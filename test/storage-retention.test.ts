import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import {
  alwaysKeptCounts,
  BACKUP_ALWAYS_KEPT,
  backupRetentionLimits,
  DEFAULT_DATABASE_BACKUPS_CONFIG,
  planBackupRetention,
  type DatabaseBackupsConfig,
  type RetentionCopy,
} from "../src/shared/database-backups.ts";
import { backupDraftEffect, spanLabel } from "../src/web/lib/storage-view.ts";

// What is at stake: the size and age limits are the first backup limits that can delete a
// kind's NEWEST copies. The minimum recovery set is what keeps "fewer backups" from ever
// meaning "no way back", and the page's "Saving deletes N copies" preview must name exactly
// the copies the daemon's prune then deletes.

const stateHome = mkdtempSync(join(tmpdir(), "mission-storage-retention-"));
process.env.MISSION_HOME = stateHome;
after(() => rmSync(stateHome, { recursive: true, force: true }));

const { openDb } = await import("../src/server/db.ts");
const { APP_CONFIG_ENTRIES } = await import("../src/shared/app-config-entries.ts");
const { DatabaseBackupService } = await import("../src/server/database-backups/service.ts");
const { getDatabaseBackupsConfig, setDatabaseBackupsConfig, StaleBackupPreviewError } = await import("../src/server/database-backups/config.ts");

const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;
const GIB = 1024 ** 3;
const NOW = Date.parse("2026-11-13T18:00:00.000Z");

function copy(kind: RetentionCopy["kind"], hoursAgo: number, bytes = GIB / 2): RetentionCopy & { diskBytes: number } {
  return { kind, filename: `${kind}-${String(hoursAgo).padStart(6, "0")}`, at: NOW - hoursAgo * HOUR, bytes, diskBytes: bytes };
}

function config(overrides: Partial<DatabaseBackupsConfig>): DatabaseBackupsConfig {
  return { ...DEFAULT_DATABASE_BACKUPS_CONFIG, ...overrides };
}

const hourly = (count: number) => Array.from({ length: count }, (_, index) => copy("scheduled", index + 1));

test("with no age or size limit, retention is the counts alone, as it always was", () => {
  const plan = planBackupRetention(hourly(5), backupRetentionLimits(config({ scheduledCount: 3 })), NOW);
  assert.deepEqual(plan.keep.map((kept) => kept.filename), ["scheduled-000001", "scheduled-000002", "scheduled-000003"]);
  assert.deepEqual(plan.remove.map((gone) => [gone.filename, gone.reason]), [
    ["scheduled-000005", "count"],
    ["scheduled-000004", "count"],
  ]);
  assert.equal(plan.overBudget, false);
});

test("an age limit removes old copies of its own kind but never the minimum recovery set", () => {
  const copies = [
    copy("scheduled", 30 * 24),
    copy("scheduled", 10 * 24),
    copy("preMigration", 200 * 24),
    copy("preMigration", 120 * 24),
    copy("preMigration", 100 * 24),
  ];
  const plan = planBackupRetention(
    copies,
    backupRetentionLimits(config({ scheduledCount: 5, preMigrationCount: 10, scheduledMaxAgeDays: 7, preMigrationMaxAgeDays: 90 })),
    NOW,
  );
  // Every copy is past its age, so only the always-kept ones stay: the newest scheduled copy
  // and the two newest pre-migration copies.
  assert.deepEqual(plan.keep.map((kept) => kept.filename).sort(), [
    "preMigration-002400",
    "preMigration-002880",
    "scheduled-000240",
  ]);
  assert.deepEqual(plan.remove.map((gone) => [gone.filename, gone.reason]), [
    ["preMigration-004800", "age"],
    ["scheduled-000720", "age"],
  ]);
});

test("the size budget removes the oldest copies across every kind until the rest fit", () => {
  const copies = [...hourly(10), copy("preMigration", 5 * 24), copy("preMigration", 50 * 24), copy("manual", 2)];
  // 13 copies of 0.5 GiB. A 4 GiB budget keeps 8 of them.
  const plan = planBackupRetention(
    copies,
    backupRetentionLimits(config({ scheduledCount: 24, preMigrationCount: 10, maxTotalBytes: 4 * GIB })),
    NOW,
  );
  assert.equal(plan.keep.reduce((total, kept) => total + kept.bytes, 0), 4 * GIB);
  assert.equal(plan.overBudget, false);
  // Oldest first, and the two always-kept pre-migration copies are skipped even though they
  // are the oldest of all.
  assert.deepEqual(plan.remove.map((gone) => [gone.filename, gone.reason]), [
    ["scheduled-000010", "size"],
    ["scheduled-000009", "size"],
    ["scheduled-000008", "size"],
    ["scheduled-000007", "size"],
    ["scheduled-000006", "size"],
  ]);
  for (const always of plan.alwaysKept) assert.ok(plan.keep.some((kept) => kept.filename === always));
});

test("a budget smaller than the minimum recovery set keeps that set and says it is over budget", () => {
  const copies = [...hourly(3), copy("preMigration", 48), copy("preMigration", 96), copy("manual", 1)];
  const plan = planBackupRetention(
    copies,
    backupRetentionLimits(config({ scheduledCount: 3, maxTotalBytes: GIB / 4 })),
    NOW,
  );
  assert.deepEqual(plan.keep.map((kept) => kept.filename).sort(), [
    "manual-000001",
    "preMigration-000048",
    "preMigration-000096",
    "scheduled-000001",
  ]);
  assert.equal(plan.overBudget, true);
});

test("a pre-migration count of 1 protects one copy, so the set never promises a copy the count removes", () => {
  const copies = [copy("preMigration", 24), copy("preMigration", 48), copy("scheduled", 1)];
  const limits = backupRetentionLimits(config({ preMigrationCount: 1, maxTotalBytes: GIB / 4 }));
  assert.deepEqual(alwaysKeptCounts(limits.counts), { scheduled: 1, preMigration: 1, manual: 1 });
  const plan = planBackupRetention(copies, limits, NOW);
  assert.deepEqual(plan.alwaysKept.sort(), ["preMigration-000024", "scheduled-000001"]);
  // The second pre-migration copy goes for the count, which the Backups tab shows before saving.
  assert.deepEqual(plan.remove.map((gone) => [gone.filename, gone.reason]), [["preMigration-000048", "count"]]);
  for (const always of plan.alwaysKept) assert.ok(plan.keep.some((kept) => kept.filename === always));

  const two = backupRetentionLimits(config({ preMigrationCount: 2 }));
  assert.equal(alwaysKeptCounts(two.counts).preMigration, BACKUP_ALWAYS_KEPT.preMigration);
});

test("a copy dated in the future is the first one a budget removes and no age limit judges it", () => {
  const future = { ...copy("scheduled", 0), filename: "scheduled-future", at: NOW + 2 * HOUR };
  const plan = planBackupRetention(
    [future, ...hourly(3)],
    backupRetentionLimits(config({ scheduledCount: 10, scheduledMaxAgeDays: 1, maxTotalBytes: GIB })),
    NOW,
  );
  assert.equal(plan.remove[0]?.filename, "scheduled-future");
  assert.equal(plan.remove[0]?.reason, "size");
});

test("the page's draft preview names what saving deletes and how far back recovery reaches", () => {
  const copies = [...hourly(24), copy("preMigration", 24 * 5), copy("preMigration", 24 * 101)];
  const effect = backupDraftEffect(copies, config({ scheduledCount: 24, preMigrationCount: 10, maxTotalBytes: 7 * GIB }), NOW);
  assert.equal(effect.plan.remove.length, 12);
  assert.equal(effect.removedBytes, 6 * GIB);
  assert.equal(effect.removedDiskBytes, 6 * GIB, "written copies free what their file size says");
  // A sparse copy frees only the blocks it holds, which is what the page reports as saved.
  const sparse = copies.map((entry) => ({ ...entry, diskBytes: 1024 ** 2 }));
  const sparseEffect = backupDraftEffect(sparse, config({ scheduledCount: 24, preMigrationCount: 10, maxTotalBytes: 7 * GIB }), NOW);
  assert.equal(sparseEffect.removedBytes, 6 * GIB);
  assert.equal(sparseEffect.removedDiskBytes, 12 * 1024 ** 2);
  assert.equal(spanLabel(effect.scheduledReach.before), "24 hours");
  assert.equal(spanLabel(effect.scheduledReach.after), "12 hours");
  assert.equal(effect.preMigrationOldest.before, NOW - 101 * DAY);
  assert.equal(effect.preMigrationOldest.after, NOW - 101 * DAY, "both pre-migration copies are always kept");
});

// ---- the daemon's prune follows the same plan ----

const backupRoot = join(stateHome, "backups", "database");

/** A copy of `bytes` apparent size. Sparse, so a test can seed hundreds of MiB for free. */
function seed(kind: "scheduled" | "pre-migration", stamp: string, index: number, bytes: number): void {
  mkdirSync(backupRoot, { recursive: true });
  const path = join(backupRoot, `${kind}-${stamp}-${String(index).padStart(32, "a")}.sqlite3`);
  writeFileSync(path, "");
  truncateSync(path, bytes);
}

beforeEach(() => {
  rmSync(backupRoot, { recursive: true, force: true });
  openDb().prepare("DELETE FROM app_config WHERE key = ?").run(APP_CONFIG_ENTRIES.backups.key);
});

test("a saved age limit prunes on save and keeps the newest copy of each kind", () => {
  seed("scheduled", "20261001T000000000Z", 1, 1024);
  seed("scheduled", "20261002T000000000Z", 2, 1024);
  seed("pre-migration", "20260101T000000000Z", 3, 1024);
  seed("pre-migration", "20260201T000000000Z", 4, 1024);
  seed("pre-migration", "20260301T000000000Z", 5, 1024);
  const backups = new DatabaseBackupService(openDb(), { now: () => new Date(NOW) });
  setDatabaseBackupsConfig({ scheduledMaxAgeDays: 7, preMigrationMaxAgeDays: 30, preMigrationCount: 10 }, backups);
  assert.deepEqual(readdirSync(backupRoot).sort(), [
    `pre-migration-20260201T000000000Z-${"4".padStart(32, "a")}.sqlite3`,
    `pre-migration-20260301T000000000Z-${"5".padStart(32, "a")}.sqlite3`,
    `scheduled-20261002T000000000Z-${"2".padStart(32, "a")}.sqlite3`,
  ]);
});

test("a fixed count passed to the service replaces only the counts; the saved size budget still applies", () => {
  const MIB = 1024 ** 2;
  for (let hour = 1; hour <= 4; hour += 1) seed("scheduled", `20261113T0${hour}0000000Z`, hour, 200 * MIB);
  setDatabaseBackupsConfig({ maxTotalBytes: GIB / 4 }, { prune: () => {} });
  const backups = new DatabaseBackupService(openDb(), {
    now: () => new Date(NOW),
    retention: { scheduled: 4, preMigration: 2 },
  });
  backups.prune();
  // The count keeps all four 200 MiB copies; the quarter-GiB budget then keeps only the newest.
  assert.deepEqual(readdirSync(backupRoot), [`scheduled-20261113T040000000Z-${"4".padStart(32, "a")}.sqlite3`]);
});

test("a save carrying the shown deletions refuses, saving and deleting nothing, when the copies changed", () => {
  const MIB = 1024 ** 2;
  for (let hour = 1; hour <= 4; hour += 1) seed("scheduled", `20261113T0${hour}0000000Z`, hour, 200 * MIB);
  const backups = new DatabaseBackupService(openDb(), { now: () => new Date(NOW) });
  setDatabaseBackupsConfig({ scheduledCount: 4 }, backups);
  const name = (hour: number) => `scheduled-20261113T0${hour}0000000Z-${String(hour).padStart(32, "a")}.sqlite3`;

  // The page showed a 0.5 GiB budget deleting the two oldest copies.
  const shown = [name(1), name(2)];
  assert.deepEqual(backups.plannedRemovals({ ...getDatabaseBackupsConfig(), maxTotalBytes: GIB / 2 }), shown);

  // A capture lands before Save: an older copy now goes too. The save is refused, with the new list.
  seed("scheduled", "20261113T000000000Z", 0, 200 * MIB);
  assert.throws(
    () => setDatabaseBackupsConfig({ maxTotalBytes: GIB / 2 }, backups, shown),
    (error: unknown) => error instanceof StaleBackupPreviewError &&
      error.remove.length === 3 && error.remove.includes(`scheduled-20261113T000000000Z-${"0".padStart(32, "a")}.sqlite3`),
  );
  assert.equal(getDatabaseBackupsConfig().maxTotalBytes, null, "nothing was saved");
  assert.equal(readdirSync(backupRoot).length, 5, "nothing was deleted");

  // Saved against the list as it now is, it deletes exactly that list.
  const fresh = backups.plannedRemovals({ ...getDatabaseBackupsConfig(), maxTotalBytes: GIB / 2 });
  setDatabaseBackupsConfig({ maxTotalBytes: GIB / 2 }, backups, fresh);
  assert.equal(getDatabaseBackupsConfig().maxTotalBytes, GIB / 2);
  assert.deepEqual(readdirSync(backupRoot).sort(), [name(3), name(4)]);
});

test("the service reports what kept copies occupy on disk, apart from their file sizes", () => {
  const MIB = 1024 ** 2;
  seed("scheduled", "20261113T010000000Z", 1, 200 * MIB);
  mkdirSync(backupRoot, { recursive: true });
  writeFileSync(join(backupRoot, `scheduled-20261113T020000000Z-${"2".padStart(32, "a")}.sqlite3`), Buffer.alloc(MIB, 1));
  const backups = new DatabaseBackupService(openDb(), { now: () => new Date(NOW) });
  const logical = backups.keptCopies().reduce((total, copy) => total + copy.bytes, 0);
  assert.equal(logical, 201 * MIB);
  const disk = backups.keptDiskBytes();
  // The sparse 200 MiB copy holds next to nothing; the written 1 MiB copy holds its megabyte.
  assert.ok(disk >= MIB && disk < 8 * MIB, `on-disk bytes ${disk}`);
  // Each listed copy carries both, so the page can show what deleting it frees on disk.
  const listed = backups.keptCopies();
  assert.equal(listed.reduce((total, entry) => total + entry.diskBytes, 0), disk);
  assert.equal(listed.find((entry) => entry.bytes === 200 * MIB)!.diskBytes < MIB, true);
});
