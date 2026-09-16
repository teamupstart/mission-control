import { z } from "zod";
import { AUDIENCE_ALL } from "../telemetry.ts";
import { TELEMETRY_OPERATION_SURFACES } from "../telemetry-ingress.ts";
import { WORKFLOW_ACTION_ROUTES } from "../workflow-actions.ts";
import type { TelemetryEventDefinition, TelemetryMetricDefinition } from "../telemetry-catalog.ts";

export const ACTION_INTENTS = ["required_decision", "recovery", "optional_steering", "termination", "unknown"] as const;
export const ACTION_CAUSES = ["human_gate", "agent_wait", "external_wait", "blocked", "none", "unknown"] as const;
/** Frozen Phase 5/6 handoff: operation/actor live in refs/envelope; event time is occurredAt. */
export const ACTION_RESULT_SCHEMA = z.object({
  feature: z.enum(["workflow", "persona"]),
  action: z.enum(WORKFLOW_ACTION_ROUTES.map((r) => r[2]) as [string, ...string[]]),
  outcome: z.enum(["applied", "refused", "failed"]),
  duration_ms: z.number().nonnegative(), surface: z.enum(TELEMETRY_OPERATION_SURFACES),
  coverage: z.enum(["owner_result", "unknown"]), intent: z.enum(ACTION_INTENTS), cause: z.enum(ACTION_CAUSES),
}).strict();
export const ACTION_RESULT_EVENT: TelemetryEventDefinition<typeof ACTION_RESULT_SCHEMA> = {
  name: "mission.action.result", version: 1, group: "primary_action", priority: "core",
  question: "Which logical actions succeed and which require human recovery?",
  owner: "src/server/telemetry/workflow-actions.ts", audience: AUDIENCE_ALL, facts: ACTION_RESULT_SCHEMA,
  refKeys: ["operation_id", "run_id", "binding_id", "workflow_id", "persona_id", "delivery_id"], ingress: null,
  span: { name: "mission.action.result", kind: "internal", durationFactKey: "duration_ms",
    attributes: Object.keys(ACTION_RESULT_SCHEMA.shape),
    refAttributes: ["operation_id", "run_id", "binding_id", "workflow_id", "persona_id", "delivery_id"],
    errorWhen: { factKey: "outcome", values: ["failed", "refused"] } },
};
const base = { description: ACTION_RESULT_EVENT.question, unit: "1", kind: "counter", valueType: "int",
  event: ACTION_RESULT_EVENT.name, audience: AUDIENCE_ALL, boundaries: null, unknownPolicy: "explicit_unknown",
  since: 2, owner: ACTION_RESULT_EVENT.owner } as const;
export const ACTION_METRICS: TelemetryMetricDefinition[] = [
  { ...base, name: "mission.action.count", dimensions: ["feature", "action", "outcome", "actor"],
    contribution: (f, e) => ({ dimensions: { feature: String(f.feature), action: String(f.action), outcome: String(f.outcome), actor: e.actor.kind }, value: 1 }) },
  { ...base, name: "mission.workflow.interventions", dimensions: ["action", "intent", "cause"],
    contribution: (f, e) => f.outcome === "applied" && e.actor.kind === "human"
      && ["owner", "app_context"].includes(e.actor.basis) && e.refs.run_id
      ? { dimensions: { action: String(f.action), intent: String(f.intent), cause: String(f.cause) }, value: 1 } : null },
];
