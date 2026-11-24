import type { VoiceCard } from "@shared/voice-routing.ts";

import type { VoiceAnswer, VoiceTimeBounds } from "@shared/voice-answers.ts";

type LocalDeadline = { localDeadline?: number; provisionalDeadline?: boolean };
export type DashboardVoiceCard = VoiceCard & LocalDeadline;
export type DashboardVoiceAnswer = VoiceAnswer & LocalDeadline;
export type VoiceCardRetention = "reading" | "in-use" | "hidden-feedback";

type Estimate = { offset: number; uncertain: boolean };

/** Bounds on the browser's monotonic time minus daemon wall time. Request travel time
 * and response travel time are both unknown. Intersect samples from independent requests. */
export class VoiceCardClock {
  private lower = -Infinity;
  private upper = Infinity;

  /** Earliest and latest daemon time consistent with both legs of every round trip. */
  serverTimeAt(localTime: number): VoiceTimeBounds | undefined {
    if (!Number.isFinite(this.lower)) return undefined;
    return { earliest: Math.max(0, Math.floor(localTime - this.upper)), latest: Math.max(0, Math.ceil(localTime - this.lower)) };
  }

  observe(sent: number, received: number, serverStart: number, serverEnd: number): Estimate {
    const lower = sent - serverStart - 1; // The daemon clock has millisecond resolution.
    const upper = received - serverEnd + 1;
    if (lower > this.upper || upper < this.lower) {
      // The daemon wall clock or the browser's monotonic clock moved between samples.
      this.lower = lower;
      this.upper = upper;
    } else {
      this.lower = Math.max(this.lower, lower);
      this.upper = Math.min(this.upper, upper);
    }
    // Until the latest possible deadline the daemon may still accept Cancel. Its
    // response settles the action even when the independent time probe failed.
    return { offset: this.upper, uncertain: this.upper - this.lower > 100 };
  }
}

/** Split-part updates and reconnect snapshots keep an already calibrated cancel window. */
export function receiveVoiceCard(card: VoiceCard, sample: Estimate, previous?: DashboardVoiceCard): DashboardVoiceCard {
  if (card.state !== "pending" || card.deadline === null) return card;
  return receiveVoiceCountdown(card, sample, previous);
}

export function receiveVoiceCountdown<T extends { id: string; deadline: number | null }>(
  card: T, sample: Estimate, previous?: T & LocalDeadline,
): T & LocalDeadline {
  if (card.deadline === null) return card;
  if (previous?.id === card.id && previous.deadline === card.deadline && previous.localDeadline !== undefined && !previous.provisionalDeadline) {
    return { ...card, localDeadline: previous.localDeadline };
  }
  return { ...card, localDeadline: card.deadline + sample.offset, provisionalDeadline: sample.uncertain };
}

export function voiceCardDeadline(card: { deadline: number | null } & LocalDeadline): number | null {
  if (card.deadline === null) return null;
  return card.localDeadline ?? card.deadline - performance.timeOrigin;
}

/** Both confirmation surfaces display at most the configured cancel window. */
export function voiceCountdownSeconds(remainingMs: number, windowMs?: number): number {
  return Math.ceil(Math.max(0, Math.min(remainingMs, windowMs ?? remainingMs)) / 1000);
}

/** Release the buttons early enough to retry without withdrawing an in-transit request. */
export function voiceCardRetryDelay(deadline: number | null): number {
  return deadline === null ? 2000 : Math.min(2000, Math.max(1, (deadline - performance.now()) / 2));
}
