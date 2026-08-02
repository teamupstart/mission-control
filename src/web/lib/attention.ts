import type { EnsembleSummary, TaskEnsembleLink } from "@shared/ensemble.ts";
import type { ReviewItem, Session } from "@shared/types.ts";
import { activePaneDialog } from "@shared/session.ts";

/**
 * Everything that is waiting on the operator, folded into ONE ordered queue.
 *
 * The topbar used to carry a "N reviews" chip that opened the FIRST answerable review's
 * session modal - so a second blocked session, a run parked on your decision, and a stuck
 * finalization were all things you found by noticing them. This
 * is the drain: one list, in a fixed order, that the inbox renders and the chip counts.
 *
 * It is a RENDERING of state the app already holds, never a second alert engine. Nothing
 * here subscribes, notifies, or decides severity - `detectAlerts` / `useNotifier` own the
 * away-notification question and `EnsembleSummary.attention` is the daemon's own derivation.
 * A fold that started deciding what is urgent would be a second opinion on both.
 *
 * Pure, and separated from the component for two reasons: it is the piece worth testing
 * (ordering, counting, the run-context sentence), and the component that renders it imports
 * `ReviewCard`, which reaches `react-diff-view`'s stylesheet and cannot be loaded by this
 * repo's DOM-less test runner.
 */

/** One thing to act on. Ordered by SECTION first (see `foldAttention`), never interleaved. */
export type AttentionItem =
  | {
      kind: "ensemble_decision";
      /** Stable across renders and unique in the fold, so it can key a list. */
      id: string;
      runId: string;
      summary: EnsembleSummary;
    }
  | {
      kind: "session_reviews";
      id: string;
      session: Session;
      /** Every answerable pending review of that session, oldest first. */
      reviews: ReviewItem[];
      /** "Best of N 'Fix the parser' - candidate 3 of 5", or null for an ordinary session. */
      context: string | null;
    }
  | {
      kind: "member_dialog";
      id: string;
      session: Session;
      context: string;
      /** The question the menu answers, when the parse found one above the rows. */
      prompt: string | null;
    }
  | {
      kind: "parked_finalization";
      id: string;
      runId: string;
      summary: EnsembleSummary;
      error: string;
    };

export interface AttentionFold {
  items: AttentionItem[];
  /**
   * How many ANSWERS the operator owes, which is not `items.length`.
   *
   * A session holding three questions is one row and three answers, and the chip has always
   * counted answers (it counted `answerableReviews.length`). Counting rows instead would have
   * made the number drop when a second question arrived on a session already listed.
   */
  total: number;
}

/**
 * The sentence that tells whoever is answering that they are steering one competitor.
 *
 * The gap this closes is specific: a member's question is answered on an ordinary session
 * surface, which says nothing about the run - so the operator nudging candidate 3 could not
 * tell they were tilting a comparison. The run TITLE comes from the summary when the fleet
 * has one; the link alone still knows the strategy and which candidate this is, and a
 * sentence that waited for the summary would be blank in exactly the seconds after a restart.
 *
 * The denominator is `maxMembers`, the roster the operator chose - the same choice
 * `ensembleMemberTooltip` makes, because "candidate 3 of 3" on a five-lane run that has
 * launched three changes meaning while nothing about the member does.
 */
export function ensembleRunContext(
  link: TaskEnsembleLink,
  summary: EnsembleSummary | null,
): string {
  const title = summary?.title ? ` "${summary.title}"` : "";
  return `${link.strategyLabel}${title} - candidate ${link.ordinal} of ${link.maxMembers}`;
}

export interface AttentionInput {
  sessions: readonly Session[];
  /**
   * Pending reviews NARROWED to live sessions (App's `answerableReviews`).
   *
   * Deliberately the narrow list: a row is a thing you can act on, and a review whose agent
   * is gone has nothing to answer. Passing the whole pending list would put rows in the inbox
   * that resolve into a void.
   */
  reviews: readonly ReviewItem[];
  ensembles: readonly EnsembleSummary[];
}

/**
 * The queue, in the order it is drained.
 *
 * Sections are fixed and never interleave, because they are different kinds of obligation and
 * a mixed list would sort a one-click gate above a run that has been parked for an hour:
 *
 *  1. **Ensemble decisions** - a run parked on you; nothing else in the run moves until it is answered.
 *  2. **Session reviews** - answerable inline, right here, which is what makes this an inbox.
 *  3. **Blocked member dialogs** - a TUI menu, answered on the card (see the inbox's comment).
 *  4. **Parked finalizations** - a stuck destructive step.
 *
 * Within a section the oldest wait leads, so draining top-to-bottom answers whoever has been
 * waiting longest. Every order is total (a timestamp then an id) so the list cannot reshuffle
 * between two renders of the same state.
 */
export function foldAttention(input: AttentionInput): AttentionFold {
  const items: AttentionItem[] = [];
  const sessionById = new Map(input.sessions.map((s) => [s.id, s]));
  const summaryByRun = new Map(input.ensembles.map((e) => [e.id, e]));

  // (1) Runs parked on a human decision.
  for (const summary of [...input.ensembles]
    .filter((e) => e.status === "awaiting_decision")
    .sort((a, b) => a.updatedAt - b.updatedAt || (a.id < b.id ? -1 : 1))) {
    items.push({
      kind: "ensemble_decision",
      id: `ensemble-decision:${summary.id}`,
      runId: summary.id,
      summary,
    });
  }

  // (2) Answerable reviews, grouped by the session that raised them. Grouped rather than
  // listed flat because the header (agent, name, run context) belongs to the session, and a
  // session with three questions is one thing to sit down with, not three.
  const bySession = new Map<string, ReviewItem[]>();
  for (const review of input.reviews) {
    if (!sessionById.has(review.sessionId)) continue;
    const group = bySession.get(review.sessionId);
    if (group) group.push(review);
    else bySession.set(review.sessionId, [review]);
  }
  const groups = [...bySession.entries()].map(([sessionId, reviews]) => ({
    session: sessionById.get(sessionId)!,
    reviews: [...reviews].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1)),
  }));
  groups.sort(
    (a, b) =>
      (a.reviews[0]?.createdAt ?? 0) - (b.reviews[0]?.createdAt ?? 0) ||
      (a.session.id < b.session.id ? -1 : 1),
  );
  for (const group of groups) {
    const link = group.session.task?.ensemble ?? null;
    items.push({
      kind: "session_reviews",
      id: `reviews:${group.session.id}`,
      session: group.session,
      reviews: group.reviews,
      context: link ? ensembleRunContext(link, summaryByRun.get(link.runId) ?? null) : null,
    });
  }

  // (3) Ensemble members parked on a TUI/driver menu. A deep link, not an answer surface:
  // a pane dialog and a review are two wire protocols, and only the review's is
  // session-agnostic today. Listed at all because a member holding one is invisible from the
  // run, and NOT deduplicated against section 2 - a session can hold both, and answering one
  // does not clear the other.
  const dialogs = input.sessions
    .filter((s) => s.task?.ensemble && activePaneDialog(s))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1));
  for (const session of dialogs) {
    const link = session.task!.ensemble!;
    items.push({
      kind: "member_dialog",
      id: `dialog:${session.id}`,
      session,
      context: ensembleRunContext(link, summaryByRun.get(link.runId) ?? null),
      prompt: activePaneDialog(session)?.prompt ?? null,
    });
  }

  // (4a) A finalization that stopped on an error. The run is past its decision and holding a
  // half-finished destructive step, which is a retry only a person can ask for.
  for (const summary of [...input.ensembles]
    .filter((e) => e.status === "finalizing" && e.error)
    .sort((a, b) => a.updatedAt - b.updatedAt || (a.id < b.id ? -1 : 1))) {
    items.push({
      kind: "parked_finalization",
      id: `finalization:${summary.id}`,
      runId: summary.id,
      summary,
      error: summary.error!,
    });
  }

  const total = items.reduce(
    (sum, item) => sum + (item.kind === "session_reviews" ? item.reviews.length : 1),
    0,
  );
  return { items, total };
}
