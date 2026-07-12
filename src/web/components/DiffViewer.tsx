import { useEffect, useMemo, useRef, useState } from "react";
import type { Session, SessionDiff } from "@shared/types.ts";
import { fetchSessionDiff } from "../lib/api.ts";
import { parsePatch, type DiffFile } from "../lib/diff.ts";

/**
 * Full-screen viewer for a session's changes against its source branch. Fetches
 * the unified patch from the daemon and parses it into per-file hunks, then lays
 * it out master-detail: a list of changed files on the left, and the diff of the
 * one you pick on the right - so a big change reads file-by-file instead of as
 * one long scroll. Files move by click or ↑/↓ (j/k); the diff shows one file only.
 */
export function DiffViewer({
  session,
  onClose,
}: {
  session: Session;
  onClose: () => void;
}): React.JSX.Element {
  const [diff, setDiff] = useState<SessionDiff | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(0);
  const activeItemRef = useRef<HTMLButtonElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void fetchSessionDiff(session.id).then((d) => {
      if (alive) {
        setDiff(d);
        setLoading(false);
      }
    });
    return () => {
      alive = false;
    };
  }, [session.id]);

  // Re-parse only when the patch changes, not on every render (selection change).
  const files = useMemo(() => (diff?.ok ? parsePatch(diff.patch) : []), [diff]);

  // A fresh diff resets the selection to the first file.
  useEffect(() => setSelected(0), [files]);

  const activeIdx = files.length > 0 ? Math.min(selected, files.length - 1) : -1;
  const active = activeIdx >= 0 ? files[activeIdx] : null;

  // Own Escape + file navigation, like the other overlays (App suppresses grid
  // keys while open). ↑/↓ and j/k walk the file list without leaving the keyboard.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") return onClose();
      if (files.length === 0) return;
      if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        setSelected((i) => Math.min(files.length - 1, i + 1));
      } else if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        setSelected((i) => Math.max(0, i - 1));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, files.length]);

  // Keep the picked file visible in the list, and show its diff from the top.
  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: "nearest" });
    if (detailRef.current) detailRef.current.scrollTop = 0;
  }, [activeIdx]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="diff-viewer"
        role="dialog"
        aria-label="Session diff"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="diff-head">
          <div className="diff-title">
            <h2 title={session.name}>{session.name}</h2>
            {diff?.branch && diff.base && diff.branch !== diff.base ? (
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
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="diff-body">
          {loading && <p className="diff-empty">Loading diff…</p>}
          {!loading && diff && !diff.ok && (
            <p className="diff-empty">Couldn't load a diff: {diff.error ?? "unknown error"}.</p>
          )}
          {!loading && diff?.ok && files.length === 0 && (
            <p className="diff-empty">No changes against {diff.base ?? "the source branch"}.</p>
          )}
          {!loading && diff?.ok && files.length > 0 && (
            <>
              <nav className="diff-filelist" aria-label="Changed files">
                {files.map((f, i) => (
                  <FileItem
                    key={`${f.path}-${i}`}
                    file={f}
                    active={i === activeIdx}
                    ref={i === activeIdx ? activeItemRef : undefined}
                    onSelect={() => setSelected(i)}
                  />
                ))}
                {diff.truncated && (
                  <p className="diff-trunc">
                    Diff truncated for size - some files may be missing. The header stats are complete.
                  </p>
                )}
              </nav>
              <div className="diff-detail" ref={detailRef}>
                {active && <FileDiff file={active} />}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** One row in the left-hand file list: status, path (basename kept visible), stats. */
const FileItem = ({
  file,
  active,
  onSelect,
  ref,
}: {
  file: DiffFile;
  active: boolean;
  onSelect: () => void;
  ref?: React.Ref<HTMLButtonElement>;
}): React.JSX.Element => {
  const { dir, name } = splitPath(file.path);
  return (
    <button
      ref={ref}
      className={`diff-fileitem${active ? " active" : ""}`}
      onClick={onSelect}
      aria-current={active}
      title={file.path}
    >
      <span
        className={`diff-file-dot status-${file.status}`}
        title={STATUS_LABEL[file.status]}
        aria-hidden
      >
        {STATUS_INITIAL[file.status]}
      </span>
      <span className="diff-fileitem-path mono">
        <span className="fp-name">{name}</span>
        {dir && <span className="fp-dir">{dir}</span>}
      </span>
      <span className="diff-fileitem-stat">
        {file.added > 0 && <span className="diff-add">+{file.added}</span>}
        {file.removed > 0 && <span className="diff-del">−{file.removed}</span>}
      </span>
    </button>
  );
};

/** The detail pane: the selected file's full path header plus its numbered diff. */
function FileDiff({ file }: { file: DiffFile }): React.JSX.Element {
  return (
    <section className="diff-file">
      <div className="diff-file-head">
        <span className={`diff-file-status status-${file.status}`}>{STATUS_LABEL[file.status]}</span>
        <span className="diff-file-path mono" title={file.path}>
          {file.path}
        </span>
        <span className="diff-file-stat">
          {file.added > 0 && <span className="diff-add">+{file.added}</span>}
          {file.removed > 0 && <span className="diff-del">−{file.removed}</span>}
        </span>
      </div>
      {file.binary ? (
        <p className="diff-binary">Binary file</p>
      ) : (
        <div className="diff-lines">
          <table>
            <tbody>
              {file.lines.map((l, i) => (
                <tr key={i} className={`dl dl-${l.type}`}>
                  <td className="dl-num">{l.oldNo ?? ""}</td>
                  <td className="dl-num">{l.newNo ?? ""}</td>
                  <td className="dl-sign">{l.type === "add" ? "+" : l.type === "del" ? "−" : ""}</td>
                  <td className="dl-text">{l.text || " "}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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
