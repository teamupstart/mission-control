import { realpathSync } from "node:fs";
import type { Session, Task } from "@shared/types.ts";
import { expectedStackBase } from "@shared/stacking.ts";
import { latestStackedPr } from "../db.ts";
import { parsePrUrl } from "../inspector/github.ts";
import { run } from "../util/exec.ts";
import { defaultStackGitHub, type StackGitHub } from "./github.ts";

/** The verified base a stacked task's review diff is taken against. */
export interface StackDiffBase {
  /** The branch, as GitHub names it (no `origin/` prefix). */
  branch: string;
  /** Its tip, fetched at the repository root and checked against `ls-remote`. */
  sha: string;
  /**
   * Where the child's work diverged from that tip: the merge base of the child checkout's
   * HEAD and `sha`, computed at the repository root from explicit commit ids. The review diff
   * is taken from here, the way GitHub diffs a pull request against its base.
   */
  mergeBase: string;
  /** The task's main checkout, where every git question about the stack is asked. */
  repoRoot: string;
  /** The child checkout's HEAD and branch, read from `git worktree list` at the root. */
  head: string;
  headBranch: string | null;
}

/** What this needs from the Registry. */
export interface StackDiffRegistry {
  taskForSession(sessionId: string, cwd: string | null): Task | undefined;
  workEpisodeForSession(sessionId: string): { episodeId: string } | null;
}

/** A refresh that could not be made. The diff fails with this rather than using a stale ref. */
export class StackDiffBaseError extends Error {}

/** One git command, always `-C <repository root>`. Injectable so a test can see every call. */
export type RepoGit = (repoRoot: string, args: readonly string[]) => Promise<{ ok: boolean; stdout: string }>;

const defaultRepoGit: RepoGit = async (repoRoot, args) => {
  const result = await run("git", ["-C", repoRoot, ...args], { timeoutMs: 15_000 });
  return { ok: result.code === 0 && !result.outcomeUnknown && !result.overflowed, stdout: result.stdout };
};

const FULL_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * The HEAD commit of one linked worktree, read from the REPOSITORY ROOT.
 *
 * `git worktree list --porcelain` reports every worktree's HEAD from the main checkout's own
 * administrative files, so the daemon learns where the child is without running git inside
 * the child's checkout - the boundary stacking keeps (see `docs/plans/pr-stacking/plan.md`,
 * non-goals). Null when the checkout is not one of this repository's worktrees.
 */
async function worktreeHead(
  repoRoot: string,
  checkout: string,
  git: RepoGit,
): Promise<{ head: string; branch: string | null } | null> {
  const listed = await git(repoRoot, ["worktree", "list", "--porcelain"]);
  if (!listed.ok) return null;
  const wanted = canonical(checkout);
  // Porcelain output is one blank-line-separated record per worktree.
  for (const record of listed.stdout.split("\n\n")) {
    const lines = record.split("\n");
    const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length).trim();
    if (!path || canonical(path) !== wanted) continue;
    const head = lines.find((line) => line.startsWith("HEAD "))?.slice("HEAD ".length).trim() ?? "";
    const branch = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length).trim() ?? null;
    return FULL_SHA.test(head) ? { head, branch: branch?.replace(/^refs\/heads\//, "") ?? null } : null;
  }
  return null;
}

/**
 * The base a stacked task's review diff must use, refreshed and verified, or null for a task
 * that was not cut on a parent (whose diff keeps the default-branch rule).
 *
 * The base is the adopted pull request's CURRENT base, read from GitHub for this review, when
 * one exists - the branch the pull request will actually be reviewed and merged against - and
 * the expected base from the parent's current state before a pull request exists. A merged
 * or closed parent selects the default branch, even if its head branch has been deleted.
 * A confirmed missing base also selects the current default, regardless of parent state.
 * The base keeps moving while the child is reviewed, so it is fetched at the repository root on
 * every call and its tip checked against what origin advertises.
 *
 * Every git command here runs at the repository root with explicit commit ids: the fetch
 * writes only `refs/remotes/origin/<branch>`, the child's HEAD comes from `worktree list`,
 * and the merge base is computed from the two ids. Nothing runs inside the child's worktree.
 *
 * Primary repository only: a run reviewing one of the task's secondary repositories is never
 * stacked. Throws `StackDiffBaseError` when the refresh, the head read or the merge base
 * fails.
 */
export async function resolveStackDiffBase(
  registry: StackDiffRegistry,
  session: Pick<Session, "id" | "cwd">,
  repoRoot: string | null,
  github: StackGitHub = defaultStackGitHub,
  checkout: string | null = session.cwd,
  git: RepoGit = defaultRepoGit,
): Promise<StackDiffBase | null> {
  const task = registry.taskForSession(session.id, session.cwd);
  if (!task?.stackParentTaskId || !task.stackBaseBranch) return null;
  if (repoRoot && repoRoot !== task.repoRoot) return null;
  const parsed = task.stackPrUrl ? parsePrUrl(task.stackPrUrl) : null;
  const episode = registry.workEpisodeForSession(session.id)?.episodeId ?? null;
  const row = parsed ? latestStackedPr(task.id, parsed.owner, parsed.repo, episode) : null;
  // The pull request's base AS IT STANDS NOW, read from GitHub for this review. The ledger's
  // `base_ref_name` is only what the last Inspector poll saw, and a child adopted moments ago
  // has none yet: falling back to the dispatch-time branch then would judge the diff against a
  // base the pull request may never have had, or no longer has.
  let branch: string;
  let defaultBranch: string | null;
  if (row) {
    const current = await github.prRefs(task.repoRoot, row.url);
    if (!current.ok || !current.value?.baseRefName) {
      throw new StackDiffBaseError(
        `stacked base could not be refreshed: could not read the current base of ${row.url}: ${current.error ?? "GitHub reported none"}`,
      );
    }
    branch = current.value.baseRefName;
    defaultBranch = current.value.defaultBranch || null;
  } else {
    // Dispatch facts are provenance, not a live base. Use the same rule as PR base
    // correction, including when the parent merged before the dependency watcher caught up.
    const parent = task.stackPrUrl ? await github.prRefs(task.repoRoot, task.stackPrUrl) : null;
    const expected = parent?.ok && parent.value
      ? expectedStackBase(parent.value, parent.value.defaultBranch || null)
      : null;
    if (!expected) {
      throw new StackDiffBaseError(
        `stacked base could not be refreshed: could not resolve the base from parent ${task.stackPrUrl ?? "(unknown)"}: ${parent?.error ?? "GitHub reported no parent state or base"}`,
      );
    }
    branch = expected;
    defaultBranch = parent?.value?.defaultBranch || null;
  }
  let tip = await github.branchSha(task.repoRoot, branch);
  // A positively absent base cannot be refreshed by resubmission. Recover against the
  // current default, but still require its verified tip. Other fetch failures stay errors.
  if (!tip.ok && tip.code === "branch_missing" && defaultBranch && branch !== defaultBranch) {
    branch = defaultBranch;
    tip = await github.branchSha(task.repoRoot, branch);
  }
  if (!tip.ok) {
    throw new StackDiffBaseError(`stacked base could not be refreshed: ${branch}: ${tip.reason}`);
  }
  const child = checkout ? await worktreeHead(task.repoRoot, checkout, git) : null;
  if (!child) {
    throw new StackDiffBaseError(`stacked base could not be refreshed: ${checkout ?? "the checkout"} is not a worktree of ${task.repoRoot}`);
  }
  const mergeBase = await git(task.repoRoot, ["merge-base", child.head, tip.value]);
  const base = mergeBase.stdout.trim();
  if (!mergeBase.ok || !FULL_SHA.test(base)) {
    throw new StackDiffBaseError(`stacked base could not be refreshed: ${branch} (${tip.value.slice(0, 12)}) shares no history with ${child.head.slice(0, 12)}`);
  }
  return { branch, sha: tip.value, mergeBase: base, repoRoot: task.repoRoot, head: child.head, headBranch: child.branch };
}
