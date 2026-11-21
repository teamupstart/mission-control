import { randomBytes } from "node:crypto";
import { TASK_KIND_INFO, taskKindHasWorkUnit, taskKindSessionJoinsWorkUnit } from "@shared/task.ts";
import type { Task } from "@shared/types.ts";
import { encodeWorkUnitId } from "@shared/work-unit.ts";
import type { TaskWorkUnitSource } from "./tasks.ts";

/**
 * A new work unit id. Only `TaskManager` calls this: a task's id is minted or copied at task
 * creation, or given once to an older row at its next dispatch or assign, and nowhere else.
 */
export function mintWorkUnitId(now: number = Date.now()): string {
  return encodeWorkUnitId(now, randomBytes(10));
}

/** What an MCP `create_task` caller may ask for. Omitted, the caller's task kind decides. */
export type McpWorkUnitChoice = "inherit" | "new";

/**
 * The work unit source for a task an MCP caller creates, or why it is refused.
 *
 * `callerTask` is the task the calling session is running, or null when the caller resolves to
 * no session or its session has no task. Decisions D1 and D6 in `docs/plans/work-unit-id/plan.md`:
 *
 *  - `"new"` always gets a new work unit.
 *  - `"inherit"` copies the caller's task's, and is refused only when there is no such task or
 *    its kind has no work unit (a resident run).
 *  - Omitted, a session whose task kind says its tasks join its work unit (a plan) is inherited
 *    from, and every other caller - including one that cannot be resolved - gets a new one.
 */
export function mcpCreateWorkUnitSource(
  requested: McpWorkUnitChoice | undefined,
  callerTask: Pick<Task, "id" | "kind"> | null,
): { ok: true; source: TaskWorkUnitSource | undefined } | { ok: false; error: string } {
  if (requested === "new") return { ok: true, source: undefined };
  if (requested === "inherit") {
    if (!callerTask) {
      return {
        ok: false,
        error: "workUnit \"inherit\" needs a calling session that is running a task, and this session is running none",
      };
    }
    if (!taskKindHasWorkUnit(callerTask.kind)) {
      return {
        ok: false,
        error: `workUnit "inherit" refused: a ${TASK_KIND_INFO[callerTask.kind].label} run has no work unit to inherit`,
      };
    }
    return { ok: true, source: { inherit: [callerTask.id] } };
  }
  return callerTask && taskKindSessionJoinsWorkUnit(callerTask.kind)
    ? { ok: true, source: { inherit: [callerTask.id] } }
    : { ok: true, source: undefined };
}
