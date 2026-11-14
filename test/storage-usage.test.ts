import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import type { QueueManager } from "../src/server/queue.ts";
import type { ReviewManager } from "../src/server/reviews.ts";
import type { TaskManager } from "../src/server/tasks.ts";
import type { StorageHealth, StorageVolume } from "../src/shared/storage-health.ts";
import { databaseBackupStatusFrom } from "../src/shared/database-backups.ts";
import type { StorageAlertState, StorageLimitsConfig } from "../src/shared/storage-limits.ts";
import { DEFAULT_STORAGE_LIMITS_CONFIG, storageAlertStateFrom } from "../src/shared/storage-limits.ts";

// What is at stake: the operator ran out of disk without warning. These pin that the
// state directory's categories add up to what was measured, that a low-space or size warning
// keeps one id for as long as it stands (across a restart, and through a moment with no reading),
// and that saving a limit warns and never deletes.

const stateHome = mkdtempSync(join(tmpdir(), "mission-storage-usage-"));
process.env.MISSION_HOME = stateHome;
after(() => rmSync(stateHome, { recursive: true, force: true }));

const { openDb } = await import("../src/server/db.ts");
const { APP_CONFIG_ENTRIES } = await import("../src/shared/app-config-entries.ts");
const { Registry } = await import("../src/server/registry.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { StorageHealthService } = await import("../src/server/storage-health.ts");
const { getStorageLimitsConfig } = await import("../src/server/storage-limits.ts");
const { measurementFrom, parseDiskUsage, remeasureGrowthFor, settleListing, StorageUsageMonitor } = await import("../src/server/storage-usage.ts");

const GIB = 1024 ** 3;
const ROOT = "/state";

beforeEach(() => {
  const db = openDb();
  db.prepare("DELETE FROM app_config WHERE key = ?").run(APP_CONFIG_ENTRIES.storageLimits.key);
  db.prepare("DELETE FROM app_config WHERE key = ?").run(APP_CONFIG_ENTRIES.storageAlerts.key);
});

// ---- measuring ----

test("du output parses into sizes relative to the state directory, skipping what it cannot read", () => {
  const sizes = parseDiskUsage([
    `56937472\t${ROOT}`,
    `32505856\t${ROOT}/worktree-pools`,
    `1048576\t${ROOT}/worktree-pools/mission-control-b5174d00f600a624/7`,
    "du: /state/locked: Permission denied",
    `12\t/elsewhere/outside`,
    `oops\t${ROOT}/garbage`,
    "",
  ].join("\n"), ROOT);
  assert.deepEqual([...sizes.entries()], [
    ["", 56937472 * 1024],
    ["worktree-pools", 32505856 * 1024],
    ["worktree-pools/mission-control-b5174d00f600a624/7", 1048576 * 1024],
  ]);
});

test("categories add up to the measured total, with everything unclaimed under other", () => {
  const directories = new Map<string, number>([
    ["", 100 * GIB],
    ["worktree-pools", 50 * GIB],
    ["worktree-pools/web-0123456789abcdef", 30 * GIB],
    ["worktree-pools/web-0123456789abcdef/1", 20 * GIB],
    ["worktree-pools/api-fedcba9876543210", 20 * GIB],
    ["backups", 21 * GIB],
    ["backups/database", 20 * GIB],
    ["app-src", 4 * GIB],
    ["update-runtimes", 1 * GIB],
    ["workflow-evidence", 2 * GIB],
    ["uploads", 1 * GIB],
  ]);
  const measured = measurementFrom({
    root: ROOT,
    listing: { directories, partial: null },
    fileBytes: (path) => (path.endsWith("harness.db") ? 3 * GIB : null),
    measuredAt: 10,
    durationMs: 5,
  });
  const byId = Object.fromEntries(measured.categories.map((category) => [category.id, category.bytes / GIB]));
  assert.deepEqual(byId, {
    pools: 50,
    backups: 20,
    updates: 5,
    database: 3,
    evidence: 2,
    worktrees: 0,
    archives: 0,
    // Settings snapshots under backups/, uploads/, logs: whatever no category names.
    other: 20,
  });
  assert.equal(measured.categories.reduce((total, category) => total + category.bytes, 0), measured.totalBytes);
  assert.deepEqual(measured.pools.map((pool) => pool.name), ["web-0123456789abcdef", "api-fedcba9876543210"]);
  assert.equal(measured.slotBytes.get("worktree-pools/web-0123456789abcdef/1"), 20 * GIB);
});

function monitor(listing: () => Promise<Map<string, number>>, extra: Partial<ConstructorParameters<typeof StorageUsageMonitor>[0]> = {}) {
  let changes = 0;
  const usage = new StorageUsageMonitor({
    root: ROOT,
    listDirectories: async () => ({ directories: await listing(), partial: null }),
    fileBytes: () => null,
    volume: async () => ({ totalBytes: 500 * GIB, freeBytes: 40 * GIB }),
    now: () => 1_000,
    onChange: () => { changes += 1; },
    ...extra,
  });
  return { usage, changes: () => changes };
}

test("a measurement is single-flight, shows while it runs, and a failure keeps the last result", async () => {
  let release!: () => void;
  let calls = 0;
  let fail = false;
  const { usage } = monitor(() => {
    calls += 1;
    if (fail) return Promise.reject(new Error("du exited 1"));
    return new Promise((resolve) => {
      release = () => resolve(new Map([["", 10 * GIB], ["worktree-pools", 6 * GIB]]));
    });
  });
  const first = usage.measure();
  const joined = usage.measure();
  assert.equal(usage.usage().measuring, true);
  release();
  await Promise.all([first, joined]);
  assert.equal(calls, 1, "a second request joins the walk already running");
  assert.equal(usage.usage().totalBytes, 10 * GIB);
  assert.equal(usage.usage().measuring, false);

  fail = true;
  await usage.measure();
  assert.equal(usage.usage().totalBytes, 10 * GIB, "the last good measurement stays shown");
  assert.equal(usage.usage().error, "du exited 1");
});

test("slots removed since the measurement drop out of the totals at once", async () => {
  const gone = new Set([`${ROOT}/worktree-pools/web-0123456789abcdef/2`]);
  const { usage } = monitor(async () => new Map([
    ["", 10 * GIB],
    ["worktree-pools", 6 * GIB],
    ["worktree-pools/web-0123456789abcdef", 6 * GIB],
    ["worktree-pools/web-0123456789abcdef/1", 2 * GIB],
    ["worktree-pools/web-0123456789abcdef/2", 4 * GIB],
  ]), { slotPresent: (path) => !gone.has(path) });
  await usage.measure();
  usage.forgetRemovedSlots();
  const view = usage.usage();
  assert.equal(view.totalBytes, 6 * GIB);
  assert.equal(view.categories.find((category) => category.id === "pools")?.bytes, 2 * GIB);
  assert.equal(view.pools[0]?.bytes, 2 * GIB);
  // A slot is recorded by its checkout, one level inside the measured ordinal directory.
  assert.equal(usage.slotBytes(`${ROOT}/worktree-pools/web-0123456789abcdef/1/web`), 2 * GIB);
  assert.equal(usage.slotBytes(`${ROOT}/worktree-pools/web-0123456789abcdef/2/web`), null);
});

test("a slot recorded through a symlinked home is still matched to its measured size", async () => {
  const real = mkdtempSync(join(tmpdir(), "mission-storage-real-"));
  const linked = join(mkdtempSync(join(tmpdir(), "mission-storage-link-")), "home");
  symlinkSync(real, linked);
  mkdirSync(join(real, "worktree-pools", "web-0123456789abcdef", "1", "web"), { recursive: true });
  const usage = new StorageUsageMonitor({
    root: real,
    listDirectories: async () => ({
      directories: new Map([["", GIB], ["worktree-pools/web-0123456789abcdef/1", GIB / 2]]),
      partial: null,
    }),
    fileBytes: () => null,
    onChange: () => {},
  });
  await usage.measure();
  assert.equal(usage.slotBytes(join(linked, "worktree-pools", "web-0123456789abcdef", "1", "web")), GIB / 2);
});

test("the volume reading moves only once free space has moved by 64 MiB", async () => {
  let free = 40 * GIB;
  let changes = 0;
  const usage = new StorageUsageMonitor({
    root: ROOT,
    listDirectories: async () => ({ directories: new Map([["", GIB]]), partial: null }),
    volume: async () => ({ totalBytes: 500 * GIB, freeBytes: free }),
    onChange: () => { changes += 1; },
  });
  await usage.checkVolume();
  assert.equal(changes, 1);
  free -= 10 * 1024 * 1024;
  await usage.checkVolume();
  assert.equal(changes, 1, "a 10 MiB wobble publishes nothing");
  assert.equal(usage.volume()?.freeBytes, 40 * GIB);
  free -= 100 * 1024 * 1024;
  await usage.checkVolume();
  assert.equal(changes, 2);
  assert.equal(usage.volume()?.freeBytes, 40 * GIB - 110 * 1024 * 1024);
});

test("while a storage limit is set, a gigabyte of lost free space or an hour's age starts an early walk, at most every 15 minutes", async () => {
  let free = 40 * GIB;
  let clock = 0;
  let walks = 0;
  let limitSet = true;
  const usage = new StorageUsageMonitor({
    root: ROOT,
    listDirectories: async () => {
      walks += 1;
      return { directories: new Map([["", GIB]]), partial: null };
    },
    volume: async () => ({ totalBytes: 500 * GIB, freeBytes: free }),
    now: () => clock,
    // A fixed 1 GiB answer while "a limit is set", to pin the walk's own gating and spacing.
    remeasureGrowthBytes: () => (limitSet ? GIB : null),
    onChange: () => {},
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  await usage.checkVolume();
  await usage.measure();
  assert.equal(walks, 1);

  // Half a gigabyte lost: not enough to walk again.
  clock = 20 * 60 * 1_000;
  free -= GIB / 2;
  await usage.checkVolume();
  await settle();
  assert.equal(walks, 1);

  // A gigabyte and a half lost since the walk began: walk again now, not in six hours.
  free -= GIB;
  await usage.checkVolume();
  await settle();
  assert.equal(walks, 2);

  // Another gigabyte, but only five minutes after that walk began: wait for the interval.
  clock += 5 * 60 * 1_000;
  free -= GIB;
  await usage.checkVolume();
  await settle();
  assert.equal(walks, 2);
  clock += 15 * 60 * 1_000;
  await usage.checkVolume();
  await settle();
  assert.equal(walks, 3);

  // Far from the threshold and with free space steady, the walk still runs once it is an hour old.
  clock += 59 * 60 * 1_000;
  await usage.checkVolume();
  await settle();
  assert.equal(walks, 3, "under an hour since the last walk, with nothing lost");
  clock += 60 * 1_000;
  await usage.checkVolume();
  await settle();
  assert.equal(walks, 4, "an hour on, it runs whatever free space did");

  // With no storage limit set, neither lost free space nor age starts a walk.
  limitSet = false;
  clock += 3 * 60 * 60 * 1_000;
  free -= 10 * GIB;
  await usage.checkVolume();
  await settle();
  assert.equal(walks, 4);
});

test("the early-walk trigger is the distance left to the next threshold, at most a GiB", () => {
  const MIB = 1024 ** 2;
  const limits = (limitBytes: number | null, warnAtPercent = 90) => ({ ...DEFAULT_STORAGE_LIMITS_CONFIG, limitBytes, warnAtPercent });
  // No limit: lost free space never starts a walk.
  assert.equal(remeasureGrowthFor(limits(null), 10 * GIB), null);
  // A quarter-GiB limit warns at 230.4 MiB. Measured at 30 MiB, 200.4 MiB of growth crosses it.
  assert.equal(remeasureGrowthFor(limits(GIB / 4), 30 * MIB), Math.floor(GIB / 4 * 0.9) - 30 * MIB);
  // Far from a large limit: the 1 GiB cap.
  assert.equal(remeasureGrowthFor(limits(60 * GIB), 10 * GIB), GIB);
  // Past the warning but under the limit: the distance to the limit, where the message turns to "over".
  assert.equal(remeasureGrowthFor(limits(60 * GIB), 59.5 * GIB), GIB / 2);
  // Past both: the cap keeps the "over" figure current.
  assert.equal(remeasureGrowthFor(limits(60 * GIB), 70 * GIB), GIB);
});

test("close to a threshold the walk runs every 15 minutes even while free space holds steady", async () => {
  const MIB = 1024 ** 2;
  const free = 40 * GIB;
  let clock = 0;
  let walks = 0;
  const limit = { ...DEFAULT_STORAGE_LIMITS_CONFIG, limitBytes: GIB / 4 };
  const usage = new StorageUsageMonitor({
    root: ROOT,
    listDirectories: async () => {
      walks += 1;
      return { directories: new Map([["", 30 * MIB]]), partial: null };
    },
    // Steady: whatever the state directory writes, something else on the volume frees as much.
    volume: async () => ({ totalBytes: 500 * GIB, freeBytes: free }),
    now: () => clock,
    remeasureGrowthBytes: (measured) => remeasureGrowthFor(limit, measured),
    onChange: () => {},
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  await usage.checkVolume();
  await usage.measure();
  assert.equal(walks, 1);

  clock = 10 * 60 * 1_000;
  await usage.checkVolume();
  await settle();
  assert.equal(walks, 1, "within the 15-minute spacing nothing runs");
  // 30 MiB measured against a 230.4 MiB warning is within a GiB of it: due again at 15 minutes.
  clock = 15 * 60 * 1_000;
  await usage.checkVolume();
  await settle();
  assert.equal(walks, 2, "growth hidden by space freed elsewhere is caught within a quarter hour");
});

test("a reading that crosses the free-space floor is taken at once, however small the move", async () => {
  const MIB = 1024 ** 2;
  let free = 10 * GIB + 10 * MIB;
  let changes = 0;
  const usage = new StorageUsageMonitor({
    root: ROOT,
    listDirectories: async () => ({ directories: new Map([["", GIB]]), partial: null }),
    volume: async () => ({ totalBytes: 500 * GIB, freeBytes: free }),
    volumeThresholds: () => [10 * GIB],
    onChange: () => { changes += 1; },
  });
  await usage.checkVolume();
  assert.equal(changes, 1);
  // 20 MiB down, from just above the 10 GiB floor to just below it: taken despite the 64 MiB step.
  free -= 20 * MIB;
  await usage.checkVolume();
  assert.equal(changes, 2);
  assert.equal(usage.volume()?.freeBytes, 10 * GIB - 10 * MIB);
  // A further small move on the same side of the floor is still held.
  free -= 5 * MIB;
  await usage.checkVolume();
  assert.equal(changes, 2);
  // And the floor is judged from that reading: the warning starts.
  const { service } = healthWith({ totalBytes: 50 * GIB, volume: usage.volume() });
  assert.deepEqual(service.recompute().problems.map((problem) => problem.kind), ["low-free-space"]);
});

test("a change in kept backup copies moves the totals by that change, keeping the measured temporary files", () => {
  // The walk measured 10 GiB in backups/database: 9 GiB of kept copies and a 1 GiB temporary.
  let copies = [GIB * 3, GIB * 3, GIB * 3].map((bytes, index) => ({
    kind: "scheduled" as const,
    filename: `scheduled-${index}`,
    at: index,
    bytes,
    diskBytes: bytes,
  }));
  const published: StorageHealth[] = [];
  const service = new StorageHealthService({
    backups: { status: () => databaseBackupStatusFrom(undefined), keptCopies: () => copies },
    usage: {
      usage: () => ({
        root: ROOT,
        measuredAt: 1,
        durationMs: 1,
        measuring: false,
        error: null,
        totalBytes: 50 * GIB,
        categories: [{ id: "backups", bytes: 10 * GIB }, { id: "other", bytes: 40 * GIB }],
        pools: [],
      }),
      volume: () => volume(80),
    },
    publish: (health) => published.push(health),
  });
  const backups = (health: StorageHealth) => health.usage.categories.find((category) => category.id === "backups")?.bytes;
  const first = service.recompute();
  assert.equal(backups(first), 10 * GIB, "right after the walk, its own figure stands");
  assert.equal(first.usage.totalBytes, 50 * GIB);
  // A save prunes one 3 GiB copy: the category and total drop by 3 GiB, and the temporary stays counted.
  copies = copies.slice(1);
  const after = service.recompute();
  assert.equal(backups(after), 7 * GIB);
  assert.equal(after.usage.totalBytes, 47 * GIB);
});

test("a pruned sparse copy moves the totals by the disk space it held, not by its file size", () => {
  const MIB = 1024 ** 2;
  // Three 3 GiB copies that are sparse: each occupies 1 MiB on disk, which is all the walk saw.
  let copies = [0, 1, 2].map((index) => ({ kind: "scheduled" as const, filename: `scheduled-${index}`, at: index, bytes: 3 * GIB, diskBytes: MIB }));
  const service = new StorageHealthService({
    backups: {
      status: () => databaseBackupStatusFrom(undefined),
      keptCopies: () => copies,
      keptDiskBytes: () => copies.length * MIB,
    },
    usage: {
      usage: () => ({
        root: ROOT,
        measuredAt: 1,
        durationMs: 1,
        measuring: false,
        error: null,
        totalBytes: 50 * GIB,
        categories: [{ id: "backups", bytes: 3 * MIB }, { id: "other", bytes: 50 * GIB - 3 * MIB }],
        pools: [],
      }),
      volume: () => volume(80),
    },
    publish: () => {},
  });
  service.recompute();
  copies = copies.slice(1);
  const after = service.recompute();
  assert.equal(after.usage.categories.find((category) => category.id === "backups")?.bytes, 2 * MIB);
  assert.equal(after.usage.totalBytes, 50 * GIB - MIB, "1 MiB came off the total, not the copy's 3 GiB file size");
  assert.equal(after.usage.categories.find((category) => category.id === "other")?.bytes, 50 * GIB - 3 * MIB, "no other category is hidden");
});

test("a backup captured while the walk runs is in the measurement it publishes, and in no later delta", async () => {
  // du passed backups/database before the capture landed: it listed 1 GiB, the folder now holds 2.
  let kept = GIB;
  const usage = new StorageUsageMonitor({
    root: ROOT,
    listDirectories: async () => {
      const listing = {
        directories: new Map([["", 10 * GIB], ["backups", GIB], ["backups/database", GIB]]),
        partial: null,
      };
      kept = 2 * GIB; // the capture lands after du's visit, before the walk ends
      return listing;
    },
    directoryBytes: (path) => (path === `${ROOT}/backups/database` ? kept : null),
    fileBytes: () => null,
    onChange: () => {},
  });
  await usage.measure();
  const view = usage.usage();
  assert.equal(view.totalBytes, 11 * GIB, "the root moved by the same difference");
  assert.equal(view.categories.find((category) => category.id === "backups")?.bytes, 2 * GIB);

  // Storage takes its kept-copies baseline in that same step, so the new copy is not lost.
  const health = new StorageHealthService({
    backups: {
      status: () => databaseBackupStatusFrom(undefined),
      keptCopies: () => [],
      keptDiskBytes: () => kept,
    },
    usage,
    publish: () => {},
  });
  assert.equal(health.recompute().usage.categories.find((category) => category.id === "backups")?.bytes, 2 * GIB);
});

test("settling leaves a listing alone when the folder is unchanged or unreadable", () => {
  const listing = { directories: new Map([["", 5 * GIB], ["backups", GIB], ["backups/database", GIB]]), partial: null };
  assert.deepEqual([...settleListing(listing, ROOT, () => GIB).directories], [...listing.directories]);
  assert.deepEqual([...settleListing(listing, ROOT, () => null).directories], [...listing.directories]);
  // A folder that shrank moves its ancestors down, never below zero.
  const shrunk = settleListing(listing, ROOT, () => 0);
  assert.equal(shrunk.directories.get(""), 4 * GIB);
  assert.equal(shrunk.directories.get("backups"), 0);
});

test("a state directory reached through a symlink is measured through it, contents and slots included", async () => {
  const MIB = 1024 ** 2;
  const real = mkdtempSync(join(tmpdir(), "mission-storage-real-home-"));
  const linkParent = mkdtempSync(join(tmpdir(), "mission-storage-link-home-"));
  const linked = join(linkParent, "home");
  symlinkSync(real, linked);
  const slot = join(real, "worktree-pools", "web-0123456789abcdef", "1", "web");
  mkdirSync(slot, { recursive: true });
  writeFileSync(join(slot, "blob"), Buffer.alloc(2 * MIB, 1));
  try {
    // The real `du`, given the link as the root.
    const usage = new StorageUsageMonitor({ root: linked, onChange: () => {} });
    await usage.measure();
    const view = usage.usage();
    assert.equal(view.error, null);
    assert.ok((view.totalBytes ?? 0) >= 2 * MIB, `measured ${view.totalBytes} through the link`);
    assert.ok((view.categories.find((category) => category.id === "pools")?.bytes ?? 0) >= 2 * MIB);
    assert.ok((usage.slotBytes(join(linked, "worktree-pools", "web-0123456789abcdef", "1", "web")) ?? 0) >= 2 * MIB);
  } finally {
    rmSync(linkParent, { recursive: true, force: true });
    rmSync(real, { recursive: true, force: true });
  }
});

// ---- warnings ----

function healthWith(input: {
  totalBytes: number | null;
  volume: StorageVolume | null;
  limits?: Partial<StorageLimitsConfig>;
  alerts?: { state: StorageAlertState };
  now?: () => number;
}) {
  const published: StorageHealth[] = [];
  const store = input.alerts ?? { state: storageAlertStateFrom(undefined) };
  const service = new StorageHealthService({
    backups: { status: () => databaseBackupStatusFrom(undefined), keptCopies: () => [] },
    usage: {
      usage: () => ({
        root: ROOT,
        measuredAt: input.totalBytes === null ? null : 1,
        durationMs: null,
        measuring: false,
        error: null,
        totalBytes: input.totalBytes,
        categories: input.totalBytes === null ? [] : [{ id: "other", bytes: input.totalBytes }],
        pools: [],
      }),
      volume: () => input.volume,
    },
    limits: () => ({ ...DEFAULT_STORAGE_LIMITS_CONFIG, ...input.limits }),
    alerts: { read: () => store.state, write: (state) => { store.state = state; } },
    now: input.now ?? (() => 5_000),
    publish: (health) => published.push(health),
  });
  return { service, published, store };
}

const volume = (freeGib: number): StorageVolume => ({ checkedAt: 1, totalBytes: 500 * GIB, freeBytes: freeGib * GIB });

test("free space under the floor is a low-free-space problem, and the default floor is 10 GiB", () => {
  const { service } = healthWith({ totalBytes: 50 * GIB, volume: volume(8) });
  const health = service.recompute();
  assert.deepEqual(health.problems.map((problem) => problem.id), ["low-free-space:volume:5000"]);
  assert.match(health.problems[0]!.message, /8\.0 GiB free, below your 10 GiB floor/);
  assert.deepEqual(health.problems[0]!.link, { target: "cleanup" });

  const { service: roomy } = healthWith({ totalBytes: 50 * GIB, volume: volume(80) });
  assert.deepEqual(roomy.recompute().problems, []);
});

test("the size warning starts at the warn-at share and says when the limit itself is passed", () => {
  const near = healthWith({ totalBytes: 55 * GIB, volume: volume(80), limits: { limitBytes: 60 * GIB, warnAtPercent: 90 } });
  assert.match(near.service.recompute().problems[0]!.message, /55 GiB, 92% of your 60 GiB limit/);
  const over = healthWith({ totalBytes: 61 * GIB, volume: volume(80), limits: { limitBytes: 60 * GIB } });
  assert.match(over.service.recompute().problems[0]!.message, /over your 60 GiB limit/);
  const under = healthWith({ totalBytes: 50 * GIB, volume: volume(80), limits: { limitBytes: 60 * GIB } });
  assert.deepEqual(under.service.recompute().problems, []);
});

test("a standing warning keeps its id across a restart and through a moment with no reading", () => {
  const store = { state: storageAlertStateFrom(undefined) };
  let clock = 5_000;
  const first = healthWith({ totalBytes: 50 * GIB, volume: volume(8), alerts: store, now: () => clock });
  assert.equal(first.service.recompute().problems[0]?.id, "low-free-space:volume:5000");

  // A restarted daemon has not checked the volume yet: no problem shown, but the occurrence stands.
  clock = 9_000;
  const restarted = healthWith({ totalBytes: null, volume: null, alerts: store, now: () => clock });
  assert.deepEqual(restarted.service.recompute().problems, []);
  assert.equal(store.state.lowFreeSpaceSince, 5_000);

  const checked = healthWith({ totalBytes: 50 * GIB, volume: volume(7), alerts: store, now: () => clock });
  assert.equal(checked.service.recompute().problems[0]?.id, "low-free-space:volume:5000", "the same occurrence, not a new one");

  // Cleared, then back: a new occurrence with a new id.
  healthWith({ totalBytes: 50 * GIB, volume: volume(30), alerts: store, now: () => clock }).service.recompute();
  assert.equal(store.state.lowFreeSpaceSince, null);
  clock = 12_000;
  const again = healthWith({ totalBytes: 50 * GIB, volume: volume(6), alerts: store, now: () => clock });
  assert.equal(again.service.recompute().problems[0]?.id, "low-free-space:volume:12000");

  // Switching the floor off ends the occurrence outright.
  healthWith({ totalBytes: 50 * GIB, volume: volume(6), alerts: store, limits: { freeFloorBytes: null } }).service.recompute();
  assert.equal(store.state.lowFreeSpaceSince, null);
});

// ---- routes ----

function app(deps: Partial<Parameters<typeof buildApp>[0]> = {}) {
  return buildApp({
    registry: new Registry(),
    reviews: {} as ReviewManager,
    tasks: {} as TaskManager,
    queues: {} as QueueManager,
    ...deps,
  });
}
const HEADERS = { host: "127.0.0.1:7317", "content-type": "application/json" };

test("PUT /api/storage/limits saves only what was sent, publishes the new thresholds, and refuses nonsense", async () => {
  const { service, published } = healthWith({ totalBytes: 55 * GIB, volume: volume(80) });
  // Read the saved limits rather than the fixture's, as the daemon does.
  const live = new StorageHealthService({
    backups: { status: () => databaseBackupStatusFrom(undefined), keptCopies: () => [] },
    usage: { usage: () => service.current().usage, volume: () => volume(80) },
    limits: getStorageLimitsConfig,
    publish: (health) => published.push(health),
  });
  const routes = app({ storageHealth: live });

  const saved = await routes.request("/api/storage/limits", {
    method: "PUT",
    headers: HEADERS,
    body: JSON.stringify({ limitBytes: 60 * GIB }),
  });
  assert.equal(saved.status, 200);
  const body = await saved.json() as { limits: StorageLimitsConfig };
  assert.equal(body.limits.limitBytes, 60 * GIB);
  assert.equal(body.limits.freeFloorBytes, 10 * GIB, "a field not sent keeps its value");
  const last = published.at(-1)!;
  assert.equal(last.limits.limitBytes, 60 * GIB);
  assert.deepEqual(last.problems.map((problem) => problem.kind), ["storage-limit"]);

  for (const bad of [{ limitBytes: 1 }, { warnAtPercent: 20 }, { poolKeepWarm: -1 }, { unknown: true }]) {
    const refused = await routes.request("/api/storage/limits", {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify(bad),
    });
    assert.equal(refused.status, 400, JSON.stringify(bad));
  }
  assert.equal(getStorageLimitsConfig().limitBytes, 60 * GIB);

  const cleared = await routes.request("/api/storage/limits", {
    method: "PUT",
    headers: HEADERS,
    body: JSON.stringify({ limitBytes: null }),
  });
  assert.equal(cleared.status, 200);
  assert.deepEqual(published.at(-1)!.problems, [], "clearing the limit clears its warning");
});

test("Measure now starts a background walk and answers at once; the pool plan needs worktrees", async () => {
  let walks = 0;
  const { usage } = monitor(async () => {
    walks += 1;
    return new Map([["", GIB]]);
  });
  const health = new StorageHealthService({
    backups: { status: () => databaseBackupStatusFrom(undefined), keptCopies: () => [] },
    usage,
    publish: () => {},
  });
  const routes = app({ storageHealth: health, storageUsage: usage });
  const started = await routes.request("/api/storage/usage/measure", { method: "POST", headers: HEADERS });
  assert.equal(started.status, 202);
  // The answer does not wait for the walk; the walk finishes on its own.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(walks, 1);
  assert.equal(usage.usage().totalBytes, GIB);

  const plan = await routes.request("/api/storage/pool-caches", { headers: HEADERS });
  assert.equal(plan.status, 503);
  assert.equal((await plan.json() as { error: string }).error, "worktrees_unavailable");
});
