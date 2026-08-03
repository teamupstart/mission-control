import type { LineStageId } from "@shared/line.ts";
import type { MissionRoute } from "../workflows/useWorkflowRoute.ts";
import { isLineDrawerStage, type LineDrawerStage } from "./line-drawer.ts";

/**
 * Where a Line stage sends you, in ONE place.
 *
 * The seam this file was cut for has now been used three times: five of the six stages open a
 * DRAWER in place rather than navigating away, and every one of those changes was entirely
 * inside this table plus the body the drawer renders. The strip component still knows nothing
 * about the router, and still knows nothing about the drawers either - it reports a stage id
 * and this decides.
 *
 * The union keeps two arms the table currently holds no member of - `route` and `sitrep` -
 * and that is deliberate rather than dead weight. Both name a KIND of destination the
 * dashboard really has, and a stage retargeted at either is a one-line edit here instead of a
 * re-widened type plus a new `case` in App's handler. This is also why it stays a small union
 * rather than a `Record<LineStageId, MissionRoute>`: not every destination is a route.
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
  // The Sitrep was this stage's target while nothing in the app rendered the queue itself,
  // and it answers a wider question than the one being asked: it is a whole-fleet report -
  // who needs you, who is working, what is idle - that happens to carry a backlog section.
  // The stage's own sentence promises what autopilot would take next, so the click now lands
  // on THAT: the queue in plan order, with the triage moves on each row. The fleet read is
  // still one click away, from the drawer's footer.
  backlog: { kind: "drawer", stage: "backlog" },
  // Already the page under the strip. The click still does something worth having: it
  // clears the filter, so "5 working" and what is on the board agree again.
  working: { kind: "fleet" },
  review: { kind: "drawer", stage: "review" },
  decide: { kind: "drawer", stage: "decide" },
  // The completed workflow runs were this stage's target while nothing in the app rendered
  // the adoption ledger, and they were wrong in both directions: a session ships code
  // without ever starting a run, and a finished run guarantees no code shipped. The count
  // on the strip is a `COUNT` over `inspector_prs.adopted_at`, so the click now lands on
  // THOSE rows - the drawer for the week's glance, escalating to `#/shipped` for the
  // cross-repo account.
  shipped: { kind: "drawer", stage: "shipped" },
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
