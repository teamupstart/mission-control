import { z } from "zod";
import type { ManagedPlanPolicy } from "./managed-plans.ts";
import { isShippingTaskKind } from "./task.ts";
import type { TaskKind } from "./types.ts";
import { WORKFLOW_TRIGGER_MODES } from "./workflow.ts";

/** A read of current binding authority, never an authorization to merge or ignore a handoff. */
export const PlanPublicationContextSchema = z.discriminatedUnion("owner", [
  z.object({
    owner: z.literal("workflow"),
    bindingId: z.string().min(1),
    workflowVersionId: z.string().min(1),
    triggerMode: z.enum(WORKFLOW_TRIGGER_MODES),
  }).strict(),
  z.object({ owner: z.literal("skill") }).strict(),
  z.object({ owner: z.literal("unavailable"), reason: z.string().min(1) }).strict(),
]);

export type PlanPublicationContext = z.infer<typeof PlanPublicationContextSchema>;

/**
 * True when Foreman's completion claim is the only thing that will start this plan's review.
 *
 * That is a repository-stored plan task whose publication a `foreman_complete` workflow owns.
 * A Manual binding waits for the operator's submit, and an unbound plan's skill opens its own
 * pull request, so neither depends on Foreman to move. Local-storage plans are left out because
 * their prompted completion never records a hold: it waits for the daemon's publication receipt.
 */
export function planStartsWorkflowOnCompletion(
  task: { kind: TaskKind; planPolicy?: ManagedPlanPolicy | null } | null | undefined,
  publication: PlanPublicationContext | null | undefined,
): boolean {
  return task?.kind === "plan"
    && task.planPolicy?.storage !== "local"
    && publication?.owner === "workflow"
    && publication.triggerMode === "foreman_complete";
}

/**
 * Whether Foreman may send a held completion's blocking gaps back to this task's session.
 *
 * Shipping kinds always may. A plan may only when `planStartsWorkflowOnCompletion` holds:
 * a held verdict consumes the completed work cycle, so without a relay such a plan sits idle
 * with no workflow run, no message and no next turn - the stall this predicate exists to end.
 */
export function heldGapRecoveryApplies(
  kind: TaskKind | null | undefined,
  planStartsWorkflow: boolean,
): boolean {
  return isShippingTaskKind(kind) || (kind === "plan" && planStartsWorkflow);
}

export function samePlanPublicationContext(a: PlanPublicationContext, b: PlanPublicationContext): boolean {
  if (a.owner === "unavailable" || b.owner === "unavailable" || a.owner !== b.owner) return false;
  return a.owner === "skill" || (b.owner === "workflow"
    && a.bindingId === b.bindingId
    && a.workflowVersionId === b.workflowVersionId
    && a.triggerMode === b.triggerMode);
}
