import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewItem } from "../src/shared/types.ts";

// The asynchronous input inbox, Phase 3, at the daemon: the two daemon rules the dashboard
// surfaces depend on. Remind me later on a message-mode question in its default mode sends the
// agent nothing, and the conversation's history route keeps every filed question, and every
// question a merge closed, across a reload.

const home = mkdtempSync(join(tmpdir(), "mission-async-input-dashboard-"));
process.env.MISSION_HOME = home;

const {
  openDb, insertReview, snoozeReviewRow, updateReviewStatus, loadConversationResolvedReviews, loadHumanResolvedReviews,
  conversationQuestionRecordSql,
} = await import("../src/server/db.ts");
const { isConversationQuestionRecord } = await import("../src/shared/review-item.ts");

after(() => rmSync(home, { recursive: true, force: true }));
openDb();

let seq = 0;
function question(over: Partial<ReviewItem> = {}): ReviewItem {
  const id = over.id ?? `q-${++seq}`;
  const review: ReviewItem = {
    id,
    sessionId: "s1",
    kind: "input",
    title: `Which linter? (${id})`,
    body: "Which linter should this repo use?",
    status: "pending",
    response: null,
    snoozable: true,
    waitMode: "message",
    meanwhile: "proceeding with eslint",
    decisions: [{ id: "q", question: "Which linter?", options: [{ id: "o0", label: "biome" }, { id: "o1", label: "eslint" }] }],
    createdAt: 1_000 + seq,
    resolvedAt: null,
    ...over,
  };
  insertReview(review);
  return review;
}

const snooze = (id: string, mode: "judgment" | "option" | "hold") =>
  snoozeReviewRow(id, { at: 5_000, until: 9_000, mode, optionId: mode === "option" ? "o0" : null, listening: false });

test("snoozing a message-mode question on Keep doing what it said owes the agent nothing", () => {
  assert.equal(snooze(question().id, "judgment")?.instructionOwed, false);
});

test("a provisional option or hold on a message-mode question is owed as a message, as before", () => {
  assert.equal(snooze(question().id, "option")?.instructionOwed, true);
  assert.equal(snooze(question().id, "hold")?.instructionOwed, true);
});

test("a detached call-mode question is still owed its judgment instruction", () => {
  const callMode = question({ waitMode: undefined, meanwhile: undefined });
  openDb().prepare("UPDATE reviews SET mcp_wait_detached_at = 2000 WHERE id = ?").run(callMode.id);
  assert.equal(snooze(callMode.id, "judgment")?.instructionOwed, true);
});

test("the history route keeps filed questions in every status, and merge-closed call-mode questions", () => {
  const session = "history";
  const open = question({ sessionId: session });
  const merged = question({ sessionId: session });
  updateReviewStatus(merged.id, "orphaned", null, 3_000, null, null, "merged");
  const withdrawn = question({ sessionId: session });
  updateReviewStatus(withdrawn.id, "withdrawn", "found it in the README", 3_100);
  const byForeman = question({ sessionId: session });
  updateReviewStatus(byForeman.id, "answered", "eslint", 3_200, null, "foreman");
  const callMerged = question({ sessionId: session, waitMode: undefined, meanwhile: undefined });
  updateReviewStatus(callMerged.id, "orphaned", null, 3_300, null, null, "merged");
  const callOrphaned = question({ sessionId: session, waitMode: undefined, meanwhile: undefined });
  updateReviewStatus(callOrphaned.id, "orphaned", null, 3_400);
  const human = question({ sessionId: session, waitMode: undefined, meanwhile: undefined });
  updateReviewStatus(human.id, "answered", "biome", 3_500, null, "human");

  const history = loadConversationResolvedReviews(session);
  assert.deepEqual(
    history.map((r) => r.id).sort(),
    [open.id, merged.id, withdrawn.id, byForeman.id, callMerged.id, human.id].sort(),
    "an ordinary orphaned call-mode question stays out, as before",
  );
  assert.equal(history.find((r) => r.id === merged.id)?.closedReason, "merged");
  assert.equal(history.find((r) => r.id === withdrawn.id)?.response, "found it in the README");
  // Oldest first, with an open question placed by when it was asked.
  const placed = history.map((r) => r.resolvedAt ?? r.createdAt);
  assert.deepEqual(placed, placed.toSorted((a, b) => a - b));
  // Never evidence of the operator's intent: the evidence read still sees only the human answer.
  assert.deepEqual(loadHumanResolvedReviews(session).map((r) => r.id), [human.id]);
});

test("the history query and the dashboard admit the same questions, from one definition", () => {
  // Every wait mode and every close reason, set and unset, through the real columns.
  const session = "agreement";
  const rows: ReviewItem[] = [];
  for (const waitMode of [undefined, "message" as const]) {
    for (const closedReason of [null, "merged" as const]) {
      const review = question({ sessionId: session, waitMode, meanwhile: undefined });
      if (closedReason) updateReviewStatus(review.id, "orphaned", null, 4_000, null, null, closedReason);
      rows.push({ ...review, closedReason });
    }
  }
  const bySql = new Set((openDb()
    .prepare(`SELECT id FROM reviews WHERE session_id = ? AND ${conversationQuestionRecordSql()}`)
    .all(session) as Array<{ id: string }>).map((row) => row.id));
  for (const review of rows) {
    assert.equal(bySql.has(review.id), isConversationQuestionRecord(review), `${review.waitMode ?? "call"} / ${review.closedReason ?? "open"}`);
  }
  assert.equal(bySql.size, 3, "message-mode in either state, and the merge-closed call-mode question");
});
