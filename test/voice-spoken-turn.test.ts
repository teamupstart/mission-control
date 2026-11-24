import assert from "node:assert/strict";
import test from "node:test";
import * as db from "../src/server/db.ts";
import { VOICE_TURN_PREFIX, openQuestionsNote, spokenMessageText } from "../src/shared/voice-delivery.ts";
import { claimHumanEcho, expectHumanEcho } from "../src/server/injections.ts";
import type { TurnDelivered } from "../src/server/registry.ts";
import { fakeTranscript } from "./helpers/fake-transcript.ts";

test("upgrade from 51 leaves typed rows untouched, and spoken composition survives restart and retry", () => {
  const key = "conversation";
  const words = "check the build";
  const typed = db.createPendingTurn({ id: "typed", noteKey: key, text: words, now: 1 });
  db.openDb().exec(`
    ALTER TABLE pending_turns DROP COLUMN spoken_words;
    ALTER TABLE pending_turns DROP COLUMN composed_at;
    ALTER TABLE pending_turns DROP COLUMN spoken_handoff_key;
    ALTER TABLE pending_turns DROP COLUMN spoken_handoff_generation;
    ALTER TABLE session_work_cycles DROP COLUMN spoken_hold;
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
  const reserve = () => spokenLedger.reserve(conversation, received, base => ({ ...base, spokenWords, received }), now);
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
