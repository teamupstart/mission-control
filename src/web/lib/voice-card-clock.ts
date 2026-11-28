import type { VoiceCard } from "@shared/voice-routing.ts";

import type { VoiceAnswer, VoiceTimeBounds } from "@shared/voice-answers.ts";

type LocalDeadline = { localDeadline?: number; provisionalDeadline?: boolean; firstReceivedAt?: number };
export type DashboardVoiceCard = VoiceCard & LocalDeadline;
export type DashboardVoiceAnswer = VoiceAnswer & LocalDeadline;
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

  /** How wide every translated time is: the shortest round trip seen, plus rounding. */
  get width(): number {
    return this.upper - this.lower;
  }

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
    return { offset: this.upper, uncertain: this.upper - this.lower > 100, receivedAt: received };
  }
}

/** Every focus observation is as wide as this clock. Speech that starts inside that width
 * cannot be ordered against the focus change, so the daemon asks for the reply again. */
export const VOICE_CARD_CLOCK_TIGHT_MS = 10;
/** The first sample usually lands in the dashboard's startup burst, when every round trip
 * is slow. Keep sampling, with growing pauses, until the interval is tight. */
export const VOICE_CARD_CLOCK_REFINE_DELAYS_MS: readonly number[] = [0, 100, 250, 500, 1000, 2000, 4000];

export type VoiceClockSample = { sent: number; received: number; stamp: number };

/** Narrow a usable but wide calibration in the background. `sampled` runs after each sample,
 * so the caller can re-report a focus observation whose bounds this clock just narrowed. */
export async function refineVoiceCardClock(clock: VoiceCardClock, sample: () => Promise<VoiceClockSample | null>,
  sampled: () => void, signal: AbortSignal, delays = VOICE_CARD_CLOCK_REFINE_DELAYS_MS): Promise<void> {
  for (const delay of delays) {
    if (signal.aborted || clock.width <= VOICE_CARD_CLOCK_TIGHT_MS) return;
    if (delay > 0) await new Promise<void>(resolve => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, delay);
      signal.addEventListener("abort", done, { once: true });
    });
    const result = signal.aborted ? null : await sample();
    if (!result || signal.aborted) continue;
    clock.observe(result.sent, result.received, result.stamp, result.stamp);
    sampled();
  }
}

/** Split-part updates and reconnect snapshots keep an already calibrated cancel window. */
export function receiveVoiceCard(card: VoiceCard, sample: Estimate, previous?: DashboardVoiceCard): DashboardVoiceCard {
  if (card.state !== "pending" || card.deadline === null) return card;
  return receiveVoiceCountdown(card, sample, previous);
}

export function receiveVoiceCountdown<T extends { id: string; deadline: number | null; windowMs?: number }>(
  card: T, sample: Estimate, previous?: T & LocalDeadline,
): T & LocalDeadline {
  if (card.deadline === null) return card;
  const sameWindow = previous?.id === card.id && previous.deadline === card.deadline;
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
