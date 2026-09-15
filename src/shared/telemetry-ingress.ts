/**
 * The browser's one way into the telemetry facility, and the operation context that travels
 * with an ordinary dashboard request.
 *
 * Two contracts, in one file because they are halves of the same claim. The dashboard is not
 * trusted: it runs in a page an operator can open a console on, and anything it sends about
 * itself is an ASSERTION. So the ingress admits only catalog entries that were declared
 * browser-eligible, only inside a bounded envelope, and only at a bounded rate - and the
 * operation context it attaches is recorded as attribution with its own basis attached, never
 * as a claim the daemon acts on.
 *
 * Nothing here may import `node:` anything: the browser reads it to compose a request and the
 * daemon reads it to refuse one, and a second copy of the limits is how those two drift apart.
 *
 * Design source: docs/plans/opentelemetry-integration/p4-interactions-errors-settings/plan.md.
 * Phase 2 owns this boundary; Phase 5 adds the callers that use it, by declaring more
 * browser-eligible catalog entries rather than by adding a second endpoint.
 */
import { z } from "zod";
import {
  TELEMETRY_ACTOR_KINDS,
  type TelemetryActor,
  type TelemetryActorBasis,
} from "./telemetry.ts";

// ---- operation context ----
//
// An APP-ISSUED logical operation id: one id per thing a person asked for, which survives the
// HTTP retries and SSE replays that would otherwise each look like another action. It is
// deliberately not a request id - the repository already has those, per-route and in the body,
// for idempotency - and it does not replace one.

/** The logical operation this request belongs to. Opaque, bounded, minted by the dashboard. */
export const OPERATION_ID_HEADER = "x-mission-operation-id";
/** Which surface issued it. A closed vocabulary, so it can be recorded without unbounding anything. */
export const OPERATION_SURFACE_HEADER = "x-mission-operation-surface";
/** What the caller says it is. Recorded as a CLAIM; the basis below says how much it is worth. */
export const OPERATION_ACTOR_HEADER = "x-mission-operation-actor";

/**
 * Where a logical operation came from.
 *
 * Closed rather than free text, because Phase 5 will want it as a metric dimension and a
 * surface name invented at a call site is exactly the unbounded label P0 forbids. Append-only:
 * a value may be added at the end, never renamed or removed.
 */
export const TELEMETRY_OPERATION_SURFACES = [
  "settings",
  "board",
  "console",
  "library",
  "runs",
  "dispatch",
  "files",
  "topbar",
  "unknown",
] as const;
export type TelemetryOperationSurface = (typeof TELEMETRY_OPERATION_SURFACES)[number];

/** Operation ids are opaque and fixed-width. Anything else is dropped rather than truncated. */
export const OPERATION_ID_PATTERN = /^[0-9a-z]{8,32}$/;

export function isOperationId(value: string): boolean {
  return OPERATION_ID_PATTERN.test(value);
}

export function isOperationSurface(value: string): value is TelemetryOperationSurface {
  return (TELEMETRY_OPERATION_SURFACES as readonly string[]).includes(value);
}

/**
 * The attribution a request carries, after the daemon has decided what to believe.
 *
 * `basis` is the whole point of the type. `app_context` means the dashboard issued this
 * operation through its own client, which is as strong a claim as an unauthenticated browser
 * can make; `declared` means something asserted an actor without that context; `unknown` means
 * nothing was said. None of the three is ever read by an authorization decision - see
 * `resolveOperationContext`.
 */
export interface TelemetryOperationContext {
  operationId: string | null;
  surface: TelemetryOperationSurface;
  actor: TelemetryActor;
}

/**
 * Decide what a set of request headers is worth.
 *
 * Pure and shared so the browser's own tests can assert the same answer the daemon gives. The
 * rules, in order of how much they matter:
 *
 *  1. `owner` is never reachable from a request. It is the basis the daemon uses for its own
 *     observations of itself, and a header that could mint one would make every other basis
 *     meaningless.
 *  2. A well-formed operation id plus a known surface earns `app_context`. That is what the
 *     dashboard's own client produces, and it is what links a browser fact to the server fact
 *     it caused.
 *  3. A declared actor kind without that context is recorded and marked `declared`. It stays
 *     VISIBLE rather than being dropped: "somebody said this was a human" is a different fact
 *     from "we do not know", and P0's acceptance gate requires the two stay distinguishable.
 *  4. Anything else is `unknown`, which is honest and is the default.
 */
export function resolveOperationContext(
  headers: { get(name: string): string | null },
  origin: TelemetryActor["origin"] = "dashboard",
): TelemetryOperationContext {
  const rawId = (headers.get(OPERATION_ID_HEADER) ?? "").trim();
  const rawSurface = (headers.get(OPERATION_SURFACE_HEADER) ?? "").trim();
  const rawActor = (headers.get(OPERATION_ACTOR_HEADER) ?? "").trim();

  const operationId = isOperationId(rawId) ? rawId : null;
  const surface = isOperationSurface(rawSurface) ? rawSurface : "unknown";
  const declaredKind = (TELEMETRY_ACTOR_KINDS as readonly string[]).includes(rawActor)
    ? (rawActor as TelemetryActor["kind"])
    : null;

  // `owner` is unreachable here by construction - there is no branch that produces it.
  let basis: TelemetryActorBasis = "unknown";
  if (operationId !== null && surface !== "unknown") basis = "app_context";
  else if (declaredKind !== null) basis = "declared";

  return {
    operationId,
    surface,
    actor: {
      // A dashboard request with app context is a person doing something in the app. Without
      // it we do not claim to know, and `unknown` is a real actor kind rather than a gap.
      kind: declaredKind ?? (basis === "app_context" ? "human" : "unknown"),
      origin,
      basis,
    },
  };
}

// ---- the typed browser ingress ----

/**
 * The bounds the ingress enforces, all of them small on purpose.
 *
 * A page can be reloaded in a loop and a console can post whatever it likes, so the endpoint's
 * safety comes from arithmetic rather than from good behavior: at most `maxRecordsPerMinute`
 * records are admitted per minute no matter how they are batched, and no single request can
 * cost more than `maxRequestBytes` to parse.
 */
export const TELEMETRY_INGRESS_LIMITS = {
  /** Records one request may carry. The dashboard sends one at a time; a batch is still bounded. */
  maxRecordsPerRequest: 8,
  /** Largest request body admitted, before parsing. */
  maxRequestBytes: 8 * 1024,
  /** Records admitted per rolling minute, across every browser talking to this daemon. */
  maxRecordsPerMinute: 120,
  /** The rolling window the limit above is measured over. */
  windowMs: 60_000,
  /** How far in the past a browser-supplied `occurredAt` may be before it is ignored. */
  maxClockSkewMs: 5 * 60_000,
} as const;

/**
 * One browser-originated fact.
 *
 * `strict`, like every event's own fact schema: an undeclared field is a rejection rather than
 * a passthrough, so a caller cannot spread a component's props into the envelope by accident.
 * There is no actor field - attribution comes from the request's operation context, never from
 * the body, because a body field would be a self-assertion with nothing behind it.
 */
export const TelemetryIngressRecordSchema = z
  .object({
    /** A catalog entry name, which must be declared browser-eligible. */
    event: z.string().min(1).max(128),
    /** When it happened in the page. Clamped to the daemon's clock; see `maxClockSkewMs`. */
    occurredAt: z.number().int().optional(),
    /** Validated by that entry's own strict schema, not by this one. */
    facts: z.record(z.unknown()).default({}),
  })
  .strict();
export type TelemetryIngressRecord = z.infer<typeof TelemetryIngressRecordSchema>;

export const TelemetryIngressRequestSchema = z
  .object({
    records: z.array(TelemetryIngressRecordSchema).min(1).max(TELEMETRY_INGRESS_LIMITS.maxRecordsPerRequest),
  })
  .strict();
export type TelemetryIngressRequest = z.infer<typeof TelemetryIngressRequestSchema>;

/**
 * Why one record was not admitted.
 *
 * Per record rather than per request, because a batch with one bad entry must not discard the
 * good ones - and because the browser needs to be able to tell "you are sending too fast" from
 * "that event does not exist" when a Phase 5 caller is being written.
 */
export const TELEMETRY_INGRESS_REJECTIONS = [
  "unknown_event",
  "not_browser_eligible",
  "invalid_facts",
  "too_large",
  "rate_limited",
  "disabled",
  "duplicate",
  "storage_error",
] as const;
export type TelemetryIngressRejection = (typeof TELEMETRY_INGRESS_REJECTIONS)[number];

/**
 * What the ingress route answers.
 *
 * Always a 200 with this body, even when everything in it was refused. The application action
 * that produced the record already succeeded, and a telemetry refusal that surfaced as an HTTP
 * error would be a browser console full of red over a fact nobody asked for.
 *
 * `accepted` counts records DURABLY COMMITTED. It is computed after the journal write, never
 * before, so a caller that does check the answer is being told the truth.
 */
export interface TelemetryIngressResult {
  accepted: number;
  rejected: { index: number; reason: TelemetryIngressRejection }[];
}
