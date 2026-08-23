import { DispatchSchema } from "@shared/protocol.ts";
import type {
  SweepReport,
  SweepResult,
  TaskCandidate,
  TaskSourceInstance,
} from "@shared/task-source.ts";
import { inTransaction, recordTaskSourceSeen, seenExternalIds } from "../db.ts";
import { resolveTaskRepoRoot, type TaskRepoRoot } from "../repos.ts";
import type { TaskManager } from "../tasks.ts";

// Everything a task source does NOT get to do. A source returns candidates; this decides
// which of them become rows, and it is the only thing in the feature that writes.
//
// Concentrating it here is what makes the interface safe to hand out: a source that got
// de-duplication wrong would re-file the same issue every sweep, forever, and no amount
// of documentation makes that impossible. Enforcing it once does.

/** The seams a test replaces. Nothing here is a policy choice; they are the I/O. */
export interface IngestDeps {
  /** Validate a candidate's repo is a repo's main checkout. The dispatch route's own check. */
  resolveRepoRoot?: (p: string) => Promise<TaskRepoRoot>;
  /** What this source has already filed. */
  seen?: (sourceId: string) => Set<string>;
  /** Remember that it has filed this one. */
  remember?: (sourceId: string, externalId: string, url: string | null) => void;
  /** Run the two writes together. */
  transaction?: <T>(fn: () => T) => T;
  log?: (msg: string) => void;
}

/**
 * Turn one sweep's candidates into backlog rows.
 *
 * In order, and the order matters:
 *
 *  1. Drop anything already seen, keyed `(sourceId, externalId)` against
 *     `task_source_seen` - NOT against the live tasks. A task you deleted stays deleted.
 *  2. Resolve and validate `repoRoot` through the same `resolveTaskRepoRoot` the dispatch
 *     route uses, so a source cannot file against a path that is not a repo's main
 *     checkout - not a non-repo, and not a worktree the scheduler could never act on.
 *  3. Normalize through `DispatchSchema`, so `normalizeLabels` and the priority enum
 *     apply to a machine-authored task exactly as to a typed one.
 *  4. Cap at `maxPerSweep` and SAY what was dropped - a silent truncation reads as
 *     "that's all there was".
 *  5. Create through `TaskManager.create({…, backlog: true})`, the same path the
 *     dispatch form takes, carrying the source's autopilot default so the task's initial
 *     enabled state is part of the same insert rather than a follow-up write.
 *  6. Record the seen row, in the same transaction as the insert.
 *
 * A swept task always lands in the BACKLOG. Auto-dispatching is a different risk class
 * and would need its own gate (an allowlist, a rate limit, a dry run) of the kind Foreman
 * carries; nothing here provisions anything, cuts a worktree, or types into a pane.
 */
export async function ingestSweep(
  inst: TaskSourceInstance,
  result: SweepResult,
  tasks: TaskManager,
  deps: IngestDeps = {},
): Promise<SweepReport> {
  const resolve = deps.resolveRepoRoot ?? resolveTaskRepoRoot;
  const seenOf = deps.seen ?? seenExternalIds;
  const remember = deps.remember ?? recordTaskSourceSeen;
  const transaction = deps.transaction ?? inTransaction;
  const log = deps.log ?? ((m: string) => console.log(`[task-source] ${m}`));

  const report: SweepReport = {
    sourceId: inst.id,
    filed: 0,
    alreadySeen: 0,
    overCap: 0,
    refused: [],
    error: result.error,
  };

  // 1. Already filed. Read once, and extended in memory as we go: two candidates in ONE
  //    sweep can carry the same externalId (a paginated list that shifted under us), and
  //    without the in-memory half the second would be filed as new.
  const seen = seenOf(inst.id);
  const fresh: TaskCandidate[] = [];
  for (const c of result.items) {
    const id = c.ref.externalId;
    if (!id || seen.has(id)) {
      report.alreadySeen += 1;
      continue;
    }
    seen.add(id);
    fresh.push(c);
  }

  // 4. The cap, applied to what is actually new and reported rather than swallowed. Done
  //    before the repo checks so a runaway sweep costs a bounded number of subprocesses.
  const admitted = fresh.slice(0, inst.maxPerSweep);
  report.overCap = fresh.length - admitted.length;
  if (report.overCap > 0) {
    log(
      `${inst.label || inst.id}: ${fresh.length} new items, filed the first ${admitted.length} ` +
        `(maxPerSweep=${inst.maxPerSweep}); ${report.overCap} left for the next sweep`,
    );
  }

  for (const c of admitted) {
    // 2. A path that is not a repo's main checkout, refused here rather than discovered
    //    later by a dispatcher half-way through cutting a worktree - or, for a worktree
    //    path, never discovered at all, since the scheduler would simply pass the row
    //    over forever. The refusal is reported, not swallowed: `refused` is what the
    //    panel shows, so a misconfigured source says so instead of sweeping up nothing.
    const resolved = await resolve(c.repoRoot);
    if (!resolved.ok) {
      report.refused.push(`${c.ref.externalId}: ${resolved.error}`);
      continue;
    }
    const repoRoot = resolved.repoRoot;

    // 3. The same validation a typed task gets, from the same schema. A source is not
    //    trusted to have capped its labels or to have invented a priority level.
    const parsed = DispatchSchema.safeParse({
      repoRoot,
      intent: c.intent,
      title: c.title,
      kind: c.kind ?? inst.defaults.kind,
      // `?? undefined` and not `?? null`: an unset source is asking the KIND, and
      // `DispatchSchema.agent` spells that absence rather than null. A candidate that names
      // its own agent still wins over both.
      agent: c.agent ?? inst.defaults.agent ?? undefined,
      // `??` and not `||`: a candidate that deliberately says `null` is saying "no
      // priority", and must not silently inherit the source's default.
      priority: c.priority !== undefined ? c.priority : inst.defaults.priority,
      // Union rather than override: the source's defaults are what every task from it
      // carries ("swept", "triage"), and the candidate's are what THIS item is about.
      labels: [...inst.defaults.labels, ...(c.labels ?? [])],
      backlog: true,
    });
    if (!parsed.success) {
      report.refused.push(`${c.ref.externalId}: ${parsed.error.message}`);
      continue;
    }

    try {
      // 5 + 6, together. A task with no seen row is re-filed on every sweep forever; a
      // seen row with no task is an item silently swallowed. Neither is fixed by
      // retrying, so they are not allowed to happen separately.
      transaction(() => {
        remember(inst.id, c.ref.externalId, c.ref.url);
        tasks.create({
          ...parsed.data,
          repoRoot,
          source: c.ref,
          enabled: inst.defaults.enabled,
        });
      });
      report.filed += 1;
    } catch (err) {
      // The transaction rolled back, so this item is neither filed nor seen and the next
      // sweep will try it again - which is the right outcome for a transient failure and
      // is why this does not abandon the rest of the batch.
      report.refused.push(
        `${c.ref.externalId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (report.filed > 0) {
    log(`${inst.label || inst.id}: filed ${report.filed} task(s) into the backlog`);
  }
  return report;
}
