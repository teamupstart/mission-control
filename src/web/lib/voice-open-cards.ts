import { createContext, useEffect, useRef } from "react";
import { VOICE_CALIBRATING_HEADER, VOICE_CARDS_EARLIEST_HEADER, VOICE_CARDS_OBSERVED_HEADER, VOICE_CONFIRM_FOCUS_HEADER, VOICE_FOCUS_TIME_HEADER, VOICE_MONOTONIC_TIME_HEADER, VOICE_OBSERVATION_ID_HEADER, VOICE_REPORT_REVISION_HEADER, voiceFocusClockSkewMs, voiceReplyState, type OpenCardsReport, type VoiceInboxEvent, type VoiceTimeBounds } from "@shared/voice-answers.ts";

import { newRequestId } from "./request-id.ts";
import type { ServerEvent } from "@shared/types.ts";
import { focusedDictationField, DictationEditor } from "./voice-dictation.ts";
import { drawnVoiceCards, receiveInboxEvent } from "./voice-inbox.ts";
import { fetchVoiceCardTime } from "./api.ts";
import { refineVoiceCardClock, VoiceCardClock, type DashboardVoiceAnswer } from "./voice-card-clock.ts";

export const VoiceAnswersContext = createContext<{ planFormsByVoice?: boolean; answers: ReadonlyMap<string, DashboardVoiceAnswer>; windowId?: string } | null>(null);

/** Read the drawn cards in the top overlay, including keyboard focus. Supersede stale requests;
 * per-window revisions also order writes that reach the daemon after a timeout. */
export function useVoiceOpenCards(windowId: string | undefined, dashboard: boolean): void {
  // Hash navigation keeps the same SSE stream. Its report order must survive role changes.
  const stream = useRef<{ id: string; timeOrigin: number; focusAtUs: number; revision: number } | null>(null);
  useEffect(() => {
    if (!windowId) return;
    const controller = new AbortController();
    // Returning to a field in the same phrase can still replace its last preview.
    const editors = new WeakMap<HTMLElement, DictationEditor>();
    let field: HTMLElement | null = null;
    let dictationTarget: string | undefined;
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
    let refining: Promise<void> | undefined;
    async function sampleOnce() {
      const sent = performance.now();
      const stamp = await fetchVoiceCardTime(AbortSignal.any([controller.signal, AbortSignal.timeout(500)]), VOICE_MONOTONIC_TIME_HEADER);
      return stamp === null ? null : { sent, received: performance.now(), stamp };
    }
    async function sampleClock() {
      // A slow outbound trip and a slow return trip have opposite clock errors.
      // Intersect an independent sample before relying on a wide interval.
      for (let i = 0; i < 2 && !controller.signal.aborted; i++) {
        const sample = await sampleOnce();
        if (sample && !cardClock.observe(sample.sent, sample.received, sample.stamp, sample.stamp).uncertain) break;
      }
      // A reply spoken soon after a focus change needs a narrower interval than this
      // first calibration may give. Narrower bounds re-report the current observation,
      // after any request in flight: its completion reports again from the refined clock.
      refining ??= refineVoiceCardClock(cardClock, sampleOnce, () => { if (!pending) void report(); }, controller.signal)
        .finally(() => { refining = undefined; });
    }
    const refreshField = () => {
      const nextField = focusedDictationField();
      if (nextField !== field) {
        field = nextField;
        dictationTarget = field ? newRequestId() : undefined;
      }
      return field;
    };
    const report = async () => {
      if (controller.signal.aborted) return;
      const nextField = refreshField();
      const hasFocus = (dashboard || !!nextField) && document.hasFocus() && !document.hidden;
      if (focused !== hasFocus) {
        focused = hasFocus;
        clock.focusAtUs = Math.max(clock.focusAtUs + 1, Math.round((clock.timeOrigin + performance.now()) * 1000));
      }
      const payload: OpenCardsReport = { windowId, dictationTarget, focused: hasFocus, cards: dashboard ? drawnVoiceCards() : [] };
      const state = voiceReplyState(payload);
      if (state !== observed?.state) observed = state ? { state, at: performance.now(), id: ++clock.revision } : undefined;
      const body = JSON.stringify(payload);
      const requested = confirmation;
      const observation = observed;
      // A refined clock narrows the same observation's bounds, which the daemon must hear.
      const keyOf = () => clock.focusAtUs + ":" + requested + ":" +
        (observation ? JSON.stringify(cardClock.serverTimeAt(observation.at)) : "") + body;
      const key = keyOf();
      if (pending?.key === key || (!pending && last === key)) return;
      clearTimeout(retry);
      pending?.controller.abort();
      const attempt = { key, controller: new AbortController() };
      pending = attempt;
      // The previous request may have been applied even if its acknowledgement stalled.
      last = "";
      try {
        const send = (bounds?: VoiceTimeBounds, calibrating = false) => fetch(dashboard || dictationTarget ? "/api/voice/open-cards" : "/api/voice/open-cards?withdraw=1", { method: "PUT",
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
          attempt.key = keyOf();
        }
        if (pending !== attempt || controller.signal.aborted) return;
        const response = await send(bounds);
        if (pending === attempt && response.ok) last = attempt.key;
      } catch { /* A timeout retries from the current DOM and document focus. */ }
      if (pending !== attempt || controller.signal.aborted) return;
      pending = undefined;
      if (last === attempt.key) void report();
      else retry = setTimeout(report, 500);
    };
    void report();
    // An unchanged form remains open across long editing sessions. Renew its daemon
    // retention without treating the heartbeat as a new focus transition.
    const heartbeat = setInterval(() => {
      if (!pending && dashboard && document.querySelector("[data-voice-kind=plan]")) {
        last = "";
        void report();
      }
    }, 60_000);
    const observer = new MutationObserver(() => void report());
    const events = ["focus", "blur", "focusin", "focusout", "visibilitychange"];
    observer.observe(document.body, { childList: true, subtree: true, attributes: true,
        attributeFilter: ["data-overlay-top", "data-voice-question", "data-voice-id", "data-voice-kind", "data-voice-key", "data-voice-action", "inert", "hidden", "disabled", "readonly", "type", "contenteditable"] });
    for (const event of events) window.addEventListener(event, report, true);
    const confirm = (event: Event) => {
      const { windowId: requestedWindow, sequence, type } = (event as CustomEvent<Extract<ServerEvent, { type: "voice_confirm_focus" | "voice_dictation_probe" }>>).detail;
      if (windowId === requestedWindow && type === "voice_dictation_probe") {
        refreshField();
        void fetch("/api/voice/open-cards?dictation=1", { method: "PUT", headers: { "content-type": "application/json" },
          signal: controller.signal, body: JSON.stringify({ windowId, sequence, target: dictationTarget }) }).catch(() => {});
        return;
      }
      if (windowId !== requestedWindow || sequence <= confirmation) return;
      confirmation = sequence;
      void report();
    };
    window.addEventListener("voice-confirm-focus", confirm);
    window.addEventListener("voice-dictation-probe", confirm);
    const inboxEvent = (event: Event) => {
      const message = (event as CustomEvent<VoiceInboxEvent>).detail;
      if (dashboard && message.windowId === windowId) void receiveInboxEvent(message, cardClock).catch(() => {
        console.warn("Voice event handler failed", message.type, message.type === "voice_inbox_action" ? message.requestId : message.reviewId);
      });
    };
    const dictate = (event: Event) => {
      const message = (event as CustomEvent<Extract<ServerEvent, { type: "voice_dictation" }>>).detail;
      if (!field || message.target !== dictationTarget || field !== focusedDictationField()) return;
      const editor = editors.get(field) ?? new DictationEditor();
      editors.set(field, editor);
      editor.insert(field, message);
    };
    window.addEventListener("voice-dictation", dictate);
    // Range-less inputs hide their native caret. Intercept navigation before the
    // default action so a repeated digit at the new position cannot claim the edit.
    const navigateNativeInput = (event: Event) => {
      if (!(field instanceof HTMLInputElement) || field.selectionStart !== null || event.target !== field) return;
      if (event instanceof KeyboardEvent && !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End",
        "PageUp", "PageDown"].includes(event.key)) return;
      editors.get(field)?.interrupt();
    };
    window.addEventListener("keydown", navigateNativeInput, true);
    window.addEventListener("pointerdown", navigateNativeInput, true);
    window.addEventListener("voice-inbox-event", inboxEvent);
    return () => {
      window.removeEventListener("voice-dictation", dictate);
      window.removeEventListener("keydown", navigateNativeInput, true);
      window.removeEventListener("pointerdown", navigateNativeInput, true);
      window.removeEventListener("voice-inbox-event", inboxEvent);
      controller.abort();
      clearTimeout(retry);
      clearInterval(heartbeat);
      observer.disconnect();
      for (const event of events) window.removeEventListener(event, report, true);
      window.removeEventListener("voice-confirm-focus", confirm);
      window.removeEventListener("voice-dictation-probe", confirm);
    };
  }, [windowId, dashboard]);
}
