import type { AgentType } from "@shared/types.ts";
import {
  ENVIRONMENT_CHECK_INFO,
  type EnvironmentCheckView,
} from "@shared/environment-checks.ts";
import {
  ENVIRONMENT_ROW_METADATA,
  SETUP_DEPENDENCY_IDS,
  SETUP_DEPENDENCY_INFO,
  SETUP_FAMILY_IDS,
  TERMINAL_PAIR_INFO,
  type SetupChecksView,
  type SetupDependencyId,
  type SetupRowView,
  type SetupStatus,
} from "@shared/setup-catalog.ts";
import {
  MULTIPLEXER_IDS,
  type TerminalBackendId,
} from "@shared/terminal.ts";

import { ghBin } from "../config.ts";
import { defaultEnvironmentDeps, environmentCheckViews } from "../environment/index.ts";
import { resolveAgentBin } from "../harness/index.ts";
import { installedPluginsRead, claudePluginsDir } from "../plugins/installed-plugins.ts";
import { PIPELINE_PROVIDERS } from "../pipelines/providers.ts";
import { readCatalog } from "../skills/catalog.ts";
import { getSkillsConfig } from "../skills/config.ts";
import { desiredSkillIds, skillDrift, skillsDirs } from "../skills/reconcile.ts";
import { resolveBin } from "../terminal/bin.ts";
import { EMULATORS, MULTIPLEXERS } from "../terminal/registry.ts";
import { terminalTargetViews } from "../terminal/targets.ts";
import { refreshProcessPathFromLoginShell, resolveBinPath, run } from "../util/exec.ts";
import { pruneSetupBannerDismissal, setupBannerView } from "@shared/setup-banner.ts";
import { getSetupBannerDismissal, setSetupBannerDismissal } from "./banner.ts";
import type { SetupDeps, SetupSkillsRead } from "./types.ts";

type SetupProbe = (deps: SetupDeps) => Promise<SetupStatus>;

const DEPENDENCY_AGENT: Partial<Record<SetupDependencyId, AgentType>> = {
  "claude-cli": "claude",
  "codex-cli": "codex",
  "pi-cli": "pi",
};

async function present(bin: string, deps: SetupDeps): Promise<SetupStatus> {
  const path = await deps.resolveBinPath(bin);
  return path ? { state: "satisfied", evidence: path } : { state: "missing" };
}

async function agentStatus(id: SetupDependencyId, deps: SetupDeps): Promise<SetupStatus> {
  const agent = DEPENDENCY_AGENT[id];
  if (!agent) throw new Error(`no agent for ${id}`);
  return present(deps.agentBin(agent), deps);
}

async function terminalStatus(id: TerminalBackendId, deps: SetupDeps): Promise<SetupStatus> {
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
  const status = await present(deps.ghBin(), deps);
  if (status.state !== "satisfied") return status;
  const result = await deps.runCommand(status.evidence, ["--version"]);
  const atLeast = result.outcomeUnknown || result.code === null
    ? null
    : ghVersionAtLeast(result.stdout, GH_MINIMUM_VERSION);
  if (atLeast === false) {
    return {
      state: "needs-setup",
      why: `The installed GitHub CLI is older than the required ${GH_MINIMUM_VERSION}. Upgrade it to keep GitHub operations working.`,
      evidence: status.evidence,
    };
  }
  return status;
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
  return { state: "satisfied", evidence: `${probe.binPath}${version}` };
}

export const SETUP_PROBES: Record<SetupDependencyId, SetupProbe> = {
  "claude-cli": (deps) => agentStatus("claude-cli", deps),
  "codex-cli": (deps) => agentStatus("codex-cli", deps),
  "pi-cli": (deps) => agentStatus("pi-cli", deps),
  tmux: (deps) => terminalStatus("tmux", deps),
  cmux: (deps) => terminalStatus("cmux", deps),
  wezterm: (deps) => terminalStatus("wezterm", deps),
  ghostty: (deps) => terminalStatus("ghostty", deps),
  "gh-cli": ghCliStatus,
  "gh-auth": ghAuthStatus,
  "claude-plugins": pluginStatus,
  "claude-skills": skillStatus,
  "ai-conductor": conductorStatus,
  iterm: (deps) => terminalStatus("iterm", deps),
};

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runProbe(id: SetupDependencyId, deps: SetupDeps): Promise<SetupStatus> {
  try {
    return await SETUP_PROBES[id](deps);
  } catch (error) {
    return { state: "unknown", why: `This check could not run: ${reasonOf(error)}.`, evidence: null };
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
    refreshPath: async () => { await refreshProcessPathFromLoginShell({ force: true }); },
    agentBin: resolveAgentBin,
    installedBackend: async (id) => {
      const spec = MULTIPLEXER_IDS.includes(id as never)
        ? MULTIPLEXERS[id as keyof typeof MULTIPLEXERS].bin
        : EMULATORS[id as keyof typeof EMULATORS].bin;
      return resolveBinPath(resolveBin(spec));
    },
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
  const [statuses, targets, environment] = await Promise.all([
    Promise.all(SETUP_DEPENDENCY_IDS.map((id) => runProbe(id, deps))),
    Promise.resolve().then(() => deps.terminalTargets()),
    deps.environmentChecks(deps.environment),
  ]);
  const statusById = new Map(SETUP_DEPENDENCY_IDS.map((id, i) => [id, statuses[i]!]));
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
        rows.push({
          rowId: { source: "dependency", id },
          label: info.label,
          family: info.family,
          requirement: info.requirement,
          enables: info.enables,
          remedy: info.remedy,
          status: statusById.get(id)!,
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
    banner: setupBannerView(rows, pruned.dismissal),
    home: deps.environment.homeDir,
  };
}
