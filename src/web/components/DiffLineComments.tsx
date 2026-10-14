// Line comments in the Diff tab: the Files tab's comment experience, reachable from the line
// a reader is looking at in a diff.
//
// Nothing here is a second comment system. A thread written from a diff row is created by the
// same draft hook, through the same routes, against the same Files-relative path, working-tree
// line and quote, so it is the thread the Files tab draws on that line and the one the review
// queue delivers. The composer and the thread card are the Files tab's own components. What
// this module adds is the part a diff needs that an editor does not: the whole file is not on
// screen, so the document is read once per file to anchor against, and a row is only
// commentable when it still agrees with that document (see `diffRowSourceLine`).
//
// Preview surfaces are out of scope here by design. A diff is source, so a comment in it is
// always an `editor`-surface line comment.

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import type {
  FileCommentReview,
  FileCommentThread,
  Session,
  SessionFileDocument,
} from "@shared/types.ts";
import {
  appendFileCommentMessage,
  fetchSessionFile,
  markFileCommentRead,
  setFileCommentStatus,
} from "../lib/api.ts";
import type { DiffLine } from "../lib/diff.ts";
import { diffRowSourceLine } from "../lib/diffComments.ts";
import { useFileCommentDraft } from "../lib/fileCommentDraft.ts";
import {
  composerDeliveryHint,
  fileCommentQuoteForDisplay,
  isReadOnlyWorkspace,
  markerLabel,
  markerTone,
  reanchorThreadsForDisplay,
  reviewQueue,
  sourceLines,
  threadsByLine,
  threadsForFile,
} from "../lib/fileComments.ts";
import { useKeybindingHints } from "../lib/keybindings.ts";
import { FileCommentComposer, FileCommentThreadCard } from "./FileCommentThread.tsx";
import { Tooltip } from "./Tooltip.tsx";

/** The working-tree document a diff file's comments anchor against. */
export interface DiffSourceDocument {
  document: SessionFileDocument | null;
  error: string | null;
}

/**
 * Read the current working-tree text of the file a diff is showing.
 *
 * The diff holds hunks, and anchoring needs the file: a blank line extends to the nearest line
 * that says something (`anchorForLine`), the thread carries the document's revision, and an
 * existing thread is drawn where its quote sits NOW (`reanchorThreadsForDisplay`). All three
 * are what the Files tab does with its buffer, so the diff asks the same route for the same
 * document rather than approximating any of them from the hunks.
 *
 * Re-read when the diff itself reloads (`reloadKey`), so the two snapshots stay close. The
 * answer is held WITH the request it answers, and anything else reads as "not yet": for the
 * one render between selecting a file and this effect running, the previous file's lines must
 * not be checked against the new file's rows.
 */
export function useDiffSourceDocument(
  sessionId: string,
  path: string | null,
  reloadKey: unknown,
): DiffSourceDocument {
  const [answer, setAnswer] = useState<{
    sessionId: string;
    path: string;
    reloadKey: unknown;
    document: SessionFileDocument | null;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    void fetchSessionFile(sessionId, path, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setAnswer({
        sessionId,
        path,
        reloadKey,
        document: result.ok ? result.file : null,
        error: result.ok ? null : result.error,
      });
    });
    // Arrowing through a long file list starts a read per file; only the last one matters.
    return () => controller.abort();
  }, [path, reloadKey, sessionId]);

  const current = answer
    && answer.sessionId === sessionId
    && answer.path === path
    && answer.reloadKey === reloadKey
    ? answer
    : null;
  return { document: current?.document ?? null, error: current?.error ?? null };
}

/** Everything a rendered diff file needs to draw comments and take new ones. */
export interface DiffFileComments {
  /** Whether a click on a line number starts a comment right now. */
  active: boolean;
  /** Why this file cannot take a new comment, or null when it can. */
  blockReason: string | null;
  /** Pinned provider evidence: threads are readable, nothing is writable. */
  readOnly: boolean;
  onToggleMode: () => void;
  resolvedCount: number;
  showResolved: boolean;
  onToggleResolved: () => void;
  /** The working-tree line a row stands for, or null when the row takes no comment. */
  sourceLine: (line: DiffLine) => number | null;
  /** The threads drawn on a working-tree line, in the order they were written. */
  threadsOn: (line: number) => readonly FileCommentThread[];
  onLineSelect: (line: number) => void;
  onMarkerSelect: (line: number) => void;
  /** The working-tree line whose panel is open, or null when none is. */
  panelLine: number | null;
  panel: React.ReactNode;
  /** A comment error with no open panel to carry it. */
  notice: string | null;
  onDismissNotice: () => void;
}

const NO_THREADS: readonly FileCommentThread[] = [];

/**
 * The Diff tab's comment state for the file on screen.
 *
 * The same moves the Files workspace makes, in the same order, against the same model:
 * a click on a line number opens the thread already on that line (cycling when there are
 * several) or a fresh composer; a marker opens its thread; a draft reopens as its composer.
 * Comment mode is a property of the reader rather than of one file, so it survives moving
 * between files, and everything open on a file closes - settling, never discarding, a
 * draft - when the reader moves to another.
 */
export function useDiffLineComments(input: {
  session: Session;
  /** The Files-relative path of the file on screen, or null when it has none. */
  path: string | null;
  source: DiffSourceDocument;
  blockReason: string | null;
  threads: readonly FileCommentThread[];
  reviews: readonly FileCommentReview[];
}): DiffFileComments {
  const { session, path, source, blockReason, threads, reviews } = input;
  const readOnly = isReadOnlyWorkspace(session);
  const document = source.document;
  const text = document?.text ?? null;
  const lines = useMemo(() => (text === null ? null : sourceLines(text)), [text]);

  const [mode, setMode] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);
  const [threadBusy, setThreadBusy] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);
  const draft = useFileCommentDraft({
    sessionId: session.id,
    path,
    revision: document?.revision ?? null,
    onDetachedError: setThreadError,
  });

  const canComment = blockReason === null && !readOnly;
  const active = mode && canComment;
  const onToggleMode = useCallback(() => {
    if (canComment) setMode((value) => !value);
  }, [canComment]);

  const allThreads = useMemo(() => {
    const own = threadsForFile(threads, session.id, path, true);
    if (!document || text === null) return own;
    return reanchorThreadsForDisplay(own, text, document.revision);
  }, [document, path, session.id, text, threads]);
  const visibleThreads = useMemo(
    () => showResolved ? allThreads : allThreads.filter((thread) => thread.status !== "resolved"),
    [allThreads, showResolved],
  );
  const threadLines = useMemo(() => threadsByLine(visibleThreads), [visibleThreads]);
  const resolvedCount = allThreads.filter((thread) => thread.status === "resolved").length;
  const openThread = allThreads.find((thread) => thread.id === openThreadId) ?? null;

  // Reading a thread is what clears its pip, here exactly as in the Files tab: the badge is
  // durable, so the read has to be too.
  useEffect(() => {
    if (!openThread) return;
    const unread = openThread.messages.some((m) => m.author === "agent" && m.readAt === null);
    if (unread) void markFileCommentRead(openThread.id);
  }, [openThread]);

  // A comment belongs to the file and session it was written on. Moving to another closes
  // what was open and lets a draft settle where it was written.
  const dismissDraft = draft.dismiss;
  useEffect(() => {
    setOpenThreadId(null);
    setThreadError(null);
    dismissDraft();
  }, [dismissDraft, path, session.id]);
  useEffect(() => {
    if (readOnly) dismissDraft();
  }, [dismissDraft, readOnly]);

  const openThreadOnLine = useCallback((line: number): void => {
    const bucket = threadLines.get(line) ?? [];
    if (bucket.length === 0) return;
    setThreadError(null);
    // `-1` when nothing on this line is open lands on the first; running off the end closes
    // the panel rather than wrapping back to a thread just read.
    const at = bucket.findIndex((thread) => thread.id === openThreadId);
    const next = bucket[at + 1] ?? null;
    draft.dismiss();
    if (!next) {
      setOpenThreadId(null);
      return;
    }
    setOpenThreadId(next.id);
    if (next.status === "draft" && !readOnly) draft.openDraft(next);
  }, [draft, openThreadId, readOnly, threadLines]);

  const onLineSelect = useCallback((line: number): void => {
    if (threadLines.has(line)) {
      openThreadOnLine(line);
      return;
    }
    if (!active || text === null) return;
    setOpenThreadId(null);
    draft.dismiss();
    if (draft.openLine(line, text)) {
      setThreadError(null);
      return;
    }
    setThreadError("This file has no text to anchor a comment to.");
  }, [active, draft, openThreadOnLine, text, threadLines]);

  const reply = useCallback(async (threadId: string, body: string): Promise<boolean> => {
    setThreadBusy(true);
    const result = await appendFileCommentMessage(threadId, body);
    setThreadBusy(false);
    setThreadError(result.ok ? null : result.error);
    return result.ok;
  }, []);

  const setThreadStatus = useCallback(async (
    threadId: string,
    status: "draft" | "resolved",
  ): Promise<void> => {
    setThreadBusy(true);
    const result = await setFileCommentStatus(threadId, status);
    setThreadBusy(false);
    if (!result.ok) {
      setThreadError(result.error);
      return;
    }
    setThreadError(null);
    // A closed thread is no longer drawn unless resolved ones are shown, so its panel would
    // be left open under a line with no marker.
    if (status === "resolved" && !showResolved) setOpenThreadId(null);
  }, [showResolved]);

  // What Send will do, from the same queue and run state the daemon decides on.
  const queue = useMemo(() => reviewQueue(threads, session.id), [threads, session.id]);
  const review = useMemo(
    () => reviews.find((r) => r.sessionId === session.id) ?? null,
    [reviews, session.id],
  );
  const hint = composerDeliveryHint(review, queue, session);

  const composer = readOnly ? null : draft.composer;
  let panel: React.ReactNode = null;
  if (composer) {
    panel = (
      <FileCommentComposer
        startLine={composer.startLine}
        endLine={composer.endLine}
        quote={fileCommentQuoteForDisplay(composer.surface, composer.quote, composer.htmlBlockQuote)}
        value={composer.text}
        hint={hint}
        busy={composer.busy}
        error={composer.error}
        onChange={draft.change}
        onSubmit={draft.submit}
        onCancel={draft.cancel}
      />
    );
  } else if (openThread) {
    panel = (
      <FileCommentThreadCard
        thread={openThread}
        displayQuote={fileCommentQuoteForDisplay(
          openThread.surface,
          openThread.quote,
          openThread.htmlBlockQuote,
        )}
        readOnly={readOnly}
        busy={threadBusy}
        error={threadError}
        onReply={(body) => reply(openThread.id, body)}
        onResolve={() => { void setThreadStatus(openThread.id, "resolved"); }}
        onReopen={() => { void setThreadStatus(openThread.id, "draft"); }}
        onClose={() => setOpenThreadId(null)}
      />
    );
  }

  return {
    active,
    blockReason,
    readOnly,
    onToggleMode,
    resolvedCount,
    showResolved,
    onToggleResolved: () => setShowResolved((value) => !value),
    sourceLine: (line) => diffRowSourceLine(line, lines),
    threadsOn: (line) => threadLines.get(line) ?? NO_THREADS,
    onLineSelect,
    onMarkerSelect: openThreadOnLine,
    panelLine: composer?.line ?? openThread?.startLine ?? null,
    panel,
    notice: threadError !== null && !composer && !openThread ? threadError : null,
    onDismissNotice: () => setThreadError(null),
  };
}

/**
 * The diff file header's comment controls - the Files toolbar's, with the Files toolbar's
 * names, so a reader and a screen reader meet the same two buttons in both tabs.
 *
 * `aria-disabled` rather than `disabled`, which is the diff header's own rule (see its
 * Open in Files button): the reason a file takes no comment differs by file - one commit,
 * deleted, outside the checkout, binary - and a disabled button cannot be focused, so its
 * tooltip, which is where that reason lives, would be unreachable from the keyboard.
 */
export function DiffCommentControls({
  comments,
}: {
  comments: DiffFileComments;
}): React.JSX.Element | null {
  const [showKeybindingHints] = useKeybindingHints();
  if (comments.readOnly) return null;
  const blocked = comments.blockReason !== null;
  return (
    <div className="file-comment-controls">
      <Tooltip label={comments.blockReason ?? "Comment on a line: click a line number"}>
        <button
          type="button"
          className={`file-comment-toggle${comments.active ? " on" : ""}`}
          aria-label="Comment mode"
          aria-keyshortcuts={blocked ? undefined : "m"}
          aria-pressed={comments.active}
          aria-disabled={blocked}
          onClick={comments.onToggleMode}
        >
          Comment
          {!blocked && showKeybindingHints && <kbd className="kb-hint">m</kbd>}
        </button>
      </Tooltip>
      {comments.active && comments.resolvedCount > 0 && (
        <Tooltip
          label={comments.showResolved
            ? "Stop drawing closed threads on this file"
            : `Also show the ${comments.resolvedCount} closed thread${comments.resolvedCount === 1 ? "" : "s"} on this file`}
        >
          <button
            type="button"
            className={`file-comment-toggle${comments.showResolved ? " on" : ""}`}
            aria-label="Show resolved comments"
            aria-pressed={comments.showResolved}
            onClick={comments.onToggleResolved}
          >
            Resolved
          </button>
        </Tooltip>
      )}
    </div>
  );
}

/**
 * What a line number does when pressed, said as a description beside its name - which
 * already says the line - rather than repeating it.
 */
function lineButtonTooltip(threadCount: number): string {
  if (threadCount === 0) return "Write a comment about this line";
  return threadCount === 1
    ? "Open the comment on this line"
    : `Step through the ${threadCount} comments on this line`;
}

/** What a marker does when pressed; its name already says which thread and what state. */
function markerTooltip(threadCount: number): string {
  return threadCount === 1
    ? "Expand this thread to read and reply"
    : `Step through the ${threadCount} threads on this line`;
}

/**
 * A file's numbered diff, with its comments drawn in.
 *
 * In comment mode the NEW-side line number of every row that is a line of the working-tree
 * file becomes a button, which is the Files editor's "click a line number" in a diff's shape.
 * It is a real, named control rather than a click handler on a cell: CodeMirror hides its
 * gutter from assistive technology and the Files tab had to work around that, and a table has
 * no such excuse. A row carrying threads gets the Files editor's marker at the end of its
 * text, and the open panel is a full-width row directly under the line it belongs to.
 */
export function DiffLines({
  lines,
  comments,
}: {
  lines: readonly DiffLine[];
  comments: DiffFileComments | null;
}): React.JSX.Element {
  return (
    <div className="diff-lines">
      <table>
        <tbody>
          {lines.map((l, i) => {
            const line = comments ? comments.sourceLine(l) : null;
            const threads = comments && line !== null ? comments.threadsOn(line) : NO_THREADS;
            return (
              <Fragment key={i}>
                <tr className={`dl dl-${l.type}`}>
                  <td className="dl-num">{l.oldNo ?? ""}</td>
                  <td className="dl-num">
                    {comments?.active && line !== null ? (
                      <Tooltip label={lineButtonTooltip(threads.length)}>
                        <button
                          type="button"
                          className="dl-num-comment"
                          aria-label={`Comment on line ${line}`}
                          onClick={() => comments.onLineSelect(line)}
                        >
                          {l.newNo}
                        </button>
                      </Tooltip>
                    ) : (l.newNo ?? "")}
                  </td>
                  <td className="dl-sign">{l.type === "add" ? "+" : l.type === "del" ? "−" : ""}</td>
                  <td className="dl-text">
                    {l.text || " "}
                    {comments && line !== null && threads.length > 0 && (
                      // The Files editor's marker, class and all, so a thread looks the same
                      // in both tabs. Its name says which line and which state, because that is
                      // what its position and colour say to everyone who can see it.
                      <Tooltip label={markerTooltip(threads.length)}>
                        <button
                          type="button"
                          className={`cm-file-comment-marker ${markerTone(threads)}`}
                          aria-label={markerLabel(line, threads)}
                          onClick={() => comments.onMarkerSelect(line)}
                        >
                          ●
                        </button>
                      </Tooltip>
                    )}
                  </td>
                </tr>
                {comments && line !== null && comments.panelLine === line && comments.panel && (
                  <tr className="dl-comment-row">
                    <td colSpan={4}>
                      <div className="diff-comment-host">{comments.panel}</div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
