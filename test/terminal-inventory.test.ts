import assert from "node:assert/strict";
import { test } from "node:test";
import { readInventory } from "../src/server/terminal/inventory.ts";

test("inventory diagnostics retain backend and exception with a shared per-backend rate limit", async (t) => {
  let now = 0;
  t.mock.method(Date, "now", () => now);
  const diagnostics = t.mock.method(console, "error", () => {});
  for (const observation of [null, [], ["pane"]]) {
    assert.deepEqual(await readInventory("ghostty", async () => observation), observation);
  }
  assert.equal(diagnostics.mock.callCount(), 0, "ordinary inventory results need no exception diagnostic");

  const failure = new Error("unexpected response");
  assert.equal(await readInventory("ghostty", () => { throw failure; }), null);
  assert.match(String(diagnostics.mock.calls[0]?.arguments[0]), /ghostty.*inventory/);
  assert.equal(diagnostics.mock.calls[0]?.arguments[1], failure, "the original error retains its stack and cause");
  const reject = async () => { throw failure; };
  assert.equal(await readInventory("ghostty", reject), null);
  assert.equal(diagnostics.mock.callCount(), 1, "a different caller shares the same backend limit");
  assert.equal(await readInventory("tmux", reject), null);
  assert.equal(diagnostics.mock.callCount(), 2, "one backend must not suppress another's failure");
  assert.match(String(diagnostics.mock.calls[1]?.arguments[0]), /tmux.*inventory/);

  now = 59_999;
  await readInventory("ghostty", async () => []);
  await readInventory("ghostty", reject);
  assert.equal(diagnostics.mock.callCount(), 2, "intermittent success must not permit poll-loop spam");
  now = 60_000;
  await readInventory("ghostty", reject);
  assert.equal(diagnostics.mock.callCount(), 3, "persistent failure remains diagnosable after the interval");
});
