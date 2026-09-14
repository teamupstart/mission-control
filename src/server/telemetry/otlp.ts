/**
 * The supported OpenTelemetry serialization boundary.
 *
 * WHY THIS PATH, and not the obvious one. P1 flagged that `MetricReaderOptions.metricProducers`
 * is experimental and that a reader REPLACES an additional producer's resource with its own.
 * A durable queue attached that way would export every replayed batch stamped with the running
 * binary's `service.version` - silently moving yesterday's work into today's release cohort,
 * which is precisely the misattribution the whole design forbids.
 *
 * So this module skips the reader entirely. `@opentelemetry/otlp-transformer` publicly exports
 * `ProtobufMetricsSerializer` and `ProtobufTraceSerializer`, which take a `ResourceMetrics` and
 * a `ReadableSpan[]` and produce OTLP/HTTP protobuf bytes. Both of those are plain interfaces,
 * so a persisted batch is rehydrated into them directly, with its OWN resource and its OWN
 * timestamps. No SDK internals are deep-imported, no protobuf is hand-written, and a batch
 * queued by an older build serializes exactly as that build described it.
 *
 * The versions are pinned exactly in `package.json` for the same reason: this leans on the
 * shape of two public interfaces, and a caret range is how that stops being true quietly.
 */
import { SpanKind, SpanStatusCode, ValueType, type HrTime } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  ProtobufMetricsSerializer,
  ProtobufTraceSerializer,
  type IExportMetricsServiceResponse,
  type IExportTraceServiceResponse,
} from "@opentelemetry/otlp-transformer";
import {
  AggregationTemporality,
  DataPointType,
  type MetricData,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import type { MetricPointDto, MetricsBatchPayload, SpanDto, TracesBatchPayload } from "./projection.ts";

/** OTLP's `Content-Type` for the protobuf encoding. */
export const OTLP_PROTOBUF_CONTENT_TYPE = "application/x-protobuf";

function hrTime(ms: number): HrTime {
  const seconds = Math.floor(ms / 1000);
  return [seconds, Math.round((ms - seconds * 1000) * 1e6)];
}

/**
 * Rehydrate a persisted metrics batch into the exact shape the public serializer accepts.
 *
 * The resource comes from the BATCH, not from this process. That single line is the whole
 * reason this module exists.
 */
export function toResourceMetrics(payload: MetricsBatchPayload): ResourceMetrics {
  return {
    resource: resourceFromAttributes(payload.resource),
    scopeMetrics: [
      {
        scope: { name: payload.scope.name, version: payload.scope.version },
        metrics: payload.metrics.map(toMetricData),
      },
    ],
  };
}

function toMetricData(point: MetricPointDto): MetricData {
  const descriptor = {
    name: point.name,
    description: point.description,
    unit: point.unit,
    valueType: point.valueType === "int" ? ValueType.INT : ValueType.DOUBLE,
  };
  const startTime = hrTime(point.startTimeMs);
  const endTime = hrTime(point.endTimeMs);

  if (point.kind === "histogram" && point.histogram) {
    return {
      descriptor,
      // Cumulative because the durable series IS cumulative and survives restarts. Delta would
      // mean the backend could not tell a restart from a reset.
      aggregationTemporality: AggregationTemporality.CUMULATIVE,
      dataPointType: DataPointType.HISTOGRAM,
      dataPoints: [
        {
          startTime,
          endTime,
          attributes: point.attributes,
          value: {
            buckets: { boundaries: point.histogram.boundaries, counts: point.histogram.buckets },
            count: point.histogram.count,
            sum: point.histogram.sum,
            min: point.histogram.min ?? undefined,
            max: point.histogram.max ?? undefined,
          },
        },
      ],
    };
  }

  if (point.kind === "gauge") {
    return {
      descriptor,
      aggregationTemporality: AggregationTemporality.CUMULATIVE,
      dataPointType: DataPointType.GAUGE,
      dataPoints: [{ startTime, endTime, attributes: point.attributes, value: point.value }],
    };
  }

  return {
    descriptor,
    aggregationTemporality: AggregationTemporality.CUMULATIVE,
    dataPointType: DataPointType.SUM,
    isMonotonic: true,
    dataPoints: [{ startTime, endTime, attributes: point.attributes, value: point.value }],
  };
}

const SPAN_KINDS: Record<SpanDto["kind"], SpanKind> = {
  internal: SpanKind.INTERNAL,
  client: SpanKind.CLIENT,
  server: SpanKind.SERVER,
};

/**
 * Rehydrate persisted span descriptors into `ReadableSpan`s.
 *
 * A completed operation does not need a live SDK span to be exported; it needs its original
 * ids, its original window and its bounded attributes, which is exactly what was persisted.
 */
export function toReadableSpans(payload: TracesBatchPayload): ReadableSpan[] {
  const resource = resourceFromAttributes(payload.resource);
  const scope = { name: payload.scope.name, version: payload.scope.version };
  return payload.spans.map((span) => {
    const start = hrTime(span.startTimeMs);
    const end = hrTime(span.endTimeMs);
    const durationMs = Math.max(0, span.endTimeMs - span.startTimeMs);
    const readable: ReadableSpan = {
      name: span.name,
      kind: SPAN_KINDS[span.kind],
      spanContext: () => ({ traceId: span.traceId, spanId: span.spanId, traceFlags: 1 }),
      ...(span.parentSpanId
        ? {
            parentSpanContext: {
              traceId: span.traceId,
              spanId: span.parentSpanId,
              traceFlags: 1,
            },
          }
        : {}),
      startTime: start,
      endTime: end,
      duration: hrTime(durationMs),
      status:
        span.status === "ok"
          ? { code: SpanStatusCode.OK }
          : span.status === "error"
            ? { code: SpanStatusCode.ERROR, message: span.statusMessage ?? undefined }
            : { code: SpanStatusCode.UNSET },
      attributes: span.attributes,
      links: [],
      events: [],
      ended: true,
      resource,
      instrumentationScope: scope,
      droppedAttributesCount: 0,
      droppedEventsCount: 0,
      droppedLinksCount: 0,
    };
    return readable;
  });
}

export function serializeMetrics(payload: MetricsBatchPayload): Uint8Array {
  const bytes = ProtobufMetricsSerializer.serializeRequest(toResourceMetrics(payload));
  if (!bytes) throw new Error("the OTLP metrics serializer produced no request");
  return bytes;
}

export function serializeTraces(payload: TracesBatchPayload): Uint8Array {
  const bytes = ProtobufTraceSerializer.serializeRequest(toReadableSpans(payload));
  if (!bytes) throw new Error("the OTLP trace serializer produced no request");
  return bytes;
}

/** What a 2xx response actually said, beyond "the request succeeded". */
export interface PartialSuccess {
  rejectedItems: number;
  message: string | null;
}

/**
 * Read OTLP's partial-success accounting out of a successful response.
 *
 * An empty body is a full success, which is what most Collectors return. A body carrying
 * `partialSuccess` means the server kept some items and refused others, and retrying the whole
 * batch would amplify the accepted half - so this detail is the difference between correct
 * accounting and a duplication bug.
 *
 * A body we cannot parse is reported as a full success with a note rather than as a failure:
 * the server said 200, and re-sending over a decoding problem on our side is the one response
 * guaranteed to make it worse.
 */
export function readMetricsPartialSuccess(body: Uint8Array): PartialSuccess {
  return readPartialSuccess(() => ProtobufMetricsSerializer.deserializeResponse(body));
}

export function readTracesPartialSuccess(body: Uint8Array): PartialSuccess {
  return readPartialSuccess(() => ProtobufTraceSerializer.deserializeResponse(body));
}

function readPartialSuccess(
  parse: () => IExportMetricsServiceResponse | IExportTraceServiceResponse,
): PartialSuccess {
  try {
    const response = parse() as {
      partialSuccess?: {
        rejectedDataPoints?: number;
        rejectedSpans?: number;
        errorMessage?: string;
      };
    };
    const partial = response.partialSuccess;
    if (!partial) return { rejectedItems: 0, message: null };
    const rejected = Number(partial.rejectedDataPoints ?? partial.rejectedSpans ?? 0);
    return {
      rejectedItems: Number.isFinite(rejected) ? rejected : 0,
      message: partial.errorMessage ? String(partial.errorMessage).slice(0, 256) : null,
    };
  } catch {
    return { rejectedItems: 0, message: "response body could not be decoded" };
  }
}
