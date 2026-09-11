import { BASE_URL, envVar, readClientToken, MISSION_AGENT_SESSION_ID_ENV } from "@shared/harness-runtime.mjs";
import { postHookEvent } from "@shared/hook-bridge.mjs";
import type { PiApi, PiContext, PiEvent } from "./api.ts";
import { hookBody, PI_EVENTS, statusBody } from "./event-map.ts";
import { McpClient } from "./mcp-client.ts";
import { adaptTool } from "./tool-adapter.ts";

declare const __MISSION_MCP_SERVER__: string;
declare const __MISSION_PI_BUILD__: string;

/** Public build metadata for Phase 6's read-only drift check. No credential is baked. */
export const missionControlBuild = {
  version: typeof __MISSION_PI_BUILD__ === "undefined" ? "source" : __MISSION_PI_BUILD__,
  mcpServerPath: typeof __MISSION_MCP_SERVER__ === "undefined" ? "" : __MISSION_MCP_SERVER__,
};

async function daemonRequest(path: string, body?: unknown): Promise<unknown> {
  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", "x-harness-token": readClientToken() },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(800),
    });
    return response.ok && response.status !== 204 ? await response.json() : null;
  } catch { return null; }
}

export default function missionControl(pi: PiApi): void {
  let client: McpClient | null = null;
  // Registrations belong to the extension, while adapters resolve the current session's
  // client. Pi's registerTool replaces a definition by name and refreshes its tool list;
  // use that update only when the published description or schema actually changes.
  const registeredDefinitions = new Map<string, string>();
  let statusTimestamp = 0;
  const postStatus = async (event: PiEvent, ctx: PiContext) => {
    // Several in-process selections can land in one millisecond. Ingest rejects equal
    // timestamps as stale, so preserve their order without losing the newest selection.
    statusTimestamp = Math.max(Date.now(), statusTimestamp + 1);
    await daemonRequest("/statusline", { ...statusBody(event, ctx), ts: statusTimestamp });
  };
  // Pi's tool_execution_end does not include args. Hold only active bash commands locally;
  // the wire carries PR provenance, never shell text or credentials embedded in it.
  const commands = new Map<string, string>();
  const safe = (fn: (event: PiEvent, ctx: PiContext) => Promise<unknown>) =>
    async (event: PiEvent, ctx: PiContext) => { try { return await fn(event, ctx); } catch { return undefined; } };

  for (const name of Object.keys(PI_EVENTS)) pi.on(name, safe(async (event, ctx) => {
    if (event.type === "session_shutdown") { client?.close(); client = null; commands.clear(); }
    if (event.type === "session_start") {
      client?.close();
      client = null;
      commands.clear();
    }
    if (event.type === "tool_execution_start" && event.toolName === "bash" &&
        event.toolCallId && event.args?.command) {
      commands.set(event.toolCallId, event.args.command);
    }
    const body = hookBody(event, ctx, event.toolCallId ? commands.get(event.toolCallId) : undefined);
    if (event.type === "tool_execution_end" && event.toolCallId) commands.delete(event.toolCallId);
    const decision = body ? await postHookEvent(body) : null;
    if (event.type === "input" && decision?.decision === "block") return { action: "handled" };
    if (body) await postStatus(event, ctx);
    if (event.type === "session_start") {
      const connection = new McpClient(envVar("MCP_SERVER") ?? missionControlBuild.mcpServerPath, {
        cwd: ctx.cwd,
        env: { ...process.env, [MISSION_AGENT_SESSION_ID_ENV]: ctx.sessionManager.getSessionId() },
      });
      client = connection;
      try {
        const tools = await connection.tools();
        if (client !== connection) return;
        for (const tool of tools) {
          const definition = JSON.stringify([tool.description, tool.inputSchema]);
          if (registeredDefinitions.get(tool.name) === definition) continue;
          pi.registerTool(adaptTool(tool, () => client));
          registeredDefinitions.set(tool.name, definition);
        }
      } catch { connection.close(); if (client === connection) client = null; }
    }
  }));
  for (const name of ["model_select", "thinking_level_select", "turn_end"]) pi.on(name, safe(async (event, ctx) => {
    await postStatus(event, ctx);
  }));
  pi.on("before_agent_start", safe(async (event, ctx) => {
    if (event.systemPromptOptions?.appendSystemPrompt) return;
    const query = new URLSearchParams({ repoPath: ctx.cwd, agent: "pi", runtime: "terminal" });
    const delivery = await daemonRequest(`/api/instructions/resolved?${query}`) as { text?: string } | null;
    if (delivery?.text) return { systemPrompt: `${event.systemPrompt ?? ""}\n\n${delivery.text}` };
  }));
}
