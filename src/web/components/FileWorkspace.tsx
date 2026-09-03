import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type { FileCommentReview, FileCommentThread, Session } from "@shared/types.ts";
import type { OpenTargetId } from "@shared/open-targets.ts";
import {
  hasUnwrittenEdits,
  isSavePending,
  type FileBuffer,
  type SessionFilesController,
} from "../lib/sessionFiles.ts";
import {
  FileEditor,
  editorFindChord,
  type FileEditorComments,
  type FileEditorFind,
} from "./FileEditor.tsx";
import { FileCommentComposer, FileCommentThreadCard } from "./FileCommentThread.tsx";
import { FileCommentRail } from "./FileCommentRail.tsx";
import { useFileCommentDraft } from "../lib/fileCommentDraft.ts";
import {
  fileCommentQuoteForDisplay,
  isCommentableDocument,
  markerLabel,
  markerTone,
  outstandingThread,
  reviewQueue,
  threadForRenderedBlock,
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
import {
  Markdown,
  type MarkdownBlockRange,
  type MarkdownFindHit,
  type MarkdownFindRequest,
} from "./Markdown.tsx";
import { FindBar } from "./FindBar.tsx";
import {
  documentHits,
  hitLinesByBlock,
  stepIndex,
  frameFindCount,
  frameFindIndex,
  type DocumentFindSession,
  type FrameFindResult,
  type DocumentHit,
} from "../lib/documentFind.ts";
import { FIND_KEY_ATTRIBUTE } from "../lib/rehypeFindMarks.ts";
import { FILES_DIAGRAM_RENDERERS } from "./markdownDiagramRegistry.tsx";
import { OpenInMenu } from "./OpenInMenu.tsx";
import { api } from "../lib/api.ts";
import { COPY_FEEDBACK_LABEL, useCopyFeedback } from "../lib/clipboard.ts";
import { chordFromEvent, isTypingTarget, useKeybindingHints, useKeybindings } from "../lib/keybindings.ts";
import { workspaceAssetPath } from "../lib/workspaceLinks.ts";
// The sandboxed HTML preview boundary is SHARED with Scouts and lives in one module, so
// neither surface can quietly weaken the CSP or the sandbox for its own documents.
import {
  HTML_PREVIEW_BLOCK_MESSAGE,
  HTML_PREVIEW_COMMENT_MESSAGE,
  HTML_PREVIEW_FIND_CHORD_MESSAGE,
  HTML_PREVIEW_FIND_MESSAGE,
  HTML_PREVIEW_FIND_READY_MESSAGE,
  HTML_PREVIEW_FIND_RESULT_MESSAGE,
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
import { ResizablePaneDivider } from "./ResizablePaneDivider.tsx";

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

/** A block the sandboxed preview has been asked to reveal, from either source. */
export interface HtmlRevealTarget {
  blockPath: HtmlBlockPathStep[];
  nonce: number;
}

/**
 * Which reveal the sandboxed HTML preview should be showing, and its identity.
 *
 * There are two sources - a comment jump ("take me to this thread") and find stepping its ring
 * - and the frame can only show ONE outline, because `missionJump` removes the previous target
 * as it sets the next. They used to post into the frame independently, from two effects, with
 * no arbitration except a one-time replay when the iframe reloaded: whichever fired last won,
 * and a live find reveal could silently displace a comment jump the reader had just asked for.
 *
 * The comment jump wins when both are live. It is an explicit navigation the reader performed,
 * where find's reveal follows the ring and is re-sent by the next step anyway.
 *
 * The `key` is what makes the posting effect fire exactly when the answer CHANGES: re-posting
 * an unchanged target would re-run the frame's smooth scroll under a reader who had scrolled
 * away from it. The nonce is part of the key on purpose, so asking for the same block twice -
 * a deep link followed again, or find stepping back onto it - is a new request rather than a
 * no-op.
 */
export function htmlRevealChoice(
  comment: HtmlRevealTarget | null,
  find: HtmlRevealTarget | null,
): { source: "comment" | "find"; target: HtmlRevealTarget; key: string } | null {
  const source = comment ? "comment" : find ? "find" : null;
  const target = comment ?? find;
  if (!source || !target) return null;
  const path = target.blockPath.map((step) => `${step.index}${step.tag}`).join("/");
  return { source, target, key: `${source}:${target.nonce}:${path}` };
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

export interface FileWorkspaceProps {
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
}

/**
 * Session upserts carry activity, cost, state, and transcript progress several times during
 * an active turn. Files reads only the session identity and display name, so those unrelated
 * fields must not redraw CodeMirror and every open comment-index row. That redraw is especially
 * expensive while Dispatch is also painting its controlled form on each keystroke.
 */
export function fileWorkspacePropsEqual(
  previous: FileWorkspaceProps,
  next: FileWorkspaceProps,
): boolean {
  return previous.session.id === next.session.id
    && previous.session.name === next.session.name
    && JSON.stringify(previous.session.workspace ?? null) === JSON.stringify(next.session.workspace ?? null)
    && previous.controller === next.controller
    && previous.fileCommentThreads === next.fileCommentThreads
    && previous.fileCommentReviews === next.fileCommentReviews
    && previous.fileLineRequest === next.fileLineRequest
    && previous.onExtract === next.onExtract
    && previous.extracted === next.extracted
    && previous.isOverlayOpen === next.isOverlayOpen
    && previous.ref === next.ref;
}

function FileWorkspaceBody({
  session,
  controller,
  fileCommentThreads = [],
  fileCommentReviews = [],
  fileLineRequest = null,
  onExtract,
  extracted = false,
  isOverlayOpen,
  ref,
}: FileWorkspaceProps): React.JSX.Element {
  const workspaceRef = useRef<HTMLElement>(null);
  const readOnlyWorkspace = session.workspace?.authority === "provider"
    && !session.workspace.capabilities.write;
  const fileNavRef = useRef<HTMLElement>(null);
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
  const commentable = buffer
    ? isCommentableDocument(buffer.document) && !readOnlyWorkspace
    : false;
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
  /**
   * A number naming the document currently in the frame, bumped whenever the source it is
   * built from changes - which is exactly when `srcDoc` is rebuilt and the frame navigates.
   *
   * Sent down with every find message and echoed back untouched, so a result says which
   * document it counted instead of the parent deciding on its arrival. That is not
   * belt-and-braces: a `srcDoc` navigation keeps the same WindowProxy, so a result queued by
   * the outgoing document passes the `event.source` check, and labelling it with the current
   * source would accept the old count for the new document.
   *
   * A counter rather than the source string because it travels over `postMessage` on every
   * keystroke, and a token only has to differ - it never has to be read.
   */
  const previewTokenRef = useRef({ text: previewText, token: 0 });
  if (previewTokenRef.current.text !== previewText) {
    previewTokenRef.current = {
      text: previewText,
      token: previewTokenRef.current.token + 1,
    };
  }
  const previewToken = previewTokenRef.current.token;
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
    anchor: {
      startLine: number;
      endLine: number;
      quote: string;
      htmlBlockPath?: HtmlBlockPathStep[] | null;
      htmlBlockQuote?: string | null;
    },
    surface: "markdown" | "html",
    revision?: string | null,
  ): void => {
    const onLine = allThreadLines.get(anchor.startLine) ?? [];
    const existing = threadForRenderedBlock(onLine, anchor, surface);
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

  /*
   * ---- find in this document ----
   *
   * The workspace owns the session and the chord, which is what makes find work in the
   * extracted window and in the console and board details alike - `App.tsx` stands every
   * session chord down while an overlay is open, and `FileWindow` is an overlay.
   *
   * The session holds the query, the case flag and the index, and DELIBERATELY no hits: each
   * surface searches the string it renders. The Editor shows source, so its hits are offsets
   * into `buffer.text`. Markdown preview shows rendered text, so its hits are the marks
   * `rehypeFindMarks` actually produced and reported back. Those two counts can legitimately
   * differ on the same file - `[label](matching-url)` is one occurrence in the source and
   * none on screen - and each is honest about what its surface shows. A shared,
   * source-derived count would have offered the reader a match Preview cannot highlight or
   * step to, which is the one invariant this feature rests on.
   *
   * What survives the Preview/Editor toggle is the query and the case flag, plus the reader's
   * place carried across BY SOURCE LINE - the same neighbourhood, not the same character,
   * which is what these two surfaces can honestly promise each other.
   *
   * The HTML preview is the third surface and the only one this origin cannot read, so it
   * reports rather than being searched: its bridge counts what it painted and posts the
   * number back. Its hits therefore have no source line and no key here at all - see
   * `htmlInFrame`, which is also the one switch back to the block-reveal fallback for a frame
   * that cannot highlight.
   */
  const [find, setFind] = useState<DocumentFindSession | null>(null);
  /** Bumped to put the caret back in the query box when the chord is pressed again. */
  const [findFocus, setFindFocus] = useState(0);
  /** Bumped only by deliberate find navigation. See `FileEditor`'s `scrollNonce`. */
  const [findScrollNonce, setFindScrollNonce] = useState(0);
  /** What the rehype plugin drew, in document order. Preview's whole model. */
  const [renderedFindHits, setRenderedFindHits] = useState<readonly MarkdownFindHit[]>([]);
  /**
   * A source line the reader's place is being carried TO, across a surface change.
   *
   * Held rather than applied immediately, because the new surface's hits are not available in
   * the same tick: Markdown preview's arrive from the plugin after it has rendered. Resolved
   * on the first render that has hits to resolve against.
   */
  const [pendingFindLine, setPendingFindLine] = useState<number | null>(null);
  /**
   * What the sandboxed preview's find bridge has told us about ITSELF, or null before it has.
   *
   * `highlight` is a CAPABILITY, not a result. A frame that cannot register CSS custom
   * highlights still announces itself, and answering a matching query with a count of zero
   * would leave the reader no highlight, no block reveal, and a number saying there is
   * nothing to find. So the block-reveal fallback and the bar's "by block" note are retired
   * only on `highlight === true`, and every announcement replaces the last - a reload, or a
   * frame that has lost the API, is free to say so again.
   *
   * Keyed on nothing but the bridge's own message (`HTML_PREVIEW_FIND_READY_MESSAGE`), never
   * the comment bridge's: that one is posted by the second of four injected scripts and
   * cannot speak for the fourth.
   */
  const [htmlFindBridge, setHtmlFindBridge] = useState<{
    highlight: boolean;
    /** The nonce that document minted for itself, from its own ready message. */
    nonce: string;
    /** The parent's document counter at the moment that ready arrived. */
    token: number;
  } | null>(null);
  /**
   * The count the frame reported, with the query it counted.
   *
   * The query rides along so a reply to a state the reader has already moved past is dropped
   * rather than shown: keeping the number we have beats replacing it with a fresher-looking
   * wrong one for a frame or two.
   */
  const [htmlFindResult, setHtmlFindResult] = useState<FrameFindResult | null>(null);
  /** Which string find is searching right now, or null when there is nothing to search. */
  const findSurface: "markdown" | "html" | "source" | null =
    buffer?.document.text == null || comparing
      ? null
      : markdownShowing
        ? "markdown"
        : htmlShowing
          ? "html"
          : sourceShowing
            ? "source"
            : null;
  /**
   * The source-side hits, for the Editor and for the HTML preview.
   *
   * The HTML preview searches `buffer.text` rather than `previewText` because `previewText`
   * is the debounced, stylesheet-inlined rendering - not the document's own bytes - and the
   * line a block is resolved from has to be a line of the file. `previewRevision` travels
   * with the resolve for the same snapshot reason the comment path states.
   */
  const sourceFindHits = useMemo((): DocumentHit[] => {
    if (!find || find.query === "" || findSurface === "markdown" || findSurface === null) {
      return [];
    }
    return documentHits(
      buffer?.text ?? "",
      find.query,
      { caseSensitive: find.caseSensitive },
      "source",
    );
  }, [buffer?.text, find, findSurface]);
  /**
   * The HTML surface's ring, over the locations it can actually reach.
   *
   * See `hitLinesByBlock`. Two occurrences on one source line are indistinguishable to a
   * resolver that is asked for a line, so offering them as two entries promised a step that
   * could not happen - and could reveal the block belonging to the other one.
   */
  const htmlFindLines = useMemo(
    (): number[] => (findSurface === "html" ? hitLinesByBlock(sourceFindHits) : []),
    [findSurface, sourceFindHits],
  );
  /**
   * Whether the HTML surface's find is being answered INSIDE the frame right now.
   *
   * The one switch between the two HTML behaviours, so nothing can retire half of the
   * fallback. False - before the bridge announces itself, after a reload that has not yet
   * re-announced, and permanently in a frame that declared it cannot highlight - keeps the
   * whole of Phase 1: the source-derived count, the by-block ring, the daemon resolve, the
   * target reveal, and the bar's note. True replaces all of it with the frame's own count
   * over the text it actually painted.
   */
  const htmlInFrame = findSurface === "html" && htmlFindBridge?.highlight === true;
  /**
   * The frame's count for the query the bar is holding RIGHT NOW, or null while its reply for
   * that query is still in flight. See `frameFindCount`, which owns the reasoning.
   *
   * Only a query or case-flag change opens that window; stepping the ring leaves both alone,
   * so the count never goes unknown under a reader pressing Enter.
   */
  /**
   * The nonce of the document the frame is showing RIGHT NOW, or null when there is not one
   * this origin can vouch for.
   *
   * Two facts have to agree, and each covers what the other cannot. The frame's nonce is the
   * only identity the outgoing document cannot forge for its successor. The parent's token is
   * the only thing that knows a reload is PENDING - the source changed, so whatever announced
   * itself last is describing a document that is being replaced. Requiring both means a count
   * is attributed to a document only while the parent's own view of what is mounted still
   * matches the document that introduced itself.
   */
  const liveFindNonce = htmlFindBridge && htmlFindBridge.token === previewToken
    ? htmlFindBridge.nonce
    : null;
  const htmlFrameCount = htmlInFrame
    ? frameFindCount(htmlFindResult, find, liveFindNonce)
    : 0;
  /**
   * Null when the surface on screen cannot yet say how many matches it has.
   *
   * Only the frame-reported surface can be in that state - every other surface searches a
   * string this origin holds, so its count is available in the same render.
   */
  const findCountKnown = findSurface !== "html" || !htmlInFrame || htmlFrameCount !== null;
  const findCount = findSurface === "markdown"
    ? renderedFindHits.length
    : findSurface === "html"
      ? (htmlInFrame ? htmlFrameCount ?? 0 : htmlFindLines.length)
      : sourceFindHits.length;
  /** Clamped here rather than on the way in, because hits move under a stored index. */
  const findIndex = findCount === 0 ? -1 : Math.min(Math.max(find?.index ?? 0, 0), findCount - 1);
  const findCurrentKey = findSurface === "markdown"
    ? renderedFindHits[findIndex]?.key ?? null
    : findSurface === "html"
      // In-frame find has no key this origin can hold: the hit is a Range inside a document
      // it cannot read, addressed by ordinal and nothing else. In the fallback the key is
      // namespaced like every other surface's and keyed on the line, because the line is the
      // whole of what block reveal can address.
      ? (htmlInFrame || htmlFindLines[findIndex] === undefined
        ? null
        : `block:${htmlFindLines[findIndex]}`)
      : sourceFindHits[findIndex]?.key ?? null;
  /**
   * The source line of every hit on the active surface, in the same order.
   *
   * Nullable per hit: a rendered hit reports the range of the block it sits in, and the
   * parser does not place every node. A missing line is not an excuse to guess one, so it is
   * simply not a candidate for the toggle to land on.
   */
  const findHitLines = useMemo((): (number | null)[] =>
    findSurface === "markdown"
      ? renderedFindHits.map((hit) => hit.range?.startLine ?? null)
      : findSurface === "html"
        // In-frame find reports ordinals over RENDERED text, and this origin cannot map one
        // back to a source line - the frame never sees the file's bytes. Null per hit rather
        // than reusing the by-block lines: those are ordinals over a different set (source
        // occurrences, including ones the page does not show), so lining them up would carry
        // the reader to a match they had not selected. A null is not a candidate, so the
        // toggle starts the new surface's ring at its first hit, which is honest.
        ? (htmlInFrame ? Array.from({ length: findCount }, () => null) : htmlFindLines)
        : sourceFindHits.map((hit) => hit.line),
  [findCount, findSurface, htmlFindLines, htmlInFrame, renderedFindHits, sourceFindHits]);
  // Read through refs by the callbacks below, refreshed during render for the reason every
  // other ref in this file is: the very first press after a state change uses current values.
  const findCountRef = useRef(findCount);
  findCountRef.current = findCount;
  const findIndexRef = useRef(findIndex);
  findIndexRef.current = findIndex;
  /**
   * The last place the reader actually was, and WHICH SURFACE it was on.
   *
   * The surface is not bookkeeping, it is the fix for a real defect. This ref used to hold a
   * bare line and be written on every render, and the render that switches surfaces already
   * has the NEW surface's hits: `sourceFindHits` is a memo over `buffer.text`, so on the first
   * Editor render `findHitLines` is already source lines and the old index still selects one
   * of them. The write therefore overwrote the outgoing line with a source line at the old
   * ordinal before the surface-change effect below could read it - and those disagree exactly
   * when Markdown hides an occurrence, which is the case the whole per-surface model exists
   * for. Selecting Preview's second visible hit after a link-destination match landed the
   * Editor on that hidden destination.
   *
   * Writing only while the recorded surface is still the surface on screen is what preserves
   * the outgoing value for one render, which is all the effect needs.
   */
  const findLineRef = useRef<{ surface: typeof findSurface; line: number | null }>({
    surface: findSurface,
    line: null,
  });
  const currentFindLine = findHitLines[findIndex] ?? null;
  if (findLineRef.current.surface === findSurface && currentFindLine !== null) {
    findLineRef.current = { surface: findSurface, line: currentFindLine };
  }

  /**
   * The last query and case flag, surviving a CLOSE of the bar.
   *
   * Reopening find restores them - selected, so typing replaces rather than appends - which
   * is what every browser's find does and what the transcript's bar already does through its
   * own retained session. Held in a ref rather than in state because nothing renders it while
   * find is closed. Reset with the session when another file is selected.
   */
  const lastFindRef = useRef<{ query: string; caseSensitive: boolean }>({
    query: "",
    caseSensitive: false,
  });
  const openFind = useCallback((): void => {
    setFind((session) => session ?? { ...lastFindRef.current, index: 0 });
    setFindFocus((nonce) => nonce + 1);
  }, []);
  const closeFind = useCallback((): void => {
    setFind(null);
    setPendingFindLine(null);
    setRenderedFindHits([]);
    // The frame's count goes with the session. Its highlight is cleared by the empty query
    // the posting effect sends next, which is the same code path a cleared query takes.
    setHtmlFindResult(null);
  }, []);
  const stepFind = useCallback((direction: 1 | -1): void => {
    setPendingFindLine(null);
    setFind((session) => session
      ? {
        ...session,
        index: Math.max(0, stepIndex(findCountRef.current, findIndexRef.current, direction)),
      }
      : session);
    setFindScrollNonce((nonce) => nonce + 1);
  }, []);
  /** A new query or a flipped case flag starts the ring again, at the top. */
  const reviseFind = useCallback((patch: Partial<DocumentFindSession>): void => {
    setPendingFindLine(null);
    setFind((session) => {
      if (!session) return session;
      const next = { ...session, ...patch, index: 0 };
      lastFindRef.current = { query: next.query, caseSensitive: next.caseSensitive };
      return next;
    });
    setFindScrollNonce((nonce) => nonce + 1);
  }, []);
  /**
   * Stable, because `markdownPropsEqual` compares it by identity: a fresh closure each render
   * would re-parse the whole document on every workspace render, which is exactly what the
   * `Markdown` memo exists to prevent.
   */
  const reportRenderedFindHits = useCallback((hits: MarkdownFindHit[]): void => {
    setRenderedFindHits(hits);
  }, []);
  const markdownFind: MarkdownFindRequest | undefined = find && findSurface === "markdown"
    ? {
      query: find.query,
      caseSensitive: find.caseSensitive,
      currentKey: findCurrentKey,
      onHits: reportRenderedFindHits,
    }
    : undefined;
  /**
   * The Editor's find owner.
   *
   * Supplied whenever this workspace hosts the editor, open or closed, because the chord has
   * to be answerable before the bar exists. `FileEditor` reads its PRESENCE as the signal to
   * claim CodeMirror's panel-opening bindings, and the three other hosts of that component
   * pass nothing and keep the panel they have today.
   */
  const answerEditorFindChord = useCallback((action: "open" | "next" | "previous"): void => {
    if (action === "open") {
      openFind();
      return;
    }
    // Find-next and find-previous with nothing open is still a request to find: opening is
    // the only answer that is not silence, and silence is what a claimed chord must never be.
    if (findCountRef.current === 0 && findIndexRef.current < 0) {
      openFind();
      return;
    }
    stepFind(action === "next" ? 1 : -1);
  }, [openFind, stepFind]);
  const editorFind: FileEditorFind = {
    hits: findSurface === "source" ? sourceFindHits : [],
    currentIndex: findSurface === "source" ? findIndex : -1,
    scrollNonce: findScrollNonce,
    onChord: answerEditorFindChord,
  };

  /*
   * The chord, claimed AHEAD of App's `findInConversation`.
   *
   * App's handler returns early on `e.defaultPrevented` and listens in the bubble phase, so a
   * capture-phase listener here is what stops Cmd+F switching the detail to the Conversation
   * tab - which is what it does today, because the Files tab mounts no transcript and the
   * handler falls through to `requestConversationTab`.
   *
   * Three departures from the workspace's other chords, each earned:
   * - it stays live while `extracted`, because those are bare letters and this carries a
   *   modifier - and App stands every session chord down while the overlay is open, so
   *   nothing else would answer;
   * - it fires from inside a typing element, because the caret is in CodeMirror's
   *   `contentEditable` whenever the reader is in the Editor, which is precisely when they
   *   want find;
   * - it accepts `ctrl+f` as well as the resolved binding. `chordFromEvent` does no platform
   *   normalization, so the default `cmd+f` genuinely does not match Ctrl+F, and the ask
   *   names both keys.
   *
   * It also claims FIND-NEXT and FIND-PREVIOUS, not only the open chord, and it has to: only
   * `FileEditor` installs those, so with find open over a Markdown or HTML preview - where no
   * CodeMirror exists - F3 and Mod-G fell through to the browser instead of stepping this
   * document's ring, while the documentation said they step it. `editorFindChord` is the same
   * predicate the editor uses, so the two owners cannot drift on which chord means what.
   *
   * Go-to-line is deliberately NOT claimed here. In the editor it is claimed and left inert
   * because it would otherwise open a panel this surface no longer has; over a preview there
   * is no panel to protect, and swallowing the chord would be over-reach.
   */
  const { bindings } = useKeybindings();
  const findChord = bindings.findInConversation;
  useEffect(() => {
    if (findSurface === null) return;
    function onKeyDown(event: KeyboardEvent): void {
      const chord = chordFromEvent(event);
      const bound = chord === findChord || chord === "cmd+f" || chord === "ctrl+f";
      const claimed = editorFindChord(event);
      const action = bound
        ? "open"
        : claimed === "next" || claimed === "previous"
          ? claimed
          : null;
      if (action === null) return;
      // The integrated tab stands down while the extracted window is up, exactly as the
      // bare-letter chords above it do, so two mounted workspaces cannot both answer.
      if (!extracted && isOverlayOpen?.() === true) return;
      event.preventDefault();
      // Stops App, and in the Editor it also stops `FileEditor`'s own handler - so a chord is
      // answered once, by whichever owner sees it first, never twice.
      event.stopImmediatePropagation();
      if (action === "open") openFind();
      else answerEditorFindChord(action);
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [answerEditorFindChord, extracted, findChord, findSurface, isOverlayOpen, openFind]);

  /*
   * Carry the reader's place across a surface change, by line.
   *
   * Recorded when the surface changes and spent when the new surface has hits, because the
   * two do not happen in the same tick. Where no line was known - the parser placed no
   * position for the block a rendered hit sat in - the query still survives and the ring
   * starts at the first hit, rather than landing somewhere invented.
   */
  useEffect(() => {
    // The ref carries the surface, so it IS the record of which one we were on - there is no
    // second piece of state to keep in step with it.
    const outgoing = findLineRef.current;
    if (outgoing.surface === findSurface) return;
    findLineRef.current = { surface: findSurface, line: null };
    if (!find || find.query === "" || outgoing.surface === null || findSurface === null) return;
    setPendingFindLine(outgoing.line);
  }, [find, findSurface]);
  useEffect(() => {
    if (pendingFindLine === null) return;
    // Nothing to resolve against yet. Preview's hits arrive one render after the plugin ran,
    // and spending the request against an empty list would land on the first hit every time.
    if (findCount === 0) return;
    const at = findHitLines.findIndex((line) => line !== null && line >= pendingFindLine);
    setPendingFindLine(null);
    setFind((session) => session ? { ...session, index: at >= 0 ? at : 0 } : session);
    setFindScrollNonce((nonce) => nonce + 1);
  }, [findCount, findHitLines, pendingFindLine]);

  /*
   * A surface find cannot search closes it.
   *
   * Opening the conflict Compare panes, or landing on an image, leaves nothing to search. A bar
   * that stayed would sit there reading "No results" over a document it was never searching -
   * a count that is not wrong so much as meaningless.
   */
  useEffect(() => {
    if (find && findSurface === null) closeFind();
  }, [closeFind, find, findSurface]);

  /*
   * Another document starts a clean session.
   *
   * Its own effect rather than a line in the selection effect above, because that effect is
   * declared before this session exists. The Preview/Editor toggle is the case that must NOT
   * reset - see the find session's own comment.
   */
  useEffect(() => {
    lastFindRef.current = { query: "", caseSensitive: false };
    // Two HTML documents in a row keep the same mounted iframe, so the bridge's report has to
    // be dropped with the session: it was about the document that just left.
    setHtmlFindBridge(null);
    closeFind();
  }, [closeFind, selectedPath, session.id]);

  /* Put the current mark in view, in the surface that drew it. */
  useEffect(() => {
    if (findSurface !== "markdown" || findCurrentKey === null) return;
    const reader = workspaceRef.current?.querySelector<HTMLElement>(".file-markdown-preview");
    // The first fragment of the hit, which is the one a split hit's jump anchors to - all of
    // its fragments carry the same key. `mark.find-hit` already reserves scroll margin so a
    // jump never parks the hit under the floating bar.
    reader
      ?.querySelector(`[${FIND_KEY_ATTRIBUTE}="${findCurrentKey}"]`)
      ?.scrollIntoView({ block: "center" });
  }, [findCurrentKey, findSurface, previewText]);

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
      blockPath: thread.htmlBlockPath ?? undefined,
      blockQuote: thread.htmlBlockQuote ?? undefined,
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
  useEffect(() => {
    armFrame(htmlCommenting);
  }, [armFrame, htmlCommenting]);

  /*
   * An HTML match, revealed by BLOCK - the FALLBACK, for a frame that cannot mark its own.
   *
   * This is the whole of what an origin can do from outside a document it cannot read: find
   * counts over the file's own source, and the current hit's line is resolved to a rendered
   * block by the daemon (`resolveHtmlBlockTarget`), then revealed with the same
   * `HTML_PREVIEW_TARGET_MESSAGE` the comment jump uses.
   *
   * It is no longer the only path - see `htmlInFrame` and the find bridge below - but it is
   * still the right one whenever the frame has not said it can highlight: before it has
   * announced itself, after a reload that has not re-announced, and permanently in a frame
   * without the CSS Custom Highlight API. There is no state in which a reader gets no
   * highlight, no block reveal and a count of zero.
   *
   * The bar says so while this path is live, because the count is taken over source and can
   * therefore include matches the rendered page does not show. `htmlInFrame` retires the note
   * and the reveal together, so the caveat and the behaviour it describes cannot part company.
   *
   * A failed resolve is not reported. There is exactly one cause - the file moved under a
   * render still on screen, which is the debounce window - and a reader stepping matches gets
   * the count and the ring either way; raising the comment path's refusal notice for a
   * keystroke would be louder than the thing that went wrong.
   */
  const htmlFindRequests = useRef(0);
  /**
   * STATE rather than a ref, because it is now an input to the one reveal decision below.
   *
   * As a ref it was written and read by two effects that each posted into the frame on their
   * own, which is what let a find reveal displace a live comment jump - see `htmlRevealChoice`.
   */
  const [htmlFindTarget, setHtmlFindTarget] = useState<HtmlRevealTarget | null>(null);
  const currentHtmlFindLine = htmlInFrame || findSurface !== "html"
    ? null
    : htmlFindLines[findIndex] ?? null;
  useEffect(() => {
    if (findSurface !== "html" || !previewPath || currentHtmlFindLine === null) {
      // Find has nothing to reveal - closed, no matches, or another surface. Dropping the
      // target hands the frame back to the comment jump if one is live.
      setHtmlFindTarget(null);
      return;
    }
    let live = true;
    htmlFindRequests.current += 1;
    const request = htmlFindRequests.current;
    void resolveHtmlBlockTarget(session.id, {
      path: previewPath,
      startLine: currentHtmlFindLine,
      endLine: currentHtmlFindLine,
      revision: previewRevision,
    }).then((result) => {
      if (!live || request !== htmlFindRequests.current || !result.ok) return;
      setHtmlFindTarget({ blockPath: result.blockPath, nonce: request });
    });
    return () => { live = false; };
  }, [
    currentHtmlFindLine,
    findSurface,
    previewPath,
    previewRevision,
    session.id,
  ]);

  /*
   * ONE owner of what the frame is showing.
   *
   * Both sources feed `htmlRevealChoice` and this single effect posts its answer, so the last
   * DECISION wins rather than the last effect to run. It fires only when the answer's key
   * changes, because re-posting an unchanged target would re-run the frame's smooth scroll
   * under a reader who had scrolled away from it.
   *
   * **What this cannot do is clear an outline**, and that limit is `missionJump`'s: it removes
   * the previous target only as it sets a new one, and a path that walks nowhere resolves to
   * `document.body` - so posting "nothing" would outline the whole page rather than clear it.
   * Dropping find's target restores the comment jump's block when one is live, and where
   * neither source has a target the last outline stays until the frame reloads.
   *
   * The find bridge does not inherit that limit, because it never sets an outline: it paints
   * `Range` objects through `CSS.highlights`, which a message with an empty query clears
   * outright. So a stale outline is now only ever the fallback's, and only in a frame that
   * cannot highlight.
   */
  const htmlReveal = htmlRevealChoice(htmlTarget, htmlFindTarget);
  const htmlRevealKey = htmlReveal?.key ?? "";
  const htmlRevealRef = useRef(htmlReveal);
  htmlRevealRef.current = htmlReveal;
  const postedRevealKey = useRef("");
  useEffect(() => {
    if (!htmlReveal || htmlRevealKey === postedRevealKey.current) return;
    postedRevealKey.current = htmlRevealKey;
    revealHtmlTarget(htmlReveal.target);
  }, [htmlReveal, htmlRevealKey, revealHtmlTarget]);
  useEffect(() => {
    if (!previewPath) return;
    const onReady = (event: MessageEvent): void => {
      if ((event.data as { type?: unknown } | null)?.type !== HTML_PREVIEW_READY_MESSAGE) return;
      const frame = workspaceRef.current?.querySelector<HTMLIFrameElement>(
        ".file-content .html-preview",
      );
      if (!frame || event.source !== frame.contentWindow) return;
      armFrame(commentingRef.current);
      /*
       * A reloaded document has no outline at all, so the current decision is re-posted -
       * through the same `htmlRevealChoice` the effect above uses, rather than a second rule
       * that could disagree with it. The posted key is cleared first because this is the one
       * case where an UNCHANGED target must be sent again.
       */
      postedRevealKey.current = "";
      const reveal = htmlRevealRef.current;
      if (reveal) {
        postedRevealKey.current = reveal.key;
        revealHtmlTarget(reveal.target);
      }
    };
    window.addEventListener("message", onReady);
    return () => window.removeEventListener("message", onReady);
  }, [armFrame, previewPath, revealHtmlTarget]);

  /*
   * ---- find INSIDE the frame ----
   *
   * The block reveal above is what this origin can do from outside a document it cannot read.
   * The find bridge moves the work to the one context that knows what it painted, so an HTML
   * match is marked where it is, counted only when a reader can see it, and stepped like any
   * other surface's. `htmlInFrame` is the single switch between the two, so the fallback is
   * retired whole or not at all.
   *
   * The handshake is `armFrame`'s, deliberately, rather than a second shape: the frame
   * announces its OWN readiness and this answers with the current state. That one exchange
   * covers find opened before the document loaded, find already open when an HTML file is
   * selected, and the `srcDoc` reload that follows every debounced edit - which destroys the
   * highlight along with the document, and which a parent that only posted on change would
   * never restore.
   *
   * Nothing here keys off `HTML_PREVIEW_READY_MESSAGE`. That is the comment bridge's, posted
   * by the second of four injected scripts, so it cannot speak for the fourth.
   */
  const htmlFindPost = useMemo(
    () => (find && htmlShowing
      ? {
        query: find.query,
        caseSensitive: find.caseSensitive,
        // See `frameFindIndex`: the clamped index while the count is known, the stored one
        // while it is not, because clamping against a ring of unknown size posts 0 and moves
        // the reader.
        index: frameFindIndex(find, findIndex, findCountKnown),
      }
      : null),
    [find, findCountKnown, findIndex, htmlShowing],
  );
  const postFindToFrame = useCallback(
    (post: { query: string; caseSensitive: boolean; index: number } | null): void => {
      const frame = workspaceRef.current?.querySelector<HTMLIFrameElement>(
        ".file-content .html-preview",
      );
      // An empty query IS the clear, so a closed bar and a cleared query take one path in the
      // frame and it can never be left highlighting something the bar no longer holds.
      frame?.contentWindow?.postMessage({
        type: HTML_PREVIEW_FIND_MESSAGE,
        query: post?.query ?? "",
        caseSensitive: post?.caseSensitive ?? false,
        index: post?.index ?? 0,
      }, "*");
    },
    [],
  );
  useEffect(() => {
    if (!htmlShowing) return;
    postFindToFrame(htmlFindPost);
  }, [htmlFindPost, htmlShowing, postFindToFrame]);
  const htmlFindPostRef = useRef(htmlFindPost);
  htmlFindPostRef.current = htmlFindPost;
  const findSessionRef = useRef(find);
  findSessionRef.current = find;
  useEffect(() => {
    if (!previewPath) return;
    const onFindReady = (event: MessageEvent): void => {
      const data = event.data as {
        type?: unknown;
        highlight?: unknown;
        nonce?: unknown;
      } | null;
      if (data?.type !== HTML_PREVIEW_FIND_READY_MESSAGE) return;
      if (typeof data.nonce !== "string" || data.nonce === "") return;
      const frame = workspaceRef.current?.querySelector<HTMLIFrameElement>(
        ".file-content .html-preview",
      );
      if (!frame || event.source !== frame.contentWindow) return;
      // Every announcement replaces the last, so a reloaded frame - or one that has lost the
      // highlight API - is free to say so again and be believed. The token recorded beside the
      // nonce is what makes a later source change invalidate this pairing without needing a
      // second message: see `liveFindNonce`.
      setHtmlFindBridge({
        highlight: data.highlight === true,
        nonce: data.nonce,
        token: previewTokenRef.current.token,
      });
      postFindToFrame(htmlFindPostRef.current);
    };
    window.addEventListener("message", onFindReady);
    return () => window.removeEventListener("message", onFindReady);
  }, [postFindToFrame, previewPath]);
  useEffect(() => {
    if (!previewPath) return;
    const onFindResult = (event: MessageEvent): void => {
      const data = event.data as {
        type?: unknown;
        query?: unknown;
        caseSensitive?: unknown;
        count?: unknown;
        nonce?: unknown;
      } | null;
      if (data?.type !== HTML_PREVIEW_FIND_RESULT_MESSAGE) return;
      const frame = workspaceRef.current?.querySelector<HTMLIFrameElement>(
        ".file-content .html-preview",
      );
      if (!frame || event.source !== frame.contentWindow) return;
      if (!Number.isInteger(data.count) || typeof data.nonce !== "string") return;
      const session = findSessionRef.current;
      // A reply about a search the reader has already left is refused rather than shown. The
      // reported index is NOT adopted: the parent owns the ring, and clamping a stored index
      // against the count it just received gives the same answer without a feedback loop.
      if (
        !session
        || data.query !== session.query
        || (data.caseSensitive === true) !== session.caseSensitive
      ) return;
      setHtmlFindResult({
        query: session.query,
        caseSensitive: session.caseSensitive,
        count: data.count as number,
        // The counting document's OWN nonce, never anything read from this side. A result
        // queued by the document being replaced passes the source check above, and would echo
        // a parent-minted token just as readily, so this is the only field that can tell the
        // two documents apart. `frameFindCount` compares it against `liveFindNonce`.
        documentNonce: data.nonce,
      });
    };
    window.addEventListener("message", onFindResult);
    return () => window.removeEventListener("message", onFindResult);
  }, [previewPath]);
  /*
   * The chord, arriving as a message because a keystroke inside a sandbox cannot arrive as a
   * keystroke. One entry point, two ways in - the workspace's own listener and this.
   *
   * `event.source` is checked for a reason sharper than the other handlers': this message
   * OPENS A UI SURFACE, so it must not be actionable by an arbitrary sender. The extracted
   * files window renders a second workspace, and neither may be opened by the other's frame.
   */
  useEffect(() => {
    if (!previewPath) return;
    const onFindChord = (event: MessageEvent): void => {
      if ((event.data as { type?: unknown } | null)?.type !== HTML_PREVIEW_FIND_CHORD_MESSAGE) {
        return;
      }
      const frame = workspaceRef.current?.querySelector<HTMLIFrameElement>(
        ".file-content .html-preview",
      );
      if (!frame || event.source !== frame.contentWindow) return;
      openFind();
    };
    window.addEventListener("message", onFindChord);
    return () => window.removeEventListener("message", onFindChord);
  }, [openFind, previewPath]);
  /*
   * A frame that is not on screen has told us nothing about the document that is.
   *
   * Dropping both facts when the preview leaves is what keeps `htmlInFrame` a statement about
   * the frame currently mounted, rather than about one the reader has toggled away from. The
   * next frame re-announces, which is the whole point of the handshake.
   */
  useEffect(() => {
    if (htmlShowing) return;
    setHtmlFindBridge(null);
    setHtmlFindResult(null);
  }, [htmlShowing]);

  // A sandbox is a separate browsing context, so its keydown events never bubble to App.
  // The armed bridge claims only Preview's fixed navigation keys and sends exit back here,
  // where focus can return to the selected file without exposing the frame's document.
  //
  // With find open, that same exit closes find first. Escape inside the frame means "get me
  // out of the thing I am in", and the find bar is the innermost of those - the same layering
  // App's own Escape follows, and the same one the bar's Escape already applies from outside.
  useEffect(() => {
    if (!previewPath) return;
    const onKeyboard = (event: MessageEvent): void => {
      const data = event.data as { type?: unknown; action?: unknown } | null;
      if (data?.type !== HTML_PREVIEW_KEYBOARD_MESSAGE || data.action !== "exit") return;
      const frame = workspaceRef.current?.querySelector<HTMLIFrameElement>(
        ".file-content .html-preview",
      );
      if (!frame || event.source !== frame.contentWindow) return;
      if (findSessionRef.current) {
        closeFind();
        return;
      }
      focusCurrentFileRow(workspaceRef.current!);
    };
    window.addEventListener("message", onKeyboard);
    return () => window.removeEventListener("message", onKeyboard);
  }, [closeFind, previewPath]);

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
          {
            startLine: result.startLine,
            endLine: result.endLine,
            quote: result.quote,
            htmlBlockPath: result.blockPath,
            htmlBlockQuote: result.blockQuote,
          },
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
          quote={fileCommentQuoteForDisplay(
            composer.surface,
            composer.quote,
            composer.htmlBlockQuote,
          )}
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
          displayQuote={fileCommentQuoteForDisplay(
            openThread.surface,
            openThread.quote,
            openThread.htmlBlockQuote,
          )}
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
      <aside ref={fileNavRef} className="file-nav">
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

      <ResizablePaneDivider
        containerRef={workspaceRef}
        leadingPaneRef={fileNavRef}
        label="Resize file list"
        widthProperty="--file-list-width"
        minLeadingWidthProperty="--file-list-min-width"
      />

      <div className="file-main">
        {readOnlyWorkspace && (
          <p className="file-readonly-banner" role="status">
            Read-only Pipeline evidence from {session.workspace?.commit?.slice(0, 12) ?? "an unavailable commit"}
          </p>
        )}
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
              {!readOnlyWorkspace && (
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
              )}
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
          <OpenInMenu
            disabled={!buffer || readOnlyWorkspace}
            disabledReason={readOnlyWorkspace && buffer
              ? "Pinned Pipeline evidence is read-only"
              : undefined}
            busy={launching || pendingOpen !== null}
            onChoose={openIn}
          />
          {!extracted && onExtract && (
            <Tooltip label="Extract to a movable window"><button className="icon-btn file-extract" onClick={() => { controller.flush(session.id); onExtract(); }} aria-label="Extract files window">↗</button></Tooltip>
          )}
        </header>

        <div className={`file-reader-shell${showComments ? " has-comment-rail" : ""}`}>
          <div className={`file-content${commentOverlayShowing ? " is-commenting" : ""}`}>
          {find && (
            <FindBar
              label="Find in this document"
              note={findSurface === "html" && !htmlInFrame ? "by block" : null}
              query={find.query}
              onQuery={(query) => reviseFind({ query })}
              caseSensitive={find.caseSensitive}
              onCaseSensitive={(caseSensitive) => reviseFind({ caseSensitive })}
              count={findCountKnown ? findCount : null}
              index={findIndex}
              focusNonce={findFocus}
              onStep={stepFind}
              onClose={closeFind}
            />
          )}
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
                find={markdownFind}
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
              find={editorFind}
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

export const FileWorkspace = memo(FileWorkspaceBody, fileWorkspacePropsEqual);

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
