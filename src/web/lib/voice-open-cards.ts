import { createContext, useEffect } from "react";
import { VOICE_FOCUS_TIME_HEADER, voiceFocusClockSkewMs, type OpenCardsReport, type VoiceAnswer } from "@shared/voice-answers.ts";

export const VoiceAnswersContext = createContext<ReadonlyMap<string, VoiceAnswer> | null>(null);

/** Read the drawn cards in the top overlay, including keyboard focus. Serialize reports
 * so a slow request for a dismissed dialog cannot reinstate its cards. */
export function useVoiceOpenCards(windowId?: string): void {
  useEffect(() => {
    if (!windowId) return;
    const controller = new AbortController();
    let focused: boolean | undefined;
    // The daemon calibrates each stream at connection. A surviving page can reconnect
    // with an older time origin, so anchor this stream's observations to the current era.
    const timeOrigin = performance.timeOrigin - voiceFocusClockSkewMs();
    let focusAtUs = 0;
    let sending = false;
    let last = "";
    let retry: ReturnType<typeof setTimeout>;
    const report = async () => {
      if (controller.signal.aborted) return;
      const hasFocus = document.hasFocus() && !document.hidden;
      if (focused !== hasFocus) {
        focused = hasFocus;
        focusAtUs = Math.max(focusAtUs + 1, Math.round((timeOrigin + performance.now()) * 1000));
      }
      if (sending) return;
      clearTimeout(retry);
      const top = document.querySelector("[data-overlay-top=true]");
      const elements = Array.from((top ?? document).querySelectorAll<HTMLElement>("[data-voice-question]"))
        .filter(el => el.getClientRects().length && !el.closest("[inert]"));
      const payload: OpenCardsReport = { windowId, focused: hasFocus,
        cards: elements.map(el => ({ kind: "question", id: el.dataset.voiceQuestion!, focused: el.contains(document.activeElement) })) };
      const body = JSON.stringify(payload);
      const key = focusAtUs + body;
      if (last === key) return;
      sending = true;
      try {
        const response = await fetch("/api/voice/open-cards", { method: "PUT", signal: controller.signal,
          headers: { "content-type": "application/json", [VOICE_FOCUS_TIME_HEADER]: String(focusAtUs) }, body });
        if (response.ok) last = key;
      } catch { /* Retry after the stream reconnects. */ }
      sending = false;
      if (!controller.signal.aborted) {
        if (last === key) void report();
        else retry = setTimeout(report, 500);
      }
    };
    const observer = new MutationObserver(() => void report());
    observer.observe(document.body, { childList: true, subtree: true, attributes: true,
      attributeFilter: ["data-overlay-top", "data-voice-question", "inert", "hidden"] });
    const events = ["focus", "blur", "focusin", "focusout", "visibilitychange"];
    for (const event of events) window.addEventListener(event, report, true);
    void report();
    return () => {
      controller.abort();
      clearTimeout(retry);
      observer.disconnect();
      for (const event of events) window.removeEventListener(event, report, true);
    };
  }, [windowId]);
}
