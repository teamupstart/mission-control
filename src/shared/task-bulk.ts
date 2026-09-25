import type { BulkUpdateTasks, TaskDependencyInput, UpdateTask } from "./protocol.ts";
import { MAX_LABELS, MAX_TASK_DEPENDENCIES, normalizeLabels } from "./task.ts";
import type { Task, TaskDependency } from "./types.ts";

/** One dependency's identity, the same `task:`/`session:` key the dispatch form uses. */
export function dependencyInputKey(dependency: TaskDependencyInput): string {
  return dependency.type === "task" ? `task:${dependency.taskId}` : `session:${dependency.sessionId}`;
}

/** A stored edge as the input that names it, which is what an update body carries. */
export function dependencyInputOf(dependency: TaskDependency): TaskDependencyInput {
  return dependency.type === "task"
    ? { type: "task", taskId: dependency.taskId }
    : { type: "session", sessionId: dependency.sessionId };
}

/** Labels compare case-insensitively everywhere else (`normalizeLabels`), so here too. */
const labelKey = (label: string): string => label.trim().toLowerCase();

/**
 * One task's share of a bulk edit, as the single-task patch `TaskManager.update` already
 * knows how to validate.
 *
 * The `set` fields pass through unchanged. Labels and dependencies are resolved against THIS
 * task's own lists: remove what was named, keep the rest in place, then append what was
 * added. A key is only written when the list actually changes, so a task that already had
 * the label being added, or never had the one being removed, gets no labels key at all and
 * stays an annotation-free patch.
 *
 * Refuses rather than truncates when the result would pass a cap. `normalizeLabels` drops
 * everything past the twelfth label silently, which is right for a single form the operator
 * is watching and wrong for a selection where the dropped label would be on a card nobody
 * is looking at.
 */
export function bulkTaskPatch(
  task: Task,
  change: Pick<BulkUpdateTasks, "set" | "labels" | "dependencies">,
): { ok: true; patch: UpdateTask } | { ok: false; error: string } {
  const patch: UpdateTask = {};
  for (const [key, value] of Object.entries(change.set)) {
    if (value !== undefined) (patch as Record<string, unknown>)[key] = value;
  }

  if (change.labels) {
    const removed = new Set(change.labels.remove.map(labelKey));
    const kept = task.labels.filter((label) => !removed.has(labelKey(label)));
    const have = new Set(kept.map(labelKey));
    const added = change.labels.add.filter((label) => !have.has(labelKey(label)));
    if (kept.length + added.length > MAX_LABELS) {
      return { ok: false, error: `would carry more than ${MAX_LABELS} labels` };
    }
    const next = normalizeLabels([...kept, ...added]);
    const same =
      next.length === task.labels.length && next.every((label, i) => label === task.labels[i]);
    if (!same) patch.labels = next;
  }

  if (change.dependencies) {
    const removed = new Set(change.dependencies.remove.map(dependencyInputKey));
    const current = task.dependencies.map(dependencyInputOf);
    const kept = current.filter((dependency) => !removed.has(dependencyInputKey(dependency)));
    const have = new Set(kept.map(dependencyInputKey));
    const added: TaskDependencyInput[] = [];
    for (const dependency of change.dependencies.add) {
      const key = dependencyInputKey(dependency);
      // A task in the selection is never its own prerequisite. The route refuses a
      // prerequisite that is itself selected, so this only matters to a direct caller.
      if (dependency.type === "task" && dependency.taskId === task.id) continue;
      if (have.has(key)) continue;
      have.add(key);
      added.push(dependency);
    }
    if (kept.length + added.length > MAX_TASK_DEPENDENCIES) {
      return { ok: false, error: `would carry more than ${MAX_TASK_DEPENDENCIES} dependencies` };
    }
    if (kept.length !== current.length || added.length > 0) {
      patch.dependencies = [...kept, ...added];
    }
  }

  return { ok: true, patch };
}
