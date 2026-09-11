import { isWrapupPayload } from "@shared/queue.ts";
import type {
  WorkflowGoalProvenanceSignal,
  WorkflowRunIntentProvenance,
  WorkflowRunIntentSnapshot,
} from "@shared/workflow.ts";

/**
 * What KIND of ask a run is about to freeze, decided from the ask itself and its provenance.
 *
 * Pure and framework-free on purpose: it is imported by the store, runs inside the
 * transaction that creates a run, and is unit tested without a database. It reads
 * `intentSource`, which Phase 1 owns, and nothing else about the session.
 *
 * It REPORTS. Nothing here refuses a run, and nothing here rewrites one: the verdict
 * describes the moment of the freeze, and an operator who disagrees with it still has a run
 * that started, reviewed and finished. Taking the reporting half only means the first version
 * of this instrument cannot strand a run on a false positive - which matters most for
 * `implausible`, the one check that reasons about a human's prose rather than the daemon's.
 */

/**
 * The shortest ask this treats as a possible completion contract.
 *
 * Not a tuned number. A completion contract has to name a subject and a state of doneness,
 * and the asks the investigation behind this work measured as machine steering - `continue`,
 * `create pr`, `you still working?` - are all under twenty characters because they name
 * neither: they are addressed to whoever is already working, about work they already know
 * about. Twenty-four is the smallest floor that clears every one of those with margin while
 * still admitting a terse but COMPLETE ask - "Fix the flaky login test" is exactly twenty-four
 * characters and names both halves.
 *
 * Deliberately conservative rather than aggressive. This verdict is shown to an operator, not
 * enforced against a run, so a check that misses a borderline case costs a badge nobody
 * needed, while one that fires on real asks costs the instrument its credibility.
 *
 * Measured on the TRIMMED ask, so leading indentation from a pasted prompt cannot buy an
 * eight-character instruction its way past the floor.
 */
export const WORKFLOW_GOAL_OBJECTIVE_FLOOR = 24;

/**
 * How a signature recognises the daemon's prose in a frozen ask.
 *
 * Every mode is ANCHORED at the start of the ask, `pattern` included. A floating substring was
 * tried and withdrawn: " needs follow-through: " reads as a machine payload and is also an
 * ordinary English clause, so "This task needs follow-through: finish the tests" was recorded
 * and displayed as machine-authored. A verdict shown to an operator has to be wrong rarely
 * enough to be worth reading, and the daemon's payloads all have a fixed opening, so requiring
 * one costs nothing and removes the whole class of false positive.
 */
type AutomationMatch = "exact" | "prefix" | "pattern";

interface AutomationSignature {
  /** Named in the reason an operator reads, so it says WHICH machine wrote the ask. */
  readonly label: string;
  readonly match: AutomationMatch;
  /** The literal for `exact` and `prefix`; unused by `pattern`. */
  readonly text?: string;
  /**
   * For `pattern`: an anchored expression identifying a payload whose opening is composed
   * rather than fixed. Anchored and structural, never a bare phrase.
   */
  readonly pattern?: RegExp;
}

/**
 * Every payload shape Mission Control has ever typed into a session pane. APPEND-ONLY.
 *
 * This is `RETIRED_WRAPUP_PAYLOADS`' rule, for `RETIRED_WRAPUP_PAYLOADS`' reason: a frozen ask
 * outlives the build that captured it. A run frozen against today's repair packet is still on
 * disk after the packet's wording changes, and dropping the old spelling here would make that
 * run silently reclassify as a healthy objective the next time anything read it.
 *
 * Deliberately a COPY of the composers' prose rather than an import of it. Two reasons, and
 * the first is the same append-only rule: a live constant can only ever recognise the current
 * spelling, so importing one would be a signature that forgets. The second is structural -
 * these payloads are composed in `foreman/ship-shepherd.ts`, `foreman/review-followup.ts`,
 * `workflows/feedback.ts` and `sdk/supervisor.ts`, and the last of those reaches the registry,
 * so a classifier the store imports cannot import them back without dragging half the daemon
 * through a cycle.
 *
 * A copy that nothing checks would drift, so `test/workflow-goal-provenance.test.ts` runs the
 * REAL composers and asserts their output classifies as `automation`. That test is where a
 * reworded payload is caught; this list is where the old wording keeps being recognised.
 *
 * `prefix` wherever the payload has a fixed opening, because a frozen ask is stored through
 * `clampPrompt`, which keeps the head and elides the middle of anything over 4,000 characters
 * - a repair packet is routinely longer than that, so a signature anchored at its end would
 * match in a test and never in production.
 */
const AUTOMATION_SIGNATURES: readonly AutomationSignature[] = [
  {
    label: "a Foreman completion-review gap packet",
    match: "prefix",
    text: "Foreman's completion review found blocking work that still belongs in this"
      + " implementation turn:",
  },
  {
    label: "a Foreman idle ship-task nudge",
    match: "prefix",
    text: "This invited ship task is still open, but its checkout has no changes and the"
      + " session has been quiet.",
  },
  {
    label: "a Foreman Straight-to-PR handoff continuation",
    match: "prefix",
    text: "Continue the task's existing Straight-to-PR handoff on this same branch.",
  },
  {
    /*
     * The only payload whose opening is composed rather than fixed: it names its pull request
     * first, as either `PR #<number>` or `your open pull request` - the two spellings
     * `buildPayload` can produce and the only two.
     *
     * So the signature is the whole SHAPE of that opening rather than the phrase inside it:
     * one of those two refs, at the very start, the follow-through clause, a single-line
     * summary of what is wrong, and then the numbered step list the packet always writes. A
     * human sentence containing the words "needs follow-through" does not match, which is the
     * false positive this replaced - the earlier floating substring flagged "This task needs
     * follow-through: finish the tests" as machine-authored.
     *
     * Every part of this is in the payload's first two lines, so it survives `clampPrompt`
     * eliding the middle exactly as the anchored prefixes above do.
     */
    label: "a Foreman review follow-through nudge",
    match: "pattern",
    pattern: /^(?:PR #\d+|your open pull request) needs follow-through: [^\n]+\n\n1\. /,
  },
  {
    label: "a workflow repair packet",
    match: "prefix",
    text: "Workflow review failed. This is a repair round; address the review packet below.",
  },
  {
    label: "a workflow evidence-preflight packet",
    match: "prefix",
    text: "# Evidence preflight needs repair",
  },
  {
    label: "an SDK restart continuation",
    match: "exact",
    text: "Mission Control restarted while your previous turn was still in progress."
      + " Continue that work from the current checkout and conversation. Inspect the current"
      + " state before acting, do not repeat completed work, and ask again for any approval or"
      + " input you still need.",
  },
] as const;

function automationLabel(ask: string): string | null {
  // `isWrapupPayload` first, because it already owns this question for the wrap-up prose and
  // already carries its own retired spellings. Restating those here would be a second list to
  // keep in step with the first.
  if (isWrapupPayload(ask)) return "a Foreman wrap-up instruction";
  for (const signature of AUTOMATION_SIGNATURES) {
    if (signature.match === "exact" && ask === signature.text) return signature.label;
    if (signature.match === "prefix" && signature.text && ask.startsWith(signature.text)) {
      return signature.label;
    }
    if (signature.match === "pattern" && signature.pattern?.test(ask)) return signature.label;
  }
  return null;
}

/**
 * The newest prompt revision that can be frozen against without the refiner having spoken.
 *
 * NOT simply `resolvedPromptRevision`, and the difference is the whole check. The OPENING ask
 * becomes the objective the moment it is captured - `captureAcceptedPrompt` writes it directly
 * because a session with no objective at all is worse than one with a provisional one - so
 * revision 1 standing above a resolved revision of 0 is the ordinary state of every session in
 * its first turn, not a warning. Flagging it would put a badge on every freshly dispatched
 * run, which is the noise this instrument exists to avoid.
 *
 * Every LATER instruction is different: only the refiner can decide whether it steers the
 * objective or replaces it, so one sitting unclassified means the contract this run is about
 * to be judged against may be superseded by something the session has already accepted.
 *
 * So the floor is the resolved revision, or 1 while nothing has been resolved yet.
 */
function unreconciledFloor(resolvedPromptRevision: number): number {
  return Math.max(resolvedPromptRevision, 1);
}

export interface WorkflowGoalProvenanceInput {
  /** The ask about to be frozen as `rawGoal`, exactly as it will be stored. */
  rawGoal: string;
  /** Phase 1's freeze-time provenance, absent on a session with no durable objective. */
  intentSource?: WorkflowRunIntentSnapshot["intentSource"];
  now: number;
}

/**
 * Classify one frozen ask.
 *
 * Every check runs; precedence only picks which one names the verdict. That split is the
 * point of the shape: an operator looking at a run needs one word for what is wrong with it,
 * and a reader diagnosing the goal pipeline needs everything that was true at the freeze.
 * Reporting only the winner would throw the second away.
 */
export function classifyWorkflowGoalProvenance(
  input: WorkflowGoalProvenanceInput,
): WorkflowRunIntentProvenance {
  const ask = input.rawGoal.trim();
  const signals: WorkflowGoalProvenanceSignal[] = [];
  const clauses: string[] = [];

  const label = automationLabel(ask);
  if (label !== null) {
    signals.push("automation");
    clauses.push(`matches ${label}, which Mission Control types itself`);
  }
  if (ask.length < WORKFLOW_GOAL_OBJECTIVE_FLOOR) {
    signals.push("implausible");
    clauses.push(
      `is ${ask.length} character${ask.length === 1 ? "" : "s"} long, under the`
        + ` ${WORKFLOW_GOAL_OBJECTIVE_FLOOR} characters a completion contract needs to name a`
        + " subject and a state of doneness",
    );
  }
  const source = input.intentSource ?? null;
  if (source && source.promptRevision > unreconciledFloor(source.resolvedPromptRevision)) {
    signals.push("unreconciled");
    clauses.push(
      `was frozen at prompt revision ${source.promptRevision} while the goal refiner had`
        + ` reconciled only up to revision ${source.resolvedPromptRevision}, so an instruction`
        + " the session has already accepted may still turn out to replace this objective",
    );
  }

  return {
    verdict: signals[0] ?? "objective",
    signals,
    reason: clauses.length === 0
      ? "The frozen ask is the session's durable objective and tripped no provenance check."
      : `The frozen ask ${clauses.join("; and ")}.`,
    classifiedAt: input.now,
  };
}
