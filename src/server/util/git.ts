import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface GitInfo {
  branch: string | null;
  /**
   * The worktree root (the dir holding `.git`), resolved through symlinks so it
   * compares equal to git's own `rev-parse --show-toplevel`. Null when the dir
   * isn't in a repo. Lets callers tell "same checkout" from "same branch, other
   * worktree" without shelling out per session.
   */
  root: string | null;
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
  const none: GitInfo = { branch: null, root: null, nomistakesGated: false };
  if (!cwd) return none;
  const found = resolveGitDir(cwd);
  if (!found) return none;
  let head: string;
  try {
    head = readFileSync(join(found.gitDir, "HEAD"), "utf8").trim();
  } catch {
    return none;
  }
  return {
    branch: branchFromHead(head),
    root: realPath(found.root),
    nomistakesGated: hasNoMistakesRemote(commonDir(found.gitDir)),
  };
}

/**
 * Resolve the git directory (where HEAD lives) and the worktree root that holds
 * it, by walking up from a working dir. A normal checkout has a `.git`
 * DIRECTORY; a linked worktree or submodule has a `.git` FILE whose `gitdir:`
 * line points at the real dir - in both cases the dir we found `.git` in is the
 * worktree root.
 */
function resolveGitDir(cwd: string): { gitDir: string; root: string } | null {
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
    if (isDir) return { gitDir: dotGit, root: dir };
    try {
      const m = readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)$/m);
      if (m) {
        const p = m[1]!.trim();
        return { gitDir: isAbsolute(p) ? p : resolve(dir, p), root: dir };
      }
    } catch {
      /* unreadable .git file - fall through */
    }
    return null;
  }
  return null;
}

/** Physical path, so a root compares equal to git's `rev-parse --show-toplevel`. */
function realPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
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
