import type { InboxActionId } from "@shared/inbox.ts";
import { planVoiceTarget, VOICE_INBOX_ACTION_TIMEOUT_MS, type DrawnVoiceCard, type VoiceInboxEvent } from "@shared/voice-answers.ts";
import { updateReviewDraft } from "./review-drafts.ts";
import type { VoiceCardClock } from "./voice-card-clock.ts";

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
export const voiceButtonActions = new WeakMap<HTMLButtonElement, (text: string) => void | Promise<void>>();
const inFlight = new WeakSet<HTMLButtonElement>();

async function postInboxReceipt(id: string, stage: "claim" | "complete", invoked?: boolean): Promise<boolean> {
  try {
    const response = await fetch(`/api/voice/inbox-actions/${id}/${stage}`, { method: "POST",
      signal: AbortSignal.timeout(2 * VOICE_INBOX_ACTION_TIMEOUT_MS),
      ...(invoked !== undefined && { headers: { "content-type": "application/json" }, body: JSON.stringify({ invoked }) }) });
    if (response.ok) return true;
    console.warn("voice_inbox_action", id, stage, response.status);
  } catch {
    console.warn("voice_inbox_action", id, stage, "request failed");
  }
  return false;
}

export async function receiveInboxEvent(event: VoiceInboxEvent, clock: VoiceCardClock) {
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
      for (const selection of event.selections) {
        const answer = decisions[selection.decisionId];
        if (answer?.manualChoiceAt !== undefined) {
          const edited = clock.serverTimeAt(answer.manualChoiceAt - performance.timeOrigin);
          // Preserve the manual edit when the clocks cannot establish which came first.
          if (!edited || !(event.capturedAtMonotonicMs > edited.latest)) continue;
        }
        decisions[selection.decisionId] = { ...answer, note: answer?.note ?? "",
          other: answer?.other ?? "", selected: selection.selected, voice: true, chat: false };
      }
      return { ...draft, decisions };
    });
  } else {
    const selector = `button[data-voice-action="${event.action}"]`;
    const button = card.querySelector<HTMLButtonElement>(selector);
    if (!button || !voiceButtonActions.has(button) || inFlight.has(button)) return;
    // Start before sending so a stalled claim response cannot invoke an expired action.
    const deadline = performance.now() + VOICE_INBOX_ACTION_TIMEOUT_MS;
    inFlight.add(button);
    try {
      if (!await postInboxReceipt(event.requestId, "claim")) return;
      const callback = performance.now() < deadline && document.hasFocus() && !document.hidden &&
        findCard() === card && card.querySelector(selector) === button ? voiceButtonActions.get(button) : undefined;
      let invoked = false;
      let work: void | Promise<void> = undefined;
      try {
        if (callback) {
          work = callback(event.text);
          invoked = true;
        }
      } finally {
        // Acknowledge invocation before a slow action finishes. Hold the button through both.
        await Promise.all([work, postInboxReceipt(event.requestId, "complete", invoked)]);
      }
    } finally {
      inFlight.delete(button);
    }
  }
}
