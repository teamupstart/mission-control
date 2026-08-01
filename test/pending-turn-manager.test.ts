import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { InjectResult } from "../src/server/actions.ts";
import { mkMuxHandle } from "./helpers/session-fixture.ts";

const home = mkdtempSync(join(tmpdir(), "mission-pending-turn-manager-"));
process.env.MISSION_HOME = home;

const { claimNextPendingTurn, createPendingTurn, listPendingTurns, clearPendingTurns } =
  await import("../src/server/db.ts");
const { PendingTurnManager } = await import("../src/server/pending-turns.ts");
const { Registry } = await import("../src/server/registry.ts");
const { resetSession } = await import("../src/server/reset.ts");

after(() => rmSync(home, { recursive: true, force: true }));

const tick = (ms = 8) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function sdkFixture(name: string, send: (text: string) => Promise<"started" | null>) {
  const registry = new Registry();
  const id = `sdk:${name}`;
  const key = `conversation:${name}`;
  registry.registerSdkSession({
    id,
    agent: "claude",
    name,
    cwd: `/repo/${name}`,
    agentSessionId: key,
  });
  const calls: string[] = [];
  const manager = new PendingTurnManager(
    registry,
    {
      sendWhenIdle: async (_id, turn) => {
        calls.push(turn.text);
        return send(turn.text);
      },
    },
    { idleSettleMs: 0, pickupTimeoutMs: 15 },
  );
  manager.start();
  return { registry, manager, id, key, calls };
}

function idle(registry: InstanceType<typeof Registry>, id: string): void {
  registry.applyDriverEvent(id, { kind: "state", state: "idle", activity: null });
}

function working(registry: InstanceType<typeof Registry>, id: string): void {
  registry.applyDriverEvent(id, { kind: "state", state: "working", activity: null });
}

function discovered(name: string): DiscoveredSession {
  return {
    syntheticId: `terminal:${name}`,
    agent: "claude",
    name,
    nameSource: "process",
    cwd: `/repo/${name}`,
    gitBranch: "feature",
    nomistakesGated: false,
    pid: 10,
    tty: `tty-${name}`,
    terminals: [mkMuxHandle({ session: name, paneId: `%${name}` })],
    startedAt: Date.now() - 1_000,
  } as DiscoveredSession;
}

function stopHook(registry: InstanceType<typeof Registry>, name: string): void {
  registry.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: `agent:${name}`,
    cwd: `/repo/${name}`,
    transcriptPath: null,
    env: { tmuxPane: `%${name}` },
  });
}

function userPromptHook(registry: InstanceType<typeof Registry>, name: string): void {
  registry.applyHook({
    agent: "claude",
    event: "UserPromptSubmit",
    sessionId: `agent:${name}`,
    cwd: `/repo/${name}`,
    transcriptPath: null,
    env: { tmuxPane: `%${name}` },
  });
}

function terminalFixture(
  name: string,
  inject: (text: string) => Promise<InjectResult>,
  pickupTimeoutMs = 15,
) {
  const registry = new Registry();
  registry.applyDiscovery([discovered(name)]);
  stopHook(registry, name);
  const injected: string[] = [];
  const manager = new PendingTurnManager(
    registry,
    { sendWhenIdle: async () => "started" },
    {
      idleSettleMs: 0,
      pickupTimeoutMs,
      inject: async (_session, text) => {
        injected.push(text);
        return inject(text);
      },
    },
  );
  manager.start();
  return {
    registry,
    manager,
    id: `terminal:${name}`,
    key: `agent:${name}`,
    injected,
  };
}

test("busy SDK sessions retain editable text until confirmed idle", async () => {
  const f = sdkFixture("busy", async () => "started");
  working(f.registry, f.id);
  const submitted = f.manager.submit(f.id, "follow up after the current turn");
  assert.equal(submitted.delivery, "pending");
  assert.equal(f.registry.getSession(f.id)?.pendingTurns[0]?.text, "follow up after the current turn");
  await tick();
  assert.deepEqual(f.calls, []);

  idle(f.registry, f.id);
  await tick();
  assert.deepEqual(f.calls, ["follow up after the current turn"]);
  assert.deepEqual(f.registry.getSession(f.id)?.pendingTurns, []);
  f.manager.stop();
});

test("manager startup projects an interrupted delivery as uncertain without sending", () => {
  const registry = new Registry();
  const id = "sdk:startup-recovery";
  const key = "agent:startup-recovery";
  registry.registerSdkSession({
    id,
    agent: "claude",
    name: "recovered",
    cwd: "/repo/recovered",
    agentSessionId: key,
  });
  createPendingTurn({ id: "startup-row", noteKey: key, text: "maybe sent", now: 1 });
  claimNextPendingTurn(key, 2);
  let sends = 0;
  const manager = new PendingTurnManager(registry, {
    sendWhenIdle: async () => {
      sends += 1;
      return "started";
    },
  });
  assert.equal(listPendingTurns(key)[0]?.state, "sending", "construction performs no DB recovery");
  assert.equal(sends, 0);
  manager.start();
  const recovered = registry.getSession(id)?.pendingTurns[0];
  assert.equal(recovered?.state, "uncertain");
  assert.match(recovered?.lastError ?? "", /restarted during delivery/);
  assert.equal(sends, 0);
  manager.stop();
  clearPendingTurns(key);
});

test("the manager sends one FIFO row per observed completion", async () => {
  const f = sdkFixture("fifo", async () => "started");
  working(f.registry, f.id);
  f.manager.submit(f.id, "first");
  f.manager.submit(f.id, "second");
  idle(f.registry, f.id);
  await tick();
  assert.deepEqual(f.calls, ["first"]);
  assert.deepEqual(f.registry.getSession(f.id)?.pendingTurns.map((turn) => turn.text), ["second"]);

  working(f.registry, f.id);
  idle(f.registry, f.id);
  await tick();
  assert.deepEqual(f.calls, ["first", "second"]);
  assert.deepEqual(f.registry.getSession(f.id)?.pendingTurns, []);
  f.manager.stop();
});

test("a driver busy result returns the claimed row to the editable queue", async () => {
  const f = sdkFixture("driver-race", async () => null);
  idle(f.registry, f.id);
  f.manager.submit(f.id, "do not steer this into active work");
  await tick();
  const turn = f.registry.getSession(f.id)?.pendingTurns[0];
  assert.equal(turn?.state, "queued");
  assert.equal(turn?.revision, 2);
  assert.match(turn?.lastError ?? "", /became busy/);
  assert.deepEqual(f.calls, ["do not steer this into active work"]);
  f.manager.stop();
  clearPendingTurns(f.key);
});

test("a driver rejection is positive non-delivery and remains safely retryable", async () => {
  const f = sdkFixture("driver-error", async () => {
    throw new Error("driver refused before acceptance");
  });
  idle(f.registry, f.id);
  f.manager.submit(f.id, "keep me editable");
  await tick();
  const turn = f.registry.getSession(f.id)?.pendingTurns[0];
  assert.equal(turn?.state, "queued");
  assert.equal(turn?.lastError, "driver refused before acceptance");
  f.manager.stop();
  clearPendingTurns(f.key);
});

test("an open driver dialog blocks delivery until the dialog resolves", async () => {
  const f = sdkFixture("dialog", async () => "started");
  idle(f.registry, f.id);
  f.registry.applyDriverEvent(f.id, {
    kind: "request",
    request: {
      id: "ask-1",
      kind: "permission",
      prompt: "Allow this?",
      options: [{ number: 1, label: "Yes" }],
    },
  });
  f.manager.submit(f.id, "wait for the answer");
  await tick();
  assert.deepEqual(f.calls, []);
  f.registry.applyDriverEvent(f.id, { kind: "request_resolved", requestId: "ask-1" });
  await tick();
  assert.deepEqual(f.calls, ["wait for the answer"]);
  f.manager.stop();
});

test("terminal rows remain sending until a hook proves prompt pickup", async () => {
  const f = terminalFixture("pickup", async () => ({
    ok: true,
    pasted: true,
    submitVerified: false,
  }));
  f.manager.submit(f.id, "terminal follow up");
  await tick();
  assert.deepEqual(f.injected, ["terminal follow up"]);
  assert.equal(f.registry.getSession(f.id)?.pendingTurns[0]?.state, "sending");
  userPromptHook(f.registry, "pickup");
  await tick();
  assert.deepEqual(f.registry.getSession(f.id)?.pendingTurns, []);
  f.manager.stop();
});

test("a verified terminal submit completes without waiting for a second lifecycle signal", async () => {
  const f = terminalFixture("verified-pickup", async () => ({
    ok: true,
    pasted: true,
    submitVerified: true,
  }));
  f.manager.submit(f.id, "verified terminal follow up");
  await tick();
  assert.deepEqual(f.injected, ["verified terminal follow up"]);
  assert.deepEqual(f.registry.getSession(f.id)?.pendingTurns, []);
  f.manager.stop();
});

test("a terminal refusal before paste returns to queued", async () => {
  const f = terminalFixture("refusal", async () => ({
    ok: false,
    error: "pane was in copy mode",
    pasted: false,
    submitVerified: false,
  }));
  f.manager.submit(f.id, "safe to retry");
  await tick();
  const turn = f.registry.getSession(f.id)?.pendingTurns[0];
  assert.equal(turn?.state, "queued");
  assert.equal(turn?.lastError, "pane was in copy mode");
  f.manager.stop();
  clearPendingTurns(f.key);
});

test("an unconfirmed terminal success becomes uncertain instead of duplicating", async () => {
  const f = terminalFixture(
    "timeout",
    async () => ({ ok: true, pasted: true, submitVerified: false }),
    10,
  );
  f.manager.submit(f.id, "possibly delivered");
  await tick(30);
  const turn = f.registry.getSession(f.id)?.pendingTurns[0];
  assert.equal(turn?.state, "uncertain");
  assert.match(turn?.lastError ?? "", /could not confirm/);
  f.manager.stop();
  clearPendingTurns(f.key);
});

test("Codex terminal delivery follows passive rollout completion and pickup markers", async () => {
  const registry = new Registry();
  const name = "codex-passive";
  const key = `agent:${name}`;
  const terminal = {
    ...discovered(name),
    agent: "codex" as const,
    agentSessionId: key,
    transcriptPath: `/tmp/${name}.jsonl`,
  };
  registry.applyDiscovery([terminal]);
  registry.applyPassiveActivity(registry.getSession(terminal.syntheticId)!, {
    state: "working",
    lastActivity: Date.now() - 100,
  });
  registry.applyDiscovery([terminal]);

  const injected: string[] = [];
  const manager = new PendingTurnManager(
    registry,
    { sendWhenIdle: async () => "started" },
    {
      idleSettleMs: 0,
      pickupTimeoutMs: 100,
      inject: async (_session, text) => {
        injected.push(text);
        return { ok: true, pasted: true, submitVerified: false };
      },
    },
  );
  manager.start();
  manager.submit(terminal.syntheticId, "wait for task_complete");
  await tick();
  assert.deepEqual(injected, [], "a task_started rollout remains busy");

  registry.applyPassiveActivity(registry.getSession(terminal.syntheticId)!, {
    state: "idle",
    lastActivity: Date.now(),
  });
  registry.applyDiscovery([terminal]);
  await tick();
  assert.deepEqual(injected, ["wait for task_complete"]);
  assert.equal(registry.getSession(terminal.syntheticId)?.pendingTurns[0]?.state, "sending");

  registry.applyPassiveActivity(registry.getSession(terminal.syntheticId)!, {
    state: "working",
    lastActivity: Date.now() + 1,
  });
  registry.applyDiscovery([terminal]);
  await tick();
  assert.deepEqual(registry.getSession(terminal.syntheticId)?.pendingTurns, []);
  manager.stop();
});

test("an exception after an unknown terminal write fails closed", async () => {
  const f = terminalFixture("exception", async () => {
    throw new Error("terminal transport disconnected");
  });
  f.manager.submit(f.id, "do not duplicate me");
  await tick();
  const turn = f.registry.getSession(f.id)?.pendingTurns[0];
  assert.equal(turn?.state, "uncertain");
  assert.equal(turn?.lastError, "terminal transport disconnected");
  f.manager.stop();
  clearPendingTurns(f.key);
});

test("recall removes only the newest queued row and returns its exact text", () => {
  const f = sdkFixture("recall", async () => "started");
  working(f.registry, f.id);
  const first = f.manager.submit(f.id, "first draft").pendingTurn!;
  const second = f.manager.submit(f.id, "second draft\nwith formatting").pendingTurn!;
  assert.equal(f.manager.recall(f.id, first.id, first.revision), null);
  assert.equal(
    f.manager.recall(f.id, second.id, second.revision)?.text,
    "second draft\nwith formatting",
  );
  assert.deepEqual(f.registry.getSession(f.id)?.pendingTurns.map((turn) => turn.id), [first.id]);
  f.manager.stop();
  clearPendingTurns(f.key);
});

test("a late SDK binding carries and clears the claimed synthetic-key row", async () => {
  const registry = new Registry();
  const id = "sdk:late-binding";
  registry.registerSdkSession({ id, agent: "claude", name: "late", cwd: "/repo/late" });
  let accept!: (value: "started") => void;
  const accepted = new Promise<"started">((resolve) => (accept = resolve));
  const manager = new PendingTurnManager(
    registry,
    { sendWhenIdle: async () => accepted },
    { idleSettleMs: 0 },
  );
  manager.start();
  idle(registry, id);
  manager.submit(id, "written before bind");
  await tick();
  assert.equal(listPendingTurns(id)[0]?.state, "sending");
  registry.applyDriverEvent(id, {
    kind: "bound",
    agentSessionId: "agent:late-binding",
    transcriptPath: null,
    modelId: null,
    pid: null,
  });
  assert.deepEqual(listPendingTurns(id), []);
  assert.equal(listPendingTurns("agent:late-binding")[0]?.text, "written before bind");
  accept("started");
  await tick();
  assert.deepEqual(registry.getSession(id)?.pendingTurns, []);
  manager.stop();
});

test("a successful session reset clears pending turns authored for discarded work", async () => {
  const f = sdkFixture("reset", async () => "started");
  working(f.registry, f.id);
  f.manager.submit(f.id, "obsolete after reset");
  const session = f.registry.getSession(f.id)!;
  const result = await resetSession(
    f.registry,
    session,
    false,
    async () => ({
      ok: true,
      error: null,
      root: "/repo/reset",
      cleared: false,
      detached: false,
    }),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(f.registry.getSession(f.id)?.pendingTurns, []);
  assert.deepEqual(listPendingTurns(f.key), []);
  f.manager.stop();
});
