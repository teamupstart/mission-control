/**
 * The typed telemetry registry: every event Mission Control may capture, every instrument it
 * may project, and the rules a later phase's addition has to satisfy.
 *
 * This is the "no caller invents a metric name from an action string" boundary. `capture()`
 * takes a catalog entry, not a string, so an event with no analysis question, no owner, no
 * bounded fact schema and no declared audience cannot be captured at all - and an instrument
 * cannot acquire a dimension that was never allowlisted.
 *
 * Phase 1 registers the two entries that have callers in Phase 1. The FEATURE GROUPS below
 * enumerate every declared group across P0-P5 with its owning phase, so a later phase adds
 * entries to an existing group rather than inventing a parallel taxonomy.
 *
 * Browser-safe: no `node:` imports. Phase 7's dashboard manifest reads these definitions to
 * check that every panel's query names an instrument that exists.
 */
import { z } from "zod";
import {
  AUDIENCE_ALL,
  AUDIENCE_OPERATOR,
  TELEMETRY_CATALOG_VERSION,
  type TelemetryAudience,
  type TelemetryEnvelope,
} from "./telemetry.ts";

// ---- feature groups ----

/**
 * Every declared telemetry feature group and the phase that owns adding entries to it.
 *
 * Listed in full from the approved design rather than grown one phase at a time, because the
 * point of the taxonomy is that a Phase 3 author finds `session_lifecycle` already here
 * instead of coining `sessions`. A group with no entries yet is not a gap; it is a reservation.
 */
export const TELEMETRY_FEATURE_GROUPS = {
  daemon_lifecycle: { phase: 1, summary: "Daemon start, readiness and self-diagnostics" },
  telemetry_control: { phase: 2, summary: "Consent, endpoint and export-profile control actions" },
  session_lifecycle: { phase: 3, summary: "Session start, turns, dispatch, terminal and end" },
  model_effort: { phase: 3, summary: "Effective model and effort observations, and usage" },
  task_outcome: { phase: 3, summary: "Task completion, departure and work-episode outcome" },
  pr_outcome: { phase: 3, summary: "Verified per-repository pull request facts, including late ones" },
  workflow_run: { phase: 4, summary: "Workflow run start, completion, cancellation and early exit" },
  workflow_stage: { phase: 4, summary: "Stage occurrence, wall, wait and execution intervals" },
  persona_review: { phase: 4, summary: "Executed reviews, verdicts, reasons and response validity" },
  workflow_repair: { phase: 4, summary: "Repair packets, repair rounds and next-review resolution" },
  human_intervention: { phase: 4, summary: "Required decisions, recovery and voluntary steering" },
  primary_action: { phase: 5, summary: "The remaining primary-action inventory across all surfaces" },
  navigation: { phase: 5, summary: "Browser navigation and exposure, distinct from use" },
  automation: { phase: 5, summary: "Foreman, scheduler and MCP-originated automation actions" },
  errors: { phase: 5, summary: "Bounded, correlated, safe cross-layer error facts" },
  analytics_cohort: { phase: 6, summary: "Bounded analytical cohort and retention summaries" },
} as const;
export type TelemetryFeatureGroup = keyof typeof TELEMETRY_FEATURE_GROUPS;

/**
 * P0's three priority levels. The first release is not "all actions covered" until `breadth`
 * is complete, however useful `core` becomes earlier.
 */
export const TELEMETRY_PRIORITIES = ["core", "breadth", "diagnostic"] as const;
export type TelemetryPriority = (typeof TELEMETRY_PRIORITIES)[number];

// ---- dimension policy ----

/**
 * Dimension keys no instrument may ever carry.
 *
 * Two different failures live in one list. The first group is unbounded cardinality - one
 * series per run forever, which is what makes a Prometheus installation fall over. The second
 * is content: a path, a branch or a message is exactly the thing P0's audience table says gets
 * no new telemetry copy, and a metric label is the easiest place to leak one by accident.
 *
 * These identities are not forbidden everywhere. They are legitimate `refs` on an event and
 * legitimate attributes on a trace span, where they are bounded by retention rather than
 * multiplied by every other dimension. They are forbidden as METRIC DIMENSIONS.
 */
export const FORBIDDEN_METRIC_DIMENSIONS: readonly string[] = [
  "attempt_id",
  "batch_id",
  "branch",
  "cwd",
  "event_id",
  "fingerprint",
  "message",
  "node_id",
  "operation_id",
  "path",
  "pr_url",
  "prompt",
  "query",
  "repo",
  "repo_root",
  "route",
  "run_id",
  "session_id",
  "submission_id",
  "task_id",
  "trace_id",
  "url",
  "worktree",
];

/**
 * A dimension value may be a bounded date BOUND carried as a metric VALUE, but never a date
 * label. This pattern catches the accident directly, since `date` is not itself a banned word.
 */
const DATE_LIKE_DIMENSION = /^(date|day|hour|timestamp|calculated_at|window_start|window_end)$/;

// ---- span definitions ----

export const TELEMETRY_SPAN_KINDS = ["internal", "client", "server"] as const;
export type TelemetrySpanKind = (typeof TELEMETRY_SPAN_KINDS)[number];

/**
 * How one event becomes a completed span.
 *
 * Deliberately a DESCRIPTOR rather than a live SDK span. A completed operation is serialized
 * from persisted facts later, possibly after a restart, which is the only way a span can
 * survive the durable boundary with its original timestamps intact.
 */
export interface TelemetrySpanDefinition {
  name: string;
  kind: TelemetrySpanKind;
  /**
   * Fact key holding the operation's duration in ms. The span's start is `occurredAt` minus
   * that duration and its end is `occurredAt`, so the backend sees when the work actually
   * ran rather than when the journal was drained. Omitted means a zero-duration point.
   */
  durationFactKey: string | null;
  /** Fact keys promoted to span attributes. Anything not listed never reaches a span. */
  attributes: readonly string[];
  /** Ref keys promoted to span attributes, after destination-scoped translation. */
  refAttributes: readonly string[];
  /**
   * Which values of which fact make this span an ERROR rather than a success.
   *
   * Declared here rather than decided in the engine, so a later phase adds an outcome-bearing
   * event by describing it instead of by editing the projection.
   *
   * Not cosmetic. Tempo filters and colours by span status, so a span left `unset` reads as
   * "nothing went wrong": a failed export probe rendered identically to a working one, and the
   * failure was legible only by reading the attribute text - on the very drill-down path this
   * facility exists to make diagnosis possible through. `null` means the event has no notion
   * of failing.
   */
  errorWhen: { factKey: string; values: readonly string[] } | null;
}

// ---- event definitions ----

export interface TelemetryEventDefinition<Facts extends z.ZodTypeAny = z.ZodTypeAny> {
  /** Dotted, `mission.`-prefixed, stable forever. A changed meaning is a new name. */
  name: string;
  /** This entry's own revision. Additive facts bump it; readers of old rows keep working. */
  version: number;
  group: TelemetryFeatureGroup;
  priority: TelemetryPriority;
  /** The analysis question this fact exists to answer. P0 admits nothing without one. */
  question: string;
  /** The authoritative owner that emits it. */
  owner: string;
  audience: TelemetryAudience;
  /**
   * The event's own fact schema, which must be strict: an undeclared field is a rejection,
   * not a passthrough. This is what stops a serializer spreading an internal Session, Task or
   * exception object into the envelope.
   */
  facts: Facts;
  /** Allowed `refs` keys. A ref outside this list is dropped before the journal. */
  refKeys: readonly string[];
  span: TelemetrySpanDefinition | null;
  /**
   * Whether the browser may submit this event through the typed ingress, and nothing more.
   *
   * `null` is the default and the safe answer: an event the daemon owns is not reachable from
   * a page, so a console cannot forge a daemon start or a workflow verdict. `"browser"` marks
   * the entries whose ONLY possible observer is the client - what a person was shown, how long
   * a render took - which the daemon genuinely cannot see.
   *
   * Declared here rather than checked at the ingress, so the allowlist is a property of the
   * catalog the same way `audience` is: a Phase 5 author adds a browser signal by declaring one,
   * and cannot widen the boundary from a call site.
   */
  ingress: "browser" | null;
}

// ---- metric definitions ----

export const TELEMETRY_INSTRUMENT_KINDS = ["counter", "histogram", "gauge"] as const;
export type TelemetryInstrumentKind = (typeof TELEMETRY_INSTRUMENT_KINDS)[number];

/** One contribution from one event to one instrument. Exactly one, or none. */
export interface TelemetryContribution {
  dimensions: Record<string, string>;
  value: number;
}

export interface TelemetryMetricDefinition {
  /** Dotted, `mission.`-prefixed. The Prometheus name is derived; see `promMetricName`. */
  name: string;
  description: string;
  /** UCUM-ish unit. `1` for a dimensionless count. */
  unit: string;
  kind: TelemetryInstrumentKind;
  valueType: "int" | "double";
  /** The single event name that contributes to this instrument. */
  event: string;
  audience: TelemetryAudience;
  /**
   * The exact dimension allowlist. A contribution returning a key outside this set is a
   * catalog defect and is refused by `assertTelemetryCatalogIntegrity`.
   */
  dimensions: readonly string[];
  /** Required for `histogram`, forbidden otherwise. */
  boundaries: readonly number[] | null;
  /** What an unobserved dimension value becomes. Unknown stays visible; it is never dropped. */
  unknownPolicy: "explicit_unknown";
  /** The catalog revision that introduced this instrument. */
  since: number;
  owner: string;
  /**
   * The deterministic projection rule. Pure, total, and the ONLY place an event turns into a
   * metric point - which is what makes a replay reproducible and a double-count impossible.
   *
   * Returns null when the event does not qualify, which is how one event feeds a `fail`-only
   * instrument without feeding it a `pass`.
   */
  contribution: (
    facts: Record<string, unknown>,
    envelope: TelemetryEnvelope,
  ) => TelemetryContribution | null;
}

// ---- definition helpers ----
//
// Every entry is built through these so the invariants are enforced at the definition site
// rather than discovered by a dashboard with an empty panel on it.

function defineEvent<Facts extends z.ZodTypeAny>(
  def: TelemetryEventDefinition<Facts>,
): TelemetryEventDefinition<Facts> {
  return def;
}

function defineMetric(def: TelemetryMetricDefinition): TelemetryMetricDefinition {
  return def;
}

// ---- Phase 1 events ----

/**
 * The daemon started and is serving.
 *
 * The walking slice's source fact: it is owned by a real subsystem, it has a durable identity
 * (this process's boot id), it carries no operator data, and it happens exactly once per boot
 * - which makes "did it contribute exactly once after a crash-and-restart" a question a test
 * can actually ask.
 */
export const DAEMON_STARTED_EVENT = defineEvent({
  name: "mission.daemon.started",
  version: 1,
  group: "daemon_lifecycle",
  priority: "diagnostic",
  question: "Is this installation running, and how long does it take to become ready?",
  owner: "src/server/index.ts",
  audience: AUDIENCE_ALL,
  facts: z
    .object({
      /** Wall time from process start to the port answering. */
      startup_ms: z.number().int().min(0),
      /** Whether this boot ran a schema migration. A slow start after an upgrade is expected. */
      schema_upgraded: z.boolean(),
      /** How the daemon was launched. Bounded enum, never a command line. */
      launch_mode: z.enum(["daemon", "desktop", "dev", "unknown"]),
    })
    .strict(),
  refKeys: [],
  // Daemon-owned: the browser has no business asserting that a daemon started.
  ingress: null,
  span: {
    name: "mission.daemon.start",
    kind: "internal",
    durationFactKey: "startup_ms",
    attributes: ["launch_mode", "schema_upgraded"],
    refAttributes: [],
    // A daemon start that was captured is a daemon start that happened. There is no failing
    // variant of it to report, and inventing one would make `unset` mean something it does not.
    errorWhen: null,
  },
});

/**
 * An operator asked whether the configured endpoint actually works.
 *
 * Deliberately captured through the ordinary path rather than measured out of band: the point
 * of the probe is to exercise journal, projection, outbox and exporter exactly as a real fact
 * would, so a green probe is evidence about the pipeline and not about a separate code path
 * that happens to speak HTTP.
 *
 * Operator audience only. P5 requires synthetic connection-test signals stay out of product
 * adoption, and the cheapest way to guarantee that is to make them ineligible at capture.
 */
export const TELEMETRY_PROBE_EVENT = defineEvent({
  name: "mission.telemetry.probe.finished",
  version: 1,
  group: "daemon_lifecycle",
  priority: "diagnostic",
  question: "Does the configured export destination accept what this installation sends?",
  owner: "src/server/telemetry/diagnostics.ts",
  audience: AUDIENCE_OPERATOR,
  facts: z
    .object({
      profile: z.enum(["local", "user", "product"]),
      outcome: z.enum(["accepted", "refused", "unreachable", "not_configured"]),
      latency_ms: z.number().int().min(0),
    })
    .strict(),
  refKeys: [],
  ingress: null,
  span: {
    name: "mission.telemetry.probe",
    kind: "client",
    durationFactKey: "latency_ms",
    attributes: ["profile", "outcome"],
    refAttributes: [],
    // `not_configured` is deliberately absent: nothing was tried, so nothing failed. Only a
    // probe that reached for an endpoint and did not get what it needed is an error.
    errorWhen: { factKey: "outcome", values: ["refused", "unreachable"] },
  },
});

// ---- Phase 2 events ----

/**
 * An operator changed something about collection or export, and it took effect.
 *
 * The one record of a telemetry control action, captured by the daemon that APPLIED it rather
 * than by the surface that asked for it - which is why there is no browser twin of this event.
 * A control can arrive from the dashboard, from a script against the route, or later from
 * another surface entirely, and all three are the same fact.
 *
 * Captured AFTER the change, which decides its own edge cases honestly rather than by
 * accident: switching collection ON is recorded (capture is now permitted), and switching it
 * OFF is not (it is not, and consent withdrawn is not consent to record the withdrawal).
 *
 * Operator audience only. Which destinations somebody configured is a fact about that person's
 * infrastructure, and P5 keeps it out of product adoption for the same reason it keeps probes
 * out: it measures the operator, not the product.
 */
export const TELEMETRY_CONTROL_EVENT = defineEvent({
  name: "mission.telemetry.control.applied",
  version: 1,
  group: "telemetry_control",
  priority: "diagnostic",
  question: "Which telemetry controls does an operator use, and do those changes succeed?",
  owner: "src/server/telemetry/controls.ts",
  audience: AUDIENCE_OPERATOR,
  facts: z
    .object({
      /**
       * What was done. `configure` covers every stored-value change - enabling, disabling,
       * pausing, resuming, an endpoint, a credential - because the VALUE is not recordable
       * (it is the operator's infrastructure) and the distinctions that are recordable are
       * already in `profile` and in the health the panel shows.
       */
      action: z.enum(["configure", "retry", "purge", "reset_identity"]),
      profile: z.enum(["local", "user", "product", "all"]),
      outcome: z.enum(["applied", "refused"]),
      /** How the request was attributed. Repeated as a fact so it survives as a dimension. */
      actor_basis: z.enum(["owner", "app_context", "declared", "inferred", "unknown"]),
    })
    .strict(),
  /**
   * The app-issued logical operation, so a browser fact and this server fact can be joined.
   * A ref, never a dimension: `operation_id` is on the forbidden-dimension list precisely
   * because one series per operation is unbounded.
   */
  refKeys: ["operation_id"],
  ingress: null,
  span: {
    name: "mission.telemetry.control",
    kind: "internal",
    durationFactKey: null,
    attributes: ["action", "profile", "outcome", "actor_basis"],
    refAttributes: ["operation_id"],
    errorWhen: { factKey: "outcome", values: ["refused"] },
  },
});

/**
 * An operator opened the telemetry controls, and what state they were shown.
 *
 * The Phase 2 event the daemon genuinely cannot observe: whether anyone ever LOOKED. It
 * answers a question the control event cannot - how many operators find these controls, see
 * that collection is off, and leave it off - which is the difference between a feature nobody
 * wants and one nobody can find.
 *
 * Deliberately narrow. This is not "the dashboard navigated somewhere": general navigation is
 * `navigation`, which Phase 5 owns and which this event must not become a bridgehead for. It
 * is scoped to the telemetry controls, which are Phase 2's own surface.
 */
export const TELEMETRY_SETTINGS_OPENED_EVENT = defineEvent({
  name: "mission.telemetry.settings.opened",
  version: 1,
  group: "telemetry_control",
  priority: "diagnostic",
  question: "Do operators find the telemetry controls, and what state do they find them in?",
  owner: "src/web/components/TelemetrySettingsPanel.tsx",
  audience: AUDIENCE_OPERATOR,
  facts: z
    .object({
      /** Whether collection was on at the moment the panel rendered. */
      collection_enabled: z.boolean(),
      /** How many export destinations were switched on. Bounded by the profile count. */
      destinations_enabled: z.number().int().min(0).max(2),
    })
    .strict(),
  refKeys: ["operation_id"],
  // The one Phase 2 entry the browser may submit, and the reason the ingress exists.
  ingress: "browser",
  span: null,
});

/** Every registered event, by name. */
export const TELEMETRY_EVENTS: Record<string, TelemetryEventDefinition> = Object.fromEntries(
  [
    DAEMON_STARTED_EVENT,
    TELEMETRY_PROBE_EVENT,
    TELEMETRY_CONTROL_EVENT,
    TELEMETRY_SETTINGS_OPENED_EVENT,
  ].map((e) => [e.name, e as TelemetryEventDefinition]),
);

/** Every event the typed browser ingress may admit, by name. */
export function browserIngressEvents(): TelemetryEventDefinition[] {
  return Object.values(TELEMETRY_EVENTS).filter((e) => e.ingress === "browser");
}

// ---- Phase 1 instruments ----

export const DAEMON_STARTS_METRIC = defineMetric({
  name: "mission.daemon.starts",
  description: "Daemon starts observed by this installation.",
  unit: "1",
  kind: "counter",
  valueType: "int",
  event: DAEMON_STARTED_EVENT.name,
  audience: AUDIENCE_ALL,
  dimensions: ["launch_mode", "schema_upgraded"],
  boundaries: null,
  unknownPolicy: "explicit_unknown",
  since: TELEMETRY_CATALOG_VERSION,
  owner: "src/shared/telemetry-catalog.ts",
  contribution: (facts) => ({
    dimensions: {
      launch_mode: String(facts.launch_mode ?? "unknown"),
      schema_upgraded: String(facts.schema_upgraded === true),
    },
    value: 1,
  }),
});

export const DAEMON_STARTUP_DURATION_METRIC = defineMetric({
  name: "mission.daemon.startup.duration",
  description: "Wall time from daemon process start to the API answering.",
  unit: "ms",
  kind: "histogram",
  valueType: "double",
  event: DAEMON_STARTED_EVENT.name,
  audience: AUDIENCE_ALL,
  dimensions: ["launch_mode"],
  // Explicit boundaries rather than exponential: a start is interesting at human scale, and
  // explicit buckets are what Prometheus's OTLP receiver translates without surprises.
  boundaries: [50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000],
  unknownPolicy: "explicit_unknown",
  since: TELEMETRY_CATALOG_VERSION,
  owner: "src/shared/telemetry-catalog.ts",
  contribution: (facts) => {
    const ms = typeof facts.startup_ms === "number" ? facts.startup_ms : null;
    if (ms === null) return null;
    return { dimensions: { launch_mode: String(facts.launch_mode ?? "unknown") }, value: ms };
  },
});

export const TELEMETRY_PROBES_METRIC = defineMetric({
  name: "mission.telemetry.probes",
  description: "Synthetic export connection probes, by destination profile and outcome.",
  unit: "1",
  kind: "counter",
  valueType: "int",
  event: TELEMETRY_PROBE_EVENT.name,
  audience: AUDIENCE_OPERATOR,
  dimensions: ["profile", "outcome"],
  boundaries: null,
  unknownPolicy: "explicit_unknown",
  since: TELEMETRY_CATALOG_VERSION,
  owner: "src/shared/telemetry-catalog.ts",
  contribution: (facts) => ({
    dimensions: {
      profile: String(facts.profile ?? "unknown"),
      outcome: String(facts.outcome ?? "unknown"),
    },
    value: 1,
  }),
});

// ---- Phase 2 instruments ----

export const TELEMETRY_CONTROLS_METRIC = defineMetric({
  name: "mission.telemetry.controls",
  description: "Telemetry control actions applied, by action, profile and outcome.",
  unit: "1",
  kind: "counter",
  valueType: "int",
  event: TELEMETRY_CONTROL_EVENT.name,
  audience: AUDIENCE_OPERATOR,
  // `actor_basis` is a dimension rather than an attribute-only fact because "who is changing
  // consent" is one of the few questions this facility must be able to answer about ITSELF.
  dimensions: ["action", "profile", "outcome", "actor_basis"],
  boundaries: null,
  unknownPolicy: "explicit_unknown",
  since: TELEMETRY_CATALOG_VERSION,
  owner: "src/shared/telemetry-catalog.ts",
  contribution: (facts) => ({
    dimensions: {
      action: String(facts.action ?? "unknown"),
      profile: String(facts.profile ?? "unknown"),
      outcome: String(facts.outcome ?? "unknown"),
      actor_basis: String(facts.actor_basis ?? "unknown"),
    },
    value: 1,
  }),
});

export const TELEMETRY_SETTINGS_OPENS_METRIC = defineMetric({
  name: "mission.telemetry.settings.opens",
  description: "Times the telemetry controls were opened, by the collection state shown.",
  unit: "1",
  kind: "counter",
  valueType: "int",
  event: TELEMETRY_SETTINGS_OPENED_EVENT.name,
  audience: AUDIENCE_OPERATOR,
  dimensions: ["collection_enabled"],
  boundaries: null,
  unknownPolicy: "explicit_unknown",
  since: TELEMETRY_CATALOG_VERSION,
  owner: "src/shared/telemetry-catalog.ts",
  contribution: (facts) => ({
    dimensions: { collection_enabled: String(facts.collection_enabled === true) },
    value: 1,
  }),
});

/** Every registered instrument, by name. */
export const TELEMETRY_METRICS: Record<string, TelemetryMetricDefinition> = Object.fromEntries(
  [
    DAEMON_STARTS_METRIC,
    DAEMON_STARTUP_DURATION_METRIC,
    TELEMETRY_PROBES_METRIC,
    TELEMETRY_CONTROLS_METRIC,
    TELEMETRY_SETTINGS_OPENS_METRIC,
  ].map((m) => [m.name, m]),
);

/** The instruments one event contributes to, in a stable order. */
export function metricsForEvent(eventName: string): TelemetryMetricDefinition[] {
  return Object.values(TELEMETRY_METRICS)
    .filter((m) => m.event === eventName)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---- name translation ----

/**
 * The Prometheus name this instrument lands under, pinned rather than discovered.
 *
 * Prometheus's OTLP receiver replaces `.` with `_` and appends `_total` to a monotonic sum
 * when its translation strategy keeps unit and type suffixes. Pinning it here lets a unit test
 * assert the exact series a dashboard query names, so a panel cannot go quietly empty because
 * a receiver default moved. The real receiver is checked against this in the stack test.
 */
export function promMetricName(metric: TelemetryMetricDefinition): string {
  const base = metric.name.replace(/\./g, "_");
  if (metric.kind === "counter") return `${base}_total`;
  if (metric.kind === "histogram" && metric.unit === "ms") return `${base}_milliseconds`;
  return base;
}

// ---- integrity ----

/**
 * Every rule a catalog entry must satisfy, checked as one pass.
 *
 * Called by a focused test rather than at module load: a throwing import would take the whole
 * daemon down over a telemetry typo, which is precisely the trade P1 forbids.
 */
export function telemetryCatalogProblems(): string[] {
  const problems: string[] = [];

  for (const [name, event] of Object.entries(TELEMETRY_EVENTS)) {
    if (name !== event.name) problems.push(`event key ${name} does not match name ${event.name}`);
    if (!event.name.startsWith("mission.")) {
      problems.push(`event ${event.name} is not namespaced under mission.`);
    }
    if (!(event.group in TELEMETRY_FEATURE_GROUPS)) {
      problems.push(`event ${event.name} names an unknown feature group ${event.group}`);
    }
    if (event.question.trim().length === 0) {
      problems.push(`event ${event.name} has no analysis question`);
    }
    if (event.audience.length === 0) problems.push(`event ${event.name} has no audience`);
    // Strictness is the rule that stops an internal object being spread into an envelope, so
    // it is checked rather than trusted. Zod records the mode on the def.
    const def = (event.facts as unknown as { _def?: { unknownKeys?: string } })._def;
    if (def?.unknownKeys !== "strict") {
      problems.push(`event ${event.name} facts schema is not strict`);
    }
    if (event.ingress === "browser") {
      // A browser-eligible event is one the daemon cannot observe, which means it is one a
      // page can ASSERT. Two rules follow from that and are checked rather than remembered.
      //
      // It may not carry a span. A span is a timing claim, and an unauthenticated page
      // supplying its own start and end would put fabricated intervals into the trace backend
      // that a reviewer has no way to tell from measured ones.
      if (event.span) {
        problems.push(`browser event ${event.name} declares a span, which a page may not assert`);
      }
      // And it must stay out of the product audience. A self-reported fact is a weaker
      // observation than a daemon-observed one, and the minimized public audience is exactly
      // where the difference would be invisible. Phase 5 may revisit this deliberately; it may
      // not happen by a copied definition.
      if (event.audience.includes("product")) {
        problems.push(
          `browser event ${event.name} claims the product audience; self-reported facts stay operator-only`,
        );
      }
    }
    if (event.span) {
      const factShape = Object.keys(
        (event.facts as unknown as { shape?: Record<string, unknown> }).shape ?? {},
      );
      for (const attribute of event.span.attributes) {
        if (!factShape.includes(attribute)) {
          problems.push(`event ${event.name} span attribute ${attribute} is not a declared fact`);
        }
      }
      for (const ref of event.span.refAttributes) {
        if (!event.refKeys.includes(ref)) {
          problems.push(`event ${event.name} span ref ${ref} is not a declared ref key`);
        }
      }
    }
  }

  for (const [name, metric] of Object.entries(TELEMETRY_METRICS)) {
    if (name !== metric.name) problems.push(`metric key ${name} does not match name ${metric.name}`);
    if (!metric.name.startsWith("mission.")) {
      problems.push(`metric ${metric.name} is not namespaced under mission.`);
    }
    const event = TELEMETRY_EVENTS[metric.event];
    if (!event) {
      problems.push(`metric ${metric.name} contributes from unknown event ${metric.event}`);
      continue;
    }
    // An instrument cannot reach an audience its own source event is not eligible for. This is
    // the "a product opt-in cannot receive what was never captured for it" rule, stated once.
    for (const profile of metric.audience) {
      if (!event.audience.includes(profile)) {
        problems.push(
          `metric ${metric.name} claims audience ${profile} that its event ${event.name} excludes`,
        );
      }
    }
    if (metric.kind === "histogram" && (metric.boundaries === null || metric.boundaries.length === 0)) {
      problems.push(`histogram ${metric.name} declares no explicit bucket boundaries`);
    }
    if (metric.kind !== "histogram" && metric.boundaries !== null) {
      problems.push(`metric ${metric.name} is not a histogram but declares boundaries`);
    }
    if (metric.boundaries) {
      const sorted = [...metric.boundaries].sort((a, b) => a - b);
      if (sorted.some((v, i) => v !== metric.boundaries?.[i])) {
        problems.push(`histogram ${metric.name} boundaries are not ascending`);
      }
    }
    for (const dimension of metric.dimensions) {
      if (FORBIDDEN_METRIC_DIMENSIONS.includes(dimension)) {
        problems.push(`metric ${metric.name} carries forbidden dimension ${dimension}`);
      }
      if (DATE_LIKE_DIMENSION.test(dimension)) {
        problems.push(`metric ${metric.name} carries a time-valued dimension ${dimension}`);
      }
    }
  }

  return problems;
}
