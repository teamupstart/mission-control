import type { ReviewItem, Session } from "@shared/types.ts";

// Works out what a needs-you session is actually blocked on - the single pure
// classification the worker and the triage tiers share. Kept out of worker.ts so
// triage.ts can import it without pulling in worker.ts's top-level `main()` (which
// would start the loop on import). Pure, no I/O, so it's directly unit-tested.

/**
 * The concrete kind of block a needs-you session sits on, richer than the coarse
 * `surface` the reviewer prompt uses. This is what the Tier 0 structural gate
 * branches on, since each situation has a fixed, model-free disposition:
 * - `input-review`     - a pending MCP `input` review: answerable by resolving it.
 * - `non-input-review` - a plan/diff/gate review: human-only, Foreman can't deliver.
 * - `terminal-pane`    - `awaiting_input` with a tmux/wezterm pane: answerable by typing.
 * - `terminal-no-pane` - `awaiting_input` but no pane: a real question, no channel.
 * - `no-question`      - needs-you for some other state, with no answerable question.
 */
export type PendingSituation =
  | "input-review"
  | "non-input-review"
  | "terminal-pane"
  | "terminal-no-pane"
  | "no-question";

export interface Pending {
  /** The rich block kind the Tier 0 gate branches on. */
  situation: PendingSituation;
  /** Coarse delivery surface handed to the reviewer prompt so it phrases the reply. */
  surface: "input-review" | "terminal";
  question: string;
  /** Set only for an `input` review, the one surface Foreman resolves via the API. */
  inputReviewId: string | null;
  /** Whether a terminal reply can be typed (a pane exists and the ask is terminal). */
  canSend: boolean;
  /** Stable id of this waiting episode, stamped as the note's handledMarker. */
  marker: string;
  /** For a non-input review: its kind (plan/diff/gate...), so Tier 0 can name the purpose. */
  reviewKind?: string;
  /** For a non-input review: its title, if any. */
  reviewTitle?: string;
}

/**
 * Stand-in `question` for a needs-you session that has no activity line at all. It is
 * phrased as prose because it goes straight into the reviewer prompt; the Tier 0 gate
 * compares against it to tell a real activity string from this placeholder.
 */
export const NO_QUESTION_PLACEHOLDER = "(the session needs you, but no explicit question was found)";

/**
 * Work out what a needs-you session is blocked on, and how (if at all) Foreman may
 * reply. An `input` review is directly answerable (resolve it); a plan/diff review
 * is not (Foreman can only frame it); a terminal `awaiting_input` is answerable by
 * typing when a pane exists; anything else is purpose-only. Pure.
 */
export function classifyPending(s: Session, reviews: ReviewItem[]): Pending {
  const pend = reviews.filter((r) => r.sessionId === s.id && r.status === "pending");
  const inputReview = pend.find((r) => r.kind === "input");
  if (inputReview) {
    return {
      situation: "input-review",
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
      situation: "non-input-review",
      surface: "input-review",
      question:
        `The child posted a ${other.kind} titled "${other.title}" for review. You cannot ` +
        `auto-approve a ${other.kind}; write the purpose and escalate if it needs the human.`,
      inputReviewId: null,
      canSend: false,
      marker: `review:${other.id}`,
      reviewKind: other.kind,
      reviewTitle: other.title,
    };
  }
  if (s.state === "awaiting_input") {
    const canSend = Boolean(s.tmux || s.wezterm);
    return {
      situation: canSend ? "terminal-pane" : "terminal-no-pane",
      surface: "terminal",
      question: s.activity ?? "",
      inputReviewId: null,
      canSend,
      marker: `await:${s.lastActivity ?? s.firstSeen}`,
    };
  }
  return {
    situation: "no-question",
    surface: "terminal",
    question: s.activity ?? NO_QUESTION_PLACEHOLDER,
    inputReviewId: null,
    canSend: false,
    marker: `state:${s.state}:${s.lastActivity ?? s.firstSeen}`,
  };
}
