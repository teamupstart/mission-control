// The pure half of the statusLine forwarder: raw Claude payload -> the daemon's flat
// wire shape. No I/O, no process exit, no delegation.
//
// Split out of harness-statusline.mjs so it can be TESTED. That script's job is to render
// a terminal line and then exit 0 no matter what, so it calls `main()` at import time and
// hangs a `process.exit` off it - importing it from a test would take the test runner down
// with it. The normalization is the part with rules worth pinning (which fields are lifted,
// what an absent one means), so it lives here and the script stays a thin shell.
//
// Plain .mjs for the same reason its caller is: bare `node` runs this at status-line render
// time, with no build step in the way.

import { captureTerminalEnv } from "../src/shared/harness-runtime.mjs";

/** Effort levels the daemon accepts; anything else is dropped (schema is strict). */
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function numOrUndef(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * One rate-limit window, normalized - or null when the payload didn't carry it.
 *
 * Null rather than a zeroed window, because 0% used is a real and very different claim
 * from "we were not told". The daemon renders nothing for null and a full-width empty
 * meter for 0, and only one of those is honest about an API-key user.
 */
function rateLimitWindow(w) {
  if (!w || typeof w !== "object") return null;
  return { usedPercentage: num(w.used_percentage), resetsAt: num(w.resets_at) };
}

/** Normalize the raw Claude statusLine payload into the daemon's flat wire shape. */
export function toBody(payload, now = Date.now()) {
  const model =
    payload.model && typeof payload.model === "object"
      ? { id: payload.model.id, displayName: payload.model.display_name }
      : typeof payload.model === "string"
        ? { id: payload.model }
        : undefined;

  const cw = payload.context_window;
  let contextWindow;
  if (cw && typeof cw === "object") {
    const cu = cw.current_usage;
    const tokens =
      cu && typeof cu === "object"
        ? num(cu.input_tokens) + num(cu.cache_read_input_tokens) + num(cu.cache_creation_input_tokens)
        : 0;
    contextWindow = {
      usedPercentage: numOrUndef(cw.used_percentage),
      contextWindowSize: numOrUndef(cw.context_window_size),
      tokens: tokens > 0 ? tokens : undefined,
    };
  }

  const level = payload.effort && typeof payload.effort === "object" ? payload.effort.level : undefined;
  const effort = typeof level === "string" && EFFORTS.has(level) ? level : undefined;

  // The subscription's rate-limit windows - the ONE cost fact OpenTelemetry cannot
  // supply (it has no quota metric), and so the reason this wrapper is part of the cost
  // design at all. Cost itself is deliberately NOT taken from this payload even when it
  // carries one: OTel owns the dollars, and one source per fact is what stops two
  // numbers disagreeing on screen.
  //
  // Absent for an API-key user, and absent for a Pro/Max session until its first API
  // response - so the whole key drops out of the JSON rather than reporting zeros. The
  // daemon reads a missing key as "unknown" and renders no meter, which is the honest
  // shape of not knowing.
  const rl = payload.rate_limits;
  const rateLimits =
    rl && typeof rl === "object"
      ? { fiveHour: rateLimitWindow(rl.five_hour), sevenDay: rateLimitWindow(rl.seven_day) }
      : undefined;

  return {
    sessionId: payload.session_id ?? null,
    cwd: payload.cwd ?? payload.workspace?.current_dir ?? null,
    ts: now,
    env: captureTerminalEnv(),
    model,
    contextWindow,
    effort,
    thinkingEnabled:
      payload.thinking && typeof payload.thinking.enabled === "boolean" ? payload.thinking.enabled : undefined,
    rateLimits,
  };
}
