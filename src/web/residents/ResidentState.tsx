import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Tooltip } from "../components/Tooltip.tsx";
import { fetchResidentState, fetchResidentStateFile, resetResidentState, type ResidentStateView } from "./api.ts";
import { WorkflowConfirmModal } from "../workflows/WorkflowConfirmModal.tsx";
import { initialStatePath, ResidentStateViewer, type ResidentStatePreview } from "./ResidentStateViewer.tsx";

function failure(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export function ResidentState({ profileId, profileName }: { profileId: string; profileName: string }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<ResidentStateView | null>(null);
  const [preview, setPreview] = useState<ResidentStatePreview | null>(null);
  const [viewerError, setViewerError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  // Closing the viewer or resetting the files makes every read still in flight stale: its answer
  // describes files that are no longer on screen, or no longer exist, and is dropped.
  const generation = useRef(0);

  async function read(action: (live: () => boolean) => Promise<void>): Promise<void> {
    const started = generation.current;
    const live = () => generation.current === started;
    setBusy(true); setViewerError("");
    try { await action(live); } catch (err) { if (live()) setViewerError(failure(err, "State unavailable")); }
    finally { setBusy(false); }
  }
  async function readFile(path: string, live: () => boolean): Promise<void> {
    setPreview({ path, state: "loading" });
    try {
      const { text } = await fetchResidentStateFile(profileId, path);
      if (live()) setPreview({ path, state: "ready", text });
    } catch (err) {
      if (live()) setPreview({ path, state: "failed", error: failure(err, "State file unavailable") });
    }
  }
  async function readList(keep: string | null, live: () => boolean): Promise<void> {
    const next = await fetchResidentState(profileId);
    if (!live()) return;
    setView(next);
    const path = keep && next.files.some((file) => file.path === keep) ? keep : initialStatePath(next);
    if (path) await readFile(path, live);
    else setPreview(null);
  }
  function openViewer(): void {
    generation.current++;
    setView(null); setPreview(null); setError(""); setNotice(""); setOpen(true);
    void read((live) => readList(null, live));
  }
  function closeViewer(): void {
    generation.current++;
    setOpen(false);
  }

  return <section className="resident-section resident-editor-card resident-editor-card-state resident-state" aria-label="Durable resident state">
    <h4>Durable state</h4>
    <p className="resident-section-blurb">Notes, watermarks and Claude auto-memory survive restarts. Copies of this profile start with separate state.</p>
    <div className="resident-editor-actions">
    <Tooltip label="Browse this profile’s saved notes, watermarks and auto-memory">
      <button type="button" className="btn btn-ghost" disabled={busy} aria-haspopup="dialog" onClick={openViewer}>View state</button>
    </Tooltip>
    <Tooltip label="Clear saved notes, watermarks and auto-memory after closing all runs">
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setConfirm(true)}>Reset state</button>
    </Tooltip>
    </div>
    {error && <p className="resident-error" role="alert">{error}</p>}
    {notice && <p className="resident-state-notice" role="status">{notice}</p>}
    {open && <ResidentStateViewer
      profileName={profileName}
      view={view}
      preview={preview}
      error={viewerError}
      busy={busy}
      onSelect={(path) => void read((live) => readFile(path, live))}
      onRefresh={() => void read((live) => readList(preview?.path ?? null, live))}
      onClose={closeViewer}
    />}
    {/* Portaled like the viewer, and opened after it, so a reset reached from the keyboard while
        the viewer is up stacks above it instead of rendering, unclickable, beneath it. */}
    {confirm && createPortal(<WorkflowConfirmModal onClose={() => setConfirm(false)} request={{
      title: "Reset resident state", body: "Permanently delete this profile’s saved notes, watermarks and auto-memory. Complete and close all its runs first; pausing is not enough. Profile settings and run history are kept.",
      confirmLabel: "Delete saved state", confirmHint: "Permanently clear this profile’s durable state", danger: true,
      onConfirm: () => {
        setConfirm(false);
        if (busy) return;
        generation.current++;
        // A viewer left open behind the confirmation is reloaded with the cleared state rather
        // than left waiting on a listing nothing will fetch.
        const reload = open;
        setError(""); setNotice(""); setBusy(true);
        void (async () => {
          try {
            await resetResidentState(profileId);
          } catch (err) {
            setError(failure(err, "State reset failed"));
            setBusy(false);
            return;
          }
          setView(null); setPreview(null); setNotice("Saved state cleared."); setBusy(false);
          if (reload) await read((live) => readList(null, live));
        })();
      },
    }} />, document.body)}
  </section>;
}
