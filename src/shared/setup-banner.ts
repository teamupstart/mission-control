import {
  DEFAULT_SETUP_BANNER_DISMISSAL,
  setupRowKey,
  type SetupBannerDismissal,
  type SetupBannerView,
  type SetupRowId,
  type SetupRowView,
} from "./setup-catalog.ts";

/** The actionable states the banner may claim are broken. Unknown is deliberately excluded. */
export function setupRowNeedsAttention(row: SetupRowView): boolean {
  return row.requirement === "required"
    && (row.status.state === "missing" || row.status.state === "needs-setup");
}

export function setupAttentionRowIds(rows: readonly SetupRowView[]): SetupRowId[] {
  return rows.filter(setupRowNeedsAttention).map((row) => row.rowId);
}

/**
 * Retire acknowledgements once their row is satisfied or absent.
 *
 * Unknown remains acknowledged: a failed observation does not prove the machine was repaired.
 * The returned `changed` bit is what keeps the setup read from becoming a routine database write.
 */
export function pruneSetupBannerDismissal(
  rows: readonly SetupRowView[],
  dismissal: SetupBannerDismissal,
): { dismissal: SetupBannerDismissal; changed: boolean } {
  const byKey = new Map(rows.map((row) => [setupRowKey(row.rowId), row]));
  const seen = new Set<string>();
  const acknowledged = dismissal.acknowledged.filter((rowId) => {
    const key = setupRowKey(rowId);
    if (seen.has(key)) return false;
    seen.add(key);
    const row = byKey.get(key);
    return row !== undefined && row.status.state !== "satisfied";
  });
  const changed = acknowledged.length !== dismissal.acknowledged.length;
  return changed
    ? { dismissal: { ...dismissal, acknowledged }, changed: true }
    : { dismissal, changed: false };
}

export function setupBannerView(
  rows: readonly SetupRowView[],
  dismissal: SetupBannerDismissal = DEFAULT_SETUP_BANNER_DISMISSAL,
): SetupBannerView {
  const attentionRowIds = setupAttentionRowIds(rows);
  const acknowledged = new Set(dismissal.acknowledged.map(setupRowKey));
  return {
    visible: !dismissal.firstLaunchAcknowledged
      || attentionRowIds.some((rowId) => !acknowledged.has(setupRowKey(rowId))),
    attentionRowIds,
    attentionCount: attentionRowIds.length,
  };
}

/** One dismissal atomically acknowledges first launch and every broken required row shown. */
export function dismissSetupBanner(
  rows: readonly SetupRowView[],
  dismissal: SetupBannerDismissal = DEFAULT_SETUP_BANNER_DISMISSAL,
): SetupBannerDismissal {
  return acknowledgeSetupRows(dismissal, setupAttentionRowIds(rows));
}

/** Server-side write primitive for the row ids carried by the browser's latest setup view. */
export function acknowledgeSetupRows(
  dismissal: SetupBannerDismissal,
  rowIds: readonly SetupRowId[],
): SetupBannerDismissal {
  const acknowledged = new Map(
    dismissal.acknowledged.map((rowId) => [setupRowKey(rowId), rowId]),
  );
  for (const rowId of rowIds) acknowledged.set(setupRowKey(rowId), rowId);
  return {
    firstLaunchAcknowledged: true,
    acknowledged: [...acknowledged.values()],
  };
}
