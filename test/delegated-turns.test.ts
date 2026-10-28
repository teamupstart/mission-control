import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptMessage } from "../src/shared/types.ts";
import { fakeTranscript } from "./helpers/fake-transcript.ts";

const home = mkdtempSync(join(tmpdir(), "mission-delegated-turns-"));
process.env.HARNESS_HOME = home;
const { delegatedTurnSources, forgetDelegatedTurnCache, noteOtherSend, pruneDelegatedTurns, releaseDelegatedTurn, rememberedOtherSendKeys, reserveDelegatedTurn, withdrawOtherSend } =
  await import("../src/server/delegated-turns.ts");
const { openDb } = await import("../src/server/db.ts");
const { attributeTranscript } = await import("../src/server/transcript-attribution.ts");
const { forgetInjections, recordInjection } = await import("../src/server/injections.ts");
after(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => { openDb().exec("DELETE FROM session_delegated_turns"); forgetDelegatedTurnCache(); });

const first = { id: "sdk:first", name: "First" };
const second = { id: "sdk:second", name: "Second" };
const LAG = 24 * 60 * 60_000;
let serial = 0;
const key = () => `conv-${++serial}`;
const senders = (conversation: ReturnType<ReturnType<typeof fakeTranscript>["conversation"]>, page: TranscriptMessage[]) => {
  const { sources } = delegatedTurnSources(conversation, page);
  return page.map((m) => sources.get(m.id)?.id ?? null);
};

test("a released delivery claims no turn", () => {
  const t = fakeTranscript(); const k = key();
  const id = reserveDelegatedTurn(t.conversation(k), "refused words", first, 1_000);
  releaseDelegatedTurn(k, id);
  const turn = t.append("m", "refused words", 1_500);
  const { sources, contested } = delegatedTurnSources(t.conversation(k), [turn]);
  assert.equal(sources.size, 0);
  assert.equal(contested.size, 0, "no row is left, so the text is not known as delegated");
});

test("an operator turn written just before the delivery is never its turn", () => {
  const t = fakeTranscript(); const k = key();
  // The operator types the words a moment before a controller sends the same ones.
  const operator = t.append("operator", "ship it", 10_000);
  reserveDelegatedTurn(t.conversation(k), "ship it", first, 10_001);
  const controller = t.append("controller", "ship it", 10_002);
  // First read holds both turns.
  assert.deepEqual(senders(t.conversation(k), [operator, controller]), [null, first.id]);
});

test("a page holding only a later operator repeat leaves the delivery's own turn its own", () => {
  const t = fakeTranscript(); const k = key();
  reserveDelegatedTurn(t.conversation(k), "rebase", first, 1_000);
  const controller = t.append("controller", "rebase", 1_100);
  for (let i = 0; i < 120; i++) t.append(`filler-${i}`, `other ${i}`, 2_000 + i);
  const operator = t.append("operator", "rebase", 9_000);
  // Nobody read the controller's turn; this first read is a page with only the repeat.
  assert.deepEqual(senders(t.conversation(k), [operator]), [null]);
  assert.deepEqual(senders(t.conversation(k), [controller]), [first.id]);
});

test("identical deliveries from two controllers both unwritten credit neither, whichever lands first", () => {
  for (const bFirst of [true, false]) {
    const t = fakeTranscript(); const k = key(); const now = Date.now();
    reserveDelegatedTurn(t.conversation(k), "same words", first, now);
    reserveDelegatedTurn(t.conversation(k), "same words", second, now);
    const [x, y] = bFirst ? ["b", "a"] : ["a", "b"];
    const page = [t.append(x, "same words", now + 1), t.append(y, "same words", now + 2)];
    assert.deepEqual(senders(t.conversation(k), page), [null, null]);
    forgetDelegatedTurnCache();
    assert.deepEqual(senders(t.conversation(k), page), [null, null]);
  }
});

test("one controller sending the same words twice keeps both labels", () => {
  const t = fakeTranscript(); const k = key(); const now = Date.now();
  reserveDelegatedTurn(t.conversation(k), "again", first, now);
  reserveDelegatedTurn(t.conversation(k), "again", first, now);
  const page = [t.append("one", "again", now + 1), t.append("two", "again", now + 2)];
  assert.deepEqual(senders(t.conversation(k), page), [first.id, first.id]);
});

test("a second controller's identical send after the first one's turn landed keeps both labels", () => {
  const t = fakeTranscript(); const k = key(); const now = Date.now();
  reserveDelegatedTurn(t.conversation(k), "relay", first, now);
  const a = t.append("a", "relay", now + 1);
  reserveDelegatedTurn(t.conversation(k), "relay", second, now + 2);
  const b = t.append("b", "relay", now + 3);
  assert.deepEqual(senders(t.conversation(k), [a, b]), [first.id, second.id]);
});

test("a rival controller's delivery that provably did not land stops contesting the other", () => {
  const t = fakeTranscript(); const k = key(); const now = Date.now();
  reserveDelegatedTurn(t.conversation(k), "solo after all", first, now);
  releaseDelegatedTurn(k, reserveDelegatedTurn(t.conversation(k), "solo after all", second, now + 1));
  const a = t.append("a", "solo after all", now + 2);
  assert.deepEqual(senders(t.conversation(k), [a]), [first.id]);
});

test("identical turns sharing a timestamp never borrow each other's sender", () => {
  const t = fakeTranscript(); const k = key();
  reserveDelegatedTurn(t.conversation(k), "twin", first, 1_000);
  const a = t.append("a", "twin", 1_234);
  // The second controller sends once the first one's turn is in the transcript.
  reserveDelegatedTurn(t.conversation(k), "twin", second, 1_100);
  const b = t.append("b", "twin", 1_234);
  assert.deepEqual(senders(t.conversation(k), [a, b]), [first.id, second.id]);
  // A later read answers by exact id, whatever the shared timestamp would suggest.
  forgetDelegatedTurnCache();
  assert.deepEqual(senders(t.conversation(k), [b, a]), [second.id, first.id]);
  // Re-synthesized ids with a shared timestamp are ambiguous, so neither guesses.
  const twins = [{ ...a, id: "a2" }, { ...b, id: "b2" }];
  assert.deepEqual(senders(t.conversation(k), twins), [null, null]);
});

test("a re-synthesized id still finds its sender when its timestamp is unambiguous", () => {
  const t = fakeTranscript(); const k = key();
  reserveDelegatedTurn(t.conversation(k), "same", first, 1_000);
  const a = t.append("a", "same", 1_200);
  assert.deepEqual(senders(t.conversation(k), [a]), [first.id]);
  forgetDelegatedTurnCache();
  assert.deepEqual(senders(t.conversation(k), [{ ...a, id: "a-reread" }]), [first.id]);
});

test("a page holding only a same-millisecond operator repeat never borrows the controller's sender", () => {
  const t = fakeTranscript(); const k = key();
  reserveDelegatedTurn(t.conversation(k), "echo", first, 1_000);
  const controller = t.append("controller", "echo", 1_234);
  // Bound while the conversation is read live.
  assert.deepEqual(senders(t.conversation(k), [controller]), [first.id]);
  // The operator repeats the words in the same millisecond; a later history page holds only that.
  const operator = t.append("operator", "echo", 1_234);
  t.append("after", "something else", 1_300);
  forgetDelegatedTurnCache();
  assert.deepEqual(senders(t.conversation(k), [operator]), [null]);
  // A re-read of the controller's own turn under a new id is now ambiguous too, so it guesses nothing.
  assert.deepEqual(senders(t.conversation(k), [{ ...controller, id: "controller-reread" }]), [null]);
  // Its native id still answers exactly.
  assert.deepEqual(senders(t.conversation(k), [controller, operator]), [first.id, null]);
});

test("without the transcript there is no timestamp fallback", () => {
  const t = fakeTranscript(); const k = key();
  reserveDelegatedTurn(t.conversation(k), "solo", first, 1_000);
  const a = t.append("a", "solo", 1_200);
  assert.deepEqual(senders(t.conversation(k), [a]), [first.id]);
  const { sources } = delegatedTurnSources({ key: k, transcript: null }, [{ ...a, id: "a-reread" }]);
  assert.equal(sources.size, 0);
});

test("a delivery's turn may land up to a day after it, and no later", () => {
  const sent = 1_000_000_000;
  const claims = (ts: number) => {
    const t = fakeTranscript(); const k = key();
    reserveDelegatedTurn(t.conversation(k), "boundary", first, sent);
    const turn = t.append("turn", "boundary", ts);
    return senders(t.conversation(k), [turn])[0];
  };
  assert.equal(claims(sent), first.id);
  assert.equal(claims(sent + LAG), first.id);
  assert.equal(claims(sent + LAG + 1), null);
});

test("a delivery whose turn has not been written yet binds when it appears", () => {
  const t = fakeTranscript(); const k = key();
  const sent = Date.now();
  reserveDelegatedTurn(t.conversation(k), "queued", first, sent);
  const busy = t.append("busy", "still working", sent + 100);
  assert.deepEqual(senders(t.conversation(k), [busy]), [null]);
  const queued = t.append("queued", "queued", sent + 60_000);
  assert.deepEqual(senders(t.conversation(k), [busy, queued]), [null, first.id]);
});

test("a cold cache does not count a new delivery twice", () => {
  const t = fakeTranscript(); const k = key();
  forgetDelegatedTurnCache();
  reserveDelegatedTurn(t.conversation(k), "once", first, 1_000);
  const a = t.append("a", "once", 1_100);
  const b = t.append("b", "once", 1_200);
  assert.deepEqual(senders(t.conversation(k), [a, b]), [first.id, null]);
});

test("pruning spares live conversations, does nothing when liveness is unknown, and clears all when none are live", () => {
  const t = fakeTranscript();
  reserveDelegatedTurn(t.conversation("live"), "a", first, 1);
  reserveDelegatedTurn(t.conversation("gone"), "b", first, 1);
  const a = t.append("x", "a", 2);
  const b = t.append("y", "b", 3);
  assert.equal(pruneDelegatedTurns(null, 10), 0);
  assert.equal(pruneDelegatedTurns(["live"], 10), 1);
  assert.deepEqual(senders(t.conversation("live"), [a]), [first.id]);
  assert.deepEqual(senders(t.conversation("gone"), [b]), [null]);
});

test("an operator send while the delegated turn is unwritten contests it, whichever turn lands first", () => {
  for (const humanFirst of [true, false]) {
    const t = fakeTranscript(); const k = key(); const now = Date.now();
    reserveDelegatedTurn(t.conversation(k), "race", first, now);
    noteOtherSend(t.conversation(k), "race", now + 1);
    const [a, b] = humanFirst ? ["human", "controller"] : ["controller", "human"];
    const page = [t.append(a, "race", now + 2), t.append(b, "race", now + 3)];
    assert.deepEqual(senders(t.conversation(k), page), [null, null]);
    // Persisted: a restart does not bind it after all.
    forgetDelegatedTurnCache();
    assert.deepEqual(senders(t.conversation(k), page), [null, null]);
  }
});

test("a delegated send that starts while an operator send is in flight is contested", () => {
  const t = fakeTranscript(); const k = key(); const now = Date.now();
  noteOtherSend(t.conversation(k), "overlap", now);
  reserveDelegatedTurn(t.conversation(k), "overlap", first, now + 1);
  const page = [t.append("human", "overlap", now + 2), t.append("controller", "overlap", now + 3)];
  assert.deepEqual(senders(t.conversation(k), page), [null, null]);
});

test("an operator send that already landed, or one after the delegated turn landed, contests nothing", () => {
  const t = fakeTranscript(); const k = key(); const now = Date.now();
  noteOtherSend(t.conversation(k), "settled", now);
  const earlier = t.append("earlier", "settled", now + 1);
  reserveDelegatedTurn(t.conversation(k), "settled", first, now + 2);
  const controller = t.append("controller", "settled", now + 3);
  // The operator repeats the words after the controller's turn was written, before any read.
  noteOtherSend(t.conversation(k), "settled", now + 4);
  const later = t.append("later", "settled", now + 5);
  assert.deepEqual(senders(t.conversation(k), [earlier, controller, later]), [null, first.id, null]);
});

test("a contested delivery stays unbound when another delivery binds in the same pass", () => {
  const t = fakeTranscript(); const k = key(); const now = Date.now();
  reserveDelegatedTurn(t.conversation(k), "raced", first, now);
  noteOtherSend(t.conversation(k), "raced", now + 1);
  reserveDelegatedTurn(t.conversation(k), "clean", second, now + 2);
  const page = [t.append("human", "raced", now + 3), t.append("controller", "raced", now + 4), t.append("clean", "clean", now + 5)];
  assert.deepEqual(senders(t.conversation(k), page), [null, null, second.id]);
});

test("a contested delivery's landed turn is never counted as the operator's", () => {
  const t = fakeTranscript(); const k = key(); const now = Date.now();
  reserveDelegatedTurn(t.conversation(k), "busy words", first, now);
  noteOtherSend(t.conversation(k), "busy words", now + 1);
  const a = t.append("controller-a", "busy words", now + 2);
  // The operator's send is still in flight when a second controller sends the same words.
  reserveDelegatedTurn(t.conversation(k), "busy words", second, now + 3);
  const human = t.append("human", "busy words", now + 4);
  const b = t.append("controller-b", "busy words", now + 5);
  assert.deepEqual(senders(t.conversation(k), [a, human, b]), [null, null, null]);
});

test("a withdrawn operator send restores the delivery it contested", () => {
  const t = fakeTranscript(); const k = key(); const now = Date.now();
  reserveDelegatedTurn(t.conversation(k), "retry", first, now);
  withdrawOtherSend(noteOtherSend(t.conversation(k), "retry", now + 1));
  const controller = t.append("controller", "retry", now + 2);
  assert.deepEqual(senders(t.conversation(k), [controller]), [first.id]);
});

test("withdrawing one operator send keeps the contest while another of the same words remains", () => {
  const t = fakeTranscript(); const k = key(); const now = Date.now();
  reserveDelegatedTurn(t.conversation(k), "twice", first, now);
  noteOtherSend(t.conversation(k), "twice", now + 1);
  withdrawOtherSend(noteOtherSend(t.conversation(k), "twice", now + 2));
  const page = [t.append("human", "twice", now + 3), t.append("controller", "twice", now + 4)];
  assert.deepEqual(senders(t.conversation(k), page), [null, null]);
});

test("a delivery whose send boundary could not be read is never bound, even from byte zero", () => {
  const t = fakeTranscript(); const k = key(); const now = Date.now();
  const older = t.append("older", "same ask", now - 60_000);
  t.failSize(true);
  reserveDelegatedTurn(t.conversation(k), "same ask", first, now);
  t.failSize(false);
  const controller = t.append("controller", "same ask", now + 1);
  assert.deepEqual(senders(t.conversation(k), [older, controller]), [null, null]);
  // Withdrawing an unrelated send never makes it bindable.
  withdrawOtherSend(noteOtherSend(t.conversation(k), "same ask", now + 2));
  forgetDelegatedTurnCache();
  assert.deepEqual(senders(t.conversation(k), [older, controller]), [null, null]);
});

test("withdrawing an operator send keeps a contest that rival controllers caused", () => {
  const t = fakeTranscript(); const k = key(); const now = Date.now();
  reserveDelegatedTurn(t.conversation(k), "contended", first, now);
  reserveDelegatedTurn(t.conversation(k), "contended", second, now);
  withdrawOtherSend(noteOtherSend(t.conversation(k), "contended", now + 1));
  const page = [t.append("b", "contended", now + 2), t.append("a", "contended", now + 3)];
  assert.deepEqual(senders(t.conversation(k), page), [null, null]);
});

test("remembered sends expire after the race window, across every message", () => {
  const t = fakeTranscript(); const k = key(); const start = Date.now();
  for (let i = 0; i < 50; i++) noteOtherSend(t.conversation(k), `distinct message ${i}`, start);
  assert.equal(rememberedOtherSendKeys(), 50);
  // A day and a bit later, one unrelated send sweeps every expired entry.
  noteOtherSend(t.conversation(k), "a new message", start + LAG + 61_000);
  assert.equal(rememberedOtherSendKeys(), 1);
});

test("a delivery reserved before its target's transcript was located is never bound", () => {
  const t = fakeTranscript(); const k = key(); const now = Date.now();
  const older = t.append("older", "located late", now - 60_000);
  // No transcript could be located when the controller sent.
  reserveDelegatedTurn({ key: k, transcript: null }, "located late", first, now);
  const controller = t.append("controller", "located late", now + 1);
  // Once it is, an older operator turn with the same words is never taken for the delivery.
  assert.deepEqual(senders(t.conversation(k), [older, controller]), [null, null]);
});

test("pruning another conversation keeps this conversation's in-flight sends", () => {
  const t = fakeTranscript(); const k = key(); const now = Date.now();
  noteOtherSend(t.conversation(k), "still racing", now);
  reserveDelegatedTurn(fakeTranscript().conversation("stale-conversation"), "old", first, now - 10 * LAG);
  assert.equal(pruneDelegatedTurns([k], now - LAG), 1);
  // The operator's send is still in flight, so a controller sending the same words is contested.
  reserveDelegatedTurn(t.conversation(k), "still racing", first, now + 1);
  const page = [t.append("human", "still racing", now + 2), t.append("controller", "still racing", now + 3)];
  assert.deepEqual(senders(t.conversation(k), page), [null, null]);
});

test("once every session has exited, old rows of finished conversations are pruned", () => {
  const now = Date.now();
  reserveDelegatedTurn(fakeTranscript().conversation("finished-a"), "a", first, now - 10 * LAG);
  reserveDelegatedTurn(fakeTranscript().conversation("finished-b"), "b", first, now - 10 * LAG);
  reserveDelegatedTurn(fakeTranscript().conversation("recent"), "c", first, now);
  // A known-empty live set: the registry swept and no session remains.
  assert.equal(pruneDelegatedTurns([], now - LAG), 2);
  const t = fakeTranscript();
  const recent = t.append("recent-turn", "c", now + 1);
  assert.deepEqual(senders(t.conversation("recent"), [recent]), [first.id]);
});

test("a contested turn carries no live label either, Foreman's included", () => {
  forgetInjections();
  const t = fakeTranscript(); const k = key(); const now = Date.now();
  reserveDelegatedTurn(t.conversation(k), "deploy now", first, now);
  // Foreman injects the same words while the controller's message is still on its way.
  noteOtherSend(t.conversation(k), "deploy now", now + 1);
  recordInjection("target-session", "deploy now", "foreman");
  const page = [t.append("one", "deploy now", now + 2), t.append("two", "deploy now", now + 3)];
  const read = attributeTranscript("target-session", page, null, undefined, t.conversation(k));
  assert.deepEqual(read.map((m) => [m.origin, m.originSession?.id]), [[undefined, undefined], [undefined, undefined]]);
});

test("a later Foreman message whose words have no unresolved delivery keeps its label", () => {
  forgetInjections();
  const t = fakeTranscript(); const k = key(); const now = Date.now();
  reserveDelegatedTurn(t.conversation(k), "status?", first, now);
  const controller = t.append("controller", "status?", now + 1);
  assert.deepEqual(senders(t.conversation(k), [controller]), [first.id]);
  recordInjection("target-session-2", "status?", "foreman");
  const foreman = t.append("foreman", "status?", now + 60_000);
  const read = attributeTranscript("target-session-2", [controller, foreman], null, undefined, t.conversation(k));
  assert.deepEqual(read.map((m) => [m.origin, m.originSession?.id]), [["session", first.id], ["foreman", undefined]]);
});

test("a delivery whose located transcript file was missing at send is never bound", () => {
  const t = fakeTranscript(); const k = key(); const now = Date.now();
  const older = t.append("older", "vanished file", now - 60_000);
  t.failSize("missing");
  reserveDelegatedTurn(t.conversation(k), "vanished file", first, now);
  t.failSize(false);
  const controller = t.append("controller", "vanished file", now + 1);
  assert.deepEqual(senders(t.conversation(k), [older, controller]), [null, null]);
});
