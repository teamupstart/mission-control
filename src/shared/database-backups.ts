import { z } from "zod";

/** The capture intervals an operator may choose, in hours. */
export const DATABASE_BACKUP_INTERVAL_HOURS = [1, 3, 6, 12, 24] as const;

const scheduledCount = z.number().int().min(1).max(48);
const preMigrationCount = z.number().int().min(1).max(10);
const [firstInterval, secondInterval, ...otherIntervals] = DATABASE_BACKUP_INTERVAL_HOURS;
const intervalHours = z.union([
  z.literal(firstInterval),
  z.literal(secondInterval),
  ...otherIntervals.map((hours) => z.literal(hours)),
]);

const GIB = 1024 ** 3;

/** The smallest and largest size budget, in bytes: a quarter GiB up to 16 TiB. */
export const DATABASE_BACKUP_BUDGET_BOUNDS = { min: GIB / 4, max: 16 * 1024 * GIB } as const;

/** How old a copy of a kind may grow before it is deleted, in whole days. */
export const DATABASE_BACKUP_MAX_AGE_DAYS = { min: 1, max: 365 } as const;

const maxAgeDays = z
  .number()
  .int()
  .min(DATABASE_BACKUP_MAX_AGE_DAYS.min)
  .max(DATABASE_BACKUP_MAX_AGE_DAYS.max)
  .nullable();
const maxTotalBytes = z
  .number()
  .int()
  .min(DATABASE_BACKUP_BUDGET_BOUNDS.min)
  .max(DATABASE_BACKUP_BUDGET_BOUNDS.max)
  .nullable();

/**
 * How many full-database recovery points of each kind are kept, how old they may grow, how
 * much space all of them together may take, and how often a scheduled one is taken.
 *
 * A count is never 0: every kind always keeps its newest copy. The `manual` kind is not here
 * because it always keeps exactly one copy. An age or size limit of `null` is no limit, which
 * is the default, so a config stored before those limits existed keeps exactly what it kept.
 * Neither limit can delete a copy in the minimum recovery set (`alwaysKeptCounts`).
 */
export const DatabaseBackupsConfigSchema = z.object({
  scheduledCount: scheduledCount.default(3),
  preMigrationCount: preMigrationCount.default(2),
  intervalHours: intervalHours.default(1),
  scheduledMaxAgeDays: maxAgeDays.default(null),
  preMigrationMaxAgeDays: maxAgeDays.default(null),
  maxTotalBytes: maxTotalBytes.default(null),
});

export type DatabaseBackupsConfig = z.output<typeof DatabaseBackupsConfigSchema>;

export const DatabaseBackupsConfigPatchSchema = z
  .object({
    scheduledCount,
    preMigrationCount,
    intervalHours,
    scheduledMaxAgeDays: maxAgeDays,
    preMigrationMaxAgeDays: maxAgeDays,
    maxTotalBytes,
  })
  .partial()
  .strict();

export type DatabaseBackupsConfigPatch = z.output<typeof DatabaseBackupsConfigPatchSchema>;

/** At most this many copies are ever named in one save: every count's maximum, with headroom. */
export const DATABASE_BACKUP_EXPECTED_REMOVALS_MAX = 256;

/**
 * `PUT /api/storage/backups/config`: a patch, and the exact copies the caller expects the save to
 * delete. The daemon recomputes the deletions against its current copies and refuses the save,
 * changing and deleting nothing, unless they match exactly. An absent list means "none": a save
 * that deletes nothing needs no list, and one that would delete copies answers 409 with them,
 * so no caller can prune a copy it was not shown.
 */
export const DatabaseBackupsSaveRequestSchema = DatabaseBackupsConfigPatchSchema.extend({
  expectRemove: z.array(z.string().min(1).max(256)).max(DATABASE_BACKUP_EXPECTED_REMOVALS_MAX).optional(),
}).strict();

export type DatabaseBackupsSaveRequest = z.output<typeof DatabaseBackupsSaveRequestSchema>;

export const DEFAULT_DATABASE_BACKUPS_CONFIG: Readonly<DatabaseBackupsConfig> = Object.freeze(
  DatabaseBackupsConfigSchema.parse({}),
);

/**
 * A stored value as the config it means. Anything missing or malformed reads as the default,
 * so a bad row can never block startup or stop a prune.
 */
export function databaseBackupsConfigFrom(stored: unknown): DatabaseBackupsConfig {
  const parsed = DatabaseBackupsConfigSchema.safeParse(stored ?? {});
  return parsed.success ? parsed.data : { ...DEFAULT_DATABASE_BACKUPS_CONFIG };
}

/** The kinds whose captures the running daemon takes, and therefore records an outcome for. */
export const RECORDED_DATABASE_BACKUP_KINDS = ["scheduled", "manual"] as const;
export type RecordedDatabaseBackupKind = (typeof RECORDED_DATABASE_BACKUP_KINDS)[number];

const epochMs = z.number().int().nonnegative();

export const DatabaseBackupFailureSchema = z.object({
  at: epochMs,
  kind: z.enum(RECORDED_DATABASE_BACKUP_KINDS),
  message: z.string(),
});

/**
 * The durable outcome of one kind's captures, in epoch milliseconds. `failingSince` is the
 * first failure of the current streak, so it is set exactly while that kind is failing. A
 * Back up now failure also counts on the scheduled kind's `consecutiveFailures` and
 * `lastAttemptAt`, so the scheduled backoff sees it, without ever setting the scheduled
 * `failingSince` or `lastFailure`.
 */
export const DatabaseBackupKindStatusSchema = z.object({
  lastAttemptAt: epochMs.nullable().default(null),
  lastSuccessAt: epochMs.nullable().default(null),
  consecutiveFailures: z.number().int().nonnegative().default(0),
  failingSince: epochMs.nullable().default(null),
  lastFailure: DatabaseBackupFailureSchema.nullable().default(null),
});

export type DatabaseBackupKindStatus = z.output<typeof DatabaseBackupKindStatusSchema>;

export const DatabaseBackupStatusSchema = z.object({
  scheduled: DatabaseBackupKindStatusSchema.prefault({}),
  manual: DatabaseBackupKindStatusSchema.prefault({}),
});

export type DatabaseBackupStatus = z.output<typeof DatabaseBackupStatusSchema>;

/** A stored status as the record it means. Anything missing or malformed reads as no history. */
export function databaseBackupStatusFrom(stored: unknown): DatabaseBackupStatus {
  const parsed = DatabaseBackupStatusSchema.safeParse(stored ?? {});
  return parsed.success ? parsed.data : DatabaseBackupStatusSchema.parse({});
}

/** Every kind of kept copy, in the order Settings > Storage lists them. */
export const DATABASE_BACKUP_COPY_KINDS = ["scheduled", "preMigration", "manual"] as const;
export type DatabaseBackupCopyKind = (typeof DATABASE_BACKUP_COPY_KINDS)[number];

/**
 * How many manual copies are kept: exactly one, outside the scheduled and pre-migration counts,
 * and with no age limit of its own. It does count toward the size budget, which is judged across
 * every kind, but as the newest manual copy it is in the minimum recovery set, so the budget never
 * deletes it.
 */
export const MANUAL_BACKUP_COUNT = 1;

/**
 * The most of each kind's newest copies the minimum recovery set holds: the copies no age or
 * size limit may delete. The set a config actually protects is `alwaysKeptCounts`, which caps
 * each kind at its own count: a count is the operator's explicit "keep at most this many", so a
 * pre-migration count of 1 protects one copy, not two. Every count is at least 1, so each kind
 * always protects its newest copy.
 */
export const BACKUP_ALWAYS_KEPT: Readonly<Record<DatabaseBackupCopyKind, number>> = Object.freeze({
  scheduled: 1,
  preMigration: 2,
  manual: 1,
});

/**
 * How many of each kind's newest copies a set of counts protects from the age and size limits.
 * The one answer behind the prune and the Backups tab's "Always kept" line, so the page never
 * promises a copy the prune would delete.
 */
export function alwaysKeptCounts(
  counts: Record<DatabaseBackupCopyKind, number>,
): Record<DatabaseBackupCopyKind, number> {
  return {
    scheduled: Math.min(BACKUP_ALWAYS_KEPT.scheduled, counts.scheduled),
    preMigration: Math.min(BACKUP_ALWAYS_KEPT.preMigration, counts.preMigration),
    manual: Math.min(BACKUP_ALWAYS_KEPT.manual, counts.manual),
  };
}

/** A copy dated further than this past `now` is treated as written under a wrong clock. */
export const DATABASE_BACKUP_FUTURE_TOLERANCE_MS = 60 * 1_000;

const DAY_MS = 24 * 60 * 60 * 1_000;

/** One kept copy as retention reads it. */
export interface RetentionCopy {
  kind: DatabaseBackupCopyKind;
  filename: string;
  /** The capture time its filename names, in epoch milliseconds. */
  at: number;
  bytes: number;
}

/** Why a copy goes: past its kind's count, past its kind's age, or over the size budget. */
export type BackupRemovalReason = "count" | "age" | "size";

export interface BackupRetentionPlan<Copy extends RetentionCopy = RetentionCopy> {
  /** What stays, newest first. */
  keep: Copy[];
  /** What goes, oldest first, each with the first limit that removed it. */
  remove: Array<Copy & { reason: BackupRemovalReason }>;
  /** Filenames in the minimum recovery set. Always a subset of `keep`. */
  alwaysKept: string[];
  /** The size budget is set and the minimum recovery set alone is larger than it. */
  overBudget: boolean;
}

export interface BackupRetentionLimits {
  counts: Record<DatabaseBackupCopyKind, number>;
  maxAgeDays: Record<Exclude<DatabaseBackupCopyKind, "manual">, number | null>;
  maxTotalBytes: number | null;
}

export function backupRetentionLimits(config: DatabaseBackupsConfig): BackupRetentionLimits {
  return {
    counts: {
      scheduled: config.scheduledCount,
      preMigration: config.preMigrationCount,
      manual: MANUAL_BACKUP_COUNT,
    },
    maxAgeDays: {
      scheduled: config.scheduledMaxAgeDays,
      preMigration: config.preMigrationMaxAgeDays,
    },
    maxTotalBytes: config.maxTotalBytes,
  };
}

/**
 * Which copies a set of limits keeps. The one decision behind both the daemon's prune and the
 * page's "Saving deletes N copies" preview, so the two cannot disagree.
 *
 * The limits apply in order: each kind's count keeps its newest copies, then each kind's age
 * limit removes older ones, then the size budget removes the oldest of what is left, across
 * every kind, until the rest fits. Age and size never touch the minimum recovery set; when
 * that set alone is over the budget, nothing more is removed and `overBudget` says so.
 *
 * Newest is by the time a filename names, except that a copy dated in the future, left by a
 * clock that moved backward, sorts as the oldest: it is the first one expired once newer
 * copies exist, and no age limit can judge it.
 */
export function planBackupRetention<Copy extends RetentionCopy>(
  copies: readonly Copy[],
  limits: BackupRetentionLimits,
  nowMs: number,
): BackupRetentionPlan<Copy> {
  const horizon = nowMs + DATABASE_BACKUP_FUTURE_TOLERANCE_MS;
  const rank = (copy: Copy) => (copy.at > horizon ? -Infinity : copy.at);
  const newestFirst = (left: Copy, right: Copy) =>
    rank(right) - rank(left) || right.filename.localeCompare(left.filename);

  const remove: Array<Copy & { reason: BackupRemovalReason }> = [];
  const alwaysKept = new Set<string>();
  const protectedCount = alwaysKeptCounts(limits.counts);
  let kept: Copy[] = [];
  for (const kind of DATABASE_BACKUP_COPY_KINDS) {
    const ofKind = copies.filter((copy) => copy.kind === kind).sort(newestFirst);
    const count = limits.counts[kind];
    ofKind.slice(0, protectedCount[kind]).forEach((copy) => alwaysKept.add(copy.filename));
    for (const copy of ofKind.slice(count)) remove.push({ ...copy, reason: "count" });
    const withinCount = ofKind.slice(0, count);
    const days = kind === "manual" ? null : limits.maxAgeDays[kind];
    for (const copy of withinCount) {
      const tooOld = days !== null &&
        rank(copy) !== -Infinity &&
        copy.at < nowMs - days * DAY_MS &&
        !alwaysKept.has(copy.filename);
      if (tooOld) remove.push({ ...copy, reason: "age" });
      else kept.push(copy);
    }
  }

  let overBudget = false;
  if (limits.maxTotalBytes !== null) {
    let total = kept.reduce((sum, copy) => sum + copy.bytes, 0);
    for (const copy of [...kept].sort(newestFirst).reverse()) {
      if (total <= limits.maxTotalBytes) break;
      if (alwaysKept.has(copy.filename)) continue;
      remove.push({ ...copy, reason: "size" });
      total -= copy.bytes;
    }
    const removed = new Set(remove.map((copy) => copy.filename));
    kept = kept.filter((copy) => !removed.has(copy.filename));
    overBudget = total > limits.maxTotalBytes;
  }

  return {
    keep: kept.sort(newestFirst),
    remove: remove.sort((left, right) => newestFirst(right, left)),
    alwaysKept: [...alwaysKept],
    overBudget,
  };
}
