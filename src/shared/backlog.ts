import type { BacklogPlan, BacklogPlanEntry, Task } from "./types.ts";
import { backlogTasks } from "./session.ts";
import { taskKindAllowsBacklog } from "./task.ts";

// The backlog autopilot's predicates, defined once - the same reason
// `foremanAllowlisted` and `reportBucket` live in src/shared rather than being
// mirrored by hand on each side.
//
// The scheduler DECIDES with these (src/server/foreman/backlog-machine.ts) and the
// board's Backlog column EXPLAINS that decision with them. A drift between the two
// readers is invisible until it lies to someone: a card marked ready that the machine
// will never take, or a "blocked" chip on the item it is about to launch. The work
// queue's panel has exactly this relationship with `foremanAllowlisted`, for exactly
// this reason.

/** How a dependency is failing to be satisfied. */
export type BlockerState =
  /** Still in the backlog, being provisioned, or running - it will finish. */
  | "waiting"
  /** Cancelled or failed - it will NOT finish on its own; a human has to intervene. */
  | "stopped"
  /**
   * Sitting in the backlog with its enable toggle off, so nothing will start it.
   *
   * Its own state rather than folded into either neighbour, because the sentence a
   * card has to write differs: "waiting" promises the prerequisite is coming and this
   * one will follow, which a parked item does not; "stopped" sends the operator to
   * look at a task that failed, when the fix here is one click on the toggle they
   * themselves turned off.
   */
  | "disabled";

/** One unmet dependency of a backlog task, in the words the card needs. */
export interface BacklogBlocker {
  taskId: string;
  title: string;
  state: BlockerState;
  /** Declared blockers are policy and cannot be manually overridden; inferred ones can. */
  source: "declared" | "inferred";
}

/** The plan's entries by task id. Empty map for a missing plan, so callers need no branch. */
export function planEntries(plan: BacklogPlan | null): Map<string, BacklogPlanEntry> {
  const out = new Map<string, BacklogPlanEntry>();
  for (const e of plan?.entries ?? []) out.set(e.taskId, e);
  return out;
}

/**
 * How much of the backlog one plan covers: its head, oldest first.
 *
 * Held BELOW `BacklogPlanSchema`'s `.max(500)` (src/shared/protocol.ts) on purpose: a
 * plan larger than the wire schema accepts is a body the daemon refuses every single
 * time, which turns a big backlog into a permanently failing write rather than a slow
 * one. `backlog-plan-http.test.ts` pins the two together, since nothing else would
 * notice them drifting apart.
 *
 * Everything past the limit is simply unplanned, which the readers below already have
 * an answer for: unnamed items are unblocked and go last, oldest first. So a 900-item
 * backlog gets a real dependency read on the part of it that is about to run, and the
 * tail is scheduled in age order with no dependency information at all.
 *
 * That tail carries one ACCEPTED cost, written down here rather than left to be
 * rediscovered: `planStale` is coverage, so above the limit every dispatch promotes an
 * unplanned item into the covered head and the plan goes stale again - one dependency
 * read per launched task. It is one model call and not a batch of them, and only on a
 * backlog past the limit, which is the trade taken deliberately over reading the whole
 * backlog in batches on the worker's single shared loop.
 */
export const PLANNABLE_LIMIT = 400;

/**
 * The head of the backlog a plan is expected to cover. See `PLANNABLE_LIMIT`.
 *
 * The enable/disable toggle is deliberately NOT read here, and that is load-bearing
 * rather than an omission. `sanitizePlan` drops any inferred edge whose target is not
 * in the list it was given (`if (!known.has(dep)) continue`), so filtering parked items
 * out of the planner's input silently deletes every inferred dependency POINTING AT a
 * parked task on the next replan - which then makes its dependents ready and launches
 * them on a base that was never laid. Operator-declared edges survive that, because
 * they live on the task; Foreman's inferred graph does not.
 *
 * The tempting version of this filter came with a story - "parking is free, un-parking
 * is what replans" - and the story was not true either. A stored entry survives a park,
 * so re-enabling a task the plan already covered stays covered and replans nothing; and
 * above `PLANNABLE_LIMIT` parking SHIFTS the slice, promoting an unplanned item into the
 * head, so it costs a replan rather than saving one.
 *
 * So a parked item keeps its plan entry and its share of the budget. That is the price
 * of a dependency graph that stays complete, and it is the cheaper of the two mistakes:
 * `readyBacklog` is the single gate that decides what actually runs.
 */
export function plannableBacklog(tasks: Task[]): Task[] {
  return backlogTasks(tasks).filter((task) => taskKindAllowsBacklog(task.kind)).slice(0, PLANNABLE_LIMIT);
}

/**
 * True when the stored plan no longer describes the backlog - i.e. some backlog item
 * a plan is allowed to cover has no entry - and must be regenerated before anything is
 * scheduled.
 *
 * Coverage, deliberately, and NOT a fingerprint of the backlog. A plan is a set of
 * statements about the tasks it names, and a task LEAVING the backlog (dispatched,
 * cancelled, removed) invalidates none of them - so a fingerprint would burn a model
 * call on every single dispatch, which is the one moment the backlog always changes.
 * A task ARRIVING is different: it may be the thing everything else waits on, and
 * nothing in the stored plan can say so.
 *
 * Asked over `plannableBacklog` rather than the whole backlog, because the question has
 * to be answerable by a plan that was actually storable. Over the full list, a backlog
 * past the limit could never be covered, so this would stay true forever and the worker
 * would replan on every tick - the unbounded loop of model calls producing nothing that
 * `sanitizePlan`'s missing-entry repair exists to prevent, arriving by the other door.
 */
export function planStale(tasks: Task[], plan: BacklogPlan | null): boolean {
  const entries = planEntries(plan);
  return plannableBacklog(tasks).some((t) => !entries.has(t.id));
}

/**
 * The dependencies of `task` that are not satisfied yet.
 *
 * A dependency counts as satisfied when it reached `done`, or when it is GONE from the
 * task list entirely. The second case is the escape hatch and it is deliberate: a
 * dependency the planner invented, or one whose task the human deleted, must not
 * strand the item behind it forever - and deleting the offending task is a gesture the
 * board already has.
 *
 * `cancelled` and `failed` are NOT satisfied. They are the states that mean "this work
 * did not happen", and letting them pass would start the dependent item on a base that
 * was never laid. They report as `stopped` so the card can say the difference between
 * "wait" and "you need to do something".
 */
export function blockersFor(
  task: Task,
  plan: BacklogPlan | null,
  tasks: Task[],
): BacklogBlocker[] {
  return blockersIn(task, backlogIndex(tasks, plan));
}

/** Operator-declared blockers only, for surfaces that do not render Foreman's plan. */
export function declaredBlockers(task: Task, tasks: Task[]): BacklogBlocker[] {
  return declaredBlockersIn(task, new Map(tasks.map((candidate) => [candidate.id, candidate])));
}

/**
 * Why one unsatisfied prerequisite is not moving, for a dependent card to render.
 *
 * Asked of a task we can still see; a dependency whose task is GONE never reaches
 * here (`blockersIn` treats a missing task as satisfied, and a declared edge to one
 * reports `stopped` at its call site).
 */
function dependencyState(target: Task): BlockerState {
  if (target.status === "cancelled" || target.status === "failed") return "stopped";
  // Only meaningful while it is still in the backlog: `enabled` gates SCHEDULING, so
  // a task that already launched is on its way regardless of what the flag says.
  if (target.status === "backlog" && !target.enabled) return "disabled";
  return "waiting";
}

function declaredBlockersIn(task: Task, byId: Map<string, Task>): BacklogBlocker[] {
  const out: BacklogBlocker[] = [];
  for (const dependency of task.dependencies) {
    if (dependency.satisfiedAt !== null) continue;
    if (dependency.type === "session") {
      out.push({
        taskId: dependency.sessionId,
        title: dependency.title,
        state: "waiting",
        source: "declared",
      });
      continue;
    }
    const target = byId.get(dependency.taskId);
    out.push({
      taskId: dependency.taskId,
      title: target?.title ?? dependency.title,
      state: target ? dependencyState(target) : "stopped",
      source: "declared",
    });
  }
  return out;
}

/**
 * The two lookups every blocker question needs, built once for a whole pass.
 *
 * Both maps used to be rebuilt inside `blockersFor`, which `readyBacklog` calls once per
 * backlog item - so answering "what can start?" cost a full rebuild per item, on the
 * three hottest paths there are: `/api/foreman/status`, the worker's 4s tick, and every
 * board render. Ask for the index once and the pass is linear again.
 */
export interface BacklogIndex {
  entries: Map<string, BacklogPlanEntry>;
  byId: Map<string, Task>;
  /** Memoized transitive closure of unresolved operator-declared task edges. */
  declaredReachability: Map<string, Set<string>>;
}

/** Build the lookups `blockersIn` reads. See `BacklogIndex`. */
export function backlogIndex(tasks: Task[], plan: BacklogPlan | null): BacklogIndex {
  return {
    entries: planEntries(plan),
    byId: new Map(tasks.map((t) => [t.id, t])),
    declaredReachability: new Map(),
  };
}

/** `blockersFor` against a prebuilt index. Same answer, no rebuild. */
export function blockersIn(task: Task, index: BacklogIndex): BacklogBlocker[] {
  const out = declaredBlockersIn(task, index.byId);
  const declaredTaskIds = new Set(
    task.dependencies.flatMap((dependency) =>
      dependency.type === "task" ? [dependency.taskId] : [],
    ),
  );
  const entry = index.entries.get(task.id);
  if (!entry || entry.dependsOn.length === 0) return out;
  for (const id of entry.dependsOn) {
    // The operator's edge is the stronger statement and has stricter completion
    // semantics for ship tasks. Do not render the same prerequisite twice.
    if (declaredTaskIds.has(id)) continue;
    // The plan may predate an operator edit that added the opposite declared edge.
    // Plans are coverage-based and deliberately do not go stale on every task edit, so
    // enforce the same "model cannot reverse a fact" rule at read time as sanitizer
    // does at write time. This closes the edit-to-next-replan window without burning a
    // model call merely because somebody changed a dependency.
    if (declaredPathReaches(id, task.id, index)) continue;
    const dep = index.byId.get(id);
    if (!dep || dep.status === "done") continue;
    out.push({
      taskId: dep.id,
      title: dep.title,
      state: dependencyState(dep),
      source: "inferred",
    });
  }
  return out;
}

function declaredPathReaches(from: string, target: string, index: BacklogIndex): boolean {
  return declaredReachable(from, index, new Set()).has(target);
}

function declaredReachable(
  from: string,
  index: BacklogIndex,
  visiting: Set<string>,
): Set<string> {
  const cached = index.declaredReachability.get(from);
  if (cached) return cached;
  if (visiting.has(from)) return new Set();
  visiting.add(from);
  const reachable = new Set<string>();
  for (const dependency of index.byId.get(from)?.dependencies ?? []) {
    if (dependency.satisfiedAt !== null || dependency.type !== "task") continue;
    reachable.add(dependency.taskId);
    for (const descendant of declaredReachable(dependency.taskId, index, visiting)) {
      reachable.add(descendant);
    }
  }
  visiting.delete(from);
  index.declaredReachability.set(from, reachable);
  return reachable;
}

/**
 * The backlog items that could start right now, in the order the plan puts them.
 *
 * Plan order first, then anything the plan does not name, oldest first. That tail is
 * not dead code: the machine only replans when coverage breaks, so between a task
 * being added and the next successful plan there are genuinely unplanned items - and
 * the fallback the machine drops to when planning has failed its cap has NO plan at
 * all and relies entirely on this ordering being sensible.
 *
 * Disabled items are not here at all. This is the list the autopilot decides from for
 * both ways it can start work (a fresh worktree and an assign to an idle agent), so
 * neither action path needs a second copy of the scheduling gate.
 */
export function readyBacklog(tasks: Task[], plan: BacklogPlan | null): Task[] {
  const backlog = backlogTasks(tasks).filter(
    (task) => task.enabled && taskKindAllowsBacklog(task.kind),
  );
  const index = backlogIndex(tasks, plan);
  // Consumed as they are placed, so a plan that names the same task twice cannot put it
  // in the result twice, and what is left over is exactly the unnamed tail.
  const unplaced = new Map(backlog.map((t) => [t.id, t]));
  const ordered: Task[] = [];
  for (const e of plan?.entries ?? []) {
    const t = unplaced.get(e.taskId);
    if (!t) continue;
    unplaced.delete(t.id);
    ordered.push(t);
  }
  for (const t of backlog) if (unplaced.has(t.id)) ordered.push(t);
  return ordered.filter((t) => blockersIn(t, index).length === 0);
}

/**
 * The item autopilot would take next, for the board's "next up" marker.
 *
 * Deliberately ignores capacity, the repo allowlist and Foreman's mode - it answers
 * "which item is at the front of the queue", not "will it launch this second". A
 * marker that vanished whenever the fleet was momentarily full would flicker, and
 * would stop answering the question a human actually has when they look at the column.
 */
export function nextUpTaskId(tasks: Task[], plan: BacklogPlan | null): string | null {
  return readyBacklog(tasks, plan)[0]?.id ?? null;
}

/**
 * The backlog items whose own blockers name `task` - what finishing it would release.
 *
 * The mirror image of `blockersIn`, and deliberately built ON it rather than by reading
 * `entry.dependsOn` and `task.dependencies` a second time: those two edge sets are
 * merged, de-duplicated and sanity-checked in one place, and a reverse walk that read the
 * raw fields would count an inferred edge the read-time repair had already discarded. So
 * "unblocks 2 tasks" is exactly "2 rows lose a blocker chip when this one finishes".
 *
 * PARKED dependents count. The question is what the dependency graph is holding, and a
 * parked item is held by a switch rather than by the graph - it is released by this task
 * finishing just the same, and the operator can see the switch on its own row.
 */
export function dependentsIn(task: Task, tasks: Task[], index: BacklogIndex): Task[] {
  return backlogTasks(tasks).filter(
    (t) => t.id !== task.id && blockersIn(t, index).some((b) => b.taskId === task.id),
  );
}

/**
 * The cancelled or failed tasks that stop `task` from ever reaching the front of the
 * queue - directly, or through a chain of still-backlogged prerequisites that are each
 * waiting on the next.
 *
 * `blockersIn` answers only the DIRECT level: a card whose prerequisite is itself a
 * backlog task waiting on a cancelled one shows a plain "after X" and says nothing about
 * the dead root - the one thing a human actually has to act on. This walks the chain and
 * names those roots for the whole downstream, so the warning lands on every dependent and
 * not just the one that happened to declare the dead edge itself.
 *
 * The walk follows only SCHEDULING-GATED edges: it recurses through a prerequisite just
 * while that prerequisite is itself in the backlog, because a `running` or `dispatching`
 * one is already on its way and whatever it once waited on no longer gates anything. It
 * collects a prerequisite the moment it reports `stopped` (cancelled/failed) and does not
 * look past it - that task is the one to reschedule or mark done, and its own
 * prerequisites become its problem again once it is back in play.
 *
 * Returns the dead tasks themselves, deduplicated; empty when nothing dead is upstream.
 * Shared, not inlined in a card, for the reason every predicate here is: the board, the
 * Sitrep and the server must agree on what "blocked by a dead task" means. Built on
 * `blockersIn` rather than a second edge-walk so it can never disagree with what actually
 * gates scheduling.
 */
export function deadBlockersFor(task: Task, index: BacklogIndex): Task[] {
  const dead = new Map<string, Task>();
  const visiting = new Set<string>();
  const walk = (current: Task): void => {
    if (visiting.has(current.id)) return;
    visiting.add(current.id);
    for (const blocker of blockersIn(current, index)) {
      const dep = index.byId.get(blocker.taskId);
      if (!dep) continue; // a declared edge to a task that is GONE - nothing to act on
      if (blocker.state === "stopped") {
        dead.set(dep.id, dep);
        continue;
      }
      // Only a still-backlogged prerequisite keeps gating us; one already dispatching
      // will finish on its own, so its own history is not this card's problem.
      if (dep.status === "backlog") walk(dep);
    }
    visiting.delete(current.id);
  };
  walk(task);
  return [...dead.values()];
}
