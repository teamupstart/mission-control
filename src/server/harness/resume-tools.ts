import { join } from "node:path";
import type { MissionMcpDescriptor, MissionMcpTool } from "../mission-mcp.ts";

export interface ResumeToolsContext {
  descriptor: MissionMcpDescriptor | null;
  stateHome: string;
  requiredTools: readonly MissionMcpTool[];
}
export interface ResumeToolsRender { args: string[]; instrumented: boolean }

export async function claudeResumeTools(context: ResumeToolsContext): Promise<ResumeToolsRender> {
  if (!context.descriptor) throw new Error("Claude resume requires Mission MCP");
  // The harness registry is also used before daemon state is configured. Resolve launch
  // dependencies only during preparation, not when importing capability predicates.
  const { claudeMissionMcpArgs, missionMcpToolName } = await import("../mission-mcp.ts");
  return { args: [
    ...claudeMissionMcpArgs(context.descriptor, join(context.stateHome, "mission-mcp.json")),
    ...(context.requiredTools.length ? ["--allowed-tools", context.requiredTools.map(missionMcpToolName).join(",")] : []),
  ], instrumented: false };
}

export async function codexResumeTools(context: ResumeToolsContext): Promise<ResumeToolsRender> {
  if (!context.descriptor) throw new Error("Codex resume requires Mission MCP");
  const { codexMissionMcpArgs } = await import("../mission-mcp.ts");
  const { codexLaunchHooks } = await import("./codex/launch.ts");
  const hooks = codexLaunchHooks();
  return { args: [...codexMissionMcpArgs(context.descriptor), ...hooks.args], instrumented: hooks.instrumented };
}

export async function piResumeTools(): Promise<ResumeToolsRender> {
  // Availability is established by the installed extension's bridge, never MCP flags.
  return { args: [], instrumented: true };
}
