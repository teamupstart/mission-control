import {
  ENSEMBLE_DRIVER_KEYS,
  knownDriverKey,
  type EnsembleDecisionPolicy,
  type EnsembleDriverKey,
  type EnsembleJson,
  type EnsembleOutcome,
} from "@shared/ensemble.ts";
import {
  CONSENSUS_DECISION_COMMAND,
  CONSENSUS_FINDINGS_VERSION,
  ConsensusAnswersSelectionSchema,
  parseConsensusDecisionInput,
  parseConsensusFindings,
  type ConsensusAnswersSelection,
  type ConsensusDecisionInput,
} from "@shared/ensemble-strategies/consensus.ts";
import { EnsembleSelectOneSelectionSchema } from "@shared/protocol.ts";

/**
 * The versioned DECISION driver registry.
 *
 * A decision driver owns both halves of one human decision: what the operator is ASKED (the stage
 * attempt's persisted input, built once when the stage opens) and whether what they answered is
 * valid (checked against that same persisted input, never against a re-read evaluation). Its
 * authority is deliberately tiny: it composes a question and it VALIDATES an answer. It cannot
 * record a decision, move the run, or touch a Task, a ref or a Workflow. The engine dispatches to
 * it by the compiled plan's `driverKey`, never by asking whether a run is Best-of-N or Consensus,
 * which is the whole reason a decision is a versioned driver and not an engine branch.
 *
 * The invariant both drivers enforce is the product-safety one: a model output is never an actor
 * here. `human_decision@1`'s recommendation is advisory, and `divergence_decision@1`'s options are
 * evidence - what some subset of the fleet actually did - that a person picks between or overrides
 * with their own words. An ineligible, malformed, or unasked answer is a refusal, never a nearest
 * match.
 */

/** What one decision is being made against - the eligible artifacts and how to build an outcome. */
export interface DecisionContext {
  policy: EnsembleDecisionPolicy;
  /** Ready artifact ids of the policy's eligible kind, in stable order. */
  eligibleArtifactIds: string[];
  /** The member that produced a given eligible artifact, for building the outcome. */
  memberForArtifact(artifactId: string): string | null;
  /**
   * The decision stage attempt's persisted INPUT - exactly what the operator was asked.
   *
   * This is the authority a driver whose options came from an evaluator validates against, and it
   * matters that it is the persisted row rather than the evaluation it was derived from: a review
   * retried after the run parked would produce different questions, and an answer checked against
   * those would be an answer to something nobody saw. Null when the stage has not opened yet.
   */
  stageInput: EnsembleJson | null;
}

/** What a decision stage needs in order to compose the question it will persist and render. */
export interface DecisionOpenContext {
  policy: EnsembleDecisionPolicy;
  /** Ready artifact ids of the policy's eligible kind, in stable order. */
  eligibleArtifactIds: string[];
  /**
   * The newest succeeded evaluation on this run, or null when there is none.
   *
   * The seam that makes evaluator-derived decision options possible without an engine branch: a
   * driver whose question is static ignores it, and one whose question IS the evaluation's result
   * reads it here, once, at the moment the stage opens.
   */
  evaluation: { id: string; body: EnsembleJson } | null;
}

export type DecisionRefusal =
  | "invalid_selection"
  | "ineligible_artifact"
  | "insufficient_eligible"
  | "unknown_member";

export type DecisionResult =
  | {
      ok: true;
      selection: EnsembleJson;
      /**
       * The discriminant of what the HUMAN chose (`selected`, `no_consensus`, `answers`), which is
       * a different fact from `outcome.kind` and the one the timeline reports: answering a
       * question set and declaring no consensus both produce non-destructive outcomes, and an
       * event that named only the outcome could not tell them apart.
       */
      selectionKind: string;
      outcome: EnsembleOutcome;
    }
  | { ok: false; reason: DecisionRefusal; detail: string };

/** A versioned decision driver, registered by the exact `driverKey` a compiled plan may name. */
export interface DecisionDriver {
  driverKey: EnsembleDriverKey;
  /**
   * The stage attempt input to persist when this decision stage opens - the durable statement of
   * what the operator is being asked. Pure: it is handed values the engine already read.
   */
  openStage(context: DecisionOpenContext): EnsembleJson;
  validate(selection: EnsembleJson, context: DecisionContext): DecisionResult;
}

/**
 * `select_one` / `human_decision@1`: choose exactly one eligible artifact, or declare no consensus.
 *
 * Cancelling is a different authority entirely (`cancel`), never a decision - a decision that reaps
 * loser worktrees must be a deliberate pick, and folding "give up and destroy" into the same shape
 * as "this one wins" is exactly the accident the split rules out. `no_consensus` retains every
 * artifact and is non-destructive.
 */
export const selectOneDecisionDriver: DecisionDriver = {
  driverKey: "human_decision@1",
  // Static: what is asked ("pick one of the eligible artifacts") is fully described by the compiled
  // policy, and the scorecards the operator reads beside it are rendered from the evaluation row.
  openStage: () => ({ command: "await_human_decision" }) as EnsembleJson,
  validate(selection, context) {
    const parsed = EnsembleSelectOneSelectionSchema.safeParse(selection);
    if (!parsed.success) {
      return { ok: false, reason: "invalid_selection", detail: parsed.error.issues[0]?.message ?? "invalid selection" };
    }
    if (context.eligibleArtifactIds.length < context.policy.minEligibleSubjects) {
      return {
        ok: false,
        reason: "insufficient_eligible",
        detail: `a decision needs at least ${context.policy.minEligibleSubjects} eligible artifacts, and ${context.eligibleArtifactIds.length} remain`,
      };
    }
    if (parsed.data.kind === "no_consensus") {
      return {
        ok: true,
        selection: parsed.data as unknown as EnsembleJson,
        selectionKind: parsed.data.kind,
        outcome: { kind: "no_consensus", artifactIds: [...context.eligibleArtifactIds], reason: parsed.data.reason },
      };
    }
    // `selected`: the chosen artifact must be one of the eligible set - not merely a ready
    // artifact of the run, and never the recommendation by default. A guessed or stale id is a
    // refusal, so a decision cannot promote something the review never judged.
    const artifactId = parsed.data.artifactId;
    if (!context.eligibleArtifactIds.includes(artifactId)) {
      return { ok: false, reason: "ineligible_artifact", detail: `artifact ${artifactId} is not an eligible result` };
    }
    const memberId = context.memberForArtifact(artifactId);
    if (memberId === null) {
      return { ok: false, reason: "unknown_member", detail: `artifact ${artifactId} has no owning member` };
    }
    return {
      ok: true,
      selection: parsed.data as unknown as EnsembleJson,
      selectionKind: parsed.data.kind,
      outcome: { kind: "selected", memberIds: [memberId], artifactIds: [artifactId], materializedTaskId: null },
    };
  },
};

/**
 * `answer_divergences` / `divergence_decision@1`: answer the questions an evaluator mined.
 *
 * This is the strategy-neutral half of the one new primitive Phase 2 introduced. `openStage` turns
 * a succeeded consensus evaluation into the question set the stage persists and the dashboard
 * renders; `validate` checks an operator's answers against THAT persisted set and turns them into
 * a `retained` outcome. Nothing here promotes, and nothing here is destructive - which is why the
 * outcome names every eligible artifact rather than one.
 *
 * A stage that opens with no readable evaluation persists an EMPTY question set rather than
 * refusing. That is deliberate: the review stage only succeeds when it produced a validated
 * result, so an unreadable one at this point means a build that cannot parse what it stored, and
 * parking the run unanswerable would be worse than letting the operator confirm zero questions and
 * keep every artifact.
 */
export const divergenceDecisionDriver: DecisionDriver = {
  driverKey: "divergence_decision@1",
  openStage(context) {
    const findings = context.evaluation ? parseConsensusFindings(context.evaluation.body) : null;
    const input: ConsensusDecisionInput = {
      command: CONSENSUS_DECISION_COMMAND,
      version: CONSENSUS_FINDINGS_VERSION,
      evaluationId: context.evaluation?.id ?? null,
      agreements: findings?.agreements ?? [],
      questions: findings?.divergences ?? [],
    };
    return input as unknown as EnsembleJson;
  },
  validate(selection, context) {
    const parsed = ConsensusAnswersSelectionSchema.safeParse(selection);
    if (!parsed.success) {
      return { ok: false, reason: "invalid_selection", detail: parsed.error.issues[0]?.message ?? "invalid selection" };
    }
    if (context.eligibleArtifactIds.length < context.policy.minEligibleSubjects) {
      return {
        ok: false,
        reason: "insufficient_eligible",
        detail: `these answers need at least ${context.policy.minEligibleSubjects} eligible artifacts, and ${context.eligibleArtifactIds.length} remain`,
      };
    }
    const asked = parseConsensusDecisionInput(context.stageInput);
    if (asked === null) {
      return {
        ok: false,
        reason: "invalid_selection",
        detail: "this decision stage holds no readable question set to answer",
      };
    }
    const refusal = checkAnswers(parsed.data, asked);
    if (refusal !== null) return { ok: false, reason: "invalid_selection", detail: refusal };

    const memberIds: string[] = [];
    for (const artifactId of context.eligibleArtifactIds) {
      const memberId = context.memberForArtifact(artifactId);
      if (memberId === null) {
        return { ok: false, reason: "unknown_member", detail: `artifact ${artifactId} has no owning member` };
      }
      memberIds.push(memberId);
    }
    return {
      ok: true,
      selection: parsed.data as unknown as EnsembleJson,
      selectionKind: parsed.data.kind,
      // Everything is retained. There is no winner and no loser, so the outcome names every
      // eligible artifact and the finalizer reaps nothing.
      outcome: { kind: "retained", memberIds, artifactIds: [...context.eligibleArtifactIds] },
    };
  },
};

/**
 * One answer per asked question, each naming an option that question offered or carrying the
 * operator's own words - or a sentence saying precisely which of those it broke.
 *
 * Every rule refuses rather than repairing, and the two that matter most are the ones a lenient
 * reading would swallow: an answer to a question that was never asked is an answer to something
 * else, and a blank override recorded as an answer is indistinguishable from a settled question.
 */
function checkAnswers(
  selection: ConsensusAnswersSelection,
  asked: ConsensusDecisionInput,
): string | null {
  const questions = new Map(asked.questions.map((question) => [question.id, question]));
  const answered = new Set<string>();
  for (const answer of selection.answers) {
    const question = questions.get(answer.questionId);
    if (!question) return `there is no open question ${JSON.stringify(answer.questionId)} to answer`;
    if (answered.has(answer.questionId)) {
      return `question ${JSON.stringify(answer.questionId)} is answered more than once`;
    }
    answered.add(answer.questionId);
    if (answer.optionId === null) {
      if (answer.note.trim() === "") {
        return `question ${JSON.stringify(answer.questionId)} was answered with neither an option nor an answer of your own`;
      }
      continue;
    }
    if (!question.options.some((option) => option.id === answer.optionId)) {
      return `option ${JSON.stringify(answer.optionId)} is not one of the positions offered for question ${JSON.stringify(answer.questionId)}`;
    }
  }
  const missing = asked.questions.filter((question) => !answered.has(question.id));
  if (missing.length > 0) {
    return `${missing.length} open question${missing.length === 1 ? " is" : "s are"} unanswered: ${missing.map((question) => question.id).join(", ")}`;
  }
  return null;
}

/**
 * Every decision driver this build can execute, keyed by the exact `driverKey` a compiled plan
 * names. `Record<EnsembleDriverKey, …>` is the enforcement: a driver key appended to the shared
 * tuple does not compile until it says whether a decision implementation exists or `null`. The
 * non-decision keys are `null` because their stages are driven by other machinery.
 */
export const DECISION_DRIVERS: Record<EnsembleDriverKey, DecisionDriver | null> = {
  "member_wave@1": null,
  "artifact_barrier@1": null,
  "comparative_review@1": null,
  "human_decision@1": selectOneDecisionDriver,
  "select_one_finalize@1": null,
  "consensus_review@1": null,
  "divergence_decision@1": divergenceDecisionDriver,
  "retain_all_finalize@1": null,
  "panel_review@1": null,
};

/** The decision driver for a persisted driver key, or null when this build cannot run it. */
export function decisionDriverFor(driverKey: string): DecisionDriver | null {
  const known = knownDriverKey(driverKey);
  return known ? DECISION_DRIVERS[known] : null;
}

/** Every driver key with a decision implementation, for completeness assertions and tests. */
export const DECISION_DRIVER_KEYS: EnsembleDriverKey[] = ENSEMBLE_DRIVER_KEYS.filter(
  (key) => DECISION_DRIVERS[key] !== null,
);
