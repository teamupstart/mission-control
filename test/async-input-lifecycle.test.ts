import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asyncInputAnswer } from "../src/shared/async-input.ts";
import { requestInputReview } from "../src/shared/request-input.ts";
import { reviewToolResult, formatResponse } from "../src/shared/review-item.ts";
import type { ReviewItem } from "../src/shared/types.ts";

const home = mkdtempSync(join(tmpdir(), "async-lifecycle-"));
process.env.MISSION_HOME = home;
const { openDb, closeDb, insertReview, updateReviewStatus, createReviewContinuationPendingTurn,
  createPendingTurn, loadReviewContinuationCandidates, listPendingTurns, claimNextPendingTurn, MESSAGE_ANSWER_TURN_PREFIX } = await import("../src/server/db.ts");
after(() => { closeDb(); rmSync(home, { recursive: true, force: true }); });

function question(id: string): ReviewItem {
  return { ...requestInputReview({ question: "What should we call the new setting?", context: "The current label is provisional." }),
    id, sessionId: `s-${id}`, status: "answered", response: "Use Archive", resolvedBy: "human",
    createdAt: 1000, resolvedAt: 61000, meanwhile: "I will prepare the reversible migration.", waitMode: "message", snoozable: true };
}

for (const shape of ["open-ended", "answered", "dismissed", "chat"] as const) {
  test(`self-contained answer: ${shape}`, () => {
    const r = question(shape);
    if (shape !== "open-ended") Object.assign(r, requestInputReview({ question: "Which setting name?", options: [{ label: "Archive" }] }));
    if (shape === "dismissed") Object.assign(r, { status: "dismissed", response: null });
    if (shape === "chat") Object.assign(r, { selections: [{ decisionId: "q", selected: [], chat: true, other: null }] });
    if (shape === "chat") r.response = formatResponse(r.decisions!, r.selections!, "Answered:");
    const text = asyncInputAnswer(r, 61000);
    assert.ok(text.includes(r.body));
    assert.ok(text.includes(r.meanwhile!));
    assert.ok(text.includes(reviewToolResult(r).text));
    assert.match(text, /asked 60 seconds ago/);
    assert.match(text, /Resume anything/);
    assert.match(text, shape === "dismissed" ? /Keep the choice/ : /Reconcile/);
    if (shape === "chat") assert.match(text, /Chat about it/);
  });
}

test("self-contained answer explains when no meanwhile plan was supplied", () => {
  const review = question("no-meanwhile");
  delete review.meanwhile;

  const text = asyncInputAnswer(review, 61000);
  assert.ok(text.includes("You said you would do meanwhile: No meanwhile plan was supplied."));
  assert.ok(text.includes("What should we call the new setting?"));
  assert.ok(text.includes("The current label is provisional."));
  assert.ok(text.includes("Use Archive"));
});

for (const count of [2, 5]) test(`${count} answers coalesce durably, without duplicate replay or a reset escalation clock`, () => {
  const key = `batch-${count}`;
  const reviews = Array.from({ length: count }, (_, n) => question(`${key}-${n}`));
  for (const r of reviews) {
    insertReview({ ...r, status: "pending" });
    updateReviewStatus(r.id, "answered", r.response, 61000, null, "human");
    const row = createReviewContinuationPendingTurn({ reviewId: r.id, noteKey: key, text: asyncInputAnswer(r, 61000), now: 61000 + reviews.indexOf(r) });
    assert.ok(row);
    closeDb(); openDb(); // No in-memory group or idempotency state survives.
  }
  const rows = listPendingTurns(key);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.id, `${MESSAGE_ANSWER_TURN_PREFIX}${reviews[0]!.id}`);
  assert.equal(rows[0]!.createdAt, 61000);
  for (const r of reviews) {
    assert.ok(rows[0]!.text.includes(asyncInputAnswer(r, 61000)));
    assert.deepEqual(loadReviewContinuationCandidates(r.id), []);
    assert.equal(createReviewContinuationPendingTurn({ reviewId: r.id, noteKey: key, text: "duplicate", now: 99999 }), null);
  }
  assert.equal(listPendingTurns(key)[0]!.text, rows[0]!.text);
});

test("a claimed answer is immutable; later answers form a second message, isolated from call-mode rows", () => {
  const key = "claimed";
  const queue = (id: string, waitMode: "message" | null = "message") => {
    const r = { ...question(id), waitMode: waitMode ?? undefined };
    insertReview({ ...r, status: "pending" });
    if (!waitMode) openDb().prepare("UPDATE reviews SET mcp_wait_detached_at = 1 WHERE id = ?").run(id);
    updateReviewStatus(id, "answered", r.response, 61000, null, "human");
    return createReviewContinuationPendingTurn({ reviewId: id, noteKey: key, text: id, now: 61000 })!;
  };
  const first = queue("first");
  assert.ok(claimNextPendingTurn(key, 62000));
  queue("second"); queue("third"); queue("blocking", null);
  const rows = listPendingTurns(key);
  assert.equal(rows.length, 3);
  assert.equal(rows.find((r) => r.id === first.id)!.text, "first");
  assert.equal(rows[1]!.text, "second\n\n---\n\nthird");
  assert.equal(rows[2]!.id, "review-continuation:blocking");
});


test("answers coalesce only at the queue tail without passing an intervening operator message", () => {
  const noteKey = "answer-message-answer";
  const queueAnswer = (id: string) => {
    const review = question(id);
    insertReview({ ...review, status: "pending" });
    updateReviewStatus(id, "answered", review.response, 61000, null, "human");
    return createReviewContinuationPendingTurn({ reviewId: id, noteKey, text: id, now: 61000 })!;
  };
  const first = queueAnswer("fifo-answer-A");
  const message = createPendingTurn({ id: "fifo-operator", noteKey, text: "Operator instruction between answers", now: 62000 });
  const second = queueAnswer("fifo-answer-B");
  closeDb(); openDb();
  const third = queueAnswer("fifo-answer-C");
  const rows = listPendingTurns(noteKey);
  assert.deepEqual(rows.map((r) => r.id), [first.id, message.id, second.id]);
  assert.equal(third.id, second.id, "the contiguous answer tail still combines");
  assert.deepEqual(rows.map((r) => r.text), ["fifo-answer-A", message.text, "fifo-answer-B\n\n---\n\nfifo-answer-C"]);
  for (const id of ["fifo-answer-A", "fifo-answer-B", "fifo-answer-C"]) {
    assert.deepEqual(loadReviewContinuationCandidates(id), [], "each review was stamped atomically");
    assert.equal(createReviewContinuationPendingTurn({ reviewId: id, noteKey, text: "duplicate", now: 63000 }), null);
  }
});
