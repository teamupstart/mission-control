import type { SessionQueueSummary, WorkItem, WorkItemState } from "@shared/types.ts";

// The work-queue panel's pure presentation logic, kept out of the component so it
// can be tested without a DOM - the same split `src/web/lib/diff.ts` and
// `alerts.ts` already use. What's here answers "what does this item say?" and
// "where would this item move to?"; WorkQueue.tsx renders the answers.

/** Labels for what Foreman is doing to the in-flight item. */
export const STATE_LABEL: Record<WorkItemState, string> = {
  queued: "waiting",
  proposed: "drafted - needs your OK",
  sending: "delivering…",
  awaiting_pickup: "delivered, waiting for the agent",
  in_progress: "working",
  verifying: "checking the work",
  verified: "done",
  escalated: "needs you",
  cancelled: "cancelled",
};

/** True while an item can still be edited/removed - i.e. Foreman hasn't typed it. */
export function isWaiting(state: WorkItemState): boolean {
  return state === "queued" || state === "proposed";
}

export function isTerminal(state: WorkItemState): boolean {
  return state === "verified" || state === "escalated" || state === "cancelled";
}

/**
 * What the card says about an item - which is its state AND the human's consent, two
 * separate facts.
 *
 * Reading only `state`, an approved draft kept demanding an OK while the button that
 * would give one was already gone (Approve is gated on `!approvedAt`), with nothing
 * to show the click had registered. That's a long silence, not a blink: the worker
 * picks it up on its next tick, which is IDLE_MS away at best and behind a serial
 * pass that can block minutes on a `claude -p`.
 */
export function itemLabel(item: WorkItem): string {
  if (item.state === "proposed" && item.approvedAt) return "approved - Foreman will send it";
  return STATE_LABEL[item.state];
}

/**
 * Where a one-place move would land `item`, or -1 when there is nowhere to go.
 *
 * Steps to the nearest other WAITING row rather than the adjacent one, which is the
 * same rule the drop handler enforces: a waiting item renumbered in among the
 * completed work doesn't change delivery order (`nextSendable` skips terminal items)
 * but does break the "in the order you authored it" contract the panel is built on.
 * Shared by the move buttons (to know whether to offer the move) and by the handler
 * that makes it.
 */
export function moveTarget(items: WorkItem[], item: WorkItem, dir: -1 | 1): number {
  const from = items.findIndex((i) => i.id === item.id);
  if (from < 0) return -1;
  let to = from + dir;
  while (to >= 0 && to < items.length && !isWaiting(items[to]!.state)) to += dir;
  return to >= 0 && to < items.length ? to : -1;
}

/** What the card's queue chip says on its face, and whether it needs your eye. */
export interface QueueChipView {
  label: string;
  title: string;
  /** Something in this batch stopped short and is waiting on a human. */
  attention: boolean;
}

/**
 * The chip's label and tone, from the counts the card summary already carries.
 *
 * The one rule here: an item that Foreman GAVE UP on may never hide behind a count
 * that reads as success. `openCount` excludes every terminal state, and `escalated`
 * is terminal (see TERMINAL_ITEM_STATES) - so "all the work is through" and "all the
 * work landed" are different facts, and a chip saying only the first is claiming the
 * second. That matters most on a session that has exited: it has no ActionBar, so no
 * Queue button, which makes this chip the last thing left pointing at what the batch
 * actually did.
 *
 * `done` is derived rather than read, because the summary carries no verified count -
 * only what's open and what escalated. Deriving it (rather than plumbing a new count
 * through the server) is honest today because `cancelled` is declared but unreachable:
 * nothing transitions an item into it, so terminal-and-not-escalated IS verified. If
 * that ever changes, this is the line that has to learn the difference.
 */
export function queueChipView(q: SessionQueueSummary): QueueChipView {
  const escalated = q.escalatedCount;
  const done = q.totalCount - q.openCount - escalated;
  const parts: string[] = [];
  if (q.openCount > 0) parts.push(`${q.openCount} queued`);
  else if (done > 0) parts.push(`${done} done`);
  if (escalated > 0) parts.push(`${escalated} escalated`);
  return {
    label: parts.join(" · "),
    title: chipTitle(q, escalated),
    attention: escalated > 0,
  };
}

function chipTitle(q: SessionQueueSummary, escalated: number): string {
  if (q.inFlightIntent) {
    return `Foreman is working through this session's queue: ${q.inFlightIntent}`;
  }
  if (escalated > 0) {
    const them = escalated === 1 ? "it" : "them";
    return `Foreman escalated ${escalated} of this session's ${q.totalCount} queued ${
      q.totalCount === 1 ? "item" : "items"
    } and needs you - click to read ${them}`;
  }
  if (q.openCount > 0) return "Work queued for this session - click to see it";
  return "This session's queued work is all through - click to read it";
}
