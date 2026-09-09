import type {
  TaskSourceInstance,
  WritebackAction,
  WritebackContext,
  WritebackNotice,
  WritebackResult,
  WritebackSignal,
} from "@shared/task-source.ts";
import type { Task } from "@shared/types.ts";
import { envVar } from "../config.ts";
import {
  claimDueWritebacks,
  enqueueWriteback,
  settleWriteback,
  type WritebackRow,
  type WritebackSettlement,
  type WritebackState,
} from "../db.ts";
import type { TaskPrLinked, Registry } from "../registry.ts";
import { publishSettingsStatus } from "../settings-status.ts";
import { unref } from "../util/timers.ts";
import { getTaskSourcesConfig } from "./config.ts";
import { annotateWith, canAnnotateTo, canResolveTo, resolveWith } from "./index.ts";

// The third chokepoint on the task-source paths, beside `ingest.ts` (inbound) and
// `push.ts` (one of our tasks, filed upstream). This one is the other outward direction:
// a note written back onto the item a task was ALREADY swept from. Nothing else on this
// path touches `task_source_writeback`.
//
// The asymmetry with `push.ts` is the whole reason this file is shaped the way it is. A
// push is one operator click on one task, so its safety comes from the click and from an
// in-flight guard held across the subprocess. A write-back is automatic and unattended,
// so neither of those is available, and two other things stand in for them:
//
//   - CONSENT lives in configuration. Three switches per source, every one off by
//     default, re-read at enqueue AND again at delivery. A source nobody has switched on
//     writes nothing, which is every source in every installation that predates this.
//   - IDEMPOTENCY lives in the ledger key. A re-observed pull request, a repeated poller
//     tick and a daemon restart all insert nothing, because the identity index already
//     holds the row. Nothing here needs to remember what it has already seen.
//
// The other structural fact: both observation points are synchronous and on hot paths
// documented "listeners must not throw" - `acceptPrForEpisode` inside the PR poller's
// reconciliation, and `finishCompletion` inside `session_upsert` / `session_remove`
// listeners that read the registry on the very next line. So enqueue is a local insert
// and nothing else, every method is wrapped so it cannot throw into its caller, and every
// subprocess and every HTTPS call happens on the worker's own tick.

/** How often the worker wakes to drain what is due. Floored, like the sweeper's tick. */
const TICK_MS = Math.max(
  5_000,
  Number(envVar("TASK_SOURCE_WRITEBACK_TICK_MS") ?? 20_000),
);

/**
 * How long a resolve waits before it may be spent.
 *
 * Not a durability nicety. `settleIfEpisodeFinished` concludes a task from an idle agent,
 * and `reopenIfWorkResumed` reverses that conclusion when the agent turns out to be
 * working - so a completion is REVERSIBLE, and closing somebody's issue in the same tick
 * as an inferred completion is the one mistake this feature could make that a person has
 * to undo by hand. The window is the pause; the worker's live re-check is what actually
 * decides.
 */
const SETTLE_MS = Math.max(
  0,
  Number(envVar("TASK_SOURCE_WRITEBACK_SETTLE_MS") ?? 5 * 60_000),
);

/** Refusals before a row is given up on. Six attempts spans roughly half an hour of backoff. */
const MAX_ATTEMPTS = 6;
/** First retry delay; doubles per attempt. */
const BACKOFF_BASE_MS = 60_000;
/** Ceiling on that doubling, so a wedged upstream is retried hourly rather than never. */
const BACKOFF_MAX_MS = 30 * 60_000;
/** Rows one tick may deliver, so a backlog drains steadily instead of in one burst. */
const MAX_PER_TICK = 20;

/** How long after a refusal this row may be tried again. */
export function backoffFor(attempts: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

/**
 * The I/O seams a test replaces. Nothing here is a policy choice; they are the I/O.
 *
 * The same shape and the same rationale as `PushDeps` and `IngestDeps`: the decisions -
 * which refusals come before the network call, what an unknown outcome means, what a
 * reopened task does to a resolve - stay in the functions, so a test that swaps these is
 * exercising the real ordering rather than a parallel one.
 */
export interface WritebackDeps {
  annotate?: (
    inst: TaskSourceInstance,
    notice: WritebackNotice,
    ctx: WritebackContext,
  ) => Promise<WritebackResult>;
  resolve?: (
    inst: TaskSourceInstance,
    notice: WritebackNotice,
    ctx: WritebackContext,
  ) => Promise<WritebackResult>;
  enqueue?: typeof enqueueWriteback;
  claim?: typeof claimDueWritebacks;
  settle?: typeof settleWriteback;
  sources?: () => TaskSourceInstance[];
  now?: () => number;
  /** How long a resolve is held. Injected so a test does not wait five minutes. */
  settleMs?: number;
  log?: (msg: string) => void;
}

interface Resolved extends Required<Omit<WritebackDeps, "log">> {
  log: (msg: string) => void;
}

function withDefaults(deps: WritebackDeps): Resolved {
  return {
    annotate: deps.annotate ?? annotateWith,
    resolve: deps.resolve ?? resolveWith,
    enqueue: deps.enqueue ?? enqueueWriteback,
    claim: deps.claim ?? claimDueWritebacks,
    settle: deps.settle ?? settleWriteback,
    sources: deps.sources ?? (() => getTaskSourcesConfig().sources),
    now: deps.now ?? Date.now,
    settleMs: deps.settleMs ?? SETTLE_MS,
    log: deps.log ?? ((m: string) => console.log(`[writeback] ${m}`)),
  };
}

// ---- the notice builders ----

/**
 * The snapshot one delivery carries.
 *
 * Pure and exported, because what a person reads on their issue is worth pinning: this is
 * where the task's own words and the pull request's url become the only two facts that
 * leave this process about a piece of work.
 */
export function noticeFor(
  task: Task,
  signal: WritebackSignal,
  action: WritebackAction,
  opts: { prUrl: string | null; repoRoot: string; observedAt: number },
): WritebackNotice | null {
  if (!task.source) return null;
  return {
    signal,
    action,
    externalId: task.source.externalId,
    externalUrl: task.source.url,
    taskTitle: task.title,
    prUrl: opts.prUrl,
    repoRoot: opts.repoRoot,
    // Only a completion has words of its own. A pull request opening is a fact about a
    // link, and padding it with a stale outcome from some earlier cycle would be a
    // sentence nobody wrote.
    outcome: signal === "task-completed" ? task.outcome : null,
    observedAt: opts.observedAt,
  };
}

/**
 * What makes one delivery ONE delivery.
 *
 * For `pr-opened`, the pull request url: the same pull request observed on twenty poller
 * ticks is one comment.
 *
 * For `task-completed`, the task id AND the instant it completed. The instant is
 * load-bearing rather than decoration. A completion inferred from an idle agent can be
 * reversed by `reopenIfWorkResumed`, and the task then completes again for real - keyed on
 * the task id alone, that second, GENUINE completion collides with the first cycle's row,
 * whatever state it reached, and `ON CONFLICT DO NOTHING` drops it in silence, so the
 * issue is never resolved at all. Keyed with the instant, each completion cycle is its own
 * delivery while a repeated observation of the same completion still dedupes to nothing.
 */
export function dedupeKeyFor(notice: WritebackNotice, task: Pick<Task, "id" | "completedAt">): string {
  if (notice.signal === "pr-opened") return notice.prUrl ?? `${task.id}:no-pr`;
  return `${task.id}:${task.completedAt ?? 0}`;
}

// ---- the enqueue chokepoint ----

/**
 * The seam `TaskManager` and the daemon's PR poller subscription call.
 *
 * An injected interface rather than a second event bus, in the style of `PushDeps`: there
 * is exactly one producer of each signal, and a bus would only add a place for the wiring
 * to be forgotten silently.
 */
export interface WritebackEnqueuer {
  /** A pull request became this task's, in this repository. */
  prLinked(e: TaskPrLinked): void;
  /** This task reached `done`, with these words. */
  completed(task: Task): void;
}

/** The one place a source's stored consent is read. */
function triggerOn(inst: TaskSourceInstance, signal: WritebackSignal): boolean {
  return signal === "pr-opened" ? inst.writeback.onPrOpened : inst.writeback.onCompleted;
}

/**
 * Build the enqueuer the daemon wires to both observation points.
 *
 * Both methods do the same local, synchronous work in the same order, and the order is
 * the design - every step that can say no is cheaper than the one after it, and the first
 * of them is the one that answers for nearly every task in a normal installation:
 *
 *  1. `task.source` is null. Nothing was swept, so there is nowhere to write.
 *  2. The source is no longer configured. Its consent went with it.
 *  3. The trigger is off - the default, per source.
 *  4. The KIND cannot do it. Asked through `canAnnotateTo` / `canResolveTo`, never by
 *     testing `inst.kind`, so a kind that gains the verb later needs no edit here.
 *  5. Insert, on conflict do nothing.
 */
export function makeWritebackEnqueuer(
  registry: Registry,
  deps: WritebackDeps = {},
): WritebackEnqueuer {
  const d = withDefaults(deps);

  const owe = (
    task: Task,
    signal: WritebackSignal,
    action: WritebackAction,
    opts: { prUrl: string | null; repoRoot: string; observedAt: number; dueAt: number },
  ): void => {
    if (!task.source) return;
    const inst = d.sources().find((s) => s.id === task.source!.sourceId);
    if (!inst) return;
    if (!triggerOn(inst, signal)) return;
    if (action === "annotate" ? !canAnnotateTo(inst) : !canResolveTo(inst)) return;
    const notice = noticeFor(task, signal, action, opts);
    if (!notice) return;
    const first = d.enqueue(
      {
        sourceId: inst.id,
        externalId: notice.externalId,
        signal,
        action,
        dedupeKey: dedupeKeyFor(notice, task),
        taskId: task.id,
        notice,
        nextAt: opts.dueAt,
      },
      opts.observedAt,
    );
    // Logged on the FIRST observation only. The repeat is the normal case - a poller tick
    // seeing the same pull request again - and a line per tick would bury the one that
    // says a delivery was actually owed.
    if (first) {
      d.log(`${inst.label || inst.id}: ${action} owed on ${notice.externalId} (${signal})`);
    }
  };

  // Each method is wrapped whole. `prLinked` runs inside the PR poller's reconciliation
  // and `completed` inside `finishCompletion`, which itself runs inside session listeners
  // that read the registry on the next line - a throw out of either would abort work that
  // has already been persisted and broadcast, to add a comment nobody is waiting for.
  return {
    prLinked(e) {
      try {
        const task = registry.getTask(e.taskId);
        if (!task) return;
        owe(task, "pr-opened", "annotate", {
          prUrl: e.prUrl,
          repoRoot: e.repoRoot,
          observedAt: e.observedAt,
          dueAt: e.observedAt,
        });
      } catch (err) {
        console.error("[writeback] enqueue on pr link failed:", e.taskId, err);
      }
    },
    completed(task) {
      try {
        const now = task.completedAt ?? d.now();
        const opts = { prUrl: task.outcomeUrl, repoRoot: task.repoRoot, observedAt: now };
        owe(task, "task-completed", "annotate", { ...opts, dueAt: now });
        // The resolve is a SECOND row rather than a flag on the first, and that is what
        // buys both the settle window and the ordering: it comes due later and carries the
        // higher id, and `claimDueWritebacks` will not hand it over until every earlier row
        // for this item is `delivered` or `cancelled` - including one that was refused and
        // is sitting in a backoff whose next attempt is further out than the settle window.
        // A close that overtook its own outcome comment would leave an issue shut with no
        // explanation on the thread, which is the one ordering this feature promises.
        if (task.source) {
          const inst = d.sources().find((s) => s.id === task.source!.sourceId);
          if (inst?.writeback.resolve) {
            owe(task, "task-completed", "resolve", { ...opts, dueAt: now + d.settleMs });
          }
        }
      } catch (err) {
        console.error("[writeback] enqueue on completion failed:", task.id, err);
      }
    },
  };
}

// ---- the worker ----

/** What one row's re-validation concluded, before anything left the process. */
type Recheck =
  | { go: true; inst: TaskSourceInstance }
  | { go: false; why: string };

/**
 * Ask the world as it is NOW whether this row should still be spent.
 *
 * Between the observation and this moment an operator may have removed the source,
 * switched the trigger off, or seen the task come back to life. Every one of those is a
 * reason not to write, and the reason is recorded so the panel can say which.
 *
 * The asymmetry between the two actions is deliberate. A resolve re-checks the TASK: a
 * task that `reopenIfWorkResumed` put back, or that was rescheduled or deleted, must not
 * have its issue closed. An annotate does not: "a pull request opened for this" was true
 * when it was observed and stays true, and a comment about it is worth posting whatever
 * became of the task afterwards.
 */
function recheck(row: WritebackRow, registry: Registry, sources: TaskSourceInstance[]): Recheck {
  const inst = sources.find((s) => s.id === row.sourceId);
  if (!inst) return { go: false, why: "this source is no longer configured" };
  if (!triggerOn(inst, row.signal)) {
    return { go: false, why: "this source's trigger was switched off" };
  }
  if (row.action === "annotate" && !canAnnotateTo(inst)) {
    return { go: false, why: `${inst.kind} cannot write back to its items` };
  }
  if (row.action === "resolve") {
    if (!inst.writeback.resolve) return { go: false, why: "auto-resolve was switched off" };
    if (!canResolveTo(inst)) return { go: false, why: `${inst.kind} cannot resolve its items` };
    const task = row.taskId ? registry.getTask(row.taskId) : null;
    if (!task) return { go: false, why: "the task is gone, so its completion cannot be confirmed" };
    if (task.status !== "done") {
      return { go: false, why: `the task is ${task.status} again, so it is not finished` };
    }
  }
  return { go: true, inst };
}

/**
 * One tick: claim what is due, re-validate it, deliver it, record what happened.
 *
 * Returns how many rows reached a TERMINAL state, which is the caller's cue to recompose
 * the settings status - `delivered`, `failed`, `unknown` and `cancelled` are the four the
 * gear's dot could care about, and a row that merely backed off has moved nothing a person
 * can see.
 */
export async function drainWritebacks(
  registry: Registry,
  deps: WritebackDeps = {},
): Promise<number> {
  const d = withDefaults(deps);
  const rows = d.claim(d.now(), MAX_PER_TICK);
  if (rows.length === 0) return 0;
  const sources = d.sources();
  let terminal = 0;

  const finish = (id: number, state: WritebackState, patch: WritebackSettlement): void => {
    d.settle(id, state, patch, d.now());
    terminal += 1;
  };

  for (const row of rows) {
    // A row whose payload this build cannot read, or whose payload contradicts the row's
    // own `signal` / `action` columns, will never deliver anything honest - so it is
    // settled rather than left pending to be re-claimed on every tick for the rest of the
    // daemon's life. See `readWritebackNotice`.
    if (!row.notice) {
      finish(row.id, "failed", {
        lastError:
          "this delivery's stored details could not be read, or disagree with the delivery itself",
      });
      continue;
    }
    const verdict = recheck(row, registry, sources);
    if (!verdict.go) {
      d.log(`${row.sourceId}: ${row.action} on ${row.externalId} cancelled - ${verdict.why}`);
      finish(row.id, "cancelled", { lastError: verdict.why });
      continue;
    }
    const inst = verdict.inst;
    const ctx: WritebackContext = {
      sourceId: inst.id,
      // The source's own repo, not the notice's: this is where a subprocess is run and
      // which checkout resolves the upstream, and a source is configured against exactly
      // one. The repository the pull request is IN travels in the notice instead.
      repoRoot: inst.repoRoot,
      // Shape parity with a sweep, exactly as on `push`. Nothing cancels a comment that
      // has already been sent, so an implementation must not pretend it can.
      signal: new AbortController().signal,
    };
    const result =
      row.action === "annotate"
        ? await d.annotate(inst, row.notice, ctx)
        : await d.resolve(inst, row.notice, ctx);

    // Asked BEFORE the error, because an unknown outcome usually carries an error message
    // too and reading that first would collapse the distinction this whole feature turns
    // on. `push.ts` makes the same ordering choice, and it matters more here: a retried
    // comment is noise, a retried transition can undo a person.
    if (result.outcomeUnknown) {
      d.log(
        `${inst.label || inst.id}: ${row.action} on ${row.externalId} did not report back - ` +
          `it may have landed; check upstream before retrying`,
      );
      finish(row.id, "unknown", {
        attempts: row.attempts + 1,
        lastError: result.error ?? "the write did not report back - it may have landed",
      });
      continue;
    }
    if (result.error) {
      const attempts = row.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        d.log(`${inst.label || inst.id}: ${row.action} on ${row.externalId} gave up: ${result.error}`);
        finish(row.id, "failed", { attempts, lastError: result.error });
        continue;
      }
      // Still `pending`, so this is not a terminal move and the status is not recomposed:
      // nothing a person can see has changed yet.
      d.settle(
        row.id,
        "pending",
        { attempts, nextAt: d.now() + backoffFor(attempts), lastError: result.error },
        d.now(),
      );
      continue;
    }
    finish(row.id, "delivered", {
      attempts: row.attempts + 1,
      lastDetail: result.detail,
    });
  }
  return terminal;
}

/**
 * Drive the queue on an interval.
 *
 * The canonical loop shape the sweeper and the PR poller already use: a self-rescheduling
 * `setTimeout` rather than `setInterval`, so ticks cannot overlap while a `gh` call is in
 * flight; `unref`'d so a pending tick never holds the process open; try/catch inside the
 * tick so one bad delivery cannot kill the loop; and a returned stopper `shutdown()` calls.
 *
 * A tick that moved anything to a terminal state recomposes the settings status, so the
 * gear's dot can react to a queue that started failing. WHAT that dot counts is
 * `settingsStatus()`'s business and is not extended here - triggering the recompute is
 * correct before and after it learns about this queue.
 */
export function startWritebackWorker(registry: Registry, deps: WritebackDeps = {}): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      if (await drainWritebacks(registry, deps)) publishSettingsStatus(registry);
    } catch (err) {
      console.error("[writeback] tick failed:", err);
    }
    if (stopped) return;
    timer = unref(setTimeout(tick, TICK_MS));
  };

  void tick();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
