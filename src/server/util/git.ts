import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface GitInfo {
  branch: string | null;
  /** True when the repo is gated by no-mistakes (has a `no-mistakes` remote). */
  nomistakesGated: boolean;
}

/**
 * Read git info for a directory by walking up to the repo root - pure
 * filesystem, no subprocess, cheap enough to run for every session every poll.
 * Returns the branch (or short SHA when detached) and whether the repo is gated
 * by no-mistakes (surfacing the component the harness runs alongside).
 */
export function gitInfo(cwd: string | null): GitInfo {
  const none: GitInfo = { branch: null, nomistakesGated: false };
  if (!cwd) return none;
  let dir = cwd;
  for (let i = 0; i < 40; i++) {
    let head: string;
    try {
      head = readFileSync(join(dir, ".git", "HEAD"), "utf8").trim();
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return none;
      dir = parent;
      continue;
    }
    return { branch: branchFromHead(head), nomistakesGated: hasNoMistakesRemote(dir) };
  }
  return none;
}

function branchFromHead(head: string): string | null {
  const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
  if (ref) return ref[1] ?? null;
  if (/^[0-9a-f]{7,40}$/.test(head)) return head.slice(0, 8);
  return null;
}

function hasNoMistakesRemote(gitDir: string): boolean {
  try {
    const cfg = readFileSync(join(gitDir, ".git", "config"), "utf8");
    return /\[remote "no-mistakes"\]/.test(cfg) || cfg.includes("/.no-mistakes/repos/");
  } catch {
    return false;
  }
}
