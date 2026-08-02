import { createHash } from "node:crypto";
import type { PaneDialog, ReviewItem, Session } from "@shared/types.ts";
import { activePaneDialog, dialogIdentity } from "@shared/session.ts";
import { canMessage } from "@shared/pane.ts";

// Works out what a needs-you session is actually blocked on - the single pure
// classification the worker and the triage tiers share. Kept out of worker.ts so
// triage.ts can import it without pulling in worker.ts's top-level `main()` (which
// would start the loop on import). Pure, no I/O, so it's directly unit-tested.

/**
 * The concrete kind of block a needs-you session sits on, richer than the coarse
 * `surface` the reviewer prompt uses. This is what the Tier 0 structural gate
 * branches on, since each situation has a fixed, model-free disposition:
 * - `input-review`     - a pending MCP `input` review: answerable by resolving it.
 * - `non-input-review` - a plan/diff review: human-only, Foreman can't deliver.
 * - `terminal-pane`    - a stopped child (`awaiting_input`, or a menu on its screen) with a
 *                        terminal pane: answerable by typing, or by selecting a row.
 * - `structured-request` - a driver-run child blocked on a REQUEST rather than a screen:
 *                        answerable by naming an option, submitting a whole form, or in
 *                        prose. Distinguished from `terminal-pane` because the reviewer
 *                        prompt describes the two differently (see `promptHarness`) and
 *                        because the record on the card should say which it was - the two
 *                        are answerable by the same code and answerable in different words.
 * - `terminal-no-pane` - the same ask with no pane: a real question, no channel.
 * - `no-question`      - needs-you for some other state, with no answerable question.
 */
export type PendingSituation =
  | "input-review"
  | "non-input-review"
  | "terminal-pane"
  | "structured-request"
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
  /** For a non-input review: its kind (plan/diff), so Tier 0 can name the purpose. */
  reviewKind?: string;
  /** For a non-input review: its title, if any. */
  reviewTitle?: string;
}

/**
 * A stable digest of the menu on the child's screen - the marker for a dialog episode.
 *
 * Digested rather than carried whole because a marker is only ever compared for equality
 * (the worker's idempotency check), and `dialogIdentity` is a JSON blob of every row's
 * number and label. Same reason, same shape, and the same 12 hex chars as
 * the other compact episode markers in this module.
 */
function dialogDigest(dialog: PaneDialog): string {
  return createHash("sha1").update(dialogIdentity(dialog)).digest("hex").slice(0, 12);
}

/**
 * Stand-in `question` `classifyPending` substitutes when a needs-you session carries no
 * activity line at all. It is phrased as prose because it goes straight into the Tier 2
 * reviewer prompt as the question.
 */
export const NO_QUESTION_PLACEHOLDER = "(the session needs you, but no explicit question was found)";

/**
 * Render an `input` review as the question Foreman actually judges, options included.
 *
 * This exists because of what `ask-channel.ts` changed. A dispatched session used to ask a
 * multiple-choice question by drawing a menu on its pane, and the reviewer read the rows off
 * the screen capture - the Foreman prompt still tells it to copy a row's number and label
 * from there. Now that session calls `request_input` and the choices live in the review's
 * `decisions`, which nothing was passing on: the reviewer got the question sentence alone.
 * The transcript cannot cover for that either, because a blocked tool call is not written to
 * it until it returns (the premise documented on `ReviewInput.pane`).
 *
 * So Foreman was answering multiple-choice questions having never seen the choices, on
 * exactly the asks this feature routes to it - free to invent an answer outside the offered
 * set. Hence the closing instruction as well as the list: this surface is resolved with free
 * prose (there is no row to select), so naming one of the labels is the reviewer's only way
 * to actually choose.
 *
 * Guarding is the caller's: `buildReviewPrompt` puts the whole `question` through
 * `fromChild`, which is what confines every child-authored string here - labels and details
 * included - to the section it was given.
 */
export function withOfferedOptions(review: ReviewItem): string {
  const decision = review.decisions?.[0];
  if (!decision?.options.length) return review.body;
  const rows = decision.options.map((o) => `- ${o.label}${o.detail ? `: ${o.detail}` : ""}`);
  return [
    review.body,
    "",
    decision.multiSelect
      ? "The agent offered these options (it will accept more than one):"
      : "The agent offered these options:",
    ...rows,
    "",
    // Named rather than implied: the reviewer's reply is typed as prose, so "pick option 2"
    // reaches the agent as the words "pick option 2" and nothing else.
    "Your answer is delivered as text, so state the LABEL of the option you are choosing," +
      " exactly as written above. If none of them is an answer you are willing to give," +
      " escalate rather than inventing one that was not offered.",
  ].join("\n");
}

/**
 * Work out what a needs-you session is blocked on, and how (if at all) Foreman may
 * reply. An `input` review is directly answerable (resolve it); any other kind -
 * plan, diff, plan-decisions - is not (Foreman can only frame it, so a plan's
 * decisions stay the human's to make); a stopped terminal - `awaiting_input`, a menu on
 * the screen - is answerable by typing when a pane exists;
 * anything else is purpose-only. Pure.
 *
 * Every branch that reaches `no-question` is therefore a session with nothing to answer,
 * which is the only shape that classification should ever have described. It is the
 * cheapest disposition in the file and the one a mistake is most expensive on: it forces
 * `canSend: false`, which `planFromVerdict` can only resolve as "no reply channel", and an
 * escalation is the one outcome that costs a human's attention.
 */
export function classifyPending(s: Session, reviews: ReviewItem[]): Pending {
  const pend = reviews.filter((r) => r.sessionId === s.id && r.status === "pending");
  const inputReview = pend.find((r) => r.kind === "input");
  if (inputReview) {
    return {
      situation: "input-review",
      surface: "input-review",
      question: withOfferedOptions(inputReview),
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
  // A menu on the screen and `awaiting_input` are ONE situation, not two, because they are
  // two reports of the same fact arriving over different channels: the child has stopped and
  // cannot move until someone answers. `reportBucket` has always treated them that way - it
  // admits a session on `activePaneDialog` alone (src/shared/session.ts), precisely so an
  // uninstrumented session parked on a prompt is not read as idle - and this function used to
  // recognise only the hook. The two disagree for a real, measured interval: Claude fires
  // `PreToolUse` when `AskUserQuestion` opens (state `working`) and the `Notification` that
  // means `awaiting_input` ~6s later, so every ask has a window in which the menu is on the
  // pane and the state is still `working`. A poll landing there fell through to `no-question`
  // with `canSend: false`, which `planFromVerdict` can only turn into "escalated (no reply
  // channel)" - a decision pinned on the human for a question Foreman could see, had a pane
  // for, and was about to be able to answer. Reading the dialog here is what makes the
  // machinery downstream reachable at all: the pane is already captured, `ctx.menu` is already
  // parsed from it, and `selectPaneOption` already verifies the row before pressing anything.
  const dialog = activePaneDialog(s);
  if (dialog || s.state === "awaiting_input") {
    // Whether an ANSWER can be delivered, which is what every downstream plan turns on -
    // `planFromVerdict` can only escalate "no reply channel" when this is false. A
    // driver-run session has one without holding a pane.
    const canSend = canMessage(s);
    return {
      // Named off the DIALOG's own source, never off the session's runtime: what makes this
      // situation different is that the ask arrived as data, and that is a property of the
      // ask. A driver that ever reported a screen-read dialog would be described as one, and
      // a future runtime whose asks are structured inherits the framing with no edit here.
      situation: !canSend
        ? "terminal-no-pane"
        : dialog?.source === "driver"
          ? "structured-request"
          : "terminal-pane",
      surface: "terminal",
      // Left as the activity even for a dialog, which reads "running AskUserQuestion". The
      // reviewer does not learn the question from this field on this surface - the prompt
      // renders the SCREEN and says to read the ask off it (see prompt.ts, which documents
      // the same generic-question premise for `awaiting_input`). Framing the rows a second
      // time here would be a second copy of the menu for the model to reconcile.
      question: s.activity ?? "",
      inputReviewId: null,
      canSend,
      // The DIALOG wins the marker whenever there is one, and this is the half that keeps the
      // fix from costing a second review per ask. `lastActivity` moves when the Notification
      // hook lands, so a menu classified during the window above and again after it would
      // mint two markers for one unchanged question and spend two `claude -p` calls on it.
      // `dialogIdentity` is already the shared notion of "the same question" - it excludes
      // `highlighted` and `checked` on purpose, so a cursor moving in the terminal is the same
      // ask being read again - and hashing it holds the marker still for exactly as long as
      // the rows do.
      marker: dialog ? `dialog:${dialogDigest(dialog)}` : `await:${s.lastActivity ?? s.firstSeen}`,
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
