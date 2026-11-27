import { randomBytes } from "node:crypto";
import { WORK_UNIT_ID_FLAG_ID } from "@shared/feature-flag-registry.ts";
import { TASK_KIND_INFO, taskKindHasWorkUnit, taskKindSessionJoinsWorkUnit } from "@shared/task.ts";
import type { Session, Task } from "@shared/types.ts";
import { emittedWorkUnitId, encodeWorkUnitId, isWorkUnitId } from "@shared/work-unit.ts";
import { featureEnabled } from "./feature-flags/index.ts";
import type { TaskWorkUnitSource } from "./tasks.ts";

/**
 * The one decision a launch makes about its work unit: the task's id when the `work-unit-id`
 * preview is on and the id is well formed, and null otherwise - no task, a resident run (which
 * has none), an older row not yet given one, or the preview off.
 *
 * The ONLY place server code reads the flag. Called once per launch, where the launch begins
 * (a dispatch, a restore, a managed resume, a runtime transfer), and that one value goes to
 * everything the launch does: the agent's environment, the launch record the registry installs
 * when the launch succeeds, and the shaping run (Phase 4). Nothing calls it a second time for
 * the same launch, so a switch of the preview while a launch is in flight cannot give its parts
 * different answers, and a switch takes effect at each agent's next start.
 */
export function launchWorkUnitId(task: Pick<Task, "workUnitId"> | null | undefined): string | null {
  if (!task || !featureEnabled(WORK_UNIT_ID_FLAG_ID)) return null;
  return isWorkUnitId(task.workUnitId) ? task.workUnitId : null;
}

/**
 * The work unit this session's agent was started with: its launch record, which the registry
 * projects onto `Session.launchWorkUnitId` and keeps in step across every note-key rotation.
 * Null for an agent started without the variable, and for every session Mission Control did not
 * launch. A span belongs to its session, so capture reads this and needs no task.
 */
export function launchWorkUnitFor(session: Pick<Session, "launchWorkUnitId">): string | null {
  return session.launchWorkUnitId ?? null;
}

/**
 * The work unit `session` emits for `task`: its launch record while the task has that same id,
 * and null otherwise. A reader with a task in hand - the dashboard row, shaping for an agent
 * that is already running - uses this, so it never names an id the agent does not carry. The
 * reuse guard keeps every task a session runs in its one work unit.
 */
export function sessionWorkUnitId(
  session: Pick<Session, "launchWorkUnitId">,
  task: Pick<Task, "workUnitId"> | null | undefined,
): string | null {
  return emittedWorkUnitId(launchWorkUnitFor(session), task?.workUnitId ?? null);
}

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
