/**
 * Age, capacity and admission pressure.
 *
 * Two windows, deliberately different lengths, and the difference is the whole point:
 *
 * - **Payload retention (7 days)** bounds the bytes. Journal facts and undelivered batches are
 *   the large objects, and they age out first.
 * - **Reducer-state retention (30 days)** bounds the IDENTITIES. Dedupe cursors and bounded
 *   reducer rows are tiny and have to outlive the payloads, because P5's rolling cohorts need
 *   a 30-day lookback and because an expired historical source must never be importable again
 *   as fresh activity. A unique key on a row that gets deleted is not durable deduplication.
 *
 * Both are charged to the same total byte budget. When the stricter of age and capacity bites,
 * the loss is COUNTED and visible rather than inferred later from a chart with a hole in it -
 * and where a failure prevented even the counter from being written, recovery says "unknown"
 * rather than claiming a precise number it does not have.
 */
import { TELEMETRY_LIMITS } from "@shared/telemetry.ts";
import {
  expiredBatchIds,
  listGaps,
  lowestConsumedSeq,
  pruneJournalPayloads,
  pruneJournalRows,
  pruneOrphanedContexts,
  pruneSourceIdentities,
  recordGap,
  releaseBatchPayload,
  settleDelivery,
  telemetryTransaction,
  usedBytes,
} from "./store.ts";

/** Start shedding before the hard cap, so ordinary capture keeps working while it drains. */
const PRESSURE_RATIO = 0.9;

/** How much work one pass does. Bounded so the sweep cannot become the thing that stalls. */
const BATCH_LIMIT = 500;

export interface RetentionPassResult {
  expiredBatches: number;
  prunedPayloads: number;
  prunedRows: number;
  prunedIdentities: number;
  prunedContexts: number;
  underPressure: boolean;
}

export function runRetentionPass(now = Date.now()): RetentionPassResult {
  return telemetryTransaction((d) => {
    const result: RetentionPassResult = {
      expiredBatches: 0,
      prunedPayloads: 0,
      prunedRows: 0,
      prunedIdentities: 0,
      prunedContexts: 0,
      underPressure: false,
    };

    const payloadCutoff = now - TELEMETRY_LIMITS.payloadRetentionMs;
    const stateCutoff = now - TELEMETRY_LIMITS.reducerStateRetentionMs;

    // 1. Undelivered batches past the age window. Expired, not silently deleted: an operator
    //    who was offline for eight days is told what did not make it.
    const stale = expiredBatchIds(d, payloadCutoff, now, BATCH_LIMIT);
    for (const id of stale) {
      settleDelivery(
        d,
        id,
        { state: "expired", attempts: 0, nextAttemptAt: now, lastError: "aged out of the retention window" },
        now,
      );
      releaseBatchPayload(d, id);
    }
    if (stale.length > 0) {
      recordGap(d, "payload_expired", `${stale.length} batch(es) aged out`, now, stale.length);
      result.expiredBatches = stale.length;
    }

    // 2. Journal payloads that are both past the window and already projected by EVERY
    //    projection. The checkpoint bound is what stops a sweep from deleting facts a slow
    //    reducer has not seen yet.
    const consumedThrough = lowestConsumedSeq(d);
    if (consumedThrough !== null) {
      result.prunedPayloads = pruneJournalPayloads(d, payloadCutoff, consumedThrough, now, BATCH_LIMIT);
    }

    // 3. Capacity pressure. Age alone is not enough on a busy installation, so the same two
    //    steps run again against the byte budget, oldest first.
    if (usedBytes(d) > TELEMETRY_LIMITS.maxTotalBytes * PRESSURE_RATIO) {
      result.underPressure = true;
      const pressured = expiredBatchIds(d, now, now, BATCH_LIMIT);
      for (const id of pressured) {
        settleDelivery(
          d,
          id,
          { state: "expired", attempts: 0, nextAttemptAt: now, lastError: "dropped under capacity pressure" },
          now,
        );
        releaseBatchPayload(d, id);
      }
      if (pressured.length > 0) {
        recordGap(
          d,
          "payload_expired",
          `${pressured.length} batch(es) dropped under capacity pressure`,
          now,
          pressured.length,
        );
        result.expiredBatches += pressured.length;
      }
      if (consumedThrough !== null) {
        result.prunedPayloads += pruneJournalPayloads(d, now, consumedThrough, now, BATCH_LIMIT);
      }
    }

    // 4. The long window. Identities and their emptied rows finally go, together, so a
    //    reconciliation cannot resurrect an expired source as new activity in between.
    result.prunedRows = pruneJournalRows(d, stateCutoff, BATCH_LIMIT);
    result.prunedIdentities = pruneSourceIdentities(d, stateCutoff, BATCH_LIMIT);
    result.prunedContexts = pruneOrphanedContexts(d);

    return result;
  });
}

/**
 * Report an unknown gap when the daemon can tell something was lost but not how much.
 *
 * Called on startup after a hard stop. The alternative - assuming zero - is the one answer the
 * data can never support.
 */
export function recordUnknownGapOnRecovery(detail: string, now = Date.now()): void {
  try {
    telemetryTransaction((d) => recordGap(d, "unknown_gap", detail, now));
  } catch {
    /* nothing left to do; the gap counter is itself unavailable */
  }
}

/** Whether any loss has been recorded at all, for the health view's honesty flag. */
export function hasRecordedGaps(): boolean {
  return telemetryTransaction((d) => listGaps(d).length > 0);
}
