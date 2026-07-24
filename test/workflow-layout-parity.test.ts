import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type { WorkflowRunSummary } from "../src/shared/workflow.ts";
import {
  WorkflowChip,
  WorkflowRailMark,
  WorkflowTileFlag,
  workflowRunTone,
} from "../src/web/components/session-bits.tsx";

const run: WorkflowRunSummary = {
  id: "run",
  bindingId: "binding",
  workflowId: "workflow",
  workflowName: "Review",
  workflowVersion: 3,
  sessionId: "session",
  noteKey: "note",
  status: "waiting_for_session",
  phase: "persona_feedback",
  round: 2,
  maxRepairRounds: 5,
  activePersonaNames: [],
  failedPersonaCount: 1,
  bypassedPersonaReview: false,
  gate: "none",
  gatePrNumber: null,
  gateHeadShort: null,
  reviewPosture: null,
  updatedAt: 1,
};

test("workflow status helper drives card, tile, rail, and detail mark vocabularies", () => {
  assert.equal(workflowRunTone(run), "waiting");
  assert.equal(workflowRunTone({ ...run, status: "waiting_for_pr", gate: "waiting_pr" }), "waiting");
  assert.equal(workflowRunTone({
    ...run,
    status: "waiting_for_inspector",
    gate: "waiting_inspector",
  }), "waiting");
  assert.equal(workflowRunTone({
    ...run,
    status: "waiting_for_new_head",
    gate: "findings",
  }), "waiting");
  assert.equal(workflowRunTone({ ...run, status: "completed" }), "passed");
  assert.equal(workflowRunTone({ ...run, status: "blocked" }), "blocked");
  assert.match(renderToStaticMarkup(createElement(WorkflowChip, { run })), /workflow-waiting/);
  assert.match(renderToStaticMarkup(createElement(WorkflowTileFlag, { run })), /Review changes/);
  assert.match(renderToStaticMarkup(createElement(WorkflowRailMark, { run })), /rail-workflow/);

  const card = readFileSync(new URL("../src/web/components/SessionCard.tsx", import.meta.url), "utf8");
  const detail = readFileSync(new URL("../src/web/components/layouts/ConsoleDetail.tsx", import.meta.url), "utf8");
  const tile = readFileSync(new URL("../src/web/components/layouts/SessionTile.tsx", import.meta.url), "utf8");
  const rail = readFileSync(new URL("../src/web/components/layouts/RailRow.tsx", import.meta.url), "utf8");
  assert.match(card, /<WorkflowChip/);
  assert.match(detail, /<WorkflowChip/);
  assert.match(tile, /<WorkflowTileFlag/);
  assert.match(rail, /<WorkflowRailMark/);
});
