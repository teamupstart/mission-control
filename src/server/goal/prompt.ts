import { z } from "zod";
import { GOAL_MAX_CHARS, goalLine } from "@shared/goal.ts";
import type { Session, TranscriptMessage } from "@shared/types.ts";
import type { TranscriptWindow } from "../transcript.ts";

// The Tier 2 prompt: rewrite a session's raw ask into the one sentence a card shows.
//
// The narrowest thing any model does in this codebase, and priced accordingly (Haiku, a
// ~12-turn window). It is not asked to judge, solve, or decide anything - only to say what
// the session is trying to solve, which is the one question a human scanning twenty cards is
// actually asking.

/**
 * What the model must return.
 *
 * `goal` is CLAMPED, not rejected, for the reason `queue-verify.ts` gives at length: a model
 * that judged the session correctly but wrote two sentences should not have its answer
 * thrown away, retried against the identical prompt, and then discarded - leaving the card
 * on the raw prompt over a verbose reply. `goalLine` is the same shortener Tier 1 uses, so
 * both tiers are bounded identically no matter which wrote last.
 *
 * The emptiness check runs AFTER `goalLine`, not before, and the distinction is the whole
 * contract: a whitespace-only reply passes a pre-transform `min(1)` and shortens to "", which
 * `runStructured` would report as a success and stamp `source: "model"` on. That silently
 * erases the Tier 1 sentence the card already had AND takes the session out of the refiner's
 * queue, so the prompt is never retried. Failing the parse instead leaves the heuristic goal
 * standing - a failure must never be stamped as a judgment.
 */
export const GoalSchema = z.object({
  goal: z.string().transform((s) => goalLine(s)).pipe(z.string().min(1)),
});
export type GoalReply = z.infer<typeof GoalSchema>;

const RULES = `You summarize what an AI coding session is trying to solve, for a one-line status card on a
dashboard. The human reading it is scanning twenty cards at once and wants to know, at a glance, what
each session is FOR.

Respond with ONLY a single JSON object - no prose, no markdown fences - of this shape:
{
  "goal": string   // ONE sentence, under ${GOAL_MAX_CHARS} characters
}

RULES:
- Say what the session is trying to SOLVE, not what it is doing this second. "Fix the flaky worktree
  cleanup on Reset" is a goal; "running the test suite" is not - the card already shows that separately.
- Lead with the outcome, in plain language. No markdown, no quotes around it, no trailing period needed.
- Base it on what the HUMAN asked for. The agent's own commentary is evidence of the goal, never the
  goal itself.
- If the session has moved on to something else, describe what it moved to - this is a live status, not
  a record of how the session opened.
- If the current goal below still describes the work, repeat it back unchanged. Most follow-up
  instructions refine a goal rather than replace it, and a card that rewords itself every minute reads
  as churn.
- Never invent detail that isn't there. If all you have is a slash command, say what that command does
  for this repo and no more.`;

export interface GoalInput {
  session: Session;
  /** The sentence currently on the card, so "unchanged" is a cheap answer. */
  currentGoal: string | null;
  /** The human's most recent substantive ask, already filtered and clamped. */
  prompt: string | null;
  /** Recent conversation, or null when there is no readable transcript. */
  window: TranscriptWindow | null;
}

/** Per-message cap. Far tighter than the reviewer's: intent shows in a turn's opening. */
const MSG_CAP = 400;

/**
 * Render a window for the summariser.
 *
 * Deliberately NOT `foreman/prompt.ts`'s `formatTranscript`: that one includes each turn's
 * tool calls, because a reviewer must know what the agent DID. Here they are pure noise -
 * `Bash(npm test)` says nothing about what the session is for - and they are the bulk of the
 * tokens in a coding transcript. Dropping them makes the call both cheaper and more accurate.
 */
function formatForGoal(messages: TranscriptMessage[]): string {
  const lines = messages
    .filter((m) => m.text.trim())
    .map((m) => {
      const text = m.text.length > MSG_CAP ? `${m.text.slice(0, MSG_CAP)}…` : m.text;
      return `[${m.role}] ${text.replace(/\s+/g, " ").trim()}`;
    });
  return lines.length ? lines.join("\n\n") : "(no readable conversation)";
}

/** Assemble the Tier 2 prompt for one session. */
export function buildGoalPrompt(input: GoalInput): string {
  const { session, currentGoal, prompt, window } = input;
  const parts = [
    RULES,
    "",
    "## The session",
    `name: ${session.name}`,
    `repo: ${session.cwd ?? "(unknown)"}`,
    `branch: ${session.gitBranch ?? "(none)"}`,
    "",
    "## Current goal on the card",
    currentGoal || "(none yet)",
    "",
    "## The human's most recent instruction",
    prompt || "(none captured - infer the goal from the conversation below)",
  ];
  if (window) {
    parts.push(
      "",
      window.truncated
        ? "## Conversation (oldest first; the middle was elided for length)"
        : "## Conversation (oldest first)",
      formatForGoal(window.messages),
    );
  }
  parts.push(
    "",
    "Now output the goal as a single raw JSON object and NOTHING else - no prose, no markdown",
    "fences. Begin your reply with { and end it with }.",
  );
  return parts.join("\n");
}
