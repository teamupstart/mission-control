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
import { noteTelemetryRunStart, noteTelemetryRunStopped, runRetentionPass } from "./retention.ts";
import { recoverLeases, telemetryTransaction } from "./store.ts";

/** P1's candidate collection and export cadence, measured in docs/observability.md. */
export const TELEMETRY_CYCLE_MS = 30_000;
/** Retention is cheap and does not need to be frequent. */
export const TELEMETRY_RETENTION_MS = 10 * 60_000;
/** The local half of shutdown gets a budget; the network half gets none. */
export const TELEMETRY_SHUTDOWN_BUDGET_MS = 2_000;

/**
 * How long an aborted cycle is given to unwind before shutdown proceeds regardless.
 *
 * Short because an aborted `fetch` rejects at once; this only bounds a pathological hang, so
 * the exit stays inside its budget either way.
 */
export const TELEMETRY_ABORT_GRACE_MS = 250;

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
  /**
   * False when the cycle threw.
   *
   * A background tick must not crash the daemon, so `telemetryCycle` swallows the rejection -
   * but an operator who pressed drain has to be able to tell a FAILED cycle from a cycle that
   * found nothing to do, and all-zero counts look identical to both. The route turns this into
   * a non-2xx response.
   */
  ok: boolean;
  /**
   * A fixed public string when `ok` is false, never the underlying message.
   *
   * The reason is logged rather than returned: a projection or delivery rejection can name an
   * endpoint, a path or a SQL fragment, and this value is served over HTTP.
   */
  error: string | null;
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
  const result: TelemetryCycleResult = {
    consumed: 0,
    batches: 0,
    sent: 0,
    accepted: 0,
    ok: true,
    error: null,
  };

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
/** Cancels the running cycle's in-flight request. Held beside the promise it belongs to. */
let inFlightAbort: AbortController | null = null;

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
  // Made here rather than by the caller, because the thing that needs to fire it - shutdown -
  // is not the thing that started the cycle.
  const abort = new AbortController();
  inFlightAbort = abort;
  inFlightCycle = runTelemetryCycle({ abort: abort.signal, ...deps })
    .catch((error: unknown) => {
      // The DETAIL goes to the daemon log; the RESULT carries a fixed string. An unhandled
      // projection or delivery rejection can name an endpoint, a file path or a SQL fragment,
      // and `/api/telemetry/drain` returns this body to its caller. The same rule the rest of
      // this facility follows: bounded, non-identifying error vocabulary, never raw detail.
      console.warn("[telemetry] export cycle failed:", error);
      return {
        consumed: 0,
        batches: 0,
        sent: 0,
        accepted: 0,
        ok: false,
        error: "the telemetry export cycle failed; see the daemon log for the reason",
      };
    })
    .finally(() => {
      inFlightCycle = null;
      inFlightAbort = null;
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

  // Did the previous run stop cleanly? Asked BEFORE anything else, because the answer is a
  // durable marker that this start is about to overwrite. Only while collection is enabled, so
  // a never-opted-in installation still writes nothing.
  const enabled = getTelemetryConfig().enabled;
  if (noteTelemetryRunStart(enabled, deps.now?.() ?? Date.now())) {
    console.warn(
      "[telemetry] the previous run did not shut down cleanly; recorded an unknown capture gap",
    );
  }

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
      if (settled === null && inFlightCycle) {
        // The budget expired with a request still open. STOPPING AWAITING IT IS NOT STOPPING
        // IT: the fetch runs on to its own ten-second timeout, so an offline exit could still
        // take ten seconds, and when the request finally resolved it would settle delivery
        // state after the local commit below had already recorded this run as clean - a write
        // racing the shutdown that was supposed to have finished.
        //
        // So tear it down, then let the cycle actually unwind before committing.
        inFlightAbort?.abort();
        await Promise.race([
          inFlightCycle,
          delay(TELEMETRY_ABORT_GRACE_MS, null, { ref: false }),
        ]).catch(() => null);
      }
      try {
        // Commit whatever is captured but unprojected, so accepted facts are not left as
        // journal rows a later start has to rediscover.
        runProjectionPass();
        // And release this process's leases explicitly, rather than leaving the next start to
        // wait for them to expire.
        telemetryTransaction((d) => recoverLeases(d, Date.now()));
        // Last, and only after the local commit succeeded: this is what stops the next start
        // reporting an unknown gap for a shutdown that was in fact orderly.
        noteTelemetryRunStopped(getTelemetryConfig().enabled);
      } catch (error) {
        console.warn("[telemetry] could not complete the local shutdown commit:", error);
      }
    },
  };
}
