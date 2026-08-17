import {
  PIPELINE_PROVIDER_INFO,
  activePipelineRepos,
  pipelineRepoKey,
  type PipelineProbe,
  type PipelineRepo,
  type PipelineRepoStatus,
  type PipelinesConfig,
} from "@shared/pipeline.ts";
import type { ConductorState } from "../useConductor.ts";
import { ConsoleCard, ConsoleState, ConsoleSwitch } from "./settings-console.tsx";
import { Tooltip } from "./Tooltip.tsx";

// The Conductor category: whether Mission Control may look at an external SDLC engine's
// work, and in which repositories.
//
// The whole panel is one posture, stated three times because three different things can be
// false: the engine may not be installed, the master switch may be off, and a repository
// may not have been consented to. An operator who sees no pipelines has to be able to tell
// which of the three it is, in one look, without opening anything - so detection, the
// master switch and the per-repository list each carry their own sentence rather than
// sharing a single "not configured".
//
// Nothing here can start, stop, pause or advance anything. That is worth saying in the
// panel itself (the lede does), because the word "conductor" reads like a control surface
// and this one is a window: the engine's own CLI is the only thing that changes its state,
// and Mission Control never writes a file the engine owns.
//
// This panel is ABOUT ai-conductor, and names it, while everything under it is generic. That
// is deliberate rather than an unfinished generalisation: the rail row an operator reads says
// "Conductor" because that is the software they installed, and a second provider would want
// its own row saying its own name rather than a shared page listing two engines under a word
// neither of them uses. The repository list, the consent config, the projection and the
// routes are all keyed by provider already, so that is an addition rather than a rewrite.

/** The last path segment, which is what an operator recognises a checkout by. */
function repoLabel(repoRoot: string): string {
  const parts = repoRoot.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? repoRoot;
}

/**
 * Why one repository is or is not being read.
 *
 * Three states rather than a boolean, because "off" has two causes with two different
 * remedies and the row has to name the right control. A single flag collapses them, and the
 * collapse always fails the same way: a repository whose own switch is checked, sitting
 * under a master switch that is off, gets told to switch itself on.
 */
export type RepoObservation = "on" | "repo-off" | "master-off";

/**
 * One repository row's health, as one readable sentence.
 *
 * Never composed from an absent reading. A repository nobody has looked at yet says so
 * rather than reporting `0 runs`, on the rule the Inspector panel's "unknown" state states:
 * nothing observed is not the same claim as nothing there, and the second one would have
 * an operator debugging an engine that is working perfectly.
 */
export function repoHealthLine(
  status: PipelineRepoStatus | undefined,
  observation: RepoObservation,
): string {
  // Named separately because the two ways of being off need different instructions, and a
  // row whose own switch is visibly checked must never be told to switch it on. The master
  // switch wins when both are off: it is what blocks the read either way, and an operator
  // who flips it then gets the row's own sentence next.
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
  // HOW this was observed, said out loud on every row rather than only when a plugin is
  // installed. Without it "file tail" is invisible and "live events" reads as a state the
  // integration invented; with it, the row an operator installs the plugin to change is the
  // row that shows it changing. The absent case reads as the tail, which is exact: a status
  // from a build or a test that predates ingest was produced by a daemon that had none.
  const ingest =
    status.ingest === "live"
      ? " · live events"
      : status.ingest === "quiet"
        ? " · file tail (plugin quiet)"
        : " · file tail";
  return `${daemon} · ${runs}${halted}${ingest}`;
}

/**
 * What one provider's detection card says, as a tone and a sentence.
 *
 * `unknown` before the first read lands - which is a real state and not a formality: the
 * panel is reachable the instant it is routed to, and a card that read "not installed"
 * for the first few hundred milliseconds would be a wrong answer to the exact question
 * somebody opened it to ask.
 */
export function detectionReading(probe: PipelineProbe | undefined): {
  tone: "ok" | "off" | "unknown";
  text: string;
} {
  if (!probe) {
    return { tone: "unknown", text: "Looking for the engine…" };
  }
  if (!probe.found) {
    return {
      tone: "off",
      text: `Not installed - ${probe.bin} is not on this daemon's PATH.`,
    };
  }
  const version = probe.version === null ? "version unknown" : `version ${probe.version}`;
  return {
    tone: "ok",
    text: `Installed at ${probe.binPath} · ${version} · ${probe.projects.length} ${
      probe.projects.length === 1 ? "repository" : "repositories"
    } registered.`,
  };
}

/**
 * Every repository this panel can offer, in a stable order.
 *
 * The union of what the engine reports and what the config already holds, deliberately -
 * a repository an operator consented to and then de-registered from the engine must stay
 * visible, or its consent would be in force with nothing on screen that could withdraw it.
 */
export function offeredRepos(
  config: PipelinesConfig | null,
  probes: readonly PipelineProbe[],
): PipelineRepo[] {
  const byKey = new Map<string, PipelineRepo>();
  for (const probe of probes) {
    for (const project of probe.projects) {
      byKey.set(pipelineRepoKey(probe.provider, project.path), {
        provider: probe.provider,
        repoRoot: project.path,
        enabled: false,
      });
    }
  }
  for (const repo of config?.repos ?? []) {
    byKey.set(pipelineRepoKey(repo.provider, repo.repoRoot), repo);
  }
  return [...byKey.values()].sort((a, b) => a.repoRoot.localeCompare(b.repoRoot));
}

export function ConductorPanel({ state }: { state: ConductorState }): React.JSX.Element {
  const { view, save, recheck, checking, error } = state;
  const config = view?.config ?? null;
  const probes = view?.probes ?? [];
  const statusByRepo = new Map(
    (view?.status ?? []).map((s) => [pipelineRepoKey(s.provider, s.repoRoot), s]),
  );
  const repos = offeredRepos(config, probes);
  const active = config ? activePipelineRepos(config).length : 0;
  const info = PIPELINE_PROVIDER_INFO["ai-conductor"];
  const detection = detectionReading(probes.find((p) => p.provider === "ai-conductor"));

  /** Write one repository's consent, leaving every other entry exactly as it was. */
  const setRepoEnabled = (repo: PipelineRepo, enabled: boolean): void => {
    if (!config) return;
    const key = pipelineRepoKey(repo.provider, repo.repoRoot);
    const kept = config.repos.filter((r) => pipelineRepoKey(r.provider, r.repoRoot) !== key);
    void save({ ...config, repos: [...kept, { ...repo, enabled }] });
  };

  return (
    <section className="settings-section sc-section sc-solo" data-anchor="conductor/pipelines">
      <p className="settings-hint sc-lede">
        <strong>{info.label}</strong> {info.blurb} With a repository switched on below,
        Mission Control <em>reads</em> that engine's own state files and shows what it is
        doing. It never writes them, never starts or stops a pipeline, and never spends a
        token of its own: the engine's CLI stays the only thing that changes anything.
      </p>
      {/* The install path, in the panel rather than only in the docs, because this is where
          somebody is standing when they wonder why their pipelines are a few seconds stale.
          Deliberately framed as an OPTION and not a requirement - the file tail is what
          every row below is using, and it works with nothing installed. */}
      <p className="settings-hint conductor-ingest-hint">
        Reading files on a cadence needs nothing installed, and each row below says so. To
        have the engine push its events instead - the same picture, without the wait - copy{" "}
        <code>integrations/ai-conductor/mission-control/</code> from the Mission Control
        checkout into <code>~/.ai-conductor/plugins/mission-control/</code> and give it this
        daemon's URL and token. The engine's files stay the source of truth either way.
      </p>

      {/* The daemon has not answered. Said out loud, on the Inspector panel's rule: the
          fallbacks below are the OFF posture, and drawing them as the daemon's answer tells
          an operator nothing is being observed while the stored config may have several
          repositories switched on. */}
      {!view && (
        <p className="settings-warn conductor-unknown">
          Can't reach the daemon, so what Conductor is actually set to is unknown. The
          controls below are showing defaults, not its current state.
        </p>
      )}

      {error && <p className="settings-error">{error}</p>}

      <div className="sc-controls">
        <ConsoleCard
          title="The engine"
          anchor="conductor/detection"
          action={
            <Tooltip label="Probe for the engine again, right now, instead of waiting for the cached answer to expire">
              <button
                type="button"
                className="btn"
                disabled={!view || checking}
                onClick={() => void recheck()}
              >
                {checking ? "Checking…" : "Check again"}
              </button>
            </Tooltip>
          }
        >
          <ConsoleState tone={detection.tone}>{detection.text}</ConsoleState>
          {/* The registry path, always - a wrong `$AI_CONDUCTOR_REGISTRY` is the one
              misconfiguration that produces an empty repository list with no error, and
              printing where we looked is the whole difference between "none registered"
              and "we looked in the wrong place". */}
          {probes.map((probe) => (
            <p className="sc-health-row" key={probe.provider}>
              <span>Registry</span>
              <span className="sc-health-value">
                <code>{probe.registryPath}</code>
              </span>
            </p>
          ))}
          {/* Only for an engine that WAS found and then could not answer. A missing engine's
              error restates its own state line word for word, and the same sentence twice -
              once neutral, once in the error tone - reads as two problems. */}
          {probes
            .filter((probe) => probe.found && probe.error !== null)
            .map((probe) => (
              <p className="settings-error" key={`${probe.provider}-error`}>
                {probe.error}
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
                  ? "On - the repositories switched on below are read on a cadence. Click to stop reading all of them."
                  : "Off - nothing is read, whatever the repositories below say. Click to start."
              }
              checked={config?.enabled ?? false}
              disabled={!config}
              // `ok`, not `danger`: the consequence is entirely local. Nothing here
              // publishes, merges, types into a pane or spends a token - it reads files.
              tone="ok"
              onChange={(next) => {
                if (config) void save({ ...config, enabled: next });
              }}
            />
          }
        >
          <p className="settings-hint">
            The master switch. Turning it off stops every repository at once without
            forgetting which ones you had chosen, so turning it back on restores exactly
            that set.
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
              tooltip={
                config?.foremanMechanicalTriage
                  ? "On - Foreman may unpark mechanical halts through conductor's action route. Click to stop."
                  : "Off - every halt stays with the operator. Click to let Foreman unpark mechanical halts only."
              }
              checked={config?.foremanMechanicalTriage ?? false}
              disabled={!config}
              tone="ok"
              onChange={(next) => {
                if (config) void save({ ...config, foremanMechanicalTriage: next });
              }}
            />
          }
        >
          <p className="settings-hint">
            Off by default. Foreman may act only when conductor classifies a halt as
            mechanical. Needs-human, protected-artifact, legacy, unclassified, and unknown
            classes always stay in the operator's Attention inbox.
          </p>
          <ConsoleState tone={config?.foremanMechanicalTriage ? "attention" : "off"}>
            {config?.foremanMechanicalTriage
              ? "On - mechanical halts may be unparked automatically."
              : "Off - Foreman does not act on pipeline halts."}
          </ConsoleState>
        </ConsoleCard>

        <ConsoleCard title="Repositories" anchor="conductor/repos">
          <p className="settings-hint">
            Every repository the engine says it manages. Listing one here is configuration;
            switching it on is consent, and only then is anything read.
          </p>
          {repos.length === 0 ? (
            <p className="settings-hint conductor-empty">
              {view
                ? "No repositories registered with the engine, so there is nothing to observe yet."
                : "The repository list is unknown until the daemon answers."}
            </p>
          ) : (
            <ul className="conductor-repos" aria-label="Conductor repositories">
              {repos.map((repo) => {
                const key = pipelineRepoKey(repo.provider, repo.repoRoot);
                const status = statusByRepo.get(key);
                const observation: RepoObservation = !(config?.enabled ?? false)
                  ? "master-off"
                  : repo.enabled
                    ? "on"
                    : "repo-off";
                return (
                  <li className="conductor-repo" key={key}>
                    <label className="skill-switch">
                      <Tooltip
                        label={
                          repo.enabled
                            ? `Enabled - ${repo.repoRoot} is read on a cadence. Click to stop observing it.`
                            : `Not observed - nothing reads ${repo.repoRoot}. Click to observe it.`
                        }
                      >
                        <input
                          type="checkbox"
                          checked={repo.enabled}
                          disabled={!config}
                          aria-label={`Observe pipelines in ${repoLabel(repo.repoRoot)}`}
                          onChange={(e) => setRepoEnabled(repo, e.target.checked)}
                        />
                      </Tooltip>
                    </label>
                    <div className="conductor-repo-body">
                      <span className="conductor-repo-name">{repoLabel(repo.repoRoot)}</span>
                      <code className="conductor-repo-path">{repo.repoRoot}</code>
                      <span className="conductor-repo-health">
                        {repoHealthLine(status, observation)}
                      </span>
                      {status?.error && (
                        <span className="settings-error conductor-repo-error">
                          {status.error}
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </ConsoleCard>
      </div>
    </section>
  );
}
