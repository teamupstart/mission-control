import { createContext, useEffect, useRef } from "react";
import { VOICE_CALIBRATING_HEADER, VOICE_CARDS_EARLIEST_HEADER, VOICE_CARDS_OBSERVED_HEADER, VOICE_CONFIRM_FOCUS_HEADER, VOICE_FOCUS_TIME_HEADER, VOICE_MONOTONIC_TIME_HEADER, VOICE_OBSERVATION_ID_HEADER, VOICE_REPORT_REVISION_HEADER, voiceFocusClockSkewMs, voiceReplyState, type OpenCardsReport, type VoiceTimeBounds } from "@shared/voice-answers.ts";

import { fetchVoiceCardTime } from "./api.ts";
import { VoiceCardClock, type DashboardVoiceAnswer } from "./voice-card-clock.ts";

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
    let confirmation = 0;
    let retry: ReturnType<typeof setTimeout>;
    let observed: { state: string; at: number; id: number } | undefined;
    const cardClock = new VoiceCardClock();
    let calibration: Promise<void> | undefined;
    async function sampleClock() {
      // A slow outbound trip and a slow return trip have opposite clock errors.
      // Intersect an independent sample before relying on a wide interval.
      for (let i = 0; i < 2 && !controller.signal.aborted; i++) {
        const sent = performance.now();
        const stamp = await fetchVoiceCardTime(AbortSignal.any([controller.signal, AbortSignal.timeout(500)]), VOICE_MONOTONIC_TIME_HEADER);
        if (stamp === null) continue;
        if (!cardClock.observe(sent, performance.now(), stamp, stamp).uncertain) break;
      }
    }
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
      if (state !== observed?.state) observed = state ? { state, at: performance.now(), id: ++clock.revision } : undefined;
      const body = JSON.stringify(payload);
      const requested = confirmation;
      const key = clock.focusAtUs + ":" + requested + body;
      if (pending?.key === key || (!pending && last === key)) return;
      clearTimeout(retry);
      pending?.controller.abort();
      const attempt = { key, controller: new AbortController() };
      pending = attempt;
      // The previous request may have been applied even if its acknowledgement stalled.
      last = "";
      try {
        const observation = observed;
        const send = (bounds?: VoiceTimeBounds, calibrating = false) => fetch(dashboard ? "/api/voice/open-cards" : "/api/voice/open-cards?withdraw=1", { method: "PUT",
          signal: AbortSignal.any([controller.signal, attempt.controller.signal, AbortSignal.timeout(1500)]),
          headers: { "content-type": "application/json", [VOICE_FOCUS_TIME_HEADER]: String(clock.focusAtUs),
            [VOICE_REPORT_REVISION_HEADER]: String(++clock.revision),
            ...(observation && { [VOICE_OBSERVATION_ID_HEADER]: String(observation.id) }),
            ...(calibrating && { [VOICE_CALIBRATING_HEADER]: "1" }),
            ...(!calibrating && requested && { [VOICE_CONFIRM_FOCUS_HEADER]: String(requested) }),
            ...(bounds && { [VOICE_CARDS_OBSERVED_HEADER]: String(bounds.latest), [VOICE_CARDS_EARLIEST_HEADER]: String(bounds.earliest) }) }, body });
        let bounds = observation && cardClock.serverTimeAt(observation.at);
        if (observation && (!bounds || bounds.latest - bounds.earliest > 100)) {
          // Publish the focus change first. Its higher-revision refinement can overtake
          // this request, and neither request may resurrect a superseded observation.
          void send(bounds, true).catch(() => {});
          calibration ??= sampleClock().finally(() => { calibration = undefined; });
          await calibration;
          bounds = cardClock.serverTimeAt(observation.at);
        }
        if (pending !== attempt || controller.signal.aborted) return;
        const response = await send(bounds);
        if (pending === attempt && response.ok) last = key;
      } catch { /* A timeout retries from the current DOM and document focus. */ }
      if (pending !== attempt || controller.signal.aborted) return;
      pending = undefined;
      if (last === key) void report();
      else retry = setTimeout(report, 500);
    };
    void report();
    const observer = new MutationObserver(() => void report());
    const events = ["focus", "blur", "focusin", "focusout", "visibilitychange"];
    if (dashboard) {
      observer.observe(document.body, { childList: true, subtree: true, attributes: true,
        attributeFilter: ["data-overlay-top", "data-voice-question", "inert", "hidden"] });
      for (const event of events) window.addEventListener(event, report, true);
    }
    const confirm = (event: Event) => {
      const { windowId: requestedWindow, sequence } = (event as CustomEvent<{ windowId: string; sequence: number }>).detail;
      if (windowId !== requestedWindow || sequence <= confirmation) return;
      confirmation = sequence;
      void report();
    };
    window.addEventListener("voice-confirm-focus", confirm);
    return () => {
      controller.abort();
      clearTimeout(retry);
      observer.disconnect();
      for (const event of events) window.removeEventListener(event, report, true);
      window.removeEventListener("voice-confirm-focus", confirm);
    };
  }, [windowId, dashboard]);
}
