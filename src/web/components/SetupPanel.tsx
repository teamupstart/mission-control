import {
  SETUP_FAMILY_IDS,
  SETUP_FAMILY_INFO,
  setupRowAnchor,
  type SetupRemedy,
  type SetupRowView,
} from "@shared/setup-catalog.ts";
import { COPY_FEEDBACK_LABEL, useCopyFeedback } from "../lib/clipboard.ts";
import type { SetupChecksState } from "../useSetupChecks.ts";
import { Tooltip } from "./Tooltip.tsx";

function CommandRemedy({ argv, note }: { argv: readonly string[]; note: string }): React.JSX.Element {
  const text = argv.join(" ");
  const copy = useCopyFeedback({ resetOn: text });
  return (
    <div className="setup-command">
      <code>{text}</code>
      <Tooltip label={copy.copied ? COPY_FEEDBACK_LABEL : note}>
        <button type="button" className="btn btn-ghost" onClick={() => void copy.copy(text)}>
          {copy.copied ? COPY_FEEDBACK_LABEL : "Copy"}
        </button>
      </Tooltip>
      {copy.error && <span className="settings-error">{copy.error}</span>}
    </div>
  );
}

function Remedy({ remedy }: { remedy: SetupRemedy }): React.JSX.Element {
  if (remedy.kind === "command") return <CommandRemedy argv={remedy.argv} note={remedy.note} />;
  if (remedy.kind === "skill") return <CommandRemedy argv={[remedy.command]} note="Copy skill command" />;
  const destination = remedy.kind === "provider-installer" ? "#/settings/conductor" : remedy.url;
  const label = remedy.kind === "provider-installer" ? "Open Conductor settings" : remedy.label;
  return (
    <Tooltip label={label}>
      <a className="setup-link" href={destination} target={destination.startsWith("http") ? "_blank" : undefined} rel={destination.startsWith("http") ? "noreferrer" : undefined}>
        {label}<span aria-hidden> ↗</span>
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
            <Remedy remedy={row.remedy} />
          </>
        )}
      </div>
    </article>
  );
}

export function SetupPanel({ state }: { state: SetupChecksState }): React.JSX.Element {
  return (
    <section className="settings-section setup-panel">
      <div className="setup-intro" data-anchor="setup/recheck">
        <div>
          <p className="settings-hint">See what Mission Control can use on this machine and what an incomplete setup prevents.</p>
          <p className="setup-read-only">Commands are copied, never run from this page.</p>
        </div>
        <Tooltip label="Inspect this machine again">
          <button type="button" className="btn btn-ghost" disabled={state.loading} onClick={() => void state.refresh()}>
            {state.loading ? "Checking..." : "Re-check"}
          </button>
        </Tooltip>
      </div>
      {state.error && <p className="settings-error">{state.error}</p>}
      {SETUP_FAMILY_IDS.map((family) => {
        const info = SETUP_FAMILY_INFO[family];
        const rows = state.view?.rows.filter((row) => row.family === family) ?? [];
        return (
          <section className="setup-family" id={`setup-family-${family}`} key={family} aria-labelledby={`setup-family-${family}-title`}>
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
