import { withCurrentShaping, type TaskShaping } from "@shared/shaping.ts";
import { featureEnabled } from "../feature-flags/index.ts";

/**
 * A task as every daemon read returns it: `shaping` only while the `task-shaping` flag is on and
 * the record names the task's current session (`withCurrentShaping`). Turning the flag off
 * deletes nothing; it hides saved records from task reads the way it hides them from the
 * dashboard and the shaping route.
 */
export function taskShapingForReads<T extends { shaping?: TaskShaping | null; sessionId: string | null }>(task: T): T {
  if (task.shaping === undefined) return task;
  if (featureEnabled("task-shaping")) return withCurrentShaping(task);
  const { shaping: _hidden, ...rest } = task;
  return rest as T;
}
