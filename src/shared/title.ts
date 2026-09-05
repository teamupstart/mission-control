import { goalLine } from "./goal.ts";

/**
 * Longest title a task card carries.
 *
 * The same 60 the heuristic `deriveTitle` has always capped at, named here so the model
 * tier and the fallback tier are bounded by one number rather than two that can drift.
 */
export const TITLE_MAX_CHARS = 60;
/** Longest title detail projected to the browser, matching accepted task-title inputs. */
export const TITLE_DETAIL_MAX_CHARS = 200;

// Small words a title leaves lowercase unless they lead it, so an auto-derived title reads
// the way a person would write one rather than Shouting Every Word.
const TITLE_MINOR_WORDS = new Set([
  "a", "an", "and", "as", "at", "but", "by", "for", "in", "nor", "of", "on", "or", "per",
  "the", "to", "vs", "via", "with",
]);

/**
 * Leading words a generated title never keeps.
 *
 * A card names the work, not the request for it: "Herdr Multiplexer", never "Implement Herdr
 * Multiplexer" and never "We should implement the Herdr multiplexer". Both are the same
 * sentence with the same subject, and the framing is the part that is identical on every card
 * in the column - so it is the part that costs the operator the scan and buys nothing. It is
 * also spent budget: of the 60 characters a card carries, "We should implement" takes nineteen
 * before the name starts, and the git branch cut from the title inherits the same waste.
 *
 * Two groups, one pass: the request framing an operator types when dictating ("we should",
 * "can you", "please"), and the bare verb "implement", which names no outcome that the object
 * after it does not already name. Deliberately NOT here: `Fix`, `Add`, `Remove`, `Migrate`,
 * `Document` - the prompt asks for those, because each says something about the work that its
 * object cannot.
 */
const TITLE_PREAMBLE_PHRASES = [
  "please",
  "kindly",
  "(?:can|could|would|will)\\s+(?:you|we|i)(?:\\s+please)?",
  "(?:i|we|you)\\s+(?:should|shall|must|ought\\s+to|could)",
  "(?:i|we)\\s+(?:want|need)(?:\\s+to)?",
  "(?:i|we)(?:'d|\\s+would)\\s+like\\s+(?:you\\s+)?to",
  "let'?s",
  // `implement` and `implementing`, but deliberately NOT `implements`: that one is a Java
  // keyword before it is a verb, and "implements Cloneable in the adapter" is a first line a
  // task really has, where the words after it do not name the work on their own.
  "implement(?:ing)?",
];
/**
 * The separators a removed phrase can leave stranded at the front - "Implement: the parser",
 * "We should - rename it". The two long dashes are written as escapes rather than literally,
 * because this repository's prose does not carry a dash a reader cannot type.
 */
const TITLE_PREAMBLE_TAIL = "[\\s,:;.\\u2013\\u2014-]*";
const TITLE_PREAMBLE = new RegExp(
  `^(?:${TITLE_PREAMBLE_PHRASES.join("|")})\\b${TITLE_PREAMBLE_TAIL}`,
  "i",
);

/**
 * Drop the request framing from the front of a generated title.
 *
 * Applied to BOTH title tiers - the model's reply and the first-line heuristic behind it - from
 * this one definition, because a convention enforced on one tier and not the other is a
 * convention the operator sees broken every time a provider is slow.
 *
 * Runs until nothing more matches, so a stacked preamble ("We should implement X") loses all of
 * it rather than one layer. Never returns empty: a title that is nothing BUT preamble
 * ("implement") is the only name the task has, and a blank card is worse than a vague one -
 * `Task.title` is `NOT NULL` for that reason.
 */
export function stripTitlePreamble(text: string): string {
  const original = text.trim();
  let out = original;
  for (;;) {
    const next = out.replace(TITLE_PREAMBLE, "").trim();
    // An empty `next` is the all-preamble case: keep the last thing that was still a name.
    if (!next || next === out) break;
    out = next;
  }
  // Re-capitalise only when something was actually removed, so an untouched title keeps the
  // casing the model or the operator chose and a stripped one still reads like a heading.
  return out === original ? out : out.charAt(0).toUpperCase() + out.slice(1);
}

/** The complete first-line title behind the bounded title stored on an untitled task. */
export function deriveFullTitle(intent: string): string {
  const first = intent.split("\n").map((part) => part.trim()).find(Boolean) ?? "task";
  const line = stripTitlePreamble(first);
  const title = line
    .split(/\s+/)
    .map((word, index) => {
      if (!word || /[A-Z]/.test(word)) return word;
      if (index > 0 && TITLE_MINOR_WORDS.has(word.toLowerCase())) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
  return title.length > TITLE_DETAIL_MAX_CHARS
    ? title.slice(0, TITLE_DETAIL_MAX_CHARS - 1) + "…"
    : title;
}

/** A bounded fallback title for an untitled task. */
export function deriveTitle(intent: string): string {
  const title = deriveFullTitle(intent);
  return title.length > TITLE_MAX_CHARS
    ? title.slice(0, TITLE_MAX_CHARS - 1) + "…"
    : title;
}

/**
 * Recover the complete title only when the stored title is the deterministic shortened
 * fallback. Explicit and model-written titles stay authoritative exactly as persisted.
 */
export function fullTaskTitle(title: string, intent: string): string {
  return title.endsWith("…") && title === deriveTitle(intent) ? deriveFullTitle(intent) : title;
}

/**
 * Shorten text to a single displayable title line.
 *
 * Delegates to `goalLine` rather than re-implementing it: "collapse whitespace, cut at a
 * word boundary, mark the cut with an ellipsis" is not goal-specific, and a second copy of
 * that logic at a different bound is how two lines that should look identical stop doing so.
 * Only the bound differs - a title is a heading, a goal is a sentence.
 */
export function titleLine(text: string): string {
  return goalLine(text, TITLE_MAX_CHARS);
}
