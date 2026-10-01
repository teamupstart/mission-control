import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MetricsBatchPayload } from "../src/server/telemetry/projection.ts";

const home = mkdtempSync(join(tmpdir(), "mission-telemetry-delta-"));
process.env.HARNESS_HOME = join(home, "state");

const { closeDb, openDb } = await import("../src/server/db.ts");
const { captureTelemetry } = await import("../src/server/telemetry/capture.ts");
const { setTelemetryConfig } = await import("../src/server/telemetry/config.ts");
const { runDeliveryPass } = await import("../src/server/telemetry/delivery.ts");
const {
  CATALOG_PROJECTION,
  runProjectionPass,
} = await import("../src/server/telemetry/projection.ts");
const {
  registerTelemetryProjection,
  resetTelemetryRegistrations,
} = await import("../src/server/telemetry/registration.ts");
const { DAEMON_STARTED_EVENT } = await import("../src/shared/telemetry-catalog.ts");
const { HEALTH_EVENT } = await import("../src/shared/telemetry-sources/health.ts");
const { ANALYTICAL_METRICS } = await import("../src/shared/telemetry-projections/index.ts");

resetTelemetryRegistrations();
registerTelemetryProjection(CATALOG_PROJECTION);

after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

const TABLES = [
  "telemetry_journal",
  "telemetry_source_identities",
  "telemetry_projection_state",
  "telemetry_series",
  "telemetry_batches",
  "telemetry_delivery",
  "telemetry_destinations",
  "telemetry_gaps",
  "telemetry_contexts",
  "telemetry_resources",
];

beforeEach(() => {
  const d = openDb();
  for (const table of TABLES) d.exec(`DELETE FROM ${table}`);
  d.exec("DELETE FROM app_config");
});

function enableDelta(endpoint = "https://otlp.example.com", now = 100): void {
  const applied = setTelemetryConfig(
    {
      enabled: true,
      user: { enabled: true, endpoint, temporality: "delta" },
    },
    now,
  );
  assert.equal(applied.ok, true, applied.ok ? "" : applied.error);
}

function captureStart(id: string, now: number, startupMs: number): void {
  const captured = captureTelemetry({
    event: DAEMON_STARTED_EVENT,
    source: { kind: "mission.daemon", id, revision: 1 },
    profiles: ["user"],
    facts: { startup_ms: startupMs, schema_upgraded: false, launch_mode: "daemon" },
    now,
  });
  assert.equal(captured.kind, "accepted");
}

function captureHealth(id: string, now: number, observedAt = 10): void {
  const captured = captureTelemetry({
    event: HEALTH_EVENT,
    source: { kind: "mission.telemetry.health", id, revision: 1 },
    profiles: ["user"],
    facts: {
      profile: "user",
      pending: 0,
      retrying: 0,
      accepted: 0,
      rejected: 0,
      expired: 0,
      pending_bytes: 0,
      oldest_pending_age: 0,
      last_accepted_at: 0,
      observed_at: observedAt,
    },
    now,
  });
  assert.equal(captured.kind, "accepted");
}

function metricBatches(): MetricsBatchPayload[] {
  return openDb()
    .prepare(
      `SELECT payload_json FROM telemetry_batches
       WHERE profile = 'user' AND signal = 'metrics'
       ORDER BY created_at, id`,
    )
    .all()
    .map((row) => JSON.parse(String(row.payload_json)) as MetricsBatchPayload);
}

function clearBatches(): void {
  const d = openDb();
  d.exec("DELETE FROM telemetry_delivery");
  d.exec("DELETE FROM telemetry_batches");
}

type WireField = { field: number; wire: number; value: number | Uint8Array };

function readVarint(bytes: Uint8Array, offset: number): [number, number] {
  let value = 0;
  let shift = 0;
  while (offset < bytes.length) {
    const byte = bytes[offset++]!;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return [value, offset];
    shift += 7;
  }
  throw new Error("truncated protobuf varint");
}

function decodeFields(bytes: Uint8Array): WireField[] {
  const fields: WireField[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const [tag, afterTag] = readVarint(bytes, offset);
    offset = afterTag;
    const field = tag >>> 3;
    const wire = tag & 0x7;
    if (wire === 0) {
      const [value, afterValue] = readVarint(bytes, offset);
      fields.push({ field, wire, value });
      offset = afterValue;
      continue;
    }
    if (wire === 1 || wire === 5) {
      const size = wire === 1 ? 8 : 4;
      fields.push({ field, wire, value: bytes.subarray(offset, offset + size) });
      offset += size;
      continue;
    }
    if (wire === 2) {
      const [length, afterLength] = readVarint(bytes, offset);
      offset = afterLength;
      fields.push({ field, wire, value: bytes.subarray(offset, offset + length) });
      offset += length;
      continue;
    }
    throw new Error(`unsupported protobuf wire type ${wire}`);
  }
  return fields;
}

function bytesField(fields: WireField[], field: number): Uint8Array[] {
  return fields
    .filter((item) => item.field === field && item.value instanceof Uint8Array)
    .map((item) => item.value as Uint8Array);
}

function numberField(fields: WireField[], field: number): number {
  const item = fields.find((candidate) => candidate.field === field);
  if (!item || typeof item.value !== "number") {
    throw new Error(`protobuf field ${field} is absent or not a varint`);
  }
  return item.value;
}

function fixed64(bytes: Uint8Array): number {
  assert.equal(bytes.length, 8);
  return Number(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0, true));
}

function double(bytes: Uint8Array): number {
  assert.equal(bytes.length, 8);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat64(0, true);
}

interface DecodedOtlpMetric {
  name: string;
  temporality: number;
  value?: number;
  histogram?: { count: number; sum: number; buckets: number[] };
}

function decodeOtlpMetrics(request: Uint8Array): DecodedOtlpMetric[] {
  const decoder = new TextDecoder();
  const resourceMetrics = bytesField(decodeFields(request), 1);
  return resourceMetrics.flatMap((resource) =>
    bytesField(decodeFields(resource), 2).flatMap((scope) =>
      bytesField(decodeFields(scope), 2).map((metricBytes) => {
        const metric = decodeFields(metricBytes);
        const name = decoder.decode(bytesField(metric, 1)[0]);
        const sumBytes = bytesField(metric, 7)[0];
        if (sumBytes) {
          const sum = decodeFields(sumBytes);
          const point = decodeFields(bytesField(sum, 1)[0]!);
          return {
            name,
            temporality: numberField(sum, 2),
            value: fixed64(bytesField(point, 6)[0]!),
          };
        }
        const histogramBytes = bytesField(metric, 9)[0];
        assert.ok(histogramBytes, `${name} is neither an OTLP sum nor histogram`);
        const histogram = decodeFields(histogramBytes);
        const point = decodeFields(bytesField(histogram, 1)[0]!);
        const packedBuckets = bytesField(point, 6)[0]!;
        const buckets: number[] = [];
        for (let offset = 0; offset < packedBuckets.length; offset += 8) {
          buckets.push(fixed64(packedBuckets.subarray(offset, offset + 8)));
        }
        return {
          name,
          temporality: numberField(histogram, 2),
          histogram: {
            count: fixed64(bytesField(point, 4)[0]!),
            sum: double(bytesField(point, 5)[0]!),
            buckets,
          },
        };
      }),
    ),
  );
}

test("a delta destination sends successive counter and histogram windows to its collector", async () => {
  enableDelta("https://collector.example.com");
  const requests: Uint8Array[] = [];
  const collector: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    assert.ok(
      url === "https://collector.example.com/v1/metrics" ||
        url === "https://collector.example.com/v1/traces",
    );
    assert.equal(
      init?.headers && new Headers(init.headers).get("content-type"),
      "application/x-protobuf",
    );
    const body = init?.body;
    if (!(body instanceof Uint8Array)) throw new Error("collector received a non-binary body");
    if (url.endsWith("/v1/metrics")) requests.push((body as Uint8Array).slice());
    return new Response(null, { status: 200 });
  };

  for (const [index, startupMs] of [100, 200].entries()) {
    const capturedAt = 1_000 + index * 1_000;
    const metricsBefore = requests.length;
    captureStart(`collector-window-${index}`, capturedAt, startupMs);
    assert.ok(runProjectionPass(capturedAt + 1).batches > 0);
    const delivered = await runDeliveryPass({ fetch: collector, now: () => capturedAt + 2 });
    assert.ok(delivered.accepted > 0);
    assert.equal(requests.length, metricsBefore + 1);
  }

  assert.equal(requests.length, 2);
  const windows = requests.map(decodeOtlpMetrics);
  const counters = windows.map((window) =>
    window.find((metric) => metric.name === "mission.daemon.starts")!,
  );
  assert.deepEqual(counters.map((metric) => metric.temporality), [1, 1], "OTLP DELTA is enum 1");
  assert.deepEqual(counters.map((metric) => metric.value), [1, 1]);

  const histograms = windows.map((window) =>
    window.find((metric) => metric.name === "mission.daemon.startup.duration")!,
  );
  assert.deepEqual(histograms.map((metric) => metric.temporality), [1, 1]);
  assert.deepEqual(histograms.map((metric) => metric.histogram?.count), [1, 1]);
  assert.deepEqual(histograms.map((metric) => metric.histogram?.sum), [100, 200]);
  assert.deepEqual(histograms.map((metric) => metric.histogram?.buckets), [
    [0, 1, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
  ]);
});

test("delta counters and histograms export only each new window across passes and restart", () => {
  enableDelta();
  for (const [index, startupMs] of [100, 200, 300].entries()) {
    captureStart(`boot-${index}`, 1_000 + index * 1_000, startupMs);
    runProjectionPass(1_001 + index * 1_000);
    if (index === 0) {
      closeDb();
      openDb();
    }
  }

  const batches = metricBatches();
  assert.equal(batches.length, 3);
  const counters = batches.map((batch) =>
    batch.metrics.find((point) => point.name === "mission.daemon.starts")!,
  );
  assert.deepEqual(counters.map((point) => point.value), [1, 1, 1]);
  assert.ok(counters.every((point) => point.temporality === "delta"));
  assert.ok(counters.every((point, index) => index === 0 || point.startTimeMs > counters[index - 1]!.startTimeMs));

  const histograms = batches.map((batch) =>
    batch.metrics.find((point) => point.name === "mission.daemon.startup.duration")!,
  );
  assert.deepEqual(histograms.map((point) => point.histogram?.count), [1, 1, 1]);
  assert.deepEqual(histograms.map((point) => point.histogram?.sum), [100, 200, 300]);
  assert.deepEqual(
    histograms.map((point) => point.histogram?.buckets),
    [
      [0, 1, 0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 1, 0, 0, 0, 0, 0, 0],
    ],
    "each export contains only that window's bucket contribution, including after restart",
  );
  assert.ok(histograms.every((point) => point.histogram?.min === null));
  assert.ok(histograms.every((point) => point.histogram?.max === null));

  const idle = runProjectionPass(10_000);
  assert.equal(idle.batches, 0, "zero counter and histogram deltas do not create a batch");
});

test("an unchanged catalog gauge heartbeats only after a full idle hour", () => {
  enableDelta();
  captureHealth("health-1", 1_000);
  runProjectionPass(1_001);

  const d = openDb();
  d.exec(`DELETE FROM telemetry_series
    WHERE profile = 'user' AND instrument <> 'mission.telemetry.health.observed_at'`);
  clearBatches();
  const initial = d.prepare(
    `SELECT exported_end FROM telemetry_series
     WHERE profile = 'user' AND instrument = 'mission.telemetry.health.observed_at'`,
  ).get() as { exported_end: number };

  const changedAt = initial.exported_end + 30 * 60_000;
  captureHealth("health-2", changedAt, 20);
  const changed = runProjectionPass(changedAt + 1);
  assert.equal(changed.batches, 1, "a changed gauge exports before the heartbeat interval");
  const changedPoint = metricBatches()[0]!.metrics.find(
    (point) => point.name === "mission.telemetry.health.observed_at",
  );
  assert.equal(changedPoint?.value, 20);
  assert.equal(changedPoint?.endTimeMs, changedAt + 1);

  clearBatches();
  d.exec(`DELETE FROM telemetry_series
    WHERE profile = 'user' AND instrument <> 'mission.telemetry.health.observed_at'`);
  const changedExport = d.prepare(
    `SELECT exported_end FROM telemetry_series
     WHERE profile = 'user' AND instrument = 'mission.telemetry.health.observed_at'`,
  ).get() as { exported_end: number };
  const checkpoint = d.prepare(
    `SELECT consumed_seq FROM telemetry_projection_state
     WHERE projection = ? AND profile = 'user'`,
  ).get(CATALOG_PROJECTION.id) as { consumed_seq: number };

  const exactHour = runProjectionPass(changedExport.exported_end + 60 * 60_000);
  assert.equal(exactHour.batches, 0, "the exact cutoff is not yet older than one hour");
  assert.equal(metricBatches().length, 0);

  const heartbeatAt = changedExport.exported_end + 60 * 60_000 + 1;
  const heartbeat = runProjectionPass(heartbeatAt);
  assert.equal(heartbeat.batches, 1);
  const [payload] = metricBatches();
  assert.equal(payload!.metrics.length, 1);
  assert.equal(payload!.metrics[0]!.name, "mission.telemetry.health.observed_at");
  assert.equal(payload!.metrics[0]!.value, 20);
  assert.equal(payload!.metrics[0]!.startTimeMs, changedExport.exported_end);
  assert.equal(payload!.metrics[0]!.endTimeMs, heartbeatAt);
  assert.equal(
    (d.prepare(
      `SELECT consumed_seq FROM telemetry_projection_state
       WHERE projection = ? AND profile = 'user'`,
    ).get(CATALOG_PROJECTION.id) as { consumed_seq: number }).consumed_seq,
    checkpoint.consumed_seq,
    "an idle heartbeat does not move the journal checkpoint",
  );

  assert.equal(runProjectionPass(heartbeatAt + 1).batches, 0);
  clearBatches();
  d.prepare(
    `UPDATE telemetry_series SET last_time = ?, exported_end = ?
     WHERE profile = 'user' AND instrument = 'mission.telemetry.health.observed_at'`,
  ).run(heartbeatAt - 8 * 24 * 60 * 60_000, heartbeatAt - 2 * 60 * 60_000);
  assert.equal(runProjectionPass(heartbeatAt + 2 * 60 * 60_000).batches, 0);

  const analytical = ANALYTICAL_METRICS[0]!;
  d.prepare(
    `UPDATE telemetry_series SET instrument = ?, last_time = ?, exported_end = ?
     WHERE profile = 'user' AND instrument = 'mission.telemetry.health.observed_at'`,
  ).run(analytical.name, heartbeatAt, heartbeatAt - 2 * 60 * 60_000);
  assert.equal(
    runProjectionPass(heartbeatAt + 3 * 60 * 60_000).batches,
    0,
    "analytical gauges own their own idle snapshots and are excluded from catalog heartbeat",
  );
});

test("switching to delta and changing its endpoint baseline existing history", () => {
  const cumulative = setTelemetryConfig(
    { enabled: true, user: { enabled: true, endpoint: "https://one.example.com" } },
    100,
  );
  assert.equal(cumulative.ok, true);
  captureStart("history", 1_000, 100);
  runProjectionPass(1_001);
  clearBatches();

  const switched = setTelemetryConfig({ user: { temporality: "delta" } }, 2_000);
  assert.equal(switched.ok, true);
  captureStart("after-switch", 3_000, 200);
  runProjectionPass(3_001);
  let point = metricBatches()[0]!.metrics.find((metric) => metric.name === "mission.daemon.starts")!;
  assert.equal(point.value, 1);
  assert.equal(point.startTimeMs, 2_000);

  clearBatches();
  const moved = setTelemetryConfig({ user: { endpoint: "https://two.example.com" } }, 4_000);
  assert.equal(moved.ok, true);
  captureStart("after-move", 5_000, 300);
  runProjectionPass(5_001);
  point = metricBatches()[0]!.metrics.find((metric) => metric.name === "mission.daemon.starts")!;
  assert.equal(point.value, 1);
  assert.equal(point.startTimeMs, 4_000);
});
