import { mcpTrustStatus } from "./mcp-trust.ts";
import { codeRabbitReadiness, CODERABBIT_MANAGED_ENV } from "../workflows/coderabbit.ts";
import { scrubCheckEnv } from "../workflows/check-env.ts";
import { readToken } from "../../shared/harness-runtime.mjs";
import { cleanupAgentSubprocessEnv } from "../agent-subprocess-env.ts";
import { canInstallPiExtension } from "../environment/pi-extension.ts";
import type { AgentType } from "@shared/types.ts";
import { EXECUTABLE_SOURCE_LABELS, type ExecutableId } from "@shared/executables.ts";
import {
  ENVIRONMENT_CHECK_INFO,
  type EnvironmentCheckView,
} from "@shared/environment-checks.ts";
import {
  CMUX_APP_REMEDY,
  CMUX_SOCKET_CONTROL_REMEDY,
  ENVIRONMENT_ROW_METADATA,
  HERDR_SERVER_REMEDY,
  INDEXED_REPOSITORIES_INFO,
  SETUP_DEPENDENCY_IDS,
  SETUP_DEPENDENCY_INFO,
  SETUP_FAMILY_IDS,
  TERMINAL_PAIR_INFO,
  type SetupChecksView,
  type SetupDependencyId,
  type SetupRowView,
  type SetupStatus,
} from "@shared/setup-catalog.ts";
import type { TerminalBackendId } from "@shared/terminal.ts";

import { acliBin, ghBin } from "../config.ts";
import { JiraConfigSchema } from "@shared/task-source.ts";
import { getTaskSourcesConfig } from "../task-sources/config.ts";
import { firstLine, siteHost } from "../task-sources/jira.ts";
import { ACLI_TIMEOUT_MS, acliActiveSite, acliFault, writeDiagnostic } from "../task-sources/jira-acli.ts";
import { defaultEnvironmentDeps, environmentCheckViews } from "../environment/index.ts";
import { resolveAgentBin } from "../harness/index.ts";
import { installedPluginsRead, claudePluginsDir } from "../plugins/installed-plugins.ts";
import { PIPELINE_PROVIDERS } from "../pipelines/providers.ts";
import { readCatalog } from "../skills/catalog.ts";
import { getSkillsConfig } from "../skills/config.ts";
import { desiredSkillIds, skillDrift, skillsDirs } from "../skills/reconcile.ts";
import { binUnsupportedReason, resolveBin } from "../terminal/bin.ts";
import { cmuxControlProbe } from "../terminal/cmux.ts";
import { herdrServerProbe } from "../terminal/herdr.ts";
import { terminalBackendBin } from "../terminal/registry.ts";
import { terminalTargetViews } from "../terminal/targets.ts";
import { configuredTerminalTargetDeps } from "../terminals-config.ts";
import { refreshProcessPathFromLoginShell, resolveBinPath, run } from "../util/exec.ts";
import { pruneSetupBannerDismissal, setupBannerView } from "@shared/setup-banner.ts";
import { getSetupBannerDismissal, setSetupBannerDismissal } from "./banner.ts";
import type { SetupDeps, SetupProbeResult, SetupRepositoryIndexRead, SetupSkillsRead } from "./types.ts";
import { repoIndexView } from "../repo-index.ts";
import { listRepos } from "../repos.ts";
import { locateExecutable } from "../executables/locator.ts";
import { MIN_NODE_MAJOR, nodePrerequisiteMessage } from "../../../scripts/init-prerequisites.mjs";
import { servingRuntime } from "../owned-runtime.ts";

/**
 * A probe answers with a status, or with a status AND the repair that reading needs.
 *
 * A union rather than one wrapped shape, because exactly one probe has a second repair to
 * name and thirteen have nothing to add. `setupProbeResult` normalizes before anything
 * reads either form, so no caller branches on which one a probe chose.
 */
type SetupProbe = (deps: SetupDeps) => Promise<SetupStatus | SetupProbeResult>;

/** One shape for both probe return forms. */
export function setupProbeResult(value: SetupStatus | SetupProbeResult): SetupProbeResult {
  return "state" in value ? { status: value } : value;
}

const DEPENDENCY_AGENT: Partial<Record<SetupDependencyId, AgentType>> = {
  "claude-cli": "claude",
  "codex-cli": "codex",
  "pi-cli": "pi",
};

const AGENT_EXECUTABLE: Record<AgentType, ExecutableId> = {
  claude: "claude",
  codex: "codex",
  pi: "pi",
};

async function present(bin: string, deps: SetupDeps, id?: ExecutableId): Promise<SetupStatus> {
  if (id && deps.executableDiagnostic) {
    const resolved = await deps.executableDiagnostic(id);
    return resolved
      ? { state: "satisfied", evidence: resolved.path, source: resolved.source }
      : { state: "missing" };
  }
  const path = await deps.resolveBinPath(bin);
  return path ? { state: "satisfied", evidence: path } : { state: "missing" };
}

async function agentStatus(id: SetupDependencyId, deps: SetupDeps): Promise<SetupStatus> {
  const agent = DEPENDENCY_AGENT[id];
  if (!agent) throw new Error(`no agent for ${id}`);
  return present(deps.agentBin(agent), deps, AGENT_EXECUTABLE[agent]);
}

async function terminalStatus(id: TerminalBackendId, deps: SetupDeps): Promise<SetupStatus> {
  const unsupported = deps.backendUnsupported?.(id);
  if (unsupported) return { state: "needs-setup", why: unsupported, evidence: null };
  if (deps.executableDiagnostic) {
    const resolved = await deps.executableDiagnostic(id);
    return resolved
      ? { state: "satisfied", evidence: resolved.path, source: resolved.source }
      : { state: "missing" };
  }
  const path = await deps.installedBackend(id);
  return path ? { state: "satisfied", evidence: path } : { state: "missing" };
}

/** Mission Control depends on GitHub CLI behavior only present from this release onward. */
const GH_MINIMUM_VERSION = "2.100.0";

/** Parse only stable `gh version X.Y.Z` output and compare numeric components. */
function ghVersionAtLeast(versionOutput: string, minimum: string): boolean | null {
  const match = /^gh version (\d+)\.(\d+)\.(\d+)(?:\s|$)/m.exec(versionOutput);
  if (!match) return null;
  const installed = match.slice(1, 4).map(Number);
  const required = minimum.split(".").map(Number);
  for (let index = 0; index < required.length; index++) {
    if (installed[index]! > required[index]!) return true;
    if (installed[index]! < required[index]!) return false;
  }
  return true;
}

async function ghCliStatus(deps: SetupDeps): Promise<SetupStatus> {
  const status = await present(deps.ghBin(), deps, "gh");
  if (status.state !== "satisfied") return status;
  const result = await deps.runCommand(status.evidence, ["--version"]);
  const atLeast = !result.outcomeUnknown && result.code === 0
    ? ghVersionAtLeast(result.stdout, GH_MINIMUM_VERSION)
    : null;
  if (atLeast === false) {
    return {
      state: "needs-setup",
      why: `The installed GitHub CLI is older than the required ${GH_MINIMUM_VERSION}. Upgrade it to keep GitHub operations working.`,
      evidence: status.evidence,
    };
  }
  return status;
}

async function nodeRuntimeStatus(deps: SetupDeps): Promise<SetupStatus> {
  const guidance = `Install or update Node.js ${MIN_NODE_MAJOR}+ using the command below (requires Homebrew), then press Re-check. If an older runtime is still selected, correct MISSION_NODE_BIN or your version manager/PATH and restart Mission Control with that environment.`;
  const status = await present("node", deps, "node");
  if (status.state !== "satisfied") {
    return { state: "needs-setup", why: `Node.js could not be found. ${guidance}`, evidence: null };
  }
  const result = await deps.runCommand(status.evidence, ["-p", "process.versions.node"]);
  const version = result.stdout.trim();
  if (result.outcomeUnknown || result.overflowed || result.code !== 0 || !/^\d+\.\d+\.\d+$/.test(version)) {
    return {
      ...status,
      state: "unknown",
      why: `Mission Control could not verify the selected Node.js version. ${guidance}`,
      evidence: status.evidence,
    };
  }
  if (nodePrerequisiteMessage(version)) {
    return {
      ...status,
      state: "needs-setup",
      why: `Node.js ${version} is too old for source development, which requires Node.js ${MIN_NODE_MAJOR} or newer. Independent tools have their own version requirements. ${guidance}`,
      evidence: status.evidence,
    };
  }
  return { ...status, evidence: `${status.evidence} (Node.js ${version})` };
}

async function ghAuthStatus(deps: SetupDeps): Promise<SetupStatus> {
  const path = await deps.resolveBinPath(deps.ghBin());
  if (!path) return { state: "missing" };
  const result = await deps.runCommand(path, ["auth", "status", "--hostname", "github.com"]);
  const evidence = `${result.stdout}\n${result.stderr}`.trim();
  if (result.outcomeUnknown) {
    return { state: "unknown", why: "GitHub authentication did not finish checking.", evidence: evidence || null };
  }
  if (result.code === null) {
    return { state: "unknown", why: "GitHub authentication could not be checked.", evidence: evidence || null };
  }
  if (/logged in to github\.com(?: account| as)/i.test(evidence)) {
    return { state: "satisfied", evidence: "Authenticated to github.com" };
  }
  return {
    state: "needs-setup",
    why: "The GitHub CLI is installed but is not authenticated to github.com.",
    evidence: evidence || null,
  };
}

async function pluginStatus(deps: SetupDeps): Promise<SetupStatus> {
  const reading = await deps.installedPlugins();
  if (!reading.ok) {
    if (reading.missing) return { state: "missing" };
    return { state: "unknown", why: "Claude Code's plugin record could not be read.", evidence: reading.reason };
  }
  if (reading.plugins.length === 0) return { state: "missing" };
  return {
    state: "satisfied",
    evidence: `${reading.plugins.length} installed in ${reading.recordPath}`,
  };
}

async function skillStatus(deps: SetupDeps): Promise<SetupStatus> {
  const reading = deps.skills();
  const evidence = reading.directories.join(", ") || null;
  if (!reading.readable) {
    return { state: "unknown", why: "Mission Control's skill catalog could not be read.", evidence: reading.problems.join(" ") || evidence };
  }
  if (!reading.enabled) {
    return { state: "needs-setup", why: "Mission Control skills are switched off.", evidence };
  }
  if (reading.configured === 0) {
    return { state: "needs-setup", why: "No Mission Control skills are enabled.", evidence };
  }
  if (reading.problems.length > 0) {
    return { state: "needs-setup", why: reading.problems.join(" "), evidence };
  }
  return { state: "satisfied", evidence: `${reading.configured} enabled across ${reading.directories.join(", ")}` };
}

async function conductorStatus(deps: SetupDeps): Promise<SetupStatus> {
  const probe = await deps.conductorProbe();
  if (!probe.found || !probe.binPath) return { state: "missing" };
  const version = probe.version ? ` ${probe.version}` : "";
  const diagnostic = await deps.executableDiagnostic?.("conductor");
  return {
    state: "satisfied",
    evidence: `${probe.binPath}${version}`,
    ...(diagnostic?.path === probe.binPath ? { source: diagnostic.source } : {}),
  };
}

/**
 * Herdr, which installation alone does not answer for.
 *
 * The CLI is a client. With it installed and its default server down, nothing Mission
 * Control does through Herdr works - no workspace is listed, created, focused or typed into
 * - and the adapter degrades to an empty pane list rather than logging that fact once a
 * tick (see `terminal/herdr.ts`). This row is where it is said instead, and it offers the
 * start rather than the install guide, because installing again repairs nothing.
 */
async function herdrStatus(deps: SetupDeps): Promise<SetupProbeResult> {
  const installed = await terminalStatus("herdr", deps);
  if (installed.state !== "satisfied") return { status: installed };
  const server = await deps.herdrServer();
  if (server.state === "ready") {
    return { status: { ...installed, evidence: `${installed.evidence} (server ${server.version})` } };
  }
  const why = server.state === "stopped"
    ? "Herdr is installed but its default server is not running. Mission Control cannot list, open, or type into Herdr workspaces until it starts."
    : server.error;
  // A `failed` probe that is not retryable is an incompatible or unreadable Herdr, and no
  // amount of starting fixes that - the catalog's install guide is the honest remedy there.
  const startable = server.state === "stopped" || server.retryable;
  return {
    status: { state: "needs-setup", why, evidence: installed.evidence },
    ...(startable ? { remedy: HERDR_SERVER_REMEDY } : {}),
  };
}

/**
 * cmux, which installation alone answers for even less than Herdr's does.
 *
 * Two facts stand between an installed cmux and a working one, and neither is guessable.
 * The control socket exists only while the app is RUNNING; and cmux ships
 * `automation.socketControlMode: "cmuxOnly"`, which admits only processes started inside
 * cmux - the daemon is not one, so every call it makes is denied. Under either, the adapter
 * degrades to an empty pane list without a word (see `terminal/cmux.ts`), and this row used
 * to report "satisfied" on the strength of the binary being on PATH while every dispatch to
 * cmux failed. That is the reading this exists to stop.
 *
 * The two get DIFFERENT remedies because they are different repairs, and offering the wrong
 * one is worse than offering none: opening an app that is already open fixes nothing, and
 * editing a config file for an app that is closed repairs a fault the operator does not have.
 */
async function cmuxStatus(deps: SetupDeps): Promise<SetupProbeResult> {
  const installed = await terminalStatus("cmux", deps);
  if (installed.state !== "satisfied") return { status: installed };
  const control = await deps.cmuxControl();
  if (control.state === "ready") {
    return {
      status: { ...installed, evidence: `${installed.evidence} (socket control ${control.accessMode})` },
    };
  }
  if (control.state === "stopped") {
    return {
      status: {
        state: "needs-setup",
        why: "cmux is installed but not running. Its control socket exists only while the app is open, so Mission Control cannot list, create, or type into cmux workspaces until it is.",
        evidence: installed.evidence,
      },
      remedy: CMUX_APP_REMEDY,
    };
  }
  if (control.state === "refused") {
    return {
      status: {
        state: "needs-setup",
        why: "cmux is running but its control socket only admits processes started inside cmux. Mission Control's daemon is not one, so every call it makes is denied until automation.socketControlMode is allowAll.",
        evidence: installed.evidence,
      },
      remedy: CMUX_SOCKET_CONTROL_REMEDY,
    };
  }
  // A socket that answered something else is not a repair either button performs, so the
  // catalog's install guide stays the offer and the row reports what cmux actually said.
  return { status: { state: "needs-setup", why: control.error, evidence: installed.evidence } };
}

/**
 * Signed in, and to the site the configured sources read.
 *
 * The same `acli jira auth status` reading the sweep's site gate makes, through the same
 * parser, so this row cannot call a machine ready that every sweep then refuses. The site is
 * the evidence and the email never is: acli prints the account address beside it.
 */
async function acliAuthStatus(deps: SetupDeps): Promise<SetupStatus> {
  const installed = await present(acliBin(), deps, "acli");
  if (installed.state !== "satisfied") {
    return { state: "needs-setup", why: "Install the Atlassian CLI first, press Re-check, then sign in.", evidence: null };
  }
  // The sweep's own budget for this command. A shorter one would report "did not answer" on
  // a busy machine where every sweep's site gate still succeeds.
  const result = await deps.runCommand(installed.evidence, ["jira", "auth", "status"], undefined, ACLI_TIMEOUT_MS);
  if (result.outcomeUnknown) {
    return { state: "unknown", why: "acli did not answer `acli jira auth status` in time.", evidence: null };
  }
  if (result.code !== 0) {
    const said = writeDiagnostic(firstLine(result.stderr || result.stdout)) || null;
    return {
      state: "needs-setup",
      why: acliFault(result) === "unauthenticated"
        ? "The Atlassian CLI is installed but not signed in to Jira."
        : "The Atlassian CLI could not report a Jira sign-in. Sign in again to repair it.",
      evidence: said,
    };
  }
  const active = acliActiveSite(result);
  if (!active) {
    return {
      state: "unknown",
      why: "acli answered, but Mission Control could not tell which Jira site it is signed in to. Run `acli jira auth status` to check.",
      evidence: null,
    };
  }
  const elsewhere = (deps.acliSourceSites?.() ?? []).filter((site) => site !== active);
  if (elsewhere.length > 0) {
    return {
      state: "needs-setup",
      why: `acli is signed in to ${active}, but ${elsewhere.length === 1 ? "a Jira source reads" : "Jira sources read"} ${elsewhere.join(", ")}. Run \`acli jira auth switch --site ${elsewhere[0]}\`, or sign in to that site.`,
      evidence: `Signed in to ${active}`,
    };
  }
  return { state: "satisfied", evidence: `Signed in to ${active}` };
}

/** Every Jira site an acli source reads, whether or not that source is paused right now. */
function configuredAcliSites(): string[] {
  const sites = new Set<string>();
  for (const source of getTaskSourcesConfig().sources) {
    if (source.kind !== "jira") continue;
    const parsed = JiraConfigSchema.safeParse(source.config ?? {});
    if (!parsed.success || parsed.data.queryVia !== "acli") continue;
    const host = siteHost(parsed.data.site);
    if (host) sites.add(host);
  }
  return [...sites].sort();
}

async function codeRabbitStatus(deps: SetupDeps): Promise<SetupStatus> {
  const status = await present("coderabbit", deps, "coderabbit");
  if (status.state !== "satisfied") return status;
  let version = "";
  const problem = await codeRabbitReadiness((args) => deps.runCommand(status.evidence, args, CODERABBIT_MANAGED_ENV), (value) => { version = value; });
  return problem ? { state: "needs-setup", why: problem, evidence: status.evidence }
    : { ...status, evidence: `${status.evidence} (CodeRabbit ${version}; stored authentication ready)` };
}

export const SETUP_PROBES: Record<SetupDependencyId, SetupProbe> = {
  "claude-mcp-trust": async (deps) => deps.mcpTrust?.("claude") ?? { state: "unknown", why: "MCP trust check unavailable.", evidence: null },
  "codex-mcp-trust": async (deps) => deps.mcpTrust?.("codex") ?? { state: "unknown", why: "MCP trust check unavailable.", evidence: null },
  "coderabbit-cli": codeRabbitStatus,
  "claude-cli": (deps) => agentStatus("claude-cli", deps),
  "codex-cli": (deps) => agentStatus("codex-cli", deps),
  "pi-cli": (deps) => agentStatus("pi-cli", deps),
  tmux: (deps) => terminalStatus("tmux", deps),
  cmux: cmuxStatus,
  herdr: herdrStatus,
  wezterm: (deps) => terminalStatus("wezterm", deps),
  ghostty: (deps) => terminalStatus("ghostty", deps),
  "gh-cli": ghCliStatus,
  "gh-auth": ghAuthStatus,
  "claude-plugins": pluginStatus,
  "claude-skills": skillStatus,
  "ai-conductor": conductorStatus,
  iterm: (deps) => terminalStatus("iterm", deps),
  "node-runtime": nodeRuntimeStatus,
  // Installed, answered from the filesystem alone. No `--version` run: every acli subprocess
  // is one an operator's audit of "what did it ask Jira" has to account for, and the sign-in
  // row already runs the one command whose answer matters.
  "acli-cli": (deps) => present(acliBin(), deps, "acli"),
  "acli-auth": acliAuthStatus,
};

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runProbe(id: SetupDependencyId, deps: SetupDeps): Promise<SetupProbeResult> {
  try {
    return setupProbeResult(await SETUP_PROBES[id](deps));
  } catch (error) {
    return {
      status: { state: "unknown", why: `This check could not run: ${reasonOf(error)}.`, evidence: null },
    };
  }
}

function repositoryNoun(count: number): string {
  return `${count} ${count === 1 ? "repository" : "repositories"}`;
}

/**
 * Setup passes only once the index has found at least one checkout.
 *
 * A machine with every tool installed and nothing to work in cannot dispatch anything, so a
 * zero count is a required gap rather than an empty list to shrug at. The reason names what
 * the walk actually saw, because "nothing is indexed" and "four directories, none of them
 * holding a checkout" are different repairs.
 */
export function indexedRepositoriesStatus(read: SetupRepositoryIndexRead): SetupStatus {
  const looked = read.directories.map((row) =>
    row.status === "ok" ? `${row.path} (${repositoryNoun(row.repoCount ?? 0)})` : `${row.path} (${row.status.replace(/-/g, " ")})`,
  );
  if (read.repoCount > 0) {
    const holding = read.directories.filter((row) => row.status === "ok" && (row.repoCount ?? 0) > 0);
    return {
      state: "satisfied",
      evidence: holding.length > 0
        ? `${repositoryNoun(read.repoCount)} in ${holding.map((row) => row.path).join(", ")}`
        : `${repositoryNoun(read.repoCount)} detected`,
    };
  }
  if (read.directories.length === 0) {
    return {
      state: "needs-setup",
      why: "No directories are indexed, so no repositories can be detected. Add the directory that holds your git checkouts.",
      evidence: null,
    };
  }
  return {
    state: "needs-setup",
    why: `${read.directories.length === 1 ? "The indexed directory holds no" : `None of the ${read.directories.length} indexed directories holds a`} git repository. Add the directory that holds your checkouts, or clone one into an indexed directory, then press Rescan now.`,
    evidence: looked.join(", "),
  };
}

async function indexedRepositoriesRow(deps: SetupDeps): Promise<SetupRowView> {
  let status: SetupStatus;
  try {
    status = indexedRepositoriesStatus(await deps.repositoryIndex());
  } catch (error) {
    status = { state: "unknown", why: `The repository index could not be read: ${reasonOf(error)}.`, evidence: null };
  }
  return { ...INDEXED_REPOSITORIES_INFO, status };
}

function environmentRow(check: EnvironmentCheckView): SetupRowView | null {
  const metadata = ENVIRONMENT_ROW_METADATA[check.id];
  const { readyEvidence, ...rowMetadata } = metadata;
  if (check.warning === null) {
    if (check.ready !== true || !readyEvidence) return null;
    return {
      rowId: { source: "environment-check", id: check.id },
      label: check.label || ENVIRONMENT_CHECK_INFO[check.id].label,
      ...rowMetadata,
      status: { state: "satisfied", evidence: readyEvidence },
    };
  }
  return {
    rowId: { source: "environment-check", id: check.id },
    label: check.label || ENVIRONMENT_CHECK_INFO[check.id].label,
    ...rowMetadata,
    status: { state: "needs-setup", why: check.warning, evidence: check.detail },
  };
}

export function defaultSetupDeps(): SetupDeps {
  const environment = defaultEnvironmentDeps();
  return {
    environment,
    mcpTrust: mcpTrustStatus,
    runtime: servingRuntime,
    canInstallPiExtension,
    refreshPath: async () => { await refreshProcessPathFromLoginShell({ force: true }); },
    executableDiagnostic: async (id) => {
      const resolved = await locateExecutable(id);
      return resolved
        ? { path: resolved.path, source: EXECUTABLE_SOURCE_LABELS[resolved.source] }
        : null;
    },
    agentBin: resolveAgentBin,
    installedBackend: async (id) => {
      const spec = terminalBackendBin(id);
      return resolveBinPath(resolveBin(spec));
    },
    backendUnsupported: (id) => binUnsupportedReason(terminalBackendBin(id)),
    herdrServer: () => herdrServerProbe(),
    cmuxControl: () => cmuxControlProbe(),
    ghBin,
    acliSourceSites: configuredAcliSites,
    resolveBinPath,
    runCommand: async (bin, argv, managedEnv, timeoutMs) => {
      if (!managedEnv) return run(bin, argv, { timeoutMs: timeoutMs ?? 5000 });
      const env = { ...scrubCheckEnv(process.env, readToken()), ...managedEnv };
      try { return await run(bin, argv, { env, timeoutMs: 7000, maxBuffer: 64 * 1024 }); }
      finally { cleanupAgentSubprocessEnv(env); }
    },
    installedPlugins: () => installedPluginsRead(claudePluginsDir(environment.homeDir)),
    skills: (): SetupSkillsRead => {
      const config = getSkillsConfig();
      const catalog = readCatalog();
      const directories = skillsDirs();
      return {
        enabled: config.enabled,
        readable: catalog.readable,
        configured: desiredSkillIds(config, catalog).size,
        directories,
        problems: [...catalog.problems, ...skillDrift(config, catalog, directories)],
      };
    },
    conductorProbe: () => PIPELINE_PROVIDERS["ai-conductor"].probe(),
    // Composed with the stored preference, so the Terminals rows and the launch menu report
    // the same raiser Focus will actually use.
    terminalTargets: () => terminalTargetViews(configuredTerminalTargetDeps),
    repositoryIndex: async () => {
      // Every Setup read carries this row, whichever family is on screen. The count comes from
      // the shared scan cache, so reads walk the indexed directories at most once per cache
      // window (the same one the dispatch picker uses) and a vanished last repository is
      // noticed as soon as that window expires. Only a zero count pays for the per-directory
      // read the failing row explains itself with. `fresh`, because a required check must not
      // report the scan from before the window closed while a rescan runs behind it - the
      // stale-while-revalidate answer is for the picker, not for readiness.
      const repos = await listRepos({ fresh: true });
      if (repos.length > 0) return { repoCount: repos.length, directories: [] };
      const view = await repoIndexView();
      return {
        repoCount: view.repoCount,
        directories: view.directories.map(({ path, status, repoCount }) => ({ path, status, repoCount })),
      };
    },
    environmentChecks: environmentCheckViews,
    readBannerDismissal: getSetupBannerDismissal,
    writeBannerDismissal: setSetupBannerDismissal,
  };
}

/** One fresh, concurrent snapshot of every setup fact the page renders. */
export async function setupChecksView(deps: SetupDeps = defaultSetupDeps()): Promise<SetupChecksView> {
  await deps.refreshPath?.();
  const [probed, targets, environment, repositories] = await Promise.all([
    Promise.all(SETUP_DEPENDENCY_IDS.map((id) => runProbe(id, deps))),
    Promise.resolve().then(() => deps.terminalTargets()),
    deps.environmentChecks(deps.environment),
    indexedRepositoriesRow(deps),
  ]);
  const probeById = new Map(SETUP_DEPENDENCY_IDS.map((id, i) => [id, probed[i]!]));
  const usable = targets.find((target) => target.unavailable === null);
  const derived: SetupRowView = {
    ...TERMINAL_PAIR_INFO,
    status: usable
      ? { state: "satisfied", evidence: `${usable.label}: ${usable.blurb}` }
      : { state: "missing" },
  };
  const environmentRows = environment.map(environmentRow).filter((row): row is SetupRowView => row !== null);
  const rows: SetupRowView[] = [];
  for (const family of SETUP_FAMILY_IDS) {
    for (const id of SETUP_DEPENDENCY_IDS) {
      const info = SETUP_DEPENDENCY_INFO[id];
      if (info.family === family) {
        const probe = probeById.get(id)!;
        rows.push({
          rowId: { source: "dependency", id },
          label: info.label,
          family: info.family,
          requirement: info.requirement,
          enables: info.enables,
          // The probe's own remedy when this reading has one; see `SetupProbeResult`.
          remedy: probe.remedy ?? info.remedy,
          status: probe.status,
        });
      }
    }
    if (family === "terminals") rows.push(derived);
    if (family === "repositories") rows.push(repositories);
    rows.push(...environmentRows.filter((row) => row.family === family));
  }
  const pruned = pruneSetupBannerDismissal(rows, deps.readBannerDismissal());
  if (pruned.changed) deps.writeBannerDismissal(pruned.dismissal);
  return {
    rows,
    ...(deps.runtime ? { runtime: deps.runtime() } : {}),
    piCliReady: probeById.get("pi-cli")?.status.state === "satisfied",
    piExtensionInstallAvailable: (deps.canInstallPiExtension?.() ?? false) && environment.find((check) => check.id === "pi-extension")?.ready !== true,
    piExtensionReady:
      environment.find((check) => check.id === "pi-extension")?.ready === true,
    banner: setupBannerView(rows, pruned.dismissal),
    home: deps.environment.homeDir,
  };
}
