import type { ControlSpec } from "../types.ts";

// How a turn reaches Claude Code: typed into its pane, because that is the pane a human
// owns and we do not get to replace their process with a headless one.
//
// Both values here were measured against a real build rather than chosen, and they are
// the harness's properties rather than the daemon's - which is the whole reason they now
// live beside the harness instead of as constants in `actions.ts`.

/**
 * The window Claude coalesces input for after a multi-line paste - the same behaviour
 * that powers its "paste again to expand" affordance. An Enter that lands inside it is
 * absorbed into the paste instead of submitting, which is how every multi-line dispatch
 * once ended up pasted and sitting there.
 *
 * Measured against Claude Code 2.1.215: swallowed at 0/50/100/200ms, submitted at
 * 300/400/500ms. 400 sits a comfortable margin past the boundary while staying far under
 * the dispatch accept timeout. Do not lower it without re-measuring against the build
 * you are lowering it for.
 */
const SETTLE_MS = 400;

/**
 * Claude's collapsed-paste placeholder, as it appears in the composer:
 *
 *     ❯ [Pasted text #1 +3 lines]
 *
 * The number is the paste's index within the turn, so it climbs as pastes accumulate and
 * cannot be pinned to 1.
 *
 * This is the one honest on-screen answer to "did the Enter we sent actually submit?".
 * tmux reports that the bytes were written, never what the TUI did with them, and a pty
 * swallows an Enter as happily as it delivers one - so seeing this is what lets a retry
 * be gated on positive evidence rather than fired blind.
 *
 * When it appears is `COLLAPSES` below, and the two are one claim about this composer.
 */
const PASTED_PLACEHOLDER = /\[Pasted text #\d+/;

/**
 * Claude collapses a paste when the text carries a newline, and only then.
 *
 * The other half of the placeholder above, split out only because the delivery path asks
 * the two at different moments - so they have to move together. A long single-line paste
 * is echoed in full: nothing collapses, nothing can be watched leaving the composer, and
 * that delivery honestly reports unverified rather than being confirmed by a screen that
 * never showed anything. A single-line paste is also never caught by the coalescing
 * window `SETTLE_MS` covers, so it has nothing to be verified against in the first place.
 */
const COLLAPSES = (text: string): boolean => text.includes("\n");

export const claudeControl: ControlSpec = {
  kind: "keystroke",
  settleMs: SETTLE_MS,
  pastePlaceholder: PASTED_PLACEHOLDER,
  collapses: COLLAPSES,
};
