import assert from "node:assert/strict";
import test from "node:test";
import { requestUpdateQuit } from "../src/main/updater.ts";

test("the update quit path sets quitting before requesting app quit", () => {
  const order: string[] = [];
  requestUpdateQuit(
    () => order.push("set-quitting"),
    () => order.push("app-quit"),
  );
  assert.deepEqual(order, ["set-quitting", "app-quit"]);
});
