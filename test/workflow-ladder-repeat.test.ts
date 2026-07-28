import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkflowLadder } from "../src/web/workflows/WorkflowLadder.tsx";
import { ladderDetail, LADDER_NODE } from "./helpers/workflow-ladder.ts";

function render(withRepeatOffender: boolean): string {
  const detail = ladderDetail("changes");
  if (withRepeatOffender) {
    detail.repeatOffenders = [{
      nodeId: LADDER_NODE.evidence,
      personaName: "Test Evidence Auditor",
      rounds: 3,
    }];
  }
  return renderToStaticMarkup(createElement(WorkflowLadder, {
    summary: detail.summary,
    detail,
    onOpenRun: () => {},
    sessionBound: detail.binding.sessionId !== null,
  }));
}

test("the failing stage rung reports each repeat offender", () => {
  const html = render(true);
  assert.match(html, /wf-ladder-repeat/);
  assert.match(html, /Test Evidence Auditor has failed 3 rounds running\./);

  const sentenceAt = html.indexOf("Test Evidence Auditor has failed");
  const rungAt = html.lastIndexOf('<li class="wf-ladder-rung', sentenceAt);
  const rung = html.slice(rungAt, html.indexOf("</li>", sentenceAt));
  assert.match(rung, /workflow-failed is-failed/);
});

test("an older daemon without the optional field renders no repeat-offender line", () => {
  const html = render(false);
  assert.doesNotMatch(html, /wf-ladder-repeat|rounds running/);
});
