import { createPortal } from "react-dom";
import { Markdown } from "../components/Markdown.tsx";
import { Overlay, OVERLAY_IDS } from "../components/Overlay.tsx";
import { Tooltip } from "../components/Tooltip.tsx";
import type { ResidentStateView } from "./api.ts";

/** A previewed state file: its text once read, or why it could not be. */
export type ResidentStatePreview =
  | { path: string; state: "loading" }
  | { path: string; state: "ready"; text: string }
  | { path: string; state: "failed"; error: string };

/** Markdown state files render through the dashboard's renderer; everything else stays verbatim. */
export function isMarkdownStatePath(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path);
}

/** The file a fresh listing opens first: the auto-memory index when there is one. */
export function initialStatePath(view: ResidentStateView): string | null {
  return view.files.find(({ path }) => path === "MEMORY.md")?.path ?? view.files[0]?.path ?? null;
}

/**
 * A resident profile's durable state, read in a window of its own.
 *
 * The listing used to unfold inside the editor's last card, below the fold of a long page, so
 * clicking View state looked like it did nothing. The viewer opens over the editor instead, lists
 * every file beside a preview, and renders Markdown, which is what auto-memory and most notes are.
 * Reading never changes the files.
 *
 * Portaled to the body: inside the editor, its `.resident-editor p` and `.resident-section h4`
 * rules would reach the rendered Markdown and the modal's bands.
 */
export function ResidentStateViewer({
  profileName,
  view,
  preview,
  error,
  busy,
  onSelect,
  onRefresh,
  onClose,
}: {
  profileName: string;
  view: ResidentStateView | null;
  preview: ResidentStatePreview | null;
  error: string;
  busy: boolean;
  onSelect: (path: string) => void;
  onRefresh: () => void;
  onClose: () => void;
}): React.JSX.Element {
  return createPortal(
    <Overlay
      id={OVERLAY_IDS.residentState}
      onClose={onClose}
      className="modal resident-state-viewer"
      role="dialog"
      ariaModal
      ariaLabel={`Durable state: ${profileName}`}
    >
      <header className="modal-head">
        <div className="resident-state-viewer-title">
          <strong>{profileName}</strong>
          <span className="dim"> · Durable state</span>
        </div>
        <div className="resident-state-viewer-actions">
          <Tooltip label="Reload this profile’s saved state files">
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={onRefresh}>Refresh</button>
          </Tooltip>
          <Tooltip label="Close the state viewer. Nothing is changed (Escape)">
            <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
          </Tooltip>
        </div>
      </header>
      {view && <div className="modal-bleed resident-state-viewer-path"><span>{view.directory}</span></div>}
      {error && <p className="resident-error resident-state-viewer-error" role="alert">{error}</p>}
      <div className="modal-bleed resident-state-viewer-body">
        {!view ? (
          !error && <div className="resident-state-viewer-empty"><p className="dim" role="status">Loading saved state…</p></div>
        ) : view.files.length === 0 ? (
          <div className="resident-state-viewer-empty"><p className="dim">No saved state files. Notes, watermarks and auto-memory appear here once a run writes them.</p></div>
        ) : (
          <>
            <nav className="resident-state-viewer-files" aria-label="State files">
              <ul>
                {view.files.map(({ path }) => (
                  <li key={path}>
                    <Tooltip label={`Preview ${path} without changing it`}>
                      <button
                        type="button"
                        className={`resident-state-viewer-file${preview?.path === path ? " is-active" : ""}`}
                        aria-current={preview?.path === path ? "true" : undefined}
                        disabled={busy}
                        onClick={() => onSelect(path)}
                      >
                        {path}
                      </button>
                    </Tooltip>
                  </li>
                ))}
              </ul>
            </nav>
            <section
              className="resident-state-viewer-preview"
              aria-label={preview ? `State file ${preview.path}` : "State file preview"}
            >
              {!preview ? (
                <p className="dim">Choose a file to preview it.</p>
              ) : preview.state === "loading" ? (
                <p className="dim" role="status">Loading {preview.path}…</p>
              ) : preview.state === "failed" ? (
                <p className="resident-error" role="alert">{preview.error}</p>
              ) : isMarkdownStatePath(preview.path) ? (
                <article className="markdown resident-state-viewer-markdown">
                  <Markdown>{preview.text}</Markdown>
                </article>
              ) : (
                <pre>{preview.text}</pre>
              )}
            </section>
          </>
        )}
      </div>
    </Overlay>,
    document.body,
  );
}
