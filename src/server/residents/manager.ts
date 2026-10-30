import { residentSkillIndex } from "./skill-index.ts";
import { randomUUID } from "node:crypto";
import { harnessOffersRuntime } from "@shared/harness-capabilities.ts";
import {
  RESIDENT_OPENING_TURN,
  isResidentAgent,
  launchInputsMatch,
  normalizeRunInstructions,
  residentLaunchInput,
  residentRunSummary,
  type ResidentRunSummary,
  type LaunchResident,
  type ResidentLaunchInput,
  type ResidentLaunchResult,
  type ResidentPersonaSnapshot,
  type ResidentProfile,
  type ResidentProfileRevision,
  type ResidentRun,
} from "@shared/residents.ts";
import type { StandingInstructionsDelivery } from "@shared/standing-instructions.ts";
import { isTerminalTask } from "@shared/task-status.ts";
import type { Persona } from "@shared/workflow.ts";
import type { ServerEvent, SessionRuntime, Task } from "@shared/types.ts";
import { getTask as getDurableTask } from "../db.ts";
import { resolveTaskRepoRoot } from "../repos.ts";
import { sdkSessionIdsForTask } from "../sdk/store.ts";
import type { CreateTaskInput, InternalCreateOptions } from "../tasks.ts";
import { composeResidentLaunch } from "./launch.ts";
import {
  ResidentNameConflictError,
  ResidentProfileLimitError,
  archiveResidentProfile,
  createResidentProfile,
  endResidentRun,
  getResidentProfile,
  getResidentRun,
  listOpenResidentRuns,
  listPendingResidentRuns,
  markResidentRunFailed,
  markResidentRunLaunched,
  reserveResidentRun,
  residentRunForTask,
  residentRunIdentityByRequest,
  updateResidentProfile,
  type ResidentRunIdentity,
  type StoredResidentRun,
} from "./store.ts";

/** Why a run whose task was never created ended. */
export const RESIDENT_INTERRUPTED_BEFORE_TASK =
  "interrupted before its task was created";
/** Why a run whose task existed but whose session never started ended. */
export const RESIDENT_INTERRUPTED_BEFORE_SESSION =
  "interrupted before its session started";
/** Why a dispatch that settled without a session failed its run, when the task said nothing. */
export const RESIDENT_SESSION_DID_NOT_START = "the resident's session did not start";

/**
 * The repository a stored run resolved, when a replay spells it exactly as the original request
 * did, or null. It wins over resolving the spelling again: the repository may since have been
 * removed or moved, or a symlink in the spelling retargeted, and an exact replay is the same
 * request whatever the path names now, so it answers with its run instead of a conflict. Any
 * other spelling gets null and is compared by the canonical path it resolves to.
 */
function knownRepoForSpelling(known: ResidentRunIdentity | null, spelling: string): string | null {
  if (!known || !spelling || known.repoSpelling !== spelling) return null;
  const stored = known.launchInput as { repoRoot?: unknown } | null;
  return typeof stored?.repoRoot === "string" ? stored.repoRoot : null;
}

/**
 * How long a launch request waits for its dispatch to settle before answering "in progress".
 * The dispatch keeps going; a replay with the same request id reads its outcome.
 */
const DEFAULT_LAUNCH_RESPONSE_WAIT_MS = 120_000;

/** Retries of an uncertain settlement before it is left to startup reconciliation. */
const SETTLEMENT_RETRIES = 6;
const DEFAULT_SETTLEMENT_RETRY_MS = 2_000;

/** The registry surface this manager reads and notifies. */
export interface ResidentRegistry {
  getTask(id: string): Task | undefined;
  subscribe(fn: (event: ServerEvent) => void): () => void;
  onSessionsObserved(fn: () => void): () => void;
  upsertResidentProfile(profile: ResidentProfile): void;
  removeResidentProfile(id: string): void;
  upsertResidentRun(summary: ResidentRunSummary): void;
  removeResidentRun(id: string): void;
}

export interface ResidentManagerDeps {
  registry: ResidentRegistry;
  /** `TaskManager.create`, bound, with the resident capability already applied. */
  createTask(input: CreateTaskInput, internal: InternalCreateOptions): Task;
  /** Any Persona the Library can name, built-in or authored, or null. */
  persona(id: string): Persona | null;
  resolveRepoRoot?: typeof resolveTaskRepoRoot;
  /** Every `sdk_sessions` row id carrying this task id: the session-start evidence. */
  sessionRowsForTask?: (taskId: string) => string[];
  /** A task as SQLite holds it, for startup reconciliation of rows the board did not load. */
  durableTask?: (taskId: string) => Task | undefined;
  now?: () => number;
  launchResponseWaitMs?: number;
  /** The first delay before an uncertain settlement is retried; later attempts back off. */
  settlementRetryMs?: number;
}

/** What a profile write answered. */
export type ResidentProfileOutcome =
  | { ok: true; profile: ResidentProfile }
  | { ok: false; status: 400 | 404 | 409; error: string; profile?: ResidentProfile };

/** What a launch answered, with its HTTP status. */
export type ResidentLaunchOutcome =
  | { ok: true; status: 200 | 202; result: ResidentLaunchResult }
  | { ok: false; status: 409; result: Extract<ResidentLaunchResult, { state: "failed" }> }
  | { ok: false; status: 400 | 404 | 409; error: string; code: "invalid" | "not_found" | "conflict" };

/**
 * Resident profiles and resident runs: the only writer of their tables and the only launch
 * path (`launch`). Every browser Launch affordance reaches this through one route.
 *
 * A run is the resident's durable identity. It is written BEFORE its task, with the task id
 * reserved and the normalized launch input recorded, so:
 *
 * - a repeated or concurrent request with the same id is answered from the run row alone and
 *   never creates a second run, task or SDK dispatch;
 * - a crash at any boundary leaves a `pending` run that startup reconciliation settles from
 *   durable evidence - an `sdk_sessions` row carrying the reserved task id, which the SDK
 *   supervisor writes only after the driver accepted turn one.
 */
export class ResidentManager {
  private readonly now: () => number;
  private readonly resolveRepoRoot: typeof resolveTaskRepoRoot;
  private readonly sessionRowsForTask: (taskId: string) => string[];
  private readonly durableTask: (taskId: string) => Task | undefined;
  private readonly launchResponseWaitMs: number;
  /** In-process launch settlements, so a concurrent replay can wait on the same outcome. */
  private readonly settling = new Map<string, Promise<void>>();
  private readonly settlementRetryMs: number;
  /** Pending retry waits, each with the resolver that ends it early when the manager stops. */
  private readonly retryTimers = new Map<NodeJS.Timeout, (proceed: boolean) => void>();
  private stopped = false;
  private subscriptions: Array<() => void> = [];

  constructor(private readonly deps: ResidentManagerDeps) {
    this.now = deps.now ?? Date.now;
    this.resolveRepoRoot = deps.resolveRepoRoot ?? resolveTaskRepoRoot;
    this.sessionRowsForTask = deps.sessionRowsForTask ?? sdkSessionIdsForTask;
    this.durableTask = deps.durableTask ?? getDurableTask;
    this.launchResponseWaitMs = deps.launchResponseWaitMs ?? DEFAULT_LAUNCH_RESPONSE_WAIT_MS;
    this.settlementRetryMs = deps.settlementRetryMs ?? DEFAULT_SETTLEMENT_RETRY_MS;
  }

  /**
   * Settle every run a previous process left pending, then follow run ends.
   *
   * Called once the TaskManager has been constructed, whose own startup reconciliation settles
   * the reserved tasks. The launch outcome here depends only on the session-start evidence,
   * so it is the same whichever order the two finish in; the run-end arm follows the task.
   */
  start(): void {
    residentSkillIndex();
    this.reconcilePendingRuns();
    this.subscriptions.push(this.deps.registry.subscribe((event) => this.observe(event)));
    // The startup twin of the `session_remove` arm: once sessions have been observed, end
    // every launched run whose task already settled while this daemon was down.
    this.subscriptions.push(this.deps.registry.onSessionsObserved(() => this.reconcileRunEnds()));
  }

  stop(): void {
    this.stopped = true;
    for (const [timer, resolve] of this.retryTimers) {
      clearTimeout(timer);
      resolve(false);
    }
    this.retryTimers.clear();
    for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe();
  }

  // ---- profiles ----

  /** Why these settings cannot be saved or launched, or null. */
  private settingsProblem(settings: ResidentProfileRevision): string | null {
    const persona = this.deps.persona(settings.persona.personaId);
    if (!persona) return "the selected Persona no longer exists";
    if (persona.archivedAt !== null) return `the Persona ${persona.name} is archived`;
    if (!isResidentAgent(settings.execution.agent)) {
      return `${settings.execution.agent} cannot run a resident`;
    }
    if (!harnessOffersRuntime(settings.execution.agent, "sdk")) {
      return `${settings.execution.agent} has no Agent SDK driver, so it cannot run a resident`;
    }
    return null;
  }

  createProfile(settings: ResidentProfileRevision): ResidentProfileOutcome {
    const problem = this.settingsProblem(settings);
    if (problem) return { ok: false, status: 400, error: problem };
    try {
      const profile = createResidentProfile({ id: randomUUID(), settings, at: this.now() });
      this.deps.registry.upsertResidentProfile(profile);
      return { ok: true, profile };
    } catch (error) {
      if (error instanceof ResidentNameConflictError || error instanceof ResidentProfileLimitError) {
        return { ok: false, status: 409, error: error.message };
      }
      throw error;
    }
  }

  updateProfile(
    id: string,
    expectedRevision: number,
    settings: ResidentProfileRevision,
  ): ResidentProfileOutcome {
    const problem = this.settingsProblem(settings);
    if (problem) return { ok: false, status: 400, error: problem };
    let write;
    try {
      write = updateResidentProfile({ id, expectedRevision, settings, at: this.now() });
    } catch (error) {
      if (error instanceof ResidentNameConflictError) {
        return { ok: false, status: 409, error: error.message };
      }
      throw error;
    }
    switch (write.status) {
      case "not_found":
        return { ok: false, status: 404, error: "no such resident profile" };
      case "archived":
        return { ok: false, status: 409, error: "this resident profile is archived", profile: write.profile };
      case "stale":
        return {
          ok: false,
          status: 409,
          error: `this profile changed since you opened it (now revision ${write.profile.revision})`,
          profile: write.profile,
        };
      case "ok":
        this.deps.registry.upsertResidentProfile(write.profile);
        return { ok: true, profile: write.profile };
    }
  }

  archiveProfile(id: string, expectedRevision: number): ResidentProfileOutcome {
    const write = archiveResidentProfile({ id, expectedRevision, at: this.now() });
    switch (write.status) {
      case "not_found":
        return { ok: false, status: 404, error: "no such resident profile" };
      case "archived":
        // Idempotent: a second Archive answers with the row as it stands.
        return { ok: true, profile: write.profile };
      case "stale":
        return {
          ok: false,
          status: 409,
          error: `this profile changed since you opened it (now revision ${write.profile.revision})`,
          profile: write.profile,
        };
      case "ok":
        this.deps.registry.removeResidentProfile(id);
        return { ok: true, profile: write.profile };
    }
  }

  // ---- launch ----

  /**
   * Launch a resident from a profile's current revision. Idempotent on `requestId` and safe
   * across a crash at every boundary; see the class comment.
   */
  async launch(profileId: string, input: LaunchResident): Promise<ResidentLaunchOutcome> {
    const spelling = input.repoRoot.trim();
    const resolved = await this.resolveRepoRoot(input.repoRoot);
    // A replay first, from the run row alone, read AFTER the await: a racing request with the
    // same id may have reserved while this one resolved its repository, and its run - not this
    // request's view of the profile - decides the answer. A known request id never re-validates
    // against the profile as it is now, because what it is compared with is what it recorded,
    // so reusing it for an unknown or archived profile is the typed conflict, not a 404.
    const known = residentRunIdentityByRequest(input.requestId);
    const request = residentLaunchInput(
      knownRepoForSpelling(known, spelling) ?? (resolved.ok ? resolved.repoRoot : spelling),
      input.instructions,
    );
    if (known) return this.replay(known, profileId, request);
    if (!resolved.ok) return { ok: false, status: 400, code: "invalid", error: resolved.error };

    const profile = getResidentProfile(profileId);
    if (!profile) return { ok: false, status: 404, code: "not_found", error: "no such resident profile" };
    if (profile.archivedAt !== null) {
      return { ok: false, status: 409, code: "conflict", error: "this resident profile is archived" };
    }
    const problem = this.settingsProblem(profile.settings);
    if (problem) return { ok: false, status: 400, code: "invalid", error: problem };
    const persona = this.deps.persona(profile.settings.persona.personaId)!;
    const snapshot: ResidentPersonaSnapshot = {
      personaId: persona.id,
      name: persona.name,
      guidanceMarkdown: persona.guidanceMarkdown,
    };

    const runId = randomUUID();
    const taskId = randomUUID();
    const reservation = reserveResidentRun({
      id: runId,
      profileId: profile.id,
      profileRevision: profile.revision,
      taskId,
      launchRequestId: input.requestId,
      launchInput: request,
      repoSpelling: spelling,
      persona: snapshot,
      runInstructions: normalizeRunInstructions(input.instructions),
      at: this.now(),
    });
    if (!reservation.reserved) {
      // Another request with this id reserved between this one's re-read and its insert. The
      // unique index refused the second row; answer as that winner's replay: one run, one task,
      // one dispatch, and never a raw constraint error.
      const winner = residentRunIdentityByRequest(input.requestId);
      if (!winner) {
        return { ok: false, status: 409, code: "conflict", error: "this launch request could not be reserved" };
      }
      return this.replay(winner, profileId, request);
    }
    const stored = getResidentRun(runId);
    if (!stored) throw new Error(`resident run ${runId} vanished after its reservation`);
    this.publishRun(runId);

    const settlement = this.createAndSettle(stored.run, request);
    this.settling.set(runId, settlement);
    void settlement.finally(() => this.settling.delete(runId));
    await this.awaitBriefly(settlement);
    return this.answer(runId);
  }

  /** Create the reserved task, wait for its dispatch, and record the outcome in one write. */
  /**
   * Never rejects, and never guesses. A failure while settling - a SQLite error reading the
   * session evidence or writing the outcome - says nothing about whether the session started,
   * so the run is NOT failed: it stays `pending` (answered as in progress) and the settlement
   * is retried from the same evidence on a backoff. If every retry fails, the run is left
   * `pending` for startup reconciliation, which applies the same evidence rule. Only a
   * definitive outcome is ever written, so a live session is never reported as a failed launch.
   */
  private async createAndSettle(run: ResidentRun, request: ResidentLaunchInput): Promise<void> {
    try {
      await this.createAndSettleUnguarded(run, request);
      return;
    } catch (error) {
      console.error(`[residents] could not settle resident run ${run.id}; it stays pending and is retried:`, error);
    }
    for (let attempt = 1; attempt <= SETTLEMENT_RETRIES; attempt += 1) {
      if (!(await this.retryDelay(this.settlementRetryMs * attempt))) return;
      try {
        this.settleFromEvidence(run, this.deps.registry.getTask(run.taskId) ?? this.durableTask(run.taskId));
        return;
      } catch (error) {
        console.error(`[residents] settlement retry ${attempt} for resident run ${run.id} failed:`, error);
      }
    }
    console.error(`[residents] resident run ${run.id} stays pending until startup reconciliation`);
  }

  /** Wait, unless the manager stops first. Resolves false when it stopped. */
  private retryDelay(ms: number): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.retryTimers.delete(timer);
        resolve(!this.stopped);
      }, ms);
      timer.unref?.();
      this.retryTimers.set(timer, resolve);
    });
  }

  private async createAndSettleUnguarded(run: ResidentRun, request: ResidentLaunchInput): Promise<void> {
    const execution = run.settings.execution;
    try {
      this.deps.createTask(
        {
          repoRoot: request.repoRoot,
          intent: RESIDENT_OPENING_TURN,
          title: run.settings.identity.name,
          kind: "resident",
          agent: execution.agent,
          ...(execution.model ? { model: execution.model } : {}),
          ...(execution.effort ? { effort: execution.effort } : {}),
          workflowId: null,
          backlog: false,
        },
        { id: run.taskId, resident: { runId: run.id } },
      );
    } catch (error) {
      markResidentRunFailed(run.id, error instanceof Error ? error.message : String(error), this.now());
      this.publishRun(run.id);
      return;
    }
    await this.dispatchSettled(run.taskId);
    this.settleFromEvidence(run, this.deps.registry.getTask(run.taskId) ?? this.durableTask(run.taskId));
  }

  /**
   * The one launch-outcome write, from durable evidence. A run is `launched` only when an
   * `sdk_sessions` row carries its task id (and, when the task names a session, that row);
   * the task existing is never evidence.
   */
  private settleFromEvidence(run: ResidentRun, task: Task | undefined): void {
    const at = this.now();
    if (this.startedSession(run.taskId, task)) {
      markResidentRunLaunched(run.id, !task || isTerminalTask(task.status) ? at : null);
    } else {
      markResidentRunFailed(run.id, task?.error ?? RESIDENT_SESSION_DID_NOT_START, at);
    }
    this.publishRun(run.id);
  }

  /**
   * Announce a run as it now stands, after the write that changed it: its live summary, or
   * its departure from the `residentRuns` collection once it ended or failed. Read back from
   * the row rather than assembled from what the caller wrote, so the frame is the durable
   * state whichever write won.
   */
  private publishRun(runId: string): void {
    const stored = getResidentRun(runId);
    const summary = stored ? residentRunSummary(stored.run) : null;
    if (summary) this.deps.registry.upsertResidentRun(summary);
    else this.deps.registry.removeResidentRun(runId);
  }

  private startedSession(taskId: string, task: Task | undefined): string | null {
    const rows = this.sessionRowsForTask(taskId);
    if (rows.length === 0) return null;
    if (task?.sessionId) return rows.includes(task.sessionId) ? task.sessionId : null;
    return rows[rows.length - 1]!;
  }

  /** Resolve once the task has left `dispatching`, or no longer exists. */
  private dispatchSettled(taskId: string): Promise<void> {
    return new Promise((resolve) => {
      const settled = (): boolean => {
        const task = this.deps.registry.getTask(taskId);
        return !task || task.status !== "dispatching";
      };
      // Subscribed BEFORE the first check, so a settle landing between the two is not missed.
      const unsubscribe = this.deps.registry.subscribe((event) => {
        if (
          (event.type === "task_upsert" && event.task.id === taskId) ||
          (event.type === "task_remove" && event.id === taskId)
        ) {
          if (settled()) {
            unsubscribe();
            resolve();
          }
        }
      });
      if (settled()) {
        unsubscribe();
        resolve();
      }
    });
  }

  private async awaitBriefly(settlement: Promise<void>): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      settlement,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.launchResponseWaitMs);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  /**
   * Answer a request whose id already names a run. The comparison reads only that row - its
   * profile and its normalized input - so it holds in every launch state, including a run
   * reserved just before a crash that left no task.
   */
  private async replay(
    identity: ResidentRunIdentity,
    profileId: string,
    request: ResidentLaunchInput,
  ): Promise<ResidentLaunchOutcome> {
    if (identity.profileId !== profileId || !launchInputsMatch(identity.launchInput, request)) {
      return {
        ok: false,
        status: 409,
        code: "conflict",
        error: "this launch request id was already used for a different launch; start a new launch",
      };
    }
    const inFlight = this.settling.get(identity.id);
    if (inFlight) await this.awaitBriefly(inFlight);
    return this.answer(identity.id);
  }

  /** Read the run back and answer by its launch state. */
  private answer(runId: string): ResidentLaunchOutcome {
    const stored = getResidentRun(runId);
    if (!stored) {
      return { ok: false, status: 409, code: "conflict", error: "this launch's run cannot be read by this build" };
    }
    const { run } = stored;
    switch (run.launchState) {
      case "launched":
        return { ok: true, status: 200, result: { state: "launched", run, taskId: run.taskId } };
      case "pending":
        return { ok: true, status: 202, result: { state: "pending", run } };
      case "failed":
        return {
          ok: false,
          status: 409,
          result: { state: "failed", run, error: run.launchError ?? RESIDENT_SESSION_DID_NOT_START },
        };
    }
  }

  // ---- launch composition (the dispatcher's one resident call site) ----

  /**
   * The standing instructions a resident task launches with: the repository block, then the
   * run's resident section. Read from the RUN, never the profile, so what reaches the agent
   * is the revision and persona text it pinned.
   */
  composeLaunch(
    task: Task,
    repository: StandingInstructionsDelivery,
    runtime: SessionRuntime,
  ): StandingInstructionsDelivery {
    const stored = residentRunForTask(task.id);
    if (!stored) throw new Error(`resident task ${task.id} has no resident run`);
    return composeResidentLaunch({ run: stored.run, agent: task.agent, runtime }, repository).standing;
  }

  // ---- reconciliation and run end ----

  /** Settle each run a previous process left pending, one write per run. */
  reconcilePendingRuns(): void {
    for (const stored of listPendingResidentRuns()) this.reconcilePending(stored);
  }

  private reconcilePending({ run }: StoredResidentRun): void {
    if (this.settling.has(run.id)) return;
    const task = this.deps.registry.getTask(run.taskId) ?? this.durableTask(run.taskId);
    const at = this.now();
    if (this.startedSession(run.taskId, task)) {
      // The driver accepted turn one before the crash. TaskManager's reconciliation binds the
      // task to that row; whether the session survives restore is the run-end path's question.
      markResidentRunLaunched(run.id, !task || isTerminalTask(task.status) ? at : null);
    } else {
      markResidentRunFailed(
        run.id,
        task ? RESIDENT_INTERRUPTED_BEFORE_SESSION : RESIDENT_INTERRUPTED_BEFORE_TASK,
        at,
      );
    }
    this.publishRun(run.id);
  }

  private observe(event: ServerEvent): void {
    switch (event.type) {
      case "task_upsert":
        if (event.task.kind === "resident" && isTerminalTask(event.task.status)) {
          this.endRunForTask(event.task.id);
        }
        return;
      case "task_remove":
        this.endRunForTask(event.id);
        return;
      case "session_remove":
        this.reconcileRunEnds();
        return;
      default:
        return;
    }
  }

  private endRunForTask(taskId: string): void {
    const stored = residentRunForTask(taskId);
    if (stored && stored.run.launchState === "launched" && stored.run.endedAt === null) {
      if (endResidentRun(stored.run.id, this.now())) this.publishRun(stored.run.id);
    }
  }

  /** End every launched run whose task has settled or gone. */
  reconcileRunEnds(): void {
    for (const { run } of listOpenResidentRuns()) {
      if (run.launchState !== "launched") continue;
      const task = this.deps.registry.getTask(run.taskId) ?? this.durableTask(run.taskId);
      if ((!task || isTerminalTask(task.status)) && endResidentRun(run.id, this.now())) {
        this.publishRun(run.id);
      }
    }
  }
}
