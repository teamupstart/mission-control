/**
 * The console detail tab strip's responsive ladder.
 *
 * The MECHANISM is `measuredLadder.ts`, shared with the topbar. What is specific to this row
 * is how many rungs it has and why it needs them at all.
 *
 * The strip used to be five tabs and Foreman, with dead space after "Files". It now also
 * hosts the conversation's toolbar - the Terminal-view toggle and the two launchers - which
 * moved here so the worktree band above the transcript could stop existing and give its
 * height back to the conversation (`docs/plans/console-header-density/plan.md`). Measured in
 * the design mockup at an 848px pane, that made the row overflow by 101px.
 *
 * A `@container` query cannot answer this, and not merely by convention: `.detail-tabs`
 * declares no container and no ancestor does either - the pane's one container is
 * `container-type: inline-size` on `.transcript`, which this row sits above rather than
 * inside. Even given one it would key on the wrong quantity, exactly as the topbar's did.
 * This row's content moves with the SESSION, not with the layout:
 *
 *   - the agent launcher carries the harness's own name, so `Codex` and `Claude Code` are
 *     ~50px apart on the same pane;
 *   - the Foreman slot is `＋ Invite foreman`, `Foreman intent` or `Foreman · 12` depending
 *     on a field that arrives over SSE;
 *   - the Work queue tab grows a count pip when the queue has anything in it.
 *
 * So two sessions selected one after the other in the same rail need different rungs at the
 * same width, and a threshold measured against either one is wrong about the other.
 *
 * The rungs, in the order they fire - least useful ink first, and never a tab's own word:
 *
 *   1. The tabs give up their KEYCAPS. A keycap is a hint about a chord that works at every
 *      width, not a control's name.
 *   2. The Terminal-view toggle drops to its glyph. It is the one control in the run that
 *      acts on the pane you are already looking at, and its state is carried by
 *      `aria-pressed`, its accent and its override dot rather than by the word.
 *   3. The two launchers drop to their glyphs, giving up their keycaps and carets with the
 *      word - a keycap floating beside a bare glyph reads as a second glyph. The chords
 *      still work and the tooltips still name what each button opens.
 *   4. Foreman drops to its mark. The rail keeps the purple dot, the attention state, its
 *      tooltip and its accessible name; only the word goes.
 *
 * Rung 1 is the one place this ladder departs from the order proposed in
 * `docs/plans/console-header-density/phase-3-tabs-are-the-toolbar.md`, which had the
 * launcher labels going first and the tab keycaps not in its model at all. It was moved on
 * a measurement: the full row needs ~1002px and a 1280px window gives this pane ~940px, so
 * exactly one rung fires at the width the console is most often read at - and spending five
 * chord hints there keeps the NAMES on three buttons that the proposed order would have
 * collapsed to bare glyphs. The governing rule is unchanged and is what decided it: shed the
 * least useful ink first.
 */
import { fitLadder, observeLadder, type Ladder } from "./measuredLadder.ts";

/** How many rungs `styles.css` defines for this row. Rung 0 is the full strip. */
export const DETAIL_TAB_RUNGS = 4;

/**
 * Nothing is sized against this row's height, so it publishes none - unlike the topbar,
 * whose `--topbar-h` every full-height surface reads. The strip is one `flex: none` band
 * inside `.cdetail`, and the reader pane below it takes whatever is left.
 */
const DETAIL_TABS_LADDER: Ladder = { rungs: DETAIL_TAB_RUNGS };

/** Step the tab strip down its ladder until its controls sit on one row. */
export function fitDetailTabs(row: HTMLElement, force = false): void {
  fitLadder(row, DETAIL_TABS_LADDER, force);
}

/** Watch the strip for the changes a render cannot report - see `observeLadder`. */
export function observeDetailTabs(row: HTMLElement): () => void {
  return observeLadder(row, DETAIL_TABS_LADDER);
}
