import { createHash, randomUUID } from "node:crypto";
import {
  ENSEMBLE_DRIVER_KEYS,
  ENSEMBLE_LIMITS,
  ensembleJsonEqual,
  ensembleIsRunnable,
  ensembleIsTerminal,
  ensemblePayload,
  type CompiledEnsemblePlan,
  type EnsembleArtifact,
  type EnsembleAttempt,
  type EnsembleBarrierSpec,
  type EnsembleDecision,
  type EnsembleDecisionPolicy,
  type EnsembleEvaluatorGuidance,
  type EnsembleEvaluatorKind,
  type EnsembleEvaluatorPolicy,
  type EnsembleFinalizationProgress,
  type EnsembleJson,
  type EnsembleLlmPurpose,
  type EnsembleMember,
  type EnsembleMemberStatus,
  type EnsembleOutcome,
  type EnsembleRoleSpec,
  type EnsembleStageAttempt,
  type EnsembleStageSpec,
  type EnsembleStatus,
  type EnsembleRun,
  type EnsembleStageDriverKind,
  type EnsembleWorkflowHandoff,
  type RunnableEnsembleRun,
} from "@shared/ensemble.ts";
import { AGENT_TYPES, type AgentType, type ThinkingLevel } from "@shared/types.ts";
import type { LlmRunnerId } from "@shared/llm.ts";
import type { EnsembleSubmissionClaims } from "@shared/protocol.ts";
import { EnsembleStore } from "./store.ts";
import { artifactAdapterFor, type ArtifactAdapterRegistry } from "./artifacts/index.ts";
import { buildMemberPrompt } from "./member-prompt.ts";
import { decisionDriverFor, type DecisionResult } from "./decisions/index.ts";
import { finalizerFor, type FinalizePlan } from "./finalizers/index.ts";
import {
  reviewDriverFor,
  type ReviewDriver,
  type ReviewExecution,
  type ReviewOutcome,
  type ReviewPersist,
  type ReviewRuntime,
  type ReviewSubject,
} from "./reviews/index.ts";
import type { ReviewScheduler } from "../llm/review-scheduler.ts";

/** The wall-clock budget for one comparison provider call. Matches the Workflow Persona ceiling. */
const DEFAULT_REVIEW_TIMEOUT_MS = 120_000;

/**
 * The review side of the engine's dependencies - present only when this build can execute a review
 * stage. Absent, a review stage parks at `evaluating` exactly as it did before an executor existed,
 * which keeps a launch-only build (and the member-launch tests) working unchanged.
 */
export interface EnsembleReviewDeps {
  /** The daemon-owned ceiling shared with Workflow review and compaction. */
  scheduler: ReviewScheduler;
  /** Resolve runner+model at attempt time from the guidance overrides / app+job ladder. */
  resolveExecution: (guidance: EnsembleEvaluatorGuidance, policy: EnsembleEvaluatorPolicy) => ReviewExecution;
  /** The bound, tool-less provider call. Tests inject a fake instead of a real model. */
  runModel: (runnerId: LlmRunnerId, prompt: string, opts: { modelId: string; timeoutMs: number }) => Promise<string>;
  /** Per-attempt wall-clock budget; defaults to the Persona ceiling. */
  timeoutMs?: number;
}

/** A finalization side effect either happened or is refused with a sentence the operator can act on. */
export type FinalizeStepResult = { ok: true } | { ok: false; detail: string };
export type ContinuationDeliveryResult =
  | { ok: true }
  | { ok: false; retryable: boolean; detail: string };

/** Everything the daemon needs to materialize one replacement normal Task at a snapshot. */
export interface ReplacementTaskRequest {
  taskId: string;
  runId: string;
  repoRoot: string;
  title: string;
  /** The full intent, already carrying the winner continuation - so it is typed once, at launch. */
  intent: string;
  agent: AgentType;
  model: string | null;
  effort: ThinkingLevel | null;
  /** The commit the replacement worktree is provisioned at and verified against. */
  snapshotSha: string;
}

/**
 * The Workflow handoff boundary, injected so the engine never imports WorkflowManager.
 *
 * Both calls are idempotent on their server-derived source key - a restart returns the same
 * binding and run rather than creating a second. `ensureBinding` refuses a note key already owned
 * by a different active binding (a typed `conflict` the operator resolves or skips); `submit`
 * refuses a winner whose HEAD is not the snapshot or whose tree is dirty (a `mismatch` the engine
 * heals by restoring and resuming the SAME submission).
 */
export interface EnsembleWorkflowHandoffDeps {
  ensureBinding(input: {
    sessionId: string;
    workflowVersionId: string;
    sourceId: string;
    resultId: string;
  }):
    | { ok: true; bindingId: string; created: boolean }
    | { ok: false; reason: "conflict" | "unavailable" | "ineligible" | "other"; detail: string };
  submit(input: {
    bindingId: string;
    sourceId: string;
    resultId: string;
    expectedHeadSha: string;
  }): Promise<
    | { ok: true; runId: string; submissionId: string }
    | { ok: false; reason: "mismatch" | "conflict" | "unavailable" | "other"; detail: string }
  >;
}

/**
 * The finalization authorities, injected only in a build that can execute a select-one finalize.
 *
 * Absent, a finalize stage parks at `finalizing` exactly as it did before an executor existed,
 * which keeps a launch/review-only build and the earlier phases' tests working unchanged. Every
 * method here is an EFFECT the engine is not otherwise allowed to perform - a destructive session
 * reset, a Task materialization, a pane write, a Workflow submission - kept off the narrow member
 * gateway on purpose: the pure finalizer computes WHAT to do, and these perform it, one owner each.
 */
export interface EnsembleFinalizeDeps {
  /** Re-verify a ready commit artifact's private ref still resolves to its snapshot SHA, or null. */
  verifyArtifact(input: { locator: EnsembleJson; repoPath: string }): Promise<string | null>;
  /** Whether a live session is safe to restore/rebind into right now - idle, instrumented, ungated. */
  sessionSafeToRebind(sessionId: string): Promise<boolean>;
  /** Restore a retained winner's checkout to its snapshot through `resetSession`, clearing state. */
  restoreWinner(input: {
    sessionId: string;
    snapshotSha: string;
    ref: string;
  }): Promise<FinalizeStepResult>;
  /** HEAD sha and cleanliness of a worktree, for the pre-handoff exactness check. */
  worktreeHead(input: { worktreePath: string }): Promise<{ headSha: string | null; clean: boolean }>;
  /** Deliver one continuation prompt to a live session's pane through the guarded inject path. */
  deliverContinuation(input: { sessionId: string; text: string }): Promise<ContinuationDeliveryResult>;
  /** Create + dispatch one replacement normal Task at a snapshot; idempotent on its preallocated id. */
  materializeReplacement(request: ReplacementTaskRequest): Promise<FinalizeStepResult>;
  /** The current durable status, live session, and worktree of a materialized replacement Task. */
  replacementStatus(taskId: string): {
    status: TaskGatewayStatus | null;
    sessionId: string | null;
    worktreePath: string | null;
  };
  /** The Workflow handoff boundary, present only when the daemon wired a WorkflowManager in. */
  workflow?: EnsembleWorkflowHandoffDeps;
}

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
  /**
   * Dispatch a created member Task with its pinned base and the ensemble submission tool. Rejects if
   * the dispatch itself is refused or throws, so the engine can fail the member rather than leave it
   * stuck launching. It does NOT wait for the agent to come up - the engine observes that durably.
   */
  dispatch(request: MemberDispatchRequest): Promise<void>;
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
  /**
   * The member session's authoritative agent cost so far, in USD, or null when unknown.
   *
   * Null is the honest answer for a runner that reports no cost, or a session already gone -
   * never zero, because "we have not been told" and "it was free" are different claims. Read at
   * submission, the one durable observation boundary, and frozen into the immutable artifact so
   * the figure survives the member's session exiting.
   */
  sessionCostUsd(taskId: string): number | null;
}

/** The subset of `TaskStatus` the engine reacts to, named so the engine needs no task types. */
export type TaskGatewayStatus = "backlog" | "dispatching" | "running" | "done" | "cancelled" | "failed";

export interface EnsembleEngineDeps {
  store: EnsembleStore;
  tasks: EnsembleTaskGateway;
  /** Re-read one run and push its compact summary + task projection onto the live channel. */
  publish: (runId: string) => void;
  adapters?: ArtifactAdapterRegistry;
  /** The comparison executor. Absent, a review stage parks rather than runs. */
  review?: EnsembleReviewDeps;
  /** The finalization executor. Absent, a finalize stage parks at `finalizing` rather than runs. */
  finalize?: EnsembleFinalizeDeps;
  now?: () => number;
  log?: (level: "info" | "warn" | "error", fields: Record<string, unknown>) => void;
  /**
   * Arm a one-shot wall-clock timer and return a canceller. Injected so a test controls time and so
   * a quiet run - one whose members run stably past its deadline, producing no registry event - is
   * still failed on schedule rather than only when the next event happens to arrive. The default is
   * an unref'd `setTimeout`; tests pass a no-op or a controllable stub.
   */
  armTimer?: (delayMs: number, fire: () => void) => () => void;
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

// ---- decision ----

export type EnsembleDecideReason =
  | "no_run"
  | "wrong_state"
  | "conflict"
  | "not_decision_stage"
  | "no_driver"
  | "invalid_selection"
  | "ineligible_artifact"
  | "insufficient_eligible"
  | "unknown_member";

export type EnsembleDecideOutcome =
  | { ok: true; decision: EnsembleDecision; replayed: boolean }
  | { ok: false; reason: EnsembleDecideReason; detail: string; status: EnsembleStatus | null };

export interface EnsembleDecideInput {
  runId: string;
  /** Client-stable idempotency key; the same one returns the same recorded decision. */
  requestId: string;
  /** The run state the caller believed it was deciding in. A mismatch is refused, never acted on. */
  expectedStatus: EnsembleStatus;
  selection: EnsembleJson;
  rationale: string;
  actorId: string | null;
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
  review: ["artifact_barrier@1", "comparative_review@1", "consensus_review@1"],
  decision: ["human_decision@1", "divergence_decision@1"],
  finalize: ["select_one_finalize@1", "retain_all_finalize@1"],
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
  private readonly review: EnsembleReviewDeps | null;
  private readonly finalize: EnsembleFinalizeDeps | null;
  private readonly publish: (runId: string) => void;
  private readonly now: () => number;
  private readonly log: (level: "info" | "warn" | "error", fields: Record<string, unknown>) => void;
  private readonly armTimer: (delayMs: number, fire: () => void) => () => void;
  private readonly locks = new Map<string, Promise<void>>();
  /** One pending deadline wake per run, so a re-arm cancels the prior one and a terminal clears it. */
  private readonly deadlineTimers = new Map<string, () => void>();
  /** The abort controller of the one in-flight review per run, so a cancel can stop its retry. */
  private readonly reviewAborts = new Map<string, AbortController>();

  constructor(deps: EnsembleEngineDeps) {
    this.store = deps.store;
    this.tasks = deps.tasks;
    this.adapters = deps.adapters ?? null;
    this.review = deps.review ?? null;
    this.finalize = deps.finalize ?? null;
    this.publish = deps.publish;
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log ?? (() => {});
    this.armTimer =
      deps.armTimer ??
      ((delayMs, fire) => {
        const timer = setTimeout(fire, Math.max(0, delayMs));
        timer.unref?.();
        return () => clearTimeout(timer);
      });
  }

  /**
   * Arm (or re-arm) the wall-clock deadline wake for one non-terminal run, or clear it when the run
   * has none. The fire path is an ordinary `wake`, so the deadline is enforced through the same
   * serialized `advanceLocked`/`enforceDeadline` a normal event would - it just guarantees the event
   * arrives even if no member ever produces one.
   */
  private armDeadline(state: RunState): void {
    const deadline = state.run.plan.budget.deadlineMs;
    this.clearDeadline(state.run.id);
    if (deadline === null) return;
    const remaining = state.run.createdAt + deadline - this.now();
    const runId = state.run.id;
    this.deadlineTimers.set(
      runId,
      this.armTimer(Math.max(0, remaining), () => {
        this.deadlineTimers.delete(runId);
        void this.wake(runId);
      }),
    );
  }

  private clearDeadline(runId: string): void {
    const cancel = this.deadlineTimers.get(runId);
    if (cancel) {
      cancel();
      this.deadlineTimers.delete(runId);
    }
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

  // ---- recovery actions (also reached through the manager's public action API) ----

  /**
   * Cancel a whole run: tear down every live member Task through its owner, mark those members
   * withdrawn, and reach `cancelled` - but never delete a restorable artifact ref. Submitted work
   * survives cancellation, exactly as a loser's snapshot survives a promotion.
   */
  async cancelRun(runId: string, reason: string | null): Promise<boolean> {
    return this.withRunLock(runId, async () => {
      const state = this.loadRaw(runId);
      if (!state) return false;
      if (state.run.status !== null) {
        if (ensembleIsTerminal(state.run.status)) return state.run.status === "cancelled";
        return this.cancelLocked(state, reason);
      }
      // A run whose status this build cannot read - a version skew, written by a newer build - is
      // still cancellable: its member Tasks are still linked and must not be orphaned. The two-phase
      // cancelling->cancelled path needs a readable status, so instead tear the Tasks down and force
      // the run terminal by exclusion of the terminal states. This honours the generic cancel
      // contract the README promises for version-skewed runs.
      const now = this.now();
      let settled = true;
      for (const member of state.members) {
        settled = (await this.tearDownMember(state, member, "withdrawn", now)) && settled;
      }
      if (!settled) {
        this.publish(runId);
        return false;
      }
      this.clearDeadline(runId);
      const cancelled = this.store.forceCancelRun(runId, reason, now);
      this.event(runId, "run_cancelled", { reason, unreadable: true }, `run_cancelled:${runId}`);
      this.publish(runId);
      return cancelled;
    });
  }

  private async cancelLocked(state: RawRunState, reason: string | null): Promise<boolean> {
    // Stop an in-flight comparison from starting its next parse attempt; its own `stillActive`
    // check would catch the cancel too, but aborting makes it prompt.
    this.reviewAborts.get(state.run.id)?.abort();
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
    this.interruptRunningReviews(
      state.run.id,
      reason ?? "the run was cancelled while this comparison was in flight",
      now,
      "cancelled",
    );
    this.clearDeadline(state.run.id);
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
      const reserved = this.store.reserveAttempt(
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
      // Dispatch the retry DIRECTLY, not through the wave's service loop: the member's original stage
      // may already have SUCCEEDED (its peers settled while this one failed), and `advanceLocked`
      // skips a succeeded member stage, so `launchReadyMembers` would never run and the reserved Task
      // would sit backlog forever. `reserveAttempt` already moved the member to `launching`; take the
      // attempt to `launching` and hand it to the owner, with the same rejection handling a wave launch has.
      this.store.setAttemptStatus(reserved.id, ["pending"], "launching", {}, now);
      void this.tasks
        .dispatch({ taskId, baseSha: input.baseSha, model: role.model, effort: role.effort })
        .catch((err) => this.onDispatchRejected(state.run.id, member.id, reserved.id, err instanceof Error ? err.message : String(err)));
      this.event(runId, "member_retried", { memberId, attempt: attemptNumber }, `member_retried:${member.id}:${attemptNumber}`);
      // Advance so the downstream barrier re-opens: the retried member is no longer settled, so a run
      // parked at review returns to waiting until it submits.
      await this.advanceLocked(runId);
      this.publish(runId);
      return true;
    });
  }

  /** Re-drive a review or finalize stage from durable state, if the run is still non-terminal. */
  async retryStage(runId: string, stageId: string): Promise<boolean> {
    return this.withRunLock(runId, async () => {
      const state = this.load(runId);
      if (!state || ensembleIsTerminal(state.run.status)) return false;
      const stage = state.run.plan.stages.find((s) => s.id === stageId);
      if (!stage) return false;
      // A failed MEMBER is retried per-member through `retryMember`, which appends a fresh attempt
      // with a new number; reopening a member STAGE would collide with those attempt numbers. A
      // decision stage waits on a PERSON and has nothing to re-run. A review stage under its attempt
      // cap and a parked finalize stage are both re-driven straight from their durable state: the
      // review re-runs its next attempt, the finalization resumes its steps. Every step is
      // idempotent, so re-driving can never duplicate an effect - the same property `recover` relies
      // on.
      if (stage.driverKind === "member" || stage.driverKind === "decision") return false;
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

  // ---- human decision ----

  /**
   * Record a human decision and move the run into `finalizing`.
   *
   * This is the ONE door destructive finalization enters through, and every guard is here rather
   * than at the caller: `awaiting_decision` + the caller's expected status, request-id idempotency,
   * a compiled decision driver, and the selection validated against the eligible artifact set. No
   * Git, Task, terminal, or Workflow effect happens before the decision, its succeeded decision
   * stage attempt, and the `finalizing` status are all durable - a crash between them resumes,
   * because the idempotent decision row is the fact that authorises everything downstream. A
   * duplicate request returns the same decision; a conflicting one (same id, different pick) is
   * refused, never adopted.
   */
  async decide(input: EnsembleDecideInput): Promise<EnsembleDecideOutcome> {
    return this.withRunLock(input.runId, async () => {
      const operationKey = `decide:${input.runId}:${input.requestId}`;
      const existing = this.store.decisionByOperationKey(operationKey);
      if (existing) {
        if (existing.runId !== input.runId || !ensembleJsonEqual(existing.selection.body, input.selection)) {
          return { ok: false, reason: "conflict", detail: "this decision request id already recorded a different selection", status: null };
        }
        const state = this.load(input.runId);
        if (state && existing.status !== "superseded") {
          const stage = this.decisionStage(state);
          const attempt = stage ? this.latestStageAttempt(state, stage.id) : null;
          if (state.run.status === "awaiting_decision" || attempt?.status !== "succeeded") {
            const applied = await this.applyDecisionTransition(state, existing);
            if (!applied.ok) return applied;
            this.publish(input.runId);
          }
        }
        return { ok: true, decision: existing, replayed: true };
      }
      const state = this.load(input.runId);
      if (!state) return { ok: false, reason: "no_run", detail: "no such runnable ensemble", status: null };
      if (state.run.status !== "awaiting_decision") {
        return { ok: false, reason: "wrong_state", detail: `run is ${state.run.status}, not awaiting a decision`, status: state.run.status };
      }
      if (input.expectedStatus !== state.run.status) {
        return { ok: false, reason: "wrong_state", detail: `expected ${input.expectedStatus} but run is ${state.run.status}`, status: state.run.status };
      }
      const prepared = this.prepareDecision(state, input.selection);
      if (!prepared.ok) return prepared;

      const now = this.now();
      const decision = this.store.recordDecision(
        {
          runId: input.runId,
          actor: "human",
          actorId: input.actorId,
          selection: ensemblePayload(input.selection),
          rationale: input.rationale,
          operationKey,
        },
        now,
      );
      const applied = await this.applyDecisionTransition(state, decision, prepared);
      if (!applied.ok) return applied;
      this.publish(input.runId);
      return { ok: true, decision, replayed: false };
    });
  }

  private decisionStage(
    state: RunState,
  ): Extract<EnsembleStageSpec, { driverKind: "decision" }> | null {
    const stage =
      state.run.plan.stages.find((candidate) => candidate.driverKind === "decision" && candidate.id === state.run.activeStageId) ??
      state.run.plan.stages.find((candidate) => candidate.driverKind === "decision");
    return stage?.driverKind === "decision" ? stage : null;
  }

  private prepareDecision(
    state: RunState,
    selection: EnsembleJson,
  ):
    | {
        ok: true;
        stage: Extract<EnsembleStageSpec, { driverKind: "decision" }>;
        validated: Extract<DecisionResult, { ok: true }>;
      }
    | Extract<EnsembleDecideOutcome, { ok: false }> {
    const stage = this.decisionStage(state);
    if (!stage) {
      return { ok: false, reason: "not_decision_stage", detail: "this run has no active decision stage", status: state.run.status };
    }
    const driver = decisionDriverFor(stage.driverKey);
    if (!driver) {
      return { ok: false, reason: "no_driver", detail: `no decision driver for ${stage.driverKey}`, status: state.run.status };
    }
    const eligible = this.eligibleDecisionArtifacts(state, stage.decision);
    const validated: DecisionResult = driver.validate(selection, {
      policy: stage.decision,
      eligibleArtifactIds: eligible.ids,
      memberForArtifact: (artifactId) => eligible.memberByArtifact.get(artifactId) ?? null,
      // The persisted question, not a re-derived one. A driver whose options came from an
      // evaluator validates the answer against what the operator was actually shown, so a review
      // retried since the run parked cannot turn a recorded answer into an answer to a question
      // nobody saw.
      stageInput: this.latestStageAttempt(state, stage.id)?.input ?? null,
    });
    return validated.ok
      ? { ok: true, stage, validated }
      : { ok: false, reason: validated.reason, detail: validated.detail, status: state.run.status };
  }

  private async applyDecisionTransition(
    state: RunState,
    decision: EnsembleDecision,
    prepared = this.prepareDecision(state, decision.selection.body),
  ): Promise<{ ok: true } | Extract<EnsembleDecideOutcome, { ok: false }>> {
    if (!prepared.ok) return prepared;
    const now = this.now();
    const decisionAttempt = this.latestStageAttempt(state, prepared.stage.id);
    if (decisionAttempt?.status !== "succeeded" && decisionAttempt) {
      this.store.finishStageAttempt(
        decisionAttempt.id,
        ["waiting", "running", "queued"],
        "succeeded",
        { output: { decisionId: decision.id, selection: decision.selection.body } as EnsembleJson },
        now,
      );
    }
    this.store.setRunStatus(
      state.run.id,
      ["awaiting_decision"],
      "finalizing",
      { outcome: prepared.validated.outcome, activeStageId: null },
      now,
    );
    this.event(
      state.run.id,
      "decision_recorded",
      { decisionId: decision.id, kind: prepared.validated.selectionKind },
      `decision_recorded:${decision.id}`,
    );
    await this.advanceLocked(state.run.id);
    return { ok: true };
  }

  /**
   * Resume a finalization parked on a remediable error - the `resolve_finalization` authority.
   *
   * A finalization that could not finish a destructive step (a missing ref, a busy winner session, a
   * Workflow note conflict) stays `finalizing` with an error, and this re-drives it from its durable
   * receipts. `skipWorkflowHandoff` abandons a blocked handoff and finishes with the normal
   * continuation instead - the only way a pinned handoff is ever given up, and always an explicit
   * operator act. Every step is idempotent, so re-driving cannot duplicate an effect.
   */
  async resolveFinalization(runId: string, skipWorkflowHandoff: boolean): Promise<{ ok: boolean; detail?: string }> {
    return this.withRunLock(runId, async () => {
      const state = this.load(runId);
      if (!state) return { ok: false, detail: "no such runnable ensemble" };
      if (state.run.status !== "finalizing") return { ok: false, detail: `run is ${state.run.status}, not finalizing` };
      if (skipWorkflowHandoff && state.run.workflowHandoff && state.run.workflowHandoff.state !== "submitted") {
        this.store.setWorkflowHandoff(
          runId,
          { ...state.run.workflowHandoff, state: "skipped", error: null },
          this.now(),
        );
        this.event(runId, "workflow_handoff_skipped", {}, `workflow_handoff_skipped:${runId}:${this.now()}`);
      }
      await this.advanceLocked(runId);
      this.publish(runId);
      const after = this.store.getRun(runId);
      return { ok: after?.status === "completed" || after?.status === "finalizing", detail: after?.error ?? undefined };
    });
  }

  /**
   * The newest succeeded evaluation on a run, or null.
   *
   * Read once, when a decision stage opens, so a driver whose question IS the evaluation's result
   * can compose it. Newest rather than first because a retried review supersedes its predecessor,
   * and the operator must be asked about the evidence that actually settled the stage.
   */
  private latestSucceededEvaluation(runId: string): { id: string; body: EnsembleJson } | null {
    let latest: { id: string; body: EnsembleJson } | null = null;
    for (const evaluation of this.store.listEvaluations(runId)) {
      if (evaluation.status === "succeeded" && evaluation.result) {
        latest = { id: evaluation.id, body: evaluation.result.body };
      }
    }
    return latest;
  }

  /** Ready artifacts of the decision's eligible kind, one per member, in stable ordinal order. */
  private eligibleDecisionArtifacts(
    state: RunState,
    policy: EnsembleDecisionPolicy,
  ): { ids: string[]; memberByArtifact: Map<string, string> } {
    const ids: string[] = [];
    const memberByArtifact = new Map<string, string>();
    for (const member of [...state.members].sort((a, b) => a.ordinal - b.ordinal)) {
      const artifact = this.readyArtifactOfKind(state, member, policy.eligibleArtifactKind);
      if (!artifact) continue;
      ids.push(artifact.id);
      memberByArtifact.set(artifact.id, member.id);
    }
    return { ids, memberByArtifact };
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
      if (state.run.status === "awaiting_decision") {
        const decision = this.store
          .listDecisions(runId)
          .find((candidate) => candidate.status === "recorded" || candidate.status === "applied");
        if (decision) {
          const applied = await this.applyDecisionTransition(state, decision);
          if (applied.ok) {
            this.event(runId, "run_recovered", {}, `run_recovered:${runId}:${now}`);
            this.publish(runId);
          }
          return;
        }
      }
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

      const evaluations = this.store.listEvaluations(runId);
      for (const stageAttempt of reconciledState.stageAttempts) {
        if (stageAttempt.driverKind !== "review" || stageAttempt.status !== "running") continue;
        const succeeded = evaluations.find(
          (evaluation) =>
            evaluation.stageAttemptId === stageAttempt.id &&
            evaluation.status === "succeeded",
        );
        if (!succeeded) continue;
        const driver = stageAttempt.driverKey ? reviewDriverFor(stageAttempt.driverKey) : null;
        const resultLabel =
          driver && succeeded.result
            ? driver.resultLabel({
                result: succeeded.result,
                subjectArtifactIds: succeeded.subjectArtifactIds,
              })
            : null;
        this.completeReviewStage(
          runId,
          stageAttempt.stageId,
          stageAttempt.id,
          succeeded.id,
          resultLabel,
          now,
        );
      }

      const interrupted = this.interruptRunningReviews(
        runId,
        "the daemon exited while this comparison was in flight",
        now,
        "failed",
      );
      for (const stageAttempt of interrupted) {
        this.event(runId, "review_interrupted", { stageId: stageAttempt.stageId }, `review_interrupted:${stageAttempt.id}:${now}`);
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

      if (await this.enforceDeadline(state)) {
        this.publish(runId);
        return;
      }
      // Arm (or re-arm) the wall-clock deadline before the run may go quiet waiting for events, so a
      // member that runs stably past its deadline still trips it. A terminal transition inside `step`
      // clears the timer; a waiting one leaves it armed for the next wake.
      this.armDeadline(state);

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
        await this.failRun(state.run.id, `stage ${stage.id} pairs ${stage.driverKind} with incompatible driver ${stage.driverKey}`);
        return "published";
      }
      const status = this.stageStatus(state, stage);
      if (status === "succeeded") continue;
      if (status === "failed") {
        await this.failRun(state.run.id, `stage ${stage.id} could not complete`);
        return "published";
      }
      if (status === "running") {
        // A running finalize stage is resumed from its persisted receipts; a running (`waiting`)
        // decision stage is parked on a person and makes no progress until `decide` finishes it.
        if (stage.driverKind === "finalize") {
          return await this.serviceFinalizeStage(state, stage as EnsembleStageSpec & { driverKind: "finalize" });
        }
        if (stage.driverKind === "decision") return "stopped";
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
        await this.failRun(
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
    await this.completeRun(state);
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
    if (stage.driverKind === "review") {
      // Dispatch by the compiled driver key, never by asking what strategy the run is. A build with
      // no review executor wired in - or a plan naming a review driver this build does not have -
      // parks at `evaluating` exactly as before, rather than best-efforting past a stage it cannot run.
      const driver = this.review ? reviewDriverFor(stage.driverKey) : null;
      if (this.review && driver) {
        this.startReviewStage(state, stage, driver);
        return "published";
      }
      this.setRunStatus(state.run.id, "evaluating", { activeStageId: stage.id });
      return "published";
    }
    if (stage.driverKind === "decision") {
      // Park on a PERSON, durably. A `waiting` stage attempt is created so the decision stage has
      // a row `decide` can finish `succeeded` (which is what unblocks the finalize stage's
      // dependency), and so a restart finds the run parked here rather than re-entering the review.
      //
      // The INPUT is composed by the compiled decision driver rather than written here, which is
      // what lets a decision stage ask a question an evaluator derived (a consensus run's
      // divergences) instead of a strategy-static one - with no engine branch on either. It is
      // written once: `startStageAttempt` is idempotent on its command key and returns the existing
      // row, so a re-entry after a restart re-renders nothing and the operator keeps being asked
      // exactly what was persisted the first time.
      const driver = decisionDriverFor(stage.driverKey);
      const input = driver
        ? driver.openStage({
            policy: stage.decision,
            eligibleArtifactIds: this.eligibleDecisionArtifacts(state, stage.decision).ids,
            evaluation: this.latestSucceededEvaluation(state.run.id),
          })
        : ({ command: "await_human_decision" } as EnsembleJson);
      this.store.startStageAttempt(
        {
          runId: state.run.id,
          stageId: stage.id,
          driverKind: "decision",
          driverKey: stage.driverKey,
          attempt: 1,
          commandKey: `decision:${state.run.id}:${stage.id}:1`,
          status: "waiting",
          input,
        },
        this.now(),
      );
      this.setRunStatus(state.run.id, "awaiting_decision", { activeStageId: stage.id });
      this.event(state.run.id, "awaiting_decision", { stageId: stage.id }, `awaiting_decision:${state.run.id}:${stage.id}`);
      return "published";
    }
    // finalize: start (or resume) the destructive select-one finalization. `serviceFinalizeStage`
    // is idempotent from its persisted receipts, so a crash mid-finalization resumes rather than
    // repeats. A build with no finalize executor wired in parks at `finalizing` unchanged.
    return await this.serviceFinalizeStage(state, stage as EnsembleStageSpec & { driverKind: "finalize" });
  }

  // ---- review execution (comparative_review@1) ----

  /**
   * Start one review stage attempt and kick its async execution.
   *
   * The stage attempt and the `evaluating` status are persisted synchronously under the run lock,
   * so a restart mid-review finds the running row rather than launching a second comparison. The
   * comparison itself runs OUTSIDE the lock (a 120s model call must not hold a run's other actions),
   * re-acquiring it only to persist the result. A fresh attempt number is used on every retry, so a
   * failed comparison re-runs against the same immutable evidence rather than rewriting a plan.
   */
  private startReviewStage(
    state: RunState,
    stage: EnsembleStageSpec & { driverKind: "review" },
    driver: ReviewDriver,
  ): void {
    const now = this.now();
    const attemptNumber = (this.latestStageAttempt(state, stage.id)?.attempt ?? 0) + 1;
    if (attemptNumber > stage.maxAttempts) {
      void this.failRun(state.run.id, `review stage ${stage.id} exhausted its ${stage.maxAttempts} attempts`);
      return;
    }
    const stageAttempt = this.store.startStageAttempt(
      {
        runId: state.run.id,
        stageId: stage.id,
        driverKind: "review",
        driverKey: stage.driverKey,
        attempt: attemptNumber,
        commandKey: `review:${state.run.id}:${stage.id}:${attemptNumber}`,
        status: "running",
        // The compiled driver key, not a literal naming one evaluator: this row is the receipt of
        // which review a restart finds running, and a consensus pass recorded as a comparison
        // would be a receipt for something that never happened.
        input: { command: "review", driverKey: stage.driverKey, attempt: attemptNumber } as EnsembleJson,
      },
      now,
    );
    this.setRunStatus(state.run.id, "evaluating", { activeStageId: stage.id });
    this.event(state.run.id, "review_started", { stageId: stage.id, attempt: attemptNumber }, `review_started:${stageAttempt.id}`);
    const abort = new AbortController();
    this.reviewAborts.get(state.run.id)?.abort();
    this.reviewAborts.set(state.run.id, abort);
    void this.executeReview(state.run.id, stage.id, stageAttempt.id, driver, abort.signal).catch((err) =>
      void this.onReviewCrashed(state.run.id, stage.id, stageAttempt.id, err instanceof Error ? err.message : String(err)),
    );
  }

  private async executeReview(
    runId: string,
    stageId: string,
    stageAttemptId: string,
    driver: ReviewDriver,
    signal: AbortSignal,
  ): Promise<void> {
    const prepared = await this.withRunLock(runId, async () => this.prepareReview(runId, stageId, stageAttemptId));
    if (prepared.kind === "abandon") return;
    if (prepared.kind === "insufficient") {
      await this.withRunLock(runId, async () => {
        this.reviewAborts.delete(runId);
        this.store.finishStageAttempt(
          stageAttemptId,
          ["running"],
          "failed",
          { error: `only ${prepared.count} eligible artifact(s) remain; a comparison needs at least ${prepared.min}` },
          this.now(),
        );
        this.event(runId, "review_failed", { stageId, kind: "insufficient", count: prepared.count }, `review_failed:${stageAttemptId}:insufficient`);
        await this.advanceLocked(runId);
        this.publish(runId);
      });
      return;
    }
    const context = {
      runId,
      stageId,
      stageAttemptId,
      intent: prepared.intent,
      baseSha: prepared.baseSha,
      repoRoot: prepared.repoRoot,
      guidance: prepared.guidance,
      policy: prepared.policy,
      subjects: prepared.subjects,
      runtime: this.reviewRuntime(),
      persist: this.reviewPersist(runId, stageAttemptId, prepared.policy.kind, driver.llmPurpose),
      signal,
      stillActive: () => this.reviewStillActive(runId, stageAttemptId),
    };
    let outcome: ReviewOutcome;
    try {
      outcome = await driver.run(context);
    } catch (err) {
      outcome = {
        ok: false,
        kind: "infrastructure",
        detail: err instanceof Error ? err.message : String(err),
        evaluationId: null,
        execution: null,
      };
    }
    // The provider ledger is written outside the run lock through single-row transactions. Only
    // the final result and status transition are persisted under the lock; terminal transitions
    // reconcile the ledger, and the active-run precondition below rejects a late outcome.
    await this.withRunLock(runId, () => this.applyReviewOutcome(runId, stageId, stageAttemptId, outcome));
  }

  /** Gather one review's immutable inputs, or say why it cannot run. Under the run lock. */
  private prepareReview(
    runId: string,
    stageId: string,
    stageAttemptId: string,
  ):
    | {
        kind: "run";
        intent: string;
        baseSha: string;
        repoRoot: string;
        guidance: EnsembleEvaluatorGuidance;
        policy: EnsembleEvaluatorPolicy;
        subjects: ReviewSubject[];
      }
    | { kind: "abandon" }
    | { kind: "insufficient"; count: number; min: number } {
    const state = this.load(runId);
    if (!state || state.run.status !== "evaluating" || state.run.baseSha === null) return { kind: "abandon" };
    const stage = state.run.plan.stages.find((s) => s.id === stageId);
    if (!stage || stage.driverKind !== "review") return { kind: "abandon" };
    const attempt = state.stageAttempts.find((a) => a.id === stageAttemptId);
    if (!attempt || attempt.status !== "running") return { kind: "abandon" };
    const subjects = this.reviewSubjects(state, stage);
    if (subjects.length < stage.subjects.minSubjects) {
      return { kind: "insufficient", count: subjects.length, min: stage.subjects.minSubjects };
    }
    return {
      kind: "run",
      intent: state.run.intent,
      baseSha: state.run.baseSha,
      repoRoot: state.run.repoRoot,
      guidance: stage.evaluator.guidance,
      policy: stage.evaluator,
      subjects,
    };
  }

  /** The ready artifacts a review judges - the declared kind, from the barrier's settled members. */
  private reviewSubjects(state: RunState, stage: EnsembleStageSpec & { driverKind: "review" }): ReviewSubject[] {
    const roleKeys =
      stage.barrier.kind === "members_settled" ? stage.barrier.roleKeys : state.run.plan.roles.map((r) => r.key);
    const kind = stage.subjects.artifactKind;
    const subjects: ReviewSubject[] = [];
    for (const member of this.membersForRoles(state, roleKeys)) {
      const artifact = this.readyArtifactOfKind(state, member, kind);
      if (!artifact) continue;
      subjects.push({
        artifactId: artifact.id,
        kind,
        locator: artifact.locator,
        observed: readMetadataSection(artifact.metadata, "observed"),
        reported: readMetadataSection(artifact.metadata, "reported"),
      });
    }
    return subjects.slice(0, stage.subjects.maxSubjects);
  }

  private readyArtifactOfKind(state: RunState, member: EnsembleMember, kind: string): EnsembleArtifact | null {
    const attemptIds = new Set(state.attempts.filter((a) => a.memberId === member.id).map((a) => a.id));
    return (
      state.artifacts.find(
        (a) => a.status === "ready" && a.kind === kind && a.attemptId !== null && attemptIds.has(a.attemptId),
      ) ?? null
    );
  }

  /** Build the review runtime from the injected deps plus this engine's adapters and clock. */
  private reviewRuntime(): ReviewRuntime {
    const review = this.review!;
    return {
      scheduler: review.scheduler,
      resolveExecution: review.resolveExecution,
      runModel: review.runModel,
      materialize: async (subject, repoRoot, maxPatchBytes) => {
        const adapter = this.adapterFor(subject.kind);
        if (!adapter) throw new Error(`no adapter for ${subject.kind} artifacts`);
        return adapter.materialize(subject.locator, { repoPath: repoRoot, maxPatchBytes });
      },
      now: this.now,
      timeoutMs: review.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS,
    };
  }

  /**
   * The durable ledger the driver writes through, bound to this run and stage attempt.
   *
   * `method` is the compiled PLAN's evaluator kind - what this run was created to do - while
   * `purpose` is the DRIVER's, because a cost row is about the call this build actually made. Both
   * are passed in rather than named here: an engine holding its own table of which evaluator uses
   * which method is the table that files a new evaluator's calls under the old one's name.
   */
  private reviewPersist(
    runId: string,
    stageAttemptId: string,
    method: EnsembleEvaluatorKind,
    purpose: EnsembleLlmPurpose,
  ): ReviewPersist {
    return {
      beginEvaluation: (input) =>
        this.store.recordEvaluation(
          {
            runId,
            stageAttemptId,
            attempt: 1,
            method,
            runnerId: input.runnerId,
            modelId: input.modelId,
            inputFingerprint: input.inputFingerprint,
            subjectArtifactIds: input.subjectArtifactIds,
            status: "running",
          },
          this.now(),
        ).id,
      startCall: (input) =>
        this.store.startLlmCall({
          runId,
          stageAttemptId,
          evaluationId: input.evaluationId,
          purpose,
          runnerId: input.runnerId,
          modelId: input.modelId,
          attempt: input.attempt,
          operationKey: `review_call:${input.evaluationId}:${input.attempt}`,
          state: "running",
          startedAt: input.startedAt,
        }).id,
      finishCall: (callId, input) => {
        this.store.finishLlmCall(callId, ["running"], input.state, {
          finishedAt: input.finishedAt,
          durationMs: input.durationMs,
          inputBytes: input.inputBytes,
          outputBytes: input.outputBytes,
          costUsd: input.costUsd,
          errorCode: input.errorCode,
        });
      },
    };
  }

  /** Whether an in-flight review may still proceed - re-read from durable state on every attempt. */
  private reviewStillActive(runId: string, stageAttemptId: string): boolean {
    const run = this.store.getRun(runId);
    if (!run || run.status !== "evaluating") return false;
    const attempt = this.store.listStageAttempts(runId).find((a) => a.id === stageAttemptId);
    return attempt?.status === "running";
  }

  private async applyReviewOutcome(
    runId: string,
    stageId: string,
    stageAttemptId: string,
    outcome: ReviewOutcome,
  ): Promise<void> {
    this.reviewAborts.delete(runId);
    const now = this.now();
    const run = this.store.getRun(runId);
    const stageAttempt = this.store.listStageAttempts(runId).find((attempt) => attempt.id === stageAttemptId);
    if (
      run?.status !== "evaluating" ||
      stageAttempt?.status !== "running" ||
      stageAttempt.stageId !== stageId ||
      stageAttempt.driverKind !== "review"
    ) {
      if (outcome.evaluationId) {
        this.store.finishEvaluation(
          outcome.evaluationId,
          ["running"],
          "interrupted",
          { error: "the review outcome arrived after its run or stage attempt stopped" },
          now,
        );
      }
      return;
    }
    if (outcome.ok) {
      if (outcome.evaluationId) {
        this.store.finishEvaluation(
          outcome.evaluationId,
          ["running"],
          "succeeded",
          { runnerId: outcome.execution.runnerId, modelId: outcome.execution.modelId, result: outcome.result },
          now,
        );
      }
      if (outcome.execution.unknownRunner) {
        // The unknown-runner fallback is made visible rather than swallowed, consistent with LLM status.
        this.event(
          runId,
          "review_runner_unknown",
          { dropped: outcome.execution.unknownRunner, using: outcome.execution.runnerId },
          `review_runner_unknown:${stageAttemptId}`,
        );
      }
      this.completeReviewStage(
        runId,
        stageId,
        stageAttemptId,
        outcome.evaluationId,
        outcome.resultLabel,
        now,
      );
      await this.advanceLocked(runId);
      this.publish(runId);
      return;
    }
    // A failure. `interrupted` is retryable against the same immutable evidence; a malformed or
    // infrastructure failure is too, bounded by the compiled attempt cap, and neither ever becomes
    // a recommendation. The generic retry logic runs from the failed stage attempt.
    const evalState = outcome.kind === "interrupted" ? "interrupted" : "failed";
    if (outcome.evaluationId) {
      this.store.finishEvaluation(
        outcome.evaluationId,
        ["running"],
        evalState,
        {
          ...(outcome.execution ? { runnerId: outcome.execution.runnerId, modelId: outcome.execution.modelId } : {}),
          error: outcome.detail,
        },
        now,
      );
    }
    this.store.finishStageAttempt(stageAttemptId, ["running"], "failed", { error: `${outcome.kind}: ${outcome.detail}` }, now);
    this.event(runId, "review_failed", { stageId, kind: outcome.kind, detail: outcome.detail }, `review_failed:${stageAttemptId}`);
    await this.advanceLocked(runId);
    this.publish(runId);
  }

  private async onReviewCrashed(runId: string, stageId: string, stageAttemptId: string, detail: string): Promise<void> {
    await this.withRunLock(runId, async () => {
      this.reviewAborts.delete(runId);
      const now = this.now();
      this.store.finishStageAttempt(stageAttemptId, ["running"], "failed", { error: `review crashed: ${detail}` }, now);
      this.event(runId, "review_failed", { stageId, kind: "crashed", detail }, `review_failed:${stageAttemptId}:crash`);
      await this.advanceLocked(runId);
      this.publish(runId);
    });
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
      await this.failRun(run.id, `stage ${stage.id} is wave ${stage.wave}, past the plan's ${run.plan.budget.maxWaves}-wave cap`);
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
        await this.failRun(state.run.id, "a member launch would exceed the plan's hard member cap");
        return;
      }
      const role = state.run.plan.roles.find((r) => r.key === member.roleKey);
      this.store.setAttemptStatus(attempt.id, ["pending"], "launching", {}, this.now());
      const memberId = member.id;
      const attemptId = attempt.id;
      // Fire-and-forget so the launch loop is not blocked, but with a rejection handler: if the
      // dispatch itself is refused or throws, the member would otherwise sit `launching` with a Task
      // that never goes live, and no durable Task change would wake the run - the wave would stall
      // until a restart. The launch's own failures are still handled by the Dispatcher marking the
      // Task failed (which the reconcile then folds in); this covers the dispatch call rejecting.
      void this.tasks
        .dispatch({
          taskId: attempt.taskId!,
          baseSha: attempt.baseSha!,
          model: role?.model ?? null,
          effort: role?.effort ?? null,
        })
        .catch((err) => this.onDispatchRejected(state.run.id, memberId, attemptId, err instanceof Error ? err.message : String(err)));
      this.event(state.run.id, "member_launched", { memberId: member.id }, `member_launched:${attempt.id}`);
      occupied += 1;
    }
  }

  /**
   * A member's dispatch call rejected. Fail the attempt and the member under the run lock, then wake
   * so the compiled barrier can decide whether the stage can still proceed - the same as any other
   * member failure, just reached through the launch path instead of an observed Task death.
   */
  private async onDispatchRejected(runId: string, memberId: string, attemptId: string, detail: string): Promise<void> {
    await this.withRunLock(runId, async () => {
      const now = this.now();
      this.store.setAttemptStatus(attemptId, ["pending", "launching"], "failed", { error: detail, finishedAt: now }, now);
      this.store.setMemberStatus(memberId, ["pending", "launching"], "failed", { error: detail }, now);
      this.event(runId, "member_dispatch_failed", { memberId, detail }, `member_dispatch_failed:${attemptId}`);
    });
    await this.wake(runId);
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
    if (await this.enforceDeadline(state)) {
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
          // The member agent's cost, summed from its session telemetry at THIS instant and
          // frozen into the immutable artifact - not re-read later, when the session may be gone.
          // Null when the runner reported none; the reader below preserves that as unknown.
          agentCostUsd: attempt.taskId ? this.tasks.sessionCostUsd(attempt.taskId) : null,
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

  private async completeRun(state: RunState): Promise<void> {
    const readyArtifacts = state.artifacts.filter((a) => a.status === "ready");
    if (readyArtifacts.length === 0) {
      await this.failRun(state.run.id, "every member settled without producing an artifact");
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
      // Stop the retained member's agent if it is still live, keeping its worktree's work in the
      // immutable ref: a completed run must not leave agents running that `cancelRun` then refuses.
      await this.settleMemberTask(member, now);
    }
    this.clearDeadline(state.run.id);
    this.store.setRunStatus(
      state.run.id,
      ["running", "waiting", "evaluating"],
      "completed",
      { outcome: { kind: "retained", memberIds, artifactIds }, completedAt: now, activeStageId: null },
      now,
    );
    this.event(state.run.id, "run_completed", { outcome: "retained", members: memberIds.length }, `run_completed:${state.run.id}`);
  }

  // ---- finalization (select_one_finalize@1) ----

  /**
   * Drive one finalize stage as far as it can go, idempotently, from its persisted receipts.
   *
   * The engine performs every destructive step itself, in the order the recovery contract requires:
   * verify the winner ref, make one exact winner available, reap losers through TaskManager, then
   * hand off to a Workflow or deliver a continuation, then complete. A step that cannot finish
   * (a missing ref, a busy session, a Workflow conflict) leaves the run `finalizing` with an
   * actionable error and returns; a later wake, `resolve_finalization`, or restart re-drives from
   * the same receipts. Every step is safe to repeat, so re-driving never doubles an effect - which
   * is what makes "interrupt at any point and resume" true rather than hoped for.
   */
  private async serviceFinalizeStage(
    state: RunState,
    stage: EnsembleStageSpec & { driverKind: "finalize" },
  ): Promise<"published"> {
    const run = state.run;
    if (!this.finalize) {
      // No executor wired in: park at `finalizing` exactly as the launch/review-only phases did.
      this.setRunStatus(run.id, "finalizing", { activeStageId: stage.id });
      return "published";
    }
    const now = this.now();
    let stageAttempt = this.latestStageAttempt(state, stage.id);
    if (!stageAttempt || stageAttempt.driverKind !== "finalize") {
      stageAttempt = this.store.startStageAttempt(
        {
          runId: run.id,
          stageId: stage.id,
          driverKind: "finalize",
          driverKey: stage.driverKey,
          attempt: 1,
          commandKey: `finalize:${run.id}:${stage.id}:1`,
          status: "running",
          input: { command: "finalize" } as EnsembleJson,
        },
        now,
      );
      this.event(run.id, "finalization_started", { stageId: stage.id }, `finalization_started:${stageAttempt.id}`);
    }
    if (stageAttempt.status === "succeeded") return "published";
    this.setRunStatus(run.id, "finalizing", { activeStageId: stage.id });

    const progress = this.readFinalizationProgress(stageAttempt);
    const finalizer = finalizerFor(stage.driverKey);
    if (!finalizer) return this.parkFinalize(run.id, stageAttempt.id, progress, `no finalizer for ${stage.driverKey}`);
    if (run.outcome === null) return this.parkFinalize(run.id, stageAttempt.id, progress, "finalization has no decided outcome");
    const planned = finalizer.plan({
      outcome: run.outcome,
      finalization: stage.finalization,
      members: state.members,
      artifacts: state.artifacts,
      attempts: state.attempts,
    });
    if (!planned.ok) return this.parkFinalize(run.id, stageAttempt.id, progress, planned.detail);
    if (planned.plan.kind === "no_consensus") {
      return this.completeRetainingAll(
        state,
        stageAttempt,
        { kind: "no_consensus", artifactIds: planned.plan.artifactIds, reason: planned.plan.reason },
        now,
      );
    }
    if (planned.plan.kind === "retained") {
      return this.completeRetainingAll(
        state,
        stageAttempt,
        { kind: "retained", memberIds: planned.plan.memberIds, artifactIds: planned.plan.artifactIds },
        now,
      );
    }
    return this.finalizeSelectOne(state, stage, stageAttempt, planned.plan);
  }

  private async finalizeSelectOne(
    state: RunState,
    stage: EnsembleStageSpec & { driverKind: "finalize" },
    stageAttempt: EnsembleStageAttempt,
    plan: Extract<FinalizePlan, { kind: "select_one" }>,
  ): Promise<"published"> {
    const deps = this.finalize!;
    const run = state.run;
    let progress = this.readFinalizationProgress(stageAttempt);
    const winnerMember = state.members.find((m) => m.id === plan.winnerMemberId);
    const winnerArtifact = state.artifacts.find((a) => a.id === plan.winnerArtifactId);
    const snapshotSha = winnerArtifact ? this.snapshotSha(winnerArtifact) : null;
    const ref = winnerArtifact ? refFromLocator(winnerArtifact.locator) : null;
    if (!winnerMember || !winnerArtifact || snapshotSha === null || ref === null) {
      return this.parkFinalize(run.id, stageAttempt.id, progress, "the selected winner artifact is incomplete");
    }

    // STEP verifying: the winner ref must still resolve to its snapshot. No cleanup happens if it
    // does not - a missing ref is a restore/ref remediation, and reaping losers around a winner
    // that is gone is exactly the loss the ordering rules out.
    let verified: string | null;
    try {
      verified = await deps.verifyArtifact({
        locator: winnerArtifact.locator,
        repoPath: run.repoRoot,
      });
    } catch (err) {
      return this.parkFinalize(
        run.id,
        stageAttempt.id,
        { ...progress, step: "verifying", verifiedSnapshotSha: null },
        `the selected artifact could not be verified; retry after the repository is available: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (verified === null) {
      return this.parkFinalize(
        run.id,
        stageAttempt.id,
        { ...progress, step: "verifying", verifiedSnapshotSha: null },
        "the selected artifact's private ref no longer resolves to its snapshot; restore or retry before any cleanup",
      );
    }
    if (verified !== snapshotSha) {
      return this.parkFinalize(
        run.id,
        stageAttempt.id,
        { ...progress, step: "verifying", verifiedSnapshotSha: null },
        `the selected artifact's private ref resolves to ${verified}, not its recorded snapshot ${snapshotSha}`,
      );
    }
    progress = { ...progress, step: "materializing", verifiedSnapshotSha: snapshotSha, error: null };
    this.store.setFinalizationProgress(stageAttempt.id, progress, this.now());

    // STEP materializing: make exactly one exact winner available.
    const ready = await this.ensureWinnerReady(
      state,
      winnerMember,
      winnerArtifact,
      snapshotSha,
      ref,
      progress,
      stageAttempt.id,
    );
    if (!ready.ok) {
      return this.parkFinalize(
        run.id,
        stageAttempt.id,
        {
          ...progress,
          winner: ready.winner,
          continuationInIntent: ready.continuationInIntent ?? progress.continuationInIntent,
        },
        ready.detail,
      );
    }
    progress = {
      ...progress,
      step: "reaping_losers",
      winner: ready.winner,
      continuationInIntent: ready.continuationInIntent,
      error: null,
    };
    this.store.setFinalizationProgress(stageAttempt.id, progress, this.now());

    // STEP reaping losers: through TaskManager, then eliminate only once resources agree.
    const reaped = await this.reapLosers(state, plan.loserMemberIds);
    if (!reaped.ok) return this.parkFinalize(run.id, stageAttempt.id, progress, reaped.detail ?? "a loser could not be reaped");
    progress = { ...progress, losersReaped: true, step: "handoff", error: null };
    this.store.setFinalizationProgress(stageAttempt.id, progress, this.now());

    // STEP handoff / continuation: exactly one of the two, never both.
    const handoff = run.workflowHandoff;
    const handoffActive = handoff !== null && handoff.state !== "skipped";
    if (handoffActive && handoff!.state !== "submitted") {
      const result = await this.runWorkflowHandoff(run, handoff!, ready.sessionId, snapshotSha, ref, plan.winnerArtifactId);
      if (!result.ok) return this.parkFinalize(run.id, stageAttempt.id, progress, result.detail ?? "the workflow handoff is blocked");
    } else if (!handoffActive) {
      const delivered = await this.deliverWinnerContinuation(
        state,
        winnerMember,
        winnerArtifact,
        ready,
        progress,
        stageAttempt.id,
      );
      if (!delivered.ok) {
        return this.parkFinalize(
          run.id,
          stageAttempt.id,
          delivered.progress,
          delivered.detail ?? "the continuation could not be delivered",
        );
      }
      progress = delivered.progress;
      this.store.setFinalizationProgress(stageAttempt.id, progress, this.now());
    }

    return this.completeSelectOne(state, stageAttempt, plan, progress);
  }

  /**
   * Make one exact winner available: prefer the original member session, else one replacement Task.
   *
   * A replacement is chosen ONCE and never unchosen - its id is durable in the outcome before it is
   * dispatched, and any prior mode receipt keeps this on the same path, so a lost response or a
   * restart reconciles to that Task rather than restoring the original or launching a second.
   */
  private async ensureWinnerReady(
    state: RunState,
    winnerMember: EnsembleMember,
    winnerArtifact: EnsembleArtifact,
    snapshotSha: string,
    ref: string,
    progress: EnsembleFinalizationProgress,
    stageAttemptId: string,
  ): Promise<
    | {
        ok: true;
        winner: { mode: "restored" | "replacement"; ready: true };
        sessionId: string | null;
        worktreePath: string | null;
        mode: "restored" | "replacement";
        continuationInIntent: boolean;
      }
    | {
        ok: false;
        winner: { mode: "restored" | "replacement"; ready: false };
        detail: string;
        continuationInIntent?: boolean;
      }
  > {
    const deps = this.finalize!;
    const run = state.run;
    const now = this.now();
    const winnerAttempt = winnerArtifact.attemptId
      ? state.attempts.find((a) => a.id === winnerArtifact.attemptId) ?? null
      : null;
    if (progress.winner?.mode === "restored" && progress.winner.ready === true) {
      const taskId = winnerAttempt?.taskId ?? null;
      const sessionId = taskId ? this.tasks.sessionId(taskId) : null;
      const worktreePath = winnerAttempt ? this.ownedWorktree(winnerAttempt) : null;
      const handoffBound =
        run.workflowHandoff !== null &&
        run.workflowHandoff.bindingId !== null &&
        run.workflowHandoff.state !== "skipped";
      // Once the winner has been handed its continuation or bound to a Workflow it may be WORKING,
      // and re-touching its checkout would erase that work - so honor the receipt as-is. This is the
      // post-delivery window.
      if (progress.continuationDelivered || handoffBound) {
        return {
          ok: true,
          winner: { mode: "restored", ready: true },
          sessionId,
          worktreePath,
          mode: "restored",
          continuationInIntent: false,
        };
      }
      // Pre-delivery: the winner should still stand exactly on its snapshot, but a parked step (a
      // loser cancel that failed) can leave the run finalizing long enough for the checkout to drift.
      // Re-verify HEAD/cleanliness and restore again if needed BEFORE resuming past the receipt, so a
      // no-handoff run can never reap the rest and complete around a winner that no longer matches.
      if (sessionId !== null && worktreePath !== null) {
        let head = await deps.worktreeHead({ worktreePath });
        if (head.headSha !== snapshotSha || !head.clean) {
          const restored = await deps.restoreWinner({ sessionId, snapshotSha, ref });
          if (!restored.ok) {
            return { ok: false, winner: { mode: "restored", ready: false }, detail: `restoring the drifted winner failed: ${restored.detail}` };
          }
          head = await deps.worktreeHead({ worktreePath });
          if (head.headSha !== snapshotSha || !head.clean) {
            return { ok: false, winner: { mode: "restored", ready: false }, detail: "the winner's checkout did not settle back on its snapshot; retry" };
          }
        }
        return {
          ok: true,
          winner: { mode: "restored", ready: true },
          sessionId,
          worktreePath,
          mode: "restored",
          continuationInIntent: false,
        };
      }
      // The restored session is gone before any delivery: fall through to materialize one replacement.
    }
    const outcome = run.outcome;
    const materializedTaskId = outcome && outcome.kind === "selected" ? outcome.materializedTaskId : null;
    const onReplacementPath = materializedTaskId !== null || progress.winner?.mode === "replacement";

    if (!onReplacementPath && winnerAttempt && winnerAttempt.taskId) {
      const taskId = winnerAttempt.taskId;
      const taskStatus = this.tasks.status(taskId);
      const sessionId = this.tasks.sessionId(taskId);
      const worktree = this.ownedWorktree(winnerAttempt);
      const canRebind =
        taskStatus === "running" && sessionId !== null && worktree !== null && (await deps.sessionSafeToRebind(sessionId));
      if (canRebind) {
        const restored = await deps.restoreWinner({ sessionId: sessionId!, snapshotSha, ref });
        if (!restored.ok) {
          return { ok: false, winner: { mode: "restored", ready: false }, detail: `restoring the winner failed: ${restored.detail}` };
        }
        const head = await deps.worktreeHead({ worktreePath: worktree! });
        if (head.headSha !== snapshotSha || !head.clean) {
          return { ok: false, winner: { mode: "restored", ready: false }, detail: "the winner's checkout did not settle exactly on its snapshot; retry" };
        }
        this.markWinnerRetained(winnerMember, now);
        this.event(run.id, "winner_restored", { memberId: winnerMember.id }, `winner_restored:${run.id}:${winnerMember.id}`);
        return {
          ok: true,
          winner: { mode: "restored", ready: true },
          sessionId,
          worktreePath: worktree,
          mode: "restored",
          continuationInIntent: false,
        };
      }
    }

    // Replacement path: exactly one normal Task at the snapshot, deterministic id, id persisted first.
    const replacementTaskId = materializedTaskId ?? deterministicUuid(`${run.id}:${winnerArtifact.id}`);
    this.markWinnerRetained(winnerMember, now);
    const inIntent = progress.continuationInIntent || run.workflowHandoff === null;
    // A replacement already materialized (a resume) is REUSED, never re-created - the winner is one
    // exact result across a restart, not two. But it is only a READY winner once it is actually
    // usable: `running`, with its provisioned session AND worktree. A `dispatching` replacement has
    // dispatched but has no live session yet and can still fail; completing around it would leave a
    // done run pointing at no usable winner. So park until the async dispatch produces a running
    // session - the finalizing-run wake resumes this from that task's update.
    const already = deps.replacementStatus(replacementTaskId);
    if (already.status !== null) {
      if (replacementUsable(already)) {
        return {
          ok: true,
          winner: { mode: "replacement", ready: true },
          sessionId: already.sessionId,
          worktreePath: already.worktreePath,
          mode: "replacement",
          continuationInIntent: inIntent,
        };
      }
      if (already.status !== "backlog") {
        // Dispatching (coming up) or terminal (a dispatch that failed): do not complete around it.
        // A backlog replacement instead falls through to be (re-)dispatched below.
        return {
          ok: false,
          winner: { mode: "replacement", ready: false },
          detail: `the replacement winner is ${already.status} without a live session; finalization will resume when it is running`,
          continuationInIntent: inIntent,
        };
      }
    }
    if (materializedTaskId === null && outcome && outcome.kind === "selected") {
      this.store.setRunStatus(run.id, ["finalizing"], "finalizing", { outcome: { ...outcome, materializedTaskId: replacementTaskId } }, now);
    }
    const role = run.plan.roles.find((r) => r.key === winnerMember.roleKey);
    const handoffActive = run.workflowHandoff !== null && run.workflowHandoff.state !== "skipped";
    const intent = handoffActive
      ? this.buildReplacementHandoffIntent(run, winnerArtifact)
      : this.buildContinuation(state, winnerMember, winnerArtifact);
    const continuationInIntent = !handoffActive;
    this.store.setFinalizationProgress(
      stageAttemptId,
      {
        ...progress,
        winner: { mode: "replacement", ready: false },
        continuationInIntent,
      },
      now,
    );
    const materialize = await deps.materializeReplacement({
      taskId: replacementTaskId,
      runId: run.id,
      repoRoot: run.repoRoot,
      title: `${run.title} - selected result`,
      intent,
      agent: winnerAttempt?.agent ?? role?.agent ?? AGENT_TYPES[0],
      model: winnerAttempt?.requestedModel ?? role?.model ?? null,
      effort: winnerAttempt?.requestedEffort ?? role?.effort ?? null,
      snapshotSha,
    });
    if (!materialize.ok) {
      return {
        ok: false,
        winner: { mode: "replacement", ready: false },
        detail: `materializing the winner failed: ${materialize.detail}`,
        continuationInIntent,
      };
    }
    this.event(run.id, "winner_materialized", { taskId: replacementTaskId }, `winner_materialized:${run.id}:${replacementTaskId}`);
    // Dispatch is asynchronous: right after materialization the replacement is usually still
    // `dispatching` (provisioning its worktree, no session yet). It is a ready winner only once it
    // is `running` with a live session and worktree; until then park and resume from its task update
    // - so a dispatch that later fails cannot leave the run completed around a winner that never came up.
    const status = deps.replacementStatus(replacementTaskId);
    if (!replacementUsable(status)) {
      return {
        ok: false,
        winner: { mode: "replacement", ready: false },
        detail: `the replacement winner is ${status.status ?? "missing"} without a live session; finalization will resume when it is running`,
        continuationInIntent,
      };
    }
    return {
      ok: true,
      winner: { mode: "replacement", ready: true },
      sessionId: status.sessionId,
      worktreePath: status.worktreePath,
      mode: "replacement",
      continuationInIntent,
    };
  }

  private markWinnerRetained(member: EnsembleMember, now: number): void {
    this.store.setMemberStatus(
      member.id,
      ["submitted", "reviewing", "advanced", "retained"],
      "retained",
      { resultLabel: "selected" },
      now,
    );
  }

  /** Cancel every loser Task through TaskManager, eliminating each only once its resources agree. */
  private async reapLosers(state: RunState, loserMemberIds: string[]): Promise<{ ok: boolean; detail?: string }> {
    const now = this.now();
    let allSettled = true;
    for (const memberId of loserMemberIds) {
      const member = state.members.find((m) => m.id === memberId);
      if (!member) continue;
      // A member that already failed/withdrew keeps its artifact and needs no cancel; an already
      // eliminated one is done. Only a settled-but-not-terminal loser is cancelled and eliminated.
      if (member.status === "eliminated" || member.status === "failed" || member.status === "withdrawn") continue;
      const taskStatus = member.taskId ? this.tasks.status(member.taskId) : null;
      if (member.taskId && taskStatus !== null && LIVE_TASK_STATUSES.includes(taskStatus)) {
        try {
          await this.tasks.cancel(member.taskId);
        } catch (err) {
          allSettled = false;
          this.log("warn", { event: "ensemble_loser_cancel_failed", runId: member.runId, memberId, error: String(err) });
          continue;
        }
      }
      const after = member.taskId ? this.tasks.status(member.taskId) : null;
      if (member.taskId && after !== null && LIVE_TASK_STATUSES.includes(after)) {
        // The Task is still live after the cancel - do not eliminate yet, retry on the next pass.
        allSettled = false;
        continue;
      }
      this.store.setMemberStatus(memberId, ["submitted", "reviewing", "advanced", "launching", "active"], "eliminated", {}, now);
      this.event(member.runId, "member_eliminated", { memberId }, `member_eliminated:${memberId}`);
    }
    return allSettled ? { ok: true } : { ok: false, detail: "a loser member's Task could not be reaped; retry finalization" };
  }

  /** Bind the winner session to the pinned Workflow version and submit its exact-clean snapshot once. */
  private async runWorkflowHandoff(
    run: RunnableEnsembleRun,
    handoff: EnsembleWorkflowHandoff,
    sessionId: string | null,
    snapshotSha: string,
    ref: string,
    resultId: string,
  ): Promise<{ ok: boolean; detail?: string }> {
    const deps = this.finalize!;
    const now = this.now();
    if (!deps.workflow) {
      this.store.setWorkflowHandoff(run.id, { ...handoff, state: "failed", error: "no workflow handoff boundary is available in this build" }, now);
      return { ok: false, detail: "no workflow handoff boundary is available" };
    }
    if (sessionId === null) {
      // The winner session is not live yet (a replacement still coming up). Stay finalizing; the
      // finalizing-run wake resumes this once its session appears.
      return { ok: false, detail: "waiting for the selected result's session before binding a workflow" };
    }
    const sourceKey = `ensemble:${run.id}:result:${resultId}:workflow:${handoff.workflowVersionId}`;
    let bindingId = handoff.bindingId;
    if (bindingId === null) {
      this.store.setWorkflowHandoff(run.id, { ...handoff, state: "binding", sourceKey, expectedHeadSha: snapshotSha, error: null }, now);
      const bound = deps.workflow.ensureBinding({ sessionId, workflowVersionId: handoff.workflowVersionId, sourceId: run.id, resultId });
      if (!bound.ok) {
        const state: EnsembleWorkflowHandoff["state"] = bound.reason === "conflict" ? "conflict" : "failed";
        this.store.setWorkflowHandoff(run.id, { ...handoff, state, sourceKey, expectedHeadSha: snapshotSha, error: bound.detail }, this.now());
        this.event(run.id, "workflow_handoff_blocked", { reason: bound.reason }, `workflow_handoff_blocked:${run.id}:${bound.reason}:${now}`);
        return { ok: false, detail: bound.detail };
      }
      bindingId = bound.bindingId;
      this.store.setWorkflowHandoff(run.id, { ...handoff, state: "binding", sourceKey, expectedHeadSha: snapshotSha, bindingId, error: null }, this.now());
    }
    const submitted = await deps.workflow.submit({ bindingId, sourceId: run.id, resultId, expectedHeadSha: snapshotSha });
    if (!submitted.ok) {
      if (submitted.reason === "mismatch") {
        // HEAD drifted or the tree is dirty: restore the SAME winner exactly and resume the SAME
        // submission next pass - never a second binding, run, or round.
        await deps.restoreWinner({ sessionId, snapshotSha, ref }).catch(() => undefined);
        this.store.setWorkflowHandoff(
          run.id,
          { ...handoff, state: "binding", sourceKey, expectedHeadSha: snapshotSha, bindingId, error: "the winner drifted from its snapshot; restored, will resubmit" },
          this.now(),
        );
        return { ok: false, detail: "the winner drifted from its snapshot during capture; restored and will resubmit" };
      }
      const state: EnsembleWorkflowHandoff["state"] = submitted.reason === "conflict" ? "conflict" : "failed";
      this.store.setWorkflowHandoff(run.id, { ...handoff, state, sourceKey, expectedHeadSha: snapshotSha, bindingId, error: submitted.detail }, this.now());
      return { ok: false, detail: submitted.detail };
    }
    this.store.setWorkflowHandoff(
      run.id,
      { ...handoff, state: "submitted", sourceKey, expectedHeadSha: snapshotSha, bindingId, runId: submitted.runId, submissionId: submitted.submissionId, error: null },
      this.now(),
    );
    this.event(run.id, "workflow_handoff_submitted", { workflowRunId: submitted.runId }, `workflow_handoff_submitted:${run.id}:${submitted.runId}`);
    return { ok: true };
  }

  /** Deliver the winner continuation once, deduplicated by a deterministic delivery key. */
  private async deliverWinnerContinuation(
    state: RunState,
    winnerMember: EnsembleMember,
    winnerArtifact: EnsembleArtifact,
    ready: { mode: "restored" | "replacement"; sessionId: string | null },
    progress: EnsembleFinalizationProgress,
    stageAttemptId: string,
  ): Promise<{ ok: boolean; detail?: string; deliveryKey: string; progress: EnsembleFinalizationProgress }> {
    const run = state.run;
    const deliveryKey = progress.continuationDeliveryKey ?? `continuation:${run.id}:${winnerArtifact.id}`;
    if (progress.continuationDelivered) {
      return { ok: true, deliveryKey, progress: { ...progress, continuationDeliveryKey: deliveryKey } };
    }
    if (progress.continuationInIntent) {
      const claimed = {
        ...progress,
        continuationDeliveryKey: deliveryKey,
        continuationDelivered: true,
      };
      this.store.setFinalizationProgress(stageAttemptId, claimed, this.now());
      return { ok: true, deliveryKey, progress: claimed };
    }
    if (ready.sessionId === null) {
      return { ok: false, detail: "the winner session is not available to receive its continuation", deliveryKey, progress };
    }
    const claimed = {
      ...progress,
      continuationDeliveryKey: deliveryKey,
      continuationDelivered: true,
    };
    this.store.setFinalizationProgress(stageAttemptId, claimed, this.now());
    const delivered = await this.finalize!.deliverContinuation({
      sessionId: ready.sessionId,
      text: this.buildContinuation(state, winnerMember, winnerArtifact),
    });
    if (!delivered.ok) {
      const failedProgress = delivered.retryable
        ? { ...claimed, continuationDelivered: false }
        : claimed;
      if (delivered.retryable) {
        this.store.setFinalizationProgress(stageAttemptId, failedProgress, this.now());
      }
      return {
        ok: false,
        detail: `delivering the winner continuation failed: ${delivered.detail}`,
        deliveryKey,
        progress: failedProgress,
      };
    }
    this.event(run.id, "winner_continuation_delivered", { memberId: winnerMember.id }, `winner_continuation:${deliveryKey}`);
    return { ok: true, deliveryKey, progress: claimed };
  }

  private completeSelectOne(
    state: RunState,
    stageAttempt: EnsembleStageAttempt,
    plan: Extract<FinalizePlan, { kind: "select_one" }>,
    progress: EnsembleFinalizationProgress,
  ): "published" {
    const run = state.run;
    const now = this.now();
    // Re-read the run's outcome rather than trusting the state snapshot: `ensureWinnerReady` may have
    // persisted a `materializedTaskId` on it since this pass began, and completing with the stale
    // snapshot would drop the id of the one replacement Task the winner now lives in.
    const fresh = this.store.getRun(run.id);
    const outcome: EnsembleOutcome =
      fresh && fresh.outcome && fresh.outcome.kind === "selected"
        ? fresh.outcome
        : { kind: "selected", memberIds: [plan.winnerMemberId], artifactIds: [plan.winnerArtifactId], materializedTaskId: null };
    this.store.setFinalizationProgress(stageAttempt.id, { ...progress, step: "completed", error: null }, now);
    const completed = this.store.setRunStatus(
      run.id,
      ["finalizing"],
      "completed",
      { outcome, error: null, completedAt: now, activeStageId: null },
      now,
    );
    if (!completed.ok) return "published";
    this.store.finishStageAttempt(stageAttempt.id, ["running"], "succeeded", { output: { ...progress, step: "completed" } as unknown as EnsembleJson }, now);
    const decision = this.store.listDecisions(run.id).find((d) => d.status === "recorded" || d.status === "applied");
    if (decision) this.store.applyDecision(decision.id, stageAttempt.id, now);
    this.clearDeadline(run.id);
    this.event(run.id, "run_completed", { outcome: "selected", winner: plan.winnerMemberId }, `run_completed:${run.id}`);
    return "published";
  }

  /**
   * The ONE non-destructive terminal, shared by `no_consensus` and `retained`.
   *
   * Every submitted member becomes `retained`, its agent is settled through the ordinary Task
   * cancellation, and nothing else happens: no ref is verified, no checkout reset, no worktree
   * reaped, no continuation typed, no Workflow bound. Both outcomes are the same act - keep it all
   * - reached by two different human decisions, and a second copy of this body is how one of them
   * would eventually start reaping something.
   */
  private async completeRetainingAll(
    state: RunState,
    stageAttempt: EnsembleStageAttempt,
    outcome: Extract<EnsembleOutcome, { kind: "no_consensus" | "retained" }>,
    now: number,
  ): Promise<"published"> {
    const run = state.run;
    for (const member of state.members) {
      if (member.status === "submitted" || member.status === "reviewing") {
        this.store.setMemberStatus(member.id, ["submitted", "reviewing"], "retained", {}, now);
        await this.settleMemberTask(member, now);
      }
    }
    this.store.setFinalizationProgress(stageAttempt.id, { ...this.readFinalizationProgress(stageAttempt), step: "completed", error: null }, now);
    const completed = this.store.setRunStatus(
      run.id,
      ["finalizing"],
      "completed",
      { outcome, error: null, completedAt: now, activeStageId: null },
      now,
    );
    if (!completed.ok) return "published";
    this.store.finishStageAttempt(stageAttempt.id, ["running"], "succeeded", {}, now);
    const decision = this.store.listDecisions(run.id).find((d) => d.status === "recorded" || d.status === "applied");
    if (decision) this.store.applyDecision(decision.id, stageAttempt.id, now);
    this.clearDeadline(run.id);
    this.event(run.id, "run_completed", { outcome: outcome.kind }, `run_completed:${run.id}`);
    return "published";
  }

  /** Leave the run `finalizing` with an actionable error and a persisted receipt, to be resumed. */
  private parkFinalize(
    runId: string,
    stageAttemptId: string,
    progress: EnsembleFinalizationProgress,
    detail: string,
  ): "published" {
    const now = this.now();
    this.store.setFinalizationProgress(stageAttemptId, { ...progress, error: detail }, now);
    this.store.setRunStatus(runId, ["finalizing"], "finalizing", { error: detail }, now);
    this.event(runId, "finalization_blocked", { step: progress.step, detail }, `finalization_blocked:${stageAttemptId}:${progress.step}:${now}`);
    return "published";
  }

  private readFinalizationProgress(stageAttempt: EnsembleStageAttempt): EnsembleFinalizationProgress {
    return parseFinalizationProgress(stageAttempt.output) ?? freshFinalizationProgress();
  }

  /** The bounded winner continuation - original intent, the winner's own summary, the reviewer's take. */
  private buildContinuation(state: RunState, winnerMember: EnsembleMember, winnerArtifact: EnsembleArtifact): string {
    const run = state.run;
    const summary = readReportedSummary(winnerArtifact.metadata);
    const review = this.latestComparativeResult(run.id, winnerArtifact.id);
    const lines: string[] = [
      "You are the selected result of an ensemble comparison, restored to the exact snapshot that was compared.",
      "",
      "Original task:",
      run.intent,
    ];
    if (summary) lines.push("", `Your submitted summary: ${summary}`);
    if (review) {
      if (review.comparison) lines.push("", `Reviewer comparison: ${review.comparison}`);
      if (review.rationale) lines.push("", `Why this result was recommended: ${review.rationale}`);
      if (review.caveats.length > 0) lines.push("", `Caveats to check: ${review.caveats.join("; ")}`);
    }
    lines.push(
      "",
      "Inspect the work, address any caveats, then ship it through the normal flow - run the checks, push, and open a pull request yourself. The comparison is advisory: nothing has been pushed, no PR has been opened, and no gate has run.",
    );
    return boundedText(lines.join("\n"), ENSEMBLE_LIMITS.intent);
  }

  /** A neutral intent for a replacement winner whose checkout a Workflow will review automatically. */
  private buildReplacementHandoffIntent(run: RunnableEnsembleRun, winnerArtifact: EnsembleArtifact): string {
    const summary = readReportedSummary(winnerArtifact.metadata);
    const lines: string[] = [
      "You are the selected result of an ensemble comparison, restored to the exact snapshot that was compared.",
      "A workflow review runs against this checkout automatically. Do not push or open a pull request; wait for the review.",
      "",
      "Original task:",
      run.intent,
    ];
    if (summary) lines.push("", `Submitted summary: ${summary}`);
    return boundedText(lines.join("\n"), ENSEMBLE_LIMITS.intent);
  }

  /** The winner's slice of the latest succeeded comparative evaluation, for the continuation. */
  private latestComparativeResult(
    runId: string,
    winnerArtifactId: string,
  ): { comparison: string | null; rationale: string | null; caveats: string[] } | null {
    let latest: EnsembleJson | null = null;
    for (const evaluation of this.store.listEvaluations(runId)) {
      if (evaluation.status === "succeeded" && evaluation.result) latest = evaluation.result.body;
    }
    return latest ? readComparisonForArtifact(latest, winnerArtifactId) : null;
  }

  /**
   * Fail a run, tearing down every live member Task first.
   *
   * A failed run is TERMINAL, and `cancelRun` refuses a terminal run, so this is the ONLY place a
   * failing run's agents get torn down - leaving them would leak an agent and a worktree with no
   * ensemble action able to reclaim them. Teardown is best-effort: unlike `cancelRun`, a cancel that
   * cannot confirm does not hold the run open, because a deadline or an impossible barrier is a hard
   * stop and the operator can still Reclaim the worktree. The member is marked `failed` regardless,
   * because a terminal run is never reconciled again.
   */
  private async failRun(runId: string, reason: string): Promise<void> {
    this.reviewAborts.get(runId)?.abort();
    const now = this.now();
    const raw = this.loadRaw(runId);
    for (const member of raw?.members ?? []) {
      const status = member.status;
      if (status === "pending" || status === "launching" || status === "active") {
        await this.settleMemberTask(member, now);
        const attempt = raw ? this.latestAttempt(raw, member.id) : null;
        if (attempt) {
          this.store.setAttemptStatus(attempt.id, ["pending", "launching", "running"], "cancelled", { finishedAt: now }, now);
        }
        this.store.setMemberStatus(member.id, [status], "failed", { error: reason }, now);
      } else {
        // A member that already SETTLED (submitted, retained, ...) may still hold a live agent: it
        // submitted but has not been reaped. Stop that agent too, keeping its status and its
        // immutable artifact - or a run that fails after some members submitted leaks their agents,
        // and a terminal run cannot be `cancelRun`'d to clean them up.
        await this.settleMemberTask(member, now);
      }
    }
    this.interruptRunningReviews(runId, reason, now, "failed");
    this.clearDeadline(runId);
    this.store.setRunStatus(runId, NON_TERMINAL_RUN_STATUSES, "failed", { error: reason, completedAt: now }, now);
    this.event(runId, "run_failed", { reason }, `run_failed:${runId}:${now}`);
  }

  private completeReviewStage(
    runId: string,
    stageId: string,
    stageAttemptId: string,
    evaluationId: string,
    resultLabel: string | null,
    now: number,
  ): boolean {
    const finished = this.store.finishStageAttempt(
      stageAttemptId,
      ["running"],
      "succeeded",
      { output: { evaluationId, resultLabel } as EnsembleJson },
      now,
    );
    if (!finished.ok) return false;
    this.event(
      runId,
      "review_succeeded",
      { stageId, evaluationId, resultLabel },
      `review_succeeded:${stageAttemptId}`,
    );
    return true;
  }

  private interruptRunningReviews(
    runId: string,
    reason: string,
    now: number,
    stageStatus: "failed" | "cancelled",
  ): EnsembleStageAttempt[] {
    const stageAttempts = this.store
      .listStageAttempts(runId)
      .filter((attempt) => attempt.driverKind === "review" && attempt.status === "running");
    if (stageAttempts.length === 0) return [];
    const stageAttemptIds = new Set(stageAttempts.map((attempt) => attempt.id));
    const evaluations = this.store
      .listEvaluations(runId)
      .filter((evaluation) => stageAttemptIds.has(evaluation.stageAttemptId) && evaluation.status === "running");
    const evaluationIds = new Set(evaluations.map((evaluation) => evaluation.id));
    for (const call of this.store.listLlmCalls(runId)) {
      if (
        call.evaluationId === null ||
        !evaluationIds.has(call.evaluationId) ||
        call.state !== "running"
      ) {
        continue;
      }
      this.store.finishLlmCall(call.id, ["running"], "interrupted", {
        finishedAt: now,
        durationMs: Math.max(0, now - call.startedAt),
        inputBytes: call.inputBytes,
        outputBytes: call.outputBytes,
        costUsd: null,
        errorCode: "review_interrupted",
      });
    }
    for (const evaluation of evaluations) {
      this.store.finishEvaluation(evaluation.id, ["running"], "interrupted", { error: reason }, now);
    }
    return stageAttempts.filter(
      (attempt) =>
        this.store.finishStageAttempt(attempt.id, ["running"], stageStatus, { error: reason }, now).ok,
    );
  }

  /**
   * Stop a member's live agent while KEEPING its record and its immutable artifact.
   *
   * Used at a terminal transition: a submitted member's agent must not outlive the run, but its
   * captured snapshot is preserved by its private ref, so tearing the Task down (which reaps the
   * worktree) loses no work - the ref IS the retained artifact and the restore action can
   * materialize it as a normal Task. Best-effort, because a terminal run cannot be held open on a
   * cleanup hiccup.
   */
  private async settleMemberTask(member: EnsembleMember, now: number): Promise<void> {
    if (!member.taskId) return;
    const taskStatus = this.tasks.status(member.taskId);
    if (taskStatus === null || !LIVE_TASK_STATUSES.includes(taskStatus)) return;
    try {
      await this.tasks.cancel(member.taskId);
    } catch (err) {
      this.log("warn", { event: "ensemble_settle_cancel_failed", runId: member.runId, memberId: member.id, error: String(err) });
    }
  }

  private async enforceDeadline(state: RunState): Promise<boolean> {
    const deadline = state.run.plan.budget.deadlineMs;
    if (deadline === null) return false;
    if (this.now() - state.run.createdAt <= deadline) return false;
    await this.failRun(state.run.id, "the run passed its wall-clock deadline before finishing");
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

// ---- pure finalization helpers ----

/** Truncate a string to at most `max` characters, so a continuation cannot burst the intent cap. */
function boundedText(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

/** The `ref` off a git_snapshot locator, or null when the locator is not that shape. */
function refFromLocator(locator: EnsembleJson): string | null {
  if (locator && typeof locator === "object" && !Array.isArray(locator) && typeof locator.ref === "string") {
    return locator.ref;
  }
  return null;
}

/**
 * A deterministic UUID-shaped id from a seed, so a replacement Task keeps ONE id across a lost
 * response or a restart. Not a real v5 UUID (no namespace), but a stable 8-4-4-4-12 hex string a
 * Task id column accepts, with the version/variant nibbles pinned so it reads as a UUID.
 */
function deterministicUuid(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex");
  const variant = ((parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Whether a materialized replacement winner is actually usable to finalize around.
 *
 * `running` alone is not enough: a dispatched Task is `dispatching` while it provisions and has no
 * live session or worktree, and its dispatch can still fail. A ready winner needs a live session
 * (for a continuation or a Workflow bind) and its worktree, so completing can never point a done
 * run at a winner that never came up.
 */
function replacementUsable(status: { status: TaskGatewayStatus | null; sessionId: string | null; worktreePath: string | null }): boolean {
  return status.status === "running" && status.sessionId !== null && status.worktreePath !== null;
}

function freshFinalizationProgress(): EnsembleFinalizationProgress {
  return {
    step: "verifying",
    verifiedSnapshotSha: null,
    winner: null,
    continuationInIntent: false,
    losersReaped: false,
    continuationDeliveryKey: null,
    continuationDelivered: false,
    error: null,
  };
}

const FINALIZATION_STEPS = ["verifying", "materializing", "reaping_losers", "handoff", "completed"] as const;

/** Read a persisted finalization progress receipt back defensively, or null when it is not one. */
function parseFinalizationProgress(output: EnsembleJson): EnsembleFinalizationProgress | null {
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const step = output.step;
  if (typeof step !== "string" || !(FINALIZATION_STEPS as readonly string[]).includes(step)) return null;
  const winner = output.winner;
  const winnerShape =
    winner && typeof winner === "object" && !Array.isArray(winner) && (winner.mode === "restored" || winner.mode === "replacement")
      ? { mode: winner.mode as "restored" | "replacement", ready: winner.ready === true }
      : null;
  return {
    step: step as EnsembleFinalizationProgress["step"],
    verifiedSnapshotSha: typeof output.verifiedSnapshotSha === "string" ? output.verifiedSnapshotSha : null,
    winner: winnerShape,
    continuationInIntent: output.continuationInIntent === true,
    losersReaped: output.losersReaped === true,
    continuationDeliveryKey: typeof output.continuationDeliveryKey === "string" ? output.continuationDeliveryKey : null,
    continuationDelivered: output.continuationDelivered === true,
    error: typeof output.error === "string" ? output.error : null,
  };
}

/** A member's reported summary out of an artifact's metadata, for the continuation prompt. */
function readReportedSummary(metadata: EnsembleJson): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const reported = metadata.reported;
  if (reported && typeof reported === "object" && !Array.isArray(reported) && typeof reported.summary === "string") {
    return reported.summary;
  }
  return null;
}

/** The winner's slice of a mapped comparative result envelope body, defensively. */
function readComparisonForArtifact(
  body: EnsembleJson,
  artifactId: string,
): { comparison: string | null; rationale: string | null; caveats: string[] } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const comparison = typeof body.comparison === "string" ? body.comparison : null;
  const caveats = Array.isArray(body.caveats) ? body.caveats.filter((c): c is string => typeof c === "string") : [];
  let rationale: string | null = null;
  if (Array.isArray(body.subjects)) {
    for (const subject of body.subjects) {
      if (subject && typeof subject === "object" && !Array.isArray(subject) && subject.artifactId === artifactId && typeof subject.rationale === "string") {
        rationale = subject.rationale;
      }
    }
  }
  return { comparison, rationale, caveats };
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

/** One named section (`observed` / `reported`) of an artifact's metadata, or null if absent. */
function readMetadataSection(metadata: EnsembleJson, key: string): EnsembleJson {
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata) && key in metadata) {
    return metadata[key] ?? null;
  }
  return null;
}
