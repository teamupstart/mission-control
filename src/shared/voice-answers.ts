import { z } from "zod";
import type { PlanDecisionAnswer } from "./types.ts";

export const VOICE_REPORT_REVISION_HEADER = "x-voice-report-revision";
export const VOICE_FOCUS_TIME_HEADER = "x-voice-focus-at-us";
export const VOICE_CARDS_OBSERVED_HEADER = "x-voice-cards-observed-at-ms";
export const VOICE_CARDS_EARLIEST_HEADER = "x-voice-cards-earliest-at-ms";
export const VOICE_OBSERVATION_ID_HEADER = "x-voice-observation-id";
export const VOICE_CALIBRATING_HEADER = "x-voice-calibrating";
export const VOICE_CONFIRM_FOCUS_HEADER = "x-voice-confirm-focus";
export const VOICE_MONOTONIC_TIME_HEADER = "x-voice-monotonic-time-ms";

/** A document or daemon keeps its monotonic time origin across a wall clock adjustment.
 * Reuse a calibration within the millisecond resolution of Date.now(). */
export function voiceFocusClockSkewMs(previous = 0): number {
  const skew = Math.floor(performance.timeOrigin + performance.now()) - Date.now();
  return Math.abs(skew - previous) <= 1 ? previous : skew;
}

export const OpenCardsSchema = z.object({
  windowId: z.string().min(1).max(128),
  focused: z.boolean(),
  cards: z.array(z.object({ kind: z.literal("question"), id: z.string().min(1), focused: z.boolean() }).strict()).max(512),
}).strict();
export type OpenCardsReport = z.infer<typeof OpenCardsSchema>;
export interface VoiceTimeBounds { earliest: number; latest: number }

/** Reordering cards, or moving within a sole open card, preserves the spoken reply target. */
export function voiceReplyState(report?: OpenCardsReport): string | undefined {
  if (!report?.focused || !report.cards.length) return undefined;
  return JSON.stringify([report.windowId, report.cards.toSorted((a, b) => a.id.localeCompare(b.id))
    .map(card => [card.id, report.cards.length > 1 && card.focused])]);
}

export interface VoiceAnswer {
  id: string;
  /** A manual edit can cancel the same pending answer across action revisions. */
  originId?: string;
  reviewId: string;
  selections: PlanDecisionAnswer[] | null;
  text: string;
  label: string;
  deadline: number;
  windowMs: number;
  switched: boolean;
  footerWindowId?: string;
}

export function optionLetter(index: number): string {
  return (index >= 26 ? optionLetter(Math.floor(index / 26) - 1) : "") + String.fromCharCode(65 + index % 26);
}
