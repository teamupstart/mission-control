import { randomUUID } from "node:crypto";
import { harnessOffersRuntime } from "@shared/harness-capabilities.ts";
import {
  RESIDENT_OPENING_TURN,
  isResidentAgent,
  launchInputsMatch,
  normalizeRunInstructions,
  residentLaunchInput,
  residentRunControlRecorded,
  residentRunSummary,
  type ResidentRunControl,
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
import type { ServerEvent, Session, SessionRuntime, Task } from "@shared/types.ts";
import { getTask as getDurableTask, logEvent } from "../db.ts";
import { resolveTaskRepoRoot } from "../repos.ts";
import { getSdkSession, sdkSessionIdsForTask } from "../sdk/store.ts";
import { residentLaunchAuthorization, type AuthorizeResidentLaunch } from "../session-control-authorization.ts";
import type { CreateTaskInput, InternalCreateOptions } from "../tasks.ts";
import { createResidentWorkspace, removeResidentWorkspace, residentWorkspaceDir } from "./workspace.ts";
import { taskHasRepository } from "@shared/task.ts";
import { composeResidentLaunch } from "./launch.ts";
import {
  ResidentNameConflictError,
  ResidentProfileLimitError,
  archiveResidentProfile,
  clearResidentRunControl,
  createResidentProfile,
  endResidentRun,
  endedResidentWorkspaces,
  clearResidentWorkspace,
  getResidentProfile,
  getResidentRun,
  listOpenResidentRuns,
  listPendingResidentRuns,
  markResidentRunFailed,
  markResidentRunLaunched,
  recordResidentRunControlAuthorized,
  recordResidentRunControlGrant,
  reserveResidentRun,
  residentRunForTask,
  residentRunIdentityByRequest,
  updateResidentProfile,
  type ResidentRunControlIdentity,
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
  getSession(id: string): Session | undefined;
  // The existing session-control grant machinery, reused unchanged: the identity it binds and
  // rechecks, and the grant itself.
  sessionControlIdentity(id: string): string | null;
  workEpisodeForSession(id: string): { episodeId: string } | null;
  taskForSession(sessionId: string, cwd: string | null): Task | undefined;
  setSessionControlEnabled(id: string, enabled: boolean): boolean;
}

/**
 * A run whose session-control grant waits for its session to have a full identity.
 *
 * - `launch`: the run's desktop Launch click was consumed. The grant is applied to the run's first
 *   identified session and its identity recorded.
 * - `restore`: the run recorded a grant before a daemon restart. It is applied again only when the
 *   restored session's conversation, working directory, work episode and task all match.
 */
type GrantWatch =
  | { taskId: string; kind: "launch" }
  | { taskId: string; kind: "restore"; recorded: ResidentRunControl };

export interface ResidentManagerDeps {
  registry: ResidentRegistry;
  /** `TaskManager.create`, bound, with the resident capability already applied. */
  createTask(input: CreateTaskInput, internal: InternalCreateOptions): Task;
  /** Any Persona the Library can name, built-in or authored, or null. */
  persona(id: string): Persona | null;
  resolveRepoRoot?: typeof resolveTaskRepoRoot;
  /** Every `sdk_sessions` row id carrying this task id: the session-start evidence. */
  sessionRowsForTask?: (taskId: string) => string[];
  /** The supervisor may still own a handle after an exited row or forced Registry retirement. */
  hasLiveDriver?: (sessionId: string) => boolean;
  /** Owned filesystem removal, injectable to exercise in-flight cleanup and shutdown. */
  removeWorkspace?: typeof removeResidentWorkspace;
  /** A task as SQLite holds it, for startup reconciliation of rows the board did not load. */
  durableTask?: (taskId: string) => Task | undefined;
  now?: () => number;
  launchResponseWaitMs?: number;
  /** The first delay before an uncertain settlement is retried; later attempts back off. */
  settlementRetryMs?: number;
  /**
   * Consume the operator's desktop Launch click over the private shell channel. Defaults to the
   * real channel, which a standalone daemon does not have, so it fails closed.
   */
  authorizeLaunch?: AuthorizeResidentLaunch;
}

/** How the launch route vouches for its caller. */
export interface ResidentLaunchOptions {
  /**
   * Whether this request may consume a desktop Launch click: never for a tool, an agent or a
   * foreign origin (`sessionControlCallerRefusal`). Off by default.
   */
  mayConsumeControlClick?: boolean;
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
  private cleanupTimer?: NodeJS.Timeout;
  private readonly cleaningWorkspaces = new Map<string, Promise<void>>();
  private readonly reportedCleanupFailures = new Set<string>();
  private cleanupScanFailed = false;
  private subscriptions: Array<() => void> = [];
  private readonly authorizeLaunch: AuthorizeResidentLaunch;
  /** Runs whose grant waits for their session, by run id. At most one per live resident. */
  private readonly grantWatches = new Map<string, GrantWatch>();
  /** Who waits for a watch to be decided or dropped: a launch answers only once it knows. */
  private readonly grantWaiters = new Map<string, Array<() => void>>();
  /**
   * Runs whose grant this daemon run has already decided - applied, refused or forgotten. A
   * recorded grant is restored at most once per daemon run: a run granted by a Launch click while
   * restore was still settling, or a second sessions-observed callback, never applies it again.
   */
  private readonly decidedGrants = new Set<string>();

  constructor(private readonly deps: ResidentManagerDeps) {
    this.now = deps.now ?? Date.now;
    this.authorizeLaunch = deps.authorizeLaunch ?? residentLaunchAuthorization();
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
    this.reconcilePendingRuns();
    this.cleanupEndedWorkspaces();
    this.cleanupTimer = setInterval(() => this.cleanupEndedWorkspaces(), 2_000);
    this.cleanupTimer.unref();
    this.subscriptions.push(this.deps.registry.subscribe((event) => this.observe(event)));
    // The startup twin of the `session_remove` arm: once sessions have been observed, end
    // every launched run whose task already settled while this daemon was down. The first
    // observation also follows SDK restore, which is when a recorded grant may be re-applied.
    this.subscriptions.push(this.deps.registry.onSessionsObserved(() => {
      this.reconcileRunEnds();
      this.watchRestoredGrants();
    }));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.cleanupTimer);
    for (const [timer, resolve] of this.retryTimers) {
      clearTimeout(timer);
      resolve(false);
    }
    this.retryTimers.clear();
    for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe();
    for (const runId of [...this.grantWatches.keys()]) this.dropGrantWatch(runId);
    await Promise.all(this.cleaningWorkspaces.values());
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
  async launch(
    profileId: string,
    input: LaunchResident,
    options: ResidentLaunchOptions = {},
  ): Promise<ResidentLaunchOutcome> {
    const spelling = input.repoRoot?.trim() ?? "";
    const resolved = spelling ? await this.resolveRepoRoot(spelling) : { ok: true as const, repoRoot: null };
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
      workspaceDir: request.repoRoot === null ? residentWorkspaceDir(runId) : null,
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

    const settlement = this.authorizeAndSettle(stored.run, request, options.mayConsumeControlClick === true);
    this.settling.set(runId, settlement);
    void settlement.finally(() => this.settling.delete(runId));
    await this.awaitBriefly(settlement);
    return this.answer(runId);
  }

  /**
   * Consume the desktop Launch click, when the run may have one, then create and settle.
   *
   * After the reservation, so only the request that reserved the run consumes a click: a racing
   * duplicate is answered as this one's replay and never asks. Before the task, so the session
   * cannot exist before its grant is decided. Never rejects.
   */
  private async authorizeAndSettle(
    run: ResidentRun,
    request: ResidentLaunchInput,
    mayConsumeControlClick: boolean,
  ): Promise<void> {
    // Authority comes from the run's pinned revision, never the profile as it reads now.
    if (mayConsumeControlClick && run.settings.authority.controlOtherSessions) {
      await this.consumeLaunchClick(run);
    }
    await this.createAndSettle(run, request);
    // The launch answers with the grant's outcome - applied or not - rather than with a consumed
    // click, so Dispatch and the dock can say which. Bounded like the launch itself: a session
    // that never gets an identity leaves the click recorded and the outcome pending.
    await this.awaitBriefly(this.grantDecided(run.id));
  }

  /** Resolves once this run has no grant waiting: decided, dropped, or never armed. */
  private grantDecided(runId: string): Promise<void> {
    if (!this.grantWatches.has(runId)) return Promise.resolve();
    return new Promise((resolve) => {
      this.grantWaiters.set(runId, [...(this.grantWaiters.get(runId) ?? []), resolve]);
    });
  }

  /** Forget a waiting grant and release whoever waits on its decision. */
  private dropGrantWatch(runId: string): void {
    this.grantWatches.delete(runId);
    for (const resolve of this.grantWaiters.get(runId) ?? []) resolve();
    this.grantWaiters.delete(runId);
  }

  /**
   * Ask the shell for the click armed for exactly this launch request, profile and revision, and
   * record it. Anything else - no desktop parent, no click, an expired or replayed one, a different
   * revision, a write that failed - leaves the run ungranted.
   */
  private async consumeLaunchClick(run: ResidentRun): Promise<void> {
    let authorized = false;
    try {
      authorized = await this.authorizeLaunch({
        requestId: run.launchRequestId,
        profileId: run.profileId,
        revision: run.profileRevision,
      });
    } catch (error) {
      console.error(`[residents] could not consume the Launch click for resident run ${run.id}:`, error);
    }
    if (!authorized) return;
    try {
      if (recordResidentRunControlAuthorized(run.id, this.now())) {
        this.grantWatches.set(run.id, { taskId: run.taskId, kind: "launch" });
      }
    } catch (error) {
      console.error(`[residents] could not record the Launch click for resident run ${run.id}; it starts without control:`, error);
    }
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
      if (run.workspaceDir) createResidentWorkspace(run.id, run.workspaceDir);
      this.deps.createTask(
        {
          repoRoot: run.workspaceDir ?? request.repoRoot!,
          intent: RESIDENT_OPENING_TURN,
          title: run.settings.identity.name,
          kind: "resident",
          agent: execution.agent,
          ...(execution.model ? { model: execution.model } : {}),
          ...(execution.effort ? { effort: execution.effort } : {}),
          workflowId: null,
          backlog: false,
        },
        { id: run.taskId, resident: { runId: run.id, workspaceDir: run.workspaceDir } },
      );
    } catch (error) {
      markResidentRunFailed(run.id, error instanceof Error ? error.message : String(error), this.now());
      this.publishRun(run.id);
      this.cleanupEndedWorkspaces();
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
    this.cleanupEndedWorkspaces();
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
    else {
      // A run that failed or ended has no session left to grant.
      this.dropGrantWatch(runId);
      this.decidedGrants.delete(runId);
      this.deps.registry.removeResidentRun(runId);
    }
    if (summary?.launchState === "launched") this.applyWaitingGrants();
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
    if (!taskHasRepository(task) && stored.run.workspaceDir !== task.repoRoot) {
      throw new Error("resident task does not own its workspace");
    }
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
        this.applyWaitingGrants();
        return;
      case "session_upsert":
        this.applyWaitingGrants();
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
      this.cleanupEndedWorkspaces();
    }
  }

  /** End every launched run whose task has settled or gone. */
  reconcileRunEnds(): Promise<void> {
    for (const { run } of listOpenResidentRuns()) {
      if (run.launchState !== "launched") continue;
      const task = this.deps.registry.getTask(run.taskId) ?? this.durableTask(run.taskId);
      if ((!task || isTerminalTask(task.status)) && endResidentRun(run.id, this.now())) {
        this.publishRun(run.id);
      }
    }
    return this.cleanupEndedWorkspaces();
  }

  /** Completion may precede eviction. Preserve cwd until every owned SDK runtime has stopped. */
  cleanupEndedWorkspaces(): Promise<void> {
    if (this.stopped) return Promise.all(this.cleaningWorkspaces.values()).then(() => {});
    try {
      for (const run of endedResidentWorkspaces()) {
        if (this.settling.has(run.id) || this.cleaningWorkspaces.has(run.id)) continue;
        const sessions = this.sessionRowsForTask(run.taskId);
        if (sessions.some((id) => {
          if (this.deps.registry.getSession(id) || this.deps.hasLiveDriver?.(id)) return true;
          const row = getSdkSession(id);
          return row && row.status !== "exited" && row.status !== "failed";
        })) continue;
        const cleanup = (async () => {
          try {
            await (this.deps.removeWorkspace ?? removeResidentWorkspace)(run.id, run.workspaceDir);
            clearResidentWorkspace(run.id);
            this.reportedCleanupFailures.delete(run.id);
          } catch (error) {
            if (!this.reportedCleanupFailures.has(run.id)) {
              this.reportedCleanupFailures.add(run.id);
              console.error(`[residents] workspace cleanup remains owed for ${run.id}:`, error);
            }
          }
        })().finally(() => this.cleaningWorkspaces.delete(run.id));
        this.cleaningWorkspaces.set(run.id, cleanup);
      }
      this.cleanupScanFailed = false;
    } catch (error) {
      if (!this.cleanupScanFailed) {
        console.error("[residents] could not scan ended workspaces; retrying on the next pass:", error);
        this.cleanupScanFailed = true;
      }
    }
    return Promise.all(this.cleaningWorkspaces.values()).then(() => {});
  }

  // ---- session control: the grant a desktop Launch click gives a run ----

  /**
   * After SDK restore, watch every open run that recorded a complete grant. A run missing any of
   * the four recorded fields - including every run from before they existed, and one whose click
   * was consumed but whose grant was never applied - stays ungranted.
   */
  private watchRestoredGrants(): void {
    for (const { run } of listOpenResidentRuns()) {
      if (run.launchState !== "launched" || !residentRunControlRecorded(run.control)) continue;
      if (!run.settings.authority.controlOtherSessions) continue;
      if (this.decidedGrants.has(run.id) || this.grantWatches.has(run.id)) continue;
      this.grantWatches.set(run.id, { taskId: run.taskId, kind: "restore", recorded: { ...run.control } });
    }
    this.applyWaitingGrants();
  }

  /**
   * Decide every waiting grant whose session now has a full identity. Synchronous from the
   * identity read through the grant, so nothing can replace the conversation in between: what is
   * granted, and what is recorded, is the identity the Registry binds right now.
   */
  private applyWaitingGrants(): void {
    if (this.grantWatches.size === 0) return;
    // Deleting the entry being visited is safe while iterating a Map.
    for (const [runId, watch] of this.grantWatches) {
      const sessionId = this.watchedSession(watch);
      if (!sessionId) continue;
      const identity = this.grantIdentity(sessionId, watch.taskId);
      if (identity === "waiting") continue;
      this.grantWatches.delete(runId);
      try {
        this.decideGrant(runId, sessionId, watch, identity);
      } catch (error) {
        console.error(`[residents] could not decide session control for resident run ${runId}:`, error);
      } finally {
        this.dropGrantWatch(runId);
      }
    }
  }

  /**
   * The session a waiting grant is decided on: the one the run's task is bound to. After a restart
   * the Registry may have bound that session to another task, which unbinds the run's; the run's
   * own `sdk_sessions` row still names the session it launched, so the identity check sees the
   * other task and the grant is forgotten rather than waited on for the rest of the run.
   */
  private watchedSession(watch: GrantWatch): string | null {
    const bound = this.deps.registry.getTask(watch.taskId)?.sessionId ?? null;
    if (bound || watch.kind === "launch") return bound;
    const rows = this.sessionRowsForTask(watch.taskId);
    return rows[rows.length - 1] ?? null;
  }

  private decideGrant(
    runId: string,
    sessionId: string,
    watch: GrantWatch,
    identity: ResidentRunControlIdentity | null,
  ): void {
    this.decidedGrants.add(runId);
    if (watch.kind === "restore") {
      const same = identity !== null
        && identity.conversationId === watch.recorded.conversationId
        && identity.cwd === watch.recorded.cwd
        && identity.episodeId === watch.recorded.episodeId;
      // A clear, a new conversation, a changed working directory or a replacement work episode
      // does not carry the grant, and nothing later can bring it back.
      if (!same) {
        clearResidentRunControl(runId);
        return;
      }
      // A grant this restore cannot apply is forgotten too: otherwise a later restart would apply
      // from a record that this one refused.
      if (!this.deps.registry.setSessionControlEnabled(sessionId, true)) {
        clearResidentRunControl(runId);
        return;
      }
      this.logGrant(sessionId, runId, "restore");
      return;
    }
    // A grant that could not be applied leaves the run with no record at all, so the launch
    // answers - and Dispatch and the dock say - that it started without control.
    if (!identity || !this.deps.registry.setSessionControlEnabled(sessionId, true)) {
      clearResidentRunControl(runId);
      return;
    }
    // Apply, then record, then log. Applying first means no record outlives a grant that never
    // applied; recording before anything else that can fail means a live grant is always one a
    // restart can restore. A record that cannot be written takes the live grant back.
    try {
      if (!recordResidentRunControlGrant(runId, identity)) throw new Error("the run no longer holds its Launch click");
    } catch (error) {
      this.deps.registry.setSessionControlEnabled(sessionId, false);
      clearResidentRunControl(runId);
      throw error;
    }
    this.logGrant(sessionId, runId, "launch_click");
  }

  /** The grant's audit line. Best effort: the grant and its record already agree without it. */
  private logGrant(sessionId: string, runId: string, source: "launch_click" | "restore"): void {
    try {
      logEvent(sessionId, this.now(), "session_control_grant", { enabled: true, residentRun: runId, source });
    } catch (error) {
      console.error(`[residents] could not log the session-control grant for resident run ${runId}:`, error);
    }
  }

  /**
   * The grant identity of a run's session, minus the process id: `waiting` while the Registry has
   * no full identity for it yet, or null when the session cannot take this run's grant - it is
   * gone, or the Registry binds it to a task other than this run's.
   */
  private grantIdentity(sessionId: string, taskId: string): ResidentRunControlIdentity | "waiting" | null {
    const registry = this.deps.registry;
    const session = registry.getSession(sessionId);
    if (!session || session.state === "exited") return null;
    if (registry.sessionControlIdentity(sessionId) === null) return "waiting";
    const episode = registry.workEpisodeForSession(sessionId);
    if (!episode || !session.agentSessionId || !session.cwd) return "waiting";
    if (registry.taskForSession(sessionId, session.cwd)?.id !== taskId) return null;
    return { conversationId: session.agentSessionId, cwd: session.cwd, episodeId: episode.episodeId };
  }

  /**
   * The operator is turning this session's control off with the existing toggle, and the route
   * calls this before the live grant goes. When the session is a resident run's, forget the run's
   * grant first, so no later failure can leave a record a restart would give back.
   */
  sessionControlRevoked(sessionId: string): void {
    const session = this.deps.registry.getSession(sessionId);
    const taskId = session?.task?.id ?? this.deps.registry.taskForSession(sessionId, session?.cwd ?? null)?.id;
    if (!taskId) return;
    const stored = residentRunForTask(taskId);
    if (!stored) return;
    this.dropGrantWatch(stored.run.id);
    clearResidentRunControl(stored.run.id);
  }
}
