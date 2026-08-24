import { z } from "zod";
import {
  APP_CONFIG_ENTRY_LIST,
  appConfigEntryHasSettings,
  type AppConfigEntry,
} from "@shared/app-config-entries.ts";
import type { SettingsBackupDomainId } from "@shared/settings-backup-domains.ts";
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

function logicalConfigValue(entry: AppConfigEntry): unknown {
  switch (entry.capture) {
    case "away": return getAwayConfig();
    case "harnesses": return getHarnessesConfig();
    case "foreman": return getForemanConfig();
    case "ui": return getUiConfig();
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
export function settingPayloadForEntry(entry: AppConfigEntry, logicalValue: unknown): unknown {
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
export function parseSettingPayload(entry: AppConfigEntry, value: unknown): unknown {
  if (entry.classification.kind === "whole") return settingPayloadForEntry(entry, value);
  const record = z.record(z.unknown()).parse(value);
  const normalized = settingPayloadForEntry(entry, record) as Record<string, unknown>;
  if (Object.keys(record).sort().join("\0") !== Object.keys(normalized).sort().join("\0")) {
    throw new TypeError(`Snapshot domain ${entry.backupDomain} has unexpected setting fields`);
  }
  return normalized;
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
