import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPending } from "../src/server/foreman/pending.ts";
import type { ReviewItem, Session, SessionState } from "../src/shared/types.ts";

function mkSession(over: Partial<Session> = {}): Session {
  return {
    id: "s1",
    agent: "claude",
    name: "sess",
    nameSource: "process",
    state: "working" as SessionState,
    cwd: null,
    gitBranch: null,
    gitRoot: null,
    nomistakesGated: false,
    pid: 1,
    tty: null,
    permissionMode: null,
    wezterm: null,
    tmux: null,
    agentSessionId: null,
    transcriptPath: null,
    instrumented: true,
    hooksSeen: true,
    activity: null,
    startedAt: null,
    firstSeen: 0,
    lastSeen: 0,
    lastActivity: null,
    pendingReviews: 0,
    nomistakes: null,
    nomistakesNarration: null,
    task: null,
    prUrl: null,
    prNumber: null,
    prState: null,
    prChecks: null,
    meta: null,
    note: null,
    queue: null,
    orphanedQueue: null,
    ...over,
  };
}

function mkReview(over: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: "r1",
    sessionId: "s1",
    kind: "input",
    title: "A question",
    body: "Which option?",
    status: "pending",
    response: null,
    createdAt: 0,
    resolvedAt: null,
    ...over,
  };
}

test("a pending input review is answerable via that review", () => {
  const p = classifyPending(mkSession(), [mkReview({ id: "rev-1", body: "A or B?" })]);
  assert.equal(p.situation, "input-review");
  assert.equal(p.surface, "input-review");
  assert.equal(p.inputReviewId, "rev-1");
  assert.equal(p.question, "A or B?");
  assert.equal(p.canSend, false);
  assert.equal(p.marker, "review:rev-1");
});

test("a plan/diff review is non-input (human-only) and carries its kind + title", () => {
  const p = classifyPending(mkSession(), [
    mkReview({ id: "rev-2", kind: "plan", title: "Refactor auth", body: "the plan" }),
  ]);
  assert.equal(p.situation, "non-input-review");
  assert.equal(p.inputReviewId, null, "not directly answerable");
  assert.equal(p.reviewKind, "plan");
  assert.equal(p.reviewTitle, "Refactor auth");
  assert.equal(p.marker, "review:rev-2");
});

test("an input review wins over a plan review posted at the same time", () => {
  const p = classifyPending(mkSession(), [
    mkReview({ id: "plan-1", kind: "plan", title: "P" }),
    mkReview({ id: "in-1", kind: "input", body: "answer me" }),
  ]);
  assert.equal(p.situation, "input-review");
  assert.equal(p.inputReviewId, "in-1");
});

test("awaiting_input with a tmux pane is answerable by typing", () => {
  const p = classifyPending(
    mkSession({
      state: "awaiting_input",
      activity: "Approve? (y/n)",
      tmux: { session: "m", window: "w", windowIndex: 1, paneId: "%1" },
      lastActivity: 500,
    }),
    [],
  );
  assert.equal(p.situation, "terminal-pane");
  assert.equal(p.surface, "terminal");
  assert.equal(p.canSend, true);
  assert.equal(p.question, "Approve? (y/n)");
  assert.equal(p.marker, "await:500");
});

test("awaiting_input with no pane has a question but no delivery channel", () => {
  const p = classifyPending(
    mkSession({ state: "awaiting_input", activity: "Approve?", tmux: null, wezterm: null, lastActivity: 7 }),
    [],
  );
  assert.equal(p.situation, "terminal-no-pane");
  assert.equal(p.canSend, false);
  assert.equal(p.marker, "await:7");
});

test("a needs-you session in some other state has no answerable question", () => {
  const p = classifyPending(mkSession({ state: "idle" as SessionState, lastActivity: 3 }), []);
  assert.equal(p.situation, "no-question");
  assert.equal(p.canSend, false);
  assert.equal(p.marker, "state:idle:3");
});

test("only pending reviews for THIS session are considered", () => {
  const p = classifyPending(mkSession({ id: "s1" }), [
    mkReview({ id: "other", sessionId: "s2", kind: "input" }),
    mkReview({ id: "resolved", sessionId: "s1", kind: "input", status: "answered" }),
  ]);
  // Neither review applies (wrong session / already resolved) -> falls through to state.
  assert.equal(p.situation, "no-question");
});
