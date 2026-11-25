import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { EXECUTABLE_SPECS } from "../server/executables/catalog.ts";
import { ExecutableLocator } from "../server/executables/locator.ts";

export interface ClaudeCli {
  path: string;
  version: string;
  run: (args: readonly string[], cwd?: string) => Promise<string>;
}

/** No shell, prompts or model calls; every diagnostic subprocess has a deadline and output bound. */
function runClaude(executable: string, args: readonly string[], env: NodeJS.ProcessEnv, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, [...args], { env, cwd, timeout: 15_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(stdout.trim());
    });
  });
}

/** Operator override, inherited PATH, then supported native/npm locations. An override is authoritative. */
export async function detectClaude(env: NodeJS.ProcessEnv, cwd: string): Promise<ClaudeCli | null> {
  const locator = new ExecutableLocator({ env: { ...env }, probeLoginShell: async () => ({ path: env.PATH ?? "", problem: null }) });
  const spec = EXECUTABLE_SPECS.claude;
  // resolveCommand's explicit child PATH avoids the daemon locator's automatic per-user
  // toolchain ranking, which would put ~/.local/bin ahead of this CLI's documented order.
  const first = await locator.resolveCommand(spec.command, { env: { ...env, PATH: env.PATH ?? "" }, cwd });
  const overridden = ["MISSION_CLAUDE_BIN", "FLEET_CLAUDE_BIN", "HARNESS_CLAUDE_BIN", ...spec.legacyEnv].some((key) => env[key]?.trim());
  const home = env.HOME || homedir();
  const paths = [...new Set([
    ...(first ? [first.path] : []),
    ...(!overridden ? [join(home, ".claude/local/claude"), join(home, ".local/bin/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"] : []),
  ])];
  for (const path of paths) {
    // Resolve explicit locations through the same executable registry checks as PATH.
    const found = await locator.resolveCommand(path, { env, cwd });
    if (!found) continue;
    const run = (args: readonly string[], dir = cwd) => runClaude(found.path, args, found.env, dir);
    try {
      const version = await run(["--version"]);
      if (!version || !/\bmarketplace\b/.test(await run(["plugin", "--help"]))) continue;
      return { path: found.path, version, run };
    } catch { /* A stale executable is not a usable Claude installation. */ }
  }
  return null;
}
