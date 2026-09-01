import { randomUUID } from "node:crypto";

import {
  ENGINEER_EVENT_LIMITS,
  ENGINEER_EVENT_TYPES,
  ENGINEER_STEP_NAMES,
  MAX_PIPELINE_COMMISSION_ATTEMPTS,
  pipelineRunKeyOf,
  type EngineerEventBase,
  type EngineerLifecycleEvent,
  type PipelineCommission,
  type PipelineCommissionAttempt,
  type PipelineCommissionId,
  type PipelineProviderId,
  type PipelineStep,
  type UnsupportedEngineerLifecycleEvent,
  type UnknownEngineerLifecycleEvent,
} from "@shared/pipeline.ts";
import {
  EngineerLifecycleEventSchema,
  UnsupportedEngineerLifecycleEventSchema,
  UnknownEngineerLifecycleEventSchema,
} from "@shared/protocol.ts";

import {
  commitPipelineCommissionEvent,
  createPipelineCommissionRow,
  getPipelineCommission,
  loadPipelineCommissions,
  pipelineCommissionForEngineerRun,
  upsertPipelineCommissionAttempt,
  type PipelineCommissionEventCommit,
} from "../db.ts";

const TERMINAL_ATTEMPT_STATES = new Set(["cancelled", "failed", "settled"]);
// A failed Engineer attempt is retryable under the same commission. Task cancellation or
// later shipment settlement is terminal for the commission itself.
const TERMINAL_COMMISSION_LIFECYCLES = new Set(["cancelled", "settled"]);
const KNOWN_ENGINEER_EVENTS = new Set<string>(ENGINEER_EVENT_TYPES);

/** A reserved, provider-unbound commission. Phase 3 calls this before it starts any host. */
export function createPipelineCommission(input: {
  taskId: string;
  provider: PipelineProviderId;
  repoRoot: string;
  id?: PipelineCommissionId;
  correlationId?: string;
  launchKey?: string;
  now?: number;
}): PipelineCommission {
  const now = input.now ?? Date.now();
  const id = input.id ?? randomUUID();
  const attempt: PipelineCommissionAttempt = {
    attempt: 1,
    launchKey: input.launchKey ?? randomUUID(),
    engineerRunId: null,
    previousEngineerRunId: null,
    providerRevision: 0,
    state: "reserved",
    terminalReason: null,
    updatedAt: now,
  };
  const commission: PipelineCommission = {
    id,
    taskId: input.taskId,
    provider: input.provider,
    repoRoot: input.repoRoot,
    correlationId: input.correlationId ?? id,
    lifecycle: "created",
    attempts: [attempt],
    activeAttempt: 1,
    steps: ENGINEER_STEP_NAMES.map((name) => ({ name, state: "pending" })),
    currentStep: null,
    tier: null,
    track: null,
    project: null,
    authoringWorktree: null,
    handoff: null,
    linkedRun: null,
    blocker: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  createPipelineCommissionRow(commission, attempt);
  return commission;
}

/**
 * Bind a provider run without consuming its revision-one event. Reconciliation then replays
 * from zero, so an uncertain create response and a missed live run-created push converge.
 */
export function bindPipelineCommissionAttempt(input: {
  commissionId: PipelineCommissionId;
  attempt: number;
  engineerRunId: string;
  providerAttempt: number;
  attemptKey: string;
  previousEngineerRunId: string | null;
  now?: number;
}): PipelineCommission {
  const held = getPipelineCommission(input.commissionId);
  if (!held) throw new Error(`unknown pipeline commission ${input.commissionId}`);
  if (held.activeAttempt !== input.attempt) throw new Error("only the active attempt may be bound");
  if (input.providerAttempt !== input.attempt) {
    throw new Error("provider Engineer attempt does not match the reserved commission attempt");
  }
  const at = held.attempts.find((attempt) => attempt.attempt === input.attempt);
  if (!at) throw new Error("reserved commission attempt is missing");
  if (at.launchKey !== input.attemptKey) throw new Error("provider launch key does not match");
  const predecessor = held.attempts.find(
    (attempt) => attempt.attempt === input.attempt - 1,
  );
  const expectedPreviousRunId = predecessor?.engineerRunId ?? null;
  if (input.previousEngineerRunId !== expectedPreviousRunId) {
    throw new Error("provider predecessor does not match the commission attempt lineage");
  }
  if (at.engineerRunId && at.engineerRunId !== input.engineerRunId) {
    throw new Error("commission attempt is already bound to another Engineer run");
  }
  const now = input.now ?? Date.now();
  const bound: PipelineCommissionAttempt = {
    ...at,
    engineerRunId: input.engineerRunId,
    previousEngineerRunId: input.previousEngineerRunId,
    updatedAt: now,
  };
  const next: PipelineCommission = {
    ...held,
    attempts: held.attempts.map((attempt) =>
      attempt.attempt === bound.attempt ? bound : attempt,
    ),
    updatedAt: now,
  };
  upsertPipelineCommissionAttempt(next, bound);
  return next;
}

/** Append a successor attempt only after the current provider attempt is terminal. */
export function appendPipelineCommissionAttempt(input: {
  commissionId: PipelineCommissionId;
  launchKey?: string;
  now?: number;
}): PipelineCommission {
  const held = getPipelineCommission(input.commissionId);
  if (!held) throw new Error(`unknown pipeline commission ${input.commissionId}`);
  if (TERMINAL_COMMISSION_LIFECYCLES.has(held.lifecycle)) {
    throw new Error("a terminal pipeline commission cannot be retried");
  }
  const current = held.attempts.find((attempt) => attempt.attempt === held.activeAttempt);
  if (current?.state === "settled") {
    throw new Error("a settled pipeline commission cannot be retried");
  }
  if (!current || !TERMINAL_ATTEMPT_STATES.has(current.state)) {
    throw new Error("the active Engineer attempt is not terminal");
  }
  const now = input.now ?? Date.now();
  const attempt: PipelineCommissionAttempt = {
    attempt: current.attempt + 1,
    launchKey: input.launchKey ?? randomUUID(),
    engineerRunId: null,
    previousEngineerRunId: current.engineerRunId,
    providerRevision: 0,
    state: "reserved",
    terminalReason: null,
    updatedAt: now,
  };
  const next: PipelineCommission = {
    ...held,
    lifecycle: "created",
    attempts: [...held.attempts, attempt].slice(-MAX_PIPELINE_COMMISSION_ATTEMPTS),
    activeAttempt: attempt.attempt,
    steps: ENGINEER_STEP_NAMES.map((name) => ({ name, state: "pending" })),
    currentStep: null,
    project: null,
    authoringWorktree: null,
    handoff: null,
    linkedRun: null,
    blocker: null,
    error: null,
    updatedAt: now,
  };
  upsertPipelineCommissionAttempt(next, attempt);
  return next;
}

/** Make task-level cancellation terminal without reopening or rewriting provider history. */
export function cancelPipelineCommission(input: {
  commissionId: PipelineCommissionId;
  reason: string;
  now?: number;
}): PipelineCommission {
  const held = getPipelineCommission(input.commissionId);
  if (!held) throw new Error(`unknown pipeline commission ${input.commissionId}`);
  if (held.lifecycle === "cancelled") return held;
  if (held.lifecycle === "settled") {
    throw new Error("a settled pipeline commission cannot be cancelled");
  }
  const now = input.now ?? Date.now();
  const active = held.attempts.find((attempt) => attempt.attempt === held.activeAttempt);
  if (!active) throw new Error("the Pipeline commission has no active Engineer attempt");
  const attempt: PipelineCommissionAttempt = TERMINAL_ATTEMPT_STATES.has(active.state)
    ? active
    : {
        ...active,
        state: "cancelled",
        terminalReason: input.reason,
        updatedAt: now,
      };
  const next: PipelineCommission = {
    ...held,
    lifecycle: "cancelled",
    attempts: held.attempts.map((entry) =>
      entry.attempt === attempt.attempt ? attempt : entry,
    ),
    currentStep: null,
    blocker: null,
    error: input.reason,
    updatedAt: now,
  };
  upsertPipelineCommissionAttempt(next, attempt);
  return next;
}

/**
 * Retain the provider identity and reason when cancellation could not stop it.
 *
 * A dispatch-time host failure records this while the commission is still active so the
 * task continues to own the provider run and Cancel can retry it. A task cancellation that
 * already won locally keeps its terminal attempt reason instead.
 */
export function recordPipelineCommissionCancellationFailure(input: {
  commissionId: PipelineCommissionId;
  engineerRunId: string;
  reason: string;
  now?: number;
}): PipelineCommission {
  const held = getPipelineCommission(input.commissionId);
  if (!held) throw new Error(`unknown pipeline commission ${input.commissionId}`);
  if (held.lifecycle !== "created" && held.lifecycle !== "cancelled") {
    throw new Error("only an active reservation or cancelled commission can retain a cancellation failure");
  }
  const active = held.attempts.find((attempt) => attempt.attempt === held.activeAttempt);
  if (!active || active.engineerRunId !== input.engineerRunId) {
    throw new Error("the cancellation failure does not match the active Engineer run");
  }
  const now = input.now ?? Date.now();
  const attempt: PipelineCommissionAttempt = held.lifecycle === "cancelled"
    ? { ...active, terminalReason: input.reason, updatedAt: now }
    : { ...active, updatedAt: now };
  const next: PipelineCommission = {
    ...held,
    attempts: held.attempts.map((entry) =>
      entry.attempt === attempt.attempt ? attempt : entry,
    ),
    error: input.reason,
    updatedAt: now,
  };
  upsertPipelineCommissionAttempt(next, attempt);
  return next;
}

export type ParsedEngineerEvent =
  | { ok: true; known: true; event: EngineerLifecycleEvent }
  | { ok: true; known: false; event: UnknownEngineerLifecycleEvent }
  | { ok: false; code: "malformed" | "oversized"; error: string };

export type ParsedUnsupportedEngineerEvent =
  | { ok: true; event: UnsupportedEngineerLifecycleEvent }
  | { ok: false; code: "malformed" | "oversized"; error: string };

function engineerEventByteLength(value: unknown): number | null {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? null : Buffer.byteLength(encoded, "utf8");
  } catch {
    return null;
  }
}

function engineerEventIsOversized(value: unknown): boolean {
  const bytes = engineerEventByteLength(value);
  return bytes !== null && bytes > ENGINEER_EVENT_LIMITS.maxBytes;
}

/** Validate the exact known payload, while retaining a structurally valid future kind. */
export function parseEngineerEvent(value: unknown): ParsedEngineerEvent {
  if (engineerEventIsOversized(value)) {
    return {
      ok: false,
      code: "oversized",
      error: `Engineer event exceeds ${ENGINEER_EVENT_LIMITS.maxBytes} bytes`,
    };
  }
  const base = UnknownEngineerLifecycleEventSchema.safeParse(value);
  if (!base.success) {
    return { ok: false, code: "malformed", error: "invalid Engineer event identity" };
  }
  if (!KNOWN_ENGINEER_EVENTS.has(base.data.type)) {
    return { ok: true, known: false, event: base.data as UnknownEngineerLifecycleEvent };
  }
  const known = EngineerLifecycleEventSchema.safeParse(value);
  if (!known.success) {
    return { ok: false, code: "malformed", error: "malformed known Engineer event" };
  }
  return { ok: true, known: true, event: known.data as EngineerLifecycleEvent };
}

/** Validate the bounded identity needed to retain a future schema as opaque evidence. */
export function parseUnsupportedEngineerEvent(value: unknown): ParsedUnsupportedEngineerEvent {
  if (engineerEventIsOversized(value)) {
    return {
      ok: false,
      code: "oversized",
      error: `Engineer event exceeds ${ENGINEER_EVENT_LIMITS.maxBytes} bytes`,
    };
  }
  const parsed = UnsupportedEngineerLifecycleEventSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, code: "malformed", error: "invalid unsupported Engineer event" };
  }
  return { ok: true, event: parsed.data as UnsupportedEngineerLifecycleEvent };
}

function setStep(steps: readonly PipelineStep[], name: string, state: PipelineStep["state"]): PipelineStep[] {
  let found = false;
  const next = steps.map((step) => {
    if (step.name !== name) return step;
    found = true;
    return { name, state };
  });
  return found ? next : [...next, { name, state }];
}

function reduceKnownEvent(
  commission: PipelineCommission,
  attempt: PipelineCommissionAttempt,
  event: EngineerLifecycleEvent,
): { commission: PipelineCommission; attempt: PipelineCommissionAttempt } {
  let next: PipelineCommission = {
    ...commission,
    blocker: null,
    error: null,
    updatedAt: Date.parse(event.ts),
  };
  let nextAttempt: PipelineCommissionAttempt = {
    ...attempt,
    providerRevision: event.revision,
    updatedAt: Date.parse(event.ts),
  };
  switch (event.type) {
    case "engineer_run_created":
      nextAttempt = { ...nextAttempt, state: "created" };
      break;
    case "engineer_run_started":
      next = { ...next, lifecycle: "authoring" };
      nextAttempt = { ...nextAttempt, state: "authoring" };
      break;
    case "engineer_routing_selected":
      next = { ...next, project: event.project };
      break;
    case "engineer_worktree_created":
      next = { ...next, authoringWorktree: event.worktreePath };
      break;
    case "engineer_step_started":
      next = {
        ...next,
        lifecycle: "authoring",
        currentStep: event.step,
        steps: setStep(next.steps, event.step, "in_progress"),
      };
      nextAttempt = { ...nextAttempt, state: "authoring" };
      break;
    case "engineer_step_completed":
      next = {
        ...next,
        currentStep: next.currentStep === event.step ? null : next.currentStep,
        steps: setStep(next.steps, event.step, "done"),
      };
      break;
    case "engineer_step_failed":
      next = {
        ...next,
        currentStep: event.step,
        steps: setStep(next.steps, event.step, "failed"),
        blocker: { kind: "step_failed", step: event.step, reason: event.error },
        error: event.error,
      };
      break;
    case "engineer_step_retried":
      next = {
        ...next,
        currentStep: event.step,
        steps: setStep(next.steps, event.step, "in_progress"),
        error: event.reason,
      };
      break;
    case "engineer_step_skipped":
      next = {
        ...next,
        currentStep: next.currentStep === event.step ? null : next.currentStep,
        steps: setStep(next.steps, event.step, "skipped"),
      };
      break;
    case "engineer_land_reconciled": {
      let steps = next.steps;
      for (const completed of event.completed) steps = setStep(steps, completed, "done");
      for (const skipped of event.skipped) steps = setStep(steps, skipped, "skipped");
      next = { ...next, tier: event.tier, track: event.track, steps, currentStep: null };
      break;
    }
    case "engineer_land_refused":
      next = {
        ...next,
        blocker: { kind: "land_refused", reason: event.reason },
        error: event.reason,
      };
      break;
    case "engineer_spec_handoff":
      next = {
        ...next,
        lifecycle: "awaiting_spec_merge",
        handoff: {
          planSlug: event.planSlug,
          branch: event.branch,
          prUrl: event.prUrl,
          outcome: event.outcome,
        },
        linkedRun: {
          provider: next.provider,
          repoRoot: next.repoRoot,
          slug: event.planSlug,
        },
        currentStep: null,
      };
      nextAttempt = { ...nextAttempt, state: "awaiting_spec_merge" };
      break;
    case "engineer_run_cancelled":
      next = { ...next, lifecycle: "cancelled", currentStep: null, error: event.reason };
      nextAttempt = { ...nextAttempt, state: "cancelled", terminalReason: event.reason };
      break;
    case "engineer_run_failed":
      next = { ...next, lifecycle: "failed", currentStep: null, error: event.error };
      nextAttempt = { ...nextAttempt, state: "failed", terminalReason: event.error };
      break;
    case "engineer_run_settled":
      next = { ...next, lifecycle: "awaiting_spec_merge", currentStep: null };
      nextAttempt = { ...nextAttempt, state: "settled" };
      break;
  }
  next = {
    ...next,
    attempts: next.attempts.map((entry) =>
      entry.attempt === nextAttempt.attempt ? nextAttempt : entry,
    ),
  };
  return { commission: next, attempt: nextAttempt };
}

export type EngineerEventApplyResult = {
  outcome: PipelineCommissionEventCommit | "malformed" | "oversized" | "unknown_commission" | "mismatch" | "terminal" | "collision";
  commission: PipelineCommission | null;
};

/** Shared live-push and replay reducer. Nothing else is allowed to project Engineer events. */
export function applyEngineerEvent(
  value: unknown,
  observedAt = Date.now(),
): EngineerEventApplyResult {
  const parsed = parseEngineerEvent(value);
  if (!parsed.ok) return { outcome: parsed.code, commission: null };
  const event = parsed.event;
  const held = pipelineCommissionForEngineerRun(event.engineerRunId);
  if (!held) return { outcome: "unknown_commission", commission: null };
  if (
    held.provider !== "ai-conductor" ||
    held.repoRoot !== event.repoRoot ||
    held.correlationId !== event.correlationId ||
    held.activeAttempt !== event.attempt
  ) {
    return { outcome: "mismatch", commission: null };
  }
  const attempt = held.attempts.find((entry) => entry.attempt === event.attempt);
  if (
    !attempt ||
    attempt.engineerRunId !== event.engineerRunId ||
    attempt.launchKey !== event.attemptKey ||
    attempt.previousEngineerRunId !== event.previousEngineerRunId
  ) {
    return { outcome: "mismatch", commission: null };
  }
  if (
    (TERMINAL_ATTEMPT_STATES.has(attempt.state) ||
      TERMINAL_COMMISSION_LIFECYCLES.has(held.lifecycle)) &&
    event.revision > attempt.providerRevision
  ) {
    return { outcome: "terminal", commission: null };
  }
  if (parsed.known && parsed.event.type === "engineer_spec_handoff") {
    const handoff = parsed.event;
    const key = pipelineRunKeyOf({ provider: held.provider, repoRoot: held.repoRoot, slug: handoff.planSlug });
    const collision = loadPipelineCommissions().some(
      (commission) => commission.id !== held.id && commission.linkedRun && pipelineRunKeyOf(commission.linkedRun) === key,
    );
    if (collision) return { outcome: "collision", commission: null };
  }
  const reduced = parsed.known
    ? reduceKnownEvent(held, attempt, parsed.event)
    : {
        commission: held,
        attempt: {
          ...attempt,
          providerRevision: event.revision,
          updatedAt: Date.parse(event.ts),
        },
      };
  if (!parsed.known) {
    reduced.commission = {
      ...held,
      attempts: held.attempts.map((entry) =>
        entry.attempt === reduced.attempt.attempt ? reduced.attempt : entry,
      ),
      updatedAt: Date.parse(event.ts),
    };
  }
  const outcome = commitPipelineCommissionEvent({
    previousRevision: attempt.providerRevision,
    attempt: reduced.attempt,
    commission: reduced.commission,
    kind: event.type,
    body: event as Record<string, unknown>,
    observedAt,
  });
  return {
    outcome,
    commission: outcome === "stored" ? reduced.commission : held,
  };
}

/** Preserve a future schema as opaque evidence and make the incompatibility explicit. */
export function applyUnsupportedEngineerEvent(
  value: unknown,
  observedAt = Date.now(),
): EngineerEventApplyResult {
  const parsed = parseUnsupportedEngineerEvent(value);
  if (!parsed.ok) return { outcome: parsed.code, commission: null };
  const event = parsed.event;
  const held = pipelineCommissionForEngineerRun(event.engineerRunId);
  if (!held) return { outcome: "unknown_commission", commission: null };
  const attemptNumber = Number(event.attempt);
  const revision = Number(event.revision);
  const attempt = held.attempts.find((entry) => entry.attempt === attemptNumber);
  if (
    !attempt ||
    held.provider !== "ai-conductor" ||
    held.repoRoot !== event.repoRoot ||
    held.correlationId !== event.correlationId ||
    held.activeAttempt !== attemptNumber ||
    attempt.engineerRunId !== event.engineerRunId ||
    attempt.launchKey !== event.attemptKey ||
    attempt.previousEngineerRunId !== event.previousEngineerRunId
  ) {
    return { outcome: "mismatch", commission: null };
  }
  if (
    (TERMINAL_ATTEMPT_STATES.has(attempt.state) ||
      TERMINAL_COMMISSION_LIFECYCLES.has(held.lifecycle)) &&
    revision > attempt.providerRevision
  ) {
    return { outcome: "terminal", commission: null };
  }
  const updatedAt = Date.parse(event.ts);
  const nextAttempt: PipelineCommissionAttempt = {
    ...attempt,
    providerRevision: revision,
    updatedAt,
  };
  const next: PipelineCommission = {
    ...held,
    lifecycle: "unsupported",
    attempts: held.attempts.map((entry) =>
      entry.attempt === nextAttempt.attempt ? nextAttempt : entry,
    ),
    error: `unsupported Engineer schema version ${String(event.schemaVersion).slice(0, 32)}`,
    updatedAt,
  };
  const outcome = commitPipelineCommissionEvent({
    previousRevision: attempt.providerRevision,
    attempt: nextAttempt,
    commission: next,
    kind: event.type,
    body: event,
    observedAt,
  });
  return { outcome, commission: outcome === "stored" ? next : held };
}

/** Narrow identity parser for envelopes before their event body is reduced. */
export function engineerEnvelopeMatchesEvent(envelope: {
  repo: string;
  engineerRunId?: string;
  correlationId?: string | null;
  engineerAttempt?: number;
  attemptKey?: string;
}, event: Pick<EngineerEventBase, "repoRoot" | "engineerRunId" | "correlationId" | "attempt" | "attemptKey">): boolean {
  return (
    envelope.repo === event.repoRoot &&
    envelope.engineerRunId === event.engineerRunId &&
    envelope.correlationId === event.correlationId &&
    envelope.engineerAttempt === event.attempt &&
    envelope.attemptKey === event.attemptKey
  );
}
