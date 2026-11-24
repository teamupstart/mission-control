import { createContext, useEffect, useRef } from "react";
import { VOICE_CARDS_OBSERVED_HEADER, VOICE_FOCUS_TIME_HEADER, VOICE_MONOTONIC_TIME_HEADER, VOICE_REPORT_REVISION_HEADER, voiceFocusClockSkewMs, voiceReplyState, type OpenCardsReport } from "@shared/voice-answers.ts";

import { fetchVoiceCardTime } from "./api.ts";
import type { DashboardVoiceAnswer } from "./voice-card-clock.ts";

export const VoiceAnswersContext = createContext<{ answers: ReadonlyMap<string, DashboardVoiceAnswer>; windowId?: string } | null>(null);

/** Read the drawn cards in the top overlay, including keyboard focus. Supersede stale requests;
 * per-window revisions also order writes that reach the daemon after a timeout. */
export function useVoiceOpenCards(windowId: string | undefined, dashboard: boolean): void {
  // Hash navigation keeps the same SSE stream. Its report order must survive role changes.
  const stream = useRef<{ id: string; timeOrigin: number; focusAtUs: number; revision: number } | null>(null);
  useEffect(() => {
    if (!windowId) return;
    const controller = new AbortController();
    let focused: boolean | undefined;
    // The daemon calibrates each stream at connection. A surviving page can reconnect
    // with an older time origin, so anchor this stream's observations to the current era.
    if (stream.current?.id !== windowId) {
      stream.current = { id: windowId, timeOrigin: performance.timeOrigin - voiceFocusClockSkewMs(), focusAtUs: 0, revision: 0 };
    }
    const clock = stream.current;
    let pending: { key: string; controller: AbortController } | undefined;
    let last = "";
    let retry: ReturnType<typeof setTimeout>;
    let observed: { state: string; at: number } | undefined;
    let calibration: Promise<number | null> | undefined;
    const report = async () => {
      if (controller.signal.aborted) return;
      const hasFocus = dashboard && document.hasFocus() && !document.hidden;
      if (focused !== hasFocus) {
        focused = hasFocus;
        clock.focusAtUs = Math.max(clock.focusAtUs + 1, Math.round((clock.timeOrigin + performance.now()) * 1000));
      }
      const top = document.querySelector("[data-overlay-top=true]");
      const elements = !dashboard ? [] : Array.from((top ?? document).querySelectorAll<HTMLElement>("[data-voice-question]"))
        .filter(el => el.getClientRects().length && !el.closest("[inert]"));
      const payload: OpenCardsReport = { windowId, focused: hasFocus,
        cards: elements.map(el => ({ kind: "question", id: el.dataset.voiceQuestion!, focused: el.contains(document.activeElement) })) };
      const state = voiceReplyState(payload);
      if (state !== observed?.state) observed = state ? { state, at: performance.now() } : undefined;
      const body = JSON.stringify(payload);
      const key = clock.focusAtUs + body;
      if (pending?.key === key || (!pending && last === key)) return;
      clearTimeout(retry);
      pending?.controller.abort();
      const attempt = { key, controller: new AbortController() };
      pending = attempt;
      // The previous request may have been applied even if its acknowledgement stalled.
      last = "";
      try {
        const observation = observed;
        if (observation && !calibration) {
          // A daemon sample taken after request start gives an upper bound for the
          // observation on the daemon's monotonic clock, independent of wall clocks.
          const sent = performance.now();
          calibration = fetchVoiceCardTime(AbortSignal.any([controller.signal, AbortSignal.timeout(500)]), VOICE_MONOTONIC_TIME_HEADER)
            .then(stamp => stamp === null ? null : stamp - sent);
        }
        const offset = observation ? await calibration : null;
        if (pending !== attempt || controller.signal.aborted) return;
        const response = await fetch(dashboard ? "/api/voice/open-cards" : "/api/voice/open-cards?withdraw=1", { method: "PUT",
          signal: AbortSignal.any([controller.signal, attempt.controller.signal, AbortSignal.timeout(1500)]),
          headers: { "content-type": "application/json", [VOICE_FOCUS_TIME_HEADER]: String(clock.focusAtUs),
            [VOICE_REPORT_REVISION_HEADER]: String(++clock.revision),
            ...(observation && offset != null && { [VOICE_CARDS_OBSERVED_HEADER]: String(Math.max(0, Math.ceil(observation.at + offset))) }) }, body });
        if (observation && offset == null) calibration = undefined;
        if (pending === attempt && response.ok) last = key;
      } catch { /* A timeout retries from the current DOM and document focus. */ }
      if (pending !== attempt || controller.signal.aborted) return;
      pending = undefined;
      if (last === key) void report();
      else retry = setTimeout(report, 500);
    };
    void report();
    if (!dashboard) return () => { controller.abort(); clearTimeout(retry); };
    const observer = new MutationObserver(() => void report());
    observer.observe(document.body, { childList: true, subtree: true, attributes: true,
      attributeFilter: ["data-overlay-top", "data-voice-question", "inert", "hidden"] });
    const events = ["focus", "blur", "focusin", "focusout", "visibilitychange"];
    for (const event of events) window.addEventListener(event, report, true);
    return () => {
      controller.abort();
      clearTimeout(retry);
      observer.disconnect();
      for (const event of events) window.removeEventListener(event, report, true);
    };
  }, [windowId, dashboard]);
}
