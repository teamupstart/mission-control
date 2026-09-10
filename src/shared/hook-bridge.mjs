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
// Contract with the agent, whichever it is: be fast, swallow every error, and always exit 0.
// Write nothing to stdout except a decision the daemon explicitly asked for - anything else
// would be injected into the model's context - and never let the daemon being slow, down or
// unintelligible block a session.
//
// That last clause used to read "a hook never blocks", full stop, and the one exception now
// carved out of it is deliberate and narrow. `POST /hooks/:event` may answer a
// `UserPromptSubmit` with a block decision, which is how Mission Control stops a prompt from
// starting a turn on a session it has already concluded and is closing. It is FAIL-OPEN in
// every direction: no answer, a slow answer, a non-JSON answer, a 204, or any error at all
// means the prompt goes ahead exactly as it always did. Only an explicit, well-formed refusal
// stops one, and the daemon only ever issues one for a session its durable closure ledger
// says is owed a close.

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
 * POST one already-mapped event to the daemon, and hand back its decision if it sent one.
 *
 * Never throws and never reports failure: the daemon being down is ordinary (nothing requires
 * it to be running for an agent to work), and the passive poller keeps tracking the session
 * either way.
 *
 * Returns `null` for every ordinary event - a 204, no daemon, a timeout, a body that will not
 * parse - and an object only when the daemon deliberately answered with one. Callers treat
 * `null` as "carry on", so every failure mode lands on the permissive side by construction
 * rather than by remembering to check.
 */
export async function postHookEvent(body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), POST_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}/hooks/${encodeURIComponent(body.event)}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-harness-token": readClientToken() },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (res.status === 204 || !res.ok) return null;
    const text = await res.text();
    if (!text) return null;
    const decision = JSON.parse(text);
    // An array is JSON and an object, and it is not a decision. Spelled out rather than left
    // to `typeof`, because everything unrecognised has to land on "carry on" by construction.
    if (!decision || typeof decision !== "object" || Array.isArray(decision)) return null;
    return decision;
  } catch {
    // daemon down, slow, or talking nonsense - ignore, the poller still tracks the session.
    return null;
  } finally {
    clearTimeout(timer);
  }
}
