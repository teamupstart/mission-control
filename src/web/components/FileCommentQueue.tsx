// The review queue: what is going to the agent, in what order, and what you can still change.
//
// Presentational for `FileCommentThread.tsx`'s reason - every write is a callback the
// workspace owns - and it is the surface the whole one-at-a-time design exists to provide. A
// batch would not need it: the queue stays editable WHILE it drains, so reorder, rewrite and
// drop have to be reachable between two turns rather than only before the first.
//
// It spans every file in the session, unlike the thread panel beside it, because a review is
// a pass over a working tree. Each row therefore names its own path.
//
// Reorder is up/down buttons rather than a drag. The backlog's drag is right there and was
// the obvious thing to copy, but a drag is unreachable from a keyboard, and this list is read
// by someone stepping through a review whose whole point is that it does not need a mouse.

import { useEffect, useState } from "react";
import type { FileCommentReview, FileCommentThread } from "@shared/types.ts";
import {
  isEditableInQueue,
  outstandingThread,
  queueRowText,
  reviewAnnouncement,
  threadStateLabel,
  unsentMessage,
} from "../lib/fileComments.ts";
import { Tooltip } from "./Tooltip.tsx";

function lineRange(startLine: number, endLine: number): string {
  return startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`;
}

export function FileCommentQueue({
  queue,
  review,
  busy,
  error,
  onStart,
  onPause,
  onMove,
  onEdit,
  onDrop,
  onOpen,
  onDismissPause,
  onDismissError,
}: {
  /** In delivery order, `sending` and `awaiting` included at the head where they belong. */
  queue: readonly FileCommentThread[];
  review: FileCommentReview | null;
  busy: boolean;
  error: string | null;
  onStart: () => void;
  onPause: () => void;
  /** Move one comment by one position. The workspace turns that into the reorder call. */
  onMove: (threadId: string, direction: -1 | 1) => void;
  /** Rewrite the message this comment will send. Answers whether it landed. */
  onEdit: (messageId: string, body: string) => Promise<boolean>;
  onDrop: (threadId: string) => void;
  /** Take the reader to this comment in the file it is about. */
  onOpen: (thread: FileCommentThread) => void;
  onDismissPause: () => void;
  onDismissError: () => void;
}): React.JSX.Element {
  const [editing, setEditing] = useState<{ messageId: string; body: string } | null>(null);
  const running = review?.state === "running";
  const out = outstandingThread(queue);
  const waiting = queue.filter((thread) => thread.status === "queued").length;

  // A comment that goes out while it is being rewritten stops being editable under the
  // reader's hands. Closing the box is the honest answer: the daemon refuses the edit from
  // here on, so leaving it open would offer a control that can only fail.
  useEffect(() => {
    if (!editing) return;
    const owner = queue.find((thread) =>
      thread.messages.some((message) => message.id === editing.messageId));
    if (!owner || !isEditableInQueue(owner)) setEditing(null);
  }, [editing, queue]);

  return (
    <section className="file-review" aria-label="Review queue">
      <header className="file-review-head">
        <h3 className="file-review-title">Review</h3>
        <span className="file-review-depth">
          {queue.length === 0
            ? "Nothing queued"
            : `${waiting} of ${queue.length} waiting`}
        </span>
        <span className="file-toolbar-spacer" />
        {running
          ? (
            <Tooltip label="Stop after the comment currently out with the agent. Nothing already sent is recalled.">
              <button className="btn" aria-label="Pause review" disabled={busy} onClick={onPause}>
                Pause
              </button>
            </Tooltip>
          )
          : (
            <Tooltip
              label={queue.length === 0
                ? "Submit a comment first: there is nothing in this review to send"
                : review?.state === "paused"
                ? "Send the next comment and carry on from where this review stopped"
                : "Send the first comment as its own turn, then the next when the agent has finished with it"}
            >
              <button
                className="btn btn-primary"
                aria-label={review?.state === "paused" ? "Resume review" : "Start review"}
                disabled={busy || queue.length === 0}
                onClick={onStart}
              >
                {review?.state === "paused" ? "Resume" : "Start review"}
              </button>
            </Tooltip>
          )}
      </header>

      {/*
        The walkthrough narrated, for a reader who cannot see the head move.
        `aria-live="polite"` rather than assertive: a comment going out is worth knowing and
        is never worth cutting off what somebody is already reading.
      */}
      <p className="file-review-status" role="status" aria-live="polite">
        {reviewAnnouncement(review, queue)}
      </p>

      {review?.state === "paused" && review.pauseReason && (
        <p className="file-review-paused" role="alert">
          <span>{review.pauseReason}</span>
          <Tooltip label="Hide this warning without resuming the review or dropping the comment">
            <button
              className="btn"
              aria-label="Dismiss review warning"
              disabled={busy}
              onClick={onDismissPause}
            >
              Dismiss
            </button>
          </Tooltip>
        </p>
      )}
      {error && (
        <p className="file-review-error" role="alert">
          {error}
          <Tooltip label="Dismiss this review error">
            <button className="btn" onClick={onDismissError}>Dismiss</button>
          </Tooltip>
        </p>
      )}

      {queue.length === 0
        ? <p className="file-review-empty">Submit a comment and it joins this queue.</p>
        : (
          <ol className="file-review-list">
            {queue.map((thread, index) => {
              const editable = isEditableInQueue(thread);
              const message = unsentMessage(thread);
              const isOut = out?.id === thread.id;
              const open = editing?.messageId === message?.id ? editing : null;
              return (
                <li
                  key={thread.id}
                  className={`file-review-item${isOut ? " is-outstanding" : ""}`}
                >
                  <div className="file-review-row">
                    <span className="file-review-index">{index + 1}</span>
                    <Tooltip label={`Open ${thread.path} at ${lineRange(thread.startLine, thread.endLine)}`}>
                      <button
                        className="file-review-open mono"
                        aria-label={`Open comment ${thread.shortId} on ${thread.path} ${lineRange(thread.startLine, thread.endLine)}`}
                        onClick={() => onOpen(thread)}
                      >
                        {thread.path}:{thread.startLine}
                      </button>
                    </Tooltip>
                    <span className={`file-comment-state is-${thread.status}`}>
                      {threadStateLabel(thread)}
                    </span>
                    {/*
                      The comment itself, on the SAME line as its location.
                      A queue is read by scanning it, and a row per comment plus a row per
                      body halved how many were on screen at once - which is the one thing
                      this panel exists to show. Truncated with an ellipsis; the whole text is
                      one click away in the file, and one Edit away here.
                    */}
                    {!open && (
                      <span className="file-review-body">{queueRowText(thread)}</span>
                    )}
                    {open && <span className="file-toolbar-spacer" />}
                    {/*
                      Reorder, rewrite and drop are offered on a QUEUED comment and never on
                      the one in flight - including during the `sending` window before
                      delivery is confirmed. The daemon refuses all three there, so drawing
                      them would be an affordance that can only answer 409.
                    */}
                    <Tooltip label="Send this comment one place earlier">
                      <button
                        className="icon-btn"
                        aria-label={`Move comment ${thread.shortId} earlier`}
                        disabled={busy || !editable || index === 0}
                        onClick={() => onMove(thread.id, -1)}
                      >
                        ↑
                      </button>
                    </Tooltip>
                    <Tooltip label="Send this comment one place later">
                      <button
                        className="icon-btn"
                        aria-label={`Move comment ${thread.shortId} later`}
                        disabled={busy || !editable || index === queue.length - 1}
                        onClick={() => onMove(thread.id, 1)}
                      >
                        ↓
                      </button>
                    </Tooltip>
                    <Tooltip
                      label={editable
                        ? "Rewrite this comment before it goes"
                        : "This comment is already committed to the outbox"}
                    >
                      <button
                        className="btn"
                        aria-label={`Edit comment ${thread.shortId}`}
                        disabled={busy || !editable || !message}
                        onClick={() =>
                          setEditing(
                            open || !message ? null : { messageId: message.id, body: message.body },
                          )}
                      >
                        Edit
                      </button>
                    </Tooltip>
                    <Tooltip label={editable ? "Drop this comment from the review" : "This comment is already out with the agent"}>
                      {/*
                        A plain button, not `btn-danger`. Dropping a QUEUED comment removes
                        something the agent has never seen, and a row of red on every line of
                        a twelve-comment review reads as twelve warnings rather than as one
                        ordinary control. The genuinely destructive door - deleting a thread
                        the agent already answered - is Resolve in the thread panel, and it is
                        not this.
                      */}
                      <button
                        className="btn"
                        aria-label={`Drop comment ${thread.shortId}`}
                        disabled={busy || !editable}
                        onClick={() => onDrop(thread.id)}
                      >
                        Drop
                      </button>
                    </Tooltip>
                  </div>
                  {thread.outdated && (
                    <p className="file-comment-stale">
                      the quoted text has moved or is gone
                    </p>
                  )}
                  {open && (
                    <div className="file-review-edit">
                        <textarea
                          aria-label={`Comment ${thread.shortId}`}
                          value={open.body}
                          readOnly={busy}
                          rows={3}
                          onChange={(event) =>
                            setEditing({ messageId: open.messageId, body: event.target.value })}
                        />
                        <div className="file-review-edit-actions">
                          <Tooltip label="Leave this comment as it was">
                            <button className="btn" disabled={busy} onClick={() => setEditing(null)}>
                              Cancel
                            </button>
                          </Tooltip>
                          <Tooltip label="Save what this comment will send">
                            <button
                              className="btn btn-primary"
                              disabled={busy || !open.body.trim()}
                              onClick={() => {
                                void onEdit(open.messageId, open.body).then((ok) => {
                                  // Kept open on a refusal, exactly as the reply box is: the
                                  // reader's sentence is still the thing to retry with.
                                  if (ok) setEditing(null);
                                });
                              }}
                            >
                              Save
                            </button>
                          </Tooltip>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
    </section>
  );
}
