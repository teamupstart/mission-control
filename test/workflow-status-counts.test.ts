/**
 * What is at stake: the Workflows settings panel sets three retention limits and, until
 * these two scalars existed, showed no measurement of the thing being limited. The only
 * related number on the page was `retainedRunCount`, which is `COUNT(*)` over EVERY run row
 * of any status - so reading it against `maxCompletedRuns` would be a gauge that climbs on
 * active, blocked and failed work the limit beside it can never remove, and an operator
 * watching it approach 1000 would be watching the wrong number.
 *
 * `completedRunCount` therefore has to be the population `runRetention`'s `ranked` CTE
 * actually windows - finished, with a completion time, and not pinned by an uncertain
 * delivery - and not an approximation of it. All three predicates are asserted separately
 * here, because a count that quietly disagrees with the sweep it describes is a panel
 * confidently explaining a deletion that will not happen.
 *
 * `deliveredDeliveries` answers how much retained run history confirms that Live delivery
 * actually typed something into a session. The boundary worth pinning is that compaction
 * blanks a delivered row's payload and coarsens its error but never its state, while deleting
 * an aged run family removes its deliveries from the count.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "mission-workflow-status-counts-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { openDb } = await import("../src/server/db.ts");
const { clearWorkflowTables, WorkflowStore } = await import("../src/server/workflows/store.ts");
const db = openDb();
const store = new WorkflowStore(db);

beforeEach(() => clearWorkflowTables(db));

function insertRun(
  id: string,
  status: "completed" | "cancelled" | "failed" | "blocked" | "running",
  completedAt: number | null,
): void {
  db.prepare(
    `INSERT INTO workflow_runs (
       id, binding_id, workflow_version_id, status, current_phase, max_repair_rounds,
       trigger_source, trigger_key, started_at, updated_at, completed_at
     ) VALUES (?, 'binding', 'version', ?, 'phase', 5, 'manual', ?, 1, ?, ?)`,
  ).run(id, status, `trigger:${id}`, completedAt ?? 1, completedAt);
}

function insertDelivery(
  id: string,
  runId: string,
  state: "prepared" | "sending" | "delivered" | "refused" | "uncertain" | "cancelled",
): void {
  db.prepare(
    `INSERT INTO workflow_deliveries (
       id, run_id, submission_id, kind, session_id, note_key, payload, payload_sha256,
       state, created_at, updated_at, delivered_at
     ) VALUES (?, ?, ?, 'persona_feedback', 'session', 'note', 'packet', 'sha', ?, 1, 1, ?)`,
  ).run(id, runId, `submission:${id}`, state, state === "delivered" ? 1 : null);
}

// The headline distinction, and the reason two fields exist rather than one nicer reading of
// the old one. Same database, two honest answers to two different questions.
test("completedRunCount excludes active runs while retainedRunCount does not", () => {
  insertRun("done", "completed", 100);
  insertRun("cancelled", "cancelled", 100);
  insertRun("running", "running", null);
  insertRun("blocked", "blocked", null);
  insertRun("failed", "failed", 100);

  const counts = store.workflowStatusCounts();
  assert.equal(counts.retainedRunCount, 5, "every run row, whatever its status");
  assert.equal(counts.completedRunCount, 2, "only the finished families the limit ranks");
  // And the third scalar over the same rows keeps meaning what it meant: `failed` is not
  // active, so a fleet with one of each does not report it as running work.
  assert.equal(counts.activeRuns, 2);
});

// A finished run with no completion time cannot be ranked by `ORDER BY completed_at DESC`,
// so the sweep never reaches it. Counting it would promise a deletion that cannot happen.
test("a finished run with no completion time is not in the ranked population", () => {
  insertRun("done", "completed", 100);
  insertRun("timeless", "completed", null);

  assert.equal(store.workflowStatusCounts().retainedRunCount, 2);
  assert.equal(store.workflowStatusCounts().completedRunCount, 1);
});

// The predicate that is easiest to leave out and hardest to notice missing: an uncertain
// delivery pins its whole run family out of both retention stages, which is the promise the
// panel's own copy makes ("delivery-uncertain work is never age-pruned"). A count that
// included it would drift from the sweep by exactly the rows an operator is most anxious
// about.
test("a run pinned by an uncertain delivery is not counted against the limit", () => {
  insertRun("clean", "completed", 100);
  insertDelivery("clean-delivery", "clean", "delivered");
  insertRun("pinned", "completed", 100);
  insertDelivery("pinned-delivery", "pinned", "uncertain");

  const counts = store.workflowStatusCounts();
  assert.equal(counts.retainedRunCount, 2);
  assert.equal(counts.completedRunCount, 1, "the pinned family is outside what the limit ranks");
  assert.equal(counts.uncertainDeliveries, 1);
});

// Only `delivered`. The other five states are deliveries that were prepared, refused,
// abandoned or are still in doubt, and none of them is evidence that anything was typed in.
test("deliveredDeliveries counts confirmed deliveries and nothing else", () => {
  insertRun("run", "completed", 100);
  insertDelivery("one", "run", "delivered");
  insertDelivery("two", "run", "delivered");
  insertDelivery("three", "run", "prepared");
  insertDelivery("four", "run", "sending");
  insertDelivery("five", "run", "refused");
  insertDelivery("six", "run", "uncertain");
  insertDelivery("seven", "run", "cancelled");

  const counts = store.workflowStatusCounts();
  assert.equal(counts.deliveredDeliveries, 2);
  // The two existing delivery scalars still answer their own questions over the same rows.
  assert.equal(counts.waitingDeliveries, 2, "prepared and sending");
  assert.equal(counts.uncertainDeliveries, 1);
});

// Compaction must not erase confirmation while the run family remains retained. A count
// derived from content would silently fall even though retention still keeps the delivery.
test("delivered deliveries still count after retention has compacted their payloads", () => {
  insertRun("old", "completed", 100);
  insertDelivery("old-delivery", "old", "delivered");
  assert.equal(store.workflowStatusCounts().deliveredDeliveries, 1);

  const result = store.runRetention({
    rawEvidenceBefore: 1_000,
    // Far enough in the past that nothing is deletable: this is the COMPACTION stage's
    // effect being measured, not a row quietly disappearing.
    completedRunsBefore: 0,
    maxCompletedRuns: 100,
    now: 2_000,
  });
  assert.deepEqual(result.compactedRunIds, ["old"]);
  assert.deepEqual(result.deletedRunIds, []);

  const row = db.prepare(`SELECT payload, state FROM workflow_deliveries WHERE id = ?`)
    .get("old-delivery") as { payload: string | null; state: string };
  assert.equal(row.payload, "", "the sweep must actually have blanked the content");
  assert.equal(row.state, "delivered", "and must have left the state alone");
  assert.equal(
    store.workflowStatusCounts().deliveredDeliveries,
    1,
    "the count reads state, which compaction never touches",
  );
});

// Full deletion is the other side of the retention boundary: keeping this delivery in the
// headline after its aged run family is gone would recreate the false all-time promise.
test("delivered deliveries leave the count when retention deletes their run family", () => {
  insertRun("old", "completed", 100);
  insertDelivery("old-delivery", "old", "delivered");
  insertRun("newest", "completed", 200);
  assert.equal(store.workflowStatusCounts().deliveredDeliveries, 1);

  const result = store.runRetention({
    rawEvidenceBefore: 0,
    completedRunsBefore: 150,
    maxCompletedRuns: 1,
    now: 300,
  });
  assert.deepEqual(result.deletedRunIds, ["old"]);
  assert.equal(store.getRun("old"), null);
  assert.ok(store.getRun("newest"));
  assert.equal(store.workflowStatusCounts().deliveredDeliveries, 0);
});

// An empty install answers zero rather than throwing or returning a null: the settings panel
// renders every tile on the first poll, and a fresh daemon is the common case for the person
// most likely to be reading it.
test("an empty store answers zero for both new scalars", () => {
  const counts = store.workflowStatusCounts();
  assert.equal(counts.completedRunCount, 0);
  assert.equal(counts.deliveredDeliveries, 0);
});
