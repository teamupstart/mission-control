import type { LlmRunnerId, ResolvedLlmRunner } from "./llm.ts";
import type { InspectorPosture } from "./inspector.ts";
import type { ModelChoiceSpec, ResolvedModel } from "./model-choice.ts";
import type { InspectorComment, InspectorInspection, InspectorMode } from "./types.ts";
import { providerModelDefault } from "./model.ts";

// Browser-safe workflow contracts. This module is intentionally data and pure helpers only:
// the daemon persists and executes these records, while the dashboard renders the same wire
// shapes. Nothing here may acquire a node: import.

export type PersonaId = string;
export type WorkflowId = string;
export type WorkflowVersionId = string;
export type WorkflowBindingId = string;
export type WorkflowRunId = string;
export type WorkflowSubmissionId = string;
export type WorkflowNodeAttemptId = string;
export type WorkflowDeliveryId = string;
export type WorkflowLlmCallId = string;

export const WORKFLOW_LIMITS = {
  personaName: 100,
  personaDescription: 500,
  personaGuidanceBytes: 100_000,
  workflowName: 120,
  graphNodes: 100,
  graphEdges: 300,
  graphJsonBytes: 500_000,
  eventPayloadBytes: 64_000,
  canvasCoordinateAbs: 100_000,
  repairRoundsMin: 1,
  repairRoundsMax: 20,
  feedbackFieldBytes: 4_000,
  feedbackPayloadBytes: 8_000,
  externalSourceId: 200,
  externalSourceSegment: 200,
  externalSourceKey: 1_000,
} as const;

export const WORKFLOW_EXECUTION_LIMITS = {
  contextJsonBytes: 2_000_000,
  verdictJsonBytes: 12_000,
  verdictSummary: 2_000,
  verdictReason: 4_000,
  verdictChanges: 20,
  verdictEvidence: 30,
  verdictPath: 1_000,
  verdictLine: 10_000_000,
} as const;

export const WORKFLOW_PERSONA_MODEL_ENV = "WORKFLOW_PERSONA_MODEL";
export const WORKFLOW_PERSONA_MODEL_SPEC: ModelChoiceSpec = {
  label: "Workflow Persona",
  envVar: `MISSION_${WORKFLOW_PERSONA_MODEL_ENV}`,
  fallback: providerModelDefault("claude", "balanced"),
  blurb: "Reviews workflow evidence with this Persona. An individual Persona override wins.",
};

export interface Persona {
  id: PersonaId;
  name: string;
  normalizedName: string;
  description: string;
  /** Exact operator-authored bytes after UTF-8 decoding. Never normalize this field. */
  guidanceMarkdown: string;
  runner: LlmRunnerId | null;
  model: string | null;
  revision: number;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
  /**
   * Shipped with the application rather than authored here.
   *
   * A built-in is app data, not operator data: it is not a row, it always carries the
   * Markdown this build was made from, and it can be neither edited nor archived. Duplicate
   * is the path to a customized copy, and that copy is an ordinary Persona like any other.
   */
  builtin: boolean;
}

export interface PersonaExecutionView {
  runner: ResolvedLlmRunner;
  model: ResolvedModel;
}

export interface PersonaDefaultsView {
  runner: ResolvedLlmRunner;
  models: Record<LlmRunnerId, ResolvedModel>;
}

export interface PersonaView extends Persona {
  execution: PersonaExecutionView;
}

/**
 * One durable uniqueness spelling for a Persona name.
 *
 * SQLite's NOCASE is ASCII-only. Normalize in JavaScript so names that differ only by
 * compatibility characters, whitespace, or English case cannot become two durable identities.
 */
export function normalizePersonaName(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

/** Workflow names use the same durable Unicode spelling rule as Persona names. */
export const normalizeWorkflowName = normalizePersonaName;

/**
 * The name a Persona Markdown document carries: its first level-one heading.
 *
 * One rule for both readers of authored Markdown - the built-ins compiled into the build and
 * an operator's **Import .md** - so a file imported by hand and the same file shipped with the
 * app arrive under the same name instead of two spellings that only collide at the unique index.
 */
export function personaNameFromMarkdown(markdown: string, fallback: string): string {
  return /^#[^\S\r\n]+(.+?)[^\S\r\n]*\r?$/m.exec(markdown)?.[1]?.trim() || fallback;
}

/**
 * The one-line summary a Persona Markdown document carries: the paragraph under its heading.
 *
 * Derived rather than stored so the description cannot drift from the document it describes.
 * A file with nothing but headings has no summary, and an empty description is a legal answer.
 */
export function personaDescriptionFromMarkdown(markdown: string): string {
  const body = markdown.replace(/^[\s\S]*?^#[^\S\r\n]+.*?$/m, "");
  const paragraph = (body === markdown ? markdown : body)
    .split(/(?:\r?\n){2,}/)
    .map((block) => block.trim())
    .find((block) => block.length > 0 && !block.startsWith("#"));
  if (paragraph === undefined) return "";
  const collapsed = paragraph.replace(/\s+/gu, " ");
  if (collapsed.length <= WORKFLOW_LIMITS.personaDescription) return collapsed;
  const cut = collapsed.slice(0, WORKFLOW_LIMITS.personaDescription - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export interface Point {
  x: number;
  y: number;
}

export const WORKFLOW_SOURCE_PORTS = ["submitted", "pass", "fail"] as const;
export type WorkflowSourcePort = (typeof WORKFLOW_SOURCE_PORTS)[number];

export const WORKFLOW_TARGET_PORTS = [
  "activate",
  "result",
  "return_for_changes",
  "terminal",
] as const;
export type WorkflowTargetPort = (typeof WORKFLOW_TARGET_PORTS)[number];

export type WorkflowDraftNode =
  | { id: string; kind: "session"; position: Point }
  | { id: string; kind: "persona"; personaId: PersonaId; position: Point }
  | { id: string; kind: "all_pass"; position: Point }
  | { id: string; kind: "end"; outcome: string; position: Point };

export interface WorkflowEdge {
  id: string;
  source: string;
  sourcePort: WorkflowSourcePort;
  target: string;
  targetPort: WorkflowTargetPort;
}

export interface WorkflowDraftGraph {
  nodes: WorkflowDraftNode[];
  edges: WorkflowEdge[];
}

export interface PersonaSnapshot {
  sourcePersonaId: PersonaId;
  sourceRevision: number;
  name: string;
  description: string;
  guidanceMarkdown: string;
  runner: LlmRunnerId | null;
  model: string | null;
}

export type PublishedWorkflowNode =
  | Exclude<WorkflowDraftNode, { kind: "persona" }>
  | { id: string; kind: "persona"; persona: PersonaSnapshot; position: Point };

export interface PublishedWorkflowGraph {
  nodes: PublishedWorkflowNode[];
  edges: WorkflowEdge[];
}

export const WORKFLOW_DIAGNOSTIC_CODES = [
  "missing_session",
  "multiple_sessions",
  "missing_end",
  "duplicate_node_id",
  "duplicate_edge_id",
  "node_limit",
  "edge_limit",
  "graph_size",
  "invalid_position",
  "coordinate_limit",
  "dangling_edge",
  "invalid_source_port",
  "invalid_target_port",
  "session_submitted_route",
  "session_return_route",
  "missing_pass_route",
  "missing_fail_route",
  "join_predecessors",
  "join_predecessor_kind",
  "join_missing_outcome",
  "join_duplicate_outcome",
  "unreachable_node",
  "no_terminal_path",
  "cycle_without_session",
  "missing_persona",
  "archived_persona",
  "invalid_completion_policy",
] as const;
export type WorkflowDiagnosticCode = (typeof WORKFLOW_DIAGNOSTIC_CODES)[number];

export interface WorkflowDiagnostic {
  code: WorkflowDiagnosticCode;
  severity: "error" | "warning";
  message: string;
  nodeId?: string;
  edgeId?: string;
}

export interface WorkflowValidationResult {
  valid: boolean;
  diagnostics: WorkflowDiagnostic[];
}

export const INSPECTOR_FINDINGS_POLICIES = ["restart_workflow", "inspector_only"] as const;
export type InspectorFindingsPolicy = (typeof INSPECTOR_FINDINGS_POLICIES)[number];

export type WorkflowCompletionPolicy =
  | { kind: "none" }
  | {
      kind: "inspector";
      onFindings: InspectorFindingsPolicy;
      missingPrAction: "wait" | "offer_prepare_pr";
    };

export const WORKFLOW_TRIGGER_MODES = ["manual", "foreman_complete"] as const;
export type WorkflowTriggerMode = (typeof WORKFLOW_TRIGGER_MODES)[number];

export const WORKFLOW_DELIVERY_MODES = ["preview", "live"] as const;
export type WorkflowDeliveryMode = (typeof WORKFLOW_DELIVERY_MODES)[number];

export interface WorkflowBindingDefaults {
  triggerMode: WorkflowTriggerMode;
  deliveryMode: WorkflowDeliveryMode;
  maxRepairRounds: number;
}

export const DEFAULT_WORKFLOW_BINDING_DEFAULTS: WorkflowBindingDefaults = {
  triggerMode: "manual",
  deliveryMode: "preview",
  maxRepairRounds: 5,
};

export const WORKFLOW_BINDING_STATES = ["active", "paused", "orphaned", "archived"] as const;
export type WorkflowBindingState = (typeof WORKFLOW_BINDING_STATES)[number];

export const WORKFLOW_RUN_STATUSES = [
  "capturing",
  "running",
  "waiting_for_session",
  "waiting_for_pr",
  "waiting_for_inspector",
  "waiting_for_new_head",
  "blocked",
  "completed",
  "cancelled",
  "failed",
] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

export const WORKFLOW_GATE_WAIT_REASONS = [
  "missing_pr",
  "unadopted_pr",
  "inspector_disabled",
  "awaiting_fresh_observation",
  "working_tree_not_pushed",
  "head_mismatch",
  "review_pending",
  "review_backoff",
  "review_error",
  "findings",
  "pr_closed",
] as const;
export type WorkflowGateWaitReason = (typeof WORKFLOW_GATE_WAIT_REASONS)[number];

export interface WorkflowInspectorGateState {
  prKey: string | null;
  prUrl: string | null;
  targetHeadSha: string | null;
  failedHeadSha: string | null;
  enteredAt: number;
  lastObservedAt: number | null;
  observedHeadSha: string | null;
  reviewPosture: InspectorPosture | null;
  waitReason: WorkflowGateWaitReason | null;
  findingFingerprints: string[];
}

export const WORKFLOW_GATE_SUMMARIES = [
  "none",
  "waiting_pr",
  "waiting_inspector",
  "findings",
  "clean",
  "blocked",
] as const;
export type WorkflowGateSummary = (typeof WORKFLOW_GATE_SUMMARIES)[number];

export const WORKFLOW_SUBMISSION_MODES = ["full_workflow", "inspector_only"] as const;
export type WorkflowSubmissionMode = (typeof WORKFLOW_SUBMISSION_MODES)[number];

export const WORKFLOW_SUBMISSION_STATUSES = [
  "capturing",
  "running",
  "waiting_for_session",
  "completed",
  "cancelled",
  "failed",
] as const;
export type WorkflowSubmissionStatus = (typeof WORKFLOW_SUBMISSION_STATUSES)[number];

/** Infrastructure lifecycle only. Persona pass/fail is stored separately as a verdict. */
export const WORKFLOW_NODE_ATTEMPT_STATES = [
  "queued",
  "running",
  "retry_wait",
  "completed",
  "error",
  "cancelled",
] as const;
export type WorkflowNodeAttemptState = (typeof WORKFLOW_NODE_ATTEMPT_STATES)[number];

export const WORKFLOW_DELIVERY_KINDS = [
  "persona_feedback",
  "inspector_feedback",
  "pr_handoff",
] as const;
export type WorkflowDeliveryKind = (typeof WORKFLOW_DELIVERY_KINDS)[number];

export const WORKFLOW_DELIVERY_STATES = [
  "prepared",
  "sending",
  "delivered",
  "refused",
  "uncertain",
  "cancelled",
] as const;
export type WorkflowDeliveryState = (typeof WORKFLOW_DELIVERY_STATES)[number];

export const WORKFLOW_COMPLETION_KINDS = ["drain", "prompted"] as const;
export type WorkflowCompletionKind = (typeof WORKFLOW_COMPLETION_KINDS)[number];

export const WORKFLOW_LLM_PURPOSES = ["context_compaction", "persona_review"] as const;
export type WorkflowLlmPurpose = (typeof WORKFLOW_LLM_PURPOSES)[number];

export const WORKFLOW_LLM_CALL_STATES = [
  "running",
  "succeeded",
  "failed",
  "interrupted",
  "cancelled",
] as const;
export type WorkflowLlmCallState = (typeof WORKFLOW_LLM_CALL_STATES)[number];

/**
 * Who started one durable run and submission. APPEND-ONLY: these strings are persisted in
 * `workflow_runs.trigger_source` and `workflow_submissions.trigger_source` on operators'
 * machines, so renaming one does not migrate history, it makes it unparsable.
 *
 * Deliberately NOT the same axis as `WORKFLOW_TRIGGER_MODES`. A trigger mode is recurring
 * binding behaviour an operator chose (answer manually, or let Foreman claim a completion);
 * a trigger source records which caller actually produced a given submission, and `ensemble`
 * is a server-owned handoff that starts exactly one initial submission and never recurs.
 */
export const WORKFLOW_TRIGGER_SOURCES = ["manual", "foreman", "ensemble"] as const;
export type WorkflowTriggerSource = (typeof WORKFLOW_TRIGGER_SOURCES)[number];

/**
 * External orchestrators that may claim one Workflow binding through the server-owned
 * boundary. Append-only for the `WORKFLOW_TRIGGER_SOURCES` reason: it is persisted in
 * `workflow_binding_claims.source_kind`.
 */
export const WORKFLOW_EXTERNAL_SOURCE_KINDS = ["ensemble"] as const;
export type WorkflowExternalSourceKind = (typeof WORKFLOW_EXTERNAL_SOURCE_KINDS)[number];

/**
 * Display provenance for a run whose binding was claimed by an external orchestrator.
 *
 * `sourceId` is DISPLAY identity - the id of the record a later phase can deep-link to.
 * It is explicit precisely so no reader ever has to take the opaque idempotency key apart:
 * that key is a server-derived string whose shape may change, and parsing it in the store
 * or the browser would turn an internal spelling into a wire contract.
 */
export interface WorkflowExternalSource {
  kind: WorkflowExternalSourceKind;
  sourceId: string;
  createdAt: number;
}

/** One external orchestrator's durable claim on exactly one Workflow binding. */
export interface WorkflowBindingClaim {
  kind: WorkflowExternalSourceKind;
  /** Opaque, server-derived idempotency key. Never parsed by a reader. */
  sourceKey: string;
  sourceId: string;
  bindingId: WorkflowBindingId;
  createdAt: number;
}

/**
 * What an externally sourced submission must observe before its evidence is durable.
 *
 * `requireCleanWorktree` is the literal `true` rather than a boolean because a matching HEAD
 * alone is NOT the selected artifact: uncommitted changes would put evidence into the review
 * that the external caller never selected. Typing it as a literal is what stops a later
 * caller from opting out of exact-clean capture while still satisfying the contract.
 */
export interface WorkflowCaptureExpectation {
  expectedHeadSha: string;
  requireCleanWorktree: true;
}

export interface WorkflowConfig {
  liveEnabled: boolean;
  repoAllowlist: string[];
  retention: WorkflowRetentionConfig;
}

export interface WorkflowRetentionConfig {
  /** Remove raw evidence from eligible terminal runs after this many days. */
  rawEvidenceDays: number;
  /** Remove the complete eligible run family after this many days. */
  completedRunDays: number;
  /** Always retain this many newest completed or cancelled run families. */
  maxCompletedRuns: number;
}

export const DEFAULT_WORKFLOW_CONFIG: WorkflowConfig = {
  liveEnabled: false,
  repoAllowlist: [],
  retention: {
    rawEvidenceDays: 30,
    completedRunDays: 180,
    maxCompletedRuns: 1_000,
  },
};

export interface WorkflowCompletionClaim {
  completionKind: WorkflowCompletionKind;
  /** SHA-256 of the worker's proof episode, never raw prompt or diff text. */
  marker: string;
  summary: string;
  evidenceFingerprint: string;
  /**
   * The prompted episode the verifier judged. Null for drain claims.
   *
   * The daemon compares this with its current goal at the same synchronous boundary
   * that retires the guard, so a newer human prompt cannot inherit an older verdict.
   */
  expectedGoal: string | null;
}

export type WorkflowCompletionClaimResult =
  | { claimed: false; reason: "no_binding" | "manual_trigger" }
  | {
      claimed: true;
      runId: WorkflowRunId;
      submissionId: WorkflowSubmissionId | null;
      state: "started" | "resubmitted" | "already_claimed" | "blocked";
    };

/** JSON that has crossed a validation boundary. */
export type WorkflowJson =
  | null
  | boolean
  | number
  | string
  | WorkflowJson[]
  | { [key: string]: WorkflowJson };

export interface WorkflowDefinition {
  id: WorkflowId;
  name: string;
  normalizedName: string;
  description: string;
  draft: WorkflowDraftGraph;
  completionPolicy: WorkflowCompletionPolicy;
  bindingDefaults: WorkflowBindingDefaults;
  draftRevision: number;
  currentVersionId: WorkflowVersionId | null;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowVersion {
  id: WorkflowVersionId;
  workflowId: WorkflowId;
  version: number;
  sourceDraftRevision: number;
  graph: PublishedWorkflowGraph;
  completionPolicy: WorkflowCompletionPolicy;
  bindingDefaults: WorkflowBindingDefaults;
  publishedAt: number;
}

export type WorkflowVersionMetadata = Omit<WorkflowVersion, "graph">;

/** The bounded catalog projection carried over SSE. Graphs and guidance stay on HTTP. */
export interface WorkflowSummary {
  id: WorkflowId;
  name: string;
  description: string;
  draftRevision: number;
  currentVersionId: WorkflowVersionId | null;
  publishedVersion: number | null;
  archivedAt: number | null;
  updatedAt: number;
  errorCount: number;
  warningCount: number;
  nodeCount: number;
  personaCount: number;
}

export interface WorkflowDetail {
  workflow: WorkflowDefinition;
  versions: WorkflowVersionMetadata[];
}

export interface WorkflowBinding {
  id: WorkflowBindingId;
  workflowVersionId: WorkflowVersionId;
  noteKey: string;
  sessionId: string | null;
  /** Immutable compatibility facts captured when the binding was created or reattached. */
  sessionAgent: string;
  sessionName: string;
  sessionCwd: string | null;
  sessionRepoRoot: string | null;
  triggerMode: WorkflowTriggerMode;
  deliveryMode: WorkflowDeliveryMode;
  state: WorkflowBindingState;
  maxRepairRounds: number;
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowRun {
  id: WorkflowRunId;
  bindingId: WorkflowBindingId;
  workflowVersionId: WorkflowVersionId;
  status: WorkflowRunStatus;
  currentPhase: string;
  maxRepairRounds: number;
  triggerSource: WorkflowTriggerSource;
  triggerKey: string;
  inspectorPrKey: string | null;
  inspectorHeadSha: string | null;
  gateState: WorkflowJson | null;
  startedAt: number;
  updatedAt: number;
  completedAt: number | null;
  evidencePrunedAt?: number | null;
}

export interface WorkflowSubmission {
  id: WorkflowSubmissionId;
  runId: WorkflowRunId;
  round: number;
  mode: WorkflowSubmissionMode;
  triggerSource: WorkflowTriggerSource;
  triggerKey: string;
  evidenceFingerprint: string;
  context: WorkflowJson;
  evidence: WorkflowJson;
  prHeadSha: string | null;
  status: WorkflowSubmissionStatus;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface WorkflowNodeAttempt {
  id: WorkflowNodeAttemptId;
  submissionId: WorkflowSubmissionId;
  nodeId: string;
  attempt: number;
  state: WorkflowNodeAttemptState;
  persona: PersonaSnapshot | null;
  /** Actual provider/model resolved at attempt start. */
  runner: LlmRunnerId | null;
  model: string | null;
  verdict: WorkflowJson | null;
  output: WorkflowJson | null;
  retryAt: number | null;
  inputFingerprint: string;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface WorkflowEdgeReceipt {
  id: number;
  submissionId: WorkflowSubmissionId;
  edgeId: string;
  sourceAttemptId: WorkflowNodeAttemptId;
  payload: WorkflowJson;
  createdAt: number;
}

export interface WorkflowDelivery {
  id: WorkflowDeliveryId;
  runId: WorkflowRunId;
  submissionId: WorkflowSubmissionId;
  kind: WorkflowDeliveryKind;
  sessionId: string;
  noteKey: string;
  payload: string;
  payloadSha256: string;
  state: WorkflowDeliveryState;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  deliveredAt: number | null;
  payloadPrunedAt?: number | null;
}

export interface WorkflowLlmCall {
  id: WorkflowLlmCallId;
  runId: WorkflowRunId;
  submissionId: WorkflowSubmissionId;
  nodeAttemptId: WorkflowNodeAttemptId | null;
  purpose: WorkflowLlmPurpose;
  runner: LlmRunnerId;
  model: string;
  attempt: number;
  state: WorkflowLlmCallState;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  inputBytes: number;
  outputBytes: number;
  costUsd: number | null;
  errorCode: string | null;
}

export interface WorkflowEvent {
  id: number;
  runId: WorkflowRunId;
  timestamp: number;
  kind: string;
  payload: WorkflowJson;
}

export interface WorkflowHumanDecision {
  decision: string;
  rationale: string | null;
  source: {
    kind: "transcript" | "review" | "foreman_episode";
    id: string;
  };
}

export interface PersonaFeedbackSummary {
  personaName: string;
  summary: string;
  requestedChanges: string[];
}

export interface WorkflowStandardsDocument {
  path: string;
  text: string;
  truncated: boolean;
  fingerprint: string;
}

export interface WorkflowTranscriptMessage {
  role: "user" | "assistant";
  content: string;
  timestamp?: number;
}

export interface WorkflowContextSnapshot {
  primaryGoal: {
    rawPrompt: string;
    refined: string | null;
    sourceNoteKey: string;
  };
  humanDecisions: WorkflowHumanDecision[];
  constraints: string[];
  acceptanceCriteria: string[];
  priorPersonaFeedback: PersonaFeedbackSummary[];
  session: {
    agent: string;
    name: string;
    cwd: string | null;
    branch: string | null;
  };
  evidence: {
    headSha: string | null;
    diffFingerprint: string;
    diff: string;
    diffTruncated: boolean;
    workingTreeDirty: boolean;
    workingTreeStatus: string[];
    workingTreeStatusTruncated: boolean;
    transcript: WorkflowTranscriptMessage[];
    transcriptAnchor: number | null;
    transcriptTruncated: boolean;
    standards: WorkflowStandardsDocument[];
    standardsTruncated: boolean;
    retention?:
      | { state: "full" }
      | {
          state: "pruned";
          prunedAt: number;
          diffBytes: number;
          workingTreeStatusEntries: number;
          transcriptMessages: number;
          standardsDocuments: number;
        };
  };
  compaction: {
    status: "model" | "fallback";
    runner: LlmRunnerId | null;
    model: string | null;
    error: string | null;
  };
}

export interface EvidenceRef {
  kind: "diff" | "transcript" | "standard" | "goal" | "decision";
  quote: string;
  path?: string;
  line?: number;
}

export interface RequestedChange {
  title: string;
  rationale: string;
  evidence: EvidenceRef[];
  path?: string;
  line?: number;
}

export type PersonaVerdict =
  | {
      verdict: "pass";
      summary: string;
      approvalDetails: {
        reason: string;
        evidence: EvidenceRef[];
      };
      confidence: number;
    }
  | {
      verdict: "fail";
      summary: string;
      requestedChanges: RequestedChange[];
      confidence: number;
    };

export interface WorkflowRunSummary {
  id: WorkflowRunId;
  bindingId: WorkflowBindingId;
  workflowId: WorkflowId;
  workflowName: string;
  workflowVersion: number;
  sessionId: string | null;
  noteKey: string;
  status: WorkflowRunStatus;
  phase: string;
  round: number;
  maxRepairRounds: number;
  activePersonaNames: string[];
  failedPersonaCount: number;
  bypassedPersonaReview: boolean;
  gate: WorkflowGateSummary;
  gatePrNumber: number | null;
  gateHeadShort: string | null;
  reviewPosture: InspectorPosture | null;
  uncertainDeliveryCount?: number;
  refusedDeliveryCount?: number;
  updatedAt: number;
}

export interface WorkflowInspectorGateDetail {
  state: WorkflowInspectorGateState;
  inspection: InspectorInspection | null;
  findings: InspectorComment[];
  inspector: {
    enabled: boolean;
    mode: InspectorMode;
    posture: InspectorPosture | null;
  };
}

export interface WorkflowRunDetail {
  summary: WorkflowRunSummary;
  binding: WorkflowBinding;
  version: WorkflowVersion | null;
  run: WorkflowRun;
  contextState: "captured" | "not_captured" | "corrupt";
  submissions: WorkflowSubmission[];
  attempts: WorkflowNodeAttempt[];
  receipts: WorkflowEdgeReceipt[];
  deliveries: WorkflowDelivery[];
  events: WorkflowEvent[];
  eventCount?: number;
  nextEventAfter?: number | null;
  llmCalls?: WorkflowLlmCall[];
  llmCallCount?: number;
  nextLlmCallAfter?: string | null;
  /**
   * Provenance for a run an external orchestrator started. Optional and detail-only: run
   * SUMMARIES travel over SSE for every run in the fleet and must stay compact.
   */
  externalSource?: WorkflowExternalSource | null;
  inspectorGate: WorkflowInspectorGateDetail | null;
}

export interface WorkflowRunPage {
  items: WorkflowRunSummary[];
  nextCursor: string | null;
}

export interface WorkflowEventPage {
  items: WorkflowEvent[];
  nextAfter: number | null;
}

export interface WorkflowLlmCallPage {
  items: WorkflowLlmCall[];
  nextAfter: string | null;
}

export interface WorkflowStatus {
  activeRuns: number;
  queuedPersonaCalls: number;
  runningPersonaCalls: number;
  waitingDeliveries: number;
  uncertainDeliveries: number;
  inspectorGates: number;
  lastRecoveryAt: number | null;
  lastRetentionAt: number | null;
  lastRetentionError: string | null;
  retainedRunCount: number;
  lastRetentionCompacted: number;
  lastRetentionDeleted: number;
}

export interface WorkflowExportEnvelope<T> {
  schemaVersion: 1;
  exportedAt: number;
  kind: "workflow_run" | "workflow_version";
  data: T;
}
