import { after, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";

const home = mkdtempSync(join(tmpdir(), "mission-usage-poller-"));
process.env.MISSION_HOME = home;
process.env.MISSION_USAGE_POLL_MS = "15";

const { Registry } = await import("../src/server/registry.ts");
const { startUsagePoller, usageSourceKey } = await import("../src/server/usage.ts");
const {
  commitUsageRead,
  openDb,
  recordAutomationUsage,
  reportedUsageLedgerHasRows,
  usageCursorFor,
} = await import("../src/server/db.ts");

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

test("reported automation usage does not masquerade as Claude session telemetry", () => {
  recordAutomationUsage({
    role: "foreman:review",
    agent: "claude",
    runId: "reported-automation-only",
    ts: Date.now(),
    models: [{
      modelId: "claude-opus-5",
      input: 100,
      output: 10,
      reasoningOutput: 0,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: 0.01,
      basis: "reported",
      pricingVersion: "",
    }],
  });
  assert.equal(reportedUsageLedgerHasRows(), false);
});

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
    assert.equal(usageCursorFor(usageSourceKey("codex", "conversation-42", path)).offset, Buffer.byteLength(
      `${sessionMeta}\n${turn}\n${token("2026-07-22T12:00:00.000Z")}\n${token("2026-07-22T12:01:00.000Z")}\n`,
    ));
  } finally {
    stop();
  }
});

test("a shortened live source stays quarantined until its proven path changes", async () => {
  const path = join(home, "rollout-reset.jsonl");
  const sessionMeta = JSON.stringify({
    timestamp: "2026-07-22T12:59:00.000Z",
    type: "session_meta",
    payload: {
      id: "conversation-reset",
      timestamp: "2026-07-22T12:59:00.000Z",
      cwd: "/repo-reset",
      source: "cli",
    },
  });
  const turn = JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-sol" } });
  writeFileSync(path, `${sessionMeta}\n${turn}\n${token("2026-07-22T13:00:00.000Z")}\n`);
  const registry = new Registry();
  const discovered = {
    syntheticId: "codex-reset",
    agent: "codex",
    name: "codex",
    nameSource: "process",
    cwd: "/repo-reset",
    gitBranch: "main",
    gitRoot: null,
    repoRoot: null,
    nomistakesGated: false,
    pid: 43,
    tty: "ttys43",
    terminals: [],
    startedAt: 0,
    agentSessionId: "conversation-reset",
    transcriptPath: path,
  } satisfies DiscoveredSession;
  registry.applyDiscovery([discovered]);
  const stop = startUsagePoller(registry);
  const originalWarn = console.warn;
  let rejected = false;
  console.warn = (...args: unknown[]) => {
    if (String(args[0]).includes("refusing rewritten source")) rejected = true;
    originalWarn(...args);
  };
  try {
    await eventually(() => registry.getSession("codex-reset")?.cost?.input === 700);
    const sourceKey = usageSourceKey("codex", "conversation-reset", path);
    const committedOffset = usageCursorFor(sourceKey).offset;

    // First make the rewrite observably shorter so the poller rejects it. Then grow it
    // beyond the old cursor with a changed event. A one-tick rejection would ingest that
    // event; a quarantined source remains fixed at the original summary.
    writeFileSync(path, `${sessionMeta}\n`);
    await eventually(() => rejected);
    const shortBytes = Buffer.byteLength(`${sessionMeta}\n`);
    appendFileSync(
      path,
      `${" ".repeat(committedOffset - shortBytes)}\n${token("2026-07-22T13:01:00.000Z")}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(registry.getSession("codex-reset")?.cost?.input, 700);
    assert.equal(usageCursorFor(sourceKey).offset, committedOffset);

    // A different concrete path is a new proven source identity. It starts at its own
    // cursor while the rejected path remains quarantined.
    const nextPath = join(home, "rollout-reset-next.jsonl");
    writeFileSync(nextPath, `${sessionMeta}\n${turn}\n${token("2026-07-22T13:02:00.000Z")}\n`);
    registry.applyDiscovery([{ ...discovered, transcriptPath: nextPath }]);
    await eventually(() => registry.getSession("codex-reset")?.cost?.input === 1_400);
    assert.ok(usageCursorFor(usageSourceKey("codex", "conversation-reset", nextPath)).offset > 0);
  } finally {
    console.warn = originalWarn;
    stop();
  }
});

test("a same-inode truncate-and-regrow cannot cross a rollout session header", async () => {
  const path = join(home, "rollout-regrown.jsonl");
  const meta = (id: string) => JSON.stringify({
    timestamp: "2026-07-22T13:29:00.000Z",
    type: "session_meta",
    payload: {
      id,
      timestamp: "2026-07-22T13:29:00.000Z",
      cwd: "/repo-regrown",
      source: "cli",
    },
  });
  const oldId = "conversation-old";
  const newId = "conversation-new";
  const turn = JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-sol" } });
  const initial = `${meta(oldId)}\n${turn}\n${token("2026-07-22T13:30:00.000Z")}\n`;
  writeFileSync(path, initial);
  const registry = new Registry();
  registry.applyDiscovery([{
    syntheticId: "codex-regrown",
    agent: "codex",
    name: "codex",
    nameSource: "process",
    cwd: "/repo-regrown",
    gitBranch: "main",
    gitRoot: null,
    repoRoot: null,
    nomistakesGated: false,
    pid: 45,
    tty: "ttys45",
    terminals: [],
    startedAt: 0,
    agentSessionId: oldId,
    transcriptPath: path,
  } satisfies DiscoveredSession]);
  const stop = startUsagePoller(registry);
  const originalWarn = console.warn;
  let rejected = false;
  console.warn = (...args: unknown[]) => {
    if (String(args[0]).includes("contradictory session")) rejected = true;
    originalWarn(...args);
  };
  try {
    await eventually(() => registry.getSession("codex-regrown")?.cost?.input === 700);
    const sourceKey = usageSourceKey("codex", oldId, path);
    const committed = usageCursorFor(sourceKey);
    const inode = statSync(path).ino;

    // writeFileSync truncates and regrows this same inode between event-loop turns. The
    // replacement is the same size, so neither the old size guard nor file identity alone
    // can distinguish it; only the revalidated session_meta prevents cross-attribution.
    const replacement = `${meta(newId)}\n${turn}\n${token("2026-07-22T13:31:00.000Z")}\n`;
    assert.equal(Buffer.byteLength(replacement), Buffer.byteLength(initial));
    writeFileSync(path, replacement);
    assert.equal(statSync(path).ino, inode);

    await eventually(() => rejected);
    assert.equal(registry.getSession("codex-regrown")?.cost?.input, 700);
    assert.deepEqual(usageCursorFor(sourceKey), committed);
  } finally {
    console.warn = originalWarn;
    stop();
  }
});

test("an observed byte-idle source refreshes its cursor retention timestamp", async () => {
  const path = join(home, "rollout-idle.jsonl");
  const sessionMeta = JSON.stringify({
    timestamp: "2026-07-22T13:59:00.000Z",
    type: "session_meta",
    payload: {
      id: "conversation-idle",
      timestamp: "2026-07-22T13:59:00.000Z",
      cwd: "/repo-idle",
      source: "cli",
    },
  });
  const turn = JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-sol" } });
  const contents = `${sessionMeta}\n${turn}\n${token("2026-07-22T14:00:00.000Z")}\n`;
  writeFileSync(path, contents);
  const sourceKey = usageSourceKey("codex", "conversation-idle", path);
  commitUsageRead({
    sourceKey,
    noteKey: "conversation-idle",
    sessionId: "codex-idle",
    agent: "codex",
    cursor: {
      offset: Buffer.byteLength(contents),
      modelId: "gpt-5.6-sol",
      discardPartial: false,
      fileId: null,
    },
    events: [],
    updatedAt: 1,
  });
  const registry = new Registry();
  registry.applyDiscovery([{
    syntheticId: "codex-idle",
    agent: "codex",
    name: "codex",
    nameSource: "process",
    cwd: "/repo-idle",
    gitBranch: "main",
    gitRoot: null,
    repoRoot: null,
    nomistakesGated: false,
    pid: 44,
    tty: "ttys44",
    terminals: [],
    startedAt: 0,
    agentSessionId: "conversation-idle",
    transcriptPath: path,
  } satisfies DiscoveredSession]);
  const stop = startUsagePoller(registry);
  try {
    await eventually(() => {
      const row = openDb()
        .prepare(`SELECT updated_at FROM usage_sources WHERE source_key = ?`)
        .get(sourceKey) as { updated_at: number } | undefined;
      return (row?.updated_at ?? 0) > 1;
    });
    assert.equal(usageCursorFor(sourceKey).offset, Buffer.byteLength(contents));
  } finally {
    stop();
  }
});
