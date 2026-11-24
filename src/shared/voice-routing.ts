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
  detail?: string;
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

const BOUNDARY_PUNCTUATION = /^[\p{P}\s]+|[\p{P}\s]+$/gu;

function normalized(text: string): string {
  return normalizeSpokenName(text).replace(BOUNDARY_PUNCTUATION, "").trim();
}

function barePhrase(text: string): string {
  return normalizeSpokenName(text).replace(/[\p{Sentence_Terminal}…]+$/u, "").trimEnd();
}

interface Token { raw: string; index: number }

function namesStartingAt(text: string, token: Token, next?: Token): [string] | [string, string] {
  const first = normalized(token.raw);
  if (!next || !/^\s+$/u.test(text.slice(token.index + token.raw.length, next.index))) return [first];
  return [first, normalized(text.slice(token.index, next.index + next.raw.length))];
}

function observedPause(words: VoiceUtterance["words"], tokens: Token[], addressWords: number): number | null {
  let index = 0;
  let previousEndMs = 0;
  for (const word of words) {
    const timedText = normalized(word.text);
    if (!timedText) continue;
    const token = tokens[index];
    if (!token || normalized(token.raw) !== timedText) return null;
    if (index === addressWords) return word.startMs - previousEndMs;
    previousEndMs = word.endMs;
    index++;
  }
  return null;
}

// Unicode paired brackets and typographic quote pairs. An unknown closer stays in the message.
const WRAPPER_PAIRS = new Set(`
  "" '' () [] {} «» ‹› ‘’ “” ‛’ ‟” ‚’ „” 〝〞 〝〟
  ༺༻ ༼༽ ᚛᚜ ⁅⁆ ⁽⁾ ₍₎ ⌈⌉ ⌊⌋ 〈〉 ❨❩ ❪❫ ❬❭ ❮❯ ❰❱ ❲❳ ❴❵
  ⟅⟆ ⟦⟧ ⟨⟩ ⟪⟫ ⟬⟭ ⟮⟯ ⦃⦄ ⦅⦆ ⦇⦈ ⦉⦊ ⦋⦌ ⦍⦐ ⦏⦎ ⦑⦒ ⦓⦔ ⦕⦖ ⦗⦘
  ⧘⧙ ⧚⧛ ⧼⧽ ⸂⸃ ⸄⸅ ⸉⸊ ⸌⸍ ⸜⸝ ⸠⸡ ⸢⸣ ⸤⸥ ⸦⸧ ⸨⸩ ⹕⹖ ⹗⹘ ⹙⹚ ⹛⹜
  〈〉 《》 「」 『』 【】 〔〕 〖〗 〘〙 〚〛 ︗︘ ︵︶ ︷︸ ︹︺ ︻︼ ︽︾ ︿﹀ ﹁﹂ ﹃﹄ ﹇﹈
  ﹙﹚ ﹛﹜ ﹝﹞ （） ［］ ｛｝ ｟｠ ｢｣
`.trim().split(/\s+/u));

function wrappedAddressBoundary(text: string, roster: readonly SpokenName[]): number {
  const prefix = text.match(/^[\s\p{Ps}\p{Pi}"']+/u)?.[0] ?? "";
  const wrappers = prefix.match(/[\p{Ps}\p{Pi}"']/gu) ?? [];
  if (!wrappers.length) return text.length;
  const inner = text.slice(prefix.length);
  for (const mark of inner.matchAll(/[,\p{Pe}\p{Pf}"']/gu)) {
    const char = mark[0];
    if (char === ",") break;
    // An apostrophe inside a roster spelling is part of the name, even in single quotes.
    if ((char === "'" || char === "’") && /[\p{L}\p{N}]/u.test(inner[mark.index + 1] ?? "") &&
        roster.some(({ name }) => normalizeSpokenName(name).startsWith(normalizeSpokenName(inner.slice(0, mark.index + 2))))) continue;
    if (!WRAPPER_PAIRS.has(wrappers.pop()! + char)) break;
    if (!wrappers.length) {
      const end = prefix.length + mark.index + char.length;
      const adjacent = text.slice(end).match(/^[^\s,]+/u)?.[0];
      return adjacent && normalized(adjacent) ? end : text.length;
    }
  }
  return text.length;
}

function tokensIn(span: string, offset: number): Token[] {
  return Array.from(span.matchAll(/[^\s,]+/gu), (m) => ({ raw: m[0], index: offset + m.index }))
    .filter(({ raw }) => normalized(raw));
}

// A comma can fall inside a quoted address (“Will,”) or before a quoted message (Will,"go").
function messageAfterAddress(text: string, end: number): { body: string; wrappersClosed: boolean } {
  const rest = text.slice(end).trimStart();
  const separatorLength = rest.startsWith(",") ? 1 : 0;
  let bodyStart = separatorLength;
  const address = text.slice(0, end).trimStart();
  const prefix = address.match(/^[\p{P}\s]+/u)?.[0] ?? "";
  const trailing = address.match(/\p{P}+$/u)?.[0] ?? "";
  const wrappers = prefix.match(/[\p{Ps}\p{Pi}"']/gu) ?? [];
  // Only a wrapper that closes around the name belongs to the address. Any other
  // bracket or quote after the name starts the literal message at that mark.
  for (const mark of trailing.matchAll(/[\p{Ps}\p{Pe}\p{Pi}\p{Pf}"']/gu)) {
    if (!WRAPPER_PAIRS.has((wrappers.pop() ?? "") + mark[0])) {
      return { body: text.slice(end - trailing.length + mark.index).trimEnd(), wrappersClosed: false };
    }
  }
  while (wrappers.length) {
    const closing = rest.slice(bodyStart).match(/^\s*([\p{Pe}\p{Pf}"'])/u);
    if (!closing || !WRAPPER_PAIRS.has(wrappers.at(-1)! + closing[1])) break;
    const afterMark = bodyStart + closing[0].length;
    // A straight quote can open the next word instead of closing the address.
    if ((closing[1] === '"' || closing[1] === "'") &&
        /^[^\s,\p{Sentence_Terminal}…\p{Pe}\p{Pf}"']/u.test(rest.slice(afterMark))) break;
    wrappers.pop();
    bodyStart = afterMark;
  }
  if (bodyStart > separatorLength) {
    // Terminal punctuation attached to a standalone closer also belongs to the quoted name.
    bodyStart += rest.slice(bodyStart).match(/^[\p{Sentence_Terminal}…]+/u)?.[0].length ?? 0;
    bodyStart += rest.slice(bodyStart).match(/^\s*,/u)?.[0].length ?? 0;
  }
  return { body: rest.slice(bodyStart).trimStart(), wrappersClosed: wrappers.length === 0 };
}

export function routeUtterance(utterance: VoiceUtterance, context: {
  roster: readonly SpokenName[];
  unsureCards?: readonly VoiceCard[];
}): Decision {
  const { text, words } = utterance;
  // Keep offsets into the original capture. Name matching ignores boundary punctuation,
  // while a message made entirely of punctuation still has a body.
  const boundary = wrappedAddressBoundary(text, context.roster);
  const tokens = tokensIn(text.slice(0, boundary), 0).concat(tokensIn(text.slice(boundary), boundary));
  const [firstToken, secondToken] = tokens;
  if (!firstToken) return { kind: "ignored", reason: "no-name" };
  const bodyAfter = (token: Token) => messageAfterAddress(text, token.index + token.raw.length);
  const phrase = bodyAfter(tokens.at(-1)!).body ? null : normalized(text);
  const controlPhrase = barePhrase(text);
  if (controlPhrase === "cancel") return { kind: "control", command: "cancel" };
  const pickName = phrase !== null ? controlPhrase : null;
  const picks = (context.unsureCards ?? []).flatMap((card) => card.candidates
    .filter((candidate) => normalized(candidate.title) === pickName)
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
      // Internal punctuation may belong to a literal roster name such as "Dr. Ada".
      // A phonetic key would erase it and could cross a sentence boundary.
      if (kind === "phonetic" && /\p{P} | \p{P}/u.test(heard)) continue;
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
  const { body, wrappersClosed } = bodyAfter(tokens[count - 1]!);
  if (!body) return { kind: "ignored", reason: "no-message" };
  const pauseMs = observedPause(words, tokens, count);
  const command = wrappersClosed && barePhrase(body) === "stop" ? { command: "stop" as const } : {};
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
