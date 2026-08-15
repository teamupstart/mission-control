import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  WorkflowLadderPeek,
  workflowLadderPeekView,
} from "../src/web/workflows/WorkflowLadderPeek.tsx";
import {
  deliveryStateView,
  gateWaitSentence,
} from "../src/web/workflows/run-model.ts";
import {
  ladderDetail,
  OBJECTION,
} from "./helpers/workflow-ladder.ts";

function render(state: Parameters<typeof ladderDetail>[0]): string {
  const detail = ladderDetail(state);
  return renderToStaticMarkup(createElement(WorkflowLadderPeek, {
    summary: detail.summary,
    detail,
    onOpenRun: () => {},
  }));
}

test("the Board peek is one accessible control for its exact workflow run", () => {
  const html = render("reviewing");
  assert.match(html, /^<a href="#\/runs\/run"/);
  assert.match(
    html,
    /aria-label="Open No-Mistakes Review v4 workflow run: Preview · R2"/,
  );
});

test("the Board peek spends its height on the active review rung", () => {
  const detail = ladderDetail("reviewing");
  const view = workflowLadderPeekView(detail.summary, detail);
  assert.equal(view?.name, "Stage 3");
  assert.equal(view?.status.tone, "running");

  const html = render("reviewing");
  assert.match(html, /Stage 3/);
  assert.match(html, /Code Risk Reviewer/);
  assert.match(html, /Test Evidence Auditor/);
  assert.match(html, /Documentation Steward/);
  assert.match(html, />Running</);
});

test("the Board peek keeps the exact first objection visible", () => {
  const detail = ladderDetail("changes");
  const view = workflowLadderPeekView(detail.summary, detail);
  assert.equal(view?.name, "Stage 3");
  assert.equal(view?.status.tone, "failed");
  assert.equal(view?.sentence, `Test Evidence Auditor: ${OBJECTION}`);

  const html = render("changes");
  assert.match(html, /Test Evidence Auditor:/);
  assert.match(html, new RegExp(OBJECTION));
});

test("the Inspector gate outranks already-passed stages in the Board peek", () => {
  const detail = ladderDetail("gate");
  const view = workflowLadderPeekView(detail.summary, detail);
  assert.equal(view?.name, "Inspector gate");
  assert.equal(view?.sub, "PR #301 · head 4f2ab19c");
  assert.equal(view?.sentence, gateWaitSentence("review_pending"));

  const html = render("gate");
  assert.match(html, /PR #301 · head 4f2ab19c/);
  assert.ok(html.includes(gateWaitSentence("review_pending")));
});

test("uncertain delivery takes precedence and reuses the shipped warning", () => {
  const detail = ladderDetail("uncertain");
  const view = workflowLadderPeekView(detail.summary, detail);
  const delivery = deliveryStateView("uncertain");
  assert.equal(view?.name, "Repair delivery");
  assert.equal(view?.status.label, delivery.label);
  assert.equal(view?.sentence, delivery.sentence);

  const html = render("uncertain");
  assert.ok(html.includes(delivery.sentence));
  assert.doesNotMatch(html, new RegExp(OBJECTION));
});
