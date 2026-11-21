// Write ordering for one dashboard window's shaping writes, at the daemon.

import assert from "node:assert/strict";
import test from "node:test";
import { shapingWriteOrder } from "../src/shared/shaping.ts";
import {
  DAEMON_SHAPING_INSTANCE,
  heldShapingWriteRecords,
  noteShapingWriteApplied,
  readShapingWriteOrder,
  SHAPING_WRITE_WINDOW_MS,
  shapingWriteExpired,
  shapingWriteFloor,
  shapingWriteFromEarlierInstance,
  shapingWriteSuperseded,
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

test("a record outlives any number of other windows' writes, and goes only once no write it refuses can apply", () => {
  const now = Date.now();
  const window = "w-retained";
  const newer = readShapingWriteOrder(shapingWriteOrder(window, sentAt(now, 0, 2), ["settings"]))!;
  const older = readShapingWriteOrder(shapingWriteOrder(window, sentAt(now, 0, 1), ["settings"]))!;
  noteShapingWriteApplied(newer, after(1));
  // Far more traffic than any count bound would keep, from other windows, in the same moment.
  const moment = after(1);
  for (let index = 0; index < 10_000; index++) {
    noteShapingWriteApplied(readShapingWriteOrder(shapingWriteOrder(`w-other-${index}`, sentAt(now), ["settings", `row:r${index}`]))!, moment);
  }
  assert.equal(shapingWriteSuperseded(older), true, "the newer save's record is still held");
  assert.equal(shapingWriteExpired(older), false);
  // Past the window, the records go, and raise the floor to the newer save's sequence: the older
  // write is refused as expired instead.
  noteShapingWriteApplied(readShapingWriteOrder(shapingWriteOrder("w-after", sentAt(now, 0, 9), ["settings"]))!, after(SHAPING_WRITE_WINDOW_MS + 1000));
  assert.equal(heldShapingWriteRecords(), 1, "only the write applied just now is held");
  assert.equal(shapingWriteSuperseded(older), false);
  assert.ok(shapingWriteFloor() >= newer.sequence);
  assert.equal(shapingWriteExpired(older), true, "nothing that record refused can apply");
  assert.equal(shapingWriteExpired(newer), true, "nor the write it recorded, sent again");
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
