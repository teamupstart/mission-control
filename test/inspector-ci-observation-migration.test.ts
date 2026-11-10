import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A database stamped 26 predates `observed_ci_json`, so opening it must take a recovery point
// before the column is added; without the version bump it would be added with no backup.

const home = mkdtempSync(join(tmpdir(), "mission-inspector-ci-observation-migration-"));
process.env.MISSION_HOME = home;

const raw = new DatabaseSync(join(home, "harness.db"));
raw.exec(`
  CREATE TABLE IF NOT EXISTS inspector_prs (
    key TEXT PRIMARY KEY, url TEXT NOT NULL, owner TEXT NOT NULL, repo TEXT NOT NULL,
    number INTEGER NOT NULL, source TEXT NOT NULL, state TEXT NOT NULL
  );
  INSERT INTO inspector_prs (key, url, owner, repo, number, source, state)
    VALUES ('owner/repo#7', 'https://github.com/owner/repo/pull/7', 'owner', 'repo', 7, 'manual', 'watching');
  PRAGMA user_version = 26;
`);
raw.close();

const { openDb, upgradeDatabaseToCurrentSchema, CURRENT_DATABASE_SCHEMA_VERSION } = await import("../src/server/db.ts");
after(() => rmSync(home, { recursive: true, force: true }));

const backupRoot = join(home, "backups", "database");
const recoveryPoints = () =>
  existsSync(backupRoot) ? readdirSync(backupRoot).filter((name) => name.startsWith("pre-migration-")) : [];

test("a schema 26 database takes a recovery point, then gains a NULL observed_ci_json", () => {
  assert.equal(CURRENT_DATABASE_SCHEMA_VERSION, 27);
  const d = openDb();
  const backups = recoveryPoints();
  assert.equal(backups.length, 1);
  const recovery = new DatabaseSync(join(backupRoot, backups[0]!), { readOnly: true });
  try {
    assert.equal((recovery.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 26);
  } finally {
    recovery.close();
  }
  const columns = (d.prepare("PRAGMA table_info(inspector_prs)").all() as { name: string }[]).map((c) => c.name);
  assert.ok(columns.includes("observed_ci_json"));
  assert.equal((d.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 27);
  const row = d.prepare("SELECT observed_ci_json FROM inspector_prs WHERE key = 'owner/repo#7'").get() as {
    observed_ci_json: string | null;
  };
  assert.equal(row.observed_ci_json, null);
});

test("upgrading again takes no second recovery point", () => {
  const before = recoveryPoints();
  upgradeDatabaseToCurrentSchema(openDb());
  assert.deepEqual(recoveryPoints(), before);
});
