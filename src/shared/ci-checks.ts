// Which GitHub check results count as pending, passing or failing. Browser-safe.
//
// The one classification for a `statusCheckRollup` entry, read by the PR card's CI chip
// (`src/server/pr.ts`) and by Wait for CI (`src/shared/wait-for-ci.ts`), so the two cannot
// disagree about whether a check failed.

import type { PrChecks } from "./types.ts";

/** CheckRun conclusions that count as a failed check. */
const FAIL_CONCLUSIONS = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "STALE",
]);
/** StatusContext states that count as a failed check. */
const FAIL_STATES = new Set(["FAILURE", "ERROR"]);
/** StatusContext states that are still running. */
const PENDING_STATES = new Set(["PENDING", "EXPECTED"]);

export type CiCheckEntryState = "pending" | "passing" | "failing";

/**
 * Classify one rollup entry: a GraphQL `CheckRun` (a `status` such as QUEUED, IN_PROGRESS or
 * COMPLETED, plus a `conclusion` once done) or a legacy `StatusContext` (a `state`). SUCCESS,
 * NEUTRAL and SKIPPED pass, and so does anything unrecognised, so an unknown value never
 * raises a false alarm. Null for a shape that is neither.
 */
export function classifyCheckEntry(entry: unknown): CiCheckEntryState | null {
  const o = (entry ?? {}) as { status?: unknown; conclusion?: unknown; state?: unknown };
  if (typeof o.status === "string") {
    if (o.status.toUpperCase() !== "COMPLETED") return "pending";
    const conclusion = typeof o.conclusion === "string" ? o.conclusion.toUpperCase() : "";
    return FAIL_CONCLUSIONS.has(conclusion) ? "failing" : "passing";
  }
  if (typeof o.state === "string") {
    const state = o.state.toUpperCase();
    if (FAIL_STATES.has(state)) return "failing";
    if (PENDING_STATES.has(state)) return "pending";
    return "passing";
  }
  return null;
}

/**
 * Which checks a CI gate counts: every check on the head, or only those GitHub marks required
 * on the pull request. APPEND-ONLY: persisted in workflow graphs and in Foreman config.
 */
export const CI_STRICTNESS = ["all", "required"] as const;
export type CiStrictness = (typeof CI_STRICTNESS)[number];

/**
 * The rollup of the checks GitHub marks required (`isRequired`), or null when none is marked.
 * `failing` when any required check fails, `pending` when any is still running, otherwise
 * `passing`. The one classification shared by Wait for CI and Foreman, so the two cannot
 * disagree about the required checks.
 */
export function requiredChecksRollup(
  runs: readonly { state: CiCheckEntryState; required?: boolean }[],
): PrChecks | null {
  const required = runs.filter((run) => run.required === true);
  if (required.length === 0) return null;
  if (required.some((run) => run.state === "failing")) return "failing";
  if (required.some((run) => run.state === "pending")) return "pending";
  return "passing";
}
