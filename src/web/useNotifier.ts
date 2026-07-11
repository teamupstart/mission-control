import { useEffect, useRef } from "react";
import type { AlertSettings, Fleet } from "./lib/alerts.ts";
import { batchSeverity, detectAlerts, digestLine, hasReportable } from "./lib/alerts.ts";
import { playChime } from "./lib/chime.ts";

function canNotify(): boolean {
  return typeof Notification !== "undefined" && Notification.permission === "granted";
}

function notify(title: string, body: string, tag: string): void {
  // Some platforms (e.g. Android Chrome) throw from `new Notification` even when
  // permission is granted (they require the service-worker path); never let that
  // escape the effect / digest timer.
  try {
    const n = new Notification(title, { body, tag });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    /* notifications unavailable on this platform - sound still plays */
  }
}

/**
 * Watches the live fleet and, on each transition into an attention state, fires a
 * desktop notification + a chime (per settings). The daemon already detects these
 * events and streams them; this just delivers them - zero extra tokens. AFK mode
 * also sends a periodic fleet digest.
 *
 * `ready` (the SSE snapshot has landed) gates alerting. `useEventStream` returns
 * empty state on the first render and drops `ready` on disconnect, re-raising it on
 * each (re)connect snapshot. We baseline off the fleet at every ready false->true
 * edge and alert only on later changes - so neither opening the dashboard nor a
 * reconnect after sleep/wake storms for everything that was already/gap-waiting.
 */
export function useNotifier(fleet: Fleet, settings: AlertSettings, ready: boolean): void {
  const prevRef = useRef<Fleet | null>(null);
  const wasReadyRef = useRef(false);
  const fleetRef = useRef(fleet);
  fleetRef.current = fleet;

  useEffect(() => {
    const justConnected = ready && !wasReadyRef.current;
    wasReadyRef.current = ready;
    // Not connected, or the (re)connect snapshot just arrived: (re)baseline, no alert.
    if (!ready || justConnected) {
      prevRef.current = fleet;
      return;
    }
    const prev = prevRef.current ?? fleet;
    prevRef.current = fleet;

    const alerts = detectAlerts(prev, fleet, settings);
    if (alerts.length === 0) return;
    if (settings.notifications && canNotify()) {
      for (const a of alerts) notify(a.title, a.body, a.id);
    }
    // One chime per batch at the most urgent severity, so a same-tick "info" alert
    // can't swallow the "attention" tone via the chime's rate limit.
    if (settings.sound) playChime(batchSeverity(alerts));
  }, [fleet, settings, ready]);

  useEffect(() => {
    if (!settings.afk || !settings.notifications) return;
    const ms = Math.max(1, settings.digestMinutes) * 60_000;
    const id = setInterval(() => {
      const f = fleetRef.current;
      // Skip an all-zero "0 need you · 0 working · 0 idle" digest on a quiet fleet.
      if (canNotify() && hasReportable(f)) notify("Fleet digest", digestLine(f), "fleet-digest");
    }, ms);
    return () => clearInterval(id);
  }, [settings.afk, settings.notifications, settings.digestMinutes]);
}
