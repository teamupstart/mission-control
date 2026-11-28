// Schema 40: `tasks.work_unit_id`. A schema 39 file opens and gains the column and its index, an
// older row reads as having no work unit, and no write changes an id once one is stored.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { tempDir } from "./temp-root.mjs";

const home = tempDir("mission-work-unit-db-");
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const {
  openDb, closeDb, getTask, upsertTask, claimTaskWorkUnitId, storedTaskWorkUnitId,
  CURRENT_DATABASE_SCHEMA_VERSION,
} = await import("../src/server/db.ts");
const { mintWorkUnitId } = await import("../src/server/work-unit.ts");
const { mkTask } = await import("./helpers/session-fixture.ts");

const dbPath = join(home, "harness.db");
const columns = (d: DatabaseSync) =>
  (d.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>).map((c) => c.name);
const indexes = (d: DatabaseSync) =>
  (d.prepare(`PRAGMA index_list(tasks)`).all() as Array<{ name: string }>).map((i) => i.name);

test("a schema 39 database gains the column and its index, keeps its rows, and reopens", () => {
  assert.ok(CURRENT_DATABASE_SCHEMA_VERSION >= 40);
  // Build the current schema, then take schema 40 away again: what a 39 file looked like.
  openDb();
  upsertTask(mkTask({ id: "older", workUnitId: null, status: "backlog", worktreePath: null }));
  closeDb();
  const old = new DatabaseSync(dbPath);
  old.exec("DROP INDEX idx_tasks_work_unit");
  old.exec("ALTER TABLE tasks DROP COLUMN work_unit_id");
  old.exec("PRAGMA user_version = 39");
  old.close();

  const upgraded = openDb();
  assert.equal(
    (upgraded.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    CURRENT_DATABASE_SCHEMA_VERSION,
  );
  assert.ok(columns(upgraded).includes("work_unit_id"));
  assert.ok(indexes(upgraded).includes("idx_tasks_work_unit"));
  // No backfill: nothing is inferred for a task that predates the column (decision D3).
  assert.equal(getTask("older")?.workUnitId, null);
  closeDb();
  openDb(); // idempotent: nothing to add the second time
  assert.equal(getTask("older")?.workUnitId, null);
});

test("no write changes a stored id, and a stale null never erases one", () => {
  const first = mintWorkUnitId();
  upsertTask(mkTask({ id: "write-once", workUnitId: first }));
  upsertTask({ ...getTask("write-once")!, workUnitId: mintWorkUnitId(), title: "renamed" });
  assert.equal(getTask("write-once")?.workUnitId, first);
  assert.equal(getTask("write-once")?.title, "renamed", "the rest of the write still lands");
  upsertTask({ ...getTask("write-once")!, workUnitId: null, title: "stale copy" });
  assert.equal(getTask("write-once")?.workUnitId, first);
  assert.equal(getTask("write-once")?.title, "stale copy");
});

test("a row with none can be given one, once", () => {
  upsertTask(mkTask({ id: "set-once", workUnitId: null }));
  assert.equal(getTask("set-once")?.workUnitId, null);
  const given = mintWorkUnitId();
  upsertTask({ ...getTask("set-once")!, workUnitId: given });
  assert.equal(getTask("set-once")?.workUnitId, given);
  upsertTask({ ...getTask("set-once")!, workUnitId: mintWorkUnitId() });
  assert.equal(getTask("set-once")?.workUnitId, given);
});

test("two claims on one task: the first write is kept and both read it back", () => {
  upsertTask(mkTask({ id: "contended", workUnitId: null }));
  const a = mintWorkUnitId();
  const b = mintWorkUnitId();
  assert.notEqual(a, b);
  assert.equal(claimTaskWorkUnitId("contended", a), a);
  assert.equal(claimTaskWorkUnitId("contended", b), a, "the second claim uses the stored id, not its own");
  assert.equal(storedTaskWorkUnitId("contended"), a);
  assert.equal(claimTaskWorkUnitId("no-such-task", b), null);
  assert.throws(() => claimTaskWorkUnitId("contended", "wu_not-an-id"), TypeError);
});

test("a malformed stored value reads as no work unit", () => {
  upsertTask(mkTask({ id: "hand-edited", workUnitId: null }));
  openDb().prepare(`UPDATE tasks SET work_unit_id = 'wu_lowercase' WHERE id = 'hand-edited'`).run();
  assert.equal(getTask("hand-edited")?.workUnitId, null);
  assert.equal(storedTaskWorkUnitId("hand-edited"), null);
});
