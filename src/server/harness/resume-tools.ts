import { join } from "node:path";
import { claudeMissionMcpArgs, codexMissionMcpArgs, missionMcpToolName,
  type MissionMcpDescriptor, type MissionMcpTool } from "../mission-mcp.ts";
import { codexLaunchHooks } from "./codex/launch.ts";

export interface ResumeToolsContext {
  descriptor: MissionMcpDescriptor | null;
  stateHome: string;
  requiredTools: readonly MissionMcpTool[];
}
export interface ResumeToolsRender { args: string[]; instrumented: boolean }

export function claudeResumeTools(context: ResumeToolsContext): ResumeToolsRender {
  if (!context.descriptor) throw new Error("Claude resume requires Mission MCP");
  return { args: [
    ...claudeMissionMcpArgs(context.descriptor, join(context.stateHome, "mission-mcp.json")),
    ...(context.requiredTools.length ? ["--allowed-tools", context.requiredTools.map(missionMcpToolName).join(",")] : []),
  ], instrumented: false };
}

export function codexResumeTools(context: ResumeToolsContext): ResumeToolsRender {
  if (!context.descriptor) throw new Error("Codex resume requires Mission MCP");
  const hooks = codexLaunchHooks();
  return { args: [...codexMissionMcpArgs(context.descriptor), ...hooks.args], instrumented: hooks.instrumented };
}

export function piResumeTools(): ResumeToolsRender {
  // Availability is established by the installed extension's bridge, never MCP flags.
  return { args: [], instrumented: true };
}
