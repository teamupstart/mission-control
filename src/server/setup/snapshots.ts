import {
  setupRowKey,
  type SetupChecksSnapshot,
  type SetupChecksView,
  type SetupRowId,
} from "@shared/setup-catalog.ts";

const SNAPSHOT_LIMIT = 64;

function rowKeys(rowIds: readonly SetupRowId[]): string[] {
  return rowIds.map(setupRowKey).sort();
}

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

/**
 * Bind a dismissal to the required-attention set returned by GET /api/setup/checks.
 *
 * Equivalent observations may coexist across tabs. Any observed repair or regression changes
 * the attention fingerprint and invalidates every older token, while a daemon restart naturally
 * invalidates its in-memory tokens too. This adds no probe, poll, or routine database write.
 */
export function createSetupSnapshotTracker(randomId: () => string) {
  let attentionFingerprint: string | null = null;
  const snapshots = new Map<string, readonly string[]>();

  return {
    issue(view: SetupChecksView): SetupChecksSnapshot {
      const keys = rowKeys(view.banner.attentionRowIds);
      const fingerprint = JSON.stringify(keys);
      if (attentionFingerprint !== fingerprint) {
        snapshots.clear();
        attentionFingerprint = fingerprint;
      }

      const snapshotToken = randomId();
      snapshots.set(snapshotToken, keys);
      while (snapshots.size > SNAPSHOT_LIMIT) {
        snapshots.delete(snapshots.keys().next().value!);
      }
      return { ...view, snapshotToken };
    },

    consume(snapshotToken: string, acknowledged: readonly SetupRowId[]): boolean {
      const expected = snapshots.get(snapshotToken);
      snapshots.delete(snapshotToken);
      return expected !== undefined && sameKeys(expected, rowKeys(acknowledged));
    },
  };
}
