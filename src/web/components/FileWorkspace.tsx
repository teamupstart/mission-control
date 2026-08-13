import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { Session } from "@shared/types.ts";
import type { OpenTargetId } from "@shared/open-targets.ts";
import {
  hasUnwrittenEdits,
  isSavePending,
  type FileBuffer,
  type SessionFilesController,
} from "../lib/sessionFiles.ts";
import { FileEditor } from "./FileEditor.tsx";
import { Markdown } from "./Markdown.tsx";
import { OpenInMenu } from "./OpenInMenu.tsx";
import { api } from "../lib/api.ts";
import { COPY_FEEDBACK_LABEL, useCopyFeedback } from "../lib/clipboard.ts";
import { workspaceAssetPath } from "../lib/workspaceLinks.ts";
import { Tooltip } from "./Tooltip.tsx";

const PREVIEW_SCROLL_MESSAGE = "mission:file-preview-scroll";
const PREVIEW_SCROLL_SCRIPT = `addEventListener("message",event=>{if(event.source===parent&&event.data?.type==="${PREVIEW_SCROLL_MESSAGE}"&&typeof event.data.top==="number")scrollBy({top:event.data.top})})`;
const PREVIEW_SCROLL_SCRIPT_HASH = "boIuepZJzJEM7sUoJjNJy7i6nq6MHE3t38Bfnj4GnvM=";
/**
 * Every anchor click leaves the document through the parent, or not at all.
 *
 * A srcdoc document resolves relative hrefs against the DASHBOARD's URL, so letting one
 * navigate turns `<a href="b.html">` into a request the daemon answers with the SPA
 * fallback - a second dashboard shell inside the sandbox, whose assets the opaque origin
 * then CORS-blocks into a white pane. The `navigate-to` CSP directive that was meant to
 * stop this never shipped in any browser. So navigation is claimed here instead: every
 * non-fragment click is cancelled and its href posted up, and the parent decides whether
 * it names a checkout file worth selecting. Fragment links stay native - same-document
 * scrolling is the one navigation the sandbox does correctly.
 *
 * `composedPath` rather than `target.closest`, because a click inside an open shadow root
 * retargets to the host and a missed anchor here is not a dead link - it is the default
 * navigation going through, which is the white pane again.
 */
const PREVIEW_LINK_MESSAGE = "mission:file-preview-link";
const PREVIEW_LINK_SCRIPT = `document.addEventListener("click",event=>{const origin=event.composedPath()[0];const anchor=origin instanceof Element?origin.closest("a[href]"):null;if(!anchor)return;const href=anchor.getAttribute("href");if(!href||href.startsWith("#"))return;event.preventDefault();parent.postMessage({type:"${PREVIEW_LINK_MESSAGE}",href},"*")},true)`;
const PREVIEW_LINK_SCRIPT_HASH = "ADNimZ0/NOY6W/JTdVdn5R5DYWseUUp14To0zvMfzF4=";
const PREVIEW_CSP =
  `default-src 'none'; connect-src 'none'; script-src 'sha256-${PREVIEW_SCROLL_SCRIPT_HASH}' 'sha256-${PREVIEW_LINK_SCRIPT_HASH}'; style-src 'unsafe-inline'; img-src data: blob:; ` +
  "font-src data:; form-action 'none'; navigate-to 'none'";

export function htmlPreviewSource(source: string): string {
  const headContent = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}"><script>${PREVIEW_SCROLL_SCRIPT}</script><script>${PREVIEW_LINK_SCRIPT}</script>`;
  // This prefix must be parsed before a single checkout-controlled byte. Searching
  // for <head> is unsafe: a match inside an HTML comment can absorb the CSP and bridge,
  // after which `allow-scripts` would run the document's own JavaScript unrestricted.
  // The HTML parser supplies the implicit html/head elements here; a later doctype or
  // explicit head in a complete source document is harmless and cannot precede this CSP.
  return `<!doctype html>${headContent}${source}`;
}

interface StylesheetLink {
  index: number;
  length: number;
  path: string;
}

const MAX_PREVIEW_STYLESHEETS = 32;
const PREVIEW_STYLESHEET_CONCURRENCY = 4;

function htmlAttribute(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(
    `\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\u0060]+))`,
    "i",
  ));
  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : null;
}

function escapeHtmlAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

/** Find checkout-local stylesheet links without treating remote CSS as readable workspace data. */
function localStylesheets(source: string, documentPath: string): StylesheetLink[] {
  const found: StylesheetLink[] = [];
  for (const match of source.matchAll(/<link\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi)) {
    if (match.index == null) continue;
    const tag = match[0];
    const rel = htmlAttribute(tag, "rel") ?? "";
    if (!rel.split(/\s+/).some((part) => part.toLowerCase() === "stylesheet")) continue;
    const href = htmlAttribute(tag, "href");
    const path = href ? workspaceAssetPath(href, documentPath) : null;
    if (path) found.push({ index: match.index, length: tag.length, path });
  }
  return found;
}

/**
 * Inline local CSS before an HTML document enters its opaque sandbox.
 *
 * A srcDoc document otherwise resolves `theme.css` against the dashboard URL, which is
 * neither the checkout nor a file-serving endpoint. Keeping style-src inline-only is the
 * useful security boundary, so local CSS is read through the same contained session-file
 * API as the document and embedded rather than granting the iframe network access.
 */
export async function inlinePreviewStyles(
  source: string,
  documentPath: string,
  read: (path: string) => Promise<string | null>,
  signal?: AbortSignal,
): Promise<string> {
  const links = localStylesheets(source, documentPath);
  if (links.length === 0) return source;
  const paths = [...new Set(links.map((link) => link.path))].slice(0, MAX_PREVIEW_STYLESHEETS);
  const css = new Map<string, string | null>();
  let cursor = 0;
  await Promise.all(Array.from(
    { length: Math.min(PREVIEW_STYLESHEET_CONCURRENCY, paths.length) },
    async () => {
      while (!signal?.aborted) {
        const path = paths[cursor++];
        if (!path) return;
        css.set(path, await read(path));
      }
    },
  ));
  if (signal?.aborted) return source;
  let output = "";
  cursor = 0;
  for (let i = 0; i < links.length; i++) {
    const link = links[i]!;
    output += source.slice(cursor, link.index);
    const text = css.get(link.path);
    if (text != null) {
      const safe = text.replace(/<\/style/gi, "<\\/style");
      output += `<style data-mission-source="${escapeHtmlAttribute(link.path)}">\n${safe}\n</style>`;
    }
    cursor = link.index + link.length;
  }
  return output + source.slice(cursor);
}

function SaveStatus({ buffer }: { buffer: FileBuffer }): React.JSX.Element {
  const labels: Record<FileBuffer["saveState"], string> = {
    saved: "Saved", modified: "Modified", saving: "Saving…", offline: "Offline",
    failed: "Save failed", conflict: "Conflict", readonly: "Read only",
  };
  return <span className={`file-save-state is-${buffer.saveState}`}>{labels[buffer.saveState]}</span>;
}

export interface FileWorkspaceHandle {
  /** Move whichever file reader is visible (editor, preview, comparison, or list). */
  scrollByArrow: (direction: -1 | 1) => void;
}

function scrollElement(element: HTMLElement, direction: -1 | 1): void {
  element.scrollBy({ top: direction * Math.max(80, element.clientHeight * 0.18) });
}

export function scrollActiveFileReader(root: ParentNode, direction: -1 | 1): boolean {
  const contentReaders = root.querySelectorAll<HTMLElement>(
    ".file-content .cm-scroller, .file-content .file-markdown-preview, .file-content .file-compare pre",
  );
  if (contentReaders.length > 0) {
    contentReaders.forEach((element) => scrollElement(element, direction));
    return true;
  }
  const preview = root.querySelector<HTMLIFrameElement>(".file-content .html-preview");
  if (preview?.contentWindow) {
    preview.contentWindow.postMessage({
      type: PREVIEW_SCROLL_MESSAGE,
      top: direction * Math.max(80, preview.clientHeight * 0.18),
    }, "*");
    return true;
  }
  const list = root.querySelector<HTMLElement>(".file-list");
  if (!list) return false;
  scrollElement(list, direction);
  return true;
}

export function FileWorkspace({
  session,
  controller,
  onExtract,
  extracted = false,
  ref,
}: {
  session: Session;
  controller: SessionFilesController;
  onExtract?: () => void;
  extracted?: boolean;
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

  useEffect(() => controller.ensure(session.id), [controller.ensure, session.id]);
  useEffect(
    () => () => controller.flush(session.id),
    [controller.flush, session.id],
  );
  const files = state?.files ?? [];
  const selectedPath = state?.selectedPath ?? null;
  const buffer = selectedPath ? state?.buffers[selectedPath] : null;
  const mode = state?.mode ?? "preview";
  const previewable = buffer?.document.kind === "html" || buffer?.document.kind === "markdown";
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
      if (data?.type !== PREVIEW_LINK_MESSAGE || typeof data.href !== "string") return;
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

  useImperativeHandle(ref, () => ({
    scrollByArrow: (direction) => {
      const root = workspaceRef.current;
      if (root) scrollActiveFileReader(root, direction);
    },
  }), []);

  function choose(path: string): void {
    setComparing(false);
    controller.select(session.id, path);
  }

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
            to a screen reader and unassertable from a browser test. It is the only
            published signal that an HTML file lands on Preview and source lands on Editor.
          */}
          {previewable && (
            <div className="file-mode" role="group" aria-label="File view mode">
              <Tooltip label="Render this file rather than showing its source"><button className={mode === "preview" ? "on" : ""} aria-pressed={mode === "preview"} onClick={() => controller.setMode(session.id, "preview")}>Preview</button></Tooltip>
              <Tooltip label={buffer.document.editable ? "Edit this file's source" : "This file is not editable"}><button className={mode === "editor" ? "on" : ""} aria-pressed={mode === "editor"} disabled={!buffer.document.editable} onClick={() => controller.setMode(session.id, "editor")}>Editor</button></Tooltip>
            </div>
          )}
          <OpenInMenu disabled={!buffer} busy={launching || pendingOpen !== null} onChoose={openIn} />
          {!extracted && onExtract && (
            <Tooltip label="Extract to a movable window"><button className="icon-btn file-extract" onClick={() => { controller.flush(session.id); onExtract(); }} aria-label="Extract files window">↗</button></Tooltip>
          )}
        </header>

        <div className="file-content">
          {!selectedPath && <p className="file-empty">Choose a file from the checkout.</p>}
          {selectedPath && state?.openError && <p className="file-error">{state.openError}</p>}
          {selectedPath && !buffer && !state?.openError && <p className="file-empty">Loading {selectedPath}…</p>}
          {buffer && buffer.document.text == null && <p className="file-empty">{buffer.document.error ?? "This file cannot be opened."}</p>}
          {buffer?.document.text != null && buffer.document.kind === "html" && mode === "preview" && (
            <iframe className="html-preview" title={`Preview of ${buffer.document.path}`} sandbox="allow-scripts" srcDoc={htmlPreviewSource(previewText)} />
          )}
          {buffer?.document.text != null && buffer.document.kind === "markdown" && mode === "preview" && (
            <article className="file-markdown-preview markdown">
              <Markdown>{previewText}</Markdown>
            </article>
          )}
          {buffer?.document.text != null && (!previewable || mode === "editor") && !comparing && (
            <FileEditor
              path={buffer.document.path}
              value={buffer.text}
              readOnly={!buffer.document.editable || buffer.saveState === "conflict"}
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
