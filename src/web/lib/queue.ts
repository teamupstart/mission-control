import type { WorkItem, WorkItemState } from "@shared/types.ts";

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
