import { after, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";

const home = mkdtempSync(join(tmpdir(), "mission-usage-poller-"));
process.env.MISSION_HOME = home;
process.env.MISSION_USAGE_POLL_MS = "15";

const { Registry } = await import("../src/server/registry.ts");
const { startUsagePoller } = await import("../src/server/usage.ts");
const { reportedUsageLedgerHasRows, usageCursorFor } = await import("../src/server/db.ts");

after(() => rmSync(home, { recursive: true, force: true }));

function token(ts: string): string {
  return JSON.stringify({
    timestamp: ts,
    type: "event_msg",
    payload: { type: "token_count", info: { last_token_usage: {
      input_tokens: 1_000, cached_input_tokens: 200, cache_write_input_tokens: 100,
      output_tokens: 50, reasoning_output_tokens: 10,
    } } },
  });
}

async function eventually(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition did not become true before timeout");
}

test("the poller prices a proven Codex rollout once and performs a final exit drain", async () => {
  const path = join(home, "rollout.jsonl");
  const sessionMeta = JSON.stringify({
    timestamp: "2026-07-22T11:59:00.000Z",
    type: "session_meta",
    payload: {
      id: "conversation-42",
      timestamp: "2026-07-22T11:59:00.000Z",
      cwd: "/repo",
      source: "cli",
    },
  });
  const turn = JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-sol" } });
  writeFileSync(path, `${sessionMeta}\n${turn}\n${token("2026-07-22T12:00:00.000Z")}\n`);
  const registry = new Registry();
  const discovered = {
    syntheticId: "codex-live",
    agent: "codex",
    name: "codex",
    nameSource: "process",
    cwd: "/repo",
    gitBranch: "main",
    gitRoot: null,
    repoRoot: null,
    nomistakesGated: false,
    pid: 42,
    tty: "ttys42",
    terminals: [],
    startedAt: 0,
    agentSessionId: "conversation-42",
    transcriptPath: path,
  } satisfies DiscoveredSession;
  registry.applyDiscovery([discovered]);
  const stop = startUsagePoller(registry);
  try {
    await eventually(() => registry.getSession("codex-live")?.cost?.basis === "api-equivalent");
    const first = registry.getSession("codex-live")?.cost;
    assert.equal(first?.input, 700);
    assert.equal(first?.pricingModels[0], "gpt-5.6-sol");
    assert.ok((first?.costUsd ?? 0) > 0);
    assert.equal(reportedUsageLedgerHasRows(), false, "Codex estimates do not masquerade as Claude telemetry");

    // Exit before the writer's final flush. The source is no longer in liveSessions(), but
    // the held source receives the planned grace drain and records the appended request.
    registry.applyDiscovery([]);
    appendFileSync(path, `${token("2026-07-22T12:01:00.000Z")}\n`);
    await eventually(() => registry.getSession("codex-live")?.cost?.input === 1_400);
    assert.equal(usageCursorFor("codex:conversation-42").offset, Buffer.byteLength(
      `${sessionMeta}\n${turn}\n${token("2026-07-22T12:00:00.000Z")}\n${token("2026-07-22T12:01:00.000Z")}\n`,
    ));
  } finally {
    stop();
  }
});
