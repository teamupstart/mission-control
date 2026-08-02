import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPending } from "../src/server/foreman/pending.ts";
import { planFromVerdict, VerdictSchema } from "../src/server/foreman/verdict.ts";
import { buildTriagePrompt } from "../src/server/foreman/triage-prompt.ts";
import type { ReviewInput } from "../src/server/foreman/prompt.ts";
import type { ReviewItem, Session, SessionState } from "../src/shared/types.ts";
import { mkMuxHandle } from "./helpers/session-fixture.ts";

function mkSession(over: Partial<Session> = {}): Session {
  return {
    id: "s1",
    agent: "claude",
    name: "sess",
    runtime: "terminal",
    nameSource: "process",
    state: "working" as SessionState,
    cwd: null,
    gitBranch: null,
    gitRoot: null,
    repoRoot: null,
    pid: 1,
    tty: null,
    permissionMode: null,
    terminals: [],
    agentSessionId: null,
    transcriptPath: null,
    instrumented: true,
    stateConfirmed: true,
    hooksSeen: true,
    activity: null,
    startedAt: null,
    firstSeen: 0,
    lastSeen: 0,
    lastActivity: null,
    pendingReviews: 0,
    task: null,
    prUrl: null,
    prNumber: null,
    prState: null,
    prChecks: null,
    meta: null,
    effortBaselineReady: false,
    note: null, cost: null, goal: null,
    queue: null,
    pendingTurns: [],
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

test("a terminal-pane pending's activity-borne question reaches the router capped", () => {
  // Pins the chain end to end, because it is easy to misread: `terminal-pane` is a
  // SITUATION, while the router's clip keys on the SURFACE - and every terminal situation
  // classifies with `surface: "terminal"`, so a chatty `report_status` that becomes the
  // question here cannot outgrow the Tier 1 prompt. The ReviewInput is assembled exactly
  // as `triageSession` assembles it: surface and question read off the classification.
  const pending = classifyPending(
    mkSession({ state: "awaiting_input" as SessionState, activity: "x".repeat(50_000), terminals: [mkMuxHandle({ session: "m", windowIndex: 1 })], lastActivity: 42 }),
    [],
  );
  assert.equal(pending.situation, "terminal-pane");
  assert.equal(pending.surface, "terminal");
  const p = buildTriagePrompt({
    session: { agent: "claude", runtime: "terminal", name: "sess", cwd: null, gitBranch: null, state: "awaiting_input", activity: null, goal: null },
    surface: pending.surface,
    question: pending.question,
    transcript: [],
    truncated: false,
    instructions: "",
  } as ReviewInput);
  assert.ok(p.length < 20_000, `terminal-pane question was not capped - prompt is ${p.length}`);
});

test("an exited session's stale menu is not a question anyone can answer", () => {
  // `activePaneDialog` drops the dialog on an exited session, and this branch has to inherit
  // that rather than re-reading `paneDialog` itself - a dead pane's last screen is not an ask.
  const p = classifyPending(mkDialogSession({ state: "exited" as SessionState }), []);
  assert.equal(p.situation, "no-question");
});

test("a driver's request is its own situation, named off the ASK and not the runtime", () => {
  // The reviewer prompt selects its whole delivery grammar from this (see `promptHarness`),
  // and the card records which kind of ask was answered. Both are properties of where the
  // ask CAME FROM, which is why the name is read off `dialog.source` rather than off
  // `session.runtime`: a driver that ever reported a screen-read dialog would be described
  // as one, and a later runtime whose asks are structured inherits the framing for free.
  const p = classifyPending(
    mkDialogSession({
      runtime: "sdk",
      terminals: [],
      paneDialog: {
        ...MENU,
        highlighted: 0,
        source: "driver",
        requestId: "req-1",
        kind: "question",
      },
    }),
    [],
  );
  assert.equal(p.situation, "structured-request");
  assert.equal(p.surface, "terminal");
  assert.equal(p.canSend, true, "a driver-run session has a delivery channel without a pane");
  assert.match(p.marker, /^dialog:/, "the same rows are the same episode, whatever produced them");
});

test("a pane menu on a pane session is still terminal-pane", () => {
  // The new name must not swallow the old one: a screen-read dialog carries no `source`, and
  // absence means pane by construction (see `PaneDialog`).
  assert.equal(classifyPending(mkDialogSession(), []).situation, "terminal-pane");
});

test("a driver request on a session that cannot be messaged is still no-channel", () => {
  // `canSend` outranks the naming: a situation that promises an answer can be delivered when
  // it cannot is the one `planFromVerdict` can only resolve as "escalated (no reply channel)"
  // - after paying for the review.
  const p = classifyPending(
    mkDialogSession({
      runtime: "terminal",
      terminals: [],
      paneDialog: { ...MENU, source: "driver", requestId: "req-1" },
    }),
    [],
  );
  assert.equal(p.situation, "terminal-no-pane");
  assert.equal(p.canSend, false);
});
