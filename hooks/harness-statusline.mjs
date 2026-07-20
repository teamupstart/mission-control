#!/usr/bin/env node
// Claude Code statusLine forwarder -> Mission Control bridge.
//
// Claude runs the configured statusLine command on every render and pipes a rich
// JSON payload on stdin (model, context window, reasoning effort, thinking). This
// wrapper lifts the fields we care about, POSTs them to the daemon (which is the
// authoritative, live source for the card's model / thinking / context %), and
// then DELEGATES to the user's real status line (ccstatusline by default) so what
// the terminal shows is byte-for-byte unchanged.
//
// Contract: print ONLY the inner command's stdout (Claude renders it verbatim),
// swallow every error, and always exit 0 so the status line never breaks - even
// when the daemon is down or the inner command is missing.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BASE_URL, readToken, stateDir } from "../src/shared/harness-runtime.mjs";
// The payload -> wire-shape normalization, in its own module so it can be tested without
// importing this script (which renders and exits at import time). See statusline-body.mjs.
import { toBody } from "./statusline-body.mjs";

/** Default inner status line when the user hasn't recorded their own. */
const DEFAULT_INNER = "npx -y ccstatusline@latest";

/** Collect all of stdin as a string (the raw payload we also re-feed the inner cmd). */
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

/**
 * The inner status line command to delegate to: an explicit override, else the
 * command the installer recorded when it wrapped the user's existing one, else
 * ccstatusline. Read fresh each render so uninstalling/re-pointing takes effect.
 */
function innerCommand() {
  const override = process.env.MISSION_STATUSLINE_INNER;
  if (override && override.trim()) return override.trim();
  try {
    const recorded = readFileSync(join(stateDir(), "statusline-inner"), "utf8").trim();
    if (recorded) return recorded;
  } catch {
    // none recorded - fall through to the default
  }
  return DEFAULT_INNER;
}

/** Fire-and-forget POST of the reading to the daemon; never throws, self-limits. */
async function post(body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 800);
  try {
    await fetch(`${BASE_URL}/statusline`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-harness-token": readToken() },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch {
    // daemon down/slow - ignore; the passive poller still reads the transcript.
  } finally {
    clearTimeout(timer);
  }
}

/** Run the inner status line with the same stdin, streaming its stdout to ours. */
function runInner(raw) {
  return new Promise((resolve) => {
    let child;
    try {
      // shell:true so an arbitrary recorded command (with args/pipes) runs exactly
      // as Claude would have run it. stdout/stderr inherit -> straight to Claude.
      child = spawn(innerCommand(), { shell: true, stdio: ["pipe", "inherit", "inherit"] });
    } catch {
      return resolve();
    }
    child.on("error", () => resolve());
    child.on("close", () => resolve());
    try {
      child.stdin.on("error", () => {});
      child.stdin.write(raw);
      child.stdin.end();
    } catch {
      // inner command may not read stdin - fine
    }
  });
}

async function main() {
  const raw = await readStdin();
  let payload = {};
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = {};
  }
  // Same rule as harness-hook.mjs: a headless `claude -p` we spawned is our own machinery,
  // not a session on a card. `applyStatusLine` binds by pane and rebinds agentSessionId
  // exactly as `applyHook` does, so a report from a headless run would rotate a real card's
  // note key. A non-interactive run has no status line to render today, which makes this
  // insurance rather than a fix - but it is the same guard and the failure it prevents is
  // silent.
  //
  // Only the REPORT is suppressed, never the delegation: rendering the line is this script's
  // other job and a user-visible one, so a stray marker in an interactive env must not be
  // able to blank someone's status line. This half is ours to skip; that half is theirs.
  const headless = Boolean(process.env.MISSION_HEADLESS);
  // Delegate (renders the terminal line) and report, in parallel; wait for both so
  // Claude has the inner command's full output and the POST had time to land.
  await Promise.all([runInner(raw), headless ? Promise.resolve() : post(toBody(payload))]);
}

main().finally(() => process.exit(0));
