#!/usr/bin/env node
// Claude Code hook -> Fleet Control bridge.
//
// Configured to run for every hook event (the event name is passed as argv[2]).
// It reads the hook JSON on stdin, captures the terminal env that lets the
// daemon bind the event to a discovered session (tmux/wezterm pane ids), and
// POSTs it to the daemon.
//
// Contract with Claude: be fast, write NOTHING to stdout (Claude would inject it
// into the model's context), swallow every error, and always exit 0 so a hook
// never blocks or fails the agent - even when the daemon is down.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PORT = process.env.HARNESS_PORT ?? "7317";
const TOKEN_PATH = process.env.HARNESS_HOME
  ? join(process.env.HARNESS_HOME, "token")
  : join(homedir(), ".ai-harness", "token");

function readToken() {
  try {
    return readFileSync(TOKEN_PATH, "utf8").trim();
  } catch {
    return "";
  }
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
    setTimeout(() => resolve(data), 500);
  });
}

async function main() {
  const event = process.argv[2] || "";
  let payload = {};
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    payload = {};
  }

  const body = {
    event: event || payload.hook_event_name || "",
    sessionId: payload.session_id ?? null,
    cwd: payload.cwd ?? null,
    ts: Date.now(),
    env: {
      tmuxPane: process.env.TMUX_PANE || undefined,
      weztermPane: process.env.WEZTERM_PANE || undefined,
      termProgram: process.env.TERM_PROGRAM || undefined,
    },
    toolName: payload.tool_name,
    prompt: payload.prompt,
    message: payload.message,
    source: payload.source,
    reason: payload.reason,
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 800);
  try {
    await fetch(`http://127.0.0.1:${PORT}/hooks/${encodeURIComponent(body.event)}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-harness-token": readToken() },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch {
    // daemon down or slow - ignore, the poller still tracks the session.
  } finally {
    clearTimeout(timer);
  }
}

main().finally(() => process.exit(0));
