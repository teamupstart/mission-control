import { run } from "../util/exec.ts";
import { FULL_SHA, resolveCapturedCommit } from "./commit-id.ts";

export interface ReviewComparison {
  baseRef: string | null;
  baseTip: string | null;
  mergeBase: string | null;
  head: string | null;
  empty: boolean;
  error: string | null;
}

interface ReviewComparisonInput {
  repoRoot: string;
  headSha: string | null;
  /** A verified stacked base takes precedence over a configured base ref. */
  stackBase?: () => Promise<{ branch: string; sha: string; repoRoot: string } | null>;
}

export interface ReviewChangedPaths {
  /** Changed paths present at the submitted head. */
  required: readonly string[];
  /** Includes deleted paths that were part of the change. */
  allowed: readonly string[];
}

/** Resolve a commit-pinned comparison for a pre-publication review. */
export async function resolveReviewComparison(
  input: ReviewComparisonInput,
  baseRef: string | null = null,
): Promise<ReviewComparison> {
  const result: ReviewComparison = { baseRef, baseTip: null, mergeBase: null, head: null, empty: false, error: null };
  const git = async (args: string[]) => {
    const r = await run("git", ["-C", input.repoRoot, ...args], { timeoutMs: 5000, maxBuffer: 64 * 1024 });
    if (r.code !== 0 || r.outcomeUnknown || r.overflowed || r.stderr.trim()) throw new Error("Git comparison could not be resolved unambiguously. Correct local refs or set an explicit baseRef in Library > Commands, then retry");
    return r.stdout.trim();
  };
  try {
    if (!input.headSha) throw new Error("No captured committed head. Commit and submit again");
    result.head = await resolveCapturedCommit(input.repoRoot, input.headSha);
    const stacked = input.stackBase ? await input.stackBase() : null;
    if (stacked) {
      // At the task's repository root, from explicit commit ids: both commits are in its
      // object store (linked worktrees share it), so nothing here runs in the checkout.
      const atRoot = async (args: string[]) => {
        const r = await run("git", ["-C", stacked.repoRoot, ...args], { timeoutMs: 5000, maxBuffer: 64 * 1024 });
        if (r.code !== 0 || r.outcomeUnknown || r.overflowed || r.stderr.trim()) throw new Error("The stacked comparison could not be resolved at the repository root");
        return r.stdout.trim();
      };
      result.baseRef = `refs/remotes/origin/${stacked.branch}`;
      result.baseTip = stacked.sha;
      result.mergeBase = await atRoot(["merge-base", "--all", result.baseTip, result.head]);
      if (!FULL_SHA.test(result.mergeBase)) throw new Error("The stacked comparison has no unique merge base");
      result.empty = (await atRoot(["diff", "--name-only", result.mergeBase, result.head, "--"])) === "";
      return result;
    }
    if (!result.baseRef) {
      // A locally observed remote HEAD is reliable; guessing main/master is not.
      result.baseRef = await git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
    }
    if (!/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(result.baseRef) || result.baseRef.includes("..")) throw new Error("Set a valid explicit baseRef in Library > Commands and retry");
    result.baseTip = await git(["rev-parse", "--verify", "--end-of-options", `${result.baseRef}^{commit}`]);
    if (!FULL_SHA.test(result.baseTip)) throw new Error("The configured base did not resolve to one commit");
    result.mergeBase = await git(["merge-base", "--all", result.baseTip, result.head]);
    if (!FULL_SHA.test(result.mergeBase)) throw new Error("The comparison has no unique merge base");
    result.empty = (await git(["diff", "--name-only", result.mergeBase, result.head, "--"])) === "";
  } catch (error) { result.error = error instanceof Error ? error.message : "Git comparison is unavailable"; }
  return result;
}

/**
 * The paths changed in a pinned comparison.
 * Renames are split so the new path is required and the old one is merely allowed, the same
 * way a deletion is. NUL-separated so no path is quoted or mangled.
 */
export async function reviewChangedPaths(repoRoot: string, mergeBase: string, head: string): Promise<ReviewChangedPaths> {
  if (!FULL_SHA.test(mergeBase) || !FULL_SHA.test(head)) throw new Error("Git comparison is not pinned to full commits");
  const r = await run("git", ["-C", repoRoot, "diff", "--name-status", "--no-renames", "--no-relative", "--no-ext-diff", "-z", mergeBase, head, "--"],
    { timeoutMs: 10_000, maxBuffer: 4 * 1024 * 1024 });
  if (r.code !== 0 || r.outcomeUnknown || r.overflowed || r.stderr.trim()) throw new Error("the pinned comparison's changed files could not be listed");
  const fields = r.stdout.split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 2) throw new Error("the pinned comparison's changed files could not be parsed");
  const required: string[] = [], allowed: string[] = [];
  for (let i = 0; i < fields.length; i += 2) {
    const status = fields[i]!, path = fields[i + 1]!;
    if (!/^[ACDMTUX]$/.test(status) || !path) throw new Error("the pinned comparison's changed files could not be parsed");
    allowed.push(path);
    if (status !== "D") required.push(path);
  }
  return { required, allowed };
}
