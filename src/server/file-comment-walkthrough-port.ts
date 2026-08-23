// The walkthrough, wired to the real daemon.
//
// Separate from `file-comment-walkthrough.ts` so that file keeps its claim: the state machine
// imports no store function, opens no database and touches no pane, which is what lets
// `test/file-comment-walkthrough.test.ts` drive every advance, hold, pause and restart path
// against a fake port instead of a fixture per case. This file is the only place the two meet.

import {
  beginFileCommentDelivery,
  loadFileCommentReview,
  loadFileCommentThreadsForSession,
  loadFileCommentThreadWithFullHistory,
  markFileCommentMessageDelivered,
  queueFileCommentThread,
  returnFileCommentDeliveryToQueue,
  setFileCommentReviewState,
  setFileCommentThreadStatus,
  updateFileCommentThreadAnchor,
} from "./db.ts";
import type { FileCommentThread } from "@shared/types.ts";
import { FileCommentWalkthrough, type FileCommentWalkthroughPort } from "./file-comment-walkthrough.ts";
import type { PendingTurnManager } from "./pending-turns.ts";
import type { Registry } from "./registry.ts";
import { readSessionFile } from "./session-files.ts";

/**
 * Build the walkthrough and subscribe it to the three facts it runs on.
 *
 * Every durable write goes through phase 1's declared writers and every one of them is paired
 * with the live frame here, in the one place, so no caller can move a thread without a browser
 * hearing about it. That pairing is the same contract `FileCommentManager.publish` states.
 */
export function createFileCommentWalkthrough(
  registry: Registry,
  pendingTurns: PendingTurnManager,
): FileCommentWalkthrough {
  const publish = (thread: FileCommentThread | null): FileCommentThread | null => {
    if (!thread) return null;
    // The orphan backstop `FileCommentManager.publish` keeps, for its reason: a settled thread
    // must never be upserted back into the live collection, even by a writer added later.
    if (thread.status === "orphaned") registry.removeFileCommentThread(thread.id);
    else registry.upsertFileCommentThread(thread);
    return thread;
  };

  const port: FileCommentWalkthroughPort = {
    now: () => Date.now(),
    session: (sessionId) => registry.getSession(sessionId) ?? null,
    review: (sessionId) => loadFileCommentReview(sessionId),
    setReviewState: (sessionId, state, pauseReason) => {
      const review = setFileCommentReviewState(sessionId, state, pauseReason, Date.now());
      registry.upsertFileCommentReview(review);
      return review;
    },
    // Read DURABLY rather than from the registry's projection, for the reason
    // `FileCommentManager.writable` states: the held copy is whatever was last published, and
    // the writers that move a thread are precisely the ones this has to see.
    //
    // `orphaned` is dropped because those threads have left the review; everything else stays,
    // including `answered` and `unanswered`, because `progressOf` counts them to work out
    // which comment of how many this is.
    threads: (sessionId) =>
      loadFileCommentThreadsForSession(sessionId)
        .filter((thread) => thread.status !== "orphaned")
        .sort(
          (a, b) =>
            (a.queueSeq ?? Number.MAX_SAFE_INTEGER) - (b.queueSeq ?? Number.MAX_SAFE_INTEGER) ||
            a.createdAt - b.createdAt,
        ),
    // The uncapped read, taken for ONE thread at the two moments the delivery ordinal is
    // decided rather than for every thread on every tick. The ordinal counts a message's
    // position among ALL of a thread's human messages, and the ordinary hydration carries only
    // the newest fifty - so a thread past that cap would otherwise print an ordinal the agent
    // could quote back and nothing could resolve.
    threadWithHistory: (threadId) => loadFileCommentThreadWithFullHistory(threadId),
    readFile: async (sessionId, path) => {
      const session = registry.getSession(sessionId);
      if (!session?.cwd) throw new Error("this session has no checkout to read");
      const document = await readSessionFile(session.cwd, path);
      return { text: document.text, revision: document.revision };
    },
    updateAnchor: (threadId, patch) => publish(updateFileCommentThreadAnchor(threadId, patch, Date.now())),
    beginDelivery: (threadId, deliveryId) =>
      publish(beginFileCommentDelivery(threadId, deliveryId, Date.now())),
    markDelivered: (messageId) => publish(markFileCommentMessageDelivered(messageId, Date.now())),
    markUnanswered: (threadId) => publish(setFileCommentThreadStatus(threadId, "unanswered", Date.now())),
    returnToQueue: (threadId) => publish(returnFileCommentDeliveryToQueue(threadId, Date.now())),
    requeueAtTail: (threadId) => publish(queueFileCommentThread(threadId, Date.now())),
    submit: (sessionId, text) => {
      const result = pendingTurns.submit(sessionId, text);
      return {
        ok: result.ok,
        turnId: result.pendingTurn?.id ?? null,
        error: result.error ?? null,
      };
    },
    pendingTurn: (sessionId, turnId) =>
      registry.getSession(sessionId)?.pendingTurns.find((turn) => turn.id === turnId) ?? null,
  };

  const walkthrough = new FileCommentWalkthrough(port);

  // 1. The confirmed-delivery signal. The ONE fact that stamps `delivered_at`.
  registry.onTurnDelivered((e) => walkthrough.onTurnDelivered(e.sessionId, e.turnId));
  // 2. Everything time-based. There is no settled-idle event in this daemon - every consumer
  //    subscribes to `session_upsert` and applies `settledIdle` with its own window, which is
  //    what the walkthrough's own timer does. This only makes it react promptly to a session
  //    that just went idle rather than waiting out the next tick.
  registry.subscribe((e) => {
    if (e.type === "session_upsert") walkthrough.onSessionChanged(e.session.id);
    else if (e.type === "session_remove") walkthrough.onSessionGone(e.id);
  });

  return walkthrough;
}
