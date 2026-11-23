import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReviewItem, Session } from "../src/shared/types.ts";
import type { FeatureFlagsConfig } from "../src/shared/feature-flags.ts";
import { FeatureFlagsContext } from "../src/web/useFeatureFlag.ts";
import { ResidentNamesContext } from "../src/web/lib/agent-names.ts";
import { SnoozeReviewSchema } from "../src/shared/protocol.ts";
import { reviewToolResult } from "../src/shared/review-item.ts";
import {
  canSnoozeReview,
  describeSnoozeWait,
  snoozeMeanwhileLabel,
  snoozeMeanwhileProblem,
  snoozedToolResultText,
} from "../src/shared/review-snooze.ts";
import { reminderClock, snoozedQuestions } from "../src/web/lib/review-snooze.ts";
import { timelineReviewsFor } from "../src/web/lib/timelineReviews.ts";
import { mergeConversation } from "../src/web/lib/episodes.ts";
import { attentionDismissalKeys, foldAttention } from "../src/web/lib/attention.ts";
import { ReviewCard } from "../src/web/components/ReviewModal.tsx";
import { SnoozedInboxRow, SnoozedReviewCard, SnoozeSheet } from "../src/web/components/ReviewSnooze.tsx";
import { mkSession, mkTaskSummary } from "./helpers/session-fixture.ts";

const HOUR = 60 * 60_000;
const NOW = Date.UTC(2026, 10, 17, 14, 30);

function question(over: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: "r1",
    sessionId: "s1",
    kind: "input",
    title: "Which linter should this repo use?",
    body: "Which linter should this repo use?",
    status: "pending",
    response: null,
    decisions: [
      {
        id: "q",
        question: "Which linter should this repo use?",
        options: [
          { id: "o0", label: "biome" },
          { id: "o1", label: "ESLint", recommended: true },
        ],
      },
    ],
    selections: null,
    resolvedBy: null,
    snoozable: true,
    createdAt: NOW - HOUR,
    resolvedAt: null,
    ...over,
  };
}

const snoozed = (mode: "judgment" | "option" | "hold", optionId: string | null = null): ReviewItem =>
  question({ status: "snoozed", snooze: { at: NOW, until: NOW + HOUR, mode, optionId, remindedAt: null } });

// ---- what the agent reads ----

test("the agent is told the question is NOT answered, and how to carry on, for each choice", () => {
  const judgment = snoozedToolResultText(snoozed("judgment"), NOW);
  assert.match(judgment, /^Not answered yet: .* ask them again in 1 hour\. Nothing is waiting on you\./);
  assert.match(judgment, /proceed on your best judgment \(the recommended option, if one was offered\)/);

  assert.match(snoozedToolResultText(snoozed("option", "o1"), NOW), /chose "ESLint" as a provisional answer/);
  assert.match(snoozedToolResultText(snoozed("hold"), NOW), /Do not do any work that depends on this answer/);

  // An option that no longer resolves is told best judgment, never a blank label.
  assert.match(snoozedToolResultText(snoozed("option", "gone"), NOW), /proceed on your best judgment/);

  for (const mode of ["judgment", "hold"] as const) {
    assert.match(snoozedToolResultText(snoozed(mode), NOW), /Do not ask this question again yourself/);
  }
  assert.equal(reviewToolResult(snoozed("judgment")).isError, false);
});

test("waits read as the coarse figure an agent needs", () => {
  assert.equal(describeSnoozeWait(15 * 60_000), "15 minutes");
  assert.equal(describeSnoozeWait(HOUR), "1 hour");
  assert.equal(describeSnoozeWait(4 * HOUR), "4 hours");
  assert.equal(describeSnoozeWait(2.5 * HOUR), "about 3 hours");
  assert.equal(describeSnoozeWait(24 * HOUR), "1 day");
  assert.equal(describeSnoozeWait(-5), "1 minute");
});

test("only a pending request_input question offers it, and a provisional answer must be offered", () => {
  assert.equal(canSnoozeReview(question()), true);
  assert.equal(canSnoozeReview(question({ snoozable: undefined })), false);
  assert.equal(canSnoozeReview(snoozed("judgment")), false);
  assert.equal(snoozeMeanwhileProblem(question(), { mode: "option", optionId: "o0" }), null);
  assert.match(snoozeMeanwhileProblem(question(), { mode: "option", optionId: "o7" }) ?? "", /not one of/);
  assert.equal(snoozeMeanwhileLabel(question(), { mode: "option", optionId: "o1" }), 'Go with "ESLint" for now');
});

test("the snooze route takes an offered delay and defaults to best judgment", () => {
  assert.deepEqual(SnoozeReviewSchema.parse({ delay: "1d" }), { delay: "1d", meanwhile: { mode: "judgment" } });
  assert.equal(SnoozeReviewSchema.safeParse({ delay: "3h" }).success, false);
  assert.equal(SnoozeReviewSchema.safeParse({ delay: "1h", meanwhile: { mode: "option" } }).success, false);
});

// ---- what the operator reads ----

test("a reminder reads as a clock time, and says tomorrow when it is", () => {
  assert.equal(reminderClock(NOW + HOUR, NOW, "en-US", "UTC"), "3:30 PM");
  assert.equal(reminderClock(NOW + 24 * HOUR, NOW, "en-US", "UTC"), "tomorrow 2:30 PM");
});

test("tomorrow is the next calendar date in the display zone, across a daylight-saving change", () => {
  // 11:30 PM on March 7, 2026 in New York; clocks spring forward at 2 AM on March 8.
  const lateNight = Date.UTC(2026, 2, 8, 4, 30);
  assert.equal(reminderClock(lateNight + HOUR, lateNight, "en-US", "America/New_York"), "tomorrow 12:30 AM");
  // A day-long snooze from there is 24 hours later, which is two dates ahead: named by weekday.
  assert.equal(reminderClock(lateNight + 24 * HOUR, lateNight, "en-US", "America/New_York"), "Mon 12:30 AM");
  // And the fall change: 11:30 PM on October 31, 2026 (EDT), clocks fall back at 2 AM.
  const fallNight = Date.UTC(2026, 10, 1, 3, 30);
  assert.equal(reminderClock(fallNight + HOUR, fallNight, "en-US", "America/New_York"), "tomorrow 12:30 AM");
  assert.equal(reminderClock(fallNight + 24 * HOUR, fallNight, "en-US", "America/New_York"), "tomorrow 10:30 PM");
});

test("the inbox lists snoozed questions of live sessions, soonest back first", () => {
  const live = mkSession({ id: "s1", state: "working" });
  const gone = mkSession({ id: "s2", state: "exited" });
  const later = { ...snoozed("judgment"), id: "later", snooze: { at: NOW, until: NOW + 4 * HOUR, mode: "judgment" as const, optionId: null, remindedAt: null } };
  const sooner = { ...snoozed("hold"), id: "sooner" };
  const theirs = { ...snoozed("hold"), id: "theirs", sessionId: "s2" };
  const listed = snoozedQuestions([later, question({ id: "open" }), sooner, theirs], [live, gone]);
  assert.deepEqual(listed.map((q) => q.review.id), ["sooner", "later"]);
});

test("the conversation shows a snoozed question where the operator snoozed it", () => {
  const parked = snoozed("judgment");
  const reviews = timelineReviewsFor("s1", [], [parked, { ...parked, id: "other", sessionId: "s9" }, question({ id: "open" })]);
  assert.deepEqual(reviews.map((r) => r.id), ["r1"]);

  const rows = mergeConversation(
    [
      { kind: "turn", id: "m1", ts: NOW - 1, message: { id: "m1", role: "assistant", text: "asking", ts: NOW - 1, tools: [] } },
      { kind: "turn", id: "m2", ts: NOW + 1, message: { id: "m2", role: "assistant", text: "carrying on", ts: NOW + 1, tools: [] } },
    ],
    [],
    reviews,
  );
  assert.deepEqual(rows.map((r) => r.kind), ["turn", "review", "turn"]);
});

test("a request_input card offers Remind me later beside Dismiss; other cards do not", () => {
  assert.match(renderToStaticMarkup(createElement(ReviewCard, { review: question() })), /Remind me later…/);
  assert.doesNotMatch(
    renderToStaticMarkup(createElement(ReviewCard, { review: question({ snoozable: undefined }) })),
    /Remind me later/,
  );
  // An open-ended request_input question offers it too, in its own action row.
  assert.match(
    renderToStaticMarkup(createElement(ReviewCard, { review: question({ decisions: null }) })),
    /Chat about it.*Remind me later…/s,
  );
});

test("a question that came back says it is a reminder and what the agent has been doing", () => {
  const back = question({ snooze: { at: NOW, until: NOW + HOUR, mode: "option", optionId: "o1", remindedAt: NOW + HOUR } });
  const html = renderToStaticMarkup(createElement(ReviewCard, { review: back }));
  assert.match(html, /kind-reminder[^>]*>reminder</);
  assert.match(html, /You snoozed this at/);
  assert.match(html, /kept working with &quot;ESLint&quot; as a provisional answer/);
});

test("the sheet asks when and, the first time only, what the agent does meanwhile", () => {
  const first = renderToStaticMarkup(createElement(SnoozeSheet, { review: question(), onBack: () => {} }));
  for (const label of ["15 minutes", "1 hour", "2 hours", "4 hours", "1 day"]) {
    assert.match(first, new RegExp(`aria-label="${label}"`));
  }
  assert.match(first, /Meanwhile, the agent should/);
  assert.match(first, /Use your best judgment/);
  assert.match(first, /Go with &quot;ESLint&quot; for now/);
  assert.match(first, /Hold work that depends on this/);
  assert.match(first, /Remind me (at|tomorrow)/);

  const again = renderToStaticMarkup(createElement(SnoozeSheet, {
    review: question({ snooze: { at: NOW, until: NOW + HOUR, mode: "hold", optionId: null, remindedAt: NOW + HOUR } }),
    onBack: () => {},
  }));
  assert.doesNotMatch(again, /Meanwhile, the agent should/);
  assert.match(again, /keeps doing what you chose last time: hold work that depends on this/);
});

test("a snoozed question in the inbox and the conversation offers Answer now", () => {
  const row = renderToStaticMarkup(createElement(SnoozedInboxRow, { review: snoozed("judgment"), session: mkSession({ id: "s1", name: "add-lint" }) }));
  assert.match(row, /aria-label="Snoozed: Which linter should this repo use\?"/);
  assert.match(row, /Answer now/);
  assert.match(row, /Meanwhile: use its best judgment/);

  const card = renderToStaticMarkup(createElement(SnoozedReviewCard, { review: snoozed("option", "o0") }));
  assert.match(card, />Snoozed</);
  assert.match(card, /meanwhile: go with &quot;biome&quot; for now/);
  assert.match(card, /Answer now/);
});

test("a question hidden from the inbox shows again when its reminder brings it back", () => {
  const session = mkSession({ id: "s1", state: "working", pendingReviews: 1 });
  const open = question();
  const first = foldAttention({ sessions: [session], reviews: [open], ensembles: [] });
  const hidden = new Map(attentionDismissalKeys(first.items[0]!).map((k) => [k.itemId, k.occurrence]));
  assert.equal(foldAttention({ sessions: [session], reviews: [open], ensembles: [], dismissed: hidden }).total, 0);

  const back = question({ snooze: { at: NOW, until: NOW + HOUR, mode: "judgment", optionId: null, remindedAt: NOW + HOUR } });
  const fold = foldAttention({ sessions: [session], reviews: [back], ensembles: [], dismissed: hidden });
  assert.equal(fold.total, 1);
  assert.equal(fold.items[0]?.kind, "session_reviews");
});

// ---- the snoozed row's name (`inbox` flag): the same rule as every other inbox row ----

/** The row's header name, with the `inbox` flag on or off and the given live resident runs. */
function snoozedRowHead(session: Session, inbox: boolean, residentRuns: { taskId: string; colorId: string; name: string }[] = []): string {
  const config: FeatureFlagsConfig = { enableAll: false, overrides: inbox ? { inbox: true } : {} };
  const runs = residentRuns.map((run) => ({
    taskId: run.taskId,
    settings: { identity: { name: run.name }, board: { colorId: run.colorId } },
  }));
  const html = renderToStaticMarkup(
    createElement(FeatureFlagsContext.Provider, { value: config },
      createElement(ResidentNamesContext.Provider, { value: runs },
        createElement(SnoozedInboxRow, { review: snoozed("judgment"), session }))),
  );
  return /<div class="inbox-head">.*?(<strong[^>]*>[^<]*<\/strong>)/.exec(html)![1]!;
}

test("with the inbox flag off, a snoozed row names its session exactly as before", () => {
  const named = mkSession({ id: "s1", name: "add-lint", task: mkTaskSummary({ id: "t1", title: "Add a linter" }) });
  assert.equal(snoozedRowHead(named, false), "<strong>add-lint</strong>");
  // Off, a resident run changes nothing either.
  assert.equal(snoozedRowHead(named, false, [{ taskId: "t1", name: "Linter watcher", colorId: "teal" }]), "<strong>add-lint</strong>");
  // The row's own fallback for a session with no name is kept.
  assert.equal(snoozedRowHead(mkSession({ id: "s2", name: "", task: null }), false), "<strong>(unnamed)</strong>");
});

test("with the inbox flag on, a snoozed row names its agent by the one rule, a resident in its board colour", () => {
  const named = mkSession({ id: "s1", name: "add-lint", task: mkTaskSummary({ id: "t1", title: "Add a linter" }) });
  assert.equal(snoozedRowHead(named, true), "<strong>Add a linter</strong>");
  assert.equal(
    snoozedRowHead(named, true, [{ taskId: "t1", name: "Linter watcher", colorId: "teal" }]),
    '<strong class="agent-name-resident" style="--resident:var(--resident-teal)">Linter watcher</strong>',
  );
  // With nothing to name it, the rule's own fallback replaces the row's.
  assert.equal(snoozedRowHead(mkSession({ id: "s2", name: "", task: null }), true), "<strong>a session</strong>");
});
