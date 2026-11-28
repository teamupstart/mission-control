import { updateUiConfig, useUiConfig } from "./uiConfig.ts";

import { type OptionalTopbarItemId, type CompactableTopbarItemId, type TopbarLayout, nextHiddenTopbarItems, nextCompactTopbarItems } from "@shared/topbar-items-settings.ts";
export * from "@shared/topbar-items-settings.ts";

export function setTopbarItemShown(
  hidden: readonly string[],
  id: OptionalTopbarItemId,
  shown: boolean,
): void {
  void updateUiConfig({ hiddenTopbarItems: nextHiddenTopbarItems(hidden, id, shown) });
}

export function setTopbarItemCompact(
  compact: readonly string[],
  id: CompactableTopbarItemId,
  compactNow: boolean,
): void {
  void updateUiConfig({ compactTopbarItems: nextCompactTopbarItems(compact, id, compactNow) });
}

/** Put the bar back the way it shipped, in one write so the preview never shows half of it. */
export function resetTopbarLayout(): void {
  void updateUiConfig({ hiddenTopbarItems: [], compactTopbarItems: [] });
}

/** The live layout, re-rendering on any change from any surface. */
export function useTopbarLayout(): TopbarLayout {
  const config = useUiConfig();
  return { hidden: config.hiddenTopbarItems, compact: config.compactTopbarItems };
}
