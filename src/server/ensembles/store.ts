import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  ENSEMBLE_ARTIFACT_KINDS,
  ENSEMBLE_ARTIFACT_STATUSES,
  ENSEMBLE_ATTEMPT_STATUSES,
  ENSEMBLE_DECISION_ACTORS,
  ENSEMBLE_DECISION_STATUSES,
  ENSEMBLE_EVALUATION_STATUSES,
  ENSEMBLE_HARD_LIMITS,
  ENSEMBLE_LIMITS,
  ENSEMBLE_LLM_CALL_STATES,
  ENSEMBLE_LLM_PURPOSES,
  ENSEMBLE_MEMBER_STATUSES,
  ENSEMBLE_SOURCE_KINDS,
  ENSEMBLE_STAGE_DRIVER_KINDS,
  ENSEMBLE_STAGE_STATUSES,
  ENSEMBLE_STATUSES,
  ENSEMBLE_TERMINAL_STATUSES,
  ensembleNeedsAttention,
  knownDriverKey,
  missingDriverKeys,
  parseEnsembleStrategyKey,
  readEnsembleEnum,
  type CompiledEnsemblePlan,
  type EnsembleArtifact,
  type EnsembleAttempt,
  type EnsembleAttemptStatus,
  type EnsembleDecision,
  type EnsembleDecisionActor,
  type EnsembleEvaluation,
  type EnsembleEvaluationStatus,
  type EnsembleEvent,
  type EnsembleJson,
  type EnsembleLlmCall,
  type EnsembleLlmCallState,
  type EnsembleLlmPurpose,
  type EnsembleMember,
  type EnsembleMemberStatus,
  type EnsembleOutcome,
  type EnsemblePayloadEnvelope,
  type EnsembleRun,
  type EnsembleRunDetail,
  type EnsembleSourceKind,
  type EnsembleStageAttempt,
  type EnsembleStageStatus,
  type EnsembleStatus,
  type EnsembleSummary,
  type EnsembleUnreadable,
  type TaskEnsembleLink,
} from "@shared/ensemble.ts";
import { ENSEMBLE_STRATEGY_INFO, knownStrategyId } from "@shared/ensemble-strategies.ts";
import {
  CompiledEnsemblePlanSchema,
  EnsembleJsonSchema,
  EnsembleOutcomeSchema,
  EnsemblePayloadEnvelopeSchema,
} from "@shared/protocol.ts";
import { AGENT_TYPES, THINKING_LEVELS, type AgentType, type ThinkingLevel } from "@shared/types.ts";
import { openDb } from "../db.ts";

/**
 * Durable storage for multi-agent ensembles.
 *
 * Mechanism only. Nothing here decides a policy, compiles a plan, launches anything or emits
 * a Registry event: an SSE emission cannot be rolled back, so a transaction that can still
 * fail must never be the thing that announced itself. The manager above decides and notifies
 * after these calls return - the same split `src/server/schedules/store.ts` makes.
 *
 * Two rules this module exists to enforce:
 *
 *  - **Every durable TEXT enum and JSON column is validated before a typed record exists.**
 *    Unknown persisted enums degrade to null. Malformed child row shapes and JSON fail at
 *    ONE boundary, with the table and row named, rather than surfacing as an `undefined`
 *    three call sites later.
 *  - **A row this build cannot execute still LOADS.** An unknown strategy, an unreadable
 *    plan, a driver version we no longer ship - each becomes `unreadable` on the record, and
 *    `ensembleIsRunnable` is the single gate that stops it being run. A run nobody can see
 *    is a run nobody can cancel or clean up after, and reading an unknown strategy as the
 *    only one we have would execute a plan the operator never asked for.
 */

export const ENSEMBLE_TABLES = [
  "ensemble_runs",
  "ensemble_members",
  "ensemble_attempts",
  "ensemble_artifacts",
  "ensemble_stage_attempts",
  "ensemble_evaluations",
  "ensemble_llm_calls",
  "ensemble_events",
  "ensemble_decisions",
] as const;
export type EnsembleTable = (typeof ENSEMBLE_TABLES)[number];

export class EnsembleRowError extends Error {
  constructor(
    readonly table: EnsembleTable,
    readonly rowId: string,
    detail: string,
  ) {
    super(`${table} row ${rowId}: ${detail}`);
    this.name = "EnsembleRowError";
  }
}

// ---- row validation ----

function rowIdOf(value: unknown): string {
  if (value && typeof value === "object" && "id" in value) return String(value.id);
  return "(unknown)";
}

function parseShape<T>(table: EnsembleTable, schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new EnsembleRowError(table, rowIdOf(value), parsed.error.message);
}

/**
 * Parse a JSON column, or throw naming the column.
 *
 * Throws rather than degrading because these columns are the run's own state - a stage's
 * input, an artifact's locator - and a silently-empty one would let a later phase act as if
 * the stage had no subjects. The one column that degrades instead is `compiled_plan_json`,
 * below, because a plan from the future is an expected condition rather than corruption.
 */
function parseJson<T>(table: EnsembleTable, id: string, column: string, raw: string, schema: z.ZodType<T>): T {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    throw new EnsembleRowError(table, id, `${column} is not JSON: ${String(err)}`);
  }
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new EnsembleRowError(table, id, `${column}: ${parsed.error.message}`);
}

function parseNullableJson<T>(
  table: EnsembleTable,
  id: string,
  column: string,
  raw: string | null,
  schema: z.ZodType<T>,
): T | null {
  return raw === null ? null : parseJson(table, id, column, raw, schema);
}

const idText = z.string().min(1);
const nullableText = z.string().nullable();
const integer = z.number().int();

const RunRowSchema = z.object({
  id: idText,
  source_kind: z.string(),
  source_key: z.string(),
  source_id: nullableText,
  strategy_id: z.string(),
  strategy_version: integer,
  strategy_key: z.string(),
  strategy_label: z.string(),
  title: z.string(),
  intent: z.string(),
  repo_root: z.string(),
  base_branch: nullableText,
  base_sha: nullableText,
  compiled_plan_json: z.string(),
  strategy_config_json: z.string(),
  status: z.string(),
  active_stage_id: nullableText,
  outcome_json: nullableText,
  created_at: integer,
  updated_at: integer,
  completed_at: integer.nullable(),
  error: nullableText,
});
type RunRow = z.infer<typeof RunRowSchema>;
type RunRowIssue = [field: string, detail: string];

function persistedValue(value: unknown): string {
  if (value === undefined) return "(missing)";
  if (typeof value === "string") return value.slice(0, 120);
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "(unreadable value)";
}

function readRunRow(value: unknown): { row: RunRow; issues: RunRowIssue[] } {
  const parsed = RunRowSchema.safeParse(value);
  if (parsed.success) return { row: parsed.data, issues: [] };

  const raw =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const issues: RunRowIssue[] = [];
  const read = <T>(column: string, schema: z.ZodType<T>, fallback: T): T => {
    const field = schema.safeParse(raw[column]);
    if (field.success) return field.data;
    issues.push([column, persistedValue(raw[column])]);
    return fallback;
  };

  return {
    row: {
      id: read("id", idText, rowIdOf(value) || "(unknown)"),
      source_kind: read("source_kind", z.string(), ""),
      source_key: read("source_key", z.string(), ""),
      source_id: read("source_id", nullableText, null),
      strategy_id: read("strategy_id", z.string(), ""),
      strategy_version: read("strategy_version", integer, 0),
      strategy_key: read("strategy_key", z.string(), ""),
      strategy_label: read("strategy_label", z.string(), ""),
      title: read("title", z.string(), ""),
      intent: read("intent", z.string(), ""),
      repo_root: read("repo_root", z.string(), ""),
      base_branch: read("base_branch", nullableText, null),
      base_sha: read("base_sha", nullableText, null),
      compiled_plan_json: read("compiled_plan_json", z.string(), ""),
      strategy_config_json: read("strategy_config_json", z.string(), ""),
      status: read("status", z.string(), ""),
      active_stage_id: read("active_stage_id", nullableText, null),
      outcome_json: read("outcome_json", nullableText, null),
      created_at: read("created_at", integer, 0),
      updated_at: read("updated_at", integer, 0),
      completed_at: read("completed_at", integer.nullable(), null),
      error: read("error", nullableText, null),
    },
    issues,
  };
}

const MemberRowSchema = z.object({
  id: idText,
  run_id: idText,
  role_key: z.string(),
  role_label: z.string(),
  ordinal: integer,
  wave: integer,
  task_id: z.string(),
  status: z.string(),
  selected_attempt_id: nullableText,
  result_label: nullableText,
  created_at: integer,
  updated_at: integer,
  error: nullableText,
});

const AttemptRowSchema = z.object({
  id: idText,
  run_id: idText,
  member_id: idText,
  attempt: integer,
  task_id: nullableText,
  session_id: nullableText,
  agent: nullableText,
  requested_model: nullableText,
  requested_effort: nullableText,
  observed_model: nullableText,
  base_sha: nullableText,
  worktree_path: nullableText,
  branch: nullableText,
  status: z.string(),
  created_at: integer,
  updated_at: integer,
  started_at: integer.nullable(),
  finished_at: integer.nullable(),
  error: nullableText,
});

const ArtifactRowSchema = z.object({
  id: idText,
  run_id: idText,
  attempt_id: z.string(),
  kind: z.string(),
  format_version: integer,
  attempt: integer,
  status: z.string(),
  locator_json: z.string(),
  digest: z.string(),
  metadata_json: z.string(),
  operation_key: z.string(),
  created_at: integer,
  ready_at: integer.nullable(),
  error: nullableText,
});

const StageAttemptRowSchema = z.object({
  id: idText,
  run_id: idText,
  stage_id: z.string(),
  driver_kind: z.string(),
  driver_key: z.string(),
  attempt: integer,
  command_key: z.string(),
  status: z.string(),
  input_json: z.string(),
  output_json: nullableText,
  created_at: integer,
  updated_at: integer,
  started_at: integer.nullable(),
  finished_at: integer.nullable(),
  error: nullableText,
});

const EvaluationRowSchema = z.object({
  id: idText,
  run_id: idText,
  stage_attempt_id: idText,
  attempt: integer,
  method: z.string(),
  runner_id: nullableText,
  model_id: nullableText,
  input_fingerprint: z.string(),
  subjects_json: z.string(),
  result_json: nullableText,
  status: z.string(),
  created_at: integer,
  updated_at: integer,
  finished_at: integer.nullable(),
  error: nullableText,
});

const LlmCallRowSchema = z.object({
  id: idText,
  run_id: idText,
  stage_attempt_id: nullableText,
  evaluation_id: nullableText,
  purpose: z.string(),
  runner_id: z.string(),
  model_id: z.string(),
  attempt: integer,
  operation_key: z.string(),
  state: z.string(),
  started_at: integer,
  finished_at: integer.nullable(),
  duration_ms: integer.nullable(),
  input_bytes: integer,
  output_bytes: integer,
  cost_usd: z.number().nullable(),
  error_code: nullableText,
});

const EventRowSchema = z.object({
  id: integer,
  run_id: idText,
  ts: integer,
  event_kind: z.string(),
  payload_json: z.string(),
});

const DecisionRowSchema = z.object({
  id: idText,
  run_id: idText,
  version: integer,
  actor: z.string(),
  actor_id: nullableText,
  status: z.string(),
  selection_json: z.string(),
  rationale: z.string(),
  finalization_stage_attempt_id: nullableText,
  created_at: integer,
  updated_at: integer,
});

/**
 * The artifact ids one evaluation judged. Bounded by what any plan could ever produce -
 * every member, retried to the stage-attempt ceiling - so a corrupt column cannot make a
 * detail read allocate without limit.
 */
const subjectsSchema = z
  .array(z.string())
  .max(ENSEMBLE_HARD_LIMITS.maxMembers * ENSEMBLE_HARD_LIMITS.maxStageAttempts);

// ---- row -> record ----

/** Parse one JSON column without throwing: the value, or null and a sentence saying why. */
function readJsonColumn<T>(
  raw: string,
  schema: z.ZodType<T>,
  what: string,
): { value: T | null; detail: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { value: null, detail: `${what} could not be read` };
  }
  const checked = schema.safeParse(parsed);
  return checked.success
    ? { value: checked.data, detail: null }
    : { value: null, detail: `${what} is in a shape this build does not understand` };
}

/**
 * Read every field of a run that this build might not be able to make sense of.
 *
 * **Nothing in here throws, and that is the point.** `EnsembleManager` builds the registry's
 * summaries during daemon construction, so a single unreadable run row that threw would stop
 * the daemon from starting - leaving no running control plane or later cleanup surface for
 * the row that is stopping it. One bad row costs THAT run its runnability and nothing else,
 * the same stance `parseTemplate` takes in the schedule store.
 *
 * Malformed child row shapes and JSON deliberately keep throwing (see `parseJson`). Unknown
 * child enum values degrade to null for version-skew tolerance. A corrupt artifact locator or
 * stage input fails one HTTP detail read, names its table and row, and leaves the rest of the
 * daemon standing; it is not on the boot path.
 *
 * The `unreadable` this returns is what fails a run CLOSED: `ensembleIsRunnable` refuses it, so
 * nothing downstream can reach a plan without having handled the null. The mapper has no branch
 * that could pick a default, because the type has nowhere to put one.
 *
 * The plan is the interesting case. A plan whose SHAPE this build cannot parse degrades to
 * null; a plan that parses but names a driver version we no longer ship stays READABLE - so
 * the detail view can show what the run was going to do - and is still refused. Those are
 * different facts and collapsing them would cost an operator the only description of a run
 * they are being asked to cancel.
 */
function readRunSnapshot(row: RunRow, rowIssues: RunRowIssue[]): {
  sourceKind: EnsembleSourceKind | null;
  strategyId: ReturnType<typeof knownStrategyId>;
  status: EnsembleStatus | null;
  plan: CompiledEnsemblePlan | null;
  strategyConfig: EnsembleJson;
  outcome: EnsembleOutcome | null;
  unreadable: EnsembleUnreadable | null;
} {
  const sourceKind = readEnsembleEnum(ENSEMBLE_SOURCE_KINDS, row.source_kind);
  const strategyId = knownStrategyId(row.strategy_id);
  const status = readEnsembleEnum(ENSEMBLE_STATUSES, row.status);
  const plan = readJsonColumn(row.compiled_plan_json, CompiledEnsemblePlanSchema, "its compiled plan");
  const config = readJsonColumn(row.strategy_config_json, EnsembleJsonSchema, "its strategy configuration");
  const outcome =
    row.outcome_json === null
      ? { value: null, detail: null }
      : readJsonColumn(row.outcome_json, EnsembleOutcomeSchema, "its outcome");

  const bad: RunRowIssue[] = [...rowIssues];
  const addBad = (field: string, detail: string): void => {
    if (!bad.some(([existing]) => existing === field)) bad.push([field, detail]);
  };
  if (sourceKind === null) addBad("source_kind", row.source_kind);
  if (strategyId === null) addBad("strategy_id", row.strategy_id);
  if (status === null) addBad("status", row.status);
  if (config.detail !== null) addBad("strategy_config_json", config.detail);
  if (outcome.detail !== null) addBad("outcome_json", outcome.detail);

  const storedStrategy = parseEnsembleStrategyKey(row.strategy_key);
  const storedStrategyId = storedStrategy ? knownStrategyId(storedStrategy.id) : null;
  if (storedStrategy === null) {
    addBad("strategy_key", row.strategy_key);
  } else if (storedStrategyId === null) {
    addBad("strategy_key", `it names unknown strategy ${storedStrategy.id}`);
  } else {
    if (storedStrategy.version > ENSEMBLE_STRATEGY_INFO[storedStrategyId].currentVersion) {
      addBad("strategy_key", `it needs ${row.strategy_key}`);
    }
    if (strategyId !== null && storedStrategyId !== strategyId) {
      addBad("strategy_key", `it disagrees with strategy_id ${row.strategy_id}`);
    }
    if (row.strategy_version !== storedStrategy.version) {
      addBad("strategy_version", `${row.strategy_version} disagrees with ${row.strategy_key}`);
    }
  }

  if (plan.value === null) addBad("compiled_plan_json", plan.detail ?? "unreadable");
  else {
    const planStrategy = parseEnsembleStrategyKey(plan.value.strategyKey);
    const planStrategyId = planStrategy ? knownStrategyId(planStrategy.id) : null;
    const planStrategyUnreadable =
      planStrategy === null ||
      planStrategyId === null ||
      (planStrategyId !== null &&
        planStrategy.version > ENSEMBLE_STRATEGY_INFO[planStrategyId].currentVersion);
    if (planStrategyUnreadable || plan.value.strategyKey !== row.strategy_key) {
      addBad("compiled_plan_json", `its strategy key is ${plan.value.strategyKey}`);
    }
    const missing = missingDriverKeys(plan.value);
    if (missing.length > 0) addBad("compiled_plan_json", `it needs ${missing.join(", ")}`);
  }

  const unreadable: EnsembleUnreadable | null =
    bad.length === 0
      ? null
      : {
          reason:
            "Mission Control cannot read this ensemble as it is stored - most likely a newer " +
            "build wrote it: " +
            bad.map(([field, value]) => `${field} is "${value}"`).join(", ") +
            ". It will not run here.",
          fields: bad.map(([field]) => field),
        };

  return {
    sourceKind,
    strategyId,
    status,
    plan: plan.value as CompiledEnsemblePlan | null,
    // An unreadable config is history nobody can render, not a reason to hide the run; the
    // `unreadable` above is what stops it being used for anything.
    strategyConfig: config.value ?? null,
    outcome: outcome.value as EnsembleOutcome | null,
    unreadable,
  };
}

function rowToRun(value: unknown): EnsembleRun {
  const { row, issues } = readRunRow(value);
  const snapshot = readRunSnapshot(row, issues);
  return {
    id: row.id,
    sourceKind: snapshot.sourceKind,
    sourceKey: row.source_key,
    sourceId: row.source_id,
    strategyId: snapshot.strategyId,
    strategyKey: row.strategy_key,
    strategyVersion: row.strategy_version,
    strategyLabel: row.strategy_label,
    title: row.title,
    intent: row.intent,
    repoRoot: row.repo_root,
    baseBranch: row.base_branch,
    baseSha: row.base_sha,
    plan: snapshot.plan,
    strategyConfig: snapshot.strategyConfig,
    status: snapshot.status,
    activeStageId: row.active_stage_id,
    outcome: snapshot.outcome,
    unreadable: snapshot.unreadable,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function rowToMember(value: unknown): EnsembleMember {
  const row = parseShape("ensemble_members", MemberRowSchema, value);
  return {
    id: row.id,
    runId: row.run_id,
    roleKey: row.role_key,
    roleLabel: row.role_label,
    ordinal: row.ordinal,
    wave: row.wave,
    // The empty string is the "no task yet" normalization the partial unique index needs;
    // it must never reach a caller as a task id, which would join against nothing.
    taskId: row.task_id === "" ? null : row.task_id,
    status: readEnsembleEnum(ENSEMBLE_MEMBER_STATUSES, row.status),
    selectedAttemptId: row.selected_attempt_id,
    resultLabel: row.result_label,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToAttempt(value: unknown): EnsembleAttempt {
  const row = parseShape("ensemble_attempts", AttemptRowSchema, value);
  return {
    id: row.id,
    runId: row.run_id,
    memberId: row.member_id,
    attempt: row.attempt,
    taskId: row.task_id,
    sessionId: row.session_id,
    agent: readEnsembleEnum<AgentType>(AGENT_TYPES, row.agent),
    requestedModel: row.requested_model,
    requestedEffort: readEnsembleEnum<ThinkingLevel>(THINKING_LEVELS, row.requested_effort),
    observedModel: row.observed_model,
    baseSha: row.base_sha,
    worktreePath: row.worktree_path,
    branch: row.branch,
    status: readEnsembleEnum(ENSEMBLE_ATTEMPT_STATUSES, row.status),
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function rowToArtifact(value: unknown): EnsembleArtifact {
  const row = parseShape("ensemble_artifacts", ArtifactRowSchema, value);
  return {
    id: row.id,
    runId: row.run_id,
    attemptId: row.attempt_id === "" ? null : row.attempt_id,
    kind: readEnsembleEnum(ENSEMBLE_ARTIFACT_KINDS, row.kind),
    formatVersion: row.format_version,
    attempt: row.attempt,
    status: readEnsembleEnum(ENSEMBLE_ARTIFACT_STATUSES, row.status),
    locator: parseJson("ensemble_artifacts", row.id, "locator_json", row.locator_json, EnsembleJsonSchema),
    digest: row.digest,
    metadata: parseJson("ensemble_artifacts", row.id, "metadata_json", row.metadata_json, EnsembleJsonSchema),
    error: row.error,
    createdAt: row.created_at,
    readyAt: row.ready_at,
  };
}

function rowToStageAttempt(value: unknown): EnsembleStageAttempt {
  const row = parseShape("ensemble_stage_attempts", StageAttemptRowSchema, value);
  return {
    id: row.id,
    runId: row.run_id,
    stageId: row.stage_id,
    driverKind: readEnsembleEnum(ENSEMBLE_STAGE_DRIVER_KINDS, row.driver_kind),
    driverKey: knownDriverKey(row.driver_key),
    attempt: row.attempt,
    commandKey: row.command_key,
    status: readEnsembleEnum(ENSEMBLE_STAGE_STATUSES, row.status),
    input: parseJson("ensemble_stage_attempts", row.id, "input_json", row.input_json, EnsembleJsonSchema),
    output: parseNullableJson(
      "ensemble_stage_attempts",
      row.id,
      "output_json",
      row.output_json,
      EnsembleJsonSchema,
    ),
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function rowToEvaluation(value: unknown): EnsembleEvaluation {
  const row = parseShape("ensemble_evaluations", EvaluationRowSchema, value);
  return {
    id: row.id,
    runId: row.run_id,
    stageAttemptId: row.stage_attempt_id,
    attempt: row.attempt,
    method: row.method,
    runnerId: row.runner_id,
    modelId: row.model_id,
    inputFingerprint: row.input_fingerprint,
    subjectArtifactIds: parseJson(
      "ensemble_evaluations",
      row.id,
      "subjects_json",
      row.subjects_json,
      subjectsSchema,
    ),
    result: parseNullableJson(
      "ensemble_evaluations",
      row.id,
      "result_json",
      row.result_json,
      EnsemblePayloadEnvelopeSchema,
    ),
    status: readEnsembleEnum(ENSEMBLE_EVALUATION_STATUSES, row.status),
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

function rowToLlmCall(value: unknown): EnsembleLlmCall {
  const row = parseShape("ensemble_llm_calls", LlmCallRowSchema, value);
  return {
    id: row.id,
    runId: row.run_id,
    stageAttemptId: row.stage_attempt_id,
    evaluationId: row.evaluation_id,
    purpose: readEnsembleEnum(ENSEMBLE_LLM_PURPOSES, row.purpose),
    runnerId: row.runner_id,
    modelId: row.model_id,
    attempt: row.attempt,
    state: readEnsembleEnum(ENSEMBLE_LLM_CALL_STATES, row.state),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    inputBytes: row.input_bytes,
    outputBytes: row.output_bytes,
    costUsd: row.cost_usd,
    errorCode: row.error_code,
  };
}

function rowToEvent(value: unknown): EnsembleEvent {
  const row = parseShape("ensemble_events", EventRowSchema, value);
  return {
    id: row.id,
    runId: row.run_id,
    ts: row.ts,
    kind: row.event_kind,
    payload: parseJson("ensemble_events", String(row.id), "payload_json", row.payload_json, EnsembleJsonSchema),
  };
}

function rowToDecision(value: unknown): EnsembleDecision {
  const row = parseShape("ensemble_decisions", DecisionRowSchema, value);
  return {
    id: row.id,
    runId: row.run_id,
    version: row.version,
    actor: readEnsembleEnum(ENSEMBLE_DECISION_ACTORS, row.actor),
    actorId: row.actor_id,
    status: readEnsembleEnum(ENSEMBLE_DECISION_STATUSES, row.status),
    selection: parseJson(
      "ensemble_decisions",
      row.id,
      "selection_json",
      row.selection_json,
      EnsemblePayloadEnvelopeSchema,
    ),
    rationale: row.rationale,
    finalizationStageAttemptId: row.finalization_stage_attempt_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---- inputs ----

/** One member as the caller compiled it, before it has an id. */
export interface EnsembleMemberInsert {
  roleKey: string;
  roleLabel: string;
  ordinal: number;
  wave: number;
}

export interface EnsembleRunInsert {
  sourceKind: EnsembleSourceKind;
  sourceKey: string;
  sourceId: string | null;
  strategyId: string;
  strategyVersion: number;
  strategyKey: string;
  strategyLabel: string;
  title: string;
  intent: string;
  repoRoot: string;
  baseBranch: string | null;
  /** Null until a launch runtime pins one full commit; see `ensemble_runs.base_sha`. */
  baseSha: string | null;
  plan: CompiledEnsemblePlan;
  strategyConfig: EnsembleJson;
  status: EnsembleStatus;
  members: EnsembleMemberInsert[];
}

/**
 * A create either made a run or found the one an earlier identical call made.
 *
 * `created: false` is a SUCCESS, not a conflict: it is the response-loss retry doing exactly
 * what the source key exists for. A caller that treated it as an error would turn one
 * duplicate request into a visible failure over a run that is already running.
 */
export interface EnsembleCreateWrite {
  run: EnsembleRun;
  members: EnsembleMember[];
  created: boolean;
}

export interface EnsembleAttemptInsert {
  runId: string;
  memberId: string;
  attempt: number;
  taskId: string | null;
  sessionId: string | null;
  agent: AgentType | null;
  requestedModel: string | null;
  requestedEffort: ThinkingLevel | null;
  baseSha: string | null;
  worktreePath: string | null;
  branch: string | null;
  status: EnsembleAttemptStatus;
}

export interface EnsembleArtifactInsert {
  runId: string;
  attemptId: string | null;
  kind: string;
  formatVersion: number;
  attempt: number;
  status: EnsembleArtifact["status"];
  locator: EnsembleJson;
  digest: string;
  metadata: EnsembleJson;
  /** Stable per-capture key. A repeat returns the existing artifact rather than a second row. */
  operationKey: string;
  readyAt: number | null;
}

export interface EnsembleStageAttemptInsert {
  runId: string;
  stageId: string;
  driverKind: string;
  driverKey: string;
  attempt: number;
  /** Persisted BEFORE the side effect it authorizes, so a restart cannot repeat one. */
  commandKey: string;
  status: EnsembleStageStatus;
  input: EnsembleJson;
}

export interface EnsembleEvaluationInsert {
  runId: string;
  stageAttemptId: string;
  attempt: number;
  method: string;
  runnerId: string | null;
  modelId: string | null;
  inputFingerprint: string;
  subjectArtifactIds: string[];
  status: EnsembleEvaluationStatus;
}

export interface EnsembleLlmCallInsert {
  runId: string;
  stageAttemptId: string | null;
  evaluationId: string | null;
  purpose: EnsembleLlmPurpose;
  runnerId: string;
  modelId: string;
  attempt: number;
  operationKey: string;
  state: EnsembleLlmCallState;
  startedAt: number;
}

export interface EnsembleDecisionInsert {
  runId: string;
  actor: EnsembleDecisionActor;
  actorId: string | null;
  selection: EnsemblePayloadEnvelope;
  rationale: string;
  operationKey: string;
}

export interface EnsembleEventInsert {
  runId: string;
  kind: string;
  payload: EnsembleJson;
  operationKey: string;
}

/** A compare-and-set write: the row as it now stands, or why it was refused. */
export type EnsembleTransition<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "not_found" | "precondition_failed"; current: T | null };

function bounded(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function identityKey(value: string, max: number, field: string): string {
  if (value.length === 0) throw new RangeError(`${field} must not be empty`);
  if (value.length > max) throw new RangeError(`${field} exceeds ${max} characters`);
  return value;
}

function identityConflict(field: string, key: string): never {
  throw new Error(`${field} ${key} is already owned by a different ensemble record`);
}

function boundedOrNull(value: string | null, max: number): string | null {
  return value === null ? null : bounded(value, max);
}

function serializedJson(
  value: EnsembleJson | EnsemblePayloadEnvelope | CompiledEnsemblePlan,
  maxBytes: number,
  field: string,
): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError(`${field} is not serializable JSON`);
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw new RangeError(`${field} exceeds ${maxBytes} UTF-8 bytes`);
  }
  return serialized;
}

const TERMINAL_ATTEMPT_STATUSES: readonly EnsembleAttemptStatus[] = [
  "submitted",
  "failed",
  "cancelled",
];
const TERMINAL_STAGE_STATUSES: readonly EnsembleStageStatus[] = ["succeeded", "failed", "cancelled"];
const TERMINAL_EVALUATION_STATUSES: readonly EnsembleEvaluationStatus[] = [
  "succeeded",
  "failed",
  "interrupted",
];
const TERMINAL_LLM_CALL_STATES: readonly EnsembleLlmCallState[] = [
  "succeeded",
  "failed",
  "interrupted",
];
const LAUNCHED_MEMBER_STATUSES: readonly EnsembleMemberStatus[] =
  ENSEMBLE_MEMBER_STATUSES.filter((status) => status !== "pending");

export class EnsembleStore {
  private readonly taskLinkListeners = new Set<() => void>();

  constructor(private readonly db: DatabaseSync = openDb()) {}

  onTaskLinksChanged(listener: () => void): () => void {
    this.taskLinkListeners.add(listener);
    return () => this.taskLinkListeners.delete(listener);
  }

  private notifyTaskLinksChanged(): void {
    for (const listener of this.taskLinkListeners) listener();
  }

  /** Run `fn` in a transaction, joining one already in progress rather than nesting. */
  private inTransaction<T>(fn: () => T): T {
    const owns = !this.db.isTransaction;
    if (owns) this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      if (owns) this.db.exec("COMMIT");
      return out;
    } catch (err) {
      if (owns && this.db.isTransaction) this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // ---- creation ----

  /**
   * Create one run and every member of its compiled roster, atomically.
   *
   * One transaction because a run with a partial roster is worse than no run: a later wave
   * would dispatch against a plan whose members do not all exist, and nothing downstream
   * could tell that from a roster that was meant to be short.
   *
   * Idempotent on `(source_kind, source_key)`. A create that lost its response returns the
   * run it already made, which is what stops one retry from launching another N agents.
   */
  createRun(input: EnsembleRunInsert, now = Date.now()): EnsembleCreateWrite {
    const sourceKey = identityKey(input.sourceKey, ENSEMBLE_LIMITS.sourceKey, "source key");
    return this.inTransaction(() => {
      const existing = this.runBySource(input.sourceKind, sourceKey);
      if (existing) {
        return { run: existing, members: this.listMembers(existing.id), created: false };
      }
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO ensemble_runs (id, source_kind, source_key, source_id, strategy_id,
             strategy_version, strategy_key, strategy_label, title, intent, repo_root,
             base_branch, base_sha, compiled_plan_json, strategy_config_json, status,
             active_stage_id, outcome_json, created_at, updated_at, completed_at, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, NULL)`,
        )
        .run(
          id,
          input.sourceKind,
          sourceKey,
          boundedOrNull(input.sourceId, ENSEMBLE_LIMITS.sourceId),
          input.strategyId,
          input.strategyVersion,
          bounded(input.strategyKey, ENSEMBLE_LIMITS.strategyKey),
          bounded(input.strategyLabel, ENSEMBLE_LIMITS.strategyLabel),
          bounded(input.title, ENSEMBLE_LIMITS.title),
          bounded(input.intent, ENSEMBLE_LIMITS.intent),
          input.repoRoot,
          input.baseBranch,
          input.baseSha,
          serializedJson(input.plan, ENSEMBLE_LIMITS.compiledPlanJsonBytes, "compiled plan"),
          serializedJson(
            input.strategyConfig,
            ENSEMBLE_LIMITS.strategyConfigJsonBytes,
            "strategy config",
          ),
          input.status,
          now,
          now,
        );
      const insertMember = this.db.prepare(
        `INSERT INTO ensemble_members (id, run_id, role_key, role_label, ordinal, wave, task_id,
           status, selected_attempt_id, result_label, created_at, updated_at, error)
         VALUES (?, ?, ?, ?, ?, ?, '', 'pending', NULL, NULL, ?, ?, NULL)`,
      );
      for (const member of input.members) {
        insertMember.run(
          randomUUID(),
          id,
          bounded(member.roleKey, ENSEMBLE_LIMITS.roleKey),
          bounded(member.roleLabel, ENSEMBLE_LIMITS.roleLabel),
          member.ordinal,
          member.wave,
          now,
          now,
        );
      }
      const run = this.getRun(id);
      if (!run) throw new EnsembleRowError("ensemble_runs", id, "vanished inside its own transaction");
      return { run, members: this.listMembers(id), created: true };
    });
  }

  // ---- reads ----

  getRun(id: string): EnsembleRun | null {
    const row = this.db.prepare(`SELECT * FROM ensemble_runs WHERE id = ?`).get(id) as unknown;
    return row ? rowToRun(row) : null;
  }

  runBySource(sourceKind: string, sourceKey: string): EnsembleRun | null {
    const row = this.db
      .prepare(`SELECT * FROM ensemble_runs WHERE source_kind = ? AND source_key = ?`)
      .get(sourceKind, sourceKey) as unknown;
    return row ? rowToRun(row) : null;
  }

  listRuns(): EnsembleRun[] {
    return (
      this.db.prepare(`SELECT * FROM ensemble_runs ORDER BY created_at DESC`).all() as unknown[]
    ).map(rowToRun);
  }

  /**
   * Every run that has not reached a terminal state.
   *
   * The restart query. Phase 3 does not EXECUTE it - there is nothing yet to resume - but it
   * is the read every later recovery pass starts from, and the terminal set it filters on is
   * derived from the status tuple rather than written out again here.
   */
  listNonTerminalRuns(): EnsembleRun[] {
    const placeholders = ENSEMBLE_TERMINAL_STATUSES.map(() => "?").join(",");
    return (
      this.db
        .prepare(
          `SELECT * FROM ensemble_runs WHERE status NOT IN (${placeholders}) ORDER BY created_at ASC`,
        )
        .all(...ENSEMBLE_TERMINAL_STATUSES) as unknown[]
    ).map(rowToRun);
  }

  listMembers(runId: string): EnsembleMember[] {
    return (
      this.db
        .prepare(`SELECT * FROM ensemble_members WHERE run_id = ? ORDER BY ordinal ASC`)
        .all(runId) as unknown[]
    ).map(rowToMember);
  }

  getMember(id: string): EnsembleMember | null {
    const row = this.db.prepare(`SELECT * FROM ensemble_members WHERE id = ?`).get(id) as unknown;
    return row ? rowToMember(row) : null;
  }

  /** The member a dispatched task belongs to, for the task projection on a session card. */
  memberForTask(taskId: string): EnsembleMember | null {
    if (taskId === "") return null;
    const row = this.db
      .prepare(`SELECT * FROM ensemble_members WHERE task_id = ?`)
      .get(taskId) as unknown;
    return row ? rowToMember(row) : null;
  }

  listAttempts(runId: string): EnsembleAttempt[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM ensemble_attempts WHERE run_id = ? ORDER BY member_id ASC, attempt ASC`,
        )
        .all(runId) as unknown[]
    ).map(rowToAttempt);
  }

  /** The next attempt number for a member. 1 when it has never been launched. */
  nextAttemptNumber(memberId: string): number {
    const row = this.db
      .prepare(`SELECT MAX(attempt) AS highest FROM ensemble_attempts WHERE member_id = ?`)
      .get(memberId) as unknown as { highest: number | null } | undefined;
    return (row?.highest ?? 0) + 1;
  }

  listArtifacts(runId: string): EnsembleArtifact[] {
    return (
      this.db
        .prepare(`SELECT * FROM ensemble_artifacts WHERE run_id = ? ORDER BY created_at ASC`)
        .all(runId) as unknown[]
    ).map(rowToArtifact);
  }

  /**
   * The next capture attempt number for one (attempt, kind), so `UNIQUE(run_id, attempt_id,
   * kind, attempt)` cannot collide when a failed capture is retried.
   *
   * A failed capture leaves a `failed` row; counting it means a retry writes a NEW row rather
   * than colliding, and the `capturing` -> `ready`/`failed` transition below never has to
   * rewrite an artifact that another reader may already have quoted.
   */
  nextArtifactAttempt(runId: string, attemptId: string, kind: string): number {
    const row = this.db
      .prepare(
        `SELECT MAX(attempt) AS highest FROM ensemble_artifacts
           WHERE run_id = ? AND attempt_id = ? AND kind = ?`,
      )
      .get(runId, attemptId, kind) as unknown as { highest: number | null } | undefined;
    return (row?.highest ?? 0) + 1;
  }

  listStageAttempts(runId: string): EnsembleStageAttempt[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM ensemble_stage_attempts WHERE run_id = ? ORDER BY stage_id ASC, attempt ASC`,
        )
        .all(runId) as unknown[]
    ).map(rowToStageAttempt);
  }

  stageAttemptByCommand(commandKey: string): EnsembleStageAttempt | null {
    const row = this.db
      .prepare(`SELECT * FROM ensemble_stage_attempts WHERE command_key = ?`)
      .get(commandKey) as unknown;
    return row ? rowToStageAttempt(row) : null;
  }

  listEvaluations(runId: string): EnsembleEvaluation[] {
    return (
      this.db
        .prepare(`SELECT * FROM ensemble_evaluations WHERE run_id = ? ORDER BY created_at ASC`)
        .all(runId) as unknown[]
    ).map(rowToEvaluation);
  }

  listLlmCalls(runId: string): EnsembleLlmCall[] {
    return (
      this.db
        .prepare(`SELECT * FROM ensemble_llm_calls WHERE run_id = ? ORDER BY started_at ASC`)
        .all(runId) as unknown[]
    ).map(rowToLlmCall);
  }

  listDecisions(runId: string): EnsembleDecision[] {
    return (
      this.db
        .prepare(`SELECT * FROM ensemble_decisions WHERE run_id = ? ORDER BY version ASC`)
        .all(runId) as unknown[]
    ).map(rowToDecision);
  }

  listEvents(runId: string): EnsembleEvent[] {
    return (
      this.db
        .prepare(`SELECT * FROM ensemble_events WHERE run_id = ? ORDER BY id ASC`)
        .all(runId) as unknown[]
    ).map(rowToEvent);
  }

  /** Everything one run is. HTTP-only by design; SSE carries `summary` instead. */
  detail(id: string): EnsembleRunDetail | null {
    const run = this.getRun(id);
    if (!run) return null;
    return {
      run,
      members: this.listMembers(id),
      attempts: this.listAttempts(id),
      artifacts: this.listArtifacts(id),
      stageAttempts: this.listStageAttempts(id),
      evaluations: this.listEvaluations(id),
      decisions: this.listDecisions(id),
      llmCalls: this.listLlmCalls(id),
      events: this.listEvents(id),
    };
  }

  // ---- compact projection ----

  /**
   * The bounded projection the browser receives over SSE.
   *
   * Counts are computed in SQL rather than by loading the children: this is called on every
   * change to a run, and a summary that had to materialize every artifact to say how many
   * were ready would put the whole detail read on the live path.
   */
  summary(id: string): EnsembleSummary | null {
    const run = this.getRun(id);
    return run ? this.summaryFor(run) : null;
  }

  listSummaries(): EnsembleSummary[] {
    return this.listRuns().map((run) => this.summaryFor(run));
  }

  private summaryFor(run: EnsembleRun): EnsembleSummary {
    const launchedSlots = LAUNCHED_MEMBER_STATUSES.map(() => "?").join(",");
    const counts = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status IN (${launchedSlots}) THEN 1 ELSE 0 END) AS launched
           FROM ensemble_members WHERE run_id = ?`,
      )
      .get(...LAUNCHED_MEMBER_STATUSES, run.id) as unknown as
      | { total: number; launched: number | null }
      | undefined;
    const ready = this.db
      .prepare(`SELECT COUNT(*) AS ready FROM ensemble_artifacts WHERE run_id = ? AND status = 'ready'`)
      .get(run.id) as unknown as { ready: number } | undefined;
    const memberCount = counts?.total ?? 0;
    const outcome = run.outcome;
    const selectedMemberId =
      outcome === null
        ? null
        : outcome.kind === "selected"
          ? (outcome.memberIds[0] ?? null)
          : outcome.kind === "synthesized"
            ? outcome.memberId
            : null;
    return {
      id: run.id,
      title: run.title,
      repoRoot: run.repoRoot,
      strategyId: run.strategyId,
      strategyKey: run.strategyKey,
      strategyLabel: run.strategyLabel,
      strategyVersion: run.strategyVersion,
      status: run.status,
      activeStageId: run.activeStageId,
      memberCount,
      launchedMembers: counts?.launched ?? 0,
      // The plan's own cap when it is readable, and the roster we actually have when it is
      // not - never a hard-coded default, which would tell an operator a run may grow to a
      // size its plan never allowed.
      maxMembers: run.plan?.budget.maxMembers ?? memberCount,
      readyArtifacts: ready?.ready ?? 0,
      selectedMemberId,
      outcomeKind: outcome?.kind ?? null,
      unreadable: run.unreadable,
      attention: ensembleNeedsAttention({ status: run.status, unreadable: run.unreadable }),
      error: run.error,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      completedAt: run.completedAt,
    };
  }

  /** The compact member link a session card carries on its nested task summary. */
  taskLink(taskId: string): TaskEnsembleLink | null {
    const member = this.memberForTask(taskId);
    if (!member) return null;
    const summary = this.summary(member.runId);
    if (!summary) return null;
    return {
      runId: member.runId,
      strategyId: summary.strategyId,
      strategyLabel: summary.strategyLabel,
      memberId: member.id,
      ordinal: member.ordinal,
      wave: member.wave,
      role: member.roleKey,
      launchedMembers: summary.launchedMembers,
      maxMembers: summary.maxMembers,
      status: member.status,
      resultLabel: boundedOrNull(member.resultLabel, ENSEMBLE_LIMITS.resultLabel),
    };
  }

  /** Every task currently bound to a member, so a projection can be built in one read. */
  listTaskLinks(): Array<{ taskId: string; link: TaskEnsembleLink }> {
    const rows = this.db
      .prepare(`SELECT task_id FROM ensemble_members WHERE task_id <> ''`)
      .all() as unknown as Array<{ task_id: string }>;
    const links: Array<{ taskId: string; link: TaskEnsembleLink }> = [];
    for (const row of rows) {
      try {
        const link = this.taskLink(row.task_id);
        if (link) links.push({ taskId: row.task_id, link });
      } catch (err) {
        if (!(err instanceof EnsembleRowError)) throw err;
      }
    }
    return links;
  }

  // ---- transitions ----

  /**
   * Move a run's status, but only from one of `expected`.
   *
   * Compare-and-set rather than a bare UPDATE because the callers are asynchronous and
   * several: a member completion, an operator action and a restart pass can all land on one
   * run, and a stale worker writing `running` over `cancelled` would resurrect a run the
   * operator stopped. The precondition is in the WHERE clause, so the check and the write
   * are one statement and there is no window between them.
   */
  setRunStatus(
    id: string,
    expected: readonly EnsembleStatus[],
    next: EnsembleStatus,
    patch: {
      activeStageId?: string | null;
      outcome?: EnsembleOutcome | null;
      error?: string | null;
      completedAt?: number | null;
    } = {},
    now = Date.now(),
  ): EnsembleTransition<EnsembleRun> {
    return this.inTransaction(() => {
      const current = this.getRun(id);
      if (!current) return { ok: false, reason: "not_found", current: null };
      const placeholders = expected.map(() => "?").join(",");
      const sets = ["status = ?", "updated_at = ?"];
      const values: Array<string | number | null> = [next, now];
      if ("activeStageId" in patch) {
        sets.push("active_stage_id = ?");
        values.push(patch.activeStageId ?? null);
      }
      if ("outcome" in patch) {
        sets.push("outcome_json = ?");
        values.push(patch.outcome === null || patch.outcome === undefined ? null : JSON.stringify(patch.outcome));
      }
      if ("error" in patch) {
        sets.push("error = ?");
        values.push(boundedOrNull(patch.error ?? null, ENSEMBLE_LIMITS.errorText));
      }
      if ("completedAt" in patch) {
        sets.push("completed_at = ?");
        values.push(patch.completedAt ?? null);
      }
      const result = this.db
        .prepare(
          `UPDATE ensemble_runs SET ${sets.join(", ")} WHERE id = ? AND status IN (${placeholders})`,
        )
        .run(...values, id, ...expected);
      if (result.changes === 0) return { ok: false, reason: "precondition_failed", current };
      const updated = this.getRun(id);
      return updated
        ? { ok: true, value: updated }
        : { ok: false, reason: "not_found", current: null };
    });
  }

  /** The same compare-and-set discipline for one member. */
  setMemberStatus(
    id: string,
    expected: readonly EnsembleMemberStatus[],
    next: EnsembleMemberStatus,
    patch: {
      taskId?: string | null;
      selectedAttemptId?: string | null;
      resultLabel?: string | null;
      error?: string | null;
    } = {},
    now = Date.now(),
  ): EnsembleTransition<EnsembleMember> {
    const transition = this.inTransaction((): EnsembleTransition<EnsembleMember> => {
      const current = this.getMember(id);
      if (!current) return { ok: false, reason: "not_found", current: null };
      const placeholders = expected.map(() => "?").join(",");
      const sets = ["status = ?", "updated_at = ?"];
      const values: Array<string | number | null> = [next, now];
      if ("taskId" in patch) {
        // Normalized to the empty string the partial unique index is written against; null
        // would make every unlaunched member distinct from every other and defeat it.
        sets.push("task_id = ?");
        values.push(patch.taskId ?? "");
      }
      if ("selectedAttemptId" in patch) {
        if (
          patch.selectedAttemptId !== null &&
          patch.selectedAttemptId !== undefined &&
          !this.db
            .prepare(
              `SELECT 1 FROM ensemble_attempts WHERE id = ? AND member_id = ? AND run_id = ?`,
            )
            .get(patch.selectedAttemptId, current.id, current.runId)
        ) {
          throw new Error(
            `attempt ${patch.selectedAttemptId} does not belong to ensemble member ${current.id}`,
          );
        }
        sets.push("selected_attempt_id = ?");
        values.push(patch.selectedAttemptId ?? null);
      }
      if ("resultLabel" in patch) {
        sets.push("result_label = ?");
        values.push(boundedOrNull(patch.resultLabel ?? null, ENSEMBLE_LIMITS.resultLabel));
      }
      if ("error" in patch) {
        sets.push("error = ?");
        values.push(boundedOrNull(patch.error ?? null, ENSEMBLE_LIMITS.errorText));
      }
      const result = this.db
        .prepare(
          `UPDATE ensemble_members SET ${sets.join(", ")} WHERE id = ? AND status IN (${placeholders})`,
        )
        .run(...values, id, ...expected);
      if (result.changes === 0) return { ok: false, reason: "precondition_failed", current };
      const updated = this.getMember(id);
      return updated
        ? { ok: true, value: updated }
        : { ok: false, reason: "not_found", current: null };
    });
    if (transition.ok) this.notifyTaskLinksChanged();
    return transition;
  }

  /** Record the pinned base once the launch runtime has resolved and verified it. */
  setBase(
    id: string,
    baseSha: string,
    baseBranch: string | null,
    now = Date.now(),
  ): EnsembleTransition<EnsembleRun> {
    return this.inTransaction(() => {
      const current = this.getRun(id);
      if (!current) return { ok: false, reason: "not_found", current: null };
      if (current.baseSha !== null) {
        return current.baseSha === baseSha
          ? { ok: true, value: current }
          : { ok: false, reason: "precondition_failed", current };
      }
      const changed = this.db
        .prepare(
          `UPDATE ensemble_runs SET base_sha = ?, base_branch = ?, updated_at = ?
             WHERE id = ? AND base_sha IS NULL`,
        )
        .run(baseSha, baseBranch, now, id).changes;
      if (changed === 0) return { ok: false, reason: "precondition_failed", current };
      const updated = this.getRun(id);
      return updated
        ? { ok: true, value: updated }
        : { ok: false, reason: "not_found", current: null };
    });
  }

  // ---- idempotent appends ----

  /**
   * Record one launch of one member.
   *
   * Idempotent on `(member_id, attempt)`: a retried launch of the SAME attempt number returns
   * the row it already wrote. A genuinely new try asks `nextAttemptNumber` first, so the two
   * cases are told apart by the caller's own numbering rather than guessed at here.
   */
  insertAttempt(input: EnsembleAttemptInsert, now = Date.now()): EnsembleAttempt {
    return this.inTransaction(() => {
      const existing = this.db
        .prepare(`SELECT * FROM ensemble_attempts WHERE member_id = ? AND attempt = ?`)
        .get(input.memberId, input.attempt) as unknown;
      if (existing) {
        const attempt = rowToAttempt(existing);
        if (
          attempt.runId !== input.runId ||
          attempt.memberId !== input.memberId ||
          attempt.attempt !== input.attempt
        ) {
          identityConflict("attempt identity", `${input.memberId}:${input.attempt}`);
        }
        return attempt;
      }
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO ensemble_attempts (id, run_id, member_id, attempt, task_id, session_id,
             agent, requested_model, requested_effort, observed_model, base_sha, worktree_path,
             branch, status, created_at, updated_at, started_at, finished_at, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
        )
        .run(
          id,
          input.runId,
          input.memberId,
          input.attempt,
          input.taskId,
          input.sessionId,
          input.agent,
          input.requestedModel,
          input.requestedEffort,
          input.baseSha,
          input.worktreePath,
          input.branch,
          input.status,
          now,
          now,
        );
      const row = this.db.prepare(`SELECT * FROM ensemble_attempts WHERE id = ?`).get(id) as unknown;
      return rowToAttempt(row);
    });
  }

  setAttemptStatus(
    id: string,
    expected: readonly EnsembleAttemptStatus[],
    next: EnsembleAttemptStatus,
    patch: {
      sessionId?: string | null;
      observedModel?: string | null;
      baseSha?: string | null;
      worktreePath?: string | null;
      branch?: string | null;
      startedAt?: number | null;
      finishedAt?: number | null;
      error?: string | null;
    } = {},
    now = Date.now(),
  ): EnsembleTransition<EnsembleAttempt> {
    return this.inTransaction(() => {
      const before = this.db.prepare(`SELECT * FROM ensemble_attempts WHERE id = ?`).get(id) as unknown;
      if (!before) return { ok: false, reason: "not_found", current: null };
      const current = rowToAttempt(before);
      if (expected.length === 0) return { ok: false, reason: "precondition_failed", current };
      const sets = ["status = ?", "updated_at = ?"];
      const values: Array<string | number | null> = [next, now];
      if ("sessionId" in patch) {
        sets.push("session_id = ?");
        values.push(patch.sessionId ?? null);
      }
      if ("observedModel" in patch) {
        sets.push("observed_model = ?");
        values.push(patch.observedModel ?? null);
      }
      if ("baseSha" in patch) {
        sets.push("base_sha = ?");
        values.push(patch.baseSha ?? null);
      }
      if ("worktreePath" in patch) {
        sets.push("worktree_path = ?");
        values.push(patch.worktreePath ?? null);
      }
      if ("branch" in patch) {
        sets.push("branch = ?");
        values.push(patch.branch ?? null);
      }
      if ("startedAt" in patch) {
        sets.push("started_at = ?");
        values.push(patch.startedAt ?? null);
      }
      if ("finishedAt" in patch) {
        sets.push("finished_at = ?");
        values.push(patch.finishedAt ?? null);
      }
      if ("error" in patch) {
        sets.push("error = ?");
        values.push(boundedOrNull(patch.error ?? null, ENSEMBLE_LIMITS.errorText));
      }
      const expectedSlots = expected.map(() => "?").join(",");
      const terminalSlots = TERMINAL_ATTEMPT_STATUSES.map(() => "?").join(",");
      const changed = this.db
        .prepare(
          `UPDATE ensemble_attempts SET ${sets.join(", ")}
             WHERE id = ? AND status IN (${expectedSlots}) AND status NOT IN (${terminalSlots})`,
        )
        .run(...values, id, ...expected, ...TERMINAL_ATTEMPT_STATUSES).changes;
      if (changed === 0) return { ok: false, reason: "precondition_failed", current };
      const row = this.db.prepare(`SELECT * FROM ensemble_attempts WHERE id = ?`).get(id) as unknown;
      return row
        ? { ok: true, value: rowToAttempt(row) }
        : { ok: false, reason: "not_found", current: null };
    });
  }

  /**
   * Record one immutable artifact, or return the one this operation already produced.
   *
   * Keyed on the caller's `operationKey`, not on content: two captures of the same worktree
   * seconds apart are legitimately two artifacts, while a repeated delivery of ONE capture
   * must be one. Only the caller knows which it is holding, so only the caller can name it.
   */
  recordArtifact(input: EnsembleArtifactInsert, now = Date.now()): EnsembleArtifact {
    const operationKey = identityKey(
      input.operationKey,
      ENSEMBLE_LIMITS.operationKey,
      "operation key",
    );
    return this.inTransaction(() => {
      const existing = this.db
        .prepare(`SELECT * FROM ensemble_artifacts WHERE operation_key = ?`)
        .get(operationKey) as unknown;
      if (existing) {
        const artifact = rowToArtifact(existing);
        if (
          artifact.runId !== input.runId ||
          artifact.attemptId !== input.attemptId ||
          artifact.kind !== input.kind ||
          artifact.attempt !== input.attempt
        ) {
          identityConflict("operation key", operationKey);
        }
        return artifact;
      }
      if (input.attemptId !== null) {
        const owner = this.db
          .prepare(`SELECT 1 FROM ensemble_attempts WHERE id = ? AND run_id = ?`)
          .get(input.attemptId, input.runId);
        if (!owner) {
          throw new Error(`attempt ${input.attemptId} does not belong to ensemble ${input.runId}`);
        }
      }
      const locator = serializedJson(
        input.locator,
        ENSEMBLE_LIMITS.artifactLocatorJsonBytes,
        "artifact locator",
      );
      const metadata = serializedJson(
        input.metadata,
        ENSEMBLE_LIMITS.artifactMetadataJsonBytes,
        "artifact metadata",
      );
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO ensemble_artifacts (id, run_id, attempt_id, kind, format_version, attempt,
             status, locator_json, digest, metadata_json, operation_key, created_at, ready_at, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          id,
          input.runId,
          input.attemptId ?? "",
          input.kind,
          input.formatVersion,
          input.attempt,
          input.status ?? "capturing",
          locator,
          input.digest,
          metadata,
          operationKey,
          now,
          input.readyAt,
        );
      const row = this.db.prepare(`SELECT * FROM ensemble_artifacts WHERE id = ?`).get(id) as unknown;
      return rowToArtifact(row);
    });
  }

  /**
   * Move one artifact off `capturing`, the only mutable transition an artifact has.
   *
   * An artifact is born `capturing` before the Git snapshot runs, so a crash mid-capture
   * leaves a row a recovery pass can fail rather than an orphaned ref nothing describes. This
   * is what fills in the real locator, fingerprint and evidence once the snapshot exists, or
   * marks the row `failed` when it does not - and it refuses to touch a row that is already
   * `ready`, because a ready artifact is immutable and something downstream may already have
   * read it. `ready` requires the whole triple: a locator, a digest and a `readyAt`, so the
   * invariant "a ready artifact always has honest evidence" holds by construction here.
   */
  setArtifactStatus(
    id: string,
    next: Extract<EnsembleArtifact["status"], "ready" | "failed">,
    patch: {
      locator?: EnsembleJson;
      digest?: string;
      metadata?: EnsembleJson;
      readyAt?: number | null;
      error?: string | null;
    } = {},
    now = Date.now(),
  ): EnsembleTransition<EnsembleArtifact> {
    if (next === "ready" && (patch.locator === undefined || patch.digest === undefined)) {
      throw new Error("a ready artifact must carry its locator and fingerprint");
    }
    const locator =
      patch.locator === undefined
        ? undefined
        : serializedJson(patch.locator, ENSEMBLE_LIMITS.artifactLocatorJsonBytes, "artifact locator");
    const metadata =
      patch.metadata === undefined
        ? undefined
        : serializedJson(patch.metadata, ENSEMBLE_LIMITS.artifactMetadataJsonBytes, "artifact metadata");
    return this.inTransaction(() => {
      const before = this.db.prepare(`SELECT * FROM ensemble_artifacts WHERE id = ?`).get(id) as unknown;
      if (!before) return { ok: false, reason: "not_found", current: null };
      const current = rowToArtifact(before);
      const sets = ["status = ?"];
      const values: Array<string | number | null> = [next];
      if (locator !== undefined) {
        sets.push("locator_json = ?");
        values.push(locator);
      }
      if (patch.digest !== undefined) {
        sets.push("digest = ?");
        values.push(patch.digest);
      }
      if (metadata !== undefined) {
        sets.push("metadata_json = ?");
        values.push(metadata);
      }
      if ("readyAt" in patch) {
        sets.push("ready_at = ?");
        values.push(patch.readyAt ?? null);
      }
      if ("error" in patch) {
        sets.push("error = ?");
        values.push(boundedOrNull(patch.error ?? null, ENSEMBLE_LIMITS.errorText));
      }
      const changed = this.db
        .prepare(`UPDATE ensemble_artifacts SET ${sets.join(", ")} WHERE id = ? AND status = 'capturing'`)
        .run(...values, id).changes;
      if (changed === 0) return { ok: false, reason: "precondition_failed", current };
      const row = this.db.prepare(`SELECT * FROM ensemble_artifacts WHERE id = ?`).get(id) as unknown;
      return row
        ? { ok: true, value: rowToArtifact(row) }
        : { ok: false, reason: "not_found", current: null };
    });
  }

  /**
   * Start one stage attempt, or return the one this exact command already started.
   *
   * The persist-before-act half of the engine's side-effect discipline: the command key goes
   * in first, and a daemon that dies between here and the effect finds this row on restart
   * rather than issuing the command a second time.
   */
  startStageAttempt(input: EnsembleStageAttemptInsert, now = Date.now()): EnsembleStageAttempt {
    const commandKey = identityKey(
      input.commandKey,
      ENSEMBLE_LIMITS.commandKey,
      "command key",
    );
    return this.inTransaction(() => {
      const existing = this.stageAttemptByCommand(commandKey);
      if (existing) {
        if (
          existing.runId !== input.runId ||
          existing.stageId !== input.stageId ||
          existing.attempt !== input.attempt
        ) {
          identityConflict("command key", commandKey);
        }
        return existing;
      }
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO ensemble_stage_attempts (id, run_id, stage_id, driver_kind, driver_key,
             attempt, command_key, status, input_json, output_json, created_at, updated_at,
             started_at, finished_at, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL)`,
        )
        .run(
          id,
          input.runId,
          bounded(input.stageId, ENSEMBLE_LIMITS.stageId),
          input.driverKind,
          bounded(input.driverKey, ENSEMBLE_LIMITS.strategyKey),
          input.attempt,
          commandKey,
          input.status,
          serializedJson(input.input, ENSEMBLE_LIMITS.stagePayloadJsonBytes, "stage input"),
          now,
          now,
          input.status === "queued" ? null : now,
        );
      const row = this.db.prepare(`SELECT * FROM ensemble_stage_attempts WHERE id = ?`).get(id) as unknown;
      return rowToStageAttempt(row);
    });
  }

  finishStageAttempt(
    id: string,
    expected: readonly EnsembleStageStatus[],
    next: EnsembleStageStatus,
    patch: { output?: EnsembleJson | null; error?: string | null } = {},
    now = Date.now(),
  ): EnsembleTransition<EnsembleStageAttempt> {
    const output =
      patch.output === undefined || patch.output === null
        ? null
        : serializedJson(patch.output, ENSEMBLE_LIMITS.stagePayloadJsonBytes, "stage output");
    return this.inTransaction(() => {
      const before = this.db
        .prepare(`SELECT * FROM ensemble_stage_attempts WHERE id = ?`)
        .get(id) as unknown;
      if (!before) return { ok: false, reason: "not_found", current: null };
      const current = rowToStageAttempt(before);
      if (expected.length === 0) return { ok: false, reason: "precondition_failed", current };
      const sets = ["status = ?", "updated_at = ?", "finished_at = ?"];
      const values: Array<string | number | null> = [
        next,
        now,
        next === "running" || next === "waiting" || next === "queued" ? null : now,
      ];
      if ("output" in patch) {
        sets.push("output_json = ?");
        values.push(output);
      }
      if ("error" in patch) {
        sets.push("error = ?");
        values.push(boundedOrNull(patch.error ?? null, ENSEMBLE_LIMITS.errorText));
      }
      const expectedSlots = expected.map(() => "?").join(",");
      const terminalSlots = TERMINAL_STAGE_STATUSES.map(() => "?").join(",");
      const changed = this.db
        .prepare(
          `UPDATE ensemble_stage_attempts SET ${sets.join(", ")}
             WHERE id = ? AND status IN (${expectedSlots}) AND status NOT IN (${terminalSlots})`,
        )
        .run(...values, id, ...expected, ...TERMINAL_STAGE_STATUSES).changes;
      if (changed === 0) return { ok: false, reason: "precondition_failed", current };
      const row = this.db
        .prepare(`SELECT * FROM ensemble_stage_attempts WHERE id = ?`)
        .get(id) as unknown;
      return row
        ? { ok: true, value: rowToStageAttempt(row) }
        : { ok: false, reason: "not_found", current: null };
    });
  }

  /** Idempotent on `(stage_attempt_id, attempt)`: a retry of the same attempt is one row. */
  recordEvaluation(input: EnsembleEvaluationInsert, now = Date.now()): EnsembleEvaluation {
    return this.inTransaction(() => {
      const existing = this.db
        .prepare(`SELECT * FROM ensemble_evaluations WHERE stage_attempt_id = ? AND attempt = ?`)
        .get(input.stageAttemptId, input.attempt) as unknown;
      if (existing) {
        const evaluation = rowToEvaluation(existing);
        if (
          evaluation.runId !== input.runId ||
          evaluation.stageAttemptId !== input.stageAttemptId ||
          evaluation.attempt !== input.attempt
        ) {
          identityConflict(
            "evaluation identity",
            `${input.stageAttemptId}:${input.attempt}`,
          );
        }
        return evaluation;
      }
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO ensemble_evaluations (id, run_id, stage_attempt_id, attempt, method,
             runner_id, model_id, input_fingerprint, subjects_json, result_json, status,
             created_at, updated_at, finished_at, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL)`,
        )
        .run(
          id,
          input.runId,
          input.stageAttemptId,
          input.attempt,
          input.method,
          input.runnerId,
          input.modelId,
          input.inputFingerprint,
          JSON.stringify(input.subjectArtifactIds),
          input.status,
          now,
          now,
        );
      const row = this.db.prepare(`SELECT * FROM ensemble_evaluations WHERE id = ?`).get(id) as unknown;
      return rowToEvaluation(row);
    });
  }

  finishEvaluation(
    id: string,
    expected: readonly EnsembleEvaluationStatus[],
    next: EnsembleEvaluationStatus,
    patch: {
      runnerId?: string | null;
      modelId?: string | null;
      result?: EnsemblePayloadEnvelope | null;
      error?: string | null;
    } = {},
    now = Date.now(),
  ): EnsembleTransition<EnsembleEvaluation> {
    const result =
      patch.result === undefined || patch.result === null
        ? null
        : serializedJson(
            patch.result,
            ENSEMBLE_LIMITS.evaluationResultJsonBytes,
            "evaluation result",
          );
    return this.inTransaction(() => {
      const before = this.db
        .prepare(`SELECT * FROM ensemble_evaluations WHERE id = ?`)
        .get(id) as unknown;
      if (!before) return { ok: false, reason: "not_found", current: null };
      const current = rowToEvaluation(before);
      if (expected.length === 0) return { ok: false, reason: "precondition_failed", current };
      const sets = ["status = ?", "updated_at = ?", "finished_at = ?"];
      const values: Array<string | number | null> = [
        next,
        now,
        next === "queued" || next === "running" ? null : now,
      ];
      if ("runnerId" in patch) {
        sets.push("runner_id = ?");
        values.push(patch.runnerId ?? null);
      }
      if ("modelId" in patch) {
        sets.push("model_id = ?");
        values.push(patch.modelId ?? null);
      }
      if ("result" in patch) {
        sets.push("result_json = ?");
        values.push(result);
      }
      if ("error" in patch) {
        sets.push("error = ?");
        values.push(boundedOrNull(patch.error ?? null, ENSEMBLE_LIMITS.errorText));
      }
      const expectedSlots = expected.map(() => "?").join(",");
      const terminalSlots = TERMINAL_EVALUATION_STATUSES.map(() => "?").join(",");
      const changed = this.db
        .prepare(
          `UPDATE ensemble_evaluations SET ${sets.join(", ")}
             WHERE id = ? AND status IN (${expectedSlots}) AND status NOT IN (${terminalSlots})`,
        )
        .run(...values, id, ...expected, ...TERMINAL_EVALUATION_STATUSES).changes;
      if (changed === 0) return { ok: false, reason: "precondition_failed", current };
      const row = this.db.prepare(`SELECT * FROM ensemble_evaluations WHERE id = ?`).get(id) as unknown;
      return row
        ? { ok: true, value: rowToEvaluation(row) }
        : { ok: false, reason: "not_found", current: null };
    });
  }

  /** Opened BEFORE the call, so an interrupted one is still on the ledger afterwards. */
  startLlmCall(input: EnsembleLlmCallInsert): EnsembleLlmCall {
    const operationKey = identityKey(
      input.operationKey,
      ENSEMBLE_LIMITS.operationKey,
      "operation key",
    );
    return this.inTransaction(() => {
      const existing = this.db
        .prepare(`SELECT * FROM ensemble_llm_calls WHERE operation_key = ?`)
        .get(operationKey) as unknown;
      if (existing) {
        const call = rowToLlmCall(existing);
        if (
          call.runId !== input.runId ||
          call.stageAttemptId !== input.stageAttemptId ||
          call.evaluationId !== input.evaluationId ||
          call.purpose !== input.purpose ||
          call.runnerId !== input.runnerId ||
          call.modelId !== input.modelId ||
          call.attempt !== input.attempt
        ) {
          identityConflict("operation key", operationKey);
        }
        return call;
      }
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO ensemble_llm_calls (id, run_id, stage_attempt_id, evaluation_id, purpose,
             runner_id, model_id, attempt, operation_key, state, started_at, finished_at,
             duration_ms, input_bytes, output_bytes, cost_usd, error_code)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, 0, NULL, NULL)`,
        )
        .run(
          id,
          input.runId,
          input.stageAttemptId,
          input.evaluationId,
          input.purpose,
          input.runnerId,
          input.modelId,
          input.attempt,
          operationKey,
          input.state,
          input.startedAt,
        );
      const row = this.db.prepare(`SELECT * FROM ensemble_llm_calls WHERE id = ?`).get(id) as unknown;
      return rowToLlmCall(row);
    });
  }

  finishLlmCall(
    id: string,
    expected: readonly EnsembleLlmCallState[],
    state: EnsembleLlmCallState,
    patch: {
      finishedAt: number;
      durationMs: number;
      inputBytes: number;
      outputBytes: number;
      /** Null means the runner did not report one. Never coalesce it to zero. */
      costUsd: number | null;
      errorCode: string | null;
    },
  ): EnsembleTransition<EnsembleLlmCall> {
    return this.inTransaction(() => {
      const before = this.db.prepare(`SELECT * FROM ensemble_llm_calls WHERE id = ?`).get(id) as unknown;
      if (!before) return { ok: false, reason: "not_found", current: null };
      const current = rowToLlmCall(before);
      if (expected.length === 0) return { ok: false, reason: "precondition_failed", current };
      const expectedSlots = expected.map(() => "?").join(",");
      const terminalSlots = TERMINAL_LLM_CALL_STATES.map(() => "?").join(",");
      const changed = this.db
        .prepare(
          `UPDATE ensemble_llm_calls SET state = ?, finished_at = ?, duration_ms = ?,
             input_bytes = ?, output_bytes = ?, cost_usd = ?, error_code = ?
             WHERE id = ? AND state IN (${expectedSlots}) AND state NOT IN (${terminalSlots})`,
        )
        .run(
          state,
          patch.finishedAt,
          patch.durationMs,
          patch.inputBytes,
          patch.outputBytes,
          patch.costUsd,
          boundedOrNull(patch.errorCode, 200),
          id,
          ...expected,
          ...TERMINAL_LLM_CALL_STATES,
        ).changes;
      if (changed === 0) return { ok: false, reason: "precondition_failed", current };
      const row = this.db.prepare(`SELECT * FROM ensemble_llm_calls WHERE id = ?`).get(id) as unknown;
      return row
        ? { ok: true, value: rowToLlmCall(row) }
        : { ok: false, reason: "not_found", current: null };
    });
  }

  /**
   * Record one decision, superseding whatever it replaces, in one transaction.
   *
   * Versioned rather than updated so the history explains a promotion under the evidence that
   * was on screen when it was made. Idempotent on `operationKey`, because the click that
   * records a decision is the click that starts destroying loser worktrees.
   */
  recordDecision(input: EnsembleDecisionInsert, now = Date.now()): EnsembleDecision {
    const operationKey = identityKey(
      input.operationKey,
      ENSEMBLE_LIMITS.operationKey,
      "operation key",
    );
    return this.inTransaction(() => {
      const existing = this.db
        .prepare(`SELECT * FROM ensemble_decisions WHERE operation_key = ?`)
        .get(operationKey) as unknown;
      if (existing) {
        const decision = rowToDecision(existing);
        if (decision.runId !== input.runId) identityConflict("operation key", operationKey);
        return decision;
      }
      const selection = serializedJson(
        input.selection,
        ENSEMBLE_LIMITS.decisionSelectionJsonBytes,
        "decision selection",
      );
      const highest = this.db
        .prepare(`SELECT MAX(version) AS highest FROM ensemble_decisions WHERE run_id = ?`)
        .get(input.runId) as unknown as { highest: number | null } | undefined;
      const version = (highest?.highest ?? 0) + 1;
      this.db
        .prepare(
          `UPDATE ensemble_decisions SET status = 'superseded', updated_at = ?
             WHERE run_id = ? AND status <> 'superseded'`,
        )
        .run(now, input.runId);
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO ensemble_decisions (id, run_id, version, actor, actor_id, status,
             selection_json, rationale, finalization_stage_attempt_id, operation_key,
             created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'recorded', ?, ?, NULL, ?, ?, ?)`,
        )
        .run(
          id,
          input.runId,
          version,
          input.actor,
          input.actorId,
          selection,
          bounded(input.rationale, ENSEMBLE_LIMITS.rationale),
          operationKey,
          now,
          now,
        );
      const row = this.db.prepare(`SELECT * FROM ensemble_decisions WHERE id = ?`).get(id) as unknown;
      return rowToDecision(row);
    });
  }

  /** Mark a recorded decision as carried out, and link the attempt that did it. */
  applyDecision(id: string, stageAttemptId: string, now = Date.now()): EnsembleTransition<EnsembleDecision> {
    return this.inTransaction(() => {
      const before = this.db.prepare(`SELECT * FROM ensemble_decisions WHERE id = ?`).get(id) as unknown;
      if (!before) return { ok: false, reason: "not_found", current: null };
      const result = this.db
        .prepare(
          `UPDATE ensemble_decisions SET status = 'applied', finalization_stage_attempt_id = ?,
             updated_at = ? WHERE id = ? AND status = 'recorded'`,
        )
        .run(stageAttemptId, now, id);
      if (result.changes === 0) return { ok: false, reason: "precondition_failed", current: rowToDecision(before) };
      const row = this.db.prepare(`SELECT * FROM ensemble_decisions WHERE id = ?`).get(id) as unknown;
      return { ok: true, value: rowToDecision(row) };
    });
  }

  /**
   * Append one audit record, or nothing if this operation already wrote one.
   *
   * Bounded and idempotent: a replayed transition after a restart must not double the
   * timeline an operator reads to work out what happened.
   */
  appendEvent(input: EnsembleEventInsert, now = Date.now()): EnsembleEvent | null {
    const operationKey = identityKey(
      input.operationKey,
      ENSEMBLE_LIMITS.operationKey,
      "operation key",
    );
    return this.inTransaction(() => {
      const existing = this.db
        .prepare(`SELECT * FROM ensemble_events WHERE operation_key = ?`)
        .get(operationKey) as unknown;
      if (existing) {
        const event = rowToEvent(existing);
        if (event.runId !== input.runId || event.kind !== input.kind) {
          identityConflict("operation key", operationKey);
        }
        return event;
      }
      const payload = serializedJson(
        input.payload,
        ENSEMBLE_LIMITS.eventPayloadJsonBytes,
        "event payload",
      );
      const result = this.db
        .prepare(
          `INSERT INTO ensemble_events (run_id, ts, event_kind, payload_json, operation_key)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          input.runId,
          now,
          input.kind,
          payload,
          operationKey,
        );
      const row = this.db
        .prepare(`SELECT * FROM ensemble_events WHERE id = ?`)
        .get(Number(result.lastInsertRowid)) as unknown;
      return row ? rowToEvent(row) : null;
    });
  }

  /**
   * Delete one run and everything under it.
   *
   * The explicit "delete this history" act, and the only thing that removes an ensemble row.
   * Children go with it through the declared foreign keys rather than through nine DELETEs
   * here, so a table added later cannot be forgotten. Private Git refs are NOT touched: the
   * caller owns that, because removing a restorable snapshot is a separate confirmation.
   */
  deleteRun(id: string): boolean {
    const removed = this.db.prepare(`DELETE FROM ensemble_runs WHERE id = ?`).run(id).changes > 0;
    if (removed) this.notifyTaskLinksChanged();
    return removed;
  }
}

/** Wipe the whole family. Tests only; the cascade means one DELETE is the whole job. */
export function clearEnsembleTables(db: DatabaseSync): void {
  db.exec("DELETE FROM ensemble_runs;");
  // Belt and braces for a database opened before the pragma existed: the cascade does the
  // work when foreign keys are on, and these make the wipe total when they are not.
  for (const table of ENSEMBLE_TABLES) {
    if (table !== "ensemble_runs") db.exec(`DELETE FROM ${table};`);
  }
}
