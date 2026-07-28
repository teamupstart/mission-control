import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkflowLadder } from "../src/web/workflows/WorkflowLadder.tsx";
import {
  deliveryStateView,
  gateWaitSentence,
} from "../src/web/workflows/run-model.ts";
import {
  ladderDetail,
  OBJECTION,
} from "./helpers/workflow-ladder.ts";

const render = (state: Parameters<typeof ladderDetail>[0]): string => {
  const detail = ladderDetail(state);
  return renderToStaticMarkup(createElement(WorkflowLadder, {
    summary: detail.summary,
    detail,
    onOpenRun: () => {},
  }));
};

test("the reviewing ladder expands the running stage and collapses passed stages", () => {
  const html = render("reviewing");
  assert.match(html, /Stage 3/);
  assert.match(html, /Test Evidence Auditor/);
  assert.match(html, /Documentation Steward/);
  assert.match(html, /Running/);
  // Stage 1 is still named and counted, but its passed member rows do not consume height.
  assert.match(html, /Stage 1/);
  assert.match(html, /2 checks · all must pass/);
  assert.doesNotMatch(html, /Check · typecheck/);
  assert.doesNotMatch(html, /Check · test/);
});

test("the failed stage opens the reviewer's objection in place", () => {
  const html = render("changes");
  assert.match(html, /wf-ladder-why/);
  assert.match(html, /Test Evidence Auditor:/);
  assert.match(html, new RegExp(OBJECTION));
});

test("the Inspector gate rung carries its wait sentence and pinned PR facts", () => {
  const html = render("gate");
  assert.match(html, /Inspector gate/);
  assert.match(html, /#301/);
  assert.match(html, /4f2ab19c/);
  assert.match(html, /posture/);
  assert.match(html, new RegExp(gateWaitSentence("review_pending")));
});

test("the uncertain delivery rung uses the shared label and sentence verbatim", () => {
  const html = render("uncertain");
  const view = deliveryStateView("uncertain");
  assert.match(html, new RegExp(view.label));
  assert.ok(html.includes(view.sentence));
  assert.doesNotMatch(html, /Mark delivered|Discard, send new round/);
});
