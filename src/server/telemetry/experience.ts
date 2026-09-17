/** Phase 5 source facade. Every observation is bounded, consented and failure-isolated. */
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { z } from "zod";
import type { TelemetryActor } from "@shared/telemetry.ts";
import type { TelemetryOperationContext } from "@shared/telemetry-ingress.ts";
import { ACTION_RESULT_EVENT } from "@shared/telemetry-sources/actions.ts";
import { AUTOMATION_EVENT, ERROR_EVENT, type ERROR_SCHEMA, type AUTOMATION_SCHEMA } from "@shared/telemetry-sources/experience.ts";
import type { PrimaryAction, PrimaryFeature } from "@shared/telemetry-sources/primary-actions.ts";
import { captureTelemetry } from "./capture.ts";
import { capturingProfiles, getTelemetryConfig } from "./config.ts";
import { findSourceIdentity, getDestination, telemetryTransaction } from "./store.ts";
import { readSourceState, writeSourceState } from "./source-state.ts";
import { digest } from "./identity.ts";
import { openDb } from "../db.ts";
import { setLlmFailureObserver } from "../llm/observations.ts";
import { registerTelemetrySource } from "./registration.ts";
import { markUnknownGapPending } from "./retention.ts";

export interface OperationObservation { context: TelemetryOperationContext; operationId: string; startedAt: number; primaryAction?: PrimaryAction; errorId?: string; ownerActions?: Set<PrimaryAction> }
export const operationObservation = new AsyncLocalStorage<OperationObservation>();
const unknownActor: TelemetryActor = { kind: "unknown", origin: "unknown", basis: "unknown" };
export function observeExperience(observe: (profile: "local" | "user" | "product", namespace: string) => void): void {
  try {
    const config = getTelemetryConfig();
    if (!config.enabled) return;
    telemetryTransaction((db) => {
      for (const profile of capturingProfiles(config)) observe(profile, `mission.experience:${profile}:${getDestination(db, profile).policyEpoch}`);
    });
  } catch { markUnknownGapPending(); }
}
export type ActionOutcome = "applied" | "refused" | "failed" | "pending" | "cancelled";
const outcomeRevision = { pending: 1, refused: 2, failed: 3, cancelled: 4, applied: 5 } as const;
export function recordPrimaryAction(input: OperationObservation & {
  action: PrimaryAction; feature: PrimaryFeature; outcome: ActionOutcome; sourceId?: string; profile?: "local" | "user" | "product"; now?: number;
}): void {
  const now = input.now ?? Date.now();
  observeExperience((profile) => {
    if (input.profile && input.profile !== profile) return;
    const db = openDb();
    const source = { kind: "mission.primary.action", id: `${profile}:${input.action}:${input.sourceId ?? input.operationId}` };
    // A successful completion is final. Provisional/failed attempts can be followed by a
    // successful retry, but neither transport replay nor that update counts another action.
    if (findSourceIdentity(db, { ...source, revision: 5 })) return;
    const existing = Object.values(outcomeRevision).some((revision) => findSourceIdentity(db, { ...source, revision }));
    const captured = captureTelemetry({ event: ACTION_RESULT_EVENT, profiles: [profile],
      source: { ...source, revision: outcomeRevision[input.outcome] }, actor: input.context.actor,
      refs: { operation_id: input.operationId }, trace: { traceId: digest(["operation", input.operationId]), parentSpanId: null },
      facts: { feature: input.feature, action: input.action, outcome: input.outcome,
        observation: existing ? "outcome_update" : "initial", duration_ms: Math.max(0, now - input.startedAt),
        surface: input.context.surface, coverage: "owner_result", intent: "unknown", cause: "unknown" }, now });
    if (captured.kind === "refused") throw new Error("action capture refused");
  });
}
const occurrences = new WeakMap<object, string>();
export function errorOccurrence(error?: unknown): string {
  if (error && typeof error === "object") {
    const prior = occurrences.get(error);
    if (prior) return prior;
    const id = randomUUID().replaceAll("-", "");
    occurrences.set(error, id);
    return id;
  }
  return randomUUID().replaceAll("-", "");
}
export function recordSafeError(facts: z.input<typeof ERROR_SCHEMA>, error?: unknown, operation = operationObservation.getStore()): string {
  const id = errorOccurrence(error);
  if (operation) operation.errorId ??= id;
  observeExperience((profile, namespace) => {
    const now = Date.now();
    const key = `error-loop:${facts.component}:${facts.code}:${facts.fingerprint}`;
    const previous = readSourceState<{ at: number; suppressed: number }>(namespace, key, now);
    if (facts.fingerprint !== "unknown" && previous && now - previous.at < 60_000) {
      // The shared occurrence remains deduped even when caught again at another layer.
      if (findSourceIdentity(openDb(), { kind: "mission.error", id: `${profile}:${id}`, revision: 1 })) return;
      writeSourceState(namespace, key, { ...previous, suppressed: Math.min(1000000, previous.suppressed + 1) }, now);
      return;
    }
    if (previous?.suppressed) captureTelemetry({ event: ERROR_EVENT, profiles: [profile],
      source: { kind: "mission.error.suppression", id: `${profile}:${id}`, revision: 1 },
      facts: { ...facts, suppressed: previous.suppressed }, actor: operation?.context.actor ?? unknownActor,
      refs: operation ? { operation_id: operation.operationId } : {}, now });
    const result = captureTelemetry({ event: ERROR_EVENT, profiles: [profile], source: { kind: "mission.error", id: `${profile}:${id}`, revision: 1 },
      facts: { ...facts, suppressed: 0 }, actor: operation?.context.actor ?? unknownActor,
      refs: { occurrence_id: id, ...(operation ? { operation_id: operation.operationId } : {}) },
      ...(operation ? { trace: { traceId: digest(["operation", operation.operationId]), parentSpanId: null } } : {}), now });
    if (result.kind === "refused") throw new Error("error capture refused");
    writeSourceState(namespace, key, { at: now, suppressed: 0 }, now);
  });
  return operation?.errorId ?? id;
}
/** One normalized outcome per existing business identity, including restart and replay. */
export function recordAutomationTransition(id: string, facts: z.input<typeof AUTOMATION_SCHEMA>, actor: TelemetryActor, now = Date.now()): void {
  // Composite business keys can contain repository paths or names. Minimize before local
  // capture as well as the audience-specific reference salting performed at export.
  const subject = digest(["automation", facts.feature, facts.action, id]);
  observeExperience((profile) => {
    const result = captureTelemetry({ event: AUTOMATION_EVENT, profiles: [profile],
      source: { kind: "mission.automation", id: `${profile}:${facts.feature}:${facts.action}:${subject}:${facts.outcome}`, revision: 1 }, facts, actor,
      refs: { subject_id: subject, ...(operationObservation.getStore() ? { operation_id: operationObservation.getStore()!.operationId } : {}) }, now });
    if (result.kind === "refused") throw new Error("automation capture refused");
  });
}

const experienceSource = { id: "mission.experience", maxScanPerTick: 0,
    recovers: ["accepted action, owner transition and error facts replay through the durable journal"],
    unrecoverable: ["browser records lost before admission", "owner writes lost before post-commit observation", "external pipeline actions and process-death causes without positive evidence"] };
export function registerExperienceTelemetrySource(): void {
  registerTelemetrySource(experienceSource);
  setLlmFailureObserver((error) => {
    if (error instanceof Error && error.name === "AbortError") return;
    const code = error instanceof Error && error.name === "TimeoutError" ? "timeout" : "unavailable";
    recordSafeError({ component: "provider", family: "provider", code,
      retryable: "unknown", handled: true, fingerprint: "unknown", suppressed: 0 }, error);
  });
}

/** Used by creators that also run without HTTP (sources, schedules and ensemble members). */
export function observeTaskCreated(id: string, scheduled: boolean): void {
  const active = operationObservation.getStore();
  const operation = active ?? { context: { operationId: null, surface: "unknown" as const,
    actor: scheduled ? { kind: "scheduler" as const, origin: "daemon" as const, basis: "owner" as const } : unknownActor },
    operationId: id, startedAt: Date.now() };
  // One request can create several ensemble members or scheduled tasks. Their existing
  // durable task ids, rather than the enclosing request, identify these creations.
  recordPrimaryAction({ ...operation, action: "task.create", feature: "tasks", sourceId: active?.primaryAction === "task.create" ? `:${active.operationId}` : id, outcome: "applied",
    ...(scheduled ? { context: { ...operation.context, actor: { kind: "scheduler", origin: "daemon", basis: "owner" } } as const } : {}) });
  if (active) { active.ownerActions ??= new Set(); active.ownerActions.add("task.create"); }
}

type PendingAction = Pick<Parameters<typeof recordPrimaryAction>[0], "action" | "feature" | "context" | "operationId" | "startedAt" | "sourceId">;
/** Attribution only: the turn owner remains the sole delivery observer from Phase 3. */
export function retainTurnOperation(turnId: string, actor: TelemetryActor): void {
  const current = operationObservation.getStore();
  if (current) observeExperience((_profile, namespace) => writeSourceState(namespace, `turn:${turnId}`,
    { actor, operationId: current.operationId }, Date.now()));
}
export function retainedTurnOperation(turnId: string): { actor: TelemetryActor; operationId: string } | null {
  try {
    if (!getTelemetryConfig().enabled) return null;
    return readSourceState(`mission.experience:local:${getDestination(openDb(), "local").policyEpoch}`, `turn:${turnId}`, Date.now());
  } catch { return null; }
}
export function retainPendingAction(subject: string, action: PendingAction): void {
  observeExperience((_profile, namespace) => writeSourceState(namespace, `pending:${subject}`, action, Date.now()));
}
export function settlePendingAction(subject: string, outcome: ActionOutcome): void {
  if (outcome === "pending") return;
  observeExperience((profile, namespace) => {
    const action = readSourceState<PendingAction>(namespace, `pending:${subject}`, Date.now());
    if (action) recordPrimaryAction({ ...action, profile, outcome });
  });
}
