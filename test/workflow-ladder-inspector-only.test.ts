import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkflowLadder } from "../src/web/workflows/WorkflowLadder.tsx";
import {
  inspectorOnlyRoundSentence,
  inspectorOnlySkipStatus,
} from "../src/web/workflows/run-model.ts";
import { ladderDetail } from "./helpers/workflow-ladder.ts";
import { tooltipLabels } from "./helpers/markup.ts";

test("an Inspector-only round keeps every authored stage before the gate", () => {
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
    sessionBound: true,
  }));
  assert.ok(html.includes(inspectorOnlyRoundSentence()));
  assert.match(html, /Stage 1/);
  assert.match(html, /Intent Conformance Judge/);
  assert.match(html, /Stage 3/);
  assert.match(html, /Inspector gate/);
  assert.equal(html.match(/wf-ladder-rung /g)?.length, 6);
  assert.equal(html.match(/workflow-passed is-passed/g)?.length, 4);
  assert.equal(html.match(/wf-ladder-state wf-status-explained/g)?.length, 3);
  assert.equal(
    tooltipLabels(html).filter((label) => label === inspectorOnlySkipStatus().tooltip).length,
    3,
  );
});
