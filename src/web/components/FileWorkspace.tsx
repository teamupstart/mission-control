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
  setFileCommentStatus,
} from "../lib/api.ts";
import { Markdown } from "./Markdown.tsx";
import { FILES_DIAGRAM_RENDERERS } from "./markdownDiagramRegistry.tsx";
import { OpenInMenu } from "./OpenInMenu.tsx";
import { api } from "../lib/api.ts";
import { COPY_FEEDBACK_LABEL, useCopyFeedback } from "../lib/clipboard.ts";
import { isTypingTarget, useKeybindingHints } from "../lib/keybindings.ts";
import { workspaceAssetPath } from "../lib/workspaceLinks.ts";
// The sandboxed HTML preview boundary is SHARED with Scouts and lives in one module, so
// neither surface can quietly weaken the CSP or the sandbox for its own documents.
import {
  HTML_PREVIEW_LINK_MESSAGE,
  HTML_PREVIEW_SANDBOX,
  HTML_PREVIEW_SCROLL_MESSAGE,
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
}

function scrollElement(element: HTMLElement, direction: -1 | 1): void {
  element.scrollBy({ top: direction * Math.max(80, element.clientHeight * 0.18) });
}

export function scrollActiveFileReader(root: ParentNode, direction: -1 | 1): boolean {
  const contentReaders = root.querySelectorAll<HTMLElement>(
    ".file-content .cm-scroller, .file-content .file-markdown-preview, .file-content .file-image-preview, .file-content .file-compare pre",
  );
  if (contentReaders.length > 0) {
    contentReaders.forEach((element) => scrollElement(element, direction));
    return true;
  }
  const preview = root.querySelector<HTMLIFrameElement>(".file-content .html-preview");
  if (preview?.contentWindow) {
    preview.contentWindow.postMessage({
      type: HTML_PREVIEW_SCROLL_MESSAGE,
      top: direction * Math.max(80, preview.clientHeight * 0.18),
    }, "*");
    return true;
  }
  const list = root.querySelector<HTMLElement>(".file-list");
  if (!list) return false;
  scrollElement(list, direction);
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
  const [showQueue, setShowQueue] = useState(false);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);
  const [threadBusy, setThreadBusy] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);
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
   * The source column Comment mode puts BESIDE a rendered document.
   *
   * Comments anchor to source lines, and that is a property of the model rather than a
   * limitation of the surface: a thread names a line and a quote, so something with lines
   * has to be on screen to click. So the preview keeps its half and the source takes the
   * other, and the reader comments without leaving Preview. It is read-only - Preview is
   * the view they chose, and `e` is one key away if they meant to edit.
   *
   * Phase 5 still owns markers ON the rendered document itself. This is the surface that
   * makes the control work in Preview at all; that is the surface that makes the rendered
   * half clickable too.
   */
  const commentSourceShowing = commentsActive && !sourceShowing && buffer?.document.text != null;
  const commentSurfaceShowing = sourceShowing || commentSourceShowing;
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
        || (event.key !== "e" && event.key !== "p" && event.key !== "m")
      ) return;
      if (
        isTypingTarget(event.target)
        || isOverlayOpen?.() === true
      ) return;
      const editorAvailable = previewable && buffer?.document.editable === true;
      if ((event.key === "p" && !previewable) || (event.key === "e" && !editorAvailable)) return;
      if (event.key === "m" && !commentable) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "m") {
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
  } | null>(null);
  const previewText = buffer && preparedPreview?.path === buffer.document.path
    ? preparedPreview.text
    : (buffer?.text ?? "");
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
      if (buffer?.document.kind !== "html") {
        setPreparedPreview({ path, text });
        return;
      }
      void inlinePreviewStyles(text, buffer.document.path, async (assetPath) => {
        const result = await api.readFile(session.id, assetPath, abort.signal);
        return result.ok ? result.file.text : null;
      }, abort.signal).then((next) => {
        if (live) setPreparedPreview({ path, text: next });
      });
    }, 180);
    return () => {
      live = false;
      abort.abort();
      clearTimeout(timer);
    };
  }, [buffer?.document.kind, buffer?.document.path, buffer?.text, session.id]);
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
   * The comment model this file draws, derived on every render from the durable threads
   * and nothing else.
   *
   * That is the rule the CodeMirror integration rests on and the one later phases must
   * keep: the Editor replaces its whole document on an agent edit and rebuilds its view
   * outright on a path or read-only change, and a marker that remembered a position rather
   * than deriving one would be wrong after each. Phase 3's re-anchor pass moves
   * `startLine`; this redraws from it with no further work.
   */
  const fileThreads = useMemo(
    () => threadsForFile(fileCommentThreads, session.id, selectedPath, showResolved),
    [fileCommentThreads, selectedPath, session.id, showResolved],
  );
  const threadLines = useMemo(() => threadsByLine(fileThreads), [fileThreads]);
  const resolvedCount = useMemo(
    () =>
      fileCommentThreads.filter(
        (thread) =>
          thread.sessionId === session.id
          && thread.path === selectedPath
          && thread.status === "resolved",
      ).length,
    [fileCommentThreads, selectedPath, session.id],
  );
  const openThread = fileThreads.find((thread) => thread.id === openThreadId) ?? null;

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

  const controlReview = useCallback(async (action: "start" | "pause"): Promise<void> => {
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
  }, [fileLineRequest, followedOutstanding, outstanding, selectedPath, session.id]);

  const openQueued = useCallback((thread: FileCommentThread): void => {
    setReviewError(null);
    setCommentMode(true);
    pendingThreadOpen.current = thread.id;
    if (thread.path !== selectedPath) controller.select(session.id, thread.path);
    else setOpenThreadId(thread.id);
  }, [controller, selectedPath, session.id]);

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
  const editorComments = useMemo((): FileEditorComments | undefined => {
    if (!commentable || !commentSurfaceShowing) return undefined;
    const panelLine = composer?.line ?? openThread?.startLine ?? null;
    return {
      markers: [...threadLines.entries()].map(([line, threads]) => ({
        line,
        label: markerLabel(line, threads),
        tone: markerTone(threads),
      })),
      panelLine,
      onLineSelect: commentsActive ? commentOnLine : null,
      onMarkerSelect: openThreadOnLine,
      panel: composer
        ? (
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
        )
        : openThread
        ? (
          <FileCommentThreadCard
            thread={openThread}
            busy={threadBusy}
            error={threadError}
            onReply={(body) => reply(openThread.id, body)}
            onResolve={() => { void setThreadStatus(openThread.id, "resolved"); }}
            onReopen={() => { void setThreadStatus(openThread.id, "draft"); }}
            onClose={() => setOpenThreadId(null)}
          />
        )
        : null,
    };
  }, [
    commentOnLine,
    commentable,
    commentsActive,
    composer,
    draft.cancel,
    draft.change,
    draft.submit,
    commentSurfaceShowing,
    openThread,
    openThreadOnLine,
    reply,
    setThreadStatus,
    threadBusy,
    threadError,
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
  }), [mode, previewable, selectedPath, shown]);

  function choose(path: string): void {
    setComparing(false);
    controller.select(session.id, path);
  }

  useEffect(() => {
    if (!focusSelectedFile.current) return;
    focusSelectedFile.current = false;
    const row = workspaceRef.current?.querySelector<HTMLButtonElement>(
      '.file-row[aria-selected="true"]',
    );
    row?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: "nearest" });
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
                  ? "Comment on a line: click a line number to write one"
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

        <div className={`file-content${commentSourceShowing ? " is-comment-split" : ""}`}>
          {!selectedPath && <p className="file-empty">Choose a file from the checkout.</p>}
          {selectedPath && state?.openError && <p className="file-error">{state.openError}</p>}
          {selectedPath && !buffer && !state?.openError && <p className="file-empty">Loading {selectedPath}…</p>}
          {buffer && buffer.document.text == null && buffer.document.kind !== "image" && <p className="file-empty">{buffer.document.error ?? "This file cannot be opened."}</p>}
          {buffer?.document.text != null && buffer.document.kind === "html" && mode === "preview" && (
            <iframe className="html-preview file-preview-reader" tabIndex={-1} title={`Preview of ${buffer.document.path}`} sandbox={HTML_PREVIEW_SANDBOX} srcDoc={htmlPreviewSource(previewText)} />
          )}
          {buffer?.document.text != null && buffer.document.kind === "markdown" && mode === "preview" && (
            <article className="file-markdown-preview file-preview-reader markdown" tabIndex={-1} aria-label={`Preview of ${buffer.document.path}`}>
              <Markdown
                diagramRenderers={FILES_DIAGRAM_RENDERERS}
                diagramDocumentKey={buffer.document.path}
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
          {buffer?.document.text != null && commentSurfaceShowing && !comparing && (
            <FileEditor
              path={buffer.document.path}
              value={buffer.text}
              readOnly={commentSourceShowing || !buffer.document.editable || buffer.saveState === "conflict"}
              wrap={commentSourceShowing}
              comments={editorComments}
              scrollTo={scrollTo}
              onChange={(text) => controller.edit(session.id, buffer.document.path, text)}
              onBlur={() => controller.flush(session.id, buffer.document.path)}
            />
          )}
          {buffer?.conflict && comparing && (
            <div className="file-compare">
              <div><h3>Local edits</h3><pre>{buffer.text}</pre></div>
              <div><h3>{buffer.conflict.deleted ? "Deleted on disk" : "Current disk"}</h3><pre>{buffer.conflict.text ?? "File content is unavailable."}</pre></div>
            </div>
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
            onDismissError={() => setReviewError(null)}
          />
        )}

        {/* A comment refusal with no panel to carry it - a blank line at the end of a file
            has nothing to anchor to, and the click that found that out has nowhere else to
            report it. */}
        {threadError && !composer && !openThread && (
          <div className="file-notice">
            <span>{threadError}</span>
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
