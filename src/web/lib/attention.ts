import type { EnsembleSummary, TaskEnsembleLink } from "@shared/ensemble.ts";
import type { ReviewItem, Session } from "@shared/types.ts";
import {
  pipelineHaltRunbookLine,
  pipelineRunKeyOf,
  type PipelineHaltClass,
  type PipelineRun,
} from "@shared/pipeline.ts";
import { activePaneDialog } from "@shared/session.ts";
import { stateDisplay } from "./format.ts";

/**
 * A session on its way out, whose questions can no longer be delivered.
 *
 * The same two states `stateDisplay` returns on ABOVE its `pendingReviews` check, named once
 * so the fold and the pulse cannot drift apart on what "settling" means.
 */
function isSettling(session: Session): boolean {
  return session.state === "exited" || session.state === "stopping";
}

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
      kind: "session_dialog";
      id: string;
      session: Session;
      /** The run clause when the session is an ensemble member, null for an ordinary one. */
      context: string | null;
      /** The question the menu answers, when the parse found one above the rows. */
      prompt: string | null;
    }
  | {
      /**
       * An external engine stopped a pipeline and is waiting for a person.
       *
       * The one item in this fold that is not about a SESSION, and it has to be: a halt is a
       * fact about the run, and the agent that hit it has usually exited by the time anyone
       * looks - the engine stops dispatching, so there is frequently no card on the board at
       * all. Before this the most definitively stuck thing on an operator's machine was the
       * one thing the inbox could not show.
       *
       * Carries the whole `PipelineRun` rather than a copy of the fields drawn here: the row
       * needs the key to link with, phase 4 attaches its verbs to these rows, and a payload
       * that had been narrowed to what today's row prints would have to be widened by each
       * of them - which is how two surfaces come to disagree about which run they are on.
       */
      kind: "pipeline_halt";
      id: string;
      run: PipelineRun;
      /** `run.halt.class`, lifted so the row and phase 6's triage read one field. */
      haltClass: PipelineHaltClass;
      /** The engine's own first line about why it stopped. */
      reason: string;
      /** The provider's runbook that owns clearing this class, as one line. */
      runbook: string;
    }
  | {
      /**
       * A session the fleet paints amber that NOTHING else in this fold accounts for.
       *
       * The backstop that makes `total` a superset of the pulse's `need you`. Two real
       * populations land here. A hook-reported `awaiting_input` is the common one: the only
       * writers of that state are the Claude `Notification` and Codex `PermissionRequest`
       * translators, neither of which files a review, so before this the most definitively
       * blocked sessions on the board were the ones the inbox could not show. The second is
       * the sub-second window where `session_upsert` has landed a raised `pendingReviews` and
       * the `review_upsert` carrying the row itself has not - two SSE frames, two `useState`
       * maps, one render in between.
       *
       * Derived LAST, from what the earlier sections did not claim, so it can never
       * double-count a session that already has a row.
       */
      kind: "session_blocked";
      id: string;
      session: Session;
      context: string | null;
      /** The agent's own word for what it is waiting on ("Needs approval: Bash"). */
      activity: string | null;
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
   *
   * INVARIANT: `total >= ` the pulse's `need you` (sessions in an attention tone). The two
   * segments are different UNITS on purpose - agents blocked vs answers owed - but they must
   * not be different SETS, because a header reading "1 need you / 0 to answer" says a thing is
   * stuck and simultaneously offers an empty inbox to fix it in. `session_blocked` is what
   * closes the gap; `attention-pill-invariant.test.ts` is what keeps it closed.
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
  /**
   * Every pipeline run the daemon is projecting, halted or not.
   *
   * Optional, and that is the fail-open posture the whole feature ships with rather than a
   * convenience for callers: a fleet observing no engine passes nothing, gets the same fold
   * it always got, and the section below contributes no rows and no count. The narrowing to
   * halted runs happens here rather than at the call site for the reason the whole module
   * exists - the fold decides what is owed, and a caller that pre-filtered would be a second
   * opinion on it.
   */
  pipelineRuns?: readonly PipelineRun[];
}

/**
 * The queue, in the order it is drained.
 *
 * Sections are fixed and never interleave, because they are different kinds of obligation and
 * a mixed list would sort a one-click gate above a run that has been parked for an hour:
 *
 *  1. **Ensemble decisions** - a run parked on you; nothing else in the run moves until it is answered.
 *  2. **Session reviews** - answerable inline, right here, which is what makes this an inbox.
 *  3. **Pane dialogs** - a TUI menu, answered on the card (see the inbox's comment).
 *  4. **Pipeline halts** - an external engine stopped a feature and is waiting for a person.
 *  5. **Blocked sessions** - amber on the fleet with no row above; the invariant's backstop.
 *  6. **Parked finalizations** - a stuck destructive step.
 *
 * The five that predate pipelines keep their relative order exactly: the new section was
 * inserted, never interleaved, so a fleet observing no engine renders the identical list.
 *
 * Within a section the oldest wait leads, so draining top-to-bottom answers whoever has been
 * waiting longest. Every order is total (a timestamp then an id) so the list cannot reshuffle
 * between two renders of the same state.
 */
export function foldAttention(input: AttentionInput): AttentionFold {
  const items: AttentionItem[] = [];
  const sessionById = new Map(input.sessions.map((s) => [s.id, s]));
  const summaryByRun = new Map(input.ensembles.map((e) => [e.id, e]));
  /** Sessions that already own a row, so the section (4) backstop cannot double-count them. */
  const represented = new Set<string>();
  const contextFor = (session: Session): string | null => {
    const link = session.task?.ensemble ?? null;
    return link ? ensembleRunContext(link, summaryByRun.get(link.runId) ?? null) : null;
  };

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
  //
  // A settling session's questions are dropped, mirroring `stateDisplay`'s precedence, which
  // returns on `exited`/`stopping` ABOVE its `pendingReviews` check. Without this the fold
  // listed answers nobody could deliver: an exited session carries its reviews for the whole
  // 8s eviction linger (`EXIT_LINGER_MS`) before `orphanReviewsFor` settles them, and a
  // `stopping` session whose driver hangs while draining carries them indefinitely.
  const bySession = new Map<string, ReviewItem[]>();
  for (const review of input.reviews) {
    const session = sessionById.get(review.sessionId);
    if (!session || isSettling(session)) continue;
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
    represented.add(group.session.id);
    items.push({
      kind: "session_reviews",
      id: `reviews:${group.session.id}`,
      session: group.session,
      reviews: group.reviews,
      context: contextFor(group.session),
    });
  }

  // (3) Any session parked on a TUI/driver menu. A deep link, not an answer surface: a pane
  // dialog and a review are two wire protocols, and only the review's is session-agnostic
  // today. NOT deduplicated against section 2 - a session can hold both, and answering one
  // does not clear the other.
  //
  // This used to be `s.task?.ensemble && activePaneDialog(s)`, on the reasoning that an
  // ordinary session parked on a menu "is already amber on the fleet and is not duplicated
  // here" (phase-4 dossier 5.1(c)). That reasoning assumed the two pulse segments were meant
  // to describe different sets. They are meant to describe different UNITS of the same set,
  // and under the narrow filter a lone session sitting on a permission prompt - the most
  // definitively blocked thing the board can show - produced `1 need you` beside an inbox
  // that opened empty.
  const dialogs = input.sessions
    .filter((s) => activePaneDialog(s))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1));
  for (const session of dialogs) {
    represented.add(session.id);
    items.push({
      kind: "session_dialog",
      id: `dialog:${session.id}`,
      session,
      context: contextFor(session),
      prompt: activePaneDialog(session)?.prompt ?? null,
    });
  }

  // (4) Pipelines an external engine stopped for a person.
  //
  // BEFORE the backstop below, deliberately. The backstop's whole job is to claim what
  // nothing else did, so any section derived after it would be a section whose rows had
  // already been drawn as something else - and a halt drawn as "waiting on you" would name
  // the agent rather than the run and offer to focus a card that has usually exited.
  //
  // Oldest wait leads, like every other section: `updatedAt` is when the projection last
  // changed, which for a halted run is when it stopped. Ties break on the run key so the
  // order is total and two renders of one fleet cannot reshuffle.
  for (const run of [...(input.pipelineRuns ?? [])]
    .filter((run) => run.halt !== null)
    .sort(
      (a, b) =>
        a.updatedAt - b.updatedAt || (pipelineRunKeyOf(a) < pipelineRunKeyOf(b) ? -1 : 1),
    )) {
    items.push({
      kind: "pipeline_halt",
      id: `pipeline-halt:${pipelineRunKeyOf(run)}`,
      run,
      haltClass: run.halt!.class,
      reason: run.halt!.reason,
      runbook: pipelineHaltRunbookLine(run.provider, run.halt!.class),
    });
  }

  // (5) The backstop: sessions the fleet paints amber that nothing above accounts for. See
  // the `session_blocked` doc for the two populations this catches. Ordered by name then id
  // like the dialogs, because a lifecycle state carries no "waiting since" to sort on.
  const blocked = input.sessions
    .filter((s) => !represented.has(s.id) && stateDisplay(s).tone === "attention")
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1));
  for (const session of blocked) {
    items.push({
      kind: "session_blocked",
      id: `blocked:${session.id}`,
      session,
      context: contextFor(session),
      activity: session.activity,
    });
  }

  // (6) A finalization that stopped on an error. The run is past its decision and holding a
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
