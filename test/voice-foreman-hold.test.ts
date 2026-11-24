import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Registry } from "../src/server/registry.ts";
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

test("settling an uncertain spoken handoff after restart holds only its original receiving cycle", () => {
  for (const finished of [false, true]) {
    const key = "uncertain-spoken-" + finished;
    const row = db.createPendingTurn({ id: key, noteKey: key, text: "inspect", spokenWords: "inspect", now: 1 });
    const claim = db.claimNextPendingTurn(key, 2, row, words => words)!;
    assert.ok(db.recordSpokenHandoff(row.id, claim.revision, 0, 2));
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

test("marking an unstamped spoken attempt sent leaves idle and unrelated working cycles alone", () => {
  for (const working of [false, true]) {
    const key = "unstamped-" + working;
    const row = db.createPendingTurn({ id: key, noteKey: key, text: "inspect", spokenWords: "inspect", now: 1 });
    assert.ok(db.claimNextPendingTurn(key, 2, row, words => words));
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
  const reservation = db.recordSpokenHandoff(row.id, claim.revision, 0, 2);
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
  const reservation = db.recordSpokenHandoff(row.id, claim.revision, 0, 4);
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
