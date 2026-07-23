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
import { workspaceAssetPath } from "../lib/workspaceLinks.ts";

const PREVIEW_SCROLL_MESSAGE = "mission:file-preview-scroll";
const PREVIEW_SCROLL_SCRIPT = `addEventListener("message",event=>{if(event.source===parent&&event.data?.type==="${PREVIEW_SCROLL_MESSAGE}"&&typeof event.data.top==="number")scrollBy({top:event.data.top})})`;
const PREVIEW_SCROLL_SCRIPT_HASH = "boIuepZJzJEM7sUoJjNJy7i6nq6MHE3t38Bfnj4GnvM=";
const PREVIEW_CSP =
  `default-src 'none'; connect-src 'none'; script-src 'sha256-${PREVIEW_SCROLL_SCRIPT_HASH}'; style-src 'unsafe-inline'; img-src data: blob:; ` +
  "font-src data:; form-action 'none'; navigate-to 'none'";

export function htmlPreviewSource(source: string): string {
  const headContent = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}"><script>${PREVIEW_SCROLL_SCRIPT}</script>`;
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
  const [previewText, setPreviewText] = useState("");
  useEffect(() => {
    let live = true;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      const text = buffer?.text ?? "";
      if (buffer?.document.kind !== "html") {
        setPreviewText(text);
        return;
      }
      void inlinePreviewStyles(text, buffer.document.path, async (assetPath) => {
        const result = await api.readFile(session.id, assetPath, abort.signal);
        return result.ok ? result.file.text : null;
      }, abort.signal).then((next) => {
        if (live) setPreviewText(next);
      });
    }, 180);
    return () => {
      live = false;
      abort.abort();
      clearTimeout(timer);
    };
  }, [buffer?.document.kind, buffer?.document.path, buffer?.text, session.id]);
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
          <button className="icon-btn" onClick={() => controller.refresh(session.id)} title="Refresh files" aria-label="Refresh files">↻</button>
        </div>
        <div className="file-list" role="listbox" aria-label="Session files">
          {state?.listState === "loading" && files.length === 0 && <p className="file-empty">Loading files…</p>}
          {state?.listError && <p className="file-error">{state.listError}</p>}
          {shown.map((file) => (
            <button
              key={file.path}
              role="option"
              aria-selected={selectedPath === file.path}
              className={`file-row${selectedPath === file.path ? " on" : ""}`}
              title={file.path}
              onClick={() => choose(file.path)}
            >
              <span className="file-row-name">{file.path}</span>
              {state?.buffers[file.path] && state.buffers[file.path]!.saveState !== "saved" && (
                <span className={`file-row-mark is-${state.buffers[file.path]!.saveState}`} aria-hidden>●</span>
              )}
            </button>
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
          <span className="file-path mono" title={selectedPath ?? ""}>{selectedPath ?? "Select a file"}</span>
          {buffer && <span className="file-language">{buffer.document.language}</span>}
          {buffer && <span className="file-size">{formatBytes(buffer.document.size)}</span>}
          {buffer && <SaveStatus buffer={buffer} />}
          <span className="file-toolbar-spacer" />
          {previewable && (
            <div className="file-mode" role="group" aria-label="File view mode">
              <button className={mode === "preview" ? "on" : ""} onClick={() => controller.setMode(session.id, "preview")}>Preview</button>
              <button className={mode === "editor" ? "on" : ""} disabled={!buffer.document.editable} onClick={() => controller.setMode(session.id, "editor")}>Editor</button>
            </div>
          )}
          <OpenInMenu disabled={!buffer} busy={launching || pendingOpen !== null} onChoose={openIn} />
          {!extracted && onExtract && (
            <button className="icon-btn file-extract" onClick={() => { controller.flush(session.id); onExtract(); }} title="Extract to a movable window" aria-label="Extract files window">↗</button>
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
            <button className="btn" onClick={() => setLaunchError(null)}>Dismiss</button>
          </div>
        )}
        {buffer && (buffer.saveState === "failed" || buffer.saveState === "offline") && (
          <div className="file-notice">
            <span>{buffer.error ?? (buffer.saveState === "offline" ? "Waiting for the daemon to reconnect." : "The save did not complete.")}</span>
            <button className="btn" onClick={() => controller.retry(session.id, buffer.document.path)}>Retry</button>
          </div>
        )}
        {buffer?.conflict && (
          <div className="file-notice is-conflict">
            <span>{buffer.error ?? "This file changed outside Mission Control."}</span>
            <button className="btn" onClick={() => setComparing((value) => !value)}>{comparing ? "Back to editor" : "Compare"}</button>
            <button className="btn" disabled={buffer.conflict.deleted || buffer.conflict.text == null} onClick={() => {
              if (window.confirm("Discard local edits and reload the version on disk?")) controller.reloadDisk(session.id, buffer.document.path);
            }}>Reload disk</button>
            <button className="btn btn-danger" disabled={!buffer.conflict.revision} onClick={() => {
              if (window.confirm("Overwrite the newer file on disk with your local edits?")) controller.overwriteDisk(session.id, buffer.document.path);
            }}>Overwrite disk</button>
            <button className="btn" onClick={() => void navigator.clipboard.writeText(buffer.text)}>Copy local</button>
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
