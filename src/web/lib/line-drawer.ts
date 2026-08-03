import type { LineStageId } from "@shared/line.ts";

/**
 * Which stage's drawer is open, as pure state.
 *
 * A three-line reducer in a file of its own, because the three lines ARE the feature. The
 * operator's mental model of the strip is a set of toggles that behave like one radio group:
 * the same stage twice closes, a different stage swaps in place without a close-then-open
 * flicker, and nothing else changes what is showing. Every one of those is a claim about a
 * transition, and a transition spelled inline in an `onClick` can only be checked by driving
 * a browser through it.
 *
 * It also keeps App's handler honest about the thing that is easy to get wrong: `openDrawer`
 * is a REPLACE, not a merge. There is exactly one drawer, which is what makes "hard-capped
 * at three rows" a statement about the page and not just about one panel.
 */

/**
 * The stages that own a drawer, and therefore the ones whose buttons are `aria-expanded`.
 *
 * Five of six, in strip order, and the sixth navigates instead: Working shows the board
 * under the strip. That split is not a staging post: a drawer is worth its space only where
 * triage means comparing several rows against each other, and "show me the board I am
 * already looking at" is not that.
 *
 * Two stages have crossed over, and both crossings are the same argument. Shipped pointed at
 * the completed workflow runs because no surface rendered the rows its count is actually made
 * of, and that target was wrong in both directions - a session ships without ever starting a
 * run, and a finished run ships nothing. Backlog pointed at the SITREP, which reads the whole
 * fleet: a panel that answers "how is everything" is not the answer to "what is queued, in
 * what order, and what can I do about it". Both counts now land on their own rows, and both
 * keep their wider read one click further out - `#/shipped` for the cross-repo ledger, the
 * Sitrep for the fleet.
 */
export const LINE_DRAWER_STAGES = ["intake", "backlog", "review", "decide", "shipped"] as const;
export type LineDrawerStage = (typeof LINE_DRAWER_STAGES)[number];

export function isLineDrawerStage(stage: LineStageId): stage is LineDrawerStage {
  return (LINE_DRAWER_STAGES as readonly LineStageId[]).includes(stage);
}

/**
 * What clicking `clicked` does to a strip whose open drawer is `open`.
 *
 * Toggle on the same stage, swap on a different one. Returns the next open stage, or null
 * for closed - never a partial update, so a caller cannot leave two drawers believing they
 * are showing.
 */
export function nextLineDrawer(
  open: LineDrawerStage | null,
  clicked: LineDrawerStage,
): LineDrawerStage | null {
  return open === clicked ? null : clicked;
}
