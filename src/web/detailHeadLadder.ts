/**
 * The console detail header's responsive ladder.
 *
 * The MECHANISM is `measuredLadder.ts`, shared with the topbar (`topbarLadder.ts`) and the
 * tab strip below this row (`detailTabsLadder.ts`). What is specific to this row is how many
 * rungs it has, what each one gives up, and the one thing it never gives up.
 *
 * WHAT WAS WRONG. The header is `flex-wrap: wrap`, and it wrapped. Flex line-breaking places
 * items at their HYPOTHETICAL main size - the flex base size clamped by min/max - and the
 * identity block was `flex: 1 1 auto`, so its base size was the title's own max-content
 * width. A long session name therefore filled the first line by itself and pushed the whole
 * runtime cluster onto a second row: mode, model, effort, context, cost, all of it, at every
 * width, on any session whose name ran long. Only THEN did the shrinking pass run, which is
 * why the title in that state is both ellipsed and the reason the row is two rows deep.
 *
 * So the base size moved to zero with a floor under it (`.detail-title` in `styles.css`), and
 * the row got a ladder for the case that is left: the chips ALONE not fitting. Both halves are
 * needed. Without the floor the title would give up every pixel before the cost chip gave up
 * one, which is backwards - the name is what the pane is about. Without the ladder the row
 * would go straight back to wrapping the moment the chips outgrew the pane.
 *
 * THE ORDER, and each rung's reason:
 *
 *   1. The review button's KEYCAP and its `→`. A chord hint is not a control's name, the
 *      chord works at every width, and the arrow is decoration.
 *   2. Words drop to their marks: `Agent SDK` to `◈`, the effort level to `✦`, and the bind
 *      chip's name to `＋` (or `⌘` when it is armed). Every one of them keeps its mark, its
 *      tooltip and its accessible name; only the word goes.
 *   3. The context READOUT goes, its tinted meter stays. The bar still says how full the
 *      window is at a glance and the exact figure is on the tooltip.
 *   4. Cost and the context meter go. Both are ticking estimates rather than facts about what
 *      the session IS, and the board's card draws both.
 *   5. The model pill goes.
 *   6. The mode and effort pickers go - last of the things this row ALWAYS draws, because they
 *      are CONTROLS rather than readouts. Both are reachable on the board card, which mounts
 *      the same two shared leaves (`SessionTile`), and the mode is also cycled with ⇧⇥ in a
 *      session's own terminal.
 *   7. Everything left that is neither the session's identity nor a fixed width, which is the
 *      run of SITUATIONAL chips between the identity block and the review badge - a pull
 *      request, an Inspector verdict, a workflow run per repository, an ensemble, a pipeline
 *      commission, a pipeline link. Rungs 1 to 6 shed what the header ALWAYS draws, and a
 *      fixed set cannot answer a row whose width moves with what the session happens to be
 *      carrying: a conversation holding several of those chips exhausted the ladder and
 *      wrapped anyway, which is this change's own defect arriving through a different door.
 *      The rung is written as an ALLOWLIST in `styles.css` - hide every child except a named
 *      few - so a chip added to this header later is covered on the day it lands rather than
 *      reopening the hole. That rule says what stays and why.
 *
 * PAST RUNG 7 THE ROW'S REQUIREMENT IS A CONSTANT. Everything the allowlist keeps is either
 * the session's identity or a fixed width, so the deepest header measures the same on every
 * session - which is what turns "does this fit at the narrow widths the app is used at" from
 * a question about one fixture into a property of the row.
 *
 * WHAT NEVER GOES is the review button. It is the one control here that says an agent has
 * stopped dead waiting on a person, so the ladder is allowed to make it smaller (rung 1) and
 * never allowed to hide it. The bind chip keeps its `＋` at every rung for a narrower reason:
 * the console detail is the ONLY surface that offers it, so hiding it would remove the only
 * way to bind a workflow rather than move it somewhere else.
 *
 * Why measured rather than `@container`: the general reason is `measuredLadder.ts`'s - a rung
 * fires on the width the row HAS while whether it needs to fire depends on the width its
 * content NEEDS. This row makes that especially plain, because almost everything on it is
 * conditional on the session: the identity block carries the session's own name, and the
 * chips between it and the badge (pull request, Inspector, standing instructions, one per
 * workflow run, ensemble, pipeline commission, pipeline) are each drawn only when they have
 * something to say. Two sessions selected one after the other in the same rail need different
 * rungs at the same width. And a container query is not available here anyway: the
 * conversation pane's only `container-type` is on `.transcript`, which this row sits above.
 */
import { fitLadder, observeLadder, type Ladder } from "./measuredLadder.ts";

/** How many rungs `styles.css` defines for this row. Rung 0 is the full header. */
export const DETAIL_HEAD_RUNGS = 7;

/**
 * Nothing is sized against this row's height, so it publishes none - unlike the topbar, whose
 * `--topbar-h` every full-height surface reads. The header is one `flex: none` band inside
 * `.cdetail` and the reader below it takes whatever is left, which is precisely why a second
 * row here is worth a ladder: every pixel it takes comes off the conversation.
 */
const DETAIL_HEAD_LADDER: Ladder = { rungs: DETAIL_HEAD_RUNGS };

/** Step the header down its ladder until its controls sit on one row. */
export function fitDetailHead(row: HTMLElement, force = false): void {
  fitLadder(row, DETAIL_HEAD_LADDER, force);
}

/** Watch the header for the changes a render cannot report - see `observeLadder`. */
export function observeDetailHead(row: HTMLElement): () => void {
  return observeLadder(row, DETAIL_HEAD_LADDER);
}
