import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPending } from "../src/server/foreman/pending.ts";
import { planFromVerdict, VerdictSchema } from "../src/server/foreman/verdict.ts";
import type { ReviewItem, Session, SessionState } from "../src/shared/types.ts";
import { mkMuxHandle } from "./helpers/session-fixture.ts";

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
    repoRoot: null,
    nomistakesGated: false,
    pid: 1,
    tty: null,
    permissionMode: null,
    terminals: [],
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
    nomistakesFixes: [],
    nomistakesNarration: null,
    task: null,
    prUrl: null,
    prNumber: null,
    prState: null,
    prChecks: null,
    meta: null,
    note: null, cost: null, goal: null,
    queue: null,
    orphanedQueue: null,
    inspector: null,
    paneDialog: null,
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
      terminals: [mkMuxHandle({ session: "m", windowIndex: 1 })],
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
    mkSession({ state: "awaiting_input", activity: "Approve?", terminals: [], lastActivity: 7 }),
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

function mkGateParked(over: Partial<Session> = {}): Session {
  return mkSession({
    // `gateParked` requires the driving agent to have STOPPED, so the state is `idle`:
    // the run is parked, but nothing is blocked on an MCP call and no Notification fired.
    state: "idle" as SessionState,
    terminals: [mkMuxHandle({ session: "m", windowIndex: 1 })],
    nomistakes: {
      id: "run-01",
      status: "running",
      branch: "feat/x",
      startedAt: 1000,
      endedAt: null,
      prUrl: null,
      awaitingAgent: "parked 1m30s",
      findingsSummary: "1 awaiting",
      gateStep: "review",
      gateSummary: null,
      gateRisk: null,
      steps: [],
      activeSteps: [],
      findings: [
        { id: "r1", severity: "warning", file: "a.go", action: "auto-fix", description: "Ignored error" },
        {
          id: "r2",
          severity: "error",
          file: "cmd/main.go",
          action: "ask-user",
          description: "New --force flag bypasses the confirm prompt",
        },
      ],
      outcome: null,
    },
    ...over,
  });
}

test("a gate-parked no-mistakes run is an answerable question, not a no-question", () => {
  const p = classifyPending(mkGateParked(), []);
  assert.equal(p.situation, "gate-parked");
  assert.equal(p.surface, "terminal");
  assert.equal(p.canSend, true, "a pane exists, so Foreman can type the decision");
  assert.match(p.question, /review/, "names the gate it is parked at");
  assert.match(p.question, /r2/, "names the ask-user finding needing the call");
  assert.match(p.question, /--force flag bypasses/, "carries the finding verbatim");
  assert.doesNotMatch(p.question, /r1/, "auto-fix findings are the agent's job, not yours");
});

test("the gate marker keys on the run, so the NEXT run on that branch is not skipped", () => {
  // Successive runs share a branch. A branch-keyed marker would let run 2 inherit run 1's
  // handledMarker at the same step and be silently dropped - which is why NmRunSummary
  // carries an id at all.
  const first = classifyPending(mkGateParked(), []);
  const second = mkGateParked();
  second.nomistakes!.id = "run-02";
  assert.notEqual(classifyPending(second, []).marker, first.marker);
});

test("the gate marker is stable while parked, so one gate is handled once", () => {
  // `awaitingAgent` ticks ("parked 1m30s" -> "parked 2m10s"). If it reached the marker, every
  // loop would look like a new episode and re-spawn a review on the same gate.
  const a = classifyPending(mkGateParked(), []);
  const b = mkGateParked();
  b.nomistakes!.awaitingAgent = "parked 9m99s";
  assert.equal(classifyPending(b, []).marker, a.marker);
});

test("re-parking the SAME step with new findings is a new episode, not a handled one", () => {
  // A run works its review step in ROUNDS: the ask is answered, fixes land, review re-runs and
  // parks again with different findings. Run id + step alone repeat, so the marker would match
  // the first round's handledMarker and every later round would be silently skipped.
  const round1 = classifyPending(mkGateParked(), []);
  const s = mkGateParked();
  s.nomistakes!.findings = [
    { id: "r7", severity: "error", file: "cmd/main.go", action: "ask-user", description: "The new guard drops the CI path" },
  ];
  const round2 = classifyPending(s, []);
  assert.notEqual(round2.marker, round1.marker, "round 2 must be reviewed, not inherit round 1");
  assert.match(round2.marker, /^gate:run-01:review:/, "still keyed on the run and its step");
});

test("re-parking with the SAME findings keeps the marker, so a gate stays handled once", () => {
  // The flip side: the digest must discriminate ROUNDS, not poll ticks. Findings that come back
  // unchanged (or merely reordered by the scrape) are the same episode and must not re-spawn.
  const a = classifyPending(mkGateParked(), []);
  const b = mkGateParked();
  b.nomistakes!.findings = [...b.nomistakes!.findings].reverse();
  assert.equal(classifyPending(b, []).marker, a.marker);
});

test("a gate-parked run with no pane is seen but has no delivery channel", () => {
  const p = classifyPending(mkGateParked({ terminals: [] }), []);
  assert.equal(p.situation, "gate-parked");
  assert.equal(p.canSend, false);
});

test("a gate parked with no ask-user finding is still yours - the agent stopped on it", () => {
  // `gateParked` already means "parked AND nobody is driving it", so the situation must
  // not be keyed on the findings: a run whose findings the poller hasn't scraped yet is
  // exactly as stuck as one with an ask-user row, and skipping it would re-open the bug.
  const s = mkGateParked();
  s.nomistakes!.findings = [];
  const p = classifyPending(s, []);
  assert.equal(p.situation, "gate-parked");
  assert.match(p.question, /review/);
});

test("an agent still driving its own gate is not parked on you", () => {
  const p = classifyPending(mkGateParked({ state: "working" as SessionState }), []);
  assert.notEqual(p.situation, "gate-parked");
});

test("an answered gate decision is delivered by typing into the pane", () => {
  // Being SEEN is only half of it: the classification has to reach a real channel. The agent
  // has stopped, so there is no blocked MCP call to resolve - `pickChannel` must fall to the
  // terminal send, which is what `canSend` on this branch buys.
  const p = classifyPending(mkGateParked(), []);
  const plan = planFromVerdict(
    VerdictSchema.parse({
      purpose: "Adding a --force flag for CI.",
      classification: "implementation",
      action: "answer",
      answer: { text: "Approve r2 - gate --force on CI=true, keep the confirm for humans." },
      confidence: 0.9,
    }),
    { sessionId: "s1", promptMarker: p.marker, inputReviewId: p.inputReviewId, canSend: p.canSend },
    true,
    true,
  );
  assert.equal(plan.send?.channel, "send", "typed into the pane, not dropped");
  assert.match(plan.send!.text, /gate --force on CI=true/);
  assert.equal(plan.note.handledMarker, p.marker, "stamped so the same gate isn't handled twice");
});

test("a gate decision with no pane is drafted for you, never dropped", () => {
  const p = classifyPending(mkGateParked({ terminals: [] }), []);
  const plan = planFromVerdict(
    VerdictSchema.parse({
      purpose: "Adding a --force flag for CI.",
      classification: "implementation",
      action: "answer",
      answer: { text: "Approve r2 - gate it on CI." },
      confidence: 0.9,
    }),
    { sessionId: "s1", promptMarker: p.marker, inputReviewId: p.inputReviewId, canSend: p.canSend },
    true,
    true,
  );
  assert.equal(plan.send, null);
  assert.equal(plan.note.disposition, "escalated");
  assert.match(plan.note.recommendation!, /gate it on CI/, "the drafted reply survives as the recommendation");
});

test("a live prompt wins over the gate behind it - that is what is blocked right now", () => {
  const p = classifyPending(
    mkGateParked({ state: "awaiting_input" as SessionState, activity: "Claude needs your permission", lastActivity: 9 }),
    [],
  );
  assert.equal(p.situation, "terminal-pane");
  assert.equal(p.marker, "await:9");
});

test("only pending reviews for THIS session are considered", () => {
  const p = classifyPending(mkSession({ id: "s1" }), [
    mkReview({ id: "other", sessionId: "s2", kind: "input" }),
    mkReview({ id: "resolved", sessionId: "s1", kind: "input", status: "answered" }),
  ]);
  // Neither review applies (wrong session / already resolved) -> falls through to state.
  assert.equal(p.situation, "no-question");
});

// ---- options reach the reviewer (the ask channel) ----
//
// What is at stake: Foreman answering a multiple-choice question without ever seeing the
// choices. Before `ask-channel.ts`, a dispatched session asked by drawing a menu on its pane
// and the reviewer read the rows off the screen capture. Now it calls `request_input` and the
// choices live in the review's `decisions` - and the transcript cannot cover for that, because
// a blocked tool call is not written to it until it returns. Pass only `body` and the reviewer
// is free to answer outside the offered set, on exactly the asks this feature routes to it.

const OPTIONS = [
  { id: "o0", label: "biome", detail: "lint + format in one binary" },
  { id: "o1", label: "eslint" },
];

test("an input review's offered options reach the reviewer's question", () => {
  const p = classifyPending(
    mkSession(),
    [mkReview({ body: "Which linter?", decisions: [{ id: "q", question: "Which linter?", options: OPTIONS }] })],
  );
  assert.match(p.question, /Which linter\?/, "the question itself survives");
  assert.match(p.question, /biome/);
  assert.match(p.question, /lint \+ format in one binary/, "detail is what makes a label judgeable");
  assert.match(p.question, /eslint/);
  // The reply is typed as prose, so "option 2" reaches the agent as the words "option 2".
  assert.match(p.question, /state the LABEL/);
  assert.match(p.question, /escalate rather than inventing one that was not offered/);
});

test("a multi-select ask says so, so the reviewer may name more than one", () => {
  const p = classifyPending(
    mkSession(),
    [mkReview({ decisions: [{ id: "q", question: "Which?", options: OPTIONS, multiSelect: true }] })],
  );
  assert.match(p.question, /accept more than one/);
});

test("an open-ended input review is unchanged - no options, no preamble", () => {
  const p = classifyPending(mkSession(), [mkReview({ body: "What should I name it?" })]);
  assert.equal(p.question, "What should I name it?");
});

// ---- a menu on the screen is an answerable question (the AskUserQuestion window) ----
//
// What is at stake: every `AskUserQuestion` reaching the human as "Foreman needs your
// decision" on a session that is visibly working, with an answer Foreman wrote and could
// not send. `reportBucket` admits a session to needs-you on `activePaneDialog` alone, but
// this function used to recognise only the `awaiting_input` hook - and the two disagree for
// a measured interval. Claude fires `PreToolUse` when the menu opens (state `working`) and
// the `Notification` that means `awaiting_input` about six seconds later; captured from a
// live session, the window was 22:39:33 -> 22:39:38. A Foreman poll landing inside it fell
// through to `no-question` with `canSend: false`, which `planFromVerdict` can only resolve
// as "escalated (no reply channel)" - and an escalation is the one outcome that spends a
// human's attention. The pane, the parsed menu and the row-verifying send all already
// existed; this classification was the only thing holding them shut.

const MENU = {
  prompt: "Should this repo enable strict mode?",
  options: [
    { number: 1, label: "Yes", detail: "Turn it on now" },
    { number: 2, label: "No" },
  ],
  highlighted: 1,
};

function mkDialogSession(over: Partial<Session> = {}): Session {
  return mkSession({
    // The window itself: the menu is up, and the hook still says `working`.
    state: "working" as SessionState,
    activity: "running AskUserQuestion",
    terminals: [mkMuxHandle({ session: "m", windowIndex: 1, paneId: "%437" })],
    paneDialog: MENU,
    lastActivity: 1784601688632,
    ...over,
  });
}

test("a menu on the screen is answerable even while the hook still says working", () => {
  const p = classifyPending(mkDialogSession(), []);
  assert.equal(p.situation, "terminal-pane", "not no-question - the ask is right there on the pane");
  assert.equal(p.surface, "terminal");
  assert.equal(p.canSend, true, "there is a pane, so a row can be selected");
});

test("the dialog window no longer forces an escalation with nowhere to send it", () => {
  // The end of the chain this fix exists to break, asserted where it was actually felt:
  // `canSend: false` leaves `pickChannel` with nothing, and a perfectly good answer becomes
  // a decision pinned on the human. Verbatim from episode 106 of the reported session.
  const p = classifyPending(mkDialogSession(), []);
  const plan = planFromVerdict(
    VerdictSchema.parse({
      purpose: "The child is asking whether to enable strict mode.",
      classification: "implementation",
      action: "answer",
      answer: { text: "Enable strict mode.", option: { number: 1, label: "Yes" } },
    }),
    { sessionId: "s1", promptMarker: p.marker, inputReviewId: p.inputReviewId, canSend: p.canSend, menu: MENU },
    true,
  );
  assert.equal(plan.note.disposition, "answered");
  assert.notEqual(plan.note.lastAction, "escalated (no reply channel)");
  assert.equal(plan.send?.channel, "send");
  assert.deepEqual(plan.send?.option, { number: 1, label: "Yes" }, "a menu is selected, not typed at");
});

test("a menu with no pane keeps its honest no-channel answer", () => {
  // Fail-closed is unchanged: the dialog says a question exists, the pane fields say nothing
  // can deliver to it, and `canSend` still answers the second question and not the first.
  const p = classifyPending(mkDialogSession({ terminals: [] }), []);
  assert.equal(p.situation, "terminal-no-pane");
  assert.equal(p.canSend, false);
});

test("the dialog marker holds still when the hook lands, so one ask costs one review", () => {
  // The half that keeps the fix from doubling Foreman's spend. `lastActivity` moves when the
  // Notification arrives, so an `await:`-keyed marker would mint a second id for the same
  // unchanged menu and buy a second `claude -p` answering the identical question.
  const during = classifyPending(mkDialogSession(), []);
  const after = classifyPending(
    mkDialogSession({ state: "awaiting_input" as SessionState, activity: "Claude needs your permission", lastActivity: 1784601694000 }),
    [],
  );
  assert.equal(after.marker, during.marker, "same menu, same episode");
  assert.match(during.marker, /^dialog:/, "keyed on the rows, not on a clock");
});

test("a cursor moving in the menu is the same question, not a new one", () => {
  // `dialogIdentity` excludes `highlighted` on purpose; the marker inherits that, so arrowing
  // down a list cannot churn one ask into an unbounded run of episodes.
  const a = classifyPending(mkDialogSession(), []);
  const b = classifyPending(mkDialogSession({ paneDialog: { ...MENU, highlighted: 2 } }), []);
  assert.equal(b.marker, a.marker);
});

test("a DIFFERENT menu is a different episode", () => {
  const a = classifyPending(mkDialogSession(), []);
  const b = classifyPending(
    mkDialogSession({ paneDialog: { ...MENU, prompt: "Delete the branch?" } }),
    [],
  );
  assert.notEqual(b.marker, a.marker);
});

test("awaiting_input with no menu keeps its await: marker", () => {
  // The pre-existing path is untouched: a permission prompt the parser did not read still
  // classifies off the hook, so nothing depends on the pane being legible.
  const p = classifyPending(
    mkSession({ state: "awaiting_input" as SessionState, activity: "Approve?", terminals: [mkMuxHandle({ session: "m", windowIndex: 1 })], lastActivity: 42 }),
    [],
  );
  assert.equal(p.marker, "await:42");
});

test("an exited session's stale menu is not a question anyone can answer", () => {
  // `activePaneDialog` drops the dialog on an exited session, and this branch has to inherit
  // that rather than re-reading `paneDialog` itself - a dead pane's last screen is not an ask.
  const p = classifyPending(mkDialogSession({ state: "exited" as SessionState }), []);
  assert.equal(p.situation, "no-question");
});
