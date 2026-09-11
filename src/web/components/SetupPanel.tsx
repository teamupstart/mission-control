import { useCallback, useEffect, useMemo, useState } from "react";
import {
  SETUP_FAMILY_IDS,
  SETUP_FAMILY_INFO,
  homeRelative,
  setupRowAnchor,
  type SetupDependencyId,
  type SetupFamilyId,
  type SetupRowView,
  type SetupServiceId,
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
  startSetupService,
  type SetupInstallerLaunchResult,
  type SetupServiceStartResult,
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

function LaunchNotice({ result }: { result: SetupInstallerLaunchResult | null }): React.JSX.Element | null {
  if (!result) return null;
  const attention = result.outcome === "opened" || result.outcome === "maybe-opening";
  return (
    <RemedyNotice
      tone={attention ? "attention" : "error"}
      detail={result.detail || result.error || "The installer terminal was refused."}
      hint={attention ? "When the installer finishes, press Re-check." : undefined}
    />
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

  async function start(): Promise<void> {
    setStarting(true);
    setResult(null);
    try {
      const next = await startSetupService({ service });
      setResult(next);
      if (next.ok) onRepaired();
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="setup-remedy-actions">
      <div className="setup-run-controls">
        <Tooltip label={note}>
          <button
            type="button"
            className="btn btn-primary"
            disabled={starting}
            onClick={() => void start()}
          >
            {starting ? "Starting..." : label}
          </button>
        </Tooltip>
      </div>
      {result && (
        <RemedyNotice
          tone={result.ok ? "attention" : "error"}
          detail={result.detail || result.error || `${label} did not finish.`}
          hint={result.ok ? undefined : "Start it yourself in a terminal, then press Re-check."}
        />
      )}
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

function Remedy({ row, onRepaired }: { row: SetupRowView; onRepaired(): void }): React.JSX.Element {
  const remedy = row.remedy;
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

/** Separate from warning rows: installing for the first time is an explicit opt-in. */
function PiExtensionInstall({ available, warning, onInstalled }: { available: boolean; warning: boolean; onInstalled(): void }): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
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
    <article className="setup-row" aria-label="Install Pi integration">
      <div className="setup-row-main">
        <div className="setup-row-title"><strong>Pi integration</strong></div>
        <p className="setup-impact">Connect new Pi sessions to Mission Control tools and lifecycle reporting.</p>
        {available && (
          <Tooltip label="Install the Mission Control extension for new Pi sessions on this machine">
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void install()}>
              {busy ? "Installing..." : "Install Pi integration"}
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

function SetupRow({
  row,
  home,
  onRepaired,
}: {
  row: SetupRowView;
  home: string;
  onRepaired(): void;
}): React.JSX.Element {
  const status = row.status;
  const satisfied = status.state === "satisfied";
  return (
    <article className={`setup-row setup-row-${status.state}`} data-anchor={setupRowAnchor(row.rowId)}>
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
            <span className={`setup-status setup-status-${status.state}`}>{STATUS_LABEL[status.state]}</span>
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
            <Remedy row={row} onRepaired={onRepaired} />
          </>
        )}
      </div>
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
function defaultFamily(rows: readonly SetupRowView[]): SetupFamilyId {
  const byFamily = SETUP_FAMILY_IDS.map((family) => ({
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
export function familyForAnchor(anchor: string, rows: readonly SetupRowView[]): SetupFamilyId | null {
  const named = SETUP_FAMILY_IDS.find((family) => anchor === `setup/family-${family}`);
  if (named) return named;
  return rows.find((row) => setupRowAnchor(row.rowId) === anchor)?.family ?? null;
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
  // Nothing to decide from. The request is deliberately left unconsumed: the panel starts
  // fetching as it mounts, so a link from the command palette or Foreman routinely arrives
  // before the rows that would resolve it.
  if (input.rows.length === 0) return null;

  const unseen = input.jumpRequestId !== current.seenRequest;
  // A fresh deep link outranks the default and the operator's last click alike.
  if (unseen && input.jumpFamily) {
    return { chosen: input.jumpFamily, seenRequest: input.jumpRequestId };
  }

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
  jumpAnchor = null,
  jumpRequestId = null,
}: {
  state: SetupChecksState;
  /** A deep link asking for one row or one family. See `familyForAnchor`. */
  jumpAnchor?: string | null;
  jumpRequestId?: number | null;
}): React.JSX.Element {
  // The family rail and the rows it selects, as one spotlight: the tour hands the whole
  // dependency list over rather than reading a family, because which family is worth opening
  // depends on what this machine turns out to be missing.
  const dependenciesTourRef = useTourTargetRef<HTMLDivElement>("setup:dependencies");
  const recheckTourRef = useTourTargetRef<HTMLButtonElement>("setup:recheck");

  // `NO_ROWS` rather than a fresh `[]`: this array is an effect dependency and a memo input,
  // and a new identity every render makes both of them run every render.
  const rows = state.view?.rows ?? NO_ROWS;
  const home = state.view?.home ?? "";

  // A remedy that settles in the daemon re-reads the machine itself, so the row it repaired
  // reports the new truth rather than waiting for the operator to press Re-check on a
  // question they have already answered.
  const refresh = state.refresh;
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
    () => (jumpAnchor ? familyForAnchor(jumpAnchor, rows) : null),
    [jumpAnchor, rows],
  );

  // Applied during render rather than only in the effect below, and both are needed.
  //
  // Render is what makes the FIRST paint already show the requested family: settling this in
  // an effect alone renders the default family once and then swaps, which is a visible flash
  // on every deep link and renders the wrong family entirely where effects do not run.
  // The effect is what makes it STICK: the page clears the jump as soon as it has flashed the
  // control, so a family held only by the live prop would snap back the moment it went away.
  const unseenJump = jumpRequestId !== seenRequest ? jumpFamily : null;
  const active = unseenJump ?? chosen ?? (rows.length > 0 ? defaultFamily(rows) : SETUP_FAMILY_IDS[0]);

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

  return (
    <section className="settings-section setup-panel">
      {/* No standing intro paragraph. It spent the top of the panel restating the question
          ("see what Mission Control can use on this machine") that the verdict now answers
          outright, and its read-only promise is the verdict's own note. */}
      <VerdictHeader
        rows={rows}
        loading={state.loading}
        onRefresh={() => void state.refresh()}
        recheckRef={recheckTourRef}
      />
      {state.error && <p className="settings-error">{state.error}</p>}
      <div className="setup-split" ref={dependenciesTourRef}>
        <nav className="setup-rail" aria-label="Setup families">
          {SETUP_FAMILY_IDS.map((family) => {
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
          {active === "extensions" && (
            <PiExtensionInstall
              available={state.view?.piExtensionInstallAvailable ?? false}
              warning={rows.some(row => row.rowId.source === "environment-check" && row.rowId.id === "pi-extension")}
              onInstalled={onRepaired}
            />
          )}
          {activeRows.length > 0
            ? (
                <div className="setup-rows">
                  {activeRows.map((row) => (
                    <SetupRow
                      key={setupRowAnchor(row.rowId)}
                      row={row}
                      home={home}
                      onRepaired={onRepaired}
                    />
                  ))}
                </div>
              )
            : <p className="setup-loading">{state.error ? "No result" : "Checking this machine..."}</p>}
        </div>
      </div>
    </section>
  );
}
