// The fake supplies Pi's event API; Mission's BUILT extension owns every POST and MCP call.
import { appendFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

export async function runExtensionSession() {
  const handlers = new Map();
  const tools = new Map();
  const sessionId = randomUUID();
  const transcript = join(process.env.PI_CODING_AGENT_DIR, `${sessionId}.jsonl`);
  const context = {
    cwd: process.cwd(), model: { id: "pi-probe", name: "Pi Probe" }, thinkingLevel: "high",
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => transcript },
    getContextUsage: () => ({ tokens: 25000, contextWindow: 100000, percent: 25 }),
  };
  writeFileSync(transcript, JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: process.cwd() }) + "\n");
  const { default: extension } = await import(pathToFileURL(process.env.MC_E2E_PI_EXTENSION).href);
  extension({ on: (name, handler) => handlers.set(name, handler), registerTool: (tool) => tools.set(tool.name, tool) });
  const emit = async (type, fields = {}) => handlers.get(type)?.({ type, ...fields }, context);
  await emit("session_start", { reason: "startup" });
  console.log("PI_EXTENSION_READY");
  createInterface({ input: process.stdin }).on("line", async (text) => {
    if (text === "minimal" || text === "off") {
      context.thinkingLevel = text;
      await emit("thinking_level_select", { level: text }); return;
    }
    await emit("input", { source: "interactive", text });
    await emit("tool_execution_start", { toolName: "request_input", toolCallId: "ask" });
    const result = await tools.get("request_input").execute("ask", { question: "Pi extension proof: continue?", options: [{ label: "Continue" }] });
    appendFileSync(transcript, JSON.stringify({ type: "message", id: "answer", timestamp: new Date().toISOString(), message: {
      role: "assistant", model: "pi-probe", provider: "mission-test", content: [{ type: "text", text: "Proof complete" }], stopReason: "stop",
      usage: { input: 25000, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0.025 } },
    } }) + "\n");
    await emit("tool_execution_end", { toolName: "request_input", toolCallId: "ask", result });
    await emit("turn_end");
    await emit("agent_end");
    await emit("agent_settled");
    console.log("PI_EXTENSION_RESUMED " + JSON.stringify(result));
  });
  process.on("SIGTERM", async () => { await emit("session_shutdown", { reason: "quit" }); process.exit(0); });
}
