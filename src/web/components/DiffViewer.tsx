import { useEffect, useState } from "react";
import type { Session, SessionDiff } from "@shared/types.ts";
import { fetchSessionDiff } from "../lib/api.ts";
import { parsePatch, type DiffFile } from "../lib/diff.ts";

/**
 * Full-screen viewer for a session's changes against its source branch. Fetches
 * the unified patch from the daemon, parses it into per-file hunks, and renders
 * it with line numbers and +/- coloring - so you can see the work a session did
 * in its checkout without leaving the dashboard.
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

  // Own Escape, like the other overlays (App suppresses grid keys while open).
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const files = diff?.ok ? parsePatch(diff.patch) : [];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="diff-viewer" role="dialog" aria-label="Session diff" onClick={(e) => e.stopPropagation()}>
        <header className="diff-head">
          <div className="diff-title">
            <h2 title={session.name}>{session.name}</h2>
            {diff?.branch && diff.base && diff.branch !== diff.base ? (
              <span className="diff-sub mono">
                <span className="branch">{diff.branch}</span> vs <span className="branch">{diff.base}</span>
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
            <p className="diff-empty">
              No changes against {diff.base ?? "the source branch"}.
            </p>
          )}
          {!loading && diff?.ok && files.length > 0 && (
            <>
              {files.map((f, i) => (
                <FileDiff key={`${f.path}-${i}`} file={f} />
              ))}
              {diff.truncated && (
                <p className="diff-empty">Diff truncated for size - the stats above are complete.</p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function FileDiff({ file }: { file: DiffFile }): React.JSX.Element {
  const [open, setOpen] = useState(true);
  return (
    <section className="diff-file">
      <button className="diff-file-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className={`diff-file-status status-${file.status}`}>{STATUS_LABEL[file.status]}</span>
        <span className="diff-file-path mono" title={file.path}>
          {file.path}
        </span>
        <span className="diff-file-stat">
          {file.added > 0 && <span className="diff-add">+{file.added}</span>}
          {file.removed > 0 && <span className="diff-del">−{file.removed}</span>}
        </span>
        <span className={`diff-file-caret${open ? " open" : ""}`} aria-hidden>
          ⌃
        </span>
      </button>
      {open &&
        (file.binary ? (
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
                    <td className="dl-text">{l.text || " "}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </section>
  );
}

const STATUS_LABEL: Record<DiffFile["status"], string> = {
  added: "added",
  deleted: "deleted",
  renamed: "renamed",
  modified: "modified",
};
