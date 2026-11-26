import { z } from "zod";

/**
 * The spoken separator: one standalone word that ends an Always-on utterance and starts the next
 * without a pause. “Steve, check the build, bagel, Carol, report status” is two messages.
 *
 * The daemon applies it to final transcripts of automatic capture only. Live partials, dictation
 * into a focused field and push-to-talk holds keep the word as ordinary text.
 */
export const VOICE_SEPARATOR_DEFAULT = "bagel";
export const VOICE_SEPARATOR_MAX_CHARS = 32;

/** Words the router already gives a meaning to. A separator with one of these would erase it. */
export const VOICE_SEPARATOR_RESERVED = ["cancel", "stop", "reply", "submit"] as const;

const WORD = /^[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*$/u;
export const VOICE_SEPARATOR_FORMAT_MESSAGE = "Use one word of letters, numbers, apostrophes or hyphens.";

export function normalizeSeparatorWord(word: string): string {
  return word.normalize("NFC").toLocaleLowerCase("en-US").replaceAll("’", "'");
}

/** Why `word` cannot be the separator, or null when it can. */
export function separatorWordProblem(word: string): string | null {
  const trimmed = word.trim();
  if (!trimmed || trimmed.length > VOICE_SEPARATOR_MAX_CHARS || !WORD.test(trimmed)) {
    return trimmed.length > VOICE_SEPARATOR_MAX_CHARS
      ? `Use at most ${VOICE_SEPARATOR_MAX_CHARS} characters.` : VOICE_SEPARATOR_FORMAT_MESSAGE;
  }
  const normalized = normalizeSeparatorWord(trimmed);
  if (VOICE_SEPARATOR_RESERVED.some(reserved => reserved === normalized)) {
    return `“${trimmed}” is already a voice command. Choose another word.`;
  }
  return null;
}

export const SeparatorWordSchema = z.string().trim().superRefine((word, ctx) => {
  const problem = separatorWordProblem(word);
  if (problem) ctx.addIssue({ code: "custom", message: problem });
});

/** Sentence and clause marks a recognizer may attach to the spoken word. Quotes keep it literal. */
const BOUNDARY = /^[.,;:!?…]*(.*?)[.,;:!?…]*$/su;

function isSeparatorToken(token: string, separator: string): boolean {
  const bare = BOUNDARY.exec(token)?.[1] ?? token;
  return bare.length > 0 && normalizeSeparatorWord(bare) === separator;
}

export interface SeparatorTiming { text: string; startMs: number; endMs: number }

export interface SeparatedPart<W extends SeparatorTiming = SeparatorTiming> {
  text: string;
  /** The timings of this part's words, or empty when the timings did not align with the text. */
  words: W[];
  /** Where this part's first word starts in the capture, or null when unknown. */
  offsetMs: number | null;
}

/**
 * Joining punctuation left at a cut: “build, bagel” leaves “build,”. A part keeps its closing
 * sentence mark but cannot open with punctuation.
 */
function tidy(text: string): string {
  return text.trim().replace(/^[\s,;:.…]+/u, "").replace(/\s*[,;:]+$/u, "").trim();
}

function letters(text: string): string {
  return text.normalize("NFC").toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]/gu, "");
}

function spoken(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

/**
 * Split a final transcript at each standalone occurrence of `separator`.
 *
 * Returns null when the word does not occur, so the caller routes the capture unchanged. Otherwise
 * returns the non-empty parts in spoken order: separators at either end or next to each other
 * leave nothing to route, so a capture of only the word returns an empty list.
 *
 * “bagels”, “bagel’s” and a quoted “"bagel"” are not the separator. Word timings are split at
 * the same occurrences, and a part keeps its group only when the group spells the part's words;
 * otherwise that part gets no timings, which the router already treats as unmeasured.
 *
 * With `leadingAddress`, the word is also a call sign: as the capture's first word it addresses
 * that agent, and everywhere else it still separates.
 */
export function splitAtSeparator<W extends SeparatorTiming>(
  text: string, words: readonly W[], separator: string, options: { leadingAddress?: boolean } = {},
): SeparatedPart<W>[] | null {
  const target = normalizeSeparatorWord(separator.trim());
  if (!target) return null;
  const texts: string[] = [];
  let from = 0;
  let first = true;
  for (const match of text.matchAll(/\S+/gu)) {
    const opening = first;
    first = false;
    if (!isSeparatorToken(match[0], target) || (opening && options.leadingAddress)) continue;
    texts.push(text.slice(from, match.index));
    from = match.index + match[0].length;
  }
  if (!texts.length) return null;
  texts.push(text.slice(from));

  const timed: W[][] = [[]];
  for (const [index, word] of words.entries()) {
    if (isSeparatorToken(word.text.trim(), target) && !(index === 0 && options.leadingAddress)) timed.push([]);
    else timed.at(-1)!.push(word);
  }
  // A timing group belongs to its text only when it spells the same words, so a decoder that
  // dropped or added a word cannot date a message from the wrong one.
  const aligned = timed.length === texts.length;
  const parts: SeparatedPart<W>[] = [];
  texts.forEach((raw, index) => {
    const part = tidy(raw);
    if (!spoken(part)) return;
    const group = aligned ? timed[index]! : [];
    const partWords = letters(group.map(word => word.text).join("")) === letters(raw) ? group : [];
    parts.push({ text: part, words: partWords, offsetMs: partWords[0]?.startMs ?? null });
  });
  return parts;
}
