import {
  SCHEDULE_CATCHUP_CREATE_CAP,
  SCHEDULE_OVERLAP_BLOCKING_TASK_STATUSES,
} from "@shared/schedules.ts";
import type {
  ScheduleDecisionKind,
  ScheduleMissedDecision,
  ScheduleMissedPolicy,
  ScheduleOverlapPolicy,
} from "@shared/schedules.ts";
import type { TaskStatus } from "@shared/types.ts";

/**
 * What the scheduler DECIDES, with nothing that can decide it wrongly.
 *
 * Every function here is pure: no clock, no database, no task manager, no logging. That
 * is not tidiness, it is the only way the interesting cases are testable at all - a
 * fortnight of standby, a cap being hit, a run blocked by its own predecessor from the
 * same tick - each of which would otherwise need a fixture that manufactures time.
 *
 * The split against `manager.ts` is exact: this module says what SHOULD happen to a list
 * of instants, and the manager does it and copes with the answer being refused by a
 * transaction. Nothing here knows an occurrence id or a task id, because those are
 * allocated by the caller and a pure function that took them would be describing a
 * particular tick rather than the policy.
 *
 * The order the two policies apply in is load-bearing, and it is missed-then-overlap:
 * coalescing decides how many runs a window is WORTH, and only then does overlap ask
 * whether the machine can take another one. Reversed, a catch-up under `skip-active`
 * would block on the first instant and coalesce nothing, so a fortnight away would file
 * one task and silently drop the rest with `skipped_overlap` - the same visible outcome
 * as `coalesce-latest`, reached by accident and recorded as the wrong reason.
 */

// ---- missed-run policy ----

/**
 * One planned instant, before anything is reserved.
 *
 * `coveredByIndex` points into this same array rather than carrying an occurrence id: ids
 * are minted by the manager, and a decision that named one could only be made after the
 * allocation it is supposed to justify.
 */
export interface MissedPlanEntry {
  at: number;
  /**
   * `create_task` here means "eligible to create work" - overlap has not been asked yet,
   * and `decideOverlap` may still turn it into `skipped_overlap`.
   */
  decisionKind: Exclude<ScheduleDecisionKind, "skipped_overlap">;
  /** Index of the entry whose run stands in for this one, for `coalesced`. */
  coveredByIndex: number | null;
}

/**
 * The catch-up-wide part of missed policy, small enough to carry across recurrence pages.
 *
 * `newestInstants` is newest-first and needs at most `cap + 1` entries: one identifies
 * coalesce-latest's run, `cap` entries identify create-all's runs, and the extra entry
 * proves the cap was hit. The manager can therefore judge a catch-up of any length without
 * allocating every crossed instant at once.
 */
export interface MissedWindowPlan {
  policy: ScheduleMissedPolicy;
  /** The earliest instant eligible to create work; older instants coalesce into it. */
  firstCreatingAt: number | null;
  hitCap: boolean;
}

export function planMissedWindow(
  newestInstants: readonly number[],
  policy: ScheduleMissedPolicy,
  cap = SCHEDULE_CATCHUP_CREATE_CAP,
): MissedWindowPlan {
  if (policy === "skip" || newestInstants.length === 0) {
    return { policy, firstCreatingAt: null, hitCap: false };
  }
  if (policy === "coalesce-latest") {
    return { policy, firstCreatingAt: newestInstants[0]!, hitCap: false };
  }
  const creatingCount = Math.min(newestInstants.length, Math.max(1, cap));
  return {
    policy,
    firstCreatingAt: newestInstants[creatingCount - 1]!,
    hitCap: newestInstants.length > creatingCount,
  };
}

export interface MissedWindowEntry {
  at: number;
  decisionKind: Exclude<ScheduleDecisionKind, "skipped_overlap">;
  /** The durable covering reservation this row should name, if it coalesces. */
  coveredByAt: number | null;
}

/** Apply one catch-up-wide decision to a bounded oldest-first recurrence page. */
export function planMissedPage(
  instants: readonly number[],
  window: MissedWindowPlan,
): MissedWindowEntry[] {
  if (window.policy === "skip") {
    return instants.map((at) => ({
      at,
      decisionKind: "skipped_policy",
      coveredByAt: null,
    }));
  }
  const firstCreatingAt = window.firstCreatingAt;
  if (firstCreatingAt === null) return [];
  return instants.map((at) =>
    at < firstCreatingAt
      ? {
          at,
          decisionKind: "coalesced" as const,
          coveredByAt: firstCreatingAt,
        }
      : { at, decisionKind: "create_task" as const, coveredByAt: null },
  );
}

/**
 * Divide the instants a catch-up crossed into the ones that create work and the ones that
 * are merely accounted for.
 *
 * `instants` must be oldest-first, which is what `recurrence.between` returns; the last
 * entry is the most recent one due.
 *
 * The three policies are three answers to "I was away, what did I miss?":
 *
 *  - `coalesce-latest` runs once, now. The default, because for nearly every recurring
 *    mission - sweep the inbox, check the dashboards - the work is idempotent and what
 *    the operator wants is the CURRENT answer, not fourteen stale ones.
 *  - `create-all` runs each of them, capped. For missions where each run is its own
 *    artifact and skipping one loses something.
 *  - `skip` runs none. For work that is only meaningful at its own instant.
 *
 * Coverage follows ONE rule in all three: a coalesced instant points at the earliest
 * planned run that is not older than it. Under `coalesce-latest` that is always the single
 * run at the end; under a capped `create-all` it is the oldest run that survived the cap;
 * under `skip` there is no run to point at and the answer is null. Stating it once is what
 * keeps history readable - "this instant did not run, and here is the run that stood in
 * for it" - rather than three policies each inventing their own idea of what covers what.
 */
export function planMissedInstants(
  instants: readonly number[],
  policy: ScheduleMissedPolicy,
  cap = SCHEDULE_CATCHUP_CREATE_CAP,
): MissedPlanEntry[] {
  if (instants.length === 0) return [];

  if (policy === "skip") {
    // No run happens, so nothing can be covered by one. `skipped_policy` is the terminal
    // record that the instant was SEEN - which is the entire difference between a skip
    // and a schedule that quietly did nothing.
    return instants.map((at) => ({
      at,
      decisionKind: "skipped_policy",
      coveredByIndex: null,
    }));
  }

  // The index of the oldest instant that gets to create work. Everything before it is
  // coalesced into it.
  const firstCreating =
    policy === "coalesce-latest"
      ? instants.length - 1
      : Math.max(0, instants.length - Math.max(1, cap));

  return instants.map((at, index) =>
    index < firstCreating
      ? {
          at,
          decisionKind: "coalesced" as const,
          coveredByIndex: firstCreating,
        }
      : { at, decisionKind: "create_task" as const, coveredByIndex: null },
  );
}

/** True when this plan dropped runs to the cap - the one thing worth logging about it. */
export function planHitCap(
  plan: readonly MissedPlanEntry[],
  policy: ScheduleMissedPolicy,
): boolean {
  return (
    policy === "create-all" &&
    plan.some((entry) => entry.decisionKind === "coalesced")
  );
}

/**
 * The same plan, in the shape the preview shows an operator.
 *
 * Indices become instants here because a preview is read by a human and by a React
 * component, neither of which should have to resolve an index back into a time.
 */
export function missedDecisionsFor(
  instants: readonly number[],
  policy: ScheduleMissedPolicy,
  cap = SCHEDULE_CATCHUP_CREATE_CAP,
): ScheduleMissedDecision[] {
  const plan = planMissedInstants(instants, policy, cap);
  return plan.map((entry) => ({
    at: entry.at,
    decisionKind: entry.decisionKind,
    coveredBy:
      entry.coveredByIndex === null
        ? null
        : (plan[entry.coveredByIndex]?.at ?? null),
  }));
}

// ---- overlap policy ----

export interface OverlapDecision {
  decisionKind: Extract<
    ScheduleDecisionKind,
    "create_task" | "skipped_overlap"
  >;
  /** The task in the way, recorded on the occurrence so history can name it. */
  blockingTaskId: string | null;
}

/**
 * Should this instant create work, given what this schedule already has in flight?
 *
 * `blockingTaskId` is whatever the caller found still active - a task from an earlier run,
 * or one this very tick created a moment ago. Both block identically under `skip-active`,
 * and the second is the case that matters: a catch-up under `create-all` files its oldest
 * run, and the next instant must see it. A check that only consulted state read before the
 * tick began would file every run in the window at once, which is precisely the pile-up
 * `skip-active` exists to prevent.
 *
 * Which statuses count as "in flight" is not decided here - it is
 * `SCHEDULE_OVERLAP_BLOCKING_TASK_STATUSES`, shared with the SQL that finds the task, so
 * the query and this decision cannot come to disagree about whether `dispatching` blocks.
 */
export function decideOverlap(
  policy: ScheduleOverlapPolicy,
  blockingTaskId: string | null,
): OverlapDecision {
  if (policy === "allow" || blockingTaskId === null) {
    return { decisionKind: "create_task", blockingTaskId: null };
  }
  return { decisionKind: "skipped_overlap", blockingTaskId };
}

/** Whether a task in this status is this schedule's work still being in flight. */
export function statusBlocksOverlap(status: TaskStatus): boolean {
  return SCHEDULE_OVERLAP_BLOCKING_TASK_STATUSES.includes(status);
}

// ---- terminal mapping ----

/**
 * The occurrence status a decision ends in when nothing goes wrong.
 *
 * Three of the four kinds are terminal the moment they are claimed - there is no work to
 * do, only a record to close - and `create_task` is the one that has to go and do
 * something before it can say `created`. Written as a total map rather than a cast from
 * the decision kind, because the two enums agreeing today is a coincidence of spelling:
 * `create_task` already breaks it, and a decision kind appended later would silently
 * become a status nobody defined.
 */
export function terminalStatusFor(
  decisionKind: ScheduleDecisionKind,
): "created" | "coalesced" | "skipped_overlap" | "skipped_policy" {
  switch (decisionKind) {
    case "create_task":
      return "created";
    case "coalesced":
      return "coalesced";
    case "skipped_overlap":
      return "skipped_overlap";
    case "skipped_policy":
      return "skipped_policy";
  }
}
