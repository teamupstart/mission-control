import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FileCommentReview, FileCommentThread, Session, SessionDiff } from "@shared/types.ts";
import { sessionWorkspaceRoot } from "@shared/session.ts";
import { fetchSessionDiff } from "../lib/api.ts";
import {
  diffFileOpenTarget,
  parsePatch,
  type DiffFile,
  type DiffFileTarget,
} from "../lib/diff.ts";
import { diffCommentBlockReason, diffFileCommentPath } from "../lib/diffComments.ts";
import { useFileCommentReview, type FileCommentReviewState } from "../lib/fileCommentReview.ts";
import { fileCommentSummaries, type FileCommentSummary } from "../lib/fileComments.ts";
import { chordFromEvent, isTypingTarget, useKeybindings } from "../lib/keybindings.ts";
import { Keycap } from "./Keycap.tsx";
import { Tooltip } from "./Tooltip.tsx";
import { ResizablePaneDivider } from "./ResizablePaneDivider.tsx";
import { FileCommentBadge } from "./FileCommentBadge.tsx";
import { FileCommentControls } from "./FileCommentControls.tsx";
import { FileCommentRail } from "./FileCommentRail.tsx";
import { FileCommentReviewPanel } from "./FileCommentQueue.tsx";
import {
  DiffLines,
  useDiffLineComments,
  useDiffSourceDocument,
  type DiffFileComments,
} from "./DiffLineComments.tsx";

const NO_THREADS: readonly FileCommentThread[] = [];
const NO_REVIEWS: readonly FileCommentReview[] = [];

/**
 * Console and Board give a session's diff a real tab, reusing one reader without a
 * screen-owning overlay.
 */
export function InlineDiffViewer({
  session,
  commit,
  requestNonce,
  onOpenInFiles,
  fileCommentThreads = NO_THREADS,
  fileCommentReviews = NO_REVIEWS,
}: {
  session: Session;
  commit?: string | null;
  requestNonce?: number;
  onOpenInFiles?: (path: string) => void;
  /**
   * Every live comment thread and walkthrough state the event stream holds - the same two
   * lists the Files tab reads, so a thread written in either tab is drawn in both.
   */
  fileCommentThreads?: readonly FileCommentThread[];
  fileCommentReviews?: readonly FileCommentReview[];
}): React.JSX.Element {
  return (
    <DiffViewerContent
      session={session}
      commit={commit}
      requestNonce={requestNonce}
      onOpenInFiles={onOpenInFiles}
      fileCommentThreads={fileCommentThreads}
      fileCommentReviews={fileCommentReviews}
    />
  );
}

function DiffViewerContent({
  session,
  commit,
  requestNonce,
  onOpenInFiles,
  fileCommentThreads,
  fileCommentReviews,
}: {
  session: Session;
  commit?: string | null;
  requestNonce?: number;
  onOpenInFiles?: (path: string) => void;
  fileCommentThreads: readonly FileCommentThread[];
  fileCommentReviews: readonly FileCommentReview[];
}): React.JSX.Element {
  const [diff, setDiff] = useState<SessionDiff | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(0);
  const activeItemRef = useRef<HTMLButtonElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const fileListRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let alive = true;
    setDiff(null);
    setLoading(true);
    void fetchSessionDiff(session.id, commit ?? undefined).then((d) => {
      if (alive) {
        setDiff(d);
        setLoading(false);
      }
    });
    return () => {
      alive = false;
    };
  }, [session.id, commit, requestNonce]);

  useLayoutEffect(() => {
    // The shared detail body keeps DOM focus while Tab changes its selected tab. Give
    // the diff reader ownership on mount too, not only when Shift+D supplies a nonce,
    // so its arrows and Open in Files shortcut work through both entry paths.
    contentRef.current?.focus({ preventScroll: true });
  }, [requestNonce]);

  // Re-parse only when the patch changes, not on every render (selection change).
  const files = useMemo(() => (diff?.ok ? parsePatch(diff.patch) : []), [diff]);

  // A fresh diff resets the selection before the loaded list is painted. A passive
  // reset can race the first arrow press and undo the file the operator just selected.
  useLayoutEffect(() => setSelected(0), [files]);

  const activeIdx = files.length > 0 ? Math.min(selected, files.length - 1) : -1;
  const active = activeIdx >= 0 ? files[activeIdx] : null;
  const workspaceRoot = sessionWorkspaceRoot(session);
  const activeTarget = active && diff?.ok
    ? diffFileOpenTarget(active, diff.repoRoot, sessionWorkspaceRoot(session))
    : null;
  const { bindings } = useKeybindings();

  // The Files path each changed file's comments live on, in list order - what the list marks
  // and what the review queue looks a comment's file up by. See `diffFileCommentPath`.
  const commentPaths = useMemo(
    () => files.map((file) => diff?.ok
      ? diffFileCommentPath(file, diffFileOpenTarget(file, diff.repoRoot, workspaceRoot), commit)
      : null),
    [commit, diff, files, workspaceRoot],
  );
  const commentSummaries = useMemo(
    () => fileCommentSummaries(fileCommentThreads, session.id),
    [fileCommentThreads, session.id],
  );
  const review = useFileCommentReview(session.id, fileCommentThreads, fileCommentReviews);

  // Line comments on the file being read. Only a working-tree diff anchors to the file the
  // Files tab holds, so a single-commit diff, a binary and a file with no Files route never
  // read a document at all - `diffCommentBlockReason` says why each takes no comment.
  const commentPath = activeIdx >= 0 ? commentPaths[activeIdx] ?? null : null;
  const source = useDiffSourceDocument(session.id, commentPath, diff);
  const comments = useDiffLineComments({
    session,
    path: commentPath,
    rows: active && !active.binary ? active.lines : null,
    source,
    blockReason: active && activeTarget
      ? diffCommentBlockReason({
        file: active,
        target: activeTarget,
        commit,
        document: source.document,
        documentError: source.error,
      })
      : "There is no file to comment on",
    threads: fileCommentThreads,
    review,
  });
  /**
   * Take the reader to a queued comment: to its file in this diff, where the thread opens; or,
   * for a file this diff does not hold, to the Files tab, which holds every file.
   */
  const openThread = comments.onOpenThread;
  const setReviewError = review.setError;
  const openQueued = useCallback((thread: FileCommentThread): void => {
    setReviewError(null);
    const index = commentPaths.indexOf(thread.path);
    if (index < 0) {
      onOpenInFiles?.(thread.path);
      return;
    }
    setSelected(index);
    openThread(thread);
  }, [commentPaths, onOpenInFiles, openThread, setReviewError]);
  const toggleCommentMode = comments.onToggleMode;
  const commentModeAvailable = comments.blockReason === null && !comments.readOnly;
  // Sending or discarding a comment unmounts the box that held focus, which drops it on
  // the document body - and this reader's keys answer only inside it. Hand focus back so
  // the next arrow or `m` works without a click, but never take it from somewhere the
  // reader moved it on purpose.
  const panelOpen = comments.panelLine !== null;
  useEffect(() => {
    if (panelOpen) return;
    const focused = document.activeElement;
    if (focused === null || focused === document.body) {
      contentRef.current?.focus({ preventScroll: true });
    }
  }, [panelOpen]);

  // File navigation is this reader's own: ↑/↓ and j/k walk the list without leaving the
  // keyboard. The inline reader attaches it to its focusable region, keeping those keys
  // scoped to the embedded reader instead of changing the Console or Board selection.
  const onViewerKey = useCallback(
    (e: KeyboardEvent) => {
      // A comment's composer and reply box live inside this region, so their keystrokes
      // bubble here. Typing a `j` into a comment must type a `j`, not change the file.
      if (isTypingTarget(e.target)) return;
      if (chordFromEvent(e) === bindings.openDiffFile) {
        if (activeTarget?.path && onOpenInFiles) {
          e.preventDefault();
          onOpenInFiles(activeTarget.path);
        }
        return;
      }
      // Comment mode answers to `m` here as it does in the Files tab.
      if (e.key === "m" && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        if (commentModeAvailable) {
          e.preventDefault();
          toggleCommentMode();
        }
        return;
      }
      const next = e.key === "ArrowDown" || e.key === "j";
      const previous = e.key === "ArrowUp" || e.key === "k";
      if (!next && !previous) return;
      e.preventDefault();
      if (files.length === 0) return;
      if (next) {
        setSelected((i) => Math.min(files.length - 1, i + 1));
      } else {
        setSelected((i) => Math.max(0, i - 1));
      }
    },
    [
      activeTarget?.path,
      bindings.openDiffFile,
      commentModeAvailable,
      files.length,
      onOpenInFiles,
      toggleCommentMode,
    ],
  );
  // Keep the picked file visible in the list, and show its diff from the top.
  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: "nearest" });
    if (detailRef.current) detailRef.current.scrollTop = 0;
  }, [activeIdx]);

  return (
    <div
      ref={contentRef}
      className="diff-viewer-content diff-viewer-inline"
      role="region"
      aria-label="Session diff"
      tabIndex={-1}
      onKeyDown={(e) => onViewerKey(e.nativeEvent)}
    >
      <header className="diff-head">
        <div className="diff-title">
          {/* A commit diff is ONE commit, so it must not borrow the range
              wording below: "<branch> vs <base>" would read as everything since
              that parent, which is the larger diff and the wrong one. */}
          {loading ? (
            <span className="diff-sub mono">loading diff scope</span>
          ) : diff && !diff.ok ? (
            <span className="diff-sub mono">diff scope unavailable</span>
          ) : commit ? (
            // Not `.branch`: that prepends a ⌥ branch glyph, and this is a commit.
            <span className="diff-sub mono">
              fix <span className="diff-sha">{diff?.headSha ?? commit}</span>
            </span>
          ) : diff?.branch && diff.base && diff.branch !== diff.base ? (
            <span className="diff-sub mono">
              <span className="branch">{diff.branch}</span> vs{" "}
              <span className="branch">{diff.base}</span>
            </span>
          ) : diff?.base ? (
            <span className="diff-sub mono">
              working tree vs <span className="branch">{diff.base}</span>
            </span>
          ) : (
            <span className="diff-sub mono">uncommitted changes</span>
          )}
          {diff?.ok && (
            <span className="diff-stat">
              {diff.filesChanged} {diff.filesChanged === 1 ? "file" : "files"}
              <span className="diff-add"> +{diff.insertions}</span>
              <span className="diff-del"> −{diff.deletions}</span>
            </span>
          )}
        </div>
      </header>

      <div className="diff-body" ref={bodyRef}>
        {loading && <p className="diff-empty">Loading diff…</p>}
        {!loading && diff && !diff.ok && (
          <p className="diff-empty">Couldn't load a diff: {diff.error ?? "unknown error"}.</p>
        )}
        {/* An empty fix commit is a real thing to open, and "against <branch>"
            is the wrong frame for one commit - it has no base branch, only a parent. */}
        {!loading && diff?.ok && files.length === 0 && (
          <p className="diff-empty">
            {commit
              ? "No changes in this commit."
              : `No changes against ${diff.base ?? "the source branch"}.`}
          </p>
        )}
        {!loading && diff?.ok && files.length > 0 && (
          <>
            <nav ref={fileListRef} className="diff-filelist" aria-label="Changed files">
              {files.map((f, i) => {
                const commentsOn = commentPaths[i];
                return (
                  <FileItem
                    key={`${f.path}-${i}`}
                    file={f}
                    active={i === activeIdx}
                    comments={commentsOn ? commentSummaries.get(commentsOn) : undefined}
                    ref={i === activeIdx ? activeItemRef : undefined}
                    onSelect={() => setSelected(i)}
                  />
                );
              })}
              {diff.truncated && (
                <p className="diff-trunc">
                  Diff truncated for size - some files may be missing. The header stats are complete.
                </p>
              )}
            </nav>
            <ResizablePaneDivider
              containerRef={bodyRef}
              leadingPaneRef={fileListRef}
              label="Resize changed files list"
              widthProperty="--diff-file-list-width"
            />
            <div className="diff-detail">
              {active && activeTarget && (
                <FileDiff
                  file={active}
                  target={activeTarget}
                  onOpenInFiles={onOpenInFiles}
                  comments={comments}
                  review={review}
                  scrollRef={detailRef}
                />
              )}
              {review.showQueue && (
                <FileCommentReviewPanel review={review} onOpen={openQueued} />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * One row in the left-hand file list: status, path (basename kept visible), the comments it
 * carries, stats.
 */
const FileItem = ({
  file,
  active,
  comments,
  onSelect,
  ref,
}: {
  file: DiffFile;
  active: boolean;
  comments: FileCommentSummary | undefined;
  onSelect: () => void;
  ref?: React.Ref<HTMLButtonElement>;
}): React.JSX.Element => {
  const { dir, name } = splitPath(file.path);
  return (
    <Tooltip label={`${STATUS_LABEL[file.status]} · ${file.path}`}>
    <button
      ref={ref}
      className={`diff-fileitem${active ? " active" : ""}`}
      onClick={onSelect}
      aria-current={active}
    >
      <span className={`diff-file-dot status-${file.status}`} aria-hidden>
        {STATUS_INITIAL[file.status]}
      </span>
      <span className="diff-fileitem-path mono">
        <span className="fp-name">{name}</span>
        {dir && <span className="fp-dir">{dir}</span>}
      </span>
      <FileCommentBadge summary={comments} />
      <span className="diff-fileitem-stat">
        {file.added > 0 && <span className="diff-add">+{file.added}</span>}
        {file.removed > 0 && <span className="diff-del">−{file.removed}</span>}
      </span>
    </button>
    </Tooltip>
  );
};

/**
 * The detail pane: the selected file's full path header plus its numbered diff.
 *
 * Only the diff scrolls. The header - and with it Comment, Comments and Open in Files - stays
 * where it is however far down the file the reader is, as the Files toolbar does, and so do a
 * docked thread and the Comments index beside the diff.
 */
function FileDiff({
  file,
  target,
  onOpenInFiles,
  comments,
  review,
  scrollRef,
}: {
  file: DiffFile;
  target: DiffFileTarget;
  onOpenInFiles?: (path: string) => void;
  comments: DiffFileComments;
  review: FileCommentReviewState;
  scrollRef: React.Ref<HTMLDivElement>;
}): React.JSX.Element {
  const showIndex = comments.showIndex && comments.indexBlockReason === null;
  return (
    <section className={`diff-file${showIndex ? " has-comment-rail" : ""}`}>
      <div className="diff-file-head">
        <span className={`diff-file-status status-${file.status}`}>{STATUS_LABEL[file.status]}</span>
        <Tooltip label={file.path}>
          <span className="diff-file-path mono">{file.path}</span>
        </Tooltip>
        <span className="diff-file-stat">
          {file.added > 0 && <span className="diff-add">+{file.added}</span>}
          {file.removed > 0 && <span className="diff-del">−{file.removed}</span>}
        </span>
        <FileCommentControls
          mode={comments.readOnly
            ? null
            : {
              active: comments.active,
              blockReason: comments.blockReason,
              label: "Comment on a line: click a line number",
              shortcut: true,
              onToggle: comments.onToggleMode,
            }}
          index={{
            count: comments.threads.length,
            expanded: showIndex,
            blockReason: comments.indexBlockReason,
            onToggle: comments.onToggleIndex,
          }}
          review={review}
          resolved={{
            count: comments.resolvedCount,
            shown: comments.showResolved,
            onToggle: comments.onToggleResolved,
          }}
        />
        {/* Rendered for EVERY file, including the ones it cannot act on: a control that
            vanishes on some files teaches that the diff sometimes has no route to the
            Files tab, when the real answer is that this one file has none and here is
            why. `aria-disabled` rather than `disabled` keeps it focusable, which is the
            only way the reason reaches the keyboard and the accessibility tree. */}
        {onOpenInFiles && (
          <Tooltip label={target.reason ?? `Open ${file.path} in the Files tab`}>
            <button
              className="diff-open-file"
              aria-disabled={target.path === null}
              onClick={() => {
                if (target.path) onOpenInFiles(target.path);
              }}
            >
              <Keycap action="openDiffFile" />
              Open in Files
              <span className="diff-open-file-glyph" aria-hidden>
                ↗
              </span>
            </button>
          </Tooltip>
        )}
      </div>
      {/* A comment refusal with no panel to carry it, as the Files tab shows one. */}
      {comments.notice && (
        <div className="file-notice">
          <span>{comments.notice}</span>
          <Tooltip label="Dismiss this comment error">
            <button className="btn" onClick={comments.onDismissNotice}>Dismiss</button>
          </Tooltip>
        </div>
      )}
      <div className="diff-file-shell">
        <div className="diff-file-main">
          {comments.panelDocked && comments.panelLine !== null && (
            <div className="diff-comment-dock">
              <p className="diff-comment-dock-note">
                Line {comments.panelLine} is not part of this diff.
              </p>
              {comments.panel}
            </div>
          )}
          <div className="diff-file-scroll" ref={scrollRef}>
            {file.binary ? (
              <p className="diff-binary">Binary file</p>
            ) : (
              <DiffLines lines={file.lines} comments={comments} />
            )}
          </div>
        </div>
        {showIndex && (
          <FileCommentRail
            path={target.path ?? file.path}
            threads={comments.threads}
            selectedId={comments.openThreadId}
            onOpen={comments.onOpenThread}
            onClose={comments.onToggleIndex}
          />
        )}
      </div>
    </section>
  );
}

/** Split a path into its directory (no trailing slash) and basename. */
function splitPath(p: string): { dir: string; name: string } {
  const i = p.lastIndexOf("/");
  return i === -1 ? { dir: "", name: p } : { dir: p.slice(0, i), name: p.slice(i + 1) };
}

const STATUS_LABEL: Record<DiffFile["status"], string> = {
  added: "added",
  deleted: "deleted",
  renamed: "renamed",
  modified: "modified",
};

const STATUS_INITIAL: Record<DiffFile["status"], string> = {
  added: "A",
  deleted: "D",
  renamed: "R",
  modified: "M",
};
