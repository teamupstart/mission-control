// The agent-agnostic half of a hook bridge: read the event off stdin, POST it here.
//
// Nothing in this file knows an event name, a payload key or a vendor. That is the point:
// `HookIngest` -> `POST /hooks/:event` -> the registry's pane-keyed overlay was already
// neutral before any of it sat behind an interface (`todo/codex-instrumentation.md`
// reached the same conclusion from the Codex side), so a second agent's bridge is a
// payload mapper plus a `HookSpec` - not a second pipeline.
//
// `.mjs`, and importing only other `.mjs`, because the installed hook command is
// `node <path> <event>` with a bare external node - no tsx, no bundler. The Electron
// build does bundle it (`build:hook`), but the repo install does not, so a `.ts` import
// here would work in the packaged app and fail in every developer's terminal.
//
// Contract with the agent, whichever it is: be fast, write NOTHING to stdout (the agent
// would inject it into the model's context), swallow every error, and always exit 0 so a
// hook never blocks or fails the session - even when the daemon is down.

import { BASE_URL, readClientToken } from "./harness-runtime.mjs";

/** How long to wait for the daemon before giving up on an event. */
const POST_TIMEOUT_MS = 800;

/** How long to wait for the agent to finish writing the payload. */
const STDIN_TIMEOUT_MS = 500;

/** The hook JSON on stdin, or "" when there is none (a TTY, or a slow writer). */
export function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
    setTimeout(() => resolve(data), STDIN_TIMEOUT_MS);
  });
}

/**
 * POST one already-mapped event to the daemon. Never throws and never reports failure:
 * the daemon being down is ordinary (nothing requires it to be running for an agent to
 * work), and the passive poller keeps tracking the session either way.
 */
export async function postHookEvent(body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), POST_TIMEOUT_MS);
  try {
    await fetch(`${BASE_URL}/hooks/${encodeURIComponent(body.event)}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-harness-token": readClientToken() },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch {
    // daemon down or slow - ignore, the poller still tracks the session.
  } finally {
    clearTimeout(timer);
  }
}
