import { createHash, randomUUID } from "node:crypto";
import { repoAllowlisted } from "@shared/allowlist.ts";
import { paneToken } from "@shared/pane.ts";
import { AGENT_IDENTITY } from "@shared/agent.ts";
import { PULL_REQUEST_SKILL } from "@shared/skills.ts";
import type { WorkflowGateStanding } from "@shared/shipping.ts";
import { NO_MISTAKES_REVIEW_WORKFLOW_ID } from "@shared/builtin-workflow.ts";
import { resolvedSessionIntent, sessionIntentMatches } from "@shared/goal.ts";
import type { AgentType, Session, Task } from "@shared/types.ts";
import { agentActive, reportBucket, settledIdle } from "@shared/session.ts";
import { taskRepoStatuses, type TaskRepoRef } from "@shared/task-repos.ts";
import type {
  CreateWorkflow,
  CreateWorkflowBinding,
  GrantWorkflowRepairRounds,
  ResolveWorkflowDelivery,
  ResubmitWorkflow,
  RetryWorkflowDelivery,
  RetryWorkflowRun,
  RestartFullWorkflow,
  RemoveWorkflowPersonaDirective,
  SetWorkflowNodesDisabled,
  SetWorkflowPersonaDirective,
  SubmitWorkflow,
  UpdateWorkflow,
  UpdateWorkflowBinding,
} from "@shared/protocol.ts";
import type {
  PersonaFeedbackSummary,
  PersonaVerdict,
  SessionActionAttemptState,
  SessionActionBlockCode,
  SessionActionContinuationExpectation,
  SessionActionSnapshot,
  SessionActionWaitReason,
  WorkflowBinding,
  WorkflowNodeAttempt,
  WorkflowPersonaDirective,
  WorkflowSessionActionNode,
  WorkflowCaptureExpectation,
  WorkflowContextSnapshot,
  WorkflowDefinition,
  WorkflowDetail,
  WorkflowDiagnostic,
  WorkflowJson,
  WorkflowRun,
  WorkflowRunDetail,
  WorkflowBindingSummary,
  WorkflowRunSummary,
  WorkflowRunPage,
  WorkflowEventPage,
  WorkflowLlmCallPage,
  WorkflowExportEnvelope,
  WorkflowStatus,
  TestEvidenceAuditAggregate,
  WorkflowSubmission,
  WorkflowSubmissionReadinessOverride,
  WorkflowSummary,
  WorkflowValidationResult,
  WorkflowVersion,
  WorkflowVersionMetadata,
  WorkflowDelivery,
  WorkflowCompletionClaim,
  WorkflowCompletionClaimResult,
  WorkflowTriggerSource,
  WorkflowInspectorGateState,
  WorkflowRunRepeatOffender,
  WorkflowAgentEvidenceLocator,
  WorkflowAgentCommandEvidenceLocator,
  WorkflowAgentTextEvidenceLocator,
  WorkflowEvidenceCoverageClaim,
  WorkflowUploadEvidenceLocator,
  WorkflowRetainedEvidenceLocator,
  WorkflowStagedEvidenceList,
} from "@shared/workflow.ts";
import {
  WORKFLOW_EXTERNAL_SOURCE_KINDS,
  WORKFLOW_LIMITS,
  WORKFLOW_UNCHANGED_REPOSITORY_PHASE,
  isSessionActionNode,
  isVerdictNode,
  manualWorkflowTriggerKey,
  normalizeWorkflowName,
  verdictAuthor,
  workflowRoundLimitParkedPhase,
  workflowRunGaveUp,
  workflowRunResumesItself,
  evaluateWorkflowEvidenceReadiness,
  workflowEvidenceReadinessPolicyEnforces,
  type WorkflowResumptionWithheldReason,
} from "@shared/workflow.ts";
import {
  PersonaVerdictSchema,
  WorkflowCaptureExpectationSchema,
  WorkflowContextSnapshotSchema,
  WorkflowInspectorGateStateSchema,
} from "@shared/protocol.ts";
import type { InspectionUpdated, InspectorComment } from "@shared/types.ts";
import type { Registry } from "../registry.ts";
import { noteKeyFor } from "../registry.ts";
import { injectPrompt, type InjectResult } from "../actions.ts";
import { recordInjection } from "../injections.ts";
import { QueueManager } from "../queue.ts";
import { getForemanConfig } from "../foreman/config.ts";
import { harnessFor, sessionMessages } from "../harness/index.ts";
import type { JobExecution } from "../llm/jobs.ts";
import type { StructuredAttemptObserver } from "../llm/structured.ts";
import {
  DEFAULT_REVIEW_CONCURRENCY,
  createReviewScheduler,
  type ReviewScheduler,
} from "../llm/review-scheduler.ts";
import {
  TEST_EVIDENCE_AUDIT_SCAN_LIMIT,
  aggregateTestEvidenceAudit,
} from "./test-evidence-audit.ts";
import type { CheckRunDeps, CheckScheduler } from "./checks.ts";
import type { CheckAttemptRef } from "./check-runtime.ts";
import {
  captureBoundaryChanged,
  captureStableWorkflowContext,
  compactWorkflowContext,
  probeMatchesEvidence,
  readWorkflowContextRaw,
  readWorkflowEvidenceProbe,
  type WorkflowEvidenceProbe,
  readWorkflowRepositoryHead,
  readWorkflowRepositoryId,
  workflowCheckoutPath,
  workflowContextFingerprint,
  workflowRepositoryFingerprint,
} from "./context.ts";
import {
  WorkflowEngine,
  sessionActionCompleteEdges,
  type WorkflowEngineOptions,
} from "./engine.ts";
import {
  completionWatchesPullRequests,
  sessionActionAdapter,
  type SessionActionAdoptedPullRequest,
  type SessionActionCaptureFacts,
} from "./session-action-adapters.ts";
import { resolveCapturedCommit } from "./commit-id.ts";
import {
  externalSourceKey,
  type EnsureExternalBindingInput,
  type ExternalBindingEligibility,
  type ExternalBindingResult,
  type SubmitExternalInput,
} from "./external-binding.ts";
import {
  WorkflowStore,
  type WorkflowDeleteWrite,
  type WorkflowPublishWrite,
  type WorkflowStoreWrite,
} from "./store.ts";
import { workflowJson } from "./store.ts";
import { getWorkflowPolicy } from "./config.ts";
import {
  renderInspectorFeedback,
  renderPrHandoff,
  renderSessionAction,
  renderParkedRepairReminder,
  renderUnchangedEvidenceNudge,
  renderWorkflowFeedback,
  renderEvidenceReadinessPacket,
} from "./feedback.ts";
import { findingFingerprintAudit } from "./finding-audit.ts";
import { repeatOffenders } from "./repeat-offender.ts";
import {
  getInspectorPr,
  loadInspectorComments,
  loadAdoptedInspectorPrsSince,
  loadInspectorInspections,
  loadOpenInspectorPrs,
  primaryRepoPrForTask,
  taskReposFor,
} from "../db.ts";
import { getInspectorConfig } from "../inspector/config.ts";
import { parsePrUrl } from "../inspector/github.ts";
import { inspectorPosture } from "@shared/inspector.ts";
import { runWorkflowRetention, WORKFLOW_RETENTION_INTERVAL_MS } from "./retention.ts";
import { workflowLog } from "./log.ts";
import {
  captureSubmissionImages,
  captureSubmissionTextArtifacts,
  reconcileWorkflowEvidenceFiles,
  stageAgentWorkflowEvidence,
  stageUploadedWorkflowEvidenceSync,
  stageRetainedWorkflowEvidence,
  WorkflowImageEvidenceError,
  workflowEvidenceOrphanCount,
} from "./images.ts";
import {
  requiredSkillCommand,
  type RequiredSkillCommand,
} from "../skills/invoke.ts";

/** Bound the caller's idempotency key while scoping it to the run that owns the decision. */
function evidenceReadinessOverrideRequestKey(runId: string, requestId: string): string {
  return `readiness-override:${createHash("sha256")
    .update(runId)
    .update("\0")
    .update(requestId)
    .digest("hex")}`;
}

export type WorkflowMutation =
  | { ok: true; workflow: WorkflowDefinition; summary: WorkflowSummary }
  | Exclude<WorkflowStoreWrite, { ok: true }>;

/** Evidence eligibility is a fact of the immutable version already in hand. */
function versionSupportsWorkflowEvidence(version: WorkflowVersion): boolean {
  return version.graph.nodes.some((node) => node.kind === "persona");
}

/** Success carries only the id: there is no row left to summarize. */
export type WorkflowDeleteMutation =
  | { ok: true; id: string }
  | Exclude<WorkflowDeleteWrite, { ok: true }>;

export type WorkflowPublishMutation =
  | {
      ok: true;
      workflow: WorkflowDefinition;
      summary: WorkflowSummary;
      version: WorkflowVersion;
      idempotent: boolean;
    }
  | Exclude<WorkflowPublishWrite, { ok: true }>;

export type WorkflowValidationMutation =
  | ({ ok: true; workflow: WorkflowDefinition } & WorkflowValidationResult)
  | {
      ok: false;
      reason: "not_found" | "revision_conflict";
      current: WorkflowDefinition | null;
    };

export type WorkflowRuntimeMutation<T> =
  | { ok: true; value: T; idempotent?: boolean }
  | {
      ok: false;
      reason:
        | "not_found"
        | "conflict"
        | "unsupported_mode"
        | "session_unavailable"
        | "incompatible_session"
        | "inactive_binding"
        | "run_active"
        | "run_not_waiting"
        | "unchanged_evidence"
        | "unchanged_repository"
        | "round_limit"
        | "not_infrastructure_failure"
        | "stale_capture"
        | "invalid_delivery_state"
        | "confirmation_required"
        | "ineligible_session"
        | "artifact_mismatch";
      message: string;
      current?: unknown;
    };

export interface WorkflowSubmitResult {
  run: WorkflowRun;
  submission: WorkflowSubmission;
}

/**
 * One durable run waiting to capture, and the binding whose repository it reviews.
 *
 * A trigger produces a LIST of these - one per repository the turn changed - and every one is
 * an ordinary single-repository run. The binding rides along because capture needs it and
 * because it is the only thing that says which checkout this run is about.
 */
interface PreparedWorkflowRun extends WorkflowSubmitResult {
  binding: WorkflowBinding;
  /**
   * The evidence fingerprint the previous round captured, when this run is a repair rather
   * than a first submission.
   *
   * Carried rather than dropped because it is what makes an unchanged snapshot refusable: a
   * sibling repository resubmitted at the completion boundary has a previous round, and a
   * capture that forgot it would accept the same evidence again and spend a repair round
   * proving nothing. Absent for every initial submission, which is what the manual fan-out
   * produces.
   */
  previousFingerprint?: string;
}

export interface WorkflowManagerOptions {
  engine?: WorkflowEngineOptions;
  readContextRaw?: typeof readWorkflowContextRaw;
  boundaryChanged?: typeof captureBoundaryChanged;
  /**
   * The resumption observer's cheap "has anything moved?" read. The same seam as
   * `readContextRaw`, and for the same reason: it shells out to git in the session's
   * checkout, and a workflow test must be able to drive the observer without one.
   */
  readEvidenceProbe?: typeof readWorkflowEvidenceProbe;
  /**
   * The three reads a completion adapter's proof is built from, injectable for the reason
   * every seam above is: two of them shell out to git in the session's checkout and the third
   * reads the Inspector's ledger, and a workflow test must be able to state a repository, a
   * pull request and a resolved commit rather than arrange one on disk and on GitHub.
   *
   * `resolveCommit` is the same seam `CheckRuntimeDeps` already carries, for the same reason:
   * turning a captured abbreviation into a full object id is a question about a real object
   * database, and the proof it feeds has to be provable without one.
   */
  readRepositoryHead?: typeof readWorkflowRepositoryHead;
  readRepositoryId?: typeof readWorkflowRepositoryId;
  adoptedPullRequests?: () => readonly SessionActionAdoptedPullRequest[];
  resolveCommit?: (repoRoot: string, headSha: string) => Promise<string>;
  compactContext?: typeof compactWorkflowContext;
  queueManager?: QueueManager;
  inject?: typeof injectPrompt;
  recordInjection?: typeof recordInjection;
  /**
   * The daemon's shared review budget, spent by Persona attempts and context compaction
   * alike. Constructed here only so a test or a second embedder still gets a real ceiling.
   */
  reviewScheduler?: ReviewScheduler;
  /**
   * The daemon's ceiling on check commands, which is a DIFFERENT budget from the review one
   * and must stay that way: a three-minute test suite spending a review slot would starve
   * the Persona reviews that budget exists to pace. Unlike `reviewScheduler` this one has a
   * single spender, so it is passed straight through rather than held here.
   */
  checkScheduler?: CheckScheduler;
  /**
   * The execution runtime a Check node reaches, bound per attempt.
   *
   * Beside `checkScheduler` because they are the two halves of the same wiring and the daemon
   * hands over both at once: one paces check commands, the other is what makes there be a
   * command to pace. Absent, every configured check reports `unavailable` and passes with a
   * note - the shipped behaviour of a build with no runtime.
   */
  checkDeps?: (attempt: CheckAttemptRef) => CheckRunDeps;
  /**
   * Contract R, forwarded beside the runtime that creates the leases it asks about.
   *
   * Separate from `checkDeps` because it is consulted on a path the executor never reaches -
   * the moment the engine decides whether to create a retry - and injecting one without the
   * other would be a runtime that leases trees nothing gates a second lease against.
   */
  unresolvedCheckLease?: (submissionId: string, nodeId: string) => boolean;
  /**
   * Whether an external orchestrator may claim this session right now.
   *
   * Injected rather than imported: the owner of that answer is the orchestrator holding the
   * session, and a Workflow module that reached into its store to ask would be exactly the
   * dependency this boundary exists to prevent. Returns one sentence for a human, or null.
   */
  externalBindingEligibility?: ExternalBindingEligibility;
  /**
   * Whether a session may acquire a NORMAL (manual) Workflow binding right now.
   *
   * The same narrow guard as `externalBindingEligibility`, applied to the manual bind path: an
   * active ensemble member session is refused here so an operator cannot bind it out from under the
   * finalization that will read it. Backed by the ensemble manager and injected as a bare
   * `(sessionId) => reason | null`, so this module never imports the ensemble store. Absent means
   * "no orchestrator to consult" and every session is eligible, which is the pre-Phase-6 behaviour.
   */
  canBindSessionToWorkflow?: (sessionId: string) => string | null;
  retentionIntervalMs?: number;
  runRetention?: typeof runWorkflowRetention;
  /** Required-skill resolver; injectable so workflow tests never touch global skill dirs. */
  requireSkill?: (session: Session, id: string) => RequiredSkillCommand;
  /** How often the resumption observer looks. Injectable so a test can drive `sweepResumptions` itself. */
  resumptionIntervalMs?: number;
  /**
   * How long the bound session must have been idle before a parked round resumes.
   *
   * The daemon passes its OWN window rather than reading Foreman's config: this observer runs
   * in the daemon, the Foreman runs in its own process, and one subsystem reaching into the
   * other's environment variable to answer a question it owns is how they end up disagreeing.
   * `settledIdle` itself is the one shared predicate (`@shared/session.ts`).
   */
  resumptionSettleMs?: number;
  /**
   * How long a parked round with a delivered packet and an untouched repository may sit
   * before the session is reminded once. Injectable so a test need not wait it out.
   */
  parkedReminderMs?: number;
}

/**
 * How often the resumption observer looks, and how settled a session must be before it acts.
 *
 * Both are plain constants rather than environment variables on purpose: the sweep is two git
 * commands per parked run and the settle window is a property of how a TUI reports idleness,
 * not something an operator tunes per machine. The interval is short relative to the settle
 * window, so the first tick after a session settles is the one that acts.
 */
const WORKFLOW_RESUMPTION_INTERVAL_MS = 15_000;
const WORKFLOW_RESUMPTION_SETTLE_MS = 10_000;

/**
 * How long a repair round may sit parked, packet delivered and repository untouched, before
 * the session is reminded about it once.
 *
 * Well above any plausible repair, and deliberately so. The observer withholding a round is
 * the NORMAL state for as long as an agent is thinking, reading, or running a test suite,
 * and a reminder that arrives during ordinary work is an interruption that makes the agent
 * worse at the thing it was already doing. Forty-five minutes is longer than every
 * successful repair in the ledger this was measured against and far shorter than the
 * multi-hour silences that produced no repair at all.
 */
const WORKFLOW_PARKED_REMINDER_MS = 45 * 60_000;

/** Delivery states that mean the latest packet has not demonstrably reached the agent yet. */
const UNDELIVERED_DELIVERY_STATES = ["prepared", "sending", "uncertain"] as const;

/**
 * How many consecutive unchanged-evidence refusals get a nudge before the run blocks.
 *
 * Read as a comparison: the run blocks when the count EXCEEDS this, so refusals 1 and 2 each
 * produce a packet and the third blocks. Two is not arbitrary - the first nudge covers a
 * session that genuinely lost the packet to a compaction, and the second covers a session that
 * read it and misjudged what "changed" means. A session that has ignored two explicit,
 * escalating packets is not going to be fixed by a third, and each one costs a real terminal
 * write into somebody's pane. Reaching the bound is a visible `blocked` state a human resolves,
 * which is the safety property, not a limitation to route around.
 */
const UNCHANGED_EVIDENCE_NUDGE_LIMIT = 2;

function runIsTerminal(run: WorkflowRun): boolean {
  return ["completed", "cancelled", "failed"].includes(run.status);
}

/**
 * The blocked phases an externally sourced submission may resume capture from.
 *
 * Every one of them is produced by the capture path itself and leaves the round's evidence
 * unwritten, which is what makes resuming the SAME submission correct rather than a way to
 * paper over a run that failed for some other reason.
 */
const CAPTURE_RESUMABLE_PHASES = [
  "external_artifact_mismatch",
  "capture_interrupted",
  "capture_error",
  "stale_capture",
  "image_evidence_capture",
] as const;

const IMAGE_CAPTURE_RESUMABLE_PHASES = ["image_evidence_capture"] as const;

/**
 * Whether this run's evidence is pinned to an external artifact.
 *
 * The manual paths - resubmit, and the replacement round a discarded delivery creates -
 * capture whatever the session holds RIGHT NOW, with no expectation attached. On an
 * externally sourced run that is a way around exact-clean capture: one click would review a
 * working tree the external caller never selected, through a route that already exists. They
 * refuse instead, because "review this session as it stands" is not a question this kind of
 * run can be asked - its subject is one immutable artifact.
 */
function externallySourced(run: WorkflowRun): boolean {
  return (WORKFLOW_EXTERNAL_SOURCE_KINDS as readonly string[]).includes(run.triggerSource);
}

const EXTERNAL_MANUAL_ROUND_REFUSAL =
  "This run reviews one exact external result, so its evidence cannot be re-captured from "
  + "the session's current state. The source that started it must submit again.";

/** The exact facts that refused an externally sourced capture, or null when it may proceed. */
type CaptureExpectationMismatch = {
  expectedHeadSha: string;
  headSha: string | null;
  headMatches: boolean;
  workingTreeDirty: boolean;
  requireCleanWorktree: true;
};

function expectationMismatch(
  expectation: WorkflowCaptureExpectation,
  context: WorkflowContextSnapshot,
): CaptureExpectationMismatch | null {
  const headSha = context.evidence.headSha;
  const workingTreeDirty = context.evidence.workingTreeDirty;
  const headMatches = headSha === expectation.expectedHeadSha;
  if (headMatches && !(expectation.requireCleanWorktree && workingTreeDirty)) return null;
  return {
    expectedHeadSha: expectation.expectedHeadSha,
    headSha,
    headMatches,
    workingTreeDirty,
    requireCleanWorktree: expectation.requireCleanWorktree,
  };
}

/** Definition/runtime policy plus compact catalog and run-summary SSE publication. */
export class WorkflowManager {
  readonly engine: WorkflowEngine;
  private unsubscribe: (() => void) | null = null;
  private discoveryUnsubscribe: (() => void) | null = null;
  private inspectionUnsubscribe: (() => void) | null = null;
  private readonly captureLocks = new Map<string, Promise<void>>();
  private readonly gateLocks = new Map<string, Promise<void>>();
  /**
   * Deliveries already reported as queued behind a sibling repository's review.
   *
   * In memory and deliberately not durable: it exists only to keep the re-offer sweep from
   * appending the same `delivery_queued` event every few seconds. The QUEUE itself is
   * re-derived from persisted delivery and attempt state on every offer, so a restart loses
   * nothing but the right to stay quiet about a hold it has already reported once.
   */
  private readonly queuedDeliveries = new Set<string>();
  private readonly backgroundTasks = new Set<Promise<void>>();
  private readonly queues: QueueManager;
  private readonly inject: typeof injectPrompt;
  private readonly rememberInjection: typeof recordInjection;
  private readonly requireSkill: NonNullable<WorkflowManagerOptions["requireSkill"]>;
  private readonly schedule: ReviewScheduler;
  private retentionTimer: ReturnType<typeof setInterval> | null = null;
  private retentionRunning = false;
  private resumptionTimer: ReturnType<typeof setInterval> | null = null;
  private resumptionRunning = false;
  private sessionActionSweepRunning = false;
  /**
   * Repeat offenders, memoized on the run row's `updatedAt`.
   *
   * The away watcher asks every few seconds and the derivation walks every submission and
   * attempt of a run; the cache turns that into one walk per real transition. Keyed by run id
   * and pruned by the same sweep, so a deleted run cannot pin its entry.
   */
  private readonly repeatOffenderCache = new Map<
    string,
    { updatedAt: number; offenders: WorkflowRunRepeatOffender[] }
  >();
  private lastRecoveryAt: number | null = null;
  private lastRetentionAt: number | null = null;
  private lastRetentionError: string | null = null;
  private lastRetentionCompacted = 0;
  private lastRetentionDeleted = 0;
  private orphanedEvidenceImages = 0;

  constructor(
    private readonly registry: Registry,
    readonly store = new WorkflowStore(),
    private readonly options: WorkflowManagerOptions = {},
  ) {
    this.queues = options.queueManager ?? new QueueManager(registry);
    this.inject = options.inject ?? injectPrompt;
    this.rememberInjection = options.recordInjection ?? recordInjection;
    this.requireSkill = options.requireSkill ?? requiredSkillCommand;
    // ONE scheduler, resolved once from whichever option named it, then handed to both
    // halves. Compaction used to run outside the engine's limiter entirely, so two
    // submissions capturing at once could exceed the ceiling the engine was enforcing.
    //
    // It is resolved here rather than half here and half in the engine because those are the
    // same budget: letting `engine.schedule` win for Persona attempts while compaction kept
    // this one would hand back exactly the split this is meant to close, and would silently
    // ignore `engine.concurrency` too. The assignment below therefore comes AFTER the spread
    // of `options.engine`, so no caller can reintroduce a second scheduler.
    this.schedule = options.reviewScheduler
      ?? options.engine?.schedule
      ?? createReviewScheduler(options.engine?.concurrency ?? DEFAULT_REVIEW_CONCURRENCY);
    this.registry.initializeWorkflows(this.list(true));
    const configuredWaiting = options.engine?.onSubmissionWaiting;
    const configuredSucceeded = options.engine?.onSubmissionSucceeded;
    this.engine = new WorkflowEngine(
      this.store,
      (runId) => this.publishRun(runId),
      {
        ...options.engine,
        schedule: this.schedule,
        // After the spread, for `schedule`'s reason: a caller must not be able to hand the
        // engine a second check budget alongside the daemon's - nor a second execution
        // runtime, whose pooled leases and durable process rows are daemon-wide resources.
        ...(options.checkScheduler ? { checkSchedule: options.checkScheduler } : {}),
        ...(options.checkDeps ? { checkDeps: options.checkDeps } : {}),
        ...(options.unresolvedCheckLease
          ? { unresolvedCheckLease: options.unresolvedCheckLease }
          : {}),
        onSubmissionWaiting: (submissionId) => {
          this.scheduleWaitingDelivery(submissionId);
          configuredWaiting?.(submissionId);
        },
        onSessionActionWaiting: (attemptId) => {
          this.scheduleSessionActionDelivery(attemptId);
          options.engine?.onSessionActionWaiting?.(attemptId);
        },
        onSubmissionSucceeded: (submissionId) =>
          this.enterInspectorGate(submissionId) || Boolean(configuredSucceeded?.(submissionId)),
      },
    );
    this.registry.initializeWorkflowRuns(this.runs());
    this.registry.initializeWorkflowBindings(this.bindingSummaries());
    this.registry.registerWorkflowReset((noteKey) => {
      const removed = this.store.resetForNoteKey(noteKey);
      reconcileWorkflowEvidenceFiles(this.store);
      this.orphanedEvidenceImages = workflowEvidenceOrphanCount(this.store);
      for (const id of removed.runIds) this.registry.removeWorkflowRun(id);
      // The bindings too. A reset deletes them in the same transaction as the runs, and
      // retiring only the runs left the stream publishing a binding whose row was gone - so a
      // reset session's chip kept naming a workflow that no longer existed and could never
      // run. Every other path that ends a binding retires it here as well.
      for (const id of removed.bindingIds) this.registry.removeWorkflowBinding(id);
    });
  }

  start(): void {
    if (!this.inspectionUnsubscribe) {
      this.inspectionUnsubscribe = this.registry.onInspectionUpdated((event) => {
        this.scheduleInspectionUpdate(event);
        // The gate is not the only thing that waits on a pull request any more. A
        // `pull_request` action settles its turn long before its proof exists, and the proof
        // is exactly what this event carries word of - so without this the action would sit
        // until the next fifteen-second sweep happened to look, on every push, for every
        // action. The sweep still runs; this only stops it being the sole way forward.
        this.scheduleSessionActionProofCheck();
      });
    }
    this.resetRecoveredGateObservations();
    for (const delivery of this.store.recoverSendingDeliveries()) {
      this.publishRun(delivery.runId);
    }
    if (!this.unsubscribe) {
      this.unsubscribe = this.registry.subscribe((event) => {
        if (event.type === "task_upsert") {
          this.bindDispatchedTaskWorkflow(event.task);
          return;
        }
        if (event.type === "session_remove") {
          for (const delivery of this.store.markSendingUncertainForSession(event.id, "session_disappeared")) {
            this.publishRun(delivery.runId);
          }
          for (const binding of this.store.listBindings()) {
            if (binding.sessionId !== event.id || binding.state === "archived") continue;
            const active = this.store.orphanBinding(binding.id, "session_disappeared");
            if (active) {
              this.publishBinding(active.id);
              const run = this.store.activeRunForBinding(active.id);
              if (run) this.publishRun(run.id);
            }
          }
          return;
        }
        if (event.type !== "session_upsert") return;
        // Pickup is recorded HERE rather than on the sweep: a turn can start and finish
        // between two fifteen-second samples, and the proof would be gone by the time the
        // observer looked. See `noteSessionActionActivity`.
        this.noteSessionActionActivity(event.session);
        for (const binding of this.store.listBindings()) {
          if (binding.sessionId !== event.session.id || binding.state !== "active") continue;
          if (binding.noteKey === noteKeyFor(event.session)) continue;
          for (const delivery of this.store.markSendingUncertainForSession(
            event.session.id,
            "conversation_changed",
          )) {
            this.publishRun(delivery.runId);
          }
          const paused = this.store.pauseBinding(binding.id, "conversation_changed");
          if (paused) {
            this.publishBinding(paused.id);
            const run = this.store.activeRunForBinding(paused.id);
            if (run) this.publishRun(run.id);
          }
        }
        this.scheduleGatesForSession(event.session.id);
        // A conversation running several repositories' reviews serializes their deliveries,
        // and this is the signal that the turn one of them was using has moved on. It leaves
        // on its first line for every conversation with a single binding, which is every
        // single-repo session in the fleet.
        this.scheduleQueuedDeliveries(noteKeyFor(event.session));
        const task = this.registry
          .listTasks()
          .find((candidate) =>
            candidate.sessionId === event.session.id
            && (candidate.status === "dispatching" || candidate.status === "running"));
        if (task) this.bindDispatchedTaskWorkflow(task);
      });
    }
    if (this.registry.sessionsObserved()) {
      this.recoverWaitingDeliveries();
      this.reconcileBindingsAfterDiscovery();
      this.startEngineAndMaintenance();
    } else if (!this.discoveryUnsubscribe) {
      this.discoveryUnsubscribe = this.registry.onSessionsObserved(() => {
        this.discoveryUnsubscribe = null;
        this.recoverWaitingDeliveries();
        this.reconcileBindingsAfterDiscovery();
        this.startEngineAndMaintenance();
      });
    }
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.discoveryUnsubscribe?.();
    this.discoveryUnsubscribe = null;
    this.inspectionUnsubscribe?.();
    this.inspectionUnsubscribe = null;
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    this.retentionTimer = null;
    if (this.resumptionTimer) clearInterval(this.resumptionTimer);
    this.resumptionTimer = null;
    await this.engine.stop();
    await Promise.allSettled(this.backgroundTasks);
  }

  list(includeArchived = false): WorkflowSummary[] {
    return this.store.listWorkflows(includeArchived).map((workflow) => this.store.summary(workflow));
  }

  get(id: string): WorkflowDetail | null {
    const workflow = this.store.getWorkflow(id);
    return workflow ? { workflow, versions: this.store.listWorkflowVersionMetadata(id) } : null;
  }

  /**
   * Whether a workflow remains a valid durable selection for a task.
   *
   * Backlog tasks intentionally keep this intent before there is a session to bind, so
   * Foreman and harness capability are launch concerns rather than save concerns.
   */
  workflowSelectionBlock(workflowId: string): string | null {
    const detail = this.get(workflowId);
    if (!detail || !detail.workflow.currentVersionId) {
      return "Choose a workflow with a published version";
    }
    if (detail.workflow.archivedAt !== null) {
      return "The selected workflow is archived";
    }
    return null;
  }

  /**
   * Whether a workflow can be armed on a newly dispatched session of this harness.
   *
   * Asked at every launch boundary so a selected/default workflow never degrades into a
   * running task with no completion review. Saving a backlog task uses the narrower
   * `workflowSelectionBlock` instead.
   */
  dispatchWorkflowBlock(
    workflowId: string,
    agent: AgentType,
    repoRoot?: string,
  ): string | null {
    const selectionBlocked = this.workflowSelectionBlock(workflowId);
    if (selectionBlocked) return selectionBlocked;
    const detail = this.get(workflowId);
    // `workflowSelectionBlock` proved both facts; retain the guard so this method stays
    // total if persistence changes between the two reads.
    if (!detail || !detail.workflow.currentVersionId) return "Choose a published workflow";
    const harness = harnessFor(agent);
    if (!getForemanConfig().enabled) {
      return "Turn on Foreman before dispatching a task with an after-work workflow";
    }
    if (!harness.hooks || !harness.workQueue) {
      return `${AGENT_IDENTITY[agent].label} cannot detect the Foreman Complete boundary required by after-work workflows`;
    }
    const current = detail.versions.find(
      (version) => version.id === detail.workflow.currentVersionId,
    );
    if (current?.bindingDefaults.deliveryMode === "live" && repoRoot) {
      const config = getWorkflowPolicy();
      if (
        !config.liveEnabled
        || !repoAllowlisted(repoRoot, repoRoot, config.repoAllowlist)
      ) {
        return "This workflow uses Live delivery, which requires Workflows Live mode and an allowlisted repository";
      }
    }
    return null;
  }

  /**
   * Whether an existing conversation binding matches the after-work binding this task
   * would arm. Assignment reuses a conversation, unlike a fresh dispatch, so it must
   * reconcile this ownership before TaskManager makes the task/session relationship real.
   */
  assignmentWorkflowBlock(workflowId: string | null, session: Session): string | null {
    const current = this.store.activeBindingForNote(noteKeyFor(session));
    if (!current) return null;
    // The binding owns the immutable version. Resolve only its workflow identity here so a
    // newer current version does not make the same task-owned binding look foreign.
    const currentVersion = this.store.getWorkflowVersionById(current.workflowVersionId);
    if (
      currentVersion?.workflowId === workflowId
      && current.triggerMode === "foreman_complete"
    ) return null;
    return "This conversation already has a different active Workflow binding";
  }

  /** Retry pending task-owned bindings after a prerequisite such as Foreman is enabled. */
  reconcileDispatchedTaskWorkflows(): void {
    for (const task of this.registry.listTasks()) this.bindDispatchedTaskWorkflow(task);
  }

  /**
   * Turn durable task intent into the ordinary immutable Workflow binding once the task's
   * session has a stable conversation identity.
   *
   * Idempotence comes from the active note-key binding: repeated task/session SSE-worthy
   * updates find the exact after-work binding already there. Assignment rejects a conflicting
   * binding before it moves the task onto the session. The task stores a Workflow identity,
   * while this moment pins its current immutable version.
   */
  private bindDispatchedTaskWorkflow(task: Task): void {
    if (
      !task.workflowId
      || !task.sessionId
      || (task.status !== "dispatching" && task.status !== "running")
    ) return;
    const session = this.registry.getSession(task.sessionId);
    if (!session || session.state === "exited" || !session.agentSessionId) return;
    const detail = this.get(task.workflowId);
    const versionId = detail?.workflow.currentVersionId ?? null;
    if (!detail || detail.workflow.archivedAt !== null || !versionId) return;
    const current = this.store.activeBindingForNote(noteKeyFor(session));
    if (current) {
      const conflict = this.assignmentWorkflowBlock(task.workflowId, session);
      if (conflict) {
        console.error(`[workflow] could not arm ${detail.workflow.name} for task ${task.id}: ${conflict}`);
      }
      return;
    }
    const result = this.createBinding({
      workflowVersionId: versionId,
      sessionId: session.id,
      // The dispatch surface promises "after work", not the published version's optional
      // manual trigger default. Delivery mode and repair rounds still come from that version.
      triggerMode: "foreman_complete",
    });
    if (!result.ok) {
      console.error(
        `[workflow] could not arm ${detail.workflow.name} for task ${task.id}: ${result.message}`,
      );
    }
  }

  create(
    input: Omit<CreateWorkflow, "resumptionPolicy" | "evidenceReadinessPolicy"> &
      Partial<Pick<CreateWorkflow, "resumptionPolicy" | "evidenceReadinessPolicy">>,
    now = Date.now(),
  ): WorkflowMutation {
    const result = this.store.insertWorkflow({
      ...input,
      id: randomUUID(),
      normalizedName: normalizeWorkflowName(input.name),
      createdAt: now,
      updatedAt: now,
    });
    return this.finish(result);
  }

  update(id: string, input: UpdateWorkflow, now = Date.now()): WorkflowMutation {
    const { expectedDraftRevision, ...editable } = input;
    const result = this.store.updateWorkflowCas(id, expectedDraftRevision, {
      ...editable,
      ...(editable.name === undefined ? {} : { normalizedName: normalizeWorkflowName(editable.name) }),
    }, now);
    return this.finish(result);
  }

  archive(id: string, expectedDraftRevision: number, now = Date.now()): WorkflowMutation {
    return this.finish(this.store.archiveWorkflowCas(id, expectedDraftRevision, now));
  }

  unarchive(id: string, expectedDraftRevision: number, now = Date.now()): WorkflowMutation {
    return this.finish(this.store.unarchiveWorkflowCas(id, expectedDraftRevision, now));
  }

  /**
   * Hard-delete a never-published workflow. The store owns that refusal; see
   * `deleteWorkflowCas` for why no cascade is needed.
   *
   * This is the only caller of the removal half of the Registry's workflow pair. Archive goes
   * through `finish`, which UPSERTS, because an archived row is still live addressable state;
   * a deleted one has to leave the browser's map, and `workflow_remove` is the event
   * `useEventStream` already handles for exactly that.
   */
  remove(id: string, expectedDraftRevision: number): WorkflowDeleteMutation {
    const result = this.store.deleteWorkflowCas(id, expectedDraftRevision);
    if (!result.ok) return result;
    this.registry.removeWorkflow(result.workflow.id);
    return { ok: true, id: result.workflow.id };
  }

  validate(id: string, expectedDraftRevision: number): WorkflowValidationMutation {
    const workflow = this.store.getWorkflow(id);
    if (!workflow) return { ok: false, reason: "not_found", current: null };
    if (workflow.draftRevision !== expectedDraftRevision) {
      return { ok: false, reason: "revision_conflict", current: workflow };
    }
    // The store's own validation, so the library card, this route and Publish cannot
    // disagree about the same draft - including about whether this build can run its nodes.
    const result = this.store.validateDraft(workflow);
    return { ok: true, workflow, ...result };
  }

  publish(id: string, expectedDraftRevision: number, now = Date.now()): WorkflowPublishMutation {
    const result = this.store.publishWorkflow(id, expectedDraftRevision, randomUUID(), now);
    if (!result.ok) return result;
    const summary = this.store.summary(result.workflow);
    this.registry.upsertWorkflow(summary);
    return { ...result, summary };
  }

  versions(id: string): WorkflowVersionMetadata[] | null {
    return this.store.getWorkflow(id) ? this.store.listWorkflowVersionMetadata(id) : null;
  }

  version(id: string, version: number): WorkflowVersion | null {
    return this.store.getWorkflowVersion(id, version);
  }

  /** Persona edits can change draft diagnostics and version-history staleness. */
  refreshSummaries(): void {
    for (const summary of this.list(true)) this.registry.upsertWorkflow(summary);
  }

  diagnostics(id: string): WorkflowDiagnostic[] | null {
    const workflow = this.store.getWorkflow(id);
    if (!workflow) return null;
    return this.store.validateDraft(workflow).diagnostics;
  }

  bindings(): WorkflowBinding[] {
    return this.store.listBindings();
  }

  /** The armed-workflow projections the fleet stream is seeded from at boot. */
  bindingSummaries(): WorkflowBindingSummary[] {
    return this.store.listBindingSummaries();
  }

  runs(): WorkflowRunSummary[] {
    return this.store.listRunSummaries();
  }

  runPage(input: {
    limit: number;
    cursor: { updatedAt: number; id: string } | null;
    status?: WorkflowRun["status"];
    workflowId?: string;
    session?: string;
  }): WorkflowRunPage {
    return this.store.listRunSummaryPage(input);
  }

  events(runId: string, after: number, limit: number): WorkflowEventPage | null {
    return this.store.getRun(runId) ? this.store.listEventPage(runId, after, limit) : null;
  }

  llmCalls(runId: string, after: string | null, limit: number): WorkflowLlmCallPage | null {
    return this.store.getRun(runId) ? this.store.listLlmCallPage(runId, after, limit) : null;
  }

  /**
   * What the built-in Test Evidence Auditor's own telemetry adds up to, fleet-wide.
   *
   * Advisory and read-only. It reads events the engine already appended; it never re-runs a
   * Persona, never rewrites a verdict, and holds no state of its own, so a caller polling it
   * cannot perturb a run.
   */
  testEvidenceAudit(limit = TEST_EVIDENCE_AUDIT_SCAN_LIMIT): TestEvidenceAuditAggregate {
    const window = this.store.listEventsOfKind("test_evidence_audit", limit);
    return aggregateTestEvidenceAudit(window.rows, {
      scanLimit: limit,
      truncated: window.truncated,
    });
  }

  status(): WorkflowStatus {
    return {
      ...this.store.workflowStatusCounts(),
      orphanedEvidenceImages: this.orphanedEvidenceImages,
      lastRecoveryAt: this.lastRecoveryAt,
      lastRetentionAt: this.lastRetentionAt,
      lastRetentionError: this.lastRetentionError,
      lastRetentionCompacted: this.lastRetentionCompacted,
      lastRetentionDeleted: this.lastRetentionDeleted,
    };
  }

  exportRun(id: string, now = Date.now()): WorkflowExportEnvelope<WorkflowRunDetail> | null {
    const detail = this.store.runExportDetail(id);
    return detail
      ? { schemaVersion: 1, exportedAt: now, kind: "workflow_run", data: this.decorateRun(detail) }
      : null;
  }

  exportVersion(
    id: string,
    version: number,
    now = Date.now(),
  ): WorkflowExportEnvelope<WorkflowVersion> | null {
    const data = this.store.getWorkflowVersion(id, version);
    return data
      ? { schemaVersion: 1, exportedAt: now, kind: "workflow_version", data }
      : null;
  }

  run(id: string):
    | { kind: "found"; detail: WorkflowRunDetail }
    | { kind: "missing" | "corrupt" } {
    const result = this.store.runDetailResult(id);
    return result.kind === "found"
      ? { kind: "found", detail: this.decorateRun(result.detail) }
      : result;
  }

  private decorateRun(detail: WorkflowRunDetail): WorkflowRunDetail {
    const state = this.gateState(detail.run);
    if (!state) return detail;
    const inspection = state.prKey
      ? loadInspectorInspections().find((row) => row.key === state.prKey) ?? null
      : null;
    const cfg = getInspectorConfig();
    return {
      ...detail,
      inspectorGate: {
        state,
        inspection,
        findings: state.prKey ? loadInspectorComments(state.prKey) : [],
        inspector: {
          enabled: cfg.enabled,
          mode: cfg.mode,
          posture: state.prKey
            ? inspectorPosture(cfg, detail.binding.sessionCwd, detail.binding.sessionRepoRoot)
            : null,
        },
      },
    };
  }

  createBinding(input: CreateWorkflowBinding, now = Date.now()): WorkflowRuntimeMutation<WorkflowBinding> {
    const version = this.store.getWorkflowVersionById(input.workflowVersionId);
    if (!version) {
      return { ok: false, reason: "not_found", message: "No such immutable workflow version" };
    }
    const workflowBlock = this.bindingWorkflowBlock(version);
    if (workflowBlock) return workflowBlock;
    const triggerMode = input.triggerMode ?? version.bindingDefaults.triggerMode;
    const deliveryMode = input.deliveryMode ?? version.bindingDefaults.deliveryMode;
    const maxRepairRounds = input.maxRepairRounds ?? version.bindingDefaults.maxRepairRounds;
    const session = this.registry.getSession(input.sessionId);
    if (!session || session.state === "exited") {
      return { ok: false, reason: "session_unavailable", message: "The selected session is not live" };
    }
    // An active ensemble member owns its session until the ensemble finalizes; binding it manually
    // would race that. The guard answers only with a reason or null and never names the ensemble
    // store - the same one-way boundary the external path uses.
    const ineligible = this.options.canBindSessionToWorkflow?.(session.id);
    if (ineligible) return { ok: false, reason: "ineligible_session", message: ineligible };
    const prerequisite = this.bindingModeBlock(session, triggerMode, deliveryMode);
    if (prerequisite) return prerequisite;
    const noteKey = noteKeyFor(session);
    const current = this.store.activeBindingForNote(noteKey);
    if (current) {
      return {
        ok: false,
        reason: "conflict",
        message: "This conversation already has an active workflow binding",
        current,
      };
    }
    let created: WorkflowBinding;
    /*
     * This try covers the INSERT and nothing else. It exists to translate one specific SQLite
     * failure - the UNIQUE constraint on an active note key, lost to a concurrent caller - into
     * a typed conflict, and anything else inside it gets read through that lens.
     *
     * Publishing sits outside for exactly that reason. It runs after the row is durably
     * committed, so a throw from it is not a failed bind: caught here it would either be
     * mislabelled "this conversation already has an active workflow binding" (if the message
     * happened to contain UNIQUE) or rethrown raw, and either way the caller would be told the
     * bind failed while the binding exists - with a retry then hitting the very conflict the
     * response invented.
     */
    try {
      created = this.store.insertBinding({
        id: randomUUID(),
        workflowVersionId: input.workflowVersionId,
        noteKey,
        sessionId: session.id,
        sessionAgent: session.agent,
        sessionName: session.name,
        sessionCwd: session.cwd,
        sessionRepoRoot: session.repoRoot,
        triggerMode,
        deliveryMode,
        maxRepairRounds,
        now,
      });
    } catch (error) {
      if (String(error).includes("UNIQUE")) {
        return {
          ok: false,
          reason: "conflict",
          message: "This conversation already has an active workflow binding",
          current: this.store.activeBindingForNote(noteKey),
        };
      }
      throw error;
    }
    // Every arm lands here - the dispatch one included, since `bindDispatchedTaskWorkflow`
    // creates its binding through this method. Publishing HERE rather than at each caller is
    // what makes a dispatched session show its workflow from the moment it is armed, which for
    // the `foreman_complete` trigger is the entire working life of the session before any run
    // exists to speak for it. Unguarded, like every other publish site in this file: a stream
    // failure is worth surfacing, and it must not be dressed up as a constraint violation.
    this.publishBinding(created.id);
    return { ok: true, value: created };
  }

  /**
   * Every repository this conversation's turn should review, in attach order, as the binding
   * that reviews each one. One workflow run per entry.
   *
   * The shape of the answer is the whole design: concurrency lives HERE, at the binding
   * layer, and never inside a run. Each returned binding gets an ordinary single-repository
   * run whose adapter proofs, evidence identity and gate vocabulary are exactly today's.
   *
   * A SINGLE-REPO conversation - which is nearly all of them, and every conversation with no
   * task at all - returns `[anchor]` and nothing below this line runs. That is not an
   * optimisation; it is the guarantee that single-repo behaviour is byte-identical.
   *
   * What counts as changed comes from `@shared/task-repos.ts`, the one definition the
   * completion quorum also reads, so run creation and completion cannot disagree about which
   * repositories this task owes work for. The one judgement made here rather than there is
   * what to do with its third verdict: `unknown` means nothing has read that worktree's head
   * yet, and it is REVIEWED rather than skipped. The two consumers face opposite
   * irreversibility - completion holds on unknown because completing early ships work
   * unmerged, and run creation reviews on unknown because skipping ships work unreviewed - so
   * each takes the conservative arm of the same predicate.
   *
   * Nothing REVIEWABLE falls back to `[anchor]` rather than to no run at all, and there are
   * two ways to get there rather than one. The ordinary one is that nothing looks changed.
   * The other is that every changed repository turned out to be unreviewable - a repository
   * whose pull request is open but whose worktree has been reclaimed reads as changed and has
   * no checkout left to read evidence from. Each unreviewable repository is reported on its
   * own before that point, because "changed and cannot be reviewed" is a different fact from
   * "not changed" and absorbing it into this fallback is how the primary's untouched checkout
   * came to be reviewed in place of a repository that really had work.
   *
   * The fallback itself is deliberate either way: a turn that settled with nothing reviewable
   * is exactly when the review should still run - the completion boundary keeps an owner, the
   * `pull_request` action can still ask for the pull request the agent has not opened, and a
   * session that completes with no review anywhere is the failure this phase exists to
   * prevent.
   */
  private repoRunTargets(session: Session, anchor: WorkflowBinding): WorkflowBinding[] {
    // A sibling binding submitted directly reviews its own repository and nothing else. Only
    // the conversation's own binding fans out, so a manual resubmission of repo B's run can
    // never quietly start repo A's. Falsy reads as the session's own, the same rule
    // `workflowCheckoutPath` states: absent means the conversation's checkout.
    if (anchor.repoRoot) return [anchor];
    const task = this.registry.taskForSession(session.id, session.cwd);
    if (!task || task.extraRepos.length === 0) return [anchor];
    // Durable reads rather than the in-memory projection, and the same two the completion
    // quorum uses: the primary's pull request lives on the work-episode binding and each
    // secondary's on its own `work_episode_prs` row.
    const extraRepos = taskReposFor(task.id);
    const primaryPr = primaryRepoPrForTask(task.id);
    const reviewable = taskRepoStatuses({ ...task, extraRepos }, (ref) => ({
      prUrl: ref.role === "primary"
        ? primaryPr.prUrl
        : extraRepos[ref.position - 1]?.prUrl ?? null,
      headSha: this.registry.worktreeHead(ref.worktreePath),
    })).filter((status) => status.verdict !== "unchanged");
    const targets: WorkflowBinding[] = [];
    for (const { ref } of reviewable) {
      const binding = ref.role === "primary" ? anchor : this.ensureRepoBinding(anchor, ref);
      if (binding) {
        targets.push(binding);
        continue;
      }
      // A repository this task CHANGED that cannot be reviewed, which is not the same thing
      // as a repository that was not changed and must not be folded into it silently.
      //
      // It is reachable: `repoChangeVerdict` reads an open pull request as changed before it
      // looks at the worktree at all, and a worktree can be reclaimed while its pull request
      // is still open - `releasedTaskResources` nulls `worktree_path` and leaves the
      // `work_episode_prs` row alone. There is then genuinely nothing to review: evidence
      // capture reads a checkout, and this repository no longer has one.
      //
      // So it is REPORTED rather than absorbed. The alternative this replaced was worse than
      // useless - it fell through to reviewing the primary's untouched checkout, which is
      // both a review of a repository that did not change and no review of the one that did.
      console.error(
        `[workflow] cannot review ${ref.repoRoot} for task ${task.id}: `
        + "it has work on this task but no worktree is recorded for it",
      );
    }
    // The fallback, and now the ONLY reason for it: nothing on this task can be reviewed.
    // Either nothing looks changed, or the only changed repositories are ones whose checkouts
    // are gone. A turn that settled having apparently touched nothing is exactly when the
    // review should still run - the completion boundary keeps an owner, the `pull_request`
    // action can still ask for a pull request the agent has not opened, and a session that
    // completes with no review anywhere is the failure this phase exists to prevent.
    return targets.length > 0 ? targets : [anchor];
  }

  /**
   * The active binding that reviews one secondary repository of this conversation, created if
   * this is the first turn that changed it.
   *
   * Everything but the repository is cloned from the conversation's own binding, and each
   * clone matters. The immutable workflow VERSION, so sibling runs review against the same
   * published graph an operator or the dispatch chose. The trigger mode, so the Foreman
   * completion boundary claims all of them or none. The delivery mode, because delivery
   * consent is a property of the PANE - one session, one allowlisted cwd - and not of the
   * repository being read. And `maxRepairRounds`, which the run copies at creation, so each
   * repository then spends its own budget: a finding in repo A restarts A's graph alone.
   *
   * `sessionCwd`/`sessionRepoRoot` are the secondary's worktree and root rather than the
   * session's. That is what scopes evidence capture, check execution, the capture root and
   * the Inspector gate's adoption match to this repository without any of them knowing why.
   */
  private ensureRepoBinding(anchor: WorkflowBinding, ref: TaskRepoRef): WorkflowBinding | null {
    const existing = this.store.activeBindingForNoteRepo(anchor.noteKey, ref.repoRoot);
    if (existing) return existing;
    // No worktree means nothing to read evidence from. Skipped rather than bound to the
    // session's cwd, which would review the primary's changes twice under another repo's name.
    if (!ref.worktreePath || !anchor.sessionId) return null;
    try {
      const created = this.store.insertBinding({
        id: randomUUID(),
        workflowVersionId: anchor.workflowVersionId,
        noteKey: anchor.noteKey,
        sessionId: anchor.sessionId,
        sessionAgent: anchor.sessionAgent,
        sessionName: anchor.sessionName,
        sessionCwd: ref.worktreePath,
        sessionRepoRoot: ref.repoRoot,
        repoRoot: ref.repoRoot,
        triggerMode: anchor.triggerMode,
        deliveryMode: anchor.deliveryMode,
        maxRepairRounds: anchor.maxRepairRounds,
        now: Date.now(),
      });
      this.publishBinding(created.id);
      return created;
    } catch (error) {
      // Lost the insert to a concurrent trigger on the same conversation - the widened
      // active-binding index refusing exactly what it exists to refuse. Re-read rather than
      // fail: the sibling that won created the binding this call wanted.
      if (String(error).includes("UNIQUE")) {
        return this.store.activeBindingForNoteRepo(anchor.noteKey, ref.repoRoot);
      }
      throw error;
    }
  }

  updateBinding(
    id: string,
    input: UpdateWorkflowBinding,
    now = Date.now(),
  ): WorkflowRuntimeMutation<WorkflowBinding> {
    const binding = this.store.getBinding(id);
    if (!binding) return { ok: false, reason: "not_found", message: "No such workflow binding" };
    if (this.store.activeRunForBinding(id)) {
      return {
        ok: false,
        reason: "run_active",
        message: "Binding modes and round limits cannot change while a run is active",
        current: binding,
      };
    }
    const triggerMode = input.triggerMode ?? binding.triggerMode;
    const deliveryMode = input.deliveryMode ?? binding.deliveryMode;
    const state = input.state ?? binding.state;
    if (state === "active" && binding.state !== "active") {
      return {
        ok: false,
        reason: "conflict",
        message: "A paused or orphaned workflow binding must be explicitly reattached",
        current: binding,
      };
    }
    if (state === "active") {
      const session = binding.sessionId ? this.registry.getSession(binding.sessionId) : undefined;
      if (!session || session.state === "exited") {
        return { ok: false, reason: "session_unavailable", message: "The selected session is not live" };
      }
      const prerequisite = this.bindingModeBlock(session, triggerMode, deliveryMode);
      if (prerequisite) return prerequisite;
    }
    const updated = this.store.updateBinding(id, input, now);
    if (updated) this.publishBinding(updated.id);
    return updated
      ? { ok: true, value: updated }
      : { ok: false, reason: "not_found", message: "No such workflow binding" };
  }

  archiveBinding(id: string, now = Date.now()): WorkflowRuntimeMutation<WorkflowBinding> {
    const archived = this.store.archiveBindingAndCancel(id, now);
    if (archived?.cancelledRunId) this.publishRun(archived.cancelledRunId);
    if (archived) this.publishBinding(archived.binding.id);
    return archived
      ? { ok: true, value: archived.binding }
      : { ok: false, reason: "not_found", message: "No such workflow binding" };
  }

  /** Whether the selected current immutable version can consume visual evidence. */
  supportsImageEvidence(workflowId: string): boolean {
    const workflow = this.store.getWorkflow(workflowId);
    const version = workflow?.currentVersionId
      ? this.store.getWorkflowVersionById(workflow.currentVersionId)
      : null;
    return Boolean(version && versionSupportsWorkflowEvidence(version));
  }

  /**
   * Session-attributed intake used by the bundled Mission MCP tool.
   *
   * The ACTIVE BINDING is the authority, exactly as it is for the browser's own staging and
   * for reattached history - and not `tasks.workflow_id`. A workflow reaches a conversation
   * two ways: selected before dispatch, which writes that column and arms the binding through
   * `bindDispatchedTaskWorkflow`, or attached by an operator to a session that is already
   * running, which writes only the binding because dispatch-time intent is not a record of
   * what a live conversation is doing. Reading the column therefore refused every manually
   * attached conversation with `workflow_unbound` while its Persona repair round was asking
   * that same agent for evidence by name (see `testEvidenceRepairRecipe`) - a demand the
   * daemon then would not accept, and the reported defect.
   *
   * Dropping the column also drops the task-versus-binding workflow equality check with it,
   * which could only ever refuse a conversation whose real binding is the one about to
   * consume the evidence. Staging is keyed on `binding.noteKey`, so the binding is what the
   * evidence belongs to; agreeing with a task's earlier intent adds nothing to that.
   *
   * The task is still consulted, for the one thing it is authoritative about: which
   * checkouts this work was issued. `scoutRepoSlots` resolves the slot vocabulary from it, so
   * a multi-repo task keeps issuing `repo-02` and beyond. With no live task - a bound
   * conversation that is not a task's, or one whose task has already settled while its repair
   * rounds continue - the session's own checkout is the single slot, the same fallback the
   * other two staging paths use.
   */
  async stageAgentEvidence(
    sessionId: string,
    evidence: {
      images: readonly WorkflowAgentEvidenceLocator[];
      artifacts?: readonly WorkflowAgentTextEvidenceLocator[];
      commandOutputs?: readonly WorkflowAgentCommandEvidenceLocator[];
      coverage?: readonly WorkflowEvidenceCoverageClaim[];
    },
    now = Date.now(),
  ): Promise<WorkflowStagedEvidenceList> {
    const session = this.registry.getSession(sessionId);
    if (!session || session.state === "exited") {
      throw new WorkflowImageEvidenceError("session_unavailable", "The evidence session is not live", 404);
    }
    const binding = this.store.activeBindingForNote(noteKeyFor(session));
    const version = binding ? this.store.getWorkflowVersionById(binding.workflowVersionId) : null;
    if (!binding || !version || !versionSupportsWorkflowEvidence(version)) {
      throw new WorkflowImageEvidenceError(
        "workflow_unbound",
        "This session does not have an active Persona workflow binding",
        403,
      );
    }
    const activeTask = this.registry.taskForSession(session.id, session.cwd);
    const task = activeTask ?? {
      repoRoot: session.repoRoot ?? session.cwd ?? "",
      worktreePath: session.cwd,
      baseSha: null,
      extraRepos: [],
    };
    return stageAgentWorkflowEvidence({
      store: this.store,
      noteKey: binding.noteKey,
      task,
      fallbackRoot: session.cwd,
      images: evidence.images,
      artifacts: evidence.artifacts,
      commandOutputs: evidence.commandOutputs,
      coverage: evidence.coverage,
      now,
      episodeKey: resolvedSessionIntent(this.registry.getGoal(session.id))?.episodeKey ?? null,
    });
  }

  stagedEvidence(bindingId: string): WorkflowStagedEvidenceList | null {
    const binding = this.store.getBinding(bindingId);
    return binding ? this.store.listWorkflowEvidence(binding.noteKey) : null;
  }

  private async stageCoverageForLiveSession(
    session: Session,
    noteKey: string,
    coverage: readonly WorkflowEvidenceCoverageClaim[],
    now: number,
  ): Promise<WorkflowStagedEvidenceList> {
    const activeTask = this.registry.taskForSession(session.id, session.cwd);
    const task = activeTask ?? {
      repoRoot: session.repoRoot ?? session.cwd ?? "",
      worktreePath: session.cwd,
      baseSha: null,
      extraRepos: [],
    };
    return stageAgentWorkflowEvidence({
      store: this.store,
      noteKey,
      task,
      fallbackRoot: session.cwd,
      images: [],
      coverage,
      now,
      episodeKey: resolvedSessionIntent(this.registry.getGoal(session.id))?.episodeKey ?? null,
    });
  }

  async stageCoverage(
    bindingId: string,
    coverage: readonly WorkflowEvidenceCoverageClaim[],
    now = Date.now(),
  ): Promise<WorkflowStagedEvidenceList | null> {
    const binding = this.store.getBinding(bindingId);
    const session = binding?.sessionId ? this.registry.getSession(binding.sessionId) : undefined;
    if (!binding || binding.state !== "active" || !session || session.state === "exited") return null;
    return this.stageCoverageForLiveSession(session, binding.noteKey, coverage, now);
  }

  async stageCoverageForSession(
    sessionId: string,
    coverage: readonly WorkflowEvidenceCoverageClaim[],
    now = Date.now(),
  ): Promise<WorkflowStagedEvidenceList | null> {
    const session = this.registry.getSession(sessionId);
    if (!session || session.state === "exited") return null;
    return this.stageCoverageForLiveSession(session, noteKeyFor(session), coverage, now);
  }

  /**
   * Conversation-owned staging before a binding exists.
   *
   * The initial dashboard composer must inspect the same packet `createBinding` will attach
   * to this conversation. Resolving the note key from the live session here keeps that
   * ownership decision in the daemon and avoids making the browser invent a provisional
   * binding solely to list or remove evidence.
   */
  stagedEvidenceForSession(sessionId: string): WorkflowStagedEvidenceList | null {
    const session = this.registry.getSession(sessionId);
    return session && session.state !== "exited"
      ? this.store.listWorkflowEvidence(noteKeyFor(session))
      : null;
  }

  removeStagedEvidence(
    bindingId: string,
    clientItemId: string,
    now = Date.now(),
  ): WorkflowStagedEvidenceList | null {
    const binding = this.store.getBinding(bindingId);
    return binding
      ? this.store.removeWorkflowEvidence(binding.noteKey, clientItemId, now)
      : null;
  }

  removeStagedEvidenceForSession(
    sessionId: string,
    clientItemId: string,
    now = Date.now(),
  ): WorkflowStagedEvidenceList | null {
    const session = this.registry.getSession(sessionId);
    return session && session.state !== "exited"
      ? this.store.removeWorkflowEvidence(noteKeyFor(session), clientItemId, now)
      : null;
  }

  removeStagedCoverage(
    bindingId: string,
    clientCriterionId: string,
    now = Date.now(),
  ): WorkflowStagedEvidenceList | null {
    const binding = this.store.getBinding(bindingId);
    return binding
      ? this.store.removeWorkflowEvidenceCoverage(binding.noteKey, clientCriterionId, now)
      : null;
  }

  removeStagedCoverageForSession(
    sessionId: string,
    clientCriterionId: string,
    now = Date.now(),
  ): WorkflowStagedEvidenceList | null {
    const session = this.registry.getSession(sessionId);
    return session && session.state !== "exited"
      ? this.store.removeWorkflowEvidenceCoverage(noteKeyFor(session), clientCriterionId, now)
      : null;
  }

  reattachRetainedEvidence(
    bindingId: string,
    locator: WorkflowRetainedEvidenceLocator,
    now = Date.now(),
  ): WorkflowStagedEvidenceList {
    const binding = this.store.getBinding(bindingId);
    const session = binding?.sessionId ? this.registry.getSession(binding.sessionId) : undefined;
    const activeTask = session ? this.registry.taskForSession(session.id, session.cwd) : undefined;
    const image = this.store.submissionImageRecord(locator.imageId);
    const sourceSubmission = image ? this.store.getSubmission(image.submissionId) : null;
    const sourceRun = sourceSubmission ? this.store.getRun(sourceSubmission.runId) : null;
    const sourceBinding = sourceRun ? this.store.getBinding(sourceRun.bindingId) : null;
    const version = binding ? this.store.getWorkflowVersionById(binding.workflowVersionId) : null;
    if (
      !binding
      || binding.state !== "active"
      || !session
      || session.state === "exited"
      || !image
      || sourceBinding?.noteKey !== binding.noteKey
      || !version?.graph.nodes.some((node) => node.kind === "persona")
    ) {
      throw new WorkflowImageEvidenceError(
        "image_ownership",
        "Historical evidence does not belong to this workflow conversation",
        403,
      );
    }
    const task = activeTask ?? {
      repoRoot: session.repoRoot ?? session.cwd ?? "",
      worktreePath: session.cwd,
      baseSha: null,
      extraRepos: [],
    };
    return stageRetainedWorkflowEvidence({
      store: this.store,
      noteKey: binding.noteKey,
      task,
      fallbackRoot: session.cwd,
      locator,
      now,
      episodeKey: resolvedSessionIntent(this.registry.getGoal(session.id))?.episodeKey ?? null,
    });
  }

  private stageSubmitEvidence(
    bindingId: string,
    images: readonly WorkflowUploadEvidenceLocator[],
    now: number,
  ): void {
    if (images.length === 0) return;
    const binding = this.store.getBinding(bindingId);
    const session = binding?.sessionId ? this.registry.getSession(binding.sessionId) : undefined;
    const activeTask = session ? this.registry.taskForSession(session.id, session.cwd) : undefined;
    const version = binding ? this.store.getWorkflowVersionById(binding.workflowVersionId) : null;
    if (
      !binding
      || binding.state !== "active"
      || !session
      || session.state === "exited"
      || !version?.graph.nodes.some((node) => node.kind === "persona")
    ) {
      throw new WorkflowImageEvidenceError(
        "workflow_unbound",
        "Browser evidence requires a live Persona workflow binding",
        403,
      );
    }
    const task = activeTask ?? {
      repoRoot: session.repoRoot ?? session.cwd ?? "",
      worktreePath: session.cwd,
      baseSha: null,
      extraRepos: [],
    };
    stageUploadedWorkflowEvidenceSync({
      store: this.store,
      noteKey: binding.noteKey,
      task,
      fallbackRoot: session.cwd,
      images,
      now,
      episodeKey: resolvedSessionIntent(this.registry.getGoal(session.id))?.episodeKey ?? null,
    });
  }

  async submit(
    bindingId: string,
    input: SubmitWorkflow,
    now = Date.now(),
  ): Promise<WorkflowRuntimeMutation<WorkflowSubmitResult>> {
    this.stageSubmitEvidence(bindingId, input.evidence ?? [], now);
    const prepared = this.prepareSubmit(bindingId, input, now);
    if (!prepared.ok) return prepared;
    const { lead, siblings } = prepared.value;
    const value = { run: lead.run, submission: lead.submission };
    // BEFORE the lead's idempotency is consulted, and never gated on it. `idempotent` here is
    // the LEAD's own answer and says nothing about the siblings, which are only ever runs this
    // call freshly created - `prepareSubmit` skips an idempotent non-lead entirely. Returning
    // early on the lead therefore stranded a genuinely new sibling run in `capturing` for
    // ever: durable, published, gating its repository's pull request, and never captured.
    this.activateSiblingRuns(siblings);
    if (prepared.idempotent) return { ok: true, value, idempotent: true };
    // The lead is awaited, exactly as the one run always was, so a caller still gets an
    // activated run back. Siblings capture in the background: they are serialized behind the
    // lead by the conversation's capture lock anyway, and holding an operator's request open
    // for one git read per attached repository buys nothing.
    return this.captureAndActivate(lead.binding, lead.run, lead.submission);
  }

  /**
   * Make a manual submission durable, then let capture continue outside the request.
   *
   * The returned run is deliberately still `capturing`. The dashboard can open that run
   * immediately, and every later transition continues through the ordinary run event path.
   */
  enqueueSubmit(
    bindingId: string,
    input: SubmitWorkflow,
    now = Date.now(),
  ): WorkflowRuntimeMutation<WorkflowSubmitResult> {
    this.stageSubmitEvidence(bindingId, input.evidence ?? [], now);
    const prepared = this.prepareSubmit(bindingId, input, now);
    if (!prepared.ok) return prepared;
    const { lead, siblings } = prepared.value;
    const value = { run: lead.run, submission: lead.submission };
    // Before the lead's idempotency is consulted, for the reason `submit` gives above: these
    // are freshly created runs whatever the lead's own answer was.
    this.activateSiblingRuns(siblings);
    if (prepared.idempotent) return { ok: true, value, idempotent: true };
    this.trackBackgroundTask(
      this.captureAndActivate(lead.binding, lead.run, lead.submission).then(() => undefined),
    );
    return { ok: true, value };
  }

  /**
   * Capture and activate the runs of a turn's other repositories, off the request.
   *
   * Each one is tracked and each one's failure is contained: a capture that throws in repo B
   * must not take down repo A's review or the request that started both. The failure is loud
   * in the log and visible as a run that never left `capturing`, which is what a capture
   * failure has always looked like.
   */
  private activateSiblingRuns(siblings: readonly PreparedWorkflowRun[]): void {
    for (const sibling of siblings) {
      this.trackBackgroundTask(
        this.captureAndActivate(
          sibling.binding,
          sibling.run,
          sibling.submission,
          sibling.previousFingerprint,
        )
          .then(() => undefined)
          .catch((error) => {
            console.error(
              `[workflow] could not start the review of ${sibling.binding.repoRoot}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }),
      );
    }
  }

  /**
   * Make one run durable per repository this turn should review.
   *
   * The LEAD is the run this submission answers with, and it is the first repository in
   * attach order rather than always the primary: a multi-repo task whose primary is untouched
   * gets no primary run at all, so the caller is handed the run that does exist.
   *
   * A target whose binding already has an active run is SKIPPED rather than refused - that
   * repository is already under review, which is the answer this submission wanted. Only when
   * every target is already running is the whole submission refused, which for a single-repo
   * conversation is exactly today's `run_active`, from the same lookup, with the same run
   * attached.
   */
  private prepareSubmit(
    bindingId: string,
    input: SubmitWorkflow,
    now: number,
  ): WorkflowRuntimeMutation<{ lead: PreparedWorkflowRun; siblings: PreparedWorkflowRun[] }> {
    const binding = this.store.getBinding(bindingId);
    if (!binding) return { ok: false, reason: "not_found", message: "No such workflow binding" };
    if (binding.state !== "active") {
      return { ok: false, reason: "inactive_binding", message: "The workflow binding is not active" };
    }
    const key = manualWorkflowTriggerKey(binding.id, input.requestId);
    const evidenceGroupKey = `manual:${binding.noteKey}:${input.requestId}`;
    const existing = this.store.submissionByTrigger(key);
    if (existing) {
      const run = this.store.getRun(existing.runId);
      if (!run) return { ok: false, reason: "not_found", message: "The idempotent run is missing" };
      const group = this.store.listSubmissionsByEvidenceGroup(evidenceGroupKey)
        .flatMap((submission) => {
          const memberRun = this.store.getRun(submission.runId);
          const memberBinding = memberRun ? this.store.getBinding(memberRun.bindingId) : null;
          if (!memberRun || !memberBinding) return [];
          const resumed = this.resumeImageEvidenceCapture(memberBinding, memberRun, submission, now);
          return resumed ? [resumed] : [];
        });
      const resumedLead = group.find((item) => item.submission.id === existing.id);
      const siblings = group.filter((item) => item.submission.id !== existing.id);
      return resumedLead
        ? { ok: true, value: { lead: resumedLead, siblings } }
        : {
            ok: true,
            value: { lead: { binding, run, submission: existing }, siblings },
            idempotent: true,
          };
    }
    const session = binding.sessionId ? this.registry.getSession(binding.sessionId) : undefined;
    const targets = session && session.state !== "exited"
      ? this.repoRunTargets(session, binding)
      : [binding];
    const prepared: PreparedWorkflowRun[] = [];
    let alreadyRunning: WorkflowRun | null = null;
    let leadWasIdempotent = false;
    for (const target of targets) {
      const active = this.store.activeRunForBinding(target.id);
      if (active) {
        alreadyRunning ??= active;
        continue;
      }
      const targetKey = manualWorkflowTriggerKey(target.id, input.requestId);
      const created = this.store.createInitialSubmission(
        { id: randomUUID(), binding: target, triggerSource: "manual", triggerKey: targetKey, now },
        {
          id: randomUUID(),
          triggerSource: "manual",
          triggerKey: targetKey,
          evidenceGroupKey,
          context: {},
          evidence: {},
          now,
        },
      );
      if (created.idempotent) {
        // Lost the insert to a concurrent caller holding the same request id. Only the lead's
        // race is reportable - it is the run this answers with - and a sibling that lost is
        // already being captured by whoever won.
        if (prepared.length === 0) leadWasIdempotent = true;
        else continue;
      } else {
        this.publishRun(created.run.id);
      }
      prepared.push({ binding: target, run: created.run, submission: created.submission });
    }
    const [lead, ...siblings] = prepared;
    if (!lead) {
      return {
        ok: false,
        reason: "run_active",
        message: "This binding already has an active run",
        current: alreadyRunning,
      };
    }
    return leadWasIdempotent
      ? { ok: true, value: { lead, siblings }, idempotent: true }
      : { ok: true, value: { lead, siblings } };
  }

  /** Resume only the same failed immutable reservation, never a fresh staged set. */
  private resumeImageEvidenceCapture(
    binding: WorkflowBinding,
    run: WorkflowRun,
    submission: WorkflowSubmission,
    now: number,
  ): PreparedWorkflowRun | null {
    const resumed = this.store.resumeCapture(
      run.id,
      submission.id,
      IMAGE_CAPTURE_RESUMABLE_PHASES,
      now,
    );
    if (!resumed) return null;
    const previousFingerprint = this.store.listSubmissions(run.id)
      .filter((candidate) =>
        candidate.round < submission.round
        || (candidate.round === submission.round && candidate.segment < submission.segment))
      .at(-1)?.evidenceFingerprint;
    return {
      binding,
      run: resumed.run,
      submission: resumed.submission,
      previousFingerprint,
    };
  }

  /**
   * Run the built-in review from an operator's explicit Ship it action.
   *
   * This is deliberately separate from `claimCompletion`: that path is Foreman's
   * verified completion boundary. A click is a manual submission. It reuses an existing
   * built-in binding, creates a Manual binding when the conversation has none, and refuses
   * to replace a different workflow the operator already selected.
   */
  async startBuiltinReview(
    sessionId: string,
    input: SubmitWorkflow,
    now = Date.now(),
  ): Promise<WorkflowRuntimeMutation<WorkflowSubmitResult>> {
    const session = this.registry.getSession(sessionId);
    if (!session || session.state === "exited") {
      return { ok: false, reason: "session_unavailable", message: "The selected session is not live" };
    }
    let binding = this.store.activeBindingForNote(noteKeyFor(session));
    if (binding) {
      const version = this.store.getWorkflowVersionById(binding.workflowVersionId);
      if (version?.workflowId !== NO_MISTAKES_REVIEW_WORKFLOW_ID) {
        return {
          ok: false,
          reason: "conflict",
          message: "This conversation already has a different workflow binding. Run it from Workflows.",
          current: binding,
        };
      }
      const active = this.store.activeRunForBinding(binding.id);
      const submission = active ? this.store.latestSubmission(active.id) : null;
      if (active && submission) {
        const resumed = this.resumeImageEvidenceCapture(binding, active, submission, now);
        if (resumed) {
          return this.captureAndActivate(
            resumed.binding,
            resumed.run,
            resumed.submission,
            resumed.previousFingerprint,
          );
        }
        return { ok: true, value: { run: active, submission }, idempotent: true };
      }
      return this.submit(binding.id, input, now);
    }

    const workflow = this.get(NO_MISTAKES_REVIEW_WORKFLOW_ID);
    const versionId = workflow?.workflow.currentVersionId ?? null;
    if (!workflow || workflow.workflow.archivedAt !== null || !versionId) {
      return { ok: false, reason: "not_found", message: "The built-in No-Mistakes Review workflow is unavailable" };
    }
    const version = this.store.getWorkflowVersionById(versionId);
    if (!version) {
      return { ok: false, reason: "not_found", message: "The built-in No-Mistakes Review workflow is unavailable" };
    }
    const workflowPolicy = getWorkflowPolicy();
    const deliveryMode = workflowPolicy.liveEnabled
      && repoAllowlisted(session.cwd, session.repoRoot, workflowPolicy.repoAllowlist)
      ? "live"
      : "preview";
    const created = this.createBinding({
      workflowVersionId: version.id,
      sessionId: session.id,
      triggerMode: "manual",
      deliveryMode,
      maxRepairRounds: version.bindingDefaults.maxRepairRounds,
    }, now);
    if (!created.ok) return created;
    binding = created.value;
    return this.submit(binding.id, input, now);
  }

  async resubmit(
    runId: string,
    input: ResubmitWorkflow,
    now = Date.now(),
  ): Promise<WorkflowRuntimeMutation<WorkflowSubmitResult>> {
    const run = this.store.getRun(runId);
    if (!run) return { ok: false, reason: "not_found", message: "No such workflow run" };
    const activeGate = this.gateState(run);
    const activeGateSubmission = activeGate ? this.store.latestSubmission(run.id) : null;
    if (
      activeGate
      && (
        run.status === "waiting_for_new_head"
        || activeGateSubmission?.mode === "inspector_only"
      )
    ) {
      return {
        ok: false,
        reason: "run_not_waiting",
        message: "GitHub Inspector-only repair resumes on a new head or through the confirmed full restart action",
      };
    }
    const binding = this.store.getBinding(run.bindingId);
    if (!binding) return { ok: false, reason: "not_found", message: "The run binding is missing" };
    if (externallySourced(run)) {
      return { ok: false, reason: "unsupported_mode", message: EXTERNAL_MANUAL_ROUND_REFUSAL };
    }
    this.stageSubmitEvidence(binding.id, input.evidence ?? [], now);
    const key = manualWorkflowTriggerKey(binding.id, input.requestId);
    const existing = this.store.submissionByTrigger(key);
    if (existing) {
      const existingRun = this.store.getRun(existing.runId) ?? run;
      const resumed = this.resumeImageEvidenceCapture(binding, existingRun, existing, now);
      if (resumed) {
        return this.captureAndActivate(
          resumed.binding,
          resumed.run,
          resumed.submission,
          resumed.previousFingerprint,
          input.resubmitUnchanged,
        );
      }
      if (
        existing.status === "failed"
        && existingRun.currentPhase === "unchanged_evidence"
      ) {
        if (
          input.resubmitUnchanged
          && binding.state === "active"
          && existingRun.status === "waiting_for_session"
        ) {
          const revived = this.store.reviveFailedSubmission(
            existing.id,
            existingRun.id,
            "unchanged_evidence",
            now,
          );
          if (!revived) {
            return {
              ok: false,
              reason: "conflict",
              message: "The failed submission changed before it could be revived",
              current: this.store.getSubmission(existing.id),
            };
          }
          this.store.appendEvent(existingRun.id, "resubmit_unchanged_confirmed", {
            submissionId: existing.id,
            triggerKey: existing.triggerKey,
          }, now);
          this.engine.activateSubmission(existing.id);
          const activatedRun = this.store.getRun(existingRun.id) ?? existingRun;
          this.publishRun(activatedRun.id);
          return {
            ok: true,
            value: {
              run: activatedRun,
              submission: this.store.getSubmission(existing.id) ?? existing,
            },
            idempotent: true,
          };
        }
        return {
          ok: false,
          reason: "unchanged_evidence",
          message: "The evidence snapshot is unchanged; confirm this same resubmission to continue",
          current: { run: existingRun, submission: existing },
        };
      }
      return {
        ok: true,
        value: { run: existingRun, submission: existing },
        idempotent: true,
      };
    }
    if (!["waiting_for_session", "blocked"].includes(run.status) || binding.state !== "active") {
      return {
        ok: false,
        reason: "run_not_waiting",
        message: "A fresh resubmission is available only for an attached waiting or blocked run",
      };
    }
    const latest = this.store.latestSubmission(run.id);
    if (!latest) return { ok: false, reason: "not_found", message: "The run has no submission" };
    if (latest.round > run.maxRepairRounds) {
      this.store.blockForRoundLimit(run, now);
      this.publishRun(run.id);
      return {
        ok: false,
        reason: "round_limit",
        message: "The workflow has exhausted its configured repair rounds",
      };
    }
    /*
     * The same repository read the resumption observer gates on, asked here for the first
     * time - and asked as a QUESTION rather than as a refusal.
     *
     * The observer has always declined to open a round whose repository is byte-identical
     * to the failed one, on the grounds that a repair which changed no code is not a
     * repair. This path never asked, so the button could spend a round proving what two
     * git reads already knew, and the capture-time fingerprint could not catch it: that
     * fingerprint includes the transcript anchor, and typing the repair packet into the
     * pane is itself a transcript write, so it has moved before the operator can click.
     *
     * The refusal is not the observer's, though, and must not become it. A human sometimes
     * has evidence the repository cannot hold - a manual verification recorded in the
     * transcript is the documented case - so this states what it found, spends nothing, and
     * leaves the same "review it anyway" move that answers `unchanged_evidence` standing
     * one click away. `resubmitUnchanged` is that click, which is why it skips this
     * entirely rather than getting a flag of its own to keep in step.
     */
    if (!input.resubmitUnchanged) {
      const probe = await this.probeRepository(binding).catch(() => null);
      const unchanged = probe && this.repositoryUnchangedSince(probe, binding, latest);
      if (unchanged) {
        this.store.setRunState(
          run.id,
          run.status,
          WORKFLOW_UNCHANGED_REPOSITORY_PHASE,
          { round: latest.round, evidenceFingerprint: latest.evidenceFingerprint },
          now,
        );
        this.store.appendEvent(run.id, "resubmit_refused_unchanged_repository", {
          round: latest.round,
          evidenceFingerprint: latest.evidenceFingerprint,
        }, now);
        this.publishRun(run.id);
        return {
          ok: false,
          reason: "unchanged_repository",
          message: `The repository has not changed since round ${latest.round};`
            + " confirm an unchanged resubmission to review it anyway",
        };
      }
    }
    const created = this.store.createRepairSubmission({
      id: randomUUID(),
      runId: run.id,
      round: latest.round + 1,
      triggerSource: "manual",
      triggerKey: key,
      evidenceGroupKey: `manual:${binding.noteKey}:${input.requestId}`,
      context: {},
      evidence: {},
      now,
    });
    if (created.idempotent) {
      return { ok: true, value: { run: created.run, submission: created.submission }, idempotent: true };
    }
    this.publishRun(run.id);
    return this.captureAndActivate(
      binding,
      created.run,
      created.submission,
      latest.evidenceFingerprint,
      input.resubmitUnchanged,
    );
  }

  async retryEvidenceReadiness(
    runId: string,
    submissionId: string,
    requestId: string,
    now = Date.now(),
  ): Promise<WorkflowRuntimeMutation<WorkflowSubmitResult>> {
    const run = this.store.getRun(runId);
    const binding = run ? this.store.getBinding(run.bindingId) : null;
    if (!run || !binding) return { ok: false, reason: "not_found", message: "No such workflow run" };
    const reserved = this.store.reserveEvidenceReadinessRefinement({
      id: randomUUID(),
      runId,
      waitingSubmissionId: submissionId,
      triggerKey: `manual:${binding.id}:evidence-preflight:${requestId}`,
      manualRetry: true,
      now,
    });
    if (!reserved.ok) {
      return {
        ok: false,
        reason: reserved.reason === "no_change" ? "unchanged_evidence" : "conflict",
        message: reserved.reason === "delivery_in_flight"
          ? "The evidence-readiness packet is still being delivered"
          : reserved.reason === "request_conflict"
            ? "That request id already names a different evidence refinement"
            : reserved.reason === "no_change"
              ? "Stage new evidence before retrying evidence preflight"
              : "The submission is no longer waiting for evidence readiness",
      };
    }
    const currentRun = this.store.getRun(runId) ?? run;
    if (reserved.idempotent && reserved.submission.status !== "capturing") {
      return { ok: true, value: { run: currentRun, submission: reserved.submission }, idempotent: true };
    }
    this.publishRun(runId);
    const captured = await this.captureAndActivate(
      binding,
      currentRun,
      reserved.submission,
      undefined,
      true,
    );
    return captured.ok && reserved.idempotent ? { ...captured, idempotent: true } : captured;
  }

  overrideEvidenceReadiness(
    runId: string,
    submissionId: string,
    requestId: string,
    reason: string,
    acknowledgedRisk: true,
    now = Date.now(),
  ) {
    const run = this.store.getRun(runId);
    const binding = run ? this.store.getBinding(run.bindingId) : null;
    const recorded = this.store.overrideEvidenceReadiness({
      id: randomUUID(),
      runId,
      submissionId,
      requestId: evidenceReadinessOverrideRequestKey(runId, requestId),
      reason,
      acknowledgedRisk,
      now,
    });
    if (!recorded.ok) return recorded;
    const durableRun = this.store.getRun(runId);
    const shouldActivate = !recorded.idempotent
      || (durableRun?.status === "running" && durableRun.currentPhase === "activating");
    if (!shouldActivate) return recorded;
    // The override row commits before graph activation. A retry while the durable handoff is
    // still in `activating` repairs an interruption, but a later replay must preserve whatever
    // state Persona or Session action processing has reached.
    this.activateEvidenceReadinessOverride(
      runId,
      submissionId,
      binding,
      recorded.override,
      now,
    );
    return recorded;
  }

  private activateEvidenceReadinessOverride(
    runId: string,
    submissionId: string,
    binding: WorkflowBinding | null,
    override: WorkflowSubmissionReadinessOverride,
    now: number,
  ): void {
    this.store.appendEvent(runId, "evidence_readiness_overridden", {
      submissionId,
      requestId: override.requestId,
      reason: override.reason,
      acknowledgedRisk: override.acknowledgedRisk,
    }, now, `evidence-readiness-override:${override.id}`);
    this.engine.activateSubmission(submissionId);
    this.publishRun(runId);
    if (binding) this.scheduleQueuedDeliveries(binding.noteKey);
  }

  reattach(
    bindingId: string,
    sessionId: string,
    now = Date.now(),
  ): WorkflowRuntimeMutation<WorkflowBinding> {
    const binding = this.store.getBinding(bindingId);
    if (!binding) return { ok: false, reason: "not_found", message: "No such workflow binding" };
    const version = this.store.getWorkflowVersionById(binding.workflowVersionId);
    if (!version) {
      return { ok: false, reason: "not_found", message: "No such immutable workflow version" };
    }
    const workflowBlock = this.bindingWorkflowBlock(version, "reattached");
    if (workflowBlock) return workflowBlock;
    const session = this.registry.getSession(sessionId);
    if (!session || session.state === "exited") {
      return { ok: false, reason: "session_unavailable", message: "The selected session is not live" };
    }
    const compatible =
      (!binding.sessionAgent || binding.sessionAgent === session.agent) &&
      (binding.sessionCwd === session.cwd) &&
      (binding.sessionRepoRoot === session.repoRoot);
    if (!compatible) {
      return {
        ok: false,
        reason: "incompatible_session",
        message: "Reattach requires the same agent, checkout path, and repository",
      };
    }
    const noteKey = noteKeyFor(session);
    const conflict = this.store.activeBindingForNote(noteKey);
    if (conflict && conflict.id !== binding.id) {
      return {
        ok: false,
        reason: "conflict",
        message: "The target conversation already has an active workflow binding",
        current: conflict,
      };
    }
    const updated = this.store.reattachBinding(binding.id, {
      noteKey,
      sessionId: session.id,
      sessionAgent: session.agent,
      sessionName: session.name,
      sessionCwd: session.cwd,
      sessionRepoRoot: session.repoRoot,
    }, now);
    if (!updated) return { ok: false, reason: "not_found", message: "No such workflow binding" };
    this.publishBinding(updated.id);
    const active = this.store.activeRunForBinding(binding.id);
    if (active) {
      for (const delivery of this.store.listDeliveries(active.id)) {
        if (delivery.state !== "prepared" && delivery.state !== "refused") continue;
        const held = this.store.requireDeliveryRetryConfirmation(delivery.id, now);
        if (held) {
          this.store.appendEvent(active.id, "delivery_retry_confirmation_required", {
            deliveryId: delivery.id,
            priorSessionId: delivery.sessionId,
            priorNoteKey: delivery.noteKey,
            sessionId: session.id,
            noteKey,
          }, now);
        }
      }
      this.store.setRunState(active.id, "waiting_for_session", "reattached_resubmit_required", {
        priorNoteKey: binding.noteKey,
        noteKey,
      }, now);
      this.store.appendEvent(active.id, "binding_reattached", {
        priorNoteKey: binding.noteKey,
        noteKey,
        sessionId: session.id,
      }, now);
      this.publishRun(active.id);
    }
    return { ok: true, value: updated };
  }

  retry(
    runId: string,
    input: RetryWorkflowRun,
    now = Date.now(),
  ): WorkflowRuntimeMutation<WorkflowSubmitResult> {
    const run = this.store.getRun(runId);
    if (!run) return { ok: false, reason: "not_found", message: "No such workflow run" };
    const existingEvent = this.store.listEvents(run.id).find((event) =>
      event.kind === "manual_infrastructure_retry" &&
      event.payload &&
      !Array.isArray(event.payload) &&
      typeof event.payload === "object" &&
      event.payload.requestId === input.requestId);
    const submission = this.store.latestSubmission(run.id);
    if (!submission) return { ok: false, reason: "not_found", message: "The run has no submission" };
    if (existingEvent) {
      return { ok: true, value: { run, submission }, idempotent: true };
    }
    const attempts = this.store.listAttempts(submission.id);
    const failed = input.nodeAttemptId
      ? attempts.find((attempt) => attempt.id === input.nodeAttemptId)
      : [...attempts].reverse().find((attempt) => attempt.state === "error");
    if (
      run.status !== "blocked" ||
      run.currentPhase !== "infrastructure_error" ||
      !failed ||
      failed.state !== "error"
    ) {
      return {
        ok: false,
        reason: "not_infrastructure_failure",
        message: "Manual retry is available only for an exhausted infrastructure attempt",
      };
    }
    const latestFailed = failed
      ? this.store.latestAttemptForNode(submission.id, failed.nodeId)
      : null;
    if (!latestFailed || latestFailed.state !== "error") {
      return {
        ok: false,
        reason: "not_infrastructure_failure",
        message: "The selected Persona no longer has an infrastructure failure to retry",
      };
    }
    const retried = this.store.manualInfrastructureRetry(
      run.id,
      submission.id,
      latestFailed,
      input.requestId,
      randomUUID(),
      now,
    );
    this.publishRun(run.id);
    this.engine.activateSubmission(submission.id);
    return {
      ok: true,
      value: { run: retried.run, submission: retried.submission },
      idempotent: retried.idempotent,
    };
  }

  cancel(runId: string, requestId: string, now = Date.now()): WorkflowRuntimeMutation<WorkflowRun> {
    const run = this.store.getRun(runId);
    if (!run) return { ok: false, reason: "not_found", message: "No such workflow run" };
    const cancelled = this.store.cancelRun(run.id, `cancelled:${requestId}`, now) ?? run;
    this.publishRun(run.id);
    return { ok: true, value: cancelled, idempotent: run.status === "cancelled" };
  }

  /**
   * Toggle the operator-disabled (auto-pass) flag on verdict nodes of one run.
   *
   * Scoped strictly to this run: the set lives on the run row, and the pinned immutable
   * version is only READ, to refuse ids that are not Persona or Check nodes there. The
   * engine consumes the set at attempt claim time, so the toggle changes rounds that have
   * not reached the node yet - the current one included - and never rewrites an outcome
   * that already happened. One audit event is appended per node so the timeline names
   * each gate the operator switched, not a count.
   */
  setNodesDisabled(
    runId: string,
    input: SetWorkflowNodesDisabled,
    now = Date.now(),
  ): WorkflowRuntimeMutation<WorkflowRun> {
    const run = this.store.getRun(runId);
    if (!run) return { ok: false, reason: "not_found", message: "No such workflow run" };
    const replay = this.store.listEvents(run.id).some((event) =>
      (event.kind === "node_disabled" || event.kind === "node_enabled")
      && event.payload
      && !Array.isArray(event.payload)
      && typeof event.payload === "object"
      && event.payload.requestId === input.requestId);
    if (replay) return { ok: true, value: run, idempotent: true };
    if (["completed", "cancelled", "failed"].includes(run.status)) {
      return {
        ok: false,
        reason: "conflict",
        message: "This run has finished, so disabling a reviewer or check can no longer change it",
      };
    }
    const version = this.store.getWorkflowVersionById(run.workflowVersionId);
    if (!version) {
      return {
        ok: false,
        reason: "not_found",
        message: "The immutable workflow version is missing or corrupt",
      };
    }
    const verdictNodes = new Map(
      version.graph.nodes.filter(isVerdictNode).map((node) => [node.id, node]),
    );
    const unknown = input.nodeIds.find((nodeId) => !verdictNodes.has(nodeId));
    if (unknown !== undefined) {
      return {
        ok: false,
        reason: "not_found",
        message: "Only a Persona or Check node of this run's pinned workflow version can be disabled",
      };
    }
    // The schema refuses duplicates, and this dedupes again anyway: the list below drives
    // one audit event per named gate, so a repeated id surviving any future schema change
    // would put the same toggle on the timeline twice.
    const requested = [...new Set(input.nodeIds)];
    const next = new Set(run.disabledNodeIds ?? []);
    for (const nodeId of requested) {
      if (input.disabled) next.add(nodeId);
      else next.delete(nodeId);
    }
    // Persisted in the graph's own node order so the stored set is deterministic and two
    // toggles that produce the same membership produce the same bytes. The audit events
    // ride the store's transaction, so a toggle and its timeline lines commit together.
    const updated = this.store.setRunDisabledNodes(
      run.id,
      version.graph.nodes.filter(isVerdictNode).map((node) => node.id)
        .filter((nodeId) => next.has(nodeId)),
      requested.map((nodeId) => ({
        kind: input.disabled ? "node_disabled" : "node_enabled",
        payload: {
          nodeId,
          persona: verdictAuthor(verdictNodes.get(nodeId)!),
          requestId: input.requestId,
        },
      })),
      now,
    );
    // The guarded UPDATE, not the status read above, decides the terminal race: a run
    // that finished between the two refuses the write, and reporting success anyway
    // would hand the operator a toggle that never happened.
    if (!updated) {
      return {
        ok: false,
        reason: "conflict",
        message: "This run finished before the toggle applied, so disabling a reviewer or check can no longer change it",
      };
    }
    this.publishRun(run.id);
    // A disabled node whose attempt is already queued auto-passes at claim time; wake the
    // engine so that claim happens now rather than on the next scheduled pump.
    this.engine.wake();
    return { ok: true, value: updated };
  }

  /** Persist highest-priority operator feedback for one Persona through later run rounds. */
  setPersonaDirective(
    runId: string,
    input: SetWorkflowPersonaDirective,
    now = Date.now(),
  ): WorkflowRuntimeMutation<{ run: WorkflowRun; directive: WorkflowPersonaDirective | null }> {
    const run = this.store.getRun(runId);
    if (!run) return { ok: false, reason: "not_found", message: "No such workflow run" };
    const replay = this.store.listEvents(run.id).some((event) =>
      event.kind === "persona_directive_set"
      && event.payload
      && !Array.isArray(event.payload)
      && typeof event.payload === "object"
      && event.payload.requestId === input.requestId);
    if (replay) {
      return {
        ok: true,
        value: {
          run,
          directive: (run.personaDirectives ?? []).find((item) => item.nodeId === input.nodeId) ?? null,
        },
        idempotent: true,
      };
    }
    if (["completed", "cancelled", "failed"].includes(run.status)) {
      return {
        ok: false,
        reason: "conflict",
        message: "This run has finished, so its Persona feedback can no longer change",
      };
    }
    const version = this.store.getWorkflowVersionById(run.workflowVersionId);
    const node = version?.graph.nodes.find((candidate) => candidate.id === input.nodeId);
    if (!version || !node || node.kind !== "persona") {
      return {
        ok: false,
        reason: "not_found",
        message: "Feedback can target only a Persona node in this run's pinned workflow version",
      };
    }
    const updated = this.store.setRunPersonaDirective(
      run.id,
      node.id,
      input.feedback,
      {
        kind: "persona_directive_set",
        payload: { nodeId: node.id, persona: node.persona.name, requestId: input.requestId },
      },
      now,
    );
    if (!updated) {
      return {
        ok: false,
        reason: "conflict",
        message: "This run finished before the Persona feedback was saved",
      };
    }
    this.publishRun(run.id);
    return { ok: true, value: updated };
  }

  /** Stop applying active feedback without changing attempts that already claimed it. */
  removePersonaDirective(
    runId: string,
    input: RemoveWorkflowPersonaDirective,
    now = Date.now(),
  ): WorkflowRuntimeMutation<{ run: WorkflowRun; directive: null }> {
    const run = this.store.getRun(runId);
    if (!run) return { ok: false, reason: "not_found", message: "No such workflow run" };
    const replay = this.store.listEvents(run.id).some((event) =>
      event.kind === "persona_directive_removed"
      && event.payload
      && !Array.isArray(event.payload)
      && typeof event.payload === "object"
      && event.payload.requestId === input.requestId);
    if (replay) return { ok: true, value: { run, directive: null }, idempotent: true };
    if (["completed", "cancelled", "failed"].includes(run.status)) {
      return {
        ok: false,
        reason: "conflict",
        message: "This run has finished, so its Persona feedback can no longer change",
      };
    }
    const version = this.store.getWorkflowVersionById(run.workflowVersionId);
    const node = version?.graph.nodes.find((candidate) => candidate.id === input.nodeId);
    if (!version || !node || node.kind !== "persona") {
      return {
        ok: false,
        reason: "not_found",
        message: "Feedback can target only a Persona node in this run's pinned workflow version",
      };
    }
    const updated = this.store.removeRunPersonaDirective(
      run.id,
      node.id,
      {
        kind: "persona_directive_removed",
        payload: { nodeId: node.id, persona: node.persona.name, requestId: input.requestId },
      },
      now,
    );
    if (!updated) {
      return {
        ok: false,
        reason: "conflict",
        message: "This run finished before the Persona feedback was removed",
      };
    }
    this.publishRun(run.id);
    return { ok: true, value: { run: updated.run, directive: null }, idempotent: !updated.removed };
  }

  /**
   * The pull request one binding's gate is looking for, before it has pinned one.
   *
   * A HINT, never proof - `matchesUnpinnedGate` and `inspector_prs` decide adoption, and this
   * only says which url to ask about. But which url is exactly what a session with several
   * reviews cannot answer with one scalar.
   *
   * The conversation's own binding reads `Session.prUrl`, byte-for-byte the expression that
   * was inline at all four gate sites before this existed. It is the current branch's pull
   * request, which for a single-repo session is the only one there is.
   *
   * A binding reviewing a SECONDARY repository cannot use it: `Session.prUrl` follows the
   * session's own checkout, so a secondary run reading it would pin - and then veto - the
   * primary repository's pull request, which is the sibling-veto adopted decision 4 forbids.
   * It reads the adoption ledger instead, filtered to this session and this repository, which
   * is the same durable provenance `matchesUnpinnedGate` then re-checks. Newest adoption
   * wins, matching "the current branch's pull request" as closely as a repository this
   * session is not standing in allows.
   */
  private gateCandidateUrl(
    binding: WorkflowBinding,
    session: Session | undefined,
  ): string | null {
    if (!binding.repoRoot) {
      return session?.state !== "exited" ? session?.prUrl ?? null : null;
    }
    if (!binding.sessionId || !binding.sessionRepoRoot) return null;
    let newest: { url: string; adoptedAt: number } | null = null;
    for (const pr of loadOpenInspectorPrs()) {
      if (pr.sessionId !== binding.sessionId) continue;
      if (pr.repoRoot !== binding.sessionRepoRoot) continue;
      if (!newest || pr.adoptedAt > newest.adoptedAt) newest = { url: pr.url, adoptedAt: pr.adoptedAt };
    }
    return newest?.url ?? null;
  }

  /**
   * Claim a successful Persona End for the immutable Inspector completion policy.
   * Session PR state is a lookup hint only; adoption is proved exclusively by inspector_prs.
   */
  private enterInspectorGate(submissionId: string, now = Date.now()): boolean {
    const submission = this.store.getSubmission(submissionId);
    const run = submission ? this.store.getRun(submission.runId) : null;
    const binding = run ? this.store.getBinding(run.bindingId) : null;
    const version = run ? this.store.getWorkflowVersionById(run.workflowVersionId) : null;
    if (!submission || !run || !binding || version?.completionPolicy.kind !== "inspector") return false;
    const context = WorkflowContextSnapshotSchema.safeParse(submission.context);
    if (!context.success) {
      this.store.setRunState(run.id, "blocked", "inspector_gate_context_invalid", {
        error: "The successful submission has no valid immutable context snapshot",
      }, now);
      this.publishRun(run.id);
      return true;
    }
    const session = binding.sessionId ? this.registry.getSession(binding.sessionId) : undefined;
    const candidateUrl = this.gateCandidateUrl(binding, session);
    const candidate = candidateUrl ? parsePrUrl(candidateUrl) : null;
    const adopted = candidate ? getInspectorPr(candidate.key) : null;
    const cfg = getInspectorConfig();
    const waitReason: WorkflowInspectorGateState["waitReason"] = !candidate
      ? "missing_pr"
      : !adopted
        ? "unadopted_pr"
        : !cfg.enabled
          ? "inspector_disabled"
          : "awaiting_fresh_observation";
    const state: WorkflowInspectorGateState = {
      prKey: adopted?.key ?? null,
      prUrl: adopted?.url ?? candidateUrl,
      targetHeadSha: null,
      failedHeadSha: null,
      enteredAt: now,
      lastObservedAt: null,
      observedHeadSha: null,
      reviewPosture: null,
      waitReason,
      findingFingerprints: [],
    };
    const entered = this.store.enterInspectorGate({
      runId: run.id,
      submissionId,
      headSha: context.data.evidence.headSha,
      status: waitReason === "inspector_disabled"
        ? "blocked"
        : waitReason === "missing_pr" || waitReason === "unadopted_pr"
          ? "waiting_for_pr"
          : "waiting_for_inspector",
      phase: `inspector_${waitReason}`,
      state,
      now,
    });
    if (entered) {
      this.publishRun(run.id);
      if (
        waitReason === "missing_pr"
        && version.completionPolicy.missingPrAction === "prepare_pr"
        && binding.sessionId
      ) {
        // Automatic PR preparation is Live-only, and stays that way: preparing a pull request
        // is done by TYPING the pull-request skill into the agent's pane, which is exactly the
        // terminal write Preview exists to withhold. There is no Preview-shaped version of it -
        // a "preview" of a handoff is a packet nobody sent.
        //
        // What changed is that the skip is now RECORDED. Silently doing nothing left a run
        // sitting in `waiting_for_pr` with a published policy that says `prepare_pr` and no
        // trace of why it had not, which reads as a stuck daemon rather than as the consent
        // boundary working. The operator's remedy is a real one - switch the binding to Live,
        // or click Prepare PR - so run detail has to be able to say it.
        if (binding.deliveryMode === "live") {
          this.scheduleAutomaticPr(run.id, submission.id, now);
        } else {
          this.store.appendEvent(run.id, "pr_handoff_automatic_deferred", {
            submissionId: submission.id,
            reason: "preview_delivery",
            message:
              "This binding delivers in Preview, which never types into the session, "
              + "so the pull-request handoff was not sent. Switch it to Live or prepare the "
              + "pull request yourself.",
          }, now);
          this.publishRun(run.id);
        }
      }
    }
    return true;
  }

  /**
   * Shipping may only be vetoed by active Inspector-gated workflow ownership.
   *
   * Returns WHICH veto rather than whether there is one, because a gate that ran out of
   * repair rounds never clears itself and telling the operator to wait for it was the
   * whole defect - see `WorkflowGateStanding`. The veto itself is unchanged: every run
   * that vetoed before still vetoes, `blocked` included and deliberately (see
   * `WORKFLOW_RUN_TERMINAL_STATUSES`). Only the reported reason got more specific.
   *
   * A run that gave up outranks nothing: when two bindings own the same key and one is
   * still reviewing, `pending` wins, because something really is still working on it and
   * "wait" remains the honest instruction.
   */
  mergeGate(prKey: string): WorkflowGateStanding {
    const adopted = getInspectorPr(prKey);
    let standing: WorkflowGateStanding = "none";
    const owns = (run: WorkflowRun): void => {
      if (standing === "pending") return;
      const round = this.store.latestSubmission(run.id)?.round ?? 0;
      standing = workflowRunGaveUp({
        status: run.status,
        phase: run.currentPhase,
        round,
        maxRepairRounds: run.maxRepairRounds,
      })
        ? "spent"
        : "pending";
    };
    for (const binding of this.store.listBindings()) {
      if (binding.state !== "active") continue;
      const run = this.store.activeRunForBinding(binding.id);
      const version = run ? this.store.getWorkflowVersionById(run.workflowVersionId) : null;
      if (!run || version?.completionPolicy.kind !== "inspector") continue;
      const gate = this.gateState(run);
      if (gate?.prKey === prKey) { owns(run); continue; }
      // A PR handoff can open the PR without changing one repository byte. Until the gate
      // pins that PR, the live Session.prUrl is only a convenience and disappears across an
      // SDK restart. The Inspector row is the durable proof that this session opened this PR,
      // so it must preserve the veto during that pinning window as well.
      if (gate && adopted && this.matchesUnpinnedGate(binding, gate, adopted)) { owns(run); continue; }
      // Scoped to the binding's own repository, so a run reviewing repo A can never veto
      // repo B's pull request. Independent per-PR merges are adopted decision 4, and this
      // last arm - the live convenience hint, before the gate has pinned anything - is the
      // one place a sibling repository's url could have leaked in.
      const session = binding.sessionId ? this.registry.getSession(binding.sessionId) : undefined;
      const candidateUrl = this.gateCandidateUrl(binding, session);
      const candidate = candidateUrl ? parsePrUrl(candidateUrl) : null;
      if (candidate?.key === prKey) owns(run);
    }
    return standing;
  }

  /**
   * Give a run that spent its repair budget more rounds, so it stops being a dead end.
   *
   * It raises the budget and, for one class of run, puts the status back.
   *
   * A PARKED REPAIR ROUND needs only the number. The resume move and the confirmed full
   * restart both accept a blocked run and refuse on exactly one inequality,
   * `round > maxRepairRounds`, so moving the right-hand side hands it straight back to the
   * machinery that already knows how to revive it - no second revival path to keep in step.
   *
   * AN INSPECTOR-ONLY GATE RUN needs the status too, and this is not symmetry for its own
   * sake. Nothing polls a blocked run: `evaluateInspectorGate` returns early on one, and
   * the resumption observer only looks at `waiting_for_session`. So a grant that moved only
   * the number would leave the gate run exactly as stopped as it was while flipping the
   * Shipping veto from `workflow-gate-spent` to `workflow-gate-pending` - trading a true
   * "this gave up" for a false "this is still working", which is worse than the dead end
   * this method exists to open. Restoring `waiting_for_new_head` puts it back where its own
   * gate re-enters it, and the head that was refused has not been recorded as a prior
   * submission head, so the next observation picks that very head up.
   *
   * `workflowRunGaveUp` reads the same inequality, so the veto downgrades to `pending` -
   * now truthfully - without this method knowing Shipping exists.
   */
  grantRepairRounds(
    runId: string,
    input: GrantWorkflowRepairRounds,
    now = Date.now(),
  ): WorkflowRuntimeMutation<WorkflowRun> {
    const run = this.store.getRun(runId);
    if (!run) return { ok: false, reason: "not_found", message: "No such workflow run" };
    /*
     * A replay of a grant that already landed is that grant, not a second one.
     *
     * The action store deliberately RETAINS its request id across a failed response, so a
     * network error on a grant that actually committed comes back with the same id. Without
     * this the replay would hit the `run_not_waiting` refusal below - the run is no longer
     * spent, precisely because the first attempt worked - and tell the operator their run
     * could not be granted rounds it already has. Every sibling action keys idempotency the
     * same way; this one has an event rather than a trigger key to key off.
     */
    const replay = this.store.listEvents(run.id).find((event) =>
      event.kind === "repair_rounds_granted"
      && event.payload
      && !Array.isArray(event.payload)
      && typeof event.payload === "object"
      && event.payload.requestId === input.requestId);
    if (replay) return { ok: true, value: run, idempotent: true };
    const latest = this.store.latestSubmission(run.id);
    if (!latest) return { ok: false, reason: "not_found", message: "The run has no submission" };
    if (!workflowRunGaveUp({
      status: run.status,
      phase: run.currentPhase,
      round: latest.round,
      maxRepairRounds: run.maxRepairRounds,
    })) {
      return {
        ok: false,
        reason: "run_not_waiting",
        message: "Only a run that has spent its repair budget can be granted more rounds",
      };
    }
    // Clamped rather than refused: the operator asked for room to continue, and the
    // binding form already caps the same number at the same ceiling.
    const granted = Math.min(run.maxRepairRounds + input.rounds, WORKFLOW_LIMITS.repairRoundsMax);
    if (granted <= run.maxRepairRounds) {
      return {
        ok: false,
        reason: "conflict",
        message: `A run may not exceed ${WORKFLOW_LIMITS.repairRoundsMax} repair rounds`,
      };
    }
    // The same discriminator `resubmit` uses to refuse an Inspector-only repair, and it has
    // to be the submission MODE rather than the status: the status is `blocked` here, which
    // is exactly what the gate arm has in common with the parked arm.
    const gate = this.gateState(run);
    const restore = gate && latest.mode === "inspector_only"
      ? {
          status: "waiting_for_new_head" as const,
          phase: "inspector_findings",
          gateState: gate as unknown as WorkflowJson,
        }
      : this.parkedRestoreForGrant(run);
    const updated = this.store.grantRunRepairRounds(run.id, granted, restore, latest.round + 1, {
      kind: "repair_rounds_granted",
      payload: {
        requestId: input.requestId,
        from: run.maxRepairRounds,
        to: granted,
        round: latest.round,
        resumed: restore?.status ?? null,
      },
    }, now);
    if (!updated) {
      return { ok: false, reason: "conflict", message: "The run finished before the grant landed" };
    }
    this.publishRun(run.id);
    return { ok: true, value: updated };
  }

  /**
   * Put a granted parked round back where its own observer can see it, or leave it alone.
   *
   * This is the half of the grant that used to be missing, and the argument for it is the
   * one already written above the Inspector arm: nothing polls a blocked run. That was a
   * complete answer while every parked round waited for a human's click. It stopped being
   * one at built-in version 7, which handed the repair loop to `sweepResumptions` - and
   * that sweep filters on `waiting_for_session` and nothing else. So on exactly the
   * workflows whose whole posture is "the loop closes itself", the grant was the one place
   * it could not: the number moved, the run stayed blocked, and the operator was left
   * looking at a button that had done its job silently and a run that had not moved.
   *
   * Restoring the status does NOT restart the round, and that distinction is the reason
   * this is safe to do unconditionally for a self-resuming run. The observer still asks
   * whether the repository moved before it opens anything. A session that did the repair
   * gets its next round within a tick; a session that did nothing leaves the run parked
   * rather than spending a granted round re-reviewing identical bytes, which is precisely
   * the waste that exhausted the budget in the first place.
   *
   * Two runs are deliberately left blocked. A run under `manual` resumption or `preview`
   * delivery has no observer coming for it, so restoring the status would replace an honest
   * "this stopped" with a "still working" that nothing is working on - the same trade the
   * Inspector arm exists to avoid. And a run blocked by a build that never recorded its
   * parked phase cannot say what to restore it to; guessing would drop it into a branch
   * that never ran. Both keep exactly the behaviour they had: raise the budget, and the
   * operator resumes by hand.
   */
  private parkedRestoreForGrant(run: WorkflowRun): {
    status: WorkflowRun["status"];
    phase: string;
    gateState: WorkflowJson | null;
  } | null {
    const parkedPhase = workflowRoundLimitParkedPhase(run.gateState);
    if (!parkedPhase) return null;
    const binding = this.store.getBinding(run.bindingId);
    const version = this.store.getWorkflowVersionById(run.workflowVersionId);
    if (!binding || !version) return null;
    if (!workflowRunResumesItself({
      resumptionPolicy: version.resumptionPolicy,
      deliveryMode: binding.deliveryMode,
    })) {
      return null;
    }
    return { status: "waiting_for_session", phase: parkedPhase, gateState: null };
  }

  async preparePr(
    runId: string,
    requestId: string,
    now = Date.now(),
  ): Promise<WorkflowRuntimeMutation<WorkflowDelivery>> {
    const run = this.store.getRun(runId);
    const gate = run ? this.gateState(run) : null;
    const binding = run ? this.store.getBinding(run.bindingId) : null;
    const version = run ? this.store.getWorkflowVersionById(run.workflowVersionId) : null;
    const submission = run ? this.store.latestSubmission(run.id) : null;
    if (!run || !gate || !binding || !submission || version?.completionPolicy.kind !== "inspector") {
      return { ok: false, reason: "not_found", message: "No active GitHub Inspector gate exists" };
    }
    const prior = this.store.listEvents(run.id).find((event) =>
      event.kind === "pr_handoff_prepared"
      && event.payload
      && !Array.isArray(event.payload)
      && typeof event.payload === "object"
      && event.payload.requestId === requestId
      && typeof event.payload.deliveryId === "string");
    if (
      prior?.payload
      && !Array.isArray(prior.payload)
      && typeof prior.payload === "object"
      && typeof prior.payload.deliveryId === "string"
    ) {
      const existing = this.store.getDelivery(prior.payload.deliveryId);
      if (existing) return { ok: true, value: existing, idempotent: true };
    }
    if (
      run.status !== "waiting_for_pr"
      || !["offer_prepare_pr", "prepare_pr"].includes(version.completionPolicy.missingPrAction)
      || !["missing_pr", "unadopted_pr"].includes(gate.waitReason ?? "")
      || !binding.sessionId
    ) {
      return {
        ok: false,
        reason: "run_not_waiting",
        message: "This published workflow does not currently offer PR preparation",
      };
    }
    const session = this.registry.getSession(binding.sessionId);
    if (!session || session.state === "exited") {
      return {
        ok: false,
        reason: "session_unavailable",
        message: "The bound session is not available to prepare this pull request",
      };
    }
    const skill = this.requireSkill(session, PULL_REQUEST_SKILL);
    if (!skill.ok) {
      return {
        ok: false,
        reason: "unsupported_mode",
        message: skill.message,
      };
    }
    const rendered = renderPrHandoff({
      workflowName: this.store.runSummary(run.id)?.workflowName ?? "Workflow",
      workflowVersion: version.version,
      runId: run.id,
      originalGoal: this.originalGoal(run.id),
      skillCommand: skill.command,
      repoRoot: binding.repoRoot || null,
      workflowEvidence: versionSupportsWorkflowEvidence(version),
    });
    const prepared = this.store.prepareDelivery({
      id: randomUUID(),
      runId: run.id,
      submissionId: submission.id,
      kind: "pr_handoff",
      sessionId: binding.sessionId,
      noteKey: binding.noteKey,
      payload: rendered.payload,
      payloadSha256: rendered.payloadSha256,
    }, now);
    if (!prepared.idempotent) {
      this.store.appendEvent(run.id, "pr_handoff_prepared", {
        requestId,
        deliveryId: prepared.delivery.id,
        payloadSha256: prepared.delivery.payloadSha256,
      }, now);
    }
    this.store.setRunState(run.id, "waiting_for_session", "pr_handoff", gate as unknown as WorkflowJson, now);
    this.publishRun(run.id);
    if (binding.deliveryMode === "live") await this.deliverPrepared(prepared.delivery.id, false);
    return { ok: true, value: this.store.getDelivery(prepared.delivery.id) ?? prepared.delivery, idempotent: prepared.idempotent };
  }

  recheckInspector(
    runId: string,
    requestId: string,
    now = Date.now(),
  ): WorkflowRuntimeMutation<WorkflowRun> {
    const run = this.store.getRun(runId);
    if (!run || !this.gateState(run)) {
      return { ok: false, reason: "not_found", message: "No active GitHub Inspector gate exists" };
    }
    const repeated = this.store.listEvents(run.id).some((event) =>
      event.kind === "inspector_recheck_requested"
      && event.payload
      && !Array.isArray(event.payload)
      && typeof event.payload === "object"
      && event.payload.requestId === requestId);
    if (repeated) return { ok: true, value: run, idempotent: true };
    if (runIsTerminal(run)) {
      return {
        ok: false,
        reason: "run_not_waiting",
        message: "This GitHub Inspector gate is already terminal",
      };
    }
    const canEvaluate = run.status === "waiting_for_pr"
      || run.status === "waiting_for_inspector"
      || run.status === "waiting_for_new_head"
      || (run.status === "waiting_for_session" && run.currentPhase === "pr_handoff")
      || (run.status === "blocked" && run.currentPhase === "inspector_disabled");
    if (!canEvaluate) {
      return {
        ok: false,
        reason: "run_not_waiting",
        message: "This GitHub Inspector gate is not waiting in a state a recheck can advance",
      };
    }
    this.store.appendEvent(run.id, "inspector_recheck_requested", { requestId }, now);
    this.scheduleGateEvaluation(run.id, null);
    return { ok: true, value: run };
  }

  async restartFull(
    runId: string,
    input: RestartFullWorkflow,
    now = Date.now(),
  ): Promise<WorkflowRuntimeMutation<WorkflowSubmitResult>> {
    const run = this.store.getRun(runId);
    const binding = run ? this.store.getBinding(run.bindingId) : null;
    const triggerKey = binding
      ? `manual:${binding.id}:restart-full:${input.requestId}`
      : null;
    const existing = triggerKey ? this.store.submissionByTrigger(triggerKey) : null;
    if (run && existing?.runId === run.id) {
      const binding = this.store.getBinding(run.bindingId);
      const resumed = binding
        ? this.resumeImageEvidenceCapture(binding, run, existing, now)
        : null;
      if (resumed) {
        return this.captureAndActivate(
          resumed.binding,
          resumed.run,
          resumed.submission,
          resumed.previousFingerprint,
        );
      }
      return {
        ok: true,
        value: { run, submission: existing },
        idempotent: true,
      };
    }
    const gate = run ? this.gateState(run) : null;
    const latest = run ? this.store.latestSubmission(run.id) : null;
    if (!run || !gate || !binding || !latest) {
      return { ok: false, reason: "not_found", message: "No active GitHub Inspector gate exists" };
    }
    const abandoningBypass =
      run.status === "waiting_for_new_head"
      || latest.mode === "inspector_only";
    if (!abandoningBypass) {
      return {
        ok: false,
        reason: "run_not_waiting",
        message: "Full restart is the explicit escape from an active GitHub Inspector-only repair",
      };
    }
    if (input.confirmation !== "RESTART FULL WORKFLOW") {
      return {
        ok: false,
        reason: "confirmation_required",
        message: "Type RESTART FULL WORKFLOW to abandon the active GitHub Inspector-only repair",
      };
    }
    if (latest.round > run.maxRepairRounds) {
      this.store.setRunState(run.id, "blocked", "round_limit", gate as unknown as WorkflowJson, now);
      this.publishRun(run.id);
      return { ok: false, reason: "round_limit", message: "The workflow has exhausted its repair rounds" };
    }
    const created = this.store.createRepairSubmission({
      id: randomUUID(),
      runId: run.id,
      round: latest.round + 1,
      triggerSource: "manual",
      triggerKey: triggerKey!,
      context: {},
      evidence: {},
      now,
    });
    // The restart's whole purpose is another real attempt at the graph, so the Commands it
    // re-reaches must be allowed to run again rather than reporting a budget the abandoned
    // Inspector-only repair spent. Written against the round the new submission just took.
    this.store.setRunCheckBudgetEpoch(run.id, created.submission.round, now);
    this.store.appendEvent(run.id, "inspector_only_abandoned_for_full_restart", {
      requestId: input.requestId,
      priorPrKey: gate.prKey,
      priorHeadSha: gate.targetHeadSha,
      submissionId: created.submission.id,
    }, now);
    this.publishRun(run.id);
    if (created.idempotent && created.submission.status !== "capturing") {
      return { ok: true, value: { run: created.run, submission: created.submission }, idempotent: true };
    }
    return this.captureAndActivate(
      binding,
      created.run,
      created.submission,
      latest.evidenceFingerprint,
      false,
    );
  }

  async retryDelivery(
    deliveryId: string,
    input: RetryWorkflowDelivery,
    now = Date.now(),
  ): Promise<WorkflowRuntimeMutation<WorkflowDelivery>> {
    const delivery = this.store.getDelivery(deliveryId);
    if (!delivery) return { ok: false, reason: "not_found", message: "No such workflow delivery" };
    const run = this.store.getRun(delivery.runId);
    if (!run || runIsTerminal(run)) {
      return {
        ok: false,
        reason: "invalid_delivery_state",
        message: "A terminal workflow run cannot deliver another repair packet",
        current: run,
      };
    }
    const prior = this.deliveryActionEvent(delivery.runId, "delivery_retry_completed", input.requestId);
    if (prior) {
      return {
        ok: true,
        value: this.store.getDelivery(delivery.id) ?? delivery,
        idempotent: true,
      };
    }
    if (delivery.state !== "refused") {
      return {
        ok: false,
        reason: "invalid_delivery_state",
        message: "Only a positively refused delivery can be retried",
        current: delivery,
      };
    }
    const targeted = this.store.confirmDeliveryRetryTarget(
      delivery.id,
      input.expectedSessionId,
      input.expectedNoteKey,
      now,
    );
    if (!targeted) {
      return {
        ok: false,
        reason: "conflict",
        message: "The workflow attachment changed; refresh before confirming this retry target",
        current: this.store.getBinding(run.bindingId),
      };
    }
    await this.deliverPrepared(delivery.id, true);
    const updated = this.store.getDelivery(delivery.id) ?? targeted;
    this.store.appendEvent(delivery.runId, "delivery_retry_completed", {
      deliveryId,
      requestId: input.requestId,
      sessionId: input.expectedSessionId,
      noteKey: input.expectedNoteKey,
      state: updated.state,
    }, Date.now());
    return { ok: true, value: updated };
  }

  async resolveDelivery(
    deliveryId: string,
    input: ResolveWorkflowDelivery,
    now = Date.now(),
  ): Promise<WorkflowRuntimeMutation<WorkflowDelivery | WorkflowSubmitResult>> {
    const delivery = this.store.getDelivery(deliveryId);
    if (!delivery) return { ok: false, reason: "not_found", message: "No such workflow delivery" };
    const run = this.store.getRun(delivery.runId);
    if (!run) return { ok: false, reason: "not_found", message: "The delivery has no workflow run" };
    const acknowledgementOnly = runIsTerminal(run);
    const version = this.store.getWorkflowVersionById(run.workflowVersionId);
    const inspectorOnlyDelivery =
      delivery.kind === "inspector_feedback"
      && version?.completionPolicy.kind === "inspector"
      && version.completionPolicy.onFindings === "inspector_only";
    if (
      input.resolution === "discard_and_new_round"
      && inspectorOnlyDelivery
      && !acknowledgementOnly
    ) {
      return {
        ok: false,
        reason: "invalid_delivery_state",
        message: "GitHub Inspector-only repair can be abandoned only through the confirmed full restart action",
        current: delivery,
      };
    }
    if (
      input.resolution === "discard_and_new_round"
      && input.confirmation !== "DISCARD AND SEND A NEW REPAIR ROUND"
    ) {
      return {
        ok: false,
        reason: "confirmation_required",
        message: "Type the exact discard confirmation before creating a new repair round",
      };
    }
    if (input.resolution === "mark_delivered" || acknowledgementOnly) {
      const resolved = this.store.resolveUncertainDelivery(
        delivery.id,
        input.resolution,
        input.requestId,
        now,
      );
      if (!resolved) {
        return {
          ok: false,
          reason: "invalid_delivery_state",
          message: "Only an uncertain delivery needs explicit resolution",
          current: this.store.getDelivery(delivery.id) ?? delivery,
        };
      }
      if (!resolved.idempotent) {
        if (input.resolution === "mark_delivered") {
          const session = this.registry.getSession(delivery.sessionId);
          if (session) this.rememberInjection(session.id, delivery.payload, "workflow");
          // The operator has said this instruction landed, so the action it belongs to can
          // be observed again. Without this the observer's refusal to guess about an
          // uncertain write would make "it landed" an answer nothing could act on.
          this.reopenSessionAction(resolved.delivery, now);
        }
        if (resolved.rearmed) this.queues.refresh(delivery.noteKey);
        this.publishRun(delivery.runId);
      }
      return {
        ok: true,
        value: resolved.delivery,
        idempotent: resolved.idempotent,
      };
    }

    if (externallySourced(run)) {
      // Same hole as resubmit: this branch also creates a manual round with no expectation.
      // Marking the ambiguous packet delivered above stays available; only re-capturing does not.
      return { ok: false, reason: "unsupported_mode", message: EXTERNAL_MANUAL_ROUND_REFUSAL };
    }
    const binding = this.store.getBinding(run.bindingId);
    if (
      !binding
      || binding.state !== "active"
      || binding.sessionId !== input.expectedSessionId
      || binding.noteKey !== input.expectedNoteKey
    ) {
      return {
        ok: false,
        reason: "conflict",
        message: "The workflow attachment changed; refresh before creating a replacement round",
        current: binding,
      };
    }
    const latest = this.store.latestSubmission(run.id);
    if (!latest) return { ok: false, reason: "not_found", message: "The run has no submission" };
    if (latest.round > run.maxRepairRounds) {
      this.store.blockForRoundLimit(run, now);
      this.publishRun(run.id);
      return {
        ok: false,
        reason: "round_limit",
        message: "The workflow has exhausted its configured repair rounds",
      };
    }
    const replaced = this.store.replaceUncertainDeliveryWithRepair(
      delivery.id,
      input.requestId,
      {
        id: randomUUID(),
        runId: run.id,
        round: latest.round + 1,
        triggerSource: "manual",
        triggerKey: `manual:${binding.id}:delivery-resolution:${input.requestId}`,
        context: {},
        evidence: {},
        now,
      },
    );
    if (!replaced) {
      return {
        ok: false,
        reason: "invalid_delivery_state",
        message: "Only an uncertain delivery on a waiting run can create a replacement round",
        current: this.store.getDelivery(delivery.id) ?? delivery,
      };
    }
    this.publishRun(run.id);
    const resumedReplacement = replaced.idempotent
      ? this.resumeImageEvidenceCapture(binding, replaced.run, replaced.submission, now)
      : null;
    const captureTarget = resumedReplacement ?? {
      binding,
      run: replaced.run,
      submission: replaced.submission,
      previousFingerprint: latest.evidenceFingerprint,
    };
    if (replaced.idempotent && !resumedReplacement && replaced.submission.status !== "capturing") {
      return {
        ok: true,
        value: { run: replaced.run, submission: replaced.submission },
        idempotent: true,
      };
    }
    const captured = await this.captureAndActivate(
      captureTarget.binding,
      captureTarget.run,
      captureTarget.submission,
      captureTarget.previousFingerprint,
      true,
    );
    return captured.ok && replaced.idempotent
      ? { ...captured, idempotent: true }
      : captured;
  }

  async claimCompletion(
    sessionId: string,
    claim: WorkflowCompletionClaim,
    now = Date.now(),
  ): Promise<WorkflowCompletionClaimResult> {
    const session = this.registry.getSession(sessionId);
    if (!session || session.state === "exited") {
      throw new Error("The completion target session is not live");
    }
    if (
      (claim.completionKind === "prompted" && !claim.expectedIntent) ||
      (claim.completionKind === "prompted" && !claim.expectedWorkCycle) ||
      (claim.expectedIntent &&
        !sessionIntentMatches(this.registry.getGoal(session.id), claim.expectedIntent))
    ) {
      throw new Error("Foreman completion intent is no longer current");
    }
    if (claim.expectedWorkCycle) {
      const cycle = session.workCycle;
      if (
        claim.expectedWorkCycle.logicalKey !== noteKeyFor(session) ||
        !cycle ||
        cycle.logicalKey !== claim.expectedWorkCycle.logicalKey ||
        cycle.generation !== claim.expectedWorkCycle.generation ||
        cycle.generation < 1 ||
        cycle.active ||
        cycle.completedAt === null
      ) {
        throw new Error("Foreman completion work cycle is no longer current");
      }
    }
    // Resolve a matching historical prompted guard before entering the claim
    // transaction. A rejected legacy replay must persist its compatibility consume;
    // doing this inside the transaction would roll that migration back with the claim.
    if (claim.completionKind === "prompted") this.registry.getQueue(session.id);
    // A claim offers a proof to an existing binding; it never creates one. An unbound
    // conversation answers `no_binding` so that completion has exactly one owner and two
    // PR-producing paths can never race on the same branch.
    const anchor = this.store.activeBindingForNote(noteKeyFor(session));
    if (!anchor) return { claimed: false, reason: "no_binding" };
    if (anchor.triggerMode !== "foreman_complete") {
      return { claimed: false, reason: "manual_trigger" };
    }
    // One settled turn, one run per repository it changed. `repoRunTargets` returns
    // `[anchor]` for every single-repo conversation, so everything below is one claim against
    // one binding exactly as it always was.
    const targets = this.repoRunTargets(session, anchor);
    let answer: WorkflowCompletionClaimResult | null = null;
    let lead: { result: WorkflowCompletionClaimResult; activate: PreparedWorkflowRun } | null = null;
    const siblings: PreparedWorkflowRun[] = [];
    // Every claim is made HERE, synchronously and in order, before any evidence is read. The
    // durable half of a completion - the guard, the runs, the submissions - is what the reply
    // speaks for, and it must not depend on how long a git read takes.
    for (const [index, target] of targets.entries()) {
      // The FIRST target spends the completion boundary; the rest ride the same proof. One
      // settled turn is one boundary however many repositories it touched, and consuming the
      // guard again would throw on a guard that is no longer armed. It is deliberately the
      // first rather than the primary: a task whose primary is untouched has no primary run,
      // and the boundary must still be spent by the review that does exist.
      const claimed = this.claimCompletionForRepo(target, claim, index === 0, session, now);
      if (index === 0) {
        answer = claimed.result;
        // A refused lead is the whole answer - nothing was claimed, the guard is still armed,
        // and starting sibling runs off an unclaimed proof would review a turn Foreman has
        // not accepted.
        if (!claimed.result.claimed) return claimed.result;
        this.queues.refresh(target.noteKey);
      }
      if (!claimed.activate) continue;
      const prepared: PreparedWorkflowRun = {
        ...claimed.activate,
        previousFingerprint: claimed.previousFingerprint,
      };
      if (index === 0) lead = { result: claimed.result, activate: prepared };
      else siblings.push(prepared);
    }
    if (!answer) throw new Error("Claimed Foreman completion produced no run");
    if (!lead) {
      // Nothing for the lead to capture - an already-claimed replay, or a run that was
      // blocked rather than resubmitted. The siblings still get theirs.
      this.activateSiblingRuns(siblings);
      return answer;
    }
    // Only the LEAD is awaited, and its promise is created BEFORE the siblings are fired so it
    // takes the conversation's capture lock first and they queue behind it.
    //
    // Awaiting every target would put N sequential evidence captures on the request path, and
    // this path is not a dashboard click: `POST /api/sessions/:id/workflow-completion` is the
    // Foreman worker's, it fails CLOSED on a lost response, and a capture reads git and can
    // include a 45-second compaction attempt. A three-repo task would have staked the
    // completion boundary - and the shipping that follows it - on three of those finishing
    // inside one HTTP timeout. The lead alone is awaited because the reply still has to be
    // able to answer `blocked` when ITS capture fails, which is the single-repo contract and
    // is unchanged.
    //
    // The same reasoning `activateSiblingRuns` already carries for the manual paths, applied
    // here rather than restated: the caller learns nothing from a sibling's git read.
    const leadCapture = this.captureAndActivate(
      lead.activate.binding,
      lead.activate.run,
      lead.activate.submission,
      lead.activate.previousFingerprint,
      false,
    ).catch((error) => {
      console.error(
        `[workflow] could not capture the review of ${
          lead?.activate.binding.repoRoot || session.repoRoot
        }: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { ok: false as const, reason: "capture_failed" as const, message: "" };
    });
    this.activateSiblingRuns(siblings);
    const activated = await leadCapture;
    if (!activated.ok && lead.result.claimed) {
      return {
        claimed: true,
        runId: lead.result.runId,
        submissionId: lead.result.submissionId,
        state: "blocked",
      };
    }
    return answer;
  }

  /**
   * Offer one settled turn's proof to one repository's binding.
   *
   * Split out of `claimCompletion` so the fan-out reads as "the same claim, once per
   * repository" rather than as two code paths. Every branch the store's transaction can take
   * - a fresh run, another repair round on a waiting one, an already-claimed replay, a run
   * that has run out of budget - applies per repository, which is what independent repair
   * budgets mean in practice.
   *
   * A sibling's failure is contained rather than fatal. The lead has already spent the
   * boundary by the time one can happen, so throwing would leave the conversation with no
   * review at all and a guard nobody can re-arm; a repository whose run failed to start is
   * visible as a repository with no run, and the operator can start one.
   */
  private claimCompletionForRepo(
    binding: WorkflowBinding,
    claim: WorkflowCompletionClaim,
    retireGuard: boolean,
    session: Session,
    now: number,
  ): {
    result: WorkflowCompletionClaimResult;
    activate: PreparedWorkflowRun | null;
    previousFingerprint: string | undefined;
  } {
    const nothing = {
      result: { claimed: false, reason: "no_binding" } as WorkflowCompletionClaimResult,
      activate: null,
      previousFingerprint: undefined,
    };
    let stored;
    try {
      stored = this.store.claimForemanCompletion({
        binding,
        completionKind: claim.completionKind,
        marker: claim.marker,
        expectedWorkCycle: claim.expectedWorkCycle,
        summary: claim.summary,
        evidenceFingerprint: claim.evidenceFingerprint,
        evidenceGroupKey: `foreman:${binding.noteKey}:${claim.completionKind}:${claim.marker}`,
        expectedIntent: claim.expectedIntent,
        runId: randomUUID(),
        submissionId: randomUUID(),
        retireGuard,
        // The CONVERSATION's checkout, never this repository's: a Foreman queue belongs to
        // the session, and the lead binding here can be an attached repository's when the
        // primary is the one that went untouched.
        guardCwd: session.cwd,
        now,
      });
    } catch (error) {
      if (retireGuard) throw error;
      console.error(
        `[workflow] could not claim the review of ${binding.repoRoot}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return nothing;
    }
    if (!stored.result.claimed) return { ...nothing, result: stored.result };
    if (!stored.run) throw new Error("Claimed Foreman completion has no workflow run");
    this.publishRun(stored.run.id);
    const resumed = stored.submission
      ? this.resumeImageEvidenceCapture(stored.binding, stored.run, stored.submission, now)
      : null;
    return {
      result: stored.result,
      activate: resumed ?? (stored.created && stored.submission
        ? { binding: stored.binding, run: stored.run, submission: stored.submission }
        : null),
      previousFingerprint: resumed?.previousFingerprint ?? stored.previousFingerprint,
    };
  }

  /**
   * Resolve one external orchestrator's binding, creating it or returning the same one.
   *
   * There is deliberately NO route for this. An HTTP endpoint that started arbitrary
   * Workflow runs on a caller's say-so would let a client target somebody else's session;
   * every identity here is resolved server-side instead - the immutable version from the
   * store, the live session and its noteKey from the registry, and the idempotency key from
   * the supplied reference. Later Ensemble code calls this method in-process.
   */
  ensureExternalBinding(
    input: EnsureExternalBindingInput,
    now = Date.now(),
  ): WorkflowRuntimeMutation<ExternalBindingResult> {
    const version = this.store.getWorkflowVersionById(input.workflowVersionId);
    if (!version) {
      return { ok: false, reason: "not_found", message: "No such immutable workflow version" };
    }
    const triggerMode = input.triggerMode ?? version.bindingDefaults.triggerMode;
    const deliveryMode = input.deliveryMode ?? version.bindingDefaults.deliveryMode;
    const maxRepairRounds = input.maxRepairRounds ?? version.bindingDefaults.maxRepairRounds;
    // Preview and Manual only, and REFUSED rather than quietly downgraded.
    //
    // The external path is Preview-scoped for now: Live delivery and Foreman completion are
    // owned by their own phases and this boundary has not been proven against either. Those
    // modes can arrive by DEFAULT as well as by request - a published version whose binding
    // defaults say Live would otherwise hand this new path a terminal write - so the check is
    // on the resolved values, not on the input. Silently substituting Preview would be worse
    // than refusing: the caller pinned a version believing it would deliver, and would get a
    // review that never reaches the session with nothing saying so.
    if (deliveryMode !== "preview" || triggerMode !== "manual") {
      return {
        ok: false,
        reason: "unsupported_mode",
        message:
          "An externally sourced binding is Preview and Manual only; "
          + "this workflow version asks for "
          + `${deliveryMode} delivery and ${triggerMode} trigger`,
      };
    }
    let sourceKey: string;
    try {
      sourceKey = externalSourceKey(input.source, version.id);
    } catch (error) {
      return {
        ok: false,
        reason: "conflict",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    // A claim outlives the session it was made for, so answer the idempotent case before
    // asking anything about live state: a retry after a restart must return the same
    // binding even while its session is being rediscovered.
    const claimed = this.store.claimBySourceKey(sourceKey);
    if (claimed) {
      const binding = this.store.getBinding(claimed.bindingId);
      if (binding) return { ok: true, value: { binding, claim: claimed, created: false }, idempotent: true };
      return {
        ok: false,
        reason: "not_found",
        message: "The claimed workflow binding is missing",
        current: claimed,
      };
    }
    const workflowBlock = this.bindingWorkflowBlock(version);
    if (workflowBlock) return workflowBlock;
    const session = this.registry.getSession(input.sessionId);
    if (!session || session.state === "exited") {
      return { ok: false, reason: "session_unavailable", message: "The selected session is not live" };
    }
    const prerequisite = this.bindingModeBlock(session, triggerMode, deliveryMode);
    if (prerequisite) return prerequisite;
    const ineligible = this.options.externalBindingEligibility?.({
      sessionId: session.id,
      source: input.source,
    });
    if (ineligible) {
      return { ok: false, reason: "ineligible_session", message: ineligible };
    }
    const resolved = this.store.ensureExternalBindingClaim({
      sourceKind: input.source.kind,
      sourceKey,
      sourceId: input.source.sourceId,
      binding: {
        id: randomUUID(),
        workflowVersionId: version.id,
        noteKey: noteKeyFor(session),
        sessionId: session.id,
        sessionAgent: session.agent,
        sessionName: session.name,
        sessionCwd: session.cwd,
        sessionRepoRoot: session.repoRoot,
        triggerMode,
        deliveryMode,
        maxRepairRounds,
        now,
      },
      now,
    });
    if (!resolved.ok) {
      return resolved.reason === "note_conflict"
        ? {
            ok: false,
            reason: "conflict",
            message: "This conversation already has an active workflow binding",
            current: resolved.conflict,
          }
        : { ok: false, reason: "not_found", message: "The claimed workflow binding is missing" };
    }
    // An Ensemble hand-off arms a session exactly as the dispatch and manual paths do, so it
    // owes the fleet stream the same event. Missing it left the winner's session genuinely
    // bound - an `active` row, a claim, a runnable workflow - while every card and console
    // header went on offering to attach one, until some unrelated mutation happened to touch
    // the binding and publish it late. That is the same wrong reading this whole change exists
    // to end, reached by a different door.
    //
    // Published whether or not the claim was `created`: a concurrent caller may have won the
    // insert, and an upsert of the state that is already true costs one idempotent frame.
    this.publishBinding(resolved.binding.id);
    return {
      ok: true,
      value: { binding: resolved.binding, claim: resolved.claim, created: resolved.created },
      idempotent: !resolved.created,
    };
  }

  /**
   * Start, or resume, the ONE initial submission an external result is entitled to.
   *
   * The claim's own key is the trigger key, so a lost response, a repeat call and a restart
   * all resolve to the same run, round and model-call family. A submission still capturing
   * from an earlier attempt is resumed in place rather than replaced - that is the whole
   * difference between "the caller restored its artifact and asked again" and "the caller
   * started a second review".
   */
  async submitExternal(
    bindingId: string,
    input: SubmitExternalInput,
    now = Date.now(),
  ): Promise<WorkflowRuntimeMutation<WorkflowSubmitResult>> {
    const binding = this.store.getBinding(bindingId);
    if (!binding) return { ok: false, reason: "not_found", message: "No such workflow binding" };
    if (binding.state !== "active") {
      return { ok: false, reason: "inactive_binding", message: "The workflow binding is not active" };
    }
    // The commit id is the one free-form value here. An abbreviated or upper-case sha would
    // simply never equal what capture read, so the run would block forever with a message
    // that blamed the session rather than the request.
    const expectation = WorkflowCaptureExpectationSchema.safeParse(input.expectation);
    if (!expectation.success) {
      return {
        ok: false,
        reason: "conflict",
        message: "An external capture expectation needs one complete lowercase commit id",
      };
    }
    const claim = this.store.claimForBinding(binding.id);
    if (!claim || claim.kind !== input.source.kind) {
      return {
        ok: false,
        reason: "conflict",
        message: "This workflow binding is not owned by that external source",
        current: claim,
      };
    }
    let key: string;
    try {
      key = externalSourceKey(input.source, binding.workflowVersionId);
    } catch (error) {
      return {
        ok: false,
        reason: "conflict",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    if (key !== claim.sourceKey) {
      return {
        ok: false,
        reason: "conflict",
        message: "The supplied external result does not match this binding's claim",
        current: claim,
      };
    }
    const existing = this.store.submissionByTrigger(key);
    if (existing) {
      const existingRun = this.store.getRun(existing.runId);
      if (!existingRun) {
        return { ok: false, reason: "not_found", message: "The idempotent run is missing" };
      }
      // The idempotency key names a RESULT, so the artifact behind it cannot change. Without
      // this, a retry could hand a different commit to the same key and either resume the
      // round against evidence nobody selected, or - once the run had finished - be answered
      // as idempotent success for a commit this run never reviewed.
      const pinned = this.store.externalExpectationFor(existingRun.id);
      if (!pinned) {
        // Unreachable by construction: the pin is written inside the same transaction as the
        // run and its submission, so an external run cannot exist without one. It is a
        // REFUSAL rather than an assumption because the alternative on being wrong is to
        // accept whatever commit the retry names - exactly the artifact swap this guards.
        // Nothing durable can be said about which artifact this run was for, so nothing is.
        return {
          ok: false,
          reason: "conflict",
          message:
            "This external run has no pinned artifact, so the result it was started for "
            + "cannot be established; start a new result rather than reviewing another commit",
          current: existingRun,
        };
      }
      if (pinned.expectedHeadSha !== expectation.data.expectedHeadSha) {
        return {
          ok: false,
          reason: "conflict",
          message:
            "This external result already pinned a different commit; "
            + "a new artifact needs its own result id",
          current: pinned,
        };
      }
      if (existing.status !== "failed") {
        return {
          ok: true,
          value: { run: existingRun, submission: existing },
          idempotent: true,
        };
      }
      const resumed = this.store.resumeCapture(
        existingRun.id,
        existing.id,
        CAPTURE_RESUMABLE_PHASES,
        now,
      );
      if (!resumed) {
        return {
          ok: true,
          value: { run: existingRun, submission: existing },
          idempotent: true,
        };
      }
      this.publishRun(resumed.run.id);
      return this.captureAndActivate(
        binding,
        resumed.run,
        resumed.submission,
        undefined,
        false,
        // The PINNED expectation, not the supplied one: they are equal by the check above,
        // and reading the durable copy is what makes that true by construction.
        pinned,
      );
    }
    const active = this.store.activeRunForBinding(binding.id);
    if (active) {
      return {
        ok: false,
        reason: "run_active",
        message: "This binding already has an active run",
        current: active,
      };
    }
    // The external source kind IS the trigger source. Assigning rather than restating it
    // means a future external kind that nobody appended to WORKFLOW_TRIGGER_SOURCES fails
    // to compile here instead of filing its runs under somebody else's name.
    const triggerSource: WorkflowTriggerSource = input.source.kind;
    // The pinned artifact rides WITH the run and submission, in one transaction. Pinning it
    // afterwards left a window where a crash produced an external run holding no expected
    // commit, and the retry - finding nothing pinned - would have accepted whatever commit it
    // was handed and reviewed an artifact nobody selected.
    const created = this.store.createInitialSubmission(
      {
        id: randomUUID(),
        binding,
        triggerSource,
        triggerKey: key,
        now,
        externalExpectation: expectation.data,
      },
      { id: randomUUID(), triggerSource, triggerKey: key, context: {}, evidence: {}, now },
    );
    if (created.idempotent) {
      return { ok: true, value: { run: created.run, submission: created.submission }, idempotent: true };
    }
    this.publishRun(created.run.id);
    return this.captureAndActivate(
      binding,
      created.run,
      created.submission,
      undefined,
      false,
      expectation.data,
    );
  }

  private gateState(run: WorkflowRun): WorkflowInspectorGateState | null {
    const parsed = WorkflowInspectorGateStateSchema.safeParse(run.gateState);
    return parsed.success ? parsed.data : null;
  }

  private resetRecoveredGateObservations(): void {
    const cfg = getInspectorConfig();
    for (const run of this.store.listRuns()) {
      if (runIsTerminal(run)) continue;
      const state = this.gateState(run);
      if (!state) continue;
      const waitingForNewHead = run.status === "waiting_for_new_head";
      const waitingForPr = run.status === "waiting_for_pr";
      const waitingForSession = run.status === "waiting_for_session";
      const blocked = run.status === "blocked";
      const waitReason = waitingForNewHead
        ? "findings"
        : waitingForPr || waitingForSession || blocked
          ? state.waitReason
          : cfg.enabled
            ? "awaiting_fresh_observation"
            : "inspector_disabled";
      const status: WorkflowRun["status"] = waitingForNewHead
        ? "waiting_for_new_head"
        : waitingForPr
          ? "waiting_for_pr"
          : waitingForSession
            ? "waiting_for_session"
            : blocked || !cfg.enabled
              ? "blocked"
              : "waiting_for_inspector";
      const phase = waitingForNewHead
        ? "inspector_findings"
        : waitingForPr || waitingForSession || blocked
          ? run.currentPhase
          : cfg.enabled
            ? "inspector_awaiting_fresh_observation"
            : "inspector_disabled";
      const next: WorkflowInspectorGateState = {
        ...state,
        lastObservedAt: null,
        observedHeadSha: null,
        waitReason,
      };
      const updated = this.store.updateInspectorGate({
        runId: run.id,
        expectedState: state,
        state: next,
        status,
        phase,
        now: Date.now(),
      });
      if (updated) this.publishRun(run.id);
    }
  }

  private scheduleInspectionUpdate(event: InspectionUpdated): void {
    for (const run of this.store.listRuns()) {
      if (runIsTerminal(run)) continue;
      const state = this.gateState(run);
      if (!state) continue;
      if (state.prKey === event.prKey) {
        this.scheduleGateEvaluation(run.id, event);
        continue;
      }
      if (state.prKey) continue;
      const binding = this.store.getBinding(run.bindingId);
      if (binding && this.matchesUnpinnedGate(binding, state, event.ledger)) {
        this.scheduleGateEvaluation(run.id, event);
        continue;
      }
      if (!binding) continue;
      const session = binding.sessionId ? this.registry.getSession(binding.sessionId) : undefined;
      const candidateUrl = this.gateCandidateUrl(binding, session);
      const candidate = candidateUrl ? parsePrUrl(candidateUrl) : null;
      if (candidate?.key === event.prKey) this.scheduleGateEvaluation(run.id, event);
    }
  }

  private scheduleGatesForSession(sessionId: string): void {
    for (const binding of this.store.listBindings()) {
      if (binding.sessionId !== sessionId) continue;
      const run = this.store.activeRunForBinding(binding.id);
      if (run && this.gateState(run)) this.scheduleGateEvaluation(run.id, null);
    }
  }

  private scheduleGateEvaluation(runId: string, event: InspectionUpdated | null): void {
    const task = this.withGateLock(runId, () => this.evaluateInspectorGate(runId, event))
      .catch((error) => {
        const run = this.store.getRun(runId);
        if (!run || runIsTerminal(run)) return;
        const state = this.gateState(run);
        if (!state) return;
        this.store.updateInspectorGate({
          runId,
          expectedState: state,
          state: { ...state, waitReason: "review_error" },
          status: "waiting_for_inspector",
          phase: "inspector_adapter_error",
          now: Date.now(),
        });
        this.store.appendEvent(runId, "inspector_adapter_error", {
          error: error instanceof Error ? error.message : String(error),
        });
        this.publishRun(runId);
      });
    this.trackBackgroundTask(task);
  }

  private transitionInspectorGate(
    run: WorkflowRun,
    expectedState: WorkflowInspectorGateState,
    state: WorkflowInspectorGateState,
    status: WorkflowRun["status"],
    phase: string,
    eventKind: string | null,
    eventPayload: WorkflowJson,
    now: number,
  ): WorkflowRun | null {
    const updated = this.store.updateInspectorGate({
      runId: run.id,
      expectedState,
      state,
      status,
      phase,
      now,
    });
    if (!updated) return null;
    if (eventKind) this.store.appendEvent(run.id, eventKind, eventPayload, now);
    this.publishRun(run.id);
    return updated;
  }

  private async evaluateInspectorGate(
    runId: string,
    observation: InspectionUpdated | null,
  ): Promise<void> {
    let run = this.store.getRun(runId);
    let state = run ? this.gateState(run) : null;
    const waitingForPrHandoff = run?.status === "waiting_for_session"
      && run.currentPhase === "pr_handoff";
    if (
      !run
      || !state
      || runIsTerminal(run)
      || (run.status === "waiting_for_session" && !waitingForPrHandoff)
    ) return;
    if (run.status === "blocked" && run.currentPhase !== "inspector_disabled") return;
    const binding = this.store.getBinding(run.bindingId);
    const version = this.store.getWorkflowVersionById(run.workflowVersionId);
    if (!binding || version?.completionPolicy.kind !== "inspector") return;
    const now = Date.now();
    const session = binding.sessionId ? this.registry.getSession(binding.sessionId) : undefined;
    const durableCandidate = observation
      && this.matchesUnpinnedGate(binding, state, observation.ledger)
      ? observation.ledger
      : null;
    const candidateUrl = durableCandidate?.url ?? this.gateCandidateUrl(binding, session);
    const candidate = candidateUrl ? parsePrUrl(candidateUrl) : null;

    if (state.prKey && candidate && candidate.key !== state.prKey) {
      this.transitionInspectorGate(
        run,
        state,
        { ...state, waitReason: "head_mismatch" },
        "blocked",
        "inspector_pr_switch_refused",
        "inspector_pr_switch_refused",
        { pinnedPrKey: state.prKey, candidatePrKey: candidate.key },
        now,
      );
      return;
    }
    if (!state.prKey) {
      if (!candidate) {
        this.transitionInspectorGate(
          run,
          state,
          { ...state, prUrl: null, waitReason: "missing_pr" },
          "waiting_for_pr",
          "inspector_missing_pr",
          null,
          null,
          now,
        );
        return;
      }
      const adopted = getInspectorPr(candidate.key);
      if (!adopted || !this.matchesUnpinnedGate(binding, state, adopted)) {
        this.transitionInspectorGate(
          run,
          state,
          { ...state, prUrl: candidateUrl, waitReason: "unadopted_pr" },
          "waiting_for_pr",
          "inspector_unadopted_pr",
          null,
          null,
          now,
        );
        return;
      }
      const pinned = {
        ...state,
        prKey: adopted.key,
        prUrl: adopted.url,
        waitReason: "awaiting_fresh_observation" as const,
      };
      const updated = this.transitionInspectorGate(
        run,
        state,
        pinned,
        waitingForPrHandoff ? "waiting_for_session" : "waiting_for_inspector",
        waitingForPrHandoff ? "pr_handoff" : "inspector_awaiting_fresh_observation",
        "inspector_pr_pinned",
        { prKey: adopted.key, source: adopted.source },
        now,
      );
      if (!updated) return;
      run = updated;
      state = pinned;
    }

    // Adoption proves the handoff opened a PR, but the agent may still be finishing that
    // turn. Keep the gate pinned and keep Shipping vetoed until the resumption observer sees
    // the session settled. It then compares repository evidence: changed work gets another
    // full workflow round, while an unchanged clean handoff advances without spending one.
    if (waitingForPrHandoff) return;

    const cfg = getInspectorConfig();
    if (!cfg.enabled) {
      this.transitionInspectorGate(
        run,
        state,
        { ...state, waitReason: "inspector_disabled" },
        "blocked",
        "inspector_disabled",
        null,
        null,
        now,
      );
      return;
    }

    const ledger = observation?.prKey === state.prKey
      ? observation.ledger
      : getInspectorPr(state.prKey!);
    if (!ledger) {
      this.transitionInspectorGate(
        run,
        state,
        { ...state, prKey: null, targetHeadSha: null, waitReason: "unadopted_pr" },
        "waiting_for_pr",
        "inspector_unadopted_pr",
        "inspector_adoption_missing",
        { priorPrKey: state.prKey },
        now,
      );
      return;
    }
    if (
      observation
      && observation.prKey === state.prKey
      && observation.observedAt >= state.enteredAt
      && observation.observedState !== null
    ) {
      const observed = {
        ...state,
        lastObservedAt: observation.observedAt,
        observedHeadSha: observation.observedHeadSha,
        reviewPosture: observation.ledger.reviewPosture,
      };
      const updated = this.transitionInspectorGate(
        run,
        state,
        observed,
        run.status,
        run.currentPhase,
        null,
        null,
        now,
      );
      if (!updated) return;
      run = updated;
      state = observed;
    }
    if (state.lastObservedAt === null || state.lastObservedAt < state.enteredAt || !state.observedHeadSha) {
      this.transitionInspectorGate(
        run,
        state,
        { ...state, waitReason: "awaiting_fresh_observation" },
        "waiting_for_inspector",
        "inspector_awaiting_fresh_observation",
        null,
        null,
        now,
      );
      return;
    }
    if (
      ledger.state === "closed"
      || (observation?.prKey === state.prKey && observation.observedState !== "OPEN")
    ) {
      this.transitionInspectorGate(
        run,
        state,
        { ...state, waitReason: "pr_closed" },
        "blocked",
        "inspector_pr_closed",
        "inspector_pr_closed",
        { prKey: state.prKey },
        now,
      );
      return;
    }

    let submission = this.store.latestSubmission(run.id);
    if (!submission) return;
    if (run.status === "waiting_for_new_head") {
      const newHead = state.observedHeadSha;
      const priorHeads = new Set(
        this.store.listSubmissions(run.id).flatMap((item) => item.prHeadSha ? [item.prHeadSha] : []),
      );
      if (!state.failedHeadSha) {
        this.transitionInspectorGate(
          run,
          state,
          { ...state, waitReason: "head_mismatch" },
          "blocked",
          "inspector_gate_context_invalid",
          null,
          { failedHeadSha: state.failedHeadSha, observedHeadSha: newHead },
          now,
        );
        return;
      }
      if (newHead === state.failedHeadSha || priorHeads.has(newHead)) return;
      if (submission.round > run.maxRepairRounds) {
        this.transitionInspectorGate(
          run,
          state,
          { ...state, waitReason: "findings" },
          "blocked",
          "round_limit",
          "inspector_round_limit",
          { maxRepairRounds: run.maxRepairRounds },
          now,
        );
        return;
      }
      const nextState: WorkflowInspectorGateState = {
        ...state,
        targetHeadSha: newHead,
        reviewPosture: ledger.reviewPosture,
        waitReason: "review_pending",
      };
      const created = this.store.createInspectorOnlySubmission({
        id: randomUUID(),
        runId: run.id,
        triggerKey: `inspector-head:${run.id}:${newHead}`,
        newHeadSha: newHead,
        failedHeadSha: state.failedHeadSha,
        priorFindingFingerprints: state.findingFingerprints,
        bypassReason: "Published GitHub Inspector-only findings policy",
        expectedState: state,
        state: nextState,
        now,
      });
      if (!created) return;
      run = created.run;
      submission = created.submission;
      state = nextState;
      this.publishRun(run.id);
    }

    const fullContext = submission.mode === "full_workflow"
      ? WorkflowContextSnapshotSchema.safeParse(submission.context)
      : null;
    if (fullContext && !fullContext.success) {
      this.transitionInspectorGate(
        run,
        state,
        { ...state, waitReason: "head_mismatch" },
        "blocked",
        "inspector_gate_context_invalid",
        null,
        null,
        now,
      );
      return;
    }
    if (fullContext?.success && fullContext.data.evidence.workingTreeDirty) {
      this.transitionInspectorGate(
        run,
        state,
        { ...state, waitReason: "working_tree_not_pushed" },
        "waiting_for_session",
        "inspector_working_tree_not_pushed",
        null,
        null,
        now,
      );
      return;
    }
    const submittedHead = submission.prHeadSha
      ?? (fullContext?.success ? fullContext.data.evidence.headSha : null);
    if (!submittedHead) {
      this.transitionInspectorGate(
        run,
        state,
        { ...state, waitReason: "head_mismatch" },
        "blocked",
        "inspector_gate_context_invalid",
        null,
        null,
        now,
      );
      return;
    }
    if (state.observedHeadSha !== submittedHead) {
      const afterPin = state.targetHeadSha !== null;
      const handoffChangedHead = submission.mode === "full_workflow"
        && this.submissionHadPrHandoff(run.id, submission.id);
      this.transitionInspectorGate(
        run,
        state,
        { ...state, waitReason: "head_mismatch" },
        afterPin || handoffChangedHead
          ? submission.mode === "full_workflow" ? "waiting_for_session" : "blocked"
          : "waiting_for_inspector",
        "inspector_head_mismatch",
        null,
        null,
        now,
      );
      return;
    }
    if (state.targetHeadSha && state.targetHeadSha !== state.observedHeadSha) {
      this.transitionInspectorGate(
        run,
        state,
        { ...state, waitReason: "head_mismatch" },
        submission.mode === "full_workflow" ? "waiting_for_session" : "blocked",
        "inspector_head_mismatch",
        null,
        null,
        now,
      );
      return;
    }
    if (!state.targetHeadSha) {
      const pinned = { ...state, targetHeadSha: submittedHead, waitReason: "review_pending" as const };
      const updated = this.transitionInspectorGate(
        run,
        state,
        pinned,
        "waiting_for_inspector",
        "inspector_review",
        "inspector_head_pinned",
        { prKey: state.prKey, targetHeadSha: submittedHead },
        now,
      );
      if (!updated) return;
      run = updated;
      state = pinned;
    }

    if (ledger.lastAttemptSha === state.targetHeadSha && ledger.lastError) {
      const backedOff = ledger.nextAttemptAt !== null && ledger.nextAttemptAt > now;
      this.transitionInspectorGate(
        run,
        state,
        { ...state, reviewPosture: ledger.reviewPosture, waitReason: backedOff ? "review_backoff" : "review_error" },
        "waiting_for_inspector",
        backedOff ? "inspector_review_backoff" : "inspector_review_error",
        null,
        null,
        now,
      );
      return;
    }
    if (ledger.headSha !== state.targetHeadSha) {
      this.transitionInspectorGate(
        run,
        state,
        { ...state, reviewPosture: ledger.reviewPosture, waitReason: "review_pending" },
        "waiting_for_inspector",
        "inspector_review",
        null,
        null,
        now,
      );
      return;
    }
    const findings = loadInspectorComments(state.prKey!).filter((row) => row.status !== "resolved");
    if (findings.length > 0) {
      await this.handleInspectorFindings(run, submission, binding, version, state, ledger.round, findings, now);
      return;
    }
    const cleanState: WorkflowInspectorGateState = {
      ...state,
      reviewPosture: ledger.reviewPosture,
      waitReason: null,
      findingFingerprints: [],
    };
    this.transitionInspectorGate(
      run,
      state,
      cleanState,
      "completed",
      "complete",
      "inspector_gate_clean",
      { prKey: state.prKey, targetHeadSha: state.targetHeadSha, reviewPosture: ledger.reviewPosture },
      now,
    );
  }

  /**
   * Match an unpinned Inspector gate to durable PR provenance.
   *
   * Session.prUrl is intentionally not provenance and is not durable. An Inspector row is:
   * it exists only after a trusted creation hook proved the PR was opened here.
   * Session identity plus repository plus adoption-after-entry makes that row the PR this
   * gate was waiting for without claiming an older PR from the same long-lived session.
   */
  private matchesUnpinnedGate(
    binding: WorkflowBinding,
    state: WorkflowInspectorGateState,
    inspection: Pick<
      InspectionUpdated["ledger"],
      "state" | "sessionId" | "adoptedAt" | "cwd" | "repoRoot"
    >,
  ): boolean {
    if (state.prKey || !binding.sessionId || inspection.state !== "open") return false;
    if (state.waitReason !== "missing_pr" && state.waitReason !== "unadopted_pr") return false;
    if (inspection.sessionId !== binding.sessionId || inspection.adoptedAt < state.enteredAt) {
      return false;
    }
    if (
      !binding.sessionRepoRoot
      || !inspection.repoRoot
      || inspection.repoRoot !== binding.sessionRepoRoot
    ) return false;
    return true;
  }

  /** Whether PR preparation was requested for the submission whose head is being compared. */
  private submissionHadPrHandoff(runId: string, submissionId: string): boolean {
    return this.store.listDeliveries(runId).some((delivery) =>
      delivery.submissionId === submissionId && delivery.kind === "pr_handoff");
  }

  private async handleInspectorFindings(
    run: WorkflowRun,
    submission: WorkflowSubmission,
    binding: WorkflowBinding,
    version: WorkflowVersion,
    state: WorkflowInspectorGateState,
    inspectorRound: number,
    findings: InspectorComment[],
    now: number,
  ): Promise<void> {
    if (version.completionPolicy.kind !== "inspector") return;
    const fingerprints = [...new Set(findings.map((row) => row.fingerprint))].sort();
    const nextState: WorkflowInspectorGateState = {
      ...state,
      failedHeadSha: state.targetHeadSha,
      reviewPosture: getInspectorPr(state.prKey!)?.reviewPosture ?? state.reviewPosture,
      waitReason: "findings",
      findingFingerprints: fingerprints,
    };
    const inspectorOnly = version.completionPolicy.onFindings === "inspector_only";
    const findingEvent = {
      prKey: state.prKey,
      targetHeadSha: state.targetHeadSha,
      ...findingFingerprintAudit(fingerprints),
      policy: version.completionPolicy.onFindings,
    };
    if (!binding.sessionId) {
      this.transitionInspectorGate(
        run,
        state,
        nextState,
        inspectorOnly ? "waiting_for_new_head" : "blocked",
        "inspector_findings",
        "inspector_findings",
        findingEvent,
        now,
      );
      return;
    }
    if (!state.prUrl || !state.targetHeadSha) return;
    const summary = this.store.runSummary(run.id);
    if (!summary) return;
    const rendered = renderInspectorFeedback({
      workflowName: summary.workflowName,
      workflowVersion: version.version,
      runId: run.id,
      submissionRound: submission.round,
      originalGoal: this.originalGoal(run.id),
      prUrl: state.prUrl,
      targetHeadSha: state.targetHeadSha,
      inspectorRound,
      reviewPosture: nextState.reviewPosture,
      policy: version.completionPolicy.onFindings,
      findings,
      workflowEvidence: versionSupportsWorkflowEvidence(version),
    });
    const deliveryId = randomUUID();
    let prepared: ReturnType<WorkflowStore["transitionInspectorFindingsWithDelivery"]>;
    try {
      prepared = this.store.transitionInspectorFindingsWithDelivery({
        runId: run.id,
        expectedState: state,
        state: nextState,
        status: inspectorOnly ? "waiting_for_new_head" : "waiting_for_session",
        findingEvent,
        delivery: {
          id: deliveryId,
          runId: run.id,
          submissionId: submission.id,
          kind: "inspector_feedback",
          sessionId: binding.sessionId,
          noteKey: binding.noteKey,
          payload: rendered.payload,
          payloadSha256: rendered.payloadSha256,
        },
        deliveryEvent: {
          deliveryId,
          payloadSha256: rendered.payloadSha256,
          ...findingFingerprintAudit(fingerprints),
          policy: version.completionPolicy.onFindings,
        },
        now,
      });
    } catch (error) {
      // The store rolled the finding state, both audits, and packet back together. Keep
      // that prior gate intact instead of letting the generic Inspector adapter handler
      // rewrite it after an atomic packet-preparation failure.
      console.error(`[workflow] Inspector feedback preparation failed for run ${run.id}: ${String(error)}`);
      return;
    }
    if (!prepared) return;
    this.publishRun(run.id);
    if (binding.deliveryMode === "live") await this.deliverPrepared(prepared.delivery.id, false);
  }

  private originalGoal(runId: string): string {
    for (const submission of this.store.listSubmissions(runId)) {
      if (submission.mode !== "full_workflow") continue;
      const parsed = WorkflowContextSnapshotSchema.safeParse(submission.context);
      if (parsed.success) return parsed.data.primaryGoal.rawPrompt;
    }
    return "(Original goal unavailable)";
  }

  private async withGateLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const before = this.gateLocks.get(runId) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const tail = before.then(() => held, () => held);
    this.gateLocks.set(runId, tail);
    await before.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.gateLocks.get(runId) === tail) this.gateLocks.delete(runId);
    }
  }

  private bindingModeBlock(
    session: Session,
    triggerMode: WorkflowBinding["triggerMode"],
    deliveryMode: WorkflowBinding["deliveryMode"],
  ): WorkflowRuntimeMutation<never> | null {
    if (deliveryMode === "live") {
      const config = getWorkflowPolicy();
      if (!config.liveEnabled || !repoAllowlisted(session.cwd, session.repoRoot, config.repoAllowlist)) {
        return {
          ok: false,
          reason: "unsupported_mode",
          message: "Live delivery requires Workflows Live mode and an allowlisted repository",
        };
      }
    }
    if (triggerMode === "foreman_complete") {
      const harness = harnessFor(session.agent);
      if (!getForemanConfig().enabled || !harness.hooks || !harness.workQueue) {
        return {
          ok: false,
          reason: "unsupported_mode",
          message: "Foreman Complete requires Foreman plus measured hook and work-queue capabilities",
        };
      }
    }
    return null;
  }

  private bindingWorkflowBlock(
    version: WorkflowVersion,
    action = "bound",
  ): WorkflowRuntimeMutation<never> | null {
    const workflow = this.store.getWorkflow(version.workflowId);
    if (!workflow) {
      return {
        ok: false,
        reason: "not_found",
        message: "The workflow for this immutable version is unavailable",
      };
    }
    if (workflow.archivedAt !== null) {
      return {
        ok: false,
        reason: "conflict",
        message: `This workflow is archived and must be restored before it can be ${action}`,
      };
    }
    return null;
  }

  private async prepareAndMaybeDeliver(submissionId: string): Promise<void> {
    const submission = this.store.getSubmission(submissionId);
    const run = submission ? this.store.getRun(submission.runId) : null;
    const binding = run ? this.store.getBinding(run.bindingId) : null;
    const version = run ? this.store.getWorkflowVersionById(run.workflowVersionId) : null;
    const summary = run ? this.store.runSummary(run.id) : null;
    if (
      !submission
      || submission.status !== "waiting_for_session"
      || !run
      || runIsTerminal(run)
      || !binding
      || !version
      || !summary
      || !binding.sessionId
    ) return;
    const rendered = renderWorkflowFeedback({
      workflowName: summary.workflowName,
      version,
      run,
      submission,
      attempts: this.store.listAttempts(submission.id),
    });
    if (rendered.failedPersonaCount === 0) return;
    const prepared = this.store.prepareDelivery({
      id: randomUUID(),
      runId: run.id,
      submissionId: submission.id,
      kind: "persona_feedback",
      sessionId: binding.sessionId,
      noteKey: binding.noteKey,
      payload: rendered.payload,
      payloadSha256: rendered.payloadSha256,
    });
    if (!prepared.idempotent) {
      this.store.appendEvent(run.id, "delivery_prepared", {
        deliveryId: prepared.delivery.id,
        payloadSha256: rendered.payloadSha256,
        truncated: rendered.truncated,
      });
    }
    this.publishRun(run.id);
    if (binding.deliveryMode === "live") await this.deliverPrepared(prepared.delivery.id, false);
  }

  private scheduleEvidenceReadinessDelivery(submissionId: string): void {
    this.trackBackgroundTask(this.prepareEvidenceReadinessDelivery(submissionId).catch((error) => {
      const submission = this.store.getSubmission(submissionId);
      if (!submission) return;
      const message = error instanceof Error ? error.message : String(error);
      this.store.setRunState(submission.runId, "blocked", "delivery_prepare_error", {
        submissionId,
        error: message,
      });
      this.store.appendEvent(submission.runId, "delivery_prepare_error", {
        submissionId,
        error: message,
      });
      this.publishRun(submission.runId);
    }));
  }

  private async prepareEvidenceReadinessDelivery(submissionId: string): Promise<void> {
    const submission = this.store.getSubmission(submissionId);
    const run = submission ? this.store.getRun(submission.runId) : null;
    const binding = run ? this.store.getBinding(run.bindingId) : null;
    const version = run ? this.store.getWorkflowVersionById(run.workflowVersionId) : null;
    const summary = run ? this.store.runSummary(run.id) : null;
    if (
      !submission
      || submission.status !== "waiting_for_evidence_readiness"
      || submission.readiness?.status !== "gaps"
      || !run
      || run.status !== "waiting_for_evidence_readiness"
      || !binding?.sessionId
      || !version
      || !summary
    ) return;
    const repository = (summary.repoRoot ?? binding.sessionCwd ?? "repository")
      .split(/[\\/]/u).filter(Boolean).at(-1) ?? "repository";
    const rendered = renderEvidenceReadinessPacket({
      workflowName: summary.workflowName,
      workflowVersion: version.version,
      runId: run.id,
      repository,
      round: submission.round,
      segment: submission.segment,
      readiness: submission.readiness,
      workflowEvidence: versionSupportsWorkflowEvidence(version),
    });
    const prepared = this.store.prepareDelivery({
      id: randomUUID(),
      runId: run.id,
      submissionId: submission.id,
      kind: "evidence_readiness",
      sessionId: binding.sessionId,
      noteKey: binding.noteKey,
      payload: rendered.payload,
      payloadSha256: rendered.payloadSha256,
    });
    if (!prepared.idempotent) {
      this.store.appendEvent(run.id, "delivery_prepared", {
        deliveryId: prepared.delivery.id,
        payloadSha256: rendered.payloadSha256,
        truncated: rendered.truncated,
        kind: "evidence_readiness",
      });
    }
    this.publishRun(run.id);
    if (binding.deliveryMode === "live") await this.deliverPrepared(prepared.delivery.id, false);
  }

  private recoverWaitingDeliveries(): void {
    for (const run of this.store.listRuns()) {
      if (run.status !== "waiting_for_pr") continue;
      const version = this.store.getWorkflowVersionById(run.workflowVersionId);
      const binding = this.store.getBinding(run.bindingId);
      const submission = this.store.latestSubmission(run.id);
      const gate = this.gateState(run);
      if (
        version?.completionPolicy.kind !== "inspector"
        || version.completionPolicy.missingPrAction !== "prepare_pr"
        || binding?.state !== "active"
        || binding.deliveryMode !== "live"
        || !binding.sessionId
        || !submission
        || gate?.waitReason !== "missing_pr"
      ) continue;
      this.scheduleAutomaticPr(run.id, submission.id);
    }
    const waitingSubmissions = this.store.listSubmissionsByState("waiting_for_session");
    const submissionRecovery = new Set(waitingSubmissions.map((submission) => submission.id));
    for (const submission of waitingSubmissions) {
      this.scheduleWaitingDelivery(submission.id);
    }
    for (const submission of this.store.listSubmissionsByState("waiting_for_evidence_readiness")) {
      this.scheduleEvidenceReadinessDelivery(submission.id);
    }
    for (const delivery of this.store.listDeliveriesByState("prepared")) {
      if (submissionRecovery.has(delivery.submissionId)) continue;
      const run = this.store.getRun(delivery.runId);
      const binding = run ? this.store.getBinding(run.bindingId) : null;
      const latestSubmission = run ? this.store.latestSubmission(run.id) : null;
      if (
        !run
        || runIsTerminal(run)
        || binding?.deliveryMode !== "live"
        || latestSubmission?.id !== delivery.submissionId
      ) continue;
      // An unchanged-evidence nudge is prepared and sent in one turn, so finding one still
      // `prepared` means the daemon stopped inside that window or the pane was briefly
      // unreachable. Its submission is `failed` rather than `waiting_for_session`, so the loop
      // above cannot see it, and without this the run stays parked on a refusal the session was
      // never told about - which is the exact dead end the nudge exists to prevent.
      if (delivery.kind === "unchanged_evidence_nudge") {
        if (run.status === "waiting_for_session" && run.currentPhase === "unchanged_evidence") {
          this.schedulePreparedDelivery(delivery.id);
        }
        continue;
      }
      const version = this.store.getWorkflowVersionById(run.workflowVersionId);
      const gate = this.gateState(run);
      const inspectorOnly =
        version?.completionPolicy.kind === "inspector"
        && version.completionPolicy.onFindings === "inspector_only";
      if (
        delivery.kind !== "inspector_feedback"
        || run.status !== (inspectorOnly ? "waiting_for_new_head" : "waiting_for_session")
        || run.currentPhase !== "inspector_findings"
        || gate?.waitReason !== "findings"
        || !gate.targetHeadSha
        || gate.targetHeadSha !== gate.failedHeadSha
      ) continue;
      this.schedulePreparedDelivery(delivery.id);
    }
  }

  /**
   * Answer an unchanged-evidence refusal with a packet instead of silence.
   *
   * Without this the loop dies on the first such refusal and never recovers. The completion
   * guard is retired inside `claimForemanCompletion`'s transaction, which commits BEFORE
   * capture runs, so by the time capture refuses the guard is already spent: the run parks in
   * `waiting_for_session` and no later completion signal from that session can ever claim it.
   *
   * Sending a packet is what restarts the clock, and it restarts it through the existing
   * machinery rather than a special case. The nudge is an ordinary delivery: queue drain may
   * re-arm explicitly, while an item-less prompted session waits for that delivered turn's
   * natural completed work-cycle generation. The next Foreman claim is therefore legitimate
   * and gated on a fresh idle plus settle, rather than firing on the next four-second tick.
   */
  private scheduleUnchangedEvidenceNudge(
    runId: string,
    submissionId: string,
    nudge: number,
  ): void {
    this.trackBackgroundTask(
      this.prepareUnchangedEvidenceNudge(runId, submissionId, nudge).catch((error) => {
        const run = this.store.getRun(runId);
        if (!run || runIsTerminal(run)) return;
        const message = error instanceof Error ? error.message : String(error);
        this.store.setRunState(runId, "blocked", "delivery_prepare_error", {
          submissionId,
          error: message,
        });
        this.store.appendEvent(runId, "delivery_prepare_error", { submissionId, error: message });
        this.publishRun(runId);
      }),
    );
  }

  private async prepareUnchangedEvidenceNudge(
    runId: string,
    submissionId: string,
    nudge: number,
  ): Promise<void> {
    const run = this.store.getRun(runId);
    const submission = this.store.getSubmission(submissionId);
    const binding = run ? this.store.getBinding(run.bindingId) : null;
    const version = run ? this.store.getWorkflowVersionById(run.workflowVersionId) : null;
    const summary = run ? this.store.runSummary(runId) : null;
    if (
      !run
      || runIsTerminal(run)
      // Re-read rather than trust the caller: a human Resubmit or the resumption observer may
      // have moved this run out of the refusal between the refusal and this task running, and
      // nudging a run that is already re-reviewing would type a stale complaint into the pane.
      || run.status !== "waiting_for_session"
      || run.currentPhase !== "unchanged_evidence"
      || !submission
      || !binding
      || binding.state !== "active"
      || !binding.sessionId
      || !version
      || !summary
    ) return;
    // The packet the session already had, so the nudge can name what was asked rather than
    // just complaining that nothing happened. Newest first; a pruned payload reads as absent
    // and the renderer says so instead of shipping an empty quote.
    const prior = [...this.store.listDeliveries(runId)].reverse().find((delivery) =>
      delivery.kind === "persona_feedback"
      && delivery.state === "delivered"
      && delivery.payload.length > 0);
    const rendered = renderUnchangedEvidenceNudge({
      workflowName: summary.workflowName,
      workflowVersion: version.version,
      runId,
      round: submission.round,
      originalGoal: this.originalGoal(runId),
      evidenceFingerprint: submission.evidenceFingerprint,
      priorPacket: prior?.payload ?? null,
      nudge,
      nudgeLimit: UNCHANGED_EVIDENCE_NUDGE_LIMIT,
      workflowEvidence: versionSupportsWorkflowEvidence(version),
    });
    const prepared = this.store.prepareDelivery({
      id: randomUUID(),
      runId,
      submissionId: submission.id,
      kind: "unchanged_evidence_nudge",
      sessionId: binding.sessionId,
      noteKey: binding.noteKey,
      payload: rendered.payload,
      payloadSha256: rendered.payloadSha256,
    });
    if (!prepared.idempotent) {
      this.store.appendEvent(runId, "delivery_prepared", {
        deliveryId: prepared.delivery.id,
        payloadSha256: rendered.payloadSha256,
        truncated: rendered.truncated,
        kind: "unchanged_evidence_nudge",
        nudge,
      });
    }
    this.publishRun(runId);
    if (binding.deliveryMode === "live") await this.deliverPrepared(prepared.delivery.id, false);
  }

  private scheduleWaitingDelivery(submissionId: string): void {
    this.trackBackgroundTask(this.prepareAndMaybeDeliver(submissionId).catch((error) => {
      const submission = this.store.getSubmission(submissionId);
      const run = submission ? this.store.getRun(submission.runId) : null;
      if (!submission || !run || runIsTerminal(run)) return;
      const message = error instanceof Error ? error.message : String(error);
      this.store.setRunState(submission.runId, "blocked", "delivery_prepare_error", {
        submissionId,
        error: message,
      });
      this.store.appendEvent(submission.runId, "delivery_prepare_error", {
        submissionId,
        error: message,
      });
      this.publishRun(submission.runId);
    }));
  }

  private scheduleAutomaticPr(runId: string, submissionId: string, now = Date.now()): void {
    this.trackBackgroundTask(
      this.preparePr(runId, `automatic:${submissionId}`, now)
        .then((result) => {
          if (result.ok) return;
          const run = this.store.getRun(runId);
          if (!run || run.status !== "waiting_for_pr") return;
          this.store.appendEvent(runId, "pr_handoff_automatic_deferred", {
            submissionId,
            reason: result.reason,
            message: result.message,
          });
          this.publishRun(runId);
        })
        .catch((error) => {
          const run = this.store.getRun(runId);
          if (!run || runIsTerminal(run)) return;
          const message = error instanceof Error ? error.message : String(error);
          this.store.setRunState(
            runId,
            "blocked",
            "pr_handoff_prepare_error",
            (this.gateState(run) as unknown as WorkflowJson | null) ?? { submissionId, error: message },
          );
          this.store.appendEvent(runId, "pr_handoff_prepare_error", {
            submissionId,
            error: message,
          });
          this.publishRun(runId);
        }),
    );
  }

  private schedulePreparedDelivery(deliveryId: string): void {
    this.trackBackgroundTask(this.deliverPrepared(deliveryId, false).catch((error) => {
      const delivery = this.store.getDelivery(deliveryId);
      const run = delivery ? this.store.getRun(delivery.runId) : null;
      if (!delivery || !run || runIsTerminal(run)) return;
      const message = error instanceof Error ? error.message : String(error);
      this.store.setRunState(
        delivery.runId,
        "blocked",
        "delivery_recovery_error",
        (this.deliveryGateState(delivery) as unknown as WorkflowJson | null) ?? {
          deliveryId,
          error: message,
        },
      );
      this.store.appendEvent(delivery.runId, "delivery_recovery_error", {
        deliveryId,
        error: message,
      });
      this.publishRun(delivery.runId);
    }));
  }

  // ---- session actions ------------------------------------------------------------------
  //
  // One authored graph node, executed as one durable side effect. The engine made the wait
  // durable; everything from here to the child evidence segment lives in this block:
  // prepare the packet from the frozen snapshot, send it under the existing consent gates,
  // prove the session picked it up, wait for that turn to settle, ask the completion adapter,
  // capture fresh evidence, and activate only the routes that completion authorizes.

  private scheduleSessionActionDelivery(attemptId: string): void {
    this.trackBackgroundTask(this.prepareSessionAction(attemptId).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.blockSessionAction(attemptId, "capture_failed", message);
    }));
  }

  /**
   * Everything a waiting action attempt needs, resolved together, or null when the attempt is
   * no longer the run's business.
   *
   * One resolver for the delivery path and the observer path so the two cannot disagree about
   * which conversation this action belongs to.
   */
  private resolveSessionAction(attemptId: string): {
    attempt: WorkflowNodeAttempt;
    snapshot: SessionActionSnapshot;
    state: SessionActionAttemptState;
    submission: WorkflowSubmission;
    run: WorkflowRun;
    binding: WorkflowBinding;
    version: WorkflowVersion;
    node: WorkflowSessionActionNode;
  } | null {
    const attempt = this.store.getAttempt(attemptId);
    if (!attempt || attempt.state !== "waiting" || !attempt.sessionAction) return null;
    const state = this.store.sessionActionState(attempt);
    // A waiting action whose own durable state will not parse is STUCK, and silently returning
    // null here is what made that invisible: the sweep looked, found nothing to resolve, and
    // left the attempt waiting forever with no reason on the run. The shape is deliberately
    // strict - a state read tolerantly could re-send a packet somebody already received - so
    // the honest answer to an unreadable one is to block for a human rather than to wait for a
    // change that cannot come. Reachable only across a daemon downgrade, and cheap to state.
    if (!state) {
      this.blockSessionAction(attempt.id, "capture_failed",
        "This action's durable progress record cannot be read by this build, so its turn "
        + "cannot be observed. Reset the run to start it again.");
      return null;
    }
    const submission = this.store.getSubmission(attempt.submissionId);
    const run = submission ? this.store.getRun(submission.runId) : null;
    if (!submission || !run || runIsTerminal(run)) return null;
    const binding = this.store.getBinding(run.bindingId);
    const version = this.store.getWorkflowVersionById(run.workflowVersionId);
    const node = version?.graph.nodes.find(
      (candidate) => candidate.id === attempt.nodeId && isSessionActionNode(candidate),
    );
    if (!binding || !version || !node || !isSessionActionNode(node)) return null;
    return { attempt, snapshot: attempt.sessionAction, state, submission, run, binding, version, node };
  }

  /**
   * Render and persist the one packet this action attempt owns.
   *
   * Preview prepares and stops. That is the whole of the Preview promise: the operator sees
   * the exact bytes, nothing is typed, no pickup watch is armed, and no later activity in
   * that session can be mistaken for the action having run.
   */
  private async prepareSessionAction(attemptId: string, now = Date.now()): Promise<void> {
    const resolved = this.resolveSessionAction(attemptId);
    if (!resolved) return;
    const { attempt, snapshot, submission, run, binding, version } = resolved;
    if (this.store.liveDeliveryForAttempt(attempt.id)) return;

    // The adapter is asked BEFORE anything is typed. A published version naming an adapter
    // this build cannot run must refuse without writing into somebody's pane, and publish
    // validation alone is not enough: a version published by a build that had the adapter can
    // be executed by one that does not.
    const adapter = sessionActionAdapter(snapshot.completion.kind);
    if (!adapter.available) {
      this.blockSessionAction(attempt.id, "adapter_unavailable", adapter.unavailableReason
        ?? "This build cannot run this session action.", now);
      return;
    }
    const snapshotProblem = adapter.validateSnapshot(snapshot);
    if (snapshotProblem) {
      this.blockSessionAction(attempt.id, "adapter_unavailable", snapshotProblem, now);
      return;
    }
    if (binding.state !== "active" || !binding.sessionId) {
      this.blockSessionAction(attempt.id, "session_lost",
        "The workflow binding is no longer active, so this action cannot be delivered.", now);
      return;
    }
    const session = this.registry.getSession(binding.sessionId);
    if (!session || session.state === "exited") {
      this.blockSessionAction(attempt.id, "session_lost",
        "The bound session is not available to run this action.", now);
      return;
    }
    // Preparation's half of the required-skill promise. `deliveryBlock` re-resolves it
    // immediately before the write; this one refuses early so an unavailable skill blocks
    // with its own reason rather than as an anonymous delivery refusal.
    let skillCommand: string | null = null;
    if (snapshot.requiredSkillId) {
      const required = this.requireSkill(session, snapshot.requiredSkillId);
      if (!required.ok) {
        this.blockSessionAction(attempt.id, "required_skill_unavailable", required.message, now);
        return;
      }
      skillCommand = required.command;
    }

    const rendered = renderSessionAction({
      origin: {
        kind: "run",
        workflowName: this.store.runSummary(run.id)?.workflowName ?? "Workflow",
        workflowVersion: version.version,
        runId: run.id,
        // Empty means the session's own checkout - see `workflow_bindings.repo_root` - and
        // the packet then names no repository at all, exactly as it did before runs could
        // be per-repository.
        repoRoot: binding.repoRoot || null,
      },
      actionName: snapshot.name,
      promptMarkdown: snapshot.promptMarkdown,
      skillCommand,
      workflowEvidence: versionSupportsWorkflowEvidence(version),
    });
    // An instruction that cannot be sent WHOLE is not sent at all. `sessionActionPromptBytes`
    // is derived from the packet budget, so an action authored through this build cannot
    // reach here; a version minted by another one blocks with a reason rather than typing a
    // prefix of somebody's instruction.
    if (!rendered.ok) {
      this.blockSessionAction(attempt.id, "prompt_too_large",
        `This action's instruction is ${rendered.bytes} bytes once addressed to the session, `
        + `over the ${rendered.limit} a single packet can carry. Shorten the action and `
        + "publish it again.",
        now);
      return;
    }
    const prepared = this.store.prepareDelivery({
      id: randomUUID(),
      runId: run.id,
      submissionId: submission.id,
      kind: "session_action",
      nodeAttemptId: attempt.id,
      sessionId: binding.sessionId,
      noteKey: binding.noteKey,
      payload: rendered.payload,
      payloadSha256: rendered.payloadSha256,
    }, now);
    if (!prepared.idempotent) {
      this.store.appendEvent(run.id, "delivery_prepared", {
        deliveryId: prepared.delivery.id,
        payloadSha256: rendered.payloadSha256,
        kind: "session_action",
        nodeId: attempt.nodeId,
        attemptId: attempt.id,
      }, now);
    }
    this.setSessionActionWait(attempt.id, "awaiting_send", {
      deliveryId: prepared.delivery.id,
    }, now);
    this.store.setRunState(run.id, "waiting_for_action", "session_action", {
      nodeId: attempt.nodeId,
      attemptId: attempt.id,
      deliveryId: prepared.delivery.id,
      action: snapshot.name,
    }, now);
    this.publishRun(run.id);
    if (binding.deliveryMode === "live") await this.deliverPrepared(prepared.delivery.id, false);
  }

  /**
   * Put a blocked action attempt back in play after its uncertain packet was resolved as
   * delivered, anchored at the moment the operator said so.
   *
   * No transcript offset is claimed, because none was ever measured: `confirmDeliverySend`
   * never ran for a packet whose send was never confirmed. Pickup therefore rests on the
   * session going active after this moment, which is the same rule every other action uses.
   */
  private reopenSessionAction(delivery: WorkflowDelivery, now: number): void {
    if (delivery.kind !== "session_action" || !delivery.nodeAttemptId) return;
    const reopened = this.store.reopenSessionActionAttempt(delivery.nodeAttemptId, {
      deliveryId: delivery.id,
      sessionId: delivery.sessionId,
      noteKey: delivery.noteKey,
      deliveredAt: delivery.deliveredAt ?? now,
      transcriptBytes: null,
    }, now);
    if (!reopened) return;
    this.store.setRunState(delivery.runId, "waiting_for_action", "session_action", {
      nodeId: reopened.nodeId,
      attemptId: reopened.id,
      deliveryId: delivery.id,
    }, now);
    this.store.appendEvent(delivery.runId, "session_action_reopened", {
      attemptId: reopened.id,
      nodeId: reopened.nodeId,
      deliveryId: delivery.id,
    }, now);
  }

  /** Move a waiting attempt's observation state forward, leaving it waiting. */
  private setSessionActionWait(
    attemptId: string,
    wait: SessionActionWaitReason,
    patch: Partial<SessionActionAttemptState> = {},
    now = Date.now(),
  ): void {
    const attempt = this.store.getAttempt(attemptId);
    const state = attempt ? this.store.sessionActionState(attempt) : null;
    if (!attempt || !state || state.wait === wait && Object.keys(patch).length === 0) return;
    this.store.updateSessionActionState(attemptId, { ...state, ...patch, wait }, now);
    // PUSHED, not merely stored. A wait reason is the answer to "why is nothing happening",
    // and until this was here it reached the database and stopped: nothing else publishes
    // while an action waits, so a run detail page that had rendered "Awaiting PR" kept saying
    // so after the daemon knew the pull request had gone to another branch. Every other state
    // this observer can reach already publishes - completion and every block do - and the
    // waits were the ones an operator sits and watches.
    //
    // Guarded by the early return above, so a sweep that changes nothing is still silent
    // rather than re-publishing the same run every fifteen seconds.
    if (state.wait !== wait) {
      const submission = this.store.getSubmission(attempt.submissionId);
      if (submission) this.publishRun(submission.runId);
    }
  }

  /** Stop a waiting action and block its run, without ever producing repair feedback. */
  private blockSessionAction(
    attemptId: string,
    code: SessionActionBlockCode,
    detail: string,
    now = Date.now(),
  ): void {
    const blocked = this.store.blockSessionActionAttempt({ attemptId, code, detail, now });
    if (!blocked) return;
    const submission = this.store.getSubmission(blocked.submissionId);
    if (submission) this.publishRun(submission.runId);
    workflowLog("error", { event: "session_action_blocked", call: attemptId, error: code });
  }

  /**
   * One pass of the action observer, over every waiting attempt this daemon owes work to.
   *
   * Driven by the same timer as the resumption sweep rather than a poller of its own: both
   * ask "has the bound session stopped?", and two loops asking that would be two answers.
   */
  async sweepSessionActions(now = Date.now()): Promise<void> {
    if (this.sessionActionSweepRunning) return;
    this.sessionActionSweepRunning = true;
    try {
      const sessions = this.registry.snapshot().sessions;
      for (const attempt of this.store.listWaitingActionAttempts()) {
        try {
          await this.observeSessionAction(attempt.id, sessions, now);
        } catch (error) {
          workflowLog("error", {
            event: "session_action_observe_failed",
            call: attempt.id,
            error: error instanceof Error ? error.name : "unknown",
          });
        }
      }
    } finally {
      this.sessionActionSweepRunning = false;
    }
  }

  /**
   * Advance one waiting action, in the only order that can be trusted.
   *
   * The target session is normally IDLE at the instant the packet is typed, so idleness is
   * not evidence of anything on its own. The sequence is therefore: a confirmed send, then a
   * signal strictly newer than the send anchor, and only then a settled idle. A stale idle
   * event, a daemon restart, or an observer that resubscribed all fail the middle step, which
   * is exactly what they should do.
   */
  private async observeSessionAction(
    attemptId: string,
    sessions: Session[],
    now: number,
  ): Promise<void> {
    const resolved = this.resolveSessionAction(attemptId);
    if (!resolved) return;
    const { attempt, snapshot, binding, run } = resolved;
    let state = resolved.state;

    const delivery = state.deliveryId ? this.store.getDelivery(state.deliveryId) : null;
    if (!delivery) return;
    // A REFUSED or CANCELLED packet is positive proof that nothing was typed, and nothing
    // about waiting longer will change that. Blocking here is what stops the attempt sitting
    // in `waiting_for_action` forever behind a generic delivery diagnostic, and what stops
    // startup recovery quietly preparing a replacement packet on every restart - an
    // automatic retry of a write the operator never re-authorized.
    if (delivery.state === "refused" || delivery.state === "cancelled") {
      this.blockSessionAction(attempt.id, "delivery_refused",
        delivery.error
          ? `This action's instruction was refused before it reached the session: ${delivery.error}`
          : "This action's instruction was refused before it reached the session.",
        now);
      return;
    }
    // An UNCERTAIN write may or may not have landed, and an action's whole contract is that
    // its exact instruction ran once - so the runtime refuses to guess in either direction.
    // It never resends, and it never counts the packet as read. `resolveDelivery`'s
    // `mark_delivered` is the operator's answer, and it reopens this attempt.
    if (delivery.state === "uncertain") {
      this.blockSessionAction(attempt.id, "delivery_uncertain",
        "It is not known whether this action's instruction reached the session. Resolve the "
        + "delivery to say whether it landed.",
        now);
      return;
    }
    // Prepared or sending: nothing has been confirmed yet. Preview parks here by design.
    if (delivery.state !== "delivered") return;
    // A packet an operator marked delivered by hand never ran `confirmDeliverySend`, so it
    // carries no anchor. Synthesize one from the resolution rather than refusing to observe:
    // the operator has asserted the instruction landed, and without an anchor the action
    // could never complete. No transcript offset is claimed, because none was measured -
    // pickup then rests on the session going active after this moment.
    const anchor = state.anchor ?? {
      deliveryId: delivery.id,
      sessionId: delivery.sessionId,
      noteKey: delivery.noteKey,
      deliveredAt: delivery.deliveredAt ?? delivery.updatedAt,
      transcriptBytes: null,
    };
    if (!state.anchor) {
      this.setSessionActionWait(attempt.id, "awaiting_pickup", { anchor }, now);
      state = { ...state, anchor };
    }

    if (binding.state !== "active" || binding.sessionId !== anchor.sessionId) {
      this.blockSessionAction(attempt.id, "session_lost",
        "The workflow binding no longer names the session this action was sent to.", now);
      return;
    }
    const session = this.registry.getSession(anchor.sessionId);
    if (!session || session.state === "exited") {
      // Deliberately NOT read as durable removal: `state === "exited"` is a linger window,
      // and `session_remove` is what the registry uses for gone. Blocking is the honest
      // answer either way - nothing can prove a turn finished in a pane nobody can read.
      this.blockSessionAction(attempt.id, "session_lost",
        "The bound session exited before this action's turn could be observed.", now);
      return;
    }
    if (noteKeyFor(session) !== anchor.noteKey) {
      this.blockSessionAction(attempt.id, "conversation_changed",
        "The session started a different conversation after this action was sent.", now);
      return;
    }

    const pickedUpAt = state.pickedUpAt ?? this.sessionActionPickup(session, state);
    if (pickedUpAt === null) {
      this.setSessionActionWait(attempt.id, "awaiting_pickup", {}, now);
      return;
    }
    if (state.pickedUpAt === null) {
      this.setSessionActionWait(attempt.id, "working", { pickedUpAt }, now);
    }
    // A session parked on a question reads as idle and is the last thing that should be
    // treated as a finished turn - it has not started, it is stuck on a human.
    if (reportBucket(session, sessions) === "needs-you") {
      this.setSessionActionWait(attempt.id, "needs_operator", { pickedUpAt }, now);
      return;
    }
    if (!settledIdle(session, now, this.options.resumptionSettleMs ?? WORKFLOW_RESUMPTION_SETTLE_MS)) {
      this.setSessionActionWait(attempt.id, "working", { pickedUpAt }, now);
      return;
    }

    // Read the checkout only once the turn has settled. Every earlier return above is a
    // cheaper answer, and an observer that shelled out to git for each waiting action on each
    // sweep would pay for three `rev-parse` calls per action per fifteen seconds to answer a
    // question that only matters at this line.
    //
    // The RUN'S checkout, which for a secondary-repository run is its own worktree. The
    // `pull_request` adapter compares its repository identity and branch against the adoption
    // ledger, so reading the session's cwd here would hold repo B's action to repo A's pull
    // request - waiting forever on a proof that belongs to another review.
    const repository = await (this.options.readRepositoryHead ?? readWorkflowRepositoryHead)(
      workflowCheckoutPath(binding, session),
    ).catch(() => null);
    // The head a reserved child has already captured, if one has. See `capturedHeadOid`.
    const capturedChild = state.continuationSubmissionId
      ? this.store.getSubmission(state.continuationSubmissionId)
      : null;
    const capturedHeadOid = capturedChild
      ? await this.capturedContinuationHead(capturedChild, repository?.root ?? null)
      : null;
    const decision = sessionActionAdapter(snapshot.completion.kind).decide({
      snapshot,
      session,
      anchorTranscriptBytes: anchor.transcriptBytes,
      deliveredAt: anchor.deliveredAt,
      pickedUpAt,
      settledAt: now,
      now,
      repository,
      adoptedPullRequests: await this.adoptedPullRequestsForAction(anchor.deliveredAt),
      capturedHeadOid,
    });
    if (decision.kind === "blocked") {
      this.blockSessionAction(attempt.id, decision.code, decision.detail, now);
      return;
    }
    if (decision.kind === "waiting") {
      this.setSessionActionWait(attempt.id, decision.reason, { pickedUpAt, settledAt: now }, now);
      return;
    }
    this.setSessionActionWait(attempt.id, "capturing", {
      pickedUpAt,
      settledAt: now,
      expectation: decision.continuationExpectation,
    }, now);
    this.publishRun(run.id);
    await this.captureSessionActionContinuation(attempt.id, now);
  }

  /**
   * Re-observe every action whose completion depends on the adoption ledger.
   *
   * Narrowed by completion kind rather than sweeping everything: a `session_turn` action's
   * decision cannot change because a pull request somewhere moved, and re-deciding it would
   * be work with no possible outcome. Failures are swallowed per attempt for the sweep's
   * reason - one unreadable checkout must not stop the others being looked at.
   */
  private scheduleSessionActionProofCheck(): void {
    const now = Date.now();
    for (const attempt of this.store.listWaitingActionAttempts()) {
      if (!attempt.sessionAction) continue;
      if (!completionWatchesPullRequests(attempt.sessionAction.completion.kind)) continue;
      const sessions = this.registry.snapshot().sessions;
      this.trackBackgroundTask(
        this.observeSessionAction(attempt.id, sessions, now).catch((error) => {
          workflowLog("error", {
            event: "session_action_observe_failed",
            call: attempt.id,
            error: error instanceof Error ? error.name : "unknown",
          });
        }),
      );
    }
  }

  /**
   * The adoption ledger, narrowed to what a completion proof may consider.
   *
   * Read fresh on every decision rather than cached: the poller writes to it from its own
   * timer, and a cached copy is exactly how an action would keep waiting for a head that had
   * already arrived.
   *
   * `observedSince` is this action's delivery instant, and it is what makes a CLOSED pull
   * request reachable at all. The poller retires a closed row in the statement after the one
   * that records the closure, so the open set loses it on the very tick the adapter needed to
   * see it - and a durable contradiction that should block would report as an ordinary missing
   * pull request and wait for ever. Anything retired before this action was even delivered
   * stays out, so the extra set is approximately zero rows and the cost stays the open set's:
   * one repository-identity resolution per DISTINCT root, which is a git subprocess.
   */
  private async adoptedPullRequestsForAction(
    observedSince: number,
  ): Promise<readonly SessionActionAdoptedPullRequest[]> {
    if (this.options.adoptedPullRequests) return this.options.adoptedPullRequests();
    // One git call per DISTINCT root, not per pull request: several open pull requests on one
    // repository are the ordinary case, and this runs on the settle path of every waiting
    // action.
    const identities = new Map<string, string | null>();
    const identify = async (root: string | null): Promise<string | null> => {
      if (!root) return null;
      if (!identities.has(root)) {
        identities.set(root, await (this.options.readRepositoryId ?? readWorkflowRepositoryId)(root));
      }
      return identities.get(root) ?? null;
    };
    // Open adoptions PLUS any retired since this action's packet was delivered. The poller
    // retires a closed pull request on the same tick it first observes the closure, so without
    // the second half the adapter could never reach the one state it is meant to block on.
    const rows = loadAdoptedInspectorPrsSince(observedSince);
    const resolved = await Promise.all(rows.map((pr) => identify(pr.repoRoot)));
    return rows.map((pr, index) => ({
      key: pr.key,
      url: pr.url,
      number: pr.number,
      repositoryRoot: resolved[index] ?? null,
      branch: pr.headRefName,
      observedHeadOid: pr.observedHeadSha,
      observedState: pr.observedState,
      observedAt: pr.observedAt,
      sessionId: pr.sessionId,
      adoptedAt: pr.adoptedAt,
    }));
  }

  /**
   * The commit a captured child segment holds, as a full object id.
   *
   * Null whenever that cannot be established - the context will not parse, the repository is
   * unreadable, or the stored abbreviation names no single commit. Every caller treats null as
   * "not proven", which keeps the action waiting rather than sealing a continuation whose
   * commit nobody could name.
   */
  private async capturedContinuationHead(
    child: WorkflowSubmission,
    repositoryRoot: string | null,
  ): Promise<string | null> {
    const context = WorkflowContextSnapshotSchema.safeParse(child.context);
    const headSha = context.success ? context.data.evidence.headSha : null;
    if (!headSha || !repositoryRoot) return null;
    const resolve = this.options.resolveCommit ?? resolveCapturedCommit;
    return resolve(repositoryRoot, headSha).catch(() => null);
  }

  /**
   * When the session picked this packet up, or null when nothing proves it did.
   *
   * The transcript is the strong signal and the only one the SWEEP can use: bytes written
   * past the offset recorded at send are durable, survive a restart, and cannot be produced
   * by anything except the session writing. It is compared against the anchor rather than
   * against "now", which is what makes a pre-send idle unable to satisfy it.
   *
   * An activity TIMESTAMP after the send is deliberately NOT accepted here, and that is the
   * subtle one. A turn that was already in flight when the packet was typed ends with its own
   * activity update and its own idle transition - strictly after the anchor, and about work
   * the action had nothing to do with. Sampling that on a sweep would satisfy pickup and
   * settle in the same instant, completing an action nobody had read. Reaching an ACTIVE
   * state after the anchor is the honest fallback, and it is recorded by
   * `noteSessionActionActivity` off the session lifecycle stream, which sees every transition
   * rather than whatever a fifteen-second sweep happens to land on.
   */
  private sessionActionPickup(session: Session, state: SessionActionAttemptState): number | null {
    const anchor = state.anchor;
    if (!anchor || anchor.transcriptBytes === null) return null;
    const transcript = sessionMessages(session);
    const size = transcript ? transcript.read.size(transcript.path) : null;
    return size !== null && size > anchor.transcriptBytes ? anchor.deliveredAt : null;
  }

  /**
   * Record pickup the moment the bound session goes ACTIVE after a confirmed send.
   *
   * Driven by the registry's own session stream - the existing lifecycle source, not a second
   * poller - because a turn can start and finish between two sweeps. A sampled observer would
   * miss that entirely on a harness with no readable transcript, and the action would wait
   * forever for proof that had already come and gone.
   *
   * `agentActive` and a `lastActivity` past the anchor are both required. Active alone could
   * be a turn already running when the packet landed; a timestamp alone is what that same
   * turn's completion produces.
   */
  private noteSessionActionActivity(session: Session): void {
    if (!agentActive(session)) return;
    for (const attempt of this.store.waitingActionAttemptsForSession(session.id)) {
      const state = this.store.sessionActionState(attempt);
      if (!state?.anchor || state.pickedUpAt !== null) continue;
      if (noteKeyFor(session) !== state.anchor.noteKey) continue;
      const activity = session.lastActivity ?? null;
      if (activity === null || activity <= state.anchor.deliveredAt) continue;
      this.store.updateSessionActionState(attempt.id, {
        ...state,
        wait: "working",
        pickedUpAt: activity,
      });
      this.store.appendEvent(
        this.store.getSubmission(attempt.submissionId)?.runId ?? "",
        "session_action_picked_up",
        { attemptId: attempt.id, nodeId: attempt.nodeId, at: activity },
      );
    }
  }

  /**
   * Reserve, capture, and activate the child evidence segment one completed action earns.
   *
   * Reservation is its own transaction and commits FIRST, so `(run, round, segment + 1)` is a
   * database fact before git or a model is asked anything. Capture then fills that reserved
   * row, and the attempt-plus-receipt commit happens in one more transaction. A crash at any
   * of the three boundaries resumes the same reservation rather than opening a second one.
   */
  private async captureSessionActionContinuation(attemptId: string, now: number): Promise<void> {
    const resolved = this.resolveSessionAction(attemptId);
    if (!resolved) return;
    const { attempt, snapshot, state, submission, binding, version, node } = resolved;
    const reservation = this.store.reserveSessionActionContinuation({
      attemptId: attempt.id,
      submissionId: randomUUID(),
      // Idempotent on the PARENT's identity, which exists before the child does. Two
      // overlapping sweeps, or a restart mid-capture, resolve to the same reserved row.
      triggerKey: `session_action:${attempt.id}:${submission.evidenceFingerprint}`,
      now,
    });
    if (!reservation.ok) {
      if (reservation.reason === "parent_superseded" || reservation.reason === "already_continued") {
        this.setSessionActionWait(attempt.id, "awaiting_proof", {}, now);
      }
      return;
    }
    const child = reservation.submission;
    this.publishRun(child.runId);
    const run = this.store.getRun(child.runId);
    if (!run) return;
    const expectation = state.expectation ?? { kind: "none" as const };
    const adapter = sessionActionAdapter(snapshot.completion.kind);
    // Resolved once, from the binding's own record of the repository, rather than per seal.
    // `binding.sessionRepoRoot` is the same root the Inspector gate matches adoptions against,
    // so the two cannot disagree about which repository a run belongs to.
    const captureRoot = binding.sessionRepoRoot ?? null;
    // A child that is already captured cannot be captured again - the capture guard requires
    // the run and the submission to both be `capturing`, and a completed capture left neither.
    // It gets here when a previous pass captured the evidence and the adapter then refused it,
    // which is the ordinary shape of "HEAD moved between the proof and the capture": the
    // observer has since re-decided against the head this child actually holds, so the only
    // thing left to do is re-check that fresh expectation against the evidence that exists.
    // Without this the run would sit in `awaiting_proof` forever, re-reserving a row it could
    // never refill.
    if (child.status !== "capturing") {
      if (await this.sealCapturedContinuation(attempt.id, child)) return;
      workflowLog("error", {
        event: "session_action_continuation_unsealed",
        call: attempt.id,
        error: child.status,
      });
      return;
    }
    const captured = await this.captureAndActivate(
      binding,
      run,
      child,
      // No previous fingerprint and `allowUnchanged`: an action may legitimately change only
      // remote or conversation state, so an unchanged checkout is a real outcome rather than
      // the refusal an unchanged REPAIR round is. The repair loop's nudge machinery must not
      // fire for it.
      undefined,
      true,
      undefined,
      (capturedSubmission) => this.sealSessionActionContinuation({
        attempt,
        snapshot,
        version,
        node,
        expectation,
        adapter,
        child: capturedSubmission,
        repositoryRoot: captureRoot,
      }),
    );
    if (!captured.ok) {
      workflowLog("error", {
        event: "session_action_continuation_failed",
        call: attempt.id,
        error: captured.reason,
      });
    }
    this.publishRun(child.runId);
  }

  /**
   * Validate the captured evidence and, if it satisfies the adapter, close the attempt and
   * seed its `complete` route. Returns false when the graph must NOT advance.
   *
   * Extracted because it has two callers, and the second is the one that matters: a daemon
   * that stopped between "the child's evidence is durable" and "the receipt is written" leaves
   * a captured child with a still-waiting attempt. Re-capturing that is not an option - the
   * capture guard requires the run and submission to be `capturing`, and neither is any more -
   * so recovery has to be able to seal an already-captured child directly.
   */
  private async sealSessionActionContinuation(input: {
    attempt: WorkflowNodeAttempt;
    snapshot: SessionActionSnapshot;
    version: WorkflowVersion;
    node: WorkflowSessionActionNode;
    expectation: SessionActionContinuationExpectation;
    adapter: ReturnType<typeof sessionActionAdapter>;
    child: WorkflowSubmission;
    /** Where to resolve the captured abbreviation, or null when it cannot be resolved. */
    repositoryRoot: string | null;
  }): Promise<boolean> {
    const { attempt, snapshot, version, node, expectation, adapter, child } = input;
    const context = WorkflowContextSnapshotSchema.safeParse(child.context);
    if (!context.success) {
      this.blockSessionAction(attempt.id, "capture_failed",
        "The continuation evidence could not be read back after capture.", Date.now());
      return false;
    }
    const capture: SessionActionCaptureFacts = {
      context: context.data,
      capturedHeadOid: await this.capturedContinuationHead(child, input.repositoryRoot),
    };
    const problem = adapter.validateCapture(expectation, capture);
    if (problem) {
      // Deliberately a WAIT rather than a block when the expectation has simply not been met
      // yet: the child row stays reserved, nothing downstream activates, and the next sweep
      // re-checks. A block here would end a run for a race.
      this.setSessionActionWait(attempt.id, "awaiting_proof", {}, Date.now());
      this.store.appendEvent(child.runId, "session_action_expectation_unmet", {
        attemptId: attempt.id,
        submissionId: child.id,
        detail: problem,
      }, Date.now());
      return false;
    }
    const receipts = sessionActionCompleteEdges(version.graph, node.id).map((edge) => ({
      edgeId: edge.id,
      payload: workflowJson({
        outcome: "complete",
        action: snapshot.name,
        nodeId: node.id,
        completion: snapshot.completion.kind,
      }),
    }));
    return Boolean(this.store.completeSessionActionContinuation({
      attemptId: attempt.id,
      submissionId: child.id,
      receipts,
      now: Date.now(),
    }));
  }

  private trackBackgroundTask(task: Promise<void>): void {
    this.backgroundTasks.add(task);
    void task.then(
      () => this.backgroundTasks.delete(task),
      () => this.backgroundTasks.delete(task),
    );
  }

  /**
   * Which skill this packet's first line has to still resolve to, or null when it names none.
   *
   * The two kinds answer from different places on purpose. A `pr_handoff` was produced by the
   * completion policy, which knows only one skill, so the id is the constant. A `session_action`
   * carries whatever its published snapshot named - including nothing, which is the ordinary
   * case for an operator's own action.
   */
  private deliverySkillId(delivery: WorkflowDelivery): string | null {
    if (delivery.kind === "pr_handoff") return PULL_REQUEST_SKILL;
    if (delivery.kind !== "session_action" || !delivery.nodeAttemptId) return null;
    return this.store.getAttempt(delivery.nodeAttemptId)?.sessionAction?.requiredSkillId ?? null;
  }

  private deliveryBlock(delivery: WorkflowDelivery, expectedPane?: string | null): string | null {
    const run = this.store.getRun(delivery.runId);
    if (!run || runIsTerminal(run)) return "run_terminal";
    const binding = run ? this.store.getBinding(run.bindingId) : null;
    if (!binding || binding.state !== "active") return "binding_not_active";
    if (binding.noteKey !== delivery.noteKey) return "conversation_changed";
    if (binding.sessionId !== delivery.sessionId) return "session_retargeted";
    const session = this.registry.getSession(delivery.sessionId);
    if (!session || session.state === "exited") return "session_unavailable";
    if (noteKeyFor(session) !== delivery.noteKey) return "conversation_changed";
    // The SECOND required-skill gate, and the reason there are two: the packet was rendered
    // when it was prepared, and a skill can be switched off, uninstalled or re-linked between
    // then and the write. Re-resolving here and comparing the prefix is what stops a prepared
    // packet invoking a command that no longer means what it did.
    //
    // ONE check over both delivery kinds, because the rule is one rule. Where the required
    // skill comes FROM differs and that is the whole difference: a legacy PR handoff is
    // hard-wired to the pull-request skill by the completion policy that produced it, while an
    // action reads its ATTEMPT's frozen snapshot - never the live library, so an edit to the
    // action cannot change what an in-flight run demands.
    if (delivery.kind === "session_action") {
      const attempt = delivery.nodeAttemptId ? this.store.getAttempt(delivery.nodeAttemptId) : null;
      if (!attempt || attempt.state !== "waiting" || !attempt.sessionAction) {
        return "session_action_not_waiting";
      }
    }
    const requiredSkillId = this.deliverySkillId(delivery);
    if (requiredSkillId) {
      const required = this.requireSkill(session, requiredSkillId);
      if (!required.ok) return "required_skill_unavailable";
      if (!delivery.payload.startsWith(`${required.command}\n`)) {
        return "required_skill_invocation_stale";
      }
    }
    if (expectedPane !== undefined && paneToken(session) !== expectedPane) return "pane_recreated";
    if (this.registry.sessionResetInProgress(session.id)) return "reset_in_progress";
    const config = getWorkflowPolicy();
    if (!config.liveEnabled || !repoAllowlisted(session.cwd, session.repoRoot, config.repoAllowlist)) {
      return "live_not_authorized";
    }
    return this.registry.promptResourceBlockerForSession(session.id);
  }

  /**
   * The delivery another of this conversation's reviews is still owed a turn for, or null
   * when the pane is free.
   *
   * A multi-repo task's session runs one review per repository it changed, and they share one
   * pane, one transcript and one turn. At most one may have a packet outstanding: two
   * instructions typed into one conversation interleave into a turn neither expects, and the
   * transcript anchor that proves a packet was picked up cannot say which of them the session
   * answered. Within a run, two ready actions are still REFUSED rather than serialized - that
   * contract is per run and is unchanged; this one is between runs, where serializing is the
   * only available answer because the runs are genuinely independent reviews.
   *
   * A conversation with one active binding - every single-repo session - returns null from
   * the first line and pays one indexed read, so nothing about its delivery path moves.
   *
   * What counts as outstanding is "the session still owes this packet a turn":
   *
   *  - `sending`: being typed right now, and the only truly concurrent case.
   *  - a delivered SESSION ACTION whose attempt is still waiting: the instruction has been
   *    read and the action has not completed.
   *  - a delivered REPAIR PACKET on a run still parked on the submission it was sent for:
   *    the agent is repairing that repository, and handing it a second repository's findings
   *    mid-repair is the interleaving this exists to prevent.
   *
   * Deliberately NOT outstanding: `refused`, `uncertain` and `cancelled`. Each of those
   * belongs to a run that is blocked waiting on a person, and a queue that held every sibling
   * behind a blocked run would turn one operator's unanswered question into a stalled fleet.
   */
  private conversationDeliveryHold(delivery: WorkflowDelivery): WorkflowDelivery | null {
    const bindings = this.store.activeBindingsForNote(delivery.noteKey);
    if (bindings.length < 2) return null;
    for (const binding of bindings) {
      const run = this.store.activeRunForBinding(binding.id);
      if (!run || run.id === delivery.runId || runIsTerminal(run)) continue;
      const latest = this.store.latestSubmission(run.id);
      for (const other of this.store.listDeliveries(run.id)) {
        if (other.state === "sending") return other;
        if (other.state !== "delivered") continue;
        if (other.kind === "session_action") {
          const attempt = other.nodeAttemptId ? this.store.getAttempt(other.nodeAttemptId) : null;
          if (attempt?.state === "waiting") return other;
          continue;
        }
        if (run.status === "waiting_for_session" && other.submissionId === latest?.id) return other;
      }
    }
    return null;
  }

  /**
   * Hold a packet behind the sibling review currently using the conversation's turn.
   *
   * The packet stays `prepared`, which is exactly what it is: rendered, authorized, and not
   * typed. Nothing is refused and nothing is discarded, so when the hold clears the same
   * bytes are sent - `prepareDelivery` is content-addressed, and re-offering a prepared
   * packet is the path daemon restart already uses.
   *
   * A session action additionally records `queued_for_conversation` on its waiting attempt,
   * which is what puts the wait on the run's chip and in its detail rather than leaving an
   * operator looking at a review that appears to be doing nothing.
   */
  private queueDeliveryBehind(delivery: WorkflowDelivery, hold: WorkflowDelivery): void {
    const now = Date.now();
    if (delivery.kind === "session_action" && delivery.nodeAttemptId) {
      const attempt = this.store.getAttempt(delivery.nodeAttemptId);
      const state = attempt ? this.store.sessionActionState(attempt) : null;
      if (attempt?.state === "waiting" && state?.wait !== "queued_for_conversation") {
        this.setSessionActionWait(attempt.id, "queued_for_conversation", {}, now);
      }
    }
    // Once per hold episode. The re-offer sweep runs on ordinary session activity, so an
    // unguarded append would write an event every couple of seconds for as long as a
    // repository waits its turn.
    if (this.queuedDeliveries.has(delivery.id)) return;
    this.queuedDeliveries.add(delivery.id);
    this.store.appendEvent(delivery.runId, "delivery_queued", {
      deliveryId: delivery.id,
      kind: delivery.kind,
      heldByRunId: hold.runId,
      heldByDeliveryId: hold.id,
    }, now);
    this.publishRun(delivery.runId);
  }

  /**
   * Drop queued ids the queue has no further claim on, BY DELIVERY rather than by binding.
   *
   * Keyed the way the set itself is keyed, which is the whole point. The re-offer sweep below
   * reaches deliveries through active bindings and their non-terminal runs, so a run that went
   * terminal while one of its packets waited - its binding archived, its run cancelled, while
   * a sibling repository still owned the pane - is never walked again, and its id would sit in
   * the set for the life of the process. Asking each id about its own delivery has no such
   * blind spot: a delivery that was cancelled with its run, or vanished with a reset, drops
   * here.
   *
   * Cheap when there is nothing queued, which is nearly always: an empty set iterates zero
   * times, and a non-empty one holds one entry per packet currently waiting its turn across
   * the whole fleet. It runs before the sweep's own early return so a conversation that has
   * dropped back to a single binding still gets its ids cleaned up.
   */
  private pruneQueuedDeliveries(): void {
    for (const id of this.queuedDeliveries) {
      const delivery = this.store.getDelivery(id);
      if (!delivery || delivery.state !== "prepared") this.queuedDeliveries.delete(id);
    }
  }

  /**
   * Re-offer the packets this conversation's other reviews are holding.
   *
   * Called wherever a hold can end - a turn moving on, a repair being resubmitted - and cheap
   * enough to call on ordinary session activity because it leaves immediately for any
   * conversation with one active binding.
   *
   * Strictly the packets THIS process queued, never every prepared one. `prepared` is also
   * the resting state of a Preview packet and of packets whose own conditions have not been
   * met, and `recoverWaitingDeliveries` decides which of those may be sent with a much
   * narrower rule than this sweep could restate. Re-offering an arbitrary prepared packet
   * here would send one that rule deliberately holds.
   *
   * That is also why nothing needs to survive a restart. Recovery re-offers what it allows,
   * each offer passes back through `conversationDeliveryHold`, and a packet still behind a
   * sibling re-enters the queue there - the queue re-derived from persisted state rather
   * than remembered.
   *
   * It re-offers rather than decides: `deliverPrepared` re-runs the consent gate and asks
   * `conversationDeliveryHold` again, so a packet re-offered while the pane is still busy
   * simply queues again.
   */
  private scheduleQueuedDeliveries(noteKey: string): void {
    this.pruneQueuedDeliveries();
    const bindings = this.store.activeBindingsForNote(noteKey);
    if (bindings.length < 2) return;
    for (const binding of bindings) {
      if (binding.deliveryMode !== "live") continue;
      const run = this.store.activeRunForBinding(binding.id);
      if (!run || runIsTerminal(run)) continue;
      for (const delivery of this.store.listDeliveries(run.id)) {
        if (!this.queuedDeliveries.has(delivery.id)) continue;
        this.schedulePreparedDelivery(delivery.id);
      }
    }
  }

  private async deliverPrepared(deliveryId: string, explicitRetry: boolean): Promise<void> {
    const delivery = this.store.getDelivery(deliveryId);
    if (!delivery) return;
    if (delivery.state !== "prepared" && !(explicitRetry && delivery.state === "refused")) return;
    const initialBlock = this.deliveryBlock(delivery);
    if (initialBlock) {
      const retainPrepared = [
        "binding_not_active",
        "conversation_changed",
        "session_retargeted",
        "session_unavailable",
      ].includes(initialBlock);
      if (!retainPrepared) {
        const refused = this.store.refuseDeliveryBeforeSend(
          delivery.id,
          initialBlock,
          explicitRetry,
        );
        if (!refused) return;
      }
      this.store.setRunState(
        delivery.runId,
        "blocked",
        "delivery_blocked",
        (this.deliveryGateState(delivery) as unknown as WorkflowJson | null) ?? {
          deliveryId: delivery.id,
          reason: initialBlock,
        },
      );
      this.store.appendEvent(delivery.runId, "delivery_refused", {
        deliveryId: delivery.id,
        reason: initialBlock,
        writeAttempted: false,
      });
      this.publishRun(delivery.runId);
      return;
    }
    // AFTER the consent gate and before the first byte. A packet that is going to be refused
    // should be refused now rather than after waiting its turn, and a packet that is going to
    // be typed must not be typed while a sibling repository's review still owns the turn.
    const hold = this.conversationDeliveryHold(delivery);
    if (hold) {
      this.queueDeliveryBehind(delivery, hold);
      return;
    }
    this.queuedDeliveries.delete(delivery.id);
    const sending = this.store.claimDeliverySend(delivery.id, explicitRetry);
    if (!sending) return;
    const session = this.registry.getSession(sending.sessionId);
    if (!session) {
      this.store.finishDeliverySend(sending.id, "refused", "session_unavailable");
      return;
    }
    const expectedPane = paneToken(session);
    this.store.appendEvent(sending.runId, "delivery_sending", { deliveryId: sending.id });
    let result: InjectResult;
    try {
      result = await this.inject(
        session,
        sending.payload,
        undefined,
        () => this.deliveryBlock(sending, expectedPane),
      );
    } catch (error) {
      this.markDeliveryUncertain(sending, error instanceof Error ? error.message : String(error));
      return;
    }
    if (!result.ok) {
      if (result.pasted === false) {
        const reason = result.paneBlocked ? "pane_blocked" : (result.error ?? "delivery_refused");
        const refused = this.store.finishDeliverySend(sending.id, "refused", reason);
        if (!refused) return;
        this.store.setRunState(
          sending.runId,
          "blocked",
          "delivery_refused",
          (this.deliveryGateState(sending) as unknown as WorkflowJson | null) ?? {
            deliveryId: sending.id,
            reason,
          },
        );
        this.store.appendEvent(sending.runId, "delivery_refused", {
          deliveryId: sending.id,
          reason,
          paneBlocked: Boolean(result.paneBlocked),
          writeAttempted: true,
        });
        this.publishRun(sending.runId);
        return;
      }
      this.markDeliveryUncertain(sending, result.error ?? "delivery_outcome_unknown");
      return;
    }
    const transcript = sessionMessages(session);
    const transcriptAnchor = transcript ? transcript.read.size(transcript.path) : null;
    const confirmed = this.store.confirmDeliverySend(
      sending.id,
      transcriptAnchor,
      result.submitVerified,
    );
    if (!confirmed) return;
    this.rememberInjection(session.id, sending.payload, "workflow");
    if (confirmed.rearmed) this.queues.refresh(sending.noteKey);
    this.publishRun(sending.runId);
  }

  private markDeliveryUncertain(delivery: WorkflowDelivery, reason: string): void {
    const uncertain = this.store.finishDeliverySend(delivery.id, "uncertain", reason);
    if (!uncertain) return;
    this.store.setRunState(
      delivery.runId,
      "blocked",
      "delivery_uncertain",
      (this.deliveryGateState(delivery) as unknown as WorkflowJson | null) ?? {
        deliveryId: delivery.id,
        reason,
      },
    );
    this.store.appendEvent(delivery.runId, "delivery_uncertain", {
      deliveryId: delivery.id,
      reason,
    });
    this.publishRun(delivery.runId);
  }

  private deliveryGateState(delivery: WorkflowDelivery): WorkflowInspectorGateState | null {
    if (delivery.kind === "persona_feedback") return null;
    const run = this.store.getRun(delivery.runId);
    return run ? this.gateState(run) : null;
  }

  private deliveryActionEvent(runId: string, kind: string, requestId: string): boolean {
    return this.store.listEvents(runId).some((event) =>
      event.kind === kind
      && event.payload
      && !Array.isArray(event.payload)
      && typeof event.payload === "object"
      && event.payload.requestId === requestId);
  }

  /**
   * `beforeActivate` is the seam a continuation commits through.
   *
   * It runs after the captured evidence is durable and runnable, and before the engine
   * activates anything, which is the only window where the child segment's own receipts can
   * be seeded atomically with closing the action attempt. Returning false leaves the capture
   * persisted and the graph untouched - a diagnosable waiting state rather than a run that
   * advanced on evidence its expectation had not matched.
   */
  private async captureAndActivate(
    binding: WorkflowBinding,
    run: WorkflowRun,
    submission: WorkflowSubmission,
    previousFingerprint?: string,
    allowUnchanged = false,
    expectation?: WorkflowCaptureExpectation,
    // Awaited, because the one guard that uses it has to ask git which commit the capture
    // actually holds before it can say whether the capture is the one the adapter proved.
    beforeActivate?: (captured: WorkflowSubmission) => boolean | Promise<boolean>,
  ): Promise<WorkflowRuntimeMutation<WorkflowSubmitResult>> {
    try {
      // A run leaving `waiting_for_session` releases the turn its repair packet was holding.
      // Scheduled before the capture lock rather than after the capture, because a sibling
      // that has been waiting should be offered the pane at the moment this run stops owing
      // it one - not once this run has finished reading git.
      this.scheduleQueuedDeliveries(binding.noteKey);
      return await this.withCaptureLock(binding.noteKey, async () => {
      if (!this.captureIsActive(run.id, submission.id)) {
        return {
          ok: false,
          reason: "conflict",
          message: "The workflow submission stopped before evidence capture began",
          current: this.store.getRun(run.id),
        };
      }
      const captured = await captureStableWorkflowContext(
        () => (this.options.readContextRaw ?? readWorkflowContextRaw)(
          this.registry,
          binding,
          this.priorFeedback(run.id),
        ),
        (candidate) => (this.options.boundaryChanged ?? captureBoundaryChanged)(
          this.registry,
          binding,
          candidate.boundary,
        ),
      );
      if (!this.captureIsActive(run.id, submission.id)) {
        return {
          ok: false,
          reason: "conflict",
          message: "The workflow submission stopped during evidence capture",
          current: this.store.getRun(run.id),
        };
      }
      if (!captured) {
        this.store.setSubmissionState(submission.id, "failed", Date.now());
        this.store.setRunState(run.id, "blocked", "stale_capture", {
          error: "Session identity, HEAD, or transcript changed during both capture attempts",
        }, Date.now());
        this.store.appendEvent(run.id, "capture_stale", { submissionId: submission.id }, Date.now());
        this.publishRun(run.id);
        return {
          ok: false,
          reason: "stale_capture",
          message: "The session changed during evidence capture; submit again when it is stable",
        };
      }
      // An externally sourced submission proves it captured the artifact it was told to,
      // and it proves it HERE: before the raw evidence is persisted and before a single
      // provider token is spent. A matching HEAD is not enough - uncommitted changes would
      // put work into the review that the caller never selected - so the tree must be clean
      // too. Blocking is visible, typed and resumable rather than fatal, because the fix is
      // for the caller to restore its artifact and ask again on this same submission.
      const mismatch = expectation ? expectationMismatch(expectation, captured.context) : null;
      if (mismatch) {
        this.store.setSubmissionState(submission.id, "failed", Date.now());
        this.store.setRunState(run.id, "blocked", "external_artifact_mismatch", mismatch, Date.now());
        this.store.appendEvent(run.id, "external_artifact_mismatch", {
          submissionId: submission.id,
          ...mismatch,
        }, Date.now());
        this.publishRun(run.id);
        return {
          ok: false,
          reason: "artifact_mismatch",
          message:
            "The session is not at the expected commit with a clean working tree; "
            + "restore the exact artifact and submit the same result again",
          current: mismatch,
        };
      }
      // The reservation was frozen with the submission. Re-open those sources and copy their
      // bytes into daemon-owned immutable storage after the external artifact guard, but
      // before raw context is persisted or the compaction model can spend a token.
      const frozenCoverage = this.store.listSubmissionCoverage(submission.id);
      const reservedEvidence = this.store.listReservedWorkflowEvidence(submission.id);
      const submissionImages = await captureSubmissionImages(this.store, submission.id);
      const submissionArtifacts = await captureSubmissionTextArtifacts(this.store, submission.id);
      const reservedSubmission = this.store.getSubmission(submission.id) ?? submission;
      captured.raw.evidence = {
        ...captured.raw.evidence,
        images: submissionImages,
        artifacts: submissionArtifacts,
        stagedImageGeneration: reservedSubmission.stagedImageGeneration ?? 0,
      };
      captured.raw.coverage = frozenCoverage;
      captured.raw.evidenceMetadata = reservedEvidence.map((item) => ({
        clientItemId: item.clientItemId,
        kind: item.evidenceKind === "image" ? "image" : "artifact",
        caption: item.caption,
        repositoryScope: item.repositoryScope,
        exitCode: item.commandExitCode ?? null,
      }));
      captured.context.evidence = {
        ...captured.context.evidence,
        images: submissionImages,
        artifacts: submissionArtifacts,
        stagedImageGeneration: reservedSubmission.stagedImageGeneration ?? 0,
      };
      // Persist bounded raw intent and evidence before the advisory model call.
      this.store.updateSubmissionCapture(submission.id, {
        context: workflowJson(captured.context),
        evidence: workflowJson(captured.context.evidence),
      }, Date.now());
      let context: WorkflowContextSnapshot;
      const compact = this.options.compactContext;
      if (compact) {
        context = await this.schedule(() => compact(captured.raw), "capture");
      } else {
        // What the compaction call REPORTS it resolved, filled in by `onExecution` before its
        // first attempt runs. Not re-derived from a second config read here: with a provider
        // per job, an app-wide re-resolution names a different provider than the one the call
        // used on every installation that set an override, so every row it wrote was wrong.
        let contextExecution: JobExecution | null = null;
        const contextCallIds = new Map<number, string>();
        const observer: StructuredAttemptObserver = {
          start: (attempt, prompt) => {
            if (!this.captureIsActive(run.id, submission.id)) return false;
            // `onExecution` fires ahead of the first attempt, so this is populated by now. If
            // it somehow is not, skip the row rather than labelling it with a guess - `finish`
            // finds no id and does nothing, and a missing ledger row is far easier to read
            // than one that confidently names the wrong provider.
            const execution = contextExecution;
            if (!execution) return;
            const id = randomUUID();
            contextCallIds.set(attempt, id);
            this.store.insertLlmCall({
              id,
              runId: run.id,
              submissionId: submission.id,
              nodeAttemptId: null,
              purpose: "context_compaction",
              runner: execution.runner,
              model: execution.model,
              attempt,
              state: "running",
              startedAt: Date.now(),
              finishedAt: null,
              durationMs: null,
              inputBytes: Buffer.byteLength(prompt),
              outputBytes: 0,
              costUsd: null,
              errorCode: null,
            });
          },
          finish: (attempt, result) => {
            const id = contextCallIds.get(attempt);
            if (!id) return;
            this.store.finishLlmCall(
              id,
              result.parsed ? "succeeded" : "failed",
              result.raw ? Buffer.byteLength(result.raw) : 0,
              result.error
                ? "context_compaction_infrastructure"
                : result.parsed
                  ? null
                  : "context_compaction_parse",
              Date.now(),
            );
          },
        };
        // No `runner`/`model` override: the compaction stamps the snapshot from the pair the
        // call itself reports, which is the same one this ledger row is written from.
        context = await this.schedule(() => compactWorkflowContext(captured.raw, {
          observer,
          onExecution: (execution) => {
            contextExecution = execution;
          },
        }), "capture");
      }
      const currentRun = this.store.getRun(run.id);
      const currentSubmission = this.store.getSubmission(submission.id);
      if (
        !currentRun
        || !currentSubmission
        || currentRun.status !== "capturing"
        || currentSubmission.status !== "capturing"
      ) {
        return {
          ok: false,
          reason: "conflict",
          message: "The workflow submission stopped while evidence was being compacted",
          current: currentRun,
        };
      }
      const fingerprint = workflowContextFingerprint(context);
      const repositoryFingerprint = workflowRepositoryFingerprint(context);
      const version = this.store.getWorkflowVersionById(run.workflowVersionId);
      const enforcingReadiness = workflowEvidenceReadinessPolicyEnforces(
        version?.evidenceReadinessPolicy,
      );
      const readiness = frozenCoverage.length === 0 && !enforcingReadiness
        ? null
        : evaluateWorkflowEvidenceReadiness({
            canonicalCriteria: context.canonicalCriteria ?? [],
            coverage: frozenCoverage,
            evidence: this.store.submissionFrozenEvidenceIdentities(submission.id),
            unavailableReason: context.compaction.status === "fallback"
              ? context.compaction.error ?? "Workflow context compaction was unavailable"
              : null,
            enforceCoverage: enforcingReadiness,
          });
      const runnable = this.store.updateSubmissionCapture(submission.id, {
        context: workflowJson(context),
        evidence: workflowJson(context.evidence),
        fingerprint,
        repositoryFingerprint,
        readiness,
        status: "running",
      }, Date.now());
      /*
       * The WORK, not the submission's identity.
       *
       * Comparing identity here is what made this refusal unreachable in practice. Identity
       * includes the transcript anchor; the repair packet is typed into that transcript
       * before anyone can resubmit, so the two fingerprints had already diverged whether or
       * not a byte of the work had. Two refusals fired in the system's whole history while
       * whole runs spent their budgets re-reviewing byte-identical trees.
       *
       * The previous row is resolved through its identity because that is what the callers
       * hand down, and it stays that way: identity is what trigger keys and idempotency are
       * built on, and this is a read, not a second source of truth. Where the previous row
       * predates the column it has no work-hash at all, so the comparison falls back to the
       * identity it always used - historical rows keep historical behaviour rather than
       * being retroactively judged by a hash they were never given.
       */
      const previous = previousFingerprint
        ? this.store.listSubmissions(run.id)
          .filter((row) => row.id !== submission.id
            && row.evidenceFingerprint === previousFingerprint)
          .at(-1) ?? null
        : null;
      const unchanged = previous?.repositoryFingerprint
        ? previous.repositoryFingerprint === repositoryFingerprint
        : Boolean(previousFingerprint) && fingerprint === previousFingerprint;
      if (unchanged && !allowUnchanged) {
        const refusedAt = Date.now();
        this.store.setSubmissionState(submission.id, "failed", refusedAt);
        // Append BEFORE counting, so the count includes this refusal and the two reads can
        // never disagree about whether the current one is in it.
        this.store.appendEvent(run.id, "resubmit_refused_unchanged", {
          triggerKey: submission.triggerKey,
          evidenceFingerprint: fingerprint,
        }, refusedAt);
        const refusals = this.store.consecutiveUnchangedRefusals(run.id);
        // Stated as a comparison, not an ordinal. Refusals 1 and 2 each get a nudge; the run
        // blocks when the count EXCEEDS the limit, i.e. on the third. Reading it as "stop after
        // the second" blocks a round early and silently shortens the repair loop.
        const exhausted = refusals > UNCHANGED_EVIDENCE_NUDGE_LIMIT;
        this.store.setRunState(
          run.id,
          exhausted ? "blocked" : "waiting_for_session",
          exhausted ? "unchanged_evidence_exhausted" : "unchanged_evidence",
          { evidenceFingerprint: fingerprint, unchangedRefusals: refusals },
          refusedAt,
        );
        if (exhausted) {
          this.store.appendEvent(run.id, "unchanged_evidence_exhausted", {
            submissionId: submission.id,
            evidenceFingerprint: fingerprint,
            refusals,
          }, refusedAt);
        }
        this.publishRun(run.id);
        // Outside the capture lock's critical decision but inside the same turn: the nudge is a
        // delivery. Queue drain may re-arm on confirmation; prompted completion waits for the
        // delivered work's next natural completed generation. That is what supplies the NEXT
        // legitimate claim; resetting the prompted guard here would spin capture against a
        // session that is not changing.
        if (!exhausted) this.scheduleUnchangedEvidenceNudge(run.id, submission.id, refusals);
        return {
          ok: false,
          reason: "unchanged_evidence",
          message: "Evidence has not changed; explicitly confirm an unchanged resubmission to continue",
        };
      }
      this.store.appendEvent(run.id, "submission_captured", {
        submissionId: submission.id,
        evidenceFingerprint: fingerprint,
        previousFingerprint: previousFingerprint ?? null,
        compaction: context.compaction.status,
        readiness: readiness?.status ?? "not_evaluated",
      }, Date.now());
      if (beforeActivate && !(await beforeActivate(runnable))) {
        this.publishRun(run.id);
        return {
          ok: false,
          reason: "conflict",
          message: "The captured evidence did not satisfy this submission's activation guard",
          current: this.store.getRun(run.id),
        };
      }
      if (enforcingReadiness && readiness?.status === "gaps") {
        const waitedAt = Date.now();
        const waitingSubmission = this.store.setSubmissionState(
          submission.id,
          "waiting_for_evidence_readiness",
          waitedAt,
        );
        const waitingRun = this.store.setRunState(
          run.id,
          "waiting_for_evidence_readiness",
          "evidence_readiness",
          {
            submissionId: submission.id,
            gapCodes: readiness.gapCodes,
          },
          waitedAt,
        );
        this.store.appendEvent(run.id, "evidence_readiness_waiting", {
          submissionId: submission.id,
          round: submission.round,
          segment: submission.segment,
          gapCodes: readiness.gapCodes,
        }, waitedAt, `evidence-readiness-wait:${submission.id}`);
        this.publishRun(run.id);
        this.scheduleEvidenceReadinessDelivery(submission.id);
        return { ok: true, value: { run: waitingRun, submission: waitingSubmission } };
      }
      this.engine.activateSubmission(submission.id);
      const updatedRun = this.store.getRun(run.id) ?? run;
      this.publishRun(run.id);
      return { ok: true, value: { run: updatedRun, submission: runnable } };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.captureIsActive(run.id, submission.id)) {
        this.store.setSubmissionState(submission.id, "failed", Date.now());
        const imageFailure = error instanceof WorkflowImageEvidenceError;
        const phase = imageFailure ? "image_evidence_capture" : "capture_error";
        this.store.setRunState(run.id, "blocked", phase, {
          error: message,
          ...(imageFailure ? { code: error.code } : {}),
        }, Date.now());
        this.store.appendEvent(run.id, phase, {
          submissionId: submission.id,
          error: message,
          ...(imageFailure ? { code: error.code } : {}),
        }, Date.now());
        this.publishRun(run.id);
      } else {
        return {
          ok: false,
          reason: "conflict",
          message: "The workflow submission stopped during evidence capture",
          current: this.store.getRun(run.id),
        };
      }
      return {
        ok: false,
        reason: "stale_capture",
        message: `Workflow evidence capture failed: ${message}`,
      };
    }
  }

  private priorFeedback(runId: string): PersonaFeedbackSummary[] {
    const run = this.store.getRun(runId);
    const version = run ? this.store.getWorkflowVersionById(run.workflowVersionId) : null;
    const nodes = new Map(
      (version?.graph.nodes ?? []).filter(isVerdictNode).map((node) => [node.id, node]),
    );
    const submissions = this.store.listSubmissions(runId);
    return submissions.flatMap((submission) =>
      this.store.listAttempts(submission.id).flatMap((attempt) => {
        const parsed = PersonaVerdictSchema.safeParse(attempt.verdict);
        const node = nodes.get(attempt.nodeId);
        if (!parsed.success || parsed.data.verdict !== "fail" || !node) return [];
        const verdict: PersonaVerdict = parsed.data;
        return [{
          personaName: verdictAuthor(node),
          summary: verdict.summary,
          requestedChanges: verdict.requestedChanges.map((item) => item.title),
        }];
      }),
    );
  }

  private captureIsActive(runId: string, submissionId: string): boolean {
    return this.store.getRun(runId)?.status === "capturing"
      && this.store.getSubmission(submissionId)?.status === "capturing";
  }

  private reconcileBindingsAfterDiscovery(): void {
    for (const binding of this.store.listBindings()) {
      if (binding.state !== "active") continue;
      const session = binding.sessionId ? this.registry.getSession(binding.sessionId) : undefined;
      const updated = !session || session.state === "exited"
        ? this.store.orphanBinding(binding.id, "session_disappeared")
        : binding.noteKey !== noteKeyFor(session)
          ? this.store.pauseBinding(binding.id, "conversation_changed")
          : null;
      if (!updated) continue;
      this.publishBinding(updated.id);
      const run = this.store.activeRunForBinding(updated.id);
      if (run) this.publishRun(run.id);
    }
  }

  /**
   * Put every interrupted session action back on a path forward, exactly once each.
   *
   * Runs AFTER `engine.start()` on purpose. The engine's own recovery is what converts a run
   * stopped mid-capture into the blocked `capture_interrupted` state, and a reserved child
   * segment is resumed from precisely that state through the existing capture-resume
   * boundary - so this has to see the engine's answer, not race it.
   *
   * Every transition below is idempotent and none of them types anything an operator did not
   * already authorize. In particular an UNCERTAIN write is never resent: the packet may have
   * landed, so the only safe move is to leave the run blocked for a human to resolve, which
   * `recoverSendingDeliveries` has already done by the time this runs.
   */
  private recoverSessionActions(): void {
    for (const attempt of this.store.listWaitingActionAttempts()) {
      const resolved = this.resolveSessionAction(attempt.id);
      if (!resolved) continue;
      const { state, binding } = resolved;
      const delivery = state.deliveryId ? this.store.getDelivery(state.deliveryId) : null;
      // A waiting attempt that owns NO packet at all: prepare the one it needs.
      // `prepareDelivery` is keyed on the attempt, so a packet prepared before the restart is
      // returned rather than duplicated.
      //
      // A refused or cancelled packet is deliberately NOT re-prepared here. It is positive
      // proof that nothing was typed, and re-preparing would retry, on every daemon start, a
      // write the operator never re-authorized. The observer blocks it instead.
      if (!delivery) {
        this.scheduleSessionActionDelivery(attempt.id);
        continue;
      }
      // Prepared but never typed. Live re-attempts through the ordinary send path, which
      // re-asks every consent gate; Preview stays exactly where it is.
      if (delivery.state === "prepared") {
        if (binding.deliveryMode === "live") this.schedulePreparedDelivery(delivery.id);
        continue;
      }
      // Delivered. Pickup and settle are observations, not stored progress, so the sweep
      // simply picks them up again from the durable anchor - a restart cannot fabricate the
      // pickup proof it did not have.
      if (delivery.state !== "delivered") continue;
      // The adapter had already completed and a child segment was reserved. Resume that
      // reservation rather than reserving another: `reserveSessionActionContinuation` returns
      // the same row, and the capture below refills it.
      if (state.wait === "capturing" && state.continuationSubmissionId) {
        const child = this.store.getSubmission(state.continuationSubmissionId);
        if (!child) continue;
        // Tracked rather than awaited, for the reason recovery is not an async function: it
        // runs on the daemon's start path, and blocking it on git for every waiting action
        // would delay every other run's recovery behind one repository. The sequence inside
        // is what has to be ordered, and it is.
        this.trackBackgroundTask(this.recoverSessionActionCapture(attempt.id, child).catch((error) => {
          this.blockSessionAction(
            attempt.id,
            "capture_failed",
            error instanceof Error ? error.message : String(error),
          );
        }));
      }
    }
  }

  /**
   * Pick one interrupted continuation back up, in the order its three durable states require.
   *
   * Seal first: a child whose evidence is durable and whose receipt is not needs its receipt,
   * not a second capture - the capture guard requires the run and the submission to both be
   * `capturing`, and a completed capture left neither. Only when that is refused does the row
   * get resumed and refilled, and `resumeCapture` is what puts the pair back into the state
   * the capture path requires.
   */
  private async recoverSessionActionCapture(
    attemptId: string,
    child: WorkflowSubmission,
  ): Promise<void> {
    if (child.status !== "capturing" && await this.sealCapturedContinuation(attemptId, child)) {
      return;
    }
    const run = this.store.getRun(child.runId);
    if (child.status === "failed" && run?.status === "blocked") {
      this.store.resumeCapture(run.id, child.id, CAPTURE_RESUMABLE_PHASES);
    }
    await this.captureSessionActionContinuation(attemptId, Date.now());
  }

  /**
   * Finish a continuation whose evidence survived but whose receipt did not.
   *
   * Returns false when this child was not in fact captured, so the caller falls through to the
   * ordinary capture-resume path. `activateSubmission` is what moves the run out of the
   * `capture_interrupted` state the engine's own recovery left it in.
   */
  private async sealCapturedContinuation(
    attemptId: string,
    child: WorkflowSubmission,
  ): Promise<boolean> {
    const resolved = this.resolveSessionAction(attemptId);
    if (!resolved) return false;
    const { attempt, snapshot, state, binding, version, node } = resolved;
    if (!WorkflowContextSnapshotSchema.safeParse(child.context).success) return false;
    const sealed = await this.sealSessionActionContinuation({
      attempt,
      snapshot,
      version,
      node,
      expectation: state.expectation ?? { kind: "none" },
      adapter: sessionActionAdapter(snapshot.completion.kind),
      child,
      repositoryRoot: binding.sessionRepoRoot ?? null,
    });
    if (!sealed) return false;
    this.store.appendEvent(child.runId, "session_action_continuation_resealed", {
      attemptId: attempt.id,
      submissionId: child.id,
    });
    this.engine.activateSubmission(child.id);
    this.publishRun(child.runId);
    return true;
  }

  private startEngineAndMaintenance(): void {
    reconcileWorkflowEvidenceFiles(this.store);
    this.orphanedEvidenceImages = workflowEvidenceOrphanCount(this.store);
    this.engine.start();
    this.recoverSessionActions();
    this.lastRecoveryAt = Date.now();
    workflowLog("info", { event: "recovery_complete", at: this.lastRecoveryAt });
    void this.sweepRetention();
    if (!this.resumptionTimer) {
      // Started here, beside retention, for the same reason retention is: both need the first
      // completed discovery sweep before they mean anything. A resumption observer running
      // before sessions are known would see every binding as orphaned.
      this.resumptionTimer = setInterval(
        () => {
          void this.sweepResumptions();
          // The SAME timer as the resumption sweep, deliberately. Both ask "has the bound
          // session stopped?", and a second poller asking that would be a second answer -
          // with its own window, its own settle threshold, and its own idea of idle.
          void this.sweepSessionActions();
          // Also here rather than on a timer of its own: this asks whether provider-owned
          // cleanup for a blocked run has settled. One observer, one interval, one answer.
          this.engine.resumeClearedCheckCleanup();
        },
        this.options.resumptionIntervalMs ?? WORKFLOW_RESUMPTION_INTERVAL_MS,
      );
      this.resumptionTimer.unref?.();
    }
    if (this.retentionTimer) return;
    this.retentionTimer = setInterval(
      () => void this.sweepRetention(),
      this.options.retentionIntervalMs ?? WORKFLOW_RETENTION_INTERVAL_MS,
    );
    this.retentionTimer.unref?.();
  }

  private async sweepRetention(): Promise<void> {
    if (this.retentionRunning) return;
    this.retentionRunning = true;
    try {
      const result = (this.options.runRetention ?? runWorkflowRetention)(
        this.store,
        getWorkflowPolicy().retention,
      );
      reconcileWorkflowEvidenceFiles(this.store);
      this.orphanedEvidenceImages = workflowEvidenceOrphanCount(this.store);
      this.lastRetentionAt = Date.now();
      this.lastRetentionError = result.failedRunCount > 0
        ? "retention_partial_failure"
        : null;
      this.lastRetentionCompacted = result.compactedRunIds.length;
      this.lastRetentionDeleted = result.deletedRunIds.length;
      for (const id of result.compactedRunIds) this.publishRun(id);
      for (const id of result.deletedRunIds) this.registry.removeWorkflowRun(id);
      workflowLog(result.failedRunCount > 0 ? "error" : "info", {
        event: result.failedRunCount > 0
          ? "retention_partial_failure"
          : "retention_complete",
        compacted: result.compactedRunIds.length,
        deleted: result.deletedRunIds.length,
        failed: result.failedRunCount,
      });
    } catch (error) {
      this.lastRetentionAt = Date.now();
      this.lastRetentionError = "retention_failed";
      this.lastRetentionCompacted = 0;
      this.lastRetentionDeleted = 0;
      workflowLog("error", {
        event: "retention_failed",
        error: error instanceof Error ? error.name : "unknown",
      });
    } finally {
      this.retentionRunning = false;
    }
  }

  /**
   * One pass of the resumption observer: pick up every parked repair round whose agent has
   * finished the work, under a version that asked for it.
   *
   * This exists because the packet the daemon types into the pane is a DEAD END otherwise.
   * A run parks in `waiting_for_session` (a Persona failed, a PR handoff was delivered, or
   * Inspector found something under `restart_workflow`), the repair packet reaches the agent,
   * the agent repairs - and nothing resubmits, because `claimCompletion` refuses every claim
   * on a binding that is not `foreman_complete`. The Foreman could never be the general answer
   * either: it needs a `foreman_queues` row with items to retire, Foreman enabled, and measured
   * `hooks` + `workQueue` capability, none of which a plain session bound by hand has. So the
   * engine watches instead of listening.
   *
   * Public so a test can drive one pass against an injected clock rather than a timer.
   *
   * The order of the gates below is deliberate: every free in-memory question is asked before
   * the one that spawns git. Generic repair still admits `waiting_for_session` and nothing
   * else through `resumableRun`. Evidence readiness additionally re-drives its own exact
   * capturing child because its reservation commits before capture begins. An overridden
   * submission left in the durable `activating` handoff is also eligible because the override
   * commits before graph activation.
   */
  async sweepResumptions(now = Date.now()): Promise<void> {
    if (this.resumptionRunning) return;
    this.resumptionRunning = true;
    try {
      const sessions = this.registry.snapshot().sessions;
      for (const run of this.store.listRuns()) {
        if (
          run.status === "waiting_for_evidence_readiness"
          || run.status === "capturing"
          || (run.status === "running" && run.currentPhase === "activating")
        ) {
          try {
            await this.resumeEvidenceReadiness(run.id, now);
          } catch (error) {
            workflowLog("error", {
              event: "evidence_readiness_resumption_failed",
              run: run.id,
              error: error instanceof Error ? error.name : "unknown",
            });
          }
          continue;
        }
        // Cheapest possible first cut, off the rows already in hand. Everything past this
        // point re-reads the run under `resumableRun`, which is where the real gates live.
        if (run.status !== "waiting_for_session") continue;
        try {
          await this.resumeParkedRun(run.id, sessions, now);
        } catch (error) {
          workflowLog("error", {
            event: "resumption_failed",
            run: run.id,
            error: error instanceof Error ? error.name : "unknown",
          });
        }
      }
    } finally {
      this.resumptionRunning = false;
    }
  }

  private async resumeEvidenceReadiness(runId: string, now: number): Promise<void> {
    const run = this.store.getRun(runId);
    const latest = run ? this.store.latestSubmission(run.id) : null;
    const binding = run ? this.store.getBinding(run.bindingId) : null;
    if (!run || !latest || !binding || binding.state !== "active") return;
    if (
      run.status === "running"
      && run.currentPhase === "activating"
      && latest.status === "running"
      && latest.readiness?.status === "overridden"
    ) {
      const override = this.store.listReadinessOverrides(run.id)
        .findLast((candidate) => candidate.submissionId === latest.id);
      if (!override) return;
      this.activateEvidenceReadinessOverride(run.id, latest.id, binding, override, now);
      return;
    }
    // A capture lock is the live owner for this conversation. It is acquired synchronously
    // before capture yields, and disappears with the process, so skipping it prevents a sweep
    // from joining live work without weakening restart recovery for an orphaned reservation.
    if (this.captureLocks.has(binding.noteKey)) return;

    let parent: WorkflowSubmission;
    let triggerKey: string;
    let manualRetry = false;
    if (
      run.status === "waiting_for_evidence_readiness"
      && latest.status === "waiting_for_evidence_readiness"
    ) {
      parent = latest;
      const generation = this.store.workflowEvidenceGeneration(
        binding.noteKey,
        binding.repoRoot || binding.sessionCwd || "",
      );
      triggerKey = `evidence-preflight:${run.id}:${parent.id}:${generation}`;
    } else if (
      run.status === "capturing"
      && latest.status === "capturing"
      && latest.refinementReason === "evidence_preflight"
      && latest.parentSubmissionId
      && ["manual", "session"].includes(latest.triggerSource)
    ) {
      const recoveredParent = this.store.getSubmission(latest.parentSubmissionId);
      if (!recoveredParent) return;
      parent = recoveredParent;
      triggerKey = latest.triggerKey;
      manualRetry = latest.triggerSource === "manual";
    } else {
      return;
    }
    const reserved = this.store.reserveEvidenceReadinessRefinement({
      id: randomUUID(),
      runId: run.id,
      waitingSubmissionId: parent.id,
      triggerKey,
      manualRetry,
      now,
    });
    if (!reserved.ok) return;
    if (reserved.idempotent && reserved.submission.status !== "capturing") return;
    this.publishRun(run.id);
    const current = this.store.getRun(run.id);
    if (!current) return;
    await this.captureAndActivate(binding, current, reserved.submission, undefined, true);
  }

  /**
   * Everything that has to be true before a parked round may resume, answered without I/O.
   *
   * `waiting_for_new_head` is absent on purpose and must stay absent. That is where
   * `inspector_only` findings park, and the repair there is resolved by pushing a head the
   * Inspector poller observes - a resubmission would rerun a review that already passed
   * against a pull request the Inspector has not looked at again. `waiting_for_pr` is absent
   * for the mirror-image reason: the run is waiting for a pull request to exist, and no amount
   * of session activity produces one.
   */
  private resumableRun(runId: string, sessions: Session[], now: number): {
    run: WorkflowRun;
    binding: WorkflowBinding;
    session: Session;
    latest: WorkflowSubmission;
    withheld?: undefined;
  } | {
    run: WorkflowRun | null;
    latest: WorkflowSubmission | null;
    withheld: WorkflowResumptionWithheldReason | null;
  } {
    const run = this.store.getRun(runId);
    // Not a withholding at all: the sweep pre-filters on this status, so reaching it here
    // means the run moved out from under the tick. There is nothing to explain to anyone.
    if (!run || run.status !== "waiting_for_session") return { run, latest: null, withheld: null };
    const latest = this.store.latestSubmission(run.id);
    const held = (reason: WorkflowResumptionWithheldReason) => ({ run, latest, withheld: reason });
    const version = this.store.getWorkflowVersionById(run.workflowVersionId);
    if (version?.resumptionPolicy !== "auto") return held("policy_manual");
    const binding = this.store.getBinding(run.bindingId);
    if (!binding || binding.state !== "active" || !binding.sessionId) return held("binding_inactive");
    const session = this.registry.getSession(binding.sessionId);
    // The same compatibility the capture path insists on: a session that vanished, exited, or
    // whose conversation was replaced is not the one this packet was typed into.
    if (!session || session.state === "exited" || binding.noteKey !== noteKeyFor(session)) {
      return held("session_unavailable");
    }
    if (!settledIdle(session, now, this.options.resumptionSettleMs ?? WORKFLOW_RESUMPTION_SETTLE_MS)) {
      return held("session_busy");
    }
    // Settled-idle answers "has it stopped"; this answers "has it stopped BECAUSE it is stuck
    // on you". A session parked on a permission prompt reads as idle and is the last thing
    // that should be handed another round of work.
    if (reportBucket(session, sessions) === "needs-you") return held("session_needs_you");
    if (!latest) return { run, latest: null, withheld: null };
    // An undelivered or uncertain packet means the agent has not been told what to repair.
    // Resuming there would submit the same evidence back into the same review, which is a
    // round spent proving nothing - and under Preview delivery, which never types, it would
    // spend every round in the budget without a single packet ever reaching a human's screen.
    const inFlight = this.store.listDeliveries(run.id).some((delivery) =>
      delivery.submissionId === latest.id
      && (UNDELIVERED_DELIVERY_STATES as readonly string[]).includes(delivery.state));
    if (inFlight) return held("packet_undelivered");
    return { run, binding, session, latest };
  }

  /**
   * Write down that the observer looked at this parked round and chose not to act.
   *
   * **This is a TRANSITION ledger, not a tick log and not a set.** An entry is written when
   * the reason differs from the one immediately before it on the same submission, so the
   * last entry is always the reason that holds right now - which is the whole point, because
   * `runResumptionState` reads exactly that entry and the header prints it.
   *
   * It is not rate-limited on time. The sweep runs every 15 seconds and a run can sit parked
   * for a working day, so a timer would still bury the ledger while a reason that has not
   * changed is not news. What bounds the entry count is real session activity rather than
   * the tick rate: reaching a different reason means the session actually left settled-idle,
   * arrived at a permission prompt, or lost its binding.
   *
   * De-duplicating on (submission, reason) GLOBALLY was considered and rejected, and the
   * reason is worth stating because the promise reads tidier than it behaves. A session that
   * goes busy and settles again - a chat turn, a hook, a test run - would leave `session_busy`
   * as the newest entry for the rest of the round, so the header would go on saying "the
   * session is still working" about a session that had been idle for an hour. A stale
   * sentence stated confidently is the exact failure this feature exists to end, and it would
   * buy an entry count that is already bounded by the same session activity.
   *
   * The event is the only transport. Run detail derives its sentence from the ledger it
   * already streams, so there is no second field on the summary to keep in step, and a
   * daemon restart loses nothing.
   */
  private recordResumptionWithheld(
    run: WorkflowRun,
    submission: WorkflowSubmission | null,
    reason: WorkflowResumptionWithheldReason,
    now: number,
  ): void {
    // The IMMEDIATELY PRECEDING withheld entry, not any matching one. See above: a match
    // further back is a reason this round has already left, and skipping the write because of
    // it would leave that older reason standing as the newest thing the header can read.
    const priorWithheld = this.store.listEvents(run.id)
      .filter((event) => event.kind === "resumption_withheld")
      .at(-1);
    const payload = priorWithheld?.payload;
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const sameSubmission = (payload.submissionId ?? null) === (submission?.id ?? null);
      if (sameSubmission && payload.reason === reason) return;
    }
    this.store.appendEvent(run.id, "resumption_withheld", {
      submissionId: submission?.id ?? null,
      round: submission?.round ?? null,
      reason,
    }, now);
    this.publishRun(run.id);
  }

  /**
   * Read the repository, and nothing else.
   *
   * Half of "has the work under review moved since this submission was captured?", which is
   * the cheap pre-filter and the whole reason there is no "capture then discard" mode: an
   * idle repair session with unchanged work must leave the run exactly where it is.
   * Re-reading the diff, the transcript window and the standards on every tick to discover
   * unchanged repair work is not free. `readWorkflowEvidenceProbe` costs two git commands and
   * reads the repository only. Every field it reads is a fingerprint input, so a differing
   * probe cannot lead to `unchanged_evidence`. Its content-sensitive diff fingerprint also
   * detects edits inside a path that was already dirty in the failed round. The converse is
   * deliberately not true: a transcript-only change leaves the probe matching while the full
   * fingerprint has moved, and a repair that changed no code is not a repair.
   *
   * Split from the comparison below, and NOT folded into one `async` helper, because the tick
   * count is load-bearing. `resumeParkedRun` re-checks the run's eligibility once this
   * resolves, exactly because a concurrent write may move the run while git is running - and
   * every extra microtask between the read and that re-check widens the window for one to
   * land. Wrapping the read in an `async` function cost enough turns to change an outcome: a
   * gate evaluation scheduled by the same session update landed first and pulled a settled
   * `pr_handoff` run into `waiting_for_pr`, so the round its new head had earned was never
   * opened. Returning the read's own promise keeps the caller to the single turn the git call
   * itself needs, which is what it has always cost.
   */
  private probeRepository(binding: WorkflowBinding): Promise<WorkflowEvidenceProbe> {
    return (this.options.readEvidenceProbe ?? readWorkflowEvidenceProbe)(this.registry, binding);
  }

  /**
   * Does that probe describe the same work the submission was captured from?
   *
   * Synchronous, so it adds no turns, and shared so the observer and the manual resubmission
   * cannot drift apart on what "changed" means - the two disagreeing is precisely the bug
   * that let the button spend rounds the observer would have declined. `null` means the
   * question could not be asked, which both callers read as "proceed": refusing a round over
   * an unparsable snapshot would strand the run over bookkeeping.
   */
  private repositoryUnchangedSince(
    probe: WorkflowEvidenceProbe,
    binding: WorkflowBinding,
    submission: WorkflowSubmission,
  ): boolean | null {
    const parsed = WorkflowContextSnapshotSchema.safeParse(submission.context);
    if (!parsed.success) return null;
    probe.stagedImageGeneration = this.store.workflowEvidenceGeneration(
      binding.noteKey,
      binding.repoRoot || binding.sessionCwd || "",
    );
    return probeMatchesEvidence(probe, parsed.data.evidence);
  }

  /**
   * Remind the session once about a round it has left standing, or do nothing.
   *
   * Reached only from the observer's `repository_unchanged` arm, which means every gate
   * before it already passed: the version resumes itself, the binding is active and live, the
   * session is present, settled and not waiting on a human, and its packet was confirmed
   * delivered. What remains is a session that was told what to fix, is not busy, and has not
   * touched the tree - and the only thing standing between that and the multi-hour silences
   * this exists to end is time.
   *
   * The clock runs from the DELIVERY, not from the run's `updatedAt`. A parked run's row is
   * rewritten by anything that publishes it, this sweep's own withheld events included, so
   * timing off the run would restart the countdown on every tick and the reminder would never
   * fire. The delivery's `deliveredAt` is the moment the session was actually told.
   *
   * Preview delivery cannot reach here - `workflowRunResumesItself` is not consulted, but the
   * confirmed-delivery gate stands in for it, because Preview never confirms one.
   */
  private maybeRemindParkedRound(
    run: WorkflowRun,
    binding: WorkflowBinding,
    submission: WorkflowSubmission,
    now: number,
  ): void {
    if (binding.deliveryMode !== "live") return;
    const deliveries = this.store.listDeliveries(run.id);
    // Once per parked round, whatever its outcome. A reminder that was refused at the pane or
    // landed ambiguously has still been attempted, and attempting it again is how a stuck
    // session ends up with three copies of the same paragraph.
    if (deliveries.some((delivery) =>
      delivery.kind === "parked_repair_reminder"
      && delivery.submissionId === submission.id)) return;
    const delivered = deliveries.find((delivery) =>
      delivery.submissionId === submission.id
      && delivery.state === "delivered"
      && delivery.deliveredAt !== null);
    if (!delivered?.deliveredAt) return;
    const parkedMs = now - delivered.deliveredAt;
    if (parkedMs < (this.options.parkedReminderMs ?? WORKFLOW_PARKED_REMINDER_MS)) return;
    this.scheduleParkedRepairReminder(run.id, submission.id, Math.round(parkedMs / 60_000), now);
  }

  private scheduleParkedRepairReminder(
    runId: string,
    submissionId: string,
    parkedMinutes: number,
    now: number,
  ): void {
    this.trackBackgroundTask(
      this.prepareParkedRepairReminder(runId, submissionId, parkedMinutes, now).catch((error) => {
        const run = this.store.getRun(runId);
        if (!run || runIsTerminal(run)) return;
        // Recorded, never escalated. Every other prepare failure blocks its run because the
        // run cannot proceed without that packet; this one is an extra courtesy on a run that
        // is already parked, and blocking it would turn a failed reminder into a worse
        // outcome than never having tried to send one.
        this.store.appendEvent(runId, "parked_reminder_failed", {
          submissionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }),
    );
  }

  /**
   * Re-ask every question the sweep asked, from scratch, and only then write the packet.
   *
   * The reminder is the one delivery in this file that nothing is waiting for. A repair packet
   * has to reach the session or the round cannot proceed; a reminder that arrives one second
   * after the agent finally started typing is pure interruption, and one that arrives after the
   * repair landed says "no change to the repository" about a repository that has changed. So
   * this is written to be droppable: every gate below is a plain `return`, no reminder row is
   * written, and the next sweep reconsiders from nothing.
   *
   * The rechecks are `resumableRun` itself rather than a hand-picked subset, because a subset
   * is a second opinion about what "still parked" means and this file has already paid for
   * having two. It runs against a FRESH registry snapshot rather than the sweep's, which is
   * the half that matters: a session that started working, or that stopped on a permission
   * prompt, is visible only in a snapshot taken after it did - and, crucially, after the one
   * await this method makes, which is the only window there is.
   *
   * The sweep's `now` is carried down rather than re-read, keeping this method on the same
   * injected clock as everything else in the file. Nothing is lost by it. `settledIdle`
   * measures the session's own `lastActivity` against that clock, so an older `now` can only
   * under-report settledness - it can skip a reminder, never send one it should not have.
   *
   * The repository is asked again for the same reason, and the once-per-round guard is asked
   * again because this method now awaits: a sweep landing in that window would find no
   * reminder row yet and schedule a second one.
   */
  private async prepareParkedRepairReminder(
    runId: string,
    submissionId: string,
    parkedMinutes: number,
    now: number,
  ): Promise<void> {
    const scheduled = this.store.getRun(runId);
    const scheduledBinding = scheduled ? this.store.getBinding(scheduled.bindingId) : null;
    if (!scheduled || !scheduledBinding) return;

    /*
     * The repository read comes FIRST, and every other gate is asked after it.
     *
     * This is the method's only await, so it is also the only point at which the world can
     * move underneath it - and asking the gates before it would recheck a world that had not
     * had the chance to change yet, which is the same as not rechecking at all. Two git reads
     * take long enough for a session to pick up its turn.
     */
    const probe = await this.probeRepository(scheduledBinding).catch(() => null);
    if (!probe) return;

    const eligible = this.resumableRun(runId, this.registry.snapshot().sessions, now);
    if (eligible.withheld !== undefined) return;
    const { run, binding, latest: submission } = eligible;
    const version = this.store.getWorkflowVersionById(run.workflowVersionId);
    const summary = this.store.runSummary(runId);
    if (
      runIsTerminal(run)
      || submission.id !== submissionId
      || binding.deliveryMode !== "live"
      || !binding.sessionId
      || !version
      || !summary
    ) return;
    // The premise of the sentence about to be typed. A repair that landed between the sweep's
    // decision and this line makes the reminder false, not merely unnecessary.
    if (this.repositoryUnchangedSince(probe, binding, submission) !== true) return;
    // Asked again after the await, because a sweep landing in that window would find no
    // reminder row yet and schedule a second one.
    if (this.store.listDeliveries(runId).some((delivery) =>
      delivery.kind === "parked_repair_reminder"
      && delivery.submissionId === submission.id)) return;
    const prior = [...this.store.listDeliveries(runId)].reverse().find((delivery) =>
      delivery.kind === "persona_feedback"
      && delivery.state === "delivered"
      && delivery.payload.length > 0);
    const rendered = renderParkedRepairReminder({
      workflowName: summary.workflowName,
      workflowVersion: version.version,
      runId,
      round: submission.round,
      originalGoal: this.originalGoal(runId),
      parkedMinutes,
      priorPacket: prior?.payload ?? null,
      workflowEvidence: versionSupportsWorkflowEvidence(version),
    });
    const prepared = this.store.prepareDelivery({
      id: randomUUID(),
      runId,
      submissionId: submission.id,
      kind: "parked_repair_reminder",
      sessionId: binding.sessionId,
      noteKey: binding.noteKey,
      payload: rendered.payload,
      payloadSha256: rendered.payloadSha256,
    });
    if (!prepared.idempotent) {
      this.store.appendEvent(runId, "delivery_prepared", {
        deliveryId: prepared.delivery.id,
        payloadSha256: rendered.payloadSha256,
        truncated: rendered.truncated,
        kind: "parked_repair_reminder",
        parkedMinutes,
      });
    }
    this.publishRun(runId);
    await this.deliverPrepared(prepared.delivery.id, false);
  }

  private async resumeParkedRun(runId: string, sessions: Session[], now: number): Promise<void> {
    const eligible = this.resumableRun(runId, sessions, now);
    if (eligible.withheld !== undefined) {
      if (eligible.run && eligible.withheld) {
        this.recordResumptionWithheld(eligible.run, eligible.latest, eligible.withheld, now);
      }
      return;
    }
    const { run, binding, latest } = eligible;
    if (latest.round > run.maxRepairRounds) {
      // The EXISTING refusal, not a new one. `claimCompletion` and `resolveDelivery` both end
      // an over-budget run this way, and a third spelling would be a second thing an operator
      // has to learn to recognise in run detail.
      this.store.blockForRoundLimit(run, now);
      this.publishRun(run.id);
      return;
    }
    // A settled PR handoff is the explicit exception below because unchanged repository
    // evidence proves it needs a fresh Inspector observation, not another submission.
    const probe = await this.probeRepository(binding);
    const unchanged = this.repositoryUnchangedSince(probe, binding, latest);
    if (unchanged === null) return;
    if (unchanged) {
      this.recordResumptionWithheld(run, latest, "repository_unchanged", now);
      this.maybeRemindParkedRound(run, binding, latest, now);
      if (run.currentPhase === "pr_handoff") {
        const gate = this.gateState(run);
        if (gate?.prKey) {
          this.transitionInspectorGate(
            run,
            gate,
            {
              ...gate,
              lastObservedAt: null,
              observedHeadSha: null,
              reviewPosture: null,
              waitReason: "awaiting_fresh_observation",
            },
            "waiting_for_inspector",
            "inspector_awaiting_fresh_observation",
            "pr_handoff_settled",
            { prKey: gate.prKey, submissionId: latest.id },
            now,
          );
        }
      }
      return;
    }
    // Re-read after the awaits above: a Foreman claim or a human Resubmit may have moved this
    // run while git was running, and the round we are about to create was computed from what
    // it looked like before.
    const stillEligible = this.resumableRun(runId, sessions, now);
    if (stillEligible.withheld !== undefined || stillEligible.latest.id !== latest.id) return;
    // Idempotent on the FAILED submission's fingerprint, which is the only one that exists
    // before capture. One auto-resumption per parked round, so two overlapping ticks - or a
    // daemon restart mid-capture - cannot open two.
    const triggerKey = `resume:${run.id}:${latest.evidenceFingerprint}`;
    const created = this.store.createRepairSubmission({
      id: randomUUID(),
      runId: run.id,
      round: latest.round + 1,
      triggerSource: "session" satisfies WorkflowTriggerSource,
      triggerKey,
      context: {},
      evidence: {},
      now,
    });
    if (created.idempotent) return;
    this.store.appendEvent(run.id, "resumption_started", {
      submissionId: created.submission.id,
      triggerKey,
      round: created.submission.round,
      previousFingerprint: latest.evidenceFingerprint,
    }, now);
    this.publishRun(run.id);
    workflowLog("info", {
      event: "resumption_started",
      run: run.id,
      submission: created.submission.id,
    });
    await this.captureAndActivate(
      binding,
      created.run,
      created.submission,
      latest.evidenceFingerprint,
      false,
    );
  }

  /**
   * The checkout a run's work lives in, or null when there is nothing to read.
   *
   * The BINDING's checkout rather than the session's, which is the whole reason this is a
   * lookup and not a field on the run summary. A multi-repo task's session holds one run per
   * repository, and only `WorkflowBinding.sessionCwd` says which worktree each one reviews -
   * `session.cwd` would answer with the session's own checkout for every one of them, so a
   * count of unpushed commits would be measured in the wrong repository and reported against
   * the right-looking run.
   *
   * Read by the away watcher's unpushed observer, on the same terms as `repeatOffenderSignals`
   * below: the watcher must not import this store, so what it needs arrives as a function.
   */
  bindingCheckout(bindingId: string): string | null {
    return this.store.getBinding(bindingId)?.sessionCwd ?? null;
  }

  /**
   * Members failing the most recent rounds consecutively, across every live run.
   *
   * Read by the away watcher, which folds it into the shared alert engine. It exists because
   * auto-resumption can now spend a run's whole repair budget with nobody watching: five
   * rounds of the same Persona rejecting the same work is a loop, not progress, and it used to
   * be visible only to someone who opened run detail.
   */
  repeatOffenderSignals(): WorkflowRunRepeatOffender[] {
    const live = new Set<string>();
    const out: WorkflowRunRepeatOffender[] = [];
    for (const run of this.store.listRuns()) {
      if (runIsTerminal(run)) continue;
      live.add(run.id);
      const cached = this.repeatOffenderCache.get(run.id);
      if (cached && cached.updatedAt === run.updatedAt) {
        out.push(...cached.offenders);
        continue;
      }
      const summary = this.store.runSummary(run.id);
      const submissions = this.store.listSubmissions(run.id);
      const attempts = submissions.flatMap((submission) => this.store.listAttempts(submission.id));
      const offenders = repeatOffenders(submissions, attempts).map((offender) => ({
        ...offender,
        runId: run.id,
        workflowName: summary?.workflowName ?? "Workflow",
        sessionId: summary?.sessionId ?? null,
        // The highest ROUND, never the submission count: one repair round may now hold
        // several evidence segments, and counting rows would report a run as further
        // through its repair budget than it is.
        round: summary?.round
          ?? submissions.reduce((highest, item) => Math.max(highest, item.round), 0),
        maxRepairRounds: run.maxRepairRounds,
      }));
      this.repeatOffenderCache.set(run.id, { updatedAt: run.updatedAt, offenders });
      out.push(...offenders);
    }
    for (const id of this.repeatOffenderCache.keys()) {
      if (!live.has(id)) this.repeatOffenderCache.delete(id);
    }
    return out;
  }

  private async withCaptureLock<T>(noteKey: string, fn: () => Promise<T>): Promise<T> {
    const before = this.captureLocks.get(noteKey);
    if (before) await before;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    this.captureLocks.set(noteKey, held);
    try {
      return await fn();
    } finally {
      if (this.captureLocks.get(noteKey) === held) this.captureLocks.delete(noteKey);
      release();
    }
  }

  private publishRun(runId: string): void {
    const summary = this.store.runSummary(runId);
    if (summary) this.registry.upsertWorkflowRun(summary);
  }

  /**
   * Push a binding's current state onto the fleet stream, or retire it from the stream.
   *
   * Archived is a REMOVAL rather than an upsert carrying `state: "archived"`, because every
   * consumer asks the same question - what is this conversation armed with - and an archived
   * binding is not an answer to it. Keeping it would make each surface re-filter, and one that
   * forgot would name a workflow that will never run. Orphaned and paused DO stay: they are
   * still the conversation's binding, and a surface that hid them would go back to claiming
   * an armed session is unarmed, which is the bug this stream exists to end.
   */
  private publishBinding(bindingId: string): void {
    const summary = this.store.bindingSummary(bindingId);
    if (!summary || summary.state === "archived") {
      this.registry.removeWorkflowBinding(bindingId);
      return;
    }
    this.registry.upsertWorkflowBinding(summary);
  }

  private finish(result: WorkflowStoreWrite): WorkflowMutation {
    if (!result.ok) return result;
    const summary = this.store.summary(result.workflow);
    this.registry.upsertWorkflow(summary);
    return { ok: true, workflow: result.workflow, summary };
  }
}
