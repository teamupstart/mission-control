import { APP_CONFIG_ENTRIES } from "@shared/app-config-entries.ts";
import {
  DEFAULT_SETUP_BANNER_DISMISSAL,
  SetupBannerDismissalSchema,
  type SetupBannerDismissal,
} from "@shared/setup-catalog.ts";

import { getAppConfig, setAppConfig } from "../db.ts";

const CONFIG_ENTRY = APP_CONFIG_ENTRIES.setupBanner;

/** Invalid legacy or hand-written state fails open to the first-launch reminder. */
export function getSetupBannerDismissal(): SetupBannerDismissal {
  const parsed = SetupBannerDismissalSchema.safeParse(getAppConfig(CONFIG_ENTRY) ?? {});
  return parsed.success ? parsed.data : { ...DEFAULT_SETUP_BANNER_DISMISSAL };
}

export function setSetupBannerDismissal(dismissal: SetupBannerDismissal): void {
  setAppConfig(CONFIG_ENTRY, SetupBannerDismissalSchema.parse(dismissal));
}
