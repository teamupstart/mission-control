import { test, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Guards the `tmux_session` -> `home_name` rename's one WORKTREE-LOSING edge, which is the
// whole reason this rename is a migration and not a field swap. A running task on a real
// user's machine carries its live agent's terminal home in the `tmux_session` column. If the
// upgrade added `home_name` without carrying that value across, every such task would read
// back with `homeName: null` - and `reconcileOnStartup`, seeing no home to probe, would run
// `git worktree remove --force` on the checkout its agent is still working in. So the
// migration must BACKFILL, and this seeds a pre-rename database exactly as an upgrading
// user's would look, then lets db.ts open it for the first time so the migration runs on the
// same path production takes.

// MISSION_HOME *is* the state dir (harness-runtime's stateDir()), so the db lands at
// <home>/harness.db - the same file db.ts opens below.
const home = mkdtempSync(join(tmpdir(), "mission-home-migrate-"));
process.env.MISSION_HOME = home;

/** Write a pre-rename tasks row: the schema had `tmux_session`, never `home_name`. */
function seedLegacyDb(): void {
  const raw = new DatabaseSync(join(home, "harness.db"));
  // The tasks schema as it shipped BEFORE this rename: `tmux_session`, all the
  // already-migrated columns, and no `home_name`. Faithful to what openDb() will meet.
  raw.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id            TEXT PRIMARY KEY,
      title         TEXT NOT NULL,
      intent        TEXT NOT NULL,
      kind          TEXT NOT NULL,
      agent         TEXT NOT NULL,
      priority      TEXT,
      labels        TEXT,
      model         TEXT,
      source_id     TEXT,
      external_id   TEXT,
      source_url    TEXT,
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
  // A live dispatched task: it holds a worktree AND a real terminal home name. This is the
  // row whose home name MUST survive, or its tree is force-removed on the next start.
  raw
    .prepare(
      `INSERT INTO tasks (id, title, intent, kind, agent, repo_root, worktree_path, tmux_session, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("live-1", "Ship the login fix", "do it", "ship", "claude", "/repo", "/wt/live-1", "ship-the-login-fix-abc123", "running", 1, 1);
  // A backlog task never had a home. NULL is the truthful answer, and must stay NULL rather
  // than becoming "" - the reader distinguishes the two nowhere, but the column should not
  // invent a name for a task that has none.
  raw
    .prepare(
      `INSERT INTO tasks (id, title, intent, kind, agent, repo_root, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("backlog-1", "Later", "eventually", "ship", "claude", "/repo", "backlog", 1, 1);
  raw.close();
}

seedLegacyDb();

const { openDb, getTask, upsertTask } = await import("../src/server/db.ts");

after(() => rmSync(home, { recursive: true, force: true }));

test("openDb backfills a live task's home name from the old tmux_session column", () => {
  openDb();
  // The safety property in one line: the running task's terminal home name is preserved, so
  // reconcileOnStartup probes the real name rather than reading `null` and reclaiming a live
  // agent's worktree.
  assert.equal(getTask("live-1")?.homeName, "ship-the-login-fix-abc123");
});

test("a task that never had a home stays null, not empty", () => {
  assert.equal(getTask("backlog-1")?.homeName, null);
});

test("the old tmux_session column is left intact but no longer read", () => {
  // House pattern (db.ts): a renamed column is left in place (SQLite drops are the expensive
  // migration) and simply stops being named by any write. So the fossil survives...
  const raw = new DatabaseSync(join(home, "harness.db"));
  const row = raw.prepare(`SELECT tmux_session FROM tasks WHERE id = ?`).get("live-1") as {
    tmux_session: string | null;
  };
  raw.close();
  assert.equal(row.tmux_session, "ship-the-login-fix-abc123");

  // ...and clearing home_name (as a reclaim does) leaves it null on the way back out: the
  // read path takes home_name and never falls back to the fossil, so a reclaimed task cannot
  // be re-bound to the name its teardown once aimed at.
  const t = getTask("live-1")!;
  upsertTask({ ...t, homeName: null });
  assert.equal(getTask("live-1")?.homeName, null);
});

test("a task written after the upgrade round-trips its home name", () => {
  const t = getTask("backlog-1")!;
  upsertTask({ ...t, homeName: "some-dispatched-home" });
  assert.equal(getTask("backlog-1")?.homeName, "some-dispatched-home");
});
