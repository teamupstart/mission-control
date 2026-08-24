import { z } from "zod";
import {
  SETTINGS_BACKUP_DOMAIN_IDS,
  type SettingsBackupDomainId,
} from "./settings-backup-domains.ts";

export const SETTINGS_BACKUP_FORMAT = "mission-control-settings-backup" as const;
export const SETTINGS_BACKUP_FORMAT_VERSION = 1 as const;
export const SETTINGS_BACKUP_READABLE_FORMAT_VERSIONS = [1] as const;
export const SETTINGS_BACKUP_KINDS = ["daily", "pre_restore"] as const;

export const SETTINGS_BACKUP_LIMITS = {
  fileBytes: 16 * 1024 * 1024,
  ownedFiles: 512,
  listResults: 128,
  domains: 32,
  entriesPerCatalog: 5_000,
  errorCharacters: 500,
  previewItems: 64,
} as const;

export const SETTINGS_BACKUP_RETENTION = {
  daily: 90,
  pre_restore: 10,
} as const;

export const SettingsBackupKindSchema = z.enum(SETTINGS_BACKUP_KINDS);
export type SettingsBackupKind = z.infer<typeof SettingsBackupKindSchema>;

export const SettingsBackupLocalDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const SettingsBackupDailyIdSchema = z.string().regex(/^daily-\d{4}-\d{2}-\d{2}$/);
export const SettingsBackupSafetyIdSchema = z.string().regex(
  /^pre-restore-\d{8}T\d{6}\.\d{3}Z-[a-f0-9]{12}$/,
);
export const SettingsBackupIdSchema = z.union([
  SettingsBackupDailyIdSchema,
  SettingsBackupSafetyIdSchema,
]);
export const SettingsBackupFilenameSchema = z.string().refine((value) => {
  if (!value.endsWith(".json")) return false;
  return SettingsBackupIdSchema.safeParse(value.slice(0, -5)).success;
}, "Invalid settings backup filename");

const domainIds = SETTINGS_BACKUP_DOMAIN_IDS as [
  SettingsBackupDomainId,
  ...SettingsBackupDomainId[],
];

export const SettingsBackupJsonValueSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string(),
  z.array(SettingsBackupJsonValueSchema),
  z.record(SettingsBackupJsonValueSchema),
]));

export const SettingsBackupDomainEntrySchema = z.object({
  domain: z.enum(domainIds),
  version: z.number().int().positive(),
  payload: SettingsBackupJsonValueSchema,
}).strict();

export const SettingsBackupCountsSchema = z.object({
  personas: z.number().int().nonnegative().max(SETTINGS_BACKUP_LIMITS.entriesPerCatalog),
  sessionActions: z.number().int().nonnegative().max(SETTINGS_BACKUP_LIMITS.entriesPerCatalog),
  workflowCommands: z.number().int().nonnegative().max(SETTINGS_BACKUP_LIMITS.entriesPerCatalog),
  workflowDefinitions: z.number().int().nonnegative().max(SETTINGS_BACKUP_LIMITS.entriesPerCatalog),
  workflowVersions: z.number().int().nonnegative().max(SETTINGS_BACKUP_LIMITS.entriesPerCatalog),
}).strict();

const SettingsBackupEnvelopeV1BaseSchema = z.object({
  format: z.literal(SETTINGS_BACKUP_FORMAT),
  formatVersion: z.literal(SETTINGS_BACKUP_FORMAT_VERSION),
  id: SettingsBackupIdSchema,
  kind: SettingsBackupKindSchema,
  createdAt: z.string().datetime({ offset: true }),
  localDate: SettingsBackupLocalDateSchema,
  appVersion: z.string().min(1).max(100),
  domains: z.array(SettingsBackupDomainEntrySchema).max(SETTINGS_BACKUP_LIMITS.domains),
  counts: SettingsBackupCountsSchema,
}).strict();

function refineEnvelopeIdentity(
  value: z.infer<typeof SettingsBackupEnvelopeV1BaseSchema>,
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<SettingsBackupDomainId>();
  for (const entry of value.domains) {
    if (seen.has(entry.domain)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["domains"],
        message: `Duplicate settings backup domain: ${entry.domain}`,
      });
    }
    seen.add(entry.domain);
  }
  if (value.kind === "daily" && value.id !== `daily-${value.localDate}`) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["id"],
      message: "Daily backup id must match its local date",
    });
  }
  if (value.kind === "pre_restore" && !SettingsBackupSafetyIdSchema.safeParse(value.id).success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["id"],
      message: "Pre-restore backup must use a safety id",
    });
  }
}

export const SettingsBackupEnvelopeBodyV1Schema = SettingsBackupEnvelopeV1BaseSchema
  .superRefine(refineEnvelopeIdentity);

export const SettingsBackupEnvelopeV1Schema = SettingsBackupEnvelopeV1BaseSchema.extend({
  digest: z.string().regex(/^[a-f0-9]{64}$/),
}).superRefine(refineEnvelopeIdentity);

export type SettingsBackupEnvelopeBodyV1 = z.infer<typeof SettingsBackupEnvelopeBodyV1Schema>;
export type SettingsBackupEnvelopeV1 = z.infer<typeof SettingsBackupEnvelopeV1Schema>;

export const SettingsRestoreCatalogChangesSchema = z.object({
  added: z.number().int().nonnegative(),
  changed: z.number().int().nonnegative(),
  archived: z.number().int().nonnegative(),
  reactivated: z.number().int().nonnegative(),
}).strict();

export const SettingsRestoreVersionChangesSchema = z.object({
  inserted: z.number().int().nonnegative(),
  retained: z.number().int().nonnegative(),
}).strict();

export const SettingsRestorePreviewSchema = z.object({
  snapshotId: SettingsBackupIdSchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  settingsDomains: z.array(z.enum(domainIds)).max(SETTINGS_BACKUP_LIMITS.domains),
  personas: SettingsRestoreCatalogChangesSchema,
  sessionActions: SettingsRestoreCatalogChangesSchema,
  workflowCommandsChanged: z.number().int().nonnegative(),
  workflows: SettingsRestoreCatalogChangesSchema,
  workflowVersions: SettingsRestoreVersionChangesSchema,
  externalEffects: z.array(z.enum(["skills", "cost"])).max(2),
  exclusions: z.array(z.string().max(200)).max(SETTINGS_BACKUP_LIMITS.previewItems),
  warnings: z.array(z.string().max(SETTINGS_BACKUP_LIMITS.errorCharacters))
    .max(SETTINGS_BACKUP_LIMITS.previewItems),
  blockers: z.array(z.string().max(SETTINGS_BACKUP_LIMITS.errorCharacters))
    .max(SETTINGS_BACKUP_LIMITS.previewItems),
}).strict();
export type SettingsRestorePreview = z.infer<typeof SettingsRestorePreviewSchema>;

const SettingsRestoreFailureSchema = z.object({
  reason: z.string().min(1).max(SETTINGS_BACKUP_LIMITS.errorCharacters),
}).strict();

export const SettingsRestorePreviewResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready"), preview: SettingsRestorePreviewSchema }).strict(),
  z.object({ status: z.literal("preflight_blocked"), preview: SettingsRestorePreviewSchema }).strict(),
  z.object({ status: z.literal("not_found") }).merge(SettingsRestoreFailureSchema),
  z.object({ status: z.literal("incompatible") }).merge(SettingsRestoreFailureSchema),
  z.object({ status: z.literal("io_error") }).merge(SettingsRestoreFailureSchema),
]);
export type SettingsRestorePreviewResult = z.infer<typeof SettingsRestorePreviewResultSchema>;

export const SettingsRestoreResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("restored"),
    snapshotId: SettingsBackupIdSchema,
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    restoredAt: z.string().datetime({ offset: true }),
    safetySnapshotId: SettingsBackupSafetyIdSchema,
    warnings: z.array(z.string().max(SETTINGS_BACKUP_LIMITS.errorCharacters))
      .max(SETTINGS_BACKUP_LIMITS.previewItems),
  }).strict(),
  z.object({ status: z.literal("in_progress") }).strict(),
  z.object({ status: z.literal("stale_digest") }).merge(SettingsRestoreFailureSchema),
  z.object({ status: z.literal("preflight_blocked"), preview: SettingsRestorePreviewSchema }).strict(),
  z.object({ status: z.literal("not_found") }).merge(SettingsRestoreFailureSchema),
  z.object({ status: z.literal("incompatible") }).merge(SettingsRestoreFailureSchema),
  z.object({ status: z.literal("io_error") }).merge(SettingsRestoreFailureSchema),
  z.object({ status: z.literal("restore_failed") }).merge(SettingsRestoreFailureSchema),
]);
export type SettingsRestoreResult = z.infer<typeof SettingsRestoreResultSchema>;

export type SettingsBackupCompatibility =
  | { status: "ready"; snapshot: SettingsBackupEnvelopeV1 }
  | { status: "produced_by_newer_build"; reason: string }
  | { status: "corrupt"; reason: string };

export type SettingsBackupFileStatus =
  | SettingsBackupCompatibility["status"]
  | "unreadable";

const looseHeaderSchema = z.object({
  format: z.string(),
  formatVersion: z.number().int(),
  domains: z.array(z.object({
    domain: z.string(),
    version: z.number().int(),
  }).passthrough()),
}).passthrough();

/** Parse enough metadata first so an older reader reports newer data accurately. */
export function inspectSettingsBackupValue(value: unknown): SettingsBackupCompatibility {
  const header = looseHeaderSchema.safeParse(value);
  if (!header.success) return { status: "corrupt", reason: "Snapshot envelope is invalid" };
  if (header.data.format !== SETTINGS_BACKUP_FORMAT) {
    return { status: "corrupt", reason: "Snapshot format is not recognized" };
  }
  if (header.data.formatVersion > SETTINGS_BACKUP_FORMAT_VERSION) {
    return {
      status: "produced_by_newer_build",
      reason: `Snapshot format v${header.data.formatVersion} requires a newer Mission Control`,
    };
  }

  const knownDomains = new Set<string>(SETTINGS_BACKUP_DOMAIN_IDS);
  for (const entry of header.data.domains) {
    if (!knownDomains.has(entry.domain)) {
      return {
        status: "produced_by_newer_build",
        reason: `Snapshot domain ${entry.domain} requires a newer Mission Control`,
      };
    }
    if (entry.version > 1) {
      return {
        status: "produced_by_newer_build",
        reason: `Snapshot domain ${entry.domain} v${entry.version} requires a newer Mission Control`,
      };
    }
  }

  const parsed = SettingsBackupEnvelopeV1Schema.safeParse(value);
  if (!parsed.success) return { status: "corrupt", reason: "Snapshot v1 schema is invalid" };
  return { status: "ready", snapshot: parsed.data };
}

type CanonicalValue = null | boolean | number | string | CanonicalValue[] | {
  [key: string]: CanonicalValue;
};

function canonicalValue(value: unknown, seen: Set<object>, path: string): CanonicalValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON does not support non-finite numbers");
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError(`Canonical JSON does not support ${typeof value} at ${path}`);
  }
  if (seen.has(value)) throw new TypeError("Canonical JSON does not support cycles");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => canonicalValue(item, seen, `${path}[${index}]`));
    }
    const output: Record<string, CanonicalValue> = {};
    for (const key of Object.keys(value).sort()) {
      output[key] = canonicalValue(
        (value as Record<string, unknown>)[key],
        seen,
        `${path}.${key}`,
      );
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

/** Exact UTF-8 text used for snapshot digests and on-disk bytes. */
export function canonicalSettingsBackupJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value, new Set(), "$"));
}

export function settingsBackupFilename(id: string): string {
  const parsed = SettingsBackupIdSchema.parse(id);
  return `${parsed}.json`;
}

export function dailySettingsBackupId(localDate: string): string {
  return SettingsBackupDailyIdSchema.parse(`daily-${SettingsBackupLocalDateSchema.parse(localDate)}`);
}

export function preRestoreSettingsBackupId(createdAt: Date, randomHex: string): string {
  const timestamp = createdAt.toISOString().replace(/[-:]/g, "");
  return SettingsBackupSafetyIdSchema.parse(`pre-restore-${timestamp}-${randomHex}`);
}
