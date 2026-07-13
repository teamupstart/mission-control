import type { ReviewItem, Session } from "@shared/types.ts";
import { reportBucket } from "@shared/session.ts";
import { ForemanClient } from "./client.ts";
import { reviewSession } from "./review.ts";
import type { ReviewInput } from "./prompt.ts";
import { applyVerdict, foremanMayActLive, planFromVerdict } from "./verdict.ts";
import type { ReviewContext } from "./verdict.ts";

// The Foreman worker: a standalone loop (run via `npm run foreman`) that drains
// the fleet's needs-you queue one session at a time, reviewing each in a FRESH
// `claude -p` process so context never bleeds between sessions. It reaches the
// daemon only over the localhost API - it never touches the DB directly - so it
// is a plain client that can run in its own terminal, exactly as designed.

/** How often to poll while idle or disabled. */
const IDLE_MS = 4000;
/** Small breather between processing two sessions. */
const BETWEEN_MS = 400;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

  const verdict = await reviewSession(input);
  const ctx: ReviewContext = {
    sessionId: session.id,
    repoRoot: session.cwd,
    promptMarker: pending.marker,
    inputReviewId: pending.inputReviewId,
    canSend: pending.canSend,
  };
  let plan = planFromVerdict(
    verdict,
    ctx,
    foremanMayActLive(cfg, session.cwd),
    cfg.autoApproveAccess,
  );

  // The review spawned a fresh `claude -p` that can run for up to two minutes, so
  // both the fleet snapshot and the config are stale by the time we're ready to act.
  // Before a LIVE send, re-confirm against a fresh fleet that this session still
  // needs *this* exact prompt; if the human already handled it (answered, left
  // needs-you, or a newer prompt arrived), skip the send but still record the
  // purpose. Then re-read the config and downgrade to a non-sending draft if the
  // operator disabled Foreman, left live mode, or dropped the repo from the
  // allowlist mid-review - "disable stops acting" must hold even for an in-flight review.
  if (plan.send) {
    if (!(await sendStillValid(client, session.id, pending))) {
      await client.putNote(session.id, { purpose: verdict.purpose }).catch(() => {});
      log(`${session.name}: skipped stale send (session changed during review)`);
      return;
    }
    const freshCfg = await client.getConfig().catch(() => null);
    if (!freshCfg || !foremanMayActLive(freshCfg, session.cwd)) {
      plan = planFromVerdict(
        verdict,
        ctx,
        false,
        (freshCfg ?? cfg).autoApproveAccess,
      );
      log(`${session.name}: config changed during review; drafting instead of sending`);
    }
  }

  await applyVerdict(client, ctx, plan);
  log(
    `${session.name}: ${verdict.action}/${verdict.classification} -> ${plan.note.disposition}` +
      (plan.send ? " (sent)" : ""),
  );
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

interface Pending {
  surface: "input-review" | "terminal";
  question: string;
  /** Set only for an `input` review, the one surface Foreman resolves via the API. */
  inputReviewId: string | null;
  /** Whether a terminal reply can be typed (a pane exists and the ask is terminal). */
  canSend: boolean;
  /** Stable id of this waiting episode, stamped as the note's handledMarker. */
  marker: string;
}

/**
 * Work out what a needs-you session is actually blocked on, and how (if at all)
 * Foreman may reply. An `input` review is directly answerable (resolve it); a
 * plan/diff review is not (Foreman can only frame it); a terminal `awaiting_input`
 * is answerable by typing when a pane exists; anything else is purpose-only.
 */
function classifyPending(s: Session, reviews: ReviewItem[]): Pending {
  const pend = reviews.filter((r) => r.sessionId === s.id && r.status === "pending");
  const inputReview = pend.find((r) => r.kind === "input");
  if (inputReview) {
    return {
      surface: "input-review",
      question: inputReview.body,
      inputReviewId: inputReview.id,
      canSend: false,
      marker: `review:${inputReview.id}`,
    };
  }
  const other = pend[0];
  if (other) {
    return {
      surface: "input-review",
      question:
        `The child posted a ${other.kind} titled "${other.title}" for review. You cannot ` +
        `auto-approve a ${other.kind}; write the purpose and escalate if it needs the human.`,
      inputReviewId: null,
      canSend: false,
      marker: `review:${other.id}`,
    };
  }
  if (s.state === "awaiting_input") {
    return {
      surface: "terminal",
      question: s.activity ?? "",
      inputReviewId: null,
      canSend: Boolean(s.tmux || s.wezterm),
      marker: `await:${s.lastActivity ?? s.firstSeen}`,
    };
  }
  return {
    surface: "terminal",
    question: s.activity ?? "(the session needs you, but no explicit question was found)",
    inputReviewId: null,
    canSend: false,
    marker: `state:${s.state}:${s.lastActivity ?? s.firstSeen}`,
  };
}

function log(msg: string): void {
  console.log(`[foreman] ${msg}`);
}

main().catch((err) => {
  console.error("[foreman] fatal:", err);
  process.exit(1);
});
