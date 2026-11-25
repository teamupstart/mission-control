import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { run } from "../util/exec.ts";
import { isolatedGitEnvironment } from "./worktree-tree.ts";
import { NativeWorktreeGit } from "../worktrees/git.ts";
import { worktreeRepositoryIdentity } from "../util/git.ts";

/** A checkout must be a registered, unlocked linked worktree of the recorded repository. */
export async function worktreeRegistrationBlocker(path: string, repoRoot: string): Promise<string | null> {
  const [checkout, repo] = [worktreeRepositoryIdentity(path), worktreeRepositoryIdentity(repoRoot)];
  if (!checkout || !repo || checkout.gitCommonDirectory !== repo.gitCommonDirectory) {
    return "checkout Git metadata or repository identity could not be verified";
  }
  const physical = await realpath(path).catch(() => null);
  const listed = await new NativeWorktreeGit().list(repo);
  if (!listed.ok) return "Git worktree registration could not be read";
  const registration = listed.value.find((entry) => entry.path === physical);
  if (!registration || !registration.head || registration.locked || registration.prunable ||
      registration.bare || physical === repo.mainCheckoutRoot) {
    return "checkout is not an unlocked, registered linked worktree";
  }
  return null;
}

function returnGit(path: string, execute: typeof run) {
  return (args: string[]) => execute("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", path, ...args], {
    timeoutMs: 30_000,
    env: isolatedGitEnvironment(),
  });
}

export type ReadReturnActivity = () => Promise<{ head: string } | { blocker: string }>;

async function metadataExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function operationBlocker(git: ReturnType<typeof returnGit>, gitDir: string): Promise<string | null> {
  const markers = ["MERGE_HEAD", "rebase-apply", "rebase-merge", "sequencer", "BISECT_LOG"];
  if ((await Promise.all(markers.map((name) => metadataExists(join(gitDir, name))))).some(Boolean)) {
    return "a Git operation is in progress";
  }
  // Ask Git about these refs so the same check works with files and reftable storage.
  const states = await Promise.all(["CHERRY_PICK_HEAD", "REVERT_HEAD"].map((ref) =>
    git(["rev-parse", "--verify", "--quiet", ref])));
  if (states.some((state) => state.code === 0)) return "a Git operation is in progress";
  if (states.some((state) => state.code !== 1 || state.outcomeUnknown || state.overflowed || state.stderr)) {
    return "checkout Git operation state could not be verified";
  }
  return null;
}

/** Match Git's unforced linked-worktree removal check for submodule metadata. */
async function submoduleBlocker(path: string, gitDir: string, index: string[]): Promise<string | null> {
  const blocker = "checkout has initialized submodules or retained submodule metadata";
  if (await metadataExists(join(gitDir, "modules"))) return blocker;
  for (const entry of index) {
    if (!entry.startsWith("160000 ", 2)) continue;
    const tab = entry.indexOf("\t");
    const submodule = tab < 0 ? "" : entry.slice(tab + 1);
    if (!submodule || submodule.includes("\uFFFD")) return "checkout submodule paths could not be verified";
    if (await metadataExists(join(path, submodule, ".git"))) return blocker;
  }
  return null;
}

/** Every uncertain read retains the checkout. Ignored files have no cache-disposal policy. */
export async function worktreeReturnBlocker(
  path: string,
  options: { fetch?: boolean; execute?: typeof run; strictIndex?: boolean; expectedBranch?: string | null; readActivity?: ReadReturnActivity } = {},
): Promise<string | null> {
  const git = returnGit(path, options.execute ?? run);
  try {
    const top = await git(["rev-parse", "--show-toplevel"]);
    if (top.code !== 0 || top.outcomeUnknown || top.overflowed ||
        await realpath(top.stdout.trim()) !== await realpath(path)) {
      return "checkout identity could not be verified";
    }
    if (options.fetch) {
      const fetched = await git(["fetch", "--atomic", "--prune", "--no-tags", "--no-recurse-submodules",
        "--refmap=", "origin", "+refs/heads/*:refs/remotes/origin/*"]);
      if (fetched.code !== 0 || fetched.outcomeUnknown || fetched.overflowed) return "origin could not be refreshed";
    }
    const head = await git(["rev-parse", "--verify", "HEAD"]);
    const oid = head.stdout.trim();
    if (head.code !== 0 || head.outcomeUnknown || head.overflowed || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(oid)) {
      return "checkout HEAD could not be verified";
    }
    const commits = await git(["rev-list", "--count", oid, "--not", "--remotes=origin"]);
    if (commits.code !== 0 || commits.outcomeUnknown || commits.overflowed || !/^\d+$/.test(commits.stdout.trim())) {
      return "commits could not be compared against origin";
    }
    if (commits.stdout.trim() !== "0") return "checkout has unpublished commits";

    // Publication can wait on Git. Sample activity after it and require the final status
    // to confirm the same commit. Check index flags after status, which can hide them.
    const activity = await options.readActivity?.();
    if (activity && "blocker" in activity) return activity.blocker;
    if (activity && activity.head !== oid) return "Git activity changed during cleanup";

    // Read cleanliness and HEAD together after the reachability walk. A clean status
    // alone cannot prove that the commit about to be reset is the one we verified.
    const status = await git(["status", "--porcelain=v2", "--branch", "--no-ahead-behind", "-z",
      "--untracked-files=all", "--ignored=matching", "--ignore-submodules=none"]);
    if (status.code !== 0 || status.outcomeUnknown || status.overflowed) return "working tree could not be read";
    const records = status.stdout.split("\0").filter(Boolean);
    if (records.some((record) => !record.startsWith("# "))) return "checkout has uncommitted, untracked or ignored work";
    if (!records.includes(`# branch.oid ${oid}`)) return "checkout HEAD changed during publication verification";
    // Git fallback has no lease. The durable task branch must match the branch in
    // this same final status, even when a replacement uses the exact same commit.
    if (options.expectedBranch !== undefined &&
        (!options.expectedBranch || options.expectedBranch === "(detached)" ||
          !records.includes(`# branch.head ${options.expectedBranch}`))) {
      return "checkout branch does not match the task's recorded branch";
    }
    const disposable = options.expectedBranch !== undefined;
    let index: string[] = [];
    if (options.strictIndex || disposable) {
      const listed = await git(["ls-files", "-v", "-z", ...(disposable ? ["--stage"] : [])]);
      index = listed.stdout.split("\0").filter(Boolean);
      if (listed.code !== 0 || listed.outcomeUnknown || listed.overflowed ||
          (options.strictIndex && index.some((entry) => /^[a-zS] /.test(entry)))) {
        return "checkout index has hidden changes or could not be verified";
      }
    }
    const directory = await git(["rev-parse", "--absolute-git-dir"]);
    const gitDir = directory.stdout.replace(/\r?\n$/, "");
    if (directory.code !== 0 || directory.outcomeUnknown || directory.overflowed ||
        !isAbsolute(gitDir) || !(await lstat(gitDir)).isDirectory()) {
      return "checkout Git metadata could not be verified";
    }
    const submodules = disposable ? await submoduleBlocker(path, gitDir, index) : null;
    return submodules ?? await operationBlocker(git, gitDir);
  } catch {
    return "checkout safety could not be verified";
  }
}
