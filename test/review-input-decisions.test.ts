import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PlanDecision, ReviewItem } from "../src/shared/types.ts";
import { CreateReviewSchema } from "../src/shared/protocol.ts";
import { reviewDecisions, decisionLead, showsBody } from "../src/web/lib/reviews.ts";
import { DecisionForm } from "../src/web/components/PlanDecisions.tsx";
import { titleLine, TITLE_MAX_CHARS } from "../src/shared/title.ts";

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

test("an input body is shown only when it says something the header does not", () => {
  // `request_input` sends a CLIPPED question as the title and the whole one as the body, so
  // the two are equal exactly when the question fit in a heading. Rendering both there printed
  // the same sentence twice; suppressing it unconditionally would instead flatten a long,
  // multi-line free-text question into a bold heading with its newlines collapsed.
  const same = review({ title: "Pick one", body: "Pick one" });
  const differs = review({ title: "Pick one", body: "Line one\nLine two, at length." });
  assert.equal(showsBody(same), false, "equal title and body must not print twice");
  assert.equal(showsBody(differs), true, "a body with its own content is still readable prose");
  // Kinds that carry real content are untouched by the rule.
  assert.equal(showsBody(review({ kind: "plan", title: "T", body: "# plan" })), true);
});

test("what request_input actually sends reaches showsBody both ways", () => {
  // The rule above is only worth anything if the producer can produce both cases. It could
  // not: `request_input` sent the question as title AND body, so `body !== title` never fired
  // for any review the tool made, and the readable `pre-wrap` paragraph was unreachable for
  // exactly the long questions it exists to carry. `titleLine` is what the producer now uses.
  const short = "Pick one";
  const long =
    "Should the migration run in one transaction, or in batches?\n" +
    "The table has 40 million rows and the replica lag budget is 5 seconds.";

  assert.equal(titleLine(short), short, "a short question is its own heading");
  assert.equal(showsBody(review({ title: titleLine(short), body: short })), false);

  assert.notEqual(titleLine(long), long, "a long or multi-line question is clipped to a line");
  assert.ok(titleLine(long).length <= TITLE_MAX_CHARS + 1, "clipped to the shared bound");
  assert.equal(
    showsBody(review({ title: titleLine(long), body: long })),
    true,
    "the full question still reaches the human as the readable paragraph",
  );
});

test("two forms in one document do not share a radio group", () => {
  // `ReviewModal` draws every pending review of a session into ONE document, and
  // `request_input` hardcodes its decision id as `q`. Sharing a `name` makes the browser treat
  // both cards' radios as a single group: clicking in the second unchecks the first in the
  // DOM, while React re-renders only the card whose state changed - so the first shows nothing
  // selected while its state still holds a selection and its Submit stays enabled.
  const render = (namePrefix: string): string =>
    renderToStaticMarkup(
      createElement(DecisionForm, { decisions: [decision], busy: false, onSubmit: () => {}, namePrefix }),
    );
  const names = (html: string): string[] =>
    [...html.matchAll(/name="([^"]+)"/g)].map((m) => m[1] ?? "");

  const first = names(render("r1"));
  const second = names(render("r2"));
  assert.ok(first.length > 0, "the radios are named at all");
  assert.equal(new Set([...first, ...second]).size, 2, "one group per form, never one shared");
  // The id itself must survive untouched - it is echoed back in the response payload.
  assert.ok(
    first.every((n) => n.endsWith(`-${decision.id}`)),
    "the prefix namespaces the id rather than replacing it",
  );
});
