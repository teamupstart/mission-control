import { useCallback } from "react";
import { updateUiConfig, useUiConfig, useUiConfigHydrated } from "./uiConfig.ts";

/**
 * The one-time automatic product orientation.
 *
 * The setting starts on for a new profile, and is consumed as soon as the tour opens. Waiting
 * for the daemon-backed config to hydrate keeps a known false preference from flashing a tour
 * while a cold browser cache still contains only the shipped defaults.
 */
export function useGuidedTour(): [enabled: boolean, hydrated: boolean, consume: () => void] {
  const enabled = useUiConfig().guidedTour;
  const hydrated = useUiConfigHydrated();
  const consume = useCallback(() => {
    void updateUiConfig({ guidedTour: false });
  }, []);
  return [enabled, hydrated, consume];
}
