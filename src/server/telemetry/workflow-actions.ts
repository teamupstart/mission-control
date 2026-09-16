import { randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { WorkflowStore } from "../workflows/store.ts";
import { workflowRunResumesItself } from "@shared/workflow.ts";
import type { WorkflowRun } from "@shared/workflow.ts";
import { matchWorkflowAction, type WorkflowAction } from "@shared/workflow-actions.ts";
import { resolveOperationContext, type TelemetryOperationContext } from "@shared/telemetry-ingress.ts";
import { ACTION_RESULT_EVENT, type ACTION_INTENTS, type ACTION_CAUSES } from "@shared/telemetry-sources/actions.ts";
import { captureTelemetry } from "./capture.ts";
import { workflowWait } from "./workflows.ts";

export function workflowActionCause(action: WorkflowAction, run: WorkflowRun | null, automaticResumption: boolean | null = null): {
  intent: typeof ACTION_INTENTS[number]; cause: typeof ACTION_CAUSES[number];
} {
  if (action === "workflow.cancel") return { intent: "termination", cause: "none" };
  if (!run) return { intent: "optional_steering", cause: "none" };
  const wait = workflowWait(run);
  const cause = wait === "human" ? "human_gate" : wait === "agent" ? "agent_wait" : wait === "external" ? "external_wait"
    : run.status === "blocked" ? "blocked" : wait === "unknown" ? "unknown" : "none";
  if (["workflow.directive", "workflow.remove_directive"].includes(action)
    || (action === "workflow.recheck" && run.status !== "blocked")) return { intent: "optional_steering", cause };
  if (action === "workflow.resubmit" && wait === "agent") return {
    intent: automaticResumption === null ? "unknown" : automaticResumption ? "recovery" : "required_decision", cause,
  };
  const recovery = cause !== "none" && cause !== "unknown";
  return { intent: recovery ? "recovery" : cause === "unknown" ? "unknown" : "optional_steering", cause };
}
export function recordWorkflowAction(input: {
  action: WorkflowAction; context: TelemetryOperationContext; operationId: string;
  outcome: "applied" | "refused" | "failed"; startedAt: number; now: number;
  before: WorkflowRun | null; automaticResumption?: boolean | null; refs?: Record<string, string>;
}): void {
  captureTelemetry({ event: ACTION_RESULT_EVENT,
    source: { kind: "mission.workflow.action", id: `${input.action}:${input.operationId}:${input.outcome}`, revision: 1 },
    actor: input.context.actor, refs: { ...input.refs, operation_id: input.operationId, ...(input.before ? { run_id: input.before.id } : {}) },
    facts: { feature: input.action.startsWith("persona.") ? "persona" : "workflow", action: input.action,
      outcome: input.outcome, duration_ms: Math.max(0, input.now - input.startedAt),
      surface: input.context.surface, coverage: "owner_result", ...workflowActionCause(input.action, input.before, input.automaticResumption) }, now: input.now });
}
/** Observe the route's authoritative result, without changing request, response or permissions. */
export function workflowActionTelemetry(store: () => WorkflowStore | null): MiddlewareHandler {
  return async (c, next) => {
    const match = matchWorkflowAction(c.req.method, c.req.path);
    if (!match) return next();
    const startedAt = Date.now();
    let before: WorkflowRun | null = null;
    let automaticResumption: boolean | null = null;
    const refs: Record<string, string> = {};
    try {
      const owner = store();
      if (match.subject) {
        if (match.owner === "workflow-runs") before = owner?.getRun(match.subject) ?? null;
        if (match.owner === "workflow-deliveries") {
          refs.delivery_id = match.subject;
          const delivery = owner?.getDelivery(match.subject);
          if (delivery) before = owner?.getRun(delivery.runId) ?? null;
        }
        if (match.owner === "workflow-bindings") {
          refs.binding_id = match.subject;
          before = owner?.activeRunForBinding(match.subject) ?? null;
        }
        if (match.owner === "workflows") refs.workflow_id = match.subject;
        if (match.owner === "personas") refs.persona_id = match.subject;
      }
      if (before && owner) {
        const binding = owner.getBinding(before.bindingId);
        const version = owner.getWorkflowVersionById(before.workflowVersionId);
        if (binding && version) automaticResumption = workflowRunResumesItself({
          deliveryMode: binding.deliveryMode, resumptionPolicy: version.resumptionPolicy,
        });
      }
    } catch { /* Observation cannot fail an operation. */ }
    const context = resolveOperationContext(c.req.raw.headers);
    let operationId = context.operationId;
    operationId ??= randomUUID();
    try { await next(); } finally {
      // The owner's request id survives browser retries even when each request carries a new
      // app context. Read only this bounded field, never retain the body or any rationale.
      try {
        if (c.res.ok && c.req.header("content-type")?.includes("application/json")) {
          const body: unknown = await c.req.json();
          if (body && typeof body === "object" && "requestId" in body
            && typeof body.requestId === "string" && body.requestId.length <= 200) operationId = body.requestId;
        }
      } catch { /* The route retains its normal malformed-body response. */ }
      recordWorkflowAction({ action: match.action, context, operationId: `${match.subject ?? "catalog"}:${operationId}`,
        before, automaticResumption, refs, startedAt, now: Date.now(), outcome: c.error || c.res.status >= 500 ? "failed" : c.res.ok ? "applied" : "refused" });
    }
  };
}
