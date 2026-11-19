import type { Task } from "@shared/types.ts";

/**
 * The repository manifest of a multi-repo task, or "" when it attaches none with a worktree.
 *
 * Shared by the two places an agent is told where its repositories are: turn one of every
 * multi-repo dispatch (`intentWithRepoManifest`), and the wake that restates a resident's
 * standing task after a compaction, which would otherwise leave a long-running resident with a
 * summary that no longer names the checkouts it has write access to.
 *
 * Everything here is something the agent cannot work out for itself from inside its cwd:
 *
 *  - **Where the other repos are.** Nothing in the primary worktree names them.
 *  - **Read each repo's own AGENTS.md/CLAUDE.md.** Only the primary's loads automatically -
 *    both harnesses resolve instruction files from the working directory, so a sibling
 *    checkout's conventions are invisible unless the agent goes and reads them.
 *  - **One pull request per repo you actually changed.** The default assumption is one
 *    branch, one pull request; without this an agent will commit across repos and open a
 *    single pull request in the one it happens to be standing in, leaving the rest of the
 *    work on unpushed local branches.
 *
 * Each repo's branch is stated PER REPO and read from what was actually provisioned. The
 * design's intent is one shared name across the set - that is what makes the resulting pull
 * requests legible as one task - and the Git fallback delivers it, while a native lease is
 * detached. Claiming a shared name a native repo does not have would send the agent to push
 * a branch that does not exist there, so the manifest reports the set it got and says plainly
 * when they differ.
 *
 * Repos with no worktree are omitted rather than listed as unavailable: this text is
 * delivered after provisioning, so an entry without one is a bug being reported to the
 * wrong audience.
 */
export function taskRepoManifest(task: Task): string {
  const attached = task.extraRepos.filter((entry) => entry.worktreePath !== null);
  if (attached.length === 0) return "";
  const branchOf = (branch: string | null): string => (branch ? `, on branch ${branch}` : "");
  // Whether the whole set really did land on one branch name. The Git fallback cuts
  // `harness/<slug>-<shortId>` in every repo, while a native lease is detached. A mixed set
  // can therefore carry branch names and nulls, and this is read from what was provisioned -
  // a manifest that promised one shared branch would send the agent to push a branch that
  // does not exist in the secondary.
  const branches = [task.branch, ...attached.map((entry) => entry.branch)];
  const shared = task.branch !== null && branches.every((b) => b === task.branch)
    ? task.branch
    : null;
  return [
    "## Repositories for this task",
    "",
    "This task spans several repositories. You have write access to all of them.",
    "",
    `- ${task.worktreePath ?? task.repoRoot} - PRIMARY (your working directory), from ${task.repoRoot}${branchOf(task.branch)}`,
    ...attached.map(
      (entry) => `- ${entry.worktreePath} - from ${entry.repoRoot}${branchOf(entry.branch)}`,
    ),
    "",
    ...(shared
      ? [`Every one of them is on the branch ${shared}.`, ""]
      : [
          "They are NOT all on the same branch - each repo's branch is listed above. Work on the",
          "branch each repo is already checked out on; do not assume one shared name.",
          "",
        ]),
    "Before you touch a repository, read its own AGENTS.md / CLAUDE.md - only the primary's",
    "loads automatically, so the others' conventions are invisible until you read them.",
    "",
    "Commit and push in each repository you change, and open ONE pull request per repository",
    "you actually changed. A repository you did not change needs no commit and no pull request.",
  ].join("\n");
}
