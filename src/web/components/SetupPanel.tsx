import { useEffect, useState } from "react";
import {
  SETUP_FAMILY_IDS,
  SETUP_FAMILY_INFO,
  setupRowAnchor,
  type SetupDependencyId,
  type SetupRowView,
} from "@shared/setup-catalog.ts";
import type {
  PipelineInstallerCandidatesResult,
  PipelineProviderId,
} from "@shared/pipeline.ts";
import type { TerminalBackendId, TerminalTargetView } from "@shared/terminal.ts";
import { COPY_FEEDBACK_LABEL, useCopyFeedback } from "../lib/clipboard.ts";
import {
  fetchPipelineInstallers,
  openSetupInstaller,
  type SetupInstallerLaunchResult,
} from "../lib/api.ts";
import { useTerminalTargets } from "../lib/terminalTargets.ts";
import type { SetupChecksState } from "../useSetupChecks.ts";
import { useTourTargetRef } from "../tour/target-context.tsx";
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

interface TerminalChoice {
  targets: TerminalTargetView[] | null;
  failed: boolean;
  selected: TerminalTargetView | null;
  select(id: TerminalBackendId): void;
}

function useTerminalChoice(): TerminalChoice {
  const terminals = useTerminalTargets();
  const [selectedId, setSelectedId] = useState<TerminalBackendId | null>(null);
  const available = terminals.targets?.filter((target) => target.unavailable === null) ?? [];
  const selected = available.find((target) => target.id === selectedId) ?? available[0] ?? null;

  useEffect(() => {
    if (selected && selected.id !== selectedId) setSelectedId(selected.id);
  }, [selected, selectedId]);

  return { ...terminals, selected, select: setSelectedId };
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
                {target.label}{target.unavailable ? `: ${target.unavailable}` : ""}
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

function LaunchNotice({ result }: { result: SetupInstallerLaunchResult | null }): React.JSX.Element | null {
  if (!result) return null;
  const attention = result.outcome === "opened" || result.outcome === "maybe-opening";
  const detail = result.detail || result.error || "The installer terminal was refused.";
  return (
    <div className={`setup-launch-notice is-${attention ? "attention" : "error"}`} role="status">
      <strong>{detail}</strong>
      {attention && <span>When the installer finishes, press Re-check.</span>}
    </div>
  );
}

function RunButton({
  disabled,
  opening,
  onClick,
}: {
  disabled: boolean;
  opening: boolean;
  onClick(): void;
}): React.JSX.Element {
  return (
    <Tooltip label="Open this daemon-owned install command in the selected visible terminal">
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
  argv,
  note,
}: {
  id: SetupDependencyId;
  label: string;
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
        />
      </div>
      <LaunchNotice result={result} />
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

function Remedy({ row }: { row: SetupRowView }): React.JSX.Element {
  const remedy = row.remedy;
  if (remedy.kind === "command") {
    return row.rowId.source === "dependency"
      ? <CommandRemedy id={row.rowId.id} label={row.label} argv={remedy.argv} note={remedy.note} />
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

const STATUS_LABEL = {
  satisfied: "Ready",
  missing: "Missing",
  "needs-setup": "Needs setup",
  unknown: "Unknown",
} as const;

function SetupRow({ row }: { row: SetupRowView }): React.JSX.Element {
  const status = row.status;
  return (
    <article className={`setup-row setup-row-${status.state}`} data-anchor={setupRowAnchor(row.rowId)}>
      <div className="setup-row-main">
        <div className="setup-row-title">
          <strong>{row.label}</strong>
          <span className={`setup-status setup-status-${status.state}`}>{STATUS_LABEL[status.state]}</span>
          <span className={`setup-requirement setup-requirement-${row.requirement}`}>{row.requirement}</span>
        </div>
        {status.state === "satisfied" ? (
          <p className="setup-evidence">{status.evidence}</p>
        ) : (
          <>
            <p className="setup-impact">{row.enables}</p>
            {status.state !== "missing" && <p className="setup-why">{status.why}</p>}
            {status.state !== "missing" && status.evidence && <p className="setup-evidence">{status.evidence}</p>}
            <Remedy row={row} />
          </>
        )}
      </div>
    </article>
  );
}

export function SetupPanel({ state }: { state: SetupChecksState }): React.JSX.Element {
  const panelTourRef = useTourTargetRef<HTMLElement>("setup:panel");
  const agentsTourRef = useTourTargetRef<HTMLElement>("setup:family-agents");
  const githubTourRef = useTourTargetRef<HTMLElement>("setup:family-github");
  const recheckTourRef = useTourTargetRef<HTMLButtonElement>("setup:recheck");
  const familyTourRefs: Partial<Record<(typeof SETUP_FAMILY_IDS)[number], (node: HTMLElement | null) => void>> = {
    agents: agentsTourRef,
    github: githubTourRef,
  };
  return (
    <section className="settings-section setup-panel">
      <div className="setup-intro" data-anchor="setup/recheck" ref={panelTourRef}>
        <div>
          <p className="settings-hint">See what Mission Control can use on this machine and what an incomplete setup prevents.</p>
          <p className="setup-read-only">Commands stay copyable. Runnable remedies open in a visible terminal where you can watch them and read the exit code.</p>
        </div>
        <Tooltip label="Inspect this machine again">
          <button type="button" className="btn btn-ghost" disabled={state.loading} onClick={() => void state.refresh()} ref={recheckTourRef}>
            {state.loading ? "Checking..." : "Re-check"}
          </button>
        </Tooltip>
      </div>
      {state.error && <p className="settings-error">{state.error}</p>}
      {SETUP_FAMILY_IDS.map((family) => {
        const info = SETUP_FAMILY_INFO[family];
        const rows = state.view?.rows.filter((row) => row.family === family) ?? [];
        return (
          <section className="setup-family" id={`setup-family-${family}`} key={family} aria-labelledby={`setup-family-${family}-title`} ref={familyTourRefs[family]}>
            <header className="setup-family-head">
              <div>
                <h3 id={`setup-family-${family}-title`}>{info.label}</h3>
                <p>{info.description}</p>
              </div>
              {rows.length > 0 && <span>{rows.filter((row) => row.status.state === "satisfied").length}/{rows.length} ready</span>}
            </header>
            {rows.length > 0 ? <div className="setup-rows">{rows.map((row) => <SetupRow key={setupRowAnchor(row.rowId)} row={row} />)}</div> : <p className="setup-loading">{state.error ? "No result" : "Checking this machine..."}</p>}
          </section>
        );
      })}
    </section>
  );
}
