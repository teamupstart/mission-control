import { lstat, opendir } from "node:fs/promises";
import { basename, join } from "node:path";
import { taskRepoRefs } from "@shared/task-repos.ts";
import type { Task } from "@shared/types.ts";
import { CHECK_WORKTREES_DIR, WORKTREES_DIR } from "../config.ts";
import { CheckLeaseStore } from "../workflows/check-lease.ts";
import { gitInfo, worktreeRepositoryIdentity } from "../util/git.ts";
import { canonicalWorktreePath } from "./path.ts";
import { observeWorktreeLink } from "./orphan.ts";

const ENTRIES_PER_ROOT = 100;

async function readRoot(root: string) {
  const paths: string[] = [];
  try {
    if (!(await lstat(root)).isDirectory()) return { paths, state: "unreadable" as const };
    const dir = await opendir(root);
    let count = 0;
    for await (const entry of dir) {
      if (count++ === ENTRIES_PER_ROOT) return { paths, state: "truncated" as const };
      if (entry.isDirectory() || entry.isSymbolicLink()) paths.push(join(root, entry.name));
    }
    return { paths, state: "complete" as const };
  } catch (error) {
    return { paths, state: (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" as const : "unreadable" as const };
  }
}

/**
 * Review residue in place. The cleanup worker selects exclusively from durable task ownership.
 * Entries are named by root and directory name, never by path.
 */
export async function disposableWorktreeCensus(tasks: readonly Task[]) {
  const ownership = new Map<string, { taskId: string; repoRoot: string }>();
  for (const task of tasks) {
    for (const ref of taskRepoRefs(task)) {
      if (ref.worktreePath) ownership.set(canonicalWorktreePath(ref.worktreePath), { taskId: task.id, repoRoot: ref.repoRoot });
    }
  }
  const [tasksRoot, checksRoot] = await Promise.all([readRoot(WORKTREES_DIR), readRoot(CHECK_WORKTREES_DIR)]);
  const paths = [
    ...tasksRoot.paths.map((path) => ({ root: "task" as const, path })),
    ...checksRoot.paths.map((path) => ({ root: "check" as const, path })),
  ].map((entry) => ({ ...entry, canonical: canonicalWorktreePath(entry.path) }));
  const checkStates = new CheckLeaseStore().statesForPaths(paths.flatMap(({ path, canonical }) => [path, canonical]));
  const entries = await Promise.all(paths.map(async ({ root, path, canonical }) => {
    const task = ownership.get(canonical);
    const checkState = checkStates.get(path) ?? checkStates.get(canonical) ?? null;
    const linkedMarker = await lstat(join(path, ".git")).then((info) => info.isFile(), () => false);
    const git = linkedMarker && worktreeRepositoryIdentity(path);
    const repo = task && worktreeRepositoryIdentity(task.repoRoot);
    const gitMetadata = git && gitInfo(path).root === canonical && (!task || repo && repo.gitCommonDirectory === git.gitCommonDirectory)
      ? "readable" as const : "unverified" as const;
    // Positive evidence only, read without Git: a directory whose `.git` file names an
    // administrative directory that is gone (`dangling-link`), or that has no `.git` at all.
    // Review evidence like the rest of the census; retention re-proves everything itself.
    const link = gitMetadata === "readable" ? null : await observeWorktreeLink(path);
    // No path: the root it was found under and its directory name (a task or check attempt id)
    // identify it, and the response carries no checkout location.
    return {
      root, name: basename(path), taskId: task?.taskId ?? null, checkState, gitMetadata,
      orphanEvidence: link && link.kind !== "absent" ? link.kind : null,
    };
  }));
  return { taskRoot: tasksRoot.state, checkRoot: checksRoot.state, entries };
}
