import { WORKFLOW_LIMITS } from "@shared/workflow.ts";
import type {
  WorkflowBinding,
  WorkflowBindingClaim,
  WorkflowCaptureExpectation,
  WorkflowDeliveryMode,
  WorkflowExternalSourceKind,
  WorkflowTriggerMode,
  WorkflowVersionId,
} from "@shared/workflow.ts";

// The narrow boundary an external orchestrator crosses to start ONE Workflow run.
//
// Workflow-owned on purpose, and free of any orchestrator's persistence: nothing here may
// import an Ensemble store, and no Workflow module may learn what an ensemble is. What
// crosses the boundary is a bounded reference plus a capture expectation; what comes back
// is durable Workflow identity. That is the whole contract, and it is why a second external
// source later needs a new `WorkflowExternalSourceKind` and nothing else.

/**
 * Where one external result came from, in bounded parts the daemon supplies itself.
 *
 * Both ids are DISPLAY identity: `sourceId` names the record a later UI can link to, and
 * `resultId` distinguishes one result inside it. They are separate fields rather than one
 * pre-joined string so nothing downstream has to split the key apart again.
 */
export interface WorkflowExternalSourceRef {
  kind: WorkflowExternalSourceKind;
  sourceId: string;
  resultId: string;
}

export interface EnsureExternalBindingInput {
  source: WorkflowExternalSourceRef;
  /** The immutable published version. Resolved by the caller; re-validated by the manager. */
  workflowVersionId: WorkflowVersionId;
  /** Whose live conversation to bind. The manager resolves its noteKey server-side. */
  sessionId: string;
  triggerMode?: WorkflowTriggerMode;
  deliveryMode?: WorkflowDeliveryMode;
  maxRepairRounds?: number;
}

export interface ExternalBindingResult {
  binding: WorkflowBinding;
  claim: WorkflowBindingClaim;
  /** True only for the call that actually created the claim and its binding. */
  created: boolean;
}

export interface SubmitExternalInput {
  source: WorkflowExternalSourceRef;
  expectation: WorkflowCaptureExpectation;
}

/** Why a session may not be claimed right now, in one sentence, or null when it may. */
export type ExternalBindingEligibility = (input: {
  sessionId: string;
  source: WorkflowExternalSourceRef;
}) => string | null;

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function segment(label: string, value: string): string {
  if (!SEGMENT.test(value) || value.length > WORKFLOW_LIMITS.externalSourceSegment) {
    throw new Error(`External workflow source ${label} must be a bounded id without separators`);
  }
  return value;
}

/**
 * Derive the opaque, stable idempotency key for one external result.
 *
 * Every segment is validated to exclude the separator, so two different references cannot
 * spell the same key by putting a colon inside an id. The daemon derives this itself and no
 * reader parses it back: the ids a UI needs are stored beside it in their own columns.
 */
export function externalSourceKey(
  source: WorkflowExternalSourceRef,
  workflowVersionId: WorkflowVersionId,
): string {
  const key = [
    segment("kind", source.kind),
    segment("id", source.sourceId),
    "result",
    segment("result id", source.resultId),
    "workflow",
    segment("workflow version id", workflowVersionId),
  ].join(":");
  if (key.length > WORKFLOW_LIMITS.externalSourceKey) {
    throw new Error("External workflow source key exceeds its durable bound");
  }
  return key;
}
