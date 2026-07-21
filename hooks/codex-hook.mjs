#!/usr/bin/env node
import { captureTerminalEnv } from "../src/shared/harness-runtime.mjs";
import { postHookEvent, readStdin } from "../src/shared/hook-bridge.mjs";
import { opensPullRequest } from "../src/shared/pr-command.mjs";

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
  });
}
main().finally(() => process.exit(0));
