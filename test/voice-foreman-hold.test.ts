import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Registry } from "../src/server/registry.ts";
import { reserveSpokenHandoff, spokenLedger } from "../src/server/delivery-ledgers.ts";
import { PendingTurnManager } from "../src/server/pending-turns.ts";
import { QueueManager } from "../src/server/queue.ts";
import { ReviewManager } from "../src/server/reviews.ts";
import { buildApp } from "../src/server/routes.ts";
import { unexpectedActiveSdkDelivery } from "./helpers/pending-turn-sender.ts";
import { TaskManager } from "./helpers/task-manager-fixture.ts";
import * as db from "../src/server/db.ts";
import { applyFeatureFlagIntent } from "../src/server/feature-flags/index.ts";
import { VOICE_TURN_PREFIX } from "../src/shared/voice-delivery.ts";

test("undelivered spoken rows hold Foreman without expiry through restart, failed claims and uncertainty", t => {
  applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: true });
  const id = "sdk:hold";
  const key = "hold-conversation";
  const boot = () => {
    const registry = new Registry();
    registry.registerSdkSession({ id, agent: "claude", name: "Hold", cwd: "/tmp", agentSessionId: key });
    registry.refreshPendingTurns(key);
    return registry;
  };
  const start = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const row = db.createPendingTurn({ id: "opaque-spoken-id", noteKey: key, text: "hello", spokenWords: "hello", now: start });
  let registry = boot();
  assert.equal(registry.voiceHold(id), true);
  t.mock.timers.tick(700_000);
  db.closeDb();
  registry = boot();
  assert.equal(registry.voiceHold(id), true);
  const send = db.claimNextPendingTurn(key, Date.now(), row, words => words + "\nnotes")!;
  const failed = db.releasePendingTurn(send.id, send.revision, "failure", Date.now())!;
  t.mock.timers.tick(700_000);
  registry.refreshPendingTurns(key);
  assert.equal(registry.voiceHold(id), true);
  const retry = db.claimNextPendingTurn(key, Date.now(), failed)!;
  const uncertain = db.markPendingTurnUncertain(retry.id, retry.revision, "unknown", Date.now())!;
  registry.refreshPendingTurns(key);
  assert.equal(registry.voiceHold(id), true);
  const queued = db.retryPendingTurn(row.id, uncertain.revision, Date.now())!;
  assert.ok(db.recallPendingTurn(key, queued.id, queued.revision));
  registry.refreshPendingTurns(key);
  assert.equal(registry.voiceHold(id), false);
});

test("confirmed speech holds Foreman past ten minutes and across restart until its receiving turn finishes", async t => {
  applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: true });
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const id = "sdk:long-running";
  const key = "long-running-conversation";
  const boot = () => {
    const registry = new Registry();
    registry.registerSdkSession({ id, agent: "claude", name: "Long turn", cwd: "/tmp", agentSessionId: key });
    return registry;
  };
  const first = boot();
  const manager = new PendingTurnManager(first, {
    ...unexpectedActiveSdkDelivery,
    sendWhenIdle: async (_, _turn, beforeSend) => {
      assert.equal(beforeSend?.(), null);
      first.applyDriverEvent(id, { kind: "state", state: "working", activity: null });
      return "started";
    },
  }, { idleSettleMs: 0 });
  manager.start();
  t.after(() => manager.stop());
  first.applyDriverEvent(id, { kind: "state", state: "idle", activity: null });
  const confirmed = new Promise<void>(resolve => first.onTurnDelivered(() => resolve()));
  assert.ok(manager.submitSpoken(id, "inspect the build", "long-running").ok);
  const timeout = new AbortController();
  try {
    await Promise.race([confirmed, delay(3_000, undefined, { signal: timeout.signal }).then(() => assert.fail("delivery timed out"))]);
  } finally {
    timeout.abort();
  }
  assert.deepEqual(db.listPendingTurns(key), []);
  t.mock.timers.tick(660_000);
  assert.equal(first.voiceHold(id), true, "an active eleven-minute turn still owns its questions");
  manager.stop();
  db.closeDb();
  const restored = boot();
  assert.equal(restored.voiceHold(id), true, "the hold survives a fresh registry and database connection");
  restored.setForemanInvite(id, "dispatch");
  const reviews = new ReviewManager(restored);
  const app = buildApp({ registry: restored, reviews, tasks: new TaskManager(restored), queues: new QueueManager(restored) });
  const question = reviews.create(id, "input", "Which build?", "Choose one.", null, { snoozable: true });
  const answer = () => app.request(`/api/reviews/${question.id}/resolve`, {
    method: "POST", headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify({ by: "foreman", action: "answer", response: "main" }),
  });
  const refused = await answer();
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error, "voice-message-pending");
  restored.applyDriverEvent(id, { kind: "turn_done", usage: null });
  assert.equal(restored.voiceHold(id), false, "the receiving turn completed");
  assert.equal((await answer()).status, 200);
  db.closeDb();
  assert.equal(boot().voiceHold(id), false, "restart cannot revive a finished turn's hold");
});

test("a spoken retirement retry clears the rekeyed live outbox and releases its next turn", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: true });
  const id = "sdk:retire-then-bind";
  const native = "native-after-failed-retirement";
  const registry = new Registry();
  registry.registerSdkSession({ id, agent: "claude", name: "Binding", cwd: "/tmp" });
  const sent: string[] = [];
  const receipts: string[] = [];
  registry.onTurnDelivered(event => receipts.push(event.turnId));
  const manager = new PendingTurnManager(registry, {
    ...unexpectedActiveSdkDelivery,
    sendWhenIdle: async (_, input, guard) => {
      assert.equal(guard?.(), null);
      sent.push(input.text);
      registry.applyDriverEvent(id, { kind: "state", state: "working", activity: null });
      return "started";
    },
  }, { idleSettleMs: 0, now: () => Date.now() });
  manager.start();
  const d = db.openDb();
  t.after(() => { manager.stop(); d.exec("DROP TRIGGER IF EXISTS refuse_rekeyed_retirement"); });
  d.exec("CREATE TEMP TRIGGER refuse_rekeyed_retirement BEFORE DELETE ON pending_turns BEGIN SELECT RAISE(ABORT, 'injected retire failure'); END");
  registry.applyDriverEvent(id, { kind: "state", state: "idle", activity: null });
  const spoken = manager.submitSpoken(id, "inspect the build", "retry-rekey").pendingTurn!;
  const tick = async (ms: number) => {
    t.mock.timers.tick(ms);
    await new Promise<void>(resolve => setImmediate(resolve));
  };
  await tick(1);
  assert.equal(db.listPendingTurns(id)[0]?.state, "sending");
  registry.applyDriverEvent(id, { kind: "bound", agentSessionId: native, transcriptPath: null, modelId: null, pid: null });
  const next = manager.submit(id, "next message").pendingTurn!;
  assert.deepEqual(registry.getSession(id)!.pendingTurns.map(row => row.noteKey), [native, native]);
  d.exec("DROP TRIGGER refuse_rekeyed_retirement");
  await tick(1_001);
  assert.deepEqual(receipts, [spoken.id]);
  assert.deepEqual(db.listPendingTurns(native).map(row => row.id), [next.id]);
  assert.deepEqual(registry.getSession(id)!.pendingTurns.map(row => row.id), [next.id]);
  assert.equal(registry.voiceHold(id), true);
  registry.applyDriverEvent(id, { kind: "turn_done", usage: null });
  assert.equal(registry.voiceHold(id), false);
  await tick(1);
  assert.deepEqual(receipts, [spoken.id, next.id]);
  assert.equal(sent.length, 2);
  assert.equal(sent[1], "next message");
});

test("a typed row and its delivery leave Foreman available even with a voice-prefixed id", () => {
  applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: true });
  const registry = new Registry();
  const id = "sdk:typed";
  const key = "typed-conversation";
  registry.registerSdkSession({ id, agent: "claude", name: "Typed", cwd: "/tmp", agentSessionId: key });
  const row = db.createPendingTurn({ id: VOICE_TURN_PREFIX + "typed", noteKey: key, text: "hello", now: Date.now() });
  registry.refreshPendingTurns(key);
  assert.equal(registry.voiceHold(id), false);
  const claimed = db.claimNextPendingTurn(key, Date.now(), row)!;
  db.retireDeliveredPendingTurn(row.id, claimed.revision, Date.now());
  registry.refreshPendingTurns(key);
  registry.turnDelivered({ sessionId: id, turnId: row.id, deliveredAt: Date.now() });
  assert.equal(registry.voiceHold(id), false);
});

test("a failed spoken reservation rolls back its outbox stamp before the runtime sees the message", () => {
  const key = "atomic-spoken-reservation";
  const row = db.createPendingTurn({ id: key, noteKey: key, text: "inspect", spokenWords: "inspect", now: 1 });
  const claim = db.claimNextPendingTurn(key, 2, row, words => words)!;
  const reserve = () => reserveSpokenHandoff({ key, transcript: null }, claim, "inspect", true, 0, 3);
  const d = db.openDb();
  d.exec("CREATE TEMP TRIGGER fail_spoken_insert BEFORE INSERT ON session_spoken_turns BEGIN SELECT RAISE(ABORT, 'injected insertion failure'); END");
  try {
    assert.throws(reserve, /injected insertion failure/);
  } finally {
    d.exec("DROP TRIGGER fail_spoken_insert");
  }
  assert.equal(d.prepare("SELECT spoken_reservation_id FROM pending_turns WHERE id = ?").get(key)?.spoken_reservation_id, null);
  assert.deepEqual(spokenLedger.rows(key), []);
  const reserved = reserve();
  assert.ok(reserved);
  assert.equal(reserve(), null, "the same claim cannot receive a second reservation");
  db.closeDb();
  assert.equal(db.loadSpokenTurns(key)[0]?.id, reserved.id);
  assert.equal(db.openDb().prepare("SELECT spoken_reservation_id FROM pending_turns WHERE id = ?").get(key)?.spoken_reservation_id, reserved.id);
});

test("recovering a legacy handoff stamp without its reservation cannot hold Foreman after mark sent", () => {
  for (const alreadyUncertain of [false, true]) {
    const key = "legacy-incomplete-" + alreadyUncertain;
    const row = db.createPendingTurn({ id: key, noteKey: key, text: "inspect", spokenWords: "inspect", now: 1 });
    const claim = db.claimNextPendingTurn(key, 2, row, words => words)!;
    assert.ok(db.recordSpokenHandoff(row.id, claim.revision, 0, 3));
    if (alreadyUncertain) db.markPendingTurnUncertain(row.id, claim.revision, "interrupted", 4);
    db.closeDb();
    db.recoverSendingPendingTurns(5);
    const [uncertain] = db.listPendingTurns(key);
    assert.equal(uncertain?.state, "uncertain");
    assert.ok(db.resolveUncertainPendingTurn(row.id, uncertain.revision, 6));
    assert.equal(db.hasDeliveredSpokenHold(key), false);
    assert.equal(db.workCycleFor(key), null);
  }
});

test("settling an uncertain spoken handoff after restart holds only its original receiving cycle", () => {
  for (const finished of [false, true]) {
    const key = "uncertain-spoken-" + finished;
    const row = db.createPendingTurn({ id: key, noteKey: key, text: "inspect", spokenWords: "inspect", now: 1 });
    const claim = db.claimNextPendingTurn(key, 2, row, words => words)!;
    assert.ok(reserveSpokenHandoff({ key, transcript: null }, claim, "inspect", true, 0, 2));
    db.markWorkCycleActive(key, 3);
    if (finished) {
      db.completeWorkCycle(key, 4, 4);
      db.markWorkCycleActive(key, 5);
    }
    db.closeDb();
    db.recoverSendingPendingTurns(6);
    const [uncertain] = db.listPendingTurns(key);
    assert.equal(uncertain?.state, "uncertain");
    assert.ok(db.resolveUncertainPendingTurn(row.id, uncertain.revision, 7));
    assert.equal(db.hasDeliveredSpokenHold(key), !finished);
    db.completeWorkCycle(key, 8, 8);
    assert.equal(db.hasDeliveredSpokenHold(key), false);
  }
});

test("marking a legacy unstamped spoken attempt sent leaves idle and unrelated working cycles alone", () => {
  for (const working of [false, true]) {
    const key = "unstamped-" + working;
    const row = db.createPendingTurn({ id: key, noteKey: key, text: "inspect", spokenWords: "inspect", now: 1 });
    assert.ok(db.claimNextPendingTurn(key, 2, row, words => words));
    db.openDb().prepare("UPDATE pending_turns SET spoken_requires_guard = NULL WHERE id = ?").run(row.id);
    db.closeDb();
    db.recoverSendingPendingTurns(3);
    if (working) db.markWorkCycleActive(key, 4);
    const before = db.workCycleFor(key);
    const [uncertain] = db.listPendingTurns(key);
    assert.ok(db.resolveUncertainPendingTurn(row.id, uncertain!.revision, 5));
    assert.equal(db.hasDeliveredSpokenHold(key), false);
    assert.deepEqual(db.workCycleFor(key), before);
  }
});

test("a confirmed spoken hold follows the first native binding and stays with that conversation on clear", () => {
  applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: true });
  const registry = new Registry();
  const id = "sdk:before-native-bind";
  const native = "native-spoken-conversation";
  registry.registerSdkSession({ id, agent: "claude", name: "First bind", cwd: "/tmp" });
  const row = db.createPendingTurn({ id: "first-bind", noteKey: id, text: "inspect", spokenWords: "inspect", now: 1 });
  const claim = db.claimNextPendingTurn(id, 2, row, words => words)!;
  const reservation = reserveSpokenHandoff({ key: id, transcript: null }, claim, "inspect", true, 0, 2)?.id;
  assert.ok(reservation);
  assert.ok(db.retireDeliveredPendingTurn(row.id, claim.revision, 3, reservation));
  assert.equal(registry.voiceHold(id), true);
  registry.applyDriverEvent(id, { kind: "bound", agentSessionId: native, transcriptPath: null, modelId: null, pid: null });
  assert.equal(registry.voiceHold(id), true);
  registry.applyDriverEvent(id, { kind: "bound", agentSessionId: "new-conversation", transcriptPath: null, modelId: null, pid: null, cleared: true });
  assert.equal(registry.voiceHold(id), false);
  assert.equal(db.hasDeliveredSpokenHold(native), true);
  registry.applyDriverEvent(id, { kind: "turn_done", usage: null }, { workCycleKey: native });
  assert.equal(db.hasDeliveredSpokenHold(native), false);
});

test("a late confirmation uses the native receiving cycle even if the outbox has since moved", () => {
  const provisional = "sdk:pending-first-bind";
  const native = "native-pending-first-bind";
  const next = "next-conversation";
  db.markWorkCycleActive(native, 1);
  db.completeWorkCycle(native, 2, 2);
  const row = db.createPendingTurn({ id: "in-flight-bind", noteKey: provisional, text: "inspect", spokenWords: "inspect", now: 3 });
  const claim = db.claimNextPendingTurn(provisional, 4, row, words => words)!;
  const reservation = reserveSpokenHandoff({ key: provisional, transcript: null }, claim, "inspect", true, 0, 4)?.id;
  assert.ok(reservation);
  db.workCycleForBoundSession(provisional, native);
  assert.ok(db.rekeyPendingTurns(provisional, native, 5));
  assert.ok(db.rekeyPendingTurns(native, next, 6));
  db.closeDb();
  assert.ok(db.retireDeliveredPendingTurn(row.id, claim.revision, 7, reservation));
  assert.equal(db.hasDeliveredSpokenHold(native), true);
  assert.equal(db.hasDeliveredSpokenHold(next), false);
  db.completeWorkCycle(native, 8, 8);
  assert.equal(db.hasDeliveredSpokenHold(native), false);
});
