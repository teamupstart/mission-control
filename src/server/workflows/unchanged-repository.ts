import { sourceRef } from "../diff.ts";
import { isolatedGitEnvironment } from "../git/worktree-tree.ts";
import { run } from "../util/exec.ts";
import { FULL_SHA } from "./commit-id.ts";

/** Positive local Git proof. Missing or unreadable facts never mean an unchanged repository. */
export interface UnchangedRepositoryProof {
  headOid: string;
  treeOid: string;
  baseOid: string;
  baseRef: string;
}

/** Uses the review diff's default-branch rule, conservatively including stacked work.
 * Null means positively changed. Unavailable proof throws a bounded diagnostic for recovery.
 */
export async function readUnchangedRepository(root: string, headOid: string): Promise<UnchangedRepositoryProof | null> {
  // A read only: `git status` must not take the index lock or refresh the index. This runs
  // while the Pull Request action's repository capture may be sealing the same checkout, and
  // that capture refuses ("The repository changed during both capture attempts") when the
  // checkout's git directory changes under it.
  const git = (args: string[]) => run("git", ["-C", root, ...args], {
    timeoutMs: 15_000, env: isolatedGitEnvironment({ GIT_OPTIONAL_LOCKS: "0" }),
  });
  // Dirty work needs publication even when the default base cannot be resolved.
  const status = await git(["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"]);
  if (status.code !== 0) throw new Error("The checkout's staged, unstaged and untracked status could not be read.");
  if (status.stdout.trim()) return null;
  const baseRef = await sourceRef(root);
  if (!baseRef) throw new Error("The repository's default base could not be resolved.");
  if (!FULL_SHA.test(headOid)) throw new Error("The checkout HEAD could not be verified.");
  const base = await git(["rev-parse", "--verify", `${baseRef}^{commit}`]);
  const baseOid = base.stdout.trim();
  if (base.code !== 0 || !FULL_SHA.test(baseOid)) throw new Error("The default base commit could not be verified.");
  // An empty diff is insufficient: even an empty commit ahead needs publication.
  const ancestor = await git(["merge-base", "--is-ancestor", headOid, baseOid]);
  if (ancestor.code === 1) return null;
  if (ancestor.code !== 0) throw new Error("The checkout ancestry relative to the default base could not be verified.");
  const current = await git(["rev-parse", "--verify", "HEAD"]);
  if (current.code !== 0) throw new Error("The checkout HEAD could not be read.");
  if (current.stdout.trim() !== headOid) throw new Error("The checkout HEAD changed while reading publication proof.");
  const tree = await git(["rev-parse", "--verify", `${headOid}^{tree}`]);
  const treeOid = tree.stdout.trim();
  if (tree.code !== 0 || !FULL_SHA.test(treeOid)) throw new Error("The checkout content tree could not be read.");
  return { headOid, treeOid, baseOid, baseRef };
}
