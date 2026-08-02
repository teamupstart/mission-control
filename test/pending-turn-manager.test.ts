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

const {
  claimNextPendingTurn,
  createPendingTurn,
  listPendingTurns,
  clearPendingTurns,
  markPendingTurnUncertain,
} = await import("../src/server/db.ts");
const { PendingTurnManager } = await import("../src/server/pending-turns.ts");
const { Registry } = await import("../src/server/registry.ts");
const { resetSession } = await import("../src/server/reset.ts");

after(() => rmSync(home, { recursive: true, force: true }));

const tick = (ms = 8) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Poll instead of sleeping a fixed span, so a settle window costs its own length and no more. */
async function until(predicate: () => boolean, what: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await tick(5);
  }
}

function sdkFixture(
  name: string,
  send: (text: string) => Promise<"started" | null>,
  options: { idleSettleMs?: number; agent?: "claude" | "codex" } = {},
) {
  const registry = new Registry();
  const id = `sdk:${name}`;
  const key = `conversation:${name}`;
  registry.registerSdkSession({
    id,
    agent: options.agent ?? "claude",
    name,
    cwd: `/repo/${name}`,
    agentSessionId: key,
  });
  const calls: string[] = [];
  const manager = new PendingTurnManager(
    registry,
    {
      sendWhenIdle: async (_id, turn, beforeSend) => {
        calls.push(turn.text);
        const blocker = beforeSend?.();
        if (blocker) throw new Error(blocker);
        return send(turn.text);
      },
    },
    { idleSettleMs: options.idleSettleMs ?? 0, pickupTimeoutMs: 15 },
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
  inject: (text: string, beforeWrite: () => string | null) => Promise<InjectResult>,
  pickupTimeoutMs = 15,
  beforeBoundary: () => Promise<void> = async () => {},
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
      inject: async (_session, text, _deps, beforeWrite) => {
        await beforeBoundary();
        const guard = beforeWrite ?? (() => null);
        const blocker = guard();
        if (blocker) {
          return { ok: false, error: blocker, pasted: false, submitVerified: false };
        }
        injected.push(text);
        return inject(text, guard);
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

test("an embedded session's only idle transition still drains the queued row", async () => {
  // The settle window is the entire point of this case, and every other SDK test here sets
  // it to zero. A driver reports idle with `lastActivity` set to that same instant, so the
  // session is NEVER already settled when the transition arrives - and unlike a terminal
  // card, which the discovery poller sweeps every `DEFAULT_POLL_MS`, nothing asks an
  // embedded session again. The transition below is the only chance the outbox gets.
  const f = sdkFixture("settle", async () => "started", { idleSettleMs: 40, agent: "codex" });
  working(f.registry, f.id);
  assert.equal(f.manager.submit(f.id, "deliver me after the settle window").ok, true);
  await tick();
  assert.deepEqual(f.calls, []);

  idle(f.registry, f.id);
  await until(() => f.calls.length > 0, "the queued turn to be delivered");
  assert.deepEqual(f.calls, ["deliver me after the settle window"]);
  assert.deepEqual(f.registry.getSession(f.id)?.pendingTurns, []);
  f.manager.stop();
});

test("a second queued row waits for the next idle transition rather than stalling", async () => {
  // The follow-on half: after the first row leaves, the session goes working and comes back
  // idle exactly once more. A drain that only ever armed on the submit path would deliver
  // row one and strand row two.
  const f = sdkFixture("settle-fifo", async () => "started", { idleSettleMs: 40 });
  working(f.registry, f.id);
  assert.equal(f.manager.submit(f.id, "first queued row").ok, true);
  assert.equal(f.manager.submit(f.id, "second queued row").ok, true);

  idle(f.registry, f.id);
  await until(() => f.calls.length > 0, "the first queued turn to be delivered");
  assert.deepEqual(f.calls, ["first queued row"]);

  working(f.registry, f.id);
  idle(f.registry, f.id);
  await until(() => f.calls.length > 1, "the second queued turn to be delivered");
  assert.deepEqual(f.calls, ["first queued row", "second queued row"]);
  assert.deepEqual(f.registry.getSession(f.id)?.pendingTurns, []);
  f.manager.stop();
});

test("SDK-to-terminal handoff waits for one live owner and wakes after eviction", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const registry = new Registry();
  const key = "agent:handoff-target";
  const sourceId = "sdk:handoff-source";
  const targetId = "terminal:handoff-target";
  registry.registerSdkSession({
    id: sourceId,
    agent: "claude",
    name: "handoff-source",
    cwd: "/repo/handoff-owner",
    agentSessionId: key,
  });
  const sends: string[] = [];
  const manager = new PendingTurnManager(
    registry,
    {
      sendWhenIdle: async () => {
        throw new Error("the exited SDK owner must not receive the pending turn");
      },
    },
    {
      idleSettleMs: 0,
      inject: async (session, _text, _deps, beforeWrite) => {
        const blocker = beforeWrite?.();
        if (blocker) {
          return { ok: false, error: blocker, pasted: false, submitVerified: false };
        }
        sends.push(session.id);
        return { ok: true, pasted: true, submitVerified: true };
      },
    },
  );
  manager.start();
  working(registry, sourceId);
  manager.submit(sourceId, "deliver through the surviving owner");

  registry.applyDiscovery([{ ...discovered("handoff-target"), agentSessionId: key }]);
  stopHook(registry, "handoff-target");
  assert.equal(registry.sessionForNoteKey(key), undefined);
  assert.deepEqual(sends, []);

  registry.applyDriverEvent(sourceId, {
    kind: "exited",
    reason: "continued in terminal",
    resumable: false,
  });
  assert.equal(registry.sessionForNoteKey(key)?.id, targetId);
  assert.deepEqual(sends, []);

  t.mock.timers.tick(9_000);
  for (let i = 0; i < 20; i++) await Promise.resolve();

  assert.deepEqual(sends, [targetId]);
  assert.deepEqual(registry.getSession(targetId)?.pendingTurns, []);
  manager.stop();
  clearPendingTurns(key);
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

test("an SDK error after the acceptance boundary remains uncertain", async () => {
  const f = sdkFixture("driver-error", async () => {
    throw new Error("transport closed after turn/start");
  });
  idle(f.registry, f.id);
  f.manager.submit(f.id, "do not replay me automatically");
  await tick();
  const turn = f.registry.getSession(f.id)?.pendingTurns[0];
  assert.equal(turn?.state, "uncertain");
  assert.match(turn?.lastError ?? "", /acceptance boundary.*transport closed after turn\/start/);
  f.manager.stop();
  clearPendingTurns(f.key);
});

test("an SDK failure before the acceptance boundary remains safely retryable", async () => {
  const registry = new Registry();
  const id = "sdk:pre-boundary-error";
  const key = "conversation:pre-boundary-error";
  registry.registerSdkSession({
    id,
    agent: "claude",
    name: "pre-boundary-error",
    cwd: "/repo/pre-boundary-error",
    agentSessionId: key,
  });
  const manager = new PendingTurnManager(
    registry,
    {
      sendWhenIdle: async () => {
        throw new Error("supervisor refused before acceptance");
      },
    },
    { idleSettleMs: 0 },
  );
  manager.start();
  idle(registry, id);
  manager.submit(id, "keep me editable");
  await tick();

  const turn = registry.getSession(id)?.pendingTurns[0];
  assert.equal(turn?.state, "queued");
  assert.equal(turn?.lastError, "supervisor refused before acceptance");
  manager.stop();
  clearPendingTurns(key);
});

test("SDK ownership changes before acceptance preserve uncertainty", async () => {
  const registry = new Registry();
  const id = "sdk:owner-before-acceptance";
  const key = "agent:owner-before-acceptance";
  registry.registerSdkSession({
    id,
    agent: "claude",
    name: "owner-before-acceptance",
    cwd: "/repo/owner-before-acceptance",
    agentSessionId: key,
  });
  let deliveryReached!: () => void;
  const deliveryReady = new Promise<void>((resolve) => (deliveryReached = resolve));
  let continueAcceptance!: () => void;
  const acceptanceMayContinue = new Promise<void>((resolve) => (continueAcceptance = resolve));
  let accepted = 0;
  const manager = new PendingTurnManager(
    registry,
    {
      sendWhenIdle: async (_sessionId, _turn, beforeSend) => {
        deliveryReached();
        await acceptanceMayContinue;
        const blocker = beforeSend?.();
        if (blocker) throw new Error(blocker);
        accepted += 1;
        return "started";
      },
    },
    { idleSettleMs: 0 },
  );
  manager.start();
  idle(registry, id);
  manager.submit(id, "do not accept through an ambiguous owner");
  await deliveryReady;

  registry.registerSdkSession({
    id: "sdk:owner-before-acceptance-other",
    agent: "claude",
    name: "owner-before-acceptance-other",
    cwd: "/repo/owner-before-acceptance",
    agentSessionId: key,
  });
  continueAcceptance();
  await tick();

  const turn = listPendingTurns(key)[0];
  assert.equal(accepted, 0);
  assert.equal(turn?.state, "uncertain");
  assert.match(turn?.lastError ?? "", /ownership changed/);
  manager.stop();
  clearPendingTurns(key);
});

test("SDK ownership changes during acknowledgement preserve uncertainty", async () => {
  const registry = new Registry();
  const id = "sdk:owner-during-ack";
  const key = "agent:owner-during-ack";
  registry.registerSdkSession({
    id,
    agent: "claude",
    name: "owner-during-ack",
    cwd: "/repo/owner-during-ack",
    agentSessionId: key,
  });
  let acceptanceReached!: () => void;
  const acceptanceBoundary = new Promise<void>((resolve) => (acceptanceReached = resolve));
  let acknowledge!: () => void;
  const acknowledgement = new Promise<void>((resolve) => (acknowledge = resolve));
  const manager = new PendingTurnManager(
    registry,
    {
      sendWhenIdle: async (_sessionId, _turn, beforeSend) => {
        const blocker = beforeSend?.();
        if (blocker) throw new Error(blocker);
        acceptanceReached();
        await acknowledgement;
        return "started";
      },
    },
    { idleSettleMs: 0 },
  );
  manager.start();
  idle(registry, id);
  manager.submit(id, "retain this accepted handoff when ownership overlaps");
  await acceptanceBoundary;

  registry.registerSdkSession({
    id: "sdk:owner-during-ack-other",
    agent: "claude",
    name: "owner-during-ack-other",
    cwd: "/repo/owner-during-ack",
    agentSessionId: key,
  });
  acknowledge();
  await tick();

  const turn = listPendingTurns(key)[0];
  assert.equal(turn?.state, "uncertain");
  assert.match(turn?.lastError ?? "", /ownership changed/);
  manager.stop();
  clearPendingTurns(key);
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

test("a verified terminal submit waits for fresh activity and idle before draining the next row", async () => {
  const f = terminalFixture("verified-fifo-boundary", async () => ({
    ok: true,
    pasted: true,
    submitVerified: true,
  }));
  f.manager.submit(f.id, "first terminal turn");
  f.manager.submit(f.id, "second terminal turn");
  await tick();

  assert.deepEqual(f.injected, ["first terminal turn"]);
  assert.deepEqual(
    f.registry.getSession(f.id)?.pendingTurns.map((turn) => turn.text),
    ["second terminal turn"],
  );

  // Repeating the stale idle observation from before the paste is not completion evidence.
  stopHook(f.registry, "verified-fifo-boundary");
  await tick();
  assert.deepEqual(f.injected, ["first terminal turn"]);

  userPromptHook(f.registry, "verified-fifo-boundary");
  await tick();
  assert.deepEqual(f.injected, ["first terminal turn"]);

  stopHook(f.registry, "verified-fifo-boundary");
  await tick();
  assert.deepEqual(f.injected, ["first terminal turn", "second terminal turn"]);
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

test("terminal delivery refuses when work starts before the write boundary", async () => {
  let reachedBoundary!: () => void;
  const boundaryReached = new Promise<void>((resolve) => (reachedBoundary = resolve));
  let continueDelivery!: () => void;
  const deliveryMayContinue = new Promise<void>((resolve) => (continueDelivery = resolve));
  const f = terminalFixture(
    "write-boundary-race",
    async () => ({ ok: true, pasted: true, submitVerified: false }),
    100,
    async () => {
      reachedBoundary();
      await deliveryMayContinue;
    },
  );

  f.manager.submit(f.id, "do not steer active work");
  await boundaryReached;
  userPromptHook(f.registry, "write-boundary-race");
  continueDelivery();
  await tick();

  assert.deepEqual(f.injected, []);
  const turn = f.registry.getSession(f.id)?.pendingTurns[0];
  assert.equal(turn?.state, "queued");
  assert.match(turn?.lastError ?? "", /became busy or opened a dialog/);
  f.manager.stop();
  clearPendingTurns(f.key);
});

test("terminal pickup timeout starts only after injection settles", async () => {
  let finishInjection!: () => void;
  const injectionMayFinish = new Promise<void>((resolve) => (finishInjection = resolve));
  let injectionStarted!: () => void;
  const started = new Promise<void>((resolve) => (injectionStarted = resolve));
  const f = terminalFixture(
    "slow-injection",
    async () => {
      injectionStarted();
      await injectionMayFinish;
      return { ok: true, pasted: true, submitVerified: false };
    },
    10,
  );

  f.manager.submit(f.id, "wait for injection to settle");
  await started;
  await tick(30);
  assert.equal(f.registry.getSession(f.id)?.pendingTurns[0]?.state, "sending");

  finishInjection();
  await tick(30);
  const turn = f.registry.getSession(f.id)?.pendingTurns[0];
  assert.equal(turn?.state, "uncertain");
  assert.match(turn?.lastError ?? "", /could not confirm/);
  f.manager.stop();
  clearPendingTurns(f.key);
});

test("in-flight pickup evidence stays provisional until injection succeeds", async () => {
  for (const scenario of [
    { name: "paste-failure", pasted: false, state: "queued" },
    { name: "submit-refusal", pasted: true, state: "uncertain" },
  ] as const) {
    let f!: ReturnType<typeof terminalFixture>;
    let finishInjection!: () => void;
    const injectionMayFinish = new Promise<void>((resolve) => (finishInjection = resolve));
    let pickupObserved!: () => void;
    const observed = new Promise<void>((resolve) => (pickupObserved = resolve));
    f = terminalFixture(
      `provisional-${scenario.name}`,
      async (_text, beforeWrite) => {
        userPromptHook(f.registry, `provisional-${scenario.name}`);
        pickupObserved();
        await injectionMayFinish;
        const blocker = scenario.pasted ? beforeWrite() : "terminal paste failed";
        return {
          ok: false,
          error: blocker ?? "terminal submit failed",
          pasted: scenario.pasted,
          submitVerified: false,
        };
      },
      100,
    );

    f.manager.submit(f.id, `preserve ${scenario.name}`);
    await observed;
    assert.equal(f.registry.getSession(f.id)?.pendingTurns[0]?.state, "sending");

    finishInjection();
    await tick();

    const turns = f.registry.getSession(f.id)?.pendingTurns ?? [];
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.state, scenario.state);
    f.manager.stop();
    clearPendingTurns(f.key);
  }
});

test("cross-owner activity during injection preserves uncertainty", async () => {
  let finishInjection!: () => void;
  const injectionMayFinish = new Promise<void>((resolve) => (finishInjection = resolve));
  let injectionStarted!: () => void;
  const started = new Promise<void>((resolve) => (injectionStarted = resolve));
  const f = terminalFixture(
    "cross-owner-source",
    async () => {
      injectionStarted();
      await injectionMayFinish;
      return { ok: true, pasted: true, submitVerified: false };
    },
    100,
  );

  f.manager.submit(f.id, "keep this turn when another owner becomes active");
  await started;

  const other = "cross-owner-other";
  f.registry.applyDiscovery([
    { ...discovered("cross-owner-source"), agentSessionId: f.key },
    { ...discovered(other), agentSessionId: f.key },
  ]);
  f.registry.applyHook({
    agent: "claude",
    event: "UserPromptSubmit",
    sessionId: f.key,
    cwd: `/repo/${other}`,
    transcriptPath: null,
    env: { tmuxPane: `%${other}` },
  });
  assert.equal(f.registry.getSession(f.id)?.pendingTurns[0]?.state, "sending");

  finishInjection();
  await tick();

  const turn = f.registry.getSession(f.id)?.pendingTurns[0];
  assert.equal(turn?.state, "uncertain");
  assert.match(turn?.lastError ?? "", /ownership changed/);
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
      inject: async (_session, text, _deps, beforeWrite) => {
        const blocker = beforeWrite?.();
        if (blocker) {
          return { ok: false, error: blocker, pasted: false, submitVerified: false };
        }
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
    undefined,
    f.manager,
  );
  assert.equal(result.ok, true);
  assert.deepEqual(f.registry.getSession(f.id)?.pendingTurns, []);
  assert.deepEqual(listPendingTurns(f.key), []);
  f.manager.stop();
});

test("an SDK reset refuses a claimed turn at the runtime acceptance boundary", async () => {
  const registry = new Registry();
  const id = "sdk:reset-before-acceptance";
  const key = "agent:reset-before-acceptance";
  registry.registerSdkSession({
    id,
    agent: "claude",
    name: "reset-before-acceptance",
    cwd: "/repo/reset-before-acceptance",
    agentSessionId: key,
  });
  let deliveryReached!: () => void;
  const deliveryReady = new Promise<void>((resolve) => (deliveryReached = resolve));
  let continueDelivery!: () => void;
  const deliveryMayContinue = new Promise<void>((resolve) => (continueDelivery = resolve));
  let accepted = 0;
  const manager = new PendingTurnManager(
    registry,
    {
      sendWhenIdle: async (_sessionId, _turn, beforeSend) => {
        deliveryReached();
        await deliveryMayContinue;
        const blocker = beforeSend?.();
        if (blocker) throw new Error(blocker);
        accepted += 1;
        return "started";
      },
    },
    { idleSettleMs: 0 },
  );
  manager.start();
  idle(registry, id);
  manager.submit(id, "discard before runtime acceptance");
  await deliveryReady;

  let resetCalled = false;
  const reset = resetSession(
    registry,
    registry.getSession(id)!,
    false,
    async () => {
      resetCalled = true;
      return {
        ok: true,
        error: null,
        root: "/repo/reset-before-acceptance",
        cleared: false,
        detached: false,
      };
    },
    undefined,
    manager,
  );
  await tick();
  assert.equal(resetCalled, false, "reset waits for the claimed delivery to refuse");

  continueDelivery();
  assert.equal((await reset).ok, true);
  assert.equal(accepted, 0);
  assert.deepEqual(listPendingTurns(key), []);
  manager.stop();
});

test("an SDK reset preserves uncertainty after runtime acceptance may have begun", async () => {
  const registry = new Registry();
  const id = "sdk:reset-after-acceptance";
  const key = "agent:reset-after-acceptance";
  registry.registerSdkSession({
    id,
    agent: "claude",
    name: "reset-after-acceptance",
    cwd: "/repo/reset-after-acceptance",
    agentSessionId: key,
  });
  let acceptanceReached!: () => void;
  const acceptanceBoundary = new Promise<void>((resolve) => (acceptanceReached = resolve));
  let finishAcceptance!: () => void;
  const acceptanceMayFinish = new Promise<void>((resolve) => (finishAcceptance = resolve));
  const manager = new PendingTurnManager(
    registry,
    {
      sendWhenIdle: async (_sessionId, _turn, beforeSend) => {
        const blocker = beforeSend?.();
        if (blocker) throw new Error(blocker);
        acceptanceReached();
        await acceptanceMayFinish;
        return "started";
      },
    },
    { idleSettleMs: 0 },
  );
  manager.start();
  idle(registry, id);
  manager.submit(id, "possibly accepted before reset");
  await acceptanceBoundary;
  manager.submit(id, "definitely still queued");

  let resetCalled = false;
  const reset = resetSession(
    registry,
    registry.getSession(id)!,
    false,
    async () => {
      resetCalled = true;
      return {
        ok: true,
        error: null,
        root: "/repo/reset-after-acceptance",
        cleared: false,
        detached: false,
      };
    },
    undefined,
    manager,
  );
  await tick();
  assert.equal(resetCalled, false, "reset waits for the ambiguous SDK handoff to settle");

  finishAcceptance();
  assert.equal((await reset).ok, true);
  const retained = listPendingTurns(key);
  assert.equal(retained.length, 1, "reset clears only the safely queued row");
  assert.equal(retained[0]?.text, "possibly accepted before reset");
  assert.equal(retained[0]?.state, "uncertain");
  assert.match(retained[0]?.lastError ?? "", /reset began while the SDK was accepting/);
  manager.stop();
  clearPendingTurns(key);
});

test("an SDK ownership race during reset retains the accepted row", async () => {
  const registry = new Registry();
  const id = "sdk:reset-owner-race";
  const key = "agent:reset-owner-race";
  registry.registerSdkSession({
    id,
    agent: "claude",
    name: "reset-owner-race",
    cwd: "/repo/reset-owner-race",
    agentSessionId: key,
  });
  let acceptanceReached!: () => void;
  const acceptanceBoundary = new Promise<void>((resolve) => (acceptanceReached = resolve));
  let acknowledge!: () => void;
  const acknowledgement = new Promise<void>((resolve) => (acknowledge = resolve));
  const manager = new PendingTurnManager(
    registry,
    {
      sendWhenIdle: async (_sessionId, _turn, beforeSend) => {
        const blocker = beforeSend?.();
        if (blocker) throw new Error(blocker);
        acceptanceReached();
        await acknowledgement;
        return "started";
      },
    },
    { idleSettleMs: 0 },
  );
  manager.start();
  idle(registry, id);
  manager.submit(id, "possibly accepted during the SDK ownership race");
  await acceptanceBoundary;
  manager.submit(id, "safe queued row");

  registry.registerSdkSession({
    id: "sdk:reset-owner-race-other",
    agent: "claude",
    name: "reset-owner-race-other",
    cwd: "/repo/reset-owner-race",
    agentSessionId: key,
  });
  const reset = resetSession(
    registry,
    registry.getSession(id)!,
    false,
    async () => ({
      ok: true,
      error: null,
      root: "/repo/reset-owner-race",
      cleared: false,
      detached: false,
    }),
    undefined,
    manager,
  );
  acknowledge();
  assert.equal((await reset).ok, true);

  const retained = listPendingTurns(key);
  assert.equal(retained.length, 1);
  assert.equal(retained[0]?.text, "possibly accepted during the SDK ownership race");
  assert.equal(retained[0]?.state, "uncertain");
  assert.match(retained[0]?.lastError ?? "", /ownership changed/);
  manager.stop();
  clearPendingTurns(key);
});

test("an SDK error during reset stays uncertain after the acceptance boundary", async () => {
  let acceptanceReached!: () => void;
  const acceptanceBoundary = new Promise<void>((resolve) => (acceptanceReached = resolve));
  let finishAcceptance!: () => void;
  const acceptanceMayFinish = new Promise<void>((resolve) => (finishAcceptance = resolve));
  const f = sdkFixture("reset-acceptance-error", async () => {
    acceptanceReached();
    await acceptanceMayFinish;
    throw new Error("driver response was lost");
  });
  idle(f.registry, f.id);
  f.manager.submit(f.id, "possibly accepted before the SDK error");
  await acceptanceBoundary;

  const reset = resetSession(
    f.registry,
    f.registry.getSession(f.id)!,
    false,
    async () => ({
      ok: true,
      error: null,
      root: "/repo/reset-acceptance-error",
      cleared: false,
      detached: false,
    }),
    undefined,
    f.manager,
  );
  finishAcceptance();
  assert.equal((await reset).ok, true);

  const retained = listPendingTurns(f.key);
  assert.equal(retained.length, 1);
  assert.equal(retained[0]?.state, "uncertain");
  assert.match(retained[0]?.lastError ?? "", /acceptance boundary.*driver response was lost/);
  f.manager.stop();
  clearPendingTurns(f.key);
});

test("a terminal reset refuses a claimed turn at the write boundary", async () => {
  let deliveryReached!: () => void;
  const deliveryReady = new Promise<void>((resolve) => (deliveryReached = resolve));
  let continueDelivery!: () => void;
  const deliveryMayContinue = new Promise<void>((resolve) => (continueDelivery = resolve));
  const f = terminalFixture(
    "reset-before-write",
    async () => ({ ok: true, pasted: true, submitVerified: false }),
    100,
    async () => {
      deliveryReached();
      await deliveryMayContinue;
    },
  );
  f.manager.submit(f.id, "discard before terminal write");
  await deliveryReady;

  let resetCalled = false;
  const reset = resetSession(
    f.registry,
    f.registry.getSession(f.id)!,
    false,
    async () => {
      resetCalled = true;
      return {
        ok: true,
        error: null,
        root: "/repo/reset-before-write",
        cleared: false,
        detached: false,
      };
    },
    undefined,
    f.manager,
  );
  await tick();
  assert.equal(resetCalled, false, "reset waits for the claimed terminal delivery to refuse");

  continueDelivery();
  assert.equal((await reset).ok, true);
  assert.deepEqual(f.injected, []);
  assert.deepEqual(listPendingTurns(f.key), []);
  f.manager.stop();
});

test("a terminal reset preserves uncertainty after the write boundary may have crossed", async () => {
  let injectionReached!: () => void;
  const injectionStarted = new Promise<void>((resolve) => (injectionReached = resolve));
  let finishInjection!: () => void;
  const injectionMayFinish = new Promise<void>((resolve) => (finishInjection = resolve));
  const f = terminalFixture(
    "reset-after-write",
    async () => {
      injectionReached();
      await injectionMayFinish;
      return { ok: true, pasted: true, submitVerified: false };
    },
    100,
  );
  f.manager.submit(f.id, "possibly written before reset");
  await injectionStarted;

  let resetCalled = false;
  const reset = resetSession(
    f.registry,
    f.registry.getSession(f.id)!,
    false,
    async () => {
      resetCalled = true;
      return {
        ok: true,
        error: null,
        root: "/repo/reset-after-write",
        cleared: false,
        detached: false,
      };
    },
    undefined,
    f.manager,
  );
  await tick();
  assert.equal(resetCalled, false, "reset waits for terminal injection to settle");

  finishInjection();
  assert.equal((await reset).ok, true);
  assert.deepEqual(f.injected, ["possibly written before reset"]);
  const retained = listPendingTurns(f.key);
  assert.equal(retained.length, 1);
  assert.equal(retained[0]?.state, "uncertain");
  assert.match(retained[0]?.lastError ?? "", /reset began after terminal delivery/);
  f.manager.stop();
  clearPendingTurns(f.key);
});

test("a terminal ownership race during reset retains the injected row", async () => {
  let injectionReached!: () => void;
  const injectionStarted = new Promise<void>((resolve) => (injectionReached = resolve));
  let finishInjection!: () => void;
  const injectionMayFinish = new Promise<void>((resolve) => (finishInjection = resolve));
  const f = terminalFixture(
    "reset-owner-source",
    async () => {
      injectionReached();
      await injectionMayFinish;
      return { ok: true, pasted: true, submitVerified: false };
    },
    100,
  );
  f.manager.submit(f.id, "possibly injected during the terminal ownership race");
  await injectionStarted;
  f.manager.submit(f.id, "safe queued row");

  const other = "reset-owner-other";
  f.registry.applyDiscovery([
    { ...discovered("reset-owner-source"), agentSessionId: f.key },
    { ...discovered(other), agentSessionId: f.key },
  ]);
  const reset = resetSession(
    f.registry,
    f.registry.getSession(f.id)!,
    false,
    async () => ({
      ok: true,
      error: null,
      root: "/repo/reset-owner-source",
      cleared: false,
      detached: false,
    }),
    undefined,
    f.manager,
  );
  finishInjection();
  assert.equal((await reset).ok, true);

  const retained = listPendingTurns(f.key);
  assert.equal(retained.length, 1);
  assert.equal(retained[0]?.text, "possibly injected during the terminal ownership race");
  assert.equal(retained[0]?.state, "uncertain");
  assert.match(retained[0]?.lastError ?? "", /ownership changed/);
  f.manager.stop();
  clearPendingTurns(f.key);
});

test("overlapping resets hold delivery until the final reset finishes", async () => {
  const f = sdkFixture("overlapping-resets", async () => "started");
  idle(f.registry, f.id);
  const retained = createPendingTurn({
    id: "possibly-delivered-before-overlapping-resets",
    noteKey: f.key,
    text: "possibly delivered before overlapping resets",
    now: 1,
  });
  const claimed = claimNextPendingTurn(f.key, 2);
  assert.equal(claimed?.id, retained.id);
  markPendingTurnUncertain(claimed!.id, claimed!.revision, "delivery was ambiguous", 3);
  f.registry.refreshPendingTurns(f.key);

  let firstResetEntered!: () => void;
  const firstResetStarted = new Promise<void>((resolve) => (firstResetEntered = resolve));
  let finishFirstReset!: () => void;
  const firstResetMayFinish = new Promise<void>((resolve) => (finishFirstReset = resolve));
  const firstReset = resetSession(
    f.registry,
    f.registry.getSession(f.id)!,
    false,
    async () => {
      firstResetEntered();
      await firstResetMayFinish;
      return {
        ok: true,
        error: null,
        root: "/repo/overlapping-resets",
        cleared: false,
        detached: false,
      };
    },
    undefined,
    f.manager,
  );
  await firstResetStarted;

  let secondResetEntered!: () => void;
  const secondResetStarted = new Promise<void>((resolve) => (secondResetEntered = resolve));
  let finishSecondReset!: () => void;
  const secondResetMayFinish = new Promise<void>((resolve) => (finishSecondReset = resolve));
  const secondReset = resetSession(
    f.registry,
    f.registry.getSession(f.id)!,
    false,
    async () => {
      secondResetEntered();
      await secondResetMayFinish;
      return {
        ok: false,
        error: "second reset failed",
        root: "/repo/overlapping-resets",
        cleared: false,
        detached: false,
      };
    },
    undefined,
    f.manager,
  );
  await secondResetStarted;

  finishFirstReset();
  assert.equal((await firstReset).ok, true);
  assert.equal(f.registry.sessionResetInProgress(f.id), true);
  assert.equal(listPendingTurns(f.key)[0]?.id, retained.id);

  f.manager.submit(f.id, "queued between reset completions");
  await tick();
  assert.deepEqual(f.calls, []);
  assert.deepEqual(
    listPendingTurns(f.key).map((turn) => [turn.text, turn.state]),
    [
      ["possibly delivered before overlapping resets", "uncertain"],
      ["queued between reset completions", "queued"],
    ],
  );

  finishSecondReset();
  assert.equal((await secondReset).ok, false);
  assert.equal(f.registry.sessionResetInProgress(f.id), false);
  await tick();
  assert.deepEqual(f.calls, []);
  const afterResets = listPendingTurns(f.key);
  assert.deepEqual(
    afterResets.map((turn) => [turn.text, turn.state]),
    [
      ["possibly delivered before overlapping resets", "uncertain"],
      ["queued between reset completions", "queued"],
    ],
  );
  assert.equal(f.manager.resolve(f.id, afterResets[0]!.id, afterResets[0]!.revision), true);
  await tick();
  assert.deepEqual(f.calls, ["queued between reset completions"]);
  assert.deepEqual(listPendingTurns(f.key), []);
  f.manager.stop();
  clearPendingTurns(f.key);
});
