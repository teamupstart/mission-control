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

/** The copies changed after the operator was shown what the save deletes. Nothing was saved. */
export class StaleBackupPreviewError extends Error {
  constructor(readonly remove: string[]) {
    super("The kept copies changed after this preview, so nothing was saved or deleted.");
  }
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const expected = new Set(left);
  return expected.size === new Set(right).size && right.every((name) => expected.has(name));
}

/**
 * Merge a patch over the current config, persist it, and prune at once, so a lowered limit
 * frees its copies on save rather than at the next capture.
 *
 * With `expectRemove`, the save first recomputes what the prune would delete and refuses with
 * `StaleBackupPreviewError`, storing and deleting nothing, unless that is exactly the list given.
 *
 * The save has succeeded once the config is stored, so a prune failure only warns, as it does
 * at startup: the next capture or startup prunes to the saved limits anyway, and reporting the
 * save as failed would hide that.
 */
export function setDatabaseBackupsConfig(
  patch: DatabaseBackupsConfigPatch,
  backups: Pick<DatabaseBackupService, "prune"> & Partial<Pick<DatabaseBackupService, "plannedRemovals">>,
  expectRemove?: readonly string[],
): DatabaseBackupsConfig {
  const next = DatabaseBackupsConfigSchema.parse({ ...getDatabaseBackupsConfig(), ...patch });
  // Checked and saved in one synchronous step, so no capture can publish or prune between the
  // check and the prune below: what is deleted is exactly what the operator was shown.
  if (expectRemove && backups.plannedRemovals) {
    const planned = backups.plannedRemovals(next);
    if (!sameSet(expectRemove, planned)) throw new StaleBackupPreviewError(planned);
  }
  setAppConfig(CONFIG_ENTRY, next);
  try {
    backups.prune();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[mission-control] database backup prune failed after saving: ${reason}`);
  }
  return next;
}
