import { MODEL_CATALOG, coreModelId } from "@shared/model.ts";
import type { ResidentProfileRevision } from "@shared/residents.ts";
import { resolveDispatchModelWithTier } from "../harnesses.ts";
import { estimateStandardApiUsage } from "../harness/codex/pricing.ts";

/** Claude reports cost; Codex needs a verified entry in the existing pricing registry. */
const measurableModel = {
  claude: (model: string | null) => model === null || ["opus", "sonnet", "haiku", "fable"].includes(model) ||
    MODEL_CATALOG.claude.some((choice) => coreModelId(choice.id) === coreModelId(model)),
  codex: (model: string | null) => estimateStandardApiUsage({
    identity: "resident-model-validation", ts: 0, modelId: model, querySource: "main",
    input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoningOutput: 0, vendorCostUsd: null,
  }) !== null,
};
export function residentSpendProblem(settings: ResidentProfileRevision): string | null {
  if (settings.loop.spendCapUsd === null) return null;
  const { agent, model } = settings.execution;
  const resolved = resolveDispatchModelWithTier(agent, model, null, "resident").model;
  return measurableModel[agent](resolved) ? null :
    `Spend cannot be priced for ${resolved ?? "the harness default model"}. Choose a priced model or clear the spend cap.`;
}
