import { useEffect, useState } from "react";
import type { UpdateSnapshot } from "@shared/update.ts";
import { subscribeToDesktopUpdates } from "../useDesktopUpdates.ts";
import { Tooltip } from "./Tooltip.tsx";
import { BINARY_RECOVERY_URL, BINARY_UPDATE_UNAVAILABLE, type BinaryEnrollment } from "@shared/binary-enrollment.ts";

/** The desktop updater owns this setting, even when the daemon cannot start. */
export function UpdateSettingsPanel(): React.JSX.Element | null {
  const updates = typeof window === "undefined" ? undefined : window.missionDesktop?.updates;
  const [snapshot, setSnapshot] = useState<UpdateSnapshot | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const installation = typeof window === "undefined" ? undefined : window.missionDesktop?.binaryInstallation;
  const [enrollment, setEnrollment] = useState<BinaryEnrollment | null>(null);
  const [enrollmentResult, setEnrollmentResult] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void installation?.getState().then(value => { if (live) setEnrollment(value); }).catch(error => { if (live) setError(String(error)); });
    return () => { live = false; };
  }, [installation]);
  useEffect(() => {
    if (!updates?.setAlpha) return;
    return subscribeToDesktopUpdates(updates, setSnapshot);
  }, [updates]);
  if (!updates?.setAlpha) return null;
  const binary = !!enrollment || (snapshot?.phase === "disabled" && snapshot.reason === BINARY_UPDATE_UNAVAILABLE);
  const busy = saving || !snapshot || ["checking", "preparing", "ready", "applying"].includes(snapshot.phase);
  const change = async (alpha: boolean) => {
    setSaving(true);
    setError(null);
    try {
      await updates.setAlpha!(alpha);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };
  const check = async () => {
    setError(null);
    try { await updates.check(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  };
  return (
    <section className="settings-section" aria-label="Application updates">
      <div className="settings-section-head"><h3>Application updates</h3></div>
      <Tooltip label="Track unreleased main commits instead of stable releases.">
        <label className={`settings-toggle${snapshot?.alpha ? " is-on" : ""}`}>
          <input type="checkbox" aria-label="Alpha updates" checked={snapshot?.alpha ?? false}
            disabled={busy || binary} onChange={(event) => { void change(event.target.checked); }} />
          <span className="settings-toggle-text">
            <span className="settings-toggle-label">Alpha updates</span>
            <span className="settings-toggle-desc">
              Track the latest commit on main, including unreleased changes. Check every five minutes
              and show stable release news too. Off by default.
            </span>
          </span>
        </label>
      </Tooltip>
      <p className="settings-hint">{binary
        ? "The signed installer verifies a published app without host Node or local compilation."
        : "Updates are built while you work. You choose when to restart and install."}</p>
      <Tooltip label={snapshot?.alpha ? "Check for new main commits now." : "Check for a newer stable release now."}>
        <button type="button" className="btn btn-ghost" disabled={busy || snapshot?.phase === "disabled"}
          onClick={() => { void check(); }}>Check for updates</button>
      </Tooltip>
      {snapshot?.phase === "up-to-date" && <p role="status">
        {snapshot.alpha ? "You are running the latest main commit." : "You are running the latest release."}
        {" "}{snapshot.currentVersion}
      </p>}
      {snapshot?.phase === "disabled" && <p className="settings-hint">{snapshot.reason}</p>}
      {enrollment && <div>
        <p className="settings-hint">{enrollment.message}</p>
        <p>Destination: {enrollment.destination}</p>
        {enrollment.action && <Tooltip label={enrollment.action === "install"
          ? "Install the verified app at the displayed persistent destination."
          : "Verify this copied app and record its current destination for managed installation."}>
          <button type="button" className="btn btn-ghost" disabled={saving} onClick={() => {
          setSaving(true); setError(null);
          void installation?.enroll().then(result => {
            setEnrollmentResult(result.message);
            if (result.started) setEnrollment({...enrollment, action: null});
          }).catch(error => setError(String(error))).finally(() => setSaving(false));
          }}>{enrollment.action === "install" ? "Install Mission Control" : "Enroll this copied app"}</button>
        </Tooltip>}
      </div>}
      {snapshot?.phase === "disabled" && <p><Tooltip label="Open signed installation and manual replacement instructions.">
        <a className="btn btn-ghost" href={BINARY_RECOVERY_URL} target="_blank" rel="noreferrer">Signed installer and recovery instructions</a>
      </Tooltip></p>}
      {enrollmentResult && <p role="status">{enrollmentResult}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
