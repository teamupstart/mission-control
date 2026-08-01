import { z } from "zod";
import { GOAL_MAX_CHARS, goalLine } from "@shared/goal.ts";
import type { Session, TranscriptMessage } from "@shared/types.ts";
import type { TranscriptWindow } from "../harness/types.ts";
import { clampPrompt } from "../util/prompt-text.ts";

// The Tier 2 prompt: reconcile the next unresolved human instruction with the durable session
// objective, then derive the compact card sentence and tactical focus from that one decision.

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
  relationship: z.enum(["initial", "steer", "amend", "replace", "unclear"]),
  objective: z.string().transform((s) => clampPrompt(s)).pipe(z.string().min(1)),
  goal: z.string().transform((s) => goalLine(s)).pipe(z.string().min(1)),
  focus: z.string().transform((s) => goalLine(s)).pipe(z.string().min(1)),
  reason: z.string().transform((s) => goalLine(s, 480)).pipe(z.string().min(1)),
});
export type GoalReply = z.infer<typeof GoalSchema>;

const RULES = `You reconcile the intent of an AI coding session after each new human instruction. Keep
the session's durable OBJECTIVE separate from its current tactical FOCUS. The objective is a completion
contract: another system may push code and open a pull request only after the whole objective is done.

Respond with ONLY a single JSON object - no prose, no markdown fences - of this shape:
{
  "relationship": "initial" | "steer" | "amend" | "replace" | "unclear",
  "objective": string, // the effective durable completion contract, preserving important detail
  "goal": string,      // objective as ONE card sentence, under ${GOAL_MAX_CHARS} characters
  "focus": string,     // latest instruction as ONE short sentence
  "reason": string     // why this relationship was chosen, under 480 characters
}

RULES:
- "initial": this is the first substantive human instruction. Establish the objective from it.
- "steer": the new instruction changes method, priority, sequence, or an intermediate step. Keep the
  objective unchanged. Completing the focus alone does NOT complete the objective.
- "amend": the new instruction materially changes acceptance criteria while preserving the same main
  outcome. Begin objective with the current durable objective exactly, then append the amendment without
  dropping, paraphrasing, or negating existing requirements. Runtime validation rejects an amendment that
  does not retain that explicit prefix.
- "replace": new information causes the human to abandon or supersede the old outcome. Replace the
  objective even when the human used no special command or stock phrase.
- "unclear": there is real ambiguity between steering and changing the objective. Keep the old objective;
  automated completion will pause until later context resolves it.
- Infer relationships semantically from the conversation, not from keywords. "Fix that test first" is
  normally steering; "the API cannot support this, build the import path instead" can be replacement.
- This call targets ONE unresolved instruction. The conversation can contain newer human turns for
  context, but do not skip, merge, or reinterpret the target as only the newest turn. Newer instructions
  receive their own ordered reconciliation after this one.
- Never shrink an objective merely because the newest instruction is narrower.
- Base intent on HUMAN turns. Agent commentary is context, never authority to change the objective.
- Preserve concrete requirements in objective. The goal field is only its compact display form.
- Lead goal and focus with outcomes in plain language. No markdown or trailing period.
- Never invent detail. If the existing objective remains correct, repeat it exactly.`;

export interface GoalInput {
  session: Session;
  /** The detailed completion contract currently in force. */
  currentObjective: string | null;
  /** Whether the target prompt is the first substantive instruction in this session. */
  initial: boolean;
  /** The next unresolved human instruction, already filtered and clamped. */
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
  const { session, currentObjective, initial, prompt, window } = input;
  const parts = [
    RULES,
    "",
    "## The session",
    `name: ${session.name}`,
    `repo: ${session.cwd ?? "(unknown)"}`,
    `branch: ${session.gitBranch ?? "(none)"}`,
    "",
    "## Current durable objective",
    currentObjective || "(none yet)",
    "",
    `## Is this the first substantive instruction? ${initial ? "yes" : "no"}`,
    "",
    "## The specific unresolved instruction to classify now",
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
    "Now output the intent decision as a single raw JSON object and NOTHING else - no prose, no markdown",
    "fences. Begin your reply with { and end it with }.",
  );
  return parts.join("\n");
}
