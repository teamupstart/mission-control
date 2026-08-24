import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  APP_CONFIG_ENTRY_LIST,
  appConfigEntryHasSettings,
  type AnyAppConfigEntry,
  type AppConfigEntry,
} from "@shared/app-config-entries.ts";
import type { SettingsBackupDomainId } from "@shared/settings-backup-domains.ts";
import { canonicalSettingsBackupJson } from "@shared/settings-backups.ts";
import { getAwayConfig } from "../away/config.ts";
import { getAppConfig } from "../db.ts";
import { getForemanConfig } from "../foreman/config.ts";
import { getHarnessesConfig } from "../harnesses.ts";
import { standingInstructionsConfig } from "../instructions/config.ts";
import { getUiConfig } from "../ui-config.ts";

export interface SettingsConfigBackupEntry {
  domain: SettingsBackupDomainId;
  version: number;
  payload: unknown;
}

export const SETTINGS_CONFIG_BACKUP_ENTRIES = APP_CONFIG_ENTRY_LIST.filter(
  appConfigEntryHasSettings,
);

export function logicalConfigValue(entry: AppConfigEntry): unknown {
  switch (entry.capture) {
    case "away": return getAwayConfig();
    case "harnesses": return getHarnessesConfig();
    case "foreman": return getForemanConfig();
    case "ui": return getUiConfig(false);
    case "standing": return standingInstructionsConfig();
    case "generic": {
      const stored = getAppConfig(entry);
      return entry.schema.parse(
        stored ?? (entry.classification.kind === "whole" ? undefined : {}),
      );
    }
  }
}

/** Select the complete logical setting partition while dropping derived and operational fields. */
export function settingPayloadForEntry(entry: AnyAppConfigEntry, logicalValue: unknown): unknown {
  if (entry.classification.kind === "whole") {
    if (entry.classification.valueClass !== "setting") {
      throw new TypeError(`${entry.key} is not a settings backup entry`);
    }
    return entry.schema.parse(logicalValue);
  }

  const parsed = entry.schema.parse(logicalValue) as Record<string, unknown>;
  const payload: Record<string, unknown> = {};
  for (const [field, valueClass] of Object.entries(entry.classification.fields)) {
    if (valueClass === "setting" && parsed[field] !== undefined) payload[field] = parsed[field];
  }
  return payload;
}

/** Validate a persisted logical payload against its descriptor and exact setting key set. */
export function parseSettingPayload(entry: AnyAppConfigEntry, value: unknown): unknown {
  if (entry.classification.kind === "whole") return settingPayloadForEntry(entry, value);
  const record = z.record(z.unknown()).parse(value);
  const allowed = new Set(Object.entries(entry.classification.fields)
    .filter(([, valueClass]) => valueClass === "setting")
    .map(([field]) => field));
  const unexpected = Object.keys(record).filter((field) => !allowed.has(field));
  if (unexpected.length > 0) {
    throw new TypeError(`Snapshot domain ${entry.backupDomain} has unexpected setting fields`);
  }
  const normalized = settingPayloadForEntry(entry, record) as Record<string, unknown>;
  return normalized;
}

/** Generic field merge used by restore and by the automatic-coverage contract test. */
export function mergeSettingPayload(
  entry: AnyAppConfigEntry,
  currentLogicalValue: unknown,
  stagedPayload: unknown,
): unknown {
  const current = entry.schema.parse(currentLogicalValue);
  const staged = parseSettingPayload(entry, stagedPayload);
  if (entry.classification.kind === "whole") return entry.schema.parse(staged);
  return entry.schema.parse({
    ...(current as Record<string, unknown>),
    ...(staged as Record<string, unknown>),
  });
}

export interface StagedSettingsConfigRestore {
  domain: SettingsBackupDomainId;
  entry: AppConfigEntry;
  settingPayload: unknown;
  mergedValue: unknown;
  changed: boolean;
}

/** Normalize every staged setting through its owner and merge over current runtime fields. */
export function stageSettingsConfigRestore(
  staged: ReadonlyMap<SettingsBackupDomainId, unknown>,
): StagedSettingsConfigRestore[] {
  return SETTINGS_CONFIG_BACKUP_ENTRIES.map((entry) => {
    if (entry.backupDomain === null) throw new TypeError(`${entry.key} has no backup domain`);
    if (!staged.has(entry.backupDomain)) {
      throw new TypeError(`Snapshot is missing settings domain ${entry.backupDomain}`);
    }
    const current = logicalConfigValue(entry);
    const settingPayload = parseSettingPayload(entry, staged.get(entry.backupDomain));
    const mergedValue = mergeSettingPayload(entry, current, settingPayload);
    return {
      domain: entry.backupDomain,
      entry,
      settingPayload,
      mergedValue,
      changed: canonicalSettingsBackupJson(settingPayloadForEntry(entry, current))
        !== canonicalSettingsBackupJson(settingPayload),
    };
  });
}

/** Write prepared values through the exact handle owned by the outer restore transaction. */
export function restoreSettingsConfigInTransaction(
  db: DatabaseSync,
  staged: readonly StagedSettingsConfigRestore[],
): void {
  const write = db.prepare(
    `INSERT INTO app_config (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
  );
  for (const item of staged) {
    if (!item.changed) continue;
    write.run(item.entry.key, JSON.stringify(item.entry.schema.parse(item.mergedValue)));
  }
}

export function captureSettingsConfig(): SettingsConfigBackupEntry[] {
  return SETTINGS_CONFIG_BACKUP_ENTRIES.map((entry) => {
    if (entry.backupDomain === null) {
      throw new TypeError(`${entry.key} has settings but no backup domain`);
    }
    return {
      domain: entry.backupDomain,
      version: entry.snapshotVersion,
      payload: settingPayloadForEntry(entry, logicalConfigValue(entry)),
    };
  }).sort((left, right) => left.domain.localeCompare(right.domain));
}
