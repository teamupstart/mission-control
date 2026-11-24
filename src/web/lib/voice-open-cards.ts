import { createContext, useEffect } from "react";
import { VOICE_FOCUS_TIME_HEADER, VOICE_REPORT_REVISION_HEADER, voiceFocusClockSkewMs, type OpenCardsReport } from "@shared/voice-answers.ts";

import type { DashboardVoiceAnswer } from "./voice-card-clock.ts";

export const VoiceAnswersContext = createContext<{ answers: ReadonlyMap<string, DashboardVoiceAnswer>; windowId?: string } | null>(null);

/** Read the drawn cards in the top overlay, including keyboard focus. Supersede stale requests;
 * per-window revisions also order writes that reach the daemon after a timeout. */
export function useVoiceOpenCards(windowId?: string): void {
  useEffect(() => {
    if (!windowId) return;
    const controller = new AbortController();
    let focused: boolean | undefined;
    // The daemon calibrates each stream at connection. A surviving page can reconnect
    // with an older time origin, so anchor this stream's observations to the current era.
    const timeOrigin = performance.timeOrigin - voiceFocusClockSkewMs();
    let focusAtUs = 0;
    let pending: { key: string; controller: AbortController } | undefined;
    let revision = 0;
    let last = "";
    let retry: ReturnType<typeof setTimeout>;
    const report = async () => {
      if (controller.signal.aborted) return;
      const hasFocus = document.hasFocus() && !document.hidden;
      if (focused !== hasFocus) {
        focused = hasFocus;
        focusAtUs = Math.max(focusAtUs + 1, Math.round((timeOrigin + performance.now()) * 1000));
      }
      const top = document.querySelector("[data-overlay-top=true]");
      const elements = Array.from((top ?? document).querySelectorAll<HTMLElement>("[data-voice-question]"))
        .filter(el => el.getClientRects().length && !el.closest("[inert]"));
      const payload: OpenCardsReport = { windowId, focused: hasFocus,
        cards: elements.map(el => ({ kind: "question", id: el.dataset.voiceQuestion!, focused: el.contains(document.activeElement) })) };
      const body = JSON.stringify(payload);
      const key = focusAtUs + body;
      if (pending?.key === key || (!pending && last === key)) return;
      clearTimeout(retry);
      pending?.controller.abort();
      const attempt = { key, controller: new AbortController() };
      pending = attempt;
      // The previous request may have been applied even if its acknowledgement stalled.
      last = "";
      try {
        const response = await fetch("/api/voice/open-cards", { method: "PUT",
          signal: AbortSignal.any([controller.signal, attempt.controller.signal, AbortSignal.timeout(1500)]),
          headers: { "content-type": "application/json", [VOICE_FOCUS_TIME_HEADER]: String(focusAtUs),
            [VOICE_REPORT_REVISION_HEADER]: String(++revision) }, body });
        if (pending === attempt && response.ok) last = key;
      } catch { /* A timeout retries from the current DOM and document focus. */ }
      if (pending !== attempt || controller.signal.aborted) return;
      pending = undefined;
      if (last === key) void report();
      else retry = setTimeout(report, 500);
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
