import { z } from "zod";
import type { PlanDecisionAnswer } from "./types.ts";

export const VOICE_FOCUS_TIME_HEADER = "x-voice-focus-at-us";

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
}

export function optionLetter(index: number): string {
  return (index >= 26 ? optionLetter(Math.floor(index / 26) - 1) : "") + String.fromCharCode(65 + index % 26);
}
