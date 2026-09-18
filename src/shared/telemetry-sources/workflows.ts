import { z } from "zod";
import { AUDIENCE_ALL } from "../telemetry.ts";
import type { TelemetryEnvelope } from "../telemetry.ts";
import type { TelemetryEventDefinition, TelemetryMetricDefinition } from "../telemetry-catalog.ts";
import { WORKFLOW_FINDING_REASONS } from "../workflow-reasons.ts";
import { WORKFLOW_BINDING_STATES, WORKFLOW_RUN_STATUSES, WORKFLOW_DELIVERY_KINDS, WORKFLOW_DELIVERY_STATES } from "../workflow.ts";
import { THINKING_LEVELS } from "../types.ts";
import { MODEL_CATALOG } from "../model.ts";

const models = new Set(Object.values(MODEL_CATALOG).flatMap((entries) => entries.map((m) => m.id)));
export const workflowModel = (value: unknown): string =>
  typeof value !== "string" || !value ? "unknown" : models.has(value) ? value : "other";
const effort = z.enum([...THINKING_LEVELS, "unknown", "unsupported"]);
export const WORKFLOW_AUTHOR_SCHEMA = z.object({
  author_model: z.string().max(256), author_effort: effort,
  author_quality: z.enum(["observed", "launch_resolved", "unknown", "unsupported"]),
});
const common = {
  workflow: z.enum(["builtin", "custom", "unknown"]),
  ...WORKFLOW_AUTHOR_SCHEMA.shape,
};
const refs = ["workflow_id", "version_id", "binding_id", "run_id", "submission_id", "node_id",
  "attempt_id", "persona_id", "persona_revision", "call_id", "delivery_id", "stage_id", "reuse_attempt_id",
  "session_id", "task_id", "segment_id", "conversation_id", "operation_id", "cause_attempt_id"];
function event<S extends z.ZodRawShape>(name: string, group: TelemetryEventDefinition["group"],
  question: string, shape: S, duration: string | null = null): TelemetryEventDefinition<z.ZodObject<S & typeof common, "strict">> {
  const facts = z.object({ ...common, ...shape }).strict();
  return { name: `mission.workflow.${name}`, version: 1, group, priority: "core", question,
    owner: "src/server/telemetry/workflows.ts", audience: AUDIENCE_ALL, facts, refKeys: refs,
    ingress: null, span: { name: `mission.workflow.${name}`, kind: "internal", durationFactKey: duration,
      attributes: Object.keys(facts.shape), refAttributes: refs, errorWhen: null } };
}
export const WORKFLOW_ASSET_EVENT = event("asset", "workflow_run", "Which immutable definitions and bindings are used?", {
  entity: z.enum(["definition", "version", "binding"]), revision: z.number().int().nonnegative(),
  state: z.enum(["draft", "published", ...WORKFLOW_BINDING_STATES]),
});
export const WORKFLOW_PROGRESS_EVENT = event("repair.progress", "workflow_repair", "When is an action packet picked up and its continuation submitted?", {
  observation: z.enum(["pickup", "resubmitted"]), duration_ms: z.number().nonnegative().nullable(),
  time_quality: z.literal("wall_clock"), coverage: z.literal("session_action"),
}, "duration_ms");
export const WORKFLOW_RUN_EVENT = event("run", "workflow_run", "Which runs start, wait and finish?", {
  observation: z.enum(["started", "changed", "finished"]), status: z.enum(WORKFLOW_RUN_STATUSES),
  automation_eligibility: z.enum(["eligible", "human_gate", "unknown"]).default("unknown"),
  wait: z.enum(["none", "agent", "external", "human", "unknown"]),
  previous_wait: z.enum(["none", "agent", "external", "human", "unknown"]),
  wait_ms: z.number().nonnegative().nullable(), duration_ms: z.number().nonnegative().nullable(),
  time_quality: z.enum(["wall_clock", "unknown"]),
}, "duration_ms");
export const WORKFLOW_SUBMISSION_EVENT = event("submission", "workflow_run", "Which evidence segments and repair rounds ran?", {
  round: z.number().int().positive(), segment: z.number().int().nonnegative(),
  repair_round: z.boolean(), trigger: z.enum(["manual", "foreman", "automatic", "unknown"]),
  pickup: z.literal("unknown"),
});
export const WORKFLOW_NODE_EVENT = event("node", "workflow_stage", "Which nodes executed, reused, bypassed or stopped?", {
  observation: z.enum(["eligible", "queued", "started", "finished", "late_result"]),
  node_kind: z.enum(["persona", "check", "session", "session_action", "all_pass", "end", "unknown"]),
  disposition: z.enum(["pending", "executed", "reused", "disabled", "cancelled", "infrastructure_error", "unknown"]),
  stage_projection: z.enum(["available", "unavailable"]),
  reviewer_model: z.string().max(256), reviewer_runner: z.string().max(40), reviewer_effort: effort,
  directive: z.boolean(), duration_ms: z.number().nonnegative().nullable(), queue_ms: z.number().nonnegative().nullable(),
  time_quality: z.literal("wall_clock"),
}, "duration_ms");
export const WORKFLOW_REVIEW_EVENT = event("review.finished", "persona_review", "What did an executed reviewer decide?", {
  verdict: z.enum(["pass", "fail"]), reviewer_model: z.string().max(256), reviewer_runner: z.string().max(40),
  reviewer_effort: effort, directive: z.boolean(),
});
export const WORKFLOW_RESPONSE_EVENT = event("review.response", "persona_review", "How many provider calls produced usable reviews?", {
  validity: z.enum(["valid", "parse_failure", "contract_violation", "unavailable", "pending"]),
  observation: z.enum(["started", "finished"]), reviewer_model: z.string().max(256),
  reviewer_runner: z.string().max(40), reviewer_effort: effort,
  duration_ms: z.number().nonnegative().nullable(),
}, "duration_ms");
export const WORKFLOW_FINDING_EVENT = event("finding", "persona_review", "Which general topics require changes?", {
  category: z.enum(WORKFLOW_FINDING_REASONS), category_version: z.literal(1),
  category_source: z.enum(["structured", "unknown"]),
  basis: z.enum(["substantive", "coverage_registration", "evidence_access", "unknown"]),
  reviewer_model: z.string().max(256),
});
export const WORKFLOW_STAGE_EVENT = event("stage", "workflow_stage", "What is the observed parallel stage wall time?", {
  observation: z.enum(["activated", "settled"]), duration_ms: z.number().nonnegative().nullable(),
  time_quality: z.literal("wall_clock"), stage_kind: z.enum(["evaluation", "session_action"]),
}, "duration_ms");
export const WORKFLOW_DELIVERY_EVENT = event("repair.delivery", "workflow_repair", "Which repair packets actually reached the author?", {
  kind: z.enum(WORKFLOW_DELIVERY_KINDS), state: z.enum(WORKFLOW_DELIVERY_STATES),
  cause_count: z.number().int().nonnegative(),
});
export const WORKFLOW_CAUSE_EVENT = event("repair.cause", "workflow_repair", "Which reviews caused a combined repair packet?", {});

function metric(name: string, event: TelemetryEventDefinition, dimensions: string[],
  predicate: (f: Record<string, unknown>, e: TelemetryEnvelope) => boolean = () => true,
  value?: string): TelemetryMetricDefinition {
  return { name: `mission.${name}`, description: event.question, unit: value ? "s" : "1",
    kind: value ? "histogram" : "counter", valueType: value ? "double" : "int", event: event.name,
    audience: AUDIENCE_ALL, dimensions, boundaries: value ? [0.1, 1, 10, 60, 300, 1800, 3600, 86400] : null,
    unknownPolicy: "explicit_unknown", since: 2, owner: event.owner,
    contribution: (facts, envelope) => !predicate(facts, envelope) || (value && typeof facts[value] !== "number") ? null : ({
      dimensions: Object.fromEntries(dimensions.map((key) => [key, String(facts[key] ?? "unknown")])),
      value: value ? (facts[value] as number) / 1000 : 1,
    }) };
}
export const WORKFLOW_EVENTS = [WORKFLOW_ASSET_EVENT, WORKFLOW_PROGRESS_EVENT, WORKFLOW_RUN_EVENT, WORKFLOW_SUBMISSION_EVENT, WORKFLOW_NODE_EVENT,
  WORKFLOW_REVIEW_EVENT, WORKFLOW_RESPONSE_EVENT, WORKFLOW_FINDING_EVENT, WORKFLOW_STAGE_EVENT,
  WORKFLOW_DELIVERY_EVENT, WORKFLOW_CAUSE_EVENT];
export const WORKFLOW_METRICS = [
  metric("workflow.assets", WORKFLOW_ASSET_EVENT, ["entity", "state"]),
  metric("workflow.pickup.duration", WORKFLOW_PROGRESS_EVENT, ["coverage"], (f) => f.observation === "pickup", "duration_ms"),
  metric("workflow.repair.duration", WORKFLOW_PROGRESS_EVENT, ["coverage"], (f) => f.observation === "resubmitted", "duration_ms"),
  metric("workflow.started", WORKFLOW_RUN_EVENT, ["workflow"], (f) => f.observation === "started"),
  metric("workflow.finished", WORKFLOW_RUN_EVENT, ["workflow", "status"], (f) => f.observation === "finished"),
  metric("workflow.duration", WORKFLOW_RUN_EVENT, ["workflow", "status"], (f) => f.observation === "finished", "duration_ms"),
  metric("workflow.wait.duration", WORKFLOW_RUN_EVENT, ["previous_wait"], () => true, "wait_ms"),
  metric("workflow.submissions", WORKFLOW_SUBMISSION_EVENT, ["trigger"]),
  metric("workflow.repair.rounds", WORKFLOW_SUBMISSION_EVENT, ["workflow"], (f) => f.repair_round === true),
  metric("workflow.nodes", WORKFLOW_NODE_EVENT, ["node_kind", "disposition"], (f) => f.observation === "finished"),
  metric("workflow.node.duration", WORKFLOW_NODE_EVENT, ["node_kind", "disposition"], (f) => f.observation === "finished", "duration_ms"),
  metric("workflow.node.queue.duration", WORKFLOW_NODE_EVENT, ["node_kind"], (f) => f.observation === "started", "queue_ms"),
  metric("persona.verdicts", WORKFLOW_REVIEW_EVENT, ["verdict", "reviewer_model", "reviewer_effort"]),
  metric("persona.executions", WORKFLOW_RESPONSE_EVENT, ["reviewer_model"], (f) => f.observation === "started"),
  metric("persona.responses", WORKFLOW_RESPONSE_EVENT, ["validity"], (f) => f.observation === "finished"),
  metric("persona.response.errors", WORKFLOW_RESPONSE_EVENT, ["validity"], (f) => f.observation === "finished" && ["parse_failure", "contract_violation"].includes(String(f.validity))),
  metric("persona.findings", WORKFLOW_FINDING_EVENT, ["category", "basis", "category_source"]),
  metric("workflow.stage.duration", WORKFLOW_STAGE_EVENT, ["stage_kind"], (f) => f.observation === "settled", "duration_ms"),
  metric("workflow.repair.packets", WORKFLOW_DELIVERY_EVENT, ["kind"], (f) => f.state === "delivered" && ["persona_feedback", "inspector_feedback"].includes(String(f.kind))),
  metric("workflow.deliveries", WORKFLOW_DELIVERY_EVENT, ["kind", "state"]),
];
