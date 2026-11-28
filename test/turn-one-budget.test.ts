import assert from "node:assert/strict";
import test from "node:test";
import {
  DRIVER_TURN_ONE,
  PASTE_TURN_ONE,
  SECTION_JOIN_MARGIN,
  TERMINAL_ENV_RESERVE,
  appleScriptPasteFits,
  launchArgumentCeiling,
  launchArgumentTurnOne,
  pasteTravelsAsArgument,
  platformArgMax,
  resetPlatformArgMaxForTests,
  turnOneAllowance,
} from "../src/server/turn-one-budget.ts";

const counted = (value: string) => Buffer.byteLength(value) + 1 + 8;
/** What exec charges beyond argv for the program: its pathname, and a `#!` interpreter's strings. */
const imageBytes = (program: string) => 2 * counted(program) + 2 * (256 + 1 + 8);

// The arithmetic the dispatcher budgets a task context section with. The delivery tests in
// `dispatcher-shaping.test.ts` drive it through real launches; this pins each remainder.

test("a path with no ceiling budgets nothing", () => {
  assert.equal(turnOneAllowance(DRIVER_TURN_ONE, "x".repeat(1_000_000), null), null);
  assert.equal(turnOneAllowance(PASTE_TURN_ONE, "x".repeat(1_000_000), null), null);
});

test("a launch argument whose combined limit cannot be measured carries no section", () => {
  for (const platform of ["darwin", "linux"] as const) {
    for (const launch of [null, { otherArgs: [], env: {}, argMax: null }]) {
      const allowance = turnOneAllowance(launchArgumentTurnOne(platform), "x", launch);
      assert.equal(allowance?.maxSectionBytes, 0, `${platform}: nothing is promised without the measure`);
      assert.match(allowance?.reason ?? "", /could not be measured/);
    }
  }
});

test("Linux caps one argument at 32 pages including its terminator", () => {
  assert.equal(launchArgumentCeiling("linux"), 131_071);
  assert.equal(launchArgumentCeiling("darwin"), null);
  const roomy = { otherArgs: [], env: {}, argMax: 2_000_000 };
  const allowance = turnOneAllowance(launchArgumentTurnOne("linux"), "x".repeat(100_000), roomy);
  assert.deepEqual(allowance?.maxSectionBytes, 131_071 - 100_000 - SECTION_JOIN_MARGIN);
  assert.match(allowance?.reason ?? "", /one launch argument/);
});

test("the combined limit counts every argument and environment string with its terminator and pointer", () => {
  const otherArgs = ["/usr/bin/pi", "--session-id", "0123"];
  const env = { PATH: "/bin", HOME: "/h", UNSET: undefined };
  const turnOne = "hello";
  const used = otherArgs.reduce((sum, arg) => sum + counted(arg), 0) + counted("PATH=/bin") + counted("HOME=/h") + counted(turnOne);
  const argMax = 1_000_000;
  const allowance = turnOneAllowance(launchArgumentTurnOne("darwin"), turnOne, { otherArgs, env, argMax });
  assert.equal(allowance?.maxSectionBytes, argMax - used - imageBytes("/usr/bin/pi") - TERMINAL_ENV_RESERVE - SECTION_JOIN_MARGIN);
  assert.match(allowance?.reason ?? "", /arguments and environment/);
});

test("a script entry point at a long path is charged its pathname and interpreter strings", () => {
  // A Pi CLI installed deep in a version manager's tree, as a `#!/usr/bin/env node` script.
  const program = `/Users/someone/${"a-long-segment/".repeat(40)}bin/pi`;
  const base = { otherArgs: [program, "--session-id", "0123"], env: {}, argMax: 1_000_000 };
  const short = { ...base, otherArgs: ["/p", "--session-id", "0123"] };
  const long = turnOneAllowance(launchArgumentTurnOne("darwin"), "x", base)!.maxSectionBytes;
  const brief = turnOneAllowance(launchArgumentTurnOne("darwin"), "x", short)!.maxSectionBytes;
  // argv[0] once, and the pathname twice more: exec's own copy and binfmt_script's re-insertion.
  assert.equal(brief - long, 3 * (Buffer.byteLength(program) - Buffer.byteLength("/p")));
  assert.ok(Buffer.byteLength(program) > 600, "a realistically long install path");
});

test("the combined limit keeps room for the terminal server's own environment", () => {
  const launch = { otherArgs: ["/p"], env: {}, argMax: TERMINAL_ENV_RESERVE + 10_000 };
  const allowance = turnOneAllowance(launchArgumentTurnOne("darwin"), "x", launch)!;
  assert.ok(allowance.maxSectionBytes < 10_000, "the reserve is taken off before the section's room");
  const tight = turnOneAllowance(launchArgumentTurnOne("darwin"), "x", { ...launch, argMax: TERMINAL_ENV_RESERVE })!;
  assert.equal(tight.maxSectionBytes, 0, "a launch with only the reserve left gets no section");
});

test("a pane paste is an argument only on an AppleScript backend, or an automatic choice on macOS", () => {
  assert.equal(pasteTravelsAsArgument("ghostty", "darwin"), true);
  assert.equal(pasteTravelsAsArgument("iterm", "darwin"), true);
  assert.equal(pasteTravelsAsArgument(null, "darwin"), true, "automatic may land on either");
  assert.equal(pasteTravelsAsArgument("tmux", "darwin"), false, "tmux reads its paste from stdin");
  assert.equal(pasteTravelsAsArgument("wezterm", "darwin"), false);
  assert.equal(pasteTravelsAsArgument(null, "linux"), false, "no AppleScript backend exists off macOS");
});

test("an AppleScript paste is checked as the backends encode it, newlines included", () => {
  const env = { PATH: "/bin" };
  assert.equal(appleScriptPasteFits("short", env, 1_048_576), true);
  assert.equal(appleScriptPasteFits("short", env, null), false, "an unmeasured limit does not fit");
  // iTerm2's encoder turns each newline into a `(character id 10)` expression joined by ` & `,
  // about 21 bytes apiece, so 64 KiB of newlines encodes past 1 MiB while 64 KiB of ordinary
  // text, which AppleScript quoting leaves the same size, fits easily.
  assert.equal(appleScriptPasteFits("\n".repeat(64 * 1024), env, 1_048_576), false);
  assert.equal(appleScriptPasteFits("x".repeat(64 * 1024), env, 1_048_576), true, "the same size of ordinary text does");
});

test("a failed ARG_MAX probe is retried after a cooldown, and a successful one is kept", async () => {
  resetPlatformArgMaxForTests();
  let now = 0;
  let calls = 0;
  let answer: number | null = null;
  const probe = async () => { calls += 1; return answer; };
  assert.equal(await platformArgMax(probe, () => now), null);
  answer = 1_048_576;
  assert.equal(await platformArgMax(probe, () => now), null, "within the cooldown the failure stands");
  assert.equal(calls, 1);
  now = 61_000;
  assert.equal(await platformArgMax(probe, () => now), 1_048_576, "after it, a later launch asks again");
  answer = null;
  now = 1_000_000;
  assert.equal(await platformArgMax(probe, () => now), 1_048_576, "and a value once read is kept");
  assert.equal(calls, 2);
  resetPlatformArgMaxForTests();
});

test("the tighter of the two remainders wins, and the allowance is never negative", () => {
  const linux = launchArgumentTurnOne("linux");
  const tightEnv = turnOneAllowance(linux, "x", { otherArgs: [], env: { PAD: "p".repeat(9_000) }, argMax: TERMINAL_ENV_RESERVE + 10_000 });
  assert.match(tightEnv?.reason ?? "", /arguments and environment/);
  const tightArg = turnOneAllowance(linux, "x".repeat(131_000), { otherArgs: [], env: {}, argMax: 2_000_000 });
  assert.match(tightArg?.reason ?? "", /one launch argument/);
  const roomy = { otherArgs: [], env: {}, argMax: 2_000_000 };
  assert.equal(turnOneAllowance(linux, "x".repeat(140_000), roomy)?.maxSectionBytes, 0);
  // Measured in bytes, not characters.
  const multibyte = turnOneAllowance(linux, "é".repeat(1000), roomy);
  assert.equal(multibyte?.maxSectionBytes, 131_071 - 2000 - SECTION_JOIN_MARGIN);
});
