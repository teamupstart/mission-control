import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as db from "../src/server/db.ts";
import { VOICE_TURN_PREFIX, openQuestionsNote, spokenMessageText } from "../src/shared/voice-delivery.ts";
import { claimHumanEcho, expectHumanEcho } from "../src/server/injections.ts";
import type { TurnDelivered } from "../src/server/registry.ts";
import { deliverySchedule } from "../src/shared/message-delivery.ts";
import { fakeTranscript } from "./helpers/fake-transcript.ts";

function claimSpoken(key: string, words: string, text: string) {
  const queued = db.createPendingTurn({ id: key + "-outbox", noteKey: key, spokenWords: words, text: words, now: Date.now() });
  const claimed = db.claimNextPendingTurn(key, Date.now(), queued, () => text)!;
  const reservationId = db.recordSpokenHandoff(claimed.id, claimed.revision, 0);
  assert.ok(reservationId);
  return { ...claimed, reservationId };
}

test("spoken rows wait for idle even with a persisted steer or interrupt override", () => {
  const session = { agent: "codex", runtime: "sdk" } as const;
  const key = "spoken-expedite";
  for (const action of ["steer", "interrupt"] as const) {
    const turn = db.createPendingTurn({ noteKey: key, id: key + action, text: "inspect", spokenWords: "inspect", now: 1 });
    const mode = action === "steer" ? "steer" : "interrupt-after-wait";
    // An earlier daemon could have persisted the override before restart.
    db.openDb().prepare("UPDATE pending_turns SET delivery_mode = ?, deadline_at = 2 WHERE id = ?").run(mode, turn.id);
    const restored = db.listPendingTurns(key).find(row => row.id === turn.id)!;
    assert.deepEqual(deliverySchedule(session, restored), []);
    assert.equal(db.expeditePendingTurn(key, turn.id, turn.revision, action, 3), null);
    assert.equal(db.claimNextPendingTurn(key, 4, turn, words => words)?.spokenWords, "inspect");
    assert.ok(db.retireDeliveredPendingTurn(turn.id, turn.revision + 1, 5));
  }
});

test("upgrade from 51 leaves typed rows untouched, and spoken composition survives restart and retry", () => {
  const key = "conversation";
  const words = "check the build";
  const typed = db.createPendingTurn({ id: "typed", noteKey: key, text: words, now: 1 });
  db.openDb().exec(`
    DROP INDEX idx_pending_spoken_handoff;
    ALTER TABLE pending_turns DROP COLUMN spoken_words;
    ALTER TABLE pending_turns DROP COLUMN composed_at;
    ALTER TABLE pending_turns DROP COLUMN spoken_handoff_key;
    ALTER TABLE pending_turns DROP COLUMN spoken_handoff_generation;
    ALTER TABLE pending_turns DROP COLUMN spoken_handoff_at;
    ALTER TABLE pending_turns DROP COLUMN spoken_reservation_id;
    ALTER TABLE session_work_cycles DROP COLUMN spoken_hold;
    ALTER TABLE session_work_cycles DROP COLUMN spoken_hold_since;
    PRAGMA user_version = 51;
  `);
  db.closeDb();
  assert.deepEqual(db.listPendingTurns(key), [typed]);
  assert.deepEqual({ ...db.openDb().prepare("SELECT spoken_words, composed_at FROM pending_turns WHERE id = ?").get(typed.id) },
    { spoken_words: null, composed_at: null });
  assert.equal(db.claimNextPendingTurn(key, 2, typed, () => assert.fail("typed message composed"))!.text, words);
  db.retireDeliveredPendingTurn(typed.id, 1, 3);
  const queued = db.createPendingTurn({ id: VOICE_TURN_PREFIX + "capture", noteKey: key, spokenWords: words, text: words, now: 4 });
  let asks = [{ id: "old", title: "Old question" }];
  const compose = (text: string) => spokenMessageText(text, { openQuestions: openQuestionsNote(asks), unseenReports: null });
  db.closeDb();
  assert.deepEqual(db.listPendingTurns(key), [queued]);
  asks = [{ id: "new", title: "New question" }];
  const claimed = db.claimNextPendingTurn(key, 5, queued, compose)!;
  assert.equal(claimed.text, compose(words));
  assert.equal(claimed.spokenWords, words);
  db.closeDb();
  const replay = { id: queued.id, noteKey: key, spokenWords: words, text: words, now: 6 };
  assert.deepEqual(db.createPendingTurn(replay), claimed);
  assert.throws(() => db.createPendingTurn({ ...replay, noteKey: "other" }), /different outbox message/);
  assert.throws(() => db.createPendingTurn({ ...replay, spokenWords: "different" }), /different outbox message/);
  const released = db.releasePendingTurn(claimed.id, claimed.revision, "transport refused", 6)!;
  db.closeDb();
  const retry = db.claimNextPendingTurn(key, 7, released, () => assert.fail("retry composed twice"))!;
  assert.equal(retry.text, claimed.text);
  assert.equal(db.openDb().prepare("SELECT composed_at FROM pending_turns WHERE id = ?").get(queued.id)?.composed_at, 5);
  expectHumanEcho("sdk:test", retry.text, { noteKey: key, cycle: undefined, now: 7 });
  assert.equal(claimHumanEcho("sdk:test", key, words, 8).kind, "none");
  assert.equal(claimHumanEcho("sdk:test", key, retry.text, 8).kind, "capture");
  db.closeDb();
});

test("spoken ledger reloads the exact payload and binds its native turn once a competing send is released", async () => {
  const { delegatedLedger, spokenLedger } = await import("../src/server/delivery-ledgers.ts");
  const { forgetDeliveryBindingState } = await import("../src/server/delivery-binding.ts");
  const transcript = fakeTranscript();
  const conversation = transcript.conversation("spoken-binding");
  const spokenWords = "inspect the build";
  const received = spokenMessageText(spokenWords, { openQuestions: null, unseenReports: null });
  const now = Date.now();
  const attempt = claimSpoken(conversation.key, spokenWords, received);
  const reserve = () => spokenLedger.reserve(conversation, received, base => ({
    ...base, spokenWords, received, outboxTurnId: attempt.id, outboxRevision: attempt.revision,
  }), now, attempt.reservationId);
  const refused = reserve();
  spokenLedger.release(conversation.key, refused.id);
  const spoken = reserve();
  const rival = delegatedLedger.reserve(conversation, received, base => ({
    ...base, controllerId: "sdk:controller", controllerName: "Controller",
  }), now);
  forgetDeliveryBindingState();
  db.closeDb();
  assert.deepEqual(spokenLedger.rows(conversation.key), [{ ...spoken, contested: true }]);
  delegatedLedger.release(conversation.key, rival.id);
  assert.ok(db.retireDeliveredPendingTurn(attempt.id, attempt.revision, now, attempt.reservationId));
  const turn = transcript.append("spoken-turn", received, now + 1);
  const duplicate = transcript.append("later-turn", received, now + 2);
  const bound = spokenLedger.bound(conversation, [turn, duplicate]);
  assert.deepEqual([...bound.rows.keys()], [turn.id]);
  forgetDeliveryBindingState();
  db.closeDb();
  assert.deepEqual(spokenLedger.rows(conversation.key), [
    { ...spoken, contested: false, messageId: turn.id, messageTs: turn.ts },
  ]);
});

test("a spoken reservation with no transcript binds its native receipt, even beside identical typed turns", async () => {
  const { reserveSpokenTurn } = await import("../src/server/delivery-ledgers.ts");
  const { forgetDeliveryBindingState } = await import("../src/server/delivery-binding.ts");
  const transcript = fakeTranscript();
  const key = "first-spoken-receipt";
  const spokenWords = "check the build";
  const received = spokenMessageText(spokenWords, { openQuestions: null, unseenReports: null });
  const now = Date.now();
  const earlier = transcript.append("typed-before", received, now);
  const row = reserveSpokenTurn({ key, transcript: null }, spokenWords, received, true, claimSpoken(key, spokenWords, received));
  assert.equal(row.transcriptOffset, null);
  const actual = transcript.append(row.id, received, now);
  const later = transcript.append("typed-after", received, now);
  forgetDeliveryBindingState();
  db.closeDb();
  const { attributeTranscript } = await import("../src/server/transcript-attribution.ts");
  const { applyFeatureFlagIntent } = await import("../src/server/feature-flags/index.ts");
  applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: true });
  const presentations = attributeTranscript("sdk:test", [earlier, actual, later], null, undefined, transcript.conversation(key))
    .map(message => message.presentation);
  assert.deepEqual(presentations, [undefined, { kind: "spoken", displayText: spokenWords, received }, undefined]);
  assert.equal(db.loadSpokenTurns(key)[0]?.messageId, actual.id);
});

test("a separate Codex client receipt follows the first native conversation key, including across restart", async () => {
  const { reserveSpokenTurn, followSpokenConversationKey, spokenLedger } = await import("../src/server/delivery-ledgers.ts");
  const { parseCodexMessages } = await import("../src/server/harness/codex/transcript.ts");
  const synthetic = "sdk:cold-codex";
  const key = "codex-native";
  const received = "check the build\n\nWhen you have finished this, post a report.";
  const row = reserveSpokenTurn({ key: synthetic, transcript: null }, "check the build", received, true,
    claimSpoken(synthetic, "check the build", received));
  const messages = parseCodexMessages([{
    type: "event_msg", timestamp: new Date().toISOString(),
    payload: { type: "item_completed", item: { type: "UserMessage", id: "item-1", client_id: row.id, content: [{ text: received }] } },
  }]);
  followSpokenConversationKey(synthetic, synthetic, key);
  followSpokenConversationKey(synthetic, key, "different-conversation");
  spokenLedger.forgetCaches();
  db.closeDb();
  assert.equal(messages[0]?.id, "item-1");
  assert.equal(spokenLedger.bound({ key, transcript: null }, messages).rows.get("item-1")?.id, row.id);
  assert.deepEqual(spokenLedger.rows("different-conversation"), []);
});

test("a terminal transcript created after reservation supplies a boundary; an older file with identical text does not", async t => {
  const { spokenLedger } = await import("../src/server/delivery-ledgers.ts");
  const dir = mkdtempSync(join(tmpdir(), "voice-late-transcript-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "native.jsonl");
  writeFileSync(path, "");
  const created = statSync(path).birthtimeMs;
  const text = "check the build";
  const transcript = fakeTranscript();
  const native = transcript.append("first-native", text, Math.ceil(created) + 5);
  const repeat = transcript.append("typed-repeat", text, native.ts + 1);
  for (const [key, reservedAt, expected] of [
    ["before-file", Math.floor(created) - 1, [native.id]], ["same-time", Math.floor(created), []],
    ["after-file", Math.ceil(created) + 1, []],
  ] as const) {
    const attempt = claimSpoken(key, text, text);
    spokenLedger.reserve({ key, transcript: null }, text, base => ({
      ...base, spokenWords: text, received: text, outboxTurnId: attempt.id, outboxRevision: attempt.revision,
    }), reservedAt, attempt.reservationId);
    assert.ok(db.retireDeliveredPendingTurn(attempt.id, attempt.revision, native.ts, attempt.reservationId));
    const located = { key, transcript: { read: transcript.conversation(key).transcript!.read, path } };
    assert.deepEqual([...spokenLedger.bound(located, [native, repeat]).rows.keys()], expected);
  }
});

for (const handedOff of [false, true]) {
  test(handedOff
    ? "restart after the handoff guard preserves the spoken occurrence after the outbox retires"
    : "restart before the handoff guard and discard leave an identical typed occurrence undecorated", async t => {
    const { Registry } = await import("../src/server/registry.ts");
    const { PendingTurnManager } = await import("../src/server/pending-turns.ts");
    const { sessionMessages } = await import("../src/server/harness/index.ts");
    const { forgetDeliveryBindingState } = await import("../src/server/delivery-binding.ts");
    const { spokenLedger } = await import("../src/server/delivery-ledgers.ts");
    const { applyFeatureFlagIntent } = await import("../src/server/feature-flags/index.ts");
    const { unexpectedActiveSdkDelivery } = await import("./helpers/pending-turn-sender.ts");
    applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: true });
    const cwd = mkdtempSync(join(tmpdir(), "voice-handoff-"));
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    const key = `handoff-${handedOff}`;
    const id = `sdk:${key}`;
    const path = join(cwd, "native.jsonl");
    writeFileSync(path, "");
    const registry = new Registry();
    registry.registerSdkSession({ id, agent: "claude", name: key, cwd, agentSessionId: key });
    registry.applyDriverEvent(id, { kind: "bound", agentSessionId: key, transcriptPath: path, modelId: null, pid: null });
    registry.applyDriverEvent(id, { kind: "state", state: "idle", activity: null });
    const transcript = sessionMessages(registry.getSession(id)!)!;
    assert.equal(transcript.read.size(path), 0);
    let payload: string | undefined;
    let receiptId: string | undefined;
    const manager = new PendingTurnManager(registry, {
      ...unexpectedActiveSdkDelivery,
      sendWhenIdle: async (_, input, beforeSend) => {
        if (handedOff) assert.equal(beforeSend?.(), null);
        payload = input.text;
        receiptId = input.clientMessageId;
        return new Promise<never>(() => {}); // The old process never observes a response.
      },
    }, { idleSettleMs: 0 });
    manager.start();
    t.after(() => manager.stop());
    const queued = manager.submitSpoken(id, "check the build", key).pendingTurn!;
    await t.waitFor(() => assert.ok(payload));
    manager.stop();
    forgetDeliveryBindingState();
    db.closeDb();
    db.recoverSendingPendingTurns(Date.now());
    const [uncertain] = db.listPendingTurns(key);
    assert.equal(uncertain?.state, "uncertain");
    if (handedOff) {
      assert.ok(db.resolveUncertainPendingTurn(queued.id, uncertain.revision));
      const [reservation] = db.loadSpokenTurns(key);
      assert.equal(reservation?.outboxTurnId, queued.id);
      assert.equal(reservation.outboxRevision, uncertain.revision - 1);
    } else {
      const editable = db.retryPendingTurn(queued.id, uncertain.revision, Date.now())!;
      assert.ok(db.recallPendingTurn(key, queued.id, editable.revision));
    }
    if (handedOff) assert.ok(receiptId, "SDK handoff supplies a native receipt even with a known transcript offset");
    for (const uuid of [receiptId ?? "first", "repeat"]) {
      appendFileSync(path, JSON.stringify({ type: "user", uuid, timestamp: new Date().toISOString(),
        message: { role: "user", content: payload } }) + "\n");
    }
    const { messages } = transcript.read.after(path, 0);
    assert.equal(messages.length, 2);
    const bound = spokenLedger.bound({ key, transcript }, messages);
    assert.deepEqual([...bound.rows.keys()], handedOff ? [receiptId] : []);
  });
}

test("settled text-only attempts cannot claim later typed messages across retries, discard, or mark sent", async () => {
  const { reserveSpokenTurn, spokenLedger } = await import("../src/server/delivery-ledgers.ts");
  const words = "check the build";
  for (const action of ["retry", "discard", "mark-sent", "confirmed"] as const) {
    const key = "text-receipt-" + action;
    const transcript = fakeTranscript();
    const conversation = transcript.conversation(key);
    const attempt = claimSpoken(key, words, words);
    const reservation = reserveSpokenTurn(conversation, words, words, false, attempt);
    if (action === "confirmed") {
      assert.ok(db.retireDeliveredPendingTurn(attempt.id, attempt.revision, Date.now(), attempt.reservationId));
    } else {
      db.recoverSendingPendingTurns(Date.now());
      const [uncertain] = db.listPendingTurns(key);
      assert.equal(uncertain?.state, "uncertain");
      if (action === "mark-sent") assert.ok(db.resolveUncertainPendingTurn(attempt.id, uncertain.revision));
      else if (action === "discard") assert.equal(db.clearPendingTurns(key).count, 1);
      else {
        const queued = db.retryPendingTurn(attempt.id, uncertain.revision, Date.now())!;
        const retried = db.claimNextPendingTurn(key, Date.now(), queued)!;
        assert.ok(db.recordSpokenHandoff(retried.id, retried.revision, 0));
      }
    }
    const message = transcript.append(action, words, Date.now());
    const stored = db.openDb().prepare("SELECT received FROM session_spoken_turns WHERE id = ?").get(reservation.id);
    assert.equal(stored?.received, action === "confirmed" ? words : undefined, action + " payload retention");
    for (const reload of [false, true]) {
      if (reload) { db.closeDb(); spokenLedger.forgetCaches(); }
      assert.equal(spokenLedger.bound(conversation, [message]).rows.has(message.id), action === "confirmed", action);
    }
  }
});

test("immediate retry after discarding a warm text-only reservation discloses only the confirmed spoken turn", async () => {
  const { noteOtherSend, reserveSpokenTurn, spokenLedger } = await import("../src/server/delivery-ledgers.ts");
  const words = "inspect the build";
  for (const action of ["retry", "discard"] as const) {
    const key = "warm-reservation-" + action;
    const transcript = fakeTranscript();
    const conversation = transcript.conversation(key);
    const original = claimSpoken(key, words, words);
    reserveSpokenTurn(conversation, words, words, false, original);
    assert.throws(() => db.inTransaction(() => {
      db.clearPendingTurns(key);
      throw new Error("roll back discard");
    }), /roll back discard/);
    assert.deepEqual(spokenLedger.rows(key).map(row => row.id), [original.reservationId]);
    const uncertain = db.markPendingTurnUncertain(original.id, original.revision, "handoff unknown", Date.now())!;
    noteOtherSend(conversation, words);
    const typed = transcript.append("typed", words, Date.now());
    if (action === "retry") db.retryPendingTurn(original.id, uncertain.revision, Date.now());
    else db.clearPendingTurns(key);
    const replay = claimSpoken(key, words, words);
    const reserved = reserveSpokenTurn(conversation, words, words, false, replay);
    assert.equal(reserved.contested, false);
    const spoken = transcript.append("confirmed-spoken", words, Date.now());
    assert.ok(db.retireDeliveredPendingTurn(replay.id, replay.revision, Date.now(), replay.reservationId));
    assert.deepEqual([...spokenLedger.bound(conversation, [typed, spoken]).rows.keys()], [spoken.id]);
  }
});

test("abandoning an uncertain native-ID attempt preserves its exact-match disclosure", async () => {
  const { reserveSpokenTurn, spokenLedger } = await import("../src/server/delivery-ledgers.ts");
  const key = "retain-native-attempt";
  const words = "check the build";
  const attempt = claimSpoken(key, words, words);
  const transcript = fakeTranscript();
  const conversation = transcript.conversation(key);
  const reservation = reserveSpokenTurn(conversation, words, words, true, attempt);
  db.recoverSendingPendingTurns(Date.now());
  assert.equal(db.clearPendingTurns(key).count, 1);
  db.closeDb();
  spokenLedger.forgetCaches();
  const actual = transcript.append(reservation.id, words, Date.now());
  assert.equal(spokenLedger.bound(conversation, [actual]).rows.get(actual.id)?.received, words);
});

test("abandoned SDK reservations expire after reconciliation and only exact transcript receipts survive", async () => {
  const { pruneAbandonedSpokenTurns, reserveSpokenTurn, spokenLedger } = await import("../src/server/delivery-ledgers.ts");
  const { DELIVERY_LAG_MS } = await import("../src/server/delivery-binding.ts");
  const transcript = fakeTranscript();
  const words = "inspect the build";
  const received = spokenMessageText(words, { openQuestions: null, unseenReports: null });
  const now = Date.now();
  const cases = ["discarded", "retry", "legacy-orphan", "previously-read", "unread", "confirmed", "uncertain"];
  for (const kind of cases) {
    const key = "sdk-expiry-" + kind;
    const attempt = claimSpoken(key, words, received);
    const conversation = transcript.conversation(key);
    const row = reserveSpokenTurn(conversation, words, received, true, attempt, now);
    if (kind === "legacy-orphan") db.openDb().prepare("DELETE FROM pending_turns WHERE id = ?").run(attempt.id);
    else if (kind === "confirmed") assert.ok(db.retireDeliveredPendingTurn(attempt.id, attempt.revision, now, row.id));
    else {
      const uncertain = db.markPendingTurnUncertain(attempt.id, attempt.revision, "interrupted", now)!;
      if (kind === "retry") assert.ok(db.retryPendingTurn(attempt.id, uncertain.revision, now));
      else if (kind !== "uncertain") db.clearPendingTurns(key);
    }
    if (kind === "previously-read" || kind === "unread") {
      const message = transcript.append("native-" + kind, received, now);
      message.clientMessageId = row.id;
      if (kind === "previously-read") assert.equal(spokenLedger.bound(conversation, [message]).rows.get(message.id)?.id, row.id);
    } else {
      transcript.append("typed-" + kind, received, now);
    }
  }
  db.recoverSendingPendingTurns(now);
  const later = now + DELIVERY_LAG_MS;
  assert.equal(pruneAbandonedSpokenTurns(later - 1, () => null), 0);
  db.closeDb();
  spokenLedger.forgetCaches();
  db.recoverSendingPendingTurns(later);
  for (const kind of cases) assert.equal(spokenLedger.rows("sdk-expiry-" + kind).length, 1);
  assert.equal(pruneAbandonedSpokenTurns(later + 60_000, key =>
    key.endsWith("-previously-read") ? null : transcript.conversation(key).transcript), 3);
  for (const kind of cases) {
    const key = "sdk-expiry-" + kind;
    const retained = ["previously-read", "unread", "confirmed", "uncertain"].includes(kind);
    assert.equal(spokenLedger.rows(key).length, Number(retained), kind);
    assert.equal(db.loadSpokenTurns(key)[0]?.received, retained ? received : undefined, kind);
  }
  const sameTimestamp = transcript.append("typed-after-native", received, now);
  const conversation = transcript.conversation("sdk-expiry-previously-read");
  assert.equal(spokenLedger.bound(conversation, [sameTimestamp]).rows.has(sameTimestamp.id), false);
});

test("cleanup retains spoken payloads through missing, unreadable and incomplete transcripts until a verified scan", async () => {
  const { pruneAbandonedSpokenTurns, reserveSpokenTurn, spokenLedger } = await import("../src/server/delivery-ledgers.ts");
  const { DELIVERY_LAG_MS } = await import("../src/server/delivery-binding.ts");
  const key = "unreadable-sdk";
  const words = "inspect the build";
  const transcript = fakeTranscript();
  const conversation = transcript.conversation(key);
  const attempt = claimSpoken(key, words, words);
  const row = reserveSpokenTurn(conversation, words, words, true, attempt);
  db.recoverSendingPendingTurns(Date.now());
  db.clearPendingTurns(key);
  const now = Date.now() + DELIVERY_LAG_MS + 1;
  const message = transcript.append(row.id, words, now - 1000);
  const read = conversation.transcript!.read;
  for (const unavailable of [null, { ...read, after: () => { throw new Error("disconnected"); } },
    { ...read, after: () => ({ messages: [], start: 0, end: 0, atEnd: true }) }]) {
    pruneAbandonedSpokenTurns(now, k => k === key && unavailable ? { path: "fake", read: unavailable } : null);
    assert.equal(db.loadSpokenTurns(key)[0]?.received, words);
  }
  pruneAbandonedSpokenTurns(now, k => k === key ? conversation.transcript : null);
  assert.equal(db.loadSpokenTurns(key)[0]?.messageTs, message.ts);
  assert.equal(spokenLedger.bound(conversation, [message]).rows.get(message.id)?.received, words);
});

test("cleanup distinguishes a verified empty transcript from a failed read at byte zero", async t => {
  const { reserveSpokenTurn, pruneAbandonedSpokenTurns } = await import("../src/server/delivery-ledgers.ts");
  const { claudeTranscript } = await import("../src/server/harness/claude/transcript.ts");
  const { DELIVERY_LAG_MS } = await import("../src/server/delivery-binding.ts");
  const dir = mkdtempSync(join(tmpdir(), "zero-byte-spoken-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "rollout.jsonl");
  const key = "zero-byte-failure";
  const words = "inspect the build";
  const row = reserveSpokenTurn({ key, transcript: null }, words, words, true, claimSpoken(key, words, words));
  db.recoverSendingPendingTurns(Date.now());
  db.clearPendingTurns(key);
  const now = Date.now() + DELIVERY_LAG_MS + 10;
  const read = { ...claudeTranscript.messages!, size: () => 0 };
  const lookup = (k: string) => k === key ? { path, read } : null;
  // The size probes report zero while the actual native reader cannot open the path.
  assert.equal(pruneAbandonedSpokenTurns(now, lookup), 0);
  assert.equal(db.loadSpokenTurns(key)[0]?.id, row.id);
  writeFileSync(path, "");
  assert.equal(pruneAbandonedSpokenTurns(now, lookup), 1);
  assert.equal(db.loadSpokenTurns(key).length, 0);
});

test("cleanup finds an evicted SDK conversation by its persisted binding and verifies an unread receipt", async t => {
  const { Registry } = await import("../src/server/registry.ts");
  const { upsertSdkSession } = await import("../src/server/sdk/store.ts");
  const { claudeTranscript, resolveTranscriptPath } = await import("../src/server/harness/claude/transcript.ts");
  const { reserveSpokenTurn } = await import("../src/server/delivery-ledgers.ts");
  const { DELIVERY_LAG_MS } = await import("../src/server/delivery-binding.ts");
  const projects = mkdtempSync(join(tmpdir(), "spoken-archived-"));
  t.after(() => rmSync(projects, { recursive: true, force: true }));
  const key = "evicted-native";
  const cwd = "/archived";
  const folder = join(projects, "-archived");
  mkdirSync(folder);
  const words = "inspect the build";
  const now = Date.now();
  const attempt = claimSpoken(key, words, words);
  const row = reserveSpokenTurn({ key, transcript: null }, words, words, true, attempt);
  db.recoverSendingPendingTurns(now);
  db.clearPendingTurns(key);
  upsertSdkSession({ id: "sdk:archived", agentSessionId: key, agent: "claude", cwd, taskId: null,
    model: null, effort: null, permissionMode: null, status: "exited", turnInProgress: false });
  const timestamp = new Date(now).toISOString();
  writeFileSync(join(folder, key + ".jsonl"), JSON.stringify({ type: "user", uuid: row.id, timestamp,
    message: { role: "user", content: words } }) + "\n");
  t.mock.method(claudeTranscript, "locate", (s: Parameters<typeof resolveTranscriptPath>[0]) => resolveTranscriptPath(s, projects));
  db.closeDb();
  const registry = new Registry();
  registry.applyDiscovery([]);
  assert.equal(registry.getSession("sdk:archived"), undefined);
  registry.pruneAbandonedSpokenTurns(now + DELIVERY_LAG_MS + 60_000);
  assert.equal(db.loadSpokenTurns(key)[0]?.messageTs, now);
});

test("startup removes an older orphan payload while retaining the still-uncertain handoff", async () => {
  const { reserveSpokenTurn } = await import("../src/server/delivery-ledgers.ts");
  const words = "inspect";
  for (const key of ["orphan-at-boot", "live-at-boot"]) {
    const attempt = claimSpoken(key, words, words);
    reserveSpokenTurn({ key, transcript: null }, words, words, false, attempt);
    if (key === "orphan-at-boot") db.openDb().prepare("DELETE FROM pending_turns WHERE id = ?").run(attempt.id);
  }
  db.closeDb();
  db.recoverSendingPendingTurns(Date.now());
  const stored = db.openDb().prepare("SELECT received FROM session_spoken_turns WHERE note_key = ?");
  assert.equal(stored.get("orphan-at-boot"), undefined);
  assert.equal(stored.get("live-at-boot")?.received, words);
});

test("upgrade preserves anchored legacy disclosures and leaves unproven legacy reservations unbound", async () => {
  const { spokenLedger } = await import("../src/server/delivery-ledgers.ts");
  const { injectionFingerprint } = await import("../src/server/injections.ts");
  const key = "legacy-attempt";
  const text = "check the build";
  const now = Date.now();
  db.openDb().exec(`ALTER TABLE session_spoken_turns DROP COLUMN outbox_turn_id;
    ALTER TABLE session_spoken_turns DROP COLUMN outbox_revision;`);
  const insert = db.openDb().prepare(`INSERT INTO session_spoken_turns
    (id, note_key, fingerprint, spoken_words, received, delivered_at, transcript_offset, message_id)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?)`);
  for (const nativeId of ["anchored", null]) {
    insert.run(nativeId ?? "orphan", key, injectionFingerprint(text), text, text, now, nativeId);
  }
  db.closeDb();
  const transcript = fakeTranscript();
  const typed = transcript.append("typed", text, now);
  const anchored = transcript.append("anchored", text, now + 1);
  const bound = spokenLedger.bound(transcript.conversation(key), [typed, anchored]);
  assert.deepEqual([...bound.rows.keys()], [anchored.id]);
});

test("replaying a discarded capture confirms only its new handoff even when outbox ID and revision repeat", async () => {
  const { reserveSpokenTurn, spokenLedger } = await import("../src/server/delivery-ledgers.ts");
  const transcript = fakeTranscript();
  const key = "recreated-capture";
  const conversation = transcript.conversation(key);
  const words = "inspect the build";
  const abandoned = claimSpoken(key, words, words);
  const first = reserveSpokenTurn(conversation, words, words, false, abandoned);
  db.closeDb();
  db.recoverSendingPendingTurns(Date.now());
  assert.equal(db.clearPendingTurns(key).count, 1);
  const typed = transcript.append("typed-in-between", words, Date.now());
  const replay = claimSpoken(key, words, words);
  assert.equal(replay.id, abandoned.id);
  assert.equal(replay.revision, abandoned.revision);
  const second = reserveSpokenTurn(conversation, words, words, false, replay);
  assert.notEqual(second.id, first.id);
  const delivered = transcript.append("actual-replay", words, Date.now());
  assert.equal(db.retireDeliveredPendingTurn(abandoned.id, abandoned.revision, Date.now(), first.id), false);
  assert.ok(db.retireDeliveredPendingTurn(replay.id, replay.revision, Date.now(), second.id));
  db.closeDb();
  spokenLedger.forgetCaches();
  const bound = spokenLedger.bound(conversation, [typed, delivered]);
  assert.deepEqual([...bound.rows.keys()], [delivered.id]);
  assert.equal(bound.rows.get(delivered.id)?.id, second.id);
});

test("busy spoken message takes the live ask list on idle, matches its composed echo and records one human Goal", async t => {
  const { Registry } = await import("../src/server/registry.ts");
  const { ReviewManager } = await import("../src/server/reviews.ts");
  const { PendingTurnManager } = await import("../src/server/pending-turns.ts");
  const { applyFeatureFlagIntent } = await import("../src/server/feature-flags/index.ts");
  const { unexpectedActiveSdkDelivery } = await import("./helpers/pending-turn-sender.ts");
  applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: true });
  const registry = new Registry();
  const reviews = new ReviewManager(registry);
  const id = "sdk:claim-time";
  const key = "claim-time";
  const cwd = "/repo/claim-time";
  registry.registerSdkSession({ id, agent: "claude", name: "claim-time", cwd, agentSessionId: key });
  registry.applyDriverEvent(id, { kind: "state", state: "working", activity: null });
  const seen: string[] = [];
  let handoffGeneration: number | undefined;
  const manager = new PendingTurnManager(registry, {
    ...unexpectedActiveSdkDelivery,
    sendWhenIdle: async (_, turn, beforeSend) => {
      assert.equal(beforeSend?.(), null);
      handoffGeneration = registry.getSession(id)?.workCycle?.generation;
      seen.push(turn.text);
      registry.applyHook({ agent: "claude", event: "UserPromptSubmit", sessionId: key,
        cwd, transcriptPath: null, env: {}, prompt: turn.text });
      registry.applyDriverEvent(id, { kind: "state", state: "working", activity: null });
      registry.applyDriverEvent(id, { kind: "turn_done", usage: null });
      return "started";
    },
  }, { idleSettleMs: 0, unseenReports: () => "There is an unseen report." });
  manager.start();
  t.after(() => manager.stop());
  const words = "check the build";
  assert.equal(manager.submitSpoken(id, words, "check").pendingTurn?.text, words);
  const ask = reviews.create(id, "input", "Added after the utterance", "Which?", null, { snoozable: true, waitMode: "message" });
  const delivered = new Promise<TurnDelivered>(resolve => registry.onTurnDelivered(resolve));
  registry.applyDriverEvent(id, { kind: "turn_done", usage: null });
  const receipt = await Promise.race([delivered, new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error("delivery timed out")), 3000);
    t.after(() => clearTimeout(timer));
  })]);
  assert.deepEqual(receipt.spoken, { generation: handoffGeneration });
  assert.deepEqual(seen, [spokenMessageText(words, {
    openQuestions: openQuestionsNote([ask]), unseenReports: "There is an unseen report.",
  })]);
  assert.equal(registry.getGoal(id)?.prompt, words);
  assert.equal(registry.getGoal(id)?.promptRevision, 1);
  assert.equal(registry.voiceHold(id), false, "the receiving turn finished before acknowledgement");
});
