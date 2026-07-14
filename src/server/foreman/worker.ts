import { randomUUID } from "node:crypto";
import type { ForemanConfig } from "@shared/protocol.ts";
import type { ReviewItem, Session, SessionQueue, WorkItem } from "@shared/types.ts";
import { reportBucket } from "@shared/session.ts";
import { ForemanClient } from "./client.ts";
import { reviewSession } from "./review.ts";
import { EvaluationDebounce } from "./debounce.ts";
import { classifyPending } from "./pending.ts";
import type { Pending } from "./pending.ts";
import type { ReviewInput } from "./prompt.ts";
import { applyVerdict, foremanMayActLive, planFromVerdict, ReviewFailureTracker } from "./verdict.ts";
import type { ReviewContext, Verdict } from "./verdict.ts";
import { classifyDivergence, triagePosture, triageSession } from "./triage.ts";
import type { TriageDeps, TriageOutcome } from "./triage.ts";
import {
  VERIFY_FAILURE_CAP,
  decideQueueTick,
  inFlightItem,
  planFromVerify,
} from "./queue-machine.ts";
import type { QueueConfig } from "./queue-machine.ts";
import { applyQueueAction, noteKeyOf } from "./queue-apply.ts";
import type { QueueActions } from "./queue-apply.ts";
import { verifyItem } from "./queue-verify.ts";
import { killLiveReviewers, runClaudeText } from "./structured.ts";

// The Foreman worker: a standalone loop (run via `npm run foreman`) that drains
// the fleet's needs-you queue AND feeds each session's work queue, one session at
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

/** This process's identity for the lease. New per start, by design. */
const WORKER_ID = `${process.pid}-${randomUUID().slice(0, 8)}`;
/** Whether we currently hold the fleet lease. Owned by the renewal timer. */
let isLeader = false;

/**
 * Renew the lease on a BACKGROUND TIMER, not from the loop. This is the
 * difference between a lease that works and one that hands the fleet to two
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
    // because the ask failed is exactly how two workers end up draining the fleet.
    isLeader = r?.leader ?? false;
    if (was && !isLeader) log("lost the lease - standing by");
    if (!was && isLeader) log("acquired the lease - this worker is the leader");
  };
  void beat();
  setInterval(() => void beat(), LEASE_RENEW_MS).unref?.();
}

/**
 * Tear down on an ordinary exit signal. Two things must happen:
 *  - Kill our reviewers. They spawn `detached` (so the fleet poller never sees them
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
      killLiveReviewers();
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
      targets = tickTargets(sessions);
      await sweepOrphanedQueues(client);
    } catch (err) {
      log(`snapshot failed (${String(err)})`);
      await sleep(IDLE_MS);
      continue;
    }

    if (targets.length === 0) {
      await sleep(IDLE_MS);
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
        await processTarget(client, cfg, session, reviews);
      } catch (err) {
        log(`error processing ${session.name} (${session.id}): ${String(err)}`);
      }
      await sleep(BETWEEN_MS);
    }
  }
}

/**
 * The sessions this tick should look at: everyone who needs you (oldest-waiting
 * first, unchanged), then everyone with a work queue.
 *
 * The old loop bailed out entirely when nobody needed you - which is exactly when
 * a work queue should be running.
 */
function tickTargets(sessions: Session[]): Session[] {
  const needsYou = sessions
    .filter((s) => s.agent === "claude" && reportBucket(s, sessions) === "needs-you")
    .sort((a, b) => waitedSince(a) - waitedSince(b));
  const seen = new Set(needsYou.map((s) => s.id));
  const withQueues = sessions.filter(
    (s) =>
      s.agent === "claude" &&
      s.state !== "exited" &&
      !seen.has(s.id) &&
      (s.queue?.openCount ?? 0) > 0,
  );
  return [...needsYou, ...withQueues];
}

function waitedSince(s: Session): number {
  return s.lastActivity ?? s.firstSeen;
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
    // The item's own session is gone, so address the write by the item id via any
    // session id - the daemon resolves items by id, not by the path's session.
    await client
      .setItemState(q.noteKey, flight.id, {
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
 */
async function processTarget(
  client: ForemanClient,
  cfg: ForemanConfig,
  session: Session,
  reviews: ReviewItem[],
): Promise<void> {
  // The FULL queue: Session.queue is only the compact card summary, while the
  // machine needs gaps, baseSha, transcriptAnchor, round, revision and strikes.
  // One extra loopback round-trip per target per tick - noise next to a claude -p.
  const queue = await client.queue(session.id).catch(() => null);

  if (!queue || queue.items.length === 0) {
    // No queue: this session is here because it needs you.
    if (reportBucket(session, [session]) === "needs-you" || session.state === "awaiting_input") {
      await processSession(client, cfg, session, reviews);
    }
    return;
  }

  const qcfg = queueConfig(cfg);
  const sessions = await client.sessions().catch(() => [session]);
  const action = decideQueueTick({
    session,
    bucket: reportBucket(session, sessions),
    queue,
    cfg: qcfg,
    mayActLive: foremanMayActLive(cfg, session.cwd),
    now: Date.now(),
  });

  if (action.kind === "triage") {
    // An unanswered question blocks the item anyway. Tell triage what the queue
    // commissioned, or the two subsystems actively fight: the reviewer can answer
    // "no, don't do that" to a question about the very item Foreman commissioned,
    // or escalate something it could have answered trivially had it known.
    const flight = inFlightItem(queue.items);
    await processSession(client, cfg, session, reviews, queueItemContext(flight));
    return;
  }

  if (action.kind === "verify") {
    await runVerify(client, cfg, session, action.item, qcfg);
    return;
  }

  const outcome = await applyQueueAction(
    queueActions(client, cfg),
    session,
    action,
    qcfg,
    Date.now(),
  );
  if (outcome.kind === "sent") log(`${session.name}: sent item "${oneLine(outcome.item.intent)}"`);
  else if (outcome.kind === "proposed")
    log(`${session.name}: drafted item "${oneLine(outcome.item.intent)}" (awaiting Approve)`);
  else if (outcome.kind === "aborted") log(`${session.name}: held off - ${outcome.why}`);
  else if (outcome.kind === "done") log(`${session.name}: ${outcome.what}`);
}

/** Policy knobs from config; timings from the module constants. */
function queueConfig(cfg: ForemanConfig): QueueConfig {
  return {
    maxFixAttempts: cfg.maxFixAttempts,
    maxFixRounds: cfg.maxFixRounds,
    settleMs: SETTLE_MS,
    pickupTimeoutMs: PICKUP_TIMEOUT_MS,
  };
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
  qcfg: QueueConfig,
): Promise<void> {
  await client
    .setItemState(session.id, item.id, { state: "verifying" })
    .catch(() => {});

  // --- evidence, and the two ways gathering it can fail HONESTLY ---

  const diff = await client.diff(session.id, item.baseSha).catch(() => null);
  if (!diff) return void (await failVerify(client, session, item, qcfg, "could not read the diff"));

  // The base commit is genuinely unreachable (GC'd, or from another checkout).
  // This is verify-INFRASTRUCTURE broken, not a gap and not a transient: without
  // the fix in computeSessionDiff this returned ok:true with a working-tree-only
  // diff, so the verifier would see near-nothing for completed work and invent
  // gaps. Escalate immediately - never burn rounds on phantom gaps.
  if (!diff.ok && item.baseSha) {
    await client.setItemState(session.id, item.id, {
      state: "escalated",
      escalationReason: `${diff.error ?? "the base commit is gone"} - verify this item by hand`,
    });
    log(`${session.name}: base commit unreachable; escalated for a manual check`);
    return;
  }

  const anchor = item.transcriptAnchor;
  const window =
    anchor !== null
      ? await client.transcriptSince(session.id, anchor).catch(() => null)
      : await client.transcript(session.id).catch(() => null);
  if (!window) {
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
    // The diff is cumulative whenever the agent doesn't commit, so anything before
    // this item's base may be an earlier item's uncommitted work.
    diffMayIncludeOtherWork: item.baseSha === null || diff.baseSha !== item.baseSha,
    transcript: window.messages,
    transcriptTruncated: window.truncated,
    standards: standards.docs,
    standardsTruncated: standards.truncated,
    priorGaps: item.gaps,
  });

  if (result.kind === "failed") {
    return void (await failVerify(client, session, item, qcfg, result.reason));
  }

  const plan = planFromVerify(item, result.verdict, foremanMayActLive(cfg, session.cwd), qcfg);
  await client.setItemState(session.id, item.id, {
    state: plan.state,
    round: plan.round,
    gaps: plan.gaps,
    escalationReason: plan.escalationReason,
    lastVerdict: plan.lastVerdict,
    // A verdict is evidence about the work, so it clears the transient-failure
    // count - the same "onSuccess" shape ReviewFailureTracker uses.
    verifyFailures: 0,
  });
  log(
    `${session.name}: verified "${oneLine(item.intent)}" -> ${plan.state}` +
      (plan.state === "sending" || plan.state === "proposed" ? ` (round ${plan.round})` : ""),
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

/** Review + act on one session, unless we've already handled its current prompt. */
async function processSession(
  client: ForemanClient,
  cfg: ForemanConfig,
  session: Session,
  reviews: ReviewItem[],
  queueItem?: ReviewInput["queueItem"],
): Promise<void> {
  const pending = classifyPending(session, reviews);

  // Idempotency: don't re-handle a prompt whose marker we've already stamped.
  const existing = await client.note(session.id).catch(() => null);
  if (existing?.handledMarker === pending.marker) return;

  // Debounce: the check above skips an UNCHANGED episode for free, but a *changed*
  // marker (a new review, or a terminal whose `lastActivity` moved) would otherwise
  // spawn a full review immediately. Hold each session to at most one evaluation per
  // window so a flapping marker can't burn a `claude -p` on every loop; a session seen
  // for the first time is due at once, so genuinely new work is never delayed.
  if (!evaluations.claim(session.id)) return;

  const ctx: ReviewContext = {
    sessionId: session.id,
    repoRoot: session.cwd,
    promptMarker: pending.marker,
    inputReviewId: pending.inputReviewId,
    canSend: pending.canSend,
  };

  // Resolve the verdict through the tier ladder (off / shadow / on). A null here means
  // the outcome was already handled - a transient review failure that will retry, or a
  // give-up note that was already written - so there's nothing left to apply.
  const decision = await decide(client, cfg, session, pending, ctx, queueItem);
  if (!decision) return;
  const { verdict, tier } = decision;

  let plan = planFromVerdict(
    verdict,
    ctx,
    foremanMayActLive(cfg, session.cwd),
    cfg.autoApproveAccess,
  );

  // The review may have spawned a fresh `claude -p` that ran for up to two minutes, so
  // both the fleet snapshot and the config are stale by the time we're ready to act.
  // Before a LIVE send, re-confirm against a fresh fleet that this session still
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
      log(`${session.name}: skipped stale send (session changed during review)`);
      return;
    }
    const freshCfg = await client.getConfig().catch(() => null);
    plan = planFromVerdict(
      verdict,
      ctx,
      !!freshCfg && foremanMayActLive(freshCfg, session.cwd),
      (freshCfg ?? cfg).autoApproveAccess,
    );
    if (!plan.send) {
      log(`${session.name}: config changed during review; drafting instead of sending`);
    }
  }

  await applyVerdict(client, ctx, plan);
  log(
    `${session.name}: [tier ${tier}] ${verdict.action}/${verdict.classification} -> ${plan.note.disposition}` +
      (plan.send ? " (sent)" : ""),
  );
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
  queueItem?: ReviewInput["queueItem"],
): Promise<Decision> {
  switch (triagePosture(cfg.triage)) {
    case "off":
      return fullReviewOnly(client, session, pending, ctx, queueItem);
    case "shadow":
      return shadowBoth(client, cfg, session, pending, ctx, queueItem);
    case "on":
      return cheapTierDecides(client, cfg, session, pending, ctx, queueItem);
  }
}

/** `off`: the pre-triage behaviour - every new marker gets a full review. */
async function fullReviewOnly(
  client: ForemanClient,
  session: Session,
  pending: Pending,
  ctx: ReviewContext,
  queueItem?: ReviewInput["queueItem"],
): Promise<Decision> {
  const r = await fullReview(client, session, pending, ctx, queueItem);
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
  queueItem?: ReviewInput["queueItem"],
): Promise<Decision> {
  const [cheap, r] = await Promise.all([
    triageSession(triageDeps(client), pending, session, cfg),
    fullReview(client, session, pending, ctx, queueItem),
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
  queueItem?: ReviewInput["queueItem"],
): Promise<Decision> {
  const cheap = await triageSession(triageDeps(client), pending, session, cfg);
  if (cheap.kind === "dispose") {
    log(`${session.name}: tier ${cheap.tier} disposed -> ${cheap.verdict.action} (${cheap.reason})`);
    return { verdict: cheap.verdict, tier: cheap.tier };
  }
  log(`${session.name}: routed up to full review (${cheap.reason})`);
  return fullReviewOnly(client, session, pending, ctx, queueItem);
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
  queueItem?: ReviewInput["queueItem"],
): Promise<{ verdict: Verdict } | null> {
  const window = await client.transcript(session.id).catch(() => ({ messages: [], truncated: false }));
  const input: ReviewInput = {
    session: {
      name: session.name,
      cwd: session.cwd,
      gitBranch: session.gitBranch,
      state: session.state,
      activity: session.activity,
    },
    surface: pending.surface,
    question: pending.question,
    transcript: window.messages,
    truncated: window.truncated,
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
 * exact prompt. A fresh fleet + reviews snapshot guards the send against a queue
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
