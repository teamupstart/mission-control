import { realpath } from "node:fs/promises";
import { run } from "../util/exec.ts";

/** Kill is permission to stop, not to discard work. Every uncertain read retains the tree. */
export async function worktreeReturnBlocker(
  path: string,
  options: { fetch?: boolean; execute?: typeof run } = {},
): Promise<string | null> {
  const execute = options.execute ?? run;
  const git = (args: string[]) => execute("git", ["--no-optional-locks", "-C", path, ...args], {
    timeoutMs: 30_000,
  });
  try {
    const top = await git(["rev-parse", "--show-toplevel"]);
    if (top.code !== 0 || top.outcomeUnknown || top.overflowed ||
        await realpath(top.stdout.trim()) !== await realpath(path)) {
      return "checkout identity could not be verified";
    }
    if (options.fetch) {
      const fetched = await git(["fetch", "--prune", "origin"]);
      if (fetched.code !== 0 || fetched.outcomeUnknown || fetched.overflowed) return "origin could not be refreshed";
    }
    const status = await git(["status", "--porcelain", "--untracked-files=all", "--ignored=matching", "--ignore-submodules=none"]);
    if (status.code !== 0 || status.outcomeUnknown || status.overflowed) return "working tree could not be read";
    if (status.stdout.trim()) return "checkout has uncommitted, untracked or ignored work";
    const commits = await git(["rev-list", "--count", "HEAD", "--not", "--remotes=origin"]);
    if (commits.code !== 0 || commits.outcomeUnknown || commits.overflowed || !/^\d+$/.test(commits.stdout.trim())) {
      return "commits could not be compared against origin";
    }
    return commits.stdout.trim() === "0" ? null : "checkout has unpublished commits";
  } catch {
    return "checkout safety could not be verified";
  }
}
