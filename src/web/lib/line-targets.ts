import type { LineStageId } from "@shared/line.ts";
import type { MissionRoute } from "../workflows/useWorkflowRoute.ts";

/**
 * Where a Line stage sends you, in ONE place.
 *
 * This map is the seam the next phase cuts along: stages will open drawers in place rather
 * than navigating away, and when they do, only this file changes. Spreading six `onClick`s
 * through the strip component would spread that edit through the markup too, and the
 * component would end up knowing about the router.
 *
 * Every target below is a surface that ALREADY EXISTS. Two of the six are not routes at all
 * (the Missions overlay, the Sitrep panel), which is itself the argument for a small union
 * rather than a `Record<LineStageId, MissionRoute>`: the honest answer for Intake today is
 * an overlay, and forcing it into a route would have meant inventing one this phase is not
 * allowed to add.
 */
export type LineStageTarget =
  /** Navigate the mission router. */
  | { kind: "route"; route: MissionRoute }
  /** Open the Recurring Missions overlay. */
  | { kind: "missions" }
  /** Open the Sitrep panel. */
  | { kind: "sitrep" }
  /** Show the fleet itself, unfiltered. */
  | { kind: "fleet" };

export const LINE_STAGE_TARGETS: Record<LineStageId, LineStageTarget> = {
  // Recurring Missions rather than Settings → Task sources, though the stage folds both.
  // Missions is the live surface - it has run history and health, and it is reachable
  // without leaving the fleet - where the sources panel is configuration. Between "watch
  // the thing that is running" and "edit the thing that configures it", a stage click on a
  // live strip means the first.
  intake: { kind: "missions" },
  // The Sitrep is where the backlog is read today: it lists every backlog item with its
  // blockers, which the board's Backlog column only shows in one of three layouts.
  backlog: { kind: "sitrep" },
  // Already the page under the strip. The click still does something worth having: it
  // clears the filter, so "5 working" and what is on the board agree again.
  working: { kind: "fleet" },
  review: { kind: "route", route: { page: "workflows", tab: "runs" } },
  decide: { kind: "route", route: { page: "workflows", tab: "ensembles" } },
  // No PR list surface exists anywhere in the app - `prsToday` is a `COUNT` over the
  // Inspector's adoption ledger and nothing renders the rows. Completed runs are the
  // nearest true thing: it is the list of work that finished, which is what the count
  // beside it is about. The phase file left this to judgement; recorded in the README.
  shipped: {
    kind: "route",
    route: { page: "workflows", tab: "runs", filters: { status: "completed" } },
  },
};
