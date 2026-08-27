import { useEffect, useRef, useState } from "react";
import {
  PIPELINE_INSTALLER_CHANGE_INFO,
  PIPELINE_LAUNCH_RUNTIMES,
  PIPELINE_PROVIDER_INFO,
  activePipelineRepos,
  pipelineRepoKey,
  type PipelineInstallerCandidate,
  type PipelineProbe,
  type PipelineLaunchRuntime,
  type PipelineProviderId,
  type PipelineRepoStatus,
  type PipelinesConfig,
} from "@shared/pipeline.ts";
import type { TerminalBackendId } from "@shared/terminal.ts";
import type { ConductorState } from "../useConductor.ts";
import { COPY_FEEDBACK_LABEL, useCopyFeedback } from "../lib/clipboard.ts";
import { relativeTime, shortenCwd } from "../lib/format.ts";
import { useTerminalTargets } from "../lib/terminalTargets.ts";
import {
  ConsoleCard,
  ConsolePager,
  ConsoleState,
  ConsoleStrip,
  ConsoleSwitch,
  consolePage,
} from "./settings-console.tsx";
import { Tooltip } from "./Tooltip.tsx";

// Conductor's permanent commissioning destination. Registration changes the provider through its
// CLI; observation changes Mission Control consent. Keeping both facts visible is what lets a
// partial success remain recoverable without repeating provider work.

const LAUNCH_RUNTIME_COPY: Record<
  PipelineLaunchRuntime,
  { label: string; detail: string }
> = {
  "agent-sdk": {
    label: "Managed Agent SDK",
    detail: "Starts the Claude or Codex Engineer host selected on each Pipeline task.",
  },
  terminal: {
    label: "Terminal",
    detail: "Opens conduct-ts engineer --idea in a terminal home with live stdin.",
  },
};

/** The last path segment, which is what an operator recognises a checkout by. */
function repoLabel(repoRoot: string): string {
  const parts = repoRoot.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? repoRoot;
}

export type RepoObservation = "on" | "repo-off" | "master-off";

export function repoHealthLine(
  status: PipelineRepoStatus | undefined,
  observation: RepoObservation,
): string {
  if (observation === "master-off")
    return "Not observed - Observe pipelines is off, so no repository is read.";
  if (observation === "repo-off")
    return "Not observed - switch this repository on to project its pipelines.";
  if (!status || status.lastReadAt === null) return "Enabled - not read yet.";
  const daemon =
    status.daemon === "running"
      ? "engine daemon running"
      : status.daemon === "paused"
        ? "engine daemon paused"
        : status.daemon === "stopped"
          ? "no engine daemon running here"
          : "engine daemon state unknown";
  const runs = `${status.runs} ${status.runs === 1 ? "pipeline" : "pipelines"}`;
  const halted = status.halted > 0 ? `, ${status.halted} halted` : "";
  const ingest =
    status.ingest === "live"
      ? " · live events"
      : status.ingest === "quiet"
        ? " · file tail (plugin quiet)"
        : " · file tail";
  return `${daemon} · ${runs}${halted}${ingest}`;
}

export function detectionReading(probe: PipelineProbe | undefined): {
  tone: "ok" | "off" | "unknown";
  text: string;
} {
  if (!probe) return { tone: "unknown", text: "Looking for the engine…" };
  if (!probe.found) {
    return { tone: "off", text: `Setup needed - ${probe.bin} is not on this daemon's PATH.` };
  }
  const version = probe.version === null ? "version unknown" : `version ${probe.version}`;
  return {
    tone: "ok",
    text: `Installed at ${probe.binPath} · ${version} · ${probe.projects.length} ${
      probe.projects.length === 1 ? "repository" : "repositories"
    } registered.`,
  };
}

/** One row in the workspace/provider/config union. */
export interface ConductorRepoCandidate {
  provider: PipelineProviderId;
  repoRoot: string;
  enabled: boolean;
  registered: boolean;
  workspace: boolean;
  name: string;
}

/**
 * Merge repository facts in authority order: workspace, provider registry, stored consent.
 * Config only owns the observation choice; it cannot make a repository registered by itself.
 */
export function offeredRepos(
  workspaceRepos: readonly string[],
  config: PipelinesConfig | null,
  probes: readonly PipelineProbe[],
): ConductorRepoCandidate[] {
  const byKey = new Map<string, ConductorRepoCandidate>();
  for (const repoRoot of workspaceRepos) {
    const provider = "ai-conductor" as const;
    byKey.set(pipelineRepoKey(provider, repoRoot), {
      provider,
      repoRoot,
      enabled: false,
      registered: false,
      workspace: true,
      name: repoLabel(repoRoot),
    });
  }
  for (const probe of probes) {
    for (const project of probe.projects) {
      const key = pipelineRepoKey(probe.provider, project.path);
      const held = byKey.get(key);
      byKey.set(key, {
        provider: probe.provider,
        repoRoot: project.path,
        enabled: held?.enabled ?? false,
        registered: true,
        workspace: held?.workspace ?? false,
        name: project.name || held?.name || repoLabel(project.path),
      });
    }
  }
  for (const repo of config?.repos ?? []) {
    const key = pipelineRepoKey(repo.provider, repo.repoRoot);
    const held = byKey.get(key);
    byKey.set(key, {
      provider: repo.provider,
      repoRoot: repo.repoRoot,
      enabled: repo.enabled,
      registered: held?.registered ?? false,
      workspace: held?.workspace ?? false,
      name: held?.name ?? repoLabel(repo.repoRoot),
    });
  }
  return [...byKey.values()].sort((a, b) => a.repoRoot.localeCompare(b.repoRoot));
}

const CLONE_COMMAND = "git clone https://github.com/mancej/ai-conductor.git";
const INSTALL_COMMAND = "cd ai-conductor && ./bin/install";

function ConductorManualInstall(): React.JSX.Element {
  const cloneCopy = useCopyFeedback();
  const installCopy = useCopyFeedback();
  return (
    <div className="conductor-manual-install">
      <p className="settings-hint">
        Mission Control will not download or run source for you. Clone the recognized upstream,
        review it locally, activate Node.js 26 or newer, then start its interactive installer
        yourself:
      </p>
      <div className="conductor-command-row">
        <code>{CLONE_COMMAND}</code>
        <Tooltip label={cloneCopy.copied ? COPY_FEEDBACK_LABEL : "Copy clone command"}>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => void cloneCopy.copy(CLONE_COMMAND)}
          >
            {cloneCopy.copied ? COPY_FEEDBACK_LABEL : "Copy clone"}
          </button>
        </Tooltip>
      </div>
      {cloneCopy.error && <p className="settings-error">{cloneCopy.error}</p>}
      <div className="conductor-command-row">
        <code>{INSTALL_COMMAND}</code>
        <Tooltip label={installCopy.copied ? COPY_FEEDBACK_LABEL : "Copy install command"}>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => void installCopy.copy(INSTALL_COMMAND)}
          >
            {installCopy.copied ? COPY_FEEDBACK_LABEL : "Copy install"}
          </button>
        </Tooltip>
      </div>
      {installCopy.error && <p className="settings-error">{installCopy.error}</p>}
    </div>
  );
}

function ConductorInstallerSetup({ state }: { state: ConductorState }): React.JSX.Element {
  const terminals = useTerminalTargets();
  const [selectedCheckout, setSelectedCheckout] = useState<string | null>(null);
  const [terminalId, setTerminalId] = useState<TerminalBackendId | null>(null);
  const candidates = state.installers?.candidates ?? [];
  const runtime = state.installers?.runtime ?? null;
  const runtimeReady = runtime?.supported === true;
  const selected = candidates.find((candidate) => candidate.checkout === selectedCheckout) ?? null;
  const available = terminals.targets?.filter((target) => target.unavailable === null) ?? [];
  const terminal = available.find((target) => target.id === terminalId) ?? available[0] ?? null;

  useEffect(() => {
    if (terminal && terminal.id !== terminalId) setTerminalId(terminal.id);
  }, [terminal, terminalId]);
  useEffect(() => {
    if (selectedCheckout && !candidates.some((candidate) => candidate.checkout === selectedCheckout)) {
      setSelectedCheckout(null);
    }
  }, [candidates, selectedCheckout]);

  const command = (candidate: PipelineInstallerCandidate): string =>
    `${candidate.checkout}/bin/install`;
  const noTerminal = terminals.targets !== null && available.length === 0;
  const sourcePending = state.installersLoading || (!state.installers && !state.installerError);

  return (
    <div className="conductor-installer-setup">
      <p className="settings-hint conductor-machine-scope">
        <strong>Install Conductor once on this machine.</strong> Repositories are registered
        separately after the engine resolves.
      </p>
      {sourcePending && <ConsoleState tone="unknown">Checking workspace repositories for verified source…</ConsoleState>}
      {state.installerError && <p className="settings-warn">{state.installerError}</p>}
      {state.installers && !state.installers.supported && (
        <p className="settings-warn">{state.installers.detail}</p>
      )}
      {state.installers?.supported && candidates.length === 0 && (
        <p className="settings-hint">{state.installers.detail}</p>
      )}
      {runtime?.supported && (
        <ConsoleState tone="ok">Installer runtime ready - {runtime.detail}</ConsoleState>
      )}
      {runtime && !runtime.supported && (
        <p className="settings-warn" role="alert">
          <strong>Unsupported installer runtime.</strong> {runtime.detail}
        </p>
      )}

      {candidates.length > 0 && (
        <ul className="conductor-installer-candidates" aria-label="Verified Conductor installer checkouts">
          {candidates.map((candidate) => (
            <li key={candidate.checkout}>
              <span>
                <strong>Verified upstream main checkout</strong>
                <code>{candidate.checkout}</code>
                <small>
                  {candidate.remote} · {candidate.version ? `version ${candidate.version}` : "version unknown"}
                </small>
              </span>
              <Tooltip
                label={
                  runtimeReady
                    ? "Review this verified checkout and the changes its installer may offer"
                    : "Activate a supported Node.js runtime before reviewing this installer"
                }
              >
                <button
                  type="button"
                  className="btn"
                  disabled={!runtimeReady || state.openingInstaller !== null}
                  onClick={() => setSelectedCheckout(candidate.checkout)}
                >
                  Review installer
                </button>
              </Tooltip>
            </li>
          ))}
        </ul>
      )}

      {selected && (
        <section className="conductor-installer-confirm" aria-label="Confirm Conductor installer">
          <header>
            <span aria-hidden>⇶</span>
            <span>
              <strong>Confirm machine-wide installation</strong>
              <small>The upstream installer remains interactive in the terminal you choose.</small>
            </span>
          </header>
          <dl>
            <div><dt>Checkout</dt><dd><code>{selected.checkout}</code></dd></div>
            <div><dt>Command</dt><dd><code>{command(selected)}</code></dd></div>
            <div><dt>Remote</dt><dd>{selected.remote}</dd></div>
            <div>
              <dt>Runtime</dt>
              <dd>{runtime?.label} {runtime?.current} (requires {runtime?.requirement})</dd>
            </div>
          </dl>
          <p className="settings-hint">Depending on your answers, the installer may:</p>
          <ul className="conductor-installer-changes">
            {selected.changes.map((change) => (
              <li key={change}>{PIPELINE_INSTALLER_CHANGE_INFO[change]}</li>
            ))}
          </ul>
          <label className="conductor-terminal-choice">
            <span>Visible hosted terminal</span>
            <Tooltip label="Choose which visible hosted terminal will open the interactive installer">
              <select
                aria-label="Installer terminal backend"
                value={terminal?.id ?? ""}
                disabled={
                  !runtimeReady ||
                  !terminals.targets ||
                  available.length === 0 ||
                  state.openingInstaller !== null
                }
                onChange={(event) => setTerminalId(event.target.value as TerminalBackendId)}
              >
                {!terminals.targets && <option value="">Checking terminals…</option>}
                {terminals.targets?.map((target) => (
                  <option key={target.id} value={target.id} disabled={target.unavailable !== null}>
                    {target.label}{target.unavailable ? `: ${target.unavailable}` : ""}
                  </option>
                ))}
              </select>
            </Tooltip>
          </label>
          {terminals.failed && (
            <p className="settings-warn">Mission Control could not check terminal availability.</p>
          )}
          {noTerminal && (
            <ul className="conductor-terminal-reasons" aria-label="Unavailable terminal reasons">
              {terminals.targets?.map((target) => (
                <li key={target.id}><strong>{target.label}</strong>: {target.unavailable}</li>
              ))}
            </ul>
          )}
          <div className="conductor-confirm-actions">
            <Tooltip label="Open the reverified upstream installer in the selected terminal">
              <button
                type="button"
                className="btn btn-primary"
                disabled={!runtimeReady || !terminal || state.openingInstaller !== null}
                onClick={() => void state.openInstaller(selected.provider, selected.checkout, terminal!.id)}
              >
                {state.openingInstaller === selected.checkout ? "Opening…" : "Open installer"}
              </button>
            </Tooltip>
            <Tooltip label="Close this confirmation without opening the installer">
              <button
                type="button"
                className="btn btn-ghost"
                disabled={state.openingInstaller !== null}
                onClick={() => setSelectedCheckout(null)}
              >
                Cancel
              </button>
            </Tooltip>
          </div>
        </section>
      )}

      {((state.installers && candidates.length === 0) ||
        state.installerError ||
        terminals.failed ||
        noTerminal) && (
        <ConductorManualInstall />
      )}
    </div>
  );
}

/** The four buckets the directory's tiles name. `all` is the whole union, unfiltered. */
export type ConductorTile = "managed" | "all" | "ready" | "failing";

/** Tile order, which is also the order a repository's "home" tile is looked for in. */
export const CONDUCTOR_TILES: readonly ConductorTile[] = ["managed", "all", "ready", "failing"];

export const CONDUCTOR_TILE_LABEL: Record<ConductorTile, string> = {
  managed: "Managed",
  all: "All",
  ready: "Ready",
  failing: "Failing",
};

/**
 * The union, partitioned once - the tiles' counts and the rows they select are the same fold.
 *
 * One function for the reason `healthCounts` is one in the task sources panel: a strip
 * saying "Ready 1" over a list of none is the kind of disagreement nobody reports and
 * everybody distrusts. A tile counts the whole union it names, never the rows a query has
 * left on screen, so the number does not move while an operator types.
 */
export function conductorBuckets(
  repos: readonly ConductorRepoCandidate[],
  config: PipelinesConfig | null,
  statusByRepo: ReadonlyMap<string, PipelineRepoStatus>,
): Record<ConductorTile, ConductorRepoCandidate[]> {
  const buckets: Record<ConductorTile, ConductorRepoCandidate[]> = {
    managed: [],
    all: [],
    ready: [],
    failing: [],
  };
  for (const repo of repos) {
    const status = statusByRepo.get(pipelineRepoKey(repo.provider, repo.repoRoot));
    buckets.all.push(repo);
    // Managed is "Conductor knows about it OR this machine consented to it" - the same
    // union the de-registered row survives in, so withdrawing consent stays reachable.
    if (repo.registered || repo.enabled) buckets.managed.push(repo);
    if (Boolean(config?.enabled) && repo.enabled) buckets.ready.push(repo);
    if (status?.error) buckets.failing.push(repo);
  }
  return buckets;
}

/** Lowercased substring over the two fields an operator recognises a checkout by. */
export function conductorRepoMatches(repo: ConductorRepoCandidate, needle: string): boolean {
  if (!needle) return true;
  return `${repo.name} ${repo.repoRoot}`.toLocaleLowerCase().includes(needle);
}

/** What a directory row's dot says, in one word an operator can act on. */
export function conductorRowState(
  repo: ConductorRepoCandidate,
  config: PipelinesConfig | null,
  status: PipelineRepoStatus | undefined,
): { tone: "failing" | "ready" | "registered" | "unmanaged"; label: string } {
  if (status?.error) return { tone: "failing", label: "Failing" };
  if (config?.enabled && repo.enabled) return { tone: "ready", label: "Ready" };
  if (repo.registered) return { tone: "registered", label: "Registered" };
  if (repo.enabled) return { tone: "registered", label: "Consented" };
  return { tone: "unmanaged", label: "Unmanaged" };
}

/**
 * Where a checkout lives, short enough for a 300px row.
 *
 * The row's name is the checkout's leaf, so printing the whole absolute path beside it
 * spends the row on a prefix every repository in a workspace shares. The parent is what
 * actually tells two same-named checkouts apart, and the full path is a hover and the
 * first line of the detail pane away.
 */
export function repoParentLabel(repoRoot: string): string {
  const parent = repoRoot.replace(/\/+$/, "").split("/").slice(0, -1).join("/");
  return shortenCwd(parent) || "/";
}

/** How this repository's pipeline state is reaching Mission Control, as a short noun. */
export function conductorIngestReading(status: PipelineRepoStatus | undefined): string {
  if (!status || status.lastReadAt === null) return "Not read yet";
  if (status.ingest === "live") return "Live events";
  if (status.ingest === "quiet") return "File tail (the plugin has gone quiet)";
  return "File tail";
}

/** One fact in the detail pane: a label, and the reading beside it. */
function DetailFact({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <p className="sc-health-row conductor-fact">
      <span>{label}</span>
      <span className="sc-health-value">{children}</span>
    </p>
  );
}

export function ConductorPanel({
  state,
  onOpenPipelines,
}: {
  state: ConductorState;
  /**
   * Leave settings for the Pipelines tab. Optional, so a render test can mount this panel
   * with no router - and separate from `SettingsNavigate`, which is typed to settings
   * categories and cannot express a destination outside them.
   *
   * Tab-level rather than repository-scoped on purpose: the route grammar has only
   * `#/runs/pipeline` and `#/runs/pipeline/:repoKey/:slug`, so there is no address for
   * "this repository's pipelines" to link to, and a button promising one would be a lie.
   */
  onOpenPipelines?: () => void;
}): React.JSX.Element {
  const {
    view,
    workspaceRepos,
    save,
    registerAndObserve,
    enableObservation,
    recheck,
    checking,
    setup,
    setupNotice,
    openingInstaller,
    installerNotice,
    error,
  } = state;
  const [query, setQuery] = useState("");
  const [tile, setTile] = useState<ConductorTile>("managed");
  const [page, setPage] = useState(1);
  const [picked, setPicked] = useState<string | null>(null);
  const directoryRef = useRef<HTMLDivElement>(null);
  const config = view?.config ?? null;
  const probes = view?.probes ?? [];
  const probe = probes.find((candidate) => candidate.provider === "ai-conductor");
  const engineFound = probe?.found === true;
  const statusByRepo = new Map(
    (view?.status ?? []).map((status) => [pipelineRepoKey(status.provider, status.repoRoot), status]),
  );
  const repos = offeredRepos(workspaceRepos, config, probes);
  const buckets = conductorBuckets(repos, config, statusByRepo);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visible = buckets[tile].filter((repo) => conductorRepoMatches(repo, normalizedQuery));

  // Changing the tile or the query starts a NEW list, so it starts at its first page.
  // Reconciled during render (React's documented "adjust state when a prop changes"
  // pattern) rather than in an effect, which would paint page 4 of a one-page filter for a
  // frame first. `ConsoleTable` does the same thing for the same reason.
  const listKey = `${tile} ${normalizedQuery}`;
  const [pagedKey, setPagedKey] = useState(listKey);
  if (pagedKey !== listKey) {
    setPagedKey(listKey);
    setPage(1);
  }
  const pageView = consolePage(visible, page);

  // Selection is DERIVED rather than an effect's output, and keyed by `pipelineRepoKey`.
  //
  // An explicit pick wins while the repository is still in the union - so turning the page,
  // changing the tile, typing a query and a four-second poll all leave the pane alone. When
  // there is no live pick, the first row of the CURRENT FILTERED SET stands in, so
  // master-detail always has a detail without ever selecting something that is not on
  // screen. Both halves are computed here rather than in an effect, which means a static
  // render (and a first paint) shows the same pane a settled one does.
  const unionKeys = new Set(repos.map((repo) => pipelineRepoKey(repo.provider, repo.repoRoot)));
  const selectedKey =
    picked && unionKeys.has(picked)
      ? picked
      : visible[0]
        ? pipelineRepoKey(visible[0].provider, visible[0].repoRoot)
        : null;
  const selected =
    repos.find((repo) => pipelineRepoKey(repo.provider, repo.repoRoot) === selectedKey) ?? null;

  // The picked repository LEFT THE UNION - that is, a poll stopped returning it from ALL
  // THREE of the workspace catalog, the engine's projects and stored consent, so there is
  // no row for it under any filter. Withdrawing consent on its own does not do this while
  // the workspace scan still finds the checkout, which is the point: the row stays, and so
  // does the pane. Forget the pick and hand focus back to the list rather than leaving it
  // on a button that no longer exists. Leaving the FILTER is a different thing entirely,
  // and deliberately does none of this.
  const inUnion = picked === null || unionKeys.has(picked);
  useEffect(() => {
    if (picked !== null && !inUnion) {
      setPicked(null);
      directoryRef.current?.focus();
    }
  }, [picked, inUnion]);

  const active = config ? activePipelineRepos(config).length : 0;
  const registered = repos.filter((repo) => repo.registered).length;
  const info = PIPELINE_PROVIDER_INFO["ai-conductor"];
  const detection = detectionReading(probe);
  const setupBusy = setup !== null || openingInstaller !== null;

  const setRepoEnabled = (repo: ConductorRepoCandidate, enabled: boolean): void => {
    if (!config || (!repo.registered && enabled)) return;
    const key = pipelineRepoKey(repo.provider, repo.repoRoot);
    const kept = config.repos.filter((held) => pipelineRepoKey(held.provider, held.repoRoot) !== key);
    void save({ ...config, repos: [...kept, { provider: repo.provider, repoRoot: repo.repoRoot, enabled }] });
  };

  // The selected repository is in the union but not in the list beside it, which is an
  // ORDINARY flow here rather than a corner: the default tile is Managed, so "open All,
  // pick something, go back" reaches it in three clicks. Silently discarding the selection
  // and silently showing a repository with no row are both worse than saying so and
  // offering the tile that holds it.
  const offFilter =
    selected !== null &&
    !visible.some((repo) => pipelineRepoKey(repo.provider, repo.repoRoot) === selectedKey);
  const selectedHome = selected
    ? CONDUCTOR_TILES.find((candidate) =>
        buckets[candidate].some((repo) => pipelineRepoKey(repo.provider, repo.repoRoot) === selectedKey),
      ) ?? "all"
    : "all";
  const queryHidesSelected = selected !== null && !conductorRepoMatches(selected, normalizedQuery);
  const showSelectedRow = (): void => {
    setTile(selectedHome);
    if (queryHidesSelected) setQuery("");
  };

  // How many the same query would find under All - the answer the conjunction of tile and
  // query owes an operator whose search matched only unmanaged repositories.
  const widerMatches = buckets.all.filter((repo) => conductorRepoMatches(repo, normalizedQuery)).length;

  const selectedStatus = selected
    ? statusByRepo.get(pipelineRepoKey(selected.provider, selected.repoRoot))
    : undefined;
  const selectedObserved = Boolean(config?.enabled && selected?.enabled);
  const selectedObservation: RepoObservation = !config?.enabled
    ? "master-off"
    : selected?.enabled
      ? "on"
      : "repo-off";
  const selectedBusy = selected !== null && setup?.repoRoot === selected.repoRoot;
  const canToggleSelected = Boolean(
    config && selected && (selected.registered || selected.enabled) && !setupBusy,
  );

  return (
    <section className="settings-section sc-section conductor-panel" data-anchor="conductor/pipelines">
      <p className="settings-hint sc-lede">
        <strong>{info.label}</strong> {info.blurb} Mission Control registers a repository through
        Conductor's own CLI, then separately asks to observe that exact repository. It never edits
        Conductor's registry or pipeline files itself.
      </p>

      <ol className="conductor-commissioning" aria-label="Conductor commissioning progress">
        <li className={engineFound ? "is-complete" : "is-current"}>
          <span aria-hidden>01</span>
          <strong>Engine</strong>
          <small>{engineFound ? "Installed" : "Setup needed"}</small>
        </li>
        <li className={registered > 0 ? "is-complete" : engineFound ? "is-current" : ""}>
          <span aria-hidden>02</span>
          <strong>Register repo</strong>
          <small>{registered > 0 ? `${registered} registered` : "Choose a workspace"}</small>
        </li>
        <li className={active > 0 ? "is-complete" : registered > 0 ? "is-current" : ""}>
          <span aria-hidden>03</span>
          <strong>Observe</strong>
          <small>{active > 0 ? `${active} ready` : "Consent separately"}</small>
        </li>
      </ol>

      {!view && (
        <p className="settings-warn conductor-unknown">
          Can't reach the daemon, so Conductor's actual setup is unknown. These are defaults, not
          its current state.
        </p>
      )}
      {error && <p className="settings-error">{error}</p>}
      {setupNotice && (
        <div className={`conductor-setup-notice is-${setupNotice.tone}`} role="status">
          <strong>{setupNotice.detail}</strong>
          {setupNotice.output && <span>{setupNotice.output}</span>}
        </div>
      )}
      {installerNotice && (
        <div className={`conductor-setup-notice is-${installerNotice.tone}`} role="status">
          <strong>{installerNotice.detail}</strong>
        </div>
      )}

      {/* The directory beside the repository it is showing. The workspace scan is unbounded
          - 202 checkouts on the machine this was written against, of which one was
          registered - so the directory opens on what Conductor MANAGES and pages every
          tile, including All. A bounded scroller alone would have stopped the page growing
          while the DOM still held a row per checkout, which is the defect itself. */}
      <div className="conductor-master-detail">
        <div className="conductor-list-col" data-anchor="conductor/repos">
          <div className="conductor-list-head">
            <h3>Repositories</h3>
          </div>
          <p className="settings-hint">
            Registration and observation are separate; Pipeline dispatch appears only after
            observation succeeds.
          </p>
          <input
            className="field-input conductor-repo-search"
            type="search"
            placeholder="Search workspace repositories"
            aria-label="Search workspace repositories"
            value={query}
            disabled={!view}
            onChange={(event) => setQuery(event.target.value)}
          />
          {/* Only once the daemon has answered. Four tiles reading zero before the first
              read are not a tally, they are defaults drawn as fact - the same claim this
              panel refuses to make with its switches. */}
          {view && (
            <ConsoleStrip
              stats={[
                {
                  id: "managed",
                  count: buckets.managed.length,
                  label: "Managed",
                  tone: "ok",
                  hint: "Show only repositories Conductor has registered, or this machine has consented to",
                },
                {
                  id: "all",
                  count: buckets.all.length,
                  label: "All",
                  hint: "Show every repository in the workspace catalog, registered or not",
                },
                {
                  id: "ready",
                  count: buckets.ready.length,
                  label: "Ready",
                  tone: "ok",
                  hint: "Show only repositories that are being read right now",
                },
                {
                  id: "failing",
                  count: buckets.failing.length,
                  label: "Failing",
                  tone: "attention",
                  hint: "Show only repositories whose last read reported an error",
                },
              ]}
              active={tile}
              // A tile is always active, so clicking the active one clears back to the whole
              // catalog rather than to no filter at all - the strip's own "there is no state
              // it cannot leave", said in this panel's vocabulary.
              onPick={(id) => setTile((id as ConductorTile | null) ?? "all")}
            />
          )}

          {repos.length === 0 ? (
            <p className="settings-hint conductor-empty">
              {view
                ? "No workspace repositories are available yet. Open or dispatch from a repository, then check again."
                : "The repository list is unknown until the daemon answers."}
            </p>
          ) : (
            <>
              {/* The empty state is a SIBLING of the list, never a child of it: a
                  `role="list"` whose child is a paragraph is a list with a non-item in it,
                  and the guidance here is not one of the things being listed. */}
              {visible.length === 0 ? (
                <div className="conductor-directory conductor-directory-empty">
                  {normalizedQuery && tile !== "all" && widerMatches > 0 ? (
                    <>
                      <p>
                        No {CONDUCTOR_TILE_LABEL[tile]} repository matches that search, but{" "}
                        {widerMatches} {widerMatches === 1 ? "repository does" : "repositories do"}{" "}
                        under All.
                      </p>
                      <Tooltip label="Widen the filter to every workspace repository, keeping this search">
                        <button type="button" className="btn" onClick={() => setTile("all")}>
                          Show {widerMatches} under All
                        </button>
                      </Tooltip>
                    </>
                  ) : normalizedQuery ? (
                    <p>No repositories match that search.</p>
                  ) : tile === "managed" ? (
                    <p>
                      Conductor manages nothing here yet. Pick <strong>All</strong> above to find a
                      repository to register.
                    </p>
                  ) : (
                    <p>No repositories are {CONDUCTOR_TILE_LABEL[tile].toLocaleLowerCase()}.</p>
                  )}
                </div>
              ) : (
                <div
                  className="conductor-directory"
                  ref={directoryRef}
                  role="list"
                  aria-label="Conductor repositories"
                  tabIndex={-1}
                >
                  {pageView.rows.map((repo) => {
                    const key = pipelineRepoKey(repo.provider, repo.repoRoot);
                    const row = conductorRowState(repo, config, statusByRepo.get(key));
                    return (
                      <div className="conductor-directory-item" role="listitem" key={key}>
                        <Tooltip
                          label={`Open ${repo.name} - ${row.label.toLocaleLowerCase()} - ${repo.repoRoot}`}
                        >
                          <button
                            type="button"
                            className={`conductor-row${selectedKey === key ? " is-active" : ""}`}
                            // The pane beside this list shows what the row names, so the
                            // row is "current" rather than "selected": one of a set of
                            // destinations, the way a nav item is, not a checkbox.
                            aria-current={selectedKey === key}
                            onClick={() => setPicked(key)}
                          >
                            <span className="conductor-row-main">
                              <strong>{repo.name}</strong>
                              <span>{repoParentLabel(repo.repoRoot)}</span>
                            </span>
                            <span className={`conductor-mark conductor-mark-${row.tone}`}>
                              <i />
                              {row.label}
                            </span>
                          </button>
                        </Tooltip>
                      </div>
                    );
                  })}
                </div>
              )}
              <ConsolePager
                view={pageView}
                back="Previous"
                forward="Next"
                backHint="Show the previous page of repositories"
                forwardHint="Show the next page of repositories"
                onGo={setPage}
              />
              <p className="settings-hint conductor-count">
                {visible.length === 0
                  ? `None of ${repos.length} workspace ${repos.length === 1 ? "repository" : "repositories"} match.`
                  : `${pageView.from}-${pageView.to} of ${pageView.total} in ${CONDUCTOR_TILE_LABEL[tile]}, of ${repos.length} in the workspace.`}
              </p>
            </>
          )}
        </div>

        {/* A labelled region rather than a bare column: it is the answer to the list
            beside it, it can be reached on its own by a screen reader's landmark walk, and
            the browser suite selects it by that name instead of by a class. */}
        <div className="conductor-detail-col" role="region" aria-label="Selected repository">
          {!selected ? (
            <p className="settings-hint conductor-empty">
              {repos.length === 0
                ? "Nothing to show until a repository is available."
                : "Select a repository on the left to see how it is set up."}
            </p>
          ) : (
            <>
              <div className="conductor-detail-head">
                <h3>{selected.name}</h3>
                <code>{selected.repoRoot}</code>
              </div>

              {offFilter && (
                <p className="settings-hint conductor-off-filter">
                  {selected.name} is not in the {CONDUCTOR_TILE_LABEL[tile]} list beside this pane.{" "}
                  <Tooltip
                    label={`Show ${selected.name} in the ${CONDUCTOR_TILE_LABEL[selectedHome]} list`}
                  >
                    <button type="button" className="btn btn-ghost" onClick={showSelectedRow}>
                      Show it in {CONDUCTOR_TILE_LABEL[selectedHome]}
                    </button>
                  </Tooltip>
                </p>
              )}

              <DetailFact label="Registered with Conductor">
                {selected.registered ? "Yes" : "No"}
              </DetailFact>
              <p className="sc-health-row conductor-fact">
                <span>Observed by Mission Control</span>
                <span className="sc-health-value">
                  <ConsoleSwitch
                    label={`Observe pipelines in ${selected.name}`}
                    tooltip={
                      selected.enabled
                        ? `Observation choice is on for ${selected.repoRoot}. Click to withdraw it.`
                        : selected.registered
                          ? `Observation choice is off for ${selected.repoRoot}.`
                          : `Register ${selected.repoRoot} before enabling observation.`
                    }
                    checked={selected.enabled}
                    disabled={!canToggleSelected}
                    tone="ok"
                    onChange={(next) => setRepoEnabled(selected, next)}
                  />
                </span>
              </p>
              <DetailFact label="Dispatch ready">{selectedObserved ? "Yes" : "No"}</DetailFact>
              <DetailFact label="Events arrive by">
                {conductorIngestReading(selectedStatus)}
              </DetailFact>
              <DetailFact label="Last read">
                {selectedStatus?.lastReadAt ? relativeTime(selectedStatus.lastReadAt) : "Never"}
              </DetailFact>

              <p className="conductor-detail-health">
                {selected.registered
                  ? repoHealthLine(selectedStatus, selectedObservation)
                  : "Conductor does not manage this repository yet."}
              </p>
              {selectedStatus?.error && (
                <p className="settings-error conductor-repo-error">{selectedStatus.error}</p>
              )}

              <div className="conductor-detail-actions">
                {!selected.registered ? (
                  <Tooltip
                    label={`Register ${selected.name} with Conductor, then enable Mission Control observation`}
                  >
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={!engineFound || setupBusy || !config}
                      onClick={() => void registerAndObserve(selected.provider, selected.repoRoot)}
                    >
                      {selectedBusy && setup?.phase === "registering"
                        ? "Registering…"
                        : "Register and observe"}
                    </button>
                  </Tooltip>
                ) : !selectedObserved ? (
                  <Tooltip
                    label={`Enable Mission Control observation for registered repository ${selected.name}`}
                  >
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={setupBusy || !config}
                      onClick={() => void enableObservation(selected.provider, selected.repoRoot)}
                    >
                      {selectedBusy && setup?.phase === "observing"
                        ? "Enabling…"
                        : "Enable observation"}
                    </button>
                  </Tooltip>
                ) : (
                  <span className="conductor-ready-mark">Ready</span>
                )}
                {/* Named for where it actually lands. The Pipelines tab is fleet-wide -
                    there is no repository-scoped pipelines address in the route grammar -
                    so a button saying "Open pipelines" here would promise one. */}
                {onOpenPipelines && selectedObserved && (
                  <Tooltip label="Open the fleet-wide Pipelines tab, which lists every observed repository">
                    <button type="button" className="btn btn-ghost" onClick={onOpenPipelines}>
                      Open Pipelines tab
                      <span aria-hidden> &rarr;</span>
                    </button>
                  </Tooltip>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      <p className="settings-hint conductor-ingest-hint">
        Reading files on a cadence needs nothing installed, and the pane above says so per
        repository. To have the engine push its events instead - the same picture, without the
        wait - copy <code>integrations/ai-conductor/mission-control/</code> from the Mission
        Control checkout into <code>~/.ai-conductor/plugins/mission-control/</code> and give it
        this daemon's URL and token. The engine's files stay the source of truth either way.
      </p>

      <div className="sc-controls">
        <ConsoleCard
          title="The engine"
          anchor="conductor/detection"
          action={
            <Tooltip label="Probe for the engine again now">
              <button
                type="button"
                className="btn"
                disabled={!view || checking || setupBusy}
                onClick={() => void recheck()}
              >
                {checking
                  ? "Checking…"
                  : probe?.found === false
                    ? "I installed it, check again"
                    : "Check again"}
              </button>
            </Tooltip>
          }
        >
          <ConsoleState tone={detection.tone}>{detection.text}</ConsoleState>
          {probe && !probe.found && (
            <ConductorInstallerSetup state={state} />
          )}
          {probes.map((candidate) => (
            <p className="sc-health-row" key={candidate.provider}>
              <span>Registry</span>
              <span className="sc-health-value"><code>{candidate.registryPath}</code></span>
            </p>
          ))}
          {probes
            .filter((candidate) => candidate.found && candidate.error !== null)
            .map((candidate) => (
              <p className="settings-error" key={`${candidate.provider}-error`}>
                {candidate.error}
              </p>
            ))}
        </ConsoleCard>

        <ConsoleCard
          title="Observe pipelines"
          anchor="conductor/enabled"
          action={
            <ConsoleSwitch
              label="Observe conductor pipelines"
              tooltip={
                config?.enabled
                  ? "On - repositories enabled in the directory are read. Click to stop every observation."
                  : "Off - no repository is read. Click to restore enabled repository choices."
              }
              checked={config?.enabled ?? false}
              disabled={!config || setupBusy}
              tone="ok"
              onChange={(next) => {
                if (config) void save({ ...config, enabled: next });
              }}
            />
          }
        >
          <p className="settings-hint">
            This is Mission Control's master consent switch. It is independent of Conductor's
            repository registry and preserves each repository choice when turned off.
          </p>
          <ConsoleState tone={config?.enabled ? (active > 0 ? "ok" : "attention") : "off"}>
            {!config
              ? "Unknown - the daemon has not answered."
              : !config.enabled
                ? "Off - no pipeline state is being read."
                : active > 0
                  ? `On - reading ${active} ${active === 1 ? "repository" : "repositories"}.`
                  : "On, but no repository is switched on, so nothing is being read."}
          </ConsoleState>
        </ConsoleCard>

        <ConsoleCard title="Launch runtime" anchor="conductor/launch-runtime">
          {/* The shared segmented control, not a bespoke radio list: the other three console
              panels ask a two-option question exactly this way, and a panel that draws its
              own says the choice works differently when it does not. Real radios still - the
              segmented look is `appearance: none` over the inputs, so arrow keys walk the
              group and the legend names it. */}
          <fieldset className="sc-field sc-seg">
            <legend className="sc-field-label">Engineer host</legend>
            <div className="sc-seg-row">
              {PIPELINE_LAUNCH_RUNTIMES.map((runtime) => {
                const choice = LAUNCH_RUNTIME_COPY[runtime];
                const on = config?.launchRuntime === runtime;
                return (
                  <Tooltip
                    key={runtime}
                    label={`Use ${choice.label} as the Engineer host. ${choice.detail}`}
                  >
                    <label className={`sc-seg-opt${on ? " is-on" : ""}`}>
                      <input
                        type="radio"
                        name="conductor-launch-runtime"
                        value={runtime}
                        checked={on}
                        disabled={!config || setupBusy}
                        onChange={() => {
                          if (config) void save({ ...config, launchRuntime: runtime });
                        }}
                      />
                      <span>{choice.label}</span>
                    </label>
                  </Tooltip>
                );
              })}
            </div>
            <p className="settings-hint">
              {LAUNCH_RUNTIME_COPY[config?.launchRuntime ?? "agent-sdk"].detail}
            </p>
          </fieldset>
          <p className="settings-hint">
            This controls Engineer's Mission Control host only. Conductor's background build
            daemon keeps its own tmux supervision.
          </p>
          <ConsoleState tone={config ? "ok" : "unknown"}>
            {!config
              ? "Unknown - the daemon has not answered."
              : config.launchRuntime === "agent-sdk"
                ? "Managed Agent SDK - the shipped default, with no Terminal fallback."
                : "Terminal - the explicit Claude-only compatibility host."}
          </ConsoleState>
        </ConsoleCard>

        <ConsoleCard
          title="Foreman triage"
          anchor="conductor/foreman-triage"
          action={
            <ConsoleSwitch
              label="Triage mechanical pipeline halts"
              tooltip="Let Foreman unpark mechanical halts only"
              checked={config?.foremanMechanicalTriage ?? false}
              disabled={!config || setupBusy}
              tone="ok"
              onChange={(next) => {
                if (config) void save({ ...config, foremanMechanicalTriage: next });
              }}
            />
          }
        >
          <p className="settings-hint">
            Off by default. Needs-human, protected-artifact, legacy, unclassified, and unknown
            halts always stay with the operator.
          </p>
          <ConsoleState tone={config?.foremanMechanicalTriage ? "attention" : "off"}>
            {config?.foremanMechanicalTriage
              ? "On - mechanical halts may be unparked automatically."
              : "Off - Foreman does not act on pipeline halts."}
          </ConsoleState>
        </ConsoleCard>
      </div>
    </section>
  );
}
