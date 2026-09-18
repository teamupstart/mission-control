import { z } from "zod";
import { AUDIENCE_ALL, AUDIENCE_OPERATOR } from "../telemetry.ts";
import type { TelemetryEventDefinition, TelemetryMetricDefinition } from "../telemetry-catalog.ts";
import { PRIMARY_FEATURES } from "./primary-actions.ts";

export const FEATURE_IDS = [...PRIMARY_FEATURES, "diff", "search", "dispatch", "conversation", "workflow", "persona", "telemetry", "board", "reports"] as const;
export type FeatureId = typeof FEATURE_IDS[number];
export const FEATURE_SCHEMA = z.object({
  feature: z.enum(FEATURE_IDS),
  action: z.enum(["enter", "select", "filter", "no_results", "dismiss", "cancel", "complete"]),
}).strict();
export const ERROR_ID_HEADER = "x-mission-error-id";
export const ERROR_SCHEMA = z.object({
  component: z.enum(["route", "renderer", "connection", "provider", "workflow", "storage", "process"]),
  family: z.enum(["execution", "renderer", "transport", "provider", "workflow", "storage", "process"]),
  code: z.enum(["unexpected", "unavailable", "timeout", "rate_limited", "authentication", "disconnected", "rejection", "exception", "termination_unknown"]),
  retryable: z.enum(["yes", "no", "unknown"]), handled: z.boolean(),
  // Frame coordinates from the shipped application only; never function names, paths or messages.
  fingerprint: z.string().regex(/^(unknown|app:[0-9]{1,6}:[0-9]{1,6})$/),
  suppressed: z.number().int().min(0).max(1000000),
}).strict();
function event<S extends z.ZodRawShape>(name: string, group: "primary_action" | "errors" | "automation", facts: z.ZodObject<S>, browser = false): TelemetryEventDefinition<z.ZodObject<S>> {
  return { name, version: 1, group, priority: "core", question: "Which features work and where do observable failures occur?",
    owner: "src/server/telemetry/experience.ts", audience: browser ? AUDIENCE_OPERATOR : AUDIENCE_ALL, facts,
    refKeys: ["operation_id", "occurrence_id", "subject_id"], ingress: browser ? "browser" : null,
    span: browser ? null : { name, kind: "internal", durationFactKey: "duration_ms" in facts.shape ? "duration_ms" : null, attributes: Object.keys(facts.shape),
      refAttributes: ["operation_id", "occurrence_id", "subject_id"],
      errorWhen: "code" in facts.shape ? { factKey: "code", values: ERROR_SCHEMA.shape.code.options } : null } };
}
export const FEATURE_EVENT = event("mission.feature.entry", "primary_action", FEATURE_SCHEMA, true);
export const ERROR_EVENT = event("mission.error.occurrence", "errors", ERROR_SCHEMA);
// Browser errors use the same vocabulary, with a separate authority from owner errors.
export const RENDERER_ERROR_EVENT = event("mission.renderer.error", "errors", ERROR_SCHEMA.extend({
  component: z.enum(["renderer", "connection"]), family: z.enum(["renderer", "transport"]),
  code: z.enum(["exception", "rejection", "disconnected"]),
}), true);
export const CONNECTION_EVENT = event("mission.connection.recovered", "errors", z.object({ duration_ms: z.number().int().nonnegative().max(86400000) }).strict(), true);
export const AUTOMATION_SCHEMA = z.object({
  feature: z.enum(["queues", "schedules", "ensembles", "pipelines", "foreman", "inspector"]),
  action: z.enum(["occurrence", "member", "stage", "run", "queue_item", "answer", "review", "handoff"]),
  outcome: z.enum(["pending", "running", "applied", "refused", "failed", "cancelled", "waiting", "unknown"]),
  coverage: z.enum(["owner_transition", "external_observation"]),
}).strict();
export const AUTOMATION_EVENT = event("mission.automation.transition", "automation", AUTOMATION_SCHEMA);
const metric = (name: string, source: TelemetryEventDefinition, dimensions: string[], contribution: TelemetryMetricDefinition["contribution"]): TelemetryMetricDefinition => ({
  name, description: source.question, unit: "1", kind: "counter", valueType: "int", event: source.name,
  audience: source.audience, boundaries: null, unknownPolicy: "explicit_unknown", since: 2, owner: source.owner, dimensions, contribution,
});
export const EXPERIENCE_EVENTS = [FEATURE_EVENT, ERROR_EVENT, RENDERER_ERROR_EVENT, CONNECTION_EVENT, AUTOMATION_EVENT];
export const EXPERIENCE_METRICS = [
  { ...metric("mission.connection.downtime", CONNECTION_EVENT, [], (f) => ({ dimensions: {}, value: Number(f.duration_ms) })),
    unit: "ms", kind: "histogram" as const, boundaries: [100, 1000, 5000, 30000, 60000, 300000, 1800000, 86400000] },
  metric("mission.connection.recoveries", CONNECTION_EVENT, [], () => ({ dimensions: {}, value: 1 })),
  metric("mission.feature.entries", FEATURE_EVENT, ["feature", "action"], (f) => ({ dimensions: { feature: String(f.feature), action: String(f.action) }, value: 1 })),
  ...[ERROR_EVENT, RENDERER_ERROR_EVENT].map((e) => metric(e === ERROR_EVENT ? "mission.errors" : "mission.renderer.errors", e,
    ["component", "family", "code"], (f) => ({ dimensions: { component: String(f.component), family: String(f.family), code: String(f.code) }, value: f.suppressed ? 0 : 1 }))),
  ...[ERROR_EVENT, RENDERER_ERROR_EVENT].map((e) => metric(e === ERROR_EVENT ? "mission.errors.suppressed" : "mission.renderer.errors.suppressed", e,
    ["component", "code"], (f) => ({ dimensions: { component: String(f.component), code: String(f.code) }, value: Number(f.suppressed) }))),
  metric("mission.automation.actions", AUTOMATION_EVENT, ["feature", "action", "outcome", "actor"], (f, e) => ({
    dimensions: { feature: String(f.feature), action: String(f.action), outcome: String(f.outcome), actor: e.actor.kind }, value: 1 })),
];
