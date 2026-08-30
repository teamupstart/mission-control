// Resolve the user's real login-shell PATH.
//
// A GUI app launched from Finder/Dock and a LaunchAgent both inherit a minimal or fixed
// PATH. Version managers can also move a CLI after the daemon starts. Ask the login shell
// for its current PATH and union it with well-known tool directories as a backstop.

import { execFile, execFileSync } from "node:child_process";
import { homedir } from "node:os";

let cached: string | null = null;
let refreshedAt = 0;
let refreshInFlight: Promise<string> | null = null;

/** Missing commands share this negative-cache window instead of repeatedly sourcing rc files. */
export const LOGIN_SHELL_PATH_REFRESH_COOLDOWN_MS = 30_000;

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
 * The login-shell PATH, unioned with the fallback dirs.
 *
 * Synchronous for the Electron main process, which needs the PATH before it can fork the
 * daemon. Daemon-side refreshes use `refreshLoginShellPath` so shell startup never blocks
 * session traffic.
 */
export function loginShellPath(): string {
  if (cached) return cached;
  const shell = process.env.SHELL || "/bin/zsh";
  const marker = "__MISSION_PATH__";
  try {
    // `-ilc`: interactive login shell so rc files that set PATH (.zshrc,
    // .zprofile, etc.) are sourced. The marker lets us pluck PATH out of any rc
    // banner noise; stdin is ignored so an interactive shell cannot hang on read.
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

/**
 * Read the current login-shell PATH without blocking the daemon's event loop.
 *
 * Concurrent callers share one subprocess. Persistently missing commands reuse its result
 * for a bounded cooldown, while an explicit Setup inspection can force one new shared read
 * so Re-check sees a just-installed version-manager binary immediately.
 */
export function refreshLoginShellPath(
  options: { force?: boolean } = {},
): Promise<string> {
  const now = Date.now();
  if (!options.force && cached && now - refreshedAt < LOGIN_SHELL_PATH_REFRESH_COOLDOWN_MS) {
    return Promise.resolve(cached);
  }
  if (refreshInFlight) return refreshInFlight;

  const shell = process.env.SHELL || "/bin/zsh";
  const marker = "__MISSION_PATH__";
  const pending = new Promise<string>((resolve) => {
    const finish = (stdout: string | null): void => {
      const m = stdout?.match(new RegExp(`${marker}(.*)${marker}`));
      const resolved = m?.[1]?.trim();
      cached = mergePath(resolved || process.env.PATH || "", fallbackDirs());
      refreshedAt = Date.now();
      resolve(cached);
    };
    try {
      execFile(
        shell,
        ["-ilc", `printf '${marker}%s${marker}' "$PATH"`],
        {
          encoding: "utf8",
          timeout: 5000,
          env: process.env,
        },
        (error, stdout) => finish(error ? null : stdout),
      );
    } catch {
      finish(null);
    }
  }).finally(() => {
    refreshInFlight = null;
  });
  refreshInFlight = pending;
  return pending;
}
