import { join } from "node:path";
import { existsSync } from "node:fs";
import { HOST, PORT, envVar, stateDir, tokenPath } from "../shared/harness-runtime.mjs";

/** Runtime coordinates and the `FLEET_`/legacy env resolution live in the shared
 * runtime module so the daemon, the MCP bridge, and the hook can never disagree.
 * Re-exported here so the rest of the server keeps importing them from config. */
export { HOST, PORT, envVar };

/** Where the daemon keeps its state (db, token, logs). */
export const STATE_DIR = stateDir();
// The db filename stays "harness.db" so an upgraded install keeps its tasks/reviews.
export const DB_PATH = join(STATE_DIR, "harness.db");
export const TOKEN_PATH = tokenPath();
/** Isolated worktrees the daemon creates for dispatched tasks (git-worktree fallback). */
export const WORKTREES_DIR = join(STATE_DIR, "worktrees");

/** Resolve the CLI to launch for a dispatched agent, overridable per agent. */
export function resolveAgentBin(agent: "claude" | "codex"): string {
  if (agent === "claude") return envVar("CLAUDE_BIN") ?? "claude";
  return envVar("CODEX_BIN") ?? "codex";
}

/** How often the passive discovery poller sweeps the system. */
export const POLL_INTERVAL_MS = Number(envVar("POLL_MS") ?? 1500);

/**
 * Resolve the wezterm CLI. It's usually on PATH, but on macOS it ships inside
 * the app bundle and is often not linked, so fall back to the known location.
 */
export function resolveWeztermBin(): string {
  if (process.env.WEZTERM_BIN) return process.env.WEZTERM_BIN;
  const bundled = "/Applications/WezTerm.app/Contents/MacOS/wezterm";
  if (existsSync(bundled)) return bundled;
  return "wezterm"; // hope it's on PATH
}
