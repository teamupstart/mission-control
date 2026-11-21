import { test } from "node:test";
import assert from "node:assert/strict";
import {
  asyncInputReceipt,
  decideWaitMode,
  questionHoldsCompletion,
  questionsAwaitingOperator,
  waitingOnOpenQuestion,
  WAITING_ON_ANSWER_REASON,
} from "../src/shared/async-input.ts";
import { detectAlerts } from "../src/shared/alerts.ts";
import { needsYouReason, reportBucket } from "../src/shared/session.ts";
import { CreateReviewSchema } from "../src/shared/protocol.ts";
import { deliversContinuation, reviewToolResult } from "../src/shared/review-item.ts";
import { stateDisplay } from "../src/web/lib/format.ts";
import type { ReviewItem, ReviewStatus, Session } from "../src/shared/types.ts";
import { mkSession, mkTaskSummary } from "./helpers/session-fixture.ts";

// The asynchronous input inbox, Phase 1 (docs/plans/async-input-inbox/phase-1-file-and-continue.md):
// the pure contracts every side reads - how an ask waits, what the agent is told, which
// questions hold completion, and who the board and the server say is waiting.

test("the wait mode is message only when every condition holds, and call otherwise", () => {
  const base = { flagOn: true, kind: "input" as const, snoozable: true, asyncCapable: true, messageable: true };
  assert.equal(decideWaitMode(base), "message");
  assert.equal(decideWaitMode({ ...base, flagOn: false }), "call", "flag off is exactly today's wait");
  assert.equal(decideWaitMode({ ...base, asyncCapable: false }), "call", "an older MCP child keeps long-polling");
  assert.equal(decideWaitMode({ ...base, messageable: false }), "call", "an answer message could never reach it");
  assert.equal(decideWaitMode({ ...base, snoozable: false }), "call", "another tool's confirmation stays a gate");
  for (const kind of ["plan", "diff", "plan-decisions"] as const) {
    assert.equal(decideWaitMode({ ...base, kind }), "call", `${kind} stays blocking`);
  }
});

test("the receipt says filed not answered, keep working reversibly, do not re-ask, and end the turn when out of work", () => {
  const text = asyncInputReceipt({ id: "rev-1" });
  const points = text.split("\n\n");
  assert.equal(points.length, 4);
  assert.match(points[0]!, /^Filed, not answered/);
  assert.match(points[0]!, /rev-1/);
  assert.match(points[0]!, /does not wait/);
  assert.match(points[1]!, /^Keep working/);
  assert.match(points[1]!, /easy to reverse/);
  assert.match(points[1]!, /irreversible or outward-facing/);
  assert.match(points[2]!, /Do not ask this question again and do not poll/);
  assert.match(points[2]!, /arrives as a message/);
  assert.match(points[3]!, /end your turn/);
  assert.match(points[3]!, /wakes it with the answer/);
});

test("meanwhile is one line of at most 300 characters, on input asks only", () => {
  const ask = { env: {}, kind: "input", title: "Q?", body: "Q?" };
  const parsed = CreateReviewSchema.parse({ ...ask, meanwhile: "  proceeding with eslint;\n the config\tis one file  " });
  assert.equal(parsed.meanwhile, "proceeding with eslint; the config is one file");
  assert.equal(CreateReviewSchema.safeParse({ ...ask, meanwhile: "x".repeat(300) }).success, true);
  assert.equal(CreateReviewSchema.safeParse({ ...ask, meanwhile: "x".repeat(301) }).success, false);
  assert.equal(CreateReviewSchema.safeParse({ env: {}, kind: "diff", title: "d", body: "d", meanwhile: "x" }).success, false);
  assert.equal(CreateReviewSchema.parse({ ...ask, asyncCapable: true }).asyncCapable, true);
});

function review(over: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: "r1", sessionId: "s1", kind: "input", title: "Q?", body: "Q?", status: "pending",
    response: null, snoozable: true, createdAt: 1, resolvedAt: null, ...over,
  };
}

test("both completion rules cover every outstanding request_input question: message mode always, call mode with the flag on", () => {
  for (const waitMode of [undefined, "message"] as const) {
    for (const status of ["pending", "snoozed"] as const) {
      const r = review({ status, ...(waitMode ? { waitMode } : {}) });
      assert.equal(questionHoldsCompletion(r, true), true, `${waitMode ?? "call"} ${status}, flag on`);
      assert.equal(questionHoldsCompletion(r, false), waitMode === "message", `${waitMode ?? "call"} ${status}, flag off`);
    }
  }
  for (const status of ["answered", "dismissed", "orphaned", "superseded", "withdrawn"] as ReviewStatus[]) {
    assert.equal(questionHoldsCompletion(review({ status, waitMode: "message" }), true), false, `${status} is settled`);
  }
  assert.equal(questionHoldsCompletion(review({ snoozable: undefined }), true), false, "another tool's confirmation");
  assert.equal(questionHoldsCompletion(review({ kind: "plan-decisions" }), true), false, "a gate holds through its own call");
});

function stopped(over: Partial<Session> = {}): Session {
  return mkSession({ state: "idle", stateConfirmed: true, openQuestions: 1, ...over });
}

test("reportBucket and the dashboard badge agree on the idle clause for working, stopped, unconfirmed and resident sessions", () => {
  const cases: Array<{ name: string; session: Session; bucket: string; label: string }> = [
    { name: "working past its question", session: stopped({ state: "working" }), bucket: "working", label: "working" },
    { name: "starting with a question", session: stopped({ state: "starting" }), bucket: "working", label: "starting" },
    { name: "stopped on its question", session: stopped(), bucket: "needs-you", label: WAITING_ON_ANSWER_REASON },
    { name: "unconfirmed with a question", session: stopped({ state: "working", stateConfirmed: false }), bucket: "needs-you", label: WAITING_ON_ANSWER_REASON },
    { name: "confirmed awaiting input keeps its label", session: stopped({ state: "awaiting_input" }), bucket: "needs-you", label: "needs input" },
    { name: "resident between iterations", session: stopped({ task: mkTaskSummary({ kind: "resident" }) }), bucket: "idle", label: "idle" },
    { name: "stopped with nothing open", session: stopped({ openQuestions: 0 }), bucket: "idle", label: "idle" },
    { name: "older snapshot without the field", session: stopped({ openQuestions: undefined as unknown as number }), bucket: "idle", label: "idle" },
  ];
  for (const { name, session, bucket, label } of cases) {
    assert.equal(reportBucket(session), bucket, `${name}: bucket`);
    const display = stateDisplay(session);
    assert.equal(display.label, label, `${name}: label`);
    assert.equal(display.tone === "attention", bucket === "needs-you", `${name}: the badge is amber exactly when the bucket is needs-you`);
  }
  assert.equal(needsYouReason(stopped()), WAITING_ON_ANSWER_REASON);
  assert.equal(needsYouReason(stopped({ state: "working" })), null, "a working agent is not waiting on you");
  assert.equal(needsYouReason(stopped({ task: mkTaskSummary({ kind: "resident" }) })), null);
  assert.equal(waitingOnOpenQuestion(stopped({ task: mkTaskSummary({ kind: "resident" }) })), false);
});

test("a call-mode review still needs you while the agent works, and a snoozed question alone does not", () => {
  // `pendingReviews` keeps its meaning: an agent stopped inside a call.
  assert.equal(reportBucket(mkSession({ state: "working", pendingReviews: 1 })), "needs-you");
  // A snoozed question is in neither count, so it turns nothing amber, as today.
  assert.equal(reportBucket(mkSession({ state: "idle", pendingReviews: 0, openQuestions: 0 })), "idle");
});

test("the readers that refuse to rebind or reset an agent count message-mode questions too", () => {
  assert.equal(questionsAwaitingOperator(mkSession({ pendingReviews: 0, openQuestions: 2 })), 2);
  assert.equal(questionsAwaitingOperator(mkSession({ pendingReviews: 1, openQuestions: 1 })), 2);
  assert.equal(questionsAwaitingOperator(mkSession({ pendingReviews: 0, openQuestions: undefined as unknown as number })), 0);
});

test("a new message-mode question alerts, titled by whether the agent is still working", () => {
  const question = review({ waitMode: "message", body: "Which linter should this repo use?" });
  const scope = (session: Session) => ({ sessions: [session], tasks: [], reviews: [question] });
  const working = mkSession({ state: "working", openQuestions: 0 });
  const raised = detectAlerts(scope(working), scope({ ...working, openQuestions: 1 }));
  assert.deepEqual(raised.map((a) => [a.id, a.kind, a.title, a.body]), [
    ["review:s1", "review", "App Bugfixes has a question, still working", "Which linter should this repo use?"],
  ]);
  const idle = mkSession({ state: "idle", openQuestions: 0 });
  assert.equal(detectAlerts(scope(idle), scope({ ...idle, openQuestions: 1 }))[0]?.title, "App Bugfixes needs your answer");
  // Stable counts stay silent, and no second alert fires when a working session later stops.
  const open = { ...working, openQuestions: 1 };
  assert.deepEqual(detectAlerts(scope(open), scope({ ...open, state: "idle" })).filter((a) => a.kind === "review"), []);
});

test("a message-mode question owes Foreman's and a standing approval's answer as a message; a call-mode one does not", () => {
  const foreman = { status: "answered" as const, resolvedBy: "foreman" as const, response: "eslint" };
  assert.equal(deliversContinuation(review({ ...foreman, waitMode: "message" })), true);
  assert.equal(deliversContinuation(review(foreman)), false);
  const standing = { ...foreman, resolvedBy: "standing-approval" as const };
  assert.equal(deliversContinuation(review({ ...standing, waitMode: "message" })), true);
  assert.equal(deliversContinuation(review(standing)), false, "a call-mode call returns it directly");
  assert.equal(deliversContinuation(review({ ...foreman, resolvedBy: "human" })), true);
  assert.equal(deliversContinuation(review({ status: "orphaned", waitMode: "message" })), false);
});

test("withdrawn and merge-closed questions read as unanswered results, never as decisions", () => {
  assert.deepEqual(reviewToolResult(review({ status: "withdrawn" })), {
    text: "Withdrawn without an answer: you took this question back, so the human no longer answers it.", isError: true,
  });
  assert.match(reviewToolResult(review({ status: "orphaned", closedReason: "merged" })).text, /^Closed unanswered: the task's pull request merged/);
  assert.match(reviewToolResult(review({ status: "orphaned" })).text, /^Review channel went away/);
});
