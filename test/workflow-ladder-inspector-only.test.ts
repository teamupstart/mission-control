import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkflowLadder } from "../src/web/workflows/WorkflowLadder.tsx";
import {
  carriedStatus,
  inspectorOnlyRoundSentence,
} from "../src/web/workflows/run-model.ts";
import { ladderDetail } from "./helpers/workflow-ladder.ts";
import { tooltipLabels } from "./helpers/markup.ts";

test("an Inspector-only round keeps every authored stage before the gate", () => {
  const detail = ladderDetail("gate");
  const prior = detail.submissions[0]!;
  detail.submissions = [prior, {
    ...prior,
    id: "inspector-only",
    round: prior.round + 1,
    mode: "inspector_only",
  }];
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
  assert.equal(html.match(/wf-ladder-state wf-status-explained/g)?.length, 3);
  // Three stage headlines, and the six members they name: the ladder lists every member, so
  // each carried reviewer and check carries the same explanation its stage does rather than
  // hiding behind a folded chip.
  assert.equal(html.match(/wf-ladder-member-state wf-status-explained/g)?.length, 6);
  assert.equal(
    tooltipLabels(html).filter((label) => label === carriedStatus("Round 3").tooltip).length,
    9,
  );
  // Grey, not green. A bypassed stage did not run in this round, and painting it with the
  // pass tone would credit it with an execution the Inspector repair never gave it.
  assert.equal(html.match(/workflow-stopped/g)?.length, 9);
  assert.equal(html.match(/workflow-passed is-passed/g)?.length, 1);
  // The reader never has to leave this round to learn where the pass came from.
  assert.equal(html.match(/Passed in Round 3/g)?.length, 3);
  assert.equal(html.match(/wf-ladder-rung[^"]*is-carried/g)?.length, 3);
});
