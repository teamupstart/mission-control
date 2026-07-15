import { test } from "node:test";
import assert from "node:assert/strict";
import { itemLabel, moveTarget } from "../src/web/lib/queue.ts";
import type { WorkItem, WorkItemState } from "../src/shared/types.ts";

// The work-queue panel's pure presentation logic. It lives in src/web/lib precisely
// so it can be checked here without a DOM - both of these were bugs a rendering test
// would have had to be lucky to catch, and a table catches by construction.

let n = 0;
function mkItem(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: `i${++n}`,
    noteKey: "k",
    seq: 0,
    intent: "add the retry",
    state: "queued",
    round: 0,
    baseSha: null,
    transcriptAnchor: null,
    gaps: [],
    sendAttempts: 0,
    verifyFailures: 0,
    escalationReason: null,
    lastVerdict: null,
    approvedAt: null,
    proposedPayload: null,
    recoveredAt: null,
    revision: 0,
    createdAt: 0,
    updatedAt: 0,
    sentAt: null,
    completedAt: null,
    ...over,
  };
}

// ---- itemLabel ----

test("an APPROVED draft never still asks for an OK", () => {
  // The label read `state` alone, so the moment the human approved, the card went on
  // demanding an OK while the button that would give one was already gone (Approve is
  // gated on `!approvedAt`). Nothing on screen said the click had registered, and the
  // wait is long: the worker's next tick is IDLE_MS away at best, behind a serial
  // pass that can block minutes on a `claude -p`.
  const drafted = mkItem({ state: "proposed" });
  assert.equal(itemLabel(drafted), "drafted - needs your OK");

  const approved = mkItem({ state: "proposed", approvedAt: 123 });
  assert.notEqual(itemLabel(approved), "drafted - needs your OK");
  assert.match(itemLabel(approved), /approved/i);
});

test("itemLabel is unchanged for every state consent doesn't apply to", () => {
  // `approvedAt` is only ever set on a draft, but it's a stamp rather than a flag -
  // it survives the state moving on. It must not rewrite the label of an item that is
  // being delivered, worked, or already done.
  const states: WorkItemState[] = [
    "queued", "sending", "awaiting_pickup", "in_progress", "verifying",
    "verified", "escalated", "cancelled",
  ];
  for (const state of states) {
    assert.equal(
      itemLabel(mkItem({ state, approvedAt: 123 })),
      itemLabel(mkItem({ state })),
      `${state} reads the same either way`,
    );
  }
  assert.equal(itemLabel(mkItem({ state: "verified", approvedAt: 123 })), "done");
});

// ---- moveTarget: the keyboard reorder ----

test("moveTarget walks a waiting item one place, and stops at the ends", () => {
  const a = mkItem({ id: "a", state: "queued" });
  const b = mkItem({ id: "b", state: "queued" });
  const c = mkItem({ id: "c", state: "queued" });
  const items = [a, b, c];

  assert.equal(moveTarget(items, b, -1), 0);
  assert.equal(moveTarget(items, b, 1), 2);
  assert.equal(moveTarget(items, a, -1), -1, "nowhere above the first");
  assert.equal(moveTarget(items, c, 1), -1, "nowhere below the last");
});

test("moveTarget steps OVER done and in-flight rows, never onto them", () => {
  // The same rule the drop handler enforces: a waiting item renumbered in among the
  // completed work doesn't change delivery order (`nextSendable` skips terminal
  // items) but does break the "in the order you authored it" contract - and makes the
  // done/waiting split unreadable.
  const done = mkItem({ id: "done", state: "verified" });
  const flight = mkItem({ id: "flight", state: "in_progress" });
  const w1 = mkItem({ id: "w1", state: "queued" });
  const w2 = mkItem({ id: "w2", state: "proposed" });
  const items = [done, flight, w1, w2];

  // w1's only legal move up is past BOTH the in-flight and done rows, to index 0.
  assert.equal(moveTarget(items, w1, -1), -1, "no waiting row above it to swap with");
  assert.equal(moveTarget(items, w1, 1), 3, "down onto the next waiting row");
  assert.equal(moveTarget(items, w2, -1), 2);
  assert.equal(moveTarget(items, w2, 1), -1);
});

test("moveTarget returns -1 for an item that isn't in the list", () => {
  assert.equal(moveTarget([mkItem({ id: "a" })], mkItem({ id: "ghost" }), 1), -1);
});
