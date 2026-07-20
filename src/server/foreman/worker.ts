import { randomUUID } from "node:crypto";
import type { ForemanConfig } from "@shared/protocol.ts";
import type { ReviewItem, Session, SessionQueue, WorkItem } from "@shared/types.ts";
import { reportBucket } from "@shared/session.ts";
import { ForemanClient } from "./client.ts";
import { reviewSession } from "./review.ts";
import { EvaluationDebounce } from "../util/debounce.ts";
import { classifyPending } from "./pending.ts";
import type { Pending } from "./pending.ts";
import { parsePaneDialog } from "../discovery/pane-dialog.ts";
import type { ReviewInput } from "./prompt.ts";
import {
  applyVerdict,
  episodeFromPlan,
  foremanMayActLive,
  menuBlocksAnswer,
  planFromVerdict,
  ReviewFailureTracker,
} from "./verdict.ts";
import type { ReviewContext, Verdict } from "./verdict.ts";
import { classifyDivergence, triagePosture, triageSession } from "./triage.ts";
import type { TriageDeps, TriageOutcome } from "./triage.ts";
import {
  VERIFY_FAILURE_CAP,
  decideQueueTick,
  diffMayIncludeOtherWork,
  inFlightItem,
  planFromVerify,
  tickTargets,
} from "./queue-machine.ts";
import type { QueueConfig } from "./queue-machine.ts";
import {
  PromptedFailureTracker,
  decidePromptedWrapup,
  planPromptedWrapup,
} from "./prompted-wrapup.ts";
import type { PromptedConfig } from "./prompted-wrapup.ts";
import { applyQueueAction, noteKeyOf, resolveLiveSession } from "./queue-apply.ts";
import type { QueueActions } from "./queue-apply.ts";
import { PLAN_FAILURE_CAP, assignRefusalParksSession, decideBacklogTick } from "./backlog-machine.ts";
import type { BacklogConfig } from "./backlog-machine.ts";
import { backlogModel, planBacklog } from "./backlog-plan.ts";
import { verifyItem } from "./queue-verify.ts";
import { killLiveClaudeRuns, runClaudeText } from "../claude-cli.ts";

// The Foreman worker: a standalone loop (run via `npm run foreman`) that drains
// the sessions' needs-you queue AND feeds each session's work queue, one session at
// a time, reviewing each in a FRESH `claude -p` process so context never bleeds
// between sessions. It reaches the daemon only over the localhost API - it never
// touches the DB directly - so it is a plain client that can run in its own
// terminal, exactly as designed.
//
// In front of the full reviewer sits the cheap TRIAGE tier (see
// docs/plans/foreman-watcher/plan.md): a pure-code Tier 0 gate + a Haiku Tier 1
// router that dispose the easy cases and route only the hard ones up to the full
// (Tier 2) review. The `triage` config picks the posture: `off` (always Tier 2),
// `on` (cheap tier decides, full review only on route-up), or `shadow` (run both,
// act on the full review, log every divergence so the cheap tier is measured
// before it's trusted).

/** How often to poll while idle or disabled. */
const IDLE_MS = 4000;
/** Small breather between processing two sessions. */
const BETWEEN_MS = 400;
/**
 * Minimum wall-clock gap between two full reviews of the *same* session. The marker
 * idempotency check already skips an unchanged episode for free; this floor stops a
 * session whose marker flaps (e.g. a terminal keyed on a moving `lastActivity`) from
 * spawning a fresh `claude -p` every loop. Overridable for tests/tuning; default 60s.
 */
const EVAL_DEBOUNCE_MS = Number(process.env.FOREMAN_EVAL_DEBOUNCE_MS || 60_000);
/**
 * The Tier 1 router's own wall-clock cap, well under the full reviewer's 120s: this is Haiku
 * emitting one small object over a trimmed window, not Opus reading 48 turns with the whole
 * POLICY. The budgets must differ because `on` mode runs the two SERIALLY (the router, then the
 * full review on route-up), so sharing Tier 2's cap would let a degraded API double the serial
 * queue's worst case rather than fail fast. A timeout is just a spawn failure to `triageSession`,
 * which routes up - i.e. degrades to exactly the pre-triage cost.
 */
const TRIAGE_TIMEOUT_MS = Number(process.env.FOREMAN_TRIAGE_TIMEOUT_MS || 30_000);

/**
 * Operational timings. Anything a human should reason about is ForemanConfig
 * (persisted, surfaced in ForemanBar); these are module constants with an env
 * override, following the FOREMAN_REVIEW_TIMEOUT_MS precedent.
 */
const SETTLE_MS = Number(process.env.FOREMAN_QUEUE_SETTLE_MS || 10_000);
const PICKUP_TIMEOUT_MS = Number(process.env.FOREMAN_QUEUE_PICKUP_MS || 45_000);
/** How often the background timer renews the lease (3 misses = expiry). */
const LEASE_RENEW_MS = 30_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Consecutive review-failure strikes, so a transient blip retries instead of a permanent skip. */
const reviewFailures = new ReviewFailureTracker();
/** Per-session cooldown so a flapping marker can't trigger back-to-back reviews. */
const evaluations = new EvaluationDebounce(EVAL_DEBOUNCE_MS);

/** Consecutive prompted-wrap-up attempts that got nowhere - see PromptedFailureTracker. */
const promptedFailures = new PromptedFailureTracker();

/**
 * Retire one episode: the write that disarms the trigger, and the ONLY thing that clears
 * the strikes. Answers whether it landed, because every caller must abort on false - a
 * tick whose only write failed changed nothing, so reporting it as progress is what
 * makes the loop skip its IDLE_MS sleep and come straight back.
 */
async function retirePromptedEpisode(
  client: ForemanClient,
  session: Session,
  goal: string,
): Promise<boolean> {
  try {
    await client.markPromptedWrapup(session.id, goal);
    promptedFailures.onRetired(session.id);
    return true;
  } catch (err) {
    const failures = promptedFailures.onFailure(session.id, goal);
    log(
      `${session.name}: prompted wrap-up aborted - could not retire the episode ` +
        `(${failures}x): ${String(err)}`,
    );
    return false;
  }
}

/** This process's identity for the lease. New per start, by design. */
const WORKER_ID = `${process.pid}-${randomUUID().slice(0, 8)}`;
/** Whether we currently hold the worker lease. Owned by the renewal timer. */
let isLeader = false;

/**
 * Renew the lease on a BACKGROUND TIMER, not from the loop. This is the
 * difference between a lease that works and one that hands the sessions to two
 * workers mid-verify.
 *
 * The loop blocks on a `claude -p` for up to 2 * REVIEW_TIMEOUT_MS = 240s, so a
 * lease renewed only by loop progress would have to outlive that - and a
 * "comfortably longer than one tick" TTL would expire mid-verify, let a standby
 * acquire, and run both workers. A `claude -p` is async I/O, so the event loop is
 * free throughout a verify and this timer fires ~8 times during one. That makes
 * the lease mean "this worker process is alive" rather than "this worker recently
 * finished a session", and keeps failover fast (90s, not 300s).
 */
function startLeaseRenewal(client: ForemanClient): void {
  const beat = async (): Promise<void> => {
    const r = await client.heartbeat(WORKER_ID);
    const was = isLeader;
    // A daemon we cannot reach means we CANNOT claim leadership: assuming it
    // because the ask failed is exactly how two workers end up draining the queue.
    isLeader = r?.leader ?? false;
    if (was && !isLeader) log("lost the lease - standing by");
    if (!was && isLeader) log("acquired the lease - this worker is the leader");
  };
  void beat();
  setInterval(() => void beat(), LEASE_RENEW_MS).unref?.();
}

/**
 * Tear down on an ordinary exit signal. Two things must happen:
 *  - Kill our reviewers. They spawn `detached` (so the session poller never sees them
 *    as phantom sessions), which also means they'd SURVIVE us and burn tokens to
 *    nowhere. A SIGKILL of this process still leaks them; nothing can be done about
 *    that from in here, but every ordinary path is covered.
 *  - Release the lease, so a standby takes over at once instead of waiting out the
 *    90s TTL.
 */
function installShutdown(client: ForemanClient): void {
  let closing = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      if (closing) process.exit(1); // a second Ctrl-C means "now"
      closing = true;
      log("shutting down…");
      killLiveClaudeRuns();
      void client.releaseLease(WORKER_ID).finally(() => process.exit(0));
    });
  }
}

async function main(): Promise<void> {
  const client = new ForemanClient();
  installShutdown(client);
  startLeaseRenewal(client);
  log(`Foreman worker started (${WORKER_ID}); watching the needs-you queue + session work queues.`);

  for (;;) {
    let cfg;
    try {
      cfg = await client.getConfig();
    } catch (err) {
      log(`daemon unreachable (${String(err)}); retrying…`);
      await sleep(IDLE_MS);
      continue;
    }

    if (!cfg.enabled) {
      await sleep(IDLE_MS);
      continue;
    }

    // A non-leader IDLES, it does not exit - so it takes over cleanly when the
    // leader's lease expires (a crash, a Ctrl-C), which is the whole point of an
    // expiring lease. The lease gates the WHOLE loop, including triage: two
    // workers double-answering a needs-you prompt is a real harm too, and
    // sendStillValid narrows that window without closing it (both can pass the
    // re-check and then both send).
    if (!isLeader) {
      await sleep(IDLE_MS);
      continue;
    }

    let targets: Session[] = [];
    let reviews: ReviewItem[] = [];
    try {
      const sessions = await client.sessions();
      reviews = await client.reviews();
      targets = tickTargets(sessions, cfg.wrapupTriggers);
      await sweepOrphanedQueues(client);
    } catch (err) {
      log(`snapshot failed (${String(err)})`);
      await sleep(IDLE_MS);
      continue;
    }

    // Whether this pass actually moved anything. A non-empty `targets` is NOT the
    // same question, and conflating them spins the loop at BETWEEN_MS forever:
    // `queueWantsATick` selects on `openCount > 0`, which is "this queue has
    // unfinished items", not "the machine can advance it" - and the summary it reads
    // can't tell those apart (a drafted item's `approvedAt` isn't in it). Every
    // NORMAL steady state of the feature is a target that decides `none` every tick:
    // a draft waiting on an Approve, an agent working, a delivered prompt inside its
    // pickup window. The needs-you half has the same shape once a prompt's marker is
    // handled. So the honest place to notice "nothing here right now" is the outcome,
    // not the selector - a pass that changed nothing has, by definition, nothing to
    // hurry back for, and IDLE_MS is the same latency an idle set of sessions already accepts.
    let advanced = false;

    // The FLEET-level step, run before the per-session ones and outside the
    // "no targets" bail below. The backlog is about sessions that DO NOT EXIST YET, so
    // gating it on `tickTargets` finding a live session with something to decide is
    // exactly backwards: the pass where the whole fleet is quiet is the pass most likely
    // to have capacity to launch into.
    try {
      if (await runBacklogAutopilot(client, cfg)) advanced = true;
    } catch (err) {
      log(`backlog autopilot failed (${String(err)})`);
    }

    if (targets.length === 0) {
      if (!advanced) await sleep(IDLE_MS);
      continue;
    }

    for (const session of targets) {
      // Honour a mid-drain disable/mode change without finishing the whole list.
      try {
        cfg = await client.getConfig();
      } catch {
        break;
      }
      if (!cfg.enabled || !isLeader) break;

      try {
        if (await processTarget(client, cfg, session, reviews)) advanced = true;
      } catch (err) {
        log(`error processing ${session.name} (${session.id}): ${String(err)}`);
      }
      await sleep(BETWEEN_MS);
    }

    if (!advanced) await sleep(IDLE_MS);
  }
}

/**
 * How long a task autopilot just acted on stays off the table.
 *
 * A belt-and-braces guard on top of the daemon's own: `POST /api/tasks/:id/dispatch`
 * flips the task out of `backlog` before it answers, so the ordinary read already sees
 * it as taken. This covers the cases where that is not enough - a response that never
 * arrives (leaving us unsure whether it landed), a daemon restart mid-launch - because
 * the failure it prevents is two agents and two worktrees on one task, which is far
 * more expensive than a task waiting an extra minute.
 */
const ACTED_TTL_MS = 60_000;
/**
 * How long serial mode lasts before the planner is given another chance.
 *
 * Exhaustion has to be TIME-BOXED. The cap is there to stop a broken planner burning a
 * model call every few seconds, and the states that trip it - an API outage, a rate
 * limit - are overwhelmingly transient, so a permanent latch would mean a two-minute
 * blip degrades scheduling until somebody notices and restarts the worker. Long enough
 * that a genuinely broken planner is still costing a call per interval, not per tick.
 */
const PLAN_RETRY_MS = Number(process.env.FOREMAN_BACKLOG_RETRY_MS || 10 * 60_000);
/** First wait after the daemon refuses a plan write; doubles per consecutive failure. */
const PLAN_STORE_BACKOFF_MS = Number(process.env.FOREMAN_BACKLOG_STORE_BACKOFF_MS || 15_000);
/** Ceiling on that doubling, so a long outage still retries at a sane rate. */
const PLAN_STORE_BACKOFF_MAX_MS = 10 * 60_000;
/** Task id -> when autopilot last acted on it. Deliberately in memory: see ACTED_TTL_MS. */
const recentlyActed = new Map<string, number>();
/**
 * How long a session that refused an assign stays off the target list.
 *
 * Longer than `ACTED_TTL_MS` because the refusals are a different kind of fact. A task
 * stamp guards a request whose outcome we never learned, which resolves itself in
 * seconds; an assign refusal is a STATE - a checkout holding uncommitted work, a wedged
 * pane - that a human has to change. Retrying it every minute would put a `git status`
 * and a `rev-list` on that session forever for no chance of a different answer, and the
 * moment the human does clear it the session is picked up on the next expiry anyway.
 */
const REFUSED_TTL_MS = 10 * 60_000;
/** Session id -> when it last refused an assign. See `REFUSED_TTL_MS`. */
const refusedAssign = new Map<string, number>();
/** Consecutive backlog-planning failures. At PLAN_FAILURE_CAP the machine goes serial. */
let backlogPlanFailures = 0;
/** When the last planning failure landed, so PLAN_RETRY_MS can lift serial mode again. */
let backlogPlanFailedAt = 0;
/**
 * Consecutive failures to STORE a plan, counted apart from `backlogPlanFailures`.
 *
 * A refused write is not a broken planner, so the two keep their own counts and their
 * own recovery clocks - a daemon that was restarting must not spend the planner's
 * strikes. What they share is the DEGRADATION they cause: see `backlogSerial`.
 *
 * It also needs its own brake. The plan never lands, so the machine asks for one again
 * next tick, and without a wait that is a Sonnet call every IDLE_MS for as long as the
 * route stays broken.
 */
let backlogStoreFailures = 0;
/** Epoch ms before which the plan path is skipped entirely. See `backlogStoreFailures`. */
let backlogStoreRetryAt = 0;
/**
 * The last thing the backlog said, so a steady state is logged ONCE.
 *
 * Without this the ordinary resting state of the feature - "at the agent ceiling",
 * "the backlog is empty" - writes a line every IDLE_MS, forever, which is how a log
 * stops being read at all. A CHANGE is news; the same answer for the ninth time is not.
 */
let lastBacklogNote = "";

/** Drop expired entries, then hand the machine the ids that are still off the table. */
function actedTaskIds(now: number): Set<string> {
  for (const [id, at] of recentlyActed) {
    if (now - at >= ACTED_TTL_MS) recentlyActed.delete(id);
  }
  return new Set(recentlyActed.keys());
}

/** Drop expired entries, then hand the machine the sessions still off the target list. */
function refusedSessionIds(now: number): Set<string> {
  for (const [id, at] of refusedAssign) {
    if (now - at >= REFUSED_TTL_MS) refusedAssign.delete(id);
  }
  return new Set(refusedAssign.keys());
}

/**
 * Lift serial mode once the cooldown has run, so a transient outage self-heals.
 *
 * Logged unconditionally rather than through `noteBacklog`: this is a transition, and
 * it is the one an operator staring at "scheduling one at a time" needs to see end.
 */
function rearmBacklogPlanning(now: number): void {
  if (backlogPlanFailures < PLAN_FAILURE_CAP) return;
  if (now - backlogPlanFailedAt < PLAN_RETRY_MS) return;
  // One probe per cooldown, not a fresh set of three. `planBacklog` is a 90s blocking
  // call on the loop that also drives queue drain and needs-you triage, so a planner
  // that HANGS rather than erroring would stall everything else for four and a half
  // minutes every cooldown. A single attempt still self-heals: it clears the count
  // outright on success.
  backlogPlanFailures = PLAN_FAILURE_CAP - 1;
  lastBacklogNote = "";
  log(
    `backlog: retrying the dependency read after ${Math.round(PLAN_RETRY_MS / 1000)}s ` +
      `of scheduling one at a time`,
  );
}

/**
 * Whether scheduling should degrade to serial right now.
 *
 * Two independent ways to get here, kept as separate counters because they are
 * different faults: the planner cannot answer, or the daemon will not store what it
 * answered. The DEGRADATION is shared on purpose. A refused write used to leave
 * `planExhausted` false, so the machine kept deciding `plan` and the worker kept
 * declining to act on it - a broken route silently switched the autopilot off rather
 * than slowing it down.
 *
 * The store half is scoped to its backoff window, so when the wait elapses the machine
 * asks for a plan again and the write gets one probe. Without that scoping this would
 * be the permanent latch the planner's cooldown was written to remove.
 */
function backlogSerial(now: number): boolean {
  if (backlogPlanFailures >= PLAN_FAILURE_CAP) return true;
  return backlogStoreFailures >= PLAN_FAILURE_CAP && now < backlogStoreRetryAt;
}

/**
 * Whether the daemon's answer positively means nothing was typed and nothing started.
 *
 * The documented refusals only: 404 for a task that is gone, 409 for a state conflict
 * (already dispatched, agent busy, wrong repo, pane locked). Those leave the task
 * exactly where it was, so the guard can be released and the item tried again at once.
 *
 * Anything else HOLDS the guard, and a 500 is the case that matters: `TaskManager.assign`
 * types the prompt before it claims the row, and the claim is a synchronous SQLite write
 * that can throw. That answer means the agent may already be working on the task while
 * the row still reads `backlog` - releasing there would type the same task into the same
 * pane again on the very next tick.
 */
function taskRefused(status: number): boolean {
  return status === 404 || status === 409;
}

/** Exponential, capped: 15s, 30s, 60s ... 10m. */
function storeBackoffMs(failures: number): number {
  const wait = PLAN_STORE_BACKOFF_MS * 2 ** Math.max(0, failures - 1);
  return Math.min(wait, PLAN_STORE_BACKOFF_MAX_MS);
}

/** Log a backlog outcome only when it differs from the last one. */
function noteBacklog(msg: string): void {
  if (!msg || msg === lastBacklogNote) return;
  lastBacklogNote = msg;
  log(`backlog: ${msg}`);
}

/** Policy knobs from config; timings from the module constants, as the queue does. */
function backlogConfig(cfg: ForemanConfig, now: number): BacklogConfig {
  return {
    enabled: cfg.autoBacklog,
    maxSessions: cfg.maxSessions,
    allowlist: cfg.repoAllowlist,
    // The SAME gate the queue's sends and the auto-wrap-up clear. Launching an agent and
    // typing a task into someone's pane are both live acts; neither happens in dry-run.
    mayActLive: cfg.mode === "live",
    settleMs: SETTLE_MS,
    respectOpenPrs: cfg.backlogRespectOpenPrs,
    planExhausted: backlogSerial(now),
  };
}

/**
 * The backlog's tick: ask the pure machine what to do, then do exactly that one thing.
 *
 * Same decide-then-act shape as `processTarget`, and for the same reason - all the
 * precedence lives in `decideBacklogTick`, so it can be read as a table and cannot
 * drift into the loop. This function only performs I/O and reports whether anything
 * moved.
 *
 * "Anything moved" is judged strictly. A refused assign, a failed plan write and a
 * failed launch all return FALSE even though work was attempted: the loop reads a true
 * as "come straight back", and every one of those states persists, so claiming progress
 * for them turns a broken daemon route into a request storm - and, on the plan path, a
 * model call every BETWEEN_MS.
 */
async function runBacklogAutopilot(client: ForemanClient, cfg: ForemanConfig): Promise<boolean> {
  if (!cfg.autoBacklog) return false;

  // Three reads, concurrently - all cheap loopback GETs against state the daemon already
  // holds in memory. A failed read decides nothing: the machine's inputs would be
  // partial, and a partial task list reads as spare capacity.
  const snapshot = await Promise.all([
    client.sessions(),
    client.tasks(),
    client.backlogPlan().catch(() => null),
  ]).catch(() => null);
  if (!snapshot) return false;
  const [sessions, tasks, plan] = snapshot;

  const now = Date.now();
  // Read before the re-arm clears it, so a plan that lands can say the degradation
  // ended. Counter-based rather than `backlogSerial`, which is false during the store
  // path's probe window and would miss exactly the recovery worth announcing.
  const degradedBefore =
    backlogPlanFailures >= PLAN_FAILURE_CAP || backlogStoreFailures >= PLAN_FAILURE_CAP;
  rearmBacklogPlanning(now);
  const action = decideBacklogTick({
    tasks,
    sessions,
    plan,
    cfg: backlogConfig(cfg, now),
    now,
    // The machine skips these and takes the next item it can act on. Kept here rather
    // than in the machine because it is a fact about THIS PROCESS's recent history, not
    // about the state of the world.
    recentlyActed: actedTaskIds(now),
    // Same reasoning, one level over: sessions that have already turned an assign down.
    // Without this a sticky refusal picks the same pair every tick and the backlog never
    // reaches the dispatch that would have moved it. See `unassignable`.
    unassignable: refusedSessionIds(now),
  });

  if (action.kind === "none") {
    noteBacklog(action.why);
    return false;
  }

  if (action.kind === "plan") {
    if (now < backlogStoreRetryAt) {
      noteBacklog("waiting to retry the plan - the daemon refused the last write");
      return false;
    }
    const result = await planBacklog(action.tasks, backlogModel(cfg));
    if (result.kind === "failed") {
      backlogPlanFailures++;
      backlogPlanFailedAt = now;
      noteBacklog(
        `could not read the dependencies (${backlogPlanFailures}x): ${result.reason}` +
          (backlogPlanFailures >= PLAN_FAILURE_CAP ? " - scheduling one at a time instead" : ""),
      );
      return false;
    }
    try {
      await client.putBacklogPlan(result.plan);
    } catch (err) {
      // NOT a planning failure - the model answered fine, the daemon refused the write.
      // Counted and backed off separately so a broken route does not spend the
      // planner's strikes, though at its own cap it degrades the same way.
      backlogStoreFailures++;
      backlogStoreRetryAt = now + storeBackoffMs(backlogStoreFailures);
      noteBacklog(
        `planned the backlog but could not store it (${backlogStoreFailures}x, retrying in ` +
          `${Math.round(storeBackoffMs(backlogStoreFailures) / 1000)}s)` +
          (backlogStoreFailures >= PLAN_FAILURE_CAP
            ? " - scheduling one at a time meanwhile"
            : "") +
          `: ${String(err)}`,
      );
      return false;
    }
    backlogStoreFailures = 0;
    backlogStoreRetryAt = 0;
    backlogPlanFailures = 0;
    backlogPlanFailedAt = 0;
    // Reset the change-only log: the next outcome is news whatever it says, because the
    // whole picture just moved.
    lastBacklogNote = "";
    log(
      `backlog: read ${result.plan.entries.length} item(s)` +
        (result.plan.note ? ` - ${result.plan.note}` : ""),
    );
    if (degradedBefore) log("backlog: scheduling from the plan again, not one at a time");
    return true;
  }

  if (action.kind === "assign") {
    // Stamped BEFORE the call, not after: the failure this guards against is a request
    // whose outcome we never learn, and a stamp that only happens on success is exactly
    // the one that is missing then.
    recentlyActed.set(action.task.id, now);
    const r = await client.assignTask(action.task.id, action.session.id);
    if (!r.ok) {
      // Released only on a documented refusal, which is positive knowledge that nothing
      // was typed; held on anything that leaves us unsure whether text reached the pane.
      // Holding it always would walk the whole ready set out of reach one item per tick
      // while a single pane stayed locked.
      if (taskRefused(r.status)) recentlyActed.delete(action.task.id);
      // The session, not the task, is what was wrong with this pairing - the same task
      // is very likely fine on the next agent, or in a fresh worktree. Stamped on a
      // documented refusal only: a 5xx or a dropped connection says nothing about the
      // session, and could have typed. And only when the daemon attributes the refusal
      // to the session, since a task that left the backlog says nothing about the agent
      // that was offered it - see `assignRefusalParksSession`.
      if (taskRefused(r.status) && assignRefusalParksSession(r.scope)) {
        refusedAssign.set(action.session.id, now);
      }
      noteBacklog(`could not hand "${oneLine(action.task.title)}" over - ${r.error}`);
      return false;
    }
    refusedAssign.delete(action.session.id);
    lastBacklogNote = "";
    log(`backlog: handed "${oneLine(action.task.title)}" to ${action.session.name} (${action.why})`);
    return true;
  }

  recentlyActed.set(action.task.id, now);
  const r = await client.dispatchTask(action.task.id);
  if (!r.ok) {
    if (taskRefused(r.status)) recentlyActed.delete(action.task.id);
    noteBacklog(`could not launch "${oneLine(action.task.title)}" - ${r.error}`);
    return false;
  }
  lastBacklogNote = "";
  log(`backlog: launched an agent for "${oneLine(action.task.title)}" (${action.why})`);
  return true;
}

/**
 * Terminalize the in-flight item of any queue whose session is gone.
 *
 * The machine's "exited -> escalate" row needs a LIVE session with that key to
 * drive it, so once the session is evicted from the snapshot an item stuck
 * mid-cycle would strand forever - and its row would keep holding the partial
 * unique index, permanently blocking a re-attached queue behind a phantom.
 *
 * Only the in-flight item is escalated. Waiting items are deliberately left
 * INTACT: escalating them would defeat the re-attach affordance, and resuming a
 * queue is the entire point. That matters most on the `/clear` case, where the
 * human clears context on a live pane fully intending to keep working - escalating
 * their untouched backlog out from under them would be a bug wearing a safety hat.
 */
async function sweepOrphanedQueues(client: ForemanClient): Promise<void> {
  const orphans = await client.orphanedQueues().catch(() => [] as SessionQueue[]);
  for (const q of orphans) {
    const flight = inFlightItem(q.items);
    if (!flight) continue;
    // The item's own session is gone - that IS the finding - so this addresses the
    // write by queue key. The session-scoped route can't serve it: there is no
    // session left for it to resolve.
    await client
      .setItemStateByKey(q.noteKey, flight.id, {
        state: "escalated",
        escalationReason: "the session vanished while this item was in flight",
      })
      .catch(() => {});
    log(`swept an orphaned in-flight item from queue ${q.noteKey}`);
  }
}

/**
 * One session's tick: ask the pure machine what to do, then do it. All the policy
 * lives in `decideQueueTick` - this only performs I/O, so the precedence can never
 * drift into the loop.
 *
 * Returns whether it ACTUALLY advanced anything, which is what lets the loop tell
 * "there is work here" from "there are items here". See the `advanced` flag.
 */
async function processTarget(
  client: ForemanClient,
  cfg: ForemanConfig,
  session: Session,
  reviews: ReviewItem[],
): Promise<boolean> {
  // Re-resolve the target against a FRESH session list before deciding ANYTHING - including
  // whether this session is here because it needs you - through the same
  // `resolveLiveSession` the send guard uses, for the same reason: a pass walks its
  // targets serially and any one of them can block on a `claude -p` for up to 240s,
  // so the snapshot this target was selected with can be minutes old. Deciding from
  // it reads a long-dead `state: "idle"` against a fresh `now`, which makes
  // `settledIdle` trivially true and fires a verify at an agent that went back to
  // work - and unlike a send, a verify has no guard of its own to catch it.
  //
  // A FAILED read is not evidence of anything, so it decides nothing: skip the
  // target and re-decide next tick. Falling back to the stale `session` would
  // reintroduce the exact bug this re-resolve exists to close, and a one-element
  // fallback would also lie to `reportBucket`, which needs the real session list to tell a
  // gate this agent is driving from one that needs you.
  //
  // This read sits ABOVE the no-queue branch because that branch needs both answers
  // just as much: it called `reportBucket(session, [session])`, and a one-element
  // list cannot see that a SIBLING session is driving the same no-mistakes run, so
  // a gate nobody needs to answer read as "needs-you" and spawned a full `claude -p`
  // triage from a possibly minutes-old snapshot. In dry-run that never reaches
  // `sendStillValid` (the one guard that does re-read the sessions), so it landed as a
  // spurious escalation note nagging the human about a gate that was already handled.
  const live = await client.sessions().catch(() => null);
  if (!live) return false;
  // A successful read that no longer lists this session (or lists it as exited) says
  // the sessions moved on under us. Say nothing about it from a stale snapshot: if it's
  // really gone the orphan sweep owns its in-flight item - and unlike this path, that
  // sweep waits out the exit linger before calling anything orphaned.
  const fresh = resolveLiveSession(live, noteKeyOf(session));
  if (!fresh) return false;

  // The FULL queue: Session.queue is only the compact card summary, while the
  // machine needs gaps, baseSha, transcriptAnchor, round, revision and strikes.
  // One extra loopback round-trip per target per tick - noise next to a claude -p.
  //
  // A FAILED read has to stay distinguishable from a successful one, because `null` is
  // ALSO the legitimate answer for "this session has no queue" - and the two mean
  // opposite things to the prompted path. Coercing a throw to `null` hands
  // `decidePromptedWrapup` a null queue on a transient daemon blip, which silently
  // disarms both of its double-fire guards at once: the overlap rule that hands a queued
  // session to the drain trigger, and the once-per-episode `promptedGoal` re-arm. The
  // result is a second wrap-up pushing the same branch.
  //
  // Distinguishable, but NOT fatal to the whole tick - the bail belongs on the prompted
  // path alone, and hoisting it above everything cost far more than it bought: triage
  // needs the queue only for `queueItemContext`, which is optional by construction, so a
  // flaky GET on this one endpoint left every session with an unanswered question
  // untriaged for as long as it stayed broken. See the branch below.
  const read = await client.queue(fresh.id).then((queue) => ({ queue }), () => null);
  const queue = read?.queue ?? null;

  if (!queue || queue.items.length === 0) {
    // No queue: this session is here because it needs you...
    //
    // Reached on a failed read too, deliberately. Triage's evidence is the session list
    // and the transcript, neither of which this read touches, and a human waiting on an
    // answer is the case least able to afford a stall. Worst case the queue did have
    // items, and triage runs without knowing what Foreman commissioned - which is
    // exactly the `queueItemContext: undefined` path it already supports.
    if (reportBucket(fresh, live) === "needs-you" || fresh.state === "awaiting_input") {
      return await processSession(client, cfg, fresh, reviews);
    }
    // ...or because it took a prompt straight into the pane, worked, and parked, and
    // the `prompted` wrap-up trigger is armed. Below the needs-you check on purpose:
    // an unanswered question is not a finished session, and triage owns that case.
    //
    // THIS is what the failed read must not reach: an unread queue is not an empty one,
    // and the trigger's guards both live in the row we failed to read. Decide nothing
    // and re-decide next tick.
    if (!read) return false;
    return await processPromptedWrapup(client, cfg, fresh, live, queue);
  }

  const qcfg = queueConfig(cfg);

  const action = decideQueueTick({
    session: fresh,
    bucket: reportBucket(fresh, live),
    queue,
    cfg: qcfg,
    mayActLive: foremanMayActLive(cfg, fresh.cwd, fresh.repoRoot),
    now: Date.now(),
  });

  if (action.kind === "triage") {
    // An unanswered question blocks the item anyway. Tell triage what the queue
    // commissioned, or the two subsystems actively fight: the reviewer can answer
    // "no, don't do that" to a question about the very item Foreman commissioned,
    // or escalate something it could have answered trivially had it known.
    const flight = inFlightItem(queue.items);
    return await processSession(client, cfg, fresh, reviews, queueItemContext(flight));
  }

  if (action.kind === "verify") {
    await runVerify(client, cfg, fresh, action.item, queue, qcfg);
    return true;
  }

  const outcome = await applyQueueAction(
    queueActions(client, cfg),
    fresh,
    action,
    qcfg,
    Date.now(),
  );
  if (outcome.kind === "sent") log(`${fresh.name}: sent item "${oneLine(outcome.item.intent)}"`);
  else if (outcome.kind === "proposed")
    log(`${fresh.name}: drafted item "${oneLine(outcome.item.intent)}" (awaiting Approve)`);
  else if (outcome.kind === "aborted") log(`${fresh.name}: held off - ${outcome.why}`);
  else if (outcome.kind === "done") log(`${fresh.name}: ${outcome.what}`);
  return outcome.kind !== "noop";
}

/** Policy knobs from config; timings from the module constants. */
function queueConfig(cfg: ForemanConfig): QueueConfig {
  return {
    maxFixAttempts: cfg.maxFixAttempts,
    maxFixRounds: cfg.maxFixRounds,
    settleMs: SETTLE_MS,
    pickupTimeoutMs: PICKUP_TIMEOUT_MS,
    wrapupTriggers: cfg.wrapupTriggers,
    wrapup: cfg.wrapup,
  };
}

/** The same projection for the prompted trigger. Same `settleMs`, deliberately. */
function promptedConfig(cfg: ForemanConfig): PromptedConfig {
  return {
    triggers: cfg.wrapupTriggers,
    wrapup: cfg.wrapup,
    settleMs: SETTLE_MS,
  };
}

/**
 * The `prompted` wrap-up trigger's tick: has this session finished the work a human
 * asked it for in the pane, and if so, ship it?
 *
 * Structured as decide -> verify -> plan -> act, mirroring `decideQueueTick` ->
 * `runVerify` -> `planFromVerify`. All the policy is in the two pure functions; this
 * only does I/O and ordering.
 *
 * THE ORDERING IS THE SAFETY ARGUMENT, and it is the same one `auto-wrapup` makes:
 * the write that RETIRES the episode lands BEFORE the irreversible act. `/no-mistakes`
 * pushes and opens a PR, so a crash between "typed" and "recorded that we typed" must
 * leave the trigger disarmed, never re-armed. Concretely:
 *
 *   verify -> stamp `promptedGoal` -> type -> record the answer
 *
 * Every failure degrades toward the human: a stamp that fails aborts before typing
 * (nothing happened, we retry next tick, and only so many times - see
 * `promptedFailures`); a type that fails leaves the episode retired with the Ship it?
 * card as the recovery; a record that fails has the instruction visibly in the pane with
 * a human looking at it.
 *
 * A tick that aborts returns NOT advanced, always. The loop reads that as "nothing here
 * right now" and sleeps IDLE_MS; claiming progress for a write that failed re-selects
 * this same session every BETWEEN_MS instead, which on the paths below the verifier
 * means a `claude -p` per 400ms for as long as one endpoint stays broken.
 */
async function processPromptedWrapup(
  client: ForemanClient,
  cfg: ForemanConfig,
  session: Session,
  live: Session[],
  queue: SessionQueue | null,
): Promise<boolean> {
  const pcfg = promptedConfig(cfg);

  // The goal is fetched BEFORE the decision because the decision needs it, but it is
  // one loopback GET and every cheap structural gate is inside `decidePromptedWrapup`
  // - so on a session that isn't a candidate this costs one request and no model call.
  // A failed read is not evidence of anything: decide nothing and retry next tick.
  const goal = await client.goal(session.id).catch(() => null);

  const candidate = decidePromptedWrapup({
    session,
    bucket: reportBucket(session, live),
    queue,
    goalPrompt: goal?.prompt ?? null,
    cfg: pcfg,
    now: Date.now(),
  });
  if (candidate.kind === "skip") return false;

  // Foreman already gave up on this episode - see `promptedFailures`, which counts both
  // the failures below that can repeat forever. Checked HERE, above every read, because
  // the whole point of the cap is to stop spending on it: a check further down would
  // still pay for the evidence gather and the `claude -p` it exists to prevent.
  if (promptedFailures.gaveUp(session.id, candidate.goal)) return false;

  // --- evidence. Same discipline as runVerify: any gap in it is a verify-INFRASTRUCTURE
  // failure and must never reach the verifier, which would otherwise find no proof the
  // work was done and answer "incomplete" about work that is finished. Here that
  // mistake is cheap in the right direction (we hold, and type nothing), so each of
  // these returns WITHOUT stamping - the episode stays armed and retries next tick.

  // No base sha: the whole branch since it diverged is the unit of work, because a
  // pane-typed session has no per-item scope to anchor to. That is also why
  // `diffMayIncludeOtherWork` is true below - it always may.
  const diff = await client.diff(session.id).catch(() => null);
  if (!diff || !diff.ok) {
    log(`${session.name}: prompted wrap-up held - could not read the diff`);
    return false;
  }

  // An empty diff decides itself, and decides it WITHOUT a model call: the session
  // changed nothing, so there is nothing to commit, push or open a PR for. This is the
  // common case for a question-and-answer session ("what does this function do?"), and
  // it is exactly the case that would otherwise make this trigger obnoxious - a Ship
  // it? card on every conversation. Stamped, because the answer will not change while
  // the session sits idle.
  if (!diff.patch.trim()) {
    // The stamp IS the whole tick here, so its result is the tick's result. Swallowing
    // it and claiming progress anyway would re-process this session every BETWEEN_MS -
    // four loopback reads a pass against the daemon's single synchronous handle, which
    // also serves hook ingest and SSE - for as long as the write stays broken.
    if (!(await retirePromptedEpisode(client, session, candidate.goal))) return false;
    log(`${session.name}: prompted wrap-up held - the session changed nothing`);
    return true;
  }

  const window = await client.transcript(session.id).catch(() => null);
  if (!window || window.unavailable) {
    log(`${session.name}: prompted wrap-up held - could not read the transcript`);
    return false;
  }

  const standards = await client
    .standards(session.id, changedPaths(diff.patch))
    .catch(() => ({ docs: [], truncated: false }));

  // The SAME verifier the queue uses, deliberately. "Did this diff satisfy this ask?"
  // is one question, and a second prompt for it would be a second thing to keep true.
  const result = await verifyItem({
    session: { name: session.name, cwd: session.cwd, gitBranch: session.gitBranch },
    intent: candidate.goal,
    round: 0,
    diff: diff.patch,
    diffTruncated: diff.truncated,
    // Always true here: with no per-item base sha the diff is the whole branch, which
    // may well carry work from before this prompt. Telling the verifier so is what
    // stops it crediting - or blaming - this ask for someone else's commits.
    diffMayIncludeOtherWork: true,
    transcript: window.messages,
    transcriptTruncated: window.truncated,
    standards: standards.docs,
    standardsTruncated: standards.truncated,
    priorGaps: [],
  });
  if (result.kind === "failed") {
    // Unlike the queue there is no item to escalate, but the failure is bounded the
    // same way and for the same reason - see `PromptedFailureTracker`. Under the cap
    // the episode stays armed and retries next tick; at the cap Foreman gives up on it,
    // and only a new human prompt (which moves the goal, resetting the strikes) re-arms
    // it. Retired durably as well, so the give-up survives a worker restart; the
    // in-memory count is what holds the line when that write is the thing that's broken.
    const failures = promptedFailures.onFailure(session.id, candidate.goal);
    if (failures >= VERIFY_FAILURE_CAP) {
      await retirePromptedEpisode(client, session, candidate.goal);
      log(
        `${session.name}: prompted wrap-up gave up - verify failed ${failures}x (${result.reason})`,
      );
      return false;
    }
    log(`${session.name}: prompted wrap-up held - verify failed (${result.reason})`);
    // NOT `advanced`: nothing was written and nothing changed. Reporting a failed tick
    // as progress makes the loop skip its IDLE_MS sleep and re-select this same session
    // on the very next pass - the episode is still armed, since `promptedGoal` was
    // deliberately not stamped - turning a broken verifier into a hot loop of model
    // calls separated only by BETWEEN_MS.
    return false;
  }
  const plan = planPromptedWrapup(
    candidate.goal,
    result.verdict,
    pcfg,
    foremanMayActLive(cfg, session.cwd, session.repoRoot),
  );

  // Retire the episode FIRST - before anything types - for the reason in the header.
  // A failed stamp aborts: proceeding would be typing an instruction that pushes with
  // nothing recording that we did, so the next tick would do it again. It also aborts
  // as NOT advanced, and counts a strike: nothing was written, and the episode is still
  // armed, so claiming progress would spend a full evidence gather plus a `claude -p`
  // per BETWEEN_MS against a session whose only broken part is one endpoint.
  if (!(await retirePromptedEpisode(client, session, plan.goal))) return false;

  if (plan.kind === "hold") {
    log(`${session.name}: prompted wrap-up held - ${oneLine(plan.why)}`);
    return true;
  }

  if (plan.kind === "ask-wrapup") {
    // Raising the card IS the whole action here, so a failure to raise it is a dropped
    // question, not a cosmetic miss: the episode is already retired, so nothing will ask
    // again. Say so at the same volume as a failed send rather than swallowing it.
    //
    // `clearAnswer` because the card renders on `wrapupAskedAt !== null && wrapupAnswer
    // === null`, and this row's answer belongs to a PREVIOUS episode - a prior prompted
    // auto-send, or a human's earlier drain answer. Left in place it swallows this ask
    // silently, which is the same dropped question by a quieter route. A new episode is
    // by definition a new question, so the answer to the old one is stale; it is cleared
    // in the SAME write that stamps the ask, so no read can see one without the other.
    try {
      await client.markWrapupAsked(session.id, { clearAnswer: true });
      log(`${session.name}: prompted work looks complete - asked about wrapping up`);
    } catch (err) {
      log(`${session.name}: prompted work looks complete but the ask could not be raised (${String(err)})`);
    }
    return true;
  }

  try {
    await client.inject(session.id, plan.payload);
  } catch (err) {
    // Never retry: a retry IS the double-push. Fall back to the card, which is exactly
    // `ask` mode and puts this same text one click away.
    log(`${session.name}: could not send the prompted wrap-up (${String(err)}) - asking instead`);
    await client.markWrapupAsked(session.id, { clearAnswer: true }).catch(() => {});
    return true;
  }

  // Record WHAT was sent, but deliberately NOT `wrapupAskedAt`.
  //
  // The card renders on `wrapupAskedAt !== null && wrapupAnswer === null`, so stamping
  // the ask here would open a window - however brief, and unbounded if the write below
  // fails - in which the card offers to send an instruction the agent has already been
  // given. On the drain path that window is accepted because `wrapupAskedAt` is also
  // that trigger's once-only guard and has to be written. This trigger's guard is
  // `promptedGoal`, already stamped above, so there is nothing forcing the same
  // trade-off: leaving the ask unstamped means no card can ever double-offer.
  await client.setWrapupAnswer(session.id, plan.payload).catch(() => {});
  log(`${session.name}: prompted work complete - sent "${plan.payload}"`);
  return true;
}

/** What triage needs to know about the item Foreman commissioned, if any. */
function queueItemContext(item: WorkItem | null): ReviewInput["queueItem"] {
  if (!item) return undefined;
  return {
    intent: item.intent,
    round: item.round,
    openGaps: item.gaps.filter((g) => g.severity === "blocking").map((g) => g.detail),
  };
}

/** The daemon surface the apply layer needs, bound to this client. */
function queueActions(client: ForemanClient, _cfg: ForemanConfig): QueueActions {
  return {
    sessions: () => client.sessions(),
    getConfig: () => client.getConfig(),
    queue: (id) => client.queue(id),
    setItemState: (sid, iid, patch) => client.setItemState(sid, iid, patch),
    inject: (id, text) => client.inject(id, text),
    markSent: (sid, iid, sha, anchor) => client.markSent(sid, iid, sha, anchor),
    recoverItem: (sid, iid) => client.recoverItem(sid, iid),
    markWrapupAsked: (id) => client.markWrapupAsked(id),
    setWrapupAnswer: (id, answer) => client.setWrapupAnswer(id, answer),
    captureScope: (s) => captureScope(client, s),
    holdsLease: () => isLeader,
  };
}

/**
 * The item's scope at delivery: HEAD now (so the diff shows only what THIS item
 * changes) and the transcript's current byte size (so the verify window starts
 * exactly at this item's first turn).
 */
async function captureScope(
  client: ForemanClient,
  session: Session,
): Promise<{ baseSha: string | null; transcriptAnchor: number | null }> {
  const [diff, size] = await Promise.all([
    client.diff(session.id).catch(() => null),
    client.transcriptSize(session.id).catch(() => null),
  ]);
  return { baseSha: diff?.headSha ?? null, transcriptAnchor: size };
}

/**
 * Verify one item: gather the evidence, ask a fresh tool-less reviewer, then apply
 * the plan. Read-only - it runs in ANY mode, so a dry-run shows real judgment
 * before Foreman ever types.
 *
 * The reviewer is tool-less (it cannot read the repo), so the worker gathers
 * everything it will see. That is a feature, not a limitation: the prompt embeds
 * untrusted repo content, and a tool-enabled reviewer would be steerable by it.
 */
async function runVerify(
  client: ForemanClient,
  cfg: ForemanConfig,
  session: Session,
  item: WorkItem,
  queue: SessionQueue,
  qcfg: QueueConfig,
): Promise<void> {
  await client
    .setItemState(session.id, item.id, { state: "verifying" })
    .catch(() => {});

  // --- evidence, and the two ways gathering it can fail HONESTLY ---

  const diff = await client.diff(session.id, item.baseSha).catch(() => null);
  if (!diff) return void (await failVerify(client, session, item, qcfg, "could not read the diff"));

  // ANY failed diff is verify-INFRASTRUCTURE broken, and must never reach the
  // verifier. `SessionDiff.patch` is a non-optional string that defaults to "" on
  // failure, so falling through renders "(no changes were made)" and the verifier
  // dutifully invents gaps for work that may well be done - the fail-open behavior
  // the whole evidence-first design exists to eliminate. Gating this on
  // `item.baseSha` left that door open for an item whose scope capture found no
  // HEAD (no cwd, or not a git repo): failed diff, null base, straight through.
  //
  // Retry-then-escalate rather than escalate-on-sight: a diff can fail transiently
  // (a concurrent index.lock, a busy worktree), and failVerify is exactly the
  // "retry a few times, then hand it to the human" shape that fits. A genuinely
  // unreachable base is not transient, so it just spends the three attempts and
  // escalates - with its own wording, since "the base commit is gone" is the one
  // cause a human can act on.
  if (!diff.ok) {
    const why = item.baseSha
      ? `${diff.error ?? "the base commit is gone"} - verify this item by hand`
      : diff.error ?? "could not read the diff";
    return void (await failVerify(client, session, item, qcfg, why));
  }

  const anchor = item.transcriptAnchor;
  const window =
    anchor !== null
      ? await client.transcriptSince(session.id, anchor).catch(() => null)
      : await client.transcript(session.id).catch(() => null);
  // `unavailable` is a 200, not a throw: the route answers "I couldn't resolve a
  // transcript path" with an EMPTY window rather than an error. It is the same
  // verify-infrastructure failure as `!window` and must be treated as one - left to
  // fall through it renders "(no transcript turns for this item)", the verifier
  // finds no evidence the work was done, and its invented gaps get typed back into
  // an agent that may well have finished. Triage already routes up on this flag
  // (see triage.ts's `no-transcript-file`); this is the same fact, same answer.
  if (!window || window.unavailable) {
    return void (await failVerify(client, session, item, qcfg, "could not read the transcript"));
  }

  // The file is now SHORTER than the anchor: the transcript was reset (a `/clear`),
  // so the anchor is meaningless. Judging the item against a near-empty window
  // would invent gaps for work that may well be done.
  if (window.reset) {
    await client.setItemState(session.id, item.id, {
      state: "escalated",
      escalationReason:
        "this session's transcript was cleared, so Foreman can't see what was done - verify by hand",
    });
    log(`${session.name}: transcript reset under the item's anchor; escalated`);
    return;
  }

  const standards = await client
    .standards(session.id, changedPaths(diff.patch))
    .catch(() => ({ docs: [], truncated: false }));

  const result = await verifyItem({
    session: { name: session.name, cwd: session.cwd, gitBranch: session.gitBranch },
    intent: item.intent,
    round: item.round,
    diff: diff.patch,
    diffTruncated: diff.truncated,
    // The diff is cumulative whenever the agent doesn't commit, so an earlier item
    // delivered at this same base has its uncommitted work in here too.
    diffMayIncludeOtherWork: diffMayIncludeOtherWork(item, queue.items),
    transcript: window.messages,
    transcriptTruncated: window.truncated,
    standards: standards.docs,
    standardsTruncated: standards.truncated,
    priorGaps: item.gaps,
  });

  if (result.kind === "failed") {
    return void (await failVerify(client, session, item, qcfg, result.reason));
  }

  // A verdict the machine can't act on is the same event as a reviewer that never
  // produced one, so it takes the same retry-then-escalate path rather than a second
  // one of its own.
  const outcome = planFromVerify(
    item,
    result.verdict,
    foremanMayActLive(cfg, session.cwd, session.repoRoot),
    qcfg,
  );
  if (outcome.kind === "failed") {
    return void (await failVerify(client, session, item, qcfg, outcome.reason));
  }
  const plan = outcome.plan;
  await client.setItemState(session.id, item.id, {
    state: plan.state,
    round: plan.round,
    gaps: plan.gaps,
    escalationReason: plan.escalationReason,
    lastVerdict: plan.lastVerdict,
    // The draft lands in the SAME write as the state it belongs to, so the item is
    // never `proposed` with no text under it - the window in which Approve would
    // consent to a prompt the human never saw.
    proposedPayload: plan.proposedPayload,
    // A verdict is evidence about the work, so it clears the transient-failure
    // count - the same "onSuccess" shape ReviewFailureTracker uses.
    verifyFailures: 0,
  });
  log(
    `${session.name}: verified "${oneLine(item.intent)}" -> ${plan.state}` +
      (plan.state === "queued" || plan.state === "proposed" ? ` (round ${plan.round})` : ""),
  );
}

/**
 * A transient verify failure (spawn/timeout/parse-miss). Under the cap the item
 * goes back to `in_progress` to retry next tick; at the cap it escalates.
 *
 * The count is DURABLE, deliberately diverging from ReviewFailureTracker's
 * in-memory design. That tracker can live in memory because marker churn naturally
 * resets and bounds it; the queue has no marker churn, so an item in `verifying`
 * with a broken `claude` binary plus a crash-looping worker would reset the count
 * every restart and respawn forever. And a round is never consumed by a transient
 * failure, so maxFixRounds does not bound it either. Comment kept prominent
 * because someone will otherwise "fix" this back to in-memory.
 */
async function failVerify(
  client: ForemanClient,
  session: Session,
  item: WorkItem,
  qcfg: QueueConfig,
  reason: string,
): Promise<void> {
  const failures = item.verifyFailures + 1;
  if (failures >= VERIFY_FAILURE_CAP) {
    await client
      .setItemState(session.id, item.id, {
        state: "escalated",
        verifyFailures: failures,
        escalationReason: `Foreman could not verify this item (${failures} attempts): ${reason}`,
      })
      .catch(() => {});
    log(`${session.name}: verify failed ${failures}x; escalated (${reason})`);
    return;
  }
  await client
    .setItemState(session.id, item.id, { state: "in_progress", verifyFailures: failures })
    .catch(() => {});
  log(`${session.name}: verify failed, will retry (${reason})`);
}

/** The repo-relative paths a unified diff touches - what standards docs apply. */
function changedPaths(patch: string): string[] {
  const out = new Set<string>();
  for (const m of patch.matchAll(/^\+\+\+ b\/(.+)$/gm)) {
    const p = m[1]?.trim();
    if (p && p !== "/dev/null") out.add(p);
  }
  return [...out];
}

/** Collapse whitespace and cap a string to one short line for a log. */
function oneLine(s: string, max = 60): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Review + act on one session, unless we've already handled its current prompt.
 *
 * Returns whether it did any work. A session that stays `needs-you` after Foreman
 * has escalated it to the human remains a target forever, so "already handled" and
 * "debounced" are exactly the states the loop must not hurry back for.
 */
async function processSession(
  client: ForemanClient,
  cfg: ForemanConfig,
  session: Session,
  reviews: ReviewItem[],
  queueItem?: ReviewInput["queueItem"],
): Promise<boolean> {
  const pending = classifyPending(session, reviews);

  // Idempotency: don't re-handle a prompt whose marker we've already stamped.
  const existing = await client.note(session.id).catch(() => null);
  if (existing?.handledMarker === pending.marker) return false;

  // Debounce: the check above skips an UNCHANGED episode for free, but a *changed*
  // marker (a new review, or a terminal whose `lastActivity` moved) would otherwise
  // spawn a full review immediately. Hold each session to at most one evaluation per
  // window so a flapping marker can't burn a `claude -p` on every loop; a session seen
  // for the first time is due at once, so genuinely new work is never delayed.
  if (!evaluations.claim(session.id)) return false;

  // ONE read of the child's screen, shared by the reviewer's prompt and by the check on
  // what it answers. Captured here rather than inside the review so those two cannot
  // disagree: the model must be judged against the same rows it was shown, or a menu that
  // repainted between two captures would have us validating an answer to a question the
  // model never saw. It also has to precede `decide`, because the CHEAP tier can answer an
  // access prompt too, and a menu it answered in prose must be caught by the same gate.
  const pane = await paneFor(client, session, pending);
  const ctx: ReviewContext = {
    sessionId: session.id,
    promptMarker: pending.marker,
    inputReviewId: pending.inputReviewId,
    canSend: pending.canSend,
    // Read off the pending classification, not re-derived from the session: the two
    // would be answering the same question from the same object, and the one that
    // drifted would file replies against the wrong gate.
    gate: pending.gate ?? null,
    // What "answering" means on this surface: a menu is selected, not typed at.
    menu: parsePaneDialog(pane),
  };

  // Resolve the verdict through the tier ladder (off / shadow / on). A null here means
  // the outcome was already handled - a transient review failure that will retry, or a
  // give-up note that was already written - so there's nothing left to apply. That still
  // counts as work: a `claude -p` was spawned, so the loop must not hurry back.
  const decision = await decide(client, cfg, session, pending, ctx, pane, queueItem);
  if (!decision) return true;
  const { verdict, tier } = decision;

  let plan = planFromVerdict(
    verdict,
    ctx,
    foremanMayActLive(cfg, session.cwd, session.repoRoot),
    cfg.autoApproveAccess,
  );

  // The review may have spawned a fresh `claude -p` that ran for up to two minutes, so
  // both the session snapshot and the config are stale by the time we're ready to act.
  // Before a LIVE send, re-confirm against a fresh session list that this session still
  // needs *this* exact prompt; if the human already handled it (answered, left
  // needs-you, or a newer prompt arrived), skip the send but still record the
  // purpose. Then re-plan from a fresh config so every "toggle stops acting" switch
  // - disable, leaving live mode, dropping the repo from the allowlist, or turning
  // off access auto-approval - is honoured even for an in-flight review. Re-planning
  // (not just re-checking mayActLive) makes autoApproveAccess=false downgrade a live
  // access approval to an escalation mid-review. This applies identically whether the
  // verdict came from Tier 1 or the full Tier 2 review.
  if (plan.send) {
    if (!(await sendStillValid(client, session.id, pending))) {
      await client
        .putNote(session.id, { purpose: verdict.purpose, disposition: "skipped" })
        .catch(() => {});
      // Record it anyway, even though nothing was sent. This return is the one exit
      // from `processSession` that reaches a decision and writes no episode, and the
      // pane captured above is the ONLY copy of a terminal ask - so leaving without it
      // is exactly the loss the table was built to prevent, on a path where the note
      // says "left for you" and the drawer would then have no matching entry to open.
      //
      // `send: null` because nothing reached the child, which leaves `sentText` and
      // `sentBy` null through `episodeFromPlan`: a stale send is a decision that
      // delivered nothing, and attributing one to it would be a lie in the record.
      await client
        .recordEpisode(
          session.id,
          episodeFromPlan({
            pending,
            ctx,
            pane,
            verdict,
            tier,
            plan: {
              note: {
                ...plan.note,
                disposition: "skipped",
                lastAction: "left for you (the session moved on during review)",
              },
              send: null,
            },
          }),
        )
        .catch(() => {});
      log(`${session.name}: skipped stale send (session changed during review)`);
      return true;
    }
    const freshCfg = await client.getConfig().catch(() => null);
    plan = planFromVerdict(
      verdict,
      ctx,
      !!freshCfg && foremanMayActLive(freshCfg, session.cwd, session.repoRoot),
      (freshCfg ?? cfg).autoApproveAccess,
    );
    if (!plan.send) {
      log(`${session.name}: config changed during review; drafting instead of sending`);
    }
  }

  await applyVerdict(client, ctx, plan);

  // Record what this decision WAS, now that we know how it ended.
  //
  // After `applyVerdict`, not before, for two reasons that point the same way. A send
  // that fails throws out of it, so nothing is recorded for a reply that never landed
  // - matching the note, which is also left unstamped there. And `plan.send` is only
  // truthful about what reached the child once it has been executed.
  //
  // This is the only place the pane is durable. It was captured at the top of this
  // function for the reviewer, and for a terminal ask it is the ONLY copy of the
  // question in existence - a blocked tool call is not yet a transcript turn (see
  // `prompt.ts`), so a tick that ends without writing it here loses that question for
  // good. Everything else here could be reconstructed later; that cannot.
  await client.recordEpisode(
    session.id,
    episodeFromPlan({ pending, ctx, pane, verdict, tier, plan }),
  );

  log(
    `${session.name}: [tier ${tier}] ${verdict.action}/${verdict.classification} -> ${plan.note.disposition}` +
      (plan.send ? " (sent)" : ""),
  );
  return true;
}

/**
 * The verdict for one session + which tier produced it, or null when the outcome was already
 * fully handled (a transient failure that will retry, or a give-up note that was written).
 */
type Decision = { verdict: Verdict; tier: 0 | 1 | 2 } | null;

/**
 * Resolve a verdict for one session through the tier ladder, honouring the `triage` config.
 *
 * The posture is resolved by `triagePosture`, never by falling through: `on` is the only
 * posture where Tier 1's verdicts are APPLIED rather than merely logged, so it must be
 * reachable only by an exact match, and a missing or unrecognised value must land on a safe
 * posture. Switching exhaustively over the three known postures keeps it that way - it also
 * means adding a fourth is a compile error here rather than a silent new path into `on`.
 */
async function decide(
  client: ForemanClient,
  cfg: ForemanConfig,
  session: Session,
  pending: Pending,
  ctx: ReviewContext,
  /** The child's screen, captured once by the caller - see `processSession`. */
  pane: string | null,
  queueItem?: ReviewInput["queueItem"],
): Promise<Decision> {
  switch (triagePosture(cfg.triage)) {
    case "off":
      return fullReviewOnly(client, session, pending, ctx, pane, queueItem);
    case "shadow":
      return shadowBoth(client, cfg, session, pending, ctx, pane, queueItem);
    case "on":
      return cheapTierDecides(client, cfg, session, pending, ctx, pane, queueItem);
  }
}

/** `off`: the pre-triage behaviour - every new marker gets a full review. */
async function fullReviewOnly(
  client: ForemanClient,
  session: Session,
  pending: Pending,
  ctx: ReviewContext,
  /** The child's screen, captured once by the caller - see `processSession`. */
  pane: string | null,
  queueItem?: ReviewInput["queueItem"],
): Promise<Decision> {
  const r = await fullReview(client, session, pending, ctx, pane, queueItem);
  return r && { verdict: r.verdict, tier: 2 };
}

/**
 * `shadow`: run the cheap tier AND the full review, act on the full review, and log the
 * divergence. Concurrent, so the cheap call adds no serial latency to the queue.
 */
async function shadowBoth(
  client: ForemanClient,
  cfg: ForemanConfig,
  session: Session,
  pending: Pending,
  ctx: ReviewContext,
  /** The child's screen, captured once by the caller - see `processSession`. */
  pane: string | null,
  queueItem?: ReviewInput["queueItem"],
): Promise<Decision> {
  const [cheap, r] = await Promise.all([
    triageSession(triageDeps(client), pending, session, cfg, pane),
    fullReview(client, session, pending, ctx, pane, queueItem),
  ]);
  if (!r) return null; // full review failed + handled; don't act on the cheap tier
  log(
    `${session.name}: shadow ${classifyDivergence(cheap, r.verdict)} ` +
      `(cheap=${describeCheap(cheap)} opus=${r.verdict.action}/${r.verdict.classification})`,
  );
  return { verdict: r.verdict, tier: 2 };
}

/** `on`: the cheap tier decides; the full review fires only on route-up. */
async function cheapTierDecides(
  client: ForemanClient,
  cfg: ForemanConfig,
  session: Session,
  pending: Pending,
  ctx: ReviewContext,
  /** The child's screen, captured once by the caller - see `processSession`. */
  pane: string | null,
  queueItem?: ReviewInput["queueItem"],
): Promise<Decision> {
  const cheap = await triageSession(triageDeps(client), pending, session, cfg, pane);
  if (cheap.kind === "dispose" && !menuBlocksAnswer(cheap.verdict, ctx)) {
    log(`${session.name}: tier ${cheap.tier} disposed -> ${cheap.verdict.action} (${cheap.reason})`);
    return { verdict: cheap.verdict, tier: cheap.tier };
  }
  // A dispose this tier can't DELIVER is not a decision, it's a route-up. The router names no
  // row (its schema has no field for one), so on a menu every answer it reaches lands here -
  // and a menu is what a permission prompt is. Handing it to the full reviewer, which can name
  // a row, keeps the ask automated; treating it as final would escalate every routine approval
  // to a human when the tier is `on`. If the full review can't name a row either, `planFromVerdict`
  // escalates it there - the fallback stays, it just stops being the first stop.
  const why = cheap.kind === "route-up" ? cheap.reason : "menu-needs-a-row";
  log(`${session.name}: routed up to full review (${why})`);
  return fullReviewOnly(client, session, pending, ctx, pane, queueItem);
}

/**
 * The full Tier 2 review: a fresh `claude -p` on the wide (48-turn) window with the
 * whole POLICY. Returns the verdict, or null when a transient failure was handled -
 * either a retry (nothing written, left queued) or, after repeated strikes, a
 * marker-stamped give-up skip so a persistently-broken reviewer stops re-spawning.
 */
async function fullReview(
  client: ForemanClient,
  session: Session,
  pending: Pending,
  ctx: ReviewContext,
  /** The child's screen, captured once by the caller - see `processSession`. */
  pane: string | null,
  queueItem?: ReviewInput["queueItem"],
): Promise<{ verdict: Verdict } | null> {
  const window = await client
    .transcript(session.id)
    .catch(() => ({ messages: [], truncated: false }));
  const input: ReviewInput = {
    session: {
      name: session.name,
      cwd: session.cwd,
      gitBranch: session.gitBranch,
      state: session.state,
      activity: session.activity,
      // Read, never re-derived: the daemon refreshes this on every prompt, while a review
      // only happens when the session is STUCK.
      goal: session.goal?.text ?? null,
    },
    surface: pending.surface,
    question: pending.question,
    transcript: window.messages,
    truncated: window.truncated,
    // The section the reviewer reads the actual ask from - see `ReviewInput.pane`.
    pane,
    // Without this the two subsystems actively fight: the reviewer can answer "no,
    // don't do that" to a question about the very item Foreman commissioned, or
    // escalate something it could have answered trivially had it known the intent.
    queueItem,
  };

  const result = await reviewSession(input);
  if (result.kind === "failed") {
    // A transient reviewer failure (spawn/timeout/parse-miss) must NOT stamp the
    // marker, or the idempotency check would abandon this prompt forever after a
    // single blip. Leave it queued to retry; only after several consecutive failures
    // do we give up with a marker-stamped skip so a persistently-broken reviewer stops
    // re-spawning `claude -p` every loop.
    const outcome = reviewFailures.onFailure(ctx, result.reason);
    if (outcome.retry) {
      log(`${session.name}: review failed, will retry (${result.reason})`);
      return null;
    }
    await client.putNote(session.id, outcome.note).catch(() => {});
    log(`${session.name}: review failed repeatedly; giving up (skipped)`);
    return null;
  }
  reviewFailures.onSuccess(session.id);
  return { verdict: result.verdict };
}

/** Adapt the daemon client to the cheap tier's read-only dependency surface. */
function triageDeps(client: ForemanClient): TriageDeps {
  return {
    transcript: (id, turns) => client.transcript(id, turns),
    runModel: (prompt, model) => runClaudeText(prompt, { model, timeoutMs: TRIAGE_TIMEOUT_MS }),
  };
}

/**
 * The child's screen for a review, or null when the surface can't have one.
 *
 * Scoped to the `terminal` surface because an `input-review` already carries its full body as
 * `Pending.question` - there is nothing on the screen the reviewer doesn't have, so capturing
 * it would spend a subprocess to learn nothing. A terminal session with no pane simply reads
 * back null (`capturePaneText` has no handle to use), so `terminal-no-pane` needs no case of
 * its own here.
 *
 * Called ONCE per session, by `processSession`, and the result is threaded down to whichever
 * tier ends up reviewing. It used to be captured inside the review, concurrently with the
 * transcript; that concurrency is gone on purpose, because the screen now decides how an
 * answer is DELIVERED (a menu is selected, not typed at) and not merely what the model reads.
 * Two captures would be two different screens, and the reviewer would be judged against rows
 * it was never shown.
 */
function paneFor(
  client: ForemanClient,
  session: Session,
  pending: Pending,
): Promise<string | null> {
  return pending.surface === "terminal" ? client.pane(session.id) : Promise.resolve(null);
}

/**
 * One-line description of a cheap-tier outcome, for the shadow-divergence log. The reason
 * is the point: shadow mode exists to measure the cheap tier before `on` is flipped, and
 * without it every route-up reads alike - a router that never spawns (`tier1-failed`) is
 * indistinguishable from one deferring on genuine judgment (`needs-judgment`).
 */
function describeCheap(cheap: TriageOutcome): string {
  return cheap.kind === "route-up"
    ? `route-up(${cheap.reason})`
    : `tier${cheap.tier}:${cheap.verdict.action}(${cheap.reason})`;
}

/**
 * Re-confirm, immediately before a live send, that the session still needs this
 * exact prompt. A fresh session list + reviews snapshot guards the send against a queue
 * that moved while the (slow) review ran. Returns false (skip the send) if the
 * session left needs-you, a newer prompt arrived, the marker is already handled,
 * or the re-check itself failed - reads are cheap, so we only guard the send path.
 */
async function sendStillValid(
  client: ForemanClient,
  sessionId: string,
  pending: Pending,
): Promise<boolean> {
  try {
    const [sessions, reviews] = await Promise.all([client.sessions(), client.reviews()]);
    const fresh = sessions.find((s) => s.id === sessionId);
    if (!fresh || reportBucket(fresh, sessions) !== "needs-you") return false;
    if (classifyPending(fresh, reviews).marker !== pending.marker) return false;
    const note = await client.note(sessionId).catch(() => null);
    if (note?.handledMarker === pending.marker) return false;
    return true;
  } catch {
    return false;
  }
}

function log(msg: string): void {
  console.log(`[foreman] ${msg}`);
}

main().catch((err) => {
  console.error("[foreman] fatal:", err);
  process.exit(1);
});
