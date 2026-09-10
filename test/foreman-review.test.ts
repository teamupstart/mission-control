import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `claude-cli.ts` reads the claude binary and the full-review budget from the env at module
// load, so both are pinned BEFORE importing it. The fake bin never exits, which exercises the
// real spawn + timeout + process-group-kill path rather than a stubbed promise.
const dir = mkdtempSync(join(tmpdir(), "foreman-review-"));
const fakeBin = join(dir, "fake-claude.sh");
const runReady = join(dir, "run-ready");
writeFileSync(fakeBin, `#!/bin/sh\nprintf ready > ${JSON.stringify(runReady)}\nsleep 30\n`);
chmodSync(fakeBin, 0o755);
process.env.FOREMAN_CLAUDE_BIN = fakeBin;

/**
 * The clock is controlled rather than measured. Both tests still exercise the real spawn,
 * timeout callback and process-group kill, but a loaded test worker cannot turn scheduler delay
 * into a product failure or make the default-budget case cost four wall-clock seconds.
 */
const DEFAULT_BUDGET_MS = 4000;
const CALLER_BUDGET_MS = 200;
const nativeSetTimeout = setTimeout;
process.env.FOREMAN_REVIEW_TIMEOUT_MS = String(DEFAULT_BUDGET_MS);

// Initialize executable discovery on the real clock. The tests below mock only the launch
// timeout, not the independent login-shell timeout used to build the executable snapshot.
const { initializeExecutableEnvironment } = await import("../src/server/executables/locator.ts");
await initializeExecutableEnvironment();
const { runClaudeText } = await import("../src/server/claude-cli.ts");

after(() => rmSync(dir, { recursive: true, force: true }));

async function waitForSpawn(readError: () => unknown): Promise<void> {
  for (let turn = 0; turn < 1000; turn += 1) {
    if (existsSync(runReady)) return;
    const error = readError();
    if (error !== null) assert.fail(`the fake Claude process failed before startup: ${String(error)}`);
    await new Promise<void>((resolve) => nativeSetTimeout(resolve, 10));
  }
  assert.fail("the fake Claude process did not start");
}

async function drainRejection(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
}

test("runClaudeText honours a caller's own timeoutMs", async (t) => {
  // The Tier 1 router passes a budget sized for Haiku emitting one small object; it must not
  // inherit the full reviewer's, which is sized for Opus reading a 60-turn window (head plus
  // tail - see `client.transcript`) with the whole POLICY.
  // In `on` mode the router and the full review run serially, so a shared cap would let a
  // degraded API double the serial queue's worst case instead of failing fast into a route-up.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let error: unknown = null;
  const completion = runClaudeText("hi", { timeoutMs: CALLER_BUDGET_MS }).catch((caught: unknown) => {
    error = caught;
  });
  await waitForSpawn(() => error);
  t.mock.timers.tick(CALLER_BUDGET_MS);
  await drainRejection();
  const rejectedAtCallerBudget = error;
  if (error === null) {
    t.mock.timers.tick(DEFAULT_BUDGET_MS);
    await completion;
  }
  assert.match(String(rejectedAtCallerBudget), /timed out/, "the caller's budget fired first");
});

test("runClaudeText defaults to the full review's budget when no timeout is given", async (t) => {
  // Tier 2 is deliberately unchanged: an absent `timeoutMs` still means REVIEW_TIMEOUT_MS.
  rmSync(runReady, { force: true });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let error: unknown = null;
  const completion = runClaudeText("hi").catch((caught: unknown) => {
    error = caught;
  });
  await waitForSpawn(() => error);
  t.mock.timers.tick(CALLER_BUDGET_MS);
  await drainRejection();
  assert.equal(error, null, "the caller-sized budget was not inherited");
  t.mock.timers.tick(DEFAULT_BUDGET_MS - CALLER_BUDGET_MS);
  await completion;
  assert.match(String(error), /timed out/, "the full review budget fired");
});
