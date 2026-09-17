import type { TelemetryEnvelope } from "@shared/telemetry.ts";
import { TELEMETRY_LIMITS } from "@shared/telemetry.ts";
import { workflowModel } from "@shared/telemetry-sources/workflows.ts";
import { workflowFindingReason } from "@shared/workflow-reasons.ts";
import { digest } from "../identity.ts";

export const DAY = 86_400_000;
export const WINDOW = 7 * DAY;
export const MAX_FACTS = 4096;
export const MAX_SLICES = 24;
export const RETENTION = TELEMETRY_LIMITS.reducerStateRetentionMs;

/** Minimal join keys and analytical values, never original envelopes or payloads. */
export interface AnalyticalFact {
  id: string;
  kind: string;
  at: number;
  observed: number;
  run: string;
  task: string;
  session: string;
  node: string;
  attempt: string;
  operation: string;
  pr: string;
  resource: string;
  appVersion: string;
  actor: "human" | "automatic" | "unknown";
  omitted: boolean;
  values: Record<string, string | number | boolean>;
}
export interface AnalyticalState {
  facts: Record<string, AnalyticalFact>;
  size: number;
  lastExpiryAt: number;
  since: number | null;
  rejected: number;
  expired: number;
  incompleteUntil: number;
  lastCalculatedAt: number;
  dirty: boolean;
  lastGapAt: number | null;
  /** Persistent bounded slice vocabulary, so a vanished population exports real zeros. */
  slices: Record<string, string[]>;
  overflowViews: string[];
  /** Bounded feature timestamps for this consent epoch, not first-ever use. */
  firstUse: Record<string, number>;
}
export function initialAnalyticalState(now?: number): AnalyticalState {
  return { facts: {}, size: 0, lastExpiryAt: 0, since: now ?? null, rejected: 0, expired: 0, incompleteUntil: 0, lastCalculatedAt: 0,
    dirty: false, lastGapAt: null, slices: {}, overflowViews: [], firstUse: {} };
}

const fields: Record<string, readonly string[]> = {
  "mission.workflow.run": ["observation", "status", "workflow", "author_model", "author_effort", "author_quality", "time_quality", "automation_eligibility"],
  "mission.workflow.submission": ["workflow", "author_model", "author_effort", "author_quality", "round", "segment"],
  "mission.workflow.review.finished": ["verdict", "reviewer_model", "reviewer_effort", "author_model", "author_effort", "workflow"],
  "mission.workflow.review.response": ["observation", "validity", "reviewer_model", "reviewer_effort"],
  "mission.workflow.node": ["observation", "disposition", "reviewer_model", "reviewer_effort"],
  "mission.workflow.finding": ["category", "basis", "category_source", "reviewer_model"],
  "mission.workflow.repair.delivery": ["kind", "state"],
  "mission.action.result": ["feature", "action", "outcome", "intent", "coverage", "observation"],
  "mission.dispatch.finished": ["outcome", "task_kind", "repo_count"],
  "mission.session.started": ["start_observation", "task_kind"],
  "mission.session.operation": ["operation", "outcome"],
  "mission.session.kill.requested": ["outcome"],
  "mission.session.effort.selected": ["outcome"],
  "mission.session.ended": ["ended_while_work_open", "reason", "observation_bounded"],
  "mission.task.outcome": ["status", "completion_evidence", "observation_bounded", "task_kind", "repo_count"],
  "mission.pr.observed": ["fact", "delivery", "visibility", "task_kind"],
  "mission.usage.recorded": ["usage_origin", "cost_basis", "model_id", "input", "output", "reasoning_output", "cache_read", "cache_write", "cost_usd"],
  "mission.session.segment.opened": ["model_id", "effort", "quality"],
};

/** Incoming strings are already schema-validated; model and feature slices get a second bound. */
export function analyticalFact(event: TelemetryEnvelope, appVersion = "unknown"): AnalyticalFact | null {
  const keys = fields[event.name];
  if (!keys) return null;
  const ref = (name: string) => event.refs[name] ? digest([name, event.refs[name]]).slice(0, 32) : "";
  const values: AnalyticalFact["values"] = {};
  for (const key of keys) {
    const value = event.facts[key];
    if (typeof value === "number" && Number.isFinite(value) || typeof value === "boolean") values[key] = value;
    else if (typeof value === "string") values[key] = key.includes("model")
      ? ["unknown", "unsupported", "other"].includes(value) ? value : workflowModel(value) : value.slice(0, 64);
  }
  if ("category" in values) values.category = workflowFindingReason(values.category);
  const kind = event.name.slice("mission.".length);
  // Application operation ids and executed attempt ids outlive individual deliveries.
  // Findings and usage already have one canonical source identity per contribution.
  const semantic = kind === "action.result" && event.refs.operation_id
    ? [event.refs.operation_id, values.action, values.outcome === "applied" ? "applied" : "initial"]
    : kind === "workflow.review.finished" && event.refs.attempt_id ? [event.refs.attempt_id]
    : kind === "workflow.review.response" && event.refs.call_id ? [event.refs.call_id, values.observation]
    : kind === "workflow.node" && event.refs.attempt_id ? [event.refs.attempt_id, values.observation, values.disposition]
    : kind === "workflow.repair.delivery" && event.refs.delivery_id ? [event.refs.delivery_id, values.state]
    : kind === "pr.observed" && event.refs.pr_key ? [event.refs.task_id, event.refs.repo_key, event.refs.pr_key, values.fact]
    : kind === "workflow.run" && event.refs.run_id ? [event.refs.run_id, values.observation]
    : [event.eventId];
  return { id: digest([kind, ...semantic]), kind, at: event.occurredAt, observed: event.observedAt,
    run: ref("run_id"), task: ref("task_id"), session: ref("session_id"), node: ref("node_id"),
    attempt: ref("attempt_id"), operation: ref("operation_id"),
    pr: event.refs.pr_key && event.refs.repo_key ? digest([event.refs.repo_key, event.refs.pr_key]).slice(0, 32) : "",
    resource: event.resourceId,
    appVersion: appVersion.slice(0, 64),
    actor: event.actor.basis === "owner" || event.actor.basis === "app_context"
      ? event.actor.kind === "human" ? "human" : event.actor.kind === "unknown" ? "unknown" : "automatic" : "unknown",
    omitted: event.refsOmitted > 0 || event.contextOmitted > 0
      || kind === "workflow.run" && !event.refs.run_id
      || kind === "workflow.review.finished" && (!event.refs.attempt_id || !event.refs.node_id || !event.refs.run_id)
      || kind === "action.result" && !event.refs.operation_id
      || kind === "pr.observed" && (!event.refs.task_id || !event.refs.repo_key || !event.refs.pr_key), values };
}

export function expireAnalyticalState(state: AnalyticalState, now: number): void {
  if (state.lastExpiryAt === now) return;
  state.lastExpiryAt = now;
  for (const [id, fact] of Object.entries(state.facts)) {
    if (fact.at >= now - RETENTION) continue;
    delete state.facts[id];
    state.size--;
    state.expired++;
    state.dirty = true;
    // Ordinary expiry cannot affect the 14-day lookback. Unresolved PR observations have
    // their own source gap; the projection does not invent a negative merge verdict.
  }
}

export function reduceAnalyticalEvent(event: TelemetryEnvelope, state: AnalyticalState, now: number, appVersion?: string): AnalyticalState {
  expireAnalyticalState(state, now);
  const fact = analyticalFact(event, appVersion);
  if (!fact) return state;
  state.since ??= fact.observed;
  if (fact.at < now - RETENTION || fact.at > now) {
    state.rejected++;
    state.dirty = true;
    state.incompleteUntil = Math.max(state.incompleteUntil, now + 2 * WINDOW);
    return state;
  }
  const previous = state.facts[fact.id];
  if (previous) {
    // Earliest semantic observation wins, independently of replay/arrival ordering.
    if (previous.at < fact.at || previous.at === fact.at && previous.observed <= fact.observed) return state;
  } else if (state.size >= MAX_FACTS) {
    state.rejected++;
    state.dirty = true;
    state.incompleteUntil = Math.max(state.incompleteUntil, now + 2 * WINDOW);
    return state;
  }
  state.facts[fact.id] = fact;
  if (!previous) state.size++;
  if (fact.kind === "action.result" && fact.values.outcome === "applied") {
    const feature = String(fact.values.feature);
    state.firstUse[feature] = Math.min(state.firstUse[feature] ?? fact.at, fact.at);
  }
  state.dirty = true;
  return state;
}
