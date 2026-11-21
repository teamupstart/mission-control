/**
 * What is at stake: an answer the operator gave reading as a raw block of daemon text, bylined
 * "you" after a restart - or, the other way round, an operator's own message drawn as an answer
 * card because they pasted a marker into it.
 *
 * With `async-input` on, every answer reaches its agent as an outbox message the daemon writes.
 * That message carries one marker line (`review-message-envelope.ts`), and a delivery the daemon
 * records before sending it (`review-deliveries.ts`). Only a turn bound to such a delivery is
 * Mission Control's and drawn as answer cards. These pin the writer, the binding, recognition,
 * retention, and the Goal reader's echo count.
 */
import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { HookIngest } from "../src/shared/protocol.ts";
import type { PlanDecision, TranscriptMessage } from "../src/shared/types.ts";
import { fakeTranscript } from "./helpers/fake-transcript.ts";
import { mkMuxHandle } from "./helpers/session-fixture.ts";

const home = mkdtempSync(join(tmpdir(), "mission-review-deliveries-"));
process.env.HARNESS_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { openDb, createReviewContinuationPendingTurn, createSnoozeInstructionPendingTurn } = await import("../src/server/db.ts");
const {
  claimReviewDeliveryEcho, confirmReviewDelivery, expireReviewDeliveryEchoes, pruneReviewDeliveries, releaseReviewDelivery,
  reserveReviewDelivery, reviewDeliveryBookkeeping, stampReviewDeliveryHandoff,
} = await import("../src/server/review-deliveries.ts");
const { forgetDeliveryBindingState, noteOtherSend } = await import("../src/server/delivery-binding.ts");
const { delegatedTurnSources, reserveDelegatedTurn } = await import("../src/server/delegated-turns.ts");
const { attributeTranscript } = await import("../src/server/transcript-attribution.ts");
const { forgetInjections, HUMAN_ECHO_TTL_MS, recordInjection } = await import("../src/server/injections.ts");
const { parseReviewEnvelope, wrapReviewEnvelope } = await import("../src/shared/review-message-envelope.ts");
const { applyFeatureFlagIntent } = await import("../src/server/feature-flags/index.ts");
const { Registry, noteKeyFor } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");

const LAG = 24 * 60 * 60_000;
beforeEach(() => {
  openDb().exec("DELETE FROM session_review_deliveries; DELETE FROM session_other_sends; DELETE FROM session_delegated_turns;");
  forgetDeliveryBindingState();
  forgetInjections();
});
const setFlag = (enabled: boolean) => assert.equal(applyFeatureFlagIntent({ kind: "flag", id: "async-input", enabled }).ok, true);
afterEach(() => setFlag(false));

/** A restart: every cache the daemon holds in memory is gone; only the tables remain. */
function restart(): void {
  forgetDeliveryBindingState();
  forgetInjections();
}

let serial = 0;
const conversationKey = () => `review-conv-${++serial}`;

function storeReview(sessionId: string): string {
  const id = randomUUID();
  openDb().prepare(`INSERT INTO reviews (id, session_id, kind, title, body, status, response, created_at, resolved_at)
    VALUES (?, ?, 'input', 'Which linter?', 'Which linter?', 'answered', 'eslint', 1, 2)`).run(id, sessionId);
  return id;
}

const answerText = (ids: string[], body = "Mission Control answer to question (asked 2 minutes ago):\n\nUse eslint") =>
  wrapReviewEnvelope("answer", ids, body);

function attribute(sessionId: string, t: ReturnType<typeof fakeTranscript>, k: string, page: TranscriptMessage[] = t.turns) {
  return attributeTranscript(sessionId, [...page], null, undefined, t.conversation(k));
}

// ---- recognition ----

test("a delivery reserved before the send binds the turn it wrote, even one that lands before confirmation", () => {
  const t = fakeTranscript(); const k = conversationKey(); const now = Date.now();
  const review = storeReview("s1");
  const text = answerText([review]);
  t.append("before", "an earlier operator turn", now - 10);
  const id = reserveReviewDelivery(t.conversation(k), text, undefined, now);
  assert.ok(id, "a marked row reserves a delivery");
  // The agent writes the turn before the runtime's acknowledgement returns.
  t.append("delivered", text, now + 5);
  confirmReviewDelivery(k, id!, { now: now + 10 });
  t.append("reply", "Mock reply", now + 20);

  const [, delivered] = attribute("s1", t, k);
  assert.equal(delivered!.origin, "harness");
  assert.deepEqual(delivered!.presentation, { kind: "review-message", envelope: "answer", reviewIds: [review] });
  assert.equal(delivered!.text, text, "the native text is untouched; the dashboard draws the card");
});

test("a steered delivery recorded twice, mid-turn and again as a plain record, is drawn once", async () => {
  const { collapseSteerEchoes } = await import("../src/shared/message-delivery.ts");
  const t = fakeTranscript(); const k = conversationKey(); const now = Date.now();
  const review = storeReview("s1");
  const text = answerText([review]);
  reserveReviewDelivery(t.conversation(k), text, { active: true, generation: 0 } as never, now);
  const taken = t.append("taken", text, now + 1);
  taken.takenMidTurn = true;
  t.append("echo", text, now + 2);
  t.turns.push({ id: "reply", role: "assistant", text: "Mock reply", tools: [], ts: now + 3 });
  // A later operator copy, after the agent spoke, is still the operator's.
  t.append("copy", text, now + 4);
  const out = attribute("s1", t, k);
  assert.deepEqual(out.map((m) => m.origin ?? null), ["harness", "harness", null, null]);
  assert.deepEqual(collapseSteerEchoes(out).map((m) => m.id), ["taken", "reply", "copy"], "the echo folds into its record");
});

test("a steered delivery's echo is recognized when it opens a page the mid-turn record is not on, across a restart", () => {
  for (const restarted of [false, true]) {
    restart();
    const t = fakeTranscript(); const k = conversationKey(); const now = Date.now();
    const review = storeReview("s1");
    const text = answerText([review]);
    reserveReviewDelivery(t.conversation(k), text, { active: true, generation: 0 } as never, now);
    const taken = t.append("taken", text, now + 1);
    taken.takenMidTurn = true;
    const echo = t.append("echo", text, now + 2);
    t.turns.push({ id: "reply", role: "assistant", text: "Mock reply", tools: [], ts: now + 3 });
    // The older page, holding the mid-turn record, has been read once; or never, after a restart.
    if (!restarted) attribute("s1", t, k, [taken]);
    else restart();
    const [onItsOwn] = attribute("s1", t, k, [echo]);
    assert.equal(onItsOwn!.origin, "harness", restarted ? "after a restart" : "on its own page");
    assert.deepEqual(onItsOwn!.presentation, { kind: "review-message", envelope: "answer", reviewIds: [review] });
  }
});

test("an operator copy sent right after a steered delivery, before its echo, stays the operator's, across a restart", () => {
  const t = fakeTranscript(); const k = conversationKey(); const now = Date.now();
  const review = storeReview("s1");
  const text = answerText([review]);
  reserveReviewDelivery(t.conversation(k), text, { active: true, generation: 0 } as never, now);
  const taken = t.append("taken", text, now + 1);
  taken.takenMidTurn = true;
  attribute("s1", t, k); // the delivery binds its mid-turn record
  // The operator sends the same marked words through Mission Control before the agent speaks.
  noteOtherSend(t.conversation(k), text, now + 2);
  const copy = t.append("operator-copy", text, now + 3);
  for (const restarted of [false, true]) {
    if (restarted) restart();
    const [record, operator] = attribute("s1", t, k);
    assert.equal(record!.presentation?.kind, "review-message", "the delivery's own turn is still its card");
    assert.equal(operator!.presentation, undefined, `the copy is not a card (restart ${restarted})`);
    assert.notEqual(operator!.origin, "harness");
    assert.equal(attribute("s1", t, k, [copy])[0]!.presentation, undefined, "nor on a page of its own");
  }
});

test("a controller's delegated copy sent right after a steered delivery, before its echo, is never that delivery's card", () => {
  const controller = { id: "sdk:controller", name: "Controller" };
  for (const readBefore of [true, false]) {
    restart();
    const t = fakeTranscript(); const k = conversationKey(); const now = Date.now();
    const text = answerText([storeReview("s1")]);
    reserveReviewDelivery(t.conversation(k), text, { active: true, generation: 0 } as never, now);
    const taken = t.append("taken", text, now + 1);
    taken.takenMidTurn = true;
    // Bound by a read before the controller sends, or by nothing until then.
    if (readBefore) attribute("s1", t, k);
    reserveDelegatedTurn(t.conversation(k), text, controller, now + 2);
    const copy = t.append("delegated-copy", text, now + 3);
    for (const restarted of [false, true]) {
      if (restarted) restart();
      const [record, delegated] = attribute("s1", t, k);
      assert.equal(record!.presentation?.kind, "review-message", "the delivery's own turn keeps its card");
      assert.equal(delegated!.presentation, undefined, `the copy is no card (read before ${readBefore}, restart ${restarted})`);
      assert.equal(attribute("s1", t, k, [copy])[0]!.presentation, undefined, "nor on a page of its own");
      assert.equal(delegated!.origin, "session", "it is the controller's delegated turn");
    }
  }
});

test("a send of a steered delivery's words while its transcript cannot be read never rules out an echo already written", () => {
  for (const unreadable of ["read throws", "no transcript"] as const) {
    restart();
    const t = fakeTranscript(); const k = conversationKey(); const now = Date.now();
    const review = storeReview("s1");
    const text = answerText([review]);
    reserveReviewDelivery(t.conversation(k), text, { active: true, generation: 0 } as never, now);
    const taken = t.append("taken", text, now + 1);
    taken.takenMidTurn = true;
    attribute("s1", t, k, [taken]); // bound; the echo is not written yet
    const echo = t.append("echo", text, now + 2);
    // Another send of the same words begins while the file cannot be read.
    const good = t.conversation(k);
    const broken = unreadable === "read throws"
      ? { key: k, transcript: { ...good.transcript!, read: { ...good.transcript!.read, after: () => { throw new Error("EIO"); } } } }
      : { key: k, transcript: null };
    noteOtherSend(broken as never, text, now + 3);
    restart();
    const [shown] = attribute("s1", t, k, [echo]);
    assert.equal(shown!.presentation?.kind, "review-message", `the written echo is still the delivery's (${unreadable})`);
  }
});

test("a steered delivery's echo already written before another send of its words keeps its card", () => {
  const t = fakeTranscript(); const k = conversationKey(); const now = Date.now();
  const text = answerText([storeReview("s1")]);
  reserveReviewDelivery(t.conversation(k), text, { active: true, generation: 0 } as never, now);
  const taken = t.append("taken", text, now + 1);
  taken.takenMidTurn = true;
  t.append("echo", text, now + 2);
  t.turns.push({ id: "reply", role: "assistant", text: "Mock reply", tools: [], ts: now + 3 });
  noteOtherSend(t.conversation(k), text, now + 4);
  t.append("operator-copy", text, now + 5);
  restart();
  const out = attribute("s1", t, k);
  assert.deepEqual(out.map((m) => m.presentation?.kind ?? null), ["review-message", "review-message", null, null]);
});

test("identical review and delegated deliveries contest each other in either order, so neither claims the other's turn", () => {
  const controller = { id: "sdk:controller", name: "Controller" };
  for (const reviewFirst of [true, false]) {
    restart();
    const t = fakeTranscript(); const k = conversationKey(); const now = Date.now();
    const text = answerText([storeReview("s1")]);
    if (reviewFirst) reserveReviewDelivery(t.conversation(k), text, undefined, now);
    reserveDelegatedTurn(t.conversation(k), text, controller, now);
    if (!reviewFirst) reserveReviewDelivery(t.conversation(k), text, undefined, now);
    t.append("a", text, now + 1);
    t.append("b", text, now + 2);
    for (const restarted of [false, true]) {
      if (restarted) restart();
      const out = attribute("s1", t, k);
      assert.deepEqual(out.map((m) => m.presentation ?? null), [null, null], `no card (${reviewFirst ? "review" : "delegated"} first, restart ${restarted})`);
      assert.deepEqual(out.map((m) => m.origin ?? null), [null, null], "and no label credits either sender");
      assert.equal(delegatedTurnSources(t.conversation(k), t.turns).sources.size, 0);
    }
  }
});

test("a delegated delivery after a review delivery has bound takes the next turn, never the review's", () => {
  const controller = { id: "sdk:controller", name: "Controller" };
  const t = fakeTranscript(); const k = conversationKey(); const now = Date.now();
  const review = storeReview("s1");
  const text = answerText([review]);
  reserveReviewDelivery(t.conversation(k), text, undefined, now);
  t.append("review-turn", text, now + 1);
  reserveDelegatedTurn(t.conversation(k), text, controller, now + 2);
  t.append("delegated-turn", text, now + 3);
  restart();
  const [reviewTurn, delegatedTurn] = attribute("s1", t, k);
  assert.deepEqual(reviewTurn!.presentation, { kind: "review-message", envelope: "answer", reviewIds: [review] });
  assert.equal(delegatedTurn!.presentation, undefined);
  assert.equal(delegatedTurn!.origin, "session");
});

test("an unmarked row reserves nothing, so a turn delivered before this phase renders as it did", () => {
  const t = fakeTranscript(); const k = conversationKey();
  assert.equal(reserveReviewDelivery(t.conversation(k), "Mission Control answer to question 1:\n\nUse eslint", undefined), null);
});

test("only a bound turn changes: a pasted marker, a marker over another body and a copy of a delivered message stay the operator's", () => {
  const t = fakeTranscript(); const k = conversationKey(); const now = Date.now();
  const review = storeReview("s1");
  const text = answerText([review]);
  // A real delivery, bound, whose words the in-memory label also remembers as Mission Control's.
  reserveReviewDelivery(t.conversation(k), text, undefined, now);
  recordInjection("s1", text, "harness");
  t.append("delivered", text, now + 1);
  // The operator pastes the whole delivered message back in, later.
  t.append("copy", text, now + 60_000);
  // A marker naming a real review over words no delivery carried.
  t.append("other-body", answerText([review], "Actually, use biome."), now + 61_000);
  // A marker naming a real review of this session with no delivery recorded at all.
  t.append("no-delivery", answerText([storeReview("s1")]), now + 62_000);

  const [delivered, copy, otherBody, noDelivery] = attribute("s1", t, k);
  assert.equal(delivered!.presentation?.kind, "review-message");
  for (const turn of [copy, otherBody, noDelivery]) {
    assert.equal(turn!.presentation, undefined, `${turn!.id} is not drawn as a card`);
    assert.equal(turn!.origin, undefined, `${turn!.id} keeps the operator's byline`);
  }
});

test("a composer send of the same words inside the race window contests the delivery, so neither turn becomes a card", () => {
  for (const operatorFirst of [true, false]) {
    restart();
    const t = fakeTranscript(); const k = conversationKey(); const now = Date.now();
    const text = answerText([storeReview("s1")]);
    if (operatorFirst) noteOtherSend(t.conversation(k), text, now);
    reserveReviewDelivery(t.conversation(k), text, undefined, now);
    if (!operatorFirst) noteOtherSend(t.conversation(k), text, now);
    t.append("a", text, now + 1);
    t.append("b", text, now + 2);
    for (const turn of attribute("s1", t, k)) {
      assert.equal(turn.presentation, undefined);
      assert.notEqual(turn.origin, "harness", "neither is guessed to be Mission Control's");
    }
  }
});

test("after a dropped delivery, an operator's later copy sent through Mission Control stays the operator's", () => {
  const t = fakeTranscript(); const k = conversationKey(); const now = Date.now();
  const text = answerText([storeReview("s1")]);
  reserveReviewDelivery(t.conversation(k), text, undefined, now);
  // The harness altered the delivered turn, so it never binds.
  t.append("altered", `> ${text}`, now + 1);
  // Much later the operator sends the same words from the composer.
  noteOtherSend(t.conversation(k), text, now + 3_600_000);
  t.append("operator", text, now + 3_600_001);
  const [altered, operator] = attribute("s1", t, k);
  assert.equal(altered!.presentation, undefined);
  assert.equal(operator!.presentation, undefined);
  assert.notEqual(operator!.origin, "harness");
});

test("a refused delivery releases its row and claims nothing", () => {
  const t = fakeTranscript(); const k = conversationKey(); const now = Date.now();
  const text = answerText([storeReview("s1")]);
  const id = reserveReviewDelivery(t.conversation(k), text, undefined, now)!;
  releaseReviewDelivery(k, id);
  assert.equal(openDb().prepare("SELECT COUNT(*) AS n FROM session_review_deliveries").get()!.n, 0);
  t.append("later", text, now + 1);
  const [turn] = attribute("s1", t, k);
  assert.equal(turn!.presentation, undefined);
  assert.equal(turn!.origin, undefined);
});

test("the binding and its Mission Control origin survive a restart with an empty injection record", () => {
  const t = fakeTranscript(); const k = conversationKey(); const now = Date.now();
  const review = storeReview("s1");
  const text = answerText([review]);
  reserveReviewDelivery(t.conversation(k), text, undefined, now);
  t.append("delivered", text, now + 1);
  assert.equal(attribute("s1", t, k)[0]!.origin, "harness");
  restart();
  const [turn] = attribute("s1", t, k);
  assert.equal(turn!.origin, "harness", "not 'you' after a restart");
  assert.deepEqual(turn!.presentation, { kind: "review-message", envelope: "answer", reviewIds: [review] });
});

test("a bound turn whose reviews can no longer be found is still Mission Control's review message, after a restart too", () => {
  const t = fakeTranscript(); const k = conversationKey(); const now = Date.now();
  const kept = storeReview("s1");
  const gone = storeReview("s1");
  const text = answerText([kept, gone]);
  reserveReviewDelivery(t.conversation(k), text, undefined, now);
  t.append("delivered", text, now + 1);
  // A database restored from before the second review existed.
  openDb().prepare("DELETE FROM reviews WHERE id = ?").run(gone);
  for (const restarted of [false, true]) {
    if (restarted) restart();
    const [turn] = attribute("s1", t, k);
    assert.equal(turn!.origin, "harness");
    // The dashboard draws the review it can find and says the other is no longer available;
    // the delivered text is never left as a raw turn.
    assert.deepEqual(turn!.presentation, { kind: "review-message", envelope: "answer", reviewIds: [kept, gone] });
  }
});

test("a delivery to a runtime-transfer successor resolves reviews its predecessor asked", () => {
  const t = fakeTranscript(); const k = conversationKey(); const now = Date.now();
  const review = storeReview("predecessor");
  openDb().prepare(`INSERT INTO session_runtime_transfers
    (id, revision, source_session_id, note_key, task_id, state, reason, successor_session_id, facts_json, created_at, updated_at)
    VALUES (?, 1, 'predecessor', ?, NULL, 'adopted', 'runtime', 'successor', '{}', 1, 1)`).run(randomUUID(), k);
  const text = answerText([review]);
  reserveReviewDelivery(t.conversation(k), text, undefined, now);
  t.append("delivered", text, now + 1);
  assert.equal(attribute("successor", t, k)[0]!.presentation?.kind, "review-message");
});

test("a bound row survives the prune tick for good; an unbound one past the window binds nothing and is pruned", () => {
  const t = fakeTranscript(); const k = conversationKey(); const now = Date.now();
  const review = storeReview("s1");
  const bound = answerText([review], "Mission Control answer: bound");
  const dropped = answerText([review], "Mission Control answer: dropped");
  reserveReviewDelivery(t.conversation(k), bound, undefined, now);
  t.append("bound", bound, now + 1);
  attribute("s1", t, k);
  reserveReviewDelivery(t.conversation(k), dropped, undefined, now + 2);
  // Its words appear only after the delivery window has closed.
  t.append("too-late", dropped, now + 2 + LAG + 1);

  const [, tooLate] = attribute("s1", t, k);
  assert.equal(tooLate!.presentation, undefined, "an expired row binds nothing");
  // A year on, the conversation is reopened after the prune tick has run.
  assert.equal(pruneReviewDeliveries(now + 365 * LAG), 1, "only the unbound row goes");
  restart();
  const [old] = attribute("s1", t, k, [t.turns[0]!]);
  assert.equal(old!.origin, "harness");
  assert.equal(old!.presentation?.kind, "review-message", "the old conversation still draws its card");
});

test("contested and offset-less deliveries outlive the prune tick, so their turns never read as the operator's", () => {
  for (const kind of ["contested", "no offset"] as const) {
    restart();
    const t = fakeTranscript(); const k = conversationKey(); const now = Date.now();
    const text = answerText([storeReview("s1")]);
    if (kind === "no offset") t.failSize("missing");
    else noteOtherSend(t.conversation(k), text, now);
    reserveReviewDelivery(t.conversation(k), text, undefined, now);
    t.failSize(false);
    t.append("delivered", text, now + 1);
    // A day and more later, the goal tick prunes; then the daemon restarts.
    pruneReviewDeliveries(now + 2 * LAG);
    restart();
    const [turn] = attribute("s1", t, k);
    assert.equal(turn!.originUnresolved, true, `${kind}: still could be Mission Control's, so no "you" label`);
    assert.equal(turn!.origin, undefined);
  }
});

// ---- the writer ----

let pane = 400;
function sessionFixture() {
  const n = ++pane;
  const registry = new Registry();
  registry.applyDiscovery([{
    syntheticId: `proc:ttys${n}:${n}:0`, agent: "claude", name: "work", nameSource: "process", cwd: `/wt/cards-${n}`,
    gitBranch: null, gitRoot: null, repoRoot: null, pid: n, tty: `ttys${n}`,
    terminals: [mkMuxHandle({ session: "s", windowName: "w", windowIndex: 0, paneId: `%${n}` })], startedAt: 0,
  } as DiscoveredSession]);
  return { registry, session: registry.getSession(`proc:ttys${n}:${n}:0`)!, pane: `%${n}` };
}

const linter: PlanDecision[] = [{ id: "q", question: "Which linter?", options: [{ id: "o0", label: "biome" }, { id: "o1", label: "eslint" }] }];

function writer(flag: () => boolean) {
  const { registry, session } = sessionFixture();
  const reviews = new ReviewManager(registry);
  const noteKey = `note-${session.id}`;
  reviews.startContinuationRecovery((review, text, kind) => {
    const queue = kind === "snooze-instruction" ? createSnoozeInstructionPendingTurn : createReviewContinuationPendingTurn;
    return queue({ reviewId: review.id, noteKey, text, now: Date.now(), markCallMode: flag() }) !== null;
  });
  const rows = () => openDb().prepare("SELECT id, text FROM pending_turns WHERE note_key = ? ORDER BY seq").all(noteKey) as Array<{ id: string; text: string }>;
  return { reviews, session, rows };
}

test("a message-mode answer always carries the marker; the text under it is what the agent always received", () => {
  const { reviews, session, rows } = writer(() => false);
  const filed = reviews.create(session.id, "input", "Which linter?", "Which linter?", linter, { snoozable: true, waitMode: "message" });
  reviews.resolve(filed.id, "answer", "eslint", "human");
  const [row] = rows();
  const envelope = parseReviewEnvelope(row!.text);
  assert.deepEqual(envelope?.reviewIds, [filed.id]);
  assert.equal(envelope?.kind, "answer");
  assert.match(envelope!.rest, /^Mission Control answer to question/);
  assert.equal(row!.id, `review-continuation:answer:${filed.id}`, "the turn id and its prefix are unchanged");
});

test("a fold rewrites the marker to name every answer the row carries, in delivery order", () => {
  const { reviews, session, rows } = writer(() => false);
  const first = reviews.create(session.id, "input", "Which linter?", "Which linter?", linter, { snoozable: true, waitMode: "message" });
  const second = reviews.create(session.id, "input", "Which formatter?", "Which formatter?", linter, { snoozable: true, waitMode: "message" });
  reviews.resolve(first.id, "answer", "eslint", "human");
  reviews.resolve(second.id, "answer", "biome", "human");
  const all = rows();
  assert.equal(all.length, 1, "coalesced into the unclaimed row");
  const envelope = parseReviewEnvelope(all[0]!.text)!;
  assert.deepEqual(envelope.reviewIds, [first.id, second.id]);
  assert.equal(envelope.rest.split("\n\n---\n\n").length, 2, "both answers, joined as before");
  assert.doesNotMatch(envelope.rest, /mission-control:/, "the line is written once, at the top");
});

test("a call-mode late answer and a snooze instruction carry the marker only while the flag is on", () => {
  for (const on of [false, true]) {
    const { reviews, session, rows } = writer(() => on);
    const late = reviews.create(session.id, "input", "Late?", "Late?", linter, { snoozable: true });
    assert.ok(reviews.detachWait(late.id, session.id));
    reviews.resolve(late.id, "answer", "eslint", "human");
    const snoozed = reviews.create(session.id, "input", "Later?", "Later?", linter, { snoozable: true });
    assert.ok(reviews.detachWait(snoozed.id, session.id));
    reviews.snooze(snoozed.id, 60 * 60_000, { mode: "option", optionId: "o1" });
    const byId = new Map(rows().map((row) => [row.id, row.text]));
    const answer = byId.get(`review-continuation:${late.id}`)!;
    const instruction = byId.get(`review-continuation:snooze:${snoozed.id}`)!;
    assert.ok(answer && instruction, "both rows were queued");
    if (on) {
      assert.deepEqual(parseReviewEnvelope(answer)?.reviewIds, [late.id]);
      assert.equal(parseReviewEnvelope(instruction)?.kind, "remind-later");
    } else {
      assert.equal(parseReviewEnvelope(answer), null, "flag off writes no line");
      assert.equal(parseReviewEnvelope(instruction), null);
      assert.match(answer, /^Mission Control review /, "exactly today's text");
    }
  }
});

// ---- the Goal reader ----

function hookSession() {
  const { registry, session, pane: paneId } = sessionFixture();
  const submit = (prompt: string): void => {
    registry.applyHook({
      agent: "claude", event: "UserPromptSubmit", sessionId: null, cwd: null, transcriptPath: null,
      env: { tmuxPane: paneId }, prompt,
    } as HookIngest);
  };
  // Reserved and then handed to the runtime, as the outbox does.
  const deliver = (text: string, now = Date.now()) => {
    const key = noteKeyFor(registry.getSession(session.id)!);
    const id = reserveReviewDelivery({ key, transcript: null }, text, undefined, now)!;
    stampReviewDeliveryHandoff(key, id, undefined, now);
    return id;
  };
  const revisions = () => registry.getGoal(session.id)?.promptRevision ?? 0;
  submit("Add a linter to CI");
  return { registry, session, submit, deliver, revisions };
}

test("the Goal reader captures nothing from a delivery, across a restart", () => {
  const { submit, deliver, revisions } = hookSession();
  const text = answerText([randomUUID()]);
  const before = revisions();
  deliver(text);
  restart();
  submit(text);
  assert.equal(revisions(), before, "the delivery's echo is spent, not captured");
});

test("N deliveries and M operator sends of the same words yield exactly M Goal revisions, in every arrival order", () => {
  // The hook cannot tell an operator copy from the delivery's echo, so the orders are the ways
  // arrivals and deliveries interleave. Each step is a delivery (D) or an arrival (A).
  const cases: Array<{ steps: string; deliveries: number; arrivals: number }> = [
    { steps: "ADA", deliveries: 1, arrivals: 2 }, // an operator send before the delivery
    { steps: "DAA", deliveries: 1, arrivals: 2 }, // between or after its echo
    { steps: "DDAAA", deliveries: 2, arrivals: 3 }, // two deliveries, one operator send
    { steps: "DADAA", deliveries: 2, arrivals: 3 },
    { steps: "ADDAA", deliveries: 2, arrivals: 3 },
  ];
  for (const { steps, deliveries, arrivals } of cases) {
    const { submit, deliver, revisions } = hookSession();
    const text = answerText([randomUUID()]);
    const before = revisions();
    for (const step of steps) {
      if (step === "D") deliver(text);
      else submit(text);
    }
    assert.equal(revisions() - before, arrivals - deliveries, steps);
  }
});

test("an operator prompt that spent the echo of a delivery the runtime then refused is captured after all", () => {
  const { session, registry, submit, revisions } = hookSession();
  const key = noteKeyFor(registry.getSession(session.id)!);
  const text = answerText([randomUUID()]);
  const before = revisions();
  const id = reserveReviewDelivery({ key, transcript: null }, text, undefined)!;
  submit(text); // the operator's copy arrives while the daemon's send is still pending
  assert.equal(revisions(), before, "counted against the pending delivery for now");
  releaseReviewDelivery(key, id); // the runtime refused it: nothing it sent was echoed
  assert.equal(revisions() - before, 1, "the operator's prompt reaches the Goal");
  // An accepted delivery keeps the count it settled.
  const accepted = reserveReviewDelivery({ key, transcript: null }, text, undefined)!;
  submit(text);
  confirmReviewDelivery(key, accepted);
  assert.equal(revisions() - before, 1);
});

test("a turn that completes while a delivery waits for its handoff never clears the echo the delivery will produce", () => {
  const k = conversationKey(); const now = Date.now();
  const text = answerText([randomUUID()]);
  // Reserved against an idle conversation at generation 0, so its echo would belong to turn 1.
  const id = reserveReviewDelivery({ key: k, transcript: null }, text, { active: false, generation: 0 } as never, now)!;
  // The row waits behind other work; turn 1 completes, and far longer than the TTL passes.
  expireReviewDeliveryEchoes(k, 1, now + 1_000);
  // At the handoff the conversation is at generation 1 and idle: the echo belongs to turn 2.
  stampReviewDeliveryHandoff(k, id, { active: false, generation: 1 } as never, now + HUMAN_ECHO_TTL_MS + 5_000);
  expireReviewDeliveryEchoes(k, 1, now + HUMAN_ECHO_TTL_MS + 6_000);
  assert.equal(claimReviewDeliveryEcho(k, [text], now + HUMAN_ECHO_TTL_MS + 7_000), true, "the echo still finds its debt");
  // Its own turn's completion clears a debt nobody spent, as before.
  const again = reserveReviewDelivery({ key: k, transcript: null }, text, { active: false, generation: 1 } as never, now)!;
  stampReviewDeliveryHandoff(k, again, { active: false, generation: 1 } as never, now);
  expireReviewDeliveryEchoes(k, 2, now + 1);
  assert.equal(claimReviewDeliveryEcho(k, [text], now + 2), false);
});

test("a delivery that waited longer than the TTL with the cycle unchanged still owes its echo from the handoff", () => {
  const k = conversationKey(); const now = Date.now();
  const text = answerText([randomUUID()]);
  // Reserved against an idle conversation long before the handoff, and the cycle never moved.
  const id = reserveReviewDelivery({ key: k, transcript: null }, text, { active: false, generation: 4 } as never, now - HUMAN_ECHO_TTL_MS - 60_000)!;
  stampReviewDeliveryHandoff(k, id, { active: false, generation: 4 } as never, now);
  assert.equal(claimReviewDeliveryEcho(k, [text], now + 1_000), true, "the TTL counts from the handoff");
});

test("bookkeeping for a delivery that ends uncertain - never confirmed, never refused - ages out", () => {
  const k = conversationKey(); const now = Date.now();
  const before = reviewDeliveryBookkeeping();
  const text = answerText([randomUUID()]);
  reserveReviewDelivery({ key: k, transcript: null }, text, undefined, now);
  claimReviewDeliveryEcho(k, [text], now + 1, () => {});
  assert.deepEqual(reviewDeliveryBookkeeping(), { reservations: before.reservations + 1, unacceptedClaims: before.unacceptedClaims + 1 });
  // A day later, the next delivery sweeps what nothing will ever settle.
  reserveReviewDelivery({ key: k, transcript: null }, answerText([randomUUID()]), undefined, now + LAG + 10);
  assert.deepEqual(reviewDeliveryBookkeeping(), { reservations: 1, unacceptedClaims: 0 });
});

test("the count survives a restart between a delivery and its echo", () => {
  const { submit, deliver, revisions } = hookSession();
  const text = answerText([randomUUID()]);
  const before = revisions();
  deliver(text);
  submit(text); // the operator's copy arrives first
  restart();
  submit(text); // then the delivery's echo
  assert.equal(revisions() - before, 1);
});

test("a dropped echo's debt clears at its work cycle's completion or the TTL, across a restart, so a later operator copy is captured", () => {
  {
    const { session, registry, submit, deliver, revisions } = hookSession();
    const text = answerText([randomUUID()]);
    const before = revisions();
    deliver(text);
    // The turn the delivery started completes with no echo ever arriving.
    expireReviewDeliveryEchoes(noteKeyFor(registry.getSession(session.id)!), 1);
    restart();
    submit(text);
    assert.equal(revisions() - before, 1, "cleared by the work cycle");
  }
  {
    const { submit, deliver, revisions } = hookSession();
    const text = answerText([randomUUID()]);
    const before = revisions();
    deliver(text, Date.now() - HUMAN_ECHO_TTL_MS - 1_000);
    restart();
    submit(text);
    assert.equal(revisions() - before, 1, "cleared by the TTL");
  }
  // A delivery queued behind a running turn waits for that turn and the next, not the TTL.
  const k = conversationKey();
  const id = reserveReviewDelivery({ key: k, transcript: null }, answerText([randomUUID()]), { active: true, generation: 3 } as never,
    Date.now() - HUMAN_ECHO_TTL_MS - 1_000)!;
  assert.ok(id);
  stampReviewDeliveryHandoff(k, id, { active: true, generation: 3 } as never, Date.now() - HUMAN_ECHO_TTL_MS - 1_000);
  expireReviewDeliveryEchoes(k, 4);
  assert.equal(claimReviewDeliveryEcho(k, [answerText([randomUUID()])]), false, "other words owe nothing");
  const owed = openDb().prepare("SELECT echo_owed, echo_eligible_at FROM session_review_deliveries WHERE id = ?").get(id) as { echo_owed: number; echo_eligible_at: number | null };
  assert.equal(owed.echo_owed, 1, "its own turn has not completed");
  assert.notEqual(owed.echo_eligible_at, null, "its turn is now next, so it ages");
  expireReviewDeliveryEchoes(k, 5);
  const cleared = openDb().prepare("SELECT echo_owed FROM session_review_deliveries WHERE id = ?").get(id) as { echo_owed: number };
  assert.equal(cleared.echo_owed, 0);
});
