import type { AgentType } from "./types.ts";

/**
 * Why an agent's sessions can never carry a Goal, or null when they can.
 *
 * Shared because two layers need the same answer and must not drift: the card renders it as
 * the empty state, and the daemon's refiner uses it to skip sessions it could never
 * summarise. An entry and its harness's `transcript.messages` capability are one fact in two
 * files - `harness-transcript.test.ts` fails until they agree.
 *
 * Both shipped harnesses now read messages, so both are null. Codex's entry was a sentence
 * for as long as its rollout parsed only model / effort / token metadata; it reads turns
 * now (`server/harness/codex/transcript.ts`) and reports the prompt itself over a hook, so
 * there is nothing left for that sentence to be true about.
 */
export const GOAL_UNSUPPORTED: Record<AgentType, string | null> = {
  claude: null,
  codex: null,
  // pi's transcript reads back as turns (`harness/pi/transcript.ts`), so its
  // `transcript.messages` capability is non-null and the refiner has a conversation to
  // summarise - null, paired with that capability by `harness-transcript.test.ts`.
  pi: null,
};

/**
 * Longest goal a card will show.
 *
 * Tier 1 shows the human's prompt verbatim, and prompts run long (p50 371 chars, p90 5,515),
 * so without a bound one card could push every other card off the screen. Sized to hold a
 * real one-sentence goal - the refiner is told to stay under it - while cutting a pasted
 * paragraph down to a line or two.
 */
export const GOAL_MAX_CHARS = 180;

/**
 * Shorten text to a single displayable goal line.
 *
 * Cuts at a word boundary when there is one in the last quarter, so a truncated goal ends on
 * a word rather than mid-syllable. Whitespace is collapsed because a pasted prompt arrives
 * with newlines and bullets that would otherwise render as one run-on line anyway.
 */
export function goalLine(text: string, max = GOAL_MAX_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.75 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
