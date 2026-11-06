import type { ShippingConfig } from "./protocol.ts";
import type { Task, TaskDependency } from "./types.ts";

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
 * `merge` while only the stacked-start half of the feature exists: without automatic
 * restacking, a stacked child that outlives its parent needs a person to clear its hold.
 * The lifecycle phase changes this constant, and only this constant, to `stack`. Nothing
 * writes `ShippingConfig.stacking` except an explicit operator choice, so flipping it moves
 * every install that never chose.
 */
export const STACKING_SHIPPED_DEFAULT: StackingMode = "merge";

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
  if (edge.type === "plan") return "merge";
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
  if (edge.type === "plan") return edge;
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
