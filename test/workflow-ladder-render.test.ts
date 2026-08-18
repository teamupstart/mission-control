import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkflowLadder } from "../src/web/workflows/WorkflowLadder.tsx";
import {
  deliveryStateView,
  gateWaitSentence,
  inspectorGateSentence,
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
    onRecheckInspector: () => {},
    sessionBound: true,
  }));
};

test("the reviewing ladder names every member of every stage, passed ones included", () => {
  const html = render("reviewing");
  assert.match(html, /Stage 3/);
  assert.match(html, /Test Evidence Auditor/);
  assert.match(html, /Documentation Steward/);
  assert.match(html, /Running/);
  // A stage that folded to a pass still names who passed it. "All passed" beside `2 checks`
  // identifies neither check, and a reader who wants to know which reviewers approved the work
  // is asking the one question the ladder exists to answer.
  assert.match(html, /Stage 1/);
  assert.match(html, /2 commands · all must pass/);
  assert.match(html, /Command · typecheck/);
  assert.match(html, /Command · test/);
  // Including the stage whose single reviewer IS its name: one member row, not zero.
  assert.match(html, /1 reviewer/);
  const members = html.match(/<li class="wf-ladder-member[\s\S]*?<\/li>/g) ?? [];
  assert.deepEqual(
    members.map((row) => row.match(/wf-ladder-member-name">([^<]+)</)?.[1]),
    [
      "Command · typecheck",
      "Command · test",
      "Intent Conformance Judge",
      "Code Risk Reviewer",
      "Test Evidence Auditor",
      "Documentation Steward",
    ],
  );
  // Each row keeps its OWN tone, so the ones that earned green are still legible as green
  // inside a stage that is still running.
  const risk = members.find((row) => row.includes("Code Risk Reviewer")) ?? "";
  assert.match(risk, /wf-ladder-member workflow-passed/);
  assert.match(risk, />Passed</);
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
  assert.match(html, /Recheck GitHub Inspector/);
});

test("a spent gate rung names historical and current heads without offering a dead recheck", () => {
  const detail = ladderDetail("spent-clean");
  const html = render("spent-clean");
  assert.match(html, /Clean head ready/);
  assert.ok(html.includes(inspectorGateSentence(detail)));
  assert.match(html, /last workflow head/);
  assert.match(html, /failed000000/);
  assert.match(html, /current Inspector head/);
  assert.match(html, /clean0000000/);
  assert.doesNotMatch(html, /Recheck GitHub Inspector/);
});

test("the uncertain delivery rung uses the shared label and sentence verbatim", () => {
  const html = render("uncertain");
  const view = deliveryStateView("uncertain");
  assert.match(html, new RegExp(view.label));
  assert.ok(html.includes(view.sentence));
  const labelAt = html.indexOf(">Repair delivery</strong>");
  assert.notEqual(labelAt, -1);
  const rungAt = html.lastIndexOf('<li class="wf-ladder-rung', labelAt);
  assert.notEqual(rungAt, -1);
  const rung = html.slice(rungAt, html.indexOf("</li>", labelAt));
  assert.match(rung, /workflow-waiting is-waiting/);
  assert.doesNotMatch(rung, /workflow-failed|is-failed/);
  assert.doesNotMatch(html, /Mark delivered|Discard, send new round/);
});
