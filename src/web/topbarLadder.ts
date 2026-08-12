/**
 * The topbar's responsive ladder.
 *
 * The MECHANISM is `measuredLadder.ts` - and it is shared, because the console detail's tab
 * strip needs the same thing (`detailTabsLadder.ts`). What is topbar-specific is this file:
 * how many rungs the bar has, and the height it publishes for everything beneath it.
 *
 * The five rungs themselves live in `styles.css`, each shedding the least useful ink first,
 * so the bar stays ONE row instead of wrapping into two or three.
 *
 * The rungs used to fire from `@container topbar (max-width: Npx)`, against five widths that
 * had been measured by sweeping every integer width. That is the right methodology and it
 * still produced a bar that wrapped, because it keys on the wrong quantity: a rung fires on
 * the width the bar HAS, and whether it needs to fire depends on the width its content
 * NEEDS - and those two are independent. The fleet pulse is sized by its own text, and its
 * segments are conditional on the fleet: `live · 0 sessions` is 165px, and
 * `live · 4 sessions · 3 need you · 2 working · 5 to answer` is 622px. Every state inherits
 * that swing, so the bar's requirement moves 457px while the thresholds do not move at all:
 *
 *     content needed          full   after r1  after r2  after r3  after r4
 *     idle (2 segments)       1558     1360      1221      1067      830
 *     busy (5 segments)       2015     1817      1679      1525     1287
 *     rung fired at at         --      1600      1410      1270     1115
 *
 * The thresholds were measured against the idle row - the only one where they all fit. On
 * the busy row every state overflows the top of its band, so the bar wrapped continuously
 * from a 1046px container all the way up to 1844px. No set of five constants fixes that:
 * tuned for the busy row they would pin an idle bar to unlabelled glyphs at every width, and
 * the fleet page caps its container at ~1344px, so the two widest rungs are already always on
 * there. The quantity that decides is "does the content fit", and that is measurable.
 *
 * So it is measured. `fitTopbar` puts the bar at rung 0, asks whether it wrapped, and steps
 * down a rung at a time until it did not. At most six layout reads, all inside a layout
 * effect, so the browser never paints an intermediate state. It is correct at every width,
 * on every fleet, in all three layouts and behind the desktop shell's traffic-light inset -
 * none of which it has to know anything about.
 */
import { fitLadder, observeLadder, type Ladder } from "./measuredLadder.ts";

/** How many rungs `styles.css` defines. Rung 0 is the full bar. */
export const TOPBAR_RUNGS = 5;

/**
 * The bar's settled height, published as `--topbar-h`.
 *
 * That height is why wrapping is worth this much trouble rather than being left as a cosmetic
 * nit: every full-height surface sizes itself against `--topbar-h`, so a bar that sprawls to
 * a second row takes 45px off the conversation under it.
 */
const TOPBAR_LADDER: Ladder = {
  rungs: TOPBAR_RUNGS,
  onSettle: (height) => document.documentElement.style.setProperty("--topbar-h", `${height}px`),
  onRelease: () => document.documentElement.style.removeProperty("--topbar-h"),
};

/** Step the bar down its ladder until its children sit on one row. */
export function fitTopbar(bar: HTMLElement, force = false): void {
  fitLadder(bar, TOPBAR_LADDER, force);
}

/** Watch the bar for the changes a render cannot report - see `observeLadder`. */
export function observeTopbar(bar: HTMLElement): () => void {
  return observeLadder(bar, TOPBAR_LADDER);
}
