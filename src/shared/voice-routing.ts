import { z } from "zod";
import { VOICE_BACKENDS } from "./voice.ts";
import { editDistance, keysSoundAlike, normalizeSpokenName, phoneticKey, type SpokenName } from "./voice-names.ts";

const WordTiming = z.object({
  text: z.string().min(1),
  startMs: z.number().nonnegative(),
  endMs: z.number().nonnegative(),
}).strict().refine((word) => word.endMs >= word.startMs);

export const VoiceUtteranceSchema = z.object({
  id: z.string().min(1).max(128),
  text: z.string().min(1).max(16_384).refine((text) => text.trim().length > 0),
  words: z.array(WordTiming).max(4096).default([]),
  capturedAt: z.number().int().nonnegative(),
  backend: z.enum(VOICE_BACKENDS),
}).strict();
export type VoiceUtterance = z.infer<typeof VoiceUtteranceSchema>;

export type VoiceDeliveryOutcome = "sent" | "queued" | "held" | "not-running" | "failed";
export interface VoiceCard {
  id: string;
  state: "pending" | "resolving" | "unsure" | "cancelled" | VoiceDeliveryOutcome;
  parts: { target: SpokenName | null; text: string }[];
  deadline: number | null;
  candidates: { kind: "agent" | "question"; id: string; title: string; detail: string }[];
  reason: string;
  openQuestions: number;
}

export interface HeardEntry {
  id: string;
  time: number;
  text: string;
  outcome: VoiceCard["state"] | "control" | "ignored";
  rule: string;
  matchedName: string | null;
  pauseMs: number | null;
  detail: string;
}

type Decision =
  | { kind: "control"; command: "cancel" }
  | { kind: "control"; command: "pick"; cardId: string; candidateId: string }
  | { kind: "addressed"; command?: "stop"; target: SpokenName; match: "exact" | "phonetic"; text: string; pauseMs: number | null }
  | { kind: "needs-model"; candidates: SpokenName[]; text: string; reason: "ambiguous-name" | "second-name"; pauseMs: number | null }
  | { kind: "ignored"; reason: "near-miss" | "no-name"; closest?: string };

function normalized(text: string): string {
  return normalizeSpokenName(text).replace(/^\p{P}+|\p{P}+$/gu, "").trim();
}

export function isVoiceStop(text: string): boolean {
  return normalized(text) === "stop";
}

export function routeUtterance(utterance: VoiceUtterance, context: {
  roster: readonly SpokenName[];
  unsure?: VoiceCard;
}): Decision {
  const { text, words } = utterance;
  const phrase = normalized(text);
  if (phrase === "cancel") return { kind: "control", command: "cancel" };
  const picks = context.unsure?.candidates.filter((c) => normalized(c.title) === phrase);
  if (context.unsure && picks?.length === 1) {
    return { kind: "control", command: "pick", cardId: context.unsure.id, candidateId: picks[0]!.id };
  }

  // Compare whole tokens. Keep their offsets into the original so quoting, spacing and
  // punctuation inside the message survive the comparison.
  const tokens = Array.from(text.matchAll(/[^\s,]+(?:,+[\p{Pe}\p{Pf}"']*)?/gu)).filter((m) => normalized(m[0]));
  const names = context.roster.map((target) => ({ target, name: normalized(target.name) }));
  const first = normalized(tokens[0]?.[0] ?? "");
  if (!first) return { kind: "ignored", reason: "no-name" };
  const leading = (count: number) => tokens.slice(0, count).map((m) => normalized(m[0])).join(" ");
  let count = 1;
  let match: "exact" | "phonetic" = "exact";
  let candidates: SpokenName[] = [];
  // An exact first word wins even if a longer call sign shares it.
  for (const kind of ["exact", "phonetic"] as const) {
    for (const length of [1, 2]) {
      if (length > tokens.length) continue;
      const heard = leading(length);
      const heardKey = kind === "phonetic" ? phoneticKey(heard) : "";
      candidates = names.filter(({ name }) => {
        if (name.split(" ").length !== length) return false;
        if (kind === "exact") return heard === name;
        // Will and Willow can even have identical phonetic keys. A partial name is
        // never an address, but the complete "Steven" may still sound like Steve.
        const nameKey = phoneticKey(name);
        const possessive = heard.replace(/[’']s$/u, "");
        if (possessive === name) return true;
        if (name.startsWith(possessive) || (heardKey === nameKey && possessive.startsWith(name))) return false;
        return keysSoundAlike(heardKey, nameKey);
      }).map(({ target }) => target);
      if (candidates.length) {
        count = length;
        match = kind;
        break;
      }
    }
    if (candidates.length) break;
  }
  if (!candidates.length) {
    const near = names.filter(({ name }) => Math.abs(name.length - first.length) <= 1 && editDistance(first, name) === 1);
    if (!near.length) return { kind: "ignored", reason: "no-name" };
    if (near.length === 1) return { kind: "ignored", reason: "near-miss", closest: near[0]!.target.name };
    candidates = near.map(({ target }) => target);
  }
  const last = tokens[count - 1]!;
  const body = text.slice(last.index + last[0].length).replace(/^[,\s]+/u, "");
  const before = words[count - 1];
  const after = words[count];
  const pauseMs = before && after ? after.startMs - before.endMs : null;
  if (candidates.length > 1) return { kind: "needs-model", reason: "ambiguous-name", candidates, text: body, pauseMs };
  const target = candidates[0]!;
  if (match !== "exact" || count !== 1) {
    const remaining = tokens.slice(count).map((m) => normalized(m[0]));
    const mentions = new Set(remaining);
    for (let i = 1; i < remaining.length; i++) mentions.add(remaining[i - 1] + " " + remaining[i]);
    const later = names.filter(({ name, target: other }) => other.key !== target.key &&
      mentions.has(name));
    if (later.length) {
      return { kind: "needs-model", reason: "second-name", candidates: [target, ...later.map(({ target: other }) => other)], text: body, pauseMs };
    }
  }
  return { kind: "addressed", target, text: body, match, pauseMs, ...(isVoiceStop(body) ? { command: "stop" } : {}) };
}
