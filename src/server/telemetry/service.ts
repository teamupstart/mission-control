/**
 * The telemetry facility's lifecycle: what starts, on what cadence, and what shutdown owes.
 *
 * Attached to the daemon AFTER state ownership and the database, and never as a launch
 * condition. Backend availability cannot delay a start and cannot delay an exit: an operator
 * on a plane closes Mission Control at the usual speed, and the queue is still there tomorrow.
 */
import { setTimeout as delay } from "node:timers/promises";
import { TELEMETRY_LIMITS } from "@shared/telemetry.ts";
import { getTelemetryConfig } from "./config.ts";
import { runDeliveryPass, type DeliveryDeps } from "./delivery.ts";
import { registerDaemonTelemetrySource } from "./diagnostics.ts";
import { CATALOG_PROJECTION, runProjectionPass } from "./projection.ts";
import { registerTelemetryProjection, registeredSources } from "./registration.ts";
import { runRetentionPass } from "./retention.ts";
import { recoverLeases, telemetryTransaction } from "./store.ts";

/** P1's candidate collection and export cadence, measured in docs/observability.md. */
export const TELEMETRY_CYCLE_MS = 30_000;
/** Retention is cheap and does not need to be frequent. */
export const TELEMETRY_RETENTION_MS = 10 * 60_000;
/** The local half of shutdown gets a budget; the network half gets none. */
export const TELEMETRY_SHUTDOWN_BUDGET_MS = 2_000;

/**
 * Register everything Phase 1 owns.
 *
 * Idempotent, and separate from `startTelemetry` so a focused test can exercise the pipeline
 * without starting timers - and so the daemon's registrations are in one readable place rather
 * than scattered across module side effects.
 */
export function registerBuiltinTelemetry(): void {
  registerTelemetryProjection(CATALOG_PROJECTION);
  registerDaemonTelemetrySource();
}

export interface TelemetryCycleResult {
  consumed: number;
  batches: number;
  sent: number;
  accepted: number;
}

/**
 * One full cycle: project everything pending, then drain a bounded slice of each queue.
 *
 * Projection loops until the journal is drained or the pass budget is spent, because a bounded
 * transaction size must not turn into a bounded throughput: a daemon that captured 5,000 facts
 * while its backend was down should catch up in one cycle, not in twenty.
 */
export async function runTelemetryCycle(
  deps: Partial<DeliveryDeps> = {},
): Promise<TelemetryCycleResult> {
  const now = deps.now?.() ?? Date.now();
  const result: TelemetryCycleResult = { consumed: 0, batches: 0, sent: 0, accepted: 0 };

  // A hard ceiling on passes per cycle, so an unexpectedly large journal cannot hold the loop.
  const maxPasses = 64;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const projected = runProjectionPass(deps.now?.() ?? now);
    result.consumed += projected.consumed;
    result.batches += projected.batches;
    if (projected.consumed < TELEMETRY_LIMITS.projectionBatchSize) break;
  }

  const delivered = await runDeliveryPass(deps);
  result.sent = delivered.sent;
  result.accepted = delivered.accepted;
  return result;
}

/**
 * The one in-flight cycle for this process.
 *
 * MODULE scope, not a closure inside `startTelemetry`, and that is the fix for a real defect
 * rather than a tidy-up. The guard was previously reachable only by the cadence timer and by
 * the service object it returned, so `POST /api/telemetry/drain` - which has neither - called
 * `runTelemetryCycle` straight through. A drain landing on the same tick as the timer produced
 * two independent delivery passes against one destination, each awaiting its own `send()`.
 * Per-batch leasing stops them taking the SAME batch; it does nothing about two concurrent
 * OTLP requests to one endpoint, which is exactly what `maxInFlightPerDestination: 1` promises.
 *
 * There is one telemetry facility per daemon process, so this state was always process-wide.
 * Hiding it in a closure did not make it narrower, only harder to reach from the second caller
 * that needed it.
 */
let inFlightCycle: Promise<TelemetryCycleResult> | null = null;

/**
 * Run one cycle, single-flighted across the whole process.
 *
 * Every caller goes through here: the cadence timer, the drain route, and shutdown. A second
 * caller arriving while one is running JOINS it rather than starting another, so it still gets
 * a truthful result for work that is actually happening.
 */
export function telemetryCycle(
  deps: Partial<DeliveryDeps> = {},
): Promise<TelemetryCycleResult> {
  if (inFlightCycle) return inFlightCycle;
  inFlightCycle = runTelemetryCycle(deps)
    .catch((error: unknown) => {
      console.warn("[telemetry] export cycle failed:", error);
      return { consumed: 0, batches: 0, sent: 0, accepted: 0 };
    })
    .finally(() => {
      inFlightCycle = null;
    }) as Promise<TelemetryCycleResult>;
  return inFlightCycle;
}

export interface TelemetryService {
  /** Run one cycle now, outside the cadence. Used by shutdown and by focused tests. */
  cycle(): Promise<TelemetryCycleResult>;
  stop(): Promise<void>;
}

/**
 * Start the recurring cycle.
 *
 * Startup recovers leases first. A leased row whose sender died returns to `retry` rather than
 * `pending`, because that request may have been accepted remotely and the retry path is where
 * that ambiguity is already handled.
 */
export function startTelemetry(deps: Partial<DeliveryDeps> = {}): TelemetryService {
  registerBuiltinTelemetry();

  const reclaimed = telemetryTransaction((d) => recoverLeases(d, deps.now?.() ?? Date.now()));
  if (reclaimed > 0) {
    console.log(`[telemetry] recovered ${reclaimed} in-flight export lease(s) from a previous run`);
  }

  // Source reconciliation, once, at start. Every Phase 1 source declares it can recover
  // nothing, so this loop does nothing today - and exists anyway, because it is the seam a
  // source phase hooks and discovering it is missing mid-phase is how one gets reinvented.
  for (const source of registeredSources()) {
    if (!source.reconcile) continue;
    try {
      void Promise.resolve(source.reconcile(deps.now?.() ?? Date.now())).catch((error: unknown) => {
        console.warn(`[telemetry] ${source.id} could not reconcile:`, error);
      });
    } catch (error) {
      console.warn(`[telemetry] ${source.id} could not reconcile:`, error);
    }
  }

  let stopped = false;
  const cycle = (): Promise<TelemetryCycleResult> => telemetryCycle(deps);

  const cycleTimer = setInterval(() => {
    if (stopped || !getTelemetryConfig().enabled) return;
    void cycle();
  }, TELEMETRY_CYCLE_MS);
  const retentionTimer = setInterval(() => {
    if (stopped || !getTelemetryConfig().enabled) return;
    try {
      runRetentionPass();
    } catch (error) {
      console.warn("[telemetry] retention pass failed:", error);
    }
  }, TELEMETRY_RETENTION_MS);
  cycleTimer.unref();
  retentionTimer.unref();

  return {
    cycle,
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(cycleTimer);
      clearInterval(retentionTimer);
      // The local commit gets a budget. The remote flush gets whatever is left of it and not a
      // millisecond more - an offline exit must never wait for a server that is not there.
      const settled = await Promise.race([
        inFlightCycle ?? Promise.resolve(null),
        // `ref: false` so this timer alone can never hold the process open. A shutdown that
        // waited on its own deadline would be the bug this budget exists to prevent.
        delay(TELEMETRY_SHUTDOWN_BUDGET_MS, null, { ref: false }),
      ]).catch(() => null);
      void settled;
      try {
        // Commit whatever is captured but unprojected, so accepted facts are not left as
        // journal rows a later start has to rediscover.
        runProjectionPass();
        // And release this process's leases explicitly, rather than leaving the next start to
        // wait for them to expire.
        telemetryTransaction((d) => recoverLeases(d, Date.now()));
      } catch (error) {
        console.warn("[telemetry] could not complete the local shutdown commit:", error);
      }
    },
  };
}
