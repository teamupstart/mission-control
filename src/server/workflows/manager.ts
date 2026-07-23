import { randomUUID } from "node:crypto";
import type {
  CreateWorkflow,
  CreateWorkflowBinding,
  ResubmitWorkflow,
  RetryWorkflowRun,
  SubmitWorkflow,
  UpdateWorkflow,
  UpdateWorkflowBinding,
} from "@shared/protocol.ts";
import type {
  PersonaFeedbackSummary,
  PersonaVerdict,
  WorkflowBinding,
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
} from "@shared/workflow.ts";
import { normalizeWorkflowName } from "@shared/workflow.ts";
import { PersonaVerdictSchema } from "@shared/protocol.ts";
import { validateWorkflowGraph } from "@shared/workflow-graph.ts";
import type { Registry } from "../registry.ts";
import { noteKeyFor } from "../registry.ts";
import { getLlmConfig, llmJobModel, llmRunnerChoice } from "../llm/config.ts";
import type { StructuredAttemptObserver } from "../llm/structured.ts";
import {
  captureBoundaryChanged,
  captureStableWorkflowContext,
  compactWorkflowContext,
  readWorkflowContextRaw,
  workflowContextFingerprint,
} from "./context.ts";
import { WorkflowEngine, type WorkflowEngineOptions } from "./engine.ts";
import {
  WorkflowStore,
  type WorkflowPublishWrite,
  type WorkflowStoreWrite,
} from "./store.ts";
import { workflowJson } from "./store.ts";

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
        | "stale_capture";
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
}

/** Definition policy and catalog SSE. Execution policy joins this manager in Phase 3. */
export class WorkflowManager {
  readonly engine: WorkflowEngine;
  private unsubscribe: (() => void) | null = null;
  private discoveryUnsubscribe: (() => void) | null = null;
  private readonly captureLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly registry: Registry,
    readonly store = new WorkflowStore(),
    private readonly options: WorkflowManagerOptions = {},
  ) {
    this.registry.initializeWorkflows(this.list(true));
    this.engine = new WorkflowEngine(
      this.store,
      (runId) => this.publishRun(runId),
      options.engine,
    );
    this.registry.initializeWorkflowRuns(this.runs());
    this.registry.registerWorkflowReset((noteKey) => {
      const removed = this.store.resetForNoteKey(noteKey);
      for (const id of removed) this.registry.removeWorkflowRun(id);
    });
  }

  start(): void {
    for (const binding of this.store.listBindings()) {
      if (
        binding.state === "active"
        && (binding.triggerMode !== "manual" || binding.deliveryMode !== "preview")
      ) {
        const paused = this.store.pauseBinding(binding.id, "unsupported_binding_mode");
        const run = paused ? this.store.activeRunForBinding(paused.id) : null;
        if (run) this.publishRun(run.id);
      }
    }
    if (!this.unsubscribe) {
      this.unsubscribe = this.registry.subscribe((event) => {
        if (event.type === "session_remove") {
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
          const paused = this.store.pauseBinding(binding.id, "conversation_changed");
          if (paused) {
            const run = this.store.activeRunForBinding(paused.id);
            if (run) this.publishRun(run.id);
          }
        }
      });
    }
    if (!this.discoveryUnsubscribe) {
      this.discoveryUnsubscribe = this.registry.onSessionsObserved(() => {
        this.discoveryUnsubscribe = null;
        this.reconcileBindingsAfterDiscovery();
      });
    }
    this.engine.start();
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.discoveryUnsubscribe?.();
    this.discoveryUnsubscribe = null;
    await this.engine.stop();
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
    if (triggerMode !== "manual" || deliveryMode !== "preview") {
      return {
        ok: false,
        reason: "unsupported_mode",
        message: "Phase 3 supports active manual Preview bindings only",
      };
    }
    const session = this.registry.getSession(input.sessionId);
    if (!session || session.state === "exited") {
      return { ok: false, reason: "session_unavailable", message: "The selected session is not live" };
    }
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
    if (state === "active" && (triggerMode !== "manual" || deliveryMode !== "preview")) {
      return {
        ok: false,
        reason: "unsupported_mode",
        message: "Phase 3 supports active manual Preview bindings only",
      };
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
    if (binding.triggerMode !== "manual" || binding.deliveryMode !== "preview") {
      return {
        ok: false,
        reason: "unsupported_mode",
        message: "Phase 3 supports manual Preview runs only",
      };
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
      { id: randomUUID(), binding, triggerKey: key, now },
      { id: randomUUID(), triggerKey: key, context: {}, evidence: {}, now },
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
          this.store.setSubmissionState(existing.id, "running", now);
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
    if (binding.triggerMode !== "manual" || binding.deliveryMode !== "preview") {
      return {
        ok: false,
        reason: "unsupported_mode",
        message: "This binding uses a workflow mode that is not executable in Phase 3",
        current: binding,
      };
    }
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

  private async captureAndActivate(
    binding: WorkflowBinding,
    run: WorkflowRun,
    submission: WorkflowSubmission,
    previousFingerprint?: string,
    allowUnchanged = false,
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
      // Persist bounded raw intent and evidence before the advisory model call.
      this.store.updateSubmissionCapture(submission.id, {
        context: workflowJson(captured.context),
        evidence: workflowJson(captured.context.evidence),
      }, Date.now());
      let context: WorkflowContextSnapshot;
      if (this.options.compactContext) {
        context = await this.options.compactContext(captured.raw);
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
        context = await compactWorkflowContext(captured.raw, {
          runner: contextRunner.id,
          model: contextModel.id,
          observer,
        });
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
