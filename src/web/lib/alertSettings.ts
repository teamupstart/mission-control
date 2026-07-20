import { useCallback } from "react";
import type { UiConfig } from "@shared/protocol.ts";
import { uiConfig, updateUiConfig, useUiConfig } from "./uiConfig.ts";

/**
 * DELIVERY preferences: how this machine renders alerts it is given.
 *
 * Deliberately does not include away mode. Away state and its thresholds are
 * durable server-side config (see src/server/away/config.ts) because away mode
 * has to survive the tab closing and the stall detector runs in the daemon; what
 * stays here is only what is genuinely about output on this machine - whether it
 * may raise an OS notification and whether it may make a sound.
 *
 * Stored in the daemon (`app_config.ui.alerts`) rather than `localStorage`, which is
 * per-origin and was reset by the product rename. The stale `ai-harness.alerts` fallback
 * that used to live here is gone: it named the wrong generation and could never fire, and
 * `lib/uiCache.ts` now walks all three, once. See `lib/uiConfig.ts`.
 */
export type AlertSettings = UiConfig["alerts"];

/** Alert delivery preferences, stored in the daemon. */
export function useAlertSettings(): [AlertSettings, (patch: Partial<AlertSettings>) => void] {
  const alerts = useUiConfig().alerts;
  // Reads the live value out of the store rather than closing over `alerts`, so the
  // callback is stable across renders and two toggles in one tick can't clobber each
  // other. `alerts` is replaced whole, matching the server's shallow field merge.
  const update = useCallback((patch: Partial<AlertSettings>) => {
    void updateUiConfig({ alerts: { ...uiConfig().alerts, ...patch } });
  }, []);
  return [alerts, update];
}
