// What is at stake: `resumption_policy` decides whether the daemon starts work on an
// operator's machine without being asked. Getting its MIGRATION wrong is therefore not a
// cosmetic bug - a column that arrives with `DEFAULT 'auto'`, or a NULL that reads as `auto`,
// would silently begin resubmitting every parked run on every install that merely upgraded.
//
// The database below is deliberately an UPGRADED one, not a fresh one. It is seeded with the
// two workflow tables exactly as they stood before this feature - no `resumption_policy`
// column at all - and then handed to `openDb()`. That is what makes this test able to fail:
// a fresh-schema test passes with both `addColumn` calls deleted, because the CREATE TABLE
// block already names the column. Same reason `schedule-db.test.ts` seeds a pre-feature
// database.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// MISSION_HOME *is* the state dir, so the db lands at <home>/harness.db - the file db.ts
// opens below. It must be set before anything that resolves it is imported, which is why
// every import that reaches the state dir in this file is dynamic: a static import is hoisted
// above this assignment and would resolve the operator's real directory.
const home = mkdtempSync(join(tmpdir(), "workflow-resumption-db-"));
process.env.MISSION_HOME = home;

const EDGES = [
  { id: "start", source: "session", sourcePort: "submitted", target: "judge", targetPort: "activate" },
  { id: "pass", source: "judge", sourcePort: "pass", target: "end", targetPort: "terminal" },
  { id: "fail", source: "judge", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
];

/** A DRAFT names a Persona by id; a PUBLISHED version carries its frozen snapshot. */
const DRAFT_GRAPH = JSON.stringify({
  nodes: [
    { id: "session", kind: "session", position: { x: 0, y: 0 } },
    { id: "judge", kind: "persona", personaId: "p1", position: { x: 220, y: 0 } },
    { id: "end", kind: "end", outcome: "Complete", position: { x: 440, y: 0 } },
  ],
  edges: EDGES,
});
const PUBLISHED_GRAPH = JSON.stringify({
  nodes: [
    { id: "session", kind: "session", position: { x: 0, y: 0 } },
    {
      id: "judge",
      kind: "persona",
      position: { x: 220, y: 0 },
      persona: {
        sourcePersonaId: "p1",
        sourceRevision: 1,
        name: "Judge",
        description: "Quality",
        guidanceMarkdown: "# Judge\n\nReview it.",
        runner: null,
        model: null,
      },
    },
    { id: "end", kind: "end", outcome: "Complete", position: { x: 440, y: 0 } },
  ],
  edges: EDGES,
});
const POLICY = JSON.stringify({ kind: "none" });
const DEFAULTS = JSON.stringify({
  triggerMode: "manual",
  deliveryMode: "preview",
  maxRepairRounds: 5,
});

/** The two workflow tables as they stood before this feature, with a row in each. */
function seedPreFeatureDb(): void {
  const raw = new DatabaseSync(join(home, "harness.db"));
  raw.exec(`
    CREATE TABLE IF NOT EXISTS workflow_definitions (
      id                     TEXT PRIMARY KEY,
      name                   TEXT NOT NULL,
      normalized_name        TEXT NOT NULL,
      description            TEXT NOT NULL DEFAULT '',
      draft_graph_json       TEXT NOT NULL,
      completion_policy_json TEXT NOT NULL,
      binding_defaults_json  TEXT NOT NULL,
      draft_revision         INTEGER NOT NULL DEFAULT 1,
      current_version_id     TEXT,
      archived_at            INTEGER,
      created_at             INTEGER NOT NULL,
      updated_at             INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflow_versions (
      id                     TEXT PRIMARY KEY,
      workflow_id            TEXT NOT NULL,
      version                INTEGER NOT NULL,
      source_draft_revision  INTEGER NOT NULL,
      graph_json             TEXT NOT NULL,
      completion_policy_json TEXT NOT NULL,
      binding_defaults_json  TEXT NOT NULL,
      published_at           INTEGER NOT NULL
    );
  `);
  raw.prepare(
    `INSERT INTO workflow_definitions (
       id, name, normalized_name, description, draft_graph_json, completion_policy_json,
       binding_defaults_json, draft_revision, current_version_id, archived_at,
       created_at, updated_at
     ) VALUES (?, ?, ?, '', ?, ?, ?, 1, ?, NULL, 1, 1)`,
  ).run("legacy-workflow", "Filed before resumption existed", "filed before resumption existed",
    DRAFT_GRAPH, POLICY, DEFAULTS, "legacy-version");
  raw.prepare(
    `INSERT INTO workflow_versions (
       id, workflow_id, version, source_draft_revision, graph_json,
       completion_policy_json, binding_defaults_json, published_at
     ) VALUES (?, ?, 1, 1, ?, ?, ?, 1)`,
  ).run("legacy-version", "legacy-workflow", PUBLISHED_GRAPH, POLICY, DEFAULTS);
  raw.close();
}

seedPreFeatureDb();

const { openDb } = await import("../src/server/db.ts");
const { WorkflowStore } = await import("../src/server/workflows/store.ts");
const { normalizePersonaName, normalizeWorkflowName } = await import("../src/shared/workflow.ts");

after(() => rmSync(home, { recursive: true, force: true }));

const db = openDb();

function columns(table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map((row) => row.name);
}

test("migrate() adds resumption_policy to both workflow tables on an upgraded database", () => {
  assert.ok(columns("workflow_definitions").includes("resumption_policy"));
  assert.ok(columns("workflow_versions").includes("resumption_policy"));
  // NULLABLE with no default. A `DEFAULT 'auto'` would have rewritten every already-published
  // version in place, which is the one outcome this column exists to prevent.
  const row = db.prepare(
    `SELECT resumption_policy FROM workflow_versions WHERE id = 'legacy-version'`,
  ).get() as { resumption_policy: string | null };
  assert.equal(row.resumption_policy, null);
});

test("a pre-feature row reads as manual, so an upgrade changes no published behaviour", () => {
  const store = new WorkflowStore(db);
  assert.equal(store.getWorkflowVersionById("legacy-version")?.resumptionPolicy, "manual");
  assert.equal(store.getWorkflow("legacy-workflow")?.resumptionPolicy, "manual");
});

test("a value this build cannot read is manual too, never a nearest match", () => {
  // A row written by a NEWER build still LOADS - a workflow nobody can see is one nobody can
  // fix - but the only thing `auto` does is start work unattended, so an unreadable value
  // takes the reading that does nothing until a human looks.
  db.prepare(
    `UPDATE workflow_versions SET resumption_policy = 'on-green-ci' WHERE id = 'legacy-version'`,
  ).run();
  const store = new WorkflowStore(db);
  assert.equal(store.getWorkflowVersionById("legacy-version")?.resumptionPolicy, "manual");
});

test("a workflow written by this build round-trips its policy, and publish freezes it", () => {
  const store = new WorkflowStore(db);
  store.insertPersona({
    id: "p1",
    name: "Judge",
    normalizedName: normalizePersonaName("Judge"),
    description: "Quality",
    guidanceMarkdown: "# Judge\n\nReview it.",
    runner: null,
    model: null,
    createdAt: 1,
    updatedAt: 1,
  });
  const created = store.insertWorkflow({
    id: "new-workflow",
    name: "Authored today",
    normalizedName: normalizeWorkflowName("Authored today"),
    description: "",
    draft: JSON.parse(DRAFT_GRAPH),
    completionPolicy: { kind: "none" },
    resumptionPolicy: "auto",
    bindingDefaults: { triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 5 },
    createdAt: 2,
    updatedAt: 2,
  });
  assert.equal(created.ok, true);
  assert.equal(store.getWorkflow("new-workflow")?.resumptionPolicy, "auto");

  const published = store.publishWorkflow("new-workflow", 1, "new-version", 3);
  assert.equal(published.ok, true);
  assert.equal(store.getWorkflowVersionById("new-version")?.resumptionPolicy, "auto");

  // Editing the draft afterwards must not reach the version an existing binding names.
  // Publish does not bump the draft revision, so the CAS token is still 1.
  const updated = store.updateWorkflowCas("new-workflow", 1, { resumptionPolicy: "manual" }, 4);
  assert.equal(updated.ok, true);
  assert.equal(store.getWorkflow("new-workflow")?.resumptionPolicy, "manual");
  assert.equal(
    store.getWorkflowVersionById("new-version")?.resumptionPolicy,
    "auto",
    "a published version is immutable; a draft edit rewrote it",
  );
  // The metadata projection reads the same column as the full version row, so version history
  // and run resolution can never disagree about what was published.
  assert.equal(
    store.listWorkflowVersionMetadata("new-workflow")[0]?.resumptionPolicy,
    "auto",
  );
});
