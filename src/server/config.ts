import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

/** Port the daemon binds on (loopback only). */
export const PORT = Number(process.env.HARNESS_PORT ?? 7317);
export const HOST = "127.0.0.1";

/** Where the daemon keeps its state (db, token, logs). */
export const STATE_DIR = process.env.HARNESS_HOME ?? join(homedir(), ".ai-harness");
export const DB_PATH = join(STATE_DIR, "harness.db");
export const TOKEN_PATH = join(STATE_DIR, "token");
/** Isolated worktrees the daemon creates for dispatched tasks (git-worktree fallback). */
export const WORKTREES_DIR = join(STATE_DIR, "worktrees");

/** Resolve the CLI to launch for a dispatched agent, overridable per agent. */
export function resolveAgentBin(agent: "claude" | "codex"): string {
  if (agent === "claude") return process.env.HARNESS_CLAUDE_BIN ?? "claude";
  return process.env.HARNESS_CODEX_BIN ?? "codex";
}

/** How often the passive discovery poller sweeps the system. */
export const POLL_INTERVAL_MS = Number(process.env.HARNESS_POLL_MS ?? 1500);

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
