import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `review.ts` reads the claude binary and the full-review budget from the env at module load,
// so both are pinned BEFORE importing it. The fake bin never exits, which exercises the real
// spawn + timeout + process-group-kill path rather than a stubbed promise.
const dir = mkdtempSync(join(tmpdir(), "foreman-review-"));
const fakeBin = join(dir, "fake-claude.sh");
writeFileSync(fakeBin, "#!/bin/sh\nsleep 30\n");
chmodSync(fakeBin, 0o755);
process.env.FOREMAN_CLAUDE_BIN = fakeBin;
process.env.FOREMAN_REVIEW_TIMEOUT_MS = "400";

const { runClaudeText } = await import("../src/server/foreman/review.ts");

test("runClaudeText honours a caller's own timeoutMs", async () => {
  // The Tier 1 router passes a budget sized for Haiku emitting one small object; it must not
  // inherit the full reviewer's, which is sized for Opus reading 48 turns with the whole POLICY.
  // In `on` mode the router and the full review run serially, so a shared cap would let a
  // degraded API double the serial queue's worst case instead of failing fast into a route-up.
  const started = Date.now();
  await assert.rejects(runClaudeText("hi", { timeoutMs: 120 }), /timed out/);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 400, `used the caller's budget, not the full review's (took ${elapsed}ms)`);
});

test("runClaudeText defaults to the full review's budget when no timeout is given", async () => {
  // Tier 2 is deliberately unchanged: an absent `timeoutMs` still means REVIEW_TIMEOUT_MS.
  const started = Date.now();
  await assert.rejects(runClaudeText("hi"), /timed out/);
  assert.ok(Date.now() - started >= 400, "waited the full review budget (pinned to 400ms here)");
});
