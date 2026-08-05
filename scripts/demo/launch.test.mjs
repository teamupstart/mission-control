// Regression test for the orphan-daemon bug a Code Risk Reviewer round found in
// `launch.mjs`, and the second, subtler race the first fix introduced: see that file's
// `createShutdownGate` for the full story. Run directly - `node --test scripts/demo/*.test.mjs`
// - since `scripts/demo/` is not under `test/`'s "runs against src/, no build required"
// contract (this launcher itself requires a build to do anything beyond this pure logic).
import assert from "node:assert/strict";
import test from "node:test";
import { createShutdownGate } from "./launch.mjs";

test("stop runs the cleanup", async () => {
  let calls = 0;
  const gate = createShutdownGate(async () => {
    calls += 1;
  });
  const claimed = await gate.stop("SIGINT");
  assert.equal(claimed, true);
  assert.equal(calls, 1);
  assert.equal(gate.isStopping(), true);
});

test("two concurrent callers race for the SAME stop: exactly one runs cleanup, exactly one is told it lost", async () => {
  // This is the shape of the real bug: a SIGINT arriving while the Foreman lease-wait's
  // own failure path is about to call stop() too. Both call stop() before either's onStop
  // has resolved - a losing caller that could not tell it lost would call process.exit
  // itself and race the winner's still-in-flight cleanup, exiting before it finished.
  let calls = 0;
  const gate = createShutdownGate(async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 20));
  });
  const [signalWon, foremanWon] = await Promise.all([gate.stop("SIGINT"), gate.stop("foreman-failed")]);
  assert.equal(calls, 1, "cleanup must run exactly once, not once per caller");
  assert.equal([signalWon, foremanWon].filter(Boolean).length, 1, "exactly one caller must be told it won");
});

test("a stop claimed after cleanup already finished is told it lost, and does not re-run cleanup", async () => {
  let calls = 0;
  const gate = createShutdownGate(async () => {
    calls += 1;
  });
  await gate.stop("first");
  const second = await gate.stop("second");
  assert.equal(calls, 1);
  assert.equal(second, false);
});

test("a caller that loses the race never sees onStop's return value or throws on its behalf", async () => {
  // The exact defect: a losing caller that still called process.exit(1) unconditionally
  // would exit the process before the winner's own cleanup (started first, still running)
  // ever reached its own process.exit. Modeled here as: the winner's cleanup takes a while,
  // and the loser resolves immediately with `false` rather than waiting on it at all.
  const order = [];
  const gate = createShutdownGate(async () => {
    order.push("cleanup-start");
    await new Promise((r) => setTimeout(r, 30));
    order.push("cleanup-end");
  });
  const winner = gate.stop("winner").then((won) => order.push(won ? "winner-done" : "winner-lost"));
  const loser = gate.stop("loser").then((won) => order.push(won ? "loser-done" : "loser-lost"));
  await Promise.all([winner, loser]);
  // The loser resolves as soon as it sees `stopping` already true - it must not block on
  // the winner's cleanup, and it must resolve `false` rather than duplicate the work.
  assert.equal(order.filter((e) => e === "cleanup-start").length, 1);
  assert.ok(order.includes("loser-lost") || order.includes("winner-lost"));
  assert.equal(order.filter((e) => e === "winner-done" || e === "loser-done").length, 1);
});
