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
const app = buildApp({
  registry: {} as Registry,
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

test("the shared schema defaults to 3 hourly, 2 pre-migration, every hour", () => {
  assert.deepEqual(DEFAULT_DATABASE_BACKUPS_CONFIG, {
    scheduledCount: 3,
    preMigrationCount: 2,
    intervalHours: 1,
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
    assert.deepEqual(DatabaseBackupsConfigSchema.parse(valid), valid);
  }
  assert.equal(DatabaseBackupsConfigPatchSchema.safeParse({ manualCount: 2 }).success, false);
});

test("saving lowered counts prunes at once, and a refused save changes nothing", async () => {
  seedScheduled(5);
  const saved = await putConfig({ scheduledCount: 2 });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), {
    scheduledCount: 2,
    preMigrationCount: 2,
    intervalHours: 1,
  });
  assert.equal(scheduledCopies().length, 2);

  for (const body of [{ scheduledCount: 0 }, { preMigrationCount: 11 }, { intervalHours: 2 }]) {
    const refused = await putConfig(body);
    assert.equal(refused.status, 400, JSON.stringify(body));
  }
  assert.equal(getDatabaseBackupsConfig().scheduledCount, 2);
  assert.equal(scheduledCopies().length, 2);

  const raised = await putConfig({ scheduledCount: 1, intervalHours: 6 });
  assert.equal(raised.status, 200);
  assert.deepEqual(getDatabaseBackupsConfig(), {
    scheduledCount: 1,
    preMigrationCount: 2,
    intervalHours: 6,
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
