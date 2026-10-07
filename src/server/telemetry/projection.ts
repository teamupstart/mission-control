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
  type TelemetryDestination,
  type TelemetryProfileId,
} from "@shared/telemetry.ts";
import {
  TELEMETRY_EVENTS,
  TELEMETRY_METRICS,
  metricsForEvent,
  type TelemetryMetricDefinition,
  type TelemetrySpanDefinition,
  type TelemetrySpanKind,
} from "@shared/telemetry-catalog.ts";
import { ANALYTICAL_PREFIX } from "@shared/telemetry-projections/index.ts";
import {
  SUM_COUNT_SUFFIXES,
  exportShape,
  seriesWeight,
  shapeDimensions,
  shapeExcludes,
  shapeSplitsHistogram,
  type TelemetryExportShape,
} from "@shared/telemetry-export-shapes.ts";
import { randomUUID } from "node:crypto";
import {
  capturingProfiles,
  getTelemetryConfig,
  profileProducesBatches,
  profileSalt,
} from "./config.ts";
import { digest, scopedRef } from "./identity.ts";
import { PARENT_SPAN_REF, SPAN_REF, TRACE_REF, boundString, resourceAttributes } from "./capture.ts";
import {
  registeredProjections,
  type EmittedSpan,
  type TelemetryEmitter,
  type TelemetryProjection,
} from "./registration.ts";
import {
  clearSeriesDeferral,
  exportHourLedger,
  exportLedgerHorizon,
  getDestination,
  getProjectionState,
  getResource,
  getSeries,
  insertBatch,
  journalHead,
  listDeferredSeries,
  listHeartbeatSeries,
  listGaps,
  listLiveSeriesKeys,
  markSeriesDeferred,
  markSeriesExported,
  putProjectionState,
  putResource,
  putSeries,
  putSeriesExportState,
  readJournalAfter,
  recordExportHour,
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
  /** Absent on historical and cumulative batches, preserving their durable JSON shape. */
  temporality?: "delta";
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
      // The declared ref keys, RAW. The engine scopes them per destination below, which is
      // the only place the profile salt exists.
      const refs: Record<string, string> = {};
      for (const key of span.refAttributes) {
        const value = event.refs[key];
        if (typeof value === "string" && value.length > 0) refs[key] = value;
      }
      emit.span({
        name: span.name,
        kind: span.kind,
        refs,
        traceId: event.refs[TRACE_REF] ?? "",
        spanId: event.refs[SPAN_REF] ?? "",
        parentSpanId: event.refs[PARENT_SPAN_REF] ?? null,
        // The ORIGINAL window. An operation that ran an hour ago and drained now is searchable
        // at the time it ran, which is the whole point of persisting a descriptor instead of
        // holding an SDK span open.
        startTime: event.occurredAt - durationMs,
        endTime: event.occurredAt,
        ...spanStatus(span, event.facts),
        attributes,
        // Ref promotion happens in the engine, where the per-profile salt is known: the same
        // session must not carry the same exported id to two audiences.
      });
    }
    return state;
  },
};

/**
 * Whether this span reports a failure, from the event's own declared outcome fact.
 *
 * Every span was hard-coded `unset`, which in Tempo reads as "nothing went wrong" - so a failed
 * export probe rendered identically to a working one and the failure was legible only by
 * reading the attribute text, on the drill-down path this facility exists to make diagnosis
 * possible through. The mapping lives in the catalog entry, so an outcome-bearing event added
 * by a later phase is described rather than special-cased here.
 */
function spanStatus(
  span: TelemetrySpanDefinition,
  facts: Record<string, unknown>,
): { status: EmittedSpan["status"]; statusMessage: string | null } {
  if (!span.errorWhen) return { status: "unset", statusMessage: null };
  const value = facts[span.errorWhen.factKey];
  if (typeof value !== "string" || !span.errorWhen.values.includes(value)) {
    return { status: "unset", statusMessage: null };
  }
  // The outcome itself, which is already a bounded catalog enum. Nothing free-form reaches a
  // status message, so it cannot become an accidental carrier for operator data.
  return { status: "error", statusMessage: `${span.errorWhen.factKey}=${value}` };
}

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
      const configuredDestination: TelemetryDestination | null =
        profile === "user" ? config.user : profile === "product" ? config.product : null;
      const one = runOne(
        projection,
        profile,
        profileProducesBatches(config, profile),
        configuredDestination?.temporality ?? "cumulative",
        exportShape(configuredDestination?.exportShape ?? "full"),
        now,
      );
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
  temporality: TelemetryDestination["temporality"],
  shape: TelemetryExportShape,
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
      state = projection.initialState(now);
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
        state = projection.initialState(now);
      } else {
        state = migrated;
      }
      consumedSeq = stored.consumedSeq;
    }

    const events = readJournalAfter(d, consumedSeq, TELEMETRY_LIMITS.projectionBatchSize);
    const heartbeatSeries =
      projection.id === CATALOG_PROJECTION.id && temporality === "delta" && producesBatches
        ? listHeartbeatSeries(
            d,
            profile,
            destination.policyEpoch,
            now - 60 * 60_000,
            now - TELEMETRY_LIMITS.payloadRetentionMs,
          ).filter(
            (series) =>
              series.kind === "gauge" && !series.instrument.startsWith(`${ANALYTICAL_PREFIX}.`),
          )
        : [];
    // Points the hourly export ledger held back. Carried by the catalog projection's pass, like
    // the heartbeat, so they go out in a later hour even if nothing new happens.
    const deferredSeries =
      projection.id === CATALOG_PROJECTION.id && shape.seriesBudget !== null && producesBatches
        ? listDeferredSeries(d, profile, destination.policyEpoch)
        : [];
    if (
      events.length === 0 &&
      !projection.idleSnapshots &&
      heartbeatSeries.length === 0 &&
      deferredSeries.length === 0
    ) {
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

    const collector = new Collector(
      profile,
      destination.policyEpoch,
      { temporality, generation: destination.generation, shape },
      now,
    );
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
        { profile, policyEpoch: destination.policyEpoch, now, resource: getResource(d, event.resourceId) ?? undefined },
      );
    }
    collector.endEvent();
    (projection as TelemetryProjection<unknown>).snapshot?.(state, collector, {
      profile,
      policyEpoch: destination.policyEpoch,
      now,
      caughtUp: highest >= journalHead(d),
      lastGapAt: listGaps(d).reduce<number | null>((latest, gap) => Math.max(latest ?? gap.lastAt, gap.lastAt), null),
    });

    const applied = collector.apply(d, producesBatches, heartbeatSeries, deferredSeries);

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
    private readonly exportDescriptor: {
      temporality: TelemetryDestination["temporality"];
      generation: number;
      /** What this profile's destination receives. `full` for `local` and by default. */
      shape: TelemetryExportShape;
    },
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
    // The destination's shape chose to leave this family out. Not a defect and not a gap.
    if (shapeExcludes(this.exportDescriptor.shape, instrument)) return;
    if (!Number.isFinite(value)) {
      this.problems.push(`${instrument} emitted a non-finite value`);
      return;
    }
    const bounded: Record<string, string> = {};
    // The shape's kept labels, so contributions that differ only in a dropped label aggregate
    // into one series. The undeclared check below still reads the FULL list, so a dropped
    // label is never mistaken for a catalog defect.
    for (const key of shapeDimensions(this.exportDescriptor.shape, definition)) {
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
    // Ref promotion, HERE rather than in the projection that declared them, because the
    // per-profile salt lives here and a projection cannot know it. A projection that hashed
    // these itself would either leak the mapping or invent a second one.
    const attributes = { ...span.attributes };
    for (const [key, value] of Object.entries(span.refs ?? {})) {
      attributes[`mission.ref.${key}`] = scopedRef(this.profile, this.salt, `${key}:${value}`);
    }
    // Per-profile translation. The same underlying operation reaches two audiences under two
    // unrelated ids, so holders of one cannot join it to the other - and that now covers the
    // session, task and pull request refs above as well as the trace and span ids.
    this.spans.push({
      span: {
        ...span,
        attributes,
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
    heartbeatSeries: StoredSeries[] = [],
    deferredSeries: StoredSeries[] = [],
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
    const shape = this.exportDescriptor.shape;
    const candidates = new Map(touched);
    const heartbeatKeys = new Set<string>();
    // A deferred gauge sends its then-current value, so it is forced through like a heartbeat.
    for (const series of [...heartbeatSeries, ...deferredSeries]) {
      const key = seriesCacheKey(series);
      heartbeatKeys.add(key);
      if (!candidates.has(key)) candidates.set(key, series);
    }
    const byResource = new Map<string, ExportCandidate[]>();
    for (const series of candidates.values()) {
      let point =
        this.exportDescriptor.temporality === "delta"
          ? toDeltaPoint(
              series,
              this.exportDescriptor.generation,
              this.now,
              heartbeatKeys.has(seriesCacheKey(series)),
            )
          : toPoint(series);
      if (!point) {
        // Nothing left to send, so nothing is waiting either.
        if (series.deferredAt !== null) clearSeriesDeferral(d, series);
        continue;
      }
      // A carried series - deferred, or due a heartbeat - that is not live right now has to be
      // admitted to the live budget like any other, because exporting it makes it live again.
      // A contribution is admitted in `fold`, so a touched series is always live by here. A
      // refused one waits with its watermark untouched, as a deferred point does, and goes out
      // once there is room. It was counted when it first waited, so it is not counted again.
      if (shape.seriesBudget !== null && !this.isLive(series)) {
        const definition = TELEMETRY_METRICS[series.instrument];
        if (!definition || !this.budget(d).admitOwn(definition, series.resourceId, series.dimensionsKey)) {
          if (series.deferredAt === null) markSeriesDeferred(d, series, this.now);
          continue;
        }
      }
      // A cumulative point ends at its latest event, and on a budgeted destination that hour
      // has to have room for it in the ledger. Two kinds of point go out stamped with this
      // pass's clock instead:
      //  - one that waited for a later hour, which would otherwise ask the same full hour for
      //    room on every retry and never leave it;
      //  - one whose hour is older than the ledger remembers, whose allowance is no longer on
      //    record and so could not be enforced.
      // Every other late point keeps its event hour, which the ledger still tracks. The value
      // is unchanged and still exact, because a cumulative total at this moment is the total
      // at its latest event: nothing has contributed since. A delta point already ends here.
      if (
        shape.seriesBudget !== null &&
        point.endTimeMs < this.now &&
        (series.deferredAt !== null || point.endTimeMs < exportLedgerHorizon(this.now))
      ) {
        point = { ...point, endTimeMs: this.now };
      }
      const list = byResource.get(series.resourceId) ?? [];
      list.push({ series, points: shapePoints(shape, point) });
      byResource.set(series.resourceId, list);
    }
    const ledger =
      shape.seriesBudget === null ? null : new HourlyExportLedger(d, this.profile, shape);
    let deferred = 0;
    for (const [resourceId, shaped] of byResource) {
      const stored = getResource(d, resourceId);
      if (!stored) {
        // Belt to the braces above. An unaddressable series cannot be put in an OTLP request at
        // all, so it is permanent export loss - and the one thing this facility may never do is
        // let loss happen without counting it.
        recordGap(
          d,
          "permanently_rejected",
          `${shaped.length} metric series have no addressable resource`,
          this.now,
        );
        continue;
      }
      // The shape's constant attributes join the resource HERE, at build time, so the batch
      // digest covers them and a queued batch never changes on the wire.
      const resource =
        Object.keys(shape.resourceAttributes).length > 0
          ? { ...stored, ...shape.resourceAttributes }
          : stored;
      let list = shaped;
      const claims: ExportHourClaim[] = [];
      if (ledger) {
        list = [];
        for (const candidate of shaped) {
          const verdict = ledger.admit(candidate, resource);
          if (verdict === "deferred") {
            // Its watermark stays where it was, so the whole delta goes out in a later hour.
            // Counted once per wait, not once for every pass the series spends waiting.
            if (markSeriesDeferred(d, candidate.series, this.now)) deferred += 1;
            continue;
          }
          list.push(candidate);
          if (verdict !== "known") claims.push(verdict);
        }
        if (list.length === 0) continue;
      }
      const points = list.flatMap((candidate) => candidate.points);
      const payload: MetricsBatchPayload = {
        resource,
        scope: TELEMETRY_SCOPE,
        metrics: points,
      };
      const written = this.writeBatch(
        d,
        "metrics",
        payload,
        points.length,
        this.exportDescriptor.temporality === "delta"
          ? Math.min(...points.map((point) => point.startTimeMs))
          : oldestOf(list.map(({ series }) => series)),
      );
      batches += written;
      if (written === 0) {
        // Nothing was queued, so the hour has not spent anything on these series.
        ledger?.release(claims);
        continue;
      }
      ledger?.commit(claims);
      for (const { series, points: exported } of list) {
        if (this.exportDescriptor.temporality === "delta") {
          putSeriesExportState(
            d,
            series,
            this.exportDescriptor.generation,
            (exported[0] as MetricPointDto).endTimeMs,
          );
        } else if (ledger || series.deferredAt !== null) {
          // An export keeps a budgeted series live exactly as a delta export does. Default
          // destinations have no budget to keep, so their cumulative path writes nothing here.
          markSeriesExported(d, series, this.now);
        }
      }
    }
    if (deferred > 0) {
      recordGap(
        d,
        "hourly_cap_deferred",
        `${deferred} series waited for a later hour to keep this hour within the export shape's budget`,
        this.now,
        deferred,
      );
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

    const shape = this.exportDescriptor.shape;
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
        dimensions = overflowDimensions(shapeDimensions(shape, definition));
        key = dimensionsKey(dimensions);
        recordGap(d, "series_overflow", `${pending.instrument} exceeded its series budget`, this.now);
        existing = getSeries(d, { ...base, dimensionsKey: key });
      }
    }

    // A budgeted shape admits every series that is not live right now: a new one, and equally
    // a stored one that aged out and is reporting again. A live series needs no admission.
    if (shape.seriesBudget !== null && !this.isLive(existing)) {
      const admitted = this.budget(d).admit(definition, pending.resourceId, key);
      if (admitted === "dropped") {
        recordGap(
          d,
          "budget_exhausted",
          `${pending.instrument} had no room in the export shape's series budget`,
          this.now,
        );
        return null;
      }
      if (admitted !== key) {
        // Refused, and folded into the pair's already paid-for overflow series. A refused resume
        // leaves its own stored row exactly as it was, so its next delta, once admitted, excludes
        // everything that went to overflow meanwhile.
        recordGap(d, "series_overflow", `${pending.instrument} exceeded its series budget`, this.now);
        dimensions = overflowDimensions(shapeDimensions(shape, definition));
        key = admitted;
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
      exportedValue: null,
      exportedHistogram: null,
      exportedEnd: null,
      exportedGeneration: null,
      lastActivity: this.now,
      deferredAt: null,
    };

    next.lastTime = Math.max(next.lastTime, endTime);
    next.lastActivity = Math.max(next.lastActivity, this.now);
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

  private liveBudget: SeriesBudget | null = null;

  /** This pass's view of the live set, read from the index at the pass's first admission. */
  private budget(d: import("node:sqlite").DatabaseSync): SeriesBudget {
    this.liveBudget ??= new SeriesBudget(
      this.exportDescriptor.shape,
      listLiveSeriesKeys(d, this.profile, this.policyEpoch, this.liveSince()),
    );
    return this.liveBudget;
  }

  private liveSince(): number {
    return this.now - TELEMETRY_LIMITS.payloadRetentionMs;
  }

  private isLive(series: StoredSeries | null): boolean {
    return series !== null && series.lastActivity >= this.liveSince();
  }
}

interface ExportCandidate {
  series: StoredSeries;
  /** One point, or a histogram's sum and count counters, exported or deferred together. */
  points: MetricPointDto[];
}

function overflowDimensions(kept: readonly string[]): Record<string, string> {
  return Object.fromEntries(kept.map((dim) => [dim, TELEMETRY_OVERFLOW_VALUE]));
}

interface BudgetPair {
  /** Live series other than the overflow series. */
  series: number;
  overflowLive: boolean;
}

/**
 * A budgeted shape's admission rule, over one consent epoch's live series.
 *
 * Committed weight is the weighted live series plus one reservation per `(resource,
 * instrument)` pair: a pair with a live series reserves the weight of its one overflow series
 * until that overflow series is live itself. Admitting a new or resumed series needs room for
 * its own weight AND its pair's reservation if the pair has none yet, so the overflow series a
 * refusal folds into is always already paid for. The invariant: committed weight never exceeds
 * `seriesBudget`, so live series in the current epoch and shape, overflow included, never do.
 *
 * Read from the index at a pass's first admission and then carried through that pass's own
 * admissions, all at one clock. It is never persisted: the next pass reads expiry fresh from
 * `last_activity`, so a series that ages out frees its room without anything having to drift.
 */
class SeriesBudget {
  private readonly pairs = new Map<string, BudgetPair>();
  private committed = 0;

  constructor(
    private readonly shape: TelemetryExportShape,
    live: Array<{ resourceId: string; instrument: string; dimensionsKey: string }>,
  ) {
    for (const row of live) {
      const definition = TELEMETRY_METRICS[row.instrument];
      if (!definition) continue;
      const pair = this.pair(row.resourceId, row.instrument);
      if (row.dimensionsKey === this.overflowKey(definition)) pair.overflowLive = true;
      else pair.series += 1;
    }
    for (const row of new Set(live.map((r) => `${r.resourceId}|${r.instrument}`))) {
      const definition = TELEMETRY_METRICS[row.slice(row.indexOf("|") + 1)];
      const pair = this.pairs.get(row);
      if (definition && pair) this.committed += this.pairWeight(definition, pair);
    }
  }

  /**
   * The series key a contribution may fold into: its own when admitted, its pair's overflow
   * key when refused but already paid for, or `dropped` when the pair has neither.
   */
  admit(
    definition: TelemetryMetricDefinition,
    resourceId: string,
    key: string,
  ): string | "dropped" {
    const overflowKey = this.overflowKey(definition);
    if (key !== overflowKey && this.admitOwn(definition, resourceId, key)) return key;
    // Only a pair whose overflow series is live or reserved may fold into it. Creating it
    // converts the reservation, so committed weight does not move. A pair with neither is new
    // while the budget is full, and its contribution is dropped and counted by the caller.
    return overflowKey !== null && this.admitOwn(definition, resourceId, overflowKey)
      ? overflowKey
      : "dropped";
  }

  /**
   * Admit a series under its OWN key, or change nothing and say no.
   *
   * What an export of a stored series needs, as opposed to a contribution: a point already
   * computed for one series cannot be folded into another. An overflow series is admissible
   * only by converting its pair's reservation, which is the room it was always paid for from.
   */
  admitOwn(definition: TelemetryMetricDefinition, resourceId: string, key: string): boolean {
    const pair = this.pair(resourceId, definition.name);
    const before = this.pairWeight(definition, pair);
    if (key === this.overflowKey(definition)) {
      if (!pair.overflowLive && pair.series === 0) return false;
      pair.overflowLive = true;
      this.committed += this.pairWeight(definition, pair) - before;
      return true;
    }
    const after = this.pairWeight(definition, { ...pair, series: pair.series + 1 });
    if (this.committed - before + after > (this.shape.seriesBudget ?? Number.POSITIVE_INFINITY)) {
      return false;
    }
    pair.series += 1;
    this.committed += after - before;
    return true;
  }

  get weight(): number {
    return this.committed;
  }

  private pair(resourceId: string, instrument: string): BudgetPair {
    const key = `${resourceId}|${instrument}`;
    let pair = this.pairs.get(key);
    if (!pair) {
      pair = { series: 0, overflowLive: false };
      this.pairs.set(key, pair);
    }
    return pair;
  }

  /** Null for an instrument with no kept labels: its one series has no overflow to fall into. */
  private overflowKey(definition: TelemetryMetricDefinition): string | null {
    const kept = shapeDimensions(this.shape, definition);
    return kept.length === 0 ? null : dimensionsKey(overflowDimensions(kept));
  }

  private pairWeight(definition: TelemetryMetricDefinition, pair: BudgetPair): number {
    const overflow =
      this.overflowKey(definition) !== null && (pair.overflowLive || pair.series > 0) ? 1 : 0;
    return seriesWeight(this.shape, definition) * (pair.series + overflow);
  }
}

/** A profile's committed weight at `now`, read exactly as its next admission would read it. */
export function committedSeriesWeight(
  d: import("node:sqlite").DatabaseSync,
  profile: TelemetryProfileId,
  policyEpoch: number,
  shape: TelemetryExportShape,
  now: number,
): number {
  return new SeriesBudget(
    shape,
    listLiveSeriesKeys(d, profile, policyEpoch, now - TELEMETRY_LIMITS.payloadRetentionMs),
  ).weight;
}

const HOUR_MS = 60 * 60_000;

/** Room one series holds in one hour's ledger until its batch is queued or abandoned. */
interface ExportHourClaim {
  hourStart: number;
  seriesDigest: string;
  weight: number;
}

/**
 * The hard billing bound: the distinct series exported in each UTC clock hour, by point time.
 *
 * Durable in `telemetry_export_hours`, keyed by profile and hour and never by shape or epoch, so
 * a shape change, a consent change or a restart earlier in the hour cannot grant a fresh
 * allowance. A series already in the hour's ledger always goes out. A new one goes out only while
 * the hour stays within `seriesBudget`; otherwise it waits with its watermark untouched, so a
 * counter's delta arrives whole in a later hour.
 *
 * Admission only CLAIMS room, in memory, so later candidates in the same pass see it taken. A
 * claim becomes a ledger row through `commit` once its batch is actually queued, in the same
 * transaction, and `release` hands the room back when nothing was queued. The hour is never
 * charged for a point the destination will not receive.
 */
class HourlyExportLedger {
  private readonly hours = new Map<number, { series: Map<string, number>; weight: number }>();

  constructor(
    private readonly d: import("node:sqlite").DatabaseSync,
    private readonly profile: TelemetryProfileId,
    private readonly shape: TelemetryExportShape,
  ) {}

  /** `known` costs nothing more; a claim must be committed or released; `deferred` waits. */
  admit(candidate: ExportCandidate, resource: Record<string, string>): ExportHourClaim | "known" | "deferred" {
    const first = candidate.points[0] as MetricPointDto;
    const hourStart = Math.floor(first.endTimeMs / HOUR_MS) * HOUR_MS;
    const hour = this.hour(hourStart);
    // What the backend counts as custom metrics for this series: the exported names, the
    // data-point attributes, and the resource they arrive under, host attribute included.
    const seriesDigest = digest([
      candidate.points.map((point) => point.name),
      first.attributes,
      resource,
    ]);
    if (hour.series.has(seriesDigest)) return "known";
    const definition = TELEMETRY_METRICS[candidate.series.instrument];
    const weight = definition ? seriesWeight(this.shape, definition) : 1;
    if (hour.weight + weight > (this.shape.seriesBudget ?? Number.POSITIVE_INFINITY)) return "deferred";
    hour.series.set(seriesDigest, weight);
    hour.weight += weight;
    return { hourStart, seriesDigest, weight };
  }

  /** The batch carrying these claims was queued: record them with it. */
  commit(claims: readonly ExportHourClaim[]): void {
    for (const claim of claims) {
      recordExportHour(this.d, this.profile, claim.hourStart, claim.seriesDigest, claim.weight);
    }
  }

  /** The batch carrying these claims was not queued: give their room back. */
  release(claims: readonly ExportHourClaim[]): void {
    for (const claim of claims) {
      const hour = this.hours.get(claim.hourStart);
      if (hour?.series.delete(claim.seriesDigest)) hour.weight -= claim.weight;
    }
  }

  private hour(hourStart: number): { series: Map<string, number>; weight: number } {
    let hour = this.hours.get(hourStart);
    if (!hour) {
      const series = exportHourLedger(this.d, this.profile, hourStart);
      hour = { series, weight: [...series.values()].reduce((sum, weight) => sum + weight, 0) };
      this.hours.set(hourStart, hour);
    }
    return hour;
  }
}

/**
 * The points a shape exports for one series' point.
 *
 * The identity, except for a histogram the shape does not keep as a distribution: that becomes
 * a `<name>.sum` counter in the histogram's unit and a `<name>.count` counter in `1`, over the
 * same window. The histogram point was already computed under the destination's temporality,
 * so its sum and count are already the cumulative totals or the window's deltas.
 */
function shapePoints(shape: TelemetryExportShape, point: MetricPointDto): MetricPointDto[] {
  const definition = TELEMETRY_METRICS[point.name];
  if (!definition || !point.histogram || !shapeSplitsHistogram(shape, definition)) return [point];
  const { histogram } = point;
  return [
    {
      ...point,
      name: `${point.name}${SUM_COUNT_SUFFIXES.sum}`,
      kind: "counter",
      valueType: "double",
      value: histogram.sum,
      histogram: null,
    },
    {
      ...point,
      name: `${point.name}${SUM_COUNT_SUFFIXES.count}`,
      unit: "1",
      kind: "counter",
      valueType: "int",
      value: histogram.count,
      histogram: null,
    },
  ];
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

function toDeltaPoint(
  series: StoredSeries,
  generation: number,
  now: number,
  heartbeat: boolean,
): MetricPointDto | null {
  const currentGeneration = series.exportedGeneration === generation;
  const previousValue = currentGeneration ? series.exportedValue : null;
  const previousHistogram = currentGeneration ? series.exportedHistogram : null;
  const previousEnd = currentGeneration ? series.exportedEnd : null;
  const startTimeMs = previousEnd ?? series.startTime;
  const endTimeMs = Math.max(now, startTimeMs + 1);
  const point = toPoint(series);

  if (series.kind === "gauge") {
    if (!heartbeat && previousValue !== null && previousValue === series.value) return null;
    return {
      ...point,
      startTimeMs,
      endTimeMs,
      temporality: "delta",
    };
  }

  if (series.kind === "histogram" && series.histogram) {
    const previousBuckets = previousHistogram?.buckets ?? [];
    const histogram = {
      count: series.histogram.count - (previousHistogram?.count ?? 0),
      sum: series.histogram.sum - (previousHistogram?.sum ?? 0),
      min: null,
      max: null,
      boundaries: point.histogram?.boundaries ?? [],
      buckets: series.histogram.buckets.map(
        (count, index) => count - (previousBuckets[index] ?? 0),
      ),
    };
    if (histogram.count === 0 && histogram.buckets.every((count) => count === 0)) return null;
    return {
      ...point,
      startTimeMs,
      endTimeMs,
      value: histogram.sum,
      histogram,
      temporality: "delta",
    };
  }

  const value = series.value - (previousValue ?? 0);
  if (value === 0) return null;
  return {
    ...point,
    startTimeMs,
    endTimeMs,
    value,
    temporality: "delta",
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
