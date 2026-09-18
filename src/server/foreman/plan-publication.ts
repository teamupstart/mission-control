import { samePlanPublicationContext, type PlanPublicationContext } from "@shared/plan-publication.ts";

/** A verifier may await a model while the operator changes the binding. Spend no stale verdict. */
export async function withPlanPublicationGuard<T>(
  expected: PlanPublicationContext | null,
  verify: () => Promise<T>,
  read: () => Promise<PlanPublicationContext>,
): Promise<T | null> {
  if (!expected) return verify(); // Other task kinds retain their existing path.
  if (expected.owner === "unavailable") return null;
  const result = await verify();
  return await planPublicationStillCurrent(expected, read) ? result : null;
}

export async function planPublicationStillCurrent(
  expected: PlanPublicationContext,
  read: () => Promise<PlanPublicationContext>,
): Promise<boolean> {
  const current = await read().catch(() => null);
  return current !== null && samePlanPublicationContext(expected, current);
}
