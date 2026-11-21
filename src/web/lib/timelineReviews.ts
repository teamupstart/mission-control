import { useEffect, useState } from "react";
import type { ReviewItem } from "@shared/types.ts";
import { isConversationQuestionRecord, isConversationResolvedReview } from "@shared/review-item.ts";
import { ASYNC_INPUT_FLAG } from "@shared/async-input.ts";
import { api, type JsonRead } from "./api.ts";
import { useFeatureFlag } from "../useFeatureFlag.ts";

/**
 * The reviews this session's conversation replays, from both halves of where they live.
 *
 * Two sources rather than one, because neither is sufficient alone:
 *
 * - The FETCH is the durable half. `/api/sessions/:id/resolved-reviews` reads SQLite, so a
 *   conversation opened tomorrow still shows what was decided. It is also the only half
 *   that survives a daemon restart: the registry reloads exactly the PENDING rows at boot
 *   (`loadPendingReviews`), so resolved reviews are simply not in memory afterwards.
 *
 * - The LIVE reviews are the immediate half. They arrive over the SSE stream the dashboard
 *   already holds open, so an answer appears in the log the instant it is submitted rather
 *   than after a refetch that nothing would have triggered.
 *
 * Unioned by id with the live copy winning, because a review present in both is the same
 * row and the live one is never older. The fetch is deliberately NOT re-run when a review
 * resolves: the live half already covers that, and a refetch keyed on the resolution would
 * race the write it is trying to observe.
 *
 * `enabled` gates only the fetch, never the hook. The grid mounts a card per session and
 * renders a transcript for at most one of them, so an ungated fetch would ask the daemon
 * for the review history of every session on screen to draw one conversation. Passing the
 * flag in - rather than calling the hook conditionally - is what keeps the hook order fixed
 * as a card expands and collapses.
 */
export function useTimelineReviews(
  sessionId: string,
  live: ReviewItem[],
  enabled = true,
): TimelineReviews {
  const [stored, setStored] = useState<ReviewItem[]>([]);
  const [lineage, setLineage] = useState<ReviewItem[]>([]);
  // The session whose durable history has come back (or failed to). Until it is this one, a
  // delivered answer whose review is not in hand is still loading, not gone.
  const [settledFor, setSettledFor] = useState<string | null>(null);
  const asyncInput = useFeatureFlag(ASYNC_INPUT_FLAG);

  useEffect(() => {
    let alive = true;
    setStored([]);
    setLineage([]);
    setSettledFor(null);
    if (!enabled) return;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    const load = (): void => {
      void loadReviewHistory(sessionId).then(({ stored: rows, lineage: inherited, complete }) => {
        // Guarded against the session switching mid-flight: without this, a slow response for
        // the session you just left would land in the panel for the one you just opened, and
        // its answers would read as this session's.
        if (!alive) return;
        // Whatever arrived is shown at once, so a failed lineage read never hides this session's
        // own answers. Only a complete read settles the history, though: a transient failure is
        // not evidence that a question is gone, so the cards stay loading and the read is retried,
        // backing off, for a bounded number of attempts before the history is settled anyway.
        setStored(rows);
        setLineage(inherited);
        const wait = complete ? null : historyRetryDelay(attempt++);
        if (wait === null) setSettledFor(sessionId);
        else retry = setTimeout(load, wait);
      });
    };
    load();
    return () => {
      alive = false;
      if (retry) clearTimeout(retry);
    };
  }, [sessionId, enabled]);

  // Computed on every render rather than memoized, deliberately. `live` is rebuilt from the
  // event stream's map on each render (`useEventStream` spreads it), so its identity always
  // differs and a `useMemo` keyed on it would recompute every time anyway - reading as a
  // cache while never being one. The work it would be hiding is a Map build over a handful
  // of reviews, and the merge downstream already walks the rows once per render.
  return {
    reviews: timelineReviewsFor(sessionId, stored, live, asyncInput),
    // A disabled hook reads nothing, so there is nothing to wait for: settled at once.
    loaded: !enabled || settledFor === sessionId,
    lineage,
  };
}

/**
 * Read a session's durable review history and its runtime-transfer predecessors'. It always
 * resolves, and each read lands on its own, so one that fails or rejects never holds the other
 * back. `complete` says both answered. Only a complete read may settle the history: a failed one
 * says nothing about whether a question still exists, so the hook keeps delivered answers
 * loading and retries rather than drawing them as "no longer available".
 */
export async function loadReviewHistory(
  sessionId: string,
  read: {
    own: (id: string) => Promise<JsonRead<ReviewItem[]>>;
    lineage: (id: string) => Promise<JsonRead<ReviewItem[]>>;
  } = { own: api.resolvedReviews, lineage: api.lineageReviews },
): Promise<{ stored: ReviewItem[]; lineage: ReviewItem[]; complete: boolean }> {
  const [own, inherited] = await Promise.allSettled([read.own(sessionId), read.lineage(sessionId)]);
  const outcome = (r: PromiseSettledResult<JsonRead<ReviewItem[]>>): JsonRead<ReviewItem[]> =>
    r.status === "fulfilled" ? r.value : { ok: false, definite: false };
  const mine = outcome(own);
  const theirs = outcome(inherited);
  // A definite answer (a 4xx, such as a session the daemon no longer holds) is final: asking
  // again will not change it, so it completes the read with nothing in it.
  const answered = (r: JsonRead<ReviewItem[]>) => r.ok || r.definite;
  return {
    stored: mine.ok ? mine.value : [],
    lineage: theirs.ok ? theirs.value : [],
    complete: answered(mine) && answered(theirs),
  };
}

/** The first retry's wait; each later one doubles, up to `HISTORY_RETRY_MAX_MS`. */
export const HISTORY_RETRY_MS = 5_000;
const HISTORY_RETRY_MAX_MS = 60_000;
/** Retries before the history is settled with whatever it has. */
const HISTORY_RETRY_LIMIT = 6;

/**
 * How long to wait before retry `attempt` (0-based) of a review-history read that failed
 * transiently, or null once the attempts are spent and the history should settle as it is.
 * Bounded so a read that keeps failing neither polls the daemon for as long as the panel is
 * open nor leaves delivered answers on "Loading the question…" for good.
 */
export function historyRetryDelay(attempt: number): number | null {
  if (attempt >= HISTORY_RETRY_LIMIT) return null;
  return Math.min(HISTORY_RETRY_MS * 2 ** attempt, HISTORY_RETRY_MAX_MS);
}

/**
 * What `useTimelineReviews` hands the conversation. `reviews` are this session's entries.
 * `loaded` says its durable history has settled, so a delivered answer naming a review that is
 * still missing really is gone rather than still loading. `lineage` is the same history for the
 * sessions this conversation was transferred from, used only to draw a delivered answer.
 */
export interface TimelineReviews {
  reviews: ReviewItem[];
  loaded: boolean;
  lineage: ReviewItem[];
}

/**
 * Union the two sources into the answers one session's conversation should show.
 *
 * Split out of the hook as a pure function so the rule can be asserted directly - the hook
 * around it needs a renderer, and this codebase deliberately has none (no jsdom, no Testing
 * Library). The interesting cases here are all about rows that must NOT be shown, which is
 * exactly the kind of thing a render test is worst at proving.
 *
 * BOTH sources are filtered by session, not just the live one. `stored` is emptied in an
 * effect, and an effect runs AFTER the render that first sees the new `sessionId` - so during
 * that one render the hook still holds the previous session's fetched history. Trusting the
 * fetch's own scoping ("these rows came from that session's endpoint, so they belong to it")
 * is true of the request and false of the state, and the gap between them is a frame in which
 * session A's gold answers are drawn into session B's conversation. Filtering here closes it
 * without depending on when React chooses to run the effect.
 *
 * `asyncInput` is the live `async-input` flag. A question that waited inside its call and was
 * closed by a merge is recorded only while the flag is on: with it off, such a question was
 * never in the conversation before this feature, and must not appear there now, even if a merge
 * closed it while the flag was on. A message-mode question is recorded either way. It exists only
 * because the flag was on when it was asked, and turning the flag off leaves it answerable, so
 * its Asked entry stays where the operator can answer it from.
 */
export function timelineReviewsFor(
  sessionId: string,
  stored: ReviewItem[],
  live: ReviewItem[],
  asyncInput = false,
): ReviewItem[] {
  // One test, applied identically to both sources. `isConversationResolvedReview` is the same
  // predicate the daemon's SQL filter mirrors, and it matters most for the LIVE list, which
  // carries every review of every status - including the pending one whose card is still on
  // screen. Admitting that would put an unanswered question in the log as though it had been
  // answered. A question the conversation records for itself (`isConversationQuestionRecord`:
  // a message-mode question, or one a merge closed) is admitted in any status; `mergeConversation`
  // draws it as an Asked or closure entry, and as an answer only when a human gave one.
  const keep = (r: ReviewItem): boolean =>
    r.sessionId === sessionId
    && (isConversationResolvedReview(r)
      || (isConversationQuestionRecord(r) && (asyncInput || r.waitMode === "message")));

  const byId = new Map<string, ReviewItem>();
  // Stored first so the live copy overwrites it, not the other way round: a review in both is
  // the same row, and the live one is never older.
  for (const r of stored) if (keep(r)) byId.set(r.id, r);
  // A live row that no longer qualifies retires its stored copy: the live one is never older, so
  // a filed question an older MCP child turned back into a blocking call (it loses `waitMode` and
  // its meanwhile line) must not keep the Asked entry the stale stored row would still draw.
  for (const r of live) {
    if (keep(r) || isSnoozedHere(r, sessionId)) byId.set(r.id, r);
    else byId.delete(r.id);
  }
  return [...byId.values()];
}

/**
 * A question this session's operator chose "Remind me later" on. It is not an answer, but it
 * is where the answer will go, and the agent carried on because of it, so the conversation
 * shows it as a snoozed card (`SnoozedReviewCard`). Live only: the parked row is always in the
 * registry, and the durable fetch returns settled answers alone.
 */
function isSnoozedHere(review: ReviewItem, sessionId: string): boolean {
  return review.sessionId === sessionId && review.status === "snoozed";
}
