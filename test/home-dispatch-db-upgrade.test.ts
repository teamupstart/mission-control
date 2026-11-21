// Schema 36 (headless mode) on an upgraded database: a version 35 file opens, gains only
// additive tables and columns, keeps its rows, and a second open changes nothing.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "mission-home-dispatch-upgrade-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { openDb, closeDb, CURRENT_DATABASE_SCHEMA_VERSION } = await import("../src/server/db.ts");
const dbPath = join(home, "harness.db");

const columns = (d: DatabaseSync, table: string) =>
  (d.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);

test("a schema 35 database upgrades through 36 additively and keeps its rows", () => {
  // Later schemas build on 36; a 35 file goes all the way to the current one.
  assert.ok(CURRENT_DATABASE_SCHEMA_VERSION >= 36);
  // Build the current schema, then take schema 36 away again: what a 35 file looked like.
  openDb();
  closeDb();
  const old = new DatabaseSync(dbPath);
  for (const column of ["origin_surface", "origin_repo", "origin_session_id"]) old.exec(`ALTER TABLE tasks DROP COLUMN ${column}`);
  old.exec("ALTER TABLE session_standing_instructions DROP COLUMN repo_task_skills");
  old.exec("DROP TABLE home_dispatch_sessions; DROP TABLE home_dispatch_receipts;");
  old.prepare(`INSERT INTO session_standing_instructions (note_key, text, mechanism, sources, created_at)
    VALUES ('k', 'kept', 'hook', '[]', 1)`).run();
  old.exec("PRAGMA user_version = 35");
  old.close();

  const upgraded = openDb();
  assert.equal((upgraded.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, CURRENT_DATABASE_SCHEMA_VERSION);
  for (const column of ["origin_surface", "origin_repo", "origin_session_id"]) assert.ok(columns(upgraded, "tasks").includes(column), column);
  assert.ok(columns(upgraded, "session_standing_instructions").includes("repo_task_skills"));
  assert.deepEqual(columns(upgraded, "home_dispatch_sessions"), [
    "session_id", "harness", "cwd", "repo_root", "client_version", "start_source", "entrypoint",
    "launcher_offered_at", "launcher_disabled", "started_at",
  ]);
  assert.deepEqual(columns(upgraded, "home_dispatch_receipts"),
    ["review_id", "task_id", "session_id", "surface", "sent", "created_at"]);
  // No `claude_pid`, `origin_terminal` or turn log (spec 8.4).
  assert.ok(!columns(upgraded, "tasks").includes("origin_terminal"));
  assert.ok(!columns(upgraded, "home_dispatch_sessions").includes("claude_pid"));
  assert.equal((upgraded.prepare("SELECT text FROM session_standing_instructions WHERE note_key = 'k'").get() as { text: string }).text, "kept");
  for (const table of ["home_dispatch_sessions", "home_dispatch_receipts"]) {
    assert.equal((upgraded.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, 0, `${table} starts empty`);
  }
  assert.equal(upgraded.prepare("SELECT 1 FROM sqlite_master WHERE name = 'home_dispatch_turns'").get(), undefined);

  closeDb();
  const reopened = openDb(); // idempotent: nothing to add the second time
  assert.equal((reopened.prepare("SELECT text FROM session_standing_instructions").get() as { text: string }).text, "kept");
  closeDb();
});
