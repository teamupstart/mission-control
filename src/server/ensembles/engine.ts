import { createHash, randomUUID } from "node:crypto";
import {
  ENSEMBLE_DRIVER_KEYS,
  ensembleIsRunnable,
  ensembleIsTerminal,
  type CompiledEnsemblePlan,
  type EnsembleArtifact,
  type EnsembleAttempt,
  type EnsembleBarrierSpec,
  type EnsembleJson,
  type EnsembleMember,
  type EnsembleMemberStatus,
  type EnsembleRoleSpec,
  type EnsembleStageAttempt,
  type EnsembleStageSpec,
  type EnsembleStatus,
  type EnsembleRun,
  type EnsembleStageDriverKind,
  type RunnableEnsembleRun,
} from "@shared/ensemble.ts";
import { AGENT_TYPES, type AgentType, type ThinkingLevel } from "@shared/types.ts";
import type { EnsembleSubmissionClaims } from "@shared/protocol.ts";
import { EnsembleStore } from "./store.ts";
import { artifactAdapterFor, type ArtifactAdapterRegistry } from "./artifacts/index.ts";
import { buildMemberPrompt } from "./member-prompt.ts";

/**
 * The strategy-neutral execution engine.
 *
 * It executes a compiled plan's STAGE KINDS and driver keys and never asks whether a run is
 * Best-of-N; that is the whole contract that makes "a new strategy needs no engine change" true.
 * Its job is narrow and durable: turn the ready stages of an immutable plan into a bounded set of
 * commands, persist each command's key and stage attempt BEFORE its side effect so a restart
 * cannot repeat one, launch member Tasks through their owner, wake barriers off ready artifacts
 * (never off a Task going idle or a hook falling silent), and recover from durable state alone.
 *
 * Everything for one run is SERIALIZED. A member completing, an operator cancelling, a submission
 * arriving and a restart pass can all land on the same run at once, and only one may act at a time
 * or two of them will each write over the other's view of the world. Different runs progress
 * concurrently. No database transaction is ever held across a Task, Git or terminal side effect -
 * the run lock is a promise chain, not a transaction, and the store's own transactions are each a
 * single statement's worth of work.
 *
 * The Task lifecycle is NOT re-implemented here. TaskManager owns create, dispatch, cancellation,
 * worktrees and terminal homes; this engine observes their durable state through an injected
 * gateway and records what it observes. An ensemble member is a normal Task with a group around it.
 */

// ---- injected seams ----

/** One member Task's launch request, including its preallocated durable identity. */
export interface MemberTaskRequest {
  taskId: string;
  runId: string;
  memberId: string;
  repoRoot: string;
  /** The full first prompt, already assembled from the ordinary intent plus the ensemble appendix. */
  intent: string;
  title: string;
  agent: AgentType;
  model: string | null;
  effort: ThinkingLevel | null;
}

export interface MemberDispatchRequest {
  taskId: string;
  /** The exact commit the worktree must be provisioned at and verified against. */
  baseSha: string;
  model: string | null;
  effort: ThinkingLevel | null;
}

/**
 * The one seam between the engine and TaskManager/Registry.
 *
 * A narrow interface rather than the managers themselves, so the engine takes no dependency on the
 * task subsystem's internals and a test can drive it against a fake that records dispatches and
 * lets the test move Task statuses by hand. Every method here is a Task LIFECYCLE operation whose
 * owner is TaskManager; the engine only asks.
 */
export interface EnsembleTaskGateway {
  /** Create ONE backlog member Task at its preallocated durable id. Never dispatches. */
  create(request: MemberTaskRequest): void;
  /** Dispatch a created member Task with its pinned base and the ensemble submission tool. */
  dispatch(request: MemberDispatchRequest): void;
  /** Cancel a member Task through its owner. Tears the agent down; keeps the record and worktree. */
  cancel(taskId: string): Promise<void>;
  /** The current durable status of a member Task, or null if it is gone. */
  status(taskId: string): TaskGatewayStatus | null;
  /** The worktree a member Task is running in, once provisioned. */
  worktreePath(taskId: string): string | null;
  /** The live session bound to a member Task, once discovered. */
  sessionId(taskId: string): string | null;
  /** The model the member's harness actually reported it is running, if known. */
  observedModel(taskId: string): string | null;
}

/** The subset of `TaskStatus` the engine reacts to, named so the engine needs no task types. */
export type TaskGatewayStatus = "backlog" | "dispatching" | "running" | "done" | "cancelled" | "failed";

export interface EnsembleEngineDeps {
  store: EnsembleStore;
  tasks: EnsembleTaskGateway;
  /** Re-read one run and push its compact summary + task projection onto the live channel. */
  publish: (runId: string) => void;
  adapters?: ArtifactAdapterRegistry;
  now?: () => number;
  log?: (level: "info" | "warn" | "error", fields: Record<string, unknown>) => void;
}

// ---- submission ----

export type EnsembleSubmitRefusal =
  | "no_member"
  | "run_not_accepting"
  | "member_inactive"
  | "no_attempt"
  | "no_worktree"
  | "wrong_cwd"
  | "already_submitted"
  | "capture_failed";

export type EnsembleSubmitOutcome =
  | { ok: true; artifact: EnsembleArtifact; replayed: boolean }
  | { ok: false; reason: EnsembleSubmitRefusal; detail: string };

export interface EnsembleSubmitInput {
  runId: string;
  memberId: string;
  claims: EnsembleSubmissionClaims;
  source: "mcp" | "operator";
  /** For the session path, the session cwd that must equal the member's live worktree. Null for manual. */
  requireWorktree: string | null;
}

// ---- pure predicates over durable state ----

/** A member no longer occupies a slot or can submit: it has settled, one way or another. */
const SETTLED_MEMBER_STATUSES: readonly EnsembleMemberStatus[] = [
  "submitted",
  "reviewing",
  "advanced",
  "eliminated",
  "failed",
  "withdrawn",
  "retained",
];

/** A member holding a worktree and a running (or launching) agent - what concurrency counts. */
const OCCUPYING_MEMBER_STATUSES: readonly EnsembleMemberStatus[] = ["launching", "active"];

/** A member that can still be handed a submission. */
const SUBMITTABLE_MEMBER_STATUSES: readonly EnsembleMemberStatus[] = ["launching", "active"];
const LIVE_TASK_STATUSES: readonly TaskGatewayStatus[] = ["backlog", "dispatching", "running"];
const DRIVER_KEYS_BY_KIND = {
  member: ["member_wave@1"],
  review: ["artifact_barrier@1", "comparative_review@1"],
  decision: ["human_decision@1"],
  finalize: ["select_one_finalize@1"],
} as const satisfies Record<EnsembleStageDriverKind, readonly (typeof ENSEMBLE_DRIVER_KEYS)[number][]>;

function isSettled(status: EnsembleMemberStatus | null): boolean {
  return status !== null && SETTLED_MEMBER_STATUSES.includes(status);
}

/** A run's status while it still accepts new observations and submissions. */
function runIsAccepting(status: EnsembleStatus): boolean {
  return !ensembleIsTerminal(status) && status !== "cancelling";
}

/** Every non-terminal run status, the compare-and-set precondition for a status move. */
const NON_TERMINAL_RUN_STATUSES: readonly EnsembleStatus[] = [
  "planning",
  "running",
  "waiting",
  "evaluating",
  "awaiting_decision",
  "finalizing",
  "cancelling",
];

interface RunState {
  run: RunnableEnsembleRun;
  members: EnsembleMember[];
  attempts: EnsembleAttempt[];
  artifacts: EnsembleArtifact[];
  stageAttempts: EnsembleStageAttempt[];
}

interface RawRunState {
  run: EnsembleRun;
  members: EnsembleMember[];
  attempts: EnsembleAttempt[];
  artifacts: EnsembleArtifact[];
  stageAttempts: EnsembleStageAttempt[];
}

export class EnsembleEngine {
  private readonly store: EnsembleStore;
  private readonly tasks: EnsembleTaskGateway;
  private readonly adapters: ArtifactAdapterRegistry | null;
  private readonly publish: (runId: string) => void;
  private readonly now: () => number;
  private readonly log: (level: "info" | "warn" | "error", fields: Record<string, unknown>) => void;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(deps: EnsembleEngineDeps) {
    this.store = deps.store;
    this.tasks = deps.tasks;
    this.adapters = deps.adapters ?? null;
    this.publish = deps.publish;
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log ?? (() => {});
  }

  private adapterFor(kind: string) {
    if (this.adapters) return this.adapters[kind as keyof ArtifactAdapterRegistry] ?? null;
    return artifactAdapterFor(kind as never);
  }

  /**
   * Serialize everything for one run, exactly the promise-chain lock `WorkflowManager.withGateLock`
   * uses. Chains onto the previous holder (tolerating its rejection), installs itself as the tail,
   * and cleans up only if still the tail so a later waiter's entry is never dropped.
   */
  private async withRunLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const before = this.locks.get(runId) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = before.then(() => held, () => held);
    this.locks.set(runId, tail);
    await before.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(runId) === tail) this.locks.delete(runId);
    }
  }

  // ---- public entry points (each takes the run lock) ----

  /** Launch a freshly created, already-pinned run: move it to running and issue its first wave. */
  async launch(runId: string): Promise<void> {
    await this.withRunLock(runId, () => this.advanceLocked(runId));
  }

  /** React to a durable Task/Session change for a member of this run. Recomputes from state. */
  async wake(runId: string): Promise<void> {
    await this.withRunLock(runId, () => this.advanceLocked(runId));
  }

  /** Capture a member's submission and advance. Attribution is the caller's job; this verifies it. */
  async submit(input: EnsembleSubmitInput): Promise<EnsembleSubmitOutcome> {
    return this.withRunLock(input.runId, () => this.submitLocked(input));
  }

  // ---- internal recovery actions (kept internal this phase; Phase 6 exposes the action API) ----

  /**
   * Cancel a whole run: tear down every live member Task through its owner, mark those members
   * withdrawn, and reach `cancelled` - but never delete a restorable artifact ref. Submitted work
   * survives cancellation, exactly as a loser's snapshot survives a promotion.
   */
  async cancelRun(runId: string, reason: string | null): Promise<boolean> {
    return this.withRunLock(runId, async () => {
      const state = this.loadRaw(runId);
      if (!state) return false;
      if (state.run.status === null) return false;
      if (ensembleIsTerminal(state.run.status)) return state.run.status === "cancelled";
      return this.cancelLocked(state, reason);
    });
  }

  private async cancelLocked(state: RawRunState, reason: string | null): Promise<boolean> {
    const now = this.now();
    if (state.run.status !== "cancelling") {
      this.store.setRunStatus(state.run.id, NON_TERMINAL_RUN_STATUSES, "cancelling", { error: reason }, now);
    }
    let settled = true;
    for (const member of state.members) {
      settled = (await this.tearDownMember(state, member, "withdrawn", now)) && settled;
    }
    if (!settled) {
      this.publish(state.run.id);
      return false;
    }
    this.store.setRunStatus(state.run.id, ["cancelling"], "cancelled", { error: reason, completedAt: now }, now);
    this.event(state.run.id, "run_cancelled", { reason }, `run_cancelled:${state.run.id}`);
    this.publish(state.run.id);
    return true;
  }

  /** Withdraw one member: stop it from launching or submitting, cancel it if live, recompute barriers. */
  async withdrawMember(runId: string, memberId: string, reason: string | null = null): Promise<boolean> {
    return this.withRunLock(runId, async () => {
      const state = this.load(runId);
      if (!state) return false;
      const member = state.members.find((m) => m.id === memberId);
      if (!member || isSettled(member.status)) return false;
      const now = this.now();
      if (!(await this.tearDownMember(state, member, "withdrawn", now, reason))) {
        this.publish(runId);
        return false;
      }
      this.event(runId, "member_withdrawn", { memberId, reason }, `member_withdrawn:${memberId}`);
      await this.advanceLocked(runId);
      this.publish(runId);
      return true;
    });
  }

  /** Cancel a member's live Task (if any) and set its terminal member status, keeping its record. */
  private async tearDownMember(
    state: Pick<RawRunState, "attempts">,
    member: EnsembleMember,
    terminal: Extract<EnsembleMemberStatus, "withdrawn" | "failed">,
    now: number,
    reason: string | null = null,
  ): Promise<boolean> {
    const taskStatus = member.taskId ? this.tasks.status(member.taskId) : null;
    if (member.taskId && taskStatus !== null && LIVE_TASK_STATUSES.includes(taskStatus)) {
      try {
        await this.tasks.cancel(member.taskId);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        this.log("warn", { event: "ensemble_member_cancel_failed", runId: member.runId, memberId: member.id, error: detail });
        if (member.status === "pending" || member.status === "launching" || member.status === "active") {
          this.store.setMemberStatus(member.id, [member.status], member.status, { error: detail }, now);
        }
        return false;
      }
      const attempt = this.latestAttempt(state, member.id);
      if (attempt) {
        this.store.setAttemptStatus(attempt.id, ["pending", "launching", "running"], "cancelled", { finishedAt: now }, now);
      }
    }
    if (member.status === "pending" || member.status === "launching" || member.status === "active") {
      this.store.setMemberStatus(member.id, [member.status], terminal, { error: reason }, now);
    }
    return true;
  }

  /**
   * Retry one failed member: append a NEW attempt on the SAME logical member and relaunch it.
   *
   * Only after the prior attempt is durably failed and its worktree is gone - a retry onto a tree an
   * agent may still hold would race the owner that is tearing it down. The ordinal never changes; a
   * retry is a second attempt, never a second candidate.
   */
  async retryMember(runId: string, memberId: string): Promise<boolean> {
    return this.withRunLock(runId, async () => {
      const state = this.load(runId);
      if (!state || ensembleIsTerminal(state.run.status)) return false;
      const member = state.members.find((m) => m.id === memberId);
      if (!member || member.status !== "failed") return false;
      const prior = this.latestAttempt(state, member.id);
      if (!prior || prior.status !== "failed") return false;
      if (prior.taskId && this.tasks.worktreePath(prior.taskId)) return false; // worktree not yet reclaimed
      if (state.attempts.length >= state.run.plan.budget.maxMembers) return false;
      const role = state.run.plan.roles.find((r) => r.key === member.roleKey);
      if (!role) return false;
      const now = this.now();
      const input = this.resolveMemberInput(state.run, role, now);
      if (!input.ok) return false;
      const attemptNumber = this.store.nextAttemptNumber(member.id);
      const prompt = buildMemberPrompt({
        runId: state.run.id,
        intent: state.run.intent,
        role,
        totalMembers: state.run.plan.roles.length,
        baseSha: input.baseSha,
        parentLabels: input.parentLabels,
      });
      const taskId = randomUUID();
      const agent = role.agent ?? AGENT_TYPES[0];
      this.store.reserveAttempt(
        {
          runId: state.run.id,
          memberId: member.id,
          attempt: attemptNumber,
          taskId,
          sessionId: null,
          agent,
          requestedModel: role.model,
          requestedEffort: role.effort,
          baseSha: input.baseSha,
          worktreePath: null,
          branch: null,
          status: "pending",
        },
        ["failed"],
        now,
      );
      this.tasks.create({
        taskId,
        runId: state.run.id,
        memberId: member.id,
        repoRoot: state.run.repoRoot,
        intent: prompt,
        title: `${state.run.title} - ${role.label}`,
        agent,
        model: role.model,
        effort: role.effort,
      });
      this.event(runId, "member_retried", { memberId, attempt: attemptNumber }, `member_retried:${member.id}:${attemptNumber}`);
      await this.advanceLocked(runId);
      this.publish(runId);
      return true;
    });
  }

  /** Append a bounded retry of a failed stage, if the compiled attempt cap leaves room. */
  async retryStage(runId: string, stageId: string): Promise<boolean> {
    return this.withRunLock(runId, async () => {
      const state = this.load(runId);
      if (!state || ensembleIsTerminal(state.run.status)) return false;
      const stage = state.run.plan.stages.find((s) => s.id === stageId);
      if (!stage || stage.driverKind !== "member" || !this.driverMatches(stage)) return false;
      const latest = this.latestStageAttempt(state, stageId);
      if (!latest || latest.status !== "failed" || latest.attempt >= stage.maxAttempts) return false;
      const now = this.now();
      const attempt = latest.attempt + 1;
      this.store.startStageAttempt(
        {
          runId,
          stageId,
          driverKind: stage.driverKind,
          driverKey: stage.driverKey,
          attempt,
          commandKey: `stage-retry:${runId}:${stageId}:${attempt}`,
          status: "running",
          input: { command: "retry_stage", stageId } as EnsembleJson,
        },
        now,
      );
      this.event(runId, "stage_retried", { stageId, attempt }, `stage_retried:${runId}:${stageId}:${attempt}`);
      await this.advanceLocked(runId);
      this.publish(runId);
      return true;
    });
  }

  /**
   * Restore one ready artifact into its member's worktree, exactly, verifying the private ref first.
   *
   * The verification is the point: the ref is checked to still resolve to the recorded commit before
   * a hard reset touches anybody's checkout, and the Phase 2 helper resets to the commit without
   * switching a real branch. This never deletes the ref - a restore is non-destructive.
   */
  async restoreArtifact(runId: string, artifactId: string): Promise<{ ok: boolean; detail?: string }> {
    return this.withRunLock(runId, async () => {
      const artifact = this.store.listArtifacts(runId).find((a) => a.id === artifactId);
      if (!artifact) return { ok: false, detail: "no such artifact" };
      if (artifact.status !== "ready") return { ok: false, detail: `artifact is ${artifact.status ?? "unreadable"}` };
      if (artifact.kind !== "commit") return { ok: false, detail: "only commit artifacts can be restored" };
      const adapter = this.adapterFor("commit");
      if (!adapter) return { ok: false, detail: "no adapter for commit artifacts" };
      const attempt = this.store.listAttempts(runId).find((a) => a.id === artifact.attemptId);
      const worktree = attempt ? this.ownedWorktree(attempt) : null;
      if (!worktree) return { ok: false, detail: "the member has no live worktree to restore into" };
      const verified = await adapter.verify(artifact.locator, { repoPath: worktree });
      if (!verified) return { ok: false, detail: "the artifact's private ref no longer resolves to its commit" };
      await adapter.restore(artifact.locator, { worktreePath: worktree });
      this.event(runId, "artifact_restored", { artifactId }, `artifact_restored:${artifactId}:${this.now()}`);
      return { ok: true };
    });
  }

  /**
   * Reconcile one non-terminal run on daemon startup, then advance it.
   *
   * Everything is recomputed from durable rows and current Task state, never from missed events. A
   * member marked `launching` whose Task is gone becomes a failed attempt; a `capturing` artifact
   * whose capture cannot still be in flight is failed so its member can resubmit; a member whose
   * Task never got dispatched is dispatched. Then the ordinary advance takes over, and because every
   * command carries a durable idempotency key, resuming cannot duplicate a Task, member, attempt,
   * artifact or wave.
   */
  async recover(runId: string): Promise<void> {
    await this.withRunLock(runId, async () => {
      const raw = this.loadRaw(runId);
      if (!raw || raw.run.status === null || ensembleIsTerminal(raw.run.status)) return;
      if (raw.run.status === "cancelling") {
        await this.cancelLocked(raw, raw.run.error);
        return;
      }
      const state = this.load(runId);
      if (!state) return;
      const now = this.now();
      for (const artifact of state.artifacts) {
        if (artifact.status !== "capturing" || artifact.kind !== "commit" || artifact.attemptId === null) continue;
        const attempt = state.attempts.find((candidate) => candidate.id === artifact.attemptId);
        const member = attempt ? state.members.find((candidate) => candidate.id === attempt.memberId) : null;
        const adapter = this.adapterFor("commit");
        const baseSha = attempt?.baseSha ?? state.run.baseSha;
        let captured = null;
        try {
          captured =
            adapter && baseSha
              ? await adapter.recover({
                  runId,
                  artifactId: artifact.id,
                  repoPath: state.run.repoRoot,
                  baseSha,
                })
              : null;
        } catch (err) {
          this.log("warn", { event: "ensemble_capture_recovery_failed", runId, artifactId: artifact.id, error: String(err) });
        }
        if (captured && attempt && member) {
          const completed = this.store.completeSubmission(
            {
              runId,
              memberId: member.id,
              attemptId: attempt.id,
              artifactId: artifact.id,
              locator: captured.locator,
              digest: captured.fingerprint,
              metadata: recoveredMetadata(artifact.metadata, captured.observed, now),
              readyAt: now,
            },
            now,
          );
          if (completed.ok) {
            this.event(runId, "member_submitted", { memberId: member.id, artifactId: artifact.id, source: "recovery" }, `member_submitted:${attempt.id}`);
            continue;
          }
        }
        this.store.setArtifactStatus(artifact.id, "failed", { error: "capture interrupted before its private ref was durable" }, now);
      }

      const afterCapture = this.load(runId);
      if (!afterCapture) return;
      for (const artifact of afterCapture.artifacts) {
        if (artifact.status !== "ready" || artifact.kind !== "commit") continue;
        const adapter = this.adapterFor("commit");
        let verified = false;
        try {
          verified = adapter ? await adapter.verify(artifact.locator, { repoPath: afterCapture.run.repoRoot }) : false;
        } catch {
          verified = false;
        }
        if (!verified) {
          this.store.invalidateReadyArtifact(artifact.id, "the artifact's private ref no longer resolves to its recorded commit");
          continue;
        }
        if (artifact.attemptId === null) continue;
        const attempt = afterCapture.attempts.find((candidate) => candidate.id === artifact.attemptId);
        const member = attempt ? afterCapture.members.find((candidate) => candidate.id === attempt.memberId) : null;
        if (!attempt || !member) continue;
        this.store.completeSubmission(
          {
            runId,
            memberId: member.id,
            attemptId: attempt.id,
            artifactId: artifact.id,
            readyAt: artifact.readyAt ?? now,
          },
          now,
        );
      }

      const reconciledState = this.load(runId);
      if (!reconciledState) return;
      for (const member of reconciledState.members) {
        if (member.status !== "launching" || member.taskId === null) continue;
        const taskStatus = this.tasks.status(member.taskId);
        const attempt = this.latestAttempt(reconciledState, member.id);
        if (attempt && attempt.status === "launching" && (taskStatus === "backlog" || taskStatus === null)) {
          // Dispatch was lost across the restart: reset the attempt to pending so it dispatches again.
          if (taskStatus === "backlog" && attempt.taskId) {
            this.store.setAttemptStatus(attempt.id, ["launching"], "pending", {}, now);
          }
        }
      }
      this.event(runId, "run_recovered", {}, `run_recovered:${runId}:${now}`);
      await this.advanceLocked(runId);
      this.publish(runId);
    });
  }

  // ---- the core: recompute readiness and take one step of progress ----

  private load(runId: string): RunState | null {
    const run = this.store.getRun(runId);
    if (!run || !ensembleIsRunnable(run)) return null;
    return {
      run,
      members: this.store.listMembers(runId),
      attempts: this.store.listAttempts(runId),
      artifacts: this.store.listArtifacts(runId),
      stageAttempts: this.store.listStageAttempts(runId),
    };
  }

  private loadRaw(runId: string): RawRunState | null {
    const run = this.store.getRun(runId);
    if (!run) return null;
    return {
      run,
      members: this.store.listMembers(runId),
      attempts: this.store.listAttempts(runId),
      artifacts: this.store.listArtifacts(runId),
      stageAttempts: this.store.listStageAttempts(runId),
    };
  }

  /**
   * The one recompute-and-act loop, run under the lock.
   *
   * It reconciles member statuses from current Task state, then walks the compiled stages in order
   * and takes exactly one meaningful step - launch a member, mark a stage done, park on a barrier,
   * complete or fail the run - looping only while a step made SYNCHRONOUS progress (a stage flipping
   * to succeeded unblocks the next). Launching a member is not synchronous progress: the member is
   * now `launching`, and the next step waits for an event. Every decision is recomputed from durable
   * rows, so a restart mid-loop resumes correctly.
   */
  private async advanceLocked(runId: string): Promise<void> {
    let published = false;
    for (let guard = 0; guard < 64; guard++) {
      const state = this.load(runId);
      if (!state) return;
      const { run, plan } = { run: state.run, plan: state.run.plan };
      if (ensembleIsTerminal(run.status)) {
        if (published) this.publish(runId);
        return;
      }
      if (run.status === "cancelling") {
        if (published) this.publish(runId);
        return;
      }

      // A member whose Task ended, or came alive, is reconciled here rather than trusted from an
      // event: a Task going idle is not a submission, and a Task dying is not a completion.
      const reconciled = this.reconcileMembers(state);
      if (reconciled) {
        published = true;
        continue;
      }

      if (this.enforceDeadline(state)) {
        this.publish(runId);
        return;
      }

      const step = await this.step(state, plan);
      if (step === "progressed") {
        published = true;
        continue;
      }
      if (step === "published") published = true;
      if (published) this.publish(runId);
      return;
    }
    this.log("warn", { event: "ensemble_advance_guard", runId });
    if (published) this.publish(runId);
  }

  /** One walk of the stages. Returns whether it should loop, stopped, or already published. */
  private async step(state: RunState, plan: CompiledEnsemblePlan): Promise<"progressed" | "stopped" | "published"> {
    const stages = [...plan.stages].sort((a, b) => a.ordinal - b.ordinal);
    for (const stage of stages) {
      if (!this.driverMatches(stage)) {
        this.failRun(state.run.id, `stage ${stage.id} pairs ${stage.driverKind} with incompatible driver ${stage.driverKey}`);
        return "published";
      }
      const status = this.stageStatus(state, stage);
      if (status === "succeeded") continue;
      if (status === "failed") {
        this.failRun(state.run.id, `stage ${stage.id} could not complete`);
        return "published";
      }
      if (status === "running") {
        // A member stage mid-launch: launch more if a slot is free, or mark it done if its whole
        // wave has settled. Only the latter is progress that unblocks a later stage.
        return await this.serviceMemberStage(state, stage);
      }
      // Not started. It runs only when its dependencies have succeeded and its barrier holds.
      if (!this.dependenciesMet(state, stage)) {
        this.setRunStatus(state.run.id, "waiting", { activeStageId: stage.id });
        return "published";
      }
      if (this.barrierImpossible(state, stage.barrier)) {
        this.failRun(
          state.run.id,
          `stage ${stage.id} can no longer meet its barrier: too many members failed or withdrew`,
        );
        return "published";
      }
      if (!this.barrierSatisfied(state, stage.barrier)) {
        this.setRunStatus(state.run.id, "waiting", { activeStageId: stage.id });
        return "published";
      }
      return await this.startStage(state, stage);
    }
    // Every stage has succeeded. The run is done with its compiled work.
    this.completeRun(state);
    return "published";
  }

  // ---- member reconciliation from Task state ----

  private latestAttempt(state: Pick<RawRunState, "attempts">, memberId: string): EnsembleAttempt | null {
    let latest: EnsembleAttempt | null = null;
    for (const attempt of state.attempts) {
      if (attempt.memberId !== memberId) continue;
      if (!latest || attempt.attempt > latest.attempt) latest = attempt;
    }
    return latest;
  }

  /** Fold current Task statuses into member/attempt rows. Returns whether anything changed. */
  private reconcileMembers(state: RunState): boolean {
    let changed = false;
    const now = this.now();
    for (const member of state.members) {
      if (member.taskId === null || !OCCUPYING_MEMBER_STATUSES.includes(member.status ?? "pending")) {
        continue;
      }
      const attempt = this.latestAttempt(state, member.id);
      const taskStatus = this.tasks.status(member.taskId);
      if (attempt?.status === "pending" && (taskStatus === null || taskStatus === "backlog")) {
        continue;
      }
      if (taskStatus === "running" && member.status === "launching") {
        this.store.setMemberStatus(member.id, ["launching"], "active", {}, now);
        if (attempt) {
          this.store.setAttemptStatus(
            attempt.id,
            ["pending", "launching"],
            "running",
            {
              sessionId: this.tasks.sessionId(member.taskId),
              observedModel: this.tasks.observedModel(member.taskId),
              worktreePath: this.tasks.worktreePath(member.taskId),
              startedAt: now,
            },
            now,
          );
        }
        this.event(member.runId, "member_active", { memberId: member.id }, `member_active:${attempt?.id ?? member.id}`);
        changed = true;
        continue;
      }
      const ended =
        taskStatus === null ||
        taskStatus === "failed" ||
        taskStatus === "cancelled" ||
        taskStatus === "done";
      if (ended) {
        this.store.setMemberStatus(
          member.id,
          ["launching", "active"],
          "failed",
          { error: "the member's task ended without submitting a result" },
          now,
        );
        if (attempt) {
          this.store.setAttemptStatus(
            attempt.id,
            ["pending", "launching", "running"],
            "failed",
            { error: "the member's task ended without submitting a result", finishedAt: now },
            now,
          );
        }
        this.event(member.runId, "member_failed", { memberId: member.id }, `member_failed:${attempt?.id ?? member.id}`);
        changed = true;
      }
    }
    return changed;
  }

  // ---- stage state ----

  private stageAttemptsFor(state: RunState, stageId: string): EnsembleStageAttempt[] {
    return state.stageAttempts.filter((attempt) => attempt.stageId === stageId);
  }

  private latestStageAttempt(state: RunState, stageId: string): EnsembleStageAttempt | null {
    let latest: EnsembleStageAttempt | null = null;
    for (const attempt of this.stageAttemptsFor(state, stageId)) {
      if (!latest || attempt.attempt > latest.attempt) latest = attempt;
    }
    return latest;
  }

  private stageStatus(state: RunState, stage: EnsembleStageSpec): "not_started" | "running" | "succeeded" | "failed" {
    const attempt = this.latestStageAttempt(state, stage.id);
    if (!attempt) return "not_started";
    if (attempt.status === "succeeded") return "succeeded";
    if (attempt.status === "cancelled") return "failed";
    if (attempt.status === "failed") {
      // A failed stage attempt is only a stage failure once its retries are spent.
      return attempt.attempt >= stage.maxAttempts ? "failed" : "not_started";
    }
    return "running";
  }

  private dependenciesMet(state: RunState, stage: EnsembleStageSpec): boolean {
    return stage.dependsOn.every((dependency) => {
      const dep = state.run.plan.stages.find((s) => s.id === dependency);
      return dep ? this.stageStatus(state, dep) === "succeeded" : true;
    });
  }

  // ---- barriers ----

  private membersForRoles(state: RunState, roleKeys: string[]): EnsembleMember[] {
    const keys = new Set(roleKeys);
    return state.members.filter((member) => keys.has(member.roleKey));
  }

  /** Members named by a barrier that have produced every required ready artifact. */
  private eligibleCount(state: RunState, roleKeys: string[], requiredArtifacts: string[]): number {
    let count = 0;
    for (const member of this.membersForRoles(state, roleKeys)) {
      if (this.memberHasArtifacts(state, member, requiredArtifacts)) count += 1;
    }
    return count;
  }

  private memberHasArtifacts(state: RunState, member: EnsembleMember, kinds: string[]): boolean {
    const attemptIds = new Set(
      state.attempts.filter((attempt) => attempt.memberId === member.id).map((attempt) => attempt.id),
    );
    return kinds.every((kind) =>
      state.artifacts.some(
        (artifact) =>
          artifact.status === "ready" &&
          artifact.kind === kind &&
          artifact.attemptId !== null &&
          attemptIds.has(artifact.attemptId),
      ),
    );
  }

  private barrierSatisfied(state: RunState, barrier: EnsembleBarrierSpec): boolean {
    switch (barrier.kind) {
      case "none":
        return true;
      case "members_settled": {
        const members = this.membersForRoles(state, barrier.roleKeys);
        const allSettled = members.length > 0 && members.every((member) => isSettled(member.status));
        return allSettled && this.eligibleCount(state, barrier.roleKeys, barrier.requiredArtifacts) >= barrier.minEligible;
      }
      case "stages_succeeded":
        return barrier.stageIds.every((stageId) => {
          const stage = state.run.plan.stages.find((s) => s.id === stageId);
          return stage ? this.stageStatus(state, stage) === "succeeded" : false;
        });
      case "human_decision":
        return this.store.listDecisions(state.run.id).some(
          (decision) => decision.status === "recorded" || decision.status === "applied",
        );
    }
  }

  private barrierImpossible(state: RunState, barrier: EnsembleBarrierSpec): boolean {
    switch (barrier.kind) {
      case "members_settled": {
        const members = this.membersForRoles(state, barrier.roleKeys);
        if (members.length === 0 || !members.every((member) => isSettled(member.status))) return false;
        return this.eligibleCount(state, barrier.roleKeys, barrier.requiredArtifacts) < barrier.minEligible;
      }
      case "stages_succeeded":
        return barrier.stageIds.some((stageId) => {
          const stage = state.run.plan.stages.find((s) => s.id === stageId);
          return stage ? this.stageStatus(state, stage) === "failed" : true;
        });
      case "none":
      case "human_decision":
        return false;
    }
  }

  // ---- starting and servicing stages ----

  private driverMatches(stage: EnsembleStageSpec): boolean {
    return (DRIVER_KEYS_BY_KIND[stage.driverKind] as readonly string[]).includes(stage.driverKey);
  }

  private async startStage(state: RunState, stage: EnsembleStageSpec): Promise<"progressed" | "stopped" | "published"> {
    if (stage.driverKind === "member") {
      await this.startMemberStage(state, stage);
      return "progressed";
    }
    // review / decision / finalize: recognized, but their drivers are not executable in this phase.
    // The engine parks the run in the matching status and stops rather than best-efforting past a
    // stage it cannot run - a later phase adds the executor that starts its stage attempt.
    const parked: EnsembleStatus =
      stage.driverKind === "review"
        ? "evaluating"
        : stage.driverKind === "decision"
          ? "awaiting_decision"
          : "finalizing";
    this.setRunStatus(state.run.id, parked, { activeStageId: stage.id });
    return "published";
  }

  /**
   * create_member_wave: every member of the wave gets a backlog Task and a persisted attempt BEFORE
   * any of them is dispatched, and the stage attempt is recorded first with a deterministic command
   * key so a crash mid-wave finds the row rather than launching the wave twice.
   */
  private async startMemberStage(state: RunState, stage: EnsembleStageSpec & { driverKind: "member"; wave: number; roleKeys: string[] }): Promise<void> {
    const run = state.run;
    const now = this.now();
    if (stage.wave > run.plan.budget.maxWaves) {
      this.failRun(run.id, `stage ${stage.id} is wave ${stage.wave}, past the plan's ${run.plan.budget.maxWaves}-wave cap`);
      return;
    }
    const commandKey = `wave:${run.id}:${stage.id}:1`;
    this.store.startStageAttempt(
      {
        runId: run.id,
        stageId: stage.id,
        driverKind: "member",
        driverKey: stage.driverKey,
        attempt: 1,
        commandKey,
        status: "running",
        input: { command: "create_member_wave", wave: stage.wave, roleKeys: stage.roleKeys } as EnsembleJson,
      },
      now,
    );
    this.event(run.id, "wave_created", { stageId: stage.id, wave: stage.wave }, `wave_created:${run.id}:${stage.id}`);

    // Every task in the wave, created before the first dispatch. A member already carrying a task
    // (a resumed wave, an idempotent re-entry) is left as it is.
    for (const roleKey of stage.roleKeys) {
      const member = state.members.find((m) => m.roleKey === roleKey);
      if (!member || member.status !== "pending" || member.taskId !== null) continue;
      this.createMember(run, member, now);
    }
    // Reload and dispatch up to the concurrency ceiling.
    this.setRunStatus(run.id, "running", { activeStageId: stage.id });
    await this.launchReadyMembers(this.load(run.id) ?? state, stage);
  }

  private createMember(run: RunnableEnsembleRun, member: EnsembleMember, now: number): void {
    const role = run.plan.roles.find((r) => r.key === member.roleKey);
    if (!role) return;
    const input = this.resolveMemberInput(run, role, now);
    if (!input.ok) {
      this.store.setMemberStatus(member.id, ["pending"], "failed", { error: input.detail }, now);
      this.event(run.id, "member_failed", { memberId: member.id, detail: input.detail }, `member_failed:${member.id}:input`);
      return;
    }
    const prompt = buildMemberPrompt({
      runId: run.id,
      intent: run.intent,
      role,
      totalMembers: run.plan.roles.length,
      baseSha: input.baseSha,
      parentLabels: input.parentLabels,
    });
    const taskId = randomUUID();
    const agent = role.agent ?? AGENT_TYPES[0];
    this.store.reserveAttempt(
      {
        runId: run.id,
        memberId: member.id,
        attempt: 1,
        taskId,
        sessionId: null,
        agent,
        requestedModel: role.model,
        requestedEffort: role.effort,
        baseSha: input.baseSha,
        worktreePath: null,
        branch: null,
        status: "pending",
      },
      ["pending"],
      now,
    );
    this.tasks.create({
      taskId,
      runId: run.id,
      memberId: member.id,
      repoRoot: run.repoRoot,
      intent: prompt,
      title: `${run.title} - ${role.label}`,
      agent,
      model: role.model,
      effort: role.effort,
    });
    this.event(run.id, "member_created", { memberId: member.id, taskId }, `member_created:${member.id}`);
  }

  private ensureMemberTask(state: RunState, member: EnsembleMember): void {
    const attempt = this.latestAttempt(state, member.id);
    const role = state.run.plan.roles.find((candidate) => candidate.key === member.roleKey);
    if (!attempt || !attempt.taskId || !attempt.baseSha || !role) return;
    const input = this.resolveMemberInput(state.run, role, this.now());
    if (!input.ok) return;
    const prompt = buildMemberPrompt({
      runId: state.run.id,
      intent: state.run.intent,
      role,
      totalMembers: state.run.plan.roles.length,
      baseSha: attempt.baseSha,
      parentLabels: input.parentLabels,
    });
    this.tasks.create({
      taskId: attempt.taskId,
      runId: state.run.id,
      memberId: member.id,
      repoRoot: state.run.repoRoot,
      intent: prompt,
      title: `${state.run.title} - ${role.label}`,
      agent: attempt.agent ?? role.agent ?? AGENT_TYPES[0],
      model: attempt.requestedModel,
      effort: attempt.requestedEffort,
    });
  }

  /** Resolve where a member's checkout starts, from its compiled input policy. */
  private resolveMemberInput(
    run: RunnableEnsembleRun,
    role: EnsembleRoleSpec,
    _now: number,
  ): { ok: true; baseSha: string; parentLabels: string[] } | { ok: false; detail: string } {
    if (run.baseSha === null) return { ok: false, detail: "the run has no pinned base commit" };
    if (role.input.kind === "run_base") {
      return { ok: true, baseSha: run.baseSha, parentLabels: [] };
    }
    // parent_artifacts: start from the first named parent's ready commit artifact. The others are
    // named to the member as context; the pinned base is the one it is provisioned at.
    const members = this.store.listMembers(run.id);
    const artifacts = this.store.listArtifacts(run.id);
    const attempts = this.store.listAttempts(run.id);
    const labels: string[] = [];
    let baseSha: string | null = null;
    for (const parentKey of role.input.roleKeys) {
      const parent = members.find((m) => m.roleKey === parentKey);
      if (!parent) return { ok: false, detail: `parent role ${parentKey} does not exist` };
      labels.push(parent.roleLabel);
      const attemptIds = new Set(attempts.filter((a) => a.memberId === parent.id).map((a) => a.id));
      const artifact = artifacts.find(
        (a) => a.status === "ready" && a.kind === "commit" && a.attemptId !== null && attemptIds.has(a.attemptId),
      );
      if (artifact && baseSha === null) {
        const sha = this.snapshotSha(artifact);
        if (sha) baseSha = sha;
      }
    }
    if (baseSha === null) return { ok: false, detail: "no parent produced a ready commit artifact to start from" };
    return { ok: true, baseSha, parentLabels: labels };
  }

  private snapshotSha(artifact: EnsembleArtifact): string | null {
    const locator = artifact.locator;
    if (locator && typeof locator === "object" && !Array.isArray(locator) && typeof locator.snapshotSha === "string") {
      return locator.snapshotSha;
    }
    return null;
  }

  /**
   * launch_member: dispatch pending members of the active stage while a concurrency slot is free.
   *
   * A slot is one member holding a worktree and a launching-or-running agent, so a slot frees only
   * when a member SETTLES - not when it merely stops for a turn. Dispatch is fire-and-forget through
   * TaskManager; the member is `launching` the instant its attempt is dispatched, and the engine
   * learns it is `running` from the next reconcile, never from the dispatch call returning.
   */
  private async launchReadyMembers(state: RunState, stage: EnsembleStageSpec & { driverKind: "member"; roleKeys: string[] }): Promise<void> {
    const ceiling = state.run.plan.budget.maxConcurrentMembers;
    const roleSet = new Set(stage.roleKeys);
    let occupied = state.members.filter(
      (m) => OCCUPYING_MEMBER_STATUSES.includes(m.status ?? "pending") && this.attemptDispatched(state, m),
    ).length;
    const launchedTotal = state.attempts.length;
    for (const member of state.members) {
      if (!roleSet.has(member.roleKey)) continue;
      if (member.status !== "launching") continue;
      const attempt = this.latestAttempt(state, member.id);
      if (!attempt || attempt.status !== "pending") continue; // already dispatched
      if (occupied >= ceiling) break;
      if (launchedTotal > state.run.plan.budget.maxMembers) {
        this.failRun(state.run.id, "a member launch would exceed the plan's hard member cap");
        return;
      }
      const role = state.run.plan.roles.find((r) => r.key === member.roleKey);
      this.store.setAttemptStatus(attempt.id, ["pending"], "launching", {}, this.now());
      this.tasks.dispatch({
        taskId: attempt.taskId!,
        baseSha: attempt.baseSha!,
        model: role?.model ?? null,
        effort: role?.effort ?? null,
      });
      this.event(state.run.id, "member_launched", { memberId: member.id }, `member_launched:${attempt.id}`);
      occupied += 1;
    }
  }

  private attemptDispatched(state: RunState, member: EnsembleMember): boolean {
    const attempt = this.latestAttempt(state, member.id);
    return attempt !== null && attempt.status !== "pending";
  }

  /** A running member stage: launch what it can, and succeed once its whole wave has settled. */
  private async serviceMemberStage(state: RunState, stage: EnsembleStageSpec): Promise<"progressed" | "stopped" | "published"> {
    if (stage.driverKind !== "member") return "stopped";
    for (const roleKey of stage.roleKeys) {
      const member = state.members.find((candidate) => candidate.roleKey === roleKey);
      if (member?.status === "pending" && member.taskId === null) this.createMember(state.run, member, this.now());
    }
    let current = this.load(state.run.id) ?? state;
    for (const member of this.membersForRoles(current, stage.roleKeys)) {
      const attempt = this.latestAttempt(current, member.id);
      if (member.status === "launching" && attempt?.status === "pending") this.ensureMemberTask(current, member);
    }
    current = this.load(state.run.id) ?? current;
    const members = this.membersForRoles(current, stage.roleKeys);
    const allSettled = members.length > 0 && members.every((member) => isSettled(member.status));
    if (allSettled) {
      const attempt = this.latestStageAttempt(state, stage.id);
      if (attempt) this.store.finishStageAttempt(attempt.id, ["running", "waiting", "queued"], "succeeded", {}, this.now());
      this.event(state.run.id, "stage_succeeded", { stageId: stage.id }, `stage_succeeded:${attempt?.id ?? stage.id}`);
      return "progressed";
    }
    await this.launchReadyMembers(current, stage as EnsembleStageSpec & { driverKind: "member"; roleKeys: string[] });
    this.setRunStatus(state.run.id, "running", { activeStageId: stage.id });
    return "published";
  }

  // ---- submission ----

  private activeAttemptFor(state: RunState, member: EnsembleMember): EnsembleAttempt | null {
    let best: EnsembleAttempt | null = null;
    for (const attempt of state.attempts) {
      if (attempt.memberId !== member.id) continue;
      if (attempt.status !== "launching" && attempt.status !== "running") continue;
      if (!best || attempt.attempt > best.attempt) best = attempt;
    }
    return best;
  }

  private ownedWorktree(attempt: EnsembleAttempt): string | null {
    if (!attempt.taskId || !attempt.worktreePath) return null;
    const current = this.tasks.worktreePath(attempt.taskId);
    return current === attempt.worktreePath ? current : null;
  }

  private readyCommitFor(state: RunState, member: EnsembleMember): EnsembleArtifact | null {
    const attemptIds = new Set(
      state.attempts.filter((a) => a.memberId === member.id).map((a) => a.id),
    );
    return (
      state.artifacts.find(
        (a) => a.status === "ready" && a.kind === "commit" && a.attemptId !== null && attemptIds.has(a.attemptId),
      ) ?? null
    );
  }

  private async submitLocked(input: EnsembleSubmitInput): Promise<EnsembleSubmitOutcome> {
    const state = this.load(input.runId);
    if (!state) return { ok: false, reason: "run_not_accepting", detail: "no such runnable ensemble" };
    if (!runIsAccepting(state.run.status)) {
      return { ok: false, reason: "run_not_accepting", detail: `run is ${state.run.status}` };
    }
    if (this.enforceDeadline(state)) {
      this.publish(input.runId);
      return { ok: false, reason: "run_not_accepting", detail: "the run's wall-clock deadline has passed" };
    }
    const member = state.members.find((m) => m.id === input.memberId);
    if (!member) return { ok: false, reason: "no_member", detail: "no such member in this run" };

    const digest = claimsDigest(input.claims);
    const existing = this.readyCommitFor(state, member);
    if (existing) {
      const priorDigest = readClaimsDigest(existing);
      if (priorDigest !== null && priorDigest === digest) {
        const attempt = existing.attemptId
          ? state.attempts.find((candidate) => candidate.id === existing.attemptId)
          : null;
        if (attempt) {
          this.store.completeSubmission({
            runId: input.runId,
            memberId: member.id,
            attemptId: attempt.id,
            artifactId: existing.id,
            readyAt: existing.readyAt ?? this.now(),
          });
        }
        return { ok: true, artifact: existing, replayed: true };
      }
      return { ok: false, reason: "already_submitted", detail: "this member has already submitted a different result" };
    }
    if (!SUBMITTABLE_MEMBER_STATUSES.includes(member.status ?? "pending")) {
      return { ok: false, reason: "member_inactive", detail: `member is ${member.status ?? "unknown"}` };
    }
    const attempt = this.activeAttemptFor(state, member);
    if (!attempt) return { ok: false, reason: "no_attempt", detail: "member has no active launch attempt" };

    const worktree = this.ownedWorktree(attempt);
    if (!worktree) return { ok: false, reason: "no_worktree", detail: "member has no live worktree to capture" };
    if (input.requireWorktree !== null && input.requireWorktree !== worktree) {
      return { ok: false, reason: "wrong_cwd", detail: "the calling session is not in this member's worktree" };
    }
    const baseSha = attempt.baseSha ?? state.run.baseSha;
    if (!baseSha) return { ok: false, reason: "no_worktree", detail: "member has no pinned base to diff against" };

    const adapter = this.adapterFor("commit");
    if (!adapter) return { ok: false, reason: "capture_failed", detail: "no adapter for commit artifacts" };

    const now = this.now();
    const captureAttempt = this.store.nextArtifactAttempt(input.runId, attempt.id, "commit");
    const capturing = this.store.recordArtifact(
      {
        runId: input.runId,
        attemptId: attempt.id,
        kind: "commit",
        formatVersion: adapter.formatVersion,
        attempt: captureAttempt,
        status: "capturing",
        locator: null,
        digest: "",
        metadata: reportedMetadata(input.claims, digest, input.source, now),
        operationKey: `capture:${attempt.id}:${captureAttempt}`,
        readyAt: null,
      },
      now,
    );

    let captured;
    try {
      captured = await adapter.capture({
        runId: input.runId,
        artifactId: capturing.id,
        worktreePath: worktree,
        baseSha,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.store.setArtifactStatus(capturing.id, "failed", { error: detail }, this.now());
      this.event(input.runId, "capture_failed", { memberId: member.id, detail }, `capture_failed:${capturing.id}`);
      // The member stays active: nothing was captured, and it may try again.
      this.publish(input.runId);
      return { ok: false, reason: "capture_failed", detail };
    }

    const readyAt = this.now();
    const completed = this.store.completeSubmission(
      {
        runId: input.runId,
        memberId: member.id,
        attemptId: attempt.id,
        artifactId: capturing.id,
        locator: captured.locator,
        digest: captured.fingerprint,
        metadata: {
          observed: captured.observed,
          reported: reportedClaims(input.claims),
          claimsDigest: digest,
          source: input.source,
          capturedAt: readyAt,
        } as EnsembleJson,
        readyAt,
      },
      readyAt,
    );
    if (!completed.ok) {
      const detail = "the captured artifact could not be finalized against its active member";
      this.event(input.runId, "capture_failed", { memberId: member.id, detail }, `capture_failed:${capturing.id}:finalize`);
      this.publish(input.runId);
      return { ok: false, reason: "capture_failed", detail };
    }
    this.event(
      input.runId,
      "member_submitted",
      { memberId: member.id, artifactId: capturing.id, source: input.source },
      `member_submitted:${attempt.id}`,
    );

    await this.advanceLocked(input.runId);
    return { ok: true, artifact: completed.value, replayed: false };
  }

  // ---- terminal transitions ----

  private completeRun(state: RunState): void {
    const readyArtifacts = state.artifacts.filter((a) => a.status === "ready");
    if (readyArtifacts.length === 0) {
      this.failRun(state.run.id, "every member settled without producing an artifact");
      return;
    }
    const now = this.now();
    // A member-only plan has no selection to make and nothing to reap: it completes with every
    // submitted member RETAINED, a non-destructive terminal that needs no human. A plan whose
    // terminal is a select-one finalize never reaches here - it parks in `finalizing` first.
    const submitted = state.members.filter((m) => m.status === "submitted");
    const memberIds = submitted.map((m) => m.id);
    const artifactIds = submitted
      .map((m) => this.readyCommitFor(state, m)?.id)
      .filter((id): id is string => typeof id === "string");
    for (const member of submitted) {
      this.store.setMemberStatus(member.id, ["submitted"], "retained", {}, now);
    }
    this.store.setRunStatus(
      state.run.id,
      ["running", "waiting", "evaluating"],
      "completed",
      { outcome: { kind: "retained", memberIds, artifactIds }, completedAt: now, activeStageId: null },
      now,
    );
    this.event(state.run.id, "run_completed", { outcome: "retained", members: memberIds.length }, `run_completed:${state.run.id}`);
  }

  private failRun(runId: string, reason: string): void {
    const now = this.now();
    this.store.setRunStatus(runId, NON_TERMINAL_RUN_STATUSES, "failed", { error: reason, completedAt: now }, now);
    this.event(runId, "run_failed", { reason }, `run_failed:${runId}:${now}`);
  }

  private enforceDeadline(state: RunState): boolean {
    const deadline = state.run.plan.budget.deadlineMs;
    if (deadline === null) return false;
    if (this.now() - state.run.createdAt <= deadline) return false;
    this.failRun(state.run.id, "the run passed its wall-clock deadline before finishing");
    return true;
  }

  private setRunStatus(runId: string, next: EnsembleStatus, patch: { activeStageId?: string | null } = {}): void {
    this.store.setRunStatus(runId, NON_TERMINAL_RUN_STATUSES, next, patch, this.now());
  }

  private event(runId: string, kind: string, payload: EnsembleJson, operationKey: string): void {
    try {
      this.store.appendEvent({ runId, kind, payload, operationKey }, this.now());
    } catch (err) {
      this.log("warn", { event: "ensemble_event_failed", runId, kind, error: String(err) });
    }
  }
}

// ---- pure claim helpers ----

/** A stable digest of a member's claims, so a byte-equivalent resubmission is recognized as one. */
export function claimsDigest(claims: EnsembleSubmissionClaims): string {
  const canonical = JSON.stringify({
    summary: claims.summary,
    checks: [...claims.checks],
    testEvidence: claims.testEvidence,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function reportedClaims(claims: EnsembleSubmissionClaims): EnsembleJson {
  return { summary: claims.summary, checks: [...claims.checks], testEvidence: claims.testEvidence };
}

/** The capturing row's placeholder metadata - the claims and their digest, before evidence exists. */
function reportedMetadata(
  claims: EnsembleSubmissionClaims,
  digest: string,
  source: "mcp" | "operator",
  now: number,
): EnsembleJson {
  return { reported: reportedClaims(claims), claimsDigest: digest, source, capturedAt: now };
}

function readClaimsDigest(artifact: EnsembleArtifact): string | null {
  const metadata = artifact.metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata) && typeof metadata.claimsDigest === "string") {
    return metadata.claimsDigest;
  }
  return null;
}

function recoveredMetadata(metadata: EnsembleJson, observed: EnsembleJson, capturedAt: number): EnsembleJson {
  const prior = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {};
  return { ...prior, observed, capturedAt };
}
