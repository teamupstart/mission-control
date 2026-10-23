import { z } from "zod";
import {
  CancelWorkflowRunSchema,
  GrantWorkflowRepairRoundsSchema,
  OverrideWorkflowEvidenceReadinessSchema,
  ReattachWorkflowBindingSchema,
  RemoveWorkflowPersonaDirectiveSchema,
  ResubmitWorkflowSchema,
  ResolveWorkflowDeliverySchema,
  RestartFullWorkflowSchema,
  RetryWorkflowDeliverySchema,
  RetryWorkflowEvidenceReadinessSchema,
  RetryWorkflowRunSchema,
  SetWorkflowNodesDisabledSchema,
  SetWorkflowPersonaDirectiveSchema,
  SubmitWorkflowSchema,
  WorkflowRunActionSchema,
  WorkflowRunStatusSchema,
} from "@shared/protocol.ts";

const id = z.string().trim().min(1).max(500)
  .refine((value) => value !== "." && value !== "..", "An ID cannot be a dot path segment");

function runAction<A extends string, S extends z.ZodTypeAny>(action: A, parameters: S) {
  return z.object({ action: z.literal(action), runId: id, parameters }).strict();
}

function submissionAction<A extends string, S extends z.ZodTypeAny>(action: A, parameters: S) {
  return runAction(action, parameters).extend({ submissionId: id });
}

// Reuse the dashboard's body schemas, including its explicit acknowledgements and replay keys.
export const WorkflowActionRequestSchema = z.discriminatedUnion("action", [
  runAction("grant-rounds", GrantWorkflowRepairRoundsSchema.strict()),
  runAction("cancel", CancelWorkflowRunSchema.strict()),
  runAction("retry", RetryWorkflowRunSchema.strict()),
  runAction("resubmit", ResubmitWorkflowSchema.strict()),
  runAction("restart-full", RestartFullWorkflowSchema.strict()),
  runAction("prepare-pr", WorkflowRunActionSchema.strict()),
  runAction("recheck-inspector", WorkflowRunActionSchema.strict()),
  runAction("set-nodes-disabled", SetWorkflowNodesDisabledSchema.strict()),
  runAction("set-persona-directive", SetWorkflowPersonaDirectiveSchema.strict()),
  runAction("remove-persona-directive", RemoveWorkflowPersonaDirectiveSchema.strict()),
  submissionAction("recover-evidence", RetryWorkflowEvidenceReadinessSchema),
  submissionAction("retry-evidence-readiness", RetryWorkflowEvidenceReadinessSchema),
  submissionAction("override-evidence-readiness", OverrideWorkflowEvidenceReadinessSchema),
  z.object({ action: z.literal("retry-delivery"), deliveryId: id, parameters: RetryWorkflowDeliverySchema.strict() }).strict(),
  z.object({ action: z.literal("resolve-delivery"), deliveryId: id, parameters: ResolveWorkflowDeliverySchema }).strict(),
  z.object({ action: z.literal("submit"), bindingId: id, parameters: SubmitWorkflowSchema.strict() }).strict(),
  z.object({ action: z.literal("reattach"), bindingId: id, parameters: ReattachWorkflowBindingSchema.strict() }).strict(),
  z.object({ action: z.literal("start-review"), sessionId: id, parameters: SubmitWorkflowSchema.strict() }).strict(),
]);

export const ListWorkflowRunsSchema = z.object({
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().max(512).optional(),
  status: WorkflowRunStatusSchema.optional(),
  workflowId: z.string().min(1).max(200).optional(),
  session: z.string().min(1).max(200).optional(),
}).strict();

export const GetWorkflowRunSchema = z.object({ runId: id }).strict();

/** Only known dashboard endpoints, never a caller-supplied URL or arbitrary method. */
export function workflowActionPath(request: z.infer<typeof WorkflowActionRequestSchema>): string {
  if ("submissionId" in request) {
    const suffix = {
      "recover-evidence": "evidence-recovery",
      "retry-evidence-readiness": "evidence-readiness/retry",
      "override-evidence-readiness": "evidence-readiness/override",
    }[request.action];
    return `/api/workflow-runs/${encodeURIComponent(request.runId)}/submissions/${encodeURIComponent(request.submissionId)}/${suffix}`;
  }
  if ("deliveryId" in request) {
    return `/api/workflow-deliveries/${encodeURIComponent(request.deliveryId)}/${request.action === "retry-delivery" ? "retry" : "resolve"}`;
  }
  if ("bindingId" in request) {
    return `/api/workflow-bindings/${encodeURIComponent(request.bindingId)}/${request.action}`;
  }
  if ("sessionId" in request) {
    return `/api/sessions/${encodeURIComponent(request.sessionId)}/workflow-review`;
  }
  return `/api/workflow-runs/${encodeURIComponent(request.runId)}/${request.action}`;
}
