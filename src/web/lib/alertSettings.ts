import { useCallback, useEffect, useState } from "react";

/**
 * Per-machine DELIVERY preferences: how this browser renders alerts it is given.
 *
 * Deliberately does not include away mode. Away state and its thresholds are
 * durable server-side config (see src/server/away/config.ts) because away mode
 * has to survive the tab closing and the stall detector runs in the daemon; what
 * stays here is only what is genuinely local to this browser - whether it may
 * raise an OS notification and whether it may make a sound.
 */
export interface AlertSettings {
  notifications: boolean;
  sound: boolean;
}

const KEY = "mission-control.alerts";
const LEGACY_KEY = "ai-harness.alerts";
const DEFAULTS: AlertSettings = { notifications: false, sound: true };

function load(): AlertSettings {
  try {
    // Fall back to the pre-rename key so saved preferences carry over.
    const raw = localStorage.getItem(KEY) ?? localStorage.getItem(LEGACY_KEY);
    if (!raw) return DEFAULTS;
    // A stored blob from before away mode moved server-side still carries `afk`
    // and `digestMinutes`; picking fields rather than spreading drops them
    // instead of resurrecting a flag nothing reads any more.
    const saved = JSON.parse(raw) as Partial<AlertSettings>;
    return {
      notifications: saved.notifications ?? DEFAULTS.notifications,
      sound: saved.sound ?? DEFAULTS.sound,
    };
  } catch {
    return DEFAULTS;
  }
}

/** Alert delivery preferences, persisted per-machine in localStorage. */
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
