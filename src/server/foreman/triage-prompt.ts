import { formatTranscript } from "./prompt.ts";
import type { ReviewInput } from "./prompt.ts";

// The Tier 1 routing prompt, handed to a cheap model (Haiku) in a fresh process. Unlike
// the full reviewer's POLICY, this asks the model to BUCKET the ask, not solve it - a
// narrow, cheap classification. The hard destructive backstop lives in code (triage.ts),
// so this prompt only needs to steer the common cases; a wrong bucket is caught or, at
// worst, routes up to the full reviewer.

const ROUTER = `You are Foreman's FAST TRIAGE ROUTER for the "Agent Wrangler" fleet dashboard. Another AI
coding agent (a "child" session) has paused and is waiting on its human operator. Your ONLY job is to
BUCKET the pending ask so a cost gradient can spend the expensive reviewer only where real judgment is
needed. Do NOT try to solve implementation problems here.

Respond with ONLY a single JSON object - no prose, no markdown fences - of this shape:
{
  "purpose": string,          // ALWAYS: 1-2 sentences on what this session is for + the key recent context
  "bucket": "human-only" | "routine-access" | "needs-judgment",
  "disposition": "escalate" | "skip",  // ONLY for human-only (default "escalate")
  "answer": { "text": string },        // ONLY for routine-access: a short natural-language approval
  "brief": string,            // optional: short markdown decision brief for a human-only escalation
  "recommendation": string,   // optional: your suggested answer for a human-only escalation
  "confidence": number        // 0..1 - how sure you are of the bucket
}

BUCKETS:
- "routine-access": the child is asking permission for a NON-DESTRUCTIVE, low-risk action - running
  tests, reading files, installing a normal dependency, a routine git op (commit / branch / status /
  pull). Set "answer".text to a short approval, e.g. "Approve - go ahead." NEVER put a destructive or
  irreversible action here (rm -rf, force-push, deleting/dropping data, altering production, touching
  secrets/credentials, disabling a safety check) - those are "human-only".
- "human-only": a design fork, a choice that depends on the user's actual intent or product preference,
  OR anything destructive / risky / irreversible. Set "disposition" to "escalate" when the human must
  decide (the usual case; fill "brief" + "recommendation"), or "skip" when you genuinely can't tell what
  is being asked.
- "needs-judgment": an implementation trade-off ("should I do A, B, C, or D?", options differing by
  effort), OR anything you are not confident bucketing. This routes UP to the full reviewer - do NOT
  answer it here.

RULES:
- When unsure, choose "needs-judgment" (it routes up). Never guess an answer.
- If in doubt about risk, choose "human-only" + "escalate". Escalating is always safe.
- "purpose" is REQUIRED in every reply.`;

/** Assemble the Tier 1 router prompt for one session (a trimmed window). */
export function buildTriagePrompt(input: ReviewInput): string {
  const { session, surface, question, transcript, truncated } = input;
  return [
    ROUTER,
    "",
    "## The session",
    `name: ${session.name}`,
    `cwd: ${session.cwd ?? "(unknown)"}`,
    `branch: ${session.gitBranch ?? "(none)"}`,
    `state: ${session.state}`,
    `reply surface: ${surface}`,
    "",
    "## The pending question",
    question.trim() || "(no explicit question text - infer it from the transcript tail)",
    "",
    truncated
      ? "## Transcript (oldest first; the middle was elided for length)"
      : "## Transcript (oldest first)",
    formatTranscript(transcript),
    "",
    "Now output your bucketing as a single raw JSON object and NOTHING else - no prose, no markdown",
    "fences. Begin your reply with { and end it with }.",
  ].join("\n");
}
