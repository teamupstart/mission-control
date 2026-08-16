import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { remoteDefaultRef } from "../actions.ts";
import { resetWorktreeToCommit } from "../git/ensemble-snapshot.ts";
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
}

export interface WorktreeGit {
  list(identity: WorktreeRepositoryIdentity): Promise<GitResult<WorktreeRegistration[]>>;
  inspect(path: string): Promise<GitResult<WorktreeInspection>>;
  add(identity: WorktreeRepositoryIdentity, path: string, commit: string): Promise<GitResult<void>>;
  reset(path: string, commit: string): Promise<GitResult<void>>;
  observedDefaultSha(identity: WorktreeRepositoryIdentity): Promise<GitResult<string>>;
  fetchDefaultSha(identity: WorktreeRepositoryIdentity): Promise<GitResult<string>>;
  mergedInto(path: string, targetSha: string): Promise<GitResult<boolean>>;
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

  async inspect(path: string): Promise<GitResult<WorktreeInspection>> {
    const identity = worktreeRepositoryIdentity(path);
    if (!identity) {
      return { ok: false, reason: `${path} is not a provable linked worktree`, outcomeUnknown: false };
    }
    const [head, status] = await Promise.all([
      this.execute("git", ["-C", path, "rev-parse", "HEAD"], { timeoutMs: 15_000 }),
      this.execute("git", ["-C", path, "status", "--porcelain", "--untracked-files=all"], {
        timeoutMs: 15_000,
      }),
    ]);
    if (commandFailed(head)) return failure("git rev-parse HEAD", head);
    if (commandFailed(status)) return failure("git status", status);
    return {
      ok: true,
      value: {
        path: await canonical(path),
        head: head.stdout.trim(),
        dirty: status.stdout.trim().length > 0,
        commonDirectory: identity.gitCommonDirectory,
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
    try {
      // The shared helper is the one owner of reset --hard plus clean -fd and exact HEAD.
      await resetWorktreeToCommit(path, commit);
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

  async fetchDefaultSha(identity: WorktreeRepositoryIdentity): Promise<GitResult<string>> {
    const fetched = await this.execute("git", ["-C", identity.mainCheckoutRoot, "fetch", "origin"], {
      timeoutMs: 30_000,
    });
    if (commandFailed(fetched)) return failure("git fetch origin", fetched);
    return this.observedDefaultSha(identity);
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
}
