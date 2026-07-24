import { useEffect, useRef } from "react";
import type { AlertScope } from "@shared/alerts.ts";
import {
  batchSeverity,
  deliverable,
  detectAlerts,
  summarizeAlerts,
  withKnownStalls,
} from "@shared/alerts.ts";
import type { AlertSettings } from "./lib/alertSettings.ts";
import { playChime, unlockAudio } from "./lib/chime.ts";

function canNotify(): boolean {
  return typeof Notification !== "undefined" && Notification.permission === "granted";
}

function notify(title: string, body: string, tag: string, workflowRunId?: string | null): void {
  // Some platforms (e.g. Android Chrome) throw from `new Notification` even when
  // permission is granted (they require the service-worker path); never let that
  // escape the effect.
  try {
    const n = new Notification(title, { body, tag });
    n.onclick = () => {
      window.focus();
      if (workflowRunId) {
        window.location.hash = `#/workflows/runs/${encodeURIComponent(workflowRunId)}`;
      }
      n.close();
    };
  } catch {
    /* notifications unavailable on this platform - sound still plays */
  }
}

/**
 * Watches the live scope and, on each transition into an attention state, fires a
 * desktop notification + a chime (per settings). The daemon already detects these
 * events and streams them; this just delivers them - zero extra tokens.
 *
 * ONLY ATTENTION ALERTS ARE DELIVERED. The engine reports everything that happened,
 * including informational events (a session going idle, a task finishing); those
 * are digest material, not interruptions, so they are dropped here and picked up by
 * the daemon's away buffer instead. This is what stops away mode from being louder
 * than being at the desk - the old behaviour, where flipping AFK on ADDED two alert
 * kinds and fired one notification each.
 *
 * Stalls are the one part of the scope that does NOT arrive with the snapshot (they
 * are polled separately - see useStalls), so the first batch of them is adopted into
 * the baseline rather than treated as news; see withKnownStalls for why that matters
 * on every page load.
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
      const missed = detectAlerts(withKnownStalls(prev, scope), scope).filter(deliverable);
      if (missed.length === 0) return;
      if (settings.notifications && canNotify()) {
        notify("While the dashboard was disconnected", summarizeAlerts(missed), "reconnect-catchup");
      }
      if (settings.sound) playChime("attention");
      return;
    }

    const prev = prevRef.current ?? scope;
    prevRef.current = scope;

    const alerts = detectAlerts(withKnownStalls(prev, scope), scope).filter(deliverable);
    if (alerts.length === 0) return;
    if (settings.notifications && canNotify()) {
      for (const a of alerts) notify(a.title, a.body, a.id, a.workflowRunId);
    }
    // One chime per batch at the most urgent severity, so a same-tick "info" alert
    // can't swallow the "attention" tone via the chime's rate limit.
    if (settings.sound) playChime(batchSeverity(alerts));
  }, [scope, settings, ready]);
}
