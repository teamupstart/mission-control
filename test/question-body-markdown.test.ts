import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReviewItem } from "../src/shared/types.ts";
import { FEATURE_FLAGS, MARKDOWN_QUESTIONS_FLAG_ID } from "../src/shared/feature-flag-registry.ts";
import { FEATURE_FLAGS_DEFAULTS, type FeatureFlagsConfig } from "../src/shared/feature-flags.ts";
import { DECISION_CONTEXT_RULE, inputReviewBody } from "../src/shared/decision-asks.ts";
import { FeatureFlagsContext } from "../src/web/useFeatureFlag.ts";
import { QuestionBody, questionLinkPath } from "../src/web/components/QuestionBody.tsx";
import { ClosedQuestionCard } from "../src/web/components/AskedQuestion.tsx";

const ON: FeatureFlagsConfig = { enableAll: false, overrides: { [MARKDOWN_QUESTIONS_FLAG_ID]: true } };

function render(element: ReactElement, config: FeatureFlagsConfig = ON): string {
  return renderToStaticMarkup(createElement(FeatureFlagsContext.Provider, { value: config }, element));
}

const BULLETED = "Two ways to ship this:\n\n- keep the old name\n- rename it everywhere\n\n## Found\n\nCI runs `npm test` only.";

test("the Markdown questions flag ships as an off-by-default preview", () => {
  const flag = FEATURE_FLAGS.find((candidate) => candidate.id === MARKDOWN_QUESTIONS_FLAG_ID);
  assert.equal(flag?.stage, "preview");
  assert.equal(
    renderToStaticMarkup(createElement(QuestionBody, { className: "question", text: "- a" })),
    '<p class="question">- a</p>',
    "with no provider the dashboard's defaults hold, and a preview is off",
  );
  assert.equal(FEATURE_FLAGS_DEFAULTS.enableAll, false);
});

test("with the flag off the body is the plain paragraph it always was", () => {
  const html = render(createElement(QuestionBody, { className: "question", text: BULLETED }), FEATURE_FLAGS_DEFAULTS);
  assert.equal(html, `<p class="question">${BULLETED}</p>`);
  assert.doesNotMatch(html, /<li>/);
});

test("with the flag on a bulleted context renders as list items, headings and code", () => {
  const html = render(createElement(QuestionBody, { className: "question", text: BULLETED }));
  assert.match(html, /^<div class="question markdown question-markdown">/);
  assert.match(html, /<ul>\s*<li>keep the old name<\/li>\s*<li>rename it everywhere<\/li>\s*<\/ul>/);
  assert.match(html, /<h2>Found<\/h2>/);
  assert.match(html, /<code>npm test<\/code>/);
});

test("a plain-text body keeps its paragraphs and its line breaks", () => {
  const html = render(createElement(QuestionBody, {
    className: "question",
    text: "First line\nsecond line\n\nA new paragraph.",
  }));
  assert.match(html, /<p>First line<br\/>\s*second line<\/p>\s*<p>A new paragraph\.<\/p>/);
});

test("raw HTML in a context is shown as text, never rendered", () => {
  const html = render(createElement(QuestionBody, { className: "question", text: "<b>bold</b> <script>x()</script>" }));
  assert.doesNotMatch(html, /<b>|<script>/);
});

test("checkout paths in a Markdown body still link to Files, and nothing else does", () => {
  const page = "docs/mockups/remind/snooze-chip.html";
  const paths = new Set([page]);
  const text = `- the leading option is \`${page}\`\n- see also docs/mockups/remind/missing.html`;
  const linked = render(createElement(QuestionBody, { className: "question", text, paths, onOpenPath: () => {} }));
  assert.equal(linked.match(/<a /g)?.length, 1, "only the listed path links");
  assert.match(linked, new RegExp(`<a[^>]*class="workspace-path"[^>]*>${page}</a>`));
  // No place to open it: no links at all, as before.
  const unlinked = render(createElement(QuestionBody, { className: "question", text, paths }));
  assert.doesNotMatch(unlinked, /<a /);
});

test("a link resolves to a checkout file only when the whole href names one", () => {
  const paths = new Set(["docs/plan.md", "Makefile"]);
  assert.equal(questionLinkPath("docs/plan.md", paths), "docs/plan.md");
  assert.equal(questionLinkPath("docs/plan.md:12", paths), "docs/plan.md");
  assert.equal(questionLinkPath("Makefile", paths), "Makefile");
  assert.equal(questionLinkPath("https://example.com/docs/plan.md", paths), null);
  assert.equal(questionLinkPath("docs/missing.md", paths), null);
});

test("the conversation's question card renders the same Markdown", () => {
  const question = "Which name should the parser keep?";
  const review: ReviewItem = {
    id: "r1",
    sessionId: "s1",
    kind: "input",
    title: question,
    body: inputReviewBody(question, BULLETED),
    status: "dismissed",
    createdAt: 1,
    resolvedAt: 2,
  } as ReviewItem;
  const on = render(createElement(ClosedQuestionCard, { review }));
  assert.match(on, /<div class="review-asked-question markdown question-markdown">/);
  assert.match(on, /<li>keep the old name<\/li>/);
  const off = render(createElement(ClosedQuestionCard, { review }), FEATURE_FLAGS_DEFAULTS);
  assert.match(off, /<p class="review-asked-question">Two ways to ship this:/);
  assert.doesNotMatch(off, /<li>/);
});

test("the decision rule asks for Markdown context and prescribes no layout", () => {
  assert.ok(DECISION_CONTEXT_RULE.endsWith(" Write context as markdown."), DECISION_CONTEXT_RULE);
  assert.doesNotMatch(DECISION_CONTEXT_RULE, /bullet|heading|lead paragraph|file list/i);
});
