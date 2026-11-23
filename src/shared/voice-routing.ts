import { z } from "zod";
import { VOICE_BACKENDS } from "./voice.ts";
import { editDistance, keysSoundAlike, normalizeSpokenName, phoneticKey, type SpokenName } from "./voice-names.ts";

const WordTiming = z.object({
  text: z.string().min(1),
  startMs: z.number().nonnegative(),
  endMs: z.number().nonnegative(),
}).strict().refine((word) => word.endMs >= word.startMs);

export const VoiceUtteranceSchema = z.object({
  id: z.string().min(1).max(128).regex(/^[A-Za-z0-9._~-]+$/u, "Use URL-unreserved characters for the capture ID.")
    .refine((id) => id !== "." && id !== "..", "A capture ID cannot be a dot segment."),
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

export type VoiceAddressedCommand = "stop";

type Decision =
  | { kind: "control"; command: "cancel" }
  | { kind: "control"; command: "pick"; cardId: string; candidateId: string }
  | { kind: "addressed"; command?: VoiceAddressedCommand; target: SpokenName; match: "exact" | "phonetic"; text: string; pauseMs: number | null }
  | { kind: "needs-model"; command?: VoiceAddressedCommand; candidates: SpokenName[]; text: string; reason: "ambiguous-name" | "second-name"; pauseMs: number | null }
  | { kind: "ignored"; reason: "near-miss" | "no-name" | "no-message" | "ambiguous-pick"; closest?: string };

function normalized(text: string): string {
  return normalizeSpokenName(text).replace(/^\p{P}+|\p{P}+$/gu, "").trim();
}

function namesStartingAt(text: string, token: RegExpExecArray, next?: RegExpExecArray): [string] | [string, string] {
  const first = normalized(token[0]);
  if (!next || text.slice(token.index, next.index).includes(",")) return [first];
  return [first, first + " " + normalized(next[0])];
}

function observedPause(words: VoiceUtterance["words"], tokens: RegExpExecArray[], addressWords: number): number | null {
  let index = 0;
  let previousEndMs = 0;
  for (const word of words) {
    const timedText = normalized(word.text);
    if (!timedText) continue;
    const token = tokens[index];
    if (!token || normalized(token[0]) !== timedText) return null;
    if (index === addressWords) return word.startMs - previousEndMs;
    previousEndMs = word.endMs;
    index++;
  }
  return null;
}

function closesWrapper(opener: string, closer: string): boolean {
  if (opener === '"' || opener === "'") return closer === opener;
  if (/\p{Ps}/u.test(opener)) return /\p{Pe}/u.test(closer);
  return /\p{Pf}/u.test(closer);
}

// A comma can fall inside a quoted address (“Will,”) or before a quoted message (Will,"go").
function messageAfterAddress(text: string, start: number, end: number): string {
  const rest = text.slice(end).trimStart();
  if (!rest.startsWith(",")) return rest;
  let bodyStart = 1;
  const address = text.slice(start, end);
  const opening = address.match(/^[\p{Ps}\p{Pi}"']+/u)?.[0] ?? "";
  const trailing = address.match(/\p{P}+$/u)?.[0] ?? "";
  // Wrappers already closed before the comma belong to the address token itself.
  const closed = trailing.match(/[\p{Pe}\p{Pf}"']/gu)?.length ?? 0;
  for (const opener of [...opening].reverse().slice(closed)) {
    const closer = rest.slice(bodyStart).match(/^[\p{Pe}\p{Pf}"']/u)?.[0];
    if (!closer || !closesWrapper(opener, closer)) break;
    bodyStart += closer.length;
  }
  // An inner comma in “Will,” may be followed by one outer address separator.
  if (bodyStart > 1 && rest[bodyStart] === ",") bodyStart++;
  return rest.slice(bodyStart).trimStart();
}

export function routeUtterance(utterance: VoiceUtterance, context: {
  roster: readonly SpokenName[];
  unsureCards?: readonly VoiceCard[];
}): Decision {
  const { text, words } = utterance;
  // Keep offsets into the original capture. Name matching ignores boundary punctuation,
  // while a message made entirely of punctuation still has a body.
  const tokens = Array.from(text.matchAll(/[^\s,]+/gu)).filter((m) => normalized(m[0]));
  const [firstToken, secondToken] = tokens;
  if (!firstToken) return { kind: "ignored", reason: "no-name" };
  const bodyAfter = (token: RegExpExecArray) => messageAfterAddress(text, firstToken.index, token.index + token[0].length);
  const phrase = bodyAfter(tokens.at(-1)!) ? null : normalized(text);
  if (phrase === "cancel") return { kind: "control", command: "cancel" };
  const picks = (context.unsureCards ?? []).flatMap((card) => card.candidates
    .filter((candidate) => normalized(candidate.title) === phrase)
    .map((candidate) => ({ cardId: card.id, candidateId: candidate.id })));
  if (picks.length === 1) return { kind: "control", command: "pick", ...picks[0]! };
  if (picks.length > 1) return { kind: "ignored", reason: "ambiguous-pick" };

  const names = context.roster.map((target) => ({ target, name: normalized(target.name) }));
  if (names.some(({ name }) => name === phrase)) return { kind: "ignored", reason: "no-message" };
  const leadingNames = namesStartingAt(text, firstToken, secondToken);
  let count = 1;
  let match: "exact" | "phonetic" = "exact";
  let candidates: SpokenName[] = [];
  // The first exact match wins. For phonetic matches, retain the longest matching name.
  for (const kind of ["exact", "phonetic"] as const) {
    for (const [index, heard] of leadingNames.entries()) {
      const length = index + 1;
      const heardKey = kind === "phonetic" ? phoneticKey(heard) : "";
      const matches = names.filter(({ name }) => {
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
      if (matches.length) {
        candidates = matches;
        count = length;
        match = kind;
        if (kind === "exact") break;
      }
    }
    if (candidates.length) break;
  }
  if (!candidates.length) {
    const first = leadingNames[0];
    const near = names.filter(({ name }) => Math.abs(name.length - first.length) <= 1 && editDistance(first, name) === 1);
    if (!near.length) return { kind: "ignored", reason: "no-name" };
    if (near.length === 1) return { kind: "ignored", reason: "near-miss", closest: near[0]!.target.name };
    return { kind: "ignored", reason: "near-miss" };
  }
  const body = bodyAfter(tokens[count - 1]!);
  if (!body) return { kind: "ignored", reason: "no-message" };
  const pauseMs = observedPause(words, tokens, count);
  const stop = normalized(body) === "stop" && !/\p{Quotation_Mark}/u.test(body);
  const command = stop ? { command: "stop" as const } : {};
  if (candidates.length > 1) return { kind: "needs-model", reason: "ambiguous-name", candidates, text: body, pauseMs, ...command };
  const target = candidates[0]!;
  if (match !== "exact" || count !== 1) {
    const remaining = tokens.slice(count);
    const mentions = new Set(remaining.flatMap((token, i) => namesStartingAt(text, token, remaining[i + 1])));
    const later = names.filter(({ name, target: other }) => other.key !== target.key &&
      mentions.has(name));
    if (later.length) {
      return { kind: "needs-model", reason: "second-name", candidates: [target, ...later.map(({ target: other }) => other)], text: body, pauseMs, ...command };
    }
  }
  return { kind: "addressed", target, text: body, match, pauseMs, ...command };
}
