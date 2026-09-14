/**
 * The two extension seams later phases add through, and nothing else.
 *
 * They are deliberately separate. A SOURCE produces facts - Phase 3's session lifecycle,
 * Phase 4's workflow semantics, Phase 5's action manifest all register here and call
 * `capture`. A PROJECTION consumes them - Phase 1's catalog projection turns events into the
 * declared instruments, and Phase 6's analytical reducers maintain bounded cohort state
 * through the same entry point without owning a second writer or a second migration path.
 *
 * Keeping them apart is what lets Phases 5 and 6 be concurrent: their write sets do not
 * overlap because neither registers into the other's table.
 */
import type { TelemetryProfileId } from "@shared/telemetry.ts";
import type { TelemetrySpanKind } from "@shared/telemetry-catalog.ts";
import type { StoredTelemetryEvent } from "./store.ts";

// ---- what a projection may emit ----

/** A completed span descriptor. Serialized later, possibly after a restart. */
export interface EmittedSpan {
  name: string;
  kind: TelemetrySpanKind;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  /** Epoch ms. The ORIGINAL times, never the time the journal happened to be drained. */
  startTime: number;
  endTime: number;
  status: "unset" | "ok" | "error";
  statusMessage: string | null;
  attributes: Record<string, string | number | boolean>;
}

/**
 * The only way a projection produces output.
 *
 * `metric` names a catalog instrument; the engine validates the name and the dimension
 * allowlist and records a gap rather than throwing when a projection gets it wrong. A
 * projection cannot write a row, open a transaction, or reach the network.
 */
export interface TelemetryEmitter {
  metric(instrument: string, dimensions: Record<string, string>, value: number): void;
  span(span: EmittedSpan): void;
}

// ---- projections ----

export interface TelemetryProjectionContext {
  profile: TelemetryProfileId;
  policyEpoch: number;
  /** Wall clock for this pass. Injected so a fixture can freeze it. */
  now: number;
}

/**
 * A bounded, versioned, checkpointed reducer over the journal.
 *
 * `reduce` is called once per event per eligible profile, in sequence order, inside the
 * projection transaction. It must be pure with respect to everything except the state it
 * returns and what it emits: the whole replay contract rests on the same events producing the
 * same output.
 */
export interface TelemetryProjection<State = unknown> {
  /** Namespaced, e.g. `mission.catalog`. Owns its own state rows under this id. */
  id: string;
  /** Bumped when `State`'s shape changes. `migrateState` is how an old row survives. */
  stateVersion: number;
  initialState(): State;
  /**
   * Bring state written by an older build forward, or return null to start over.
   *
   * Returning null is allowed and is not a silent reset: the engine records a
   * `unsupported_schema` gap so the loss is visible rather than inferred from a chart that
   * suddenly starts at zero.
   */
  migrateState(state: unknown, fromVersion: number): State | null;
  reduce(
    event: StoredTelemetryEvent,
    state: State,
    emit: TelemetryEmitter,
    ctx: TelemetryProjectionContext,
  ): State;
  /**
   * Called once at the end of a pass that consumed anything, after the last `reduce`.
   *
   * This is the gauge seam. A counter is emitted as it happens; a cohort snapshot is a
   * calculation over accumulated state and has no single contributing event, so Phase 6's
   * reducers publish theirs here.
   */
  snapshot?(state: State, emit: TelemetryEmitter, ctx: TelemetryProjectionContext): void;
}

const projections = new Map<string, TelemetryProjection<never>>();

/**
 * Register a projection.
 *
 * Idempotent for the SAME implementation - the daemon entry, `startTelemetry` and a focused
 * test all reach the built-ins, and a duplicate registration would otherwise double every
 * count. A DIFFERENT implementation under an id already taken is refused, because these ids are
 * the persisted-state namespace: `telemetry_projection_state` rows are keyed by them, so a
 * silent replacement would hand one projection another's checkpoint and reducer state, and
 * which implementation won would depend on import order.
 */
export function registerTelemetryProjection<State>(projection: TelemetryProjection<State>): void {
  claim(projections, projection.id, projection as unknown as TelemetryProjection<never>, "projection");
}

/** Registered projections in a stable order, so replays run them the same way every time. */
export function registeredProjections(): TelemetryProjection<never>[] {
  return [...projections.values()].sort((a, b) => a.id.localeCompare(b.id));
}

// ---- sources ----

/**
 * A source of facts, and an honest statement of what it can and cannot recover.
 *
 * `recovers` is not decoration. P1 requires every source adapter to say what it can rebuild
 * after a restart and what simply becomes unknown, because a post-restart scan of a current
 * Session cannot reconstruct the model it was running an hour ago. Writing that down at the
 * registration site is what keeps the next phase from assuming otherwise.
 */
export interface TelemetrySource {
  /** Namespaced owner id, matching the `kind` of the identities it captures under. */
  id: string;
  /** Plain-language list of what a reconciliation pass can recover. May be empty. */
  recovers: readonly string[];
  /** What is permanently unknown after a crash for this source. May be empty. */
  unrecoverable: readonly string[];
  /** Hard ceiling on durable rows one reconciliation tick may scan. */
  maxScanPerTick: number;
  /**
   * Recover missed facts from durable authoritative records. Bounded and idempotent - it
   * captures through the same deduplicated path, so running it twice records nothing twice.
   */
  reconcile?: (now: number) => void | Promise<void>;
}

const sources = new Map<string, TelemetrySource>();

/**
 * Register a source. Same rule, same reason: the id is the `source_kind` half of every dedupe
 * identity this owner writes, so two owners sharing one id would deduplicate each other's facts.
 */
export function registerTelemetrySource(source: TelemetrySource): void {
  claim(sources, source.id, source, "source");
}

/**
 * Take a namespace, or refuse.
 *
 * A THROW rather than a warning, and deliberately unlike `telemetryCatalogProblems`, which
 * reports rather than throws. That one validates a large data table at import time, where a
 * typo taking the daemon down would be the worse trade. This is one explicit call made once at
 * startup by the author of a phase, and the failure it prevents is silent state corruption
 * across a phase boundary - so it should stop a build, and a test will always see it first.
 */
function claim<T>(registry: Map<string, T>, id: string, value: T, kind: string): void {
  const existing = registry.get(id);
  if (existing !== undefined && existing !== value) {
    throw new Error(
      `telemetry ${kind} id "${id}" is already registered by a different implementation. ` +
        "These ids namespace persisted projection state and source dedupe identities, so two " +
        "owners cannot share one. Pick a different id.",
    );
  }
  registry.set(id, value);
}

export function registeredSources(): TelemetrySource[] {
  return [...sources.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Test-only: drop every registration so one file's fixtures cannot leak into another's. */
export function resetTelemetryRegistrations(): void {
  projections.clear();
  sources.clear();
}
