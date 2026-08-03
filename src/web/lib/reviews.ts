import type { PlanDecision, PlanDecisionAnswer, ReviewItem } from "@shared/types.ts";

// Which control a pending review is answered with, decided in one place.
//
// Split out of `ReviewModal` rather than left inline because `ReviewModal` cannot be
// imported by a test at all: it pulls in react-diff-view, which imports a `.css` file Node
// refuses to load (`overlay-registry.test.ts` documents the same wall). Inline, the rule
// deciding whether an agent's question reaches the human as clickable options or as a
// textarea would be reachable only through a component nothing can render - so it lives
// here, where it can be asserted directly.
//
// What is NOT here: `formatResponse`, `selectedOptions` and `decisionLead`, which moved to
// `@shared/review-item.ts` when the daemon acquired a second writer of answered reviews.
// Answering an Agent SDK session's own `AskUserQuestion` records one server-side, and it has
// to read exactly like the one this form writes - so the formatter is shared rather than
// spelled twice.

/**
 * The questions to draw as a form, or null to fall through to the kind's default control.
 *
 * `plan-decisions` has always meant "a plan plus choices". `input` means it now too, when
 * the agent supplied options: that is `request_input` standing in for Claude's built-in
 * `AskUserQuestion`, which dispatched sessions no longer have (`server/ask-channel.ts`). An
 * `input` without options is the genuinely open-ended ask and keeps its free-text box.
 *
 * `plan` and `diff` are excluded outright. They are approved or sent back, so there is no
 * control to hang decisions on, and a payload carrying them is ignored rather than drawn.
 */
export function reviewDecisions(review: ReviewItem): PlanDecision[] | null {
  if (review.kind !== "plan-decisions" && review.kind !== "input") return null;
  return review.decisions?.length ? review.decisions : null;
}

/**
 * Should the review's body be drawn under its header?
 *
 * Only `input` is ever in doubt. `request_input` sends a CLIPPED question as the title and
 * the whole question as the body (`titleLine`, `src/mcp/server.ts`), so the two are equal
 * exactly when the question was short enough to survive the clip - and there, drawing both
 * printed the same sentence twice, once as the `<h3>` and again as a paragraph beneath it.
 *
 * The test is `body !== title` rather than the kind, deliberately. Suppressing `input` bodies
 * outright would flatten a long or multi-line free-text question into a bold heading with its
 * newlines collapsed, which is the case this rule most has to protect: past the clip the two
 * genuinely differ, and the body renders as the readable, `pre-wrap` paragraph it should be.
 * Whenever a body carries something the header does not already say, it is shown.
 *
 * `plan` and `diff` bodies ARE the content, and always render.
 */
export function showsBody(review: ReviewItem): boolean {
  return review.kind !== "input" || review.body !== review.title;
}

// ---- answering a decision form, and replaying it afterwards ----

/**
 * A decision is answered once it has a selected option, or free text when the decision
 * allows it. Submit stays disabled until every decision clears this bar, and an empty
 * decision set is "nothing to submit" rather than vacuously complete, so the agent never
 * unblocks on a half-filled or content-free form.
 */
export function isAnswered(decision: PlanDecision, answer: PlanDecisionAnswer | undefined): boolean {
  if (!answer) return false;
  if (answer.selected.length > 0) return true;
  return Boolean(decision.allowOther && answer.other?.trim());
}

/**
 * Pair a resolved review's questions with what was picked, for the conversation to replay.
 *
 * Empty unless BOTH halves survived: the questions are needed to show what was passed over,
 * and the selections to show what was taken. Either one alone is a form that cannot be drawn
 * honestly, and the caller falls back to the response prose - which is why this reports the
 * absence rather than filling in a default.
 */
export function answeredDecisions(
  review: ReviewItem,
): Array<{ decision: PlanDecision; answer: PlanDecisionAnswer | undefined }> {
  const decisions = reviewDecisions(review);
  if (!decisions || !review.selections?.length) return [];
  const byId = new Map(review.selections.map((a) => [a.decisionId, a]));
  return decisions.map((decision) => ({ decision, answer: byId.get(decision.id) }));
}

/**
 * How the conversation bylines a resolution: the verb, in the human's voice.
 *
 * Status and not kind, because that is what the agent was told. A `diff` sent back for
 * another pass and one waved through are the same review and opposite answers, and a log
 * that called both "you reviewed" would leave the reader unable to tell which.
 */
export function reviewAnswerVerb(review: ReviewItem): string {
  switch (review.status) {
    case "approved":
      return "you approved";
    case "rejected":
      return "you requested changes";
    case "dismissed":
      return "you dismissed";
    default:
      return "you answered";
  }
}
