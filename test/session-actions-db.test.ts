import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// What is at stake: `session_actions` is a NEW table, so the risk is not a backfill - it is
// that an operator upgrading into this build has a database whose workflow family already
// exists, and `openDb` has to add the table to it without failing on the way past everything
// it already has. A fresh-schema test alone would pass even if that were broken.

const home = mkdtempSync(join(tmpdir(), "mission-session-actions-db-"));
process.env.MISSION_HOME = home;

/**
 * The database of a build that shipped before SessionActions: a workflow family with real
 * rows in it, and no `session_actions` table anywhere.
 */
function seedPreFeatureDb(): void {
  const raw = new DatabaseSync(join(home, "harness.db"));
  raw.exec(`
    CREATE TABLE IF NOT EXISTS personas (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      description     TEXT NOT NULL DEFAULT '',
      guidance_md     TEXT NOT NULL,
      runner_id       TEXT,
      model_id        TEXT,
      revision        INTEGER NOT NULL DEFAULT 1,
      archived_at     INTEGER,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
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
  `);
  raw.prepare(
    `INSERT INTO personas (id, name, normalized_name, description, guidance_md, runner_id,
       model_id, revision, archived_at, created_at, updated_at)
     VALUES ('legacy-judge', 'Legacy Judge', 'legacy judge', '', '# Judge', NULL, NULL, 2, NULL, 1, 1)`,
  ).run();
  raw.prepare(
    `INSERT INTO workflow_definitions (id, name, normalized_name, description, draft_graph_json,
       completion_policy_json, binding_defaults_json, draft_revision, current_version_id,
       archived_at, created_at, updated_at)
     VALUES ('legacy-workflow', 'Legacy', 'legacy', '', ?, ?, ?, 1, NULL, NULL, 1, 1)`,
  ).run(
    JSON.stringify({ nodes: [], edges: [] }),
    JSON.stringify({ kind: "none" }),
    JSON.stringify({ triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 5 }),
  );
  raw.close();
}

seedPreFeatureDb();

const { openDb } = await import("../src/server/db.ts");
const { WorkflowStore } = await import("../src/server/workflows/store.ts");

after(() => rmSync(home, { recursive: true, force: true }));

const db = openDb();

test("an existing database opens and receives the new table", () => {
  const table = db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_actions'`,
  ).get() as { name: string } | undefined;
  assert.equal(table?.name, "session_actions");

  const columns = db.prepare(`PRAGMA table_info(session_actions)`).all() as unknown as Array<{
    name: string;
    notnull: number;
  }>;
  assert.deepEqual(columns.map((column) => column.name), [
    "id",
    "name",
    "normalized_name",
    "description",
    "prompt_md",
    "required_skill_id",
    "completion_kind",
    "revision",
    "archived_at",
    "created_at",
    "updated_at",
  ]);
  // The three that decide behaviour are NOT NULL: a row with no prompt has nothing to
  // deliver, and one with no completion kind has no definition of done.
  for (const name of ["prompt_md", "completion_kind", "normalized_name"]) {
    assert.equal(columns.find((column) => column.name === name)?.notnull, 1, `${name} is nullable`);
  }
});

test("the normalized-name uniqueness index arrives with the table", () => {
  const unique = (db.prepare(`PRAGMA index_list(session_actions)`).all() as unknown as Array<{
    name: string;
    unique: number;
  }>)
    .filter((index) => index.unique === 1)
    .map((index) => (db.prepare(`PRAGMA index_info(${index.name})`).all() as unknown as Array<{
      name: string;
    }>).map((column) => column.name).join(","));
  assert.ok(unique.includes("normalized_name"), "one live name means one durable identity");
});

test("nothing the upgraded database already held was disturbed", () => {
  const store = new WorkflowStore(db);
  assert.equal(store.getPersona("legacy-judge")?.revision, 2);
  assert.equal(store.getWorkflow("legacy-workflow")?.name, "Legacy");
  // And the new table is empty rather than seeded: built-ins are app data, not rows.
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM session_actions`).get() as { n: number }).n,
    0,
  );
  assert.ok(store.listSessionActions().every((action) => action.builtin));
});

test("opening twice is idempotent, as every start of the daemon is", () => {
  const again = openDb();
  assert.equal(
    (again.prepare(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'session_actions'`,
    ).get() as { n: number }).n,
    1,
  );
});
