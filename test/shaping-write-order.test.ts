// Write ordering for one dashboard window's shaping writes, at the daemon.

import assert from "node:assert/strict";
import test from "node:test";
import { shapingWriteOrder } from "../src/shared/shaping.ts";
import {
  DAEMON_SHAPING_INSTANCE,
  noteShapingWriteApplied,
  readShapingWriteOrder,
  shapingWriteFromEarlierInstance,
  shapingWriteSuperseded,
} from "../src/server/shaping/write-order.ts";

test("a write order is read from its header, and an unreadable one declares none", () => {
  assert.deepEqual(readShapingWriteOrder(shapingWriteOrder("w-1", 3, ["import", "row:a"])), { window: "w-1", sequence: 3, controls: ["import", "row:a"], instance: null });
  assert.deepEqual(readShapingWriteOrder(shapingWriteOrder("w-1", 3, ["settings"], "daemon-1")), { window: "w-1", sequence: 3, controls: ["settings"], instance: "daemon-1" });
  for (const header of [undefined, "", "w-1 3", "w-1 0 settings", "w-1 x settings", "w 1 settings d extra", "w 1 settings bad/instance", "bad/window 1 settings", "w-1 1 bad/control"]) {
    assert.equal(readShapingWriteOrder(header), null, String(header));
  }
});

test("a write is superseded once a later one from its window was applied to one of its controls", () => {
  const window = "order-test-window";
  const later = readShapingWriteOrder(shapingWriteOrder(window, 2, ["settings"]))!;
  const earlier = readShapingWriteOrder(shapingWriteOrder(window, 1, ["settings"]))!;
  assert.equal(shapingWriteSuperseded(later), false);
  noteShapingWriteApplied(later);
  assert.equal(shapingWriteSuperseded(earlier), true, "the earlier write would overwrite the newer edit");
  // Other controls, and other windows, are not ordered against it.
  assert.equal(shapingWriteSuperseded(readShapingWriteOrder(shapingWriteOrder(window, 1, ["row:a"]))!), false);
  assert.equal(shapingWriteSuperseded(readShapingWriteOrder(shapingWriteOrder("another-window", 1, ["settings"]))!), false);
  // A write that touches the newer one's control among others is ordered too.
  assert.equal(shapingWriteSuperseded(readShapingWriteOrder(shapingWriteOrder(window, 1, ["import", "settings"]))!), true);
});

test("a write made against an earlier daemon process is told apart from one made against this one", () => {
  const order = (instance?: string) => readShapingWriteOrder(shapingWriteOrder("w-instance", 1, ["settings"], instance))!;
  assert.match(DAEMON_SHAPING_INSTANCE, /^[0-9a-f-]{36}$/);
  assert.equal(shapingWriteFromEarlierInstance(order(DAEMON_SHAPING_INSTANCE)), false, "this process");
  assert.equal(shapingWriteFromEarlierInstance(order("an-earlier-process")), true, "a process this one replaced");
  // Ordered but naming no instance: made against a daemon older than instances, so earlier too.
  assert.equal(shapingWriteFromEarlierInstance(order()), true, "no instance named, as against an older daemon");
});
