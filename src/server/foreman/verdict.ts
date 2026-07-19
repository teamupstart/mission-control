import { z } from "zod";
import type { ForemanConfig, RecordEpisode, SetNote } from "@shared/protocol.ts";
import { foremanAllowlisted } from "@shared/foreman.ts";
import { optionRowMiss } from "../discovery/pane-dialog.ts";
import type { PaneDialog } from "../discovery/pane-dialog.ts";
import type { GateRef, Pending } from "./pending.ts";

// The Foreman review verdict + the deterministic mapping from a verdict to the
// concrete actions the worker takes. Kept pure and free of I/O so it's unit
// tested exhaustively: the model produces judgment (the verdict); this file
// decides, given the operating mode and what reply channel actually exists,
// exactly which note is written and whether a reply is sent.

/**
 * An `answer` field that reads a TEXTLESS answer as absent rather than as a malformed reply.
 *
 * The prompt hands the model the whole object shape, so a reviewer with nothing to send fills
 * the field in regardless: `"answer": {"text": ""}` next to `"action": "skip"` is what a real
 * reviewer actually returns, measured against the live sessions. A bare `text: z.string().min(1)`
 * failed the WHOLE object on it, `runStructured` retried, and after three strikes the worker
 * gave up and wrote `skipped (reviewer failed 3x)` - discarding a well-formed judgment, purpose
 * and recommendation and all, over an empty field that the action it names never reads. The
 * symptom reached the human as Foreman going quiet on a session, which is indistinguishable
 * from the reviewer having nothing to say. Three Opus calls bought that silence, every time.
 *
 * Normalized to `undefined` rather than relaxing `min(1)`, so the invariant the rest of this
 * file leans on holds unchanged: an `answer` that is PRESENT has text worth sending (see
 * `planFromVerdict`'s `v.answer!`). The refine below still rejects `action: "answer"` carrying
 * nothing to send - an empty answer is only ever tolerated for an action that ignores it, and
 * that case must keep failing rather than send an empty line into someone's terminal.
 */
const AnswerField = z.preprocess(
  (v) => (textlessAnswer(v) ? undefined : v),
  z
    .object({
      text: z.string().min(1),
      submit: z.boolean().optional().default(true),
      /**
       * The menu row to select, when the child is showing one. Required to answer a menu at
       * all - `text` is prose, and prose is not an answer to a menu (see `pane-dialog.ts`);
       * on this surface it is recorded as the rationale and never typed.
       *
       * Both halves are carried because they check each other: the number says where to
       * navigate, and the label says what that position must still read when we get there.
       */
      option: z
        .object({
          number: z.number().int().min(1).max(99),
          label: z.string().min(1),
        })
        .optional(),
    })
    .optional(),
);

/**
 * Whether an `answer` carries no text to send: absent, null, or text that is empty/whitespace.
 *
 * A non-string `text` is deliberately NOT swallowed - that is a reply we genuinely can't read,
 * so it must fail validation and retry rather than be silently rewritten to "no answer".
 *
 * Exported for the Tier 1 report schema, which is handed the same shape by the same kind of
 * model and so grew the same defect independently. One predicate, so a fix to what counts as
 * "no answer" can't land on one tier and not the other.
 */
export function textlessAnswer(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v !== "object") return false;
  const { text } = v as { text?: unknown };
  return text === undefined || (typeof text === "string" && text.trim() === "");
}

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
    /** The reply to deliver, when action === "answer". Textless reads as absent - see `AnswerField`. */
    answer: AnswerField,
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
  /**
   * The option menu the child's pane was showing when the reviewer read it, if any.
   *
   * Present, it changes what an answer even IS on this surface: not text to type but a row
   * to select. It is also what makes a prose-only answer detectable as unanswerable here,
   * which is the whole of the fix - the old path could not tell a menu from a prompt, so it
   * typed at both and the menu confirmed its default.
   */
  menu?: PaneDialog | null;
}

/** A resolved send instruction the worker will execute (or null: nothing to send). */
export interface SendPlan {
  channel: "send" | "review";
  text: string;
  reviewId?: string;
  submit: boolean;
  /**
   * Set only for a menu: the row to select instead of typing `text`. The worker delivers
   * this with arrow keys and an Enter (`selectPaneOption`); `text` rides along as the
   * rationale for the note and the gate byline, and is never typed.
   */
  option?: { number: number; label: string };
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

  // A menu on the pane is answered by selecting a row, so an answer that names no row (or
  // names one the screen doesn't have) cannot be delivered here. Escalating rather than
  // falling back to typing is the fix itself: the fallback is what silently confirmed the
  // default and signed the human's name to it. The reviewer's reasoning is kept as the
  // recommendation, so its judgment reaches the human even though it couldn't reach the child.
  const menuMiss = chan.channel === "send" ? menuMismatch(ctx.menu, answer.option) : null;
  if (menuMiss) {
    return {
      note: {
        ...base,
        disposition: "escalated",
        brief: v.brief ?? null,
        recommendation: answer.text,
        lastAction: `escalated (${menuMiss})`,
      },
      send: null,
    };
  }

  if (mayActLive) {
    // Only a menu send carries the option: `pickChannel` can route to an `input-review`
    // (answered over the API, no pane involved) while a menu happens to be on the screen,
    // and an option there would be a row nothing navigates.
    const option = ctx.menu && chan.channel === "send" ? answer.option : undefined;
    return {
      note: {
        ...base,
        disposition: "answered",
        brief: null,
        recommendation: null,
        lastAction: option
          ? `answered: option ${option.number}. ${oneLine(option.label, 60)}`
          : `answered: ${oneLine(answer.text)}`,
      },
      send: {
        channel: chan.channel,
        text: answer.text,
        reviewId: chan.reviewId,
        submit: answer.submit ?? true,
        ...(option ? { option } : {}),
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

/**
 * Everything worth remembering about one decision, from the state that is about to
 * be dropped.
 *
 * Pure, and extracted from `processSession` for the same reason `classifyPending`
 * was: `worker.ts` calls `main()` at import, so anything left inline there can never
 * be unit-tested. This mapping decides what the record says about an act that has
 * already happened and cannot be replayed, so it is exactly the wrong thing to leave
 * untestable.
 *
 * Call it only AFTER the plan has been executed. `plan.send` describes what was
 * *intended* until then, and a send that throws must leave no episode at all - the
 * same rule `applyVerdict` already applies to the note.
 */
export function episodeFromPlan(p: {
  pending: Pending;
  ctx: ReviewContext;
  /** The child's screen, captured once by the worker before the review. */
  pane: string | null;
  verdict: Verdict;
  tier: number;
  plan: VerdictPlan;
}): RecordEpisode {
  const { pending, ctx, pane, verdict, tier, plan } = p;
  const send = plan.send;
  return {
    marker: pending.marker,
    situation: pending.situation,
    surface: pending.surface,
    question: pending.question,
    // Terminal surfaces only. An `input` review's question is already durable in
    // `reviews.body`, so a copy here could only drift from it - and a pane captured
    // for a review is a screen that happens to be behind the ask, not the ask.
    pane: pending.surface === "terminal" ? pane : null,
    menu: ctx.menu ?? null,
    reviewId: pending.inputReviewId,
    purpose: verdict.purpose,
    // The brief comes from the VERDICT, the recommendation from the PLAN, and the
    // asymmetry is the point.
    //
    // `brief` is Foreman's reasoning, which the plan nulls on the paths where it is
    // no longer live (skip, answer). Keeping the verdict's copy is the whole reason
    // this table exists - the record must outlive what the card stops showing.
    //
    // `recommendation` is different: the plan RESOLVES which text is being
    // recommended for this disposition, and they are not the same string. An
    // escalation recommends `verdict.recommendation`; a draft recommends the answer
    // it would have sent (`answer.text`). Reading the verdict's field for a draft
    // would file a recommendation the human was never shown, next to a purpose and a
    // brief that were.
    brief: verdict.brief ?? null,
    recommendation: plan.note.recommendation ?? null,
    classification: verdict.classification,
    confidence: verdict.confidence ?? null,
    tier,
    disposition: plan.note.disposition ?? "skipped",
    lastAction: plan.note.lastAction ?? null,
    // What actually reached the child. A menu send types NOTHING - the row's label is
    // the whole of what it received, and `text` rides along only as the rationale -
    // so the label is the sent text there, exactly as the gate byline reads it.
    sentText: send ? (send.option ? send.option.label : send.text) : null,
    sentOption: send?.option ?? null,
    sentBy: send ? "foreman" : null,
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
  /**
   * Select a row of the menu the child is showing. Separate from `sendText` because it is
   * a different act, not a different payload: no text is typed, and the daemon verifies the
   * row against the live screen before confirming it (see `selectPaneOption`).
   */
  selectOption(sessionId: string, option: { number: number; label: string }): Promise<unknown>;
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
 * send is logged, and only the words actually delivered: words the agent never saw
 * caused nothing, and claiming otherwise on the card would be a fabricated byline.
 * Undelivered has TWO shapes here, and they are easy to mistake for one:
 *   - no send at all (dry-run / semi-auto / off-allowlist), which returns above;
 *   - `submit: false`, which types the text and never presses Enter, leaving it
 *     sitting unsubmitted in the pane (queue-machine.ts names the same state) with
 *     the gate still parked. The send SUCCEEDS, so nothing else here notices.
 *
 * A menu send is a third shape, and it inverts both halves. `text` is the rationale
 * and is NEVER typed - the row's label is the whole of what the child received - so
 * the byline has to quote the label. And `submit` is not a delivery question there:
 * `selectOption` always presses the Enter, so gating the log on it would drop the
 * byline for a reply that did land.
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
    } else if (plan.send.option) {
      // A menu: select the row. This THROWS when the daemon can't confirm the row is the
      // one on screen, which lands in the catch below and leaves the session queued with a
      // `skipped` note - the child untouched, still parked, for the next sweep or a human.
      await actions.selectOption(ctx.sessionId, plan.send.option);
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
  const delivered = plan.send.option ? plan.send.option.label : plan.send.submit ? plan.send.text : null;
  if (ctx.gate && delivered !== null) {
    await actions
      .logGateReply(ctx.sessionId, ctx.gate, delivered)
      .catch((err) => console.error("[foreman] could not record the gate reply:", err));
  }
  await actions.putNote(ctx.sessionId, plan.note);
}

/**
 * Why an answer can't be delivered to the menu on screen, or null when it can.
 *
 * Deliberately says nothing when there is NO menu: an ordinary prompt is answered with
 * prose, which is the majority path (a parked no-mistakes gate, a plain question), and an
 * `option` volunteered against no menu is simply ignored rather than treated as an error.
 *
 * The label is re-checked against the row and not taken on trust because the number alone
 * is a position on a screen the reviewer read seconds ago. A reviewer that miscounts rows -
 * or reads the number off a menu that has since repainted - produces a well-formed verdict
 * pointing at the wrong row, which is indistinguishable from a correct one downstream. The
 * label is the only field that can catch that, and catching it here means it becomes an
 * escalation rather than a wrong answer typed under the human's name.
 */
function menuMismatch(
  menu: PaneDialog | null | undefined,
  option: { number: number; label: string } | undefined,
): string | null {
  if (!menu) return null;
  if (!option) return "a menu is open and the reviewer named no option to select";
  const miss = optionRowMiss(menu, option);
  if (!miss) return null;
  const chose = `the reviewer's option ${option.number} ("${oneLine(option.label, 40)}")`;
  switch (miss) {
    case "no-such-row":
      return `the reviewer chose option ${option.number}, which this menu doesn't have`;
    case "label-differs":
      return `${chose} isn't what that row says`;
    case "label-ambiguous":
      return `${chose} reads the same as another row, so it can't say which was meant`;
  }
}

/**
 * Whether the menu on screen would block this verdict's answer from reaching the child.
 *
 * The tier ladder's question, not the planner's: a verdict that names no row can't be
 * DELIVERED to a menu, but the cheap tier's inability to name one says nothing about whether
 * a human is needed - only that this reviewer can't answer this surface. The Tier 1 router's
 * schema has no `option` field at all, so on a permission prompt (which is a menu) every one
 * of its answers is blocked here. Routing up hands the same ask to the full reviewer, which
 * can name a row; escalating instead would put a human in front of every routine approval
 * when the tier is `on`, having already spent the cheap call to learn nothing.
 */
export function menuBlocksAnswer(v: Verdict, ctx: ReviewContext): boolean {
  if (v.action !== "answer") return false;
  const chan = pickChannel(ctx);
  if (chan?.channel !== "send") return false;
  return menuMismatch(ctx.menu, v.answer?.option) !== null;
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
