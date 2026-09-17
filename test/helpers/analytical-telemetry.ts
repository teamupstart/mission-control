import { TELEMETRY_EVENTS } from "../../src/shared/telemetry-catalog.ts";
import type { TelemetryEnvelope } from "../../src/shared/telemetry.ts";

export const ANALYTICAL_DAY = 86_400_000;
const author = { workflow: "builtin", author_model: "unknown", author_effort: "unknown", author_quality: "unknown" };
const reviewer = { reviewer_model: "unknown", reviewer_runner: "claude", reviewer_effort: "unknown" };
const defaults: Record<string, Record<string, unknown>> = {
  "workflow.run": { ...author, observation: "started", status: "running", automation_eligibility: "eligible",
    wait: "none", previous_wait: "none", wait_ms: null, duration_ms: null, time_quality: "wall_clock" },
  "workflow.submission": { ...author, round: 1, segment: 0, repair_round: false, trigger: "automatic", pickup: "unknown" },
  "workflow.review.finished": { ...author, ...reviewer, directive: false, verdict: "pass" },
  "workflow.review.response": { ...author, ...reviewer, observation: "finished", validity: "parse_failure", duration_ms: 12 },
  "workflow.node": { ...author, ...reviewer, directive: false, observation: "finished", disposition: "reused", stage_projection: "available",
    node_kind: "persona", duration_ms: null, queue_ms: null, time_quality: "wall_clock" },
  "workflow.finding": { ...author, reviewer_model: "unknown", category: "test_coverage", category_version: 1, category_source: "structured", basis: "substantive" },
  "workflow.repair.delivery": { ...author, kind: "persona_feedback", state: "delivered", cause_count: 1 },
  "action.result": { feature: "workflow", action: "workflow.resubmit", outcome: "applied", observation: "initial",
    duration_ms: 1, surface: "runs", coverage: "owner_result", intent: "recovery", cause: "agent_wait" },
  "dispatch.finished": { outcome: "launched", agent: "claude", runtime: "sdk", task_kind: "ship", resolved_model: "",
    resolved_effort: "unknown", resolution_source: "harness", repo_count: 2, duration_ms: 1 },
  "task.outcome": { task_kind: "ship", status: "failed", completion_evidence: "missing", repo_count: 2, duration_ms: 1, observation_bounded: false },
  "session.ended": { agent: "claude", runtime: "sdk", task_kind: "ship", reason: "unknown", ended_while_work_open: true,
    observation_bounded: false, observed_ms: 1 },
  "pr.observed": { fact: "creation_verified", task_kind: "ship", repo_role: "primary", delivery: "live", visibility: "unknown", age_ms: 0 },
  "usage.recorded": { usage_origin: "authoring", cost_basis: "api-equivalent", model_id: "unknown",
    input: 10, output: 5, reasoning_output: 0, cache_read: 0, cache_write: 0, cost_usd: 0.01 },
};

/** Shared schema-valid source fixture for reducer, outbox and real receiver tests. */
export function analyticalEvent(kind: string, id: string, at: number,
  facts: Record<string, unknown> = {}, refs: Record<string, string> = {},
  actor: TelemetryEnvelope["actor"] = { kind: "workflow", origin: "daemon", basis: "owner" }): TelemetryEnvelope {
  const name = `mission.${kind}`;
  const definition = TELEMETRY_EVENTS[name];
  if (!definition) throw new Error(`unknown fixture event ${name}`);
  return { envelopeVersion: 1, eventId: id, name, eventVersion: definition.version, occurredAt: at, observedAt: at,
    resourceId: "fixture-resource", contextId: "fixture-context", actor, refs, refsOmitted: 0, contextOmitted: 0,
    facts: definition.facts.parse({ ...defaults[kind], ...facts }) as Record<string, unknown> };
}

export function analyticalGoldenFixture(now: number): TelemetryEnvelope[] {
  const start = now - 10 * ANALYTICAL_DAY;
  const events: TelemetryEnvelope[] = [];
  const push = (kind: string, id: string, offset: number, facts: Record<string, unknown>, refs: Record<string, string>, actor?: TelemetryEnvelope["actor"]) =>
    events.push(analyticalEvent(kind, id, start + offset, facts, refs, actor));
  for (let run = 1; run <= 6; run++) {
    const refs = { run_id: `R${run}`, session_id: `S${run}` };
    push("workflow.run", `R${run}-start`, 0, { automation_eligibility: run === 5 ? "human_gate" : "eligible" }, refs);
    if (run !== 3) push("workflow.run", `R${run}-end`, 10_000, { observation: "finished", status: run === 4 ? "cancelled" : "completed" }, refs);
  }
  const review = (run: number, node: string, attempt: string, verdict: "pass" | "fail", at: number) =>
    push("workflow.review.finished", attempt, at, { verdict }, { run_id: `R${run}`, node_id: node, attempt_id: attempt });
  review(1, "A", "R1-A1", "fail", 100);
  review(1, "B", "R1-B1", "pass", 200);
  review(1, "A", "R1-A2", "pass", 500);
  review(2, "A", "R2-A1", "pass", 100);
  review(2, "B", "R2-B1", "pass", 200);
  review(4, "A", "R4-A1", "fail", 100);
  review(5, "A", "R5-A1", "pass", 100);
  review(6, "A", "R6-A1", "pass", 100);
  push("workflow.review.response", "invalid", 50, {}, { run_id: "R1", call_id: "invalid-call" });
  push("workflow.node", "reuse", 600, {}, { run_id: "R1", attempt_id: "reused-pass" });
  push("workflow.finding", "finding", 100, {}, { run_id: "R1", attempt_id: "R1-A1" });
  push("workflow.repair.delivery", "packet", 300, {}, { run_id: "R1", delivery_id: "packet" });
  for (const [run, intent] of [[1, "recovery"], [4, "termination"], [5, "required_decision"], [6, "recovery"]] as const) {
    push("action.result", `action-R${run}`, 400, { intent }, { run_id: `R${run}`, operation_id: `operation-R${run}` },
      { kind: run === 6 ? "unknown" : "human", origin: "dashboard", basis: run === 6 ? "unknown" : "app_context" });
  }
  return events.sort((a, b) => a.occurredAt - b.occurredAt || a.eventId.localeCompare(b.eventId));
}
