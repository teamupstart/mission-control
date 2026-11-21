import { withCurrentShaping, type TaskShaping } from "@shared/shaping.ts";
import { featureEnabled } from "../feature-flags/index.ts";

/**
 * Records a failed commit superseded whose on-disk clear has not succeeded yet: task id to the
 * session the stale record names. The registry writes it (`hideSupersededShaping`); every read
 * below consults it, so a durable read of the row cannot show the earlier delivery as current
 * while its clean-up is pending.
 */
const supersededShaping = new Map<string, string>();

export function noteSupersededShaping(taskId: string, sessionId: string): void {
  supersededShaping.set(taskId, sessionId);
}

export function forgetSupersededShaping(taskId: string): void {
  supersededShaping.delete(taskId);
}

/** The session a pending clean-up's stale record names, if one is pending for this task. */
export function supersededShapingFor(taskId: string): string | undefined {
  return supersededShaping.get(taskId);
}

export function hasSupersededShaping(): boolean {
  return supersededShaping.size > 0;
}

/**
 * A task as every daemon read returns it: `shaping` only while the `task-shaping` flag is on and
 * the record names the task's current session (`withCurrentShaping`), and the `shapingContext`
 * progress mark only while the flag is on. Turning the flag off deletes nothing; it hides saved
 * records, and a step still running, from task reads the way it hides them from the dashboard
 * and the shaping route.
 */
export function taskShapingForReads<T extends {
  id?: string;
  shaping?: TaskShaping | null;
  shapingContext?: unknown;
  sessionId: string | null;
}>(task: T): T {
  if (task.shaping === undefined && task.shapingContext === undefined) return task;
  if (featureEnabled("task-shaping")) {
    if (task.shaping === undefined) return task;
    // A record whose clean-up is pending is superseded even though it still names this session.
    if (task.id !== undefined && task.shaping && supersededShapingFor(task.id) === task.shaping.sessionId) {
      const { shaping: _superseded, ...rest } = task;
      return rest as T;
    }
    return withCurrentShaping(task);
  }
  const { shaping: _hidden, shapingContext: _running, ...rest } = task;
  return rest as T;
}

/**
 * A session as every daemon read returns it: its task card carries `shaping` only while the
 * `task-shaping` flag is on. The card already holds only its own launch's record
 * (`taskSummaryFor`); the flag is applied here, where the session leaves the daemon, because a
 * card cached before a toggle would otherwise keep it.
 */
export function sessionShapingForReads<T extends { task?: { shaping?: TaskShaping | null } | null }>(session: T): T {
  if (session.task?.shaping === undefined || featureEnabled("task-shaping")) return session;
  const { shaping: _hidden, ...task } = session.task;
  return { ...session, task };
}
