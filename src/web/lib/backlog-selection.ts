import type { BulkUpdateTasksInput, TaskDependencyInput } from "@shared/protocol.ts";
import { dependencyInputKey, dependencyInputOf } from "@shared/task-bulk.ts";
import type { AgentType, Task, TaskKind, TaskPriority, ThinkingLevel } from "@shared/types.ts";

/**
 * The backlog column's multi-select, and the bulk-edit draft built over it.
 *
 * Pure, so the rules a person relies on (which cards a shift-click takes, what "Mixed"
 * says, which fields a draft actually writes) are pinned in `test/` without a browser.
 */

/**
 * The ids from `anchor` to `target` inclusive, in the column's order, whichever way round
 * they were clicked. A missing anchor (it left the backlog, or nothing was clicked yet)
 * selects just the target, the same as a plain toggle.
 */
export function rangeBetween(order: readonly string[], anchor: string | null, target: string): string[] {
  const to = order.indexOf(target);
  if (to < 0) return [];
  const from = anchor === null ? -1 : order.indexOf(anchor);
  if (from < 0) return [target];
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  return order.slice(lo, hi + 1);
}

/** A set with `id` flipped, as a new set so React sees the change. */
export function toggled(selection: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selection);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** Axis-aligned overlap, the only geometry the marquee needs. */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function boxesOverlap(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/** The box two corners of a drag span, whichever direction it was dragged in. */
export function boxFrom(x1: number, y1: number, x2: number, y2: number): Box {
  return {
    left: Math.min(x1, x2),
    top: Math.min(y1, y2),
    right: Math.max(x1, x2),
    bottom: Math.max(y1, y2),
  };
}

/**
 * What the selected tasks hold for one field, in words: `all High`, or `Medium ×2, unset ×1`
 * when they disagree. Ordered by count so the common value reads first.
 */
export function valueSummary(values: readonly string[]): string {
  if (values.length === 0) return "";
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  if (counts.size === 1) return `all ${values[0]}`;
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([value, n]) => `${value} ×${n}`)
    .join(", ");
}

/** The one value every task shares, or null when they disagree. */
export function sharedValue<T>(tasks: readonly Task[], read: (task: Task) => T): T | null {
  if (tasks.length === 0) return null;
  const first = read(tasks[0]!);
  return tasks.every((task) => read(task) === first) ? first : null;
}

/** Every label on the selection with how many tasks carry it, most common first. */
export function labelCounts(tasks: readonly Task[]): Array<{ label: string; count: number }> {
  const counts = new Map<string, { label: string; count: number }>();
  for (const task of tasks) {
    for (const label of task.labels) {
      const key = label.toLowerCase();
      const entry = counts.get(key);
      if (entry) entry.count += 1;
      else counts.set(key, { label, count: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** Every prerequisite on the selection with how many tasks wait on it. */
export function dependencyCounts(
  tasks: readonly Task[],
): Array<{ input: TaskDependencyInput; title: string; count: number }> {
  const counts = new Map<string, { input: TaskDependencyInput; title: string; count: number }>();
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      const input = dependencyInputOf(dependency);
      const key = dependencyInputKey(input);
      const entry = counts.get(key);
      if (entry) entry.count += 1;
      else counts.set(key, { input, title: dependency.title, count: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));
}

/**
 * The bulk-edit dialog's state. `undefined` on a scalar is "leave as is", and `null` on a
 * nullable one is "clear it back to the default" - the same two meanings the update route
 * gives an absent key and an explicit null.
 */
export interface BulkEditDraft {
  priority?: TaskPriority | null;
  enabled?: boolean;
  kind?: TaskKind;
  agent?: AgentType;
  model?: string | null;
  effort?: ThinkingLevel | null;
  workflowId?: string | null;
  labelsAdd: string[];
  labelsRemove: string[];
  dependenciesAdd: TaskDependencyInput[];
  dependenciesRemove: TaskDependencyInput[];
}

export const EMPTY_BULK_DRAFT: BulkEditDraft = {
  labelsAdd: [],
  labelsRemove: [],
  dependenciesAdd: [],
  dependenciesRemove: [],
};

const SCALARS = ["priority", "enabled", "kind", "agent", "model", "effort", "workflowId"] as const;

/** How many fields this draft would change, for the footer's "3 fields on 4 tasks". */
export function changedFieldCount(draft: BulkEditDraft): number {
  const scalars = SCALARS.filter((key) => draft[key] !== undefined).length;
  const labels = draft.labelsAdd.length + draft.labelsRemove.length > 0 ? 1 : 0;
  const dependencies = draft.dependenciesAdd.length + draft.dependenciesRemove.length > 0 ? 1 : 0;
  return scalars + labels + dependencies;
}

/**
 * The agent every selected task will run after this edit, or null when they will still
 * disagree. Model and effort choices only make sense against one harness, so the dialog
 * offers them only when this answers.
 */
export function resultingAgent(tasks: readonly Task[], draft: BulkEditDraft): AgentType | null {
  return draft.agent ?? sharedValue(tasks, (task) => task.agent);
}

/**
 * The request body for this draft, or null when it would change nothing. Only the fields
 * the operator touched are named, so every other field stays as each task has it.
 */
export function bulkEditRequest(
  taskIds: readonly string[],
  draft: BulkEditDraft,
): BulkUpdateTasksInput | null {
  if (taskIds.length === 0 || changedFieldCount(draft) === 0) return null;
  const set: NonNullable<BulkUpdateTasksInput["set"]> = {};
  for (const key of SCALARS) {
    const value = draft[key];
    if (value !== undefined) (set as Record<string, unknown>)[key] = value;
  }
  return {
    taskIds: [...taskIds],
    set,
    ...(draft.labelsAdd.length + draft.labelsRemove.length > 0
      ? { labels: { add: draft.labelsAdd, remove: draft.labelsRemove } }
      : {}),
    ...(draft.dependenciesAdd.length + draft.dependenciesRemove.length > 0
      ? { dependencies: { add: draft.dependenciesAdd, remove: draft.dependenciesRemove } }
      : {}),
  };
}
