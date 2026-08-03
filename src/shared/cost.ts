import type { AgentType, FleetCost, RateLimitWindow, SessionCost } from "./types.ts";

// One place that decides when a number stops being a fact and starts being a signal.
//
// Cost is drawn by four components across three layouts, and each has its own mark
// vocabulary (the card's chips, the tile's `.tile-flag`s, the rail's glyphs). If each
// picked its own "when is this a lot?" the same session would read as fine on the board
// and as alarming in the rail - the exact drift `foremanAllowlisted` and `composeWrapup`
// live in `@shared` to prevent. So the threshold lives here and every surface asks.
//
// Deliberately NOT a session tone: `TONE_ORDER` drives grid sort, rail sections and board
// columns, and none of those should reorder by estimated cost. This is a chip modifier only.

/**
 * A dollar figure for a chip: `$0.42`, `$12.40`, `$1,204`.
 *
 * Cents are dropped past three figures because they stop being information there - the
 * estimate's own error bar is wider than a cent by then, and the extra glyphs cost room
 * on the tightest surfaces. Below a cent reads as `<$0.01` rather than `$0.00`, since a
 * session that has spent SOMETHING and one that has spent nothing are different states
 * and the second one renders no chip at all.
 *
 * Here rather than in `src/web/lib/format.ts` (which re-exports it) because the daemon
 * words the Line's Shipped sentence, and money has to be spelled the same way in a
 * server-built string as in the chip beside it. A second `toFixed(2)` on the server is
 * how `$4.1` ends up next to `$4.10`.
 */
export function fmtUsd(usd: number | null | undefined): string {
  if (usd == null || !Number.isFinite(usd)) return "-";
  if (usd > 0 && usd < 0.01) return "<$0.01";
  if (usd >= 1000) return "$" + Math.round(usd).toLocaleString("en-US");
  return "$" + usd.toFixed(2);
}

/**
 * What one shipped pull request cost the fleet today, or null when that cannot be said.
 *
 * Fleet-wide and same-day by construction: it is today's estimate over today's adoptions,
 * so it is an average of a day rather than a figure attributable to any one row. Two
 * surfaces print it - the spend popover and the Ship log's KPI - and they must not disagree
 * about the division or about when to refuse it.
 *
 * Null on every reading that would be a lie rather than a zero: no telemetry at all, an
 * estimate withheld because part of today's usage is unpriced (`estimatedCostToday` is null
 * exactly then), a day that has genuinely spent nothing, a day with no adopted pull requests
 * (the division is by zero, and the honest answer is that nothing shipped rather than that
 * shipping was free), and a figure that is not a number at all.
 *
 * That last one is why the guards are `Number.isFinite` and not a negated comparison.
 * `NaN > 0` is false, so the three call sites this fold replaced all REFUSED a corrupt
 * estimate; `NaN <= 0` is false too, so writing the same rule inverted ACCEPTS it and
 * divides. The two spellings look interchangeable and differ on exactly the input that
 * matters. Downstream, `fmtUsd` renders a non-finite number as `-`, so the surfaces would
 * not have printed `$NaN` - they would have printed a per-PR ROW, with a dash where the
 * measurement goes, on a day when the right thing to say is nothing at all.
 */
export function costPerPrToday(fleet: FleetCost | null | undefined): number | null {
  if (!fleet) return null;
  const estimated = fleet.estimatedCostToday;
  if (estimated === null || !Number.isFinite(estimated) || estimated <= 0) return null;
  if (!Number.isFinite(fleet.prsToday) || fleet.prsToday <= 0) return null;
  return estimated / fleet.prsToday;
}

/** Where a session's API-equivalent estimate sits, for the chip's colour and rail glyph. */
export type CostTone = "normal" | "attention" | "danger";

/**
 * Estimated dollars at which one session is worth noticing, and worth stopping at.
 *
 * Round numbers, not measured ones - there is no "correct" figure here, and pretending
 * otherwise would be false precision. They are set where a person running a fleet would
 * plausibly want to look: a session past a few dollars is doing real work, one past
 * twenty is either enormous or stuck in a loop, and telling those apart is the operator's
 * job, not ours. Configurable is a later question; a silent zero threshold is not, since
 * that would flag every session and mean nothing.
 */
export const COST_ATTENTION_USD = 5;
export const COST_DANGER_USD = 20;

/** The tone for an estimate. `null`/unpriced reads as `normal` - absence is not alarm. */
export function costTone(costUsd: number | null | undefined): CostTone {
  if (costUsd == null) return "normal";
  if (costUsd >= COST_DANGER_USD) return "danger";
  if (costUsd >= COST_ATTENTION_USD) return "attention";
  return "normal";
}

/**
 * Whether a session's estimate has earned a place in a mark vocabulary.
 *
 * The rail is the surface this exists for: `RailRow` budgets itself two lines and a full
 * `≈$1.24` in `.rail-meta` costs horizontal room on the tightest surface in the app. So the
 * rail shows a glyph only once the number is notable, and the routine case stays invisible
 * there - a deliberate trade, and the one place cost is not on screen at all times.
 */
export function costIsNotable(cost: SessionCost | null | undefined): boolean {
  return costTone(cost?.costUsd) !== "normal";
}

/** Agents whose usage cannot produce either reported or API-equivalent dollars. */
export const COST_UNSUPPORTED: Record<AgentType, string | null> = {
  claude: null,
  codex: null,
  // Not unsupported: pi records real per-message token AND dollar cost in its transcript,
  // so it is not an agent that "reports no cost telemetry". We simply do not aggregate it
  // passively (its usage is per-message, not a cumulative total, and pi has no hook/telemetry
  // pipeline to feed the ledger), so a pi card shows the same neutral absence a session
  // shows before telemetry arrives.
  pi: null,
};

/** How long each rate-limit window runs, which is what makes a runway projectable. */
export const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
export const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;

/** How much of a rate-limit window is left, at the rate it has been spent so far. */
export interface RunwayProjection {
  /** Milliseconds of headroom. Zero means the window is already exhausted. */
  ms: number;
  /** True when the window rolls over before that lands - you will not hit the wall. */
  clears: boolean;
}

/**
 * When the current rate exhausts a rate-limit window.
 *
 * The projection uses the window's OWN average - `usedPercentage` over the time since the
 * window opened - and nothing else. That is a deliberate choice over projecting from
 * the estimated hourly cost: API-equivalent dollars and quota are different meters (a
 * subscription's dollars are notional, and a cache-heavy hour is cheap in dollars but not
 * in quota), so deriving
 * one from the other would produce a confident number about the wrong quantity. This one
 * needs no extra state, survives a daemon restart, and is checkable by hand against the
 * two figures Claude sends.
 *
 * Its weakness is honest and worth stating: an average cannot see a burst. A fleet that
 * idled four hours and then started six sessions reads as calm for a while. It is a
 * projection, and the UI says "~" in front of it.
 *
 * Returns null when there is nothing to project from - no consumption yet, or a window
 * whose start is not in the past (clock skew, or a reading from the future). Null means
 * "we cannot say", and must render as nothing rather than as a full runway.
 */
export function projectRunway(
  window: RateLimitWindow,
  windowMs: number,
  now: number,
): RunwayProjection | null {
  const resetsAtMs = window.resetsAt * 1000;
  const msToReset = resetsAtMs - now;
  if (msToReset <= 0) return null;
  const used = window.usedPercentage;
  if (!Number.isFinite(used) || used <= 0) return null;
  if (used >= 100) return { ms: 0, clears: false };
  const elapsed = windowMs - msToReset;
  if (elapsed <= 0) return null;
  // Percent per ms, then the percent still unspent divided by it.
  const msToFull = ((100 - used) / used) * elapsed;
  return { ms: Math.min(msToFull, msToReset), clears: msToFull >= msToReset };
}
