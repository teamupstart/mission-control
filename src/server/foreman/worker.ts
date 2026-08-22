import { randomUUID } from "node:crypto";
import type { ForemanConfig, PromptedCompletionDisposition } from "@shared/protocol.ts";
import {
  PROMPTED_DECISION_GAPS_MAX,
  PROMPTED_DECISION_GAP_DETAIL_MAX,
  PROMPTED_DECISION_GAP_ID_MAX,
  PROMPTED_DECISION_GAP_PATH_MAX,
  PROMPTED_DECISION_SUMMARY_MAX,
} from "@shared/protocol.ts";
import { taskCompletionContract } from "@shared/task-completion.ts";
import type {
  AgentType,
  PromptedCompletionGap,
  PromptedDirectHandoffKind,
  ReviewItem,
  Session,
  SessionQueue,
  WorkItem,
} from "@shared/types.ts";
import { activePaneDialog, reportBucket } from "@shared/session.ts";
import {
  ForemanClient,
  foremanClaudeTransportFallback,
  foremanCodexTransportFallback,
  flushPendingSpend,
  loadSpendOutbox,
  sweepSpendOutbox,
} from "./client.ts";
import { setLlmSpendSink } from "../llm/spend.ts";
import { reviewModel, reviewSession } from "./review.ts";
import { EvaluationDebounce } from "../util/debounce.ts";
import { classifyPending } from "./pending.ts";
import type { Pending } from "./pending.ts";
import { parsePaneDialog } from "../discovery/pane-dialog.ts";
import type { PaneDialog } from "../discovery/pane-dialog.ts";
import { dialogSpecFor } from "../harness/index.ts";
import { foremanTriageAuthorized } from "./authorization.ts";
import type { CapturedInputs, ReviewInput } from "./prompt.ts";
import {
  applyVerdict,
  episodeFromPlan,
  foremanMayActLive,
  menuBlocksAnswer,
  planFromVerdict,
  planLeavesAMark,
  ReviewFailureTracker,
} from "./verdict.ts";
import type { ReviewContext, Verdict } from "./verdict.ts";
import { cheapActionOf, classifyDivergence, triagePosture, triageSession } from "./triage.ts";
import type { TriageDeps, TriageOutcome } from "./triage.ts";
import type { CheapAction, Divergence } from "@shared/foreman.ts";
import { resolvedSessionIntent, sessionIntentMatches } from "@shared/goal.ts";
import {
  VERIFY_FAILURE_CAP,
  decideQueueTick,
  diffMayIncludeOtherWork,
  inFlightItem,
  planFromVerify,
  tickTargets,
} from "./queue-machine.ts";
import type { QueueConfig, QueueVerdict } from "./queue-machine.ts";
import {
  PromptedFailureTracker,
  decidePromptedWrapup,
  planPromptedWrapup,
} from "./prompted-wrapup.ts";
import type { PromptedCandidate, PromptedConfig } from "./prompted-wrapup.ts";
import {
  InjectError,
  applyQueueAction,
  noteKeyOf,
  paneKeyOf,
  resolveLiveSession,
} from "./queue-apply.ts";
import type { QueueActions } from "./queue-apply.ts";
import {
  activeWorkflowOwnsSession,
  advanceFollowupMark,
  decideReviewFollowup,
  followupPrs,
} from "./review-followup.ts";
import type { FollowupMark, FollowupPr } from "./review-followup.ts";
import { PLAN_FAILURE_CAP, assignRefusalParksSession, decideBacklogTick } from "./backlog-machine.ts";
import type { BacklogConfig } from "./backlog-machine.ts";
import { backlogModel, planBacklog } from "./backlog-plan.ts";
import { BacklogPlannerCircuit } from "./planner-circuit.ts";
import { verifyItem, verifyModel } from "./queue-verify.ts";
import type { StandardsBundle } from "../standards.ts";
import { DEFAULT_LLM_RUNNER_ID, llmRunner } from "../llm/index.ts";
import { configureClaudeRunnerTransport } from "../llm/claude.ts";
import { configureCodexRunnerTransport } from "../llm/codex.ts";
import type { ClaudeTransport, CodexTransport, LlmRunnerId } from "@shared/llm.ts";
import { installForemanShutdown } from "./shutdown.ts";
import {
  drainCompletionClaim,
  promptedCompletionClaim,
  tryWorkflowCompletionClaim,
} from "./workflow-claim.ts";
import { automaticWrapupBlock } from "./wrapup-eligibility.ts";
import { runPipelineTriage } from "./pipeline-triage.ts";

/**
 * The menu on a pane, read with that agent's own grammar - or null when this harness draws
 * none we can read.
 *
 * Null and "no menu on screen" collapse deliberately: the reviewer's fallback for both is
 * to answer in prose rather than by selecting a row, which is the correct behaviour for a
 * screen we cannot navigate. What must not happen is a Codex pane being read with Claude's
 * cursor glyph, or skipped for being Codex when its rows are perfectly legible.
 */
function dialogMenu(agent: AgentType, pane: string | null): PaneDialog | null {
  const spec = dialogSpecFor(agent);
  return spec ? parsePaneDialog(pane, spec) : null;
}

/**
 * The ask this session is parked on, whichever way it got here - the ONE object every tier
 * is shown and every answer is checked against.
 *
 * Keyed on where the dialog CAME FROM, never on the session's runtime or its agent. A
 * driver reports its request as data and the registry has already put it on the session, so
 * re-reading a screen for it would be asking a question that has an authoritative answer; a
 * pane's menu exists nowhere but the capture, so it has to be parsed. Reading the session's
 * field first is also what makes this correct for a session with BOTH (there is none today,
 * and if one arrives the structured ask is the one with a correlation id to answer against).
 *
 * Getting this wrong is silent in the expensive direction: `ctx.menu` null for a driver
 * session means `planFromVerdict` sees no ask, so a verdict naming an option is delivered as
 * TYPED PROSE - a new turn the agent reads while still blocked on the request nobody
 * answered.
 */
function askOnScreen(session: Session, pane: string | null): PaneDialog | null {
  const reported = activePaneDialog(session);
  if (reported?.source === "driver") return reported;
  return dialogMenu(session.agent, pane);
}

// The Foreman worker: a standalone loop (run via `npm run foreman`) that drains
// the sessions' needs-you queue AND feeds each session's work queue, one session at
// a time, reviewing each in a FRESH tool-less model call so context never bleeds
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
 * How often to look for spend reports abandoned by an exited peer.
 *
 * A recovery interval, not a poll of anything live: what it finds belongs to runs that have
 * already finished and been paid for, so arriving half a minute late costs nothing, while
 * scanning on every pass of a loop that can spin at `BETWEEN_MS` would read the state
 * directory dozens of times a minute for no benefit.
 */
const SPEND_SWEEP_MS = 30_000;
let lastSpendSweepAt = 0;
/**
 * Minimum wall-clock gap between two full reviews of the *same* session. The marker
 * idempotency check already skips an unchanged episode for free; this floor stops a
 * session whose marker flaps (e.g. a terminal keyed on a moving `lastActivity`) from
 * starting a fresh model call every loop. Overridable for tests/tuning; default 60s.
 */
const EVAL_DEBOUNCE_MS = Number(process.env.FOREMAN_EVAL_DEBOUNCE_MS || 60_000);
/**
 * The Tier 1 router's own wall-clock cap, well under the full reviewer's 120s: this is Haiku
 * emitting one small object over a trimmed window, not Opus reading a 60-turn window (head
 * plus tail - see `client.transcript`) with the whole POLICY. The budgets must differ because `on` mode runs the two SERIALLY (the router, then the
 * full review on route-up), so sharing Tier 2's cap would let a degraded API double the serial
 * queue's worst case rather than fail fast. A timeout is just a provider failure to `triageSession`,
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
 * Consume one completed generation: the write that disarms the trigger, and the ONLY thing that clears
 * the strikes. Answers whether it landed, because every caller must abort on false - a
 * tick whose only write failed changed nothing, so reporting it as progress is what
 * makes the loop skip its IDLE_MS sleep and come straight back.
 */
async function consumePromptedCycle(
  client: ForemanClient,
  session: Session,
  candidate: Extract<PromptedCandidate, { kind: "check" | "retire" }>,
  /**
   * WHY this generation is being consumed. Required at every call site, because the
   * generation and its reason are one durable fact - see `SessionQueue.promptedDecision`.
   */
  decision: PromptedCompletionDisposition,
  opts?: { ask?: boolean; directHandoff?: PromptedDirectHandoffKind },
): Promise<boolean> {
  const expectedIntent = {
    objective: candidate.objective,
    objectiveVersion: candidate.objectiveVersion,
    promptRevision: candidate.promptRevision,
    episodeKey: candidate.episodeKey,
  };
  try {
    await client.consumePromptedGeneration(
      session.id,
      candidate.logicalKey,
      candidate.generation,
      expectedIntent,
      boundedDecision(decision),
      opts,
    );
    promptedFailures.onConsumed(candidate.logicalKey);
    return true;
  } catch (err) {
    const failures = promptedFailures.onFailure(candidate.logicalKey, candidate.generation);
    log(
      `${session.name}: prompted wrap-up aborted - could not consume generation ` +
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
 * The loop blocks on a model call for up to 2 * REVIEW_TIMEOUT_MS = 240s, so a
 * lease renewed only by loop progress would have to outlive that - and a
 * "comfortably longer than one tick" TTL would expire mid-verify, let a standby
 * acquire, and run both workers. A model call is async I/O, so the event loop is
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

async function main(): Promise<void> {
  const client = new ForemanClient();
  // The daemon installs the same runner with a DB-backed resolver. This separate process
  // must not import that config module, so its resolver closes over the HTTP-refreshed
  // value below instead. It is installed before any path can spend.
  configureClaudeRunnerTransport(() => claudeTransport);
  // And Codex's, for the same reason and at the same moment. A worker that installed only
  // Claude's would answer the operator's saved transport correctly on one provider and
  // silently ignore it on the other - which is worse than not offering the choice, because
  // the panel says the choice took.
  configureCodexRunnerTransport(() => codexTransport);
  // This process's half of usage accounting, installed before anything can spend. The
  // worker never opens the database, so its runs reach the ledger the way everything else
  // it does reaches it - over a route. `void` rather than await: the runner reports on the
  // way out of a call that has already produced its answer, and blocking a review on an
  // accounting POST would let a slow daemon slow the loop down.
  setLlmSpendSink((report) => void client.reportSpend(report));
  // Anything a previous worker spent but never managed to report - it crashed, or was
  // restarted while the daemon was down. This is the moment that spend either reaches the
  // ledger or is lost for good, so it happens before the loop rather than on the first
  // report of this process's own.
  const recovered = loadSpendOutbox();
  if (recovered > 0) {
    log(`recovered ${recovered} undelivered spend report(s) from a previous run`);
    void flushPendingSpend();
  }
  installForemanShutdown(client, WORKER_ID, log);
  startLeaseRenewal(client);
  log(`Foreman worker started (${WORKER_ID}); watching the needs-you queue + session work queues.`);

  for (;;) {
    // Recovery for a peer that died while THIS worker kept running. Startup adoption cannot
    // cover that: the abandoned spool would sit unreported until some future process
    // happened to boot, which on a machine whose worker simply stays up is never.
    //
    // The cadence is the worker's rather than the client's, because this loop spins as fast
    // as BETWEEN_MS when it is busy and a scan on every pass would read the state directory
    // dozens of times a minute for reports that are in no hurry - they belong to runs that
    // already finished. Placed before the config read so it still runs while the daemon is
    // unreachable, and not gated on leadership: a standby that outlives the leader is
    // exactly who should be carrying the leader's last reports.
    if (Date.now() - lastSpendSweepAt >= SPEND_SWEEP_MS) {
      lastSpendSweepAt = Date.now();
      sweepSpendOutbox();
    }
    let cfg;
    try {
      cfg = await client.getConfig();
    } catch (err) {
      log(`daemon unreachable (${String(err)}); retrying…`);
      await sleep(IDLE_MS);
      continue;
    }

    // Foreman's own runner pick wins, and only when it HAS one. An unset `runner` is not
    // "claude" - it means the operator never chose here, so the answer is the app-wide
    // ladder (config, then `MISSION_LLM_RUNNER`, then the default), which only the daemon
    // can resolve because only it can see the config layer. Defaulting to a literal here
    // silently drops the env layer for the one subsystem that runs in its own process.
    //
    // Kept on the last known answer when the daemon can't say, rather than reset to the
    // default: a blip must not silently move the cheap tier onto a provider the operator
    // did not pick, and the next pass asks again anyway.
    // The Claude transport has no Foreman-local override. It follows the daemon's resolved
    // app-wide answer so a Settings edit reaches both processes on the next pass. One status
    // request carries both facts, and a transient failure retains both last-known values.
    const llmSelection = await client.llmSelection().catch(() => null);
    triageRunnerId = cfg.runner ?? llmSelection?.runner ?? triageRunnerId;
    if (llmSelection) {
      claudeTransport = llmSelection.claudeTransport;
      codexTransport = llmSelection.codexTransport;
    }
    await syncBacklogPlanner(client, cfg, triageRunnerId);
    if (isLeader) await publishBacklogPlannerHealth(client);

    // Identity and retry control are observed even while disabled, above. That way a
    // provider/model edit retires the old circuit immediately and the next enable starts
    // with the promised probe instead of reviving stale strikes.
    if (!cfg.enabled) {
      await sleep(IDLE_MS);
      continue;
    }

    // A non-leader IDLES, it does not exit - so it takes over cleanly when the
    // leader's lease expires (a crash, a Ctrl-C), which is the whole point of an
    // expiring lease. The lease gates the WHOLE loop, including triage: two
    // workers double-answering a needs-you prompt is a real harm too, and
    // pendingStillLive narrows that window without closing it (both can pass the
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
    } finally {
      await publishBacklogPlannerHealth(client);
    }

    // A fleet-level loop over external engine halts. The Conductor switch is independent of
    // backlog autopilot, but the worker lease and Foreman's own master switch still gate it.
    try {
      if (await runPipelineTriage(client)) advanced = true;
    } catch (err) {
      log(`pipeline triage failed (${String(err)})`);
    }

    // Also fleet-level, and outside the "no targets" bail for the same reason: a session
    // whose PR needs following through has, by definition, parked - it is exactly the
    // quiet fleet this pass most needs to look at, and it is never a `tickTargets` pick.
    //
    // Returns the sessions it typed into, so the per-target loop below can leave them
    // alone THIS pass: `promptedWantsATick` keeps a prompted-armed idle session selected
    // forever (the card summary can't see it is already wrapped up), so a session can be
    // both a follow-through nudge here and a wrap-up target below - and typing both into
    // one pane in one pass is the double-send the whole worker is built to avoid. The
    // follow-up wins; next pass the session is working on it and the wrap-up correctly
    // stands down on its own.
    let nudgedThisPass = new Set<string>();
    try {
      nudgedThisPass = await runReviewFollowup(client, cfg);
      if (nudgedThisPass.size > 0) advanced = true;
    } catch (err) {
      log(`review follow-through failed (${String(err)})`);
    }

    if (targets.length === 0) {
      if (!advanced) await sleep(IDLE_MS);
      continue;
    }

    for (const session of targets) {
      // Skip a session the follow-through pass already typed into this pass - see
      // `nudgedThisPass`. Its wrap-up (if any) waits one pass rather than landing a second
      // instruction in the same pane.
      if (nudgedThisPass.has(session.id)) continue;
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
const backlogPlanner = new BacklogPlannerCircuit({
  failureCap: PLAN_FAILURE_CAP,
  retryMs: PLAN_RETRY_MS,
  storeBackoffMs: PLAN_STORE_BACKOFF_MS,
  storeBackoffMaxMs: PLAN_STORE_BACKOFF_MAX_MS,
});
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
/** Last operator retry signal observed from the daemon. */
let backlogRetryGeneration = 0;
/** Daemon instance that holds the last accepted health projection. */
let backlogProjectionEpoch = "";
/** Last health projection the daemon accepted, so a steady state costs no extra POSTs. */
let publishedPlannerHealth = "";
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

/** Resolve effective planner changes and process a manual retry signal once per worker. */
async function syncBacklogPlanner(
  client: ForemanClient,
  cfg: ForemanConfig,
  runner: LlmRunnerId,
): Promise<void> {
  const identity = { runner, model: backlogModel(cfg, runner) };
  const changed = backlogPlanner.setIdentity(identity);
  if (changed === "changed") {
    lastBacklogNote = "";
    log(`backlog: provider/model changed to ${identity.runner}/${identity.model}; probing now`);
  }

  const control = await client.plannerControl().catch(() => null);
  if (control && control.projectionEpoch !== backlogProjectionEpoch) {
    backlogProjectionEpoch = control.projectionEpoch;
    publishedPlannerHealth = "";
  }
  if (control && control.retryGeneration !== backlogRetryGeneration) {
    if (control.retryGeneration === 0) {
      backlogRetryGeneration = 0;
    } else if (control.retryClaimedBy === WORKER_ID) {
      // Also covers a lost claim response: the daemon's assignment is the durable fact
      // for this daemon/worker lifetime, and this process has not handled it locally yet.
      backlogRetryGeneration = control.retryGeneration;
      backlogPlanner.requestProbe();
      lastBacklogNote = "";
      log("backlog: operator requested an immediate dependency-planner retry");
    } else if (control.retryClaimedBy) {
      // A previous worker already consumed this generation. Remember it locally so a
      // worker-only restart cannot replay an old click forever.
      backlogRetryGeneration = control.retryGeneration;
    } else if (
      await client.claimPlannerRetry(WORKER_ID, control.retryGeneration).catch(() => false)
    ) {
      backlogRetryGeneration = control.retryGeneration;
      backlogPlanner.requestProbe();
      lastBacklogNote = "";
      log("backlog: operator requested an immediate dependency-planner retry");
    }
  }
}

/** Publish only changes, retrying a missed projection on the next ordinary worker pass. */
async function publishBacklogPlannerHealth(client: ForemanClient, now = Date.now()): Promise<void> {
  const health = backlogPlanner.health(now);
  if (!health) return;
  const serialized = JSON.stringify(health);
  if (serialized === publishedPlannerHealth) return;
  try {
    await client.reportPlannerHealth(WORKER_ID, health);
    publishedPlannerHealth = serialized;
  } catch {
    // Projection only. A down daemon already stops scheduling through the normal reads,
    // and the unchanged report is attempted again next pass.
  }
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

/** Log a backlog outcome only when it differs from the last one. */
function noteBacklog(msg: string): void {
  if (!msg || msg === lastBacklogNote) return;
  lastBacklogNote = msg;
  log(`backlog: ${msg}`);
}

/** Policy knobs from config; timings from the module constants, as the queue does. */
function backlogConfig(cfg: ForemanConfig): BacklogConfig {
  return {
    enabled: cfg.autoBacklog,
    maxSessions: cfg.maxSessions,
    allowlist: cfg.repoAllowlist,
    // The SAME gate the queue's sends and the auto-wrap-up clear. Launching an agent and
    // typing a task into someone's pane are both live acts; neither happens in dry-run.
    mayActLive: cfg.mode === "live",
    settleMs: SETTLE_MS,
    respectOpenPrs: cfg.backlogRespectOpenPrs,
    planExhausted: backlogPlanner.serial(),
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
  const [sessions, tasks, storedPlan] = snapshot;

  const now = Date.now();
  // Read before the re-arm starts its probe, so a plan that lands can say the degradation
  // ended rather than letting the in-flight recovery erase the transition worth announcing.
  const degradedBefore = backlogPlanner.health(now)?.state === "degraded";
  if (backlogPlanner.rearm(now)) {
    lastBacklogNote = "";
    log(
      `backlog: retrying the dependency read after ${Math.round(PLAN_RETRY_MS / 1000)}s ` +
        `of scheduling one at a time`,
    );
  }
  // A provider/model edit or operator retry must probe even when the old stored plan still
  // covers every task. Feeding null through the existing stale-plan decision is the narrow
  // way to request that read without adding a second scheduling path.
  const plan = backlogPlanner.shouldProbe() ? null : storedPlan;
  const action = decideBacklogTick({
    tasks,
    sessions,
    plan,
    cfg: backlogConfig(cfg),
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
    if (now < backlogPlanner.storeRetryAt()) {
      noteBacklog("waiting to retry the plan - the daemon refused the last write");
      return false;
    }
    const identity = backlogPlanner.health(now);
    if (!identity) return false;
    const result = await planBacklog(action.tasks, identity.model, identity.runner);
    if (result.kind === "failed") {
      backlogPlanner.onPlanningFailure(result.reason, Date.now());
      const health = backlogPlanner.health(Date.now())!;
      noteBacklog(
        `could not read the dependencies (${health.failureCount}x): ${health.lastError}` +
          (health.state === "degraded" ? " - scheduling one at a time instead" : ""),
      );
      return false;
    }
    try {
      await client.putBacklogPlan(result.plan);
    } catch (err) {
      // NOT a planning failure - the model answered fine, the daemon refused the write.
      // Counted and backed off separately so a broken route does not spend the
      // planner's strikes, though at its own cap it degrades the same way.
      backlogPlanner.onStoreFailure(err, Date.now());
      const health = backlogPlanner.health(Date.now())!;
      const retrySeconds = Math.max(
        0,
        Math.round((backlogPlanner.storeRetryAt() - Date.now()) / 1000),
      );
      noteBacklog(
        `planned the backlog but could not store it (${health.failureCount}x, retrying in ` +
          `${retrySeconds}s)` +
          (health.state === "degraded"
            ? " - scheduling one at a time meanwhile"
            : "") +
          `: ${health.lastError}`,
      );
      return false;
    }
    backlogPlanner.onSuccess();
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
  const r = await client.dispatchTask(
    action.task.id,
    cfg.backlogDefaultModel[action.task.agent],
  );
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
 * Session id -> PR key -> what we have already relayed about that pull request (see
 * `FollowupMark`).
 *
 * Two levels rather than one, because a session can own several pull requests at once - a
 * multi-repo task opens one per repository it changed - and their review histories are
 * independent. A flat session-keyed map made each pull request's mark evict its sibling's:
 * the evicted one then reads as never-nudged, its feedback is relayed again, and it evicts
 * the first back. The outer key is pruned to the live fleet; the inner map is pruned to the
 * pull requests that are still open, which is what the flat map's eviction used to do.
 *
 * In-memory, like `recentlyActed` and the failure trackers, and justified the same way:
 * the lease guarantees a single worker, so this is the only reader/writer, and the cost
 * of losing it on a restart is bounded to ONE re-nudge per PR still carrying feedback - a
 * duplicate "go fix your PR" typed at an idle agent. That is low harm next to the DB
 * column, route and migration a durable version would cost, and unlike the prompted
 * wrap-up's marker this action does not PUSH, so a rare double is a repeated instruction,
 * not a repeated pull request. Pruned to the live session set each pass so it cannot grow
 * without bound.
 */
const reviewNudged = new Map<string, Map<string, FollowupMark>>();

/**
 * Fold this pass's observation into every one of a session's open pull requests, and forget
 * the ones that are no longer open. Returns the session's marks, which is also what the map
 * now holds for it.
 *
 * Every open pull request, not only the one about to be nudged, for the reason
 * `advanceFollowupMark` gives: a CI recovery seen while the session was working has to be
 * remembered so the next failure re-arms once it parks.
 */
function observeFollowupMarks(sessionId: string, prs: FollowupPr[]): Map<string, FollowupMark> {
  const prior = reviewNudged.get(sessionId);
  const next = new Map<string, FollowupMark>();
  for (const pr of prs) next.set(pr.prKey, advanceFollowupMark(prior?.get(pr.prKey) ?? null, pr));
  reviewNudged.set(sessionId, next);
  return next;
}

/**
 * The review follow-through pass: nudge each parked session whose OPEN pull request
 * carries feedback nobody is acting on - unresolved Inspector comments, a failing CI, or
 * both - back onto it.
 *
 * Decide-then-act, like every other step: all the precedence lives in
 * `decideReviewFollowup` (pure, testable), and this only reads the fleet and types.
 * Immediately before each send it re-reads the session and config and repeats the same
 * decision against the fresh fleet.
 *
 * Returns the ids of the sessions whose pane it claimed this pass - a send that landed,
 * or one that threw but MAY have reached the composer - so the caller can both judge
 * progress (a non-empty set means come straight back) and keep the per-target loop from
 * landing a second instruction in a pane this pass already touched. Only a send the
 * daemon POSITIVELY reports as undelivered is left out, which frees that session to be
 * retried next pass and typed into by the target loop now; it is also the one case whose
 * marker is restored, so the same feedback remains actionable. A pass that claims no pane
 * lets the loop sleep IDLE_MS rather than spinning - and a claimed-but-unconfirmed pane
 * cannot spin either, because its marker is kept, so the next pass sees "already nudged"
 * and does nothing.
 */
async function runReviewFollowup(
  client: ForemanClient,
  cfg: ForemanConfig,
): Promise<Set<string>> {
  const nudged = new Set<string>();

  const sessions = await client.sessions().catch(() => null);
  if (!sessions) return nudged;

  // Drop markers for sessions that have gone away, so the map tracks the live fleet.
  const liveIds = new Set(sessions.map((s) => s.id));
  for (const id of reviewNudged.keys()) if (!liveIds.has(id)) reviewNudged.delete(id);

  const now = Date.now();
  for (const session of sessions) {
    // No open PR anywhere: forget this session's marks - a merged/closed PR is done, and a
    // later new PR starts fresh. Everything below is scoped to pull requests a mark can be
    // keyed to.
    const prs = followupPrs(session);
    if (prs.length === 0) {
      reviewNudged.delete(session.id);
      continue;
    }

    // Fold this pass's observation (a CI recovery, or a new PR) into every mark and PERSIST
    // them, for EVERY open pull request - not only the one about to be nudged - because that
    // recovery is what re-arms CI once the session parks. See `advanceFollowupMark`.
    const marks = observeFollowupMarks(session.id, prs);

    // A workflow is another writer to this pane and checkout. Failure to read ownership
    // is a reason to hold, never permission to type across an owner we could not observe.
    // One read for the session, not one per pull request: the ownership it answers is the
    // session's, and the pull requests below share the pane it is about.
    const workflowRuns = await client.workflowRuns(noteKeyOf(session)).catch(() => null);
    if (!workflowRuns) continue;

    // AT MOST ONE NUDGE PER SESSION PER PASS, primary repository first. The pull requests
    // share one pane and one turn, so relaying two at once would interleave two instructions
    // into a turn expecting neither - the same rule phase 3 gave concurrent review runs'
    // deliveries. The rest keep their feedback pending and are offered on a later pass, once
    // this one has been acted on and the session parks again.
    for (const pr of prs) {
      const decision = decideReviewFollowup({
        session,
        pr,
        // The real fleet, not a one-element list: `reportBucket` needs it to tell a gate
        // this session is driving from one that needs a human.
        bucket: reportBucket(session, sessions),
        mayActLive: foremanMayActLive(cfg, session.cwd, session.repoRoot),
        workflowOwnsSession: activeWorkflowOwnsSession(workflowRuns),
        mark: marks.get(pr.prKey) ?? null,
        cfg: {
          trackReviewComments: cfg.trackReviewFeedback,
          trackCiFailures: cfg.trackCiFailures,
          settleMs: SETTLE_MS,
        },
        now,
      });
      if (decision.kind === "skip") continue;

      const [freshCfg, freshSessions] = await Promise.all([
        client.getConfig().catch(() => null),
        client.sessions().catch(() => null),
      ]);
      if (!freshCfg || !freshSessions || !isLeader) break;

      const fresh = resolveLiveSession(freshSessions, noteKeyOf(session));
      if (!fresh || paneKeyOf(fresh) !== paneKeyOf(session)) break;

      // Re-read workflow ownership at the same freshness boundary as session/config. A run
      // may have been bound after the first decision but before this pane was about to move.
      const freshWorkflowRuns = await client.workflowRuns(noteKeyOf(fresh)).catch(() => null);
      if (!freshWorkflowRuns) break;

      // Re-observe against the fresh snapshot, carrying the marks across an id re-mint. This
      // is what stops the freshness recheck from discarding a recovery the first read saw.
      // The pull request has to still be there: it may have merged, or been closed, in the
      // window this recheck exists to notice.
      if (fresh.id !== session.id) {
        const carried = reviewNudged.get(session.id);
        if (carried && !reviewNudged.has(fresh.id)) reviewNudged.set(fresh.id, carried);
        reviewNudged.delete(session.id);
      }
      const freshPrs = followupPrs(fresh);
      const freshPr = freshPrs.find((candidate) => candidate.prKey === pr.prKey);
      if (!freshPr) break;
      const freshMarks = observeFollowupMarks(fresh.id, freshPrs);
      const freshMark = freshMarks.get(freshPr.prKey) ?? null;

      const freshDecision = decideReviewFollowup({
        session: fresh,
        pr: freshPr,
        bucket: reportBucket(fresh, freshSessions),
        mayActLive: foremanMayActLive(freshCfg, fresh.cwd, fresh.repoRoot),
        workflowOwnsSession: activeWorkflowOwnsSession(freshWorkflowRuns),
        mark: freshMark,
        cfg: {
          trackReviewComments: freshCfg.trackReviewFeedback,
          trackCiFailures: freshCfg.trackCiFailures,
          settleMs: SETTLE_MS,
        },
        now: Date.now(),
      });
      if (freshDecision.kind === "skip" || !isLeader) break;

      // Stamp BEFORE the inject, then retract ONLY on positive evidence nothing landed -
      // the `recentlyActed` discipline. A request whose outcome we never learn keeps the
      // stamp, because a lost response must not become a second nudge; a delivery the
      // daemon reports as refused restores the pre-nudge mark to retry on a later pass.
      freshMarks.set(freshDecision.prKey, freshDecision.mark);
      try {
        await client.inject(fresh.id, freshDecision.payload);
      } catch (err) {
        // Only a delivery the daemon POSITIVELY reported as undelivered frees this session:
        // its previous mark is restored so it re-nudges, and it is NOT claimed, so the
        // target loop may act on it now. Any other failure - a lost response, an unrecognised
        // throw - is treated as "may have reached the composer" (the same conservative
        // reading `queue-apply`'s `mayHaveLanded` makes): keep the mark and claim the pane,
        // so nothing types a wrap-up on top of a follow-up that might already be sitting there.
        const confirmedUndelivered = err instanceof InjectError && !err.mayHaveLanded;
        if (confirmedUndelivered) {
          if (freshMark) freshMarks.set(freshDecision.prKey, freshMark);
          else freshMarks.delete(freshDecision.prKey);
        } else {
          nudged.add(session.id);
          nudged.add(fresh.id);
        }
        log(`${fresh.name}: could not nudge the PR follow-through (${String(err)})`);
        break;
      }
      nudged.add(session.id);
      nudged.add(fresh.id);
      log(`${fresh.name}: nudged to follow through on its PR - ${freshDecision.reason}`);
      break;
    }
  }
  return nudged;
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
  // targets serially and any one of them can block on a model call for up to 240s,
  // so the snapshot this target was selected with can be minutes old. Deciding from
  // it reads a long-dead `state: "idle"` against a fresh `now`, which makes
  // `settledIdle` trivially true and fires a verify at an agent that went back to
  // work - and unlike a send, a verify has no guard of its own to catch it.
  //
  // A FAILED read is not evidence of anything, so it decides nothing: skip the
  // target and re-decide next tick. Falling back to the stale `session` would
  // reintroduce the exact bug this re-resolve exists to close, and a one-element
  // fallback would also lie to `reportBucket`, whose classification uses fleet context.
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
  // One extra loopback round-trip per target per tick - noise next to a model call.
  //
  // A FAILED read has to stay distinguishable from a successful one, because `null` is
  // ALSO the legitimate answer for "this session has no queue" - and the two mean
  // opposite things to the prompted path. Coercing a throw to `null` hands
  // `decidePromptedWrapup` a null queue on a transient daemon blip, which silently
  // disarms both of its double-fire guards at once: the overlap rule that hands a queued
  // session to the drain trigger, and the consumed-generation guard. The
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
  const intent = await client.goal(fresh.id).catch(() => null);

  const action = decideQueueTick({
    session: fresh,
    bucket: reportBucket(fresh, live),
    queue,
    intent,
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

  if (action.kind === "ask-wrapup" || action.kind === "auto-wrapup") {
    const completionIntent = action.kind === "auto-wrapup"
      ? action.intentGuard
      : resolvedSessionIntent(intent);
    if (completionIntent) {
      const [diff, transcriptAnchor] = await Promise.all([
        client.diff(fresh.id).catch(() => null),
        client.transcriptSize(fresh.id).catch(() => null),
      ]);
      // The pure machines catch durable task kind and explicit output contracts before
      // reaching this point. The evidence read adds the last case they cannot see: a
      // completed diff made entirely of conventional review artifacts. This check must stay
      // before `tryWorkflowCompletionClaim`, because even an `ask-wrapup` action claims an
      // existing Foreman-complete binding before it would render the card.
      const block = automaticWrapupBlock({
        taskKind: fresh.task?.kind ?? null,
        workflowId: fresh.task?.workflowId ?? null,
        objective: completionIntent.objective,
        // A truncated patch is not a complete file list. Treating its visible prefix as
        // exhaustive could hide a later source file and incorrectly classify a mixed change.
        changedPaths: diff?.ok && !diff.truncated ? changedPaths(diff.patch) : null,
        skipScoutWrapup: cfg.skipScoutWrapup,
        skipReviewArtifactWrapup: cfg.skipReviewArtifactWrapup,
      });
      if (block) {
        const outcome = await applyQueueAction(
          queueActions(client, cfg),
          fresh,
          { kind: "skip-wrapup", queue: action.queue, reason: block.reason },
          qcfg,
          Date.now(),
        );
        log(`${fresh.name}: ${block.reason}; skipped automatic wrap-up`);
        return outcome.kind !== "noop";
      }
      const claim = await tryWorkflowCompletionClaim(
        client,
        fresh.id,
        drainCompletionClaim(
          action.queue,
          diff?.ok ? diff.headSha : null,
          transcriptAnchor,
          completionIntent,
        ),
      );
      if (claim.kind === "failed") {
        log(`${fresh.name}: workflow completion claim failed closed (${claim.error})`);
        return false;
      }
      if (claim.kind === "claimed") {
        log(`${fresh.name}: workflow claimed queue completion for run ${claim.result.runId}`);
        return true;
      }
      if (claim.result.reason === "manual_trigger") {
        // A Manual binding is an existing operator choice. It may own PR creation itself,
        // so direct shipping must not race it on the same branch. Degrade to the Ship it?
        // card and let the operator choose which path owns the completion.
        const outcome = await applyQueueAction(
          queueActions(client, cfg),
          fresh,
          { kind: "ask-wrapup", queue: action.queue },
          qcfg,
          Date.now(),
        );
        log(`${fresh.name}: existing workflow is Manual - asked about wrapping up`);
        return outcome.kind !== "noop";
      }
    }
  }

  if (
    action.kind === "auto-wrapup" &&
    !sessionIntentMatches(await client.goal(fresh.id).catch(() => null), action.intentGuard)
  ) return false;

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
    skipScoutWrapup: cfg.skipScoutWrapup,
    skipReviewArtifactWrapup: cfg.skipReviewArtifactWrapup,
  };
}

/** The same projection for the prompted trigger. Same `settleMs`, deliberately. */
function promptedConfig(cfg: ForemanConfig): PromptedConfig {
  return {
    triggers: cfg.wrapupTriggers,
    wrapup: cfg.wrapup,
    settleMs: SETTLE_MS,
    skipScoutWrapup: cfg.skipScoutWrapup,
    skipReviewArtifactWrapup: cfg.skipReviewArtifactWrapup,
  };
}

/**
 * Re-read every prompted safety gate after evidence work, especially after a verifier call.
 *
 * Running the pure decision again keeps queue precedence, human-attention, instrumentation,
 * settled-idle, logical-key, generation, and intent policy in one place. A changed result is
 * discarded without consuming either the observed or newest generation.
 */
async function refreshPromptedCandidate(
  client: ForemanClient,
  pcfg: PromptedConfig,
  expected: Extract<PromptedCandidate, { kind: "check" | "retire" }>,
): Promise<{
  session: Session;
  candidate: Extract<PromptedCandidate, { kind: "check" | "retire" }>;
} | null> {
  const sessions = await client.sessions().catch(() => null);
  if (!sessions) return null;
  const session = resolveLiveSession(sessions, expected.logicalKey);
  if (!session) return null;
  const [queueRead, intent] = await Promise.all([
    client.queue(session.id).then((queue) => ({ ok: true as const, queue }), () => null),
    client.goal(session.id).catch(() => null),
  ]);
  if (!queueRead) return null;
  const current = decidePromptedWrapup({
    session,
    bucket: reportBucket(session, sessions),
    queue: queueRead.queue,
    intent,
    cfg: pcfg,
    now: Date.now(),
  });
  if (
    current.kind !== expected.kind ||
    current.logicalKey !== expected.logicalKey ||
    current.generation !== expected.generation ||
    current.episodeKey !== expected.episodeKey ||
    current.objective !== expected.objective ||
    current.objectiveVersion !== expected.objectiveVersion ||
    current.promptRevision !== expected.promptRevision
  ) return null;
  return { session, candidate: current };
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
 * the write that CONSUMES the generation lands BEFORE the shipping instruction, so a crash
 * between "typed" and "recorded that we typed" must leave the trigger disarmed. Concretely:
 *
 *   verify -> consume expected generation -> type -> record the answer
 *
 * Every failure degrades toward the human: a consume that fails aborts before typing
 * (nothing happened, we retry next tick, and only so many times - see
 * `promptedFailures`); a type that fails leaves the generation consumed with the Ship it?
 * card as the recovery; a record that fails has the instruction visibly in the pane with
 * a human looking at it.
 *
 * A tick that aborts returns NOT advanced, always. The loop reads that as "nothing here
 * right now" and sleeps IDLE_MS; claiming progress for a write that failed re-selects
 * this same session every BETWEEN_MS instead, which on the paths below the verifier
 * means a model call per 400ms for as long as one endpoint stays broken.
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
    intent: goal,
    cfg: pcfg,
    now: Date.now(),
  });
  if (candidate.kind === "skip") return false;
  if (candidate.kind === "retire") {
    const current = await refreshPromptedCandidate(client, pcfg, candidate);
    if (
      !current ||
      !(await consumePromptedCycle(client, current.session, current.candidate, {
        outcome: "retired",
        summary: candidate.why,
        gaps: [],
      }))
    ) {
      return false;
    }
    log(`${session.name}: prompted automatic wrap-up skipped - ${candidate.why}`);
    return true;
  }

  // Foreman already gave up on this generation - see `promptedFailures`, which counts both
  // the failures below that can repeat forever. Checked HERE, above every read, because
  // the whole point of the cap is to stop spending on it: a check further down would
  // still pay for the evidence gather and the model call it exists to prevent.
  if (promptedFailures.gaveUp(candidate.logicalKey, candidate.generation)) return false;

  // --- evidence. Same discipline as runVerify: any gap in it is a verify-INFRASTRUCTURE
  // failure and must never reach the verifier, which would otherwise find no proof the
  // work was done and answer "incomplete" about work that is finished. Here that
  // mistake is cheap in the right direction (we hold, and type nothing), so each of
  // these returns WITHOUT consuming - the generation stays armed and retries next tick.

  // No base sha: the whole branch since it diverged is the unit of work, because a
  // pane-typed session has no per-item scope to anchor to. That is also why
  // `diffMayIncludeOtherWork` is true below - it always may.
  const [diff, transcriptRead] = await Promise.all([
    client.diff(session.id).catch(() => null),
    client.transcriptSize(session.id).then(
      (value) => ({ ok: true as const, value }),
      () => ({ ok: false as const, value: null }),
    ),
  ]);
  if (!diff || !diff.ok) {
    log(`${session.name}: prompted wrap-up held - could not read the diff`);
    return false;
  }
  if (!transcriptRead.ok) {
    log(`${session.name}: prompted wrap-up held - could not read the transcript anchor`);
    return false;
  }
  const transcriptAnchor = transcriptRead.value;

  const intentGuard = {
    objective: candidate.objective,
    objectiveVersion: candidate.objectiveVersion,
    promptRevision: candidate.promptRevision,
    episodeKey: candidate.episodeKey,
  };
  // An empty diff decides itself, and decides it WITHOUT a model call: the session
  // changed nothing, so there is nothing to commit, push or open a PR for. This is the
  // common case for a question-and-answer session ("what does this function do?"), and
  // it is exactly the case that would otherwise make this trigger obnoxious - a Ship
  // it? card on every conversation. Stamped, because the answer will not change while
  // the session sits idle.
  if (!diff.patch.trim()) {
    // The consume IS the whole tick here, so its result is the tick's result. Swallowing
    // it and claiming progress anyway would re-process this session every BETWEEN_MS -
    // four loopback reads a pass against the daemon's single synchronous handle, which
    // also serves hook ingest and SSE - for as long as the write stays broken.
    const current = await refreshPromptedCandidate(client, pcfg, candidate);
    if (
      !current ||
      // `empty`, never `held`: no verifier ever ran, so there is no summary to send back
      // and nothing for recovery to ask the session to finish. The distinction is the
      // whole reason the outcome vocabulary is wider than a boolean.
      !(await consumePromptedCycle(client, current.session, current.candidate, {
        outcome: "empty",
        summary: "the session changed nothing",
        gaps: [],
      }))
    ) {
      return false;
    }
    log(`${session.name}: prompted wrap-up held - the session changed nothing`);
    return true;
  }

  // The resolved objective gate above catches explicit mockup-style contracts. The diff
  // adds a content-shaped backstop for terse prompts whose only changes landed in the
  // repository's review-artifact paths. Retire before transcript gathering or verification:
  // the result cannot become eligible for automatic shipping later in this generation.
  const block = automaticWrapupBlock({
    taskKind: session.task?.kind ?? null,
    workflowId: session.task?.workflowId ?? null,
    objective: candidate.objective,
    changedPaths: diff.truncated ? null : changedPaths(diff.patch),
    skipScoutWrapup: cfg.skipScoutWrapup,
    skipReviewArtifactWrapup: cfg.skipReviewArtifactWrapup,
  });
  if (block) {
    const current = await refreshPromptedCandidate(client, pcfg, candidate);
    if (
      !current ||
      !(await consumePromptedCycle(client, current.session, current.candidate, {
        outcome: "retired",
        summary: block.reason,
        gaps: [],
      }))
    ) {
      return false;
    }
    log(`${session.name}: prompted automatic wrap-up skipped - ${block.reason}`);
    return true;
  }

  const window = await client.transcript(session.id).catch(() => null);
  if (!window || window.unavailable) {
    log(`${session.name}: prompted wrap-up held - could not read the transcript`);
    return false;
  }

  const { standards, instructions } = await judgingContext(client, session, diff.patch);

  // The SAME verifier the queue uses, deliberately. "Did this diff satisfy the durable
  // objective, in light of the latest focus?" is one question, and a second prompt for it
  // would be a second thing to keep true.
  const result = await verifyItem({
    session: { name: session.name, cwd: session.cwd, gitBranch: session.gitBranch },
    intent: candidate.objective,
    focus: candidate.focus,
    round: 0,
    diff: diff.patch,
    diffTruncated: diff.truncated,
    // Always true here: with no per-item base sha the diff is the whole branch, which
    // may well carry work from before this intent episode. Telling the verifier so is
    // what stops it crediting - or blaming - this objective for someone else's commits.
    diffMayIncludeOtherWork: true,
    transcript: window.messages,
    transcriptTruncated: window.truncated,
    standards: standards.docs,
    standardsTruncated: standards.truncated,
    instructions,
    priorGaps: [],
    // The trusted boundary this session's task was actually delivered, resolved
    // STRUCTURALLY from the durable task kind on the live session Foreman just re-read -
    // never from transcript prose, which is evidence being judged.
    //
    // This is what closes the reported deadlock. A dispatched ship task's objective very
    // often still says "open a reviewable pull request", while `withTaskKindContract` told
    // that agent in the same delivery not to. Without the contract the verifier is right
    // by its own lights and wrong about the boundary: it answers incomplete, the hold
    // spends the generation, and the bound workflow never gets the finished work.
    //
    // A personal session has no task and gets none, so the generic prompted trigger's
    // behavior is untouched - and so is every other task kind, because only `ship` has a
    // contract to give.
    completionContract: taskCompletionContract(session.task?.kind),
  }, verifyModel(cfg), triageRunnerId);
  if (result.kind === "failed") {
    // Unlike the queue there is no item to escalate, but the failure is bounded the
    // same way and for the same reason - see `PromptedFailureTracker`. Under the cap
    // the generation stays armed and retries next tick; at the cap Foreman consumes it.
    // A later completed generation gets a fresh bounded counter even when intent is unchanged.
    const failures = promptedFailures.onFailure(candidate.logicalKey, candidate.generation);
    if (failures >= VERIFY_FAILURE_CAP) {
      const current = await refreshPromptedCandidate(client, pcfg, candidate);
      if (current) {
        // `verification_failed`, and deliberately NOT `held`. A hold is a MODEL's verdict
        // that the work is unfinished; this is the verifier infrastructure failing enough
        // times to give up, and no one has judged this work at all. Labelling it `held`
        // would let a later recovery send "blocking gaps" that no verifier ever wrote.
        await consumePromptedCycle(client, current.session, current.candidate, {
          outcome: "verification_failed",
          summary: `verification failed ${failures}x: ${result.reason}`,
          gaps: [],
        });
      }
      log(
        `${session.name}: prompted wrap-up gave up - verify failed ${failures}x (${result.reason})`,
      );
      return false;
    }
    log(`${session.name}: prompted wrap-up held - verify failed (${result.reason})`);
    // NOT `advanced`: nothing was written and nothing changed. Reporting a failed tick
    // as progress makes the loop skip its IDLE_MS sleep and re-select this same session
    // on the very next pass - the generation is still armed - turning a broken verifier into a hot loop of model
    // calls separated only by BETWEEN_MS.
    return false;
  }

  let current = await refreshPromptedCandidate(client, pcfg, candidate);
  if (!current || current.candidate.kind !== "check") return false;

  if (
    result.verdict.complete
    && !result.verdict.gaps.some((gap) => gap.severity === "blocking")
  ) {
    const claim = await tryWorkflowCompletionClaim(
      client,
      current.session.id,
      promptedCompletionClaim({
        noteKey: current.candidate.logicalKey,
        workCycle: {
          logicalKey: current.candidate.logicalKey,
          generation: current.candidate.generation,
        },
        intent: intentGuard,
        headSha: diff.headSha,
        transcriptAnchor,
        summary: result.verdict.summary,
      }),
    );
    if (claim.kind === "failed") {
      log(`${session.name}: workflow completion claim failed closed (${claim.error})`);
      return false;
    }
    if (claim.kind === "claimed") {
      log(`${session.name}: workflow claimed prompted completion for run ${claim.result.runId}`);
      return true;
    }
    if (claim.result.reason === "manual_trigger") {
      // Preserve the active Manual binding and surface the verified boundary to the
      // human without starting direct PR shipping alongside that binding.
      current = await refreshPromptedCandidate(client, pcfg, candidate);
      if (
        !current ||
        !(await consumePromptedCycle(
          client,
          current.session,
          current.candidate,
          { outcome: "asked", summary: result.verdict.summary, gaps: [] },
          { ask: true },
        ))
      ) return false;
      log(`${session.name}: existing workflow is Manual - asked about wrapping up`);
      return true;
    }
    current = await refreshPromptedCandidate(client, pcfg, candidate);
    if (!current || current.candidate.kind !== "check") return false;
  }
  const plan = planPromptedWrapup(
    candidate.episodeKey,
    result.verdict,
    pcfg,
    foremanMayActLive(cfg, current.session.cwd, current.session.repoRoot),
  );

  if (plan.kind === "ask-wrapup") {
    // The card and consumed generation are one durable fact: a failure must leave both
    // absent so this verified boundary remains retryable.
    if (
      !(await consumePromptedCycle(
        client,
        current.session,
        current.candidate,
        { outcome: "asked", summary: result.verdict.summary, gaps: [] },
        { ask: true },
      ))
    ) {
      return false;
    }
    log(`${session.name}: prompted work looks complete - asked about wrapping up`);
    return true;
  }

  // Consume the generation FIRST - before anything types - for the reason in the header.
  // A failed compare-and-set aborts: proceeding would be typing an instruction that pushes with
  // nothing recording that we did, so the next tick would do it again. It also aborts
  // as NOT advanced, and counts a strike: nothing was written, and the generation is still
  // armed, so claiming progress would spend a full evidence gather plus a model call
  // per BETWEEN_MS against a session whose only broken part is one endpoint.
  //
  // On the shipping path the SAME write also latches the direct handoff against this
  // intent episode. Consuming the generation alone is not enough to disarm this trigger,
  // and deliberately so: the instruction below makes the agent commit, push, open a PR
  // and follow CI, and its settled Stop completes a LATER generation under the human's
  // unchanged intent - so a generation-only guard re-arms on the very turn the injection
  // caused and types the instruction again. That was the loop. One request, so a crash
  // between "recorded" and "typed" leaves the handoff recorded rather than repeatable.
  if (
    !(await consumePromptedCycle(
      client,
      current.session,
      current.candidate,
      plan.kind === "auto-wrapup"
        ? { outcome: "direct_handoff", summary: result.verdict.summary, gaps: [] }
        // The hold's reason, stored rather than only logged. `plan.why` is the verifier's
        // own words for what is missing, and the blocking gaps beside it are what Phase 2
        // sends back - so this is the one outcome that carries them.
        : { outcome: "held", summary: plan.why, gaps: blockingDecisionGaps(result.verdict) },
      plan.kind === "auto-wrapup" ? { directHandoff: "direct-ship" } : undefined,
    ))
  ) return false;

  if (plan.kind === "hold") {
    log(`${session.name}: prompted wrap-up held - ${oneLine(plan.why)}`);
    return true;
  }

  try {
    await client.inject(current.session.id, plan.payload);
  } catch (err) {
    // Never retry: a retry IS the double-push. Fall back to the card, which is exactly
    // `ask` mode and puts this same text one click away.
    log(`${session.name}: could not send the prompted wrap-up (${String(err)}) - asking instead`);
    await client.markWrapupAsked(current.session.id, { clearAnswer: true }).catch(() => {});
    return true;
  }

  // Record WHAT was sent, but deliberately NOT `wrapupAskedAt`.
  //
  // The card renders on `wrapupAskedAt !== null && wrapupAnswer === null`, so stamping
  // the ask here would open a window - however brief, and unbounded if the write below
  // fails - in which the card offers to send an instruction the agent has already been
  // given. On the drain path that window is accepted because `wrapupAskedAt` is also
  // that trigger's once-only guard and has to be written. This trigger's guard is
  // the consumed work-cycle generation, already stamped above, so there is nothing
  // forcing the same trade-off: leaving the ask unstamped means no card can ever double-offer.
  await client.setWrapupAnswer(current.session.id, plan.payload).catch(() => {});
  log(`${session.name}: prompted work complete - sent "${plan.payload}"`);
  return true;
}

/**
 * Clamp a reason to the wire schema's bounds, HERE, before it can be rejected.
 *
 * The schema refuses over-long text rather than truncating it, and this reason travels
 * inside the consume - so an unbounded summary would not merely lose the reason, it would
 * fail the consume itself, leave the generation armed, and spend a full evidence gather
 * plus a model call every unhurried tick until the strike cap. Most of these summaries come
 * from the verifier and are already clamped; `verification_failed` carries a runner failure
 * reason, which is whatever a broken child process wrote to stderr, and that is exactly the
 * case where a reason must not be able to break the write it rides on.
 */
function boundedDecision(decision: PromptedCompletionDisposition): PromptedCompletionDisposition {
  const clamp = (value: string, max: number): string =>
    value.length > max ? value.slice(0, max) : value;
  return {
    outcome: decision.outcome,
    summary: clamp(decision.summary, PROMPTED_DECISION_SUMMARY_MAX),
    gaps: decision.gaps.slice(0, PROMPTED_DECISION_GAPS_MAX).map((gap) => ({
      id: clamp(gap.id, PROMPTED_DECISION_GAP_ID_MAX),
      path: clamp(gap.path, PROMPTED_DECISION_GAP_PATH_MAX),
      detail: clamp(gap.detail, PROMPTED_DECISION_GAP_DETAIL_MAX),
    })),
  };
}

/**
 * The verdict's BLOCKING gaps, bounded, as the durable record of what is missing.
 *
 * Blocking only: an advisory gap is by definition something the human's request did not
 * depend on, and storing one would put "rename this variable" in front of Phase 2 as a
 * reason a task is stuck. The count and text bounds are the schema's, re-stated nowhere -
 * `PromptedCompletionDispositionSchema` refuses anything past them at the write boundary,
 * and the verifier has already clamped each field to the same lengths.
 */
function blockingDecisionGaps(verdict: QueueVerdict): PromptedCompletionGap[] {
  return verdict.gaps
    .filter((gap) => gap.severity === "blocking")
    .slice(0, PROMPTED_DECISION_GAPS_MAX)
    .map((gap) => ({ id: gap.id, path: gap.path, detail: gap.detail }));
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

  const { standards, instructions } = await judgingContext(client, session, diff.patch);

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
    instructions,
    priorGaps: item.gaps,
  }, verifyModel(cfg), triageRunnerId);

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

/**
 * What a verify judges an item AGAINST: this repo's standards, and the operator's own
 * instructions. Shared by the two verify entry points (the work queue and the prompted
 * wrap-up), which call the same `verifyItem` with the same shape and had this block
 * byte-for-byte twice - including the fallback literal, which is the part that must not drift.
 *
 * Both degrade to ABSENT rather than holding the tick, and that rule is why it is worth one
 * function: a repo with no FOREMAN.md is the ordinary case and must verify exactly as it did
 * before the file existed, so a failed read has to be indistinguishable from "there is none".
 * Two copies of that reasoning are two chances for one of them to start holding the tick
 * instead.
 */
async function judgingContext(
  client: ForemanClient,
  session: Session,
  patch: string,
): Promise<{ standards: StandardsBundle; instructions: string }> {
  const [standards, instructions] = await Promise.all([
    client.standards(session.id, changedPaths(patch)).catch(() => ({ docs: [], truncated: false })),
    readInstructions(client),
  ]);
  return { standards, instructions };
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
  if (!foremanTriageAuthorized(session)) return false;
  const pending = classifyPending(session, reviews);

  // Idempotency: don't re-handle a prompt whose marker we've already stamped.
  const existing = await client.note(session.id).catch(() => null);
  if (existing?.handledMarker === pending.marker) return false;

  // Debounce: the check above skips an UNCHANGED episode for free, but a *changed*
  // marker (a new review, or a terminal whose `lastActivity` moved) would otherwise
  // spawn a full review immediately. Hold each session to at most one evaluation per
  // window so a flapping marker can't burn a model call on every loop; a session seen
  // for the first time is due at once, so genuinely new work is never delayed.
  if (!evaluations.claim(session.id)) return false;

  // ONE read of the child's screen, shared by the reviewer's prompt and by the check on
  // what it answers. Captured here rather than inside the review so those two cannot
  // disagree: the model must be judged against the same rows it was shown, or a menu that
  // repainted between two captures would have us validating an answer to a question the
  // model never saw. It also has to precede `decide`, because the CHEAP tier can answer an
  // access prompt too, and a menu it answered in prose must be caught by the same gate.
  // ONE read of the operator's FOREMAN.md per evaluation, threaded exactly like `pane`
  // above and for a related reason. Whichever tiers run must be reading the SAME
  // instructions - in `shadow` both run concurrently and their verdicts are compared, so
  // two independent reads could have them diverge over an edit that landed between them
  // and log it as a tier disagreement. It also spares a repeated `git rev-parse
  // --show-toplevel` subprocess: the route resolves the repo root per call and caches
  // nothing, so the `on` path used to pay for it twice whenever an ask routed up.
  //
  // Null on failure, like every other read of this file - see `ForemanClient.prefs`.
  const [pane, instructions] = await Promise.all([
    paneFor(client, session, pending),
    readInstructions(client),
  ]);
  const ctx: ReviewContext = {
    sessionId: session.id,
    promptMarker: pending.marker,
    inputReviewId: pending.inputReviewId,
    canSend: pending.canSend,
    // What "answering" means on this surface: a menu is selected, not typed at. Parsed
    // with this session's OWN grammar - the reviewer is shown whatever rows its agent drew,
    // and a harness we cannot read reports no menu rather than another agent's reading of
    // its screen.
    menu: askOnScreen(session, pane),
  };

  // Resolve the verdict through the tier ladder (off / shadow / on). A null here means
  // the outcome was already handled - a transient review failure that will retry, or a
  // give-up note that was already written - so there's nothing left to apply. That still
  // counts as work: a model call ran, so the loop must not hurry back.
  const decision = await decide(client, cfg, session, pending, ctx, {
    pane,
    // The SAME object `ctx.menu` holds when it is a driver's request, so what the reviewer
    // was shown and what its answer is checked against cannot be two different asks. Null
    // for a pane menu, which is rendered from `pane` and has no structured form.
    request: ctx.menu?.source === "driver" ? ctx.menu : null,
    instructions,
    queueItem,
  });
  if (!decision) return true;
  const { verdict, tier, shadow, reason: triageReason } = decision;

  let plan = planFromVerdict(
    verdict,
    ctx,
    foremanMayActLive(cfg, session.cwd, session.repoRoot),
    cfg.autoApproveAccess,
  );

  // The review may have run a fresh model call for up to two minutes, so
  // both the session snapshot and the config are stale by the time we're ready to act.
  // Before acting on it, re-confirm against a fresh session list that this session still
  // needs *this* exact prompt; if the human already handled it (answered, left
  // needs-you, or a newer prompt arrived), record the decision but leave no mark on the
  // session. Then, for a send, re-plan from a fresh config so every "toggle stops acting"
  // switch - disable, leaving live mode, dropping the repo from the allowlist, or turning
  // off access auto-approval - is honoured even for an in-flight review. Re-planning
  // (not just re-checking mayActLive) makes autoApproveAccess=false downgrade a live
  // access approval to an escalation mid-review. This applies identically whether the
  // verdict came from Tier 1 or the full Tier 2 review.
  //
  // The guard covers an ESCALATION and a DRAFT as well as a send, which is the half it used
  // to be missing: its doc said "reads are cheap, so we only guard the send path", quietly
  // assuming a note costs nothing to write. See `planLeavesAMark` for why it does.
  if (planLeavesAMark(plan)) {
    if (!(await pendingStillLive(client, session.id, pending))) {
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
      // `sentBy` null through `episodeFromPlan`: a stale decision is one that delivered
      // nothing, and attributing one to it would be a lie in the record. The reviewer's
      // judgment is not lost - `episodeFromPlan` keeps the brief and the recommendation,
      // so a stale escalation is still readable in the drawer. It is only unpinned.
      await client
        .recordEpisode(
          session.id,
          episodeFromPlan({
            pending,
            ctx,
            pane,
            verdict,
            tier,
            // Kept on the stale path too: the comparison was MADE - both calls ran and
            // both answered - and what went stale is the session, not the measurement.
            // Dropping it here would silently thin the shadow sample by exactly the
            // decisions that took longest, which are the ones worth measuring.
            shadow,
            triageReason,
            // The one field this path exists to write, and the reason it was worth a
            // column. Everything else here says `skipped`, and `skipped` is the wrong
            // word for what happened: Foreman REACHED a verdict - it is right there in
            // the recommendation this same call preserves - and the session moved on
            // before it could be delivered. On a real 833-episode ledger that was 235 of
            // 318 skips, all of them rendered under a tile captioned "the asks Foreman
            // could not read", which describes none of them. The disposition stays
            // `skipped` because the NOTE's vocabulary is about who still owes an answer
            // and nobody does; this is what lets the RECORD say something truer than the
            // note without the two contradicting each other. See `episodeOutcome`.
            skipReason: "stale",
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
      log(`${session.name}: dropped a stale ${plan.send ? "send" : plan.note.disposition} (session changed during review)`);
      return true;
    }
  }
  if (plan.send) {
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
    episodeFromPlan({ pending, ctx, pane, verdict, tier, shadow, triageReason, plan }),
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
 *
 * `shadow` is present on exactly one posture, and its absence elsewhere is meaningful
 * rather than incidental: `off` never asks the cheap tier, and under `on` the cheap tier
 * IS the decision, so in neither case is there a second opinion to compare against. The
 * episode row records that as null - "not measured" - rather than as agreement.
 */
type Decision = {
  verdict: Verdict;
  tier: 0 | 1 | 2;
  shadow?: { cheapAction: CheapAction; divergence: Divergence };
  /**
   * Why the ladder landed on this verdict - `TriageOutcome.reason`, carried out to the
   * episode row instead of being logged and dropped.
   *
   * Present wherever the cheap tier was consulted at all, which is `shadow` and `on`. Under
   * `off` the full review is the first and only reader, so there is no ladder decision to
   * report and this is absent - the same "not measured, not a value" distinction the shadow
   * pair makes, and for the same reason: a reason invented for a posture that never asked
   * would be the record answering a question nobody put.
   *
   * On a route-up it is the reason the CHEAP tier declined, not a claim about the full
   * review that followed, and that is exactly what makes it worth keeping: "escalated"
   * beside `low-confidence` and "escalated" beside `human-only-risky` are two different
   * stories about the same word, and the ledger has only ever been able to tell the word.
   */
  reason?: string;
} | null;

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
  /** What the caller captured once for this evaluation - see `processSession`. */
  captured: CapturedInputs,
): Promise<Decision> {
  switch (triagePosture(cfg.triage)) {
    case "off":
      return fullReviewOnly(client, cfg, session, pending, ctx, captured);
    case "shadow":
      return shadowBoth(client, cfg, session, pending, ctx, captured);
    case "on":
      return cheapTierDecides(client, cfg, session, pending, ctx, captured);
  }
}

/** `off`: the pre-triage behaviour - every new marker gets a full review. */
async function fullReviewOnly(
  client: ForemanClient,
  cfg: ForemanConfig,
  session: Session,
  pending: Pending,
  ctx: ReviewContext,
  /** What the caller captured once for this evaluation - see `processSession`. */
  captured: CapturedInputs,
): Promise<Decision> {
  const r = await fullReview(client, cfg, session, pending, ctx, captured);
  return r && { verdict: r.verdict, tier: 2 };
}

/**
 * `shadow`: run the cheap tier AND the full review, act on the full review, and RECORD the
 * divergence. Concurrent, so the cheap call adds no serial latency to the queue.
 *
 * The measurement used to end at `log()`. That made the posture the panel describes as
 * "run the cheap tier alongside, measure it" a feature nobody could read: it spent a
 * second model call per decision to produce a comparison, wrote it to stdout, and dropped
 * it on the next line. It is now returned with the verdict and lands on the episode row,
 * which is what makes "is the cheap tier safe to turn on?" answerable from the app rather
 * than by grepping a worker's output. The `log()` stays - stdout is still useful while
 * watching one session - but it is no longer the only sink. The recorded cheap outcome
 * models what `on` would actually do after its delivery gate: an answer the cheap tier
 * cannot deliver to a menu is a route-up, not an answer.
 */
async function shadowBoth(
  client: ForemanClient,
  cfg: ForemanConfig,
  session: Session,
  pending: Pending,
  ctx: ReviewContext,
  /** What the caller captured once for this evaluation - see `processSession`. */
  captured: CapturedInputs,
): Promise<Decision> {
  const [cheap, r] = await Promise.all([
    // The same `prefs` object to both, which is the point of reading it once: these two
    // verdicts are COMPARED below, so a tier reading different instructions than its
    // counterpart would surface as a divergence in the log rather than as what it is.
    triageSession(triageDeps(client), pending, session, cfg, captured),
    fullReview(client, cfg, session, pending, ctx, captured),
  ]);
  if (!r) return null; // full review failed + handled; don't act on the cheap tier
  const cheapUnderOn =
    cheap.kind === "dispose" && menuBlocksAnswer(cheap.verdict, ctx)
      ? ({ kind: "route-up", reason: "menu-needs-a-row" } as const)
      : cheap;
  const divergence = classifyDivergence(cheapUnderOn, r.verdict);
  log(
    `${session.name}: shadow ${divergence} ` +
      `(cheap=${describeCheap(cheap)} opus=${r.verdict.action}/${r.verdict.classification})`,
  );
  return {
    verdict: r.verdict,
    // Still 2: the full review is what acted. See `episodeFromPlan`.
    tier: 2,
    shadow: { cheapAction: cheapActionOf(cheapUnderOn), divergence },
    // The CHEAP tier's reason, on a row whose verdict came from the full review, and that
    // is the honest pairing under this posture: the divergence column already says the two
    // disagreed, and this is the only field that says what the cheap tier thought it was
    // looking at when it did. `cheapUnderOn` rather than `cheap`, so a delivery-blocked
    // answer reports `menu-needs-a-row` here exactly as it is scored above.
    reason: cheapUnderOn.reason,
  };
}

/** `on`: the cheap tier decides; the full review fires only on route-up. */
async function cheapTierDecides(
  client: ForemanClient,
  cfg: ForemanConfig,
  session: Session,
  pending: Pending,
  ctx: ReviewContext,
  /** What the caller captured once for this evaluation - see `processSession`. */
  captured: CapturedInputs,
): Promise<Decision> {
  const cheap = await triageSession(triageDeps(client), pending, session, cfg, captured);
  if (cheap.kind === "dispose" && !menuBlocksAnswer(cheap.verdict, ctx)) {
    log(`${session.name}: tier ${cheap.tier} disposed -> ${cheap.verdict.action} (${cheap.reason})`);
    return { verdict: cheap.verdict, tier: cheap.tier, reason: cheap.reason };
  }
  // A dispose this tier can't DELIVER is not a decision, it's a route-up. The router names no
  // row (its schema has no field for one), so on a menu every answer it reaches lands here -
  // and a menu is what a permission prompt is. Handing it to the full reviewer, which can name
  // a row, keeps the ask automated; treating it as final would escalate every routine approval
  // to a human when the tier is `on`. If the full review can't name a row either, `planFromVerdict`
  // escalates it there - the fallback stays, it just stops being the first stop.
  const why = cheap.kind === "route-up" ? cheap.reason : "menu-needs-a-row";
  log(`${session.name}: routed up to full review (${why})`);
  const r = await fullReviewOnly(client, cfg, session, pending, ctx, captured);
  // The route-up reason survives the escalation to the full review, and it is the half of
  // the story the tier column cannot tell. A row reading `tier: review` under the `on`
  // posture means the cheap tier declined and handed over - `why` is the only record of
  // WHAT it declined on, and the difference between `low-confidence` (the router was
  // unsure) and `no-transcript-context` (there was nothing for the safety backstop to
  // read) is the difference between tuning a threshold and fixing a transcript.
  return r && { ...r, reason: why };
}

/**
 * The full Tier 2 review: a fresh tool-less model call on the wide window (60 turns: a
 * `TRANSCRIPT_HEAD_TURNS` head the route always adds, plus the default 48-turn tail
 * `client.transcript` asks for) with the whole POLICY. Returns the verdict, or null when a transient failure was handled -
 * either a retry (nothing written, left queued) or, after repeated strikes, a
 * marker-stamped give-up skip so a persistently-broken reviewer stops re-spawning.
 */
async function fullReview(
  client: ForemanClient,
  cfg: ForemanConfig,
  session: Session,
  pending: Pending,
  ctx: ReviewContext,
  /** What the caller captured once for this evaluation - see `processSession`. */
  captured: CapturedInputs,
): Promise<{ verdict: Verdict } | null> {
  const window = await client
    .transcript(session.id)
    .catch(() => ({ messages: [], truncated: false }));
  const input: ReviewInput = {
    session: {
      // Which harness this is, so the prompt describes ITS screen - see `ReviewInput.session.agent`.
      agent: session.agent,
      // ...and how an answer reaches it, which decides whether there IS a screen to describe.
      runtime: session.runtime,
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
    // The screen the reviewer reads the actual ask from, the item Foreman itself
    // commissioned, and how this operator wants such calls made - all captured once by
    // `processSession` so every tier judges from the same evidence. Spread rather than
    // listed, so a new `CapturedInputs` field reaches the reviewer without a fourth
    // place to remember.
    ...captured,
  };

  const result = await reviewSession(input, reviewModel(cfg), triageRunnerId);
  if (result.kind === "failed") {
    // A transient reviewer failure (spawn/timeout/parse-miss) must NOT stamp the
    // marker, or the idempotency check would abandon this prompt forever after a
    // single blip. Leave it queued to retry; only after several consecutive failures
    // do we give up with a marker-stamped skip so a persistently-broken reviewer stops
    // starting another model call every loop.
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

/**
 * Foreman's standing instructions, or "" when they cannot be read.
 *
 * ONE fetch per evaluation, handed to whichever tiers run - the same rule `pane` follows, and
 * for a sharper reason here: in `shadow` mode both tiers run concurrently and their verdicts
 * are COMPARED, so two reads straddling an edit would be logged as a tier divergence when it
 * was really an input one.
 *
 * Empty on failure, and that is not a silent degrade: a daemon that cannot answer is
 * indistinguishable from an operator who cleared the box, and both mean "judge by your own
 * policy". It is logged on the transition into and out of failure rather than every tick,
 * because the loop revisits a session every BETWEEN_MS and a line per pass buries the one
 * that mattered.
 */
let instructionsUnreadable = false;
async function readInstructions(client: ForemanClient): Promise<string> {
  try {
    const text = await client.instructions();
    if (instructionsUnreadable) {
      instructionsUnreadable = false;
      log("Foreman instructions readable again");
    }
    return text;
  } catch (err) {
    if (!instructionsUnreadable) {
      instructionsUnreadable = true;
      log(`could NOT read Foreman's instructions (${String(err)}) - judging on policy alone`);
    }
    return "";
  }
}

/**
 * The provider the cheap tier spawns through, refreshed once per outer loop pass.
 *
 * Held here rather than threaded through `processTarget` because it is not a property of
 * any one session: every triage in a pass runs on the same provider, and passing it down
 * five frames to reach `triageDeps` would put a preference in five signatures. Refreshed
 * per pass so a change in Settings lands within a tick without a worker restart, and seeded
 * with the default so the very first pass has an answer even if the daemon is slow.
 */
let triageRunnerId: LlmRunnerId = DEFAULT_LLM_RUNNER_ID;

/**
 * The Claude wire transport this worker process applies to all four Foreman call sites.
 *
 * Seeded from the worker's environment for rolling compatibility with a daemon that has
 * no `/api/llm/status` route yet. A successful status read replaces it with the daemon's
 * resolved config/env/default answer, keeping that daemon authoritative thereafter.
 */
let claudeTransport: ClaudeTransport = foremanClaudeTransportFallback();

/**
 * The Codex wire transport this worker applies wherever the cheap tier runs on Codex.
 *
 * Kept beside `claudeTransport` and refreshed from the same status read, because the two
 * answer one question - how this process talks to whichever provider it was told to use -
 * and splitting their refresh is how one of them goes stale unnoticed.
 */
let codexTransport: CodexTransport = foremanCodexTransportFallback();

/**
 * Adapt the daemon client to the cheap tier's read-only dependency surface.
 *
 * `runModel` returns the model's TEXT with the provider envelope already off, which is what
 * `LlmRunner.run` guarantees and what `parseModelJson` on the other side tolerates either
 * way. It used to hand over `claude -p`'s raw `{result: …}` JSON.
 */
function triageDeps(client: ForemanClient): TriageDeps {
  return {
    transcript: (id, turns) => client.transcript(id, turns),
    runModel: (prompt, model, schema) =>
      llmRunner(triageRunnerId).run(prompt, {
        model,
        timeoutMs: TRIAGE_TIMEOUT_MS,
        role: "foreman:triage",
        schema,
      }),
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
 * Re-confirm, immediately before acting, that the session still needs this exact prompt.
 *
 * A fresh session list + reviews snapshot guards the decision against a queue that moved
 * while the (slow) review ran. Returns false if the session left needs-you, a newer prompt
 * arrived, the marker is already handled, or the re-check itself failed.
 *
 * Named for what it establishes rather than for one caller ("sendStillValid"), because it
 * now gates every outcome that leaves a mark: a send that would type into a child, and an
 * escalation or draft that would pin a decision on a human. Those are the same question -
 * is this episode still the live one? - and the answer must not depend on which of them is
 * about to happen.
 */
async function pendingStillLive(
  client: ForemanClient,
  sessionId: string,
  pending: Pending,
): Promise<boolean> {
  try {
    const [sessions, reviews] = await Promise.all([client.sessions(), client.reviews()]);
    const fresh = sessions.find((s) => s.id === sessionId);
    if (!fresh || reportBucket(fresh, sessions) !== "needs-you") return false;
    // The triage twin of `queueSendStillValid`'s invite re-check, and it belongs on the
    // same reasoning: the selection gate ran minutes ago, a review is slow, and Withdraw
    // is one click whose entire meaning is "stop acting in here". Re-asked on the fresh
    // snapshot so the click lands on the act already in flight, not merely the next one.
    if (fresh.foremanInvite === null) return false;
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
