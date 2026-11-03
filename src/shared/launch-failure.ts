/**
 * A dispatch that never started, as every surface reads it.
 *
 * Browser-safe and shared, because the daemon records the failure, the board and Console rail
 * draw it, the top bar counts it, the toast announces it and the report route reads it - five
 * readers of one fact, which is exactly the shape that forks if any of them restates it.
 *
 * WHY A RECORD AND NOT A READING OF `status`. A dispatched task has always had a placeholder:
 * `provisioningTasks` draws one at the top of `working` while the task is `dispatching` with no
 * session. A failure moves the status on, the placeholder drops out, and nothing took its
 * place - the dispatch read as dropped, with a chime as the only signal. `status === "failed"`
 * cannot replace it, because a session that ran for an hour and was lost to a restart is
 * `failed` with no session too, and that is not a launch failure. Only the dispatcher knows the
 * difference at the moment it happens, so it writes this record then, and nothing else infers
 * one later.
 */
import { z } from "zod";
import type { Task } from "./types.ts";
import { TASK_KIND_BEHAVIOR, taskHasRepository } from "./task.ts";
import { dispatchPhase } from "./session.ts";

/** How far the dispatch got before it failed. The phases `dispatchPhase` names. */
export const LAUNCH_FAILURE_PHASES = ["prepare", "launch", "discover", "handover"] as const;
export type LaunchFailurePhase = (typeof LAUNCH_FAILURE_PHASES)[number];

/**
 * The persisted record, in `tasks.launch_failure` as JSON.
 *
 * `dismissedAt` is the operator's acknowledgement. A dismissed failure keeps its record - the
 * task's `error` still explains it wherever that is printed - and leaves every surface that
 * asks for attention. `reportTaskId` is the report session started for it, shared by every
 * failure in the same group so one reason gets one report.
 */
export const TaskLaunchFailureSchema = z.object({
  at: z.number().int().nonnegative(),
  phase: z.enum(LAUNCH_FAILURE_PHASES),
  dismissedAt: z.number().int().nonnegative().nullable(),
  reportTaskId: z.string().min(1).nullable(),
  /** The resident profile a resident task launched from, so its tile can launch it again. */
  residentProfileId: z.string().min(1).nullable(),
  /**
   * The dispatcher kept this attempt's agent and resources: its session, terminal home or
   * worktree may still be live, or nothing could say it was not. Recorded at the failure
   * because `sessionId` is often not written yet at that point - an embedded or terminal
   * session can exist before the task is bound to it - and a kept failure must never offer a
   * retry that would re-file the task and reclaim the worktree an agent may be working in.
   * Defaults false so a record written before the field existed still reads.
   */
  sessionKept: z.boolean().default(false),
});
export type TaskLaunchFailure = z.infer<typeof TaskLaunchFailureSchema>;

/** A persisted value read back, or null when it is absent or unreadable. */
export function parseLaunchFailure(raw: string | null | undefined): TaskLaunchFailure | null {
  if (!raw) return null;
  try {
    const parsed = TaskLaunchFailureSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Where the failed task ended up, which decides where it is drawn.
 *
 * - `not-started`: failed with no session. Drawn as a failed tile where its placeholder was.
 * - `returned`: put back in the Backlog with its reason. Drawn on its Backlog card.
 * - `kept`: failed, but its session survived. Drawn on that session's card.
 *
 * Null when there is no record, or when the task has since moved on - re-dispatched, settled
 * by the operator, or completed - so a stale record never draws anything.
 */
export type LaunchFailureOutcome = "not-started" | "returned" | "kept";

export function launchFailureOutcome(task: Task): LaunchFailureOutcome | null {
  if (!task.launchFailure) return null;
  if (task.status === "backlog") return "returned";
  if (task.status !== "failed") return null;
  return task.sessionId || task.launchFailure.sessionKept ? "kept" : "not-started";
}

/** A launch failure the operator has not dismissed. */
export function hasOpenLaunchFailure(task: Task): boolean {
  return launchFailureOutcome(task) !== null && task.launchFailure?.dismissedAt === null;
}

/**
 * The work a task is, independent of the attempt. Used to clear older failures when the same
 * work later starts, and as the stem of the group key.
 *
 * A resident's work is its PROFILE. Its title is the profile's name, which two profiles can
 * share and one can be renamed out of, and its repository is the run's private workspace,
 * different on every launch - so neither can say which profile it was. `residentProfileId` is
 * the failed attempt's recorded profile by default; a caller asking about an attempt that
 * carries no record (a launch that just started) passes the profile it launched from.
 *
 * Everything else, and a resident whose profile cannot be named, is its kind, repository and
 * title. A resident falling back that way never matches a profile-keyed failure, so an unknown
 * profile can leave a failure open but can never clear another profile's.
 */
export function launchWorkKey(
  task: Task,
  residentProfileId: string | null = task.launchFailure?.residentProfileId ?? null,
): string {
  if (residentProfileId && TASK_KIND_BEHAVIOR[task.kind].launch === "resident") {
    return JSON.stringify(["resident-profile", residentProfileId]);
  }
  return JSON.stringify([task.kind, taskHasRepository(task) ? task.repoRoot : "", task.title]);
}

/** Failures that read as one problem: the same work, failing for the same reason. */
export function launchFailureGroupKey(task: Task): string {
  return JSON.stringify([launchWorkKey(task), task.error ?? ""]);
}

export interface LaunchFailureGroup {
  key: string;
  outcome: LaunchFailureOutcome;
  /** Newest attempt first. Never empty. */
  tasks: Task[];
}

/** The newest attempt in a group - the one whose fields a surface prints. */
export function latestLaunchFailure(group: LaunchFailureGroup): Task {
  return group.tasks[0]!;
}

function failedAt(task: Task): number {
  return task.launchFailure?.at ?? task.updatedAt;
}

/**
 * Every open failure, grouped, newest group first.
 *
 * Grouped within an outcome: a `returned` card and a `not-started` tile are drawn in different
 * places, so merging them would put one count on two surfaces.
 */
export function openLaunchFailureGroups(tasks: readonly Task[]): LaunchFailureGroup[] {
  const groups = new Map<string, LaunchFailureGroup>();
  for (const task of tasks) {
    if (!hasOpenLaunchFailure(task)) continue;
    const outcome = launchFailureOutcome(task)!;
    const key = JSON.stringify([outcome, launchFailureGroupKey(task)]);
    const group = groups.get(key);
    if (group) group.tasks.push(task);
    else groups.set(key, { key, outcome, tasks: [task] });
  }
  const out = [...groups.values()];
  for (const group of out) group.tasks.sort((a, b) => failedAt(b) - failedAt(a));
  return out.sort((a, b) => failedAt(latestLaunchFailure(b)) - failedAt(latestLaunchFailure(a)));
}

/**
 * Whether this task is itself a Report bug session. Read off the task's own marker, never off
 * the failure that started it: that failure's record is cleared when its task is retried, and
 * a report session that then failed to start must still not offer a Report bug of its own.
 */
export function isLaunchFailureReport(task: Task): boolean {
  return Boolean(task.launchReportFor);
}

/** What the failed tile and toast call the phase it stopped in. */
export const LAUNCH_FAILURE_PHASE_COPY: Record<LaunchFailurePhase, string> = {
  prepare: "while provisioning",
  launch: "at launch",
  discover: "waiting for the agent",
  handover: "handing over the task",
};

/**
 * The record for an attempt failing now, read off the task as it stood when it failed - so the
 * phase is the one it reached, before any teardown clears the fields that name it.
 */
export function newLaunchFailure(
  task: Task,
  at: number,
  residentProfileId: string | null,
  sessionKept = false,
): TaskLaunchFailure {
  return { at, phase: dispatchPhase(task), dismissedAt: null, reportTaskId: null, residentProfileId, sessionKept };
}
