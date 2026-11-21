// Write ordering for one dashboard window's shaping writes, at the daemon.

import assert from "node:assert/strict";
import test from "node:test";
import { shapingWriteOrder } from "../src/shared/shaping.ts";
import {
  DAEMON_SHAPING_INSTANCE,
  heldShapingWriteRecords,
  noteShapingWriteApplied,
  readShapingWriteOrder,
  SHAPING_SEQUENCE_LEAD_MS,
  SHAPING_WRITE_RECORDS_KEPT,
  SHAPING_WRITE_WINDOW_MS,
  shapingWriteExpired,
  shapingWriteFloor,
  shapingWriteFromEarlierInstance,
  shapingWriteSuperseded,
  shapingWriteTooFarAhead,
} from "../src/server/shaping/write-order.ts";

/** A sequence as a window numbers a write it sent `ago` milliseconds before `now`. */
const sentAt = (now: number, ago = 0, step = 0): number => (now - ago) * 1000 + step;

/**
 * The daemon's monotonic clock, as this file advances it: records are kept and dropped by it, and
 * it only moves forward, whatever these tests do to the sequences, which follow the wall clock.
 */
let monotonic = 1_000;
const after = (ms: number): number => (monotonic += ms);

test("a write order is read from its header, and an unreadable one declares none", () => {
  assert.deepEqual(readShapingWriteOrder(shapingWriteOrder("w-1", 3, ["import", "row:a"])), { window: "w-1", sequence: 3, controls: ["import", "row:a"], instance: null });
  assert.deepEqual(readShapingWriteOrder(shapingWriteOrder("w-1", 3, ["settings"], "daemon-1")), { window: "w-1", sequence: 3, controls: ["settings"], instance: "daemon-1" });
  for (const header of [undefined, "", "w-1 3", "w-1 0 settings", "w-1 x settings", "w 1 settings d extra", "w 1 settings bad/instance", "bad/window 1 settings", "w-1 1 bad/control"]) {
    assert.equal(readShapingWriteOrder(header), null, String(header));
  }
});

test("a write is superseded once a later one from its window was applied to one of its controls", () => {
  const window = "order-test-window";
  const now = Date.now();
  const later = readShapingWriteOrder(shapingWriteOrder(window, sentAt(now, 0, 2), ["settings"]))!;
  const earlier = readShapingWriteOrder(shapingWriteOrder(window, sentAt(now, 0, 1), ["settings"]))!;
  assert.equal(shapingWriteSuperseded(later), false);
  noteShapingWriteApplied(later, after(1));
  assert.equal(shapingWriteSuperseded(earlier), true, "the earlier write would overwrite the newer edit");
  // Other controls, and other windows, are not ordered against it.
  assert.equal(shapingWriteSuperseded(readShapingWriteOrder(shapingWriteOrder(window, sentAt(now, 0, 1), ["row:a"]))!), false);
  assert.equal(shapingWriteSuperseded(readShapingWriteOrder(shapingWriteOrder("another-window", sentAt(now, 0, 1), ["settings"]))!), false);
  // A write that touches the newer one's control among others is ordered too.
  assert.equal(shapingWriteSuperseded(readShapingWriteOrder(shapingWriteOrder(window, sentAt(now, 0, 1), ["import", "settings"]))!), true);
});

test("a write made against an earlier daemon process is told apart from one made against this one", () => {
  const order = (instance?: string) => readShapingWriteOrder(shapingWriteOrder("w-instance", 1, ["settings"], instance))!;
  assert.match(DAEMON_SHAPING_INSTANCE, /^[0-9a-f-]{36}$/);
  assert.equal(shapingWriteFromEarlierInstance(order(DAEMON_SHAPING_INSTANCE)), false, "this process");
  assert.equal(shapingWriteFromEarlierInstance(order("an-earlier-process")), true, "a process this one replaced");
  // Ordered but naming no instance: made against a daemon older than instances, so earlier too.
  assert.equal(shapingWriteFromEarlierInstance(order()), true, "no instance named, as against an older daemon");
});

test("a burst of other windows' writes never grows the records past their bound, and a write a dropped record refused stays refused", () => {
  const now = Date.now();
  const window = "w-retained";
  const newer = readShapingWriteOrder(shapingWriteOrder(window, sentAt(now, 0, 2), ["settings"]))!;
  const older = readShapingWriteOrder(shapingWriteOrder(window, sentAt(now, 0, 1), ["settings"]))!;
  noteShapingWriteApplied(newer, after(1));
  assert.equal(shapingWriteSuperseded(older), true, "the newer save's record is held");
  // Far more distinct ids and controls than the bound, from callers that choose them, in one moment.
  const moment = after(1);
  for (let index = 0; index < SHAPING_WRITE_RECORDS_KEPT * 2; index++) {
    noteShapingWriteApplied(readShapingWriteOrder(shapingWriteOrder(`w-other-${index}`, sentAt(now, 0, 3), [`row:r${index}`]))!, moment);
  }
  assert.ok(heldShapingWriteRecords() <= SHAPING_WRITE_RECORDS_KEPT, "the records stay within their bound");
  // The newer save's record was among the oldest and went first, but raised the floor past it: the
  // older write is still refused, now as expired.
  assert.equal(shapingWriteSuperseded(older), false);
  assert.ok(shapingWriteFloor() >= newer.sequence);
  assert.equal(shapingWriteExpired(older, now), true);
  // Past the window, every record goes, and the floor keeps refusing what they refused.
  noteShapingWriteApplied(readShapingWriteOrder(shapingWriteOrder("w-after", sentAt(now, 0, 9), ["settings"]))!, after(SHAPING_WRITE_WINDOW_MS + 1000));
  assert.equal(heldShapingWriteRecords(), 1, "only the write applied just now is held");
  assert.equal(shapingWriteExpired(newer, now), true, "nor the write a record held, sent again");
});

test("a write sent longer ago than the window is refused, though nothing else was written meanwhile", () => {
  const now = Date.now() + 60 * 60_000;
  const order = (ago: number) => readShapingWriteOrder(shapingWriteOrder("w-idle", sentAt(now, ago), ["settings"]))!;
  // Above the floor, so only its age decides.
  assert.ok(order(SHAPING_WRITE_WINDOW_MS + 1000).sequence > shapingWriteFloor());
  assert.equal(shapingWriteExpired(order(SHAPING_WRITE_WINDOW_MS + 1000), now), true, "sent before the window");
  assert.equal(shapingWriteExpired(order(SHAPING_WRITE_WINDOW_MS - 1000), now), false, "sent inside it");
});

test("a sequence further ahead than any tab numbers one is refused, so it can never lift the floor out of reach", () => {
  const now = Date.now();
  const order = (sequence: number) => readShapingWriteOrder(shapingWriteOrder("w-ahead", sequence, ["settings"]))!;
  assert.equal(shapingWriteTooFarAhead(order(Number.MAX_SAFE_INTEGER), now), true, "the largest safe integer");
  assert.equal(shapingWriteTooFarAhead(order((now + SHAPING_SEQUENCE_LEAD_MS + 1000) * 1000), now), true);
  assert.equal(shapingWriteTooFarAhead(order((now + 1000) * 1000), now), false, "a tab's own clock");
  // A tab raised past the floor is always inside the bound, however far ahead the floor is.
  assert.equal(shapingWriteTooFarAhead(order(shapingWriteFloor() + 1), now), false);
});

test("two pages of a tab that give writes the same number: the one applied first stands", () => {
  const now = Date.now() + 2 * 60 * 60_000;
  const tied = sentAt(now, 0, 5);
  noteShapingWriteApplied(readShapingWriteOrder(shapingWriteOrder("w-tied", tied, ["settings"]))!, after(1));
  assert.equal(shapingWriteSuperseded(readShapingWriteOrder(shapingWriteOrder("w-tied", tied, ["settings"]))!), true, "the duplicate's write, numbered the same");
  assert.equal(shapingWriteSuperseded(readShapingWriteOrder(shapingWriteOrder("w-tied", tied + 1, ["settings"]))!), false, "one numbered after it");
});

test("once a record is dropped, no wall clock change makes a write it refused eligible again", () => {
  // The clock jumps an hour forward: a save is numbered by it and applied.
  const jumped = Date.now() + 3_600_000;
  const window = "w-clock";
  const newer = readShapingWriteOrder(shapingWriteOrder(window, sentAt(jumped, 0, 2), ["settings"]))!;
  noteShapingWriteApplied(newer, after(1));
  // More than the window passes, by the monotonic clock, and the next write drops its record.
  noteShapingWriteApplied(readShapingWriteOrder(shapingWriteOrder("w-other-clock", sentAt(jumped, 0, 3), ["settings"]))!, after(SHAPING_WRITE_WINDOW_MS + 1000));
  // The clock is set back. A save the window sent before the newer one, delayed all this while, would
  // have passed a wall-clock expiry again; the floor refuses it.
  const delayed = readShapingWriteOrder(shapingWriteOrder(window, sentAt(jumped, 0, 1), ["settings"]))!;
  assert.equal(shapingWriteSuperseded(delayed), false, "its record is gone");
  assert.equal(shapingWriteExpired(delayed), true, "but the floor still refuses it");
  // A page told the floor numbers its next writes above it, and those apply.
  const raised = readShapingWriteOrder(shapingWriteOrder(window, shapingWriteFloor() + 1, ["settings"]))!;
  assert.equal(shapingWriteExpired(raised), false);
  assert.equal(shapingWriteSuperseded(raised), false);
});
