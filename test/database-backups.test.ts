import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  DatabaseBackupService,
  validateDatabaseBackupForRestore,
} from "../src/server/database-backups/service.ts";
import { startDatabaseBackupLoop } from "../src/server/database-backups/loop.ts";
import { verifyDatabaseBackupForRestore } from "../src/server/database-backups/restore.ts";
import { CURRENT_DATABASE_SCHEMA_VERSION } from "../src/server/db.ts";

function fixture(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return root;
}

function openWalDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE recovery_probe (value TEXT NOT NULL);
    PRAGMA wal_checkpoint(TRUNCATE);
    INSERT INTO recovery_probe VALUES ('committed-in-wal');
  `);
  return db;
}

test("online snapshots include committed WAL pages that a main-file copy loses", async (t) => {
  const root = fixture("mission-database-backup-wal-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourcePath = join(root, "harness.db");
  const source = openWalDatabase(sourcePath);
  t.after(() => source.close());
  assert.equal(existsSync(`${sourcePath}-wal`), true);
  const sourceBefore = statSync(sourcePath);

  const unsafeCopy = join(root, "unsafe-copy.db");
  copyFileSync(sourcePath, unsafeCopy);
  const copied = new DatabaseSync(unsafeCopy, { readOnly: true });
  assert.deepEqual(copied.prepare("SELECT value FROM recovery_probe").all(), []);
  copied.close();

  const service = new DatabaseBackupService(source, { root: join(root, "backups") });
  const snapshot = await service.captureScheduled();
  const backup = new DatabaseSync(snapshot.path, { readOnly: true });
  assert.deepEqual(
    backup
      .prepare("SELECT value FROM recovery_probe")
      .all()
      .map((row) => (row as { value: string }).value),
    ["committed-in-wal"],
  );
  backup.close();
  assert.equal(validateDatabaseBackupForRestore(snapshot.path).integrity, "ok");
  const sourceAfter = statSync(sourcePath);
  assert.equal(sourceAfter.uid, sourceBefore.uid);
  assert.equal(sourceAfter.mode & 0o777, sourceBefore.mode & 0o777);
  assert.equal(statSync(snapshot.path).mode & 0o777, 0o600);
  assert.equal(statSync(join(root, "backups")).mode & 0o777, 0o700);
});

test("scheduled and pre-migration generations have independent bounded retention", async (t) => {
  const root = fixture("mission-database-backup-retention-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = new DatabaseSync(join(root, "harness.db"));
  t.after(() => source.close());
  source.exec("CREATE TABLE recovery_probe (value TEXT NOT NULL)");
  let now = Date.UTC(2026, 7, 30, 12, 0, 0);
  const service = new DatabaseBackupService(source, {
    root: join(root, "backups"),
    retention: { scheduled: 2, preMigration: 1 },
    now: () => new Date(now++),
  });

  await service.captureScheduled();
  await service.captureScheduled();
  await service.captureScheduled();
  service.capturePreMigration();
  service.capturePreMigration();

  const names = readdirSync(join(root, "backups"));
  assert.equal(names.filter((name) => name.startsWith("scheduled-")).length, 2);
  assert.equal(names.filter((name) => name.startsWith("pre-migration-")).length, 1);
  assert.equal(names.some((name) => name.includes(".tmp")), false);
});

test("restore validation rejects corruption without changing healthy live state", async (t) => {
  const root = fixture("mission-database-backup-corrupt-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = new DatabaseSync(join(root, "harness.db"));
  t.after(() => source.close());
  source.exec("CREATE TABLE recovery_probe (value TEXT NOT NULL); INSERT INTO recovery_probe VALUES ('before')");
  const service = new DatabaseBackupService(source, { root: join(root, "backups") });
  const snapshot = await service.captureScheduled();
  source.exec("UPDATE recovery_probe SET value = 'healthy-live'");
  writeFileSync(snapshot.path, Buffer.from("not a sqlite database", "utf8"));

  assert.throws(
    () => validateDatabaseBackupForRestore(snapshot.path),
    /not a valid SQLite database backup|integrity/i,
  );
  assert.equal(
    (source.prepare("SELECT value FROM recovery_probe").get() as { value: string }).value,
    "healthy-live",
  );
});

test("restore validation forward-migrates a disposable copy and leaves the candidate read-only", async (t) => {
  const root = fixture("mission-database-backup-restore-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = new DatabaseSync(join(root, "harness.db"));
  t.after(() => source.close());
  source.exec("CREATE TABLE recovery_probe (value TEXT NOT NULL); INSERT INTO recovery_probe VALUES ('recoverable')");
  const service = new DatabaseBackupService(source, { root: join(root, "backups") });
  const snapshot = await service.captureScheduled();

  const before = readFileSync(snapshot.path);
  const result = await verifyDatabaseBackupForRestore(snapshot.path);
  assert.equal(result.integrity, "ok");
  assert.equal(result.tableCount, 1);
  assert.equal(result.currentBuildIntegrity, "ok");
  assert.ok(result.currentBuildTableCount > result.tableCount);
  assert.deepEqual(readFileSync(snapshot.path), before, "validation must not mutate the candidate");
});

test("startup captures the WAL-consistent database before schema creation and migration", (t) => {
  const home = fixture("mission-database-backup-startup-");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const sourcePath = join(home, "harness.db");
  const source = openWalDatabase(sourcePath);
  t.after(() => source.close());

  const openArgs = [
    "--import",
    "tsx",
    "--input-type=module",
    "-e",
    "const { openDb } = await import('./src/server/db.ts'); const db = openDb(); db.close();",
  ];
  const child = spawnSync(process.execPath, openArgs, {
      cwd: process.cwd(),
      env: { ...process.env, MISSION_HOME: home },
      encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr);

  const backupRoot = join(home, "backups", "database");
  const names = readdirSync(backupRoot).filter((name) => name.startsWith("pre-migration-"));
  assert.equal(names.length, 1);
  const recovery = new DatabaseSync(join(backupRoot, names[0]!), { readOnly: true });
  assert.deepEqual(
    recovery
      .prepare("SELECT value FROM recovery_probe")
      .all()
      .map((row) => (row as { value: string }).value),
    ["committed-in-wal"],
  );
  assert.equal(
    (recovery.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name = 'reviews'").get() as { count: number }).count,
    0,
    "the recovery point must precede current schema creation",
  );
  recovery.close();

  const migrated = new DatabaseSync(sourcePath, { readOnly: true });
  assert.equal(
    (migrated.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name = 'reviews'").get() as { count: number }).count,
    1,
  );
  assert.equal(
    (migrated.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    CURRENT_DATABASE_SCHEMA_VERSION,
  );
  migrated.close();

  const restarted = spawnSync(process.execPath, openArgs, {
    cwd: process.cwd(),
    env: { ...process.env, MISSION_HOME: home },
    encoding: "utf8",
  });
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.deepEqual(
    readdirSync(backupRoot).filter((name) => name.startsWith("pre-migration-")),
    names,
    "an ordinary restart must not consume another pre-migration retention slot",
  );
});

test("startup stops before migrations when it cannot create a recovery point", (t) => {
  const home = fixture("mission-database-backup-startup-failure-");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const sourcePath = join(home, "harness.db");
  const source = new DatabaseSync(sourcePath);
  source.exec("CREATE TABLE legacy_only (value TEXT NOT NULL)");
  source.close();
  writeFileSync(join(home, "backups"), "blocks the backup directory");

  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      "const { openDb } = await import('./src/server/db.ts'); try { openDb(); } catch (error) { console.error(String(error)); process.exit(42); }",
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, MISSION_HOME: home },
      encoding: "utf8",
    },
  );
  assert.equal(child.status, 42, child.stderr);
  assert.match(child.stderr, /stopped before migrations.*recovery backup failed/i);
  const untouched = new DatabaseSync(sourcePath, { readOnly: true });
  assert.equal(
    (untouched.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name = 'reviews'").get() as { count: number }).count,
    0,
  );
  assert.equal(
    (untouched.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    0,
    "a failed recovery boundary must leave the migration pending",
  );
  untouched.close();
});

test("the recurring loop waits one interval, contains failures, and never overlaps", async () => {
  let calls = 0;
  let reject: (error: Error) => void = () => { throw new Error("capture did not start"); };
  let scheduled: (() => void) | undefined;
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    const stop = startDatabaseBackupLoop(
      {
        captureScheduled: () => {
          calls += 1;
          return new Promise((_, rejectCapture) => { reject = rejectCapture; }) as never;
        },
      },
      {
        intervalMs: 123,
        setTimer: (callback, delayMs) => {
          assert.equal(delayMs, 123);
          scheduled = callback;
          return { unref() {} };
        },
        clearTimer: () => undefined,
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 0, "startup must not compete with scheduled backup I/O");
    assert.ok(scheduled, "the first capture must be scheduled");
    const firstTick = scheduled;
    scheduled = undefined;
    firstTick();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    assert.equal(scheduled, undefined, "no timer is armed while capture is in flight");
    reject(new Error("disk unavailable"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(warnings.length, 1);
    assert.ok(scheduled);
    await stop();
  } finally {
    console.warn = originalWarn;
  }
});
