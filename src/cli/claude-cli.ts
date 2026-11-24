import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Finding the `claude` CLI (spec 7.14). One detection function, so `mctl setup`, `mctl doctor`
 * and later `mctl claude` agree on which binary they mean.
 *
 * Order: `MISSION_CLAUDE_BIN` (authoritative: when it is set and fails, nothing else is tried,
 * so a typo is reported rather than silently replaced), then every `PATH` entry, then the
 * places Claude Code installs itself. A candidate is accepted only when `claude --version` runs
 * and `claude plugin --help` lists `marketplace`: an older Claude Code has no plugin
 * marketplaces and cannot install the mod.
 */

export interface ExecResult {
  /** The exit code; -1 when the program could not be started or timed out. */
  code: number;
  stdout: string;
  stderr: string;
}

export type Exec = (file: string, args: readonly string[], options?: { cwd?: string; timeoutMs?: number }) => Promise<ExecResult>;

/** Runs a program without a shell. A start failure is a result, never a throw. */
export const realExec: Exec = (file, args, options = {}) =>
  new Promise((resolve) => {
    execFile(file, [...args], { cwd: options.cwd, timeout: options.timeoutMs ?? 30_000, encoding: "utf8" }, (error, stdout, stderr) => {
      if (!error) return resolve({ code: 0, stdout, stderr });
      const code = typeof error.code === "number" ? error.code : -1;
      resolve({ code, stdout: stdout ?? "", stderr: stderr || error.message });
    });
  });

export interface ClaudeCli {
  path: string;
  version: string;
  source: "MISSION_CLAUDE_BIN" | "PATH" | "known place";
}

export interface ClaudeSearch {
  claude: ClaudeCli | null;
  /** Each candidate that was tried and why it was refused, for the doctor message. */
  rejected: string[];
}

export interface ClaudeSearchDeps {
  env: Readonly<Record<string, string | undefined>>;
  exec: Exec;
  /** The user's home directory when `env.HOME` is unset, so the known places are still searched. */
  home?: string;
  /** Whether a path is an executable file. Defaults to an `access(X_OK)` check. */
  executable?: (path: string) => boolean;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The places Claude Code puts itself that are often missing from a GUI-launched `PATH`. */
export function knownClaudePlaces(home: string | undefined): string[] {
  const places = ["/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
  if (home) places.unshift(join(home, ".claude", "local", "claude"), join(home, ".local", "bin", "claude"), join(home, ".npm-global", "bin", "claude"));
  return places;
}

async function probe(path: string, exec: Exec): Promise<{ ok: true; version: string } | { ok: false; reason: string }> {
  const version = await exec(path, ["--version"], { timeoutMs: 15_000 });
  if (version.code !== 0) return { ok: false, reason: path + ": `--version` failed (" + (version.stderr.trim() || "exit " + version.code) + ")" };
  const help = await exec(path, ["plugin", "--help"], { timeoutMs: 15_000 });
  if (help.code !== 0 || !/marketplace/i.test(help.stdout + help.stderr)) {
    return { ok: false, reason: path + ": this Claude Code has no `plugin marketplace` command; update it" };
  }
  return { ok: true, version: /(\d+\.\d+\.\d+)/.exec(version.stdout)?.[1] ?? version.stdout.trim() };
}

export async function findClaude(deps: ClaudeSearchDeps): Promise<ClaudeSearch> {
  const executable = deps.executable ?? isExecutable;
  const rejected: string[] = [];
  const explicit = deps.env.MISSION_CLAUDE_BIN?.trim();
  const candidates: { path: string; source: ClaudeCli["source"] }[] = [];
  if (explicit) {
    candidates.push({ path: explicit, source: "MISSION_CLAUDE_BIN" });
  } else {
    for (const dir of (deps.env.PATH ?? "").split(delimiter).filter(Boolean)) candidates.push({ path: join(dir, "claude"), source: "PATH" });
    for (const path of knownClaudePlaces(deps.env.HOME ?? deps.home)) candidates.push({ path, source: "known place" });
  }
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.path)) continue;
    seen.add(candidate.path);
    // An explicit override is probed even when the check cannot see it, so the failure names it.
    if (candidate.source !== "MISSION_CLAUDE_BIN" && !executable(candidate.path)) continue;
    const result = await probe(candidate.path, deps.exec);
    if (result.ok) return { claude: { ...candidate, version: result.version }, rejected };
    rejected.push(result.reason);
  }
  return { claude: null, rejected };
}
