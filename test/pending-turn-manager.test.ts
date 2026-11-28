import { unexpectedActiveSdkDelivery } from "./helpers/pending-turn-sender.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { InjectResult } from "../src/server/actions.ts";
import type { PaneDialog, SessionState, TranscriptMessage } from "../src/shared/types.ts";
import type { TranscriptMessages } from "../src/server/harness/types.ts";
import type { SessionMessages } from "../src/server/harness/index.ts";
import { activePaneDialog } from "../src/shared/session.ts";
import { mkMuxHandle, mkSession, mkTask } from "./helpers/session-fixture.ts";
import { tempDir } from "./temp-root.mjs";

const home = tempDir("mission-pending-turn-manager-");
process.env.MISSION_HOME = home;

const {
  claimNextPendingTurn,
  createPendingTurn,
  listPendingTurns,
  clearPendingTurns,
  markPendingTurnUncertain,
} = await import("../src/server/db.ts");
const { applyFeatureFlagIntent } = await import("../src/server/feature-flags/index.ts");
const { PendingTurnManager } = await import("../src/server/pending-turns.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { reportBucket } = await import("../src/shared/session.ts");
const { claudeTranscript } = await import("../src/server/harness/claude/transcript.ts");
const { collapseSteerEchoes } = await import("../src/shared/message-delivery.ts");
const { resetSession } = await import("../src/server/reset.ts");
const { interruptSession } = await import("../src/server/sdk/control.ts");
const { clearScoutPromptContext, openScoutPromptContext, scoutPromptTurns } = await import(
  "../src/server/scouts/prompt-context.ts"
);
const {
  claimHumanEcho, HUMAN_ECHO_TTL_MS, injectionFingerprint, observeInjections, onPersonDelivery, originOf,
  onAutomatedDelivery,
} = await import("../src/server/injections.ts");
const { journalScoutPrompt } = await import("../src/server/scouts/prompt-journal.ts");
const { SNOOZE_INSTRUCTION_TURN_PREFIX, MESSAGE_ANSWER_TURN_PREFIX, insertReview, updateReviewStatus, markReviewWaitDetached } = await import("../src/server/db.ts");
const { noteKeyFor } = await import("../src/server/registry.ts");

after(() => rmSync(home, { recursive: true, force: true }));

const tick = (ms = 8) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Wait for a condition to hold, for the cases whose timing is genuinely load-sensitive.
 *
 * `tick(n)` is a fixed sleep, and that is the right tool while it is only yielding to the
 * microtask queue - most cases here settle in one turn of the loop and a sleep reads more
 * plainly than a poll. It is the wrong tool when the thing being waited for is a TIMER plus
 * the async work that timer starts, because then the number has to be bigger than the
 * machine's worst moment rather than bigger than a tick. One case here waited 30ms for a
 * 10ms pickup timeout to fire AND its transition to land, which held on an idle machine and
 * failed under `npm test`, where six test files run concurrently and other suites are
 * spawning child processes.
 *
 * Deliberately does NOT assert on timeout. It returns and lets the caller's own assertion
 * do the judging, so a genuine failure still reports `'sending' !== 'uncertain'` rather than
 * a bare "condition did not hold" that says nothing about what the state actually was.
 *
 * The ceiling is generous rather than tuned: on a machine that is keeping up this returns as
 * soon as the condition holds, so a long ceiling costs nothing, while a short one buys
 * nothing and fails a case that was going to pass.
 */
async function settles(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await tick(2);
  }
}

/**
 * Poll instead of sleeping a fixed span, so a settle window costs its own length and no more.
 *
 * The deadline reads `performance.now()`, not `Date.now()`: a case that mocks `Date` to age a
 * ledger entry would otherwise freeze this clock too, and a delivery that never completed would
 * hang the file instead of failing it.
 */
async function until(predicate: () => boolean, what: string, timeoutMs = 2_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
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
      ...unexpectedActiveSdkDelivery,
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
    { ...unexpectedActiveSdkDelivery, sendWhenIdle: async () => "started" },
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
  assert.equal(f.registry.getGoal(f.id), null, "editable text has not been accepted");
  await tick();
  assert.deepEqual(f.calls, []);

  idle(f.registry, f.id);
  await tick();
  assert.deepEqual(f.calls, ["follow up after the current turn"]);
  assert.deepEqual(f.registry.getSession(f.id)?.pendingTurns, []);
  assert.equal(f.registry.getGoal(f.id)?.prompt, "follow up after the current turn");
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
      ...unexpectedActiveSdkDelivery,
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
    ...unexpectedActiveSdkDelivery,
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

test("a session stopped on a filed question still receives the operator's message (async-input)", async () => {
  const f = sdkFixture("asked", async () => "started");
  idle(f.registry, f.id);
  const reviews = new ReviewManager(f.registry);
  reviews.create(f.id, "input", "Which linter?", "Which linter?", null, { snoozable: true, waitMode: "message" });
  // Amber on the board, yet an operator message is not one of the rows a question holds.
  assert.equal(reportBucket(f.registry.getSession(f.id)!), "needs-you");
  f.manager.submit(f.id, "use eslint, and carry on");
  await tick();
  assert.deepEqual(f.calls, ["use eslint, and carry on"]);
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
  assert.equal(f.registry.getGoal(f.id), null, "a refused turn never enters Goal capture");
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
      ...unexpectedActiveSdkDelivery,
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

test("SDK ownership changes before acceptance preserve uncertainty", async (t) => {
  // The person's words never reached the driver, so their announcement is withdrawn too.
  const heard: Array<{ id: string; released: boolean }> = [];
  t.after(onPersonDelivery((delivery) => { heard.push({ id: delivery.id, released: delivery.released }); }));
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
      ...unexpectedActiveSdkDelivery,
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
  assert.deepEqual(heard.map((h) => h.released), [false, true], "a send refused before acceptance still contests a delivery of its words");
  assert.equal(heard[1]!.id, heard[0]!.id);
  manager.stop();
  clearPendingTurns(key);
});

test("SDK ownership changes during acknowledgement preserve uncertainty", async (t) => {
  // Past the acceptance boundary the words may have reached the agent: the announcement stands.
  const heard: Array<{ released: boolean }> = [];
  t.after(onPersonDelivery((delivery) => { heard.push({ released: delivery.released }); }));
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
      ...unexpectedActiveSdkDelivery,
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
  assert.equal(registry.getGoal(id), null, "an uncertain owner cannot receive the prompt");
  assert.deepEqual(heard.map((h) => h.released), [false], "a send that may have landed was taken back");
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

/**
 * The gate reads `activePaneDialog`, and the dashboard's held indicator reads it too. This
 * pins the property that makes those one rule rather than two expressions that happen to
 * agree today.
 *
 * `canDrain` is private, so this asserts the invariant the swap rests on directly: for every
 * state in the union, a session carrying a dialog is refused - either because the shared
 * helper still reports it, or because the state is not `idle` and the conjunct above it has
 * already refused. Written over `SessionState` exhaustively rather than over the two states
 * that differ today, so widening `activePaneDialog`'s cleared set to a state that CAN be
 * idle fails here instead of quietly loosening delivery.
 */
test("no session state lets a dialog-covered row past the drain gate", () => {
  const STATES: readonly SessionState[] = [
    "starting",
    "idle",
    "working",
    "awaiting_input",
    "awaiting_review",
    "stopping",
    "exited",
  ];
  const menu = {
    prompt: "Allow this?",
    options: [{ number: 1, label: "Yes" }],
    highlighted: 1,
  } as PaneDialog;

  for (const state of STATES) {
    const session = mkSession({ id: `s-${state}`, state, paneDialog: menu });
    const covered = activePaneDialog(session) !== null;
    const drainable = state === "idle";
    assert.equal(
      covered || !drainable,
      true,
      `state "${state}" is drainable AND reports no active dialog: the outbox would deliver into an open menu`,
    );
    // And the converse of the no-op claim: wherever the gate's own idle conjunct lets this
    // clause decide, the helper and the raw field must return the same answer.
    if (drainable) {
      assert.equal(
        activePaneDialog(session) === null,
        session.paneDialog === null,
        `state "${state}" makes the helper and the raw field disagree where the gate can act`,
      );
    }
  }
});

test("a dialog raised on a stopping session still refuses the queued row", async () => {
  // The window the two expressions used to differ over. Delivery must refuse it either way,
  // and this asserts the behaviour rather than the expression that produces it.
  const f = sdkFixture("stopping-dialog", async () => "started");
  idle(f.registry, f.id);
  f.registry.applyDriverEvent(f.id, {
    kind: "request",
    request: {
      id: "ask-stopping",
      kind: "permission",
      prompt: "Allow this?",
      options: [{ number: 1, label: "Yes" }],
    },
  });
  f.manager.submit(f.id, "never delivered while it is going away");
  await tick();
  assert.deepEqual(f.calls, []);
  f.registry.markSessionStopping(f.id);
  await tick();
  assert.deepEqual(f.calls, [], "a stopping session drained a row it should have held");
  f.manager.stop();
});

test("the operator's queued words are announced as a person's delivery on both runtimes", async (t) => {
  // A declared wait reads a person's turn as the wake even when its words repeat an automated
  // delivery still pending, and it can only do that if the outbox says the words are a person's.
  const heard: Array<{ sessionId: string; key: string }> = [];
  t.after(onPersonDelivery((delivery) => { heard.push({ sessionId: delivery.sessionId, key: delivery.key }); }));

  const sdk = sdkFixture("person-sdk", async () => "started");
  working(sdk.registry, sdk.id);
  sdk.manager.submit(sdk.id, "Please wrap up and open the pull request.");
  idle(sdk.registry, sdk.id);
  await tick();
  assert.deepEqual(sdk.calls, ["Please wrap up and open the pull request."]);
  sdk.manager.stop();

  const terminal = terminalFixture("person-terminal", async () => ({ ok: true, pasted: true, submitVerified: true }));
  terminal.manager.submit(terminal.id, "Please wrap up and open the pull request.");
  await tick();
  assert.deepEqual(terminal.injected, ["Please wrap up and open the pull request."]);
  terminal.manager.stop();

  const key = injectionFingerprint("Please wrap up and open the pull request.");
  assert.deepEqual(heard, [{ sessionId: sdk.id, key }, { sessionId: terminal.id, key }]);
});

test("an operator's queued words the driver refuses are taken back as a person's delivery", async (t) => {
  // A refusal is positive evidence nothing landed, so the announcement is withdrawn beside the
  // other-send record, and a waiting session's matching automated delivery stops being contested.
  const heard: Array<{ id: string; released: boolean }> = [];
  t.after(onPersonDelivery((delivery) => { heard.push({ id: delivery.id, released: delivery.released }); }));
  const sdk = sdkFixture("person-refused", async () => null);
  working(sdk.registry, sdk.id);
  sdk.manager.submit(sdk.id, "Please wrap up and open the pull request.");
  idle(sdk.registry, sdk.id);
  await tick();
  assert.deepEqual(sdk.calls, ["Please wrap up and open the pull request."]);
  sdk.manager.stop();
  assert.deepEqual(heard.map((h) => h.released), [false, true]);
  assert.equal(heard[1]!.id, heard[0]!.id);
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

for (const runtime of ["sdk", "terminal"] as const) test(runtime + " refusal retries only the atomic spoken settlement after SQLite recovers", async t => {
  const db = await import("../src/server/db.ts");
  applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: true });
  t.after(() => applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: false }));
  const name = "refusal-settlement-" + runtime;
  let attempts = 0;
  const refuse = () => {
    attempts++;
    db.openDb().exec(`CREATE TRIGGER refuse_queue_write BEFORE UPDATE OF state ON pending_turns
      WHEN OLD.spoken_words IS NOT NULL AND NEW.state = 'queued' BEGIN SELECT RAISE(ABORT, 'queue write failed'); END`);
  };
  const f = runtime === "sdk" ? sdkFixture(name, async () => { refuse(); return null; }) :
    terminalFixture(name, async () => { refuse(); return { ok: false, pasted: false, submitVerified: false, error: "positive refusal" }; });
  t.after(() => { f.manager.stop(); db.openDb().exec("DROP TRIGGER IF EXISTS refuse_queue_write"); });
  if (runtime === "sdk") idle(f.registry, f.id);
  assert.ok(f.manager.submitSpoken(f.id, "inspect this refusal", name).ok);
  await until(() => attempts === 1, "transport refusal");
  assert.equal(listPendingTurns(f.key)[0]?.state, "sending");
  const receipts = db.loadSpokenTurns(f.key);
  assert.equal(receipts.length, 1, "the failed transition also rolled back reservation withdrawal");
  db.openDb().exec("DROP TRIGGER refuse_queue_write");
  await until(() => listPendingTurns(f.key)[0]?.state === "queued", "bookkeeping retry", 5000);
  assert.equal(db.loadSpokenTurns(f.key).length, 0);
  await tick(30); // Let a drain erroneously scheduled by the queue update run.
  assert.equal(attempts, 1, "the storage retry did not call the transport");
  db.recoverSendingPendingTurns(Date.now());
  assert.equal(listPendingTurns(f.key)[0]?.state, "queued");
});

test("a spoken refusal before the handoff retries only the requeue after SQLite recovers", async t => {
  const db = await import("../src/server/db.ts");
  applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: true });
  let boundaries = 0;
  const f = terminalFixture("spoken-before-handoff", async () => ({ ok: true, pasted: true, submitVerified: true }), 15, async () => {
    if (++boundaries !== 1) return;
    db.openDb().exec(`CREATE TEMP TRIGGER block_unreserved_requeue BEFORE UPDATE OF state ON pending_turns
      WHEN OLD.spoken_words IS NOT NULL AND NEW.state = 'queued' BEGIN SELECT RAISE(ABORT, 'busy'); END`);
    applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: false });
  });
  t.after(() => {
    f.manager.stop();
    db.openDb().exec("DROP TRIGGER IF EXISTS block_unreserved_requeue");
    applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: false });
  });
  const spoken = f.manager.submitSpoken(f.id, "do not send", "before-guard").pendingTurn!;
  await until(() => boundaries === 1, "transport guard refusal");
  assert.equal(listPendingTurns(f.key)[0]?.state, "sending");
  assert.deepEqual(db.loadSpokenTurns(f.key), []);
  db.openDb().exec("DROP TRIGGER block_unreserved_requeue");
  await until(() => listPendingTurns(f.key)[0]?.state === "queued", "claim requeued without restart", 5000);
  assert.equal(boundaries, 1);
  assert.deepEqual(f.injected, []);
  const released = listPendingTurns(f.key)[0]!;
  assert.equal(released.id, spoken.id);
  assert.ok(f.manager.recall(f.id, released.id, released.revision));
  f.manager.submit(f.id, "next typed message");
  await until(() => f.injected.length > 0, "typed message following the recalled speech");
  assert.deepEqual(f.injected, ["next typed message"]);
});

test("a spoken paste retries a changed transcript boundary and sends once against the fresh file", async t => {
  const name = "spoken-boundary-retry";
  const path = join(home, name + ".jsonl");
  writeFileSync(path, "{}\n");
  t.mock.method(claudeTranscript, "locate", () => path);
  applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: true });
  t.after(() => applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: false }));
  let attempts = 0;
  const f = terminalFixture(name, async () => ({ ok: true, pasted: true, submitVerified: true }), 15, async () => {
    if (++attempts === 1) appendFileSync(path, "{}\n");
  });
  t.after(() => f.manager.stop());
  const receipt = f.manager.submitSpoken(f.id, "check the build", name);
  assert.equal(receipt.ok, true);
  await until(() => listPendingTurns(f.key)[0]?.lastError?.includes("transcript changed") === true, "safe retry");
  assert.deepEqual(f.injected, []);
  await until(() => listPendingTurns(f.key).length === 0, "confirmed spoken paste", 10_000);
  assert.equal(attempts, 2);
  assert.equal(f.injected.length, 1);
  const { loadSpokenTurns } = await import("../src/server/db.ts");
  const [row] = loadSpokenTurns(f.key);
  assert.equal(row?.transcriptBoundary, claudeTranscript.messages!.boundary!(path)?.proof);
});

test("failed spoken preparation retries SQLite settlement without sending and releases the following turn", async t => {
  const { openDb } = await import("../src/server/db.ts");
  const path = join(home, "spoken-preparation-settlement.jsonl");
  writeFileSync(path, "{}\n");
  t.mock.method(claudeTranscript, "locate", () => path);
  applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: true });
  t.after(() => applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: false }));
  const d = openDb();
  let attempts = 0;
  const read = claudeTranscript.messages as Required<Pick<TranscriptMessages, "prepareHandoffBoundaries">>;
  t.mock.method(read, "prepareHandoffBoundaries", async () => {
    attempts++;
    if (attempts === 1) d.exec(`CREATE TEMP TRIGGER block_prepare_settlement BEFORE UPDATE OF state ON pending_turns
      WHEN NEW.state = 'queued' BEGIN SELECT RAISE(ABORT, 'cannot requeue yet'); END`);
    if (attempts === 3) d.exec(`CREATE TEMP TRIGGER block_prepare_settlement BEFORE DELETE ON pending_turns
      WHEN OLD.spoken_words IS NOT NULL BEGIN SELECT RAISE(ABORT, 'cannot remove yet'); END`);
    throw new Error("proof worker unavailable");
  });
  const f = terminalFixture("spoken-preparation-settlement", async () => ({ ok: true, pasted: true, submitVerified: true }));
  t.after(() => { f.manager.stop(); d.exec("DROP TRIGGER IF EXISTS block_prepare_settlement"); });
  const spoken = f.manager.submitSpoken(f.id, "first spoken instruction", f.key).pendingTurn!;
  f.manager.submit(f.id, "next typed turn");
  for (const attempt of [1, 3]) {
    await until(() => attempts === attempt, "blocked preparation settlement " + attempt, 10_000);
    assert.equal(listPendingTurns(f.key)[0]?.state, "sending");
    assert.equal(d.prepare("SELECT spoken_proof_failures AS count FROM pending_turns WHERE id = ?").get(spoken.id)?.count, attempt - 1);
    assert.equal(f.registry.voiceHold(f.id), true);
    assert.deepEqual(f.injected, []);
    d.exec("DROP TRIGGER block_prepare_settlement");
  }
  await until(() => f.injected.length > 0, "following typed delivery", 5_000);
  assert.equal(attempts, 3, "bookkeeping retries did not consume proof attempts");
  assert.deepEqual(f.injected, ["next typed turn"]);
  assert.equal(f.registry.voiceHold(f.id), false);
  assert.equal(listPendingTurns(f.key).some(row => row.id === spoken.id), false);
});

test("a quiet spoken delivery bounds worker failures and changed transcript revisions across restart, then releases Foreman", async t => {
  const { VoiceRouter } = await import("../src/server/voice/router.ts");
  const { closeDb, loadSpokenTurns } = await import("../src/server/db.ts");
  const path = join(home, "spoken-worker-recovery.jsonl");
  writeFileSync(path, "{}\n");
  t.mock.method(claudeTranscript, "locate", () => path);
  applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: true });
  t.after(() => applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: false }));
  const read = claudeTranscript.messages as Required<Pick<TranscriptMessages, "prepareHandoffBoundaries">>;
  const prepare = read.prepareHandoffBoundaries.bind(read);
  let workerFailures = 0;
  let attempts = 0;
  t.mock.method(read, "prepareHandoffBoundaries", async (...args: Parameters<typeof prepare>) => {
    attempts++;
    if (attempts <= workerFailures) throw new Error("Transcript worker exited before returning proof");
    return prepare(...args);
  });
  for (const [errors, changes] of [[1, 0], [3, 0], [0, 3], [1, 2]] as const) {
    workerFailures = errors;
    attempts = 0;
    const fixture = () => terminalFixture(`spoken-proof-${errors}-${changes}`, async () => ({ ok: true, pasted: true, submitVerified: true }),
      15, async () => { if (attempts <= errors + changes) appendFileSync(path, "{}\n"); });
    let f = fixture();
    t.after(() => f.manager.stop());
    const target = { key: "task:steve", name: "Steve", kind: "session", sessionId: f.id, taskId: null,
      role: "", colorId: null, agent: "claude", state: "running" } as const;
    const cards: import("../src/shared/voice-routing.ts").VoiceCard[] = [];
    const router = new VoiceRouter(() => ({ mode: "listening", backend: "fluidaudio", roster: [target] }),
      () => ({ enabled: false, seconds: 1 }), { deliver: async (_target, words, id, _command, _active, queued) => {
        const turn = f.manager.submitSpoken(f.id, words, id, queued).pendingTurn!;
        return { outcome: "queued", turnId: turn.id };
      } }, card => cards.push(card));
    f.registry.voiceRouter = router;
    await router.accept({ id: f.key, text: "Steve, inspect the build", capturedAt: Date.now(), backend: "fluidaudio", words: [] });
    assert.equal(f.registry.voiceHold(f.id), true);
    if (changes === 2) {
      await until(() => listPendingTurns(f.key)[0]?.lastError?.includes("Retrying the spoken message") === true, "first proof retry");
      f.manager.stop();
      closeDb();
      f = fixture();
      f.registry.voiceRouter = router;
    }
    await until(() => listPendingTurns(f.key).length === 0, "worker-result settlement", 10_000);
    const failed = errors + changes === 3;
    assert.equal(attempts, failed ? 3 : 2);
    assert.equal(f.injected.length, failed ? 0 : 1);
    assert.equal(loadSpokenTurns(f.key).length, failed ? 0 : 1);
    assert.equal(cards.at(-1)?.state, failed ? "failed" : "sent");
    assert.equal(router.heard.list()[0]?.outcome, cards.at(-1)?.state);
    if (failed) {
      assert.match(cards.at(-1)?.detail ?? "", /Nothing was sent.*try again/);
      assert.equal(router.heard.list()[0]?.detail, cards.at(-1)?.detail);
      assert.equal(f.registry.voiceHold(f.id), false);
      await router.accept({ id: f.key + "-retry", text: "Steve, inspect the build", capturedAt: Date.now(), backend: "fluidaudio", words: [] });
      await until(() => cards.at(-1)?.state === "sent", "operator retry", 10_000);
      assert.equal(f.injected.length, 1);
    }
    f.manager.stop();
  }
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
  // The 10ms pickup timeout has to FIRE and its transition has to land. Polled rather than
  // slept through, so the case is bounded by the transition rather than by a guess at how
  // busy the machine is.
  await settles(() => f.registry.getSession(f.id)?.pendingTurns[0]?.state === "uncertain");
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
    { ...unexpectedActiveSdkDelivery, sendWhenIdle: async () => "started" },
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
    { ...unexpectedActiveSdkDelivery, sendWhenIdle: async () => accepted },
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
      ...unexpectedActiveSdkDelivery,
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
      ...unexpectedActiveSdkDelivery,
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
      ...unexpectedActiveSdkDelivery,
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

test("an interrupt drops what is still editable and leaves what has left or is in doubt", async () => {
  // The queue half of the interrupt gesture, and the three states are the whole test.
  //
  // A `queued` row has not been delivered and nobody is waiting on it, so stopping the turn
  // has to take it too - leaving it armed would restart, seconds later, exactly the work the
  // operator just stopped. A `sending` row has already left for the harness, so deleting it
  // would erase Mission Control's only record of a message that may be mid-flight. An
  // `uncertain` row is a question waiting for a human ("did this land?"), and the person
  // pressing Ctrl+C is not answering it.
  const f = sdkFixture("interrupt-drops-queue", async () => "started");
  // Working, so the manager's own drain leaves these rows alone and the only thing that
  // moves them is the interrupt under test.
  working(f.registry, f.id);

  // Oldest first, because `claimNextPendingTurn` takes the head of the queue: the row that
  // has already left is the one that was next in line.
  const inFlight = createPendingTurn({
    id: "left-already",
    noteKey: f.key,
    text: "already sending",
    now: 1,
  });
  createPendingTurn({ id: "gone-1", noteKey: f.key, text: "first queued", now: 2 });
  createPendingTurn({ id: "gone-2", noteKey: f.key, text: "second queued", now: 3 });
  const claimed = claimNextPendingTurn(f.key, 4);
  assert.equal(claimed?.id, inFlight.id, "the oldest queued row is the one that leaves");
  f.registry.refreshPendingTurns(f.key);
  assert.deepEqual(
    listPendingTurns(f.key).map((turn) => [turn.text, turn.state]),
    [["already sending", "sending"], ["first queued", "queued"], ["second queued", "queued"]],
  );

  assert.equal(f.manager.dropQueued(f.id), 2);
  assert.deepEqual(
    listPendingTurns(f.key).map((turn) => [turn.text, turn.state]),
    [["already sending", "sending"]],
  );
  // And the card was told, or the drawer would keep drawing rows the database no longer has.
  assert.deepEqual(
    f.registry.getSession(f.id)?.pendingTurns.map((turn) => turn.text),
    ["already sending"],
  );

  // The uncertain row, from the same starting point: still there afterwards, because it
  // carries information the operator has not been given a chance to act on.
  markPendingTurnUncertain(claimed!.id, claimed!.revision, "delivery was ambiguous", 5);
  f.registry.refreshPendingTurns(f.key);
  createPendingTurn({ id: "gone-3", noteKey: f.key, text: "queued after the doubt", now: 6 });
  f.registry.refreshPendingTurns(f.key);

  assert.equal(f.manager.dropQueued(f.id), 1);
  assert.deepEqual(
    listPendingTurns(f.key).map((turn) => [turn.text, turn.state]),
    [["already sending", "uncertain"]],
  );

  // Idempotent, and honest about it: a second press has nothing left to take.
  assert.equal(f.manager.dropQueued(f.id), 0);
  // A session the registry has never heard of is a no-op rather than a throw - the route
  // above it has already answered 404 for that case, and this must not be a second way to
  // fail one request.
  assert.equal(f.manager.dropQueued("sdk:no-such-session"), 0);

  f.manager.stop();
  clearPendingTurns(f.key);
});

// ---------------------------------------------------------------------------
// The scout prompt journal
//
// A scout archive preserves the human prompts of its work episode, and the only honest
// definition of "delivered" it can use is this manager's: an accepted SDK turn or a proven
// terminal pickup. Everything short of that is text somebody typed into a box, which is a
// different thing from something the agent was told - and the gap between them is where a
// recalled prompt would otherwise be published as part of the conversation.
// ---------------------------------------------------------------------------

/** Give a fixture's session a running scout task with a frozen prompt boundary. */
function scoutEpisode(
  registry: InstanceType<typeof Registry>,
  sessionId: string,
): { taskId: string; episodeId: string } {
  const taskId = `task-${sessionId}`;
  registry.upsertTask(
    mkTask({ id: taskId, kind: "scout", status: "running", sessionId, title: "Scout something" }),
  );
  const episode = registry.workEpisodeForSession(sessionId);
  assert.ok(episode, "precondition: the session has a work episode to own the prompts");
  const frozen = openScoutPromptContext({
    taskId,
    episodeId: episode.episodeId,
    sessionId,
    sessionName: registry.getSession(sessionId)?.name ?? sessionId,
    transcriptPath: null,
    transcriptOffset: 0,
  });
  assert.ok(frozen, "precondition: the boundary was frozen at delivery");
  return { taskId, episodeId: episode.episodeId };
}

test("an accepted SDK turn becomes a durable scout prompt", async () => {
  const f = sdkFixture("journal-sdk", async () => "started");
  const episode = scoutEpisode(f.registry, f.id);
  f.manager.submit(f.id, "also check whether pi behaves the same way");
  idle(f.registry, f.id);
  await settles(() => scoutPromptTurns(episode.taskId, episode.episodeId).length === 1);

  const turns = scoutPromptTurns(episode.taskId, episode.episodeId);
  assert.equal(turns.length, 1, "the accepted turn, once");
  assert.equal(turns[0]?.text, "also check whether pi behaves the same way");
  assert.equal(turns[0]?.origin, "human");
  f.manager.stop();
  clearPendingTurns(f.key);
  clearScoutPromptContext(episode.taskId, episode.episodeId);
});

test("a queued turn is not a prompt until it is accepted, and a recalled one never is", async () => {
  // The exact failure this ordering prevents: `submit` creates an EDITABLE outbox row, so
  // journaling there would archive text the operator then thought better of.
  const f = sdkFixture("journal-recall", async () => "started");
  const episode = scoutEpisode(f.registry, f.id);
  working(f.registry, f.id);
  const queued = f.manager.submit(f.id, "ignore this, I typed it by mistake");
  await tick();
  assert.deepEqual(
    scoutPromptTurns(episode.taskId, episode.episodeId),
    [],
    "a row that is still editable has not been delivered to anything",
  );

  const pending = queued.pendingTurn!;
  assert.ok(f.manager.recall(f.id, pending.id, pending.revision), "the operator takes it back");
  idle(f.registry, f.id);
  await tick(20);
  assert.deepEqual(
    scoutPromptTurns(episode.taskId, episode.episodeId),
    [],
    "and it is archived as nothing, because the agent never saw it",
  );
  f.manager.stop();
  clearPendingTurns(f.key);
  clearScoutPromptContext(episode.taskId, episode.episodeId);
});

test("a refused SDK delivery journals nothing and stays re-sendable", async () => {
  // `sendWhenIdle` answering null is a clean refusal - the agent became busy first - so the
  // row goes back to the outbox. Nothing crossed, so nothing is archived.
  const f = sdkFixture("journal-refused", async () => null);
  const episode = scoutEpisode(f.registry, f.id);
  f.manager.submit(f.id, "a turn that never lands");
  idle(f.registry, f.id);
  await settles(() => f.registry.getSession(f.id)?.pendingTurns[0]?.state === "queued");
  assert.equal(f.registry.getSession(f.id)?.pendingTurns[0]?.state, "queued");
  assert.deepEqual(scoutPromptTurns(episode.taskId, episode.episodeId), []);
  f.manager.stop();
  clearPendingTurns(f.key);
  clearScoutPromptContext(episode.taskId, episode.episodeId);
});

test("an unresolved uncertain delivery is not archived as a prompt", async () => {
  // Uncertain means the daemon cannot say whether the text crossed. Archiving it would
  // assert something nobody knows, and the operator's retry or resolution is what settles it.
  const f = sdkFixture("journal-uncertain", async () => {
    throw new Error("transport died after the acceptance guard");
  });
  const episode = scoutEpisode(f.registry, f.id);
  f.manager.submit(f.id, "a turn whose fate is unknown");
  idle(f.registry, f.id);
  await settles(() => f.registry.getSession(f.id)?.pendingTurns[0]?.state === "uncertain");
  assert.equal(f.registry.getSession(f.id)?.pendingTurns[0]?.state, "uncertain");
  assert.deepEqual(scoutPromptTurns(episode.taskId, episode.episodeId), []);
  f.manager.stop();
  clearPendingTurns(f.key);
  clearScoutPromptContext(episode.taskId, episode.episodeId);
});

test("a terminal turn is journaled on proven pickup, not on a successful paste", async () => {
  // The terminal boundary is two facts, not one: the paste succeeded AND the session was
  // observed picking it up. `completePickup` is where both are in hand, which is why it is
  // the journal point rather than the injection returning ok.
  const f = terminalFixture("journal-terminal", async () => ({
    ok: true,
    pasted: true,
    submitVerified: true,
  }));
  const episode = scoutEpisode(f.registry, f.id);
  f.manager.submit(f.id, "read the failing spec first");
  await settles(() => scoutPromptTurns(episode.taskId, episode.episodeId).length === 1);
  const turns = scoutPromptTurns(episode.taskId, episode.episodeId);
  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.text, "read the failing spec first");
  assert.equal(turns[0]?.origin, "human");
  f.manager.stop();
  clearPendingTurns(f.key);
  clearScoutPromptContext(episode.taskId, episode.episodeId);
});

test("a session running no scout journals nothing at all", async () => {
  const f = sdkFixture("journal-not-a-scout", async () => "started");
  f.registry.upsertTask(
    mkTask({ id: "task-ship", kind: "ship", status: "running", sessionId: f.id }),
  );
  const episode = f.registry.workEpisodeForSession(f.id);
  f.manager.submit(f.id, "a perfectly ordinary follow-up");
  idle(f.registry, f.id);
  await tick(20);
  assert.deepEqual(scoutPromptTurns("task-ship", episode?.episodeId ?? ""), []);
  f.manager.stop();
  clearPendingTurns(f.key);
});

function steeringFixture(name: string, options: {
  sendError?: boolean; interruptFails?: boolean; interruptTimeoutMs?: number;
  beforeSteer?: () => Promise<void>; beforeInterrupt?: () => Promise<void>;
  messagesFor?: () => SessionMessages | null;
  steerReceiptPollMs?: number;
} = {}) {
  const registry = new Registry();
  const id = `sdk:steering:${name}`;
  registry.registerSdkSession({ id, agent: "claude", name, cwd: `/repo/${name}`, agentSessionId: `steering:${name}` });
  working(registry, id);
  const sends: string[] = [];
  let interrupts = 0;
  const manager = new PendingTurnManager(registry, {
    sendWhenIdle: async (_id, turn, guard) => {
      const blocked = guard?.();
      if (blocked) throw new Error(blocked);
      if (registry.getSession(id)?.state !== "idle") return null;
      sends.push(turn.text);
      working(registry, id);
      return "started";
    },
    send: async (_id, turn, guard) => {
      await options.beforeSteer?.();
      const blocked = guard?.();
      if (blocked) throw new Error(blocked);
      if (options.sendError) throw new Error("receipt lost");
      sends.push(turn.text);
      return "steered";
    },
    interruptForDelivery: async (_id, guard) => {
      await options.beforeInterrupt?.();
      const blocked = guard();
      if (blocked) throw new Error(blocked);
      interrupts++;
      if (!options.interruptFails) idle(registry, id);
    },
  }, {
    idleSettleMs: 0,
    interruptTimeoutMs: options.interruptTimeoutMs ?? 100,
    messagesFor: options.messagesFor ?? (() => null),
    steerReceiptPollMs: options.steerReceiptPollMs ?? 5,
  });
  manager.start();
  return { registry, id, manager, sends, interrupts: () => interrupts };
}

test("steering passes intentional next-turn work while preserving it and all input is claimed once", async () => {
  const f = steeringFixture("bypass");
  const later = f.manager.submit(f.id, "after the turn").pendingTurn!;
  const one = f.manager.submit(f.id, "correction one").pendingTurn!;
  const two = f.manager.submit(f.id, "correction two").pendingTurn!;
  assert.ok(f.manager.expedite(f.id, one.id, one.revision, "steer"));
  assert.ok(f.manager.expedite(f.id, two.id, two.revision, "steer"));
  await until(() => f.sends.length === 2, "both steers");
  assert.deepEqual(f.sends, ["correction one", "correction two"]);
  assert.deepEqual(f.registry.getSession(f.id)?.pendingTurns.map(t => t.id), [later.id]);
  idle(f.registry, f.id);
  await until(() => f.sends.length === 3, "the next turn");
  assert.equal(f.sends[2], "after the turn");
  f.manager.stop();
});

test("ambiguous steering is uncertain and never replayed by timers or idle", async () => {
  const f = steeringFixture("ambiguous", { sendError: true });
  const row = f.manager.submit(f.id, "only once").pendingTurn!;
  assert.ok(f.manager.expedite(f.id, row.id, row.revision, "steer"));
  await until(() => f.registry.getSession(f.id)?.pendingTurns[0]?.state === "uncertain", "uncertainty");
  idle(f.registry, f.id);
  await tick();
  assert.equal(f.registry.getSession(f.id)?.pendingTurns[0]?.state, "uncertain");
  assert.deepEqual(f.sends, []);
  f.manager.stop();
});

test("an accepted steer stays on the session until the turn that must read it ends", async () => {
  const f = steeringFixture("receipt");
  const row = f.manager.submit(f.id, "skip e2e for now").pendingTurn!;
  assert.ok(f.manager.expedite(f.id, row.id, row.revision, "steer"));
  await until(() => f.sends.length === 1, "the steer");
  // The outbox row retired at acceptance; the steer is what keeps the message on screen.
  const session = f.registry.getSession(f.id)!;
  assert.deepEqual(session.pendingTurns, []);
  assert.deepEqual(session.steeredTurns?.map((t) => [t.id, t.text]), [[row.id, "skip e2e for now"]]);
  assert.equal(typeof session.steeredTurns?.[0]?.acceptedAt, "number");
  // More output from the same turn is not a reason to forget it.
  working(f.registry, f.id);
  assert.equal(f.registry.getSession(f.id)?.steeredTurns?.length, 1);
  // The turn ended: the agent has read it or begun a new turn with it.
  idle(f.registry, f.id);
  assert.equal(f.registry.getSession(f.id)?.steeredTurns, undefined);
  f.manager.stop();
});

/** A transcript whose byte offsets are record indexes: enough for the receipt scan. */
function fakeTranscript(records: TranscriptMessage[]): SessionMessages {
  const read = {
    size: () => records.length,
    appended: (_path: string, pos: number) => ({ messages: records.slice(pos), pos: records.length }),
  } as unknown as TranscriptMessages;
  return { read, path: "/fake/transcript.jsonl" };
}

test("a steer leaves the moment the transcript shows it, while its turn is still running", async () => {
  const records: TranscriptMessage[] = [
    // The same words, said before the steer: never its receipt.
    { id: "earlier", role: "user", text: "read me mid-turn", tools: [], ts: 1 },
  ];
  const f = steeringFixture("receipt-live", { messagesFor: () => fakeTranscript(records) });
  const row = f.manager.submit(f.id, "read me mid-turn").pendingTurn!;
  assert.ok(f.manager.expedite(f.id, row.id, row.revision, "steer"));
  await until(() => f.registry.getSession(f.id)?.steeredTurns?.length === 1, "the steer");
  records.push({ id: "assistant-1", role: "assistant", text: "still working", tools: [], ts: Date.now() });
  await tick(30);
  assert.equal(f.registry.getSession(f.id)?.steeredTurns?.length, 1, "not read yet");
  // The agent reads it at its next step and writes it down; the turn keeps running.
  records.push({ id: "read", role: "user", text: "read me mid-turn", tools: [], ts: Date.now() });
  await until(() => f.registry.getSession(f.id)?.steeredTurns === undefined, "the receipt");
  assert.equal(f.registry.getSession(f.id)?.state, "working");
  f.manager.stop();
});

test("a Claude steer leaves when Claude records it as a queued command, mid-turn", async () => {
  // The real transcript reader over a real file, because the bug lived in the parse: Claude
  // Code usually records a mid-turn message only as a `queued_command` attachment, so a
  // steer it had read stayed pinned under the log until the turn ended.
  const dir = tempDir("mission-claude-steer-");
  const path = join(dir, "transcript.jsonl");
  const line = (record: Record<string, unknown>) => `${JSON.stringify(record)}\n`;
  writeFileSync(path, line({
    type: "assistant", uuid: "a1", timestamp: new Date().toISOString(),
    message: { role: "assistant", content: [{ type: "text", text: "working on it" }] },
  }));
  const f = steeringFixture("receipt-claude-queued-command", {
    messagesFor: () => ({ read: claudeTranscript.messages!, path }),
  });
  const row = f.manager.submit(f.id, "use the staging database").pendingTurn!;
  assert.ok(f.manager.expedite(f.id, row.id, row.revision, "steer"));
  await until(() => f.registry.getSession(f.id)?.steeredTurns?.length === 1, "the steer");
  appendFileSync(path, line({
    type: "attachment", uuid: "q1", isSidechain: false, timestamp: new Date().toISOString(),
    attachment: {
      type: "queued_command", commandMode: "prompt", origin: null,
      prompt: "use the staging database", timestamp: new Date().toISOString(),
    },
  }));
  await until(() => f.registry.getSession(f.id)?.steeredTurns === undefined, "the queued-command receipt");
  const session = f.registry.getSession(f.id)!;
  assert.equal(session.state, "working", "retired while the turn that read it is still running");
  assert.deepEqual(session.steerReceipts?.map((r) => [r.steerId, r.messageId]), [[row.id, "q1"]]);
  f.manager.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("a Claude steer recorded both as a queued command and as a user record is read once", async () => {
  // The attachment and a `user` record with the same words, nothing from the agent between
  // them: one message recorded twice. The attachment is the receipt, the user record must
  // never answer the steer a second time, and the conversation shows the message once.
  const dir = tempDir("mission-claude-steer-both-");
  const path = join(dir, "transcript.jsonl");
  const line = (record: Record<string, unknown>) => `${JSON.stringify(record)}\n`;
  writeFileSync(path, line({
    type: "assistant", uuid: "a1", timestamp: new Date().toISOString(),
    message: { role: "assistant", content: [{ type: "text", text: "working on it" }] },
  }));
  const f = steeringFixture("receipt-claude-both-forms", {
    messagesFor: () => ({ read: claudeTranscript.messages!, path }),
  });
  const row = f.manager.submit(f.id, "use the staging database").pendingTurn!;
  assert.ok(f.manager.expedite(f.id, row.id, row.revision, "steer"));
  await until(() => f.registry.getSession(f.id)?.steeredTurns?.length === 1, "the steer");
  appendFileSync(path, line({
    type: "attachment", uuid: "q1", isSidechain: false, timestamp: new Date().toISOString(),
    attachment: {
      type: "queued_command", commandMode: "prompt", origin: null,
      prompt: "use the staging database", timestamp: new Date().toISOString(),
    },
  }) + line({
    type: "user", uuid: "u1", timestamp: new Date().toISOString(),
    message: { role: "user", content: "use the staging database" },
  }));
  await until(() => f.registry.getSession(f.id)?.steeredTurns === undefined, "the receipt");
  await tick(30);
  const session = f.registry.getSession(f.id)!;
  assert.equal(session.state, "working", "retired while the turn that read it is still running");
  assert.deepEqual(session.pendingTurns, [], "nothing left waiting to send");
  assert.deepEqual(
    session.steerReceipts?.map((r) => [r.steerId, r.messageId]),
    [[row.id, "q1"]],
    "one receipt, on the attachment - the user record answers no second steer",
  );
  // The conversation draws one delivered operator turn: the mid-turn record the receipt names.
  const visible = collapseSteerEchoes(claudeTranscript.messages!.appended(path, 0).messages);
  assert.deepEqual(visible.filter((m) => m.role === "user").map((m) => [m.id, m.text]), [
    ["q1", "use the staging database"],
  ]);
  f.manager.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("a retired steer publishes the exact turn that is its receipt, and a reset forgets it", async () => {
  const records: TranscriptMessage[] = [
    // The same words, written just before the steer: never its receipt, never labelled.
    { id: "earlier", role: "user", text: "same words", tools: [], ts: Date.now() },
  ];
  const f = steeringFixture("receipt-published", { messagesFor: () => fakeTranscript(records) });
  const row = f.manager.submit(f.id, "same words").pendingTurn!;
  assert.ok(f.manager.expedite(f.id, row.id, row.revision, "steer"));
  await until(() => f.registry.getSession(f.id)?.steeredTurns?.length === 1, "the steer");
  await tick(30);
  assert.equal(f.registry.getSession(f.id)?.steerReceipts, undefined, "the earlier turn is not a receipt");
  records.push({ id: "later", role: "user", text: "same words", tools: [], ts: Date.now() });
  await until(() => f.registry.getSession(f.id)?.steeredTurns === undefined, "the receipt");
  assert.deepEqual(
    f.registry.getSession(f.id)?.steerReceipts?.map((r) => [r.steerId, r.messageId]),
    [[row.id, "later"]],
  );
  // The turn ending keeps the receipt, so its label is still owed.
  idle(f.registry, f.id);
  assert.equal(f.registry.getSession(f.id)?.steerReceipts?.length, 1);
  f.registry.clearPendingTurns("steering:receipt-published");
  assert.equal(f.registry.getSession(f.id)?.steerReceipts, undefined);
  f.manager.stop();
});

test("a turn that ends before the next scan still records the steer it read", async () => {
  const records: TranscriptMessage[] = [];
  // A poll far longer than the test: only the read at turn end can find this receipt.
  const f = steeringFixture("receipt-at-idle", {
    messagesFor: () => fakeTranscript(records),
    steerReceiptPollMs: 60_000,
  });
  const row = f.manager.submit(f.id, "read then finish").pendingTurn!;
  assert.ok(f.manager.expedite(f.id, row.id, row.revision, "steer"));
  await until(() => f.registry.getSession(f.id)?.steeredTurns?.length === 1, "the steer");
  records.push({ id: "read-then-idle", role: "user", text: "read then finish", tools: [], ts: Date.now() });
  idle(f.registry, f.id);
  const session = f.registry.getSession(f.id)!;
  assert.equal(session.steeredTurns, undefined);
  assert.deepEqual(session.steerReceipts?.map((r) => [r.steerId, r.messageId]), [[row.id, "read-then-idle"]]);
  f.manager.stop();
});

test("only the steer the transcript shows is retired; the other keeps waiting", async () => {
  const records: TranscriptMessage[] = [];
  const f = steeringFixture("receipt-partial", { messagesFor: () => fakeTranscript(records) });
  const first = f.manager.submit(f.id, "first steer").pendingTurn!;
  const second = f.manager.submit(f.id, "second steer").pendingTurn!;
  assert.ok(f.manager.expedite(f.id, first.id, first.revision, "steer"));
  assert.ok(f.manager.expedite(f.id, second.id, second.revision, "steer"));
  await until(() => f.registry.getSession(f.id)?.steeredTurns?.length === 2, "both steers");
  records.push({ id: "read-second", role: "user", text: "second steer", tools: [], ts: Date.now() });
  await until(() => f.registry.getSession(f.id)?.steeredTurns?.length === 1, "one receipt");
  assert.deepEqual(f.registry.getSession(f.id)?.steeredTurns?.map((t) => t.text), ["first steer"]);
  f.manager.stop();
});

test("two steers with the same words are not both retired by one transcript turn", async () => {
  const records: TranscriptMessage[] = [];
  const f = steeringFixture("receipt-twins", { messagesFor: () => fakeTranscript(records) });
  const first = f.manager.submit(f.id, "check again").pendingTurn!;
  const second = f.manager.submit(f.id, "check again").pendingTurn!;
  assert.ok(f.manager.expedite(f.id, first.id, first.revision, "steer"));
  assert.ok(f.manager.expedite(f.id, second.id, second.revision, "steer"));
  await until(() => f.registry.getSession(f.id)?.steeredTurns?.length === 2, "both steers");
  records.push({ id: "read-1", role: "user", text: "check again", tools: [], ts: Date.now() });
  await until(() => f.registry.getSession(f.id)?.steeredTurns?.length === 1, "one receipt");
  await tick(30);
  assert.deepEqual(f.registry.getSession(f.id)?.steeredTurns?.map((t) => t.id), [second.id]);
  records.push({ id: "read-2", role: "user", text: "check again", tools: [], ts: Date.now() });
  await until(() => f.registry.getSession(f.id)?.steeredTurns === undefined, "the second receipt");
  f.manager.stop();
});

test("a steer read while its send is in flight is found behind an advanced scan", async () => {
  const records: TranscriptMessage[] = [];
  let steers = 0;
  const f = steeringFixture("receipt-rewind", {
    messagesFor: () => fakeTranscript(records),
    beforeSteer: async () => {
      steers += 1;
      if (steers !== 2) return;
      // The agent reads the second steer before the driver acknowledges it, and the scan
      // still running for the first steer reads past that line meanwhile.
      records.push({ id: "read-second", role: "user", text: "second, read early", tools: [], ts: Date.now() });
      records.push({ id: "assistant-2", role: "assistant", text: "on it", tools: [], ts: Date.now() });
      await tick(40);
    },
  });
  const recorded = new Set<string>();
  f.registry.subscribe((event) => {
    if (event.type !== "session_upsert") return;
    for (const turn of event.session.steeredTurns ?? []) recorded.add(turn.text);
  });
  const first = f.manager.submit(f.id, "first, never read").pendingTurn!;
  assert.ok(f.manager.expedite(f.id, first.id, first.revision, "steer"));
  await until(() => f.registry.getSession(f.id)?.steeredTurns?.length === 1, "the first steer");
  const second = f.manager.submit(f.id, "second, read early").pendingTurn!;
  assert.ok(f.manager.expedite(f.id, second.id, second.revision, "steer"));
  await until(() => f.sends.length === 2, "the second steer's acceptance");
  // Recorded once the driver acknowledged it, then retired off the line written before that.
  await until(
    () => recorded.has("second, read early") &&
      f.registry.getSession(f.id)?.steeredTurns?.map((t) => t.text).join() === "first, never read",
    "the early receipt",
  );
  assert.equal(f.registry.getSession(f.id)?.state, "working");
  f.manager.stop();
});

test("a steer waiting to be read never holds the outbox", async () => {
  const f = steeringFixture("non-blocking");
  const first = f.manager.submit(f.id, "first correction").pendingTurn!;
  assert.ok(f.manager.expedite(f.id, first.id, first.revision, "steer"));
  await until(() => f.registry.getSession(f.id)?.steeredTurns?.length === 1, "the first steer");
  // A later message can still be steered, and the one after it still waits for the next
  // turn: the unread steer is not an outbox row, so no drain gate can see it.
  const second = f.manager.submit(f.id, "second correction").pendingTurn!;
  const later = f.manager.submit(f.id, "after the turn").pendingTurn!;
  assert.ok(f.manager.expedite(f.id, second.id, second.revision, "steer"));
  await until(() => f.sends.length === 2, "the second steer");
  assert.deepEqual(
    f.registry.getSession(f.id)?.steeredTurns?.map((t) => t.text),
    ["first correction", "second correction"],
  );
  assert.deepEqual(f.registry.getSession(f.id)?.pendingTurns.map((t) => t.id), [later.id]);
  idle(f.registry, f.id);
  await until(() => f.sends.length === 3, "the next turn");
  assert.equal(f.sends[2], "after the turn");
  f.manager.stop();
});

test("a session that exits forgets the steers it never read", async () => {
  const f = steeringFixture("exit-steer");
  const row = f.manager.submit(f.id, "never read").pendingTurn!;
  assert.ok(f.manager.expedite(f.id, row.id, row.revision, "steer"));
  await until(() => f.registry.getSession(f.id)?.steeredTurns?.length === 1, "the steer");
  f.registry.applyDriverEvent(f.id, { kind: "exited", reason: "done", resumable: false });
  assert.equal(f.registry.getSession(f.id)?.steeredTurns, undefined);
  f.manager.stop();
});

test("a message delivered as a new turn is never tracked as steered", async () => {
  const f = steeringFixture("started");
  idle(f.registry, f.id);
  f.manager.submit(f.id, "fresh turn");
  await until(() => f.sends.length === 1, "the new turn");
  assert.equal(f.registry.getSession(f.id)?.steeredTurns, undefined);
  f.manager.stop();
});

test("a reset forgets steers the discarded conversation accepted", async () => {
  const f = steeringFixture("reset-steer");
  const row = f.manager.submit(f.id, "forget me").pendingTurn!;
  assert.ok(f.manager.expedite(f.id, row.id, row.revision, "steer"));
  await until(() => f.registry.getSession(f.id)?.steeredTurns?.length === 1, "the steer");
  f.registry.clearPendingTurns(`steering:reset-steer`);
  assert.equal(f.registry.getSession(f.id)?.steeredTurns, undefined);
  f.manager.stop();
});

test("interrupt and deliver preserves the other queued messages and stale actions cannot replay it", async () => {
  const f = steeringFixture("interrupt");
  const other = f.manager.submit(f.id, "later").pendingTurn!;
  const urgent = f.manager.submit(f.id, "change course").pendingTurn!;
  assert.equal(f.manager.expedite(f.id, urgent.id, urgent.revision + 1, "interrupt"), false);
  assert.equal(f.manager.expedite(f.id, urgent.id, urgent.revision, "interrupt"), true);
  await until(() => f.sends.length === 1, "interruption delivery");
  assert.equal(f.interrupts(), 1);
  assert.deepEqual(f.sends, ["change course"]);
  assert.deepEqual(f.registry.getSession(f.id)?.pendingTurns.map(t => t.id), [other.id]);
  assert.equal(f.manager.expedite(f.id, urgent.id, urgent.revision, "interrupt"), false);
  f.manager.stop();
});

test("an unconfirmed interrupt times out without sending and is not attempted again", async () => {
  const f = steeringFixture("timeout", { interruptFails: true, interruptTimeoutMs: 10 });
  const row = f.manager.submit(f.id, "do not lose me").pendingTurn!;
  assert.equal(f.manager.expedite(f.id, row.id, row.revision, "interrupt"), true);
  await until(() => !!f.registry.getSession(f.id)?.pendingTurns[0]?.lastError, "watchdog");
  working(f.registry, f.id);
  await tick(20);
  assert.equal(f.interrupts(), 1);
  assert.deepEqual(f.sends, []);
  assert.equal(f.registry.getSession(f.id)?.pendingTurns[0]?.state, "queued");
  f.manager.stop();
});

test("every message steers at one minute despite continued output, and survives manager restart", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100000 });
  const f = steeringFixture("deadline-restart");
  const row = f.manager.submit(f.id, "timed correction").pendingTurn!;
  // Nothing about the escalation is chosen or written: it is derived from the enqueue time,
  // which is what lets a restarted daemon arrive at the same instant.
  assert.equal(row.deliveryMode, "after-turn");
  assert.equal(row.deadlineAt, null);
  assert.equal(row.createdAt, 100000);
  t.mock.timers.tick(59000);
  working(f.registry, f.id);
  assert.deepEqual(f.sends, []);
  f.manager.stop();
  const resumed = new PendingTurnManager(f.registry, {
    ...unexpectedActiveSdkDelivery,
    sendWhenIdle: async () => "started",
    send: async (_id, turn, guard) => {
      assert.equal(guard?.(), null);
      f.sends.push(turn.text);
      return "steered";
    },
  }, { idleSettleMs: 0 });
  resumed.start();
  t.mock.timers.tick(1000);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(f.sends, ["timed correction"]);
  t.mock.timers.tick(120000);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.sends.length, 1);
  resumed.stop();
});

test("a deadline never answers a blocking review and resumes when the review is resolved", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 200000 });
  const f = steeringFixture("deadline-review");
  f.manager.submit(f.id, "do not answer the menu");
  f.registry.applyDriverEvent(f.id, { kind: "request", request: {
    id: "deadline-ask", kind: "permission", prompt: "Allow this?", options: [{ number: 1, label: "Yes" }],
  } });
  t.mock.timers.tick(65000);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(f.sends, []);
  f.registry.applyDriverEvent(f.id, { kind: "request_resolved", requestId: "deadline-ask" });
  working(f.registry, f.id);
  t.mock.timers.tick(1);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(f.sends, ["do not answer the menu"]);
  f.manager.stop();
});

test("a message a steer could not deliver interrupts at three minutes and keeps the other rows", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 300000 });
  // Steering is refused for as long as the gate is held, which is what a driver that has
  // stopped answering looks like from here. The second stage is the whole point of the
  // policy: the one-minute steer is not a guarantee that the message arrived.
  let allowSteer = false;
  const f = steeringFixture("deadline-interrupt", { beforeSteer: async () => {
    if (!allowSteer) throw new Error("the driver refused this steer");
  } });
  f.manager.submit(f.id, "interrupt if still unsent");
  f.manager.submit(f.id, "queued behind it");
  t.mock.timers.tick(60000);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(f.sends, [], "the steer did not reach the agent");
  assert.equal(f.interrupts(), 0);
  t.mock.timers.tick(119999);
  assert.equal(f.interrupts(), 0, "three minutes from the enqueue, not from the failed steer");
  allowSteer = true;
  t.mock.timers.tick(1);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.interrupts(), 1);
  assert.deepEqual(f.sends, ["interrupt if still unsent"]);
  assert.equal(f.registry.getSession(f.id)?.pendingTurns[0]?.text, "queued behind it");
  f.manager.stop();
});

test("an immediate steer does not wait behind a future deadline", async () => {
  const f = steeringFixture("future-before-now");
  f.manager.submit(f.id, "wait one minute");
  const now = f.manager.submit(f.id, "correct this now").pendingTurn!;
  assert.ok(f.manager.expedite(f.id, now.id, now.revision, "steer"));
  await until(() => f.sends.length === 1, "immediate correction");
  assert.deepEqual(f.sends, ["correct this now"]);
  assert.equal(f.registry.getSession(f.id)?.pendingTurns[0]?.text, "wait one minute");
  f.manager.stop();
});

test("an explicit correction still wins if the active turn ends before its timer fires", async () => {
  const f = steeringFixture("idle-before-steer");
  f.manager.submit(f.id, "intentional next-turn work");
  const urgent = f.manager.submit(f.id, "urgent correction").pendingTurn!;
  assert.ok(f.manager.expedite(f.id, urgent.id, urgent.revision, "steer"));
  idle(f.registry, f.id);
  await until(() => f.sends.length === 1, "correction as a new turn");
  assert.deepEqual(f.sends, ["urgent correction"]);
  assert.equal(f.registry.getSession(f.id)?.pendingTurns[0]?.text, "intentional next-turn work");
  f.manager.stop();
});

test("a steer queued beside a newly started turn does not depend on another driver event", async () => {
  const f = steeringFixture("follow-idle-start");
  idle(f.registry, f.id);
  const start = f.manager.submit(f.id, "start work").pendingTurn!;
  const also = f.manager.submit(f.id, "also consider this").pendingTurn!;
  assert.ok(f.manager.expedite(f.id, start.id, start.revision, "steer"));
  assert.ok(f.manager.expedite(f.id, also.id, also.revision, "steer"));
  await until(() => f.sends.length === 2, "both corrections");
  assert.deepEqual(f.sends, ["start work", "also consider this"]);
  f.manager.stop();
});

test("a review opening before steering acceptance leaves the message unsent", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = steeringFixture("review-before-acceptance", { beforeSteer: () => gate });
  const row = f.manager.submit(f.id, "do not answer the review").pendingTurn!;
  assert.ok(f.manager.expedite(f.id, row.id, row.revision, "steer"));
  await until(() => f.registry.getSession(f.id)?.pendingTurns[0]?.state === "sending", "claim");
  f.registry.applyDriverEvent(f.id, { kind: "request", request: {
    id: "new-review", kind: "permission", prompt: "Allow this?", options: [{ number: 1, label: "Yes" }],
  } });
  release();
  await until(() => f.registry.getSession(f.id)?.pendingTurns[0]?.state === "queued", "refusal");
  assert.deepEqual(f.sends, []);
  f.manager.stop();
});

test("a timed steer refused by a newly opened review resumes automatically after resolution", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 400000 });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = steeringFixture("timed-review-before-acceptance", { beforeSteer: () => gate });
  t.after(() => f.manager.stop());
  f.manager.submit(f.id, "deliver after the review");
  t.mock.timers.tick(60000);
  assert.equal(f.registry.getSession(f.id)?.pendingTurns[0]?.state, "sending");
  f.registry.applyDriverEvent(f.id, { kind: "request", request: {
    id: "timed-review", kind: "permission", prompt: "Allow this?", options: [{ number: 1, label: "Yes" }],
  } });
  release();
  await new Promise<void>(resolve => setImmediate(resolve));
  const refused = f.registry.getSession(f.id)?.pendingTurns[0];
  assert.equal(refused?.state, "queued");
  assert.match(refused?.lastError ?? "", /opened a dialog/);
  assert.deepEqual(f.sends, []);
  t.mock.timers.tick(30000);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(f.sends, [], "the unresolved review still blocks expired steering");

  f.registry.applyDriverEvent(f.id, { kind: "request_resolved", requestId: "timed-review" });
  t.mock.timers.tick(1);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(f.sends, ["deliver after the review"]);
  assert.deepEqual(f.registry.getSession(f.id)?.pendingTurns, []);
  working(f.registry, f.id);
  t.mock.timers.tick(120000);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.sends.length, 1, "accepted steering is never replayed");
});

test("a serialized interruption that outlives its watchdog cannot stop a later turn", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = steeringFixture("expired-guard", { beforeInterrupt: () => gate, interruptTimeoutMs: 10 });
  const row = f.manager.submit(f.id, "replacement").pendingTurn!;
  assert.ok(f.manager.expedite(f.id, row.id, row.revision, "interrupt"));
  await until(() => !!f.registry.getSession(f.id)?.pendingTurns[0]?.lastError, "watchdog");
  release();
  await tick();
  assert.equal(f.interrupts(), 0);
  assert.deepEqual(f.sends, []);
  f.manager.stop();
});

test("a terminal, which cannot steer, interrupts its turn three minutes after the message was queued", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 600000 });
  const registry = new Registry();
  const name = "terminal-timed-interrupt";
  registry.applyDiscovery([discovered(name)]);
  stopHook(registry, name);
  userPromptHook(registry, name);
  const session = registry.snapshot().sessions[0]!;
  const injected: string[] = [];
  let interrupted = false;
  const manager = new PendingTurnManager(registry, { ...unexpectedActiveSdkDelivery, sendWhenIdle: async () => "started" }, {
    idleSettleMs: 0, interruptTimeoutMs: 1000,
    interruptPane: async () => { interrupted = true; return { ok: true }; },
    inject: async (_session, text) => {
      injected.push(text);
      userPromptHook(registry, name);
      return { ok: true, pasted: true, submitVerified: true };
    },
  });
  manager.start();
  manager.submit(session.id, "a terminal correction");
  // The one-minute stage belongs to harnesses with a native mid-turn input path. A terminal
  // has none, so its message waits out the full three minutes rather than being typed into a
  // running TUI, and nothing here needed an event from the silent pane to notice.
  t.mock.timers.tick(179999);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(interrupted, false);
  assert.deepEqual(injected, []);
  t.mock.timers.tick(1);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(interrupted, true);
  assert.deepEqual(injected, [], "a successful keypress is not an idle acknowledgement");
  stopHook(registry, name);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(injected, ["a terminal correction"]);
  manager.stop();
});

test("terminal interruption waits for observed idle and then for verified pickup", async () => {
  const registry = new Registry();
  const name = "terminal-interrupt-delivery";
  registry.applyDiscovery([discovered(name)]);
  stopHook(registry, name);
  userPromptHook(registry, name);
  const session = registry.snapshot().sessions[0]!;
  const injected: string[] = [];
  let interrupted = false;
  const manager = new PendingTurnManager(registry, { ...unexpectedActiveSdkDelivery, sendWhenIdle: async () => "started" }, {
    idleSettleMs: 0, interruptTimeoutMs: 1000,
    interruptPane: async () => { interrupted = true; return { ok: true }; },
    inject: async (_session, text, _deps, beforeWrite) => {
      assert.equal(beforeWrite?.(), null);
      injected.push(text);
      userPromptHook(registry, name);
      return { ok: true, pasted: true, submitVerified: true };
    },
  });
  manager.start();
  const other = manager.submit(session.id, "for later").pendingTurn!;
  const urgent = manager.submit(session.id, "terminal replacement").pendingTurn!;
  assert.ok(manager.expedite(session.id, urgent.id, urgent.revision, "interrupt"));
  await until(() => interrupted, "terminal Escape");
  assert.deepEqual(injected, [], "a successful keypress is not an idle acknowledgement");
  stopHook(registry, name);
  await until(() => injected.length === 1, "replacement pickup");
  assert.deepEqual(injected, ["terminal replacement"]);
  assert.deepEqual(registry.getSession(session.id)?.pendingTurns.map(turn => turn.id), [other.id]);
  manager.stop();
});

test("ordinary Stop cancels an unsent interrupt-and-deliver replacement", async () => {
  const f = steeringFixture("stop-replacement", { interruptFails: true });
  f.manager.submit(f.id, "later");
  const replacement = f.manager.submit(f.id, "do not restart stopped work").pendingTurn!;
  assert.ok(f.manager.expedite(f.id, replacement.id, replacement.revision, "interrupt"));
  await until(() => f.interrupts() === 1, "interrupt request");
  const supervisor = {
    interrupt: async () => {
      idle(f.registry, f.id);
      await tick(20);
      return "interrupted" as const;
    },
  } as unknown as import("../src/server/sdk/supervisor.ts").SdkSupervisor;
  const stopped = await interruptSession(f.registry.getSession(f.id)!, supervisor, f.manager);
  assert.equal(stopped.droppedQueued, 2);
  await tick(20);
  assert.deepEqual(f.sends, []);
  assert.deepEqual(f.registry.getSession(f.id)?.pendingTurns, []);
  f.manager.stop();
});

test("a refused normal Stop releases its hold so an unsent steer can still arrive", async () => {
  const f = steeringFixture("refused-normal-stop");
  let queued!: import("../src/shared/types.ts").PendingTurn;
  const supervisor = {
    interrupt: async () => {
      queued = f.manager.submit(f.id, "keep this correction").pendingTurn!;
      assert.equal(f.manager.expedite(f.id, queued.id, queued.revision, "steer"), false,
        "the pending stop holds every delivery, the explicit ones included");
      await tick(20);
      assert.deepEqual(f.sends, [], "no timed delivery can race the stop request");
      throw new Error("interruption refused");
    },
  } as unknown as import("../src/server/sdk/supervisor.ts").SdkSupervisor;
  const stopped = await interruptSession(f.registry.getSession(f.id)!, supervisor, f.manager);
  assert.equal(stopped.ok, false);
  assert.ok(f.manager.expedite(f.id, queued.id, queued.revision, "steer"), "the hold is gone");
  await until(() => f.sends.length === 1, "resumed steering");
  assert.deepEqual(f.sends, ["keep this correction"]);
  f.manager.stop();
});
for (const { state, startOffset } of [
  { state: "working", startOffset: 300 },
  { state: "idle", startOffset: 300 },
  { state: "during-injection", startOffset: 300 },
  // Idle prevents the working-state fallback from masking an exclusive passive comparison.
  { state: "idle", startOffset: 0 },
] as const) {
  const timing = startOffset === 0 ? "exactly at the write boundary" : "after the write within the same second";
  test(`Codex passive ${state} confirms a turn that started ${timing}`, async (t) => {
    const { parseRolloutActivity } = await import("../src/server/harness/codex/rollout.ts");
    const registry = new Registry();
    const name = `codex-fast-${state}-${startOffset}`;
    const key = `agent:${name}`;
    const terminal = {
      ...discovered(name), agent: "codex" as const, agentSessionId: key,
      transcriptPath: `/tmp/${name}.jsonl`,
    };
    // Deliberately fractional: Codex's payload timestamps round this turn's start
    // BELOW the delivery boundary. The record timestamp retains its true ordering.
    const second = Math.floor(Date.now() / 1000) * 1000;
    const boundary = second + 200;
    let now = boundary;
    const observe = (lines: string[]) => {
      registry.applyPassiveActivity(registry.getSession(terminal.syntheticId)!, parseRolloutActivity(lines));
      registry.applyDiscovery([terminal]);
    };
    const marker = (type: string, at: number, turn: string) => JSON.stringify({
      type: "event_msg", timestamp: new Date(at).toISOString(),
      payload: { type, turn_id: turn, started_at: second / 1000,
        ...(type === "task_complete" ? { completed_at: Math.floor(at / 1000) } : {}) },
    });
    registry.applyDiscovery([terminal]);
    observe([marker("task_complete", second - 1000, "old")]);
    const started = marker("task_started", boundary + startOffset, "new");
    const completed = marker("task_complete", second + 800, "new");
    const injected: string[] = [];
    const manager = new PendingTurnManager(registry, { ...unexpectedActiveSdkDelivery, sendWhenIdle: async () => "started" }, {
      now: () => now, idleSettleMs: 0, pickupTimeoutMs: 100,
      inject: async (_session, text, _deps, beforeWrite) => {
        assert.equal(beforeWrite?.(), null);
        injected.push(text);
        if (state === "during-injection" && injected.length === 1) {
          now = second + 900;
          observe([started, completed]);
        }
        return { ok: true, pasted: true, submitVerified: false };
      },
    });
    t.after(() => manager.stop());
    manager.start();
    manager.submit(terminal.syntheticId, "first fast turn");
    manager.submit(terminal.syntheticId, "second queued turn");
    await until(() => injected.length >= 1, "first injection");
    if (state === "during-injection") {
      await until(() => injected.length === 2, "FIFO after completion during injection");
      assert.deepEqual(injected, ["first fast turn", "second queued turn"]);
      return;
    }
    assert.equal(listPendingTurns(key)[0]?.state, "sending");

    // Even one millisecond before the write is too old, despite a newer completion.
    observe([marker("task_started", boundary - 1, "old"), marker("task_complete", second + 300, "old")]);
    assert.equal(listPendingTurns(key)[0]?.state, "sending", "a pre-boundary start is not pickup");

    now = second + 900;
    observe(state === "idle" ? [started, completed] : [started]);
    assert.deepEqual(listPendingTurns(key).map(row => row.text), ["second queued turn"],
      "pickup survives a whole fast turn between reads as well as same-second working evidence");
    if (state === "working") {
      await tick();
      assert.deepEqual(injected, ["first fast turn"], "FIFO stays closed while the turn runs");
      observe([started, completed]);
    }
    await until(() => injected.length === 2, "FIFO delivery after fast completion");
    assert.deepEqual(injected, ["first fast turn", "second queued turn"]);
  });
}

// ---- one Goal revision per human SDK follow-up ----
//
// A follow-up reaches the Goal by two doors: the outbox's acknowledgement and the agent's
// prompt-hook echo of the same text. Exactly one of them may open a revision, whichever order
// they arrive in and whichever of them fails.

type HookEvent = Parameters<InstanceType<typeof Registry>["applyHook"]>[0];

function sdkEcho(registry: InstanceType<typeof Registry>, key: string, name: string, prompt: string): void {
  registry.applyHook({
    agent: "claude",
    event: "UserPromptSubmit",
    sessionId: key,
    cwd: `/repo/${name}`,
    transcriptPath: null,
    env: {},
    prompt,
  } as HookEvent);
}

function turnDone(registry: InstanceType<typeof Registry>, id: string): void {
  registry.applyDriverEvent(id, { kind: "turn_done", usage: null });
}

/** An idle SDK session whose driver runs `onSend` at its acceptance boundary. */
function echoFixture(
  name: string,
  onSend: (f: { registry: InstanceType<typeof Registry>; key: string; text: string }) => "started" | null,
) {
  const registry = new Registry();
  const id = `sdk:${name}`;
  const key = `conversation:${name}`;
  registry.registerSdkSession({ id, agent: "claude", name, cwd: `/repo/${name}`, agentSessionId: key });
  const calls: string[] = [];
  const manager = new PendingTurnManager(
    registry,
    {
      ...unexpectedActiveSdkDelivery,
      sendWhenIdle: async (_id, turn, beforeSend) => {
        calls.push(turn.text);
        const blocker = beforeSend?.();
        if (blocker) throw new Error(blocker);
        return onSend({ registry, key, text: turn.text });
      },
    },
    { idleSettleMs: 0, pickupTimeoutMs: 15 },
  );
  manager.start();
  working(registry, id);
  turnDone(registry, id);
  return { registry, manager, id, key, calls };
}

for (const order of ["before", "after"] as const) {
  test(`a delivered SDK follow-up echoed ${order} its acknowledgement opens one revision`, async () => {
    const text = `follow up echoed ${order}`;
    const f = echoFixture(`echo-${order}`, ({ registry, key }) => {
      if (order === "before") sdkEcho(registry, key, `echo-${order}`, text);
      return "started";
    });
    f.manager.submit(f.id, text);
    await until(() => f.registry.getSession(f.id)?.pendingTurns.length === 0, "delivery");
    if (order === "after") sdkEcho(f.registry, f.key, `echo-${order}`, text);
    assert.equal(f.registry.getGoal(f.id)?.promptRevision, 1);
    assert.equal(f.registry.getGoal(f.id)?.prompt, text);
    f.manager.stop();
  });
}

test("an early echo whose turn completes before the SDK acknowledgement opens one revision", async () => {
  const name = "echo-turn-ends-first";
  const text = "a quick follow-up the agent finishes before the ack";
  const f = echoFixture(name, ({ registry, key }) => {
    sdkEcho(registry, key, name, text);
    working(registry, `sdk:${name}`);
    turnDone(registry, `sdk:${name}`);
    return "started";
  });
  f.manager.submit(f.id, text);
  await until(() => f.registry.getSession(f.id)?.pendingTurns.length === 0, "delivery");
  assert.equal(f.registry.getGoal(f.id)?.promptRevision, 1);
  f.manager.stop();
});

test("an early echo followed by a refused SDK acknowledgement opens one revision", async () => {
  const text = "early echo then refusal";
  let echoed = false;
  const f = echoFixture("echo-refused", ({ registry, key }) => {
    if (!echoed) sdkEcho(registry, key, "echo-refused", text);
    echoed = true;
    return null;
  });
  f.manager.submit(f.id, text);
  await until(() => f.registry.getSession(f.id)?.pendingTurns[0]?.state === "queued"
    && f.calls.length > 0, "the refusal");
  assert.equal(f.registry.getGoal(f.id)?.promptRevision, 1);
  f.manager.stop();
  clearPendingTurns(f.key);
});

test("an early echo followed by an uncertain SDK acknowledgement opens one revision", async () => {
  const text = "early echo then uncertainty";
  const f = echoFixture("echo-uncertain", ({ registry, key }) => {
    sdkEcho(registry, key, "echo-uncertain", text);
    throw new Error("receipt lost after the boundary");
  });
  f.manager.submit(f.id, text);
  await until(() => f.registry.getSession(f.id)?.pendingTurns[0]?.state === "uncertain", "uncertainty");
  assert.equal(f.registry.getGoal(f.id)?.promptRevision, 1);
  f.manager.stop();
  clearPendingTurns(f.key);
});

for (const failure of ["throws", "returns null"] as const) {
  test(`an early echo whose capture ${failure} is recorded by the acknowledgement, once`, async (t) => {
    const text = `early echo whose capture ${failure}`;
    const name = `echo-capture-${failure === "throws" ? "throws" : "null"}`;
    let hookFailed = false;
    const f = echoFixture(name, ({ registry, key }) => {
      const original = Registry.prototype.captureAcceptedPrompt;
      const mock = t.mock.method(registry, "captureAcceptedPrompt", function (
        this: InstanceType<typeof Registry>,
        ...args: Parameters<typeof original>
      ) {
        if (!hookFailed) {
          hookFailed = true;
          if (failure === "throws") throw new Error("goal write failed");
          return null;
        }
        return original.apply(this, args);
      });
      try {
        sdkEcho(registry, key, name, text);
      } catch {
        /* the hook's own capture threw; the acknowledgement records the turn */
      }
      assert.equal(mock.mock.callCount(), 1);
      return "started";
    });
    f.manager.submit(f.id, text);
    await until(() => f.registry.getSession(f.id)?.pendingTurns.length === 0, "delivery");
    assert.ok(hookFailed);
    assert.equal(f.registry.getGoal(f.id)?.promptRevision, 1);
    assert.equal(f.registry.getGoal(f.id)?.prompt, text);
    f.manager.stop();
  });
}

for (const failure of ["throws", "returns null"] as const) {
  test(`an acknowledgement whose capture ${failure} leaves the turn for its echo, once`, async (t) => {
    const text = `acknowledged capture ${failure}`;
    const name = `echo-ack-${failure === "throws" ? "throws" : "null"}`;
    const f = echoFixture(name, () => "started");
    const original = Registry.prototype.captureAcceptedPrompt;
    let ackFailed = false;
    t.mock.method(f.registry, "captureAcceptedPrompt", function (
      this: InstanceType<typeof Registry>,
      ...args: Parameters<typeof original>
    ) {
      if (!ackFailed) {
        ackFailed = true;
        if (failure === "throws") throw new Error("goal write failed");
        return null;
      }
      return original.apply(this, args);
    });
    f.manager.submit(f.id, text);
    await until(() => f.registry.getSession(f.id)?.pendingTurns.length === 0, "delivery");
    assert.ok(ackFailed, "the acknowledgement's capture was the one that failed");
    assert.equal(f.registry.getGoal(f.id), null, "nothing recorded yet");
    sdkEcho(f.registry, f.key, name, text);
    assert.equal(f.registry.getGoal(f.id)?.promptRevision, 1);
    assert.equal(f.registry.getGoal(f.id)?.prompt, text);
    f.manager.stop();
  });
}

test("a refused SDK send with no echo captures nothing and leaves no expectation", async () => {
  const text = "refused and never echoed";
  const f = echoFixture("echo-none-refused", () => null);
  f.manager.submit(f.id, text);
  await until(() => f.calls.length > 0
    && f.registry.getSession(f.id)?.pendingTurns[0]?.state === "queued", "the refusal");
  assert.equal(f.registry.getGoal(f.id), null);
  assert.equal(claimHumanEcho(f.id, f.key, text).kind, "none");
  f.manager.stop();
  clearPendingTurns(f.key);
});

test("an identical retype after an unechoed SDK follow-up is its own revision", async () => {
  const text = "say it again";
  const f = echoFixture("echo-retype", () => "started");
  f.manager.submit(f.id, text);
  await until(() => f.registry.getSession(f.id)?.pendingTurns.length === 0, "the first send");
  assert.equal(f.registry.getGoal(f.id)?.promptRevision, 1);
  working(f.registry, f.id);
  turnDone(f.registry, f.id);
  f.manager.submit(f.id, text);
  await until(() => f.calls.length === 2
    && f.registry.getSession(f.id)?.pendingTurns.length === 0, "the retype");
  assert.equal(f.registry.getGoal(f.id)?.promptRevision, 2, "one revision per send");
  f.manager.stop();
});

test("a steered SDK follow-up echoed after the running turn ends opens one revision", async (t) => {
  const name = "echo-steered";
  const text = "fold this into the next turn";
  const f = steeringFixture(name);
  const key = `steering:${name}`;
  const row = f.manager.submit(f.id, text).pendingTurn!;
  assert.ok(f.manager.expedite(f.id, row.id, row.revision, "steer"));
  await until(() => f.sends.length === 1, "the steer");
  assert.equal(f.registry.getGoal(f.id)?.promptRevision, 1, "the acknowledgement captured it");
  const capture = t.mock.method(f.registry, "captureAcceptedPrompt");

  // The running turn ends, and only then does Claude dequeue the follow-up and echo it.
  turnDone(f.registry, f.id);
  assert.equal(claimHumanEcho(f.id, key, "not this text").kind, "none");
  sdkEcho(f.registry, key, name, text);
  assert.equal(capture.mock.callCount(), 0, "the echo answered skip");
  assert.equal(f.registry.getGoal(f.id)?.promptRevision, 1);

  // The follow-up's own turn completes; a later hook-only arrival of the text is new input.
  working(f.registry, f.id);
  turnDone(f.registry, f.id);
  sdkEcho(f.registry, key, name, text);
  assert.equal(f.registry.getGoal(f.id)?.promptRevision, 2);
  f.manager.stop();
});

test("a steered follow-up's entry survives the turn it waited behind and expires with its own", async () => {
  const name = "echo-steered-expiry";
  const text = "queued behind the running turn";
  const f = steeringFixture(name);
  const key = `steering:${name}`;
  const row = f.manager.submit(f.id, text).pendingTurn!;
  assert.ok(f.manager.expedite(f.id, row.id, row.revision, "steer"));
  await until(() => f.sends.length === 1, "the steer");
  turnDone(f.registry, f.id);
  working(f.registry, f.id);
  turnDone(f.registry, f.id);
  assert.equal(claimHumanEcho(f.id, key, text).kind, "none", "its own turn completed");
  f.manager.stop();
});

test("with no turn end, a captured SDK follow-up stops absorbing echoes once it ages out", async (t) => {
  const name = "echo-aged";
  const text = "an echo that never came";
  // Only Date is mocked: the manager's default clock and the registry's hook clock both read
  // it, while the polling below still runs on real timers.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = echoFixture(name, () => "started");
  f.manager.submit(f.id, text);
  await until(() => f.registry.getSession(f.id)?.pendingTurns.length === 0, "delivery");
  assert.equal(f.registry.getGoal(f.id)?.promptRevision, 1);
  t.mock.timers.tick(HUMAN_ECHO_TTL_MS + 1);
  sdkEcho(f.registry, f.key, name, text);
  assert.equal(f.registry.getGoal(f.id)?.promptRevision, 2, "a hook-only arrival is captured");
  f.manager.stop();
});

test("a woken session's queued message waits until its task is bound, then is delivered once", async () => {
  // A hibernated task's woken driver has not yet shown it reopened the task's conversation
  // (`SdkSupervisor.holdsDelivery`): rows stay queued without a single attempt, so nothing is
  // retried in a loop, and the binding's `session_upsert` releases them.
  let held = true;
  const registry = new Registry();
  const id = "sdk:held-wake";
  registry.registerSdkSession({ id, agent: "claude", name: "held-wake", cwd: "/repo/held-wake", agentSessionId: "conversation:held-wake" });
  const calls: string[] = [];
  const manager = new PendingTurnManager(
    registry,
    {
      ...unexpectedActiveSdkDelivery,
      sendWhenIdle: async (_id, turn, beforeSend) => {
        calls.push(turn.text);
        const blocker = beforeSend?.();
        if (blocker) throw new Error(blocker);
        return "started";
      },
      holdsDelivery: () => held,
    },
    { idleSettleMs: 0, pickupTimeoutMs: 15 },
  );
  manager.start();
  idle(registry, id);
  manager.submit(id, "while it wakes");
  await tick(60);
  assert.deepEqual(calls, [], "nothing reaches a driver that has not reopened its conversation");
  assert.equal(registry.getSession(id)?.pendingTurns.length, 1, "the row stays queued");

  held = false;
  registry.emit("event", { type: "session_upsert", session: registry.getSession(id)! });
  await until(() => calls.length === 1, "delivery once the task is bound");
  await tick(60);
  assert.deepEqual(calls, ["while it wakes"], "delivered exactly once");
  manager.stop();
});

/** The operator's pause, as `PauseManager` publishes it onto the session. */
function pauseSession(registry: InstanceType<typeof Registry>, id: string, since: number): void {
  registry.setSessionPause(id, { reason: "operator", phase: "frozen", since, interrupted: null, stopped: true });
}

/** A resume, as `PauseManager.lift` writes it: the resume time first, then the cleared pause. */
function resumeSession(registry: InstanceType<typeof Registry>, id: string): void {
  registry.setSessionResumedAt(id, Date.now());
  registry.setSessionPause(id, null);
}

test("a message queued before a long pause waits through it, then steers one minute after the resume", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 700000 });
  const f = steeringFixture("pause-rebase-steer");
  const row = f.manager.submit(f.id, "queued before the pause").pendingTurn!;
  assert.equal(row.createdAt, 700000);
  pauseSession(f.registry, f.id, 700000);

  // Ten minutes paused: far past both the one-minute steer and the three-minute interrupt,
  // and nothing is attempted while the session is held.
  t.mock.timers.tick(600000);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(f.sends, [], "nothing is steered into a paused session");
  assert.equal(f.interrupts(), 0, "nothing interrupts a paused session");
  assert.equal(f.registry.getSession(f.id)?.pendingTurns[0]?.state, "queued");

  // Resumed mid-turn. Counted from its enqueue the row is nine minutes overdue for a steer and
  // seven for an interrupt; counted from the resume it gets the same quiet minute as a new one.
  resumeSession(f.registry, f.id);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(f.sends, [], "the resume does not steer the overdue message at once");
  assert.equal(f.interrupts(), 0, "the resume does not interrupt the turn it just thawed");
  t.mock.timers.tick(59999);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(f.sends, [], "still inside the minute after the resume");
  t.mock.timers.tick(1);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(f.sends, ["queued before the pause"], "steered exactly one minute after the resume");
  assert.equal(f.interrupts(), 0);
  f.manager.stop();
});

test("a message queued before a long pause interrupts three minutes after the resume, not at once", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 800000 });
  // Steering is refused throughout, so the second stage is the one under test.
  const f = steeringFixture("pause-rebase-interrupt", { beforeSteer: async () => {
    throw new Error("the driver refused this steer");
  } });
  f.manager.submit(f.id, "interrupt only after the resume's three minutes");
  pauseSession(f.registry, f.id, 800000);
  t.mock.timers.tick(600000);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.interrupts(), 0);

  resumeSession(f.registry, f.id);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.interrupts(), 0, "the resume does not interrupt at once");
  t.mock.timers.tick(179999);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.interrupts(), 0, "three minutes from the resume, not from the enqueue");
  t.mock.timers.tick(1);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.interrupts(), 1, "interrupted exactly three minutes after the resume");
  f.manager.stop();
});

test("a daemon restart just after a resume keeps the held message's deadlines counted from the resume", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 900000 });
  const f = steeringFixture("pause-rebase-restart");
  f.manager.submit(f.id, "queued before the pause, delivered after a restart");
  pauseSession(f.registry, f.id, 900000);
  t.mock.timers.tick(600000);
  resumeSession(f.registry, f.id);
  // The daemon stops ten seconds after the resume. The registry the next manager reads holds the
  // resume time because `PauseManager` persisted it and hands it back on start.
  t.mock.timers.tick(10000);
  f.manager.stop();
  const restarted = new PendingTurnManager(f.registry, {
    ...unexpectedActiveSdkDelivery,
    sendWhenIdle: async () => null,
    send: async (_id, turn, guard) => {
      const blocked = guard?.();
      if (blocked) throw new Error(blocked);
      f.sends.push(turn.text);
      return "steered";
    },
  }, { idleSettleMs: 0 });
  restarted.start();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(f.sends, [], "the restart does not treat the held message as ten minutes overdue");
  t.mock.timers.tick(49999);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(f.sends, [], "still inside the minute after the resume");
  t.mock.timers.tick(1);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(f.sends, ["queued before the pause, delivered after a restart"], "steered one minute after the resume");
  restarted.stop();
});

test("a snoozed question's carry-on instruction is delivered as the daemon's words, not the operator's", async (t) => {
  const f = sdkFixture("snooze-instruction", async () => "started");
  const episode = scoutEpisode(f.registry, f.id);
  // Production wiring: daemon-typed text reaches the scout journal through this observer.
  observeInjections((sessionId, text, origin) => journalScoutPrompt(f.registry, sessionId, text, origin));
  t.after(() => observeInjections(null));
  const text = 'Your earlier request_input question "Which linter?" ended before the operator chose.';
  createPendingTurn({ id: `${SNOOZE_INSTRUCTION_TURN_PREFIX}review-1`, noteKey: f.key, text, now: 1 });
  f.registry.refreshPendingTurns(f.key);

  idle(f.registry, f.id);
  await settles(() => (f.registry.getSession(f.id)?.pendingTurns.length ?? 1) === 0);

  assert.deepEqual(f.calls, [text], "delivered once");
  assert.equal(f.registry.getGoal(f.id), null, "never captured as the operator's Goal");
  assert.equal(originOf(f.id, text), "harness", "attributed to the daemon in the conversation");
  const journaled = scoutPromptTurns(episode.taskId, episode.episodeId);
  assert.deepEqual(journaled.map((turn) => turn.origin), ["harness"], "journaled once, never as human");
  f.manager.stop();
  clearPendingTurns(f.key);
  clearScoutPromptContext(episode.taskId, episode.episodeId);
});

test("a daemon-written row whose attribution cannot be stored is refused before the driver sees it, and goes back to the queue", async (t) => {
  const f = sdkFixture("attribution-refused", async () => "started");
  // A declared wait that cannot record the delivery as Mission Control's (its store failed).
  t.after(onAutomatedDelivery(() => { throw new Error("store down"); }));
  const text = 'Your earlier request_input question "Which build?" ended before the operator chose.';
  createPendingTurn({ id: `${SNOOZE_INSTRUCTION_TURN_PREFIX}review-refused`, noteKey: f.key, text, now: 1 });
  f.registry.refreshPendingTurns(f.key);

  idle(f.registry, f.id);
  await settles(() => f.registry.getSession(f.id)?.pendingTurns[0]?.state === "queued"
    && f.registry.getSession(f.id)?.pendingTurns[0]?.lastError != null);

  assert.deepEqual(f.calls, [], "the driver was handed a delivery whose attribution was not stored");
  const row = f.registry.getSession(f.id)?.pendingTurns[0];
  assert.match(row?.lastError ?? "", /could not record this delivery/);
  assert.equal(originOf(f.id, text), undefined, "a refused delivery still claimed authorship");
  f.manager.stop();
  clearPendingTurns(f.key);
});

test("an operator's row whose attribution cannot be stored is refused before the driver sees it, and goes back to the queue", async (t) => {
  const f = sdkFixture("person-attribution-refused", async () => "started");
  // A declared wait that cannot record these words as the operator's (its store failed).
  t.after(onPersonDelivery(() => { throw new Error("store down"); }));
  const text = "Check the release notes before you merge.";
  createPendingTurn({ id: "operator-refused", noteKey: f.key, text, now: 1 });
  f.registry.refreshPendingTurns(f.key);

  idle(f.registry, f.id);
  await settles(() => f.registry.getSession(f.id)?.pendingTurns[0]?.state === "queued"
    && f.registry.getSession(f.id)?.pendingTurns[0]?.lastError != null);

  assert.deepEqual(f.calls, [], "the driver was handed words whose attribution was not stored");
  assert.match(f.registry.getSession(f.id)?.pendingTurns[0]?.lastError ?? "", /could not record these words as a person's/);
  f.manager.stop();
  clearPendingTurns(f.key);
});

// ---- async-input: answers to filed questions are the daemon's words ----------------------

/** A settled `request_input` question, as the review manager leaves it before handing it on. */
function settledQuestion(id: string, sessionId: string, actor: "human" | "foreman" | "standing-approval", waitMode?: "message") {
  insertReview({
    id, sessionId, kind: "input", title: "Which linter?", body: "Which linter?", status: "pending",
    response: null, snoozable: true, ...(waitMode ? { waitMode } : {}), createdAt: 1, resolvedAt: null,
  });
  // A call-mode answer reaches the outbox only once its call has ended.
  if (!waitMode) markReviewWaitDetached(id, 1);
  updateReviewStatus(id, "answered", "Answered: eslint", 2, null, actor);
}

for (const actor of ["human", "foreman", "standing-approval"] as const) {
  test(`an answer to a filed question from ${actor} is delivered as the daemon's words: no Goal, no human echo (async-input)`, async (t) => {
    const f = sdkFixture(`filed-answer-${actor}`, async () => "started");
    const episode = scoutEpisode(f.registry, f.id);
    observeInjections((sessionId, text, origin) => journalScoutPrompt(f.registry, sessionId, text, origin));
    t.after(() => observeInjections(null));
    const reviewId = `filed-${actor}`;
    settledQuestion(reviewId, f.id, actor, "message");
    const text = `Mission Control review ${reviewId} was answered after its MCP wait ended. Answered: eslint (${actor})`;
    const queued = f.manager.submitReviewContinuation(reviewId, f.id, text);
    assert.equal(queued.ok, true);
    assert.equal(queued.ok && queued.pendingTurn?.id, `${MESSAGE_ANSWER_TURN_PREFIX}${reviewId}`);
    assert.ok(`${MESSAGE_ANSWER_TURN_PREFIX}${reviewId}`.startsWith("review-continuation:"), "resident pacing still reads it as review news");

    idle(f.registry, f.id);
    await settles(() => (f.registry.getSession(f.id)?.pendingTurns.length ?? 1) === 0);
    assert.deepEqual(f.calls, [text], "delivered once");
    assert.equal(f.registry.getGoal(f.id), null, "never captured as a Goal revision");
    assert.equal(originOf(f.id, text), "harness", "attributed to the daemon, not drawn as an operator turn");
    assert.equal(claimHumanEcho(f.id, f.key, text).kind, "none", "no human echo was expected");
    assert.deepEqual(scoutPromptTurns(episode.taskId, episode.episodeId).map((turn) => turn.origin), ["harness"]);
    f.manager.stop();
    clearPendingTurns(f.key);
    clearScoutPromptContext(episode.taskId, episode.episodeId);
  });
}

test("a call-mode answer that lost its call keeps operator authorship, as today (async-input)", async () => {
  const f = sdkFixture("call-answer", async () => "started");
  settledQuestion("call-human", f.id, "human");
  const text = "Mission Control review call-human was answered after its MCP wait ended. Answered: biome";
  const queued = f.manager.submitReviewContinuation("call-human", f.id, text);
  assert.equal(queued.ok && queued.pendingTurn?.id, "review-continuation:call-human");
  idle(f.registry, f.id);
  await settles(() => (f.registry.getSession(f.id)?.pendingTurns.length ?? 1) === 0);
  assert.deepEqual(f.calls, [text]);
  assert.notEqual(originOf(f.id, text), "harness", "the operator's answer stays theirs");
  f.manager.stop();
  clearPendingTurns(f.key);
});

test("daemon authorship does not exempt a filed question's answer from the steer at 60 s (async-input)", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 900000 });
  const f = steeringFixture("filed-answer-steer");
  settledQuestion("filed-steer", f.id, "foreman", "message");
  const text = "Mission Control review filed-steer was answered. Answered: eslint";
  assert.equal(f.manager.submitReviewContinuation("filed-steer", f.id, text).ok, true);
  t.mock.timers.tick(59999);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(f.sends, [], "inside the quiet minute an operator message gets too");
  t.mock.timers.tick(1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(f.sends, [text], "steered into the working turn at 60 s");
  assert.equal(f.registry.getGoal(f.id), null, "a steered answer is not a Goal revision either");
  assert.equal(originOf(f.id, text), "harness");
  f.manager.stop();
  clearPendingTurns(noteKeyFor(f.registry.getSession(f.id)!));
});

test("daemon authorship does not exempt a filed question's answer from the interrupt at 180 s (async-input)", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000000 });
  const f = steeringFixture("filed-answer-interrupt", { beforeSteer: async () => {
    throw new Error("the driver refused this steer");
  } });
  settledQuestion("filed-interrupt", f.id, "human", "message");
  assert.equal(f.manager.submitReviewContinuation("filed-interrupt", f.id, "Answered: eslint, interrupt").ok, true);
  t.mock.timers.tick(179999);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.interrupts(), 0);
  t.mock.timers.tick(1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.interrupts(), 1, "interrupted at 180 s, like an operator message");
  f.manager.stop();
  clearPendingTurns(noteKeyFor(f.registry.getSession(f.id)!));
});

// Phase 2 exercises the same delivery owner with the new text and durable coalescing.
for (const count of [1, 5]) {
  test(`${count} self-contained answers wake once with daemon authorship and no Goal or human echo`, async (t) => {
    const { asyncInputAnswer } = await import("../src/shared/async-input.ts");
    const f = sdkFixture(`self-contained-${count}`, async () => "started");
    const episode = scoutEpisode(f.registry, f.id);
    observeInjections((sessionId, text, origin) => journalScoutPrompt(f.registry, sessionId, text, origin));
    t.after(() => observeInjections(null));
    const texts: string[] = [];
    for (let i = 0; i < count; i++) {
      const id = `self-contained-${count}-${i}`;
      settledQuestion(id, f.id, "foreman", "message");
      const text = asyncInputAnswer({ id, sessionId: f.id, kind: "input", title: "Which?", body: `Question ${i}?`,
        status: "answered", response: "eslint", meanwhile: "Prepare the tests", createdAt: 1, resolvedAt: 2 });
      texts.push(text);
      assert.equal(f.manager.submitReviewContinuation(id, f.id, text).ok, true);
    }
    const combined = texts.join("\n\n---\n\n");
    idle(f.registry, f.id);
    await settles(() => (f.registry.getSession(f.id)?.pendingTurns.length ?? 1) === 0);
    assert.deepEqual(f.calls, [combined]);
    assert.equal(f.registry.getGoal(f.id), null);
    assert.equal(originOf(f.id, combined), "harness");
    assert.equal(claimHumanEcho(f.id, f.key, combined).kind, "none");
    assert.deepEqual(scoutPromptTurns(episode.taskId, episode.episodeId).map((turn) => turn.origin), ["harness"]);
    f.manager.stop(); clearPendingTurns(f.key); clearScoutPromptContext(episode.taskId, episode.episodeId);
  });
}

for (const mode of ["steer", "interrupt"] as const) test(`coalescing preserves the first answer's ${mode} deadline`, async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 2000000 });
  const f = steeringFixture(`coalesced-${mode}`, mode === "interrupt" ? { beforeSteer: async () => { throw new Error("steer refused"); } } : {});
  settledQuestion(`first-${mode}`, f.id, "human", "message");
  f.manager.submitReviewContinuation(`first-${mode}`, f.id, "First answer");
  t.mock.timers.tick(30000);
  settledQuestion(`second-${mode}`, f.id, "foreman", "message");
  f.manager.submitReviewContinuation(`second-${mode}`, f.id, "Second answer");
  const deadline = mode === "steer" ? 60000 : 180000;
  t.mock.timers.tick(deadline - 30001);
  await new Promise<void>((resolve) => setImmediate(resolve));
  if (mode === "steer") assert.deepEqual(f.sends, []);
  else assert.equal(f.interrupts(), 0);
  t.mock.timers.tick(1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  if (mode === "steer") {
    assert.deepEqual(f.sends, ["First answer\n\n---\n\nSecond answer"]);
    assert.equal(f.registry.getGoal(f.id), null);
    assert.equal(originOf(f.id, f.sends[0]!), "harness");
  } else assert.equal(f.interrupts(), 1);
  f.manager.stop(); clearPendingTurns(noteKeyFor(f.registry.getSession(f.id)!));
});

// ---- async-input answer cards: a marked row records its own delivery -----------------------

const { openDb } = await import("../src/server/db.ts");
const { parseReviewEnvelope } = await import("../src/shared/review-message-envelope.ts");
const deliveriesFor = (key: string) => openDb().prepare(
  "SELECT id, review_ids AS reviewIds, confirmed_at AS confirmedAt FROM session_review_deliveries WHERE note_key = ?",
).all(key) as Array<{ id: string; reviewIds: string; confirmedAt: number | null }>;

test("a marked answer reserves exactly one delivery before the send and confirms it on acceptance", async () => {
  let atSend: Array<{ confirmedAt: number | null }> | null = null;
  const f = sdkFixture("marked-answer", async () => {
    atSend = deliveriesFor(f.key);
    return "started";
  });
  const reviewId = crypto.randomUUID();
  settledQuestion(reviewId, f.id, "human", "message");
  const text = "Mission Control answer to question: Answered: eslint";
  assert.equal(f.manager.submitReviewContinuation(reviewId, f.id, text).ok, true);
  idle(f.registry, f.id);
  await settles(() => (f.registry.getSession(f.id)?.pendingTurns.length ?? 1) === 0);
  assert.equal(f.calls.length, 1);
  const envelope = parseReviewEnvelope(f.calls[0]!);
  assert.deepEqual(envelope && { ids: envelope.reviewIds, rest: envelope.rest }, { ids: [reviewId], rest: text },
    "the agent reads exactly the old text below one marker line");
  assert.equal(atSend!.length, 1, "reserved before the runtime was handed the text");
  assert.equal(atSend![0]!.confirmedAt, null);
  const [row] = deliveriesFor(f.key);
  assert.deepEqual(JSON.parse(row!.reviewIds), [reviewId]);
  assert.notEqual(row!.confirmedAt, null, "confirmed once the driver accepted it");
  assert.equal(deliveriesFor(f.key).length, 1);
  assert.equal(f.registry.getGoal(f.id), null);
  assert.equal(originOf(f.id, f.calls[0]!), "harness", "still daemon-authored");
  f.manager.stop(); clearPendingTurns(f.key);
});

test("a refused marked delivery releases its reservation", async () => {
  const f = sdkFixture("marked-refused", async () => null);
  const reviewId = crypto.randomUUID();
  settledQuestion(reviewId, f.id, "human", "message");
  assert.equal(f.manager.submitReviewContinuation(reviewId, f.id, "Answered: eslint").ok, true);
  idle(f.registry, f.id);
  await until(() => f.calls.length >= 1, "the refused attempt");
  await until(() => deliveriesFor(f.key).length === 0, "the refused delivery's reservation to be released");
  f.manager.stop(); clearPendingTurns(f.key);
});

test("a marked call-mode late answer (flag on) is never captured as a Goal revision at the send door", async (t) => {
  assert.equal(applyFeatureFlagIntent({ kind: "flag", id: "async-input", enabled: true }).ok, true);
  t.after(() => applyFeatureFlagIntent({ kind: "flag", id: "async-input", enabled: false }));
  const f = sdkFixture("marked-call-answer", async () => "started");
  const reviewId = crypto.randomUUID();
  settledQuestion(reviewId, f.id, "human");
  const text = `Mission Control review ${reviewId} was answered after its MCP wait ended. Answered: biome`;
  const queued = f.manager.submitReviewContinuation(reviewId, f.id, text);
  assert.equal(queued.ok && queued.pendingTurn?.id, `review-continuation:${reviewId}`, "the turn id is unchanged");
  idle(f.registry, f.id);
  await settles(() => (f.registry.getSession(f.id)?.pendingTurns.length ?? 1) === 0);
  assert.equal(parseReviewEnvelope(f.calls[0]!)?.rest, text);
  assert.equal(f.registry.getGoal(f.id), null, "a delivery is nobody's ask");
  assert.equal(claimHumanEcho(f.id, f.key, f.calls[0]!).kind, "none");
  assert.equal(deliveriesFor(f.key).length, 1);
  f.manager.stop(); clearPendingTurns(f.key);
});

for (const mode of ["steer", "interrupt"] as const) test(`a marked answer keeps the ${mode} at ${mode === "steer" ? 60 : 180} s`, async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 3000000 });
  const f = steeringFixture(`marked-${mode}`, mode === "interrupt" ? { beforeSteer: async () => { throw new Error("steer refused"); } } : {});
  const reviewId = crypto.randomUUID();
  settledQuestion(reviewId, f.id, "foreman", "message");
  assert.equal(f.manager.submitReviewContinuation(reviewId, f.id, "Answered: eslint").ok, true);
  const deadline = mode === "steer" ? 60000 : 180000;
  t.mock.timers.tick(deadline - 1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  if (mode === "steer") assert.deepEqual(f.sends, []);
  else assert.equal(f.interrupts(), 0);
  t.mock.timers.tick(1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  if (mode === "steer") {
    assert.equal(f.sends.length, 1);
    assert.deepEqual(parseReviewEnvelope(f.sends[0]!)?.reviewIds, [reviewId]);
    assert.equal(originOf(f.id, f.sends[0]!), "harness");
    assert.equal(f.registry.getGoal(f.id), null);
  } else assert.equal(f.interrupts(), 1);
  f.manager.stop(); clearPendingTurns(noteKeyFor(f.registry.getSession(f.id)!));
});

/** Make every write of a delivery's confirmation fail, as a full disk or a locked file would. */
function failConfirmationWrites(t: { after: (fn: () => void) => void }): void {
  openDb().exec(`CREATE TEMP TRIGGER fail_review_confirmation BEFORE UPDATE OF confirmed_at ON session_review_deliveries
    BEGIN SELECT RAISE(ABORT, 'confirmation write failed'); END;`);
  t.after(() => openDb().exec("DROP TRIGGER IF EXISTS temp.fail_review_confirmation"));
}

test("an SDK answer the runtime accepted is retired even when recording its confirmation fails", async (t) => {
  failConfirmationWrites(t);
  const f = sdkFixture("marked-confirm-fails", async () => "started");
  const reviewId = crypto.randomUUID();
  settledQuestion(reviewId, f.id, "human", "message");
  assert.equal(f.manager.submitReviewContinuation(reviewId, f.id, "Answered: eslint").ok, true);
  idle(f.registry, f.id);
  await until(() => (f.registry.getSession(f.id)?.pendingTurns.length ?? 1) === 0, "the accepted answer to leave the outbox");
  assert.equal(f.calls.length, 1, "accepted once, and never made retryable");
  assert.equal(deliveriesFor(f.key)[0]?.confirmedAt, null, "the confirmation write did fail");
  f.manager.stop(); clearPendingTurns(f.key);
});

test("a pasted terminal answer still completes pickup when recording its confirmation fails", async (t) => {
  failConfirmationWrites(t);
  let key = "";
  const f = terminalFixture("marked-terminal-confirm-fails", async () => ({ ok: true, pasted: true, submitVerified: true }));
  key = noteKeyFor(f.registry.getSession(f.id)!);
  const reviewId = crypto.randomUUID();
  settledQuestion(reviewId, f.id, "human", "message");
  assert.equal(f.manager.submitReviewContinuation(reviewId, f.id, "Answered: eslint").ok, true);
  await until(() => (f.registry.getSession(f.id)?.pendingTurns.length ?? 1) === 0, "the verified paste to complete pickup");
  assert.equal(f.injected.length, 1, "pasted once");
  assert.equal(deliveriesFor(key)[0]?.confirmedAt, null, "the confirmation write did fail");
  f.manager.stop(); clearPendingTurns(key);
});

test("an operator message that begins with a review marker is the operator's: no delivery is reserved for it", async () => {
  const f = sdkFixture("operator-marker", async () => "started");
  const reviewId = crypto.randomUUID();
  settledQuestion(reviewId, f.id, "human", "message");
  const pasted = `[mission-control:answer review=${reviewId}]\n\nI pasted this marker myself.`;
  assert.equal(f.manager.submit(f.id, pasted).ok, true);
  idle(f.registry, f.id);
  await settles(() => (f.registry.getSession(f.id)?.pendingTurns.length ?? 1) === 0);
  assert.deepEqual(f.calls, [pasted]);
  assert.equal(deliveriesFor(f.key).length, 0, "the marker proves nothing; only the daemon's own rows are recorded");
  assert.notEqual(f.registry.getGoal(f.id), null, "and it reaches the Goal like any operator message");
  f.manager.stop(); clearPendingTurns(f.key);
});

for (const refused of [false, true]) test(`a marked answer pasted into a terminal ${refused ? "releases its reservation when the pane refuses it" : "reserves before the paste and confirms on success"}`, async () => {
  let atPaste = -1;
  let key = "";
  const f = terminalFixture(`marked-terminal-${refused}`, async () => {
    atPaste = deliveriesFor(key).length;
    return refused ? { ok: false, pasted: false, submitVerified: false, error: "pane refused" } : { ok: true, pasted: true, submitVerified: true };
  });
  key = noteKeyFor(f.registry.getSession(f.id)!);
  const reviewId = crypto.randomUUID();
  settledQuestion(reviewId, f.id, "human", "message");
  assert.equal(f.manager.submitReviewContinuation(reviewId, f.id, "Answered: eslint").ok, true);
  await until(() => f.injected.length >= 1, "the paste");
  assert.equal(atPaste, 1, "reserved before the text reached the pane");
  assert.equal(parseReviewEnvelope(f.injected[0]!)?.rest, "Answered: eslint");
  if (refused) await until(() => deliveriesFor(key).length === 0, "the refused paste's reservation to be released");
  else await until(() => deliveriesFor(key)[0]?.confirmedAt != null, "the pasted delivery to be confirmed");
  f.manager.stop(); clearPendingTurns(key);
});

test("a queued after-work prompt is dropped, never sent, when task shaping is off at delivery", async () => {
  const { queueTaskSkillPromptTurn, getTaskSkillPrompt } = await import("../src/server/db.ts");
  const { AFTER_WORK_SKILLS_TURN_PREFIX } = await import("../src/shared/message-delivery.ts");
  const { AFTER_WORK_FLAG_OFF } = await import("../src/server/pending-turns.ts");
  const run = (name: string, enabled: boolean) => {
    const registry = new Registry();
    const id = `sdk:${name}`;
    registry.registerSdkSession({ id, agent: "claude", name, cwd: `/repo/${name}`, agentSessionId: `conversation:${name}` });
    const sent: string[] = [];
    let shaping = true;
    const manager = new PendingTurnManager(registry, {
      ...unexpectedActiveSdkDelivery,
      sendWhenIdle: async (_id, turn) => { sent.push(turn.text); return "started"; },
    }, { idleSettleMs: 0, pickupTimeoutMs: 15, afterWorkEnabled: () => shaping });
    manager.start();
    working(registry, id);
    const turnId = `${AFTER_WORK_SKILLS_TURN_PREFIX}task-${name}:${id}:1`;
    // Queued while task shaping was on, as the after-work prompter queues it.
    const queued = manager.submitDaemonTurn(id, (noteKey, now) => queueTaskSkillPromptTurn({
      taskId: `task-${name}`, sessionId: id, noteKey, turnId, text: "/wrap-notes\n\nThe work is complete.", skills: ["wrap-notes"], from: null, now,
    }));
    assert.equal(queued.pendingTurn?.id, turnId);
    shaping = enabled;
    return { registry, manager, id, sent, row: () => getTaskSkillPrompt(`task-${name}`, id) };
  };

  const off = run("after-work-off", false);
  idle(off.registry, off.id);
  await settles(() => (off.registry.getSession(off.id)?.pendingTurns.length ?? 1) === 0);
  await tick(20);
  assert.deepEqual(off.sent, [], "nothing is sent once the flag is off");
  assert.deepEqual(off.registry.getSession(off.id)?.pendingTurns, [], "the queued turn is gone from the outbox");
  assert.equal(off.row()?.state, "not_delivered");
  assert.equal(off.row()?.reason, AFTER_WORK_FLAG_OFF);
  off.manager.stop();

  // The same turn with the flag still on is delivered at idle.
  const on = run("after-work-on", true);
  idle(on.registry, on.id);
  await until(() => on.sent.length > 0, "the after-work turn to be delivered");
  assert.equal(on.sent[0]!.split("\n")[0], "/wrap-notes");
  on.manager.stop();
});

test("an after-work turn a later launch supersedes while its delivery holds it never reaches the agent", async () => {
  const { queueTaskSkillPromptTurn, upsertTask, commitTaskShaping } = await import("../src/server/db.ts");
  const { AFTER_WORK_SKILLS_TURN_PREFIX } = await import("../src/shared/message-delivery.ts");
  const registry = new Registry();
  const id = "sdk:after-work-superseded";
  registry.registerSdkSession({ id, agent: "claude", name: "superseded", cwd: "/repo/superseded", agentSessionId: "conversation:superseded" });
  const taskId = "task-superseded";
  upsertTask(mkTask({ id: taskId, status: "running", sessionId: id }));
  const sent: string[] = [];
  let handoffs = 0;
  const manager = new PendingTurnManager(registry, {
    ...unexpectedActiveSdkDelivery,
    sendWhenIdle: async (_id, turn, beforeSend) => {
      handoffs += 1;
      // The task is handed back to this session while the delivery holds the turn: the new
      // launch's shaping commit removes the earlier launch's prompt row, but not the claimed turn.
      commitTaskShaping(taskId, null, "", Date.now(), id);
      if (beforeSend?.()) return null;
      sent.push(turn.text);
      return "started";
    },
  }, { idleSettleMs: 0, pickupTimeoutMs: 15, afterWorkEnabled: () => true });
  manager.start();
  working(registry, id);
  manager.submitDaemonTurn(id, (noteKey, now) => queueTaskSkillPromptTurn({
    taskId, sessionId: id, noteKey, turnId: `${AFTER_WORK_SKILLS_TURN_PREFIX}${taskId}:${id}:1`,
    text: "/wrap-notes\n\nThe work is complete.", skills: ["wrap-notes"], from: null, now,
  }));
  idle(registry, id);
  await settles(() => handoffs > 0 && (registry.getSession(id)?.pendingTurns.length ?? 1) === 0);
  assert.deepEqual(sent, [], "the superseded launch's prompt is refused at the acceptance guard");
  assert.deepEqual(registry.getSession(id)?.pendingTurns, [], "and dropped, not claimed again");
  manager.stop();
});

test("an after-work turn task shaping is turned off for while its delivery holds it never reaches the agent", async () => {
  const { queueTaskSkillPromptTurn, getTaskSkillPrompt } = await import("../src/server/db.ts");
  const { AFTER_WORK_SKILLS_TURN_PREFIX } = await import("../src/shared/message-delivery.ts");
  const { AFTER_WORK_FLAG_OFF } = await import("../src/server/pending-turns.ts");
  const queue = (manager: InstanceType<typeof PendingTurnManager>, id: string, taskId: string) => manager.submitDaemonTurn(id, (noteKey, now) => queueTaskSkillPromptTurn({
    taskId, sessionId: id, noteKey, turnId: `${AFTER_WORK_SKILLS_TURN_PREFIX}${taskId}:${id}:1`,
    text: "/wrap-notes\n\nThe work is complete.", skills: ["wrap-notes"], from: null, now,
  }));

  // SDK: the flag is turned off after the outbox claimed the turn, while the driver waits to send it.
  {
    const registry = new Registry();
    const id = "sdk:after-work-flag-held";
    registry.registerSdkSession({ id, agent: "claude", name: "flag-held", cwd: "/repo/flag-held", agentSessionId: "conversation:flag-held" });
    let shaping = true;
    let handoffs = 0;
    const sent: string[] = [];
    const manager = new PendingTurnManager(registry, {
      ...unexpectedActiveSdkDelivery,
      sendWhenIdle: async (_id, turn, beforeSend) => {
        handoffs += 1;
        shaping = false;
        if (beforeSend?.()) return null;
        sent.push(turn.text);
        return "started";
      },
    }, { idleSettleMs: 0, pickupTimeoutMs: 15, afterWorkEnabled: () => shaping, afterWorkTurnOwed: () => true });
    manager.start();
    working(registry, id);
    queue(manager, id, "task-flag-held-sdk");
    idle(registry, id);
    await settles(() => handoffs > 0 && (registry.getSession(id)?.pendingTurns.length ?? 1) === 0);
    assert.deepEqual(sent, [], "refused at the acceptance guard once the flag is off");
    assert.deepEqual(registry.getSession(id)?.pendingTurns, [], "and dropped, not claimed again");
    assert.equal(getTaskSkillPrompt("task-flag-held-sdk", id)?.state, "not_delivered");
    assert.equal(getTaskSkillPrompt("task-flag-held-sdk", id)?.reason, AFTER_WORK_FLAG_OFF);
    manager.stop();
  }

  // Terminal: the flag is turned off after the outbox claimed the turn, before the paste.
  {
    const name = "after-work-flag-pane";
    const registry = new Registry();
    registry.applyDiscovery([discovered(name)]);
    let shaping = true;
    let handoffs = 0;
    const pasted: string[] = [];
    const manager = new PendingTurnManager(
      registry,
      { ...unexpectedActiveSdkDelivery, sendWhenIdle: async () => "started" },
      {
        idleSettleMs: 0,
        pickupTimeoutMs: 15,
        afterWorkEnabled: () => shaping,
        afterWorkTurnOwed: () => true,
        inject: async (_session, text, _deps, beforeWrite) => {
          handoffs += 1;
          shaping = false;
          const blocker = beforeWrite?.() ?? null;
          if (blocker) return { ok: false, error: blocker, pasted: false, submitVerified: false };
          pasted.push(text);
          return { ok: true, pasted: true, submitVerified: true };
        },
      },
    );
    manager.start();
    const id = `terminal:${name}`;
    working(registry, id);
    queue(manager, id, "task-flag-held-pane");
    stopHook(registry, name);
    await settles(() => handoffs > 0 && (registry.getSession(id)?.pendingTurns.length ?? 1) === 0);
    assert.deepEqual(pasted, [], "refused at the paste guard once the flag is off");
    assert.deepEqual(registry.getSession(id)?.pendingTurns, [], "and dropped, not claimed again");
    assert.equal(getTaskSkillPrompt("task-flag-held-pane", id)?.state, "not_delivered");
    assert.equal(getTaskSkillPrompt("task-flag-held-pane", id)?.reason, AFTER_WORK_FLAG_OFF);
    manager.stop();
  }
});

test("an after-work turn whose launch cannot be checked is held back, never delivered and never dropped, until it can", async () => {
  const { queueTaskSkillPromptTurn, getTaskSkillPrompt } = await import("../src/server/db.ts");
  const { AFTER_WORK_SKILLS_TURN_PREFIX } = await import("../src/shared/message-delivery.ts");
  const registry = new Registry();
  const id = "sdk:after-work-unverified";
  registry.registerSdkSession({ id, agent: "claude", name: "unverified", cwd: "/repo/unverified", agentSessionId: "conversation:unverified" });
  const taskId = "task-unverified";
  let readable = true;
  let checksWhileUnreadable = 0;
  let handoffs = 0;
  const sent: string[] = [];
  const manager = new PendingTurnManager(registry, {
    ...unexpectedActiveSdkDelivery,
    sendWhenIdle: async (_id, turn, beforeSend) => {
      handoffs += 1;
      // The ownership read starts failing while the driver holds the claimed turn.
      if (handoffs === 1) readable = false;
      if (beforeSend?.()) return null;
      sent.push(turn.text);
      return "started";
    },
  }, {
    idleSettleMs: 0, pickupTimeoutMs: 15, afterWorkEnabled: () => true, afterWorkRecheckMs: 5,
    afterWorkTurnOwed: () => {
      if (readable) return true;
      checksWhileUnreadable += 1;
      throw new Error("database is locked");
    },
  });
  manager.start();
  working(registry, id);
  manager.submitDaemonTurn(id, (noteKey, now) => queueTaskSkillPromptTurn({
    taskId, sessionId: id, noteKey, turnId: `${AFTER_WORK_SKILLS_TURN_PREFIX}${taskId}:${id}:1`,
    text: "/wrap-notes\n\nThe work is complete.", skills: ["wrap-notes"], from: null, now,
  }));
  idle(registry, id);
  // Refused at the acceptance guard, then checked again on the drain's recheck timer, never claimed.
  await until(() => checksWhileUnreadable >= 3, "the drain to recheck the unreadable launch");
  assert.deepEqual(sent, [], "an unreadable ownership check never delivers the turn");
  assert.equal(handoffs, 1, "and the turn is not claimed again while it cannot be checked");
  assert.equal(registry.getSession(id)?.pendingTurns.length, 1, "it stays queued: nothing was dropped");
  assert.equal(getTaskSkillPrompt(taskId, id)?.state, "queued", "and its prompt row is not settled");
  // The read recovers: the turn is delivered, once.
  readable = true;
  await until(() => sent.length === 1, "the held-back turn to be delivered");
  await tick(20);
  assert.equal(sent.length, 1);
  manager.stop();
});

test("an ownership read that fails only at the delivery guard still gets the turn rechecked and delivered on a quiet session", async () => {
  const { queueTaskSkillPromptTurn } = await import("../src/server/db.ts");
  const { AFTER_WORK_SKILLS_TURN_PREFIX } = await import("../src/shared/message-delivery.ts");
  const queue = (manager: InstanceType<typeof PendingTurnManager>, id: string, taskId: string) => manager.submitDaemonTurn(id, (noteKey, now) => queueTaskSkillPromptTurn({
    taskId, sessionId: id, noteKey, turnId: `${AFTER_WORK_SKILLS_TURN_PREFIX}${taskId}:${id}:1`,
    text: "/wrap-notes\n\nThe work is complete.", skills: ["wrap-notes"], from: null, now,
  }));
  // Reads: 1 at the drain (owed), 2 at the guard (throws), 3 after the release (owed again).
  // Nothing else happens to the session, so only the drain's own recheck can deliver it.
  const intermittent = () => {
    let reads = 0;
    return () => {
      reads += 1;
      if (reads === 2) throw new Error("database is locked");
      return true;
    };
  };

  // SDK: the acceptance guard.
  {
    const registry = new Registry();
    const id = "sdk:after-work-intermittent";
    registry.registerSdkSession({ id, agent: "claude", name: "intermittent", cwd: "/repo/intermittent", agentSessionId: "conversation:intermittent" });
    let handoffs = 0;
    const sent: string[] = [];
    const manager = new PendingTurnManager(registry, {
      ...unexpectedActiveSdkDelivery,
      sendWhenIdle: async (_id, turn, beforeSend) => {
        handoffs += 1;
        if (beforeSend?.()) return null;
        sent.push(turn.text);
        return "started";
      },
    }, { idleSettleMs: 0, pickupTimeoutMs: 15, afterWorkEnabled: () => true, afterWorkRecheckMs: 5, afterWorkTurnOwed: intermittent() });
    manager.start();
    working(registry, id);
    queue(manager, id, "task-intermittent-sdk");
    idle(registry, id);
    await until(() => sent.length === 1, "the turn the guard held back to be rechecked and delivered");
    assert.equal(handoffs, 2, "refused once at the guard, then delivered by the recheck");
    await tick(20);
    assert.equal(sent.length, 1);
    manager.stop();
  }

  // Terminal: the paste guard.
  {
    const name = "after-work-intermittent-pane";
    const registry = new Registry();
    registry.applyDiscovery([discovered(name)]);
    let handoffs = 0;
    const pasted: string[] = [];
    const manager = new PendingTurnManager(
      registry,
      { ...unexpectedActiveSdkDelivery, sendWhenIdle: async () => "started" },
      {
        idleSettleMs: 0,
        pickupTimeoutMs: 15,
        afterWorkEnabled: () => true,
        afterWorkRecheckMs: 5,
        afterWorkTurnOwed: intermittent(),
        inject: async (_session, text, _deps, beforeWrite) => {
          handoffs += 1;
          const blocker = beforeWrite?.() ?? null;
          if (blocker) return { ok: false, error: blocker, pasted: false, submitVerified: false };
          pasted.push(text);
          return { ok: true, pasted: true, submitVerified: true };
        },
      },
    );
    manager.start();
    const id = `terminal:${name}`;
    working(registry, id);
    queue(manager, id, "task-intermittent-pane");
    stopHook(registry, name);
    await until(() => pasted.length === 1, "the pane's held-back turn to be rechecked and pasted");
    assert.equal(handoffs, 2, "refused once at the paste guard, then pasted by the recheck");
    manager.stop();
  }
});

test("the outbox records an after-work prompt delivered when it retires the turn, with no listener involved", async () => {
  const { queueTaskSkillPromptTurn, getTaskSkillPrompt } = await import("../src/server/db.ts");
  const { AFTER_WORK_SKILLS_TURN_PREFIX } = await import("../src/shared/message-delivery.ts");
  const registry = new Registry();
  const id = "sdk:after-work-retired";
  registry.registerSdkSession({ id, agent: "claude", name: "retired", cwd: "/repo/retired", agentSessionId: "conversation:retired" });
  const taskId = "task-retired";
  const sent: string[] = [];
  // No after-work prompter is wired here: only the outbox's own retire can settle the row.
  const manager = new PendingTurnManager(registry, {
    ...unexpectedActiveSdkDelivery,
    sendWhenIdle: async (_id, turn, beforeSend) => {
      if (beforeSend?.()) return null;
      sent.push(turn.text);
      return "started";
    },
  }, { idleSettleMs: 0, pickupTimeoutMs: 15, afterWorkEnabled: () => true, afterWorkTurnOwed: () => true });
  manager.start();
  working(registry, id);
  manager.submitDaemonTurn(id, (noteKey, now) => queueTaskSkillPromptTurn({
    taskId, sessionId: id, noteKey, turnId: `${AFTER_WORK_SKILLS_TURN_PREFIX}${taskId}:${id}:1`,
    text: "/wrap-notes\n\nThe work is complete.", skills: ["wrap-notes"], from: null, now,
  }));
  idle(registry, id);
  await until(() => sent.length === 1, "the after-work turn to be delivered");
  assert.equal(getTaskSkillPrompt(taskId, id)?.state, "delivered");
  assert.ok(getTaskSkillPrompt(taskId, id)?.deliveredAt);
  manager.stop();
});

test("a delivered turn whose retire fails is retired again, and its after-work row settled, without sending it again", async () => {
  const db = await import("../src/server/db.ts");
  const { AFTER_WORK_SKILLS_TURN_PREFIX } = await import("../src/shared/message-delivery.ts");
  const registry = new Registry();
  const id = "sdk:after-work-retire-retry";
  registry.registerSdkSession({ id, agent: "claude", name: "retire-retry", cwd: "/repo/retire-retry", agentSessionId: "conversation:retire-retry" });
  const taskId = "task-retire-retry";
  const sent: string[] = [];
  let retires = 0;
  const manager = new PendingTurnManager(registry, {
    ...unexpectedActiveSdkDelivery,
    sendWhenIdle: async (_id, turn, beforeSend) => {
      if (beforeSend?.()) return null;
      sent.push(turn.text);
      return "started";
    },
  }, {
    idleSettleMs: 0, pickupTimeoutMs: 15, afterWorkEnabled: () => true, afterWorkTurnOwed: () => true,
    retireDelivered: (turnId, revision, at) => {
      retires += 1;
      if (retires === 1) throw new Error("disk I/O error");
      return db.retireDeliveredPendingTurnKey(turnId, revision, at);
    },
  });
  manager.start();
  working(registry, id);
  manager.submitDaemonTurn(id, (noteKey, now) => db.queueTaskSkillPromptTurn({
    taskId, sessionId: id, noteKey, turnId: `${AFTER_WORK_SKILLS_TURN_PREFIX}${taskId}:${id}:1`,
    text: "/wrap-notes\n\nThe work is complete.", skills: ["wrap-notes"], from: null, now,
  }));
  idle(registry, id);
  await until(() => sent.length === 1, "the after-work turn to be delivered");
  assert.equal(retires, 1);
  assert.equal(db.getTaskSkillPrompt(taskId, id)?.state, "queued", "the failed retire changed nothing yet");
  await until(() => retires === 2, "the retire to be tried again", 3_000);
  assert.equal(db.getTaskSkillPrompt(taskId, id)?.state, "delivered");
  assert.deepEqual(registry.getSession(id)?.pendingTurns, []);
  await tick(20);
  assert.equal(sent.length, 1, "the prompt is never sent twice");
  manager.stop();
});

test("marking an uncertain after-work turn sent settles its prompt row delivered in the same transaction", async () => {
  const db = await import("../src/server/db.ts");
  const { AFTER_WORK_SKILLS_TURN_PREFIX } = await import("../src/shared/message-delivery.ts");
  const d = db.openDb();
  const taskId = "task-uncertain-sent";
  const turnId = `${AFTER_WORK_SKILLS_TURN_PREFIX}${taskId}:s-uncertain:1`;
  db.queueTaskSkillPromptTurn({ taskId, sessionId: "s-uncertain", noteKey: "note:s-uncertain", turnId, text: "/wrap-notes", skills: ["wrap-notes"], from: null, now: 1 });
  // The daemon stopped after the agent took the turn and before its retire committed.
  d.prepare(`UPDATE pending_turns SET state = 'sending', claimed_at = 2 WHERE id = ?`).run(turnId);
  db.recoverSendingPendingTurns(3);
  const row = d.prepare(`SELECT state, revision FROM pending_turns WHERE id = ?`).get(turnId) as { state: string; revision: number };
  assert.equal(row.state, "uncertain", "never resent on its own");
  assert.equal(db.getTaskSkillPrompt(taskId, "s-uncertain")?.state, "queued");
  assert.equal(db.resolveUncertainPendingTurn(turnId, row.revision, 40), true);
  assert.equal(db.getTaskSkillPrompt(taskId, "s-uncertain")?.state, "delivered");
  assert.equal(db.getTaskSkillPrompt(taskId, "s-uncertain")?.deliveredAt, 40);
});
