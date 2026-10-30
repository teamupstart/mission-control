import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// An operator's database from before residents existed gains the three tables, empty, with
// the request-id index over a NOT NULL column - and the catalog reads as empty rather than
// failing.

const home = mkdtempSync(join(tmpdir(), "mission-residents-upgrade-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

// A pre-feature database: a real file with a table this build also creates, and no resident
// tables at all.
const raw = new DatabaseSync(join(home, "harness.db"));
raw.exec(`CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          INSERT INTO app_config (key, value) VALUES ('ui', '{}');`);
raw.close();

const { openDb } = await import("../src/server/db.ts");
const store = await import("../src/server/residents/store.ts");

test("an upgraded database gains the resident tables empty, with the idempotency key enforced", () => {
  const db = openDb();
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'resident_%'`)
    .all() as Array<{ name: string }>).map((row) => row.name).sort();
  assert.deepEqual(tables, ["resident_profile_revisions", "resident_profiles", "resident_runs"]);
  const runColumns = db.prepare(`PRAGMA table_info(resident_runs)`).all() as Array<{ name: string; notnull: number }>;
  for (const column of ["launch_request_id", "launch_input", "launch_repo_spelling", "launch_state", "task_id", "persona_snapshot"]) {
    assert.equal(runColumns.find((c) => c.name === column)?.notnull, 1, `${column} must be NOT NULL`);
  }
  const indexes = db.prepare(`PRAGMA index_list(resident_runs)`).all() as Array<{ name: string; unique: number }>;
  assert.equal(indexes.find((index) => index.name === "idx_resident_runs_request")?.unique, 1);
  assert.deepEqual(store.listLiveResidentProfiles(), []);
  assert.equal((db.prepare(`SELECT value FROM app_config WHERE key = 'ui'`).get() as { value: string }).value, "{}");
});
