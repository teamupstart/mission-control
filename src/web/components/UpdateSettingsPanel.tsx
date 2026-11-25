import { useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
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
const ENABLE_ALL_TIMEOUT_MS = 10_000;
/**
 * `superseded`: Enable all was seen on while this write was pending, so the operator's flags no
 * longer depend on it and its failure, if any, is dropped rather than offered as a Retry that
 * could undo a later choice to switch previews off.
 */
type EnableAllWrite = { pending: boolean; error: string | null; superseded: boolean };
let enableAllWrite: EnableAllWrite = { pending: false, error: null, superseded: false };
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
  setEnableAllWrite({ pending: true, error: enableAllWrite.error, superseded: false });
  // Bounded, so a daemon that accepts the request and never answers still frees Retry.
  const signal = AbortSignal.timeout(ENABLE_ALL_TIMEOUT_MS);
  const result = await api.setFeatureFlags({ kind: "master", enabled: true }, { signal });
  const error = result.ok || enableAllWrite.superseded ? null
    : signal.aborted ? `Mission Control did not answer within ${ENABLE_ALL_TIMEOUT_MS / 1000} seconds`
    : result.error ?? "unknown error";
  setEnableAllWrite({ pending: false, error, superseded: false });
}
function forgetEnableAllFailure(): void {
  if (enableAllWrite.error && !enableAllWrite.pending) setEnableAllWrite({ pending: false, error: null, superseded: false });
}
function noteEnableAllOn(): void {
  if (enableAllWrite.pending) {
    if (!enableAllWrite.superseded) setEnableAllWrite({ ...enableAllWrite, superseded: true });
  } else forgetEnableAllFailure();
}

/** The desktop updater owns this setting, even when the daemon cannot start. */
export function UpdateSettingsPanel({ children }: { children: ReactNode }): React.JSX.Element {
  const updates = typeof window === "undefined" ? undefined : window.missionDesktop?.updates;
  const [snapshot, setSnapshot] = useState<UpdateSnapshot | null>(null);
  const [saving, setSaving] = useState(false);
  const [alphaError, setAlphaError] = useState<string | null>(null);
  const [footerError, setFooterError] = useState<string | null>(null);
  const flagWrite = useSyncExternalStore(subscribeEnableAllWrite, readEnableAllWrite, readEnableAllWrite);
  const enableAllOn = useContext(FeatureFlagsContext).enableAll;
  const installation = typeof window === "undefined" ? undefined : window.missionDesktop?.binaryInstallation;
  const [enrollment, setEnrollment] = useState<BinaryEnrollment | null>(null);
  const [enrollmentResult, setEnrollmentResult] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void installation?.getState().then(value => { if (live) setEnrollment(value); }).catch(error => { if (live) setFooterError(String(error)); });
    return () => { live = false; };
  }, [installation]);
  useEffect(() => {
    if (!updates?.setAlpha) return;
    return subscribeToDesktopUpdates(updates, setSnapshot);
  }, [updates]);
  // Enable all came on some other way, such as the Feature flags panel: nothing is left to retry.
  // Seen while the write is pending, it marks that write superseded, so a failure landing after
  // Enable all went on, and even off again, never comes back as a Retry.
  useEffect(() => { if (enableAllOn) noteEnableAllOn(); }, [enableAllOn, flagWrite]);
  if (!updates?.setAlpha) return <>{children}</>;
  const binary = !!enrollment || (snapshot?.phase === "disabled" && snapshot.reason === BINARY_UPDATE_UNAVAILABLE);
  const busy = saving || !snapshot || ["checking", "preparing", "ready", "applying"].includes(snapshot.phase);
  const change = async (alpha: boolean) => {
    setSaving(true);
    setAlphaError(null);
    try {
      await updates.setAlpha!(alpha);
    } catch (error) {
      setAlphaError(error instanceof Error ? error.message : String(error));
      return;
    } finally {
      setSaving(false);
    }
    // Only once the desktop confirms alpha is off: a refused opt-out leaves alpha on, and its
    // Retry with it.
    // Enable all already on needs no write, and sending one anyway could land after the operator
    // switches it off elsewhere and undo that.
    if (alpha) { if (!enableAllOn) void switchOnEnableAll(); }
    else forgetEnableAllFailure();
  };
  const enableAllError = snapshot?.alpha && !enableAllOn ? flagWrite.error : null;
  const check = async () => {
    setFooterError(null);
    try { await updates.check(); }
    catch (error) { setFooterError(error instanceof Error ? error.message : String(error)); }
  };
  return (
    <>
      <div className="settings-section">
        <Tooltip label="Track unreleased main commits instead of stable releases. This also enables preview feature flags, except those you switched off.">
          <label className={`settings-toggle${snapshot?.alpha ? " is-on" : ""}`}>
            <input type="checkbox" checked={snapshot?.alpha ?? false}
              disabled={busy || snapshot?.phase === "disabled"} onChange={(event) => { void change(event.target.checked); }} />
            <span className="settings-toggle-label">Alpha updates</span>
          </label>
        </Tooltip>
        {enableAllError && <div role="alert">
          <p>Alpha updates are on, but Enable all feature flags could not be switched on: {enableAllError}</p>
          <Tooltip label="Try switching on Enable all feature flags again.">
            <button type="button" className="btn btn-ghost" disabled={flagWrite.pending || saving} onClick={() => { void switchOnEnableAll(); }}>Retry</button>
          </Tooltip>
        </div>}
        {alphaError && <p role="alert">{alphaError}</p>}
      </div>
      {children}
      <footer className="settings-section setup-update-footer">
        <section aria-label="Application updates">
          <Tooltip label={snapshot?.alpha ? "Check for new main commits now." : "Check for a newer stable release now."}>
            <button type="button" className="btn btn-ghost" disabled={busy || snapshot?.phase === "disabled"}
              onClick={() => { void check(); }}>Check for updates</button>
          </Tooltip>
          {snapshot?.phase === "up-to-date" && <p className="settings-hint" role="status">
            {snapshot.pendingVersion
              ? (snapshot.alpha ? "You are running the newest signed main build." : "You are running the newest signed release.")
              : (snapshot.alpha ? "You are running the latest main commit." : "You are running the latest release.")}
            {" "}{snapshot.currentVersion}
          </p>}
          {snapshot?.phase === "up-to-date" && snapshot.pendingVersion && <p className="settings-hint">{pendingBuildNotice(snapshot.pendingVersion)}</p>}
          {snapshot?.phase === "disabled" && <p className="settings-hint">{snapshot.reason}</p>}
          {enrollment && <div>
            <p className="settings-hint">{enrollment.message}</p>
            <p className="settings-hint">Destination: {enrollment.destination}</p>
            {enrollment.action && <Tooltip label={enrollment.action === "install"
              ? "Install the verified app at the displayed persistent destination."
              : "Verify this copied app and record its current destination for managed installation."}>
              <button type="button" className="btn btn-ghost" disabled={saving} onClick={() => {
                setSaving(true); setFooterError(null);
                void installation?.enroll().then(result => {
                  setEnrollmentResult(result.message);
                  if (result.started) setEnrollment({...enrollment, action: null});
                }).catch(error => setFooterError(String(error))).finally(() => setSaving(false));
              }}>{enrollment.action === "install" ? "Install Mission Control" : "Enroll this copied app"}</button>
            </Tooltip>}
          </div>}
          {binary && snapshot?.phase === "disabled" && <p><Tooltip label="Open signed installation and manual replacement instructions.">
            <a className="btn btn-ghost" href={BINARY_RECOVERY_URL} target="_blank" rel="noreferrer">Signed installer and recovery instructions</a>
          </Tooltip></p>}
          {enrollmentResult && <p className="settings-hint" role="status">{enrollmentResult}</p>}
          <p className="settings-hint">Manage preview features in <Tooltip label="Choose which preview features to enable"><a href="#/settings/feature-flags">Feature flags</a></Tooltip>.</p>
          {footerError && <p role="alert">{footerError}</p>}
        </section>
      </footer>
    </>
  );
}
