// Schema 37 (task hibernation) on an upgraded database: a version 36 file opens, gains only the
// nullable `tasks.hibernation` column, keeps its rows, and a second open changes nothing.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "mission-hibernation-upgrade-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { openDb, closeDb, getTask, upsertTask, CURRENT_DATABASE_SCHEMA_VERSION } = await import("../src/server/db.ts");
const { mkTask } = await import("./helpers/session-fixture.ts");
const dbPath = join(home, "harness.db");

const columns = (d: DatabaseSync, table: string) =>
  (d.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);

test("a schema 36 database upgrades through 37 with the hibernation column and keeps its tasks", () => {
  // Later schemas build on 37; a 36 file goes all the way to the current one.
  assert.ok(CURRENT_DATABASE_SCHEMA_VERSION >= 37);
  // Build the current schema with a task in it, then take schema 37 away again: what a 36 file
  // looked like.
  openDb();
  upsertTask(mkTask({ id: "kept", title: "Kept task", status: "backlog" }));
  closeDb();
  const old = new DatabaseSync(dbPath);
  old.exec("ALTER TABLE tasks DROP COLUMN hibernation");
  old.exec("PRAGMA user_version = 36");
  old.close();

  const upgraded = openDb();
  assert.equal((upgraded.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, CURRENT_DATABASE_SCHEMA_VERSION);
  assert.ok(columns(upgraded, "tasks").includes("hibernation"));
  const kept = getTask("kept");
  assert.equal(kept?.title, "Kept task");
  assert.equal(kept?.status, "backlog");
  assert.equal(kept?.hibernation ?? null, null, "no task was hibernated before the column existed");

  closeDb();
  const reopened = openDb(); // idempotent: nothing to add the second time
  assert.ok(columns(reopened, "tasks").includes("hibernation"));
  closeDb();
});
