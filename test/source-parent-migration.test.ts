import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A swept item's parent over a database written before tasks could record one.
// `tasks.source_parent` arrives through `addColumn`, an older row reads as having no parent,
// and the upgraded row takes a parent and keeps it.

const home = mkdtempSync(join(tmpdir(), "mission-source-parent-migration-"));
process.env.MISSION_HOME = home;

function seedPreFeatureDb(): void {
  const raw = new DatabaseSync(join(home, "harness.db"));
  raw.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, intent TEXT NOT NULL, kind TEXT NOT NULL,
      agent TEXT NOT NULL, priority TEXT, labels TEXT, dependencies TEXT,
      enabled INTEGER NOT NULL DEFAULT 1, model TEXT, effort TEXT, advisor_model TEXT, workflow_id TEXT,
      source_id TEXT, external_id TEXT, source_url TEXT, repo_root TEXT NOT NULL,
      worktree_path TEXT, branch TEXT, provider TEXT, home_name TEXT,
      terminal_resource_id TEXT, session_id TEXT, schedule_id TEXT,
      schedule_occurrence_id TEXT, scheduled_for INTEGER, status TEXT NOT NULL,
      outcome TEXT, outcome_url TEXT, error TEXT, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, dispatched_at INTEGER, completed_at INTEGER
    );
    PRAGMA user_version = 25;
  `);
  raw.prepare(
    `INSERT INTO tasks (id, title, intent, kind, agent, source_id, external_id, source_url, repo_root, status, created_at, updated_at)
     VALUES ('swept', 'Swept', 'do it', 'ship', 'claude', 'gh', 'acme/demo#4', 'https://github.com/acme/demo/issues/4', '/repo', 'backlog', 1, 1)`,
  ).run();
  raw.close();
}

seedPreFeatureDb();

const { openDb, getTask, upsertTask, CURRENT_DATABASE_SCHEMA_VERSION } = await import("../src/server/db.ts");
after(() => rmSync(home, { recursive: true, force: true }));
openDb();

test("an upgraded database gains the column, and an older task reads as having no parent", () => {
  assert.ok(CURRENT_DATABASE_SCHEMA_VERSION >= 26);
  const columns = (openDb().prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[]).map((c) => c.name);
  assert.ok(columns.includes("source_parent"));
  assert.equal(
    (openDb().prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    CURRENT_DATABASE_SCHEMA_VERSION,
  );
  assert.equal(getTask("swept")?.sourceParent, null);
});

test("the upgraded row takes a parent and keeps it", () => {
  const parent = { sourceId: "gh", externalId: "acme/demo#3", url: "https://github.com/acme/demo/issues/3" };
  upsertTask({ ...getTask("swept")!, sourceParent: parent });
  assert.deepEqual(getTask("swept")?.sourceParent, parent);
  upsertTask({ ...getTask("swept")!, sourceParent: null });
  assert.equal(getTask("swept")?.sourceParent, null);
});
