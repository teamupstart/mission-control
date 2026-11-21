import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PendingTurn, ReviewItem, TranscriptMessage } from "../src/shared/types.ts";
import { wrapReviewEnvelope } from "../src/shared/review-message-envelope.ts";
import { mergeConversation, type ConversationRow, type ReviewHistory } from "../src/web/lib/episodes.ts";
import { projectLaunchPresentation } from "../src/web/lib/launch-presentation.ts";
import { transcriptRows } from "../src/web/lib/tools.ts";
import { collectHits } from "../src/web/lib/find.ts";
import { ReviewAnswerCard, UnavailableReviewCard } from "../src/web/components/ReviewAnswer.tsx";
import { SnoozedReviewCard } from "../src/web/components/ReviewSnooze.tsx";

// Where an answer delivered as a message (`async-input`) is drawn: once, as the gold card, at
// the turn the agent received it - and at the moment the operator answered, saying it is on its
// way, until then. The daemon decides which turns qualify (`review-deliveries.ts`); these pin
// what the dashboard does with that decision.

const A = "1b0c9f4e-2a8d-4a43-9d3e-0f6c2b7e5a10";
const B = "7d1e2f30-4b5c-4d6e-8f90-a1b2c3d4e5f6";

function review(id: string, over: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id, sessionId: "s", kind: "input", title: `Question ${id.slice(0, 4)}`, body: "body", status: "answered",
    response: "eslint", decisions: null, selections: null, createdAt: 1_000, resolvedAt: 2_000, waitMode: "message",
    resolvedBy: "human", ...over,
  } as ReviewItem;
}

const turn = (id: string, ts: number, over: Partial<TranscriptMessage> = {}): TranscriptMessage =>
  ({ id, role: "assistant", text: `turn ${id}`, tools: [], ts, ...over });

function delivered(id: string, ts: number, reviewIds: string[], envelope: "answer" | "remind-later" = "answer"): TranscriptMessage {
  return {
    id, role: "user", ts, tools: [], origin: "harness",
    text: wrapReviewEnvelope(envelope, reviewIds, "Mission Control answer to question:\n\nUse eslint"),
    presentation: { kind: "review-message", envelope, reviewIds },
  };
}

function rows(messages: TranscriptMessage[], reviews: ReviewItem[], pending: PendingTurn[] = [], history: ReviewHistory = {}): ConversationRow[] {
  return mergeConversation(transcriptRows(projectLaunchPresentation(messages)), [], reviews, pending, history);
}

// Phase 3's Asked entry is left exactly where it was; only the answer's placement is pinned here.
const shape = (out: ConversationRow[]) => out.filter((row) => row.kind !== "asked").map((row) =>
  row.kind === "review"
    ? `review:${row.review.id.slice(0, 4)}${row.delivery ? `@${row.delivery.turnId}` : ""}${row.queued ? ":queued" : ""}`
    : row.kind === "delivered" ? `delivered:${row.reviewId.slice(0, 4)}@${row.delivery.turnId}${row.loading ? ":loading" : ""}${row.unreadable ? ":unreadable" : ""}`
      : row.kind === "turn" ? row.id : row.kind);

test("a delivered answer is drawn once, at its turn, in place of the raw message, and the reply follows it", () => {
  const out = rows([turn("before", 1_500), turn("between", 2_500), delivered("d", 3_000, [A]), turn("reply", 3_100)], [review(A)]);
  assert.deepEqual(shape(out), ["before", "between", `review:1b0c@d`, "reply"],
    "no entry at resolvedAt, and no raw turn");
});

test("two answers delivered together draw two cards on one turn, in delivery order, disclosing the text once", () => {
  const out = rows([delivered("d", 3_000, [B, A])], [review(A), review(B)]);
  assert.deepEqual(shape(out), [`review:7d1e@d`, `review:1b0c@d`]);
  const cards = out.filter((row): row is Extract<ConversationRow, { kind: "review" }> => row.kind === "review");
  assert.deepEqual(cards.map((card) => card.delivery?.last), [false, true]);
});

test("an answer still in the outbox stays where it was given, on its way", () => {
  const pending = [{
    id: `review-continuation:answer:${A}`, noteKey: "k", seq: 0, state: "queued", revision: 0, createdAt: 2_000,
    updatedAt: 2_000, claimedAt: null, lastError: null, text: wrapReviewEnvelope("answer", [A], "Use eslint"),
  } as PendingTurn];
  const out = rows([turn("before", 1_500), turn("after", 2_500)], [review(A)], pending);
  assert.deepEqual(shape(out), ["before", "review:1b0c:queued", "after"]);
});

test("an operator's queued message that begins with a marker never puts an answer on its way", () => {
  const pending = [{
    id: "a-random-operator-row", noteKey: "k", seq: 0, state: "queued", revision: 0, createdAt: 2_000,
    updatedAt: 2_000, claimedAt: null, lastError: null, text: wrapReviewEnvelope("answer", [A], "pasted"),
  } as PendingTurn];
  const out = rows([turn("before", 1_500)], [review(A)], pending);
  assert.deepEqual(shape(out), ["before", "review:1b0c"]);
});

test("a call-mode answer its call returned is placed exactly as before", () => {
  const out = rows([turn("before", 1_500), turn("after", 2_500)], [review(A, { waitMode: undefined })]);
  assert.deepEqual(shape(out), ["before", "review:1b0c", "after"]);
});

test("a delivered turn naming a review the dashboard cannot draw is still a card per answer, never the raw turn", () => {
  const out = rows([delivered("d", 3_000, [A, B])], [review(A)]);
  assert.deepEqual(shape(out), ["review:1b0c@d", "delivered:7d1e@d"], "no raw turn is left");
  const gone = out.find((row) => row.kind === "delivered") as Extract<ConversationRow, { kind: "delivered" }>;
  assert.equal(gone.delivery.last, true, "the disclosure rides on the last card of the turn");
  // A history that has come back without the review: a restored database.
  assert.deepEqual(shape(rows([delivered("d", 3_000, [A])], [], [], { loaded: true })), ["delivered:1b0c@d"]);
  const html = renderToStaticMarkup(createElement(UnavailableReviewCard, {
    envelope: "answer",
    delivery: { state: "delivered", turnId: "d", at: 3_000, received: { text: gone.delivery.text, open: false } },
  }));
  assert.match(html, /class="review-answer" role="note" aria-label="Answer to a question no longer available" data-turn-id="d"/);
  assert.match(html, /This question is no longer available/);
  assert.match(html, /Delivered to the agent/);
  assert.match(html, /What the agent received/);
  const snoozed = renderToStaticMarkup(createElement(UnavailableReviewCard, {
    envelope: "remind-later", delivery: { state: "delivered", turnId: "d", at: 3_000 },
  }));
  assert.match(snoozed, /class="review-snoozed"/);
});

test("while the review history is still loading, a delivered answer reads as loading, never as gone", () => {
  assert.deepEqual(shape(rows([delivered("d", 3_000, [A])], [], [], { loaded: false })), ["delivered:1b0c@d:loading"]);
  // Once it settles with the review, the real card takes the turn.
  assert.deepEqual(shape(rows([delivered("d", 3_000, [A])], [review(A)], [], { loaded: true })), ["review:1b0c@d"]);
  const html = renderToStaticMarkup(createElement(UnavailableReviewCard, {
    envelope: "answer", loading: true, delivery: { state: "delivered", turnId: "d", at: 3_000 },
  }));
  assert.match(html, /aria-label="Answer loading" aria-busy="true"/);
  assert.match(html, /Loading the question…/);
  assert.doesNotMatch(html, /no longer available/);
});

test("a review history that settled only because its reads kept failing draws a read error, never \"no longer available\"", () => {
  // Retries spent with a source unread: the question may exist, so the card says it could not be loaded.
  assert.deepEqual(shape(rows([delivered("d", 3_000, [A])], [], [], { loaded: true, failed: true })), ["delivered:1b0c@d:unreadable"]);
  // Still in flight is loading, whatever an earlier session's read did.
  assert.deepEqual(shape(rows([delivered("d", 3_000, [A])], [], [], { loaded: false, failed: true })), ["delivered:1b0c@d:loading"]);
  // A read that answered without the review is the only one that says gone.
  assert.deepEqual(shape(rows([delivered("d", 3_000, [A])], [], [], { loaded: true, failed: false })), ["delivered:1b0c@d"]);
  // A review the failed history did return still draws its real card.
  assert.deepEqual(shape(rows([delivered("d", 3_000, [A])], [review(A)], [], { loaded: true, failed: true })), ["review:1b0c@d"]);
  for (const envelope of ["answer", "remind-later"] as const) {
    const html = renderToStaticMarkup(createElement(UnavailableReviewCard, {
      envelope, unreadable: true, delivery: { state: "delivered", turnId: "d", at: 3_000, received: { text: "Use eslint", open: false } },
    }));
    assert.match(html, /Couldn(&#x27;|')t load the question/);
    assert.match(html, envelope === "answer"
      ? /aria-label="Answer whose question could not be loaded"/
      : /aria-label="Snoozed question that could not be loaded"/);
    assert.doesNotMatch(html, /no longer available/);
    assert.doesNotMatch(html, /aria-busy/);
    assert.match(html, /Delivered to the agent/);
    assert.match(html, /What the agent received/, "what the agent received stays one click away");
  }
});

test("an answer delivered here to a question a runtime-transfer predecessor asked draws its real card", () => {
  const inherited = review(A, { sessionId: "predecessor" });
  const out = rows([delivered("d", 3_000, [A])], [], [], { loaded: true, lineage: [inherited] });
  assert.deepEqual(shape(out), ["review:1b0c@d"], "looked up for the card only; no entry of its own here");
});

test("a turn carrying a marker but no presentation is an ordinary turn", () => {
  const pasted: TranscriptMessage = { id: "pasted", role: "user", ts: 3_000, tools: [], text: wrapReviewEnvelope("answer", [A], "Use biome") };
  const out = rows([pasted], [review(A)]);
  assert.deepEqual(shape(out), ["review:1b0c", "pasted"]);
});

test("a delivered Remind me later instruction is the snoozed line at its turn, not raw instructions", () => {
  const snoozed = review(A, { status: "snoozed", resolvedAt: null, snooze: { at: 1_500, until: 99_000, mode: "hold" } } as Partial<ReviewItem>);
  const out = rows([turn("before", 1_200), delivered("d", 3_000, [A], "remind-later")], [snoozed]);
  assert.deepEqual(shape(out), ["before", "review:1b0c@d"], "the snooze entry gives way to the delivered line");
  const row = out.find((r) => r.kind === "review") as Extract<ConversationRow, { kind: "review" }>;
  const html = renderToStaticMarkup(createElement(SnoozedReviewCard, {
    review: row.review,
    delivery: { state: "delivered", turnId: "d", at: 3_000, received: { text: row.delivery!.text, open: false } },
  }));
  assert.match(html, /class="review-snoozed"/);
  assert.match(html, /Delivered to the agent/);
  assert.match(html, /Answer now/, "still parked, so it can be brought back");
  // Answered since: the line records the snooze and offers nothing to act on.
  const answered = renderToStaticMarkup(createElement(SnoozedReviewCard, {
    review: { ...row.review, status: "answered" },
    delivery: { state: "delivered", turnId: "d", at: 3_000 },
  }));
  assert.doesNotMatch(answered, /Answer now/);
});

test("the card says how its answer travelled, and discloses exactly what the agent received", () => {
  const queued = renderToStaticMarkup(createElement(ReviewAnswerCard, { review: review(A), delivery: { state: "queued" } }));
  assert.match(queued, /On its way to the agent/);
  assert.doesNotMatch(queued, /<details/);
  const text = wrapReviewEnvelope("answer", [A], "Use eslint");
  const html = renderToStaticMarkup(createElement(ReviewAnswerCard, {
    review: review(A),
    delivery: { state: "delivered", turnId: "d", at: 3_000, received: { text, open: false } },
  }));
  assert.match(html, /class="review-answer" data-turn-id="d"/);
  assert.match(html, /Delivered to the agent/);
  assert.match(html, /<details class="review-received" aria-label="What the agent received"><summary[^>]*>What the agent received<\/summary>/);
  assert.ok(html.includes(`[mission-control:answer review=${A}]`), "nothing is hidden for good");
  const plain = renderToStaticMarkup(createElement(ReviewAnswerCard, { review: review(A) }));
  assert.doesNotMatch(plain, /Delivered|On its way|data-turn-id/, "a call-returned answer is unchanged");
});

test("find reaches the delivered text inside the disclosure, as Mission Control's words, once per delivery", () => {
  const out = rows([delivered("d", 3_000, [B, A])], [review(A), review(B)]);
  const hits = collectHits(out, "use eslint", { caseSensitive: false }, "claude");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.rowId, "d");
  assert.equal(hits[0]!.scope, "injected");
  assert.equal(hits[0]!.who, "mission control");
});

test("the review history read always resolves, keeps what arrived, and is complete only when both reads answered", async () => {
  const { loadReviewHistory } = await import("../src/web/lib/timelineReviews.ts");
  const own = [review(A)];
  const inherited = [review(B, { sessionId: "predecessor" })];
  const ok = (value: ReviewItem[]) => async () => ({ ok: true as const, value });
  const transient = async () => ({ ok: false as const, definite: false });
  const definite = async () => ({ ok: false as const, definite: true });
  const reject = () => Promise.reject(new Error("network down"));
  const load = async (...args: Parameters<typeof loadReviewHistory>) => {
    const { stored, lineage, complete, refused } = await loadReviewHistory(...args);
    return { stored, lineage, complete, refused };
  };
  // A failed lineage read cannot hide the session's own answers, but it does not settle either.
  assert.deepEqual(await load("s", { own: ok(own), lineage: reject }), { stored: own, lineage: [], complete: false, refused: false });
  // Nor the other way round.
  assert.deepEqual(await load("s", { own: reject, lineage: ok(inherited) }), { stored: [], lineage: inherited, complete: false, refused: false });
  // A 5xx or network failure is transient: never an empty history.
  assert.deepEqual(await load("s", { own: transient, lineage: ok([]) }), { stored: [], lineage: [], complete: false, refused: false });
  // A 4xx (a session the daemon no longer holds) is final, so it is not retried, but it is a
  // refusal rather than a read: the history settles as refused, never as one that found nothing.
  assert.deepEqual(await load("s", { own: definite, lineage: definite }), { stored: [], lineage: [], complete: true, refused: true });
  assert.deepEqual(await load("s", { own: ok(own), lineage: definite }), { stored: own, lineage: [], complete: true, refused: true });
  // Both answered, even with nothing in them: complete, so a missing review really is gone.
  assert.deepEqual(await load("s", { own: ok([]), lineage: ok([]) }), { stored: [], lineage: [], complete: true, refused: false });
  assert.deepEqual(shape(rows([delivered("d", 3_000, [A])], [], [], { loaded: true })), ["delivered:1b0c@d"]);
  // Not complete, the history stays unloaded and the card stays loading.
  assert.deepEqual(shape(rows([delivered("d", 3_000, [A])], [], [], { loaded: false })), ["delivered:1b0c@d:loading"]);
});

test("a source that answered on an earlier attempt keeps its reviews when a later attempt fails", async () => {
  const { loadReviewHistory, NO_HISTORY } = await import("../src/web/lib/timelineReviews.ts");
  const own = [review(A)];
  const inherited = [review(B, { sessionId: "predecessor" })];
  let ownReads = 0;
  // Attempt 1: this session's history answers, the lineage read fails.
  const first = await loadReviewHistory("s", {
    own: async () => { ownReads += 1; return { ok: true as const, value: own }; },
    lineage: async () => ({ ok: false as const, definite: false }),
  }, NO_HISTORY);
  assert.deepEqual({ stored: first.stored, complete: first.complete }, { stored: own, complete: false });
  // Attempt 2: the own read would now fail, the lineage read answers. The reviews already in hand stay.
  const second = await loadReviewHistory("s", {
    own: async () => { ownReads += 1; return { ok: false as const, definite: false }; },
    lineage: async () => ({ ok: true as const, value: inherited }),
  }, first);
  assert.deepEqual({ stored: second.stored, lineage: second.lineage, complete: second.complete },
    { stored: own, lineage: inherited, complete: true });
  assert.equal(ownReads, 1, "a source that answered is not read again");
  // So the delivered answer draws its real card, never "no longer available".
  assert.deepEqual(shape(rows([delivered("d", 3_000, [A])], second.stored, [], { loaded: true, lineage: second.lineage })), ["review:1b0c@d"]);
});

test("a review-history read that keeps failing backs off and stops, so it neither polls for good nor loads for good", async () => {
  const { historyRetryDelay } = await import("../src/web/lib/timelineReviews.ts");
  const waits: number[] = [];
  for (let attempt = 0; ; attempt++) {
    const wait = historyRetryDelay(attempt);
    if (wait === null) break;
    waits.push(wait);
    assert.ok(attempt < 50, "the schedule ends");
  }
  assert.deepEqual(waits, [5_000, 10_000, 20_000, 40_000, 60_000, 60_000], "doubling from 5 s, capped at 60 s, six retries");
});

test("a disabled review-history hook settles at once but as unread, so a delivered card neither loads for good nor reads as gone", async () => {
  const { useTimelineReviews } = await import("../src/web/lib/timelineReviews.ts");
  // The hook as a host drives it, feeding the merge exactly as the conversation panel does.
  function Probe({ enabled }: { enabled: boolean }) {
    const history = useTimelineReviews("s", [], enabled);
    const out = mergeConversation(transcriptRows([delivered("d", 3_000, [A])]), [], history.reviews, [],
      { loaded: history.loaded, failed: history.failed, lineage: history.lineage });
    const row = out.find((r) => r.kind === "delivered") as Extract<ConversationRow, { kind: "delivered" }>;
    return createElement(UnavailableReviewCard, {
      envelope: "answer", loading: row.loading, unreadable: row.unreadable, delivery: { state: "delivered", turnId: "d", at: 3_000 },
    });
  }
  // Disabled: nothing is fetched, so nothing is waited for, and nothing was read either: the
  // question may well exist, so the card says it could not be loaded rather than that it is gone.
  const disabled = renderToStaticMarkup(createElement(Probe, { enabled: false }));
  assert.doesNotMatch(disabled, /Loading the question/);
  assert.match(disabled, /Couldn(&#x27;|')t load the question/);
  assert.doesNotMatch(disabled, /no longer available/);
  // Enabled, before its read has settled: still loading, which is the case the flag separates.
  const enabled = renderToStaticMarkup(createElement(Probe, { enabled: true }));
  assert.match(enabled, /Loading the question/);
  assert.doesNotMatch(enabled, /Couldn(&#x27;|')t load the question/);
});
