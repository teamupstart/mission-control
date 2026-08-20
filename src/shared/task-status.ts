import type { TaskStatus } from "./types.ts";

/**
 * The task statuses with no further lifecycle: the agent is gone, nothing will move the row
 * on again by itself.
 *
 * One definition, in `src/shared` and browser-safe, because three subsystems now decide
 * something durable from it and a fourth spelling would be a silent policy fork. The registry
 * evicts on it, the SQL that reloads resource-holding tasks lists the same three, and worktree
 * retention will only ever run its clock for a task in one of them - so a status added to two
 * of those readers and not the third would either keep a live task's tree under a deletion
 * deadline or leave a finished one with no clock at all.
 */
export const TERMINAL_TASK_STATUSES = ["done", "failed", "cancelled"] as const satisfies
  readonly TaskStatus[];

/** A task in a terminal state has no further lifecycle - safe to evict from memory. */
export function isTerminalTask(status: TaskStatus): boolean {
  return (TERMINAL_TASK_STATUSES as readonly TaskStatus[]).includes(status);
}
