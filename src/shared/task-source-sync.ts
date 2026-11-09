import { z } from "zod";
import { TASK_PRIORITIES, taskHasNoProvisionedResources } from "./task.ts";
import type { Task } from "./types.ts";

export const SourceContentSchema = z.object({
  title: z.string(),
  intent: z.string(),
  priority: z.enum(TASK_PRIORITIES).nullable(),
  labels: z.array(z.string()),
});
export type SourceContent = z.infer<typeof SourceContentSchema>;
export const SOURCE_CONTENT_GROUPS = ["brief", "priority", "labels"] as const;
export type SourceContentGroup = (typeof SOURCE_CONTENT_GROUPS)[number];

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
  return { title: t.title, intent: t.intent, priority: t.priority, labels: [...t.labels] };
}
export function sameSourceContent(a: SourceContent, b: SourceContent): boolean {
  return SOURCE_CONTENT_GROUPS.every((group) => sameGroup(a, b, group));
}
function groupValue(c: SourceContent, group: SourceContentGroup): unknown {
  if (group === "brief") return [c.title, c.intent];
  if (group === "labels") return [...c.labels].sort();
  return c.priority;
}
function sameGroup(a: SourceContent, b: SourceContent, group: SourceContentGroup): boolean {
  return JSON.stringify(groupValue(a, group)) === JSON.stringify(groupValue(b, group));
}
export function copySourceGroup(target: SourceContent, from: SourceContent, group: SourceContentGroup): void {
  if (group === "brief") { target.title = from.title; target.intent = from.intent; }
  else if (group === "labels") target.labels = [...from.labels];
  else target.priority = from.priority;
}

/** A local override remains local until the source changes that same group again. */
export function reconcileSourceContent(baseline: SourceContent, local: SourceContent, remote: SourceContent): {
  content: SourceContent; baseline: SourceContent; conflicts: SourceContentGroup[];
} {
  const content = sourceContent(local);
  const accepted = sourceContent(baseline);
  const conflicts: SourceContentGroup[] = [];
  for (const group of SOURCE_CONTENT_GROUPS) {
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
