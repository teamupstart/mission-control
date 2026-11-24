import type { VoiceCard } from "@shared/voice-routing.ts";

export type DashboardVoiceCard = VoiceCard & { localDeadline?: number; provisionalDeadline?: boolean };

type Estimate = { offset: number; uncertain: boolean };

/** Bounds on the browser's monotonic time minus daemon wall time. Request travel time
 * and response travel time are both unknown. Intersect samples from independent requests. */
export class VoiceCardClock {
  private lower = -Infinity;
  private upper = Infinity;

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
  if (previous?.deadline === card.deadline && previous.localDeadline !== undefined && !previous.provisionalDeadline) {
    return { ...card, localDeadline: previous.localDeadline };
  }
  return { ...card, localDeadline: card.deadline + sample.offset, provisionalDeadline: sample.uncertain };
}

export function voiceCardDeadline(card: DashboardVoiceCard): number | null {
  if (card.deadline === null) return null;
  return card.localDeadline ?? card.deadline - performance.timeOrigin;
}

/** Release the buttons early enough to retry without withdrawing an in-transit request. */
export function voiceCardRetryDelay(deadline: number | null): number {
  return deadline === null ? 2000 : Math.min(2000, Math.max(1, (deadline - performance.now()) / 2));
}
