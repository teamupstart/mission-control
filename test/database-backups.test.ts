import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";
import {
  DATABASE_BACKUP_RETENTION,
  DatabaseBackupService,
  validateDatabaseBackupForRestore,
} from "../src/server/database-backups/service.ts";
import {
  DATABASE_BACKUP_WAKE_MS,
  startDatabaseBackupLoop,
} from "../src/server/database-backups/loop.ts";
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

const SEED_PREFIX = { scheduled: "scheduled", preMigration: "pre-migration", manual: "manual" };

/**
 * Plant `count` hourly copies of a kind dated in 2020, oldest first, so every real capture
 * sorts newer.
 * The content is never opened: prune decides by name alone.
 */
function seedCopies(
  backupRoot: string,
  kind: keyof typeof SEED_PREFIX,
  count: number,
): string[] {
  mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  const names: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const stamp = new Date(Date.UTC(2020, 0, 1) + index * 3_600_000).toISOString().replace(/[-:.]/g, "");
    const name = `${SEED_PREFIX[kind]}-${stamp}-${String(index).padStart(32, "a")}.sqlite3`;
    writeFileSync(join(backupRoot, name), "seeded copy");
    names.push(name);
  }
  return names;
}

function kept(backupRoot: string, prefix: string): string[] {
  return readdirSync(backupRoot).filter((name) => name.startsWith(`${prefix}-`) && name.endsWith(".sqlite3")).sort();
}

function storeBackupsConfig(db: DatabaseSync, value: string): void {
  db.exec("CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.prepare(
    "INSERT INTO app_config (key, value) VALUES ('backups', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(value);
}

test("the default retention is the shared schema default: 3 hourly and 2 pre-migration", () => {
  assert.deepEqual({ ...DATABASE_BACKUP_RETENTION }, { scheduled: 3, preMigration: 2 });
});

test("with default config a capture leaves 3 hourly, 2 pre-migration and the newest manual copy", async (t) => {
  const root = fixture("mission-database-backup-defaults-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const backupRoot = join(root, "backups");
  const source = new DatabaseSync(join(root, "harness.db"));
  t.after(() => source.close());
  source.exec("CREATE TABLE recovery_probe (value TEXT NOT NULL)");
  // The audited machine: 24 hourly copies under the old fixed limit.
  const scheduled = seedCopies(backupRoot, "scheduled", 9);
  const preMigration = seedCopies(backupRoot, "preMigration", 5);
  const manual = seedCopies(backupRoot, "manual", 3);
  const service = new DatabaseBackupService(source, { root: backupRoot });

  const capture = await service.captureScheduled();

  assert.deepEqual(kept(backupRoot, "scheduled"), [...scheduled.slice(-2), capture.filename].sort());
  assert.deepEqual(kept(backupRoot, "pre-migration"), preMigration.slice(-2));
  assert.deepEqual(kept(backupRoot, "manual"), manual.slice(-1), "manual copies are outside the hourly limit");
});

test("saved counts change what prune keeps, and a malformed value reads as the default", async (t) => {
  const root = fixture("mission-database-backup-saved-counts-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const backupRoot = join(root, "backups");
  const source = new DatabaseSync(join(root, "harness.db"));
  t.after(() => source.close());
  const service = new DatabaseBackupService(source, { root: backupRoot });

  seedCopies(backupRoot, "scheduled", 9);
  seedCopies(backupRoot, "preMigration", 9);
  storeBackupsConfig(source, JSON.stringify({ scheduledCount: 6, preMigrationCount: 4, intervalHours: 6 }));
  await service.captureScheduled();
  assert.equal(kept(backupRoot, "scheduled").length, 6);
  assert.equal(kept(backupRoot, "pre-migration").length, 4);

  storeBackupsConfig(source, JSON.stringify({ scheduledCount: 0 }));
  service.prune();
  assert.equal(kept(backupRoot, "scheduled").length, 3, "an out-of-range stored count falls back");
  assert.equal(kept(backupRoot, "pre-migration").length, 2);
});

test("prune deletes copies above a lowered limit with their sidecars", (t) => {
  const root = fixture("mission-database-backup-startup-prune-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const backupRoot = join(root, "backups");
  const source = new DatabaseSync(join(root, "harness.db"));
  t.after(() => source.close());
  const scheduled = seedCopies(backupRoot, "scheduled", 4);
  const expired = join(backupRoot, scheduled[0]!);
  const survivor = join(backupRoot, scheduled[3]!);
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    writeFileSync(`${expired}${suffix}`, "sidecar");
    writeFileSync(`${survivor}${suffix}`, "sidecar");
  }
  writeFileSync(join(backupRoot, "unrelated.sqlite3"), "not owned");
  storeBackupsConfig(source, JSON.stringify({ scheduledCount: 1 }));

  new DatabaseBackupService(source, { root: backupRoot }).prune();

  assert.deepEqual(readdirSync(backupRoot).sort(), [
    scheduled[3]!,
    `${scheduled[3]!}-journal`,
    `${scheduled[3]!}-shm`,
    `${scheduled[3]!}-wal`,
    "unrelated.sqlite3",
  ].sort());
});

test("prune on a fresh home with no backup directory does nothing", (t) => {
  const root = fixture("mission-database-backup-no-root-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = new DatabaseSync(":memory:");
  t.after(() => source.close());
  new DatabaseBackupService(source, { root: join(root, "backups") }).prune();
  assert.equal(existsSync(join(root, "backups")), false);
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

function openDbAt(home: string): ReturnType<typeof spawnSync> {
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      "const { openDb } = await import('./src/server/db.ts'); openDb().close();",
    ],
    { cwd: process.cwd(), env: { ...process.env, MISSION_HOME: home }, encoding: "utf8" },
  );
}

for (const [label, storedValue, expected] of [
  ["keeps the stored preMigrationCount", JSON.stringify({ preMigrationCount: 4 }), 4],
  ["falls back to the default when app_config is missing", null, 2],
  ["falls back to the default when the stored value is not JSON", "{not json", 2],
  ["falls back to the default when the stored count is out of range", JSON.stringify({ preMigrationCount: 0 }), 2],
] as const) {
  test(`openDb's pre-migration copy ${label}`, (t) => {
    const home = fixture("mission-database-backup-open-retention-");
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const legacy = new DatabaseSync(join(home, "harness.db"));
    legacy.exec("CREATE TABLE legacy_only (value TEXT NOT NULL)");
    if (storedValue !== null) storeBackupsConfig(legacy, storedValue);
    legacy.close();
    const backupRoot = join(home, "backups", "database");
    const seeded = seedCopies(backupRoot, "preMigration", 6);

    const child = openDbAt(home);
    assert.equal(child.status, 0, String(child.stderr));

    const names = kept(backupRoot, "pre-migration");
    assert.equal(names.length, expected);
    assert.deepEqual(names.slice(0, -1), seeded.slice(-(expected - 1)), "the newest copies are the ones kept");
  });
}

const idleTimers = {
  setTimer: () => ({ unref() {} }),
  clearTimer: () => undefined,
};

test("starting the backup loop prunes 24 hourly copies to 3 before any capture", async (t) => {
  const root = fixture("mission-database-backup-loop-start-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const backupRoot = join(root, "backups");
  const source = new DatabaseSync(join(root, "harness.db"));
  t.after(() => source.close());
  const scheduled = seedCopies(backupRoot, "scheduled", 24);
  const service = new DatabaseBackupService(source, { root: backupRoot });
  let captures = 0;

  const stop = startDatabaseBackupLoop(
    {
      captureScheduled: () => {
        captures += 1;
        return service.captureScheduled();
      },
      prune: () => service.prune(),
      scheduledDue: () => service.scheduledDue(),
    },
    idleTimers,
  );
  t.after(stop);

  assert.equal(captures, 0);
  assert.deepEqual(kept(backupRoot, "scheduled"), scheduled.slice(-3));
});

test("a prune that throws at loop start only warns, and the loop still schedules", async () => {
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  let armed = 0;
  try {
    const stop = startDatabaseBackupLoop(
      {
        captureScheduled: () => Promise.reject(new Error("not reached")),
        prune: () => { throw new Error("backup root is a symlink"); },
        scheduledDue: () => false,
      },
      { ...idleTimers, setTimer: () => { armed += 1; return { unref() {} }; } },
    );
    assert.equal(armed, 1, "the first capture is still scheduled");
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0]![0]), /database backup prune failed: backup root is a symlink/);
    await stop();
  } finally {
    console.warn = originalWarn;
  }
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * A backup loop on an injected wall clock and timers. `wake()` advances the clock by one wake
 * interval, fires the loop's timer, and resolves once the tick has finished and re-armed.
 * `restart()` stops the loop and starts a fresh service and loop on the same database, as a
 * daemon restart does, keeping the clock where it is.
 */
function wallClockLoop(t: test.TestContext, options: { intervalHours?: number } = {}) {
  // Every injected failure is logged by the loop; the assertions read the status record.
  t.mock.method(console, "warn", () => undefined);
  const root = fixture("mission-database-backup-wall-clock-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const backupRoot = join(root, "backups");
  const source = new DatabaseSync(join(root, "harness.db"));
  t.after(() => source.close());
  source.exec("CREATE TABLE recovery_probe (value TEXT NOT NULL)");
  storeBackupsConfig(source, JSON.stringify({ intervalHours: options.intervalHours ?? 1 }));

  const state = {
    clock: Date.UTC(2026, 9, 27, 12),
    failing: false,
    /** Every online capture's clock time, scheduled and manual alike. */
    attempts: [] as number[],
  };
  const newService = () => new DatabaseBackupService(source, {
    root: backupRoot,
    now: () => new Date(state.clock),
    onlineBackup: async (db, destination) => {
      state.attempts.push(state.clock);
      if (state.failing) throw new Error("ENOSPC: no space left on device");
      await sqliteBackup(db, destination);
    },
  });
  let service = newService();
  let pending: (() => void) | null = null;
  let armed: () => void = () => undefined;
  const start = () => startDatabaseBackupLoop(service, {
    setTimer: (callback, delayMs) => {
      assert.equal(delayMs, DATABASE_BACKUP_WAKE_MS);
      pending = callback;
      armed();
      return { unref() {} };
    },
    clearTimer: () => { pending = null; },
  });
  let stop = start();
  t.after(() => stop());

  return {
    state,
    backupRoot,
    get service() { return service; },
    seedScheduled(at: number, index: number): string {
      mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
      const stamp = new Date(at).toISOString().replace(/[-:.]/g, "");
      const name = `scheduled-${stamp}-${String(index).padStart(32, "c")}.sqlite3`;
      writeFileSync(join(backupRoot, name), "seeded copy");
      return name;
    },
    async wake(): Promise<void> {
      state.clock += DATABASE_BACKUP_WAKE_MS;
      const callback = pending;
      assert.ok(callback, "the loop must have armed its next wake");
      pending = null;
      const rearmed = new Promise<void>((resolve) => { armed = resolve; });
      callback();
      await rearmed;
    },
    async restart(): Promise<void> {
      await stop();
      service = newService();
      stop = start();
    },
    /** Wake until `count` more online captures have been attempted. */
    async wakeUntilAttempts(count: number): Promise<void> {
      const target = state.attempts.length + count;
      for (let wakes = 0; state.attempts.length < target; wakes += 1) {
        assert.ok(wakes < 2_000, "the expected attempts never came");
        await this.wake();
      }
    },
  };
}

function gapsInMinutes(times: number[]): number[] {
  return times.slice(1).map((at, index) => (at - times[index]!) / MINUTE);
}

test("no capture runs before the first wake, 5 minutes after start, even with no copy at all", async (t) => {
  const loop = wallClockLoop(t);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(loop.state.attempts, [], "startup must not compete with scheduled backup I/O");

  const started = loop.state.clock;
  await loop.wake();
  assert.deepEqual(loop.state.attempts, [started + 5 * MINUTE]);
  assert.equal(kept(loop.backupRoot, "scheduled").length, 1);
});

test("a restart 50 minutes after the newest copy captures about 10 minutes later, not 60", async (t) => {
  const loop = wallClockLoop(t);
  loop.seedScheduled(loop.state.clock - 50 * MINUTE, 1);
  const restartedAt = loop.state.clock;

  await loop.wake();
  assert.deepEqual(loop.state.attempts, [], "55 minutes after the newest copy is not yet due");
  await loop.wake();
  assert.deepEqual(loop.state.attempts, [restartedAt + 10 * MINUTE]);
  await loop.wake();
  assert.equal(loop.state.attempts.length, 1, "the new copy restarts the interval");
});

test("a forward wall-clock jump past the interval captures at the next wake", async (t) => {
  const loop = wallClockLoop(t);
  await loop.wake();
  assert.equal(loop.state.attempts.length, 1);
  await loop.wake();
  assert.equal(loop.state.attempts.length, 1);

  loop.state.clock += 3 * HOUR;
  await loop.wake();
  assert.equal(loop.state.attempts.length, 2);
});

test("a copy dated 2 hours in the future is ignored by the due check and pruned first", async (t) => {
  const loop = wallClockLoop(t);
  const future = loop.seedScheduled(loop.state.clock + 2 * HOUR, 1);
  const older = [
    loop.seedScheduled(loop.state.clock - 3 * HOUR, 2),
    loop.seedScheduled(loop.state.clock - 2 * HOUR, 3),
  ];

  await loop.wake();
  assert.equal(loop.state.attempts.length, 1, "the future copy must not postpone a capture");
  const scheduled = kept(loop.backupRoot, "scheduled");
  assert.equal(scheduled.length, 3);
  assert.equal(scheduled.includes(future), false, "the future-dated copy is the first one expired");
  assert.deepEqual(scheduled.filter((name) => older.includes(name)), older);

  await loop.wake();
  assert.equal(loop.state.attempts.length, 1, "the fresh copy is not captured again on the next wake");
});

test("only a copy more than 1 minute in the future is ignored by the due check and pruned first", (t) => {
  // 30 seconds ahead is inside the tolerance: it is the newest copy, so nothing is due, and
  // prune keeps it while expiring the genuinely oldest copy.
  const near = wallClockLoop(t);
  const nearCopy = near.seedScheduled(near.state.clock + 30_000, 1);
  const nearOldest = near.seedScheduled(near.state.clock - 5 * HOUR, 2);
  near.seedScheduled(near.state.clock - 4 * HOUR, 3);
  near.seedScheduled(near.state.clock - 3 * HOUR, 4);
  assert.equal(near.service.scheduledDue(), false);
  near.service.prune();
  const nearKept = kept(near.backupRoot, "scheduled");
  assert.equal(nearKept.includes(nearCopy), true, "a copy 30 s ahead is not ranked oldest");
  assert.equal(nearKept.includes(nearOldest), false);

  // 2 minutes ahead is past the tolerance: it is ignored, so a capture is due, and it is the
  // first copy prune expires.
  const far = wallClockLoop(t);
  const farCopy = far.seedScheduled(far.state.clock + 2 * MINUTE, 1);
  const farOldest = far.seedScheduled(far.state.clock - 4 * HOUR, 2);
  far.seedScheduled(far.state.clock - 3 * HOUR, 3);
  far.seedScheduled(far.state.clock - 2 * HOUR, 4);
  assert.equal(far.service.scheduledDue(), true);
  far.service.prune();
  const farKept = kept(far.backupRoot, "scheduled");
  assert.equal(farKept.includes(farCopy), false, "a copy 2 minutes ahead is pruned first");
  assert.equal(farKept.includes(farOldest), true);
});

test("a status write that fails never turns a capture's own outcome around", async (t) => {
  const warn = t.mock.method(console, "warn", () => undefined);
  const root = fixture("mission-database-backup-status-write-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const backupRoot = join(root, "backups");
  const source = new DatabaseSync(join(root, "harness.db"));
  t.after(() => source.close());
  source.exec("CREATE TABLE recovery_probe (value TEXT NOT NULL)");
  storeBackupsConfig(source, JSON.stringify({}));
  let failing = false;
  const service = new DatabaseBackupService(source, {
    root: backupRoot,
    onlineBackup: async (db, destination) => {
      if (failing) throw new Error("ENOSPC: no space left on device");
      await sqliteBackup(db, destination);
    },
  });
  source.exec(`
    CREATE TRIGGER refuse_insert BEFORE INSERT ON app_config BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;
    CREATE TRIGGER refuse_update BEFORE UPDATE ON app_config BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;
  `);

  const published = await service.captureScheduled();
  assert.deepEqual(kept(backupRoot, "scheduled"), [published.filename], "the copy is still published");
  const manual = await service.captureManual();
  assert.deepEqual(kept(backupRoot, "manual"), [manual.filename]);

  failing = true;
  await assert.rejects(service.captureScheduled(), /^Error: Scheduled database backup failed: ENOSPC/);

  const warnings = warn.mock.calls.map((call) => String(call.arguments[0]));
  assert.ok(warnings.length > 0);
  for (const warning of warnings) {
    assert.match(warning, /database backup status was not saved: disk I\/O error/);
  }
});

test("a backup root that cannot be prepared is a recorded scheduled failure that backs off", async (t) => {
  const loop = wallClockLoop(t);
  const elsewhere = join(loop.backupRoot, "..", "elsewhere");
  mkdirSync(elsewhere, { mode: 0o700 });
  symlinkSync(elsewhere, loop.backupRoot);
  const started = loop.state.clock;

  await loop.wake();
  const first = loop.service.status().scheduled;
  assert.equal(first.consecutiveFailures, 1, "the due check must not swallow the failure");
  assert.equal(first.failingSince, started + 5 * MINUTE);
  assert.equal(first.lastFailure?.kind, "scheduled");
  assert.match(first.lastFailure?.message ?? "", /must be a real directory/);

  const attempts = [first.lastAttemptAt];
  for (let wake = 0; wake < 6; wake += 1) {
    await loop.wake();
    const { lastAttemptAt } = loop.service.status().scheduled;
    if (lastAttemptAt !== attempts.at(-1)) attempts.push(lastAttemptAt);
  }
  assert.deepEqual(gapsInMinutes(attempts as number[]), [5, 10], "attempts follow the backoff");
  assert.equal(loop.service.status().scheduled.consecutiveFailures, 3);
  assert.deepEqual(loop.state.attempts, [], "no online backup ran into the symlinked root");
});

test("a future lastAttemptAt counts as now and does not lengthen the backoff", async (t) => {
  const loop = wallClockLoop(t);
  loop.state.failing = true;
  await loop.wake();
  assert.equal(loop.service.status().scheduled.consecutiveFailures, 1);
  // The clock moves back 10 hours after the failure, leaving the last attempt in the future.
  loop.state.clock -= 10 * HOUR;
  const movedBack = loop.state.clock;

  await loop.wake();
  const noticedAt = movedBack + 5 * MINUTE;
  assert.equal(loop.state.attempts.length, 1);
  assert.equal(loop.service.status().scheduled.lastAttemptAt, noticedAt, "stored as the time it was noticed");
  await loop.wake();
  assert.equal(loop.state.attempts.at(-1), noticedAt + 5 * MINUTE, "waits 5 minutes, not 10 hours");
});

test("persistent failures back off 5, 10, 20, 40, then 60 minutes at a 1-hour interval, across a restart, and reset on success", async (t) => {
  const loop = wallClockLoop(t);
  loop.state.failing = true;
  await loop.wakeUntilAttempts(3);
  const firstFailure = loop.state.attempts[0]!;
  assert.deepEqual(gapsInMinutes(loop.state.attempts), [5, 10]);

  await loop.restart();
  const recorded = loop.service.status().scheduled;
  assert.equal(recorded.consecutiveFailures, 3, "the streak survives a restart");
  assert.equal(recorded.failingSince, firstFailure);
  assert.equal(recorded.lastAttemptAt, loop.state.attempts.at(-1));
  assert.equal(recorded.lastFailure?.at, loop.state.attempts.at(-1));
  assert.equal(recorded.lastFailure?.kind, "scheduled");
  assert.match(recorded.lastFailure?.message ?? "", /ENOSPC/);
  assert.equal(recorded.lastSuccessAt, null);

  await loop.wakeUntilAttempts(4);
  assert.deepEqual(gapsInMinutes(loop.state.attempts), [5, 10, 20, 40, 60, 60]);
  assert.deepEqual(kept(loop.backupRoot, "scheduled"), [], "a failed capture publishes nothing");

  loop.state.failing = false;
  await loop.wakeUntilAttempts(1);
  const succeededAt = loop.state.attempts.at(-1)!;
  assert.equal(succeededAt - loop.state.attempts.at(-2)!, 60 * MINUTE);
  assert.deepEqual(loop.service.status().scheduled, {
    lastAttemptAt: succeededAt,
    lastSuccessAt: succeededAt,
    consecutiveFailures: 0,
    failingSince: null,
    lastFailure: null,
  });

  // The next failure starts a new streak at the 5-minute wait.
  loop.state.clock += HOUR - DATABASE_BACKUP_WAKE_MS;
  loop.state.failing = true;
  await loop.wakeUntilAttempts(2);
  assert.equal(loop.state.attempts.at(-1)! - loop.state.attempts.at(-2)!, 5 * MINUTE);
});

test("persistent failures at a 24-hour interval keep doubling until they reach 1440 minutes", async (t) => {
  const loop = wallClockLoop(t, { intervalHours: 24 });
  loop.state.failing = true;
  await loop.wakeUntilAttempts(12);
  assert.deepEqual(
    gapsInMinutes(loop.state.attempts),
    [5, 10, 20, 40, 80, 160, 320, 640, 1280, 1440, 1440],
  );
});

test("a Back up now failure moves the next scheduled attempt out and leaves the scheduled failure unset", async (t) => {
  const loop = wallClockLoop(t);
  loop.seedScheduled(loop.state.clock - 55 * MINUTE, 1);
  loop.state.failing = true;
  const failedAt = loop.state.clock;
  await assert.rejects(loop.service.captureManual(), /Manual database backup failed: ENOSPC/);
  await assert.rejects(loop.service.captureManual(), /ENOSPC/);

  const status = loop.service.status();
  assert.equal(status.manual.consecutiveFailures, 2);
  assert.equal(status.manual.failingSince, failedAt);
  assert.equal(status.manual.lastFailure?.kind, "manual");
  assert.deepEqual(status.scheduled, {
    lastAttemptAt: failedAt,
    lastSuccessAt: null,
    consecutiveFailures: 2,
    failingSince: null,
    lastFailure: null,
  });

  loop.state.failing = false;
  await loop.wake();
  assert.equal(loop.state.attempts.length, 2, "due by the interval, but two failures wait 10 minutes");
  await loop.wake();
  assert.equal(loop.state.attempts.at(-1), failedAt + 10 * MINUTE);
});

test("Back up now is never refused by the backoff, clears the scheduled streak, and never restarts the interval", async (t) => {
  const loop = wallClockLoop(t);
  loop.state.failing = true;
  await loop.wakeUntilAttempts(3);
  const failing = loop.service.status().scheduled;
  assert.equal(failing.consecutiveFailures, 3);
  assert.notEqual(failing.failingSince, null);
  assert.equal(loop.service.scheduledDue(), false, "the scheduled attempt is backing off");

  loop.state.failing = false;
  const manual = await loop.service.captureManual();
  assert.equal(manual.kind, "manual");
  assert.deepEqual(kept(loop.backupRoot, "manual"), [manual.filename]);
  const status = loop.service.status();
  assert.equal(status.manual.lastSuccessAt, loop.state.clock);
  assert.equal(status.manual.lastFailure, null);
  assert.equal(status.scheduled.consecutiveFailures, 0);
  assert.equal(status.scheduled.failingSince, null);
  assert.equal(status.scheduled.lastFailure, null);
  assert.equal(loop.service.scheduledDue(), true, "a manual copy does not count as an hourly one");

  // With an hourly copy 50 minutes old, a fresh manual copy still leaves it due 10 minutes later.
  rmSync(loop.backupRoot, { recursive: true, force: true });
  loop.seedScheduled(loop.state.clock - 50 * MINUTE, 1);
  await loop.service.captureManual();
  const before = loop.state.attempts.length;
  const manualAt = loop.state.clock;
  await loop.wake();
  assert.equal(loop.state.attempts.length, before);
  await loop.wake();
  assert.equal(loop.state.attempts.at(-1), manualAt + 10 * MINUTE);
});

test("captures are single-flight: the same kind joins, the other kind waits its turn", async (t) => {
  const root = fixture("mission-database-backup-single-flight-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = new DatabaseSync(join(root, "harness.db"));
  t.after(() => source.close());
  source.exec("CREATE TABLE recovery_probe (value TEXT NOT NULL)");
  const releases: Array<() => void> = [];
  let running = 0;
  let overlapped = false;
  const service = new DatabaseBackupService(source, {
    root: join(root, "backups"),
    onlineBackup: async (db, destination) => {
      running += 1;
      overlapped ||= running > 1;
      await new Promise<void>((resolve) => releases.push(resolve));
      await sqliteBackup(db, destination);
      running -= 1;
    },
  });

  const scheduled = service.captureScheduled();
  assert.equal(service.captureScheduled(), scheduled, "a second scheduled request joins the first");
  const manual = service.captureManual();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(releases.length, 1, "the manual capture waits for the scheduled one");
  releases.shift()!();
  assert.equal((await scheduled).kind, "scheduled");
  while (!releases[0]) await new Promise<void>((resolve) => setImmediate(resolve));
  releases.shift()!();
  assert.equal((await manual).kind, "manual");
  assert.equal(overlapped, false);
});

test("a recurring loop contains a failed due check and keeps waking", async () => {
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  let scheduled: (() => void) | undefined;
  try {
    const stop = startDatabaseBackupLoop(
      {
        captureScheduled: () => Promise.reject(new Error("not reached")),
        prune: () => undefined,
        scheduledDue: () => { throw new Error("backup root is a symlink"); },
      },
      {
        setTimer: (callback) => { scheduled = callback; return { unref() {} }; },
        clearTimer: () => undefined,
      },
    );
    const firstTick = scheduled!;
    scheduled = undefined;
    firstTick();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0]![0]), /database backup failed: backup root is a symlink/);
    assert.ok(scheduled, "the next wake is armed");
    await stop();
  } finally {
    console.warn = originalWarn;
  }
});
