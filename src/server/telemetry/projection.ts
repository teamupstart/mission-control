/**
 * The journal-to-outbox engine, and the built-in projection that applies the metric catalog.
 *
 * One pass, per projection, per profile, in ONE transaction: read a bounded slice of the
 * journal, reduce it, update durable cumulative state, write immutable export batches, advance
 * the checkpoint. All of it commits together or none of it does, which is what makes a crash
 * mid-pass a replay of the same slice rather than a silently skipped one.
 *
 * Two rules are load-bearing and easy to lose:
 *
 * - **No network I/O in here.** Wire serialization happens in `otlp.ts`, outside, from the
 *   committed batch. A batch row is a persisted pending descriptor exactly so that moving the
 *   expensive part outside the transaction cannot advance a checkpoint without its output.
 * - **The journal is processed once.** Cumulative totals live in `telemetry_series` and
 *   survive restarts; retries operate on batches. Nothing ever replays events through a live
 *   counter, which is the failure mode that would double every metric on every reboot.
 */
import {
  TELEMETRY_CATALOG_VERSION,
  TELEMETRY_ENVELOPE_VERSION,
  TELEMETRY_LIMITS,
  TELEMETRY_OVERFLOW_VALUE,
  TELEMETRY_UNKNOWN_VALUE,
  type TelemetryEnvelope,
  type TelemetryProfileId,
} from "@shared/telemetry.ts";
import {
  TELEMETRY_EVENTS,
  TELEMETRY_METRICS,
  metricsForEvent,
  type TelemetrySpanKind,
} from "@shared/telemetry-catalog.ts";
import { randomUUID } from "node:crypto";
import {
  capturingProfiles,
  getTelemetryConfig,
  profileProducesBatches,
  profileSalt,
} from "./config.ts";
import { digest } from "./identity.ts";
import { PARENT_SPAN_REF, SPAN_REF, TRACE_REF, boundString, resourceAttributes } from "./capture.ts";
import {
  registeredProjections,
  type EmittedSpan,
  type TelemetryEmitter,
  type TelemetryProjection,
} from "./registration.ts";
import {
  getDestination,
  getProjectionState,
  getResource,
  getSeries,
  insertBatch,
  journalHead,
  putProjectionState,
  putResource,
  putSeries,
  readJournalAfter,
  recordGap,
  seriesCountForInstrument,
  seriesCountForProfile,
  telemetryTransaction,
  type StoredHistogram,
  type StoredSeries,
  type StoredTelemetryEvent,
} from "./store.ts";

/** The instrumentation scope every Mission Control signal is published under. */
export const TELEMETRY_SCOPE = { name: "mission-control", version: String(TELEMETRY_CATALOG_VERSION) };

// ---- batch payload shapes ----
//
// The durable DTO, not the wire format. Keeping them separate is what lets a batch queued by
// an older build be serialized by a newer one without re-aggregating it.

export interface MetricPointDto {
  name: string;
  description: string;
  unit: string;
  kind: "counter" | "histogram" | "gauge";
  valueType: "int" | "double";
  /** Epoch ms. Preserved from the stream, never the drain time. */
  startTimeMs: number;
  endTimeMs: number;
  attributes: Record<string, string>;
  value: number;
  histogram: {
    count: number;
    sum: number;
    min: number | null;
    max: number | null;
    boundaries: number[];
    /** One count per boundary plus the final `+Inf` bucket. */
    buckets: number[];
  } | null;
}

export interface MetricsBatchPayload {
  resource: Record<string, string>;
  scope: { name: string; version: string };
  metrics: MetricPointDto[];
}

export interface SpanDto {
  name: string;
  kind: TelemetrySpanKind;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  startTimeMs: number;
  endTimeMs: number;
  status: "unset" | "ok" | "error";
  statusMessage: string | null;
  attributes: Record<string, string | number | boolean>;
}

export interface TracesBatchPayload {
  resource: Record<string, string>;
  scope: { name: string; version: string };
  spans: SpanDto[];
}

// ---- the built-in catalog projection ----

/**
 * Turns declared events into declared instruments and completed spans.
 *
 * Stateless beyond its checkpoint, and that is deliberate rather than lazy: cumulative totals
 * belong in `telemetry_series`, where they are keyed by resource and consent epoch and can be
 * read, capped and pruned. Duplicating them into a JSON blob would create a second source of
 * truth for the same number.
 */
export const CATALOG_PROJECTION: TelemetryProjection<Record<string, never>> = {
  id: "mission.catalog",
  stateVersion: 1,
  initialState: () => ({}),
  migrateState: (state, fromVersion) => (fromVersion === 1 ? (state as Record<string, never>) : null),
  reduce(event, state, emit) {
    for (const metric of metricsForEvent(event.name)) {
      const contribution = metric.contribution(event.facts, event);
      if (!contribution) continue;
      emit.metric(metric.name, contribution.dimensions, contribution.value);
    }
    const definition = TELEMETRY_EVENTS[event.name];
    const span = definition?.span;
    if (span) {
      const durationMs =
        span.durationFactKey && typeof event.facts[span.durationFactKey] === "number"
          ? Math.max(0, event.facts[span.durationFactKey] as number)
          : 0;
      const attributes: Record<string, string | number | boolean> = {
        "mission.event.name": event.name,
        "mission.event.version": event.eventVersion,
        "mission.actor.kind": event.actor.kind,
        "mission.actor.origin": event.actor.origin,
        "mission.actor.basis": event.actor.basis,
      };
      for (const key of span.attributes) {
        const value = event.facts[key];
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          attributes[`mission.${key}`] = value;
        }
      }
      emit.span({
        name: span.name,
        kind: span.kind,
        traceId: event.refs[TRACE_REF] ?? "",
        spanId: event.refs[SPAN_REF] ?? "",
        parentSpanId: event.refs[PARENT_SPAN_REF] ?? null,
        // The ORIGINAL window. An operation that ran an hour ago and drained now is searchable
        // at the time it ran, which is the whole point of persisting a descriptor instead of
        // holding an SDK span open.
        startTime: event.occurredAt - durationMs,
        endTime: event.occurredAt,
        status: "unset",
        statusMessage: null,
        attributes,
        // Ref promotion happens in the engine, where the per-profile salt is known: the same
        // session must not carry the same exported id to two audiences.
      });
    }
    return state;
  },
};

function envelopeOf(event: StoredTelemetryEvent): TelemetryEnvelope {
  return {
    envelopeVersion: TELEMETRY_ENVELOPE_VERSION,
    eventId: event.eventId,
    name: event.name,
    eventVersion: event.eventVersion,
    occurredAt: event.occurredAt,
    observedAt: event.observedAt,
    resourceId: event.resourceId,
    contextId: event.contextId,
    actor: event.actor,
    refs: event.refs,
    refsOmitted: event.refsOmitted,
    contextOmitted: event.contextOmitted,
    facts: event.facts,
  };
}

// ---- the engine ----

export interface ProjectionPassResult {
  consumed: number;
  batches: number;
  spans: number;
}

/**
 * Run every registered projection over every capturing profile, once.
 *
 * Returns how much work it did so a caller can loop until drained without guessing. Bounded by
 * `projectionBatchSize` per projection and profile, so one pass is one bounded transaction
 * however long the daemon was offline.
 */
export function runProjectionPass(now = Date.now()): ProjectionPassResult {
  const config = getTelemetryConfig();
  const result: ProjectionPassResult = { consumed: 0, batches: 0, spans: 0 };
  if (!config.enabled) return result;

  for (const projection of registeredProjections()) {
    for (const profile of capturingProfiles(config)) {
      const one = runOne(projection, profile, profileProducesBatches(config, profile), now);
      result.consumed += one.consumed;
      result.batches += one.batches;
      result.spans += one.spans;
    }
  }
  return result;
}

function runOne(
  projection: TelemetryProjection<never>,
  profile: TelemetryProfileId,
  producesBatches: boolean,
  now: number,
): ProjectionPassResult {
  return telemetryTransaction((d) => {
    const destination = getDestination(d, profile);
    const stored = getProjectionState(d, projection.id, profile);

    let state: unknown;
    let consumedSeq: number;
    if (!stored) {
      // A projection meeting a profile for the first time starts at the journal HEAD, not at
      // zero. This is the "enabling authorizes new data from that point" rule in one line: a
      // fresh opt-in inherits no history, and a re-enable after a withdrawal cannot replay the
      // facts that withdrawal purged.
      state = projection.initialState();
      consumedSeq = journalHead(d);
    } else if (stored.stateVersion === projection.stateVersion) {
      state = stored.state;
      consumedSeq = stored.consumedSeq;
    } else {
      const migrated = projection.migrateState(stored.state, stored.stateVersion);
      if (migrated === null) {
        recordGap(
          d,
          "unsupported_schema",
          `${projection.id} state v${stored.stateVersion} could not be migrated`,
          now,
        );
        state = projection.initialState();
      } else {
        state = migrated;
      }
      consumedSeq = stored.consumedSeq;
    }

    const events = readJournalAfter(d, consumedSeq, TELEMETRY_LIMITS.projectionBatchSize);
    if (events.length === 0) {
      // Still persist a first checkpoint, so the head we just chose survives a restart and a
      // later pass cannot rediscover an empty journal and reset to a newer head.
      if (!stored) {
        putProjectionState(
          d,
          projection.id,
          profile,
          { stateVersion: projection.stateVersion, consumedSeq, state },
          now,
        );
      }
      return { consumed: 0, batches: 0, spans: 0 };
    }

    const collector = new Collector(profile, destination.policyEpoch, now);
    let highest = consumedSeq;
    for (const event of events) {
      highest = event.seq;
      if (!event.profiles.includes(profile)) continue;
      // A fact captured under a previous consent epoch does not join this one's streams.
      if (event.epochs[profile] !== destination.policyEpoch) continue;
      // Converted HERE, once, so nothing registered through the extension seam ever sees the
      // stored row. `seq`, `profiles` and `epochs` are read above and stay behind.
      const envelope = envelopeOf(event);
      collector.beginEvent(envelope);
      state = (projection as TelemetryProjection<unknown>).reduce(
        envelope,
        state,
        collector,
        { profile, policyEpoch: destination.policyEpoch, now },
      );
    }
    collector.endEvent();
    (projection as TelemetryProjection<unknown>).snapshot?.(state, collector, {
      profile,
      policyEpoch: destination.policyEpoch,
      now,
    });

    const applied = collector.apply(d, producesBatches);

    putProjectionState(
      d,
      projection.id,
      profile,
      { stateVersion: projection.stateVersion, consumedSeq: highest, state },
      now,
    );

    return { consumed: events.length, batches: applied.batches, spans: applied.spans };
  });
}

interface PendingMetric {
  instrument: string;
  resourceId: string;
  dimensions: Record<string, string>;
  value: number;
  /**
   * The contributing event's `occurredAt`, captured HERE rather than read back during `apply`.
   *
   * Load-bearing. `apply` runs after the event loop has finished, so anything that reaches for
   * "the current event" at that point finds nothing and falls back to the projection clock -
   * which silently stamps a fact accepted before a crash, and projected after the restart, as
   * having happened at restart time. That is precisely the original-time attribution the whole
   * design promises, lost in the one case it exists for.
   */
  occurredAt: number;
}

/**
 * Gathers one pass's output, then applies it in the same transaction.
 *
 * It exists so `reduce` can stay a pure function that "emits", while the ordering, the series
 * ceilings, the overflow folding and the batch construction all happen in one place that knows
 * about the database.
 */
class Collector implements TelemetryEmitter {
  private readonly metrics: PendingMetric[] = [];
  private readonly spans: Array<{ span: EmittedSpan; resourceId: string }> = [];
  private current: TelemetryEnvelope | null = null;
  private readonly salt: string;
  private readonly problems: string[] = [];

  constructor(
    private readonly profile: TelemetryProfileId,
    private readonly policyEpoch: number,
    private readonly now: number,
  ) {
    this.salt = profileSalt(profile);
  }

  beginEvent(event: TelemetryEnvelope): void {
    this.current = event;
  }

  endEvent(): void {
    this.current = null;
  }

  metric(instrument: string, dimensions: Record<string, string>, value: number): void {
    const definition = TELEMETRY_METRICS[instrument];
    if (!definition) {
      this.problems.push(`unknown instrument ${instrument}`);
      return;
    }
    if (!definition.audience.includes(this.profile)) return;
    if (!Number.isFinite(value)) {
      this.problems.push(`${instrument} emitted a non-finite value`);
      return;
    }
    const bounded: Record<string, string> = {};
    for (const key of definition.dimensions) {
      const raw = dimensions[key];
      // `boundString`, not `slice`. Slicing by UTF-16 code units gets both halves wrong: for
      // multi-byte text it can still exceed the 256-byte budget, and a cut between the halves
      // of a surrogate pair leaves a lone surrogate that is not valid UTF-8 for the protobuf
      // encoder. Phase 1's own two instruments only ever pass short enum strings, but this is
      // the seam later phases emit COMPUTED dimension values through.
      bounded[key] =
        typeof raw === "string" && raw.length > 0 ? boundString(raw) : TELEMETRY_UNKNOWN_VALUE;
    }
    for (const key of Object.keys(dimensions)) {
      // A dimension outside the allowlist is a catalog defect in the emitting projection. Drop
      // it and say so rather than letting an unbudgeted label reach a backend.
      if (!definition.dimensions.includes(key)) {
        this.problems.push(`${instrument} emitted undeclared dimension ${key}`);
      }
    }
    this.metrics.push({
      instrument,
      resourceId: this.current?.resourceId ?? "",
      dimensions: bounded,
      value,
      // Read while the event is still current. A `snapshot` gauge has no contributing event and
      // legitimately carries the projection clock; everything else carries when it happened.
      occurredAt: this.current?.occurredAt ?? this.now,
    });
  }

  span(span: EmittedSpan): void {
    if (span.traceId === "" || span.spanId === "") {
      this.problems.push(`${span.name} emitted without correlation ids`);
      return;
    }
    // Per-profile translation. The same underlying operation reaches two audiences under two
    // unrelated ids, so holders of one cannot join it to the other.
    this.spans.push({
      span: {
        ...span,
        traceId: scopedTraceId(this.profile, this.salt, span.traceId),
        spanId: scopedSpanId(this.profile, this.salt, span.spanId),
        parentSpanId: span.parentSpanId
          ? scopedSpanId(this.profile, this.salt, span.parentSpanId)
          : null,
      },
      // The resource of the event that produced it, so a span queued before an upgrade is
      // exported under the version that actually ran it.
      resourceId: this.current?.resourceId ?? "",
    });
  }

  /** Fold this pass into durable series, then build the immutable batches it implies. */
  apply(
    d: import("node:sqlite").DatabaseSync,
    producesBatches: boolean,
  ): { batches: number; spans: number } {
    for (const problem of this.problems) {
      recordGap(d, "unsupported_schema", problem, this.now);
    }

    // Anything emitted OUTSIDE the event loop has no contributing event to take a resource
    // from, because `endEvent` cleared it before `snapshot` ran. That is not a defect in the
    // emitter: a cohort gauge is a statement about this installation NOW, so the running
    // process's own resource is the right one - and the alternative, whatever event happened to
    // be last in the pass, would attribute a fresh calculation to an arbitrary old app version.
    //
    // Resolved BEFORE the fold, so the durable series row and the export batch are keyed by the
    // same resource. Leaving it empty stored the series happily and then silently skipped its
    // batch below, since no resource row can ever have id "" - a metric durably recorded and
    // permanently unexportable, with nothing in `telemetry_gaps` to say so.
    let processResourceId: string | null = null;
    const processResource = (): string => {
      processResourceId ??= putResource(d, resourceAttributes(), this.now);
      return processResourceId;
    };
    for (const pending of this.metrics) {
      if (pending.resourceId === "") pending.resourceId = processResource();
    }
    for (const entry of this.spans) {
      if (entry.resourceId === "") entry.resourceId = processResource();
    }

    const touched = new Map<string, StoredSeries>();
    for (const pending of this.metrics) {
      const updated = this.fold(d, pending);
      if (updated) touched.set(seriesCacheKey(updated), updated);
    }

    if (!producesBatches) return { batches: 0, spans: 0 };

    let batches = 0;
    // One batch per resource, because an OTLP request carries exactly one resource - and
    // mixing an upgraded binary's points into the previous version's resource is the exact
    // misattribution this whole design exists to prevent.
    const byResource = new Map<string, StoredSeries[]>();
    for (const series of touched.values()) {
      const list = byResource.get(series.resourceId) ?? [];
      list.push(series);
      byResource.set(series.resourceId, list);
    }
    for (const [resourceId, list] of byResource) {
      const resource = getResource(d, resourceId);
      if (!resource) {
        // Belt to the braces above. An unaddressable series cannot be put in an OTLP request at
        // all, so it is permanent export loss - and the one thing this facility may never do is
        // let loss happen without counting it.
        recordGap(
          d,
          "permanently_rejected",
          `${list.length} metric series have no addressable resource`,
          this.now,
        );
        continue;
      }
      const payload: MetricsBatchPayload = {
        resource,
        scope: TELEMETRY_SCOPE,
        metrics: list.map((series) => toPoint(series)),
      };
      batches += this.writeBatch(d, "metrics", payload, list.length, oldestOf(list));
    }

    const spansByResource = new Map<string, EmittedSpan[]>();
    for (const { span, resourceId } of this.spans) {
      const list = spansByResource.get(resourceId) ?? [];
      list.push(span);
      spansByResource.set(resourceId, list);
    }
    for (const [resourceId, list] of spansByResource) {
      const resource = getResource(d, resourceId);
      if (!resource) {
        recordGap(
          d,
          "permanently_rejected",
          `${list.length} span(s) have no addressable resource`,
          this.now,
        );
        continue;
      }
      const payload: TracesBatchPayload = {
        resource,
        scope: TELEMETRY_SCOPE,
        spans: list.map((s) => ({
          name: s.name,
          kind: s.kind,
          traceId: s.traceId,
          spanId: s.spanId,
          parentSpanId: s.parentSpanId,
          startTimeMs: s.startTime,
          endTimeMs: s.endTime,
          status: s.status,
          statusMessage: s.statusMessage,
          attributes: s.attributes,
        })),
      };
      const oldest = Math.min(...list.map((s) => s.startTime));
      batches += this.writeBatch(d, "traces", payload, list.length, oldest);
    }

    return { batches, spans: this.spans.length };
  }

  private writeBatch(
    d: import("node:sqlite").DatabaseSync,
    signal: "metrics" | "traces",
    payload: MetricsBatchPayload | TracesBatchPayload,
    itemCount: number,
    oldestEventAt: number,
    // How many batch rows were persisted, not whether any were. A split writes several, and a
    // boolean made the pass report one however many it actually created.
  ): number {
    const destination = getDestination(d, this.profile);
    const json = JSON.stringify(payload);
    const bytes = Buffer.byteLength(json, "utf8");
    if (bytes > TELEMETRY_LIMITS.maxRequestBytes) {
      // SPLIT, rather than drop.
      //
      // Dropping here lost data for real: the checkpoint advances whether or not a batch was
      // written, so the events in this pass were consumed and their output thrown away. The
      // cumulative series survived that for metrics, but spans have nowhere else to live and
      // were gone.
      //
      // Splitting is safe now that every resource attribute is bounded at capture: each half
      // carries the same bounded resource, so halving the item list really does halve the
      // payload and the recursion terminates. The one case it cannot fix is a SINGLE item that
      // does not fit alone, which is counted as loss below.
      if (itemCount > 1) return this.writeSplitBatch(d, signal, payload, oldestEventAt);
      recordGap(
        d,
        "payload_expired",
        `one ${signal} item exceeds the ${TELEMETRY_LIMITS.maxRequestBytes} byte request limit`,
        this.now,
      );
      return 0;
    }
    insertBatch(
      d,
      {
        id: randomUUID(),
        profile: this.profile,
        signal,
        destinationGeneration: destination.generation,
        policyEpoch: this.policyEpoch,
        catalogVersion: TELEMETRY_CATALOG_VERSION,
        envelopeVersion: TELEMETRY_ENVELOPE_VERSION,
        payload,
        digest: digest(payload),
        itemCount,
        bytes,
        createdAt: this.now,
        oldestEventAt,
      },
      this.now,
    );
    return 1;
  }

  /**
   * Halve an oversized payload and write both halves, recursing until each fits.
   *
   * Both signals split cleanly: a metrics request is a list of independent data points and a
   * traces request a list of completed spans, so two requests carry exactly what one would
   * have. Order within a signal is preserved, which is what the cumulative stream needs.
   */
  private writeSplitBatch(
    d: import("node:sqlite").DatabaseSync,
    signal: "metrics" | "traces",
    payload: MetricsBatchPayload | TracesBatchPayload,
    oldestEventAt: number,
  ): number {
    if (signal === "metrics") {
      const full = payload as MetricsBatchPayload;
      const half = Math.floor(full.metrics.length / 2);
      const left = { ...full, metrics: full.metrics.slice(0, half) };
      const right = { ...full, metrics: full.metrics.slice(half) };
      return (
        this.writeBatch(d, signal, left, left.metrics.length, oldestEventAt) +
        this.writeBatch(d, signal, right, right.metrics.length, oldestEventAt)
      );
    }
    const full = payload as TracesBatchPayload;
    const half = Math.floor(full.spans.length / 2);
    const left = { ...full, spans: full.spans.slice(0, half) };
    const right = { ...full, spans: full.spans.slice(half) };
    return (
      this.writeBatch(d, signal, left, left.spans.length, oldestEventAt) +
      this.writeBatch(d, signal, right, right.spans.length, oldestEventAt)
    );
  }

  /** Apply one contribution to its durable cumulative stream, honouring the series ceilings. */
  private fold(d: import("node:sqlite").DatabaseSync, pending: PendingMetric): StoredSeries | null {
    const definition = TELEMETRY_METRICS[pending.instrument];
    if (!definition) return null;
    // From the contribution, NOT from `this.current` - by the time `apply` runs the event loop
    // has ended and `current` is null. See `PendingMetric.occurredAt`.
    const endTime = pending.occurredAt;

    let dimensions = pending.dimensions;
    let key = dimensionsKey(dimensions);
    const base = {
      profile: this.profile,
      policyEpoch: this.policyEpoch,
      resourceId: pending.resourceId,
      instrument: pending.instrument,
    };

    let existing = getSeries(d, { ...base, dimensionsKey: key });
    if (!existing) {
      const perInstrument = seriesCountForInstrument(
        d,
        this.profile,
        this.policyEpoch,
        pending.resourceId,
        pending.instrument,
      );
      const perProfile = seriesCountForProfile(d, this.profile);
      if (
        perInstrument >= TELEMETRY_LIMITS.maxSeriesPerInstrument ||
        perProfile >= TELEMETRY_LIMITS.maxSeriesPerProfile
      ) {
        // Fold into an explicit overflow bucket rather than dropping the contribution. The
        // total stays correct; only the breakdown degrades, and the gap says so.
        dimensions = Object.fromEntries(
          definition.dimensions.map((dim) => [dim, TELEMETRY_OVERFLOW_VALUE]),
        );
        key = dimensionsKey(dimensions);
        recordGap(d, "series_overflow", `${pending.instrument} exceeded its series budget`, this.now);
        existing = getSeries(d, { ...base, dimensionsKey: key });
      }
    }

    const next: StoredSeries = existing ?? {
      ...base,
      dimensionsKey: key,
      dimensions,
      catalogVersion: TELEMETRY_CATALOG_VERSION,
      kind: definition.kind,
      // The stream's start, written once and never rewritten. A restart continues this stream;
      // it does not open a new one with today's date on it.
      startTime: endTime,
      lastTime: endTime,
      value: 0,
      histogram:
        definition.kind === "histogram"
          ? {
              count: 0,
              sum: 0,
              min: null,
              max: null,
              buckets: Array.from({ length: (definition.boundaries?.length ?? 0) + 1 }, () => 0),
            }
          : null,
    };

    next.lastTime = Math.max(next.lastTime, endTime);
    if (definition.kind === "histogram") {
      next.histogram = addToHistogram(next.histogram, definition.boundaries ?? [], pending.value);
      next.value = next.histogram.sum;
    } else if (definition.kind === "gauge") {
      next.value = pending.value;
    } else {
      next.value += pending.value;
    }
    putSeries(d, next);
    return next;
  }
}

function addToHistogram(
  current: StoredHistogram | null,
  boundaries: readonly number[],
  value: number,
): StoredHistogram {
  const buckets = current ? [...current.buckets] : Array.from({ length: boundaries.length + 1 }, () => 0);
  let index = boundaries.length;
  for (let i = 0; i < boundaries.length; i += 1) {
    if (value <= (boundaries[i] as number)) {
      index = i;
      break;
    }
  }
  buckets[index] = (buckets[index] ?? 0) + 1;
  return {
    count: (current?.count ?? 0) + 1,
    sum: (current?.sum ?? 0) + value,
    min: current?.min === null || current?.min === undefined ? value : Math.min(current.min, value),
    max: current?.max === null || current?.max === undefined ? value : Math.max(current.max, value),
    buckets,
  };
}

function toPoint(series: StoredSeries): MetricPointDto {
  const definition = TELEMETRY_METRICS[series.instrument];
  return {
    name: series.instrument,
    description: definition?.description ?? "",
    unit: definition?.unit ?? "1",
    kind: series.kind,
    valueType: definition?.valueType ?? "double",
    startTimeMs: series.startTime,
    // The latest EVENT that contributed to this cumulative value, not the moment the projection
    // ran. Clamping this up to the projection clock was the other half of the same defect: a
    // week-old backlog drained today would have been exported as today's activity even though
    // every fact in it was a week old.
    endTimeMs: series.lastTime,
    attributes: series.dimensions,
    value: series.value,
    histogram: series.histogram
      ? {
          count: series.histogram.count,
          sum: series.histogram.sum,
          min: series.histogram.min,
          max: series.histogram.max,
          boundaries: [...(definition?.boundaries ?? [])],
          buckets: series.histogram.buckets,
        }
      : null,
  };
}

function oldestOf(list: StoredSeries[]): number {
  return list.reduce((min, s) => Math.min(min, s.startTime), Number.POSITIVE_INFINITY);
}

function seriesCacheKey(series: StoredSeries): string {
  return `${series.resourceId}|${series.instrument}|${series.dimensionsKey}`;
}

/** Stable, order-independent dimension identity. */
export function dimensionsKey(dimensions: Record<string, string>): string {
  return Object.keys(dimensions)
    .sort()
    .map((k) => `${k}=${dimensions[k]}`)
    .join("\u0000");
}

/**
 * 32 hex characters, derived so the same trace is unjoinable across audiences.
 *
 * The whole digest, not a padded prefix. Padding to length would have spent half of every trace
 * id on zeroes - still unique in practice, but a visibly degenerate identifier that any backend
 * operator would reasonably assume was a bug.
 */
export function scopedTraceId(profile: TelemetryProfileId, salt: string, traceId: string): string {
  return searchable(digest([profile, `${salt}:trace`, traceId]));
}

/** 16 hex characters, derived for the same reason. */
export function scopedSpanId(profile: TelemetryProfileId, salt: string, spanId: string): string {
  return searchable(digest([profile, `${salt}:span`, spanId]).slice(0, 16));
}

/**
 * An id a person can actually search for, and that OTLP accepts.
 *
 * Two rules, and the second is the one that bites. OTLP forbids an all-zero id - astronomically
 * unlikely from a digest, cheap to rule out. And Tempo, like Jaeger before it, STRIPS LEADING
 * ZEROES when it stores, returns and displays a trace id: an id beginning `0` comes back one
 * character shorter. One id in sixteen would therefore be handed to an operator by
 * `/api/telemetry/probe` in a form that does not match what the trace backend shows them, which
 * is the "well-formed link that resolves to nothing" failure in miniature.
 *
 * Fixed here rather than by making every caller and every dashboard normalise, because there is
 * exactly one place ids are minted and dozens of places they are read. The cost is the first
 * nibble carrying one fewer value: about 0.09 bits out of 128, against a collision budget that
 * was never close to binding.
 */
function searchable(hex: string): string {
  const withoutLeadingZero = hex[0] === "0" ? `1${hex.slice(1)}` : hex;
  return /^0+$/.test(withoutLeadingZero) ? `1${"0".repeat(hex.length - 1)}` : withoutLeadingZero;
}
