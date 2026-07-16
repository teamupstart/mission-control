import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CreateReviewSchema } from "../src/shared/protocol.ts";
import type { PlanDecision, ReviewItem } from "../src/shared/types.ts";

// Throwaway home BEFORE config.ts resolves the state dir at module load, so this
// never touches the real ~/.mission-control db (db must be imported dynamically after).
const home = mkdtempSync(join(tmpdir(), "mission-plan-decisions-db-"));
process.env.MISSION_HOME = home;

const { openDb, insertReview, updateReviewStatus, loadPendingReviews } = await import(
  "../src/server/db.ts"
);

after(() => rmSync(home, { recursive: true, force: true }));

openDb();

const decisions: PlanDecision[] = [
  {
    id: "store",
    question: "Where should sessions live?",
    options: [
      { id: "redis", label: "Redis", detail: "one more service", recommended: true },
      { id: "pg", label: "Postgres" },
    ],
  },
  {
    id: "providers",
    question: "Which providers?",
    options: [
      { id: "google", label: "Google" },
      { id: "github", label: "GitHub" },
    ],
    multiSelect: true,
    allowOther: true,
  },
];

function review(over: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: `r-${Math.random().toString(36).slice(2)}`,
    sessionId: "s1",
    kind: "plan-decisions",
    title: "Auth plan",
    body: "# Auth\n\nthe plan",
    status: "pending",
    response: null,
    decisions,
    createdAt: 1000,
    resolvedAt: null,
    ...over,
  };
}

test("a plan-decisions review round-trips its decisions through the db", () => {
  const r = review();
  insertReview(r);
  const loaded = loadPendingReviews().find((x) => x.id === r.id);
  assert.ok(loaded, "the review reloads as pending");
  assert.equal(loaded.kind, "plan-decisions");
  assert.deepEqual(loaded.decisions, decisions, "decisions survive insert -> reload intact");
});

test("a review with no decisions reloads with decisions null, not a crash", () => {
  const r = review({ id: "r-plain", kind: "plan", decisions: null });
  insertReview(r);
  const loaded = loadPendingReviews().find((x) => x.id === "r-plain");
  assert.ok(loaded);
  assert.equal(loaded.decisions, null);
});

test("resolving a decisions review drops it from the pending set", () => {
  const r = review({ id: "r-resolve" });
  insertReview(r);
  updateReviewStatus("r-resolve", "answered", "Plan decisions submitted:\n\n• ...", 2000);
  assert.equal(
    loadPendingReviews().find((x) => x.id === "r-resolve"),
    undefined,
    "an answered review is no longer pending",
  );
});

/**
 * The decisions column is free text; a corrupt blob must degrade to "no decisions"
 * (the card renders as a plain plan) rather than throwing and taking every other
 * pending review down with it on reload.
 */
test("a malformed decisions blob degrades to null instead of throwing", () => {
  openDb()
    .prepare(
      `INSERT INTO reviews (id, session_id, kind, title, body, status, response, decisions, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("r-corrupt", "s1", "plan-decisions", "t", "b", "pending", null, "not json{", 1000, null);
  const loaded = loadPendingReviews().find((x) => x.id === "r-corrupt");
  assert.ok(loaded, "the corrupt row still loads");
  assert.equal(loaded.decisions, null, "and its decisions read as null");
});

// ---- protocol ----

const base = { env: {}, kind: "plan-decisions" as const, title: "t", body: "b" };

test("CreateReviewSchema accepts the new kind with decisions", () => {
  const parsed = CreateReviewSchema.safeParse({ ...base, decisions });
  assert.ok(parsed.success, "a well-formed decisions payload parses");
  assert.equal(parsed.data.decisions?.length, 2);
});

test("CreateReviewSchema still accepts a plain plan with no decisions", () => {
  const parsed = CreateReviewSchema.safeParse({ ...base, kind: "plan" });
  assert.ok(parsed.success);
  assert.equal(parsed.data.decisions, undefined);
});

test("CreateReviewSchema rejects a decision with no options", () => {
  const parsed = CreateReviewSchema.safeParse({
    ...base,
    decisions: [{ id: "x", question: "q?", options: [] }],
  });
  assert.equal(parsed.success, false, "an empty option list is not a decision");
});
