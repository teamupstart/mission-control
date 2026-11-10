import type { TaskDependencyInput } from "@shared/protocol.ts";
import type {
  LinkedReadResult,
  SweepContext,
  TaskCandidate,
  TaskSourceInstance,
  TaskSourceRef,
} from "@shared/task-source.ts";
import type { Task, TaskSourceItemState } from "@shared/types.ts";
import { canRelateTo, readLinkedSource } from "./index.ts";

// Blocking links recovered through a task source (`canRelate`), in both halves:
//
//  - on ingest, a candidate's `blockedBy` refs become dependency inputs for the task being
//    filed - a task edge when the blocker is already one of our tasks, a `source` edge
//    otherwise (`dependenciesFor`, which asks `TaskManager.acceptsNewTaskEdgeTo`);
//  - after each sweep, the `source` edges still waiting are re-read through the source's
//    linked read, and what it says is recorded on the edges (`recheckSourceDependencies`).
//
// Nothing here branches on the kind: the registry's `canRelateTo` is the whole question.
// And nothing here writes the database: `TaskManager.create` resolves the inputs (cycle
// refusal included) and `TaskManager.observeSourceItems` records what the read found.

/** How many external items one sweep re-reads: one linked read's own limit. */
export const SOURCE_RECHECK_BUDGET = 25;

/** What a candidate's blocking links ask `TaskManager.create` for. */
export interface CandidateDependencies {
  /** Task edges, resolved like any operator's selection (cycle refusal included). */
  dependencies: TaskDependencyInput[];
  /** External items, which `create` turns into new `source` edges. */
  sourceDependencies: TaskSourceRef[];
}

/**
 * The dependencies a candidate's blocking links ask for.
 *
 * Empty for a source whose kind cannot relate, whatever the candidate carries. Otherwise
 * `blockerDependencies` decides each edge.
 */
export function dependenciesFor(
  inst: TaskSourceInstance,
  candidate: TaskCandidate,
  listTasks: () => Task[],
  acceptsTaskEdge: (taskId: string) => boolean,
): CandidateDependencies {
  if (!canRelateTo(inst) || !candidate.blockedBy?.length) return { dependencies: [], sourceDependencies: [] };
  return blockerDependencies(candidate.ref.externalId, candidate.blockedBy, listTasks(), acceptsTaskEdge);
}

/**
 * Which edge each blocking link becomes: the one rule, for a task filed by a sweep and for
 * blockers a later sync adds to it (`TaskManager.sourceSyncedDependencies`).
 *
 * A blocker linked to one of our tasks that may take a new task edge becomes one, which
 * then follows that task to its merge like any operator's edge. Whether it may is
 * `TaskManager`'s rule (`acceptsNewTaskEdgeTo`), passed in as `acceptsTaskEdge` so it has
 * one owner. Every other blocker - never swept, filtered out of this source, or linked to
 * a task that already finished, stopped, or has no live session yet - becomes a `source`
 * edge, released only by the item itself closing as completed. The parent link is never
 * an edge, and the item never blocks itself (`selfExternalId`).
 */
export function blockerDependencies(
  selfExternalId: string,
  blockedBy: TaskSourceRef[],
  tasks: Task[],
  acceptsTaskEdge: (taskId: string) => boolean,
): CandidateDependencies {
  const out: CandidateDependencies = { dependencies: [], sourceDependencies: [] };
  const seen = new Set<string>();
  for (const ref of blockedBy) {
    if (ref.externalId === selfExternalId || seen.has(ref.externalId)) continue;
    seen.add(ref.externalId);
    const linked = tasks.find(
      (task) =>
        task.source?.sourceId === ref.sourceId &&
        task.source.externalId === ref.externalId &&
        acceptsTaskEdge(task.id),
    );
    if (linked) out.dependencies.push({ type: "task", taskId: linked.id });
    else out.sourceDependencies.push(ref);
  }
  return out;
}

/**
 * A sweep's candidates, with every blocker in the same batch filed before what it blocks.
 *
 * Without this, an issue listed before its own blocker would find no task for it yet and
 * take a `source` edge, although the blocker is filed a moment later. Otherwise the
 * source's own order stands. A cycle upstream is left in that order: filing it would
 * deadlock two tasks, and `TaskManager.create` refuses the edge that closes it.
 */
export function orderByBlockers(candidates: TaskCandidate[]): TaskCandidate[] {
  const byId = new Map(candidates.map((c) => [c.ref.externalId, c]));
  const out: TaskCandidate[] = [];
  const placed = new Set<string>();
  const visiting = new Set<string>();
  const place = (c: TaskCandidate): void => {
    const id = c.ref.externalId;
    if (placed.has(id) || visiting.has(id)) return;
    visiting.add(id);
    for (const ref of c.blockedBy ?? []) {
      const blocker = byId.get(ref.externalId);
      if (blocker) place(blocker);
    }
    visiting.delete(id);
    placed.add(id);
    out.push(c);
  };
  for (const c of candidates) place(c);
  return out;
}

/**
 * The external items this source's waiting `source` edges name, least recently checked
 * first, at most `limit` of them.
 *
 * Only backlog tasks' edges: a dependency gates scheduling, so once a task has started
 * what it waited on no longer matters. Both open and not-planned items are read, so an
 * item reopened upstream stops showing as stopped.
 */
export function sourceEdgesToRecheck(
  tasks: Task[],
  sourceId: string,
  limit = SOURCE_RECHECK_BUDGET,
): TaskSourceRef[] {
  const oldest = new Map<string, { ref: TaskSourceRef; checkedAt: number }>();
  for (const task of tasks) {
    if (task.status !== "backlog") continue;
    for (const d of task.dependencies) {
      if (d.type !== "source" || d.sourceId !== sourceId || d.satisfiedAt !== null) continue;
      const checkedAt = d.checkedAt ?? 0;
      const prior = oldest.get(d.externalId);
      if (!prior || checkedAt < prior.checkedAt) {
        oldest.set(d.externalId, {
          ref: { sourceId, externalId: d.externalId, url: d.url },
          checkedAt,
        });
      }
    }
  }
  return [...oldest.values()]
    .sort((a, b) => a.checkedAt - b.checkedAt || a.ref.externalId.localeCompare(b.ref.externalId))
    .slice(0, limit)
    .map((entry) => entry.ref);
}

export interface SourceItemObservation {
  externalId: string;
  state: TaskSourceItemState | null;
  title?: string;
}

/** What one re-read learned, per item. `state: null` is an item the read could not answer. */
export function observationsFrom(
  refs: TaskSourceRef[],
  read: LinkedReadResult,
): SourceItemObservation[] {
  const found = new Map(read.items.map((item) => [item.ref.externalId, item]));
  return refs.flatMap((ref): SourceItemObservation[] => {
    const item = found.get(ref.externalId);
    if (item?.state) return [{ externalId: ref.externalId, state: item.state, title: item.title }];
    // A whole-read failure (auth, an abandoned sweep) says nothing about any one item, so
    // it does not touch the queue; a per-item failure moves that item to the back of it.
    if (read.error) return [];
    return [{ externalId: ref.externalId, state: null }];
  });
}

/** The seams a test replaces. */
export interface RecheckDeps {
  read?: typeof readLinkedSource;
}

/** The part of `TaskManager` a re-check needs. */
export interface RecheckTasks {
  list(): Task[];
  observeSourceItems(sourceId: string, observations: SourceItemObservation[]): void;
}

/**
 * Re-read the external items this source's waiting `source` edges name, within the
 * sweep's budget, and record what they say. Returns how many items were read.
 */
export async function recheckSourceDependencies(
  inst: TaskSourceInstance,
  tasks: RecheckTasks,
  ctx: SweepContext,
  deps: RecheckDeps = {},
): Promise<number> {
  if (!canRelateTo(inst)) return 0;
  const refs = sourceEdgesToRecheck(tasks.list(), inst.id);
  if (refs.length === 0 || ctx.signal.aborted) return 0;
  const read = await (deps.read ?? readLinkedSource)(inst, refs, ctx);
  const observations = observationsFrom(refs, read);
  if (observations.length > 0) tasks.observeSourceItems(inst.id, observations);
  return refs.length;
}
