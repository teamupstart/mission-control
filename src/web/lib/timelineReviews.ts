import { useEffect, useState } from "react";
import type { ReviewItem } from "@shared/types.ts";
import { isHumanResolvedReview } from "@shared/review-item.ts";
import { api } from "./api.ts";

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
): ReviewItem[] {
  const [stored, setStored] = useState<ReviewItem[]>([]);

  useEffect(() => {
    let alive = true;
    setStored([]);
    if (!enabled) return;
    void api.resolvedReviews(sessionId).then((rows) => {
      // Guarded against the session switching mid-flight: without this, a slow response for
      // the session you just left would land in the panel for the one you just opened, and
      // its answers would read as this session's.
      if (alive && rows) setStored(rows);
    });
    return () => {
      alive = false;
    };
  }, [sessionId, enabled]);

  // Computed on every render rather than memoized, deliberately. `live` is rebuilt from the
  // event stream's map on each render (`useEventStream` spreads it), so its identity always
  // differs and a `useMemo` keyed on it would recompute every time anyway - reading as a
  // cache while never being one. The work it would be hiding is a Map build over a handful
  // of reviews, and the merge downstream already walks the rows once per render.
  return timelineReviewsFor(sessionId, stored, live);
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
 */
export function timelineReviewsFor(
  sessionId: string,
  stored: ReviewItem[],
  live: ReviewItem[],
): ReviewItem[] {
  // One test, applied identically to both sources. `isHumanResolvedReview` is the same
  // predicate the daemon's SQL filter mirrors, and it matters most for the LIVE list, which
  // carries every review of every status - including the pending one whose card is still on
  // screen. Admitting that would put an unanswered question in the log as though it had been
  // answered.
  const keep = (r: ReviewItem): boolean =>
    r.sessionId === sessionId && isHumanResolvedReview(r);

  const byId = new Map<string, ReviewItem>();
  // Stored first so the live copy overwrites it, not the other way round: a review in both is
  // the same row, and the live one is never older.
  for (const r of stored) if (keep(r)) byId.set(r.id, r);
  for (const r of live) if (keep(r)) byId.set(r.id, r);
  return [...byId.values()];
}
