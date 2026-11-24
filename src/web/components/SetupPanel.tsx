import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { ENVIRONMENT_CHECK_IDS } from "@shared/environment-checks.ts";
import {
  ENVIRONMENT_ROW_METADATA,
  SETUP_FAMILY_IDS,
  SETUP_FAMILY_INFO,
  SETUP_REPOSITORY_ANCHORS,
  SETUP_SERVICE_INFO,
  homeRelative,
  setupFamilyFlagOn,
  setupRowAnchor,
  type SetupCommandPurpose,
  type SetupDependencyId,
  type SetupFamilyId,
  type SetupRowView,
  type SetupServiceId,
} from "@shared/setup-catalog.ts";
import type {
  PipelineInstallerCandidatesResult,
  PipelineProviderId,
} from "@shared/pipeline.ts";
import { visibleSetupFamilyIds } from "@shared/conductor-integration.ts";
import { resolveFeatureFlag, type FeatureFlagId } from "@shared/feature-flags.ts";
import { FEATURE_FLAGS } from "@shared/feature-flag-registry.ts";
import { formatBytes } from "@shared/format-bytes.ts";
import type { VoiceModelState, VoiceState } from "@shared/voice.ts";
import { voiceModelSetupStatus } from "@shared/voice-models.ts";
import { FeatureFlagsContext } from "../useFeatureFlag.ts";
import {
  MULTIPLEXER_IDS,
  resolveEmulatorBackend,
  type EmulatorId,
  type MultiplexerId,
  type TerminalBackendId,
  type TerminalTargetView,
} from "@shared/terminal.ts";
import { COPY_FEEDBACK_LABEL, useCopyFeedback } from "../lib/clipboard.ts";
import {
  api,
  fetchPipelineInstallers,
  openSetupInstaller,
  startSetupService,
  type SetupInstallerLaunchResult,
  type SetupServiceStartResult,
} from "../lib/api.ts";
import { initialTerminalTarget, useTerminalTargets, type TerminalTargetsState } from "../lib/terminalTargets.ts";
import { useTerminalsConfig, type TerminalsConfigState } from "../useTerminalsConfig.ts";
import type { SetupChecksState } from "../useSetupChecks.ts";
import { useRepoIndex } from "../useRepoIndex.ts";
import { RepositoriesPanel } from "./RepositoriesPanel.tsx";
import { useTourTargetRef } from "../tour/target-context.tsx";
import {
  EMULATOR_GROUPS,
  multiplexerTerminalCopy,
  TerminalPreferencePicker,
} from "./TerminalPreferencePicker.tsx";
import { Tooltip } from "./Tooltip.tsx";

function CopyCommand({ argv, note }: { argv: readonly string[]; note: string }): React.JSX.Element {
  const text = argv.join(" ");
  const copy = useCopyFeedback({ resetOn: text });
  return (
    <>
      <div className="setup-command">
        <code>{text}</code>
        <Tooltip label={copy.copied ? COPY_FEEDBACK_LABEL : note}>
          <button type="button" className="btn btn-ghost" onClick={() => void copy.copy(text)}>
            {copy.copied ? COPY_FEEDBACK_LABEL : "Copy"}
          </button>
        </Tooltip>
      </div>
      {copy.error && <span className="settings-error">{copy.error}</span>}
    </>
  );
}

function OwnedIntegrationRepair(): React.JSX.Element | null {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ok: boolean; message: string} | null>(null);
  if (typeof window === "undefined" || !window.missionDesktop?.installIntegrations) return null;
  return <div className="setup-row" aria-label="Mission-owned integrations">
    <p className="setup-impact">Install or repair Mission hooks and MCP with the app runtime. Existing Mission statusline wrappers keep their saved command; independent tools keep their own prerequisites.</p>
    <Tooltip label="Install or repair Mission-owned hooks and MCP using this app's runtime.">
      <button type="button" className="btn" disabled={busy} onClick={async () => {
        setBusy(true);
        try { setResult(await window.missionDesktop!.installIntegrations()); }
        catch { setResult({ok:false, message:"Integration repair could not finish. Check the app log and retry."}); }
        finally { setBusy(false); }
      }}>{busy ? "Repairing..." : "Install Claude integrations"}</button>
    </Tooltip>
    {result && <p role="status" className={result.ok ? "setup-impact" : "settings-error"}>{result.message}</p>}
  </div>;
}

interface TerminalChoice {
  targets: TerminalTargetView[] | null;
  failed: boolean;
  selected: TerminalTargetView | null;
  select(id: TerminalBackendId): void;
}

/**
 * The panel's own terminal read, which Re-check refreshes. Every installer picker reads it, so
 * a Re-check that finds the system default reaches pickers already on screen; a picker mounted
 * outside the panel falls back to the shared memoized read.
 */
const SetupTerminalTargetsContext = createContext<TerminalTargetsState | null>(null);

function useTerminalChoice(): TerminalChoice {
  const shared = useContext(SetupTerminalTargetsContext);
  const own = useTerminalTargets();
  const terminals = shared ?? own;
  // Only an operator's pick is stored. The automatic choice is derived from the catalog as it
  // stands now, so a later read that marks the system default moves an untouched picker to it
  // instead of leaving it on whatever the first read happened to list first.
  const [pickedId, setPickedId] = useState<TerminalBackendId | null>(null);
  const available = terminals.targets?.filter((target) => target.unavailable === null) ?? [];
  const selected = available.find((target) => target.id === pickedId) ?? initialTerminalTarget(available);

  return { ...terminals, selected, select: setPickedId };
}

function TerminalPicker({
  label,
  choice,
  busy,
}: {
  label: string;
  choice: TerminalChoice;
  busy: boolean;
}): React.JSX.Element {
  const noTerminal = choice.targets !== null && !choice.targets.some((target) => target.unavailable === null);
  return (
    <>
      <label className="setup-terminal-choice">
        <span>Visible terminal</span>
        <Tooltip label={`Choose the visible terminal that will run the ${label} installer`}>
          <select
            aria-label={`Terminal for ${label}`}
            value={choice.selected?.id ?? ""}
            disabled={!choice.targets || noTerminal || busy}
            onChange={(event) => choice.select(event.target.value as TerminalBackendId)}
          >
            {!choice.targets && <option value="">Checking terminals...</option>}
            {choice.targets?.map((target) => (
              <option key={target.id} value={target.id} disabled={target.unavailable !== null}>
                {target.label}{target.systemDefault ? " (system default)" : ""}{target.unavailable ? `: ${target.unavailable}` : ""}
              </option>
            ))}
          </select>
        </Tooltip>
      </label>
      {choice.failed && (
        <p className="settings-warn">Mission Control could not check terminal availability.</p>
      )}
      {noTerminal && (
        <ul className="setup-terminal-reasons" aria-label={`Unavailable terminals for ${label}`}>
          {choice.targets?.map((target) => (
            <li key={target.id}><strong>{target.label}</strong>: {target.unavailable}</li>
          ))}
        </ul>
      )}
    </>
  );
}

function RemedyNotice({
  tone,
  detail,
  hint,
}: {
  tone: "attention" | "error";
  detail: string;
  hint?: string;
}): React.JSX.Element {
  return (
    <div className={`setup-launch-notice is-${tone}`} role="status">
      <strong>{detail}</strong>
      {hint && <span>{hint}</span>}
    </div>
  );
}

function LaunchNotice({
  result,
  purpose = "install",
}: {
  result: SetupInstallerLaunchResult | null;
  purpose?: SetupCommandPurpose;
}): React.JSX.Element | null {
  if (!result) return null;
  const attention = result.outcome === "opened" || result.outcome === "maybe-opening";
  const what = purpose === "sign-in" ? "sign-in" : "installer";
  return (
    <RemedyNotice
      tone={attention ? "attention" : "error"}
      detail={result.detail || result.error || `The ${what} terminal was refused.`}
      hint={attention ? `When the ${what} finishes, press Re-check.` : undefined}
    />
  );
}

function RunButton({
  disabled,
  opening,
  onClick,
  purpose = "install",
}: {
  disabled: boolean;
  opening: boolean;
  onClick(): void;
  purpose?: SetupCommandPurpose;
}): React.JSX.Element {
  return (
    <Tooltip label={`Open this daemon-owned ${purpose === "sign-in" ? "sign-in" : "install"} command in the selected visible terminal`}>
      <button
        type="button"
        className="btn btn-primary"
        disabled={disabled}
        onClick={onClick}
      >
        {opening ? "Opening..." : "Run in a terminal"}
      </button>
    </Tooltip>
  );
}

function CommandRemedy({
  id,
  label,
  purpose,
  argv,
  note,
}: {
  id: SetupDependencyId;
  label: string;
  purpose: SetupCommandPurpose;
  argv: readonly string[];
  note: string;
}): React.JSX.Element {
  const terminal = useTerminalChoice();
  const [opening, setOpening] = useState(false);
  const [result, setResult] = useState<SetupInstallerLaunchResult | null>(null);

  async function launch(): Promise<void> {
    if (!terminal.selected) return;
    setOpening(true);
    setResult(null);
    try {
      setResult(await openSetupInstaller({ id, backend: terminal.selected.id }));
    } finally {
      setOpening(false);
    }
  }

  return (
    <div className="setup-remedy-actions">
      <CopyCommand argv={argv} note={note} />
      <div className="setup-run-controls">
        <TerminalPicker label={label} choice={terminal} busy={opening} />
        <RunButton
          disabled={!terminal.selected || opening}
          opening={opening}
          onClick={() => void launch()}
          purpose={purpose}
        />
      </div>
      <LaunchNotice result={result} purpose={purpose} />
    </div>
  );
}

/**
 * Start a background service the daemon owns, then re-read the machine.
 *
 * No terminal picker, and that absence is the point: nothing opens a window, so there is
 * nothing for the operator to choose or to watch. The call settles with the service either
 * answering or not, which is why this remedy re-checks itself instead of ending on "press
 * Re-check" the way an install must.
 */
function ServiceRemedy({
  service,
  label,
  note,
  onRepaired,
}: {
  service: SetupServiceId;
  label: string;
  note: string;
  onRepaired(): void;
}): React.JSX.Element {
  const [starting, setStarting] = useState(false);
  const [result, setResult] = useState<SetupServiceStartResult | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  const [installDidNotRegister, setInstallDidNotRegister] = useState(false);

  async function start(): Promise<SetupServiceStartResult> {
    setStarting(true);
    // A new attempt replaces the whole outcome, including an earlier inline install failure.
    setResult(null);
    setInstallError(null);
    setInstallDidNotRegister(false);
    try {
      const next = await startSetupService({ service });
      setResult(next);
      if (next.ok) onRepaired();
      return next;
    } finally {
      setStarting(false);
    }
  }

  // The trust write needs a server table to edit, and only the integration install writes
  // one. Offer that install here, where the refusal is read, then finish the trust the
  // operator asked for - rather than a sentence pointing somewhere else on the page.
  async function installThenStart(): Promise<void> {
    setInstalling(true);
    setInstallError(null);
    try {
      // Only the install is guarded here, so its failure sentence is never pinned on the
      // trust retry below, which reports its own outcome through `result`.
      let installed: { ok: boolean; message: string };
      try {
        installed = await window.missionDesktop!.installIntegrations();
      } catch {
        setInstallError("Integration install could not finish. Check the app log and retry.");
        return;
      }
      if (!installed.ok) { setInstallError(installed.message); return; }
      onRepaired();
      const retried = await start();
      // The installer preserves an existing entry it does not own (a disabled or custom
      // `mission-control` table) and still reports success. Offering the same install again
      // would loop, so say what it did and what is left to fix by hand.
      if (retried.prerequisite === "mission-integrations") {
        setInstallDidNotRegister(true);
        setInstallError(`${installed.message} Codex still has no runnable mission-control server, so trust cannot apply. In config.toml, give its [mcp_servers.mission-control] table a command or url and remove enabled = false if it is there, then press Trust again.`);
      }
    } catch {
      // The install already succeeded; only the trust retry can land here.
      setInstallError("Integrations installed, but the trust request could not finish. Press Trust again.");
    } finally {
      setInstalling(false);
    }
  }

  const needsIntegrations = result?.prerequisite === "mission-integrations";
  // `request()` resolves a transport failure without an HTTP status: the daemon never
  // answered, so no file or service is at fault and the per-service hint would mislead.
  const unreachable = !!result && !result.ok && result.status === undefined;
  const canInstall = typeof window !== "undefined" && !!window.missionDesktop?.installIntegrations;
  const busy = starting || installing;

  return (
    <div className="setup-remedy-actions">
      <div className="setup-run-controls">
        <Tooltip label={note}>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void start()}
          >
            {starting ? "Starting..." : label}
          </button>
        </Tooltip>
      </div>
      {result && (
        <RemedyNotice
          tone={result.ok ? "attention" : "error"}
          detail={unreachable
            ? `Mission Control did not answer the request${result.error ? ` (${result.error})` : ""}.`
            : result.detail || result.error || `${label} did not finish.`}
          hint={result.ok || installDidNotRegister ? undefined : unreachable
            ? `Check that Mission Control is running, then press ${label} again.`
            : needsIntegrations
            ? canInstall
              ? "Install Claude integrations also registers the Mission Control MCP server with Codex, then this retries the trust automatically."
              : "Open Setup in the Mission Control desktop app and choose Install Claude integrations, which registers the MCP server with Codex too, then retry."
            : SETUP_SERVICE_INFO[service].retry}
        />
      )}
      {needsIntegrations && canInstall && !installDidNotRegister && (
        <div className="setup-run-controls">
          <Tooltip label="Register Mission Control MCP with Claude Code and Codex using this app's runtime, then retry the trust.">
            <button type="button" className="btn" disabled={busy} onClick={() => void installThenStart()}>
              {installing ? "Installing..." : "Install Claude integrations"}
            </button>
          </Tooltip>
        </div>
      )}
      {installError && <p role="status" className="settings-error">{installError}</p>}
    </div>
  );
}

/**
 * Install Mission Control's own Claude integrations with one press, then re-read the machine.
 *
 * The desktop shell owns the installer, so a dashboard opened in a plain browser has no button
 * to offer. It says where the button is instead, and keeps the checkout command copyable for
 * an operator who runs Mission Control from one.
 */
function IntegrationsRemedy({
  note,
  fallback,
  onRepaired,
}: {
  note: string;
  fallback: { argv: readonly string[]; note: string };
  onRepaired(): void;
}): React.JSX.Element {
  const [installing, setInstalling] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const install = typeof window !== "undefined" ? window.missionDesktop?.installIntegrations : undefined;

  if (!install) {
    return (
      <div className="setup-remedy-actions">
        <p className="setup-remedy-hint">
          Open Settings &gt; Setup in the Mission Control desktop app and press Install, or run this
          from a Mission Control checkout:
        </p>
        <CopyCommand argv={fallback.argv} note={fallback.note} />
      </div>
    );
  }

  async function run(): Promise<void> {
    setInstalling(true);
    setResult(null);
    try {
      const next = await install!();
      setResult(next);
      // Re-read even after a refusal: a partial install can still have repaired this row.
      onRepaired();
    } catch {
      setResult({ ok: false, message: "The install could not finish. Check the app log and retry." });
    } finally {
      setInstalling(false);
    }
  }

  return (
    <div className="setup-remedy-actions">
      <div className="setup-run-controls">
        <Tooltip label={note}>
          <button type="button" className="btn btn-primary" disabled={installing} onClick={() => void run()}>
            {installing ? "Installing..." : "Install"}
          </button>
        </Tooltip>
      </div>
      {result && <RemedyNotice tone={result.ok ? "attention" : "error"} detail={result.message} />}
    </div>
  );
}

interface ProviderRead {
  loading: boolean;
  result: PipelineInstallerCandidatesResult | null;
  error: string | null;
}

function useProviderInstallers(provider: PipelineProviderId): ProviderRead {
  const [read, setRead] = useState<ProviderRead>({ loading: true, result: null, error: null });
  useEffect(() => {
    let live = true;
    setRead({ loading: true, result: null, error: null });
    void fetchPipelineInstallers(provider).then((result) => {
      if (!live) return;
      setRead(result
        ? { loading: false, result, error: null }
        : {
            loading: false,
            result: null,
            error: "Mission Control could not check for a verified local installer checkout.",
          });
    });
    return () => { live = false; };
  }, [provider]);
  return read;
}

function ProviderFallback({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="setup-provider-fallback">
      <p className="settings-warn">{children}</p>
      <Tooltip label="Open the Conductor settings that own provider source setup">
        <a className="setup-link" href="#/settings/conductor">Open Conductor settings<span aria-hidden> ↗</span></a>
      </Tooltip>
    </div>
  );
}

function ProviderInstallerRemedy({
  id,
  label,
  provider,
}: {
  id: SetupDependencyId;
  label: string;
  provider: PipelineProviderId;
}): React.JSX.Element {
  const terminal = useTerminalChoice();
  const read = useProviderInstallers(provider);
  const [opening, setOpening] = useState(false);
  const [result, setResult] = useState<SetupInstallerLaunchResult | null>(null);
  const candidates = read.result?.candidates ?? [];
  const runtimeReady = read.result?.runtime?.supported === true;

  async function launch(): Promise<void> {
    if (!terminal.selected || candidates.length !== 1) return;
    setOpening(true);
    setResult(null);
    try {
      setResult(await openSetupInstaller({
        id,
        backend: terminal.selected.id,
      }));
    } finally {
      setOpening(false);
    }
  }

  if (read.loading) return <p className="setup-loading">Checking workspace repositories...</p>;
  if (read.error) return <ProviderFallback>{read.error}</ProviderFallback>;
  if (!read.result) {
    return <ProviderFallback>Mission Control could not read installer candidates.</ProviderFallback>;
  }
  if (!read.result.supported) return <ProviderFallback>{read.result.detail}</ProviderFallback>;
  if (candidates.length === 0) {
    return (
      <ProviderFallback>
        No verified local installer checkout was found. Settings &gt; Conductor owns source setup.
      </ProviderFallback>
    );
  }
  if (!runtimeReady) {
    return <ProviderFallback>{read.result.runtime?.detail ?? read.result.detail}</ProviderFallback>;
  }
  if (candidates.length > 1) {
    return (
      <ProviderFallback>
        Multiple verified local installer checkouts were found. Mission Control will not choose
        between them from Setup.
      </ProviderFallback>
    );
  }

  return (
    <div className="setup-remedy-actions">
      <p className="setup-provider-checkout">
        Verified checkout <code>{candidates[0]!.checkout}</code>
      </p>
      <div className="setup-run-controls">
        <TerminalPicker label={label} choice={terminal} busy={opening} />
        <RunButton
          disabled={!terminal.selected || opening}
          opening={opening}
          onClick={() => void launch()}
        />
      </div>
      <LaunchNotice result={result} />
    </div>
  );
}

/**
 * Turn on the preview flags a row names, one `PUT /api/feature-flags` each, the way the Feature
 * flags panel switches them. Stops at the first refusal and says which flag it was.
 */
function FeatureFlagsRemedy({
  flags,
  label,
  note,
  onRepaired,
}: {
  flags: readonly FeatureFlagId[];
  label: string;
  note: string;
  onRepaired(): void;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function turnOn(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      for (const id of flags) {
        const result = await api.setFeatureFlags({ kind: "flag", id, enabled: true });
        if (!result.ok) {
          // Named by its label, the name Settings > Feature flags shows, so the hint below leads there.
          const label = FEATURE_FLAGS.find((flag) => flag.id === id)?.label ?? id;
          setError(`${label} could not be turned on${result.error ? `: ${result.error}` : "."}`);
          return;
        }
      }
    } finally {
      setBusy(false);
      onRepaired();
    }
  }
  return (
    <div className="setup-remedy-actions">
      <div className="setup-run-controls">
        <Tooltip label={note}>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void turnOn()}>
            {busy ? "Turning on..." : label}
          </button>
        </Tooltip>
      </div>
      {error && <RemedyNotice tone="error" detail={error} hint="Switch it in Settings > Feature flags, then press Re-check." />}
    </div>
  );
}

/**
 * The voice state from the event stream, so the speech model's row follows a download as it runs
 * instead of waiting for a Re-check. Null outside Settings or before the first snapshot.
 */
const SetupVoiceContext = createContext<VoiceState | null>(null);

/** "45 s left", "3 min left". */
function timeLeft(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} s left`;
  return `${Math.round(seconds / 60)} min left`;
}

export function voiceModelProgressText(model: Pick<VoiceModelState, "status" | "doneBytes" | "totalBytes" | "bytesPerSecond">): string {
  const amount = `${formatBytes(model.doneBytes)} of ${formatBytes(model.totalBytes)}`;
  if (model.status === "verifying") return `Checked ${amount}`;
  if (model.bytesPerSecond === null || model.bytesPerSecond <= 0) return amount;
  const left = Math.max(0, model.totalBytes - model.doneBytes) / model.bytesPerSecond;
  return `${amount} · ${formatBytes(model.bytesPerSecond)}/s · ${timeLeft(left)}`;
}

/**
 * The daemon owns the download; this draws `VoiceState.model` as the event stream delivers it, so
 * every window shows the same bar.
 */
function VoiceModelRemedy({ label, note }: { label: string; note: string }): React.JSX.Element | null {
  const voice = useContext(SetupVoiceContext);
  const model = voice?.model ?? null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function start(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await api.startVoiceModelDownload();
      if (!result.ok) setError(result.reason ?? result.error ?? "The download could not start.");
    } finally {
      setBusy(false);
    }
  }
  async function cancel(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await api.cancelVoiceModelDownload();
      if (!result.ok) setError(result.error ?? "The download could not be cancelled.");
    } finally {
      setBusy(false);
    }
  }
  // Nothing to download for this backend: the row's sentence says so, and a button would fail.
  if (model && model.status === "missing" && model.revision === null) return null;
  const notice = error && <RemedyNotice tone="error" detail={error} hint="Press Re-check, then try again." />;
  if (model && (model.status === "downloading" || model.status === "verifying")) {
    const downloading = model.status === "downloading";
    const percent = model.totalBytes > 0 ? Math.min(100, Math.floor((model.doneBytes / model.totalBytes) * 100)) : 0;
    const figures = voiceModelProgressText(model);
    return (
      <div className="setup-remedy-actions voice-model-progress">
        <div
          className="app-banner-progress"
          role="progressbar"
          aria-label={downloading ? "Downloading the speech model" : "Checking the speech model"}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-valuetext={figures}
        >
          <span className="app-banner-progress-fill" style={{ width: `${percent}%` }} />
        </div>
        <div className="voice-model-progress-line">
          <span className="voice-model-figures">{figures}</span>
          {downloading && (
            <Tooltip label="Stop the download and delete what it has written">
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void cancel()}>Cancel</button>
            </Tooltip>
          )}
        </div>
        {notice}
      </div>
    );
  }
  const failed = model?.status === "failed";
  return (
    <div className="setup-remedy-actions">
      <div className="setup-run-controls">
        <Tooltip label={note}>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void start()}>
            {failed ? "Retry" : label}
          </button>
        </Tooltip>
        {model && model.totalBytes > 0 && (
          <span className="voice-model-figures">{formatBytes(model.totalBytes)} from Hugging Face</span>
        )}
      </div>
      {notice}
    </div>
  );
}

function MicrophoneRemedy({ label, note, action, onRepaired }: {
  label: string; note: string; action?: "settings" | "ask"; onRepaired(): void;
}): React.JSX.Element {
  const fix = typeof window !== "undefined" && window.missionDesktop?.fixVoiceMicrophone;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function apply() {
    if (!fix) return;
    setBusy(true);
    setError("");
    try { await fix(); onRepaired(); }
    catch { setError("Could not open microphone settings."); }
    finally { setBusy(false); }
  }
  return (
    <div className="setup-remedy-actions">
      {!fix && <p className="setup-remedy-note">{note}</p>}
      <div className="setup-run-controls">
        {fix && action && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void apply()}>
          {action === "settings" ? "Open System Settings" : "Ask macOS"}
        </button>}
        {(!fix || action !== "ask") && <Tooltip label="Read the microphone permission again">
          <button type="button" className="btn btn-ghost" onClick={onRepaired}>{label}</button>
        </Tooltip>}
      </div>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

/** The pill a row reads while the live state is mid-way through something the snapshot cannot say. */
function liveStatusLabel(row: SetupRowView, voice: VoiceState | null): string | null {
  if (row.remedy.kind !== "voice-model-download" || !voice) return null;
  if (voice.model.status === "downloading") return "Downloading";
  if (voice.model.status === "verifying") return "Verifying";
  return null;
}

function Remedy({ row, onRepaired }: { row: SetupRowView; onRepaired(): void }): React.JSX.Element | null {
  const remedy = row.remedy;
  if (remedy.kind === "feature-flags") {
    return <FeatureFlagsRemedy flags={remedy.flags} label={remedy.label} note={remedy.note} onRepaired={onRepaired} />;
  }
  if (remedy.kind === "voice-model-download") {
    return <VoiceModelRemedy label={remedy.label} note={remedy.note} />;
  }
  if (remedy.kind === "microphone-access") {
    return <MicrophoneRemedy action={remedy.action} label={remedy.label} note={remedy.note} onRepaired={onRepaired} />;
  }
  if (remedy.kind === "service") {
    return (
      <ServiceRemedy
        service={remedy.service}
        label={remedy.label}
        note={remedy.note}
        onRepaired={onRepaired}
      />
    );
  }
  if (remedy.kind === "integrations") {
    return <IntegrationsRemedy note={remedy.note} fallback={remedy.fallback} onRepaired={onRepaired} />;
  }
  if (remedy.kind === "command") {
    return row.rowId.source === "dependency"
      ? <CommandRemedy id={row.rowId.id} label={row.label} purpose={remedy.purpose} argv={remedy.argv} note={remedy.note} />
      : <CopyCommand argv={remedy.argv} note={remedy.note} />;
  }
  if (remedy.kind === "provider-installer") {
    return row.rowId.source === "dependency"
      ? <ProviderInstallerRemedy id={row.rowId.id} label={row.label} provider={remedy.provider} />
      : (
          <Tooltip label="Open the Conductor settings that own provider source setup">
            <a className="setup-link" href="#/settings/conductor">Open Conductor settings<span aria-hidden> ↗</span></a>
          </Tooltip>
        );
  }
  if (remedy.kind === "skill") {
    return <CopyCommand argv={[remedy.command]} note="Copy skill command" />;
  }
  return (
    <Tooltip label={remedy.label}>
      <a
        className="setup-link"
        href={remedy.url}
        target={remedy.url.startsWith("http") ? "_blank" : undefined}
        rel={remedy.url.startsWith("http") ? "noreferrer" : undefined}
      >
        {remedy.label}<span aria-hidden> ↗</span>
      </a>
    </Tooltip>
  );
}

/** Separate from warning rows: installing for the first time is an explicit opt-in. */
function PiExtensionInstall({ available, warning, onInstalled }: { available: boolean; warning: boolean; onInstalled(): void }): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  // An attempt notice is obsolete once a fresh check reports a different installation state.
  useEffect(() => { setDetail(null); }, [available, warning]);
  const install = async () => {
    setBusy(true);
    try {
      const result = await openSetupInstaller({ id: "pi-integration" });
      setDetail(result.detail ?? result.error ?? "The Pi integration could not be installed.");
    } catch (error) { setDetail(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); onInstalled(); }
  };
  if (!available && (!detail || warning)) return <></>;
  return (
    <article className="setup-row" aria-label={warning ? "Repair Pi integration" : "Install Pi integration"}>
      <div className="setup-row-main">
        <div className="setup-row-title"><strong>Pi integration</strong></div>
        <p className="setup-impact">Connect new Pi sessions to Mission Control tools and lifecycle reporting.</p>
        {available && (
          <Tooltip label="Install the Mission Control extension for new Pi sessions on this machine">
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void install()}>
              {busy ? "Installing..." : warning ? "Repair Pi integration" : "Install Pi integration"}
            </button>
          </Tooltip>
        )}
        {detail && <p className="setup-why" role="status">{detail}</p>}
      </div>
    </article>
  );
}

const STATUS_LABEL = {
  satisfied: "Ready",
  missing: "Missing",
  "needs-setup": "Needs setup",
  unknown: "Unknown",
} as const;

/**
 * Evidence, shortened to `~` where it sits under this machine's home.
 *
 * The tooltip carries the absolute path, and only when shortening actually hid something:
 * a hover that repeats the text already on screen is worse than no hover at all.
 */
function Evidence({ evidence, home }: { evidence: string; home: string }): React.JSX.Element {
  const shown = homeRelative(evidence, home);
  const line = <p className="setup-evidence">{shown}</p>;
  return shown === evidence ? line : <Tooltip label={evidence}>{line}</Tooltip>;
}

/**
 * The multiplexer a Setup row is about, or null when the row is not one.
 *
 * No mapping table: `SETUP_DEPENDENCY_IDS` spells its multiplexer values exactly as
 * `MULTIPLEXER_IDS` does, and this narrows through that shared spelling rather than
 * restating the list.
 */
function multiplexerForRow(row: SetupRowView): MultiplexerId | null {
  if (row.family !== "terminals" || row.rowId.source !== "dependency") return null;
  return MULTIPLEXER_IDS.find((id) => id === row.rowId.id) ?? null;
}

/**
 * The trailing "Opens in" control on one multiplexer's row.
 *
 * WHICH multiplexers get one is the daemon's answer, not this component's: `needsTerminalApp`
 * is derived from the adapter's `attachArgv`, so a backend that draws its own window says so
 * itself and a future self-hosting multiplexer needs no edit here. Naming cmux in the browser
 * would put a second copy of that declaration somewhere nothing can check it against the
 * adapter.
 *
 * A multiplexer that is not installed keeps the control and disables it: there is nothing to
 * set a preference for yet, and a live control would imply otherwise.
 */
function MultiplexerTerminal({
  mux,
  row,
  target,
  targets,
  terminals,
}: {
  mux: MultiplexerId;
  row: SetupRowView;
  target: TerminalTargetView | undefined;
  /** The panel's own reading, so a Re-check reaches the menu's rows too. */
  targets: TerminalTargetsState;
  terminals: TerminalsConfigState;
}): React.JSX.Element | null {
  // The daemon has not answered yet. Rendering either branch now would guess.
  if (target?.needsTerminalApp === undefined) return null;
  if (!target.needsTerminalApp) {
    return (
      <div className="setup-row-aside">
        <Tooltip label={`${target.label} sessions are drawn in their own window`}>
          <span className="pref-inert">Needs no terminal</span>
        </Tooltip>
      </div>
    );
  }
  const stored = terminals.config?.multiplexerTerminal[mux] ?? null;
  // The SHARED resolver over the config this browser fetched - never the server-only
  // `resolveFocusEmulator`, which reads the daemon's own config.
  const unknown = resolveEmulatorBackend(stored).unknown;
  return (
    <div className="setup-row-aside">
      <span className="launch-head">Opens in</span>
      <TerminalPreferencePicker
        id={`setup-terminal-${mux}`}
        copy={multiplexerTerminalCopy(target.label)}
        groups={EMULATOR_GROUPS}
        resolve={resolveEmulatorBackend}
        value={stored}
        availability={targets}
        disabled={terminals.config === null || row.status.state !== "satisfied"}
        onChange={(backend: EmulatorId | null) => {
          void terminals.update({ multiplexerTerminal: { [mux]: backend } });
        }}
      />
      {unknown && (
        <p className="setup-pref-unknown">
          Ignoring “{unknown}”, which is not a terminal app this build offers here.
        </p>
      )}
    </div>
  );
}

/** Where the outside-sessions switch is, for a deep link or the settings palette. */
export const SETUP_EXTERNAL_SESSIONS_ANCHOR = "setup/external-sessions";

/** The warning shown under the outside-sessions setting, always, whether it is on or off. */
export const EXTERNAL_SESSIONS_WARNING =
  "Off by default. When on, Mission Control also shows Claude, Codex, and Pi sessions you " +
  "started yourself in a terminal. This works poorly on some setups: cards can show the wrong " +
  "state, name, or pane, and sending to them can fail. Sessions Mission Control starts are " +
  "always shown.";

/**
 * The Terminals family's one switch that is not about a multiplexer: whether passive discovery
 * shows sessions Mission Control did not start (`TerminalsConfig.externalSessions`). Workers in
 * an observed pipeline worktree are shown either way.
 *
 * The warning is outside the label and always rendered, so it is read before anyone turns
 * this on rather than discovered after. Disabled until the config has been read, like the
 * multiplexer choosers beside it, so the box never shows a guess as the stored value.
 */
export function ExternalSessionsSetting({ terminals }: { terminals: TerminalsConfigState }): React.JSX.Element {
  const on = terminals.config?.externalSessions === true;
  return (
    <div className="setup-external-sessions" data-anchor={SETUP_EXTERNAL_SESSIONS_ANCHOR}>
      <label className={`settings-toggle${on ? " is-on" : ""}`}>
        <Tooltip label="Also show Claude, Codex, and Pi sessions you started yourself in a terminal">
          <input
            type="checkbox"
            checked={on}
            disabled={terminals.config === null}
            aria-describedby="setup-external-sessions-warning"
            onChange={(e) => { void terminals.update({ externalSessions: e.target.checked }); }}
          />
        </Tooltip>
        <span className="settings-toggle-text">
          <span className="settings-toggle-label">Show sessions started outside Mission Control</span>
        </span>
      </label>
      <p className="settings-warn" id="setup-external-sessions-warning">{EXTERNAL_SESSIONS_WARNING}</p>
    </div>
  );
}

function SetupRow({
  row,
  home,
  aside,
  onRepaired,
}: {
  row: SetupRowView;
  home: string;
  /** A trailing control belonging to this row, or null. See `MultiplexerTerminal`. */
  aside?: React.JSX.Element | null;
  onRepaired(): void;
}): React.JSX.Element {
  const status = row.status;
  const satisfied = status.state === "satisfied";
  const liveLabel = liveStatusLabel(row, useContext(SetupVoiceContext));
  const main = (
    <div className="setup-row-main">
      <div className="setup-row-title">
        {/* Labelled, not decorative. Dropping the pill from a satisfied row left the dot as
            the only thing saying so, and a dot conveys its meaning entirely through colour -
            which is no meaning at all to a screen reader, and the one state with no pill,
            no amber wash and no impact sentence to fall back on. */}
        <span
          className={`setup-dot setup-dot-${satisfied ? "ready" : "gap"}`}
          role="img"
          aria-label={STATUS_LABEL[status.state]}
        />
        <strong>{row.label}</strong>
        {/* A satisfied row states its status with the dot and its own colour. The pill is
            kept for the states that need a word, and `required` is the only requirement
            worth repeating on a row that is already fine - "recommended" on ten healthy
            rows describes a decision made long ago and says nothing about now. */}
        {!satisfied && (
          <span className={`setup-status setup-status-${status.state}`}>{liveLabel ?? STATUS_LABEL[status.state]}</span>
        )}
        {(!satisfied || row.requirement === "required") && (
          <span className={`setup-requirement setup-requirement-${row.requirement}`}>{row.requirement}</span>
        )}
      </div>
      {satisfied ? (
        <>
          <Evidence evidence={status.evidence} home={home} />
          {status.source && <p className="setup-source">Source: {status.source}</p>}
        </>
      ) : (
        <>
          <p className="setup-impact">{row.enables}</p>
          {status.state !== "missing" && <p className="setup-why">{status.why}</p>}
          {status.state !== "missing" && status.evidence && (
            <Evidence evidence={status.evidence} home={home} />
          )}
          {status.state !== "missing" && status.source && <p className="setup-source">Source: {status.source}</p>}
          <Remedy row={row} onRepaired={onRepaired} />
        </>
      )}
      {row.guide && (
        <div className="setup-guide">
          <Tooltip label={row.guide.label}>
            <a className="setup-link" href={row.guide.url} target="_blank" rel="noreferrer">
              {row.guide.label}<span aria-hidden> ↗</span>
            </a>
          </Tooltip>
        </div>
      )}
    </div>
  );
  return (
    <article className={`setup-row setup-row-${status.state}`} data-anchor={setupRowAnchor(row.rowId)}>
      {aside
        ? (
            <div className="setup-row-split">
              {main}
              {aside}
            </div>
          )
        : main}
    </article>
  );
}

/** The stable empty reading, so "no rows yet" keeps one identity across renders. */
const NO_ROWS: readonly SetupRowView[] = [];

/** How many of a family's checks are satisfied, and whether any gap is a required one. */
interface FamilyTally {
  ready: number;
  total: number;
  gaps: number;
  requiredGaps: number;
}

function tally(rows: readonly SetupRowView[]): FamilyTally {
  const gaps = rows.filter((row) => row.status.state !== "satisfied");
  return {
    ready: rows.length - gaps.length,
    total: rows.length,
    gaps: gaps.length,
    requiredGaps: gaps.filter((row) => row.requirement === "required").length,
  };
}

/**
 * Which family the rail opens on before the operator has chosen one.
 *
 * A required gap first, then any gap, then the catalog's first family. The panel exists to
 * say what this machine cannot do, so opening on a family that is entirely fine buries the
 * answer behind a click - and the Setup banner links straight here precisely when something
 * required is unsatisfied.
 */
function defaultFamily(rows: readonly SetupRowView[], flagOn?: (flag: FeatureFlagId) => boolean): SetupFamilyId {
  const byFamily = visibleSetupFamilyIds(rows, undefined, flagOn).map((family) => ({
    family,
    tally: tally(rows.filter((row) => row.family === family)),
  }));
  return (
    byFamily.find((entry) => entry.tally.requiredGaps > 0)?.family
    ?? byFamily.find((entry) => entry.tally.gaps > 0)?.family
    ?? SETUP_FAMILY_IDS[0]
  );
}

/**
 * The family a deep-link anchor lands in, or null when it names nothing this build renders.
 *
 * Two anchor shapes reach here. `setup/family-<id>` is the rail item itself, which is what
 * the guided tour and any "show me this family" caller asks for. Anything else is a row
 * anchor from `setupRowAnchor`, and a row is only in the DOM while its family is selected -
 * so a jump to one has to select that family first, or the page's flash observer waits for
 * an element that will never mount and silently lights nothing.
 */
export function familyForAnchor(
  anchor: string,
  rows: readonly SetupRowView[],
  /** The resolved flags, so a link to a family behind an off flag (Voice) names nothing. */
  flagOn?: (flag: FeatureFlagId) => boolean,
): SetupFamilyId | null {
  // Only a family the rail draws: a link to one hidden with its integration names nothing.
  const named = visibleSetupFamilyIds(rows, undefined, flagOn).find((family) => anchor === `setup/family-${family}`);
  if (named) return named;
  // The Repositories family's directory editor is not a row, but it is only mounted while
  // that family is selected, so its controls resolve the same way a row anchor does.
  if ((Object.values(SETUP_REPOSITORY_ANCHORS) as string[]).includes(anchor)) return "repositories";
  // Likewise the Terminals family's outside-sessions switch, which is not a row either.
  if (anchor === SETUP_EXTERNAL_SESSIONS_ANCHOR) return "terminals";
  const listed = rows.find((row) => setupRowAnchor(row.rowId) === anchor)?.family;
  if (listed) return listed;
  // An environment-check row exists only while its check warns, and the snapshot on screen
  // may predate the warning that sent the operator here (the dispatch form re-reads the
  // machine on every open; this panel reads it at startup and on Re-check). Its family is
  // fixed by the catalog, so the rail moves now and the page's flash waits for the row to
  // mount once the refreshed snapshot lands, rather than the request being consumed
  // unresolved against rows that do not carry it yet.
  const check = ENVIRONMENT_CHECK_IDS.find(
    (id) => anchor === setupRowAnchor({ source: "environment-check", id }),
  );
  return check ? ENVIRONMENT_ROW_METADATA[check].family : null;
}

/** Which family the rail is showing, and which deep-link request settled it. */
export interface SetupSelection {
  chosen: SetupFamilyId | null;
  seenRequest: number | null;
}

export interface SetupSelectionInput {
  rows: readonly SetupRowView[];
  jumpRequestId: number | null;
  jumpFamily: SetupFamilyId | null;
}

/**
 * The rail's next selection, or null when nothing should change.
 *
 * Pure, and separate from the effect that applies it, because the precedence here is the
 * whole of the rail's behaviour and none of it is observable in markup: a deep link has to
 * beat the opening default, the opening default has to be latched exactly once, and a request
 * that arrives before the snapshot must not be consumed unresolved.
 */
export function nextSetupSelection(
  current: SetupSelection,
  input: SetupSelectionInput,
): SetupSelection | null {
  const unseen = input.jumpRequestId !== current.seenRequest;
  // A fresh deep link outranks the default and the operator's last click alike. Latched as
  // soon as it resolves, rows or not: an environment-check anchor resolves from the catalog
  // before the snapshot lands (`familyForAnchor`), and the page stops handing the jump down
  // once it has started waiting for the control. Waiting for rows here as well let a slow
  // first read lose the jump and open the default family instead.
  if (unseen && input.jumpFamily) {
    return { chosen: input.jumpFamily, seenRequest: input.jumpRequestId };
  }

  // Nothing else to decide from. An unresolved request is deliberately left unconsumed: the
  // panel starts fetching as it mounts, so a link from the command palette or Foreman
  // routinely arrives before the rows that would resolve it.
  if (input.rows.length === 0) return null;

  // An unresolvable request is consumed rather than waited on, so a link to a row this build
  // does not render cannot pin the rail forever.
  const seenRequest = unseen ? input.jumpRequestId : current.seenRequest;
  // Latched once. `defaultFamily` answers "where are the gaps", and that answer changes:
  // re-deriving it would move the rail on the very Re-check that repaired the family being
  // read, unmounting those rows to reward the operator for fixing something.
  const chosen = current.chosen ?? defaultFamily(input.rows);
  if (chosen === current.chosen && seenRequest === current.seenRequest) return null;
  return { chosen, seenRequest };
}

function VerdictHeader({
  rows,
  loading,
  onRefresh,
  recheckRef,
}: {
  rows: readonly SetupRowView[];
  loading: boolean;
  onRefresh(): void;
  recheckRef: (node: HTMLButtonElement | null) => void;
}): React.JSX.Element {
  const all = tally(rows);
  const read = rows.length > 0;
  const clean = read && all.requiredGaps === 0;
  return (
    // Carries `setup/recheck`, which is what the command palette's "Machine setup checks"
    // entry deep-links to. It used to sit on an intro paragraph that this header replaced.
    <header className="setup-verdict" data-anchor="setup/recheck">
      <div
        className={`setup-verdict-mark is-${read ? (clean ? "ready" : "attention") : "unknown"}`}
        aria-hidden
      >
        {read ? (clean ? "✓" : "!") : "…"}
      </div>
      <div className="setup-verdict-body">
        <h3>
          {!read
            ? "Reading this machine..."
            : clean
              ? "This machine can run sessions."
              : "This machine is missing something required."}
        </h3>
        {/* One tick per check, in catalog order. The shape of the machine is readable before
            any word is, and amber-versus-red carries the only distinction that changes what
            you have to do about it. */}
        {read && (
          <>
            <div className="setup-meter" role="img" aria-label={`${all.ready} of ${all.total} checks ready`}>
              {rows.map((row) => {
                const state = row.status.state === "satisfied"
                  ? "ready"
                  : row.requirement === "required" ? "required" : "gap";
                return <span key={setupRowAnchor(row.rowId)} className={`setup-tick is-${state}`} />;
              })}
            </div>
            <p className="setup-verdict-detail">
              <strong>{all.ready} of {all.total} ready</strong>
              {clean
                ? all.gaps === 0
                  ? " · nothing is missing."
                  : ` · no required gaps. ${all.gaps} optional tool${all.gaps === 1 ? "" : "s"} would add capability.`
                : ` · ${all.requiredGaps} required gap${all.requiredGaps === 1 ? "" : "s"} blocks work.`}
            </p>
          </>
        )}
      </div>
      <div className="setup-verdict-actions">
        {/* This is a tour target, so its DOM identity must survive the loading transition.
            Keep the native trigger mounted and express the brief unavailable state with
            aria-disabled. Tooltip can then merge its handlers into the same button instead
            of adding the disabled-trigger anchor that would disconnect Driver's target. */}
        <Tooltip label="Inspect this machine again">
          <button
            type="button"
            className="btn btn-ghost"
            aria-disabled={loading}
            onClick={loading ? undefined : onRefresh}
            ref={recheckRef}
          >
            {loading ? "Checking..." : "Re-check"}
          </button>
        </Tooltip>
        <p className="setup-verdict-note">Package installers open in a visible terminal. Integration installs run here.</p>
      </div>
    </header>
  );
}

export function SetupPanel({
  state,
  voice = null,
  jumpAnchor = null,
  jumpRequestId = null,
}: {
  state: SetupChecksState;
  /** `MissionState.voice`, which the Voice family's speech model row follows live. */
  voice?: VoiceState | null;
  /** A deep link asking for one row or one family. See `familyForAnchor`. */
  jumpAnchor?: string | null;
  jumpRequestId?: number | null;
}): React.JSX.Element {
  // The family rail and the rows it selects, as one spotlight: the tour hands the whole
  // dependency list over rather than reading a family, because which family is worth opening
  // depends on what this machine turns out to be missing.
  const dependenciesTourRef = useTourTargetRef<HTMLDivElement>("setup:dependencies");
  const recheckTourRef = useTourTargetRef<HTMLButtonElement>("setup:recheck");
  // The Terminals family's per-multiplexer chooser. The targets say WHICH multiplexers need
  // one (`needsTerminalApp`) and the config says what each is set to; both are read here so
  // the rows share one answer rather than each asking the daemon.
  // Re-checked alongside the machine itself: the targets read is the one answer on this panel
  // that can fail on its own, and without the bump a failed read would leave the Terminals
  // rows without their choosers until the panel happened to remount.
  const [terminalRevision, setTerminalRevision] = useState(0);
  const terminalTargets = useTerminalTargets(terminalRevision);
  const terminals = useTerminalsConfig(terminalRevision);
  const recheck = useCallback((): void => {
    setTerminalRevision((n) => n + 1);
    void state.refresh();
  }, [state]);

  // `NO_ROWS` rather than a fresh `[]`: this array is an effect dependency and a memo input,
  // and a new identity every render makes both of them run every render.
  // The event stream's flags, so a family behind a preview flag (Voice) appears and leaves the
  // rail the moment it is switched, in every window.
  const flags = useContext(FeatureFlagsContext);
  const flagOn = useCallback((flag: FeatureFlagId) => resolveFeatureFlag(flag, flags), [flags]);
  // A snapshot read while a family's flag was on still holds its rows after the flag goes off,
  // until the re-read lands. The live flag wins: those rows leave the rail, the pane and the
  // verdict's counts at once, so no repair button outlives the feature it repairs.
  const readRows = state.view?.rows ?? NO_ROWS;
  // The speech model's row reads the live model state over the snapshot's: a download runs for
  // minutes, and the bar, the rail's count and the verdict should all move with it, in every
  // window, rather than at the next Re-check. The daemon's probe gives the same reading.
  const liveModel = voice && voice.mode !== "off" && voice.model.backend !== null ? voice.model : null;
  const rows = useMemo(() => {
    const shown = readRows.filter((row) => setupFamilyFlagOn(row.family, flagOn));
    const flagged = shown.length === readRows.length ? readRows : shown;
    if (!liveModel) return flagged;
    return flagged.map((row) => (row.remedy.kind === "voice-model-download" ? { ...row, status: voiceModelSetupStatus(liveModel) } : row));
  }, [readRows, flagOn, liveModel]);
  const home = state.view?.home ?? "";
  const families = useMemo(() => visibleSetupFamilyIds(rows, undefined, flagOn), [rows, flagOn]);

  // A remedy that settles in the daemon re-reads the machine itself, so the row it repaired
  // reports the new truth rather than waiting for the operator to press Re-check on a
  // question they have already answered.
  const refresh = state.refresh;
  // The shell can obtain or lose access after Setup's initial probe, including while
  // macOS has focus. Re-read the daemon's merged listener/shell reading on a transition.
  const microphone = voice?.capabilities.microphone;
  const microphoneStatus = microphone && (microphone.available ? "granted" : microphone.reason ?? "unknown");
  useEffect(() => {
    if (microphoneStatus !== undefined) void refresh();
  }, [microphoneStatus, refresh]);

  const onRepaired = useCallback(() => { void refresh(); }, [refresh]);

  // Chosen, not derived on every read. `null` means "nobody has chosen", which is the only
  // state `defaultFamily` may answer for: re-deriving on each snapshot would move the rail
  // out from under the operator the moment a Re-check repaired the family they were reading.
  const [chosen, setChosen] = useState<SetupFamilyId | null>(null);
  const [seenRequest, setSeenRequest] = useState<number | null>(null);

  // A deep link outranks the default and the operator's last click alike - it is a fresh,
  // explicit request to look at one thing. Keyed on the request id so the same anchor asked
  // for twice still moves the rail back after the operator has clicked elsewhere.
  const jumpFamily = useMemo(
    () => (jumpAnchor ? familyForAnchor(jumpAnchor, rows, flagOn) : null),
    [jumpAnchor, rows, flagOn],
  );

  // Applied during render rather than only in the effect below, and both are needed.
  //
  // Render is what makes the FIRST paint already show the requested family: settling this in
  // an effect alone renders the default family once and then swaps, which is a visible flash
  // on every deep link and renders the wrong family entirely where effects do not run.
  // The effect is what makes it STICK: the page clears the jump as soon as it has flashed the
  // control, so a family held only by the live prop would snap back the moment it went away.
  const unseenJump = jumpRequestId !== seenRequest ? jumpFamily : null;
  const picked = unseenJump ?? chosen ?? (rows.length > 0 ? defaultFamily(rows, flagOn) : SETUP_FAMILY_IDS[0]);
  // A family chosen while its flag was on stops being drawn when the flag goes off; the pane
  // follows the rail rather than showing a family nothing selects.
  const active = families.includes(picked) ? picked : families[0] ?? SETUP_FAMILY_IDS[0];

  // One effect applying one decision, because the jump and the opening default both write
  // `chosen`: as two effects they fire in the same commit and the loser is decided by
  // declaration order, which is how a deep link loses to the default it was overriding.
  useEffect(() => {
    const next = nextSetupSelection({ chosen, seenRequest }, { rows, jumpRequestId, jumpFamily });
    if (!next) return;
    setChosen(next.chosen);
    setSeenRequest(next.seenRequest);
  }, [rows, jumpFamily, jumpRequestId, seenRequest, chosen]);

  const info = SETUP_FAMILY_INFO[active];
  const activeRows = rows.filter((row) => row.family === active);
  // Polled only while its family is on screen, like every other Settings reader: the index
  // walks the filesystem, and nothing else in Setup needs its directory list.
  const repoIndex = useRepoIndex(active === "repositories");

  return (
    <SetupVoiceContext.Provider value={voice}>
    <SetupTerminalTargetsContext.Provider value={terminalTargets}>
    <section className="settings-section setup-panel">
      {/* No standing intro paragraph. It spent the top of the panel restating the question
          ("see what Mission Control can use on this machine") that the verdict now answers
          outright, and its read-only promise is the verdict's own note. */}
      <VerdictHeader
        rows={rows}
        loading={state.loading}
        onRefresh={recheck}
        recheckRef={recheckTourRef}
      />
      {state.error && <p className="settings-error">{state.error}</p>}
      <div className="setup-split" ref={dependenciesTourRef}>
        <nav className="setup-rail" aria-label="Setup families">
          {/* A family emptied by a hidden integration (Pipelines, while ai-conductor is
              hidden) is not drawn at all, rather than drawn as a family with nothing in it. */}
          {families.map((family) => {
            const familyRows = rows.filter((row) => row.family === family);
            const counts = tally(familyRows);
            const label = SETUP_FAMILY_INFO[family].label;
            return (
              <Tooltip key={family} label={SETUP_FAMILY_INFO[family].description}>
                <button
                  type="button"
                  id={`setup-family-${family}`}
                  data-anchor={`setup/family-${family}`}
                  className={`setup-rail-item${family === active ? " is-active" : ""}`}
                  aria-current={family === active ? "true" : undefined}
                  // Spelt out, because the visible count is "2/5": a screen reader reading a
                  // rail of five of those learns nothing, and the dot beside it is decorative.
                  aria-label={familyRows.length > 0
                    ? `${label}: ${counts.ready} of ${counts.total} ready`
                    : label}
                  onClick={() => setChosen(family)}
                >
                  {/* Only once there is a reading to report. With no rows every family has
                      no gaps, which would draw five green dots while the machine is still
                      being inspected - a clean bill of health nothing has established yet. */}
                  {familyRows.length > 0 && (
                    <span
                      className={`setup-dot setup-dot-${counts.gaps > 0 ? "gap" : "ready"}`}
                      aria-hidden
                    />
                  )}
                  <span className="setup-rail-label">{label}</span>
                  {familyRows.length > 0 && (
                    <span className="setup-rail-count">{counts.ready}/{counts.total}</span>
                  )}
                </button>
              </Tooltip>
            );
          })}
        </nav>
        <div
          className="setup-pane"
          id="setup-pane"
          aria-labelledby={`setup-family-${active}-title`}
        >
          <header className="setup-pane-head">
            <h3 id={`setup-family-${active}-title`}>{info.label}</h3>
            <p>{info.description}</p>
          </header>
          {active === "runtime" && (
            <div className="setup-row" aria-label="Serving runtime">
              <div className="setup-row-main">
                <strong>{state.view?.runtime?.origin === "bundled" ? "App-owned Electron runtime"
                  : state.view?.runtime?.origin === "standalone" ? "Standalone Node.js"
                    : state.view?.runtime?.origin === "electron-development" ? "Development Electron runtime"
                      : "Serving runtime unknown"}</strong>
                <p>{state.view?.runtime
                  ? `Node.js ${state.view.runtime.node}${state.view.runtime.electron ? ` · Electron ${state.view.runtime.electron}` : ""}`
                  : "This daemon does not report its runtime. Reconnect after upgrading to inspect it."}</p>
                {state.view?.runtime && <Evidence evidence={state.view.runtime.executable} home={home} />}
                <p>{state.view?.runtime?.origin === "bundled"
                  ? "Electron includes Node. Desktop installation, binary updates and Mission-owned tools do not need a system Node installation."
                  : "Source development requires Node.js 24+. A standalone daemon keeps its own runtime even when adopted by the desktop app."}</p>
              </div>
            </div>
          )}
          {active === "extensions" && (
            <><OwnedIntegrationRepair /><PiExtensionInstall
              available={state.view?.piExtensionInstallAvailable ?? false}
              warning={rows.some(row => row.rowId.source === "environment-check" && row.rowId.id === "pi-extension")}
              onInstalled={onRepaired}
            /></>
          )}
          {/* One sentence for the whole family: the choosers share one hook, so a refusal
              printed per row would repeat itself on every multiplexer. */}
          {active === "terminals" && terminals.error && (
            <p className="settings-error">{terminals.error}</p>
          )}
          {/* A failed targets read leaves every chooser absent, which on its own reads as
              "this build has no terminal apps". Re-check retries it. */}
          {active === "terminals" && terminalTargets.failed && (
            <p className="settings-warn">
              Mission Control could not check terminal availability, so the per-multiplexer
              terminal choosers are hidden. Re-check to try again.
            </p>
          )}
          {activeRows.length > 0
            ? (
                <div className="setup-rows">
                  {activeRows.map((row) => {
                    const mux = multiplexerForRow(row);
                    return (
                      <SetupRow
                        key={setupRowAnchor(row.rowId)}
                        row={row}
                        home={home}
                        aside={mux && (
                          <MultiplexerTerminal
                            mux={mux}
                            row={row}
                            target={terminalTargets.targets?.find((t) => t.id === mux)}
                            targets={terminalTargets}
                            terminals={terminals}
                          />
                        )}
                        onRepaired={onRepaired}
                      />
                    );
                  })}
                </div>
              )
            : <p className="setup-loading">{state.error ? "No result" : "Checking this machine..."}</p>}
          {/* Outside the row list, so it is there before the machine check answers: it is a
              setting about what the dashboard shows, not a dependency of this machine. */}
          {active === "terminals" && <ExternalSessionsSetting terminals={terminals} />}
          {/* Below the row that requires a detected repository, so the check and the list it
              reads are one screen: an edit here re-reads the machine and the row follows. */}
          {active === "repositories" && <RepositoriesPanel state={repoIndex} onChanged={onRepaired} />}
        </div>
      </div>
    </section>
    </SetupTerminalTargetsContext.Provider>
    </SetupVoiceContext.Provider>
  );
}
