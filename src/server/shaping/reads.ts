import { currentShaping, withCurrentShaping, type ShapingBinding, type TaskShaping, type TaskSkillPrompt } from "@shared/shaping.ts";
import { getTaskSkillPrompt } from "../db.ts";
import { featureEnabled } from "../feature-flags/index.ts";

/**
 * A task as every daemon read returns it: `shaping` only while the `task-shaping` flag is on and
 * the record describes the delivery the task is bound to now (`withCurrentShaping`), with the
 * `shapingDelivery` that rule compared it against beside it and never on its own, and the
 * `shapingContext` progress mark only while the flag is on. A record left by an earlier
 * delivery, to another session or to this same one, is rejected by that rule from the row
 * alone, so no clean-up has to have succeeded and no restart can bring it back. Every delivery
 * binds under an id, so carrying the id only beside a record keeps an unshaped task's payload
 * what it was. Turning the flag off deletes nothing; it hides saved records, and a step still
 * running, from task reads the way it hides them from the dashboard and the shaping route.
 */
export function taskShapingForReads<T extends ShapingBinding & { shapingContext?: unknown }>(task: T): T {
  if (task.shaping === undefined && task.shapingContext === undefined && task.shapingDelivery === undefined) return task;
  const shown = featureEnabled("task-shaping") ? withCurrentShaping(task) : null;
  if (shown?.shaping) return shown;
  const { shaping: _hidden, shapingDelivery: _binding, ...rest } = shown ?? task;
  if (shown) return rest as T;
  const { shapingContext: _running, ...off } = rest;
  return off as T;
}

/**
 * The after-work prompt of the launch a task's record describes, for a read that has already
 * applied `taskShapingForReads`: null when the read shows no record, or the launch wrote no row.
 */
export function taskAfterWorkForReads(task: ShapingBinding & { id: string }): TaskSkillPrompt | null {
  const record = currentShaping(task);
  if (!record?.sessionId) return null;
  const row = getTaskSkillPrompt(task.id, record.sessionId);
  if (!row) return null;
  const { taskId: _task, turnId: _turn, ...prompt } = row;
  return prompt;
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
