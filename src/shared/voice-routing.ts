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
export const VoiceCardNoticeSchema = z.object({
  id: z.string().uuid(), title: z.string().max(256), body: z.string().max(32768),
  remainingMs: z.number().int().positive(), scope: z.enum(["single", "both", "remaining"]).default("single"),
}).strict();
export type VoiceCardNotice = z.input<typeof VoiceCardNoticeSchema>;
/** A focus race can be retried on blur. A null result ends the request without an action. */
export type VoiceCardNoticeResult = "cancel" | "send-now" | "window-focused" | null;
export interface VoiceCard {
  id: string;
  state: "pending" | "resolving" | "unsure" | "cancelled" | VoiceDeliveryOutcome;
  parts: {
    target: SpokenName | null;
    /** The outbox owner when a restored turn no longer has a spoken roster entry. */
    restoredSession?: { id: string; name: string };
    text: string;
    outcome?: VoiceDeliveryOutcome | "cancelled";
    /** The addressed command executed for this receipt. */
    command?: VoiceAddressedCommand;
    detail?: string;
    /** The exact outbox row to recall, including after a two-part delivery. */
    turnId?: string;
    /** Addressed stops run as soon as routing resolves, even during a split's countdown. */
    immediateStop?: boolean;
  }[];
  mentions?: SpokenName[];
  windowMs?: number;
  deadline: number | null;
  candidates: { kind: "agent" | "question"; id: string; title: string; detail: string; target?: SpokenName }[];
  reason: string;
  /** What an unsure card from prefix recovery heard before the name, verbatim from the capture. */
  prefix?: string;
  openQuestions: number;
  questionTitle?: string;
  detail?: string;
}

export interface HeardEntry {
  id: string;
  time: number;
  text: string;
  outcome: VoiceCard["state"] | "control" | "ignored";
  rule: string;
  matchedName: string | null;
  matchedReferenceName?: true;
  /** Words prefix recovery looked past before the name, verbatim from the start of `text`. */
  prefix?: string;
  /** The names an unsure card from prefix recovery offered, in the order they were heard. */
  suggested?: string[];
  pauseMs: number | null;
  detail: string;
}

export function voiceCardCanExpire(card: VoiceCard): boolean {
  return !["pending", "resolving", "unsure", "held"].includes(card.state)
    && !card.parts.some(part => part.outcome === "held" || (part.immediateStop && !part.outcome));
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
  const prefix = text.trim();
  const raw = prefix.replace(/,$/u, "").trimEnd();
  // When only the comma separates the commands, a lone "and" or "then"
  // can be the first message's final word. Preserve that reading.
  const unmarkedJoiner = prefix.endsWith(",") ? /\s+and\s+then$/iu : /\s+(?:and\s+then|and|then)$/iu;
  const conjunction = /(?:^|,\s*|(?<=[\p{Sentence_Terminal};:…])\s+)(?:and\s+then|and|then|also|plus)$/iu.exec(raw)
    ?? unmarkedJoiner.exec(raw);
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
  if (prefix.endsWith(",") && /^\s+and\s+then$/iu.test(conjunction[0])) {
    // In "between if and then, Alice", the comma ends the comparison. Its "and" pairs
    // the two operands. A comparison already containing that "and" can take a joiner.
    const clause = before.split(/[.!?;:]/u).at(-1) ?? "";
    if (clause.match(/\b(?:between|and)\b/giu)?.at(-1)?.toLowerCase() === "between") return raw;
  }
  if (literalVerb || /\b(?:word|term|literal|keyword|token|conjunction|titled|entitled|called|named|labelled|labeled)$/iu.test(before)) return raw;
  if (/\b(?:or|use)$/iu.test(before)) return raw;
  // A replacement can introduce its literal operand with "with the text" or "to the string".
  if (/\b(?:with|to|from|as)\s+(?:the\s+)?(?:text|string|value)$/iu.test(before)) return raw;
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

/**
 * Present only on a decision prefix recovery produced: the words said before the call sign,
 * verbatim from the start of the capture up to the name. Every other field describes the rest.
 */
interface Recovered { prefix?: string }

type Decision =
  | { kind: "control"; command: "cancel" } & Recovered
  | { kind: "control"; command: "pick"; cardId: string; candidateId: string }
  | { kind: "addressed"; command?: VoiceAddressedCommand; target: SpokenName; match: "exact" | "phonetic"; text: string; pauseMs: number | null } & Recovered
  | { kind: "needs-model"; candidates: SpokenName[]; text: string; reason: "ambiguous-name"; match: "exact" | "phonetic"; command?: VoiceAddressedCommand; splits: VoiceSplitPoint[]; pauseMs: number | null }
  | { kind: "needs-model"; candidates: SpokenName[]; text: string; reason: "second-name"; pauseMs: number | null;
      /** The fixed first target: the model never chooses it (the first-word rule, spike S3). */
      target: SpokenName; match: "exact" | "phonetic";
      /** Each later name that could start a message of its own, in the order it was said. */
      splits: VoiceSplitPoint[] } & Recovered
  /**
   * Prefix recovery found a possible call sign after a word it cannot vouch for. The operator
   * confirms the recipient on an unsure card; nothing is sent and no model is asked.
   */
  | { kind: "suggest"; candidates: SpokenName[]; text: string; prefix: string; command?: VoiceAddressedCommand; pauseMs: number | null }
  | { kind: "ignored"; reason: "near-miss" | "no-name" | "no-message" | "ambiguous-pick"; closest?: string; closestReferenceName?: true };

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

const OPENING_QUOTES = new Set([...WRAPPER_PAIRS].map(pair => pair[0]!).filter(mark => /\p{Quotation_Mark}/u.test(mark)));

function messageQuotes(body: string, offset: number) {
  const closers = new Set<number>();
  const spans: { start: number; end: number; name: string }[] = [];
  const stack: { mark: string; index: number }[] = [];
  for (const { 0: mark, index } of body.matchAll(/\\[\s\S]|\p{Quotation_Mark}/gu)) {
    if (mark.startsWith("\\")) continue;
    const open = stack.at(-1);
    if ((mark === "'" || mark === "’") && /[\p{L}\p{N}]/u.test(body[index - 1] ?? "") &&
        (!open || /[\p{L}\p{N}]/u.test(body[index + 1] ?? ""))) continue;
    if (open && WRAPPER_PAIRS.has(open.mark + mark)) {
      stack.pop();
      closers.add(offset + index);
      if (!stack.length) spans.push({ start: offset + open.index, end: offset + index, name: normalized(body.slice(open.index + 1, index)) });
    } else if (OPENING_QUOTES.has(mark)) {
      stack.push({ mark, index });
    }
  }
  return { closers, spans };
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

export interface VoiceRouteContext {
  roster: readonly SpokenName[];
  unsureCards?: readonly VoiceCard[];
  /** Candidates from a past card state at the time the speech was captured. */
  priorPickNames?: readonly string[];
  /** The `voice-prefix-recovery` preview: look past a stray word or two the opening rule dropped. */
  prefixRecovery?: boolean;
}

/**
 * The opening-name rule (spike S3), then, with `prefixRecovery`, a bounded second look at an
 * utterance that rule dropped. Every decision the opening rule makes other than dropping for
 * want of an opening name is final, so recovery never changes a route that works today.
 */
export function routeUtterance(utterance: VoiceUtterance, context: VoiceRouteContext): Decision {
  const decision = routeOpening(utterance, context);
  if (!context.prefixRecovery || decision.kind !== "ignored" || (decision.reason !== "no-name" && decision.reason !== "near-miss")) return decision;
  return recoverPrefix(utterance, context.roster) ?? decision;
}

function routeOpening(utterance: VoiceUtterance, context: VoiceRouteContext): Decision {
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
    .filter((candidate) => candidate.kind === "agent" && normalized(candidate.title) === pickName)
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
    if (near.length === 1) return { kind: "ignored", reason: "near-miss", closest: near[0]!.target.name, ...(near[0]!.target.isReferenceName && { closestReferenceName: true }) };
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
  const quotes = messageQuotes(body, offset);
  let quoteIndex = 0;
  for (let i = count; i < tokens.length; i++) {
    const at = tokens[i]!;
    const nameOffset = at.index + (at.raw.match(/^\p{P}+/u)?.[0].length ?? 0);
    while (quoteIndex < quotes.spans.length && quotes.spans[quoteIndex]!.end <= nameOffset) quoteIndex++;
    const quote = quotes.spans[quoteIndex];
    const laterNames = namesStartingAt(text, at, tokens[i + 1]);
    const atStart = splits.length;
    let addressLength = 1;
    for (let length = laterNames.length; length > 0; length--) {
      const end = tokens[i + length - 1]!;
      const heard = laterNames[length - 1];
      // A quote around the name alone can mark an address. Words inside a quoted sentence belong to the message.
      if (quote && quote.start < nameOffset && heard !== quote.name) continue;
      const matches = names.filter(({ name }) => name === heard);
      if (!matches.length) continue;
      const preceding = text.slice(offset, at.index);
      const wrappers = preceding.match(/(?:^|[,\s])([\p{Ps}\p{Pi}"'\s]+)$/u)?.[1] ?? "";
      const wrapperStart = at.index - wrappers.length;
      let addressStart = wrapperStart;
      for (const mark of wrappers.matchAll(/["']/gu)) {
        const index = wrapperStart + mark.index;
        if (quotes.closers.has(index)) addressStart = index + 1;
      }
      const beforeName = text.slice(offset, addressStart).trimEnd();
      const head = splitHead(beforeName);
      // A separator or joining phrase introduces the whole call sign. With no
      // such boundary, "check the release Captain" can still address Captain.
      if (head !== beforeName || /[\p{Sentence_Terminal};:]$/u.test(beforeName)) {
        addressLength = Math.max(addressLength, length);
      }
      const second = messageAfterAddress(text, addressStart, end.index + end.raw.length);
      const tail = second.body.trim();
      const content = /[\p{L}\p{N}\p{S}]|\p{Emoji}\uFE0F|[#*]\u20E3/u;
      // Names are checked longest first. With no message after "Release Captain",
      // the second word of that call sign cannot become a message for "Release".
      if (!content.test(tail)) break;
      if (!content.test(head)) {
        // No command precedes this call sign. Its own words cannot supply that command
        // for a split starting inside the name.
        addressLength = Math.max(addressLength, length);
        break;
      }
      const commands = [addressedCommand(head, wrappersClosed), addressedCommand(second.body, second.wrappersClosed)];
      for (const other of matches) {
        splits.push({ target: other.target, at: nameOffset, head, tail, ...(commands.some(Boolean) && { commands }) });
        splitCandidates.add(other.target);
      }
    }
    // For example, both Release and Release Captain may start at this word.
    if (splits.length > atStart + 1) {
      for (let j = atStart; j < splits.length; j++) splits[j]!.ambiguousTarget = true;
    }
    i += addressLength - 1;
  }
  if (candidates.length > 1) return { kind: "needs-model", reason: "ambiguous-name", match, splits, candidates, text: body, pauseMs, ...(command && { command }) };
  if (splits.length) {
    return { kind: "needs-model", reason: "second-name", candidates: [...splitCandidates], text: body, pauseMs, target, match, splits };
  }
  return { kind: "addressed", target, text: body, match, pauseMs, ...(command && { command }) };
}

// ---- prefix recovery (the `voice-prefix-recovery` preview) ----
//
// A noise or filler word transcribed before the call sign leaves "Um, Steve, check the build."
// without an opening name. Recovery looks past at most two such words, routes only when the
// words are known not to carry meaning and a clear exact call sign with its own boundary follows,
// asks on an unsure card when the address is plausible but not certain, and otherwise leaves the
// utterance dropped. It never searches further into the sentence and never asks a model who.

/** Non-lexical fillers: "Um, Steve, check the build." */
export const VOICE_PREFIX_FILLERS: ReadonlySet<string> = new Set([
  "um", "umm", "uh", "uhh", "er", "erm", "ah", "hmm", "hm", "mm", "mmm", "mhm", "mm-hmm", "uh-huh", "huh", "eh",
]);
/** Discourse openers that introduce a call sign, as in "Okay, Steve, check the build." */
export const VOICE_PREFIX_OPENERS: ReadonlySet<string> = new Set([
  "oh", "okay", "ok", "so", "hey", "hi", "hello", "yo", "yeah", "right", "well", "and", "alright",
]);
/**
 * Function words a recognizer writes for a cough or a knock. "The Atlas, our deploy box, is down."
 * is grammatical, so one of these routes only when its own punctuation cuts it off ("The. Atlas,").
 */
export const VOICE_PREFIX_NOISE_WORDS: ReadonlySet<string> = new Set(["the", "a", "an", "you", "i"]);
/** Before a name these report or relay speech ("Tell Steve, check the build"): never an address. */
const RELAY_WORDS: ReadonlySet<string> = new Set([
  "tell", "told", "ask", "asked", "say", "said", "says", "let", "have", "get", "make", "ping", "message", "remind",
  "call", "text", "email", "show", "give", "send", "thank", "thanks", "dear",
]);

/** A boundary the recognizer wrote right after the name: a comma or a sentence or clause mark. */
function delimitedAfter(text: string, token: Token): boolean {
  return /[\p{Sentence_Terminal};:…][\p{Pe}\p{Pf}"']*$/u.test(token.raw) ||
    /^[\p{Pe}\p{Pf}"']*\s*[,;:]/u.test(text.slice(token.index + token.raw.length));
}

/** Timed words after the first `skip` tokens, or none when the timings do not line up with them. */
function wordsAfter(words: VoiceUtterance["words"], tokens: Token[], skip: number): VoiceUtterance["words"] {
  let index = 0;
  for (const [position, word] of words.entries()) {
    const timedText = normalized(word.text);
    if (!timedText) continue;
    if (index === skip) return words.slice(position);
    if (normalized(tokens[index]?.raw ?? "") !== timedText) return [];
    index++;
  }
  return [];
}

/**
 * A recovered address carries one plain clause. After a prefix, the transcript cannot tell a name that is
 * talked about from a name that is addressed once the rest of the sentence branches:
 *
 * - a comma may set off a phrase that describes the name ("So, Steve, who is on call, said the build is
 *   fine.", "Okay, Steve, our build lead, also approved it.");
 * - "and" or "or" may continue a list the name began ("Okay, Steve, my brother and Bob approved it.").
 *
 * Recovery therefore leaves alone every message with a comma, other than before a closing courtesy word
 * ("deploy to staging, please"), or with a coordinating word. A compound command after a prefix, such as
 * "Um, Steve, check the build and run the tests.", is dropped, never sent; without the prefix the opening
 * rule routes it as before.
 */
const COURTESY_CLOSE = /,\s*(?:please|thanks|thank you|okay|ok|now)[\p{P}\s]*$/iu;
const COORDINATOR = /(?:^|[\s\p{P}])(?:and|or|nor|&)(?=$|[\s\p{P}])/iu;

function describesName(message: string): boolean {
  return message.replace(COURTESY_CLOSE, "").includes(",") || COORDINATOR.test(message);
}

function recoverPrefix(utterance: VoiceUtterance, roster: readonly SpokenName[]): Decision | null {
  const { text } = utterance;
  const tokens = tokensIn(text, 0);
  const names = roster.map((target) => ({ target, name: normalized(target.name) }));
  /** The longest exact roster name starting at token `i`. */
  const exactAt = (i: number) => {
    const token = tokens[i];
    if (!token) return null;
    const heard = namesStartingAt(text, token, tokens[i + 1]);
    for (let length = heard.length; length > 0; length--) {
      const targets = names.filter(({ name }) => name === heard[length - 1]).map(({ target }) => target);
      if (targets.length) return { targets, last: tokens[i + length - 1]! };
    }
    return null;
  };
  /**
   * A second exact name right behind the first, optionally joined by "and" or "or", with its own boundary after
   * it. Without one, "Um, Steve and Luna said the build is fine." is two people being talked about.
   */
  const behind = (i: number) => {
    const joined = !!tokens[i] && /^(?:and|or|&)$/u.test(normalized(tokens[i]!.raw));
    const found = exactAt(joined ? i + 1 : i);
    return found && delimitedAfter(text, found.last) ? found : null;
  };
  let suggestion: Decision | null = null;
  for (const skip of [1, 2]) {
    const start = tokens[skip];
    if (!start) break;
    // A roster name among the skipped words is an address the opening rule already judged.
    if (skip === 2 && exactAt(1)) break;
    const said = tokens.slice(0, skip).map(({ raw }) => normalized(raw));
    const known = said.every((word, i) => VOICE_PREFIX_FILLERS.has(word) || VOICE_PREFIX_OPENERS.has(word) ||
      (VOICE_PREFIX_NOISE_WORDS.has(word) && delimitedAfter(text, tokens[i]!)));
    const relayed = said.some((word) => RELAY_WORDS.has(word));
    const prefix = text.slice(0, start.index);
    const rest = { ...utterance, text: text.slice(start.index), words: wordsAfter(utterance.words, tokens, skip) };
    // Unsure cards are not offered to the remainder: a pick needs the name said on its own.
    const decision = routeOpening(rest, { roster });
    if (decision.kind === "control") {
      if (decision.command === "cancel" && known) return { ...decision, prefix };
      continue;
    }
    let candidates: SpokenName[];
    let message: string;
    let command: VoiceAddressedCommand | undefined;
    let pauseMs: number | null = null;
    let exact = false;
    if (decision.kind === "addressed") {
      ({ text: message, command, pauseMs } = decision);
      candidates = [decision.target];
      exact = decision.match === "exact";
    } else if (decision.kind === "needs-model") {
      // An ambiguous name stays a question for the operator here, never for the model.
      candidates = decision.reason === "second-name" ? [decision.target] : decision.candidates;
      ({ text: message, pauseMs } = decision);
      command = decision.reason === "ambiguous-name" ? decision.command : undefined;
      exact = decision.reason === "second-name" && decision.match === "exact";
    } else if (decision.kind === "ignored" && decision.reason === "near-miss" && decision.closest) {
      candidates = roster.filter((target) => target.name === decision.closest && !!target.isReferenceName === !!decision.closestReferenceName);
      const after = messageAfterAddress(text, 0, start.index + start.raw.length);
      message = after.body;
      command = addressedCommand(after.body, after.wrappersClosed);
    } else {
      continue;
    }
    if (!candidates.length || !message) continue;
    // A filler or opener that only sounds like a name ("well" for Will) is the next filler, not an address.
    const spelled = decision.kind !== "ignored" && decision.match === "exact";
    const heardWord = normalized(start.raw);
    if (!spelled && [VOICE_PREFIX_FILLERS, VOICE_PREFIX_OPENERS, VOICE_PREFIX_NOISE_WORDS].some(words => words.has(heardWord))) continue;
    const nameLength = decision.kind === "ignored" ? 1 : normalized(candidates[0]!.name).split(" ").length;
    const last = tokens[skip + nameLength - 1];
    // "Uh Steve's build broke" talks about Steve.
    if (!last || /[’']s[\p{P}]*$/u.test(last.raw)) continue;
    const delimited = delimitedAfter(text, last);
    const second = behind(skip + nameLength);
    if (second) {
      // "Tell Steve and Luna, check the build." relays a message; it is not addressed to either.
      if (relayed) continue;
      // "Um, Steve and Luna, check the build." Offer every name heard; the message follows them.
      const after = messageAfterAddress(text, 0, second.last.index + second.last.raw.length);
      const offered = [...new Set([...candidates, ...second.targets])];
      if (after.body && !describesName(after.body)) suggestion ??= { kind: "suggest", candidates: offered, text: after.body, prefix, pauseMs,
        ...(addressedCommand(after.body, after.wrappersClosed) && { command: "stop" as const }) };
      continue;
    }
    // Checked after a second name: "and Luna, check the build." is the rest of an address, not an aside.
    if (describesName(message)) continue;
    if (known && exact && delimited && (decision.kind === "addressed" || (decision.kind === "needs-model" && decision.reason === "second-name"))) {
      return { ...decision, prefix };
    }
    // With no boundary after the name, "Uh Steve broke it again." reads exactly like "Uh Steve check the
    // build": ordinary speech that mentions an agent is left alone rather than asked about.
    if (!relayed && delimited) {
      suggestion ??= { kind: "suggest", candidates, text: message, prefix, pauseMs, ...(command && { command }) };
    }
  }
  return suggestion;
}
