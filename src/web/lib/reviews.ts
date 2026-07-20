import type { PlanDecision, ReviewItem, ReviewKind } from "@shared/types.ts";

// Which control a pending review is answered with, decided in one place.
//
// Split out of `ReviewModal` rather than left inline because `ReviewModal` cannot be
// imported by a test at all: it pulls in react-diff-view, which imports a `.css` file Node
// refuses to load (`overlay-registry.test.ts` documents the same wall). Inline, the rule
// deciding whether an agent's question reaches the human as clickable options or as a
// textarea would be reachable only through a component nothing can render - so it lives
// here, where it can be asserted directly.

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
