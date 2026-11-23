import { APP_CONFIG_ENTRIES } from "@shared/app-config-entries.ts";
import { AGENT_ENVIRONMENT_FLAG } from "@shared/feature-flag-registry.ts";
import { AgentEnvironmentConfigSchema } from "@shared/protocol.ts";
import type { WorktreeClaimVariableView } from "@shared/worktrees.ts";
import { readToken } from "../shared/harness-runtime.mjs";
import { getAppConfig, setAppConfig } from "./db.ts";
import { probeLoginShellPath } from "./executables/locator.ts";
import { featureEnabled } from "./feature-flags/index.ts";
import { resolveNamedVariable } from "./executables/named-variable.ts";

export interface NamedAgentEnvironment {
  extraEnv: Record<string, string>;
  missing: string[];
}

export function saveAgentEnvironment(names: string[]): void {
  setAppConfig(APP_CONFIG_ENTRIES.agentEnvironment, AgentEnvironmentConfigSchema.parse({ names }));
}

/** A fresh, bounded probe. Secret values never enter the executable locator's cached snapshot. */
async function resolveEnvironment() {
  const config = AgentEnvironmentConfigSchema.safeParse(getAppConfig(APP_CONFIG_ENTRIES.agentEnvironment));
  const names = config.success ? config.data.names : [];
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

export async function agentEnvironmentPresence(): Promise<WorktreeClaimVariableView[]> {
  return (await resolveEnvironment()).variables;
}

export async function launchAgentEnvironment(resident = false): Promise<NamedAgentEnvironment | undefined> {
  if (resident || !featureEnabled(AGENT_ENVIRONMENT_FLAG)) return undefined;
  const { variables, extraEnv, missing } = await resolveEnvironment();
  return variables.length ? { extraEnv, missing } : undefined;
}
