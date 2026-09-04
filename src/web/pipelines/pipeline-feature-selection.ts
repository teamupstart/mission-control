import {
  pipelineRunKeyOf,
  type PipelineCommission,
  type PipelineRun,
} from "@shared/pipeline.ts";

type PipelineRunIdentity = Pick<PipelineRun, "provider" | "repoRoot" | "slug">;

/** Resolve either provider record through the same exact run key used by session views. */
export function featureRecordForRun<T>(
  records: readonly T[],
  runOf: (record: T) => PipelineRunIdentity | null | undefined,
  target: PipelineRunIdentity | null | undefined,
): T | null {
  if (!target) return null;
  const key = pipelineRunKeyOf(target);
  return records.find((record) => {
    const candidate = runOf(record);
    return candidate !== null && candidate !== undefined && pipelineRunKeyOf(candidate) === key;
  }) ?? null;
}

export interface PipelineFeatureSelection {
  activeRun: PipelineRun | null;
  activeCommission: PipelineCommission | null;
}

/**
 * Resolve one feature from either side of specification handoff.
 *
 * An addressed run wins. A commission selection suppresses the bare-tab fallback and may
 * cross the handoff through its linked run. With neither explicit selection, the rail's lead
 * run wins; only a bare tab with no run falls back to the first planning commission.
 */
export function resolvePipelineFeatureSelection({
  runs,
  commissions,
  addressedRun,
  fallbackRun,
  hasSelectedRunAddress,
  selectedCommissionId,
}: {
  runs: readonly PipelineRun[];
  commissions: readonly PipelineCommission[];
  addressedRun: PipelineRun | null;
  fallbackRun: PipelineRun | null;
  hasSelectedRunAddress: boolean;
  selectedCommissionId: string | null;
}): PipelineFeatureSelection {
  const run =
    addressedRun
    ?? (!hasSelectedRunAddress && selectedCommissionId === null ? fallbackRun : null);
  let commission: PipelineCommission | null = null;
  if (!hasSelectedRunAddress) {
    if (selectedCommissionId !== null) {
      commission = commissions.find((entry) => entry.id === selectedCommissionId) ?? null;
    } else if (!run) {
      commission = commissions[0] ?? null;
    }
  }
  const commissionRun = featureRecordForRun(runs, (candidate) => candidate, commission?.linkedRun);
  const activeRun = run ?? commissionRun;
  const activeCommission = activeRun
    ? featureRecordForRun(commissions, (entry) => entry.linkedRun, activeRun)
    : commission;

  return { activeRun, activeCommission };
}
