import type { VoiceCard } from "@shared/voice-routing.ts";

export type DashboardVoiceCard = VoiceCard & { localDeadline?: number };

/** Anchor a daemon deadline to performance.now() at SSE receipt, preserving the wire card. */
export function receiveVoiceCard(card: VoiceCard, clockOffset: number, previous?: DashboardVoiceCard): DashboardVoiceCard {
  if (card.state !== "pending" || card.deadline === null) return card;
  // A split-part update is still the same cancel window.
  const existing = previous?.deadline === card.deadline ? previous.localDeadline : undefined;
  return { ...card, localDeadline: existing ?? card.deadline + clockOffset };
}

export function voiceCardDeadline(card: DashboardVoiceCard): number | null {
  if (card.deadline === null) return null;
  return card.localDeadline ?? card.deadline - performance.timeOrigin;
}
