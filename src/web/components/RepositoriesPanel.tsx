import { useState } from "react";
import type { IndexedDirectoryView } from "@shared/repo-index.ts";
import type { RepoIndexState } from "../useRepoIndex.ts";
import { Tooltip } from "./Tooltip.tsx";

function directoryStatus(row: IndexedDirectoryView): string {
  switch (row.status) {
    case "ok": {
      const count = row.repoCount ?? 0;
      return `${count} ${count === 1 ? "repository" : "repositories"}`;
    }
    case "missing":
      return "not found";
    case "not-a-directory":
      return "not a directory";
    case "unreadable":
      return "unreadable";
  }
}

function DirectoryRow({
  row,
  environment,
  saved,
  disabled,
  onRemove,
}: {
  row: IndexedDirectoryView;
  environment?: boolean;
  saved?: boolean;
  disabled?: boolean;
  onRemove?: () => void;
}): React.JSX.Element {
  return (
    <li className={`ri-row${row.status === "ok" ? "" : " is-muted"}`}>
      <span className="ri-glyph" aria-hidden>{row.status === "missing" ? "▢" : "▤"}</span>
      <Tooltip
        label={row.resolved
          ? `Resolved path: ${row.resolved}`
          : `${row.path}: ${directoryStatus(row)}`}
      >
        <span className="ri-path">{row.path}</span>
      </Tooltip>
      <span className="ri-meta">
        {row.isDefault && <span className="ri-chip ri-chip-default">default</span>}
        {environment && <span className="ri-chip">from environment</span>}
        {!saved && (
          <span className={`ri-chip ri-chip-${row.status}`}>{directoryStatus(row)}</span>
        )}
      </span>
      {onRemove
        ? (
            <Tooltip label={`Stop indexing ${row.path}`}>
              <button className="ri-remove" type="button" disabled={disabled} onClick={onRemove}>
                Remove
              </button>
            </Tooltip>
          )
        : <span />}
    </li>
  );
}

function scanAge(scannedAt: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - scannedAt) / 1000));
  if (seconds < 2) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ago`;
}

/** Which directories the daemon walks for repository pickers and name resolution. */
export function RepositoriesPanel({ state }: { state: RepoIndexState }): React.JSX.Element {
  const { view, error, writing } = state;
  const [path, setPath] = useState("");
  const environment = view?.managedBy === "environment";
  const editable = view !== null && !environment;

  const add = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    const next = path.trim();
    if (!next) return;
    if (await state.addDirectory(next)) setPath("");
  };

  return (
    <section className="settings-section ri-panel">
      <p className="settings-hint settings-blurb">
        The directories this daemon walks looking for git checkouts. The dispatch repo picker,
        tasks filed by repository name through MCP, and Conductor install candidates all read
        this list. Indexing offers a checkout; it grants nothing. Trust stays separate.
      </p>

      {environment && (
        <div className="settings-warn">
          <strong>Set by the environment.</strong>{" "}
          This daemon was launched with <code>{view.environmentVariable}={view.environmentValue}</code>,
          which takes precedence over anything saved here. Unset it and restart the daemon to
          edit the saved list from this page.
        </div>
      )}

      <div className="settings-section-head">
        <h3>{environment ? "Directories indexed now" : "Indexed directories"}</h3>
        <p className="settings-hint">
          Found up to three levels down. Mission Control never descends into a checkout.
        </p>
      </div>

      <div data-anchor="repositories/directories">
        {view === null ? (
          <div className="ri-empty">
            <strong>Reading this machine...</strong>
            <span>The directory list is unknown until the daemon answers.</span>
          </div>
        ) : view.directories.length === 0 ? (
          <div className="ri-empty">
            <strong>{environment ? "The environment indexes nothing." : "Nothing is indexed."}</strong>
            <span>
              The dispatch repo picker offers no repositories, and tasks filed by repository name
              cannot resolve until a directory is added or restored.
            </span>
          </div>
        ) : (
          <ul className="ri-rows">
            {view.directories.map((row, index) => (
              <DirectoryRow
                key={`${row.path}-${index}`}
                row={row}
                environment={environment}
                disabled={writing}
                onRemove={editable ? () => void state.removeDirectory(row.path) : undefined}
              />
            ))}
          </ul>
        )}
      </div>

      {environment && view.savedDirectories.length > 0 && (
        <div className="ri-saved">
          <div className="settings-section-head">
            <h3>Saved here, currently ignored</h3>
            <p className="settings-hint">Kept intact for when the environment override is removed.</p>
          </div>
          <ul className="ri-rows">
            {view.savedDirectories.map((row, index) => (
              <DirectoryRow key={`${row.path}-${index}`} row={row} saved />
            ))}
          </ul>
        </div>
      )}

      {!environment && (
        <form className="ri-add" onSubmit={(event) => void add(event)}>
          <input
            className="field-input"
            type="text"
            value={path}
            placeholder="~/another-directory"
            aria-label="Directory to index"
            data-anchor="repositories/add"
            disabled={!editable || writing}
            onChange={(event) => setPath(event.target.value)}
          />
          <Tooltip label="Add this directory to repository discovery">
            <button className="btn btn-primary" type="submit" disabled={!editable || writing || !path.trim()}>
              Add directory
            </button>
          </Tooltip>
        </form>
      )}

      {!environment && (
        <p className="settings-hint ri-add-hint">
          A leading <code>~</code> means your home directory. A path that does not exist yet is
          saved and reported as <em>not found</em> rather than refused.
        </p>
      )}

      {error && <p className="settings-error">{error}</p>}

      <div className="ri-actions">
        <Tooltip label="Drop the discovery cache and walk every indexed directory now">
          <button
            className="btn"
            type="button"
            data-anchor="repositories/rescan"
            disabled={view === null || writing}
            onClick={() => void state.rescan()}
          >
            Rescan now
          </button>
        </Tooltip>
        {editable && view.defaultsMissing.length > 0 && (
          <Tooltip label="Add back missing seeded directories without removing your own">
            <button className="btn" type="button" disabled={writing} onClick={() => void state.restoreDefaults()}>
              Restore defaults
            </button>
          </Tooltip>
        )}
        <span className="ri-count">
          {view === null
            ? "Repository count unknown"
            : `${view.repoCount} ${view.repoCount === 1 ? "repository" : "repositories"} indexed · last scanned ${scanAge(view.scannedAt)}`}
        </span>
      </div>

      {!environment && (
        <p className="ri-footnote">
          <span aria-hidden>ℹ</span>
          <span>
            Four directories are seeded so a fresh install finds common checkout locations.
            Removing any row is durable and never touches files on disk. Restore defaults adds
            only missing seeded rows and leaves your own rows intact.
          </span>
        </p>
      )}
    </section>
  );
}
