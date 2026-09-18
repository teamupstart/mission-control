import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Run git in `dir`, returning trimmed stdout. */
export function gitIn(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" }).toString().trim();
}

/**
 * Stop git from running housekeeping inside a fixture repository.
 *
 * Git fires `maintenance run --auto` off the back of ordinary commands, and while it holds
 * `.git/objects/maintenance.lock` a LOCAL `git clone` of that repository is copying the very
 * directory the lock lives in. The lock is created and removed in the same breath, so the
 * copy can enumerate it and then find it gone:
 *
 *     fatal: failed to copy file to '…/clone/.git/objects/maintenance.lock':
 *     No such file or directory
 *
 * That is a race, so it only shows up under load - which means it shows up in the full suite
 * on a busy machine and never once while someone is reproducing it. Disabling housekeeping is
 * the whole fix and it costs these repositories nothing: every one of them holds a handful of
 * objects, lives in the temp dir, and is deleted minutes later. There is no repacking here
 * worth doing and no test that asserts any happened.
 *
 * Applied to every fixture repository rather than only to a clone source, because which of
 * them a future helper clones, adds a worktree to, or fetches from is not fixed.
 */
function quietHousekeeping(dir: string): void {
  gitIn(dir, "config", "maintenance.auto", "false");
  gitIn(dir, "config", "gc.auto", "0");
}

export interface OriginAndClone {
  /** The temp dir holding both, so a suite can remove what it made. */
  root: string;
  origin: string;
  clone: string;
}

/**
 * A real "origin" repo (a `main` branch with a base commit) plus a clone of it
 * whose `origin/main` tracks that base. Real git, so tests can advance origin,
 * diverge the clone, and exercise a genuine fetch/reset/clean rather than a mock
 * that can't show what a reset does to a branch name.
 *
 * `prefix` names the temp dir so a failing test says which suite left it behind.
 */
export function mkOriginAndClone(prefix: string): OriginAndClone {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const origin = join(root, "origin");
  execFileSync("git", ["init", "-q", origin]);
  const og = (...a: string[]): string => gitIn(origin, ...a);
  // Before the first commit, which is the command that would schedule the housekeeping the
  // clone below then races. See `quietHousekeeping`.
  quietHousekeeping(origin);
  og("branch", "-M", "main");
  og("config", "user.email", "t@test");
  og("config", "user.name", "t");
  writeFileSync(join(origin, "keep.txt"), "base\n");
  og("add", "-A");
  og("commit", "-qm", "base");

  const clone = join(root, "clone");
  execFileSync("git", ["clone", "-q", origin, clone]);
  quietHousekeeping(clone);
  gitIn(clone, "config", "user.email", "t@test");
  gitIn(clone, "config", "user.name", "t");
  return { root, origin, clone };
}

/**
 * A clone sitting on `branch` with a local commit on top - the shape a session is
 * in when a review has just finished validating that work. Returns the
 * clone dir, which is also its worktree root.
 */
export function mkCloneOnBranch(prefix: string, branch: string): string {
  const { clone } = mkOriginAndClone(prefix);
  gitIn(clone, "checkout", "-qb", branch);
  writeFileSync(join(clone, "keep.txt"), "base\nthe work the run validated\n");
  gitIn(clone, "commit", "-qam", "work");
  return clone;
}

/**
 * A second worktree of `clone`'s repo, checked out on `branch` - a real linked
 * worktree (its `.git` is a FILE), which is how another checkout
 * differs from the session that drives it.
 */
export function mkLinkedWorktree(clone: string, branch: string, dir: string): string {
  gitIn(clone, "worktree", "add", "-q", "-b", branch, dir);
  return realpathSync(dir);
}
