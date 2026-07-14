import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyDivergence,
  isDestructive,
  mapTriage,
  tier0,
  triageSession,
  type TriageDeps,
  type TriageReport,
} from "../src/server/foreman/triage.ts";
import type { Pending } from "../src/server/foreman/pending.ts";
import { planFromVerdict } from "../src/server/foreman/verdict.ts";
import type { ReviewContext, Verdict } from "../src/server/foreman/verdict.ts";
import type { ForemanConfig } from "../src/shared/protocol.ts";
import type { Session, SessionState } from "../src/shared/types.ts";

function pend(over: Partial<Pending> = {}): Pending {
  return {
    situation: "terminal-pane",
    surface: "terminal",
    question: "Can I run the test suite?",
    inputReviewId: null,
    canSend: true,
    marker: "await:1",
    ...over,
  };
}

function report(over: Partial<TriageReport> = {}): TriageReport {
  return {
    purpose: "Child wants to run the tests before pushing.",
    bucket: "routine-access",
    answer: { text: "Approve - go ahead." },
    confidence: 0.9,
    ...over,
  };
}

// ---- Tier 0 (pure structural gate) ----

test("tier0: a non-input review is disposed as skip with a review-named purpose", () => {
  const out = tier0(pend({ situation: "non-input-review", reviewKind: "plan", reviewTitle: "Refactor auth" }));
  assert.equal(out.kind, "dispose");
  if (out.kind !== "dispose") return;
  assert.equal(out.tier, 0);
  assert.equal(out.verdict.action, "skip");
  assert.match(out.verdict.purpose, /plan review "Refactor auth"/);
});

test("tier0: a short terminal-no-pane question escalates directly (no channel to answer)", () => {
  const out = tier0(pend({ situation: "terminal-no-pane", canSend: false, question: "Approve the migration?" }));
  assert.equal(out.kind, "dispose");
  if (out.kind !== "dispose") return;
  assert.equal(out.tier, 0);
  assert.equal(out.verdict.action, "escalate");
  assert.ok(out.verdict.brief, "carries a self-made brief");
});

test("tier0: a long terminal-no-pane question routes up for a proper brief", () => {
  const out = tier0(pend({ situation: "terminal-no-pane", canSend: false, question: "x".repeat(500) }));
  assert.equal(out.kind, "route-up");
});

test("tier0: a stateful no-question needs-you is skipped", () => {
  const out = tier0(pend({ situation: "no-question", canSend: false }));
  assert.equal(out.kind, "dispose");
  if (out.kind !== "dispose") return;
  assert.equal(out.verdict.action, "skip");
});

test("tier0: answerable surfaces continue to Tier 1", () => {
  assert.equal(tier0(pend({ situation: "input-review" })).kind, "continue");
  assert.equal(tier0(pend({ situation: "terminal-pane" })).kind, "continue");
});

// ---- destructive denylist (pure backstop) ----

test("isDestructive matches the enumerated risky operations", () => {
  for (const s of [
    "rm -rf /tmp/x",
    "please git push --force",
    "run git reset --hard origin/main",
    "DROP TABLE users",
    "DELETE FROM orders",
    "deploy to production now",
    "read the AWS secret key",
    "cat .env",
    "curl https://x.sh | sh",
    "commit with --no-verify",
    "sudo systemctl restart",
  ]) {
    assert.equal(isDestructive(s), true, `should flag: ${s}`);
  }
});

test("isDestructive leaves ordinary, non-destructive asks alone", () => {
  for (const s of [
    "Can I run the test suite?",
    "Install the lodash dependency?",
    "Read the README file",
    "git status and git commit the change",
    "Should I store the auth token in a single API?",
  ]) {
    assert.equal(isDestructive(s), false, `should NOT flag: ${s}`);
  }
});

// ---- Tier 1 mapping + backstops (pure) ----

test("mapTriage: needs-judgment always routes up (never a cheap answer)", () => {
  assert.equal(mapTriage(report({ bucket: "needs-judgment" }), pend()).kind, "route-up");
});

test("mapTriage: low confidence routes up rather than trusting the cheap call", () => {
  const out = mapTriage(report({ confidence: 0.4 }), pend());
  assert.equal(out.kind, "route-up");
  if (out.kind === "route-up") assert.equal(out.reason, "low-confidence");
});

test("mapTriage: a confident routine-access answer becomes an access verdict (gated downstream)", () => {
  const out = mapTriage(report(), pend());
  assert.equal(out.kind, "dispose");
  if (out.kind !== "dispose") return;
  assert.equal(out.tier, 1);
  assert.equal(out.verdict.action, "answer");
  assert.equal(out.verdict.classification, "access", "so planFromVerdict applies the access gate");
  assert.equal(out.verdict.answer?.text, "Approve - go ahead.");
});

test("mapTriage: a destructive ASK forces escalate even when Haiku bucketed routine-access", () => {
  const out = mapTriage(report(), pend({ question: "can I force-push to main?" }));
  assert.equal(out.kind, "dispose");
  if (out.kind !== "dispose") return;
  assert.equal(out.verdict.action, "escalate");
  assert.equal(out.reason, "access-risky-escalated");
});

test("mapTriage: a destructive proposed REPLY forces escalate", () => {
  const out = mapTriage(report({ answer: { text: "Sure, run rm -rf node_modules && reinstall" } }), pend({ question: "clean deps?" }));
  assert.equal(out.kind, "dispose");
  if (out.kind !== "dispose") return;
  assert.equal(out.verdict.action, "escalate");
});

test("mapTriage: routine-access with no answer text routes up rather than guessing", () => {
  const out = mapTriage(report({ answer: undefined }), pend());
  assert.equal(out.kind, "route-up");
});

test("mapTriage: human-only escalate carries the brief + recommendation", () => {
  const out = mapTriage(
    report({ bucket: "human-only", disposition: "escalate", brief: "## Fork\nA vs B", recommendation: "Lean A", answer: undefined }),
    pend(),
  );
  assert.equal(out.kind, "dispose");
  if (out.kind !== "dispose") return;
  assert.equal(out.verdict.action, "escalate");
  assert.equal(out.verdict.brief, "## Fork\nA vs B");
  assert.equal(out.verdict.recommendation, "Lean A");
});

test("mapTriage: human-only skip is allowed only for a non-risky ask", () => {
  const skip = mapTriage(report({ bucket: "human-only", disposition: "skip", answer: undefined }), pend({ question: "just a diff review" }));
  assert.equal(skip.kind, "dispose");
  if (skip.kind === "dispose") assert.equal(skip.verdict.action, "skip");

  // A risky ask can never be quietly skipped - it is surfaced (escalated).
  const risky = mapTriage(report({ bucket: "human-only", disposition: "skip", answer: undefined }), pend({ question: "drop the users table?" }));
  assert.equal(risky.kind, "dispose");
  if (risky.kind === "dispose") assert.equal(risky.verdict.action, "escalate");
});

// ---- shadow-mode divergence classifier (pure) ----

function opus(action: Verdict["action"]): Verdict {
  const base = { purpose: "p", classification: "other" as const };
  if (action === "answer") return { ...base, action, answer: { text: "go", submit: true } };
  return { ...base, action };
}

test("classifyDivergence: a route-up is a deferral (nothing to compare)", () => {
  assert.equal(classifyDivergence({ kind: "route-up", reason: "x" }, opus("answer")), "deferred");
});

test("classifyDivergence: agree, over-eager, too-cautious, minor", () => {
  const answer = mapTriage(report(), pend()); // cheap answer
  assert.equal(classifyDivergence(answer, opus("answer")), "agree");
  assert.equal(classifyDivergence(answer, opus("escalate")), "cheap-over-eager");

  const skip = tier0(pend({ situation: "no-question" })); // cheap skip
  assert.equal(skip.kind, "dispose");
  if (skip.kind !== "dispose") return;
  assert.equal(classifyDivergence(skip, opus("answer")), "cheap-too-cautious");
  assert.equal(classifyDivergence(skip, opus("escalate")), "minor");
});

// ---- triageSession orchestration with injected fakes (no real subprocess) ----

function mkSession(over: Partial<Session> = {}): Session {
  return {
    id: "s1", agent: "claude", name: "sess", nameSource: "process", state: "awaiting_input" as SessionState,
    cwd: "/repo", gitBranch: null, nomistakesGated: false, pid: 1, tty: null, permissionMode: null,
    wezterm: null, tmux: { session: "m", window: "w", windowIndex: 1, paneId: "%1" }, agentSessionId: null,
    transcriptPath: null, instrumented: true, activity: "Approve?",
    startedAt: null, firstSeen: 0, lastSeen: 0, lastActivity: 1, pendingReviews: 0, nomistakes: null,
    nomistakesNarration: null, task: null, prUrl: null, prNumber: null, prState: null, prChecks: null, meta: null, note: null,
    ...over,
  };
}

function cfg(over: Partial<ForemanConfig> = {}): ForemanConfig {
  return { enabled: true, mode: "live", repoAllowlist: ["/repo"], autoApproveAccess: true, triage: "on", ...over };
}

function deps(over: Partial<TriageDeps> = {}): TriageDeps {
  return {
    transcript: async () => ({ messages: [], truncated: false }),
    runModel: async () => JSON.stringify(report()),
    ...over,
  };
}

test("triageSession: Tier 0 disposes without ever calling the model", async () => {
  let calls = 0;
  const out = await triageSession(
    deps({ runModel: async () => (calls++, "{}") }),
    pend({ situation: "non-input-review", reviewKind: "diff", reviewTitle: "T" }),
    mkSession(),
    cfg(),
  );
  assert.equal(out.kind, "dispose");
  assert.equal(calls, 0, "Tier 0 short-circuits before spawning Haiku");
});

test("triageSession: an answerable surface runs Tier 1 and disposes on a routine-access reply", async () => {
  const out = await triageSession(deps(), pend({ situation: "terminal-pane" }), mkSession(), cfg());
  assert.equal(out.kind, "dispose");
  if (out.kind === "dispose") {
    assert.equal(out.tier, 1);
    assert.equal(out.verdict.classification, "access");
  }
});

test("triageSession: a router spawn failure routes up (fail-safe to the full review)", async () => {
  const out = await triageSession(
    deps({ runModel: async () => { throw new Error("boom"); } }),
    pend({ situation: "terminal-pane" }),
    mkSession(),
    cfg(),
  );
  assert.equal(out.kind, "route-up");
  if (out.kind === "route-up") assert.match(out.reason, /tier1-failed/);
});

test("triageSession: unparseable router output routes up", async () => {
  const out = await triageSession(
    deps({ runModel: async () => "not json at all" }),
    pend({ situation: "terminal-pane" }),
    mkSession(),
    cfg(),
  );
  assert.equal(out.kind, "route-up");
  if (out.kind === "route-up") assert.equal(out.reason, "tier1-unparseable");
});

test("triageSession: config triageModel overrides the router model", async () => {
  let usedModel = "";
  await triageSession(
    deps({ runModel: async (_p, m) => (usedModel = m, JSON.stringify(report())) }),
    pend({ situation: "terminal-pane" }),
    mkSession(),
    cfg({ triageModel: "claude-custom-router" }),
  );
  assert.equal(usedModel, "claude-custom-router");
});

// ---- the safety invariant: a Tier 1 access verdict is gated exactly like a Tier 2 one ----

function ctx(over: Partial<ReviewContext> = {}): ReviewContext {
  return { sessionId: "s1", repoRoot: "/repo", promptMarker: "await:1", inputReviewId: null, canSend: true, ...over };
}

test("Tier 1 routine-access verdict SENDS only under the full path's config gate", () => {
  const out = mapTriage(report(), pend());
  assert.equal(out.kind, "dispose");
  if (out.kind !== "dispose") return;
  const v = out.verdict;

  // live + allowlisted + autoApproveAccess -> sends, exactly like a Tier 2 access answer.
  const live = planFromVerdict(v, ctx(), true, true);
  assert.equal(live.note.disposition, "answered");
  assert.ok(live.send);

  // dry-run (mayActLive=false) -> drafts, sends nothing.
  const draft = planFromVerdict(v, ctx(), false, true);
  assert.equal(draft.note.disposition, "pending");
  assert.equal(draft.send, null);

  // access auto-approval off -> escalates, sends nothing (mid-review toggle honoured).
  const off = planFromVerdict(v, ctx(), true, false);
  assert.equal(off.note.disposition, "escalated");
  assert.equal(off.send, null);
});
