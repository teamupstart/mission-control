import assert from "node:assert/strict";
import { after, test } from "node:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Stacked pull requests adds columns to `tasks` and `inspector_prs`, so it is a schema version
// of its own: a database written at the previous version gets a pre-migration recovery point
// before the columns are added, exactly as every earlier column-adding upgrade does.

const home = mkdtempSync(join(tmpdir(), "mission-stacking-schema-version-"));
process.env.MISSION_HOME = home;
const { openDb, closeDb, CURRENT_DATABASE_SCHEMA_VERSION } = await import("../src/server/db.ts");
after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

const TASK_COLUMNS = ["stack_parent_task_id", "stack_base_branch", "stack_base_sha", "stack_pr_url"];
const PR_COLUMNS = [
  "base_ref_name", "reviewed_base_ref", "reviewed_base_sha", "merge_commit_sha", "stack_task_id",
  "stack_episode", "stack_adopted_at", "stack_parent_pr_url", "stack_base_sha",
  "stack_released_head_sha", "stack_lineage_history", "stack_note",
];

function columns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name);
}

test("a version-19 database gets a recovery point before the stacking columns are added", () => {
  assert.equal(CURRENT_DATABASE_SCHEMA_VERSION, 20);
  const backupRoot = join(home, "backups", "database");
  const db = openDb();
  db.exec([
    ...TASK_COLUMNS.map((name) => `ALTER TABLE tasks DROP COLUMN ${name};`),
    ...PR_COLUMNS.map((name) => `ALTER TABLE inspector_prs DROP COLUMN ${name};`),
    "PRAGMA user_version = 19;",
  ].join("\n"));
  closeDb();

  const migrated = openDb();
  const backups = existsSync(backupRoot) ? readdirSync(backupRoot).filter((name) => name.startsWith("pre-migration-")) : [];
  assert.equal(backups.length, 1, "the upgrade from 19 captures one recovery point");
  const recovery = new DatabaseSync(join(backupRoot, backups[0]!), { readOnly: true });
  try {
    assert.equal(Number((recovery.prepare("PRAGMA user_version").get() as { user_version: number }).user_version), 19);
    assert.ok(!columns(recovery, "tasks").some((name) => TASK_COLUMNS.includes(name)), "the recovery point predates the task columns");
    assert.ok(!columns(recovery, "inspector_prs").some((name) => PR_COLUMNS.includes(name)), "and the pull request columns");
  } finally {
    recovery.close();
  }
  assert.equal(Number((migrated.prepare("PRAGMA user_version").get() as { user_version: number }).user_version), 20);
  for (const name of TASK_COLUMNS) assert.ok(columns(migrated, "tasks").includes(name), name);
  for (const name of PR_COLUMNS) assert.ok(columns(migrated, "inspector_prs").includes(name), name);

  closeDb();
  openDb();
  assert.equal(
    readdirSync(backupRoot).filter((name) => name.startsWith("pre-migration-")).length,
    1,
    "reopening a current database captures nothing more",
  );
});
