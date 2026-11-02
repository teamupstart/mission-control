import type { FleetCost } from "@shared/types.ts";
import type { ForemanState } from "../useForeman.ts";

/**
 * The fleet the Top bar panel's preview draws.
 *
 * The panel mounts the REAL `Topbar` against these rather than a drawing of one, for the
 * reason `board-card-preview.ts` gives for the card: a drawing would be a second source of
 * truth for the thing being configured.
 *
 * The one hard constraint: every optional item in `lib/topbar-items.ts` must have something to
 * draw. A count of zero renders no segment whether its checkbox is on or not, and an empty
 * spend record renders no chip, which would read as a broken checkbox rather than an idle
 * fleet. `test/topbar-items.test.ts` holds this to account.
 */
export const PREVIEW_TOPBAR_FLEET = {
  sessions: 4,
  attention: 1,
  working: 2,
  inbox: 1,
} as const;

/** A priced day, so the cost estimate is on the bar with both of its figures. */
export function previewFleetCost(now: number): FleetCost {
  return {
    estimatedCostToday: 18.4,
    estimatedBurnPerHour: 2.1,
    tokensToday: 1_240_000,
    prsToday: 2,
    rateLimits: null,
    automation: { estimatedCostToday: 0, tokensToday: 0, roles: [] },
    updatedAt: now,
  };
}

/** Foreman before its first poll: the control draws its dot, its word and an `off` chip. */
export const PREVIEW_FOREMAN: ForemanState = {
  config: null,
  status: null,
  backlogPlan: null,
  episodes: [],
  update: async () => false,
  refresh: async () => {},
  error: null,
};
