import type { TelemetryMetricDefinition } from "../telemetry-catalog.ts";
import { AUDIENCE_ALL } from "../telemetry.ts";

/** Versioned populations. Every field, including zeros, is emitted in every snapshot. */
export const ANALYTICAL_VIEWS = {
  runs: ["eligible", "completed", "pending", "cancelled", "failed", "unknown", "immature", "left_censored",
    "recovery_operations", "with_recovery", "with_human", "ambiguous_actor", "human_gate",
    "automation_eligible", "eligibility_unknown", "human_free", "observation_incomplete", "mixed_author"],
  reviews: ["executed", "pass", "fail", "first", "first_pass", "failed_with_next", "resolved", "no_next",
    "invalid", "reused", "packets", "ordering_unknown"],
  tasks: ["eligible", "completed", "failed", "cancelled", "pending", "unknown", "early_exit",
    "abandonment_candidate", "continued", "pr_eligible", "with_new_pr", "with_existing_pr", "with_merged_pr", "with_merged_pr_within_horizon",
    "pr_visibility_unknown", "with_usage", "usage_missing", "usage_unfinished"],
  prs: ["associated", "created", "existing", "merged", "merged_within_horizon", "closed_unmerged", "visibility_unknown", "late_merges"],
  features: ["observed", "first_period", "second_period", "repeat_eligible", "repeated", "operations",
    "successful_operations", "failed_operations", "affected_installation"],
  reasons: ["findings", "reviews", "unknown_basis"],
  quality: ["facts", "late_facts", "omitted_facts", "unknown_actor", "model_observations", "known_model",
    "effort_observations", "known_effort", "rejected_state", "expired_state"],
  usage: ["input", "output", "reasoning_output", "cache_read", "cache_write", "attributed", "unattributed", "priced", "unpriced", "qualifying_outcomes"],
} as const;
export type AnalyticalView = keyof typeof ANALYTICAL_VIEWS;
export const ANALYTICAL_WINDOW = "7d";
export const ANALYTICAL_HORIZON = "7d";
export const ANALYTICAL_PREFIX = "mission.analytics.v1";
export const ANALYTICAL_METADATA = ["calculated_at", "window_start", "window_end", "horizon", "complete", "expected_points", "first_observed_at", "consent_epoch"] as const;
export const ANALYTICAL_DIMENSIONS = ["window", "horizon", "slice_by", "slice", "audience"] as const;

function gauge(name: string, description: string, unit = "{item}"): TelemetryMetricDefinition {
  return { name: `${ANALYTICAL_PREFIX}.${name}`, description, unit, kind: "gauge", valueType: "double",
    // An audience anchor only. These instruments are computed by the analytical reducer;
    // the ordinary event catalog must never contribute to them a second time.
    event: "mission.workflow.run", audience: AUDIENCE_ALL, dimensions: ANALYTICAL_DIMENSIONS,
    boundaries: null, unknownPolicy: "explicit_unknown", since: 2,
    owner: "src/server/telemetry/projections/index.ts", contribution: () => null };
}

/** No source registrations: Phase 5 can extend its action catalog independently. */
export const ANALYTICAL_METRICS: TelemetryMetricDefinition[] = Object.entries(ANALYTICAL_VIEWS).flatMap(([view, fields]) => [
  ...fields.map((field) => gauge(`${view}.${field}`, `Exact bounded ${view} snapshot: ${field}; see docs/telemetry-analytics.md`)),
  ...ANALYTICAL_METADATA.map((field) => gauge(`${view}.${field}`, `${view} snapshot ${field}; timestamps are values, never labels`,
    ["calculated_at", "window_start", "window_end", "horizon", "first_observed_at"].includes(field) ? "s" : field === "complete" ? "1" : "{item}")),
  ...(view === "usage" ? [gauge("usage.cost", "Attributed API-equivalent or reported cost; split by cost basis and work role", "USD")] : []),
]);
