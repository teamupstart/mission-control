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
  shapingWriteFromEarlierInstance,
  shapingWriteSuperseded,
} from "../src/server/shaping/write-order.ts";

/** A sequence as a window numbers a write it sent `ago` milliseconds before `now`. */
const sentAt = (now: number, ago = 0, step = 0): number => (now - ago) * 1000 + step;

test("a write order is read from its header, and an unreadable one declares none", () => {
  assert.deepEqual(readShapingWriteOrder(shapingWriteOrder("w-1", 3, ["import", "row:a"])), { window: "w-1", sequence: 3, controls: ["import", "row:a"], instance: null, lineage: [] });
  assert.deepEqual(readShapingWriteOrder(shapingWriteOrder("w-1", 3, ["settings"], "daemon-1")), { window: "w-1", sequence: 3, controls: ["settings"], instance: "daemon-1", lineage: [] });
  assert.deepEqual(readShapingWriteOrder(shapingWriteOrder("w-2", 3, ["settings"], "daemon-1", ["w-0", "w-1"])), { window: "w-2", sequence: 3, controls: ["settings"], instance: "daemon-1", lineage: ["w-0", "w-1"] });
  // A lineage with no instance known names none: `-`, which no daemon process is.
  assert.deepEqual(readShapingWriteOrder(shapingWriteOrder("w-2", 3, ["settings"], undefined, ["w-1"]))?.instance, "-");
  const tooLong = Array.from({ length: 17 }, (_, index) => `w-${index}`).join(",");
  for (const header of [undefined, "", "w-1 3", "w-1 0 settings", "w-1 x settings", "w 1 settings d w-0 extra", "w 1 settings bad/instance", "bad/window 1 settings", "w-1 1 bad/control", "w 1 settings d bad/earlier", `w 1 settings d ${tooLong}`]) {
    assert.equal(readShapingWriteOrder(header), null, String(header));
  }
});

test("a write is superseded once a later one from its window was applied to one of its controls", () => {
  const window = "order-test-window";
  const now = Date.now();
  const later = readShapingWriteOrder(shapingWriteOrder(window, sentAt(now, 0, 2), ["settings"]))!;
  const earlier = readShapingWriteOrder(shapingWriteOrder(window, sentAt(now, 0, 1), ["settings"]))!;
  assert.equal(shapingWriteSuperseded(later), false);
  noteShapingWriteApplied(later, now);
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

test("a write sent longer ago than the window is refused, however little else was applied", () => {
  const now = Date.now();
  const order = (ago: number) => readShapingWriteOrder(shapingWriteOrder("w-expiry", sentAt(now, ago), ["settings"]))!;
  assert.equal(shapingWriteExpired(order(0), now), false, "sent just now");
  assert.equal(shapingWriteExpired(order(SHAPING_WRITE_WINDOW_MS - 1000), now), false, "sent inside the window");
  assert.equal(shapingWriteExpired(order(SHAPING_WRITE_WINDOW_MS + 1000), now), true, "sent before the window");
  // A sequence that is no time at all, as a window numbering writes from one, reads as long ago.
  assert.equal(shapingWriteExpired(readShapingWriteOrder(shapingWriteOrder("w-expiry", 7, ["settings"]))!, now), true);
});

test("a record outlives any number of other windows' writes, and goes only once no write it refuses can apply", () => {
  const now = Date.now();
  const window = "w-retained";
  const newer = readShapingWriteOrder(shapingWriteOrder(window, sentAt(now, 0, 2), ["settings"]))!;
  const older = readShapingWriteOrder(shapingWriteOrder(window, sentAt(now, 0, 1), ["settings"]))!;
  noteShapingWriteApplied(newer, now);
  // Far more traffic than any count bound would keep, from other windows, in the same moment.
  for (let index = 0; index < 10_000; index++) {
    noteShapingWriteApplied(readShapingWriteOrder(shapingWriteOrder(`w-other-${index}`, sentAt(now), ["settings", `row:r${index}`]))!, now);
  }
  assert.equal(shapingWriteSuperseded(older), true, "the newer save's record is still held");
  assert.equal(shapingWriteExpired(older, now), false);
  // Past the window, the records go, and the older write is refused as expired instead.
  const later = now + SHAPING_WRITE_WINDOW_MS + 1000;
  noteShapingWriteApplied(readShapingWriteOrder(shapingWriteOrder("w-after", sentAt(later), ["settings"]))!, later);
  assert.equal(heldShapingWriteRecords(), 1, "only the write applied just now is held");
  assert.equal(shapingWriteSuperseded(older), false);
  assert.equal(shapingWriteExpired(older, later), true, "nothing that record refused can apply");
});

test("a write a page applied is recorded against the earlier pages of its tab, and only its own refuse it", () => {
  const now = Date.now();
  const before = "w-before-reload";
  const after = "w-after-reload";
  const order = (window: string, step: number, lineage: string[] = []) =>
    readShapingWriteOrder(shapingWriteOrder(window, sentAt(now, 0, step), ["settings"], DAEMON_SHAPING_INSTANCE, lineage))!;
  // The reloaded page saves, naming the page it replaced.
  noteShapingWriteApplied(order(after, 5, [before]), now);
  // A save the page before the reload sent earlier, delayed past that one, is refused.
  assert.equal(shapingWriteSuperseded(order(before, 3)), true, "the earlier page's delayed save");
  // One the earlier page sent later is not: it is the newer edit.
  assert.equal(shapingWriteSuperseded(order(before, 7)), false);
  // A page is never refused for what an earlier page of its tab, or a duplicate of it, applied:
  // the duplicate's own id has no record but its own.
  noteShapingWriteApplied(order(before, 9), now);
  assert.equal(shapingWriteSuperseded(order(after, 6, [before])), false, "the reloaded page's own save");
  assert.equal(shapingWriteSuperseded(order(after, 4, [before])), true, "though its own later save still refuses an earlier one");
});
