import type { InspectorPr, Task } from "@shared/types.ts";
import { expectedStackBase, stackPrNumber, stackReleased, type Ancestry } from "@shared/stacking.ts";
import {
  getInspectorPr,
  latestStackLineage,
  noteInspectorPrStack,
  recordInspectorPrLineage,
  releaseInspectorPrStack,
  updateInspectorPr,
} from "../db.ts";
import { parsePrUrl, type PrSnapshot } from "../inspector/github.ts";
import type { StackGitHub } from "./github.ts";

// A stacked pull request's lineage on its Inspector row, the base it belongs on, and the
// release check that frees it to merge. All of it runs from GitHub data; nothing here runs
// git in a worktree, and the only GitHub write is a base edit.

/** What adoption needs to know about the session that opened the pull request. */
export interface LineageSource {
  /** The task the opening session is running, if any. */
  task: Task | undefined;
  /** The session's work episode at adoption. */
  episodeId: string | null;
}

/**
 * Write the lineage onto a freshly adopted pull request row, when the session that opened it
 * is running a stacked task and the pull request is in that task's PRIMARY repository.
 *
 * SYNCHRONOUS, and called in the same turn that adopts the row, before anything can inspect
 * it. That ordering is the safety property: a stacked child opened straight against the
 * default branch carries no stacking signal on GitHub, so if its row could be read before
 * its lineage was written, the merge gate would see an ordinary pull request and skip the
 * stack hold. With no await between adoption and this write there is no such window.
 *
 * "Primary repository" is decided without a network or git read: the child's pull request
 * must be in the same GitHub repository as the parent pull request it was cut on, and
 * readiness only ever stamps a parent pull request it proved is in the prerequisite's primary
 * repository (the same repository as the child's, since stacking is same-repository only).
 * A pull request in a secondary repository is therefore in a different GitHub repository
 * and gets no lineage.
 *
 * The first child pull request of a work episode is seeded from the task's dispatch. A later
 * one for the same task, repository and episode - a replacement opened after its parent
 * closed, say - copies the most recently adopted previous row's lineage unchanged, so a
 * replacement never reverts to the parent the task was originally cut on. Written once:
 * `recordInspectorPrLineage` refuses to overwrite existing lineage.
 */
export function adoptStackLineage(prKey: string, source: LineageSource, now: number): boolean {
  const row = getInspectorPr(prKey);
  const task = source.task;
  if (!row || row.stack || !task?.stackParentTaskId || !task.stackPrUrl) return false;
  const parent = parsePrUrl(task.stackPrUrl);
  if (!parent) return false;
  if (parent.owner.toLowerCase() !== row.owner.toLowerCase() || parent.repo.toLowerCase() !== row.repo.toLowerCase()) {
    return false;
  }
  const inherited = latestStackLineage(task.id, row.owner, row.repo, source.episodeId, prKey);
  return recordInspectorPrLineage(prKey, {
    taskId: task.id,
    episode: source.episodeId,
    adoptedAt: now,
    parentPrUrl: inherited?.parentPrUrl ?? task.stackPrUrl,
    baseSha: inherited ? inherited.baseSha : task.stackBaseSha ?? null,
    history: inherited?.history ?? [],
  });
}

/**
 * Point a stacked pull request at the branch it belongs on, if it is not there already.
 *
 * The expected base comes from the row's CURRENT parent, never from the task: the parent's
 * branch while it is open, and the default branch once it has merged or closed. So a
 * replacement child opened against the default branch after its parent closed is left there,
 * and nothing is ever retargeted to a finished parent's (possibly deleted) branch. Unknown
 * state retargets nothing.
 */
export async function correctStackBase(
  prKey: string,
  github: StackGitHub,
  now: number,
): Promise<"unchanged" | "retargeted" | "unknown" | "failed"> {
  const row = getInspectorPr(prKey);
  if (!row?.stack) return "unchanged";
  const cwd = row.cwd ?? row.repoRoot;
  const [parent, child] = await Promise.all([
    github.prRefs(cwd, row.stack.parentPrUrl),
    github.prRefs(cwd, row.url),
  ]);
  if (!parent.ok || !parent.value || !child.ok || !child.value) {
    noteInspectorPrStack(prKey, "could not read the stacked base from GitHub", now);
    return "unknown";
  }
  if (child.value.state !== "OPEN") return "unchanged";
  const expected = expectedStackBase(parent.value, child.value.defaultBranch || null);
  if (!expected) {
    noteInspectorPrStack(prKey, "could not work out which branch this stacked pull request belongs on", now);
    return "unknown";
  }
  if (child.value.baseRefName === expected) return "unchanged";
  const result = await github.retarget(cwd, row.owner, row.repo, row.number, expected);
  if (!result.ok) {
    noteInspectorPrStack(prKey, `could not move the base from ${child.value.baseRefName || "?"} to ${expected}: ${(result.error ?? "refused").slice(0, 160)}`, now);
    return "failed";
  }
  noteInspectorPrStack(prKey, `base moved from ${child.value.baseRefName || "?"} to ${expected}`, now);
  return "retargeted";
}

/**
 * Run the stack release check for a lineage-bearing row against the snapshot this tick just
 * read, and record the release against that exact head when it passes.
 *
 * Asked only while the base is already the default branch - before then the check cannot
 * pass, so its compare calls would buy nothing. The current parent is read from GitHub
 * rather than from the ledger, because the ledger retires a finished pull request's row
 * and may never have polled its merge.
 */
export async function refreshStackRelease(
  pr: InspectorPr,
  snapshot: PrSnapshot,
  dir: string,
  github: StackGitHub,
  now: number,
): Promise<boolean> {
  const lineage = pr.stack;
  if (!lineage || !snapshot.headSha) return false;
  if (lineage.releasedHeadSha === snapshot.headSha) return true;
  const base = snapshot.baseRefName || null;
  const defaultBranch = snapshot.defaultBranch || null;
  if (!base || !defaultBranch || base !== defaultBranch) return false;
  const parent = await github.prRefs(dir, lineage.parentPrUrl);
  if (!parent.ok || !parent.value) return false;
  const ancestry = async (commit: string | null): Promise<Ancestry> => {
    if (!commit) return null;
    const answer = await github.isAncestor(dir, pr.owner, pr.repo, commit, snapshot.headSha);
    return answer.ok && answer.value !== undefined ? answer.value : null;
  };
  const merged = parent.value.state === "MERGED";
  const closed = parent.value.state === "CLOSED";
  const released = stackReleased({
    baseRefName: base,
    defaultBranch,
    parentState: parent.value.state,
    parentMergeCommitInHead: merged ? await ancestry(parent.value.mergeCommitSha) : null,
    stackBaseInHead: closed ? await ancestry(lineage.baseSha) : null,
    parentLastHeadInHead: closed ? await ancestry(parent.value.headSha) : null,
  });
  if (!released) return false;
  releaseInspectorPrStack(pr.key, snapshot.headSha, now);
  return true;
}

/**
 * Whether the review recorded on `pr` still describes the pull request's diff, judged by the
 * base COMMIT rather than the base branch name.
 *
 * GitHub diffs a pull request from the merge base of its head and its base. A stacked
 * parent that is rebased or force-pushed keeps its branch name while that merge base moves,
 * so the child's diff changes under an unchanged head and an unchanged base name. A review
 * made before that cannot authorize a merge after it.
 *
 * - `current`: nothing to check, or GitHub confirms the merge base is the one reviewed. A
 *   base that only moved forward is recorded as the new reviewed tip, so the two compare
 *   calls run once per base move, not once per tick.
 * - `changed`: the merge base moved, or no reviewed base was recorded: review again.
 * - `unknown`: GitHub could not say for the current base: neither merge nor re-review.
 *
 * Checked only for a pull request with stack lineage or a known base other than the default
 * branch. A pull request on the default branch keeps the head-only rule: that branch
 * advancing never moves the merge base of an unchanged head.
 */
export async function reviewedStackBase(
  pr: InspectorPr,
  snapshot: PrSnapshot,
  dir: string,
  github: StackGitHub,
  now: number,
): Promise<"current" | "changed" | "unknown"> {
  const base = snapshot.baseRefName || null;
  const defaultBranch = snapshot.defaultBranch || null;
  const stacked = pr.stack !== null && pr.stack !== undefined;
  // An unknown base on an ordinary pull request is the merge gate's to refuse
  // (`base-not-default`), not a reason to stop reviewing it.
  if (!stacked && !(base && defaultBranch && base !== defaultBranch)) return "current";
  // A new head is reviewed again anyway, and the review gate matches heads first.
  if (!snapshot.headSha || snapshot.headSha !== pr.headSha) return "current";
  const tip = snapshot.baseSha || null;
  if (!tip) return "unknown";
  if (pr.reviewedBaseSha === tip) return "current";
  if (!pr.reviewedBaseSha) return "changed";
  const current = await github.mergeBase(dir, pr.owner, pr.repo, tip, snapshot.headSha);
  if (!current.ok || !current.value) return "unknown";
  // A reviewed tip GitHub no longer knows (force-pushed away and collected) cannot vouch for
  // anything: review again.
  const then = await github.mergeBase(dir, pr.owner, pr.repo, pr.reviewedBaseSha, snapshot.headSha);
  if (!then.ok || !then.value || then.value !== current.value) return "changed";
  updateInspectorPr(pr.key, { reviewedBaseSha: tip }, now);
  return "current";
}

/** The parent's state as far as the local ledger knows it, without asking GitHub. */
function ledgerParentState(parentPrUrl: string): "OPEN" | "CLOSED" | "MERGED" | null {
  const parsed = parsePrUrl(parentPrUrl);
  const row = parsed ? getInspectorPr(parsed.key) : null;
  if (!row) return null;
  if (row.mergedAt !== null || row.observedState === "MERGED") return "MERGED";
  if (row.observedState === "CLOSED") return "CLOSED";
  if (row.state === "open" && row.observedState === "OPEN") return "OPEN";
  return null;
}

/**
 * What to tell a stacked task's session about the base of the pull request it opens.
 *
 * Computed from the same expected-base rule base correction uses, at the moment the text is
 * built: the current parent (the most recently adopted lineage row of this task's current
 * episode, else the parent the task was cut on) and that parent's state as the ledger last
 * observed it. When that state is unknown the sentence states the rule instead of guessing.
 * Null for a task that is not stacked.
 */
export function stackPrInstruction(task: Task, episodeId: string | null | undefined): string | null {
  if (!task.stackParentTaskId || !task.stackPrUrl) return null;
  const parsed = parsePrUrl(task.stackPrUrl);
  if (!parsed) return null;
  // `undefined` is a launch: a brand-new episode that has no pull request row yet, so the
  // parent is the one this dispatch was just cut on and nothing is looked up.
  const lineage = episodeId === undefined
    ? null
    : latestStackLineage(task.id, parsed.owner, parsed.repo, episodeId, "");
  const parentUrl = lineage?.parentPrUrl ?? task.stackPrUrl;
  const number = stackPrNumber(parentUrl);
  const parentKey = parsePrUrl(parentUrl)?.key;
  const parentRow = parentKey ? getInspectorPr(parentKey) : null;
  const branch = parentRow?.headRefName ?? (lineage ? null : task.stackBaseBranch ?? null);
  const state = ledgerParentState(parentUrl) ?? (lineage ? null : "OPEN");
  const stackedLine = `Start the pull request description with "Stacked on #${number ?? "?"}" (${parentUrl}).`;
  const lines = ["## Stacked pull request", `This task is stacked on ${parentUrl}.`];
  if (state === "OPEN" && branch) {
    lines.push(
      `Open its pull request in this repository with \`gh pr create --base ${branch}\`, not against the default branch.`,
      stackedLine,
    );
  } else if (state === "MERGED" || state === "CLOSED") {
    lines.push(
      `That pull request has ${state === "MERGED" ? "merged" : "closed"}, so open this one against the repository's default branch.`,
      stackedLine,
    );
  } else {
    lines.push(
      `While #${number ?? "?"} is open, open this pull request with \`--base\` set to its head branch${branch ? ` (${branch})` : ""}. If it has merged or closed, open it against the repository's default branch.`,
      stackedLine,
    );
  }
  lines.push("Mission Control corrects the base automatically if it is wrong, and never merges a pull request whose base is not the default branch.");
  return lines.join("\n");
}
