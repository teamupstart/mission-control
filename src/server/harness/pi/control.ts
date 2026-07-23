import type { ControlSpec } from "../types.ts";

// How a turn reaches Pi: typed into its pane, like Claude and Codex.
//
// pi's composer renders no collapsed-paste placeholder - verified live, a multi-line paste
// arrives expanded in the editor, and the package carries no `[Pasted text #N]` equivalent -
// so `pastePlaceholder` is null: submit verification has no on-screen evidence to wait on,
// spends exactly one Enter, and reports `submitVerified: false` rather than claiming a
// confirmed submit it never saw. Same posture as Codex, and for the same measured reason.
//
// The settle window is Claude's measurement, inherited because it is the value this code has
// always applied and this is not the place to change a timing. It is NOT a pi measurement:
// nobody has established whether pi coalesces input after a paste, so treat it as an
// unverified inheritance. Erring long costs 400ms per dispatch; erring short loses the prompt.

/** Inherited from Claude's measurement, not measured against pi. See above. */
const SETTLE_MS = 400;

/**
 * pi collapses nothing, which is `pastePlaceholder: null` said again at the other point the
 * delivery path asks about this composer. The two must not drift: a harness that claimed to
 * collapse something while declaring no placeholder would send the delivery path hunting a
 * pane for a thing it has already been told does not exist.
 */
const COLLAPSES = (): boolean => false;

export const piControl: ControlSpec = {
  kind: "keystroke",
  settleMs: SETTLE_MS,
  pastePlaceholder: null,
  collapses: COLLAPSES,
};
