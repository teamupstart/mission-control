// "Which of a task's repositories did this task actually CHANGE?" - defined once, because
// two subsystems decide something irreversible from the answer.
//
// Completion reads it to know which pull requests the all-merged quorum is waiting for, and
// per-repo review runs read it to know which repositories get a full review. A drifting
// second copy is not a display bug in either: one would complete a task while work sat
// unmerged, the other would ship a repository's changes unreviewed.
//
// It lives in `src/shared` for that reason rather than for reuse. Both consumers are
// server-side today; the point is that "changed" has ONE definition and neither owns it.
//
// The rule the whole thing turns on: **the primary repository is a repository.** A task's
// primary lives on the `tasks` row and its secondaries live in `task_repos`, so a version
// that iterates `task_repos` alone silently drops the primary - and a task whose primary
// changed without opening a primary pull request would then complete on a merged secondary
// alone, shipping the primary's work unmerged, and would never get a review run for it.
// `taskRepoRefs` is the only enumeration in the codebase that returns both, and every
// function here is built on it so nothing can iterate half a task by accident.

import type {
  RepoPrFeedback,
  Task,
  TaskRepoEntry,
  TaskRepoPrSummary,
  WorktreeProvider,
} from "./types.ts";

/** Which half of the additive data shape an entry came from. */
export type TaskRepoRole = "primary" | "secondary";

/**
 * One repository attached to a task, primary and secondary flattened onto one shape.
 *
 * `position` is the provisioning slot: 0 is always the primary (whose worktree the session
 * runs in), and each secondary carries its `task_repos` position. Nothing here may be
 * renumbered without moving the corresponding tree - see `worktreeSlotPath`.
 */
export interface TaskRepoRef {
  repoRoot: string;
  worktreePath: string | null;
  branch: string | null;
  provider: WorktreeProvider | null;
  baseSha: string | null;
  role: TaskRepoRole;
  position: number;
}

/** The narrowest task shape this module reads, so a test can build one by hand. */
export type TaskRepoSource = Pick<
  Task,
  "repoRoot" | "worktreePath" | "branch" | "provider" | "baseSha"
> & { extraRepos: readonly TaskRepoEntry[] };

/**
 * Every repository this task is attached to, primary FIRST, then secondaries in position
 * order.
 *
 * Primary first is load-bearing rather than cosmetic: `outcomeUrl` keeps the primary's pull
 * request for back-compat, and the report and cards list repositories in this order, so the
 * one repo an operator scanning a list sees first is the one the session's cwd is in.
 *
 * A single-repo task returns exactly one entry, which is what keeps every rule built on this
 * identical to today's behavior for the tasks that are nearly all of them.
 */
export function taskRepoRefs(task: TaskRepoSource): TaskRepoRef[] {
  return [
    {
      repoRoot: task.repoRoot,
      worktreePath: task.worktreePath,
      branch: task.branch,
      provider: task.provider,
      baseSha: task.baseSha,
      role: "primary",
      position: 0,
    },
    ...task.extraRepos.map((entry, index) => ({
      repoRoot: entry.repoRoot,
      worktreePath: entry.worktreePath,
      branch: entry.branch,
      provider: entry.provider,
      baseSha: entry.baseSha,
      role: "secondary" as const,
      position: index + 1,
    })),
  ];
}

/**
 * Every repository of a MULTI-repo task with the pull request it has produced, primary
 * first - the list a card, a console and the report all draw.
 *
 * Empty for a single-repo task, and that emptiness is what keeps single-repo markup
 * byte-identical: each surface renders this only when it is non-empty and otherwise draws
 * exactly what it drew before.
 *
 * The primary's pull request is passed in rather than read off `task`, because it does not
 * live on the task row at all - it lives on the work-episode binding, which is server-side
 * state. This function's job is to put it in the same list as the secondaries, so no surface
 * has to remember that the primary is stored somewhere else.
 *
 * `feedbackFor` is passed in for the same reason and answers for the primary and the
 * secondaries alike: the live observation lives in the registry, keyed on what the poller
 * asked, and nothing here should know where. It returns null whenever the last poll saw no
 * open pull request for that repository - see `TaskRepoPrSummary.feedback`.
 */
export function taskRepoPrSummaries(
  task: TaskRepoSource,
  primaryPr: { prUrl: string | null; prState: string | null; mergedAt: number | null },
  feedbackFor: (repoRoot: string, prUrl: string | null) => RepoPrFeedback | null,
): TaskRepoPrSummary[] {
  if (task.extraRepos.length === 0) return [];
  return taskRepoRefs(task).map((ref) => {
    const entry = ref.role === "primary" ? null : task.extraRepos[ref.position - 1];
    const prUrl = entry ? entry.prUrl : primaryPr.prUrl;
    return {
      repoRoot: ref.repoRoot,
      primary: ref.role === "primary",
      prUrl,
      prState: entry ? entry.prState : primaryPr.prState,
      mergedAt: entry ? entry.mergedAt : primaryPr.mergedAt,
      feedback: feedbackFor(ref.repoRoot, prUrl),
    };
  });
}

/**
 * What is known about one repository's work on one task.
 *
 * `headSha` has THREE states and the difference between two of them decides whether a task
 * completes:
 *
 *  - a string: the worktree's head as last observed.
 *  - `null`: something looked and could not answer - the worktree is gone, or `git` failed.
 *    Read as "unchanged", which is the only answer that lets a task whose checkouts were
 *    torn down ever complete.
 *  - `undefined`: nothing has looked yet. Read as "unknown", which HOLDS completion rather
 *    than allowing it. The distinction exists because the observation is asynchronous: a
 *    reconciler pass that ran before the first head sweep would otherwise read every repo as
 *    unchanged and complete a task on one merged sibling.
 */
export interface RepoWorkFacts {
  /** The pull request this task opened in this repository, or null if none is known. */
  prUrl: string | null;
  /** When that pull request was observed merged, or null. */
  mergedAt?: number | null;
  /** Last observed worktree head. See the three states above. */
  headSha?: string | null;
}

/**
 * Did this task change this repository?
 *
 * `"unknown"` is not a third kind of change, it is an admission that the head has not been
 * read yet - every consumer must treat it as "do not conclude anything".
 */
export type RepoChangeVerdict = "changed" | "unchanged" | "unknown";

/**
 * The one definition of "this task changed this repository".
 *
 * Two ways in, and both are needed:
 *
 *  - **It opened a pull request here.** Proof, and it survives teardown: the pull request is
 *    a durable record where a worktree is not. This clause alone is why a task whose
 *    checkouts were reclaimed still knows what it owes.
 *  - **Its head moved off the baseline the branch was cut at.** The clause that catches an
 *    agent who committed here and never opened a pull request - the case that makes a
 *    quorum built on pull requests alone unsound.
 *
 * Everything else reads as unchanged, and each of those is a deliberate "we cannot tell, so
 * do not hold the task hostage": no baseline recorded (every task dispatched before the
 * column existed), no worktree provisioned, or a head read that came back empty.
 */
export function repoChangeVerdict(ref: TaskRepoRef, facts: RepoWorkFacts): RepoChangeVerdict {
  if (facts.prUrl !== null) return "changed";
  if (ref.baseSha === null || ref.worktreePath === null) return "unchanged";
  if (facts.headSha === undefined) return "unknown";
  if (facts.headSha === null) return "unchanged";
  return facts.headSha === ref.baseSha ? "unchanged" : "changed";
}

/** One repository's ref paired with the verdict and the facts it was reached from. */
export interface TaskRepoStatus {
  ref: TaskRepoRef;
  facts: RepoWorkFacts;
  verdict: RepoChangeVerdict;
}

/**
 * Every repository on the task, with its change verdict. The single fan-out both consumers
 * start from - completion filters it for what to wait on, run creation for what to review.
 */
export function taskRepoStatuses(
  task: TaskRepoSource,
  factsFor: (ref: TaskRepoRef) => RepoWorkFacts,
): TaskRepoStatus[] {
  return taskRepoRefs(task).map((ref) => {
    const facts = factsFor(ref);
    return { ref, facts, verdict: repoChangeVerdict(ref, facts) };
  });
}

/** The changed set: exactly the repositories this task owes a merged pull request for. */
export function changedTaskRepos(
  task: TaskRepoSource,
  factsFor: (ref: TaskRepoRef) => RepoWorkFacts,
): TaskRepoStatus[] {
  return taskRepoStatuses(task, factsFor).filter((entry) => entry.verdict === "changed");
}

/** Why the all-merged quorum is not satisfied yet. */
export type QuorumHold =
  /** A changed repository whose pull request has not merged (or was never opened). */
  | { reason: "unmerged"; ref: TaskRepoRef; prUrl: string | null }
  /** A repository whose head has not been observed, so its membership is undecided. */
  | { reason: "unobserved"; ref: TaskRepoRef };

export interface MergedRepoPr {
  repoRoot: string;
  prUrl: string;
  mergedAt: number;
  role: TaskRepoRole;
}

/**
 * The adopted all-merged completion quorum: a multi-repo task completes when EVERY repo in
 * its changed set has a merged pull request, and not before.
 *
 * `holds` is the answer to "why not yet", in the order the repos are attached, and it is
 * what a surface shows an operator staring at a task that has one green pull request and is
 * still running. An empty `holds` with an empty `merged` is not satisfaction - it means the
 * task changed nothing anyone can see, which no merge should conclude.
 *
 * Auto-merge is deliberately untouched by this: each pull request still merges on its own
 * per-PR verdict (adopted decision 4). This decides when the TASK is done, never when a
 * pull request may land.
 */
export interface QuorumVerdict {
  satisfied: boolean;
  merged: MergedRepoPr[];
  holds: QuorumHold[];
}

export function taskMergeQuorum(
  task: TaskRepoSource,
  factsFor: (ref: TaskRepoRef) => RepoWorkFacts,
): QuorumVerdict {
  const merged: MergedRepoPr[] = [];
  const holds: QuorumHold[] = [];
  for (const { ref, facts, verdict } of taskRepoStatuses(task, factsFor)) {
    if (verdict === "unknown") {
      holds.push({ reason: "unobserved", ref });
      continue;
    }
    if (verdict === "unchanged") continue;
    if (facts.prUrl !== null && typeof facts.mergedAt === "number") {
      merged.push({
        repoRoot: ref.repoRoot,
        prUrl: facts.prUrl,
        mergedAt: facts.mergedAt,
        role: ref.role,
      });
      continue;
    }
    holds.push({ reason: "unmerged", ref, prUrl: facts.prUrl });
  }
  return { satisfied: holds.length === 0 && merged.length > 0, merged, holds };
}
