import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { QueueManager } from "../src/server/queue.ts";
import type { Registry } from "../src/server/registry.ts";
import type { ReviewManager } from "../src/server/reviews.ts";
import type { TaskManager } from "../src/server/tasks.ts";
import {
  DATABASE_BACKUP_INTERVAL_HOURS,
  DatabaseBackupsConfigPatchSchema,
  DatabaseBackupsConfigSchema,
  DEFAULT_DATABASE_BACKUPS_CONFIG,
} from "../src/shared/database-backups.ts";

const stateHome = mkdtempSync(join(tmpdir(), "mission-database-backups-config-"));
// Set the supported test home before importing any server module that can resolve the DB.
process.env.MISSION_HOME = stateHome;
after(() => rmSync(stateHome, { recursive: true, force: true }));

const { openDb } = await import("../src/server/db.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { DatabaseBackupService } = await import("../src/server/database-backups/service.ts");
const { getDatabaseBackupsConfig, setDatabaseBackupsConfig } = await import(
  "../src/server/database-backups/config.ts"
);

const backupRoot = join(stateHome, "backups", "database");
const databaseBackups = new DatabaseBackupService(openDb(), { root: backupRoot });
let configAnnouncements = 0;
const app = buildApp({
  registry: { emitStorageConfigChanged: () => { configAnnouncements += 1; } } as unknown as Registry,
  reviews: {} as ReviewManager,
  tasks: {} as TaskManager,
  queues: {} as QueueManager,
  databaseBackups,
});
const HEADERS = { host: "127.0.0.1:7317", "content-type": "application/json" };

function putConfig(body: unknown): Promise<Response> {
  return Promise.resolve(app.request("/api/storage/backups/config", {
    method: "PUT",
    headers: HEADERS,
    body: JSON.stringify(body),
  }));
}

function postBackup(target = app): Promise<Response> {
  return Promise.resolve(target.request("/api/storage/backups", { method: "POST", headers: HEADERS }));
}

function seedScheduled(count: number): void {
  mkdirSync(backupRoot, { recursive: true });
  for (let index = 0; index < count; index += 1) {
    const name = `scheduled-2020010${index + 1}T000000000Z-${String(index).padStart(32, "b")}.sqlite3`;
    writeFileSync(join(backupRoot, name), "seeded copy");
  }
}

function scheduledCopies(): string[] {
  return readdirSync(backupRoot).filter((name) => name.startsWith("scheduled-"));
}

// The age and size limits arrived after the counts. Off by default, so a config stored before
// them keeps exactly the copies it kept.
const NO_AGE_OR_SIZE_LIMIT = {
  scheduledMaxAgeDays: null,
  preMigrationMaxAgeDays: null,
  maxTotalBytes: null,
} as const;

test("the shared schema defaults to 3 hourly, 2 pre-migration, every hour, with no age or size limit", () => {
  assert.deepEqual(DEFAULT_DATABASE_BACKUPS_CONFIG, {
    scheduledCount: 3,
    preMigrationCount: 2,
    intervalHours: 1,
    ...NO_AGE_OR_SIZE_LIMIT,
  });
});

test("the shared schema refuses out-of-range counts and intervals, and never accepts 0", () => {
  for (const scheduledCount of [0, -1, 49, 2.5]) {
    assert.equal(DatabaseBackupsConfigSchema.safeParse({ scheduledCount }).success, false);
  }
  for (const preMigrationCount of [0, 11, 1.5]) {
    assert.equal(DatabaseBackupsConfigSchema.safeParse({ preMigrationCount }).success, false);
  }
  for (const intervalHours of DATABASE_BACKUP_INTERVAL_HOURS) {
    assert.equal(DatabaseBackupsConfigSchema.parse({ intervalHours }).intervalHours, intervalHours);
  }
  for (const intervalHours of [0, 2, 4, 48]) {
    assert.equal(DatabaseBackupsConfigSchema.safeParse({ intervalHours }).success, false);
  }
  for (const valid of [
    { scheduledCount: 1, preMigrationCount: 1, intervalHours: 24 },
    { scheduledCount: 48, preMigrationCount: 10, intervalHours: 12 },
  ]) {
    assert.deepEqual(DatabaseBackupsConfigSchema.parse(valid), { ...valid, ...NO_AGE_OR_SIZE_LIMIT });
  }
  assert.equal(DatabaseBackupsConfigPatchSchema.safeParse({ manualCount: 2 }).success, false);
  for (const days of [0, 366, 1.5]) {
    assert.equal(DatabaseBackupsConfigSchema.safeParse({ scheduledMaxAgeDays: days }).success, false);
    assert.equal(DatabaseBackupsConfigSchema.safeParse({ preMigrationMaxAgeDays: days }).success, false);
  }
  for (const bytes of [0, 1024 ** 3 / 8, 1.5 * 1024 ** 3 + 0.5]) {
    assert.equal(DatabaseBackupsConfigSchema.safeParse({ maxTotalBytes: bytes }).success, false);
  }
  // `null` in a patch clears a limit; a number sets it.
  assert.deepEqual(
    DatabaseBackupsConfigPatchSchema.parse({ scheduledMaxAgeDays: null, maxTotalBytes: 8 * 1024 ** 3 }),
    { scheduledMaxAgeDays: null, maxTotalBytes: 8 * 1024 ** 3 },
  );
});

test("a save whose shown deletions no longer match answers 409 with the current list, saving and deleting nothing", async () => {
  seedScheduled(5);
  const name = (index: number) => `scheduled-2020010${index + 1}T000000000Z-${String(index).padStart(32, "b")}.sqlite3`;
  const announcedBefore = configAnnouncements;
  const countBefore = getDatabaseBackupsConfig().scheduledCount;
  // The page showed a count of 2 deleting the three oldest; an older copy has landed since.
  writeFileSync(join(backupRoot, `scheduled-20191231T000000000Z-${"9".padStart(32, "b")}.sqlite3`), "late copy");
  const stale = await putConfig({ scheduledCount: 2, expectRemove: [name(0), name(1), name(2)] });
  assert.equal(stale.status, 409);
  const body = await stale.json() as { error: string; remove: string[] };
  assert.equal(body.error, "stale_preview");
  assert.equal(body.remove.length, 4);
  assert.equal(configAnnouncements, announcedBefore, "a refused save announces nothing");
  assert.equal(scheduledCopies().length, 6, "nothing was deleted");
  assert.equal(getDatabaseBackupsConfig().scheduledCount, countBefore, "nothing was saved");

  // Sent with the list as it now is, the save goes through and deletes exactly that.
  const saved = await putConfig({ scheduledCount: 2, expectRemove: body.remove });
  assert.equal(saved.status, 200);
  assert.equal(getDatabaseBackupsConfig().scheduledCount, 2);
  assert.deepEqual(scheduledCopies().sort(), [name(3), name(4)]);
  // Leave the shared config and copies as the tests below expect to find them.
  setDatabaseBackupsConfig({ scheduledCount: countBefore }, { prune: () => {} });
  rmSync(backupRoot, { recursive: true, force: true });
});

test("a save that would delete copies without naming them is refused with the exact list, and nothing changes", async () => {
  seedScheduled(5);
  const announcedBefore = configAnnouncements;
  const countBefore = getDatabaseBackupsConfig().scheduledCount;
  const unconfirmed = await putConfig({ scheduledCount: 2 });
  assert.equal(unconfirmed.status, 409);
  const body = await unconfirmed.json() as { error: string; message: string; remove: string[] };
  assert.equal(body.error, "preview_required");
  assert.match(body.message, /Saving these limits deletes 3 copies\. Nothing was saved or deleted/);
  assert.deepEqual(body.remove, scheduledCopies().sort().slice(0, 3));
  assert.equal(scheduledCopies().length, 5, "nothing was deleted");
  assert.equal(getDatabaseBackupsConfig().scheduledCount, countBefore, "nothing was saved");
  assert.equal(configAnnouncements, announcedBefore, "a refused save announces nothing");

  // Any save prunes to the current limits, so with copies over them even an interval change
  // names what it deletes. With nothing over the limits, a save needs no list.
  assert.equal((await putConfig({ intervalHours: 1 })).status, 409);
  rmSync(backupRoot, { recursive: true, force: true });
  assert.equal((await putConfig({ intervalHours: 1 })).status, 200);
});

test("saving lowered counts prunes at once, and a refused save changes nothing", async () => {
  seedScheduled(5);
  const announcedBefore = configAnnouncements;
  const confirm = (await (await putConfig({ scheduledCount: 2 })).json() as { remove: string[] }).remove;
  const saved = await putConfig({ scheduledCount: 2, expectRemove: confirm });
  assert.equal(saved.status, 200);
  assert.equal(configAnnouncements, announcedBefore + 1, "a save tells every open window to re-read");
  assert.deepEqual(await saved.json(), {
    scheduledCount: 2,
    preMigrationCount: 2,
    intervalHours: 1,
    ...NO_AGE_OR_SIZE_LIMIT,
  });
  assert.equal(scheduledCopies().length, 2);

  for (const body of [{ scheduledCount: 0 }, { preMigrationCount: 11 }, { intervalHours: 2 }]) {
    const refused = await putConfig(body);
    assert.equal(refused.status, 400, JSON.stringify(body));
  }
  assert.equal(configAnnouncements, announcedBefore + 1, "a refused save announces nothing");
  assert.equal(getDatabaseBackupsConfig().scheduledCount, 2);
  assert.equal(scheduledCopies().length, 2);

  const lowered = (await (await putConfig({ scheduledCount: 1, intervalHours: 6 })).json() as { remove: string[] }).remove;
  assert.equal(lowered.length, 1, "a count of 1 deletes one of the two copies, so it is named first");
  const raised = await putConfig({ scheduledCount: 1, intervalHours: 6, expectRemove: lowered });
  assert.equal(raised.status, 200);
  assert.deepEqual(getDatabaseBackupsConfig(), {
    scheduledCount: 1,
    preMigrationCount: 2,
    intervalHours: 6,
    ...NO_AGE_OR_SIZE_LIMIT,
  });
  assert.equal(scheduledCopies().length, 1);
});

test("a prune that throws after saving still reports the save, and only warns", () => {
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    const saved = setDatabaseBackupsConfig(
      { preMigrationCount: 7 },
      { prune: () => { throw new Error("backup root is a symlink"); } },
    );
    assert.equal(saved.preMigrationCount, 7);
    assert.equal(getDatabaseBackupsConfig().preMigrationCount, 7, "the save was persisted");
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0]![0]), /prune failed after saving: backup root is a symlink/);
  } finally {
    console.warn = originalWarn;
  }
});

test("a save the database refuses answers 500 with its reason, and stores nothing", async () => {
  const before = getDatabaseBackupsConfig();
  const announcedBefore = configAnnouncements;
  const db = openDb();
  db.exec(`CREATE TEMP TRIGGER refuse_backups_save BEFORE INSERT ON app_config
    WHEN NEW.key = 'backups' BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END`);
  try {
    const refused = await putConfig({ scheduledCount: before.scheduledCount + 1 });
    assert.equal(refused.status, 500);
    assert.deepEqual(await refused.json(), { error: "save_failed", message: "database or disk is full" });
  } finally {
    db.exec("DROP TRIGGER refuse_backups_save");
  }
  assert.deepEqual(getDatabaseBackupsConfig(), before);
  assert.equal(configAnnouncements, announcedBefore, "a save SQLite refused announces nothing");
});

test("a settings snapshot taken before the database-backups domain still validates and restores", async () => {
  const { WorkflowStore } = await import("../src/server/workflows/store.ts");
  const { Registry } = await import("../src/server/registry.ts");
  const { SettingsBackupService } = await import("../src/server/settings-backups/service.ts");
  const { SettingsBackupStore } = await import("../src/server/settings-backups/store.ts");
  const { createSettingsBackupEnvelope, validateSettingsBackupDomains } =
    await import("../src/server/settings-backups/format.ts");
  const { migrateSettingsBackupSnapshot } = await import("../src/server/settings-backups/restore.ts");
  const { stageSettingsConfigRestore, restoreSettingsConfigInTransaction } =
    await import("../src/server/settings-backups/config-registry.ts");
  const db = openDb();
  const kept = { scheduledCount: 9, preMigrationCount: 4, intervalHours: 12 } as const;
  setDatabaseBackupsConfig(kept, { prune: () => {} });
  const captured = await new SettingsBackupService(
    new WorkflowStore(db),
    new SettingsBackupStore(join(stateHome, "settings-backups")),
    () => new Date("2026-11-09T18:00:00.000Z"),
    "database-backups-test",
    {
      registry: new Registry(),
      preflightSkills: () => [],
      preflightCost: () => {},
      reconcileSkills: () => {},
      reconcileCost: () => {},
    },
  ).ensureDailySnapshot("2026-11-09");
  assert.equal(captured.status, "ready");
  if (captured.status !== "ready") return;
  const { digest: _digest, ...body } = captured.snapshot;
  const old = createSettingsBackupEnvelope({
    ...body,
    domains: body.domains.filter((entry) => entry.domain !== "database-backups"),
  });

  validateSettingsBackupDomains(old);
  restoreSettingsConfigInTransaction(db, stageSettingsConfigRestore(migrateSettingsBackupSnapshot(old).settings));
  assert.deepEqual(getDatabaseBackupsConfig(), { ...kept, ...NO_AGE_OR_SIZE_LIMIT }, "absence leaves the current backup settings alone");
});

test("Back up now takes a manual copy, and its failure is recorded on the manual kind", async () => {
  const taken = await postBackup();
  assert.equal(taken.status, 201);
  const body = await taken.json() as { kind: string; filename: string; createdAt: string };
  assert.equal(body.kind, "manual");
  assert.match(body.filename, /^manual-\d{8}T\d{9}Z-[a-f0-9]{32}\.sqlite3$/);
  assert.deepEqual(readdirSync(backupRoot).filter((name) => name.startsWith("manual-")), [body.filename]);
  assert.notEqual(databaseBackups.status().manual.lastSuccessAt, null);

  // The same database, served by a capture that always fails.
  const failing = buildApp({
    registry: {} as Registry,
    reviews: {} as ReviewManager,
    tasks: {} as TaskManager,
    queues: {} as QueueManager,
    databaseBackups: new DatabaseBackupService(openDb(), {
      root: backupRoot,
      onlineBackup: async () => { throw new Error("ENOSPC: no space left on device"); },
    }),
  });
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const refused = await postBackup(failing);
    assert.equal(refused.status, 500, "a failure is reported, and the backoff never refuses the request");
    assert.deepEqual(await refused.json(), {
      error: "backup_failed",
      message: "Manual database backup failed: ENOSPC: no space left on device",
    });
  }
  const failed = databaseBackups.status();
  assert.equal(failed.manual.consecutiveFailures, 3);
  assert.match(failed.manual.lastFailure?.message ?? "", /ENOSPC/);
  assert.equal(failed.scheduled.consecutiveFailures, 3, "a manual failure feeds the scheduled backoff");
  assert.equal(failed.scheduled.lastFailure, null);
  assert.equal(failed.scheduled.failingSince, null);

  const recovered = await postBackup();
  assert.equal(recovered.status, 201);
  const status = databaseBackups.status();
  assert.equal(status.manual.consecutiveFailures, 0);
  assert.equal(status.manual.failingSince, null);
  assert.equal(status.scheduled.consecutiveFailures, 0, "a manual success clears the scheduled streak");
});

test("Back up now answers 503 without a backup service", async () => {
  const bare = buildApp({
    registry: {} as Registry,
    reviews: {} as ReviewManager,
    tasks: {} as TaskManager,
    queues: {} as QueueManager,
  });
  assert.equal((await postBackup(bare)).status, 503);
});
