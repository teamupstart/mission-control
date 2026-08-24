// Which persisted reviews are part of the conversation, decided once for both sides.
//
// Browser-safe pure predicates only: no `node:` import may reach this module.
//
// The rule has two readers that must not drift. The daemon answers
// `/api/sessions/:id/resolved-reviews` from SQLite, which is the durable half - it is what
// a conversation reopened tomorrow, or after a daemon restart, is drawn from. The dashboard
// applies the same test to the reviews arriving live over SSE, which is the immediate half -
// it is what puts your answer in the log the instant you submit it, without a refetch. Two
// spellings of "does this belong in the transcript" would show an entry on submit that
// vanished on reload, or the reverse.

import type {
  PlanDecision,
  PlanDecisionAnswer,
  ReviewItem,
  ReviewKind,
  ReviewStatus,
} from "./types.ts";

/**
 * The terminal statuses a person can put a review into.
 *
 * `orphaned` is absent because the daemon writes it, not a human: it means the session that
 * asked went away before anyone answered. `pending` is absent because it is not terminal -
 * a question still on screen is not yet an answer.
 *
 * `dismissed` IS here. Closing a question without choosing is a decision the agent was told
 * about ("dismissed without a response"), so the conversation owes the reader the same
 * account of it - otherwise the log shows an agent asking, a silence, and a reply to
 * something never said.
 */
export const HUMAN_REVIEW_STATUSES: ReadonlySet<ReviewStatus> = new Set<ReviewStatus>([
  "approved",
  "rejected",
  "answered",
  "dismissed",
]);

/**
 * Does this review belong in the session's conversation as the human's answer?
 *
 * `resolvedBy === "human"` is asserted rather than inferred from the status, because
 * Foreman resolves reviews through the very same route the dashboard does. Its answers are
 * already in the conversation as their own episode card - drawn from the record of what
 * Foreman was asked and what it decided - so admitting them here would put the same moment
 * on screen twice, once as Foreman and once as if you had answered it yourself.
 *
 * A null actor (an `orphaned` settle, or a row written before the column existed) fails
 * this test. That is deliberate: the conversation states who spoke, and it may not put
 * words in the operator's mouth on the strength of a status alone.
 */
export function isHumanResolvedReview(review: ReviewItem): boolean {
  return review.resolvedBy === "human" && HUMAN_REVIEW_STATUSES.has(review.status);
}

/**
 * The semantic result a blocking review tool hands back to its caller.
 *
 * Shared by the MCP fast path and the durable continuation fallback. If these were two
 * spellings, a timeout would change the meaning of the human's answer depending only on
 * which transport happened to deliver it.
 */
export function reviewToolResult(review: ReviewItem): { text: string; isError: boolean } {
  if (review.status === "orphaned") {
    return { text: "Review channel went away before a human answered.", isError: true };
  }
  if (review.status === "dismissed") {
    return {
      text:
        review.kind === "plan-decisions"
          ? "Decision request dismissed without a response."
          : review.kind === "input"
            ? "Input request dismissed without a response."
            : "Review dismissed without a response.",
      isError: false,
    };
  }
  if (review.kind === "diff") {
    const verdict = review.status === "approved" ? "APPROVED" : "CHANGES REQUESTED";
    const note = review.response ? `\nReviewer note: ${review.response}` : "";
    return { text: `${verdict}${note}`, isError: false };
  }
  return {
    text:
      review.response ??
      (review.kind === "plan-decisions" ? "(no selections given)" : "(no answer given)"),
    isError: false,
  };
}

// ---- how a filled-in form reads as text, for both sides ----
//
// These moved out of `web/lib/reviews.ts` when the daemon acquired a second writer of
// answered reviews: an Agent SDK session's native `AskUserQuestion` is answered through
// `/submit-options`, and the record it leaves has to read exactly like the one the browser
// writes through `/api/reviews/:id/resolve`. Two spellings of "what did they pick" would
// put two different sentences in the same column of the same table.

/**
 * The options the human took, in the order the agent listed them.
 *
 * Driven off `decision.options` rather than off `answer.selected`, so the replayed form
 * reads down the page in the order it was asked however the clicks arrived, and an id that
 * no longer names an option (a review answered against a question since rewritten) is
 * dropped instead of rendering as a blank row.
 */
export function selectedOptions(
  decision: PlanDecision,
  answer: PlanDecisionAnswer | undefined,
): PlanDecision["options"] {
  if (!answer) return [];
  return decision.options.filter((o) => answer.selected.includes(o.id));
}

/**
 * The opening line of the response the agent receives when the form is submitted.
 *
 * Not cosmetic: the string is handed back as the tool result verbatim and lands in the
 * transcript. Telling a `request_input` caller that "Plan decisions" were submitted would
 * credit it with a plan it never wrote, and a later reader - Foreman included - would go
 * looking for one.
 */
export function decisionLead(kind: ReviewKind): string {
  return kind === "input" ? "Answered:" : "Plan decisions submitted:";
}

/**
 * Format the selections into the response string the agent receives verbatim as its tool
 * result. Deterministic and human-legible, one block per question with the chosen labels
 * and any free-text note.
 *
 * Derived from `PlanDecisionAnswer[]` - the same array that is persisted - rather than from
 * the form's own state, so the string the agent reads and the record the conversation
 * replays cannot describe different answers.
 *
 * `lead` names what was answered, because this form serves several askers: a
 * `plan-decisions` review resolving several choices about a plan, an `input` review where
 * `request_input` asked one question with options, and the record left behind when a driver
 * session's own `AskUserQuestion` form is answered from the dashboard. Telling the second
 * one "Plan decisions submitted" would hand the agent a plan it never wrote.
 */
export function formatResponse(
  decisions: PlanDecision[],
  answers: PlanDecisionAnswer[],
  lead: string,
): string {
  const byId = new Map(answers.map((a) => [a.decisionId, a]));
  const blocks = decisions.map((d) => {
    const answer = byId.get(d.id);
    const labels = selectedOptions(d, answer).map((o) => o.label);
    const other = answer?.other?.trim() ?? "";
    const lines = [`• ${d.question}`];
    if (labels.length) lines.push(`  → ${labels.join(", ")}`);
    if (d.allowOther && other) lines.push(`  Other: ${other}`);
    if (!labels.length && !(d.allowOther && other)) lines.push("  → (no selection)");
    return lines.join("\n");
  });
  return `${lead}\n\n${blocks.join("\n\n")}`;
}
