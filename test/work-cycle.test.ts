import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentType } from "@shared/types.ts";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import { mkMuxHandle } from "./helpers/session-fixture.ts";

const home = mkdtempSync(join(tmpdir(), "mission-work-cycle-"));
process.env.MISSION_HOME = home;

const { hooksEverSeen, openDb, workCycleFor } = await import("../src/server/db.ts");
const { Registry, SDK_SESSION_ID_PREFIX } = await import("../src/server/registry.ts");

after(() => rmSync(home, { recursive: true, force: true }));

openDb();

function discovered(
  agent: AgentType,
  syntheticId: string,
  paneId: string,
): DiscoveredSession {
  return {
    syntheticId,
    agent,
    name: `${agent} work`,
    nameSource: "process",
    cwd: "/repo",
    gitBranch: "feature/work-cycle",
    gitRoot: "/repo",
    repoRoot: "/repo",
    pid: Number(paneId.replace(/\D/g, "")) || 1,
    tty: `ttys${paneId.replace(/\D/g, "") || "1"}`,
    terminals: [mkMuxHandle({ paneId })],
    startedAt: 1,
  } as DiscoveredSession;
}

function applyTerminalHook(input: {
  registry: InstanceType<typeof Registry>;
  agent: "claude" | "codex";
  event: string;
  logicalKey: string;
  paneId: string;
  ts: number;
  prompt?: string;
  message?: string;
  toolName?: string;
  source?: string;
}): void {
  input.registry.applyHook({
    agent: input.agent,
    event: input.event,
    sessionId: input.logicalKey,
    cwd: "/repo",
    transcriptPath: null,
    env: { tmuxPane: input.paneId },
    ts: input.ts,
    prompt: input.prompt,
    message: input.message,
    toolName: input.toolName,
    source: input.source,
  });
}

test("Claude and Codex terminal turns share one durable generation contract", () => {
  for (const [index, agent] of (["claude", "codex"] as const).entries()) {
    const registry = new Registry();
    const syntheticId = `terminal-${agent}`;
    const logicalKey = `${agent}-conversation-1`;
    const paneId = `%${20 + index}`;
    registry.applyDiscovery([discovered(agent, syntheticId, paneId)]);

    applyTerminalHook({
      registry,
      agent,
      event: "UserPromptSubmit",
      logicalKey,
      paneId,
      ts: 1_000 + index,
      prompt: "Implement the durable lifecycle",
    });
    assert.deepEqual(registry.getSession(syntheticId)?.workCycle, {
      logicalKey,
      generation: 0,
      active: true,
      completedAt: null,
      updatedAt: registry.getSession(syntheticId)?.workCycle?.updatedAt,
    });

    const completedAt = 2_000 + index;
    applyTerminalHook({
      registry,
      agent,
      event: "Stop",
      logicalKey,
      paneId,
      ts: completedAt,
    });
    const completed = registry.getSession(syntheticId)?.workCycle;
    assert.equal(completed?.logicalKey, logicalKey);
    assert.equal(completed?.generation, 1);
    assert.equal(completed?.active, false);
    assert.equal(completed?.completedAt, completedAt);
    assert.deepEqual(workCycleFor(logicalKey), completed, "the wire projection follows SQLite");

    applyTerminalHook({
      registry,
      agent,
      event: "Stop",
      logicalKey,
      paneId,
      ts: completedAt + 1,
    });
    assert.equal(
      registry.getSession(syntheticId)?.workCycle?.generation,
      1,
      "a duplicate turn end without new work does not advance",
    );
  }
});

test("a Claude task notification arms work without becoming human intent", () => {
  const registry = new Registry();
  const syntheticId = "terminal-machine-continuation";
  const logicalKey = "claude-machine-continuation";
  const paneId = "%31";
  registry.applyDiscovery([discovered("claude", syntheticId, paneId)]);

  applyTerminalHook({
    registry,
    agent: "claude",
    event: "UserPromptSubmit",
    logicalKey,
    paneId,
    ts: 3_000,
    prompt:
      "<task-notification>\n<task-id>background-1</task-id>\n<status>completed</status>\n</task-notification>",
  });

  assert.equal(registry.getGoal(syntheticId), null, "machine scaffolding is still excluded from intent");
  assert.equal(registry.getSession(syntheticId)?.workCycle?.active, true);

  applyTerminalHook({
    registry,
    agent: "claude",
    event: "Stop",
    logicalKey,
    paneId,
    ts: 3_100,
  });
  assert.equal(registry.getSession(syntheticId)?.workCycle?.generation, 1);
});

test("idle noise, duplicate ends, and late activity do not invent a completion", () => {
  const registry = new Registry();
  const syntheticId = "terminal-noise";
  const logicalKey = "claude-noise";
  const paneId = "%32";
  registry.applyDiscovery([discovered("claude", syntheticId, paneId)]);

  applyTerminalHook({
    registry,
    agent: "claude",
    event: "Notification",
    logicalKey,
    paneId,
    ts: 4_000,
    message: "Claude is waiting for your input",
  });
  assert.equal(registry.getSession(syntheticId)?.workCycle, undefined);

  applyTerminalHook({
    registry,
    agent: "claude",
    event: "UserPromptSubmit",
    logicalKey,
    paneId,
    ts: 4_100,
    prompt: "Run the checks",
  });
  applyTerminalHook({
    registry,
    agent: "claude",
    event: "Stop",
    logicalKey,
    paneId,
    ts: 4_200,
  });
  applyTerminalHook({
    registry,
    agent: "claude",
    event: "Stop",
    logicalKey,
    paneId,
    ts: 4_300,
  });
  assert.equal(registry.getSession(syntheticId)?.workCycle?.generation, 1);

  applyTerminalHook({
    registry,
    agent: "claude",
    event: "PostToolUse",
    logicalKey,
    paneId,
    ts: 4_400,
    toolName: "Bash",
  });
  const late = registry.getSession(syntheticId)?.workCycle;
  assert.equal(late?.generation, 1, "activity alone is not another completion");
  assert.equal(late?.active, true, "the later turn end, not the activity event, will complete it");
});

test("Claude and Codex SDK events use the same transition and do not count as hooks", () => {
  const cases = [
    ["claude", `${SDK_SESSION_ID_PREFIX}11111111-1111-4111-8111-111111111111`, "sdk-claude-cycle"],
    ["codex", `${SDK_SESSION_ID_PREFIX}22222222-2222-4222-8222-222222222222`, "sdk-codex-cycle"],
  ] as const;

  for (const [agent, id, logicalKey] of cases) {
    const registry = new Registry();
    registry.registerSdkSession({ id, agent, name: `${agent} sdk`, cwd: "/repo", agentSessionId: logicalKey });

    registry.applyDriverEvent(id, { kind: "state", state: "working", activity: "working" });
    assert.equal(registry.getSession(id)?.workCycle?.active, true);
    registry.applyDriverEvent(id, { kind: "turn_done", usage: null });
    assert.equal(registry.getSession(id)?.workCycle?.generation, 1);
    assert.equal(registry.getSession(id)?.workCycle?.active, false);

    registry.applyDriverEvent(id, { kind: "turn_done", usage: null });
    assert.equal(registry.getSession(id)?.workCycle?.generation, 1);
    assert.equal(hooksEverSeen(id), false, "SDK lifecycle state stays out of session_events");
  }
});

test("restart preserves armed work and the latest completed generation", () => {
  const syntheticId = "terminal-restart-cycle";
  const logicalKey = "restart-conversation";
  const paneId = "%41";
  const observation = discovered("claude", syntheticId, paneId);

  const first = new Registry();
  first.applyDiscovery([observation]);
  applyTerminalHook({
    registry: first,
    agent: "claude",
    event: "UserPromptSubmit",
    logicalKey,
    paneId,
    ts: 5_000,
    prompt: "Keep this active across restart",
  });
  assert.equal(first.getSession(syntheticId)?.workCycle?.active, true);

  const restarted = new Registry();
  restarted.applyDiscovery([observation]);
  assert.equal(restarted.getSession(syntheticId)?.workCycle?.logicalKey, logicalKey);
  assert.equal(restarted.getSession(syntheticId)?.workCycle?.active, true);

  applyTerminalHook({
    registry: restarted,
    agent: "claude",
    event: "Stop",
    logicalKey,
    paneId,
    ts: 5_100,
  });
  assert.equal(restarted.getSession(syntheticId)?.workCycle?.generation, 1);

  const restartedAgain = new Registry();
  restartedAgain.applyDiscovery([observation]);
  assert.equal(restartedAgain.getSession(syntheticId)?.workCycle?.generation, 1);
  assert.equal(restartedAgain.getSession(syntheticId)?.workCycle?.active, false);
});

test("an SDK restart restores active state before the later turn completion", () => {
  const id = `${SDK_SESSION_ID_PREFIX}33333333-3333-4333-8333-333333333333`;
  const logicalKey = "sdk-restart-cycle";
  const first = new Registry();
  first.registerSdkSession({ id, agent: "claude", name: "sdk restart", cwd: "/repo", agentSessionId: logicalKey });
  first.applyDriverEvent(id, { kind: "state", state: "working", activity: null });

  const restarted = new Registry();
  restarted.registerSdkSession({ id, agent: "claude", name: "sdk restart", cwd: "/repo", agentSessionId: logicalKey });
  assert.equal(restarted.getSession(id)?.workCycle?.active, true);
  restarted.applyDriverEvent(id, { kind: "turn_done", usage: null });
  assert.equal(restarted.getSession(id)?.workCycle?.generation, 1);
});

test("an SDK completion advances while a queued turn keeps the card working", () => {
  const id = `${SDK_SESSION_ID_PREFIX}44444444-4444-4444-8444-444444444444`;
  const registry = new Registry();
  registry.registerSdkSession({
    id,
    agent: "codex",
    name: "sdk queued",
    cwd: "/repo",
    agentSessionId: "sdk-queued-cycle",
  });
  registry.applyDriverEvent(id, { kind: "state", state: "working", activity: "first turn" });

  registry.applyDriverEvent(id, { kind: "turn_done", usage: null }, { deferIdle: true });
  assert.equal(registry.getSession(id)?.state, "working", "no transient idle was projected");
  assert.equal(registry.getSession(id)?.workCycle?.generation, 1);
  assert.equal(registry.getSession(id)?.workCycle?.active, false);

  registry.applyDriverEvent(id, { kind: "state", state: "working", activity: "queued turn" });
  assert.equal(registry.getSession(id)?.workCycle?.generation, 1);
  assert.equal(registry.getSession(id)?.workCycle?.active, true);
});

test("a driver rebind selects fresh lifecycle state", () => {
  const id = `${SDK_SESSION_ID_PREFIX}55555555-5555-4555-8555-555555555555`;
  const firstKey = "sdk-before-rebind";
  const nextKey = "sdk-after-rebind";
  const registry = new Registry();
  registry.registerSdkSession({
    id,
    agent: "claude",
    name: "sdk rebind",
    cwd: "/repo",
    agentSessionId: firstKey,
  });
  registry.applyDriverEvent(id, { kind: "state", state: "working", activity: null });
  registry.applyDriverEvent(id, { kind: "turn_done", usage: null });
  assert.equal(registry.getSession(id)?.workCycle?.generation, 1);

  registry.applyDriverEvent(id, {
    kind: "bound",
    agentSessionId: nextKey,
    transcriptPath: null,
    modelId: null,
    pid: null,
    cleared: true,
  });
  assert.equal(registry.getSession(id)?.workCycle, undefined);
  assert.equal(workCycleFor(firstKey)?.generation, 1, "the old conversation remains intact");
});

test("a final SDK completion persists without reviving a stopping card", () => {
  const id = `${SDK_SESSION_ID_PREFIX}66666666-6666-4666-8666-666666666666`;
  const registry = new Registry();
  registry.registerSdkSession({
    id,
    agent: "claude",
    name: "sdk stopping",
    cwd: "/repo",
    agentSessionId: "sdk-stopping-cycle",
  });
  registry.applyDriverEvent(id, { kind: "state", state: "working", activity: null });
  registry.markSessionStopping(id);

  registry.applyDriverEvent(id, { kind: "turn_done", usage: null });
  assert.equal(registry.getSession(id)?.state, "stopping");
  assert.equal(registry.getSession(id)?.workCycle?.generation, 1);
  assert.equal(registry.getSession(id)?.workCycle?.active, false);
});

test("logical conversation rotation starts from fresh state", () => {
  const registry = new Registry();
  const syntheticId = "terminal-clear-cycle";
  const firstKey = "before-clear";
  const nextKey = "after-clear";
  const paneId = "%51";
  registry.applyDiscovery([discovered("claude", syntheticId, paneId)]);

  applyTerminalHook({
    registry,
    agent: "claude",
    event: "UserPromptSubmit",
    logicalKey: firstKey,
    paneId,
    ts: 6_000,
    prompt: "Finish the old conversation",
  });
  applyTerminalHook({
    registry,
    agent: "claude",
    event: "Stop",
    logicalKey: firstKey,
    paneId,
    ts: 6_100,
  });
  assert.equal(registry.getSession(syntheticId)?.workCycle?.generation, 1);

  applyTerminalHook({
    registry,
    agent: "claude",
    event: "SessionStart",
    logicalKey: nextKey,
    paneId,
    ts: 6_200,
    source: "clear",
  });
  assert.equal(registry.getSession(syntheticId)?.agentSessionId, nextKey);
  assert.equal(registry.getSession(syntheticId)?.workCycle, undefined);
  assert.equal(workCycleFor(firstKey)?.generation, 1, "rotation does not rewrite the old key");

  applyTerminalHook({
    registry,
    agent: "claude",
    event: "UserPromptSubmit",
    logicalKey: nextKey,
    paneId,
    ts: 6_300,
    prompt: "Begin the new conversation",
  });
  assert.equal(registry.getSession(syntheticId)?.workCycle?.generation, 0);
  assert.equal(registry.getSession(syntheticId)?.workCycle?.logicalKey, nextKey);
});

test("a hook that beats discovery is projected when the session first appears", () => {
  const registry = new Registry();
  const logicalKey = "pre-discovery-cycle";
  const paneId = "%61";

  applyTerminalHook({
    registry,
    agent: "codex",
    event: "UserPromptSubmit",
    logicalKey,
    paneId,
    ts: 7_000,
    prompt: "Arrive before the process poll",
  });
  registry.applyDiscovery([discovered("codex", "pre-discovery-terminal", paneId)]);

  assert.equal(registry.getSession("pre-discovery-terminal")?.workCycle?.logicalKey, logicalKey);
  assert.equal(registry.getSession("pre-discovery-terminal")?.workCycle?.active, true);
});
