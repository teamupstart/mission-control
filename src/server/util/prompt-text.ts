/**
 * Bounding a captured prompt for storage. Harness-neutral by construction: it is
 * character arithmetic on a string, and WHICH characters of a turn are the human's own
 * words is the harness's question (`harness/claude/scaffolding.ts` answers it for Claude).
 *
 * Out here rather than beside that answer for the same reason `file-tail.ts` is out here:
 * the next harness needs this one unchanged, and a generic helper living inside a
 * vendor's module is a helper that gets copied instead of imported.
 */

/**
 * Cap on a stored prompt. Sized to hold a whole real ask: the clean first prompts measured
 * on this machine run to a 371-char median and a 5,515-char p90, so this keeps every
 * ordinary one intact and only bites on a pasted log or file dump.
 */
const PROMPT_CAP = 4000;
/** How much of an over-cap prompt is kept from the end. See `clampPrompt`. */
const PROMPT_TAIL = 1000;

/**
 * Bound a prompt for storage, keeping the head AND the tail when it's over the cap.
 *
 * Head-only truncation is the obvious choice and the wrong one: "here is the failing log:
 * <8KB> - work out why it breaks" puts the entire ask in the last line, and a head-only
 * clamp would store 4KB of log and no question. Keeping both ends means the clamp can only
 * ever elide the middle of a paste, which is the part least likely to carry the goal.
 *
 * Mirrors the transcript window's head+tail split for the same reason, at a smaller scale.
 */
export function clampPrompt(text: string, cap = PROMPT_CAP): string {
  if (text.length <= cap) return text;
  const tail = Math.min(PROMPT_TAIL, Math.floor(cap / 2));
  return `${text.slice(0, cap - tail)} […] ${text.slice(-tail)}`;
}
