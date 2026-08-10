import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type {
  CreatePersona,
  CreateSessionAction,
  CreateWorkflow,
  UpdatePersona,
  UpdateSessionAction,
  UpdateWorkflow,
} from "@shared/protocol.ts";
import {
  PersonaProvenanceSchema,
  PersonaSnapshotSchema,
  SessionActionAttemptStateSchema,
  SessionActionSkillIdSchema,
  SessionActionSnapshotSchema,
  PublishedWorkflowGraphSchema,
  WorkflowBindingDefaultsSchema,
  WorkflowCompletionPolicySchema,
  WorkflowDraftGraphSchema,
  WorkflowExternalSourceKindSchema,
  WorkflowJsonSchema,
  WorkflowNodeAttemptStateSchema,
  WorkflowRunStatusSchema,
  WorkflowInspectorGateStateSchema,
  WorkflowContextSnapshotSchema,
  WorkflowInspectorOnlyContextSchema,
  WorkflowSubmissionModeSchema,
  WorkflowSubmissionStatusSchema,
  WorkflowTriggerSourceSchema,
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
  WORKFLOW_RESUMPTION_POLICIES,
  WORKFLOW_TRIGGER_MODES,
  LEGACY_WORKFLOW_RESUMPTION_POLICY,
  SESSION_ACTION_COMPLETION_KINDS,
  personaSnapshotOf,
  personasForDisplay,
  sessionActionSnapshotOf,
  sessionActionsForDisplay,
  workflowsForDisplay,
  type WorkflowTriggerSource,
  type WorkflowCompletionKind,
  type WorkflowDeliveryKind,
  type WorkflowGateSummary,
  type WorkflowInspectorGateState,
  type WorkflowResumptionPolicy,
} from "@shared/workflow.ts";
import { SESSION_ACTION_COMPLETION_CAPABILITIES } from "@shared/workflow.ts";
import type {
  Persona,
  PersonaProvenance,
  SessionAction,
  WorkflowBinding,
  WorkflowBindingClaim,
  WorkflowCaptureExpectation,
  WorkflowDefinition,
  WorkflowDelivery,
  WorkflowEdgeReceipt,
  WorkflowEvent,
  WorkflowExternalSource,
  WorkflowExternalSourceKind,
  WorkflowJson,
  WorkflowLlmCall,
  WorkflowNodeAttempt,
  WorkflowRun,
  WorkflowRunDetail,
  WorkflowRunPage,
  WorkflowRunSummary,
  WorkflowEventPage,
  WorkflowLlmCallPage,
  WorkflowContextSnapshot,
  WorkflowSubmission,
  WorkflowVersion,
  WorkflowVersionMetadata,
  WorkflowSummary,
  WorkflowDiagnostic,
  WorkflowValidationResult,
  SessionActionAttemptState,
  SessionActionDeliveryAnchor,
  SessionActionCompletionCapability,
  SessionActionCompletionKind,
  SessionActionSnapshot,
} from "@shared/workflow.ts";
import type { LlmRunnerId } from "@shared/llm.ts";
import type { SessionIntentGuard } from "@shared/types.ts";
import { LLM_RUNNER_IDS } from "@shared/llm.ts";
import { openDb } from "../db.ts";
import { BUILTIN_PERSONAS } from "./builtin-personas.ts";
import { BUILTIN_SESSION_ACTIONS } from "./builtin-session-actions.ts";
import { BUILTIN_WORKFLOWS, type BuiltinWorkflow } from "./builtin-workflows.ts";
import { validateWorkflowGraph } from "@shared/workflow-graph.ts";
import { TERMINAL_ITEM_STATES } from "@shared/queue.ts";
import { priorFindingFingerprintAudit } from "./finding-audit.ts";
import { workflowLog } from "./log.ts";
import { repeatOffenders } from "./repeat-offender.ts";

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
const utf8 = new TextEncoder();
const DEFAULT_DETAIL_PAGE_SIZE = 200;
export const WORKFLOW_RETENTION_BATCH_SIZE = 100;

type RunCursor = { updatedAt: number; id: string };

// A summary intentionally selects no submission evidence or context. The newest submission
// contributes only its identity and segment; attempts for the bounded result set are loaded
// in one follow-up query instead of three reads per run.
const WORKFLOW_RUN_SUMMARY_SELECT = `
  SELECT r.*, b.note_key, b.session_id, b.session_name,
         d.id AS workflow_id, d.name AS workflow_name, v.version AS workflow_version,
         COALESCE((
           SELECT MAX(s.round) FROM workflow_submissions s WHERE s.run_id = r.id
         ), 0) AS current_round,
         ls.id AS latest_submission_id,
         COALESCE(ls.segment, 0) AS latest_segment,
         CASE WHEN EXISTS (
           SELECT 1 FROM workflow_submissions s
            WHERE s.run_id = r.id AND s.mode = 'inspector_only'
         ) THEN 1 ELSE 0 END AS bypassed_persona_review,
         (SELECT COUNT(*) FROM workflow_deliveries wd
           WHERE wd.run_id = r.id AND wd.state = 'uncertain') AS uncertain_delivery_count,
         (SELECT COUNT(*) FROM workflow_deliveries wd
           WHERE wd.run_id = r.id AND wd.state = 'refused') AS refused_delivery_count,
         c.source_kind AS claim_kind, c.source_id AS claim_source_id,
         c.created_at AS claim_created_at
    FROM workflow_runs r
    JOIN workflow_bindings b ON b.id = r.binding_id
    LEFT JOIN workflow_versions v ON v.id = r.workflow_version_id
    LEFT JOIN workflow_definitions d ON d.id = v.workflow_id
    LEFT JOIN workflow_submissions ls ON ls.id = (
      SELECT newest.id FROM workflow_submissions newest
       WHERE newest.run_id = r.id
       ORDER BY newest.round DESC, newest.segment DESC
       LIMIT 1
    )
    -- Display provenance for a run an external orchestrator started, matched on the RUN's own
    -- trigger source and never on the binding merely having a claim: a claimed binding stays
    -- usable by the manual and Foreman paths, so a later run on it is genuinely not the
    -- external one, and reading provenance off the binding alone would put somebody else's
    -- name on an operator's own run. A join rather than a lookup per run because these
    -- summaries are folded for the whole fleet on every change; claims are unique per binding,
    -- so at most one row joins. The opaque idempotency key is deliberately not selected - it
    -- never leaves the store.
    LEFT JOIN workflow_binding_claims c
           ON c.binding_id = r.binding_id AND c.source_kind = r.trigger_source`;

export function encodeWorkflowRunCursor(cursor: RunCursor): string {
  return Buffer.from(JSON.stringify([cursor.updatedAt, cursor.id]), "utf8").toString("base64url");
}

export function decodeWorkflowRunCursor(raw: string): RunCursor | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (
      !Array.isArray(value)
      || value.length !== 2
      || !Number.isSafeInteger(value[0])
      || Number(value[0]) < 0
      || typeof value[1] !== "string"
      || value[1].length === 0
      || value[1].length > 500
    ) return null;
    return { updatedAt: value[0] as number, id: value[1] };
  } catch {
    return null;
  }
}

function inspectorGateState(run: WorkflowRun): WorkflowInspectorGateState | null {
  const parsed = WorkflowInspectorGateStateSchema.safeParse(run.gateState);
  return parsed.success ? parsed.data : null;
}

function compactGate(run: WorkflowRun, gate: WorkflowInspectorGateState | null): WorkflowGateSummary {
  if (!gate) return "none";
  if (run.status === "completed") return "clean";
  if (run.status === "blocked") return "blocked";
  if (
    run.status === "waiting_for_pr"
    || gate.waitReason === "missing_pr"
    || gate.waitReason === "unadopted_pr"
  ) return "waiting_pr";
  if (run.status === "waiting_for_new_head" || gate.waitReason === "findings") return "findings";
  return "waiting_inspector";
}

/**
 * Display provenance off the claim columns `WORKFLOW_RUN_SUMMARY_SELECT` joins in, or null.
 *
 * Validated rather than cast, and NULL-tolerant on every column, because the join is a LEFT
 * one: the ordinary case is three nulls, and a `source_kind` this build has never heard of is
 * a newer daemon's row read by an older browser. Both land on "no provenance", which is the
 * same thing a run nobody claimed shows, rather than on a chip naming a kind nothing can
 * render.
 */
function externalSourceFromRow(row: Record<string, unknown>): WorkflowExternalSource | null {
  const kind = WorkflowExternalSourceKindSchema.safeParse(row.claim_kind);
  const sourceId = row.claim_source_id;
  const createdAt = Number(row.claim_created_at);
  if (!kind.success || typeof sourceId !== "string") return null;
  if (!Number.isSafeInteger(createdAt)) return null;
  return { kind: kind.data, sourceId, createdAt };
}

export const WORKFLOW_TABLES = [
  "personas",
  "session_actions",
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
  "workflow_binding_claims",
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
  if (value && typeof value === "object") {
    if ("id" in value) return String(value.id);
    // The claim table is keyed by its opaque source key rather than a surrogate id.
    if ("source_key" in value) return String(value.source_key);
  }
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

/**
 * A stored resumption policy, or the honest answer for a row that has none.
 *
 * NULL means "written before this column existed" and reads as `manual`, which preserves a
 * published version exactly (see `LEGACY_WORKFLOW_RESUMPTION_POLICY`). A NON-null value this
 * build cannot read is treated the same way, and deliberately not as a nearest match: the
 * only thing `auto` does is start work unattended, so the safe reading of "a newer build
 * wrote something here" is the one that does nothing until a human looks.
 */
function readResumptionPolicy(raw: string | null): WorkflowResumptionPolicy {
  return (WORKFLOW_RESUMPTION_POLICIES as readonly string[]).includes(raw ?? "")
    ? (raw as WorkflowResumptionPolicy)
    : LEGACY_WORKFLOW_RESUMPTION_POLICY;
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
  /**
   * Optional on the SHAPE, unlike every other column, because a database written by a build
   * that predates the column has no key here at all - `SELECT *` simply does not return one.
   * The blob's own contents are validated separately, and tolerantly.
   */
  import_provenance_json: nullableText.optional(),
});

/**
 * The provenance blob, or null - and null for a blob this build cannot read.
 *
 * The `runner_id` discipline rather than the `completion_kind` one, and for the same reason
 * spelled the other way round: an unreadable provenance record costs an operator a badge,
 * while failing the row over it would remove a working reviewer from the catalog, from every
 * draft that names it, and from Publish. Reported so a malformed write is not silent, and the
 * Persona is served either way.
 */
function readPersonaProvenance(id: string, raw: string | null | undefined): PersonaProvenance | null {
  if (raw === null || raw === undefined) return null;
  if (utf8.encode(raw).byteLength > WORKFLOW_LIMITS.personaProvenanceJsonBytes) {
    diagnose(new WorkflowRowError("personas", id, "import_provenance_json exceeds its byte limit"));
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    diagnose(new WorkflowRowError("personas", id, "import_provenance_json is not valid JSON"));
    return null;
  }
  const parsed = PersonaProvenanceSchema.safeParse(value);
  if (!parsed.success) {
    diagnose(new WorkflowRowError("personas", id, "import_provenance_json is not a provenance record"));
    return null;
  }
  return parsed.data;
}

/**
 * The blob as it is written, validated on the way OUT as well as on the way in.
 *
 * A write that cannot be read back is the one failure mode this column has: the row would keep
 * a working Persona and silently lose its badge, and the reader above - which degrades rather
 * than throws - would never say why. So the writer refuses instead, and the caller's request
 * fails while the stored row is still whatever it was.
 */
function serializePersonaProvenance(provenance: PersonaProvenance | null): string | null {
  if (provenance === null) return null;
  const raw = JSON.stringify(PersonaProvenanceSchema.parse(provenance));
  if (utf8.encode(raw).byteLength > WORKFLOW_LIMITS.personaProvenanceJsonBytes) {
    throw new Error("Persona provenance exceeds its stored byte limit");
  }
  return raw;
}

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
    provenance: readPersonaProvenance(row.id, row.import_provenance_json),
    // A row is operator data by construction: built-ins are never written to this table.
    builtin: false,
  };
}

const SessionActionRowSchema = z.object({
  id: nonempty,
  name: nonempty.max(WORKFLOW_LIMITS.sessionActionName),
  normalized_name: nonempty,
  description: text.max(WORKFLOW_LIMITS.sessionActionDescription),
  prompt_md: text,
  required_skill_id: nullableText,
  /**
   * STRICT on read, unlike `personas.runner_id` beside it, and the asymmetry is the point.
   * An unreadable runner degrades to the app-wide default and reports the fallback - the
   * review still happens, just on another model. An unreadable completion kind has no safe
   * fallback: reading a newer build's stricter adapter as `session_turn` would let an action
   * complete on a settled idle turn when the version it belongs to demanded durable proof.
   */
  completion_kind: z.enum(SESSION_ACTION_COMPLETION_KINDS),
  revision: positive,
  archived_at: nullableInteger,
  created_at: integer,
  updated_at: integer,
});

export function parseSessionActionRow(value: unknown): SessionAction {
  const row = parseShape("session_actions", SessionActionRowSchema, value);
  // The READ bound, which is looser than the authoring one on purpose: a row written before
  // the prompt ceiling was tied to the deliverable packet budget stays visible and editable
  // rather than becoming a row nobody can read in order to shorten. It still cannot be
  // published - the snapshot schema holds it to `sessionActionPromptBytes`.
  if (utf8.encode(row.prompt_md).byteLength > WORKFLOW_LIMITS.sessionActionPromptReadBytes) {
    throw new WorkflowRowError("session_actions", row.id, "prompt_md exceeds the prompt byte limit");
  }
  if (row.prompt_md.trim().length === 0) {
    throw new WorkflowRowError("session_actions", row.id, "prompt_md is empty");
  }
  const skill = row.required_skill_id;
  if (skill !== null && !SessionActionSkillIdSchema.safeParse(skill).success) {
    throw new WorkflowRowError("session_actions", row.id, "required_skill_id is not a catalog id");
  }
  return {
    id: row.id,
    name: row.name,
    normalizedName: row.normalized_name,
    description: row.description,
    promptMarkdown: row.prompt_md,
    requiredSkillId: skill,
    completion: { kind: row.completion_kind },
    revision: row.revision,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // A row is operator data by construction: built-ins are never written to this table.
    builtin: false,
  };
}

const WorkflowDefinitionRowSchema = z.object({
  id: nonempty,
  name: nonempty,
  normalized_name: nonempty,
  description: text,
  draft_graph_json: nonempty,
  completion_policy_json: nonempty,
  // Tolerant on READ for the reason `readResumptionPolicy` documents: an absent column on an
  // upgrading database and an unknown value from a newer build are both answered there.
  resumption_policy: nullableText.optional().default(null),
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
    resumptionPolicy: readResumptionPolicy(row.resumption_policy ?? null),
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
    // A row is by definition operator data. Built-ins never round-trip through SQLite.
    builtin: false,
  };
}

const WorkflowVersionRowSchema = z.object({
  id: nonempty,
  workflow_id: nonempty,
  version: positive,
  source_draft_revision: positive,
  graph_json: nonempty,
  completion_policy_json: nonempty,
  resumption_policy: nullableText.optional().default(null),
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
    resumptionPolicy: readResumptionPolicy(row.resumption_policy ?? null),
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
    resumptionPolicy: readResumptionPolicy(row.resumption_policy ?? null),
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
  trigger_source: WorkflowTriggerSourceSchema,
  trigger_key: nonempty,
  inspector_pr_key: nullableText,
  inspector_head_sha: nullableText,
  gate_state_json: nullableText,
  started_at: integer,
  updated_at: integer,
  completed_at: nullableInteger,
  evidence_pruned_at: nullableInteger.optional().default(null),
  disabled_nodes_json: nullableText.optional().default(null),
});

/** Node ids an operator disabled for one run. Bounded by the graph's own node ceiling. */
const DisabledNodesSchema = z.array(nonempty.max(200)).max(WORKFLOW_LIMITS.graphNodes);

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
    disabledNodeIds: parseNullableJson(
      "workflow_runs",
      row.id,
      "disabled_nodes_json",
      row.disabled_nodes_json ?? null,
      DisabledNodesSchema,
    ) ?? [],
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    evidencePrunedAt: row.evidence_pruned_at ?? null,
  };
}

const WorkflowSubmissionRowSchema = z.object({
  id: nonempty,
  run_id: nonempty,
  round: positive,
  // Optional with a zero default only so a row written by a build without the column still
  // parses in-process during an upgrade; `migrate()` supplies the real NOT NULL DEFAULT 0.
  segment: integer.nonnegative().optional().default(0),
  parent_submission_id: nullableText.optional().default(null),
  continuation_node_id: nullableText.optional().default(null),
  continuation_node_attempt_id: nullableText.optional().default(null),
  mode: WorkflowSubmissionModeSchema,
  trigger_source: WorkflowTriggerSourceSchema,
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
  // Continuation provenance is ALL-OR-NOTHING with a nonzero segment, and the check lives
  // here because a half-written continuation is exactly the row a reader would misinterpret:
  // a child segment with no parent looks like an ordinary repair round, and a segment-zero
  // row carrying a parent claims a continuation that never happened.
  const segment = row.segment ?? 0;
  const provenance = [
    row.parent_submission_id ?? null,
    row.continuation_node_id ?? null,
    row.continuation_node_attempt_id ?? null,
  ];
  if (segment === 0 ? provenance.some((v) => v !== null) : provenance.some((v) => v === null)) {
    throw new WorkflowRowError(
      "workflow_submissions",
      row.id,
      "continuation provenance must be present exactly when segment is nonzero",
    );
  }
  return {
    id: row.id,
    runId: row.run_id,
    round: row.round,
    segment,
    parentSubmissionId: row.parent_submission_id ?? null,
    continuationNodeId: row.continuation_node_id ?? null,
    continuationNodeAttemptId: row.continuation_node_attempt_id ?? null,
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
  session_action_snapshot_json: nullableText.optional().default(null),
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
  // An attempt executes ONE kind of thing. Carrying both snapshots would make every reader
  // that branches on "is this a reviewer or an action?" answer both ways, and the row is the
  // last place that can still be told apart cheaply.
  if (row.persona_snapshot_json !== null && (row.session_action_snapshot_json ?? null) !== null) {
    throw new WorkflowRowError(
      "workflow_node_attempts",
      row.id,
      "an attempt cannot carry both a Persona and a session action snapshot",
    );
  }
  // `waiting` exists only for a session action, so a waiting attempt with no action snapshot
  // is a row nothing can deliver, recover, or explain. Refuse it rather than park a run on it.
  if (row.state === "waiting" && (row.session_action_snapshot_json ?? null) === null) {
    throw new WorkflowRowError(
      "workflow_node_attempts",
      row.id,
      "a waiting attempt must carry its session action snapshot",
    );
  }
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
    sessionAction: parseNullableJson(
      "workflow_node_attempts",
      row.id,
      "session_action_snapshot_json",
      row.session_action_snapshot_json ?? null,
      SessionActionSnapshotSchema,
      WORKFLOW_LIMITS.sessionActionPromptReadBytes + WORKFLOW_LIMITS.eventPayloadBytes,
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
  node_attempt_id: nullableText.optional().default(null),
  session_id: nonempty,
  note_key: nonempty,
  payload: text,
  payload_sha256: nonempty,
  state: z.enum(WORKFLOW_DELIVERY_STATES),
  error: nullableText,
  created_at: integer,
  updated_at: integer,
  delivered_at: nullableInteger,
  payload_pruned_at: nullableInteger.optional().default(null),
});

/**
 * The run phase a CONFIRMED delivery of each kind leaves behind.
 *
 * A `Record` rather than the ternary chain this replaced, so a fifth delivery kind fails
 * typecheck here until somebody decides what state a run is in once that packet has landed -
 * the same reason the display vocabulary lives in one exhaustive map in `run-model.ts`.
 *
 * `unchanged_evidence_nudge` deliberately KEEPS `unchanged_evidence`. The nudge does not undo
 * the refusal, it asks the session to answer it; relabelling the phase `persona_feedback` would
 * tell the run detail page a review had been delivered when what was delivered was a refusal,
 * and would lose the one phase a human scanning stalled runs needs to see.
 */
const DELIVERY_RUN_PHASE: Record<WorkflowDeliveryKind, string> = {
  persona_feedback: "persona_feedback",
  inspector_feedback: "inspector_findings",
  pr_handoff: "pr_handoff",
  unchanged_evidence_nudge: "unchanged_evidence",
  session_action: "session_action",
};

/**
 * The run STATUS a confirmed delivery of each kind leaves behind, when it is not the default
 * `waiting_for_session`.
 *
 * An action wait is its own status because the two are watched by different observers with
 * different budgets: `waiting_for_session` is a parked repair round the resumption sweep may
 * resubmit, while a delivered action must be resumed only by proving pickup and a settled
 * turn. Sharing the status would hand every action turn to the resumption observer.
 */
const DELIVERY_RUN_STATUS: Partial<Record<WorkflowDeliveryKind, WorkflowRun["status"]>> = {
  session_action: "waiting_for_action",
};

export function parseWorkflowDeliveryRow(value: unknown): WorkflowDelivery {
  const row = parseShape("workflow_deliveries", WorkflowDeliveryRowSchema, value);
  if (utf8.encode(row.payload).byteLength > WORKFLOW_LIMITS.eventPayloadBytes) {
    throw new WorkflowRowError("workflow_deliveries", row.id, "payload exceeds the delivery limit");
  }
  // The link is required for an action and refused for everything else. Stated as one
  // biconditional at the row boundary so an action packet can never be orphaned from the
  // attempt that owns it, and so no legacy kind can quietly acquire an attempt it does not
  // have - which would make recovery believe a pr_handoff was a graph node's action.
  if ((row.kind === "session_action") !== ((row.node_attempt_id ?? null) !== null)) {
    throw new WorkflowRowError(
      "workflow_deliveries",
      row.id,
      "only a session_action delivery names a node attempt, and it must name one",
    );
  }
  return {
    id: row.id,
    runId: row.run_id,
    submissionId: row.submission_id,
    kind: row.kind,
    nodeAttemptId: row.node_attempt_id ?? null,
    sessionId: row.session_id,
    noteKey: row.note_key,
    payload: row.payload,
    payloadSha256: row.payload_sha256,
    state: row.state,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deliveredAt: row.delivered_at,
    payloadPrunedAt: row.payload_pruned_at ?? null,
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

const WorkflowBindingClaimRowSchema = z.object({
  source_key: nonempty.max(WORKFLOW_LIMITS.externalSourceKey),
  source_kind: WorkflowExternalSourceKindSchema,
  source_id: nonempty.max(WORKFLOW_LIMITS.externalSourceId),
  binding_id: nonempty,
  created_at: integer,
});

export function parseWorkflowBindingClaimRow(value: unknown): WorkflowBindingClaim {
  const row = parseShape("workflow_binding_claims", WorkflowBindingClaimRowSchema, value);
  return {
    kind: row.source_kind,
    sourceKey: row.source_key,
    sourceId: row.source_id,
    bindingId: row.binding_id,
    createdAt: row.created_at,
  };
}

function diagnose(error: unknown): void {
  workflowLog("error", {
    event: "malformed_durable_row",
    error: error instanceof WorkflowRowError ? error.table : "unknown",
  });
}

function readFullWorkflowContext(
  context: WorkflowJson,
  status: WorkflowSubmission["status"] | string,
):
  | { kind: "captured"; context: WorkflowContextSnapshot }
  | { kind: "not_captured" | "corrupt" } {
  const parsed = WorkflowContextSnapshotSchema.safeParse(context);
  if (parsed.success) return { kind: "captured", context: parsed.data };
  if (
    context !== null
    && typeof context === "object"
    && !Array.isArray(context)
    && Object.keys(context).length === 0
    && ["capturing", "cancelled", "failed"].includes(status)
  ) {
    return { kind: "not_captured" };
  }
  return { kind: "corrupt" };
}

function runContextState(
  submissions: WorkflowSubmission[],
): WorkflowRunDetail["contextState"] {
  let latestFull: WorkflowRunDetail["contextState"] | null = null;
  for (const submission of submissions) {
    if (submission.mode === "inspector_only") {
      if (!WorkflowInspectorOnlyContextSchema.safeParse(submission.context).success) {
        diagnose(new WorkflowRowError(
          "workflow_submissions",
          submission.id,
          "context_json is not a valid Inspector-only context",
        ));
        return "corrupt";
      }
      continue;
    }
    const context = readFullWorkflowContext(submission.context, submission.status);
    if (context.kind === "corrupt") {
      diagnose(new WorkflowRowError(
        "workflow_submissions",
        submission.id,
        "context_json is not a captured workflow context",
      ));
      return "corrupt";
    }
    latestFull = context.kind;
  }
  if (latestFull) return latestFull;
  diagnose(new WorkflowRowError(
    "workflow_submissions",
    "(missing)",
    "run has no full-workflow submission",
  ));
  return "corrupt";
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
  /**
   * Absent for the ordinary authored Persona, which is why this is optional rather than
   * `| null` at every call site: "created in the editor" is the common case and stating it
   * would be noise on every caller but one.
   */
  provenance?: PersonaProvenance | null;
}

/**
 * `provenance` is here and NOT on `UpdatePersona`, which is the point.
 *
 * A patch reaches this type from two directions: the browser's PATCH body, parsed by
 * `UpdatePersonaSchema`, and the manager's own re-import. Only the second may write
 * provenance - a browser that could put a path and a hash in a Persona edit could claim any
 * file as any Persona's upstream, and every later drift check would agree with it.
 */
export type PersonaPatch = Omit<UpdatePersona, "expectedRevision" | "name"> & {
  name?: string;
  normalizedName?: string;
  provenance?: PersonaProvenance | null;
};

type WorkflowDeliveryInsert = Pick<
  WorkflowDelivery,
  "id" | "runId" | "submissionId" | "kind" | "sessionId" | "noteKey" | "payload" | "payloadSha256"
> & {
  /** Required for `session_action` and refused for every other kind. */
  nodeAttemptId?: string | null;
};

export type PersonaStoreWrite =
  | { ok: true; persona: Persona }
  | {
      ok: false;
      /** `builtin` is "this Persona ships with the app", the one refusal a retry cannot clear. */
      reason: "not_found" | "revision_conflict" | "name_conflict" | "archived" | "builtin";
      current: Persona | null;
    };

export interface SessionActionInsert extends CreateSessionAction {
  id: string;
  normalizedName: string;
  createdAt: number;
  updatedAt: number;
}

export type SessionActionPatch =
  Omit<UpdateSessionAction, "expectedRevision" | "name"> & {
    name?: string;
    normalizedName?: string;
  };

/**
 * Deliberately the same refusal vocabulary as `PersonaStoreWrite`, not a wider one. The two
 * catalogs answer to the same CAS, name-reservation and built-in rules, and a route that had
 * to translate two error sets would be the place they quietly diverged.
 */
export type SessionActionStoreWrite =
  | { ok: true; action: SessionAction }
  | {
      ok: false;
      /** `builtin` is "this action ships with the app", the one refusal a retry cannot clear. */
      reason: "not_found" | "revision_conflict" | "name_conflict" | "archived" | "builtin";
      current: SessionAction | null;
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
      /** `builtin` is "this workflow ships with the app", the one refusal a retry cannot clear. */
      reason:
        | "not_found"
        | "revision_conflict"
        | "name_conflict"
        | "archived"
        | "not_archived"
        | "active_binding"
        | "builtin";
      current: WorkflowDefinition | null;
    };

/**
 * A hard delete cannot report the row it removed as live state, so it says so in its own
 * shape rather than borrowing `WorkflowStoreWrite`'s `workflow` - which every other caller
 * reads as "the definition as it now stands" and hands to `summary()` for an SSE upsert.
 * The removed row rides along only so the manager can name it in the `workflow_remove` event.
 */
export type WorkflowDeleteWrite =
  | { ok: true; workflow: WorkflowDefinition }
  | {
      ok: false;
      /** `published` and `builtin` are the two refusals a retry can never clear. */
      reason: "not_found" | "revision_conflict" | "published" | "builtin";
      current: WorkflowDefinition | null;
    };

export type WorkflowPublishWrite =
  | { ok: true; workflow: WorkflowDefinition; version: WorkflowVersion; idempotent: boolean }
  | {
      ok: false;
      reason: "not_found" | "revision_conflict" | "archived" | "validation" | "builtin";
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

/**
 * `triggerSource` is required on both inserts, not defaulted.
 *
 * It used to be a `manual` literal written inside the SQL, which meant a second caller was
 * one forgotten argument away from filing its runs as an operator's own. Making it a
 * required input costs each existing manual call site one explicit word and makes a missing
 * source a typecheck failure rather than a durable misattribution.
 */
export interface WorkflowRunInsert {
  id: string;
  binding: WorkflowBinding;
  triggerSource: WorkflowTriggerSource;
  triggerKey: string;
  now: number;
  /**
   * The artifact an externally sourced run is entitled to review, pinned INSIDE the creating
   * transaction.
   *
   * It is a field on the insert rather than a follow-up call because those are two halves of
   * one fact. Pinned afterwards, a crash in between leaves a run holding a submission but no
   * expected commit - and the retry, finding nothing pinned, would accept whatever commit it
   * was handed and review an artifact nobody originally selected. Committing them together
   * removes that state rather than coping with it.
   */
  externalExpectation?: WorkflowCaptureExpectation;
}

export interface WorkflowSubmissionInsert {
  id: string;
  runId: string;
  round: number;
  /**
   * Server-owned and absent from every caller outside the continuation transaction.
   *
   * An API client never chooses a segment. Omitting it means zero, which is the only value
   * an initial or repair submission may have, and the continuation transaction is the one
   * place that computes `parent.segment + 1`.
   */
  segment?: number;
  continuation?: {
    parentSubmissionId: string;
    nodeId: string;
    nodeAttemptId: string;
  };
  triggerSource: WorkflowTriggerSource;
  triggerKey: string;
  context: WorkflowJson;
  evidence: WorkflowJson;
  mode?: WorkflowSubmission["mode"];
  evidenceFingerprint?: string;
  prHeadSha?: string | null;
  status?: WorkflowSubmission["status"];
  now: number;
}

export interface WorkflowExternalClaimInput {
  sourceKind: WorkflowExternalSourceKind;
  sourceKey: string;
  sourceId: string;
  /** Used only when the claim is new. An existing claim keeps the binding it already owns. */
  binding: WorkflowBindingInsert;
  now: number;
}

export interface WorkflowRetentionResult {
  compactedRunIds: string[];
  deletedRunIds: string[];
  failedRunCount: number;
}

export type WorkflowExternalClaimResult =
  | { ok: true; claim: WorkflowBindingClaim; binding: WorkflowBinding; created: boolean }
  | {
      ok: false;
      reason: "note_conflict" | "binding_missing";
      /** The active binding that already owns the note key, when that is the reason. */
      conflict: WorkflowBinding | null;
    };

export interface WorkflowAttemptInsert {
  id: string;
  submissionId: string;
  nodeId: string;
  attempt: number;
  state: WorkflowNodeAttempt["state"];
  persona: WorkflowNodeAttempt["persona"];
  /** Required whenever `state` is `waiting`; refused beside a Persona snapshot. */
  sessionAction?: SessionActionSnapshot | null;
  /** The waiting attempt's initial observation state, written with the row. */
  sessionActionState?: SessionActionAttemptState | null;
  inputFingerprint: string;
  retryAt?: number | null;
  error?: string | null;
  now: number;
}

/** Everything the continuation transaction needs to reserve and seed one child segment. */
export interface WorkflowContinuationInput {
  /** The waiting action attempt whose completion authorizes this segment. */
  attemptId: string;
  /** The child submission's id, minted by the caller so recovery can find it again. */
  submissionId: string;
  triggerKey: string;
  now: number;
}

export type WorkflowContinuationReservation =
  | { ok: true; submission: WorkflowSubmission; parent: WorkflowSubmission; idempotent: boolean }
  | {
      ok: false;
      reason: "attempt_not_waiting" | "parent_superseded" | "run_terminal" | "already_continued";
    };

export interface ForemanCompletionStoreInput {
  /** Resolved by the manager before the claim is offered. A claim never creates a binding. */
  binding: WorkflowBinding;
  completionKind: "drain" | "prompted";
  marker: string;
  summary: string;
  evidenceFingerprint: string;
  expectedIntent: SessionIntentGuard | null;
  runId: string;
  submissionId: string;
  now: number;
}

export type ForemanCompletionStoreResult =
  | {
      result: Extract<
        import("@shared/workflow.ts").WorkflowCompletionClaimResult,
        { claimed: false }
      >;
      binding: WorkflowBinding;
      run: null;
      submission: null;
      created: false;
      previousFingerprint: undefined;
    }
  | {
      result: Exclude<
        import("@shared/workflow.ts").WorkflowCompletionClaimResult,
        { claimed: false }
      >;
      binding: WorkflowBinding;
      run: WorkflowRun;
      submission: WorkflowSubmission | null;
      created: boolean;
      previousFingerprint: string | undefined;
    };

export class WorkflowStore {
  /**
   * `builtins` is injectable for the contract tests, and defaults to what this build ships.
   *
   * It is a constructor parameter rather than a module-level read inside each method so a
   * test can prove the merge rules on a catalog it authored, without the four real documents
   * deciding what "a name an operator already took" means.
   */
  constructor(
    private readonly db: DatabaseSync = openDb(),
    private readonly builtins: readonly Persona[] = BUILTIN_PERSONAS,
    /** Injectable for the same reason `builtins` is: the merge rules are provable on a
     * fabricated catalog, so they do not depend on what the shipped graph happens to say. */
    private readonly builtinWorkflows: readonly BuiltinWorkflow[] = BUILTIN_WORKFLOWS,
    private readonly builtinActions: readonly SessionAction[] = BUILTIN_SESSION_ACTIONS,
    /**
     * Which completion adapters this build can EXECUTE. Injectable for the reason the two
     * catalogs above are: the publish transaction's snapshot and atomicity rules have to be
     * provable without depending on which adapters happen to be shipping.
     *
     * A per-adapter map rather than the single boolean this replaced. Publishing is now a
     * question about the proof an action selected, not about the runtime as a whole: a
     * `session_turn` graph runs today while a `pull_request` graph is still refused, and one
     * flag cannot express both.
     */
    private readonly sessionActionCompletions: Record<
      SessionActionCompletionKind,
      Pick<SessionActionCompletionCapability, "available" | "unavailableReason">
    > = SESSION_ACTION_COMPLETION_CAPABILITIES,
  ) {}

  /**
   * The one draft validation, so the library card, the diagnostics route and Publish cannot
   * answer differently about the same draft.
   *
   * `catalogs` is optional only so Publish can pass the lists it already read INSIDE its own
   * transaction; every other caller reads them here.
   */
  validateDraft(
    workflow: Pick<WorkflowDefinition, "draft" | "completionPolicy">,
    catalogs?: { personas: readonly Persona[]; sessionActions: readonly SessionAction[] },
  ): WorkflowValidationResult {
    return validateWorkflowGraph({
      graph: workflow.draft,
      personas: catalogs?.personas ?? this.personaCatalog(),
      sessionActions: catalogs?.sessionActions ?? this.sessionActionCatalog(),
      completionPolicy: workflow.completionPolicy,
      sessionActionCompletionCapabilities: this.sessionActionCompletions,
    });
  }

  /**
   * Merge the shipped Personas into a set of rows.
   *
   * A stored Persona whose normalized name matches a built-in SHADOWS it, and that is a
   * migration accommodation with a narrow cause: an operator who imported one of these
   * documents by hand before it shipped built-in reserved that name durably, and their copy
   * - which they may have edited, and which their published versions name - has to keep it.
   * `create` and rename refuse a built-in's name, so no new shadow can appear. The shadowed
   * built-in stays addressable by id, because a draft or version may already point at it.
   *
   * Only a LIVE row shadows. Two reasons, and the second is a bug this shape rules out: an
   * archived Persona is retired, so it should not keep a shipped role out of new stages; and
   * counting archived rows would make `listPersonas(true)` drop a built-in that
   * `listPersonas(false)` still lists, so the archived listing - which is what the SSE
   * snapshot is built from - would stop being a superset of the active one.
   */
  private sortPersonas(personas: Persona[]): Persona[] {
    return personas.sort((a, b) =>
      a.normalizedName.localeCompare(b.normalizedName, "en-US") || a.id.localeCompare(b.id));
  }

  private withBuiltins(rows: Persona[]): Persona[] {
    return this.sortPersonas(
      personasForDisplay(rows.concat(this.builtins)),
    );
  }

  private withAddressableBuiltins(rows: Persona[]): Persona[] {
    return this.sortPersonas(rows.concat(this.builtins));
  }

  private builtinPersona(id: string): Persona | null {
    return this.builtins.find((persona) => persona.id === id) ?? null;
  }

  private builtinPersonaNamed(normalizedName: string): Persona | null {
    return this.builtins.find((persona) => persona.normalizedName === normalizedName) ?? null;
  }

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
    // Built-ins are never archived, so they belong in both listings.
    return this.withBuiltins(out);
  }

  /**
   * Return every Persona that a durable draft may address.
   *
   * Unlike `listPersonas`, this catalog never applies live-row name shadowing. Shadowing is
   * only a display rule, while validation and Publish must continue resolving every built-in
   * id that may already be stored in a draft.
   */
  personaCatalog(): Persona[] {
    const rows = this.db
      .prepare(`SELECT * FROM personas ORDER BY normalized_name ASC, id ASC`)
      .all() as unknown[];
    const out: Persona[] = [];
    for (const row of rows) {
      try {
        out.push(parsePersonaRow(row));
      } catch (error) {
        diagnose(error);
      }
    }
    return this.withAddressableBuiltins(out);
  }

  getPersona(id: string): Persona | null {
    const row = this.db.prepare(`SELECT * FROM personas WHERE id = ?`).get(id);
    if (!row) return this.builtinPersona(id);
    try {
      return parsePersonaRow(row);
    } catch (error) {
      diagnose(error);
      return null;
    }
  }

  insertPersona(input: PersonaInsert): PersonaStoreWrite {
    return transaction(this.db, () => {
      const shipped = this.builtinPersona(input.id);
      if (shipped) return { ok: false, reason: "builtin", current: shipped };
      const named = this.builtinPersonaNamed(input.normalizedName);
      if (named) return { ok: false, reason: "name_conflict", current: named };
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
             revision, archived_at, created_at, updated_at, import_provenance_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?)`,
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
          serializePersonaProvenance(input.provenance ?? null),
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
      const shipped = this.builtinPersona(id);
      if (shipped) return { ok: false, reason: "builtin", current: shipped };
      const current = this.getPersonaInTransaction(id);
      if (!current) return { ok: false, reason: "not_found", current: null };
      if (current.archivedAt !== null) return { ok: false, reason: "archived", current };
      if (current.revision !== expectedRevision) {
        return { ok: false, reason: "revision_conflict", current };
      }
      if (patch.normalizedName !== undefined) {
        const named = this.builtinPersonaNamed(patch.normalizedName);
        if (named && named.normalizedName !== current.normalizedName) {
          return { ok: false, reason: "name_conflict", current: named };
        }
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
      // Presence, not truthiness, exactly like the two above: a re-import always names its new
      // provenance, and "no key" is how every other write says it is not touching this column.
      if ("provenance" in patch) {
        add("import_provenance_json", serializePersonaProvenance(patch.provenance ?? null));
      }
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
      const shipped = this.builtinPersona(id);
      if (shipped) return { ok: false, reason: "builtin", current: shipped };
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

  // ---- SessionActions ----
  //
  // The same five rules as Personas above, stated again rather than shared through a generic
  // helper. The two tables have different columns, different limits and a different strictness
  // on read (`completion_kind` fails the row where `runner_id` degrades), so a shared
  // implementation would be a parameter list longer than either method and would put the one
  // asymmetry that matters behind a flag.

  private sortSessionActions(actions: SessionAction[]): SessionAction[] {
    return actions.sort((a, b) =>
      a.normalizedName.localeCompare(b.normalizedName, "en-US") || a.id.localeCompare(b.id));
  }

  private withBuiltinActions(rows: SessionAction[]): SessionAction[] {
    return this.sortSessionActions(sessionActionsForDisplay(rows.concat(this.builtinActions)));
  }

  private withAddressableBuiltinActions(rows: SessionAction[]): SessionAction[] {
    return this.sortSessionActions(rows.concat(this.builtinActions));
  }

  private builtinSessionAction(id: string): SessionAction | null {
    return this.builtinActions.find((action) => action.id === id) ?? null;
  }

  private builtinSessionActionNamed(normalizedName: string): SessionAction | null {
    return this.builtinActions.find((action) => action.normalizedName === normalizedName) ?? null;
  }

  listSessionActions(includeArchived = false): SessionAction[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM session_actions
          ${includeArchived ? "" : "WHERE archived_at IS NULL"}
         ORDER BY normalized_name ASC, id ASC`,
      )
      .all() as unknown[];
    const out: SessionAction[] = [];
    for (const row of rows) {
      try {
        out.push(parseSessionActionRow(row));
      } catch (error) {
        diagnose(error);
      }
    }
    // Built-ins are never archived, so they belong in both listings.
    return this.withBuiltinActions(out);
  }

  /**
   * Every SessionAction a durable draft may address.
   *
   * Unlike `listSessionActions`, this catalog never applies live-row name shadowing.
   * Shadowing is only a display rule, while validation and Publish must continue resolving
   * every built-in id that may already be stored in a draft.
   */
  sessionActionCatalog(): SessionAction[] {
    const rows = this.db
      .prepare(`SELECT * FROM session_actions ORDER BY normalized_name ASC, id ASC`)
      .all() as unknown[];
    const out: SessionAction[] = [];
    for (const row of rows) {
      try {
        out.push(parseSessionActionRow(row));
      } catch (error) {
        diagnose(error);
      }
    }
    return this.withAddressableBuiltinActions(out);
  }

  getSessionAction(id: string): SessionAction | null {
    const row = this.db.prepare(`SELECT * FROM session_actions WHERE id = ?`).get(id);
    if (!row) return this.builtinSessionAction(id);
    try {
      return parseSessionActionRow(row);
    } catch (error) {
      diagnose(error);
      return null;
    }
  }

  insertSessionAction(input: SessionActionInsert): SessionActionStoreWrite {
    return transaction(this.db, () => {
      const shipped = this.builtinSessionAction(input.id);
      if (shipped) return { ok: false, reason: "builtin", current: shipped };
      const named = this.builtinSessionActionNamed(input.normalizedName);
      if (named) return { ok: false, reason: "name_conflict", current: named };
      const conflict = this.db
        .prepare(`SELECT * FROM session_actions WHERE normalized_name = ?`)
        .get(input.normalizedName);
      if (conflict) {
        let current: SessionAction | null = null;
        try {
          current = parseSessionActionRow(conflict);
        } catch (error) {
          diagnose(error);
        }
        return { ok: false, reason: "name_conflict", current };
      }
      this.db
        .prepare(
          `INSERT INTO session_actions (
             id, name, normalized_name, description, prompt_md, required_skill_id,
             completion_kind, revision, archived_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)`,
        )
        .run(
          input.id,
          input.name,
          input.normalizedName,
          input.description,
          input.promptMarkdown,
          input.requiredSkillId,
          input.completion.kind,
          input.createdAt,
          input.updatedAt,
        );
      return { ok: true, action: this.mustSessionAction(input.id) };
    });
  }

  updateSessionActionCas(
    id: string,
    expectedRevision: number,
    patch: SessionActionPatch,
    updatedAt = Date.now(),
  ): SessionActionStoreWrite {
    return transaction(this.db, () => {
      const shipped = this.builtinSessionAction(id);
      if (shipped) return { ok: false, reason: "builtin", current: shipped };
      const current = this.getSessionActionInTransaction(id);
      if (!current) return { ok: false, reason: "not_found", current: null };
      if (current.archivedAt !== null) return { ok: false, reason: "archived", current };
      if (current.revision !== expectedRevision) {
        return { ok: false, reason: "revision_conflict", current };
      }
      if (patch.normalizedName !== undefined) {
        const named = this.builtinSessionActionNamed(patch.normalizedName);
        if (named && named.normalizedName !== current.normalizedName) {
          return { ok: false, reason: "name_conflict", current: named };
        }
        const conflict = this.db
          .prepare(`SELECT id FROM session_actions WHERE normalized_name = ? AND id <> ?`)
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
      if (patch.promptMarkdown !== undefined) add("prompt_md", patch.promptMarkdown);
      if ("requiredSkillId" in patch) add("required_skill_id", patch.requiredSkillId ?? null);
      if (patch.completion !== undefined) add("completion_kind", patch.completion.kind);
      assignments.push("revision = revision + 1", "updated_at = ?");
      values.push(updatedAt, id, expectedRevision);
      const result = this.db
        .prepare(
          `UPDATE session_actions SET ${assignments.join(", ")}
            WHERE id = ? AND revision = ? AND archived_at IS NULL`,
        )
        .run(...values);
      if (Number(result.changes) !== 1) {
        const latest = this.getSessionActionInTransaction(id);
        return { ok: false, reason: "revision_conflict", current: latest };
      }
      return { ok: true, action: this.mustSessionAction(id) };
    });
  }

  /**
   * Soft archive. The row STAYS, and keeps its name reserved.
   *
   * Both halves are load-bearing here in a way they are not for a reviewer: a draft or a
   * published version may name this action, and history has to keep resolving the id it
   * snapshotted. Releasing the name would let a second action claim the identity an
   * operator's version reports as its source.
   */
  archiveSessionActionCas(
    id: string,
    expectedRevision: number,
    archivedAt = Date.now(),
  ): SessionActionStoreWrite {
    return transaction(this.db, () => {
      const shipped = this.builtinSessionAction(id);
      if (shipped) return { ok: false, reason: "builtin", current: shipped };
      const current = this.getSessionActionInTransaction(id);
      if (!current) return { ok: false, reason: "not_found", current: null };
      if (current.archivedAt !== null) return { ok: false, reason: "archived", current };
      if (current.revision !== expectedRevision) {
        return { ok: false, reason: "revision_conflict", current };
      }
      const result = this.db
        .prepare(
          `UPDATE session_actions
              SET archived_at = ?, updated_at = ?, revision = revision + 1
            WHERE id = ? AND revision = ? AND archived_at IS NULL`,
        )
        .run(archivedAt, archivedAt, id, expectedRevision);
      if (Number(result.changes) !== 1) {
        const latest = this.getSessionActionInTransaction(id);
        return { ok: false, reason: "revision_conflict", current: latest };
      }
      return { ok: true, action: this.mustSessionAction(id) };
    });
  }

  private getSessionActionInTransaction(id: string): SessionAction | null {
    const row = this.db.prepare(`SELECT * FROM session_actions WHERE id = ?`).get(id);
    return row ? parseSessionActionRow(row) : null;
  }

  private mustSessionAction(id: string): SessionAction {
    const action = this.getSessionActionInTransaction(id);
    if (!action) {
      throw new Error(`Session action ${id} disappeared during a workflow transaction`);
    }
    return action;
  }

  /**
   * The shipped workflows, in the same shape a row parses into.
   *
   * Read through a method rather than a field so a caller cannot accidentally hold the
   * definition of a version list it did not also consult.
   */
  private builtinWorkflowDefinitions(): WorkflowDefinition[] {
    return this.builtinWorkflows.map((builtin) => builtin.definition);
  }

  private sortWorkflows(workflows: WorkflowDefinition[]): WorkflowDefinition[] {
    return workflows.sort((a, b) =>
      a.normalizedName.localeCompare(b.normalizedName, "en-US") || a.id.localeCompare(b.id));
  }

  private builtinWorkflowById(id: string): BuiltinWorkflow | null {
    return this.builtinWorkflows.find((builtin) => builtin.definition.id === id) ?? null;
  }

  private builtinWorkflowNamed(normalizedName: string): WorkflowDefinition | null {
    return this.builtinWorkflows
      .find((builtin) => builtin.definition.normalizedName === normalizedName)?.definition ?? null;
  }

  private builtinWorkflowVersion(id: string): WorkflowVersion | null {
    for (const builtin of this.builtinWorkflows) {
      const version = builtin.versions.find((candidate) => candidate.id === id);
      if (version) return version;
    }
    return null;
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
    // Built-ins are never archived, so they belong in both listings - which is what keeps the
    // archived listing, the one the SSE snapshot is built from, a superset of the active one.
    return this.sortWorkflows(
      workflowsForDisplay(out.concat(this.builtinWorkflowDefinitions())),
    );
  }

  /**
   * Every workflow a durable binding or run may address.
   *
   * Unlike `listWorkflows`, this catalog never applies live-row name shadowing. Shadowing is
   * a display rule only: a binding pinned to a built-in version has to keep resolving even
   * while an operator's same-named workflow is what the library shows under that name.
   */
  workflowCatalog(): WorkflowDefinition[] {
    const rows = this.db
      .prepare(`SELECT * FROM workflow_definitions ORDER BY normalized_name ASC, id ASC`)
      .all() as unknown[];
    const out: WorkflowDefinition[] = [];
    for (const row of rows) {
      try {
        out.push(parseWorkflowDefinitionRow(row));
      } catch (error) {
        diagnose(error);
      }
    }
    return this.sortWorkflows(out.concat(this.builtinWorkflowDefinitions()));
  }

  getWorkflow(id: string): WorkflowDefinition | null {
    const row = this.db.prepare(`SELECT * FROM workflow_definitions WHERE id = ?`).get(id);
    if (!row) return this.builtinWorkflowById(id)?.definition ?? null;
    try {
      return parseWorkflowDefinitionRow(row);
    } catch (error) {
      diagnose(error);
      return null;
    }
  }

  insertWorkflow(input: WorkflowInsert): WorkflowStoreWrite {
    return transaction(this.db, () => {
      const shipped = this.builtinWorkflowById(input.id);
      if (shipped) return { ok: false, reason: "builtin", current: shipped.definition };
      const named = this.builtinWorkflowNamed(input.normalizedName);
      if (named) return { ok: false, reason: "name_conflict", current: named };
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
           completion_policy_json, resumption_policy, binding_defaults_json, draft_revision,
           current_version_id, archived_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL, ?, ?)`,
      ).run(
        input.id,
        input.name,
        input.normalizedName,
        input.description,
        JSON.stringify(input.draft),
        JSON.stringify(input.completionPolicy),
        input.resumptionPolicy,
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
      const shipped = this.builtinWorkflowById(id);
      if (shipped) return { ok: false, reason: "builtin", current: shipped.definition };
      const current = this.getWorkflowInTransaction(id);
      if (!current) return { ok: false, reason: "not_found", current: null };
      if (current.archivedAt !== null) return { ok: false, reason: "archived", current };
      if (current.draftRevision !== expectedDraftRevision) {
        return { ok: false, reason: "revision_conflict", current };
      }
      if (patch.normalizedName !== undefined) {
        const named = this.builtinWorkflowNamed(patch.normalizedName);
        if (named && named.normalizedName !== current.normalizedName) {
          return { ok: false, reason: "name_conflict", current: named };
        }
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
      if (patch.resumptionPolicy !== undefined) add("resumption_policy", patch.resumptionPolicy);
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
      // Before the active-binding join below, and that ordering is load-bearing: a built-in
      // has no version ROWS, so that join cannot see the bindings it holds and would report
      // "no active binding" about a workflow an operator is running right now.
      const shipped = this.builtinWorkflowById(id);
      if (shipped) return { ok: false, reason: "builtin", current: shipped.definition };
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

  /**
   * Lift an archive.
   *
   * There is no name conflict to resolve and no check for one, because
   * `idx_workflow_definitions_normalized_name` covers archived rows too: archiving never
   * released the name, so nothing can have taken it meanwhile. That is the same reservation
   * Phase 1 chose deliberately for Personas, read from the other direction - it is what makes
   * restoring safe rather than a second identity claiming a live one's name.
   *
   * `not_archived` is a distinct refusal rather than a silent success so a double-click from
   * two tabs reports what actually happened instead of bumping the revision twice.
   */
  unarchiveWorkflowCas(id: string, expectedDraftRevision: number, updatedAt = Date.now()): WorkflowStoreWrite {
    return transaction(this.db, () => {
      // Before the row read, or a built-in - which owns no row - would be refused as
      // `not_found`, which is a sentence about a workflow the operator is looking at.
      const shipped = this.builtinWorkflowById(id);
      if (shipped) return { ok: false, reason: "builtin", current: shipped.definition };
      const current = this.getWorkflowInTransaction(id);
      if (!current) return { ok: false, reason: "not_found", current: null };
      if (current.archivedAt === null) return { ok: false, reason: "not_archived", current };
      if (current.draftRevision !== expectedDraftRevision) {
        return { ok: false, reason: "revision_conflict", current };
      }
      const result = this.db.prepare(
        `UPDATE workflow_definitions
            SET archived_at = NULL, updated_at = ?, draft_revision = draft_revision + 1
          WHERE id = ? AND draft_revision = ? AND archived_at IS NOT NULL`,
      ).run(updatedAt, id, expectedDraftRevision);
      if (Number(result.changes) !== 1) {
        return { ok: false, reason: "revision_conflict", current: this.getWorkflowInTransaction(id) };
      }
      return { ok: true, workflow: this.mustWorkflow(id) };
    });
  }

  /**
   * Remove a never-published workflow, row and all.
   *
   * The `published` guard is the entire reason this is ONE `DELETE` and not the eleven-table
   * walk `runRetention` performs below. `workflow_bindings.workflow_version_id` and
   * `workflow_runs.workflow_version_id` are both `NOT NULL` and both name a `workflow_versions`
   * row, so a workflow with no versions can have no binding; no binding means no run, and no
   * run means no submission, attempt, edge receipt, delivery, LLM call or event. Nothing is
   * orphaned here because nothing can exist to orphan - which matters because this family
   * declares no foreign keys, so SQLite would not have stopped us. Ensembles reach a workflow
   * only through a PUBLISHED version (`EnsembleManager.resolveWorkflowVersion` refuses
   * anything else), so `ensemble_runs.workflow_handoff_json` cannot name one of these either.
   *
   * Publish once and this refuses for good. An immutable version is audit history that
   * bindings, runs and ensemble handoffs quote by id, and archive stays the way to retire it.
   * The asymmetry is the feature: it is what keeps "delete" from ever meaning "rewrite the
   * record of what already ran".
   */
  deleteWorkflowCas(id: string, expectedDraftRevision: number): WorkflowDeleteWrite {
    return transaction(this.db, () => {
      // Before the `published` guard below. That guard would refuse a built-in anyway, since
      // one always names a current version - but it would say "publish once and this refuses
      // for good" about a workflow the operator never published, which sends them looking for
      // an archive they cannot take either.
      const shipped = this.builtinWorkflowById(id);
      if (shipped) return { ok: false, reason: "builtin", current: shipped.definition };
      const current = this.getWorkflowInTransaction(id);
      if (!current) return { ok: false, reason: "not_found", current: null };
      if (current.draftRevision !== expectedDraftRevision) {
        return { ok: false, reason: "revision_conflict", current };
      }
      // Both halves deliberately. `current_version_id` is the cheap pointer, the table is the
      // truth, and a row whose pointer was somehow cleared must still not lose its history.
      const published = current.currentVersionId !== null
        || this.db.prepare(`SELECT 1 FROM workflow_versions WHERE workflow_id = ? LIMIT 1`).get(id);
      if (published) return { ok: false, reason: "published", current };
      const result = this.db.prepare(
        `DELETE FROM workflow_definitions WHERE id = ? AND draft_revision = ?`,
      ).run(id, expectedDraftRevision);
      if (Number(result.changes) !== 1) {
        return { ok: false, reason: "revision_conflict", current: this.getWorkflowInTransaction(id) };
      }
      return { ok: true, workflow: current };
    });
  }

  /** Newest first, matching the row query, so a caller cannot tell a built-in from a row. */
  private builtinVersionsNewestFirst(workflowId: string): WorkflowVersion[] | null {
    const builtin = this.builtinWorkflowById(workflowId);
    return builtin ? [...builtin.versions].reverse() : null;
  }

  listWorkflowVersions(workflowId: string): WorkflowVersion[] {
    const shipped = this.builtinVersionsNewestFirst(workflowId);
    if (shipped) return shipped;
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
    const shipped = this.builtinVersionsNewestFirst(workflowId);
    if (shipped) return shipped.map(({ graph: _graph, ...metadata }) => metadata);
    const rows = this.db.prepare(
      `SELECT id, workflow_id, version, source_draft_revision,
              completion_policy_json, resumption_policy, binding_defaults_json, published_at
         FROM workflow_versions WHERE workflow_id = ? ORDER BY version DESC`,
    ).all(workflowId) as unknown[];
    const out: WorkflowVersionMetadata[] = [];
    for (const row of rows) {
      try { out.push(parseWorkflowVersionMetadataRow(row)); } catch (error) { diagnose(error); }
    }
    return out;
  }

  getWorkflowVersion(workflowId: string, version: number): WorkflowVersion | null {
    const builtin = this.builtinWorkflowById(workflowId);
    if (builtin) {
      return builtin.versions.find((candidate) => candidate.version === version) ?? null;
    }
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
      // A built-in arrives published. Refusing here rather than at the route is what stops a
      // second caller from minting a row version against an id that owns no rows.
      const shipped = this.builtinWorkflowById(id);
      if (shipped) return { ok: false, reason: "builtin", current: shipped.definition };
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
      // BOTH catalogs read inside this transaction, and the snapshots below are taken from
      // these exact lists. Re-reading either after validation would open the window this
      // whole method exists to close: an action archived between the two reads would pass
      // validation and then be frozen into an immutable version as a live source.
      const personas = this.listPersonasInTransaction();
      const sessionActions = this.listSessionActionsInTransaction();
      const validation = this.validateDraft(workflow, { personas, sessionActions });
      if (!validation.valid) {
        return { ok: false, reason: "validation", current: workflow, diagnostics: validation.diagnostics };
      }
      const personaMap = new Map(personas.map((persona) => [persona.id, persona]));
      const actionMap = new Map(sessionActions.map((action) => [action.id, action]));
      const graph = {
        nodes: workflow.draft.nodes.map((node) => {
          if (node.kind === "session_action") {
            const action = actionMap.get(node.sessionActionId);
            if (!action || action.archivedAt !== null) {
              throw new Error(
                `validated session action ${node.sessionActionId} disappeared during Publish`,
              );
            }
            return {
              id: node.id,
              kind: "session_action" as const,
              position: node.position,
              action: sessionActionSnapshotOf(action),
            };
          }
          if (node.kind !== "persona") return node;
          const persona = personaMap.get(node.personaId);
          if (!persona || persona.archivedAt !== null) {
            throw new Error(`validated Persona ${node.personaId} disappeared during Publish`);
          }
          return {
            id: node.id,
            kind: "persona" as const,
            position: node.position,
            persona: personaSnapshotOf(persona),
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
           completion_policy_json, resumption_policy, binding_defaults_json, published_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        versionId,
        id,
        next,
        expectedDraftRevision,
        JSON.stringify(graph),
        JSON.stringify(workflow.completionPolicy),
        // Frozen from the draft at publish time, exactly like the completion policy: a later
        // edit to the draft must not change how a version already bound behaves.
        workflow.resumptionPolicy,
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
    const validation = this.validateDraft(workflow);
    // A built-in owns no version rows, so the row lookup below would report it unpublished -
    // which reads on the card as a shipped workflow nobody can bind.
    const current = workflow.currentVersionId === null
      ? null
      : workflow.builtin
        ? this.builtinWorkflowVersion(workflow.currentVersionId) ?? undefined
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
      builtin: workflow.builtin,
    };
  }

  /**
   * The one resolver every binding and every run goes through.
   *
   * It consults the catalog with no shadowing applied, because a binding holding a built-in
   * version id must resolve even when an operator's same-named workflow is hiding the
   * built-in from the library listing.
   */
  getWorkflowVersionById(id: string): WorkflowVersion | null {
    const row = this.db.prepare(`SELECT * FROM workflow_versions WHERE id = ?`).get(id);
    if (!row) return this.builtinWorkflowVersion(id);
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

  claimBySourceKey(sourceKey: string): WorkflowBindingClaim | null {
    const row = this.db.prepare(
      `SELECT * FROM workflow_binding_claims WHERE source_key = ?`,
    ).get(sourceKey);
    if (!row) return null;
    try { return parseWorkflowBindingClaimRow(row); } catch (error) { diagnose(error); return null; }
  }

  claimForBinding(bindingId: string): WorkflowBindingClaim | null {
    const row = this.db.prepare(
      `SELECT * FROM workflow_binding_claims WHERE binding_id = ?`,
    ).get(bindingId);
    if (!row) return null;
    try { return parseWorkflowBindingClaimRow(row); } catch (error) { diagnose(error); return null; }
  }

  /**
   * Resolve one external orchestrator's claim, creating the claim and its binding together
   * or returning exactly what an earlier call created.
   *
   * One transaction because the two halves are one fact: a claim pointing at a binding that
   * was never inserted, or a binding no claim can find again, would each make the retry
   * create a second review of the same result. `BEGIN IMMEDIATE` takes the write lock before
   * the conflict check, so the check and the insert cannot interleave with a concurrent
   * caller inside this single-writer daemon.
   *
   * An active binding already owning that conversation is a TYPED CONFLICT, never an
   * adoption: silently taking it over would point somebody else's run at this result, and
   * silently replacing it would discard a review an operator started.
   */
  ensureExternalBindingClaim(input: WorkflowExternalClaimInput): WorkflowExternalClaimResult {
    return transaction(this.db, () => {
      const existing = this.claimBySourceKey(input.sourceKey);
      if (existing) {
        const binding = this.getBinding(existing.bindingId);
        return binding
          ? { ok: true as const, claim: existing, binding, created: false }
          : { ok: false as const, reason: "binding_missing" as const, conflict: null };
      }
      const conflict = this.activeBindingForNote(input.binding.noteKey);
      if (conflict) return { ok: false as const, reason: "note_conflict" as const, conflict };
      const binding = this.insertBinding(input.binding);
      this.db.prepare(
        `INSERT INTO workflow_binding_claims (
           source_key, source_kind, source_id, binding_id, created_at
         ) VALUES (?, ?, ?, ?, ?)`,
      ).run(input.sourceKey, input.sourceKind, input.sourceId, binding.id, input.now);
      const claim = this.claimBySourceKey(input.sourceKey);
      if (!claim) throw new Error(`Workflow binding claim ${input.sourceKey} disappeared after insert`);
      return { ok: true as const, claim, binding, created: true };
    });
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
      `${WORKFLOW_RUN_SUMMARY_SELECT}
       ORDER BY r.updated_at DESC, r.id DESC`,
    ).all() as unknown as Array<Record<string, unknown>>;
    return this.runSummariesFromRows(rows);
  }

  listRunSummaryPage(input: {
    limit: number;
    cursor: RunCursor | null;
    status?: WorkflowRun["status"];
    workflowId?: string;
    session?: string;
  }): WorkflowRunPage {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (input.cursor) {
      where.push(`(r.updated_at < ? OR (r.updated_at = ? AND r.id < ?))`);
      params.push(input.cursor.updatedAt, input.cursor.updatedAt, input.cursor.id);
    }
    if (input.status) {
      where.push(`r.status = ?`);
      params.push(input.status);
    }
    if (input.workflowId) {
      // A built-in owns no version rows, so `d.id` is NULL on every run it ever produced and
      // filtering the join column would report the shipped workflow as having no history.
      // Its runs are named by the synthetic version ids they pinned instead.
      const shipped = this.builtinWorkflowById(input.workflowId);
      if (shipped) {
        const ids = shipped.versions.map((version) => version.id);
        where.push(ids.length > 0
          ? `r.workflow_version_id IN (${ids.map(() => "?").join(", ")})`
          : "0");
        params.push(...ids);
      } else {
        where.push(
          `r.workflow_version_id IN (
             SELECT id FROM workflow_versions WHERE workflow_id = ?
           )`,
        );
        params.push(input.workflowId);
      }
    }
    if (input.session) {
      where.push(`(b.session_id = ? OR b.note_key = ?)`);
      params.push(input.session, input.session);
    }
    params.push(input.limit + 1);
    const rows = this.db.prepare(
      `${WORKFLOW_RUN_SUMMARY_SELECT}
       ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY r.updated_at DESC, r.id DESC
       LIMIT ?`,
    ).all(...params) as unknown as Array<Record<string, unknown>>;
    const pageRows = rows.slice(0, input.limit);
    const items = this.runSummariesFromRows(pageRows);
    const hasMore = rows.length > input.limit;
    const last = pageRows.at(-1);
    const lastUpdatedAt = Number(last?.updated_at);
    const lastId = typeof last?.id === "string" ? last.id : null;
    return {
      items,
      // Advance by the durable row, even if its nested JSON was malformed and the
      // summary mapper skipped it. One bad row may shorten this page, but it cannot
      // pin the cursor or hide every valid row after it.
      nextCursor: hasMore && Number.isSafeInteger(lastUpdatedAt) && lastId
        ? encodeWorkflowRunCursor({ updatedAt: lastUpdatedAt, id: lastId })
        : null,
    };
  }

  runSummary(id: string): WorkflowRunSummary | null {
    const row = this.db.prepare(
      `${WORKFLOW_RUN_SUMMARY_SELECT}
       WHERE r.id = ?`,
    ).get(id) as Record<string, unknown> | undefined;
    return row ? this.runSummariesFromRows([row])[0] ?? null : null;
  }

  private runSummariesFromRows(rows: Array<Record<string, unknown>>): WorkflowRunSummary[] {
    const submissionIds = rows.flatMap((row) =>
      typeof row.latest_submission_id === "string" ? [row.latest_submission_id] : []);
    const { attemptsBySubmission, corruptSubmissionIds } =
      this.summaryAttemptsForSubmissions(submissionIds);
    return rows.flatMap((row) => {
      const submissionId = typeof row.latest_submission_id === "string"
        ? row.latest_submission_id
        : null;
      if (submissionId && corruptSubmissionIds.has(submissionId)) return [];
      const summary = this.runSummaryFromRow(
        row,
        submissionId ? attemptsBySubmission.get(submissionId) ?? [] : [],
      );
      return summary ? [summary] : [];
    });
  }

  private summaryAttemptsForSubmissions(submissionIds: string[]): {
    attemptsBySubmission: Map<string, WorkflowNodeAttempt[]>;
    corruptSubmissionIds: Set<string>;
  } {
    const attemptsBySubmission = new Map<string, WorkflowNodeAttempt[]>();
    const corruptSubmissionIds = new Set<string>();
    // Stay below SQLite builds with a conservative host-parameter limit while keeping a
    // normal 50-row page to one statement.
    for (let offset = 0; offset < submissionIds.length; offset += 400) {
      const chunk = submissionIds.slice(offset, offset + 400);
      const rows = this.db.prepare(
        `SELECT * FROM workflow_node_attempts
          WHERE submission_id IN (${chunk.map(() => "?").join(", ")})
          ORDER BY submission_id ASC, created_at ASC, node_id ASC, attempt ASC`,
      ).all(...chunk) as unknown as Array<Record<string, unknown>>;
      for (const row of rows) {
        try {
          const attempt = parseWorkflowNodeAttemptRow(row);
          const attempts = attemptsBySubmission.get(attempt.submissionId) ?? [];
          attempts.push(attempt);
          attemptsBySubmission.set(attempt.submissionId, attempts);
        } catch (error) {
          diagnose(error);
          if (typeof row.submission_id === "string") corruptSubmissionIds.add(row.submission_id);
        }
      }
    }
    return { attemptsBySubmission, corruptSubmissionIds };
  }

  private runSummaryFromRow(
    row: Record<string, unknown>,
    submissionAttempts: WorkflowNodeAttempt[],
  ): WorkflowRunSummary | null {
    try {
      const run = parseWorkflowRunRow(row);
      const claim = externalSourceFromRow(row);
      const latestAttempts = new Map<string, WorkflowNodeAttempt>();
      for (const attempt of submissionAttempts) {
        latestAttempts.set(attempt.nodeId, attempt);
      }
      const attempts = [...latestAttempts.values()];
      const gateState = inspectorGateState(run);
      const gatePrNumber = gateState?.prKey
        ? Number(gateState.prKey.match(/#(\d+)$/)?.[1] ?? NaN)
        : NaN;
      // The joins above reach rows, and a built-in has none - so a run of the shipped
      // workflow arrives here looking exactly like one whose version was deleted. Resolve it
      // from the catalog before reading that absence as "Missing workflow version".
      const shipped = typeof row.workflow_id === "string"
        ? null
        : this.builtinWorkflowVersion(run.workflowVersionId);
      const shippedName = shipped
        ? this.builtinWorkflowById(shipped.workflowId)?.definition.name ?? null
        : null;
      return {
        id: run.id,
        bindingId: run.bindingId,
        workflowId: typeof row.workflow_id === "string"
          ? row.workflow_id
          : shipped?.workflowId ?? `missing:${run.workflowVersionId}`,
        workflowName: typeof row.workflow_name === "string"
          ? row.workflow_name
          : shippedName ?? "Missing workflow version",
        workflowVersion: Number(row.workflow_version ?? shipped?.version ?? 0),
        sessionId: typeof row.session_id === "string" ? row.session_id : null,
        noteKey: String(row.note_key),
        // Spread rather than set, for the same reason `externalSource` below is: the binding
        // coalesces an unnamed session to `''` on write, and an empty string on every
        // summary of every run on every change is bytes bought for nothing. The value is the
        // binding's own captured title, which OUTLIVES the session - a run whose session was
        // removed has no other human name left.
        ...(typeof row.session_name === "string" && row.session_name
          ? { sessionName: row.session_name }
          : {}),
        status: run.status,
        phase: run.currentPhase,
        // `MAX(s.round)` and never a count of submissions: a repair round may now hold
        // several evidence segments, so counting rows would inflate the number the repair
        // budget is compared against.
        round: Number(row.current_round),
        segment: Number(row.latest_segment ?? 0),
        // Derived once, HERE, from the attempt the runtime is actually watching. A surface
        // that re-derived it from session activity would be guessing at the one distinction
        // this phase exists to make - a stale idle is not a finished turn.
        actionWait: attempts
          .flatMap((attempt) =>
            attempt.state === "waiting" ? [this.sessionActionState(attempt)?.wait] : [])
          .find((wait) => wait !== undefined) ?? null,
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
        bypassedPersonaReview: Number(row.bypassed_persona_review ?? 0) === 1,
        // Spread rather than set, so a summary for a run nobody claimed carries no key at
        // all. Summaries travel over SSE for EVERY run in the fleet on every change, and the
        // overwhelming majority of them are operator- or Foreman-started - a `null` on each
        // of those is bytes per run per event bought for nothing.
        ...(claim ? { externalSource: claim } : {}),
        gate: compactGate(run, gateState),
        gatePrNumber: Number.isInteger(gatePrNumber) ? gatePrNumber : null,
        gateHeadShort: (gateState?.targetHeadSha ?? gateState?.observedHeadSha)?.slice(0, 8) ?? null,
        reviewPosture: gateState?.reviewPosture ?? null,
        uncertainDeliveryCount: Number(row.uncertain_delivery_count ?? 0),
        refusedDeliveryCount: Number(row.refused_delivery_count ?? 0),
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

  /** Every submission of one run in evidence order: repair rounds, and segments within them. */
  listSubmissions(runId: string): WorkflowSubmission[] {
    return (this.db.prepare(
      `SELECT * FROM workflow_submissions WHERE run_id = ? ORDER BY round ASC, segment ASC`,
    ).all(runId) as unknown[]).map(parseWorkflowSubmissionRow);
  }

  listSubmissionsByState(status: WorkflowSubmission["status"]): WorkflowSubmission[] {
    return (this.db.prepare(
      `SELECT * FROM workflow_submissions WHERE status = ? ORDER BY created_at ASC, id ASC`,
    ).all(status) as unknown[]).map(parseWorkflowSubmissionRow);
  }

  /**
   * The newest evidence snapshot of a run, ordered by `(round, segment)` and never by
   * insertion time.
   *
   * Insertion order and evidence order agree today and must not be relied on to: a
   * continuation is reserved before its evidence is captured, so a row's `created_at` says
   * when the daemon started work, not which evidence is current.
   */
  latestSubmissionForRun(runId: string): WorkflowSubmission | null {
    const row = this.db.prepare(
      `SELECT * FROM workflow_submissions WHERE run_id = ?
        ORDER BY round DESC, segment DESC LIMIT 1`,
    ).get(runId);
    return row ? parseWorkflowSubmissionRow(row) : null;
  }

  /**
   * The submission a REPAIR round started with, which is always its segment zero.
   *
   * Named separately from `latestSubmissionForRun` because the two answer different
   * questions and the difference only became visible once a round could hold more than one
   * snapshot: the repair budget, the round scrubber and a resubmission all mean "the round",
   * while delivery and activation mean "the current evidence".
   */
  submissionForRepairRound(runId: string, round: number): WorkflowSubmission | null {
    return this.submissionForSegment(runId, round, 0);
  }

  /** One exact evidence snapshot, by its full `(round, segment)` identity. */
  submissionForSegment(runId: string, round: number, segment: number): WorkflowSubmission | null {
    const row = this.db.prepare(
      `SELECT * FROM workflow_submissions WHERE run_id = ? AND round = ? AND segment = ?`,
    ).get(runId, round, segment);
    return row ? parseWorkflowSubmissionRow(row) : null;
  }

  /**
   * The newest evidence snapshot. Retained as the merged spelling every existing call site
   * uses; `latestSubmissionForRun` is the same query under the name the continuation work
   * introduced, so both readings of "latest" resolve to one statement.
   */
  latestSubmission(runId: string): WorkflowSubmission | null {
    return this.latestSubmissionForRun(runId);
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
        run.triggerSource,
        run.triggerKey,
        run.now,
        run.now,
      );
      this.insertSubmissionInTransaction({
        ...submission,
        runId: run.id,
        round: 1,
      });
      if (run.externalExpectation) {
        this.appendEvent(run.id, "external_expectation_pinned", {
          expectedHeadSha: run.externalExpectation.expectedHeadSha,
          requireCleanWorktree: run.externalExpectation.requireCleanWorktree,
        }, run.now);
      }
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
      const updated = this.db.prepare(
        `UPDATE workflow_runs
            SET status = 'capturing', current_phase = 'capturing', gate_state_json = NULL,
                updated_at = ?, completed_at = NULL
          WHERE id = ? AND status NOT IN ('completed', 'cancelled', 'failed')`,
      ).run(input.now, input.runId);
      if (Number(updated.changes) !== 1) {
        throw new Error(`Workflow run ${input.runId} is terminal`);
      }
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
   * The worker never supplies durable workflow identity, and this transaction never creates
   * any: the manager resolves the already-bound workflow before the claim reaches here.
   */
  claimForemanCompletion(input: ForemanCompletionStoreInput): ForemanCompletionStoreResult {
    return transaction(this.db, () => {
      const binding = input.binding;
      const noteKey = binding.noteKey;
      const triggerKey = `foreman:${binding.id}:${input.completionKind}:${input.marker}`;
      const expectedIntent = input.expectedIntent;
      const currentIntent = expectedIntent || input.completionKind === "prompted"
        ? this.db.prepare(
            `SELECT objective, objective_version, prompt_revision,
                    resolved_prompt_revision, relationship
               FROM session_goals WHERE note_key = ?`,
          ).get(noteKey) as {
            objective: string | null;
            objective_version: number;
            prompt_revision: number;
            resolved_prompt_revision: number;
            relationship: string | null;
          } | undefined
        : undefined;

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
          binding,
          run,
          submission,
          created: false,
          previousFingerprint: undefined,
        };
      }

      if (input.completionKind === "prompted" && !expectedIntent) {
        throw new Error("Foreman prompted completion has no intent guard");
      }
      if (
        expectedIntent &&
        (
          !currentIntent ||
          currentIntent.objective?.trim() !== expectedIntent.objective ||
          currentIntent.objective_version !== expectedIntent.objectiveVersion ||
          currentIntent.prompt_revision !== expectedIntent.promptRevision ||
          currentIntent.resolved_prompt_revision !== expectedIntent.promptRevision ||
          !currentIntent.relationship ||
          currentIntent.relationship === "unclear" ||
          expectedIntent.episodeKey !==
            `intent:${currentIntent.objective_version}:${currentIntent.prompt_revision}`
        )
      ) {
        throw new Error("Foreman completion intent is no longer current");
      }

      let run = this.activeRunForBinding(binding.id);
      let submission: WorkflowSubmission | null = null;
      let state: Exclude<
        import("@shared/workflow.ts").WorkflowCompletionClaimResult,
        { claimed: false }
      >["state"] = "blocked";
      let created = false;
      let previousFingerprint: string | undefined;

      if (!run) {
        this.db.prepare(
          `INSERT INTO workflow_runs (
             id, binding_id, workflow_version_id, status, current_phase, max_repair_rounds,
             trigger_source, trigger_key, inspector_pr_key, inspector_head_sha,
             gate_state_json, started_at, updated_at, completed_at
           ) VALUES (?, ?, ?, 'capturing', 'capturing', ?, ?, ?, NULL, NULL, NULL, ?, ?, NULL)`,
        ).run(
          input.runId,
          binding.id,
          binding.workflowVersionId,
          binding.maxRepairRounds,
          "foreman" satisfies WorkflowTriggerSource,
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

      // Retiring the guard stays inside this transaction: a later failure rolls it back, so
      // a rejected or stale claim never spends the episode.
      const retired = input.completionKind === "drain"
        ? this.retireDrainGuard(binding.noteKey, `workflow:${run.id}`, input.now)
        : this.retirePromptedGuard(binding, expectedIntent!.episodeKey, input.now);
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
        binding,
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
        WHERE id = ? AND status NOT IN ('completed', 'cancelled', 'failed')`,
    ).run(status, currentPhase, gateState === null ? null : JSON.stringify(gateState), now, terminal ? 1 : 0, now, id);
    return this.mustRun(id);
  }

  /**
   * Replace one run's operator-disabled verdict node set and append its audit events, in
   * one transaction - or report `null` when the run had already finished.
   *
   * A dedicated UPDATE rather than a parameter on `setRunState`, because `setRunState`
   * overwrites `gate_state_json` unconditionally on every call and a disabled set stored
   * there would be erased by the next ordinary state transition.
   *
   * The guarded UPDATE is the authority on the terminal race, not a status read before
   * it: a run can finish between a caller's check and this write, and a toggle reported
   * as applied when the row refused it would tell the operator a gate was disabled while
   * the finished run's history says nothing of the kind. Zero changed rows means nothing
   * is written - the events ride the same transaction precisely so a refused toggle
   * cannot leave a `node_disabled` line on a run it never changed. The caller resolves
   * "no such run" separately; here an absent row and a finished one earn the same `null`.
   */
  setRunDisabledNodes(
    id: string,
    nodeIds: readonly string[],
    events: ReadonlyArray<{ kind: string; payload: WorkflowJson }> = [],
    now = Date.now(),
  ): WorkflowRun | null {
    return transaction(this.db, () => {
      const result = this.db.prepare(
        `UPDATE workflow_runs
            SET disabled_nodes_json = ?, updated_at = ?
          WHERE id = ? AND status NOT IN ('completed', 'cancelled', 'failed')`,
      ).run(nodeIds.length === 0 ? null : JSON.stringify(nodeIds), now, id);
      if (Number(result.changes) !== 1) return null;
      for (const event of events) this.appendEvent(id, event.kind, event.payload, now);
      return this.mustRun(id);
    });
  }

  enterInspectorGate(input: {
    runId: string;
    submissionId: string;
    headSha: string | null;
    status: WorkflowRun["status"];
    phase: string;
    state: WorkflowInspectorGateState;
    now: number;
  }): { run: WorkflowRun; submission: WorkflowSubmission } | null {
    return transaction(this.db, () => {
      const submissionChanged = this.db.prepare(
        `UPDATE workflow_submissions
            SET status = 'completed', pr_head_sha = ?, updated_at = ?,
                completed_at = COALESCE(completed_at, ?)
          WHERE id = ? AND run_id = ? AND status = 'running'`,
      ).run(input.headSha, input.now, input.now, input.submissionId, input.runId);
      if (Number(submissionChanged.changes) !== 1) return null;
      const runChanged = this.db.prepare(
        `UPDATE workflow_runs
            SET status = ?, current_phase = ?, inspector_pr_key = ?,
                inspector_head_sha = NULL, gate_state_json = ?, updated_at = ?,
                completed_at = NULL
          WHERE id = ? AND status = 'running'`,
      ).run(
        input.status,
        input.phase,
        input.state.prKey,
        JSON.stringify(input.state),
        input.now,
        input.runId,
      );
      if (Number(runChanged.changes) !== 1) {
        throw new Error(`Workflow run ${input.runId} cannot enter its Inspector gate`);
      }
      this.appendEvent(input.runId, "inspector_gate_entered", {
        submissionId: input.submissionId,
        prKey: input.state.prKey,
        prUrl: input.state.prUrl,
        submittedHeadSha: input.headSha,
        enteredAt: input.state.enteredAt,
        waitReason: input.state.waitReason,
      }, input.now);
      return {
        run: this.mustRun(input.runId),
        submission: this.mustSubmission(input.submissionId),
      };
    });
  }

  updateInspectorGate(input: {
    runId: string;
    expectedState: WorkflowInspectorGateState;
    state: WorkflowInspectorGateState;
    status: WorkflowRun["status"];
    phase: string;
    now: number;
  }): WorkflowRun | null {
    const expectedJson = JSON.stringify(input.expectedState);
    const stateJson = JSON.stringify(input.state);
    const completed = input.status === "completed";
    const changed = this.db.prepare(
      `UPDATE workflow_runs
          SET status = ?, current_phase = ?, inspector_pr_key = ?,
              inspector_head_sha = ?, gate_state_json = ?, updated_at = ?,
              completed_at = CASE WHEN ? THEN COALESCE(completed_at, ?) ELSE NULL END
        WHERE id = ? AND gate_state_json = ?
          AND status NOT IN ('completed', 'cancelled', 'failed')`,
    ).run(
      input.status,
      input.phase,
      input.state.prKey,
      input.state.targetHeadSha,
      stateJson,
      input.now,
      completed ? 1 : 0,
      input.now,
      input.runId,
      expectedJson,
    );
    return Number(changed.changes) === 1 ? this.mustRun(input.runId) : null;
  }

  transitionInspectorFindingsWithDelivery(input: {
    runId: string;
    expectedState: WorkflowInspectorGateState;
    state: WorkflowInspectorGateState;
    status: Extract<WorkflowRun["status"], "waiting_for_new_head" | "waiting_for_session">;
    findingEvent: WorkflowJson;
    delivery: WorkflowDeliveryInsert;
    deliveryEvent: WorkflowJson;
    now: number;
  }): { run: WorkflowRun; delivery: WorkflowDelivery; idempotent: boolean } | null {
    return transaction(this.db, () => {
      const run = this.updateInspectorGate({
        runId: input.runId,
        expectedState: input.expectedState,
        state: input.state,
        status: input.status,
        phase: "inspector_findings",
        now: input.now,
      });
      if (!run) return null;
      this.appendEvent(input.runId, "inspector_findings", input.findingEvent, input.now);
      const existing = this.deliveryForPacket(
        input.delivery.submissionId,
        input.delivery.kind,
        input.delivery.payloadSha256,
      );
      const delivery = existing ?? this.insertDeliveryInTransaction(input.delivery, input.now);
      if (!existing) {
        this.appendEvent(input.runId, "inspector_feedback_prepared", input.deliveryEvent, input.now);
      }
      return {
        run: this.mustRun(input.runId),
        delivery,
        idempotent: existing !== null,
      };
    });
  }

  createInspectorOnlySubmission(input: {
    id: string;
    runId: string;
    triggerKey: string;
    newHeadSha: string;
    failedHeadSha: string;
    priorFindingFingerprints: string[];
    bypassReason: string;
    expectedState: WorkflowInspectorGateState;
    state: WorkflowInspectorGateState;
    now: number;
  }): { run: WorkflowRun; submission: WorkflowSubmission; idempotent: boolean } | null {
    return transaction(this.db, () => {
      const duplicate = this.submissionByTrigger(input.triggerKey);
      if (duplicate) {
        return { run: this.mustRun(duplicate.runId), submission: duplicate, idempotent: true };
      }
      const run = this.getRun(input.runId);
      const latest = run ? this.latestSubmission(run.id) : null;
      if (
        !run
        || !latest
        || run.status !== "waiting_for_new_head"
        || latest.round > run.maxRepairRounds
        || input.newHeadSha === input.failedHeadSha
        || this.listSubmissions(run.id).some((item) => item.prHeadSha === input.newHeadSha)
      ) return null;
      const currentGate = inspectorGateState(run);
      if (!currentGate || JSON.stringify(currentGate) !== JSON.stringify(input.expectedState)) return null;
      this.insertSubmissionInTransaction({
        id: input.id,
        runId: run.id,
        round: latest.round + 1,
        triggerSource: "manual",
        triggerKey: input.triggerKey,
        context: {
          bypassReason: input.bypassReason,
          failedHeadSha: input.failedHeadSha,
          newHeadSha: input.newHeadSha,
          priorFindingFingerprints: input.priorFindingFingerprints,
        },
        evidence: {
          prHeadSha: input.newHeadSha,
          priorFindingFingerprints: input.priorFindingFingerprints,
        },
        mode: "inspector_only",
        evidenceFingerprint: `inspector:${input.newHeadSha}`,
        prHeadSha: input.newHeadSha,
        status: "completed",
        now: input.now,
      });
      const changed = this.db.prepare(
        `UPDATE workflow_runs
            SET status = 'waiting_for_inspector', current_phase = 'inspector_review',
                inspector_head_sha = ?, gate_state_json = ?, updated_at = ?, completed_at = NULL
          WHERE id = ? AND gate_state_json = ? AND status = 'waiting_for_new_head'`,
      ).run(
        input.newHeadSha,
        JSON.stringify(input.state),
        input.now,
        run.id,
        JSON.stringify(input.expectedState),
      );
      if (Number(changed.changes) !== 1) {
        throw new Error(`Workflow run ${run.id} changed while creating an Inspector-only submission`);
      }
      this.appendEvent(run.id, "inspector_persona_bypass_used", {
        submissionId: input.id,
        failedHeadSha: input.failedHeadSha,
        newHeadSha: input.newHeadSha,
        ...priorFindingFingerprintAudit(input.priorFindingFingerprints),
        bypassReason: input.bypassReason,
      }, input.now);
      return {
        run: this.mustRun(run.id),
        submission: this.mustSubmission(input.id),
        idempotent: false,
      };
    });
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
        WHERE id = ? AND status NOT IN ('completed', 'cancelled', 'failed')`,
    ).run(status, now, terminal ? 1 : 0, now, id);
    return this.mustSubmission(id);
  }

  /**
   * The exact artifact an externally sourced run is entitled to review, or null.
   *
   * The expectation has to be DURABLE, not merely re-validated per call: the idempotency key
   * names a result, and a retry that supplied a different commit under that same key would
   * resume the same submission against evidence nobody selected - and after completion would
   * be answered as idempotent success for a commit this run never saw. Pinned once, the run
   * carries its own answer to "which artifact was this?" across restarts.
   *
   * It is written by `createInitialSubmission`, inside that transaction, and is deliberately
   * not writable afterwards: a second entry point would be the two-step window again. It
   * lives in the event ledger rather than a column because it is written exactly once and
   * only ever read back for comparison - the same shape as the other once-only facts here.
   */
  externalExpectationFor(runId: string): WorkflowCaptureExpectation | null {
    const row = this.db.prepare(
      `SELECT json_extract(payload_json, '$.expectedHeadSha') AS expected_head_sha
         FROM workflow_events
        WHERE run_id = ? AND event_kind = 'external_expectation_pinned'
        ORDER BY id ASC LIMIT 1`,
    ).get(runId) as { expected_head_sha: string | null } | undefined;
    if (!row?.expected_head_sha) return null;
    // requireCleanWorktree is the literal true in the wire type, so the pin restates the
    // requirement rather than storing a choice; there is no stored value that could relax it.
    return { expectedHeadSha: row.expected_head_sha, requireCleanWorktree: true };
  }

  /**
   * Return one blocked submission to evidence capture without starting a second family.
   *
   * The externally sourced path needs this and `reviveFailedSubmission` cannot serve it:
   * that one resumes a submission whose evidence is already captured and whose graph work
   * failed, so it lands in `running`. Here the capture itself is what did not happen - the
   * caller's artifact was not the one on disk, or a restart interrupted the read - and the
   * retry has to redo exactly that. Guarded on the exact blocking phases the capture path
   * produces, so nothing else can re-enter capture, and it reuses the same run, round,
   * submission and model-call ledger rather than minting new ones.
   */
  resumeCapture(
    runId: string,
    submissionId: string,
    expectedPhases: readonly string[],
    now = Date.now(),
  ): { run: WorkflowRun; submission: WorkflowSubmission } | null {
    if (expectedPhases.length === 0) return null;
    const placeholders = expectedPhases.map(() => "?").join(", ");
    return transaction(this.db, () => {
      const submissionChanged = this.db.prepare(
        `UPDATE workflow_submissions
            SET status = 'capturing', updated_at = ?, completed_at = NULL
          WHERE id = ? AND run_id = ? AND status = 'failed'
            AND EXISTS (
              SELECT 1 FROM workflow_runs
               WHERE id = ? AND status = 'blocked' AND current_phase IN (${placeholders})
            )`,
      ).run(now, submissionId, runId, runId, ...expectedPhases);
      if (Number(submissionChanged.changes) !== 1) return null;
      const runChanged = this.db.prepare(
        `UPDATE workflow_runs
            SET status = 'capturing', current_phase = 'capturing', gate_state_json = NULL,
                updated_at = ?, completed_at = NULL
          WHERE id = ? AND status = 'blocked' AND current_phase IN (${placeholders})`,
      ).run(now, runId, ...expectedPhases);
      if (Number(runChanged.changes) !== 1) {
        throw new Error(`Workflow run ${runId} left its blocked capture phase mid-transaction`);
      }
      this.appendEvent(runId, "capture_resumed", { submissionId }, now);
      return { run: this.mustRun(runId), submission: this.mustSubmission(submissionId) };
    });
  }

  reviveFailedSubmission(
    id: string,
    runId: string,
    expectedPhase: string,
    now = Date.now(),
  ): WorkflowSubmission | null {
    const changed = this.db.prepare(
      `UPDATE workflow_submissions
          SET status = 'running', updated_at = ?, completed_at = NULL
        WHERE id = ? AND run_id = ? AND status = 'failed'
          AND EXISTS (
            SELECT 1 FROM workflow_runs
             WHERE id = ? AND current_phase = ?
               AND status IN ('waiting_for_session', 'blocked')
          )`,
    ).run(now, id, runId, runId, expectedPhase);
    return Number(changed.changes) === 1 ? this.mustSubmission(id) : null;
  }

  /**
   * Reserve the child evidence segment one completed session action authorizes.
   *
   * The reservation and the capture are deliberately SEPARATE transactions. Capture shells
   * out to git and may call a model, which cannot happen inside a SQLite write; reserving
   * first is what makes "exactly one child segment" a database fact rather than a promise
   * about how fast the daemon is. `(run_id, round, segment)` is UNIQUE, so a second reserver
   * loses the insert rather than opening a rival branch of the run.
   *
   * Idempotent in both directions: a reservation recorded on the attempt is returned as-is,
   * and a `trigger_key` that already exists resolves to the same row. Retrying after a crash
   * therefore resumes the reserved continuation instead of creating a second one.
   */
  reserveSessionActionContinuation(
    input: WorkflowContinuationInput,
  ): WorkflowContinuationReservation {
    return transaction(this.db, () => {
      const attempt = this.getAttempt(input.attemptId);
      if (!attempt || attempt.state !== "waiting" || !attempt.sessionAction) {
        return { ok: false, reason: "attempt_not_waiting" } as const;
      }
      const parent = this.getSubmission(attempt.submissionId);
      if (!parent) return { ok: false, reason: "attempt_not_waiting" } as const;
      const run = this.getRun(parent.runId);
      if (!run || ["completed", "cancelled", "failed"].includes(run.status)) {
        return { ok: false, reason: "run_terminal" } as const;
      }
      // Idempotency is resolved BEFORE the supersede check, and the order is load-bearing.
      // A successful reservation makes the CHILD the run's latest submission, so asking
      // "is the parent still latest?" first would make every resume after a crash - the one
      // path this reservation exists to survive - look like a stale completion and refuse.
      const state = this.sessionActionState(attempt);
      const reserved = state?.continuationSubmissionId
        ? this.getSubmission(state.continuationSubmissionId)
        : null;
      if (reserved) {
        return { ok: true, submission: reserved, parent, idempotent: true } as const;
      }
      const byTrigger = this.submissionByTrigger(input.triggerKey);
      if (byTrigger) {
        return { ok: true, submission: byTrigger, parent, idempotent: true } as const;
      }
      // Only now, for a genuinely NEW reservation: the action ran against the parent's
      // evidence, so a newer segment means something else already moved this run on and this
      // completion is stale.
      const latest = this.latestSubmissionForRun(parent.runId);
      if (!latest || latest.id !== parent.id) {
        return { ok: false, reason: "parent_superseded" } as const;
      }
      // Same round, next segment. `round` is untouched on purpose: an action never spends
      // repair budget, however many of them one round executes.
      this.insertSubmissionInTransaction({
        id: input.submissionId,
        runId: parent.runId,
        round: parent.round,
        segment: parent.segment + 1,
        continuation: {
          parentSubmissionId: parent.id,
          nodeId: attempt.nodeId,
          nodeAttemptId: attempt.id,
        },
        mode: parent.mode,
        triggerSource: parent.triggerSource,
        triggerKey: input.triggerKey,
        context: {},
        evidence: {},
        now: input.now,
      });
      const updated = this.db.prepare(
        `UPDATE workflow_node_attempts SET output_json = ?, updated_at = ?
          WHERE id = ? AND state = 'waiting'`,
      ).run(
        JSON.stringify({
          ...(state ?? {
            wait: "capturing" as const,
            deliveryId: null,
            anchor: null,
            pickedUpAt: null,
            settledAt: null,
            expectation: null,
            continuationSubmissionId: null,
            blocked: null,
          }),
          wait: "capturing",
          continuationSubmissionId: input.submissionId,
        } satisfies SessionActionAttemptState),
        input.now,
        attempt.id,
      );
      if (Number(updated.changes) !== 1) {
        throw new Error(`Session action attempt ${attempt.id} stopped waiting mid-reservation`);
      }
      this.setRunState(
        parent.runId,
        "capturing",
        "session_action_capture",
        { nodeId: attempt.nodeId, attemptId: attempt.id, submissionId: input.submissionId },
        input.now,
      );
      this.appendEvent(parent.runId, "session_action_continuation_reserved", {
        parentSubmissionId: parent.id,
        submissionId: input.submissionId,
        nodeId: attempt.nodeId,
        attemptId: attempt.id,
        round: parent.round,
        segment: parent.segment + 1,
      }, input.now);
      return {
        ok: true,
        submission: this.mustSubmission(input.submissionId),
        parent,
        idempotent: false,
      } as const;
    });
  }

  /**
   * Close the action attempt and seed its `complete` route into the captured child segment,
   * in one transaction.
   *
   * The two writes belong together: an attempt marked complete without its receipt strands
   * the run with no node left to activate, and a receipt without a completed attempt would
   * let recovery prepare a second delivery for work that already happened.
   */
  completeSessionActionContinuation(input: {
    attemptId: string;
    submissionId: string;
    receipts: Array<{ edgeId: string; payload: WorkflowJson }>;
    now: number;
  }): { attempt: WorkflowNodeAttempt; submission: WorkflowSubmission } | null {
    return transaction(this.db, () => {
      const attempt = this.getAttempt(input.attemptId);
      if (!attempt || attempt.state !== "waiting") return null;
      const child = this.getSubmission(input.submissionId);
      if (!child || child.continuationNodeAttemptId !== attempt.id) return null;
      const state = this.sessionActionState(attempt);
      const completed = this.finishAttempt(attempt.id, {
        state: "completed",
        output: workflowJson({
          outcome: "complete",
          action: attempt.sessionAction?.name ?? null,
          completion: attempt.sessionAction?.completion.kind ?? null,
          continuationSubmissionId: child.id,
          anchor: state?.anchor ?? null,
          pickedUpAt: state?.pickedUpAt ?? null,
          settledAt: state?.settledAt ?? null,
          // Carried past completion rather than dropped with the waiting state, because it is
          // the only durable record of WHAT WAS PROVEN. A finished `pull_request` action whose
          // expectation went with its wait state can say it completed and nothing else - not
          // which pull request, not at which commit - which is exactly the audit question run
          // detail and a diagnostic are asked afterwards.
          expectation: state?.expectation ?? null,
        }),
        error: null,
      }, input.now);
      for (const receipt of input.receipts) {
        this.addReceipt(child.id, receipt.edgeId, attempt.id, receipt.payload, input.now);
      }
      this.appendEvent(child.runId, "session_action_completed", {
        nodeId: attempt.nodeId,
        attemptId: attempt.id,
        submissionId: child.id,
        parentSubmissionId: child.parentSubmissionId,
        receipts: input.receipts.map((receipt) => receipt.edgeId),
      }, input.now);
      return { attempt: completed, submission: this.mustSubmission(child.id) };
    });
  }

  /**
   * Stop a waiting action attempt for a reason that is not the graph's business.
   *
   * A block, never a verdict: it carries an action-specific code, leaves the run's repair
   * budget untouched, and writes no receipt, so nothing downstream reads it as work the
   * session was asked to redo.
   */
  blockSessionActionAttempt(input: {
    attemptId: string;
    code: string;
    detail: string;
    now: number;
  }): WorkflowNodeAttempt | null {
    return transaction(this.db, () => {
      const attempt = this.getAttempt(input.attemptId);
      if (!attempt || attempt.state !== "waiting") return null;
      const state = this.sessionActionState(attempt);
      const finished = this.finishAttempt(attempt.id, {
        state: "error",
        // The observation state is KEPT beside the block, so run detail can still say how
        // far the action got - sent, picked up, settled - rather than only that it stopped.
        output: workflowJson({
          ...state,
          blocked: { code: input.code, detail: input.detail },
        }),
        error: `${input.code}: ${input.detail}`,
      }, input.now);
      const submission = this.getSubmission(attempt.submissionId);
      if (submission) {
        this.setRunState(submission.runId, "blocked", "session_action_blocked", {
          nodeId: attempt.nodeId,
          attemptId: attempt.id,
          code: input.code,
          detail: input.detail,
        }, input.now);
        this.appendEvent(submission.runId, "session_action_blocked", {
          nodeId: attempt.nodeId,
          attemptId: attempt.id,
          code: input.code,
          detail: input.detail,
        }, input.now);
      }
      return finished;
    });
  }

  insertAttempt(input: WorkflowAttemptInsert): WorkflowNodeAttempt {
    this.db.prepare(
      `INSERT OR IGNORE INTO workflow_node_attempts (
         id, submission_id, node_id, attempt, state, persona_snapshot_json,
         session_action_snapshot_json, runner_id,
         model_id, verdict_json, output_json, retry_at, input_fingerprint, error,
         created_at, updated_at, started_at, finished_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    ).run(
      input.id,
      input.submissionId,
      input.nodeId,
      input.attempt,
      input.state,
      input.persona === null ? null : JSON.stringify(input.persona),
      input.sessionAction ? JSON.stringify(input.sessionAction) : null,
      // The waiting attempt's observation state is written WITH the row, not after it: a
      // daemon that stopped between the two would leave an attempt nothing can tell apart
      // from one whose packet was already prepared.
      input.sessionActionState ? JSON.stringify(input.sessionActionState) : null,
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

  /**
   * The action attempts of one run that are still waiting, oldest first.
   *
   * Joined through submissions and runs rather than read per submission, because recovery's
   * question is fleet-wide: "which action attempts does this daemon owe work to?" Terminal
   * runs are excluded so a cancelled run's waiting rows never wake an observer.
   */
  listWaitingActionAttempts(runId?: string): WorkflowNodeAttempt[] {
    const rows = runId
      ? this.db.prepare(
          `SELECT a.* FROM workflow_node_attempts a
             JOIN workflow_submissions s ON s.id = a.submission_id
            WHERE a.state = 'waiting' AND s.run_id = ?
            ORDER BY a.created_at ASC, a.id ASC`,
        ).all(runId)
      : this.db.prepare(
          `SELECT a.* FROM workflow_node_attempts a
             JOIN workflow_submissions s ON s.id = a.submission_id
             JOIN workflow_runs r ON r.id = s.run_id
            WHERE a.state = 'waiting'
              AND r.status NOT IN ('completed', 'cancelled', 'failed')
            ORDER BY a.created_at ASC, a.id ASC`,
        ).all();
    return (rows as unknown[]).map(parseWorkflowNodeAttemptRow);
  }

  /**
   * Waiting action attempts whose packet was CONFIRMED SENT into one session.
   *
   * Joined through the delivery rather than through the binding, because the question this
   * answers is "which packets is this pane still owed a turn for?" - and the delivery is the
   * only row that records which session actually received one. A prepared-but-unsent packet
   * is deliberately excluded: nothing was typed, so no activity in that pane can be pickup.
   */
  waitingActionAttemptsForSession(sessionId: string): WorkflowNodeAttempt[] {
    return (this.db.prepare(
      `SELECT a.* FROM workflow_node_attempts a
         JOIN workflow_deliveries d ON d.node_attempt_id = a.id
         JOIN workflow_submissions s ON s.id = a.submission_id
         JOIN workflow_runs r ON r.id = s.run_id
        WHERE a.state = 'waiting'
          AND d.session_id = ? AND d.state = 'delivered'
          AND r.status NOT IN ('completed', 'cancelled', 'failed')
        ORDER BY a.created_at ASC, a.id ASC`,
    ).all(sessionId) as unknown[]).map(parseWorkflowNodeAttemptRow);
  }

  /**
   * Return a blocked action attempt to `waiting`, on explicit operator authority.
   *
   * The one backwards transition this runtime allows, and it exists for exactly one caller:
   * an operator resolving an uncertain delivery as `mark_delivered`. The observer blocks an
   * uncertain action rather than guessing whether its instruction landed - so without a way
   * back, saying "it landed" would be an answer the run could no longer act on.
   *
   * Guarded on the attempt being blocked by a DELIVERY, never on any other block code: a lost
   * session or an unavailable adapter is not something marking a packet delivered can fix.
   */
  reopenSessionActionAttempt(
    attemptId: string,
    anchor: SessionActionDeliveryAnchor,
    now = Date.now(),
  ): WorkflowNodeAttempt | null {
    return transaction(this.db, () => {
      const attempt = this.getAttempt(attemptId);
      if (!attempt || attempt.state !== "error" || !attempt.sessionAction) return null;
      const parsed = SessionActionAttemptStateSchema.safeParse(attempt.output);
      const state = parsed.success ? parsed.data : null;
      if (!state?.blocked || !["delivery_refused", "delivery_uncertain"].includes(state.blocked.code)) {
        return null;
      }
      const changed = this.db.prepare(
        `UPDATE workflow_node_attempts
            SET state = 'waiting', error = NULL, finished_at = NULL, output_json = ?,
                updated_at = ?
          WHERE id = ? AND state = 'error'`,
      ).run(
        JSON.stringify({
          ...state,
          wait: "awaiting_pickup",
          deliveryId: anchor.deliveryId,
          anchor,
          blocked: null,
        } satisfies SessionActionAttemptState),
        now,
        attemptId,
      );
      return Number(changed.changes) === 1 ? this.mustAttempt(attemptId) : null;
    });
  }

  private mustAttempt(id: string): WorkflowNodeAttempt {
    const attempt = this.getAttempt(id);
    if (!attempt) throw new Error(`Workflow attempt ${id} is missing`);
    return attempt;
  }

  /** One waiting action attempt's durable observation state, or null when it has none. */
  sessionActionState(attempt: WorkflowNodeAttempt): SessionActionAttemptState | null {
    if (attempt.sessionAction === null) return null;
    const parsed = SessionActionAttemptStateSchema.safeParse(attempt.output);
    return parsed.success ? parsed.data : null;
  }

  /**
   * Advance a waiting action attempt's observation state without finishing it.
   *
   * Guarded on `state = 'waiting'` so a completed, cancelled or blocked attempt can never be
   * moved backwards by an observer that was already in flight when the attempt resolved.
   */
  updateSessionActionState(
    attemptId: string,
    state: SessionActionAttemptState,
    now = Date.now(),
  ): WorkflowNodeAttempt | null {
    const changed = this.db.prepare(
      `UPDATE workflow_node_attempts
          SET output_json = ?, updated_at = ?
        WHERE id = ? AND state = 'waiting'`,
    ).run(JSON.stringify(state), now, attemptId);
    return Number(changed.changes) === 1 ? this.getAttempt(attemptId) : null;
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

  /** Every attempt for a run in the same evidence and attempt order as per-submission reads. */
  listAttemptsForRun(runId: string): WorkflowNodeAttempt[] {
    return (this.db.prepare(
      `SELECT a.* FROM workflow_node_attempts a
         JOIN workflow_submissions s ON s.id = a.submission_id
        WHERE s.run_id = ?
        ORDER BY s.round ASC, s.segment ASC,
                 a.created_at ASC, a.node_id ASC, a.attempt ASC`,
    ).all(runId) as unknown[]).map(parseWorkflowNodeAttemptRow);
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

  /**
   * Take an attempt from queued to running, atomically, so two pumps cannot both run it.
   *
   * `runner` and `model` are NULLABLE because not every node kind is a model call: a Check
   * runs a command the operator configured, and stamping it with a provider it never used
   * would put a fiction in front of whoever reads the run. The columns were already
   * nullable; only this signature insisted otherwise.
   */
  claimAttempt(
    id: string,
    runner: LlmRunnerId | null,
    model: string | null,
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
      if (!this.reviveFailedSubmission(
        submissionId,
        runId,
        "infrastructure_error",
        now,
      )) {
        throw new Error(`Workflow submission ${submissionId} cannot be revived`);
      }
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

  /**
   * Record one edge receipt, refusing a source attempt that does not belong to this
   * submission's own evidence.
   *
   * There is exactly ONE legal cross-submission source, and it is named on the submission
   * itself: the action attempt a continuation segment declares as
   * `continuation_node_attempt_id`. That attempt ran against the PARENT evidence and its
   * completion is what authorized downstream work against this segment - deliberate
   * provenance, not a leak. Any other attempt from another submission would let a node
   * activated on one evidence snapshot advance a graph running on a different one, so it is
   * refused here rather than inferred from whether the ids happen to line up.
   */
  addReceipt(
    submissionId: string,
    edgeId: string,
    sourceAttemptId: string,
    payload: WorkflowJson,
    now = Date.now(),
  ): boolean {
    const legal = this.db.prepare(
      `SELECT 1 FROM workflow_node_attempts a
        WHERE a.id = ?
          AND (
            a.submission_id = ?
            OR EXISTS (
              SELECT 1 FROM workflow_submissions s
               WHERE s.id = ? AND s.continuation_node_attempt_id = a.id
            )
          )`,
    ).get(sourceAttemptId, submissionId, submissionId);
    if (!legal) {
      throw new Error(
        `Workflow receipt on edge ${edgeId} names an attempt outside submission ${submissionId}`,
      );
    }
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

  /** Every receipt for a run, preserving the old submission-then-receipt detail order. */
  listReceiptsForRun(runId: string): WorkflowEdgeReceipt[] {
    return (this.db.prepare(
      `SELECT receipt.* FROM workflow_edge_receipts receipt
         JOIN workflow_submissions s ON s.id = receipt.submission_id
        WHERE s.run_id = ?
        ORDER BY s.round ASC, s.segment ASC, receipt.id ASC`,
    ).all(runId) as unknown[]).map(parseWorkflowEdgeReceiptRow);
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
    input: WorkflowDeliveryInsert,
    now = Date.now(),
  ): { delivery: WorkflowDelivery; idempotent: boolean } {
    return transaction(this.db, () => {
      // An action's packet identity is its ATTEMPT, not `(submission, kind, payload sha)`.
      // Two action nodes in one submission can legitimately render the same bytes, so the
      // generic packet lookup would hand the second one the first one's delivery and
      // complete two graph nodes on a single write.
      if (input.kind === "session_action") {
        const live = this.liveDeliveryForAttempt(input.nodeAttemptId ?? "");
        if (live) return { delivery: live, idempotent: true };
      } else {
        const existing = this.deliveryForPacket(input.submissionId, input.kind, input.payloadSha256);
        if (existing) return { delivery: existing, idempotent: true };
      }
      return {
        delivery: this.insertDeliveryInTransaction(input, now),
        idempotent: false,
      };
    });
  }

  /**
   * The packet an action attempt already owns, in any state that means "do not prepare
   * another one". Refused and cancelled rows are excluded so an explicit retry can prepare.
   */
  liveDeliveryForAttempt(nodeAttemptId: string): WorkflowDelivery | null {
    const row = this.db.prepare(
      `SELECT * FROM workflow_deliveries
        WHERE node_attempt_id = ?
          AND state IN ('prepared', 'sending', 'delivered', 'uncertain')
        LIMIT 1`,
    ).get(nodeAttemptId);
    return row ? parseWorkflowDeliveryRow(row) : null;
  }

  /** Every packet ever prepared for one action attempt, oldest first. */
  listDeliveriesForAttempt(nodeAttemptId: string): WorkflowDelivery[] {
    return (this.db.prepare(
      `SELECT * FROM workflow_deliveries WHERE node_attempt_id = ?
        ORDER BY created_at ASC, id ASC`,
    ).all(nodeAttemptId) as unknown[]).map(parseWorkflowDeliveryRow);
  }

  private insertDeliveryInTransaction(input: WorkflowDeliveryInsert, now: number): WorkflowDelivery {
    const nodeAttemptId = input.kind === "session_action" ? input.nodeAttemptId ?? null : null;
    if (input.kind === "session_action") {
      // The link is validated by JOIN rather than trusted, because the row parser cannot:
      // a delivery naming an attempt in another submission - or another run - would let a
      // completed action advance a graph it never ran in.
      const attempt = nodeAttemptId ? this.getAttempt(nodeAttemptId) : null;
      if (!attempt || attempt.submissionId !== input.submissionId) {
        throw new Error("A session action delivery must name an attempt of its own submission");
      }
      const submission = this.getSubmission(input.submissionId);
      if (!submission || submission.runId !== input.runId) {
        throw new Error("A session action delivery must name a submission of its own run");
      }
    }
    this.db.prepare(
      `INSERT INTO workflow_deliveries (
         id, run_id, submission_id, kind, node_attempt_id, session_id, note_key, payload,
         payload_sha256, state, error, created_at, updated_at, delivered_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', NULL, ?, ?, NULL)`,
    ).run(
      input.id,
      input.runId,
      input.submissionId,
      input.kind,
      nodeAttemptId,
      input.sessionId,
      input.noteKey,
      input.payload,
      input.payloadSha256,
      now,
      now,
    );
    return this.mustDelivery(input.id);
  }

  /**
   * Own the only automatic transition across the terminal-write boundary.
   * Refused packets may be explicitly reclaimed; uncertain/delivered packets never can.
   */
  claimDeliverySend(id: string, allowRefused = false, now = Date.now()): WorkflowDelivery | null {
    return transaction(this.db, () => {
      const delivery = this.getDelivery(id);
      if (!delivery) return null;
      const run = this.getRun(delivery.runId);
      if (!run || ["completed", "cancelled", "failed"].includes(run.status)) return null;
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

  refuseDeliveryBeforeSend(
    id: string,
    error: string,
    allowRefused: boolean,
    now = Date.now(),
  ): WorkflowDelivery | null {
    const result = this.db.prepare(
      `UPDATE workflow_deliveries
          SET state = 'refused', error = ?, updated_at = ?
        WHERE id = ? AND (state = 'prepared' OR (? = 1 AND state = 'refused'))`,
    ).run(error, now, id, allowRefused ? 1 : 0);
    return Number(result.changes) === 1 ? this.mustDelivery(id) : null;
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
  ): { delivery: WorkflowDelivery; rearmed: WorkflowCompletionKind | null } | null {
    return transaction(this.db, () => {
      const delivery = this.getDelivery(id);
      if (!delivery || delivery.state !== "sending") return null;
      const run = this.getRun(delivery.runId);
      if (!run || ["completed", "cancelled", "failed"].includes(run.status)) return null;
      const changed = this.db.prepare(
        `UPDATE workflow_deliveries
            SET state = 'delivered', error = NULL, updated_at = ?, delivered_at = ?
          WHERE id = ? AND state = 'sending'`,
      ).run(now, now, id);
      if (Number(changed.changes) !== 1) return null;
      const version = delivery.kind === "inspector_feedback"
        ? this.getWorkflowVersionById(run.workflowVersionId)
        : null;
      const inspectorOnly =
        version?.completionPolicy.kind === "inspector"
        && version.completionPolicy.onFindings === "inspector_only";
      const nextStatus = DELIVERY_RUN_STATUS[delivery.kind]
        ?? (delivery.kind === "inspector_feedback" && inspectorOnly
          ? "waiting_for_new_head"
          : "waiting_for_session");
      // The pickup anchor lands in the SAME transaction that marks the packet delivered.
      // Split across two writes, a daemon that stopped between them would leave an attempt
      // that knows a packet was sent and nothing about when - and "before the send" is the
      // one fact that separates a finished action turn from the session's ordinary idleness.
      if (delivery.kind === "session_action" && delivery.nodeAttemptId) {
        const attempt = this.getAttempt(delivery.nodeAttemptId);
        const state = attempt ? this.sessionActionState(attempt) : null;
        if (state) {
          this.db.prepare(
            `UPDATE workflow_node_attempts SET output_json = ?, updated_at = ?
              WHERE id = ? AND state = 'waiting'`,
          ).run(
            JSON.stringify({
              ...state,
              wait: "awaiting_pickup",
              deliveryId: delivery.id,
              anchor: {
                deliveryId: delivery.id,
                sessionId: delivery.sessionId,
                noteKey: delivery.noteKey,
                deliveredAt: now,
                transcriptBytes: transcriptAnchor,
              },
            } satisfies SessionActionAttemptState),
            now,
            delivery.nodeAttemptId,
          );
        }
      }
      this.setRunState(
        delivery.runId,
        nextStatus,
        DELIVERY_RUN_PHASE[delivery.kind],
        delivery.kind === "persona_feedback" || delivery.kind === "session_action"
          ? { deliveryId: delivery.id, transcriptAnchor }
          : run.gateState,
        now,
      );
      this.appendEvent(delivery.runId, "delivery_delivered", {
        deliveryId: delivery.id,
        transcriptAnchor,
        submitVerified,
      }, now);
      const rearmed = this.rearmCompletionForDelivery(delivery, now);
      if (rearmed) {
        this.appendEvent(delivery.runId, "foreman_completion_rearmed", {
          deliveryId: delivery.id,
          completionKind: rearmed,
        }, now);
      }
      return { delivery: this.mustDelivery(id), rearmed };
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

  requireDeliveryRetryConfirmation(
    id: string,
    now = Date.now(),
  ): WorkflowDelivery | null {
    const result = this.db.prepare(
      `UPDATE workflow_deliveries
          SET state = 'refused', error = 'reattach_confirmation_required', updated_at = ?
        WHERE id = ? AND state IN ('prepared', 'refused')`,
    ).run(now, id);
    return Number(result.changes) === 1 ? this.getDelivery(id) : null;
  }

  confirmDeliveryRetryTarget(
    id: string,
    expectedSessionId: string,
    expectedNoteKey: string,
    now = Date.now(),
  ): WorkflowDelivery | null {
    return transaction(this.db, () => {
      const delivery = this.getDelivery(id);
      const run = delivery ? this.getRun(delivery.runId) : null;
      const binding = run ? this.getBinding(run.bindingId) : null;
      if (
        !delivery
        || delivery.state !== "refused"
        || !run
        || ["completed", "cancelled", "failed"].includes(run.status)
        || !binding
        || binding.state !== "active"
        || binding.sessionId !== expectedSessionId
        || binding.noteKey !== expectedNoteKey
      ) {
        return null;
      }
      const changed = this.db.prepare(
        `UPDATE workflow_deliveries
            SET session_id = ?, note_key = ?, updated_at = ?
          WHERE id = ? AND state = 'refused'`,
      ).run(expectedSessionId, expectedNoteKey, now, id);
      return Number(changed.changes) === 1 ? this.mustDelivery(id) : null;
    });
  }

  resolveUncertainDelivery(
    id: string,
    resolution: "mark_delivered" | "discard_and_new_round",
    requestId: string,
    now = Date.now(),
  ): {
    delivery: WorkflowDelivery;
    idempotent: boolean;
    rearmed: WorkflowCompletionKind | null;
  } | null {
    return transaction(this.db, () => {
      const delivery = this.getDelivery(id);
      if (!delivery) return null;
      const run = this.getRun(delivery.runId);
      if (!run) return null;
      const runTerminal = ["completed", "cancelled", "failed"].includes(run.status);
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
          ? { delivery, idempotent: true, rearmed: null }
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
      let rearmed: WorkflowCompletionKind | null = null;
      if (resolution === "mark_delivered" && !runTerminal) {
        const binding = this.getBinding(run.bindingId);
        if (
          binding?.state === "active"
          && binding.sessionId === delivery.sessionId
          && binding.noteKey === delivery.noteKey
        ) {
          const version = delivery.kind === "inspector_feedback"
            ? this.getWorkflowVersionById(run.workflowVersionId)
            : null;
          const inspectorOnly =
            version?.completionPolicy.kind === "inspector"
            && version.completionPolicy.onFindings === "inspector_only";
          const nextStatus = delivery.kind === "inspector_feedback" && inspectorOnly
            ? "waiting_for_new_head"
            : "waiting_for_session";
          this.setRunState(
            delivery.runId,
            nextStatus,
            DELIVERY_RUN_PHASE[delivery.kind],
            delivery.kind === "persona_feedback"
              ? { deliveryId: delivery.id, resolvedByOperator: true }
              : run.gateState,
            now,
          );
          rearmed = this.rearmCompletionForDelivery(delivery, now);
          if (rearmed) {
            this.appendEvent(delivery.runId, "foreman_completion_rearmed", {
              deliveryId: delivery.id,
              completionKind: rearmed,
            }, now);
          }
        }
      }
      return { delivery: this.mustDelivery(id), idempotent: false, rearmed };
    });
  }

  replaceUncertainDeliveryWithRepair(
    deliveryId: string,
    requestId: string,
    input: WorkflowSubmissionInsert,
  ): {
    delivery: WorkflowDelivery;
    run: WorkflowRun;
    submission: WorkflowSubmission;
    idempotent: boolean;
  } | null {
    return transaction(this.db, () => {
      const delivery = this.getDelivery(deliveryId);
      if (!delivery) return null;
      const run = this.getRun(delivery.runId);
      if (!run || ["completed", "cancelled", "failed"].includes(run.status)) return null;
      const prior = this.db.prepare(
        `SELECT json_extract(payload_json, '$.submissionId') AS submission_id
           FROM workflow_events
          WHERE run_id = ? AND event_kind = 'delivery_uncertain_resolved'
            AND json_extract(payload_json, '$.deliveryId') = ?
            AND json_extract(payload_json, '$.requestId') = ?
            AND json_extract(payload_json, '$.resolution') = 'discard_and_new_round'
          LIMIT 1`,
      ).get(delivery.runId, deliveryId, requestId) as { submission_id: string | null } | undefined;
      if (prior?.submission_id) {
        const submission = this.getSubmission(prior.submission_id);
        return submission
          ? { delivery, run, submission, idempotent: true }
          : null;
      }
      if (
        delivery.state !== "uncertain"
        || input.runId !== run.id
        || !["waiting_for_session", "blocked"].includes(run.status)
      ) {
        return null;
      }
      const latest = this.latestSubmission(run.id);
      if (!latest || input.round !== latest.round + 1) return null;
      this.insertSubmissionInTransaction(input);
      const runChanged = this.db.prepare(
        `UPDATE workflow_runs
            SET status = 'capturing', current_phase = 'capturing', gate_state_json = NULL,
                updated_at = ?, completed_at = NULL
          WHERE id = ? AND status IN ('waiting_for_session', 'blocked')`,
      ).run(input.now, run.id);
      if (Number(runChanged.changes) !== 1) {
        throw new Error(`Workflow run ${run.id} cannot start a replacement round`);
      }
      const deliveryChanged = this.db.prepare(
        `UPDATE workflow_deliveries
            SET state = 'cancelled', error = 'discarded_by_operator', updated_at = ?
          WHERE id = ? AND state = 'uncertain'`,
      ).run(input.now, delivery.id);
      if (Number(deliveryChanged.changes) !== 1) {
        throw new Error(`Workflow delivery ${delivery.id} cannot be discarded`);
      }
      this.appendEvent(run.id, "submission_created", {
        submissionId: input.id,
        triggerKey: input.triggerKey,
        round: input.round,
      }, input.now);
      this.appendEvent(run.id, "delivery_uncertain_resolved", {
        deliveryId: delivery.id,
        requestId,
        resolution: "discard_and_new_round",
        submissionId: input.id,
      }, input.now);
      return {
        delivery: this.mustDelivery(delivery.id),
        run: this.mustRun(run.id),
        submission: this.mustSubmission(input.id),
        idempotent: false,
      };
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
    workflowLog("info", { run: runId, event: kind });
    return parseWorkflowEventRow(row);
  }

  listEvents(runId: string): WorkflowEvent[] {
    return (this.db.prepare(
      `SELECT * FROM workflow_events WHERE run_id = ? ORDER BY id ASC`,
    ).all(runId) as unknown[]).map(parseWorkflowEventRow);
  }

  listEventPage(runId: string, after = 0, limit = DEFAULT_DETAIL_PAGE_SIZE): WorkflowEventPage {
    const rows = (this.db.prepare(
      `SELECT * FROM workflow_events
        WHERE run_id = ? AND id > ?
        ORDER BY id ASC
        LIMIT ?`,
    ).all(runId, after, limit + 1) as unknown[]).map(parseWorkflowEventRow);
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    return {
      items,
      nextAfter: hasMore ? items.at(-1)?.id ?? null : null,
    };
  }

  listLlmCallPage(
    runId: string,
    after: string | null = null,
    limit = DEFAULT_DETAIL_PAGE_SIZE,
  ): WorkflowLlmCallPage {
    const rows = (after
      ? this.db.prepare(
          `SELECT c.* FROM workflow_llm_calls c
            WHERE c.run_id = ?
              AND (
                c.started_at > COALESCE((
                  SELECT started_at FROM workflow_llm_calls
                   WHERE id = ? AND run_id = ?
                ), -1)
                OR (
                  c.started_at = COALESCE((
                    SELECT started_at FROM workflow_llm_calls
                     WHERE id = ? AND run_id = ?
                  ), -1)
                  AND c.id > ?
                )
              )
            ORDER BY c.started_at ASC, c.id ASC
            LIMIT ?`,
        ).all(runId, after, runId, after, runId, after, limit + 1)
      : this.db.prepare(
          `SELECT * FROM workflow_llm_calls
            WHERE run_id = ?
            ORDER BY started_at ASC, id ASC
            LIMIT ?`,
        ).all(runId, limit + 1)) as unknown[];
    const parsed = rows.map(parseWorkflowLlmCallRow);
    const hasMore = parsed.length > limit;
    const items = parsed.slice(0, limit);
    return {
      items,
      nextAfter: hasMore ? items.at(-1)?.id ?? null : null,
    };
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
    workflowLog("info", {
      run: call.runId,
      submission: call.submissionId,
      event: "model_call_started",
      call: call.id,
      purpose: call.purpose,
      runner: call.runner,
      model: call.model,
      attempt: call.attempt,
      input_bytes: call.inputBytes,
    });
  }

  finishLlmCall(
    id: string,
    state: WorkflowLlmCall["state"],
    outputBytes: number,
    errorCode: string | null,
    now = Date.now(),
  ): void {
    const updated = this.db.prepare(
      `UPDATE workflow_llm_calls
          SET state = ?, finished_at = ?, duration_ms = ? - started_at,
              output_bytes = ?, error_code = ?
        WHERE id = ? AND state = 'running'
        RETURNING run_id, submission_id, runner_id, model_id, duration_ms`,
    ).get(state, now, now, outputBytes, errorCode, id) as {
      run_id: string;
      submission_id: string;
      runner_id: string;
      model_id: string;
      duration_ms: number;
    } | undefined;
    // A cancellation or restart can settle the row while the provider callback is
    // still unwinding. Do not log the later callback as if it replaced that durable
    // outcome.
    if (!updated) return;
    workflowLog(state === "succeeded" ? "info" : "warn", {
      run: updated.run_id,
      submission: updated.submission_id,
      event: "model_call_finished",
      call: id,
      runner: updated.runner_id,
      model: updated.model_id,
      state,
      duration_ms: updated.duration_ms,
      output_bytes: outputBytes,
      error: errorCode,
    });
  }

  interruptRunningLlmCalls(runId: string, now = Date.now()): void {
    this.db.prepare(
      `UPDATE workflow_llm_calls
          SET state = 'interrupted', finished_at = ?, duration_ms = ? - started_at,
              error_code = 'daemon_restart'
        WHERE run_id = ? AND state = 'running'`,
    ).run(now, now, runId);
  }

  runRetention(input: {
    rawEvidenceBefore: number;
    completedRunsBefore: number;
    maxCompletedRuns: number;
    now: number;
  }): WorkflowRetentionResult {
    const compactedRunIds = (this.db.prepare(
      `SELECT r.id FROM workflow_runs r
        WHERE r.status IN ('completed', 'cancelled')
          AND r.completed_at IS NOT NULL
          AND r.completed_at <= ?
          AND r.evidence_pruned_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM workflow_deliveries d
             WHERE d.run_id = r.id AND d.state = 'uncertain'
          )
        ORDER BY r.completed_at ASC, r.id ASC
        LIMIT ?`,
    ).all(
      input.rawEvidenceBefore,
      WORKFLOW_RETENTION_BATCH_SIZE,
    ) as Array<{ id: string }>).map((row) => row.id);

    const compacted: string[] = [];
    const failedRunIds = new Set<string>();
    for (const runId of compactedRunIds) {
      let didCompact = false;
      try {
        didCompact = transaction(this.db, () => {
          const run = this.getRun(runId);
          if (!run) {
            const exists = this.db.prepare(`SELECT 1 FROM workflow_runs WHERE id = ?`).get(runId);
            if (exists) {
              throw new WorkflowRowError("workflow_runs", runId, "row is malformed");
            }
            return false;
          }
          if (
            !["completed", "cancelled"].includes(run.status)
            || run.evidencePrunedAt != null
            || run.completedAt === null
            || run.completedAt > input.rawEvidenceBefore
          ) return false;
          const uncertain = this.db.prepare(
            `SELECT 1 FROM workflow_deliveries
              WHERE run_id = ? AND state = 'uncertain' LIMIT 1`,
          ).get(runId);
          if (uncertain) return false;

          const rows = this.db.prepare(
            // Evidence order, so a compaction event's counts read in the same sequence run
            // detail shows: repair rounds, and the continuation segments inside them.
            `SELECT id, mode, status, context_json FROM workflow_submissions
              WHERE run_id = ? ORDER BY round ASC, segment ASC, id ASC`,
          ).all(runId) as Array<{
            id: string;
            mode: string;
            status: string;
            context_json: string;
          }>;
          let diffBytes = 0;
          let statusEntries = 0;
          let transcriptMessages = 0;
          let standardsDocuments = 0;
          const updates: Array<{ id: string; context: WorkflowContextSnapshot }> = [];
          for (const row of rows) {
            if (row.mode !== "full_workflow") continue;
            const context = parseJson(
              "workflow_submissions",
              row.id,
              "context_json",
              row.context_json,
              WorkflowJsonSchema,
              WORKFLOW_EXECUTION_LIMITS.contextJsonBytes,
            );
            const fullContext = readFullWorkflowContext(context, row.status);
            if (fullContext.kind === "not_captured") continue;
            if (fullContext.kind !== "captured") {
              throw new WorkflowRowError(
                "workflow_submissions",
                row.id,
                "context_json is not a captured workflow context",
              );
            }
            const parsed = fullContext.context;
            if (parsed.evidence.retention?.state === "pruned") continue;
            diffBytes += utf8.encode(parsed.evidence.diff).byteLength;
            statusEntries += parsed.evidence.workingTreeStatus.length;
            transcriptMessages += parsed.evidence.transcript.length;
            standardsDocuments += parsed.evidence.standards.length;
            parsed.evidence = {
              ...parsed.evidence,
              diff: "",
              workingTreeStatus: [],
              transcript: [],
              standards: parsed.evidence.standards.map((document) => ({ ...document, text: "" })),
              retention: {
                state: "pruned",
                prunedAt: input.now,
                diffBytes: utf8.encode(parsed.evidence.diff).byteLength,
                workingTreeStatusEntries: parsed.evidence.workingTreeStatus.length,
                transcriptMessages: parsed.evidence.transcript.length,
                standardsDocuments: parsed.evidence.standards.length,
              },
            };
            updates.push({ id: row.id, context: parsed });
          }

          this.appendEvent(runId, "evidence_pruned", {
            submissions: updates.length,
            diffBytes,
            workingTreeStatusEntries: statusEntries,
            transcriptMessages,
            standardsDocuments,
          }, input.now);
          const updateSubmission = this.db.prepare(
            `UPDATE workflow_submissions
                SET context_json = ?, evidence_json = ?, updated_at = ?
              WHERE id = ?`,
          );
          for (const update of updates) {
            updateSubmission.run(
              JSON.stringify(update.context),
              JSON.stringify(update.context.evidence),
              input.now,
              update.id,
            );
          }
          this.db.prepare(
            `UPDATE workflow_deliveries
                SET payload = '', payload_pruned_at = ?,
                    error = CASE
                      WHEN error IS NULL THEN NULL
                      WHEN length(error) <= 100
                           AND error NOT GLOB '*[^a-zA-Z0-9_:-]*' THEN error
                      ELSE 'delivery_error'
                    END
              WHERE run_id = ?
                AND state IN ('delivered', 'refused')
                AND payload_pruned_at IS NULL`,
          ).run(input.now, runId);
          this.db.prepare(
            `UPDATE workflow_runs
                SET evidence_pruned_at = ?, updated_at = ?
              WHERE id = ?`,
          ).run(input.now, input.now, runId);
          return true;
        });
      } catch (error) {
        diagnose(error);
        failedRunIds.add(runId);
      }
      if (didCompact) compacted.push(runId);
    }

    const deletableRunIds = (this.db.prepare(
      `WITH ranked AS (
         SELECT r.id, r.completed_at,
                ROW_NUMBER() OVER (
                  ORDER BY r.completed_at DESC, r.id DESC
                ) AS newest_position
           FROM workflow_runs r
          WHERE r.status IN ('completed', 'cancelled')
            AND r.completed_at IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM workflow_deliveries d
               WHERE d.run_id = r.id AND d.state = 'uncertain'
            )
       )
       SELECT id FROM ranked
        WHERE completed_at <= ? AND newest_position > ?
        ORDER BY completed_at ASC, id ASC
        LIMIT ?`,
    ).all(
      input.completedRunsBefore,
      input.maxCompletedRuns,
      WORKFLOW_RETENTION_BATCH_SIZE,
    ) as Array<{ id: string }>)
      .map((row) => row.id);

    const deleted: string[] = [];
    for (const runId of deletableRunIds) {
      let didDelete = false;
      try {
        didDelete = transaction(this.db, () => {
          const run = this.getRun(runId);
          if (!run) {
            const exists = this.db.prepare(`SELECT 1 FROM workflow_runs WHERE id = ?`).get(runId);
            if (exists) {
              throw new WorkflowRowError("workflow_runs", runId, "row is malformed");
            }
            return false;
          }
          if (
            !["completed", "cancelled"].includes(run.status)
            || run.completedAt === null
            || run.completedAt > input.completedRunsBefore
          ) return false;
          const uncertain = this.db.prepare(
            `SELECT 1 FROM workflow_deliveries
              WHERE run_id = ? AND state = 'uncertain' LIMIT 1`,
          ).get(runId);
          if (uncertain) return false;
          this.db.prepare(`DELETE FROM workflow_llm_calls WHERE run_id = ?`).run(runId);
          this.db.prepare(`DELETE FROM workflow_deliveries WHERE run_id = ?`).run(runId);
          this.db.prepare(
            `DELETE FROM workflow_edge_receipts
              WHERE submission_id IN (
                SELECT id FROM workflow_submissions WHERE run_id = ?
              )`,
          ).run(runId);
          this.db.prepare(
            `DELETE FROM workflow_node_attempts
              WHERE submission_id IN (
                SELECT id FROM workflow_submissions WHERE run_id = ?
              )`,
          ).run(runId);
          this.db.prepare(`DELETE FROM workflow_submissions WHERE run_id = ?`).run(runId);
          this.db.prepare(`DELETE FROM workflow_events WHERE run_id = ?`).run(runId);
          this.db.prepare(`DELETE FROM workflow_runs WHERE id = ?`).run(runId);
          return true;
        });
      } catch (error) {
        diagnose(error);
        failedRunIds.add(runId);
      }
      if (didDelete) deleted.push(runId);
    }
    return {
      compactedRunIds: compacted,
      deletedRunIds: deleted,
      failedRunCount: failedRunIds.size,
    };
  }

  workflowStatusCounts(): {
    activeRuns: number;
    queuedPersonaCalls: number;
    runningPersonaCalls: number;
    waitingDeliveries: number;
    uncertainDeliveries: number;
    inspectorGates: number;
    retainedRunCount: number;
    completedRunCount: number;
    deliveredDeliveries: number;
  } {
    const scalar = (sql: string): number => Number(
      (this.db.prepare(sql).get() as { count: number }).count,
    );
    const inspectorGates = (this.db.prepare(
      `SELECT * FROM workflow_runs
        WHERE gate_state_json IS NOT NULL
          AND status IN (
            'waiting_for_pr', 'waiting_for_inspector',
            'waiting_for_new_head', 'blocked'
          )`,
    ).all() as unknown[]).reduce<number>((count, row) => {
      try {
        return inspectorGateState(parseWorkflowRunRow(row)) ? count + 1 : count;
      } catch (error) {
        diagnose(error);
        return count;
      }
    }, 0);
    return {
      activeRuns: scalar(
        `SELECT COUNT(*) AS count FROM workflow_runs
          WHERE status NOT IN ('completed', 'cancelled', 'failed')`,
      ),
      queuedPersonaCalls: scalar(
        `SELECT COUNT(*) AS count FROM workflow_node_attempts
          WHERE state = 'queued' AND persona_snapshot_json IS NOT NULL`,
      ),
      runningPersonaCalls: scalar(
        `SELECT COUNT(*) AS count FROM workflow_llm_calls
          WHERE state = 'running' AND purpose = 'persona_review'`,
      ),
      waitingDeliveries: scalar(
        `SELECT COUNT(*) AS count FROM workflow_deliveries
          WHERE state IN ('prepared', 'sending')`,
      ),
      uncertainDeliveries: scalar(
        `SELECT COUNT(*) AS count FROM workflow_deliveries WHERE state = 'uncertain'`,
      ),
      inspectorGates,
      retainedRunCount: scalar(`SELECT COUNT(*) AS count FROM workflow_runs`),
      // The `ranked` population in `runRetention` above, counted rather than windowed -
      // finished, with a completion time, and not pinned by an uncertain delivery. This is
      // deliberately the SAME three predicates and not an approximation of them: the number
      // exists so the settings panel can show `maxCompletedRuns` against the rows that limit
      // actually ranks, and a count over a slightly different set would be a gauge that
      // disagrees with the sweep it claims to describe.
      completedRunCount: scalar(
        `SELECT COUNT(*) AS count FROM workflow_runs r
          WHERE r.status IN ('completed', 'cancelled')
            AND r.completed_at IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM workflow_deliveries d
               WHERE d.run_id = r.id AND d.state = 'uncertain'
            )`,
      ),
      // Among retained run families, compaction does not reduce this count: it blanks a
      // delivered row's payload and coarsens its error but never its state. Full run-family
      // deletion does reduce it because that stage removes the delivery rows too. The count
      // therefore reports retained confirmation without reading one byte of what was typed.
      deliveredDeliveries: scalar(
        `SELECT COUNT(*) AS count FROM workflow_deliveries WHERE state = 'delivered'`,
      ),
    };
  }

  runExportDetail(id: string): WorkflowRunDetail | null {
    const detail = this.runDetail(id);
    if (!detail) return null;
    const llmCalls = (this.db.prepare(
      `SELECT * FROM workflow_llm_calls
        WHERE run_id = ? ORDER BY started_at ASC, id ASC`,
    ).all(id) as unknown[]).map(parseWorkflowLlmCallRow);
    const events = this.listEvents(id);
    return {
      ...detail,
      events,
      eventCount: events.length,
      nextEventAfter: null,
      llmCalls,
      llmCallCount: llmCalls.length,
      nextLlmCallAfter: null,
    };
  }

  runDetail(id: string): WorkflowRunDetail | null {
    const summary = this.runSummary(id);
    const run = this.getRun(id);
    if (!summary || !run) return null;
    const binding = this.getBinding(run.bindingId);
    const version = this.getWorkflowVersionById(run.workflowVersionId);
    if (!binding) return null;
    const submissions = this.listSubmissions(id);
    const attempts = this.listAttemptsForRun(id);
    const offenders = repeatOffenders(submissions, attempts);
    const events = this.listEventPage(id);
    const llmCalls = this.listLlmCallPage(id);
    const eventCountRow = this.db.prepare(
      `SELECT COUNT(*) AS count FROM workflow_events WHERE run_id = ?`,
    ).get(id) as { count: number };
    const llmCallCountRow = this.db.prepare(
      `SELECT COUNT(*) AS count FROM workflow_llm_calls WHERE run_id = ?`,
    ).get(id) as { count: number };
    const eventCount = Number(eventCountRow.count);
    const llmCallCount = Number(llmCallCountRow.count);
    return {
      summary,
      binding,
      version,
      run,
      contextState: runContextState(submissions),
      submissions,
      attempts,
      receipts: this.listReceiptsForRun(id),
      deliveries: this.listDeliveries(id),
      events: events.items,
      eventCount,
      nextEventAfter: events.nextAfter,
      llmCalls: llmCalls.items,
      llmCallCount,
      nextLlmCallAfter: llmCalls.nextAfter,
      ...(offenders.length === 0 ? {} : { repeatOffenders: offenders }),
      // Taken off the summary the join already resolved, not looked up a second way. The
      // detail's field predates the summary's and stays because the reader reads it here;
      // what must not exist twice is the RULE deciding whether a claim is this run's.
      externalSource: summary.externalSource ?? null,
      inspectorGate: null,
    };
  }

  runDetailResult(id: string):
    | { kind: "found"; detail: WorkflowRunDetail }
    | { kind: "missing" | "corrupt" } {
    try {
      const detail = this.runDetail(id);
      if (detail) return { kind: "found", detail };
      const exists = this.db.prepare(`SELECT 1 FROM workflow_runs WHERE id = ?`).get(id);
      return exists ? { kind: "corrupt" } : { kind: "missing" };
    } catch (error) {
      diagnose(error);
      return { kind: "corrupt" };
    }
  }

  cancelRun(id: string, reason: string, now = Date.now()): WorkflowRun | null {
    return transaction(this.db, () => {
      const run = this.getRun(id);
      if (!run) return null;
      if (["completed", "cancelled", "failed"].includes(run.status)) return run;
      this.db.prepare(
        // `waiting` is in the set for the reason the other three are: a cancelled run must
        // leave nothing an observer would still pick up. An action attempt left waiting
        // would keep its delivery live and its pickup watch armed on a run nobody is
        // reviewing any more.
        `UPDATE workflow_node_attempts SET state = 'cancelled', error = ?,
                updated_at = ?, finished_at = COALESCE(finished_at, ?)
          WHERE submission_id IN (SELECT id FROM workflow_submissions WHERE run_id = ?)
            AND state IN ('queued', 'retry_wait', 'running', 'waiting')`,
      ).run(reason, now, now, id);
      this.db.prepare(
        `UPDATE workflow_submissions SET status = 'cancelled', updated_at = ?,
                completed_at = COALESCE(completed_at, ?)
          WHERE run_id = ? AND status NOT IN ('completed', 'cancelled', 'failed')`,
      ).run(now, now, id);
      this.cancelRunDeliveries(id, reason, "run_cancelled_during_send", now);
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
        this.cancelRunDeliveries(
          active.id,
          "binding_archived",
          "binding_archived_during_send",
          now,
        );
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

  private cancelRunDeliveries(
    runId: string,
    reason: string,
    uncertainReason: string,
    now: number,
  ): void {
    const sending = this.db.prepare(
      `SELECT id FROM workflow_deliveries WHERE run_id = ? AND state = 'sending'`,
    ).all(runId) as { id: string }[];
    this.db.prepare(
      `UPDATE workflow_deliveries
          SET state = 'cancelled', error = ?, updated_at = ?
        WHERE run_id = ? AND state IN ('prepared', 'refused')`,
    ).run(reason, now, runId);
    this.db.prepare(
      `UPDATE workflow_deliveries
          SET state = 'uncertain', error = ?, updated_at = ?
        WHERE run_id = ? AND state = 'sending'`,
    ).run(uncertainReason, now, runId);
    for (const delivery of sending) {
      this.appendEvent(runId, "delivery_uncertain", {
        deliveryId: delivery.id,
        reason: uncertainReason,
      }, now);
    }
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
      // Claims go before their bindings, in the same dependency order as everything above.
      // Left behind, a claim would point at a binding that no longer exists and the next
      // retry of the same external result would resolve to nothing it could open.
      //
      // Deleting the CLAIM is not deleting the orchestrator's own history: that lives in its
      // own tables, keeps its artifacts, and renders this run as removed.
      this.db.prepare(
        `DELETE FROM workflow_binding_claims
          WHERE binding_id IN (SELECT id FROM workflow_bindings WHERE note_key = ?)`,
      ).run(noteKey);
      this.db.prepare(`DELETE FROM workflow_bindings WHERE note_key = ?`).run(noteKey);
      return runIds;
    });
  }

  /**
   * How many unchanged-evidence refusals this run has taken in a row.
   *
   * Derived from the event log rather than held in `gate_state_json`, because every path that
   * opens a round - `createRepairSubmission`, `claimForemanCompletion`, the full restart -
   * writes `gate_state_json = NULL`, so a counter kept there would reset on exactly the event
   * it is supposed to be counting. The events are already durable, already indexed by
   * `(run_id, id)`, and are only ever deleted with the whole run family.
   *
   * "In a row" is the id of the newest reset. `submission_captured` is the honest reset - it is
   * appended only when a capture produced a fingerprint that DIFFERS, which is precisely "the
   * session changed something". `resubmit_unchanged_confirmed` resets too: a human looked at
   * the same bytes and said proceed anyway, and holding their override against the next
   * automatic round would block a run the human just unblocked.
   */
  consecutiveUnchangedRefusals(runId: string): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS n
         FROM workflow_events
        WHERE run_id = ?
          AND event_kind = 'resubmit_refused_unchanged'
          AND id > COALESCE((
            SELECT MAX(id) FROM workflow_events
             WHERE run_id = ?
               AND event_kind IN ('submission_captured', 'resubmit_unchanged_confirmed')
          ), 0)`,
    ).get(runId, runId) as { n: number | bigint } | undefined;
    return Number(row?.n ?? 0);
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

  /**
   * The other half of the re-arm pair: put the PROMPTED episode back in play.
   *
   * `rearmDrainCompletionForDelivery` above can only speak for a session that has queue
   * items - its `EXISTS` clause is what makes "the queue drained again" a true statement.
   * A session driven by a human prompt has no items at all, so before this existed a
   * confirmed repair packet re-armed nothing and the loop depended on a new human prompt.
   * Clearing `prompted_goal` is the exact inverse of what
   * `retirePromptedGuard` writes, so `decidePromptedWrapup` step 10 stops matching and the
   * episode is armed again.
   *
   * Deliberately UPDATE-only, matching the drain function's shape: an absent row means this
   * session has no wrap-up state to re-arm, and inserting one here would manufacture a queue
   * for a session Foreman was never watching. `retirePromptedGuard` may insert because it is
   * recording an episode that actually fired; this is only ever undoing one.
   */
  private rearmPromptedCompletionForDelivery(
    delivery: WorkflowDelivery,
    now: number,
  ): boolean {
    const result = this.db.prepare(
      `UPDATE foreman_queues
          SET prompted_goal = NULL, updated_at = ?
        WHERE note_key = ? AND prompted_goal IS NOT NULL`,
    ).run(now, delivery.noteKey);
    return Number(result.changes) === 1;
  }

  /**
   * Re-arm EXACTLY ONE completion episode for a confirmed delivery, and say which.
   *
   * Drain first, prompted only if drain declined. Re-arming both would let one repair packet
   * produce two completion claims and therefore two repair rounds for one fix - the session
   * would be reviewed twice for work it did once, and the second round would land on
   * `unchanged_evidence` because nothing moved between them.
   *
   * Drain wins the tie because it is the more specific statement: it fires only for a session
   * that has queue items and has drained them, which is a real event with a real moment. The
   * prompted episode is the fallback for a session Foreman is merely watching.
   */
  private rearmCompletionForDelivery(
    delivery: WorkflowDelivery,
    now: number,
  ): WorkflowCompletionKind | null {
    // A session action re-arms NOTHING. Every other packet asks the session to change the
    // work under review, so a Foreman completion afterwards is a legitimate new repair
    // round. An action asks it to perform one instruction, and the daemon's own observer
    // owns what happens next - re-arming here would let the session's completion signal
    // open a repair round that competes with the continuation segment for the same turn.
    if (delivery.kind === "session_action") return null;
    if (this.rearmDrainCompletionForDelivery(delivery, now)) return "drain";
    if (this.rearmPromptedCompletionForDelivery(delivery, now)) return "prompted";
    return null;
  }

  private retirePromptedGuard(
    binding: Pick<WorkflowBinding, "noteKey" | "sessionCwd">,
    episodeKey: string,
    now: number,
  ): boolean {
    const existing = this.db.prepare(
      `SELECT prompted_goal FROM foreman_queues WHERE note_key = ?`,
    ).get(binding.noteKey) as { prompted_goal: string | null } | undefined;
    if (existing?.prompted_goal === episodeKey) return false;
    if (existing) {
      const result = this.db.prepare(
        `UPDATE foreman_queues SET prompted_goal = ?, updated_at = ?
          WHERE note_key = ?
            AND (prompted_goal IS NULL OR prompted_goal <> ?)`,
      ).run(episodeKey, now, binding.noteKey, episodeKey);
      return Number(result.changes) === 1;
    }
    const result = this.db.prepare(
      `INSERT INTO foreman_queues (
         note_key, cwd, branch, wrapup_asked_at, wrapup_answer, prompted_goal, updated_at
       ) VALUES (?, ?, NULL, NULL, NULL, ?, ?)`,
    ).run(binding.noteKey, binding.sessionCwd, episodeKey, now);
    return Number(result.changes) === 1;
  }

  private insertSubmissionInTransaction(input: WorkflowSubmissionInsert): void {
    const segment = input.segment ?? 0;
    // The same all-or-nothing rule the row parser enforces, asserted before the write so a
    // caller that supplied half a continuation fails here rather than leaving a row that
    // reads as an ordinary repair round.
    if ((segment > 0) !== Boolean(input.continuation)) {
      throw new Error("A continuation segment requires exactly one parent attempt provenance");
    }
    this.db.prepare(
      `INSERT INTO workflow_submissions (
         id, run_id, round, segment, parent_submission_id, continuation_node_id,
         continuation_node_attempt_id, mode, trigger_source, trigger_key, evidence_fingerprint,
         context_json, evidence_json, pr_head_sha, status, created_at, updated_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 CASE WHEN ? IN ('completed', 'cancelled', 'failed') THEN ? ELSE NULL END)`,
    ).run(
      input.id,
      input.runId,
      input.round,
      segment,
      input.continuation?.parentSubmissionId ?? null,
      input.continuation?.nodeId ?? null,
      input.continuation?.nodeAttemptId ?? null,
      input.mode ?? "full_workflow",
      input.triggerSource,
      input.triggerKey,
      input.evidenceFingerprint ?? `capturing:${input.id}`,
      JSON.stringify(input.context),
      JSON.stringify(input.evidence),
      input.prHeadSha ?? null,
      input.status ?? "capturing",
      input.now,
      input.now,
      input.status ?? "capturing",
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

  /**
   * The addressable catalog Publish validates and snapshots against, built-ins included.
   *
   * The merge belongs here rather than at the call site because this list decides two things
   * at once - whether a draft's Persona nodes are valid, and which guidance bytes get frozen
   * into the version. Name shadowing cannot remove an id from either decision.
   */
  private listPersonasInTransaction(): Persona[] {
    const rows = this.db.prepare(
      `SELECT * FROM personas ORDER BY normalized_name ASC, id ASC`,
    ).all() as unknown[];
    return this.withAddressableBuiltins(rows.map((row) => parsePersonaRow(row)));
  }

  /** The SessionAction half of the same catalog, for the same reason. */
  private listSessionActionsInTransaction(): SessionAction[] {
    const rows = this.db.prepare(
      `SELECT * FROM session_actions ORDER BY normalized_name ASC, id ASC`,
    ).all() as unknown[];
    return this.withAddressableBuiltinActions(rows.map((row) => parseSessionActionRow(row)));
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
