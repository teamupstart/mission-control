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
 * name's (`tail`), each verbatim from the text. Only a name with words on both sides can split.
 */
export interface VoiceSplitPoint {
  target: SpokenName;
  /** Character offset of this name in the original utterance. */
  at: number;
  /** More than one captured target has the spoken name at this offset. */
  ambiguousTarget?: true;
  commands?: readonly (VoiceAddressedCommand | undefined)[];
  head: string;
  tail: string;
}

/** Drop what joins two commands from the end of the first: separators and a joining word. */
function splitHead(text: string): string {
  let head = text;
  for (;;) {
    const next = head.replace(/[\s,;:–—-]+$/u, "").replace(/\b(?:and then|and|then|also|plus)$/iu, "");
    if (next === head) return head.trim();
    head = next;
  }
}

export type VoiceAddressedCommand = "stop";
export type VoiceRouteDecision = Decision;

type Decision =
  | { kind: "control"; command: "cancel" }
  | { kind: "control"; command: "pick"; cardId: string; candidateId: string }
  | { kind: "addressed"; command?: VoiceAddressedCommand; target: SpokenName; match: "exact" | "phonetic"; text: string; pauseMs: number | null }
  | { kind: "needs-model"; candidates: SpokenName[]; text: string; reason: "ambiguous-name"; match: "exact" | "phonetic"; command?: VoiceAddressedCommand; pauseMs: number | null }
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

function namesStartingAt(text: string, token: RegExpExecArray, next?: RegExpExecArray): [string] | [string, string] {
  const first = normalized(token[0]);
  if (!next || !/^\s+$/u.test(text.slice(token.index + token[0].length, next.index))) return [first];
  return [first, normalized(text.slice(token.index, next.index + next[0].length))];
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

// Unicode paired brackets and typographic quote pairs. An unknown closer stays in the message.
const WRAPPER_PAIRS = new Set(`
  "" '' () [] {} «» ‹› ‘’ “” ‛’ ‟” ‚’ „” 〝〞 〝〟
  ༺༻ ༼༽ ᚛᚜ ⁅⁆ ⁽⁾ ₍₎ ⌈⌉ ⌊⌋ 〈〉 ❨❩ ❪❫ ❬❭ ❮❯ ❰❱ ❲❳ ❴❵
  ⟅⟆ ⟦⟧ ⟨⟩ ⟪⟫ ⟬⟭ ⟮⟯ ⦃⦄ ⦅⦆ ⦇⦈ ⦉⦊ ⦋⦌ ⦍⦐ ⦏⦎ ⦑⦒ ⦓⦔ ⦕⦖ ⦗⦘
  ⧘⧙ ⧚⧛ ⧼⧽ ⸂⸃ ⸄⸅ ⸉⸊ ⸌⸍ ⸜⸝ ⸠⸡ ⸢⸣ ⸤⸥ ⸦⸧ ⸨⸩ ⹕⹖ ⹗⹘ ⹙⹚ ⹛⹜
  〈〉 《》 「」 『』 【】 〔〕 〖〗 〘〙 〚〛 ︗︘ ︵︶ ︷︸ ︹︺ ︻︼ ︽︾ ︿﹀ ﹁﹂ ﹃﹄ ﹇﹈
  ﹙﹚ ﹛﹜ ﹝﹞ （） ［］ ｛｝ ｟｠ ｢｣
`.trim().split(/\s+/u));

// A comma can fall inside a quoted address (“Will,”) or before a quoted message (Will,"go").
function messageAfterAddress(text: string, start: number, end: number): { body: string; wrappersClosed: boolean } {
  const rest = text.slice(end).trimStart();
  const separatorLength = rest.startsWith(",") ? 1 : 0;
  let bodyStart = separatorLength;
  const address = text.slice(start, end).trimStart();
  const prefix = address.match(/^[\p{P}\s]+/u)?.[0] ?? "";
  const trailing = address.match(/\p{P}+$/u)?.[0] ?? "";
  const wrappers = prefix.match(/[\p{Ps}\p{Pi}"']/gu) ?? [];
  for (const mark of trailing.matchAll(/[\p{Pe}\p{Pf}"']/gu)) {
    if (!WRAPPER_PAIRS.has((wrappers.pop() ?? "") + mark[0])) {
      return { body: text.slice(end - trailing.length + mark.index).trimEnd(), wrappersClosed: false };
    }
  }
  while (wrappers.length) {
    const closing = rest.slice(bodyStart).match(/^\s*([\p{Pe}\p{Pf}"'])/u);
    if (!closing || !WRAPPER_PAIRS.has(wrappers.at(-1)! + closing[1])) break;
    wrappers.pop();
    bodyStart += closing[0].length;
  }
  if (bodyStart > separatorLength) {
    // Terminal punctuation attached to a standalone closer also belongs to the quoted name.
    if (!separatorLength) bodyStart += rest.slice(bodyStart).match(/^[\p{Sentence_Terminal}…]+/u)?.[0].length ?? 0;
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
  const tokens = Array.from(text.matchAll(/[^\s,]+/gu)).filter((m) => normalized(m[0]));
  const [firstToken, secondToken] = tokens;
  if (!firstToken) return { kind: "ignored", reason: "no-name" };
  const bodyAfter = (token: RegExpExecArray) => messageAfterAddress(text, 0, token.index + token[0].length);
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
  const command = addressedCommand(body, wrappersClosed);
  if (candidates.length > 1) return { kind: "needs-model", reason: "ambiguous-name", match, candidates, text: body, pauseMs, ...(command && { command }) };
  const target = candidates[0]!;
  // A later roster name may start a message of its own or only be talked about. The first
  // target stays fixed whichever it is: the model is asked split or mention, never who.
  const splitCandidates = new Set([target]);
  const splits: VoiceSplitPoint[] = [];
  for (let i = count; i < tokens.length; i++) {
    const at = tokens[i]!;
    const laterNames = namesStartingAt(text, at, tokens[i + 1]);
    for (let length = laterNames.length; length > 0; length--) {
      const end = tokens[i + length - 1]!;
      const heard = laterNames[length - 1];
      const matches = names.filter(({ name }) => name === heard);
      if (!matches.length) continue;
      const preceding = text.slice(text.length - body.length, at.index);
      const wrappers = preceding.match(/(?:^|\s)([\p{Ps}\p{Pi}"'\s]+)$/u)?.[1] ?? "";
      const addressStart = at.index - wrappers.length;
      const head = splitHead(text.slice(text.length - body.length, addressStart));
      const second = messageAfterAddress(text, addressStart, end.index + end[0].length);
      const tail = second.body.replace(/^[\s;:–—-]+/u, "").trim();
      if (head && tail) {
        const commands = [addressedCommand(head, wrappersClosed), addressedCommand(second.body, second.wrappersClosed)];
        for (const other of matches) {
          splits.push({ target: other.target, at: at.index, head, tail,
            ...(commands.some(Boolean) && { commands }), ...(matches.length > 1 && { ambiguousTarget: true }) });
          splitCandidates.add(other.target);
        }
      }
      i += length - 1;
      break;
    }
  }
  if (splits.length) {
    return { kind: "needs-model", reason: "second-name", candidates: [...splitCandidates], text: body, pauseMs, target, match, splits };
  }
  return { kind: "addressed", target, text: body, match, pauseMs, ...(command && { command }) };
}
