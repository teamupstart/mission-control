import { getPipelineCommission, getTask } from "../db.ts";
import { observePipelineCommission } from "./automation.ts";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { MiddlewareHandler } from "hono";
import { resolveOperationContext } from "@shared/telemetry-ingress.ts";
import { matchPrimaryAction, primaryActionVariant, type PrimaryAction } from "@shared/telemetry-sources/primary-actions.ts";
import { ERROR_ID_HEADER } from "@shared/telemetry-sources/experience.ts";
import { operationObservation, recordPrimaryAction, retainPendingAction, recordSafeError, type ActionOutcome, type OperationObservation } from "./experience.ts";

const requestContext = z.object({ requestId: z.string().min(1).max(900).optional(), sourceKey: z.string().min(1).max(4096).optional(), by: z.enum(["human", "foreman", "agent", "workflow"]).optional() });
const resultShape = z.object({ ok: z.boolean().optional(), outcome: z.string().optional(), status: z.string().optional(), state: z.string().optional(),
  occurrence: z.object({ status: z.string() }).optional(), queued: z.boolean().optional(), accepted: z.boolean().optional(),
  claimed: z.boolean().optional(), kind: z.string().optional() });
/** These predicates read the owner's normalized result, never a response's prose. */
export function primaryOutcome(action: PrimaryAction, status: number, value: unknown): ActionOutcome {
  if (["pipeline.start", "pipeline.retry"].includes(action)
    && z.object({ outcomeUnknown: z.literal(true) }).safeParse(value).success) return "pending";
  if (status >= 500) return "failed";
  if (status >= 400) return "refused";
  const parsed = resultShape.safeParse(value);
  if (!parsed.success) return "pending"; // An unrecognized success shape cannot prove completion.
  const r = parsed.data;
  if (r.ok === false || r.claimed === false || r.accepted === false) return "refused";
  // `state` on a queue item describes future delivery, not whether enqueue succeeded.
  // A review request likewise succeeds when the pending review has been created.
  const outcome = r.occurrence?.status ?? r.outcome
    ?? (action === "attention.request" ? undefined : r.status)
    ?? (action === "foreman.workflow_claim" ? r.state : undefined) ?? r.kind;
  if (outcome && ["refused", "stale", "skipped_overlap", "skipped_missed", "skipped_policy", "blocked"].includes(outcome)) return "refused";
  if (outcome && ["failed", "error"].includes(outcome)) return "failed";
  if (outcome && ["cancelled", "canceled"].includes(outcome)) return "cancelled";
  if (status === 202 || r.queued || (outcome && ["pending", "queued", "creating", "maybe-opening", "unknown", "claimed"].includes(outcome))) return "pending";
  // Starting an external engine proves admission only after its commission confirms it.
  if (["pipeline.start", "pipeline.retry"].includes(action)) return "pending";
  return "applied";
}
export function primaryActionTelemetry(): MiddlewareHandler {
  return async (c, next) => {
    // Exporter/ingress diagnostics own their errors and cannot recursively report themselves.
    if (c.req.path.startsWith("/api/telemetry/")) return next();
    const match = matchPrimaryAction(c.req.method, c.req.path);
    const context = resolveOperationContext(c.req.raw.headers, c.req.path.startsWith("/mcp/") ? "mcp" : "unknown");
    // The standard browser headers establish dashboard origin; an unmarked caller stays unknown.
    if (context.actor.basis === "app_context") context.actor.origin = "dashboard";
    const observation: OperationObservation = { context, primaryAction: match?.action, operationId: context.operationId ?? randomUUID().replaceAll("-", ""), startedAt: Date.now() };
    return operationObservation.run(observation, async () => {
      await next();
      let idempotencyKey = observation.operationId;
      // Reading observation data must never change the already-completed business response.
      try {
        if (match && (c.req.bodyCache.json || c.req.bodyCache.text)) {
          // Only inspect a body the route already consumed. In particular, never read a
          // rejected oversized stream after its bodyLimit middleware has returned 413.
          const body: unknown = await c.req.json();
          const parsed = requestContext.safeParse(body);
          observation.primaryAction = primaryActionVariant(match.action, body);
          if (parsed.success) {
            if (parsed.data.requestId) idempotencyKey = parsed.data.requestId;
            else if (match.action === "ensemble.create" && parsed.data.sourceKey) idempotencyKey = parsed.data.sourceKey;
            if (parsed.data.by && context.actor.kind !== "unknown" && parsed.data.by !== context.actor.kind) {
              context.actor = { kind: "unknown", basis: "unknown", origin: context.actor.origin };
            } else if (parsed.data.by && context.actor.kind === "unknown") {
              context.actor = { kind: parsed.data.by, basis: "declared", origin: context.actor.origin };
            }
          }
        }
      } catch { /* Malformed requests keep the route's refusal. */ }
      if (c.error || c.res.status >= 500) {
        const id = observation.errorId ?? recordSafeError({ component: "route", family: "execution",
          code: c.res.status === 503 ? "unavailable" : c.res.status === 504 ? "timeout" : "unexpected", retryable: "unknown", handled: !c.error,
          fingerprint: "unknown", suppressed: 0 }, c.error, observation);
        c.header(ERROR_ID_HEADER, id);
      }
      if (match && !observation.ownerActions?.has(match.action)) {
        let result: unknown = null;
        try {
          // Routes in this manifest return finite JSON owner results, never streams/files.
          result = await c.res.clone().json();
        } catch { /* Unknown success stays pending. */ }
        const action = { ...observation, ...match, action: observation.primaryAction ?? match.action, sourceId: `${match.subject}:${idempotencyKey}` };
        const outcome = c.error ? "failed" : primaryOutcome(match.action, c.res.status, result);
        recordPrimaryAction({ ...action, outcome });
        if (outcome === "pending" && ["pipeline.start", "pipeline.retry"].includes(match.action)) {
          try {
            const link = z.object({ pipelineCommissionId: z.string() }).safeParse(result);
            const commissionId = link.success ? link.data.pipelineCommissionId : getTask(match.subject)?.pipelineCommissionId;
            const commission = commissionId ? getPipelineCommission(commissionId) : null;
            if (commission) {
              retainPendingAction(`${commission.id}:${commission.activeAttempt}`, { action: match.action, feature: match.feature,
                context, operationId: observation.operationId, startedAt: observation.startedAt, sourceId: action.sourceId });
              observePipelineCommission(commission);
            }
          } catch { /* Preserve the business response when observation is unavailable. */ }
        }
      }
    });
  };
}
