/**
 * `capture` - the one entry point a source owner calls.
 *
 * Three promises hold this whole design together and all three are enforced here:
 *
 * 1. **Accepted means committed.** This function returns `accepted` only after a journal row
 *    is durably written. Nothing downstream can weaken that into "queued in memory".
 * 2. **No network I/O.** Capture touches SQLite and returns. The exporter runs on its own
 *    schedule, so a dead endpoint cannot make a business operation slow or fail.
 * 3. **A telemetry failure never rewrites a business result.** Every path returns a refusal
 *    value; nothing throws out of here. The caller has already done its real work.
 *
 * The pre-acceptance gap is explicit and is not closed by this function: a crash between a
 * successful business commit and this call loses the fact. Closing it would mean attaching
 * telemetry to every business transaction, which P1 rejects, and the honest alternative is to
 * measure the gap rather than claim it away - see `telemetry_gaps`.
 */
import { z } from "zod";
import {
  SYSTEM_ACTOR,
  TELEMETRY_ENVELOPE_VERSION,
  TELEMETRY_LIMITS,
  type TelemetryActor,
  type TelemetryCaptureResult,
  type TelemetryProfileId,
  type TelemetrySourceIdentity,
} from "@shared/telemetry.ts";
import type { TelemetryEventDefinition } from "@shared/telemetry-catalog.ts";
import { TELEMETRY_EVENTS } from "@shared/telemetry-catalog.ts";
import { SERVICE_VERSION } from "../version.ts";
import { envVar } from "../config.ts";
import {
  capturingProfiles,
  getTelemetryConfig,
  telemetryIdentity,
} from "./config.ts";
import { eventIdFor, newSpanId, newTraceId } from "./identity.ts";
import {
  appendJournal,
  getDestination,
  putContext,
  putResource,
  recordGap,
  telemetryTransaction,
  usedBytes,
} from "./store.ts";

/**
 * Reserved ref keys the facility writes itself.
 *
 * Exempt from an event's declared `refKeys` allowlist because a caller never supplies them:
 * they are the correlation identity this capture minted, and they are what lets the probe hand
 * an operator a trace id to search for before the span has even been serialized.
 */
export const TRACE_REF = "__trace_id";
export const SPAN_REF = "__span_id";
export const PARENT_SPAN_REF = "__parent_span_id";
const RESERVED_REFS = new Set([TRACE_REF, SPAN_REF, PARENT_SPAN_REF]);

export interface CaptureRequest<Facts extends z.ZodTypeAny> {
  event: TelemetryEventDefinition<Facts>;
  /** The authoritative identity this fact dedupes on. */
  source: TelemetrySourceIdentity;
  facts: z.input<Facts>;
  /** When the business thing happened. Defaults to now; a reconciled fact passes the real time. */
  occurredAt?: number;
  actor?: TelemetryActor;
  /** Opaque internal correlation ids, filtered against the event's `refKeys`. */
  refs?: Record<string, string>;
  /**
   * Extra immutable context attributes, content-addressed alongside the standing ones.
   * Bounded and minimized like everything else; this is not a place to put an object.
   */
  context?: Record<string, string>;
  /** Correlate this fact into an existing trace instead of starting one. */
  trace?: { traceId: string; parentSpanId: string | null };
  now?: number;
}

/**
 * The standing resource attributes for this process.
 *
 * Deliberately small and deliberately stable: this map IS the OTLP resource identity, so every
 * key added here multiplies series when its value changes. `service.instance.id` is the
 * installation pseudonym rather than a hostname, because a hostname is operator data.
 */
export function resourceAttributes(): Record<string, string> {
  const identity = telemetryIdentity();
  return {
    "service.name": "mission-control",
    "service.version": SERVICE_VERSION,
    "service.instance.id": identity.installationId,
    "mission.identity.epoch": String(identity.epoch),
    // P5 requires an explicit environment marker so demo, development and test signals can be
    // kept out of adoption. Default `local`, because that is what an ordinary install is.
    // Bounded like any other string: this is operator-supplied and lands in the resource of
    // EVERY batch, so an unbounded value would be paid for on every request rather than once.
    "deployment.environment.name": boundString(envVar("TELEMETRY_ENVIRONMENT") ?? "local"),
  };
}

/**
 * Capture one accepted semantic fact.
 *
 * Returns rather than throws, always. A source hook sees accepted, duplicate, disabled or
 * refused - never an exporter exception, and never a storage stack trace.
 */
export function captureTelemetry<Facts extends z.ZodTypeAny>(
  request: CaptureRequest<Facts>,
): TelemetryCaptureResult {
  const now = request.now ?? Date.now();
  try {
    const definition = TELEMETRY_EVENTS[request.event.name];
    if (!definition || definition !== (request.event as TelemetryEventDefinition)) {
      // A caller holding a definition this build does not have registered is a build defect,
      // not a runtime condition. Refuse rather than invent a catalog entry for it.
      return {
        kind: "refused",
        reason: "unknown_event",
        detail: `${request.event.name} is not a registered telemetry event`,
      };
    }

    const config = getTelemetryConfig();
    if (!config.enabled) return { kind: "disabled" };

    const eligible = capturingProfiles(config).filter((p) => definition.audience.includes(p));
    if (eligible.length === 0) {
      return { kind: "refused", reason: "not_eligible", detail: "no profile admits this event" };
    }

    const parsed = definition.facts.safeParse(request.facts);
    if (!parsed.success) {
      // The strict schema is what stops an internal Session or exception object being spread
      // into an envelope, so a failure here is exactly the case worth refusing loudly.
      return {
        kind: "refused",
        reason: "invalid_facts",
        detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.code}`).join("; "),
      };
    }
    const facts = truncateStrings(parsed.data as Record<string, unknown>);

    const { refs, omitted } = boundRefs(request.refs ?? {}, definition.refKeys);
    const traceId = request.trace?.traceId ?? newTraceId();
    const spanId = newSpanId();
    refs[TRACE_REF] = traceId;
    refs[SPAN_REF] = spanId;
    if (request.trace?.parentSpanId) refs[PARENT_SPAN_REF] = request.trace.parentSpanId;

    const occurredAt = request.occurredAt ?? now;
    const actor = request.actor ?? SYSTEM_ACTOR;
    const bytes = Buffer.byteLength(JSON.stringify({ facts, refs }), "utf8");
    if (bytes > TELEMETRY_LIMITS.maxEventBytes) {
      recordCaptureGap(`${definition.name} exceeded ${TELEMETRY_LIMITS.maxEventBytes} bytes`, now);
      return { kind: "refused", reason: "too_large", detail: "event payload over the byte limit" };
    }

    return telemetryTransaction((d) => {
      // Admission control. At the absolute cap even high-priority capture fails, and it fails
      // here - visibly, with a counted gap - rather than by growing the file past the number
      // the operator was shown.
      if (usedBytes(d) + bytes > TELEMETRY_LIMITS.maxTotalBytes) {
        recordGap(d, "capture_refused", `over capacity: ${definition.name}`, now);
        return { kind: "refused", reason: "over_capacity", detail: "telemetry store is full" };
      }

      const resourceId = putResource(d, resourceAttributes(), now);
      const contextId = putContext(d, { ...request.context }, now);
      const epochs: Record<string, number> = {};
      for (const profile of eligible) epochs[profile] = getDestination(d, profile).policyEpoch;

      const eventId = eventIdFor(request.source, "journal");
      const appended = appendJournal(d, {
        eventId,
        envelopeVersion: TELEMETRY_ENVELOPE_VERSION,
        name: definition.name,
        eventVersion: definition.version,
        source: request.source,
        occurredAt,
        observedAt: now,
        resourceId,
        contextId,
        actor,
        refs,
        refsOmitted: omitted,
        facts,
        profiles: eligible as TelemetryProfileId[],
        epochs,
        bytes,
      });
      if (appended.kind === "duplicate") return { kind: "duplicate", eventId: appended.eventId };
      // Returned with the acceptance rather than parked in a module slot for the caller to read
      // back: a shared slot would make a caller's own trace id depend on whether anything else
      // captured in between.
      return { kind: "accepted", eventId, seq: appended.seq, correlation: { traceId, spanId } };
    });
  } catch (error) {
    // The containment boundary. Whatever went wrong in here, the caller's business operation
    // already succeeded and must not learn about it.
    const detail = error instanceof Error ? error.message : String(error);
    recordCaptureGap(detail, now);
    return { kind: "refused", reason: "storage_error", detail };
  }
}

/**
 * Record that a capture was refused.
 *
 * Best-effort on purpose. If the disk failure that lost the record also prevents writing the
 * counter, recovery reports an UNKNOWN gap rather than a precise count - claiming exactness we
 * do not have is the one thing this table must never do.
 */
function recordCaptureGap(detail: string, now: number): void {
  try {
    telemetryTransaction((d) => recordGap(d, "capture_refused", detail, now));
  } catch {
    /* the gap about the gap; recovery reports it as unknown */
  }
}

function truncateStrings(facts: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(facts)) {
    out[key] = typeof value === "string" ? boundString(value) : value;
  }
  return out;
}

/**
 * Cut a string to the byte budget WITHOUT splitting a character.
 *
 * Measuring in bytes and then slicing by UTF-16 code units gets both halves wrong: for
 * multi-byte text the result can still exceed the budget, and a cut between the halves of a
 * surrogate pair produces a lone surrogate - an unpaired code unit that is not valid UTF-8, and
 * that a protobuf encoder or a backend is entitled to reject. One emoji in a fact is enough.
 *
 * Iterating the string yields whole code points, which is all that is needed to keep every
 * character intact on a path that runs at capture time.
 */
export function boundString(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= TELEMETRY_LIMITS.maxStringBytes) return value;
  const ellipsis = "…";
  const budget = TELEMETRY_LIMITS.maxStringBytes - Buffer.byteLength(ellipsis, "utf8");
  let used = 0;
  let cut = "";
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (used + size > budget) break;
    cut += character;
    used += size;
  }
  return `${cut}${ellipsis}`;
}

/**
 * Keep only refs the event declared, up to the limit, and carry the omitted count.
 *
 * Truncating links silently is how a denominator changes without anyone noticing, so the count
 * travels with the record.
 */
function boundRefs(
  refs: Record<string, string>,
  allowed: readonly string[],
): { refs: Record<string, string>; omitted: number } {
  const out: Record<string, string> = {};
  let omitted = 0;
  for (const [key, value] of Object.entries(refs)) {
    if (RESERVED_REFS.has(key)) continue;
    if (!allowed.includes(key)) {
      omitted += 1;
      continue;
    }
    if (Object.keys(out).length >= TELEMETRY_LIMITS.maxRefs) {
      omitted += 1;
      continue;
    }
    out[key] = boundString(value);
  }
  return { refs: out, omitted };
}
