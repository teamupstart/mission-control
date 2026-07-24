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
 * renders and the launch estimate it prints before anybody confirms. Compilation into a
 * generic plan lives in `src/server/ensembles/strategies/best-of-n.ts`; nothing here knows
 * what a stage or a driver is.
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
  runner: z.enum(LLM_RUNNER_IDS).nullable().default(null),
  model: ModelIdSchema.nullable().default(null),
  /** Hide agent, model and ordinal from the judge. On by default; bias is the default risk. */
  anonymizeSubjects: z.boolean().default(true),
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
      kind: "toggle",
      key: "evaluator.anonymizeSubjects",
      label: "Judge blind",
      help:
        "Hide which agent and model produced each candidate from the comparison. On by " +
        "default: those attributes invite brand and order bias.",
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
