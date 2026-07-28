import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkflowLadder } from "../src/web/workflows/WorkflowLadder.tsx";
import { inspectorOnlyRoundSentence } from "../src/web/workflows/run-model.ts";
import { ladderDetail } from "./helpers/workflow-ladder.ts";

test("an Inspector-only round draws no permanently pending Persona stages", () => {
  const detail = ladderDetail("gate");
  detail.submissions = [{
    ...detail.submissions[0]!,
    mode: "inspector_only",
  }];
  detail.attempts = [];
  detail.summary.bypassedPersonaReview = true;
  const html = renderToStaticMarkup(createElement(WorkflowLadder, {
    summary: detail.summary,
    detail,
    onOpenRun: () => {},
  }));
  assert.ok(html.includes(inspectorOnlyRoundSentence()));
  assert.doesNotMatch(html, /Stage 1|Stage 3|Intent Conformance Judge/);
  assert.equal(html.match(/wf-ladder-rung /g)?.length, 3);
});
