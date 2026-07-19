import { goalLine } from "./goal.ts";

/**
 * Longest title a task card carries.
 *
 * The same 60 the heuristic `deriveTitle` has always capped at, named here so the model
 * tier and the fallback tier are bounded by one number rather than two that can drift.
 */
export const TITLE_MAX_CHARS = 60;

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
