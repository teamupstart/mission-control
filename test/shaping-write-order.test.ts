// Write ordering for one dashboard window's shaping writes, at the daemon.

import assert from "node:assert/strict";
import test from "node:test";
import { shapingWriteOrder } from "../src/shared/shaping.ts";
import { noteShapingWriteApplied, readShapingWriteOrder, shapingWriteSuperseded } from "../src/server/shaping/write-order.ts";

test("a write order is read from its header, and an unreadable one declares none", () => {
  assert.deepEqual(readShapingWriteOrder(shapingWriteOrder("w-1", 3, ["import", "row:a"])), { window: "w-1", sequence: 3, controls: ["import", "row:a"] });
  for (const header of [undefined, "", "w-1 3", "w-1 0 settings", "w-1 x settings", "w 1 settings extra", "bad/window 1 settings", "w-1 1 bad control"]) {
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
