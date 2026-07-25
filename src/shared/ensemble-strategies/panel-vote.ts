import { z } from "zod";
import { AGENT_TYPES, THINKING_LEVELS } from "../types.ts";
import { supportsEffort } from "../harness-capabilities.ts";
import { LLM_RUNNER_IDS } from "../llm.ts";
import { ModelIdSchema } from "../protocol.ts";
import { ENSEMBLE_HARD_LIMITS, ENSEMBLE_LIMITS, type EnsembleLaunchEstimate } from "../ensemble.ts";
import type { EnsembleStrategyCapabilities, StrategyFormSpec } from "./types.ts";

/**
 * Panel vote, the second ensemble strategy: the same isolated roster Best-of-N launches, then M
 * independent single-lens judges score EVERY submission in parallel, and a pure aggregation ranks
 * them while keeping the judges' disagreement visible beside the recommendation.
 *
 * This file is the BROWSER-safe half - the lenses, the config schema, the form, the launch
 * estimate, the result shapes and the aggregation. Compilation lives in
 * `src/server/ensembles/strategies/panel-vote.ts` and execution in
 * `src/server/ensembles/reviews/panel.ts`; nothing here knows what a stage, a driver or a provider
 * is.
 *
 * What this strategy adds over one comparative call is not a better ranking - it is a SECOND
 * signal. One judge asked to weigh correctness, maintainability and risk at once returns a single
 * ordering that hides which of those it traded away; three judges each asked for one of them return
 * an ordering plus the places they disagree, and where they disagree is exactly what a person has
 * to decide. That is why the aggregate never suppresses a split: `disagreement` and per-artifact
 * `rankSpread` are first-class outputs, not diagnostics.
 */

// ---- built-in lenses (append-only rubric ids) ----

/**
 * The lens ids a judge may be given, in default panel order.
 *
 * APPEND-ONLY, and for the harder of the two usual reasons: a lens id is not merely persisted in a
 * config blob, it is persisted as a `builtin` rubric id INSIDE a compiled plan, and the panel
 * driver resolves it back to text on every attempt. Renaming one does not re-aim an in-flight run,
 * it makes that run's judge unresolvable - and the driver correctly fails the attempt rather than
 * judging with a substitute. A reworded lens is therefore a NEW id beside the old one, exactly as
 * `BEST_OF_N_BUILTIN_RUBRIC` is.
 */
export const PANEL_LENS_IDS = [
  "panel_correctness_v1",
  "panel_maintainability_v1",
  "panel_risk_v1",
  "panel_evidence_v1",
  "panel_scope_v1",
] as const;
export type PanelLensId = (typeof PANEL_LENS_IDS)[number];

/**
 * What each lens is called and what it tells its judge to weigh.
 *
 * `Record<PanelLensId, …>` is the enforcement: a lens id appended above does not compile until it
 * has a label an operator can pick and the exact text the judge will be given. The text is
 * deliberately SINGLE-minded - each one names what to weigh and, just as importantly, what to
 * ignore - because a panel of five judges that each silently re-derive the whole rubric is five
 * expensive samples of one opinion.
 */
export const PANEL_LENSES: Record<PanelLensId, { label: string; blurb: string; text: string }> = {
  panel_correctness_v1: {
    label: "Correctness",
    blurb: "Does it actually do the task, and is it right?",
    text: [
      "You are judging ONE dimension only: correctness against the task and its acceptance criteria.",
      "Weigh whether the change does what was asked, whether it handles the cases the task implies, and whether you can see a defect in what was written.",
      "Deliberately do NOT weigh style, structure, diff size, or how maintainable the result is - other judges are weighing those, and duplicating them here wastes the panel.",
      "A submission that is elegant but does less of the task ranks below one that is plainer and complete.",
    ].join("\n"),
  },
  panel_maintainability_v1: {
    label: "Maintainability",
    blurb: "Would you want to own this code next quarter?",
    text: [
      "You are judging ONE dimension only: how maintainable this change is, and how well it fits the repository's existing conventions.",
      "Weigh naming, structure, the honesty of comments, duplication, and whether the next person to touch this area is helped or hindered.",
      "Deliberately do NOT re-litigate whether the change is correct or how risky it is - other judges are weighing those.",
      "Assume every submission is correct for the purpose of this ranking, and rank on what living with it would cost.",
    ].join("\n"),
  },
  panel_risk_v1: {
    label: "Risk",
    blurb: "What could this break, and how badly?",
    text: [
      "You are judging ONE dimension only: regression surface and security risk.",
      "Weigh the blast radius of what was touched, error and failure handling, concurrency and data-loss hazards, and anything that widens an attack surface or weakens a check.",
      "Deliberately do NOT weigh elegance or completeness - other judges are weighing those.",
      "A larger diff is not automatically riskier; a two-line change to a shared invariant may be the riskiest submission in the set.",
    ].join("\n"),
  },
  panel_evidence_v1: {
    label: "Evidence",
    blurb: "How well is the work actually demonstrated?",
    text: [
      "You are judging ONE dimension only: the strength of the evidence that this change works.",
      "Weigh the tests added or changed, what they would actually catch, and the checks the author reports having run.",
      "Treat every author-reported check as a CLAIM, never as proof it passed, and rank a submission that shows its work above one that asserts it.",
      "Deliberately do NOT weigh style or scope - other judges are weighing those.",
    ].join("\n"),
  },
  panel_scope_v1: {
    label: "Scope",
    blurb: "Did it stay inside the task it was given?",
    text: [
      "You are judging ONE dimension only: scope discipline.",
      "Weigh whether the change did the task and stopped, whether unrelated edits, drive-by refactors or reformatting rode along, and whether anything necessary was left out.",
      "Deliberately do NOT weigh correctness or maintainability directly - other judges are weighing those.",
      "Both failures count: doing too much and doing too little are the same defect from opposite sides.",
    ].join("\n"),
  },
};

/** Resolve a lens id back to its exact text, or null when this build has never had it. */
export function panelLensText(lensId: string): { label: string; text: string } | null {
  return (PANEL_LENS_IDS as readonly string[]).includes(lensId)
    ? PANEL_LENSES[lensId as PanelLensId]
    : null;
}

// ---- bounds ----

export const PANEL_VOTE_MIN_MEMBERS = 2;
export const PANEL_VOTE_DEFAULT_MEMBERS = 3;
export const PANEL_VOTE_MAX_MEMBERS = 5;

export const PANEL_VOTE_MIN_JUDGES = 2;
export const PANEL_VOTE_DEFAULT_JUDGES = 3;
export const PANEL_VOTE_MAX_JUDGES = 5;

/**
 * The quorum: how many judges must return a valid ballot for the aggregate to mean anything.
 *
 * Two, and never one. A "panel" of one surviving judge is a comparative review wearing a panel's
 * label - its disagreement measure is vacuously zero, which reads on screen as unanimous agreement
 * when it is actually the absence of a second opinion. Below quorum the stage FAILS and retries
 * against the same immutable subjects rather than recommending from what came back.
 */
export const PANEL_VOTE_MIN_QUORUM = 2;

/**
 * How much artifact material ONE panel attempt may consume, in bytes, split evenly across subjects.
 *
 * The same 400 KiB Best-of-N allows, and deliberately not M times that: the evidence packet is
 * built ONCE and every judge is asked about the same bytes, so the per-judge prompt is one packet
 * plus one lens. Budgeting per judge would multiply the cost of the panel by M for no extra
 * evidence, and letting each judge see different material would make their disagreement
 * uninterpretable - the entire product claim rests on the subjects being identical.
 */
export const PANEL_VOTE_DEFAULT_MATERIAL_BYTES = 400 * 1024;
export const PANEL_VOTE_MAX_MATERIAL_BYTES = 2 * 1024 * 1024;

// ---- config ----

/**
 * One roster row - the same shape Best-of-N's members have.
 *
 * Restated rather than imported so the two strategies' configs can move independently: they are
 * two persisted blobs under two strategy keys, and a bound one of them later needs is not a bound
 * the other inherits.
 */
export const PanelVoteMemberSchema = z.object({
  agent: z.enum(AGENT_TYPES).nullable().default(null),
  model: ModelIdSchema.nullable().default(null),
  effort: z.enum(THINKING_LEVELS).nullable().default(null),
  /** Free-text nudge toward a different approach. Repeated configurations are valid. */
  approach: z.string().max(ENSEMBLE_LIMITS.approach).nullable().default(null),
});
export type PanelVoteMember = z.infer<typeof PanelVoteMemberSchema>;

/**
 * One judge.
 *
 * `lens` is what the judge weighs when no Persona is named, and it is REQUIRED to be one this
 * build has - a panel whose judges all fell back to the same default rubric is the failure mode
 * this strategy exists to avoid. `personaId` overrides it with an operator-authored lens, resolved
 * to an exact revision at creation and snapshotted into the plan, exactly as Best-of-N resolves
 * its comparative Persona: the same drift a base-commit pin removes.
 */
export const PanelVoteJudgeSchema = z.object({
  lens: z.enum(PANEL_LENS_IDS).default("panel_correctness_v1"),
  /**
   * An operator-authored Persona to judge with, replacing the lens above, or null to use it.
   *
   * A bare id here, resolved by the daemon at creation. The compiler refuses to compile an id it
   * was not handed a resolution for, so a Persona that has been deleted or archived fails visibly
   * at creation rather than silently leaving this judge on a built-in lens the operator replaced.
   */
  personaId: z.string().min(1).max(200).nullable().default(null),
  /**
   * Optionally pin the Persona revision this request was built against. When set and the live
   * Persona has moved on, creation is REFUSED rather than snapshotting newer guidance under the
   * request that was made.
   */
  personaRevision: z.number().int().positive().nullable().default(null),
  runner: z.enum(LLM_RUNNER_IDS).nullable().default(null),
  model: ModelIdSchema.nullable().default(null),
});
export type PanelVoteJudge = z.infer<typeof PanelVoteJudgeSchema>;

const DEFAULT_MEMBER: PanelVoteMember = { agent: null, model: null, effort: null, approach: null };

/** The default panel: correctness, maintainability, risk - three lenses that genuinely trade off. */
const DEFAULT_JUDGE_LENSES: PanelLensId[] = [
  "panel_correctness_v1",
  "panel_maintainability_v1",
  "panel_risk_v1",
];

const DEFAULT_JUDGES: PanelVoteJudge[] = DEFAULT_JUDGE_LENSES.map((lens) => ({
  lens,
  personaId: null,
  personaRevision: null,
  runner: null,
  model: null,
}));

export const PanelVoteConfigSchema = z
  .object({
    members: z
      .array(PanelVoteMemberSchema)
      .min(PANEL_VOTE_MIN_MEMBERS)
      .max(PANEL_VOTE_MAX_MEMBERS)
      .default([DEFAULT_MEMBER, DEFAULT_MEMBER, DEFAULT_MEMBER]),
    judges: z
      .array(PanelVoteJudgeSchema)
      .min(PANEL_VOTE_MIN_JUDGES)
      .max(PANEL_VOTE_MAX_JUDGES)
      .default(DEFAULT_JUDGES),
    /** The panel always anonymizes, so this durable parity field is not offered as a form control. */
    anonymizeSubjects: z.boolean().default(true),
    maxAttempts: z.number().int().min(1).max(ENSEMBLE_HARD_LIMITS.maxStageAttempts).default(2),
    materialBudgetBytes: z
      .number()
      .int()
      .min(16 * 1024)
      .max(PANEL_VOTE_MAX_MATERIAL_BYTES)
      .default(PANEL_VOTE_DEFAULT_MATERIAL_BYTES),
    maxConcurrentMembers: z
      .number()
      .int()
      .min(1)
      .max(ENSEMBLE_HARD_LIMITS.maxConcurrentMembers)
      .default(3),
    /** Wall-clock ceiling from creation, or null. Bounded at a week so a typo cannot park a run. */
    deadlineMs: z
      .number()
      .int()
      .positive()
      .max(7 * 24 * 60 * 60 * 1000)
      .nullable()
      .default(null),
  })
  .superRefine((config, ctx) => {
    // An override the harness cannot honour would be dropped silently at launch, and the operator
    // would read a roster that says `xhigh` beside an agent running at its default.
    config.members.forEach((member, index) => {
      if (member.agent === null || member.effort === null) return;
      if (supportsEffort(member.agent, member.effort)) return;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["members", index, "effort"],
        message: `${member.agent} does not support ${member.effort} reasoning effort`,
      });
    });
    // Two judges given the same built-in lens are two samples of one opinion presented as a panel:
    // their agreement is guaranteed and their disagreement measure is meaningless. Two judges on
    // the same PERSONA is a different claim - the operator wrote that guidance and may want it
    // sampled twice - so only the built-in case is refused, and only where no Persona replaced it.
    const seenLens = new Map<string, number>();
    config.judges.forEach((judge, index) => {
      if (judge.personaId !== null) return;
      const first = seenLens.get(judge.lens);
      if (first !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["judges", index, "lens"],
          message: `the ${PANEL_LENSES[judge.lens].label} lens is already judge ${first + 1}; a panel needs distinct lenses to disagree`,
        });
        return;
      }
      seenLens.set(judge.lens, index);
    });
  });
export type PanelVoteConfig = z.infer<typeof PanelVoteConfigSchema>;

/** What an untouched form holds. Derived from the schema so the two cannot disagree. */
export const PANEL_VOTE_DEFAULTS: PanelVoteConfig = PanelVoteConfigSchema.parse({});

export const PANEL_VOTE_CAPABILITIES: EnsembleStrategyCapabilities = {
  singleSessionFinalization: true,
  sharesArtifacts: false,
  requiresHumanDecision: true,
  artifactKinds: ["commit"],
  launchShape: "fixed",
};

export const PANEL_VOTE_FORM: StrategyFormSpec = {
  fields: [
    {
      kind: "member_roster",
      key: "members",
      label: "Candidates",
      help:
        "Each row is one agent working alone from the same pinned commit. Repeating a row is a " +
        "legitimate way to sample the same configuration twice.",
      minRows: PANEL_VOTE_MIN_MEMBERS,
      maxRows: PANEL_VOTE_MAX_MEMBERS,
      allowDuplicates: true,
    },
    {
      kind: "lens_panel",
      key: "judges",
      label: "Panel",
      help:
        "Each judge scores every submission from one lens alone, in parallel. Pick lenses that " +
        "genuinely trade off - where they disagree is the point.",
      minRows: PANEL_VOTE_MIN_JUDGES,
      maxRows: PANEL_VOTE_MAX_JUDGES,
      options: PANEL_LENS_IDS.map((id) => ({
        value: id,
        label: PANEL_LENSES[id].label,
        help: PANEL_LENSES[id].blurb,
      })),
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
      key: "maxAttempts",
      label: "Panel retries",
      help:
        "How many times the whole panel may be re-run against the same immutable evidence when " +
        `fewer than ${PANEL_VOTE_MIN_QUORUM} judges return a usable ballot.`,
      min: 1,
      max: ENSEMBLE_HARD_LIMITS.maxStageAttempts,
      step: 1,
    },
  ],
};

/**
 * What creating this would start.
 *
 * `evaluationCalls` is the judge count, not one: the honest number here is the one the operator is
 * agreeing to spend, and a panel's whole cost difference from Best-of-N is that it asks M models
 * instead of one. The member agents' own token use is deliberately not counted - it is unbounded
 * work by definition, and inventing a number for it would be the dishonest half of an honest
 * estimate.
 */
export function panelVoteEstimate(raw: unknown): EnsembleLaunchEstimate | null {
  const parsed = PanelVoteConfigSchema.safeParse(raw);
  if (!parsed.success) return null;
  const config = parsed.data;
  return {
    initialMembers: config.members.length,
    maxMembers: config.members.length,
    maxConcurrentMembers: Math.min(config.maxConcurrentMembers, config.members.length),
    maxWaves: 1,
    evaluationCalls: config.judges.length,
  };
}

// ---- one judge's ballot ----

/**
 * Every bound on a ballot, in one place.
 *
 * These cap what a MODEL may return before the value is persisted or shown. The semantic rules -
 * integer scores, contiguous ranks, every subject scored exactly once - are applied by the driver
 * on top of the parse, for the reason Best-of-N states: a judge that misunderstood the scale must
 * be refused, never clamped into a plausible-looking ballot.
 */
export const PANEL_BALLOT_LIMITS = {
  label: 40,
  summary: 4_000,
  caveat: 600,
  caveats: 12,
  strength: 600,
  strengths: 12,
  risk: 600,
  risks: 12,
  rationale: 3_000,
} as const;

/** One subject's score AS THE JUDGE RETURNS IT - keyed by an anonymous label, never an artifact id. */
export const PanelBallotSubjectSchema = z
  .object({
    label: z.string().min(1).max(PANEL_BALLOT_LIMITS.label),
    score: z.number().finite(),
    rank: z.number().finite(),
    strengths: z.array(z.string().max(PANEL_BALLOT_LIMITS.strength)).max(PANEL_BALLOT_LIMITS.strengths),
    risks: z.array(z.string().max(PANEL_BALLOT_LIMITS.risk)).max(PANEL_BALLOT_LIMITS.risks),
    rationale: z.string().max(PANEL_BALLOT_LIMITS.rationale),
    confidence: z.number().finite(),
  })
  .strict();
export type PanelBallotSubject = z.infer<typeof PanelBallotSubjectSchema>;

/**
 * One judge's ballot, as the model is asked to produce it.
 *
 * There is no `recommendation` field, unlike the comparative result, and its absence is deliberate:
 * a judge's preference IS the subject it put at rank 1, so asking for it twice adds a way for the
 * two answers to contradict each other and nothing else. The panel's recommendation is the
 * aggregate's, and no single judge makes it.
 */
export const PanelBallotSchema = z
  .object({
    summary: z.string().max(PANEL_BALLOT_LIMITS.summary),
    caveats: z.array(z.string().max(PANEL_BALLOT_LIMITS.caveat)).max(PANEL_BALLOT_LIMITS.caveats),
    subjects: z.array(PanelBallotSubjectSchema).min(2).max(ENSEMBLE_HARD_LIMITS.maxMembers),
  })
  .strict();
export type PanelBallot = z.infer<typeof PanelBallotSchema>;

/** The persisted ballot's own version, so a later shape is distinguishable off an evaluation row. */
export const PANEL_VERDICT_VERSION = 1;

export const PanelScorecardSchema = z.object({
  artifactId: z.string().min(1),
  score: z.number().int().min(0).max(100),
  rank: z.number().int().positive(),
  strengths: z.array(z.string()),
  risks: z.array(z.string()),
  rationale: z.string(),
  confidence: z.number().min(0).max(1),
});
export type PanelScorecard = z.infer<typeof PanelScorecardSchema>;

/**
 * One judge's ballot as it is STORED on its own evaluation row - labels resolved to the exact
 * artifact ids the decision stage will offer, scorecards in ascending rank order, and the identity
 * of the lens that produced it carried alongside so the aggregate can name who disagreed.
 */
export const PanelVerdictSchema = z.object({
  version: z.literal(PANEL_VERDICT_VERSION),
  /** The compiled judge key (`judge-1`), stable for the life of the run. */
  judgeKey: z.string().min(1),
  /** What to call this judge on screen - a lens name or a Persona's pinned name. */
  judgeLabel: z.string().min(1),
  summary: z.string(),
  caveats: z.array(z.string()),
  /** Ascending rank order. */
  scorecards: z.array(PanelScorecardSchema).min(1),
  /** True when any subject's diff was truncated for this judge - a reason to trust it less. */
  evidenceTruncated: z.boolean(),
});
export type PanelVerdict = z.infer<typeof PanelVerdictSchema>;

/**
 * Read a stored ballot back, or null when the value is not one this build can render.
 *
 * Every reader goes through this rather than trusting the JSON's shape: a row written by a newer
 * build, or a corrupt one, must degrade to "no readable ballot" rather than a half-rendered card.
 * Mirrors `parseBestOfNComparison`.
 */
export function parsePanelVerdict(body: unknown): PanelVerdict | null {
  const parsed = PanelVerdictSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

// ---- aggregation ----

/** One artifact's standing across the whole panel. */
export interface PanelAggregateEntry {
  artifactId: string;
  /** Final aggregate rank, 1-based and contiguous, ties broken deterministically. */
  rank: number;
  /**
   * Borda points: summed over judges, each awarding `subjects - rank` to a subject. Higher is
   * better, and this - not the mean score - is what orders the panel, because a 0-100 score is a
   * scale each judge invented privately while a rank is a comparison between the same subjects.
   */
  points: number;
  /** Mean rank across the judges that ranked it. Lower is better; reported for readability. */
  meanRank: number;
  /** Mean of the judges' scores. Display only - never the ordering. */
  meanScore: number;
  /** Every judge's rank for this artifact, in judge order. */
  ranks: Array<{ judgeKey: string; judgeLabel: string; rank: number; score: number }>;
  /** Worst rank minus best rank: 0 when every judge placed it identically. */
  rankSpread: number;
  /** True when the judges did not place this artifact identically. */
  contested: boolean;
}

/** What the panel concluded, and how much the judges disagreed getting there. */
export interface PanelAggregate {
  /** Ascending aggregate rank. */
  entries: PanelAggregateEntry[];
  /** The top entry, or null when no judge produced a usable ballot. */
  recommendedArtifactId: string | null;
  /** How many ballots this aggregate is built from. */
  judgeCount: number;
  /**
   * Mean normalized Kendall tau distance over every pair of judges: the share of subject PAIRS the
   * two judges ordered differently, averaged. 0 is unanimous, 1 is perfectly reversed. Chosen over
   * "did the top pick match" because that question cannot tell a panel that agrees on everything
   * but the winner from one that agrees on nothing else either.
   */
  disagreement: number;
  /** True when every judge returned exactly the same ordering. */
  unanimous: boolean;
  /** True when the top two entries could not be separated on points or mean rank. */
  tied: boolean;
  /** True when any ballot reported truncated evidence. */
  evidenceTruncated: boolean;
}

/**
 * Aggregate the panel's ballots into one ranking plus its disagreement, purely.
 *
 * PURE and total: no clock, no randomness, no I/O, and a deterministic answer for any input,
 * including the degenerate ones (no ballots, one ballot, judges that scored different subject
 * sets). The daemon calls it to label the stage and the dashboard calls it to draw the result, and
 * the two must not be able to reach different conclusions from the same rows - which is the whole
 * reason it lives in shared code rather than being computed on either side.
 *
 * Ordering is Borda points descending, then mean rank ascending, then artifact id - a total order,
 * so the aggregate rank is contiguous and the same ballots always produce the same recommendation.
 * A subject a judge did not rank simply does not contribute that judge's points; it is not scored
 * zero, because a missing ballot entry is an absence of judgement and treating it as the worst
 * possible verdict would let one failed judge decide the panel.
 */
export function aggregatePanelVotes(verdicts: readonly PanelVerdict[]): PanelAggregate {
  const artifactIds: string[] = [];
  const seen = new Set<string>();
  for (const verdict of verdicts) {
    for (const card of verdict.scorecards) {
      if (seen.has(card.artifactId)) continue;
      seen.add(card.artifactId);
      artifactIds.push(card.artifactId);
    }
  }

  const entries = artifactIds.map((artifactId): Omit<PanelAggregateEntry, "rank"> => {
    const ranks: PanelAggregateEntry["ranks"] = [];
    let points = 0;
    let rankTotal = 0;
    let scoreTotal = 0;
    for (const verdict of verdicts) {
      const card = verdict.scorecards.find((c) => c.artifactId === artifactId);
      if (!card) continue;
      ranks.push({
        judgeKey: verdict.judgeKey,
        judgeLabel: verdict.judgeLabel,
        rank: card.rank,
        score: card.score,
      });
      points += verdict.scorecards.length - card.rank;
      rankTotal += card.rank;
      scoreTotal += card.score;
    }
    const counted = ranks.length;
    const rankValues = ranks.map((r) => r.rank);
    const rankSpread = counted === 0 ? 0 : Math.max(...rankValues) - Math.min(...rankValues);
    return {
      artifactId,
      points,
      meanRank: counted === 0 ? 0 : rankTotal / counted,
      meanScore: counted === 0 ? 0 : scoreTotal / counted,
      ranks,
      rankSpread,
      contested: rankSpread > 0,
    };
  });

  entries.sort(
    (a, b) =>
      b.points - a.points ||
      a.meanRank - b.meanRank ||
      (a.artifactId < b.artifactId ? -1 : a.artifactId > b.artifactId ? 1 : 0),
  );
  const ranked: PanelAggregateEntry[] = entries.map((entry, index) => ({ ...entry, rank: index + 1 }));

  const top = ranked[0] ?? null;
  const runnerUp = ranked[1] ?? null;
  return {
    entries: ranked,
    recommendedArtifactId: top?.artifactId ?? null,
    judgeCount: verdicts.length,
    disagreement: meanKendallTau(verdicts),
    unanimous: verdicts.length > 1 && ranked.every((entry) => !entry.contested),
    tied:
      top !== null &&
      runnerUp !== null &&
      top.points === runnerUp.points &&
      top.meanRank === runnerUp.meanRank,
    evidenceTruncated: verdicts.some((verdict) => verdict.evidenceTruncated),
  };
}

/**
 * The mean normalized Kendall tau distance between every pair of ballots.
 *
 * For one pair: over the subjects BOTH judges ranked, the fraction of subject pairs they ordered
 * differently. Restricting to the shared subjects is what keeps a judge that scored a smaller set
 * from registering as disagreement it never expressed. Fewer than two ballots, or fewer than two
 * shared subjects, is no evidence of disagreement at all - which is 0, and the caller states
 * `unanimous` separately so a single ballot is never PRESENTED as agreement.
 */
function meanKendallTau(verdicts: readonly PanelVerdict[]): number {
  const distances: number[] = [];
  for (let i = 0; i < verdicts.length; i++) {
    for (let j = i + 1; j < verdicts.length; j++) {
      const a = rankMap(verdicts[i]!);
      const b = rankMap(verdicts[j]!);
      const shared = [...a.keys()].filter((id) => b.has(id));
      if (shared.length < 2) continue;
      let discordant = 0;
      let pairs = 0;
      for (let x = 0; x < shared.length; x++) {
        for (let y = x + 1; y < shared.length; y++) {
          const left = shared[x]!;
          const right = shared[y]!;
          pairs++;
          const aOrder = Math.sign(a.get(left)! - a.get(right)!);
          const bOrder = Math.sign(b.get(left)! - b.get(right)!);
          if (aOrder !== bOrder) discordant++;
        }
      }
      if (pairs > 0) distances.push(discordant / pairs);
    }
  }
  if (distances.length === 0) return 0;
  return distances.reduce((sum, d) => sum + d, 0) / distances.length;
}

function rankMap(verdict: PanelVerdict): Map<string, number> {
  return new Map(verdict.scorecards.map((card) => [card.artifactId, card.rank]));
}
