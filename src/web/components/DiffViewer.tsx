import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { Session, SessionDiff } from "@shared/types.ts";
import { fetchSessionDiff } from "../lib/api.ts";
import { parsePatch, type DiffFile } from "../lib/diff.ts";
import { Overlay, OVERLAY_IDS } from "./Overlay.tsx";

/**
 * Full-screen viewer for a session's changes against its source branch. Fetches
 * the unified patch from the daemon and parses it into per-file hunks, then lays
 * it out master-detail: a list of changed files on the left, and the diff of the
 * one you pick on the right - so a big change reads file-by-file instead of as
 * one long scroll. Files move by click or ↑/↓ (j/k); the diff shows one file only.
 *
 * Given a `commit`, it shows what that ONE commit changed instead - how a
 * no-mistakes fix opens from the card's fix log.
 */
export function DiffViewer({
  session,
  commit,
  onClose,
}: {
  session: Session;
  commit?: string | null;
  onClose: () => void;
}): React.JSX.Element {
  const viewerKeyRef = useRef<((e: KeyboardEvent) => void) | null>(null);
  return (
    <Overlay
      id={OVERLAY_IDS.diff}
      onClose={onClose}
      className="diff-viewer"
      role="dialog"
      ariaLabel="Session diff"
      onKeyDown={(e) => viewerKeyRef.current?.(e)}
    >
      <DiffViewerContent session={session} commit={commit} onClose={onClose} onViewerKeyRef={viewerKeyRef} />
    </Overlay>
  );
}

/**
 * The console and board give a session's diff a real tab, so they reuse the same
 * reader without creating a screen-owning overlay. Cards do not have that tab and
 * continue to use the modal wrapper above.
 */
export function InlineDiffViewer({
  session,
  commit,
  requestNonce,
}: {
  session: Session;
  commit?: string | null;
  requestNonce?: number;
}): React.JSX.Element {
  return (
    <DiffViewerContent
      session={session}
      commit={commit}
      inline
      requestNonce={requestNonce}
    />
  );
}

function DiffViewerContent({
  session,
  commit,
  onClose,
  inline = false,
  onViewerKeyRef,
  requestNonce,
}: {
  session: Session;
  commit?: string | null;
  onClose?: () => void;
  inline?: boolean;
  onViewerKeyRef?: MutableRefObject<((e: KeyboardEvent) => void) | null>;
  requestNonce?: number;
}): React.JSX.Element {
  const [diff, setDiff] = useState<SessionDiff | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(0);
  const activeItemRef = useRef<HTMLButtonElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    setDiff(null);
    setLoading(true);
    void fetchSessionDiff(session.id, commit ?? undefined).then((d) => {
      if (alive) {
        setDiff(d);
        setLoading(false);
      }
    });
    return () => {
      alive = false;
    };
  }, [session.id, commit, requestNonce]);

  useEffect(() => {
    if (!inline || requestNonce === undefined) return;
    contentRef.current?.focus({ preventScroll: true });
  }, [inline, requestNonce]);

  // Re-parse only when the patch changes, not on every render (selection change).
  const files = useMemo(() => (diff?.ok ? parsePatch(diff.patch) : []), [diff]);

  // A fresh diff resets the selection to the first file.
  useEffect(() => setSelected(0), [files]);

  const activeIdx = files.length > 0 ? Math.min(selected, files.length - 1) : -1;
  const active = activeIdx >= 0 ? files[activeIdx] : null;

  // Escape belongs to the Overlay in Cards (App suppresses grid keys while one is open,
  // so the overlay layer closes itself). File navigation is this reader's own: ↑/↓
  // and j/k walk the list without leaving the keyboard. The modal hands it to Overlay;
  // the inline reader attaches it to its focusable region, keeping those keys scoped to
  // the embedded reader instead of changing the Console or Board selection.
  const onViewerKey = useCallback(
    (e: KeyboardEvent) => {
      const next = e.key === "ArrowDown" || e.key === "j";
      const previous = e.key === "ArrowUp" || e.key === "k";
      if (!next && !previous) return;
      e.preventDefault();
      if (files.length === 0) return;
      if (next) {
        setSelected((i) => Math.min(files.length - 1, i + 1));
      } else {
        setSelected((i) => Math.max(0, i - 1));
      }
    },
    [files.length],
  );
  if (onViewerKeyRef) onViewerKeyRef.current = onViewerKey;

  // Keep the picked file visible in the list, and show its diff from the top.
  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: "nearest" });
    if (detailRef.current) detailRef.current.scrollTop = 0;
  }, [activeIdx]);

  return (
    <div
      ref={contentRef}
      className={`diff-viewer-content${inline ? " diff-viewer-inline" : ""}`}
      role={inline ? "region" : undefined}
      aria-label={inline ? "Session diff" : undefined}
      tabIndex={inline ? -1 : undefined}
      onKeyDown={inline ? (e) => onViewerKey(e.nativeEvent) : undefined}
    >
      <header className="diff-head">
        <div className="diff-title">
          {!inline && <h2 title={session.name}>{session.name}</h2>}
          {/* A commit diff is ONE commit, so it must not borrow the range
              wording below: "<branch> vs <base>" would read as everything since
              that parent, which is the larger diff and the wrong one. */}
          {commit ? (
            // Not `.branch`: that prepends a ⌥ branch glyph, and this is a commit.
            <span className="diff-sub mono">
              fix <span className="diff-sha">{diff?.headSha ?? commit}</span>
            </span>
          ) : diff?.branch && diff.base && diff.branch !== diff.base ? (
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
        {onClose && (
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        )}
      </header>

      <div className="diff-body">
        {loading && <p className="diff-empty">Loading diff…</p>}
        {!loading && diff && !diff.ok && (
          <p className="diff-empty">Couldn't load a diff: {diff.error ?? "unknown error"}.</p>
        )}
        {/* An empty fix commit is a real thing to open, and "against <branch>"
            is the wrong frame for one commit - it has no base branch, only a parent. */}
        {!loading && diff?.ok && files.length === 0 && (
          <p className="diff-empty">
            {commit
              ? "No changes in this commit."
              : `No changes against ${diff.base ?? "the source branch"}.`}
          </p>
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
