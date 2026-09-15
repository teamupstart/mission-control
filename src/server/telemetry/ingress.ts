/**
 * The daemon half of the typed browser ingress.
 *
 * The dashboard is not a trusted source. It runs in a page anyone can open a console on, so
 * every record arriving here is an assertion, and the endpoint's job is to admit the small set
 * of assertions that are worth having while costing an attacker more than they gain:
 *
 *  - only catalog entries declared `ingress: "browser"` - which no page can widen, because the
 *    declaration lives in the catalog rather than at a call site;
 *  - only inside that entry's own strict fact schema, so an undeclared key is a rejection
 *    rather than a passthrough into the envelope;
 *  - only at a bounded rate, measured across every browser talking to this daemon, so a
 *    reload loop or a `for` loop in a console is arithmetic rather than an outage;
 *  - and never with an actor the body claims. Attribution comes from the request's operation
 *    context, with its basis attached, because a body field asserting `human` would be a claim
 *    with nothing behind it.
 *
 * Acceptance means the journal row is committed. `captureTelemetry` is the only path in, and it
 * returns after the durable write, so a record this route reports as accepted is one a restart
 * will still find. Phase 5 adds callers by declaring more browser-eligible catalog entries; it
 * does not add a second endpoint.
 */
import {
  TELEMETRY_INGRESS_LIMITS,
  type TelemetryIngressRecord,
  type TelemetryIngressRejection,
  type TelemetryIngressResult,
  type TelemetryOperationContext,
} from "@shared/telemetry-ingress.ts";
import { TELEMETRY_EVENTS } from "@shared/telemetry-catalog.ts";
import { captureTelemetry } from "./capture.ts";
import { newSpanId } from "./identity.ts";

/**
 * The rolling admission window.
 *
 * Module scope, because there is one telemetry facility per daemon process and the limit is
 * about the daemon, not about a connection: a page that opened eight tabs to get eight budgets
 * would have defeated a per-connection counter without trying.
 *
 * A plain array of timestamps rather than a token bucket. At 120 entries a minute the memory is
 * trivial and the behavior is exactly what the limit says it is - no refill rate to reason
 * about, and no way for a long quiet period to accumulate a burst allowance nobody asked for.
 */
let admitted: number[] = [];

/** Drop timestamps that have left the window, and report how many remain. */
function usedInWindow(now: number): number {
  const floor = now - TELEMETRY_INGRESS_LIMITS.windowMs;
  if (admitted.length > 0 && admitted[0]! <= floor) {
    admitted = admitted.filter((at) => at > floor);
  }
  return admitted.length;
}

/** Reset the window. Tests only - there is no operator reason to clear a rate limiter. */
export function resetIngressRateLimitForTesting(): void {
  admitted = [];
}

/**
 * Admit a batch of browser-originated records.
 *
 * Per record, never per request: a batch with one bad entry must not discard the good ones,
 * and the caller needs to be able to tell "too fast" from "that event does not exist" while a
 * later phase's caller is being written.
 */
export function admitBrowserTelemetry(
  records: TelemetryIngressRecord[],
  context: TelemetryOperationContext,
  now = Date.now(),
): TelemetryIngressResult {
  const result: TelemetryIngressResult = { accepted: 0, rejected: [] };

  for (const [index, record] of records.entries()) {
    const reason = admitOne(record, context, index, now);
    if (reason === null) result.accepted += 1;
    else result.rejected.push({ index, reason });
  }
  return result;
}

function admitOne(
  record: TelemetryIngressRecord,
  context: TelemetryOperationContext,
  index: number,
  now: number,
): TelemetryIngressRejection | null {
  const definition = TELEMETRY_EVENTS[record.event];
  if (!definition) return "unknown_event";
  // The allowlist, and the reason it is a catalog property: a daemon-owned event is not
  // reachable from a page at all, so a console cannot forge a daemon start, a workflow verdict
  // or an export probe by naming it here.
  if (definition.ingress !== "browser") return "not_browser_eligible";

  // Charged BEFORE the capture, and only for records that got as far as being plausible. A
  // rejected unknown name costs a map lookup, so counting it against the budget would let a
  // stream of nonsense names exhaust a real caller's allowance.
  if (usedInWindow(now) >= TELEMETRY_INGRESS_LIMITS.maxRecordsPerMinute) return "rate_limited";

  const captured = captureTelemetry({
    event: definition,
    /**
     * The dedupe identity, and the thing that makes a REPLAY different from a second action.
     *
     * Keyed on the app-issued operation id, so the same logical operation retried - an HTTP
     * retry, a resent beacon, a component that mounted twice - collapses to one fact. Without
     * an operation id there is nothing to dedupe on and nothing pretends otherwise: a fresh
     * identity is minted, which records the record and does not claim an idempotency the
     * request did not ask for. The index is included so a single request may legitimately
     * carry two different records for one operation.
     */
    source: {
      kind: "mission.dashboard",
      id: context.operationId
        ? `${definition.name}:${context.operationId}:${index}`
        : `${definition.name}:${now}:${newSpanId()}`,
      revision: 1,
    },
    actor: context.actor,
    facts: record.facts,
    occurredAt: clampOccurredAt(record.occurredAt, now),
    refs: context.operationId ? { operation_id: context.operationId } : {},
    now,
  });

  switch (captured.kind) {
    case "accepted":
      admitted.push(now);
      return null;
    // A duplicate is a REPLAY, not a failure, and it is reported as its own reason rather than
    // as an acceptance. Counting it as accepted would tell a caller its second attempt landed
    // a second fact; counting it as an error would make an ordinary retry look broken.
    case "duplicate":
      return "duplicate";
    case "disabled":
      return "disabled";
    case "refused":
      switch (captured.reason) {
        case "invalid_facts":
        case "unknown_event":
          return "invalid_facts";
        case "too_large":
          return "too_large";
        // `not_eligible` means no enabled profile admits this event - collection is on but this
        // audience is not. From the browser's side that is indistinguishable from disabled, and
        // it is not an error either way.
        case "not_eligible":
          return "disabled";
        case "over_capacity":
        case "storage_error":
          return "storage_error";
      }
  }
}

/**
 * What `occurredAt` the daemon will believe.
 *
 * A browser clock is the operator's clock, which can be wrong by years - and `occurredAt` is
 * what decides which retention window, which cohort and which dashboard range a fact lands in.
 * So a client time is honoured only when it is plausibly this moment: slightly in the past by
 * up to the skew budget, and never in the future. Anything else falls back to the daemon's own
 * clock, which is the same rule every other source in this facility already follows by having
 * no other option.
 */
function clampOccurredAt(occurredAt: number | undefined, now: number): number {
  if (occurredAt === undefined) return now;
  if (!Number.isSafeInteger(occurredAt)) return now;
  if (occurredAt > now) return now;
  if (occurredAt < now - TELEMETRY_INGRESS_LIMITS.maxClockSkewMs) return now;
  return occurredAt;
}
