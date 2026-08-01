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

import type { ReviewItem, ReviewStatus } from "./types.ts";

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
