/** Observations only. WorkflowStore remains the owner of every execution decision. */
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { TelemetryProfileId } from "@shared/telemetry.ts";
import type { z } from "zod";
import type { TelemetryEventDefinition } from "@shared/telemetry-catalog.ts";
import type { WorkflowRun, WorkflowNodeAttempt, WorkflowLlmCall, WorkflowSubmission } from "@shared/workflow.ts";
import { WORKFLOW_RUN_TERMINAL_STATUSES } from "@shared/workflow.ts";
import { PersonaVerdictSchema } from "@shared/protocol.ts";
import { decodeWorkflowRunLifecycle } from "@shared/workflow-lifecycle.ts";
import { projectStages, stageMembers } from "@shared/workflow-stages.ts";
import { workflowFindingReason } from "@shared/workflow-reasons.ts";
import {
  WORKFLOW_ASSET_EVENT, WORKFLOW_PROGRESS_EVENT, WORKFLOW_RUN_EVENT, WORKFLOW_SUBMISSION_EVENT, WORKFLOW_NODE_EVENT, WORKFLOW_REVIEW_EVENT,
  WORKFLOW_RESPONSE_EVENT, WORKFLOW_FINDING_EVENT, WORKFLOW_STAGE_EVENT, WORKFLOW_DELIVERY_EVENT,
  WORKFLOW_CAUSE_EVENT, workflowModel,
} from "@shared/telemetry-sources/workflows.ts";
import {
  registerWorkflowMutationObserver, type WorkflowMutation, type WorkflowMutationObserver, type WorkflowMutationView,
} from "../workflows/mutations.ts";
import { openDb } from "../db.ts";
import { captureTelemetry } from "./capture.ts";
import { capturingProfiles, getTelemetryConfig } from "./config.ts";
import { digest } from "./identity.ts";
import { workflowAuthorContext } from "./sessions.ts";
import { readSourceState, writeSourceState } from "./source-state.ts";
import { getDestination, recordGap, resetUsedBytesCache, telemetryTransaction } from "./store.ts";
import { registerTelemetrySource } from "./registration.ts";

const SOURCE = "mission.workflow";
const actor = { kind: "workflow", origin: "daemon", basis: "owner" } as const;
const unknownAuthor = { author_model: "unknown", author_effort: "unknown", author_quality: "unknown" } as const;
type Author = ReturnType<typeof workflowAuthorContext>;
interface Context { facts: Author["facts"] & { workflow: "builtin" | "custom" | "unknown" }; refs: Record<string, string> }

/** Checkpoints and frozen context belong to one audience's continuous consent window. */
interface WorkflowObservationScope { profile: TelemetryProfileId; namespace: string }
function forWorkflowProfiles(observe: (scope: WorkflowObservationScope) => void): void {
  for (const profile of capturingProfiles(getTelemetryConfig())) {
    const epoch = getDestination(openDb(), profile).policyEpoch;
    observe({ profile, namespace: `${SOURCE}:${profile}:${epoch}` });
  }
}

/** Failure rolls back only telemetry, even when a business transaction is already open. */
export function observeWorkflowWrite(db: DatabaseSync, observe: (scope: WorkflowObservationScope) => void): void {
  try {
    if (db !== openDb() || !getTelemetryConfig().enabled) return;
    telemetryTransaction(() => forWorkflowProfiles(observe));
  } catch {
    try { telemetryTransaction((d) => recordGap(d, "capture_refused", "workflow observation unavailable", Date.now())); } catch {}
  }
}
function emit<S extends z.ZodTypeAny>(scope: WorkflowObservationScope, event: TelemetryEventDefinition<S>, id: string,
  ctx: Context, facts: Record<string, unknown>, now: number, refs: Record<string, string> = {}): void {
  const result = captureTelemetry({ event, profiles: [scope.profile],
    // Permanent business identities stay stable across epochs: a replay is not a new review.
    source: { kind: SOURCE, id: `${scope.profile}:${id}`, revision: 1 }, actor,
    facts: { ...ctx.facts, ...facts }, refs: { ...ctx.refs, ...refs }, occurredAt: now,
    trace: { traceId: digest(["workflow-submission", ctx.refs.submission_id ?? ctx.refs.run_id ?? id]), parentSpanId: null }, now });
  if (result.kind === "refused") throw new Error("workflow telemetry capture refused");
}
function context(scope: WorkflowObservationScope, store: WorkflowMutationView, run: WorkflowRun, submission: WorkflowSubmission | null, now: number): Context {
  const binding = store.getBinding(run.bindingId);
  const version = store.getWorkflowVersionById(run.workflowVersionId);
  const author = submission ? readSourceState<Author>(scope.namespace, `author:${submission.id}`, now) : null;
  return { facts: { ...(author?.facts ?? unknownAuthor),
    workflow: version ? store.getWorkflow(version.workflowId)?.builtin ? "builtin" : "custom" : "unknown" },
    refs: { ...author?.refs, run_id: run.id, binding_id: run.bindingId, version_id: run.workflowVersionId,
      ...(version ? { workflow_id: version.workflowId } : {}),
      ...(!submission && binding?.sessionId ? { session_id: binding.sessionId } : {}),
      ...(submission ? { submission_id: submission.id } : {}) } };
}
export function observeWorkflowAsset(scope: WorkflowObservationScope, store: WorkflowMutationView, entity: "definition" | "version" | "binding", id: string, now: number): void {
  const binding = entity === "binding" ? store.getBinding(id) : null;
  const version = entity === "version" ? store.getWorkflowVersionById(id)
    : binding ? store.getWorkflowVersionById(binding.workflowVersionId) : null;
  const definition = store.getWorkflow(entity === "definition" ? id : version?.workflowId ?? "");
  if (!binding && !version && !definition) return;
  const revision = entity === "binding" ? 0 : entity === "version" ? version?.version ?? 0 : definition?.draftRevision ?? 0;
  const state = binding?.state ?? (entity === "version" ? "published" : definition?.archivedAt ? "archived" : "draft");
  const signature = digest([revision, state, binding?.workflowVersionId, binding?.triggerMode, binding?.deliveryMode]);
  const key = `asset:${entity}:${id}`;
  const previous = readSourceState<{ signature: string; revision: number; generation: string }>(scope.namespace, key, now);
  if (previous?.signature === signature) return;
  const observation = (previous?.revision ?? 0) + 1;
  const generation = previous?.generation ?? randomUUID();
  emit(scope, WORKFLOW_ASSET_EVENT, `${key}:${generation}:${observation}`, { facts: { ...unknownAuthor,
    workflow: definition?.builtin ? "builtin" : definition ? "custom" : "unknown" }, refs: {
      ...(definition ? { workflow_id: definition.id } : {}), ...(version ? { version_id: version.id } : {}),
      ...(binding ? { binding_id: binding.id } : {}),
    } }, { entity, revision, state }, now);
  writeSourceState(scope.namespace, key, { signature, revision: observation, generation }, now);
}
export function workflowWait(run: WorkflowRun): "none" | "agent" | "external" | "human" | "unknown" {
  if (WORKFLOW_RUN_TERMINAL_STATUSES.includes(run.status as typeof WORKFLOW_RUN_TERMINAL_STATUSES[number])) return "none";
  const decoded = decodeWorkflowRunLifecycle({ status: run.status, phase: run.currentPhase, gateState: run.gateState });
  if (!decoded.phaseRecognized) return "unknown";
  if (["waiting_for_session", "waiting_for_action", "waiting_for_evidence_readiness"].includes(run.status)) return "agent";
  if (decoded.gate) return "external";
  if (decoded.detail.kind === "round_limit" || decoded.detail.kind === "capture_failure" || decoded.detail.kind === "check_cleanup") return "human";
  return run.status === "blocked" ? "unknown" : "none";
}
interface RunState { signature: string; revision: number; generation: string; wait: ReturnType<typeof workflowWait>; since: number; start: number | null }
export function observeWorkflowRun(scope: WorkflowObservationScope, store: WorkflowMutationView, id: string, now: number, atCreation = false): void {
  const run = store.getRun(id);
  if (!run) return;
  const key = `run:${id}`;
  const previous = readSourceState<RunState>(scope.namespace, key, now);
  const wait = workflowWait(run);
  const signature = digest([run.status, run.currentPhase, wait]);
  if (previous?.signature === signature) return;
  const terminal = WORKFLOW_RUN_TERMINAL_STATUSES.includes(run.status as typeof WORKFLOW_RUN_TERMINAL_STATUSES[number]);
  const started = !previous && atCreation;
  const start = previous?.start ?? (started ? run.startedAt : null);
  const revision = (previous?.revision ?? 0) + 1;
  // A consent boundary resets this audience's checkpoints; accepted journal identities remain. A new
  // observation window must not collide with an earlier window's revision 1.
  const generation = previous?.generation ?? randomUUID();
  emit(scope, WORKFLOW_RUN_EVENT, terminal ? `${key}:finished` : `${key}:${generation}:${revision}`, context(scope, store, run, store.latestSubmissionForRun(id), now), {
    observation: terminal ? "finished" : started ? "started" : "changed", status: run.status,
    wait, previous_wait: previous?.wait ?? "unknown",
    wait_ms: previous && previous.wait !== wait ? Math.max(0, now - previous.since) : null,
    duration_ms: terminal && start !== null ? Math.max(0, now - start) : null,
    time_quality: start === null ? "unknown" : "wall_clock",
  }, now);
  writeSourceState(scope.namespace, key, { signature, revision, generation, wait,
    since: previous?.wait === wait ? previous.since : now, start }, now);
}
export function observeWorkflowSubmission(scope: WorkflowObservationScope, store: WorkflowMutationView, id: string, now: number): void {
  const submission = store.getSubmission(id);
  const run = submission && store.getRun(submission.runId);
  if (!submission || !run) return;
  const key = `author:${id}`;
  if (readSourceState(scope.namespace, key, now)) return;
  const binding = store.getBinding(run.bindingId);
  // Only the creation seam reads live session context. A historical recovery never does.
  const author = submission.createdAt === now && binding?.sessionId
    ? workflowAuthorContext(binding.sessionId) : { facts: unknownAuthor, refs: {} };
  writeSourceState(scope.namespace, key, { ...author, refs: {
    ...author.refs, ...(submission.createdAt === now && binding?.sessionId ? { session_id: binding.sessionId } : {}),
  } }, now);
  const repairKey = `round:${run.id}:${submission.round}`;
  const repair = submission.round > 1 && !readSourceState(scope.namespace, repairKey, now);
  emit(scope, WORKFLOW_SUBMISSION_EVENT, `submission:${id}`, context(scope, store, run, submission, now), {
    round: submission.round, segment: submission.segment, repair_round: repair,
    trigger: ["manual", "foreman", "automatic"].includes(submission.triggerSource) ? submission.triggerSource : "unknown",
    pickup: "unknown",
  }, now);
  writeSourceState(scope.namespace, repairKey, true, now);
  observeWorkflowRun(scope, store, run.id, now, submission.round === 1 && submission.segment === 0);
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
function reviewer(attempt: WorkflowNodeAttempt) {
  return { reviewer_model: workflowModel(attempt.model), reviewer_runner: attempt.runner ?? "unknown",
    // The current LlmRunner API supplies no observed reviewer effort.
    reviewer_effort: "unknown", directive: !!attempt.operatorDirective };
}
export function observeWorkflowAttempt(scope: WorkflowObservationScope, store: WorkflowMutationView, id: string, now: number): void {
  const attempt = store.getAttempt(id);
  const submission = attempt && store.getSubmission(attempt.submissionId);
  const run = submission && store.getRun(submission.runId);
  if (!attempt || !submission || !run) return;
  const ctx = context(scope, store, run, submission, now);
  const version = store.getWorkflowVersionById(run.workflowVersionId);
  const node = version?.graph.nodes.find((n) => n.id === attempt.nodeId);
  const stages = version ? projectStages(version.graph)?.stages : null;
  const stage = stages?.find((s) => stageMembers(s).some((m) => m.nodeId === attempt.nodeId) || (s.kind === "evaluation" && s.joinId === attempt.nodeId));
  const stageId = stage ? digest([run.workflowVersionId, stageMembers(stage).map((m) => m.nodeId)]) : null;
  const refs = { attempt_id: id, node_id: attempt.nodeId, ...(stageId ? { stage_id: stageId } : {}),
    ...(attempt.persona ? { persona_id: attempt.persona.sourcePersonaId, persona_revision: String(attempt.persona.sourceRevision) } : {}) };
  const actionState = attempt.sessionAction ? record(attempt.output) : {};
  const anchor = record(actionState.anchor);
  if (typeof actionState.pickedUpAt === "number") {
    emit(scope, WORKFLOW_PROGRESS_EVENT, `pickup:${id}`, ctx, {
      observation: "pickup", duration_ms: typeof anchor.deliveredAt === "number" ? Math.max(0, actionState.pickedUpAt - anchor.deliveredAt) : null,
      time_quality: "wall_clock", coverage: "session_action",
    }, actionState.pickedUpAt, { ...refs, ...(typeof actionState.deliveryId === "string" ? { delivery_id: actionState.deliveryId } : {}) });
    if (typeof actionState.continuationSubmissionId === "string" && attempt.state === "completed") {
      const child = store.getSubmission(actionState.continuationSubmissionId);
      if (child) emit(scope, WORKFLOW_PROGRESS_EVENT, `resubmitted:${id}`, ctx, {
        observation: "resubmitted", duration_ms: Math.max(0, child.createdAt - actionState.pickedUpAt),
        time_quality: "wall_clock", coverage: "session_action",
      }, child.createdAt, { ...refs, submission_id: child.id });
    }
  }
  const key = `attempt:${id}`;
  const previous = readSourceState<{ state: string; verdict: boolean }>(scope.namespace, key, now);
  const terminal = ["completed", "error", "cancelled"].includes(attempt.state);
  const late = attempt.state === "cancelled" && !!attempt.verdict;
  if (previous?.state === attempt.state && previous.verdict === !!attempt.verdict) return;
  const output = record(attempt.output);
  const disposition = attempt.state === "cancelled" ? "cancelled" : attempt.state === "error" ? "infrastructure_error"
    : !terminal ? "pending" : output.disabled === true ? "disabled" : typeof output.reusedPassAttemptId === "string" ? "reused" : "executed";
  const observation = late ? "late_result" : terminal ? "finished" : attempt.state === "running" ? "started" : attempt.state === "retry_wait" ? "queued" : "eligible";
  emit(scope, WORKFLOW_NODE_EVENT, `${key}:${observation}:${attempt.state}`, ctx, {
    observation, node_kind: node?.kind ?? "unknown", disposition, stage_projection: stage ? "available" : "unavailable",
    ...reviewer(attempt), duration_ms: terminal && attempt.startedAt !== null ? Math.max(0, now - attempt.startedAt) : null,
    queue_ms: attempt.state === "running" && previous?.state === "queued" ? Math.max(0, now - attempt.createdAt) : null, time_quality: "wall_clock",
  }, now, { ...refs, ...(typeof output.reusedPassAttemptId === "string" ? { reuse_attempt_id: output.reusedPassAttemptId } : {}) });
  const verdict = PersonaVerdictSchema.safeParse(attempt.verdict);
  if (attempt.persona && terminal && disposition === "executed" && verdict.success) {
    emit(scope, WORKFLOW_REVIEW_EVENT, `review:${id}`, ctx, { ...reviewer(attempt), verdict: verdict.data.verdict }, now, refs);
    if (verdict.data.verdict === "fail") verdict.data.requestedChanges.forEach((finding, index) => {
      const category = workflowFindingReason(finding.category);
      emit(scope, WORKFLOW_FINDING_EVENT, `finding:${id}:${index}`, ctx, { category, category_version: 1,
        category_source: category === "unknown" ? "unknown" : "structured", basis: finding.basis ?? "unknown",
        reviewer_model: workflowModel(attempt.model) }, now, refs);
    });
  }
  writeSourceState(scope.namespace, key, { state: attempt.state, verdict: !!attempt.verdict }, now);
  if (stage && stageId) {
    const stageKey = `stage:${submission.id}:${stageId}`;
    const prior = readSourceState<{ start: number; settled: boolean }>(scope.namespace, stageKey, now);
    if (!prior) {
      emit(scope, WORKFLOW_STAGE_EVENT, `${stageKey}:activated`, ctx, { observation: "activated", duration_ms: null,
        time_quality: "wall_clock", stage_kind: stage.kind }, now, { stage_id: stageId });
      writeSourceState(scope.namespace, stageKey, { start: now, settled: false }, now);
    }
    const barrierId = stage.kind === "evaluation" && stage.joinId ? stage.joinId : stageMembers(stage)[0]?.nodeId;
    if (terminal && attempt.nodeId === barrierId && !prior?.settled) {
      emit(scope, WORKFLOW_STAGE_EVENT, `${stageKey}:settled`, ctx, { observation: "settled", duration_ms: prior ? Math.max(0, now - prior.start) : null,
        time_quality: "wall_clock", stage_kind: stage.kind }, now, { stage_id: stageId });
      writeSourceState(scope.namespace, stageKey, { start: prior?.start ?? now, settled: true }, now);
    }
  }
}
export function observeWorkflowCall(scope: WorkflowObservationScope, store: WorkflowMutationView, call: WorkflowLlmCall, now: number): void {
  if (call.purpose !== "persona_review") return;
  const run = store.getRun(call.runId);
  if (!run) return;
  const attempt = call.nodeAttemptId ? store.getAttempt(call.nodeAttemptId) : null;
  const rejection = attempt?.reviewRejections?.find((r) => r.execution === call.attempt);
  const validity = call.state === "running" ? "pending" : call.state === "succeeded" ? "valid"
    : rejection && rejection.basis !== "parse" ? "contract_violation" : call.errorCode === "persona_parse" ? "parse_failure" : "unavailable";
  emit(scope, WORKFLOW_RESPONSE_EVENT, `call:${call.id}:${call.state === "running" ? "started" : "finished"}`,
    context(scope, store, run, store.getSubmission(call.submissionId), now), {
      observation: call.state === "running" ? "started" : "finished", validity, duration_ms: call.durationMs,
      reviewer_model: workflowModel(call.model), reviewer_runner: call.runner, reviewer_effort: "unknown",
    }, now, { call_id: call.id, ...(call.nodeAttemptId ? { attempt_id: call.nodeAttemptId } : {}) });
}
export function observeWorkflowDelivery(scope: WorkflowObservationScope, store: WorkflowMutationView, id: string, now: number): void {
  const delivery = store.getDelivery(id);
  const run = delivery && store.getRun(delivery.runId);
  if (!delivery || !run) return;
  const ctx = context(scope, store, run, store.getSubmission(delivery.submissionId), now);
  const causes = delivery.kind === "persona_feedback" ? store.listAttempts(delivery.submissionId).filter((a) =>
    a.state === "completed" && record(a.verdict).verdict === "fail") : [];
  const key = `delivery:${id}`;
  const prior = readSourceState<{ state: string; revision: number; generation: string }>(scope.namespace, key, now);
  if (prior?.state === delivery.state) return;
  const revision = (prior?.revision ?? 0) + 1;
  const generation = prior?.generation ?? randomUUID();
  // Confirmed delivery has a permanent packet identity even if a repeated owner callback arrives.
  emit(scope, WORKFLOW_DELIVERY_EVENT, delivery.state === "delivered" ? `${key}:delivered` : `${key}:${generation}:${revision}`,
    ctx, { kind: delivery.kind, state: delivery.state, cause_count: causes.length }, now, { delivery_id: id });
  for (const cause of causes) emit(scope, WORKFLOW_CAUSE_EVENT, `cause:${id}:${cause.id}`, ctx, {}, now,
    { delivery_id: id, cause_attempt_id: cause.id });
  writeSourceState(scope.namespace, key, { state: delivery.state, revision, generation }, now);
}
const source = { id: SOURCE, maxScanPerTick: 0,
  recovers: ["Committed journal facts and source checkpoints replay with original context and time"],
  unrecoverable: ["Pre-consent history, failed pre-acceptance capture, unobserved repair pickup and reviewer effort"] };
const actionSource = { id: "mission.workflow.action", maxScanPerTick: 0, recovers: [],
  unrecoverable: ["HTTP result lost before capture; unattributed callers remain unknown"] };
export function registerWorkflowTelemetrySource(): void {
  registerTelemetrySource(source);
  registerTelemetrySource(actionSource);
  registerWorkflowMutationObserver(workflowObserver);
}

/** One adapter owns the mapping from store mutations to telemetry observations. */
function observeMutation(scope: WorkflowObservationScope, store: WorkflowMutationView, mutation: WorkflowMutation): void {
  const { now } = mutation;
  switch (mutation.kind) {
    case "definition": case "version": case "binding":
      observeWorkflowAsset(scope, store, mutation.kind, mutation.id, now);
      return;
    case "run": observeWorkflowRun(scope, store, mutation.id, now); return;
    case "submission": observeWorkflowSubmission(scope, store, mutation.id, now); return;
    case "attempt": observeWorkflowAttempt(scope, store, mutation.id, now); return;
    case "delivery": observeWorkflowDelivery(scope, store, mutation.id, now); return;
    case "call": {
      const call = store.getLlmCall(mutation.id);
      if (call) observeWorkflowCall(scope, store, call, now);
      return;
    }
    case "run_cancelled":
      for (const attempt of store.listAttemptsForRun(mutation.runId)) observeWorkflowAttempt(scope, store, attempt.id, now);
      for (const delivery of store.listDeliveries(mutation.runId)) observeWorkflowDelivery(scope, store, delivery.id, now);
      // Cancellation settles provider calls in the same transaction as their attempts.
      for (const call of store.listLlmCallsFinishedAt(mutation.runId, now)) observeWorkflowCall(scope, store, call, now);
      return;
    case "calls_settled":
      for (const call of store.listLlmCallsFinishedAt(mutation.runId, now)) observeWorkflowCall(scope, store, call, now);
      return;
    case "event": {
      observeWorkflowRun(scope, store, mutation.event.runId, now);
      const payload = record(mutation.event.payload);
      if (typeof payload.deliveryId === "string") observeWorkflowDelivery(scope, store, payload.deliveryId, now);
      return;
    }
    default: {
      const exhaustive: never = mutation;
      return exhaustive;
    }
  }
}

const workflowObserver: WorkflowMutationObserver = {
  observe(db, store, mutation) {
    if (db !== openDb() || !getTelemetryConfig().enabled) return;
    forWorkflowProfiles((scope) => observeMutation(scope, store, mutation));
  },
  failed() {
    resetUsedBytesCache();
    telemetryTransaction((db) => recordGap(db, "capture_refused", "workflow observation unavailable", Date.now()));
  },
};
