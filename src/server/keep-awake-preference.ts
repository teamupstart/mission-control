import { APP_CONFIG_ENTRIES, KeepAwakePreferenceSchema } from "@shared/app-config-entries.ts";
import { getAppConfig, setAppConfig } from "./db.ts";
import type { KeepAwakePreferenceStore } from "./keep-awake.ts";

// The operator's Keep awake choice, as one `app_config` row, so a restart or an upgrade
// finds it where the last daemon left it. It stores the CHOICE only: whether the OS is
// holding the assertion right now is observed by `KeepAwakeManager` and never written here.

const ENTRY = APP_CONFIG_ENTRIES.keepAwake;

/**
 * The production store. A row that is missing, is not JSON, or does not match the schema
 * reads as off: a damaged value must never be the reason this Mac is held awake.
 */
export function keepAwakePreferenceStore(): KeepAwakePreferenceStore {
  return {
    load: () => {
      const parsed = KeepAwakePreferenceSchema.safeParse(getAppConfig(ENTRY));
      return parsed.success && parsed.data.enabled;
    },
    save: (enabled) => setAppConfig(ENTRY, { enabled }),
  };
}
