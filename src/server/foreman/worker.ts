import type { ReviewItem, Session } from "@shared/types.ts";
import { reportBucket } from "@shared/session.ts";
import { ForemanClient } from "./client.ts";
import { reviewSession, runClaudeText } from "./review.ts";
import { EvaluationDebounce } from "./debounce.ts";
import { classifyPending } from "./pending.ts";
import type { Pending } from "./pending.ts";
import type { ReviewInput } from "./prompt.ts";
import { applyVerdict, foremanMayActLive, planFromVerdict, ReviewFailureTracker } from "./verdict.ts";
import type { ReviewContext, Verdict } from "./verdict.ts";
import { classifyDivergence, triageSession } from "./triage.ts";
import type { TriageDeps, TriageOutcome } from "./triage.ts";

// The Foreman worker: a standalone loop (run via `npm run foreman`) that drains
// the fleet's needs-you queue one session at a time, reviewing each in a FRESH
// `claude -p` process so context never bleeds between sessions. It reaches the
// daemon only over the localhost API - it never touches the DB directly - so it
// is a plain client that can run in its own terminal, exactly as designed.
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Consecutive review-failure strikes, so a transient blip retries instead of a permanent skip. */
const reviewFailures = new ReviewFailureTracker();
/** Per-session cooldown so a flapping marker can't trigger back-to-back reviews. */
const evaluations = new EvaluationDebounce(EVAL_DEBOUNCE_MS);

async function main(): Promise<void> {
  const client = new ForemanClient();
  log("Foreman worker started; watching the needs-you queue.");

  for (;;) {
    await client.heartbeat();

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

    let queue: Session[] = [];
    let reviews: ReviewItem[] = [];
    try {
      const sessions = await client.sessions();
      reviews = await client.reviews();
      queue = needsYouQueue(sessions);
    } catch (err) {
      log(`snapshot failed (${String(err)})`);
      await sleep(IDLE_MS);
      continue;
    }

    if (queue.length === 0) {
      await sleep(IDLE_MS);
      continue;
    }

    for (const session of queue) {
      // Each review spawns a `claude -p` that can run for minutes, far longer than
      // the heartbeat TTL, so beat again before every session or the dashboard would
      // read "not running" mid-drain.
      await client.heartbeat();

      // Honour a mid-drain disable/mode change without finishing the whole queue.
      try {
        cfg = await client.getConfig();
      } catch {
        break;
      }
      if (!cfg.enabled) break;

      try {
        await processSession(client, cfg, session, reviews);
      } catch (err) {
        log(`error processing ${session.name} (${session.id}): ${String(err)}`);
      }
      await sleep(BETWEEN_MS);
    }
  }
}

/** Needs-you claude sessions, oldest-waiting first. */
function needsYouQueue(sessions: Session[]): Session[] {
  return sessions
    .filter((s) => s.agent === "claude" && reportBucket(s, sessions) === "needs-you")
    .sort((a, b) => waitedSince(a) - waitedSince(b));
}

function waitedSince(s: Session): number {
  return s.lastActivity ?? s.firstSeen;
}

/** Review + act on one session, unless we've already handled its current prompt. */
async function processSession(
  client: ForemanClient,
  cfg: Awaited<ReturnType<ForemanClient["getConfig"]>>,
  session: Session,
  reviews: ReviewItem[],
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
  const decision = await decide(client, cfg, session, pending, ctx);
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
 * Resolve a verdict for one session through the tier ladder, honouring the `triage`
 * config. Returns the verdict + which tier produced it, or null when the outcome was
 * already fully handled (a transient failure retry, or a give-up note).
 */
async function decide(
  client: ForemanClient,
  cfg: Awaited<ReturnType<ForemanClient["getConfig"]>>,
  session: Session,
  pending: Pending,
  ctx: ReviewContext,
): Promise<{ verdict: Verdict; tier: 0 | 1 | 2 } | null> {
  if (cfg.triage === "off") {
    const r = await fullReview(client, session, pending, ctx);
    return r && { verdict: r.verdict, tier: 2 };
  }

  const deps = triageDeps(client);

  if (cfg.triage === "shadow") {
    // Run the cheap tier AND the full review, act on the full review, and log the
    // divergence. Concurrent, so the cheap call adds no serial latency to the queue.
    const [cheap, r] = await Promise.all([
      triageSession(deps, pending, session, cfg),
      fullReview(client, session, pending, ctx),
    ]);
    if (!r) return null; // full review failed + handled; don't act on the cheap tier
    log(
      `${session.name}: shadow ${classifyDivergence(cheap, r.verdict)} ` +
        `(cheap=${describeCheap(cheap)} opus=${r.verdict.action}/${r.verdict.classification})`,
    );
    return { verdict: r.verdict, tier: 2 };
  }

  // cfg.triage === "on": the cheap tier decides; the full review fires only on route-up.
  const cheap = await triageSession(deps, pending, session, cfg);
  if (cheap.kind === "dispose") {
    log(`${session.name}: tier ${cheap.tier} disposed -> ${cheap.verdict.action} (${cheap.reason})`);
    return { verdict: cheap.verdict, tier: cheap.tier };
  }
  log(`${session.name}: routed up to full review (${cheap.reason})`);
  const r = await fullReview(client, session, pending, ctx);
  return r && { verdict: r.verdict, tier: 2 };
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
    runModel: (prompt, model) => runClaudeText(prompt, { model }),
  };
}

/** One-line description of a cheap-tier outcome, for the shadow-divergence log. */
function describeCheap(cheap: TriageOutcome): string {
  return cheap.kind === "route-up" ? "route-up" : `tier${cheap.tier}:${cheap.verdict.action}`;
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
