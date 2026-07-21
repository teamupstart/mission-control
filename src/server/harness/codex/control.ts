import type { ControlSpec } from "../types.ts";

// How a turn reaches Codex: typed into its pane, like Claude - but with no way to read
// back whether it landed.
//
// Codex renders no collapsed-paste placeholder. Nothing appears in its composer that
// distinguishes "the Enter submitted" from "the Enter was swallowed", so `pastePlaceholder`
// is null and submit verification has no evidence to wait on for this harness.
//
// That null is the point of declaring it. Until this capability existed the placeholder
// was one module-level regex applied to every agent, so for Codex the check simply never
// matched: `hasPendingPaste` was permanently false, the retry loop had nothing to gate on,
// and one Enter was reported as a confirmed submit having proved nothing at all. A wrong
// answer no caller could tell from a right one. Now the absence is a value the delivery
// path reads and degrades on deliberately - see `awaitPasteSubmitted`.
//
// The settle window is Claude's measurement, kept because it is what the code has always
// applied here and this migration changes no behaviour. It is NOT a Codex measurement:
// nobody has established whether Codex coalesces input at all, so treat it as an
// unverified inheritance rather than a fact about this harness, and measure before
// trusting it. Erring long costs 400ms per dispatch; erring short loses the prompt.

/** Inherited from Claude's measurement, not measured against Codex. See above. */
const SETTLE_MS = 400;

/**
 * Codex collapses nothing, which is `pastePlaceholder: null` said again at the other point
 * the delivery path asks about this composer.
 *
 * One fact, stated twice because it is needed twice, and the two must not drift: a harness
 * that claimed to collapse something while declaring no placeholder would have the
 * delivery path spend a pane read hunting for a thing it has already been told does not
 * exist.
 */
const COLLAPSES = (): boolean => false;

export const codexControl: ControlSpec = {
  kind: "keystroke",
  settleMs: SETTLE_MS,
  pastePlaceholder: null,
  collapses: COLLAPSES,
};
