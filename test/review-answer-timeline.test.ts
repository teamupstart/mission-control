import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PlanDecision, PlanDecisionAnswer, ReviewItem } from "../src/shared/types.ts";
import { ResolveReviewSchema } from "../src/shared/protocol.ts";
import { isHumanResolvedReview } from "../src/shared/review-item.ts";
import {
  answeredDecisions,
  formatResponse,
  isAnswered,
  reviewAnswerVerb,
  selectedOptions,
} from "../src/web/lib/reviews.ts";
import { ReviewAnswerCard } from "../src/web/components/ReviewAnswer.tsx";
import { timelineReviewsFor } from "../src/web/lib/timelineReviews.ts";

// What is at stake: a decision the human made must be visible in the conversation where
// they made it.
//
// A review's answer reaches the agent as an MCP tool result, and every harness parser drops
// a user turn that is purely a tool result as machine noise (`harness/claude/transcript.ts`).
// So the log showed the agent's question as a grey tool chip, then a silence, then the agent
// carrying on as though something had been decided - with the decision readable only on a
// card that vanished the instant it was submitted.
//
// Two rules protect the fix. The conversation shows what was CHOSEN and what it was chosen
// FROM, which the flattened response string cannot say. And it credits only the human -
// Foreman resolves through the same route, and its answers are already in the log as their
// own episode.

const decision: PlanDecision = {
  id: "q",
  question: "Which linter should this repo use?",
  options: [
    { id: "o0", label: "biome", detail: "lint + format in one binary" },
    { id: "o1", label: "eslint", recommended: true },
    { id: "o2", label: "oxlint" },
  ],
};

function review(over: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: "r1",
    sessionId: "s1",
    kind: "input",
    title: decision.question,
    body: decision.question,
    status: "answered",
    response: "Answered:\n\n• Which linter should this repo use?\n  → eslint",
    decisions: [decision],
    selections: [{ decisionId: "q", selected: ["o1"], other: null }],
    resolvedBy: "human",
    createdAt: 1000,
    resolvedAt: 2000,
    ...over,
  };
}

const render = (r: ReviewItem): string =>
  renderToStaticMarkup(createElement(ReviewAnswerCard, { review: r }));

// ---- who gets into the conversation ----

test("a human-resolved review belongs in the conversation", () => {
  for (const status of ["answered", "approved", "rejected", "dismissed"] as const) {
    assert.equal(
      isHumanResolvedReview(review({ status })),
      true,
      `${status} is a decision the human made`,
    );
  }
});

test("a pending review is NOT in the conversation", () => {
  // The question is still on screen. Showing it would put an unanswered ask in the log as
  // though it had been answered.
  assert.equal(isHumanResolvedReview(review({ status: "pending", resolvedBy: null })), false);
});

test("Foreman's answer stays out of the conversation", () => {
  // It is already there as its own episode card. Admitting it here would draw the same
  // moment twice - once as Foreman, once as if you had answered it yourself.
  assert.equal(isHumanResolvedReview(review({ resolvedBy: "foreman" })), false);
});

test("an orphaned review is nobody's answer", () => {
  // The session went away before anyone decided. Not evidence of intent, and not a voice.
  assert.equal(isHumanResolvedReview(review({ status: "orphaned", resolvedBy: null })), false);
});

test("a row from before the actor column is not credited to the human", () => {
  // It may well have been a human, but the record does not say so, and the conversation
  // must not put words in the operator's mouth on the strength of a status alone.
  assert.equal(isHumanResolvedReview(review({ resolvedBy: null })), false);
});

// ---- which of the two sources reaches one session's conversation ----

test("the durable history and the live stream union by id, live winning", () => {
  // The same row from both halves is one entry, and the live copy is never the older one.
  const stale = review({ response: "an older copy" });
  const fresh = review({ response: "what the daemon last published" });
  const merged = timelineReviewsFor("s1", [stale], [fresh]);
  assert.equal(merged.length, 1, "one row, not two");
  assert.equal(merged[0]?.response, "what the daemon last published");
});

test("a previous session's fetched history never leaks into the next one", () => {
  // The regression this guards: `stored` is emptied in an EFFECT, and an effect runs after
  // the render that first sees the new session id. For that one frame the hook still holds
  // the session you just left. Scoping only the live list - and trusting the fetch's own
  // endpoint to have scoped the rest - draws session A's gold answers into session B's
  // conversation until React gets round to the effect.
  const fromSessionA = review({ id: "r-a", sessionId: "s1" });
  const merged = timelineReviewsFor("s2", [fromSessionA], []);
  assert.deepEqual(merged, [], "B's conversation shows none of A's answers");
});

test("a pending review on the live stream is not an answer", () => {
  const pending = review({ id: "r-pending", status: "pending", resolvedBy: null });
  assert.deepEqual(timelineReviewsFor("s1", [], [pending]), []);
});

test("Foreman's live resolution never reaches the conversation", () => {
  const byForeman = review({ id: "r-foreman", resolvedBy: "foreman" });
  assert.deepEqual(timelineReviewsFor("s1", [], [byForeman]), []);
});

test("this session's own answers do come through, from either half", () => {
  const stored = review({ id: "r-stored" });
  const live = review({ id: "r-live" });
  assert.deepEqual(
    timelineReviewsFor("s1", [stored], [live]).map((r) => r.id),
    ["r-stored", "r-live"],
  );
});

// ---- the response string and the selections agree ----

test("the agent's response string is derived from the persisted selections", () => {
  // One derivation, so the string the agent read and the record the log replays can never
  // describe different answers.
  const answers: PlanDecisionAnswer[] = [{ decisionId: "q", selected: ["o1"], other: null }];
  assert.equal(
    formatResponse([decision], answers, "Answered:"),
    "Answered:\n\n• Which linter should this repo use?\n  → eslint",
  );
});

test("a multi-select keeps the order the agent listed, not the order clicked", () => {
  const answers: PlanDecisionAnswer[] = [{ decisionId: "q", selected: ["o2", "o0"], other: null }];
  assert.match(formatResponse([decision], answers, "Answered:"), /→ biome, oxlint/);
});

test("free text rides along with the chosen options", () => {
  const withOther: PlanDecision = { ...decision, allowOther: true };
  const answers: PlanDecisionAnswer[] = [{ decisionId: "q", selected: ["o1"], other: "  pinned  " }];
  assert.match(formatResponse([withOther], answers, "Answered:"), /Other: pinned$/);
});

test("a decision answered by nothing at all says so", () => {
  const answers: PlanDecisionAnswer[] = [{ decisionId: "q", selected: [], other: null }];
  assert.match(formatResponse([decision], answers, "Answered:"), /→ \(no selection\)/);
});

test("free text alone answers a decision that allows it, and nothing else does", () => {
  const withOther: PlanDecision = { ...decision, allowOther: true };
  const only = { decisionId: "q", selected: [], other: "something else" };
  assert.equal(isAnswered(withOther, only), true, "allowOther accepts text alone");
  assert.equal(isAnswered(decision, only), false, "without allowOther, text is not an answer");
  assert.equal(isAnswered(decision, undefined), false, "an untouched decision is unanswered");
});

// ---- pairing questions with what was picked ----

test("selections are read back as the options the agent listed", () => {
  assert.deepEqual(
    selectedOptions(decision, { decisionId: "q", selected: ["o1"], other: null }).map((o) => o.id),
    ["o1"],
  );
});

test("an option id that no longer exists is dropped, not drawn blank", () => {
  // A review answered against a question the agent has since rewritten.
  assert.deepEqual(
    selectedOptions(decision, { decisionId: "q", selected: ["gone"], other: null }),
    [],
  );
});

test("a review with no stored selections has no form to replay", () => {
  // Every resolution with no form behind it - a free-text input, an approve note, a
  // dismissal, an answer stored before selections were recorded.
  assert.deepEqual(answeredDecisions(review({ selections: null })), []);
  assert.deepEqual(answeredDecisions(review({ decisions: null })), []);
});

test("the byline names what was actually done", () => {
  // Status and not kind: a diff sent back and one waved through are the same review and
  // opposite answers.
  assert.equal(reviewAnswerVerb(review({ status: "approved" })), "you approved");
  assert.equal(reviewAnswerVerb(review({ status: "rejected" })), "you requested changes");
  assert.equal(reviewAnswerVerb(review({ status: "dismissed" })), "you dismissed");
  assert.equal(reviewAnswerVerb(review({ status: "answered" })), "you answered");
});

// ---- what the conversation actually draws ----

test("the card replays every option, marking the one taken", () => {
  const html = render(review());
  assert.match(html, /you answered/, "the byline says who decided");
  assert.match(html, /Which linter should this repo use\?/, "the question is shown");
  for (const label of ["biome", "eslint", "oxlint"]) {
    assert.match(html, new RegExp(label), `${label} is shown, chosen or not`);
  }
  assert.match(
    html,
    /class="review-answer-option is-picked"[^>]*aria-label="Chosen: eslint"/,
    "the taken option is marked, and says so to assistive tech",
  );
  assert.match(html, /aria-label="Not chosen: biome"/, "and the untaken ones say that");
});

test("a question the header already carries is not printed twice", () => {
  // `request_input` sends the question as the title AND as its one decision, so the card
  // would say the same sentence twice - the duplication `showsBody` prevents on the form.
  const html = render(review());
  const asked = "Which linter should this repo use?";
  assert.equal(html.split(asked).length - 1, 1, "the question appears exactly once, anywhere");
  assert.equal(html.includes("review-answer-q"), false, "the redundant heading is dropped");
  // Named by REFERENCE to the header, not by a copied string: repeating it in an aria-label
  // would have a screen reader read the same sentence twice in a row.
  assert.match(html, /<ul class="review-answer-options" aria-labelledby="ra-r1-title">/);
  assert.match(html, /id="ra-r1-title"/, "and the header carries that id");
});

test("a question too long for the title is shown in full below it", () => {
  // Past `titleLine`'s clip the title says less than the question does, and the header
  // truncates to one line - so this is the case that most needs the full text.
  const html = render(review({ title: "Which linter should this repo…" }));
  assert.match(html, /class="review-answer-q" id="ra-r1-0-q">Which linter should this repo use\?</);
  assert.match(html, /aria-labelledby="ra-r1-0-q"/, "and the list names itself by it");
});

test("a plan's several questions all show, since the title is the plan's", () => {
  const second: PlanDecision = { id: "q2", question: "Ship behind a flag?", options: [{ id: "y", label: "Yes" }] };
  const html = render(
    review({
      kind: "plan-decisions",
      title: "Lint and release plan",
      decisions: [decision, second],
      selections: [
        { decisionId: "q", selected: ["o1"], other: null },
        { decisionId: "q2", selected: ["y"], other: null },
      ],
    }),
  );
  assert.match(html, /Which linter should this repo use\?/);
  assert.match(html, /Ship behind a flag\?/);
  assert.equal(html.split("review-answer-q").length - 1, 2, "both questions get a heading");
});

test("the card is inert - a record, never a control", () => {
  // A resolved review cannot be re-answered, and a disabled input announces itself as a
  // control you may not use, which is a lie about a record.
  const html = render(review());
  for (const tag of ["<input", "<button", "<textarea", "<select"]) {
    assert.equal(html.includes(tag), false, `no ${tag} in a replayed answer`);
  }
});

test("free text typed into Other is shown, tagged as not one of the options", () => {
  const html = render(
    review({
      decisions: [{ ...decision, allowOther: true }],
      selections: [{ decisionId: "q", selected: [], other: "oxlint, but pinned" }],
    }),
  );
  assert.match(html, /Other/, "the free text is labelled");
  assert.match(html, /oxlint, but pinned/);
});

test("a question closed with nothing chosen says so rather than showing an empty block", () => {
  const html = render(
    review({ status: "dismissed", selections: [{ decisionId: "q", selected: [], other: null }] }),
  );
  assert.match(html, /you dismissed/);
  assert.match(html, /No option chosen\./);
});

test("a free-text answer falls back to the response the agent received", () => {
  const html = render(
    review({ decisions: null, selections: null, response: "use eslint, and turn on --fix" }),
  );
  assert.match(html, /use eslint, and turn on --fix/);
  assert.equal(html.includes("review-answer-options"), false, "no form is invented for it");
});

test("an approval with no note ends at the byline instead of drawing an empty box", () => {
  const html = render(
    review({ kind: "diff", status: "approved", decisions: null, selections: null, response: null }),
  );
  assert.match(html, /you approved/);
  assert.equal(html.includes("review-answer-text"), false, "no empty prose element");
});

// ---- the wire contract ----

test("a resolution is the human's unless it says otherwise", () => {
  // The route is the dashboard's, so the default has to be the human; the Foreman worker is
  // the one caller that must declare itself.
  const parsed = ResolveReviewSchema.safeParse({ action: "answer", response: "ok" });
  assert.ok(parsed.success);
  assert.equal(parsed.data.by, "human");
});

test("Foreman can declare itself on the same route", () => {
  const parsed = ResolveReviewSchema.safeParse({ action: "answer", response: "ok", by: "foreman" });
  assert.ok(parsed.success);
  assert.equal(parsed.data.by, "foreman");
});

test("selections ride along with an answer", () => {
  const parsed = ResolveReviewSchema.safeParse({
    action: "answer",
    response: "Answered:\n\n• q\n  → eslint",
    selections: [{ decisionId: "q", selected: ["o1"] }],
  });
  assert.ok(parsed.success);
  assert.deepEqual(parsed.data.selections, [{ decisionId: "q", selected: ["o1"], other: null }]);
});

test("a dismiss stores no selections, however contradictory the request", () => {
  // A client sending both a dismissal and a set of selections is contradicting itself; the
  // stored row must not.
  const parsed = ResolveReviewSchema.safeParse({
    action: "dismiss",
    response: "changed my mind",
    selections: [{ decisionId: "q", selected: ["o1"] }],
  });
  assert.ok(parsed.success);
  assert.equal(parsed.data.response, null);
  assert.equal(parsed.data.selections, null);
});
