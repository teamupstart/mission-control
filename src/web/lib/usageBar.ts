import { useCallback } from "react";
import { updateUiConfig, useUiConfig } from "./uiConfig.ts";

/**
 * Whether the topbar's fleet-cost / rate-limit strip is folded away.
 *
 * Stored in the daemon (`app_config.ui.usageBarCollapsed`), per machine, alongside the
 * layout and rich-text preferences - see `lib/uiConfig.ts`. Off by default: the strip is
 * useful at a glance, so it starts open and an operator who wants the topbar shorter folds
 * it themselves.
 */
export function useUsageBarCollapsed(): [boolean, (collapsed: boolean) => void] {
  const collapsed = useUiConfig().usageBarCollapsed;
  const set = useCallback((next: boolean) => {
    void updateUiConfig({ usageBarCollapsed: next });
  }, []);
  return [collapsed, set];
}
