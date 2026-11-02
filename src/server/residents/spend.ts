import type { ResidentProfileRevision } from "@shared/residents.ts";
import { residentModelSpendAvailable } from "@shared/resident-spend.ts";
import { resolveDispatchModelWithTier } from "../harnesses.ts";

export function residentSpendProblem(settings: ResidentProfileRevision): string | null {
  if (settings.loop.spendCapUsd === null) return null;
  const { agent, model } = settings.execution;
  const resolved = resolveDispatchModelWithTier(agent, model, null, "resident").model;
  return residentModelSpendAvailable(agent, resolved) ? null :
    `Spend cannot be priced for ${resolved ?? "the harness default model"}. Choose a priced model or clear the spend cap.`;
}
