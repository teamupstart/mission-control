import type { VoiceCard } from "@shared/voice-routing.ts";

export type DashboardVoiceCard = VoiceCard & { localDeadline?: number; provisionalDeadline?: boolean; firstReceivedAt?: number };
export type VoiceCardRetention = "reading" | "in-use" | "hidden-feedback";

type Estimate = { offset: number; uncertain: boolean; receivedAt: number };

/** Bounds on the browser's monotonic time minus daemon wall time. Request travel time
 * and response travel time are both unknown. Intersect samples from independent requests. */
export class VoiceCardClock {
  private lower = -Infinity;
  private upper = Infinity;

  private streamStart?: number;
  private requestStart?: number;
  epoch = 0;

  /** A stream spans many frames. Move old bounds into the new daemon epoch after a clock step. */
  observeStream(sent: number, received: number, serverStart: number, serverEnd: number) {
    const shift = this.requestStart === sent ? (this.streamStart ?? serverStart) - serverStart : 0;
    if (Math.abs(shift) > 2) {
      this.epoch++;
      this.lower += shift;
      this.upper += shift;
    }
    this.requestStart = sent;
    this.streamStart = serverStart;
    return this.observe(sent, received, serverStart, serverEnd);
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
    return { offset: this.upper, uncertain: this.upper - this.lower > 100, receivedAt: received };
  }
}

/** Split-part updates and reconnect snapshots keep an already calibrated cancel window. */
export function receiveVoiceCard(card: VoiceCard, sample: Estimate, previous?: DashboardVoiceCard): DashboardVoiceCard {
  if (card.state !== "pending" || card.deadline === null) return card;
  const sameWindow = previous?.deadline === card.deadline;
  const firstReceivedAt = (sameWindow ? previous.firstReceivedAt : undefined) ?? sample.receivedAt;
  if (sameWindow && previous.localDeadline !== undefined && !previous.provisionalDeadline) {
    return { ...card, firstReceivedAt, localDeadline: previous.localDeadline };
  }
  // Even an arbitrarily delayed frame was received after the daemon opened its window.
  // Reconnects and later clock probes cannot move that first-receipt upper bound.
  const translated = card.deadline + sample.offset;
  const localDeadline = card.windowMs === undefined ? translated : Math.min(translated, firstReceivedAt + card.windowMs);
  return { ...card, firstReceivedAt, localDeadline, provisionalDeadline: sample.uncertain };
}

export function voiceCardDeadline(card: DashboardVoiceCard): number | null {
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
