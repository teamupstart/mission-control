// What is at stake: `disabled_nodes_json` is the per-run operator override that lets a gate
// auto-pass. The database below is deliberately an UPGRADED one, not a fresh one: it seeds
// `workflow_runs` exactly as it stood before this feature - no `disabled_nodes_json` column -
// and then hands it to `openDb()`. A fresh-schema test would pass with the `addColumn` call
// deleted, because the CREATE TABLE block already names the column; this one cannot. Same
// reason `workflow-resumption-db.test.ts` seeds a pre-feature database.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// MISSION_HOME must be set before anything that resolves the state dir is imported, which is
// why every import that reaches it below is dynamic - a static import is hoisted above this
// assignment and would resolve the operator's real directory.
const home = mkdtempSync(join(tmpdir(), "workflow-disabled-nodes-db-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

/** `workflow_runs` exactly as it stood before this feature, with one live and one done run. */
function seedPreFeatureDb(): void {
  const raw = new DatabaseSync(join(home, "harness.db"));
  raw.exec(`
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id                    TEXT PRIMARY KEY,
      binding_id            TEXT NOT NULL,
      workflow_version_id   TEXT NOT NULL,
      status                TEXT NOT NULL,
      current_phase         TEXT NOT NULL,
      max_repair_rounds     INTEGER NOT NULL,
      trigger_source        TEXT NOT NULL,
      trigger_key           TEXT NOT NULL,
      inspector_pr_key      TEXT,
      inspector_head_sha    TEXT,
      gate_state_json       TEXT,
      started_at            INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL,
      completed_at          INTEGER,
      evidence_pruned_at    INTEGER
    );
  `);
  const insert = raw.prepare(`
    INSERT INTO workflow_runs (
      id, binding_id, workflow_version_id, status, current_phase, max_repair_rounds,
      trigger_source, trigger_key, started_at, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, 5, 'manual', ?, 1, 2, ?)
  `);
  insert.run("legacy-run", "binding", "version", "running", "persona_review", "legacy-run-key", null);
  insert.run("finished-run", "binding", "version", "completed", "complete", "finished-run-key", 2);
  raw.close();
}

test("a pre-feature run row upgrades, reads as nothing-disabled, and round-trips the set", async () => {
  seedPreFeatureDb();
  const { openDb } = await import("../src/server/db.ts");
  openDb();
  const { WorkflowStore } = await import("../src/server/workflows/store.ts");
  const store = new WorkflowStore();

  // NULL from the migration truthfully means "nothing was disabled before the column existed".
  const legacy = store.getRun("legacy-run");
  assert.ok(legacy);
  assert.deepEqual(legacy.disabledNodeIds, []);

  // The set persists with its audit events in one transaction, bumps updated_at, and
  // clears back to NULL rather than to "[]" bytes.
  const disabled = store.setRunDisabledNodes(
    "legacy-run",
    ["judge"],
    [{ kind: "node_disabled", payload: { nodeId: "judge", requestId: "r-1" } }],
    99,
  );
  assert.ok(disabled);
  assert.deepEqual(disabled.disabledNodeIds, ["judge"]);
  assert.equal(disabled.updatedAt, 99);
  assert.equal(store.listEvents("legacy-run").filter((event) => event.kind === "node_disabled").length, 1);
  assert.deepEqual(store.setRunDisabledNodes("legacy-run", [], [], 100)?.disabledNodeIds, []);

  // A finished run's history must read exactly as it ran: the guarded UPDATE refuses the
  // write, reports it with null so a caller cannot claim success, and the refused
  // toggle's events never reach the timeline - they ride the same transaction.
  const finished = store.setRunDisabledNodes(
    "finished-run",
    ["judge"],
    [{ kind: "node_disabled", payload: { nodeId: "judge", requestId: "r-2" } }],
    101,
  );
  assert.equal(finished, null);
  assert.deepEqual(store.getRun("finished-run")?.disabledNodeIds, []);
  assert.equal(store.getRun("finished-run")?.updatedAt, 2);
  assert.equal(store.listEvents("finished-run").some((event) => event.kind === "node_disabled"), false);
});
