import { APP_CONFIG_ENTRIES } from "@shared/app-config-entries.ts";
import {
  storageAlertStateFrom,
  storageLimitsConfigFrom,
  StorageLimitsConfigSchema,
  type StorageAlertState,
  type StorageLimitsConfig,
  type StorageLimitsConfigPatch,
} from "@shared/storage-limits.ts";
import { getAppConfig, setAppConfig } from "./db.ts";

/** The current limits, with defaults for anything missing or malformed. */
export function getStorageLimitsConfig(): StorageLimitsConfig {
  return storageLimitsConfigFrom(getAppConfig(APP_CONFIG_ENTRIES.storageLimits));
}

/** Merge a patch over the current limits and persist the result. Saving never deletes anything. */
export function setStorageLimitsConfig(patch: StorageLimitsConfigPatch): StorageLimitsConfig {
  const next = StorageLimitsConfigSchema.parse({ ...getStorageLimitsConfig(), ...patch });
  setAppConfig(APP_CONFIG_ENTRIES.storageLimits, next);
  return next;
}

export function getStorageAlertState(): StorageAlertState {
  return storageAlertStateFrom(getAppConfig(APP_CONFIG_ENTRIES.storageAlerts));
}

export function setStorageAlertState(state: StorageAlertState): void {
  setAppConfig(APP_CONFIG_ENTRIES.storageAlerts, state);
}
