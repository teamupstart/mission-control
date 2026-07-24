import type { AgentType, ThinkingLevel } from "./types.ts";
import type { LlmRunnerId } from "./llm.ts";

/**
 * Multi-agent ensembles: the durable vocabulary, shared by the daemon and the browser.
 *
 * An **ensemble** is a group of ordinary Tasks run under one versioned strategy, plus the
 * group-level facts a Task cannot express - a compiled plan, member roles, immutable
 * artifacts, comparative evaluations, a human decision, and a terminal outcome. Best-of-N
 * is the first STRATEGY, not the name of the engine: nothing in this file says candidate,
 * judge, diff or winner, because a tournament, a critique round and a synthesis all have to
 * persist through these same nouns.
 *
 * No `node:` imports reach this file and none may: the dashboard renders every type here,
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
export const ENSEMBLE_STRATEGY_IDS = ["best_of_n"] as const;
export type EnsembleStrategyId = (typeof ENSEMBLE_STRATEGY_IDS)[number];

/**
 * Who asked for an ensemble. Only `manual` exists: an operator pressing Create.
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
 * comparative reviewer changed shape must go on executing the reviewer it was compiled
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
] as const;
export type EnsembleDriverKey = (typeof ENSEMBLE_DRIVER_KEYS)[number];

/**
 * What a member can submit, and what an evaluation can consume.
 *
 * Append-only: an artifact row's `kind` is how a later build knows which adapter validates
 * its locator. `commit` is the one Best-of-N v1 will produce (an immutable private Git
 * commit created through a temporary index); the rest are named now so that appending an
 * adapter later never has to widen the member or stage tables.
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

export const ENSEMBLE_LLM_PURPOSES = ["comparative_review"] as const;
export type EnsembleLlmPurpose = (typeof ENSEMBLE_LLM_PURPOSES)[number];

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

// ---- bounds ----

/**
 * Every durable text/JSON cap in one place, so a store, a compiler and a later route cannot
 * disagree about what "bounded" means. Byte caps are UTF-8 bytes, not code units.
 */
export const ENSEMBLE_LIMITS = {
  title: 200,
  intent: 20_000,
  /** One member's declarative prompt appendix. Fencing and evidence land in later phases. */
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
  /** Page size reserved for the later HTTP detail surface. */
  detailPageSize: 200,
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

/** Where a member's checkout starts. */
export type EnsembleMemberInput =
  /** The run's single pinned base commit. Every Best-of-N member verifies the same one. */
  { kind: "run_base" };

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

/** Where the comparative reviewer's guidance comes from, snapshotted at creation. */
export type EnsembleEvaluatorGuidance =
  | { kind: "builtin"; rubricId: string }
  | { kind: "persona"; personaId: string; revision: number };

/**
 * How a review stage judges. A union so a deterministic gate, a pairwise scheduler or a
 * Persona panel can be appended without touching the evaluation table.
 */
export type EnsembleEvaluatorPolicy = {
  kind: "comparative_llm";
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
};

/** What a human is being asked to decide. */
export type EnsembleDecisionPolicy = {
  kind: "select_one";
  eligibleArtifactKind: EnsembleArtifactKind;
  minEligibleSubjects: number;
};

/**
 * What the terminal outcome does.
 *
 * `requiresHumanDecision` is the literal `true` rather than a boolean, the same device
 * `WorkflowCaptureExpectation.requireCleanWorktree` uses: finalization here resets a
 * branch and reaps worktrees, so the type itself must refuse a policy that opts out.
 */
export type EnsembleFinalizationPolicy = {
  kind: "select_one";
  requiresHumanDecision: true;
  /** Losers give back their worktrees; their immutable artifacts are always retained. */
  loserPolicy: "reap_worktrees";
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

/** What the dashboard tells an operator they are about to start, before they confirm. */
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
  sourceKind: EnsembleSourceKind;
  /** Display identity of the external record, or null when the source is the operator. */
  sourceId: string | null;
  title: string;
  intent: string;
  repoRoot: string;
  strategyId: EnsembleStrategyId;
  /** Optional pin; absent means "this build's current version for that strategy". */
  strategyVersion?: number;
  /** Validated by the chosen strategy's own schema, never by the generic record. */
  strategyConfig: unknown;
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

export type EnsembleOutcome =
  | { kind: "selected"; memberIds: string[]; artifactIds: string[]; materializedTaskId: string | null }
  | { kind: "synthesized"; memberId: string; artifactId: string; materializedTaskId: string | null }
  | { kind: "retained"; memberIds: string[]; artifactIds: string[] }
  | { kind: "no_consensus"; artifactIds: string[]; reason: string };

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
  unreadable: EnsembleUnreadable | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

/**
 * A run this build can execute.
 *
 * The type every later phase's engine works in. Reaching it costs one call to
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
  result: EnsembleJson | null;
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
  selection: EnsembleJson;
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

/** Everything one run is, for the HTTP detail read a later phase serves. */
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
 * entry and adds no top-level denormalized session state. Bounded to what a card draws -
 * anything richer is a fetch against the run detail.
 */
export interface TaskEnsembleLink {
  runId: string;
  strategyId: EnsembleStrategyId | null;
  strategyLabel: string;
  memberId: string;
  ordinal: number;
  wave: number;
  /** The member's compiled role key, which is what a card labels it by. */
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
 * primitive. No route consumes this yet; the shape is fixed now so later phases and the
 * dashboard cannot invent two spellings of the same act.
 */
export type EnsembleAction =
  | { kind: "retry_stage"; stageId: string }
  | { kind: "withdraw_member"; memberId: string }
  | { kind: "decide"; selection: EnsembleJson; rationale: string }
  | { kind: "resolve_finalization" }
  | { kind: "cancel"; reason: string | null }
  | { kind: "restore_artifact"; artifactId: string };

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
  return input.status === "failed" || input.status === "awaiting_decision";
}
