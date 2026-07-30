import { randomUUID } from "node:crypto";
import { repoAllowlisted } from "@shared/allowlist.ts";
import { paneToken } from "@shared/pane.ts";
import { AGENT_IDENTITY } from "@shared/agent.ts";
import { PULL_REQUEST_SKILL } from "@shared/skills.ts";
import { NO_MISTAKES_REVIEW_WORKFLOW_ID } from "@shared/builtin-workflow.ts";
import type { AgentType, Session, Task } from "@shared/types.ts";
import type {
  CreateWorkflow,
  CreateWorkflowBinding,
  ResolveWorkflowDelivery,
  ResubmitWorkflow,
  RetryWorkflowDelivery,
  RetryWorkflowRun,
  RestartFullWorkflow,
  SubmitWorkflow,
  UpdateWorkflow,
  UpdateWorkflowBinding,
} from "@shared/protocol.ts";
import type {
  PersonaFeedbackSummary,
  PersonaVerdict,
  WorkflowBinding,
  WorkflowCaptureExpectation,
  WorkflowContextSnapshot,
  WorkflowDefinition,
  WorkflowDetail,
  WorkflowDiagnostic,
  WorkflowJson,
  WorkflowRun,
  WorkflowRunDetail,
  WorkflowRunSummary,
  WorkflowRunPage,
  WorkflowEventPage,
  WorkflowLlmCallPage,
  WorkflowExportEnvelope,
  WorkflowStatus,
  WorkflowSubmission,
  WorkflowSummary,
  WorkflowValidationResult,
  WorkflowVersion,
  WorkflowVersionMetadata,
  WorkflowDelivery,
  WorkflowCompletionClaim,
  WorkflowCompletionClaimResult,
  WorkflowTriggerSource,
  WorkflowInspectorGateState,
} from "@shared/workflow.ts";
import {
  WORKFLOW_EXTERNAL_SOURCE_KINDS,
  isVerdictNode,
  normalizeWorkflowName,
  verdictAuthor,
} from "@shared/workflow.ts";
import {
  PersonaVerdictSchema,
  WorkflowCaptureExpectationSchema,
  WorkflowContextSnapshotSchema,
  WorkflowInspectorGateStateSchema,
} from "@shared/protocol.ts";
import type { InspectionUpdated, InspectorComment } from "@shared/types.ts";
import { validateWorkflowGraph } from "@shared/workflow-graph.ts";
import type { Registry } from "../registry.ts";
import { noteKeyFor } from "../registry.ts";
import { injectPrompt, type InjectResult } from "../actions.ts";
import { recordInjection } from "../injections.ts";
import { QueueManager } from "../queue.ts";
import { getForemanConfig } from "../foreman/config.ts";
import { harnessFor, sessionMessages } from "../harness/index.ts";
import { getLlmConfig, llmJobModel, llmRunnerChoice } from "../llm/config.ts";
import type { StructuredAttemptObserver } from "../llm/structured.ts";
import {
  DEFAULT_REVIEW_CONCURRENCY,
  createReviewScheduler,
  type ReviewScheduler,
} from "../llm/review-scheduler.ts";
import type { CheckScheduler } from "./checks.ts";
import {
  captureBoundaryChanged,
  captureStableWorkflowContext,
  compactWorkflowContext,
  readWorkflowContextRaw,
  workflowContextFingerprint,
} from "./context.ts";
import { WorkflowEngine, type WorkflowEngineOptions } from "./engine.ts";
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
import { getWorkflowConfig } from "./config.ts";
import {
  renderInspectorFeedback,
  renderPrHandoff,
  renderWorkflowFeedback,
} from "./feedback.ts";
import { findingFingerprintAudit } from "./finding-audit.ts";
import {
  getInspectorPr,
  loadInspectorComments,
  loadInspectorInspections,
} from "../db.ts";
import { getInspectorConfig } from "../inspector/config.ts";
import { parsePrUrl } from "../inspector/github.ts";
import { inspectorPosture } from "@shared/inspector.ts";
import { runWorkflowRetention, WORKFLOW_RETENTION_INTERVAL_MS } from "./retention.ts";
import { workflowLog } from "./log.ts";
import {
  requiredSkillCommand,
  type RequiredSkillCommand,
} from "../skills/invoke.ts";

export type WorkflowMutation =
  | { ok: true; workflow: WorkflowDefinition; summary: WorkflowSummary }
  | Exclude<WorkflowStoreWrite, { ok: true }>;

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

export interface WorkflowManagerOptions {
  engine?: WorkflowEngineOptions;
  readContextRaw?: typeof readWorkflowContextRaw;
  boundaryChanged?: typeof captureBoundaryChanged;
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
}

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
const EXTERNAL_RESUMABLE_PHASES = [
  "external_artifact_mismatch",
  "capture_interrupted",
  "capture_error",
  "stale_capture",
] as const;

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
  private readonly deliveryTasks = new Set<Promise<void>>();
  private readonly queues: QueueManager;
  private readonly inject: typeof injectPrompt;
  private readonly rememberInjection: typeof recordInjection;
  private readonly requireSkill: NonNullable<WorkflowManagerOptions["requireSkill"]>;
  private readonly schedule: ReviewScheduler;
  private retentionTimer: ReturnType<typeof setInterval> | null = null;
  private retentionRunning = false;
  private lastRecoveryAt: number | null = null;
  private lastRetentionAt: number | null = null;
  private lastRetentionError: string | null = null;
  private lastRetentionCompacted = 0;
  private lastRetentionDeleted = 0;

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
        // engine a second check budget alongside the daemon's.
        ...(options.checkScheduler ? { checkSchedule: options.checkScheduler } : {}),
        onSubmissionWaiting: (submissionId) => {
          this.scheduleWaitingDelivery(submissionId);
          configuredWaiting?.(submissionId);
        },
        onSubmissionSucceeded: (submissionId) =>
          this.enterInspectorGate(submissionId) || Boolean(configuredSucceeded?.(submissionId)),
      },
    );
    this.registry.initializeWorkflowRuns(this.runs());
    this.registry.registerWorkflowReset((noteKey) => {
      const removed = this.store.resetForNoteKey(noteKey);
      for (const id of removed) this.registry.removeWorkflowRun(id);
    });
  }

  start(): void {
    if (!this.inspectionUnsubscribe) {
      this.inspectionUnsubscribe = this.registry.onInspectionUpdated((event) => {
        this.scheduleInspectionUpdate(event);
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
              const run = this.store.activeRunForBinding(active.id);
              if (run) this.publishRun(run.id);
            }
          }
          return;
        }
        if (event.type !== "session_upsert") return;
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
            const run = this.store.activeRunForBinding(paused.id);
            if (run) this.publishRun(run.id);
          }
        }
        this.scheduleGatesForSession(event.session.id);
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
    await this.engine.stop();
    await Promise.allSettled([...this.deliveryTasks]);
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
      const config = getWorkflowConfig();
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
    const selectedVersionId = workflowId
      ? this.get(workflowId)?.workflow.currentVersionId ?? null
      : null;
    if (
      selectedVersionId
      && current.workflowVersionId === selectedVersionId
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

  create(input: CreateWorkflow, now = Date.now()): WorkflowMutation {
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
    const result = validateWorkflowGraph({
      graph: workflow.draft,
      personas: this.store.personaCatalog(),
      completionPolicy: workflow.completionPolicy,
    });
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
    return validateWorkflowGraph({
      graph: workflow.draft,
      personas: this.store.personaCatalog(),
      completionPolicy: workflow.completionPolicy,
    }).diagnostics;
  }

  bindings(): WorkflowBinding[] {
    return this.store.listBindings();
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

  status(): WorkflowStatus {
    return {
      ...this.store.workflowStatusCounts(),
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
    try {
      return {
        ok: true,
        value: this.store.insertBinding({
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
        }),
      };
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
    return updated
      ? { ok: true, value: updated }
      : { ok: false, reason: "not_found", message: "No such workflow binding" };
  }

  archiveBinding(id: string, now = Date.now()): WorkflowRuntimeMutation<WorkflowBinding> {
    const archived = this.store.archiveBindingAndCancel(id, now);
    if (archived?.cancelledRunId) this.publishRun(archived.cancelledRunId);
    return archived
      ? { ok: true, value: archived.binding }
      : { ok: false, reason: "not_found", message: "No such workflow binding" };
  }

  async submit(
    bindingId: string,
    input: SubmitWorkflow,
    now = Date.now(),
  ): Promise<WorkflowRuntimeMutation<WorkflowSubmitResult>> {
    const binding = this.store.getBinding(bindingId);
    if (!binding) return { ok: false, reason: "not_found", message: "No such workflow binding" };
    if (binding.state !== "active") {
      return { ok: false, reason: "inactive_binding", message: "The workflow binding is not active" };
    }
    const key = `manual:${binding.id}:${input.requestId}`;
    const existing = this.store.submissionByTrigger(key);
    if (existing) {
      const run = this.store.getRun(existing.runId);
      return run
        ? { ok: true, value: { run, submission: existing }, idempotent: true }
        : { ok: false, reason: "not_found", message: "The idempotent run is missing" };
    }
    const active = this.store.activeRunForBinding(binding.id);
    if (active) {
      return { ok: false, reason: "run_active", message: "This binding already has an active run", current: active };
    }
    const created = this.store.createInitialSubmission(
      { id: randomUUID(), binding, triggerSource: "manual", triggerKey: key, now },
      { id: randomUUID(), triggerSource: "manual", triggerKey: key, context: {}, evidence: {}, now },
    );
    if (created.idempotent) {
      return { ok: true, value: { run: created.run, submission: created.submission }, idempotent: true };
    }
    this.publishRun(created.run.id);
    return this.captureAndActivate(binding, created.run, created.submission);
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
        message: "Inspector-only repair resumes on a new head or through the confirmed full restart action",
      };
    }
    const binding = this.store.getBinding(run.bindingId);
    if (!binding) return { ok: false, reason: "not_found", message: "The run binding is missing" };
    if (externallySourced(run)) {
      return { ok: false, reason: "unsupported_mode", message: EXTERNAL_MANUAL_ROUND_REFUSAL };
    }
    const key = `manual:${binding.id}:${input.requestId}`;
    const existing = this.store.submissionByTrigger(key);
    if (existing) {
      const existingRun = this.store.getRun(existing.runId) ?? run;
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
      this.store.setRunState(run.id, "blocked", "round_limit", { maxRepairRounds: run.maxRepairRounds }, now);
      this.publishRun(run.id);
      return {
        ok: false,
        reason: "round_limit",
        message: "The workflow has exhausted its configured repair rounds",
      };
    }
    const created = this.store.createRepairSubmission({
      id: randomUUID(),
      runId: run.id,
      round: latest.round + 1,
      triggerSource: "manual",
      triggerKey: key,
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
    const candidateUrl = session?.state !== "exited" ? session?.prUrl ?? null : null;
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
        && binding.deliveryMode === "live"
        && binding.sessionId
      ) {
        this.scheduleAutomaticPr(run.id, submission.id, now);
      }
    }
    return true;
  }

  /** Shipping may only be vetoed by active Inspector-gated workflow ownership. */
  blocksMerge(prKey: string): boolean {
    for (const binding of this.store.listBindings()) {
      if (binding.state !== "active") continue;
      const run = this.store.activeRunForBinding(binding.id);
      const version = run ? this.store.getWorkflowVersionById(run.workflowVersionId) : null;
      if (!run || version?.completionPolicy.kind !== "inspector") continue;
      const gate = this.gateState(run);
      if (gate?.prKey === prKey) return true;
      const session = binding.sessionId ? this.registry.getSession(binding.sessionId) : undefined;
      const candidate = session?.state !== "exited" && session?.prUrl
        ? parsePrUrl(session.prUrl)
        : null;
      if (candidate?.key === prKey) return true;
    }
    return false;
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
      return { ok: false, reason: "not_found", message: "No active Inspector gate exists" };
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
      return { ok: false, reason: "not_found", message: "No active Inspector gate exists" };
    }
    if (runIsTerminal(run)) {
      return {
        ok: false,
        reason: "run_not_waiting",
        message: "This Inspector gate is already terminal",
      };
    }
    const repeated = this.store.listEvents(run.id).some((event) =>
      event.kind === "inspector_recheck_requested"
      && event.payload
      && !Array.isArray(event.payload)
      && typeof event.payload === "object"
      && event.payload.requestId === requestId);
    if (repeated) return { ok: true, value: run, idempotent: true };
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
      return {
        ok: true,
        value: { run, submission: existing },
        idempotent: true,
      };
    }
    const gate = run ? this.gateState(run) : null;
    const latest = run ? this.store.latestSubmission(run.id) : null;
    if (!run || !gate || !binding || !latest) {
      return { ok: false, reason: "not_found", message: "No active Inspector gate exists" };
    }
    const abandoningBypass =
      run.status === "waiting_for_new_head"
      || latest.mode === "inspector_only";
    if (!abandoningBypass) {
      return {
        ok: false,
        reason: "run_not_waiting",
        message: "Full restart is the explicit escape from an active Inspector-only repair",
      };
    }
    if (input.confirmation !== "RESTART FULL WORKFLOW") {
      return {
        ok: false,
        reason: "confirmation_required",
        message: "Type RESTART FULL WORKFLOW to abandon the active Inspector-only repair",
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
        message: "Inspector-only repair can be abandoned only through the confirmed full restart action",
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
        }
        if (resolved.rearmedDrain) this.queues.refresh(delivery.noteKey);
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
      this.store.setRunState(run.id, "blocked", "round_limit", {
        maxRepairRounds: run.maxRepairRounds,
      }, now);
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
    if (replaced.idempotent && replaced.submission.status !== "capturing") {
      return {
        ok: true,
        value: { run: replaced.run, submission: replaced.submission },
        idempotent: true,
      };
    }
    const captured = await this.captureAndActivate(
      binding,
      replaced.run,
      replaced.submission,
      latest.evidenceFingerprint,
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
    let binding = this.store.activeBindingForNote(noteKeyFor(session));
    if (!binding && claim.fallbackWorkflow === "no-mistakes") {
      const workflow = this.get(NO_MISTAKES_REVIEW_WORKFLOW_ID);
      const versionId = workflow?.workflow.currentVersionId ?? null;
      if (!workflow || workflow.workflow.archivedAt !== null || !versionId) {
        throw new Error("The built-in No-Mistakes Review workflow is unavailable");
      }
      const workflowConfig = getWorkflowConfig();
      const liveDeliveryAuthorized = workflowConfig.liveEnabled
        && repoAllowlisted(session.cwd, session.repoRoot, workflowConfig.repoAllowlist);
      const created = this.createBinding({
        workflowVersionId: versionId,
        sessionId: session.id,
        // The completion claim is already the verified Foreman boundary. Pin this explicitly
        // even if a later built-in version changes its ordinary binding default.
        triggerMode: "foreman_complete",
        // Foreman's setting authorizes reaching this review boundary, not Workflow repair
        // prompts. Preserve the built-in's Live default only when Workflows Live separately
        // authorizes this repository; otherwise the review still runs and any repair is
        // presented as Preview instead of failing to bind at all.
        deliveryMode: liveDeliveryAuthorized ? "live" : "preview",
      }, now);
      if (created.ok) {
        binding = created.value;
      } else {
        // A concurrent claim or operator bind may have won the unique active-note-key slot.
        // Re-read the winner instead of retrying the insert. The completion marker below is
        // independently idempotent, so both requests converge on one binding and one run.
        binding = this.store.activeBindingForNote(noteKeyFor(session));
        if (!binding) {
          throw new Error(`No-Mistakes Review could not be bound: ${created.message}`);
        }
      }
    }
    if (!binding) return { claimed: false, reason: "no_binding" };
    if (binding.triggerMode !== "foreman_complete") {
      return { claimed: false, reason: "manual_trigger" };
    }
    const stored = this.store.claimForemanCompletion({
      binding,
      completionKind: claim.completionKind,
      marker: claim.marker,
      summary: claim.summary,
      evidenceFingerprint: claim.evidenceFingerprint,
      expectedGoal: claim.expectedGoal,
      runId: randomUUID(),
      submissionId: randomUUID(),
      now,
    });
    this.queues.refresh(binding.noteKey);
    this.publishRun(stored.run.id);
    if (!stored.created || !stored.submission) return stored.result;
    const activated = await this.captureAndActivate(
      binding,
      stored.run,
      stored.submission,
      stored.previousFingerprint,
      false,
    );
    if (!activated.ok) {
      return {
        claimed: true,
        runId: stored.run.id,
        submissionId: stored.submission.id,
        state: "blocked",
      };
    }
    return stored.result;
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
        EXTERNAL_RESUMABLE_PHASES,
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
      const session = binding?.sessionId ? this.registry.getSession(binding.sessionId) : undefined;
      const candidate = session?.prUrl ? parsePrUrl(session.prUrl) : null;
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
    this.trackDeliveryTask(task);
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
    if (!run || !state || runIsTerminal(run) || run.status === "waiting_for_session") return;
    if (run.status === "blocked" && run.currentPhase !== "inspector_disabled") return;
    const binding = this.store.getBinding(run.bindingId);
    const version = this.store.getWorkflowVersionById(run.workflowVersionId);
    if (!binding || version?.completionPolicy.kind !== "inspector") return;
    const now = Date.now();
    const session = binding.sessionId ? this.registry.getSession(binding.sessionId) : undefined;
    const candidateUrl = session?.state !== "exited" ? session?.prUrl ?? null : null;
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
      if (!adopted) {
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
        "waiting_for_inspector",
        "inspector_awaiting_fresh_observation",
        "inspector_pr_pinned",
        { prKey: adopted.key, source: adopted.source },
        now,
      );
      if (!updated) return;
      run = updated;
      state = pinned;
    }

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
        bypassReason: "Published Inspector-only findings policy",
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
      this.transitionInspectorGate(
        run,
        state,
        { ...state, waitReason: "head_mismatch" },
        afterPin
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
      const config = getWorkflowConfig();
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
    for (const delivery of this.store.listDeliveriesByState("prepared")) {
      if (submissionRecovery.has(delivery.submissionId)) continue;
      const run = this.store.getRun(delivery.runId);
      const binding = run ? this.store.getBinding(run.bindingId) : null;
      const latestSubmission = run ? this.store.latestSubmission(run.id) : null;
      const version = run ? this.store.getWorkflowVersionById(run.workflowVersionId) : null;
      const gate = run ? this.gateState(run) : null;
      const inspectorOnly =
        version?.completionPolicy.kind === "inspector"
        && version.completionPolicy.onFindings === "inspector_only";
      if (
        delivery.kind !== "inspector_feedback"
        || !run
        || runIsTerminal(run)
        || binding?.deliveryMode !== "live"
        || latestSubmission?.id !== delivery.submissionId
        || run.status !== (inspectorOnly ? "waiting_for_new_head" : "waiting_for_session")
        || run.currentPhase !== "inspector_findings"
        || gate?.waitReason !== "findings"
        || !gate.targetHeadSha
        || gate.targetHeadSha !== gate.failedHeadSha
      ) continue;
      this.schedulePreparedDelivery(delivery.id);
    }
  }

  private scheduleWaitingDelivery(submissionId: string): void {
    this.trackDeliveryTask(this.prepareAndMaybeDeliver(submissionId).catch((error) => {
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
    this.trackDeliveryTask(
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
    this.trackDeliveryTask(this.deliverPrepared(deliveryId, false).catch((error) => {
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

  private trackDeliveryTask(task: Promise<void>): void {
    this.deliveryTasks.add(task);
    void task.then(
      () => this.deliveryTasks.delete(task),
      () => this.deliveryTasks.delete(task),
    );
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
    if (delivery.kind === "pr_handoff") {
      const required = this.requireSkill(session, PULL_REQUEST_SKILL);
      if (!required.ok) return "required_skill_unavailable";
      if (!delivery.payload.startsWith(`${required.command}\n`)) {
        return "required_skill_invocation_stale";
      }
    }
    if (expectedPane !== undefined && paneToken(session) !== expectedPane) return "pane_recreated";
    if (this.registry.sessionResetInProgress(session.id)) return "reset_in_progress";
    const config = getWorkflowConfig();
    if (!config.liveEnabled || !repoAllowlisted(session.cwd, session.repoRoot, config.repoAllowlist)) {
      return "live_not_authorized";
    }
    return this.registry.promptResourceBlockerForSession(session.id);
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
    if (confirmed.rearmedDrain) this.queues.refresh(sending.noteKey);
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

  private async captureAndActivate(
    binding: WorkflowBinding,
    run: WorkflowRun,
    submission: WorkflowSubmission,
    previousFingerprint?: string,
    allowUnchanged = false,
    expectation?: WorkflowCaptureExpectation,
  ): Promise<WorkflowRuntimeMutation<WorkflowSubmitResult>> {
    try {
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
      // Persist bounded raw intent and evidence before the advisory model call.
      this.store.updateSubmissionCapture(submission.id, {
        context: workflowJson(captured.context),
        evidence: workflowJson(captured.context.evidence),
      }, Date.now());
      let context: WorkflowContextSnapshot;
      const compact = this.options.compactContext;
      if (compact) {
        context = await this.schedule(() => compact(captured.raw));
      } else {
        const config = getLlmConfig();
        const contextRunner = llmRunnerChoice(config);
        const contextModel = llmJobModel("workflow-context", config);
        const contextCallIds = new Map<number, string>();
        const observer: StructuredAttemptObserver = {
          start: (attempt, prompt) => {
            if (!this.captureIsActive(run.id, submission.id)) return false;
            const id = randomUUID();
            contextCallIds.set(attempt, id);
            this.store.insertLlmCall({
              id,
              runId: run.id,
              submissionId: submission.id,
              nodeAttemptId: null,
              purpose: "context_compaction",
              runner: contextRunner.id,
              model: contextModel.id,
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
        context = await this.schedule(() => compactWorkflowContext(captured.raw, {
          runner: contextRunner.id,
          model: contextModel.id,
          observer,
        }));
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
      const runnable = this.store.updateSubmissionCapture(submission.id, {
        context: workflowJson(context),
        evidence: workflowJson(context.evidence),
        fingerprint,
        status: "running",
      }, Date.now());
      if (previousFingerprint && fingerprint === previousFingerprint && !allowUnchanged) {
        this.store.setSubmissionState(submission.id, "failed", Date.now());
        this.store.setRunState(run.id, "waiting_for_session", "unchanged_evidence", {
          evidenceFingerprint: fingerprint,
        }, Date.now());
        this.store.appendEvent(run.id, "resubmit_refused_unchanged", {
          triggerKey: submission.triggerKey,
          evidenceFingerprint: fingerprint,
        }, Date.now());
        this.publishRun(run.id);
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
      }, Date.now());
      this.engine.activateSubmission(submission.id);
      const updatedRun = this.store.getRun(run.id) ?? run;
      this.publishRun(run.id);
      return { ok: true, value: { run: updatedRun, submission: runnable } };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.captureIsActive(run.id, submission.id)) {
        this.store.setSubmissionState(submission.id, "failed", Date.now());
        this.store.setRunState(run.id, "blocked", "capture_error", { error: message }, Date.now());
        this.store.appendEvent(run.id, "capture_error", {
          submissionId: submission.id,
          error: message,
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
      const run = this.store.activeRunForBinding(updated.id);
      if (run) this.publishRun(run.id);
    }
  }

  private startEngineAndMaintenance(): void {
    this.engine.start();
    this.lastRecoveryAt = Date.now();
    workflowLog("info", { event: "recovery_complete", at: this.lastRecoveryAt });
    void this.sweepRetention();
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
        getWorkflowConfig().retention,
      );
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

  private finish(result: WorkflowStoreWrite): WorkflowMutation {
    if (!result.ok) return result;
    const summary = this.store.summary(result.workflow);
    this.registry.upsertWorkflow(summary);
    return { ok: true, workflow: result.workflow, summary };
  }
}
