import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  WorkflowLadderPeek,
  workflowLadderPeekProjection,
  workflowLadderStages,
  workflowLadderPeekView,
} from "../src/web/workflows/WorkflowLadderPeek.tsx";
import { RepairRoundMeter } from "../src/web/workflows/WorkflowStageMeter.tsx";
import {
  deliveryStateView,
  gateWaitSentence,
  inspectorGateSentence,
} from "../src/web/workflows/run-model.ts";
import {
  ladderDetail,
  LADDER_NODE,
  OBJECTION,
} from "./helpers/workflow-ladder.ts";

function render(
  state: Parameters<typeof ladderDetail>[0],
  progressMeter = false,
): string {
  const detail = ladderDetail(state);
  return renderToStaticMarkup(createElement(WorkflowLadderPeek, {
    summary: detail.summary,
    detail,
    onOpenRun: () => {},
    progressMeter,
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
  assert.equal(view?.name, "GitHub Inspector gate");
  assert.equal(view?.sub, "PR #301 · head 4f2ab19c");
  assert.equal(view?.sentence, gateWaitSentence("review_pending"));

  const html = render("gate");
  assert.match(html, /PR #301 · head 4f2ab19c/);
  assert.ok(html.includes(gateWaitSentence("review_pending")));
});

test("the Board peek reads a spent gate from the current Inspector ledger", () => {
  const detail = ladderDetail("spent-clean");
  const view = workflowLadderPeekView(detail.summary, detail);
  assert.equal(view?.name, "GitHub Inspector gate");
  assert.equal(view?.sub, "PR #301 · head clean0000000");
  assert.equal(view?.status.label, "Clean head ready");
  assert.equal(view?.sentence, inspectorGateSentence(detail));

  const html = render("spent-clean");
  assert.match(html, /PR #301 · head clean0000000/);
  assert.match(html, /Clean head ready/);
  assert.ok(html.includes(inspectorGateSentence(detail)));
  assert.doesNotMatch(html, new RegExp(gateWaitSentence("findings")));
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

test("the whole-stage projection and the rung choose the same active stage", () => {
  const detail = ladderDetail("reviewing");
  const projection = workflowLadderPeekProjection(detail.summary, detail);
  const stages = projection.stages!;
  const view = projection.view!;

  assert.equal(stages.length, 3);
  assert.deepEqual(stages.map((stage) => stage.name), [
    "Stage 1",
    "Intent Conformance Judge",
    "Stage 3",
  ]);
  assert.equal(view.stageIndex, 2);
  assert.equal(stages[view.stageIndex]?.name, view.name);

  const html = render("reviewing", true);
  assert.equal(html.match(/class="tpm-seg /g)?.length, stages.length);
  assert.match(html, /aria-label="Stage 3: Running"/);
  assert.equal(html.match(/is-now/g)?.length, 1);
});

test("carried passes and degraded skips are filled and hatched instead of pending", () => {
  const carried = ladderDetail("reviewing");
  const parent = carried.submissions[0]!;
  carried.submissions.push({
    ...parent,
    id: "continuation",
    round: 2,
    segment: 1,
    parentSubmissionId: parent.id,
    continuationNodeId: LADDER_NODE.intent,
  });
  const carriedStages = workflowLadderStages(carried.summary, carried)!;
  assert.equal(carriedStages[0]?.status.skipKind, "carried_pass");
  assert.equal(carriedStages[1]?.status.skipKind, "carried_pass");

  const degraded = ladderDetail("reviewing");
  const skipped = degraded.attempts.find((candidate) => candidate.nodeId === LADDER_NODE.typecheck)!;
  const skippedOutput = skipped.output as { status: string; [key: string]: unknown };
  skipped.output = { ...skippedOutput, status: "skipped" };
  const degradedStages = workflowLadderStages(degraded.summary, degraded)!;
  assert.equal(degradedStages[0]?.status.degraded, true);

  const carriedHtml = renderToStaticMarkup(createElement(WorkflowLadderPeek, {
    summary: carried.summary,
    detail: carried,
    onOpenRun: () => {},
    progressMeter: true,
  }));
  assert.match(carriedHtml, /workflow-stopped is-degraded[^>]*><i style="width:100%/);
  const degradedHtml = renderToStaticMarkup(createElement(WorkflowLadderPeek, {
    summary: degraded.summary,
    detail: degraded,
    onOpenRun: () => {},
    progressMeter: true,
  }));
  assert.match(degradedHtml, /workflow-waiting is-degraded[^>]*><i style="width:100%/);
});

test("non-stage workflow states keep their rung when the meter preference is on", () => {
  for (const state of ["uncertain", "gate"] as const) {
    const detail = ladderDetail(state);
    assert.equal(workflowLadderStages(detail.summary, detail), null);
    const html = render(state, true);
    assert.match(html, /wf-tile-peek-rung/);
    assert.doesNotMatch(html, /wf-stage-meter/);
  }

  const inspectorOnly = ladderDetail("reviewing");
  inspectorOnly.submissions[0]!.mode = "inspector_only";
  assert.equal(workflowLadderStages(inspectorOnly.summary, inspectorOnly), null);
  const html = renderToStaticMarkup(createElement(WorkflowLadderPeek, {
    summary: inspectorOnly.summary,
    detail: inspectorOnly,
    onOpenRun: () => {},
    progressMeter: true,
  }));
  assert.match(html, /wf-tile-peek-rung/);
  assert.match(html, /GitHub Inspector-only round/);
  assert.doesNotMatch(html, /wf-stage-meter/);
});

test("the repair meter has an initial pip plus every repair round", () => {
  const detail = ladderDetail("reviewing");
  const html = renderToStaticMarkup(createElement(RepairRoundMeter, {
    summary: { ...detail.summary, round: 3, maxRepairRounds: 5 },
  }));
  assert.equal(html.match(/role="img"/g)?.length, 6);
  assert.match(html, /aria-label="Round 2: spent"/);
  assert.match(html, /aria-label="Round 3: current"/);
  assert.match(html, /aria-label="Round 4: available"/);
});

test("the last legal round says no repairs remain without calling a completed run failed", () => {
  const detail = ladderDetail("reviewing");
  const beforeLast = renderToStaticMarkup(createElement(RepairRoundMeter, {
    summary: { ...detail.summary, round: 5, maxRepairRounds: 5 },
  }));
  assert.doesNotMatch(beforeLast, /no repairs left/);

  const last = renderToStaticMarkup(createElement(RepairRoundMeter, {
    summary: {
      ...detail.summary,
      status: "completed",
      phase: "completed",
      round: 6,
      maxRepairRounds: 5,
    },
  }));
  assert.equal(last.match(/role="img"/g)?.length, 6);
  assert.match(last, /aria-label="Round 6: current, no repairs left"/);
  assert.match(last, /wf-repair-pip is-current workflow-passed/);
  assert.doesNotMatch(last, /wf-repair-pip is-current workflow-failed/);
  assert.match(last, />no repairs left</);
  assert.doesNotMatch(last, />Failed</);
});
