// The session detail's tab table.
//
// A pure function rather than a literal inside ConsoleDetail for the reason
// `conversationReveal` is one: three separate things read this order and none of them can
// see the others. The strip renders it left to right, Tab/Shift+Tab step through it, and
// each tab prints the keycap of the chord that also reveals it - so a tab added to the
// render but forgotten in the stepper is a tab the keyboard walks past, and a chord that
// no tab claims is a shortcut with nothing to reveal. Keeping the table in one exported
// value makes all three the same list, and makes the list itself testable without a DOM
// (this repo renders with `renderToStaticMarkup` and has no jsdom, so nothing in test/ can
// click a tab or dispatch a keydown).

import type { ActionId } from "./keybindings.ts";

export type DetailTabId = "conversation" | "queue" | "workflows" | "diff" | "files";

export interface DetailTab {
  id: DetailTabId;
  label: string;
  /** Attention count on the tab's face; 0 draws no pip. */
  pip: number;
  /**
   * The rebindable chord that also reveals this tab, printed on its face when keybinding
   * hints are on. Required, not optional: Gate used to be the one tab with no chord, so
   * the only way to it was the mouse or walking the whole strip. Workflows, which absorbed
   * it, carries one.
   */
  action: ActionId;
}

export interface DetailTabInputs {
  /** Open items in the session's work queue. */
  queueCount: number;
  /**
   * Agent replies to line comments that nobody has read yet.
   *
   * Deliberately not the review's queue depth: the comments still waiting to go out are the
   * human's own work, and a pip counting those would light up as they typed them. This counts
   * what arrived while they were on another tab, and expanding the thread clears it.
   */
  fileReplyCount: number;
}

/**
 * The tabs, in the order the strip draws them and the keyboard walks them.
 *
 * Workflows sits between Work queue and Diff because it answers "how is this run going",
 * which is the question you ask right after "what is it about to do" and before you go
 * read the change itself.
 */
export function detailTabs({ queueCount, fileReplyCount }: DetailTabInputs): DetailTab[] {
  return [
    { id: "conversation", label: "Conversation", pip: 0, action: "conversation" },
    { id: "queue", label: "Work queue", pip: queueCount, action: "queue" },
    { id: "workflows", label: "Workflows", pip: 0, action: "sessionWorkflows" },
    { id: "diff", label: "Diff", pip: 0, action: "diff" },
    { id: "files", label: "Files", pip: fileReplyCount, action: "files" },
  ];
}
