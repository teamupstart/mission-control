import type { LayoutMode } from "@shared/protocol.ts";

/**
 * What the conversation chord has to DO, given where you are.
 *
 * Console always has a detail whose strip may have been walked off to Files. Board has
 * both an overview that draws no detail and a drill-in that is a Console. So "show me the
 * conversation" either opens that drill-in or returns its tab strip to Conversation.
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
 */
export type ConversationReveal =
  /** Board overview: open the drill-in, which starts on the conversation. */
  | "drill-in"
  /** Console, or a board already drilled in: switch the tab strip back. */
  | "tab"
  /** Not ours: no session is selected, so the chord goes unclaimed. */
  | "none";

export function conversationReveal(input: {
  layout: LayoutMode;
  /** Whether a session is selected at all. Every selection-group chord needs one. */
  hasSelection: boolean;
  /** Board only: whether the drill-in detail is open. */
  boardDetailOpen: boolean;
}): ConversationReveal {
  if (!input.hasSelection) return "none";
  switch (input.layout) {
    case "board":
      // The overview draws no detail at all, so it has to open first - and it opens on
      // the conversation, which is why nothing further is asked of it.
      return input.boardDetailOpen ? "tab" : "drill-in";
    case "console":
      // The detail is permanent here; only the strip moves.
      return "tab";
  }
}
