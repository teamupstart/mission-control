import { z } from "zod";
import { AGENT_TYPES, THINKING_LEVELS } from "../types.ts";
import { supportsEffort } from "../harness-capabilities.ts";
import { LLM_RUNNER_IDS } from "../llm.ts";
import { ModelIdSchema } from "../protocol.ts";
import { ENSEMBLE_HARD_LIMITS, ENSEMBLE_LIMITS, type EnsembleLaunchEstimate } from "../ensemble.ts";
import type { EnsembleStrategyCapabilities, StrategyFormSpec } from "./types.ts";

/**
 * Best-of-N, the first ensemble strategy: two to five isolated implementation candidates,
 * one tool-less comparative review, and a human-confirmed promotion.
 *
 * This file is the BROWSER-safe half - the input schema, its bounds, the form the dashboard
 * can render in a later phase and the launch estimate it can print before anybody confirms.
 * Compilation into a generic plan lives in
 * `src/server/ensembles/strategies/best-of-n.ts`; nothing here knows what a stage or a driver
 * is.
 *
 * The bounds are product decisions, not tuning knobs: fewer than two candidates is not a
 * comparison, and more than five is uncontrolled local resource use for a comparison that
 * stops getting better. The daemon's own `ENSEMBLE_HARD_LIMITS` sit above them and are what
 * stop ANY strategy - including one appended later - from launching an unbounded fleet.
 */

export const BEST_OF_N_MIN_CANDIDATES = 2;
export const BEST_OF_N_DEFAULT_CANDIDATES = 3;
export const BEST_OF_N_MAX_CANDIDATES = 5;

/** How many candidates may be building at once by default. */
export const BEST_OF_N_DEFAULT_CONCURRENCY = 3;

/**
 * How much artifact material one comparison may consume, in bytes, split evenly across the
 * eligible subjects. Roughly 400 KiB: enough for several real patches, small enough that a
 * five-way comparison cannot become an unbounded prompt. File-level statistics and an
 * explicit truncation disclosure always survive the cut - see the evaluator phase.
 */
export const BEST_OF_N_DEFAULT_MATERIAL_BYTES = 400 * 1024;
export const BEST_OF_N_MAX_MATERIAL_BYTES = 2 * 1024 * 1024;

/** The built-in rubric's id. Append-only: it is persisted inside a compiled plan. */
export const BEST_OF_N_BUILTIN_RUBRIC = "best_of_n_v1";

/**
 * The built-in rubric's TEXT, versioned by the id above.
 *
 * Owned by `best_of_n@1`: a plan compiled with no Persona snapshots `{ kind: "builtin";
 * rubricId: BEST_OF_N_BUILTIN_RUBRIC }` and the comparative reviewer resolves that id to
 * exactly this text. It is append-only in the same sense the id is - a changed rubric is a
 * NEW id beside this one, so a run compiled today keeps its exact rubric after the wording
 * moves on. Order is priority order and the comparator is told to treat it as such.
 */
export const BEST_OF_N_BUILTIN_RUBRIC_TEXT = [
  "Rank the submissions by the following criteria, in order of importance:",
  "1. Correctness against the task and its acceptance criteria.",
  "2. The strength of OBSERVED evidence and the quality of any relevant checks the author reports having run. Treat a reported check as a claim, not as proof it passed.",
  "3. Maintainability, clarity, and fit with the repository's existing conventions.",
  "4. Scope discipline, regression surface, and security risk.",
  "5. Diff size only as a tie-breaker - never prefer a smaller diff that does less of the task.",
  "Surface uncertainty explicitly wherever a truncated diff, a missing test, a binary change, or an incomparable approach makes a judgement less reliable.",
].join("\n");

/**
 * One roster row.
 *
 * Every override is nullable and null means "the daemon's default at launch", which is NOT
 * the same as pinning today's default - the same distinction `DispatchSchema.model` makes,
 * and what lets a run created today launch on a default changed tomorrow.
 */
export const BestOfNMemberSchema = z.object({
  agent: z.enum(AGENT_TYPES).nullable().default(null),
  model: ModelIdSchema.nullable().default(null),
  effort: z.enum(THINKING_LEVELS).nullable().default(null),
  /** Free-text nudge toward a different approach. Repeated configurations are valid. */
  approach: z.string().max(ENSEMBLE_LIMITS.approach).nullable().default(null),
});
export type BestOfNMember = z.infer<typeof BestOfNMemberSchema>;

const DEFAULT_MEMBER: BestOfNMember = { agent: null, model: null, effort: null, approach: null };

export const BestOfNEvaluatorSchema = z.object({
  /**
   * An operator-authored Persona to judge with, or null for the built-in rubric.
   *
   * A bare id here, resolved to an exact revision by the daemon at creation and snapshotted
   * into the plan. The compiler refuses to compile an id it was not handed a resolution
   * for, so a Persona that has been deleted fails visibly at creation rather than silently
   * falling back to the built-in rubric on a run the operator configured differently.
   */
  personaId: z.string().min(1).max(200).nullable().default(null),
  /**
   * Optionally pin the Persona revision the operator built this request against. When set and
   * the live Persona has since moved on, creation is REFUSED rather than snapshotting newer
   * guidance under the request they made - the same drift a base-commit pin removes. Null
   * snapshots whatever the current revision is at creation.
   */
  personaRevision: z.number().int().positive().nullable().default(null),
  runner: z.enum(LLM_RUNNER_IDS).nullable().default(null),
  model: ModelIdSchema.nullable().default(null),
  /**
   * Persisted, always `true`, and NOT an operator control - see the consensus strategy's copy of
   * this field for the argument. The comparative packet is unconditionally anonymous, so this
   * states what happens rather than choosing it, and it normalizes so a stored `false` cannot
   * describe a comparison as de-anonymised when it was not.
   */
  anonymizeSubjects: z
    .boolean()
    .default(true)
    .transform(() => true as const),
  maxAttempts: z
    .number()
    .int()
    .min(1)
    .max(ENSEMBLE_HARD_LIMITS.maxStageAttempts)
    .default(2),
  materialBudgetBytes: z
    .number()
    .int()
    .min(16 * 1024)
    .max(BEST_OF_N_MAX_MATERIAL_BYTES)
    .default(BEST_OF_N_DEFAULT_MATERIAL_BYTES),
});
export type BestOfNEvaluator = z.infer<typeof BestOfNEvaluatorSchema>;

export const BestOfNConfigSchema = z
  .object({
    members: z
      .array(BestOfNMemberSchema)
      .min(BEST_OF_N_MIN_CANDIDATES)
      .max(BEST_OF_N_MAX_CANDIDATES)
      .default([DEFAULT_MEMBER, DEFAULT_MEMBER, DEFAULT_MEMBER]),
    evaluator: BestOfNEvaluatorSchema.default({}),
    maxConcurrentMembers: z
      .number()
      .int()
      .min(1)
      .max(ENSEMBLE_HARD_LIMITS.maxConcurrentMembers)
      .default(BEST_OF_N_DEFAULT_CONCURRENCY),
    /** Wall-clock ceiling from creation, or null. Bounded at a week so a typo cannot park a run. */
    deadlineMs: z
      .number()
      .int()
      .positive()
      .max(7 * 24 * 60 * 60 * 1000)
      .nullable()
      .default(null),
  })
  // An override the harness cannot honour would be dropped silently at launch, and the
  // operator would read a roster that says `xhigh` beside an agent running at its default.
  // Refused here so the roster on screen is the roster that runs.
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
export type BestOfNConfig = z.infer<typeof BestOfNConfigSchema>;

/** What an untouched form holds. Derived from the schema so the two cannot disagree. */
export const BEST_OF_N_DEFAULTS: BestOfNConfig = BestOfNConfigSchema.parse({});

export const BEST_OF_N_CAPABILITIES: EnsembleStrategyCapabilities = {
  singleSessionFinalization: true,
  sharesArtifacts: false,
  requiresHumanDecision: true,
  artifactKinds: ["commit"],
  launchShape: "fixed",
};

export const BEST_OF_N_FORM: StrategyFormSpec = {
  fields: [
    {
      kind: "member_roster",
      key: "members",
      label: "Candidates",
      help:
        "Each row is one agent working alone from the same pinned commit. Repeating a row " +
        "is a legitimate way to sample the same configuration twice.",
      minRows: BEST_OF_N_MIN_CANDIDATES,
      maxRows: BEST_OF_N_MAX_CANDIDATES,
      allowDuplicates: true,
    },
    {
      kind: "int",
      key: "maxConcurrentMembers",
      label: "Building at once",
      help: "How many candidates may hold a worktree and a running agent simultaneously.",
      min: 1,
      max: ENSEMBLE_HARD_LIMITS.maxConcurrentMembers,
      step: 1,
    },
    {
      kind: "int",
      key: "evaluator.maxAttempts",
      label: "Comparison retries",
      help: "How many times one comparison may be attempted against the same immutable evidence.",
      min: 1,
      max: ENSEMBLE_HARD_LIMITS.maxStageAttempts,
      step: 1,
    },
  ],
};

/**
 * What creating this would start.
 *
 * Exact rather than a range because the roster is fixed: `initialMembers` equals
 * `maxMembers`, there is one wave, and the ensemble itself makes exactly one model call
 * unless a comparison has to be retried. The member agents' own token use is deliberately
 * not counted here - it is unbounded work by definition, and pretending to a number for it
 * would be the dishonest half of an honest estimate.
 */
export function bestOfNEstimate(raw: unknown): EnsembleLaunchEstimate | null {
  const parsed = BestOfNConfigSchema.safeParse(raw);
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

// ---- comparative result ----

/**
 * Every bound on the comparative result, in one place.
 *
 * These cap what the MODEL may return before the value is ever persisted or shown, which is
 * one half of the honesty contract - a judge that pads its rationale to a megabyte must be
 * refused, not stored. The other half is the semantic validation the server applies on top
 * of a parse: exact labels once each, integer scores, contiguous ranks, a recommendation
 * that actually holds rank 1. This schema does STRUCTURE and length; the server does meaning.
 */
export const BEST_OF_N_RESULT_LIMITS = {
  label: 40,
  comparison: 6_000,
  caveat: 600,
  caveats: 12,
  strength: 600,
  strengths: 12,
  risk: 600,
  risks: 12,
  rationale: 3_000,
} as const;

/**
 * One subject's scorecard AS THE MODEL RETURNS IT - keyed by an anonymous label, never an
 * artifact or member id.
 *
 * `score`, `rank` and `confidence` are only `finite()` here on purpose: a score of 250 or a
 * rank of 0 is a STRUCTURALLY valid number, and the reason it must be refused is a semantic
 * one the server states with a precise message (an integer 0..100, contiguous ranks, a
 * confidence in 0..1). Clamping them the way a Persona verdict clamps its confidence would
 * turn a judge that misunderstood the scale into a plausible-looking ranking, which is the
 * one thing a comparison that authorises a promotion may not do.
 */
export const BestOfNSubjectResultSchema = z.object({
  label: z.string().min(1).max(BEST_OF_N_RESULT_LIMITS.label),
  score: z.number().finite(),
  rank: z.number().finite(),
  strengths: z.array(z.string().max(BEST_OF_N_RESULT_LIMITS.strength)).max(BEST_OF_N_RESULT_LIMITS.strengths),
  risks: z.array(z.string().max(BEST_OF_N_RESULT_LIMITS.risk)).max(BEST_OF_N_RESULT_LIMITS.risks),
  rationale: z.string().max(BEST_OF_N_RESULT_LIMITS.rationale),
  confidence: z.number().finite(),
}).strict();
export type BestOfNSubjectResult = z.infer<typeof BestOfNSubjectResultSchema>;

/**
 * The comparative result the MODEL is asked to produce.
 *
 * Anonymous by construction: `recommendation` and every subject's `label` are opaque display
 * labels the server assigned, and the mapping back to artifact ids never enters the prompt.
 * The array is bounded by the daemon's hard member cap rather than Best-of-N's roster max so
 * the same schema serves any future comparison; the exact-count check is the server's.
 */
export const BestOfNComparisonResultSchema = z.object({
  recommendation: z.string().min(1).max(BEST_OF_N_RESULT_LIMITS.label),
  comparison: z.string().max(BEST_OF_N_RESULT_LIMITS.comparison),
  caveats: z.array(z.string().max(BEST_OF_N_RESULT_LIMITS.caveat)).max(BEST_OF_N_RESULT_LIMITS.caveats),
  subjects: z.array(BestOfNSubjectResultSchema).min(2).max(ENSEMBLE_HARD_LIMITS.maxMembers),
}).strict();
export type BestOfNComparisonResult = z.infer<typeof BestOfNComparisonResultSchema>;

/**
 * The persisted, de-anonymised comparison. Its own version, so a later result shape is
 * distinguishable from this one when read back off an evaluation row.
 */
export const BEST_OF_N_COMPARISON_VERSION = 1;

export const BestOfNScorecardSchema = z.object({
  artifactId: z.string().min(1),
  score: z.number().int().min(0).max(100),
  rank: z.number().int().positive(),
  strengths: z.array(z.string()),
  risks: z.array(z.string()),
  rationale: z.string(),
  confidence: z.number().min(0).max(1),
});
export type BestOfNScorecard = z.infer<typeof BestOfNScorecardSchema>;

/**
 * The comparison as it is stored and rendered - labels resolved to the exact artifact ids the
 * decision stage will offer, scorecards in ascending rank order, and the uncertainty the
 * evaluator raised carried alongside.
 */
export const BestOfNComparisonSchema = z.object({
  version: z.literal(BEST_OF_N_COMPARISON_VERSION),
  recommendedArtifactId: z.string().min(1),
  comparison: z.string(),
  caveats: z.array(z.string()),
  /** Ascending rank order. */
  scorecards: z.array(BestOfNScorecardSchema),
  /** True when any subject's diff was truncated for the evaluator - a reason to trust the ranking less. */
  evidenceTruncated: z.boolean(),
});
export type BestOfNComparison = z.infer<typeof BestOfNComparisonSchema>;

/**
 * Read a stored comparison back, or null when the value is not one this build can render.
 *
 * A detail response derives its scorecards from the evaluation row through this, never by
 * trusting the JSON's shape - a row written by a newer build, or a corrupt one, must degrade
 * to "no readable result" rather than a half-rendered card. Mirrors `parsePersonaVerdict`.
 */
export function parseBestOfNComparison(body: unknown): BestOfNComparison | null {
  const parsed = BestOfNComparisonSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}
