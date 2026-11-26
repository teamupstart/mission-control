import { z } from "zod";
import { INBOX_ACTIONS, type InboxActionId } from "./inbox.ts";
import type { PlanDecisionAnswer } from "./types.ts";

export const VOICE_REPORT_REVISION_HEADER = "x-voice-report-revision";
export const VOICE_FOCUS_TIME_HEADER = "x-voice-focus-at-us";
export const VOICE_CARDS_OBSERVED_HEADER = "x-voice-cards-observed-at-ms";
export const VOICE_CARDS_EARLIEST_HEADER = "x-voice-cards-earliest-at-ms";
export const VOICE_OBSERVATION_ID_HEADER = "x-voice-observation-id";
export const VOICE_CALIBRATING_HEADER = "x-voice-calibrating";
export const VOICE_CONFIRM_FOCUS_HEADER = "x-voice-confirm-focus";
export const VOICE_DASHBOARD_CONFIRM_MS = 3000;
/** Each dashboard gets this long to claim an inbox action, then to confirm its invocation. */
export const VOICE_INBOX_ACTION_TIMEOUT_MS = 5000;
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
  dictationTarget: z.string().uuid().optional(),
  cards: z.array(z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("question"), sessionId: z.string().optional(), id: z.string().min(1), focused: z.boolean() }).strict(),
    z.object({ kind: z.enum(["plan", "report", "stuck"]), id: z.string().min(1), focused: z.boolean(),
      sessionId: z.string(), agentKey: z.string().optional(), actions: z.array(z.enum(INBOX_ACTIONS.map(a => a.id))).max(INBOX_ACTIONS.length).optional() }).strict(),
  ])).max(512),
}).strict();
export type OpenCardsReport = z.infer<typeof OpenCardsSchema>;
export interface VoiceTimeBounds { earliest: number; latest: number }

/** Reordering cards, or moving within a sole open card, preserves the spoken reply target. */
export function voiceReplyState(report?: OpenCardsReport): string | undefined {
  if (!report?.focused || !report.cards.length) return undefined;
  return JSON.stringify([report.windowId, report.cards.toSorted((a, b) => a.id.localeCompare(b.id))
    .map(card => [card.id, report.cards.length > 1 && card.focused])]);
}

export type VoiceFormFill = {
  reviewId: string;
  selections: PlanDecisionAnswer[];
};

type Address = { key: string; sessionId: string | null } | null;
export type DrawnVoiceCard = OpenCardsReport["cards"][number];

export function addressedCards(cards: DrawnVoiceCard[], address: Address) {
  return address ? cards.filter(c => (c.kind !== "question" && c.agentKey === address.key) ||
    (address.sessionId !== null && c.sessionId === address.sessionId)) : cards;
}

export function focusedVoiceCard(cards: DrawnVoiceCard[]) {
  const choices = cards.length === 1 ? cards : cards.filter(c => c.focused);
  return choices.length === 1 ? choices[0] : undefined;
}

/** A named plan command identifies the card type. Unnamed "reply" follows keyboard focus. */
export function planVoiceTarget(cards: DrawnVoiceCard[], address: Address) {
  const candidates = address ? addressedCards(cards, address).filter(c => c.kind === "plan") : cards;
  const card = focusedVoiceCard(candidates);
  return card?.kind === "plan" ? card : undefined;
}

export type VoiceInboxEvent = { address: Address } & (
  | ({ type: "voice_form_fill"; windowId: string; capturedAtMonotonicMs: number } & VoiceFormFill)
  | { type: "voice_form_submit"; reviewId: string; submitId: string; windowId: string }
  | { type: "voice_inbox_action"; windowId: string; cardId: string; kind: "report" | "stuck"; action: InboxActionId; text: string; requestId: string });

export function ordinal(position: number): string {
  const suffix = position % 100 >= 11 && position % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][position % 10] ?? "th";
  return position + suffix;
}

export function spokenOrdinal(position: number): string {
  const units = ["zeroth", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth",
    "tenth", "eleventh", "twelfth", "thirteenth", "fourteenth", "fifteenth", "sixteenth", "seventeenth", "eighteenth", "nineteenth"];
  const tens = ["twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
  if (position < 20) return units[position]!;
  if (position === 100) return "one hundredth";
  if (position > 100 && position < 200) return "one hundred " + spokenOrdinal(position - 100);
  const ten = tens[Math.floor(position / 10) - 2];
  if (!ten) return ordinal(position);
  return position % 10 ? ten + " " + units[position % 10] : ten.slice(0, -1) + "ieth";
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
