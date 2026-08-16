import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { WORKTREE_POOLS_DIR } from "../config.ts";

export interface GitInfo {
  branch: string | null;
  /**
   * The worktree root (the dir holding `.git`), resolved through symlinks so it
   * compares equal to git's own `rev-parse --show-toplevel`. Null when the dir
   * isn't in a repo. Lets callers tell "same checkout" from "same branch, other
   * worktree" without shelling out per session.
   */
  root: string | null;
  /**
   * The root of the repo every linked worktree of this checkout SHARES - i.e. the
   * main checkout, derived from the common git dir. Equals `root` for a normal
   * checkout; for a linked worktree it points back at the main repo instead of at
   * the worktree's own throwaway directory. Null when the dir isn't in a repo.
   *
   * Exists so identity questions ("is this the ai-harness repo?") stop being asked
   * as location questions ("is this path under the ai-harness directory?"). A
   * worktree of an allowlisted repo lives nowhere near it on disk - under
   * `~/.treehouse/...` or the daemon's own worktrees dir - so a path prefix says
   * "no" about the very repo the user allowlisted. `repoRoot` is what makes
   * Foreman's allowlist mean the repo rather than the directory.
   */
  repoRoot: string | null;
}

/**
 * Read git info for a directory by walking up to the repo root - pure
 * filesystem, no subprocess, cheap enough to run for every session every poll.
 * Returns the branch (or null when detached) and the checkout/repository roots.
 *
 * Handles linked worktrees (and submodules), where `.git` is a FILE pointing at
 * the real git dir (`gitdir: <path>`) and shared config lives in the commondir -
 * without this, agents in a dispatched worktree show no branch and never gate.
 */
export function gitInfo(cwd: string | null): GitInfo {
  const none: GitInfo = { branch: null, root: null, repoRoot: null };
  if (!cwd) return none;
  const found = resolveGitDir(cwd);
  if (!found) return none;
  let head: string;
  try {
    head = readFileSync(join(found.gitDir, "HEAD"), "utf8").trim();
  } catch {
    return none;
  }
  const common = commonDir(found.gitDir);
  return {
    branch: branchFromHead(head),
    root: realPath(found.root),
    repoRoot: realPath(mainRootFromCommonDir(common)),
  };
}

/**
 * The main checkout's root, from a common git dir.
 *
 * A non-bare repo's common dir is the main worktree's `.git`, so its parent is the
 * root that every linked worktree shares. A BARE repo has no worktree at all and
 * its common dir is the repo itself (`/srv/repo.git`) - taking the parent there
 * would name the directory that merely CONTAINS the repo, which for an allowlist
 * would silently clear every sibling repo next to it. So the parent is only taken
 * when the common dir is actually a `.git`.
 */
function mainRootFromCommonDir(common: string): string {
  return basename(common) === ".git" ? dirname(common) : common;
}

/**
 * The MAIN repo root behind a working dir - i.e. the checkout that owns the
 * shared git dir, not the linked worktree the caller happens to stand in.
 *
 * A pooled worktree's cwd resolves to itself under `gitInfo().root`; treehouse
 * (and `git worktree`) instead key a pool off the repo that owns it, so the pool
 * reaper has to walk from any tree back to that owner. The commondir pointer is
 * exactly that link: `<main-root>/.git`, so the main root is its parent.
 *
 * Returns null for a bare repo and for a dir outside a repo. That null is where
 * this parts ways with `gitInfo().repoRoot`, which names the bare repo itself so
 * an allowlist can still match it: naming a pool owner we can't hand a worktree
 * back to would be a guess, and this feeds a destructive return. Pure filesystem,
 * like the rest of this module - no subprocess.
 */
export function mainRepoRoot(cwd: string | null): string | null {
  if (!cwd) return null;
  const found = resolveGitDir(cwd);
  if (!found) return null;
  const common = commonDir(found.gitDir);
  // A normal clone's common dir is `<root>/.git`; anything else (a bare repo, a
  // relocated git dir) has no worktree we can name, so don't guess one.
  if (basename(common) !== ".git") return null;
  return realPath(dirname(common));
}

/** Canonical identity used by the daemon-owned native worktree allocator. */
export interface WorktreeRepositoryIdentity {
  /** Physical root of the main checkout that owns the linked-worktree family. */
  mainCheckoutRoot: string;
  /** Physical Git common directory. This, and only this, is native pool identity. */
  gitCommonDirectory: string;
  /** Human-readable repository name, derived from the main checkout directory. */
  repositoryName: string;
  /** Stable native pool directory under WORKTREE_POOLS_DIR. */
  poolPath: string;
}

/**
 * Resolve a path to a provable non-bare main checkout and its physical Git common dir.
 *
 * A main checkout and every linked worktree resolve identically. Separate clones of one
 * remote do not, because their common directories differ. Bare and relocated-Git-dir
 * repositories return null: neither has the ordinary `<main>/.git` ownership relationship
 * required before the allocator may create or remove linked worktrees.
 */
export function worktreeRepositoryIdentity(
  cwd: string | null,
  poolsDirectory = WORKTREE_POOLS_DIR,
): WorktreeRepositoryIdentity | null {
  if (!cwd) return null;
  const found = resolveGitDir(cwd);
  if (!found) return null;
  const common = realPath(commonDir(found.gitDir));
  if (basename(common) !== ".git") return null;
  const mainCheckoutRoot = realPath(dirname(common));
  const mainDotGit = realPath(join(mainCheckoutRoot, ".git"));
  if (mainDotGit !== common) return null;
  const repositoryName = basename(mainCheckoutRoot);
  if (!repositoryName) return null;
  const digest = createHash("sha256").update(common).digest("hex").slice(0, 16);
  // The leaf need not exist yet, but its state-directory parent does. Physicalize that
  // parent now so the durable slot path later compares byte-for-byte with realpath and
  // Git's porcelain output (notably /var versus /private/var on macOS).
  const physicalPoolsDirectory = join(realPath(dirname(poolsDirectory)), basename(poolsDirectory));
  return {
    mainCheckoutRoot,
    gitCommonDirectory: common,
    repositoryName,
    poolPath: join(physicalPoolsDirectory, `${repositoryName}-${digest}`),
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
  // A detached checkout has no branch. Keeping this null lets the first real branch be
  // adopted in place instead of looking like a branch change that invalidates task ownership.
  return null;
}
