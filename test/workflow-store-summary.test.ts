import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXTURE_RUN_INTENT } from "./helpers/workflow-run-intent.ts";

/**
 * The durable session title on a run summary.
 *
 * What is at stake is one sentence: A RUN OUTLIVES THE SESSION IT REVIEWED. When a session
 * goes, `orphanBinding` nulls the binding's `session_id` and blocks the run, so any surface
 * that names a run from the live session list has nothing left and falls through to
 * `noteKey` - a conversation GUID. `workflow_bindings.session_name` was already durable and
 * already joined; the summary now selects it, which is what lets the Line's Review drawer
 * name a stopped run.
 *
 * Both halves of the contract are pinned here, because the second is what makes the first
 * affordable: the key is CARRIED when a title was captured and OMITTED ENTIRELY when it was
 * not. Summaries travel over SSE for every run in the fleet on every change, so an empty
 * string on each of them is bytes bought for nothing - the same trade `externalSource` makes.
 */

const home = mkdtempSync(join(tmpdir(), "mission-workflow-store-summary-"));
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const { WorkflowStore, clearWorkflowTables } = await import("../src/server/workflows/store.ts");

const db = openDb();
after(() => rmSync(home, { recursive: true, force: true }));

const GRAPH = {
  nodes: [
    { id: "session", kind: "session", position: { x: 0, y: 0 } },
    { id: "end", kind: "end", outcome: "Complete", position: { x: 100, y: 0 } },
  ],
  edges: [],
};
const DEFAULTS = JSON.stringify({
  triggerMode: "manual",
  deliveryMode: "preview",
  maxRepairRounds: 5,
});

function seedVersion(): void {
  db.prepare(
    `INSERT INTO workflow_definitions (
       id, name, normalized_name, description, draft_graph_json, completion_policy_json,
       binding_defaults_json, draft_revision, current_version_id, archived_at, created_at, updated_at
     ) VALUES ('w', 'Review', 'review', '', ?, '{"kind":"none"}', ?, 1, 'v', NULL, 1, 1)`,
  ).run(JSON.stringify(GRAPH), DEFAULTS);
  db.prepare(
    `INSERT INTO workflow_versions (
       id, workflow_id, version, source_draft_revision, graph_json,
       completion_policy_json, binding_defaults_json, published_at
     ) VALUES ('v', 'w', 1, 1, ?, '{"kind":"none"}', ?, 1)`,
  ).run(JSON.stringify(GRAPH), DEFAULTS);
}

function seedRun(store: InstanceType<typeof WorkflowStore>, sessionName: string) {
  const binding = store.insertBinding({
    id: "b",
    workflowVersionId: "v",
    noteKey: "claude:9f1c-4d2a-8e77",
    sessionId: "session",
    sessionAgent: "claude",
    sessionName,
    sessionCwd: "/repo",
    sessionRepoRoot: "/repo",
    triggerMode: "manual",
    deliveryMode: "preview",
    maxRepairRounds: 5,
    now: 1,
  });
  store.createInitialSubmission(
    { id: "run", binding, intent: FIXTURE_RUN_INTENT, triggerSource: "manual", triggerKey: "manual:b:req", now: 2 },
    { id: "sub", triggerSource: "manual", triggerKey: "manual:b:req", context: {}, evidence: {}, now: 2 },
  );
  return binding;
}

test("a run summary carries the binding's captured session title, and it survives the session", () => {
  clearWorkflowTables(db);
  seedVersion();
  const store = new WorkflowStore(db);
  seedRun(store, "Fix Busy State for Diff Link");

  assert.equal(store.runSummary("run")?.sessionName, "Fix Busy State for Diff Link");

  // The case the field exists for. Orphaning is what a removed session does to a binding:
  // the run blocks and `sessionId` goes to null, so the live session list can no longer name
  // it. The captured title is untouched, and it is now the only human name the row has.
  store.orphanBinding("b", "session_disappeared", 5);
  const orphaned = store.runSummary("run");
  assert.equal(orphaned?.sessionId, null);
  assert.equal(orphaned?.status, "blocked");
  assert.equal(orphaned?.phase, "session_disappeared");
  assert.equal(orphaned?.sessionName, "Fix Busy State for Diff Link");
});

test("a binding that captured no title emits no key at all, rather than an empty string", () => {
  clearWorkflowTables(db);
  seedVersion();
  const store = new WorkflowStore(db);
  // `session_name` is `NOT NULL DEFAULT ''`, so "no title" reaches the row mapper as `''` and
  // never as null. Omitted, not emitted: `"sessionName" in summary` is the assertion, because
  // `summary.sessionName === undefined` would pass for a key present and explicitly undefined.
  seedRun(store, "");
  const summary = store.runSummary("run");
  assert.ok(summary);
  assert.equal("sessionName" in summary, false);
});
