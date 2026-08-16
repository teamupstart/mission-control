import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

// Seed a database that predates both native pool tables and the check provider column,
// before importing db.ts and allowing the production open path to migrate it.
const home = process.env.HARNESS_HOME;
assert.ok(home, "test/setup-state.mjs must provide an isolated HARNESS_HOME");
mkdirSync(home, { recursive: true });
const path = join(home, "harness.db");
const legacy = new DatabaseSync(path);
legacy.exec(`
  CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO app_config (key, value) VALUES ('legacy-setting', '{"kept":true}');

  CREATE TABLE workflow_check_leases (
    attempt_id             TEXT    NOT NULL PRIMARY KEY,
    submission_id          TEXT    NOT NULL,
    node_id                TEXT    NOT NULL,
    repo_root              TEXT    NOT NULL,
    lease_path             TEXT    NOT NULL,
    holder_token           TEXT    NOT NULL,
    cleanup_state          TEXT    NOT NULL,
    supervisor_pid         INTEGER NOT NULL,
    supervisor_start_ticks TEXT    NOT NULL,
    created_at             INTEGER NOT NULL,
    updated_at             INTEGER NOT NULL
  );
  INSERT INTO workflow_check_leases VALUES
    ('attempt-old', 'submission-old', 'node-old', '/repo', '/pool/1/repo',
     'mission-control-check-attempt-old', 'held', 0, '', 1, 1);
`);
legacy.close();

const { openDb } = await import("../src/server/db.ts");
const db = openDb();

test("a pre-native database gains empty operational tables without rewriting old rows", () => {
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table'
       AND name IN ('worktree_pools', 'worktree_slots') ORDER BY name`,
    )
    .all() as unknown as Array<{ name: string }>;
  assert.deepEqual(tables.map((row) => row.name), ["worktree_pools", "worktree_slots"]);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM worktree_pools`).get() as { n: number }).n, 0);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM worktree_slots`).get() as { n: number }).n, 0);
  assert.equal(
    (db.prepare(`SELECT value FROM app_config WHERE key = 'legacy-setting'`).get() as { value: string }).value,
    '{"kept":true}',
  );
  assert.equal(
    (db.prepare(`SELECT provider FROM workflow_check_leases WHERE attempt_id = 'attempt-old'`).get() as {
      provider: string;
    }).provider,
    "treehouse",
  );
});
