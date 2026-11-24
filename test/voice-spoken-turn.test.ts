import assert from "node:assert/strict";
import fs, { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
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

test("upgrade from 54 leaves typed rows untouched, and spoken composition survives restart and retry", () => {
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
    ALTER TABLE pending_turns DROP COLUMN spoken_claim_id;
    ALTER TABLE pending_turns DROP COLUMN spoken_proof_failures;
    ALTER TABLE pending_turns DROP COLUMN spoken_requires_guard;
    ALTER TABLE session_work_cycles DROP COLUMN spoken_hold;
    ALTER TABLE session_work_cycles DROP COLUMN spoken_hold_since;
    PRAGMA user_version = 54;
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
  const { spokenClaimId, ...publicTurn } = claimed;
  assert.ok(spokenClaimId);
  assert.equal(db.openDb().prepare("SELECT spoken_claim_id FROM pending_turns WHERE id = ?").get(queued.id)?.spoken_claim_id, spokenClaimId);
  assert.deepEqual(db.createPendingTurn(replay), publicTurn);
  assert.throws(() => db.createPendingTurn({ ...replay, noteKey: "other" }), /different outbox message/);
  assert.throws(() => db.createPendingTurn({ ...replay, spokenWords: "different" }), /different outbox message/);
  const released = db.releasePendingTurn(claimed.id, claimed.revision, "transport refused", 6)!;
  db.closeDb();
  const retry = db.claimNextPendingTurn(key, 7, released, () => assert.fail("retry composed twice"))!;
  assert.ok(retry.spokenClaimId);
  assert.notEqual(retry.spokenClaimId, spokenClaimId);
  assert.equal(retry.text, claimed.text);
  assert.equal(db.openDb().prepare("SELECT composed_at FROM pending_turns WHERE id = ?").get(queued.id)?.composed_at, 5);
  expectHumanEcho("sdk:test", retry.text, { noteKey: key, cycle: undefined, now: 7 });
  assert.equal(claimHumanEcho("sdk:test", key, words, 8).kind, "none");
  assert.equal(claimHumanEcho("sdk:test", key, retry.text, 8).kind, "capture");
  db.closeDb();
});

test("preparation settlement cannot spend a replacement spoken claim's retry budget", () => {
  const key = "reused-preparation-claim";
  const claim = (now: number) => {
    const q = db.createPendingTurn({ id: key, noteKey: key, text: "same words", spokenWords: "same words", now });
    return db.claimNextPendingTurn(key, now, q, words => words)!;
  };
  const original = claim(1);
  assert.ok(db.deleteClaimedPendingTurn(original.id, original.revision));
  const replacement = claim(2);
  assert.equal(replacement.revision, original.revision);
  assert.equal(db.failSpokenPreparation(original, 3, "proof failed"), null);
  assert.equal(db.listPendingTurns(key)[0]?.state, "sending");
  db.openDb().exec(`CREATE TEMP TRIGGER ignore_proof_failure BEFORE UPDATE OF spoken_proof_failures ON pending_turns
    BEGIN SELECT RAISE(IGNORE); END`);
  try {
    assert.throws(() => db.failSpokenPreparation(replacement, 4, "proof failed"), /Could not record/);
  } finally {
    db.openDb().exec("DROP TRIGGER ignore_proof_failure");
  }
  assert.deepEqual(db.failSpokenPreparation(replacement, 5, "proof failed"), { noteKey: key, exhausted: false });
  assert.equal(db.listPendingTurns(key)[0]?.state, "queued");
});

test("stale preparation failure preserves a replacement's retry budget with identical timestamps", () => {
  const key = "same-time-preparation-replay";
  const claim = () => {
    const queued = db.createPendingTurn({ id: key, noteKey: key, spokenWords: "inspect", text: "inspect", now: 1 });
    return db.claimNextPendingTurn(key, 2, queued, words => words)!;
  };
  const original = claim();
  assert.ok(db.deleteClaimedPendingTurn(original.id, original.revision));
  const replacement = claim();
  assert.equal(replacement.revision, original.revision);
  assert.notEqual(replacement.spokenClaimId, original.spokenClaimId);

  assert.equal(db.failSpokenPreparation(original, 3, "stale failure"), null);
  const row = db.openDb().prepare("SELECT state, spoken_proof_failures FROM pending_turns WHERE id = ? AND spoken_claim_id = ?")
    .get(key, replacement.spokenClaimId);
  assert.equal(row?.state, "sending");
  assert.equal(row.spoken_proof_failures, 0);
});

for (const [scenario, createdAt, claimedAt] of [
  ["changed creation time", 2, 3],
  ["changed claim time", 1, 4],
  ["identical timestamps", 1, 3],
] as const) test(`a pre-handoff refusal cannot requeue a replacement (${scenario}) or a claim past handoff`, () => {
  const key = `pre-handoff-refusal-replay-${scenario}`;
  const make = (createdAt: number, claimedAt: number) => {
    const row = db.createPendingTurn({ id: key, noteKey: key, spokenWords: "inspect", text: "inspect", now: createdAt });
    return db.claimNextPendingTurn(key, claimedAt, row, words => words)!;
  };
  const original = make(1, 3);
  db.clearPendingTurns(key);
  const replay = make(createdAt, claimedAt);
  assert.equal(replay.revision, original.revision);
  assert.equal(db.releaseUnreservedSpokenClaim(original, "old refusal", 5), null);
  assert.equal(db.listPendingTurns(key)[0]?.state, "sending");
  assert.ok(db.recordSpokenHandoff(replay.id, replay.revision, 0, 6));
  assert.equal(db.releaseUnreservedSpokenClaim(replay, "late refusal", 7), null);
  assert.equal(db.listPendingTurns(key)[0]?.state, "sending");
  db.clearPendingTurns(key);
});

test("a refused spoken release fences the attempt and rolls the queue transition back if withdrawal fails", async () => {
  const { reserveSpokenTurn } = await import("../src/server/delivery-ledgers.ts");
  const key = "atomic-refused-spoken";
  const words = "test the queue";
  const turn = claimSpoken(key, words, words);
  const reservation = reserveSpokenTurn({ key, transcript: null }, words, words, true, turn);
  assert.equal(db.releasePendingTurn(turn.id, turn.revision, "refused", 10, "old-attempt"), null);
  db.openDb().exec("CREATE TRIGGER ignore_withdrawal BEFORE DELETE ON session_spoken_turns BEGIN SELECT RAISE(IGNORE); END");
  try {
    assert.throws(() => db.releasePendingTurn(turn.id, turn.revision, "refused", 10, reservation.id), /not withdrawn/);
    assert.equal(db.listPendingTurns(key)[0]?.state, "sending");
    assert.equal(db.loadSpokenTurns(key)[0]?.id, reservation.id);
  } finally {
    db.openDb().exec("DROP TRIGGER ignore_withdrawal");
  }
  assert.equal(db.releasePendingTurn(turn.id, turn.revision, "refused", 11, reservation.id)?.state, "queued");
  assert.equal(db.loadSpokenTurns(key).length, 0);
  assert.equal(db.openDb().prepare("SELECT spoken_reservation_id FROM pending_turns WHERE id=?").get(turn.id)?.spoken_reservation_id, null);
});

test("spoken ledger reloads the exact payload and binds its native turn once a competing send is released", async () => {
  const { delegatedLedger, reserveSpokenTurn, spokenLedger } = await import("../src/server/delivery-ledgers.ts");
  const { forgetDeliveryBindingState } = await import("../src/server/delivery-binding.ts");
  const transcript = fakeTranscript();
  const conversation = transcript.conversation("spoken-binding");
  const spokenWords = "inspect the build";
  const received = spokenMessageText(spokenWords, { openQuestions: null, unseenReports: null });
  const now = Date.now();
  const attempt = claimSpoken(conversation.key, spokenWords, received);
  const reserve = () => reserveSpokenTurn(conversation, spokenWords, received, false, attempt, now);
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
  const { reserveSpokenTurn, spokenLedger } = await import("../src/server/delivery-ledgers.ts");
  const { claudeTranscript } = await import("../src/server/harness/claude/transcript.ts");
  const dir = mkdtempSync(join(tmpdir(), "voice-late-transcript-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "native.jsonl");
  writeFileSync(path, "");
  const created = statSync(path).birthtimeMs;
  const text = "check the build";
  const ts = Math.ceil(created) + 5;
  const contents = ["first-native", "typed-repeat"].map((uuid, i) => JSON.stringify({ type: "user", uuid,
    timestamp: new Date(ts + i).toISOString(), message: { role: "user", content: text } }) + "\n").join("");
  appendFileSync(path, contents);
  const transcript = { path, read: claudeTranscript.messages! };
  for (const [key, reservedAt, expected] of [
    ["before-file", Math.floor(created) - 1, ["first-native"]], ["same-time", Math.floor(created), []],
    ["after-file", Math.ceil(created) + 1, []],
  ] as const) {
    const attempt = claimSpoken(key, text, text);
    reserveSpokenTurn({ key, transcript: null }, text, text, false, attempt, reservedAt);
    assert.ok(db.retireDeliveredPendingTurn(attempt.id, attempt.revision, ts, attempt.reservationId));
    assert.deepEqual([...spokenLedger.bound({ key, transcript }, transcript.read.after(path, 0).messages).rows.keys()], expected);
  }
  db.closeDb();
  spokenLedger.forgetCaches();
  const boundIds = () => [...spokenLedger.bound({ key: "before-file", transcript }, transcript.read.after(path, 0).messages).rows.keys()];
  assert.deepEqual(boundIds(), ["first-native"]);
  writeFileSync(path + ".next", contents);
  renameSync(path + ".next", path);
  assert.deepEqual(boundIds(), []);
});

test("terminal handoff accepts an intervening append and rejects a prefix rewritten during final verification", async t => {
  const { reserveSpokenTurn, spokenLedger } = await import("../src/server/delivery-ledgers.ts");
  const { claudeTranscript } = await import("../src/server/harness/claude/transcript.ts");
  const dir = mkdtempSync(join(tmpdir(), "spoken-active-boundary-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const read = claudeTranscript.messages!;
  const prefix = JSON.stringify({ padding: "x".repeat(128 * 1024) }) + "\n";
  for (const mode of ["append", "edit-and-grow", "second-pass-edit", "rotate"] as const) {
    const key = "hash-during-" + mode;
    const path = join(dir, key);
    writeFileSync(path, prefix);
    const conversation = { key, transcript: { path, read } };
    const words = "read the build log";
    const received = spokenMessageText(words, { openQuestions: null, unseenReports: null });
    const attempt = claimSpoken(key, words, received);
    const expected = read.boundary!(path);
    const nativeRead = fs.readSync;
    let writes = 0;
    const reads = t.mock.method(fs, "readSync", (fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
      const count = nativeRead(fd, buffer, offset, length, position);
      if (position === 0 && (!writes || (mode === "second-pass-edit" && writes === 1))) {
        if (mode === "rotate" && !writes) {
          writeFileSync(path + ".next", prefix);
          renameSync(path + ".next", path);
        } else if ((mode === "edit-and-grow" && !writes) || (mode === "second-pass-edit" && writes === 1)) {
          writeFileSync(path, prefix.replace("xxx", "yyy"));
        }
        appendFileSync(path, "{}\n");
        writes++;
      }
      return count;
    });
    syncBuiltinESMExports();
    let row;
    try {
      row = reserveSpokenTurn(conversation, words, received, false, attempt);
    } finally {
      reads.mock.restore();
      syncBuiltinESMExports();
    }
    assert.ok(writes > 0);
    assert.equal(row.transcriptBoundary, mode === "append" ? expected?.proof : null, mode);
    assert.equal(row.transcriptOffset, Buffer.byteLength(prefix));
    assert.ok(db.retireDeliveredPendingTurn(attempt.id, attempt.revision, Date.now(), row.id));
    appendFileSync(path, JSON.stringify({ type: "user", uuid: "actual", timestamp: new Date().toISOString(),
      message: { role: "user", content: received } }) + "\n");
    spokenLedger.forgetCaches();
    const actual = spokenLedger.bound(conversation, read.after(path, 0).messages).rows.get("actual");
    assert.equal(actual?.received, mode === "append" ? received : undefined, mode);
  }
});

test("handoff and fixed-offset proof batches retry a final-pass rewrite and growth before certifying the new revision", async t => {
  const { captureHandoffBoundaries, transcriptBoundary, transcriptSnapshot } = await import("../src/server/transcript-boundary.ts");
  const dir = mkdtempSync(join(tmpdir(), "spoken-proof-revision-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const prefix = "x".repeat(130_000);
  for (const handoff of [true, false]) {
    const path = join(dir, "transcript-" + handoff);
    writeFileSync(path, prefix);
    const original = transcriptBoundary(path, prefix.length);
    const read = fs.readSync;
    let passes = 0;
    const mock = t.mock.method(fs, "readSync", (fd: number, buf: Buffer, offset: number, length: number, pos: number) => {
      const n = read(fd, buf, offset, length, pos);
      if (pos === 0 && ++passes <= 2) {
        if (passes === 2) writeFileSync(path, "y" + prefix.slice(1) + "a");
        appendFileSync(path, "a");
      }
      return n;
    });
    syncBuiltinESMExports();
    try {
      assert.equal(captureHandoffBoundaries(path, [prefix.length], handoff), null);
      assert.equal(passes, 2);
    } finally {
      mock.mock.restore();
      syncBuiltinESMExports();
    }
    const stable = captureHandoffBoundaries(path, [prefix.length], handoff);
    assert.equal(stable?.version, transcriptSnapshot(path)?.version);
    assert.notEqual(stable?.proofs.get(prefix.length)?.proof, original?.proof);
    assert.deepEqual(stable?.proofs.get(prefix.length), transcriptBoundary(path, prefix.length));
  }
});

test("a fixed-offset read error retries disclosure on the same revision while an unreadable handoff can proceed", async t => {
  const { captureHandoffBoundaries, transcriptSnapshot } = await import("../src/server/transcript-boundary.ts");
  const dir = mkdtempSync(join(tmpdir(), "spoken-fixed-read-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "turns.jsonl");
  writeFileSync(path, "native transcript\n");
  const version = transcriptSnapshot(path)!.version;
  const error = Object.assign(new Error("transient read error"), { code: "EIO" });
  const reads = t.mock.method(fs, "readSync", () => { throw error; });
  syncBuiltinESMExports();
  try {
    for (const includeEof of [false, true]) {
      const fallback = captureHandoffBoundaries(path, [4], includeEof);
      assert.deepEqual(fallback, { version, eof: null, proofs: new Map(), unreadable: true });
    }
  } finally {
    reads.mock.restore();
    syncBuiltinESMExports();
  }
  const recovered = captureHandoffBoundaries(path, [4], false);
  assert.equal(recovered?.version, version);
  assert.ok(recovered?.proofs.get(4)?.proof);
});

test("terminal proof preparation leaves the daemon responsive and rechecks the file and outbox claim at paste", async t => {
  const { prepareSpokenTranscript, reserveSpokenHandoff, SpokenTranscriptChanged } = await import("../src/server/delivery-ledgers.ts");
  const { claudeTranscript } = await import("../src/server/harness/claude/transcript.ts");
  const dir = mkdtempSync(join(tmpdir(), "spoken-worker-proof-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const key = "off-thread-handoff";
  const path = join(dir, "terminal.jsonl");
  writeFileSync(path, Buffer.alloc(8 * 1024 * 1024, 32));
  const transcript = { path, read: claudeTranscript.messages! };
  const conversation = { key, transcript };
  const words = "check the archive";
  const queued = db.createPendingTurn({ id: key, noteKey: key, spokenWords: words, text: words, now: 1 });
  const turn = db.claimNextPendingTurn(key, 2, queued, s => s)!;
  const expected = transcript.read.boundary!(path);
  const reads = t.mock.method(fs, "readSync", () => assert.fail("handoff read transcript history on the daemon thread"));
  syncBuiltinESMExports();
  try {
    let daemonResponded = false;
    setImmediate(() => { daemonResponded = true; });
    const prepared = await prepareSpokenTranscript(key, transcript, turn.text);
    assert.equal(daemonResponded, true);
    assert.deepEqual(prepared.capture?.eof, expected);
    assert.deepEqual(db.loadSpokenTurns(key), []);
    appendFileSync(path, "\n");
    assert.throws(() => reserveSpokenHandoff(conversation, turn, words, false, 0, 3, prepared), SpokenTranscriptChanged);
    assert.deepEqual(db.loadSpokenTurns(key), []);
    const current = await prepareSpokenTranscript(key, transcript, turn.text);
    assert.ok(db.releasePendingTurn(turn.id, turn.revision, "refused", 4));
    assert.equal(reserveSpokenHandoff(conversation, turn, words, false, 0, 5, current), null);
    const next = db.claimNextPendingTurn(key, 6, db.listPendingTurns(key)[0]!, s => s)!;
    const row = reserveSpokenHandoff(conversation, next, words, false, 0, 7, current);
    assert.equal(row?.transcriptBoundary, current.capture?.eof?.proof);
    assert.equal(row?.transcriptOffset, statSync(path).size);
    assert.deepEqual(db.loadSpokenTurns(key).map(r => r.id), [row!.id]);
  } finally {
    reads.mock.restore();
    syncBuiltinESMExports();
  }
});

test("typed, delegated and review sends leave unprepared spoken transcript work to the worker-backed projection", async t => {
  const { reserveSpokenTurn, spokenLedger, noteOtherSend, withdrawOtherSend, withSpokenReadProofs } = await import("../src/server/delivery-ledgers.ts");
  const { reserveDelegatedTurn } = await import("../src/server/delegated-turns.ts");
  const { reserveReviewDelivery } = await import("../src/server/review-deliveries.ts");
  const { wrapReviewEnvelope } = await import("../src/shared/review-message-envelope.ts");
  const { claudeTranscript } = await import("../src/server/harness/claude/transcript.ts");
  const dir = mkdtempSync(join(tmpdir(), "spoken-unprepared-send-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const native = claudeTranscript.messages!;
  const now = Date.now();
  const words = "inspect the previous delivery";
  const line = (uuid: string, content: string) => JSON.stringify({ type: "user", uuid,
    timestamp: new Date(now).toISOString(), message: { role: "user", content } }) + "\n";
  for (const kind of ["typed", "delegated", "review"]) {
    const key = "unprepared-send-" + kind;
    const path = join(dir, key + ".jsonl");
    writeFileSync(path, line("history", "x".repeat(1024 * 1024)));
    const claim = claimSpoken(key, words, words);
    const row = reserveSpokenTurn({ key, transcript: { path, read: native } }, words, words, false, claim, now);
    assert.ok(db.retireDeliveredPendingTurn(claim.id, claim.revision, now, row.id));
    appendFileSync(path, line("actual", words));
    const messages = native.after(path, row.transcriptOffset!).messages;
    const boundary = t.mock.fn(native.boundary!);
    const after = t.mock.fn(native.after);
    const convo = { key, transcript: { path, read: { ...native, boundary, after } } };
    if (kind === "typed") withdrawOtherSend(noteOtherSend(convo, words, now));
    else if (kind === "delegated") reserveDelegatedTurn(convo, "different delegated instruction", { id: "controller", name: "Controller" }, now);
    else assert.ok(reserveReviewDelivery(convo, wrapReviewEnvelope("answer", ["b99fa7da-f9dd-4bab-9e44-691bac441a4c"], "a different answer"), undefined, now));
    assert.equal(after.mock.callCount(), 0, kind + " send walked the transcript");
    assert.equal(boundary.mock.callCount(), 0, kind + " send hashed the prefix");
    assert.equal(db.loadSpokenTurns(key)[0]?.messageId, null);
    const bound = await withSpokenReadProofs(convo, messages, prepared => spokenLedger.bound(prepared, messages));
    assert.equal(bound.rows.get("actual")?.id, row.id);
    assert.equal(boundary.mock.callCount(), 0, "prepared projection used the worker proof");
  }
});

test("a new spoken handoff reconciles an older receipt across a long suffix outside the guard and rechecks senders, file and claim", async t => {
  const { prepareSpokenTranscript, reserveSpokenHandoff, reserveSpokenTurn, noteOtherSend, withdrawOtherSend,
    SpokenTranscriptChanged } = await import("../src/server/delivery-ledgers.ts");
  const { claudeTranscript } = await import("../src/server/harness/claude/transcript.ts");
  const dir = mkdtempSync(join(tmpdir(), "spoken-handoff-reconcile-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const now = Date.now();
  const words = "inspect the build";
  const line = (id: string, text: string) => JSON.stringify({ type: "user", uuid: id,
    timestamp: new Date(now).toISOString(), message: { role: "user", content: text } }) + "\n";
  const history = Array.from({ length: 600 }, (_, i) => line("history-" + i, "x".repeat(4096))).join("");
  for (const sdk of [false, true]) {
    const key = "handoff-reconcile-" + sdk;
    const path = join(dir, key + ".jsonl");
    writeFileSync(path, line("prefix", "before handoff"));
    let pages = 0;
    let callbacks = 0;
    let guardedReads = 0;
    const native = claudeTranscript.messages!;
    const read = { ...native, after: (...args: Parameters<typeof native.after>) => {
      if (db.openDb().isTransaction) guardedReads++;
      const page = native.after(...args);
      if (!page.atEnd) {
        pages++;
        setImmediate(() => { callbacks++; });
      }
      return page;
    } };
    const transcript = { path, read };
    const conversation = { key, transcript };
    const first = claimSpoken(key, words, words);
    const earlier = reserveSpokenTurn(conversation, words, words, false, first, now);
    assert.ok(db.retireDeliveredPendingTurn(first.id, first.revision, now, earlier.id));
    appendFileSync(path, history + line("earlier-native", words));
    const queued = db.createPendingTurn({ id: key + "-next", noteKey: key, text: words, spokenWords: words, now });
    const claim = db.claimNextPendingTurn(key, now, queued, s => s)!;
    const prepare = () => prepareSpokenTranscript(key, transcript, claim.text, sdk, now);
    const guard = (proof: Awaited<ReturnType<typeof prepare>>, turn = claim) =>
      reserveSpokenHandoff(conversation, turn, words, sdk, 0, now, proof);
    const staleFile = await prepare();
    assert.equal(db.loadSpokenTurns(key)[0]?.messageId, "earlier-native");
    assert.ok(pages > 2);
    assert.equal(callbacks, pages);
    appendFileSync(path, line("changed-file", "more output"));
    assert.throws(() => guard(staleFile), SpokenTranscriptChanged);
    const staleSender = await prepare();
    const rival = noteOtherSend(conversation, words, now);
    assert.throws(() => guard(staleSender), SpokenTranscriptChanged);
    withdrawOtherSend(rival);
    const ready = await prepare();
    assert.ok(db.releasePendingTurn(claim.id, claim.revision, "recall", now));
    assert.equal(guard(ready), null);
    const next = db.claimNextPendingTurn(key, now, db.listPendingTurns(key)[0]!)!;
    const current = await prepare();
    const reserved = guard(current, next);
    assert.ok(reserved);
    assert.ok(db.retireDeliveredPendingTurn(next.id, next.revision, now, reserved.id));
    assert.equal(guardedReads, 0);
    t.diagnostic(`${sdk ? "SDK" : "terminal"}: ${Buffer.byteLength(history)} bytes, ${callbacks} interleaved callbacks, zero guard page reads.`);
  }
});

test("a buffered older terminal turn flushed past the saved offset cannot claim the spoken delivery", async () => {
  const { reserveSpokenTurn, spokenLedger } = await import("../src/server/delivery-ledgers.ts");
  const now = Date.now();
  const transcript = fakeTranscript();
  transcript.append("prefix", "older history", now - 10);
  const conversation = transcript.conversation("buffered-terminal-record");
  const words = "check the logs";
  const received = spokenMessageText(words, { openQuestions: null, unseenReports: null });
  const attempt = claimSpoken(conversation.key, words, received);
  const row = reserveSpokenTurn(conversation, words, received, false, attempt, now);
  assert.ok(row.transcriptOffset);
  assert.ok(db.retireDeliveredPendingTurn(attempt.id, attempt.revision, now, row.id));
  const older = transcript.append("buffered-native", received, now - 1);
  assert.equal(spokenLedger.bound(conversation, [older]).rows.size, 0);
  const actual = transcript.append("actual-native", received, now);
  assert.deepEqual([...spokenLedger.bound(conversation, [older, actual]).rows.keys()], [actual.id]);
  assert.equal(db.loadSpokenTurns(conversation.key)[0]?.messageId, actual.id);
  // A previous daemon may already have recorded the buffered turn as the receipt.
  db.openDb().prepare("UPDATE session_spoken_turns SET message_id = ?, message_ts = ? WHERE id = ?").run(older.id, older.ts, row.id);
  db.closeDb();
  db.recoverSendingPendingTurns(now + 1);
  assert.deepEqual([...spokenLedger.bound(conversation, [older, actual]).rows.keys()], [actual.id]);
});

test("a confirmed terminal send binds only in the file and history captured at handoff", async t => {
  const { reserveSpokenTurn, spokenLedger } = await import("../src/server/delivery-ledgers.ts");
  const { claudeTranscript } = await import("../src/server/harness/claude/transcript.ts");
  const dir = mkdtempSync(join(tmpdir(), "spoken-boundary-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const now = Date.now();
  const words = "inspect the build";
  const payload = spokenMessageText(words, { openQuestions: null, unseenReports: null });
  const line = (uuid: string, content: string) => JSON.stringify({ type: "user", uuid, timestamp: new Date(now).toISOString(),
    message: { role: "user", content } }) + "\n";
  const prefix = line("prefix", "before") + line("boundary", "same last record");
  for (const kind of ["append", "replace", "rewrite", "legacy"]) {
    const key = "terminal-file-" + kind;
    const path = join(dir, key + ".jsonl");
    writeFileSync(path, prefix);
    const transcript = { path, read: claudeTranscript.messages! };
    const conversation = { key, transcript };
    const attempt = claimSpoken(key, words, payload);
    const row = reserveSpokenTurn(conversation, words, payload, false, attempt, now);
    assert.ok(db.retireDeliveredPendingTurn(attempt.id, attempt.revision, now, row.id));
    if (kind === "replace") {
      writeFileSync(path + ".next", prefix);
      renameSync(path + ".next", path);
    } else if (kind === "rewrite") {
      writeFileSync(path, prefix.replace("before", "edited"));
    } else if (kind === "legacy") {
      db.openDb().prepare("UPDATE session_spoken_turns SET transcript_boundary = NULL WHERE id = ?").run(row.id);
    }
    appendFileSync(path, line("same-words", payload));
    db.closeDb();
    spokenLedger.forgetCaches();
    const messages = transcript.read.after(path, 0).messages;
    assert.equal(spokenLedger.bound(conversation, messages).rows.has("same-words"), kind === "append", kind);
    assert.equal(db.loadSpokenTurns(key)[0]?.messageId, kind === "append" ? "same-words" : null);
    if (kind === "append") {
      writeFileSync(path, prefix.replace("before", "edited") + line("same-words", payload));
      assert.equal(spokenLedger.bound(conversation, transcript.read.after(path, 0).messages).rows.size, 0, "edited prefix and reused ID");
      writeFileSync(path, prefix + line("same-words", payload));
      assert.equal(spokenLedger.bound(conversation, transcript.read.after(path, 0).messages).rows.size, 1, "restored prefix");
      writeFileSync(path + ".next", prefix + line("same-words", payload));
      renameSync(path + ".next", path);
      db.closeDb();
      spokenLedger.forgetCaches();
      assert.equal(spokenLedger.bound(conversation, transcript.read.after(path, 0).messages).rows.size, 0, "replacement with identical ID, words and timestamp");
      const sdk = reserveSpokenTurn(conversation, words, payload, true, claimSpoken(key, words, payload), now);
      const native = transcript.read.after(path, 0).messages.at(-1)!;
      assert.equal(spokenLedger.bound(conversation, [{ ...native, clientMessageId: sdk.id }]).rows.get(native.id)?.id, sdk.id,
        "a separate SDK client receipt still identifies its delivery on the replacement");
      writeFileSync(path + ".next", prefix + line("typed-on-replacement", payload));
      renameSync(path + ".next", path);
      const replacement = transcript.read.after(path, 0).messages;
      assert.equal(spokenLedger.bound(conversation, replacement).rows.has("typed-on-replacement"), false);
    }
  }
});

test("archived spoken payloads leave the bounded cache and their disclosures reload from SQLite", async t => {
  const { reserveSpokenTurn, spokenLedger } = await import("../src/server/delivery-ledgers.ts");
  const { Registry } = await import("../src/server/registry.ts");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const key = "archived-cached-spoken";
  const transcript = fakeTranscript();
  const conversation = transcript.conversation(key);
  const words = "read the report";
  const payload = spokenMessageText(words, { openQuestions: null, unseenReports: null });
  const attempt = claimSpoken(key, words, payload);
  const row = reserveSpokenTurn(conversation, words, payload, true, attempt);
  assert.ok(db.retireDeliveredPendingTurn(attempt.id, attempt.revision, Date.now(), row.id));
  const message = transcript.append(row.id, payload, Date.now());
  assert.equal(spokenLedger.bound(conversation, [message]).rows.get(message.id)?.received, payload);
  const cached = spokenLedger.rows(key);
  const registry = new Registry();
  const id = "sdk:spoken-cache";
  registry.registerSdkSession({ id, agent: "claude", name: "Cache", cwd: "/tmp", agentSessionId: key });
  registry.applyDriverEvent(id, { kind: "exited", reason: "relaunch", resumable: true });
  t.mock.timers.tick(8000);
  assert.equal(registry.getSession(id), undefined);
  const reopened = spokenLedger.rows(key);
  assert.notStrictEqual(reopened, cached);
  for (let i = 0; i < 100; i++) spokenLedger.rows("later-conversation-" + i);
  assert.notStrictEqual(spokenLedger.rows(key), reopened);
  assert.equal(spokenLedger.bound(conversation, [message]).rows.get(message.id)?.received, payload);
});

test("restart retries a proven pre-guard spoken claim once and keeps legacy and partially stamped attempts uncertain", async () => {
  const { reserveSpokenHandoff } = await import("../src/server/delivery-ledgers.ts");
  const now = Date.now();
  const words = "inspect the resumed build";
  for (const key of ["unguarded-legacy", "guard-waiting", "partial-stamp", "ordinary-typed"]) {
    const queued = db.createPendingTurn({ id: key, noteKey: key, text: words, now,
      ...(key !== "ordinary-typed" && { spokenWords: words }) });
    db.claimNextPendingTurn(key, now, queued, () => words + " with original notes");
  }
  db.openDb().prepare("UPDATE pending_turns SET spoken_requires_guard = NULL WHERE id = 'unguarded-legacy'").run();
  db.openDb().prepare("UPDATE pending_turns SET spoken_handoff_at = ? WHERE id = 'partial-stamp'").run(now);
  db.closeDb();
  db.recoverSendingPendingTurns(now + 1);
  for (const key of ["unguarded-legacy", "partial-stamp", "ordinary-typed"]) {
    assert.equal(db.listPendingTurns(key)[0]?.state, "uncertain", key);
  }
  const key = "guard-waiting";
  const [restored] = db.listPendingTurns(key);
  assert.equal(restored?.state, "queued");
  assert.equal(restored.claimedAt, null);
  assert.equal(restored.text, words + " with original notes");
  const claimed = db.claimNextPendingTurn(key, now + 2, restored, () => assert.fail("recomposed the recovered turn"))!;
  const row = reserveSpokenHandoff({ key, transcript: null }, claimed, words, true, 0, now + 2)!;
  assert.ok(db.retireDeliveredPendingTurn(claimed.id, claimed.revision, now + 3, row.id));
  db.recoverSendingPendingTurns(now + 4);
  assert.deepEqual(db.listPendingTurns(key), []);
  assert.deepEqual(db.loadSpokenTurns(key).map(s => s.id), [row.id]);
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
    const [restored] = db.listPendingTurns(key);
    assert.equal(restored?.state, handedOff ? "uncertain" : "queued");
    if (handedOff) {
      assert.ok(db.resolveUncertainPendingTurn(queued.id, restored.revision));
      const [reservation] = db.loadSpokenTurns(key);
      assert.equal(reservation?.outboxTurnId, queued.id);
      assert.equal(reservation.outboxRevision, restored.revision - 1);
    } else {
      assert.ok(db.recallPendingTurn(key, queued.id, restored.revision));
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

test("after restart an uncertain terminal paste still contests a later delegated or review send before its native turn is flushed", async () => {
  const { delegatedLedger, reviewLedger, reserveSpokenTurn, spokenLedger } = await import("../src/server/delivery-ledgers.ts");
  const { forgetDeliveryBindingState } = await import("../src/server/delivery-binding.ts");
  const { reserveReviewDelivery } = await import("../src/server/review-deliveries.ts");
  const { wrapReviewEnvelope } = await import("../src/shared/review-message-envelope.ts");
  const words = wrapReviewEnvelope("answer", ["b99fa7da-f9dd-4bab-9e44-691bac441a4c"], "Inspect the build");
  const now = Date.now();
  for (const sender of ["delegated", "review"]) {
    const key = "uncertain-paste-before-" + sender;
    const fake = fakeTranscript();
    const conversation = fake.conversation(key);
    reserveSpokenTurn(conversation, words, words, false, claimSpoken(key, words, words), now);
    db.closeDb();
    db.recoverSendingPendingTurns(now + 1);
    forgetDeliveryBindingState();
    assert.equal(db.listPendingTurns(key)[0]?.state, "uncertain");
    if (sender === "review") assert.ok(reserveReviewDelivery(conversation, words, undefined, now + 2));
    else delegatedLedger.reserve(conversation, words, base => ({ ...base, controllerId: "sdk:sender", controllerName: "Sender" }), now + 2);
    const rival = sender === "review" ? reviewLedger : delegatedLedger;
    const turn = fake.append("late-flush", words, now + 3);
    assert.equal(rival.rows(key)[0]?.contested, true);
    forgetDeliveryBindingState();
    assert.equal(rival.bound(conversation, [turn]).rows.size, 0);
    assert.equal(spokenLedger.bound(conversation, [turn]).rows.size, 0);
    assert.equal(db.loadSpokenTurns(key)[0]?.messageId, null, "arbitration retained the reservation without granting a receipt");
  }
});

test("marking an uncertain terminal paste sent preserves its original sender claim across rollback, restart and first native binding", async t => {
  const { delegatedLedger, reviewLedger, reserveSpokenTurn, spokenLedger, followSpokenConversationKey } = await import("../src/server/delivery-ledgers.ts");
  const { forgetDeliveryBindingState } = await import("../src/server/delivery-binding.ts");
  const { reserveReviewDelivery } = await import("../src/server/review-deliveries.ts");
  const { wrapReviewEnvelope } = await import("../src/shared/review-message-envelope.ts");
  const now = Date.now();
  const words = wrapReviewEnvelope("answer", ["b99fa7da-f9dd-4bab-9e44-691bac441a4c"], "Use this build");
  for (const mode of ["warm", "restart", "native-key", "already-flushed", "rewritten", "long-history"]) {
    const key = "mark-sent-arbitration-" + mode;
    const fake = fakeTranscript();
    let conversation = fake.conversation(key);
    fake.append("before", words, now - 1);
    const attempt = claimSpoken(key, words, words);
    const reservation = reserveSpokenTurn(conversation, words, words, false, attempt, now);
    const uncertain = db.markPendingTurnUncertain(attempt.id, attempt.revision, "lost receipt", now + 1)!;
    assert.throws(() => db.inTransaction(() => {
      assert.ok(db.resolveUncertainPendingTurn(attempt.id, uncertain.revision, now + 2));
      throw new Error("roll back settlement");
    }), /roll back settlement/);
    assert.deepEqual(db.loadOtherSends(key, 0), []);
    assert.ok(db.resolveUncertainPendingTurn(attempt.id, uncertain.revision, now + 2));
    assert.deepEqual(db.loadSpokenTurns(key), [], "manual settlement cannot disclose a text-only turn");
    if (mode === "restart") { db.closeDb(); forgetDeliveryBindingState(); }
    if (mode === "native-key") {
      followSpokenConversationKey(key, key, key + "-native");
      conversation = fake.conversation(key + "-native");
      assert.deepEqual(db.loadOtherSends(key, 0), []);
    }
    const [saved] = db.loadOtherSends(conversation.key, 0);
    assert.deepEqual({ ...saved }, { id: reservation.id, noteKey: conversation.key, fingerprint: reservation.fingerprint,
      sentAt: now, transcriptOffset: reservation.transcriptOffset, spokenBoundary: reservation.transcriptBoundary });
    fake.append("old-buffered", words, now - 1);
    if (mode === "already-flushed" || mode === "rewritten") fake.append("spoken-first", words, now + 2);
    if (mode === "rewritten") fake.turns[0]!.text = "different history";
    if (mode === "long-history") for (let i = 0; i < 6000; i++) fake.append("progress-" + i, "progress", now);
    const rival = mode === "restart" ? reviewLedger : delegatedLedger;
    if (mode === "restart") assert.ok(reserveReviewDelivery(conversation, words, undefined, now + 3));
    else delegatedLedger.reserve(conversation, words, base => ({ ...base, controllerId: "sdk:controller", controllerName: "Controller" }), now + 3);
    const late = fake.append("after-reservation", words, now + 4);
    assert.equal(rival.rows(conversation.key)[0]?.contested, mode !== "already-flushed", mode);
    assert.equal(rival.bound(conversation, [late]).rows.has(late.id), mode === "already-flushed", mode);
    assert.equal(spokenLedger.bound(conversation, [late]).rows.size, 0);
    t.diagnostic(mode + ": later sender credited=" + (mode === "already-flushed") + ", spoken disclosures=0");
  }
});

test("a pending spoken release follows competing reservations to the native conversation before any post-restart ledger read", async () => {
  const { reserveSpokenTurn, spokenLedger, followSpokenConversationKey } = await import("../src/server/delivery-ledgers.ts");
  const { forgetDeliveryBindingState } = await import("../src/server/delivery-binding.ts");
  for (const duplicate of [false, true]) {
    const fake = fakeTranscript();
    const key = "sdk:provisional-release-" + duplicate;
    const native = "native-release-" + duplicate;
    const source = fake.conversation(key);
    const now = Date.now();
    const text = "same received payload " + duplicate;
    const first = claimSpoken(key, "first", text);
    const retained = reserveSpokenTurn(source, "first", text, false, first, now);
    assert.ok(db.retireDeliveredPendingTurn(first.id, first.revision, now, retained.id));
    const second = claimSpoken(key, "second", text);
    reserveSpokenTurn(source, "second", text, false, second, now);
    assert.ok(db.loadSpokenTurns(key).every(row => row.contested));
    const uncertain = db.markPendingTurnUncertain(second.id, second.revision, "lost receipt", now)!;
    assert.ok(db.retryPendingTurn(second.id, uncertain.revision, now));
    db.closeDb();
    forgetDeliveryBindingState();
    const debts = () => db.openDb().prepare("SELECT note_key FROM session_spoken_releases WHERE fingerprint = ? ORDER BY note_key")
      .all(retained.fingerprint).map(row => row.note_key);
    // Migration must tolerate a native reminder which was independently committed earlier.
    if (duplicate) db.openDb().prepare("INSERT INTO session_spoken_releases VALUES (?, ?)").run(native, retained.fingerprint);
    assert.throws(() => db.inTransaction(() => {
      db.moveSpokenTurns(key, native);
      throw new Error("rollback first native binding");
    }), /rollback/);
    assert.deepEqual(debts(), duplicate ? [native, key] : [key]);
    followSpokenConversationKey(key, key, native);
    assert.deepEqual(debts(), [native]);
    const message = fake.append("native-first", text, now + 1);
    const found = spokenLedger.bound(fake.conversation(native), [message]);
    assert.equal(found.rows.get(message.id)?.id, retained.id);
    assert.deepEqual(debts(), []);
  }
});

test("withdrawing uncertain speech reconsiders delegated and review senders after commit and restart", async () => {
  const { delegatedLedger, reviewLedger, reserveSpokenTurn, noteOtherSend } = await import("../src/server/delivery-ledgers.ts");
  const { forgetDeliveryBindingState } = await import("../src/server/delivery-binding.ts");
  const { reserveReviewDelivery } = await import("../src/server/review-deliveries.ts");
  const { wrapReviewEnvelope } = await import("../src/shared/review-message-envelope.ts");
  const now = Date.now();
  const words = wrapReviewEnvelope("answer", ["b99fa7da-f9dd-4bab-9e44-691bac441a4c"], "Use the new build");
  for (const action of ["discard", "retry", "mark-sent", "typed-rival", "two-senders"] as const) {
    const key = "withdraw-racing-speech-" + action;
    const fake = fakeTranscript();
    const conversation = fake.conversation(key);
    const attempt = claimSpoken(key, words, words);
    reserveSpokenTurn(conversation, words, words, false, attempt, now);
    const ledger = action === "retry" ? reviewLedger : delegatedLedger;
    if (action !== "retry") delegatedLedger.reserve(conversation, words, base => ({
      ...base, controllerId: "sdk:controller", controllerName: "Controller",
    }), now);
    if (action === "retry" || action === "two-senders") assert.ok(reserveReviewDelivery(conversation, words, undefined, now));
    if (action === "typed-rival") noteOtherSend(conversation, words, now);
    assert.equal(ledger.rows(key)[0]?.contested, true);
    const uncertain = db.markPendingTurnUncertain(attempt.id, attempt.revision, "interrupted", now)!;
    assert.throws(() => db.inTransaction(() => {
      db.clearPendingTurns(key);
      throw new Error("rollback");
    }), /rollback/);
    assert.equal(ledger.rows(key)[0]?.contested, true, "a rolled-back withdrawal cannot release the contest");
    if (action === "retry") assert.ok(db.retryPendingTurn(attempt.id, uncertain.revision, now));
    else if (action === "mark-sent") assert.ok(db.resolveUncertainPendingTurn(attempt.id, uncertain.revision));
    else db.clearPendingTurns(key);
    if (action === "retry") {
      db.closeDb();
      forgetDeliveryBindingState();
    }
    const onlyRival = action === "discard" || action === "retry";
    assert.equal(ledger.rows(key)[0]?.contested, !onlyRival, action);
    const native = fake.append("native-rival", words, now + 1);
    assert.equal(ledger.bound(conversation, [native]).rows.has(native.id), onlyRival, action);
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

test("confirmed and abandoned SDK reservations expire only after a verified native receipt scan", async () => {
  const { pruneExpiredSpokenTurns, reserveSpokenTurn, spokenLedger } = await import("../src/server/delivery-ledgers.ts");
  const { DELIVERY_LAG_MS } = await import("../src/server/delivery-binding.ts");
  const transcript = fakeTranscript();
  const words = "inspect the build";
  const received = spokenMessageText(words, { openQuestions: null, unseenReports: null });
  const now = Date.now();
  const cases = ["discarded", "retry", "legacy-orphan", "previously-read", "unread", "confirmed", "confirmed-orphan",
    "confirmed-unavailable", "uncertain"];
  for (const kind of cases) {
    const key = "sdk-expiry-" + kind;
    const attempt = claimSpoken(key, words, received);
    const conversation = transcript.conversation(key);
    const row = reserveSpokenTurn(conversation, words, received, true, attempt, now);
    if (kind === "legacy-orphan") db.openDb().prepare("DELETE FROM pending_turns WHERE id = ?").run(attempt.id);
    else if (kind.startsWith("confirmed")) assert.ok(db.retireDeliveredPendingTurn(attempt.id, attempt.revision, now, row.id));
    else {
      const uncertain = db.markPendingTurnUncertain(attempt.id, attempt.revision, "interrupted", now)!;
      if (kind === "retry") assert.ok(db.retryPendingTurn(attempt.id, uncertain.revision, now));
      else if (kind !== "uncertain") db.clearPendingTurns(key);
    }
    if (kind === "previously-read" || kind === "unread" || kind === "confirmed") {
      const message = transcript.append("native-" + kind, received, now);
      message.clientMessageId = row.id;
      if (kind === "previously-read") assert.equal(spokenLedger.bound(conversation, [message]).rows.get(message.id)?.id, row.id);
    } else {
      transcript.append("typed-" + kind, received, now);
    }
  }
  db.recoverSendingPendingTurns(now);
  const later = now + DELIVERY_LAG_MS;
  assert.equal(await pruneExpiredSpokenTurns(later - 1, () => []), 0);
  db.closeDb();
  spokenLedger.forgetCaches();
  db.recoverSendingPendingTurns(later);
  for (const kind of cases) assert.equal(spokenLedger.rows("sdk-expiry-" + kind).length, 1);
  assert.equal(await pruneExpiredSpokenTurns(later + 60_000, key =>
    key.startsWith("sdk-expiry-") && !key.endsWith("-previously-read") && !key.endsWith("-unavailable") ?
      [transcript.conversation(key).transcript] : []), 4);
  await pruneExpiredSpokenTurns(later + 60_000, () => [], now + 1);
  for (const kind of cases) {
    const key = "sdk-expiry-" + kind;
    const retained = ["previously-read", "unread", "confirmed", "confirmed-unavailable", "uncertain"].includes(kind);
    assert.equal(spokenLedger.rows(key).length, Number(retained), kind);
    assert.equal(db.loadSpokenTurns(key)[0]?.received, retained ? received : undefined, kind);
  }
  const sameTimestamp = transcript.append("typed-after-native", received, now);
  const conversation = transcript.conversation("sdk-expiry-previously-read");
  assert.equal(spokenLedger.bound(conversation, [sameTimestamp]).rows.has(sameTimestamp.id), false);
});

test("confirmed text-only payloads expire after the binding window while native disclosures survive", async t => {
  const { pruneExpiredSpokenTurns, reserveSpokenTurn, spokenLedger } = await import("../src/server/delivery-ledgers.ts");
  const { DELIVERY_LAG_MS } = await import("../src/server/delivery-binding.ts");
  const { claudeTranscript } = await import("../src/server/harness/claude/transcript.ts");
  const dir = mkdtempSync(join(tmpdir(), "unbound-terminal-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "native.jsonl");
  writeFileSync(path, "");
  const key = "expiry-terminal";
  const confirmed = Math.ceil(statSync(path).birthtimeMs) + 1;
  const conversation = { key, transcript: { path, read: claudeTranscript.messages! } };
  let unopened = "";
  for (const kind of ["no-offset", "bound", "unopened", "no-match", "recent"]) {
    const words = "inspect " + kind;
    const received = spokenMessageText(words, { openQuestions: "Open questions: which build?", unseenReports: "One unseen report." });
    const q = db.createPendingTurn({ id: kind, noteKey: key, spokenWords: words, text: words, now: confirmed });
    const turn = db.claimNextPendingTurn(key, confirmed, q, () => received)!;
    const reservationId = db.recordSpokenHandoff(turn.id, turn.revision, 0, confirmed)!;
    const row = reserveSpokenTurn(kind === "no-offset" ? { key, transcript: null } : conversation,
      words, received, false, { ...turn, reservationId }, confirmed);
    const confirmedAt = kind === "recent" ? confirmed + 60_000 : confirmed;
    assert.ok(db.retireDeliveredPendingTurn(turn.id, turn.revision, confirmedAt, row.id));
    if (kind === "no-match" || kind === "recent") continue;
    const line = JSON.stringify({ type: "user", uuid: kind, timestamp: new Date(confirmed + 5).toISOString(),
      message: { role: "user", content: received } }) + "\n";
    if (kind === "unopened") { unopened = line; continue; }
    appendFileSync(path, line);
    if (kind === "bound") spokenLedger.bindLanded(key, conversation.transcript, confirmed + 10);
  }
  appendFileSync(path, unopened);
  db.closeDb();
  spokenLedger.forgetCaches();
  const lookup = (candidate: string) => candidate === key ? [conversation.transcript] : [];
  assert.equal(db.loadSpokenTurns(key).find(row => row.outboxTurnId === "unopened")?.messageId, null);
  assert.equal(await pruneExpiredSpokenTurns(confirmed + DELIVERY_LAG_MS - 1, lookup), 0);
  const d = db.openDb();
  d.exec(`CREATE TEMP TRIGGER refuse_text_binding BEFORE UPDATE OF message_id ON session_spoken_turns
    WHEN OLD.outbox_turn_id = 'unopened' BEGIN SELECT RAISE(ABORT, 'binding refused'); END`);
  try {
    await pruneExpiredSpokenTurns(confirmed + DELIVERY_LAG_MS + 10, lookup, confirmed + 1);
    assert.ok(db.loadSpokenTurns(key).some(row => row.outboxTurnId === "unopened"));
  } finally {
    d.exec("DROP TRIGGER refuse_text_binding");
  }
  assert.equal(await pruneExpiredSpokenTurns(confirmed + DELIVERY_LAG_MS + 10, lookup), 2);
  const surviving = spokenLedger.rows(key);
  assert.deepEqual(surviving.map(r => [r.outboxTurnId, r.messageId]), [["bound", "bound"], ["unopened", "unopened"], ["recent", null]]);
  assert.ok(surviving.every(row => row.received.includes("One unseen report.")));
});

test("a quiet native binding survives a failed transcript read and advances attribution past a newer receipt", async t => {
  const { reserveSpokenTurn, spokenLedger } = await import("../src/server/delivery-ledgers.ts");
  const key = "deferred-native-binding";
  const fake = fakeTranscript();
  const convo = fake.conversation(key);
  const native = convo.transcript!;
  const now = Date.now();
  for (const words of ["first instruction", "newer instruction"]) {
    const attempt = claimSpoken(key, words, words);
    const reservation = reserveSpokenTurn(convo, words, words, false, attempt, now);
    assert.ok(db.retireDeliveredPendingTurn(attempt.id, attempt.revision, now, reservation.id));
  }
  const confirmed = db.spokenTranscriptState(key)?.receipt;
  const first = fake.append("native-first", "first instruction", now);
  const after = native.read.after.bind(native.read);
  t.mock.method(native.read, "after", (...args: Parameters<typeof after>) => {
    const page = after(...args);
    fake.append("growth", "concurrent output", now + 1);
    return page;
  }, { times: 1 });
  spokenLedger.bindLanded(key, native, now);
  assert.equal(db.loadSpokenTurns(key)[0]?.messageId, null);
  assert.equal(db.spokenTranscriptState(key)?.receipt, confirmed);
  // A native reader normally folds a transient filesystem error into an empty EOF.
  // The retry must request a strict read and keep its marker when that read fails.
  let requestedStrict = false;
  t.mock.method(native.read, "after", (...args: Parameters<typeof after>) => {
    requestedStrict = Boolean(args[3]);
    if (requestedStrict) throw new Error("transient native read failure");
    return { messages: [], start: args[1], end: args[1], atEnd: true };
  }, { times: 1 });
  spokenLedger.retryDeferredBindings(convo);
  assert.ok(requestedStrict);
  assert.equal(db.spokenTranscriptState(key)?.receipt, confirmed);
  spokenLedger.retryDeferredBindings(convo);
  const bound = db.spokenTranscriptState(key)?.receipt;
  assert.ok(bound && bound !== confirmed);
  assert.equal(db.loadSpokenTurns(key)[0]?.messageId, first.id);
  db.closeDb();
  assert.equal(db.spokenTranscriptState(key)?.receipt, bound);
});

test("a failed SDK receipt write leaves the exact disclosure readable and cleanup retries the observation", async () => {
  const { reserveSpokenTurn, spokenLedger, pruneExpiredSpokenTurns } = await import("../src/server/delivery-ledgers.ts");
  const { DELIVERY_LAG_MS } = await import("../src/server/delivery-binding.ts");
  const now = Date.now();
  for (const refusal of ["ABORT, 'unavailable'", "IGNORE"]) {
    const key = "unwritten-sdk-receipt-" + refusal;
    const fake = fakeTranscript();
    const convo = fake.conversation(key);
    const words = "verify the native receipt";
    const payload = spokenMessageText(words, { openQuestions: null, unseenReports: null });
    const attempt = claimSpoken(key, words, payload);
    const row = reserveSpokenTurn(convo, words, payload, true, attempt, now);
    assert.ok(db.retireDeliveredPendingTurn(attempt.id, attempt.revision, now, row.id));
    const native = fake.append(row.id, payload, now);
    db.openDb().exec(`CREATE TEMP TRIGGER refuse_observation BEFORE UPDATE OF message_ts ON session_spoken_turns
      BEGIN SELECT RAISE(${refusal}); END`);
    try {
      assert.equal(spokenLedger.bound(convo, [native]).rows.get(native.id)?.received, payload);
      assert.equal(db.loadSpokenTurns(key)[0]?.messageTs, null);
      assert.equal(await pruneExpiredSpokenTurns(now + 2 * DELIVERY_LAG_MS, k => k === key ? [convo.transcript] : []), 0);
      assert.equal(db.loadSpokenTurns(key)[0]?.received, payload);
      assert.equal(db.loadSpokenTurns(key)[0]?.messageTs, null);
    } finally {
      db.openDb().exec("DROP TRIGGER refuse_observation");
    }
    spokenLedger.retryDeferredBindings(convo);
    assert.equal(db.loadSpokenTurns(key)[0]?.messageTs, now);
    assert.equal(spokenLedger.bound(convo, [native]).rows.get(native.id)?.spokenWords, words);
  }
});

test("cleanup retries an unreadable prefix before deciding whether a matching terminal turn owns its disclosure", async () => {
  const { pruneExpiredSpokenTurns, reserveSpokenTurn } = await import("../src/server/delivery-ledgers.ts");
  const { DELIVERY_LAG_MS } = await import("../src/server/delivery-binding.ts");
  const now = Date.now();
  const key = "cleanup-prefix-io";
  const fake = fakeTranscript();
  fake.append("prefix", "older words", now - 1);
  const conversation = fake.conversation(key);
  const words = "inspect the boundary";
  const attempt = claimSpoken(key, words, words);
  const row = reserveSpokenTurn(conversation, words, words, false, attempt, now);
  assert.ok(db.retireDeliveredPendingTurn(attempt.id, attempt.revision, now, row.id));
  const message = fake.append("native", words, now + 1);
  const native = conversation.transcript!;
  const unavailable = { ...native, read: { ...native.read, boundary: () => null } };
  const expiry = now + 8 * DELIVERY_LAG_MS;
  await pruneExpiredSpokenTurns(expiry, k => k === key ? [unavailable] : [], now + 1);
  assert.equal(db.loadSpokenTurns(key)[0]?.id, row.id);
  assert.equal(db.loadSpokenTurns(key)[0]?.messageId, null);
  await pruneExpiredSpokenTurns(expiry, k => k === key ? [native] : [], now + 1);
  assert.equal(db.loadSpokenTurns(key)[0]?.messageId, message.id);
});

test("a rewritten terminal record that reuses a native ID cannot present an earlier spoken payload", async () => {
  const { reserveSpokenTurn, spokenLedger } = await import("../src/server/delivery-ledgers.ts");
  const { attributeTranscript } = await import("../src/server/transcript-attribution.ts");
  const { applyFeatureFlagIntent } = await import("../src/server/feature-flags/index.ts");
  applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: true });
  const fake = fakeTranscript();
  const key = "rewrite-native-id";
  const conversation = fake.conversation(key);
  const now = Date.now();
  for (const [i, words] of ["first instruction", "second instruction"].entries()) {
    const attempt = claimSpoken(key, words, words);
    const row = reserveSpokenTurn(conversation, words, words, false, attempt, now + i);
    assert.ok(db.retireDeliveredPendingTurn(attempt.id, attempt.revision, now + i, row.id));
    const message = fake.append("native-" + i, words, now + i);
    assert.equal(spokenLedger.bound(conversation, [message]).rows.get(message.id)?.id, row.id);
  }
  fake.turns[0]!.text = fake.turns[1]!.text;
  const [edited, original] = attributeTranscript(key, fake.turns, null, undefined, conversation);
  assert.equal(edited?.text, "second instruction");
  assert.equal(edited?.presentation, undefined);
  assert.deepEqual(original?.presentation, { kind: "spoken", displayText: "second instruction", received: "second instruction" });
});

test("unrelated appends do not rescan the suffix of an unmatched spoken receipt", async t => {
  const { reserveSpokenTurn, spokenLedger } = await import("../src/server/delivery-ledgers.ts");
  const { claudeTranscript } = await import("../src/server/harness/claude/transcript.ts");
  const dir = mkdtempSync(join(tmpdir(), "spoken-unmatched-appends-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const key = "unmatched-append-cost";
  const path = join(dir, key + ".jsonl");
  const now = Date.now();
  const words = "inspect the build";
  const line = (uuid: string, text: string, ts = now) => JSON.stringify({ type: "user", uuid,
    timestamp: new Date(ts).toISOString(), message: { role: "user", content: text } }) + "\n";
  writeFileSync(path, line("prefix", "handoff boundary", now - 1));
  const read = claudeTranscript.messages!;
  const conversation = { key, transcript: { path, read } };
  const attempt = claimSpoken(key, words, words);
  const row = reserveSpokenTurn(conversation, words, words, false, attempt, now);
  assert.ok(db.retireDeliveredPendingTurn(attempt.id, attempt.revision, now, row.id));
  const history = Array.from({ length: 500 }, (_, i) => line("history-" + i, "x".repeat(4096))).join("");
  appendFileSync(path, history);
  const nativeAfter = read.after.bind(read);
  let scanBytes = 0;
  t.mock.method(read, "after", (...args: Parameters<typeof read.after>) => {
    const page = nativeAfter(...args);
    scanBytes += page.end - page.start;
    return page;
  });
  for (let i = 0; i < 4; i++) {
    const from = statSync(path).size;
    appendFileSync(path, i === 2 ? line("old-words", words, now - 1) : line("new-" + i, "unrelated progress"));
    const frame = nativeAfter(path, from);
    spokenLedger.retryDeferredBindings(conversation);
    assert.equal(spokenLedger.bound(conversation, frame.messages).rows.size, 0);
  }
  t.diagnostic(`Unmatched suffix: ${Buffer.byteLength(history)} bytes. Receipt scan across four unrelated appends: ${scanBytes} bytes.`);
  assert.equal(scanBytes, 0);
  // A visible later repeat still requires the first eligible record, including one outside the page.
  appendFileSync(path, line("first-match", words));
  const beforeRepeat = statSync(path).size;
  appendFileSync(path, line("later-repeat", words));
  assert.equal(spokenLedger.bound(conversation, nativeAfter(path, beforeRepeat).messages).rows.size, 0);
  assert.equal(db.loadSpokenTurns(key)[0]?.messageId, "first-match");
});

test("a skipped terminal record prevents a later typed copy from taking the spoken receipt", async t => {
  const { reserveSpokenTurn, spokenLedger, withSpokenReadProofs, pruneExpiredSpokenTurns } = await import("../src/server/delivery-ledgers.ts");
  const { DELIVERY_LAG_MS } = await import("../src/server/delivery-binding.ts");
  const { claudeTranscript } = await import("../src/server/harness/claude/transcript.ts");
  const dir = mkdtempSync(join(tmpdir(), "spoken-skipped-record-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const key = "terminal-skipped-match";
  const path = join(dir, "transcript.jsonl");
  const now = Date.now();
  const words = "inspect the same build";
  const line = (uuid: string, padding = "") => JSON.stringify({ type: "user", uuid, padding,
    timestamp: new Date(now).toISOString(), message: { role: "user", content: words } }) + "\n";
  const native = claudeTranscript.messages!;
  const conversation = { key, transcript: { path, read: native } };
  writeFileSync(path, "");
  const claim = claimSpoken(key, words, words);
  const row = reserveSpokenTurn(conversation, words, words, false, claim, now);
  assert.ok(db.retireDeliveredPendingTurn(claim.id, claim.revision, now, row.id));
  const large = line("spoken-original", "x".repeat(17 * 1024 * 1024));
  appendFileSync(path, large + line("typed-copy"));
  const repeat = native.after(path, Buffer.byteLength(large)).messages;
  assert.equal(repeat[0]?.id, "typed-copy");
  const project = () => withSpokenReadProofs(conversation, repeat, prepared => spokenLedger.bound(prepared, repeat));
  assert.equal((await project()).rows.size, 0);
  assert.equal(db.loadSpokenTurns(key)[0]?.messageId, null);
  await pruneExpiredSpokenTurns(now + 8 * DELIVERY_LAG_MS, k => k === key ? [conversation.transcript] : [], now + 1);
  assert.equal(db.loadSpokenTurns(key)[0]?.messageId, null);

  writeFileSync(path, line("spoken-original") + line("typed-copy"));
  assert.equal((await project()).rows.size, 0);
  assert.equal(db.loadSpokenTurns(key)[0]?.messageId, "spoken-original");

  // A parser-generated ID can change between reads. Its timestamp fallback must
  // also rule out a hidden twin before displaying a disclosure on a later record.
  writeFileSync(path, large + line("typed-copy"));
  assert.equal((await project()).rows.size, 0);
  assert.equal(spokenLedger.bound(conversation, repeat).rows.size, 0);
});

test("a visible spoken match beyond a large suffix yields between pages and restarts on a concurrent rewrite", async t => {
  const { reserveSpokenTurn, spokenLedger, withSpokenReadProofs } = await import("../src/server/delivery-ledgers.ts");
  const { claudeTranscript } = await import("../src/server/harness/claude/transcript.ts");
  const dir = mkdtempSync(join(tmpdir(), "spoken-visible-scan-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const now = Date.now();
  const words = "check the logs";
  const line = (id: string, text: string) => JSON.stringify({ type: "user", uuid: id,
    timestamp: new Date(now).toISOString(), message: { role: "user", content: text } }) + "\n";
  const history = Array.from({ length: 600 }, (_, i) => line("history-" + i, "x".repeat(4096))).join("");
  const prefix = line("prefix", "previous turn");
  const native = claudeTranscript.messages!;
  for (const rewrite of [false, true]) {
    const key = "visible-scan-" + rewrite;
    const path = join(dir, key + ".jsonl");
    writeFileSync(path, prefix);
    let pages = 0;
    let serviced = 0;
    const read = { ...native, after: (...args: Parameters<typeof native.after>) => {
      const page = native.after(...args);
      if (!page.atEnd) {
        pages++;
        setImmediate(() => {
          serviced++;
          if (rewrite && serviced === 1) writeFileSync(path, prefix + history + line("new-first", words) + line("repeat", words));
        });
      }
      return page;
    } };
    const conversation = { key, transcript: { path, read } };
    const attempt = claimSpoken(key, words, words);
    const row = reserveSpokenTurn(conversation, words, words, false, attempt, now);
    assert.ok(db.retireDeliveredPendingTurn(attempt.id, attempt.revision, now, row.id));
    appendFileSync(path, history + line("old-first", words) + line("repeat", words));
    const repeat = native.after(path, Buffer.byteLength(prefix + history + line("old-first", words))).messages;
    const found = await withSpokenReadProofs(conversation, repeat, prepared => spokenLedger.bound(prepared, repeat));
    assert.equal(found.rows.size, 0, "a later visible copy cannot take the earlier receipt");
    assert.equal(db.loadSpokenTurns(key)[0]?.messageId, rewrite ? "new-first" : "old-first");
    assert.ok(pages > 5);
    assert.equal(serviced, pages, "daemon work ran between every forward and timestamp-uniqueness page");
    t.diagnostic(`Searched ${Buffer.byteLength(history)} bytes with ${serviced} interleaved callbacks (rewrite=${rewrite}).`);
  }
});

test("a rewritten transcript suffix is searched again from the confirmed spoken handoff", async t => {
  const { reserveSpokenTurn, spokenLedger } = await import("../src/server/delivery-ledgers.ts");
  const { claudeTranscript } = await import("../src/server/harness/claude/transcript.ts");
  const dir = mkdtempSync(join(tmpdir(), "spoken-rescan-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const key = "rescan-terminal";
  const path = join(dir, key + ".jsonl");
  const now = Date.now();
  const words = "red build";
  const line = (uuid: string, text: string) => JSON.stringify({ type: "user", uuid,
    timestamp: new Date(now).toISOString(), message: { role: "user", content: text } }) + "\n";
  const prefix = line("typed-before-handoff", words);
  writeFileSync(path, prefix);
  const read = claudeTranscript.messages!;
  const conversation = { key, transcript: { path, read } };
  const attempt = claimSpoken(key, words, words);
  const row = reserveSpokenTurn(conversation, words, words, false, attempt, now);
  assert.ok(db.retireDeliveredPendingTurn(attempt.id, attempt.revision, now, row.id));
  const tail = Array.from({ length: 180 }, (_, i) => line("later-" + i, "x".repeat(4000))).join("");
  appendFileSync(path, line("record", "old draft") + tail);
  const page = read.after(path, prefix.length);
  assert.ok(!page.atEnd);
  assert.equal(spokenLedger.bound(conversation, page.messages).rows.size, 0);
  const before = statSync(path).size;
  writeFileSync(path, prefix + line("record", words) + tail);
  assert.equal(statSync(path).size, before);
  const reopened = read.after(path, 0).messages;
  assert.deepEqual([...spokenLedger.bound(conversation, reopened).rows.keys()], ["record"]);
  assert.equal(db.loadSpokenTurns(key)[0]?.messageId, "record");
  // Removing the delivered record leaves only a typed twin from before the handoff.
  writeFileSync(path, prefix);
  const typed = read.after(path, 0).messages;
  const { withSpokenReadProofs } = await import("../src/server/delivery-ledgers.ts");
  assert.equal((await withSpokenReadProofs(conversation, typed, prepared => spokenLedger.bound(prepared, typed))).rows.size, 0);
  assert.equal(spokenLedger.bound(conversation, typed).rows.size, 0);
});

test("spoken binding skips future-dated matches and finds an eligible buffered turn on a later page", async () => {
  const { reserveSpokenTurn, spokenLedger } = await import("../src/server/delivery-ledgers.ts");
  const { DELIVERY_LAG_MS } = await import("../src/server/delivery-binding.ts");
  const fake = fakeTranscript();
  const key = "spoken-delayed-past-future-record";
  const convo = fake.conversation(key);
  const now = Date.now();
  const words = "inspect the red build";
  const claim = claimSpoken(key, words, words);
  const row = reserveSpokenTurn(convo, words, words, false, claim, now);
  assert.ok(db.retireDeliveredPendingTurn(claim.id, claim.revision, now, row.id));
  const future = fake.append("outside-window", words, now + DELIVERY_LAG_MS + 1);
  for (let i = 0; i < 55; i++) fake.append("output-" + i, "progress", now + DELIVERY_LAG_MS + i);
  const actual = fake.append("buffered-spoken", words, now + DELIVERY_LAG_MS);
  const result = spokenLedger.bound(convo, [future, actual], now + 2 * DELIVERY_LAG_MS);
  assert.deepEqual([...result.rows.keys()], [actual.id]);
  assert.equal(db.loadSpokenTurns(key)[0]?.messageId, actual.id);
});

test("a unique post-handoff timestamp can still identify a regenerated terminal ID", async t => {
  const { reserveSpokenTurn, spokenLedger, withSpokenReadProofs } = await import("../src/server/delivery-ledgers.ts");
  const { claudeTranscript } = await import("../src/server/harness/claude/transcript.ts");
  const dir = mkdtempSync(join(tmpdir(), "spoken-fallback-position-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "transcript.jsonl");
  const key = "terminal-regenerated-id";
  const ts = Date.now();
  const words = "inspect this build";
  const line = (uuid: string, content: string, when: number) => JSON.stringify({ type: "user", uuid,
    timestamp: new Date(when).toISOString(), message: { role: "user", content } }) + "\n";
  writeFileSync(path, line("future-clock", "before the handoff", ts + 1));
  const transcript = { path, read: claudeTranscript.messages! };
  const convo = { key, transcript };
  const claim = claimSpoken(key, words, words);
  const row = reserveSpokenTurn(convo, words, words, false, claim, ts);
  assert.ok(db.retireDeliveredPendingTurn(claim.id, claim.revision, ts, row.id));
  appendFileSync(path, line("native-id", words, ts));
  const native = transcript.read.after(path, row.transcriptOffset!).messages;
  const project = (page: typeof native) => withSpokenReadProofs(convo, page, prepared => spokenLedger.bound(prepared, page));
  assert.equal((await project(native)).rows.get("native-id")?.id, row.id);
  const regenerated = [{ ...native[0]!, id: "regenerated" }];
  assert.equal((await project(regenerated)).rows.get("regenerated")?.id, row.id);
  appendFileSync(path, line("late-twin", words, ts));
  assert.equal((await project(regenerated)).rows.size, 0);
});

test("confirmed text-only payloads in unavailable transcripts expire at the orphan cutoff without erasing SDK receipts", async () => {
  const { pruneExpiredSpokenTurns, reserveSpokenTurn, spokenLedger } = await import("../src/server/delivery-ledgers.ts");
  const { DELIVERY_LAG_MS } = await import("../src/server/delivery-binding.ts");
  const now = Date.now();
  const terminalKey = "unavailable-terminal";
  const sdkKey = "unavailable-sdk";
  const text = "inspect the build";
  for (const key of [terminalKey, sdkKey]) {
    const attempt = claimSpoken(key, text, text);
    const row = reserveSpokenTurn({ key, transcript: null }, text, text, key === sdkKey, attempt, now);
    if (key === terminalKey) assert.ok(db.retireDeliveredPendingTurn(attempt.id, attempt.revision, now, row.id));
    else {
      assert.ok(db.markPendingTurnUncertain(attempt.id, attempt.revision, "interrupted", now));
      db.clearPendingTurns(key);
    }
  }
  await pruneExpiredSpokenTurns(now + DELIVERY_LAG_MS + 1, () => [], now - 1);
  assert.equal(spokenLedger.rows(terminalKey).length, 1);
  await pruneExpiredSpokenTurns(now + 7 * DELIVERY_LAG_MS + 1, () => [], now + 1);
  assert.deepEqual(spokenLedger.rows(terminalKey), []);
  assert.equal(spokenLedger.rows(sdkKey).length, 1);
});

test("cleanup retains spoken payloads through missing, unreadable and incomplete transcripts until a verified scan", async () => {
  const { pruneExpiredSpokenTurns, reserveSpokenTurn, spokenLedger } = await import("../src/server/delivery-ledgers.ts");
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
    await pruneExpiredSpokenTurns(now, k => k === key && unavailable ? [{ path: "fake", read: unavailable }] : []);
    assert.equal(db.loadSpokenTurns(key)[0]?.received, words);
  }
  await pruneExpiredSpokenTurns(now, k => k === key ? [conversation.transcript] : []);
  assert.equal(db.loadSpokenTurns(key)[0]?.messageTs, message.ts);
  assert.equal(spokenLedger.bound(conversation, [message]).rows.get(message.id)?.received, words);
});

test("cleanup recovers an SDK receipt moved before its handoff offset by transcript replacement", async t => {
  const { pruneExpiredSpokenTurns, reserveSpokenTurn } = await import("../src/server/delivery-ledgers.ts");
  const { DELIVERY_LAG_MS } = await import("../src/server/delivery-binding.ts");
  const { claudeTranscript } = await import("../src/server/harness/claude/transcript.ts");
  const dir = mkdtempSync(join(tmpdir(), "replaced-spoken-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const words = "inspect the build";
  const now = Date.now();
  const expiry = now + DELIVERY_LAG_MS + 60_000;
  const line = (uuid: string) => JSON.stringify({ type: "user", uuid, timestamp: new Date(now).toISOString(),
    message: { role: "user", content: words } }) + "\n";
  for (const when of ["before", "during"]) {
    const key = "replaced-" + when;
    const path = join(dir, key + ".jsonl");
    const typed = line("0".repeat(36));
    writeFileSync(path, typed + typed);
    const read = claudeTranscript.messages!;
    const row = reserveSpokenTurn({ key, transcript: { path, read } }, words, words, true, claimSpoken(key, words, words), now);
    assert.equal(row.transcriptOffset, Buffer.byteLength(typed + typed));
    db.recoverSendingPendingTurns(now);
    db.clearPendingTurns(key);
    writeFileSync(path, typed + typed + typed);
    const replacement = path + ".replacement";
    writeFileSync(replacement, line(row.id) + typed + typed);
    assert.equal(statSync(replacement).size, statSync(path).size);
    if (when === "before") renameSync(replacement, path);
    const lookup = (candidate: string) => candidate === key ? [{ path, read }] : [];
    const after = read.after.bind(read);
    const scan = t.mock.method(read, "after", (...args: Parameters<typeof read.after>) => {
      const page = after(...args);
      if (when === "during") renameSync(replacement, path);
      return page;
    });
    assert.equal(await pruneExpiredSpokenTurns(expiry, lookup), 0, when);
    scan.mock.restore();
    if (when === "during") {
      assert.equal(db.loadSpokenTurns(key)[0]?.messageTs, null);
      assert.equal(await pruneExpiredSpokenTurns(expiry, lookup), 0);
    }
    assert.equal(db.loadSpokenTurns(key)[0]?.messageTs, now, when);
  }
});

test("cleanup expires unmatched spoken receipts after a stable partial JSONL tail and protects recent writes", async t => {
  const { pruneExpiredSpokenTurns, reserveSpokenTurn } = await import("../src/server/delivery-ledgers.ts");
  const { DELIVERY_LAG_MS } = await import("../src/server/delivery-binding.ts");
  const { claudeTranscript } = await import("../src/server/harness/claude/transcript.ts");
  const dir = mkdtempSync(join(tmpdir(), "spoken-partial-tail-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const key = "stable-partial";
  const path = join(dir, "turns.jsonl");
  const read = claudeTranscript.messages!;
  const source = { path, read };
  const written = Date.now();
  const sent = written - 2 * DELIVERY_LAG_MS;
  writeFileSync(path, "");
  const reserve = (words: string, sdk: boolean) => {
    const q = db.createPendingTurn({ id: words, noteKey: key, text: words, spokenWords: words, now: sent });
    const claim = db.claimNextPendingTurn(key, sent, q, text => text)!;
    const reservationId = db.recordSpokenHandoff(claim.id, claim.revision, 0, sent)!;
    const row = reserveSpokenTurn({ key, transcript: source }, words, words, sdk, { ...claim, reservationId }, sent);
    assert.ok(db.retireDeliveredPendingTurn(claim.id, claim.revision, sent, row.id));
    return row;
  };
  const sdk = reserve("sdk-missing", true);
  const terminal = reserve("terminal-missing", false);
  const observed = reserve("sdk-present", true);
  const incomplete = reserve("sdk-being-written", true);
  const record = (id: string, words: string) => JSON.stringify({ type: "user", uuid: id,
    timestamp: new Date(sent).toISOString(), message: { role: "user", content: words } });
  const complete = record(observed.id, observed.received) + "\n";
  const partial = record(incomplete.id, incomplete.received);
  writeFileSync(path, complete + partial.slice(0, -1));
  const lookup = (k: string) => k === key ? [source] : [];
  // The receipts predate the cutoff, but the writer could still finish its latest record.
  assert.equal(await pruneExpiredSpokenTurns(written + 1000, lookup), 0);
  assert.equal(db.loadSpokenTurns(key).find(r => r.id === observed.id)?.messageTs, sent);
  appendFileSync(path, partial.slice(-1) + "\n" + '{"type":');
  assert.equal(await pruneExpiredSpokenTurns(written + 2000, lookup), 0);
  assert.equal(db.loadSpokenTurns(key).find(r => r.id === incomplete.id)?.messageTs, sent);
  // The runtime exited partway through the last line. The complete records keep their
  // disclosures even after both missing payloads expire without a final newline.
  assert.equal(await pruneExpiredSpokenTurns(written + 2 * DELIVERY_LAG_MS, lookup), 2);
  const stored = db.loadSpokenTurns(key);
  assert.ok(stored.every(row => row.id !== sdk.id && row.id !== terminal.id));
  assert.deepEqual(stored.map(r => r.id).sort(), [observed.id, incomplete.id].sort());
});

test("cleanup preserves an SDK receipt in an oversized native record and observes later readable receipts", async t => {
  const { pruneExpiredSpokenTurns, reserveSpokenTurn } = await import("../src/server/delivery-ledgers.ts");
  const { DELIVERY_LAG_MS } = await import("../src/server/delivery-binding.ts");
  const { claudeTranscript } = await import("../src/server/harness/claude/transcript.ts");
  const dir = mkdtempSync(join(tmpdir(), "spoken-oversized-cleanup-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const key = "sdk-oversized-cleanup";
  const path = join(dir, "transcript.jsonl");
  writeFileSync(path, "");
  const now = Date.now();
  const source = { path, read: claudeTranscript.messages! };
  const reserve = (words: string) => {
    const claim = claimSpoken(key, words, words);
    const row = reserveSpokenTurn({ key, transcript: source }, words, words, true, claim, now);
    assert.ok(db.retireDeliveredPendingTurn(claim.id, claim.revision, now, row.id));
    return row;
  };
  const large = reserve("huge native record");
  const later = reserve("later readable receipt");
  const line = (row: typeof large, padding: string) => JSON.stringify({ type: "user", uuid: row.id, padding,
    timestamp: new Date(now).toISOString(), message: { role: "user", content: row.received } }) + "\n";
  writeFileSync(path, line(large, "x".repeat(17 * 1024 * 1024)) + line(later, ""));
  const sweep = () => pruneExpiredSpokenTurns(now + 8 * DELIVERY_LAG_MS, k => k === key ? [source] : [], now + 1);
  assert.equal(await sweep(), 0);
  const rows = db.loadSpokenTurns(key);
  assert.equal(rows.find(r => r.id === large.id)?.received, large.received);
  assert.equal(rows.find(r => r.id === later.id)?.messageTs, now);
  writeFileSync(path, line(large, "") + line(later, ""));
  await sweep();
  assert.equal(db.loadSpokenTurns(key).find(r => r.id === large.id)?.messageTs, now);
});

test("cleanup distinguishes a verified empty transcript from a failed read at byte zero", async t => {
  const { reserveSpokenTurn, pruneExpiredSpokenTurns } = await import("../src/server/delivery-ledgers.ts");
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
  const read = { ...claudeTranscript.messages!, snapshot: () => ({ size: 0, version: "stable" }) };
  const lookup = (k: string) => k === key ? [{ path, read }] : [];
  // The size probes report zero while the actual native reader cannot open the path.
  assert.equal(await pruneExpiredSpokenTurns(now, lookup), 0);
  assert.equal(db.loadSpokenTurns(key)[0]?.id, row.id);
  writeFileSync(path, "");
  assert.equal(await pruneExpiredSpokenTurns(now, lookup), 1);
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
  await registry.pruneExpiredSpokenTurns(now + DELIVERY_LAG_MS + 60_000);
  assert.equal(db.loadSpokenTurns(key)[0]?.messageTs, now);
});

test("cleanup checks live, persisted and handoff paths when a runtime moves its transcript", async t => {
  const { Registry } = await import("../src/server/registry.ts");
  const { upsertSdkSession } = await import("../src/server/sdk/store.ts");
  const { claudeTranscript, resolveTranscriptPath } = await import("../src/server/harness/claude/transcript.ts");
  const { reserveSpokenTurn } = await import("../src/server/delivery-ledgers.ts");
  const { DELIVERY_LAG_MS } = await import("../src/server/delivery-binding.ts");
  const projects = mkdtempSync(join(tmpdir(), "spoken-relocated-"));
  t.after(() => rmSync(projects, { recursive: true, force: true }));
  const cwd = "/moved";
  mkdirSync(join(projects, "-moved"));
  t.mock.method(claudeTranscript, "locate", (s: Parameters<typeof resolveTranscriptPath>[0]) => resolveTranscriptPath(s, projects));
  const now = Date.now();
  for (const location of ["live", "persisted", "handoff"]) {
    const key = "relocated-" + location;
    const id = "sdk:" + key;
    const old = join(projects, key + "-old.jsonl");
    const current = location === "persisted" ? join(projects, "-moved", key + ".jsonl") : join(projects, key + "-current.jsonl");
    writeFileSync(old, "");
    writeFileSync(current, "");
    const words = "inspect the moved build";
    const row = reserveSpokenTurn({ key, session: { agent: "claude", cwd, transcriptPath: old },
      transcript: { path: old, read: claudeTranscript.messages! } }, words, words, true, claimSpoken(key, words, words), now);
    db.recoverSendingPendingTurns(now);
    db.clearPendingTurns(key);
    writeFileSync(location === "handoff" ? old : current, JSON.stringify({ type: "user", uuid: row.id,
      timestamp: new Date(now).toISOString(), message: { role: "user", content: words } }) + "\n");
    const registry = new Registry();
    registry.applyDiscovery([]);
    if (location === "persisted") {
      upsertSdkSession({ id, agentSessionId: key, agent: "claude", cwd, taskId: null,
        model: null, effort: null, permissionMode: null, status: "exited", turnInProgress: false });
    } else {
      registry.registerSdkSession({ id, agent: "claude", name: key, cwd, agentSessionId: key });
      registry.applyDriverEvent(id, { kind: "bound", agentSessionId: key, transcriptPath: current, pid: null, modelId: null });
    }
    await registry.pruneExpiredSpokenTurns(now + DELIVERY_LAG_MS + 60_000);
    assert.equal(db.loadSpokenTurns(key)[0]?.messageTs, now, location);
  }
});

test("an evicted SDK default-path miss cannot block a verified custom archive or replace an unread custom path", async t => {
  const { Registry } = await import("../src/server/registry.ts");
  const { upsertSdkSession } = await import("../src/server/sdk/store.ts");
  const { reserveSpokenTurn } = await import("../src/server/delivery-ledgers.ts");
  const { DELIVERY_LAG_MS } = await import("../src/server/delivery-binding.ts");
  const { claudeTranscript } = await import("../src/server/harness/claude/transcript.ts");
  const dir = mkdtempSync(join(tmpdir(), "sdk-only-custom-archive-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  t.mock.method(claudeTranscript, "locate", () => null);
  const key = "only-saved-custom-path";
  const path = join(dir, "custom.jsonl");
  writeFileSync(path, "");
  const now = Date.now();
  const words = "archived missing receipt";
  const row = reserveSpokenTurn({ key, session: { agent: "claude", cwd: dir, transcriptPath: path },
    transcript: { path, read: claudeTranscript.messages! } }, words, words, true, claimSpoken(key, words, words), now);
  db.recoverSendingPendingTurns(now);
  db.clearPendingTurns(key);
  upsertSdkSession({ id: "sdk:" + key, agentSessionId: key, agent: "claude", cwd: dir, taskId: null,
    model: null, effort: null, permissionMode: null, status: "exited", turnInProgress: false });
  const registry = new Registry();
  registry.applyDiscovery([]);
  const expire = () => registry.pruneExpiredSpokenTurns(now + DELIVERY_LAG_MS + 1000);
  renameSync(path, path + ".away");
  await expire();
  assert.equal(db.loadSpokenTurns(key)[0]?.id, row.id);
  renameSync(path + ".away", path);
  await expire();
  assert.equal(db.loadSpokenTurns(key).length, 0);
});

test("after eviction cleanup searches later handoffs in the same conversation before expiring a spoken receipt", async t => {
  const { Registry } = await import("../src/server/registry.ts");
  const { claudeTranscript, resolveTranscriptPath } = await import("../src/server/harness/claude/transcript.ts");
  const { reserveSpokenTurn, spokenLedger } = await import("../src/server/delivery-ledgers.ts");
  const { DELIVERY_LAG_MS } = await import("../src/server/delivery-binding.ts");
  const dir = mkdtempSync(join(tmpdir(), "spoken-handoff-paths-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  t.mock.method(claudeTranscript, "locate", (s: Parameters<typeof resolveTranscriptPath>[0]) => resolveTranscriptPath(s, dir));
  const key = "evicted-custom-files";
  const cwd = "/archived";
  const old = join(dir, "old-custom.jsonl");
  const later = join(dir, "later-custom.jsonl");
  const unrelated = join(dir, "another-conversation.jsonl");
  for (const path of [old, later, unrelated]) writeFileSync(path, "");
  const now = Date.now();
  const expireAt = now + DELIVERY_LAG_MS + 1000;
  const reserve = (key: string, path: string, words: string, at: number) => {
    const attempt = claimSpoken(key, words, words);
    const row = reserveSpokenTurn({ key, session: { agent: "claude", cwd, transcriptPath: path },
      transcript: { path, read: claudeTranscript.messages! } }, words, words, true, attempt, at);
    assert.ok(db.retireDeliveredPendingTurn(attempt.id, attempt.revision, at, row.id));
    return row;
  };
  const moved = reserve(key, old, "inspect the moved receipt", now);
  const absent = reserve(key, old, "inspect the missing receipt", now);
  const duringSweep = reserve(key, old, "a receipt during cleanup", now);
  const recent = reserve(key, later, "a later handoff", expireAt - 1);
  reserve("another-key", unrelated, "another conversation", expireAt - 1);
  const native = (row: typeof moved) => JSON.stringify({ type: "user", uuid: row.id, timestamp: new Date(now).toISOString(),
    message: { role: "user", content: row.received } }) + "\n";
  writeFileSync(later, native(moved));
  writeFileSync(unrelated, native(absent));
  db.closeDb();
  spokenLedger.forgetCaches();
  const registry = new Registry();
  registry.applyDiscovery([]);
  mkdirSync(join(dir, "-archived"));
  writeFileSync(join(dir, "-archived", key + ".jsonl"), "");
  renameSync(later, later + ".away");
  await registry.pruneExpiredSpokenTurns(expireAt);
  assert.ok(db.loadSpokenTurns(key).some(row => row.id === moved.id), "a readable default cannot stand in for a missing custom file");
  renameSync(later + ".away", later);
  // Make both custom paths fresh reads. An unchanged SDK-only file can reuse its last scan.
  appendFileSync(old, "\n");
  // The writer can append a receipt to an already scanned file while the sweep reads a sibling.
  let firstPath = "";
  let appended = false;
  const read = claudeTranscript.messages!;
  const after = read.after.bind(read);
  const walk = t.mock.method(read, "after", (...args: Parameters<typeof read.after>) => {
    if (args[0] === old || args[0] === later) {
      firstPath ||= args[0];
      if (!appended && args[0] !== firstPath) {
        appendFileSync(firstPath, native(duringSweep));
        appended = true;
      }
    }
    return after(...args);
  });
  await registry.pruneExpiredSpokenTurns(expireAt);
  walk.mock.restore();
  assert.ok(appended);
  assert.ok(db.loadSpokenTurns(key).some(row => row.id === duringSweep.id), "a changed file defers deletion");
  await registry.pruneExpiredSpokenTurns(expireAt);
  const rows = db.loadSpokenTurns(key);
  assert.equal(rows.find(row => row.id === moved.id)?.messageTs, now, "the later custom file contains this UUID");
  assert.equal(rows.find(row => row.id === duringSweep.id)?.messageTs, now, "the next sweep observes the concurrent append");
  assert.equal(rows.some(row => row.id === absent.id), false, "a UUID in another conversation cannot preserve this row");
  assert.ok(rows.some(row => row.id === recent.id), "the later handoff itself is still inside its receipt window");
});

test("archived cleanup binds only spoken receipts and preserves native turns claimed by other senders", async () => {
  const { delegatedLedger, reviewLedger, spokenLedger, pruneExpiredSpokenTurns, reserveSpokenTurn } = await import("../src/server/delivery-ledgers.ts");
  const { reserveReviewDelivery } = await import("../src/server/review-deliveries.ts");
  const { wrapReviewEnvelope } = await import("../src/shared/review-message-envelope.ts");
  const { DELIVERY_LAG_MS } = await import("../src/server/delivery-binding.ts");
  const key = "archived-path-claims";
  const live = fakeTranscript();
  const archived = fakeTranscript();
  const current = live.conversation(key);
  const old = { key, transcript: { ...archived.conversation(key).transcript!, path: "archived" } };
  const now = Date.now();
  const delegate = (words: string) => delegatedLedger.reserve(current, words, base => ({
    ...base, controllerId: "controller", controllerName: "Steve",
  }), now);
  delegate("already delivered");
  const claimed = live.append("previous-claim", "already delivered", now);
  assert.ok(delegatedLedger.bound(current, [claimed]).rows.has(claimed.id));
  const delegated = delegate("a delegated turn");
  const review = wrapReviewEnvelope("answer", ["b99fa7da-f9dd-4bab-9e44-691bac441a4c"], "a review answer");
  const reviewId = reserveReviewDelivery(current, review, undefined, now)!;
  const words = "a spoken instruction";
  const attempt = claimSpoken(key, words, words);
  const spoken = reserveSpokenTurn(old, words, words, false, attempt, now);
  assert.ok(db.retireDeliveredPendingTurn(attempt.id, attempt.revision, now, spoken.id));
  archived.append(claimed.id, words, now);
  archived.append("old-delegated", "a delegated turn", now);
  archived.append("old-review", review, now);
  archived.append("actual-spoken", words, now);
  await pruneExpiredSpokenTurns(now + 2 * DELIVERY_LAG_MS, k => k === key ? [old.transcript] : []);
  assert.equal(spokenLedger.rows(key)[0]?.messageId, "actual-spoken");
  assert.equal(delegatedLedger.rows(key).find(r => r.id === delegated.id)?.messageId, null);
  assert.equal(reviewLedger.rows(key).find(r => r.id === reviewId)?.messageId, null);
  const liveDelegated = live.append("live-delegated", "a delegated turn", now);
  const liveReview = live.append("live-review", review, now);
  assert.equal(delegatedLedger.bound(current, [liveDelegated]).rows.get(liveDelegated.id)?.id, delegated.id);
  assert.equal(reviewLedger.bound(current, [liveReview]).rows.get(liveReview.id)?.id, reviewId);
});

test("hourly SDK cleanup yields between pages and reuses only complete scans of the same revision and receipt IDs", async t => {
  const { reserveSpokenTurn, pruneExpiredSpokenTurns } = await import("../src/server/delivery-ledgers.ts");
  const { DELIVERY_LAG_MS } = await import("../src/server/delivery-binding.ts");
  const key = "paged-cleanup";
  const fake = fakeTranscript();
  const conversation = fake.conversation(key);
  const source = conversation.transcript!;
  const now = Date.now();
  const reserve = (words: string) => {
    const attempt = claimSpoken(key, words, words);
    const row = reserveSpokenTurn(conversation, words, words, true, attempt, now);
    assert.ok(db.retireDeliveredPendingTurn(attempt.id, attempt.revision, now, row.id));
    return row;
  };
  reserve("unobserved SDK handoff");
  for (let n = 0; n < 160; n++) fake.append("other-" + n, "unrelated record", now);
  const original = source.read.after.bind(source.read);
  let pages = 0;
  let allowedNextPage = true;
  t.mock.method(source.read, "after", (...args: Parameters<typeof original>) => {
    assert.ok(allowedNextPage, "the daemon ran another event between pages");
    pages++;
    allowedNextPage = false;
    setImmediate(() => { allowedNextPage = true; });
    return original(...args);
  });
  let missingSibling = true;
  const lookup = (candidate: string) => candidate !== key ? [] : missingSibling ? [source, null] : [source];
  const sweep = () => pruneExpiredSpokenTurns(now + 2 * DELIVERY_LAG_MS, lookup);
  assert.equal(await sweep(), 0);
  assert.equal(pages, 4);
  assert.equal(await sweep(), 0);
  assert.equal(pages, 4, "a missing sibling did not rescan unchanged history");
  const later = reserve("a newly eligible SDK handoff");
  await sweep();
  assert.equal(pages, 8, "a new UUID gets its own scan");
  fake.append(later.id, later.received, now);
  missingSibling = false;
  assert.equal(await sweep(), 1);
  assert.equal(pages, 12);
  assert.deepEqual(db.loadSpokenTurns(key).map(row => [row.id, row.messageTs]), [[later.id, now]]);
});

test("hourly terminal cleanup prepares handoff proofs off-thread and retries a changed revision before binding", async t => {
  const { prepareSpokenTranscript, reserveSpokenHandoff, pruneExpiredSpokenTurns } = await import("../src/server/delivery-ledgers.ts");
  const { DELIVERY_LAG_MS } = await import("../src/server/delivery-binding.ts");
  const { claudeTranscript } = await import("../src/server/harness/claude/transcript.ts");
  const dir = mkdtempSync(join(tmpdir(), "spoken-archive-worker-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "archive.jsonl");
  writeFileSync(path, JSON.stringify({ padding: "x".repeat(2 * 1024 * 1024) }) + "\n");
  const now = Date.now();
  const key = "cleanup-proof-worker";
  const read = claudeTranscript.messages!;
  const source = { path, read };
  const words = "inspect the archive";
  const pending = db.createPendingTurn({ id: key, noteKey: key, text: words, spokenWords: words, now });
  const claim = db.claimNextPendingTurn(key, now, pending, text => text)!;
  const prepared = await prepareSpokenTranscript(key, source, claim.text);
  const row = reserveSpokenHandoff({ key, transcript: source }, claim, words, false, 0, now, prepared)!;
  assert.ok(db.retireDeliveredPendingTurn(claim.id, claim.revision, now, row.id));
  appendFileSync(path, JSON.stringify({ type: "user", uuid: "native-archive", timestamp: new Date(now).toISOString(),
    message: { role: "user", content: words } }) + "\n");
  const native = read as Required<Pick<typeof read, "boundary" | "prepareHandoffBoundaries">>;
  const sync = t.mock.method(native, "boundary");
  const prepare = native.prepareHandoffBoundaries.bind(native);
  let change = true;
  const worker = t.mock.method(native, "prepareHandoffBoundaries", async (...args: Parameters<typeof prepare>) => {
    const result = await prepare(...args);
    if (change) appendFileSync(path, "{}\n");
    return result;
  });
  const sweep = () => pruneExpiredSpokenTurns(now + 2 * DELIVERY_LAG_MS, k => k === key ? [source] : []);
  await sweep();
  assert.equal(db.loadSpokenTurns(key)[0]?.messageId, null, "a changed capture deferred cleanup");
  change = false;
  await sweep();
  assert.equal(db.loadSpokenTurns(key)[0]?.messageId, "native-archive");
  assert.equal(worker.mock.callCount(), 2);
  for (const call of worker.mock.calls) assert.deepEqual(call.arguments, [path, [row.transcriptOffset], false]);
  assert.equal(sync.mock.callCount(), 0);
});

test("cleanup reopens an evicted terminal's native transcript before expiring its unread disclosure", async t => {
  const { Registry } = await import("../src/server/registry.ts");
  const { claudeTranscript, resolveTranscriptPath } = await import("../src/server/harness/claude/transcript.ts");
  const { prepareSpokenTranscript, reserveSpokenHandoff, spokenLedger } = await import("../src/server/delivery-ledgers.ts");
  const { DELIVERY_LAG_MS } = await import("../src/server/delivery-binding.ts");
  const dir = mkdtempSync(join(tmpdir(), "spoken-archived-terminal-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cwd = "/archived-terminal";
  mkdirSync(join(dir, "-archived-terminal"));
  t.mock.method(claudeTranscript, "locate", (s: Parameters<typeof resolveTranscriptPath>[0]) => resolveTranscriptPath(s, dir));
  const now = Date.now() - 1000;
  for (const late of [false, true]) {
    const key = late ? "native-terminal-late" : "native-terminal-custom-path";
    const path = late ? join(dir, "-archived-terminal", key + ".jsonl") : join(dir, "outside-default-layout.jsonl");
    if (!late) writeFileSync(path, "");
    const transcript = late ? null : { path, read: claudeTranscript.messages! };
    const words = "check the receipt";
    const payload = spokenMessageText(words, { openQuestions: null, unseenReports: null });
    const q = db.createPendingTurn({ id: key + "-queued", noteKey: key, spokenWords: words, text: words, now });
    const turn = db.claimNextPendingTurn(key, now, q, () => payload)!;
    const conversation = { key, transcript, session: { agent: "claude" as const, cwd, transcriptPath: null } };
    const prepared = transcript ? await prepareSpokenTranscript(key, transcript, turn.text) : undefined;
    const row = reserveSpokenHandoff(conversation, turn, words, false, 0, now, prepared)!;
    assert.ok(db.retireDeliveredPendingTurn(turn.id, turn.revision, now, row.id));
    appendFileSync(path, JSON.stringify({ type: "user", uuid: "native-" + key, timestamp: new Date(now + 1000).toISOString(),
      message: { role: "user", content: payload } }) + "\n");
    db.closeDb();
    spokenLedger.forgetCaches();
    const registry = new Registry();
    registry.applyDiscovery([]);
    await registry.pruneExpiredSpokenTurns(now + 8 * DELIVERY_LAG_MS, now + DELIVERY_LAG_MS);
    const archived = db.loadSpokenTurns(key)[0];
    assert.equal(archived?.messageId, "native-" + key);
    assert.equal(archived?.received, payload);
  }
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

test("upgrade preserves SDK client receipts and leaves legacy text bindings without a prefix undecorated", async () => {
  const { spokenLedger } = await import("../src/server/delivery-ledgers.ts");
  const { injectionFingerprint } = await import("../src/server/injections.ts");
  const key = "legacy-attempt";
  const text = "check the build";
  const now = Date.now();
  db.openDb().exec(`ALTER TABLE session_spoken_turns DROP COLUMN outbox_turn_id;
    ALTER TABLE session_spoken_turns DROP COLUMN outbox_revision;
    ALTER TABLE session_spoken_turns DROP COLUMN transcript_boundary;
    ALTER TABLE session_spoken_turns DROP COLUMN transcript_agent;
    ALTER TABLE session_spoken_turns DROP COLUMN transcript_cwd;
    ALTER TABLE session_spoken_turns DROP COLUMN transcript_path;`);
  const insert = db.openDb().prepare(`INSERT INTO session_spoken_turns
    (id, note_key, fingerprint, spoken_words, received, delivered_at, transcript_offset, message_id)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?)`);
  for (const [id, nativeId] of [["anchored", "anchored"], ["terminal", "native-terminal"], ["orphan", null]] as const) {
    insert.run(id, key, injectionFingerprint(text), text, text, now, nativeId);
  }
  db.closeDb();
  const transcript = fakeTranscript();
  const typed = transcript.append("typed", text, now);
  const anchored = transcript.append("anchored", text, now + 1);
  const oldTerminal = transcript.append("native-terminal", text, now + 2);
  const bound = spokenLedger.bound(transcript.conversation(key), [typed, anchored, oldTerminal]);
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
