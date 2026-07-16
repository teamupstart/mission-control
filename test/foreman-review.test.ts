import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `claude-cli.ts` reads the claude binary and the full-review budget from the env at module
// load, so both are pinned BEFORE importing it. The fake bin never exits, which exercises the
// real spawn + timeout + process-group-kill path rather than a stubbed promise.
const dir = mkdtempSync(join(tmpdir(), "foreman-review-"));
const fakeBin = join(dir, "fake-claude.sh");
writeFileSync(fakeBin, "#!/bin/sh\nsleep 30\n");
chmodSync(fakeBin, 0o755);
process.env.FOREMAN_CLAUDE_BIN = fakeBin;

/**
 * Which budget fired is only observable as elapsed time, so the two are pinned an order of
 * magnitude apart with the assertion boundary between them: a run landing under the boundary
 * can only have used the caller's budget, one landing over it can only have used the default.
 * `node --test` runs test files in parallel, so a bound set just past the shorter budget would
 * report a loaded machine as a regression instead of measuring the code. The default-budget
 * test costs its full DEFAULT_BUDGET_MS - the honest price of exercising the real spawn.
 */
const DEFAULT_BUDGET_MS = 4000;
const CALLER_BUDGET_MS = 200;
const BOUNDARY_MS = 2000;
process.env.FOREMAN_REVIEW_TIMEOUT_MS = String(DEFAULT_BUDGET_MS);

const { runClaudeText } = await import("../src/server/claude-cli.ts");

test("runClaudeText honours a caller's own timeoutMs", async () => {
  // The Tier 1 router passes a budget sized for Haiku emitting one small object; it must not
  // inherit the full reviewer's, which is sized for Opus reading 48 turns with the whole POLICY.
  // In `on` mode the router and the full review run serially, so a shared cap would let a
  // degraded API double the serial queue's worst case instead of failing fast into a route-up.
  const started = Date.now();
  await assert.rejects(runClaudeText("hi", { timeoutMs: CALLER_BUDGET_MS }), /timed out/);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < BOUNDARY_MS, `used the caller's budget, not the full review's (took ${elapsed}ms)`);
});

test("runClaudeText defaults to the full review's budget when no timeout is given", async () => {
  // Tier 2 is deliberately unchanged: an absent `timeoutMs` still means REVIEW_TIMEOUT_MS.
  const started = Date.now();
  await assert.rejects(runClaudeText("hi"), /timed out/);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= BOUNDARY_MS, `waited the full review's budget, not a caller's (took ${elapsed}ms)`);
});
