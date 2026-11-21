import { withCurrentShaping, type TaskShaping } from "@shared/shaping.ts";
import { featureEnabled } from "../feature-flags/index.ts";

/**
 * A task as every daemon read returns it: `shaping` only while the `task-shaping` flag is on and
 * the record names the task's current session (`withCurrentShaping`), and the `shapingContext`
 * progress mark only while the flag is on. Turning the flag off deletes nothing; it hides saved
 * records, and a step still running, from task reads the way it hides them from the dashboard
 * and the shaping route.
 */
export function taskShapingForReads<T extends {
  shaping?: TaskShaping | null;
  shapingContext?: unknown;
  sessionId: string | null;
}>(task: T): T {
  if (task.shaping === undefined && task.shapingContext === undefined) return task;
  if (featureEnabled("task-shaping")) return task.shaping === undefined ? task : withCurrentShaping(task);
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
