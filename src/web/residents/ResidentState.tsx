import { useState } from "react";
import { Tooltip } from "../components/Tooltip.tsx";
import { fetchResidentState, fetchResidentStateFile, resetResidentState, type ResidentStateView } from "./api.ts";
import { WorkflowConfirmModal } from "../workflows/WorkflowConfirmModal.tsx";

export function ResidentState({ profileId }: { profileId: string }): React.JSX.Element {
  const [view, setView] = useState<ResidentStateView | null>(null);
  const [preview, setPreview] = useState<{ path: string; text: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  async function act(action: () => Promise<void>): Promise<void> {
    setBusy(true); setError("");
    try { await action(); } catch (err) { setError(err instanceof Error ? err.message : "State unavailable"); }
    finally { setBusy(false); }
  }
  return <section className="resident-section resident-state" aria-label="Durable resident state">
    <h4>Durable state</h4>
    <p className="resident-section-blurb">Notes, watermarks and Claude auto-memory survive restarts. Copies of this profile start with separate state.</p>
    <div className="resident-editor-actions">
    <Tooltip label={view ? "Reload this profile’s saved state files" : "Browse this profile’s saved notes, watermarks and auto-memory"}>
    <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void act(async () => {
      setView(await fetchResidentState(profileId)); setPreview(null);
    })}>{view ? "Refresh state" : "View state"}</button>
    </Tooltip>
    <Tooltip label="Clear saved notes, watermarks and auto-memory after closing all runs">
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setConfirm(true)}>Reset state</button>
    </Tooltip>
    </div>
    {error && <p className="resident-error" role="alert">{error}</p>}
    {view && <>
      <p className="resident-state-path">{view.directory}</p>
      {view.files.length === 0 ? <p>No saved state files.</p> : <ul aria-label="State files">{view.files.map(({ path }) =>
        <li key={path}><Tooltip label={`Preview ${path} without changing it`}><button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void act(async () => {
          setPreview({ path, ...(await fetchResidentStateFile(profileId, path)) });
        })}>{path}</button></Tooltip></li>)}</ul>}
      {preview && <section aria-label={`State file ${preview.path}`}><h4>{preview.path}</h4><pre>{preview.text}</pre></section>}
    </>}
    {confirm && <WorkflowConfirmModal onClose={() => setConfirm(false)} request={{
      title: "Reset resident state", body: "Permanently delete this profile’s saved notes, watermarks and auto-memory. Complete and close all its runs first; pausing is not enough. Profile settings and run history are kept.",
      confirmLabel: "Delete saved state", confirmHint: "Permanently clear this profile’s durable state", danger: true,
      onConfirm: () => { setConfirm(false); void act(async () => { await resetResidentState(profileId); setPreview(null); setView(await fetchResidentState(profileId)); }); },
    }} />}
  </section>;
}
