import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { FileCommentReview, FileCommentThread, Session } from "@shared/types.ts";
import type { OpenTargetId } from "@shared/open-targets.ts";
import {
  hasUnwrittenEdits,
  isSavePending,
  type FileBuffer,
  type SessionFilesController,
} from "../lib/sessionFiles.ts";
import { FileEditor, type FileEditorComments } from "./FileEditor.tsx";
import { FileCommentComposer, FileCommentThreadCard } from "./FileCommentThread.tsx";
import { FileCommentRail } from "./FileCommentRail.tsx";
import { useFileCommentDraft } from "../lib/fileCommentDraft.ts";
import {
  isCommentableDocument,
  markerLabel,
  markerTone,
  outstandingThread,
  reviewQueue,
  threadsByLine,
  threadsForFile,
} from "../lib/fileComments.ts";
import { FileCommentQueue } from "./FileCommentQueue.tsx";
import {
  appendFileCommentMessage,
  controlFileCommentReview,
  deleteFileComment,
  editFileCommentMessage,
  markFileCommentRead,
  reorderFileComments,
  resolveHtmlBlockAnchor,
  resolveHtmlBlockTarget,
  setFileCommentStatus,
} from "../lib/api.ts";
import { boundQuote, reanchor, sliceLines } from "@shared/file-comment-anchor.ts";
import type { HtmlBlockPathStep } from "@shared/protocol.ts";
import { Markdown, type MarkdownBlockRange } from "./Markdown.tsx";
import { FILES_DIAGRAM_RENDERERS } from "./markdownDiagramRegistry.tsx";
import { OpenInMenu } from "./OpenInMenu.tsx";
import { api } from "../lib/api.ts";
import { COPY_FEEDBACK_LABEL, useCopyFeedback } from "../lib/clipboard.ts";
import { isTypingTarget, useKeybindingHints } from "../lib/keybindings.ts";
import { workspaceAssetPath } from "../lib/workspaceLinks.ts";
// The sandboxed HTML preview boundary is SHARED with Scouts and lives in one module, so
// neither surface can quietly weaken the CSP or the sandbox for its own documents.
import {
  HTML_PREVIEW_BLOCK_MESSAGE,
  HTML_PREVIEW_COMMENT_MESSAGE,
  HTML_PREVIEW_LINK_MESSAGE,
  HTML_PREVIEW_KEYBOARD_MESSAGE,
  HTML_PREVIEW_READY_MESSAGE,
  HTML_PREVIEW_SANDBOX,
  HTML_PREVIEW_SCROLL_MESSAGE,
  HTML_PREVIEW_TARGET_MESSAGE,
  htmlPreviewSource,
  inlinePreviewStyles,
} from "../lib/htmlPreview.ts";
import { Tooltip } from "./Tooltip.tsx";

function SaveStatus({ buffer }: { buffer: FileBuffer }): React.JSX.Element {
  const labels: Record<FileBuffer["saveState"], string> = {
    saved: "Saved", modified: "Modified", saving: "Saving…", offline: "Offline",
    failed: "Save failed", conflict: "Conflict", readonly: "Read only",
  };
  return <span className={`file-save-state is-${buffer.saveState}`}>{labels[buffer.saveState]}</span>;
}

export interface FileWorkspaceHandle {
  /** Claim a vertical arrow for preview navigation or scroll the focused file reader. */
  handleArrow: (direction: -1 | 1, fromReader: boolean) => boolean;
  /** Move keyboard focus from the file selection into the rendered preview. */
  focusPreview: () => boolean;
  /** Return keyboard focus from the rendered preview to the selected file. */
  focusFileList: () => boolean;
}

type FileReaderScrollDistance = "arrow" | "page";

interface FileThreadError {
  message: string;
  /** True only when re-reading the selected file is the remedy the daemon prescribed. */
  refreshable: boolean;
}

function scrollElement(
  element: HTMLElement,
  direction: -1 | 1,
  distance: FileReaderScrollDistance,
): void {
  const top = distance === "page"
    ? element.clientHeight
    : Math.max(80, element.clientHeight * 0.18);
  element.scrollBy({ top: direction * top });
}

export function scrollActiveFileReader(
  root: ParentNode,
  direction: -1 | 1,
  distance: FileReaderScrollDistance = "arrow",
): boolean {
  const contentReaders = root.querySelectorAll<HTMLElement>(
    ".file-content .cm-scroller, .file-content .file-markdown-preview, .file-content .file-image-preview, .file-content .file-compare pre",
  );
  if (contentReaders.length > 0) {
    contentReaders.forEach((element) => scrollElement(element, direction, distance));
    return true;
  }
  const preview = root.querySelector<HTMLIFrameElement>(".file-content .html-preview");
  if (preview?.contentWindow) {
    preview.contentWindow.postMessage({
      type: HTML_PREVIEW_SCROLL_MESSAGE,
      top: direction * (distance === "page"
        ? preview.clientHeight
        : Math.max(80, preview.clientHeight * 0.18)),
    }, "*");
    return true;
  }
  const list = root.querySelector<HTMLElement>(".file-list");
  if (!list) return false;
  scrollElement(list, direction, distance);
  return true;
}

export function adjacentFilePath(
  paths: readonly string[],
  selectedPath: string | null,
  direction: -1 | 1,
): string | null {
  const index = selectedPath === null ? -1 : paths.indexOf(selectedPath);
  if (index < 0) return paths[0] ?? null;
  return paths[index + direction] ?? null;
}

function previewReader(root: ParentNode): HTMLElement | null {
  return root.querySelector<HTMLElement>(
    ".file-content .html-preview, .file-content .file-markdown-preview, .file-content .file-image-preview",
  );
}

function previewHasFocus(preview: HTMLElement): boolean {
  const active = document.activeElement;
  return active === preview || (active instanceof HTMLElement && preview.contains(active));
}

function focusCurrentFileRow(root: ParentNode): boolean {
  const row = root.querySelector<HTMLButtonElement>('.file-row[aria-selected="true"]');
  if (!row) return false;
  row.focus({ preventScroll: true });
  row.scrollIntoView({ block: "nearest" });
  return true;
}

export function FileWorkspace({
  session,
  controller,
  fileCommentThreads = [],
  fileCommentReviews = [],
  fileLineRequest = null,
  onExtract,
  extracted = false,
  isOverlayOpen,
  ref,
}: {
  session: Session;
  controller: SessionFilesController;
  /**
   * Every live comment thread the event stream holds, for every session.
   *
   * The whole list rather than this session's, because the filter is a pure function of
   * the model and the two live `FileWorkspace` instances - the integrated tab and the
   * extracted window - would otherwise each need their own narrowing to be kept in step.
   * There is no fetch here on purpose: the snapshot and the two `file_comment_thread_*`
   * frames are the entire read path, so a poll would be a second answer that drifts.
   */
  fileCommentThreads?: readonly FileCommentThread[];
  /**
   * Every session's walkthrough run state, narrowed here for `fileCommentThreads`' reason.
   *
   * Needed as its own fact rather than derived from the threads: "paused" and "never started"
   * are the same set of threads, and between two comments the outstanding set is briefly
   * empty, so a derived "running" would flicker on every advance.
   */
  fileCommentReviews?: readonly FileCommentReview[];
  /** A source line the reader deep-linked to. See `FileEditor`'s `scrollTo` for the nonce. */
  fileLineRequest?: { sessionId: string; path: string; line: number; nonce: number } | null;
  onExtract?: () => void;
  extracted?: boolean;
  isOverlayOpen?: () => boolean;
  ref?: React.Ref<FileWorkspaceHandle>;
}): React.JSX.Element {
  const workspaceRef = useRef<HTMLElement>(null);
  const state = controller.sessions[session.id];
  const [filter, setFilter] = useState("");
  const [manualPath, setManualPath] = useState("");
  const [comparing, setComparing] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [pendingOpen, setPendingOpen] = useState<{ path: string; target: OpenTargetId } | null>(null);
  const focusSelectedFile = useRef(false);
  /** A thread to open once the selection has landed on the file it belongs to. */
  const pendingThreadOpen = useRef<string | null>(null);
  const [showKeybindingHints] = useKeybindingHints();

  useEffect(() => controller.ensure(session.id), [controller.ensure, session.id]);
  useEffect(
    () => () => controller.flush(session.id),
    [controller.flush, session.id],
  );
  const files = state?.files ?? [];
  const selectedPath = state?.selectedPath ?? null;
  const buffer = selectedPath ? state?.buffers[selectedPath] : null;
  const mode = state?.mode ?? "preview";
  const previewable = buffer?.document.kind === "html"
    || buffer?.document.kind === "markdown"
    || buffer?.document.kind === "image";
  /**
   * Whether this document has lines a comment can point at.
   *
   * Deliberately its own predicate and not `previewable`, which answers a different
   * question and includes `image` - see `isCommentableDocument`.
   */
  const commentable = buffer ? isCommentableDocument(buffer.document) : false;
  const [commentMode, setCommentMode] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const [showComments, setShowComments] = useState(false);
  const [showQueue, setShowQueue] = useState(false);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);
  const [threadBusy, setThreadBusy] = useState(false);
  const [threadError, setThreadErrorState] = useState<FileThreadError | null>(null);
  const setThreadError = useCallback((message: string | null, refreshable = false): void => {
    setThreadErrorState(message === null ? null : { message, refreshable });
  }, []);
  const [threadJump, setThreadJump] = useState<{
    id: string;
    line: number;
    nonce: number;
  } | null>(null);
  const [htmlTarget, setHtmlTarget] = useState<{
    blockPath: HtmlBlockPathStep[];
    nonce: number;
  } | null>(null);
  const jumpNonce = useRef(0);
  const draft = useFileCommentDraft({
    sessionId: session.id,
    path: selectedPath,
    revision: buffer?.document.revision ?? null,
    // A write that failed after its composer closed has nowhere else to be seen. This is the
    // same notice a refused anchor uses, and it renders whenever no panel is open.
    onDetachedError: setThreadError,
  });
  /**
   * Whether the source is already the surface on screen - a plain file, or Editor chosen.
   */
  const sourceShowing = buffer?.document.text != null && (!previewable || mode === "editor");
  /**
   * Comment mode is on whenever the reader asked for it on a file that has lines.
   *
   * It does NOT require the Editor. Comment mode used to switch a rendered document over to
   * source, which answered "where do comments live" by taking away the thing the reader was
   * reading - and a person reading a rendered plan is exactly the person with something to
   * say about line 84.
   */
  const commentsActive = commentMode && commentable && !comparing;
  /**
   * Whether the panel Comment mode opens is docked OVER the rendered document.
   *
   * It used to be a read-only source column BESIDE it, taking 48% of the pane, and the
   * reasoning was sound as far as it went: a comment anchors to source lines and a quote, so
   * the reader should be able to see the lines their comment names. What that reasoning
   * missed is that the composer already prints both - the range in its header and the source
   * slice beside it - so the column was showing a second copy of what the panel was about to
   * say, and charging half the preview for it.
   *
   * It also could not survive a real document. The panel is drawn at its anchored line, and
   * CodeMirror builds DOM only for its rendered viewport; a generated report puts its first
   * rendered block a couple of hundred lines down, past an inline stylesheet, so the composer
   * was created outside the viewport, never attached, and its own `focus()` ran against a
   * detached node. Nothing appeared and nothing said why. Docking the panel over the preview
   * removes that failure by construction rather than by scrolling a column to chase it.
   *
   * A comment in Preview still starts on the RENDERED document - hover a paragraph, heading,
   * table, code block or diagram and its own control appears - and still resolves to source
   * lines. Only where the panel lands has changed.
   *
   * Not an `<Overlay>` and not a `role="dialog"`, deliberately. See `FileCommentThread.tsx`'s
   * header: this panel must not cover the app, trap focus, or stand App's global shortcuts
   * down, because the reader is meant to keep reading the document while writing about it.
   */
  const commentOverlayShowing = commentsActive && !sourceShowing && buffer?.document.text != null;
  const enterCommentMode = useCallback(() => {
    if (!commentable) return;
    setCommentMode(true);
  }, [commentable]);
  useEffect(() => {
    if (extracted) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (
        event.altKey
        || event.ctrlKey
        || event.metaKey
        || event.shiftKey
        || (
          event.key !== "e"
          && event.key !== "p"
          && event.key !== "m"
          && event.key !== "u"
          && event.key !== "d"
        )
      ) return;
      if (
        isTypingTarget(event.target)
        || isOverlayOpen?.() === true
      ) return;
      const editorAvailable = previewable && buffer?.document.editable === true;
      if ((event.key === "p" && !previewable) || (event.key === "e" && !editorAvailable)) return;
      if (event.key === "m" && !commentable) return;
      const pageDirection = event.key === "u" ? -1 : event.key === "d" ? 1 : null;
      if (pageDirection !== null && (!previewable || mode !== "preview")) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      if (pageDirection !== null) {
        const root = workspaceRef.current;
        if (root) scrollActiveFileReader(root, pageDirection, "page");
      } else if (event.key === "m") {
        if (commentsActive) setCommentMode(false);
        else enterCommentMode();
      } else if (event.key === "p") {
        controller.setMode(session.id, "preview");
      } else {
        controller.setMode(session.id, "editor");
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [
    buffer?.document.editable,
    commentable,
    commentsActive,
    controller.setMode,
    enterCommentMode,
    extracted,
    isOverlayOpen,
    mode,
    previewable,
    session.id,
  ]);
  /*
   * The conflict notice's "Copy local".
   *
   * It called `navigator.clipboard.writeText` behind a `void` and rendered nothing either way,
   * so the one moment a reader most needs to know their text is safe - the file changed under
   * them and they are about to discard or overwrite - was the moment the control said least.
   * Through `copyText` now, and it confirms and reports like every other copy in the app.
   *
   * Keyed to THE CONFLICT, not to the file, because this component never remounts and a
   * refusal arms no hold to expire - so that red sentence has whatever lifetime this key gives
   * it and no other. The file alone is too coarse in both directions: it leaves a refusal
   * standing after Reload disk or Overwrite disk has settled the conflict it was about, and it
   * puts that same stale sentence back on screen the instant a LATER edit reopens a conflict on
   * the same file, before the reader has attempted anything. Resolving to `selectedPath` while
   * there is no conflict is what makes both transitions a change.
   *
   * The path goes last so that a path containing the separator cannot shift the fields before
   * it; revision and the deleted flag never contain one.
   */
  const conflict = buffer?.conflict ?? null;
  const copyLocal = useCopyFeedback({
    resetOn: conflict
      ? `${conflict.revision ?? "none"}:${conflict.deleted ? "gone" : "changed"}:${selectedPath ?? ""}`
      : selectedPath,
  });
  /**
   * The last debounced/stylesheet-inlined rendering, including the file it belongs to.
   *
   * The path is load-bearing. A newly mounted workspace can already have its selected
   * buffer in the shared controller, while this component-local preparation starts empty.
   * Rendering that empty string made the iframe white until the debounce and every local
   * stylesheet read completed. A different path therefore falls back to the selected
   * buffer's raw HTML immediately; once preparation lands, it replaces the same document
   * with its inlined form. Edits to the SAME path keep the prepared copy for the existing
   * 180 ms debounce instead of reloading the iframe on every keystroke.
   */
  const [preparedPreview, setPreparedPreview] = useState<{
    path: string;
    text: string;
    revision: string | null;
  } | null>(null);
  const prepared = buffer && preparedPreview?.path === buffer.document.path
    ? preparedPreview
    : null;
  const previewText = prepared ? prepared.text : (buffer?.text ?? "");
  /**
   * The revision `previewText` was taken from, which is NOT always the buffer's.
   *
   * The preparation above is debounced, so during that window the live buffer has moved on
   * and the reader is still looking at the older render. A comment anchored to that render
   * has to be stamped with the revision it was actually sliced from: `reanchor()` skips the
   * quote search entirely when the revisions match, so pairing an older quote with the newer
   * revision would assert the text is still where it was without ever checking.
   */
  const previewRevision = prepared ? prepared.revision : (buffer?.document.revision ?? null);
  const imageSource = useMemo(() => {
    if (mode !== "preview" || buffer?.document.kind !== "image") return null;
    return buffer.document.image?.mediaType === "image/svg+xml" && buffer.document.text !== null
      ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(buffer.text)}`
      : (buffer.document.image?.dataUrl ?? null);
  }, [buffer, mode]);
  useEffect(() => {
    let live = true;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      const text = buffer?.text ?? "";
      const path = buffer?.document.path ?? "";
      const revision = buffer?.document.revision ?? null;
      if (buffer?.document.kind !== "html") {
        setPreparedPreview({ path, text, revision });
        return;
      }
      void inlinePreviewStyles(text, buffer.document.path, async (assetPath) => {
        const result = await api.readFile(session.id, assetPath, abort.signal);
        return result.ok ? result.file.text : null;
      }, abort.signal).then((next) => {
        if (live) setPreparedPreview({ path, text: next, revision });
      });
    }, 180);
    return () => {
      live = false;
      abort.abort();
      clearTimeout(timer);
    };
  }, [
    buffer?.document.kind,
    buffer?.document.path,
    buffer?.document.revision,
    buffer?.text,
    session.id,
  ]);
  /**
   * The receiving half of PREVIEW_LINK_SCRIPT: a click inside the sandbox arrives here
   * as an href, and either names a checkout file - which gets selected, exactly as a
   * Markdown preview link would - or it does not, and nothing happens. There is no
   * "let the browser have it" branch on purpose: the iframe has already cancelled the
   * navigation by the time this runs, because it cannot know what the parent will claim,
   * and un-cancelling is not a thing. An unclaimed link being inert IS the designed
   * outcome - the alternative was the SPA fallback rendering a white pane.
   *
   * `event.source` is matched against THIS workspace's iframe, so a fleet of open
   * previews (the extracted files window renders a second FileWorkspace) cannot act on
   * each other's clicks, and nothing else that posts messages can act on this one.
   */
  const previewPath = buffer?.document.kind === "html" ? buffer.document.path : null;
  useEffect(() => {
    if (!previewPath) return;
    const onMessage = (event: MessageEvent): void => {
      const data = event.data as { type?: unknown; href?: unknown } | null;
      if (data?.type !== HTML_PREVIEW_LINK_MESSAGE || typeof data.href !== "string") return;
      const frame = workspaceRef.current?.querySelector<HTMLIFrameElement>(
        ".file-content .html-preview",
      );
      if (!frame || event.source !== frame.contentWindow) return;
      const path = workspaceAssetPath(data.href, previewPath);
      if (!path) return;
      void controller.probe(session.id, path).then((exists) => {
        if (exists) controller.select(session.id, path);
      });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [controller.probe, controller.select, previewPath, session.id]);
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? files.filter((file) => file.path.toLowerCase().includes(q)) : files;
  }, [files, filter]);

  /*
   * The durable row keeps a thread's identity; the selected file's current bytes decide
   * where it is drawn. Delivery re-anchors queued comments on the daemon, but an answered
   * thread can outlive an edit above its quote without entering that path again. Deriving
   * its display anchor here keeps the marker and Preview click on the same current line,
   * while the next human reply still uses the existing thread id and lets the daemon persist
   * the move before delivery. The document revision keeps unchanged files on the cheap path;
   * a newly loaded revision triggers the same bounded quote search the daemon uses.
   */
  const allFileThreads = useMemo(() => {
    const threads = threadsForFile(fileCommentThreads, session.id, selectedPath, true);
    if (!buffer || buffer.document.text === null) return threads;
    const revision = buffer.document.revision;
    return threads.map((thread) => {
      const outcome = reanchor(thread, buffer.text, revision);
      if (outcome.kind === "outdated") {
        return thread.outdated ? thread : { ...thread, outdated: true };
      }
      if (
        thread.startLine === outcome.startLine
        && thread.endLine === outcome.endLine
        && thread.revision === outcome.revision
        && thread.outdated === false
      ) return thread;
      return {
        ...thread,
        startLine: outcome.startLine,
        endLine: outcome.endLine,
        revision: outcome.revision,
        outdated: false,
      };
    });
  }, [
    buffer,
    fileCommentThreads,
    selectedPath,
    session.id,
  ]);
  const fileThreads = useMemo(
    () => showResolved
      ? allFileThreads
      : allFileThreads.filter((thread) => thread.status !== "resolved"),
    [allFileThreads, showResolved],
  );
  const allThreadLines = useMemo(() => threadsByLine(allFileThreads), [allFileThreads]);
  const threadLines = useMemo(() => threadsByLine(fileThreads), [fileThreads]);
  const resolvedCount = allFileThreads.filter((thread) => thread.status === "resolved").length;
  const openThread = allFileThreads.find((thread) => thread.id === openThreadId) ?? null;

  /*
   * Reading a thread is what clears its pip.
   *
   * Durable rather than local, because the badge is durable: the integrated Files tab and the
   * extracted Files window are two instances that converge only through the daemon, so a read
   * recorded in one has to be a read in the other. The guard is the loop's terminator as well
   * as its economy - the write comes back as an upsert with `readAt` stamped, so the next run
   * of this effect finds nothing unread and posts nothing.
   */
  useEffect(() => {
    if (!openThread) return;
    const unread = openThread.messages.some((m) => m.author === "agent" && m.readAt === null);
    if (!unread) return;
    void markFileCommentRead(openThread.id);
  }, [openThread]);

  // ---- the review queue ----
  const queue = useMemo(
    () => reviewQueue(fileCommentThreads, session.id),
    [fileCommentThreads, session.id],
  );
  const review = useMemo(
    () => fileCommentReviews.find((r) => r.sessionId === session.id) ?? null,
    [fileCommentReviews, session.id],
  );
  /*
   * The queue opens itself when a review starts, and never closes itself again.
   *
   * Opening is what makes "Start review" show its own effect - the comment that just went is
   * at the head of a list the reader can now steer. Closing on `running` going false would be
   * the wrong half of the pair: a review PAUSES because something needs a person, and taking
   * the panel away at exactly that moment hides the reason and the controls together.
   */
  const running = review?.state === "running";
  useEffect(() => {
    if (running) setShowQueue(true);
  }, [running]);

  const controlReview = useCallback(async (
    action: "start" | "pause" | "dismiss",
  ): Promise<void> => {
    setReviewBusy(true);
    const result = await controlFileCommentReview(session.id, action);
    setReviewBusy(false);
    setReviewError(result.ok ? null : result.error);
  }, [session.id]);

  /**
   * Move one comment one place, by rewriting the whole order.
   *
   * The reorder route takes a list rather than a delta on purpose - it rewrites `queue_seq`
   * in two passes so nothing reads a half-applied order - so a one-place move is expressed as
   * the list it produces. The swap happens here, against the order currently on screen, which
   * is the order the reader is looking at.
   */
  const moveInQueue = useCallback(async (threadId: string, direction: -1 | 1): Promise<void> => {
    const order = queue.map((thread) => thread.id);
    const at = order.indexOf(threadId);
    const to = at + direction;
    if (at < 0 || to < 0 || to >= order.length) return;
    [order[at], order[to]] = [order[to]!, order[at]!];
    setReviewBusy(true);
    const result = await reorderFileComments(session.id, order);
    setReviewBusy(false);
    setReviewError(result.ok ? null : result.error);
  }, [queue, session.id]);

  const editQueued = useCallback(async (messageId: string, body: string): Promise<boolean> => {
    setReviewBusy(true);
    const result = await editFileCommentMessage(messageId, body);
    setReviewBusy(false);
    setReviewError(result.ok ? null : result.error);
    return result.ok;
  }, []);

  const dropFromQueue = useCallback(async (threadId: string): Promise<void> => {
    setReviewBusy(true);
    const result = await deleteFileComment(threadId);
    setReviewBusy(false);
    setReviewError(result.ok ? null : result.error);
    if (result.ok && openThreadId === threadId) setOpenThreadId(null);
  }, [openThreadId]);

  /** Take the reader to a queued comment, in the file it is about. */
  /*
   * Where the viewer should be looking, from the two things that can ask.
   *
   * A deep link (`plan.md:84`), and the walkthrough moving the reader to the comment it just
   * sent. Both are one-shot requests carrying their own nonce, and both are answered by the
   * same effect in `FileEditor`, which reads the line off the live document rather than
   * remembering a position - the view is destroyed outright on a path change, so a remembered
   * one would be wrong exactly when it was needed.
   *
   * The outstanding comment wins when both are live, because it is the more recent request by
   * construction: a deep link is a click that already happened, and the walkthrough only asks
   * when a comment has actually gone out.
   */
  const outstanding = useMemo(() => outstandingThread(queue), [queue]);
  const [followedOutstanding, setFollowedOutstanding] = useState<{ id: string; nonce: number } | null>(null);
  /**
   * The comment that just went out, followed ONCE - including into another file.
   *
   * A review spans every file the session holds comments on, so the comment that just went out
   * is frequently not in the one being looked at. Producing a scroll request only when the
   * path already matched left the reader parked on the previous file with no sign that anything
   * had happened, which is not what "takes you to each comment as it goes out" says.
   * Selecting the path is the same move `openQueued` makes for a click, and the scroll request
   * lands afterwards against the rebuilt view.
   *
   * Once, by id, and that is the point of the ref: `selectedPath` is a dependency, so this
   * re-runs when the reader navigates. Without the guard it would drag them straight back to
   * the outstanding comment's file every time they tried to look at anything else for as long
   * as that comment was out.
   */
  const followedId = useRef<string | null>(null);
  useEffect(() => {
    if (!outstanding || followedId.current === outstanding.id) return;
    followedId.current = outstanding.id;
    setFollowedOutstanding((prev) => ({ id: outstanding.id, nonce: (prev?.nonce ?? 0) + 1 }));
    if (outstanding.path !== selectedPath) controller.select(session.id, outstanding.path);
  }, [controller, outstanding, selectedPath, session.id]);
  const scrollTo = useMemo(() => {
    if (threadJump) return { line: threadJump.line, nonce: threadJump.nonce };
    if (
      outstanding
      && followedOutstanding?.id === outstanding.id
      && outstanding.path === selectedPath
    ) {
      return { line: outstanding.startLine, nonce: followedOutstanding.nonce };
    }
    if (
      fileLineRequest
      && fileLineRequest.sessionId === session.id
      && fileLineRequest.path === selectedPath
    ) {
      return { line: fileLineRequest.line, nonce: fileLineRequest.nonce };
    }
    return null;
  }, [fileLineRequest, followedOutstanding, outstanding, selectedPath, session.id, threadJump]);

  const openQueued = useCallback((thread: FileCommentThread): void => {
    setReviewError(null);
    setCommentMode(true);
    pendingThreadOpen.current = thread.id;
    if (thread.path !== selectedPath) controller.select(session.id, thread.path);
    else setOpenThreadId(thread.id);
  }, [controller, selectedPath, session.id]);

  /** Open a history row and make its anchor the active target on every visible reader. */
  const openIndexedThread = useCallback((thread: FileCommentThread): void => {
    setThreadError(null);
    setCommentMode(true);
    if (thread.status === "resolved") setShowResolved(true);
    if (thread.status === "draft") {
      setOpenThreadId(null);
      draft.openDraft(thread);
    } else {
      draft.dismiss();
      setOpenThreadId(thread.id);
    }
    jumpNonce.current += 1;
    setThreadJump({ id: thread.id, line: thread.startLine, nonce: jumpNonce.current });
  }, [draft]);

  /*
   * A comment belongs to the file and the session it was written on.
   *
   * Moving to either closes whatever was open here and lets the draft settle where it was,
   * rather than carrying it over. The SESSION is in this dependency list as well as the
   * path, and it has to be: this component is not remounted when the rail selection moves,
   * so without it a composer opened on one session's file would stay on screen over
   * another's - and, before the composer started carrying its own target, would have
   * written its row against whichever session was selected when the debounce fired.
   *
   * Settling rather than discarding, because a draft is durable by design. What the reader
   * typed is written where they typed it; only the panel goes.
   */
  const dismissDraft = draft.dismiss;
  useEffect(() => {
    // A thread the reader asked for BY NAME survives the move that was made to reach it.
    // Opening a queued comment on another file selects that file, and this effect runs on the
    // selection - so without the handoff the walkthrough's own "take me to comment 3" would
    // close the panel it had just opened, every time the comment was not already on screen.
    const requested = pendingThreadOpen.current;
    pendingThreadOpen.current = null;
    setOpenThreadId(requested);
    setThreadError(null);
    setThreadJump(null);
    setHtmlTarget(null);
    dismissDraft();
  }, [dismissDraft, selectedPath, session.id]);

  /** Open a line's thread, cycling when the line carries more than one. */
  const openThreadOnLine = useCallback((line: number): void => {
    const bucket = threadLines.get(line) ?? [];
    if (bucket.length === 0) return;
    setThreadError(null);
    // `-1` when nothing on this line is open, which lands on the first - so one expression
    // covers both "open it" and "step to the next of several", and running off the end
    // closes the panel rather than wrapping back to a thread just read.
    const at = bucket.findIndex((thread) => thread.id === openThreadId);
    const next = bucket[at + 1] ?? null;
    draft.dismiss();
    if (!next) {
      setOpenThreadId(null);
      return;
    }
    setOpenThreadId(next.id);
    // A draft IS its composer - it was never submitted, so there is nothing to read yet and
    // everything still to edit. Opening it any other way would strand it unqueueable.
    if (next.status === "draft") draft.openDraft(next);
  }, [draft, openThreadId, threadLines]);

  const commentOnLine = useCallback((line: number): void => {
    if (threadLines.has(line)) {
      openThreadOnLine(line);
      return;
    }
    setOpenThreadId(null);
    draft.dismiss();
    if (draft.openLine(line, buffer?.text ?? "")) {
      setThreadError(null);
      return;
    }
    // Only reachable on a file of nothing but blank lines: an ordinary blank line anchors to
    // the nearest line that says something, below it or above it.
    setThreadError("This file has no text to anchor a comment to.");
  }, [buffer?.text, draft, openThreadOnLine, threadLines]);

  /*
   * ---- commenting on the RENDERED document ----
   *
   * Comment mode already puts the source beside a preview, so a reader can point at line 84
   * without leaving the view they chose. This is the other half: pointing at the PARAGRAPH.
   *
   * Both surfaces end in the same place - `draft.openRange`, opening phase 2's composer in
   * the source column, at the line the block came from - and neither invents a way to
   * anchor. A comment made in Preview is a comment on source lines, exactly as one made in
   * the Editor is, because that is a property of the model rather than of the surface.
   *
   * They differ only in who does the parse. Markdown carries `node.position` down from the
   * parser that rendered it, so the range is already known in this tab. HTML is inside an
   * opaque sandbox this origin cannot read, so the frame reports WHERE it was clicked and
   * the daemon resolves that against a parse5 tree of the same file.
   */

  // Both taken off the controller by name, because both are `useCallback`-stable while the
  // controller OBJECT is rebuilt every render. Depending on the object would make the handler
  // below a new function each time, which the `Markdown` memo compares by identity - so the
  // whole preview would re-highlight on every workspace render.
  const openRange = draft.openRange;
  const dismissDraftForBlock = draft.dismiss;
  /**
   * What a click on a rendered block does, once its source range is known.
   *
   * The Comments rail now gives Preview a visible index of every thread, including resolved
   * ones. A block that already carries a thread therefore opens that thread in the dock so the
   * reader can reply or reopen it. A draft reopens in the same way. Only an unclaimed block
   * opens a new composer, so repeated clicks never create duplicate threads.
   */
  const commentOnBlock = useCallback((
    anchor: { startLine: number; endLine: number; quote: string },
    surface: "markdown" | "html",
    revision?: string | null,
  ): void => {
    const onLine = allThreadLines.get(anchor.startLine) ?? [];
    const existing = onLine.find((thread) => thread.status === "draft") ?? onLine[0];
    if (existing) {
      openIndexedThread(existing);
      return;
    }
    setOpenThreadId(null);
    dismissDraftForBlock();
    if (openRange({ ...anchor, surface, revision })) {
      setThreadError(null);
      return;
    }
    setThreadError("That block has no source text to anchor a comment to.");
  }, [allThreadLines, dismissDraftForBlock, openIndexedThread, openRange]);

  /**
   * A block of the rendered Markdown, anchored to the source it was rendered FROM.
   *
   * `previewText` rather than `buffer.text`, and the difference is the point: the positions
   * came from the parse of what is on screen, which is the debounced copy. Slicing the newer
   * buffer would quote text the reader was not looking at.
   *
   * `previewRevision` travels with it for the same reason, and it is the half that is easy to
   * drop: quote and revision have to describe ONE snapshot. Stamping this quote with the live
   * buffer's revision instead would tell `reanchor()` the file has not moved since - which is
   * exactly the case where it trusts the stored lines and never looks for the quote.
   */
  const commentOnMarkdownBlock = useCallback((range: MarkdownBlockRange): void => {
    commentOnBlock(
      { ...range, quote: boundQuote(sliceLines(previewText, range.startLine, range.endLine)) },
      "markdown",
      previewRevision,
    );
  }, [commentOnBlock, previewRevision, previewText]);

  const markdownShowing = buffer?.document.kind === "markdown" && mode === "preview";
  const htmlShowing = buffer?.document.kind === "html" && mode === "preview";
  /*
   * One identity for the whole time comment mode is on, held behind a ref.
   *
   * `commentOnMarkdownBlock` is rebuilt whenever `previewText` moves, which is every keystroke
   * an agent makes in the file being read. Passing it straight through as `blockAnchor` would
   * make `markdownPropsEqual` report "not equal" each time, and the memo it guards exists
   * because the remark -> rehype -> highlight pipeline behind it is real work. A reader sitting
   * in comment mode reading a long spec is precisely the case that memo is for, so the prop has
   * to be stable while the freshest handler still runs.
   *
   * The ref is refreshed during render rather than in an effect, so the very first click
   * after a state change already calls the new closure. `blockClickRef` below does the same
   * thing for the HTML bridge, for the same reason.
   */
  const markdownBlockRef = useRef(commentOnMarkdownBlock);
  markdownBlockRef.current = commentOnMarkdownBlock;
  const stableMarkdownBlockAnchor = useCallback((range: MarkdownBlockRange): void => {
    markdownBlockRef.current(range);
  }, []);
  /**
   * Absent, not a no-op, when comment mode is off.
   *
   * `undefined` is the opt-in signal `Markdown` uses, and it is what keeps every block
   * rendering as bare markup for the nine callers that never pass it - and for this one,
   * whenever the reader is only reading. Two values, both stable: this constant and
   * `undefined`, so toggling the mode is the only thing that re-parses.
   */
  const markdownBlockAnchor = commentsActive && markdownShowing
    ? stableMarkdownBlockAnchor
    : undefined;

  /** Whether the sandboxed preview should be treating a click as a comment right now. */
  const htmlCommenting = commentsActive && htmlShowing;

  /* Reveal the indexed block in Markdown Preview, where source ranges are already in DOM. */
  useEffect(() => {
    if (!threadJump || !markdownShowing || !commentsActive) return;
    const reader = workspaceRef.current?.querySelector<HTMLElement>(".file-markdown-preview");
    if (!reader) return;
    const blocks = [...reader.querySelectorAll<HTMLElement>("[data-start-line][data-end-line]")];
    const target = blocks.find((block) => {
      const start = Number(block.dataset.startLine);
      const end = Number(block.dataset.endLine);
      return start <= threadJump.line && end >= threadJump.line;
    });
    if (!target) return;
    blocks.forEach((block) => block.classList.remove("mission-comment-target"));
    target.classList.add("mission-comment-target");
    target.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [commentsActive, markdownShowing, previewText, threadJump]);

  /* Resolve the same source range to the opaque HTML preview's structural path. */
  useEffect(() => {
    if (!threadJump || !htmlShowing || !previewPath) {
      setHtmlTarget(null);
      return;
    }
    const thread = allFileThreads.find((candidate) => candidate.id === threadJump.id);
    if (!thread) {
      setHtmlTarget(null);
      return;
    }
    let live = true;
    void resolveHtmlBlockTarget(session.id, {
      path: previewPath,
      startLine: thread.startLine,
      endLine: thread.endLine,
      quote: thread.quote,
      revision: previewRevision,
    }).then((result) => {
      if (!live) return;
      setHtmlTarget(result.ok
        ? { blockPath: result.blockPath, nonce: threadJump.nonce }
        : null);
    });
    return () => { live = false; };
  }, [allFileThreads, htmlShowing, previewPath, previewRevision, session.id, threadJump]);

  /*
   * Arming the frame, from BOTH directions, because either one alone loses.
   *
   * Telling it when the reader toggles the mode is the obvious half, and it is not enough: a
   * `srcDoc` document that reloads - which it does whenever the file changes - comes back with
   * a fresh bridge that was never told anything. Telling it on the iframe's `load` is not
   * enough either, and this is the subtle one: a load event can fire for the `about:blank`
   * that precedes the real document, so a message sent then reaches a window that is about to
   * be replaced and is simply lost. The symptom is comment mode reading ON in the toolbar and
   * being OFF inside the frame, where a click does nothing and says nothing.
   *
   * So the bridge announces itself when it is live, and this answers with the current state.
   * The ref is what lets that answer be current without re-subscribing on every toggle.
   */
  const armFrame = useCallback((enabled: boolean): void => {
    const frame = workspaceRef.current?.querySelector<HTMLIFrameElement>(
      ".file-content .html-preview",
    );
    frame?.contentWindow?.postMessage({ type: HTML_PREVIEW_COMMENT_MESSAGE, enabled }, "*");
    frame?.contentWindow?.postMessage({ type: HTML_PREVIEW_KEYBOARD_MESSAGE, enabled: true }, "*");
  }, []);
  const revealHtmlTarget = useCallback((target: typeof htmlTarget): void => {
    if (!target) return;
    const frame = workspaceRef.current?.querySelector<HTMLIFrameElement>(
      ".file-content .html-preview",
    );
    frame?.contentWindow?.postMessage({
      type: HTML_PREVIEW_TARGET_MESSAGE,
      path: target.blockPath,
    }, "*");
  }, []);
  const commentingRef = useRef(htmlCommenting);
  commentingRef.current = htmlCommenting;
  const htmlTargetRef = useRef(htmlTarget);
  htmlTargetRef.current = htmlTarget;
  useEffect(() => {
    armFrame(htmlCommenting);
  }, [armFrame, htmlCommenting]);
  useEffect(() => {
    revealHtmlTarget(htmlTarget);
  }, [htmlTarget, revealHtmlTarget]);
  useEffect(() => {
    if (!previewPath) return;
    const onReady = (event: MessageEvent): void => {
      if ((event.data as { type?: unknown } | null)?.type !== HTML_PREVIEW_READY_MESSAGE) return;
      const frame = workspaceRef.current?.querySelector<HTMLIFrameElement>(
        ".file-content .html-preview",
      );
      if (!frame || event.source !== frame.contentWindow) return;
      armFrame(commentingRef.current);
      revealHtmlTarget(htmlTargetRef.current);
    };
    window.addEventListener("message", onReady);
    return () => window.removeEventListener("message", onReady);
  }, [armFrame, previewPath, revealHtmlTarget]);

  // A sandbox is a separate browsing context, so its keydown events never bubble to App.
  // The armed bridge claims only Preview's fixed navigation keys and sends exit back here,
  // where focus can return to the selected file without exposing the frame's document.
  useEffect(() => {
    if (!previewPath) return;
    const onKeyboard = (event: MessageEvent): void => {
      const data = event.data as { type?: unknown; action?: unknown } | null;
      if (data?.type !== HTML_PREVIEW_KEYBOARD_MESSAGE || data.action !== "exit") return;
      const frame = workspaceRef.current?.querySelector<HTMLIFrameElement>(
        ".file-content .html-preview",
      );
      if (!frame || event.source !== frame.contentWindow) return;
      focusCurrentFileRow(workspaceRef.current!);
    };
    window.addEventListener("message", onKeyboard);
    return () => window.removeEventListener("message", onKeyboard);
  }, [previewPath]);

  /**
   * The receiving half of the comment bridge, and a sibling of the link handler above.
   *
   * `event.source` is matched against THIS workspace's iframe for that handler's reason: the
   * extracted files window renders a second `FileWorkspace`, and neither may act on the
   * other's clicks.
   *
   * The refusal is shown rather than swallowed. There is exactly one - the reported path does
   * not resolve against the current source, which means the file changed under a render still
   * on screen - and the daemon's sentence names the reload that fixes it.
   */
  /*
   * The handler reaches its own latest self through a ref, and that is a correctness fix
   * rather than a tidy-up.
   *
   * `commentOnBlock` is rebuilt whenever `threadLines` is - which is whenever ANY thread in the
   * session changes, including the ones this click is about to create. With the handler in this
   * effect's dependency list, the listener was torn down and resubscribed on each of those, and
   * any rebuild landing during the resolve request dropped the answer on the floor: a click that
   * produced neither a composer nor a refusal, at a rate set by whatever else happened to move
   * the thread model in those few milliseconds. It was worse still when this closed over the
   * whole draft controller, which is a fresh object every render, but narrowing the dependencies
   * does not fix it - a resolve is a round trip, and any rebuild inside it is enough.
   *
   * Subscribed on the three facts that really define this listener, then, and called through
   * a ref that is refreshed during render, so it is always the current closure.
   */
  const blockClickRef = useRef(commentOnBlock);
  blockClickRef.current = commentOnBlock;
  /*
   * Which click the reader is still waiting on.
   *
   * Resolving a block is a round trip, and two clicks in quick succession are two of them
   * with no ordering between the answers. The older one arriving second used to win: it
   * dismissed the composer the newer click had already opened and put up its own, so the
   * reader ended up writing about a block they had moved on from - and nothing on screen
   * said so. Every click takes the next number, and an answer is applied only if its number
   * is still the current one.
   *
   * A counter rather than an `AbortController` because the stale answer must be dropped even
   * when it has already arrived, and abandoning it here is the same thing to the daemon: the
   * route only reads.
   */
  const blockRequests = useRef(0);
  const previewRevisionRef = useRef(previewRevision);
  previewRevisionRef.current = previewRevision;
  useEffect(() => {
    if (!htmlCommenting || !previewPath) return;
    let live = true;
    const onMessage = (event: MessageEvent): void => {
      const data = event.data as { type?: unknown; path?: unknown } | null;
      if (data?.type !== HTML_PREVIEW_BLOCK_MESSAGE || !Array.isArray(data.path)) return;
      const frame = workspaceRef.current?.querySelector<HTMLIFrameElement>(
        ".file-content .html-preview",
      );
      if (!frame || event.source !== frame.contentWindow) return;
      const blockPath = data.path as HtmlBlockPathStep[];
      blockRequests.current += 1;
      const request = blockRequests.current;
      void resolveHtmlBlockAnchor(session.id, {
        path: previewPath,
        blockPath,
        // The revision the iframe's document was built from. The daemon refuses if the file
        // it reads is not that one, because a path can still resolve against a file whose
        // TEXT has changed underneath it - same tags, same positions, different words.
        revision: previewRevisionRef.current,
      }).then((result) => {
        // Now only false when the reader really has left this file or turned the mode off,
        // which is the one case where an answer is genuinely no longer wanted.
        if (!live || request !== blockRequests.current) return;
        if (!result.ok) {
          // This endpoint uses 409 for exactly one condition: the file on disk no longer
          // matches the render the person clicked. Keep that fact structured so every place
          // this error can appear offers the action that fixes it, without text matching.
          setThreadError(result.error, result.status === 409);
          return;
        }
        blockClickRef.current(
          { startLine: result.startLine, endLine: result.endLine, quote: result.quote },
          "html",
          // The revision the daemon sliced the quote out of, which is a fact the browser's
          // buffer may not have caught up with yet. See `FileCommentRangeAnchor`.
          result.revision,
        );
      });
    };
    window.addEventListener("message", onMessage);
    return () => {
      live = false;
      window.removeEventListener("message", onMessage);
    };
  }, [htmlCommenting, previewPath, session.id]);

  /** Answers whether the reply landed, so a rejected one keeps its text to retry. */
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
    // Closing a thread stops it being drawn unless resolved ones are shown, so
    // leaving its panel open would leave a panel with no marker behind it.
    if (status === "resolved" && !showResolved) setOpenThreadId(null);
  }, [showResolved]);

  const composer = draft.composer;
  /**
   * The open panel itself, built once for BOTH places it can be drawn.
   *
   * The Editor hosts it in a block widget under its anchored line; a rendered document docks
   * it over the preview. Which of those is on screen is a property of the surface and not of
   * the panel, so there is one panel and two hosts rather than two panels that have to be
   * kept saying the same thing.
   */
  const commentPanel = useMemo((): React.ReactNode => {
    if (composer) {
      return (
        <FileCommentComposer
          startLine={composer.startLine}
          endLine={composer.endLine}
          quote={composer.quote}
          value={composer.text}
          busy={composer.busy}
          error={composer.error}
          onChange={draft.change}
          onSubmit={draft.submit}
          onCancel={draft.cancel}
        />
      );
    }
    if (openThread) {
      return (
        <FileCommentThreadCard
          thread={openThread}
          busy={threadBusy}
          error={threadError?.refreshable ? null : (threadError?.message ?? null)}
          onReply={(body) => reply(openThread.id, body)}
          onResolve={() => { void setThreadStatus(openThread.id, "resolved"); }}
          onReopen={() => { void setThreadStatus(openThread.id, "draft"); }}
          onClose={() => setOpenThreadId(null)}
        />
      );
    }
    return null;
  }, [
    composer,
    draft.cancel,
    draft.change,
    draft.submit,
    openThread,
    reply,
    setThreadStatus,
    threadBusy,
    threadError,
  ]);
  /**
   * Gated on `sourceShowing` rather than on "comments are on anywhere".
   *
   * A rendered document no longer mounts an editor at all, so markers and the panel line -
   * both of which only mean something in a gutter - belong to the Editor's surface alone.
   */
  const editorComments = useMemo((): FileEditorComments | undefined => {
    if (!commentable || !sourceShowing) return undefined;
    return {
      markers: [...threadLines.entries()].map(([line, threads]) => ({
        line,
        label: markerLabel(line, threads),
        tone: markerTone(threads),
      })),
      panelLine: composer?.line ?? openThread?.startLine ?? null,
      onLineSelect: commentsActive ? commentOnLine : null,
      onMarkerSelect: openThreadOnLine,
      panel: commentPanel,
    };
  }, [
    commentOnLine,
    commentPanel,
    commentable,
    commentsActive,
    composer,
    openThread,
    openThreadOnLine,
    sourceShowing,
    threadLines,
  ]);

  useImperativeHandle(ref, () => ({
    handleArrow: (direction, fromReader) => {
      const root = workspaceRef.current;
      if (!root) return false;
      if (previewable && mode === "preview") {
        const preview = previewReader(root);
        if (preview && previewHasFocus(preview)) {
          return scrollActiveFileReader(root, direction);
        }
        const next = adjacentFilePath(shown.map((file) => file.path), selectedPath, direction);
        if (next) {
          focusSelectedFile.current = true;
          choose(next);
        }
        // Preview owns the file cursor even at the first and last item. Falling through
        // there would switch sessions merely because this file has no neighbour.
        return true;
      }
      return fromReader ? scrollActiveFileReader(root, direction) : false;
    },
    focusPreview: () => {
      const root = workspaceRef.current;
      if (!root || !previewable || mode !== "preview") return false;
      const preview = previewReader(root);
      if (!preview || previewHasFocus(preview)) return false;
      preview.focus({ preventScroll: true });
      return true;
    },
    focusFileList: () => {
      const root = workspaceRef.current;
      if (!root || !previewable || mode !== "preview") return false;
      const preview = previewReader(root);
      if (!preview || !previewHasFocus(preview)) return false;
      return focusCurrentFileRow(root);
    },
  }), [mode, previewable, selectedPath, shown]);

  function choose(path: string): void {
    setComparing(false);
    controller.select(session.id, path);
  }

  const refreshStaleFile = useCallback((): void => {
    setThreadError(null);
    controller.refresh(session.id);
  }, [controller.refresh, session.id, setThreadError]);

  useEffect(() => {
    if (!focusSelectedFile.current) return;
    focusSelectedFile.current = false;
    if (workspaceRef.current) focusCurrentFileRow(workspaceRef.current);
  }, [selectedPath]);

  const launch = useCallback(async (path: string, target: OpenTargetId): Promise<void> => {
    setLaunching(true);
    const result = await api.openFile(session.id, path, target);
    setLaunching(false);
    // Nothing is said on success: the application takes the screen, which is the whole
    // confirmation. A failure has to be visible, though - the human is looking at a
    // window that did not change.
    setLaunchError(result.ok ? null : (result.error ?? "could not open the file"));
  }, [session.id]);

  /** Both refusal paths say the same thing, because they are the same refusal. */
  const unwritten = (path: string): string => `Not opened - ${path} could not be saved first.`;

  /**
   * Hand the SAVED file to a target, not the one on disk a moment ago.
   *
   * Every "Open in" target reads the path, and autosave is 750ms behind the keystroke, so
   * clicking straight after an edit would open the previous version - a bug that looks
   * exactly like the launcher having cached the page. Flushing and waiting for the buffer
   * to settle is what makes what-you-see and what-opens the same bytes.
   *
   * The two unsaved states are handled HERE as well as in the effect below, and both
   * branches are needed: a buffer that is `modified` when clicked ends up in the effect,
   * but one that is ALREADY `failed`, `offline` or `conflict` never enters it - nothing is
   * pending, so there is nothing to wait for - and would otherwise fall straight through
   * to a launch of the stale file.
   */
  function openIn(target: OpenTargetId): void {
    if (!selectedPath || !buffer) return;
    setLaunchError(null);
    if (isSavePending(buffer)) {
      controller.flush(session.id, selectedPath);
      setPendingOpen({ path: selectedPath, target });
      return;
    }
    if (hasUnwrittenEdits(buffer)) {
      setLaunchError(unwritten(selectedPath));
      return;
    }
    void launch(selectedPath, target);
  }

  useEffect(() => {
    if (!pendingOpen) return;
    const pending = state?.buffers[pendingOpen.path];
    if (pending && isSavePending(pending)) return;
    setPendingOpen(null);
    if (!pending) return;
    // The flush ended in `failed`, `offline` or `conflict`: the edits are real and are NOT
    // on disk, so opening now would quietly show the wrong thing. The save notice below
    // says which of those it was.
    if (hasUnwrittenEdits(pending)) {
      setLaunchError(unwritten(pendingOpen.path));
      return;
    }
    void launch(pendingOpen.path, pendingOpen.target);
  }, [launch, pendingOpen, state?.buffers]);

  // A refusal is about the file it names, so it goes when that file leaves the toolbar.
  // A launch already in flight does NOT: the human asked for that file, and switching
  // away while its save lands is not a change of mind.
  useEffect(() => {
    setLaunchError(null);
  }, [selectedPath]);

  return (
    <section ref={workspaceRef} className={`file-workspace${extracted ? " is-extracted" : ""}`} aria-label={`Files for ${session.name}`}>
      <aside className="file-nav">
        <div className="file-nav-tools">
          <input
            className="file-filter"
            value={filter}
            onChange={(event) => setFilter(event.currentTarget.value)}
            placeholder="Filter files…"
            aria-label="Filter session files"
          />
          <Tooltip label="Re-read this checkout's file list"><button className="icon-btn" onClick={() => controller.refresh(session.id)} aria-label="Refresh files">↻</button></Tooltip>
        </div>
        <div className="file-list" role="listbox" aria-label="Session files">
          {state?.listState === "loading" && files.length === 0 && <p className="file-empty">Loading files…</p>}
          {state?.listError && <p className="file-error">{state.listError}</p>}
          {shown.map((file) => (
            <Tooltip key={file.path} label={file.path}>
            <button
              role="option"
              aria-selected={selectedPath === file.path}
              className={`file-row${selectedPath === file.path ? " on" : ""}`}
              onClick={() => choose(file.path)}
            >
              <span className="file-row-name">{file.path}</span>
              {state?.buffers[file.path] && state.buffers[file.path]!.saveState !== "saved" && (
                <span className={`file-row-mark is-${state.buffers[file.path]!.saveState}`} aria-hidden>●</span>
              )}
            </button>
            </Tooltip>
          ))}
          {state?.listState === "ready" && shown.length === 0 && <p className="file-empty">No matching files.</p>}
        </div>
        <form
          className="file-manual"
          onSubmit={(event) => {
            event.preventDefault();
            const next = manualPath.trim();
            if (next) choose(next);
          }}
        >
          <input value={manualPath} onChange={(event) => setManualPath(event.currentTarget.value)} placeholder="Open relative path…" aria-label="Open a relative path" />
        </form>
      </aside>

      <div className="file-main">
        <header className="file-toolbar">
          <Tooltip label={selectedPath ?? "No file open"}><span className="file-path mono">{selectedPath ?? "Select a file"}</span></Tooltip>
          {buffer && <span className="file-language">{buffer.document.language}</span>}
          {buffer && <span className="file-size">{formatBytes(buffer.document.size)}</span>}
          {buffer && <SaveStatus buffer={buffer} />}
          <span className="file-toolbar-spacer" />
          {/*
            `aria-pressed` and not the class alone: which of the two views a file opened in
            is the state a reader of this toolbar most needs, and a highlight is invisible
            to a screen reader and unassertable from a browser test. It is the published
            signal that a rendered document lands on Preview and source lands on Editor.
          */}
          {previewable && (
            <div className="file-mode" role="group" aria-label="File view mode">
              <Tooltip label="Render this file rather than showing its source"><button className={mode === "preview" ? "on" : ""} aria-label="Preview" aria-keyshortcuts={extracted ? undefined : "p"} aria-pressed={mode === "preview"} onClick={() => controller.setMode(session.id, "preview")}>Preview{!extracted && showKeybindingHints && <kbd className="kb-hint">p</kbd>}</button></Tooltip>
              <Tooltip label={buffer.document.editable ? "Edit this file's source" : "This file is not editable"}><button className={mode === "editor" ? "on" : ""} aria-label="Editor" aria-keyshortcuts={!extracted && buffer.document.editable ? "e" : undefined} aria-pressed={mode === "editor"} disabled={!buffer.document.editable} onClick={() => controller.setMode(session.id, "editor")}>Editor{!extracted && buffer.document.editable && showKeybindingHints && <kbd className="kb-hint">e</kbd>}</button></Tooltip>
            </div>
          )}
          {/*
            Its own control rather than a third segment of `.file-mode`: that group is
            "which view", and this is "what a click on a line does" - and the group is only
            rendered for a previewable file, while a plain source file takes comments too.
            The classes are its own for a second reason - `PersonaEditor`,
            `SessionActionEditor` and `ForemanProfileEditor` all reuse `.file-toolbar` and
            `.file-mode`, so styling by descendant of either would put this control's
            appearance on three surfaces that have no comments at all.
          */}
          {buffer && (
            <div className="file-comment-controls">
              <Tooltip
                label={commentable
                  ? "Comment on a line: click a line number, or a block of the preview"
                  : buffer.document.kind === "image"
                  ? "An image has no lines to comment on"
                  : "This file has no source to comment on"}
              >
                <button
                  className={`file-comment-toggle${commentsActive ? " on" : ""}`}
                  aria-label="Comment mode"
                  aria-keyshortcuts={!extracted && commentable ? "m" : undefined}
                  aria-pressed={commentsActive}
                  disabled={!commentable}
                  onClick={() => {
                    if (commentsActive) setCommentMode(false);
                    else enterCommentMode();
                  }}
                >
                  Comment
                  {!extracted && commentable && showKeybindingHints && <kbd className="kb-hint">m</kbd>}
                </button>
              </Tooltip>
              <Tooltip
                label={showComments
                  ? "Hide every comment on this file"
                  : "Show every comment on this file, including resolved threads"}
              >
                <button
                  className={`file-comment-toggle${showComments ? " on" : ""}`}
                  aria-label="Comments"
                  aria-expanded={showComments}
                  onClick={() => setShowComments((value) => !value)}
                >
                  Comments ({allFileThreads.length})
                </button>
              </Tooltip>
              {/*
                The review's own control, beside the mode toggle rather than inside it: comment
                mode is "what a click on a line does", and this is "what happens to what you
                have already written". It is drawn whenever the session HAS a review to look
                at, not only in comment mode - a review drains while you read another file, and
                a control that vanished when you left the file you were commenting on would be
                the one control you cannot find when it pauses.
              */}
              {(queue.length > 0 || review !== null) && (
                <Tooltip
                  label={showQueue
                    ? "Hide the review queue"
                    : `Show the ${queue.length} comment${queue.length === 1 ? "" : "s"} in this session's review`}
                >
                  <button
                    className={`file-comment-toggle${showQueue ? " on" : ""}`}
                    aria-label="Review queue"
                    aria-pressed={showQueue}
                    onClick={() => setShowQueue((value) => !value)}
                  >
                    Review ({queue.length})
                  </button>
                </Tooltip>
              )}
              {commentsActive && resolvedCount > 0 && (
                <Tooltip
                  label={showResolved
                    ? "Stop drawing closed threads on this file"
                    : `Also show the ${resolvedCount} closed thread${resolvedCount === 1 ? "" : "s"} on this file`}
                >
                  <button
                    className={`file-comment-toggle${showResolved ? " on" : ""}`}
                    aria-label="Show resolved comments"
                    aria-pressed={showResolved}
                    onClick={() => setShowResolved((value) => !value)}
                  >
                    Resolved
                  </button>
                </Tooltip>
              )}
            </div>
          )}
          <OpenInMenu disabled={!buffer} busy={launching || pendingOpen !== null} onChoose={openIn} />
          {!extracted && onExtract && (
            <Tooltip label="Extract to a movable window"><button className="icon-btn file-extract" onClick={() => { controller.flush(session.id); onExtract(); }} aria-label="Extract files window">↗</button></Tooltip>
          )}
        </header>

        <div className={`file-reader-shell${showComments ? " has-comment-rail" : ""}`}>
          <div className={`file-content${commentOverlayShowing ? " is-commenting" : ""}`}>
          {!selectedPath && <p className="file-empty">Choose a file from the checkout.</p>}
          {selectedPath && state?.openError && <p className="file-error">{state.openError}</p>}
          {selectedPath && !buffer && !state?.openError && <p className="file-empty">Loading {selectedPath}…</p>}
          {buffer && buffer.document.text == null && buffer.document.kind !== "image" && <p className="file-empty">{buffer.document.error ?? "This file cannot be opened."}</p>}
          {buffer?.document.text != null && buffer.document.kind === "html" && mode === "preview" && (
            <iframe
              className="html-preview file-preview-reader"
              tabIndex={-1}
              title={`Preview of ${buffer.document.path}`}
              sandbox={HTML_PREVIEW_SANDBOX}
              srcDoc={htmlPreviewSource(previewText)}
            />
          )}
          {buffer?.document.text != null && buffer.document.kind === "markdown" && mode === "preview" && (
            <article
              className={`file-markdown-preview file-preview-reader markdown${markdownBlockAnchor ? " is-commenting" : ""}`}
              tabIndex={-1}
              aria-label={`Preview of ${buffer.document.path}`}
            >
              <Markdown
                diagramRenderers={FILES_DIAGRAM_RENDERERS}
                diagramDocumentKey={buffer.document.path}
                blockAnchor={markdownBlockAnchor}
              >
                {previewText}
              </Markdown>
            </article>
          )}
          {buffer?.document.kind === "image" && mode === "preview" && imageSource && (
            <div className="file-image-preview file-preview-reader" tabIndex={-1} aria-label={`Preview of ${buffer.document.path}`}>
              <img src={imageSource} alt={buffer.document.path} />
            </div>
          )}
          {buffer?.document.kind === "image" && mode === "preview" && !imageSource && (
            <p className="file-empty">Image preview is unavailable.</p>
          )}
          {buffer?.document.text != null && sourceShowing && !comparing && (
            <FileEditor
              path={buffer.document.path}
              value={buffer.text}
              readOnly={!buffer.document.editable || buffer.saveState === "conflict"}
              comments={editorComments}
              scrollTo={scrollTo}
              onChange={(text) => controller.edit(session.id, buffer.document.path, text)}
              onBlur={() => controller.flush(session.id, buffer.document.path)}
            />
          )}
          {/*
            The panel, docked over the rendered document rather than beside it.

            In flow terms it is out of flow, so the preview keeps the whole pane and reflows
            for nothing when a comment opens. It is NOT a `role="dialog"` and it is not
            registered with the overlay registry: the composer inside already names itself a
            region, and making this a modal would trap focus and stand App's shortcuts down
            over a reader who is meant to keep reading the document behind it.
          */}
          {commentOverlayShowing && commentPanel && (
            <div className="file-comment-dock">{commentPanel}</div>
          )}
          {buffer?.conflict && comparing && (
            <div className="file-compare">
              <div><h3>Local edits</h3><pre>{buffer.text}</pre></div>
              <div><h3>{buffer.conflict.deleted ? "Deleted on disk" : "Current disk"}</h3><pre>{buffer.conflict.text ?? "File content is unavailable."}</pre></div>
            </div>
          )}
          </div>

          {showComments && selectedPath && (
            <FileCommentRail
              path={selectedPath}
              threads={allFileThreads}
              selectedId={openThreadId ?? composer?.threadId ?? null}
              onOpen={openIndexedThread}
              onClose={() => setShowComments(false)}
            />
          )}
        </div>

        {showQueue && (
          <FileCommentQueue
            queue={queue}
            review={review}
            busy={reviewBusy}
            error={reviewError}
            onStart={() => { void controlReview("start"); }}
            onPause={() => { void controlReview("pause"); }}
            onMove={(threadId, direction) => { void moveInQueue(threadId, direction); }}
            onEdit={editQueued}
            onDrop={(threadId) => { void dropFromQueue(threadId); }}
            onOpen={openQueued}
            onDismissPause={() => { void controlReview("dismiss"); }}
            onDismissError={() => setReviewError(null)}
          />
        )}

        {/* A comment refusal with no panel to carry it - a blank line at the end of a file
            has nothing to anchor to, and the click that found that out has nowhere else to
            report it. */}
        {threadError && (threadError.refreshable || (!composer && !openThread)) && (
          <div className="file-notice">
            <span>{threadError.message}</span>
            {threadError.refreshable && (
              <Tooltip label="Reload the selected file and its preview">
                <button className="btn" onClick={refreshStaleFile}>Refresh</button>
              </Tooltip>
            )}
            <Tooltip label="Dismiss this comment error">
              <button className="btn" onClick={() => setThreadError(null)}>Dismiss</button>
            </Tooltip>
          </div>
        )}
        {launchError && (
          <div className="file-notice">
            <span>{launchError}</span>
            <Tooltip label="Dismiss this launch error">
              <button className="btn" onClick={() => setLaunchError(null)}>Dismiss</button>
            </Tooltip>
          </div>
        )}
        {buffer && (buffer.saveState === "failed" || buffer.saveState === "offline") && (
          <div className="file-notice">
            <span>{buffer.error ?? (buffer.saveState === "offline" ? "Waiting for the daemon to reconnect." : "The save did not complete.")}</span>
            <Tooltip label="Try saving this file again"><button className="btn" onClick={() => controller.retry(session.id, buffer.document.path)}>Retry</button></Tooltip>
          </div>
        )}
        {buffer?.conflict && (
          <div className="file-notice is-conflict">
            <span>{buffer.error ?? "This file changed outside Mission Control."}</span>
            <Tooltip label={comparing ? "Go back to editing" : "Show your edits against the version on disk"}><button className="btn" onClick={() => setComparing((value) => !value)}>{comparing ? "Back to editor" : "Compare"}</button></Tooltip>
            <Tooltip label={buffer.conflict.deleted || buffer.conflict.text == null ? "The file on disk is gone, so there is nothing to reload" : "Discard your edits and take the version on disk"}><button className="btn" disabled={buffer.conflict.deleted || buffer.conflict.text == null} onClick={() => {
              if (window.confirm("Discard local edits and reload the version on disk?")) controller.reloadDisk(session.id, buffer.document.path);
            }}>Reload disk</button></Tooltip>
            <Tooltip label="Overwrite the newer file on disk with your local edits"><button className="btn btn-danger" disabled={!buffer.conflict.revision} onClick={() => {
              if (window.confirm("Overwrite the newer file on disk with your local edits?")) controller.overwriteDisk(session.id, buffer.document.path);
            }}>Overwrite disk</button></Tooltip>
            <Tooltip label="Copy your local version to the clipboard"><button className="btn" onClick={() => { void copyLocal.copy(() => buffer.text); }}>{copyLocal.copied ? COPY_FEEDBACK_LABEL : "Copy local"}</button></Tooltip>
            {/* Its own class so it opts out of the `.file-notice > span` rule that pins the
                leading sentence left - this one belongs beside the button it reports on. */}
            {copyLocal.error && <span className="file-notice-error" role="alert">{copyLocal.error}</span>}
          </div>
        )}
      </div>
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
