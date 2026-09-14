/**
 * The exporter: leases an immutable batch, sends it, and records what happened.
 *
 * Everything here runs OUTSIDE a database transaction except the two settlements at either
 * end, which is the property that makes the crash boundaries tractable. A crash before local
 * acknowledgement retries the same immutable record; lease recovery deliberately does NOT
 * assume the previous request went unaccepted, which is why an ambiguous attempt lands on the
 * retry path where the duplicate behaviour is documented rather than on a fresh-send path
 * where it would be invisible.
 *
 * Exporter failures never go back through `capture`. A telemetry facility that records its own
 * export errors as user activity generates work for itself forever; they go to a bounded
 * self-diagnostic path - the destination's `last_error` and the gap counters - instead.
 */
import {
  TELEMETRY_LIMITS,
  TELEMETRY_SIGNALS,
  type TelemetryPauseReason,
  type TelemetryProfileId,
  type TelemetrySignal,
  type TelemetryTransportOutcome,
} from "@shared/telemetry.ts";
import { getTelemetryConfig, profileIsExporting } from "./config.ts";
import { credentialSurvivesRedirect, safeEndpointLabel, signalUrl } from "./endpoint.ts";
import {
  OTLP_PROTOBUF_CONTENT_TYPE,
  readMetricsPartialSuccess,
  readTracesPartialSuccess,
  serializeMetrics,
  serializeTraces,
} from "./otlp.ts";
import type { MetricsBatchPayload, TracesBatchPayload } from "./projection.ts";
import {
  getDestination,
  getSecret,
  leaseBatch,
  recordGap,
  releaseBatchPayload,
  settleDelivery,
  telemetryTransaction,
  updateDestination,
  type StoredBatch,
} from "./store.ts";

/** Identifies this process's leases. A restart reclaims what it left behind. */
const LEASE_OWNER = `daemon-${process.pid}`;

/** How many consecutive throttled attempts before a destination is paused as over quota. */
const QUOTA_PAUSE_AFTER = 10;

export interface DeliveryPassResult {
  sent: number;
  accepted: number;
  retried: number;
  rejected: number;
  paused: number;
}

export interface DeliveryDeps {
  /** Injected so a fixture can answer without a socket. Defaults to global `fetch`. */
  fetch: typeof globalThis.fetch;
  now: () => number;
  /**
   * Tears down whatever is in flight. Shutdown's budget is the only thing that fires it.
   *
   * Bounding the WAIT is not bounding the WORK: a request abandoned at the budget still runs
   * to its own ten-second timeout, so the process could take ten seconds to exit, and when the
   * request finally resolved it would settle delivery state after shutdown had already
   * recorded the run as having ended cleanly.
   */
  abort: AbortSignal | null;
}

const defaultDeps: DeliveryDeps = {
  fetch: (...args) => globalThis.fetch(...args),
  now: Date.now,
  abort: null,
};

/**
 * Drain a bounded slice of every exporting destination's queue.
 *
 * One in-flight request per destination and signal, and a bounded number of batches per pass,
 * so an overnight backlog catches up without saturating either the daemon or the endpoint.
 * One destination's failure never blocks another's: each profile is its own loop.
 */
export async function runDeliveryPass(deps: Partial<DeliveryDeps> = {}): Promise<DeliveryPassResult> {
  const d = { ...defaultDeps, ...deps };
  const config = getTelemetryConfig();
  const result: DeliveryPassResult = { sent: 0, accepted: 0, retried: 0, rejected: 0, paused: 0 };
  if (!config.enabled) return result;

  for (const profile of ["user", "product"] as const) {
    // Whatever was already in flight is torn down by the signal itself; this stops the pass
    // claiming a batch it has no time left to send.
    if (d.abort?.aborted) break;
    if (!profileIsExporting(config, profile)) continue;
    const endpoint = profile === "user" ? config.user.endpoint : config.product.endpoint;

    for (const signal of TELEMETRY_SIGNALS) {
      // Re-read for EVERY signal, not once per profile. The metrics loop can pause this
      // destination itself - a 401 or 404 through `settle`, or the tenth consecutive throttle -
      // and a check taken before it ran would then let the traces loop send up to eight more
      // requests to an endpoint we have just established is refusing us. That is the hammering
      // the pause exists to stop, and the guide promises it does not happen.
      if (telemetryTransaction((tx) => getDestination(tx, profile).pausedReason) !== null) break;

      for (let i = 0; i < TELEMETRY_LIMITS.deliveryBatchesPerTick; i += 1) {
        if (d.abort?.aborted) break;
        const outcome = await deliverOne(profile, signal, endpoint, d);
        if (outcome === "idle") break;
        result.sent += 1;
        if (outcome === "accepted") result.accepted += 1;
        if (outcome === "retry") {
          result.retried += 1;
          // A retry means this destination is unhealthy right now. Stop pulling from its queue
          // this pass rather than burning the budget on requests that will fail the same way.
          break;
        }
        if (outcome === "rejected") result.rejected += 1;
        if (outcome === "paused") {
          result.paused += 1;
          break;
        }
      }
    }
  }
  return result;
}

type DeliveryStep = "idle" | "accepted" | "retry" | "rejected" | "paused";

async function deliverOne(
  profile: TelemetryProfileId,
  signal: TelemetrySignal,
  endpoint: string,
  deps: DeliveryDeps,
): Promise<DeliveryStep> {
  const now = deps.now();
  const leased = telemetryTransaction((d) => {
    const destination = getDestination(d, profile);
    const claim = leaseBatch(d, profile, signal, LEASE_OWNER, now);
    if (!claim) return null;
    return { ...claim, destination };
  });
  if (!leased) return "idle";

  const { batch, attempts, destination } = leased;

  // Fencing. A batch built for a different endpoint or a different consent epoch is never
  // redirected to the current one; it is retained in a terminal state so Phase 2 can offer the
  // operator the documented keep / discard / approve-transfer choice over it.
  if (
    batch.destinationGeneration !== destination.generation ||
    batch.policyEpoch !== destination.policyEpoch
  ) {
    telemetryTransaction((d) => {
      settleDelivery(
        d,
        batch.id,
        {
          state: "rejected",
          attempts,
          nextAttemptAt: now,
          lastError: "built for a previous endpoint or consent epoch",
        },
        now,
      );
      recordGap(d, "permanently_rejected", `${profile}/${signal}: stale destination generation`, now);
    });
    return "rejected";
  }

  let body: Uint8Array;
  try {
    body =
      signal === "metrics"
        ? serializeMetrics(batch.payload as MetricsBatchPayload)
        : serializeTraces(batch.payload as TracesBatchPayload);
  } catch (error) {
    // A batch this build cannot serialize is quarantined rather than retried forever. Other
    // valid batches for the same destination keep going.
    const detail = error instanceof Error ? error.message : String(error);
    telemetryTransaction((d) => {
      settleDelivery(d, batch.id, { state: "rejected", attempts, nextAttemptAt: now, lastError: detail }, now);
      recordGap(d, "unsupported_schema", `${profile}/${signal}: ${detail}`, now);
      releaseBatchPayload(d, batch.id);
    });
    return "rejected";
  }

  const outcome = await send(signalUrl(endpoint, signal), signal, body, profile, deps);
  return settle(profile, signal, batch, attempts, outcome, deps.now());
}

function settle(
  profile: TelemetryProfileId,
  signal: TelemetrySignal,
  batch: StoredBatch,
  attempts: number,
  outcome: TelemetryTransportOutcome,
  now: number,
): DeliveryStep {
  const nextAttempts = attempts + 1;
  return telemetryTransaction((d) => {
    if (outcome.kind === "accepted") {
      settleDelivery(
        d,
        batch.id,
        {
          state: "accepted",
          attempts: nextAttempts,
          nextAttemptAt: now,
          acceptedItems: Math.max(0, batch.itemCount - outcome.rejectedItems),
          rejectedItems: outcome.rejectedItems,
          lastError: outcome.message,
        },
        now,
      );
      // Release the payload: nothing local needs it once the destination has it, and holding a
      // second copy of every delivered batch is how a bounded budget stops being bounded.
      releaseBatchPayload(d, batch.id);
      updateDestination(d, profile, { lastAcceptedAt: now, lastError: outcome.message }, now);
      if (outcome.rejectedItems > 0) {
        // Partial success. The accepted half is NOT re-sent; only the accounting records the
        // refused items, because retrying the whole batch would double what already landed.
        recordGap(
          d,
          "permanently_rejected",
          `${profile}/${signal}: ${outcome.rejectedItems} item(s) refused by the backend`,
          now,
        );
      }
      return "accepted";
    }

    if (outcome.kind === "retry") {
      const delay = outcome.retryAfterMs ?? backoffMs(nextAttempts);
      settleDelivery(
        d,
        batch.id,
        {
          state: "retry",
          attempts: nextAttempts,
          nextAttemptAt: now + delay,
          lastError: outcome.detail,
        },
        now,
      );
      updateDestination(d, profile, { lastError: outcome.detail }, now);
      // Persistent throttling stops being a transient condition at some point. Pause visibly
      // rather than hammering an endpoint that has told us ten times to go away.
      //
      // Keyed on the destination having THROTTLED us, not on that particular response having
      // carried `Retry-After`. Plenty of backends return a bare 429 or 503 under sustained
      // load, and requiring the header meant those were retried for ever with `pausedReason`
      // stuck at null - the one field an operator is told to check.
      //
      // Deliberately not attempt count alone: a plain network failure retries through this
      // same branch, and an outage is not a reason to pause. Pausing would stop the backlog
      // draining by itself when the link comes back.
      if (outcome.throttled && nextAttempts >= QUOTA_PAUSE_AFTER) {
        updateDestination(d, profile, { pausedReason: "quota" }, now);
      }
      return "retry";
    }

    if (outcome.kind === "paused") {
      settleDelivery(
        d,
        batch.id,
        {
          state: "retry",
          attempts: nextAttempts,
          nextAttemptAt: now + TELEMETRY_LIMITS.retryMaxMs,
          lastError: outcome.detail,
        },
        now,
      );
      updateDestination(d, profile, { pausedReason: outcome.reason, lastError: outcome.detail }, now);
      return "paused";
    }

    settleDelivery(
      d,
      batch.id,
      { state: "rejected", attempts: nextAttempts, nextAttemptAt: now, lastError: outcome.detail },
      now,
    );
    recordGap(d, "permanently_rejected", `${profile}/${signal}: ${outcome.detail}`, now);
    releaseBatchPayload(d, batch.id);
    updateDestination(d, profile, { lastError: outcome.detail }, now);
    return "rejected";
  });
}

/** Jittered exponential backoff between the configured floor and ceiling. */
export function backoffMs(attempts: number, random = Math.random): number {
  const base = Math.min(
    TELEMETRY_LIMITS.retryMaxMs,
    TELEMETRY_LIMITS.retryMinMs * 2 ** Math.max(0, attempts - 1),
  );
  const jitter = base * 0.25 * (random() * 2 - 1);
  return Math.max(TELEMETRY_LIMITS.retryMinMs, Math.round(base + jitter));
}

/**
 * One OTLP/HTTP request, with the credential rules enforced at the wire boundary.
 *
 * Redirects are followed manually and the credential is dropped the moment the destination
 * stops being the one the operator configured. A redirect is not authorization to hand a token
 * to a new host; the resulting refusal is the correct, visible outcome.
 */
export async function send(
  url: string,
  signal: TelemetrySignal,
  body: Uint8Array,
  profile: TelemetryProfileId,
  deps: DeliveryDeps,
): Promise<TelemetryTransportOutcome> {
  const secret = telemetryTransaction((d) => getSecret(d, profile));
  let target = url;
  let carryCredential = secret !== null;
  const started = deps.now();

  for (let hop = 0; hop <= 3; hop += 1) {
    const headers: Record<string, string> = {
      "content-type": OTLP_PROTOBUF_CONTENT_TYPE,
      accept: OTLP_PROTOBUF_CONTENT_TYPE,
    };
    if (secret && carryCredential) headers[secret.headerName.toLowerCase()] = secret.headerValue;

    let response: Response;
    try {
      response = await deps.fetch(target, {
        method: "POST",
        headers,
        // Re-wrapped so the view is backed by its own exactly sized ArrayBuffer, which is what
        // `BodyInit` accepts. The copy is once per send, on a payload already capped at 1 MiB.
        body: new Uint8Array(body),
        redirect: "manual",
        // The per-request ceiling, plus shutdown's ability to cut it short. Whichever fires
        // first ends the request; neither can be defeated by the other being generous.
        signal: deps.abort
          ? AbortSignal.any([deps.abort, AbortSignal.timeout(TELEMETRY_LIMITS.requestTimeoutMs)])
          : AbortSignal.timeout(TELEMETRY_LIMITS.requestTimeoutMs),
      });
    } catch (error) {
      // Network failure or an ambiguous disconnect. Retryable, and NOT assumed unaccepted: the
      // server may have taken it, which is why the same immutable batch is what gets re-sent.
      const detail = error instanceof Error ? error.name : "network error";
      return {
        kind: "retry",
        retryAfterMs: null,
        throttled: false,
        detail: `${detail} to ${safeEndpointLabel(target)}`,
      };
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        return { kind: "rejected", detail: `redirect with no location from ${safeEndpointLabel(target)}` };
      }
      carryCredential = carryCredential && credentialSurvivesRedirect(target, location);
      target = new URL(location, target).toString();
      continue;
    }

    return classify(response, signal, started, deps.now());
  }

  return { kind: "rejected", detail: "too many redirects" };
}

async function classify(
  response: Response,
  signal: TelemetrySignal,
  startedAt: number,
  finishedAt: number,
): Promise<TelemetryTransportOutcome> {
  void startedAt;
  void finishedAt;
  const { status } = response;

  if (status >= 200 && status < 300) {
    const buffer = new Uint8Array(await response.arrayBuffer().catch(() => new ArrayBuffer(0)));
    const partial =
      signal === "metrics" ? readMetricsPartialSuccess(buffer) : readTracesPartialSuccess(buffer);
    return { kind: "accepted", rejectedItems: partial.rejectedItems, message: partial.message };
  }

  if (status === 401 || status === 403) {
    return authOrConfig(status, "auth");
  }
  if (status === 404 || status === 405 || status === 415) {
    return authOrConfig(status, "configuration");
  }
  if (status === 429 || status === 503) {
    // The destination asking us to slow down, with or without a `Retry-After` to say for how long.
    return {
      kind: "retry",
      retryAfterMs: retryAfterMs(response),
      throttled: true,
      detail: `HTTP ${status}`,
    };
  }
  if (status === 408 || status >= 500) {
    // A server fault rather than a throttle. Retried, but never a reason to pause: there is
    // nothing for an operator to fix at this end.
    return {
      kind: "retry",
      retryAfterMs: retryAfterMs(response),
      throttled: false,
      detail: `HTTP ${status}`,
    };
  }
  if (status === 413) {
    return { kind: "rejected", detail: "HTTP 413: the request exceeded the endpoint's size limit" };
  }
  // Everything else in 4xx is a permanent payload or schema rejection. Quarantine this batch;
  // unrelated valid batches for the same destination keep flowing.
  return { kind: "rejected", detail: `HTTP ${status}` };
}

function authOrConfig(status: number, reason: TelemetryPauseReason): TelemetryTransportOutcome {
  return {
    kind: "paused",
    reason,
    detail:
      reason === "auth"
        ? `HTTP ${status}: the endpoint refused this credential`
        : `HTTP ${status}: the endpoint did not accept an OTLP/HTTP request here`,
  };
}

/** OTLP honours `Retry-After` in both its seconds and HTTP-date forms. */
function retryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(TELEMETRY_LIMITS.retryMaxMs, Math.round(seconds * 1000));
  }
  const when = Date.parse(header);
  if (Number.isFinite(when)) {
    return Math.max(0, Math.min(TELEMETRY_LIMITS.retryMaxMs, when - Date.now()));
  }
  return null;
}
