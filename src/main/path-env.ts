// Resolve the user's real login-shell PATH.
//
// A GUI app launched from Finder/Dock inherits a minimal PATH
// (/usr/bin:/bin:/usr/sbin:/sbin). `git` and `ps` are there, but `tmux`,
// `wezterm`, `no-mistakes`, and `treehouse` usually live in ~/.local/bin,
// /opt/homebrew/bin, or a Go bin dir - so without this the daemon's discovery
// and dispatch would silently fail. We ask the login shell for its PATH (the
// same trick VS Code's `fix-path` uses) and union it with the well-known tool
// dirs as a backstop. Mirrors what scripts/install-service.mjs hardcodes for the
// LaunchAgent, done for real.

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";

let cached: string | null = null;

/** Well-known dirs that must always be present even if the shell probe fails. */
function fallbackDirs(): string[] {
  const home = homedir();
  return [
    `${home}/.local/bin`,
    `${home}/go/bin`,
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
}

/** Union two PATH strings, preserving order and dropping empties/dupes. */
function mergePath(primary: string, extra: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of [...primary.split(":"), ...extra]) {
    const dir = p.trim();
    if (dir && !seen.has(dir)) {
      seen.add(dir);
      out.push(dir);
    }
  }
  return out.join(":");
}

/**
 * The login-shell PATH, unioned with the fallback dirs. Cached (the login shell
 * probe is relatively expensive and the PATH doesn't change while we run).
 */
export function loginShellPath(): string {
  if (cached) return cached;
  const shell = process.env.SHELL || "/bin/zsh";
  const marker = "__MISSION_PATH__";
  try {
    // `-ilc`: interactive login shell so rc files that set PATH (.zshrc,
    // .zprofile, …) are sourced. The marker lets us pluck PATH out of any rc
    // banner noise; stdin is ignored so an interactive shell can't hang on read.
    const out = execFileSync(shell, ["-ilc", `printf '${marker}%s${marker}' "$PATH"`], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const m = out.match(new RegExp(`${marker}(.*)${marker}`));
    const resolved = m?.[1]?.trim();
    if (resolved) {
      cached = mergePath(resolved, fallbackDirs());
      return cached;
    }
  } catch {
    /* shell missing / probe timed out - fall through to the current PATH + fallbacks */
  }
  cached = mergePath(process.env.PATH ?? "", fallbackDirs());
  return cached;
}
