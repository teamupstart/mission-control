import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What this proves is IDEMPOTENCY, not an upgrade path, and the distinction is the point: a
// NEW table needs no `migrate()` entry, because the schema literal runs on every open, before
// `migrate()`. What it therefore has to survive is being opened again, and again - including
// its partial unique index, which is NOT in the literal (its predicate is derived from a
// TypeScript tuple) and so is the one piece an "it's all in the CREATE" reading would miss.

const home = mkdtempSync(join(tmpdir(), "mission-file-comments-migration-"));

after(() => rmSync(home, { recursive: true, force: true }));

function run(script: string): string {
  return execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    {
      cwd: process.cwd(),
      env: { ...process.env, FILE_COMMENTS_MIGRATION_HOME: home },
      encoding: "utf8",
    },
  ).trim();
}

const TABLES = ["file_comment_threads", "file_comment_messages", "file_comment_reviews"];

test("dropping the tables in one process brings them back in the next, repeatedly", () => {
  run(`
    process.env.HARNESS_HOME = process.env.FILE_COMMENTS_MIGRATION_HOME;
    const { openDb } = await import("./src/server/db.ts");
    const db = openDb();
    ${TABLES.map((t) => `db.exec("DROP TABLE ${t}");`).join("\n    ")}
    db.close();
  `);

  const inspect = `
    process.env.HARNESS_HOME = process.env.FILE_COMMENTS_MIGRATION_HOME;
    const { openDb } = await import("./src/server/db.ts");
    const db = openDb();
    const names = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'file_comment%' ORDER BY name"
    ).all().map((r) => r.name);
    process.stdout.write(names.join(","));
    db.close();
  `;
  const expected = [...TABLES].sort().join(",");
  assert.equal(run(inspect), expected);
  assert.equal(run(inspect), expected, "a second pass keeps the tables");
});

test("the derived single-flight index is rebuilt with them, and its predicate is exact", () => {
  // The index lives OUTSIDE the schema literal because its WHERE clause is built from
  // `OUTSTANDING_THREAD_STATUSES`. `CREATE UNIQUE INDEX IF NOT EXISTS` leaves an existing
  // index untouched, so this is also what would catch a build whose tuple had drifted from
  // the database's stored predicate - the exact drift the shared constant exists to prevent.
  const sql = run(`
    process.env.HARNESS_HOME = process.env.FILE_COMMENTS_MIGRATION_HOME;
    const { openDb } = await import("./src/server/db.ts");
    const db = openDb();
    const row = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='index' AND name='one_outstanding_file_comment'"
    ).get();
    process.stdout.write(row?.sql ?? "missing");
    db.close();
  `);
  assert.match(sql, /ON file_comment_threads\(session_id\)/);
  assert.match(sql, /'sending'/);
  assert.match(sql, /'awaiting'/);
  // `unanswered` must NOT be in it: decision 3 auto-advances, so a timed-out thread left in
  // the outstanding set would deadlock the queue the index exists to protect.
  assert.equal(/'unanswered'/.test(sql), false);
});

test("a stale predicate is rebuilt on the next open rather than enforced for ever", () => {
  // The upgrade half of the same rule. Replace the index with an older, narrower predicate
  // and re-open: the daemon must notice and rebuild, not go on enforcing `sending` alone
  // while every TypeScript reader uses both statuses.
  run(`
    process.env.HARNESS_HOME = process.env.FILE_COMMENTS_MIGRATION_HOME;
    const { openDb } = await import("./src/server/db.ts");
    const db = openDb();
    db.exec("DROP INDEX one_outstanding_file_comment");
    db.exec("CREATE UNIQUE INDEX one_outstanding_file_comment ON file_comment_threads(session_id) WHERE status IN ('sending')");
    db.close();
  `);
  const sql = run(`
    process.env.HARNESS_HOME = process.env.FILE_COMMENTS_MIGRATION_HOME;
    const { openDb } = await import("./src/server/db.ts");
    const db = openDb();
    const row = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='index' AND name='one_outstanding_file_comment'"
    ).get();
    process.stdout.write(row?.sql ?? "missing");
    db.close();
  `);
  assert.match(sql, /'awaiting'/);
});
