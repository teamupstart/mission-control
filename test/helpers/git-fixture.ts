import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Run git in `dir`, returning trimmed stdout. */
export function gitIn(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" }).toString().trim();
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
  og("branch", "-M", "main");
  og("config", "user.email", "t@test");
  og("config", "user.name", "t");
  writeFileSync(join(origin, "keep.txt"), "base\n");
  og("add", "-A");
  og("commit", "-qm", "base");

  const clone = join(root, "clone");
  execFileSync("git", ["clone", "-q", origin, clone]);
  gitIn(clone, "config", "user.email", "t@test");
  gitIn(clone, "config", "user.name", "t");
  return { root, origin, clone };
}

/**
 * A clone sitting on `branch` with a local commit on top - the shape a session is
 * in when its no-mistakes run has just finished validating that work. Returns the
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
 * worktree (its `.git` is a FILE), which is how a launcher-bound run's checkout
 * differs from the session that drives it.
 */
export function mkLinkedWorktree(clone: string, branch: string, dir: string): string {
  gitIn(clone, "worktree", "add", "-q", "-b", branch, dir);
  return realpathSync(dir);
}
