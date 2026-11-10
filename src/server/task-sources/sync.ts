import { createHash } from "node:crypto";
import {
  canRefreshSourceTask, copySourceGroup, localSourceContent, PUSHED_SOURCE_GROUPS, reconcileSourceContent,
  sameSourceContent, sourceBlockers, sourceContent, SourceContentSchema, SOURCE_CONTENT_GROUPS,
  type SourceContent, type SourceContentGroup, type SourceSyncCounts, type SourceSyncRecord, type SourceSyncReview,
} from "@shared/task-source-sync.ts";
import { normalizeLabels } from "@shared/task.ts";
import { sameSourceRef, type SweepContext, type SweepResult, type TaskCandidate, type TaskSourceInstance } from "@shared/task-source.ts";
import type { Task } from "@shared/types.ts";
import { getTask, listTaskSourceBacklog, listTasks } from "../db.ts";
import type { TaskManager } from "../tasks.ts";
import { taskSourceById } from "./config.ts";
import { canRelateTo, readLinkedSource } from "./index.ts";
import { getSourceSync, saveSourceSync } from "./sync-store.ts";

function legacyRecord(task: Task, inst: TaskSourceInstance): SourceSyncRecord {
  return {
    origin: "legacy", externalId: task.source!.externalId,
    defaults: { priority: inst.defaults.priority, labels: inst.defaults.labels },
    baseline: null, pending: null, conflicts: [], checkedAt: null, appliedAt: null, error: null,
  };
}
/**
 * The groups this record syncs. A source that cannot relate has no `dependencies` group,
 * and a pushed task syncs only that one: its other content was written here.
 */
export function syncGroups(inst: TaskSourceInstance, record: SourceSyncRecord): SourceContentGroup[] {
  const groups = record.origin === "pushed" ? PUSHED_SOURCE_GROUPS : SOURCE_CONTENT_GROUPS;
  return groups.filter((group) => group !== "dependencies" || canRelateTo(inst));
}
function relation(inst: TaskSourceInstance, tasks: () => Task[]): { sourceId: string; tasks: Task[] } | null {
  return canRelateTo(inst) ? { sourceId: inst.id, tasks: tasks() } : null;
}
function projection(inst: TaskSourceInstance, candidate: TaskCandidate, record: SourceSyncRecord): SourceContent {
  return SourceContentSchema.parse({
    title: candidate.title.trim(), intent: candidate.intent.trim(),
    priority: candidate.priority === undefined ? record.defaults.priority : candidate.priority,
    labels: normalizeLabels([...record.defaults.labels, ...(candidate.labels ?? [])]),
    // The same refs ingest turns into edges: this source's, never the item itself.
    ...(canRelateTo(inst) ? { blockedBy: sourceBlockers((candidate.blockedBy ?? []).filter((ref) =>
      ref.sourceId === inst.id && ref.externalId !== candidate.ref.externalId)) } : {}),
  });
}
function sameRecord(a: SourceSyncRecord | null, b: SourceSyncRecord | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
function sourceIsCurrent(inst: TaskSourceInstance): boolean {
  return JSON.stringify(taskSourceById(inst.id)) === JSON.stringify(inst);
}
function reviewVersion(task: Task, local: SourceContent, inst: TaskSourceInstance, record: SourceSyncRecord | null): string {
  return createHash("sha256").update(JSON.stringify([task.source, local, inst, record])).digest("hex");
}

export function sourceSyncReviews(sources: TaskSourceInstance[]): SourceSyncReview[] {
  return sources.flatMap((inst) => {
    const relate = relation(inst, listTasks);
    return listTaskSourceBacklog(inst.id).filter(canRefreshSourceTask).flatMap((task) => {
      const local = localSourceContent(task, relate);
      let saved: SourceSyncRecord | null;
      try { saved = getSourceSync(task.id); }
      catch { return [{ taskId: task.id, sourceId: inst.id, externalId: task.source!.externalId,
        title: task.title, local, remote: null, conflicts: [], adoption: false,
        error: "saved sync history is unreadable", checkedAt: null, version: "invalid" }]; }
      const record = saved ?? legacyRecord(task, inst);
      if (syncGroups(inst, record).length === 0) return [];
      return [{ taskId: task.id, sourceId: inst.id, externalId: task.source!.externalId,
        title: task.title, local, remote: record.pending,
        conflicts: record.conflicts, adoption: record.baseline === null,
        error: record.error, checkedAt: record.checkedAt, version: reviewVersion(task, local, inst, saved) }];
    });
  });
}

const CYCLE_ERROR = "The source's blocking links would form a dependency cycle. The task was kept as it is.";

function dependencyRefusal(applied: { refused?: boolean; cycle?: boolean; error?: string }): string | null {
  if (!applied.refused) return null;
  if (applied.cycle) return CYCLE_ERROR;
  return `The source's blocking links could not be applied: ${applied.error ?? "a dependency was refused"}. The task was kept as it is.`;
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
      const record = saved ?? legacyRecord(task, inst);
      return syncGroups(inst, record).length === 0 ? [] : [{task, saved, record}];
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
    const groups = syncGroups(inst, record);
    const local = localSourceContent(task, relation(inst, () => tasks.sourceRelationTasks(task)));
    let content = local;
    // Set once the candidate is confirmed to be this task's item: its parent is then
    // overwritten as source-owned display data, whatever the merge below decides.
    let parent: TaskCandidate["parent"] | null | undefined;
    let next: SourceSyncRecord = { ...record, checkedAt: Date.now(), error: null };
    const candidate = candidates.get(task.source!.externalId);
    if (identities.get(task.source!.externalId)! > 1) {
      next.error = "Several backlog tasks link to this item. Remove the unwanted copies before refreshing.";
    } else if (record.externalId !== task.source!.externalId) {
      next.error = "The task's source identity changed; its saved baseline cannot be used.";
    } else if (!candidate || candidate.ref.sourceId !== inst.id) {
      next.error = read.itemErrors?.[task.source!.externalId] ?? read.error
        ?? "The linked item was not returned. It may be missing or inaccessible; the task was kept.";
    } else if (candidate.ref.url !== task.source!.url) {
      next.error = "The source returned a different issue link. The existing task was kept.";
    } else {
      parent = candidate.parent ?? null;
      try {
        const remote = projection(inst, candidate, record);
        if (!record.baseline && record.origin !== "pushed") {
          // Legacy links also include locally-authored pushes. Adoption is always explicit.
          next = { ...next, pending: remote, conflicts: groups };
        } else {
          // A push records the blocking links it confirmed as the dependencies baseline. A
          // pushed task without one (the source could not vouch for its links, or it was
          // pushed before baselines were recorded) falls to that group's no-baseline rule:
          // applied only where local and source already agree.
          const baseline = record.baseline ?? { ...local, blockedBy: undefined };
          const merged = reconcileSourceContent(baseline, local, remote, groups);
          content = merged.content;
          next = { ...next, baseline: merged.baseline, conflicts: merged.conflicts,
            pending: merged.conflicts.length ? remote : null };
          if (!sameSourceContent(local, content)) next.appliedAt = Date.now();
        }
      } catch (error) { next.error = error instanceof Error ? error.message : String(error); }
    }
    const stillCurrent = () => !ctx.signal.aborted && current() && sameRecord(getSourceSync(task.id), saved);
    const applied = await tasks.applySourceContent(task.id, task.source!, local, content,
      () => saveSourceSync(task.id, inst.id, next), stillCurrent, canRelateTo(inst), parent);
    // A refused edge (a cycle, most often) is refused whole, like a hand edit. Say so beside
    // the task, and retry on later sweeps, when the source or the local graph may have moved.
    // Only the check and the error are recorded: `next` carries the merge's advanced baseline,
    // which would mark the groups this refused pass never wrote as already synced.
    const refusal = dependencyRefusal(applied);
    if (refusal && stillCurrent()) {
      saveSourceSync(task.id, inst.id, { ...record, checkedAt: next.checkedAt, error: refusal });
    }
    if (!applied.ok || next.error) counts.skipped++;
    else if (next.pending) counts.conflicted++;
    else if (!sameSourceContent(local, content)
      || (parent !== undefined && !sameSourceRef(parent, task.sourceParent))) counts.updated++;
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
  const local = localSourceContent(task, relation(inst, () => tasks.sourceRelationTasks(task)));
  if (!record?.pending || record.error || syncGroups(inst, record).length === 0
    || reviewVersion(task, local, inst, record) !== version) {
    return { ok: false, error: "This review changed. Sweep again and review the current values." };
  }
  if (listTaskSourceBacklog(inst.id).filter((t) => t.source?.externalId === task.source!.externalId).length !== 1) {
    return { ok: false, error: "Several backlog tasks link to this item; resolve the duplicates first." };
  }
  const content = sourceContent(local);
  const baseline = sourceContent(record.baseline ?? record.pending);
  for (const group of record.conflicts) {
    copySourceGroup(baseline, record.pending, group);
    if (choice === "source") copySourceGroup(content, record.pending, group);
  }
  const next: SourceSyncRecord = { ...record, origin: record.origin === "pushed" ? "pushed" : "imported",
    baseline, pending: null, conflicts: [], appliedAt: choice === "source" ? Date.now() : record.appliedAt };
  const applied = await tasks.applySourceContent(task.id, task.source, local, content,
    () => saveSourceSync(task.id, inst.id, next),
    () => sourceIsCurrent(inst) && sameRecord(getSourceSync(task.id), record), canRelateTo(inst));
  const refusal = dependencyRefusal(applied);
  return refusal ? { ok: false, error: refusal } : applied;
}
