import { z } from "zod";
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

export function samePlanPublicationContext(a: PlanPublicationContext, b: PlanPublicationContext): boolean {
  if (a.owner === "unavailable" || b.owner === "unavailable" || a.owner !== b.owner) return false;
  return a.owner === "skill" || (b.owner === "workflow"
    && a.bindingId === b.bindingId
    && a.workflowVersionId === b.workflowVersionId
    && a.triggerMode === b.triggerMode);
}
