import { useEffect, useRef } from "react";
import type { Alert, AlertScope, NotifySwitches } from "@shared/alerts.ts";
import {
  batchSeverity,
  detectAlerts,
  heldForAway,
  heldReportStillDue,
  shouldDeliver,
  summarizeAlerts,
  withKnownStalls,
} from "@shared/alerts.ts";
import type { AlertSettings } from "./lib/alertSettings.ts";
import { playChime, recordFallbackSound, unlockAudio } from "./lib/chime.ts";

function canNotify(): boolean {
  return typeof Notification !== "undefined" && Notification.permission === "granted";
}

function notify(
  title: string,
  body: string,
  tag: string,
  silent: boolean,
  deepLink?: { workflowRunId?: string | null; ensembleId?: string | null; reportId?: string },
  onOpenReport?: (reportId: string) => void,
): boolean {
  // Some platforms (e.g. Android Chrome) throw from `new Notification` even when
  // permission is granted (they require the service-worker path); never let that
  // escape the effect.
  try {
    const n = new Notification(title, { body, tag, silent });
    n.onclick = () => {
      window.focus();
      // One deep link per toast, the same hash routes the dashboard already owns: a
      // workflow toast opens its Run, an ensemble toast its run detail beside it.
      if (deepLink?.workflowRunId) {
        window.location.hash = `#/runs/${encodeURIComponent(deepLink.workflowRunId)}`;
      } else if (deepLink?.ensembleId) {
        window.location.hash = `#/ensembles/${encodeURIComponent(deepLink.ensembleId)}`;
      } else if (deepLink?.reportId) {
        // A report toast opens the inbox at its report. Whether it may (the `inbox` flag) is
        // decided at the click, not when the toast was raised: the flag can go off in between.
        onOpenReport?.(deepLink.reportId);
      }
      n.close();
    };
    return true;
  } catch {
    // No desktop delivery to record in the sound rate gate.
    return false;
  }
}

export interface NotifierDelivery {
  /**
   * The "What notifies you" switches while the `inbox` flag is on, or null while it is off, when
   * delivery is exactly `deliverable` (see `shouldDeliver`).
   */
  notify: NotifySwitches | null;
  /**
   * Away mode as last read from the daemon, or still being left. Reports are held while away.
   * Null until the daemon's first answer: a report raised then waits for it, and is delivered
   * then only if you are not away. Every other alert is delivered as it always was.
   */
  away: boolean | null;
  /** What a click on a report notification does, read when the click lands. */
  onOpenReport: (reportId: string) => void;
}

const DELIVER_AS_BEFORE: NotifierDelivery = { notify: null, away: false, onOpenReport: () => undefined };

/**
 * Raise one batch: one chime at its most urgent severity, then a notification per alert. The OS
 * is a fallback only for unavailable audio, never for Sound off or an intentionally throttled
 * chime.
 */
function raiseBatch(alerts: Alert[], settings: AlertSettings, openReport: (reportId: string) => void): void {
  if (alerts.length === 0) return;
  const severity = batchSeverity(alerts);
  const fallbackSound = settings.sound && playChime(severity) === "unavailable";
  if (settings.notifications && canNotify()) {
    for (const [index, a] of alerts.entries()) {
      const audible = fallbackSound && index === 0;
      const delivered = notify(a.title, a.body, a.id, !audible, {
        workflowRunId: a.workflowRunId, ensembleId: a.ensembleId, reportId: a.reportId,
      }, openReport);
      if (delivered && audible) recordFallbackSound(severity);
    }
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
 * With the `inbox` flag on, `shouldDeliver` refines that: each "What notifies you" switch can
 * silence its own kind, and an agent report - info, but worth hearing at the desk - is
 * delivered unless you are away, when the digest summarises it instead.
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
export function useNotifier(
  scope: AlertScope,
  settings: AlertSettings,
  ready: boolean,
  delivery: NotifierDelivery = DELIVER_AS_BEFORE,
): void {
  const prevRef = useRef<AlertScope | null>(null);
  const wasReadyRef = useRef(false);
  // Read through a ref rather than listed as an effect dependency: flipping a switch or Away mode
  // changes what the NEXT alert does, and must not re-run detection on a scope that did not move.
  const deliveryRef = useRef(delivery);
  deliveryRef.current = delivery;

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

  // Report alerts held while this window was away, or did not know yet (`heldForAway`).
  const heldRef = useRef<Alert[]>([]);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  // Known not to be away: deliver each held report alert the return digest did not cover, read
  // against the reports as they are now (`heldReportStillDue`). One read or counted meanwhile is
  // dropped; the digest, or the operator, already has it.
  const awayOff = delivery.away === false;
  useEffect(() => {
    if (!awayOff || heldRef.current.length === 0) return;
    const held = heldRef.current;
    heldRef.current = [];
    const { notify: switches, onOpenReport } = deliveryRef.current;
    const reports = scopeRef.current.reports;
    raiseBatch(
      held.filter((a) => heldReportStillDue(a, reports) && shouldDeliver(a, switches, false)),
      settingsRef.current,
      onOpenReport,
    );
  }, [awayOff]);

  useEffect(() => {
    // A report alert raised while this window is away, or does not know yet, is held (see
    // above); everything else is decided now, exactly as before.
    const deliver = (a: Alert) => {
      const { notify: switches, away } = deliveryRef.current;
      if (heldForAway(a, switches, away)) {
        heldRef.current.push(a);
        return false;
      }
      return shouldDeliver(a, switches, away ?? false);
    };
    const openReport = (reportId: string) => deliveryRef.current.onOpenReport(reportId);
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
      const delivered = detectAlerts(withKnownStalls(prev, scope), scope).filter(deliver);
      // A report keeps its own notification - "<name>'s back: <title>", opening its report -
      // rather than becoming a line in the catch-up: the wording and the click are the point of
      // it. One per report, and reports alone; every other missed alert is summarised as before.
      const reports = delivered.filter((a) => a.kind === "report");
      const missed = delivered.filter((a) => a.kind !== "report");
      if (missed.length > 0) {
        const fallbackSound = settings.sound && playChime("attention") === "unavailable";
        if (settings.notifications && canNotify()) {
          const raised = notify("While the dashboard was disconnected", summarizeAlerts(missed), "reconnect-catchup", !fallbackSound);
          if (raised && fallbackSound) recordFallbackSound("attention");
        }
      }
      raiseBatch(reports, settings, openReport);
      return;
    }

    const prev = prevRef.current ?? scope;
    prevRef.current = scope;

    raiseBatch(detectAlerts(withKnownStalls(prev, scope), scope).filter(deliver), settings, openReport);
  }, [scope, settings, ready]);
}
