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

/**
 * Which no-mistakes gate round a `gate-parked` session sits on - enough to file a
 * reply against it later, and nothing more.
 *
 * The same three facts the marker above is built from, carried in structured form
 * rather than re-derived: the marker is a hash meant for an equality check and
 * can't be read back. Note what is NOT here: `findingsDigest`. The ids are the
 * discriminator (see `logGateReply`), because they survive `axi status`'
 * description truncation and a digest of that text does not.
 */
export interface GateRef {
  runId: string;
  step: string;
  /** Every finding up at the gate, ask-user and auto-fix alike. */
  findingIds: string[];
}

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
  /** Set only for `gate-parked`: which gate round, so a send can be filed against it. */
  gate?: GateRef;
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
 * `ask-user` rows lead because they ARE the decision: no-mistakes routed them to the user's
 * judgment instead of fixing them itself, which is precisely what Foreman stands in for.
 * `auto-fix` rows are the agent's own to drive and are noise on this card. This deliberately
 * frames them as the user's call to MAKE rather than as off-limits, because the reviewer POLICY
 * tells the reviewer to judge a gate - answer when the session's goal makes the call clear,
 * escalate when it turns on the user's intent or is risky. A heading declaring the rows
 * human-only would contradict that, and the model would be reading both. But the question never
 * *depends* on finding an ask-user row - see `classifyPending`.
 */
function gateQuestion(nm: NmRunSummary): string {
  const step = nm.gateStep ? `the "${nm.gateStep}" gate` : "a gate";
  const lines = [
    `The no-mistakes run on ${nm.branch} is parked at ${step} and the agent driving it has ` +
      `stopped, so this decision is waiting on the user - and you are standing in for them. ` +
      `Answer with what you want done and the child will translate it into the matching ` +
      `\`no-mistakes axi respond\` call.`,
  ];
  const asks = nm.findings.filter((f) => f.action === "ask-user");
  if (asks.length > 0) {
    lines.push("", "Findings no-mistakes routed to the user's judgment rather than fixing itself:");
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
 * decisions stay the human's to make); a terminal `awaiting_input` and a parked
 * no-mistakes gate are both answerable by typing when a pane exists; anything else
 * is purpose-only. Pure.
 *
 * `gateParked` is called WITHOUT a session list, which reduces it to "parked, and this agent has
 * stopped". The cross-session check (is a sibling still driving this run?) is the caller's,
 * via `reportBucket` - a run someone else is driving never reports needs-you, so it never
 * reaches here. This function assumes a needs-you session throughout and re-derives none of
 * that bucketing; passing the session list would duplicate it and let the two answers drift.
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
  //
  // That ordering decides the BYLINE too, and deliberately so: `gate` below is set on this
  // branch and nowhere else, so a send that answers a live prompt is filed against no gate
  // and its fix is credited to nobody. The ref attaches only when the gate IS the live
  // question. A prompt that's up may be about anything - the agent may be asking something
  // the gate never raised - so filing our answer to it against the gate would claim the reply
  // was about the gate when nothing establishes that. That's an OVERCLAIM, and it's the
  // direction this byline keeps having to close; a missing byline is the safe side of the
  // same trade. So the foreman is named only where it stopped a gate that stayed a gate.
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
      // The same run/step/findings the marker hashes, kept readable so a send can be
      // filed against this exact round (see `GateRef`). Only when the step is known:
      // it is half the join key, and a reply filed under "parked" would attach to
      // whatever step the fix log later asked about.
      gate: s.nomistakes.gateStep
        ? {
            runId: s.nomistakes.id,
            step: s.nomistakes.gateStep,
            findingIds: s.nomistakes.findings.map((f) => f.id).filter(Boolean),
          }
        : undefined,
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
