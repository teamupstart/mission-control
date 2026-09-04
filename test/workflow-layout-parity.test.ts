import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  WORKFLOW_RUN_STATUSES,
  workflowRunIsOpen,
  type WorkflowRunSummary,
} from "../src/shared/workflow.ts";
import { ConsoleDetail } from "../src/web/components/layouts/ConsoleDetail.tsx";
import { RailRow } from "../src/web/components/layouts/RailRow.tsx";
import {
  WorkflowChip,
  WorkflowChips,
  workflowRunLabel,
  workflowRunTone,
} from "../src/web/components/session-bits.tsx";
import { heldByRun, newestSessionRun } from "../src/web/lib/held.ts";
import { mkSession } from "./helpers/session-fixture.ts";
import { mkSessionView } from "./helpers/session-view.ts";

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

/**
 * The unarmed offer, whose ＋ and word are separate elements so the console header's ladder
 * can shed the word and leave the mark (`detailHeadLadder.ts`, rung 2). Both are still
 * matched, in order, because what this file is about is the offer being READABLE as
 * `＋ workflow` - a chip that kept only one of the two says something else.
 */
const BIND_CHIP =
  /class="workflow-bind-chip"[^>]*><span class="wbc-glyph">＋<\/span><span class="wbc-word"> workflow<\/span>/;
const outcomeChip = (tone: string, label: string): RegExp =>
  new RegExp(`class="workflow-chip workflow-${tone}"[^>]*>.*?${label}<`);

function detailWith(bound: WorkflowRunSummary | null): string {
  const session = mkSession({ state: "idle", activity: null });
  return renderToStaticMarkup(createElement(ConsoleDetail, {
    session,
    view: mkSessionView(session, {
      workflowRunsBySession: new Map(
        bound ? [[session.id, [{ ...bound, sessionId: session.id }]]] : [],
      ),
      onOpenWorkflowRun: () => {},
      onBindWorkflow: () => {},
    }),
  }));
}

test("workflow status vocabulary remains shared", () => {
  assert.equal(workflowRunTone(run), "waiting");
  assert.equal(workflowRunTone({ ...run, status: "completed" }), "passed");
  assert.equal(workflowRunTone({ ...run, status: "blocked" }), "blocked");
  assert.equal(workflowRunLabel({ ...run, status: "waiting_for_evidence_readiness" }), "Evidence preflight");
});

test("an open run withholds the bind chip from the Console and Board detail", () => {
  const open = WORKFLOW_RUN_STATUSES.filter((status) => workflowRunIsOpen(status));
  assert.ok(open.length >= 8);
  for (const status of open) {
    assert.doesNotMatch(detailWith({ ...run, status }), BIND_CHIP, status);
  }
});

test("a terminal run restores the bind offer beside its outcome", () => {
  for (const [status, tone, label] of [
    ["completed", "passed", "Approved"],
    ["cancelled", "failed", "Preview cancelled"],
    ["failed", "failed", "Preview failed"],
  ] as const) {
    const html = detailWith({ ...run, status });
    assert.match(html, BIND_CHIP);
    assert.match(html, outcomeChip(tone, label));
  }
});

test("multiple repository reviews draw one named chip each", () => {
  const second = {
    ...run,
    id: "run-2",
    bindingId: "binding-2",
    status: "completed" as const,
    repoRoot: "/checkouts/second-repo",
  };
  const both = renderToStaticMarkup(createElement(WorkflowChips, {
    runs: [{ ...run, repoRoot: "/checkouts/demo-repo" }, second],
  }));
  assert.match(both, /workflow-chip-repo">demo-repo<\/span> Review changes/);
  assert.match(both, /workflow-chip-repo">second-repo<\/span> Approved/);
  const ids = (markup: string): string => markup.replaceAll(/_R_[a-z0-9]+_/g, "_id_");
  assert.equal(
    ids(renderToStaticMarkup(createElement(WorkflowChips, { runs: [run] }))),
    ids(renderToStaticMarkup(createElement(WorkflowChip, { run }))),
  );
});

test("the rail names the open run that actually holds the session", () => {
  const queued = { ...run, id: "queued", workflowName: "Repo A review", updatedAt: 10 };
  const finished = {
    ...run,
    id: "finished",
    workflowName: "Repo B review",
    status: "completed" as const,
    updatedAt: 99,
  };
  assert.equal(newestSessionRun([queued, finished])?.workflowName, "Repo B review");
  assert.equal(heldByRun([queued, finished], "idle")?.workflowName, "Repo A review");

  const markup = renderToStaticMarkup(createElement(RailRow, {
    selected: false,
    onSelect: () => {},
    session: mkSession({ state: "idle", activity: null }),
    workflowRun: finished,
    workflowRuns: [queued, finished],
  }));
  assert.match(markup, /Held by Repo A review - the run owns this session/);
  assert.doesNotMatch(markup, /Held by Repo B review/);
});
