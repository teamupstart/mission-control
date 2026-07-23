import { test, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The backfill from `tmux_session` -> `home_name` must run EXACTLY ONCE, on the start that
// adds the column, and never again. `tmux_session` becomes a frozen fossil after the rename
// (no write path names it), so a task dispatched before the upgrade and later RECLAIMED has
// `home_name = NULL` and a stale `tmux_session` still naming the home it used to hold. If the
// backfill re-ran on every open it would resurrect that dead name onto the reclaimed task and
// re-aim its teardown - `killHome` - at whatever session has since taken the name.
//
// This seeds a database in the ALREADY-MIGRATED shape (both columns present) and opens it, so
// migrate() meets a `home_name` column that already exists. `addColumn` returns false, the
// backfill is gated on it, and the fossil must stay buried.

const home = mkdtempSync(join(tmpdir(), "mission-home-idem-"));
process.env.MISSION_HOME = home;

/** Write a post-first-migration tasks row: both `tmux_session` and `home_name` exist. */
function seedMigratedDb(): void {
  const raw = new DatabaseSync(join(home, "harness.db"));
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
  // A reclaimed task: home_name cleared to NULL, but the fossil tmux_session still names the
  // home it once held. Re-running the backfill would resurrect "ghost-home" onto it.
  raw
    .prepare(
      `INSERT INTO tasks (id, title, intent, kind, agent, repo_root, tmux_session, home_name, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("reclaimed-1", "Done and reclaimed", "did it", "ship", "claude", "/repo", "ghost-home", null, "done", 1, 1);
  raw.close();
}

seedMigratedDb();

const { openDb, getTask } = await import("../src/server/db.ts");

after(() => rmSync(home, { recursive: true, force: true }));

test("openDb does not re-run the backfill when home_name already exists", () => {
  openDb();
  // The gate held: `addColumn` found `home_name` already present and returned false, so the
  // fossil `tmux_session` was NOT copied over a task that had been reclaimed to null.
  assert.equal(getTask("reclaimed-1")?.homeName, null);
});
