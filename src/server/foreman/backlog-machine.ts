import type { AssignRefusalScope, BacklogPlan, Session, Task } from "@shared/types.ts";
import { backlogTasks, reportBucket } from "@shared/session.ts";
import { backlogIndex, blockersIn, plannableBacklog, planStale, readyBacklog } from "@shared/backlog.ts";
import { cwdAllowlisted, foremanAllowlisted } from "@shared/foreman.ts";
import { hasPane } from "./queue-machine.ts";
import { settledIdle } from "@shared/session.ts";

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
   * Whether an idle agent still holding an OPEN PR is off-limits (`backlogRespectOpenPrs`).
   * See `agentIsFree`.
   */
  respectOpenPrs: boolean;
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
  /**
   * Tasks the caller has already acted on and has not seen land yet.
   *
   * An INPUT rather than a check the worker makes on the answer, because those two
   * differ in a way that matters: filtering the candidates lets the machine pick the
   * next item it can act on, while re-judging a decided action parks the whole
   * autopilot behind one task for as long as the caller's memory lasts. The set is
   * still the caller's to keep - it is a fact about one process's history, not about
   * the world - so the machine stays pure and total.
   */
  recentlyActed?: ReadonlySet<string>;
  /**
   * Sessions the caller has recently tried and been REFUSED by, which it should stop
   * offering as assign targets for a while.
   *
   * The same shape and the same justification as `recentlyActed`, one level over: a fact
   * about one process's history, not about the world, so it stays the caller's to keep.
   * What it prevents is specific and was reachable before this existed. A refused assign
   * makes the tick return without acting, and the refusals that matter are STICKY - a
   * checkout holding uncommitted work, a wedged pane - so the machine would pick the same
   * session and the same task every 4s and never fall through to the dispatch that would
   * have made progress. One bad session parked the whole backlog. Excluding the session
   * lets the very next tick try another agent, or cut a fresh worktree.
   */
  unassignable?: ReadonlySet<string>;
}

/**
 * Tasks that are executing right now, however they got there, for serial mode.
 *
 * Deliberately wider than "the ones autopilot launched": a task assigned to a session
 * and a task holding a terminal home of ours are indistinguishable on the row today,
 * and `dispatching` covers the window between the dispatch POST answering and the home
 * spawn - the exact window a sub-second next tick would otherwise launch into. Serial
 * mode exists because we could NOT read the dependencies, so pausing behind a human's
 * in-flight task too is the conservative reading, and the cheap one: it costs some
 * parallelism in a state that is already degraded.
 *
 * But "executing" has to mean something we can still SEE, which is why the sessions are
 * read here. A task bound to a session that is gone is not executing anything. Counting one
 * turned serial mode from a degradation into a dead end: an agent whose terminal was
 * closed left a `running` row behind, that row held the count above zero for as long as
 * the daemon lived, and the fallback that exists so a broken planner "degrades to slow
 * rather than to wrong" instead scheduled nothing at all, forever. Observed exactly that
 * way - a backlog of two dozen ready items parked behind one dead row.
 *
 * `TaskManager.agentWentAway` now settles such a row when its session is evicted, which is
 * the cause rather than this symptom - but this clause stays, and not merely as belt and
 * braces. Eviction is deliberately eight seconds behind the process dying, and this fold
 * runs on every tick inside that window; a scheduler in serial mode is exactly the reader
 * that must not stall behind a row it can already see has no agent.
 *
 * A task with no session yet still counts: `dispatching`, or `running` with a terminal
 * home we cut, is the discovery window, and that is the one this must not launch into.
 */
function inFlightTasks(tasks: Task[], sessions: Session[]): number {
  const live = new Set(sessions.filter((s) => s.state !== "exited").map((s) => s.id));
  return tasks.filter((t) => {
    if (t.status === "dispatching") return true;
    if (t.status !== "running") return false;
    // Bound to an agent: in flight only while that agent is still one of ours.
    if (t.sessionId !== null) return live.has(t.sessionId);
    // Not bound yet, but we cut it a session - the window before discovery finds it.
    return t.homeName !== null;
  }).length;
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
 *  - `hooksSeen`: we have to be able to OBSERVE this session after delivery. Passive
 *    lifecycle evidence may place a Codex session in the board's Idle column, but it
 *    cannot prove that a later prompt was accepted or completed. That is enough for a
 *    readout and not enough for an autopilot handing the session new work.
 *  - a `"sdk"` or `"dispatch"` invite - a STRICTER bar than the rest of Foreman applies,
 *    and the one clause here that is about CONSENT rather than readiness. Everywhere else
 *    a non-null `foremanInvite` is enough, because everything else Foreman does is help
 *    with the work the session is already doing: triage its question, wrap up its prompt,
 *    relay its PR feedback. Assignment is different in kind - it hands the session a whole
 *    new task nobody in that conversation asked for - so an `"operator"` invite
 *    deliberately does not grant it (approved decision 2). Inviting Foreman to help with
 *    what you are doing must never read as consent for the autopilot to start something
 *    else in your pane. `"sdk"` and `"dispatch"` sessions exist BECAUSE Mission Control
 *    wanted work done in them, so for those the two questions have the same answer.
 *  - a pane: there is nowhere to type otherwise.
 *  - an empty work queue: Foreman is already feeding this session, one item at a time.
 *  - no OPEN PR on its branch. The one clause here that is about the WORK rather than
 *    the agent, and it exists because the two come apart exactly here: an agent that
 *    opened a PR and stopped is indistinguishable, on every other signal above, from
 *    one that finished and has nothing left to protect. Assigning types into a checkout
 *    still standing on that branch, so the next task's commits land on a change that is
 *    out for review, and the reviewer pulls work nobody asked that PR for. Configurable
 *    (`backlogRespectOpenPrs`), on by default. A MERGED PR does not block: it lingers on
 *    the card so you can see the work landed, and landed work is finished work.
 *  - no non-terminal task bound to it: it is already executing something of ours. This
 *    clause IS the serial-execution invariant on the selection side - an agent may take
 *    several tasks over its life, one after another, but never two at once. It filters
 *    on STATUS, not on the pointer: `Task.sessionId` is "currently executing on" and a
 *    finished row keeps naming its session until the agent takes its next task, so
 *    reading the bare pointer as "busy" would retire an agent the moment it shipped.
 *  - allowlisted: typing here is a live send, gated exactly like every other one.
 *
 * `TaskManager.assign` re-checks what it can server-side - the same non-terminal clause,
 * the other enforcement point of that invariant - because a session can go busy between
 * this decision and the POST that acts on it.
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
  // Only sessions Mission Control created. Note this is the SELECTION side only: the
  // board's drag gesture stays deliberately asymmetric and is never invite-gated (see the
  // note above and `TaskManager.assign`), because a human dropping a task on a pane has
  // already said "yes, that one" about the exact session this loop has to guess at.
  if (s.foremanInvite !== "sdk" && s.foremanInvite !== "dispatch") return false;
  if (!hasPane(s)) return false;
  if (s.queue && s.queue.openCount > 0) return false;
  if (cfg.respectOpenPrs && s.prState === "open") return false;
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
  unassignable: ReadonlySet<string>,
): Session | null {
  for (const s of sessions) {
    if (unassignable.has(s.id)) continue;
    // Compared on repoRoot, not cwd - a linked worktree of the task's repo is a
    // legitimate home for it, a different repo never is. The same comparison
    // `TaskManager.assign` refuses on.
    if (s.repoRoot !== task.repoRoot) continue;
    // The harness the task was FILED for. A dispatch honours `task.agent` by launching
    // that binary, so an assign that typed a Codex task into a Claude pane would make
    // the same task mean two different things depending on which path happened to win
    // the tick. The drag gesture is permissive here on purpose - a human picked that
    // pane - but nobody picked this one.
    if (s.agent !== task.agent) continue;
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
 *     asking and drops to SERIAL mode instead: one task in flight at a time, oldest
 *     first. Serial execution satisfies every possible dependency order by
 *     construction, so a broken planner degrades to slow rather than to wrong. The gate
 *     covers ASSIGNS as well as launches - typing a task into an idle agent starts it
 *     just as thoroughly as cutting a worktree does, and serial mode is precisely the
 *     state in which we cannot say the two are independent.
 *  4. an allowlisted, ready item with a free agent in its repo -> assign. Checked
 *     BEFORE capacity because it consumes no new session, so it is correct at the
 *     ceiling and cheaper below it.
 *  5. the first allowlisted ready item, if the fleet is under `maxSessions` -> dispatch.
 *  6. otherwise nothing, saying which of those it was.
 *
 * "Ready" in steps 4 and 5 is `readyBacklog`, which already drops items whose enable
 * toggle is off rather than making both action paths remember to ask. Step 3 deliberately
 * still sees parked items through `plannableBacklog`: hiding one from `sanitizePlan` would
 * delete inferred dependencies pointing at it and make its dependents ready. The only
 * action-path use of `enabled` in this file is the refusal message, because "nothing is
 * ready" and "you switched everything off" are the same silence with very different fixes.
 *
 * The mode gate sits at the END rather than the top, so a dry run reports the decision
 * it would have taken instead of a flat "off". That is the whole value of dry-run here:
 * the ordering and the dependency read are what you want to check before you trust it
 * to launch anything.
 */
export function decideBacklogTick(input: BacklogTickInput): BacklogAction {
  const { tasks, sessions, plan, cfg, now } = input;
  const acted = input.recentlyActed ?? new Set<string>();
  const unassignable = input.unassignable ?? new Set<string>();

  if (!cfg.enabled) return { kind: "none", why: "" };

  const backlog = backlogTasks(tasks);
  if (backlog.length === 0) return { kind: "none", why: "the backlog is empty" };

  // Step 3. `planExhausted` is the only thing that lets a stale plan through, and what
  // it buys is not "schedule from a stale plan" - `readyBacklog` with a stale plan
  // simply treats the unplanned items as unblocked - but the serial cap below, which is
  // what makes that safe.
  const stale = planStale(tasks, plan);
  // `plannableBacklog`, not the whole backlog: the same head `planStale` asks about, so
  // what gets read is exactly what makes the staleness question answerable.
  if (stale && !cfg.planExhausted) return { kind: "plan", tasks: plannableBacklog(tasks) };
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
    const index = backlogIndex(tasks, plan);
    const off = allowed.filter((t) => !t.enabled).length;
    // Blocked is asked of the ENABLED items only. A parked item is not held up by
    // anything - it is switched off - and blaming a dependency graph for it is the same
    // misdirection the allowlist ordering above exists to avoid, one layer in.
    const blocked = allowed.filter((t) => t.enabled && blockersIn(t, index).length > 0).length;
    if (blocked === 0 && off > 0) {
      return { kind: "none", why: `every schedulable backlog item is disabled (${off} disabled)` };
    }
    return {
      kind: "none",
      why:
        `every schedulable backlog item is waiting on another task (${blocked} blocked` +
        `${off > 0 ? `, ${off} disabled` : ""})`,
    };
  }

  // Serial mode's cap, and it sits AHEAD of both ways of starting something. With no
  // dependency read to trust, at most one task may be executing at a time.
  if (serial && inFlightTasks(tasks, sessions) > 0) {
    return {
      kind: "none",
      why: "scheduling one at a time - Foreman could not read the backlog's dependencies",
    };
  }

  // Items already acted on drop out here rather than being re-judged after a decision,
  // so one task whose request we never saw the end of costs itself a minute instead of
  // costing the whole backlog one.
  const candidates = ready.filter((t) => !acted.has(t.id));
  if (candidates.length === 0) {
    return {
      kind: "none",
      why: "every ready backlog item was just acted on - waiting for it to land",
    };
  }

  // Step 4: prefer a free agent anywhere in the ready set, not just for the head. The
  // backlog is a set of items whose ordering constraints are already stated explicitly
  // as dependencies - unlike the work queue, where the human's sequence IS the meaning
  // - so taking a later item that has a home costs the head nothing and saves a
  // worktree. The head is still what gets launched when nothing can be assigned.
  for (const task of candidates) {
    const session = freeAgentFor(task, sessions, tasks, cfg, now, unassignable);
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

  const head = candidates[0]!;

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

/**
 * Whether a refused assign should take the SESSION off the target list for a while.
 *
 * The counterpart to `unassignable`: that set is only worth keeping for refusals a
 * different task would hit too. A 404 for a task a human dispatched a second earlier,
 * or a 409 saying the task has left the backlog, is a fact about the TASK - parking the
 * agent for ten minutes over it takes a perfectly free agent off the backlog and sends
 * the next item to a fresh worktree instead.
 *
 * An ABSENT scope parks, and that default is deliberate: a daemon older than the field
 * cannot tell us, and the worker is started separately from the daemon, so a version
 * skew between them is an ordinary upgrade-window state. Parking a session that did not
 * deserve it costs one worktree for ten minutes; not parking one that did puts the
 * autopilot back on the same doomed pairing every 4s.
 */
export function assignRefusalParksSession(scope: AssignRefusalScope | undefined): boolean {
  return scope !== "task";
}
