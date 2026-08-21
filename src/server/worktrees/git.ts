import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { remoteDefaultRef } from "../actions.ts";
import { resetWorktreeToCommit } from "../git/ensemble-snapshot.ts";
import { freshRemoteDefaultSha } from "../git/remote-default.ts";
import { run } from "../util/exec.ts";
import {
  worktreeRepositoryIdentity,
  type WorktreeRepositoryIdentity,
} from "../util/git.ts";

export interface WorktreeRegistration {
  path: string;
  head: string | null;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
}

export type GitResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string; outcomeUnknown: boolean };

export interface WorktreeInspection {
  path: string;
  head: string;
  dirty: boolean;
  commonDirectory: string;
  /**
   * No branch is checked out here - HEAD names a commit directly.
   *
   * A pool slot is only ever handed out detached, and this is the fact that proves it
   * rather than the comment that asserts it. A slot that arrives at the right commit while
   * still standing on the previous occupant's branch passes every other check in this
   * interface: the path matches, the repository matches, HEAD is exactly the requested
   * commit, and the tree is clean. What it then hands the next task is a branch name, and
   * the registry - correctly - reads that task's first real branch as a takeover of
   * somebody else's work episode and unbinds it.
   *
   * Observed from Git, never inferred from a stored branch column or from `rev-parse
   * --abbrev-ref` text (which answers the literal string "HEAD" for a detached checkout,
   * and would answer the same for a branch actually named `HEAD`).
   */
  detached: boolean;
}

export interface WorktreeGit {
  list(identity: WorktreeRepositoryIdentity): Promise<GitResult<WorktreeRegistration[]>>;
  inspect(path: string): Promise<GitResult<WorktreeInspection>>;
  add(identity: WorktreeRepositoryIdentity, path: string, commit: string): Promise<GitResult<void>>;
  reset(path: string, commit: string): Promise<GitResult<void>>;
  observedDefaultSha(identity: WorktreeRepositoryIdentity): Promise<GitResult<string>>;
  fetchDefaultSha(identity: WorktreeRepositoryIdentity): Promise<GitResult<string>>;
  mergedInto(path: string, targetSha: string): Promise<GitResult<boolean>>;
  remove(identity: WorktreeRepositoryIdentity, path: string, force: boolean): Promise<GitResult<void>>;
}

function failure(step: string, result: Awaited<ReturnType<typeof run>>): GitResult<never> {
  return {
    ok: false,
    reason: `${step} failed: ${result.stderr.trim() || `exit ${result.code}`}`,
    outcomeUnknown: result.outcomeUnknown,
  };
}

function commandFailed(result: Awaited<ReturnType<typeof run>>): boolean {
  return result.code !== 0 || result.outcomeUnknown || result.overflowed;
}

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

export function parseWorktreePorcelain(stdout: string): WorktreeRegistration[] {
  const registrations: WorktreeRegistration[] = [];
  let current: WorktreeRegistration | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) registrations.push(current);
      current = {
        path: line.slice("worktree ".length),
        head: null,
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length);
    else if (line === "bare") current.bare = true;
    else if (line === "detached") current.detached = true;
    else if (line === "locked" || line.startsWith("locked ")) current.locked = true;
    else if (line === "prunable" || line.startsWith("prunable ")) current.prunable = true;
  }
  if (current) registrations.push(current);
  return registrations;
}

/** Production Git operations for the native allocator. */
export class NativeWorktreeGit implements WorktreeGit {
  constructor(private readonly execute: typeof run = run) {}

  async list(identity: WorktreeRepositoryIdentity): Promise<GitResult<WorktreeRegistration[]>> {
    const result = await this.execute(
      "git",
      ["-C", identity.mainCheckoutRoot, "worktree", "list", "--porcelain"],
      { timeoutMs: 30_000 },
    );
    if (commandFailed(result)) return failure("git worktree list", result);
    const parsed = parseWorktreePorcelain(result.stdout);
    for (const registration of parsed) registration.path = await canonical(registration.path);
    return { ok: true, value: parsed };
  }

  /**
   * Whether `path`'s HEAD names a commit rather than a branch.
   *
   * `symbolic-ref --quiet HEAD` has exactly three outcomes worth telling apart, and the
   * quiet flag is what makes the middle one legible: exit 0 with a ref means a branch is
   * checked out, exit 1 with nothing on either stream means HEAD is detached, and anything
   * else - a killed child, an overflow, an unexpected code, an exit 1 that still said
   * something - is Git not having answered. The third is reported as an error rather than
   * folded into either verdict, because both verdicts gate a destructive or granting state
   * transition and "we did not find out" must not read as "detached".
   */
  private async detachedAt(path: string): Promise<GitResult<boolean>> {
    const probe = await this.execute("git", ["-C", path, "symbolic-ref", "--quiet", "HEAD"], {
      timeoutMs: 15_000,
    });
    if (probe.outcomeUnknown || probe.overflowed) return failure("git symbolic-ref HEAD", probe);
    if (probe.code === 0 && probe.stdout.trim().length > 0) return { ok: true, value: false };
    if (probe.code === 1 && probe.stdout.trim().length === 0 && probe.stderr.trim().length === 0) {
      return { ok: true, value: true };
    }
    return failure("git symbolic-ref HEAD", probe);
  }

  async inspect(path: string): Promise<GitResult<WorktreeInspection>> {
    const identity = worktreeRepositoryIdentity(path);
    if (!identity) {
      return { ok: false, reason: `${path} is not a provable linked worktree`, outcomeUnknown: false };
    }
    const [head, status, detached] = await Promise.all([
      this.execute("git", ["-C", path, "rev-parse", "HEAD"], { timeoutMs: 15_000 }),
      this.execute("git", ["-C", path, "status", "--porcelain", "--untracked-files=all"], {
        timeoutMs: 15_000,
      }),
      this.detachedAt(path),
    ]);
    if (commandFailed(head)) return failure("git rev-parse HEAD", head);
    if (commandFailed(status)) return failure("git status", status);
    if (!detached.ok) return detached;
    return {
      ok: true,
      value: {
        path: await canonical(path),
        head: head.stdout.trim(),
        dirty: status.stdout.trim().length > 0,
        commonDirectory: identity.gitCommonDirectory,
        detached: detached.value,
      },
    };
  }

  async add(
    identity: WorktreeRepositoryIdentity,
    path: string,
    commit: string,
  ): Promise<GitResult<void>> {
    const parent = dirname(path);
    await mkdir(parent, { recursive: true });
    const [stat, physicalParent] = await Promise.all([lstat(parent), realpath(parent)]);
    if (!stat.isDirectory() || stat.isSymbolicLink() || physicalParent !== resolve(parent)) {
      return {
        ok: false,
        reason: `worktree parent ${parent} is not an exact physical directory`,
        outcomeUnknown: false,
      };
    }
    const result = await this.execute(
      "git",
      ["-C", identity.mainCheckoutRoot, "worktree", "add", "--detach", path, commit],
      { timeoutMs: 60_000 },
    );
    if (commandFailed(result)) return failure("git worktree add", result);
    return { ok: true, value: undefined };
  }

  async reset(path: string, commit: string): Promise<GitResult<void>> {
    try {
      const [stat, physical] = await Promise.all([lstat(path), realpath(path)]);
      if (!stat.isDirectory() || stat.isSymbolicLink() || physical !== resolve(path)) {
        return {
          ok: false,
          reason: `worktree ${path} is not an exact physical directory`,
          outcomeUnknown: false,
        };
      }
    } catch (error) {
      return {
        ok: false,
        reason: `worktree ${path} could not be physically verified: ${String(error)}`,
        outcomeUnknown: false,
      };
    }
    // Release the branch BEFORE the file reset, not after, and never by deleting it.
    //
    // A pool slot is reused, so the checkout it is handed back for reuse may still be
    // standing on the finished occupant's branch. `reset --hard` alone would leave it
    // there and drag the branch's TIP to the new commit as a side effect: the next task
    // starts on a name that already has a pull request, and its first real branch reads to
    // the registry as one feature branch replacing another, which is a work-episode
    // takeover and unbinds the task. Detaching first makes the reset a pure file
    // operation on a checkout that holds no name.
    //
    // `--force` because this is the destructive pool reset - the tree's contents are about
    // to be replaced wholesale, so a checkout that refused over local edits would only
    // move the failure one line later. The branch REF is left exactly where it was: the
    // commits under it are somebody's finished work, and dropping the name here would be a
    // deletion nothing asked for and nothing recorded.
    const detach = await this.execute("git", ["-C", path, "checkout", "--force", "--detach", commit], {
      timeoutMs: 60_000,
    });
    if (commandFailed(detach)) {
      return {
        ok: false,
        reason: `git checkout --force --detach failed: ${detach.stderr.trim() || `exit ${detach.code}`}`,
        // A checkout that died mid-flight may have moved HEAD, replaced working files, or
        // done neither, and an overflowed one never reported which. Either way the slot is
        // quarantined for reconciliation rather than reset again in place.
        outcomeUnknown: detach.outcomeUnknown || detach.overflowed,
      };
    }
    try {
      // The shared helper is the one owner of reset --hard plus clean -fd and exact HEAD.
      // Deliberately NOT taught to detach: `restoreSnapshotIntoWorktree` puts an ensemble
      // artifact back into a live session's checkout, which is not pool lifecycle policy
      // and must not have its branch yanked out from under it.
      await resetWorktreeToCommit(path, commit);
      // Independent of the checkout above having reported success: the shared helper runs
      // its own Git mutations in between, and this slot is about to be leased on the
      // strength of this result.
      const detached = await this.detachedAt(path);
      if (!detached.ok) return detached;
      if (!detached.value) {
        return {
          ok: false,
          reason: `worktree ${path} still holds a branch after being reset to ${commit}`,
          outcomeUnknown: false,
        };
      }
      return { ok: true, value: undefined };
    } catch (error) {
      // The shared helper deliberately exposes one error rather than subprocess health.
      // Classify the mutation conservatively: Git may have reset before a later clean or
      // verification failed, so callers must reconcile instead of double-acquiring.
      return { ok: false, reason: String(error), outcomeUnknown: true };
    }
  }

  async observedDefaultSha(identity: WorktreeRepositoryIdentity): Promise<GitResult<string>> {
    const target = await remoteDefaultRef(identity.mainCheckoutRoot);
    if (!target) {
      return { ok: false, reason: "no remote default branch is available", outcomeUnknown: false };
    }
    const resolved = await this.execute(
      "git",
      ["-C", identity.mainCheckoutRoot, "rev-parse", target],
      { timeoutMs: 15_000 },
    );
    if (commandFailed(resolved)) return failure(`git rev-parse ${target}`, resolved);
    const sha = resolved.stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      return { ok: false, reason: `${target} did not resolve to a full commit id`, outcomeUnknown: false };
    }
    return { ok: true, value: sha };
  }

  /**
   * Where Return puts a slot: the newest commit on the branch origin advertises TODAY.
   *
   * Not `observedDefaultSha`, which reads the checkout's cached `refs/remotes/origin/HEAD`
   * and is the right answer for a status panel describing what this clone knows. A fetch
   * does not refresh that cache, so a repository whose default was renamed server-side
   * would have every returned slot parked on the old branch's tip forever, and every task
   * leased from that slot would start there. Dispatch asks the remote the same question
   * through the same helper so the two cannot drift apart.
   */
  async fetchDefaultSha(identity: WorktreeRepositoryIdentity): Promise<GitResult<string>> {
    return freshRemoteDefaultSha(identity.mainCheckoutRoot, this.execute);
  }

  async mergedInto(path: string, targetSha: string): Promise<GitResult<boolean>> {
    const result = await this.execute(
      "git",
      ["-C", path, "merge-base", "--is-ancestor", "HEAD", targetSha],
      { timeoutMs: 15_000 },
    );
    if (result.outcomeUnknown || result.overflowed) {
      return failure("git merge-base --is-ancestor", result);
    }
    if (result.code === 0) return { ok: true, value: true };
    if (result.code === 1) return { ok: true, value: false };
    return failure("git merge-base --is-ancestor", result);
  }

  async remove(
    identity: WorktreeRepositoryIdentity,
    path: string,
    force: boolean,
  ): Promise<GitResult<void>> {
    const args = ["-C", identity.mainCheckoutRoot, "worktree", "remove"];
    if (force) args.push("--force");
    args.push(path);
    const result = await this.execute("git", args, { timeoutMs: 60_000 });
    if (commandFailed(result)) return failure("git worktree remove", result);
    return { ok: true, value: undefined };
  }
}
