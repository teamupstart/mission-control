import type { BacklogPlan, Session, Task } from "@shared/types.ts";
import { backlogTasks, reportBucket } from "@shared/session.ts";
import { blockersFor, planStale, readyBacklog } from "@shared/backlog.ts";
import { cwdAllowlisted, foremanAllowlisted } from "@shared/foreman.ts";
import { hasPane, settledIdle } from "./queue-machine.ts";

// The backlog autopilot's decision core: given the fleet, the backlog and the stored
// plan, what should Foreman do THIS tick? Zero I/O, `now` always injected - mirroring
// queue-machine.ts's discipline, so the whole policy is unit-testable as a table and
// the worker holds none of it.
//
// The unit of a tick is ONE action, deliberately. Two dispatches decided from one
// snapshot would both be judged against the same capacity count, which is the exact
// shape of an over-launch; making the loop re-read between them means the ceiling is
// re-checked against the world every time it is applied.

/** Consecutive planning failures tolerated before the machine schedules serially instead. */
export const PLAN_FAILURE_CAP = 3;

/** The knobs the machine reads. Policy from ForemanConfig; timings from the worker's constants. */
export interface BacklogConfig {
  /** The `autoBacklog` master switch. */
  enabled: boolean;
  /** The agent ceiling (`maxSessions`). */
  maxSessions: number;
  /** Repo roots Foreman may act in - the same list `foremanAllowlisted` reads. */
  allowlist: readonly string[];
  /**
   * Whether Foreman's MODE clears it to act at all (live). False in dry-run and
   * semi-auto, where the machine still plans but never launches or types.
   */
  mayActLive: boolean;
  /** How long a session must sit idle before it counts as free. Shared with the queue. */
  settleMs: number;
  /**
   * True once planning has failed `PLAN_FAILURE_CAP` times in a row. The machine stops
   * asking and schedules SERIALLY instead - see `decideBacklogTick` step 3.
   */
  planExhausted: boolean;
}

/** What the worker should do for the backlog this tick. Exactly one thing, or nothing. */
export type BacklogAction =
  /** Nothing to do; `why` is the one-line reason, for the log and the operator. */
  | { kind: "none"; why: string }
  /** The plan no longer covers the backlog - read these tasks and store a new one. */
  | { kind: "plan"; tasks: Task[] }
  /** Hand `task` to an agent that is already running and free. */
  | { kind: "assign"; task: Task; session: Session; why: string }
  /** Launch a fresh agent in its own worktree for `task`. */
  | { kind: "dispatch"; task: Task; why: string };

export interface BacklogTickInput {
  /** Every task the daemon knows about - not just the backlog; dependencies point outside it. */
  tasks: Task[];
  /** Every session in the snapshot, including exited ones (they are filtered here). */
  sessions: Session[];
  plan: BacklogPlan | null;
  cfg: BacklogConfig;
  now: number;
}

/**
 * How many agents are running right now, for the `maxSessions` ceiling.
 *
 * Two terms, and the second is the one that matters. A task that has been dispatched
 * but whose agent has not been DISCOVERED yet is an agent - the worktree is being cut,
 * the process is coming up - and counting only the session list leaves a window of
 * several seconds in which every tick sees spare capacity and launches into it. That
 * is not a theoretical race: discovery polls, and provisioning a worktree takes longer
 * than one Foreman pass.
 *
 * A `dispatching` task whose session IS already in the list is not counted twice; one
 * whose `sessionId` points at a session that has since been evicted still counts,
 * because we cannot prove its process is gone.
 *
 * Live sessions are counted WHOLE - hand-started terminals included. See `maxSessions`.
 */
export function activeAgentCount(sessions: Session[], tasks: Task[]): number {
  const live = sessions.filter((s) => s.state !== "exited");
  const liveIds = new Set(live.map((s) => s.id));
  const provisioning = tasks.filter(
    (t) => t.status === "dispatching" && (!t.sessionId || !liveIds.has(t.sessionId)),
  );
  return live.length + provisioning.length;
}

/**
 * Whether this session is genuinely free to be handed a whole task.
 *
 * A much stricter bar than "looks idle", because the consequence is different in kind:
 * the board's drag gesture is a human saying "yes, that one", while this is a
 * background loop typing a task into a pane nobody asked. Every clause below is a way
 * a session can read idle while being anything but.
 *
 *  - `reportBucket === "idle"`: the shared bucketing, which already excludes a session
 *    with a review waiting, a menu on screen, or a parked gate. The board's Idle column
 *    is the same predicate, so "an idle agent got given work" matches what you saw.
 *  - `settledIdle`: idle for the settle window, so a pause between turns of a multi-turn
 *    flow is not mistaken for being finished.
 *  - `hooksSeen`: we have to be able to OBSERVE this session. `reportBucket` files an
 *    uninstrumented session under idle by default ("open, not confirmed busy"), which is
 *    the right default for a readout and the wrong one for an autopilot - it would hand
 *    a task to an agent that may be mid-thought and would then be unable to tell.
 *  - a pane: there is nowhere to type otherwise.
 *  - an empty work queue: Foreman is already feeding this session, one item at a time.
 *  - no non-terminal task bound to it: it is already executing something of ours.
 *  - allowlisted: typing here is a live send, gated exactly like every other one.
 *
 * `TaskManager.assign` re-checks what it can server-side, because a session can go busy
 * between this decision and the POST that acts on it.
 */
export function agentIsFree(
  s: Session,
  sessions: Session[],
  tasks: Task[],
  cfg: BacklogConfig,
  now: number,
): boolean {
  if (reportBucket(s, sessions) !== "idle") return false;
  if (!settledIdle(s, now, cfg.settleMs)) return false;
  if (!s.hooksSeen) return false;
  if (!hasPane(s)) return false;
  if (s.queue && s.queue.openCount > 0) return false;
  if (!foremanAllowlisted(s.cwd, s.repoRoot, cfg.allowlist)) return false;
  return !tasks.some(
    (t) => t.sessionId === s.id && (t.status === "running" || t.status === "dispatching"),
  );
}

/** The free agent that could take this task, or null. Same repo, judged on `repoRoot`. */
function freeAgentFor(
  task: Task,
  sessions: Session[],
  tasks: Task[],
  cfg: BacklogConfig,
  now: number,
): Session | null {
  for (const s of sessions) {
    // Compared on repoRoot, not cwd - a linked worktree of the task's repo is a
    // legitimate home for it, a different repo never is. The same comparison
    // `TaskManager.assign` refuses on.
    if (s.repoRoot !== task.repoRoot) continue;
    if (agentIsFree(s, sessions, tasks, cfg, now)) return s;
  }
  return null;
}

/**
 * Decide the backlog's one action for this tick.
 *
 * Precedence, and every step is a refusal the operator can be told about:
 *
 *  1. autopilot off.
 *  2. nothing in the backlog.
 *  3. the plan does not cover the backlog -> replan first, scheduling NOTHING this
 *     tick. Acting on a plan that has never seen the newest item is how two tasks that
 *     conflict get started together. Once planning has failed its cap the machine stops
 *     asking and drops to SERIAL mode instead: one autopilot-launched task at a time,
 *     oldest first. Serial execution satisfies every possible dependency order by
 *     construction, so a broken planner degrades to slow rather than to wrong.
 *  4. an allowlisted, ready item with a free agent in its repo -> assign. Checked
 *     BEFORE capacity because it consumes no new session, so it is correct at the
 *     ceiling and cheaper below it.
 *  5. the first allowlisted ready item, if the fleet is under `maxSessions` -> dispatch.
 *  6. otherwise nothing, saying which of those it was.
 *
 * The mode gate sits at the END rather than the top, so a dry run reports the decision
 * it would have taken instead of a flat "off". That is the whole value of dry-run here:
 * the ordering and the dependency read are what you want to check before you trust it
 * to launch anything.
 */
export function decideBacklogTick(input: BacklogTickInput): BacklogAction {
  const { tasks, sessions, plan, cfg, now } = input;

  if (!cfg.enabled) return { kind: "none", why: "" };

  const backlog = backlogTasks(tasks);
  if (backlog.length === 0) return { kind: "none", why: "the backlog is empty" };

  // Step 3. `planExhausted` is the only thing that lets a stale plan through, and what
  // it buys is not "schedule from a stale plan" - `readyBacklog` with a stale plan
  // simply treats the unplanned items as unblocked - but the serial cap below, which is
  // what makes that safe.
  const stale = planStale(tasks, plan);
  if (stale && !cfg.planExhausted) return { kind: "plan", tasks: backlog };
  const serial = stale;

  // Only items we are cleared to act on at all. `cwdAllowlisted` and not
  // `foremanAllowlisted`, because a backlog task has no cwd yet - it has only the repo
  // it will be cut FROM, which is the exact thing the allowlist names. (The worktree it
  // eventually runs in is covered by the other half of `foremanAllowlisted` once it is a
  // live session.)
  const allowed = backlog.filter((t) => cwdAllowlisted(t.repoRoot, cfg.allowlist));

  // The allowlist is answered BEFORE dependencies, and the order is the whole point: it
  // is the coarser fact, and it is the only one of the two the operator can act on
  // immediately. Asking "is anything blocked?" first blames a dependency graph that may
  // be perfectly fine - measured, not assumed: with an empty allowlist and one genuinely
  // blocked item out of three, the reversed order reported "every schedulable backlog
  // item is waiting on another task" while the real answer was that Foreman was trusted
  // nowhere.
  if (allowed.length === 0) {
    return { kind: "none", why: "no backlog item is in a repo Foreman is trusted to act in" };
  }

  const ready = readyBacklog(tasks, plan).filter((t) => cwdAllowlisted(t.repoRoot, cfg.allowlist));
  if (ready.length === 0) {
    // Counted over the ALLOWED items, so the number matches the sentence: an item in an
    // untrusted repo is not "blocked", it is out of scope, and including it would have
    // the count disagree with the board's blocked chips.
    const blocked = allowed.filter((t) => blockersFor(t, plan, tasks).length > 0).length;
    return {
      kind: "none",
      why: `every schedulable backlog item is waiting on another task (${blocked} blocked)`,
    };
  }

  // Step 4: prefer a free agent anywhere in the ready set, not just for the head. The
  // backlog is a set of items whose ordering constraints are already stated explicitly
  // as dependencies - unlike the work queue, where the human's sequence IS the meaning
  // - so taking a later item that has a home costs the head nothing and saves a
  // worktree. The head is still what gets launched when nothing can be assigned.
  for (const task of ready) {
    const session = freeAgentFor(task, sessions, tasks, cfg, now);
    if (!session) continue;
    if (!cfg.mayActLive) {
      return {
        kind: "none",
        why: `would hand "${task.title}" to ${session.name} (Foreman is not in live mode)`,
      };
    }
    return {
      kind: "assign",
      task,
      session,
      why: `${session.name} is free and in the right repo`,
    };
  }

  const head = ready[0]!;

  // Serial mode's cap: with no dependency read to trust, at most one task launched by
  // autopilot may be in flight at a time. Counted over the tasks WE started (they hold a
  // tmux session of ours), not over the fleet, so a human's own agents neither block
  // this nor are blocked by it.
  if (serial) {
    const ours = tasks.filter(
      (t) => (t.status === "running" || t.status === "dispatching") && t.tmuxSession !== null,
    ).length;
    if (ours > 0) {
      return {
        kind: "none",
        why: "scheduling one at a time - Foreman could not read the backlog's dependencies",
      };
    }
  }

  const active = activeAgentCount(sessions, tasks);
  if (active >= cfg.maxSessions) {
    return {
      kind: "none",
      why: `at the agent ceiling (${active}/${cfg.maxSessions}) - waiting for one to finish`,
    };
  }

  if (!cfg.mayActLive) {
    return {
      kind: "none",
      why: `would launch an agent for "${head.title}" (Foreman is not in live mode)`,
    };
  }

  return {
    kind: "dispatch",
    task: head,
    why: `${active}/${cfg.maxSessions} agents running`,
  };
}
