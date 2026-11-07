import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PlanDecision, ReviewItem } from "../src/shared/types.ts";
import { decisionLead, formatResponse } from "../src/shared/review-item.ts";
import { quickDecision, quickSelections } from "../src/web/lib/reviews.ts";
import { QuickDecisionButtons } from "../src/web/components/QuickDecisionButtons.tsx";
import { decisionChoiceKey } from "../src/web/components/PlanDecisions.tsx";

// `ReviewCard` itself cannot be imported here (react-diff-view's stylesheet, see
// overlay-registry.test.ts), so its quick-answer branch is pinned through the two pieces it is
// built from: the rule admitting a question, and the buttons it draws.

const SHIP: PlanDecision = {
  id: "q",
  question: "Ship the nightly migration?",
  options: [{ id: "yes", label: "Ship it" }, { id: "no", label: "Hold it", detail: "Wait for the backup." }],
  allowOther: false,
};

function ask(over: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: "rv-1", sessionId: "s1", kind: "input", status: "pending",
    title: SHIP.question, body: SHIP.question, decisions: [SHIP],
    response: null, createdAt: 1, resolvedAt: null,
    ...over,
  } as ReviewItem;
}

test("only a single single-select request_input question is answered by one press", () => {
  assert.equal(quickDecision(ask()), SHIP);
  // Everything a press cannot carry keeps the full form.
  assert.equal(quickDecision(ask({ decisions: [SHIP, { ...SHIP, id: "q2" }] })), null);
  assert.equal(quickDecision(ask({ decisions: [{ ...SHIP, multiSelect: true }] })), null);
  assert.equal(quickDecision(ask({ decisions: [{ ...SHIP, allowOther: true }] })), null);
  assert.equal(quickDecision(ask({ kind: "plan-decisions" })), null);
  assert.equal(quickDecision(ask({ standingApprovalEligible: true })), null);
  // The open-ended ask has no options to press, and keeps its textarea.
  assert.equal(quickDecision(ask({ decisions: undefined })), null);
  assert.equal(quickDecision(ask({ kind: "diff", decisions: undefined })), null);
});

test("a press sends the selection the form would have sent", () => {
  const picked = quickSelections(SHIP, { optionId: "no" });
  assert.deepEqual(picked, [{ decisionId: "q", selected: ["no"], other: null }]);
  assert.match(formatResponse([SHIP], picked, decisionLead("input")), /Hold it/);
  const chat = quickSelections(SHIP, "chat");
  assert.deepEqual(chat, [{ decisionId: "q", selected: [], other: null, chat: true }]);
});

test("each option is a button, beside Dismiss and Chat about it, with no radio and no Submit", () => {
  const html = renderToStaticMarkup(createElement(QuickDecisionButtons, {
    decision: SHIP,
    busy: false,
    recommended: new Set([decisionChoiceKey("q", "yes")]),
    onAnswer: () => {},
    onDismiss: () => {},
  }));
  assert.match(html, /role="group" aria-label="Answer: Ship the nightly migration\?"/);
  assert.match(html, /<button type="button" class="btn review-quick-option is-foreman-pick"[^>]*>Ship it<\/button>/);
  assert.match(html, /<button type="button" class="btn review-quick-option"[^>]*>Hold it<\/button>/);
  assert.match(html, />Dismiss<\/button>/);
  assert.match(html, /Chat about it<\/button>/);
  assert.doesNotMatch(html, /type="radio"/);
  assert.doesNotMatch(html, />Submit</);
});

test("while an answer is in flight every button is disabled", () => {
  const html = renderToStaticMarkup(createElement(QuickDecisionButtons, {
    decision: SHIP, busy: true, onAnswer: () => {}, onDismiss: () => {},
  }));
  assert.equal((html.match(/<button /g) ?? []).length, 4);
  assert.equal((html.match(/disabled=""/g) ?? []).length, 4);
});
