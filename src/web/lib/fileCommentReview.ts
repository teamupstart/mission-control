// A session's review queue, as every surface that shows comments drives it.
//
// The Files tab and the Diff tab are two doors into one review: the same queue, the same run
// state, the same daemon routes. This hook is what both hold, so neither keeps its own copy of
// what is out with the agent or what Pause and Resume do. Where the reader is taken to look at
// a queued comment stays with each surface, because only it knows what it has on screen.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { FileCommentReview, FileCommentThread } from "@shared/types.ts";
import { isParkedReview } from "@shared/file-comments.ts";
import {
  controlFileCommentReview,
  deleteFileComment,
  editFileCommentMessage,
  reorderFileComments,
} from "./api.ts";
import { outstandingThread, reviewQueue } from "./fileComments.ts";

export interface FileCommentReviewState {
  /** In delivery order, `sending` and `awaiting` included at the head where they belong. */
  queue: FileCommentThread[];
  review: FileCommentReview | null;
  /** The comment out with the agent right now, or null between two turns. */
  outstanding: FileCommentThread | null;
  showQueue: boolean;
  onToggleQueue: () => void;
  busy: boolean;
  error: string | null;
  setError: (error: string | null) => void;
  control: (action: "start" | "pause" | "dismiss") => Promise<void>;
  move: (threadId: string, direction: -1 | 1) => Promise<void>;
  edit: (messageId: string, body: string) => Promise<boolean>;
  /** Drop a comment from the review. Answers whether the daemon removed it. */
  drop: (threadId: string) => Promise<boolean>;
}

export function useFileCommentReview(
  sessionId: string,
  threads: readonly FileCommentThread[],
  reviews: readonly FileCommentReview[],
): FileCommentReviewState {
  const [showQueue, setShowQueue] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const queue = useMemo(() => reviewQueue(threads, sessionId), [threads, sessionId]);
  const review = useMemo(
    () => reviews.find((r) => r.sessionId === sessionId) ?? null,
    [reviews, sessionId],
  );
  const outstanding = useMemo(() => outstandingThread(queue), [queue]);

  /*
   * The queue opens itself when a pause needs a person, and never closes itself again.
   *
   * NOT when delivery starts. Sending a comment starts it, so opening then would pop the panel
   * over the file on every comment, while the reader is already writing the next one - the
   * toolbar's marker says a comment is out instead. A pause that needs a person is the moment
   * the panel's reason and Resume matter, so that is when it opens. A pause the reader chose
   * themselves opens nothing: they pressed Pause in this panel, so it is already open.
   *
   * Closing on the pause clearing would be the wrong half of the pair, for the old reason:
   * taking the panel away as it resolves hides what just happened.
   */
  const pauseNeedsPerson = review?.state === "paused" && review.pauseReason !== null && !isParkedReview(review);
  useEffect(() => {
    if (pauseNeedsPerson) setShowQueue(true);
  }, [pauseNeedsPerson]);

  const control = useCallback(async (action: "start" | "pause" | "dismiss"): Promise<void> => {
    setBusy(true);
    const result = await controlFileCommentReview(sessionId, action);
    setBusy(false);
    setError(result.ok ? null : result.error);
  }, [sessionId]);

  /**
   * Move one comment one place, by rewriting the whole order.
   *
   * The reorder route takes a list rather than a delta on purpose - it rewrites `queue_seq`
   * in two passes so nothing reads a half-applied order - so a one-place move is expressed as
   * the list it produces. The swap happens here, against the order currently on screen, which
   * is the order the reader is looking at.
   */
  const move = useCallback(async (threadId: string, direction: -1 | 1): Promise<void> => {
    const order = queue.map((thread) => thread.id);
    const at = order.indexOf(threadId);
    const to = at + direction;
    if (at < 0 || to < 0 || to >= order.length) return;
    [order[at], order[to]] = [order[to]!, order[at]!];
    setBusy(true);
    const result = await reorderFileComments(sessionId, order);
    setBusy(false);
    setError(result.ok ? null : result.error);
  }, [queue, sessionId]);

  const edit = useCallback(async (messageId: string, body: string): Promise<boolean> => {
    setBusy(true);
    const result = await editFileCommentMessage(messageId, body);
    setBusy(false);
    setError(result.ok ? null : result.error);
    return result.ok;
  }, []);

  const drop = useCallback(async (threadId: string): Promise<boolean> => {
    setBusy(true);
    const result = await deleteFileComment(threadId);
    setBusy(false);
    setError(result.ok ? null : result.error);
    return result.ok;
  }, []);

  const onToggleQueue = useCallback(() => setShowQueue((value) => !value), []);

  return {
    queue,
    review,
    outstanding,
    showQueue,
    onToggleQueue,
    busy,
    error,
    setError,
    control,
    move,
    edit,
    drop,
  };
}
