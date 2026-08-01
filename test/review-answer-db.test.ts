import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlanDecision, ReviewItem } from "../src/shared/types.ts";

// Throwaway home BEFORE config.ts resolves the state dir at module load, so this never
// touches the real ~/.mission-control db (db must be imported dynamically after).
const home = mkdtempSync(join(tmpdir(), "mission-review-answer-db-"));
process.env.MISSION_HOME = home;

const { openDb, insertReview, updateReviewStatus, loadHumanResolvedReviews } = await import(
  "../src/server/db.ts"
);

after(() => rmSync(home, { recursive: true, force: true }));

openDb();

// What is at stake: the conversation's review entries have to survive a daemon restart.
//
// The registry reloads exactly the PENDING rows at boot (`loadPendingReviews`), so a
// resolved review is simply not in memory afterwards. If the log were drawn from that map,
// every answer you gave would quietly empty out of the conversation on restart while the
// transcript beside it survived. So the durable half is read straight from SQLite - and
// what it selects has to match the predicate the dashboard applies to the live half, or an
// entry shown on submit would vanish on reload.

const decisions: PlanDecision[] = [
  {
    id: "q",
    question: "Which linter?",
    options: [
      { id: "o0", label: "biome" },
      { id: "o1", label: "eslint", recommended: true },
    ],
  },
];

function review(id: string, over: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id,
    sessionId: "s1",
    kind: "input",
    title: "Which linter?",
    body: "Which linter?",
    status: "pending",
    response: null,
    decisions,
    selections: null,
    resolvedBy: null,
    createdAt: 1000,
    resolvedAt: null,
    ...over,
  };
}

test("an answered review round-trips its selections and its actor", () => {
  insertReview(review("r-answered"));
  updateReviewStatus(
    "r-answered",
    "answered",
    "Answered:\n\n• Which linter?\n  → eslint",
    2000,
    [{ decisionId: "q", selected: ["o1"], other: "pinned" }],
    "human",
  );
  const loaded = loadHumanResolvedReviews("s1").find((r) => r.id === "r-answered");
  assert.ok(loaded, "it comes back as one of this session's human answers");
  assert.equal(loaded.resolvedBy, "human");
  assert.deepEqual(loaded.selections, [{ decisionId: "q", selected: ["o1"], other: "pinned" }]);
  assert.deepEqual(loaded.decisions, decisions, "the question survives beside the answer");
});

test("Foreman's answer is stored but kept out of the conversation", () => {
  // Stored, because the record of who answered is worth keeping. Not returned, because
  // Foreman is already in the log as its own episode.
  insertReview(review("r-foreman"));
  updateReviewStatus("r-foreman", "answered", "foreman said so", 2000, null, "foreman");
  assert.equal(
    loadHumanResolvedReviews("s1").find((r) => r.id === "r-foreman"),
    undefined,
  );
});

test("a pending review is not in the conversation", () => {
  insertReview(review("r-pending"));
  assert.equal(
    loadHumanResolvedReviews("s1").find((r) => r.id === "r-pending"),
    undefined,
  );
});

test("an orphaned review is nobody's answer", () => {
  // The session went away before anyone decided - the daemon's settle, not a human's.
  insertReview(review("r-orphan"));
  updateReviewStatus("r-orphan", "orphaned", null, 2000, null, null);
  assert.equal(
    loadHumanResolvedReviews("s1").find((r) => r.id === "r-orphan"),
    undefined,
  );
});

test("a dismissal IS in the conversation", () => {
  // Closing a question without choosing is a decision the agent was told about, so the log
  // owes the reader the same account of it.
  insertReview(review("r-dismissed"));
  updateReviewStatus("r-dismissed", "dismissed", null, 2100, null, "human");
  const loaded = loadHumanResolvedReviews("s1").find((r) => r.id === "r-dismissed");
  assert.ok(loaded);
  assert.equal(loaded.status, "dismissed");
  assert.equal(loaded.selections, null, "nothing was chosen, so nothing is stored");
});

test("approvals and change requests are in the conversation too", () => {
  insertReview(review("r-approved", { kind: "diff" }));
  updateReviewStatus("r-approved", "approved", "ship it", 2200, null, "human");
  insertReview(review("r-rejected", { kind: "diff" }));
  updateReviewStatus("r-rejected", "rejected", "split the migration out", 2300, null, "human");
  const ids = loadHumanResolvedReviews("s1").map((r) => r.id);
  assert.ok(ids.includes("r-approved"), "an approved diff is a thing you said");
  assert.ok(ids.includes("r-rejected"), "so is sending one back");
});

test("answers come back oldest-first, the order they are read in", () => {
  const stamps = loadHumanResolvedReviews("s1").map((r) => r.resolvedAt ?? 0);
  assert.deepEqual([...stamps].sort((a, b) => a - b), stamps, "ascending by resolution time");
});

test("another session's answers stay in that session's conversation", () => {
  insertReview(review("r-other", { sessionId: "s2" }));
  updateReviewStatus("r-other", "answered", "elsewhere", 2400, null, "human");
  assert.equal(
    loadHumanResolvedReviews("s1").find((r) => r.id === "r-other"),
    undefined,
  );
  assert.ok(loadHumanResolvedReviews("s2").find((r) => r.id === "r-other"));
});

test("a malformed selections blob degrades to null instead of throwing", () => {
  // The column is free text. One corrupt row must not take down every other answer in the
  // conversation with it; the card falls back to the response prose.
  openDb()
    .prepare(
      `INSERT INTO reviews
         (id, session_id, kind, title, body, status, response, decisions, selections, resolved_by, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("r-corrupt", "s1", "input", "t", "b", "answered", "said so", null, "not json{", "human", 1000, 2500);
  const loaded = loadHumanResolvedReviews("s1").find((r) => r.id === "r-corrupt");
  assert.ok(loaded, "the corrupt row still loads");
  assert.equal(loaded.selections, null, "and its selections read as null");
  assert.equal(loaded.response, "said so", "so the card can still show what was said");
});

test("a row written before the actor column is not credited to the human", () => {
  // The upgrade path: `resolved_by` is added by ALTER, so every review resolved before this
  // shipped reads as NULL. It may well have been a human, but the record does not say so.
  openDb()
    .prepare(
      `INSERT INTO reviews (id, session_id, kind, title, body, status, response, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("r-legacy", "s1", "input", "t", "b", "answered", "said so", 1000, 2600);
  assert.equal(
    loadHumanResolvedReviews("s1").find((r) => r.id === "r-legacy"),
    undefined,
  );
});
