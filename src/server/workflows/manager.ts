import { randomUUID } from "node:crypto";
import { repoAllowlisted } from "@shared/allowlist.ts";
import { paneToken } from "@shared/pane.ts";
import type { Session } from "@shared/types.ts";
import type {
  CreateWorkflow,
  CreateWorkflowBinding,
  ResolveWorkflowDelivery,
  ResubmitWorkflow,
  RetryWorkflowDelivery,
  RetryWorkflowRun,
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
  WorkflowSubmission,
  WorkflowSummary,
  WorkflowValidationResult,
  WorkflowVersion,
  WorkflowVersionMetadata,
  WorkflowDelivery,
  WorkflowCompletionClaim,
  WorkflowCompletionClaimResult,
  WorkflowTriggerSource,
} from "@shared/workflow.ts";
import { WORKFLOW_EXTERNAL_SOURCE_KINDS, normalizeWorkflowName } from "@shared/workflow.ts";
import { PersonaVerdictSchema, WorkflowCaptureExpectationSchema } from "@shared/protocol.ts";
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
  type WorkflowPublishWrite,
  type WorkflowStoreWrite,
} from "./store.ts";
import { workflowJson } from "./store.ts";
import { getWorkflowConfig } from "./config.ts";
import { renderWorkflowFeedback } from "./feedback.ts";

export type WorkflowMutation =
  | { ok: true; workflow: WorkflowDefinition; summary: WorkflowSummary }
  | Exclude<WorkflowStoreWrite, { ok: true }>;

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
   * Whether an external orchestrator may claim this session right now.
   *
   * Injected rather than imported: the owner of that answer is the orchestrator holding the
   * session, and a Workflow module that reached into its store to ask would be exactly the
   * dependency this boundary exists to prevent. Returns one sentence for a human, or null.
   */
  externalBindingEligibility?: ExternalBindingEligibility;
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
  private readonly captureLocks = new Map<string, Promise<void>>();
  private readonly deliveryTasks = new Set<Promise<void>>();
  private readonly queues: QueueManager;
  private readonly inject: typeof injectPrompt;
  private readonly rememberInjection: typeof recordInjection;
  private readonly schedule: ReviewScheduler;

  constructor(
    private readonly registry: Registry,
    readonly store = new WorkflowStore(),
    private readonly options: WorkflowManagerOptions = {},
  ) {
    this.queues = options.queueManager ?? new QueueManager(registry);
    this.inject = options.inject ?? injectPrompt;
    this.rememberInjection = options.recordInjection ?? recordInjection;
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
    this.engine = new WorkflowEngine(
      this.store,
      (runId) => this.publishRun(runId),
      {
        ...options.engine,
        schedule: this.schedule,
        onSubmissionWaiting: (submissionId) => {
          this.scheduleWaitingDelivery(submissionId);
          configuredWaiting?.(submissionId);
        },
      },
    );
    this.registry.initializeWorkflowRuns(this.runs());
    this.registry.registerWorkflowReset((noteKey) => {
      const removed = this.store.resetForNoteKey(noteKey);
      for (const id of removed) this.registry.removeWorkflowRun(id);
    });
  }

  start(): void {
    for (const delivery of this.store.recoverSendingDeliveries()) {
      this.publishRun(delivery.runId);
    }
    if (!this.unsubscribe) {
      this.unsubscribe = this.registry.subscribe((event) => {
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
      });
    }
    if (this.registry.sessionsObserved()) {
      this.recoverWaitingDeliveries();
      this.reconcileBindingsAfterDiscovery();
      this.engine.start();
    } else if (!this.discoveryUnsubscribe) {
      this.discoveryUnsubscribe = this.registry.onSessionsObserved(() => {
        this.discoveryUnsubscribe = null;
        this.recoverWaitingDeliveries();
        this.reconcileBindingsAfterDiscovery();
        this.engine.start();
      });
    }
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.discoveryUnsubscribe?.();
    this.discoveryUnsubscribe = null;
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

  validate(id: string, expectedDraftRevision: number): WorkflowValidationMutation {
    const workflow = this.store.getWorkflow(id);
    if (!workflow) return { ok: false, reason: "not_found", current: null };
    if (workflow.draftRevision !== expectedDraftRevision) {
      return { ok: false, reason: "revision_conflict", current: workflow };
    }
    const result = validateWorkflowGraph({
      graph: workflow.draft,
      personas: this.store.listPersonas(true),
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
      personas: this.store.listPersonas(true),
      completionPolicy: workflow.completionPolicy,
    }).diagnostics;
  }

  bindings(): WorkflowBinding[] {
    return this.store.listBindings();
  }

  runs(): WorkflowRunSummary[] {
    return this.store.listRunSummaries();
  }

  run(id: string): WorkflowRunDetail | null {
    return this.store.runDetail(id);
  }

  createBinding(input: CreateWorkflowBinding, now = Date.now()): WorkflowRuntimeMutation<WorkflowBinding> {
    const version = this.store.getWorkflowVersionById(input.workflowVersionId);
    if (!version) {
      return { ok: false, reason: "not_found", message: "No such immutable workflow version" };
    }
    const triggerMode = input.triggerMode ?? version.bindingDefaults.triggerMode;
    const deliveryMode = input.deliveryMode ?? version.bindingDefaults.deliveryMode;
    const maxRepairRounds = input.maxRepairRounds ?? version.bindingDefaults.maxRepairRounds;
    const session = this.registry.getSession(input.sessionId);
    if (!session || session.state === "exited") {
      return { ok: false, reason: "session_unavailable", message: "The selected session is not live" };
    }
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
    const binding = this.store.activeBindingForNote(noteKeyFor(session));
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
      if (pinned && pinned.expectedHeadSha !== expectation.data.expectedHeadSha) {
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
        pinned ?? expectation.data,
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
    const created = this.store.createInitialSubmission(
      { id: randomUUID(), binding, triggerSource, triggerKey: key, now },
      { id: randomUUID(), triggerSource, triggerKey: key, context: {}, evidence: {}, now },
    );
    if (created.idempotent) {
      return { ok: true, value: { run: created.run, submission: created.submission }, idempotent: true };
    }
    // Pin before capture, so a crash between the two leaves a run that still knows which
    // artifact it is entitled to rather than one that would accept whatever the retry names.
    this.store.pinExternalExpectation(created.run.id, expectation.data, now);
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
    for (const submission of this.store.listSubmissionsByState("waiting_for_session")) {
      this.scheduleWaitingDelivery(submission.id);
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
      this.store.setRunState(delivery.runId, "blocked", "delivery_blocked", {
        deliveryId: delivery.id,
        reason: initialBlock,
      });
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
        this.store.setRunState(sending.runId, "blocked", "delivery_refused", {
          deliveryId: sending.id,
          reason,
        });
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
    this.store.setRunState(delivery.runId, "blocked", "delivery_uncertain", {
      deliveryId: delivery.id,
      reason,
    });
    this.store.appendEvent(delivery.runId, "delivery_uncertain", {
      deliveryId: delivery.id,
      reason,
    });
    this.publishRun(delivery.runId);
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
    const submissions = this.store.listSubmissions(runId);
    return submissions.flatMap((submission) =>
      this.store.listAttempts(submission.id).flatMap((attempt) => {
        const parsed = PersonaVerdictSchema.safeParse(attempt.verdict);
        if (!parsed.success || parsed.data.verdict !== "fail" || !attempt.persona) return [];
        const verdict: PersonaVerdict = parsed.data;
        return [{
          personaName: attempt.persona.name,
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
