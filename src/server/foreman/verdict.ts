import { z } from "zod";
import type { ForemanConfig, SetNote } from "@shared/protocol.ts";

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
        channel: z.enum(["send", "review"]).optional(),
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
  /** Repo root the session runs in (allowlist check). */
  repoRoot: string | null;
  /** Stable id of the prompt being handled - stamped as the note's handledMarker. */
  promptMarker: string;
  /** A pending MCP `input` review's id, if the ask arrived that way. */
  inputReviewId: string | null;
  /** True when the session has a pane we can type into (tmux/wezterm). */
  canSend: boolean;
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
 * so dry-run / semi-auto / off-allowlist never type into a session.
 */
export function planFromVerdict(v: Verdict, ctx: ReviewContext, mayActLive: boolean): VerdictPlan {
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

/** Minimal daemon surface `applyVerdict` needs, so tests can inject a fake. */
export interface ForemanActions {
  putNote(sessionId: string, patch: SetNote): Promise<unknown>;
  sendText(sessionId: string, text: string, submit: boolean): Promise<unknown>;
  resolveReview(reviewId: string, action: "answer", response: string): Promise<unknown>;
}

/** Execute a plan: always write the note, then deliver the reply if one is set. */
export async function applyVerdict(
  actions: ForemanActions,
  ctx: ReviewContext,
  plan: VerdictPlan,
): Promise<void> {
  await actions.putNote(ctx.sessionId, plan.note);
  if (!plan.send) return;
  if (plan.send.channel === "review" && plan.send.reviewId) {
    await actions.resolveReview(plan.send.reviewId, "answer", plan.send.text);
  } else {
    await actions.sendText(ctx.sessionId, plan.send.text, plan.send.submit);
  }
}

/** Collapse whitespace and cap a string to one short line for the audit field. */
function oneLine(s: string, max = 80): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * True when Foreman is cleared to *send* for a session running in `cwd`: config
 * enabled + live, and `cwd` is at or under an allowlisted repo root (so a repo's
 * worktrees are covered by listing the repo). Dry-run / semi-auto / off-allowlist
 * all return false, so they draft instead of typing into a session. Pure.
 */
export function foremanMayActLive(cfg: ForemanConfig, cwd: string | null): boolean {
  if (!cfg.enabled || cfg.mode !== "live" || !cwd) return false;
  return cfg.repoAllowlist.some((root) => cwd === root || cwd.startsWith(`${root}/`));
}
