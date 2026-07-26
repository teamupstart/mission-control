import type { AgentType, ThinkingLevel } from "./types.ts";
import type { LlmRunnerId } from "./llm.ts";

/**
 * Multi-agent ensembles: the durable vocabulary, shared by the daemon and the browser.
 *
 * An **ensemble** is a group of ordinary Tasks run under one versioned strategy, plus the
 * group-level facts a Task cannot express - a compiled plan, member roles, immutable
 * artifacts, evaluations, a human decision, and a terminal outcome. Best-of-N is the first
 * STRATEGY, not the name of the engine: strategy-specific compiled policies can describe
 * candidates or judges, but every strategy persists through these same durable nouns.
 *
 * No `node:` imports reach this file and none may: the dashboard consumes these contracts,
 * so one `node:` import in the module graph takes the web bundle down. Compilation,
 * persistence and execution live under `src/server/ensembles/`.
 *
 * The tuples below the header are PERSISTED - every value appears in an operator's SQLite
 * file - so they are **append-only**, for the reason `TASK_SOURCE_KINDS` and
 * `WORKFLOW_TRIGGER_SOURCES` are: renaming one does not migrate the rows written under the
 * old spelling, it orphans them.
 */

// ---- persisted ids (append-only) ----

/**
 * The strategies this build can CREATE. Append-only; `best_of_n` is the first.
 *
 * Deliberately narrower than what this build can LOAD: a compiled plan persists an opaque
 * `EnsembleStrategyKey`, so a run written by a newer build still parses and reports itself
 * unreadable rather than being recompiled with today's defaults. See `EnsembleUnreadable`.
 */
export const ENSEMBLE_STRATEGY_IDS = ["best_of_n", "consensus", "panel_vote"] as const;
export type EnsembleStrategyId = (typeof ENSEMBLE_STRATEGY_IDS)[number];

/**
 * Who asked for an ensemble. Only `manual` exists: operator-originated creation through the
 * localhost API or the in-process manager.
 *
 * Workflow and Foreman are deliberately absent rather than reserved - a source id nothing
 * can produce is a value a reader has to handle and a test cannot reach. Append one when a
 * real inbound creation path exists.
 */
export const ENSEMBLE_SOURCE_KINDS = ["manual"] as const;
export type EnsembleSourceKind = (typeof ENSEMBLE_SOURCE_KINDS)[number];

/**
 * What KIND of work a stage is, and therefore which runtime executes it.
 *
 * Four, and the plan data owns everything else: how many members, which roles, what the
 * barrier waits for, which artifacts count. A strategy that needs a fifth kind is
 * introducing a genuinely new primitive, not merely a new strategy.
 */
export const ENSEMBLE_STAGE_DRIVER_KINDS = ["member", "review", "decision", "finalize"] as const;
export type EnsembleStageDriverKind = (typeof ENSEMBLE_STAGE_DRIVER_KINDS)[number];

/**
 * The exact driver implementations a compiled plan may name, as `id@version`.
 *
 * A plan PERSISTS this key rather than relying on whatever the current build considers the
 * default for its stage kind. That is the whole reason it exists: an in-flight run whose
 * review driver changed shape must go on executing the driver it was compiled
 * against, and a driver version that has been removed while a non-terminal run still names
 * it is a startup health error - never permission to invoke the latest one.
 *
 * APPEND-ONLY, including the version suffix: a new behaviour is `@2` beside `@1`.
 */
export const ENSEMBLE_DRIVER_KEYS = [
  "member_wave@1",
  "artifact_barrier@1",
  "comparative_review@1",
  "human_decision@1",
  "select_one_finalize@1",
  "consensus_review@1",
  "divergence_decision@1",
  "retain_all_finalize@1",
  "panel_review@1",
] as const;
export type EnsembleDriverKey = (typeof ENSEMBLE_DRIVER_KEYS)[number];

/**
 * What a member can submit, and what an evaluation can consume.
 *
 * Append-only: an artifact row's `kind` is how a later build knows which adapter validates
 * its locator. `commit` is the one both enabled strategies produce (an immutable private
 * Git commit created through a temporary index); the rest are named now so that appending
 * an adapter later never has to widen the member or stage tables.
 */
export const ENSEMBLE_ARTIFACT_KINDS = [
  "patch",
  "commit",
  "branch",
  "worktree",
  "summary",
  "test_report",
  "evaluation",
] as const;
export type EnsembleArtifactKind = (typeof ENSEMBLE_ARTIFACT_KINDS)[number];

// ---- persisted status vocabularies (append-only) ----

/**
 * Where a run is. Terminal states are named below rather than inferred from
 * `completedAt`: a nullable timestamp cannot tell a cancelled run from one still finalizing,
 * and recovery asks exactly that question on every start.
 */
export const ENSEMBLE_STATUSES = [
  "planning",
  "running",
  "waiting",
  "evaluating",
  "awaiting_decision",
  "finalizing",
  "completed",
  "cancelled",
  "failed",
  "cancelling",
] as const;
export type EnsembleStatus = (typeof ENSEMBLE_STATUSES)[number];

/** Derived, never written out again - see `SCHEDULE_TERMINAL_STATUSES` for the argument. */
export const ENSEMBLE_TERMINAL_STATUSES: readonly EnsembleStatus[] = ENSEMBLE_STATUSES.filter(
  (status) => status === "completed" || status === "cancelled" || status === "failed",
);

export function ensembleIsTerminal(status: EnsembleStatus): boolean {
  return ENSEMBLE_TERMINAL_STATUSES.includes(status);
}

/**
 * Where one logical member is.
 *
 * `pending` is the state a member is CREATED in - every member of a wave is durable before
 * the first Task in that wave is dispatched, so there is a row long before there is a
 * process. Scores, ranks and "winner" are deliberately absent: those are facts about an
 * evaluation or an outcome, and one artifact may be judged in several panels or rounds.
 */
export const ENSEMBLE_MEMBER_STATUSES = [
  "pending",
  "launching",
  "active",
  "submitted",
  "reviewing",
  "advanced",
  "eliminated",
  "failed",
  "withdrawn",
  "retained",
] as const;
export type EnsembleMemberStatus = (typeof ENSEMBLE_MEMBER_STATUSES)[number];

export const ENSEMBLE_TERMINAL_MEMBER_STATUSES: readonly EnsembleMemberStatus[] =
  ENSEMBLE_MEMBER_STATUSES.filter(
    (status) =>
      status === "advanced" ||
      status === "eliminated" ||
      status === "failed" ||
      status === "withdrawn" ||
      status === "retained",
  );

/** One launch of one member. A retry is a new attempt, never a rewritten member. */
export const ENSEMBLE_ATTEMPT_STATUSES = [
  "pending",
  "launching",
  "running",
  "submitted",
  "failed",
  "cancelled",
] as const;
export type EnsembleAttemptStatus = (typeof ENSEMBLE_ATTEMPT_STATUSES)[number];

export const ENSEMBLE_ARTIFACT_STATUSES = ["capturing", "ready", "failed", "superseded"] as const;
export type EnsembleArtifactStatus = (typeof ENSEMBLE_ARTIFACT_STATUSES)[number];

export const ENSEMBLE_STAGE_STATUSES = [
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type EnsembleStageStatus = (typeof ENSEMBLE_STAGE_STATUSES)[number];

/**
 * `interrupted` is not `failed`: a daemon that exited mid-call left a child whose result
 * nobody read, which is retryable against the SAME immutable subjects. A malformed answer
 * is a failure of the attempt and needs the operator to see it.
 */
export const ENSEMBLE_EVALUATION_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "interrupted",
] as const;
export type EnsembleEvaluationStatus = (typeof ENSEMBLE_EVALUATION_STATUSES)[number];

/**
 * A recorded human (or, later, system) decision.
 *
 * `recorded` is the choice; `applied` means finalization ran to completion against it;
 * `superseded` is what an earlier version becomes when a newer decision replaces it.
 * Decisions are versioned rather than updated so history explains what was chosen and when.
 */
export const ENSEMBLE_DECISION_STATUSES = ["recorded", "applied", "superseded"] as const;
export type EnsembleDecisionStatus = (typeof ENSEMBLE_DECISION_STATUSES)[number];

/**
 * Who made a decision. A model output is EVIDENCE and never an actor here: the invariant
 * that destructive finalization requires a human is enforced by refusing any actor but
 * `human` on a policy whose `requiresHumanDecision` is true.
 */
export const ENSEMBLE_DECISION_ACTORS = ["human", "system"] as const;
export type EnsembleDecisionActor = (typeof ENSEMBLE_DECISION_ACTORS)[number];

/** Where finalization got to. Durable, so a restart resumes rather than restarts. */
export const ENSEMBLE_FINALIZATION_STATUSES = ["pending", "running", "completed", "failed"] as const;
export type EnsembleFinalizationStatus = (typeof ENSEMBLE_FINALIZATION_STATUSES)[number];

export const ENSEMBLE_LLM_PURPOSES = ["comparative_review", "consensus_review", "panel_review"] as const;
export type EnsembleLlmPurpose = (typeof ENSEMBLE_LLM_PURPOSES)[number];

/**
 * What KIND of judgement a review stage's evaluator makes, persisted inside the compiled plan
 * and mirrored onto the evaluation row's `method`.
 *
 * Append-only, and deliberately NOT derivable from the driver key: the key names an exact
 * implementation (`consensus_review@1`) while this names the question being asked, which is what
 * a reader deciding how to render an evaluation result actually needs. `comparative_llm` ranks
 * and recommends one subject; `consensus_llm` compares the subjects' DECISIONS and returns
 * agreements plus open questions, recommending nothing.
 */
export const ENSEMBLE_EVALUATOR_KINDS = ["comparative_llm", "consensus_llm", "panel_llm"] as const;
export type EnsembleEvaluatorKind = (typeof ENSEMBLE_EVALUATOR_KINDS)[number];

export const ENSEMBLE_LLM_CALL_STATES = ["running", "succeeded", "failed", "interrupted"] as const;
export type EnsembleLlmCallState = (typeof ENSEMBLE_LLM_CALL_STATES)[number];

/** What a terminal outcome IS. Only `selected` is reachable in v1; the rest are shaped now
 *  so a retained/no-consensus strategy needs no new column. */
export const ENSEMBLE_OUTCOME_KINDS = [
  "selected",
  "synthesized",
  "retained",
  "no_consensus",
] as const;
export type EnsembleOutcomeKind = (typeof ENSEMBLE_OUTCOME_KINDS)[number];

/**
 * Where an optional post-selection Workflow handoff got to.
 *
 * A handoff is pinned at ensemble CREATION (its immutable version, defaults and display
 * snapshot) and driven at finalization. `pending` is the pinned-but-not-started state,
 * `binding`/`submitted` its two durable milestones, `failed` a remediable error, `conflict`
 * a note key already owned by a different active binding (offer retry or skip), and `skipped`
 * the operator's explicit `skip_workflow_handoff`. Append-only, for the reason the file is:
 * a persisted handoff state a newer build wrote must still read back on an older one.
 */
export const ENSEMBLE_WORKFLOW_HANDOFF_STATES = [
  "pending",
  "binding",
  "submitted",
  "failed",
  "conflict",
  "skipped",
] as const;
export type EnsembleWorkflowHandoffState = (typeof ENSEMBLE_WORKFLOW_HANDOFF_STATES)[number];

/**
 * Which finalization step a `finalizing` run has durably reached.
 *
 * Recovery reads THIS off the finalize stage attempt to resume rather than restart: a run
 * interrupted after its winner was made exact but before its member Tasks were reconciled must not
 * re-verify a decision or re-materialize a winner. `reaping_losers` also settles a superseded
 * original winner on the replacement path; the persisted step id remains append-only. Ordered by
 * execution, so a later step proves every earlier one durable.
 */
export const ENSEMBLE_FINALIZATION_STEPS = [
  "verifying",
  "materializing",
  "reaping_losers",
  "handoff",
  "completed",
] as const;
export type EnsembleFinalizationStep = (typeof ENSEMBLE_FINALIZATION_STEPS)[number];

/** Where an explicit history/ref deletion got to. Durable, so a crash resumes the same refs. */
export const ENSEMBLE_DELETION_STATUSES = ["pending", "deleting_refs", "completed", "failed"] as const;
export type EnsembleDeletionStatus = (typeof ENSEMBLE_DELETION_STATUSES)[number];

// ---- bounds ----

/**
 * Every durable text/JSON cap in one place, so stores, compilers and routes cannot
 * disagree about what "bounded" means. Byte caps are UTF-8 bytes, not code units.
 */
export const ENSEMBLE_LIMITS = {
  title: 200,
  intent: 20_000,
  /** One member's declarative appendix, rendered into its bounded launch prompt. */
  rolePrompt: 8_000,
  roleKey: 120,
  roleLabel: 120,
  stageId: 120,
  stageLabel: 120,
  approach: 2_000,
  /** The opaque strategy/driver key inside a persisted plan, from any build. */
  strategyKey: 200,
  strategyLabel: 120,
  sourceKey: 1_000,
  sourceId: 200,
  operationKey: 1_000,
  commandKey: 1_000,
  compiledPlanJsonBytes: 200_000,
  strategyConfigJsonBytes: 100_000,
  artifactLocatorJsonBytes: 32_000,
  artifactMetadataJsonBytes: 32_000,
  stagePayloadJsonBytes: 200_000,
  evaluationResultJsonBytes: 200_000,
  decisionSelectionJsonBytes: 32_000,
  eventPayloadJsonBytes: 64_000,
  rationale: 8_000,
  errorText: 4_000,
  resultLabel: 60,
  /**
   * Review guidance text, as SNAPSHOTTED into the compiled plan.
   *
   * Smaller than a Workflow Persona's own `personaGuidanceBytes` (100 KiB) on purpose: this
   * text lives INSIDE the compiled plan, which has its own `compiledPlanJsonBytes` ceiling.
   * The manager divides this shared budget across the Persona references named by a strategy
   * and truncates each snapshot before persistence rather than allowing the plan to burst.
   * The truncation is disclosed where it happens; it is not a silent clip.
   */
  reviewGuidanceBytes: 80_000,
  /** Page size reserved for the later HTTP detail surface. */
  detailPageSize: 200,
  /** One member submission's own bounded, member-authored content. */
  submissionSummary: 4_000,
  submissionCheck: 400,
  submissionChecks: 40,
  submissionTestEvidence: 8_000,
} as const;

/**
 * Hard ceilings no strategy config or driver command may exceed, whatever it asks for.
 *
 * Separate from a strategy's own bounds on purpose: Best-of-N caps its roster at five
 * because more than five is not a useful comparison, while THIS is the ceiling that stops
 * any strategy - including one appended later, and including an adaptive driver acting on
 * a model's suggestion - from launching an unbounded number of local agents.
 */
export const ENSEMBLE_HARD_LIMITS = {
  maxMembers: 16,
  maxConcurrentMembers: 8,
  maxWaves: 8,
  maxStageAttempts: 5,
} as const;

// ---- unreadable snapshots ----

/**
 * What a persisted run says that this build cannot execute.
 *
 * A run written by a NEWER build - an unknown strategy key, a driver version this binary
 * has never had, a compiled plan whose shape has moved on - still LOADS, because a run
 * nobody can see is one nobody can cancel or clean up. What it must never do is run:
 * reading an unknown strategy key as `best_of_n` would execute a plan the operator never
 * asked for, over real agents, on their machine.
 *
 * Enforcement is in the types rather than in a convention. Every field that could carry an
 * unreadable value is `T | null` on `EnsembleRun`, so a caller cannot reach a plan without
 * saying what it does when there isn't one - `ensembleIsRunnable` is the single narrowing
 * gate that answers that once. Same shape as `ScheduleUnreadable`, for the same reason.
 */
export interface EnsembleUnreadable {
  /** One operator-readable sentence naming the column and the value we could not read. */
  reason: string;
  /** Column names, for a UI that wants to mark the offending fields. */
  fields: string[];
}

// ---- compiled plan ----

/**
 * The SHAPE version of a compiled plan, bumped when this record's fields change - which is
 * a different fact from a strategy's own version. A snapshot carrying a higher number than
 * this build knows is unreadable rather than best-effort parsed.
 */
export const ENSEMBLE_PLAN_VERSION = 1;

/** Total launches, concurrent launches and waves are three different controls. */
export interface EnsembleBudget {
  /** Hard lifetime cap including retries and replacements. */
  maxMembers: number;
  /** Local process/worktree ceiling. */
  maxConcurrentMembers: number;
  maxWaves: number;
  maxStageAttempts: number;
  /** Wall-clock deadline in ms from run creation, or null for none. */
  deadlineMs: number | null;
}

/**
 * Which immutable artifacts a member may see.
 *
 * Default and only v1 value is `isolated`: a member receives the shared task, its own role
 * and approach, and nothing about its siblings. Sibling isolation is BEHAVIOURAL - the
 * worktrees share one Git repository and a local agent can find them - so nothing here or
 * in the UI may describe members as adversarially isolated.
 */
export type EnsembleInformationPolicy = { kind: "isolated" };

/**
 * Where a member's checkout starts.
 *
 * `run_base` is the run's single pinned base commit, and every Best-of-N member verifies the
 * same one. `parent_artifacts` is the second-wave case: a revision or synthesis member starts
 * from the immutable artifacts a PRIOR wave produced, named by the compiled ROLE keys of those
 * parents rather than by runtime ids the compiler cannot know. The launch runtime resolves
 * those role keys to the ready commit each parent submitted and pins the member to the first of
 * them - which is what makes "a second wave from parent artifact inputs" an ordinary pinned
 * dispatch rather than a new lifecycle. Append-only, for the reason the whole file is.
 */
export type EnsembleMemberInput =
  | { kind: "run_base" }
  | { kind: "parent_artifacts"; roleKeys: string[] };

/**
 * One member template, in stable compiled order.
 *
 * `key` is a deterministic LOGICAL id the compiler generates (`candidate-1`); runtime ids
 * are daemon-generated and never embedded by a compiler, or the same plan could not be
 * compiled twice for two runs.
 */
export interface EnsembleRoleSpec {
  key: string;
  label: string;
  /** Stable creation order, 1-based. Adaptive waves append; they never renumber. */
  ordinal: number;
  /** 1-based launch wave. */
  wave: number;
  /** Null means "whatever the daemon's default is at launch". */
  agent: AgentType | null;
  model: string | null;
  effort: ThinkingLevel | null;
  /** Optional operator hint about the approach this member should take. */
  approach: string | null;
  /** Declarative appendix to the ordinary task intent. Bounded; no evidence injected here. */
  promptTemplate: string;
  /** What this member must produce before a barrier can count it eligible. */
  requiredArtifacts: EnsembleArtifactKind[];
  input: EnsembleMemberInput;
}

/**
 * What a stage waits for.
 *
 * `members_settled` is the all-required-members barrier: every named role has reached a
 * terminal member status AND at least `minEligible` of them produced every required
 * artifact. Both halves matter - "everyone stopped" without the second is how a comparison
 * of one artifact gets manufactured.
 */
export type EnsembleBarrierSpec =
  | { kind: "none" }
  | {
      kind: "members_settled";
      roleKeys: string[];
      minEligible: number;
      requiredArtifacts: EnsembleArtifactKind[];
    }
  | { kind: "stages_succeeded"; stageIds: string[] }
  | { kind: "human_decision" };

/** Which artifacts one evaluation is ABOUT. */
export interface EnsembleSubjectPolicy {
  kind: "ready_artifacts";
  artifactKind: EnsembleArtifactKind;
  minSubjects: number;
  maxSubjects: number;
}

/**
 * Where a reviewer's guidance comes from, snapshotted at creation.
 *
 * The persona case carries the FULL guidance text, not just an id and a revision, and that
 * is load-bearing: it is embedded in the compiled plan, and recovery executes the compiled
 * plan rather than reloading the live Persona. An operator who edits or archives the Persona
 * after creation must not silently re-aim a run already judging against the text they chose,
 * exactly as a published Workflow pins a `PersonaSnapshot`. The `builtin` case names a
 * versioned rubric id whose text is owned by the strategy that named it; a new rubric is a
 * new id beside the old one, so an old plan keeps the exact rubric it named.
 */
export type EnsembleEvaluatorGuidance =
  | { kind: "builtin"; rubricId: string }
  | {
      kind: "persona";
      personaId: string;
      revision: number;
      /** The Persona's display name at the pinned revision, for labelling the guidance. */
      name: string;
      /** The exact guidance bytes at the pinned revision. Recovery reads THIS, never the live Persona. */
      guidanceMarkdown: string;
      /** The Persona's runner override at the pinned revision, or null for the app runner. */
      runner: LlmRunnerId | null;
      /** The Persona's model override at the pinned revision, or null for the ladder. */
      model: string | null;
    };

/**
 * A Persona resolved to an exact, immutable snapshot at ensemble creation.
 *
 * This is what a review-guidance resolver hands the compiler, and what the compiler pins into
 * the `persona` guidance case above. `id` here is the source Persona's id; the guidance case
 * spells it `personaId`. Resolving one reads SQLite, so it happens OUTSIDE the pure compiler -
 * the same reason the launch runtime, not the compiler, pins a base commit.
 */
export interface EnsembleReviewPersona {
  id: string;
  revision: number;
  name: string;
  guidanceMarkdown: string;
  runner: LlmRunnerId | null;
  model: string | null;
}

/**
 * One judge on a panel, as snapshotted into a compiled plan.
 *
 * `key` and `ordinal` are LOGICAL and deterministic (`judge-1`), for the reason
 * `EnsembleRoleSpec.key` is: the same config has to compile to the same plan twice, so no runtime
 * id appears here. `guidance` is the whole point - a panel is M judges over ONE subject set,
 * differing only in the lens each was given, which is what makes their disagreement information
 * rather than noise. A judge's runner/model overrides sit beside its guidance rather than on the
 * policy because a panel may legitimately mix providers.
 */
export interface EnsemblePanelJudgeSpec {
  key: string;
  label: string;
  /** Stable 1-based order, and the evaluation-row ordinal within one stage attempt. */
  ordinal: number;
  guidance: EnsembleEvaluatorGuidance;
  /** Null resolves through the daemon's own ladder at attempt time. */
  runner: LlmRunnerId | null;
  model: string | null;
}

/**
 * How a review stage judges. A union so a deterministic gate, a pairwise scheduler or a
 * Persona panel can be appended without touching the evaluation table.
 *
 * The single-evaluator arms answer the same three questions the engine and their drivers ask -
 * what guidance, whether to anonymize, and how much artifact material one attempt may consume -
 * while a panel carries one guidance snapshot per judge and defines its partial-answer quorum.
 */
export type EnsembleEvaluatorPolicy =
  | {
      kind: "comparative_llm" | "consensus_llm";
      guidance: EnsembleEvaluatorGuidance;
      /** Null resolves through the daemon's own ladder at attempt time. */
      runner: LlmRunnerId | null;
      model: string | null;
      /**
       * Hide agent, model and ordinal from the evaluator's input. True in v1: those attributes
       * are useful to the operator and invite brand and order bias in a judge.
       */
      anonymizeSubjects: boolean;
      /** Total artifact material one attempt may consume, allocated evenly across subjects. */
      materialBudgetBytes: number;
    }
  | {
      kind: "panel_llm";
      /** Two to five independent judges, each scoring EVERY eligible subject from its own lens. */
      judges: EnsemblePanelJudgeSpec[];
      /**
       * The quorum, compiled into the plan rather than decided at execution time.
       *
       * A judge whose call is malformed or interrupted fails ITS attempt only; the stage succeeds
       * when at least this many judges returned a valid ballot, and fails - retryably, against the
       * same immutable subjects - when fewer did. Compiled rather than constant because the number
       * that makes an aggregate defensible is a property of the plan the operator confirmed, and a
       * later build changing its mind must not re-aim a run already in flight.
       */
      minSuccessfulJudges: number;
      anonymizeSubjects: boolean;
      /** Total artifact material ONE attempt may consume - the packet is built once and shared. */
      materialBudgetBytes: number;
    };

/**
 * What a human is being asked to decide.
 *
 * A union, and both members carry `eligibleArtifactKind` / `minEligibleSubjects` because those
 * are the two facts the GENERIC engine reads to build the eligible artifact set before it hands
 * a selection to a driver - a member that omitted them would make that read conditional on the
 * policy kind, which is exactly the strategy branch the engine must not contain.
 *
 * `select_one` asks which single artifact wins. `answer_divergences` asks a question set the
 * EVALUATOR derived from the artifacts, and its options are rendered from the decision stage's
 * persisted input rather than from a strategy-static scorecard - the one new primitive the
 * consensus strategy needed. It promotes nothing, so its finalization is `retain_all`.
 */
export type EnsembleDecisionPolicy =
  | {
      kind: "select_one";
      eligibleArtifactKind: EnsembleArtifactKind;
      minEligibleSubjects: number;
    }
  | {
      kind: "answer_divergences";
      eligibleArtifactKind: EnsembleArtifactKind;
      minEligibleSubjects: number;
    };

/**
 * What the terminal outcome does.
 *
 * `requiresHumanDecision` is the literal `true` on EVERY member rather than a boolean, the same
 * device `WorkflowCaptureExpectation.requireCleanWorktree` uses. For `select_one` the reason is
 * that finalization resets a branch and reaps worktrees, so the type itself must refuse a policy
 * that opts out. For `retain_all` nothing destructive happens at all, and the literal stays
 * because the run's PRODUCT is the recorded human answer: a terminal outcome nobody confirmed
 * would be a question set filed as if it had been settled.
 */
export type EnsembleFinalizationPolicy =
  | {
      kind: "select_one";
      requiresHumanDecision: true;
      /** Losers give back their worktrees; their immutable artifacts are always retained. */
      loserPolicy: "reap_worktrees";
    }
  | {
      kind: "retain_all";
      requiresHumanDecision: true;
      /**
       * Every member is retained and no worktree is reaped by finalization itself. The members'
       * agents are still settled through the ordinary Task cancellation a completed run performs,
       * which is what a `no_consensus` outcome already does - "non-destructive" means no artifact,
       * ref or branch is discarded, not that agents keep running after the run ends.
       */
      loserPolicy: "retain";
    };

interface EnsembleStageBase {
  /** Deterministic logical id, stable for the life of the run. */
  id: string;
  ordinal: number;
  label: string;
  /**
   * The exact implementation this stage was compiled against, as the opaque `id@version`
   * key - a bounded STRING and not `EnsembleDriverKey`, for the reason `strategyKey` is.
   * A plan written by a newer build must stay READABLE so an operator can see what it was
   * going to do and cancel it; what it must not do is execute, and `knownDriverKey`
   * returning null is where that is decided.
   */
  driverKey: string;
  /** Stage ids that must have succeeded first. */
  dependsOn: string[];
  barrier: EnsembleBarrierSpec;
  maxAttempts: number;
}

export type EnsembleStageSpec =
  | (EnsembleStageBase & { driverKind: "member"; wave: number; roleKeys: string[] })
  | (EnsembleStageBase & {
      driverKind: "review";
      evaluator: EnsembleEvaluatorPolicy;
      subjects: EnsembleSubjectPolicy;
    })
  | (EnsembleStageBase & { driverKind: "decision"; decision: EnsembleDecisionPolicy })
  | (EnsembleStageBase & { driverKind: "finalize"; finalization: EnsembleFinalizationPolicy });

/**
 * The immutable execution plan snapshotted into a run.
 *
 * Recovery executes THIS, never a fresh compilation: a compiler that changes its defaults
 * must not silently re-aim a run that is already half-launched. Retries create attempts;
 * they never rewrite a plan.
 *
 * `strategyKey` is `id@version` as a bounded opaque string rather than the
 * `EnsembleStrategyId` union, and that is the load-bearing difference between what this
 * build can create and what it can load.
 */
export interface CompiledEnsemblePlan {
  planVersion: number;
  strategyKey: string;
  budget: EnsembleBudget;
  information: EnsembleInformationPolicy;
  roles: EnsembleRoleSpec[];
  stages: EnsembleStageSpec[];
}

/** What the later creation UI can tell an operator before they confirm. */
export interface EnsembleLaunchEstimate {
  /** Members launched immediately. */
  initialMembers: number;
  /** Hard lifetime cap, including any later wave. */
  maxMembers: number;
  maxConcurrentMembers: number;
  maxWaves: number;
  /** Model calls the ensemble itself will make, excluding the member agents' own work. */
  evaluationCalls: number;
}

// ---- creation ----

/** What a caller asks for. Server-generated ids remain authoritative. */
export interface EnsembleCreateInput {
  /**
   * Stable per-submission idempotency key the CALLER mints and reuses on retry. A response
  * lost on the way back must not launch another N agents.
  */
  sourceKey: string;
  /** Absent defaults to operator-originated `manual`. */
  sourceKind?: EnsembleSourceKind;
  /** Display identity of the external record, or null when the source is the operator. */
  sourceId?: string | null;
  title: string;
  intent: string;
  repoRoot: string;
  strategyId: EnsembleStrategyId;
  /** Optional pin; absent means "this build's current version for that strategy". */
  strategyVersion?: number;
  /** Validated by the chosen strategy's own schema, never by the generic record. Absent is `{}`. */
  strategyConfig?: unknown;
  /**
   * Optional post-selection Workflow handoff. The daemon resolves the id + version to ONE immutable
   * published version and refuses an unsupported mode; the caller never supplies the version id,
   * binding defaults, or delivery mode.
   */
  workflow?: { workflowId: string; workflowVersion: number } | null;
}

// ---- durable records ----

/** JSON that has crossed a validation boundary. */
export type EnsembleJson =
  | null
  | boolean
  | number
  | string
  | EnsembleJson[]
  | { [key: string]: EnsembleJson };

export const ENSEMBLE_PAYLOAD_VERSION = 1 as const;

export interface EnsemblePayloadEnvelope {
  payloadVersion: typeof ENSEMBLE_PAYLOAD_VERSION;
  body: EnsembleJson;
}

export function ensemblePayload(body: EnsembleJson): EnsemblePayloadEnvelope {
  return { payloadVersion: ENSEMBLE_PAYLOAD_VERSION, body };
}

export function canonicalEnsembleJson(value: EnsembleJson): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalEnsembleJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalEnsembleJson(value[key] as EnsembleJson)}`).join(",")}}`;
}

export function ensembleJsonEqual(a: EnsembleJson, b: EnsembleJson): boolean {
  return canonicalEnsembleJson(a) === canonicalEnsembleJson(b);
}

export type EnsembleOutcome =
  | { kind: "selected"; memberIds: string[]; artifactIds: string[]; materializedTaskId: string | null }
  | { kind: "synthesized"; memberId: string; artifactId: string; materializedTaskId: string | null }
  | { kind: "retained"; memberIds: string[]; artifactIds: string[] }
  | { kind: "no_consensus"; artifactIds: string[]; reason: string };

/**
 * An optional post-selection Workflow handoff, pinned at creation and driven at finalization.
 *
 * The immutable version, its binding defaults, its completion policy and a DISPLAY snapshot are
 * resolved once at creation (`resolveWorkflowVersion`), so a Persona edit or an archive after
 * creation cannot re-aim it - exactly as a published Workflow pins a `PersonaSnapshot`. The mode
 * fields are plain strings on purpose: they are a display snapshot of what was chosen, and keeping
 * them decoupled from the Workflow enums keeps this browser-safe record append-only without
 * importing the Workflow vocabulary. Only Preview + manual is accepted on this baseline; a
 * Live/Foreman selection is a typed refusal at creation, never a silent Preview downgrade.
 *
 * Everything below `state` is runtime identity filled in AS the handoff runs: the derived
 * server-side `sourceKey`, the `expectedHeadSha` the submission was pinned to, and the returned
 * binding/run/submission ids. Its lifecycle is entirely separate from the linked Workflow's own:
 * a completed Ensemble whose Workflow later fails is still completed, and a Workflow Reset that
 * removes the binding leaves this snapshot rendering the link as removed rather than recreating it.
 */
export interface EnsembleWorkflowHandoff {
  workflowId: string;
  workflowVersionId: string;
  workflowVersion: number;
  workflowName: string;
  /** A display snapshot of the pinned binding defaults - not the live Workflow's current ones. */
  triggerMode: string;
  deliveryMode: string;
  maxRepairRounds: number;
  /** The pinned completion policy's discriminant, for display; the Workflow owns its execution. */
  completionPolicy: string;
  state: EnsembleWorkflowHandoffState;
  /** The opaque server-derived idempotency key, once the handoff begins. Never parsed by a reader. */
  sourceKey: string | null;
  /** The snapshot SHA the submission was pinned to require. */
  expectedHeadSha: string | null;
  bindingId: string | null;
  runId: string | null;
  submissionId: string | null;
  error: string | null;
}

/**
 * The durable per-step receipt a `finalizing` run leaves, read by recovery to RESUME.
 *
 * Persisted on the finalize stage attempt's output. Every field is a receipt of an effect that
 * already happened, so a repeated finalization pass reads them and skips forward rather than
 * re-verifying a decision or re-materializing a winner. The two fields that MUST be durable
 * (nothing else can re-derive them) are `continuationDeliveryKey`/`continuationDelivered` - a
 * continuation sent twice is the failure this record exists to rule out.
 */
export interface EnsembleFinalizationProgress {
  step: EnsembleFinalizationStep;
  /** The snapshot SHA the selected artifact's private ref was re-verified to resolve to. */
  verifiedSnapshotSha: string | null;
  /** How the one exact winner was made available. */
  winner: { mode: "restored" | "replacement"; ready: boolean } | null;
  continuationInIntent: boolean;
  /** True once every loser is terminal and any superseded original winner has been settled. */
  losersReaped: boolean;
  /** Deterministic key for the one continuation message, so a restart cannot send it twice. */
  continuationDeliveryKey: string | null;
  continuationDelivered: boolean;
  /** The last actionable error a step recorded, kept visible while the run stays `finalizing`. */
  error: string | null;
}

export interface EnsembleRun {
  id: string;
  sourceKind: EnsembleSourceKind | null;
  /** Opaque, caller-derived idempotency key. Never parsed by a reader. */
  sourceKey: string;
  sourceId: string | null;
  /** Null when this build has never heard of the persisted strategy - see `unreadable`. */
  strategyId: EnsembleStrategyId | null;
  /** Always present, whatever wrote it: `id@version`. */
  strategyKey: string;
  strategyVersion: number;
  strategyLabel: string;
  title: string;
  intent: string;
  repoRoot: string;
  /** Informational; the commit below is what members are actually cut from. */
  baseBranch: string | null;
  /** The one full commit every member starts at. Null until the launch runtime pins it. */
  baseSha: string | null;
  /** Null when the persisted plan cannot be read by this build - see `unreadable`. */
  plan: CompiledEnsemblePlan | null;
  /** The validated strategy config the plan was compiled from, kept for history. */
  strategyConfig: EnsembleJson;
  /** Null when the stored value is not one this build knows. */
  status: EnsembleStatus | null;
  activeStageId: string | null;
  outcome: EnsembleOutcome | null;
  /** The optional post-selection Workflow handoff, pinned at creation, or null when none was chosen. */
  workflowHandoff: EnsembleWorkflowHandoff | null;
  unreadable: EnsembleUnreadable | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

/**
 * A run this build can execute.
 *
 * The type the engine works in. Reaching it costs one call to
 * `ensembleIsRunnable`, and that call is the fail-closed gate: there is no other way to get
 * a non-null plan out of an `EnsembleRun`.
 */
export interface RunnableEnsembleRun extends EnsembleRun {
  sourceKind: EnsembleSourceKind;
  strategyId: EnsembleStrategyId;
  plan: CompiledEnsemblePlan;
  status: EnsembleStatus;
  unreadable: null;
}

export function ensembleIsRunnable(run: EnsembleRun): run is RunnableEnsembleRun {
  return (
    run.unreadable === null &&
    run.sourceKind !== null &&
    run.strategyId !== null &&
    run.plan !== null &&
    run.status !== null
  );
}

export interface EnsembleMember {
  id: string;
  runId: string;
  /** The compiled role this member instantiates. Stable for the life of the run. */
  roleKey: string;
  roleLabel: string;
  ordinal: number;
  wave: number;
  /** The Task this member is, or null before its wave is dispatched. */
  taskId: string | null;
  status: EnsembleMemberStatus | null;
  /** The attempt whose artifacts represent this member, once one does. */
  selectedAttemptId: string | null;
  /**
   * A bounded, strategy-derived human label - "rank 1", "advanced", "critic". Components
   * render it; they never interpret strategy-specific JSON to derive one.
   */
  resultLabel: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface EnsembleAttempt {
  id: string;
  runId: string;
  memberId: string;
  attempt: number;
  taskId: string | null;
  sessionId: string | null;
  /** Launch facts as they were actually resolved, not as they were requested. */
  agent: AgentType | null;
  requestedModel: string | null;
  requestedEffort: ThinkingLevel | null;
  observedModel: string | null;
  /** The commit this attempt's worktree was verified to stand on. */
  baseSha: string | null;
  worktreePath: string | null;
  branch: string | null;
  status: EnsembleAttemptStatus | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface EnsembleArtifact {
  id: string;
  runId: string;
  /** The attempt that produced it, or null for an artifact the run itself owns. */
  attemptId: string | null;
  kind: EnsembleArtifactKind | null;
  /** The adapter's own versioned locator format. Append-only per kind. */
  formatVersion: number;
  /** Capture attempt within (run, attempt, kind). Artifacts are immutable; retries append. */
  attempt: number;
  status: EnsembleArtifactStatus | null;
  /** Where the bytes are - a ref, a commit, a path. Never the bytes themselves. */
  locator: EnsembleJson;
  /** Content digest, so a later read can prove it is the same artifact. */
  digest: string;
  metadata: EnsembleJson;
  error: string | null;
  createdAt: number;
  readyAt: number | null;
}

export interface EnsembleStageAttempt {
  id: string;
  runId: string;
  stageId: string;
  driverKind: EnsembleStageDriverKind | null;
  /** The exact driver the plan named. Null when this build no longer has it. */
  driverKey: EnsembleDriverKey | null;
  attempt: number;
  /** Deterministic key persisted BEFORE any side effect, so a restart cannot repeat one. */
  commandKey: string;
  status: EnsembleStageStatus | null;
  input: EnsembleJson;
  output: EnsembleJson | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface EnsembleEvaluation {
  id: string;
  runId: string;
  stageAttemptId: string;
  attempt: number;
  method: string;
  /** What actually ran, resolved at attempt time - not what the policy asked for. */
  runnerId: string | null;
  modelId: string | null;
  /** Digest of the exact bounded input, so a retry can prove it judged the same evidence. */
  inputFingerprint: string;
  /** The artifact ids judged, in the order they were presented. */
  subjectArtifactIds: string[];
  result: EnsemblePayloadEnvelope | null;
  status: EnsembleEvaluationStatus | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

export interface EnsembleLlmCall {
  id: string;
  runId: string;
  stageAttemptId: string | null;
  evaluationId: string | null;
  purpose: EnsembleLlmPurpose | null;
  runnerId: string;
  modelId: string;
  attempt: number;
  state: EnsembleLlmCallState | null;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  inputBytes: number;
  outputBytes: number;
  /** Authoritative-only. Null means the runner did not report a cost, never zero. */
  costUsd: number | null;
  errorCode: string | null;
}

export interface EnsembleDecision {
  id: string;
  runId: string;
  /** 1-based. A new decision supersedes rather than overwrites its predecessor. */
  version: number;
  actor: EnsembleDecisionActor | null;
  actorId: string | null;
  status: EnsembleDecisionStatus | null;
  /** What was chosen, in the finalization policy's own vocabulary. */
  selection: EnsemblePayloadEnvelope;
  rationale: string;
  /** The finalize stage attempt that executed it, once one has. */
  finalizationStageAttemptId: string | null;
  createdAt: number;
  updatedAt: number;
}

/** One operator-visible orchestration transition. Append-only, bounded, never a transcript. */
export interface EnsembleEvent {
  id: number;
  runId: string;
  ts: number;
  kind: string;
  payload: EnsembleJson;
}

// ---- projections ----

/**
 * The bounded catalog projection carried over SSE.
 *
 * Small on purpose and bounded independently of the strategy: a later tournament may
 * generate hundreds of pairwise evaluations and this shape must not grow with them. Full
 * members, artifacts, evaluations, stage output and patches stay on HTTP.
 */
export interface EnsembleSummary {
  id: string;
  title: string;
  repoRoot: string;
  /** Null when this build cannot name the persisted strategy; `strategyKey` still can. */
  strategyId: EnsembleStrategyId | null;
  strategyKey: string;
  strategyLabel: string;
  strategyVersion: number;
  status: EnsembleStatus | null;
  activeStageId: string | null;
  memberCount: number;
  /** Members that have reached at least `launching`. */
  launchedMembers: number;
  maxMembers: number;
  /** Artifacts in `ready`, which is what a barrier and a decision actually count. */
  readyArtifacts: number;
  selectedMemberId: string | null;
  outcomeKind: EnsembleOutcomeKind | null;
  /** The recoverability signal: set when this build cannot execute the stored snapshot. */
  unreadable: EnsembleUnreadable | null;
  /** Derived: this run is terminal-failed, unreadable, or waiting on a person. */
  attention: boolean;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

/** Everything one run is, returned by its bounded HTTP detail read. */
export interface EnsembleRunDetail {
  run: EnsembleRun;
  members: EnsembleMember[];
  attempts: EnsembleAttempt[];
  artifacts: EnsembleArtifact[];
  stageAttempts: EnsembleStageAttempt[];
  evaluations: EnsembleEvaluation[];
  decisions: EnsembleDecision[];
  llmCalls: EnsembleLlmCall[];
  events: EnsembleEvent[];
}

/**
 * An ensemble member, denormalized onto the nested `TaskSummary` a session card carries.
 *
 * On the TASK summary rather than on `Session`, deliberately: `Session.task` is already
 * compared structurally by `byJson`, so this needs no new `SESSION_FIELD_COMPARATORS`
 * entry and adds no top-level denormalized session state. Bounded to what the later session
 * UI needs - anything richer is a fetch against the run detail.
 */
export interface TaskEnsembleLink {
  runId: string;
  strategyId: EnsembleStrategyId | null;
  strategyLabel: string;
  memberId: string;
  ordinal: number;
  wave: number;
  /** The member's compiled role key, intended as its compact display label. */
  role: string;
  launchedMembers: number;
  maxMembers: number;
  status: EnsembleMemberStatus | null;
  resultLabel: string | null;
}

// ---- operator authorities ----

/**
 * The generic engine authorities an operator has over a run.
 *
 * A discriminated union rather than one route family per verb, and generic rather than
 * strategy-shaped: a strategy composed only from existing primitives adds no member here.
 * A genuinely new operator authority does - and that is the signal that it introduced a new
 * primitive. The one `/api/ensembles/:id/actions` route consumes this shape, so later strategies
 * and the dashboard cannot invent two spellings of the same act.
 */
export type EnsembleAction =
  | { kind: "retry_stage"; stageId: string }
  | { kind: "retry_member"; memberId: string }
  | { kind: "withdraw_member"; memberId: string }
  | {
      kind: "decide";
      /** Client-stable idempotency key; a lost response returns the same recorded decision. */
      requestId: string;
      /** The run state the caller believes it is acting on; a mismatch is a `409`, never an act. */
      expectedStatus: EnsembleStatus;
      /** The outcome, in the compiled finalization policy's own vocabulary. */
      selection: EnsembleJson;
      rationale: string;
      /** The literal `true`: destructive finalization is never reachable without saying so. */
      confirmDestructive: true;
    }
  | { kind: "resolve_finalization"; skipWorkflowHandoff: boolean }
  | { kind: "cancel"; reason: string | null }
  | { kind: "restore_artifact"; artifactId: string };

/**
 * What a `select_one` decision chooses, once validated against the eligible artifact set.
 *
 * `selected` is the winner (an eligible ready artifact id); `no_consensus` is the declared
 * escape when there is no defensible pick, retaining every artifact. Cancelling is a separate
 * authority (`cancel`), not a decision - a decision that destroys is never an accident.
 */
export type EnsembleSelectOneSelection =
  | { kind: "selected"; artifactId: string }
  | { kind: "no_consensus"; reason: string };

/**
 * One answer to one evaluator-derived divergence question.
 *
 * `optionId` names an option of THAT question - the position some subset of the fleet actually
 * took - or is null, in which case `note` carries the operator's own answer. Null with an empty
 * note is refused rather than read as "no opinion": the run's whole product is the answers, and
 * a blank one recorded as an answer is indistinguishable from a settled question.
 */
export type EnsembleDivergenceAnswer = {
  questionId: string;
  optionId: string | null;
  /** Free text. Required when `optionId` is null; an optional aside otherwise. */
  note: string;
};

/**
 * What an `answer_divergences` decision records: one answer per question the evaluator asked.
 *
 * Validated against the question set persisted on the decision stage attempt's INPUT, never
 * against a re-read evaluation - a review retried since would ask different questions, and
 * answers checked against those would be answers to something the operator never saw.
 */
export type EnsembleDivergenceSelection = {
  kind: "answers";
  answers: EnsembleDivergenceAnswer[];
};

// ---- helpers ----

/**
 * Read a persisted enum value back, or null if this build has never heard of it.
 *
 * One helper for every persisted ensemble enum rather than one guard each, because the
 * failure it prevents - a value silently read as something adjacent - is identical in each,
 * and a hand-written guard is where that gets forgotten. Mirrors `readPersistedEnum` in
 * `@shared/schedules.ts`; kept separate only so neither file has to import the other.
 */
export function readEnsembleEnum<T extends string>(
  values: readonly T[],
  raw: string | null | undefined,
): T | null {
  return raw != null && (values as readonly string[]).includes(raw) ? (raw as T) : null;
}

/** `id@version`, the one spelling of a strategy or driver key. */
export function ensembleStrategyKey(id: string, version: number): string {
  return `${id}@${version}`;
}

/**
 * Split a persisted `id@version` key back into its parts, or null when it is not one.
 *
 * Returns the id as a plain STRING, never an `EnsembleStrategyId`: the whole point of the
 * opaque key is that it may name a strategy this build does not have. Resolving that string
 * against the catalog is a separate, explicit step.
 */
export function parseEnsembleStrategyKey(key: string): { id: string; version: number } | null {
  const at = key.lastIndexOf("@");
  if (at <= 0 || at === key.length - 1) return null;
  const version = Number(key.slice(at + 1));
  if (!Number.isInteger(version) || version <= 0) return null;
  return { id: key.slice(0, at), version };
}

/** Narrow a persisted driver key to one this build can actually execute, or null. */
export function knownDriverKey(key: string): EnsembleDriverKey | null {
  return (ENSEMBLE_DRIVER_KEYS as readonly string[]).includes(key)
    ? (key as EnsembleDriverKey)
    : null;
}

/**
 * Every driver key a plan names that this build does not have.
 *
 * Empty is the healthy answer. A non-empty list is a startup HEALTH error for any
 * non-terminal run holding it - never permission to substitute the latest version of that
 * driver, which would execute a stage the operator's plan did not describe.
 */
export function missingDriverKeys(plan: CompiledEnsemblePlan): string[] {
  const missing = new Set<string>();
  for (const stage of plan.stages) {
    if (knownDriverKey(stage.driverKey) === null) missing.add(stage.driverKey);
  }
  return [...missing];
}

/**
 * Whether a summary should pull the operator's eye.
 *
 * Derived on the server from durable state and rendered by the browser, so the two cannot
 * invent competing thresholds - the same split `deriveScheduleHealth` makes.
 */
export function ensembleNeedsAttention(input: {
  status: EnsembleStatus | null;
  unreadable: EnsembleUnreadable | null;
}): boolean {
  if (input.unreadable !== null) return true;
  if (input.status === null) return true;
  return input.status === "failed" || input.status === "awaiting_decision" || input.status === "cancelling";
}

// ---- agent cost ----

/**
 * The member agent cost frozen into an artifact's metadata at submission, or null when unknown.
 *
 * Null is a first-class answer, not a missing zero: a runner that reports no cost, and a member
 * whose session had already exited when it submitted, both land here as `null`, and a reader that
 * coalesced either to zero would print a $0.00 that reads as "this candidate was free". The figure
 * is captured once, at the submission observation boundary, so it survives the member's session
 * exiting - the aggregate below sums exactly these.
 */
export function readArtifactAgentCost(metadata: EnsembleJson): number | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const raw = metadata.agentCostUsd;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

/** An aggregate that keeps "some members reported no cost" distinct from "the total is zero". */
export interface EnsembleAgentCost {
  /** Sum over the members whose cost is known, or null when NONE reported one. */
  totalUsd: number | null;
  /** How many contributing members reported an authoritative cost, and how many did not. */
  known: number;
  unknown: number;
}

/**
 * Sum per-member agent costs while preserving what is unknown.
 *
 * `totalUsd` stays null until at least one member reports a cost, so a run whose runners report
 * nothing shows "unknown" rather than "$0.00"; once any member reports, the total is the sum of the
 * KNOWN members and `unknown` says how many were left out, which is what lets a surface print
 * "$1.20 (2 of 3 reported)" instead of a total that silently under-counts.
 */
export function sumAgentCost(costs: readonly (number | null)[]): EnsembleAgentCost {
  let total: number | null = null;
  let known = 0;
  let unknown = 0;
  for (const c of costs) {
    if (c === null) {
      unknown++;
      continue;
    }
    known++;
    total = (total ?? 0) + c;
  }
  return { totalUsd: total, known, unknown };
}

/**
 * The aggregate member agent cost for one run, counted once per SUBMITTED member.
 *
 * Attribution runs through the immutable artifacts, not the live sessions: each member's cost was
 * frozen into its ready commit artifact at submission, so a member whose session has since exited
 * still contributes. Only members that produced a ready commit are counted - one that never
 * submitted has no cost to attribute rather than a zero - and a resubmission's later attempt
 * replaces the earlier one so a retry is never double-counted. The evaluator's own model cost is
 * NOT folded in here: it is a separate figure on a separate ledger.
 */
export function aggregateEnsembleAgentCost(
  attempts: readonly Pick<EnsembleAttempt, "id" | "memberId">[],
  artifacts: readonly Pick<EnsembleArtifact, "attemptId" | "kind" | "status" | "attempt" | "metadata">[],
): EnsembleAgentCost {
  const memberOf = new Map(attempts.map((a) => [a.id, a.memberId]));
  const best = new Map<string, { attempt: number; cost: number | null }>();
  for (const artifact of artifacts) {
    if (artifact.status !== "ready" || artifact.kind !== "commit" || artifact.attemptId === null) continue;
    const memberId = memberOf.get(artifact.attemptId);
    if (memberId === undefined) continue;
    const prior = best.get(memberId);
    if (prior && prior.attempt >= artifact.attempt) continue;
    best.set(memberId, { attempt: artifact.attempt, cost: readArtifactAgentCost(artifact.metadata) });
  }
  return sumAgentCost([...best.values()].map((b) => b.cost));
}
