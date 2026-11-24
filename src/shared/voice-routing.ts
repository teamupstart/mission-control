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

/**
 * Where a later name would split an utterance: the first target's message (`head`) and the later
 * name's (`tail`), each verbatim from the text. Both messages need content beyond separators.
 */
export interface VoiceSplitPoint {
  target: SpokenName;
  /** Character offset of this name in the original utterance. */
  at: number;
  /** More than one captured target could be addressed starting at this offset. */
  ambiguousTarget?: true;
  commands?: readonly (VoiceAddressedCommand | undefined)[];
  head: string;
  tail: string;
}

/** Drop what joins two commands from the end of the first: separators and a joining word. */
function splitHead(text: string): string {
  // A comma may separate independent commands, or introduce one joining phrase.
  // Everything before that boundary belongs to the first message, including punctuation.
  const raw = text.trim().replace(/,$/u, "").trimEnd();
  const conjunction = /(?:^|,\s*|(?<=[\p{Sentence_Terminal};:…])\s+)(?:and\s+then|and|then|also|plus)$/iu.exec(raw)
    ?? /\s+(?:and\s+then|and|then)$/iu.exec(raw);
  if (!conjunction) return raw;
  const preceding = raw.slice(0, conjunction.index).trimEnd();
  // A literal directive or an unfinished phrase ("replace x with", "rename x to")
  // still needs the final word as its argument. The comma alone separates the address.
  const before = preceding.replace(/[\p{P}\s]+$/u, "");
  const literalVerb = /\b(?:spell|say|type|quote|repeat|pronounce|define|write|print)$/iu.exec(before);
  if (conjunction[0].startsWith(",")) {
    // "Say, then" still needs its object. "Update the keyword, and" already has one.
    const bareDirective = literalVerb && /^(?:please\s+)?$/iu.test(before.slice(0, literalVerb.index));
    return bareDirective ? raw : preceding;
  }
  if (literalVerb || /\b(?:word|term|literal|keyword|token|conjunction)$/iu.test(before)) return raw;
  if (/\b(?:or|use)$/iu.test(before)) return raw;
  const preposition = /\b(?:with|to|from|by|as|for|of|into)$/iu.exec(before);
  if (!preposition) return preceding;
  // In "who this is for", the question word already supplies the object of "for".
  const clause = before.slice(0, preposition.index).trimEnd().split(/[,;:.!?]|\b(?:and|but|then)\b/iu).at(-1) ?? "";
  const completeQuestion = /\b(?:who|whom|what|which)\b/iu.test(clause) &&
    /\b(?:am|is|are|was|were)(?:\s+(?:this|that|it|they|these|those|we|you|he|she|I))?$/iu.test(clause);
  return completeQuestion ? preceding : raw;
}

export type VoiceAddressedCommand = "stop";
export type VoiceRouteDecision = Decision;

type Decision =
  | { kind: "control"; command: "cancel" }
  | { kind: "control"; command: "pick"; cardId: string; candidateId: string }
  | { kind: "addressed"; command?: VoiceAddressedCommand; target: SpokenName; match: "exact" | "phonetic"; text: string; pauseMs: number | null }
  | { kind: "needs-model"; candidates: SpokenName[]; text: string; reason: "ambiguous-name"; match: "exact" | "phonetic"; command?: VoiceAddressedCommand; splits: VoiceSplitPoint[]; pauseMs: number | null }
  | { kind: "needs-model"; candidates: SpokenName[]; text: string; reason: "second-name"; pauseMs: number | null;
      /** The fixed first target: the model never chooses it (the first-word rule, spike S3). */
      target: SpokenName; match: "exact" | "phonetic";
      /** Each later name that could start a message of its own, in the order it was said. */
      splits: VoiceSplitPoint[] }
  | { kind: "ignored"; reason: "near-miss" | "no-name" | "no-message" | "ambiguous-pick"; closest?: string };

const BOUNDARY_PUNCTUATION = /^[\p{P}\s]+|[\p{P}\s]+$/gu;

function normalized(text: string): string {
  return normalizeSpokenName(text).replace(BOUNDARY_PUNCTUATION, "").trim();
}

function barePhrase(text: string): string {
  return normalizeSpokenName(text).replace(/[\p{Sentence_Terminal}…]+$/u, "").trimEnd();
}

function addressedCommand(text: string, wrappersClosed: boolean): VoiceAddressedCommand | undefined {
  return wrappersClosed && barePhrase(text) === "stop" ? "stop" : undefined;
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

/** Straight quotes can close the first command or open a quoted second address. */
function closingMessageQuotes(body: string, offset: number): Set<number> {
  const closers = new Set<number>();
  let open = "";
  for (const { 0: mark, index } of body.matchAll(/\\[\s\S]|["']/gu)) {
    if (mark.length !== 1) continue; // Escaped character.
    if (mark === "'" && /[\p{L}\p{N}]/u.test(body[index - 1] ?? "") &&
        (!open || /[\p{L}\p{N}]/u.test(body[index + 1] ?? ""))) continue; // Possessive or contraction.
    if (mark === open) {
      closers.add(offset + index);
      open = "";
    } else if (!open) {
      open = mark;
    }
  }
  return closers;
}

// A comma can fall inside a quoted address (“Will,”) or before a quoted message (Will,"go").
function messageAfterAddress(text: string, start: number, end: number): { body: string; offset: number; wrappersClosed: boolean } {
  const rest = text.slice(end).trimStart();
  const separatorLength = rest.startsWith(",") ? 1 : 0;
  let bodyStart = separatorLength;
  const address = text.slice(start, end).trimStart();
  const prefix = address.match(/^[\p{P}\s]+/u)?.[0] ?? "";
  const trailing = address.match(/\p{P}+$/u)?.[0] ?? "";
  const wrappers = prefix.match(/[\p{Ps}\p{Pi}"']/gu) ?? [];
  // Only a wrapper that closes around the name belongs to the address. Any other
  // bracket or quote after the name starts the literal message at that mark.
  for (const mark of trailing.matchAll(/[\p{Ps}\p{Pe}\p{Pi}\p{Pf}"']/gu)) {
    if (!WRAPPER_PAIRS.has((wrappers.pop() ?? "") + mark[0])) {
      const offset = end - trailing.length + mark.index;
      return { body: text.slice(offset).trimEnd(), offset, wrappersClosed: false };
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
  const body = rest.slice(bodyStart).trimStart();
  return { body, offset: text.length - body.length, wrappersClosed: wrappers.length === 0 };
}

export function routeUtterance(utterance: VoiceUtterance, context: {
  roster: readonly SpokenName[];
  unsureCards?: readonly VoiceCard[];
  /** Candidates from a past card state at the time the speech was captured. */
  priorPickNames?: readonly string[];
}): Decision {
  const { text, words } = utterance;
  // Keep offsets into the original capture. Name matching ignores boundary punctuation,
  // while a message made entirely of punctuation still has a body.
  const boundary = wrappedAddressBoundary(text, context.roster);
  const tokens = tokensIn(text.slice(0, boundary), 0).concat(tokensIn(text.slice(boundary), boundary));
  const [firstToken, secondToken] = tokens;
  if (!firstToken) return { kind: "ignored", reason: "no-name" };
  const bodyAfter = (token: Token) => messageAfterAddress(text, 0, token.index + token.raw.length);
  const phrase = bodyAfter(tokens.at(-1)!).body ? null : normalized(text);
  const controlPhrase = barePhrase(text);
  if (controlPhrase === "cancel") return { kind: "control", command: "cancel" };
  const pickName = phrase !== null ? controlPhrase : null;
  if (pickName && context.priorPickNames?.some(name => normalized(name) === pickName)) {
    return { kind: "ignored", reason: "ambiguous-pick" };
  }
  const picks = (context.unsureCards ?? []).flatMap((card) => card.candidates
    .filter((candidate) => normalized(candidate.title) === pickName)
    .map((candidate) => ({ card, candidateId: candidate.id })));
  if (picks.length === 1 && picks[0]!.card.state === "unsure") {
    return { kind: "control", command: "pick", cardId: picks[0]!.card.id, candidateId: picks[0]!.candidateId };
  }
  if (picks.length) return { kind: "ignored", reason: "ambiguous-pick" };

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
  const { body, offset, wrappersClosed } = bodyAfter(tokens[count - 1]!);
  if (!body) return { kind: "ignored", reason: "no-message" };
  const pauseMs = observedPause(words, tokens, count);
  const command = addressedCommand(body, wrappersClosed);
  const target = candidates[0]!;
  // A later roster name may start a message of its own or only be talked about. The first
  // target stays fixed whichever it is: the model is asked split or mention, never who.
  const splitCandidates = new Set([target]);
  const splits: VoiceSplitPoint[] = [];
  const closingQuotes = closingMessageQuotes(body, offset);
  for (let i = count; i < tokens.length; i++) {
    const at = tokens[i]!;
    const laterNames = namesStartingAt(text, at, tokens[i + 1]);
    const atStart = splits.length;
    for (let length = laterNames.length; length > 0; length--) {
      const end = tokens[i + length - 1]!;
      const heard = laterNames[length - 1];
      const matches = names.filter(({ name }) => name === heard);
      if (!matches.length) continue;
      const preceding = text.slice(offset, at.index);
      const wrappers = preceding.match(/(?:^|[,\s])([\p{Ps}\p{Pi}"'\s]+)$/u)?.[1] ?? "";
      const wrapperStart = at.index - wrappers.length;
      let addressStart = wrapperStart;
      for (const mark of wrappers.matchAll(/["']/gu)) {
        const index = wrapperStart + mark.index;
        if (closingQuotes.has(index)) addressStart = index + 1;
      }
      const head = splitHead(text.slice(offset, addressStart));
      const second = messageAfterAddress(text, addressStart, end.index + end.raw.length);
      const tail = second.body.trim();
      const content = /[\p{L}\p{N}\p{S}]|\p{Emoji}\uFE0F|[#*]\u20E3/u;
      if (content.test(head) && content.test(tail)) {
        const commands = [addressedCommand(head, wrappersClosed), addressedCommand(second.body, second.wrappersClosed)];
        const nameOffset = at.index + (at.raw.match(/^\p{P}+/u)?.[0].length ?? 0);
        for (const other of matches) {
          splits.push({ target: other.target, at: nameOffset, head, tail, ...(commands.some(Boolean) && { commands }) });
          splitCandidates.add(other.target);
        }
      }
    }
    // For example, both Release and Release Captain may start at this word.
    if (splits.length > atStart + 1) {
      for (let j = atStart; j < splits.length; j++) splits[j]!.ambiguousTarget = true;
    }
  }
  if (candidates.length > 1) return { kind: "needs-model", reason: "ambiguous-name", match, splits, candidates, text: body, pauseMs, ...(command && { command }) };
  if (splits.length) {
    return { kind: "needs-model", reason: "second-name", candidates: [...splitCandidates], text: body, pauseMs, target, match, splits };
  }
  return { kind: "addressed", target, text: body, match, pauseMs, ...(command && { command }) };
}
