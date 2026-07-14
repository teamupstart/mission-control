import type { TranscriptMessage, TrackedGap } from "@shared/types.ts";
import type { StandardsDoc } from "../standards.ts";

// The verify prompt: "did the agent actually finish THIS item, to this repo's
// bar?". Evidence-only by decision - it judges the diff + transcript and never
// runs anything; no-mistakes stays the gate that actually executes tests.

/** Per-message text cap so a long turn can't blow up the prompt. */
const MSG_CAP = 1800;
/** Cap on the diff we embed - the stats stay honest past it. */
const DIFF_CAP = 120_000;

export interface VerifyInput {
  session: { name: string; cwd: string | null; gitBranch: string | null };
  /** What the human asked for - the axis that actually decides completion. */
  intent: string;
  round: number;
  /** Unified diff for this item (scoped by the base sha recorded at delivery). */
  diff: string;
  diffTruncated: boolean;
  /** True when the diff may contain earlier items' uncommitted work. */
  diffMayIncludeOtherWork: boolean;
  /** Transcript turns since the item was delivered (byte-anchored). */
  transcript: TranscriptMessage[];
  transcriptTruncated: boolean;
  standards: StandardsDoc[];
  standardsTruncated: boolean;
  /** Gaps from the previous round, with their live strike counts. */
  priorGaps: TrackedGap[];
}

const POLICY = `You are Foreman, verifying one unit of work an AI coding agent just finished for its
human operator. You are reading EVIDENCE ONLY - a diff and a transcript. You cannot run anything, and
you must not pretend to have. A separate pipeline ("no-mistakes") actually runs the tests and lint;
your job is narrower and more important: was the thing the human asked for ACTUALLY DONE?

Respond with ONLY a single JSON object - no prose, no markdown fences - of this shape:
{
  "complete": boolean,          // was the requested intent satisfied?
  "summary": string,            // 1-2 sentences: what was done, and what (if anything) is missing
  "gaps": [                     // AT MOST 3, most severe first. Empty when complete.
    {
      "id": string,             // stable slug for this problem, e.g. "retry-untested"
      "severity": "blocking" | "advisory",
      "kind": "incomplete" | "untested" | "standards" | "regression",
      "path": string,           // the repo-relative file the gap is about
      "detail": string,         // what is missing, concretely
      "fix": string             // what to do about it (<= 600 chars)
    }
  ],
  "resolved": string[],         // ids from "previously reported gaps" that are now FIXED
  "confidence": number          // 0..1
}

THE PRIMARY AXIS IS INTENT-SATISFACTION. Ask: if the human read this diff, would they say "yes, that
is what I asked for, and it is finished"? Everything else is secondary.

SEVERITY - this is the most consequential field you set, so read it carefully:
- "blocking" means the work is genuinely NOT DONE and the agent must go back: the intent isn't
  satisfied, a new code path has no test at all, or the change breaks something that worked.
- "advisory" means "worth noting, but the human's request WAS satisfied": style, naming, a
  convention nit, a nice-to-have, a preference.
Only "blocking" gaps send the agent back to work. Every blocking gap you raise costs the human real
time, so raise one ONLY when you would genuinely refuse to merge this. When in doubt: advisory.

CONVENTIONS ARE SECONDARY AND EGREGIOUS-ONLY. The repo's standards docs are included below, but you
are NOT running a style review. A convention finding is "advisory" unless it is a flagrant violation
of an explicit, load-bearing rule. Do not go hunting for nits: if you report a fresh style gap every
round, the agent will fix one and introduce another forever, and the human's actual request - already
satisfied - will never be marked done.

REUSE GAP IDS. If a problem you are reporting is the SAME underlying problem as one in "previously
reported gaps", reuse that id EVEN IF YOUR WORDING DIFFERS. The strike count attached to each id is
how we know when to stop asking, so a fresh id for an old problem hides that the agent is stuck.

Put any gap that is now fixed in "resolved" so it stops being tracked.`;

/** Assemble the verify prompt for one work item. */
export function buildVerifyPrompt(input: VerifyInput): string {
  const lines = [
    POLICY,
    "",
    "## The session",
    `name: ${input.session.name}`,
    `cwd: ${input.session.cwd ?? "(unknown)"}`,
    `branch: ${input.session.gitBranch ?? "(none)"}`,
    "",
    "## What the human asked for (THE thing to judge)",
    input.intent.trim(),
    "",
  ];

  if (input.round > 0) {
    lines.push(
      `## This is fix round ${input.round}`,
      "The agent has already been sent feedback on this item at least once. Judge the CURRENT state.",
      "",
    );
  }

  if (input.priorGaps.length > 0) {
    lines.push("## Previously reported gaps (reuse these ids for the same problems)");
    for (const g of input.priorGaps) {
      lines.push(
        `- id: ${g.id} (asked ${g.strikes}x already) [${g.severity}/${g.kind}] ${g.path}`,
        `  ${g.detail}`,
      );
    }
    lines.push("");
  }

  lines.push(
    input.diffTruncated
      ? "## The diff for this item (TRUNCATED for length)"
      : "## The diff for this item",
  );
  if (input.diffMayIncludeOtherWork) {
    // The diff is cumulative whenever the agent doesn't commit, so it can carry an
    // earlier item's work. Saying so is what stops the verifier reporting someone
    // else's unfinished business as this item's gap.
    lines.push(
      "NOTE: this diff may also contain uncommitted work from EARLIER items in this session's queue.",
      "Judge ONLY whether the intent above is satisfied. Ignore unrelated changes - they are not this",
      "item's business, and reporting them as gaps would send the agent back for work it already did.",
    );
  }
  lines.push("", input.diff.trim() ? capped(input.diff, DIFF_CAP) : "(no changes were made)", "");

  lines.push(
    input.transcriptTruncated
      ? "## What the agent did (transcript since this item was delivered; truncated for length)"
      : "## What the agent did (transcript since this item was delivered)",
    formatTranscript(input.transcript),
    "",
  );

  if (input.standards.length > 0) {
    lines.push("## This repo's standards (SECONDARY - advisory unless flagrant)");
    if (input.standardsTruncated) lines.push("(some standards docs were omitted for length)");
    for (const d of input.standards) {
      lines.push(`### ${d.path}${d.truncated ? " (truncated)" : ""}`, d.text.trim(), "");
    }
  }

  lines.push(
    // Repeated LAST (recency) and made concrete, because the highest-value case -
    // an item that is genuinely done - is exactly where the model is tempted to
    // editorialize about style instead of saying so.
    "Now output your verdict as a single raw JSON object and NOTHING else - no prose,",
    "no markdown fences, no commentary. Begin your reply with { and end it with }.",
  );
  return lines.join("\n");
}

function capped(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n… (truncated)` : s;
}

function formatTranscript(messages: TranscriptMessage[]): string {
  if (messages.length === 0) return "(no transcript turns for this item)";
  return messages
    .map((m) => {
      const tools = m.tools.length ? ` (tools: ${m.tools.join(", ")})` : "";
      const text = m.text.length > MSG_CAP ? `${m.text.slice(0, MSG_CAP)}…` : m.text;
      return `[${m.role}]${tools} ${text}`.trim();
    })
    .join("\n\n");
}
