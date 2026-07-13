import { test } from "node:test";
import assert from "node:assert/strict";
import type { ForemanConfig } from "../src/shared/protocol.ts";
import {
  applyVerdict,
  foremanMayActLive,
  planFromVerdict,
  type ForemanActions,
  type ReviewContext,
  type Verdict,
} from "../src/server/foreman/verdict.ts";
import { extractVerdict } from "../src/server/foreman/review.ts";

function ctx(over: Partial<ReviewContext> = {}): ReviewContext {
  return {
    sessionId: "s1",
    repoRoot: "/repo",
    promptMarker: "await:100",
    inputReviewId: null,
    canSend: true,
    ...over,
  };
}

function cfg(over: Partial<ForemanConfig> = {}): ForemanConfig {
  return { enabled: true, mode: "live", repoAllowlist: ["/repo"], autoApproveAccess: true, ...over };
}

const ANSWER: Verdict = {
  purpose: "Wiring the auth refactor; deciding how to store tokens.",
  classification: "implementation",
  action: "answer",
  answer: { text: "Use option D: one token store behind a single API.", submit: true },
  confidence: 0.9,
};

test("live + allowlisted answer -> sends via terminal and marks answered", () => {
  const plan = planFromVerdict(ANSWER, ctx(), true);
  assert.equal(plan.note.disposition, "answered");
  assert.equal(plan.note.purpose, ANSWER.purpose);
  assert.equal(plan.note.handledMarker, "await:100");
  assert.ok(plan.send);
  assert.equal(plan.send?.channel, "send");
  assert.equal(plan.send?.text, ANSWER.answer!.text);
});

test("dry-run (mayActLive=false) drafts a reply and sends nothing", () => {
  const plan = planFromVerdict(ANSWER, ctx(), false);
  assert.equal(plan.note.disposition, "pending");
  assert.equal(plan.note.recommendation, ANSWER.answer!.text);
  assert.equal(plan.send, null);
});

test("answer to an input review resolves that review, not the terminal", () => {
  const plan = planFromVerdict(ANSWER, ctx({ inputReviewId: "rev-9", canSend: false }), true);
  assert.equal(plan.send?.channel, "review");
  assert.equal(plan.send?.reviewId, "rev-9");
});

test("answer with no deliverable channel escalates with the drafted text", () => {
  const plan = planFromVerdict(ANSWER, ctx({ canSend: false, inputReviewId: null }), true);
  assert.equal(plan.note.disposition, "escalated");
  assert.equal(plan.note.recommendation, ANSWER.answer!.text);
  assert.equal(plan.send, null);
});

test("escalate writes brief + recommendation and never sends", () => {
  const v: Verdict = {
    purpose: "p",
    classification: "design-fork",
    action: "escalate",
    brief: "## Fork\nA vs B",
    recommendation: "Lean A",
    confidence: 0.4,
  };
  const plan = planFromVerdict(v, ctx(), true);
  assert.equal(plan.note.disposition, "escalated");
  assert.equal(plan.note.brief, "## Fork\nA vs B");
  assert.equal(plan.note.recommendation, "Lean A");
  assert.equal(plan.send, null);
});

test("skip writes only a purpose", () => {
  const v: Verdict = { purpose: "just a diff review", classification: "other", action: "skip" };
  const plan = planFromVerdict(v, ctx(), true);
  assert.equal(plan.note.disposition, "skipped");
  assert.equal(plan.note.purpose, "just a diff review");
  assert.equal(plan.send, null);
});

test("foremanMayActLive: only enabled + live + allowlisted (prefix) cwd sends", () => {
  assert.equal(foremanMayActLive(cfg(), "/repo"), true);
  assert.equal(foremanMayActLive(cfg(), "/repo/worktrees/x"), true, "worktree under an allowlisted root");
  assert.equal(foremanMayActLive(cfg(), "/other"), false, "off the allowlist");
  assert.equal(foremanMayActLive(cfg({ mode: "dry-run" }), "/repo"), false);
  assert.equal(foremanMayActLive(cfg({ enabled: false }), "/repo"), false);
  assert.equal(foremanMayActLive(cfg(), null), false);
  assert.equal(foremanMayActLive(cfg({ repoAllowlist: ["/repofoo"] }), "/repo"), false, "no partial-token match");
});

test("applyVerdict: live answer writes the note then sends once", async () => {
  const calls: string[] = [];
  const actions: ForemanActions = {
    putNote: async () => (calls.push("putNote"), {}),
    sendText: async () => (calls.push("sendText"), {}),
    resolveReview: async () => (calls.push("resolveReview"), {}),
  };
  const plan = planFromVerdict(ANSWER, ctx(), true);
  await applyVerdict(actions, ctx(), plan);
  assert.deepEqual(calls, ["putNote", "sendText"]);
});

test("applyVerdict: dry-run draft writes the note and sends nothing", async () => {
  const calls: string[] = [];
  const actions: ForemanActions = {
    putNote: async () => (calls.push("putNote"), {}),
    sendText: async () => (calls.push("sendText"), {}),
    resolveReview: async () => (calls.push("resolveReview"), {}),
  };
  await applyVerdict(actions, ctx(), planFromVerdict(ANSWER, ctx(), false));
  assert.deepEqual(calls, ["putNote"]);
});

test("extractVerdict unwraps the claude -p envelope and fenced JSON", () => {
  const verdict = {
    purpose: "p",
    classification: "access",
    action: "answer",
    answer: { text: "Approve - go ahead." },
  };
  const envelope = JSON.stringify({ result: "```json\n" + JSON.stringify(verdict) + "\n```" });
  const got = extractVerdict(envelope);
  assert.equal(got?.action, "answer");
  assert.equal(got?.answer?.text, "Approve - go ahead.");
});

test("extractVerdict handles a bare object and rejects invalid output", () => {
  const bare = '{"purpose":"p","classification":"other","action":"skip"}';
  assert.equal(extractVerdict(bare)?.action, "skip");
  assert.equal(extractVerdict("not json at all"), null);
  // action=answer without answer.text must fail the schema refine.
  assert.equal(extractVerdict('{"purpose":"p","classification":"other","action":"answer"}'), null);
});
