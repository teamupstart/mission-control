import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * What is at stake: this phase is the only migration boundary for the whole ensemble family.
 * A missing table, a nullable column inside a conflict target, or a foreign key that is
 * declared but not enforced would not fail until a later phase tried to recover a real run -
 * by which point adding the constraint safely would mean migrating an operator's history.
 *
 * The database this runs against is deliberately an UPGRADED one, not a fresh one: it is
 * seeded with a pre-ensemble tasks table and then handed to `openDb()`, so every assertion
 * below also proves the path a real operator takes. A fresh-schema test would pass even if
 * the new statements had been put somewhere an existing database never reaches.
 */

// MISSION_HOME *is* the state dir, so the db lands at <home>/harness.db. It has to be set
// before anything that resolves it is imported, which is why the server import is dynamic.
const home = mkdtempSync(join(tmpdir(), "mission-ensemble-db-"));
process.env.MISSION_HOME = home;

function seedPreFeatureDb(): void {
  const raw = new DatabaseSync(join(home, "harness.db"));
  // The `tasks` table as it stands on main, i.e. what is actually on an operator's disk
  // before this change. Ensembles add no column to it; seeding it anyway is what makes the
  // assertions below statements about an UPGRADE rather than about a fresh install.
  raw.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id            TEXT PRIMARY KEY,
      title         TEXT NOT NULL,
      intent        TEXT NOT NULL,
      kind          TEXT NOT NULL,
      agent         TEXT NOT NULL,
      repo_root     TEXT NOT NULL,
      worktree_path TEXT,
      branch        TEXT,
      provider      TEXT,
      home_name     TEXT,
      session_id    TEXT,
      status        TEXT NOT NULL,
      outcome       TEXT,
      outcome_url   TEXT,
      error         TEXT,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      dispatched_at INTEGER,
      completed_at  INTEGER
    );
  `);
  raw
    .prepare(
      `INSERT INTO tasks (id, title, intent, kind, agent, repo_root, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("legacy-task", "Filed before ensembles existed", "do it", "ship", "claude", "/repo", "backlog", 1, 1);
  raw.close();
}

seedPreFeatureDb();

const { openDb } = await import("../src/server/db.ts");
const { ENSEMBLE_TABLES, EnsembleStore } = await import("../src/server/ensembles/store.ts");

const db = openDb();
after(() => rmSync(home, { recursive: true, force: true }));

function uniqueIndexes(table: string): string[][] {
  return (db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string; unique: number }>)
    .filter((index) => index.unique === 1)
    .map((index) =>
      (db.prepare(`PRAGMA index_info(${index.name})`).all() as Array<{ name: string | null }>).map(
        (column) => column.name ?? "(expression)",
      ),
    );
}

function columns(table: string): Array<{ name: string; notnull: number }> {
  return db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number }>;
}

test("upgrading an existing database creates the whole ensemble family and keeps its rows", () => {
  const tables = new Set(
    (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
  for (const table of ENSEMBLE_TABLES) assert.ok(tables.has(table), `missing ${table}`);
  const legacy = db.prepare(`SELECT title FROM tasks WHERE id = 'legacy-task'`).get() as
    | { title: string }
    | undefined;
  assert.equal(legacy?.title, "Filed before ensembles existed");
});

test("foreign keys are ENFORCED, not merely declared", () => {
  // A REFERENCES clause with the pragma off is a comment that looks like a constraint.
  const [pragma] = db.prepare(`PRAGMA foreign_keys`).all() as Array<{ foreign_keys: number }>;
  assert.equal(pragma?.foreign_keys, 1);

  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO ensemble_members (id, run_id, role_key, role_label, ordinal, wave, task_id,
             status, created_at, updated_at) VALUES ('m', 'no-such-run', 'r', 'R', 1, 1, '', 'pending', 1, 1)`,
        )
        .run(),
    /FOREIGN KEY/i,
  );
});

test("every child table names its run, so deleting one run collects all of its history", () => {
  const parents = new Map(
    ENSEMBLE_TABLES.filter((table) => table !== "ensemble_runs").map((table) => [
      table,
      (db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{ table: string; on_delete: string }>),
    ]),
  );
  for (const [table, keys] of parents) {
    assert.ok(keys.length > 0, `${table} declares no foreign key`);
    assert.ok(
      keys.some((key) => key.table === "ensemble_runs"),
      `${table} does not reference ensemble_runs`,
    );
    for (const key of keys) {
      assert.equal(key.on_delete, "CASCADE", `${table} -> ${key.table} does not cascade`);
    }
  }
});

test("no column inside a uniqueness key is nullable", () => {
  // SQLite treats NULLs as DISTINCT inside a unique index, so a nullable half turns an
  // idempotent upsert back into an insert and the row multiplies on every retry. On this
  // family that would mean a duplicate run, a duplicate artifact, or a re-issued command.
  for (const table of ENSEMBLE_TABLES) {
    const notNull = new Map(columns(table).map((column) => [column.name, column.notnull === 1]));
    for (const index of uniqueIndexes(table)) {
      for (const column of index) {
        if (column === "(expression)") continue;
        assert.equal(notNull.get(column), true, `${table}.${column} is nullable inside a unique index`);
      }
    }
  }
});

test("the source claim, the roster, and every operation key are unique", () => {
  const runIndexes = uniqueIndexes("ensemble_runs").map((columns) => columns.join(","));
  assert.ok(runIndexes.includes("source_kind,source_key"), runIndexes.join(" | "));

  const memberIndexes = uniqueIndexes("ensemble_members").map((columns) => columns.join(","));
  assert.ok(memberIndexes.includes("run_id,ordinal"));
  assert.ok(memberIndexes.includes("run_id,role_key"));
  assert.ok(memberIndexes.includes("task_id"));

  assert.ok(uniqueIndexes("ensemble_attempts").some((c) => c.join(",") === "member_id,attempt"));
  assert.ok(
    uniqueIndexes("ensemble_artifacts").some((c) => c.join(",") === "run_id,attempt_id,kind,attempt"),
  );
  assert.ok(uniqueIndexes("ensemble_artifacts").some((c) => c.join(",") === "operation_key"));
  assert.ok(
    uniqueIndexes("ensemble_stage_attempts").some((c) => c.join(",") === "run_id,stage_id,attempt"),
  );
  assert.ok(uniqueIndexes("ensemble_stage_attempts").some((c) => c.join(",") === "command_key"));
  assert.ok(
    uniqueIndexes("ensemble_evaluations").some((c) => c.join(",") === "stage_attempt_id,attempt"),
  );
  assert.ok(uniqueIndexes("ensemble_llm_calls").some((c) => c.join(",") === "operation_key"));
  assert.ok(uniqueIndexes("ensemble_decisions").some((c) => c.join(",") === "run_id,version"));
  assert.ok(uniqueIndexes("ensemble_decisions").some((c) => c.join(",") === "operation_key"));
  assert.ok(uniqueIndexes("ensemble_events").some((c) => c.join(",") === "operation_key"));
});

test("many members may have no task, but a task belongs to at most one member", () => {
  // The partial index is what makes the empty-string normalization safe: it excludes the
  // rows that mean "not launched yet" and constrains only the ones that name a real task.
  db.prepare(
    `INSERT INTO ensemble_runs (id, source_kind, source_key, source_id, strategy_id, strategy_version,
       strategy_key, strategy_label, title, intent, repo_root, base_branch, base_sha,
       compiled_plan_json, strategy_config_json, status, created_at, updated_at)
     VALUES ('run-part', 'manual', 'k-part', NULL, 'best_of_n', 1, 'best_of_n@1', 'Best of N',
             'T', 'I', '/repo', NULL, NULL, '{}', '{}', 'planning', 1, 1)`,
  ).run();
  const insert = db.prepare(
    `INSERT INTO ensemble_members (id, run_id, role_key, role_label, ordinal, wave, task_id, status,
       created_at, updated_at) VALUES (?, 'run-part', ?, 'R', ?, 1, ?, 'pending', 1, 1)`,
  );
  insert.run("m1", "candidate-1", 1, "");
  insert.run("m2", "candidate-2", 2, "");
  insert.run("m3", "candidate-3", 3, "task-a");
  assert.throws(() => insert.run("m4", "candidate-4", 4, "task-a"), /UNIQUE/i);

  db.prepare(`DELETE FROM ensemble_runs WHERE id = 'run-part'`).run();
  const orphans = db
    .prepare(`SELECT COUNT(*) AS count FROM ensemble_members WHERE run_id = 'run-part'`)
    .get() as { count: number };
  assert.equal(orphans.count, 0, "deleting a run must collect its members");
});

test("child ownership cannot cross ensemble runs", () => {
  const insertRun = db.prepare(
    `INSERT INTO ensemble_runs (id, source_kind, source_key, source_id, strategy_id, strategy_version,
       strategy_key, strategy_label, title, intent, repo_root, base_branch, base_sha,
       compiled_plan_json, strategy_config_json, status, created_at, updated_at)
     VALUES (?, 'manual', ?, NULL, 'best_of_n', 1, 'best_of_n@1', 'Best of N',
             'T', 'I', '/repo', NULL, NULL, '{}', '{}', 'planning', 1, 1)`,
  );
  insertRun.run("owner-a", "owner-a");
  insertRun.run("owner-b", "owner-b");
  const insertMember = db.prepare(
    `INSERT INTO ensemble_members (id, run_id, role_key, role_label, ordinal, wave, task_id,
       status, created_at, updated_at) VALUES (?, ?, 'candidate', 'Candidate', 1, 1, '', 'pending', 1, 1)`,
  );
  insertMember.run("member-a", "owner-a");
  insertMember.run("member-b", "owner-b");

  const insertAttempt = db.prepare(
    `INSERT INTO ensemble_attempts (id, run_id, member_id, attempt, status, created_at, updated_at)
     VALUES (?, ?, ?, 1, 'running', 1, 1)`,
  );
  assert.throws(() => insertAttempt.run("cross-attempt", "owner-a", "member-b"), /FOREIGN KEY/i);
  insertAttempt.run("attempt-b", "owner-b", "member-b");

  const store = new EnsembleStore(db);
  assert.throws(
    () =>
      store.recordArtifact({
        runId: "owner-a",
        attemptId: "attempt-b",
        kind: "commit",
        formatVersion: 1,
        attempt: 1,
        status: "ready",
        locator: {},
        digest: "d",
        metadata: {},
        operationKey: "cross-artifact",
        readyAt: 1,
      }),
    /does not belong/,
  );

  db.prepare(
    `INSERT INTO ensemble_stage_attempts (id, run_id, stage_id, driver_kind, driver_key, attempt,
       command_key, status, input_json, created_at, updated_at)
     VALUES ('stage-b', 'owner-b', 'stage', 'review', 'comparative_review@1', 1,
             'stage-b:1', 'running', '{}', 1, 1)`,
  ).run();
  assert.throws(
    () =>
      db.prepare(
        `INSERT INTO ensemble_evaluations (id, run_id, stage_attempt_id, attempt, method,
           runner_id, model_id, input_fingerprint, subjects_json, status, created_at, updated_at)
         VALUES ('cross-evaluation', 'owner-a', 'stage-b', 1, 'comparative_llm',
                 NULL, NULL, 'f', '[]', 'running', 1, 1)`,
      ).run(),
    /FOREIGN KEY/i,
  );

  db.prepare(`DELETE FROM ensemble_runs WHERE id IN ('owner-a', 'owner-b')`).run();
});

test("a monetary cost is nullable, because unknown and zero are different facts", () => {
  const cost = columns("ensemble_llm_calls").find((column) => column.name === "cost_usd");
  assert.equal(cost?.notnull, 0);
});

test("an unresolved evaluation runner and model are nullable", () => {
  const evaluationColumns = columns("ensemble_evaluations");
  assert.equal(evaluationColumns.find((column) => column.name === "runner_id")?.notnull, 0);
  assert.equal(evaluationColumns.find((column) => column.name === "model_id")?.notnull, 0);
});

test("the pinned base is nullable, because a run has none until the launch runtime pins one", () => {
  const base = columns("ensemble_runs").find((column) => column.name === "base_sha");
  assert.equal(base?.notnull, 0);
});
