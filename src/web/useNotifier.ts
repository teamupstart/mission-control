import { useEffect, useRef } from "react";
import type { AlertSettings, Fleet } from "./lib/alerts.ts";
import { detectAlerts, digestLine } from "./lib/alerts.ts";
import { playChime } from "./lib/chime.ts";

function canNotify(): boolean {
  return typeof Notification !== "undefined" && Notification.permission === "granted";
}

function notify(title: string, body: string, tag: string): void {
  const n = new Notification(title, { body, tag });
  n.onclick = () => {
    window.focus();
    n.close();
  };
}

/**
 * Watches the live fleet and, on each transition into an attention state, fires a
 * desktop notification + a chime (per settings). The daemon already detects these
 * events and streams them; this just delivers them - zero extra tokens. AFK mode
 * also sends a periodic fleet digest.
 */
export function useNotifier(fleet: Fleet, settings: AlertSettings): void {
  const prevRef = useRef<Fleet | null>(null);
  const fleetRef = useRef(fleet);
  fleetRef.current = fleet;

  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = fleet;
    // Seed on the first snapshot so opening the dashboard doesn't alert for every
    // session that was already waiting.
    if (!prev) return;
    for (const a of detectAlerts(prev, fleet, settings)) {
      if (settings.notifications && canNotify()) notify(a.title, a.body, a.id);
      if (settings.sound) playChime(a.severity);
    }
  }, [fleet, settings]);

  useEffect(() => {
    if (!settings.afk || !settings.notifications) return;
    const ms = Math.max(1, settings.digestMinutes) * 60_000;
    const id = setInterval(() => {
      if (canNotify()) notify("Fleet digest", digestLine(fleetRef.current), "fleet-digest");
    }, ms);
    return () => clearInterval(id);
  }, [settings.afk, settings.notifications, settings.digestMinutes]);
}
