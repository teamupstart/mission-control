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

import { BASE_URL, captureTerminalEnv, readToken } from "../src/shared/harness-runtime.mjs";

// A GitHub PR URL as printed by `gh pr create` / `gh pr view`. Scoped to a real
// pull path so a repo or compare link never masquerades as a PR.
const PR_URL_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;

/**
 * Sniff a PR URL out of a PostToolUse payload. `gh pr create` prints the new
 * PR's URL on stdout, which Claude hands back in `tool_response`. Scoped to Bash
 * results so merely reading a PR page (WebFetch/Read of a pull URL) can't flash a
 * false chip; even if one slips through, the PR poller clears it within a tick
 * because the link won't match the session's branch. Returns undefined when
 * there's nothing to report - the common case, kept cheap.
 */
function sniffPrUrl(payload) {
  const event = payload.hook_event_name ?? process.argv[2] ?? "";
  if (event !== "PostToolUse") return undefined;
  if (payload.tool_name && payload.tool_name !== "Bash") return undefined;
  const field = payload.tool_response;
  if (field == null) return undefined;
  const text = typeof field === "string" ? field : JSON.stringify(field);
  const m = PR_URL_RE.exec(text);
  return m ? m[0] : undefined;
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
    transcriptPath: payload.transcript_path ?? null,
    ts: Date.now(),
    env: captureTerminalEnv(),
    toolName: payload.tool_name,
    prompt: payload.prompt,
    message: payload.message,
    source: payload.source,
    reason: payload.reason,
    // Claude's current permission mode (the Shift+Tab state), present on most
    // hook events. Undefined on events that omit it - the daemon keeps the last
    // known mode rather than clearing it.
    permissionMode: payload.permission_mode,
    prUrl: sniffPrUrl(payload),
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 800);
  try {
    await fetch(`${BASE_URL}/hooks/${encodeURIComponent(body.event)}`, {
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
