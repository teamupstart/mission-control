import { test, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Guards the `queued` -> `backlog` rename's ONE data-losing edge: rows written
// before the rename are still persisted as 'queued', and `loadActiveTasks` now
// only selects 'backlog'. Without the migration in openDb(), every task sitting
// in a real user's backlog would silently vanish from the dashboard on the first
// start after upgrading - present in the DB, absent from the dashboard.
//
// This seeds a pre-rename database on disk exactly as an upgrading user's would
// look, then lets db.ts open it for the first time, so the migration runs on the
// same path production takes rather than on a hand-called helper.

// MISSION_HOME *is* the state dir (harness-runtime's stateDir()), so the db lands
// at <home>/harness.db - the same file db.ts will open below.
const home = mkdtempSync(join(tmpdir(), "mission-migrate-"));
process.env.MISSION_HOME = home;

/** Write a pre-rename tasks row (status='queued') straight to the db file. */
function seedLegacyDb(): void {
  const raw = new DatabaseSync(join(home, "harness.db"));
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
      tmux_session  TEXT,
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
    .run("legacy-1", "Shelved before the rename", "do it", "ship", "claude", "/repo", "queued", 1, 1);
  // A terminal row the migration must NOT touch - it only rewrites 'queued'.
  raw
    .prepare(
      `INSERT INTO tasks (id, title, intent, kind, agent, repo_root, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("legacy-2", "Already shipped", "did it", "ship", "claude", "/repo", "done", 1, 1);
  raw.close();
}

seedLegacyDb();

const { openDb, getTask, loadActiveTasks, upsertTask } = await import("../src/server/db.ts");

after(() => rmSync(home, { recursive: true, force: true }));

test("openDb migrates pre-rename 'queued' tasks to 'backlog'", () => {
  openDb();
  assert.equal(getTask("legacy-1")?.status, "backlog");
});

test("a migrated task is still loaded as active, so a real backlog survives the upgrade", () => {
  // The regression this exists for: loadActiveTasks selects 'backlog', so an
  // unmigrated 'queued' row would be dropped from the rehydrated dashboard entirely.
  const ids = loadActiveTasks().map((t) => t.id);
  assert.ok(ids.includes("legacy-1"), "the shelved task must survive the rename");
});

test("the migration leaves non-queued rows alone", () => {
  assert.equal(getTask("legacy-2")?.status, "done");
});

/*
 * The seeded table above has no `priority` / `labels` columns - it is the pre-triage
 * schema, byte for byte. That makes it the exact fixture the ALTERs exist for, so the
 * two tests below ride it rather than seeding a second database.
 *
 * `CREATE TABLE IF NOT EXISTS` will not add a column to a table that already exists, so
 * without the `addColumn` calls in migrate() every task write on an upgraded install
 * would fail against a table missing the columns the INSERT names - not a silent
 * degradation but a hard break, on the first dispatch after upgrading.
 */

test("openDb adds the triage columns to a pre-triage tasks table", () => {
  // Reading a legacy row back proves the columns exist AND that a row written before
  // triage reads as untriaged rather than as anything the sort would move.
  const legacy = getTask("legacy-1");
  assert.equal(legacy?.priority, null);
  assert.deepEqual(legacy?.labels, []);
  // Effort arrived later too; an old row follows the harness default rather than
  // acquiring a made-up level during migration.
  assert.equal(legacy?.effort, null);
});

test("a task written after the upgrade round-trips its triage fields", () => {
  const t = getTask("legacy-1")!;
  upsertTask({ ...t, priority: "high", labels: ["infra", "flaky"], effort: "xhigh" });
  const back = getTask("legacy-1");
  assert.equal(back?.priority, "high");
  assert.deepEqual(back?.labels, ["infra", "flaky"]);
  assert.equal(back?.effort, "xhigh");
});

test("a persisted effort unsupported by its harness reads as default", () => {
  openDb().prepare("UPDATE tasks SET agent = ?, effort = ? WHERE id = ?").run("codex", "max", "legacy-1");
  assert.equal(getTask("legacy-1")?.effort, null);
});
