import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { CreatePersona, CreateWorkflow, UpdatePersona, UpdateWorkflow } from "@shared/protocol.ts";
import {
  PersonaSnapshotSchema,
  PublishedWorkflowGraphSchema,
  WorkflowBindingDefaultsSchema,
  WorkflowCompletionPolicySchema,
  WorkflowDraftGraphSchema,
  WorkflowJsonSchema,
  WorkflowNodeAttemptStateSchema,
  WorkflowRunStatusSchema,
  WorkflowSubmissionModeSchema,
  WorkflowSubmissionStatusSchema,
} from "@shared/protocol.ts";
import {
  WORKFLOW_BINDING_STATES,
  WORKFLOW_DELIVERY_KINDS,
  WORKFLOW_DELIVERY_MODES,
  WORKFLOW_DELIVERY_STATES,
  WORKFLOW_EXECUTION_LIMITS,
  WORKFLOW_LIMITS,
  WORKFLOW_LLM_CALL_STATES,
  WORKFLOW_LLM_PURPOSES,
  WORKFLOW_TRIGGER_MODES,
  type WorkflowTriggerSource,
} from "@shared/workflow.ts";
import type {
  Persona,
  WorkflowBinding,
  WorkflowDefinition,
  WorkflowDelivery,
  WorkflowEdgeReceipt,
  WorkflowEvent,
  WorkflowJson,
  WorkflowLlmCall,
  WorkflowNodeAttempt,
  WorkflowRun,
  WorkflowRunDetail,
  WorkflowRunSummary,
  WorkflowSubmission,
  WorkflowVersion,
  WorkflowVersionMetadata,
  WorkflowSummary,
  WorkflowDiagnostic,
} from "@shared/workflow.ts";
import type { LlmRunnerId } from "@shared/llm.ts";
import { LLM_RUNNER_IDS } from "@shared/llm.ts";
import { openDb } from "../db.ts";
import { validateWorkflowGraph } from "@shared/workflow-graph.ts";
import { TERMINAL_ITEM_STATES } from "@shared/queue.ts";

// SQL and row mapping for the whole Phase 1 workflow table family. Managers own policy and
// ids; this module owns the fact that every durable TEXT enum/JSON value is validated before
// it can become a typed record.

const text = z.string();
const nonempty = text.min(1);
const integer = z.number().int();
const positive = integer.positive();
const nullableText = text.nullable();
const nullableInteger = integer.nullable();
const boundedCode = text.max(200);
const TRIGGER_SOURCES = ["manual", "foreman"] as const;
const utf8 = new TextEncoder();

export const WORKFLOW_TABLES = [
  "personas",
  "workflow_definitions",
  "workflow_versions",
  "workflow_bindings",
  "workflow_runs",
  "workflow_submissions",
  "workflow_node_attempts",
  "workflow_edge_receipts",
  "workflow_deliveries",
  "workflow_llm_calls",
  "workflow_events",
] as const;

export class WorkflowRowError extends Error {
  constructor(
    readonly table: (typeof WORKFLOW_TABLES)[number],
    readonly rowId: string,
    detail: string,
  ) {
    super(`${table} row ${rowId}: ${detail}`);
    this.name = "WorkflowRowError";
  }
}

function rowId(value: unknown): string {
  if (value && typeof value === "object" && "id" in value) return String(value.id);
  return "(unknown)";
}

function parseShape<T>(
  table: (typeof WORKFLOW_TABLES)[number],
  schema: z.ZodType<T>,
  value: unknown,
): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new WorkflowRowError(table, rowId(value), parsed.error.message);
}

function parseJson<T>(
  table: (typeof WORKFLOW_TABLES)[number],
  id: string | number,
  column: string,
  raw: string,
  schema: z.ZodType<T>,
  maxBytes: number = WORKFLOW_LIMITS.graphJsonBytes,
): T {
  if (utf8.encode(raw).byteLength > maxBytes) {
    throw new WorkflowRowError(table, String(id), `${column} exceeds ${maxBytes} UTF-8 bytes`);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new WorkflowRowError(table, String(id), `${column} is not valid JSON`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new WorkflowRowError(table, String(id), `${column}: ${parsed.error.message}`);
  }
  return parsed.data;
}

function parseNullableJson<T>(
  table: (typeof WORKFLOW_TABLES)[number],
  id: string,
  column: string,
  raw: string | null,
  schema: z.ZodType<T>,
  maxBytes?: number,
): T | null {
  return raw === null ? null : parseJson(table, id, column, raw, schema, maxBytes);
}

const PersonaRowSchema = z.object({
  id: nonempty,
  name: nonempty.max(WORKFLOW_LIMITS.personaName),
  normalized_name: nonempty,
  description: text.max(WORKFLOW_LIMITS.personaDescription),
  guidance_md: text,
  // Deliberately free text on READ. A newer build may have written a runner id this build
  // does not implement; Persona execution degrades through resolveLlmRunner and reports it.
  runner_id: nullableText,
  model_id: nullableText,
  revision: positive,
  archived_at: nullableInteger,
  created_at: integer,
  updated_at: integer,
});

export function parsePersonaRow(value: unknown): Persona {
  const row = parseShape("personas", PersonaRowSchema, value);
  if (utf8.encode(row.guidance_md).byteLength > WORKFLOW_LIMITS.personaGuidanceBytes) {
    throw new WorkflowRowError("personas", row.id, "guidance_md exceeds the Persona byte limit");
  }
  if (row.guidance_md.trim().length === 0) {
    throw new WorkflowRowError("personas", row.id, "guidance_md is empty");
  }
  return {
    id: row.id,
    name: row.name,
    normalizedName: row.normalized_name,
    description: row.description,
    guidanceMarkdown: row.guidance_md,
    // Runtime may hold an unknown id from a newer build. The wire type stays the declared
    // runner union; Persona resolution is the tolerant boundary that reports the fallback.
    runner: row.runner_id as LlmRunnerId | null,
    model: row.model_id,
    revision: row.revision,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const WorkflowDefinitionRowSchema = z.object({
  id: nonempty,
  name: nonempty,
  normalized_name: nonempty,
  description: text,
  draft_graph_json: nonempty,
  completion_policy_json: nonempty,
  binding_defaults_json: nonempty,
  draft_revision: positive,
  current_version_id: nullableText,
  archived_at: nullableInteger,
  created_at: integer,
  updated_at: integer,
});

export function parseWorkflowDefinitionRow(value: unknown): WorkflowDefinition {
  const row = parseShape("workflow_definitions", WorkflowDefinitionRowSchema, value);
  return {
    id: row.id,
    name: row.name,
    normalizedName: row.normalized_name,
    description: row.description,
    draft: parseJson("workflow_definitions", row.id, "draft_graph_json", row.draft_graph_json, WorkflowDraftGraphSchema),
    completionPolicy: parseJson(
      "workflow_definitions",
      row.id,
      "completion_policy_json",
      row.completion_policy_json,
      WorkflowCompletionPolicySchema,
    ),
    bindingDefaults: parseJson(
      "workflow_definitions",
      row.id,
      "binding_defaults_json",
      row.binding_defaults_json,
      WorkflowBindingDefaultsSchema,
    ),
    draftRevision: row.draft_revision,
    currentVersionId: row.current_version_id,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const WorkflowVersionRowSchema = z.object({
  id: nonempty,
  workflow_id: nonempty,
  version: positive,
  source_draft_revision: positive,
  graph_json: nonempty,
  completion_policy_json: nonempty,
  binding_defaults_json: nonempty,
  published_at: integer,
});

export function parseWorkflowVersionRow(value: unknown): WorkflowVersion {
  const row = parseShape("workflow_versions", WorkflowVersionRowSchema, value);
  return {
    id: row.id,
    workflowId: row.workflow_id,
    version: row.version,
    sourceDraftRevision: row.source_draft_revision,
    graph: parseJson("workflow_versions", row.id, "graph_json", row.graph_json, PublishedWorkflowGraphSchema),
    completionPolicy: parseJson(
      "workflow_versions",
      row.id,
      "completion_policy_json",
      row.completion_policy_json,
      WorkflowCompletionPolicySchema,
    ),
    bindingDefaults: parseJson(
      "workflow_versions",
      row.id,
      "binding_defaults_json",
      row.binding_defaults_json,
      WorkflowBindingDefaultsSchema,
    ),
    publishedAt: row.published_at,
  };
}

const WorkflowVersionMetadataRowSchema = WorkflowVersionRowSchema.omit({ graph_json: true });

export function parseWorkflowVersionMetadataRow(value: unknown): WorkflowVersionMetadata {
  const row = parseShape("workflow_versions", WorkflowVersionMetadataRowSchema, value);
  return {
    id: row.id,
    workflowId: row.workflow_id,
    version: row.version,
    sourceDraftRevision: row.source_draft_revision,
    completionPolicy: parseJson(
      "workflow_versions",
      row.id,
      "completion_policy_json",
      row.completion_policy_json,
      WorkflowCompletionPolicySchema,
    ),
    bindingDefaults: parseJson(
      "workflow_versions",
      row.id,
      "binding_defaults_json",
      row.binding_defaults_json,
      WorkflowBindingDefaultsSchema,
    ),
    publishedAt: row.published_at,
  };
}

const WorkflowBindingRowSchema = z.object({
  id: nonempty,
  workflow_version_id: nonempty,
  note_key: nonempty,
  session_id: nullableText,
  session_agent: text.optional().default(""),
  session_name: text.optional().default(""),
  session_cwd: nullableText.optional().default(null),
  session_repo_root: nullableText.optional().default(null),
  trigger_mode: z.enum(WORKFLOW_TRIGGER_MODES),
  delivery_mode: z.enum(WORKFLOW_DELIVERY_MODES),
  state: z.enum(WORKFLOW_BINDING_STATES),
  max_repair_rounds: integer.min(WORKFLOW_LIMITS.repairRoundsMin).max(WORKFLOW_LIMITS.repairRoundsMax),
  created_at: integer,
  updated_at: integer,
});

export function parseWorkflowBindingRow(value: unknown): WorkflowBinding {
  const row = parseShape("workflow_bindings", WorkflowBindingRowSchema, value);
  return {
    id: row.id,
    workflowVersionId: row.workflow_version_id,
    noteKey: row.note_key,
    sessionId: row.session_id,
    sessionAgent: row.session_agent ?? "",
    sessionName: row.session_name ?? "",
    sessionCwd: row.session_cwd ?? null,
    sessionRepoRoot: row.session_repo_root ?? null,
    triggerMode: row.trigger_mode,
    deliveryMode: row.delivery_mode,
    state: row.state,
    maxRepairRounds: row.max_repair_rounds,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const WorkflowRunRowSchema = z.object({
  id: nonempty,
  binding_id: nonempty,
  workflow_version_id: nonempty,
  status: WorkflowRunStatusSchema,
  current_phase: text,
  max_repair_rounds: integer.min(WORKFLOW_LIMITS.repairRoundsMin).max(WORKFLOW_LIMITS.repairRoundsMax),
  trigger_source: z.enum(TRIGGER_SOURCES),
  trigger_key: nonempty,
  inspector_pr_key: nullableText,
  inspector_head_sha: nullableText,
  gate_state_json: nullableText,
  started_at: integer,
  updated_at: integer,
  completed_at: nullableInteger,
});

export function parseWorkflowRunRow(value: unknown): WorkflowRun {
  const row = parseShape("workflow_runs", WorkflowRunRowSchema, value);
  return {
    id: row.id,
    bindingId: row.binding_id,
    workflowVersionId: row.workflow_version_id,
    status: row.status,
    currentPhase: row.current_phase,
    maxRepairRounds: row.max_repair_rounds,
    triggerSource: row.trigger_source,
    triggerKey: row.trigger_key,
    inspectorPrKey: row.inspector_pr_key,
    inspectorHeadSha: row.inspector_head_sha,
    gateState: parseNullableJson(
      "workflow_runs",
      row.id,
      "gate_state_json",
      row.gate_state_json,
      WorkflowJsonSchema,
      WORKFLOW_EXECUTION_LIMITS.contextJsonBytes,
    ),
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

const WorkflowSubmissionRowSchema = z.object({
  id: nonempty,
  run_id: nonempty,
  round: positive,
  mode: WorkflowSubmissionModeSchema,
  trigger_source: z.enum(TRIGGER_SOURCES),
  trigger_key: nonempty,
  evidence_fingerprint: nonempty,
  context_json: nonempty,
  evidence_json: nonempty,
  pr_head_sha: nullableText,
  status: WorkflowSubmissionStatusSchema,
  created_at: integer,
  updated_at: integer,
  completed_at: nullableInteger,
});

export function parseWorkflowSubmissionRow(value: unknown): WorkflowSubmission {
  const row = parseShape("workflow_submissions", WorkflowSubmissionRowSchema, value);
  return {
    id: row.id,
    runId: row.run_id,
    round: row.round,
    mode: row.mode,
    triggerSource: row.trigger_source,
    triggerKey: row.trigger_key,
    evidenceFingerprint: row.evidence_fingerprint,
    context: parseJson(
      "workflow_submissions",
      row.id,
      "context_json",
      row.context_json,
      WorkflowJsonSchema,
      WORKFLOW_EXECUTION_LIMITS.contextJsonBytes,
    ),
    evidence: parseJson(
      "workflow_submissions",
      row.id,
      "evidence_json",
      row.evidence_json,
      WorkflowJsonSchema,
      WORKFLOW_EXECUTION_LIMITS.contextJsonBytes,
    ),
    prHeadSha: row.pr_head_sha,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

const WorkflowNodeAttemptRowSchema = z.object({
  id: nonempty,
  submission_id: nonempty,
  node_id: nonempty,
  attempt: positive,
  state: WorkflowNodeAttemptStateSchema,
  persona_snapshot_json: nullableText,
  runner_id: z.enum(LLM_RUNNER_IDS).nullable().optional().default(null),
  model_id: nullableText.optional().default(null),
  verdict_json: nullableText,
  output_json: nullableText,
  retry_at: nullableInteger,
  input_fingerprint: nonempty,
  error: nullableText,
  created_at: integer,
  updated_at: integer,
  started_at: nullableInteger,
  finished_at: nullableInteger,
});

export function parseWorkflowNodeAttemptRow(value: unknown): WorkflowNodeAttempt {
  const row = parseShape("workflow_node_attempts", WorkflowNodeAttemptRowSchema, value);
  return {
    id: row.id,
    submissionId: row.submission_id,
    nodeId: row.node_id,
    attempt: row.attempt,
    state: row.state,
    persona: parseNullableJson(
      "workflow_node_attempts",
      row.id,
      "persona_snapshot_json",
      row.persona_snapshot_json,
      PersonaSnapshotSchema,
    ),
    runner: row.runner_id ?? null,
    model: row.model_id ?? null,
    verdict: parseNullableJson(
      "workflow_node_attempts",
      row.id,
      "verdict_json",
      row.verdict_json,
      WorkflowJsonSchema,
      WORKFLOW_LIMITS.eventPayloadBytes,
    ),
    output: parseNullableJson(
      "workflow_node_attempts",
      row.id,
      "output_json",
      row.output_json,
      WorkflowJsonSchema,
      WORKFLOW_EXECUTION_LIMITS.contextJsonBytes,
    ),
    retryAt: row.retry_at,
    inputFingerprint: row.input_fingerprint,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

const WorkflowEdgeReceiptRowSchema = z.object({
  id: positive,
  submission_id: nonempty,
  edge_id: nonempty,
  source_attempt_id: nonempty,
  payload_json: nonempty,
  created_at: integer,
});

export function parseWorkflowEdgeReceiptRow(value: unknown): WorkflowEdgeReceipt {
  const row = parseShape("workflow_edge_receipts", WorkflowEdgeReceiptRowSchema, value);
  return {
    id: row.id,
    submissionId: row.submission_id,
    edgeId: row.edge_id,
    sourceAttemptId: row.source_attempt_id,
    payload: parseJson(
      "workflow_edge_receipts",
      row.id,
      "payload_json",
      row.payload_json,
      WorkflowJsonSchema,
      WORKFLOW_EXECUTION_LIMITS.contextJsonBytes,
    ),
    createdAt: row.created_at,
  };
}

const WorkflowDeliveryRowSchema = z.object({
  id: nonempty,
  run_id: nonempty,
  submission_id: nonempty,
  kind: z.enum(WORKFLOW_DELIVERY_KINDS),
  session_id: nonempty,
  note_key: nonempty,
  payload: text,
  payload_sha256: nonempty,
  state: z.enum(WORKFLOW_DELIVERY_STATES),
  error: nullableText,
  created_at: integer,
  updated_at: integer,
  delivered_at: nullableInteger,
});

export function parseWorkflowDeliveryRow(value: unknown): WorkflowDelivery {
  const row = parseShape("workflow_deliveries", WorkflowDeliveryRowSchema, value);
  if (utf8.encode(row.payload).byteLength > WORKFLOW_LIMITS.eventPayloadBytes) {
    throw new WorkflowRowError("workflow_deliveries", row.id, "payload exceeds the delivery limit");
  }
  return {
    id: row.id,
    runId: row.run_id,
    submissionId: row.submission_id,
    kind: row.kind,
    sessionId: row.session_id,
    noteKey: row.note_key,
    payload: row.payload,
    payloadSha256: row.payload_sha256,
    state: row.state,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deliveredAt: row.delivered_at,
  };
}

const WorkflowLlmCallRowSchema = z.object({
  id: nonempty,
  run_id: nonempty,
  submission_id: nonempty,
  node_attempt_id: nullableText,
  purpose: z.enum(WORKFLOW_LLM_PURPOSES),
  runner_id: z.enum(LLM_RUNNER_IDS),
  model_id: nonempty,
  attempt: positive,
  state: z.enum(WORKFLOW_LLM_CALL_STATES),
  started_at: integer,
  finished_at: nullableInteger,
  duration_ms: nullableInteger,
  input_bytes: integer.nonnegative(),
  output_bytes: integer.nonnegative(),
  cost_usd: z.number().finite().nonnegative().nullable(),
  error_code: boundedCode.nullable(),
});

export function parseWorkflowLlmCallRow(value: unknown): WorkflowLlmCall {
  const row = parseShape("workflow_llm_calls", WorkflowLlmCallRowSchema, value);
  return {
    id: row.id,
    runId: row.run_id,
    submissionId: row.submission_id,
    nodeAttemptId: row.node_attempt_id,
    purpose: row.purpose,
    runner: row.runner_id,
    model: row.model_id,
    attempt: row.attempt,
    state: row.state,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    inputBytes: row.input_bytes,
    outputBytes: row.output_bytes,
    costUsd: row.cost_usd,
    errorCode: row.error_code,
  };
}

const WorkflowEventRowSchema = z.object({
  id: positive,
  run_id: nonempty,
  ts: integer,
  event_kind: nonempty.max(200),
  payload_json: nonempty,
});

export function parseWorkflowEventRow(value: unknown): WorkflowEvent {
  const row = parseShape("workflow_events", WorkflowEventRowSchema, value);
  return {
    id: row.id,
    runId: row.run_id,
    timestamp: row.ts,
    kind: row.event_kind,
    payload: parseJson(
      "workflow_events",
      row.id,
      "payload_json",
      row.payload_json,
      WorkflowJsonSchema,
      WORKFLOW_LIMITS.eventPayloadBytes,
    ),
  };
}

function diagnose(error: unknown): void {
  console.error(`[workflow] skipping malformed durable row: ${String(error)}`);
}

function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

export interface PersonaInsert extends CreatePersona {
  id: string;
  normalizedName: string;
  createdAt: number;
  updatedAt: number;
}

export type PersonaPatch = Omit<UpdatePersona, "expectedRevision" | "name"> & {
  name?: string;
  normalizedName?: string;
};

export type PersonaStoreWrite =
  | { ok: true; persona: Persona }
  | {
      ok: false;
      reason: "not_found" | "revision_conflict" | "name_conflict" | "archived";
      current: Persona | null;
    };

export interface WorkflowInsert extends CreateWorkflow {
  id: string;
  normalizedName: string;
  createdAt: number;
  updatedAt: number;
}

export type WorkflowPatch = Omit<UpdateWorkflow, "expectedDraftRevision" | "name"> & {
  name?: string;
  normalizedName?: string;
};

export type WorkflowStoreWrite =
  | { ok: true; workflow: WorkflowDefinition }
  | {
      ok: false;
      reason: "not_found" | "revision_conflict" | "name_conflict" | "archived" | "active_binding";
      current: WorkflowDefinition | null;
    };

export type WorkflowPublishWrite =
  | { ok: true; workflow: WorkflowDefinition; version: WorkflowVersion; idempotent: boolean }
  | {
      ok: false;
      reason: "not_found" | "revision_conflict" | "archived" | "validation";
      current: WorkflowDefinition | null;
      diagnostics?: WorkflowDiagnostic[];
    };

export interface WorkflowBindingInsert {
  id: string;
  workflowVersionId: string;
  noteKey: string;
  sessionId: string;
  sessionAgent: string;
  sessionName: string;
  sessionCwd: string | null;
  sessionRepoRoot: string | null;
  triggerMode: WorkflowBinding["triggerMode"];
  deliveryMode: WorkflowBinding["deliveryMode"];
  maxRepairRounds: number;
  now: number;
}

export interface WorkflowRunInsert {
  id: string;
  binding: WorkflowBinding;
  triggerSource?: WorkflowTriggerSource;
  triggerKey: string;
  now: number;
}

export interface WorkflowSubmissionInsert {
  id: string;
  runId: string;
  round: number;
  triggerSource?: WorkflowTriggerSource;
  triggerKey: string;
  context: WorkflowJson;
  evidence: WorkflowJson;
  now: number;
}

export interface WorkflowAttemptInsert {
  id: string;
  submissionId: string;
  nodeId: string;
  attempt: number;
  state: WorkflowNodeAttempt["state"];
  persona: WorkflowNodeAttempt["persona"];
  inputFingerprint: string;
  retryAt?: number | null;
  error?: string | null;
  now: number;
}

export interface ForemanCompletionStoreInput {
  binding: WorkflowBinding;
  completionKind: "drain" | "prompted";
  marker: string;
  summary: string;
  evidenceFingerprint: string;
  currentGoal: string | null;
  runId: string;
  submissionId: string;
  now: number;
}

export interface ForemanCompletionStoreResult {
  result: Exclude<import("@shared/workflow.ts").WorkflowCompletionClaimResult, { claimed: false }>;
  run: WorkflowRun;
  submission: WorkflowSubmission | null;
  created: boolean;
  previousFingerprint: string | undefined;
}

export class WorkflowStore {
  constructor(private readonly db: DatabaseSync = openDb()) {}

  listPersonas(includeArchived = false): Persona[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM personas
          ${includeArchived ? "" : "WHERE archived_at IS NULL"}
         ORDER BY normalized_name ASC, id ASC`,
      )
      .all() as unknown[];
    const out: Persona[] = [];
    for (const row of rows) {
      try {
        out.push(parsePersonaRow(row));
      } catch (error) {
        diagnose(error);
      }
    }
    return out;
  }

  getPersona(id: string): Persona | null {
    const row = this.db.prepare(`SELECT * FROM personas WHERE id = ?`).get(id);
    if (!row) return null;
    try {
      return parsePersonaRow(row);
    } catch (error) {
      diagnose(error);
      return null;
    }
  }

  insertPersona(input: PersonaInsert): PersonaStoreWrite {
    return transaction(this.db, () => {
      const conflict = this.db
        .prepare(`SELECT * FROM personas WHERE normalized_name = ?`)
        .get(input.normalizedName);
      if (conflict) {
        let current: Persona | null = null;
        try {
          current = parsePersonaRow(conflict);
        } catch (error) {
          diagnose(error);
        }
        return { ok: false, reason: "name_conflict", current };
      }
      this.db
        .prepare(
          `INSERT INTO personas (
             id, name, normalized_name, description, guidance_md, runner_id, model_id,
             revision, archived_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)`,
        )
        .run(
          input.id,
          input.name,
          input.normalizedName,
          input.description,
          input.guidanceMarkdown,
          input.runner,
          input.model,
          input.createdAt,
          input.updatedAt,
        );
      return { ok: true, persona: this.mustPersona(input.id) };
    });
  }

  updatePersonaCas(
    id: string,
    expectedRevision: number,
    patch: PersonaPatch,
    updatedAt = Date.now(),
  ): PersonaStoreWrite {
    return transaction(this.db, () => {
      const current = this.getPersonaInTransaction(id);
      if (!current) return { ok: false, reason: "not_found", current: null };
      if (current.archivedAt !== null) return { ok: false, reason: "archived", current };
      if (current.revision !== expectedRevision) {
        return { ok: false, reason: "revision_conflict", current };
      }
      if (patch.normalizedName !== undefined) {
        const conflict = this.db
          .prepare(`SELECT id FROM personas WHERE normalized_name = ? AND id <> ?`)
          .get(patch.normalizedName, id);
        if (conflict) return { ok: false, reason: "name_conflict", current };
      }

      const assignments: string[] = [];
      const values: Array<string | number | null> = [];
      const add = (column: string, value: string | number | null): void => {
        assignments.push(`${column} = ?`);
        values.push(value);
      };
      if (patch.name !== undefined) add("name", patch.name);
      if (patch.normalizedName !== undefined) add("normalized_name", patch.normalizedName);
      if (patch.description !== undefined) add("description", patch.description);
      if (patch.guidanceMarkdown !== undefined) add("guidance_md", patch.guidanceMarkdown);
      if ("runner" in patch) add("runner_id", patch.runner ?? null);
      if ("model" in patch) add("model_id", patch.model ?? null);
      assignments.push("revision = revision + 1", "updated_at = ?");
      values.push(updatedAt, id, expectedRevision);
      const result = this.db
        .prepare(
          `UPDATE personas SET ${assignments.join(", ")}
            WHERE id = ? AND revision = ? AND archived_at IS NULL`,
        )
        .run(...values);
      if (Number(result.changes) !== 1) {
        const latest = this.getPersonaInTransaction(id);
        return { ok: false, reason: "revision_conflict", current: latest };
      }
      return { ok: true, persona: this.mustPersona(id) };
    });
  }

  archivePersonaCas(id: string, expectedRevision: number, archivedAt = Date.now()): PersonaStoreWrite {
    return transaction(this.db, () => {
      const current = this.getPersonaInTransaction(id);
      if (!current) return { ok: false, reason: "not_found", current: null };
      if (current.archivedAt !== null) return { ok: false, reason: "archived", current };
      if (current.revision !== expectedRevision) {
        return { ok: false, reason: "revision_conflict", current };
      }
      const result = this.db
        .prepare(
          `UPDATE personas
              SET archived_at = ?, updated_at = ?, revision = revision + 1
            WHERE id = ? AND revision = ? AND archived_at IS NULL`,
        )
        .run(archivedAt, archivedAt, id, expectedRevision);
      if (Number(result.changes) !== 1) {
        const latest = this.getPersonaInTransaction(id);
        return { ok: false, reason: "revision_conflict", current: latest };
      }
      return { ok: true, persona: this.mustPersona(id) };
    });
  }

  private getPersonaInTransaction(id: string): Persona | null {
    const row = this.db.prepare(`SELECT * FROM personas WHERE id = ?`).get(id);
    return row ? parsePersonaRow(row) : null;
  }

  private mustPersona(id: string): Persona {
    const persona = this.getPersonaInTransaction(id);
    if (!persona) throw new Error(`Persona ${id} disappeared during a workflow transaction`);
    return persona;
  }

  listWorkflows(includeArchived = false): WorkflowDefinition[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM workflow_definitions
          ${includeArchived ? "" : "WHERE archived_at IS NULL"}
         ORDER BY normalized_name ASC, id ASC`,
      )
      .all() as unknown[];
    const out: WorkflowDefinition[] = [];
    for (const row of rows) {
      try {
        out.push(parseWorkflowDefinitionRow(row));
      } catch (error) {
        diagnose(error);
      }
    }
    return out;
  }

  getWorkflow(id: string): WorkflowDefinition | null {
    const row = this.db.prepare(`SELECT * FROM workflow_definitions WHERE id = ?`).get(id);
    if (!row) return null;
    try {
      return parseWorkflowDefinitionRow(row);
    } catch (error) {
      diagnose(error);
      return null;
    }
  }

  insertWorkflow(input: WorkflowInsert): WorkflowStoreWrite {
    return transaction(this.db, () => {
      const conflict = this.db
        .prepare(`SELECT * FROM workflow_definitions WHERE normalized_name = ?`)
        .get(input.normalizedName);
      if (conflict) {
        let current: WorkflowDefinition | null = null;
        try { current = parseWorkflowDefinitionRow(conflict); } catch (error) { diagnose(error); }
        return { ok: false, reason: "name_conflict", current };
      }
      this.db.prepare(
        `INSERT INTO workflow_definitions (
           id, name, normalized_name, description, draft_graph_json,
           completion_policy_json, binding_defaults_json, draft_revision,
           current_version_id, archived_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL, ?, ?)`,
      ).run(
        input.id,
        input.name,
        input.normalizedName,
        input.description,
        JSON.stringify(input.draft),
        JSON.stringify(input.completionPolicy),
        JSON.stringify(input.bindingDefaults),
        input.createdAt,
        input.updatedAt,
      );
      return { ok: true, workflow: this.mustWorkflow(input.id) };
    });
  }

  updateWorkflowCas(
    id: string,
    expectedDraftRevision: number,
    patch: WorkflowPatch,
    updatedAt = Date.now(),
  ): WorkflowStoreWrite {
    return transaction(this.db, () => {
      const current = this.getWorkflowInTransaction(id);
      if (!current) return { ok: false, reason: "not_found", current: null };
      if (current.archivedAt !== null) return { ok: false, reason: "archived", current };
      if (current.draftRevision !== expectedDraftRevision) {
        return { ok: false, reason: "revision_conflict", current };
      }
      if (patch.normalizedName !== undefined) {
        const conflict = this.db
          .prepare(`SELECT id FROM workflow_definitions WHERE normalized_name = ? AND id <> ?`)
          .get(patch.normalizedName, id);
        if (conflict) return { ok: false, reason: "name_conflict", current };
      }
      const assignments: string[] = [];
      const values: Array<string | number | null> = [];
      const add = (column: string, value: string | number | null): void => {
        assignments.push(`${column} = ?`);
        values.push(value);
      };
      if (patch.name !== undefined) add("name", patch.name);
      if (patch.normalizedName !== undefined) add("normalized_name", patch.normalizedName);
      if (patch.description !== undefined) add("description", patch.description);
      if (patch.draft !== undefined) add("draft_graph_json", JSON.stringify(patch.draft));
      if (patch.completionPolicy !== undefined) add("completion_policy_json", JSON.stringify(patch.completionPolicy));
      if (patch.bindingDefaults !== undefined) add("binding_defaults_json", JSON.stringify(patch.bindingDefaults));
      assignments.push("draft_revision = draft_revision + 1", "updated_at = ?");
      values.push(updatedAt, id, expectedDraftRevision);
      const result = this.db.prepare(
        `UPDATE workflow_definitions SET ${assignments.join(", ")}
          WHERE id = ? AND draft_revision = ? AND archived_at IS NULL`,
      ).run(...values);
      if (Number(result.changes) !== 1) {
        return { ok: false, reason: "revision_conflict", current: this.getWorkflowInTransaction(id) };
      }
      return { ok: true, workflow: this.mustWorkflow(id) };
    });
  }

  archiveWorkflowCas(id: string, expectedDraftRevision: number, archivedAt = Date.now()): WorkflowStoreWrite {
    return transaction(this.db, () => {
      const current = this.getWorkflowInTransaction(id);
      if (!current) return { ok: false, reason: "not_found", current: null };
      if (current.archivedAt !== null) return { ok: false, reason: "archived", current };
      if (current.draftRevision !== expectedDraftRevision) {
        return { ok: false, reason: "revision_conflict", current };
      }
      const active = this.db.prepare(
        `SELECT 1 FROM workflow_bindings b
           JOIN workflow_versions v ON v.id = b.workflow_version_id
          WHERE v.workflow_id = ? AND b.state = 'active' LIMIT 1`,
      ).get(id);
      if (active) return { ok: false, reason: "active_binding", current };
      this.db.prepare(
        `UPDATE workflow_definitions
            SET archived_at = ?, updated_at = ?, draft_revision = draft_revision + 1
          WHERE id = ? AND draft_revision = ? AND archived_at IS NULL`,
      ).run(archivedAt, archivedAt, id, expectedDraftRevision);
      return { ok: true, workflow: this.mustWorkflow(id) };
    });
  }

  listWorkflowVersions(workflowId: string): WorkflowVersion[] {
    const rows = this.db.prepare(
      `SELECT * FROM workflow_versions WHERE workflow_id = ? ORDER BY version DESC`,
    ).all(workflowId) as unknown[];
    const out: WorkflowVersion[] = [];
    for (const row of rows) {
      try { out.push(parseWorkflowVersionRow(row)); } catch (error) { diagnose(error); }
    }
    return out;
  }

  listWorkflowVersionMetadata(workflowId: string): WorkflowVersionMetadata[] {
    const rows = this.db.prepare(
      `SELECT id, workflow_id, version, source_draft_revision,
              completion_policy_json, binding_defaults_json, published_at
         FROM workflow_versions WHERE workflow_id = ? ORDER BY version DESC`,
    ).all(workflowId) as unknown[];
    const out: WorkflowVersionMetadata[] = [];
    for (const row of rows) {
      try { out.push(parseWorkflowVersionMetadataRow(row)); } catch (error) { diagnose(error); }
    }
    return out;
  }

  getWorkflowVersion(workflowId: string, version: number): WorkflowVersion | null {
    const row = this.db.prepare(
      `SELECT * FROM workflow_versions WHERE workflow_id = ? AND version = ?`,
    ).get(workflowId, version);
    if (!row) return null;
    try { return parseWorkflowVersionRow(row); } catch (error) { diagnose(error); return null; }
  }

  publishWorkflow(
    id: string,
    expectedDraftRevision: number,
    versionId: string,
    publishedAt = Date.now(),
  ): WorkflowPublishWrite {
    return transaction(this.db, () => {
      const existing = this.db.prepare(
        `SELECT * FROM workflow_versions WHERE workflow_id = ? AND source_draft_revision = ?`,
      ).get(id, expectedDraftRevision);
      if (existing) {
        const version = parseWorkflowVersionRow(existing);
        return { ok: true, workflow: this.mustWorkflow(id), version, idempotent: true };
      }
      const workflow = this.getWorkflowInTransaction(id);
      if (!workflow) return { ok: false, reason: "not_found", current: null };
      if (workflow.archivedAt !== null) return { ok: false, reason: "archived", current: workflow };
      if (workflow.draftRevision !== expectedDraftRevision) {
        return { ok: false, reason: "revision_conflict", current: workflow };
      }
      const personas = this.listPersonasInTransaction(true);
      const validation = validateWorkflowGraph({
        graph: workflow.draft,
        personas,
        completionPolicy: workflow.completionPolicy,
      });
      if (!validation.valid) {
        return { ok: false, reason: "validation", current: workflow, diagnostics: validation.diagnostics };
      }
      const personaMap = new Map(personas.map((persona) => [persona.id, persona]));
      const graph = {
        nodes: workflow.draft.nodes.map((node) => {
          if (node.kind !== "persona") return node;
          const persona = personaMap.get(node.personaId);
          if (!persona || persona.archivedAt !== null) {
            throw new Error(`validated Persona ${node.personaId} disappeared during Publish`);
          }
          return {
            id: node.id,
            kind: "persona" as const,
            position: node.position,
            persona: {
              sourcePersonaId: persona.id,
              sourceRevision: persona.revision,
              name: persona.name,
              description: persona.description,
              guidanceMarkdown: persona.guidanceMarkdown,
              runner: persona.runner,
              model: persona.model,
            },
          };
        }),
        edges: workflow.draft.edges,
      };
      const next = Number((this.db.prepare(
        `SELECT COALESCE(MAX(version), 0) AS value FROM workflow_versions WHERE workflow_id = ?`,
      ).get(id) as { value: number }).value) + 1;
      this.db.prepare(
        `INSERT INTO workflow_versions (
           id, workflow_id, version, source_draft_revision, graph_json,
           completion_policy_json, binding_defaults_json, published_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        versionId,
        id,
        next,
        expectedDraftRevision,
        JSON.stringify(graph),
        JSON.stringify(workflow.completionPolicy),
        JSON.stringify(workflow.bindingDefaults),
        publishedAt,
      );
      this.db.prepare(
        `UPDATE workflow_definitions SET current_version_id = ?, updated_at = ? WHERE id = ?`,
      ).run(versionId, publishedAt, id);
      return {
        ok: true,
        workflow: this.mustWorkflow(id),
        version: this.mustWorkflowVersion(id, next),
        idempotent: false,
      };
    });
  }

  summary(workflow: WorkflowDefinition): WorkflowSummary {
    const validation = validateWorkflowGraph({
      graph: workflow.draft,
      personas: this.listPersonas(true),
      completionPolicy: workflow.completionPolicy,
    });
    const current = workflow.currentVersionId === null
      ? null
      : this.db.prepare(`SELECT version FROM workflow_versions WHERE id = ?`).get(workflow.currentVersionId) as { version: number } | undefined;
    return {
      id: workflow.id,
      name: workflow.name,
      description: workflow.description,
      draftRevision: workflow.draftRevision,
      currentVersionId: workflow.currentVersionId,
      publishedVersion: current?.version ?? null,
      archivedAt: workflow.archivedAt,
      updatedAt: workflow.updatedAt,
      errorCount: validation.diagnostics.filter((item) => item.severity === "error").length,
      warningCount: validation.diagnostics.filter((item) => item.severity === "warning").length,
      nodeCount: workflow.draft.nodes.length,
      personaCount: workflow.draft.nodes.filter((node) => node.kind === "persona").length,
    };
  }

  getWorkflowVersionById(id: string): WorkflowVersion | null {
    const row = this.db.prepare(`SELECT * FROM workflow_versions WHERE id = ?`).get(id);
    if (!row) return null;
    try { return parseWorkflowVersionRow(row); } catch (error) { diagnose(error); return null; }
  }

  listBindings(includeArchived = false): WorkflowBinding[] {
    const rows = this.db.prepare(
      `SELECT * FROM workflow_bindings
        ${includeArchived ? "" : "WHERE state <> 'archived'"}
        ORDER BY updated_at DESC, id ASC`,
    ).all() as unknown[];
    return rows.flatMap((row) => {
      try { return [parseWorkflowBindingRow(row)]; } catch (error) { diagnose(error); return []; }
    });
  }

  getBinding(id: string): WorkflowBinding | null {
    const row = this.db.prepare(`SELECT * FROM workflow_bindings WHERE id = ?`).get(id);
    if (!row) return null;
    try { return parseWorkflowBindingRow(row); } catch (error) { diagnose(error); return null; }
  }

  activeBindingForNote(noteKey: string): WorkflowBinding | null {
    const row = this.db.prepare(
      `SELECT * FROM workflow_bindings WHERE note_key = ? AND state = 'active'`,
    ).get(noteKey);
    return row ? parseWorkflowBindingRow(row) : null;
  }

  insertBinding(input: WorkflowBindingInsert): WorkflowBinding {
    this.db.prepare(
      `INSERT INTO workflow_bindings (
         id, workflow_version_id, note_key, session_id, session_agent, session_name,
         session_cwd, session_repo_root, trigger_mode, delivery_mode, state,
         max_repair_rounds, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    ).run(
      input.id,
      input.workflowVersionId,
      input.noteKey,
      input.sessionId,
      input.sessionAgent,
      input.sessionName,
      input.sessionCwd,
      input.sessionRepoRoot,
      input.triggerMode,
      input.deliveryMode,
      input.maxRepairRounds,
      input.now,
      input.now,
    );
    const binding = this.getBinding(input.id);
    if (!binding) throw new Error(`Workflow binding ${input.id} disappeared after insert`);
    return binding;
  }

  updateBinding(
    id: string,
    patch: Partial<Pick<WorkflowBinding, "triggerMode" | "deliveryMode" | "state" | "maxRepairRounds">>,
    now = Date.now(),
  ): WorkflowBinding | null {
    const assignments: string[] = [];
    const values: Array<string | number> = [];
    if (patch.triggerMode !== undefined) { assignments.push("trigger_mode = ?"); values.push(patch.triggerMode); }
    if (patch.deliveryMode !== undefined) { assignments.push("delivery_mode = ?"); values.push(patch.deliveryMode); }
    if (patch.state !== undefined) { assignments.push("state = ?"); values.push(patch.state); }
    if (patch.maxRepairRounds !== undefined) {
      assignments.push("max_repair_rounds = ?");
      values.push(patch.maxRepairRounds);
    }
    if (assignments.length === 0) return this.getBinding(id);
    assignments.push("updated_at = ?");
    values.push(now, id);
    this.db.prepare(`UPDATE workflow_bindings SET ${assignments.join(", ")} WHERE id = ?`).run(...values);
    return this.getBinding(id);
  }

  reattachBinding(
    id: string,
    input: Pick<WorkflowBindingInsert, "noteKey" | "sessionId" | "sessionAgent" | "sessionName" | "sessionCwd" | "sessionRepoRoot">,
    now = Date.now(),
  ): WorkflowBinding | null {
    this.db.prepare(
      `UPDATE workflow_bindings
          SET note_key = ?, session_id = ?, session_agent = ?, session_name = ?,
              session_cwd = ?, session_repo_root = ?, state = 'active', updated_at = ?
        WHERE id = ? AND state <> 'archived'`,
    ).run(
      input.noteKey,
      input.sessionId,
      input.sessionAgent,
      input.sessionName,
      input.sessionCwd,
      input.sessionRepoRoot,
      now,
      id,
    );
    return this.getBinding(id);
  }

  getRun(id: string): WorkflowRun | null {
    const row = this.db.prepare(`SELECT * FROM workflow_runs WHERE id = ?`).get(id);
    if (!row) return null;
    try { return parseWorkflowRunRow(row); } catch (error) { diagnose(error); return null; }
  }

  activeRunForBinding(bindingId: string): WorkflowRun | null {
    const row = this.db.prepare(
      `SELECT * FROM workflow_runs
        WHERE binding_id = ? AND status NOT IN ('completed', 'cancelled', 'failed')
        ORDER BY started_at DESC LIMIT 1`,
    ).get(bindingId);
    return row ? parseWorkflowRunRow(row) : null;
  }

  latestRunForBinding(bindingId: string): WorkflowRun | null {
    const row = this.db.prepare(
      `SELECT * FROM workflow_runs WHERE binding_id = ? ORDER BY started_at DESC, id DESC LIMIT 1`,
    ).get(bindingId);
    return row ? parseWorkflowRunRow(row) : null;
  }

  listRuns(): WorkflowRun[] {
    const rows = this.db.prepare(`SELECT * FROM workflow_runs ORDER BY updated_at DESC`).all() as unknown[];
    return rows.flatMap((row) => {
      try { return [parseWorkflowRunRow(row)]; } catch (error) { diagnose(error); return []; }
    });
  }

  listRunSummaries(): WorkflowRunSummary[] {
    const rows = this.db.prepare(
      `SELECT r.*, b.note_key, b.session_id,
              d.id AS workflow_id, d.name AS workflow_name, v.version AS workflow_version,
              COALESCE(MAX(s.round), 0) AS current_round
         FROM workflow_runs r
         JOIN workflow_bindings b ON b.id = r.binding_id
         LEFT JOIN workflow_versions v ON v.id = r.workflow_version_id
         LEFT JOIN workflow_definitions d ON d.id = v.workflow_id
         LEFT JOIN workflow_submissions s ON s.run_id = r.id
        GROUP BY r.id
        ORDER BY r.updated_at DESC, r.id ASC`,
    ).all() as unknown as Array<Record<string, unknown>>;
    return rows.flatMap((row) => {
      const summary = this.runSummaryFromRow(row);
      return summary ? [summary] : [];
    });
  }

  runSummary(id: string): WorkflowRunSummary | null {
    const row = this.db.prepare(
      `SELECT r.*, b.note_key, b.session_id,
              d.id AS workflow_id, d.name AS workflow_name, v.version AS workflow_version,
              COALESCE(MAX(s.round), 0) AS current_round
         FROM workflow_runs r
         JOIN workflow_bindings b ON b.id = r.binding_id
         LEFT JOIN workflow_versions v ON v.id = r.workflow_version_id
         LEFT JOIN workflow_definitions d ON d.id = v.workflow_id
         LEFT JOIN workflow_submissions s ON s.run_id = r.id
        WHERE r.id = ?
        GROUP BY r.id`,
    ).get(id) as Record<string, unknown> | undefined;
    return row ? this.runSummaryFromRow(row) : null;
  }

  private runSummaryFromRow(row: Record<string, unknown>): WorkflowRunSummary | null {
    try {
      const run = parseWorkflowRunRow(row);
      const submission = this.latestSubmission(run.id);
      const latestAttempts = new Map<string, WorkflowNodeAttempt>();
      if (submission) {
        for (const attempt of this.listAttempts(submission.id)) {
          latestAttempts.set(attempt.nodeId, attempt);
        }
      }
      const attempts = [...latestAttempts.values()];
      return {
        id: run.id,
        bindingId: run.bindingId,
        workflowId: typeof row.workflow_id === "string"
          ? row.workflow_id
          : `missing:${run.workflowVersionId}`,
        workflowName: typeof row.workflow_name === "string"
          ? row.workflow_name
          : "Missing workflow version",
        workflowVersion: Number(row.workflow_version ?? 0),
        sessionId: typeof row.session_id === "string" ? row.session_id : null,
        noteKey: String(row.note_key),
        status: run.status,
        phase: run.currentPhase,
        round: Number(row.current_round),
        maxRepairRounds: run.maxRepairRounds,
        activePersonaNames: attempts.flatMap((attempt) =>
          attempt.persona && ["queued", "running", "retry_wait"].includes(attempt.state)
            ? [attempt.persona.name]
            : []),
        failedPersonaCount: attempts.filter((attempt) => {
          const verdict = attempt.verdict;
          return Boolean(
            verdict
            && !Array.isArray(verdict)
            && typeof verdict === "object"
            && verdict.verdict === "fail",
          );
        }).length,
        bypassedPersonaReview: false,
        updatedAt: run.updatedAt,
      };
    } catch (error) {
      diagnose(error);
      return null;
    }
  }

  getSubmission(id: string): WorkflowSubmission | null {
    const row = this.db.prepare(`SELECT * FROM workflow_submissions WHERE id = ?`).get(id);
    return row ? parseWorkflowSubmissionRow(row) : null;
  }

  submissionByTrigger(triggerKey: string): WorkflowSubmission | null {
    const row = this.db.prepare(
      `SELECT * FROM workflow_submissions WHERE trigger_key = ?`,
    ).get(triggerKey);
    return row ? parseWorkflowSubmissionRow(row) : null;
  }

  listSubmissions(runId: string): WorkflowSubmission[] {
    return (this.db.prepare(
      `SELECT * FROM workflow_submissions WHERE run_id = ? ORDER BY round ASC`,
    ).all(runId) as unknown[]).map(parseWorkflowSubmissionRow);
  }

  latestSubmission(runId: string): WorkflowSubmission | null {
    const row = this.db.prepare(
      `SELECT * FROM workflow_submissions WHERE run_id = ? ORDER BY round DESC LIMIT 1`,
    ).get(runId);
    return row ? parseWorkflowSubmissionRow(row) : null;
  }

  createInitialSubmission(
    run: WorkflowRunInsert,
    submission: Omit<WorkflowSubmissionInsert, "runId" | "round">,
  ): { run: WorkflowRun; submission: WorkflowSubmission; idempotent: boolean } {
    return transaction(this.db, () => {
      const existing = this.submissionByTrigger(submission.triggerKey);
      if (existing) {
        const existingRun = this.getRun(existing.runId);
        if (!existingRun) throw new Error(`Workflow run ${existing.runId} is missing`);
        return { run: existingRun, submission: existing, idempotent: true };
      }
      this.db.prepare(
        `INSERT INTO workflow_runs (
           id, binding_id, workflow_version_id, status, current_phase, max_repair_rounds,
           trigger_source, trigger_key, inspector_pr_key, inspector_head_sha,
           gate_state_json, started_at, updated_at, completed_at
         ) VALUES (?, ?, ?, 'capturing', 'capturing', ?, ?, ?, NULL, NULL, NULL, ?, ?, NULL)`,
      ).run(
        run.id,
        run.binding.id,
        run.binding.workflowVersionId,
        run.binding.maxRepairRounds,
        run.triggerSource ?? "manual",
        run.triggerKey,
        run.now,
        run.now,
      );
      this.insertSubmissionInTransaction({
        ...submission,
        runId: run.id,
        round: 1,
        triggerSource: run.triggerSource ?? "manual",
      });
      this.appendEvent(run.id, "run_created", {
        submissionId: submission.id,
        triggerKey: submission.triggerKey,
        round: 1,
      }, run.now);
      return {
        run: this.mustRun(run.id),
        submission: this.mustSubmission(submission.id),
        idempotent: false,
      };
    });
  }

  createRepairSubmission(
    input: WorkflowSubmissionInsert,
  ): { run: WorkflowRun; submission: WorkflowSubmission; idempotent: boolean } {
    return transaction(this.db, () => {
      const existing = this.submissionByTrigger(input.triggerKey);
      if (existing) {
        return { run: this.mustRun(existing.runId), submission: existing, idempotent: true };
      }
      this.insertSubmissionInTransaction(input);
      this.db.prepare(
        `UPDATE workflow_runs
            SET status = 'capturing', current_phase = 'capturing', gate_state_json = NULL,
                updated_at = ?, completed_at = NULL
          WHERE id = ?`,
      ).run(input.now, input.runId);
      this.appendEvent(input.runId, "submission_created", {
        submissionId: input.id,
        triggerKey: input.triggerKey,
        round: input.round,
      }, input.now);
      return {
        run: this.mustRun(input.runId),
        submission: this.mustSubmission(input.id),
        idempotent: false,
      };
    });
  }

  /**
   * Claim one Foreman proof and retire its matching once-only guard atomically.
   * The worker never supplies durable workflow identity; the manager resolves the binding first.
   */
  claimForemanCompletion(input: ForemanCompletionStoreInput): ForemanCompletionStoreResult {
    return transaction(this.db, () => {
      const triggerKey =
        `foreman:${input.binding.id}:${input.completionKind}:${input.marker}`;
      const duplicateEvent = this.db.prepare(
        `SELECT run_id, payload_json FROM workflow_events
          WHERE event_kind = 'workflow_completion_claimed'
            AND json_extract(payload_json, '$.triggerKey') = ?
          ORDER BY id ASC LIMIT 1`,
      ).get(triggerKey) as { run_id: string; payload_json: string } | undefined;
      if (duplicateEvent) {
        const run = this.mustRun(duplicateEvent.run_id);
        const submission = this.submissionByTrigger(triggerKey);
        return {
          result: {
            claimed: true,
            runId: run.id,
            submissionId: submission?.id ?? null,
            state: "already_claimed",
          },
          run,
          submission,
          created: false,
          previousFingerprint: undefined,
        };
      }

      let run = this.latestRunForBinding(input.binding.id);
      let submission: WorkflowSubmission | null = null;
      let state: ForemanCompletionStoreResult["result"]["state"] = "blocked";
      let created = false;
      let previousFingerprint: string | undefined;

      if (!run) {
        this.db.prepare(
          `INSERT INTO workflow_runs (
             id, binding_id, workflow_version_id, status, current_phase, max_repair_rounds,
             trigger_source, trigger_key, inspector_pr_key, inspector_head_sha,
             gate_state_json, started_at, updated_at, completed_at
           ) VALUES (?, ?, ?, 'capturing', 'capturing', ?, 'foreman', ?, NULL, NULL, NULL, ?, ?, NULL)`,
        ).run(
          input.runId,
          input.binding.id,
          input.binding.workflowVersionId,
          input.binding.maxRepairRounds,
          triggerKey,
          input.now,
          input.now,
        );
        this.insertSubmissionInTransaction({
          id: input.submissionId,
          runId: input.runId,
          round: 1,
          triggerSource: "foreman",
          triggerKey,
          context: {},
          evidence: {},
          now: input.now,
        });
        run = this.mustRun(input.runId);
        submission = this.mustSubmission(input.submissionId);
        state = "started";
        created = true;
      } else if (run.status === "waiting_for_session") {
        const latest = this.latestSubmission(run.id);
        if (latest && latest.round <= run.maxRepairRounds) {
          previousFingerprint = latest.evidenceFingerprint;
          this.insertSubmissionInTransaction({
            id: input.submissionId,
            runId: run.id,
            round: latest.round + 1,
            triggerSource: "foreman",
            triggerKey,
            context: {},
            evidence: {},
            now: input.now,
          });
          this.db.prepare(
            `UPDATE workflow_runs
                SET status = 'capturing', current_phase = 'capturing',
                    gate_state_json = NULL, updated_at = ?, completed_at = NULL
              WHERE id = ?`,
          ).run(input.now, run.id);
          run = this.mustRun(run.id);
          submission = this.mustSubmission(input.submissionId);
          state = "resubmitted";
          created = true;
        } else {
          this.setRunState(run.id, "blocked", "round_limit", {
            maxRepairRounds: run.maxRepairRounds,
          }, input.now);
          run = this.mustRun(run.id);
        }
      } else if (run.status === "capturing" || run.status === "running") {
        submission = this.latestSubmission(run.id);
        state = "already_claimed";
      } else {
        this.appendEvent(run.id, "workflow_completion_blocked", {
          triggerKey,
          completionKind: input.completionKind,
          marker: input.marker,
          runStatus: run.status,
          phase: run.currentPhase,
        }, input.now);
      }

      const retired = input.completionKind === "drain"
        ? this.retireDrainGuard(input.binding.noteKey, `workflow:${run.id}`, input.now)
        : this.retirePromptedGuard(input.binding, input.currentGoal, input.now);
      if (!retired) {
        throw new Error(`Foreman ${input.completionKind} completion guard is no longer armed`);
      }
      this.appendEvent(run.id, "workflow_completion_claimed", {
        triggerKey,
        completionKind: input.completionKind,
        marker: input.marker,
        summary: input.summary,
        evidenceFingerprint: input.evidenceFingerprint,
        state,
        submissionId: submission?.id ?? null,
      }, input.now);
      return {
        result: {
          claimed: true,
          runId: run.id,
          submissionId: submission?.id ?? null,
          state,
        },
        run,
        submission,
        created,
        previousFingerprint,
      };
    });
  }

  updateSubmissionCapture(
    id: string,
    input: {
      context: WorkflowJson;
      evidence: WorkflowJson;
      fingerprint?: string;
      status?: WorkflowSubmission["status"];
    },
    now = Date.now(),
  ): WorkflowSubmission {
    const current = this.mustSubmission(id);
    this.db.prepare(
      `UPDATE workflow_submissions
          SET context_json = ?, evidence_json = ?, evidence_fingerprint = ?,
              status = ?, updated_at = ?
        WHERE id = ?`,
    ).run(
      JSON.stringify(input.context),
      JSON.stringify(input.evidence),
      input.fingerprint ?? current.evidenceFingerprint,
      input.status ?? current.status,
      now,
      id,
    );
    return this.mustSubmission(id);
  }

  setRunState(
    id: string,
    status: WorkflowRun["status"],
    currentPhase: string,
    gateState: WorkflowJson | null = null,
    now = Date.now(),
  ): WorkflowRun {
    const terminal = ["completed", "cancelled", "failed"].includes(status);
    this.db.prepare(
      `UPDATE workflow_runs
          SET status = ?, current_phase = ?, gate_state_json = ?, updated_at = ?,
              completed_at = CASE WHEN ? THEN COALESCE(completed_at, ?) ELSE NULL END
        WHERE id = ?`,
    ).run(status, currentPhase, gateState === null ? null : JSON.stringify(gateState), now, terminal ? 1 : 0, now, id);
    return this.mustRun(id);
  }

  setSubmissionState(
    id: string,
    status: WorkflowSubmission["status"],
    now = Date.now(),
  ): WorkflowSubmission {
    const terminal = ["completed", "cancelled", "failed"].includes(status);
    this.db.prepare(
      `UPDATE workflow_submissions SET status = ?, updated_at = ?,
              completed_at = CASE WHEN ? THEN COALESCE(completed_at, ?) ELSE NULL END
        WHERE id = ?`,
    ).run(status, now, terminal ? 1 : 0, now, id);
    return this.mustSubmission(id);
  }

  insertAttempt(input: WorkflowAttemptInsert): WorkflowNodeAttempt {
    this.db.prepare(
      `INSERT OR IGNORE INTO workflow_node_attempts (
         id, submission_id, node_id, attempt, state, persona_snapshot_json, runner_id,
         model_id, verdict_json, output_json, retry_at, input_fingerprint, error,
         created_at, updated_at, started_at, finished_at
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, NULL, NULL)`,
    ).run(
      input.id,
      input.submissionId,
      input.nodeId,
      input.attempt,
      input.state,
      input.persona === null ? null : JSON.stringify(input.persona),
      input.retryAt ?? null,
      input.inputFingerprint,
      input.error ?? null,
      input.now,
      input.now,
    );
    const attempt = this.attemptForNode(input.submissionId, input.nodeId, input.attempt);
    if (!attempt) throw new Error(`Workflow attempt ${input.id} disappeared after insert`);
    return attempt;
  }

  getAttempt(id: string): WorkflowNodeAttempt | null {
    const row = this.db.prepare(`SELECT * FROM workflow_node_attempts WHERE id = ?`).get(id);
    return row ? parseWorkflowNodeAttemptRow(row) : null;
  }

  attemptForNode(submissionId: string, nodeId: string, attempt: number): WorkflowNodeAttempt | null {
    const row = this.db.prepare(
      `SELECT * FROM workflow_node_attempts
        WHERE submission_id = ? AND node_id = ? AND attempt = ?`,
    ).get(submissionId, nodeId, attempt);
    return row ? parseWorkflowNodeAttemptRow(row) : null;
  }

  latestAttemptForNode(submissionId: string, nodeId: string): WorkflowNodeAttempt | null {
    const row = this.db.prepare(
      `SELECT * FROM workflow_node_attempts
        WHERE submission_id = ? AND node_id = ? ORDER BY attempt DESC LIMIT 1`,
    ).get(submissionId, nodeId);
    return row ? parseWorkflowNodeAttemptRow(row) : null;
  }

  listAttempts(submissionId: string): WorkflowNodeAttempt[] {
    return (this.db.prepare(
      `SELECT * FROM workflow_node_attempts
        WHERE submission_id = ? ORDER BY created_at ASC, node_id ASC, attempt ASC`,
    ).all(submissionId) as unknown[]).map(parseWorkflowNodeAttemptRow);
  }

  listRunnableAttempts(now = Date.now()): WorkflowNodeAttempt[] {
    return (this.db.prepare(
      `SELECT a.* FROM workflow_node_attempts a
         JOIN workflow_submissions s ON s.id = a.submission_id
         JOIN workflow_runs r ON r.id = s.run_id
        WHERE a.state IN ('queued', 'retry_wait')
          AND (a.retry_at IS NULL OR a.retry_at <= ?)
          AND s.status = 'running' AND r.status = 'running'
        ORDER BY a.created_at ASC, a.id ASC`,
    ).all(now) as unknown[]).map(parseWorkflowNodeAttemptRow);
  }

  listAttemptsDueAfter(now = Date.now()): number | null {
    const row = this.db.prepare(
      `SELECT MIN(a.retry_at) AS retry_at FROM workflow_node_attempts a
         JOIN workflow_submissions s ON s.id = a.submission_id
         JOIN workflow_runs r ON r.id = s.run_id
        WHERE a.state = 'retry_wait' AND a.retry_at > ?
          AND s.status = 'running' AND r.status = 'running'`,
    ).get(now) as { retry_at: number | null } | undefined;
    return row?.retry_at ?? null;
  }

  claimAttempt(
    id: string,
    runner: LlmRunnerId,
    model: string,
    now = Date.now(),
  ): WorkflowNodeAttempt | null {
    const result = this.db.prepare(
      `UPDATE workflow_node_attempts
          SET state = 'running', runner_id = ?, model_id = ?, started_at = ?,
              updated_at = ?, retry_at = NULL
        WHERE id = ? AND state IN ('queued', 'retry_wait')`,
    ).run(runner, model, now, now, id);
    return Number(result.changes) === 1 ? this.getAttempt(id) : null;
  }

  finishAttempt(
    id: string,
    input: {
      state: WorkflowNodeAttempt["state"];
      verdict?: WorkflowJson | null;
      output?: WorkflowJson | null;
      error?: string | null;
      retryAt?: number | null;
    },
    now = Date.now(),
  ): WorkflowNodeAttempt {
    this.db.prepare(
      `UPDATE workflow_node_attempts
          SET state = ?, verdict_json = ?, output_json = ?, error = ?, retry_at = ?,
              updated_at = ?, finished_at = ?
        WHERE id = ?`,
    ).run(
      input.state,
      input.verdict === undefined || input.verdict === null ? null : JSON.stringify(input.verdict),
      input.output === undefined || input.output === null ? null : JSON.stringify(input.output),
      input.error ?? null,
      input.retryAt ?? null,
      now,
      input.state === "retry_wait" ? null : now,
      id,
    );
    const attempt = this.getAttempt(id);
    if (!attempt) throw new Error(`Workflow attempt ${id} disappeared after update`);
    return attempt;
  }

  finishAttemptWithReceipts(
    id: string,
    input: {
      verdict: WorkflowJson;
      output: WorkflowJson;
      receipts: Array<{ edgeId: string; payload: WorkflowJson }>;
    },
    now = Date.now(),
  ): WorkflowNodeAttempt {
    return transaction(this.db, () => {
      const attempt = this.finishAttempt(id, {
        state: "completed",
        verdict: input.verdict,
        output: input.output,
        error: null,
      }, now);
      for (const receipt of input.receipts) {
        this.addReceipt(
          attempt.submissionId,
          receipt.edgeId,
          attempt.id,
          receipt.payload,
          now,
        );
      }
      return attempt;
    });
  }

  manualInfrastructureRetry(
    runId: string,
    submissionId: string,
    failed: WorkflowNodeAttempt,
    requestId: string,
    attemptId: string,
    now = Date.now(),
  ): { run: WorkflowRun; submission: WorkflowSubmission; idempotent: boolean } {
    return transaction(this.db, () => {
      const existing = this.listEvents(runId).find((event) =>
        event.kind === "manual_infrastructure_retry"
        && event.payload
        && !Array.isArray(event.payload)
        && typeof event.payload === "object"
        && event.payload.requestId === requestId);
      if (existing) {
        return {
          run: this.mustRun(runId),
          submission: this.mustSubmission(submissionId),
          idempotent: true,
        };
      }
      const latest = this.latestAttemptForNode(submissionId, failed.nodeId);
      if (!latest || latest.state !== "error") {
        throw new Error(`Workflow node ${failed.nodeId} has no latest infrastructure failure`);
      }
      const latestByNode = new Map<string, WorkflowNodeAttempt>();
      for (const attempt of this.listAttempts(submissionId)) {
        const current = latestByNode.get(attempt.nodeId);
        if (!current || attempt.attempt > current.attempt) {
          latestByNode.set(attempt.nodeId, attempt);
        }
      }
      const errored = [...latestByNode.values()].filter((attempt) => attempt.state === "error");
      for (const attempt of errored) {
        this.insertAttempt({
          id: attempt.nodeId === latest.nodeId ? attemptId : randomUUID(),
          submissionId,
          nodeId: attempt.nodeId,
          attempt: attempt.attempt + 1,
          state: "queued",
          persona: attempt.persona,
          inputFingerprint: attempt.inputFingerprint,
          now,
        });
      }
      this.setSubmissionState(submissionId, "running", now);
      this.setRunState(runId, "running", "persona_review", null, now);
      this.appendEvent(runId, "manual_infrastructure_retry", {
        requestId,
        nodeAttemptId: latest.id,
        reactivatedNodeAttemptIds: errored.map((attempt) => attempt.id),
      }, now);
      return {
        run: this.mustRun(runId),
        submission: this.mustSubmission(submissionId),
        idempotent: false,
      };
    });
  }

  addReceipt(
    submissionId: string,
    edgeId: string,
    sourceAttemptId: string,
    payload: WorkflowJson,
    now = Date.now(),
  ): boolean {
    const result = this.db.prepare(
      `INSERT OR IGNORE INTO workflow_edge_receipts (
         submission_id, edge_id, source_attempt_id, payload_json, created_at
       ) VALUES (?, ?, ?, ?, ?)`,
    ).run(submissionId, edgeId, sourceAttemptId, JSON.stringify(payload), now);
    return Number(result.changes) === 1;
  }

  listReceipts(submissionId: string): WorkflowEdgeReceipt[] {
    return (this.db.prepare(
      `SELECT * FROM workflow_edge_receipts WHERE submission_id = ? ORDER BY id ASC`,
    ).all(submissionId) as unknown[]).map(parseWorkflowEdgeReceiptRow);
  }

  getDelivery(id: string): WorkflowDelivery | null {
    const row = this.db.prepare(`SELECT * FROM workflow_deliveries WHERE id = ?`).get(id);
    return row ? parseWorkflowDeliveryRow(row) : null;
  }

  deliveryForPacket(
    submissionId: string,
    kind: WorkflowDelivery["kind"],
    payloadSha256: string,
  ): WorkflowDelivery | null {
    const row = this.db.prepare(
      `SELECT * FROM workflow_deliveries
        WHERE submission_id = ? AND kind = ? AND payload_sha256 = ?`,
    ).get(submissionId, kind, payloadSha256);
    return row ? parseWorkflowDeliveryRow(row) : null;
  }

  listDeliveries(runId: string): WorkflowDelivery[] {
    return (this.db.prepare(
      `SELECT * FROM workflow_deliveries WHERE run_id = ? ORDER BY created_at ASC, id ASC`,
    ).all(runId) as unknown[]).map(parseWorkflowDeliveryRow);
  }

  listDeliveriesByState(state: WorkflowDelivery["state"]): WorkflowDelivery[] {
    return (this.db.prepare(
      `SELECT * FROM workflow_deliveries WHERE state = ? ORDER BY created_at ASC, id ASC`,
    ).all(state) as unknown[]).map(parseWorkflowDeliveryRow);
  }

  prepareDelivery(
    input: Pick<
      WorkflowDelivery,
      "id" | "runId" | "submissionId" | "kind" | "sessionId" | "noteKey" | "payload" | "payloadSha256"
    >,
    now = Date.now(),
  ): { delivery: WorkflowDelivery; idempotent: boolean } {
    return transaction(this.db, () => {
      const existing = this.deliveryForPacket(input.submissionId, input.kind, input.payloadSha256);
      if (existing) return { delivery: existing, idempotent: true };
      this.db.prepare(
        `INSERT INTO workflow_deliveries (
           id, run_id, submission_id, kind, session_id, note_key, payload, payload_sha256,
           state, error, created_at, updated_at, delivered_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'prepared', NULL, ?, ?, NULL)`,
      ).run(
        input.id,
        input.runId,
        input.submissionId,
        input.kind,
        input.sessionId,
        input.noteKey,
        input.payload,
        input.payloadSha256,
        now,
        now,
      );
      return { delivery: this.mustDelivery(input.id), idempotent: false };
    });
  }

  /**
   * Own the only automatic transition across the terminal-write boundary.
   * Refused packets may be explicitly reclaimed; uncertain/delivered packets never can.
   */
  claimDeliverySend(id: string, allowRefused = false, now = Date.now()): WorkflowDelivery | null {
    return transaction(this.db, () => {
      const delivery = this.getDelivery(id);
      if (!delivery) return null;
      const eligible = delivery.state === "prepared" || (allowRefused && delivery.state === "refused");
      if (!eligible) return null;
      const sibling = this.db.prepare(
        `SELECT id FROM workflow_deliveries
          WHERE submission_id = ? AND kind = ? AND id <> ?
            AND state IN ('sending', 'delivered')
          LIMIT 1`,
      ).get(delivery.submissionId, delivery.kind, delivery.id);
      if (sibling) return null;
      const result = this.db.prepare(
        `UPDATE workflow_deliveries
            SET state = 'sending', error = NULL, updated_at = ?
          WHERE id = ? AND state = ?`,
      ).run(now, id, delivery.state);
      return Number(result.changes) === 1 ? this.mustDelivery(id) : null;
    });
  }

  setDeliveryState(
    id: string,
    state: WorkflowDelivery["state"],
    error: string | null,
    now = Date.now(),
  ): WorkflowDelivery | null {
    const result = this.db.prepare(
      `UPDATE workflow_deliveries
          SET state = ?, error = ?, updated_at = ?,
              delivered_at = CASE WHEN ? = 'delivered'
                                  THEN COALESCE(delivered_at, ?) ELSE delivered_at END
        WHERE id = ?`,
    ).run(state, error, now, state, now, id);
    return Number(result.changes) === 1 ? this.getDelivery(id) : null;
  }

  finishDeliverySend(
    id: string,
    state: Extract<WorkflowDelivery["state"], "refused" | "uncertain">,
    error: string | null,
    now = Date.now(),
  ): WorkflowDelivery | null {
    const result = this.db.prepare(
      `UPDATE workflow_deliveries
          SET state = ?, error = ?, updated_at = ?
        WHERE id = ? AND state = 'sending'`,
    ).run(state, error, now, id);
    return Number(result.changes) === 1 ? this.getDelivery(id) : null;
  }

  confirmDeliverySend(
    id: string,
    transcriptAnchor: number | null,
    submitVerified: boolean,
    now = Date.now(),
  ): { delivery: WorkflowDelivery; rearmedDrain: boolean } | null {
    return transaction(this.db, () => {
      const delivery = this.getDelivery(id);
      if (!delivery || delivery.state !== "sending") return null;
      const changed = this.db.prepare(
        `UPDATE workflow_deliveries
            SET state = 'delivered', error = NULL, updated_at = ?, delivered_at = ?
          WHERE id = ? AND state = 'sending'`,
      ).run(now, now, id);
      if (Number(changed.changes) !== 1) return null;
      this.setRunState(delivery.runId, "waiting_for_session", "persona_feedback", {
        deliveryId: delivery.id,
        transcriptAnchor,
      }, now);
      this.appendEvent(delivery.runId, "delivery_delivered", {
        deliveryId: delivery.id,
        transcriptAnchor,
        submitVerified,
      }, now);
      const rearmedDrain = this.rearmDrainCompletionForDelivery(delivery, now);
      if (rearmedDrain) {
        this.appendEvent(delivery.runId, "foreman_completion_rearmed", {
          deliveryId: delivery.id,
          completionKind: "drain",
        }, now);
      }
      return { delivery: this.mustDelivery(id), rearmedDrain };
    });
  }

  /**
   * A daemon that stopped with a row in `sending` cannot know whether the paste landed.
   * Convert all of them before any ready graph work is recovered.
   */
  recoverSendingDeliveries(now = Date.now()): WorkflowDelivery[] {
    return transaction(this.db, () => {
      const sending = this.listDeliveriesByState("sending");
      for (const delivery of sending) {
        this.db.prepare(
          `UPDATE workflow_deliveries
              SET state = 'uncertain', error = 'daemon_restart_after_send_claim', updated_at = ?
            WHERE id = ? AND state = 'sending'`,
        ).run(now, delivery.id);
        this.db.prepare(
          `UPDATE workflow_runs
              SET status = 'blocked', current_phase = 'delivery_uncertain',
                  gate_state_json = ?, updated_at = ?
            WHERE id = ? AND status NOT IN ('completed', 'cancelled', 'failed')`,
        ).run(JSON.stringify({ deliveryId: delivery.id }), now, delivery.runId);
        this.appendEvent(delivery.runId, "delivery_uncertain", {
          deliveryId: delivery.id,
          reason: "daemon_restart_after_send_claim",
        }, now);
      }
      return sending.map((delivery) => this.mustDelivery(delivery.id));
    });
  }

  markSendingUncertainForSession(
    sessionId: string,
    reason: string,
    now = Date.now(),
  ): WorkflowDelivery[] {
    return transaction(this.db, () => {
      const rows = this.db.prepare(
        `SELECT * FROM workflow_deliveries WHERE session_id = ? AND state = 'sending'`,
      ).all(sessionId) as unknown[];
      const sending = rows.map(parseWorkflowDeliveryRow);
      for (const delivery of sending) {
        this.db.prepare(
          `UPDATE workflow_deliveries
              SET state = 'uncertain', error = ?, updated_at = ?
            WHERE id = ? AND state = 'sending'`,
        ).run(reason, now, delivery.id);
        this.db.prepare(
          `UPDATE workflow_runs
              SET status = 'blocked', current_phase = 'delivery_uncertain',
                  gate_state_json = ?, updated_at = ?
            WHERE id = ? AND status NOT IN ('completed', 'cancelled', 'failed')`,
        ).run(JSON.stringify({ deliveryId: delivery.id, reason }), now, delivery.runId);
        this.appendEvent(delivery.runId, "delivery_uncertain", {
          deliveryId: delivery.id,
          reason,
        }, now);
      }
      return sending.map((delivery) => this.mustDelivery(delivery.id));
    });
  }

  retargetDelivery(
    id: string,
    sessionId: string,
    noteKey: string,
    now = Date.now(),
  ): WorkflowDelivery | null {
    const result = this.db.prepare(
      `UPDATE workflow_deliveries
          SET session_id = ?, note_key = ?, state = 'refused',
              error = 'reattach_confirmation_required', updated_at = ?
        WHERE id = ? AND state IN ('prepared', 'refused')`,
    ).run(sessionId, noteKey, now, id);
    return Number(result.changes) === 1 ? this.getDelivery(id) : null;
  }

  resolveUncertainDelivery(
    id: string,
    resolution: "mark_delivered" | "discard_and_new_round",
    requestId: string,
    now = Date.now(),
  ): { delivery: WorkflowDelivery; idempotent: boolean; rearmedDrain: boolean } | null {
    return transaction(this.db, () => {
      const delivery = this.getDelivery(id);
      if (!delivery) return null;
      const prior = this.db.prepare(
        `SELECT json_extract(payload_json, '$.resolution') AS resolution
           FROM workflow_events
          WHERE run_id = ? AND event_kind = 'delivery_uncertain_resolved'
            AND json_extract(payload_json, '$.deliveryId') = ?
            AND json_extract(payload_json, '$.requestId') = ?
          LIMIT 1`,
      ).get(delivery.runId, id, requestId) as { resolution: string } | undefined;
      if (prior) {
        return prior.resolution === resolution
          ? { delivery, idempotent: true, rearmedDrain: false }
          : null;
      }
      if (delivery.state !== "uncertain") return null;
      const state = resolution === "mark_delivered" ? "delivered" : "cancelled";
      const error = resolution === "mark_delivered" ? null : "discarded_by_operator";
      const changed = this.db.prepare(
        `UPDATE workflow_deliveries
            SET state = ?, error = ?, updated_at = ?,
                delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END
          WHERE id = ? AND state = 'uncertain'`,
      ).run(state, error, now, state, now, id);
      if (Number(changed.changes) !== 1) return null;
      this.appendEvent(delivery.runId, "delivery_uncertain_resolved", {
        deliveryId: id,
        requestId,
        resolution,
      }, now);
      let rearmedDrain = false;
      if (resolution === "mark_delivered") {
        this.setRunState(delivery.runId, "waiting_for_session", "persona_feedback", {
          deliveryId: delivery.id,
          resolvedByOperator: true,
        }, now);
        rearmedDrain = this.rearmDrainCompletionForDelivery(delivery, now);
        if (rearmedDrain) {
          this.appendEvent(delivery.runId, "foreman_completion_rearmed", {
            deliveryId: delivery.id,
            completionKind: "drain",
          }, now);
        }
      }
      return { delivery: this.mustDelivery(id), idempotent: false, rearmedDrain };
    });
  }

  appendEvent(
    runId: string,
    kind: string,
    payload: WorkflowJson,
    now = Date.now(),
  ): WorkflowEvent {
    const result = this.db.prepare(
      `INSERT INTO workflow_events (run_id, ts, event_kind, payload_json) VALUES (?, ?, ?, ?)`,
    ).run(runId, now, kind, JSON.stringify(payload));
    const row = this.db.prepare(`SELECT * FROM workflow_events WHERE id = ?`).get(Number(result.lastInsertRowid));
    return parseWorkflowEventRow(row);
  }

  listEvents(runId: string): WorkflowEvent[] {
    return (this.db.prepare(
      `SELECT * FROM workflow_events WHERE run_id = ? ORDER BY id ASC`,
    ).all(runId) as unknown[]).map(parseWorkflowEventRow);
  }

  insertLlmCall(call: WorkflowLlmCall): void {
    this.db.prepare(
      `INSERT INTO workflow_llm_calls (
         id, run_id, submission_id, node_attempt_id, purpose, runner_id, model_id,
         attempt, state, started_at, finished_at, duration_ms, input_bytes, output_bytes,
         cost_usd, error_code
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      call.id, call.runId, call.submissionId, call.nodeAttemptId, call.purpose,
      call.runner, call.model, call.attempt, call.state, call.startedAt, call.finishedAt,
      call.durationMs, call.inputBytes, call.outputBytes, call.costUsd, call.errorCode,
    );
  }

  finishLlmCall(
    id: string,
    state: WorkflowLlmCall["state"],
    outputBytes: number,
    errorCode: string | null,
    now = Date.now(),
  ): void {
    this.db.prepare(
      `UPDATE workflow_llm_calls
          SET state = ?, finished_at = ?, duration_ms = ? - started_at,
              output_bytes = ?, error_code = ?
        WHERE id = ? AND state = 'running'`,
    ).run(state, now, now, outputBytes, errorCode, id);
  }

  interruptRunningLlmCalls(runId: string, now = Date.now()): void {
    this.db.prepare(
      `UPDATE workflow_llm_calls
          SET state = 'interrupted', finished_at = ?, duration_ms = ? - started_at,
              error_code = 'daemon_restart'
        WHERE run_id = ? AND state = 'running'`,
    ).run(now, now, runId);
  }

  runDetail(id: string): WorkflowRunDetail | null {
    const summary = this.runSummary(id);
    const run = this.getRun(id);
    if (!summary || !run) return null;
    const binding = this.getBinding(run.bindingId);
    const version = this.getWorkflowVersionById(run.workflowVersionId);
    if (!binding) return null;
    const submissions = this.listSubmissions(id);
    return {
      summary,
      binding,
      version,
      run,
      submissions,
      attempts: submissions.flatMap((submission) => this.listAttempts(submission.id)),
      receipts: submissions.flatMap((submission) => this.listReceipts(submission.id)),
      deliveries: this.listDeliveries(id),
      events: this.listEvents(id),
    };
  }

  cancelRun(id: string, reason: string, now = Date.now()): WorkflowRun | null {
    return transaction(this.db, () => {
      const run = this.getRun(id);
      if (!run) return null;
      if (["completed", "cancelled", "failed"].includes(run.status)) return run;
      this.db.prepare(
        `UPDATE workflow_node_attempts SET state = 'cancelled', error = ?,
                updated_at = ?, finished_at = COALESCE(finished_at, ?)
          WHERE submission_id IN (SELECT id FROM workflow_submissions WHERE run_id = ?)
            AND state IN ('queued', 'retry_wait', 'running')`,
      ).run(reason, now, now, id);
      this.db.prepare(
        `UPDATE workflow_submissions SET status = 'cancelled', updated_at = ?,
                completed_at = COALESCE(completed_at, ?)
          WHERE run_id = ? AND status NOT IN ('completed', 'cancelled', 'failed')`,
      ).run(now, now, id);
      this.db.prepare(
        `UPDATE workflow_deliveries
            SET state = 'cancelled', error = ?, updated_at = ?
          WHERE run_id = ? AND state = 'prepared'`,
      ).run(reason, now, id);
      this.db.prepare(
        `UPDATE workflow_llm_calls
            SET state = 'cancelled', finished_at = ?, duration_ms = ? - started_at,
                error_code = ?
          WHERE run_id = ? AND state = 'running'`,
      ).run(now, now, reason, id);
      this.setRunState(id, "cancelled", reason, { reason }, now);
      this.appendEvent(id, "run_cancelled", { reason }, now);
      return this.mustRun(id);
    });
  }

  orphanBinding(id: string, reason: string, now = Date.now()): WorkflowBinding | null {
    return transaction(this.db, () => {
      const binding = this.getBinding(id);
      if (!binding || binding.state === "archived") return binding;
      this.db.prepare(
        `UPDATE workflow_bindings SET state = 'orphaned', session_id = NULL, updated_at = ? WHERE id = ?`,
      ).run(now, id);
      const active = this.activeRunForBinding(id);
      if (active) {
        this.db.prepare(
          `UPDATE workflow_node_attempts SET state = 'cancelled', error = ?, updated_at = ?,
                  finished_at = COALESCE(finished_at, ?)
            WHERE submission_id IN (SELECT id FROM workflow_submissions WHERE run_id = ?)
              AND state IN ('queued', 'retry_wait')`,
        ).run(reason, now, now, active.id);
        this.db.prepare(
          `UPDATE workflow_submissions SET status = 'cancelled', updated_at = ?,
                  completed_at = COALESCE(completed_at, ?)
            WHERE run_id = ? AND status IN ('capturing', 'running')`,
        ).run(now, now, active.id);
        this.db.prepare(
          `UPDATE workflow_llm_calls
              SET state = 'cancelled', finished_at = ?, duration_ms = ? - started_at,
                  error_code = ?
            WHERE run_id = ? AND state = 'running'`,
        ).run(now, now, reason, active.id);
        this.setRunState(active.id, "blocked", reason, { reason }, now);
        this.appendEvent(active.id, "binding_orphaned", { reason }, now);
      }
      return this.getBinding(id);
    });
  }

  pauseBinding(id: string, reason: string, now = Date.now()): WorkflowBinding | null {
    return transaction(this.db, () => {
      const binding = this.getBinding(id);
      if (!binding || binding.state === "archived") return binding;
      this.db.prepare(
        `UPDATE workflow_bindings SET state = 'paused', updated_at = ? WHERE id = ?`,
      ).run(now, id);
      const active = this.activeRunForBinding(id);
      if (active) {
        this.db.prepare(
          `UPDATE workflow_node_attempts SET state = 'cancelled', error = ?, updated_at = ?,
                  finished_at = COALESCE(finished_at, ?)
            WHERE submission_id IN (SELECT id FROM workflow_submissions WHERE run_id = ?)
              AND state IN ('queued', 'retry_wait')`,
        ).run(reason, now, now, active.id);
        this.db.prepare(
          `UPDATE workflow_submissions SET status = 'cancelled', updated_at = ?,
                  completed_at = COALESCE(completed_at, ?)
            WHERE run_id = ? AND status IN ('capturing', 'running')`,
        ).run(now, now, active.id);
        this.db.prepare(
          `UPDATE workflow_llm_calls
              SET state = 'cancelled', finished_at = ?, duration_ms = ? - started_at,
                  error_code = ?
            WHERE run_id = ? AND state = 'running'`,
        ).run(now, now, reason, active.id);
        this.setRunState(active.id, "blocked", reason, { reason }, now);
        this.appendEvent(active.id, "binding_paused", { reason }, now);
      }
      return this.getBinding(id);
    });
  }

  archiveBindingAndCancel(
    id: string,
    now = Date.now(),
  ): { binding: WorkflowBinding; cancelledRunId: string | null } | null {
    return transaction(this.db, () => {
      const binding = this.getBinding(id);
      if (!binding) return null;
      const active = this.activeRunForBinding(id);
      if (active) {
        this.db.prepare(
          `UPDATE workflow_node_attempts SET state = 'cancelled', error = 'binding_archived',
                  updated_at = ?, finished_at = COALESCE(finished_at, ?)
            WHERE submission_id IN (SELECT id FROM workflow_submissions WHERE run_id = ?)
              AND state IN ('queued', 'retry_wait', 'running')`,
        ).run(now, now, active.id);
        this.db.prepare(
          `UPDATE workflow_submissions SET status = 'cancelled', updated_at = ?,
                  completed_at = COALESCE(completed_at, ?)
            WHERE run_id = ? AND status NOT IN ('completed', 'cancelled', 'failed')`,
        ).run(now, now, active.id);
        this.db.prepare(
          `UPDATE workflow_deliveries
              SET state = 'cancelled', error = 'binding_archived', updated_at = ?
            WHERE run_id = ? AND state = 'prepared'`,
        ).run(now, active.id);
        this.db.prepare(
          `UPDATE workflow_llm_calls
              SET state = 'cancelled', finished_at = ?, duration_ms = ? - started_at,
                  error_code = 'binding_archived'
            WHERE run_id = ? AND state = 'running'`,
        ).run(now, now, active.id);
        this.setRunState(active.id, "cancelled", "binding_archived", { reason: "binding_archived" }, now);
        this.appendEvent(active.id, "run_cancelled", { reason: "binding_archived" }, now);
      }
      this.db.prepare(
        `UPDATE workflow_bindings SET state = 'archived', updated_at = ? WHERE id = ?`,
      ).run(now, id);
      const archived = this.getBinding(id);
      if (!archived) throw new Error(`Workflow binding ${id} disappeared during archive`);
      return { binding: archived, cancelledRunId: active?.id ?? null };
    });
  }

  resetForNoteKey(noteKey: string): string[] {
    return transaction(this.db, () => {
      const runRows = this.db.prepare(
        `SELECT r.id FROM workflow_runs r
          JOIN workflow_bindings b ON b.id = r.binding_id
         WHERE b.note_key = ?`,
      ).all(noteKey) as unknown as Array<{ id: string }>;
      const runIds = runRows.map((row) => row.id);
      for (const runId of runIds) {
        this.db.prepare(
          `DELETE FROM workflow_llm_calls WHERE run_id = ?`,
        ).run(runId);
        this.db.prepare(
          `DELETE FROM workflow_edge_receipts
            WHERE submission_id IN (SELECT id FROM workflow_submissions WHERE run_id = ?)`,
        ).run(runId);
        this.db.prepare(
          `DELETE FROM workflow_node_attempts
            WHERE submission_id IN (SELECT id FROM workflow_submissions WHERE run_id = ?)`,
        ).run(runId);
        this.db.prepare(`DELETE FROM workflow_deliveries WHERE run_id = ?`).run(runId);
        this.db.prepare(`DELETE FROM workflow_events WHERE run_id = ?`).run(runId);
        this.db.prepare(`DELETE FROM workflow_submissions WHERE run_id = ?`).run(runId);
        this.db.prepare(`DELETE FROM workflow_runs WHERE id = ?`).run(runId);
      }
      this.db.prepare(`DELETE FROM workflow_bindings WHERE note_key = ?`).run(noteKey);
      return runIds;
    });
  }

  private retireDrainGuard(noteKey: string, answer: string, now: number): boolean {
    const terminal = TERMINAL_ITEM_STATES.map((state) => `'${state}'`).join(",");
    const result = this.db.prepare(
      `UPDATE foreman_queues
          SET wrapup_asked_at = ?, wrapup_answer = ?, updated_at = ?
        WHERE note_key = ?
          AND wrapup_asked_at IS NULL
          AND EXISTS (
            SELECT 1 FROM foreman_queue_items WHERE note_key = foreman_queues.note_key
          )
          AND NOT EXISTS (
            SELECT 1 FROM foreman_queue_items
             WHERE note_key = foreman_queues.note_key AND state NOT IN (${terminal})
          )`,
    ).run(now, answer, now, noteKey);
    return Number(result.changes) === 1;
  }

  private rearmDrainCompletionForDelivery(
    delivery: WorkflowDelivery,
    now: number,
  ): boolean {
    const result = this.db.prepare(
      `UPDATE foreman_queues
          SET wrapup_asked_at = NULL, wrapup_answer = NULL, updated_at = ?
        WHERE note_key = ?
          AND EXISTS (
            SELECT 1 FROM foreman_queue_items WHERE note_key = foreman_queues.note_key
          )`,
    ).run(now, delivery.noteKey);
    return Number(result.changes) === 1;
  }

  private retirePromptedGuard(
    binding: WorkflowBinding,
    currentGoal: string | null,
    now: number,
  ): boolean {
    const goal = currentGoal?.trim();
    if (!goal) return false;
    const existing = this.db.prepare(
      `SELECT prompted_goal FROM foreman_queues WHERE note_key = ?`,
    ).get(binding.noteKey) as { prompted_goal: string | null } | undefined;
    if (existing?.prompted_goal === goal) return false;
    if (existing) {
      const result = this.db.prepare(
        `UPDATE foreman_queues SET prompted_goal = ?, updated_at = ?
          WHERE note_key = ?
            AND (prompted_goal IS NULL OR prompted_goal <> ?)`,
      ).run(goal, now, binding.noteKey, goal);
      return Number(result.changes) === 1;
    }
    const result = this.db.prepare(
      `INSERT INTO foreman_queues (
         note_key, cwd, branch, wrapup_asked_at, wrapup_answer, prompted_goal, updated_at
       ) VALUES (?, ?, NULL, NULL, NULL, ?, ?)`,
    ).run(binding.noteKey, binding.sessionCwd, goal, now);
    return Number(result.changes) === 1;
  }

  private insertSubmissionInTransaction(input: WorkflowSubmissionInsert): void {
    this.db.prepare(
      `INSERT INTO workflow_submissions (
         id, run_id, round, mode, trigger_source, trigger_key, evidence_fingerprint,
         context_json, evidence_json, pr_head_sha, status, created_at, updated_at, completed_at
       ) VALUES (?, ?, ?, 'full_workflow', ?, ?, ?, ?, ?, NULL, 'capturing', ?, ?, NULL)`,
    ).run(
      input.id,
      input.runId,
      input.round,
      input.triggerSource ?? "manual",
      input.triggerKey,
      `capturing:${input.id}`,
      JSON.stringify(input.context),
      JSON.stringify(input.evidence),
      input.now,
      input.now,
    );
  }

  private mustRun(id: string): WorkflowRun {
    const run = this.getRun(id);
    if (!run) throw new Error(`Workflow run ${id} disappeared during a transaction`);
    return run;
  }

  private mustSubmission(id: string): WorkflowSubmission {
    const submission = this.getSubmission(id);
    if (!submission) throw new Error(`Workflow submission ${id} disappeared during a transaction`);
    return submission;
  }

  private mustDelivery(id: string): WorkflowDelivery {
    const delivery = this.getDelivery(id);
    if (!delivery) throw new Error(`Workflow delivery ${id} disappeared during a transaction`);
    return delivery;
  }

  private listPersonasInTransaction(includeArchived: boolean): Persona[] {
    const rows = this.db.prepare(
      `SELECT * FROM personas ${includeArchived ? "" : "WHERE archived_at IS NULL"} ORDER BY normalized_name ASC`,
    ).all() as unknown[];
    return rows.map((row) => parsePersonaRow(row));
  }

  private getWorkflowInTransaction(id: string): WorkflowDefinition | null {
    const row = this.db.prepare(`SELECT * FROM workflow_definitions WHERE id = ?`).get(id);
    return row ? parseWorkflowDefinitionRow(row) : null;
  }

  private mustWorkflow(id: string): WorkflowDefinition {
    const workflow = this.getWorkflowInTransaction(id);
    if (!workflow) throw new Error(`Workflow ${id} disappeared during a workflow transaction`);
    return workflow;
  }

  private mustWorkflowVersion(workflowId: string, version: number): WorkflowVersion {
    const row = this.db.prepare(
      `SELECT * FROM workflow_versions WHERE workflow_id = ? AND version = ?`,
    ).get(workflowId, version);
    if (!row) throw new Error(`Workflow ${workflowId} version ${version} disappeared during Publish`);
    return parseWorkflowVersionRow(row);
  }
}

/** Test-only cleanup. Requiring an explicit handle prevents this from ever reaching live state. */
export function clearWorkflowTables(testDb: DatabaseSync): void {
  for (const table of [...WORKFLOW_TABLES].reverse()) testDb.exec(`DELETE FROM ${table}`);
}

/** Validate an arbitrary later-phase JSON payload with the same durable contract as row parsers. */
export function workflowJson(value: unknown): WorkflowJson {
  return WorkflowJsonSchema.parse(value);
}
