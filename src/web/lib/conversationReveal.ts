import type { LayoutMode } from "@shared/protocol.ts";

/**
 * What the conversation chord has to DO, given where you are.
 *
 * The conversation is the one thing every layout shows and no two show the same way:
 * Cards has no tab strip at all and simply puts the transcript on the expanded card,
 * Console always has a detail whose strip may have been walked off to Files, and the
 * Board has both - an overview that draws no detail, and a drill-in that is a Console.
 * So "show me the conversation" is four different actions wearing one key.
 *
 * A PURE function rather than four branches inside App's keydown handler, for the reason
 * `schedules/policy.ts` gives on the server: a decision written inside the handler is one
 * no test can reach. This repo renders with `renderToStaticMarkup` and has no jsdom, so
 * nothing in `test/` can dispatch a keydown, mount App, or run an effect - a keyboard
 * behaviour left in the handler is testable only by grepping App.tsx for the strings it
 * happens to contain today, which pins spelling and not conduct. Here the whole decision
 * table is one call with no React, no DOM and no window in it, and `test/` can ask it
 * every question an operator can.
 *
 * `already` is a real answer and not a no-op: in Cards an expanded card is ALREADY
 * showing its transcript, and the chord must not toggle it shut. Reveal is the whole
 * contract - `expand` is the only branch that changes what is open, and it only ever
 * opens. The toggle belongs to its own chord.
 */
export type ConversationReveal =
  /** Cards: expand the selected card, where the transcript lives. */
  | "expand"
  /** Board overview: open the drill-in, which starts on the conversation. */
  | "drill-in"
  /** Console, or a board already drilled in: switch the tab strip back. */
  | "tab"
  /** It is on screen already. Do nothing - do NOT close it. */
  | "already"
  /** Not ours: no session is selected, so the chord goes unclaimed. */
  | "none";

export function conversationReveal(input: {
  layout: LayoutMode;
  /** Whether a session is selected at all. Every selection-group chord needs one. */
  hasSelection: boolean;
  /** Cards only: whether the SELECTED session is the one expanded in place. */
  selectedIsExpanded: boolean;
  /** Board only: whether the drill-in detail is open. */
  boardDetailOpen: boolean;
}): ConversationReveal {
  if (!input.hasSelection) return "none";
  switch (input.layout) {
    case "grid":
      return input.selectedIsExpanded ? "already" : "expand";
    case "board":
      // The overview draws no detail at all, so it has to open first - and it opens on
      // the conversation, which is why nothing further is asked of it.
      return input.boardDetailOpen ? "tab" : "drill-in";
    case "console":
      // The detail is permanent here; only the strip moves.
      return "tab";
  }
}
