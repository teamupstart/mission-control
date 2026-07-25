import { z } from "zod";
import { AGENT_TYPES, THINKING_LEVELS } from "../types.ts";
import { supportsEffort } from "../harness-capabilities.ts";
import { LLM_RUNNER_IDS } from "../llm.ts";
import { ModelIdSchema } from "../protocol.ts";
import { ENSEMBLE_HARD_LIMITS, ENSEMBLE_LIMITS, type EnsembleLaunchEstimate } from "../ensemble.ts";
import type { EnsembleStrategyCapabilities, StrategyFormSpec } from "./types.ts";

/**
 * Consensus (divergence mining): N isolated attempts at one task, then an evaluator that diffs
 * their DECISIONS rather than their code, and a human who answers what the fleet could not settle.
 *
 * This file is the BROWSER-safe half - the input schema, the evaluator's output and persisted
 * result shapes, the question/answer vocabulary the decision stage renders, the form and the
 * launch estimate. Compilation into a generic plan lives in
 * `src/server/ensembles/strategies/consensus.ts`; nothing here knows what a stage or a driver is.
 *
 * The one structural difference from Best-of-N is what the run PRODUCES. Best-of-N ends by
 * promoting one artifact and reaping the rest; this ends `retained` with every artifact kept and
 * a recorded answer per open question. Nothing here may ever recommend a winner: an option's
 * `label` and `rationale` are model output over untrusted candidate diffs, and the moment one of
 * them is read as an identity or an instruction rather than as text, an agent's own diff has
 * written the operator's question.
 */

// The floor is three, not two. Two artifacts produce a difference, not a divergence: with no
// third position there is nothing to tell "the fleet split on this" from "these two differ", and
// every question would have exactly one option per submission.
export const CONSENSUS_MIN_MEMBERS = 3;
export const CONSENSUS_DEFAULT_MEMBERS = 3;
export const CONSENSUS_MAX_MEMBERS = 5;

export const CONSENSUS_DEFAULT_CONCURRENCY = 3;

/** The evidence budget one consensus call may consume, split across the eligible subjects. */
export const CONSENSUS_DEFAULT_MATERIAL_BYTES = 400 * 1024;
export const CONSENSUS_MAX_MATERIAL_BYTES = 2 * 1024 * 1024;

/** The built-in guidance's id. Append-only: it is persisted inside a compiled plan. */
export const CONSENSUS_BUILTIN_RUBRIC = "consensus_v1";

/**
 * The built-in guidance's TEXT, versioned by the id above.
 *
 * Owned by `consensus@1`, and append-only in the same sense the id is - changed wording is a NEW
 * id beside this one, so a run compiled today keeps the exact guidance it was created under.
 *
 * What it asks for is deliberately not a ranking. The failure this wording exists to prevent is
 * an evaluator that answers the question it is used to answering - "which of these is best" -
 * and returns a divergence set that is really a scorecard in disguise.
 */
export const CONSENSUS_BUILTIN_RUBRIC_TEXT = [
  "Compare what the submissions DECIDED, not how well they are written. You are not ranking them and you must not recommend one.",
  "A decision is a choice a reader of the diff can name: a data shape, an interface, an error-handling stance, where responsibility was placed, what was left out, what was renamed, which dependency was taken on.",
  "1. An AGREEMENT is a decision every submission made the same way, stated as one sentence a reader could act on. Two submissions agreeing while a third differs is a divergence, never an agreement.",
  "2. A DIVERGENCE is one question the submissions answered differently. State it as a question, then give one option per distinct position actually taken, attributing each option to the submissions that took it.",
  "3. Say what each position is and what it costs. An option's rationale is the case FOR that position as its authors would put it, plus the risk it carries - not a verdict on it.",
  "4. Prefer few, consequential questions over many trivial ones. Whitespace, comment wording, and identical logic spelled differently are not divergences.",
  "5. Every submission must appear in at least one option across the divergences, so a submission you found nothing distinctive in is still accounted for.",
  "6. If a truncated diff or missing evidence makes a question uncertain, say so inside that question's text rather than omitting the question.",
].join("\n");

/** One roster row. Null overrides mean "the daemon's default at launch", never today's default. */
export const ConsensusMemberSchema = z.object({
  agent: z.enum(AGENT_TYPES).nullable().default(null),
  model: ModelIdSchema.nullable().default(null),
  effort: z.enum(THINKING_LEVELS).nullable().default(null),
  /** Free-text nudge toward a different approach - the raw material a divergence is mined from. */
  approach: z.string().max(ENSEMBLE_LIMITS.approach).nullable().default(null),
});
export type ConsensusMember = z.infer<typeof ConsensusMemberSchema>;

const DEFAULT_MEMBER: ConsensusMember = { agent: null, model: null, effort: null, approach: null };

/**
 * The evaluator half of the config, deliberately the same field names Best-of-N uses.
 *
 * Not a copy for convenience: `EnsembleManager` resolves `strategyConfig.evaluator.personaId` /
 * `.personaRevision` generically before it calls any compiler, so a strategy that spelled its
 * guidance Persona differently would silently never have one resolved, and its compiler would
 * refuse every run configured with a Persona.
 */
export const ConsensusEvaluatorSchema = z.object({
  personaId: z.string().min(1).max(200).nullable().default(null),
  personaRevision: z.number().int().positive().nullable().default(null),
  runner: z.enum(LLM_RUNNER_IDS).nullable().default(null),
  model: ModelIdSchema.nullable().default(null),
  /**
   * Hide agent, model and ordinal from the evaluator. On by default for the reason it is in a
   * comparison: an evaluator told which agent wrote which submission attributes the divergence
   * to the brand rather than to the position.
   */
  anonymizeSubjects: z.boolean().default(true),
  maxAttempts: z.number().int().min(1).max(ENSEMBLE_HARD_LIMITS.maxStageAttempts).default(2),
  materialBudgetBytes: z
    .number()
    .int()
    .min(16 * 1024)
    .max(CONSENSUS_MAX_MATERIAL_BYTES)
    .default(CONSENSUS_DEFAULT_MATERIAL_BYTES),
});
export type ConsensusEvaluator = z.infer<typeof ConsensusEvaluatorSchema>;

export const ConsensusConfigSchema = z
  .object({
    members: z
      .array(ConsensusMemberSchema)
      .min(CONSENSUS_MIN_MEMBERS)
      .max(CONSENSUS_MAX_MEMBERS)
      .default([DEFAULT_MEMBER, DEFAULT_MEMBER, DEFAULT_MEMBER]),
    evaluator: ConsensusEvaluatorSchema.default({}),
    maxConcurrentMembers: z
      .number()
      .int()
      .min(1)
      .max(ENSEMBLE_HARD_LIMITS.maxConcurrentMembers)
      .default(CONSENSUS_DEFAULT_CONCURRENCY),
    deadlineMs: z
      .number()
      .int()
      .positive()
      .max(7 * 24 * 60 * 60 * 1000)
      .nullable()
      .default(null),
  })
  // An override the harness cannot honour would be dropped silently at launch, so the roster on
  // screen would not be the roster that runs. Refused here, exactly as Best-of-N refuses it.
  .superRefine((config, ctx) => {
    config.members.forEach((member, index) => {
      if (member.agent === null || member.effort === null) return;
      if (supportsEffort(member.agent, member.effort)) return;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["members", index, "effort"],
        message: `${member.agent} does not support ${member.effort} reasoning effort`,
      });
    });
  });
export type ConsensusConfig = z.infer<typeof ConsensusConfigSchema>;

/** What an untouched form holds. Derived from the schema so the two cannot disagree. */
export const CONSENSUS_DEFAULTS: ConsensusConfig = ConsensusConfigSchema.parse({});

export const CONSENSUS_CAPABILITIES: EnsembleStrategyCapabilities = {
  // Nothing is promoted, so there is no single live Session at the end to hand a Workflow.
  singleSessionFinalization: false,
  sharesArtifacts: false,
  requiresHumanDecision: true,
  artifactKinds: ["commit"],
  launchShape: "fixed",
};

export const CONSENSUS_FORM: StrategyFormSpec = {
  fields: [
    {
      kind: "member_roster",
      key: "members",
      label: "Attempts",
      help:
        "Each row is one agent working alone from the same pinned commit. Distinct approach " +
        "hints are what give the evaluator real positions to compare rather than three drafts " +
        "of the same idea.",
      minRows: CONSENSUS_MIN_MEMBERS,
      maxRows: CONSENSUS_MAX_MEMBERS,
      allowDuplicates: true,
    },
    {
      kind: "int",
      key: "maxConcurrentMembers",
      label: "Building at once",
      help: "How many attempts may hold a worktree and a running agent simultaneously.",
      min: 1,
      max: ENSEMBLE_HARD_LIMITS.maxConcurrentMembers,
      step: 1,
    },
    {
      kind: "toggle",
      key: "evaluator.anonymizeSubjects",
      label: "Mine blind",
      help:
        "Hide which agent and model produced each attempt from the evaluator. On by default: " +
        "otherwise a divergence gets attributed to the brand rather than to the position.",
    },
    {
      kind: "int",
      key: "evaluator.maxAttempts",
      label: "Mining retries",
      help: "How many times the divergence pass may be attempted against the same immutable evidence.",
      min: 1,
      max: ENSEMBLE_HARD_LIMITS.maxStageAttempts,
      step: 1,
    },
  ],
};

/**
 * What creating this would start.
 *
 * `evaluationCalls` is one for the same reason Best-of-N's is: the roster is fixed, there is one
 * wave and one evaluation, and a retry is a retry rather than a second question set. The member
 * agents' own token use is deliberately not counted - it is unbounded by definition.
 */
export function consensusEstimate(raw: unknown): EnsembleLaunchEstimate | null {
  const parsed = ConsensusConfigSchema.safeParse(raw);
  if (!parsed.success) return null;
  const config = parsed.data;
  return {
    initialMembers: config.members.length,
    maxMembers: config.members.length,
    maxConcurrentMembers: Math.min(config.maxConcurrentMembers, config.members.length),
    maxWaves: 1,
    evaluationCalls: 1,
  };
}

// ---- the divergence result ----

/**
 * Every bound on the consensus result, in one place.
 *
 * These cap what the MODEL may return before the value is persisted or shown. The counts matter
 * as much as the lengths: a question set the operator cannot finish answering is a run that never
 * terminates, and "prefer few consequential questions" in the guidance is advice while
 * `divergences` here is the rule.
 */
export const CONSENSUS_RESULT_LIMITS = {
  label: 40,
  agreement: 400,
  agreements: 12,
  question: 400,
  divergences: 8,
  optionLabel: 120,
  optionRationale: 800,
  /** An option is one position; at most every subject holds a distinct one. */
  optionsPerDivergence: ENSEMBLE_HARD_LIMITS.maxMembers,
  /** An operator's own answer, or their aside on a chosen option. */
  note: 2_000,
} as const;

/**
 * One position on one question, AS THE MODEL RETURNS IT - attributed by anonymous submission
 * label, never by artifact or member id.
 */
export const ConsensusOptionResultSchema = z
  .object({
    label: z.string().min(1).max(CONSENSUS_RESULT_LIMITS.optionLabel),
    rationale: z.string().max(CONSENSUS_RESULT_LIMITS.optionRationale),
    /** The submission labels that took this position. */
    submissions: z
      .array(z.string().min(1).max(CONSENSUS_RESULT_LIMITS.label))
      .min(1)
      .max(ENSEMBLE_HARD_LIMITS.maxMembers),
  })
  .strict();
export type ConsensusOptionResult = z.infer<typeof ConsensusOptionResultSchema>;

/** One question the fleet answered more than one way. Two options minimum, or it is not one. */
export const ConsensusDivergenceResultSchema = z
  .object({
    question: z.string().min(1).max(CONSENSUS_RESULT_LIMITS.question),
    options: z
      .array(ConsensusOptionResultSchema)
      .min(2)
      .max(CONSENSUS_RESULT_LIMITS.optionsPerDivergence),
  })
  .strict();
export type ConsensusDivergenceResult = z.infer<typeof ConsensusDivergenceResultSchema>;

/**
 * The consensus result the MODEL is asked to produce.
 *
 * Both arrays may be empty INDIVIDUALLY - a fleet that agreed on everything files no divergence,
 * one that agreed on nothing files no agreement - and the server refuses the case where both are,
 * which is the evaluator saying nothing at all rather than reporting a finding.
 */
export const ConsensusResultSchema = z
  .object({
    agreements: z
      .array(z.string().min(1).max(CONSENSUS_RESULT_LIMITS.agreement))
      .max(CONSENSUS_RESULT_LIMITS.agreements),
    divergences: z.array(ConsensusDivergenceResultSchema).max(CONSENSUS_RESULT_LIMITS.divergences),
  })
  .strict();
export type ConsensusResult = z.infer<typeof ConsensusResultSchema>;

/** The persisted, de-anonymised findings shape's own version, so a later one is distinguishable. */
export const CONSENSUS_FINDINGS_VERSION = 1;

/**
 * One position, as it is stored and rendered: a server-assigned id, the model's text, and the
 * exact artifact ids that took it.
 *
 * The ids are assigned by the SERVER after validation and are never model output. That is what
 * lets an answer name an option without the operator's recorded decision depending on a string
 * an agent's own diff could have influenced.
 */
export const ConsensusOptionSchema = z.object({
  id: z.string().min(1).max(40),
  label: z.string().min(1),
  rationale: z.string(),
  artifactIds: z.array(z.string().min(1)),
});
export type ConsensusOption = z.infer<typeof ConsensusOptionSchema>;

export const ConsensusDivergenceSchema = z.object({
  id: z.string().min(1).max(40),
  question: z.string().min(1),
  options: z.array(ConsensusOptionSchema).min(2),
});
export type ConsensusDivergence = z.infer<typeof ConsensusDivergenceSchema>;

/**
 * The findings as stored on the evaluation row and rendered by the browser: what the fleet agreed
 * on, and one identified question per thing it did not.
 */
export const ConsensusFindingsSchema = z.object({
  version: z.literal(CONSENSUS_FINDINGS_VERSION),
  agreements: z.array(z.string()),
  divergences: z.array(ConsensusDivergenceSchema),
  /** The artifact ids the findings were mined from, in the order they were presented. */
  subjectArtifactIds: z.array(z.string().min(1)),
  /** True when any subject's diff was truncated for the evaluator - a reason to trust it less. */
  evidenceTruncated: z.boolean(),
});
export type ConsensusFindings = z.infer<typeof ConsensusFindingsSchema>;

/**
 * Read stored findings back, or null when the value is not one this build can render.
 *
 * A detail response derives its divergence cards through this, never by trusting the JSON's
 * shape - a row written by a newer build, or a corrupt one, must degrade to "no readable result"
 * rather than a half-rendered question. Mirrors `parseBestOfNComparison`.
 */
export function parseConsensusFindings(body: unknown): ConsensusFindings | null {
  const parsed = ConsensusFindingsSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

// ---- the decision stage's persisted question set ----

/** The command discriminant on an `answer_divergences` decision stage attempt's input. */
export const CONSENSUS_DECISION_COMMAND = "answer_divergences";

/**
 * What the decision stage attempt's INPUT holds: the exact questions the operator was asked.
 *
 * Persisted rather than re-derived, and this is the load-bearing half of the evaluator-derived
 * decision-options primitive. An answer is validated against THIS, so a review retried after the
 * run parked - or an evaluation row edited by a newer build - cannot turn a recorded answer into
 * an answer to a question nobody saw.
 */
export const ConsensusDecisionInputSchema = z.object({
  command: z.literal(CONSENSUS_DECISION_COMMAND),
  version: z.literal(CONSENSUS_FINDINGS_VERSION),
  /** The evaluation the questions were mined from, for provenance. Null if it is gone. */
  evaluationId: z.string().min(1).nullable(),
  agreements: z.array(z.string()),
  questions: z.array(ConsensusDivergenceSchema),
});
export type ConsensusDecisionInput = z.infer<typeof ConsensusDecisionInputSchema>;

export function parseConsensusDecisionInput(body: unknown): ConsensusDecisionInput | null {
  const parsed = ConsensusDecisionInputSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

/**
 * The answers an operator posts, mirrored here and in the server driver so both boundaries reject
 * the same bodies. Semantic validation - one answer per asked question, an option that question
 * actually offered, a note where there is no option - is the driver's.
 */
export const ConsensusAnswersSelectionSchema = z
  .object({
    kind: z.literal("answers"),
    answers: z
      .array(
        z
          .object({
            questionId: z.string().min(1).max(40),
            optionId: z.string().min(1).max(40).nullable(),
            note: z.string().max(CONSENSUS_RESULT_LIMITS.note).default(""),
          })
          .strict(),
      )
      .max(CONSENSUS_RESULT_LIMITS.divergences),
  })
  .strict();
export type ConsensusAnswersSelection = z.infer<typeof ConsensusAnswersSelectionSchema>;

export function parseConsensusAnswers(body: unknown): ConsensusAnswersSelection | null {
  const parsed = ConsensusAnswersSelectionSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

/** Server-assigned, stable within one question set. `q1`, `q2`, … - never model output. */
export function divergenceQuestionId(index: number): string {
  return `q${index + 1}`;
}

/** Server-assigned option id, scoped to its question: `q1-a`, `q1-b`, … */
export function divergenceOptionId(questionIndex: number, optionIndex: number): string {
  return `${divergenceQuestionId(questionIndex)}-${String.fromCharCode(97 + optionIndex)}`;
}
