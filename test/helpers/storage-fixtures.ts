// A Settings > Storage page with something in every tab, for render tests: a measured state
// directory, a volume under its free-space floor, a size limit it is near, backup copies, and
// an idle-cache plan that removes one slot and is blocked on another.

import type { StorageHealth, IdleCachePlan } from "../../src/shared/storage-health.ts";
import { DEFAULT_DATABASE_BACKUPS_CONFIG, databaseBackupStatusFrom } from "../../src/shared/database-backups.ts";
import { DEFAULT_STORAGE_LIMITS_CONFIG } from "../../src/shared/storage-limits.ts";
import type {
  IdleCacheActions,
  IdleCacheState,
  StorageActions,
  StorageState,
} from "../../src/web/useStorage.ts";

export const GIB = 1024 ** 3;
export const NOW = Date.parse("2026-11-13T18:00:00.000Z");
const HOUR = 60 * 60 * 1_000;

export function storageHealthFixture(overrides: Partial<StorageHealth> = {}): StorageHealth {
  return {
    backups: {
      status: databaseBackupStatusFrom({ scheduled: { lastSuccessAt: NOW - HOUR } }),
      copies: [
        { kind: "scheduled", filename: "scheduled-20261113T170000000Z-a.sqlite3", at: NOW - HOUR, bytes: GIB / 2, diskBytes: GIB / 2 },
        { kind: "scheduled", filename: "scheduled-20261113T160000000Z-b.sqlite3", at: NOW - 2 * HOUR, bytes: GIB / 2, diskBytes: GIB / 2 },
        { kind: "scheduled", filename: "scheduled-20261113T150000000Z-c.sqlite3", at: NOW - 3 * HOUR, bytes: GIB / 2, diskBytes: GIB / 2 },
        { kind: "preMigration", filename: "pre-migration-20261108T000000000Z-d.sqlite3", at: NOW - 130 * HOUR, bytes: GIB / 2, diskBytes: GIB / 2 },
      ],
      totalBytes: 2 * GIB,
    },
    usage: {
      root: "/Users/operator/.mission-control",
      measuredAt: NOW - 2 * 60 * 1_000,
      durationMs: 41_000,
      measuring: false,
      error: null,
      totalBytes: 54 * GIB,
      categories: [
        { id: "pools", bytes: 31 * GIB },
        { id: "backups", bytes: 2 * GIB },
        { id: "updates", bytes: 4 * GIB },
        { id: "database", bytes: 1 * GIB },
        { id: "evidence", bytes: GIB / 2 },
        { id: "worktrees", bytes: GIB / 4 },
        { id: "archives", bytes: GIB / 8 },
        { id: "other", bytes: 15 * GIB + GIB / 8 },
      ],
      pools: [{ name: "mission-control-b5174d00f600a624", bytes: 31 * GIB }],
    },
    volume: { checkedAt: NOW, totalBytes: 494 * GIB, freeBytes: 8 * GIB },
    limits: { ...DEFAULT_STORAGE_LIMITS_CONFIG, limitBytes: 60 * GIB, poolIdleBudgetBytes: 2 * GIB },
    problems: [
      {
        id: "low-free-space:volume:1",
        kind: "low-free-space",
        message: "The volume holding Mission Control has 8.0 GiB free, below your 10 GiB floor.",
        link: { target: "cleanup" },
      },
      {
        id: "storage-limit:state:1",
        kind: "storage-limit",
        message: "Mission Control uses 54 GiB, 90% of your 60 GiB limit.",
        link: { target: "cleanup" },
      },
    ],
    ...overrides,
  };
}

export const IDLE_PLAN: IdleCachePlan = {
  observedAt: NOW,
  sizesMeasuredAt: NOW - 2 * 60 * 1_000,
  budgetBytes: 2 * GIB,
  keepWarm: 2,
  pools: [{
    poolId: "pool-1",
    name: "mission-control",
    path: "/Users/operator/.mission-control/worktree-pools/mission-control-b5174d00f600a624",
    maxSlots: 16,
    leased: 1,
    idle: 4,
    quarantined: 1,
    other: 0,
    bytes: 6 * GIB,
    idleBytes: 4 * GIB,
    unmeasuredIdle: 0,
    remove: 1,
    removeBytes: GIB,
    blocked: 1,
  }],
  idleBytes: 4 * GIB,
  unmeasuredIdle: 0,
  remove: [{
    slotId: "slot-16",
    poolId: "pool-1",
    poolName: "mission-control",
    path: "/Users/operator/.mission-control/worktree-pools/mission-control-b5174d00f600a624/16",
    bytes: GIB,
    lastUsedAt: NOW - 9 * 24 * HOUR,
  }],
  blocked: [{
    slotId: "slot-14",
    poolId: "pool-1",
    poolName: "mission-control",
    path: "/Users/operator/.mission-control/worktree-pools/mission-control-b5174d00f600a624/14",
    bytes: GIB,
    lastUsedAt: NOW - 8 * 24 * HOUR,
    reason: "slot is occupied",
  }],
  freesBytes: GIB,
  afterIdleBytes: 3 * GIB,
  untouched: { leased: 1, leasedBytes: GIB, quarantined: 1, quarantinedBytes: GIB, warm: 2, warmBytes: 2 * GIB },
};

export function storageStateFixture(health: StorageHealth = storageHealthFixture()): StorageState {
  return {
    view: { health, config: { ...DEFAULT_DATABASE_BACKUPS_CONFIG } },
    health,
    loadError: null,
    saving: false,
    savingLimits: false,
    backingUp: false,
    error: null,
    notice: null,
  };
}

export const STORAGE_ACTIONS: StorageActions = {
  save: async () => true,
  saveLimits: async () => true,
  backUpNow: async () => {},
  measure: async () => {},
};

export function idleStateFixture(plan: IdleCachePlan | null = IDLE_PLAN): IdleCacheState {
  return {
    plan,
    current: plan !== null,
    loading: false,
    loadError: null,
    preview: null,
    previewError: null,
    previewChanged: false,
    busy: false,
    notice: null,
  };
}

export const IDLE_ACTIONS: IdleCacheActions = {
  reload: async () => {},
  requestRemoval: async () => {},
  executeRemoval: async () => {},
  closeRemoval: () => {},
};
