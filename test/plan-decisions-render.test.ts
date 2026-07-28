import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DecisionForm } from "../src/web/components/PlanDecisions.tsx";
import type { PlanDecision } from "../src/shared/types.ts";
import { hasTooltip } from "./helpers/markup.ts";

// Rendered rather than driven through a browser: the dashboard's SSE stream holds the
// connection open, which hangs headless automation. Static markup is enough to prove the
// form renders each question with the right control type, the recommended/detail hints,
// an "Other" field only where asked, and a Submit that starts disabled so the agent can't
// unblock on an empty form. (The form is rendered directly rather than through ReviewModal
// because this unit only needs the decision form, not the surrounding review protocols.)

const decisions: PlanDecision[] = [
  {
    id: "store",
    question: "Where should sessions live?",
    options: [
      { id: "redis", label: "Use Redis", detail: "one more service to run", recommended: true },
      { id: "pg", label: "Postgres table" },
    ],
  },
  {
    id: "providers",
    question: "Which providers ship first?",
    options: [
      { id: "google", label: "Google" },
      { id: "github", label: "GitHub" },
    ],
    multiSelect: true,
    allowOther: true,
  },
];

function render(ds: PlanDecision[] = decisions): string {
  return renderToStaticMarkup(
    createElement(DecisionForm, { decisions: ds, busy: false, onSubmit: () => {} }),
  );
}

test("renders every question and option", () => {
  const html = render();
  assert.match(html, /Where should sessions live\?/);
  assert.match(html, /Which providers ship first\?/);
  assert.match(html, /Use Redis/);
  assert.match(html, /Postgres table/);
  assert.match(html, /Google/);
  assert.match(html, /GitHub/);
});

test("single-select renders radios, multi-select renders checkboxes", () => {
  const html = render();
  // The group name is the decision id under a per-form prefix, because a `name` is
  // document-scoped and several forms can share one document - see `namePrefix`.
  assert.match(html, /type="radio"[^>]*name="[^"]*-store"/);
  assert.match(html, /type="checkbox"[^>]*name="[^"]*-providers"/);
});

test("a recommended option shows the hint and details render", () => {
  const html = render();
  assert.match(html, /recommended/);
  assert.match(html, /one more service to run/);
  assert.ok(hasTooltip(html, "one more service to run"));
  assert.ok(hasTooltip(html, "Postgres table"));
});

test("allowOther adds a free-text field only where asked", () => {
  // Exactly one "Other…" input: the providers decision, not the store decision.
  assert.equal(render().match(/placeholder="Other/g)?.length, 1);
});

test("Submit starts disabled so the agent can't unblock on an empty form", () => {
  const html = render();
  assert.match(html, /<button[^>]*disabled[^>]*>Submit<\/button>/);
});

test("a review can expose Dismiss without treating it as a submitted choice", () => {
  const html = renderToStaticMarkup(
    createElement(DecisionForm, {
      decisions,
      busy: false,
      onSubmit: () => {},
      onDismiss: () => {},
    }),
  );
  assert.match(html, /<button[^>]*>Dismiss<\/button>/);
  assert.match(html, /<button[^>]*disabled[^>]*>Submit<\/button>/);
});

test("zero decisions leave Submit disabled rather than vacuously complete", () => {
  // A degraded `decisions` blob reaches the form as an empty list; "every decision is
  // answered" is trivially true for none of them, so Submit must be gated on having
  // something to submit or the agent unblocks on a content-free response.
  assert.match(render([]), /<button[^>]*disabled[^>]*>Submit<\/button>/);
});
