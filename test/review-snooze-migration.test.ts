import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { tempDir } from "./temp-root.mjs";

// A version-33 database, written before "Remind me later": the real schema, made in a child
// process by this build, then wound back to what a version-33 daemon left on disk - the reviews
// table without its snooze columns, holding one open question.
const home = tempDir("mission-review-snooze-migration-");
process.env.MISSION_HOME = home;
execFileSync(process.execPath, ["--import", "tsx", "-e", "await import(process.env.DB_MODULE).then(m => m.openDb())"], {
  env: { ...process.env, DB_MODULE: new URL("../src/server/db.ts", import.meta.url).href }, stdio: "pipe",
});
const SNOOZE_COLUMNS = [
  "snoozable",
  "snoozed_at",
  "snoozed_until",
  "snooze_mode",
  "snooze_option_id",
  "snooze_reminded_at",
  "snooze_instruction_owed_at",
  "snooze_instruction_queued_at",
];
const old = new DatabaseSync(join(home, "harness.db"));
old.exec(`${SNOOZE_COLUMNS.map((column) => `ALTER TABLE reviews DROP COLUMN ${column};`).join("\n")}
  INSERT INTO reviews (id, session_id, kind, title, body, status, response, created_at, resolved_at)
  VALUES ('open-question', 'sdk:s', 'input', 'Which path?', 'Which path?', 'pending', NULL, 100, NULL);
  PRAGMA user_version = 33`);
old.close();
const db = await import("../src/server/db.ts");
after(() => rmSync(home, { recursive: true, force: true }));

test("version 33 upgrade captures recovery before adding the snooze columns, and old questions read as never snoozed", () => {
  const d = db.openDb();
  const columns = new Set((d.prepare("PRAGMA table_info(reviews)").all() as Array<{ name: string }>).map((c) => c.name));
  for (const column of SNOOZE_COLUMNS) assert.ok(columns.has(column), column);
  assert.equal((d.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, db.CURRENT_DATABASE_SCHEMA_VERSION);
  assert.ok(db.CURRENT_DATABASE_SCHEMA_VERSION >= 34);

  const backupRoot = join(home, "backups", "database");
  const backups = existsSync(backupRoot) ? readdirSync(backupRoot).filter((name) => name.startsWith("pre-migration-")) : [];
  assert.equal(backups.length, 1, "the version-33 database needs a recovery point before migration");
  const recovery = new DatabaseSync(join(backupRoot, backups[0]!), { readOnly: true });
  try {
    assert.equal((recovery.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 33);
    const recovered = (recovery.prepare("PRAGMA table_info(reviews)").all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(!recovered.includes("snoozed_until"), "the recovery point is the database as it was");
  } finally {
    recovery.close();
  }

  const question = db.loadPendingReviews().find((r) => r.id === "open-question");
  assert.equal(question?.status, "pending");
  assert.equal(question?.snoozable, undefined, "an older question does not offer Remind me later");
  assert.equal(question?.snooze, undefined, "and was never snoozed");

  db.closeDb();
  db.openDb();
  assert.deepEqual(
    readdirSync(backupRoot).filter((name) => name.startsWith("pre-migration-")),
    backups,
    "reopening at the current version must not capture again",
  );
});
