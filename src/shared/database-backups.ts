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

/**
 * How many full-database recovery points of each kind are kept, and how often a scheduled one
 * is taken. A count is never 0: every kind always keeps its newest copy. The `manual` kind is
 * not here because it always keeps exactly one copy.
 */
export const DatabaseBackupsConfigSchema = z.object({
  scheduledCount: scheduledCount.default(3),
  preMigrationCount: preMigrationCount.default(2),
  intervalHours: intervalHours.default(1),
});

export type DatabaseBackupsConfig = z.output<typeof DatabaseBackupsConfigSchema>;

export const DatabaseBackupsConfigPatchSchema = z
  .object({ scheduledCount, preMigrationCount, intervalHours })
  .partial()
  .strict();

export type DatabaseBackupsConfigPatch = z.output<typeof DatabaseBackupsConfigPatchSchema>;

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
