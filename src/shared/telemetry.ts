/**
 * The browser-safe half of Mission Control's general telemetry facility.
 *
 * This file owns the DOMAIN and CONTROL contract - the envelope every captured fact is shaped
 * like, the profile/audience partition every record is fenced by, the bounded limits the
 * daemon enforces, and the health/readiness view a settings panel reads. The catalog of
 * concrete events and instruments lives beside it in `telemetry-catalog.ts`; the daemon-only
 * journal, projection, outbox and exporter live under `src/server/telemetry/`.
 *
 * Nothing here may import `node:` anything. The Phase 2 Settings UI and the Phase 7 dashboard
 * checks both read these types in the browser.
 *
 * Design source: docs/plans/opentelemetry-integration/p0-data-contract/plan.md and
 * p1-durable-export/plan.md. Phase 1 implements the contract; later phases add sources and
 * projections through the registration seams without changing what is written here.
 */
import { z } from "zod";

/**
 * The domain envelope's schema revision.
 *
 * Bumped when the envelope itself changes shape, never when one event gains a fact - an event
 * carries its own version for that. A journal row written by a newer build is quarantined
 * rather than guessed at, so this number is what a downgrade reads to know it cannot
 * interpret a record.
 */
export const TELEMETRY_ENVELOPE_VERSION = 1;

/**
 * The metric catalog's revision. Changing an instrument's MEANING gets a new instrument, so
 * this moves only when the catalog gains or retires entries. Queued batches carry the value
 * that created them, which is what stops a replay after an upgrade from being re-aggregated
 * under today's rules.
 */
export const TELEMETRY_CATALOG_VERSION = 1;

/** The audience-policy revision. A record carries the policy epoch that admitted it. */
export const TELEMETRY_AUDIENCE_POLICY_VERSION = 1;

// ---- actor and origin ----
//
// Attribution, never authorization. No permission decision anywhere in the daemon may start
// reading these: a dashboard operation context is application-level provenance, not proof of
// a person. P4 and Phase 5 own propagating richer context into them.

/**
 * Who a fact is attributed to.
 *
 * APPEND-ONLY. These ids are persisted in journal rows and exported as metric dimensions, so
 * a value may be added at the end and never renamed, reordered or removed.
 *
 * `system` is Phase 1's one addition to P0's proposed list, and it exists to protect P0's own
 * acceptance gate: a daemon lifecycle observation has no actor in P0's sense, and the nearest
 * listed value - `unknown` - already means "we could not tell", which gate 5 requires stay
 * distinguishable from confirmed automation. Folding the daemon's own start into `unknown`
 * would have made every installation look like it had ambiguous activity on every boot.
 */
export const TELEMETRY_ACTOR_KINDS = [
  "human",
  "agent",
  "foreman",
  "workflow",
  "scheduler",
  "recovery",
  "unknown",
  "system",
] as const;
export type TelemetryActorKind = (typeof TELEMETRY_ACTOR_KINDS)[number];

/** Which surface a fact arrived through. Append-only for the reason above. */
export const TELEMETRY_ORIGINS = [
  "dashboard",
  "mcp",
  "cli",
  "daemon",
  "external_observation",
  "unknown",
] as const;
export type TelemetryOrigin = (typeof TELEMETRY_ORIGINS)[number];

/** How strongly the actor is known. Append-only for the reason above. */
export const TELEMETRY_ACTOR_BASES = [
  "owner",
  "app_context",
  "declared",
  "inferred",
  "unknown",
] as const;
export type TelemetryActorBasis = (typeof TELEMETRY_ACTOR_BASES)[number];

export const TelemetryActorSchema = z.object({
  kind: z.enum(TELEMETRY_ACTOR_KINDS),
  origin: z.enum(TELEMETRY_ORIGINS),
  basis: z.enum(TELEMETRY_ACTOR_BASES),
});
export type TelemetryActor = z.infer<typeof TelemetryActorSchema>;

/** The attribution the daemon's own observations of itself carry. */
export const SYSTEM_ACTOR: TelemetryActor = {
  kind: "system",
  origin: "daemon",
  basis: "owner",
};

// ---- profiles (audiences) ----
//
// Three independent destinations with independent opt-ins, identities, consent epochs and
// queues. `local` has no endpoint at all and is what "collection enabled, nothing configured"
// means; `user` is the operator's own backend; `product` is the minimized public audience,
// which no installation can enable until the separately scoped ingest service exists.

export const TELEMETRY_PROFILE_IDS = ["local", "user", "product"] as const;
export type TelemetryProfileId = (typeof TELEMETRY_PROFILE_IDS)[number];

/** Which profiles a catalog entry may reach. A subset is a narrowing, never a widening. */
export type TelemetryAudience = readonly TelemetryProfileId[];

/** Every audience, including the minimized product one. */
export const AUDIENCE_ALL: TelemetryAudience = TELEMETRY_PROFILE_IDS;
/** Local capture and the operator's own backend, but never the product audience. */
export const AUDIENCE_OPERATOR: TelemetryAudience = ["local", "user"];
/** Local capture only - diagnostics with no meaning off this machine. */
export const AUDIENCE_LOCAL: TelemetryAudience = ["local"];

// ---- signal kinds ----

export const TELEMETRY_SIGNALS = ["metrics", "traces"] as const;
export type TelemetrySignal = (typeof TELEMETRY_SIGNALS)[number];

// ---- bounded limits ----
//
// P0 and P1's candidate limits, promoted to enforced constants by Phase 1 and measured in
// docs/observability.md. They live in shared code deliberately: the exporter enforces them and
// the Settings UI explains them, and a second copy is how those two drift apart.

export const TELEMETRY_LIMITS = {
  /** Longest ordinary attribute string before truncation. Truncation is recorded, not silent. */
  maxStringBytes: 256,
  /** Largest canonical event payload admitted into the journal. */
  maxEventBytes: 16 * 1024,
  /** Most `refs` links one event may carry; the omitted count travels with it. */
  maxRefs: 64,
  /** Distinct dimension combinations per instrument before values fold into overflow. */
  maxSeriesPerInstrument: 2_000,
  /** Distinct dimension combinations across one profile before new ones fold into overflow. */
  maxSeriesPerProfile: 10_000,
  /** Total logical bytes across contexts, journal, series, batches and delivery state. */
  maxTotalBytes: 256 * 1024 * 1024,
  /** How long a retained journal or batch payload may live. The stricter of age and bytes wins. */
  payloadRetentionMs: 7 * 24 * 60 * 60 * 1000,
  /**
   * How long minimal dedupe and reducer state lives after its payload is pruned.
   *
   * Longer than the payload window on purpose: P5's rolling cohorts need a 30-day lookback
   * that a seven-day unsent-payload queue cannot provide, and widening the payload window to
   * cover it would multiply the byte budget to keep a handful of small rows.
   */
  reducerStateRetentionMs: 30 * 24 * 60 * 60 * 1000,
  /** Largest serialized OTLP request. Batches are built under this rather than split after. */
  maxRequestBytes: 1024 * 1024,
  /** Per-request wall clock before an attempt is treated as an ambiguous disconnect. */
  requestTimeoutMs: 10_000,
  /** One in-flight request per destination and signal. */
  maxInFlightPerDestination: 1,
  /** Retry backoff floor and ceiling, before jitter and before any server `Retry-After`. */
  retryMinMs: 1_000,
  retryMaxMs: 60_000,
  /** How long a delivery lease is honoured before another pass may reclaim it. */
  leaseMs: 60_000,
  /** How many journal rows one projection pass consumes. Bounds the transaction, not the day. */
  projectionBatchSize: 256,
  /** How many batches one delivery pass drains, so an overnight backlog cannot saturate. */
  deliveryBatchesPerTick: 8,
} as const;

/** The sentinel a dimension value folds into once an instrument exceeds its series budget. */
export const TELEMETRY_OVERFLOW_VALUE = "__overflow__";
/** The sentinel for a dimension whose real value was never observed. */
export const TELEMETRY_UNKNOWN_VALUE = "unknown";

// ---- the domain envelope ----

/**
 * One accepted semantic fact.
 *
 * `occurredAt` is when the business thing happened and never moves; `observedAt` is when
 * telemetry saw it. A replay after an upgrade re-sends the original pair, which is what keeps
 * old work out of a new release's cohort.
 */
export const TelemetryEnvelopeSchema = z.object({
  envelopeVersion: z.literal(TELEMETRY_ENVELOPE_VERSION),
  /** Stable within one audience and configuration epoch; a retry reuses it, a replay does not mint one. */
  eventId: z.string().min(1),
  /** A catalog entry name. A caller cannot invent one - see `telemetry-catalog.ts`. */
  name: z.string().min(1),
  /** That catalog entry's own revision at capture time. */
  eventVersion: z.number().int().min(1),
  occurredAt: z.number().int(),
  observedAt: z.number().int(),
  /** Content-addressed immutable resource identity (service name, version, instance). */
  resourceId: z.string().min(1),
  /** Content-addressed immutable execution and association context. */
  contextId: z.string().min(1),
  actor: TelemetryActorSchema,
  /** Opaque correlation ids. Translated to destination-scoped ids before export. */
  refs: z.record(z.string()).default({}),
  /** How many refs were dropped to stay inside `maxRefs`. */
  refsOmitted: z.number().int().min(0).default(0),
  /** The event-specific facts, validated by that entry's own schema. */
  facts: z.record(z.unknown()).default({}),
});
export type TelemetryEnvelope = z.infer<typeof TelemetryEnvelopeSchema>;

/**
 * The authoritative identity a capture dedupes on.
 *
 * A workflow attempt completion is identified by its owner's durable id and semantic
 * revision, never by arrival time or model output text. An amendment is a new revision and
 * therefore a new fact; it never mutates an already delivered historical event.
 */
export interface TelemetrySourceIdentity {
  /** Namespaced owner, e.g. `mission.daemon`. */
  kind: string;
  /** The owner's own durable id for the thing that happened. */
  id: string;
  /** The semantic revision of that thing. */
  revision: number;
}

// ---- capture results ----
//
// A source hook sees one of these. It never sees an exporter exception, and a telemetry
// failure never rewrites a successful business result.

/**
 * The correlation ids a capture minted, returned WITH the acceptance.
 *
 * On the result rather than in a "last capture" slot the caller reads afterwards. A shared slot
 * makes a caller's own trace id a function of whether anything else captured in between, which
 * is a race nobody writing a source hook should have to think about.
 */
export interface TelemetryCorrelation {
  traceId: string;
  spanId: string;
}

export type TelemetryCaptureResult =
  | { kind: "accepted"; eventId: string; seq: number; correlation: TelemetryCorrelation }
  | { kind: "duplicate"; eventId: string }
  | { kind: "disabled" }
  | { kind: "refused"; reason: TelemetryRefusalReason; detail: string };

export const TELEMETRY_REFUSAL_REASONS = [
  "unknown_event",
  "invalid_facts",
  "too_large",
  "over_capacity",
  "not_eligible",
  "storage_error",
] as const;
export type TelemetryRefusalReason = (typeof TELEMETRY_REFUSAL_REASONS)[number];

// ---- delivery vocabulary ----

export const TELEMETRY_DELIVERY_STATES = [
  "pending",
  "leased",
  "retry",
  "accepted",
  "rejected",
  "expired",
] as const;
export type TelemetryDeliveryState = (typeof TELEMETRY_DELIVERY_STATES)[number];

/**
 * Why a destination stopped on its own. Phase 2's Settings surface renders these directly, so
 * they are a closed vocabulary rather than free text.
 */
export const TELEMETRY_PAUSE_REASONS = ["auth", "configuration", "payload", "quota"] as const;
export type TelemetryPauseReason = (typeof TELEMETRY_PAUSE_REASONS)[number];

/** How one send attempt ended, before any local bookkeeping. */
export type TelemetryTransportOutcome =
  | { kind: "accepted"; rejectedItems: number; message: string | null }
  | {
      kind: "retry";
      retryAfterMs: number | null;
      /**
       * True when the DESTINATION asked us to slow down (429 or 503), as opposed to our not
       * being able to reach it at all. Persistent throttling pauses the destination; a network
       * outage does not, because pausing would stop the backlog draining when the link returns.
       */
      throttled: boolean;
      detail: string;
    }
  | { kind: "paused"; reason: TelemetryPauseReason; detail: string }
  | { kind: "rejected"; detail: string };

// ---- configuration ----

/**
 * One export destination.
 *
 * `endpoint` is a base URL; per-signal paths are resolved from it once. A credential is NOT
 * here - it lives in a daemon-owned secret table keyed by profile, so a settings snapshot, a
 * config API read and an export batch payload can none of them carry one.
 */
export const TelemetryDestinationSchema = z.object({
  /** Export is attempted only when this is true AND `endpoint` is set. */
  enabled: z.boolean().default(false),
  endpoint: z.string().default(""),
  /** Which header the stored secret is sent as, when one exists. */
  headerName: z.string().default("authorization"),
  /** Pausing keeps capture running and drains nothing. Distinct from disabling. */
  paused: z.boolean().default(false),
});
export type TelemetryDestination = z.infer<typeof TelemetryDestinationSchema>;

/**
 * The persisted telemetry configuration. Every default is off, and that is the upgrade
 * contract: an existing database opens with collection disabled and no endpoint, and nothing
 * is captured until an operator says so.
 */
export const TelemetryConfigSchema = z.object({
  /** The master switch. Off means no journal row is ever written. */
  enabled: z.boolean().default(false),
  /**
   * The operator's own backend.
   *
   * Independent of `product` in every way that matters: separate opt-in, separate identity,
   * separate queue, separate consent epoch and separate failure handling.
   */
  user: TelemetryDestinationSchema.default({}),
  /**
   * The minimized product audience.
   *
   * Shipped unavailable rather than merely off: the public ingest service is separately
   * scoped and does not exist, so `productEnrollment` reports `unavailable` and the daemon
   * refuses to enable it. Presenting it as ready would be the dishonest option.
   */
  product: TelemetryDestinationSchema.default({}),
});
export type TelemetryConfig = z.infer<typeof TelemetryConfigSchema>;

export const TelemetryConfigPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    user: TelemetryDestinationSchema.partial().optional(),
    product: TelemetryDestinationSchema.partial().optional(),
    /**
     * The operator's credential for their own backend, or the empty string to clear it.
     *
     * Write-only by construction: it is stored in the secret table and no read path returns
     * it. `undefined` leaves whatever is stored alone, so a config PUT that does not mention
     * it cannot silently erase one.
     */
    userCredential: z.string().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: "empty telemetry config update" });
export type TelemetryConfigPatch = z.infer<typeof TelemetryConfigPatchSchema>;

/**
 * Whether this installation can enable the product audience at all.
 *
 * `unavailable` in every shipped build, because the public ingest service is separately scoped
 * and does not exist. A union rather than a boolean because Phase 2 renders the reason, and
 * because a later enrollment service adds its own states here without changing what this field
 * means.
 */
export const TELEMETRY_PRODUCT_ENROLLMENTS = ["unavailable", "available"] as const;
export type TelemetryProductEnrollment = (typeof TELEMETRY_PRODUCT_ENROLLMENTS)[number];

// ---- health and readiness ----
//
// The bounded view Phase 1 exposes for the walking slice and Phase 2 renders in Settings.
// Everything here is a count, an age or a closed enum: no endpoint credential, no payload and
// no entity identity.

export interface TelemetryProfileHealth {
  profile: TelemetryProfileId;
  /** Capture eligibility - collection on, and this profile opted in. */
  capturing: boolean;
  /** Export eligibility - capturing, plus an endpoint, enabled and not paused. */
  exporting: boolean;
  /** Set when the daemon stopped this destination on its own. */
  pausedReason: TelemetryPauseReason | null;
  /** Bumped by every endpoint change, so old batches can never silently move. */
  destinationGeneration: number;
  /** Bumped by every consent transition, so a new opt-in starts a new metric baseline. */
  policyEpoch: number;
  pending: number;
  retrying: number;
  accepted: number;
  rejected: number;
  expired: number;
  /** Age in ms of the oldest undelivered batch, or null when the queue is empty. */
  oldestPendingAgeMs: number | null;
  pendingBytes: number;
  /** Bounded, sanitized last failure. Never a response body or a URL carrying a credential. */
  lastError: string | null;
  lastAcceptedAt: number | null;
}

export interface TelemetryHealth {
  enabled: boolean;
  /**
   * This installation's pseudonym, as exported in `service.instance.id`.
   *
   * Reported because an operator cannot otherwise filter their own dashboards to their own
   * installation: the value is a local random seed with no other way to discover it. It is not
   * a secret - every exported sample already carries it - and it identifies an installation
   * epoch, never a person.
   */
  installationId: string;
  identityEpoch: number;
  envelopeVersion: number;
  catalogVersion: number;
  audiencePolicyVersion: number;
  productEnrollment: TelemetryProductEnrollment;
  /** Journal rows admitted but not yet projected. Zero is the steady state. */
  journalBacklog: number;
  /** Total logical bytes charged against `TELEMETRY_LIMITS.maxTotalBytes`. */
  usedBytes: number;
  maxBytes: number;
  /**
   * Bounded record of what could NOT be recorded: refusals, expiries, quarantines, and the
   * unknown gap that a failed drop-counter write leaves behind.
   */
  gaps: TelemetryGapSummary[];
  profiles: TelemetryProfileHealth[];
}

export interface TelemetryGapSummary {
  kind: TelemetryGapKind;
  count: number;
  firstAt: number;
  lastAt: number;
  detail: string;
}

export const TELEMETRY_GAP_KINDS = [
  /** Capture refused before the journal - the documented pre-acceptance boundary. */
  "capture_refused",
  /** A payload aged or was squeezed out before it could be delivered. */
  "payload_expired",
  /** A record this build's schema cannot interpret. */
  "unsupported_schema",
  /** Dimension values folded into the overflow bucket to hold the series ceiling. */
  "series_overflow",
  /** A destination permanently refused a batch. */
  "permanently_rejected",
  /** Something was lost and the loss counter itself could not be written. */
  "unknown_gap",
] as const;
export type TelemetryGapKind = (typeof TELEMETRY_GAP_KINDS)[number];

/**
 * What the config route reports.
 *
 * The stored intent, plus the two things intent alone cannot tell an operator: whether a
 * credential exists (not what it is), and whether the endpoint they saved actually satisfies
 * the transport rules. Phase 2's panel renders this directly.
 */
export interface TelemetryStatus {
  config: TelemetryConfig;
  productEnrollment: TelemetryProductEnrollment;
  /** True when a credential is stored for the user backend. The value is never returned. */
  userCredentialConfigured: boolean;
  /** Null when no endpoint is configured. */
  endpoint: { ok: boolean; detail: string; warning: string | null } | null;
}

/** Which destination a probe should exercise. `local` has no endpoint and is refused. */
export const TelemetryProbeRequestSchema = z.object({
  profile: z.enum(["user", "product"]).default("user"),
});
export type TelemetryProbeRequest = z.infer<typeof TelemetryProbeRequestSchema>;

/** Result of the synthetic connection probe - the walking slice's own end-to-end check. */
export interface TelemetryProbeResult {
  profile: TelemetryProfileId;
  outcome: "accepted" | "refused" | "unreachable" | "not_configured";
  latencyMs: number;
  detail: string;
  /** The trace this probe produced, so an operator can search for it in the backend. */
  traceId: string | null;
}
