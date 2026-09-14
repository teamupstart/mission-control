import { useEffect, useState } from "react";
import type { UpdateSnapshot } from "@shared/update.ts";
import { subscribeToDesktopUpdates } from "../useDesktopUpdates.ts";

/** The desktop updater owns this setting, even when the daemon cannot start. */
export function UpdateSettingsPanel(): React.JSX.Element | null {
  const updates = typeof window === "undefined" ? undefined : window.missionDesktop?.updates;
  const [snapshot, setSnapshot] = useState<UpdateSnapshot | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!updates?.setAlpha) return;
    return subscribeToDesktopUpdates(updates, setSnapshot);
  }, [updates]);
  if (!updates?.setAlpha) return null;
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
      <label className={`settings-toggle${snapshot?.alpha ? " is-on" : ""}`}>
        <input type="checkbox" aria-label="Alpha updates" checked={snapshot?.alpha ?? false}
          disabled={busy} onChange={(event) => { void change(event.target.checked); }} />
        <span className="settings-toggle-text">
          <span className="settings-toggle-label">Alpha updates</span>
          <span className="settings-toggle-desc">
            Track the latest commit on main, including unreleased changes. Check every five minutes
            and show stable release news too. Off by default.
          </span>
        </span>
      </label>
      <p className="settings-hint">Updates are built while you work. You choose when to restart and install.</p>
      <button type="button" className="btn btn-ghost" disabled={busy || snapshot?.phase === "disabled"}
        onClick={() => { void check(); }}>Check for updates</button>
      {snapshot?.phase === "up-to-date" && <p role="status">
        {snapshot.alpha ? "You are running the latest main commit." : "You are running the latest release."}
        {" "}{snapshot.currentVersion}
      </p>}
      {snapshot?.phase === "disabled" && <p className="settings-hint">{snapshot.reason}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
