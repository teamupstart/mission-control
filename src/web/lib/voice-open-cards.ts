import { createContext, useEffect } from "react";
import type { OpenCardsReport, VoiceAnswer } from "@shared/voice-answers.ts";

export const VoiceAnswersContext = createContext<ReadonlyMap<string, VoiceAnswer> | null>(null);

/** Read the drawn cards in the top overlay, including keyboard focus. Serialize reports
 * so a slow request for a dismissed dialog cannot reinstate its cards. */
export function useVoiceOpenCards(windowId?: string): void {
  useEffect(() => {
    if (!windowId) return;
    let stopped = false;
    let sending = false;
    let last = "";
    let retry: ReturnType<typeof setTimeout>;
    const report = async () => {
      if (stopped || sending) return;
      clearTimeout(retry);
      const top = document.querySelector("[data-overlay-top=true]");
      const elements = Array.from((top ?? document).querySelectorAll<HTMLElement>("[data-voice-question]"))
        .filter(el => el.getClientRects().length && !el.closest("[inert]"));
      const payload: OpenCardsReport = { windowId, focused: document.hasFocus() && !document.hidden,
        cards: elements.map(el => ({ kind: "question", id: el.dataset.voiceQuestion!, focused: el.contains(document.activeElement) })) };
      const body = JSON.stringify(payload);
      if (last === body) return;
      sending = true;
      try {
        const response = await fetch("/api/voice/open-cards", { method: "PUT", headers: { "content-type": "application/json" }, body });
        if (response.ok) last = body;
      } catch { /* Retry after the stream reconnects. */ }
      sending = false;
      if (!stopped) {
        if (last === body) void report();
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
      stopped = true;
      clearTimeout(retry);
      observer.disconnect();
      for (const event of events) window.removeEventListener(event, report, true);
    };
  }, [windowId]);
}
