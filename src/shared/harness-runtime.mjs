// Single source of truth for the daemon's runtime coordinates - port, host, and
// the state-dir/token paths - plus the harness's lease identity and the tiny client
// helpers the hook and the MCP bridge both need to reach the daemon.
//
// This is plain JavaScript (.mjs) on purpose: the Claude hook (hooks/harness-hook.mjs)
// runs under bare `node` at hook-invocation time with no build step, so it cannot
// import the TypeScript config. Every consumer - the daemon (via src/server/config.ts),
// the MCP bridge (src/mcp/server.ts, bundled by esbuild), the hook, the service
// installer, scripts/new-session.mjs, and vite.config.ts - imports this file so the
// port, token path, and lease holder can never drift. A drift here fails silently
// (the hook swallows fetch errors; a mismatched lease holder just stops the reaper
// from ever matching), which is exactly why these must live in one place. A .d.mts
// alongside gives the TS side types.

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Read a config env var by its `FLEET_` name, falling back to the legacy
 * `HARNESS_` name so an existing install's environment keeps working after the
 * Fleet Control rename. Prefer setting the `FLEET_` names going forward.
 */
export function envVar(suffix) {
  return process.env[`FLEET_${suffix}`] ?? process.env[`HARNESS_${suffix}`];
}

/** Port the daemon binds on (loopback only). */
export const PORT = Number(envVar("PORT") ?? 7317);

/** Loopback host the daemon binds to. */
export const HOST = "127.0.0.1";

/** Base URL clients use to reach the daemon. */
export const BASE_URL = `http://${HOST}:${PORT}`;

/**
 * The holder this harness records on every treehouse lease it takes, and the only
 * one its leak sweep will ever hand back.
 *
 * It lives here, on the shared surface, because the code that TAKES a lease spans
 * the build boundary - `scripts/new-session.mjs` runs under bare `node`, the
 * dispatcher is TypeScript - while the code that decides a lease may be RETURNED
 * (the reap gate in src/server/pool.ts) is a third site again. All three have to
 * agree on this string, and disagreement is silent either way: a lease site that
 * drifts stamps a label the gate reads as a stranger's, so the abandoned leases the
 * sweep exists to collect become permanently uncollectable with no error; a gate
 * that drifts points at leases we never took. One import, no drift.
 */
export const LEASE_HOLDER = "fleet-control";

/**
 * Where the daemon keeps its state (db, token, logs). Defaults to `~/.fleet-control`,
 * but an existing `~/.ai-harness` (token + db already there) is kept in place so an
 * in-place upgrade never orphans a running install; fresh installs get the new dir.
 */
export function stateDir() {
  const override = envVar("HOME");
  if (override) return override;
  const preferred = join(homedir(), ".fleet-control");
  const legacy = join(homedir(), ".ai-harness");
  if (!existsSync(preferred) && existsSync(legacy)) return legacy;
  return preferred;
}

/** Path to the shared auth token the daemon writes and clients present. */
export function tokenPath() {
  return join(stateDir(), "token");
}

/** Read the daemon auth token, or "" when it isn't present yet. */
export function readToken() {
  try {
    return readFileSync(tokenPath(), "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * Capture the terminal env the daemon uses to bind an event to a discovered
 * session (tmux/wezterm pane ids). Values are `undefined` when unset so they
 * drop out of JSON rather than serializing as empty strings.
 */
export function captureTerminalEnv() {
  return {
    tmuxPane: process.env.TMUX_PANE || undefined,
    weztermPane: process.env.WEZTERM_PANE || undefined,
    termProgram: process.env.TERM_PROGRAM || undefined,
  };
}
