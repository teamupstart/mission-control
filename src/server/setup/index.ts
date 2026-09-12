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

import { ghBin } from "../config.ts";
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
import { refreshProcessPathFromLoginShell, resolveBinPath, run } from "../util/exec.ts";
import { pruneSetupBannerDismissal, setupBannerView } from "@shared/setup-banner.ts";
import { getSetupBannerDismissal, setSetupBannerDismissal } from "./banner.ts";
import type { SetupDeps, SetupProbeResult, SetupSkillsRead } from "./types.ts";
import { locateExecutable } from "../executables/locator.ts";
import { MIN_NODE_MAJOR, nodePrerequisiteMessage } from "../../../scripts/init-prerequisites.mjs";

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
      state: "unknown",
      why: `Mission Control could not verify the selected Node.js version. ${guidance}`,
      evidence: status.evidence,
    };
  }
  if (nodePrerequisiteMessage(version)) {
    return {
      state: "needs-setup",
      why: `Node.js ${version} is too old; Mission Control requires Node.js ${MIN_NODE_MAJOR} or newer. ${guidance}`,
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

export const SETUP_PROBES: Record<SetupDependencyId, SetupProbe> = {
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

function environmentRow(check: EnvironmentCheckView): SetupRowView | null {
  if (check.warning === null) return null;
  const metadata = ENVIRONMENT_ROW_METADATA[check.id];
  return {
    rowId: { source: "environment-check", id: check.id },
    label: check.label || ENVIRONMENT_CHECK_INFO[check.id].label,
    ...metadata,
    status: { state: "needs-setup", why: check.warning, evidence: check.detail },
  };
}

export function defaultSetupDeps(): SetupDeps {
  const environment = defaultEnvironmentDeps();
  return {
    environment,
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
    resolveBinPath,
    runCommand: (bin, argv) => run(bin, argv, { timeoutMs: 5000 }),
    installedPlugins: () => installedPluginsRead(claudePluginsDir(environment.homeDir)),
    skills: (): SetupSkillsRead => {
      const config = getSkillsConfig();
      const catalog = readCatalog();
      const directories = skillsDirs();
      return {
        enabled: config.enabled,
        readable: catalog.readable,
        configured: desiredSkillIds(config, catalog.present).size,
        directories,
        problems: [...catalog.problems, ...skillDrift(config, catalog, directories)],
      };
    },
    conductorProbe: () => PIPELINE_PROVIDERS["ai-conductor"].probe(),
    terminalTargets: terminalTargetViews,
    environmentChecks: environmentCheckViews,
    readBannerDismissal: getSetupBannerDismissal,
    writeBannerDismissal: setSetupBannerDismissal,
  };
}

/** One fresh, concurrent snapshot of every setup fact the page renders. */
export async function setupChecksView(deps: SetupDeps = defaultSetupDeps()): Promise<SetupChecksView> {
  await deps.refreshPath?.();
  const [probed, targets, environment] = await Promise.all([
    Promise.all(SETUP_DEPENDENCY_IDS.map((id) => runProbe(id, deps))),
    Promise.resolve().then(() => deps.terminalTargets()),
    deps.environmentChecks(deps.environment),
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
    rows.push(...environmentRows.filter((row) => row.family === family));
  }
  const pruned = pruneSetupBannerDismissal(rows, deps.readBannerDismissal());
  if (pruned.changed) deps.writeBannerDismissal(pruned.dismissal);
  return {
    rows,
    piExtensionInstallAvailable: deps.canInstallPiExtension?.() ?? false,
    piExtensionReady:
      environment.find((check) => check.id === "pi-extension")?.ready === true,
    banner: setupBannerView(rows, pruned.dismissal),
    home: deps.environment.homeDir,
  };
}
