import type { InboxActionId } from "@shared/inbox.ts";
import { planVoiceTarget, VOICE_INBOX_ACTION_TIMEOUT_MS, type DrawnVoiceCard, type VoiceInboxEvent } from "@shared/voice-answers.ts";
import { updateReviewDraft } from "./review-drafts.ts";

const selector = "[data-voice-question], [data-voice-kind]";

function drawnCards() {
  const surface = document.querySelector("[data-overlay-top=true]") ?? document;
  return Array.from(surface.querySelectorAll<HTMLElement>(selector)).filter(el => el.getClientRects().length && !el.closest("[inert]"));
}

export function cardActions(card: HTMLElement): InboxActionId[] {
  return Array.from(card.querySelectorAll<HTMLElement>("[data-voice-action]"), el => el.dataset.voiceAction as InboxActionId);
}

function describeCard(el: HTMLElement): DrawnVoiceCard {
  const focused = el.contains(document.activeElement);
  const sessionId = el.dataset.voiceSession ?? "";
  if (el.dataset.voiceQuestion) return { kind: "question", id: el.dataset.voiceQuestion, focused, sessionId };
  const kind = el.dataset.voiceKind as "plan" | "report" | "stuck";
  return { kind, id: el.dataset.voiceId!, sessionId, agentKey: el.dataset.voiceKey, focused, actions: cardActions(el) };
}

export function drawnVoiceCards() {
  return drawnCards().map(describeCard);
}

/** Live button callbacks accept dictated text without overwriting the operator's parked draft. */
export const voiceButtonActions = new WeakMap<HTMLButtonElement, (text: string) => void>();

export async function receiveInboxEvent(event: VoiceInboxEvent) {
  if (!document.hasFocus() || document.hidden) return;
  const id = event.type === "voice_inbox_action" ? event.cardId : event.reviewId;
  const findCard = () => drawnCards().find(el => el.dataset.voiceId === id &&
    el.dataset.voiceKind === (event.type === "voice_inbox_action" ? event.kind : "plan"));
  const card = findCard();
  if (!card) return;
  if (event.type !== "voice_inbox_action" && planVoiceTarget(drawnVoiceCards(), event.address)?.id !== id) return;
  if (event.type === "voice_form_submit") {
    card.dispatchEvent(new CustomEvent("voice-form-submit", { detail: event.submitId }));
  } else if (event.type === "voice_form_fill") {
    updateReviewDraft(id, draft => {
      const decisions = { ...draft.decisions };
      for (const selection of event.selections) decisions[selection.decisionId] = {
        ...decisions[selection.decisionId], note: decisions[selection.decisionId]?.note ?? "",
        other: decisions[selection.decisionId]?.other ?? "", selected: selection.selected, voice: true, chat: false,
      };
      return { ...draft, decisions };
    });
  } else {
    const selector = `button[data-voice-action="${event.action}"]`;
    const button = card.querySelector<HTMLButtonElement>(selector);
    if (!button || !voiceButtonActions.has(button)) return;
    const path = `/api/voice/inbox-actions/${event.requestId}`;
    // Start before sending so a stalled claim response cannot invoke an expired action.
    const deadline = performance.now() + VOICE_INBOX_ACTION_TIMEOUT_MS;
    const response = await fetch(path + "/claim", { method: "POST" });
    if (!response.ok) return;
    let invoked = false;
    try {
      if (performance.now() < deadline && document.hasFocus() && !document.hidden &&
          findCard() === card && card.querySelector(selector) === button) {
        const callback = voiceButtonActions.get(button);
        if (callback) {
          callback(event.text);
          invoked = true;
        }
      }
    } finally {
      await fetch(path + "/complete", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ invoked }) });
    }
  }
}
