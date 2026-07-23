import { test, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "mission-home-atomic-"));
const dbPath = join(home, "harness.db");
process.env.MISSION_HOME = home;

function seedFailingLegacyDb(): void {
  const raw = new DatabaseSync(dbPath);
  raw.exec(`
    CREATE TABLE tasks (
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
    CREATE TRIGGER reject_home_backfill
    BEFORE UPDATE OF home_name ON tasks
    BEGIN
      SELECT RAISE(ABORT, 'reject home backfill');
    END;
  `);
  raw
    .prepare(
      `INSERT INTO tasks (id, title, intent, kind, agent, repo_root, tmux_session, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("live-1", "Live task", "do it", "ship", "claude", "/repo", "live-home", "running", 1, 1);
  raw.close();
}

seedFailingLegacyDb();

const { openDb } = await import("../src/server/db.ts");

after(() => rmSync(home, { recursive: true, force: true }));

test("a failed home-name backfill rolls back the column addition", () => {
  assert.throws(() => openDb(), /reject home backfill/);

  const raw = new DatabaseSync(dbPath);
  const columns = raw.prepare(`PRAGMA table_info(tasks)`).all() as unknown as Array<{ name: string }>;
  assert.equal(columns.some((column) => column.name === "home_name"), false);
  const row = raw.prepare(`SELECT tmux_session FROM tasks WHERE id = ?`).get("live-1") as {
    tmux_session: string | null;
  };
  assert.equal(row.tmux_session, "live-home");
  raw.close();
});
