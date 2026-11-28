import { test, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./temp-root.mjs";

// How many times creating a fresh schema commits, and so how many times it syncs the WAL.
//
// Every daemon boot on a new state home pays this before it can listen, and every e2e test
// boots one. Under WAL with the default `synchronous=FULL` each commit is a disk sync: with one
// commit per table and index, a synthetic run on ext4 took 1784 ms against 15 ms in one
// transaction.

const home = tempDir("mission-schema-commits-");
process.env.HARNESS_HOME = join(home, "state");

const { CURRENT_DATABASE_SCHEMA_VERSION, upgradeDatabaseToCurrentSchema } = await import("../src/server/db.ts");

after(() => rmSync(home, { recursive: true, force: true }));

function freshDatabase(): { d: DatabaseSync; path: string } {
  const path = join(home, `fresh-${Math.random().toString(36).slice(2)}.db`);
  const d = new DatabaseSync(path);
  // Keep every frame in the WAL, so the count below sees every commit the upgrade made.
  d.exec("PRAGMA wal_autocheckpoint = 0;");
  return { d, path };
}

/** Commit frames in a WAL file: a frame whose header records the database size after it. */
function walCommits(path: string): number {
  const wal = readFileSync(`${path}-wal`);
  const pageSize = wal.readUInt32BE(8);
  let commits = 0;
  for (let at = 32; at + 24 + pageSize <= wal.length; at += 24 + pageSize) {
    if (wal.readUInt32BE(at + 4) !== 0) commits++;
  }
  return commits;
}

test("a fresh database gains its whole schema without committing once per table", () => {
  const { d, path } = freshDatabase();
  upgradeDatabaseToCurrentSchema(d);
  const { tables } = d
    .prepare("SELECT count(*) AS tables FROM sqlite_schema WHERE type = 'table'")
    .get() as { tables: number };
  const commits = walCommits(path);
  d.close();
  assert.ok(tables > 100, `expected the full schema, found ${tables} tables`);
  assert.ok(
    commits < tables,
    `a fresh upgrade committed ${commits} times for ${tables} tables; each commit is a disk sync`,
  );
});

test("a CREATE that fails leaves no part of the schema behind and reports SQLite's error", () => {
  const { d } = freshDatabase();
  // Near the end of the schema, after a hundred other tables: `CREATE TABLE IF NOT EXISTS`
  // accepts the view as already present, and the index declared after it cannot be built on
  // a view.
  d.exec("CREATE VIEW file_comment_messages AS SELECT 1 AS thread_id, 1 AS created_at;");
  assert.throws(() => upgradeDatabaseToCurrentSchema(d), /views may not be indexed/);
  assert.equal(d.isTransaction, false);
  const names = d.prepare("SELECT name FROM sqlite_schema").all() as Array<{ name: string }>;
  d.close();
  assert.deepEqual(names.map((row) => row.name), ["file_comment_messages"]);
});

test("a failed schema upgrade preserves saved settings across reopen and can be retried", () => {
  const { d, path } = freshDatabase();
  const inspector = JSON.stringify({ enabled: false, mode: "dry-run" });
  const schemaSql = "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name";
  let originalSchema;
  try {
    // Unlike the empty-database failure case, this models an older install with operator
    // settings. The late CREATE failure must not change its durable schema or version.
    d.exec(`
      CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      PRAGMA user_version = 35;
      CREATE VIEW file_comment_messages AS SELECT 1 AS thread_id, 1 AS created_at;
    `);
    d.prepare("INSERT INTO app_config (key, value) VALUES ('inspector', ?)").run(inspector);
    originalSchema = d.prepare(schemaSql).all();

    assert.throws(() => upgradeDatabaseToCurrentSchema(d), /views may not be indexed/);
    assert.equal(d.isTransaction, false);
  } finally {
    d.close();
  }

  const reopened = new DatabaseSync(path);
  try {
    assert.deepEqual(reopened.prepare(schemaSql).all(), originalSchema);
    assert.equal(reopened.prepare("PRAGMA user_version").get()?.user_version, 35);
    assert.equal(reopened.prepare("SELECT value FROM app_config WHERE key = 'inspector'").get()?.value, inspector);

    // Once the conflicting object is removed, the same database must still be upgradeable,
    // without treating its existing settings as a fresh install's default.
    reopened.exec("DROP VIEW file_comment_messages;");
    upgradeDatabaseToCurrentSchema(reopened);
    assert.equal(reopened.isTransaction, false);
    assert.equal(reopened.prepare("PRAGMA user_version").get()?.user_version, CURRENT_DATABASE_SCHEMA_VERSION);
    assert.equal(reopened.prepare("SELECT type FROM sqlite_schema WHERE name = 'file_comment_messages'").get()?.type, "table");
    assert.equal(reopened.prepare("SELECT value FROM app_config WHERE key = 'inspector'").get()?.value, inspector);
    assert.equal(reopened.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
    assert.deepEqual(reopened.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    reopened.close();
  }
});
