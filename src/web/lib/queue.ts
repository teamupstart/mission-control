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
  /** Something in this batch ended without landing, so it's owed a human's eye. */
  attention: boolean;
}

/**
 * An outstanding wrap-up question: raised, and not yet sent or dismissed.
 *
 * Both halves are required. `wrapupAskedAt` is never cleared - on the drain path it
 * doubles as the once-only guard - so on its own it means "a question was asked here
 * once", which stays true forever after it is answered.
 */
export function wrapupAskPending(q: SessionQueueSummary): boolean {
  return q.wrapupAskedAt !== null && !q.wrapupAnswered;
}

/**
 * Whether the card's queue chip has anything to say.
 *
 * Item count alone was the gate, and it hid the `prompted` trigger's ask completely: a
 * prompted wrap-up fires only on a checkout with no work queue, so its row has zero
 * items by construction. The alert fired and pointed at a card carrying no queue
 * affordance at all - the panel only mounts once the card is expanded - so the one
 * question Foreman had was reachable only by going looking for it.
 *
 * Kept narrow deliberately: an ANSWERED ask must not keep the chip alive on an itemless
 * row, or every session that ever wrapped up grows a permanent chip saying nothing.
 */
export function queueChipVisible(q: SessionQueueSummary): boolean {
  return q.totalCount > 0 || wrapupAskPending(q);
}

/**
 * The chip's label and tone.
 *
 * The one rule: only work the agent actually LANDED may be counted as done. That's
 * why `done` is read straight from `verifiedCount` rather than reckoned as "terminal
 * minus the failures I could think of" - subtraction quietly promotes every terminal
 * state nobody enumerated into the win column, which is how a cancelled item came to
 * report itself as done here. Anything terminal that isn't verified is work that
 * stopped, and it says so.
 *
 * `stopped` is deliberately unnamed beyond that: it's whatever ended without landing
 * and without escalating - `cancelled` today - and calling it by that name would be
 * the same guess in a new coat. It counts as unfinished either way, which is the fact
 * that matters and the safe direction to be wrong in.
 *
 * All of this matters most on a session that has exited: it has no ActionBar, so no
 * Queue button, which leaves this chip the last thing pointing at what the batch did.
 */
export function queueChipView(q: SessionQueueSummary): QueueChipView {
  // No items at all, which is the `prompted` trigger's row: every count below is zero,
  // so the tally would render an empty chip. The open question IS the whole content
  // here, and it is owed a human's eye by definition - the same reason its alert is
  // raised at `attention`.
  if (q.totalCount === 0) {
    return {
      label: "ship it?",
      title: "Foreman thinks the work you asked for is finished - click to decide",
      attention: true,
    };
  }
  const done = q.verifiedCount;
  const escalated = q.escalatedCount;
  const stopped = Math.max(0, q.totalCount - q.openCount - done - escalated);
  const parts: string[] = [];
  // While anything is still waiting, that's the headline; a done count beside it is
  // just noise on a queue whose whole point is what's left.
  if (q.openCount > 0) parts.push(`${q.openCount} queued`);
  else if (done > 0) parts.push(`${done} done`);
  if (escalated > 0) parts.push(`${escalated} escalated`);
  if (stopped > 0) parts.push(`${stopped} stopped`);
  return {
    label: parts.join(" · "),
    title: chipTitle(q, escalated + stopped, escalated),
    attention: escalated + stopped > 0,
  };
}

function chipTitle(q: SessionQueueSummary, unfinished: number, escalated: number): string {
  if (q.inFlightIntent) {
    return `Foreman is working through this session's queue: ${q.inFlightIntent}`;
  }
  if (unfinished > 0) {
    const escalatedNote = escalated > 0 ? ` (${escalated} escalated to you)` : "";
    return `${unfinished} of this session's ${q.totalCount} queued ${
      q.totalCount === 1 ? "item" : "items"
    } never landed${escalatedNote} - click to read ${unfinished === 1 ? "it" : "them"}`;
  }
  if (q.openCount > 0) return "Work queued for this session - click to see it";
  return "This session's queued work all landed - click to read it";
}
