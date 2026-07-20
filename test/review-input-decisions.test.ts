import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PlanDecision, ReviewItem } from "../src/shared/types.ts";
import { CreateReviewSchema } from "../src/shared/protocol.ts";
import { reviewDecisions, decisionLead } from "../src/web/lib/reviews.ts";
import { DecisionForm } from "../src/web/components/PlanDecisions.tsx";

// What is at stake: the question has to arrive as ARGUMENTS, not as a picture of a menu.
//
// Disallowing Claude's built-in `AskUserQuestion` is only an improvement if what replaces it
// carries the same information. `request_input` used to take free text alone, so an agent
// asking "eslint, biome, or oxlint?" collapsed its three options into one prose string and
// the human got a textarea - the same guessing game, one layer further from the screen.
//
// So: an `input` review may carry exactly one decision, it must be answered with the form
// rather than the textarea, and the answer must not tell the agent it submitted a plan.
//
// `ReviewModal` itself is deliberately NOT imported - it pulls in react-diff-view, which
// imports a .css file Node cannot load (see overlay-registry.test.ts). That is precisely why
// the branch lives in `web/lib/reviews.ts` as a pure predicate: so it can be asserted here
// instead of only inside a component nothing can render.

const decision: PlanDecision = {
  id: "q",
  question: "Which linter should this repo use?",
  options: [
    { id: "o0", label: "biome", detail: "lint + format in one binary" },
    { id: "o1", label: "eslint", recommended: true },
  ],
};

function review(over: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: "r1",
    sessionId: "s1",
    kind: "input",
    title: decision.question,
    body: decision.question,
    status: "pending",
    response: null,
    decisions: null,
    createdAt: 0,
    resolvedAt: null,
    ...over,
  };
}

const base = { env: {}, kind: "input" as const, title: "q", body: "q" };

test("an input review accepts exactly one decision", () => {
  assert.ok(CreateReviewSchema.safeParse({ ...base, decisions: [decision] }).success);
  assert.ok(CreateReviewSchema.safeParse(base).success, "free text stays the open-ended ask");
  // More than one would break every downstream reader, all of which take the question by
  // position - the single fieldset, the "Answered:" lead.
  assert.equal(
    CreateReviewSchema.safeParse({ ...base, decisions: [decision, decision] }).success,
    false,
  );
});

test("kinds with nowhere to draw a form cannot carry decisions", () => {
  for (const kind of ["plan", "diff"] as const) {
    assert.equal(
      CreateReviewSchema.safeParse({ ...base, kind, decisions: [decision] }).success,
      false,
      `${kind} has no control to render decisions on`,
    );
    // Belt and braces: even if one reached the client, it is ignored rather than drawn.
    assert.equal(reviewDecisions(review({ kind, decisions: [decision] })), null);
  }
});

test("an input with options is answered by the form; without them, by free text", () => {
  assert.deepEqual(reviewDecisions(review({ decisions: [decision] })), [decision]);
  assert.equal(reviewDecisions(review()), null, "an open-ended ask keeps its textarea");
  assert.deepEqual(
    reviewDecisions(review({ kind: "plan-decisions", decisions: [decision] })),
    [decision],
    "plan-decisions is unaffected",
  );
});

test("the agent is not told it submitted a plan it never wrote", () => {
  // This string is handed back as the tool result verbatim and lands in the transcript.
  assert.equal(decisionLead("input"), "Answered:");
  assert.equal(decisionLead("plan-decisions"), "Plan decisions submitted:");
});

test("discrete choices become real controls, carrying detail and the recommendation", () => {
  const html = renderToStaticMarkup(
    createElement(DecisionForm, { decisions: [decision], busy: false, onSubmit: () => {} }),
  );
  assert.match(html, /type="radio"/);
  assert.match(html, /biome/);
  assert.match(html, /lint \+ format in one binary/, "detail reaches the human");
  assert.match(html, /recommended/);
});

test("the form does not reprint a question the modal already headlines", () => {
  // `request_input` sends the question as the review title AND as the decision's question,
  // so an unsuppressed legend renders it twice in the same modal, once as the header and
  // again immediately beneath. Caught on screen, not in the diff.
  const html = renderToStaticMarkup(
    createElement(DecisionForm, {
      decisions: [decision],
      busy: false,
      onSubmit: () => {},
      hideQuestions: true,
    }),
  );
  assert.doesNotMatch(html, /<legend/, "the header is the question's one home");
  // The group still has to be NAMED for anyone not looking at the header.
  assert.ok(html.includes(`aria-label="${decision.question}"`), "the group is still named");
  assert.match(html, /biome/, "the options themselves are untouched");
});

test("a plan-decisions form keeps its legends", () => {
  const html = renderToStaticMarkup(
    createElement(DecisionForm, { decisions: [decision], busy: false, onSubmit: () => {} }),
  );
  // Several questions under one plan title: here the legend is the only thing naming each.
  assert.ok(html.includes(`<legend class="decision-q">${decision.question}</legend>`));
});

test("multiSelect asks for checkboxes", () => {
  const html = renderToStaticMarkup(
    createElement(DecisionForm, {
      decisions: [{ ...decision, multiSelect: true }],
      busy: false,
      onSubmit: () => {},
    }),
  );
  assert.match(html, /type="checkbox"/);
});
