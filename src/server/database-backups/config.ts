import { APP_CONFIG_ENTRIES } from "@shared/app-config-entries.ts";
import {
  databaseBackupsConfigFrom,
  DatabaseBackupsConfigSchema,
  type DatabaseBackupsConfig,
  type DatabaseBackupsConfigPatch,
} from "@shared/database-backups.ts";
import { getAppConfig, setAppConfig } from "../db.ts";
import type { DatabaseBackupService } from "./service.ts";

const CONFIG_ENTRY = APP_CONFIG_ENTRIES.backups;

/** The current config, with defaults for anything missing or malformed. */
export function getDatabaseBackupsConfig(): DatabaseBackupsConfig {
  return databaseBackupsConfigFrom(getAppConfig(CONFIG_ENTRY));
}

/**
 * Merge a patch over the current config, persist it, and prune at once, so a lowered count
 * frees its copies on save rather than at the next capture.
 *
 * The save has succeeded once the config is stored, so a prune failure only warns, as it does
 * at startup: the next capture or startup prunes to the saved counts anyway, and reporting the
 * save as failed would hide that.
 */
export function setDatabaseBackupsConfig(
  patch: DatabaseBackupsConfigPatch,
  backups: Pick<DatabaseBackupService, "prune">,
): DatabaseBackupsConfig {
  const next = DatabaseBackupsConfigSchema.parse({ ...getDatabaseBackupsConfig(), ...patch });
  setAppConfig(CONFIG_ENTRY, next);
  try {
    backups.prune();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[mission-control] database backup prune failed after saving: ${reason}`);
  }
  return next;
}
