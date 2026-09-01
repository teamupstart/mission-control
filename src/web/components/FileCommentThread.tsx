// The panel that opens under a commented line: a composer for a new comment, or the
// thread that line already owns.
//
// Presentational on purpose. Every write goes through a callback the workspace owns, so
// these components have no idea a daemon exists - which is what lets phase 5 mount the
// same two under the Markdown and HTML previews rather than reimplementing them, and what
// lets `renderToStaticMarkup` assert their shape without a DOM.
//
// Nothing here is a `role="dialog"`. It is an inline panel inside the document, in flow
// under the line it belongs to: it does not cover the app, it does not trap focus, and it
// must not stand App's global shortcuts down while you are reading the file behind it.
// See `test/overlay-registry.test.ts` for why that distinction is worth stating.

import { useEffect, useRef, useState } from "react";
import type { FileCommentThread as FileCommentThreadModel } from "@shared/types.ts";
import { canResolveThread, threadStateLabel } from "../lib/fileComments.ts";
import { Tooltip } from "./Tooltip.tsx";

function when(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function lineRange(startLine: number, endLine: number): string {
  return startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`;
}

/**
 * A new comment on a line, and the one surface in this feature that is NOT purely
 * presentational about its text.
 *
 * The text lives here and is reported out on every keystroke, because the workspace turns
 * the first keystroke into a durable `draft` row and every one after it into an edit of
 * that row. Holding the string in the composer as well would be a second copy of the same
 * answer; holding it ONLY in the workspace would round-trip every character through a
 * request before it could be drawn. So: local for the caret, reported for the record.
 */
export function FileCommentComposer({
  startLine,
  endLine,
  quote,
  value,
  busy,
  error,
  onChange,
  onSubmit,
  onCancel,
}: {
  startLine: number;
  endLine: number;
  quote: string;
  value: string;
  busy: boolean;
  error: string | null;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const box = useRef<HTMLTextAreaElement>(null);
  // The composer is opened by a click on a line number, so the caret has to arrive without
  // a second one. Keyed to the line, so moving to another line moves the caret with it.
  useEffect(() => {
    box.current?.focus();
  }, [startLine]);

  /*
   * A submission in flight FREEZES this composer, rather than only greying its button.
   *
   * Submitting is two requests - the last edit, then the queue - and the reader's text is
   * already a durable row throughout. Leaving the box live meant a keystroke during a slow
   * queue request scheduled an edit BEHIND it, so the message a reader submitted could still
   * change afterwards; and Cancel stayed armed over a comment that was on its way into the
   * review queue.
   *
   * Read-only rather than disabled: the words are still theirs to select and copy while they
   * wait, and a disabled textarea is unreachable and unreadable to a screen reader.
   */

  return (
    <section
      className="file-comment-panel is-composer"
      aria-label={`New comment on ${lineRange(startLine, endLine)}`}
    >
      <header className="file-comment-panel-head">
        <span className="file-comment-line">{lineRange(startLine, endLine)}</span>
        <span className="file-comment-quote mono">{quote}</span>
      </header>
      <textarea
        ref={box}
        className="file-comment-box"
        value={value}
        placeholder="What is wrong with this line?"
        aria-label={`Comment on ${lineRange(startLine, endLine)}`}
        readOnly={busy}
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          // Escape cancels the composer and stops there. It must not reach App's global
          // Escape, which would also hand the Console reader back to its rail and then
          // drop the fleet selection - three layers peeled by one press. It is still stopped
          // while busy, when it cancels nothing: the reader is looking at this panel either
          // way, and one press should not peel the layers behind it.
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            if (!busy) onCancel();
            return;
          }
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            onSubmit();
          }
        }}
      />
      {error && <p className="file-comment-error" role="alert">{error}</p>}
      <footer className="file-comment-panel-foot">
        <Tooltip label={busy ? "This comment is being submitted" : "Discard this comment"}>
          <button className="btn" disabled={busy} onClick={onCancel}>Cancel</button>
        </Tooltip>
        <Tooltip label="Add this comment to the review">
          <button
            className="btn btn-primary"
            disabled={busy || value.trim().length === 0}
            onClick={onSubmit}
          >
            Comment
          </button>
        </Tooltip>
      </footer>
    </section>
  );
}

/**
 * An existing thread, expanded: what was said, in time order, and a box to say more.
 *
 * A reply is a durable note on the thread and nothing else in this phase. Phase 3 is what
 * makes one re-enter the review queue; until it merges, writing here records the follow-up
 * where the reader wrote it rather than in a scrollback.
 */
export function FileCommentThreadCard({
  thread,
  displayQuote,
  busy,
  error,
  onReply,
  onResolve,
  onReopen,
  onClose,
}: {
  thread: FileCommentThreadModel;
  /** Human-readable projection; durable anchor markup stays on `thread`. */
  displayQuote: string;
  busy: boolean;
  error: string | null;
  /** Resolves true when the reply reached the thread. False keeps the text to retry. */
  onReply: (body: string) => Promise<boolean>;
  onResolve: () => void;
  onReopen: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const resolvable = canResolveThread(thread);
  /*
   * The reply box empties on SUCCESS, not on click.
   *
   * Clearing it immediately meant a rejected or offline request took the reader's sentence
   * with it: the error appeared above a box that no longer held what to retry, and the only
   * way forward was to type it again from memory.
   */
  const send = async (): Promise<void> => {
    const body = reply.trim();
    if (!body || sending) return;
    setSending(true);
    const ok = await onReply(body);
    setSending(false);
    // Clear the box only if it still holds WHAT WAS SENT. The freeze below is what normally
    // guarantees that, and this is the second half of the same rule: emptying the box on
    // success is only correct for the sentence that succeeded, never for one typed since.
    if (ok) setReply((current) => (current.trim() === body ? "" : current));
  };
  // A thread past the wire cap arrives carrying its NEWEST messages, not all of them.
  // Saying so is the honest thing: the alternative is a reader counting replies and
  // concluding the earlier ones were lost.
  const truncated = thread.messageCount > thread.messages.length;

  return (
    <section
      className="file-comment-panel is-thread"
      aria-label={`Comment ${thread.shortId} on ${lineRange(thread.startLine, thread.endLine)}`}
    >
      <header className="file-comment-panel-head">
        <span className="file-comment-id mono">{thread.shortId}</span>
        <span className="file-comment-line">{lineRange(thread.startLine, thread.endLine)}</span>
        <span className={`file-comment-state is-${thread.status}`}>{threadStateLabel(thread)}</span>
        {thread.outdated && (
          <span className="file-comment-stale">the quoted text has moved</span>
        )}
        <span className="file-comment-panel-spacer" />
        <Tooltip label="Collapse this thread">
          <button className="icon-btn" aria-label={`Collapse comment ${thread.shortId}`} onClick={onClose}>✕</button>
        </Tooltip>
      </header>
      <blockquote className="file-comment-quote mono">{displayQuote}</blockquote>
      {truncated && (
        <p className="file-comment-truncated">
          Showing the most recent {thread.messages.length} of {thread.messageCount} messages.
        </p>
      )}
      <ol className="file-comment-messages">
        {thread.messages.map((message) => (
          <li key={message.id} className={`file-comment-message is-${message.author}`}>
            <span className="file-comment-author">{message.author === "agent" ? "Agent" : "You"}</span>
            <span className="file-comment-when">{when(message.createdAt)}</span>
            <p className="file-comment-body">{message.body}</p>
          </li>
        ))}
      </ol>
      {error && <p className="file-comment-error" role="alert">{error}</p>}
      <textarea
        className="file-comment-box"
        value={reply}
        placeholder="Reply…"
        aria-label={`Reply to comment ${thread.shortId}`}
        // Frozen while the reply is out, for the reason the composer is - a reply in flight
        // owns this box. Typing into it during a slow request meant the success handler
        // emptied a sentence that had never been sent. Read-only rather than disabled, so
        // the words stay selectable and stay readable while the reader waits.
        readOnly={sending}
        onChange={(event) => setReply(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
            return;
          }
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && reply.trim() && !sending) {
            event.preventDefault();
            void send();
          }
        }}
      />
      <footer className="file-comment-panel-foot">
        {resolvable ? (
          <Tooltip label="Close this thread. Only a person closes a comment">
            <button className="btn" disabled={busy} onClick={onResolve}>Resolve</button>
          </Tooltip>
        ) : (
          <Tooltip label="Put this thread back in play">
            <button className="btn" disabled={busy} onClick={onReopen}>Reopen</button>
          </Tooltip>
        )}
        <span className="file-comment-panel-spacer" />
        <Tooltip label="Add this reply to the thread">
          <button
            className="btn btn-primary"
            disabled={busy || sending || reply.trim().length === 0}
            onClick={() => { void send(); }}
          >
            Reply
          </button>
        </Tooltip>
      </footer>
    </section>
  );
}
