import { useEffect, useMemo, useRef, useState } from "react";
import type { Session, SessionFileEntry } from "@shared/types.ts";
import type { SessionFilesController } from "../lib/sessionFiles.ts";
import { Overlay, OVERLAY_IDS } from "./Overlay.tsx";
import { Tooltip } from "./Tooltip.tsx";

/**
 * Match paths the way a command palette should: basename prefixes first, then basename
 * substrings, then the rest of the path. Stable path order breaks ties, so arrow-key
 * movement never jumps around between renders.
 */
export function filterSessionFiles(
  files: readonly SessionFileEntry[],
  query: string,
): SessionFileEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...files];
  return files
    .flatMap((file) => {
      const path = file.path.toLowerCase();
      const basename = path.slice(path.lastIndexOf("/") + 1);
      if (!path.includes(needle)) return [];
      const rank = basename.startsWith(needle) ? 0 : basename.includes(needle) ? 1 : 2;
      return [{ file, rank }];
    })
    .sort((a, b) => a.rank - b.rank || a.file.path.localeCompare(b.file.path))
    .map(({ file }) => file);
}

export function moveFilePickerIndex(index: number, count: number, delta: -1 | 1): number {
  if (count === 0) return 0;
  return Math.max(0, Math.min(count - 1, index + delta));
}

export function FilePicker({
  session,
  controller,
  onChoose,
  onClose,
}: {
  session: Session;
  controller: SessionFilesController;
  onChoose: (path: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);
  const state = controller.sessions[session.id];
  const shown = useMemo(
    () => filterSessionFiles(state?.files ?? [], query),
    [state?.files, query],
  );
  const activeIndex = shown.length > 0 ? Math.min(active, shown.length - 1) : -1;

  useEffect(() => {
    controller.ensure(session.id);
  }, [controller.ensure, session.id]);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    // Chrome may return a thenable from scrollIntoView. An expression-bodied effect
    // implicitly handed that value to React as a cleanup function; Strict Mode called
    // it while replaying effects and unmounted the entire app with "destroy is not a
    // function". A block body makes the effect's no-cleanup contract explicit.
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  function chooseActive(): void {
    const file = shown[activeIndex];
    if (file) onChoose(file.path);
  }

  return (
    <Overlay
      id={OVERLAY_IDS.filePicker}
      onClose={onClose}
      className="modal file-picker-modal"
      role="dialog"
      ariaLabel={`Find a file in ${session.name}`}
    >
      <header className="modal-head file-picker-head">
        <div>
          <h2>Find a file</h2>
          <span className="file-picker-session mono">{session.name}</span>
        </div>
        <Tooltip label="Close the file picker (Escape)"><button className="icon-btn" onClick={onClose} aria-label="Close file picker">✕</button></Tooltip>
      </header>

      <form
        className="file-picker-search"
        onSubmit={(event) => {
          event.preventDefault();
          chooseActive();
        }}
      >
        <span aria-hidden>⌕</span>
        <input
          ref={inputRef}
          value={query}
          placeholder="Search checkout files…"
          aria-label="Search checkout files"
          aria-controls="file-picker-results"
          aria-activedescendant={activeIndex >= 0 ? `file-picker-option-${activeIndex}` : undefined}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((index) => moveFilePickerIndex(index, shown.length, 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((index) => moveFilePickerIndex(index, shown.length, -1));
            } else if (event.key === "Home") {
              event.preventDefault();
              setActive(0);
            } else if (event.key === "End") {
              event.preventDefault();
              setActive(Math.max(0, shown.length - 1));
            }
          }}
        />
        <kbd>↵</kbd>
      </form>

      <div
        id="file-picker-results"
        className="file-picker-results"
        role="listbox"
        aria-label="Matching files"
      >
        {state?.listState === "loading" && (state.files.length === 0) && (
          <p className="file-picker-empty">Loading files…</p>
        )}
        {state?.listError && <p className="file-picker-error">{state.listError}</p>}
        {shown.map((file, index) => (
          <Tooltip key={file.path} label={file.path}>
          <button
            id={`file-picker-option-${index}`}
            ref={index === activeIndex ? activeRef : undefined}
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            className={`file-picker-option${index === activeIndex ? " is-active" : ""}`}
            onMouseMove={() => setActive(index)}
            onClick={() => onChoose(file.path)}
          >
            <span className="file-picker-name mono">{file.path}</span>
          </button>
          </Tooltip>
        ))}
        {state?.listState === "ready" && shown.length === 0 && (
          <p className="file-picker-empty">No matching files.</p>
        )}
      </div>

      <footer className="file-picker-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> select</span>
        <span><kbd>↵</kbd> open</span>
        <span><kbd>esc</kbd> close</span>
        <span className="file-picker-count">{shown.length} file{shown.length === 1 ? "" : "s"}</span>
      </footer>
    </Overlay>
  );
}
