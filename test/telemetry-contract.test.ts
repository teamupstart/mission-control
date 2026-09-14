import { test } from "node:test";
import assert from "node:assert/strict";

// The contract layer: the catalog's own rules, and the OTLP serialization boundary.
//
// No database and no daemon - these are pure functions over the registry and over a persisted
// batch, which is exactly the level the two failures they guard against live at. A catalog
// entry with an unbounded dimension is a defect the moment it is written, and a serializer
// that substitutes the running binary's resource for a queued batch's resource is a defect
// that only shows up as a chart quietly attributing old work to a new release.

import {
  DAEMON_STARTED_EVENT,
  DAEMON_STARTS_METRIC,
  DAEMON_STARTUP_DURATION_METRIC,
  FORBIDDEN_METRIC_DIMENSIONS,
  TELEMETRY_EVENTS,
  TELEMETRY_FEATURE_GROUPS,
  TELEMETRY_METRICS,
  TELEMETRY_PROBES_METRIC,
  metricsForEvent,
  promMetricName,
  telemetryCatalogProblems,
} from "../src/shared/telemetry-catalog.ts";
import { TELEMETRY_PROFILE_IDS } from "../src/shared/telemetry.ts";
import {
  readMetricsPartialSuccess,
  serializeMetrics,
  serializeTraces,
  toReadableSpans,
  toResourceMetrics,
} from "../src/server/telemetry/otlp.ts";

test("the registered catalog satisfies every declared rule", () => {
  assert.deepEqual(telemetryCatalogProblems(), []);
});

test("every feature group declares the phase that owns adding entries to it", () => {
  // The taxonomy is a reservation, not a backlog: a Phase 3 author must find
  // `session_lifecycle` already here rather than coining `sessions` beside it.
  for (const [name, group] of Object.entries(TELEMETRY_FEATURE_GROUPS)) {
    assert.ok(group.phase >= 1 && group.phase <= 7, `${name} has no owning phase`);
    assert.ok(group.summary.length > 0, `${name} has no summary`);
  }
  assert.ok("session_lifecycle" in TELEMETRY_FEATURE_GROUPS);
  assert.ok("persona_review" in TELEMETRY_FEATURE_GROUPS);
  assert.ok("analytics_cohort" in TELEMETRY_FEATURE_GROUPS);
});

test("an event's fact schema rejects an undeclared field", () => {
  // This is the rule that stops a serializer spreading an internal Session, Task or exception
  // object into an envelope. It has to be enforced by the schema, not by a reviewer.
  const accepted = DAEMON_STARTED_EVENT.facts.safeParse({
    startup_ms: 10,
    schema_upgraded: false,
    launch_mode: "daemon",
  });
  assert.equal(accepted.success, true);

  const refused = DAEMON_STARTED_EVENT.facts.safeParse({
    startup_ms: 10,
    schema_upgraded: false,
    launch_mode: "daemon",
    repoRoot: "/Users/someone/private-project",
  });
  assert.equal(refused.success, false);
});

test("no instrument carries an unbounded or content-bearing dimension", () => {
  for (const metric of Object.values(TELEMETRY_METRICS)) {
    for (const dimension of metric.dimensions) {
      assert.ok(
        !FORBIDDEN_METRIC_DIMENSIONS.includes(dimension),
        `${metric.name} carries ${dimension}`,
      );
    }
  }
});

test("an instrument cannot reach an audience its source event excludes", () => {
  // The probe is operator-only because P5 requires synthetic connection-test signals stay out
  // of product adoption. The catalog is where that is guaranteed, not the exporter.
  assert.deepEqual([...TELEMETRY_PROBES_METRIC.audience], ["local", "user"]);
  assert.ok(!TELEMETRY_PROBES_METRIC.audience.includes("product"));
  assert.deepEqual([...DAEMON_STARTS_METRIC.audience], [...TELEMETRY_PROFILE_IDS]);
});

test("one event contributes to each of its instruments exactly once", () => {
  const instruments = metricsForEvent(DAEMON_STARTED_EVENT.name).map((m) => m.name);
  assert.deepEqual(instruments, [
    "mission.daemon.starts",
    "mission.daemon.startup.duration",
  ]);
  assert.equal(new Set(instruments).size, instruments.length);
});

test("a contribution is deterministic and total", () => {
  const facts = { startup_ms: 1200, schema_upgraded: true, launch_mode: "daemon" };
  const envelope = {} as never;
  const first = DAEMON_STARTS_METRIC.contribution(facts, envelope);
  const second = DAEMON_STARTS_METRIC.contribution(facts, envelope);
  assert.deepEqual(first, second);
  assert.deepEqual(first, { dimensions: { launch_mode: "daemon", schema_upgraded: "true" }, value: 1 });

  // A missing fact produces no contribution rather than a zero, so a broken observation cannot
  // quietly pull a histogram's average down.
  assert.equal(DAEMON_STARTUP_DURATION_METRIC.contribution({}, envelope), null);
});

test("the Prometheus names dashboards query are pinned, not discovered", () => {
  // A panel goes empty without a word of warning when a receiver's translation default moves.
  // Pinning the expected name here is what turns that into a failing test instead.
  assert.equal(promMetricName(DAEMON_STARTS_METRIC), "mission_daemon_starts_total");
  assert.equal(
    promMetricName(DAEMON_STARTUP_DURATION_METRIC),
    "mission_daemon_startup_duration_milliseconds",
  );
  assert.equal(promMetricName(TELEMETRY_PROBES_METRIC), "mission_telemetry_probes_total");
});

test("every event name is namespaced and every instrument names a real event", () => {
  for (const event of Object.values(TELEMETRY_EVENTS)) {
    assert.ok(event.name.startsWith("mission."));
  }
  for (const metric of Object.values(TELEMETRY_METRICS)) {
    assert.ok(TELEMETRY_EVENTS[metric.event], `${metric.name} has no source event`);
  }
});

// ---- the serialization boundary ----

const HISTORICAL_RESOURCE = {
  "service.name": "mission-control",
  "service.version": "1.9.0",
  "service.instance.id": "install-abc",
};

function historicalBatch() {
  return {
    resource: HISTORICAL_RESOURCE,
    scope: { name: "mission-control", version: "1" },
    metrics: [
      {
        name: "mission.daemon.starts",
        description: "d",
        unit: "1",
        kind: "counter" as const,
        valueType: "int" as const,
        startTimeMs: 1_757_000_000_000,
        endTimeMs: 1_757_000_060_000,
        attributes: { launch_mode: "daemon", schema_upgraded: "false" },
        value: 7,
        histogram: null,
      },
    ],
  };
}

test("a queued batch keeps its OWN resource, not the running binary's", () => {
  // This is the whole reason the exporter does not go through a MetricReader. The documented
  // behaviour of the experimental `metricProducers` option is that the reader REPLACES an
  // additional producer's resource - which would restamp every replayed batch with today's
  // service.version and move yesterday's work into a new release cohort.
  const resourceMetrics = toResourceMetrics(historicalBatch());
  assert.equal(resourceMetrics.resource.attributes["service.version"], "1.9.0");
  assert.notEqual(resourceMetrics.resource.attributes["service.version"], process.env.npm_package_version);
});

test("a queued batch keeps its original timestamps", () => {
  const [metric] = toResourceMetrics(historicalBatch()).scopeMetrics[0]!.metrics;
  const point = metric!.dataPoints[0]!;
  // HrTime is [seconds, nanos]; 1_757_000_000_000 ms is 1_757_000_000 s exactly.
  assert.deepEqual(point.startTime, [1_757_000_000, 0]);
  assert.deepEqual(point.endTime, [1_757_000_060, 0]);
});

test("cumulative temporality is what a monotonic counter is exported as", () => {
  const [metric] = toResourceMetrics(historicalBatch()).scopeMetrics[0]!.metrics;
  // Delta would make a restart indistinguishable from a reset. The durable series IS
  // cumulative and survives restarts, so this is the only honest temporality for it.
  assert.equal(metric!.aggregationTemporality, 1 /* CUMULATIVE */);
  assert.equal((metric as { isMonotonic?: boolean }).isMonotonic, true);
});

test("a metrics batch serializes to OTLP protobuf bytes", () => {
  const bytes = serializeMetrics(historicalBatch());
  assert.ok(bytes.length > 0);
  // The resource travels in the request rather than being applied by the receiver, so the
  // historical version has to be findable in the encoded bytes.
  assert.ok(Buffer.from(bytes).includes(Buffer.from("1.9.0")));
});

test("a histogram batch carries explicit boundaries and bucket counts", () => {
  const bytes = serializeMetrics({
    resource: HISTORICAL_RESOURCE,
    scope: { name: "mission-control", version: "1" },
    metrics: [
      {
        name: "mission.daemon.startup.duration",
        description: "d",
        unit: "ms",
        kind: "histogram",
        valueType: "double",
        startTimeMs: 1_757_000_000_000,
        endTimeMs: 1_757_000_060_000,
        attributes: { launch_mode: "daemon" },
        value: 300,
        histogram: {
          count: 2,
          sum: 450,
          min: 150,
          max: 300,
          boundaries: [100, 250, 500],
          buckets: [0, 1, 1, 0],
        },
      },
    ],
  });
  assert.ok(bytes.length > 0);
});

test("a persisted span descriptor becomes a completed ReadableSpan with its original window", () => {
  // A completed operation does not need a live SDK span to be exported. That is what lets a
  // span survive the durable boundary and still be searchable at the time it actually ran.
  const spans = toReadableSpans({
    resource: HISTORICAL_RESOURCE,
    scope: { name: "mission-control", version: "1" },
    spans: [
      {
        name: "mission.telemetry.probe",
        kind: "client",
        traceId: "0af7651916cd43dd8448eb211c80319c",
        spanId: "b7ad6b7169203331",
        parentSpanId: null,
        startTimeMs: 1_757_000_000_000,
        endTimeMs: 1_757_000_000_250,
        status: "ok",
        statusMessage: null,
        attributes: { "mission.outcome": "accepted" },
      },
    ],
  });
  assert.equal(spans.length, 1);
  const span = spans[0]!;
  assert.equal(span.ended, true);
  assert.deepEqual(span.startTime, [1_757_000_000, 0]);
  assert.deepEqual(span.endTime, [1_757_000_000, 250_000_000]);
  assert.deepEqual(span.duration, [0, 250_000_000]);
  assert.equal(span.resource.attributes["service.version"], "1.9.0");
  assert.equal(span.spanContext().traceId, "0af7651916cd43dd8448eb211c80319c");

  const bytes = serializeTraces({
    resource: HISTORICAL_RESOURCE,
    scope: { name: "mission-control", version: "1" },
    spans: [
      {
        name: "mission.telemetry.probe",
        kind: "client",
        traceId: "0af7651916cd43dd8448eb211c80319c",
        spanId: "b7ad6b7169203331",
        parentSpanId: null,
        startTimeMs: 1_757_000_000_000,
        endTimeMs: 1_757_000_000_250,
        status: "ok",
        statusMessage: null,
        attributes: { "mission.outcome": "accepted" },
      },
    ],
  });
  assert.ok(bytes.length > 0);
});

test("a scoped id is one a person can search for in the trace backend", async () => {
  // Tempo, like Jaeger, strips leading zeroes when it stores and displays a trace id. An id
  // beginning `0` would come back a character shorter, so the value `/api/telemetry/probe`
  // hands an operator would not match what the backend shows them. One id in sixteen.
  const { scopedTraceId, scopedSpanId } = await import("../src/server/telemetry/projection.ts");
  for (let i = 0; i < 512; i += 1) {
    const trace = scopedTraceId("user", "salt", `operation-${i}`);
    assert.equal(trace.length, 32, trace);
    assert.match(trace, /^[0-9a-f]{32}$/);
    assert.notEqual(trace[0], "0", `trace id ${trace} would be reformatted by the backend`);

    const span = scopedSpanId("user", "salt", `operation-${i}`);
    assert.equal(span.length, 16, span);
    assert.notEqual(span[0], "0", `span id ${span} would be reformatted by the backend`);
  }
});

test("the same operation gets unrelated ids for different audiences", async () => {
  const { scopedTraceId } = await import("../src/server/telemetry/projection.ts");
  const user = scopedTraceId("user", "salt", "operation-1");
  const product = scopedTraceId("product", "salt", "operation-1");
  assert.notEqual(user, product, "two audiences must not be trivially joinable");
  // And stable, so a retry of the same batch carries the same id.
  assert.equal(user, scopedTraceId("user", "salt", "operation-1"));
});

test("a long string is cut to the byte budget without splitting a character", async () => {
  // Measuring bytes and then slicing UTF-16 units was wrong in both directions: for multi-byte
  // text the result could still exceed the budget, and a cut between the halves of a surrogate
  // pair leaves a lone surrogate, which is not valid UTF-8 and which a protobuf encoder or a
  // backend may refuse. One emoji in a fact was enough.
  const { boundString } = await import("../src/server/telemetry/capture.ts");
  const { TELEMETRY_LIMITS } = await import("../src/shared/telemetry.ts");

  assert.equal(boundString("short"), "short", "a string inside the budget is untouched");

  for (const unit of ["a", "\u00e9", "\u4e2d", "\uD83D\uDE80"]) {
    const cut = boundString(unit.repeat(4_000));
    assert.ok(
      Buffer.byteLength(cut, "utf8") <= TELEMETRY_LIMITS.maxStringBytes,
      `${JSON.stringify(unit)} overflowed the budget at ${Buffer.byteLength(cut, "utf8")} bytes`,
    );
    // A lone surrogate survives a round trip through Buffer as U+FFFD, so comparing the
    // re-decoded bytes to the string is what actually catches a split pair.
    assert.equal(
      Buffer.from(cut, "utf8").toString("utf8"),
      cut,
      `${JSON.stringify(unit)} was cut mid-character`,
    );
    assert.ok(cut.endsWith("\u2026"), "truncation is visible rather than silent");
  }
});

// ---- the extension seams ----

test("registering the same implementation twice is idempotent", async () => {
  // The real case: the daemon entry, `startTelemetry` and a focused test all reach the
  // built-ins. A second registration must not double every count, and must not throw.
  const { registerBuiltinTelemetry } = await import("../src/server/telemetry/service.ts");
  const { registeredProjections, registeredSources, resetTelemetryRegistrations } = await import(
    "../src/server/telemetry/registration.ts"
  );
  resetTelemetryRegistrations();
  registerBuiltinTelemetry();
  registerBuiltinTelemetry();
  registerBuiltinTelemetry();
  assert.deepEqual(registeredProjections().map((p) => p.id), ["mission.catalog"]);
  assert.deepEqual(registeredSources().map((s) => s.id), ["mission.daemon", "mission.telemetry"]);
  resetTelemetryRegistrations();
});

test("a different implementation cannot take an id that is already owned", async () => {
  // These ids are the persisted-state namespace: `telemetry_projection_state` rows are keyed by
  // the projection id, and every dedupe identity is keyed by the source id. A silent replacement
  // would hand one implementation another's checkpoint, and which one won would depend on
  // import order. Refused, loudly, rather than resolved by accident.
  const { registerTelemetryProjection, registerTelemetrySource, resetTelemetryRegistrations } =
    await import("../src/server/telemetry/registration.ts");
  const { CATALOG_PROJECTION } = await import("../src/server/telemetry/projection.ts");
  resetTelemetryRegistrations();

  registerTelemetryProjection(CATALOG_PROJECTION);
  assert.throws(
    () =>
      registerTelemetryProjection({
        ...CATALOG_PROJECTION,
        stateVersion: 99,
      }),
    /already registered by a different implementation/,
  );

  const source = {
    id: "mission.daemon",
    recovers: [],
    unrecoverable: [],
    maxScanPerTick: 0,
  };
  registerTelemetrySource(source);
  registerTelemetrySource(source);
  assert.throws(
    () => registerTelemetrySource({ ...source, maxScanPerTick: 5 }),
    /already registered by a different implementation/,
  );

  resetTelemetryRegistrations();
});

test("an empty OTLP response body is a full success", () => {
  // What every Collector returns on the happy path.
  assert.deepEqual(readMetricsPartialSuccess(new Uint8Array(0)), {
    rejectedItems: 0,
    message: null,
  });
});

test("an undecodable OTLP response is a success with a note, not a retry", () => {
  // The server said 200. Re-sending over a decoding problem on our side is the one response
  // guaranteed to make it worse.
  const result = readMetricsPartialSuccess(new Uint8Array([0xff, 0xff, 0xff, 0xff]));
  assert.equal(result.rejectedItems, 0);
  assert.ok(result.message === null || typeof result.message === "string");
});
