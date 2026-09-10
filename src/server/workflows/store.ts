import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { RASTER_IMAGE_MIME_TYPES } from "@shared/images.ts";
import { canonicalSettingsBackupJson } from "@shared/settings-backups.ts";
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
  WorkflowCommandArgvSchema,
  WorkflowCompletionPolicySchema,
  WorkflowDraftGraphSchema,
  WorkflowExternalSourceKindSchema,
  WorkflowJsonSchema,
  WorkflowNodeAttemptStateSchema,
  WorkflowPersonaDirectiveSchema,
  WorkflowPersonaDirectiveSnapshotSchema,
  WorkflowRunCriteriaSchema,
  WorkflowRunIntentSnapshotSchema,
  WorkflowRunStatusSchema,
  WorkflowContextSnapshotSchema,
  WorkflowCheckEvidenceSchema,
  WorkflowEvidenceImageSchema,
  WorkflowEvidenceTextArtifactSchema,
  WorkflowEvidenceRepositoryScopeSchema,
  WorkflowEvidenceCoverageClaimSchema,
  WorkflowEvidenceCoverageLinkSchema,
  WorkflowEvidenceCoverageClaimsSchema,
  WorkflowEvidenceReadinessResultSchema,
  WorkflowCommandExitCodeSchema,
  WorkflowInspectorOnlyContextSchema,
  WorkflowSubmissionModeSchema,
  WorkflowSubmissionStatusSchema,
  WorkflowTriggerSourceSchema,
} from "@shared/protocol.ts";
import {
  JSON_UTF8_MAX_BYTES_PER_CHAR,
  WORKFLOW_BINDING_STATES,
  WORKFLOW_CHECK_SLOTS,
  WORKFLOW_DELIVERY_KINDS,
  WORKFLOW_DELIVERY_MODES,
  WORKFLOW_DELIVERY_STATES,
  WORKFLOW_EXECUTION_LIMITS,
  WORKFLOW_IMAGE_LIMITS,
  WORKFLOW_TEXT_EVIDENCE_LIMITS,
  WORKFLOW_EVIDENCE_COVERAGE_LIMITS,
  WORKFLOW_EVIDENCE_PROOF_CLASSES,
  WORKFLOW_EVIDENCE_READINESS_POLICIES,
  WORKFLOW_LIMITS,
  WORKFLOW_LLM_CALL_STATES,
  WORKFLOW_LLM_PURPOSES,
  WORKFLOW_RESUMPTION_POLICIES,
  WORKFLOW_RUN_SPENT_PHASES,
  WORKFLOW_SUBMISSION_REFINEMENT_REASONS,
  WORKFLOW_TRIGGER_MODES,
  LEGACY_WORKFLOW_RESUMPTION_POLICY,
  DEFAULT_WORKFLOW_EVIDENCE_READINESS_POLICY,
  DEFAULT_WORKFLOW_RESUMPTION_POLICY,
  SESSION_ACTION_COMPLETION_KINDS,
  emptyWorkflowCommandView,
  checkRunBudgetSpent,
  WORKFLOW_COMMAND_DEFAULT_MAX_RUNS,
  workflowRunResumesItself,
  personaOriginRank,
  personaSnapshotOf,
  personasForDisplay,
  sessionActionSnapshotOf,
  sessionActionsForDisplay,
  workflowEvidenceReadinessPolicyEnforces,
  workflowsForDisplay,
  type WorkflowTriggerSource,
  type WorkflowCompletionKind,
  type WorkflowDeliveryKind,
  type WorkflowGateSummary,
  type WorkflowInspectorGateState,
  type WorkflowResumptionPolicy,
  type WorkflowEvidenceImage,
  type WorkflowEvidenceInheritance,
  type WorkflowEvidenceTextArtifact,
  type WorkflowEvidenceRepositoryScope,
  type WorkflowCheckEvidence,
  type WorkflowStagedEvidenceImage,
  type WorkflowStagedEvidenceTextArtifact,
  type WorkflowStagedEvidenceList,
  type WorkflowStagedEvidenceCoverageClaim,
  type WorkflowEvidenceCoverageClaim,
  type WorkflowEvidenceReadinessPolicy,
  type WorkflowEvidenceReadinessResult,
  type WorkflowSubmissionReadinessOverride,
} from "@shared/workflow.ts";
import { SESSION_ACTION_COMPLETION_CAPABILITIES } from "@shared/workflow.ts";
import {
  WORKFLOW_PREFLIGHT_REFINEMENT_EXHAUSTED_PHASE,
  withInspectorGate,
  workflowInspectorGate,
  workflowRoundLimitParkedPhase,
  workflowRunLifecycleViolation,
  type WorkflowRunPhase,
} from "@shared/workflow-lifecycle.ts";
import type {
  Persona,
  PersonaProvenance,
  SessionAction,
  WorkflowBinding,
  WorkflowBindingSummary,
  WorkflowBindingClaim,
  WorkflowDeliveryMode,
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
  WorkflowPersonaDirective,
  WorkflowPersonaDirectiveSnapshot,
  WorkflowRun,
  WorkflowRunCriteria,
  WorkflowRunDetail,
  WorkflowRunIntentSnapshot,
  WorkflowRunPage,
  WorkflowRunSummary,
  WorkflowSubmissionEvidenceImages,
  WorkflowSubmissionEvidenceCoverage,
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
  WorkflowCheckSlot,
  WorkflowCommandOverride,
  WorkflowCommandView,
  WorkflowAssetReferenceSet,
} from "@shared/workflow.ts";
import {
  freezeWorkflowRunIntent,
  workflowRunIntentFingerprint,
  type WorkflowRunIntentInput,
} from "./intent-fingerprint.ts";
import type { LlmRunnerId } from "@shared/llm.ts";
import type { SessionIntentGuard } from "@shared/types.ts";
import { LLM_RUNNER_IDS } from "@shared/llm.ts";
import { consumePromptedGeneration, openDb } from "../db.ts";
import { BUILTIN_PERSONAS } from "./builtin-personas.ts";
import { BUILTIN_SESSION_ACTIONS } from "./builtin-session-actions.ts";
import { BUILTIN_WORKFLOWS, type BuiltinWorkflow } from "./builtin-workflows.ts";
import { validateWorkflowGraph } from "@shared/workflow-graph.ts";
import { TERMINAL_ITEM_STATES } from "@shared/queue.ts";
import { priorFindingFingerprintAudit } from "./finding-audit.ts";
import { workflowLog } from "./log.ts";
import { repeatOffenders } from "./repeat-offender.ts";
import type {
  SettingsBackupPersona,
  SettingsBackupSessionAction,
  SettingsBackupWorkflowCommand,
  SettingsBackupWorkflowDefinition,
  SettingsBackupWorkflowVersion,
} from "../settings-backups/catalogs.ts";

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
const PERSONA_DIRECTIVES_JSON_BYTES =
  WORKFLOW_LIMITS.personaDirectiveBytes * WORKFLOW_LIMITS.graphNodes + 100_000;
export const WORKFLOW_RETENTION_BATCH_SIZE = 100;

/**
 * How many consecutive evidence-preflight refinements one round may spend.
 *
 * Stated as a limit the count must EXCEED, exactly like `UNCHANGED_EVIDENCE_NUDGE_LIMIT` in
 * the manager: refinements one and two are reserved normally, and the run blocks on the third.
 * Reading it as "stop after the second" would refuse the segment that closes the gaps in the
 * common case, which is the repair this bound exists to leave room for.
 *
 * The bound is small on purpose. A preflight refinement re-measures a mapping the agent
 * already had every chance to declare, so a third consecutive one is evidence that the packet
 * and the preflight disagree about something a person has to settle - which is why exceeding
 * it parks the run for the operator rather than costing another repair round.
 */
export const EVIDENCE_PREFLIGHT_REFINEMENT_LIMIT = 2;

type RunCursor = { updatedAt: number; id: string };

/**
 * The one projection from graph nodes to Library asset identities.
 *
 * Both summary halves call this same helper so draft and published cannot quietly disagree
 * about how a node names its source. Sets remove repeated use of one asset while preserving
 * graph order; the output stays bounded by the graph's node ceiling.
 */
function workflowAssetReferenceSet(
  graph: WorkflowDefinition["draft"] | WorkflowVersion["graph"],
): WorkflowAssetReferenceSet {
  const personaIds = new Set<string>();
  const sessionActionIds = new Set<string>();
  for (const node of graph.nodes) {
    if (node.kind === "persona") {
      personaIds.add("persona" in node ? node.persona.sourcePersonaId : node.personaId);
    } else if (node.kind === "session_action") {
      sessionActionIds.add("action" in node
        ? node.action.sourceSessionActionId
        : node.sessionActionId);
    }
  }
  return { personaIds: [...personaIds], sessionActionIds: [...sessionActionIds] };
}

// A summary intentionally selects no submission evidence or context. The newest submission
// contributes only its identity and segment; attempts for the bounded result set are loaded
// in one follow-up query instead of three reads per run.
const WORKFLOW_RUN_SUMMARY_SELECT = `
  SELECT r.*, b.note_key, b.session_id, b.session_name,
         -- The run's repository, RESOLVED: a secondary repository's own root, or the
         -- session's root for the binding that follows its cwd. Resolved in SQL so no
         -- reader has to know that '' means "ask the session", and so a run whose session
         -- has gone still names the repository it reviewed.
         COALESCE(NULLIF(b.repo_root, ''), b.session_repo_root) AS run_repo_root,
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
         c.created_at AS claim_created_at,
         -- Whether a round parked in waiting_for_session picks itself back up. Aliased
         -- rather than taken bare because r.* is spread above and a future column of
         -- either name on workflow_runs would silently shadow one of these.
         --
         -- Read off the pinned VERSION and the binding, which is exactly the pair
         -- resumableRun consults before it resumes anything - so a surface reading these
         -- cannot promise an automatic resumption the observer will not perform. Both are
         -- already in scope on the existing joins; neither costs a new one.
         v.resumption_policy AS version_resumption_policy,
         b.delivery_mode AS binding_delivery_mode
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

/**
 * The gate a run holds, read through the one lifecycle decoder rather than by re-parsing the
 * column here. The manager asked the same question with its own copy of this function, and
 * the copies could not both learn that a round-limit block now carries the gate along with
 * the budget.
 */
function inspectorGateState(run: WorkflowRun): WorkflowInspectorGateState | null {
  return workflowInspectorGate(runLifecycleRecord(run));
}

function runLifecycleRecord(run: WorkflowRun): {
  status: WorkflowRun["status"];
  phase: string;
  gateState: WorkflowJson | null;
} {
  return { status: run.status, phase: run.currentPhase, gateState: run.gateState };
}

/**
 * Refuse a lifecycle triple no reader could recover from, before SQLite is touched.
 *
 * Throws rather than normalises, and throws rather than returning a refusal the caller can
 * ignore: every writer is in this repository, the suite exercises each of them, and a
 * combination that reaches here is a bug at the call site rather than a state some operator
 * produced. Silently rewriting it would persist a run its author did not mean, in a phase
 * nobody would think to look for.
 */
function assertRunLifecycle(
  id: string,
  status: WorkflowRun["status"],
  phase: string,
  gateState: WorkflowJson | null,
): void {
  const violation = workflowRunLifecycleViolation({ status, phase, gateState });
  if (violation) {
    throw new Error(`Workflow run ${id} cannot be persisted as ${status}/${phase}: ${violation}`);
  }
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
  "workflow_commands",
  "workflow_command_overrides",
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
  "workflow_submission_readiness_overrides",
  "workflow_binding_claims",
  "workflow_evidence_owners",
  "workflow_evidence_scope_generations",
  "workflow_evidence_staging",
  "workflow_evidence_coverage_staging",
  "workflow_evidence_reservations",
  "workflow_submission_images",
  "workflow_submission_evidence_coverage",
  "workflow_submission_text_artifacts",
  "workflow_image_cleanup",
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

// The schema's INPUT is stated as `unknown` because that is what a row read out of SQLite
// is. Leaving it to inference makes `T` bind to a schema's input shape wherever one differs
// from its output - which is every schema carrying `.optional().default(...)` for a column
// added by a migration - and the parsed row then reads as though those columns might be
// absent after they have already been defaulted.
function parseShape<T>(
  table: (typeof WORKFLOW_TABLES)[number],
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
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
 * Read a run's frozen review basis, saying WHICH of the three states it is in.
 *
 * Tolerant on purpose, and only here. Every other JSON column on this row throws through
 * `parseNullableJson`, which `getRun` catches by returning null - so a single damaged byte in
 * a snapshot would make the whole RUN disappear from every listing, leaving an operator with
 * a workflow that stopped and nothing at all to look at. That is a worse answer than the
 * problem it guards.
 *
 * It is emphatically NOT lenience about the intent itself. An unreadable payload is reported
 * as `unreadable`, which capture refuses; what survives is the run's identity, status and
 * phase, so the failure is diagnosable instead of invisible. Only a genuinely absent column
 * reads as `never_frozen`, and only that one takes the live-read path.
 *
 * Criteria are read here too because they are the other half of the same basis: criteria that
 * cannot be parsed cannot be reused, and treating them as merely absent would recompact the
 * run on every submission for ever - the write-once column can never be overwritten to settle
 * it.
 */
function readRunIntent(
  id: string,
  intentJson: string | null,
  criteriaJson: string | null,
): Pick<WorkflowRun, "intent" | "intentState" | "criteria"> {
  const read = <T>(column: string, raw: string, schema: z.ZodType<T>): T | undefined => {
    try {
      return parseJson(
        "workflow_runs",
        id,
        column,
        raw,
        schema,
        WORKFLOW_EXECUTION_LIMITS.contextJsonBytes,
      );
    } catch (error) {
      diagnose(error);
      return undefined;
    }
  };
  if (intentJson === null) {
    /*
     * No ask AND no criteria is the pre-migration row. No ask WITH criteria is not.
     *
     * A genuine legacy run has neither column: nothing ever wrote criteria for it, because the
     * legacy path compacts per submission and only a frozen run has a criteria set at all. So a
     * row carrying criteria beside a null intent did not come from an upgrade - it came from a
     * partial restore, or from two rows mixed together - and reading it as legacy would hand a
     * corrupted run to the mutable live Goal, which is the failure this mechanism exists to
     * remove. Dropping the stray payload and proceeding is not better: it is the same live-read
     * outcome, reached quietly.
     */
    if (criteriaJson !== null) {
      diagnose(new WorkflowRowError(
        "workflow_runs",
        id,
        "run_criteria_json is present with no intent_json, which no upgrade produces",
      ));
      return { intent: null, intentState: "unreadable", criteria: null };
    }
    return { intent: null, intentState: "never_frozen", criteria: null };
  }
  const intent = read("intent_json", intentJson, WorkflowRunIntentSnapshotSchema);
  if (!intent) return { intent: null, intentState: "unreadable", criteria: null };
  /*
   * Recomputed on the way out as well as derived on the way in.
   *
   * Deriving on write covers rows this build wrote. It says nothing about a row an older build
   * wrote from a caller-supplied fingerprint, or one a partial write left half-updated, and
   * those are exactly the rows whose stored identity would be a lie. Recomputing costs one
   * hash of already-loaded fields and makes the fingerprint a CHECKED fact rather than a
   * remembered one - which is what the criteria comparison below needs it to be.
   */
  if (workflowRunIntentFingerprint(intent) !== intent.fingerprint) {
    diagnose(new WorkflowRowError(
      "workflow_runs",
      id,
      "intent_json: the stored fingerprint does not identify the intent fields beside it",
    ));
    return { intent: null, intentState: "unreadable", criteria: null };
  }
  const criteria = criteriaJson === null
    ? null
    : read("run_criteria_json", criteriaJson, WorkflowRunCriteriaSchema);
  if (criteria === undefined) {
    return { intent, intentState: "unreadable", criteria: null };
  }
  /*
   * The two columns are read separately, so their RELATIONSHIP has to be checked here.
   *
   * A criteria payload that parses perfectly can still have been distilled from different
   * intent - a partial write, a restore that mixed rows, a hand edit. Reuse deliberately makes
   * no fingerprint comparison of its own, because frozen intent cannot move and comparing the
   * CAPTURED context against it would only add a way for an injected read to fall back to
   * recompaction. That reasoning holds exactly as far as the two stored halves agreeing, which
   * is this check and nowhere else.
   *
   * Mismatch is `unreadable` rather than a recompaction: criteria that do not belong to this
   * run's ask are not a missing value to be recomputed, they are evidence the row is wrong, and
   * a run whose frozen basis is wrong has no honest basis to review against.
   */
  if (criteria && criteria.intentFingerprint !== intent.fingerprint) {
    diagnose(new WorkflowRowError(
      "workflow_runs",
      id,
      "run_criteria_json: criteria were distilled from different intent than intent_json holds",
    ));
    return { intent, intentState: "unreadable", criteria: null };
  }
  return { intent, intentState: "frozen", criteria };
}

/**
 * Validate the frozen intent on the way IN, not only on the way out.
 *
 * A snapshot that parses on read and not on write would be a run whose review intent silently
 * reverts to the live Goal the first time it is captured - the failure this whole column
 * exists to remove, arrived at through a bounding mistake rather than a hook. Failing the
 * insert instead makes an over-long goal or decision list a loud, immediate error at the one
 * moment a human is watching a run start.
 */
/**
 * Serialize for a WRITE-ONCE column, refusing anything the read path could not load back.
 *
 * `parseJson` rejects a payload over `contextJsonBytes`, and both of these columns are set
 * once and never rewritten - so a row that is valid by schema and too large by bytes is
 * written successfully, read back as `unreadable`, and blocks its run for good with no path
 * that can repair it. The schemas genuinely permit it: 200 decisions at 16,000 characters each
 * for text and rationale is 6.4M against a 2M ceiling.
 *
 * Bounding at capture is not enough, for the reason every other invariant here moved to this
 * boundary: it leaves the rule with the caller, and the column is what has to live with the
 * consequence. Throwing costs a caller a loud failure at the one moment a human is watching a
 * run start, instead of a silent one that surfaces rounds later as a run nobody can unstick.
 */
function durableRunJson(id: string, column: string, value: unknown): string {
  const payload = JSON.stringify(value);
  const bytes = utf8.encode(payload).byteLength;
  if (bytes > WORKFLOW_EXECUTION_LIMITS.contextJsonBytes) {
    throw new WorkflowRowError(
      "workflow_runs",
      id,
      `${column} would be ${bytes} UTF-8 bytes, over the `
        + `${WORKFLOW_EXECUTION_LIMITS.contextJsonBytes} the read path can load back`,
    );
  }
  return payload;
}

function frozenIntentJson(id: string, intent: WorkflowRunIntentInput): string {
  // DERIVED here, never accepted from the caller. The fingerprint identifies the intent
  // fields beside it, so a supplied one is a second copy of a fact the snapshot already
  // holds - and a second copy can disagree. It has to be able to disagree for the disagreement
  // to matter: the criteria-provenance check compares a run's stored criteria against this
  // value, so an unverified fingerprint quietly weakens the check meant to catch criteria
  // distilled from another ask.
  return durableRunJson(
    id,
    "intent_json",
    WorkflowRunIntentSnapshotSchema.parse(freezeWorkflowRunIntent(intent)),
  );
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

/** Historical rows have no policy and resolve to the only non-enforcing posture. */
function readEvidenceReadinessPolicy(raw: string | null): WorkflowEvidenceReadinessPolicy {
  if (raw === null) return DEFAULT_WORKFLOW_EVIDENCE_READINESS_POLICY;
  if ((WORKFLOW_EVIDENCE_READINESS_POLICIES as readonly string[]).includes(raw)) {
    return raw as WorkflowEvidenceReadinessPolicy;
  }
  throw new TypeError(`Unknown workflow evidence readiness policy: ${raw}`);
}

/**
 * A binding's delivery mode, read off a summary join rather than a parsed binding row.
 *
 * `preview` is the unreadable-value answer for the reason `manual` is above: Preview is the
 * posture that never types, so a value this build cannot read degrades to the one that
 * cannot act on a pane it does not understand. The column is `NOT NULL` and
 * `parseWorkflowBindingRow` reads it strictly, so this only ever fires on a value written by
 * a newer build.
 */
function readDeliveryMode(raw: unknown): WorkflowDeliveryMode {
  return typeof raw === "string" && (WORKFLOW_DELIVERY_MODES as readonly string[]).includes(raw)
    ? (raw as WorkflowDeliveryMode)
    : "preview";
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

/**
 * The stored argv, held to the SAME bounds the write path enforces.
 *
 * Re-validated on read rather than trusted, because these bytes are executed: an argv that
 * reached the column by any route other than the update schema - a downgrade, a hand-edited
 * row - must fail its row rather than reach a spawn.
 */
const CommandArgvJsonSchema = WorkflowCommandArgvSchema;

/**
 * A ceiling on the stored JSON blob, derived from the argv bounds rather than chosen.
 *
 * `checkCommandLength` rather than `checkCommandArgs * checkCommandArg`, because the joined
 * bound is the binding one: whatever the per-argument ceiling allows, the schema refuses an argv
 * whose arguments and separators exceed 4,000 characters together.
 *
 * Multiplied by `JSON_UTF8_MAX_BYTES_PER_CHAR` for the reason the route's body limit is: that
 * ceiling counts CHARACTERS and this one counts BYTES, and a bound that conflated them would
 * fail a row holding an argv the write path had just accepted - the read would report the
 * operator's own configured command as unreadable, and the gate would silently skip.
 *
 * Its job is to stop one malformed row from making every later read expensive, not to be the
 * real bound - the schema above is.
 */
const COMMAND_ARGV_JSON_BYTES =
  WORKFLOW_LIMITS.checkCommandLength * JSON_UTF8_MAX_BYTES_PER_CHAR
  + WORKFLOW_LIMITS.checkCommandArgs * 8;

const WorkflowCommandRowSchema = z.object({
  slot: z.enum(WORKFLOW_CHECK_SLOTS),
  default_command_json: nullableText,
  /*
   * Deliberately UNTYPED in the row schema, and read by `readCommandMaxRuns` instead.
   *
   * The same field-level tolerance `default_command_json` gets from `readCommandArgv`, for
   * the same reason: a slot whose budget is unreadable must still project the command an
   * operator configured, so they can see it and repair it. Bounding the column here would
   * make a database mid-upgrade (no column at all) or one hand-edited to `0` degrade the
   * WHOLE slot to "Not configured", hiding a command that is perfectly good.
   */
  max_runs: z.unknown().optional(),
  revision: positive,
  created_at: integer,
  updated_at: integer,
});

const WorkflowCommandOverrideRowSchema = z.object({
  slot: z.enum(WORKFLOW_CHECK_SLOTS),
  repo_root: nonempty.max(WORKFLOW_LIMITS.checkRepoRoot),
  command_json: nonempty,
  created_at: integer,
  updated_at: integer,
});
type WorkflowCommandOverrideRow = z.infer<typeof WorkflowCommandOverrideRowSchema>;

/**
 * An argv column, or null when this build cannot read what is in it.
 *
 * Degrades the FIELD rather than the row, and that asymmetry is load-bearing. The slot row
 * also carries the `revision` every write compares against, so failing it whole would report
 * revision 1 for a row sitting at revision 5 - and the slot would become permanently
 * unwritable, every compare-and-swap refused as stale against a number no caller could ever
 * learn. An unreadable command instead reads as "not configured", which SKIPS, and the next
 * save repairs it. That is the recovery the per-slot degrade exists to enable.
 */
function readCommandArgv(
  table: (typeof WORKFLOW_TABLES)[number],
  id: string,
  column: string,
  raw: string | null,
): string[] | null {
  if (raw === null) return null;
  try {
    return parseJson(table, id, column, raw, CommandArgvJsonSchema, COMMAND_ARGV_JSON_BYTES);
  } catch (error) {
    diagnose(error);
    return null;
  }
}

/**
 * A Command's per-run execution budget, or the default when the column cannot supply one.
 *
 * Answers all four absences with one rule - the column missing on a database mid-upgrade, a
 * NULL, a non-number, and a number outside the range the write path enforces. The last is a
 * clamp rather than a rejection because both directions have a safe reading: `0` or a
 * negative means "never run", which this catalog expresses by leaving the slot unconfigured
 * and must not silently become a permanently dead gate, and a number above the ceiling means
 * "always run", which the ceiling already is.
 */
function readCommandMaxRuns(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return WORKFLOW_COMMAND_DEFAULT_MAX_RUNS;
  return Math.min(
    Math.max(Math.round(raw), WORKFLOW_LIMITS.commandMaxRunsMin),
    WORKFLOW_LIMITS.commandMaxRunsMax,
  );
}

/** An override, or null when its argv is unreadable - in which case it is not projected. */
function parseWorkflowCommandOverrideRow(
  row: WorkflowCommandOverrideRow,
): WorkflowCommandOverride | null {
  const command = readCommandArgv(
    "workflow_command_overrides",
    `${row.slot}:${row.repo_root}`,
    "command_json",
    row.command_json,
  );
  return command ? { repoRoot: row.repo_root, command } : null;
}

/**
 * Whether two override sets are the same configuration.
 *
 * Compared as a SET keyed by path rather than pairwise down two arrays, deliberately. The
 * stored side comes back in SQLite's own `ORDER BY repo_root` collation and the requested side
 * arrives in whatever order a caller sent; an index-wise comparison would report two identical
 * configurations as different wherever those two orders disagree, and the only consequence
 * visible to an operator would be a revision bump and a redraw nothing asked for.
 */
function sameOverrides(
  a: readonly WorkflowCommandOverride[],
  b: readonly WorkflowCommandOverride[],
): boolean {
  const byPath = new Map(a.map((entry) => [entry.repoRoot, entry.command]));
  // A list carrying the same path twice describes no set at all, so it can never be "the
  // configuration already stored" - the stored side is unique by its composite primary key.
  // Answering "unchanged" for one would silently keep a row it does not contain.
  if (byPath.size !== a.length) return false;
  if (new Set(b.map((entry) => entry.repoRoot)).size !== b.length) return false;
  if (a.length !== b.length) return false;
  return b.every((entry) => {
    const command = byPath.get(entry.repoRoot);
    return command !== undefined
      && command.length === entry.command.length
      && command.every((arg, index) => arg === entry.command[index]);
  });
}

function parseWorkflowCommandRow(
  value: unknown,
  overrides: WorkflowCommandOverride[],
): WorkflowCommandView {
  const row = parseShape("workflow_commands", WorkflowCommandRowSchema, value);
  return {
    slot: row.slot,
    defaultCommand: readCommandArgv(
      "workflow_commands",
      row.slot,
      "default_command_json",
      row.default_command_json,
    ),
    maxRuns: readCommandMaxRuns(row.max_runs),
    overrides,
    revision: row.revision,
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
  // Tolerant on READ for the reason `readResumptionPolicy` documents: an absent column on an
  // upgrading database and an unknown value from a newer build are both answered there.
  resumption_policy: nullableText.optional().default(null),
  evidence_readiness_policy: z.enum(WORKFLOW_EVIDENCE_READINESS_POLICIES)
    .nullable().optional().default(null),
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
    evidenceReadinessPolicy: readEvidenceReadinessPolicy(row.evidence_readiness_policy ?? null),
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
  evidence_readiness_policy: z.enum(WORKFLOW_EVIDENCE_READINESS_POLICIES)
    .nullable().optional().default(null),
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
    evidenceReadinessPolicy: readEvidenceReadinessPolicy(row.evidence_readiness_policy ?? null),
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
    evidenceReadinessPolicy: readEvidenceReadinessPolicy(row.evidence_readiness_policy ?? null),
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
  // Optional-with-a-default like every other post-hoc column: a row read by a build whose
  // migrate() has not run yet still parses, and "" is what such a row genuinely is.
  repo_root: text.optional().default(""),
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
    repoRoot: row.repo_root ?? "",
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
  persona_directives_json: nullableText.optional().default(null),
  check_budget_epoch_round: nullableInteger.optional().default(null),
  intent_json: nullableText.optional().default(null),
  run_criteria_json: nullableText.optional().default(null),
});

/** Node ids an operator disabled for one run. Bounded by the graph's own node ceiling. */
const DisabledNodesSchema = z.array(nonempty.max(200)).max(WORKFLOW_LIMITS.graphNodes);
const PersonaDirectivesSchema = z.array(WorkflowPersonaDirectiveSchema)
  .max(WORKFLOW_LIMITS.graphNodes)
  .refine((items) => new Set(items.map((item) => item.nodeId)).size === items.length, {
    message: "Persona directive node ids must not repeat",
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
    disabledNodeIds: parseNullableJson(
      "workflow_runs",
      row.id,
      "disabled_nodes_json",
      row.disabled_nodes_json ?? null,
      DisabledNodesSchema,
    ) ?? [],
    personaDirectives: parseNullableJson(
      "workflow_runs",
      row.id,
      "persona_directives_json",
      row.persona_directives_json ?? null,
      PersonaDirectivesSchema,
      PERSONA_DIRECTIVES_JSON_BYTES,
    ) ?? [],
    checkBudgetEpochRound: row.check_budget_epoch_round ?? null,
    ...readRunIntent(row.id, row.intent_json ?? null, row.run_criteria_json ?? null),
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    evidencePrunedAt: row.evidence_pruned_at ?? null,
  };
}

type WorkflowSubmissionOrigin =
  | { kind: "root" }
  | {
      kind: "session_action";
      segment: number;
      parentSubmissionId: string;
      nodeId: string;
      nodeAttemptId: string;
    }
  | {
      kind: "evidence_preflight";
      segment: number;
      parentSubmissionId: string;
    };

interface WorkflowSubmissionOriginColumns {
  segment: number;
  parentSubmissionId: string | null;
  continuationNodeId: string | null;
  continuationNodeAttemptId: string | null;
  refinementReason: "session_action" | "evidence_preflight" | null;
}

function workflowSubmissionOriginColumns(
  origin: WorkflowSubmissionOrigin,
): WorkflowSubmissionOriginColumns {
  switch (origin.kind) {
    case "root":
      return {
        segment: 0,
        parentSubmissionId: null,
        continuationNodeId: null,
        continuationNodeAttemptId: null,
        refinementReason: null,
      };
    case "session_action":
      if (
        origin.segment <= 0
        || !origin.parentSubmissionId
        || !origin.nodeId
        || !origin.nodeAttemptId
      ) throw new Error("A session-action origin requires complete positive-segment provenance");
      return {
        segment: origin.segment,
        parentSubmissionId: origin.parentSubmissionId,
        continuationNodeId: origin.nodeId,
        continuationNodeAttemptId: origin.nodeAttemptId,
        refinementReason: origin.kind,
      };
    case "evidence_preflight":
      if (origin.segment <= 0 || !origin.parentSubmissionId) {
        throw new Error("An evidence-preflight origin requires parent provenance and a positive segment");
      }
      return {
        segment: origin.segment,
        parentSubmissionId: origin.parentSubmissionId,
        continuationNodeId: null,
        continuationNodeAttemptId: null,
        refinementReason: origin.kind,
      };
  }
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
  refinement_reason: z.enum(WORKFLOW_SUBMISSION_REFINEMENT_REASONS).nullable().optional().default(null),
  mode: WorkflowSubmissionModeSchema,
  trigger_source: WorkflowTriggerSourceSchema,
  trigger_key: nonempty,
  evidence_group_key: text.optional().default(""),
  staged_image_generation: integer.nonnegative().optional().default(0),
  evidence_fingerprint: nonempty,
  repository_fingerprint: nullableText.optional().default(null),
  context_json: nonempty,
  evidence_json: nonempty,
  readiness_json: nullableText.optional().default(null),
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
  // Rows written before refinement_reason existed are Phase 1 action continuations. Infer
  // that one historical shape so an upgrade does not make durable child segments unreadable.
  // Evidence-preflight rows are new and always persist their explicit reason.
  const parentSubmissionId = row.parent_submission_id ?? null;
  const continuationNodeId = row.continuation_node_id ?? null;
  const continuationNodeAttemptId = row.continuation_node_attempt_id ?? null;
  const reason = row.refinement_reason ?? (
    segment > 0
      && parentSubmissionId !== null
      && continuationNodeId !== null
      && continuationNodeAttemptId !== null
      ? "session_action"
      : null
  );
  let origin: WorkflowSubmissionOrigin | null = null;
  switch (reason) {
    case null:
      if (
        segment === 0
        && parentSubmissionId === null
        && continuationNodeId === null
        && continuationNodeAttemptId === null
      ) origin = { kind: "root" };
      break;
    case "session_action":
      if (
        segment > 0
        && parentSubmissionId !== null
        && continuationNodeId !== null
        && continuationNodeAttemptId !== null
      ) {
        origin = {
          kind: reason,
          segment,
          parentSubmissionId,
          nodeId: continuationNodeId,
          nodeAttemptId: continuationNodeAttemptId,
        };
      }
      break;
    case "evidence_preflight":
      if (
        segment > 0
        && parentSubmissionId !== null
        && continuationNodeId === null
        && continuationNodeAttemptId === null
      ) {
        origin = {
          kind: reason,
          segment,
          parentSubmissionId,
        };
      }
      break;
    default: {
      const unhandledReason: never = reason;
      return unhandledReason;
    }
  }
  if (!origin) {
    throw new WorkflowRowError(
      "workflow_submissions",
      row.id,
      "refinement provenance does not match the segment reason",
    );
  }
  const provenance = workflowSubmissionOriginColumns(origin);
  return {
    id: row.id,
    runId: row.run_id,
    round: row.round,
    segment: provenance.segment,
    parentSubmissionId: provenance.parentSubmissionId,
    continuationNodeId: provenance.continuationNodeId,
    continuationNodeAttemptId: provenance.continuationNodeAttemptId,
    refinementReason: provenance.refinementReason,
    mode: row.mode,
    triggerSource: row.trigger_source,
    triggerKey: row.trigger_key,
    evidenceGroupKey: row.evidence_group_key || undefined,
    stagedImageGeneration: row.staged_image_generation ?? 0,
    evidenceFingerprint: row.evidence_fingerprint,
    repositoryFingerprint: row.repository_fingerprint,
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
    readiness: parseNullableJson(
      "workflow_submissions",
      row.id,
      "readiness_json",
      row.readiness_json ?? null,
      WorkflowEvidenceReadinessResultSchema,
      WORKFLOW_EVIDENCE_COVERAGE_LIMITS.readinessJsonBytes,
    ),
    prHeadSha: row.pr_head_sha,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

const WorkflowEvidenceStagingRowSchema = z.object({
  id: nonempty.max(200),
  note_key: nonempty,
  client_item_id: nonempty.max(WORKFLOW_IMAGE_LIMITS.clientItemIdChars),
  source_kind: z.enum(["agent", "upload", "retained", "command"]),
  evidence_kind: z.enum(["image", "text"]).optional().default("image"),
  source_root: nonempty,
  source_locator: nonempty.max(WORKFLOW_IMAGE_LIMITS.relativePathChars),
  inline_content: nullableText.optional().default(null),
  command_exit_code: WorkflowCommandExitCodeSchema.nullable().optional().default(null),
  episode_key: nullableText.optional().default(null),
  display_name: nonempty.max(WORKFLOW_IMAGE_LIMITS.displayNameChars),
  caption: nonempty.max(WORKFLOW_IMAGE_LIMITS.captionChars),
  repository_scope: WorkflowEvidenceRepositoryScopeSchema,
  mime_type: nonempty,
  bytes: positive.max(Math.max(
    WORKFLOW_IMAGE_LIMITS.maxBytesPerImage,
    WORKFLOW_TEXT_EVIDENCE_LIMITS.maxBytesPerArtifact,
  )),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  generation: positive,
  state: z.enum(["staged", "reserved"]),
  reserved_group_key: nullableText,
  created_at: integer,
  updated_at: integer,
}).superRefine((row, ctx) => {
  if ((row.state === "staged") !== (row.reserved_group_key === null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reserved_group_key"],
      message: "Reserved state and evidence group must be present together",
    });
  }
  if (row.evidence_kind === "image" && !RASTER_IMAGE_MIME_TYPES.includes(
    row.mime_type as (typeof RASTER_IMAGE_MIME_TYPES)[number],
  )) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["mime_type"], message: "Invalid image MIME type" });
  }
  if (row.evidence_kind === "text" && row.mime_type !== "text/plain") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["mime_type"], message: "Invalid text artifact MIME type" });
  }
  if (row.evidence_kind === "text" && !["agent", "command"].includes(row.source_kind)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["source_kind"], message: "Text evidence must come from an agent path or command output" });
  }
  if (row.source_kind === "command" && row.evidence_kind !== "text") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["evidence_kind"], message: "Command evidence must be text" });
  }
  if ((row.source_kind === "command") !== (row.inline_content !== null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["inline_content"],
      message: "Only command evidence carries inline content, and command evidence must carry it",
    });
  }
  // Command evidence existed before exit status gained a dedicated column. Those rows still
  // carry the status in their integrity-checked inline artifact, but NULL is the only honest
  // structured value for a field their writer never recorded. New writes remain strict in
  // stageWorkflowEvidence, while non-command rows may never claim command status.
  if (row.source_kind !== "command" && row.command_exit_code !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["command_exit_code"],
      message: "Only command evidence carries an exit code",
    });
  }
  if (row.source_kind === "command" && row.inline_content !== null) {
    const bytes = Buffer.byteLength(row.inline_content, "utf8");
    const sha256 = createHash("sha256").update(Buffer.from(row.inline_content, "utf8")).digest("hex");
    if (bytes !== row.bytes || sha256 !== row.sha256) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["inline_content"],
        message: "Command evidence content does not match its byte count and digest",
      });
    }
  }
  const byteLimit = row.evidence_kind === "image"
    ? WORKFLOW_IMAGE_LIMITS.maxBytesPerImage
    : WORKFLOW_TEXT_EVIDENCE_LIMITS.maxBytesPerArtifact;
  if (row.bytes > byteLimit) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["bytes"], message: "Evidence item exceeds its byte limit" });
  }
});

export type WorkflowEvidenceStagingRow = z.infer<typeof WorkflowEvidenceStagingRowSchema>;

export function parseWorkflowEvidenceStagingRow(value: unknown): WorkflowEvidenceStagingRow {
  const row = parseShape("workflow_evidence_staging", WorkflowEvidenceStagingRowSchema, value);
  return {
    ...row,
    evidence_kind: row.evidence_kind ?? "image",
    inline_content: row.inline_content ?? null,
    command_exit_code: row.command_exit_code ?? null,
    episode_key: row.episode_key ?? null,
  };
}

const WorkflowEvidenceCoverageStagingRowSchema = z.object({
  id: nonempty.max(200),
  note_key: nonempty,
  client_criterion_id: nonempty.max(WORKFLOW_EVIDENCE_COVERAGE_LIMITS.clientCriterionIdChars),
  criterion: nonempty.max(WORKFLOW_EVIDENCE_COVERAGE_LIMITS.criterionBytes),
  proof_class: z.enum(WORKFLOW_EVIDENCE_PROOF_CLASSES),
  repository_scope: WorkflowEvidenceRepositoryScopeSchema,
  source_root: nonempty,
  links_json: nonempty,
  episode_key: nullableText.optional().default(null),
  generation: positive,
  state: z.enum(["staged", "reserved"]),
  reserved_group_key: nullableText,
  created_at: integer,
  updated_at: integer,
}).superRefine((row, ctx) => {
  if ((row.state === "staged") !== (row.reserved_group_key === null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reserved_group_key"],
      message: "Reserved state and evidence group must be present together",
    });
  }
});

export type WorkflowEvidenceCoverageStagingRow = z.infer<
  typeof WorkflowEvidenceCoverageStagingRowSchema
>;

export function parseWorkflowEvidenceCoverageStagingRow(
  value: unknown,
): WorkflowEvidenceCoverageStagingRow {
  const row = parseShape(
    "workflow_evidence_coverage_staging",
    WorkflowEvidenceCoverageStagingRowSchema,
    value,
  );
  return { ...row, episode_key: row.episode_key ?? null };
}

function coverageClaimFromRow(row: WorkflowEvidenceCoverageStagingRow): WorkflowEvidenceCoverageClaim {
  return WorkflowEvidenceCoverageClaimSchema.parse({
    clientCriterionId: row.client_criterion_id,
    criterion: row.criterion,
    proofClass: row.proof_class,
    repositoryScope: row.repository_scope,
    links: parseJson(
      "workflow_evidence_coverage_staging",
      row.id,
      "links_json",
      row.links_json,
      z.array(WorkflowEvidenceCoverageLinkSchema)
        .max(WORKFLOW_EVIDENCE_COVERAGE_LIMITS.linksPerClaim),
      WORKFLOW_EVIDENCE_COVERAGE_LIMITS.aggregateJsonBytes,
    ),
  });
}

const WorkflowSubmissionCoverageRowSchema = z.object({
  submission_id: nonempty,
  staging_id: nonempty,
  client_criterion_id: nonempty.max(WORKFLOW_EVIDENCE_COVERAGE_LIMITS.clientCriterionIdChars),
  criterion: nonempty.max(WORKFLOW_EVIDENCE_COVERAGE_LIMITS.criterionBytes),
  proof_class: z.enum(WORKFLOW_EVIDENCE_PROOF_CLASSES),
  repository_scope: WorkflowEvidenceRepositoryScopeSchema,
  links_json: nonempty,
  inherited_from_submission_id: nullableText.optional().default(null),
  generation: positive,
  created_at: integer,
  updated_at: integer,
});

function submissionCoverageClaimFromRow(value: unknown): WorkflowEvidenceCoverageClaim {
  const row = parseShape(
    "workflow_submission_evidence_coverage",
    WorkflowSubmissionCoverageRowSchema,
    value,
  );
  return WorkflowEvidenceCoverageClaimSchema.parse({
    clientCriterionId: row.client_criterion_id,
    criterion: row.criterion,
    proofClass: row.proof_class,
    repositoryScope: row.repository_scope,
    links: parseJson(
      "workflow_submission_evidence_coverage",
      `${row.submission_id}:${row.client_criterion_id}`,
      "links_json",
      row.links_json,
      z.array(WorkflowEvidenceCoverageLinkSchema)
        .max(WORKFLOW_EVIDENCE_COVERAGE_LIMITS.linksPerClaim),
      WORKFLOW_EVIDENCE_COVERAGE_LIMITS.aggregateJsonBytes,
    ),
    // Spread, not a null: a claim its own author declared is shaped exactly as it was before
    // carry-forward existed, in the immutable context and on the wire alike.
    ...(row.inherited_from_submission_id
      ? { inheritedFromSubmissionId: row.inherited_from_submission_id }
      : {}),
  });
}

const WorkflowSubmissionImageRowSchema = z.object({
  id: nonempty.max(200),
  submission_id: nonempty,
  staging_id: nonempty,
  ordinal: integer.nonnegative(),
  display_name: nonempty.max(WORKFLOW_IMAGE_LIMITS.displayNameChars),
  caption: nonempty.max(WORKFLOW_IMAGE_LIMITS.captionChars),
  repository_scope: WorkflowEvidenceRepositoryScopeSchema,
  mime_type: z.enum(RASTER_IMAGE_MIME_TYPES),
  bytes: positive.max(WORKFLOW_IMAGE_LIMITS.maxBytesPerImage),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  storage_relative_path: nonempty.max(WORKFLOW_IMAGE_LIMITS.relativePathChars),
  availability: z.enum(["retained", "pruned"]),
  pruned_at: nullableInteger,
  // Optional with a default, not merely nullable: a frozen row written before these columns
  // existed reads as self-captured rather than as malformed.
  inherited_from_submission_id: nullableText.optional().default(null),
  origin_round: nullableInteger.optional().default(null),
  origin_repository_fingerprint: nullableText.optional().default(null),
  created_at: integer,
}).superRefine((row, ctx) => {
  if ((row.availability === "retained") !== (row.pruned_at === null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["pruned_at"],
      message: "Pruned availability and pruning timestamp must be present together",
    });
  }
  /*
   * Carry-forward provenance is one fact in three columns, not three facts.
   *
   * A row that names an origin submission without saying which round it captured in cannot be
   * judged for staleness, and one that names a round with no origin submission is describing a
   * carry that did not happen. Reading either as fresh evidence - which is what a tolerant
   * reader does - would quietly present carried bytes to a Persona as though this submission
   * had just taken them, which is the exact misrepresentation the mark exists to prevent. A
   * malformed row is refused here like every other malformed row in this file.
   *
   * `origin_repository_fingerprint` is allowed to stand alone as null: a source submission
   * whose capture failed genuinely has no fingerprint to carry, and inventing one would invent
   * a comparison.
   */
  if ((row.inherited_from_submission_id === null) !== (row.origin_round === null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["origin_round"],
      message: "Carried evidence must name both its origin submission and its origin round",
    });
  }
  if (row.inherited_from_submission_id === null && row.origin_repository_fingerprint !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["origin_repository_fingerprint"],
      message: "Evidence captured here cannot carry an origin repository fingerprint",
    });
  }
});

export type WorkflowSubmissionImageRow = z.infer<typeof WorkflowSubmissionImageRowSchema>;

export function parseWorkflowSubmissionImageRow(value: unknown): WorkflowSubmissionImageRow {
  return parseShape("workflow_submission_images", WorkflowSubmissionImageRowSchema, value);
}

/**
 * The carry-forward mark, or null for a row this submission captured itself.
 *
 * All three columns move together: a row that names an origin submission without saying
 * which round it captured in cannot be judged for staleness, and reporting it as inherited
 * anyway would be worse than reporting nothing. `origin_repository_fingerprint` is allowed
 * to stay null on its own because a source submission whose capture failed genuinely has no
 * fingerprint to carry, and inventing one would invent a comparison.
 */
function inheritanceFromRow(row: {
  inherited_from_submission_id?: string | null;
  origin_round?: number | null;
  origin_repository_fingerprint?: string | null;
}): WorkflowEvidenceInheritance | null {
  // The row schema has already refused any partial combination, so the origin submission alone
  // decides this and the round beside it is guaranteed. Reading the two independently here is
  // what would let a half-written row pass as fresh evidence.
  if (!row.inherited_from_submission_id) return null;
  return {
    submissionId: row.inherited_from_submission_id,
    round: row.origin_round!,
    repositoryFingerprint: row.origin_repository_fingerprint ?? null,
  };
}

function workflowEvidenceImageFromRow(row: WorkflowSubmissionImageRow): WorkflowEvidenceImage {
  return WorkflowEvidenceImageSchema.parse({
    id: row.id,
    ordinal: row.ordinal,
    displayName: row.display_name,
    caption: row.caption,
    repositoryScope: row.repository_scope,
    mimeType: row.mime_type,
    bytes: row.bytes,
    sha256: row.sha256,
    inheritedFrom: inheritanceFromRow(row),
    availability: row.availability,
    prunedAt: row.pruned_at,
    createdAt: row.created_at,
  });
}

const WorkflowSubmissionTextArtifactRowSchema = z.object({
  id: nonempty.max(200),
  submission_id: nonempty,
  staging_id: nonempty,
  ordinal: integer.nonnegative(),
  display_name: nonempty.max(WORKFLOW_TEXT_EVIDENCE_LIMITS.displayNameChars),
  caption: nonempty.max(WORKFLOW_TEXT_EVIDENCE_LIMITS.captionChars),
  repository_scope: WorkflowEvidenceRepositoryScopeSchema,
  mime_type: z.literal("text/plain"),
  bytes: positive.max(WORKFLOW_TEXT_EVIDENCE_LIMITS.maxBytesPerArtifact),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  content: z.string(),
  availability: z.enum(["retained", "pruned"]),
  pruned_at: nullableInteger,
  // Optional with a default, not merely nullable: a frozen row written before these columns
  // existed reads as self-captured rather than as malformed.
  inherited_from_submission_id: nullableText.optional().default(null),
  origin_round: nullableInteger.optional().default(null),
  origin_repository_fingerprint: nullableText.optional().default(null),
  created_at: integer,
}).superRefine((row, ctx) => {
  if ((row.availability === "retained") !== (row.pruned_at === null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["pruned_at"],
      message: "Pruned availability and pruning timestamp must be present together",
    });
  }
  /*
   * Carry-forward provenance is one fact in three columns, not three facts.
   *
   * A row that names an origin submission without saying which round it captured in cannot be
   * judged for staleness, and one that names a round with no origin submission is describing a
   * carry that did not happen. Reading either as fresh evidence - which is what a tolerant
   * reader does - would quietly present carried bytes to a Persona as though this submission
   * had just taken them, which is the exact misrepresentation the mark exists to prevent. A
   * malformed row is refused here like every other malformed row in this file.
   *
   * `origin_repository_fingerprint` is allowed to stand alone as null: a source submission
   * whose capture failed genuinely has no fingerprint to carry, and inventing one would invent
   * a comparison.
   */
  if ((row.inherited_from_submission_id === null) !== (row.origin_round === null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["origin_round"],
      message: "Carried evidence must name both its origin submission and its origin round",
    });
  }
  if (row.inherited_from_submission_id === null && row.origin_repository_fingerprint !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["origin_repository_fingerprint"],
      message: "Evidence captured here cannot carry an origin repository fingerprint",
    });
  }
});

export type WorkflowSubmissionTextArtifactRow = z.infer<typeof WorkflowSubmissionTextArtifactRowSchema>;

export function parseWorkflowSubmissionTextArtifactRow(value: unknown): WorkflowSubmissionTextArtifactRow {
  return parseShape(
    "workflow_submission_text_artifacts",
    WorkflowSubmissionTextArtifactRowSchema,
    value,
  );
}

function workflowEvidenceTextArtifactFromRow(
  row: WorkflowSubmissionTextArtifactRow,
): WorkflowEvidenceTextArtifact {
  return WorkflowEvidenceTextArtifactSchema.parse({
    id: row.id,
    ordinal: row.ordinal,
    displayName: row.display_name,
    caption: row.caption,
    repositoryScope: row.repository_scope,
    mimeType: row.mime_type,
    bytes: row.bytes,
    sha256: row.sha256,
    content: row.content,
    inheritedFrom: inheritanceFromRow(row),
    availability: row.availability,
    prunedAt: row.pruned_at,
    createdAt: row.created_at,
  });
}

const WorkflowNodeAttemptRowSchema = z.object({
  id: nonempty,
  submission_id: nonempty,
  node_id: nonempty,
  attempt: positive,
  state: WorkflowNodeAttemptStateSchema,
  persona_snapshot_json: nullableText,
  session_action_snapshot_json: nullableText.optional().default(null),
  operator_directive_json: nullableText.optional().default(null),
  check_evidence_json: nullableText.optional().default(null),
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
  if ((row.operator_directive_json ?? null) !== null && row.persona_snapshot_json === null) {
    throw new WorkflowRowError(
      "workflow_node_attempts",
      row.id,
      "only a Persona attempt may carry an operator directive",
    );
  }
  if ((row.check_evidence_json ?? null) !== null && row.persona_snapshot_json === null) {
    throw new WorkflowRowError(
      "workflow_node_attempts",
      row.id,
      "only a Persona attempt may carry frozen Check evidence",
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
    operatorDirective: parseNullableJson(
      "workflow_node_attempts",
      row.id,
      "operator_directive_json",
      row.operator_directive_json ?? null,
      WorkflowPersonaDirectiveSnapshotSchema,
      WORKFLOW_LIMITS.personaDirectiveBytes + 1_000,
    ),
    checkEvidence: parseNullableJson(
      "workflow_node_attempts",
      row.id,
      "check_evidence_json",
      row.check_evidence_json ?? null,
      z.array(WorkflowCheckEvidenceSchema).max(WORKFLOW_LIMITS.graphNodes),
      WORKFLOW_EXECUTION_LIMITS.contextJsonBytes,
    ) ?? undefined,
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

function directiveSnapshot(
  directive: WorkflowPersonaDirective,
): WorkflowPersonaDirectiveSnapshot {
  return {
    feedback: directive.feedback,
    revision: directive.revision,
    createdAt: directive.createdAt,
    updatedAt: directive.updatedAt,
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
const DELIVERY_RUN_PHASE: Record<WorkflowDeliveryKind, WorkflowRunPhase | null> = {
  persona_feedback: "persona_feedback",
  inspector_feedback: "inspector_findings",
  pr_handoff: "pr_handoff",
  unchanged_evidence_nudge: "unchanged_evidence",
  session_action: "session_action",
  // `null` means LEAVE THE PHASE ALONE, and this is the only kind that asks for it. Every
  // other packet moves the run into the state it created; a reminder creates no state. The
  // run is parked for the same reason it was parked a minute ago - a persona's findings, or
  // a pull-request handoff - and overwriting either with a phase of its own would report a
  // review that was never re-delivered, on a run whose whole problem is that nothing moved.
  parked_repair_reminder: null,
  evidence_readiness: "evidence_readiness",
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
  evidence_readiness: "waiting_for_evidence_readiness",
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
  event_id: nullableText.optional().default(null),
  run_id: nonempty,
  ts: integer,
  event_kind: nonempty.max(200),
  payload_json: nonempty,
});

export function parseWorkflowEventRow(value: unknown): WorkflowEvent {
  const row = parseShape("workflow_events", WorkflowEventRowSchema, value);
  return {
    id: row.id,
    eventId: row.event_id ?? null,
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

const WorkflowReadinessOverrideRowSchema = z.object({
  id: nonempty,
  submission_id: nonempty,
  request_id: nonempty.max(200),
  actor: z.literal("operator"),
  reason: nonempty.max(WORKFLOW_LIMITS.readinessOverrideReason),
  acknowledged_risk: z.union([z.literal(0), z.literal(1)]),
  created_at: integer,
});

function parseWorkflowReadinessOverrideRow(value: unknown): WorkflowSubmissionReadinessOverride {
  const row = parseShape(
    "workflow_submission_readiness_overrides",
    WorkflowReadinessOverrideRowSchema,
    value,
  );
  return {
    id: row.id,
    submissionId: row.submission_id,
    requestId: row.request_id,
    actor: row.actor,
    reason: row.reason,
    acknowledgedRisk: row.acknowledged_risk === 1,
    createdAt: row.created_at,
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
          "context_json is not a valid GitHub Inspector-only context",
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
 * The Command catalog's refusals.
 *
 * A shorter vocabulary than the two catalogs beside it, and every omission is a rule this
 * catalog does not have: slots are built in, so there is no `builtin` refusal to make (every
 * row is), no `archived`, and no `name_conflict` - a slot's identity is its append-only id.
 * `not_found` therefore means only "that is not one of the four", which is a caller mistake
 * rather than a race.
 */
export type WorkflowCommandStoreWrite =
  | { ok: true; view: WorkflowCommandView }
  | {
      ok: false;
      reason: "not_found" | "revision_conflict" | "duplicate_override";
      current: WorkflowCommandView | null;
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

type WorkflowDefaultedPolicyField = "resumptionPolicy" | "evidenceReadinessPolicy";

export interface WorkflowInsert extends Omit<CreateWorkflow, WorkflowDefaultedPolicyField> {
  resumptionPolicy?: CreateWorkflow["resumptionPolicy"];
  evidenceReadinessPolicy?: CreateWorkflow["evidenceReadinessPolicy"];
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
  /**
   * Which checkout this binding reviews; omitted means the session's own, which is what every
   * caller but the per-repo sibling path wants. Optional rather than required so the six
   * existing insert sites read exactly as they did.
   */
  repoRoot?: string;
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
  /**
   * What the human asked for, read before this transaction and frozen inside it.
   *
   * On the insert rather than a follow-up write for the same reason `externalExpectation` is:
   * a run that exists without one would, on the retry, be filled in from whatever the Goal
   * says by then - and "by then" is exactly the window a repair packet lands in.
   *
   * REQUIRED, and a real snapshot: there is no spelling of "create this run without an ask".
   *
   * Creation is the one moment the ask can honestly be captured, so a run that cannot supply
   * one must not be created - the manager refuses instead. An optional field, or a marker
   * meaning "no ask", would both end at the same SQL NULL as a genuine pre-migration row, and
   * nothing afterwards could tell a brand-new run permanently reading the mutable live Goal
   * from historical data that is entitled to. The legacy shape is reachable only by DEMOTING a
   * row - nulling the column, which is precisely what an upgrade leaves behind - and never by
   * creating one.
   *
   * The identity is NOT part of this input. `frozenIntentJson` derives it from the fields, so
   * a caller cannot mint a snapshot whose fingerprint disagrees with the ask it names.
   */
  intent: WorkflowRunIntentInput;
}

interface WorkflowSubmissionInsertBase {
  id: string;
  runId: string;
  round: number;
  triggerSource: WorkflowTriggerSource;
  triggerKey: string;
  /** Shared by sibling repository submissions created for one completion boundary. */
  evidenceGroupKey?: string;
  context: WorkflowJson;
  evidence: WorkflowJson;
  mode?: WorkflowSubmission["mode"];
  evidenceFingerprint?: string;
  prHeadSha?: string | null;
  status?: WorkflowSubmission["status"];
  now: number;
}

type WorkflowSubmissionInsert = WorkflowSubmissionInsertBase & {
  /** Server-owned origin. The variant derives the complete persisted provenance tuple. */
  origin: WorkflowSubmissionOrigin;
};

type WorkflowRootSubmissionInsert = WorkflowSubmissionInsertBase;

export interface WorkflowStagedEvidenceWrite {
  id: string;
  clientItemId: string;
  sourceKind: "agent" | "upload" | "retained" | "command";
  /** Omitted by historical/image-only callers and therefore defaults to `image`. */
  evidenceKind?: "image" | "text";
  sourceRoot: string;
  sourceLocator: string;
  /** Present only for bounded command output supplied directly through the evidence tool. */
  inlineContent?: string | null;
  /** Present only for command evidence; never recovered from the retained display text. */
  commandExitCode?: number | null;
  displayName: string;
  caption: string;
  repositoryScope: string;
  mimeType: WorkflowEvidenceImage["mimeType"] | "text/plain";
  bytes: number;
  sha256: string;
}

export interface WorkflowStagedEvidenceCoverageWrite extends WorkflowEvidenceCoverageClaim {
  id: string;
  sourceRoot: string;
}

export interface WorkflowReservedEvidence extends WorkflowStagedEvidenceWrite {
  generation: number;
  ordinal: number;
}

/**
 * One frozen item a later submission may carry, with what it takes to re-check it.
 *
 * `sourceKind`, `sourceRoot` and `sourceLocator` are null when the staging row that
 * registered the bytes is gone. The bytes are still carryable; they simply cannot be
 * re-verified against a source that no longer exists to be read.
 */
export interface WorkflowInheritableEvidence {
  kind: "image" | "text";
  stagingId: string;
  sha256: string;
  sourceKind: string | null;
  sourceRoot: string | null;
  sourceLocator: string | null;
}

/**
 * The identity of one frozen evidence row, wherever that row came from.
 *
 * `(submissionId, stagingId)` names a frozen row uniquely whether the submission captured the
 * bytes itself or carried them from an earlier one, so the id is stable across restarts and
 * across a resumed capture, and an `EvidenceRef` citing it resolves the same way either way.
 *
 * ONE implementation, exported, because this is a persisted identity rule: capture and carry
 * must agree byte for byte or the same item resolves two ways through reservations and links,
 * and a format change that updated only some call sites would be invisible until a manifest
 * citation stopped resolving. `images.ts` calls this rather than restating it.
 */
export function frozenEvidenceId(
  prefix: "img" | "txt",
  submissionId: string,
  stagingId: string,
): string {
  return `${prefix}_${createHash("sha256")
    .update(`${submissionId}\0${stagingId}`).digest("hex").slice(0, 32)}`;
}

export interface WorkflowSubmissionImageWrite {
  id: string;
  stagingId: string;
  ordinal: number;
  displayName: string;
  caption: string;
  repositoryScope: string;
  mimeType: WorkflowEvidenceImage["mimeType"];
  bytes: number;
  sha256: string;
  storageRelativePath: string;
  createdAt: number;
}

export interface WorkflowSubmissionTextArtifactWrite {
  id: string;
  stagingId: string;
  ordinal: number;
  displayName: string;
  caption: string;
  repositoryScope: string;
  mimeType: "text/plain";
  bytes: number;
  sha256: string;
  content: string;
  createdAt: number;
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

export interface WorkflowSettingsCatalogRestore {
  personas: readonly SettingsBackupPersona[];
  sessionActions: readonly SettingsBackupSessionAction[];
  workflowCommands: readonly SettingsBackupWorkflowCommand[];
  workflows: readonly SettingsBackupWorkflowDefinition[];
  workflowVersions: readonly SettingsBackupWorkflowVersion[];
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
  /** Frozen only for Persona attempts; omitted everywhere else. */
  checkEvidence?: readonly WorkflowCheckEvidence[];
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
  expectedWorkCycle: { logicalKey: string; generation: number } | null;
  summary: string;
  evidenceFingerprint: string;
  /** Same completion boundary across every repository sibling. */
  evidenceGroupKey?: string;
  expectedIntent: SessionIntentGuard | null;
  runId: string;
  submissionId: string;
  /**
   * Whether this claim spends the completion boundary. Defaults to true, which is what every
   * single-repo claim is and what every caller before per-repo runs meant.
   *
   * A multi-repo task's turn offers ONE proof to one binding per repository it changed, and
   * the boundary is one boundary however many repositories it touched. The first claim consumes
   * the once-only guard; the rest pass `false` and ride the same proof, because consuming a
   * guard that is no longer armed throws - correctly, since a second spend of one boundary is
   * exactly what that guard exists to refuse.
   */
  retireGuard?: boolean;
  /**
   * The CONVERSATION's working directory, for the Foreman queue row a prompted claim creates
   * when none exists yet.
   *
   * Defaults to the binding's own checkout, which for every binding but a secondary
   * repository's IS the conversation's. For that one it must not be: a Foreman queue belongs
   * to the session and its `cwd` is where Foreman runs, so seeding it with an attached
   * repository's worktree would point the queue at a checkout the agent is not standing in.
   */
  guardCwd?: string | null;
  /**
   * The frozen intent for the run this claim may create, read before the transaction.
   *
   * Supplied on every claim because the caller cannot know which branch the transaction will
   * take, and ignored on every branch that does not create a run: a repair round of an
   * existing run reviews against the intent that run already froze, and a claim that lands on
   * a run mid-capture is not a new ask at all. Real intent fields for the reason
   * `WorkflowRunInsert.intent` requires them, with the identity derived rather than supplied,
   * and the manager refuses the claim before offering it when the conversation cannot be read.
   */
  intent: WorkflowRunIntentInput;
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
  /**
   * Library order: by ORIGIN first, then by name.
   *
   * The origin tier is what stops eleven role documents an operator did not write from being
   * interleaved alphabetically through the reviewers they did. It is applied here, in the one
   * place both `listPersonas` and `personaCatalog` pass through, so the sidebar, the pickers and
   * a workflow's reviewer choices cannot disagree about order.
   *
   * Name and id still decide within a tier, so the ordering stays total and stable: two
   * Personas of the same origin sort exactly as they always did.
   */
  private sortPersonas(personas: Persona[]): Persona[] {
    return personas.sort((a, b) =>
      personaOriginRank(a) - personaOriginRank(b)
      || a.normalizedName.localeCompare(b.normalizedName, "en-US")
      || a.id.localeCompare(b.id));
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

  /**
   * Every catalog document identity this database already knows about.
   *
   * Deliberately includes ARCHIVED rows, and that is the whole contract. An operator who
   * archives a supplied Persona has said they do not want it, and a boot-time sync that only
   * looked at live rows would hand it back on the next restart - which is the single worst
   * behaviour this feature could have. Presence of the key means "decided", never "present".
   *
   * Read through `parsePersonaRow` rather than by selecting the JSON column directly, so a blob
   * this build cannot understand degrades to no key by the same tolerant rule that governs every
   * other read of it. The cost of that degradation is one duplicate import an operator can
   * archive, which is strictly better than a malformed blob making a row invisible to the sync
   * forever.
   */
  personaSourceKeys(): Set<string> {
    const rows = this.db.prepare(`SELECT * FROM personas`).all() as unknown[];
    const keys = new Set<string>();
    for (const row of rows) {
      try {
        const key = parsePersonaRow(row).provenance?.sourceKey;
        if (key != null) keys.add(key);
      } catch (error) {
        diagnose(error);
      }
    }
    return keys;
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

  // ---- Global Command catalog ----
  //
  // The four portable slots are BUILT IN, so this catalog behaves unlike the two beside it:
  // nothing creates or archives a row, every slot is always projected whether or not it has
  // been stored, and the unit of both identity and update is the slot rather than a surrogate
  // id. What it keeps from Personas and SessionActions is the part that matters - one
  // compare-and-swap write inside one transaction, and a store that refuses rather than
  // repairs.

  /**
   * Every built-in slot, in registry order, whether or not it has ever been written.
   *
   * A slot that vanished until somebody configured it would make "no command here" and "the
   * catalog has not loaded" the same observation for every reader, and the Library card whose
   * whole job is to say "Not configured" could not be drawn from it.
   *
   * A malformed row degrades to that slot's empty projection rather than throwing, matching
   * `listSessionActions`: one hand-edited row must not take the catalog down.
   */
  workflowCommandCatalog(): WorkflowCommandView[] {
    const rows = new Map<string, unknown>();
    for (const row of this.db.prepare(`SELECT * FROM workflow_commands`).all() as unknown[]) {
      const slot = (row as { slot?: unknown }).slot;
      if (typeof slot === "string") rows.set(slot, row);
    }
    const overrides = this.workflowCommandOverridesBySlot();
    return WORKFLOW_CHECK_SLOTS.map((slot) => {
      const row = rows.get(slot);
      if (!row) return emptyWorkflowCommandView(slot);
      try {
        return parseWorkflowCommandRow(row, overrides.get(slot) ?? []);
      } catch (error) {
        diagnose(error);
        return emptyWorkflowCommandView(slot);
      }
    });
  }

  /** One slot's complete state, or null when the id is not a built-in slot. */
  getWorkflowCommand(slot: string): WorkflowCommandView | null {
    if (!(WORKFLOW_CHECK_SLOTS as readonly string[]).includes(slot)) return null;
    return this.workflowCommandCatalog().find((view) => view.slot === slot) ?? null;
  }

  /**
   * Create the four slot rows this build ships, leaving any that already exist untouched.
   *
   * `INSERT OR IGNORE`, so a restart neither resets a configured slot nor bumps its revision.
   * Returns whether the catalog was EMPTY beforehand, which is the one-shot gate the legacy
   * import hangs off: a new table is the only honest evidence that nothing has been written
   * here yet, and there is no `addColumn` return value to gate on the way `home_name` does.
   */
  seedWorkflowCommands(now = Date.now()): boolean {
    return transaction(this.db, () => this.seedWorkflowCommandsInTransaction(now));
  }

  private seedWorkflowCommandsInTransaction(now: number): boolean {
    const existing = this.db
      .prepare(`SELECT COUNT(*) AS n FROM workflow_commands`)
      .get() as { n: number };
    const wasEmpty = Number(existing.n) === 0;
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO workflow_commands (slot, default_command_json, revision, created_at, updated_at)
       VALUES (?, NULL, 1, ?, ?)`,
    );
    for (const slot of WORKFLOW_CHECK_SLOTS) insert.run(slot, now, now);
    return wasEmpty;
  }

  /**
   * Replace ONE slot's complete state - nullable default plus every override - under an
   * expected revision, in one transaction.
   *
   * Whole-slot replacement rather than a patch, because the two halves are one decision: a
   * surface that could commit a new default without the override list it was editing beside
   * it would let an operator save half of what they see. The delete-then-insert is what makes
   * a removal expressible at all; there is no separate "remove override" write to forget.
   */
  replaceWorkflowCommandCas(
    slot: string,
    expectedRevision: number,
    next: {
      defaultCommand: string[] | null;
      overrides: readonly WorkflowCommandOverride[];
      maxRuns: number;
    },
    now = Date.now(),
  ): WorkflowCommandStoreWrite {
    if (!(WORKFLOW_CHECK_SLOTS as readonly string[]).includes(slot)) {
      return { ok: false, reason: "not_found", current: null };
    }
    const key = slot as WorkflowCheckSlot;
    // Refused here as well as at the route, because the store is the boundary a future
    // caller reaches without passing the schema. The composite PRIMARY KEY would refuse the
    // second row anyway, but as a constraint violation rather than a readable answer.
    if (new Set(next.overrides.map((entry) => entry.repoRoot)).size !== next.overrides.length) {
      return { ok: false, reason: "duplicate_override", current: this.getWorkflowCommand(key) };
    }
    return transaction(this.db, () => {
      // Seeding inside the write covers the one start where a slot row does not exist yet:
      // an update arriving before `seedWorkflowCommands` has run must not read as "no such
      // slot", which is a refusal an operator can do nothing about.
      this.seedWorkflowCommandsInTransaction(now);
      const current = this.workflowCommandInTransaction(key);
      if (current.revision !== expectedRevision) {
        return { ok: false, reason: "revision_conflict", current };
      }
      const updated = this.db
        .prepare(
          `UPDATE workflow_commands
              SET default_command_json = ?, max_runs = ?, revision = revision + 1, updated_at = ?
            WHERE slot = ? AND revision = ?`,
        )
        .run(
          next.defaultCommand && next.defaultCommand.length > 0
            ? JSON.stringify(next.defaultCommand)
            : null,
          // Clamped rather than refused, because the route's schema has already refused
          // anything outside the range and this is the second boundary a future caller
          // reaches without passing it. A stored zero would be a gate that never runs again.
          Math.min(
            Math.max(next.maxRuns, WORKFLOW_LIMITS.commandMaxRunsMin),
            WORKFLOW_LIMITS.commandMaxRunsMax,
          ),
          now,
          key,
          expectedRevision,
        );
      if (Number(updated.changes) !== 1) {
        return { ok: false, reason: "revision_conflict", current: this.workflowCommandInTransaction(key) };
      }
      // Timestamps of surviving overrides are preserved across the replace, so an untouched
      // exception does not report itself as newly written every time a neighbour changes.
      const previous = new Map(
        (this.workflowCommandOverrideRows(key)).map((row) => [row.repo_root, row.created_at]),
      );
      this.db.prepare(`DELETE FROM workflow_command_overrides WHERE slot = ?`).run(key);
      const insert = this.db.prepare(
        `INSERT INTO workflow_command_overrides (slot, repo_root, command_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const entry of next.overrides) {
        insert.run(
          key,
          entry.repoRoot,
          JSON.stringify(entry.command),
          previous.get(entry.repoRoot) ?? now,
          now,
        );
      }
      return { ok: true, view: this.workflowCommandInTransaction(key) };
    });
  }

  /**
   * Import legacy `checkCommands` rows as overrides, once, and only into an empty catalog.
   *
   * Returns false without writing when the catalog already holds slot rows. That is the whole
   * idempotence story: the table's own emptiness is the marker, so a second start imports
   * nothing and an operator who has since deleted every override never has them resurrected
   * from a stale blob - the resurrection hazard `migrateTaskHomeName` records in `db.ts`.
   *
   * No default is inferred. Every legacy row named a repository, and that a repository runs
   * `npm test` is not evidence the same argv is correct anywhere else.
   */
  importLegacyCommandOverrides(
    legacy: readonly { slot: WorkflowCheckSlot; repoRoot: string; command: string[] }[],
    now = Date.now(),
  ): boolean {
    return transaction(this.db, () => {
      if (!this.seedWorkflowCommandsInTransaction(now)) return false;
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO workflow_command_overrides
           (slot, repo_root, command_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      // OR IGNORE keeps the FIRST of a duplicated `(slot, repoRoot)` pair, matching what
      // resolution did with the flat list it is replacing. The write schema always refused
      // such a pair, so only a hand-edited blob can produce one.
      for (const entry of legacy) {
        insert.run(entry.slot, entry.repoRoot, JSON.stringify(entry.command), now, now);
      }
      return true;
    });
  }

  /**
   * Apply a COMPLETE legacy `checkCommands` list across all four slots, in one transaction.
   *
   * The adapter behind `PUT /api/workflows/config`. Whole-list replacement, because that is
   * exactly what the old field was: the form sends the entire array and a row it omits is a
   * row it removed. Every slot is therefore considered, including the ones with no rows in
   * the request - that is how the last override of a slot gets deleted.
   *
   * Carries NO expected revision, and that is the honest translation rather than an omission.
   * The legacy config PUT never had one; it has always been last-write-wins over the whole
   * blob, and inventing a conflict the old form cannot resolve would turn a working save into
   * a refusal an operator cannot act on. Catalog-native writes keep their CAS.
   *
   * Each slot's `defaultCommand` is PRESERVED. A legacy caller knows nothing about global
   * defaults, so a save from the old form must not be able to clear one.
   *
   * Returns only the slots that actually changed, so a Settings save that merely toggled a
   * switch does not bump four revisions and emit four events.
   */
  replaceLegacyCommandOverrides(
    legacy: readonly { slot: WorkflowCheckSlot; repoRoot: string; command: string[] }[],
    now = Date.now(),
  ): WorkflowCommandView[] {
    return transaction(this.db, () => this.replaceLegacyCommandOverridesInTransaction(legacy, now));
  }

  /**
   * Run `fn` inside one transaction, for a caller that has to commit MORE than this store owns.
   *
   * The legacy workflow-config save is the reason it exists: it moves the command catalog and
   * the policy blob together, they are two owners over one database file, and committing the
   * first while the second fails would report a refusal over a change that had already
   * happened. Anything called inside must use the `…InTransaction` readers and writers -
   * `transaction` is not re-entrant, and a nested `BEGIN` is an error, not a savepoint.
   *
   * Everything `fn` writes must go through THIS handle. Two connections to one file are two
   * transactions, and the second one's write would sit outside the rollback this promises.
   */
  transact<T>(fn: (db: DatabaseSync) => T): T {
    return transaction(this.db, () => fn(this.db));
  }

  /**
   * Forward-restore every operator-owned workflow catalog through this store's connection.
   * The caller owns the outer transaction; this method never opens a nested one.
   */
  restoreSettingsCatalogsInTransaction(
    staged: WorkflowSettingsCatalogRestore,
    now = Date.now(),
  ): void {
    const canonical = (value: unknown): string => canonicalSettingsBackupJson(value);
    const builtinPersonaIds = new Set(this.builtins.map((row) => row.id));
    const builtinActionIds = new Set(this.builtinActions.map((row) => row.id));
    const builtinWorkflowIds = new Set(
      this.builtinWorkflows.map((row) => row.definition.id),
    );
    const personaContent = (value: Persona | SettingsBackupPersona): unknown => {
      const {
        id: _id, revision: _revision, createdAt: _createdAt, updatedAt: _updatedAt,
        builtin: _builtin, ...content
      } = value;
      return content;
    };
    const actionContent = (value: SessionAction | SettingsBackupSessionAction): unknown => {
      const {
        id: _id, revision: _revision, createdAt: _createdAt, updatedAt: _updatedAt,
        builtin: _builtin, ...content
      } = value;
      return content;
    };
    const commandContent = (value: WorkflowCommandView | SettingsBackupWorkflowCommand): unknown => {
      const { revision: _revision, createdAt: _createdAt, updatedAt: _updatedAt, ...content } = value;
      return content;
    };
    const workflowContent = (
      value: WorkflowDefinition | SettingsBackupWorkflowDefinition,
    ): unknown => {
      const {
        id: _id, draftRevision: _draftRevision, createdAt: _createdAt,
        updatedAt: _updatedAt, builtin: _builtin, ...content
      } = value;
      return content;
    };

    const currentPersonas = (this.db.prepare(`SELECT * FROM personas`).all() as unknown[])
      .map((row) => parsePersonaRow(row));
    const currentPersonaById = new Map(currentPersonas.map((row) => [row.id, row]));
    const stagedPersonaIds = new Set(staged.personas.map((row) => row.id));
    const writePersona = this.db.prepare(
      `INSERT INTO personas (
         id, name, normalized_name, description, guidance_md, runner_id, model_id,
         revision, archived_at, created_at, updated_at, import_provenance_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name=excluded.name, normalized_name=excluded.normalized_name,
         description=excluded.description, guidance_md=excluded.guidance_md,
         runner_id=excluded.runner_id, model_id=excluded.model_id,
         revision=excluded.revision, archived_at=excluded.archived_at,
         updated_at=excluded.updated_at, import_provenance_json=excluded.import_provenance_json`,
    );
    for (const row of staged.personas) {
      const current = currentPersonaById.get(row.id);
      const revision = current ? Math.max(current.revision, row.revision) + 1 : Math.max(1, row.revision);
      writePersona.run(
        row.id,
        row.name,
        row.normalizedName,
        row.description,
        row.guidanceMarkdown,
        row.runner,
        row.model,
        revision,
        row.archivedAt,
        current?.createdAt ?? row.createdAt,
        current ? now : row.updatedAt,
        row.provenance === null ? null : JSON.stringify(row.provenance),
      );
    }
    const archivePersona = this.db.prepare(
      `UPDATE personas SET archived_at = ?, updated_at = ?, revision = revision + 1
        WHERE id = ? AND archived_at IS NULL`,
    );
    for (const row of currentPersonas) {
      if (
        !builtinPersonaIds.has(row.id)
        && !stagedPersonaIds.has(row.id)
        && row.archivedAt === null
      ) {
        archivePersona.run(now, now, row.id);
      }
    }

    const currentActions = (this.db.prepare(`SELECT * FROM session_actions`).all() as unknown[])
      .map((row) => parseSessionActionRow(row));
    const currentActionById = new Map(currentActions.map((row) => [row.id, row]));
    const stagedActionIds = new Set(staged.sessionActions.map((row) => row.id));
    const writeAction = this.db.prepare(
      `INSERT INTO session_actions (
         id, name, normalized_name, description, prompt_md, required_skill_id,
         completion_kind, revision, archived_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name=excluded.name, normalized_name=excluded.normalized_name,
         description=excluded.description, prompt_md=excluded.prompt_md,
         required_skill_id=excluded.required_skill_id, completion_kind=excluded.completion_kind,
         revision=excluded.revision, archived_at=excluded.archived_at,
         updated_at=excluded.updated_at`,
    );
    for (const row of staged.sessionActions) {
      const current = currentActionById.get(row.id);
      const revision = current ? Math.max(current.revision, row.revision) + 1 : Math.max(1, row.revision);
      writeAction.run(
        row.id,
        row.name,
        row.normalizedName,
        row.description,
        row.promptMarkdown,
        row.requiredSkillId,
        row.completion.kind,
        revision,
        row.archivedAt,
        current?.createdAt ?? row.createdAt,
        current ? now : row.updatedAt,
      );
    }
    const archiveAction = this.db.prepare(
      `UPDATE session_actions SET archived_at = ?, updated_at = ?, revision = revision + 1
        WHERE id = ? AND archived_at IS NULL`,
    );
    for (const row of currentActions) {
      if (
        !builtinActionIds.has(row.id)
        && !stagedActionIds.has(row.id)
        && row.archivedAt === null
      ) {
        archiveAction.run(now, now, row.id);
      }
    }

    this.seedWorkflowCommandsInTransaction(now);
    for (const row of staged.workflowCommands) {
      const current = this.workflowCommandInTransaction(row.slot);
      if (canonical(commandContent(current)) === canonical(commandContent(row))) continue;
      const revision = Math.max(current.revision, row.revision) + 1;
      const previousOverrides = new Map(
        this.workflowCommandOverrideRows(row.slot).map((item) => [item.repo_root, item.created_at]),
      );
      this.db.prepare(
        `UPDATE workflow_commands
            SET default_command_json = ?, max_runs = ?, revision = ?, updated_at = ?
          WHERE slot = ?`,
      ).run(
        row.defaultCommand === null ? null : JSON.stringify(row.defaultCommand),
        row.maxRuns,
        revision,
        now,
        row.slot,
      );
      this.db.prepare(`DELETE FROM workflow_command_overrides WHERE slot = ?`).run(row.slot);
      const insertOverride = this.db.prepare(
        `INSERT INTO workflow_command_overrides
           (slot, repo_root, command_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const override of row.overrides) {
        insertOverride.run(
          row.slot,
          override.repoRoot,
          JSON.stringify(override.command),
          previousOverrides.get(override.repoRoot) ?? now,
          now,
        );
      }
    }

    const currentWorkflows = (this.db.prepare(`SELECT * FROM workflow_definitions`).all() as unknown[])
      .map((row) => parseWorkflowDefinitionRow(row));
    const currentWorkflowById = new Map(currentWorkflows.map((row) => [row.id, row]));
    const stagedWorkflowIds = new Set(staged.workflows.map((row) => row.id));
    const maxSourceRevision = this.db.prepare(
      `SELECT COALESCE(MAX(source_draft_revision), 0) AS value
         FROM workflow_versions WHERE workflow_id = ?`,
    );
    const stagedSourceHighWater = new Map<string, number>();
    for (const version of staged.workflowVersions) {
      stagedSourceHighWater.set(
        version.workflowId,
        Math.max(stagedSourceHighWater.get(version.workflowId) ?? 0, version.sourceDraftRevision),
      );
    }
    const writeWorkflow = this.db.prepare(
      `INSERT INTO workflow_definitions (
         id, name, normalized_name, description, draft_graph_json,
         completion_policy_json, resumption_policy, evidence_readiness_policy,
         binding_defaults_json, draft_revision, current_version_id, archived_at,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name=excluded.name, normalized_name=excluded.normalized_name,
         description=excluded.description, draft_graph_json=excluded.draft_graph_json,
         completion_policy_json=excluded.completion_policy_json,
         resumption_policy=excluded.resumption_policy,
         evidence_readiness_policy=excluded.evidence_readiness_policy,
         binding_defaults_json=excluded.binding_defaults_json,
         draft_revision=excluded.draft_revision, current_version_id=NULL,
         archived_at=excluded.archived_at, updated_at=excluded.updated_at`,
    );
    for (const row of staged.workflows) {
      const current = currentWorkflowById.get(row.id);
      const highWater = Number((maxSourceRevision.get(row.id) as { value: number }).value);
      const draftRevision = Math.max(
        current?.draftRevision ?? 0,
        row.draftRevision,
        highWater,
        stagedSourceHighWater.get(row.id) ?? 0,
      ) + 1;
      writeWorkflow.run(
        row.id,
        row.name,
        row.normalizedName,
        row.description,
        JSON.stringify(row.draft),
        JSON.stringify(row.completionPolicy),
        row.resumptionPolicy,
        row.evidenceReadinessPolicy,
        JSON.stringify(row.bindingDefaults),
        draftRevision,
        row.archivedAt,
        current?.createdAt ?? row.createdAt,
        current ? now : row.updatedAt,
      );
    }
    for (const row of currentWorkflows) {
      if (
        builtinWorkflowIds.has(row.id)
        || stagedWorkflowIds.has(row.id)
        || row.archivedAt !== null
      ) continue;
      const highWater = Number((maxSourceRevision.get(row.id) as { value: number }).value);
      this.db.prepare(
        `UPDATE workflow_definitions
            SET archived_at = ?, updated_at = ?, draft_revision = ?
          WHERE id = ?`,
      ).run(now, now, Math.max(row.draftRevision, highWater) + 1, row.id);
    }

    const versionByNumber = this.db.prepare(
      `SELECT * FROM workflow_versions WHERE workflow_id = ? AND version = ?`,
    );
    const versionByDraft = this.db.prepare(
      `SELECT * FROM workflow_versions WHERE workflow_id = ? AND source_draft_revision = ?`,
    );
    const insertVersion = this.db.prepare(
      `INSERT INTO workflow_versions (
         id, workflow_id, version, source_draft_revision, graph_json,
         completion_policy_json, resumption_policy, evidence_readiness_policy,
         binding_defaults_json, published_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of staged.workflowVersions) {
      const byId = this.db.prepare(`SELECT * FROM workflow_versions WHERE id = ?`).get(row.id);
      if (byId) {
        if (canonical(parseWorkflowVersionRow(byId)) !== canonical(row)) {
          throw new Error(`Immutable workflow version ${row.id} changed during restore`);
        }
        continue;
      }
      const sameNumber = versionByNumber.get(row.workflowId, row.version);
      const sameDraft = versionByDraft.get(row.workflowId, row.sourceDraftRevision);
      if (sameNumber || sameDraft) {
        throw new Error(`Immutable workflow version uniqueness changed during restore`);
      }
      insertVersion.run(
        row.id,
        row.workflowId,
        row.version,
        row.sourceDraftRevision,
        JSON.stringify(row.graph),
        JSON.stringify(row.completionPolicy),
        row.resumptionPolicy,
        row.evidenceReadinessPolicy,
        JSON.stringify(row.bindingDefaults),
        row.publishedAt,
      );
    }

    const pointWorkflow = this.db.prepare(
      `UPDATE workflow_definitions SET current_version_id = ? WHERE id = ?`,
    );
    for (const row of staged.workflows) {
      if (row.currentVersionId !== null) {
        const version = this.db.prepare(`SELECT workflow_id FROM workflow_versions WHERE id = ?`)
          .get(row.currentVersionId) as { workflow_id: string } | undefined;
        if (!version || version.workflow_id !== row.id) {
          throw new Error(`Workflow ${row.id} current version no longer resolves`);
        }
      }
      pointWorkflow.run(row.currentVersionId, row.id);
    }

    const personas = this.listPersonasInTransaction();
    const sessionActions = this.listSessionActionsInTransaction();
    for (const row of staged.workflows) {
      const restored = this.mustWorkflow(row.id);
      const validation = this.validateDraft(restored, { personas, sessionActions });
      if (!validation.valid) throw new Error(`Workflow ${row.id} failed final restore validation`);
    }
    for (const row of staged.personas) {
      const restored = this.mustPersona(row.id);
      if (canonical(personaContent(restored)) !== canonical(personaContent(row))) {
        throw new Error(`Persona ${row.id} failed final restore validation`);
      }
    }
    for (const row of staged.sessionActions) {
      const restored = this.mustSessionAction(row.id);
      if (canonical(actionContent(restored)) !== canonical(actionContent(row))) {
        throw new Error(`Session Action ${row.id} failed final restore validation`);
      }
    }
    for (const row of staged.workflowCommands) {
      if (canonical(commandContent(this.workflowCommandInTransaction(row.slot)))
        !== canonical(commandContent(row))) {
        throw new Error(`Command ${row.slot} failed final restore validation`);
      }
    }
    for (const row of staged.workflows) {
      const restored = this.mustWorkflow(row.id);
      if (canonical(workflowContent(restored)) !== canonical(workflowContent(row))) {
        throw new Error(`Workflow ${row.id} failed final restore validation`);
      }
    }
    for (const row of staged.workflowVersions) {
      const restored = this.getWorkflowVersionById(row.id);
      if (!restored || canonical(restored) !== canonical(row)) {
        throw new Error(`Workflow version ${row.id} failed final restore validation`);
      }
    }
  }

  /** `replaceLegacyCommandOverrides`, for a caller that already opened the transaction. */
  replaceLegacyCommandOverridesInTransaction(
    legacy: readonly { slot: WorkflowCheckSlot; repoRoot: string; command: string[] }[],
    now = Date.now(),
  ): WorkflowCommandView[] {
    this.seedWorkflowCommandsInTransaction(now);
    const changed: WorkflowCommandView[] = [];
    for (const slot of WORKFLOW_CHECK_SLOTS) {
      const desired = legacy
        .filter((entry) => entry.slot === slot)
        .map((entry) => ({ repoRoot: entry.repoRoot, command: entry.command }));
      const rows = this.workflowCommandOverrideRows(slot);
      if (sameOverrides(this.workflowCommandOverridesFor(slot), desired)) continue;
      const created = new Map(rows.map((row) => [row.repo_root, row.created_at]));
      this.db.prepare(`DELETE FROM workflow_command_overrides WHERE slot = ?`).run(slot);
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO workflow_command_overrides
           (slot, repo_root, command_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const entry of desired) {
        insert.run(
          slot,
          entry.repoRoot,
          JSON.stringify(entry.command),
          created.get(entry.repoRoot) ?? now,
          now,
        );
      }
      this.db
        .prepare(
          `UPDATE workflow_commands SET revision = revision + 1, updated_at = ? WHERE slot = ?`,
        )
        .run(now, slot);
      changed.push(this.workflowCommandInTransaction(slot));
    }
    return changed;
}

  private workflowCommandInTransaction(slot: WorkflowCheckSlot): WorkflowCommandView {
    const row = this.db.prepare(`SELECT * FROM workflow_commands WHERE slot = ?`).get(slot);
    if (!row) return emptyWorkflowCommandView(slot);
    return parseWorkflowCommandRow(row, this.workflowCommandOverridesFor(slot));
  }

  private workflowCommandOverrideRows(slot: WorkflowCheckSlot): WorkflowCommandOverrideRow[] {
    const out: WorkflowCommandOverrideRow[] = [];
    for (const raw of this.db
      .prepare(`SELECT * FROM workflow_command_overrides WHERE slot = ? ORDER BY repo_root ASC`)
      .all(slot) as unknown[]) {
      try {
        out.push(parseShape("workflow_command_overrides", WorkflowCommandOverrideRowSchema, raw));
      } catch (error) {
        diagnose(error);
      }
    }
    return out;
  }

  private workflowCommandOverridesFor(slot: WorkflowCheckSlot): WorkflowCommandOverride[] {
    return this.workflowCommandOverrideRows(slot)
      .map(parseWorkflowCommandOverrideRow)
      .filter((entry): entry is WorkflowCommandOverride => entry !== null);
  }

  /** One pass over the override table, so projecting four slots is not four queries. */
  private workflowCommandOverridesBySlot(): Map<string, WorkflowCommandOverride[]> {
    const out = new Map<string, WorkflowCommandOverride[]>();
    const rows = this.db
      .prepare(`SELECT * FROM workflow_command_overrides ORDER BY slot ASC, repo_root ASC`)
      .all() as unknown[];
    for (const raw of rows) {
      try {
        const row = parseShape(
          "workflow_command_overrides",
          WorkflowCommandOverrideRowSchema,
          raw,
        );
        const override = parseWorkflowCommandOverrideRow(row);
        if (!override) continue;
        const bucket = out.get(row.slot) ?? [];
        bucket.push(override);
        out.set(row.slot, bucket);
      } catch (error) {
        diagnose(error);
      }
    }
    return out;
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
           completion_policy_json, resumption_policy, evidence_readiness_policy,
           binding_defaults_json, draft_revision,
           current_version_id, archived_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL, ?, ?)`,
      ).run(
        input.id,
        input.name,
        input.normalizedName,
        input.description,
        JSON.stringify(input.draft),
        JSON.stringify(input.completionPolicy),
        input.resumptionPolicy ?? DEFAULT_WORKFLOW_RESUMPTION_POLICY,
        input.evidenceReadinessPolicy ?? DEFAULT_WORKFLOW_EVIDENCE_READINESS_POLICY,
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
      if (patch.evidenceReadinessPolicy !== undefined) {
        add("evidence_readiness_policy", patch.evidenceReadinessPolicy);
      }
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
              completion_policy_json, resumption_policy, evidence_readiness_policy,
              binding_defaults_json, published_at
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
           completion_policy_json, resumption_policy, evidence_readiness_policy,
           binding_defaults_json, published_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        workflow.evidenceReadinessPolicy,
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
    // Resolve the WHOLE current version because the summary now projects its bounded asset ids
    // as well as its version number. `getWorkflowVersionById` is already the one resolver for
    // row-backed and built-in versions, so this does not create a second opinion about either.
    const current = workflow.currentVersionId === null
      ? null
      : this.getWorkflowVersionById(workflow.currentVersionId);
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
      assetReferences: {
        draft: workflowAssetReferenceSet(workflow.draft),
        published: current ? workflowAssetReferenceSet(current.graph) : null,
      },
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

  /**
   * The armed-workflow projection for one binding, or null when there is no such row.
   *
   * Archived bindings resolve too. The caller decides what an archived one means - the
   * registry drops it from the fleet stream, while a route asking about a specific id wants
   * the answer rather than silence.
   */
  bindingSummary(id: string): WorkflowBindingSummary | null {
    const binding = this.getBinding(id);
    return binding ? this.toBindingSummary(binding) : null;
  }

  /** Every non-archived binding as a summary, for the boot-time stream seed. */
  listBindingSummaries(): WorkflowBindingSummary[] {
    return this.listBindings().map((binding) => this.toBindingSummary(binding));
  }

  /**
   * Resolve a binding's workflow identity for display.
   *
   * Two lookups rather than a SQL join, and deliberately so: `getWorkflowVersionById` already
   * falls back to the built-in catalog, which is the case a join CANNOT reach - a shipped
   * workflow has no `workflow_versions` row, so joining alone reports the No-Mistakes Review
   * every dispatch arms as a deleted version. `getWorkflow` resolves built-ins by id for the
   * same reason. Bindings are counted in the dozens and this runs on binding change, not per
   * frame, so the clarity is worth more than folding it into `WORKFLOW_RUN_SUMMARY_SELECT`'s
   * shape. A version that truly no longer resolves keeps the id visible rather than inventing
   * a name: an operator can paste it into a bug report.
   */
  private toBindingSummary(binding: WorkflowBinding): WorkflowBindingSummary {
    const version = this.getWorkflowVersionById(binding.workflowVersionId);
    const workflow = version ? this.getWorkflow(version.workflowId) : null;
    return {
      id: binding.id,
      workflowVersionId: binding.workflowVersionId,
      workflowId: version?.workflowId ?? `missing:${binding.workflowVersionId}`,
      workflowName: workflow?.name ?? "Missing workflow version",
      workflowVersion: version?.version ?? 0,
      noteKey: binding.noteKey,
      sessionId: binding.sessionId,
      // The same COALESCE `WORKFLOW_RUN_SUMMARY_SELECT` does, in TypeScript because this
      // projection starts from a parsed row rather than a join: '' means "the session's own
      // checkout", whose root is the one the binding captured.
      ...(binding.repoRoot || binding.sessionRepoRoot
        ? { repoRoot: binding.repoRoot || binding.sessionRepoRoot }
        : {}),
      triggerMode: binding.triggerMode,
      deliveryMode: binding.deliveryMode,
      state: binding.state,
      updatedAt: binding.updatedAt,
    };
  }

  /**
   * The active binding that follows this conversation's OWN checkout.
   *
   * Unchanged in meaning by the repository dimension, and that is deliberate: every existing
   * caller - the create conflict check, the dispatch arming, the Foreman claim, reattach -
   * asks about the conversation's own binding, and a multi-repo task's secondary bindings are
   * daemon-created siblings none of them may accidentally pick up. `activeBindingsForNote`
   * below is the one that sees all of them.
   */
  activeBindingForNote(noteKey: string): WorkflowBinding | null {
    const row = this.db.prepare(
      `SELECT * FROM workflow_bindings
        WHERE note_key = ? AND repo_root = '' AND state = 'active'`,
    ).get(noteKey);
    return row ? parseWorkflowBindingRow(row) : null;
  }

  /**
   * Every active binding on this conversation - the session's own first, then one per
   * secondary repository in path order.
   *
   * Its length is also the cheap "is this conversation running more than one review" test the
   * delivery queue gates itself on, answered from the active-binding index alone.
   */
  activeBindingsForNote(noteKey: string): WorkflowBinding[] {
    const rows = this.db.prepare(
      `SELECT * FROM workflow_bindings
        WHERE note_key = ? AND state = 'active'
        ORDER BY repo_root ASC`,
    ).all(noteKey) as unknown[];
    return rows.flatMap((row) => {
      try { return [parseWorkflowBindingRow(row)]; } catch (error) { diagnose(error); return []; }
    });
  }

  /** The active binding reviewing one named repository of this conversation. */
  activeBindingForNoteRepo(noteKey: string, repoRoot: string): WorkflowBinding | null {
    const row = this.db.prepare(
      `SELECT * FROM workflow_bindings
        WHERE note_key = ? AND repo_root = ? AND state = 'active'`,
    ).get(noteKey, repoRoot);
    return row ? parseWorkflowBindingRow(row) : null;
  }

  insertBinding(input: WorkflowBindingInsert): WorkflowBinding {
    this.db.prepare(
      `INSERT INTO workflow_bindings (
         id, workflow_version_id, note_key, session_id, session_agent, session_name,
         session_cwd, session_repo_root, repo_root, trigger_mode, delivery_mode, state,
         max_repair_rounds, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    ).run(
      input.id,
      input.workflowVersionId,
      input.noteKey,
      input.sessionId,
      input.sessionAgent,
      input.sessionName,
      input.sessionCwd,
      input.sessionRepoRoot,
      input.repoRoot ?? "",
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
      const activePersonaAttempts = attempts.filter((attempt) =>
        attempt.persona && ["queued", "running", "retry_wait"].includes(attempt.state));
      const activeSessionActionAttempts = attempts.filter((attempt) =>
        attempt.sessionAction && attempt.state === "waiting");
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
        // Spread for the same reason, and absent means the same thing here as it does on the
        // wire type: the session's own repository, which is what every run of a single-repo
        // session reviews.
        ...(typeof row.run_repo_root === "string" && row.run_repo_root
          ? { repoRoot: row.run_repo_root }
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
        activePersonaNames: activePersonaAttempts.map((attempt) => attempt.persona!.name),
        // Exact source ids beside the legacy names. Names stay for the existing human-facing
        // summaries; ids are what make a same-named built-in and operator Persona unambiguous.
        activePersonaIds: [...new Set(activePersonaAttempts.map((attempt) =>
          attempt.persona!.sourcePersonaId))],
        // `actionWait` says WHY an action is holding the run. The immutable attempt snapshot
        // says WHICH one, so the Library can name the exact asset rather than every action the
        // workflow happens to contain.
        activeSessionActionIds: [...new Set(activeSessionActionAttempts.map((attempt) =>
          attempt.sessionAction!.sourceSessionActionId))],
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
        // SET rather than spread, unlike every optional field above, and the difference is
        // the point. Those are absent when they have nothing to say; these two are absent
        // only when the DAEMON cannot say - which readers treat as "behave as you did before
        // this field existed". Emitting them always is what stops a run this build knows to
        // be manual from being read as one it is about to resume.
        //
        // A built-in ships no `workflow_versions` row, so `v` joins to NULL for every run of
        // the No-Mistakes Review. Falling through to the column reading here would report
        // shipped versions 1-6 - all of them manual - as the absent case, which is the exact
        // silence this change exists to end. The catalog is the version record for those.
        resumptionPolicy: shipped
          ? shipped.resumptionPolicy
          : readResumptionPolicy(
            typeof row.version_resumption_policy === "string"
              ? row.version_resumption_policy
              : null,
          ),
        // The binding join is an inner JOIN and the column is NOT NULL, so this is only ever
        // absent on a row that failed to parse - which returns null from this method anyway.
        deliveryMode: readDeliveryMode(row.binding_delivery_mode),
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

  /** Register one material staged-set change under the durable conversation identity. */
  stageWorkflowEvidence(
    noteKey: string,
    items: readonly WorkflowStagedEvidenceWrite[],
    now = Date.now(),
    episodeKey: string | null = null,
    coverage: readonly WorkflowStagedEvidenceCoverageWrite[] = [],
  ): WorkflowStagedEvidenceList {
    const validatedItems = items.map((item) => ({
      ...item,
      commandExitCode: item.sourceKind === "command"
        ? WorkflowCommandExitCodeSchema.parse(item.commandExitCode)
        : null,
    }));
    return transaction(this.db, () => {
      this.db.prepare(
        `INSERT OR IGNORE INTO workflow_evidence_owners (
           note_key, generation, all_generation, updated_at
         ) VALUES (?, 0, 0, ?)`,
      ).run(noteKey, now);
      const existingRows = (this.db.prepare(
        `SELECT * FROM workflow_evidence_staging WHERE note_key = ?`,
      ).all(noteKey) as unknown[]).map(parseWorkflowEvidenceStagingRow);
      const existing = new Map(existingRows.map((row) => [row.client_item_id, row]));
      const existingCoverageRows = (this.db.prepare(
        `SELECT * FROM workflow_evidence_coverage_staging WHERE note_key = ?`,
      ).all(noteKey) as unknown[]).map(parseWorkflowEvidenceCoverageStagingRow);
      const existingCoverage = new Map(
        existingCoverageRows.map((row) => [row.client_criterion_id, row]),
      );
      const changedItems: WorkflowStagedEvidenceWrite[] = [];
      const changedCoverage: WorkflowStagedEvidenceCoverageWrite[] = [];
      const affectedRoots = new Set<string>();
      let allAffected = false;
      /*
       * Return byte-identical evidence to the mutable tray instead of doing nothing.
       *
       * Reservation is one way: a submission flips its applicable rows to `reserved` and
       * nothing ever flips them back, so every later submission started from an empty tray.
       * Registering the same item again then hit the `same` short-circuit below and silently
       * did nothing, which is why agents learned to mint a fresh client id every round - the
       * only way to get evidence they had already proven in front of the next Persona. That
       * produced 41.6% duplicate registrations and one screenshot frozen nine times.
       *
       * Re-staging does NOT detach the item from the submission that already reserved it:
       * that submission's reservation and frozen rows are immutable and stay exactly as they
       * are. It only makes the row applicable again, to the NEXT submission.
       *
       * Deliberately not counted as a change. Generations drive the resumption observer and
       * `stagedImageGeneration` feeds the repository fingerprint, and re-registering bytes
       * that already exist is not new evidence about the work. Bumping here would wake a
       * resumption for nothing and, worse, would make an untouched tree read as changed and
       * defeat the unchanged-evidence refusal.
       */
      const restagedItemIds = new Set<string>();
      const restagedCoverageIds = new Set<string>();
      for (const item of validatedItems) {
        const row = existing.get(item.clientItemId);
        const same = row
          && row.source_kind === item.sourceKind
          && row.evidence_kind === (item.evidenceKind ?? "image")
          && row.source_root === item.sourceRoot
          && row.source_locator === item.sourceLocator
          && row.inline_content === (item.inlineContent ?? null)
          && row.command_exit_code === (item.commandExitCode ?? null)
          && row.episode_key === episodeKey
          && row.display_name === item.displayName
          && row.caption === item.caption
          && row.repository_scope === item.repositoryScope
          && row.mime_type === item.mimeType
          && row.bytes === item.bytes
          && row.sha256 === item.sha256;
        if (same) {
          if (row.state === "reserved") restagedItemIds.add(row.id);
          continue;
        }
        if (row?.reserved_group_key) {
          throw new Error(`Workflow evidence item ${item.clientItemId} is already reserved`);
        }
        changedItems.push(item);
        if (row?.repository_scope === "all" || item.repositoryScope === "all") allAffected = true;
        if (row && row.repository_scope !== "all") affectedRoots.add(row.source_root);
        if (item.repositoryScope !== "all") affectedRoots.add(item.sourceRoot);
      }
      for (const claim of coverage) {
        const row = existingCoverage.get(claim.clientCriterionId);
        const same = row
          && row.criterion === claim.criterion
          && row.proof_class === claim.proofClass
          && row.repository_scope === claim.repositoryScope
          && row.source_root === claim.sourceRoot
          && row.episode_key === episodeKey
          && row.links_json === JSON.stringify(claim.links);
        if (same) {
          if (row.state === "reserved") restagedCoverageIds.add(row.id);
          continue;
        }
        if (row?.reserved_group_key) {
          throw new Error(`Workflow coverage claim ${claim.clientCriterionId} is already reserved`);
        }
        changedCoverage.push(claim);
        if (row?.repository_scope === "all" || claim.repositoryScope === "all") allAffected = true;
        if (row && row.repository_scope !== "all") affectedRoots.add(row.source_root);
        if (claim.repositoryScope !== "all") affectedRoots.add(claim.sourceRoot);
      }
      // Applied BEFORE the no-change early return below, so a call that only re-stages still
      // takes effect. The in-memory rows are updated with it because the limit arithmetic and
      // the coverage scope checks below read those, not the table.
      //
      // No aggregate-limit check of its own: these bytes were within the limit when they were
      // first staged, and `reserveWorkflowEvidenceInTransaction` re-checks the whole
      // applicable set at submission time, which is the boundary that decides what a Persona
      // actually receives.
      const restage = this.db.prepare(
        `UPDATE workflow_evidence_staging
            SET state = 'staged', reserved_group_key = NULL, updated_at = ?
          WHERE id = ?`,
      );
      for (const row of existingRows) {
        if (!restagedItemIds.has(row.id)) continue;
        restage.run(now, row.id);
        row.state = "staged";
        row.reserved_group_key = null;
      }
      const restageCoverage = this.db.prepare(
        `UPDATE workflow_evidence_coverage_staging
            SET state = 'staged', reserved_group_key = NULL, updated_at = ?
          WHERE id = ?`,
      );
      for (const row of existingCoverageRows) {
        if (!restagedCoverageIds.has(row.id)) continue;
        restageCoverage.run(now, row.id);
        row.state = "staged";
        row.reserved_group_key = null;
      }
      if (changedItems.length === 0 && changedCoverage.length === 0) {
        return this.listWorkflowEvidence(noteKey);
      }

      const currentStaged = existingRows.filter((row) => row.state === "staged");
      const nextIds = new Set(changedItems.map((item) => item.clientItemId));
      const nextItems = [
        ...currentStaged.filter((row) => !nextIds.has(row.client_item_id)).map((row) => ({
          kind: row.evidence_kind,
          bytes: row.bytes,
        })),
        ...changedItems.map((item) => ({ kind: item.evidenceKind ?? "image", bytes: item.bytes })),
      ];
      const imageItems = nextItems.filter((item) => item.kind === "image");
      const textItems = nextItems.filter((item) => item.kind === "text");
      if (imageItems.length > WORKFLOW_IMAGE_LIMITS.maxCount) {
        throw new Error(`At most ${WORKFLOW_IMAGE_LIMITS.maxCount} workflow evidence images may be staged`);
      }
      if (imageItems.reduce((sum, item) => sum + item.bytes, 0) > WORKFLOW_IMAGE_LIMITS.maxAggregateBytes) {
        throw new Error("Workflow evidence images exceed the aggregate byte limit");
      }
      if (textItems.length > WORKFLOW_TEXT_EVIDENCE_LIMITS.maxCount) {
        throw new Error(`At most ${WORKFLOW_TEXT_EVIDENCE_LIMITS.maxCount} workflow text artifacts may be staged`);
      }
      if (
        textItems.reduce((sum, item) => sum + item.bytes, 0)
        > WORKFLOW_TEXT_EVIDENCE_LIMITS.maxAggregateBytes
      ) {
        throw new Error("Workflow text artifacts exceed the aggregate byte limit");
      }
      const nextItemScopes = new Map([
        ...currentStaged.filter((row) => !nextIds.has(row.client_item_id)).map((row) => [
          row.client_item_id,
          { repositoryScope: row.repository_scope, sourceRoot: row.source_root },
        ] as const),
        ...changedItems.map((item) => [
          item.clientItemId,
          { repositoryScope: item.repositoryScope, sourceRoot: item.sourceRoot },
        ] as const),
      ]);
      const changedCriterionIds = new Set(
        changedCoverage.map((claim) => claim.clientCriterionId),
      );
      const nextCoverage = [
        ...existingCoverageRows
          .filter((row) => row.state === "staged" && !changedCriterionIds.has(row.client_criterion_id))
          .map(coverageClaimFromRow),
        ...changedCoverage.map(({ id: _id, sourceRoot: _sourceRoot, ...claim }) => claim),
      ];
      WorkflowEvidenceCoverageClaimsSchema.parse(nextCoverage);
      for (const claim of nextCoverage) {
        for (const link of claim.links) {
          const item = nextItemScopes.get(link.clientItemId);
          if (!item) {
            throw new Error(
              `Workflow coverage claim ${claim.clientCriterionId} links unknown evidence ${link.clientItemId}`,
            );
          }
          const sourceRoot = changedCoverage.find(
            (candidate) => candidate.clientCriterionId === claim.clientCriterionId,
          )?.sourceRoot ?? existingCoverage.get(claim.clientCriterionId)?.source_root;
          const scopeMatches = item.repositoryScope === "all"
            || (claim.repositoryScope !== "all"
              && item.repositoryScope === claim.repositoryScope
              && item.sourceRoot === sourceRoot);
          if (!scopeMatches) {
            throw new Error(
              `Workflow coverage claim ${claim.clientCriterionId} links evidence ${link.clientItemId} outside its repository scope`,
            );
          }
        }
      }
      this.db.prepare(
        `UPDATE workflow_evidence_owners
            SET generation = generation + 1, updated_at = ?
          WHERE note_key = ?`,
      ).run(now, noteKey);
      const owner = this.db.prepare(
        `SELECT generation FROM workflow_evidence_owners WHERE note_key = ?`,
      ).get(noteKey) as { generation: number };
      if (allAffected) {
        this.db.prepare(
          `UPDATE workflow_evidence_owners SET all_generation = ? WHERE note_key = ?`,
        ).run(owner.generation, noteKey);
      }
      const updateScopeGeneration = this.db.prepare(
        `INSERT INTO workflow_evidence_scope_generations (
           note_key, source_root, generation, updated_at
         ) VALUES (?, ?, ?, ?)
         ON CONFLICT(note_key, source_root) DO UPDATE SET
           generation = excluded.generation,
           updated_at = excluded.updated_at`,
      );
      for (const root of affectedRoots) {
        updateScopeGeneration.run(noteKey, root, owner.generation, now);
      }
      const write = this.db.prepare(
        `INSERT INTO workflow_evidence_staging (
           id, note_key, client_item_id, source_kind, evidence_kind, source_root, source_locator,
           inline_content, command_exit_code, episode_key, display_name, caption, repository_scope,
           mime_type, bytes, sha256, generation, state, reserved_group_key, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'staged', NULL, ?, ?)
         ON CONFLICT(note_key, client_item_id) DO UPDATE SET
           source_kind = excluded.source_kind,
           evidence_kind = excluded.evidence_kind,
           source_root = excluded.source_root,
           source_locator = excluded.source_locator,
           inline_content = excluded.inline_content,
           command_exit_code = excluded.command_exit_code,
           episode_key = excluded.episode_key,
           display_name = excluded.display_name,
           caption = excluded.caption,
           repository_scope = excluded.repository_scope,
           mime_type = excluded.mime_type,
           bytes = excluded.bytes,
           sha256 = excluded.sha256,
           generation = excluded.generation,
           state = 'staged',
           reserved_group_key = NULL,
           updated_at = excluded.updated_at`,
      );
      for (const item of changedItems) {
        const prior = existing.get(item.clientItemId);
        write.run(
          prior?.id ?? item.id,
          noteKey,
          item.clientItemId,
          item.sourceKind,
          item.evidenceKind ?? "image",
          item.sourceRoot,
          item.sourceLocator,
          item.inlineContent ?? null,
          item.commandExitCode ?? null,
          episodeKey,
          item.displayName,
          item.caption,
          item.repositoryScope,
          item.mimeType,
          item.bytes,
          item.sha256,
          owner.generation,
          prior?.created_at ?? now,
          now,
        );
      }
      const writeCoverage = this.db.prepare(
        `INSERT INTO workflow_evidence_coverage_staging (
           id, note_key, client_criterion_id, criterion, proof_class, repository_scope,
           source_root, links_json, episode_key, generation, state, reserved_group_key,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'staged', NULL, ?, ?)
         ON CONFLICT(note_key, client_criterion_id) DO UPDATE SET
           criterion = excluded.criterion,
           proof_class = excluded.proof_class,
           repository_scope = excluded.repository_scope,
           source_root = excluded.source_root,
           links_json = excluded.links_json,
           episode_key = excluded.episode_key,
           generation = excluded.generation,
           state = 'staged',
           reserved_group_key = NULL,
           updated_at = excluded.updated_at`,
      );
      for (const claim of changedCoverage) {
        const prior = existingCoverage.get(claim.clientCriterionId);
        writeCoverage.run(
          prior?.id ?? claim.id,
          noteKey,
          claim.clientCriterionId,
          claim.criterion,
          claim.proofClass,
          claim.repositoryScope,
          claim.sourceRoot,
          JSON.stringify(claim.links),
          episodeKey,
          owner.generation,
          prior?.created_at ?? now,
          now,
        );
      }
      return this.listWorkflowEvidence(noteKey);
    });
  }

  listWorkflowEvidence(noteKey: string): WorkflowStagedEvidenceList {
    const owner = this.db.prepare(
      `SELECT generation FROM workflow_evidence_owners WHERE note_key = ?`,
    ).get(noteKey) as { generation: number } | undefined;
    const rows = (this.db.prepare(
      `SELECT * FROM workflow_evidence_staging
        WHERE note_key = ? AND state = 'staged'
        ORDER BY created_at ASC, id ASC`,
    ).all(noteKey) as unknown[]).map(parseWorkflowEvidenceStagingRow);
    const coverageRows = (this.db.prepare(
      `SELECT * FROM workflow_evidence_coverage_staging
        WHERE note_key = ? AND state = 'staged'
        ORDER BY created_at ASC, id ASC`,
    ).all(noteKey) as unknown[]).map(parseWorkflowEvidenceCoverageStagingRow);
    return {
      generation: Number(owner?.generation ?? 0),
      images: rows.filter((row) => row.evidence_kind === "image").map((row): WorkflowStagedEvidenceImage => ({
        id: row.id,
        clientItemId: row.client_item_id,
        sourceKind: row.source_kind as WorkflowStagedEvidenceImage["sourceKind"],
        sourceLocator: row.source_locator,
        episodeKey: row.episode_key,
        displayName: row.display_name,
        caption: row.caption,
        repositoryScope: row.repository_scope,
        mimeType: row.mime_type as WorkflowEvidenceImage["mimeType"],
        bytes: row.bytes,
        sha256: row.sha256,
        generation: row.generation,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
      artifacts: rows.filter((row) => row.evidence_kind === "text").map(
        (row): WorkflowStagedEvidenceTextArtifact => ({
          id: row.id,
          clientItemId: row.client_item_id,
          sourceKind: row.source_kind as WorkflowStagedEvidenceTextArtifact["sourceKind"],
          sourceLocator: row.source_locator,
          episodeKey: row.episode_key,
          displayName: row.display_name,
          caption: row.caption,
          repositoryScope: row.repository_scope,
          mimeType: "text/plain",
          bytes: row.bytes,
          sha256: row.sha256,
          generation: row.generation,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }),
      ),
      coverage: coverageRows.map((row): WorkflowStagedEvidenceCoverageClaim => ({
        ...coverageClaimFromRow(row),
        generation: row.generation,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    };
  }

  /** Latest material staged-set change that applies to this one repository checkout. */
  workflowEvidenceGeneration(noteKey: string, sourceRoot: string): number {
    const row = this.db.prepare(
      `SELECT MAX(o.all_generation, COALESCE(g.generation, 0)) AS generation
         FROM workflow_evidence_owners o
         LEFT JOIN workflow_evidence_scope_generations g
           ON g.note_key = o.note_key AND g.source_root = ?
        WHERE o.note_key = ?`,
    ).get(sourceRoot, noteKey) as { generation: number } | undefined;
    return Number(row?.generation ?? 0);
  }

  removeWorkflowEvidence(noteKey: string, clientItemId: string, now = Date.now()): WorkflowStagedEvidenceList {
    return transaction(this.db, () => {
      const linked = (this.db.prepare(
        `SELECT * FROM workflow_evidence_coverage_staging
          WHERE note_key = ? AND state = 'staged'`,
      ).all(noteKey) as unknown[])
        .map(parseWorkflowEvidenceCoverageStagingRow)
        .some((row) => coverageClaimFromRow(row).links.some(
          (link) => link.clientItemId === clientItemId,
        ));
      if (linked) {
        throw new Error("Remove the evidence link from its coverage claim first");
      }
      const item = this.db.prepare(
        `SELECT * FROM workflow_evidence_staging
          WHERE note_key = ? AND client_item_id = ? AND state = 'staged'
            AND reserved_group_key IS NULL`,
      ).get(noteKey, clientItemId);
      const parsed = item ? parseWorkflowEvidenceStagingRow(item) : null;
      const removed = this.db.prepare(
        `DELETE FROM workflow_evidence_staging
          WHERE note_key = ? AND client_item_id = ? AND state = 'staged'
            AND reserved_group_key IS NULL`,
      ).run(noteKey, clientItemId);
      if (Number(removed.changes) > 0) {
        this.db.prepare(
          `UPDATE workflow_evidence_owners
              SET generation = generation + 1, updated_at = ?
            WHERE note_key = ?`,
        ).run(now, noteKey);
        const owner = this.db.prepare(
          `SELECT generation FROM workflow_evidence_owners WHERE note_key = ?`,
        ).get(noteKey) as { generation: number };
        if (parsed?.repository_scope === "all") {
          this.db.prepare(
            `UPDATE workflow_evidence_owners SET all_generation = ? WHERE note_key = ?`,
          ).run(owner.generation, noteKey);
        } else if (parsed) {
          this.db.prepare(
            `INSERT INTO workflow_evidence_scope_generations (
               note_key, source_root, generation, updated_at
             ) VALUES (?, ?, ?, ?)
             ON CONFLICT(note_key, source_root) DO UPDATE SET
               generation = excluded.generation,
               updated_at = excluded.updated_at`,
          ).run(noteKey, parsed.source_root, owner.generation, now);
        }
      }
      return this.listWorkflowEvidence(noteKey);
    });
  }

  removeWorkflowEvidenceCoverage(
    noteKey: string,
    clientCriterionId: string,
    now = Date.now(),
  ): WorkflowStagedEvidenceList {
    return transaction(this.db, () => {
      const value = this.db.prepare(
        `SELECT * FROM workflow_evidence_coverage_staging
          WHERE note_key = ? AND client_criterion_id = ? AND state = 'staged'
            AND reserved_group_key IS NULL`,
      ).get(noteKey, clientCriterionId);
      const claim = value ? parseWorkflowEvidenceCoverageStagingRow(value) : null;
      const removed = this.db.prepare(
        `DELETE FROM workflow_evidence_coverage_staging
          WHERE note_key = ? AND client_criterion_id = ? AND state = 'staged'
            AND reserved_group_key IS NULL`,
      ).run(noteKey, clientCriterionId);
      if (Number(removed.changes) > 0 && claim) {
        this.db.prepare(
          `UPDATE workflow_evidence_owners
              SET generation = generation + 1, updated_at = ?
            WHERE note_key = ?`,
        ).run(now, noteKey);
        const owner = this.db.prepare(
          `SELECT generation FROM workflow_evidence_owners WHERE note_key = ?`,
        ).get(noteKey) as { generation: number };
        if (claim.repository_scope === "all") {
          this.db.prepare(
            `UPDATE workflow_evidence_owners SET all_generation = ? WHERE note_key = ?`,
          ).run(owner.generation, noteKey);
        } else {
          this.db.prepare(
            `INSERT INTO workflow_evidence_scope_generations (
               note_key, source_root, generation, updated_at
             ) VALUES (?, ?, ?, ?)
             ON CONFLICT(note_key, source_root) DO UPDATE SET
               generation = excluded.generation,
               updated_at = excluded.updated_at`,
          ).run(noteKey, claim.source_root, owner.generation, now);
        }
      }
      return this.listWorkflowEvidence(noteKey);
    });
  }

  listReservedWorkflowEvidence(submissionId: string): WorkflowReservedEvidence[] {
    return (this.db.prepare(
      `SELECT s.*, r.ordinal
         FROM workflow_evidence_reservations r
         JOIN workflow_evidence_staging s ON s.id = r.staging_id
        WHERE r.submission_id = ?
        ORDER BY r.ordinal ASC`,
    ).all(submissionId) as Array<Record<string, unknown>>).map((value) => {
      const row = parseWorkflowEvidenceStagingRow(value);
      const ordinal = integer.nonnegative().parse(value.ordinal);
      return {
        id: row.id,
        clientItemId: row.client_item_id,
        sourceKind: row.source_kind,
        evidenceKind: row.evidence_kind,
        sourceRoot: row.source_root,
        sourceLocator: row.source_locator,
        inlineContent: row.inline_content,
        commandExitCode: row.command_exit_code,
        displayName: row.display_name,
        caption: row.caption,
        repositoryScope: row.repository_scope,
        mimeType: row.mime_type as WorkflowReservedEvidence["mimeType"],
        bytes: row.bytes,
        sha256: row.sha256,
        generation: row.generation,
        ordinal,
      };
    });
  }

  finalizeSubmissionImages(
    submissionId: string,
    images: readonly WorkflowSubmissionImageWrite[],
  ): WorkflowEvidenceImage[] {
    return transaction(this.db, () => {
      const existing = this.listSubmissionImages(submissionId);
      if (existing.length > 0) return existing;
      const insert = this.db.prepare(
        `INSERT INTO workflow_submission_images (
           id, submission_id, staging_id, ordinal, display_name, caption,
           repository_scope, mime_type, bytes, sha256, storage_relative_path,
           availability, pruned_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'retained', NULL, ?)`,
      );
      /*
       * A body this submission is about to reference must not stay queued for deletion.
       *
       * Bodies are shared by digest now, so a path enqueued when one run was pruned can be
       * the exact path a capture in another run just decided to reuse. The enqueue side
       * already refuses to queue a path another retained row holds, but a capture that
       * happens AFTER the enqueue cannot be seen from there. Cancelling the pending entry
       * inside the same transaction that writes the referencing row closes that window: the
       * row and the cancellation commit together, so no ordering leaves a live row pointing
       * at a body the ledger still intends to delete.
       */
      const cancelCleanup = this.db.prepare(
        `DELETE FROM workflow_image_cleanup WHERE storage_relative_path = ?`,
      );
      for (const image of images) {
        cancelCleanup.run(image.storageRelativePath);
        insert.run(
          image.id,
          submissionId,
          image.stagingId,
          image.ordinal,
          image.displayName,
          image.caption,
          image.repositoryScope,
          image.mimeType,
          image.bytes,
          image.sha256,
          image.storageRelativePath,
          image.createdAt,
        );
      }
      return this.listSubmissionImages(submissionId);
    });
  }

  listSubmissionImages(submissionId: string): WorkflowEvidenceImage[] {
    return (this.db.prepare(
      `SELECT * FROM workflow_submission_images
        WHERE submission_id = ? ORDER BY ordinal ASC`,
    ).all(submissionId) as unknown[])
      .map(parseWorkflowSubmissionImageRow)
      .map(workflowEvidenceImageFromRow);
  }

  finalizeSubmissionTextArtifacts(
    submissionId: string,
    artifacts: readonly WorkflowSubmissionTextArtifactWrite[],
  ): WorkflowEvidenceTextArtifact[] {
    return transaction(this.db, () => {
      const existing = this.listSubmissionTextArtifacts(submissionId);
      if (existing.length > 0) return existing;
      const insert = this.db.prepare(
        `INSERT INTO workflow_submission_text_artifacts (
           id, submission_id, staging_id, ordinal, display_name, caption,
           repository_scope, mime_type, bytes, sha256, content,
           availability, pruned_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'retained', NULL, ?)`,
      );
      for (const artifact of artifacts) {
        insert.run(
          artifact.id,
          submissionId,
          artifact.stagingId,
          artifact.ordinal,
          artifact.displayName,
          artifact.caption,
          artifact.repositoryScope,
          artifact.mimeType,
          artifact.bytes,
          artifact.sha256,
          artifact.content,
          artifact.createdAt,
        );
      }
      return this.listSubmissionTextArtifacts(submissionId);
    });
  }

  listSubmissionTextArtifacts(submissionId: string): WorkflowEvidenceTextArtifact[] {
    return (this.db.prepare(
      `SELECT * FROM workflow_submission_text_artifacts
        WHERE submission_id = ? ORDER BY ordinal ASC`,
    ).all(submissionId) as unknown[])
      .map(parseWorkflowSubmissionTextArtifactRow)
      .map(workflowEvidenceTextArtifactFromRow);
  }

  listSubmissionCoverage(submissionId: string): WorkflowEvidenceCoverageClaim[] {
    const claims = (this.db.prepare(
      `SELECT * FROM workflow_submission_evidence_coverage
        WHERE submission_id = ? ORDER BY client_criterion_id ASC`,
    ).all(submissionId) as unknown[]).map(submissionCoverageClaimFromRow);
    return WorkflowEvidenceCoverageClaimsSchema.parse(claims);
  }

  /**
   * The submission a capture may carry evidence forward from, and why.
   *
   * Two shapes, and the difference decides how much verification the carry deserves:
   *
   * - `refinement`: an `evidence_preflight` child repairs its parent's coverage MAPPING. The
   *   tree is the same tree by definition of the segment, so the parent's evidence is carried
   *   wholesale and unverified. This is the case the observed run lost a screenshot to: the
   *   round-1 image was reserved by submission 2.0, refinement 2.1 started from an empty tray,
   *   and a Persona failed the submission for evidence that had been proven one segment ago.
   * - `round`: the first submission of a later repair round. The tree HAS moved, so the carry
   *   is verified against its source and marked with where it came from.
   *
   * Everything else - the first submission of a run, a session-action continuation, which
   * captures around a shipping step rather than around a review - carries nothing. A run's
   * first submission has nothing to carry from, and a continuation is not a review round.
   */
  evidenceInheritanceSource(
    submission: WorkflowSubmission,
  ): { source: WorkflowSubmission; mode: "refinement" | "round" } | null {
    if (submission.refinementReason === "evidence_preflight" && submission.parentSubmissionId) {
      const parent = this.getSubmission(submission.parentSubmissionId);
      return parent ? { source: parent, mode: "refinement" } : null;
    }
    if (submission.refinementReason !== null || submission.segment !== 0) return null;
    const previous = this.listSubmissions(submission.runId)
      .filter((row) => row.id !== submission.id && row.round < submission.round)
      .at(-1) ?? null;
    return previous ? { source: previous, mode: "round" } : null;
  }

  /**
   * One source submission's frozen evidence, with the registration facts a carry needs.
   *
   * Joined back to the staging row because deciding whether two-round-old bytes still prove
   * anything means re-reading the source they were captured from, and only the staging row
   * remembers where that was. A frozen row whose staging row is gone is still carryable - the
   * bytes are immutable and the mark says when they were taken - it simply cannot be
   * re-verified, which is what a null `sourceLocator` states.
   */
  listInheritableSubmissionEvidence(sourceSubmissionId: string): WorkflowInheritableEvidence[] {
    const rows = this.db.prepare(
      `SELECT f.kind, f.staging_id, f.sha256, f.inherited_from_submission_id,
              f.origin_round, f.origin_repository_fingerprint,
              g.source_kind, g.source_root, g.source_locator
         FROM (
           SELECT 'image' AS kind, staging_id, sha256, ordinal,
                  inherited_from_submission_id, origin_round, origin_repository_fingerprint
             FROM workflow_submission_images
            WHERE submission_id = ? AND availability = 'retained'
           UNION ALL
           SELECT 'text' AS kind, staging_id, sha256, ordinal,
                  inherited_from_submission_id, origin_round, origin_repository_fingerprint
             FROM workflow_submission_text_artifacts
            WHERE submission_id = ? AND availability = 'retained'
         ) f
         LEFT JOIN workflow_evidence_staging g ON g.id = f.staging_id
        ORDER BY f.ordinal ASC`,
    ).all(sourceSubmissionId, sourceSubmissionId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      kind: row.kind === "text" ? "text" as const : "image" as const,
      stagingId: String(row.staging_id),
      sha256: String(row.sha256),
      sourceKind: typeof row.source_kind === "string" ? row.source_kind : null,
      sourceRoot: typeof row.source_root === "string" ? row.source_root : null,
      sourceLocator: typeof row.source_locator === "string" ? row.source_locator : null,
    }));
  }

  /**
   * Copy a source submission's frozen evidence and coverage onto this submission.
   *
   * Runs AFTER the submission has frozen whatever it staged itself, and adds only what is
   * missing, so a carry can never displace a fresh capture:
   *
   * - An item already frozen here under the same STAGING id is skipped, because that is the
   *   same item rather than merely the same bytes. Identical bytes are deduplicated as one
   *   body on disk, never as one row: see the note at the carry loops for why collapsing rows
   *   would orphan a coverage link.
   * - Every frozen parent coverage claim is retained whole, with its own id, proof class and
   *   links, marked with where it came from. See the long note at that loop.
   * - Carried items get reservation rows, because a Persona manifest, the readiness preflight
   *   and the evidence metadata all resolve public client ids through reservations. Without
   *   them a carried screenshot would be frozen and invisible, which is the failure this
   *   phase exists to end rather than to relocate.
   *
   * The mark follows the ORIGINAL capture, in all three of its columns together. Carrying an
   * already-carried row keeps that row's origin rather than restamping it with the hand-off, so
   * a screenshot that has ridden three rounds still names the submission that captured it and
   * the round and tree it was taken against. Restamping any one of the three would produce a
   * record that contradicts itself: an origin submission from one round beside a round number
   * and fingerprint from another.
   */
  inheritSubmissionEvidence(input: {
    submissionId: string;
    sourceSubmissionId: string;
    stagingIds: readonly string[];
    now: number;
  }): number {
    return transaction(this.db, () => {
      const source = this.getSubmission(input.sourceSubmissionId);
      if (!source) return 0;
      const carry = new Set(input.stagingIds);
      const ownImages = this.listSubmissionImages(input.submissionId);
      const ownArtifacts = this.listSubmissionTextArtifacts(input.submissionId);
      /*
       * Deliberately NO digest test on the carried set.
       *
       * Deduplication in this phase is about BODIES, not rows: one file per digest, which
       * `captureSubmissionImages` achieves by pointing a new row at a retained body and which
       * a carried row inherits by copying `storage_relative_path`. A source submission is
       * explicitly allowed to hold two frozen rows with byte-identical content under two
       * client ids, and `captureSubmissionImages` freezes exactly that.
       *
       * Skipping the second of those on digest would leave its client id with no reservation
       * here, so `submissionFrozenEvidenceIdentities` would not resolve it, and every parent
       * claim link citing that id would be filtered out a few lines below - an invented gap,
       * for evidence whose bytes are demonstrably present under the sibling id. The only
       * "already have it" test that is safe is the staging id in `held`, which is the same
       * ITEM rather than merely the same bytes.
       */
      /*
       * What is left of this submission's evidence budget after its own captures.
       *
       * Carrying is subject to the same aggregate limits as capturing, and it competes for
       * them LAST: a submission's own freshly staged proof is never displaced by something
       * carried in behind it. Within the carry, source ordinal order puts the source's OWN
       * captures ahead of what it had itself carried, so what the limit refuses is drawn from
       * the oldest ancestry first - the half most likely to be stale. Ordering inside each of
       * those two groups is staging order, not recency, and nothing here depends on it.
       *
       * The first refusal of a kind ends the carry for that kind, whether the count or the
       * byte cap produced it. Refusing only the item that did not fit would let a smaller,
       * OLDER one through behind it, and the source's own captures come first in this order,
       * so the item refused for its size is the more recent of the two. That is the ordering
       * inverted, in exchange for a few more bytes carried.
       *
       * `WorkflowContextSnapshotSchema` caps the frozen arrays at these same counts, so this
       * is not a policy choice that could simply be relaxed: a carry that ignored the limit
       * would fail the whole capture as `stale_capture` and lose every item rather than the
       * few at the margin. What the limit refuses is recorded as `evidence_carry_truncated`.
       *
       * Without a bound here a run that mints a fresh client id every round accumulates one
       * more artifact per round until the immutable context snapshot refuses to validate, and
       * a repair round then fails as a stale capture with a schema error - which is a worse
       * outcome than the empty tray this phase replaced.
       */
      const budget = {
        images: WORKFLOW_IMAGE_LIMITS.maxCount - ownImages.length,
        imageBytes: WORKFLOW_IMAGE_LIMITS.maxAggregateBytes
          - ownImages.reduce((sum, image) => sum + image.bytes, 0),
        artifacts: WORKFLOW_TEXT_EVIDENCE_LIMITS.maxCount - ownArtifacts.length,
        artifactBytes: WORKFLOW_TEXT_EVIDENCE_LIMITS.maxAggregateBytes
          - ownArtifacts.reduce((sum, artifact) => sum + artifact.bytes, 0),
      };
      const held = new Set([
        ...(this.db.prepare(
          `SELECT staging_id FROM workflow_submission_images WHERE submission_id = ?
           UNION
           SELECT staging_id FROM workflow_submission_text_artifacts WHERE submission_id = ?`,
        ).all(input.submissionId, input.submissionId) as Array<{ staging_id: string }>)
          .map((row) => row.staging_id),
      ]);
      const nextOrdinal = Number((this.db.prepare(
        `SELECT COALESCE(MAX(ordinal), -1) + 1 AS next FROM (
           SELECT ordinal FROM workflow_submission_images WHERE submission_id = ?
           UNION ALL
           SELECT ordinal FROM workflow_submission_text_artifacts WHERE submission_id = ?
           UNION ALL
           SELECT ordinal FROM workflow_evidence_reservations WHERE submission_id = ?
         )`,
      ).get(input.submissionId, input.submissionId, input.submissionId) as { next: number }).next);
      /*
       * What the source CAPTURED before what the source had itself carried.
       *
       * Stated in the ORDER BY rather than left to insertion order, because this is what
       * decides which items survive when the cap refuses part of a carry, and inheritance
       * happens to append carried rows after captured ones today. A run that carries across
       * many segments accumulates ancestry that has been re-carried repeatedly and describes
       * ever older trees; the source's own captures describe the tree the source was reviewed
       * against. When something has to go, it is the oldest ancestry, never a capture the
       * previous submission made itself.
       */
      const imageRows = (this.db.prepare(
        `SELECT * FROM workflow_submission_images
          WHERE submission_id = ? AND availability = 'retained'
          ORDER BY (inherited_from_submission_id IS NULL) DESC, ordinal ASC`,
      ).all(input.sourceSubmissionId) as unknown[]).map(parseWorkflowSubmissionImageRow);
      const artifactRows = (this.db.prepare(
        `SELECT * FROM workflow_submission_text_artifacts
          WHERE submission_id = ? AND availability = 'retained'
          ORDER BY (inherited_from_submission_id IS NULL) DESC, ordinal ASC`,
      ).all(input.sourceSubmissionId) as unknown[]).map(parseWorkflowSubmissionTextArtifactRow);
      const insertImage = this.db.prepare(
        `INSERT INTO workflow_submission_images (
           id, submission_id, staging_id, ordinal, display_name, caption,
           repository_scope, mime_type, bytes, sha256, storage_relative_path,
           availability, pruned_at, inherited_from_submission_id, origin_round,
           origin_repository_fingerprint, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'retained', NULL, ?, ?, ?, ?)`,
      );
      const insertArtifact = this.db.prepare(
        `INSERT INTO workflow_submission_text_artifacts (
           id, submission_id, staging_id, ordinal, display_name, caption,
           repository_scope, mime_type, bytes, sha256, content,
           availability, pruned_at, inherited_from_submission_id, origin_round,
           origin_repository_fingerprint, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'retained', NULL, ?, ?, ?, ?)`,
      );
      const reserve = this.db.prepare(
        `INSERT OR IGNORE INTO workflow_evidence_reservations
           (staging_id, submission_id, ordinal, created_at)
         VALUES (?, ?, ?, ?)`,
      );
      const cancelCleanup = this.db.prepare(
        `DELETE FROM workflow_image_cleanup WHERE storage_relative_path = ?`,
      );
      // What the cap refused, so a carry that could not be complete says so out loud instead of
      // letting evidence go quiet - which is the failure mode this whole phase exists to end.
      const truncated = { images: 0, artifacts: 0, claims: 0 };
      let ordinal = nextOrdinal;
      let carried = 0;
      const carriedStagingIds = new Set<string>();
      for (const row of imageRows) {
        if (!carry.has(row.staging_id) || held.has(row.staging_id)) continue;
        if (budget.images <= 0 || row.bytes > budget.imageBytes) {
          // A byte miss closes the door exactly as an exhausted count does. Skipping only the
          // item that did not fit would let a SMALLER, older one through behind it, and since
          // the source's own captures are ordered first, the one refused for its size is the
          // more recent of the two. Greedy packing would carry marginally more bytes at the
          // cost of the ordering the whole rule exists to state.
          budget.images = 0;
          truncated.images += 1;
          continue;
        }
        budget.images -= 1;
        budget.imageBytes -= row.bytes;
        cancelCleanup.run(row.storage_relative_path);
        insertImage.run(
          frozenEvidenceId("img", input.submissionId, row.staging_id),
          input.submissionId,
          row.staging_id,
          ordinal,
          row.display_name,
          row.caption,
          row.repository_scope,
          row.mime_type,
          row.bytes,
          row.sha256,
          row.storage_relative_path,
          row.inherited_from_submission_id ?? input.sourceSubmissionId,
          row.origin_round ?? source.round,
          row.origin_repository_fingerprint ?? source.repositoryFingerprint ?? null,
          input.now,
        );
        reserve.run(row.staging_id, input.submissionId, ordinal, input.now);
        carriedStagingIds.add(row.staging_id);
        ordinal += 1;
        carried += 1;
      }
      for (const row of artifactRows) {
        if (!carry.has(row.staging_id) || held.has(row.staging_id)) continue;
        if (budget.artifacts <= 0 || row.bytes > budget.artifactBytes) {
          // Same rule as the images above: the first refusal ends the carry for this kind.
          budget.artifacts = 0;
          truncated.artifacts += 1;
          continue;
        }
        budget.artifacts -= 1;
        budget.artifactBytes -= row.bytes;
        insertArtifact.run(
          frozenEvidenceId("txt", input.submissionId, row.staging_id),
          input.submissionId,
          row.staging_id,
          ordinal,
          row.display_name,
          row.caption,
          row.repository_scope,
          row.mime_type,
          row.bytes,
          row.sha256,
          row.content,
          row.inherited_from_submission_id ?? input.sourceSubmissionId,
          row.origin_round ?? source.round,
          row.origin_repository_fingerprint ?? source.repositoryFingerprint ?? null,
          input.now,
        );
        reserve.run(row.staging_id, input.submissionId, ordinal, input.now);
        carriedStagingIds.add(row.staging_id);
        ordinal += 1;
        carried += 1;
      }
      // Coverage is carried whether or not any evidence needed to be, because a claim citing
      // items this submission staged under the same ids is still a claim it did not repeat.
      const applicable = new Set(
        this.submissionFrozenEvidenceIdentities(input.submissionId).map((item) => item.clientItemId),
      );
      const freezeCoverage = this.db.prepare(
        `INSERT OR IGNORE INTO workflow_submission_evidence_coverage (
           submission_id, staging_id, client_criterion_id, criterion, proof_class,
           repository_scope, links_json, inherited_from_submission_id, generation,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const coverageRows = this.db.prepare(
        `SELECT * FROM workflow_submission_evidence_coverage WHERE submission_id = ?`,
      ).all(input.sourceSubmissionId) as unknown[];
      const ownCoverage = this.listSubmissionCoverage(input.submissionId);
      let claimBudget = WORKFLOW_EVIDENCE_COVERAGE_LIMITS.maxClaims - ownCoverage.length;
      /*
       * Every frozen parent claim, retained whole, up to what a submission can hold.
       *
       * Not collapsed to one claim per criterion, and not reduced to a merge of its links into
       * somebody else's claim. A claim is an author's assertion with its own id, proof class,
       * scope and link set, and carrying a criterion's proof forward while discarding the claim
       * that made it is not inheriting coverage - it is summarising it.
       *
       * The one bound is the frozen-coverage limit itself. `listSubmissionCoverage` reads this
       * table through `WorkflowEvidenceCoverageClaimsSchema`, which caps a submission at
       * `maxClaims`, so a carry that ignored it would not retain more coverage - it would make
       * the submission's coverage unreadable and lose all of it. `maxClaims` is 100 and a
       * submission cannot stage more than that either, so the bound is only reachable when a
       * parent already at the cap meets a child that declared claims of its own. Reaching it is
       * recorded as `evidence_carry_truncated` rather than passed over in silence.
       *
       * The reason this can be literal is that ambiguity moved to where it belongs.
       * `evaluateWorkflowEvidenceReadiness` prefers a claim the author declared on THIS
       * submission over the ancestry standing behind it, so retaining the ancestry no longer
       * turns a clear current claim into `ambiguous_mapping`. Where a criterion has no claim of
       * its own, the carried ones answer for it and are judged among themselves exactly as
       * before, which is the case inheritance exists for.
       *
       * Newest first, so the claim budget is spent on the most recent ancestry when a run has
       * more of it than the limit admits.
       */
      const orderedCoverage = coverageRows
        .map((value) => ({
          claim: submissionCoverageClaimFromRow(value),
          row: parseShape(
            "workflow_submission_evidence_coverage",
            WorkflowSubmissionCoverageRowSchema,
            value,
          ),
        }))
        /*
         * What the source DECLARED before what the source had itself carried, exactly as the
         * evidence carry above orders its rows, and for the same reason: when the budget
         * refuses part of a carry it must refuse the oldest ancestry, never a claim the
         * immediately preceding submission made itself.
         *
         * Recency alone gets this backwards, and silently. A submission's own claims are frozen
         * at reservation and keep their STAGING row's timestamps, while claims it carries are
         * written later, when inheritance runs during its capture - so a source's carried-in
         * ancestry always has a NEWER `created_at` than the claims that source declared. Sorting
         * by recency first would therefore evict the source's own declarations and keep its
         * grandparent's, which is the reverse of the stated rule. Only a three-level chain
         * reaches it, which is why `a three-level chain refuses the oldest ancestry, not the
         * parent's own claims` exists.
         */
        .sort((a, b) =>
          Number(a.row.inherited_from_submission_id !== null)
            - Number(b.row.inherited_from_submission_id !== null)
          || b.row.created_at - a.row.created_at
          || a.claim.clientCriterionId.localeCompare(b.claim.clientCriterionId));
      /*
       * A criterion this submission re-declared under the SAME id is not a carry at all.
       *
       * `freezeCoverage` is `INSERT OR IGNORE` on `(submission_id, client_criterion_id)`, so a
       * carried row whose id this submission already froze is silently ignored: the author's
       * current wording wins, which is the documented behaviour. Charging the budget for it
       * anyway spends capacity on a row that was never written, and enough same-id
       * re-declarations then truncate DISTINCT ancestry that would have fit - the opposite of
       * the rule this budget exists to express.
       *
       * Filtered before the budget rather than detected after the insert, so `truncated.claims`
       * counts only claims genuinely refused for want of room. A row that was never a candidate
       * is not a claim the limit turned away.
       */
      const declaredHere = new Set(ownCoverage.map((claim) => claim.clientCriterionId));
      for (const { claim, row } of orderedCoverage) {
        if (declaredHere.has(claim.clientCriterionId)) continue;
        if (claimBudget <= 0) {
          truncated.claims += 1;
          continue;
        }
        /*
         * The claim is always retained. Only a link whose evidence did not come with it is
         * dropped, and only because a link pointing at nothing is not proof: it would hand the
         * preflight an `evidence_not_frozen` gap invented by the carry rather than found in the
         * work. Dropping the whole claim over one unresolvable link, as this did before, threw
         * away the criterion's authorship and proof class along with it and could regress a
         * criterion the parent had answered for all the way back to `missing_coverage`.
         */
        const links = claim.links.filter((link) => applicable.has(link.clientItemId));
        claimBudget -= 1;
        // `OR IGNORE` on (submission_id, client_criterion_id): where this submission declared a
        // claim under the same id, that is the same claim re-declared and the author's current
        // wording wins. A DIFFERENT id for the same criterion is a different claim and is
        // retained beside it.
        freezeCoverage.run(
          input.submissionId,
          row.staging_id,
          claim.clientCriterionId,
          claim.criterion,
          claim.proofClass,
          claim.repositoryScope,
          JSON.stringify(links),
          row.inherited_from_submission_id ?? input.sourceSubmissionId,
          row.generation,
          input.now,
          input.now,
        );
      }
      if (truncated.images > 0 || truncated.artifacts > 0 || truncated.claims > 0) {
        const submission = this.getSubmission(input.submissionId);
        if (submission) {
          this.appendEvent(submission.runId, "evidence_carry_truncated", {
            submissionId: input.submissionId,
            sourceSubmissionId: input.sourceSubmissionId,
            ...truncated,
          }, input.now);
        }
      }
      return carried;
    });
  }

  /** Resolve public client ids only to immutable evidence frozen for this submission. */
  submissionFrozenEvidenceIdentities(submissionId: string): Array<{
    clientItemId: string;
    evidenceId: string;
    repositoryScope: WorkflowEvidenceRepositoryScope;
  }> {
    const rows = this.db.prepare(
      `SELECT s.client_item_id, s.repository_scope, i.id AS image_id, t.id AS artifact_id
         FROM workflow_evidence_reservations r
         JOIN workflow_evidence_staging s ON s.id = r.staging_id
         LEFT JOIN workflow_submission_images i
           ON i.submission_id = r.submission_id AND i.staging_id = r.staging_id
         LEFT JOIN workflow_submission_text_artifacts t
           ON t.submission_id = r.submission_id AND t.staging_id = r.staging_id
        WHERE r.submission_id = ?
        ORDER BY r.ordinal ASC`,
    ).all(submissionId) as Array<{
      client_item_id: string;
      repository_scope: WorkflowEvidenceRepositoryScope;
      image_id: string | null;
      artifact_id: string | null;
    }>;
    return rows.flatMap((row) => {
      const evidenceId = row.image_id ?? row.artifact_id;
      return evidenceId ? [{
        clientItemId: row.client_item_id,
        evidenceId,
        repositoryScope: WorkflowEvidenceRepositoryScopeSchema.parse(row.repository_scope),
      }] : [];
    });
  }

  private runSubmissionImageGroups(
    runId: string,
    submissions: readonly WorkflowSubmission[],
  ): WorkflowSubmissionEvidenceImages[] {
    const groups = new Map<string, WorkflowEvidenceImage[]>();
    const rows = this.db.prepare(
      `SELECT i.* FROM workflow_submission_images i
        JOIN workflow_submissions s ON s.id = i.submission_id
       WHERE s.run_id = ?
       ORDER BY i.submission_id ASC, i.ordinal ASC`,
    ).all(runId) as unknown[];
    for (const value of rows) {
      const row = parseWorkflowSubmissionImageRow(value);
      const images = groups.get(row.submission_id) ?? [];
      images.push(workflowEvidenceImageFromRow(row));
      groups.set(row.submission_id, images);
    }
    return submissions.map((submission) => ({
      submissionId: submission.id,
      images: groups.get(submission.id) ?? [],
    }));
  }

  private runSubmissionCoverageGroups(
    runId: string,
    submissions: readonly WorkflowSubmission[],
  ): WorkflowSubmissionEvidenceCoverage[] {
    const groups = new Map<string, WorkflowEvidenceCoverageClaim[]>();
    const rows = this.db.prepare(
      `SELECT c.* FROM workflow_submission_evidence_coverage c
        JOIN workflow_submissions s ON s.id = c.submission_id
       WHERE s.run_id = ?
       ORDER BY c.submission_id ASC, c.client_criterion_id ASC`,
    ).all(runId) as unknown[];
    for (const value of rows) {
      const row = parseShape(
        "workflow_submission_evidence_coverage",
        WorkflowSubmissionCoverageRowSchema,
        value,
      );
      const coverage = groups.get(row.submission_id) ?? [];
      coverage.push(submissionCoverageClaimFromRow(value));
      groups.set(row.submission_id, coverage);
    }
    return submissions.map((submission) => ({
      submissionId: submission.id,
      coverage: WorkflowEvidenceCoverageClaimsSchema.parse(groups.get(submission.id) ?? []),
    }));
  }

  submissionImageRecord(imageId: string): (WorkflowEvidenceImage & {
    submissionId: string;
    storageRelativePath: string;
  }) | null {
    const value = this.db.prepare(
      `SELECT * FROM workflow_submission_images WHERE id = ?`,
    ).get(imageId);
    if (!value) return null;
    const row = parseWorkflowSubmissionImageRow(value);
    return {
      ...workflowEvidenceImageFromRow(row),
      submissionId: row.submission_id,
      storageRelativePath: row.storage_relative_path,
    };
  }

  /**
   * The body already on disk for these exact bytes, or null to write a fresh one.
   *
   * Immutable storage is keyed by `(submissionId, stagingId)`, so the same screenshot proven
   * again in the next round used to be copied to a second path under a second name. One
   * 38,600-byte image was stored nine times that way. The bytes are content-addressed by
   * `sha256` whether or not the path says so, so an existing retained row's path IS the
   * canonical location for that digest and a second copy has nothing to add.
   *
   * Only `retained` rows answer: a pruned row's path names a body that has been deleted, and
   * reusing it would freeze a reference to nothing. The caller re-inspects the returned path
   * before trusting it, because a row is a claim about the filesystem and not the filesystem.
   */
  retainedImageStoragePathForDigest(sha256: string): string | null {
    const row = this.db.prepare(
      `SELECT storage_relative_path FROM workflow_submission_images
        WHERE sha256 = ? AND availability = 'retained'
        ORDER BY created_at ASC, id ASC LIMIT 1`,
    ).get(sha256) as { storage_relative_path: string } | undefined;
    return row?.storage_relative_path ?? null;
  }

  /**
   * True while any LIVE frozen row still names this body.
   *
   * `retained` and nothing else, matching the deletion guards. A pruned row names a body that
   * has already been given up, so counting it as a reference would keep a file no reader can
   * legitimately open - and on the capture rollback path, where this decides whether a body
   * just written can be removed, it would leave that file behind as an orphan. Bodies are
   * shared by digest now, so a pruned row from another submission genuinely can name a path a
   * live capture is working on.
   */
  imageStoragePathIsReferenced(storageRelativePath: string): boolean {
    return Boolean(this.db.prepare(
      `SELECT 1 FROM workflow_submission_images
        WHERE storage_relative_path = ? AND availability = 'retained' LIMIT 1`,
    ).get(storageRelativePath));
  }

  submissionImageStorageRecords(submissionId: string): Array<WorkflowEvidenceImage & {
    storageRelativePath: string;
  }> {
    return (this.db.prepare(
      `SELECT * FROM workflow_submission_images
        WHERE submission_id = ? ORDER BY ordinal ASC`,
    ).all(submissionId) as unknown[]).map((value) => {
      const row = parseWorkflowSubmissionImageRow(value);
      return { ...workflowEvidenceImageFromRow(row), storageRelativePath: row.storage_relative_path };
    });
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

  /** Every repository sibling that froze evidence from one completion boundary. */
  listSubmissionsByEvidenceGroup(evidenceGroupKey: string): WorkflowSubmission[] {
    if (!evidenceGroupKey) return [];
    return (this.db.prepare(
      `SELECT * FROM workflow_submissions
        WHERE evidence_group_key = ?
        ORDER BY created_at ASC, id ASC`,
    ).all(evidenceGroupKey) as unknown[]).map(parseWorkflowSubmissionRow);
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
    submission: Omit<WorkflowRootSubmissionInsert, "runId" | "round">,
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
           gate_state_json, started_at, updated_at, completed_at, intent_json
         ) VALUES (?, ?, ?, 'capturing', 'capturing', ?, ?, ?, NULL, NULL, NULL, ?, ?, NULL, ?)`,
      ).run(
        run.id,
        run.binding.id,
        run.binding.workflowVersionId,
        run.binding.maxRepairRounds,
        run.triggerSource,
        run.triggerKey,
        run.now,
        run.now,
        frozenIntentJson(run.id, run.intent),
      );
      this.insertSubmissionInTransaction({
        ...submission,
        runId: run.id,
        round: 1,
        origin: { kind: "root" },
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
    input: WorkflowRootSubmissionInsert,
  ): { run: WorkflowRun; submission: WorkflowSubmission; idempotent: boolean } {
    return transaction(this.db, () => {
      const existing = this.submissionByTrigger(input.triggerKey);
      if (existing) {
        return { run: this.mustRun(existing.runId), submission: existing, idempotent: true };
      }
      this.insertSubmissionInTransaction({ ...input, origin: { kind: "root" } });
      assertRunLifecycle(input.runId, "capturing", "capturing", null);
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
      if (input.completionKind === "prompted" && !input.expectedWorkCycle) {
        throw new Error("Foreman prompted completion has no work-cycle guard");
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
             gate_state_json, started_at, updated_at, completed_at, intent_json
           ) VALUES (?, ?, ?, 'capturing', 'capturing', ?, ?, ?, NULL, NULL, NULL, ?, ?, NULL, ?)`,
        ).run(
          input.runId,
          binding.id,
          binding.workflowVersionId,
          binding.maxRepairRounds,
          "foreman" satisfies WorkflowTriggerSource,
          triggerKey,
          input.now,
          input.now,
          frozenIntentJson(input.runId, input.intent),
        );
        this.insertSubmissionInTransaction({
          id: input.submissionId,
          runId: input.runId,
          round: 1,
          origin: { kind: "root" },
          triggerSource: "foreman",
          triggerKey,
          evidenceGroupKey: input.evidenceGroupKey,
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
            origin: { kind: "root" },
            triggerSource: "foreman",
            triggerKey,
            evidenceGroupKey: input.evidenceGroupKey,
            context: {},
            evidence: {},
            now: input.now,
          });
          assertRunLifecycle(run.id, "capturing", "capturing", null);
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
          this.blockForRoundLimit(run, input.now);
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

      // Consuming the guard stays inside this transaction: a later failure rolls it back, so
      // a rejected or stale claim never spends the boundary. A sibling repository's claim on
      // the same turn passes `retireGuard: false` - the boundary was already spent by the
      // first, and this claim is that same proof offered to another repository's review.
      if (input.retireGuard !== false) {
        const retired = input.completionKind === "drain"
          ? this.retireDrainGuard(binding.noteKey, `workflow:${run.id}`, input.now)
          : this.consumePromptedGuard(
              binding.noteKey,
              input.guardCwd === undefined ? binding.sessionCwd : input.guardCwd,
              input.expectedWorkCycle!,
              input.expectedIntent!.episodeKey,
              input.summary,
              input.now,
            );
        if (!retired) {
          throw new Error(`Foreman ${input.completionKind} completion guard is no longer armed`);
        }
      }
      this.appendEvent(run.id, "workflow_completion_claimed", {
        triggerKey,
        completionKind: input.completionKind,
        marker: input.marker,
        summary: input.summary,
        evidenceFingerprint: input.evidenceFingerprint,
        expectedWorkCycle: input.expectedWorkCycle,
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
      repositoryFingerprint?: string;
      readiness?: WorkflowEvidenceReadinessResult | null;
      status?: WorkflowSubmission["status"];
    },
    now = Date.now(),
  ): WorkflowSubmission {
    const current = this.mustSubmission(id);
    this.db.prepare(
      `UPDATE workflow_submissions
          SET context_json = ?, evidence_json = ?, evidence_fingerprint = ?,
              repository_fingerprint = ?, readiness_json = ?, status = ?, updated_at = ?
        WHERE id = ?`,
    ).run(
      JSON.stringify(input.context),
      JSON.stringify(input.evidence),
      input.fingerprint ?? current.evidenceFingerprint,
      input.repositoryFingerprint ?? current.repositoryFingerprint ?? null,
      (input.readiness === undefined ? current.readiness : input.readiness) === null
        ? null
        : JSON.stringify(input.readiness === undefined ? current.readiness : input.readiness),
      input.status ?? current.status,
      now,
      id,
    );
    return this.mustSubmission(id);
  }

  /**
   * What a delivery leaves in `gate_state_json` when it lands on a run.
   *
   * A delivery does not author a lifecycle state; it confirms a packet and leaves the run in
   * whatever state that packet created. Two kinds record themselves. The rest used to write
   * the row's existing payload back verbatim, and that was the hole: when the delivery also
   * MOVES the phase, the old phase's note travels into a phase with no business holding it -
   * an `evidence_readiness` run left carrying a delivery blob, a `session_action` run left
   * carrying a block's `code` and `detail`.
   *
   * So the note is carried only while the phase stands still. When the phase moves, the only
   * thing that rides across is the GitHub Inspector gate, which is sticky by nature: it
   * belongs to the run rather than to any one phase, and dropping it is the destructive bug
   * this model was built to fix.
   */
  private deliveryCarriedDetail(
    run: WorkflowRun,
    nextPhase: string,
    own: { [key: string]: WorkflowJson } | null,
  ): WorkflowJson | null {
    // THE GATE RIDES ON EVERY BRANCH. Two delivery kinds record a detail of their own, and
    // returning it bare would drop the gate for exactly the reason the round-limit block used
    // to - a payload that had something of its own to say overwrote the one thing that was
    // never the phase's to hold. Uniform here because the invariant is uniform, and free:
    // `withInspectorGate` returns the detail untouched when there is no gate, which is every
    // ordinary delivery.
    const gate = workflowInspectorGate(runLifecycleRecord(run));
    if (own !== null) return withInspectorGate(own, gate);
    // Standing still, the run's existing payload is still this phase's own.
    if (nextPhase === run.currentPhase) return run.gateState;
    // Moving, the note belongs to the phase being left; only the gate crosses.
    return (gate as unknown as WorkflowJson | null);
  }

  /**
   * Freeze one run's canonical acceptance criteria, the first writer winning.
   *
   * Compare-and-set on `IS NULL` rather than a plain UPDATE, and the returned value is what
   * the row HOLDS rather than what was offered. Two submissions of one run can be in capture
   * at once - a sibling repository's, a resumed one, a session-action continuation - and a
   * last-writer-wins update would let the second overwrite criteria the first has already
   * reviewed against, which is drift with extra steps. The loser adopts the winner's set and
   * reviews against the same target, which is the entire point of compacting once.
   *
   * Validated on write for the reason `frozenIntentJson` is: criteria that store fine and
   * fail to parse would silently return every later submission to per-submission compaction.
   */
  freezeRunCriteria(id: string, criteria: WorkflowRunCriteria): WorkflowRunCriteria | null {
    const payload = durableRunJson(
      id,
      "run_criteria_json",
      WorkflowRunCriteriaSchema.parse(criteria),
    );
    return transaction(this.db, () => {
      /*
       * Refuse a foreign write, rather than leaving the read to discover it.
       *
       * The read-side comparison catches criteria distilled from another ask, but catching it
       * there is a poor second best: the column is write-once, so a bad write cannot be
       * repaired through this path afterwards, and the run stays unreadable for good. The
       * cheapest moment to say no is before the UPDATE.
       *
       * Only a run with READABLE frozen intent may receive criteria at all. A legacy run has
       * no ask to distil them from and would become the mixed row `readRunIntent` refuses; a
       * run whose ask cannot be read has no basis to check them against.
       */
      const run = this.getRun(id);
      if (!run || run.intentState !== "frozen" || !run.intent) {
        throw new WorkflowRowError(
          "workflow_runs",
          id,
          "run criteria may only be frozen onto a run whose intent is readable and frozen",
        );
      }
      if (run.intent.fingerprint !== criteria.intentFingerprint) {
        throw new WorkflowRowError(
          "workflow_runs",
          id,
          "run_criteria_json: criteria were distilled from different intent than this run froze",
        );
      }
      this.db.prepare(
        `UPDATE workflow_runs SET run_criteria_json = ?
          WHERE id = ? AND run_criteria_json IS NULL`,
      ).run(payload, id);
      return this.getRun(id)?.criteria ?? null;
    });
  }

  /**
   * Move a run to a phase THIS BUILD DECLARES.
   *
   * `currentPhase` is the registry's literal union rather than `string`, and that is the type
   * half of the fix: the registry decides which phases are executable, so a writer that
   * invents one would produce a run nothing can act on. Taking the union means that mistake
   * is a compile error at the call site instead of a state discovered in production. The
   * persisted COLUMN stays free text - see `setRunStateCarryingPhase` for the two kinds of
   * writer that legitimately need it.
   */
  setRunState(
    id: string,
    status: WorkflowRun["status"],
    currentPhase: WorkflowRunPhase,
    gateState: WorkflowJson | null = null,
    now = Date.now(),
  ): WorkflowRun {
    return this.setRunStateCarryingPhase(id, status, currentPhase, gateState, now);
  }

  /**
   * The compatibility write: a phase this build may not declare.
   *
   * Exactly two kinds of caller, and both are about a phase this build did not choose. A
   * FREE-FORM reason code, where `cancelRun` writes whatever an operator or a caller named -
   * `cancelled:<requestId>` is the live example. And a CARRY-FORWARD, where a delivery lands
   * on a run whose phase is not this delivery's business to change, so whatever the row
   * already said is written back unchanged, including a phase from a newer daemon.
   *
   * Named rather than reached by widening `setRunState`, so the ordinary writer keeps its
   * typed door and these two say out loud that they are not naming a lifecycle state. The
   * lifecycle validation below applies identically either way: the compatibility path relaxes
   * what may be SPELLED, never what may be persisted as a coherent state.
   */
  setRunStateCarryingPhase(
    id: string,
    status: WorkflowRun["status"],
    currentPhase: string,
    gateState: WorkflowJson | null = null,
    now = Date.now(),
  ): WorkflowRun {
    // The FULL contract, status and detail, exactly as the naming writer. This door once
    // skipped the detail half, on the argument that a carried payload was not its to justify.
    // That argument was wrong in the direction that matters: it made "every registered phase"
    // untrue, and the payloads it was excusing were precisely the ones landing in a phase with
    // no business holding them. `deliveryCarriedDetail` fixed that at the source - a note
    // travels only while its phase stands still - so there is nothing left to excuse.
    assertRunLifecycle(id, status, currentPhase, gateState);
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
   * Stop a run that has no repair round left to spend, remembering what it was doing.
   *
   * The one writer of the `round_limit` block, and it exists because there were five of
   * them. Each spelled the same two-field payload by hand, which was harmless while the
   * payload was only the budget and stopped being harmless the moment a grant needed to
   * know the phase the run had been parked in - a fact four of the five call sites had in
   * hand and none of them wrote down. Routing them through here is what makes
   * `workflowRoundLimitParkedPhase` answerable at all.
   *
   * THE GATE RIDES THROUGH THE BLOCK, and that is the second fact this helper owns. The
   * budget and the GitHub Inspector gate are independent things sharing one column, and this
   * writer used to overwrite the column with the budget alone - so a run parked in
   * `pr_handoff` that spent its last round lost the pull request it was gated on, the moment
   * it stopped. Nothing could give it back: the gate context is not derivable from anything
   * else the run stores, `evaluateInspectorGate` skipped the run for want of a gate, and the
   * grant that raises the budget had nothing to restore it to. Carrying it under the reserved
   * key means a spent run still knows which review it is waiting on, and it is why the
   * GitHub Inspector gate's own round-limit block can now come through here too rather than
   * writing the gate by hand and losing the budget the other way round.
   *
   * Re-blocking preserves the FIRST recorded phase. A run that blocked, was granted rounds,
   * resumed and blocked again would otherwise record `round_limit` as the phase it was
   * parked in, and a second grant would restore it into the very phase it is trying to
   * leave.
   */
  blockForRoundLimit(run: WorkflowRun, now = Date.now()): WorkflowRun {
    const parkedPhase = workflowRoundLimitParkedPhase(runLifecycleRecord(run))
      ?? ((WORKFLOW_RUN_SPENT_PHASES as readonly string[]).includes(run.currentPhase)
        ? null
        : run.currentPhase);
    return this.setRunState(run.id, "blocked", "round_limit", withInspectorGate({
      maxRepairRounds: run.maxRepairRounds,
      ...(parkedPhase ? { parkedPhase } : {}),
    }, inspectorGateState(run)), now);
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

  /**
   * Raise one run's repair budget and append its audit event, in one transaction.
   *
   * The run carries its OWN `max_repair_rounds`, snapshotted from the binding when the row
   * was inserted, and every round-limit guard in the manager reads that snapshot. Until
   * this method existed nothing ever updated the column, so the remedy the dashboard
   * advertised - "a larger repair budget is a change to the binding" - could not work on
   * the run it was advertised on: `updateBinding` writes `workflow_bindings` only, and the
   * blocked run went on comparing against the number it was born with. This is the one
   * writer that moves it.
   *
   * Deliberately NOT a parameter on `setRunState`: the budget outlives any single
   * transition, and a run whose status a concurrent sweep is rewriting must still take the
   * grant. The guarded UPDATE is the authority on the terminal race for the same reason
   * `setRunDisabledNodes` gives - a grant reported as applied to a finished run would put
   * a line in its history about a budget it never spent.
   */
  /**
   * Move where this run's Command run budgets start counting, without touching anything else.
   *
   * The full restart's half of the same escape hatch `grantRunRepairRounds` carries inline.
   * It is a separate write because a restart is not a grant: it buys no extra rounds, it
   * abandons an Inspector-only repair for a real one, and a real repair round that skipped
   * every gate it was created to re-run would be the restart failing at the one thing it was
   * asked to do.
   *
   * Silently a no-op on a finished run, matching every other run mutation here: a run that
   * completed between the decision and the write has nothing left to budget.
   */
  setRunCheckBudgetEpoch(id: string, round: number, now = Date.now()): void {
    this.db.prepare(
      `UPDATE workflow_runs
          SET check_budget_epoch_round = ?, updated_at = ?
        WHERE id = ? AND status NOT IN ('completed', 'cancelled', 'failed')`,
    ).run(round, now, id);
  }

  grantRunRepairRounds(
    id: string,
    maxRepairRounds: number,
    /**
     * The status to put the run back into, for the runs a budget alone does not revive.
     *
     * `null` leaves the run blocked, which is right for a parked repair round: the resume
     * move accepts a blocked run and the resumption observer is not involved. An
     * Inspector-only gate run is the opposite case - its gate is what drives it, and
     * `evaluateInspectorGate` returns early on a blocked run, so a grant that moved only
     * the number would leave it stopped forever while telling Shipping it was working
     * again. Carried in the same transaction as the budget because a run restored without
     * its new budget re-blocks on the very next head.
     */
    restore: {
      status: WorkflowRun["status"];
      phase: WorkflowRunPhase;
      gateState: WorkflowJson | null;
    } | null,
    /**
     * The round the granted rounds start at, which is also where Command run budgets start
     * counting again.
     *
     * In THIS transaction rather than a call beside it, for the reason `restore` is: a run
     * that took its new rounds but not its new budget epoch would spend every one of them
     * skipping the gates whose budget was already exhausted - the operator would watch the
     * rounds they asked for go by without a single test suite running, and nothing would say
     * why. The two writes describe one decision, so they commit together or not at all.
     */
    checkBudgetEpochRound: number,
    event: { kind: string; payload: WorkflowJson },
    now = Date.now(),
  ): WorkflowRun | null {
    return transaction(this.db, () => {
      const result = this.db.prepare(
        `UPDATE workflow_runs
            SET max_repair_rounds = ?, check_budget_epoch_round = ?, updated_at = ?
          WHERE id = ? AND status NOT IN ('completed', 'cancelled', 'failed')`,
      ).run(maxRepairRounds, checkBudgetEpochRound, now, id);
      if (Number(result.changes) !== 1) return null;
      if (restore) {
        assertRunLifecycle(id, restore.status, restore.phase, restore.gateState);
        this.db.prepare(
          `UPDATE workflow_runs
              SET status = ?, current_phase = ?, gate_state_json = ?, updated_at = ?
            WHERE id = ? AND status NOT IN ('completed', 'cancelled', 'failed')`,
        ).run(
          restore.status,
          restore.phase,
          restore.gateState === null ? null : JSON.stringify(restore.gateState),
          now,
          id,
        );
      }
      this.appendEvent(id, event.kind, event.payload, now);
      return this.mustRun(id);
    });
  }

  /** Set or replace one active, run-scoped Persona directive with its audit event. */
  setRunPersonaDirective(
    id: string,
    nodeId: string,
    feedback: string,
    event: { kind: string; payload: WorkflowJson },
    now = Date.now(),
  ): { run: WorkflowRun; directive: WorkflowPersonaDirective } | null {
    return transaction(this.db, () => {
      const run = this.getRun(id);
      if (!run || ["completed", "cancelled", "failed"].includes(run.status)) return null;
      const existing = (run.personaDirectives ?? []).find((item) => item.nodeId === nodeId);
      const directive: WorkflowPersonaDirective = {
        nodeId,
        feedback,
        revision: (existing?.revision ?? 0) + 1,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      const next = [
        ...(run.personaDirectives ?? []).filter((item) => item.nodeId !== nodeId),
        directive,
      ].sort((left, right) => left.nodeId.localeCompare(right.nodeId));
      const result = this.db.prepare(
        `UPDATE workflow_runs
            SET persona_directives_json = ?, updated_at = ?
          WHERE id = ? AND status NOT IN ('completed', 'cancelled', 'failed')`,
      ).run(JSON.stringify(next), now, id);
      if (Number(result.changes) !== 1) return null;
      this.appendEvent(id, event.kind, event.payload, now);
      return { run: this.mustRun(id), directive };
    });
  }

  /** Remove active feedback while leaving every attempt snapshot and verdict untouched. */
  removeRunPersonaDirective(
    id: string,
    nodeId: string,
    event: { kind: string; payload: WorkflowJson },
    now = Date.now(),
  ): { run: WorkflowRun; removed: boolean } | null {
    return transaction(this.db, () => {
      const run = this.getRun(id);
      if (!run || ["completed", "cancelled", "failed"].includes(run.status)) return null;
      const existing = (run.personaDirectives ?? []).find((item) => item.nodeId === nodeId);
      if (!existing) return { run, removed: false };
      const next = (run.personaDirectives ?? []).filter((item) => item.nodeId !== nodeId);
      const result = this.db.prepare(
        `UPDATE workflow_runs
            SET persona_directives_json = ?, updated_at = ?
          WHERE id = ? AND status NOT IN ('completed', 'cancelled', 'failed')`,
      ).run(next.length === 0 ? null : JSON.stringify(next), now, id);
      if (Number(result.changes) !== 1) return null;
      this.appendEvent(id, event.kind, event.payload, now);
      return { run: this.mustRun(id), removed: true };
    });
  }

  enterInspectorGate(input: {
    runId: string;
    submissionId: string;
    headSha: string | null;
    status: WorkflowRun["status"];
    phase: WorkflowRunPhase;
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
      assertRunLifecycle(
        input.runId,
        input.status,
        input.phase,
        input.state as unknown as WorkflowJson,
      );
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
        throw new Error(`Workflow run ${input.runId} cannot enter its GitHub Inspector gate`);
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
    phase: WorkflowRunPhase;
    now: number;
  }): WorkflowRun | null {
    assertRunLifecycle(
      input.runId,
      input.status,
      input.phase,
      input.state as unknown as WorkflowJson,
    );
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
        origin: { kind: "root" },
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
      assertRunLifecycle(
        run.id,
        "waiting_for_inspector",
        "inspector_review",
        input.state as unknown as WorkflowJson,
      );
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
        throw new Error(`Workflow run ${run.id} changed while creating a GitHub Inspector-only submission`);
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
      assertRunLifecycle(runId, "capturing", "capturing", null);
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
        origin: {
          kind: "session_action",
          segment: parent.segment + 1,
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
         session_action_snapshot_json, operator_directive_json, check_evidence_json, runner_id,
         model_id, verdict_json, output_json, retry_at, input_fingerprint, error,
         created_at, updated_at, started_at, finished_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    ).run(
      input.id,
      input.submissionId,
      input.nodeId,
      input.attempt,
      input.state,
      input.persona === null ? null : JSON.stringify(input.persona),
      input.sessionAction ? JSON.stringify(input.sessionAction) : null,
      input.checkEvidence ? JSON.stringify(input.checkEvidence) : null,
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

  /**
   * Claim one execution of a Command against its per-run budget, or refuse.
   *
   * Scoped to the COMMAND SLOT, not to the node that named it. The budget is stored with the
   * command and an operator reads it as "the test suite runs once per run", so two check nodes
   * both resolving to `test` spend ONE shared allowance - the second is skipped even inside
   * the same round. Scoping it per node would let a graph that gates on `test` twice execute
   * it twice under a limit of one, which is the setting not being enforced at the level it is
   * configured at.
   *
   * A RESERVATION rather than a count taken beforehand, and that is what makes a shared budget
   * hold. Two checks in one stage run concurrently, so a caller that counted, awaited its
   * command and only then recorded the execution would let both read the same zero and both
   * run. Here the count and the claim are one synchronous transaction: `check_run_slot` is
   * written before this returns, so the sibling asking a moment later sees it. Nothing can
   * interleave between them - the daemon holds one `DatabaseSync` connection and every
   * statement in this block is synchronous, so there is no await for another attempt to run
   * inside.
   *
   * Counts reservations, never attempts or outcomes. An attempt that never reached a command -
   * an unconfigured slot, an unauthorized repository, a budget already spent - never reserves,
   * so a round in which nothing ran costs nothing. An attempt whose state is `error` is
   * excluded because an infrastructure failure is the same execution asked again rather than a
   * second one, and its retry must not be refused a budget the first try never really spent;
   * `cancelled` is excluded because a submission that stopped discards the answer it bought.
   *
   * `round >= epoch` implements the two operator escape hatches. A null epoch counts the whole
   * run, which is both the pre-column behaviour and the behaviour of a run nobody intervened in.
   */
  reserveCheckRun(
    runId: string,
    attemptId: string,
    slot: string,
    maxRuns: number,
    epochRound: number | null,
  ): { granted: boolean; spent: number } {
    return transaction(this.db, () => {
      const row = this.db.prepare(
        `SELECT COUNT(*) AS n
           FROM workflow_node_attempts a
           JOIN workflow_submissions s ON s.id = a.submission_id
          WHERE s.run_id = ?
            AND a.check_run_slot = ?
            AND s.round >= ?
            AND a.state NOT IN ('error', 'cancelled')
            AND a.id <> ?`,
      ).get(runId, slot, epochRound ?? 0, attemptId) as { n: number };
      const spent = Number(row.n);
      // The shared rule, applied here rather than restated: it clamps a `maxRuns` of zero or
      // below toward running, so a hand-edited catalog row cannot switch a gate off forever.
      if (checkRunBudgetSpent(spent, maxRuns)) return { granted: false, spent };
      this.db
        .prepare(`UPDATE workflow_node_attempts SET check_run_slot = ? WHERE id = ?`)
        .run(slot, attemptId);
      return { granted: true, spent };
    });
  }

  /**
   * Reservations a run has already spent on one Command, for a reader that is not claiming one.
   *
   * Exists for tests and diagnostics. The engine never asks: a caller that counted and then
   * decided would be the race `reserveCheckRun` exists to close.
   */
  checkRunsSpent(runId: string, slot: string, epochRound: number | null): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS n
         FROM workflow_node_attempts a
         JOIN workflow_submissions s ON s.id = a.submission_id
        WHERE s.run_id = ?
          AND a.check_run_slot = ?
          AND s.round >= ?
          AND a.state NOT IN ('error', 'cancelled')`,
    ).get(runId, slot, epochRound ?? 0) as { n: number };
    return Number(row.n);
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
    return transaction(this.db, () => {
      const initial = this.getAttempt(id);
      if (!initial || !["queued", "retry_wait"].includes(initial.state)) return null;
      let snapshot = initial.operatorDirective ?? null;
      if (initial.persona && !snapshot) {
        const submission = this.getSubmission(initial.submissionId);
        const run = submission ? this.getRun(submission.runId) : null;
        const active = run?.personaDirectives?.find((item) => item.nodeId === initial.nodeId);
        snapshot = active ? directiveSnapshot(active) : null;
      }
      const result = this.db.prepare(
        `UPDATE workflow_node_attempts
            SET state = 'running', runner_id = ?, model_id = ?, started_at = ?,
                updated_at = ?, retry_at = NULL,
                operator_directive_json = COALESCE(operator_directive_json, ?)
          WHERE id = ? AND state IN ('queued', 'retry_wait')`,
      ).run(
        runner,
        model,
        now,
        now,
        snapshot ? JSON.stringify(snapshot) : null,
        id,
      );
      return Number(result.changes) === 1 ? this.getAttempt(id) : null;
    });
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
          checkEvidence: attempt.checkEvidence,
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

  /**
   * Confirmed packets that can still appear in one session's bounded transcript window.
   *
   * The delivery ledger and its post-send transcript anchors are the durable authorship source
   * for workflow context capture. Only confirmed sends with an anchor qualify: prepared,
   * refused, uncertain, and unanchored packets cannot identify a transcript turn. Newest first
   * and capped beyond the transcript window so a long-lived session cannot make context capture
   * scan or retain an unbounded payload history.
   */
  listDeliveredTranscriptAnchors(
    sessionId: string,
    noteKey: string,
    limit = 200,
  ): Array<{ payload: string; transcriptAnchor: number }> {
    return (this.db.prepare(
      `SELECT d.payload,
              CAST(json_extract(e.payload_json, '$.transcriptAnchor') AS INTEGER)
                AS transcript_anchor
         FROM workflow_deliveries d
         JOIN workflow_events e
           ON e.run_id = d.run_id
          AND e.event_kind = 'delivery_delivered'
          AND json_extract(e.payload_json, '$.deliveryId') = d.id
        WHERE d.session_id = ? AND d.note_key = ?
          AND d.delivered_at IS NOT NULL AND d.payload_pruned_at IS NULL
          AND d.payload <> ''
          AND json_type(e.payload_json, '$.transcriptAnchor') = 'integer'
        ORDER BY d.delivered_at DESC, d.id DESC
        LIMIT ?`,
    ).all(sessionId, noteKey, limit) as Array<{
      payload: string;
      transcript_anchor: number;
    }>).map((row) => ({
      payload: row.payload,
      transcriptAnchor: row.transcript_anchor,
    }));
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
      // `parked_repair_reminder` maps to null, meaning LEAVE THE PHASE ALONE - which is also
      // the only case in which the run's existing note is still this phase's note.
      const deliveredPhase = DELIVERY_RUN_PHASE[delivery.kind] ?? run.currentPhase;
      this.setRunStateCarryingPhase(
        delivery.runId,
        nextStatus,
        deliveredPhase,
        this.deliveryCarriedDetail(
          run,
          deliveredPhase,
          delivery.kind === "persona_feedback" || delivery.kind === "session_action"
            ? { deliveryId: delivery.id, transcriptAnchor }
            : null,
        ),
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
        const blocked = this.getRun(delivery.runId);
        const detail = withInspectorGate(
          { deliveryId: delivery.id },
          blocked ? inspectorGateState(blocked) : null,
        );
        // A raw UPDATE still answers to the contract. This statement writes the same two
        // columns `setRunState` does and cannot route through it - the guarded WHERE is the
        // point - so the check is called explicitly rather than skipped. Without it there is a
        // third door, and "both doors enforce both contracts" stops being true the first time
        // somebody adds a field here.
        assertRunLifecycle(delivery.runId, "blocked", "delivery_uncertain", detail);
        this.db.prepare(
          `UPDATE workflow_runs
              SET status = 'blocked', current_phase = 'delivery_uncertain',
                  gate_state_json = ?, updated_at = ?
            WHERE id = ? AND status NOT IN ('completed', 'cancelled', 'failed')`,
        ).run(JSON.stringify(detail), now, delivery.runId);
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
        const blocked = this.getRun(delivery.runId);
        const detail = withInspectorGate(
          { deliveryId: delivery.id, reason },
          blocked ? inspectorGateState(blocked) : null,
        );
        assertRunLifecycle(delivery.runId, "blocked", "delivery_uncertain", detail);
        this.db.prepare(
          `UPDATE workflow_runs
              SET status = 'blocked', current_phase = 'delivery_uncertain',
                  gate_state_json = ?, updated_at = ?
            WHERE id = ? AND status NOT IN ('completed', 'cancelled', 'failed')`,
        ).run(JSON.stringify(detail), now, delivery.runId);
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
          const nextStatus = DELIVERY_RUN_STATUS[delivery.kind]
            ?? (delivery.kind === "inspector_feedback" && inspectorOnly
              ? "waiting_for_new_head"
              : "waiting_for_session");
          const resolvedPhase = DELIVERY_RUN_PHASE[delivery.kind] ?? run.currentPhase;
          this.setRunStateCarryingPhase(
            delivery.runId,
            nextStatus,
            resolvedPhase,
            this.deliveryCarriedDetail(
              run,
              resolvedPhase,
              delivery.kind === "persona_feedback"
                ? { deliveryId: delivery.id, resolvedByOperator: true }
                : null,
            ),
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
    input: WorkflowRootSubmissionInsert,
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
      this.insertSubmissionInTransaction({ ...input, origin: { kind: "root" } });
      assertRunLifecycle(run.id, "capturing", "capturing", null);
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

  listReadinessOverrides(runId: string): WorkflowSubmissionReadinessOverride[] {
    return (this.db.prepare(
      `SELECT o.*
         FROM workflow_submission_readiness_overrides o
         JOIN workflow_submissions s ON s.id = o.submission_id
        WHERE s.run_id = ?
        ORDER BY o.created_at ASC, o.id ASC`,
    ).all(runId) as unknown[]).map(parseWorkflowReadinessOverrideRow);
  }

  /**
   * How many evidence-preflight refinements this submission's segment chain has spent in a row.
   *
   * Walked through `parentSubmissionId` rather than counted per round, because "consecutive" is
   * the property the cap is about: a round may legitimately reach evidence readiness again after
   * a session action segment interrupted it, and that later gap is a new disagreement rather
   * than a continuation of the one this bound is closing. The walk stops at the first link that
   * is not a preflight refinement, which is the submission the chain grew out of.
   */
  consecutiveEvidencePreflightRefinements(submissionId: string): number {
    let current = this.getSubmission(submissionId);
    let refinements = 0;
    while (current?.refinementReason === "evidence_preflight" && current.parentSubmissionId) {
      refinements += 1;
      current = this.getSubmission(current.parentSubmissionId);
    }
    return refinements;
  }

  reserveEvidenceReadinessRefinement(input: {
    id: string;
    runId: string;
    waitingSubmissionId: string;
    triggerKey: string;
    manualRetry: boolean;
    now: number;
  }):
    | { ok: true; submission: WorkflowSubmission; idempotent: boolean }
    | {
        ok: false;
        reason:
          | "not_waiting"
          | "no_change"
          | "delivery_in_flight"
          | "request_conflict"
          | "refinement_exhausted";
      } {
    return transaction(this.db, () => {
      const existing = this.submissionByTrigger(input.triggerKey);
      if (existing) {
        return existing.runId === input.runId
            && existing.parentSubmissionId === input.waitingSubmissionId
            && existing.refinementReason === "evidence_preflight"
            && existing.triggerSource === (input.manualRetry ? "manual" : "session")
          ? { ok: true, submission: existing, idempotent: true }
          : { ok: false, reason: "request_conflict" };
      }
      const run = this.getRun(input.runId);
      const parent = this.getSubmission(input.waitingSubmissionId);
      const latest = run ? this.latestSubmission(run.id) : null;
      if (
        !run
        || !parent
        || parent.runId !== run.id
        || latest?.id !== parent.id
        || run.status !== "waiting_for_evidence_readiness"
        || parent.status !== "waiting_for_evidence_readiness"
      ) return { ok: false, reason: "not_waiting" };
      const binding = this.getBinding(run.bindingId);
      if (!binding) return { ok: false, reason: "not_waiting" };
      const generation = this.workflowEvidenceGeneration(
        binding.noteKey,
        binding.repoRoot || binding.sessionCwd || "",
      );
      if (generation <= (parent.stagedImageGeneration ?? 0)) {
        return { ok: false, reason: "no_change" };
      }
      /*
       * The bound on the loop, checked before anything is reserved and after idempotency, so a
       * restart re-driving a refinement that already exists still recovers it.
       *
       * Counting the PARENT's chain and comparing the child it would produce is what keeps the
       * cap off by nothing: `refinements` is what has already been spent, so the reservation in
       * hand is `refinements + 1`, and the run blocks only once that exceeds the limit.
       *
       * The parent submission is deliberately left `waiting_for_evidence_readiness`. The gaps
       * are still real and still the operator's to settle, and leaving the submission where it
       * is keeps `overrideEvidenceReadiness` - continue despite gaps - reachable from the block.
       */
      const refinements = this.consecutiveEvidencePreflightRefinements(parent.id);
      if (refinements + 1 > EVIDENCE_PREFLIGHT_REFINEMENT_LIMIT) {
        this.setRunState(
          run.id,
          "blocked",
          WORKFLOW_PREFLIGHT_REFINEMENT_EXHAUSTED_PHASE,
          { submissionId: parent.id, round: parent.round, refinements },
          input.now,
        );
        this.appendEvent(run.id, WORKFLOW_PREFLIGHT_REFINEMENT_EXHAUSTED_PHASE, {
          submissionId: parent.id,
          round: parent.round,
          segment: parent.segment,
          refinements,
          limit: EVIDENCE_PREFLIGHT_REFINEMENT_LIMIT,
          manualRetry: input.manualRetry,
        }, input.now, `preflight-refinement-exhausted:${parent.id}`);
        return { ok: false, reason: "refinement_exhausted" };
      }
      const inFlight = this.db.prepare(
        `SELECT 1 FROM workflow_deliveries
          WHERE run_id = ? AND submission_id = ? AND kind = 'evidence_readiness'
            AND state IN ('sending', 'uncertain') LIMIT 1`,
      ).get(run.id, parent.id);
      if (inFlight) return { ok: false, reason: "delivery_in_flight" };
      this.db.prepare(
        `UPDATE workflow_deliveries
            SET state = 'cancelled', error = 'superseded_by_evidence', updated_at = ?
          WHERE run_id = ? AND submission_id = ? AND kind = 'evidence_readiness'
            AND state = 'prepared'`,
      ).run(input.now, run.id, parent.id);
      this.insertSubmissionInTransaction({
        id: input.id,
        runId: run.id,
        round: parent.round,
        origin: {
          kind: "evidence_preflight",
          segment: parent.segment + 1,
          parentSubmissionId: parent.id,
        },
        triggerSource: input.manualRetry ? "manual" : "session",
        triggerKey: input.triggerKey,
        context: {},
        evidence: {},
        mode: parent.mode,
        now: input.now,
      });
      assertRunLifecycle(run.id, "capturing", "evidence_readiness_capture", null);
      this.db.prepare(
        `UPDATE workflow_runs
            SET status = 'capturing', current_phase = 'evidence_readiness_capture',
                gate_state_json = NULL, updated_at = ?, completed_at = NULL
          WHERE id = ? AND status = 'waiting_for_evidence_readiness'`,
      ).run(input.now, run.id);
      this.appendEvent(run.id, "evidence_preflight_refinement_reserved", {
        parentSubmissionId: parent.id,
        submissionId: input.id,
        round: parent.round,
        segment: parent.segment + 1,
        generation,
        manualRetry: input.manualRetry,
      }, input.now, `readiness-refinement:${input.id}`);
      return { ok: true, submission: this.mustSubmission(input.id), idempotent: false };
    });
  }

  overrideEvidenceReadiness(input: {
    id: string;
    runId: string;
    submissionId: string;
    requestId: string;
    reason: string;
    acknowledgedRisk: true;
    now: number;
  }):
    | { ok: true; override: WorkflowSubmissionReadinessOverride; idempotent: boolean }
    | { ok: false; reason: "not_found" | "conflict" | "policy_off" | "request_conflict" } {
    const normalizedReason = input.reason.trim();
    if (!normalizedReason || normalizedReason.length > WORKFLOW_LIMITS.readinessOverrideReason) {
      return { ok: false, reason: "conflict" };
    }
    return transaction(this.db, () => {
      const priorRow = this.db.prepare(
        `SELECT o.*, s.run_id
           FROM workflow_submission_readiness_overrides o
           JOIN workflow_submissions s ON s.id = o.submission_id
          WHERE o.request_id = ?`,
      ).get(input.requestId) as (Record<string, unknown> & { run_id?: string }) | undefined;
      if (priorRow) {
        const prior = parseWorkflowReadinessOverrideRow(priorRow);
        return prior.submissionId === input.submissionId
            && priorRow.run_id === input.runId
            && prior.reason === normalizedReason
            && prior.acknowledgedRisk === input.acknowledgedRisk
          ? { ok: true, override: prior, idempotent: true }
          : { ok: false, reason: "request_conflict" };
      }
      const run = this.getRun(input.runId);
      const submission = this.getSubmission(input.submissionId);
      if (!run || !submission || submission.runId !== run.id) return { ok: false, reason: "not_found" };
      const version = this.getWorkflowVersionById(run.workflowVersionId);
      if (!workflowEvidenceReadinessPolicyEnforces(version?.evidenceReadinessPolicy)) {
        return { ok: false, reason: "policy_off" };
      }
      const latest = this.latestSubmission(run.id);
      /*
       * Two run states, one submission state.
       *
       * The override answers a question about the SUBMISSION - continue despite these gaps -
       * and the submission is waiting either way. The second run state is the refinement cap's
       * block: it stops the loop from spending more segments, and if it also withdrew the
       * override it would take away the operator decision it exists to ask for, leaving a round
       * that can only be abandoned. So the block is accepted here and nowhere else; every other
       * blocked phase still refuses.
       */
      const preflightExhausted = run.status === "blocked"
        && run.currentPhase === WORKFLOW_PREFLIGHT_REFINEMENT_EXHAUSTED_PHASE;
      if (
        (run.status !== "waiting_for_evidence_readiness" && !preflightExhausted)
        || submission.status !== "waiting_for_evidence_readiness"
        || latest?.id !== submission.id
      ) return { ok: false, reason: "conflict" };
      this.db.prepare(
        `INSERT INTO workflow_submission_readiness_overrides (
           id, submission_id, request_id, actor, reason, acknowledged_risk, created_at
         ) VALUES (?, ?, ?, 'operator', ?, 1, ?)`,
      ).run(input.id, input.submissionId, input.requestId, normalizedReason, input.now);
      const readiness = submission.readiness
        ? { ...submission.readiness, status: "overridden" as const }
        : null;
      this.db.prepare(
        `UPDATE workflow_submissions
            SET status = 'running', readiness_json = ?, updated_at = ?
          WHERE id = ? AND status = 'waiting_for_evidence_readiness'`,
      ).run(readiness ? JSON.stringify(readiness) : null, input.now, submission.id);
      assertRunLifecycle(run.id, "running", "activating", null);
      this.db.prepare(
        `UPDATE workflow_runs
            SET status = 'running', current_phase = 'activating', gate_state_json = NULL,
                updated_at = ?, completed_at = NULL
          WHERE id = ?
            AND (status = 'waiting_for_evidence_readiness'
                 OR (status = 'blocked' AND current_phase = ?))`,
      ).run(input.now, run.id, WORKFLOW_PREFLIGHT_REFINEMENT_EXHAUSTED_PHASE);
      const row = this.db.prepare(
        `SELECT * FROM workflow_submission_readiness_overrides WHERE id = ?`,
      ).get(input.id);
      return { ok: true, override: parseWorkflowReadinessOverrideRow(row), idempotent: false };
    });
  }

  appendEvent(
    runId: string,
    kind: string,
    payload: WorkflowJson,
    now = Date.now(),
    eventId?: string,
  ): WorkflowEvent {
    const payloadJson = JSON.stringify(payload);
    if (eventId) {
      if (eventId.length > 200) throw new Error("Workflow event id exceeds 200 characters");
      const existing = this.db.prepare(
        `SELECT * FROM workflow_events WHERE event_id = ?`,
      ).get(eventId);
      if (existing) {
        const parsed = parseWorkflowEventRow(existing);
        if (parsed.runId !== runId || parsed.kind !== kind || JSON.stringify(parsed.payload) !== payloadJson) {
          throw new Error(`Workflow event replay conflict for ${eventId}`);
        }
        return parsed;
      }
    }
    const result = this.db.prepare(
      `INSERT INTO workflow_events (event_id, run_id, ts, event_kind, payload_json) VALUES (?, ?, ?, ?, ?)`,
    ).run(eventId ?? null, runId, now, kind, payloadJson);
    const row = this.db.prepare(`SELECT * FROM workflow_events WHERE id = ?`).get(Number(result.lastInsertRowid));
    workflowLog("info", { run: runId, event: kind });
    return parseWorkflowEventRow(row);
  }

  listEvents(runId: string): WorkflowEvent[] {
    return (this.db.prepare(
      `SELECT * FROM workflow_events WHERE run_id = ? ORDER BY id ASC`,
    ).all(runId) as unknown[]).map(parseWorkflowEventRow);
  }

  /**
   * The newest events of one kind across EVERY run, for a fleet-wide aggregate.
   *
   * Newest-first in SQL and reversed here, so the cap keeps the most recent window rather
   * than the oldest one, and the caller still reads in append order. `truncated` is returned
   * rather than inferred by the caller comparing lengths: an aggregate that silently drops
   * older attempts reads as a complete history of the fleet, which is the one thing this
   * telemetry must not do.
   *
   * A malformed payload becomes `null` rather than throwing. One unreadable row must not
   * cost an operator the other 1,999, and the aggregate counts what it could not read.
   */
  listEventsOfKind(kind: string, limit: number): {
    rows: { runId: string; timestamp: number; payload: unknown }[];
    truncated: boolean;
  } {
    const rows = this.db.prepare(
      `SELECT run_id, ts, payload_json FROM workflow_events
        WHERE event_kind = ?
        ORDER BY id DESC
        LIMIT ?`,
    ).all(kind, limit + 1) as { run_id: string; ts: number; payload_json: string }[];
    const truncated = rows.length > limit;
    return {
      rows: rows.slice(0, limit).reverse().map((row) => ({
        runId: String(row.run_id),
        timestamp: Number(row.ts),
        payload: ((): unknown => {
          try {
            return JSON.parse(row.payload_json);
          } catch {
            return null;
          }
        })(),
      })),
      truncated,
    };
  }

  /** One capped append-order window across a bounded set of related event kinds. */
  listEventsOfKinds(kinds: readonly string[], limit: number): {
    rows: Array<{
      eventId: string | null;
      runId: string;
      timestamp: number;
      kind: string;
      payload: unknown;
    }>;
    truncated: boolean;
  } {
    if (kinds.length === 0) return { rows: [], truncated: false };
    const placeholders = kinds.map(() => "?").join(", ");
    const rows = this.db.prepare(
      `SELECT event_id, run_id, ts, event_kind, payload_json FROM workflow_events
        WHERE event_kind IN (${placeholders})
        ORDER BY id DESC
        LIMIT ?`,
    ).all(...kinds, limit + 1) as Array<{
      event_id: string | null;
      run_id: string;
      ts: number;
      event_kind: string;
      payload_json: string;
    }>;
    const truncated = rows.length > limit;
    return {
      rows: rows.slice(0, limit).reverse().map((row) => ({
        eventId: row.event_id,
        runId: String(row.run_id),
        timestamp: Number(row.ts),
        kind: row.event_kind,
        payload: ((): unknown => {
          try {
            return JSON.parse(row.payload_json);
          } catch {
            return null;
          }
        })(),
      })),
      truncated,
    };
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
          let imageCount = 0;
          let imageBytes = 0;
          let textArtifactCount = 0;
          let textArtifactBytes = 0;
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
            const submissionImages = this.listSubmissionImages(row.id);
            const submissionArtifacts = this.listSubmissionTextArtifacts(row.id);
            imageCount += submissionImages.length;
            imageBytes += submissionImages.reduce((sum, image) => sum + image.bytes, 0);
            textArtifactCount += submissionArtifacts.length;
            textArtifactBytes += submissionArtifacts.reduce((sum, artifact) => sum + artifact.bytes, 0);
            parsed.evidence = {
              ...parsed.evidence,
              diff: "",
              workingTreeStatus: [],
              transcript: [],
              standards: parsed.evidence.standards.map((document) => ({ ...document, text: "" })),
              images: submissionImages.map((image) => ({
                ...image,
                availability: "pruned" as const,
                prunedAt: input.now,
              })),
              artifacts: submissionArtifacts.map((artifact) => ({
                ...artifact,
                content: "",
                availability: "pruned" as const,
                prunedAt: input.now,
              })),
              retention: {
                state: "pruned",
                prunedAt: input.now,
                diffBytes: utf8.encode(parsed.evidence.diff).byteLength,
                workingTreeStatusEntries: parsed.evidence.workingTreeStatus.length,
                transcriptMessages: parsed.evidence.transcript.length,
                standardsDocuments: parsed.evidence.standards.length,
                imageCount: submissionImages.length,
                imageBytes: submissionImages.reduce((sum, image) => sum + image.bytes, 0),
                textArtifactCount: submissionArtifacts.length,
                textArtifactBytes: submissionArtifacts.reduce((sum, artifact) => sum + artifact.bytes, 0),
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
            imageCount,
            imageBytes,
            textArtifactCount,
            textArtifactBytes,
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
          this.enqueueRunImageCleanupInTransaction(runId, input.now);
          this.db.prepare(
            `UPDATE workflow_submission_images
                SET availability = 'pruned', pruned_at = ?
              WHERE submission_id IN (
                SELECT id FROM workflow_submissions WHERE run_id = ?
              ) AND availability = 'retained'`,
          ).run(input.now, runId);
          this.db.prepare(
            `UPDATE workflow_submission_text_artifacts
                SET content = '', availability = 'pruned', pruned_at = ?
              WHERE submission_id IN (
                SELECT id FROM workflow_submissions WHERE run_id = ?
              ) AND availability = 'retained'`,
          ).run(input.now, runId);
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
            `DELETE FROM workflow_submission_readiness_overrides
              WHERE submission_id IN (SELECT id FROM workflow_submissions WHERE run_id = ?)`,
          ).run(runId);
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
          this.enqueueRunImageCleanupInTransaction(runId, input.now);
          this.deleteRunImageRowsInTransaction(runId);
          this.db.prepare(
            `DELETE FROM workflow_submission_text_artifacts
              WHERE submission_id IN (SELECT id FROM workflow_submissions WHERE run_id = ?)`,
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

  /**
   * Queue this run's bodies for deletion, minus the ones another run still reads.
   *
   * Digest reuse means one file can back frozen rows in several submissions and several
   * runs, so "this run is finished with it" stopped implying "nobody needs it". Both callers
   * are about to end this run's claim on the path in the same transaction - pruning marks its
   * rows `pruned`, deletion removes them - so the surviving-reference test is exactly "a
   * retained row outside this run", evaluated while this run's rows are still present.
   *
   * The alternative, a stored reference count, would be a second source of truth about
   * something the rows already state exactly. Counting them at the one moment a deletion is
   * decided cannot drift from them.
   */
  private enqueueRunImageCleanupInTransaction(runId: string, now: number): void {
    const rows = this.db.prepare(
      `SELECT DISTINCT i.storage_relative_path
         FROM workflow_submission_images i
         JOIN workflow_submissions s ON s.id = i.submission_id
        WHERE s.run_id = ?
          AND NOT EXISTS (
            SELECT 1
              FROM workflow_submission_images o
              JOIN workflow_submissions os ON os.id = o.submission_id
             WHERE o.storage_relative_path = i.storage_relative_path
               AND os.run_id <> s.run_id
               AND o.availability = 'retained'
          )`,
    ).all(runId) as Array<{ storage_relative_path: string }>;
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO workflow_image_cleanup (
         id, storage_relative_path, trash_relative_path, state, created_at, updated_at
       ) VALUES (?, ?, ?, 'pending', ?, ?)`,
    );
    for (const row of rows) {
      const id = randomUUID();
      insert.run(id, row.storage_relative_path, `.trash/${id}`, now, now);
    }
  }

  private deleteRunImageRowsInTransaction(runId: string): void {
    this.db.prepare(
      `DELETE FROM workflow_submission_evidence_coverage
        WHERE submission_id IN (SELECT id FROM workflow_submissions WHERE run_id = ?)`,
    ).run(runId);
    this.db.prepare(
      `DELETE FROM workflow_submission_images
        WHERE submission_id IN (SELECT id FROM workflow_submissions WHERE run_id = ?)`,
    ).run(runId);
    this.db.prepare(
      `DELETE FROM workflow_evidence_reservations
        WHERE submission_id IN (SELECT id FROM workflow_submissions WHERE run_id = ?)`,
    ).run(runId);
    this.db.prepare(
      `DELETE FROM workflow_evidence_staging
        WHERE state = 'reserved'
          AND NOT EXISTS (
            SELECT 1 FROM workflow_evidence_reservations r
             WHERE r.staging_id = workflow_evidence_staging.id
          )`,
    ).run();
    this.db.prepare(
      `DELETE FROM workflow_evidence_coverage_staging
        WHERE state = 'reserved'
          AND NOT EXISTS (
            SELECT 1 FROM workflow_submission_evidence_coverage c
             WHERE c.staging_id = workflow_evidence_coverage_staging.id
          )`,
    ).run();
  }

  processWorkflowImageCleanup(
    remove: (storageRelativePath: string, trashRelativePath: string) => void,
  ): void {
    const rows = this.db.prepare(
      `SELECT id, storage_relative_path, trash_relative_path
         FROM workflow_image_cleanup
        ORDER BY created_at ASC, id ASC LIMIT ?`,
    ).all(WORKFLOW_RETENTION_BATCH_SIZE) as Array<{
      id: string;
      storage_relative_path: string;
      trash_relative_path: string | null;
    }>;
    const referenced = this.db.prepare(
      `SELECT 1 FROM workflow_submission_images
        WHERE storage_relative_path = ? AND availability = 'retained' LIMIT 1`,
    );
    for (const row of rows) {
      try {
        // Defence in depth behind the two transactional guards. Reaching a queued path that a
        // live row has since claimed means the ledger is stale, not that the body is
        // disposable: drop the entry and leave the bytes where the row says they are.
        if (referenced.get(row.storage_relative_path)) {
          this.db.prepare(`DELETE FROM workflow_image_cleanup WHERE id = ?`).run(row.id);
          continue;
        }
        remove(row.storage_relative_path, row.trash_relative_path ?? `.trash/${row.id}`);
        this.db.prepare(`DELETE FROM workflow_image_cleanup WHERE id = ?`).run(row.id);
      } catch (error) {
        diagnose(error);
      }
    }
  }

  trackedImageStoragePaths(): string[] {
    return (this.db.prepare(
      `SELECT storage_relative_path FROM workflow_submission_images
       UNION
       SELECT storage_relative_path FROM workflow_image_cleanup`,
    ).all() as Array<{ storage_relative_path: string }>).map((row) => row.storage_relative_path);
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
    retainedEvidenceImages: number;
    retainedEvidenceImageBytes: number;
    prunedEvidenceImages: number;
    pendingEvidenceImageCleanup: number;
    orphanedEvidenceImages: number;
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
      retainedEvidenceImages: scalar(
        `SELECT COUNT(*) AS count FROM workflow_submission_images WHERE availability = 'retained'`,
      ),
      retainedEvidenceImageBytes: scalar(
        `SELECT COALESCE(SUM(bytes), 0) AS count
           FROM workflow_submission_images WHERE availability = 'retained'`,
      ),
      prunedEvidenceImages: scalar(
        `SELECT COUNT(*) AS count FROM workflow_submission_images WHERE availability = 'pruned'`,
      ),
      pendingEvidenceImageCleanup: scalar(
        `SELECT COUNT(*) AS count FROM workflow_image_cleanup`,
      ),
      // Filesystem reconciliation reports bounded orphans without deleting them. The store
      // owns no filesystem handle, so zero here is replaced by the manager's cached count.
      orphanedEvidenceImages: 0,
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

  /**
   * The last grant this run was given, read from the WHOLE ledger rather than a page of it.
   *
   * `runDetail` ships the oldest two hundred events and a cursor, and a grant is a late event
   * by construction - it cannot happen until a run has exhausted its repair budget. So a run
   * that spent five rounds keeps its grant well outside the page the browser is handed, and a
   * notice derived there would be absent on exactly the runs that were granted anything. This
   * reads the ledger directly, on the server, where there is no page.
   *
   * The staleness rule stays in the browser: this says what was granted and when, and
   * `runGrantNotice` decides whether that is still the last thing that happened. Deciding it
   * here would put a presentation rule in the store and make the field lie to any other
   * reader.
   */
  private runRepairGrant(runId: string): WorkflowRunDetail["repairGrant"] {
    const granted = this.listEvents(runId)
      .filter((event) => event.kind === "repair_rounds_granted")
      .at(-1);
    const payload = granted?.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    const { round, from, to } = payload;
    if (typeof round !== "number" || typeof from !== "number" || typeof to !== "number") {
      return null;
    }
    return { round, from, to };
  }

  /**
   * The observer's last word on this run, for the page that has to explain a parked round.
   *
   * Scoped to a run that is actually parked. A withheld reason on a run that has since
   * resumed, finished or been cancelled is history, and the ledger already holds it; repeating
   * it in the header would explain a state the run left.
   *
   * `resumesItself` rides along because the two facts are only useful together. "Waiting on
   * the session" means something quite different on a run whose loop closes by itself than on
   * one under `manual` resumption or `preview` delivery, where nothing is coming and the next
   * round is the operator's to start - and neither of those settings is visible anywhere else
   * on the page.
   */
  private runResumptionState(
    run: WorkflowRun,
    binding: WorkflowBinding,
    version: WorkflowVersion | null,
  ): WorkflowRunDetail["resumption"] {
    if (run.status !== "waiting_for_session") return null;
    const withheld = this.listEvents(run.id)
      .filter((event) => event.kind === "resumption_withheld")
      .at(-1);
    const payload = withheld?.payload;
    if (!withheld || !payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    const reason = payload.reason;
    if (typeof reason !== "string") return null;
    // Scoped to the round it was recorded against, not merely to the run being parked. A run
    // that was withheld at round 1, resumed, and parked again at round 2 is waiting on
    // something new; carrying the old sentence forward would explain the current silence with
    // a reason that has already been answered - and the more rounds a run survives, the more
    // confidently it would be wrong.
    if ((payload.submissionId ?? null) !== (this.latestSubmission(run.id)?.id ?? null)) return null;
    const round = payload.round;
    return {
      reason,
      round: typeof round === "number" ? round : null,
      resumesItself: workflowRunResumesItself({
        resumptionPolicy: version?.resumptionPolicy,
        deliveryMode: binding.deliveryMode,
      }),
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
      evidenceImages: this.runSubmissionImageGroups(id, submissions),
      evidenceCoverage: this.runSubmissionCoverageGroups(id, submissions),
      readinessOverrides: this.listReadinessOverrides(id),
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
      repairGrant: this.runRepairGrant(id),
      resumption: this.runResumptionState(run, binding, version),
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
      // The reason IS the phase here, and it is whatever the caller named - `cancelled:<id>`
      // from the dashboard's cancel action. Free-form by contract, so it takes the
      // compatibility door rather than widening the typed one.
      this.setRunStateCarryingPhase(id, "cancelled", reason, { reason }, now);
      this.appendEvent(id, "run_cancelled", { reason }, now);
      return this.mustRun(id);
    });
  }

  orphanBinding(
    id: string,
    reason: WorkflowRunPhase,
    now = Date.now(),
  ): WorkflowBinding | null {
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
            WHERE run_id = ? AND status IN (
              'capturing', 'running', 'waiting_for_evidence_readiness'
            )`,
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

  pauseBinding(
    id: string,
    reason: WorkflowRunPhase,
    now = Date.now(),
  ): WorkflowBinding | null {
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
            WHERE run_id = ? AND status IN (
              'capturing', 'running', 'waiting_for_evidence_readiness'
            )`,
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

  /**
   * Everything a reset removed, so the caller can retire it from the fleet stream too.
   *
   * Both lists, not just the runs. This used to return run ids alone while deleting the
   * bindings in the same transaction, so the registry kept publishing a binding whose row was
   * gone and a reset session's chip went on naming a workflow that could never run. Returning
   * what was deleted is what makes the SQL and the stream describe the same world; a caller
   * that forgets one of them now has to do so on purpose.
   */
  resetForNoteKey(noteKey: string): { runIds: string[]; bindingIds: string[] } {
    return transaction(this.db, () => {
      const runRows = this.db.prepare(
        `SELECT r.id FROM workflow_runs r
          JOIN workflow_bindings b ON b.id = r.binding_id
         WHERE b.note_key = ?`,
      ).all(noteKey) as unknown as Array<{ id: string }>;
      const runIds = runRows.map((row) => row.id);
      // Collected BEFORE the delete below, for the obvious reason: afterwards there is nothing
      // left to select, and the stream would never learn which entries to drop.
      const bindingIds = (this.db.prepare(
        `SELECT id FROM workflow_bindings WHERE note_key = ?`,
      ).all(noteKey) as unknown as Array<{ id: string }>).map((row) => row.id);
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
        this.db.prepare(
          `DELETE FROM workflow_submission_readiness_overrides
            WHERE submission_id IN (SELECT id FROM workflow_submissions WHERE run_id = ?)`,
        ).run(runId);
        this.db.prepare(`DELETE FROM workflow_events WHERE run_id = ?`).run(runId);
        this.enqueueRunImageCleanupInTransaction(runId, Date.now());
        this.deleteRunImageRowsInTransaction(runId);
        this.db.prepare(
          `DELETE FROM workflow_submission_text_artifacts
            WHERE submission_id IN (SELECT id FROM workflow_submissions WHERE run_id = ?)`,
        ).run(runId);
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
      this.db.prepare(`DELETE FROM workflow_evidence_staging WHERE note_key = ?`).run(noteKey);
      this.db.prepare(
        `DELETE FROM workflow_evidence_coverage_staging WHERE note_key = ?`,
      ).run(noteKey);
      this.db.prepare(`DELETE FROM workflow_evidence_scope_generations WHERE note_key = ?`).run(noteKey);
      this.db.prepare(`DELETE FROM workflow_evidence_owners WHERE note_key = ?`).run(noteKey);
      return { runIds, bindingIds };
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
   * Re-arm queue drain for a confirmed delivery, and say whether it was applicable.
   *
   * Queue drain retains its explicit state-machine re-arm. Queue-less prompted work needs no
   * delivery reset: the delivered repair turn's later normalized completion advances the
   * durable work-cycle generation naturally.
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
    if (delivery.kind === "session_action" || delivery.kind === "evidence_readiness") return null;
    if (this.rearmDrainCompletionForDelivery(delivery, now)) return "drain";
    return null;
  }

  private consumePromptedGuard(
    noteKey: string,
    sessionCwd: string | null,
    expectedWorkCycle: { logicalKey: string; generation: number },
    episodeKey: string,
    summary: string,
    now: number,
  ): boolean {
    if (expectedWorkCycle.logicalKey !== noteKey) return false;
    return consumePromptedGeneration({
      noteKey,
      sessionCwd,
      generation: expectedWorkCycle.generation,
      episodeKey,
      ask: false,
      // The claim's own reason, written by the SAME statement that spends the generation
      // and inside this transaction - so a claim that later throws rolls the reason back
      // with the consumption it described. Routing this through the ordinary consume route
      // instead would split one atomic claim into two writes a crash could land between,
      // which is why `workflow_claimed` is the one outcome that route refuses.
      decision: {
        outcome: "workflow_claimed",
        summary,
        gaps: [],
      },
      // A Workflow claim is not a direct-shipping handoff. Foreman submits the bound
      // Workflow and never types the direct PR instruction here, so latching one would
      // permanently disarm prompted completion for this intent episode against an action
      // that was never taken.
      directHandoff: null,
      now,
    }, this.db);
  }

  private insertSubmissionInTransaction(input: WorkflowSubmissionInsert): void {
    const provenance = workflowSubmissionOriginColumns(input.origin);
    this.db.prepare(
      `INSERT INTO workflow_submissions (
         id, run_id, round, segment, parent_submission_id, continuation_node_id,
         continuation_node_attempt_id, refinement_reason, mode, trigger_source, trigger_key, evidence_group_key,
         staged_image_generation, evidence_fingerprint, context_json, evidence_json,
         readiness_json, pr_head_sha,
         status, created_at, updated_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL, ?, ?, ?, ?,
                 CASE WHEN ? IN ('completed', 'cancelled', 'failed') THEN ? ELSE NULL END)`,
    ).run(
      input.id,
      input.runId,
      input.round,
      provenance.segment,
      provenance.parentSubmissionId,
      provenance.continuationNodeId,
      provenance.continuationNodeAttemptId,
      provenance.refinementReason,
      input.mode ?? "full_workflow",
      input.triggerSource,
      input.triggerKey,
      input.evidenceGroupKey ?? input.triggerKey,
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
    this.reserveWorkflowEvidenceInTransaction(
      input.id,
      input.evidenceGroupKey ?? input.triggerKey,
      input.now,
    );
  }

  private reserveWorkflowEvidenceInTransaction(
    submissionId: string,
    groupKey: string,
    now: number,
  ): void {
    const owner = this.db.prepare(
      `SELECT b.note_key,
              CASE WHEN b.repo_root <> '' THEN b.repo_root ELSE b.session_cwd END AS checkout_root,
              MAX(COALESCE(o.all_generation, 0), COALESCE(g.generation, 0)) AS generation
         FROM workflow_submissions s
         JOIN workflow_runs r ON r.id = s.run_id
         JOIN workflow_bindings b ON b.id = r.binding_id
         LEFT JOIN workflow_evidence_owners o ON o.note_key = b.note_key
         LEFT JOIN workflow_evidence_scope_generations g
           ON g.note_key = b.note_key
          AND g.source_root = CASE WHEN b.repo_root <> '' THEN b.repo_root ELSE b.session_cwd END
        WHERE s.id = ?`,
    ).get(submissionId) as {
      note_key: string;
      checkout_root: string | null;
      generation: number;
    } | undefined;
    if (!owner) throw new Error(`Workflow submission ${submissionId} has no evidence owner`);
    this.db.prepare(
      `UPDATE workflow_submissions SET staged_image_generation = ? WHERE id = ?`,
    ).run(owner.generation, submissionId);
    const rows = (this.db.prepare(
      `SELECT * FROM workflow_evidence_staging
        WHERE note_key = ?
          AND (state = 'staged' OR reserved_group_key = ?)
          AND (repository_scope = 'all' OR source_root = ?)
        ORDER BY created_at ASC, id ASC`,
    ).all(owner.note_key, groupKey, owner.checkout_root ?? "") as unknown[])
      .map(parseWorkflowEvidenceStagingRow);
    const imageRows = rows.filter((row) => row.evidence_kind === "image");
    const textRows = rows.filter((row) => row.evidence_kind === "text");
    if (imageRows.length > WORKFLOW_IMAGE_LIMITS.maxCount) {
      throw new Error(`At most ${WORKFLOW_IMAGE_LIMITS.maxCount} workflow evidence images apply to a submission`);
    }
    if (imageRows.reduce((sum, row) => sum + row.bytes, 0) > WORKFLOW_IMAGE_LIMITS.maxAggregateBytes) {
      throw new Error("Applicable workflow evidence exceeds the aggregate byte limit");
    }
    if (textRows.length > WORKFLOW_TEXT_EVIDENCE_LIMITS.maxCount) {
      throw new Error(`At most ${WORKFLOW_TEXT_EVIDENCE_LIMITS.maxCount} workflow text artifacts apply to a submission`);
    }
    if (
      textRows.reduce((sum, row) => sum + row.bytes, 0)
      > WORKFLOW_TEXT_EVIDENCE_LIMITS.maxAggregateBytes
    ) {
      throw new Error("Applicable workflow text evidence exceeds the aggregate byte limit");
    }
    const reserve = this.db.prepare(
      `INSERT OR IGNORE INTO workflow_evidence_reservations
         (staging_id, submission_id, ordinal, created_at)
       VALUES (?, ?, ?, ?)`,
    );
    const mark = this.db.prepare(
      `UPDATE workflow_evidence_staging
          SET state = 'reserved', reserved_group_key = ?, updated_at = ?
        WHERE id = ? AND (reserved_group_key IS NULL OR reserved_group_key = ?)`,
    );
    rows.forEach((row, ordinal) => {
      const marked = mark.run(groupKey, now, row.id, groupKey);
      if (Number(marked.changes) !== 1) {
        throw new Error(`Workflow evidence item ${row.client_item_id} was reserved concurrently`);
      }
      reserve.run(row.id, submissionId, ordinal, now);
    });
    const applicableItemIds = new Set(rows.map((row) => row.client_item_id));
    const coverageRows = (this.db.prepare(
      `SELECT * FROM workflow_evidence_coverage_staging
        WHERE note_key = ?
          AND (state = 'staged' OR reserved_group_key = ?)
          AND (repository_scope = 'all' OR source_root = ?)
        ORDER BY created_at ASC, id ASC`,
    ).all(owner.note_key, groupKey, owner.checkout_root ?? "") as unknown[])
      .map(parseWorkflowEvidenceCoverageStagingRow);
    if (coverageRows.length > WORKFLOW_EVIDENCE_COVERAGE_LIMITS.maxClaims) {
      throw new Error(
        `At most ${WORKFLOW_EVIDENCE_COVERAGE_LIMITS.maxClaims} workflow coverage claims apply to a submission`,
      );
    }
    const markCoverage = this.db.prepare(
      `UPDATE workflow_evidence_coverage_staging
          SET state = 'reserved', reserved_group_key = ?, updated_at = ?
        WHERE id = ? AND (reserved_group_key IS NULL OR reserved_group_key = ?)`,
    );
    const freezeCoverage = this.db.prepare(
      `INSERT OR IGNORE INTO workflow_submission_evidence_coverage (
         submission_id, staging_id, client_criterion_id, criterion, proof_class,
         repository_scope, links_json, generation, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of coverageRows) {
      const claim = coverageClaimFromRow(row);
      const missingLink = claim.links.find((link) => !applicableItemIds.has(link.clientItemId));
      if (missingLink) {
        throw new Error(
          `Workflow coverage claim ${claim.clientCriterionId} links evidence ${missingLink.clientItemId} outside this submission scope`,
        );
      }
      const marked = markCoverage.run(groupKey, now, row.id, groupKey);
      if (Number(marked.changes) !== 1) {
        throw new Error(
          `Workflow coverage claim ${row.client_criterion_id} was reserved concurrently`,
        );
      }
      freezeCoverage.run(
        submissionId,
        row.id,
        claim.clientCriterionId,
        claim.criterion,
        claim.proofClass,
        claim.repositoryScope,
        JSON.stringify(claim.links),
        row.generation,
        row.created_at,
        row.updated_at,
      );
    }
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
