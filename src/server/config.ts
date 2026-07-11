import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

/**
 * Read a config env var by its `FLEET_` name, falling back to the legacy
 * `HARNESS_` name so an existing install's environment keeps working after the
 * Fleet Control rename. Prefer setting the `FLEET_` names going forward.
 */
export function envVar(suffix: string): string | undefined {
  return process.env[`FLEET_${suffix}`] ?? process.env[`HARNESS_${suffix}`];
}

/** Port the daemon binds on (loopback only). */
export const PORT = Number(envVar("PORT") ?? 7317);
export const HOST = "127.0.0.1";

/**
 * Where the daemon keeps its state (db, token, logs). Defaults to `~/.fleet-control`,
 * but an existing `~/.ai-harness` (token + db already there) is kept in place so an
 * in-place upgrade never orphans a running install; fresh installs get the new dir.
 */
function resolveStateDir(): string {
  const override = envVar("HOME");
  if (override) return override;
  const preferred = join(homedir(), ".fleet-control");
  const legacy = join(homedir(), ".ai-harness");
  if (!existsSync(preferred) && existsSync(legacy)) return legacy;
  return preferred;
}
export const STATE_DIR = resolveStateDir();
// The db filename stays "harness.db" so an upgraded install keeps its tasks/reviews.
export const DB_PATH = join(STATE_DIR, "harness.db");
export const TOKEN_PATH = join(STATE_DIR, "token");
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
