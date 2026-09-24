import { createHash } from "node:crypto";
import {
  canRefreshSourceTask, copySourceGroup, reconcileSourceContent, sameSourceContent,
  sourceContent, SourceContentSchema, SOURCE_CONTENT_GROUPS,
  type SourceContent, type SourceSyncCounts, type SourceSyncRecord, type SourceSyncReview,
} from "@shared/task-source-sync.ts";
import { normalizeLabels } from "@shared/task.ts";
import type { SweepContext, SweepResult, TaskCandidate, TaskSourceInstance } from "@shared/task-source.ts";
import type { Task } from "@shared/types.ts";
import { getTask, listTaskSourceBacklog } from "../db.ts";
import type { TaskManager } from "../tasks.ts";
import { taskSourceById } from "./config.ts";
import { readLinkedSource } from "./index.ts";
import { getSourceSync, saveSourceSync } from "./sync-store.ts";

function legacyRecord(task: Task, inst: TaskSourceInstance): SourceSyncRecord {
  return {
    origin: "legacy", externalId: task.source!.externalId,
    defaults: { priority: inst.defaults.priority, labels: inst.defaults.labels },
    baseline: null, pending: null, conflicts: [], checkedAt: null, appliedAt: null, error: null,
  };
}
function projection(candidate: TaskCandidate, record: SourceSyncRecord): SourceContent {
  return SourceContentSchema.parse({
    title: candidate.title.trim(), intent: candidate.intent.trim(),
    priority: candidate.priority === undefined ? record.defaults.priority : candidate.priority,
    labels: normalizeLabels([...record.defaults.labels, ...(candidate.labels ?? [])]),
  });
}
function sameRecord(a: SourceSyncRecord | null, b: SourceSyncRecord | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
function sourceIsCurrent(inst: TaskSourceInstance): boolean {
  return JSON.stringify(taskSourceById(inst.id)) === JSON.stringify(inst);
}
function reviewVersion(task: Task, inst: TaskSourceInstance, record: SourceSyncRecord | null): string {
  return createHash("sha256").update(JSON.stringify([task.source, sourceContent(task), inst, record])).digest("hex");
}

export function sourceSyncReviews(sources: TaskSourceInstance[]): SourceSyncReview[] {
  return sources.flatMap((inst) => listTaskSourceBacklog(inst.id).filter(canRefreshSourceTask).flatMap((task) => {
    let saved: SourceSyncRecord | null;
    try { saved = getSourceSync(task.id); }
    catch { return [{ taskId: task.id, sourceId: inst.id, externalId: task.source!.externalId,
      title: task.title, local: sourceContent(task), remote: null, conflicts: [], adoption: false,
      error: "saved sync history is unreadable", checkedAt: null, version: "invalid" }]; }
    if (saved?.origin === "pushed") return [];
    const record = saved ?? legacyRecord(task, inst);
    return [{ taskId: task.id, sourceId: inst.id, externalId: task.source!.externalId,
      title: task.title, local: sourceContent(task), remote: record.pending,
      conflicts: record.conflicts, adoption: record.baseline === null,
      error: record.error, checkedAt: record.checkedAt, version: reviewVersion(task, inst, saved) }];
  }));
}

/** Refresh has its own bounded, oldest-checked-first budget; it never consumes creation slots. */
export async function refreshSourceTasks(
  inst: TaskSourceInstance, discovered: SweepResult, tasks: TaskManager, ctx: SweepContext,
  current: () => boolean = () => sourceIsCurrent(inst),
): Promise<SourceSyncCounts> {
  const counts: SourceSyncCounts = { updated: 0, unchanged: 0, conflicted: 0, skipped: 0 };
  if (!inst.keepUpdated || !current()) return counts;
  const all = listTaskSourceBacklog(inst.id).filter(canRefreshSourceTask);
  const identities = new Map<string, number>();
  for (const task of all) identities.set(task.source!.externalId, (identities.get(task.source!.externalId) ?? 0) + 1);
  const eligible = all.flatMap((task) => {
    try {
      const saved = getSourceSync(task.id);
      return saved?.origin === "pushed" ? [] : [{task, saved, record: saved ?? legacyRecord(task, inst)}];
    } catch { counts.skipped++; return []; }
  }).sort((a, b) => (a.record.checkedAt ?? 0) - (b.record.checkedAt ?? 0)
    || a.task.createdAt - b.task.createdAt || a.task.id.localeCompare(b.task.id)).slice(0, 25);
  // Persist attempts before remote I/O so a timeout cannot strand every later batch.
  for (const entry of eligible) {
    const attempt = { ...entry.record, checkedAt: Date.now(), error: "Refresh did not finish; sweep again to retry." };
    saveSourceSync(entry.task.id, inst.id, attempt);
    entry.saved = attempt;
    entry.record = attempt;
  }
  const candidates = new Map(discovered.items.map((c) => [c.ref.externalId, c]));
  const missing = eligible.filter(({task}) => !candidates.has(task.source!.externalId)
    && identities.get(task.source!.externalId) === 1).map(({task}) => task.source!);
  const read = missing.length ? await readLinkedSource(inst, missing, ctx) : { items: [], error: null };
  for (const candidate of read.items) candidates.set(candidate.ref.externalId, candidate);
  for (const { task, saved, record } of eligible) {
    if (ctx.signal.aborted || !current()) { counts.skipped++; continue; }
    const local = sourceContent(task);
    let content = local;
    let next: SourceSyncRecord = { ...record, checkedAt: Date.now(), error: null };
    const candidate = candidates.get(task.source!.externalId);
    if (identities.get(task.source!.externalId)! > 1) {
      next.error = "Several backlog tasks link to this item. Remove the unwanted copies before refreshing.";
    } else if (record.externalId !== task.source!.externalId) {
      next.error = "The task's source identity changed; its saved baseline cannot be used.";
    } else if (!candidate || candidate.ref.sourceId !== inst.id) {
      next.error = read.error ?? "The linked item was not returned. It may be missing or inaccessible; the task was kept.";
    } else if (candidate.ref.url !== task.source!.url) {
      next.error = "The source returned a different issue link. The existing task was kept.";
    } else {
      try {
        const remote = projection(candidate, record);
        if (!record.baseline) {
          // Legacy links also include locally-authored pushes. Adoption is always explicit.
          next = { ...next, pending: remote, conflicts: [...SOURCE_CONTENT_GROUPS] };
        } else {
          const merged = reconcileSourceContent(record.baseline, local, remote);
          content = merged.content;
          next = { ...next, baseline: merged.baseline, conflicts: merged.conflicts,
            pending: merged.conflicts.length ? remote : null };
          if (!sameSourceContent(local, content)) next.appliedAt = Date.now();
        }
      } catch (error) { next.error = error instanceof Error ? error.message : String(error); }
    }
    const applied = await tasks.applySourceContent(task.id, task.source!, local, content,
      () => saveSourceSync(task.id, inst.id, next),
      () => !ctx.signal.aborted && current() && sameRecord(getSourceSync(task.id), saved));
    if (!applied.ok || next.error) counts.skipped++;
    else if (next.pending) counts.conflicted++;
    else if (!sameSourceContent(local, content)) counts.updated++;
    else counts.unchanged++;
  }
  return counts;
}

export async function resolveSourceSync(
  inst: TaskSourceInstance, taskId: string, version: string, choice: "source" | "local", tasks: TaskManager,
): Promise<{ ok: boolean; error?: string }> {
  const task = getTask(taskId);
  if (!inst.keepUpdated || !task || task.source?.sourceId !== inst.id || !canRefreshSourceTask(task)) {
    return { ok: false, error: "Enable updates for this source and choose an unstarted backlog task." };
  }
  const record = getSourceSync(taskId);
  if (!record?.pending || record.error || record.origin === "pushed"
    || reviewVersion(task, inst, record) !== version) {
    return { ok: false, error: "This review changed. Sweep again and review the current values." };
  }
  if (listTaskSourceBacklog(inst.id).filter((t) => t.source?.externalId === task.source!.externalId).length !== 1) {
    return { ok: false, error: "Several backlog tasks link to this item; resolve the duplicates first." };
  }
  const local = sourceContent(task);
  const content = sourceContent(task);
  const baseline = sourceContent(record.baseline ?? record.pending);
  for (const group of record.conflicts) {
    copySourceGroup(baseline, record.pending, group);
    if (choice === "source") copySourceGroup(content, record.pending, group);
  }
  const next: SourceSyncRecord = { ...record, origin: "imported", baseline, pending: null, conflicts: [],
    appliedAt: choice === "source" ? Date.now() : record.appliedAt };
  return tasks.applySourceContent(task.id, task.source, local, content,
    () => saveSourceSync(task.id, inst.id, next),
    () => sourceIsCurrent(inst) && sameRecord(getSourceSync(task.id), record));
}
