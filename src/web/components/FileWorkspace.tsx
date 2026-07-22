import { useEffect, useMemo, useState } from "react";
import type { Session } from "@shared/types.ts";
import type { FileBuffer, SessionFilesController } from "../lib/sessionFiles.ts";
import { FileEditor } from "./FileEditor.tsx";

const PREVIEW_CSP =
  "default-src 'none'; connect-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; " +
  "font-src data:; form-action 'none'; navigate-to 'none'";

export function htmlPreviewSource(source: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`;
  const head = source.match(/<head(?:\s[^>]*)?>/i);
  if (head?.index != null) {
    const at = head.index + head[0].length;
    return source.slice(0, at) + meta + source.slice(at);
  }
  return `<!doctype html><html><head>${meta}</head><body>${source}</body></html>`;
}

function SaveStatus({ buffer }: { buffer: FileBuffer }): React.JSX.Element {
  const labels: Record<FileBuffer["saveState"], string> = {
    saved: "Saved", modified: "Modified", saving: "Saving…", offline: "Offline",
    failed: "Save failed", conflict: "Conflict", readonly: "Read only",
  };
  return <span className={`file-save-state is-${buffer.saveState}`}>{labels[buffer.saveState]}</span>;
}

export function FileWorkspace({
  session,
  controller,
  onExtract,
  extracted = false,
}: {
  session: Session;
  controller: SessionFilesController;
  onExtract?: () => void;
  extracted?: boolean;
}): React.JSX.Element {
  const state = controller.sessions[session.id];
  const [filter, setFilter] = useState("");
  const [manualPath, setManualPath] = useState("");
  const [comparing, setComparing] = useState(false);

  useEffect(() => controller.ensure(session.id), [controller.ensure, session.id]);
  useEffect(
    () => () => controller.flush(session.id),
    [controller.flush, session.id],
  );
  const files = state?.files ?? [];
  const selectedPath = state?.selectedPath ?? null;
  const buffer = selectedPath ? state?.buffers[selectedPath] : null;
  const mode = state?.mode ?? "preview";
  const [previewText, setPreviewText] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setPreviewText(buffer?.text ?? ""), 180);
    return () => clearTimeout(timer);
  }, [buffer?.text]);
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? files.filter((file) => file.path.toLowerCase().includes(q)) : files;
  }, [files, filter]);

  function choose(path: string): void {
    setComparing(false);
    controller.select(session.id, path);
  }

  return (
    <section className={`file-workspace${extracted ? " is-extracted" : ""}`} aria-label={`Files for ${session.name}`}>
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
          {buffer?.document.kind === "html" && (
            <div className="file-mode" role="group" aria-label="HTML view mode">
              <button className={mode === "preview" ? "on" : ""} onClick={() => controller.setMode(session.id, "preview")}>Preview</button>
              <button className={mode === "editor" ? "on" : ""} disabled={!buffer.document.editable} onClick={() => controller.setMode(session.id, "editor")}>Editor</button>
            </div>
          )}
          {!extracted && onExtract && (
            <button className="icon-btn file-extract" onClick={() => { controller.flush(session.id); onExtract(); }} title="Extract to a movable window" aria-label="Extract files window">↗</button>
          )}
        </header>

        <div className="file-content">
          {!selectedPath && <p className="file-empty">Choose a file from the checkout.</p>}
          {selectedPath && !buffer && <p className="file-empty">Loading {selectedPath}…</p>}
          {buffer && buffer.document.text == null && <p className="file-empty">{buffer.document.error ?? "This file cannot be opened."}</p>}
          {buffer?.document.text != null && buffer.document.kind === "html" && mode === "preview" && (
            <iframe className="html-preview" title={`Preview of ${buffer.document.path}`} sandbox="" srcDoc={htmlPreviewSource(previewText)} />
          )}
          {buffer?.document.text != null && (buffer.document.kind !== "html" || mode === "editor") && !comparing && (
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
