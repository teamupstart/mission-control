import { z } from "zod";
import type { PlanDecisionAnswer } from "./types.ts";

export const VOICE_REPORT_REVISION_HEADER = "x-voice-report-revision";
export const VOICE_FOCUS_TIME_HEADER = "x-voice-focus-at-us";

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

export interface VoiceAnswer {
  id: string;
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
