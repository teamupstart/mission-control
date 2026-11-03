import { run } from "../util/exec.ts";
import { captureWorktreeTree, isolatedGitEnvironment } from "./worktree-tree.ts";

// The commit a workflow's Commands and CodeRabbit review when a submission is uncommitted.
//
// A ship task hands its work to the workflow BEFORE anything is committed - committing and
// opening the pull request is the workflow's own last step. Commands run in a detached lease
// pinned to one commit, so pinning them to HEAD would check the base the task started from
// rather than the task's work, and CodeRabbit (which reviews committed history only) could
// not run at all. The submission's captured content is turned into an ordinary commit
// instead, parented on HEAD, so every pinned reviewer sees exactly what was submitted.
//
// Like the ensemble snapshot, this never disturbs the checkout: the tree is written through a
// temporary index, no branch moves, and the only ref touched lives in our own namespace. Refs
// live in the git dir every linked worktree shares, which is what lets a pooled check lease
// of the same repository check the commit out.

/** The namespace that keeps review snapshots reachable while a run may still need them. */
export const REVIEW_SNAPSHOT_REF_PREFIX = "refs/mission-control/workflow-reviews";

/**
 * How long a snapshot ref outlives its capture. Matches the default raw-evidence retention:
 * after that a retry of the submission has no evidence to review it against anyway.
 */
export const REVIEW_SNAPSHOT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const IDENTITY = {
  GIT_AUTHOR_NAME: "Mission Control",
  GIT_AUTHOR_EMAIL: "mission-control@localhost",
  GIT_COMMITTER_NAME: "Mission Control",
  GIT_COMMITTER_EMAIL: "mission-control@localhost",
};

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): ReturnType<typeof run> {
  return run("git", ["-C", cwd, ...args], { timeoutMs: 60_000, env });
}

function requireOk(step: string, r: Awaited<ReturnType<typeof run>>): string {
  if (r.code !== 0 || r.outcomeUnknown) throw new Error(`${step} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  return r.stdout.trim();
}

function requireObjectId(step: string, value: string): string {
  if (!OBJECT_ID.test(value)) throw new Error(`${step} returned an invalid git object id`);
  return value;
}

/** The ref that keeps one snapshot alive. The component is a validated object id, never text. */
export function reviewSnapshotRef(commitOid: string): string {
  return `${REVIEW_SNAPSHOT_REF_PREFIX}/${requireObjectId("review snapshot", commitOid)}`;
}

export interface CapturedReviewSnapshot {
  /** Complete tracked and nonignored worktree content - the same id `captureWorktreeTree` gives. */
  treeOid: string;
  /** HEAD at capture, and the snapshot's parent. Null on an unborn branch. */
  headOid: string | null;
  /** The commit Commands and CodeRabbit are pinned to: HEAD itself when nothing is uncommitted. */
  commitOid: string;
  /** The ref keeping `commitOid` reachable, or null when `commitOid` is HEAD. */
  ref: string | null;
}

/**
 * Capture the worktree as the commit a workflow reviews.
 *
 * A clean worktree reviews HEAD and writes nothing. Otherwise the tree is persisted in the
 * repository's object store, committed onto HEAD with a fixed identity (so a missing
 * `user.email` cannot fail a capture), named under {@link REVIEW_SNAPSHOT_REF_PREFIX}, and read
 * back before it is returned. Expired snapshot refs are pruned on the way out; a pruning
 * failure never fails the capture it rides on.
 */
export async function captureReviewSnapshot(
  worktreePath: string,
  now: number = Date.now(),
): Promise<CapturedReviewSnapshot> {
  const env = isolatedGitEnvironment(IDENTITY);
  const captured = await captureWorktreeTree(worktreePath, { objectStorage: "repository" });
  const { treeOid, headOid } = captured;
  if (headOid) {
    const headTree = requireOk("git rev-parse HEAD^{tree}", await git(worktreePath, ["rev-parse", "--verify", `${headOid}^{tree}`], env));
    if (headTree === treeOid) return { treeOid, headOid, commitOid: headOid, ref: null };
  }
  const date = `@${Math.floor(now / 1_000)} +0000`;
  const commitOid = requireObjectId("git commit-tree", requireOk("git commit-tree", await git(
    worktreePath,
    ["commit-tree", treeOid, ...(headOid ? ["-p", headOid] : []), "-m",
      "Mission Control review snapshot\n\nUncommitted content a workflow submission captured for review."],
    { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  )));
  const ref = reviewSnapshotRef(commitOid);
  requireOk("git update-ref", await git(worktreePath, ["update-ref", ref, commitOid], env));
  const stored = requireOk("git rev-parse (verifying the review snapshot ref)",
    await git(worktreePath, ["rev-parse", "--verify", `${ref}^{commit}`], env));
  if (stored !== commitOid) throw new Error(`review snapshot ref ${ref} resolved to ${stored}, expected ${commitOid}`);
  await pruneReviewSnapshots(worktreePath, now).catch(() => undefined);
  return { treeOid, headOid, commitOid, ref };
}

/** Delete snapshot refs whose capture is older than {@link REVIEW_SNAPSHOT_RETENTION_MS}. */
export async function pruneReviewSnapshots(repoPath: string, now: number = Date.now()): Promise<string[]> {
  const env = isolatedGitEnvironment();
  const listed = requireOk("git for-each-ref", await git(repoPath,
    ["for-each-ref", "--format=%(refname) %(committerdate:unix)", `${REVIEW_SNAPSHOT_REF_PREFIX}/`], env));
  const cutoff = Math.floor((now - REVIEW_SNAPSHOT_RETENTION_MS) / 1_000);
  const pruned: string[] = [];
  for (const line of listed.split("\n").filter(Boolean)) {
    const [ref, seconds] = line.split(" ");
    const oid = ref?.slice(REVIEW_SNAPSHOT_REF_PREFIX.length + 1) ?? "";
    // Only exact generated names are ours to delete.
    if (!ref || ref !== `${REVIEW_SNAPSHOT_REF_PREFIX}/${oid}` || !OBJECT_ID.test(oid)) continue;
    if (!(Number(seconds) < cutoff)) continue;
    requireOk("git update-ref -d", await git(repoPath, ["update-ref", "-d", ref, oid], env));
    pruned.push(ref);
  }
  return pruned;
}
