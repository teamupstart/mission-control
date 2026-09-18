import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The fabricated demonstration run the Follow the review tour seeds on an empty machine.
 *
 * Two properties carry everything: the record must read as a COHERENT completed run to every
 * consumer that will ever open it - the run detail route, the pipeline strip's status map,
 * the worklist's verdict parser, the context reader, and retention compaction an hour later -
 * and it must be written at most once, whatever races the tour's start throws at it. A run
 * that renders is easy; a run that still compacts cleanly after thirty days is the guard the
 * store's own `WorkflowRowError` makes explicit.
 */

const home = mkdtempSync(join(tmpdir(), "mission-workflow-tour-demo-"));
process.env.HARNESS_HOME = join(home, "state");

const { WorkflowStore } = await import("../src/server/workflows/store.ts");
const { seedWorkflowsTourDemoRun, TOUR_DEMO_RUN_ID } = await import(
  "../src/server/workflows/tour-demo-run.ts"
);
const { NO_MISTAKES_REVIEW_WORKFLOW_ID } = await import("../src/shared/builtin-workflow.ts");

const store = new WorkflowStore();
after(() => rmSync(home, { recursive: true, force: true }));

const NOW = 1_800_000_000_000;
const run = seedWorkflowsTourDemoRun(store, NOW);

test("the seeded run is a completed No-Mistakes run the reader can open whole", () => {
  assert.equal(run.id, TOUR_DEMO_RUN_ID);
  assert.equal(run.status, "completed");
  assert.equal(run.currentPhase, "complete");

  const detail = store.runDetail(TOUR_DEMO_RUN_ID);
  assert.ok(detail, "the run detail could not be assembled");
  assert.equal(detail.summary.workflowId, NO_MISTAKES_REVIEW_WORKFLOW_ID);
  assert.equal(detail.summary.status, "completed");
  assert.equal(detail.summary.gate, "clean");
  assert.equal(detail.summary.sessionName, "Tour demo");
  // The version resolves from the built-in catalog, so the strip has a graph to draw.
  assert.ok(detail.version, "the pinned built-in version did not resolve");
  // Both submissions carry STRICTLY valid context snapshots; an invalid one reads the whole
  // run as corrupt and fails retention compaction hourly.
  assert.notEqual(detail.contextState, "corrupt");
  assert.equal(detail.submissions.length, 2);
  assert.ok(detail.submissions.every((submission) => submission.status === "completed"));
});

test("every graph node holds the attempt shape its kind records on a clean pass", () => {
  const detail = store.runDetail(TOUR_DEMO_RUN_ID)!;
  const graph = detail.version!.graph;
  const byNode = new Map(detail.attempts.map((attempt) => [attempt.nodeId, attempt]));
  for (const node of graph.nodes) {
    const attempt = byNode.get(node.id);
    assert.ok(attempt, `${node.id} has no attempt`);
    assert.equal(attempt.state, "completed", `${node.id} did not complete`);
    if (node.kind === "persona") {
      assert.ok(attempt.persona, `${node.id} lost its Persona snapshot`);
      assert.equal((attempt.verdict as { verdict?: string } | null)?.verdict, "pass");
      assert.ok(attempt.runner && attempt.model, `${node.id} has no verdict meta`);
    }
    if (node.kind === "check") {
      assert.equal((attempt.output as { status?: string } | null)?.status, "skipped");
      assert.equal((attempt.verdict as { verdict?: string } | null)?.verdict, "pass");
    }
    if (node.kind === "session_action") {
      assert.equal((attempt.output as { outcome?: string } | null)?.outcome, "complete");
    }
  }
  // Receipts cover every pass/submitted/complete seam, so joins read as satisfied.
  const receiptEdges = new Set(detail.receipts.map((receipt) => receipt.edgeId));
  for (const edge of graph.edges) {
    if (edge.sourcePort === "fail" || edge.targetPort === "return_for_changes") continue;
    assert.ok(receiptEdges.has(edge.id), `edge ${edge.id} has no receipt`);
  }
});

test("the fabricated session identity is orphaned, never pointable", () => {
  const binding = store.getBinding(run.bindingId);
  assert.ok(binding);
  assert.equal(binding.state, "orphaned");
  assert.equal(binding.sessionId, null);
  assert.equal(binding.sessionName, "Tour demo");
});

test("seeding is idempotent, and the run appears once in the summaries the fleet streams", () => {
  const again = seedWorkflowsTourDemoRun(store, NOW + 60_000);
  assert.equal(again.id, run.id);
  const summaries = store.listRunSummaries();
  assert.equal(summaries.filter((s) => s.workflowId === NO_MISTAKES_REVIEW_WORKFLOW_ID).length, 1);
  assert.equal(summaries.some((s) => s.id === TOUR_DEMO_RUN_ID), true);
});

test("retention compaction thirty days later accepts the fabricated snapshots", () => {
  const result = store.runRetention({
    rawEvidenceBefore: NOW + 31 * 24 * 60 * 60 * 1000,
    completedRunsBefore: 0,
    maxCompletedRuns: 1000,
    now: NOW + 31 * 24 * 60 * 60 * 1000,
  });
  assert.equal(result.failedRunCount, 0, "compaction refused the seeded run");
  assert.deepEqual(result.compactedRunIds, [TOUR_DEMO_RUN_ID]);
});

test("after retention deletes the run, reseeding reuses the surviving orphaned binding", () => {
  // Completed-run retention DELETES the run and cascades its submissions, attempts,
  // receipts, deliveries and events - but the orphaned binding is durable. A reseed that
  // tried to insert its fixed id again would refuse on uniqueness and leave the tour with
  // no demo run at all, which is exactly the state this test forces.
  const later = NOW + 31 * 24 * 60 * 60 * 1000;
  const wiped = store.runRetention({
    rawEvidenceBefore: 0,
    completedRunsBefore: later,
    maxCompletedRuns: 0,
    now: later,
  });
  assert.deepEqual(wiped.deletedRunIds, [TOUR_DEMO_RUN_ID]);
  assert.ok(!store.getRun(TOUR_DEMO_RUN_ID), "the demo run should be deleted");
  assert.ok(store.getBinding(run.bindingId), "the orphaned binding survives run deletion");

  const reseeded = seedWorkflowsTourDemoRun(store, later + 24 * 60 * 60 * 1000);
  assert.equal(reseeded.id, TOUR_DEMO_RUN_ID);
  assert.equal(reseeded.status, "completed");
  assert.equal(reseeded.bindingId, run.bindingId);
  const detail = store.runDetail(TOUR_DEMO_RUN_ID);
  assert.ok(detail, "the reseeded run detail could not be assembled");
  assert.notEqual(detail.contextState, "corrupt");
  assert.equal(detail.binding.state, "orphaned");
  assert.equal(detail.submissions.length, 2);
});
