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
  WORKFLOW_LIMITS,
  WORKFLOW_LLM_CALL_STATES,
  WORKFLOW_LLM_PURPOSES,
  WORKFLOW_TRIGGER_MODES,
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
  WorkflowSubmission,
  WorkflowVersion,
  WorkflowSummary,
  WorkflowDiagnostic,
} from "@shared/workflow.ts";
import type { LlmRunnerId } from "@shared/llm.ts";
import { LLM_RUNNER_IDS } from "@shared/llm.ts";
import { openDb } from "../db.ts";
import { validateWorkflowGraph } from "@shared/workflow-graph.ts";

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

const WorkflowBindingRowSchema = z.object({
  id: nonempty,
  workflow_version_id: nonempty,
  note_key: nonempty,
  session_id: nullableText,
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
      WORKFLOW_LIMITS.eventPayloadBytes,
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
    context: parseJson("workflow_submissions", row.id, "context_json", row.context_json, WorkflowJsonSchema),
    evidence: parseJson("workflow_submissions", row.id, "evidence_json", row.evidence_json, WorkflowJsonSchema),
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
      WORKFLOW_LIMITS.eventPayloadBytes,
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
      WORKFLOW_LIMITS.eventPayloadBytes,
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
