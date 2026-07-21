import type { AgentType, RateLimitWindow, SessionCost } from "./types.ts";

// One place that decides when a number stops being a fact and starts being a signal.
//
// Cost is drawn by four components across three layouts, and each has its own mark
// vocabulary (the card's chips, the tile's `.tile-flag`s, the rail's glyphs). If each
// picked its own "when is this a lot?" the same session would read as fine on the board
// and as alarming in the rail - the exact drift `foremanAllowlisted` and `composeWrapup`
// live in `@shared` to prevent. So the threshold lives here and every surface asks.
//
// Deliberately NOT a session tone: `TONE_ORDER` drives grid sort, rail sections and board
// columns, and none of those should reorder by spend. This is a chip modifier only.

/** Where a session's spend sits, for the chip's colour and the rail's glyph. */
export type CostTone = "normal" | "attention" | "danger";

/**
 * Dollars at which one session's spend is worth noticing, and worth stopping at.
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

/** The tone for a spend figure. `null`/unpriced reads as `normal` - absence is not alarm. */
export function costTone(costUsd: number | null | undefined): CostTone {
  if (costUsd == null) return "normal";
  if (costUsd >= COST_DANGER_USD) return "danger";
  if (costUsd >= COST_ATTENTION_USD) return "attention";
  return "normal";
}

/**
 * Whether a session's spend has earned a place in a mark vocabulary.
 *
 * The rail is the surface this exists for: `RailRow` budgets itself two lines and a full
 * `$1.24` in `.rail-meta` costs horizontal room on the tightest surface in the app. So the
 * rail shows a glyph only once the number is notable, and the routine case stays invisible
 * there - a deliberate trade, and the one place cost is not on screen at all times.
 */
export function costIsNotable(cost: SessionCost | null | undefined): boolean {
  return costTone(cost?.costUsd) !== "normal";
}

/**
 * Agents whose spend we do not track, and why - rendered where a figure would be.
 *
 * Codex keeps a single `tokens_used` scalar in `~/.codex/state_5.sqlite`: no tier split,
 * no cost, no per-model breakdown. Pricing that to the same confidence as Claude's own
 * `cost.usage` counter is not possible, and showing a number with a different error bar
 * beside a Claude one is worse than showing none. Mirrors `GOAL_UNSUPPORTED`.
 */
export const COST_UNSUPPORTED: Record<AgentType, string | null> = {
  claude: null,
  codex: "Codex reports no cost telemetry",
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
 * `burnPerHour`: the dollar burn and the quota are different meters (a Max plan's dollars
 * are notional, and a cache-heavy hour is cheap in dollars and not in quota), so deriving
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
