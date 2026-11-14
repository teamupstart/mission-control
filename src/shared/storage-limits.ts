import { z } from "zod";
import { partialPatch } from "./zod-shapes.ts";

const GIB = 1024 ** 3;

/** The bounds every byte-valued storage limit is held to: a quarter GiB up to 64 TiB. */
export const STORAGE_LIMIT_BYTES = { min: GIB / 4, max: 64 * 1024 * GIB } as const;

/** How early, as a share of the storage limit, the limit warning starts. */
export const STORAGE_WARN_AT_PERCENT = { min: 50, max: 100 } as const;

/** How many of each pool's most recently used idle slots the idle-cache budget never removes. */
export const STORAGE_POOL_KEEP_WARM = { min: 0, max: 64 } as const;

const limitBytes = z.number().int().min(STORAGE_LIMIT_BYTES.min).max(STORAGE_LIMIT_BYTES.max);

/**
 * Settings > Storage's own limits: when to warn about Mission Control's size and the volume's
 * free space, where to say so, and how much idle native-pool cache may stay warm.
 *
 * Every limit only warns or plans. Crossing one deletes nothing: the idle-cache budget chooses
 * which idle slots a cleanup preview offers, and nothing is removed until that preview is
 * executed. `null` is no limit.
 *
 * The free-space floor ships at 10 GiB so a machine about to run out says so without being set
 * up first. The size limit and the idle-cache budget ship off: they are a choice about how much
 * this machine should spend, and only the operator can make it.
 */
export const StorageLimitsConfigSchema = z.object({
  limitBytes: limitBytes.nullable().default(null),
  warnAtPercent: z
    .number()
    .int()
    .min(STORAGE_WARN_AT_PERCENT.min)
    .max(STORAGE_WARN_AT_PERCENT.max)
    .default(90),
  freeFloorBytes: limitBytes.nullable().default(10 * GIB),
  /** Show the fleet banner while a size or free-space warning stands. */
  fleetBanner: z.boolean().default(true),
  /** Send one desktop notification when a size or free-space warning starts. */
  desktopNotification: z.boolean().default(false),
  poolIdleBudgetBytes: limitBytes.nullable().default(null),
  poolKeepWarm: z
    .number()
    .int()
    .min(STORAGE_POOL_KEEP_WARM.min)
    .max(STORAGE_POOL_KEEP_WARM.max)
    .default(2),
});

export type StorageLimitsConfig = z.output<typeof StorageLimitsConfigSchema>;

export const StorageLimitsConfigPatchSchema = partialPatch(StorageLimitsConfigSchema).strict();

export type StorageLimitsConfigPatch = z.output<typeof StorageLimitsConfigPatchSchema>;

export const DEFAULT_STORAGE_LIMITS_CONFIG: Readonly<StorageLimitsConfig> = Object.freeze(
  StorageLimitsConfigSchema.parse({}),
);

/** A stored value as the config it means. Anything missing or malformed reads as the default. */
export function storageLimitsConfigFrom(stored: unknown): StorageLimitsConfig {
  const parsed = StorageLimitsConfigSchema.safeParse(stored ?? {});
  return parsed.success ? parsed.data : { ...DEFAULT_STORAGE_LIMITS_CONFIG };
}

/** The size at which the limit warning starts, or null without a limit. */
export function storageWarnAtBytes(config: StorageLimitsConfig): number | null {
  if (config.limitBytes === null) return null;
  return Math.floor((config.limitBytes * config.warnAtPercent) / 100);
}

/**
 * When each warning's current occurrence began, in epoch milliseconds, or null while it is
 * clear. Persisted so a daemon restart reports the same occurrence under the same problem id,
 * and a warning that clears and later returns gets a new one.
 */
export const StorageAlertStateSchema = z.object({
  lowFreeSpaceSince: z.number().int().nonnegative().nullable().default(null),
  storageLimitSince: z.number().int().nonnegative().nullable().default(null),
});

export type StorageAlertState = z.output<typeof StorageAlertStateSchema>;

export function storageAlertStateFrom(stored: unknown): StorageAlertState {
  const parsed = StorageAlertStateSchema.safeParse(stored ?? {});
  return parsed.success ? parsed.data : StorageAlertStateSchema.parse({});
}
