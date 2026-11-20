import { useContext, useEffect, useState, useSyncExternalStore } from "react";
import type { UpdateSnapshot } from "@shared/update.ts";
import { pendingBuildNotice } from "@shared/update-copy.ts";
import { subscribeToDesktopUpdates } from "../useDesktopUpdates.ts";
import { Tooltip } from "./Tooltip.tsx";
import { api } from "../lib/api.ts";
import { FeatureFlagsContext } from "../useFeatureFlag.ts";
import { BINARY_RECOVERY_URL, BINARY_UPDATE_UNAVAILABLE, type BinaryEnrollment } from "@shared/binary-enrollment.ts";

/*
 * Opting in to alpha also opts in to every preview feature, current and future. It is the same
 * write as switching on Enable all, so individual offs are kept, and leaving alpha changes no
 * flag. Alpha is saved first and kept when this write fails, because the desktop owns alpha and
 * it must work while the daemon is down; the failure offers a retry instead.
 *
 * The write's state lives here rather than in the panel so a failure, and its Retry, survive
 * leaving Setup and coming back. It is independent of the desktop save: a daemon request that
 * stalls never locks the alpha switch.
 */
type EnableAllWrite = { pending: boolean; error: string | null };
let enableAllWrite: EnableAllWrite = { pending: false, error: null };
const enableAllListeners = new Set<() => void>();
function setEnableAllWrite(next: EnableAllWrite): void {
  enableAllWrite = next;
  for (const listener of enableAllListeners) listener();
}
function subscribeEnableAllWrite(listener: () => void): () => void {
  enableAllListeners.add(listener);
  return () => { enableAllListeners.delete(listener); };
}
const readEnableAllWrite = () => enableAllWrite;
async function switchOnEnableAll(): Promise<void> {
  if (enableAllWrite.pending) return;
  // A retry keeps showing the last failure, with Retry disabled, until this one settles.
  setEnableAllWrite({ pending: true, error: enableAllWrite.error });
  const result = await api.setFeatureFlags({ kind: "master", enabled: true });
  setEnableAllWrite({ pending: false, error: result.ok ? null : result.error ?? "unknown error" });
}
function forgetEnableAllFailure(): void {
  if (enableAllWrite.error && !enableAllWrite.pending) setEnableAllWrite({ pending: false, error: null });
}

/** The desktop updater owns this setting, even when the daemon cannot start. */
export function UpdateSettingsPanel(): React.JSX.Element | null {
  const updates = typeof window === "undefined" ? undefined : window.missionDesktop?.updates;
  const [snapshot, setSnapshot] = useState<UpdateSnapshot | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flagWrite = useSyncExternalStore(subscribeEnableAllWrite, readEnableAllWrite, readEnableAllWrite);
  const enableAllOn = useContext(FeatureFlagsContext).enableAll;
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
  // Enable all came on some other way, such as the Feature flags panel: nothing is left to retry.
  useEffect(() => { if (enableAllOn) forgetEnableAllFailure(); }, [enableAllOn]);
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
      return;
    } finally {
      setSaving(false);
    }
    // Only once the desktop confirms alpha is off: a refused opt-out leaves alpha on, and its
    // Retry with it.
    if (alpha) void switchOnEnableAll();
    else forgetEnableAllFailure();
  };
  const enableAllError = snapshot?.alpha && !enableAllOn ? flagWrite.error : null;
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
            disabled={busy || snapshot?.phase === "disabled"} onChange={(event) => { void change(event.target.checked); }} />
          <span className="settings-toggle-text">
            <span className="settings-toggle-label">Alpha updates</span>
            <span className="settings-toggle-desc">
              Track the latest commit on main, including unreleased changes. Check every five minutes
              and show stable release news too. Off by default.
            </span>
          </span>
        </label>
      </Tooltip>
      <p className="settings-hint">Switching alpha on also switches on Enable all, so every preview feature comes on, keeping any you switched off. Adjust them in <Tooltip label="Choose which preview features to enable"><a href="#/settings/feature-flags">Feature flags</a></Tooltip>.</p>
      <p className="settings-hint">Signed binaries download while you work. You choose when to restart and install. No host Node or local compilation is needed for updates.</p>
      <Tooltip label={snapshot?.alpha ? "Check for new main commits now." : "Check for a newer stable release now."}>
        <button type="button" className="btn btn-ghost" disabled={busy || snapshot?.phase === "disabled"}
          onClick={() => { void check(); }}>Check for updates</button>
      </Tooltip>
      {snapshot?.phase === "up-to-date" && <p role="status">
        {snapshot.pendingVersion
          ? (snapshot.alpha ? "You are running the newest signed main build." : "You are running the newest signed release.")
          : (snapshot.alpha ? "You are running the latest main commit." : "You are running the latest release.")}
        {" "}{snapshot.currentVersion}
      </p>}
      {snapshot?.phase === "up-to-date" && snapshot.pendingVersion && <p className="settings-hint">{pendingBuildNotice(snapshot.pendingVersion)}</p>}
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
      {binary && snapshot?.phase === "disabled" && <p><Tooltip label="Open signed installation and manual replacement instructions.">
        <a className="btn btn-ghost" href={BINARY_RECOVERY_URL} target="_blank" rel="noreferrer">Signed installer and recovery instructions</a>
      </Tooltip></p>}
      {enrollmentResult && <p role="status">{enrollmentResult}</p>}
      {enableAllError && <div role="alert">
        <p>Alpha updates are on, but Enable all feature flags could not be switched on: {enableAllError}</p>
        <Tooltip label="Try switching on Enable all feature flags again.">
          <button type="button" className="btn btn-ghost" disabled={flagWrite.pending} onClick={() => { void switchOnEnableAll(); }}>Retry</button>
        </Tooltip>
      </div>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
