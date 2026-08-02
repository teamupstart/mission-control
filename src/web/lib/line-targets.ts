import type { LineStageId } from "@shared/line.ts";
import type { MissionRoute } from "../workflows/useWorkflowRoute.ts";
import { isLineDrawerStage, type LineDrawerStage } from "./line-drawer.ts";

/**
 * Where a Line stage sends you, in ONE place.
 *
 * The seam this file was cut for has now been used: three of the six stages open a DRAWER in
 * place rather than navigating away, and that change is entirely inside this table plus the
 * bodies the drawers render. The strip component still knows nothing about the router, and
 * still knows nothing about the drawers either - it reports a stage id and this decides.
 *
 * The remaining three navigate, and two of those are not routes at all (the Sitrep panel, the
 * fleet itself), which is why this stays a small union rather than a
 * `Record<LineStageId, MissionRoute>`.
 */
export type LineStageTarget =
  /** Navigate the mission router. */
  | { kind: "route"; route: MissionRoute }
  /** Open (or toggle, or swap to) this stage's drawer, between the strip and the board. */
  | { kind: "drawer"; stage: LineDrawerStage }
  /** Open the Sitrep panel. */
  | { kind: "sitrep" }
  /** Show the fleet itself, unfiltered. */
  | { kind: "fleet" };

export const LINE_STAGE_TARGETS: Record<LineStageId, LineStageTarget> = {
  // The Recurring Missions OVERLAY was this stage's target for one release, and the drawer
  // replaces it rather than sitting in front of it: a modal that covers the fleet is the
  // wrong shape for "is anything feeding the backlog broken", which is a question you ask
  // while looking at the board. The overlay is still where a mission is edited, and the
  // drawer's rows open it.
  intake: { kind: "drawer", stage: "intake" },
  // The Sitrep is where the backlog is read today: it lists every backlog item with its
  // blockers, which the board's Backlog column only shows in one of three layouts.
  backlog: { kind: "sitrep" },
  // Already the page under the strip. The click still does something worth having: it
  // clears the filter, so "5 working" and what is on the board agree again.
  working: { kind: "fleet" },
  review: { kind: "drawer", stage: "review" },
  decide: { kind: "drawer", stage: "decide" },
  // No PR list surface exists anywhere in the app - `prsToday` is a `COUNT` over the
  // Inspector's adoption ledger and nothing renders the rows. Completed runs are the
  // nearest true thing: it is the list of work that finished, which is what the count
  // beside it is about. The phase file left this to judgement; recorded in the README.
  shipped: {
    kind: "route",
    route: { page: "runs", filters: { status: "completed" } },
  },
};

/**
 * Whether this stage's button opens a drawer, for the strip's `aria-expanded`.
 *
 * Read off the table rather than off `LINE_DRAWER_STAGES` directly, so a stage retargeted
 * from a drawer to a route cannot keep announcing itself as expandable. The predicate is
 * what the strip imports; the table stays App's business.
 */
export function lineStageHasDrawer(stage: LineStageId): boolean {
  const target = LINE_STAGE_TARGETS[stage];
  return target.kind === "drawer" && isLineDrawerStage(target.stage);
}
