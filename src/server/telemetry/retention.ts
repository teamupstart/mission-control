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
import { APP_CONFIG_ENTRIES } from "@shared/app-config-entries.ts";
import { getAppConfig, setAppConfig } from "../db.ts";
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
 * A loss counter that could not itself be written, owed to the next writable moment.
 *
 * Process-level, and deliberately not durable: the whole premise is that a write just failed,
 * so the only place left to remember it is memory. It is not lost by being in memory either,
 * because a crash before it can be flushed leaves the in-progress marker set, and the next
 * start reports the unknown gap for that reason instead.
 */
let unknownGapPending = false;

/** Remember that `recordGap` itself threw. Called from capture's containment boundary. */
export function markUnknownGapPending(): void {
  unknownGapPending = true;
}

/**
 * Write a deferred unknown gap if one is owed and the store is writable again.
 *
 * Without this the promise in docs/observability.md held only by coincidence: a failed gap
 * write followed by a clean shutdown recorded nothing at all, and health showed zero gaps for
 * an incident where a fact was refused AND its own counter failed. Returns whether it wrote.
 */
export function flushPendingUnknownGap(now = Date.now()): boolean {
  if (!unknownGapPending) return false;
  try {
    telemetryTransaction((d) =>
      recordGap(
        d,
        "unknown_gap",
        "a loss counter could not be written, so at least one refusal is uncounted",
        now,
      ),
    );
    unknownGapPending = false;
    return true;
  } catch {
    return false;
  }
}

/** Test-only: forget any owed gap so one file's fixtures cannot leak into another's. */
export function resetPendingUnknownGap(): void {
  unknownGapPending = false;
}

/**
 * Note that the previous run ended abruptly, and mark this one as in progress.
 *
 * Called once at startup, and ONLY while collection is enabled so a never-opted-in
 * installation still stores nothing.
 *
 * What an unclean stop actually costs is the pre-acceptance gap: a crash between a business
 * operation committing and its `capture()` call loses that fact, and nothing durable records
 * how many there were. Everything after acceptance is recoverable - an unprojected journal row
 * replays, an unacknowledged batch is retried - so this does not claim those were lost. It
 * claims only that the count is unknown, which is the one thing the data can support.
 *
 * Returns whether a gap was recorded, so a caller can log it.
 */
export function noteTelemetryRunStart(enabled: boolean, now = Date.now()): boolean {
  if (!enabled) return false;
  const previous = getAppConfig(APP_CONFIG_ENTRIES.telemetryRuntime);
  const unclean = previous !== undefined && previous.cleanShutdown === false;
  if (unclean) {
    recordUnknownGapOnRecovery(
      "the previous run ended without a clean shutdown; facts captured between a business commit and their capture call cannot be counted",
      now,
    );
  }
  setAppConfig(APP_CONFIG_ENTRIES.telemetryRuntime, { cleanShutdown: false });
  return unclean;
}

/**
 * Record that this run ended in an orderly way, so the next start does not report a gap.
 *
 * An owed unknown gap is written first. If it still cannot be written, the run is deliberately
 * NOT marked clean: leaving the in-progress marker set makes the next start report the unknown
 * gap, which is the outcome that keeps the promise even when the store is the thing at fault.
 */
export function noteTelemetryRunStopped(enabled: boolean, now = Date.now()): void {
  if (!enabled) return;
  flushPendingUnknownGap(now);
  if (unknownGapPending) return;
  setAppConfig(APP_CONFIG_ENTRIES.telemetryRuntime, { cleanShutdown: true });
}

/**
 * Report an unknown gap when the daemon can tell something was lost but not how much.
 *
 * The alternative - assuming zero - is the one answer the data can never support.
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
