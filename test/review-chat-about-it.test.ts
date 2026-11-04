import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PlanDecision, PlanDecisionAnswer, ReviewItem } from "../src/shared/types.ts";
import { ResolveReviewSchema } from "../src/shared/protocol.ts";
import { formatResponse } from "../src/shared/review-item.ts";
import { isAnswered } from "../src/web/lib/reviews.ts";
import { DecisionForm } from "../src/web/components/PlanDecisions.tsx";
import { ReviewAnswerCard } from "../src/web/components/ReviewAnswer.tsx";
import {
  requestComposerFocus,
  subscribeComposerFocus,
  takeComposerFocus,
} from "../src/web/lib/composer-focus.ts";

const decisions: PlanDecision[] = [
  {
    id: "store",
    question: "Where should review drafts persist?",
    options: [
      { id: "local", label: "localStorage", recommended: true },
      { id: "server", label: "Server-side table" },
    ],
  },
  {
    id: "migrate",
    question: "Should the migration ship in this PR?",
    options: [
      { id: "yes", label: "Yes" },
      { id: "later", label: "No, follow-up PR" },
    ],
  },
  {
    id: "name",
    question: "Name the setting",
    options: [
      { id: "a", label: "reviewDrafts.enabled" },
      { id: "b", label: "drafts.persist" },
    ],
  },
];

const mixed: PlanDecisionAnswer[] = [
  { decisionId: "store", selected: ["local"], other: null },
  { decisionId: "migrate", selected: [], other: null, chat: true },
  { decisionId: "name", selected: ["a"], other: null },
];

test("answered questions and moved ones reach the agent in one response, with what to do", () => {
  assert.equal(
    formatResponse(decisions, mixed, "Plan decisions submitted:"),
    [
      "Plan decisions submitted:",
      "",
      "• Where should review drafts persist?",
      "  → localStorage",
      "",
      "• Should the migration ship in this PR?",
      "  → Chat about it",
      "",
      "• Name the setting",
      "  → reviewDrafts.enabled",
      "",
      "The human wants to discuss this decision with you in conversation before choosing:",
      "- Should the migration ship in this PR?",
      "",
      "Do not choose it yourself, and do not ask it again with request_input or request_plan_decisions." +
        " Act on the other answers only where they do not depend on it.",
      "Then, in your next message, explain it in plain terms: the context behind it, the trade-off" +
        " you cannot settle on your own, and what you would need to know to decide. End your turn" +
        " after that message so the human can reply in this session.",
    ].join("\n"),
  );
});

test("moving every question names them all and has no other answers to act on", () => {
  const all = decisions.map((d) => ({ decisionId: d.id, selected: [], other: null, chat: true }));
  const text = formatResponse(decisions, all, "Plan decisions submitted:");
  assert.match(text, /discuss these 3 decisions with you/);
  assert.match(text, /Do not choose them yourself, and do not ask them again/);
  assert.match(text, /explain each one in plain terms/);
  assert.equal(text.includes("Act on the other answers"), false);
});

test("a moved question drops a pick made before the move but keeps its note", () => {
  const answers: PlanDecisionAnswer[] = [
    { decisionId: "migrate", selected: ["yes"], other: null, chat: true, note: "why is a later PR safer?" },
  ];
  const text = formatResponse([decisions[1]!], answers, "Answered:");
  assert.match(text, /^• Should the migration ship in this PR\?\n {2}→ Chat about it\n {2}Note: why is a later PR safer\?$/m);
  assert.equal(text.includes("→ Yes"), false);
});

test("a response with nothing moved is exactly what it always was", () => {
  const answers: PlanDecisionAnswer[] = [{ decisionId: "store", selected: ["local"], other: null }];
  assert.equal(
    formatResponse([decisions[0]!], answers, "Answered:"),
    "Answered:\n\n• Where should review drafts persist?\n  → localStorage",
  );
});

test("a moved question counts as answered, so the rest can be submitted", () => {
  assert.equal(isAnswered(decisions[1]!, { decisionId: "migrate", selected: [], other: null, chat: true }), true);
  assert.equal(isAnswered(decisions[1]!, { decisionId: "migrate", selected: [], other: null, chat: false }), false);
});

test("the resolve route keeps the chat mark, and leaves it off answers that never had one", () => {
  const parsed = ResolveReviewSchema.parse({ action: "answer", response: "x", selections: mixed });
  assert.deepEqual(parsed.selections, [
    { decisionId: "store", selected: ["local"], other: null },
    { decisionId: "migrate", selected: [], other: null, chat: true },
    { decisionId: "name", selected: ["a"], other: null },
  ]);
});

function renderForm(props: Partial<Parameters<typeof DecisionForm>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(DecisionForm, { decisions, busy: false, onSubmit: () => {}, onDismiss: () => {}, ...props }),
  );
}

test("every question offers Chat about it in its own group, plus Chat about all", () => {
  const html = renderForm({ allowChat: true, namePrefix: "r1" });
  assert.equal(html.match(/class="decision-option decision-chat"/g)?.length, 3);
  // The row is a choice in the question's own radio group, so picking it clears the others.
  for (const d of decisions) {
    assert.equal(html.match(new RegExp(`name="r1-${d.id}"`, "g"))?.length, d.options.length + 1);
  }
  assert.match(html, />Chat about all<\/button>/);
  assert.match(html, /<button[^>]*disabled[^>]*>Submit<\/button>/);
});

test("a single question gets the row but no redundant Chat about all", () => {
  const html = renderForm({ allowChat: true, decisions: [decisions[0]!] });
  assert.match(html, /Chat about it/);
  assert.equal(html.includes("Chat about all"), false);
});

test("a form that cannot reach a conversation offers neither", () => {
  const html = renderForm();
  assert.equal(html.includes("Chat about"), false);
});

test("a moved question is drawn checked and Submit names the chat", () => {
  const html = renderForm({
    allowChat: true,
    answers: {
      store: { selected: ["local"], other: "", note: "" },
      migrate: { selected: [], other: "", note: "", chat: true },
      name: { selected: ["a"], other: "", note: "" },
    },
    onAnswersChange: () => {},
  });
  assert.match(html, /class="decision-option decision-chat is-chat"/);
  assert.match(html, /<button class="btn btn-approve"[^>]*>Submit &amp; chat \(1\)<\/button>/);
});

function answered(over: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: "r1",
    sessionId: "s1",
    kind: "plan-decisions",
    title: "Drafts plan",
    body: "## Drafts",
    status: "answered",
    response: formatResponse(decisions, mixed, "Plan decisions submitted:"),
    decisions,
    selections: mixed,
    resolvedBy: "human",
    createdAt: 1000,
    resolvedAt: 2000,
    ...over,
  };
}

const replay = (r: ReviewItem): string => renderToStaticMarkup(createElement(ReviewAnswerCard, { review: r }));

test("the conversation shows a moved question as moved, not as unanswered", () => {
  const html = replay(answered());
  assert.equal(html.match(/Moved to chat/g)?.length, 1);
  assert.equal(html.includes("No option chosen"), false);
  assert.match(html, /aria-label="Chosen: localStorage"/);
});

test("an open-ended question moved to chat shows the fact and the note, not the agent's instruction", () => {
  const selections: PlanDecisionAnswer[] = [
    { decisionId: "q", selected: [], other: null, chat: true, note: "what is a shard here?" },
  ];
  const html = replay(answered({
    kind: "input",
    title: "What retry budget for flaky shards?",
    body: "What retry budget for flaky shards?",
    decisions: null,
    selections,
    response: formatResponse(
      [{ id: "q", question: "What retry budget for flaky shards?", options: [] }],
      selections,
      "Answered:",
    ),
  }));
  assert.match(html, /Moved to chat/);
  assert.match(html, /what is a shard here\?/);
  assert.equal(html.includes("Do not choose"), false);
});

test("a focus request is taken once, by the session it names, while it is fresh", () => {
  const heard: string[] = [];
  const off = subscribeComposerFocus("s1", () => heard.push("s1"));
  requestComposerFocus("s2", 1_000);
  assert.deepEqual(heard, [], "another session's request is not heard");
  requestComposerFocus("s1", 1_000);
  assert.deepEqual(heard, ["s1"]);
  assert.equal(takeComposerFocus("s1", 1_500), true);
  assert.equal(takeComposerFocus("s1", 1_500), false, "one request focuses once");
  assert.equal(takeComposerFocus("s2", 60_000), false, "a stale request steals nothing");
  off();
});
