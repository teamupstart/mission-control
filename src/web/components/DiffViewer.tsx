import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Session, SessionDiff } from "@shared/types.ts";
import { fetchSessionDiff } from "../lib/api.ts";
import {
  diffFileOpenTarget,
  parsePatch,
  type DiffFile,
  type DiffFileTarget,
} from "../lib/diff.ts";
import { chordFromEvent, useKeybindings } from "../lib/keybindings.ts";
import { Keycap } from "./Keycap.tsx";
import { Tooltip } from "./Tooltip.tsx";

/**
 * Console and Board give a session's diff a real tab, reusing one reader without a
 * screen-owning overlay.
 */
export function InlineDiffViewer({
  session,
  commit,
  requestNonce,
  onOpenInFiles,
}: {
  session: Session;
  commit?: string | null;
  requestNonce?: number;
  onOpenInFiles?: (path: string) => void;
}): React.JSX.Element {
  return (
    <DiffViewerContent
      session={session}
      commit={commit}
      requestNonce={requestNonce}
      onOpenInFiles={onOpenInFiles}
    />
  );
}

function DiffViewerContent({
  session,
  commit,
  requestNonce,
  onOpenInFiles,
}: {
  session: Session;
  commit?: string | null;
  requestNonce?: number;
  onOpenInFiles?: (path: string) => void;
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
    if (requestNonce === undefined) return;
    contentRef.current?.focus({ preventScroll: true });
  }, [requestNonce]);

  // Re-parse only when the patch changes, not on every render (selection change).
  const files = useMemo(() => (diff?.ok ? parsePatch(diff.patch) : []), [diff]);

  // A fresh diff resets the selection to the first file.
  useEffect(() => setSelected(0), [files]);

  const activeIdx = files.length > 0 ? Math.min(selected, files.length - 1) : -1;
  const active = activeIdx >= 0 ? files[activeIdx] : null;
  const activeTarget = active && diff?.ok
    ? diffFileOpenTarget(active, diff.repoRoot, session.cwd)
    : null;
  const { bindings } = useKeybindings();

  // File navigation is this reader's own: ↑/↓ and j/k walk the list without leaving the
  // keyboard. The inline reader attaches it to its focusable region, keeping those keys
  // scoped to the embedded reader instead of changing the Console or Board selection.
  const onViewerKey = useCallback(
    (e: KeyboardEvent) => {
      if (chordFromEvent(e) === bindings.openDiffFile) {
        if (activeTarget?.path && onOpenInFiles) {
          e.preventDefault();
          onOpenInFiles(activeTarget.path);
        }
        return;
      }
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
    [activeTarget?.path, bindings.openDiffFile, files.length, onOpenInFiles],
  );
  // Keep the picked file visible in the list, and show its diff from the top.
  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: "nearest" });
    if (detailRef.current) detailRef.current.scrollTop = 0;
  }, [activeIdx]);

  return (
    <div
      ref={contentRef}
      className="diff-viewer-content diff-viewer-inline"
      role="region"
      aria-label="Session diff"
      tabIndex={-1}
      onKeyDown={(e) => onViewerKey(e.nativeEvent)}
    >
      <header className="diff-head">
        <div className="diff-title">
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
              {active && activeTarget && (
                <FileDiff
                  file={active}
                  target={activeTarget}
                  onOpenInFiles={onOpenInFiles}
                />
              )}
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
    <Tooltip label={`${STATUS_LABEL[file.status]} · ${file.path}`}>
    <button
      ref={ref}
      className={`diff-fileitem${active ? " active" : ""}`}
      onClick={onSelect}
      aria-current={active}
    >
      <span className={`diff-file-dot status-${file.status}`} aria-hidden>
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
    </Tooltip>
  );
};

/** The detail pane: the selected file's full path header plus its numbered diff. */
function FileDiff({
  file,
  target,
  onOpenInFiles,
}: {
  file: DiffFile;
  target: DiffFileTarget;
  onOpenInFiles?: (path: string) => void;
}): React.JSX.Element {
  return (
    <section className="diff-file">
      <div className="diff-file-head">
        <span className={`diff-file-status status-${file.status}`}>{STATUS_LABEL[file.status]}</span>
        <Tooltip label={file.path}>
          <span className="diff-file-path mono">{file.path}</span>
        </Tooltip>
        <span className="diff-file-stat">
          {file.added > 0 && <span className="diff-add">+{file.added}</span>}
          {file.removed > 0 && <span className="diff-del">−{file.removed}</span>}
        </span>
        {/* Rendered for EVERY file, including the ones it cannot act on: a control that
            vanishes on some files teaches that the diff sometimes has no route to the
            Files tab, when the real answer is that this one file has none and here is
            why. `aria-disabled` rather than `disabled` keeps it focusable, which is the
            only way the reason reaches the keyboard and the accessibility tree. */}
        {onOpenInFiles && (
          <Tooltip label={target.reason ?? `Open ${file.path} in the Files tab`}>
            <button
              className="diff-open-file"
              aria-disabled={target.path === null}
              onClick={() => {
                if (target.path) onOpenInFiles(target.path);
              }}
            >
              <Keycap action="openDiffFile" />
              Open in Files
              <span className="diff-open-file-glyph" aria-hidden>
                ↗
              </span>
            </button>
          </Tooltip>
        )}
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
