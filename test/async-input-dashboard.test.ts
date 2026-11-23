import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReviewItem, Session, TranscriptMessage } from "../src/shared/types.ts";
import { snoozeMeanwhileLabel, snoozeMeanwhileSince } from "../src/shared/review-snooze.ts";
import { isConversationQuestionRecord } from "../src/shared/review-item.ts";
import { reportBucket } from "../src/shared/session.ts";
import {
  PausedResidentsContext,
  QUESTION_ACTION_COPY,
  asQuestionAgent,
  pausedResidentSessionIds,
  questionWait,
  questionAgentStatus,
  questionBadge,
  questionOutcome,
  questionStatusLine,
  stoppedOnQuestions,
} from "../src/web/lib/async-questions.ts";
import { foldAttention } from "../src/web/lib/attention.ts";
import { stateDisplay } from "../src/web/lib/format.ts";
import { reviewChordTarget, reviewShortcutTarget } from "../src/web/lib/review-shortcut.ts";
import { mergeConversation, reviewEntries, type ConversationRow } from "../src/web/lib/episodes.ts";
import { timelineReviewsFor } from "../src/web/lib/timelineReviews.ts";
import { transcriptRows } from "../src/web/lib/tools.ts";
import { ReviewCard } from "../src/web/components/ReviewModal.tsx";
import { SnoozeSheet } from "../src/web/components/ReviewSnooze.tsx";
import { AskedQuestionCard, ClosedQuestionCard } from "../src/web/components/AskedQuestion.tsx";
import { mkSession, mkTaskSummary } from "./helpers/session-fixture.ts";

// The asynchronous input inbox, Phase 3: how the dashboard renders a question its agent filed and
// kept working past. Every surface reads `ReviewItem` and `Session` through the same predicates,
// so these pin the rendering decisions; `e2e/specs/async-input-dashboard.spec.ts` drives them in a
// browser against the real daemon.

const NOW = Date.UTC(2026, 10, 20, 15, 0);
const MIN = 60_000;

function question(over: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: "q1",
    sessionId: "s1",
    kind: "input",
    title: "Which linter should this repo use?",
    body: "Which linter should this repo use?",
    status: "pending",
    response: null,
    snoozable: true,
    waitMode: "message",
    meanwhile: "proceeding with eslint; the config is one file",
    decisions: [{
      id: "q",
      question: "Which linter should this repo use?",
      options: [{ id: "o0", label: "biome" }, { id: "o1", label: "eslint", recommended: true }],
    }],
    createdAt: NOW - 4 * MIN,
    resolvedAt: null,
    ...over,
  };
}

const working = (over: Partial<Session> = {}): Session =>
  mkSession({ state: "working", stateConfirmed: true, openQuestions: 1, ...over });
const stopped = (over: Partial<Session> = {}): Session =>
  mkSession({ state: "idle", stateConfirmed: true, openQuestions: 1, ...over });
const resident = (over: Partial<Session> = {}): Session =>
  mkSession({ state: "idle", stateConfirmed: true, openQuestions: 1, task: mkTaskSummary({ kind: "resident" }), ...over });

// ---- the card's status line ----

test("a message-mode card reads Still working with its meanwhile line while the agent works", () => {
  assert.deepEqual(questionStatusLine(question(), working(), NOW), {
    status: "working",
    label: "Still working",
    meanwhile: "proceeding with eslint; the config is one file",
    asked: "asked 4m ago",
  });
});

test("a stopped agent reads Stopped, waiting on this answer, and drops the meanwhile line", () => {
  assert.deepEqual(questionStatusLine(question(), stopped(), NOW), {
    status: "stopped",
    label: "Stopped, waiting on this answer",
    meanwhile: null,
    asked: "asked 4m ago",
  });
});

test("an unconfirmed agent reads stopped, as the bucket paints it amber", () => {
  const unconfirmed = mkSession({ state: "working", stateConfirmed: false, openQuestions: 1 });
  assert.equal(questionStatusLine(question(), unconfirmed, NOW)?.status, "stopped");
  assert.equal(reportBucket(unconfirmed), "needs-you");
});

test("a resident between iterations reads Still working, because it wakes on its own", () => {
  assert.equal(questionStatusLine(question(), resident(), NOW)?.label, "Still working");
});

test("the status line agrees with the bucket's idle clause for every reading", () => {
  for (const session of [working(), stopped(), resident(), mkSession({ state: "starting", stateConfirmed: true, openQuestions: 1 })]) {
    assert.equal(questionAgentStatus(session) === "stopped", reportBucket(session) === "needs-you", session.state);
  }
});

test("a call-mode card has no status line and renders exactly as before", () => {
  const callMode = question({ waitMode: undefined, meanwhile: undefined });
  assert.equal(questionStatusLine(callMode, stopped(), NOW), null);
  const withSession = renderToStaticMarkup(createElement(ReviewCard, { review: callMode, session: stopped() }));
  const without = renderToStaticMarkup(createElement(ReviewCard, { review: callMode }));
  assert.equal(withSession, without);
  assert.doesNotMatch(withSession, /review-wait/);
});

test("the rendered card carries the status line under its title", () => {
  const html = renderToStaticMarkup(createElement(ReviewCard, { review: question(), session: working() }));
  assert.match(html, /class="review-wait review-wait-working"/);
  assert.match(html, />Still working</);
  assert.match(html, /proceeding with eslint; the config is one file/);
  assert.ok(html.indexOf("review-wait") > html.indexOf("<h3>"), "under the title");
  const stoppedHtml = renderToStaticMarkup(createElement(ReviewCard, { review: question(), session: stopped() }));
  assert.match(stoppedHtml, />Stopped, waiting on this answer</);
  assert.doesNotMatch(stoppedHtml, /proceeding with eslint/);
});

// ---- the inbox ----

test("stopped sessions lead the inbox's questions, then oldest question first", () => {
  const sessions = [
    working({ id: "busy", name: "busy" }),
    stopped({ id: "stuck", name: "stuck" }),
    mkSession({ id: "gate", name: "gate", state: "awaiting_review", stateConfirmed: true, pendingReviews: 1 }),
  ];
  const reviews = [
    question({ id: "a", sessionId: "busy", createdAt: NOW - 30 * MIN }),
    question({ id: "b", sessionId: "stuck", createdAt: NOW - 5 * MIN }),
    question({ id: "c", sessionId: "gate", waitMode: undefined, kind: "plan", createdAt: NOW - 10 * MIN }),
  ];
  const order = foldAttention({ sessions, reviews, ensembles: [] }).items
    .flatMap((item) => (item.kind === "session_reviews" ? [item.session.id] : []));
  assert.deepEqual(order, ["gate", "stuck", "busy"]);
});

test("with every review call-mode, the order is oldest first exactly as before", () => {
  const sessions = [mkSession({ id: "x", pendingReviews: 1 }), mkSession({ id: "y", pendingReviews: 1 })];
  const reviews = [
    question({ id: "1", sessionId: "y", waitMode: undefined, createdAt: 1 }),
    question({ id: "2", sessionId: "x", waitMode: undefined, createdAt: 2 }),
  ];
  const order = foldAttention({ sessions, reviews, ensembles: [] }).items
    .flatMap((item) => (item.kind === "session_reviews" ? [item.session.id] : []));
  assert.deepEqual(order, ["y", "x"]);
  assert.equal(stoppedOnQuestions(working(), [question({ waitMode: undefined })]), true, "a call-mode review is always stopped");
});

test("a working session's questions count toward to answer but not toward need you", () => {
  const session = working();
  const fold = foldAttention({ sessions: [session], reviews: [question()], ensembles: [] });
  assert.equal(fold.total, 1);
  assert.notEqual(stateDisplay(session).tone, "attention");
  assert.equal(fold.items.some((item) => item.kind === "session_blocked"), false);
});

test("the attention-pill invariant holds for a stopped session with open questions", () => {
  // Every amber session owes an answer: the stopped one is amber and its question is listed.
  const session = stopped();
  assert.equal(stateDisplay(session).tone, "attention");
  const fold = foldAttention({ sessions: [session], reviews: [question()], ensembles: [] });
  assert.equal(fold.total, 1);
  assert.equal(fold.items[0]?.kind, "session_reviews");
});

// ---- the state badge ----

test("a working session's badge reads N questions open in the working tone and opens them", () => {
  const session = working({ openQuestions: 2 });
  const badge = questionBadge(session, stateDisplay(session));
  assert.deepEqual({ label: badge?.label, tone: badge?.tone }, { label: "2 questions open", tone: "working" });
  assert.equal(questionBadge(working(), stateDisplay(working()))?.label, "1 question open");
});

test("a stopped session's badge is today's amber button", () => {
  const session = stopped();
  assert.deepEqual(
    { label: questionBadge(session, stateDisplay(session))?.label, tone: questionBadge(session, stateDisplay(session))?.tone },
    { label: "waiting on your answer", tone: "attention" },
  );
});

test("a resident with questions open keeps its own tone, never amber", () => {
  const session = resident();
  const badge = questionBadge(session, stateDisplay(session));
  assert.deepEqual({ label: badge?.label, tone: badge?.tone }, { label: "1 question open", tone: "idle" });
});

test("the badge's words follow questionAgentStatus, never the display tone, so it cannot contradict the card", () => {
  // A stopped agent whose badge is not amber, as an interrupt in flight or another runtime override
  // draws it: the count stays, and the words say stopped, as the card beside it does.
  const notAmber = { label: "interrupting", tone: "working" as const };
  const stoppedBadge = questionBadge(stopped(), notAmber);
  assert.equal(stoppedBadge?.label, "1 question open");
  assert.equal(stoppedBadge?.tone, "working", "the colour is still the display's");
  assert.match(stoppedBadge?.tooltip ?? "", /has stopped on this question/);
  assert.doesNotMatch(stoppedBadge?.tooltip ?? "", /keeps working/);
  assert.equal(questionStatusLine(question(), stopped(), NOW)?.label, "Stopped, waiting on this answer");
  // A working agent whose display is amber for another reason keeps that reason as its label,
  // and its words still say it keeps working.
  const workingAmber = questionBadge(working(), { label: "needs an answer", tone: "attention" });
  assert.equal(workingAmber?.label, "needs an answer");
  assert.match(workingAmber?.tooltip ?? "", /keeps working/);
  // The ordinary readings, through the real display.
  assert.match(questionBadge(stopped(), stateDisplay(stopped()))?.tooltip ?? "", /has stopped/);
  assert.match(questionBadge(working(), stateDisplay(working()))?.tooltip ?? "", /keeps working/);
  assert.match(questionBadge(resident(), stateDisplay(resident()))?.tooltip ?? "", /keeps working/);
});

test("a call-mode review keeps today's badge, and nothing to answer is no button", () => {
  const session = mkSession({ state: "awaiting_input", stateConfirmed: true, pendingReviews: 1 });
  const badge = questionBadge(session, stateDisplay(session));
  assert.equal(badge?.label, "to review");
  assert.match(badge?.tooltip ?? "", /1 review waiting on you/);
  assert.equal(questionBadge(mkSession({ openQuestions: 0 }), stateDisplay(mkSession())), null);
});

// ---- the review chord ----

test("the chord reaches a working session's questions only after every stopped session", () => {
  const visible = [working({ id: "busy" }), stopped({ id: "stuck" })];
  assert.deepEqual(reviewShortcutTarget(visible, null), { sessionId: "stuck", refocus: true });
  assert.deepEqual(reviewShortcutTarget([working({ id: "busy" })], null), { sessionId: "busy", refocus: true });
  assert.deepEqual(reviewShortcutTarget(visible, "busy"), { sessionId: "busy", refocus: false }, "the selected one still wins");
});

test("a stopped resident in the drawer comes before a fleet session still working past its question", () => {
  const busy = working({ id: "busy" });
  const parked = mkSession({ id: "parked", state: "awaiting_input", stateConfirmed: true, task: mkTaskSummary({ kind: "resident" }) });
  const watcher = resident({ id: "watcher" });
  assert.deepEqual(reviewChordTarget([busy], null, [watcher, parked]), { kind: "resident", sessionId: "parked", opens: "conversation" });
  assert.deepEqual(reviewChordTarget([busy], null, [watcher]), { kind: "fleet", sessionId: "busy", refocus: true });
  assert.deepEqual(reviewChordTarget([], null, [watcher]), { kind: "resident", sessionId: "watcher", opens: "review" });
});

test("a stopped resident whose conversation is already open does not keep the chord from a working fleet session", () => {
  const busy = working({ id: "busy" });
  const parked = mkSession({ id: "parked", state: "awaiting_input", stateConfirmed: true, task: mkTaskSummary({ kind: "resident" }) });
  // Its conversation is the one open and it has no queue to open: step 4 reaches the fleet session.
  assert.deepEqual(reviewChordTarget([busy], null, [parked], "parked"), { kind: "fleet", sessionId: "busy", refocus: true });
  // With nothing else asking, the last step still falls back to it, as before.
  assert.deepEqual(reviewChordTarget([], null, [parked], "parked"), { kind: "resident", sessionId: "parked", opens: "conversation" });
});

test("a resident with open questions opens its review queue, not its conversation", () => {
  const r = resident({ id: "watcher" });
  assert.deepEqual(reviewChordTarget([], null, [r]), { kind: "resident", sessionId: "watcher", opens: "review" });
});

// ---- the conversation ----

function order(rows: ConversationRow[]): string[] {
  return rows.map((r) =>
    r.kind === "turn" || r.kind === "tools" ? r.id
      : `${r.kind}:${r.kind === "episode" ? r.episode.marker : r.kind === "delivered" ? r.reviewId : r.kind === "report" ? r.report.id : r.review.id}`);
}

function msg(id: string, ts: number): TranscriptMessage {
  return { id, role: "assistant", text: `turn ${id}`, tools: [], ts };
}

test("an open question is an Asked entry where it was filed, while the agent carried on", () => {
  const q = question({ createdAt: 150 });
  const rows = mergeConversation(transcriptRows([msg("a", 100), msg("b", 200)]), [], [q]);
  assert.deepEqual(order(rows), ["a", "asked:q1", "b"]);
});

test("an answered question keeps its Asked entry and gains the gold answer at the resolution", () => {
  const q = question({ createdAt: 150, status: "answered", resolvedAt: 250, resolvedBy: "human", response: "eslint" });
  const rows = mergeConversation(transcriptRows([msg("a", 100), msg("b", 200), msg("c", 300)]), [], [q]);
  assert.deepEqual(order(rows), ["a", "asked:q1", "b", "review:q1", "c"]);
});

test("Foreman's answer, a merge closure, an orphaning and a withdrawal each stay on the Asked entry", () => {
  for (const over of [
    { status: "answered" as const, resolvedBy: "foreman" as const, resolvedAt: 250 },
    { status: "orphaned" as const, closedReason: "merged" as const, resolvedAt: 250 },
    { status: "orphaned" as const, resolvedAt: 250 },
    { status: "withdrawn" as const, response: "no longer needed", resolvedAt: 250 },
  ]) {
    assert.deepEqual(reviewEntries(question({ createdAt: 150, ...over })).map((e) => `${e.kind}@${e.ts}`), ["asked@150"], over.status);
  }
});

test("a call-mode question a merge closed is a closure entry where it was snoozed", () => {
  const snoozedThenMerged = question({
    waitMode: undefined, status: "orphaned", closedReason: "merged", createdAt: 100, resolvedAt: 400,
    snooze: { at: 200, until: 9_000, mode: "judgment", optionId: null, remindedAt: null },
  });
  assert.deepEqual(reviewEntries(snoozedThenMerged).map((e) => `${e.kind}@${e.ts}`), ["closed@200"]);
  const pendingThenMerged = question({ waitMode: undefined, status: "orphaned", closedReason: "merged", createdAt: 100, resolvedAt: 400 });
  assert.deepEqual(reviewEntries(pendingThenMerged).map((e) => `${e.kind}@${e.ts}`), ["closed@400"]);
  const otherOrphan = question({ waitMode: undefined, status: "orphaned", createdAt: 100, resolvedAt: 400 });
  assert.deepEqual(reviewEntries(otherOrphan), [], "an ordinary orphaned call-mode question stays out, as before");
});

test("the outcome line says how each question ended", () => {
  assert.equal(questionOutcome(question()).state, "open");
  assert.equal(questionOutcome(question({ status: "orphaned", closedReason: "merged" })).text, "Closed unanswered: pull request merged");
  assert.equal(questionOutcome(question({ status: "orphaned" })).text, "Closed unanswered");
  assert.deepEqual(questionOutcome(question({ status: "withdrawn", response: "found it in the README" })), {
    state: "withdrawn", text: "Withdrawn by the agent", detail: "found it in the README",
  });
  assert.equal(questionOutcome(question({ status: "answered", resolvedBy: "foreman" })).text, "Answered by Foreman");
  assert.equal(questionOutcome(question({ status: "dismissed", resolvedBy: "human" })).text, "Dismissed without an answer");
});

test("an open Asked entry says whether its agent is still working or has stopped, and an ended one does not", () => {
  const open = (session: Session) => renderToStaticMarkup(createElement(AskedQuestionCard, { review: question(), session }));
  assert.match(open(working()), /review-asked-status review-wait-working[^>]*><span class="review-wait-state">Still working</);
  assert.match(open(stopped()), /review-wait-stopped[^>]*><span class="review-wait-state">Stopped, waiting on this answer</);
  assert.match(open(resident()), />Still working</);
  const ended = renderToStaticMarkup(createElement(AskedQuestionCard, {
    review: question({ status: "answered", resolvedBy: "human" }), session: stopped(),
  }));
  assert.doesNotMatch(ended, /review-asked-status/);
  assert.match(ended, />Answered</);
});

test("Asked and Closed entries show the whole question, never repeating a heading that already says it", () => {
  const long = "Which linter should this repo use, given that CI runs Prettier only and the monorepo has three packages with different TypeScript configs?";
  const clipped = question({ title: "Which linter should this repo use, given that CI runs…", body: `${long}\n\nThe repo has no linter.` });
  const asked = renderToStaticMarkup(createElement(AskedQuestionCard, { review: clipped }));
  assert.match(asked, /review-asked-question/);
  assert.ok(asked.includes("three packages with different TypeScript configs?"), "the clipped part is shown");
  const closed = renderToStaticMarkup(createElement(ClosedQuestionCard, {
    review: { ...clipped, waitMode: undefined, status: "orphaned", closedReason: "merged" },
  }));
  assert.ok(closed.includes("three packages with different TypeScript configs?"));
  // A question that fit in the heading adds only its context, and nothing when it has none.
  const short = renderToStaticMarkup(createElement(AskedQuestionCard, {
    review: question({ body: "Which linter should this repo use?\n\nCI runs Prettier only." }),
  }));
  // Counted as visible text only: the entry's accessible name also carries the title.
  assert.equal(short.split(">Which linter should this repo use?").length - 1, 1, "the heading is not repeated");
  assert.match(short, /CI runs Prettier only\./);
  const bare = renderToStaticMarkup(createElement(AskedQuestionCard, { review: question() }));
  assert.doesNotMatch(bare, /review-asked-question/);
});

test("a filed question turned back into a blocking call retires its stored Asked entry", () => {
  const stored = question({ id: "q1" });
  const reattached = { ...stored, waitMode: undefined, meanwhile: undefined };
  assert.deepEqual(timelineReviewsFor("s1", [stored], [reattached], true), []);
  // A live row that still qualifies replaces its stored copy as before.
  assert.equal(timelineReviewsFor("s1", [stored], [{ ...stored, meanwhile: "newer" }], true)[0]?.meanwhile, "newer");
});

test("the Asked entry has an Answer button only while the question is open", () => {
  const open = renderToStaticMarkup(createElement(AskedQuestionCard, { review: question(), onAnswer: () => {} }));
  assert.match(open, />Asked</);
  assert.match(open, />Answer</);
  assert.match(open, /proceeding with eslint/);
  const merged = renderToStaticMarkup(createElement(AskedQuestionCard, {
    review: question({ status: "orphaned", closedReason: "merged" }), onAnswer: () => {},
  }));
  assert.match(merged, /Closed unanswered: pull request merged/);
  assert.doesNotMatch(merged, />Answer</);
  const closed = renderToStaticMarkup(createElement(ClosedQuestionCard, {
    review: question({ waitMode: undefined, status: "orphaned", closedReason: "merged" }),
  }));
  assert.match(closed, /Closed unanswered: pull request merged/);
});

test("the timeline admits a filed question in any status, and a merge-closed call-mode one", () => {
  const live = [
    question({ id: "open" }),
    question({ id: "foreman", status: "answered", resolvedBy: "foreman" }),
    question({ id: "merged-call", waitMode: undefined, status: "orphaned", closedReason: "merged" }),
    question({ id: "other-call", waitMode: undefined, status: "pending" }),
    question({ id: "elsewhere", sessionId: "s2" }),
  ];
  assert.deepEqual(timelineReviewsFor("s1", [], live, true).map((r) => r.id).sort(), ["foreman", "merged-call", "open"]);
  assert.equal(isConversationQuestionRecord({ waitMode: undefined, closedReason: null }), false);
});

test("with the flag off, a merge-closed call-mode question stays out of the conversation, as before", () => {
  const mergedCall = question({ id: "merged-call", waitMode: undefined, status: "orphaned", closedReason: "merged", resolvedAt: 400 });
  // From the history route as well as live: neither half may bring it back.
  assert.deepEqual(timelineReviewsFor("s1", [mergedCall], [mergedCall], false), []);
  // A filed question was asked only because the flag was on, and stays answerable after it goes off.
  assert.deepEqual(timelineReviewsFor("s1", [], [question({ id: "open" })], false).map((r) => r.id), ["open"]);
  // And an ordinary human answer is in the conversation whichever way the flag reads.
  const answered = question({ id: "answered", waitMode: undefined, status: "answered", resolvedBy: "human", resolvedAt: 300 });
  assert.deepEqual(timelineReviewsFor("s1", [answered], [], false).map((r) => r.id), ["answered"]);
});

// ---- Remind me later ----

test("a message-mode question's default Meanwhile reads Keep doing what it said", () => {
  const html = renderToStaticMarkup(createElement(SnoozeSheet, { review: question(), onBack: () => {} }));
  assert.match(html, /Keep doing what it said/);
  assert.match(html, /It said &quot;proceeding with eslint; the config is one file&quot;. Nothing is sent to it/);
  assert.doesNotMatch(html, /Use your best judgment/);
  const callMode = renderToStaticMarkup(createElement(SnoozeSheet, { review: question({ waitMode: undefined }), onBack: () => {} }));
  assert.match(callMode, /Use your best judgment/);
});

test("every action's words follow the agent's current status, never contradicting the card", () => {
  assert.equal(questionWait(question({ waitMode: undefined }), stopped()), "call");
  assert.equal(questionWait(question(), working()), "working");
  assert.equal(questionWait(question(), stopped()), "stopped");
  assert.equal(questionWait(question(), resident()), "working");
  assert.match(QUESTION_ACTION_COPY.stopped.dismissRow, /has stopped on them/);
  assert.match(QUESTION_ACTION_COPY.stopped.remindLater, /has stopped on it/);
  for (const copy of Object.values(QUESTION_ACTION_COPY.stopped)) assert.doesNotMatch(copy, /keeps working/);
  assert.match(QUESTION_ACTION_COPY.call.dismissRow, /The agent keeps waiting/, "call-mode words unchanged");

  const card = (session: Session) => renderToStaticMarkup(createElement(ReviewCard, { review: question(), session }));
  assert.match(card(working()), /The agent keeps working, and this question comes back to you later/);
  assert.match(card(stopped()), /The agent has stopped on it and hears nothing unless you choose a provisional option or Hold/);
  assert.doesNotMatch(card(stopped()), /keeps working/);

  const sheet = renderToStaticMarkup(createElement(SnoozeSheet, { review: question(), wait: "stopped", onBack: () => {} }));
  assert.match(sheet, /It has since stopped. Nothing is sent to it/);
  assert.match(sheet, /the agent stays stopped unless you choose a provisional option or Hold/);
});

test("a returned filed question whose earlier snooze sent nothing offers the Meanwhile choice again", () => {
  const silent = question({ snooze: { at: NOW - 60 * MIN, until: NOW, mode: "judgment", optionId: null, remindedAt: NOW, instructed: false } });
  const html = renderToStaticMarkup(createElement(SnoozeSheet, { review: silent, onBack: () => {} }));
  assert.match(html, /Hold work that depends on this/);
  assert.doesNotMatch(html, /keeps doing what you chose last time/);
  // A question whose earlier snooze did tell its agent something keeps that choice, as before.
  const told = question({ snooze: { at: NOW - 60 * MIN, until: NOW, mode: "hold", optionId: null, remindedAt: NOW } });
  assert.match(renderToStaticMarkup(createElement(SnoozeSheet, { review: told, onBack: () => {} })), /keeps doing what you chose last time/);
  const callMode = question({ waitMode: undefined, snooze: { at: NOW - 60 * MIN, until: NOW, mode: "judgment", optionId: null, remindedAt: NOW } });
  assert.match(renderToStaticMarkup(createElement(SnoozeSheet, { review: callMode, onBack: () => {} })), /keeps doing what you chose last time/);
  // A filed question snoozed on best judgment before the silent rule: its agent WAS told, so the
  // choice is not re-offered and the labels say what it was told, not "Keep doing what it said".
  const toldEarlier = question({ snooze: { at: NOW - 60 * MIN, until: NOW, mode: "judgment", optionId: null, remindedAt: NOW } });
  const toldHtml = renderToStaticMarkup(createElement(SnoozeSheet, { review: toldEarlier, onBack: () => {} }));
  assert.match(toldHtml, /keeps doing what you chose last time: use its best judgment/);
  assert.doesNotMatch(toldHtml, /Hold work that depends on this/);
  assert.equal(snoozeMeanwhileSince(toldEarlier, toldEarlier.snooze!), "The agent has kept working on its best judgment.");
});

test("the snooze labels read true for an agent that never waited", () => {
  const judgment = { mode: "judgment" as const, optionId: null, instructed: false };
  assert.equal(snoozeMeanwhileLabel(question(), judgment), "Keep doing what it said");
  assert.equal(snoozeMeanwhileLabel(question({ waitMode: undefined }), judgment), "Use its best judgment");
  // Neutral: by the time the question comes back the agent may have stopped, which the card's live
  // status line says; this line only records what the operator chose.
  assert.equal(snoozeMeanwhileSince(question(), judgment), "You left it to do what it said it would when it asked.");
  assert.doesNotMatch(snoozeMeanwhileSince(question(), judgment), /kept|keeps|working/);
  const returned = renderToStaticMarkup(createElement(ReviewCard, {
    review: question({ snooze: { at: NOW - 60 * MIN, until: NOW, mode: "judgment", optionId: null, remindedAt: NOW, instructed: false } }),
    session: stopped(),
  }));
  assert.match(returned, /Stopped, waiting on this answer/);
  assert.match(returned, /You left it to do what it said it would when it asked/);
  assert.doesNotMatch(returned, /kept doing|keeps working/);
  assert.equal(snoozeMeanwhileLabel(question(), { mode: "option", optionId: "o0" }), 'Go with "biome" for now');
  assert.equal(snoozeMeanwhileLabel(question(), { mode: "hold", optionId: null }), "Hold work that depends on this");
});

// ---- the Residents drawer ----

const { residentDrawerGroups, residentEntryAmber } = await import("../src/web/residents/ResidentsDrawer.tsx");
type DrawerEntry = Parameters<typeof residentDrawerGroups>[0][number];

test("a working resident with an open question is listed under Needs you, its tone unchanged", () => {
  const entry = (session: Session): DrawerEntry => ({ session } as DrawerEntry);
  const asking = resident({ id: "asking", state: "working" });
  const quiet = resident({ id: "quiet", openQuestions: 0 });
  const groups = residentDrawerGroups([entry(quiet), entry(asking)]);
  assert.deepEqual(groups.needsYou.map((e) => e.session?.id), ["asking"]);
  assert.deepEqual(groups.others.map((e) => e.session?.id), ["quiet"]);
  assert.equal(stateDisplay(asking).tone, "working", "never amber for its questions alone");
});

// ---- a resident the operator paused ----

test("a paused resident has stopped on its open question, unless it is still finishing a turn", () => {
  const paused = { ...resident({ id: "watcher" }), residentPaused: true };
  assert.equal(questionAgentStatus(paused), "stopped");
  assert.equal(questionStatusLine(question(), paused, NOW)?.label, "Stopped, waiting on this answer");
  assert.equal(questionAgentStatus({ ...paused, state: "working" }), "working", "Pause does not interrupt a running turn");
  assert.equal(questionAgentStatus(resident()), "working", "an unpaused resident still wakes on its own");
  // The shared bucket is unchanged: the daemon refuses Resume while it reads needs-you.
  assert.notEqual(reportBucket(resident()), "needs-you");
});

test("paused residents are joined from their runs by task, and marked only when paused", () => {
  const watcher = resident({ id: "watcher", task: mkTaskSummary({ id: "t-watch", kind: "resident" }) });
  const other = resident({ id: "other", task: mkTaskSummary({ id: "t-other", kind: "resident" }) });
  const ids = pausedResidentSessionIds(
    [{ taskId: "t-watch", loopState: "paused" }, { taskId: "t-other", loopState: "waiting" }],
    [watcher, other],
  );
  assert.deepEqual([...ids], ["watcher"]);
  assert.equal(asQuestionAgent(watcher, ids).residentPaused, true);
  assert.equal(asQuestionAgent(other, ids).residentPaused, undefined);
  assert.equal(pausedResidentSessionIds(undefined, [watcher]).size, 0);
});

test("a paused resident's question sorts with the stopped ones, and the chord reaches it before working sessions", () => {
  const watcher = resident({ id: "watcher", name: "watcher", task: mkTaskSummary({ id: "t-watch", kind: "resident" }) });
  const busy = working({ id: "busy", name: "busy" });
  const order = (runs: { taskId: string; loopState: "paused" | "waiting" }[]) => foldAttention({
    sessions: [busy, watcher],
    reviews: [question({ id: "a", sessionId: "watcher", createdAt: NOW - 1 * MIN }), question({ id: "b", sessionId: "busy", createdAt: NOW - 30 * MIN })],
    ensembles: [],
    residentRuns: runs as never,
  }).items.flatMap((item) => (item.kind === "session_reviews" ? [item.session.id] : []));
  assert.deepEqual(order([{ taskId: "t-watch", loopState: "waiting" }]), ["busy", "watcher"], "both working: oldest first");
  assert.deepEqual(order([{ taskId: "t-watch", loopState: "paused" }]), ["watcher", "busy"], "paused: stopped, so first");

  const pausedWatcher = asQuestionAgent(watcher, new Set(["watcher"]));
  assert.deepEqual(reviewChordTarget([busy], null, [pausedWatcher]), { kind: "resident", sessionId: "watcher", opens: "review" });
  assert.deepEqual(reviewChordTarget([busy], null, [watcher]), { kind: "fleet", sessionId: "busy", refocus: true });
});

test("a paused resident's badge, card and drawer entry say it has stopped, and the drawer turns it amber", () => {
  const watcher = resident({ id: "watcher" });
  const paused = { ...watcher, residentPaused: true };
  assert.match(questionBadge(paused, stateDisplay(watcher))?.tooltip ?? "", /has stopped/);
  const card = renderToStaticMarkup(createElement(PausedResidentsContext.Provider, { value: new Set(["watcher"]) },
    createElement(ReviewCard, { review: question({ sessionId: "watcher" }), session: watcher })));
  assert.match(card, /Stopped, waiting on this answer/);
  assert.doesNotMatch(card, /Still working/);
  const run = (loopState: "paused" | "waiting") => ({ loopState }) as Parameters<typeof residentEntryAmber>[0]["run"];
  assert.equal(residentEntryAmber({ run: run("paused"), session: watcher }), true);
  assert.equal(residentEntryAmber({ run: run("waiting"), session: watcher }), false, "a working resident is never amber for its questions");
});

// ---- filed plan decisions (`filed-plan-decisions`): a filed plan form is a gate ----

function filedPlan(over: Partial<ReviewItem> = {}): ReviewItem {
  return question({
    id: "p1", kind: "plan-decisions", title: "Linter plan", body: "# Linter plan\n\nAdopt one linter.",
    snoozable: undefined, meanwhile: undefined, ...over,
  });
}

test("a filed plan form reads Waiting on your decisions, stopped, with no meanwhile line, even while its agent finishes its turn", () => {
  for (const session of [working({ pendingReviews: 1, openQuestions: 0 }), stopped({ pendingReviews: 1, openQuestions: 0 }), resident({ pendingReviews: 1, openQuestions: 0 })]) {
    assert.deepEqual(questionStatusLine(filedPlan(), session, NOW), {
      status: "stopped", label: "Waiting on your decisions", meanwhile: null, asked: "filed 4m ago",
    }, session.state);
  }
  const html = renderToStaticMarkup(createElement(ReviewCard, { review: filedPlan(), session: working({ pendingReviews: 1, openQuestions: 0 }) }));
  assert.match(html, /class="review-wait review-wait-stopped"/);
  assert.match(html, />Waiting on your decisions</);
  assert.doesNotMatch(html, /Still working/);
  assert.doesNotMatch(html, /Remind me later/, "no snooze on a plan form");
});

test("a filed plan form's session leads the inbox and its actions say the agent keeps waiting", () => {
  const sessions = [
    working({ id: "busy", name: "busy" }),
    working({ id: "planner", name: "planner", pendingReviews: 1, openQuestions: 0 }),
  ];
  const reviews = [
    question({ id: "a", sessionId: "busy", createdAt: NOW - 30 * MIN }),
    filedPlan({ id: "b", sessionId: "planner", createdAt: NOW - 5 * MIN }),
  ];
  const fold = foldAttention({ sessions, reviews, ensembles: [] });
  assert.deepEqual(fold.items.flatMap((item) => (item.kind === "session_reviews" ? [item.session.id] : [])), ["planner", "busy"]);
  assert.equal(fold.total, 2, "counted in to answer from filing");
  assert.equal(stoppedOnQuestions(working(), [filedPlan()]), true);
  assert.equal(questionWait(filedPlan(), working()), "call");
  assert.equal(stateDisplay(sessions[1]!).tone, "attention", "amber while its agent is still working");
  assert.equal(stateDisplay(sessions[1]!).label, "to review");
});

test("a filed plan is drawn where it was filed as Plan filed, with an Open button and no plan body", () => {
  assert.deepEqual(reviewEntries(filedPlan()).map((entry) => entry.kind), ["asked"]);
  const open = renderToStaticMarkup(createElement(AskedQuestionCard, { review: filedPlan(), session: working(), onAnswer: () => {} }));
  assert.match(open, /aria-label="Plan filed: Linter plan"/);
  assert.match(open, />Plan filed</);
  assert.match(open, />Open</);
  assert.match(open, />Waiting on your decisions</);
  assert.doesNotMatch(open, /Adopt one linter/);
  const withdrawn = renderToStaticMarkup(createElement(AskedQuestionCard, {
    review: filedPlan({ status: "withdrawn", response: "Scope changed" }), onAnswer: () => {},
  }));
  assert.match(withdrawn, /Withdrawn by the agent/);
  assert.match(withdrawn, /Scope changed/);
  const merged = renderToStaticMarkup(createElement(AskedQuestionCard, { review: filedPlan({ status: "orphaned", closedReason: "merged" }) }));
  assert.match(merged, /Closed unanswered: pull request merged/);
});
