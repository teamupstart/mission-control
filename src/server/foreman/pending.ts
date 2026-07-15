import { createHash } from "node:crypto";
import type { NmFinding, NmRunSummary, ReviewItem, Session } from "@shared/types.ts";
import { gateParked } from "@shared/session.ts";

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
 * - `terminal-pane`    - `awaiting_input` with a tmux/wezterm pane: answerable by typing.
 * - `terminal-no-pane` - `awaiting_input` but no pane: a real question, no channel.
 * - `gate-parked`      - a no-mistakes gate whose agent has stopped: answerable by typing.
 * - `no-question`      - needs-you for some other state, with no answerable question.
 */
export type PendingSituation =
  | "input-review"
  | "non-input-review"
  | "terminal-pane"
  | "terminal-no-pane"
  | "gate-parked"
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
 * Frame a parked no-mistakes gate as a question a reviewer can actually answer.
 *
 * The `/no-mistakes` skill drives its own gates while the session works, and stops only to
 * put an `ask-user` finding to the human - relaying it "as the pipeline wrote it, verbatim"
 * and ending its turn. That stop is why this is needed at all: it fires `Stop`, so the state
 * reads `idle`, and the ask exists only as prose in the transcript and as findings on the run
 * summary. Naming the findings here means the reviewer gets the decision framed even before
 * it reads a single turn.
 *
 * `ask-user` rows lead because they are definitionally the human's call; `auto-fix` rows are
 * the agent's own to drive and are noise on this card. But the question never *depends* on
 * finding one - see `classifyPending`.
 */
function gateQuestion(nm: NmRunSummary): string {
  const step = nm.gateStep ? `the "${nm.gateStep}" gate` : "a gate";
  const lines = [
    `The no-mistakes run on ${nm.branch} is parked at ${step} and the agent driving it has ` +
      `stopped, so this decision is the human's. Answer with what you want done and the child ` +
      `will translate it into the matching \`no-mistakes axi respond\` call.`,
  ];
  const asks = nm.findings.filter((f) => f.action === "ask-user");
  if (asks.length > 0) {
    lines.push("", "Findings the pipeline says only a human can call:");
    for (const f of asks) lines.push(`- ${f.id} [${f.severity}] ${f.file}: ${f.description}`);
  } else if (nm.findingsSummary) {
    // No ask-user row scraped (yet, or at all) - say what IS known rather than invent a reason.
    lines.push("", `Findings: ${nm.findingsSummary}`);
  }
  return lines.join("\n");
}

/**
 * A stable digest of the gate's findings - the discriminator that keeps two parkings at the
 * SAME step within one run apart. A run works its review step in rounds (the pipeline applies
 * the fixes and re-runs it), so run id + step alone repeats across rounds 2..n, and the marker
 * being identical is read as "already handled" - silently dropping every round after the first.
 *
 * Built from only `id` + `description`: the two fields that say WHICH decision is up, and the
 * only ones that hold still while a gate sits parked. Sorted, so a scrape that reorders the same
 * findings is not a new episode. Findings arriving late (the poller scrapes them after the park)
 * does move it once, which is right - the first look was blind, the second reads the real ask.
 */
function findingsDigest(findings: NmFinding[]): string {
  const rows = findings
    .map((f): [string, string] => [f.id, f.description])
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  return createHash("sha1").update(JSON.stringify(rows)).digest("hex").slice(0, 12);
}

/**
 * Stand-in `question` `classifyPending` substitutes when a needs-you session carries no
 * activity line at all. It is phrased as prose because it goes straight into the Tier 2
 * reviewer prompt as the question.
 */
export const NO_QUESTION_PLACEHOLDER = "(the session needs you, but no explicit question was found)";

/**
 * Work out what a needs-you session is blocked on, and how (if at all) Foreman may
 * reply. An `input` review is directly answerable (resolve it); a plan/diff review
 * is not (Foreman can only frame it); a terminal `awaiting_input` and a parked
 * no-mistakes gate are both answerable by typing when a pane exists; anything else
 * is purpose-only. Pure.
 *
 * `gateParked` is called WITHOUT a fleet, which reduces it to "parked, and this agent has
 * stopped". The cross-session check (is a sibling still driving this run?) is the caller's,
 * via `reportBucket` - a run someone else is driving never reports needs-you, so it never
 * reaches here. This function assumes a needs-you session throughout and re-derives none of
 * that bucketing; passing the fleet would duplicate it and let the two answers drift.
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
  // Ordered AFTER `awaiting_input` on purpose: a session can be both (a gate parks, then the
  // agent puts the finding up as a live prompt), and the live prompt is the precise thing
  // blocked right now - answering it is what unblocks the run. The gate behind it is context,
  // and the reviewer reads it off the transcript either way.
  if (gateParked(s) && s.nomistakes) {
    return {
      situation: "gate-parked",
      surface: "terminal",
      question: gateQuestion(s.nomistakes),
      inputReviewId: null,
      // The agent has stopped, so there is no blocked call to release - typing into its pane
      // wakes it with a new prompt, exactly as a human answering this would.
      canSend: Boolean(s.tmux || s.wezterm),
      // Keyed on the RUN id, not its branch (successive runs share one, and the second would
      // inherit the first's handled marker and be silently skipped - the very thing NmRunSummary
      // carries an id to prevent); on the step; and on the findings up at it (see
      // `findingsDigest`, which separates that step's successive rounds). NOT on `awaitingAgent`
      // ("parked 1m30s"), whose elapsed time ticks and would churn the marker into re-handling
      // the same gate every loop.
      marker: `gate:${s.nomistakes.id}:${s.nomistakes.gateStep ?? "parked"}:${findingsDigest(s.nomistakes.findings)}`,
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
