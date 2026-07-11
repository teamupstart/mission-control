import { useCallback, useEffect, useState } from "react";
import type { AlertSettings } from "./alerts.ts";

const KEY = "ai-harness.alerts";
const DEFAULTS: AlertSettings = { notifications: false, sound: true, afk: false, digestMinutes: 15 };

function load(): AlertSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<AlertSettings>) };
  } catch {
    return DEFAULTS;
  }
}

/** Alert preferences, persisted per-machine in localStorage. */
export function useAlertSettings(): [AlertSettings, (patch: Partial<AlertSettings>) => void] {
  const [settings, setSettings] = useState<AlertSettings>(load);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(settings));
    } catch {
      /* storage unavailable - keep in-memory only */
    }
  }, [settings]);
  const update = useCallback(
    (patch: Partial<AlertSettings>) => setSettings((s) => ({ ...s, ...patch })),
    [],
  );
  return [settings, update];
}
