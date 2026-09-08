import type { LlmImageInput } from "@shared/llm.ts";
import type { RepositoryBudgets } from "@shared/repository-access.ts";
import {
  REPOSITORY_MCP_SERVER_NAME,
  REPOSITORY_OPERATION_IDS,
  repositoryMcpToolName,
} from "@shared/repository-access.ts";
import { agentSubprocessEnv, dropPaneIdentityEnv } from "../../agent-subprocess-env.ts";

export interface RepositoryMcpLaunchDescriptor {
  serverName: typeof REPOSITORY_MCP_SERVER_NAME;
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
}

export interface PersonaProviderLaunch {
  provider: "claude" | "codex";
  model: string;
  workingDirectory: string;
  prompt: string;
  images: readonly LlmImageInput[];
  outputSchema: Record<string, unknown>;
  deadline: number;
  budgets: RepositoryBudgets;
  repositoryMcp: RepositoryMcpLaunchDescriptor;
  allowedTools: readonly string[];
  hostedSearchMaximum: "cached";
}

export interface PersonaProviderResult {
  rawVerdict: string;
  usage: Record<string, unknown> | null;
  repositoryToolCalls: readonly string[];
}

export interface PersonaWorkloadProviderAdapter {
  readonly id: "claude" | "codex";
  run(launch: PersonaProviderLaunch, signal: AbortSignal): Promise<PersonaProviderResult>;
}

export const PERSONA_WORKLOAD_ALLOWED_TOOLS = Object.freeze(
  REPOSITORY_OPERATION_IDS.map(repositoryMcpToolName),
);

export const PERSONA_CODEX_DISABLED_FEATURES = Object.freeze([
  "shell_tool",
  "unified_exec",
  "apps",
  "enable_mcp_apps",
  "plugins",
  "memories",
  "skill_search",
  "multi_agent",
  "image_generation",
  "view_image",
  "browser_use",
  "in_app_browser",
  "sleep_tool",
  "goals",
  "hooks",
  "tool_suggest",
  "recommended_plugins",
  "workspace_dependencies",
] as const);

/** Build a provider environment without any capability to call Mission Control itself. */
export function personaProviderSubprocessEnv(
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const env = agentSubprocessEnv(base, { loopbackAccess: false });
  dropPaneIdentityEnv(env);
  delete env.TERM_PROGRAM;
  return env;
}

export function assertProviderNeutralLaunch(launch: PersonaProviderLaunch): void {
  if (launch.repositoryMcp.serverName !== REPOSITORY_MCP_SERVER_NAME) {
    throw new Error("Persona workload received an unexpected MCP server");
  }
  if (
    launch.allowedTools.length !== PERSONA_WORKLOAD_ALLOWED_TOOLS.length
    || launch.allowedTools.some((tool, index) => tool !== PERSONA_WORKLOAD_ALLOWED_TOOLS[index])
  ) {
    throw new Error("Persona workload tool capability differs from the closed repository MCP set");
  }
  if (launch.deadline <= Date.now()) throw new Error("Persona workload deadline has passed");
  if (launch.hostedSearchMaximum !== "cached") {
    throw new Error("Persona workload received an unsupported hosted-search policy");
  }
}

export function codexRepositoryMcpArgs(descriptor: RepositoryMcpLaunchDescriptor): string[] {
  const quote = (value: string): string => JSON.stringify(value);
  const key = `mcp_servers.${descriptor.serverName}`;
  const args = descriptor.args.map(quote).join(",");
  const env = Object.entries(descriptor.env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${quote(name)}=${quote(value)}`)
    .join(",");
  const enabledTools = REPOSITORY_OPERATION_IDS.map(quote).join(",");
  return [
    "--strict-config",
    "-c", "mcp_servers={}",
    "-c", `${key}.command=${quote(descriptor.command)}`,
    "-c", `${key}.args=[${args}]`,
    "-c", `${key}.env={${env}}`,
    "-c", `${key}.enabled_tools=[${enabledTools}]`,
    ...PERSONA_CODEX_DISABLED_FEATURES.flatMap((feature) => ["-c", `features.${feature}=false`]),
    "-c", 'web_search="disabled"',
    "-c", "tools.web_search=false",
  ];
}
