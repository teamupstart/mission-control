import type { VoiceUtterance } from "../shared/voice-routing.ts";

export interface Recognition {
  text: string;
  tokens: string[];
  timestamps: number[];
  durations: number[];
}

export function tokenWords(result: Recognition): VoiceUtterance["words"] {
  const words: VoiceUtterance["words"] = [];
  let boundary = true;
  for (const [i, token] of result.tokens.entries()) {
    if (/^[ ▁]/u.test(token)) boundary = true;
    const text = token.replace(/^[ ▁]+/u, "");
    if (!text) continue;
    const start = result.timestamps[i], duration = result.durations[i];
    if (start === undefined || duration === undefined || !Number.isFinite(start + duration) || start < 0 || duration < 0) return [];
    const startMs = Math.round(start * 1000), endMs = Math.round((start + duration) * 1000);
    const previous = words.at(-1);
    if (boundary || !previous) words.push({ text, startMs, endMs });
    else {
      previous.text += text;
      previous.endMs = Math.max(previous.endMs, endMs);
    }
    boundary = false;
  }
  return words;
}

/** Encode each complete roster phrase in SentencePiece vocabulary, omitting unrepresentable names. */
export function rosterHotwords(names: string[], vocabulary: Set<string>): string | undefined {
  const phrases: string[] = [];
  for (const name of names) {
    const phrase = "▁" + name.trim().toLowerCase().replace(/\s+/gu, "▁");
    const suffixes = new Map<number, string[]>([[phrase.length, []]]);
    for (let start = phrase.length - 1; start >= 0; start--) {
      for (let end = phrase.length; end > start; end--) {
        const token = phrase.slice(start, end);
        const rest = suffixes.get(end);
        if (rest && vocabulary.has(token)) {
          suffixes.set(start, [token, ...rest]);
          break;
        }
      }
    }
    const tokens = suffixes.get(0);
    if (tokens) phrases.push(tokens.join(" "));
  }
  return phrases.join("/") || undefined;
}
