#!/usr/bin/env node
import { captureTerminalEnv } from "../src/shared/harness-runtime.mjs";
import { postHookEvent, readStdin } from "../src/shared/hook-bridge.mjs";
import { opensPullRequest } from "../src/shared/pr-command.mjs";
import { hookText } from "../src/shared/hook-subagents.mjs";

/**
 * Codex's own sub-agent lifecycle events. Only these forward `agent_id`: on them it names the
 * child that started or stopped, which is what a terminal session's background agents are read
 * from, and the daemon keeps a hook carrying it from moving the parent's state. Codex's schema
 * also allows `agent_id` on its other events, but what it means there is not pinned down, so
 * those keep reaching the parent exactly as they did.
 */
const SUBAGENT_EVENTS = new Set(["SubagentStart", "SubagentStop"]);

async function main() {
  let payload = {};
  try { payload = JSON.parse(await readStdin()); } catch { /* empty hook payload */ }
  const event = process.argv[2] || payload.hook_event_name || payload.event || "";
  const input = payload.tool_input ?? payload.input;
  const command = input?.command ?? (typeof input === "string" ? input : undefined);
  await postHookEvent({
    agent: "codex", event,
    sessionId: payload.session_id ?? payload.sessionId ?? null,
    cwd: payload.cwd ?? null,
    transcriptPath: payload.transcript_path ?? payload.transcriptPath ?? null,
    ts: Date.now(), env: captureTerminalEnv(),
    toolName: payload.tool_name ?? payload.toolName,
    prompt: payload.prompt,
    message: payload.message,
    source: payload.source,
    reason: payload.reason,
    prCreated: opensPullRequest(command) ? true : undefined,
    agentId: SUBAGENT_EVENTS.has(event) ? hookText(payload.agent_id) : undefined,
    agentType: SUBAGENT_EVENTS.has(event) ? hookText(payload.agent_type) : undefined,
  });
}
main().finally(() => process.exit(0));
