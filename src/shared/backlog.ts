import type { BacklogPlan, BacklogPlanEntry, Task } from "./types.ts";
import { backlogTasks } from "./session.ts";

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
  | "stopped";

/** One unmet dependency of a backlog task, in the words the card needs. */
export interface BacklogBlocker {
  taskId: string;
  title: string;
  state: BlockerState;
}

/** The plan's entries by task id. Empty map for a missing plan, so callers need no branch. */
export function planEntries(plan: BacklogPlan | null): Map<string, BacklogPlanEntry> {
  const out = new Map<string, BacklogPlanEntry>();
  for (const e of plan?.entries ?? []) out.set(e.taskId, e);
  return out;
}

/**
 * How many backlog items one plan may describe.
 *
 * A ceiling on COVERAGE, and not the same thing as how much of the backlog gets a
 * dependency read - that is `BACKLOG_MAX_CHUNKS` in backlog-plan.ts, is much smaller,
 * and is what actually costs model calls. Coverage is cheap: an item no chunk described
 * still gets an entry saying it waits on nothing.
 *
 * The two must not be conflated, because a coverage ceiling below the backlog's size
 * has a nasty cost profile. `planStale` is coverage, so every dispatch would promote an
 * uncovered item into the covered window and make the plan stale again - a full read
 * per launched task, which is exactly the "model call on every dispatch" that choosing
 * coverage over a fingerprint was meant to avoid. Hence a ceiling set where no real
 * backlog reaches it, rather than one sized to the read.
 *
 * Held at `BacklogPlanSchema`'s `.max(...)` (src/shared/protocol.ts), since a plan the
 * wire schema refuses is a write that fails every time. `backlog-plan-http.test.ts`
 * pins the two together, as nothing else would notice them drifting apart.
 */
export const PLANNABLE_LIMIT = 2000;

/** The head of the backlog a plan is expected to cover. See `PLANNABLE_LIMIT`. */
export function plannableBacklog(tasks: Task[]): Task[] {
  return backlogTasks(tasks).slice(0, PLANNABLE_LIMIT);
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
  const entry = planEntries(plan).get(task.id);
  if (!entry || entry.dependsOn.length === 0) return [];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out: BacklogBlocker[] = [];
  for (const id of entry.dependsOn) {
    const dep = byId.get(id);
    if (!dep || dep.status === "done") continue;
    out.push({
      taskId: dep.id,
      title: dep.title,
      state: dep.status === "cancelled" || dep.status === "failed" ? "stopped" : "waiting",
    });
  }
  return out;
}

/**
 * The backlog items that could start right now, in the order the plan puts them.
 *
 * Plan order first, then anything the plan does not name, oldest first. That tail is
 * not dead code: the machine only replans when coverage breaks, so between a task
 * being added and the next successful plan there are genuinely unplanned items - and
 * the fallback the machine drops to when planning has failed its cap has NO plan at
 * all and relies entirely on this ordering being sensible.
 */
export function readyBacklog(tasks: Task[], plan: BacklogPlan | null): Task[] {
  const backlog = backlogTasks(tasks);
  const byId = new Map(backlog.map((t) => [t.id, t]));
  const ordered: Task[] = [];
  const seen = new Set<string>();
  for (const e of plan?.entries ?? []) {
    const t = byId.get(e.taskId);
    if (!t || seen.has(t.id)) continue;
    seen.add(t.id);
    ordered.push(t);
  }
  for (const t of backlog) if (!seen.has(t.id)) ordered.push(t);
  return ordered.filter((t) => blockersFor(t, plan, tasks).length === 0);
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
