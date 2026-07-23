import type { LlmRunnerId, ResolvedLlmRunner } from "./llm.ts";
import type { ModelChoiceSpec, ResolvedModel } from "./model-choice.ts";
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

export type WorkflowTriggerSource = "manual" | "foreman";

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

export interface WorkflowBinding {
  id: WorkflowBindingId;
  workflowVersionId: WorkflowVersionId;
  noteKey: string;
  sessionId: string | null;
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
