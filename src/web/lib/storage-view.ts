// Settings > Storage's pure view logic: which tab an anchor lands on, how a byte limit reads as
// a GiB field, and what a draft of the backup limits would cost. No React and no fetch, so a test
// drives each rule directly and the panel only arranges what these return.

import {
  backupRetentionLimits,
  planBackupRetention,
  type BackupRetentionPlan,
  type DatabaseBackupsConfig,
} from "@shared/database-backups.ts";
import type { StorageBackupCopy } from "@shared/storage-health.ts";

/** The tabs, in order. Each carries the anchor the settings search and deep links point at. */
export const STORAGE_TABS = [
  { id: "overview", label: "Overview", anchor: "storage/overview", hint: "Problems, free space, and disk use by category" },
  { id: "backups", label: "Backups", anchor: "storage/backups", hint: "Database backup limits, Back up now, and the kept copies" },
  { id: "pools", label: "Pool caches", anchor: "storage/pool-caches", hint: "The idle-cache budget for native worktree pools" },
  { id: "cleanup", label: "Cleanup", anchor: "storage/cleanup", hint: "Exactly what the idle-cache budget would remove, and what blocks it" },
  { id: "warnings", label: "Warnings", anchor: "storage/limits", hint: "The storage limit, the free-space floor, and how you are warned" },
] as const;

export type StorageTabId = (typeof STORAGE_TABS)[number]["id"];

/** Anchors that live inside a tab without being its own. */
const NESTED_ANCHORS: Record<string, StorageTabId> = {
  "storage/problems": "overview",
};

/** The tab a deep link must show before its control can be found, or null for another page. */
export function storageTabForAnchor(anchor: string): StorageTabId | null {
  return STORAGE_TABS.find((tab) => tab.anchor === anchor)?.id ?? NESTED_ANCHORS[anchor] ?? null;
}

const GIB = 1024 ** 3;

/** A byte limit as its GiB field shows it: empty for no limit, at most one decimal. */
export function gibField(bytes: number | null): string {
  if (bytes === null) return "";
  const gib = Math.round((bytes / GIB) * 10) / 10;
  return String(gib);
}

/**
 * A GiB field as the byte limit it means: empty is no limit, and anything that is not a
 * positive number is `undefined`, which the panel reads as "cannot save".
 */
export function parseGibField(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const gib = Number(trimmed);
  if (!Number.isFinite(gib) || gib <= 0) return undefined;
  return Math.round(gib * GIB);
}

/** A whole-number field: empty is `null`, anything else that is not an integer is `undefined`. */
export function parseWholeField(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isInteger(value) ? value : undefined;
}

export interface BackupDraftEffect {
  plan: BackupRetentionPlan<StorageBackupCopy>;
  /** The deleted copies' file sizes, which the size budget is judged by. */
  removedBytes: number;
  /** What deleting them frees on disk: their allocated blocks, smaller than file size if sparse. */
  removedDiskBytes: number;
  /** How far back the oldest kept scheduled copy reaches, before and after, in milliseconds. */
  scheduledReach: { before: number | null; after: number | null };
  /** The oldest kept pre-migration copy, before and after, in epoch milliseconds. */
  preMigrationOldest: { before: number | null; after: number | null };
}

function reach(copies: readonly StorageBackupCopy[], now: number): number | null {
  const scheduled = copies.filter((copy) => copy.kind === "scheduled" && copy.at <= now);
  if (scheduled.length === 0) return null;
  return now - Math.min(...scheduled.map((copy) => copy.at));
}

function oldestPreMigration(copies: readonly StorageBackupCopy[]): number | null {
  const pre = copies.filter((copy) => copy.kind === "preMigration");
  return pre.length === 0 ? null : Math.min(...pre.map((copy) => copy.at));
}

/**
 * What saving a draft of the backup limits would delete, and how much recovery it gives up.
 * Built on the same `planBackupRetention` the daemon prunes with, so the preview and the prune
 * cannot disagree about which copies go.
 */
export function backupDraftEffect(
  copies: readonly StorageBackupCopy[],
  draft: DatabaseBackupsConfig,
  now: number,
): BackupDraftEffect {
  const plan = planBackupRetention(copies, backupRetentionLimits(draft), now);
  return {
    plan,
    removedBytes: plan.remove.reduce((total, copy) => total + copy.bytes, 0),
    removedDiskBytes: plan.remove.reduce((total, copy) => total + copy.diskBytes, 0),
    scheduledReach: { before: reach(copies, now), after: reach(plan.keep, now) },
    preMigrationOldest: { before: oldestPreMigration(copies), after: oldestPreMigration(plan.keep) },
  };
}

/** A span as the recovery-window line reads it: hours under two days, days above. */
export function spanLabel(ms: number | null): string {
  if (ms === null) return "none";
  const hours = Math.round(ms / (60 * 60 * 1_000));
  if (hours < 48) return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  const days = Math.round(hours / 24);
  return `${days} days`;
}
