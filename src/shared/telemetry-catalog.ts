import { SOURCE_EVENTS, SOURCE_METRICS } from "./telemetry-sources/index.ts";
import { ANALYTICAL_METRICS } from "./telemetry-projections/index.ts";
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
  TELEMETRY_ACTOR_BASES,
  TELEMETRY_UNKNOWN_VALUE,
  type TelemetryAudience,
  type TelemetryEnvelope,
} from "./telemetry.ts";
// The shared registries, imported rather than restated. A telemetry schema that wrote out
// "claude" | "codex" | "pi" would be a second source of truth for the harness list, and the
// day a fourth one lands it would silently refuse every fact about it.
import { EMULATOR_IDS, MULTIPLEXER_IDS } from "./terminal.ts";
import { AGENT_TYPES, SESSION_RUNTIMES, TASK_KINDS, THINKING_LEVELS } from "./types.ts";
import { MODEL_CATALOG } from "./model.ts";

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

// ---- Phase 3 events ----
//
// Session attribution, in the shape P2 argues for: what was actually KNOWN about a session
// when the work happened, split into facts that are independently true. A model choice, a
// session existing, a task finishing and a pull request landing are four different
// observations with four different owners, and collapsing any pair of them is how a chart
// ends up claiming a model "failed" because its session was killed.
//
// Every vocabulary below is imported from the shared registries rather than written out.
// A fourth harness, a third runtime or a seventh task kind then widens these schemas by
// existing, instead of by somebody remembering to edit a telemetry file.

/**
 * How a session came to be observed, and how much of its life this installation saw.
 *
 * Two fields rather than one, because they answer different questions and P2 requires both.
 * `origin` is provenance - did Mission Control launch this, adopt it, or bring it back? -
 * and `start_observation` is COVERAGE: whether the start itself was witnessed. A session
 * discovered mid-flight has a real start time that nothing here can know, and reporting it
 * as though capture had been running from the beginning is what would quietly put it in a
 * complete-from-start cohort it does not belong to.
 */
export const SESSION_STARTED_EVENT = defineEvent({
  name: "mission.session.started",
  version: 1,
  group: "session_lifecycle",
  priority: "core",
  question: "How do sessions come into existence, on which harness and runtime, and for what kind of work?",
  owner: "src/server/telemetry/sessions.ts",
  audience: AUDIENCE_ALL,
  facts: z
    .object({
      /**
       * `dispatch` is an app-owned launch, `discovered` an external session this
       * installation adopted, `restored` a managed session brought back across a restart.
       *
       * ONE event with an origin rather than P2's proposed `session.created` /
       * `session.first_observed` pair. The two would have carried an identical fact schema,
       * an identical dedupe identity and an identical instrument, and the distinction they
       * exist to preserve is exactly what this field states - while a single entry makes
       * "exactly one start per session id" a property the dedupe table enforces, rather
       * than an invariant split across two tables nobody joins.
       */
      origin: z.enum(["dispatch", "discovered", "restored"]),
      /**
       * Whether the START was witnessed, or only the session's existence.
       *
       * `observed_start` for a launch this installation performed with capture already
       * running; `first_observed` for a session that already existed - its real start is
       * unknowable and is NOT guessed at; `after_restart` for one re-adopted across a
       * daemon boot, where continuity is proven but the original start is not this
       * observation's.
       */
      start_observation: z.enum(["observed_start", "first_observed", "after_restart"]),
      agent: z.enum([...AGENT_TYPES, "unknown", "unsupported"]),
      runtime: z.enum([...SESSION_RUNTIMES, "unknown", "unsupported"]),
      /** The existing task vocabulary, plus an explicit no-task state. A personal session is not `chat`. */
      task_kind: z.enum([...TASK_KINDS, "none", "unknown", "unsupported"]),
      /** Multiplexer and emulator INDEPENDENTLY: one nests inside the other, so neither implies the other. */
      multiplexer: z.enum([...MULTIPLEXER_IDS, "none", "unknown", "not_applicable"]),
      emulator: z.enum([...EMULATOR_IDS, "none", "unknown", "not_applicable"]),
      /** How many repositories this session may write to. One on an ordinary dispatch. */
      repo_count: z.number().int().min(0).max(64),
    })
    .strict(),
  refKeys: ["session_id", "task_id", "conversation_id"],
  ingress: null,
  span: {
    name: "mission.session.start",
    kind: "internal",
    durationFactKey: null,
    attributes: ["origin", "start_observation", "agent", "runtime", "task_kind"],
    refAttributes: ["session_id", "task_id", "conversation_id"],
    errorWhen: null,
  },
});

/**
 * A managed session's restoration was attempted, and how it ended.
 *
 * Its own event rather than an outcome on the start above, because a restoration that FAILS
 * never becomes a session at all - there is no start to hang it off. P2's rule stated as a
 * schema: an inert restoring projection is not yet a usable session, and only the supervisor
 * knows which of the two it produced.
 */
export const SESSION_RESTORE_EVENT = defineEvent({
  name: "mission.session.restore.finished",
  version: 1,
  group: "session_lifecycle",
  priority: "core",
  question: "Do managed sessions survive a daemon restart, and how long does coming back take?",
  owner: "src/server/sdk/supervisor.ts",
  audience: AUDIENCE_ALL,
  facts: z
    .object({
      outcome: z.enum(["succeeded", "failed", "interrupted"]),
      agent: z.enum([...AGENT_TYPES, "unknown", "unsupported"]),
      /** Wall time for this one row's resume. Serial across rows, so it is not the whole restart. */
      duration_ms: z.number().int().min(0),
      /** Whether the row carried a turn that was in flight when the previous daemon stopped. */
      turn_in_progress: z.boolean(),
    })
    .strict(),
  refKeys: ["session_id", "task_id"],
  ingress: null,
  span: {
    name: "mission.session.restore",
    kind: "internal",
    durationFactKey: "duration_ms",
    attributes: ["outcome", "agent", "turn_in_progress"],
    refAttributes: ["session_id", "task_id"],
    errorWhen: { factKey: "outcome", values: ["failed", "interrupted"] },
  },
});

/**
 * A dispatch attempt finished, carrying what it RESOLVED and what happened to it.
 *
 * Resolution and outcome in one fact because they are one operation: an admitted dispatch
 * that never reaches a running agent is the single most interesting row here, and splitting
 * it would make "which resolved model fails to launch" a join rather than a filter. The
 * resolved values are frozen at the dispatcher's own resolution boundary and carried
 * forward, so a settings change between resolution and failure cannot rewrite them.
 *
 * `resolved_model` is deliberately absent from every instrument below and present on the
 * span: model ids multiplied by outcome, kind, agent and runtime is the label cross-product
 * P0 forbids, and the question it answers is a trace question.
 */
export const DISPATCH_FINISHED_EVENT = defineEvent({
  name: "mission.dispatch.finished",
  version: 1,
  group: "session_lifecycle",
  priority: "core",
  question: "Which dispatches reach a running agent, on which resolved model and effort, and which fail before that?",
  owner: "src/server/dispatcher.ts",
  audience: AUDIENCE_ALL,
  facts: z
    .object({
      /**
       * `launched` means an agent session was admitted and its first turn delivered.
       * `failed` covers every refusal, including the ones that never spawned anything -
       * which is the point: a launch request that fails never becomes a started session.
       * `superseded` is a dispatch the operator settled underneath, and is not a failure.
       */
      outcome: z.enum(["launched", "failed", "superseded"]),
      agent: z.enum([...AGENT_TYPES, "unknown", "unsupported"]),
      runtime: z.enum([...SESSION_RUNTIMES, "unknown", "unsupported"]),
      task_kind: z.enum([...TASK_KINDS, "unknown", "unsupported"]),
      /** The model this launch resolved to, or empty when the harness's own default was left to decide. */
      resolved_model: z.string(),
      /** The effort this launch resolved to. `unsupported` when the harness has no effort parameter. */
      resolved_effort: z.enum([...THINKING_LEVELS, "unsupported", "unknown"]),
      /**
       * Where the resolved values came from, which is what separates a deliberate pin from
       * a default nobody chose. `task` is the row's own pin; `automation` is Foreman's
       * launch-only choice; `kind` is the task-kind tier; `harness_default` is the panel
       * default; `harness` means nothing was resolved and the CLI decides for itself.
       */
      resolution_source: z.enum(["task", "automation", "kind", "harness_default", "harness"]),
      repo_count: z.number().int().min(0).max(64),
      duration_ms: z.number().int().min(0),
    })
    .strict(),
  refKeys: ["session_id", "task_id"],
  ingress: null,
  span: {
    name: "mission.dispatch",
    kind: "internal",
    durationFactKey: "duration_ms",
    attributes: [
      "outcome",
      "agent",
      "runtime",
      "task_kind",
      "resolved_model",
      "resolved_effort",
      "resolution_source",
    ],
    refAttributes: ["session_id", "task_id"],
    errorWhen: { factKey: "outcome", values: ["failed"] },
  },
});

/**
 * A new execution segment opened: the interval over which effective model and effort are
 * stable, and the unit every model-comparison question is actually asked of.
 *
 * Opened on a MEANINGFUL observed change, never on a metadata refresh. A repeated identical
 * observation refreshes quality and opens nothing, because a segment per poll would make
 * "turns per segment" a fact about the poller.
 *
 * `quality` is what stops a configured value being reported as an executed one. P2's rule -
 * do not set `effective_effort=high` merely because the API accepted a request - is enforced
 * by the source refusing to open a segment until something OBSERVES the level, and by this
 * field saying which of the two happened when it does.
 */
export const SESSION_SEGMENT_EVENT = defineEvent({
  name: "mission.session.segment.opened",
  version: 1,
  group: "model_effort",
  priority: "core",
  question: "What model and effort was a session ACTUALLY executing, over which intervals?",
  owner: "src/server/telemetry/sessions.ts",
  audience: AUDIENCE_ALL,
  facts: z
    .object({
      agent: z.enum([...AGENT_TYPES, "unknown", "unsupported"]),
      runtime: z.enum([...SESSION_RUNTIMES, "unknown", "unsupported"]),
      /** The reported model id, or empty when nothing has reported one yet. Trace-only. */
      model_id: z.string(),
      /** Normalized effort. `unknown` and `unsupported` are NEVER translated into `low`. */
      effort: z.enum([...THINKING_LEVELS, "unknown", "unsupported"]),
      /**
       * `observed` means a driver, status line or transcript reported it; `launch_resolved`
       * means only the launch choice is known; `unknown` and `unsupported` mean what they
       * say. P2 requires these stay distinguishable forever.
       */
      quality: z.enum(["observed", "launch_resolved", "unknown", "unsupported"]),
      /** Which source produced the reading, so a weak read is never mistaken for a strong one. */
      meta_source: z.enum(["statusline", "driver", "transcript", "codex-rollout", "none"]),
      /**
       * Why this segment opened. `conversation_rotation` always ends the previous one: a
       * model value must never migrate across a context clear into an unrelated conversation.
       */
      reason: z.enum(["first_observation", "model_changed", "effort_changed", "conversation_rotation"]),
      /** True when the session is carrying a next-turn selection that has not taken effect. */
      effort_pending: z.boolean(),
    })
    .strict(),
  refKeys: ["session_id", "task_id", "conversation_id", "segment_id"],
  ingress: null,
  span: {
    name: "mission.session.segment",
    kind: "internal",
    durationFactKey: null,
    attributes: ["agent", "runtime", "model_id", "effort", "quality", "meta_source", "reason"],
    refAttributes: ["session_id", "conversation_id", "segment_id"],
    errorWhen: null,
  },
});

/**
 * Somebody asked for a different effort level, and the driver answered.
 *
 * The SELECTION, which is a different fact from the segment above and must never be folded
 * into it. `applies` is the whole reason this event exists: a harness whose driver defers to
 * the next turn leaves the running turn on its old level, and a chart that attributed that
 * turn's tokens to the newly selected level would be measuring the wrong thing.
 */
export const EFFORT_SELECTED_EVENT = defineEvent({
  name: "mission.session.effort.selected",
  version: 1,
  group: "model_effort",
  priority: "core",
  question: "When an effort change is requested, is it accepted, and when does it take effect?",
  owner: "src/server/routes.ts",
  audience: AUDIENCE_ALL,
  facts: z
    .object({
      requested_effort: z.enum([...THINKING_LEVELS, "unknown", "unsupported"]),
      outcome: z.enum(["accepted", "refused"]),
      /** `current_turn` for a pane walk, `next_turn` for a deferring driver, `unknown` when refused. */
      applies: z.enum(["current_turn", "next_turn", "unknown"]),
      agent: z.enum([...AGENT_TYPES, "unknown", "unsupported"]),
      runtime: z.enum([...SESSION_RUNTIMES, "unknown", "unsupported"]),
      /** Attribution, never authorization - a dashboard context is not proof of a person. */
      actor_basis: z.enum(TELEMETRY_ACTOR_BASES),
    })
    .strict(),
  refKeys: ["session_id", "operation_id", "conversation_id"],
  ingress: null,
  span: {
    name: "mission.session.effort.select",
    kind: "internal",
    durationFactKey: null,
    attributes: ["requested_effort", "outcome", "applies", "agent", "runtime", "actor_basis"],
    refAttributes: ["session_id", "operation_id"],
    errorWhen: { factKey: "outcome", values: ["refused"] },
  },
});

/**
 * One conversation operation reached - or failed to reach - a session.
 *
 * At the DELIVERY seam, not at the button. The daemon owns whether bytes were taken, and
 * that is the only honest place to say an operation happened. `actor_basis` is carried
 * because a user-role message does not prove a human sender: automation writes through the
 * same routes, and the difference is exactly what this field records.
 */
export const SESSION_OPERATION_EVENT = defineEvent({
  name: "mission.session.operation",
  version: 1,
  group: "session_lifecycle",
  priority: "core",
  question: "Which conversation operations do people and automation perform, and do they land?",
  owner: "src/server/routes.ts",
  audience: AUDIENCE_ALL,
  facts: z
    .object({
      operation: z.enum(["send", "queued", "interrupt", "cancel", "question_response"]),
      outcome: z.enum(["delivered", "refused"]),
      agent: z.enum([...AGENT_TYPES, "unknown", "unsupported"]),
      runtime: z.enum([...SESSION_RUNTIMES, "unknown", "unsupported"]),
      actor_basis: z.enum(TELEMETRY_ACTOR_BASES),
    })
    .strict(),
  refKeys: ["session_id", "operation_id", "conversation_id", "segment_id"],
  ingress: null,
  span: {
    name: "mission.session.operation",
    kind: "internal",
    durationFactKey: null,
    attributes: ["operation", "outcome", "agent", "runtime", "actor_basis"],
    refAttributes: ["session_id", "operation_id", "conversation_id", "segment_id"],
    errorWhen: { factKey: "outcome", values: ["refused"] },
  },
});

/**
 * A session finished a turn, attributed to the segment that actually ran it.
 *
 * `duration_ms` is OBSERVED EXECUTION - the interval between the session entering and
 * leaving a working state - and not wall time across a laptop sleep. The two are different
 * numbers and this facility does not pretend to the second one; see `observation_bounded`.
 */
export const TURN_FINISHED_EVENT = defineEvent({
  name: "mission.session.turn.finished",
  version: 1,
  group: "session_lifecycle",
  priority: "core",
  question: "How long do turns take on a given model and effort, and how many complete?",
  owner: "src/server/telemetry/sessions.ts",
  audience: AUDIENCE_ALL,
  facts: z
    .object({
      agent: z.enum([...AGENT_TYPES, "unknown", "unsupported"]),
      runtime: z.enum([...SESSION_RUNTIMES, "unknown", "unsupported"]),
      /** The segment's effort at the moment the turn started. A next-turn selection does not move it. */
      effort: z.enum([...THINKING_LEVELS, "unknown", "unsupported"]),
      quality: z.enum(["observed", "launch_resolved", "unknown", "unsupported"]),
      /** How the turn left the working state. `blocked` means it stopped to ask something. */
      outcome: z.enum(["completed", "blocked", "ended"]),
      duration_ms: z.number().int().min(0),
      /**
       * True when the interval was measured across a gap this daemon cannot vouch for - a
       * restart, or a discovery miss. The duration is then a bound rather than a measurement,
       * and a histogram that mixed the two would be quietly wrong about the tail.
       */
      observation_bounded: z.boolean(),
    })
    .strict(),
  refKeys: ["session_id", "task_id", "conversation_id", "segment_id"],
  ingress: null,
  span: {
    name: "mission.session.turn",
    kind: "internal",
    durationFactKey: "duration_ms",
    attributes: ["agent", "runtime", "effort", "quality", "outcome", "observation_bounded"],
    refAttributes: ["session_id", "conversation_id", "segment_id"],
    errorWhen: null,
  },
});

/**
 * A session's departure was CONFIRMED by its owner.
 *
 * Captured at durable removal - `session_remove` - and never inferred from an `exited`
 * projection, which is provisional and can be cancelled by a rediscovery inside the linger.
 * It says nothing about the task: `ended_while_work_open` is an observed relationship, not a
 * verdict, and `mission.task.outcome` is where the task's own status lives.
 */
export const SESSION_ENDED_EVENT = defineEvent({
  name: "mission.session.ended",
  version: 1,
  group: "session_lifecycle",
  priority: "core",
  question: "How do sessions end, how long do they live, and how often is work still open when they do?",
  owner: "src/server/telemetry/sessions.ts",
  audience: AUDIENCE_ALL,
  facts: z
    .object({
      /**
       * `kill_requested` only when an explicit stop was observed from an owner; `unknown` is
       * the honest answer for everything else, and is deliberately not narrowed by guessing.
       */
      reason: z.enum(["kill_requested", "handoff", "shutdown", "unknown"]),
      agent: z.enum([...AGENT_TYPES, "unknown", "unsupported"]),
      runtime: z.enum([...SESSION_RUNTIMES, "unknown", "unsupported"]),
      task_kind: z.enum([...TASK_KINDS, "none", "unknown", "unsupported"]),
      /** True when a task bound to this session was still open at removal. Not a failure. */
      ended_while_work_open: z.boolean(),
      /** How long this installation OBSERVED the session, which is not its lifetime when it was adopted. */
      observed_ms: z.number().int().min(0),
      /** True when observation started after the session did, or was interrupted mid-life. */
      observation_bounded: z.boolean(),
    })
    .strict(),
  refKeys: ["session_id", "task_id", "conversation_id"],
  ingress: null,
  span: {
    name: "mission.session.end",
    kind: "internal",
    durationFactKey: "observed_ms",
    attributes: [
      "reason",
      "agent",
      "runtime",
      "task_kind",
      "ended_while_work_open",
      "observation_bounded",
    ],
    refAttributes: ["session_id", "task_id"],
    // A session ending is not an error. Whether the WORK failed is a different fact, with a
    // different owner, and marking every ending red would make the trace view useless.
    errorWhen: null,
  },
});

/**
 * Somebody asked for a session to stop.
 *
 * An ACTION, captured before any ending and independently of whether one follows. P2's
 * table requires the two be orthogonal: a kill request that the agent survives, and a
 * session that vanishes with no request, are both real and neither implies the other.
 */
export const SESSION_KILL_REQUESTED_EVENT = defineEvent({
  name: "mission.session.kill.requested",
  version: 1,
  group: "session_lifecycle",
  priority: "breadth",
  question: "How often do operators and automation stop sessions deliberately?",
  owner: "src/server/routes.ts",
  audience: AUDIENCE_ALL,
  facts: z
    .object({
      agent: z.enum([...AGENT_TYPES, "unknown", "unsupported"]),
      runtime: z.enum([...SESSION_RUNTIMES, "unknown", "unsupported"]),
      outcome: z.enum(["accepted", "refused"]),
      actor_basis: z.enum(TELEMETRY_ACTOR_BASES),
    })
    .strict(),
  refKeys: ["session_id", "operation_id", "task_id"],
  ingress: null,
  span: {
    name: "mission.session.kill",
    kind: "internal",
    durationFactKey: null,
    attributes: ["agent", "runtime", "outcome", "actor_basis"],
    refAttributes: ["session_id", "operation_id"],
    errorWhen: { factKey: "outcome", values: ["refused"] },
  },
});

/**
 * Canonical usage, projected ONCE from the ledger that already deduplicated it.
 *
 * From the ledger writers rather than from a transcript or an inbound OTLP report, which is
 * what stops the same tokens being counted twice: Claude Code exports its own OTLP cost
 * AND writes driver rows, and summing both would roughly double a supervised session.
 *
 * `usage_origin` keeps authoring and automation apart, because they answer different
 * questions and one total that mixes them answers neither. `cost_basis` carries the
 * estimator's provenance: both priced variants are API-EQUIVALENT estimates and neither is
 * subscription billing, which is a distinction a dashboard must never quietly drop.
 */
export const USAGE_RECORDED_EVENT = defineEvent({
  name: "mission.usage.recorded",
  version: 1,
  group: "model_effort",
  priority: "core",
  question: "What do sessions and automation actually spend, by model, and how well is it known?",
  owner: "src/server/telemetry/sessions.ts",
  audience: AUDIENCE_ALL,
  facts: z
    .object({
      /** `authoring` is a session's own conversation; `automation` is a headless run with no card. */
      usage_origin: z.enum(["authoring", "automation"]),
      /** `reported` means the harness did the arithmetic; `api-equivalent` means we did; `unpriced` means nobody could. */
      cost_basis: z.enum(["reported", "api-equivalent", "unpriced"]),
      model_id: z.string(),
      input: z.number().int().min(0),
      output: z.number().int().min(0),
      reasoning_output: z.number().int().min(0),
      cache_read: z.number().int().min(0),
      cache_write: z.number().int().min(0),
      cost_usd: z.number().min(0),
    })
    .strict(),
  refKeys: ["session_id", "conversation_id", "segment_id", "task_id"],
  ingress: null,
  // No span. A usage row is an accounting fact with no interval of its own, and inventing a
  // zero-duration span per request would flood the trace backend with points nobody queries.
  span: null,
});

/**
 * A task reached a terminal state, with an explicit statement of what is KNOWN about it.
 *
 * `completion_evidence` is the field this event exists for. `TaskManager` settles a departed
 * task as `failed` while documenting that a clean exit cannot be told from a crash, and
 * exporting that as a measured correctness failure would be a lie told by a dashboard. The
 * two travel together, always, so a consumer that wants "tasks that verifiably failed" has
 * to say so.
 */
export const TASK_OUTCOME_EVENT = defineEvent({
  name: "mission.task.outcome",
  version: 1,
  group: "task_outcome",
  priority: "core",
  question: "How do tasks of each kind end, and how much of that is actually known?",
  owner: "src/server/telemetry/sessions.ts",
  audience: AUDIENCE_ALL,
  facts: z
    .object({
      task_kind: z.enum([...TASK_KINDS, "unknown", "unsupported"]),
      status: z.enum(["done", "failed", "cancelled"]),
      /**
       * `recorded` means an owner wrote an outcome; `missing` means the agent departed and
       * nothing did; `unknown` covers everything this observation cannot distinguish.
       */
      completion_evidence: z.enum(["recorded", "missing", "unknown"]),
      /** One task, however many repositories it touched. Counters must not multiply by this. */
      repo_count: z.number().int().min(0).max(64),
      /** Observed wall time from dispatch to this outcome, or 0 when the dispatch was never seen. */
      duration_ms: z.number().int().min(0),
      observation_bounded: z.boolean(),
    })
    .strict(),
  refKeys: ["task_id", "session_id"],
  ingress: null,
  span: {
    name: "mission.task.outcome",
    kind: "internal",
    durationFactKey: "duration_ms",
    attributes: [
      "task_kind",
      "status",
      "completion_evidence",
      "repo_count",
      "observation_bounded",
    ],
    refAttributes: ["task_id", "session_id"],
    // Deliberately NOT an error for `failed`. A failed task with `completion_evidence:
    // missing` is an unknown, and colouring it red in Tempo would assert the very thing the
    // evidence field exists to withhold.
    errorWhen: null,
  },
});

/**
 * A VERIFIED per-repository pull request fact.
 *
 * Verified means an owner observed it: the durable work-episode ledger made the association,
 * or the poller read the state off the forge. An agent SAYING it opened a pull request, or a
 * requested action, satisfies neither.
 *
 * `delivery` is the late-outcome half. A merge observed after the session that produced it
 * was removed - and after its task binding was invalidated - is still that task's delivery,
 * and it arrives here with its ORIGINAL attribution rather than with today's context.
 *
 * No URL, owner, branch or commit anywhere in the schema or the refs. The pull request is
 * identified to the outside world by an opaque per-destination id; the URL stays local
 * polling metadata in the daemon's own table.
 */
export const PR_OBSERVED_EVENT = defineEvent({
  name: "mission.pr.observed",
  version: 1,
  group: "pr_outcome",
  priority: "core",
  question: "Does shipping work actually deliver pull requests, and do they land - including after the session is gone?",
  owner: "src/server/telemetry/pr-observations.ts",
  audience: AUDIENCE_ALL,
  facts: z
    .object({
      /** P2's vocabulary. `associated_existing` is not `creation_verified`; nothing collapses them. */
      fact: z.enum([
        "associated_existing",
        "creation_verified",
        "updated",
        "merged",
        "closed_unmerged",
      ]),
      task_kind: z.enum([...TASK_KINDS, "unknown", "unsupported"]),
      /** `primary` is the task's own repository; `secondary` is an attached one. */
      repo_role: z.enum(["primary", "secondary"]),
      /** `live` while the producing session still owned the binding; `late` after it did not. */
      delivery: z.enum(["live", "late"]),
      /** `unknown` when the forge would not say - never silently reported as private or public. */
      visibility: z.enum(["known", "unknown"]),
      /** Observed ms from first association to this fact. Zero on the association itself. */
      age_ms: z.number().int().min(0),
    })
    .strict(),
  refKeys: ["task_id", "repo_key", "pr_key", "session_id"],
  ingress: null,
  span: {
    name: "mission.pr.observed",
    kind: "internal",
    durationFactKey: null,
    attributes: ["fact", "task_kind", "repo_role", "delivery", "visibility"],
    refAttributes: ["task_id", "repo_key", "pr_key"],
    errorWhen: null,
  },
});

/** Every registered event, by name. */
export const TELEMETRY_EVENTS: Record<string, TelemetryEventDefinition> = Object.fromEntries(
  [
    ...SOURCE_EVENTS,
    DAEMON_STARTED_EVENT,
    TELEMETRY_PROBE_EVENT,
    TELEMETRY_CONTROL_EVENT,
    TELEMETRY_SETTINGS_OPENED_EVENT,
    SESSION_STARTED_EVENT,
    SESSION_RESTORE_EVENT,
    DISPATCH_FINISHED_EVENT,
    SESSION_SEGMENT_EVENT,
    EFFORT_SELECTED_EVENT,
    SESSION_OPERATION_EVENT,
    TURN_FINISHED_EVENT,
    SESSION_ENDED_EVENT,
    SESSION_KILL_REQUESTED_EVENT,
    USAGE_RECORDED_EVENT,
    TASK_OUTCOME_EVENT,
    PR_OBSERVED_EVENT,
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
  since: 1,
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
  since: 1,
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
  since: 1,
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
  since: 1,
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
  since: 1,
  owner: "src/shared/telemetry-catalog.ts",
  contribution: (facts) => ({
    dimensions: { collection_enabled: String(facts.collection_enabled === true) },
    value: 1,
  }),
});

// ---- Phase 3 instruments ----
//
// One instrument per question, and every dimension on this side of the line is a closed
// vocabulary. Model ids appear on exactly two of them - the usage pair, where "what does
// this model cost" IS the question - and nowhere else: multiplying a model list by agent,
// runtime, kind and outcome is the label cross-product P0 forbids, and those questions are
// answered from traces instead.

/** `unknown` rather than a dropped dimension. An unobserved value stays visible. */
function dim(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : TELEMETRY_UNKNOWN_VALUE;
}

// Only the shipped catalog bounds metric cardinality. Stored overrides and live discovery
// may contain arbitrarily many valid model ids, so they must never extend this set.
const METRIC_MODEL_IDS: ReadonlySet<string> = new Set(
  Object.values(MODEL_CATALOG).flatMap((models) => models.map((model) => model.id)),
);

/** Preserve detailed ids in source facts and traces; metrics use at most catalog size + 2. */
function modelDimension(value: unknown): string {
  const model = dim(value);
  return model === TELEMETRY_UNKNOWN_VALUE || METRIC_MODEL_IDS.has(model) ? model : "other";
}

export const SESSIONS_STARTED_METRIC = defineMetric({
  name: "mission.sessions.started",
  description: "Sessions observed starting, by how they came to exist and how much was witnessed.",
  unit: "1",
  kind: "counter",
  valueType: "int",
  event: SESSION_STARTED_EVENT.name,
  audience: AUDIENCE_ALL,
  dimensions: ["origin", "start_observation", "agent", "runtime", "task_kind"],
  boundaries: null,
  unknownPolicy: "explicit_unknown",
  since: 1,
  owner: "src/shared/telemetry-catalog.ts",
  contribution: (facts) => ({
    dimensions: {
      origin: dim(facts.origin),
      start_observation: dim(facts.start_observation),
      agent: dim(facts.agent),
      runtime: dim(facts.runtime),
      task_kind: dim(facts.task_kind),
    },
    value: 1,
  }),
});

export const SESSIONS_ENDED_METRIC = defineMetric({
  name: "mission.sessions.ended",
  description: "Session departures confirmed at durable removal, by reason and whether work was open.",
  unit: "1",
  kind: "counter",
  valueType: "int",
  event: SESSION_ENDED_EVENT.name,
  audience: AUDIENCE_ALL,
  dimensions: ["reason", "agent", "runtime", "task_kind", "ended_while_work_open"],
  boundaries: null,
  unknownPolicy: "explicit_unknown",
  since: 1,
  owner: "src/shared/telemetry-catalog.ts",
  contribution: (facts) => ({
    dimensions: {
      reason: dim(facts.reason),
      agent: dim(facts.agent),
      runtime: dim(facts.runtime),
      task_kind: dim(facts.task_kind),
      ended_while_work_open: String(facts.ended_while_work_open === true),
    },
    value: 1,
  }),
});

export const SESSION_OBSERVED_DURATION_METRIC = defineMetric({
  name: "mission.session.observed.duration",
  description: "How long this installation observed a session, from first sight to durable removal.",
  unit: "ms",
  kind: "histogram",
  valueType: "double",
  event: SESSION_ENDED_EVENT.name,
  audience: AUDIENCE_ALL,
  // `observation_bounded` is a dimension rather than a filter applied later, because a
  // bounded observation is a LOWER BOUND on a lifetime and mixing the two into one
  // distribution quietly understates the tail.
  dimensions: ["agent", "runtime", "observation_bounded"],
  boundaries: [1_000, 10_000, 60_000, 300_000, 900_000, 3_600_000, 14_400_000, 86_400_000],
  unknownPolicy: "explicit_unknown",
  since: 1,
  owner: "src/shared/telemetry-catalog.ts",
  contribution: (facts) => {
    const ms = typeof facts.observed_ms === "number" ? facts.observed_ms : null;
    if (ms === null) return null;
    return {
      dimensions: {
        agent: dim(facts.agent),
        runtime: dim(facts.runtime),
        observation_bounded: String(facts.observation_bounded === true),
      },
      value: ms,
    };
  },
});

export const SESSION_RESTORES_METRIC = defineMetric({
  name: "mission.session.restores",
  description: "Managed session restorations attempted across a daemon restart, by outcome.",
  unit: "1",
  kind: "counter",
  valueType: "int",
  event: SESSION_RESTORE_EVENT.name,
  audience: AUDIENCE_ALL,
  dimensions: ["outcome", "agent", "turn_in_progress"],
  boundaries: null,
  unknownPolicy: "explicit_unknown",
  since: 1,
  owner: "src/shared/telemetry-catalog.ts",
  contribution: (facts) => ({
    dimensions: {
      outcome: dim(facts.outcome),
      agent: dim(facts.agent),
      turn_in_progress: String(facts.turn_in_progress === true),
    },
    value: 1,
  }),
});

export const DISPATCHES_METRIC = defineMetric({
  name: "mission.dispatches",
  description: "Dispatch attempts, by outcome and by where the resolved model and effort came from.",
  unit: "1",
  kind: "counter",
  valueType: "int",
  event: DISPATCH_FINISHED_EVENT.name,
  audience: AUDIENCE_ALL,
  dimensions: ["outcome", "agent", "runtime", "task_kind", "resolution_source", "resolved_effort"],
  boundaries: null,
  unknownPolicy: "explicit_unknown",
  since: 1,
  owner: "src/shared/telemetry-catalog.ts",
  contribution: (facts) => ({
    dimensions: {
      outcome: dim(facts.outcome),
      agent: dim(facts.agent),
      runtime: dim(facts.runtime),
      task_kind: dim(facts.task_kind),
      resolution_source: dim(facts.resolution_source),
      resolved_effort: dim(facts.resolved_effort),
    },
    value: 1,
  }),
});

export const DISPATCH_DURATION_METRIC = defineMetric({
  name: "mission.dispatch.duration",
  description: "Wall time from dispatch admission to a running agent, or to the refusal that stopped it.",
  unit: "ms",
  kind: "histogram",
  valueType: "double",
  event: DISPATCH_FINISHED_EVENT.name,
  audience: AUDIENCE_ALL,
  dimensions: ["outcome", "agent", "runtime"],
  boundaries: [500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000, 120_000, 300_000],
  unknownPolicy: "explicit_unknown",
  since: 1,
  owner: "src/shared/telemetry-catalog.ts",
  contribution: (facts) => {
    const ms = typeof facts.duration_ms === "number" ? facts.duration_ms : null;
    if (ms === null) return null;
    return {
      dimensions: {
        outcome: dim(facts.outcome),
        agent: dim(facts.agent),
        runtime: dim(facts.runtime),
      },
      value: ms,
    };
  },
});

export const SESSION_SEGMENTS_METRIC = defineMetric({
  name: "mission.session.segments",
  description: "Execution segments opened, by the effective effort they carry and how well it is known.",
  unit: "1",
  kind: "counter",
  valueType: "int",
  event: SESSION_SEGMENT_EVENT.name,
  audience: AUDIENCE_ALL,
  dimensions: ["agent", "runtime", "effort", "quality", "reason"],
  boundaries: null,
  unknownPolicy: "explicit_unknown",
  since: 1,
  owner: "src/shared/telemetry-catalog.ts",
  contribution: (facts) => ({
    dimensions: {
      agent: dim(facts.agent),
      runtime: dim(facts.runtime),
      effort: dim(facts.effort),
      quality: dim(facts.quality),
      reason: dim(facts.reason),
    },
    value: 1,
  }),
});

export const EFFORT_SELECTIONS_METRIC = defineMetric({
  name: "mission.session.effort.selections",
  description: "Effort changes requested from a session, by outcome and when they take effect.",
  unit: "1",
  kind: "counter",
  valueType: "int",
  event: EFFORT_SELECTED_EVENT.name,
  audience: AUDIENCE_ALL,
  dimensions: ["requested_effort", "outcome", "applies", "agent", "runtime"],
  boundaries: null,
  unknownPolicy: "explicit_unknown",
  since: 1,
  owner: "src/shared/telemetry-catalog.ts",
  contribution: (facts) => ({
    dimensions: {
      requested_effort: dim(facts.requested_effort),
      outcome: dim(facts.outcome),
      applies: dim(facts.applies),
      agent: dim(facts.agent),
      runtime: dim(facts.runtime),
    },
    value: 1,
  }),
});

export const SESSION_OPERATIONS_METRIC = defineMetric({
  name: "mission.session.operations",
  description: "Conversation operations that reached a session, by kind, outcome and actor basis.",
  unit: "1",
  kind: "counter",
  valueType: "int",
  event: SESSION_OPERATION_EVENT.name,
  audience: AUDIENCE_ALL,
  dimensions: ["operation", "outcome", "agent", "runtime", "actor_basis"],
  boundaries: null,
  unknownPolicy: "explicit_unknown",
  since: 1,
  owner: "src/shared/telemetry-catalog.ts",
  contribution: (facts) => ({
    dimensions: {
      operation: dim(facts.operation),
      outcome: dim(facts.outcome),
      agent: dim(facts.agent),
      runtime: dim(facts.runtime),
      actor_basis: dim(facts.actor_basis),
    },
    value: 1,
  }),
});

export const SESSION_TURNS_METRIC = defineMetric({
  name: "mission.session.turns",
  description: "Turns observed finishing, attributed to the segment's effective effort.",
  unit: "1",
  kind: "counter",
  valueType: "int",
  event: TURN_FINISHED_EVENT.name,
  audience: AUDIENCE_ALL,
  dimensions: ["agent", "runtime", "effort", "quality", "outcome"],
  boundaries: null,
  unknownPolicy: "explicit_unknown",
  since: 1,
  owner: "src/shared/telemetry-catalog.ts",
  contribution: (facts) => ({
    dimensions: {
      agent: dim(facts.agent),
      runtime: dim(facts.runtime),
      effort: dim(facts.effort),
      quality: dim(facts.quality),
      outcome: dim(facts.outcome),
    },
    value: 1,
  }),
});

export const TURN_DURATION_METRIC = defineMetric({
  name: "mission.session.turn.duration",
  description: "Observed execution time of a finished turn, on the effort that actually ran it.",
  unit: "ms",
  kind: "histogram",
  valueType: "double",
  event: TURN_FINISHED_EVENT.name,
  audience: AUDIENCE_ALL,
  dimensions: ["agent", "runtime", "effort", "observation_bounded"],
  boundaries: [1_000, 5_000, 15_000, 30_000, 60_000, 180_000, 600_000, 1_800_000],
  unknownPolicy: "explicit_unknown",
  since: 1,
  owner: "src/shared/telemetry-catalog.ts",
  contribution: (facts) => {
    const ms = typeof facts.duration_ms === "number" ? facts.duration_ms : null;
    if (ms === null) return null;
    return {
      dimensions: {
        agent: dim(facts.agent),
        runtime: dim(facts.runtime),
        effort: dim(facts.effort),
        observation_bounded: String(facts.observation_bounded === true),
      },
      value: ms,
    };
  },
});

export const USAGE_TOKENS_METRIC = defineMetric({
  name: "mission.usage.tokens",
  description: "Billable tokens from the canonical ledger, separated by authoring and automation.",
  unit: "1",
  kind: "counter",
  valueType: "int",
  event: USAGE_RECORDED_EVENT.name,
  audience: AUDIENCE_ALL,
  // Both usage metrics share a closed model vocabulary: shipped catalog ids, other, unknown.
  dimensions: ["usage_origin", "model_id"],
  boundaries: null,
  unknownPolicy: "explicit_unknown",
  since: 1,
  owner: "src/shared/telemetry-catalog.ts",
  contribution: (facts) => {
    const total = ["input", "output", "reasoning_output", "cache_read", "cache_write"].reduce(
      (sum, key) => sum + (typeof facts[key] === "number" ? (facts[key] as number) : 0),
      0,
    );
    if (total <= 0) return null;
    return {
      dimensions: { usage_origin: dim(facts.usage_origin), model_id: modelDimension(facts.model_id) },
      value: total,
    };
  },
});

export const USAGE_COST_METRIC = defineMetric({
  name: "mission.usage.cost",
  description: "API-equivalent cost from the canonical ledger. Never subscription billing.",
  unit: "USD",
  kind: "counter",
  valueType: "double",
  event: USAGE_RECORDED_EVENT.name,
  audience: AUDIENCE_ALL,
  // `cost_basis` is a dimension so an unpriced row can never be silently added to a priced
  // total: `unpriced` contributes zero and stays countable as its own series.
  dimensions: ["usage_origin", "model_id", "cost_basis"],
  boundaries: null,
  unknownPolicy: "explicit_unknown",
  since: 1,
  owner: "src/shared/telemetry-catalog.ts",
  contribution: (facts) => ({
    dimensions: {
      usage_origin: dim(facts.usage_origin),
      model_id: modelDimension(facts.model_id),
      cost_basis: dim(facts.cost_basis),
    },
    value: typeof facts.cost_usd === "number" ? facts.cost_usd : 0,
  }),
});

export const TASK_OUTCOMES_METRIC = defineMetric({
  name: "mission.task.outcomes",
  description: "Tasks reaching a terminal state, with how much is actually known about the ending.",
  unit: "1",
  kind: "counter",
  valueType: "int",
  event: TASK_OUTCOME_EVENT.name,
  audience: AUDIENCE_ALL,
  // ONE per task, whatever its repository count - `repo_count` is deliberately not a
  // dimension here. A multi-repo task counted once per repository would inflate every
  // completion rate in proportion to how many repositories somebody attached.
  dimensions: ["task_kind", "status", "completion_evidence"],
  boundaries: null,
  unknownPolicy: "explicit_unknown",
  since: 1,
  owner: "src/shared/telemetry-catalog.ts",
  contribution: (facts) => ({
    dimensions: {
      task_kind: dim(facts.task_kind),
      status: dim(facts.status),
      completion_evidence: dim(facts.completion_evidence),
    },
    value: 1,
  }),
});

export const PR_OBSERVATIONS_METRIC = defineMetric({
  name: "mission.pr.observations",
  description: "Verified per-repository pull request facts, including ones observed after the session ended.",
  unit: "1",
  kind: "counter",
  valueType: "int",
  event: PR_OBSERVED_EVENT.name,
  audience: AUDIENCE_ALL,
  dimensions: ["fact", "task_kind", "repo_role", "delivery", "visibility"],
  boundaries: null,
  unknownPolicy: "explicit_unknown",
  since: 1,
  owner: "src/shared/telemetry-catalog.ts",
  contribution: (facts) => ({
    dimensions: {
      fact: dim(facts.fact),
      task_kind: dim(facts.task_kind),
      repo_role: dim(facts.repo_role),
      delivery: dim(facts.delivery),
      visibility: dim(facts.visibility),
    },
    value: 1,
  }),
});

/** Every registered instrument, by name. */
export const TELEMETRY_METRICS: Record<string, TelemetryMetricDefinition> = Object.fromEntries(
  [
    ...SOURCE_METRICS,
    ...ANALYTICAL_METRICS,
    DAEMON_STARTS_METRIC,
    DAEMON_STARTUP_DURATION_METRIC,
    TELEMETRY_PROBES_METRIC,
    TELEMETRY_CONTROLS_METRIC,
    TELEMETRY_SETTINGS_OPENS_METRIC,
    SESSIONS_STARTED_METRIC,
    SESSIONS_ENDED_METRIC,
    SESSION_OBSERVED_DURATION_METRIC,
    SESSION_RESTORES_METRIC,
    DISPATCHES_METRIC,
    DISPATCH_DURATION_METRIC,
    SESSION_SEGMENTS_METRIC,
    EFFORT_SELECTIONS_METRIC,
    SESSION_OPERATIONS_METRIC,
    SESSION_TURNS_METRIC,
    TURN_DURATION_METRIC,
    USAGE_TOKENS_METRIC,
    USAGE_COST_METRIC,
    TASK_OUTCOMES_METRIC,
    PR_OBSERVATIONS_METRIC,
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
