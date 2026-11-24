import { createHash } from "node:crypto";
import { APP_CONFIG_ENTRIES } from "@shared/app-config-entries.ts";
import { AGENT_ENVIRONMENT_FLAG } from "@shared/feature-flag-registry.ts";
import { AgentEnvironmentConfigSchema } from "@shared/protocol.ts";
import type { WorktreeClaimVariableView } from "@shared/worktrees.ts";
import { readToken } from "../shared/harness-runtime.mjs";
import { getAppConfig, setAppConfig } from "./db.ts";
import { probeLoginShellPath } from "./executables/locator.ts";
import { featureEnabled } from "./feature-flags/index.ts";
import { resolveNamedVariable, type NamedAgentEnvironment } from "./executables/named-variable.ts";
import { rememberTerminalLaunchWarning } from "./terminal-launch-warnings.ts";

function configuredNames(): string[] {
  const entry = APP_CONFIG_ENTRIES.agentEnvironment;
  const config = entry.schema.safeParse(getAppConfig(entry));
  return config.success ? config.data.names : [];
}

// The ordered names identify the saved selection across daemon restarts and settings restores.
function selection(names: string[]) {
  return { names, revision: createHash("sha256").update(JSON.stringify(names)).digest("hex") };
}

export function saveAgentEnvironment(names: string[], expectedRevision?: string) {
  if (expectedRevision !== undefined) {
    const current = selection(configuredNames());
    if (current.revision !== expectedRevision) return { ok: false, selection: current };
  }
  const config = AgentEnvironmentConfigSchema.parse({ names });
  setAppConfig(APP_CONFIG_ENTRIES.agentEnvironment, config);
  return { ok: true, selection: selection(config.names) };
}

/** A fresh, bounded probe. Secret values never enter the executable locator's cached snapshot. */
async function resolveEnvironment(names: string[]) {
  const absent = names.filter((name) => !process.env[name]);
  const shell = absent.length ? await probeLoginShellPath(process.env, undefined, absent) : null;
  const sources = { daemonEnv: process.env, loginShell: shell?.variables ?? {}, daemonToken: readToken() };
  const variables: WorktreeClaimVariableView[] = [];
  const extraEnv: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of names) {
    const resolved = resolveNamedVariable(name, sources);
    variables.push({ name, present: !!resolved, source: resolved?.source ?? null });
    if (resolved) extraEnv[name] = resolved.value;
    else missing.push(name);
  }
  return { variables, extraEnv, missing };
}

export async function agentEnvironmentPresence(saved = selection(configuredNames())) {
  const { variables } = await resolveEnvironment(saved.names);
  const current = selection(configuredNames());
  return current.revision === saved.revision ? { ...saved, variables } : { ...current, variables: null };
}

export async function launchAgentEnvironment(resident = false): Promise<NamedAgentEnvironment | undefined> {
  if (resident || !featureEnabled(AGENT_ENVIRONMENT_FLAG)) return undefined;
  const { variables, extraEnv, missing } = await resolveEnvironment(configuredNames());
  return variables.length ? { extraEnv, missing } : undefined;
}

export async function terminalLaunchEnvironment(launchHome: string, resident: boolean) {
  const named = await launchAgentEnvironment(resident);
  if (named?.missing.length) {
    try { rememberTerminalLaunchWarning(launchHome, named.missing); }
    catch { console.warn("[agent-environment] Could not persist the terminal launch warning for rediscovery"); }
  }
  return named;
}
