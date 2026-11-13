import type { ShippingConfig } from "./protocol.ts";
import type { Task, TaskDependency } from "./types.ts";
import { isWorkDependency } from "./task-dependency.ts";

// Stacked pull requests: the shared rules that decide when a dependent task may start on
// its prerequisite's open pull request instead of waiting for it to merge, which branch its
// own pull request belongs on, and when a stacked pull request is released to merge.
//
// Shared rather than server-only for the reason every predicate beside it is: the daemon
// acts on these and the board explains them, and the two must not disagree about why a
// card is waiting. See `docs/inspector-and-shipping.md#stacked-pull-requests`.

/** How one same-repository dependency releases its dependent. */
export type StackingMode = "merge" | "stack";

/**
 * What an install that never chose a Stacked pull requests value follows.
 *
 * `stack`, now that the lifecycle half exists: a stacked child is caught up when its parent
 * moves, retargeted and prompted to restack when its parent merges, and held with a named
 * reason and an action when its stack breaks. Whether it then lands with no manual step depends
 * on the conditions in `docs/inspector-and-shipping.md` ("When a stack lands by itself"); when
 * one fails, the child's merge-queue row says what holds it. It was
 * `merge` while only the stacked-start half existed. Nothing writes `ShippingConfig.stacking` except
 * an explicit operator choice, so this moves every install that never chose and no other: an
 * explicit *Wait for merge* and every edge with its own `mode` are kept.
 */
export const STACKING_SHIPPED_DEFAULT: StackingMode = "stack";

/** Bounds and default for `ShippingConfig.maxStackDepth`. */
export const STACK_DEPTH_LIMITS = { min: 1, max: 5, default: 3 } as const;

/** The Shipping default an edge with no `mode` inherits right now. */
export function effectiveStacking(config: Pick<ShippingConfig, "stacking">): StackingMode {
  return config.stacking ?? STACKING_SHIPPED_DEFAULT;
}

/** A task or session edge: the two kinds an operator can declare a mode on. */
export type ModalDependency = Exclude<TaskDependency, { type: "plan" }>;
type TaskEdge = Extract<TaskDependency, { type: "task" }>;

/**
 * The mode one edge is in: its own `mode`, or the Shipping default when it has none.
 *
 * Plan-publication edges never stack. They wait for a publication receipt, which has no
 * branch to start from.
 */
export function effectiveEdgeMode(
  edge: TaskDependency,
  config: Pick<ShippingConfig, "stacking">,
): StackingMode {
  if (!isWorkDependency(edge)) return "merge";
  return edge.mode ?? effectiveStacking(config);
}

/** Why a stack-mode edge still waits for merge, in the words a card shows. */
export type StackWaitCode =
  | "after-merge"
  | "not-a-task"
  | "prerequisite-gone"
  | "prerequisite-stopped"
  | "other-repository"
  | "several-unmerged"
  | "cross-repository-unmerged"
  | "secondary-unmerged"
  | "too-deep";

export type StackEligibility =
  | { ok: true; edge: TaskEdge; parent: Task }
  | { ok: false; code: StackWaitCode; reason: string; edge: ModalDependency | null };

function unmergedTaskEdges(task: Task): TaskEdge[] {
  return task.dependencies.filter(
    (edge): edge is TaskEdge => edge.type === "task" && edge.satisfiedAt === null,
  );
}

/**
 * How many unmerged stacked pull requests sit under `task`, counting `task` itself as one
 * once it is stacked: zero for a task cut from its default branch, one for a task stacked on
 * a task cut from its default branch, and so on.
 *
 * Read from what each task RECORDED at dispatch (`stackParentTaskId`) and whether its edge
 * to that parent has merged since, so a parent that merged shortens every stack above it.
 */
export function stackDepth(task: Task, byId: ReadonlyMap<string, Task>): number {
  const visited = new Set<string>();
  let depth = 0;
  let current: Task | undefined = task;
  while (current?.stackParentTaskId && !visited.has(current.id)) {
    visited.add(current.id);
    const parentId: string = current.stackParentTaskId;
    const edge = current.dependencies.find(
      (candidate) => candidate.type === "task" && candidate.taskId === parentId,
    );
    if (!edge || edge.satisfiedAt !== null) break;
    depth += 1;
    current = byId.get(parentId);
  }
  return depth;
}

/**
 * The structural half of eligibility, which needs no Shipping config: the single unmerged
 * same-repository prerequisite this task could stack on, or why there is none.
 *
 * Kept apart from `stackEligibility` because some readers of the blocker predicate run
 * without the config (Foreman's worker, the Line). They read the daemon's readiness stamp
 * for the config-dependent half instead; the daemon stamps only an edge that passes the full
 * rule and clears the stamp when it stops passing.
 */
export function stackCandidate(
  task: Task,
  byId: ReadonlyMap<string, Task>,
): StackEligibility {
  const unmerged = unmergedTaskEdges(task);
  const sameRepo: { edge: TaskEdge; parent: Task }[] = [];
  for (const edge of unmerged) {
    const parent = byId.get(edge.taskId);
    if (!parent) {
      return { ok: false, code: "prerequisite-gone", reason: `${edge.title} is no longer on the board`, edge };
    }
    if (parent.repoRoot === task.repoRoot) {
      sameRepo.push({ edge, parent });
      continue;
    }
    return {
      ok: false,
      code: "cross-repository-unmerged",
      reason: `${parent.title} is in another repository, so it has to merge first`,
      edge,
    };
  }
  const unmergedSession = task.dependencies.find(
    (edge): edge is Extract<TaskDependency, { type: "session" }> =>
      edge.type === "session" && edge.satisfiedAt === null,
  );
  if (unmergedSession) {
    return {
      ok: false,
      code: "not-a-task",
      reason: `${unmergedSession.title} has no task to stack on, so it has to merge first`,
      edge: unmergedSession,
    };
  }
  if (sameRepo.length !== 1) {
    return {
      ok: false,
      code: "several-unmerged",
      reason: "two prerequisites in this repository are unmerged, and a pull request has one base",
      edge: sameRepo[0]?.edge ?? null,
    };
  }
  const { edge, parent } = sameRepo[0]!;
  if (parent.status === "cancelled" || parent.status === "failed") {
    return { ok: false, code: "prerequisite-stopped", reason: `${parent.title} is ${parent.status}`, edge };
  }
  const openSecondary = parent.extraRepos.find((repo) => repo.prUrl && repo.mergedAt === null);
  if (openSecondary) {
    return {
      ok: false,
      code: "secondary-unmerged",
      reason: `${parent.title} has an unmerged change in another repository`,
      edge,
    };
  }
  return { ok: true, edge, parent };
}

/**
 * May `task` stack on one of its prerequisites, and on which edge?
 *
 * Every condition of the Stacked pull requests rule: the edge is in stack mode; it is the
 * only unmerged same-repository prerequisite; every prerequisite in another repository and
 * every secondary repository the parent changed has merged; and the stack under the parent
 * is shorter than the depth cap. Whether the parent has an open pull request and an idle
 * agent is not asked here: that is the daemon's readiness stamp.
 */
export function stackEligibility(
  task: Task,
  tasks: readonly Task[] | ReadonlyMap<string, Task>,
  config: Pick<ShippingConfig, "stacking" | "maxStackDepth">,
): StackEligibility {
  const byId = tasks instanceof Map
    ? tasks as ReadonlyMap<string, Task>
    : new Map((tasks as readonly Task[]).map((candidate) => [candidate.id, candidate]));
  const candidate = stackCandidate(task, byId);
  if (!candidate.ok) return candidate;
  if (effectiveEdgeMode(candidate.edge, config) !== "stack") {
    return { ok: false, code: "after-merge", reason: "set to start after merge", edge: candidate.edge };
  }
  const max = config.maxStackDepth ?? STACK_DEPTH_LIMITS.default;
  if (stackDepth(candidate.parent, byId) + 1 > max) {
    return {
      ok: false,
      code: "too-deep",
      reason: `the stack under ${candidate.parent.title} is already ${max} deep`,
      edge: candidate.edge,
    };
  }
  return candidate;
}

/**
 * The edge whose readiness stamp lets `task` start before its prerequisite merges, or null.
 *
 * The config-free reading the shared blocker predicate uses: the structural rule, an edge
 * not explicitly set to wait for merge, and a recorded `stackReadyAt`. An absent or null
 * stamp is unstamped, so an edge written before stacking existed never releases anything.
 */
export function stackStartEdge(task: Task, byId: ReadonlyMap<string, Task>): TaskEdge | null {
  const candidate = stackCandidate(task, byId);
  if (!candidate.ok) return null;
  if (candidate.edge.mode === "merge") return null;
  return typeof candidate.edge.stackReadyAt === "number" ? candidate.edge : null;
}

/** A parent pull request's state, as far as the expected base needs it. */
export interface StackParentState {
  state: "OPEN" | "CLOSED" | "MERGED" | null;
  headRefName: string | null;
}

/**
 * The branch a stacked child pull request belongs on right now.
 *
 * The parent's head branch while the parent is open, and the default branch once it has
 * merged or closed, so nothing is ever pointed at a branch whose pull request is finished
 * (and which may already be deleted). Null when either fact is unknown: a caller that cannot
 * name the base must not guess one.
 */
export function expectedStackBase(
  parent: StackParentState | null,
  defaultBranch: string | null,
): string | null {
  if (!parent || parent.state === null) return null;
  if (parent.state === "OPEN") return parent.headRefName || null;
  return defaultBranch || null;
}

/**
 * Whether one commit is in the child head's ancestry: true, false, or null when GitHub could
 * not be asked or did not answer.
 */
export type Ancestry = boolean | null;

/** Everything the release check reads, all observed from GitHub on the Inspector tick. */
export interface StackReleaseFacts {
  /** The child pull request's current base, or null when unknown. */
  baseRefName: string | null;
  defaultBranch: string | null;
  /** The CURRENT parent's state. */
  parentState: "OPEN" | "CLOSED" | "MERGED" | null;
  /** Merged parent: is its merge commit in the child head's ancestry? */
  parentMergeCommitInHead: Ancestry;
  /** Closed parent: is the commit the child was cut at in the child head's ancestry? */
  stackBaseInHead: Ancestry;
  /** Closed parent: is the parent's last observed head in the child head's ancestry? */
  parentLastHeadInHead: Ancestry;
}

/**
 * Has this stacked pull request been restacked, or moved off a closed parent?
 *
 * Exactly two ways to pass, both requiring the default branch as the base:
 *
 * - the parent merged, and its merge commit is in the child's ancestry;
 * - the parent closed without merging, and neither the commit the child was cut at nor the
 *   parent's last head is in the child's ancestry - the child no longer carries the parent's
 *   unmerged code. The cut commit is what makes this safe when the parent pushed again before
 *   closing: its last head is then absent while its earlier commits are not.
 *
 * Anything unknown holds. A base change alone is never enough, because GitHub retargets a
 * child by itself when the parent's branch is deleted.
 */
export function stackReleased(facts: StackReleaseFacts): boolean {
  if (!facts.baseRefName || !facts.defaultBranch) return false;
  if (facts.baseRefName !== facts.defaultBranch) return false;
  if (facts.parentState === "MERGED") return facts.parentMergeCommitInHead === true;
  if (facts.parentState === "CLOSED") {
    return facts.stackBaseInHead === false && facts.parentLastHeadInHead === false;
  }
  return false;
}

/**
 * An edge without its readiness stamp. "Unstamped" is the ABSENCE of the four fields, never a
 * set of nulls, so an edge that was stamped and cleared has the same shape as one that never
 * was - in memory and as read back from SQLite.
 */
export function withoutStackStamp<T extends TaskDependency>(edge: T): T {
  if (!isWorkDependency(edge)) return edge;
  const { stackReadyAt: _a, stackBaseBranch: _b, stackBaseSha: _c, stackPrUrl: _d, ...rest } = edge;
  return rest as T;
}

/** The pull request number in a GitHub pull request URL, for "Stacked on #N". */
export function stackPrNumber(url: string | null | undefined): number | null {
  const match = /\/pull\/(\d+)(?:[/?#]|$)/.exec(url ?? "");
  return match ? Number(match[1]) : null;
}

/** "Stacked on #N", or null for a task that was not cut on a parent. */
export function stackedOnLabel(task: Pick<Task, "stackParentTaskId" | "stackPrUrl">): string | null {
  if (!task.stackParentTaskId) return null;
  const number = stackPrNumber(task.stackPrUrl);
  return number === null ? "Stacked on its prerequisite" : `Stacked on #${number}`;
}

// ---- Stack lifecycle (the half that keeps a stack landable) ----
//
// Everything below is derived from a pull request ROW's lineage and what the Inspector tick
// last observed about it, never from the task or the Shipping setting, so it still answers
// after the session is gone and with stacking switched off. None of it is a gate: Phase 1's
// `stacked-base` and `stack-hold` stay the only stacking values `mergeVerdict` returns, and
// only the release check releases anything. These states decide what to SAY about a held
// child and which prompt or action brings it to the state the release check accepts.

/**
 * Where one stacked child stands. When more than one applies, the first in this order wins,
 * so a terminal parent outcome always beats a catch-up: a parent that advanced and then merged
 * or closed is never sent a catch-up prompt.
 */
export const STACK_STATES = [
  "released",
  "merge-unconfirmed",
  "broken",
  "parent-merged-needs-retarget",
  "restack-needed",
  "parent-moved",
  "current",
] as const;
export type StackState = (typeof STACK_STATES)[number];

/** Why a stack is broken. */
export type StackBrokenReason =
  /** The current parent pull request closed without merging. */
  | "parent-closed"
  /** The parent task was cancelled, failed or rescheduled while its pull request was open. */
  | "parent-task-stopped"
  /** GitHub closed the child itself, which is what deleting its base branch does. */
  | "child-closed"
  /**
   * The child merged, but into its parent's branch rather than the default branch - a person
   * merged it on GitHub before it was retargeted. Its code is not on the default branch, so it
   * completes nothing (see `mergeLandedOnDefault`).
   */
  | "merged-into-parent"
  /**
   * The child merged into some other branch that is neither the default branch nor its
   * parent's (its base was changed by hand, say). It completes nothing either, but the
   * parent-branch recovery does not describe it, so none is offered.
   */
  | "merged-off-default";

/**
 * What the Inspector tick last observed about one stacked child and its current parent.
 * Persisted on the row (`inspector_prs.stack_state`) as JSON; every field is optional on read,
 * so an observation written by an older build parses and reads as unknown where it is silent.
 */
export interface StackObservation {
  observedAt: number;
  /** The child's own state and head when this was observed. */
  childState: "OPEN" | "CLOSED" | "MERGED" | null;
  childHeadSha: string | null;
  baseRefName: string | null;
  defaultBranch: string | null;
  /** The current parent, as read from GitHub on this tick. */
  parentUrl: string;
  parentState: "OPEN" | "CLOSED" | "MERGED" | null;
  parentHeadSha: string | null;
  parentHeadRefName: string | null;
  parentMergeCommitSha: string | null;
  /** Open parent: is its head in the child's history? Null when unknown or not asked. */
  parentHeadInChild: Ancestry;
  /**
   * How many commits the child's base has that its head does not, from GitHub's compare API.
   * Named for the base rather than the stack so a default-branch staleness check can reuse it.
   */
  baseBehindBy: number | null;
  /**
   * The parent task's state, when it ended the parent's work before its pull request did:
   * cancelled or failed, or rescheduled (back in the backlog, not yet started again).
   */
  parentTaskStopped: "cancelled" | "failed" | "rescheduled" | null;
  /** The parent task, so the action that restarts it can name it. Null when unknown. */
  parentTaskId: string | null;
  /** The parent task's work episode its current pull request belongs to, once seen. */
  parentEpisodeId: string | null;
  /** GitHub's reason the last base reconciliation failed; null once one succeeds. */
  retargetError: string | null;
  /** The child's merge commit and merge instant (epoch ms), once it merged. */
  childMergeCommitSha?: string | null;
  childMergedAt?: number | null;
  /** When the current parent merged (epoch ms), once it has. */
  parentMergedAt?: number | null;
  /**
   * When a tick last failed to read the current parent, if it has not been read since. The
   * facts above are then the last ones GitHub gave and may be stale - the parent may have
   * merged or closed - so nothing is prompted or offered on them until a read succeeds.
   */
  parentUnreadSince?: number | null;
}

/** The facts `deriveStackState` reads, all from the row and its observation. */
export interface StackStateFacts {
  observation: StackObservation | null;
  /** Phase 1's release record: the head the release check passed for. */
  releasedHeadSha: string | null;
}

/** Read a persisted observation defensively: anything malformed reads as no observation. */
export function parseStackObservation(raw: string | null | undefined): StackObservation | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown> | null;
    if (!value || typeof value !== "object" || typeof value.parentUrl !== "string") return null;
    const str = (key: string): string | null => (typeof value[key] === "string" && value[key] ? value[key] as string : null);
    const prState = (key: string): StackObservation["parentState"] =>
      value[key] === "OPEN" || value[key] === "CLOSED" || value[key] === "MERGED" ? value[key] : null;
    const stopped = value.parentTaskStopped;
    return {
      observedAt: typeof value.observedAt === "number" ? value.observedAt : 0,
      childState: prState("childState"),
      childHeadSha: str("childHeadSha"),
      baseRefName: str("baseRefName"),
      defaultBranch: str("defaultBranch"),
      parentUrl: value.parentUrl,
      parentState: prState("parentState"),
      parentHeadSha: str("parentHeadSha"),
      parentHeadRefName: str("parentHeadRefName"),
      parentMergeCommitSha: str("parentMergeCommitSha"),
      parentHeadInChild: typeof value.parentHeadInChild === "boolean" ? value.parentHeadInChild : null,
      baseBehindBy: typeof value.baseBehindBy === "number" ? value.baseBehindBy : null,
      parentTaskStopped: stopped === "cancelled" || stopped === "failed" || stopped === "rescheduled" ? stopped : null,
      parentEpisodeId: str("parentEpisodeId"),
      parentTaskId: str("parentTaskId"),
      retargetError: str("retargetError"),
      parentUnreadSince: typeof value.parentUnreadSince === "number" ? value.parentUnreadSince : null,
      // Written only once known, so an observation of an unmerged stack keeps its old shape.
      ...(str("childMergeCommitSha") ? { childMergeCommitSha: str("childMergeCommitSha") } : {}),
      ...(typeof value.childMergedAt === "number" ? { childMergedAt: value.childMergedAt } : {}),
      ...(typeof value.parentMergedAt === "number" ? { parentMergedAt: value.parentMergedAt } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * The lifecycle state of one stacked child, by the fixed precedence above.
 *
 * - `released`: Phase 1's release check passed for the child's current head, or the child
 *   merged into the default branch.
 * - `merge-unconfirmed`: the child merged, but GitHub has not yet reported both the branch it
 *   merged into and the default branch, so whether it landed is unknown.
 * - `broken`: the parent closed unmerged, the parent task stopped while its pull request was
 *   still open, GitHub closed the child, or the child merged into its parent's branch.
 * - `parent-merged-needs-retarget`: the parent merged and the child's base is still not the
 *   default branch.
 * - `restack-needed`: the parent merged, the child is on the default branch, and the release
 *   check has not passed for its head - which covers a head changed by an unrelated push.
 * - `parent-moved`: the parent is open and its head is not in the child's history.
 * - `current`: none of the above, including anything not yet observed.
 */
export function deriveStackState(facts: StackStateFacts): StackState {
  const o = facts.observation;
  const head = o?.childHeadSha ?? null;
  if (o?.childState === "MERGED") {
    // Released only once GitHub has said the merge landed on the default branch. Until both
    // branches are read the merge is unresolved - the poller holds it the same way - so the
    // stack keeps saying so rather than reading as finished.
    const landed = mergeLandedOnDefault(o.baseRefName, o.defaultBranch);
    return landed === null ? "merge-unconfirmed" : landed ? "released" : "broken";
  }
  if (head && facts.releasedHeadSha === head && o?.childState !== "CLOSED") return "released";
  if (!o) return "current";
  if (stackBrokenReason(o)) return "broken";
  if (o.parentState === "MERGED") {
    if (!o.baseRefName || !o.defaultBranch || o.baseRefName !== o.defaultBranch) return "parent-merged-needs-retarget";
    return "restack-needed";
  }
  if (o.parentState === "OPEN" && o.parentHeadInChild === false) return "parent-moved";
  return "current";
}

/** Why the stack is broken, or null when it is not. Precedence: the child, then the parent. */
export function stackBrokenReason(o: StackObservation): StackBrokenReason | null {
  if (mergedIntoParentBranch(o)) return "merged-into-parent";
  if (mergedOffDefault(o)) return "merged-off-default";
  if (o.childState === "CLOSED") return "child-closed";
  if (o.parentState === "CLOSED") return "parent-closed";
  // Only while the parent's pull request is still open: a parent task stopped AFTER its pull
  // request merged has already landed what the child is built on.
  if (o.parentState === "OPEN" && o.parentTaskStopped) return "parent-task-stopped";
  return null;
}

/**
 * Whether a merge landed on the repository's default branch. Only that merge completes work:
 * a stacked child merged into its parent's branch has not reached the default branch, so it
 * must not mark its work episode merged, complete its task or satisfy a dependency edge.
 * Null when either branch is unknown - the caller holds rather than guesses.
 */
export function mergeLandedOnDefault(baseRefName: string | null | undefined, defaultBranch: string | null | undefined): boolean | null {
  if (!baseRefName || !defaultBranch) return null;
  return baseRefName === defaultBranch;
}

/** The child merged, and the branch it merged into is known not to be the default branch. */
function mergedOffDefault(o: StackObservation): boolean {
  return o.childState === "MERGED" && mergeLandedOnDefault(o.baseRefName, o.defaultBranch) === false;
}

/** It merged off the default branch, and the branch it merged into is its parent's. */
function mergedIntoParentBranch(o: StackObservation): boolean {
  return mergedOffDefault(o) && Boolean(o.parentHeadRefName) && o.baseRefName === o.parentHeadRefName;
}

/**
 * The child merged into its parent's branch AFTER the parent had already merged, so the merge
 * went into a branch that was finished with and its changes reached nothing. Exactly the case
 * the recovery prompt answers. A child merged into a parent that was still open is not offered
 * one: the parent's later merge may have carried its changes, which nothing here verifies, so the
 * operator decides. Judged by merge times only; unknown instants decide nothing.
 */
export function strayMergeAfterParent(o: StackObservation): boolean {
  return mergedIntoParentBranch(o) && o.parentState === "MERGED"
    && typeof o.parentMergedAt === "number" && typeof o.childMergedAt === "number"
    // Strictly later: equal reported times do not establish which merged first, and the
    // prompt asserts the parent had already merged. A tie is left to the operator.
    && o.parentMergedAt < o.childMergedAt;
}

/**
 * The child merged into its parent's branch and the parent has merged, but GitHub has not yet
 * reported a fact the recovery needs: the child's merge commit (the prompt's key and the diff it
 * names) or either merge time (whether the parent merged first). Until all three are known the
 * recovery can be neither offered nor ruled out, so the merged child is read again.
 */
export function strayMergeUndecided(o: StackObservation): boolean {
  return mergedIntoParentBranch(o) && o.parentState === "MERGED"
    && (!o.childMergeCommitSha || typeof o.childMergedAt !== "number" || typeof o.parentMergedAt !== "number");
}

/**
 * The prompts Foreman types into a child's session: the two that bring a held child up to date,
 * and the recovery for a child merged into its finished parent's branch.
 */
export type StackPromptKind = "catch-up" | "restack" | "recover-merge";

/** Whether a stack prompt or action kind is a prompt (claimed by its tip) rather than an action. */
export function isStackPromptKind(kind: StackPromptKind | StackPromptActionKind): kind is StackPromptKind {
  return kind === "catch-up" || kind === "restack" || kind === "recover-merge";
}
/** The broken-stack actions typed into the child's session as a prompt. */
export type StackPromptActionKind = "move-onto-main" | "reopen-against-main" | "reopen-on-parent";
/**
 * The broken-stack actions an operator can take: the two prompts above, *Wait for a
 * replacement*, and restarting a stopped parent task through the task's own reschedule and
 * dispatch controls.
 */
export type StackActionKind = StackPromptActionKind | "await-replacement" | "reschedule-parent" | "start-parent";

/**
 * The prompt this child needs right now, and the tip that makes it necessary - or null.
 *
 * Keyed to the CONDITION, never to the child's head: the parent's head for a catch-up, the
 * parent's merge commit for a restack. An unrelated push to the child therefore never re-sends
 * the same prompt, and a new parent tip (it pushed again, or a different parent merged after a
 * replacement) is a new key and re-arms it. A recovery is keyed to the child's own merge
 * commit: the stray merge it recovers can only ever happen once.
 */
export function stackPromptNeed(state: StackState, o: StackObservation | null): { kind: StackPromptKind; tip: string } | null {
  // Never on facts the last read could not confirm: a parent that merged or closed since would
  // turn a catch-up into an instruction to merge a branch that no longer exists.
  if (!o || o.parentUnreadSince) return null;
  if (state === "broken" && strayMergeAfterParent(o) && o.childMergeCommitSha) {
    return { kind: "recover-merge", tip: o.childMergeCommitSha };
  }
  if (state === "parent-moved" && o.parentHeadSha) return { kind: "catch-up", tip: o.parentHeadSha };
  if (state === "restack-needed" && o.parentMergeCommitSha) return { kind: "restack", tip: o.parentMergeCommitSha };
  return null;
}

/**
 * The broken-stack actions offered for this state, in the order they are drawn.
 *
 * - Parent closed, child still open: *Move onto main* or *Wait for a replacement*.
 * - Child closed by GitHub, parent merged: *Reopen against main*.
 * - Child closed by GitHub, parent closed: only *Move onto main*. There is no open child to
 *   retarget, so a replacement parent cannot take it over.
 * - Child closed while its parent is still open (closed by hand, say): *Reopen on #A's
 *   branch*, a new pull request from the same branch against the open parent's branch, which
 *   inherits this one's lineage. It is then an ordinary stacked child again.
 * - Parent task stopped while its pull request is open: the child cannot release itself while
 *   that pull request is open, so the action restarts the parent's work - *Reschedule* a
 *   cancelled or failed task back into the backlog, then *Start* it - and its pull request can
 *   then merge (or close) and the stack resolves as usual.
 */
export function stackActions(state: StackState, o: StackObservation | null): StackActionKind[] {
  if (state !== "broken" || !o || o.parentUnreadSince) return [];
  const reason = stackBrokenReason(o);
  if (reason === "parent-closed") return ["move-onto-main", "await-replacement"];
  if (reason === "child-closed") {
    if (o.parentState === "MERGED") return ["reopen-against-main"];
    if (o.parentState === "CLOSED") return ["move-onto-main"];
    if (o.parentState === "OPEN") return ["reopen-on-parent"];
  }
  if (reason === "parent-task-stopped" && o.parentTaskId) {
    return o.parentTaskStopped === "rescheduled" ? ["start-parent"] : ["reschedule-parent"];
  }
  return [];
}

/** How a pending prompt stands, as far as delivery goes. */
export type StackPromptStatus =
  /** Foreman will deliver it on the session's next idle tick. */
  | "pending"
  /** Delivered; the session is working on it. */
  | "sent"
  /** Claimed but never confirmed delivered; never retried automatically. */
  | "uncertain"
  /**
   * Delivered, but to a session that has since gone - it exited before acting on it - and a
   * different (resumed) session owns the child now. Offered to the operator to send again;
   * never retried automatically.
   */
  | "orphaned"
  /** No live session owns the child. Resume the task to deliver it. */
  | "no-session"
  /**
   * The one live owner has no pane, so nothing - Foreman or the operator - can type the prompt
   * into it. Resume the task to give it a delivery channel again.
   */
  | "no-pane"
  /**
   * Foreman will not send it: off, not live, or its own stable session rule refuses the owner
   * (not invited, an agent it cannot drive, no hooks, no pane, not allowed here). The operator
   * sends it by hand.
   */
  | "foreman-off";

/**
 * Everything the merge queue, the session card and Foreman read about one stacked child.
 * Computed on read; never written into `mergeBlock`, which keeps holding only gate values.
 */
export interface StackStanding {
  state: StackState;
  /** The current parent, and its number for "#A" copy. */
  parentUrl: string;
  parentNumber: number | null;
  brokenReason: StackBrokenReason | null;
  retargetError: string | null;
  /**
   * The prompt this child needs. `blocker` names why Foreman will not send it when that is not
   * simply Foreman being off - an uninvited session, an agent it cannot drive, no hooks, no
   * pane, or a repository it may not act in - so the label can say so beside the manual send.
   */
  prompt: { kind: StackPromptKind; tip: string; status: StackPromptStatus; blocker?: string } | null;
  actions: StackActionKind[];
  /** The operator chose *Wait for a replacement*. */
  awaitingReplacement: boolean;
  /** The one live session that owns the child, when there is exactly one. */
  sessionId: string | null;
  /** Recovery actions already delivered for the current stack state; not sent again. */
  sentActions: StackActionKind[];
  /** The parent task, for the restart actions. Null when unknown. */
  parentTaskId: string | null;
  /**
   * Whether the owning session has a pane anything can type into. Without one, no prompt or
   * prompt-typed action can be delivered, so none is offered as clickable.
   */
  sessionHasPane: boolean;
  /** The lifecycle label, or null when there is nothing to say (released). */
  label: string | null;
  /** True for the in-progress labels that belong with `waiting` rather than `blocked`. */
  inProgress: boolean;
  /** What a prompt or action sent for this child names. */
  facts: StackPromptFacts;
}

const PROMPT_NAME: Record<StackPromptKind, { needed: string; prompt: string }> = {
  "catch-up": { needed: "Catch-up needed", prompt: "Catch-up prompt" },
  restack: { needed: "Restack needed", prompt: "Restack prompt" },
  "recover-merge": { needed: "Recovery needed", prompt: "Recovery prompt" },
};

/**
 * What a prompt's delivery status says, after the state it answers: why nobody can send it, or
 * that it is uncertain or went to a session that has gone. Null while it is on its way or sent.
 */
function promptStatusPhrase(prompt: NonNullable<StackStanding["prompt"]>): string | null {
  const name = PROMPT_NAME[prompt.kind];
  switch (prompt.status) {
    case "no-session":
      return `${name.needed}: no session`;
    case "no-pane":
      return `${name.needed}: the session has no pane to type into - resume its task to restore one`;
    case "foreman-off":
      return prompt.blocker ? `${name.needed}: Foreman can't send it - ${prompt.blocker}` : `${name.needed}: Foreman is off`;
    case "uncertain":
      return `${name.prompt} delivery uncertain`;
    case "orphaned":
      return `${name.prompt} went to a session that has gone - send it to the resumed one`;
    case "pending":
    case "sent":
      return null;
  }
}

/**
 * The lifecycle label for a standing, and whether it is in progress. Broken and retarget
 * failures come first: they are what needs a person.
 */
export function stackLifecycleLabel(
  s: Pick<StackStanding, "state" | "parentNumber" | "brokenReason" | "retargetError" | "prompt">,
  o: Pick<StackObservation, "parentState" | "parentTaskStopped"> & Partial<Pick<StackObservation, "defaultBranch" | "baseRefName">> | null,
): { label: string | null; inProgress: boolean } {
  const parent = s.parentNumber === null ? "its parent" : `#${s.parentNumber}`;
  const onto = `Restacking onto ${o?.defaultBranch || "main"}`;
  if (s.state === "released") return { label: null, inProgress: false };
  if (s.state === "merge-unconfirmed") {
    return { label: `Merged - checking on GitHub whether it reached ${o?.defaultBranch || "the default branch"}`, inProgress: true };
  }
  if (s.state === "broken") {
    if (s.brokenReason === "merged-off-default") {
      return { label: `Stack broken: merged into ${o?.baseRefName ? `\`${o.baseRefName}\`` : "another branch"}, not ${o?.defaultBranch || "the default branch"}`, inProgress: false };
    }
    if (s.brokenReason === "merged-into-parent") {
      const broken = `Stack broken: merged into ${parent}'s branch, not ${o?.defaultBranch || "the default branch"}`;
      if (!s.prompt) return { label: broken, inProgress: false };
      const phrase = promptStatusPhrase(s.prompt);
      return {
        label: phrase ? `${broken} - ${phrase}` : `${broken} - ${s.prompt.status === "sent" ? "recovering" : "recovery prompt on its way"}`,
        inProgress: false,
      };
    }
    if (s.brokenReason === "child-closed") {
      return {
        label: o?.parentState === "MERGED"
          ? `Stack broken: GitHub closed this pull request after ${parent} merged`
          : o?.parentState === "OPEN"
          ? `Stack broken: this pull request was closed while ${parent} is still open`
          : `Stack broken: GitHub closed this pull request and ${parent} closed`,
        inProgress: false,
      };
    }
    if (s.brokenReason === "parent-task-stopped") {
      return { label: `Stack broken: ${parent}'s task was ${o?.parentTaskStopped ?? "stopped"}`, inProgress: false };
    }
    return { label: `Stack broken: ${parent} closed`, inProgress: false };
  }
  if (s.retargetError) return { label: `Retarget failed: ${s.retargetError}`, inProgress: false };
  if (s.prompt) {
    const phrase = promptStatusPhrase(s.prompt);
    if (phrase) return { label: phrase, inProgress: false };
    return s.prompt.kind === "restack"
      ? { label: onto, inProgress: true }
      : { label: `Catching up with ${parent}`, inProgress: false };
  }
  if (s.state === "restack-needed" || s.state === "parent-merged-needs-retarget") {
    return { label: onto, inProgress: true };
  }
  return { label: `Stacked on ${parent} (waiting for it to merge)`, inProgress: false };
}

/** The button text for a manual prompt send. */
export const STACK_SEND_LABEL: Record<StackPromptKind, string> = {
  "catch-up": "Send catch-up prompt",
  restack: "Send restack prompt",
  "recover-merge": "Send recovery prompt",
};

/**
 * The button text for each broken-stack action: the parent's number names a restart, and the
 * repository's own default branch names where a child is moved or reopened (`main` only when
 * it is not known), so the button never names a branch the prompt does not target.
 */
export function stackActionLabel(action: StackActionKind, parentNumber: number | null, defaultBranch: string | null = null): string {
  const parent = parentNumber === null ? "the parent" : `#${parentNumber}`;
  const base = defaultBranch || "main";
  switch (action) {
    case "move-onto-main":
      return `Move onto ${base}`;
    case "reopen-against-main":
      return `Reopen against ${base}`;
    case "reopen-on-parent":
      return `Reopen on ${parent}'s branch`;
    case "await-replacement":
      return "Wait for a replacement";
    case "reschedule-parent":
      return `Reschedule ${parent}'s task`;
    case "start-parent":
      return `Start ${parent}'s task`;
  }
}

/** What a stack prompt names. */
export interface StackPromptFacts {
  prNumber: number;
  prUrl: string;
  headRefName: string | null;
  parentNumber: number | null;
  parentUrl: string;
  parentHeadRefName: string | null;
  defaultBranch: string | null;
  /** The branch the child merged into, and its merge commit, for the recovery prompt. */
  mergedIntoRefName?: string | null;
  mergeCommitSha?: string | null;
}

/**
 * The text typed into the child's session for one prompt or action. Plain text in any
 * composer, naming the exact pull requests and branches so the agent need not rediscover them.
 *
 * Every variant says what never to do: force-push, rebase, or open a second pull request for a
 * catch-up or restack. The daemon never runs git in the worktree; the session does the merge.
 * The recovery is the one that opens a new pull request, from a new branch, because both
 * branches it would otherwise touch have already merged and must not be rewritten.
 */
export function buildStackPrompt(kind: StackPromptKind | StackPromptActionKind, f: StackPromptFacts): string {
  const parent = f.parentNumber === null ? f.parentUrl : `#${f.parentNumber} (${f.parentUrl})`;
  const base = f.defaultBranch || "the default branch";
  const branch = f.headRefName ? `\`${f.headRefName}\`` : "its branch";
  const noForce = "Do NOT force-push and do NOT rebase: merge, so the branch only moves forward.";
  const steps = (lines: string[]): string => lines.map((line, i) => `${i + 1}. ${line}`).join("\n");
  switch (kind) {
    case "catch-up":
      return `PR #${f.prNumber} is stacked on ${parent}, which has new commits. Bring them in.\n\n` + steps([
        `Fetch, then merge \`origin/${f.parentHeadRefName ?? "<parent branch>"}\` into ${branch}.`,
        "Resolve any conflicts, keeping both changes' intent, and run focused checks for what you touched.",
        `Push to ${branch}. ${noForce}`,
        "Do NOT open a new pull request - this one stays stacked on its parent.",
      ]);
    case "restack":
      return `${parent} merged, so PR #${f.prNumber} (${f.prUrl}) now targets ${base}. Restack it.\n\n` + steps([
        `Fetch, then merge \`origin/${base}\` into ${branch}. Hunks identical to the parent's squash merge resolve cleanly.`,
        "Resolve any real conflicts and run focused checks for what you touched.",
        `Push to ${branch}. ${noForce}`,
        "Do NOT open a new pull request. Mission Control verifies the restack and then reviews this one against the default branch.",
      ]);
    case "move-onto-main":
      return `${parent} closed without merging, so PR #${f.prNumber} (${f.prUrl}) still carries its unmerged code. Move only this task's own work onto ${base}.\n\n` + steps([
        `Fetch, then create a new branch from \`origin/${base}\`.`,
        `Cherry-pick only this task's own commits from ${branch} onto it - none of ${parent}'s.`,
        "Resolve conflicts and run focused checks.",
        `Push the new branch and open a replacement pull request with \`gh pr create --base ${base}\`.`,
        `Then close PR #${f.prNumber} with \`gh pr close ${f.prNumber}\`, saying it was replaced. ${noForce}`,
      ]);
    case "reopen-on-parent":
      return `PR #${f.prNumber} (${f.prUrl}) was closed, but ${parent} is still open, so this work is still stacked on it. Open it again against ${f.parentNumber === null ? "the parent" : `#${f.parentNumber}`}'s branch.\n\n` + steps([
        `Open a new pull request from the same branch, ${branch}, with \`gh pr create --base ${f.parentHeadRefName ?? "<parent branch>"}\`, and start its description with "Stacked on ${f.parentNumber === null ? "its parent" : `#${f.parentNumber}`}".`,
        "Do not reopen it against the default branch: it merges after its parent does.",
        noForce,
      ]);
    case "recover-merge": {
      const merge = f.mergeCommitSha ? `\`${f.mergeCommitSha}\`` : "its merge commit";
      const sha = f.mergeCommitSha ?? "<merge commit>";
      const into = f.mergedIntoRefName ? `\`${f.mergedIntoRefName}\`` : "its parent's branch";
      const merged = [branch, f.mergedIntoRefName ? into : null].filter(Boolean).join(" or ");
      return `PR #${f.prNumber} (${f.prUrl}) was merged into ${into} after ${parent} had already merged, so its changes never reached ${base}. Recover them onto ${base} in a new pull request.\n\n` + steps([
        `Fetch, then create a new branch from \`origin/${base}\`.`,
        `Bring over exactly the changes that merge introduced - the diff between merge commit ${merge} and its first parent - with \`git diff --binary ${sha}^1 ${sha} | git apply --3way\`, then commit them. This works whether GitHub made a merge commit or a squash commit.`,
        `Resolve any conflicts with ${base} and run focused checks for what you touched.`,
        `Push the new branch and open a new pull request with \`gh pr create --base ${base}\`, saying it recovers PR #${f.prNumber}. This task completes when that pull request merges into ${base}.`,
        `Do NOT force-push, rebase, reset or otherwise rewrite ${merged}: they have already merged.`,
      ]);
    }
    case "reopen-against-main":
      return `GitHub closed PR #${f.prNumber} (${f.prUrl}) when ${parent} merged and its branch was deleted. Open it again against ${base}.\n\n` + steps([
        `Open a new pull request from the same branch, ${branch}, with \`gh pr create --base ${base}\`.`,
        `Then fetch and merge \`origin/${base}\` into ${branch}, resolve any conflicts, run focused checks and push.`,
        noForce,
      ]);
  }
}

/**
 * A request to type one stack prompt or action into a child's session. Identity only, like
 * `CodeRabbitFollowup`: the daemon rebuilds the text and re-checks every guard itself, so the
 * caller carries no authority and no worker-authored instructions. `tip` names the condition a
 * catch-up or restack prompt is keyed to; actions carry none.
 */
export interface StackPromptRequest {
  prKey: string;
  kind: StackPromptKind | StackPromptActionKind;
  tip: string | null;
}
