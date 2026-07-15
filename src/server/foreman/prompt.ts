import type { TranscriptMessage } from "@shared/types.ts";
import { sanitizeGapText } from "./queue-machine.ts";

// Builds the review prompt handed to a fresh `claude -p` per session. This text
// IS Foreman's judgment contract - the policy from docs/plans/foreman/plan.md,
// encoded verbatim - plus the session's transcript and the pending question.

export interface ReviewInput {
  session: {
    name: string;
    cwd: string | null;
    gitBranch: string | null;
    state: string;
    activity: string | null;
  };
  /** How Foreman's answer will be delivered, so it phrases the reply right. */
  surface: "input-review" | "terminal";
  /** The pending question (review body, or the terminal prompt + last turn). */
  question: string;
  transcript: TranscriptMessage[];
  truncated: boolean;
  /**
   * The work-queue item Foreman itself commissioned, when the blocked session is
   * working on one. Without it triage is blind to the queue and the two subsystems
   * fight: the reviewer can answer "no, don't do that" to a question about the very
   * item Foreman asked for, or escalate something it could have answered trivially
   * had it known the intent.
   */
  queueItem?: { intent: string; round: number; openGaps: string[] };
}

/** Per-message text cap so a long turn can't blow up the prompt. */
const MSG_CAP = 1800;

const POLICY = `You are Foreman, an autonomous triage agent for the "Agent Wrangler" fleet
dashboard. Another AI coding agent (a "child" session) has paused and is waiting on its human
operator. Your job: understand the child's goal from its transcript, then either answer the
pending question ON THE HUMAN'S BEHALF, or hand it back to the human.

Respond with ONLY a single JSON object - no prose, no markdown fences - of this shape:
{
  "purpose": string,            // ALWAYS: 1-2 sentences on what this session is for + the most
                                //   relevant recent context for the upcoming decision (shown on the card)
  "classification": "implementation" | "access" | "design-fork" | "intent-unclear" | "other",
  "action": "answer" | "escalate" | "skip",
  "answer": { "text": string }, // required when action="answer": the exact reply to send the child
  "recommendation": string,     // your suggested answer (for escalate, and drafts)
  "brief": string,              // for escalate: short markdown decision brief (question + options + tradeoffs)
  "confidence": number          // 0..1
}

WHEN TO ANSWER (action="answer"):
- Implementation trade-offs ("should I do A, B, C, or D?", options that differ by effort): pick the
  MOST correct, MOST secure, technically robust option that is NOT duplicative. HOWEVER, if the only
  way to satisfy several of the options is a duplicative implementation per case, do NOT pick one -
  instead answer by asking for a SINGLE unified abstraction / one API, with the per-case details
  handled on the backend. Give a one-line rationale.
- Access / approval requests: approve when the action is non-destructive AND not an obvious, serious
  security risk (e.g. running tests, reading files, installing a normal dependency, a routine git op).

WHEN TO ESCALATE (action="escalate"):
- A design fork where only one path is truly viable, or where the right call depends on the user's
  actual intent or product preferences.
- Anything destructive or risky - NEVER auto-approve these: rm -rf, force-push, deleting or dropping
  data, altering production, accessing secrets/credentials, network exfiltration, disabling a safety
  check, or any irreversible operation.
- Whenever you are unsure of the user's intent. Do NOT make major assumptions - prompt the user.
Fill "brief" (the framed decision) and "recommendation" (what you'd suggest) so the human can decide fast.

WHEN TO SKIP (action="skip"):
- The pending item is a plan/diff review or a gate rather than an answerable question, or you genuinely
  can't tell what is being asked. Still fill in "purpose".

PHRASING answer.text: write the exact message to send to the child agent - concise and directive, with a
one-line rationale. For a permission/menu prompt, reply in natural language ("Approve - go ahead." or
"Use option D: build the shared abstraction because ...").`;

/** Assemble the full review prompt for one session. */
export function buildReviewPrompt(input: ReviewInput): string {
  const { session, surface, question, transcript, truncated, queueItem } = input;
  const head = [
    POLICY,
    "",
    "## The session",
    `name: ${session.name}`,
    `cwd: ${session.cwd ?? "(unknown)"}`,
    `branch: ${session.gitBranch ?? "(none)"}`,
    `state: ${session.state}`,
    `activity: ${session.activity ?? "(none)"}`,
    `reply surface: ${surface} (this is how your answer will be delivered to the child)`,
    "",
    ...(queueItem ? queueItemSection(queueItem) : []),
    "## The pending question",
    question.trim() || "(no explicit question text - infer it from the transcript tail)",
    "",
    truncated
      ? "## Transcript (oldest first; the middle was elided for length)"
      : "## Transcript (oldest first)",
    formatTranscript(transcript),
    "",
    // Repeated LAST (recency) and made concrete, because the highest-value cases -
    // a risky ask you must escalate - are exactly where the model is tempted to
    // editorialize in prose. A parse miss is safe (it falls back to a no-op skip),
    // but we want the framed brief, so demand the raw object here.
    "Now output your verdict as a single raw JSON object and NOTHING else - no prose,",
    "no markdown fences, no commentary. Begin your reply with { and end it with }.",
  ];
  return head.join("\n");
}

/**
 * Tell the reviewer what Foreman itself asked this session to do, so it answers
 * *for* the commissioned work rather than second-guessing it.
 */
function queueItemSection(item: NonNullable<ReviewInput["queueItem"]>): string[] {
  const lines = [
    "## Foreman commissioned this work (IMPORTANT)",
    "This session is not freelancing: it is working on an item YOU (Foreman) delivered from the",
    "human's work queue. The human already asked for this, so do not re-litigate whether it should",
    "happen - answer the question in a way that helps the agent finish it.",
    "",
    `The item: ${item.intent.trim()}`,
  ];
  if (item.round > 0) {
    lines.push(`This is fix round ${item.round} - the agent was already sent feedback on it.`);
  }
  if (item.openGaps.length > 0) {
    lines.push("Still outstanding on this item:");
    // Through `sanitizeGapText`, exactly as the fix-prompt path renders the same
    // field. This text is model-produced, from a verdict the schema only
    // LENGTH-clamps - so newlines and control characters survive it - and it is
    // emitted ABOVE "## The pending question", the heading the reviewer answers. Left
    // raw, a multi-line detail can close this block and counterfeit that heading, and
    // in live mode the answer to the forged question is typed into a tool-enabled
    // child. Flattening to one line is what confines it to the line it was given.
    for (const g of item.openGaps) lines.push(`- ${sanitizeGapText(g)}`);
  }
  lines.push("");
  return lines;
}

/**
 * Render a transcript window as `[role] (tools: …) text`, per-message capped. Shared with triage.
 *
 * A tool renders as `Name(input)` - the input already capped at parse time (TOOL_INPUT_CAP).
 * Carrying it is what makes the terminal surface legible at all: the pending question there
 * is the generic "Claude needs your permission", so an `AskUserQuestion(...)` rendering its
 * question and options is the ONLY place the reviewer can read what it is being asked to
 * decide. A name-only chip left it judging blind, and the policy correctly escalated rather
 * than guess - which read as Foreman being unhelpful when it was being honest.
 */
export function formatTranscript(messages: TranscriptMessage[]): string {
  if (messages.length === 0) return "(transcript unavailable)";
  return messages
    .map((m) => {
      const calls = m.tools.map((t) => (t.input ? `${t.name}(${t.input})` : t.name));
      const tools = calls.length ? ` (tools: ${calls.join(", ")})` : "";
      const text = m.text.length > MSG_CAP ? `${m.text.slice(0, MSG_CAP)}…` : m.text;
      return `[${m.role}]${tools} ${text}`.trim();
    })
    .join("\n\n");
}
