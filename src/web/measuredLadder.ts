/**
 * The mechanism behind every responsive ladder in this app: which rungs are applied,
 * decided by MEASUREMENT rather than by a width.
 *
 * A ladder is a row of controls that must stay ONE row, plus an ordered list of rungs in
 * `styles.css` - each shedding the least useful ink first. This module owns the part that
 * is the same for every such row: put the row at rung 0, ask whether it wrapped, and step
 * down a rung at a time until it did not.
 *
 * WHY it measures instead of firing rungs from `@container (max-width: Npx)` is the whole
 * reason this file exists, and it generalizes past the bar it was found on: a rung fires
 * on the width the row HAS, and whether it needs to fire depends on the width its content
 * NEEDS - and those two are independent. The topbar's fleet pulse is sized by its own text
 * and swings 457px with the fleet, so thresholds measured against an idle bar left a busy
 * one wrapping continuously from a 1046px container up to 1844px. The console detail's tab
 * strip has the same shape of problem from a different direction: its launcher run carries
 * an agent's own name (`Claude Code`, `Codex`, `Pi`) and its Foreman slot swaps between
 * `＋ Invite foreman`, `Foreman intent` and `Foreman · 12`, so the same pane needs a
 * different rung for two sessions sitting side by side in the same rail.
 *
 * The full topbar measurements, which are what established this, are in `topbarLadder.ts`.
 *
 * Two rules bind every ladder built on this:
 *
 *  1. **The row must wrap.** `flex-wrap: wrap` is what the fit READS - it steps down only
 *     while the row is taller than its tallest child, so `nowrap` makes the ladder inert
 *     and the row overflows instead.
 *  2. **A shed label goes visually hidden, never `display: none`.** Out of flow so it costs
 *     no width and no flex gap, clipped so it paints nothing, and still in the accessibility
 *     tree - so the control keeps its accessible name and only its glyph is drawn.
 *     `display: none` turns a narrow row into unnamed icons, silently.
 */

/** One row's ladder, declared by the module that owns that row. */
export interface Ladder {
  /**
   * How many rungs `styles.css` defines for this row. Rung 0 is the full row.
   *
   * This number and the sheet have to mean the same thing: a rung the fit never reaches is
   * ink the row could have spent, and a step past the last rung frees nothing while the fit
   * reports the row unfittable. Each ladder's own source-scan test pins the agreement.
   */
  rungs: number;
  /**
   * The height the row settled at, for rows whose height other layout is sized against.
   * The topbar publishes `--topbar-h` here; a row nothing measures against omits it.
   */
  onSettle?: (height: number) => void;
  /** Undo whatever `onSettle` published, when the row stops being observed. */
  onRelease?: () => void;
}

/**
 * `data-rung` for each level, as the cumulative token list the CSS matches with `~=`.
 *
 * Cumulative because the rungs STACK: at level 3 the row has also shed rungs 1 and 2. The
 * `@container` ladder got that free - a bar narrower than 1270px is also narrower than 1600px,
 * so every wider rung was still matching. An attribute has to say so explicitly, and `~=`
 * against a token list is the way CSS spells "contains", since it cannot compare numbers.
 *
 * Cached per rung count rather than rebuilt per fit: the lists are pure functions of that
 * one number and the fit runs after every render of the surface that owns the row.
 */
const TOKENS = new Map<number, string[]>();

function rungTokens(rungs: number): string[] {
  let tokens = TOKENS.get(rungs);
  if (!tokens) {
    tokens = Array.from({ length: rungs + 1 }, (_, level) =>
      Array.from({ length: level }, (_, i) => String(i + 1)).join(" "),
    );
    TOKENS.set(rungs, tokens);
  }
  return tokens;
}

/**
 * A cheap signature of everything that can change the answer: how much room the row has, and
 * how much text it is carrying.
 *
 * A fit runs after every render of the component that owns the row, and those components
 * re-render on every server event. Without this the common case - a frame that moved a figure
 * the row does not show - would cost six forced layouts. `textContent` is deliberately not a
 * width: it ignores CSS, so it reads the same at every rung and cannot make the guard argue
 * with the fit it is guarding.
 */
function signature(row: HTMLElement, available: number): string {
  return `${available}|${row.textContent?.length ?? 0}`;
}

const lastFit = new WeakMap<HTMLElement, string>();

/**
 * The height each row last SETTLED at, which is how `observeLadder` tells its own work from
 * everyone else's without having to guess.
 */
const settledHeight = new WeakMap<HTMLElement, number>();

/**
 * Step the row down its ladder until its children sit on one row.
 *
 * At most `rungs + 1` layout reads, all inside a layout effect, so the browser never paints
 * an intermediate state.
 *
 * @param force Re-fit even when nothing the signature can see has changed. The caller passes
 *   this when the available width moved, which `textContent` cannot report.
 */
export function fitLadder(row: HTMLElement, ladder: Ladder, force = false): void {
  const style = getComputedStyle(row);
  const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  const sig = signature(row, Math.round(row.clientWidth - padX));
  if (!force && lastFit.get(row) === sig) return;
  lastFit.set(row, sig);

  const tokens = rungTokens(ladder.rungs);
  const kids = [...row.children] as HTMLElement[];
  /**
   * Wrapped iff the content box is taller than its tallest child. Measured rather than
   * compared against a constant, because the row's height is whatever the tallest control in
   * it happens to be, and every previous attempt to write that down as a number aged badly.
   * `clientHeight` excludes the bottom border and includes the padding, hence `- padY`. The
   * 2px is for sub-pixel layout only: a real second row costs the row-gap plus a whole
   * control, so there is no width at which this is a close call.
   */
  const wrapped = (): boolean =>
    row.clientHeight - padY > Math.max(0, ...kids.map((k) => k.offsetHeight)) + 2;

  let level = 0;
  row.dataset.rung = tokens[0]!;
  while (level < ladder.rungs && wrapped()) {
    level += 1;
    row.dataset.rung = tokens[level]!;
  }

  const height = row.offsetHeight;
  settledHeight.set(row, height);
  ladder.onSettle?.(height);
}

/**
 * Watch the row for the changes a render cannot report, and re-fit when one lands.
 *
 * Two things reach a row without going through React. Its available width moves when the
 * window does - and the ROW is watched rather than its parent, because a parent can stop
 * changing while the row keeps shrinking: in the default layout `.app` caps at 1400px, so
 * above that the topbar's parent is fixed while the desktop shell's traffic-light inset,
 * clamped against `100vw`, keeps eating into the bar for another 168px.
 *
 * The second is anything that resizes the row's CONTENT at a fixed width: a browser minimum
 * font size, a user stylesheet, a zoom that lands on different text metrics. This callback
 * used to treat every block-size-only notification as its own fit settling and skip the
 * re-fit, which was wrong in a way that stuck: a 16px minimum font size wraps the bar at a
 * width where it had been on one row, the notification arrives with the inline size unchanged,
 * the rung never steps down - and the render path cannot recover it either, because
 * `signature` keys on the available width and the text length and this trigger moves neither.
 * The bar stayed on two rows for the life of the page.
 *
 * So it is not inferred. `fitLadder` records the height it settled at, and any other height
 * means something outside the ladder resized the row and the ladder has to look again. That
 * cannot loop: the fit is deterministic for a given width and content, so the height it
 * settles at is the one the next notification reports, and the comparison stops there.
 */
export function observeLadder(row: HTMLElement, ladder: Ladder): () => void {
  let inline = -1;
  const ro = new ResizeObserver(([entry]) => {
    const next = entry?.contentBoxSize?.[0]?.inlineSize ?? row.clientWidth;
    if (next !== inline) {
      inline = next;
      fitLadder(row, ladder, true);
      return;
    }
    // Same width, different height. Forced, because the signature guard is blind to exactly
    // the change that got us here and would wave the re-fit straight through.
    if (row.offsetHeight !== settledHeight.get(row)) fitLadder(row, ladder, true);
  });
  ro.observe(row);
  return () => {
    ro.disconnect();
    ladder.onRelease?.();
  };
}
