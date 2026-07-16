import { useEffect, useRef } from "react";
import type { AlertSettings, AlertScope } from "./lib/alerts.ts";
import {
  batchSeverity,
  detectAlerts,
  digestLine,
  hasReportable,
  summarizeAlerts,
} from "./lib/alerts.ts";
import { playChime, unlockAudio } from "./lib/chime.ts";

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
 * Watches the live scope and, on each transition into an attention state, fires a
 * desktop notification + a chime (per settings). The daemon already detects these
 * events and streams them; this just delivers them - zero extra tokens. AFK mode
 * also sends a periodic digest of every session.
 *
 * `ready` (the SSE snapshot has landed) gates alerting. `useEventStream` returns
 * empty state on the first render and drops `ready` on disconnect, re-raising it on
 * each (re)connect snapshot. On INITIAL open we baseline silently; on RECONNECT we
 * neither storm (one alert per gap change) nor swallow (miss what happened while
 * away) - we coalesce the attention events missed during the gap into one catch-up.
 */
export function useNotifier(scope: AlertScope, settings: AlertSettings, ready: boolean): void {
  const prevRef = useRef<AlertScope | null>(null);
  const wasReadyRef = useRef(false);
  const stateRef = useRef(scope);
  stateRef.current = scope;

  // Sound defaults on, but a fresh page load starts a suspended AudioContext that
  // only a user gesture can resume. Unlock on the first interaction anywhere, so
  // chimes aren't silently dropped after a refresh until the alert controls are used.
  useEffect(() => {
    const unlock = (): void => {
      unlockAudio();
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  useEffect(() => {
    const justConnected = ready && !wasReadyRef.current;
    wasReadyRef.current = ready;

    // Do NOT touch prevRef while disconnected: on initial open it must stay null so
    // the snapshot seeds silently; across a disconnect it retains the last baseline
    // so the reconnect catch-up has something to diff against.
    if (!ready) return;

    if (justConnected) {
      const prev = prevRef.current;
      prevRef.current = scope;
      // Initial open: no prior baseline, so nothing was "missed" - seed silently.
      if (!prev) return;
      // Reconnect: summarize the attention-level events that happened during the
      // gap (coalesced so a long disconnect doesn't storm) instead of dropping them.
      const missed = detectAlerts(prev, scope, settings).filter((a) => a.severity === "attention");
      if (missed.length === 0) return;
      if (settings.notifications && canNotify()) {
        notify("While you were away", summarizeAlerts(missed), "reconnect-catchup");
      }
      if (settings.sound) playChime("attention");
      return;
    }

    const prev = prevRef.current ?? scope;
    prevRef.current = scope;

    const alerts = detectAlerts(prev, scope, settings);
    if (alerts.length === 0) return;
    if (settings.notifications && canNotify()) {
      for (const a of alerts) notify(a.title, a.body, a.id);
    }
    // One chime per batch at the most urgent severity, so a same-tick "info" alert
    // can't swallow the "attention" tone via the chime's rate limit.
    if (settings.sound) playChime(batchSeverity(alerts));
  }, [scope, settings, ready]);

  useEffect(() => {
    if (!settings.afk || !settings.notifications) return;
    const ms = Math.max(1, settings.digestMinutes) * 60_000;
    const id = setInterval(() => {
      const f = stateRef.current;
      // Skip an all-zero "0 need you · 0 working · 0 idle" digest on a quiet scope.
      if (canNotify() && hasReportable(f)) notify("Session digest", digestLine(f), "session-digest");
    }, ms);
    return () => clearInterval(id);
  }, [settings.afk, settings.notifications, settings.digestMinutes]);
}
