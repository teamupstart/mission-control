import { join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
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

/**
 * The skills catalog (`skills/<id>/SKILL.md`), baked into the repo and shipped with
 * the app - resolved absolutely, so it never depends on the daemon's working
 * directory (unpredictable when Electron spawns it).
 *
 * `../../skills` lands on the repo root under `tsx src/server/index.ts` AND on the app
 * root under `node dist/server/index.mjs`, exactly like index.ts's `FLEET_WEB_DIR`
 * fallback and for the same reason: both entry points sit two levels down.
 *
 * WHICH IS WHY THIS LIVES HERE and not beside its callers in skills/. esbuild bundles
 * the whole server into `dist/server/index.mjs`, so every bundled module's
 * `import.meta.url` becomes that ONE file's - and only a module that already sits two
 * levels down in the source tree resolves the same before and after bundling.
 * `skills/catalog.ts` is three levels down, so the identical expression there is
 * correct packaged and points at a nonexistent `src/skills` in dev.
 *
 * The symlinks this feeds read fine from a packaged build: the app ships `asar: false`
 * (see electron-builder.yml), so these are real directories on disk. That was the
 * plan's one open question, and it was already answered - the satellites need plain
 * files for the same reason. If asar is ever turned back on, the reconciler has to
 * copy and compare a content hash instead; nothing about the symlink path survives it.
 */
export function skillsDir(): string {
  return envVar("SKILLS_DIR") ?? fileURLToPath(new URL("../../skills", import.meta.url));
}

/** Resolve the CLI to launch for a dispatched agent, overridable per agent. */
export function resolveAgentBin(agent: "claude" | "codex"): string {
  if (agent === "claude") return envVar("CLAUDE_BIN") ?? "claude";
  return envVar("CODEX_BIN") ?? "codex";
}

/** How often the passive discovery poller sweeps the system. */
export const POLL_INTERVAL_MS = Number(envVar("POLL_MS") ?? 1500);

/**
 * How often the PR poller asks `gh` whether each feature-branch session has an
 * open PR. PR creation and merge are rare relative to the process sweep, so this
 * runs far slower to keep `gh` calls negligible.
 */
export const PR_POLL_MS = Number(envVar("PR_POLL_MS") ?? 20_000);

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
