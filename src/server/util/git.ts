import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

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
 *
 * Handles linked worktrees (and submodules), where `.git` is a FILE pointing at
 * the real git dir (`gitdir: <path>`) and shared config lives in the commondir -
 * without this, agents in a dispatched worktree show no branch and never gate.
 */
export function gitInfo(cwd: string | null): GitInfo {
  const none: GitInfo = { branch: null, nomistakesGated: false };
  if (!cwd) return none;
  const gitDir = resolveGitDir(cwd);
  if (!gitDir) return none;
  let head: string;
  try {
    head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
  } catch {
    return none;
  }
  return {
    branch: branchFromHead(head),
    nomistakesGated: hasNoMistakesRemote(commonDir(gitDir)),
  };
}

/**
 * Resolve the git directory (where HEAD lives) for a working dir by walking up
 * to the repo root. A normal checkout has a `.git` DIRECTORY; a linked worktree
 * or submodule has a `.git` FILE whose `gitdir:` line points at the real dir.
 */
function resolveGitDir(cwd: string): string | null {
  let dir = cwd;
  for (let i = 0; i < 40; i++) {
    const dotGit = join(dir, ".git");
    let isDir: boolean;
    try {
      isDir = statSync(dotGit).isDirectory();
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
      continue;
    }
    if (isDir) return dotGit;
    try {
      const m = readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)$/m);
      if (m) {
        const p = m[1]!.trim();
        return isAbsolute(p) ? p : resolve(dir, p);
      }
    } catch {
      /* unreadable .git file - fall through */
    }
    return null;
  }
  return null;
}

/**
 * The common git dir (shared config/remotes) for a git dir. A linked worktree's
 * git dir has a `commondir` pointer to the main repo's git dir; without one, the
 * git dir is itself the common dir.
 */
function commonDir(gitDir: string): string {
  try {
    const rel = readFileSync(join(gitDir, "commondir"), "utf8").trim();
    return isAbsolute(rel) ? rel : resolve(gitDir, rel);
  } catch {
    return gitDir;
  }
}

function branchFromHead(head: string): string | null {
  const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
  if (ref) return ref[1] ?? null;
  if (/^[0-9a-f]{7,40}$/.test(head)) return head.slice(0, 8);
  return null;
}

function hasNoMistakesRemote(gitDir: string): boolean {
  try {
    const cfg = readFileSync(join(gitDir, "config"), "utf8");
    return /\[remote "no-mistakes"\]/.test(cfg) || cfg.includes("/.no-mistakes/repos/");
  } catch {
    return false;
  }
}
