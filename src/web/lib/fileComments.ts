// What the Files workspace needs to know about line comments, with no React and no I/O.
//
// Everything here is a pure function of the durable model phase 1 publishes plus the text
// currently in the editor. That is deliberate and it is the rule the CodeMirror integration
// rests on: markers and the open panel are DERIVED from `FileCommentThread.startLine` on
// every render, never mapped through a document change. `FileEditor` replaces its whole
// document on an external sync and destroys its `EditorView` outright when `path`,
// `readOnly` or `lineSeparator` change, and position-mapped decorations do not survive
// either. Derived ones do not notice.

import type { FileCommentReview, FileCommentThread, SessionFileDocument } from "@shared/types.ts";
import { boundQuote, normalizeQuote } from "@shared/file-comment-anchor.ts";
import {
  holdsQueuePosition,
  isOutstandingThreadStatus,
  isTerminalThreadStatus,
} from "@shared/file-comments.ts";

/**
 * Whether the Editor can anchor a comment in this document.
 *
 * **Deliberately not `previewable`.** That predicate answers a different question - "is
 * there something to render instead of source" - and it includes `image`, which has no
 * lines at all. It is also pinned by a literal source regex in
 * `test/console-arrow-scroll.test.ts`, so it could not be narrowed even if the two
 * questions happened to coincide today. They do not: a plain `.ts` file is commentable and
 * not previewable, and a `.png` is previewable and not commentable.
 *
 * A `binary` or `oversized` document arrives with `text === null` and is refused by that
 * clause rather than by a kind list, which is the same test the Editor itself renders on -
 * so the control is live exactly when there are lines on screen to click.
 *
 * A file too large to EDIT (over the 2 MiB editor limit) still arrives with its text and
 * still renders in the Editor read-only, and it takes comments. Reading is when you want to
 * point at a line; being unable to type into the buffer does not change that.
 */
export function isCommentableDocument(document: SessionFileDocument): boolean {
  return document.kind !== "image" && document.text !== null;
}

/** Split exactly as CodeMirror numbers lines, so line N here is line N on screen. */
export function sourceLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/**
 * The anchor a click on line `line` takes, or null when the file has no text to anchor to.
 *
 * A blank line is the case this exists for. `CreateFileCommentSchema` refuses a quote that
 * normalizes to nothing - and it is right to, because such a thread is born unanchorable
 * and no edit could ever repair it - so clicking the blank line between two paragraphs
 * cannot anchor to that line alone. It extends to the nearest line that does say
 * something: forward first, because a blank line reads as belonging to what follows it,
 * and backward only when there is nothing below.
 *
 * The range it returns is what the reader sees quoted back, so it stays as small as it can.
 */
export function anchorForLine(
  text: string,
  line: number,
): { startLine: number; endLine: number; quote: string } | null {
  const lines = sourceLines(text);
  if (line < 1 || line > lines.length) return null;
  const speaks = (index: number): boolean => (lines[index] ?? "").trim().length > 0;
  const at = line - 1;
  if (speaks(at)) {
    return { startLine: line, endLine: line, quote: boundQuote(lines[at] ?? "") };
  }
  for (let forward = at + 1; forward < lines.length; forward += 1) {
    if (!speaks(forward)) continue;
    return {
      startLine: line,
      endLine: forward + 1,
      quote: boundQuote(lines.slice(at, forward + 1).join("\n")),
    };
  }
  for (let back = at - 1; back >= 0; back -= 1) {
    if (!speaks(back)) continue;
    return {
      startLine: back + 1,
      endLine: line,
      quote: boundQuote(lines.slice(back, at + 1).join("\n")),
    };
  }
  return null;
}

/** A thread's opening comment - the row a draft edits and the one a reader sees first. */
export function openingMessage(thread: FileCommentThread): FileCommentThread["messages"][number] | null {
  return thread.messages[0] ?? null;
}

/**
 * The threads this file's Editor draws, newest anchor last.
 *
 * `orphaned` never appears: its session is gone, so the thread is the prune's and there is
 * nothing a person can do to it. `resolved` appears only behind the toggle - the point of
 * closing a thread is that it stops taking up room in the file.
 */
export function threadsForFile(
  threads: readonly FileCommentThread[],
  sessionId: string,
  path: string | null,
  showResolved: boolean,
): FileCommentThread[] {
  if (!path) return [];
  return threads
    .filter((thread) => thread.sessionId === sessionId && thread.path === path)
    .filter((thread) => thread.status !== "orphaned")
    .filter((thread) => showResolved || thread.status !== "resolved")
    .sort((a, b) => a.startLine - b.startLine || a.createdAt - b.createdAt);
}

/** Anchor line to the threads on it, in the order they were written. */
export function threadsByLine(
  threads: readonly FileCommentThread[],
): Map<number, FileCommentThread[]> {
  const byLine = new Map<number, FileCommentThread[]>();
  for (const thread of threads) {
    const bucket = byLine.get(thread.startLine);
    if (bucket) bucket.push(thread);
    else byLine.set(thread.startLine, [thread]);
  }
  return byLine;
}

/** How a thread's state reads on a marker and in a thread header. */
export function threadStateLabel(thread: FileCommentThread): string {
  if (thread.outdated) return "moved";
  switch (thread.status) {
    case "draft": return "draft";
    case "queued": return "queued";
    case "sending":
    case "awaiting": return "sent";
    case "answered": return "answered";
    case "unanswered": return "no answer";
    case "resolved": return "resolved";
    case "orphaned": return "session ended";
  }
}

/** Whether a person can still close this thread, as opposed to reopen it. */
export function canResolveThread(thread: FileCommentThread): boolean {
  return !isTerminalThreadStatus(thread.status);
}

/**
 * The accessible name of a line's marker.
 *
 * It names the LINE and the STATE, because those are the two things a marker communicates
 * to a sighted reader by position and colour and to nobody else otherwise.
 */
export function markerLabel(line: number, threads: readonly FileCommentThread[]): string {
  const first = threads[0];
  if (!first) return `Comment on line ${line}`;
  if (threads.length > 1) {
    return `${threads.length} comments on line ${line}`;
  }
  const replies = Math.max(0, first.messageCount - 1);
  const state = threadStateLabel(first);
  const tail = replies === 0 ? "" : `, ${replies} ${replies === 1 ? "reply" : "replies"}`;
  return `Comment ${first.shortId} on line ${line}, ${state}${tail}`;
}

/** The marker's visual class, so a resolved or stale thread does not read as a live one. */
export function markerTone(threads: readonly FileCommentThread[]): string {
  const first = threads[0];
  if (!first) return "is-draft";
  if (first.status === "resolved") return "is-resolved";
  if (first.outdated) return "is-outdated";
  if (first.status === "answered") return "is-answered";
  if (first.status === "draft") return "is-draft";
  return "is-queued";
}

/**
 * Whether a body is worth persisting as a draft yet.
 *
 * The create route trims and requires at least one character, and it computes the quote
 * hash off `normalizeQuote`, so a body of only whitespace is refused rather than stored.
 * Asking here keeps the first keystroke from spending a request that cannot succeed.
 */
export function isPersistableBody(body: string): boolean {
  return body.trim().length > 0 && normalizeQuote(body).length > 0;
}

// ---- the review queue (phase 3's walkthrough) ----

/**
 * The comments a session's review still holds, in the order they will be delivered.
 *
 * Spans every FILE, unlike `threadsForFile` above, and that is the difference that matters:
 * a review is a pass over a working tree, not over one document, so the queue panel has to
 * name each comment's path. The threads arrive here already ordered by `queue_seq` from the
 * daemon's own comparator, but the wire list is keyed by id and carries every session's
 * threads, so the order is re-established rather than assumed.
 *
 * `sending` and `awaiting` keep their positions - they hold `queue_seq` and are what
 * `QUEUE_POSITION_THREAD_STATUSES` names - so the comment currently out with the agent is
 * still in this list, at the head, which is where a reader expects to find it.
 */
export function reviewQueue(
  threads: readonly FileCommentThread[],
  sessionId: string,
): FileCommentThread[] {
  return threads
    .filter((thread) => thread.sessionId === sessionId && holdsQueuePosition(thread.status))
    .sort((a, b) => (a.queueSeq ?? 0) - (b.queueSeq ?? 0) || a.createdAt - b.createdAt);
}

/** The comment out with the agent right now, or null between two turns. */
export function outstandingThread(queue: readonly FileCommentThread[]): FileCommentThread | null {
  return queue.find((thread) => isOutstandingThreadStatus(thread.status)) ?? null;
}

/**
 * The message a queued comment would send next: its oldest human message not yet delivered.
 *
 * The same selection the daemon's payload renderer makes, and the reason edit-unsent edits
 * this row rather than the thread's opening comment - a thread that timed out and was replied
 * to would otherwise offer to edit a comment the agent has already read.
 *
 * Null when there is nothing left to send, and null is also what a truncated frame yields for
 * a thread past the message cap: the wire list carries the NEWEST fifty, so an undelivered
 * message older than those is not in it. Editing is refused rather than guessed at there,
 * which is the safe direction - fifty replies deep on one line, the composer is not the
 * problem.
 */
export function unsentMessage(thread: FileCommentThread): FileCommentThread["messages"][number] | null {
  return thread.messages.find((m) => m.author === "human" && m.deliveredAt === null) ?? null;
}

/**
 * The one line of text a queue row shows for a comment.
 *
 * The comment somebody WROTE, not the line they wrote it about. `unsentMessage` goes null the
 * moment a comment is delivered, and falling back to the quote there made the head row - the
 * one row a reader is actually watching - stop showing the sentence it just sent and start
 * showing the source line instead, which reads as the queue having lost it. So the latest
 * human message wins whether or not it has gone, and the quote is only the answer for a
 * thread that somehow carries no human message at all.
 */
export function queueRowText(thread: FileCommentThread): string {
  const written = [...thread.messages].reverse().find((m) => m.author === "human");
  return written?.body ?? thread.quote;
}

/**
 * Whether this comment can still be rewritten, reordered or dropped.
 *
 * False for the one in flight, INCLUDING during the `sending` window before delivery is
 * confirmed: the bytes are already committed to the outbox, and the daemon refuses the edit
 * outright, so offering the control would only produce a 409 the reader cannot act on.
 */
export function isEditableInQueue(thread: FileCommentThread): boolean {
  return !isOutstandingThreadStatus(thread.status);
}

/**
 * What the walkthrough is doing, in one sentence, for the queue panel's live region.
 *
 * Announced rather than merely drawn because the whole feature is a queue draining without
 * anybody watching it: a sighted reader sees the head move, and without this a screen-reader
 * user is left guessing whether their review is running at all.
 */
export function reviewAnnouncement(
  review: FileCommentReview | null,
  queue: readonly FileCommentThread[],
): string {
  const waiting = queue.filter((thread) => thread.status === "queued").length;
  const out = outstandingThread(queue);
  const remaining = `${waiting} comment${waiting === 1 ? "" : "s"} waiting`;
  // Deliberately WITHOUT the pause reason. The reason is drawn beside this line in its own
  // `role="alert"`, which a screen reader announces too, so carrying it here as well read as
  // the same sentence twice - on screen, literally twice, one under the other.
  if (review?.state === "paused") return `Review paused. ${remaining}.`;
  if (review?.state !== "running") {
    return waiting === 0
      ? "No comments are queued for review."
      : `Review not started. ${remaining}.`;
  }
  return out
    ? `${out.shortId} on ${out.path} line ${out.startLine} is out with the agent. ${remaining}.`
    : `Review running. ${remaining}.`;
}
