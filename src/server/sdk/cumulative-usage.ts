import type { SdkUsage } from "../harness/types.ts";
import type { LlmSpendModelUsage } from "@shared/llm-spend.ts";

/** A cumulative counter's new contribution, tolerating a provider-side reset. */
function cumulativeDelta(current: number, previous: number): number {
  return current >= previous ? current - previous : current;
}

/** Whether any query-wide counter proves the provider started a new accounting window. */
function cumulativeUsageReset(current: SdkUsage, previous: SdkUsage): boolean {
  return (
    current.input < previous.input ||
    current.output < previous.output ||
    current.cacheRead < previous.cacheRead ||
    current.cacheWrite < previous.cacheWrite ||
    (current.reasoningOutput ?? 0) < (previous.reasoningOutput ?? 0) ||
    (current.costUsd !== null && previous.costUsd !== null && current.costUsd < previous.costUsd)
  );
}

/** Whether one model's counters prove its cumulative accounting window restarted. */
function cumulativeModelUsageReset(
  current: LlmSpendModelUsage,
  previous: LlmSpendModelUsage,
): boolean {
  return (
    current.input < previous.input ||
    current.output < previous.output ||
    current.reasoningOutput < previous.reasoningOutput ||
    current.cacheRead < previous.cacheRead ||
    current.cacheWrite < previous.cacheWrite ||
    (
      current.reportedCostUsd !== null &&
      previous.reportedCostUsd !== null &&
      current.reportedCostUsd < previous.reportedCostUsd
    )
  );
}

/**
 * Advance cumulative counters without forgetting the last price the provider knew.
 *
 * A provider may omit cost from one otherwise valid result and resume reporting it later. That
 * unknown turn must keep its null delta, but storing null as the next baseline would make the
 * later query-to-date price subtract from zero. Token counters still advance normally while
 * scalar and per-model costs carry forward. An observable reset clears those remembered costs
 * so a new accounting window still contributes its whole first priced result.
 */
export function cumulativeUsageBaseline(current: SdkUsage, previous: SdkUsage | null): SdkUsage {
  if (!previous || cumulativeUsageReset(current, previous)) return current;
  const previousModels = new Map(previous.models?.map((model) => [model.modelId, model]) ?? []);
  const models = current.models?.map((model) => {
    const prior = previousModels.get(model.modelId);
    const reset = prior ? cumulativeModelUsageReset(model, prior) : false;
    return {
      ...model,
      reportedCostUsd:
        model.reportedCostUsd ?? (reset ? null : prior?.reportedCostUsd ?? null),
    };
  });
  return {
    ...current,
    costUsd: current.costUsd ?? previous.costUsd,
    ...(models ? { models } : {}),
  };
}

/**
 * Convert two conversation-to-date snapshots into the newest turn's usage.
 *
 * The first snapshot contributes its whole value. Later snapshots contribute only their
 * increase. A lower current value means the provider reset that counter, so the current value is
 * the new contribution rather than a negative delta. The result keeps the newest frame UUID:
 * it remains the durable replay key for this delta even though it was never the boundary of
 * the cumulative figures on the wire.
 */
export function cumulativeUsageDelta(
  current: SdkUsage,
  previous: SdkUsage | null,
): SdkUsage {
  if (!previous || cumulativeUsageReset(current, previous)) return current;
  const previousModels = new Map(previous?.models?.map((model) => [model.modelId, model]) ?? []);
  const models = current.models?.map((model) => {
    const prior = previousModels.get(model.modelId);
    return {
      ...model,
      input: cumulativeDelta(model.input, prior?.input ?? 0),
      output: cumulativeDelta(model.output, prior?.output ?? 0),
      reasoningOutput: cumulativeDelta(model.reasoningOutput, prior?.reasoningOutput ?? 0),
      cacheRead: cumulativeDelta(model.cacheRead, prior?.cacheRead ?? 0),
      cacheWrite: cumulativeDelta(model.cacheWrite, prior?.cacheWrite ?? 0),
      reportedCostUsd:
        model.reportedCostUsd === null
          ? null
          : cumulativeDelta(model.reportedCostUsd, prior?.reportedCostUsd ?? 0),
    };
  });
  return {
    input: cumulativeDelta(current.input, previous?.input ?? 0),
    output: cumulativeDelta(current.output, previous?.output ?? 0),
    cacheRead: cumulativeDelta(current.cacheRead, previous?.cacheRead ?? 0),
    cacheWrite: cumulativeDelta(current.cacheWrite, previous?.cacheWrite ?? 0),
    ...(current.reasoningOutput !== undefined
      ? {
          reasoningOutput: cumulativeDelta(
            current.reasoningOutput,
            previous?.reasoningOutput ?? 0,
          ),
        }
      : {}),
    modelId: current.modelId,
    costUsd:
      current.costUsd === null
        ? null
        : cumulativeDelta(current.costUsd, previous?.costUsd ?? 0),
    ...(current.turnId && models ? { turnId: current.turnId, models } : {}),
  };
}

