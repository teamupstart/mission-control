import { useState } from "react";
import {
  PIPELINE_PROVIDER_INFO,
  activePipelineRepos,
  pipelineRepoKey,
  type PipelineProbe,
  type PipelineProviderId,
  type PipelineRepoStatus,
  type PipelinesConfig,
} from "@shared/pipeline.ts";
import type { ConductorState } from "../useConductor.ts";
import { ConsoleCard, ConsoleState, ConsoleSwitch } from "./settings-console.tsx";
import { Tooltip } from "./Tooltip.tsx";

// Conductor's permanent commissioning destination. Registration changes the provider through its
// CLI; observation changes Mission Control consent. Keeping both facts visible is what lets a
// partial success remain recoverable without repeating provider work.

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

export function ConductorPanel({ state }: { state: ConductorState }): React.JSX.Element {
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
    error,
  } = state;
  const [query, setQuery] = useState("");
  const config = view?.config ?? null;
  const probes = view?.probes ?? [];
  const probe = probes.find((candidate) => candidate.provider === "ai-conductor");
  const engineFound = probe?.found === true;
  const statusByRepo = new Map(
    (view?.status ?? []).map((status) => [pipelineRepoKey(status.provider, status.repoRoot), status]),
  );
  const repos = offeredRepos(workspaceRepos, config, probes);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredRepos = normalizedQuery
    ? repos.filter((repo) =>
        `${repo.name} ${repo.repoRoot}`.toLocaleLowerCase().includes(normalizedQuery),
      )
    : repos;
  const active = config ? activePipelineRepos(config).length : 0;
  const registered = repos.filter((repo) => repo.registered).length;
  const info = PIPELINE_PROVIDER_INFO["ai-conductor"];
  const detection = detectionReading(probe);
  const setupBusy = setup !== null;

  const setRepoEnabled = (repo: ConductorRepoCandidate, enabled: boolean): void => {
    if (!config || (!repo.registered && enabled)) return;
    const key = pipelineRepoKey(repo.provider, repo.repoRoot);
    const kept = config.repos.filter((held) => pipelineRepoKey(held.provider, held.repoRoot) !== key);
    void save({ ...config, repos: [...kept, { provider: repo.provider, repoRoot: repo.repoRoot, enabled }] });
  };

  return (
    <section className="settings-section sc-section sc-solo" data-anchor="conductor/pipelines">
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
                {checking ? "Checking…" : "Check again"}
              </button>
            </Tooltip>
          }
        >
          <ConsoleState tone={detection.tone}>{detection.text}</ConsoleState>
          {probe && !probe.found && (
            <div className="conductor-install-copy">
              <p className="settings-hint">
                Install ai-conductor with its documented installer, ensure <code>{probe.bin}</code>{" "}
                is on the Mission Control daemon's PATH, then check again. Mission Control does not
                run the installer from this page.
              </p>
              <code aria-label="Required Conductor command">{probe.bin}</code>
            </div>
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
                  ? "On - repositories enabled below are read. Click to stop every observation."
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

        <ConsoleCard title="Workspace repositories" anchor="conductor/repos">
          <p className="settings-hint">
            Choose a repository already known to Mission Control. Registration and observation are
            shown separately; Pipeline dispatch appears only after observation succeeds.
          </p>
          <label className="conductor-repo-search">
            <span className="sr-only">Search workspace repositories</span>
            <input
              type="search"
              placeholder="Search workspace repositories"
              value={query}
              disabled={!view}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          {repos.length === 0 ? (
            <p className="settings-hint conductor-empty">
              {view
                ? "No workspace repositories are available yet. Open or dispatch from a repository, then check again."
                : "The repository list is unknown until the daemon answers."}
            </p>
          ) : filteredRepos.length === 0 ? (
            <p className="settings-hint conductor-empty">No repositories match that search.</p>
          ) : (
            <ul className="conductor-repos" aria-label="Conductor repositories">
              {filteredRepos.map((repo) => {
                const key = pipelineRepoKey(repo.provider, repo.repoRoot);
                const status = statusByRepo.get(key);
                const observed = Boolean(config?.enabled && repo.enabled);
                const observation: RepoObservation = !config?.enabled
                  ? "master-off"
                  : repo.enabled
                    ? "on"
                    : "repo-off";
                const busy = setup?.repoRoot === repo.repoRoot;
                const canToggle = Boolean(config && (repo.registered || repo.enabled) && !setupBusy);
                return (
                  <li className="conductor-repo" key={key}>
                    <label className="skill-switch">
                      <Tooltip
                        label={
                          repo.enabled
                            ? `Observation choice is on for ${repo.repoRoot}. Click to withdraw it.`
                            : repo.registered
                              ? `Observation choice is off for ${repo.repoRoot}.`
                              : `Register ${repo.repoRoot} before enabling observation.`
                        }
                      >
                        <input
                          type="checkbox"
                          checked={repo.enabled}
                          disabled={!canToggle}
                          aria-label={`Observe pipelines in ${repo.name}`}
                          onChange={(event) => setRepoEnabled(repo, event.target.checked)}
                        />
                      </Tooltip>
                    </label>
                    <div className="conductor-repo-body">
                      <span className="conductor-repo-name">{repo.name}</span>
                      <code className="conductor-repo-path">{repo.repoRoot}</code>
                      <span className="conductor-repo-facts" aria-label={`Setup status for ${repo.name}`}>
                        <span className={repo.registered ? "is-ready" : ""}>
                          {repo.registered ? "Registered" : "Not registered"}
                        </span>
                        <span className={observed ? "is-ready" : ""}>
                          {observed ? "Observed" : "Not observed"}
                        </span>
                        <span className={observed ? "is-ready" : ""}>
                          {observed ? "Dispatch ready" : "Dispatch not ready"}
                        </span>
                      </span>
                      <span className="conductor-repo-health">
                        {repo.registered
                          ? repoHealthLine(status, observation)
                          : "Conductor does not manage this repository yet."}
                      </span>
                      {status?.error && <span className="settings-error conductor-repo-error">{status.error}</span>}
                    </div>
                    <div className="conductor-repo-action">
                      {!repo.registered ? (
                        <Tooltip
                          label={`Register ${repo.name} with Conductor, then enable Mission Control observation`}
                        >
                          <button
                            type="button"
                            className="btn btn-primary"
                            disabled={!engineFound || setupBusy || !config}
                            onClick={() => void registerAndObserve(repo.provider, repo.repoRoot)}
                          >
                            {busy && setup?.phase === "registering"
                              ? "Registering…"
                              : "Register and observe"}
                          </button>
                        </Tooltip>
                      ) : !observed ? (
                        <Tooltip
                          label={`Enable Mission Control observation for registered repository ${repo.name}`}
                        >
                          <button
                            type="button"
                            className="btn btn-primary"
                            disabled={setupBusy || !config}
                            onClick={() => void enableObservation(repo.provider, repo.repoRoot)}
                          >
                            {busy && setup?.phase === "observing"
                              ? "Enabling…"
                              : "Enable observation"}
                          </button>
                        </Tooltip>
                      ) : (
                        <span className="conductor-ready-mark">Ready</span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </ConsoleCard>
      </div>

      <p className="settings-hint conductor-ingest-hint">
        Mission Control reads Conductor's files on a cadence. The optional visualizer plugin can
        push the same events sooner; the files remain the source of truth either way.
      </p>
    </section>
  );
}
