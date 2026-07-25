import { randomUUID } from "node:crypto";
import type {
  AgentType,
  AssignRefusalScope,
  AssignResetConfirm,
  ResetResult,
  Session,
  Task,
  TaskDependency,
  TaskKind,
  TaskPriority,
} from "@shared/types.ts";
import type { TaskDependencyInput, UpdateTask } from "@shared/protocol.ts";
import type { TaskSourceRef } from "@shared/task-source.ts";
import { isAnnotationOnlyUpdate } from "@shared/protocol.ts";
import { supportsEffort } from "@shared/harness-capabilities.ts";
import { canWriteTo } from "@shared/pane.ts";
import { gateParked } from "@shared/session.ts";
import { declaredBlockers, type BacklogBlocker } from "@shared/backlog.ts";
import { completableByMerge, type Registry, type TaskPrMerged } from "./registry.ts";
import {
  Dispatcher,
  deriveTitle,
  teardownWorktree,
  type TaskDispatchOptions,
} from "./dispatcher.ts";
import {
  branchReleasedByReset,
  injectPrompt,
  kill,
  nameRulesFor,
  paneAcceptsPrompt,
  rename,
  resetWouldDestroyWork,
  validateSessionName,
  validateSessionNameAgainstTasks,
  type ActionResult,
} from "./actions.ts";
import {
  getTask as getDurableTask,
  historicalTaskWorkEpisodeBindingsForTask,
  taskWorkEpisodeForTask,
} from "./db.ts";
import { resetSession } from "./reset.ts";
import { getShippingConfig } from "./shipping/config.ts";
import { homeAlive } from "./terminal/home.ts";
import { summariseTaskTitle } from "./task-title.ts";

export interface CreateTaskInput {
  repoRoot: string;
  intent: string;
  title?: string;
  kind: TaskKind;
  agent: AgentType;
  /** Optional urgency. Omitted means unset, which is not the same as `low`. */
  priority?: TaskPriority | null;
  /** Optional tags, already normalized by the schema that parsed them. */
  labels?: string[];
  /** Launch this agent on a specific model; omitted follows the harness default. */
  model?: string;
  /** Launch with a specific reasoning effort; omitted follows the harness default. */
  effort?: import("@shared/types.ts").ThinkingLevel;
  /** Prerequisites selected from current backlog tasks or live sessions. */
  dependencies?: TaskDependencyInput[];
  /**
   * Where a task source swept this from. Omitted by every human-facing caller, which is
   * nearly all of them. Provenance only (see `Task.source`) - it is never consulted to
   * decide whether an item has been filed before.
   */
  source?: TaskSourceRef;
  /** Only add to the backlog (no worktree/session) - dispatch it later. */
  backlog: boolean;
}

/**
 * The three provenance values a schedule-created task carries, moved as one.
 *
 * A struct rather than three optional fields on `CreateTaskInput` because they are one
 * fact - which occurrence of which schedule filed this, and for what instant - and two of
 * three populated is not a partially-known task, it is a corrupt one.
 */
export interface TaskScheduleProvenance {
  scheduleId: string;
  scheduleOccurrenceId: string;
  /** The instant the task is FOR, not when it was filed. See `Task.scheduledFor`. */
  scheduledFor: number;
}

/**
 * What an INTERNAL, durable producer supplies that no human caller may: a task id it
 * chose itself, plus schedule provenance only when the scheduler is the producer. Ensemble
 * ownership stays normalized in `ensemble_members`; copying it onto Task would create a
 * second source of truth.
 *
 * The id is the whole mechanism behind retry-safe creation. The scheduler reserves an
 * occurrence and task id in one transaction; the ensemble engine persists a member attempt
 * and task id before creating the Task. Recovery repeats the same call, which returns an
 * existing Task only when its owning inputs still match and otherwise fails closed - see
 * `create`.
 *
 * Deliberately a second argument rather than fields on `CreateTaskInput`: every ordinary
 * caller parses a request body into that type, and an id accepted there would be an id an
 * HTTP client could choose.
 */
export type InternalCreateOptions =
  | {
      id: string;
      schedule: TaskScheduleProvenance;
    }
  | {
      id: string;
      schedule?: undefined;
    };

/** A preallocated id already belongs to a DIFFERENT task. Corruption, never idempotency. */
export class TaskIdCollisionError extends Error {}

export interface Ok {
  ok: boolean;
  error?: string;
}

/** A user-fixable dependency selection conflict, safe to return as HTTP 409. */
export class TaskDependencyError extends Error {}

export class TaskStatusConflictError extends Error {}

/**
 * Why the disabled toggle refuses by DEFAULT rather than trusting callers to identify
 * themselves, spelled out once for both options objects below.
 *
 * The first design had the autopilot declare itself and be refused on that basis. It
 * cannot work: the Foreman worker is a separate process started by hand
 * (`npm run foreman`), so it can outlive a daemon restart, and a worker that predates
 * this field sends nothing - which an "are you the autopilot?" flag reads as a human
 * override. That stale worker also has no `readyBacklog` filter of its own, so it would
 * cheerfully launch a task somebody had just parked.
 *
 * Inverting it removes the question. Nothing has to be identified: a request that does
 * not CLAIM an override does not get one, so the stale worker is refused by
 * construction. The dashboard ships in the same bundle as the daemon and can never be
 * skewed against it, so it can always claim the override behind the operator's own
 * "launch anyway" button - which is the one path that must keep working.
 */
const DISABLED_REFUSAL =
  "task is disabled - Foreman will not schedule it (launch it yourself to override)";

/** True when this call must be refused because the task is parked and nobody claimed an override. */
function refusedAsDisabled(task: Task, overrideDisabled: boolean | undefined): boolean {
  // Scoped to `backlog`: `enabled` gates SCHEDULING, and the retry path for a cleanly
  // failed task is not scheduling - that task already ran.
  return task.status === "backlog" && !task.enabled && overrideDisabled !== true;
}

/**
 * What a caller asks of ONE launch: the launch options the Dispatcher acts on
 * (`TaskDispatchOptions` - pinned base, required Mission MCP tools, the launch-time default
 * model Foreman may supply for an otherwise-unpinned backlog task) plus the one thing that
 * is a TaskManager decision rather than a launch property.
 *
 * The split is the point. `overrideDisabled` is an authorization the caller is claiming
 * about this request; everything else describes the agent that is about to start, and is
 * forwarded verbatim. Nothing here is persisted - see `TaskDispatchOptions`.
 */
export interface DispatchOptions extends TaskDispatchOptions {
  /** The caller is deliberately starting a parked task. See `DISABLED_REFUSAL`. */
  overrideDisabled?: boolean;
}

/** The seams and the one decision `TaskManager.assign` takes from its caller. */
export interface AssignOptions {
  /** The caller is deliberately handing over a parked task. See `DISABLED_REFUSAL`. */
  overrideDisabled?: boolean;
  /**
   * The caller has accepted what the handover reset discards beyond git state. False -
   * the default, and what an omitted flag gets - means a reset with anything to lose is
   * refused with the breakdown attached instead of run.
   */
  confirmReset?: boolean;
  /** Deliver the task's intent to the agent. The one call that types. */
  inject?: typeof injectPrompt;
  /** Ask whether the pane could take a prompt, before anything is done to the agent. */
  paneReady?: (session: Session) => Promise<ActionResult>;
  /** Hand the agent's checkout back in the shape a fresh one starts in. */
  reset?: (session: Session) => Promise<ResetResult>;
  /** Rename the agent's terminal after the task it just took. Cosmetic, never fatal. */
  rename?: (session: Session, name: string) => Promise<ActionResult>;
}

export interface CloseMergedSessionDeps {
  resetWouldDestroyWork: typeof resetWouldDestroyWork;
  kill: typeof kill;
}

const defaultCloseMergedSessionDeps: CloseMergedSessionDeps = {
  resetWouldDestroyWork,
  kill,
};

/**
 * An assign's answer. A refusal says whose fault it is, and - when the caller only has
 * to say yes - exactly what saying yes would spend.
 */
export interface AssignOutcome extends Ok {
  scope?: AssignRefusalScope;
  resetConfirm?: AssignResetConfirm;
}

export type DispatchOutcome =
  | { ok: true; task: Task }
  | { ok: false; error: string; task?: Task };

/** Whether the handover would take anything the caller has not already agreed to. */
function needsResetConfirm(c: AssignResetConfirm): boolean {
  // `clearsContext` is deliberately NOT a trigger, though it IS reported. Every agent
  // that can be assigned at all has a pane, so treating the `/clear` as something to ask
  // about would put a dialog in front of every drop - including onto a pooled worktree
  // sitting detached with nothing in it, which is the case that must stay one gesture.
  return c.queuedItems > 0 || c.branch != null;
}

/** The loss in one sentence, for the refusal a caller may show as-is. */
function describeResetLoss(c: AssignResetConfirm): string {
  const parts: string[] = [];
  if (c.queuedItems > 0) parts.push(`${c.queuedItems} queued work item(s)`);
  if (c.branch) parts.push(`the branch ${c.branch}`);
  if (c.clearsContext) parts.push("the agent's context");
  return parts.join(", ");
}

/**
 * Owns the task lifecycle: create/queue, kick off dispatch, cancel (tearing down
 * the live session + terminal home + optional worktree), complete with an outcome, and
 * remove from the list. The registry is the single store; this class is the
 * policy layer routes call into - the task analog of ReviewManager.
 */
export class TaskManager {
  private dispatcher: Dispatcher;
  /**
   * In-flight titling runs, by task id.
   *
   * A backlogged untitled task is on the board - and dispatchable - the instant `create`
   * returns, while its title is still being decided. Dispatching in that window would cut
   * the branch and terminal home name from the heuristic title and then rename only the card,
   * which is the exact mismatch the awaited-titling ordering exists to prevent. `dispatch`
   * awaits this first, so an early click waits a beat and gets the model's title instead.
   * Held here rather than checked at the route so the invariant holds on every path.
   */
  private titling = new Map<string, Promise<void>>();
  private assigningTasks = new Set<string>();
  private assigningSessions = new Set<string>();
  private reschedulingTasks = new Set<string>();
  /** Tasks concluded from an agent's idleness, and so reversible. See `reopenIfWorkResumed`. */
  private autoCompleted = new Map<string, string>();
  /** Re-entrancy guard for `reconcileMergedTasks`, which its own completions can re-enter. */
  private reconcilingMergedTasks = false;
  private completedInitialSessionSweep = false;
  constructor(
    private registry: Registry,
    private closeMergedSessionDeps: CloseMergedSessionDeps = defaultCloseMergedSessionDeps,
  ) {
    this.dispatcher = new Dispatcher(registry);
    // A restart severs the in-flight dispatch promises but leaves worktrees + terminal
    // homes on disk. Reconcile every task that still holds resources by checking
    // whether its agent's terminal home survived (any backend, resolved by name).
    for (const t of registry.listTasks()) {
      // Every `dispatching` task needs reconciling even before it acquired a
      // worktree (a restart mid-provision would otherwise strand it forever);
      // terminal tasks only when they still hold resources to check/reclaim.
      const needsReconcile =
        t.status === "dispatching" ||
        ((Boolean(t.worktreePath) || Boolean(t.homeName)) &&
          (t.status === "running" ||
            t.status === "failed" ||
            t.status === "done" ||
            t.status === "cancelled"));
      if (needsReconcile) void this.reconcileOnStartup(t);
    }

    // A bound session can also go away while the daemon is UP: the (k) kill, a terminal
    // the operator closed, an agent that exited by itself. Registry emits `session_remove`
    // only from its eviction timer, which is the durable answer - a session marked exited
    // by one sweep and rediscovered by the next never reaches it.
    registry.subscribe((e) => {
      if (e.type === "session_remove") {
        // Before `agentWentAway`, so a task whose work landed reads as done rather than
        // as a failure with a merged pull request sitting in its record. Registry deletes
        // the session before it emits this, so the reconciler sees the agent as gone;
        // `agentWentAway` keeps its own `mergedPrFor` check as the belt for any caller
        // that does not.
        this.reconcileMergedTasks();
        this.reconcileTasksBoundTo(e.id);
      }
      if (e.type === "task_remove") this.autoCompleted.delete(e.id);
      if (
        e.type === "task_upsert" &&
        this.autoCompleted.has(e.task.id) &&
        (e.task.status !== "done" ||
          e.task.sessionId !== this.autoCompleted.get(e.task.id))
      ) {
        this.autoCompleted.delete(e.task.id);
      }
      // The other end of a merged task's life, for an agent that is still here. See
      // `settleIfEpisodeFinished`.
      if (e.type === "session_upsert") {
        this.settleIfEpisodeFinished(e.session);
        this.reopenIfWorkResumed(e.session);
        // And the rows no session can settle: a terminal task whose pull request has since
        // merged, or one still bound to a session id nothing answers to. Cheap on the hot
        // path - a task whose agent is right here costs no query at all.
        this.reconcileMergedTasks();
      }
    });

    // And one that went away while the daemon was DOWN is in no map at all until discovery
    // rebuilds it, so the same reconciliation waits for the first completed sweep. This is
    // the half the startup loop above cannot reach: it only visits a task still holding a
    // worktree or a home, so an ASSIGNED task - handed to an agent the operator started, so
    // it never had resources of ours - was skipped by it on every restart, forever.
    registry.onSessionsObserved(() => {
      this.completedInitialSessionSweep = true;
      this.reconcileMergedTasks();
      this.reconcileTasksWithNoLiveSession();
    });

    // The other way a task ends: its work landed. See `settleMergedTask`.
    registry.onTaskPrMerged((e) => void this.settleMergedTask(e));
    // And the periodic backstop for the tasks that announcement cannot reach: whatever the
    // by-URL poller recorded this tick. No timer of its own - the poller's tick is it.
    registry.onPrMergesRecorded(() => this.reconcileMergedTasks());
  }

  /**
   * A task's pull request merged. Settle it if its episode appears finished, and end its
   * agent if the operator asked for that.
   *
   * A merge is not proof the task is over: an agent may be mid-turn or roll onto more
   * work, and no timer can rule out a prompt that has not arrived yet. An idle, empty,
   * still-current episode is enough to conclude provisionally; `reopenIfWorkResumed`
   * reverses that inference if the agent contradicts it by working again. A working
   * session is left alone, while a session that later disappears settles through
   * `agentWentAway`.
   *
   * The disposition of the agent remains a separate preference. With
   * `closeSessionAfterMerge` enabled, an idle merged session is closed only AFTER its
   * task has been recorded done, and only if it still matches that task and episode
   * after the asynchronous checkout-safety probe. Work resuming during that probe
   * reopens the inferred completion and cancels the close.
   *
   * Errors are swallowed to a log line: this runs inside the PR poller's reconciliation,
   * where a throw would abandon the rest of the sweep.
   */
  private async settleMergedTask(e: TaskPrMerged): Promise<void> {
    try {
      const t = this.registry.getTask(e.taskId);
      if (!t || (t.status !== "running" && t.status !== "dispatching")) return;
      const session = this.registry.getSession(e.sessionId);
      // The common ordering, and the one a `session_upsert` listener alone misses: the
      // agent finished its turn BEFORE the poller noticed the merge. Nothing further is
      // guaranteed to touch that session, so the same finished-episode question has to be
      // asked here too or the task stays running for ever. Both callers land on one
      // predicate rather than two that could drift.
      if (session) this.settleIfEpisodeFinished(session);
      if (!getShippingConfig().closeSessionAfterMerge) return;
      // This preference is "complete, then close", never Kill's "stop and let the task
      // settle as failed". `settleIfEpisodeFinished` is deliberately narrower than
      // "not working": awaiting input/review is still an unfinished turn. Requiring the
      // completion it just recorded keeps those states out of the terminal kill path.
      if (
        session?.state !== "idle" ||
        this.registry.getTask(e.taskId)?.status !== "done" ||
        this.autoCompleted.get(e.taskId) !== e.sessionId
      ) {
        return;
      }
      await this.closeMergedSession(e);
    } catch (error) {
      console.error("[merge] closing merged session failed:", e.taskId, error);
    }
  }

  /**
   * Land a merged task whose agent is still here but has finished the episode.
   *
   * The counterpart to `agentWentAway`, and the reason both exist: waiting for the agent
   * to go away is unimpeachable but it never arrives for the ordinary case, where an
   * agent ships its pull request and then sits idle forever. That session keeps a
   * `running` task, so `agentIsFree` refuses it and the backlog cannot reuse the agent -
   * which is the whole problem this change is about, left in place by the safe half of
   * the fix.
   *
   * So the episode is concluded on EVIDENCE that it finished, never on a clock:
   *
   *  - the agent is idle, so its turn is over rather than merely paused;
   *  - its work queue is empty, so nothing pending is about to continue this task;
   *  - the merged episode is still its CURRENT one, so it has not already rolled onto
   *    new work (this live-session gate does not apply after `agentWentAway`);
   *  - and a merge is durably recorded against that binding.
   *
   * An idle agent can still be wrong about being finished - it may be idle only because
   * nobody has typed yet. That is why this conclusion is REVERSIBLE: see
   * `reopenIfWorkResumed`. Every other route to `done` is a human's and stays put.
   */
  private settleIfEpisodeFinished(s: Session): void {
    if (s.state !== "idle") return;
    if (s.queue && s.queue.openCount > 0) return;
    const t = this.registry.listTasks().find(
      (task) => task.sessionId === s.id && (task.status === "running" || task.status === "dispatching"),
    );
    if (!t) return;
    const binding = taskWorkEpisodeForTask(t.id);
    if (!binding?.mergedAt || !binding.prUrl) return;
    // Rolled onto new work since the merge - not ours to conclude while the agent is still
    // HERE. This is deliberately narrower than `mergedPrFor`, and the asymmetry is the point:
    // a present agent that got a follow-up prompt may still be mid-turn, so an intermediate
    // merge is not yet its outcome; a DEPARTED agent (which is what `mergedPrFor`/`agentWentAway`
    // answer for) has no such turn left, so any merge it produced IS the outcome. So this
    // path keeps the episode-currency gate and reads only the current binding.
    const current = this.registry.workEpisodeForSession(s.id);
    if (current && current.episodeId !== binding.episodeId) return;
    const completed = this.complete(t.id, `merged ${binding.prUrl}`, binding.prUrl);
    // `complete` broadcasts synchronously and may evict this row from the bounded
    // in-memory task list before it returns. Do not recreate provenance after the
    // corresponding `task_remove` already cleared it.
    if (completed && this.registry.getTask(t.id) === completed) {
      this.autoCompleted.set(t.id, s.id);
    }
  }

  /**
   * Put back a task this class concluded, when its agent turns out to be working again.
   *
   * The honest answer to the one thing an idle agent cannot tell us. Concluding on
   * idleness is what makes a shipped agent reusable at all, but idleness is not proof
   * the work is over - the operator may simply not have typed yet. Landing an
   * intermediate pull request, reading the diff, and then saying "now do the follow-up"
   * is an ordinary sequence, and it produces a terminal task while its agent works on.
   *
   * Rather than guess for longer before concluding - every fixed window is outrunnable,
   * which is what the timer this replaced got wrong - the conclusion is simply undone
   * once the agent contradicts it. The evidence is unambiguous and it is the agent's
   * own: it is working again on the very task we called finished.
   *
   * Only tasks THIS class auto-completed are eligible, tracked in `autoCompleted`. An
   * outcome a human recorded is a statement about the work, not an inference from
   * idleness, and nothing here may overwrite one. The set is in memory on purpose: after
   * a restart nothing is reopened, which is the conservative direction - a task that
   * stays `done` is the state the whole feature exists to reach.
   */
  private reopenIfWorkResumed(s: Session): void {
    if (s.state !== "working") return;
    const t = this.registry.listTasks().find(
      (task) =>
        task.sessionId === s.id &&
        task.status === "done" &&
        this.autoCompleted.get(task.id) === s.id,
    );
    if (!t) return;
    this.autoCompleted.delete(t.id);
    this.registry.upsertTask({
      ...t,
      status: "running",
      outcome: null,
      outcomeUrl: null,
      completedAt: null,
      updatedAt: Date.now(),
    });
  }

  /**
   * The newest pull request any of this task's work episodes produced, if one was observed
   * merged - or null.
   *
   * The durable-record contract: a merge on ANY of this task's episodes completes it, and
   * the session's CURRENT episode is irrelevant here. Read from `task_work_episode_bindings`
   * AND `historical_task_work_episode_bindings`, both stamped by `markWorkEpisodeMerged` at
   * the moment the merge is seen. That is the durable acknowledgement the settle needs: it
   * survives a restart, it cannot be outrun by a prompt arriving later, and unlike a timer
   * it is a FACT rather than an inference.
   *
   * This reverses the earlier "current binding only" rule deliberately (adopted plan
   * decision). That rule read only the current binding so that a task whose episode rolled
   * over after its merge stayed `failed` - the reasoning being the agent was handed more
   * work and then vanished mid-flight. But the only caller is `agentWentAway`: the session
   * is GONE, so there is no "more work" in progress to strand, and a merged pull request IS
   * the outcome the task was dispatched for. Reporting it as `failed` behind a `stopped`
   * blocker strands every dependent for work that shipped. When several episodes merged
   * (a fix-forward task can open more than one PR), the NEWEST `mergedAt` is the outcome to
   * display.
   */
  private mergedPrFor(taskId: string): string | null {
    const current = taskWorkEpisodeForTask(taskId);
    const candidates = [
      ...(current ? [current] : []),
      ...historicalTaskWorkEpisodeBindingsForTask(taskId),
    ];
    let best: { mergedAt: number; prUrl: string } | null = null;
    for (const binding of candidates) {
      if (binding.mergedAt === null || !binding.prUrl) continue;
      if (best === null || binding.mergedAt > best.mergedAt) {
        best = { mergedAt: binding.mergedAt, prUrl: binding.prUrl };
      }
    }
    return best?.prUrl ?? null;
  }

  /**
   * Complete every task whose durable record shows a merged pull request, whatever became
   * of the session that produced it.
   *
   * The single owner of pull-request-driven completion, and the answer to the requirement
   * the two session-shaped paths could not reach between them: `settleIfEpisodeFinished`
   * needs an agent that is here and idle, `agentWentAway` needs the exact moment one is
   * evicted. A task whose agent was killed while the daemon was down, or whose merge only
   * happened days after everyone stopped looking, met neither - and sat behind a `stopped`
   * blocker holding up every dependent for work that had shipped.
   *
   * Three rules, each load-bearing:
   *
   *  - **A live agent is left to the narrower path.** While the session that owns a
   *    `running` task is still on the process table, the merge is not necessarily its
   *    outcome: an agent routinely lands an intermediate pull request and carries on, so
   *    only `settleIfEpisodeFinished`'s idle-and-still-on-that-episode evidence may
   *    conclude it, and that conclusion stays reversible. This path is what happens
   *    afterwards, when there is no turn left to interrupt.
   *  - **`failed` and `cancelled` are upgraded**, per `completableByMerge`. Those statuses
   *    record what was concluded before anyone could see the pull request merge, and a
   *    merge is evidence that outranks it. `complete` clears the error, records the pull
   *    request as the outcome, and keeps the worktree and terminal home for the operator's
   *    confirmed Clean up - freeing a checkout stays a human's click.
   *  - **The completion is NOT registered in `autoCompleted`.** `reopenIfWorkResumed`
   *    exists to reverse an inference drawn from idleness; this one is drawn from a merged
   *    pull request. An agent typing again must not resurrect a task whose work landed.
   *
   * `satisfyDependents` is on for the same reason `satisfyDeclaredEdgesTo` writes on the
   * edge: terminal rows are eventually pruned, so a completion recorded only in this task's
   * row stops being readable and every dependent silently re-blocks.
   *
   * Idempotent, and it must stay that way - it runs from four signals. A `done` task is
   * never revisited, and a merge already recorded costs one indexed read per task.
   */
  reconcileMergedTasks(): void {
    // Completing re-enters here: `complete` upserts, which resyncs the bound session, which
    // emits `session_upsert`, which this class listens to. The inner pass would re-scan the
    // same rows the outer loop is still walking, so it is refused and the outer pass simply
    // carries on to them.
    if (this.reconcilingMergedTasks) return;
    this.reconcilingMergedTasks = true;
    try {
      for (const { id } of this.registry.listTasks()) {
        // Re-read rather than trusting the snapshot: a completion mid-loop can settle
        // another row through that same re-entrancy, and can evict a terminal one entirely.
        const t = this.registry.getTask(id);
        if (!t || !completableByMerge(t.status)) continue;
        // A reschedule mid-teardown holds a cancelled/failed row it is about to re-file as
        // backlog. `complete` throws on that, and this runs inside event listeners and the
        // PR poller's reconciliation, where a throw abandons the rest of the sweep.
        if (this.reschedulingTasks.has(t.id)) continue;
        if (this.agentMayStillBeUndiscovered(t)) continue;
        if (this.agentIsStillHere(t)) continue;
        const merged = this.mergedPrFor(t.id);
        if (!merged) continue;
        this.complete(t.id, `merged ${merged}`, merged, true);
      }
    } finally {
      this.reconcilingMergedTasks = false;
    }
  }

  /**
   * Before the first completed discovery sweep, an absent session map entry means the
   * process table has not been authoritatively observed, not that the task's agent is gone.
   */
  private agentMayStillBeUndiscovered(t: Task): boolean {
    return (
      !this.completedInitialSessionSweep &&
      (t.status === "running" || t.status === "dispatching")
    );
  }

  /**
   * Is the agent that was executing this task still on the process table?
   *
   * Only asked of live statuses: a `failed` or `cancelled` task may still name the session
   * it ran on (`cancel` leaves `sessionId` alone), and that agent being alive says nothing
   * about a status something already concluded.
   */
  private agentIsStillHere(t: Task): boolean {
    return (
      (t.status === "running" || t.status === "dispatching") &&
      t.sessionId !== null &&
      this.registry.getSession(t.sessionId) !== undefined
    );
  }

  /**
   * Close the agent of a task that was completed after its merge, and reclaim its
   * checkout if that is safe.
   *
   * Two separate judgements. Closing is allowed only while the session is still idle,
   * its task is already done, and it still owns this merged episode. The checkout-safety
   * probe awaits filesystem work, so all four facts are re-read afterwards; a follow-up
   * prompt during the probe reopens an inferred completion and cancels the close instead
   * of terminating a working agent.
   *
   * Reclaiming is not. A merge proves the COMMITTED work landed; it says nothing about
   * uncommitted edits or untracked files still sitting in that checkout, and `reclaim`
   * runs `git worktree remove --force` over them. So the tree is freed only when the same
   * `resetWouldDestroyWork` probe the assign path consults says there is nothing to lose,
   * and otherwise kept - the row stays visible with Clean up on it, exactly as a killed
   * session's does. That is the house rule holding: freeing a tree is the operator's call
   * whenever anything could be lost by it.
   */
  private async closeMergedSession(e: TaskPrMerged): Promise<void> {
    const session = this.registry.getSession(e.sessionId);
    if (!session) return;
    // Probed BEFORE the kill: the answer is about the checkout, and asking first keeps
    // the reason readable in the log even when the kill races the process away.
    const holding = await this.closeMergedSessionDeps.resetWouldDestroyWork(session);
    const currentSession = this.registry.getSession(e.sessionId);
    const currentTask = this.registry.getTask(e.taskId);
    const currentEpisode = this.registry.workEpisodeForSession(e.sessionId);
    if (
      !currentSession ||
      currentSession.state !== "idle" ||
      (currentSession.queue?.openCount ?? 0) > 0 ||
      currentTask?.sessionId !== e.sessionId ||
      currentEpisode?.episodeId !== e.episodeId ||
      currentTask.status !== "done" ||
      this.autoCompleted.get(e.taskId) !== e.sessionId
    ) {
      return;
    }
    const killed = await this.closeMergedSessionDeps.kill(currentSession);
    if (!killed.ok) {
      throw new Error(killed.error ?? "could not close the merged task's session");
    }
    if (holding !== null) {
      console.log(
        `[merge] task ${e.taskId}: session closed, checkout kept - ${holding}. ` +
          "Clean up on the task row frees it.",
      );
      return;
    }
    await this.reclaim(e.taskId);
  }

  list(): Task[] {
    return this.registry.listTasks();
  }

  /**
   * Settle every task bound to a session that is gone for good.
   *
   * A `running` task used to be reconciled ONLY on a daemon restart, so until this existed
   * a killed session left a row claiming to be executing - and holding a worktree and a
   * terminal home that nothing would ever offer to reclaim. The Foreman already had to
   * defend against exactly that (`inFlightTasks` re-reads the session list because such a
   * row "is a row nothing will ever move"), which treated the symptom at one reader while
   * every other reader - the board, the report, `agentIsFree` - still believed the row.
   */
  private reconcileTasksBoundTo(sessionId: string): void {
    for (const t of this.registry.listTasks()) {
      if (t.sessionId === sessionId) this.agentWentAway(t);
    }
  }

  /** The same reconciliation for a restart: whatever the first completed sweep did not find. */
  private reconcileTasksWithNoLiveSession(): void {
    for (const t of this.registry.listTasks()) {
      if (t.sessionId && !this.registry.getSession(t.sessionId)) this.agentWentAway(t);
    }
  }

  /**
   * Mark one task's agent gone, KEEPING everything it holds.
   *
   * Deliberately not a teardown, and the asymmetry with `reconcileOnStartup` is the point:
   * that path reclaims because a row nobody can see leaks invisibly, while this one makes
   * the row visible the moment it happens - settled, resources intact, one confirmed Clean
   * up away from being freed. Tearing down here would run `git worktree remove --force`
   * seconds after a mis-aimed (k), which is the one thing `complete` already refuses to do
   * ("Mark done must not discard work"). Freeing a tree is the operator's call; saying the
   * agent is gone is ours.
   *
   * When no episode recorded a merge, `failed` is the least-wrong terminal state, and the
   * sentence is careful not to overclaim what it means. An agent that finished cleanly and
   * exited is indistinguishable here from one that crashed - the only thing observed is
   * that the session went away with no outcome recorded, so that is what it says. It is
   * also the status `reconcileOnStartup` already reaches for in the same situation, and
   * the one whose row carries the affordances this state wants: Retry when the tree is
   * gone, Clean up when it is not.
   */
  private agentWentAway(t: Task): void {
    this.autoCompleted.delete(t.id);
    if (t.status !== "running" && t.status !== "dispatching") return;
    // The agent is gone AND its work landed, which is the one combination that means the
    // task finished rather than merely stopped. This is the boundary a later prompt
    // cannot outrun: while an agent is still being given work it is still here, so
    // nothing reaches this line; once it is gone, no prompt is coming. `failed` below
    // says "ended with no outcome recorded", and a merged pull request IS the outcome -
    // reporting it as a failure would strand every task declared to wait on this one
    // behind a `stopped` blocker, for work that shipped.
    const merged = this.mergedPrFor(t.id);
    if (merged) {
      this.complete(t.id, `merged ${merged}`, merged);
      return;
    }
    const holdsResources = Boolean(t.worktreePath) || Boolean(t.homeName);
    const now = Date.now();
    this.registry.upsertTask({
      ...t,
      status: "failed",
      error: holdsResources
        ? "the agent's session ended with no outcome recorded - its worktree was kept; Clean up or re-dispatch it"
        : "the agent's session ended with no outcome recorded",
      // A synthetic id carries the pid and the process start time, so this one can never
      // name a running agent again.
      sessionId: null,
      updatedAt: now,
    });
  }

  get(id: string): Task | undefined {
    return this.registry.getTask(id);
  }

  /** Explicit blockers are enforced on every path that can start a task. */
  dependencyBlockers(task: Task): BacklogBlocker[] {
    return declaredBlockers(task, this.registry.listTasks());
  }

  private observedPrFor(session: Session, taskId?: string): string | null {
    const observation = this.registry.prObservationFor(session.id);
    const episode = this.registry.workEpisodeForSession(session.id);
    if (
      !observation ||
      !episode ||
      observation.url !== session.prUrl ||
      observation.branch !== session.gitBranch ||
      observation.agentSessionId !== session.agentSessionId ||
      observation.episodeId !== episode.episodeId ||
      (taskId !== undefined && !this.registry.taskOwnsWorkEpisode(taskId, session.id, observation.url))
    ) {
      return null;
    }
    return observation.url;
  }

  /**
   * Resolve untrusted ids to durable dependency edges and reject deadlocks.
   *
   * A selected session already carrying a task becomes a task edge. That is what lets
   * the dependency survive a process restart and follow the work through its PR merge.
   * Bare operator-started sessions remain session edges.
   */
  private resolveDependencies(
    inputs: TaskDependencyInput[],
    taskId: string,
    current: Task["dependencies"] = [],
  ): TaskDependency[] {
    const selectedAt = Date.now();
    const existing = new Map(
      current.map((dependency) => [
        dependency.type === "task" ? `task:${dependency.taskId}` : `session:${dependency.sessionId}`,
        dependency,
      ]),
    );
    const sessions = this.registry.snapshot().sessions;
    const resolved: TaskDependency[] = [];
    const seen = new Set<string>();

    for (const input of inputs) {
      let dependency: TaskDependency;
      if (input.type === "session") {
        const kept = existing.get(`session:${input.sessionId}`);
        if (kept?.type === "session") {
          dependency = kept;
          const key = `session:${dependency.sessionId}`;
          if (!seen.has(key)) resolved.push(dependency);
          seen.add(key);
          continue;
        }
        const session = sessions.find((candidate) => candidate.id === input.sessionId && candidate.state !== "exited");
        // Preserve an existing edge whose target disappeared so the operator can edit
        // other fields or remove dependencies without the daemon resurrecting/dropping it.
        if (!session) {
          throw new TaskDependencyError("dependency session is no longer active");
        }
        const episode = this.registry.workEpisodeForSession(session.id);
        if (!session.agentSessionId || !episode || episode.awaitingAgentRebind) {
          throw new TaskDependencyError("dependency session has no stable work identity yet");
        } else if (!session.hooksSeen) {
          throw new TaskDependencyError("dependency session has no observable work lifecycle");
        } else if (session.task && this.registry.getTask(session.task.id)) {
          const target = this.registry.getTask(session.task.id)!;
          const observedPr = this.observedPrFor(session, target.id);
          const previouslySatisfied =
            existing.get(`task:${target.id}`)?.satisfiedAt ??
            existing.get(`session:${session.id}`)?.satisfiedAt;
          const previousEdge =
            existing.get(`task:${target.id}`) ?? existing.get(`session:${session.id}`);
          dependency = {
            type: "task",
            taskId: target.id,
            title: target.title,
            sessionId: previousEdge?.sessionId ?? session.id,
            episodeId: previousEdge?.episodeId ?? episode?.episodeId ?? null,
            agentSessionId: previousEdge?.agentSessionId ?? episode?.agentSessionId ?? null,
            branch: previousEdge?.branch ?? episode?.branch ?? null,
            prUrl: previousEdge?.prUrl ?? observedPr,
            selectedAt: previousEdge ? previousEdge.selectedAt : selectedAt,
            satisfiedAt:
              observedPr && session.prState === "merged"
                ? Date.now()
                : previouslySatisfied ?? null,
          };
        } else {
          const observedPr = this.observedPrFor(session);
          dependency = {
            type: "session",
            sessionId: session.id,
            title: session.name,
            episodeId: episode.episodeId,
            agentSessionId: session.agentSessionId,
            branch: session.gitBranch,
            prUrl: observedPr,
            selectedAt,
            satisfiedAt: observedPr && session.prState === "merged" ? Date.now() : null,
          };
        }
      } else {
        const target = this.registry.getTask(input.taskId);
        if (!target) {
          const kept = existing.get(`task:${input.taskId}`);
          if (!kept) throw new TaskDependencyError("dependency task is no longer available");
          dependency = kept;
        } else {
          const activeSession = sessions.find(
            (session) => session.state !== "exited" && session.task?.id === target.id,
          );
          const previousEdge = existing.get(`task:${target.id}`);
          const binding = this.registry.workEpisodeForTask(target.id);
          const observedPr = activeSession ? this.observedPrFor(activeSession, target.id) : null;
          const eligible = target.status === "backlog" || Boolean(activeSession);
          if (!eligible && !existing.has(`task:${target.id}`)) {
            throw new TaskDependencyError("dependency task is neither backlogged nor active");
          }
          if (target.status !== "backlog" && activeSession && !activeSession.hooksSeen && !previousEdge) {
            throw new TaskDependencyError("dependency task has no observable work lifecycle");
          }
          dependency = {
            type: "task",
            taskId: target.id,
            title: target.title,
            sessionId: previousEdge?.sessionId ?? binding?.sessionId ?? null,
            episodeId: previousEdge?.episodeId ?? binding?.episodeId ?? null,
            agentSessionId: previousEdge?.agentSessionId ?? binding?.agentSessionId ?? null,
            branch: previousEdge?.branch ?? binding?.branch ?? null,
            prUrl: previousEdge?.prUrl ?? observedPr ?? binding?.prUrl ?? null,
            selectedAt: previousEdge ? previousEdge.selectedAt : selectedAt,
            satisfiedAt:
              observedPr && activeSession?.prState === "merged"
                ? Date.now()
                : existing.get(`task:${target.id}`)?.satisfiedAt ?? null,
          };
        }
      }

      const key = dependency.type === "task" ? `task:${dependency.taskId}` : `session:${dependency.sessionId}`;
      if (dependency.type === "task" && dependency.taskId === taskId) {
        throw new TaskDependencyError("a task cannot depend on itself");
      }
      if (!seen.has(key)) resolved.push(dependency);
      seen.add(key);
    }

    if (this.createsDependencyCycle(taskId, resolved)) {
      throw new TaskDependencyError("task dependencies cannot form a cycle");
    }
    return resolved;
  }

  private createsDependencyCycle(taskId: string, proposed: TaskDependency[]): boolean {
    const tasks = new Map(this.registry.listTasks().map((task) => [task.id, task]));
    const visiting = new Set<string>();
    const reachesTask = (id: string): boolean => {
      if (id === taskId) return true;
      if (visiting.has(id)) return false;
      visiting.add(id);
      const dependencies = id === taskId ? proposed : tasks.get(id)?.dependencies ?? [];
      for (const dependency of dependencies) {
        if (dependency.satisfiedAt !== null || dependency.type !== "task") continue;
        if (reachesTask(dependency.taskId)) return true;
      }
      return false;
    };
    return proposed.some(
      (dependency) =>
        dependency.satisfiedAt === null &&
        dependency.type === "task" &&
        reachesTask(dependency.taskId),
    );
  }

  /**
   * Create a task, and - when the operator left the title blank - name it with a model
   * before anything downstream reads that name.
   *
   * Stays synchronous so the POST returns a task immediately: the card must appear the
   * instant it is dispatched, not after a subprocess. It appears under the heuristic title,
   * which `autoTitleThenDispatch` replaces over SSE a beat later.
   *
   * `internal` is the durable producer's door - today the Recurring Missions scheduler and
   * the ensemble engine. It makes this call idempotent on a caller-chosen id, which is the
   * property both recovery paths are built on. See `InternalCreateOptions`. Omitting it is
   * every other caller, and their behaviour here is unchanged: fresh UUID, model titling
   * when the title is blank, dispatch when it is not.
   */
  create(input: CreateTaskInput, internal?: InternalCreateOptions): Task {
    const now = Date.now();
    const explicitTitle = input.title?.trim();
    const id = internal?.id ?? randomUUID();
    if (internal) {
      // Two producer-specific identity checks, with the same recovery rule. A scheduled id
      // must carry THIS occurrence's provenance; an ensemble id must still carry the exact
      // member Task inputs its attempt reserved. A match closes the crash window without
      // re-emitting, re-titling or re-dispatching. Anything else means the id belongs to a
      // different Task, so fail closed rather than adopt and rewrite a stranger's work.
      const existing = getDurableTask(id);
      if (existing) {
        if (internal.schedule) {
          const p = internal.schedule;
          if (
            existing.scheduleId !== p.scheduleId ||
            existing.scheduleOccurrenceId !== p.scheduleOccurrenceId ||
            existing.scheduledFor !== p.scheduledFor
          ) {
            throw new TaskIdCollisionError(
              `task ${id} already exists and was not filed by occurrence ${p.scheduleOccurrenceId}`,
            );
          }
        } else if (
          existing.repoRoot !== input.repoRoot ||
          existing.intent !== input.intent ||
          existing.title !== explicitTitle ||
          existing.kind !== input.kind ||
          existing.agent !== input.agent ||
          existing.model !== (input.model ?? null) ||
          existing.effort !== (input.effort ?? null) ||
          existing.scheduleId !== null
        ) {
          throw new TaskIdCollisionError(`task ${id} already exists with different ensemble input`);
        }
        return existing;
      }
      // Shared contract for every durable producer, asserted here rather than trusted at
      // each call site: first persist a named ordinary backlog Task. The scheduler stops
      // there; the ensemble engine separately dispatches through TaskManager only after the
      // complete wave exists. A blank title would also put model titling on a recovery path.
      if (!input.backlog) throw new Error(`internally created task ${id} must be backlog`);
      if (!explicitTitle) throw new Error(`internally created task ${id} must carry a title`);
    }
    const dependencies = this.resolveDependencies(input.dependencies ?? [], id);
    const mustBacklog = dependencies.some((dependency) => dependency.satisfiedAt === null);
    const task: Task = {
      id,
      title: explicitTitle || deriveTitle(input.intent),
      intent: input.intent,
      kind: input.kind,
      agent: input.agent,
      priority: input.priority ?? null,
      labels: input.labels ?? [],
      dependencies,
      // Always schedulable to begin with, on every path - the form, an MCP call, a task
      // source sweep. Parking is a decision taken about an item you can already see on
      // the board, so nothing gets to file work that is invisible to the autopilot
      // without anyone having said so.
      enabled: true,
      // Stored as an override, not a resolved value: unset means the dispatcher asks
      // the harness config at launch time, so shelving a task doesn't freeze the
      // defaults it happened to see (see `resolveDispatchModel` and
      // `resolveDispatchEffort`).
      model: input.model ?? null,
      effort: input.effort ?? null,
      source: input.source ?? null,
      repoRoot: input.repoRoot,
      worktreePath: null,
      branch: null,
      provider: null,
      homeName: null,
      terminalResourceId: null,
      sessionId: null,
      // Null for every human or external caller - the dispatch form, an MCP tool, a task
      // source sweep - none of which has an occurrence to point at. All three arrive
      // together or not at all, from the scheduler's internal producer above.
      scheduleId: internal?.schedule?.scheduleId ?? null,
      scheduleOccurrenceId: internal?.schedule?.scheduleOccurrenceId ?? null,
      scheduledFor: internal?.schedule?.scheduledFor ?? null,
      status: input.backlog || mustBacklog ? "backlog" : "dispatching",
      outcome: null,
      outcomeUrl: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      dispatchedAt: null,
      completedAt: null,
    };
    this.registry.upsertTask(task);
    if (explicitTitle) {
      if (task.status === "dispatching") void this.dispatcher.dispatch(task.id);
    } else {
      // Registered synchronously, before this returns, so no caller can observe the task
      // without also observing that its title is still in flight.
      const settled = this.autoTitleThenDispatch(task.id, input.intent, task.status === "backlog")
        .catch((err) => console.error("[title] titling failed:", err))
        .finally(() => this.titling.delete(task.id));
      this.titling.set(task.id, settled);
    }
    return task;
  }

  /**
   * Replace an auto-derived title with a model's, THEN dispatch.
   *
   * The ordering is the whole point, and it is why dispatch waits on a cosmetic call.
   * `Dispatcher.dispatch` reads `task.title` once, at the top, to build the git branch
   * (`slugify`) and the terminal session name (`sessionLabel`) - both of which are permanent for
   * the life of the task and neither of which can be renamed afterwards from the dashboard.
   * Dispatching first and patching the title after would leave every untitled task with a
   * card whose name no longer matches its branch or its terminal, which is worse than the
   * rough title this feature exists to replace. The wait is `TITLE_TIMEOUT_MS` per attempt,
   * and almost always exactly one attempt: a timeout or a missing `claude` makes
   * `runStructured` return on the first exception rather than retry, so the slow path costs
   * one budget (~15s) and the answered path costs however long Haiku takes (~7s measured).
   * Only a parse miss - a clean exit whose output won't validate - takes the second attempt
   * and so roughly twice the budget. All of it against a dispatch that spends far longer
   * cutting a worktree and waiting for the agent to boot.
   *
   * Never throws: `summariseTaskTitle` reports failure as null, and the title write is
   * guarded, so a failure of either simply leaves the heuristic title standing - the
   * dispatch below happens either way.
   */
  private async autoTitleThenDispatch(id: string, intent: string, backlog: boolean): Promise<void> {
    const title = await summariseTaskTitle(intent);
    // Re-read rather than closing over the created task: the operator can cancel or remove a
    // task while the model is thinking, and both of those are decisions this must not undo.
    const cur = this.registry.getTask(id);
    if (!cur) return;
    if (title && title !== cur.title) {
      try {
        this.registry.upsertTask({ ...cur, title, updatedAt: Date.now() });
      } catch (err) {
        // A failed write must not cost the dispatch. Throwing here would strand the task in
        // `dispatching` forever - no error on the card, and `remove` refuses that status -
        // over a cosmetic rename. The heuristic title stands and we fall through.
        console.error("[title] could not store the title:", err);
      }
    }
    if (backlog) return;
    // A task cancelled mid-title is withdrawn, not merely renamed - launching an agent for it
    // now would strand a worktree and a terminal home behind a card that says "cancelled".
    if ((this.registry.getTask(id) ?? cur).status !== "dispatching") return;
    void this.dispatcher.dispatch(id);
  }

  /**
   * Dispatch a backlog task, or retry a failed one - but only when the failure was
   * cleanly torn down (no lingering worktree). A failed task that still holds a
   * worktree means its agent may still be running; the user should Cancel it first
   * (which reclaims the tree) rather than dispatch a second agent onto it.
   *
   * Waits out any in-flight titling first: the branch and initial terminal home name are cut
   * from `task.title`, and later title edits do not propagate to them. Dispatching
   * mid-titling would name them after the heuristic title and leave the card disagreeing.
   */
  async dispatch(id: string, options: DispatchOptions = {}): Promise<DispatchOutcome> {
    await this.titling.get(id);
    // Read only AFTER the wait - the task may have been cancelled or removed during it.
    const t = this.registry.getTask(id);
    if (!t) return { ok: false, error: "no such task" };
    if (this.assigningTasks.has(id)) {
      return { ok: false, error: "task is being assigned", task: t };
    }
    if (t.status === "backlog" || (t.status === "failed" && !t.worktreePath)) {
      // Asked before dependencies, like the allowlist is in `decideBacklogTick`: it is
      // the coarser fact and the one the operator can act on immediately.
      if (refusedAsDisabled(t, options.overrideDisabled)) {
        return { ok: false, error: DISABLED_REFUSAL, task: t };
      }
      const blockers = this.dependencyBlockers(t);
      if (blockers.length > 0) {
        return {
          ok: false,
          error: `task is waiting on ${blockers.map((blocker) => blocker.title).join(", ")}`,
          task: t,
        };
      }
      // A task-specific model is an explicit operator choice and must always win. Foreman
      // supplies this only for a fresh backlog launch; persisting it before the async
      // dispatcher starts makes the task card's model match the command line it will use.
      if (t.status === "backlog" && t.model === null && options.defaultModel) {
        const selected = { ...t, model: options.defaultModel, updatedAt: Date.now() };
        this.registry.upsertTask(selected);
      }
      // Forwarded whole: `TaskDispatchOptions` describes the launch, and the Dispatcher is
      // the layer that acts on it. The one field this method consumed above is harmless to
      // pass along - the model a launch runs on is resolved from the stored task, never
      // from an options object.
      void this.dispatcher.dispatch(id, options);
    }
    return { ok: true, task: this.registry.getTask(id) ?? t };
  }

  /**
   * Edit a task - the dispatch modal reopened on a card, or the backlog column's
   * priority picker and enable/disable toggle.
   *
   * The status guard applies to the PROVISIONING fields only, and that split is the
   * whole rule. The moment a task dispatches, its title has supplied a git branch and an
   * initial terminal home name (see `autoTitleThenDispatch`), and its intent has already
   * been typed at an agent. A title edit after that point would change the card without
   * propagating to those resources, which is worse than a refusal. Every
   * other status is a conflict the caller shows, not retries.
   *
   * Dependencies share that guard because changing them can change whether launch is
   * allowed, and `enabled` shares it because it is the same kind of statement: it
   * decides whether the autopilot may start this item, and a task that already started
   * has no such question left to answer.
   * `priority` and `labels` are exempt because nothing is provisioned from them. They
   * are annotation, so re-marking a RUNNING task `blocker` is safe, and re-marking a
   * finished one keeps the record honest - the two things the guard above is protecting
   * simply are not at stake. Refusing them would make the board's priority picker dead
   * the instant its card was dispatched, for no reason anyone could name.
   *
   * Waits out any in-flight titling for the same reason `dispatch` does, inverted: the
   * model writes the whole row back when it lands, so an edit applied before it would be
   * silently reverted a beat later, in front of an operator who watched their text go in.
   */
  async update(id: string, patch: UpdateTask): Promise<Ok & { task?: Task }> {
    await this.titling.get(id);
    const t = this.registry.getTask(id);
    if (!t) return { ok: false, error: "no such task" };
    if (this.assigningTasks.has(id) && !isAnnotationOnlyUpdate(patch)) {
      return { ok: false, error: "task is being assigned" };
    }
    if (t.status !== "backlog" && !isAnnotationOnlyUpdate(patch)) {
      return { ok: false, error: `task is ${t.status}, not in the backlog` };
    }
    const intent = patch.intent?.trim() ?? t.intent;
    const title = patch.title?.trim();
    const agent = patch.agent ?? t.agent;
    const agentChanged = agent !== t.agent;
    const model = patch.model === undefined ? (agentChanged ? null : t.model) : patch.model;
    const effort = patch.effort === undefined ? (agentChanged ? null : t.effort) : patch.effort;
    if (effort !== null && !supportsEffort(agent, effort)) {
      return { ok: false, error: `reasoning effort ${effort} is not supported by ${agent}` };
    }
    let dependencies = t.dependencies;
    try {
      if (patch.dependencies !== undefined) {
        dependencies = this.resolveDependencies(patch.dependencies, t.id, t.dependencies);
      }
    } catch (error) {
      if (error instanceof TaskDependencyError) return { ok: false, error: error.message };
      throw error;
    }
    const next: Task = {
      ...t,
      repoRoot: patch.repoRoot ?? t.repoRoot,
      intent,
      // Emptying the title asks for one to be derived again - and from the intent as it
      // now reads, not the one the task was first shelved under. Derived here rather than
      // re-run through the model: an edit is a synchronous answer to a click, and the
      // titling wait it would cost buys a nicety on a name the operator is looking at and
      // can simply type.
      title: title === undefined ? t.title : title || deriveTitle(intent),
      kind: patch.kind ?? t.kind,
      agent,
      // Read by `in`, not by truthiness: `priority: null` is a caller deliberately
      // clearing the field back to unset, and `?? t.priority` would silently ignore them.
      priority: "priority" in patch ? (patch.priority ?? null) : t.priority,
      labels: patch.labels ?? t.labels,
      dependencies,
      // Guarded by the status check above, like the provisioning fields and unlike
      // priority/labels: it is a statement about scheduling, and there is nothing left
      // to schedule once the task has left the backlog.
      enabled: patch.enabled ?? t.enabled,
      // `undefined` leaves an override as it stands unless the agent changed; `null` is
      // the caller clearing it, which is a value the row can hold and cannot use `??`.
      model,
      effort,
      updatedAt: Date.now(),
    };
    this.registry.upsertTask(next);
    return { ok: true, task: next };
  }

  /**
   * Hand a backlog task to an agent that is ALREADY running, instead of cutting a
   * fresh worktree and launching one. This is what the board's drag-onto-an-idle-
   * agent gesture calls: the operator has an agent sitting free in the right repo
   * and would rather feed it than pay for another checkout.
   *
   * The critical difference from `dispatch`: an assigned task owns no worktree. The
   * agent keeps its own checkout - very often the operator's real one - so
   * `worktreePath` stays null, and that is precisely what keeps a later Cancel from
   * running `git worktree remove --force` over a directory we did not create.
   *
   * That reuse is what the reset below is for: the agent keeps the checkout, so unless
   * something puts it back to origin's default branch the new task inherits the last
   * one's branch and context. It also means an assign CLEARS the session's work queue,
   * because the reset does - those items were authored against a branch that no longer
   * exists.
   *
   * Which is why an assign that would take any of that ASKS FIRST. `resetWouldDestroyWork`
   * covers only what git holds; the queue, the context and the branch name are losses
   * origin cannot undo, and a drag gesture that spends them unannounced is the same
   * unconfirmed destruction the Reset button's dialog exists to prevent. An agent with
   * nothing to lose - empty queue, no branch - still takes a task in one gesture.
   *
   * Every refusal below is a state conflict the caller should surface, not retry, and
   * each says whose fault it is (`scope`) - see `AssignRefusalScope`.
   *
   * `inject` and `paneReady` are parameters for the same reason `inject` is one on
   * `injectPrompt` itself: they are the calls here that leave the process, and the
   * window they hold open is where this method's ordering rules can be broken.
   */
  async assign(id: string, sessionId: string, opts: AssignOptions = {}): Promise<AssignOutcome> {
    const t = this.registry.getTask(id);
    if (!t) return { ok: false, error: "no such task", scope: "task" };
    if (t.status !== "backlog") {
      return { ok: false, error: `task is ${t.status}, not in the backlog`, scope: "task" };
    }
    // The same refusal `dispatch` applies, and it has to be here too: assigning onto a
    // running agent is the autopilot's OTHER way of starting a parked task, and a guard
    // on one path only is the drift this whole feature is built to avoid.
    if (refusedAsDisabled(t, opts.overrideDisabled)) {
      return { ok: false, error: DISABLED_REFUSAL, scope: "task" };
    }
    const dependencyBlockers = this.dependencyBlockers(t);
    if (dependencyBlockers.length > 0) {
      return {
        ok: false,
        error: `task is waiting on ${dependencyBlockers.map((blocker) => blocker.title).join(", ")}`,
        scope: "task",
      };
    }

    const s = this.registry.getSession(sessionId);
    if (!s) return { ok: false, error: "no such session", scope: "session" };
    if (this.assigningTasks.has(id)) {
      return { ok: false, error: "task is already being assigned", scope: "task" };
    }
    if (this.assigningSessions.has(sessionId)) {
      return { ok: false, error: "that agent is already taking another task", scope: "session" };
    }
    this.assigningTasks.add(id);
    this.assigningSessions.add(sessionId);
    try {
      return await this.assignReserved(t, s, opts);
    } finally {
      this.assigningTasks.delete(id);
      this.assigningSessions.delete(sessionId);
    }
  }

  private async assignReserved(
    t: Task,
    s: Session,
    opts: AssignOptions,
  ): Promise<AssignOutcome> {
    const inject = opts.inject ?? injectPrompt;
    const paneReady = opts.paneReady ?? paneAcceptsPrompt;
    const reset = opts.reset ?? ((session: Session) => resetSession(this.registry, session, true));
    const doRename = opts.rename ?? rename;

    if (s.state !== "idle") {
      return {
        ok: false,
        error: `that agent is ${s.state.replace("_", " ")} - drop onto an idle one`,
        scope: "session",
      };
    }
    if (!s.instrumented) {
      return {
        ok: false,
        error: "that agent has no live hook instrumentation to confirm a safe handover",
        scope: "session",
      };
    }
    // Reports idle, but something is already parked on it waiting for the human. The
    // dashboard files such a session under "needs you" rather than "idle" and won't
    // offer it as a target; refuse it here too, so the API can't route around a rule
    // the operator can see being applied on screen.
    if (s.pendingReviews > 0) {
      return {
        ok: false,
        error: "that agent has a review waiting on you - clear it first",
        scope: "session",
      };
    }
    if (gateParked(s, this.registry.snapshot().sessions)) {
      return {
        ok: false,
        error: "that agent has a no-mistakes gate waiting on you - resolve it first",
        scope: "session",
      };
    }
    // Running a task's intent against the wrong checkout is the one way this gesture
    // does damage you cannot undo from the dashboard, so a mismatch is refused rather
    // than best-efforted. Compared on repoRoot, not cwd: a linked worktree of the
    // task's repo is a legitimate home for it, a different repo never is.
    if (!s.repoRoot || s.repoRoot !== t.repoRoot) {
      return {
        ok: false,
        error: `that agent is in a different repo (${s.repoRoot ?? "no repo"})`,
        scope: "session",
      };
    }
    const resourceOwner = this.registry.taskResourceOwnerForSession(s.id);
    if (resourceOwner) {
      return {
        ok: false,
        error: `that agent still holds resources for ${resourceOwner.title} - clean up that task before reusing it`,
        scope: "session",
      };
    }
    // Asked BEFORE the reset, and that ordering is the whole reason it is a separate
    // probe. Everything below strips the agent - detaches its checkout, drops its work
    // queue, wipes its context - for the sake of a prompt that is typed at the very end.
    // Finding out then that the pane has no handle, or that a human is sitting in
    // copy-mode reading their scrollback, leaves an agent taken apart for a task that
    // goes straight back to the backlog.
    const pane = await paneReady(s);
    if (!pane.ok) {
      return { ok: false, error: pane.error ?? "that agent's pane cannot take a prompt", scope: "session" };
    }

    // A reused agent starts the new task from origin's default branch with a cleared
    // context, not wherever the last one left it.
    //
    // The state this fixes is the ordinary one, not an edge case: an agent that just
    // shipped is standing on its own feature branch with that work committed. Typing
    // the next task in stacks unrelated commits on top of it, and no-mistakes, seeing a
    // non-default branch, validates and pushes onto it - so two tasks arrive in one PR.
    // `resetSession` is the same operation the Reset button performs (git reset --hard
    // onto origin/main, clean, detach the branch, /clear), so a recycled agent is handed
    // over in the shape a freshly dispatched one starts in.
    //
    // Guarded rather than unconditional, and the guard REFUSES rather than proceeding.
    // A reset is destructive and the autopilot's is unwatched: the button has a confirm
    // dialog with a loss preview in front of it. So a checkout holding work sends the
    // task back to the backlog with a sentence saying what is in the way, which the
    // operator can act on - the one outcome we cannot offer is silently discarding it.
    const holding = await resetWouldDestroyWork(s);
    if (holding) {
      return { ok: false, error: `that agent's checkout cannot be reset - ${holding}`, scope: "session" };
    }
    // Git is not the whole loss. The reset also drops the agent's work queue, wipes its
    // context and takes its branch away, and none of that is recoverable from origin -
    // so the human drag gesture is told what it is about to spend and asked once. The
    // breakdown travels WITH the refusal so the dialog and the action cannot disagree
    // about a queue that moved in between.
    if (!opts.confirmReset) {
      const confirm = await this.resetConfirmFor(s);
      if (needsResetConfirm(confirm)) {
        return {
          ok: false,
          error: `resetting that agent first would discard ${describeResetLoss(confirm)}`,
          scope: "session",
          resetConfirm: confirm,
        };
      }
    }
    // Re-read immediately before the destructive step. The idle check above is by now
    // several git invocations old, and the reset itself spends up to 30s in a fetch -
    // an agent a human woke up in that window must not be reset out from under them.
    const fresh = this.registry.getSession(s.id);
    if (
      !fresh ||
      !fresh.instrumented ||
      fresh.state !== "idle" ||
      fresh.pendingReviews > 0 ||
      gateParked(fresh, this.registry.snapshot().sessions)
    ) {
      return { ok: false, error: "that agent stopped being idle - try again", scope: "session" };
    }

    const done = await reset(s);
    if (!done.ok) {
      return { ok: false, error: `could not reset that agent's checkout - ${done.error}`, scope: "session" };
    }
    // `cleared` means the agent was SEEN acting on the `/clear`, not that tmux took the
    // keystrokes. Believing the weaker one is how a task gets claimed with nothing
    // running it: a `/clear` processed after the paste below wipes the prompt off the
    // composer, and the pane read that follows the paste finds nothing pending and calls
    // that success. Unconfirmed, the task stays in the backlog.
    if (!done.cleared) {
      return {
        ok: false,
        error: "could not confirm the agent cleared its context, so the task was not typed",
        scope: "session",
      };
    }
    if (done.workIdentityReady === false || (!opts.reset && !done.workIdentityReady)) {
      return {
        ok: false,
        error: "could not confirm the agent's new work identity, so the task was not typed",
        scope: "session",
      };
    }
    if (opts.reset) {
      this.registry.resetWorkEpisode(s.id);
    }
    if (this.registry.workEpisodeForSession(s.id)?.awaitingAgentRebind) {
      return {
        ok: false,
        error: "could not confirm the agent's new work identity, so the task was not typed",
        scope: "session",
      };
    }

    const ready = this.registry.getTask(t.id);
    if (!ready || ready.status !== "backlog") {
      return {
        ok: false,
        error: ready ? `task is ${ready.status}, not in the backlog` : "no such task",
        scope: "task",
      };
    }
    const blockers = this.dependencyBlockers(ready);
    if (blockers.length > 0) {
      return {
        ok: false,
        error: `task is waiting on ${blockers.map((blocker) => blocker.title).join(", ")}`,
        scope: "task",
      };
    }

    // Type the prompt BEFORE claiming the task: if the pane refuses (it is locked, or
    // the agent died between the drop and here) the task must stay in the backlog,
    // droppable again, rather than sit marked `running` with nothing running it.
    const r = await inject(
      this.registry.getSession(s.id) ?? s,
      ready.intent,
      undefined,
      () => this.registry.promptResourceBlockerForSession(s.id),
    );
    if (!r.ok) {
      return { ok: false, error: r.error ?? "could not type into the agent's pane", scope: "session" };
    }

    // Merge onto the LATEST snapshot, not the one read before the injection, for the
    // same reason `cancel` and `reclaim` do it: typing into a pane takes long enough
    // for a retriage to land, and priority/labels stay editable in every status - so a
    // stale spread here writes yesterday's priority back over one just set on the card,
    // silently, on a gesture that was only meant to hand the task to an agent.
    const cur = this.registry.getTask(t.id) ?? t;
    const now = Date.now();
    this.registry.upsertTask({
      ...cur,
      status: "running",
      sessionId: s.id,
      dispatchedAt: now,
      updatedAt: now,
    });
    this.registry.bindTaskToWorkEpisode(t.id, s.id);
    // The agent now IS this task, so its terminal has to say so - see `renameForTask`.
    // Last, and after the claim: it is the one step here that changes nothing about
    // whether the task is running, so it must not sit in front of anything that does.
    await this.renameForTask(
      // Re-read for the same reason the task is: the reset detached the checkout and the
      // injection took a round trip, and `rename` targets the terminal home BY NAME.
      this.registry.getSession(s.id) ?? s,
      this.registry.getTask(t.id) ?? cur,
      doRename,
    );
    return { ok: true };
  }

  /**
   * Name the agent's terminal after the task it just took, the way a fresh dispatch does.
   *
   * A dispatch cuts its session name from the task title, so a launched agent's card is
   * titled by its work from the first frame. An assign reuses a terminal that was
   * named for something else - the pooled worktree it was handed out as, or the task it
   * finished ten minutes ago - and everything else about the handover (branch back to
   * origin's default, work queue dropped, context cleared) already says this is a fresh
   * start. Leaving the name behind is how a board ends up with a card reading one task
   * while running another, which is worse than either name alone: the operator cannot tell
   * from the card which of the two is the lie.
   *
   * Best-effort, and deliberately AFTER the task is claimed. The task is typed and running
   * by the time this is reached; failing the assign over a cosmetic rename would send a
   * task that an agent is already working on back to the backlog, to be handed to a second
   * agent. So every refusal below is a silent no-op that leaves the old name standing.
   *
   * The fallback name exists for one reason: a rename onto a name a live terminal home
   * already holds fails, and `validateSessionNameAgainstTasks` refuses a name a task's
   * teardown still aims at (taking it would point that task's `killHome` at this agent).
   * Both are answered the same way `spawnUniquely` answers them - retry once under a name
   * the task id makes unique.
   */
  private async renameForTask(
    s: Session,
    t: Task,
    doRename: NonNullable<AssignOptions["rename"]>,
  ): Promise<void> {
    // This session's OWN backend spells the name, not the one a fresh dispatch would land
    // on: the two can differ (an operator's multiplexer session on a machine where a dispatch
    // would open a tab), and sanitizing for the wrong one strips characters this rename
    // could have kept - or keeps ones it cannot.
    const label = nameRulesFor(s).sanitize(t.title);
    if (s.name === label) return;
    for (const candidate of [label, `${label}-${t.id.slice(0, 6)}`]) {
      // `sanitize` already strips what this backend's names cannot hold, so this normally
      // only refuses a session with no terminal handle at all - one where there is nothing
      // to rename, whose card is named after its process.
      const valid = validateSessionName(s, candidate);
      if (!valid.ok) continue;
      if (!validateSessionNameAgainstTasks(s, valid.name, this.list()).ok) continue;
      const r = await doRename(s, valid.name).catch((err) => ({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }));
      if (r.ok) {
        this.registry.renameSession(s.id, valid.name);
        return;
      }
    }
  }

  /**
   * What the handover reset would take from this agent that git cannot give back.
   *
   * Read from the registry and the checkout at the moment of deciding, and returned
   * with the refusal, so the dialog the operator answers describes the same state the
   * assign will act on.
   */
  private async resetConfirmFor(s: Session): Promise<AssignResetConfirm> {
    return {
      queuedItems: s.queue?.openCount ?? 0,
      // A pane is what `/clear` needs, and `assign` has already refused a session
      // without one by the time this is asked.
      clearsContext: canWriteTo(s),
      branch: await branchReleasedByReset(s),
    };
  }

  /**
   * Stop a task's agent and reclaim its (ephemeral) worktree, marking it
   * cancelled. A dispatched agent's tree is throwaway - to preserve work you
   * Focus and commit/PR it before cancelling - so cancel always reclaims, which
   * keeps the teardown model simple and leak-free (no keep/remove ambiguity that
   * an in-flight dispatch could race).
   *
   * Cancel only kills agents we LAUNCHED. An assigned task (dropped onto an agent
   * that was already running) never had a terminal home of ours, and killing it would
   * take down the operator's own session - along with whatever else it was doing
   * before we handed it this task. For those, cancel means "stop tracking it", and
   * the human stops the agent themselves if they want it stopped.
   */
  async cancel(id: string): Promise<Ok> {
    const t = this.registry.getTask(id);
    if (!t) return { ok: false, error: "no such task" };
    this.autoCompleted.delete(id);

    if (t.sessionId && t.homeName) {
      const s = this.registry.getSession(t.sessionId);
      if (s) await kill(s);
    }
    // Re-read before tearing down so we don't miss resources a concurrent dispatch
    // created during the kill above. teardownWorktree also kills the terminal home.
    const teardownTarget = this.registry.getTask(id) ?? t;
    let teardownError: string | null = null;
    try {
      await teardownWorktree(teardownTarget);
    } catch (error) {
      teardownError = error instanceof Error ? error.message : String(error);
    }

    // Merge onto the LATEST snapshot, not a stale one, so we don't resurrect fields
    // the dispatcher patched during the awaits.
    const cur = this.registry.getTask(id) ?? t;
    const now = Date.now();
    this.registry.upsertTask({
      ...cur,
      status: "cancelled",
      worktreePath: teardownError === null ? null : cur.worktreePath,
      branch: teardownError === null ? null : cur.branch,
      provider: teardownError === null ? null : cur.provider,
      homeName: teardownError === null ? null : cur.homeName,
      terminalResourceId: teardownError === null ? null : cur.terminalResourceId,
      completedAt: now,
      updatedAt: now,
    });
    return teardownError === null
      ? { ok: true }
      : { ok: false, error: `task cancelled, but its resources remain tracked: ${teardownError}` };
  }

  /**
   * Record a task's outcome. Deliberately does NOT tear down the worktree/agent -
   * "Mark done" annotates a result, it must not silently discard unpushed work.
   * The tree is freed later by an explicit, confirmed `reclaim` (or `remove`).
   *
   * `satisfyDependents` additionally closes the operator-declared edges pointing HERE.
   * Off by default, and that default is load-bearing - see `CompleteTaskSchema` for why
   * a merge is ordinarily the only thing that satisfies a declared dependency, and what
   * this exists to rescue. Callers that pass nothing behave exactly as before.
   */
  complete(
    id: string,
    outcome: string,
    outcomeUrl?: string,
    satisfyDependents = false,
    requireStopped = false,
  ): Task | null {
    // Refuse EVERY completion while a reschedule holds this task, not only the stopped-only
    // dead-blocker path: a reschedule mid-teardown still has the row cancelled/failed, so an
    // ordinary Mark done would flip it to `done` and the reschedule would then tear its
    // worktree out from under that done row, leaving it pointing at reclaimed resources. The
    // reservation covers the whole teardown window. The internal auto-settle callers never
    // reach this throw: they only complete a running/dispatching task, and a reschedule only
    // ever holds a cancelled/failed one.
    if (this.reschedulingTasks.has(id)) {
      throw new TaskStatusConflictError("task is being rescheduled");
    }
    const t = this.registry.getTask(id);
    if (!t) return null;
    if (requireStopped && t.status !== "cancelled" && t.status !== "failed") {
      throw new TaskStatusConflictError(
        `task is ${t.status}, only a cancelled or failed task can be completed from a blocked dependent`,
      );
    }
    this.autoCompleted.delete(id);
    const now = Date.now();
    const updated: Task = {
      ...t,
      status: "done",
      outcome,
      outcomeUrl: outcomeUrl ?? null,
      error: null,
      completedAt: now,
      updatedAt: now,
    };
    this.registry.upsertTask(updated);
    if (satisfyDependents) this.satisfyDeclaredEdgesTo(id, now);
    return updated;
  }

  /**
   * Stamp `satisfiedAt` on every unsatisfied declared edge aimed at `taskId`.
   *
   * Written on the EDGE rather than inferred from the target's status, which is the
   * same reason `TaskDependency.satisfiedAt` is persisted at all: terminal task rows are
   * eventually pruned, so a completion that lives only in the target's row stops being
   * readable once that row is gone, and every dependent silently re-blocks. One
   * timestamp per edge survives that.
   *
   * Task edges only. `resolveDependencies` normalizes a session reference to a task
   * reference whenever that session carries a task row, so a surviving `session` edge is
   * by construction operator-started work with no task to complete - nothing this call
   * could be about.
   */
  private satisfyDeclaredEdgesTo(taskId: string, at: number): void {
    for (const task of this.registry.listTasks()) {
      let changed = false;
      const dependencies = task.dependencies.map((dependency) => {
        if (
          dependency.type !== "task" ||
          dependency.taskId !== taskId ||
          dependency.satisfiedAt !== null
        ) {
          return dependency;
        }
        changed = true;
        return { ...dependency, satisfiedAt: at };
      });
      if (changed) {
        this.registry.upsertTask({ ...task, dependencies, updatedAt: Math.max(task.updatedAt, at) });
      }
    }
  }

  /**
   * Put a stopped task back into the backlog so it can be run again. The escape hatch
   * for a prerequisite that was cancelled or failed while the work it stood for still
   * needs doing: its dependents stay blocked (a `stopped` dependency never satisfies)
   * until it is either marked done or actually run, and this is the "run it" half - the
   * companion to `complete(..., satisfyDependents)`, which is the "it already landed" half.
   *
   * Only `cancelled` and `failed` tasks are eligible: a `done` task's result is already
   * recorded and a live one is on its way, so neither is a thing to re-file. Any leftover
   * worktree/agent is reclaimed first - the same teardown `reclaim` performs, behind the
   * same human click - because a fresh backlog dispatch provisions its own, and keeping
   * the old one would leak it. The row is reset to the shape `create` leaves a backlog
   * task in, so nothing stale (an old outcome, a dead branch) survives into the relaunch,
   * and re-enabled so the autopilot it was filed for can actually pick it up again.
   *
   * Schedule provenance (`scheduleId` / `scheduleOccurrenceId` / `scheduledFor`) is left
   * untouched: it records which occurrence FILED this task, a fact rescheduling does not
   * change. Its declared dependencies are kept too - re-running it means re-running it
   * under the same prerequisites, which the backlog re-evaluates on the next plan.
   */
  async reschedule(id: string): Promise<Ok> {
    if (this.reschedulingTasks.has(id)) {
      return { ok: false, error: "task is being rescheduled" };
    }
    const t = this.registry.getTask(id);
    if (!t) return { ok: false, error: "no such task" };
    if (t.status !== "cancelled" && t.status !== "failed") {
      return {
        ok: false,
        error: `task is ${t.status}, only a cancelled or failed task can be rescheduled`,
      };
    }
    this.reschedulingTasks.add(id);
    try {
      this.autoCompleted.delete(id);
      if (t.worktreePath || t.homeName) {
        try {
          await teardownWorktree(this.registry.getTask(id) ?? t);
        } catch (error) {
          return {
            ok: false,
            error: `could not reclaim task resources: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }
      const cur = this.registry.getTask(id);
      if (!cur) return { ok: false, error: "no such task" };
      if (cur.status !== "cancelled" && cur.status !== "failed") {
        return {
          ok: false,
          error: `task is ${cur.status}, only a cancelled or failed task can be rescheduled`,
        };
      }
      this.registry.upsertTask({
        ...cur,
        status: "backlog",
        enabled: true,
        worktreePath: null,
        branch: null,
        provider: null,
        homeName: null,
        terminalResourceId: null,
        sessionId: null,
        outcome: null,
        outcomeUrl: null,
        error: null,
        dispatchedAt: null,
        completedAt: null,
        updatedAt: Date.now(),
      });
      return { ok: true };
    } finally {
      this.reschedulingTasks.delete(id);
    }
  }

  /**
   * Free a terminal task's leftover worktree + agent (the explicit, confirmed
   * "reclaim" action) while KEEPING its status and outcome - unlike cancel, which
   * aborts an active task.
   */
  async reclaim(id: string): Promise<Ok> {
    const t = this.registry.getTask(id);
    if (!t) return { ok: false, error: "no such task" };
    this.autoCompleted.delete(id);
    try {
      await teardownWorktree(this.registry.getTask(id) ?? t);
    } catch (error) {
      return {
        ok: false,
        error: `could not reclaim task resources: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const cur = this.registry.getTask(id) ?? t;
    this.registry.upsertTask({
      ...cur,
      worktreePath: null,
      branch: null,
      provider: null,
      homeName: null,
      terminalResourceId: null,
      sessionId: null,
      updatedAt: Date.now(),
    });
    return { ok: true };
  }

  async remove(id: string): Promise<Ok> {
    const t = this.registry.getTask(id);
    if (!t) return { ok: false, error: "no such task" };
    if (t.status === "running" || t.status === "dispatching") {
      return { ok: false, error: "cancel the task before removing it" };
    }
    this.autoCompleted.delete(id);
    // A terminal task may still hold a tree (e.g. a failed-but-alive dispatch);
    // reclaim it so removing the record never leaks a worktree/lease.
    if (t.worktreePath || t.homeName) {
      try {
        await teardownWorktree(t);
      } catch (error) {
        return {
          ok: false,
          error: `could not reclaim task resources: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    this.registry.removeTask(id);
    return { ok: true };
  }

  /**
   * Reconcile a resource-holding task after a restart. If its agent's terminal home
   * survived, keep it (a `running`/`failed` task re-binds to its rediscovered
   * session; a `dispatching` one can't confirm its prompt landed, so it fails
   * honestly but keeps the live agent to Focus/Cancel). If the home is gone, the
   * agent died with the daemon - reclaim its worktree so nothing leaks invisibly.
   *
   * `homeAlive` has three answers and only ONE of them may reclaim. `null` - no installed
   * backend could hold a named home, so the recorded name proves nothing either way - is
   * grouped with "survived", because this is the most destructive branch in the product:
   * the reclaim path runs `git worktree remove --force` and hands a pooled lease back. A
   * wrong "gone" deletes work an agent is still doing; a wrong "survived" leaves a tree the
   * operator frees with one Reclaim.
   *
   * A MISSING home name defaults to `null` here, not `false`, and that is a deliberate
   * departure from the live dispatch path. On the first start after the `tmux_session` ->
   * `home_name` migration, a name that failed to carry across would read as absent - and an
   * absent name reclaiming by omission (`? probe : false`) is exactly how a rename destroys
   * a live agent's worktree. This is a restart, where an absent name cannot be told apart
   * from an unmigrated one, so it fails safe: keep the tree, surface the task. (The
   * dispatcher's own catch keeps `: false` - there the absence is this process's own
   * knowledge that no home was ever spawned, not a value that might have been lost.)
   */
  private async reconcileOnStartup(t: Task): Promise<void> {
    const alive = t.homeName ? await homeAlive(t.homeName) : null;
    if (alive !== false) {
      if (t.status === "dispatching") {
        this.registry.upsertTask({
          ...t,
          status: "failed",
          error: "dispatch interrupted by a restart - Focus or Cancel it",
          updatedAt: Date.now(),
        });
      }
      return; // resource-holding tasks stay loaded; live sessions re-bind by cwd
    }
    // The agent is gone - reclaim its worktree. Terminal tasks keep their status and outcome.
    try {
      await teardownWorktree(t);
    } catch (error) {
      const now = Date.now();
      this.registry.upsertTask({
        ...t,
        status: t.status === "done" || t.status === "cancelled" ? t.status : "failed",
        error:
          t.status === "done" || t.status === "cancelled"
            ? t.error
            : `could not reclaim task resources: ${error instanceof Error ? error.message : String(error)}`,
        sessionId: null,
        updatedAt: now,
      });
      return;
    }
    this.registry.upsertTask({
      ...t,
      status: t.status === "done" || t.status === "cancelled" ? t.status : "failed",
      error:
        t.status === "done" || t.status === "cancelled"
          ? t.error
          : t.status === "dispatching"
            ? "dispatch interrupted by a restart - re-dispatch"
            : "the agent's session did not survive a restart",
      worktreePath: null,
      branch: null,
      provider: null,
      homeName: null,
      terminalResourceId: null,
      sessionId: null,
      updatedAt: Date.now(),
    });
  }
}
