/**
 * The topbar's responsive ladder: which rungs are applied, decided by MEASUREMENT.
 *
 * The five rungs themselves live in `styles.css` and are unchanged - each still sheds the
 * least useful ink first, so the bar stays ONE row instead of wrapping into two or three.
 * What changed is the trigger.
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

/** How many rungs `styles.css` defines. Rung 0 is the full bar. */
export const TOPBAR_RUNGS = 5;

/**
 * `data-rung` for each level, as the cumulative token list the CSS matches with `~=`.
 *
 * Cumulative because the rungs STACK: at level 3 the bar has also shed rungs 1 and 2. The
 * `@container` ladder got that free - a bar narrower than 1270px is also narrower than 1600px,
 * so every wider rung was still matching. An attribute has to say so explicitly, and `~=`
 * against a token list is the way CSS spells "contains", since it cannot compare numbers.
 */
const RUNG_TOKENS: string[] = Array.from({ length: TOPBAR_RUNGS + 1 }, (_, level) =>
  Array.from({ length: level }, (_, i) => String(i + 1)).join(" "),
);

/**
 * A cheap signature of everything that can change the answer: how much room the bar has, and
 * how much text it is carrying.
 *
 * `fitTopbar` runs after every render of App, which re-renders on every server event. Without
 * this the common case - a frame that moved a figure the bar does not show - would cost six
 * forced layouts. `textContent` is deliberately not a width: it ignores CSS, so it reads the
 * same at every rung and cannot make the guard argue with the fit it is guarding.
 */
function signature(bar: HTMLElement, available: number): string {
  return `${available}|${bar.textContent?.length ?? 0}`;
}

const lastFit = new WeakMap<HTMLElement, string>();

/**
 * The height each bar last SETTLED at, which is how `observeTopbar` tells its own work from
 * everyone else's without having to guess.
 */
const settledHeight = new WeakMap<HTMLElement, number>();

/**
 * Step the bar down its ladder until its children sit on one row, and publish the height it
 * settled at as `--topbar-h`.
 *
 * That height is why wrapping is worth this much trouble rather than being left as a cosmetic
 * nit: every full-height surface sizes itself against `--topbar-h`, so a bar that sprawls to
 * a second row takes 45px off the conversation under it.
 *
 * @param force Re-fit even when nothing the signature can see has changed. The caller passes
 *   this when the available width moved, which `textContent` cannot report.
 */
export function fitTopbar(bar: HTMLElement, force = false): void {
  const style = getComputedStyle(bar);
  const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  const sig = signature(bar, Math.round(bar.clientWidth - padX));
  if (!force && lastFit.get(bar) === sig) return;
  lastFit.set(bar, sig);

  const kids = [...bar.children] as HTMLElement[];
  /**
   * Wrapped iff the content box is taller than its tallest child. Measured rather than
   * compared against a constant, because the row's height is whatever the tallest control in
   * it happens to be, and every previous attempt to write that down as a number aged badly.
   * `clientHeight` excludes the bottom border and includes the padding, hence `- padY`. The
   * 2px is for sub-pixel layout only: a real second row costs the 12px row-gap plus a ~30px
   * control, so there is no width at which this is a close call.
   */
  const wrapped = (): boolean =>
    bar.clientHeight - padY > Math.max(0, ...kids.map((k) => k.offsetHeight)) + 2;

  let level = 0;
  bar.dataset.rung = RUNG_TOKENS[0]!;
  while (level < TOPBAR_RUNGS && wrapped()) {
    level += 1;
    bar.dataset.rung = RUNG_TOKENS[level]!;
  }

  const height = bar.offsetHeight;
  settledHeight.set(bar, height);
  document.documentElement.style.setProperty("--topbar-h", `${height}px`);
}

/**
 * Watch the bar for the changes a render cannot report, and re-fit when one lands.
 *
 * Two things reach the bar without going through React. Its available width moves when the
 * window does - and the bar is watched rather than its parent, because in the default layout
 * `.app` caps at 1400px, so above that the parent stops changing while the desktop shell's
 * traffic-light inset, clamped against `100vw`, keeps eating into the bar for another 168px.
 *
 * The second is anything that resizes the bar's CONTENT at a fixed width: a browser minimum
 * font size, a user stylesheet, a zoom that lands on different text metrics. This callback
 * used to treat every block-size-only notification as its own fit settling and skip the
 * re-fit, which was wrong in a way that stuck: a 16px minimum font size wraps the bar at a
 * width where it had been on one row, the notification arrives with the inline size unchanged,
 * the rung never steps down - and the render path cannot recover it either, because
 * `signature` keys on the available width and the text length and this trigger moves neither.
 * The bar stayed on two rows for the life of the page.
 *
 * So it is not inferred. `fitTopbar` records the height it settled at, and any other height
 * means something outside the ladder resized the bar and the ladder has to look again. That
 * cannot loop: the fit is deterministic for a given width and content, so the height it
 * settles at is the one the next notification reports, and the comparison stops there.
 */
export function observeTopbar(bar: HTMLElement): () => void {
  let inline = -1;
  const ro = new ResizeObserver(([entry]) => {
    const next = entry?.contentBoxSize?.[0]?.inlineSize ?? bar.clientWidth;
    if (next !== inline) {
      inline = next;
      fitTopbar(bar, true);
      return;
    }
    // Same width, different height. Forced, because the signature guard is blind to exactly
    // the change that got us here and would wave the re-fit straight through.
    if (bar.offsetHeight !== settledHeight.get(bar)) fitTopbar(bar, true);
  });
  ro.observe(bar);
  return () => {
    ro.disconnect();
    document.documentElement.style.removeProperty("--topbar-h");
  };
}
