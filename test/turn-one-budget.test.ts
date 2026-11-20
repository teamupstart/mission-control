import assert from "node:assert/strict";
import test from "node:test";
import {
  DRIVER_TURN_ONE,
  PASTE_TURN_ONE,
  SECTION_JOIN_MARGIN,
  launchArgumentCeiling,
  launchArgumentTurnOne,
  turnOneAllowance,
} from "../src/server/turn-one-budget.ts";

// The arithmetic the dispatcher budgets a task context section with. The delivery tests in
// `dispatcher-shaping.test.ts` drive it through real launches; this pins each remainder.

test("a path with no ceiling budgets nothing", () => {
  assert.equal(turnOneAllowance(DRIVER_TURN_ONE, "x".repeat(1_000_000), null), null);
  assert.equal(turnOneAllowance(PASTE_TURN_ONE, "x".repeat(1_000_000), null), null);
  // macOS has no per-argument limit, and without ARG_MAX there is nothing to budget either.
  assert.equal(turnOneAllowance(launchArgumentTurnOne("darwin"), "x", null), null);
});

test("Linux caps one argument at 32 pages including its terminator", () => {
  assert.equal(launchArgumentCeiling("linux"), 131_071);
  assert.equal(launchArgumentCeiling("darwin"), null);
  const allowance = turnOneAllowance(launchArgumentTurnOne("linux"), "x".repeat(100_000), null);
  assert.deepEqual(allowance?.maxSectionBytes, 131_071 - 100_000 - SECTION_JOIN_MARGIN);
  assert.match(allowance?.reason ?? "", /one launch argument/);
});

test("the combined limit counts every argument and environment string with its terminator and pointer", () => {
  const otherArgs = ["/usr/bin/pi", "--session-id", "0123"];
  const env = { PATH: "/bin", HOME: "/h", UNSET: undefined };
  const turnOne = "hello";
  const counted = (value: string) => Buffer.byteLength(value) + 1 + 8;
  const used = otherArgs.reduce((sum, arg) => sum + counted(arg), 0) + counted("PATH=/bin") + counted("HOME=/h") + counted(turnOne);
  const allowance = turnOneAllowance(launchArgumentTurnOne("darwin"), turnOne, { otherArgs, env, argMax: 10_000 });
  assert.equal(allowance?.maxSectionBytes, 10_000 - used - SECTION_JOIN_MARGIN);
  assert.match(allowance?.reason ?? "", /arguments and environment/);
});

test("the tighter of the two remainders wins, and the allowance is never negative", () => {
  const linux = launchArgumentTurnOne("linux");
  const tightEnv = turnOneAllowance(linux, "x", { otherArgs: [], env: { PAD: "p".repeat(9_000) }, argMax: 10_000 });
  assert.match(tightEnv?.reason ?? "", /arguments and environment/);
  const tightArg = turnOneAllowance(linux, "x".repeat(131_000), { otherArgs: [], env: {}, argMax: 2_000_000 });
  assert.match(tightArg?.reason ?? "", /one launch argument/);
  assert.equal(turnOneAllowance(linux, "x".repeat(140_000), null)?.maxSectionBytes, 0);
  // Measured in bytes, not characters.
  const multibyte = turnOneAllowance(linux, "é".repeat(1000), null);
  assert.equal(multibyte?.maxSectionBytes, 131_071 - 2000 - SECTION_JOIN_MARGIN);
});
