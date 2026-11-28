import { persistConfigPatch } from "../config-patch-storage.ts";
import { APP_CONFIG_ENTRIES } from "@shared/app-config-entries.ts";
import {
  databaseBackupsConfigFrom,
  DatabaseBackupsConfigSchema,
  type DatabaseBackupsConfig,
  type DatabaseBackupsConfigPatch,
} from "@shared/database-backups.ts";
import { getAppConfig } from "../db.ts";
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
  const current = getDatabaseBackupsConfig();
  const next = DatabaseBackupsConfigSchema.parse({ ...current, ...patch });
  // A worker can publish a copy during this save. Use the confirmed list for the
  // deletion so neither a newly published copy nor a clock tick can expand it.
  let confirmedRemovals: string[] | undefined;
  if (expectRemove && backups.plannedRemovals) {
    confirmedRemovals = backups.plannedRemovals(next);
    if (!sameSet(expectRemove, confirmedRemovals)) throw new StaleBackupPreviewError(confirmedRemovals);
  }
  persistConfigPatch(CONFIG_ENTRY, current, next, patch);
  try {
    backups.prune(confirmedRemovals);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[mission-control] database backup prune failed after saving: ${reason}`);
  }
  return next;
}
