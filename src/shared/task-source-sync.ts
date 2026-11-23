import { z } from "zod";
import { TASK_PRIORITIES, taskHasNoProvisionedResources } from "./task.ts";
import type { Task, TaskDependency } from "./types.ts";

/** One upstream item that blocks the task, named the way the source names it. */
export const SourceBlockerSchema = z.object({ externalId: z.string(), url: z.string().nullable() });
export type SourceBlocker = z.infer<typeof SourceBlockerSchema>;
export const SourceContentSchema = z.object({
  title: z.string(),
  intent: z.string(),
  priority: z.enum(TASK_PRIORITIES).nullable(),
  labels: z.array(z.string()),
  /**
   * The `dependencies` group: the items of this source that block the task. Absent when the
   * source cannot relate, and in anything saved before the group existed, which reads as
   * "no baseline" for this group alone.
   */
  blockedBy: z.array(SourceBlockerSchema).optional(),
});
export type SourceContent = z.infer<typeof SourceContentSchema>;
// Append-only: `conflicts` persists these ids.
export const SOURCE_CONTENT_GROUPS = ["brief", "priority", "labels", "dependencies"] as const;
export type SourceContentGroup = (typeof SOURCE_CONTENT_GROUPS)[number];
/** A pushed task was written here, so only its upstream blocking links flow back in. */
export const PUSHED_SOURCE_GROUPS: readonly SourceContentGroup[] = ["dependencies"];

export const SourceSyncRecordSchema = z.object({
  origin: z.enum(["imported", "pushed", "legacy"]),
  externalId: z.string(),
  defaults: z.object({ priority: z.enum(TASK_PRIORITIES).nullable(), labels: z.array(z.string()) }),
  baseline: SourceContentSchema.nullable(),
  pending: SourceContentSchema.nullable(),
  conflicts: z.array(z.enum(SOURCE_CONTENT_GROUPS)),
  checkedAt: z.number().nullable(),
  appliedAt: z.number().nullable(),
  error: z.string().nullable(),
});
export type SourceSyncRecord = z.infer<typeof SourceSyncRecordSchema>;
export interface SourceSyncReview {
  taskId: string;
  sourceId: string;
  externalId: string;
  title: string;
  local: SourceContent;
  remote: SourceContent | null;
  conflicts: SourceContentGroup[];
  adoption: boolean;
  error: string | null;
  checkedAt: number | null;
  version: string;
}
export interface SourceSyncCounts {
  updated: number;
  unchanged: number;
  conflicted: number;
  skipped: number;
}
export const ResolveSourceSyncSchema = z.object({
  version: z.string().min(1).max(64),
  choice: z.enum(["source", "local"]),
});

export function sourceContent(t: SourceContent): SourceContent {
  const out: SourceContent = { title: t.title, intent: t.intent, priority: t.priority, labels: [...t.labels] };
  if (t.blockedBy) out.blockedBy = t.blockedBy.map((b) => ({ ...b }));
  return out;
}
export function sameSourceContent(a: SourceContent, b: SourceContent): boolean {
  return SOURCE_CONTENT_GROUPS.every((group) => sameGroup(a, b, group));
}
/** Blockers de-duplicated and in a stable order, so equal sets compare and persist equally. */
export function sourceBlockers(refs: Iterable<SourceBlocker>): SourceBlocker[] {
  const byId = new Map<string, SourceBlocker>();
  for (const ref of refs) if (!byId.has(ref.externalId)) byId.set(ref.externalId, { externalId: ref.externalId, url: ref.url });
  return [...byId.values()].sort((a, b) => a.externalId.localeCompare(b.externalId));
}
/**
 * A task's content as this source sees it. With `relate`, that includes the task's edges
 * that stand for one of the source's items: a `source` edge to it, or a task edge to the task
 * linked to it. Every other edge (sessions, unlinked tasks, other sources) stays local and
 * outside the group, so sync can neither see nor remove it.
 */
export function localSourceContent(task: Task, relate: { sourceId: string; tasks: Task[] } | null): SourceContent {
  const content = sourceContent({ title: task.title, intent: task.intent, priority: task.priority, labels: task.labels });
  if (!relate) return content;
  const byId = new Map(relate.tasks.map((t) => [t.id, t]));
  content.blockedBy = sourceBlockers(task.dependencies.flatMap((d) => sourceBlockerOf(d, relate.sourceId, byId) ?? []));
  return content;
}
/**
 * The source item an edge stands for, or null when the edge is outside the source's
 * `dependencies` group. The one owner of that rule: the local projection above and the
 * edges sync keeps (`TaskManager.sourceSyncedDependencies`) both read it.
 */
export function sourceBlockerOf(d: TaskDependency, sourceId: string, tasksById: Map<string, Task>): SourceBlocker | null {
  if (d.type === "source") return d.sourceId === sourceId ? { externalId: d.externalId, url: d.url } : null;
  if (d.type !== "task") return null;
  const linked = tasksById.get(d.taskId)?.source;
  return linked?.sourceId === sourceId ? { externalId: linked.externalId, url: linked.url } : null;
}
function groupValue(c: SourceContent, group: SourceContentGroup): unknown {
  if (group === "brief") return [c.title, c.intent];
  if (group === "labels") return [...c.labels].sort();
  if (group === "dependencies") return c.blockedBy ? c.blockedBy.map((b) => b.externalId).sort() : null;
  return c.priority;
}
function sameGroup(a: SourceContent, b: SourceContent, group: SourceContentGroup): boolean {
  return JSON.stringify(groupValue(a, group)) === JSON.stringify(groupValue(b, group));
}
export function copySourceGroup(target: SourceContent, from: SourceContent, group: SourceContentGroup): void {
  if (group === "brief") { target.title = from.title; target.intent = from.intent; }
  else if (group === "labels") target.labels = [...from.labels];
  else if (group === "dependencies") {
    if (from.blockedBy) target.blockedBy = from.blockedBy.map((b) => ({ ...b }));
    else delete target.blockedBy;
  } else target.priority = from.priority;
}

/**
 * A local override remains local until the source changes that same group again.
 *
 * A group the baseline never captured (`blockedBy` absent) has nothing to tell a local edit
 * from a remote one, so it is applied only when local and remote already agree and is
 * otherwise flagged for review: the no-baseline rule, one group at a time.
 */
export function reconcileSourceContent(
  baseline: SourceContent, local: SourceContent, remote: SourceContent,
  groups: readonly SourceContentGroup[] = SOURCE_CONTENT_GROUPS,
): {
  content: SourceContent; baseline: SourceContent; conflicts: SourceContentGroup[];
} {
  const content = sourceContent(local);
  const accepted = sourceContent(baseline);
  const conflicts: SourceContentGroup[] = [];
  for (const group of groups) {
    if (sameGroup(local, remote, group)) copySourceGroup(accepted, remote, group);
    else if (sameGroup(baseline, remote, group)) continue;
    else if (sameGroup(local, baseline, group)) {
      copySourceGroup(content, remote, group);
      copySourceGroup(accepted, remote, group);
    } else conflicts.push(group);
  }
  return { content, baseline: accepted, conflicts };
}

export function canRefreshSourceTask(task: Task): boolean {
  return task.status === "backlog" && !task.sessionId && task.dispatchedAt === null
    && taskHasNoProvisionedResources(task);
}
