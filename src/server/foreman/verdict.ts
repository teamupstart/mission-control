import { z } from "zod";
import type { ForemanConfig, SetNote } from "@shared/protocol.ts";
import { foremanAllowlisted } from "@shared/foreman.ts";
import type { GateRef } from "./pending.ts";

// The Foreman review verdict + the deterministic mapping from a verdict to the
// concrete actions the worker takes. Kept pure and free of I/O so it's unit
// tested exhaustively: the model produces judgment (the verdict); this file
// decides, given the operating mode and what reply channel actually exists,
// exactly which note is written and whether a reply is sent.

/** The structured judgment a fresh `claude -p` reviewer must return. */
export const VerdictSchema = z
  .object({
    /** 1-2 sentence purpose, always required (even when it can't answer). */
    purpose: z.string().min(1),
    classification: z.enum([
      "implementation",
      "access",
      "design-fork",
      "intent-unclear",
      "other",
    ]),
    action: z.enum(["answer", "escalate", "skip"]),
    /** The reply to deliver, when action === "answer". */
    answer: z
      .object({
        text: z.string().min(1),
        submit: z.boolean().optional().default(true),
      })
      .optional(),
    /** Foreman's recommended answer, shown for escalate + dry-run drafts. */
    recommendation: z.string().optional(),
    /** Decision-brief markdown for an escalation (the question + the options). */
    brief: z.string().optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .refine((v) => v.action !== "answer" || !!v.answer?.text, {
    message: "answer action requires answer.text",
  });
export type Verdict = z.infer<typeof VerdictSchema>;

/** What the worker knows about a session's pending prompt when applying a verdict. */
export interface ReviewContext {
  sessionId: string;
  /** Stable id of the prompt being handled - stamped as the note's handledMarker. */
  promptMarker: string;
  /** A pending MCP `input` review's id, if the ask arrived that way. */
  inputReviewId: string | null;
  /** True when the session has a pane we can type into (tmux/wezterm). */
  canSend: boolean;
  /**
   * Which no-mistakes gate this prompt is, when it is one - so a send can be
   * recorded against the round it answered. Null for every other situation.
   */
  gate?: GateRef | null;
}

/** A resolved send instruction the worker will execute (or null: nothing to send). */
export interface SendPlan {
  channel: "send" | "review";
  text: string;
  reviewId?: string;
  submit: boolean;
}

/** The concrete outcome of a verdict: the note to write + an optional reply. */
export interface VerdictPlan {
  note: SetNote;
  send: SendPlan | null;
}

/**
 * Pick the reply channel from *reality*, not the model's hint: an unblocking
 * `input` review answer wins (it releases the blocked agent cleanly), else a
 * terminal send when the session has a pane, else null (nothing can be delivered).
 */
function pickChannel(ctx: ReviewContext): { channel: "send" | "review"; reviewId?: string } | null {
  if (ctx.inputReviewId) return { channel: "review", reviewId: ctx.inputReviewId };
  if (ctx.canSend) return { channel: "send" };
  return null;
}

/**
 * Map a verdict to the note + reply, given whether Foreman is cleared to act
 * *live* for this session (config live + repo allowlisted). Everything that
 * isn't a live, deliverable answer becomes a non-sending draft or an escalation,
 * so dry-run / semi-auto / off-allowlist never type into a session. When
 * `autoApproveAccess` is false, an `access` answer is escalated (with the drafted
 * reply as the recommendation) instead of being sent, honouring the config switch.
 */
export function planFromVerdict(
  v: Verdict,
  ctx: ReviewContext,
  mayActLive: boolean,
  autoApproveAccess = true,
): VerdictPlan {
  const base: SetNote = { purpose: v.purpose, handledMarker: ctx.promptMarker };

  if (v.action === "skip") {
    return {
      note: {
        ...base,
        disposition: "skipped",
        brief: null,
        recommendation: null,
        lastAction: `skipped${v.brief ? `: ${oneLine(v.brief)}` : ""}`,
      },
      send: null,
    };
  }

  if (v.action === "escalate") {
    return {
      note: {
        ...base,
        disposition: "escalated",
        brief: v.brief ?? null,
        recommendation: v.recommendation ?? null,
        lastAction: "escalated for your decision",
      },
      send: null,
    };
  }

  // action === "answer"
  const answer = v.answer!; // guaranteed by the schema refine

  if (!autoApproveAccess && v.classification === "access") {
    // Access auto-approval is switched off: hand the approval to the human with
    // Foreman's drafted reply as the recommendation instead of sending it.
    return {
      note: {
        ...base,
        disposition: "escalated",
        brief: v.brief ?? null,
        recommendation: answer.text,
        lastAction: "escalated (access auto-approval disabled)",
      },
      send: null,
    };
  }

  const chan = pickChannel(ctx);
  if (!chan) {
    // Wanted to answer but there's no channel to deliver it - hand it to the human
    // with the drafted reply as the recommendation rather than dropping it.
    return {
      note: {
        ...base,
        disposition: "escalated",
        brief: v.brief ?? null,
        recommendation: answer.text,
        lastAction: "escalated (no reply channel)",
      },
      send: null,
    };
  }

  if (mayActLive) {
    return {
      note: {
        ...base,
        disposition: "answered",
        brief: null,
        recommendation: null,
        lastAction: `answered: ${oneLine(answer.text)}`,
      },
      send: {
        channel: chan.channel,
        text: answer.text,
        reviewId: chan.reviewId,
        submit: answer.submit ?? true,
      },
    };
  }

  // dry-run / semi-auto / live-but-not-allowlisted: draft, never send.
  return {
    note: {
      ...base,
      disposition: "pending",
      brief: v.brief ?? null,
      recommendation: answer.text,
      lastAction: "drafted a reply (awaiting you)",
    },
    send: null,
  };
}

/** Consecutive transient review failures tolerated before Foreman gives up on a prompt. */
export const REVIEW_FAILURE_CAP = 3;

/** What the worker should do after a transient review failure. */
export type FailureOutcome =
  | { retry: true }
  | { retry: false; note: SetNote };

/**
 * Tracks consecutive transient reviewer failures (spawn/timeout/parse-miss) per
 * session so a one-off blip retries instead of permanently stamping the prompt's
 * marker (which the worker's idempotency check would then never re-review). Under
 * the cap it says "retry" (write nothing, leave the item queued); at the cap it
 * gives up with a marker-stamped skip note so a persistently-broken reviewer stops
 * re-spawning `claude -p` every loop. The count is keyed per session and reset
 * whenever the prompt marker changes (a new waiting episode) or a review succeeds,
 * so it stays bounded and never carries a stale strike into a fresh prompt. Pure.
 */
export class ReviewFailureTracker {
  private bySession = new Map<string, { marker: string; count: number }>();

  /** Record a transient failure for this session's current prompt; decide retry vs give-up. */
  onFailure(ctx: ReviewContext, reason: string): FailureOutcome {
    const prev = this.bySession.get(ctx.sessionId);
    const count = prev && prev.marker === ctx.promptMarker ? prev.count + 1 : 1;
    this.bySession.set(ctx.sessionId, { marker: ctx.promptMarker, count });
    if (count < REVIEW_FAILURE_CAP) return { retry: true };
    return {
      retry: false,
      note: {
        purpose: reason,
        handledMarker: ctx.promptMarker,
        disposition: "skipped",
        brief: null,
        recommendation: null,
        lastAction: `skipped (reviewer failed ${count}x)`,
      },
    };
  }

  /** Forget a session's strikes after a review that produced a real verdict. */
  onSuccess(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}

/** Minimal daemon surface `applyVerdict` needs, so tests can inject a fake. */
export interface ForemanActions {
  putNote(sessionId: string, patch: SetNote): Promise<unknown>;
  sendText(sessionId: string, text: string, submit: boolean): Promise<unknown>;
  resolveReview(reviewId: string, action: "answer", response: string): Promise<unknown>;
  /**
   * Record what we just said to a no-mistakes gate, for the fix log's byline.
   *
   * On the actions interface rather than as a direct `logEvent`, because the
   * worker is a separate PROCESS: it reaches the daemon only over the localhost
   * API and never touches the DB (see worker.ts). So this is a route call like
   * every other write here, and the same injection seam the tests already use.
   */
  logGateReply(sessionId: string, gate: GateRef, text: string): Promise<unknown>;
}

/**
 * Execute a plan. For a draft (no send) just write the note. For a send, deliver
 * the reply FIRST and only stamp the answered note (with its handledMarker) once
 * the send succeeds - so a failed send never leaves a false "answered" note that
 * the worker's idempotency check would then refuse to retry. On send failure the
 * purpose is still recorded (without the marker) and the error is rethrown so the
 * worker logs it and the session stays queued for a retry.
 *
 * A send that answered a no-mistakes gate is also recorded against that gate, so
 * the fix log can put a byline on whatever reply it produces. Only a DELIVERED
 * send is logged: words the agent never saw caused nothing, and claiming
 * otherwise on the card would be a fabricated byline. Undelivered has TWO shapes
 * here, and they are easy to mistake for one:
 *   - no send at all (dry-run / semi-auto / off-allowlist), which returns above;
 *   - `submit: false`, which types the text and never presses Enter, leaving it
 *     sitting unsubmitted in the pane (queue-machine.ts names the same state) with
 *     the gate still parked. The send SUCCEEDS, so nothing else here notices.
 */
export async function applyVerdict(
  actions: ForemanActions,
  ctx: ReviewContext,
  plan: VerdictPlan,
): Promise<void> {
  if (!plan.send) {
    await actions.putNote(ctx.sessionId, plan.note);
    return;
  }
  try {
    if (plan.send.channel === "review" && plan.send.reviewId) {
      await actions.resolveReview(plan.send.reviewId, "answer", plan.send.text);
    } else {
      await actions.sendText(ctx.sessionId, plan.send.text, plan.send.submit);
    }
  } catch (err) {
    if (plan.note.purpose) {
      await actions
        .putNote(ctx.sessionId, { purpose: plan.note.purpose, disposition: "skipped" })
        .catch(() => {});
    }
    throw err;
  }
  // The gate is only ever set for a `gate-parked` prompt (classifyPending sets it
  // nowhere else), so the "log gate replies only" rule is structural here rather
  // than a situation string re-checked in a second place that could drift.
  // `submit` is the model's to choose, so the delivery half is not structural and
  // has to be read off the plan we just executed.
  //
  // Swallowed on purpose, and it is the ONLY swallow here that costs nothing real:
  // the reply is already delivered and the note still stamps, so a failure loses a
  // byline - the card reads `replied` with no author, exactly as it did before this
  // existed. Letting it throw would instead skip the note below and leave a
  // delivered send unstamped, which the worker's idempotency check would re-send.
  if (ctx.gate && plan.send.submit) {
    await actions
      .logGateReply(ctx.sessionId, ctx.gate, plan.send.text)
      .catch((err) => console.error("[foreman] could not record the gate reply:", err));
  }
  await actions.putNote(ctx.sessionId, plan.note);
}

/** Collapse whitespace and cap a string to one short line for the audit field. */
function oneLine(s: string, max = 80): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * True when Foreman is cleared to *send* for a session: config enabled + live, and
 * the session is allowlisted - either its `cwd` sits under an allowlisted root, or
 * it's a worktree OF an allowlisted repo (`repoRoot`, from git's common dir).
 * Dry-run / semi-auto / off-allowlist all return false, so they draft instead of
 * typing into a session. Pure.
 *
 * `repoRoot` is optional so a caller without one (a test, or a session whose git
 * resolution failed) degrades to the old cwd-prefix rule rather than throwing -
 * fail-closed: a missing repoRoot can only ever withhold a send, never grant one.
 */
export function foremanMayActLive(
  cfg: ForemanConfig,
  cwd: string | null,
  repoRoot: string | null = null,
): boolean {
  if (!cfg.enabled || cfg.mode !== "live") return false;
  return foremanAllowlisted(cwd, repoRoot, cfg.repoAllowlist);
}
