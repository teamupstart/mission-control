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

/** The complete first-line title behind the bounded title stored on an untitled task. */
export function deriveFullTitle(intent: string): string {
  const line = intent.split("\n").map((part) => part.trim()).find(Boolean) ?? "task";
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
