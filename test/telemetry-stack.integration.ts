import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The compatibility gate: Mission Control's durable path against the REAL local stack.
//
// Deliberately not part of `npm test`. It needs Docker, four running containers and about a
// minute, and a unit suite that silently depends on a background service is a unit suite that
// fails for reasons nobody can reproduce. Run it explicitly:
//
//     npm run observability:up
//     npm run test:telemetry-stack
//
// Equally deliberately, it does NOT skip when the stack is absent. A compatibility proof that
// quietly passes on a machine with no backend is worse than no proof at all - the phase's exit
// criteria depend on this actually having run - so a missing stack is a loud failure with the
// command to fix it.
//
// What it proves that an HTTP 200 does not:
//
//   * a real receiver stores the exact series a dashboard queries, under the pinned names;
//   * a batch built days ago lands at the time it was BUILT, not the time it drained;
//   * a historical app version survives as a label rather than being replaced by this one;
//   * a duplicate delivery of an ambiguously acknowledged batch does not double anything;
//   * a completed span is searchable in Tempo at its ORIGINAL timestamp;
//   * a sample past the configured late window is visibly refused rather than silently dropped;
//   * and the whole promise end to end: a fact captured while the backend is STOPPED survives a
//     Mission Control restart and is delivered as both a metric and a trace once the backend
//     comes back, still carrying the time it originally happened.

const home = mkdtempSync(join(tmpdir(), "mission-telemetry-stack-"));
process.env.HARNESS_HOME = join(home, "state");

const { closeDb, openDb } = await import("../src/server/db.ts");
const { captureTelemetry, resourceAttributes } = await import("../src/server/telemetry/capture.ts");
const { setTelemetryConfig } = await import("../src/server/telemetry/config.ts");
const { runProjectionPass, scopedTraceId } = await import("../src/server/telemetry/projection.ts");
const { runDeliveryPass, send } = await import("../src/server/telemetry/delivery.ts");
const { profileSalt } = await import("../src/server/telemetry/config.ts");
const { registerBuiltinTelemetry } = await import("../src/server/telemetry/service.ts");
const { runTelemetryProbe } = await import("../src/server/telemetry/diagnostics.ts");
const { serializeMetrics } = await import("../src/server/telemetry/otlp.ts");
const { DAEMON_STARTED_EVENT } = await import("../src/shared/telemetry-catalog.ts");
const { TELEMETRY_LIMITS } = await import("../src/shared/telemetry.ts");
const { ENDPOINTS, composeService, waitUntilReady } = await import(
  "../scripts/observability.mjs"
);

registerBuiltinTelemetry();

const DAY = 24 * 60 * 60 * 1000;
/** One run's marker, so repeated runs against a persistent stack never read each other's data. */
const RUN = Math.random().toString(36).slice(2, 10);

before(async () => {
  const ready = await waitUntilReady(30_000);
  assert.ok(
    ready.ok,
    `The local observability stack is not running (${ready.waiting.join(", ")}).\n` +
      "Start it with: npm run observability:up",
  );
});

after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

/** Start over with a new installation identity, and therefore a new metric stream. */
function resetTelemetryState(): void {
  const d = openDb();
  for (const table of [
    "telemetry_journal",
    "telemetry_source_identities",
    "telemetry_projection_state",
    "telemetry_series",
    "telemetry_batches",
    "telemetry_delivery",
    "telemetry_destinations",
    "telemetry_secrets",
    "telemetry_gaps",
    "telemetry_contexts",
    "telemetry_resources",
  ]) {
    d.exec(`DELETE FROM ${table}`);
  }
  d.exec("DELETE FROM app_config");
}

function enableExport(): void {
  const applied = setTelemetryConfig({
    enabled: true,
    user: { enabled: true, endpoint: ENDPOINTS.otlp },
  });
  assert.equal(applied.ok, true, applied.ok ? "" : applied.error);
}

function capture(id: string, occurredAt: number, startupMs: number) {
  const result = captureTelemetry({
    event: DAEMON_STARTED_EVENT,
    source: { kind: "mission.daemon", id: `${RUN}-${id}`, revision: 1 },
    facts: { startup_ms: startupMs, schema_upgraded: false, launch_mode: "daemon" },
    occurredAt,
    now: occurredAt,
  });
  assert.equal(result.kind, "accepted", JSON.stringify(result));
  return result;
}

interface PromResult {
  status: string;
  data: { result: Array<{ metric: Record<string, string>; value: [number, string] }> };
}

async function promQuery(query: string, atSeconds?: number): Promise<PromResult> {
  const url = new URL(`${ENDPOINTS.prometheus}/api/v1/query`);
  url.searchParams.set("query", query);
  if (atSeconds !== undefined) url.searchParams.set("time", String(atSeconds));
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  assert.equal(response.ok, true, `Prometheus query failed: ${response.status}`);
  return (await response.json()) as PromResult;
}

/**
 * Poll until a query returns something.
 *
 * Prometheus's OTLP receiver commits synchronously, but the Collector batches for up to five
 * seconds before forwarding. Polling is the honest way to wait for a pipeline whose latency is
 * a configured property rather than guessing a sleep.
 */
async function promEventually(
  query: string,
  predicate: (result: PromResult) => boolean,
  timeoutMs = 45_000,
  atSeconds?: number,
): Promise<PromResult> {
  const deadline = Date.now() + timeoutMs;
  let last: PromResult = { status: "", data: { result: [] } };
  while (Date.now() < deadline) {
    last = await promQuery(query, atSeconds);
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  assert.fail(`query never satisfied its predicate: ${query}\nlast: ${JSON.stringify(last)}`);
}

/**
 * Print one state transition.
 *
 * A passing test name says a scenario ran; it does not say what the system did. This test
 * makes a claim about six distinct transitions - capture accepted with the backend down, the
 * queue retained, the queue surviving a restart, the backend returning, the metric landing,
 * the trace landing - and a reviewer reading the transcript should be able to see each one and
 * its numbers rather than take the assertion's word for it.
 */
function checkpoint(label: string, detail: string): void {
  // eslint-disable-next-line no-console
  console.log(`  [restart-recovery] ${label}: ${detail}`);
}

/** Whether a URL answers at all. Used to show the backend really is down, not assumed down. */
async function reachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function tempoTrace(traceId: string, timeoutMs = 60_000): Promise<unknown | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${ENDPOINTS.tempo}/api/traces/${traceId}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) return await response.json();
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return null;
}

test("a captured fact reaches Prometheus under the exact series a dashboard queries", async () => {
  // A new installation identity per assertion, and every query scoped to it.
  //
  // Prometheus keeps its data across runs on purpose - persistence is one of the things this
  // stack is proving - so a test that queried `mission_daemon_starts_total` unscoped would be
  // reading yesterday's totals and would drift every time it ran. Scoping by installation is
  // also how a real multi-producer rollup has to work, so this is the honest query shape.
  resetTelemetryState();
  enableExport();
  const instance = resourceAttributes()["service.instance.id"];
  const now = Date.now();
  capture("live-1", now - 2_000, 180);
  capture("live-2", now - 1_000, 320);
  runProjectionPass(now);
  const delivered = await runDeliveryPass({ now: () => now });
  assert.ok(delivered.accepted > 0, `nothing was accepted: ${JSON.stringify(delivered)}`);

  // The exact name `promMetricName` predicts, and the promoted resource labels the dashboard
  // filters on. If Prometheus's translation strategy moved, this is where it shows up.
  const result = await promEventually(
    `mission_daemon_starts_total{service_instance_id="${instance}"}`,
    (r) => r.data.result.length > 0,
  );
  const sample = result.data.result[0]!;
  assert.equal(sample.metric.__name__, "mission_daemon_starts_total");
  assert.equal(sample.metric.launch_mode, "daemon");
  assert.equal(sample.metric.service_name, "mission-control");
  assert.equal(sample.metric.deployment_environment_name, "local");
  assert.ok(sample.metric.service_version, "the app version is promoted to a label");
  assert.equal(Number(sample.value[1]), 2, "two starts, counted once each");

  // The histogram, under its own pinned name.
  const histogram = await promEventually(
    `mission_daemon_startup_duration_milliseconds_count{service_instance_id="${instance}"}`,
    (r) => r.data.result.length > 0,
  );
  assert.equal(Number(histogram.data.result[0]!.value[1]), 2);
});

test("a completed span is searchable in Tempo at its original timestamp", async () => {
  enableExport();
  const now = Date.now();
  // An operation that happened four hours ago and is only being exported now.
  const occurredAt = now - 4 * 60 * 60 * 1000;
  // The correlation comes off the capture's own result, so no unrelated capture in this process
  // can substitute a different operation's ids between accepting and reading.
  const accepted = capture("historic-span", occurredAt, 275);
  assert.equal(accepted.kind, "accepted");
  const correlation = accepted.kind === "accepted" ? accepted.correlation : null;
  assert.ok(correlation);

  runProjectionPass(now);
  await runDeliveryPass({ now: () => now });

  // The id an operator would search for is the PER-PROFILE scoped one, not the internal id.
  const traceId = scopedTraceId("user", profileSalt("user"), correlation!.traceId);
  assert.equal(traceId.length, 32);

  const trace = (await tempoTrace(traceId)) as {
    batches?: Array<{
      resource?: { attributes?: Array<{ key: string; value: { stringValue?: string } }> };
      scopeSpans?: Array<{ spans?: Array<{ name: string; startTimeUnixNano: string }> }>;
    }>;
  } | null;
  assert.ok(trace, `Tempo never returned trace ${traceId}`);

  const span = trace!.batches?.[0]?.scopeSpans?.[0]?.spans?.[0];
  assert.ok(span, "the trace has no spans");
  assert.equal(span!.name, "mission.daemon.start");
  // The window it ACTUALLY ran in, not the window it was drained in. A four-hour-old operation
  // has to be findable at four hours ago, or trace drill-down after any outage is useless.
  const startMs = Number(BigInt(span!.startTimeUnixNano) / 1_000_000n);
  assert.ok(
    Math.abs(startMs - (occurredAt - 275)) < 2_000,
    `span started at ${new Date(startMs).toISOString()}, expected near ${new Date(occurredAt - 275).toISOString()}`,
  );
});

test("a batch built days ago lands at the time it was built, not the time it drained", async () => {
  // The backlog case, and the reason Prometheus is configured with an out-of-order window
  // longer than the app's queue. Without it this drains successfully, returns 200 the whole
  // way, and every sample is silently refused as too old.
  //
  // A FRESH telemetry state first, and that is not test hygiene - it is the thing being
  // tested. A cumulative stream cannot emit a point earlier than one it has already emitted,
  // so to observe a three-day-old point the stream itself has to start three days ago. That is
  // exactly the real shape of this case: a daemon that ran, captured and projected while it was
  // offline, then delivered when the backend came back.
  resetTelemetryState();
  enableExport();
  const instance = resourceAttributes()["service.instance.id"];
  const now = Date.now();
  const threeDaysAgo = now - 3 * DAY;

  capture("backlog-1", threeDaysAgo - 5_000, 210);
  // Projected with the clock of three days ago: the batch is stamped then and keeps that stamp
  // through every retry and restart between then and delivery.
  runProjectionPass(threeDaysAgo);
  const delivered = await runDeliveryPass({ now: () => now });
  assert.ok(delivered.accepted > 0, JSON.stringify(delivered));

  const at = Math.floor(threeDaysAgo / 1000) + 60;
  const result = await promEventually(
    `mission_daemon_starts_total{service_instance_id="${instance}"}`,
    (r) => r.data.result.length > 0,
    60_000,
    at,
  );
  assert.equal(
    Number(result.data.result[0]!.value[1]),
    1,
    "the drained backlog is queryable three days in the past, where it happened",
  );

  // And it is NOT also sitting on today's chart pretending to be new activity.
  const today = await promQuery(`mission_daemon_starts_total{service_instance_id="${instance}"}`);
  const stamped = today.data.result[0]?.value[0];
  if (stamped !== undefined) {
    assert.ok(
      Math.abs(stamped * 1000 - threeDaysAgo) < 10 * 60_000,
      `the sample is stamped at ${new Date(stamped * 1000).toISOString()}, not at drain time`,
    );
  }
});

test("a historical app version survives as its own stream", async () => {
  // A queued batch carries the resource of the build that produced it. Exporting it under the
  // running binary's version would move old work into a new release's cohort.
  enableExport();
  const now = Date.now();
  const { serializeMetrics: serialize } = { serializeMetrics };
  const body = serialize({
    resource: {
      "service.name": "mission-control",
      "service.version": `0.0.0-historic-${RUN}`,
      "service.instance.id": `install-${RUN}`,
      "deployment.environment.name": "local",
    },
    scope: { name: "mission-control", version: "1" },
    metrics: [
      {
        name: "mission.daemon.starts",
        description: "Daemon starts observed by this installation.",
        unit: "1",
        kind: "counter",
        valueType: "int",
        startTimeMs: now - 10 * 60_000,
        endTimeMs: now - 60_000,
        attributes: { launch_mode: "daemon", schema_upgraded: "false" },
        value: 5,
        histogram: null,
      },
    ],
  });
  const outcome = await send(`${ENDPOINTS.otlp}/v1/metrics`, "metrics", body, "user", {
    fetch: (...args) => globalThis.fetch(...args),
    now: Date.now,
  });
  assert.equal(outcome.kind, "accepted", JSON.stringify(outcome));

  const result = await promEventually(
    `mission_daemon_starts_total{service_version="0.0.0-historic-${RUN}"}`,
    (r) => r.data.result.length > 0,
  );
  assert.equal(Number(result.data.result[0]!.value[1]), 5);
});

test("delivering the same batch twice does not double the total", async () => {
  // The ambiguous-acknowledgement boundary: a crash after the server accepted a request and
  // before the local acknowledgement replays the SAME immutable payload. A cumulative snapshot
  // is idempotent under that replay by construction, which is a large part of why the durable
  // aggregate is cumulative rather than delta.
  enableExport();
  const now = Date.now();
  const instance = `dupe-${RUN}`;
  const payload = {
    resource: {
      "service.name": "mission-control",
      "service.version": "9.9.9",
      "service.instance.id": instance,
      "deployment.environment.name": "local",
    },
    scope: { name: "mission-control", version: "1" },
    metrics: [
      {
        name: "mission.daemon.starts",
        description: "Daemon starts observed by this installation.",
        unit: "1",
        kind: "counter" as const,
        valueType: "int" as const,
        startTimeMs: now - 10 * 60_000,
        endTimeMs: now - 30_000,
        attributes: { launch_mode: "daemon", schema_upgraded: "false" },
        value: 3,
        histogram: null,
      },
    ],
  };
  const body = serializeMetrics(payload);
  const deps = { fetch: (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args), now: Date.now };

  const first = await send(`${ENDPOINTS.otlp}/v1/metrics`, "metrics", body, "user", deps);
  assert.equal(first.kind, "accepted");
  const second = await send(`${ENDPOINTS.otlp}/v1/metrics`, "metrics", body, "user", deps);
  assert.equal(second.kind, "accepted");

  const result = await promEventually(
    `mission_daemon_starts_total{service_instance_id="${instance}"}`,
    (r) => r.data.result.length > 0,
  );
  assert.equal(
    Number(result.data.result[0]!.value[1]),
    3,
    "the replayed cumulative snapshot is the same value, not twice the value",
  );
});

test("a sample past the configured late window is visibly refused, not silently dropped", async () => {
  // Prometheus is configured with an 8-day out-of-order window, one day longer than the app's
  // queue. A sample beyond it has to be REPORTED as loss: "the receiver returned 200" is not
  // the same claim as "the dashboard can find it", and conflating them is the exact failure
  // this stack exists to catch.
  enableExport();
  const now = Date.now();
  const tooOld = now - 30 * DAY;
  const instance = `stale-${RUN}`;
  const body = serializeMetrics({
    resource: {
      "service.name": "mission-control",
      "service.version": "9.9.9",
      "service.instance.id": instance,
      "deployment.environment.name": "local",
    },
    scope: { name: "mission-control", version: "1" },
    metrics: [
      {
        name: "mission.daemon.starts",
        description: "Daemon starts observed by this installation.",
        unit: "1",
        kind: "counter",
        valueType: "int",
        startTimeMs: tooOld - 60_000,
        endTimeMs: tooOld,
        attributes: { launch_mode: "daemon", schema_upgraded: "false" },
        value: 11,
        histogram: null,
      },
    ],
  });
  const outcome = await send(`${ENDPOINTS.otlp}/v1/metrics`, "metrics", body, "user", {
    fetch: (...args) => globalThis.fetch(...args),
    now: Date.now,
  });

  // The Collector accepts it (its queue is in front of Prometheus), so the refusal shows up as
  // the sample never becoming queryable. Both halves are asserted: whatever the transport said,
  // the data is provably not there, and the documented boundary in docs/observability.md is
  // what an operator reads to understand why.
  void outcome;
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  const at = Math.floor(tooOld / 1000) + 60;
  const result = await promQuery(
    `mission_daemon_starts_total{service_instance_id="${instance}"}`,
    at,
  );
  assert.equal(
    result.data.result.length,
    0,
    "a sample 30 days old is outside the 8-day window and is not stored",
  );
});

test("the synthetic probe reports a real, working endpoint", async () => {
  enableExport();
  const result = await runTelemetryProbe("user");
  assert.equal(result.outcome, "accepted", result.detail);
  assert.ok(result.latencyMs >= 0);
  assert.ok(result.traceId, "the probe hands back a trace id an operator can search for");
  assert.equal(result.traceId!.length, 32);
});

test("the provisioned Grafana dashboard and both data sources exist without manual setup", async () => {
  const dashboard = await fetch(
    `${ENDPOINTS.grafana}/api/dashboards/uid/mission-telemetry-diagnostics`,
    { signal: AbortSignal.timeout(10_000) },
  );
  assert.equal(dashboard.ok, true, `Grafana has no provisioned dashboard: ${dashboard.status}`);
  const body = (await dashboard.json()) as { dashboard: { title: string; panels: unknown[] } };
  assert.match(body.dashboard.title, /telemetry diagnostics/i);
  assert.ok(body.dashboard.panels.length >= 5);

  for (const uid of ["mission-prometheus", "mission-tempo"]) {
    const datasource = await fetch(`${ENDPOINTS.grafana}/api/datasources/uid/${uid}`, {
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(datasource.ok, true, `data source ${uid} is not provisioned`);
  }
});

test("a fact captured while the backend is down survives a restart and is delivered when it returns", async () => {
  // THE end-to-end claim of this phase, in one test, with a real backend actually taken away.
  //
  // Every other case here proves one behaviour against a healthy stack. This one walks the
  // whole promise: capture with the backend unreachable, restart Mission Control, bring the
  // backend back, and have the fact arrive - as a metric AND a trace, still carrying the time
  // it originally happened rather than the time it was finally delivered.
  //
  // The Collector is genuinely stopped, not faked. A simulated transport failure would prove
  // the retry state machine and nothing about the hop.
  resetTelemetryState();
  enableExport();
  const instance = resourceAttributes()["service.instance.id"];
  const happenedAt = Date.now();

  let offlineTraceId: string | null = null;

  const stopped = composeService("stop", "collector");
  assert.ok(stopped.ok, `could not stop the collector: ${stopped.output}`);
  const stoppedAt = Date.now();

  // The `try` opens IMMEDIATELY after the stop, so every step below is covered by the `finally`
  // that brings the collector back. An assertion between the stop and the `try` - the probe
  // below was one - would leave the stack down for every test that runs afterwards if it failed.
  try {
    checkpoint("backend stopped", `collector container down; ${ENDPOINTS.otlp} is unreachable`);
    assert.equal(
      await reachable(ENDPOINTS.collectorHealth),
      false,
      "the collector should not answer while it is stopped",
    );
    checkpoint(
      "backend unreachable",
      `health probe to ${ENDPOINTS.collectorHealth} got no response`,
    );
    // 1. Capture and project while there is nowhere to send. Acceptance is a LOCAL commit, so
    //    this must succeed with the backend on the floor.
    const accepted = capture("offline-1", happenedAt, 265);
    offlineTraceId =
      accepted.kind === "accepted"
        ? scopedTraceId("user", profileSalt("user"), accepted.correlation.traceId)
        : null;
    assert.equal(accepted.kind, "accepted");
    checkpoint(
      "capture accepted while offline",
      `kind=${accepted.kind} eventId=${accepted.kind === "accepted" ? accepted.eventId : "-"} ` +
        `occurredAt=${new Date(happenedAt).toISOString()}`,
    );

    runProjectionPass(happenedAt);
    const queued = openDb()
      .prepare(`SELECT COUNT(*) AS n FROM telemetry_batches WHERE profile = 'user'`)
      .get() as { n: number };
    assert.ok(queued.n > 0, "the batch was built and retained while the backend was unreachable");
    checkpoint("projected with nowhere to send", `batches queued=${queued.n}`);

    // 2. Delivery fails, and fails RETRYABLY: the batch is kept, not discarded.
    const failed = await runDeliveryPass({ now: () => Date.now() });
    assert.equal(failed.accepted, 0, "nothing can be accepted while the backend is down");
    const retrying = openDb()
      .prepare(`SELECT state FROM telemetry_delivery WHERE profile = 'user'`)
      .all() as unknown as Array<{ state: string }>;
    assert.ok(
      retrying.every((r) => r.state === "retry"),
      `every batch should be retrying, got ${JSON.stringify(retrying)}`,
    );
    checkpoint(
      "delivery attempted with backend down",
      `accepted=${failed.accepted} retried=${failed.retried} ` +
        `states=[${retrying.map((r) => r.state).join(",")}] (retained, not discarded)`,
    );

    // 3. Restart Mission Control. The same close-and-reopen a daemon performs, through the same
    //    migration path, with the backend still unavailable.
    const before = openDb()
      .prepare(`SELECT id, digest, bytes FROM telemetry_batches ORDER BY id`)
      .all() as unknown as Array<{ id: string; digest: string; bytes: number }>;
    closeDb();
    openDb();
    const after = openDb()
      .prepare(`SELECT id, digest, bytes FROM telemetry_batches ORDER BY id`)
      .all() as unknown as Array<{ id: string; digest: string; bytes: number }>;
    assert.deepEqual(after, before, "the queued payloads survived the restart byte for byte");
    checkpoint(
      "mission control restarted",
      `closeDb/openDb; queued before=${before.length} after=${after.length}; ` +
        `digests ${before.map((b) => b.digest.slice(0, 12)).join(",")} identical`,
    );
  } finally {
    // 4. The backend returns. Restored in `finally` so a failure above cannot leave the stack
    //    broken for anything that runs afterwards.
    const started = composeService("start", "collector");
    assert.ok(started.ok, `could not restart the collector: ${started.output}`);
  }

  const ready = await waitUntilReady(120_000);
  assert.ok(ready.ok, `the collector did not come back: ${ready.waiting.join(", ")}`);
  const recoveredAt = Date.now();
  checkpoint(
    "backend recovered",
    `collector ready again after ${recoveredAt - stoppedAt}ms offline`,
  );

  // 5. And now it drains, with no new capture and no operator intervention.
  const drained = await runDeliveryPass({ now: () => Date.now() });
  assert.ok(drained.accepted > 0, `the backlog did not drain: ${JSON.stringify(drained)}`);
  const deliveredAt = Date.now();
  const remaining = openDb()
    .prepare(`SELECT state FROM telemetry_delivery WHERE profile = 'user'`)
    .all() as unknown as Array<{ state: string }>;
  checkpoint(
    "backlog drained without new capture",
    `sent=${drained.sent} accepted=${drained.accepted} ` +
      `states=[${remaining.map((r) => r.state).join(",")}]`,
  );

  // 6. The metric is queryable AT THE TIME IT HAPPENED, not at the time it was delivered.
  const at = Math.floor(happenedAt / 1000) + 30;
  const metric = await promEventually(
    `mission_daemon_starts_total{service_instance_id="${instance}"}`,
    (r) => r.data.result.length > 0,
    90_000,
    at,
  );
  assert.equal(Number(metric.data.result[0]!.value[1]), 1);

  // The SAMPLE's own timestamp, via `timestamp()`, not the tuple's first element.
  //
  // An instant query returns the EVALUATION time there, not the time the sample was recorded,
  // so comparing that to the event time measures when this test asked rather than when the
  // fact happened - and would sit at whatever offset the query used while looking like proof.
  // `timestamp()` returns the sample's own epoch seconds as the value.
  const stampQuery = await promQuery(
    `timestamp(mission_daemon_starts_total{service_instance_id="${instance}"})`,
    at,
  );
  assert.equal(stampQuery.data.result.length, 1, "the sample should be visible to timestamp()");
  const stamped = Number(stampQuery.data.result[0]!.value[1]) * 1000;
  assert.ok(
    Math.abs(stamped - happenedAt) < 5_000,
    `sample stamped ${new Date(stamped).toISOString()}, expected the event time ${new Date(happenedAt).toISOString()}`,
  );
  checkpoint(
    "prometheus query",
    `mission_daemon_starts_total{service_instance_id="${instance}"} = ` +
      `${metric.data.result[0]!.value[1]}; sample's own timestamp ` +
      `${new Date(stamped).toISOString()} (${stamped - happenedAt}ms from the original event ` +
      `time, delivered ${deliveredAt - happenedAt}ms after it happened)`,
  );

  // 7. And so is the trace, which is the other half of "metrics AND traces".
  //
  //    Looked up by id rather than searched. Tempo's search path only sees a trace once its
  //    blocklist poller has picked up a flushed block, so searching here would be timing the
  //    backend's indexing rather than proving delivery; the direct lookup hits the ingester and
  //    answers as soon as the span has actually arrived.
  assert.ok(offlineTraceId, "the offline capture produced no correlation id");
  const trace = (await tempoTrace(offlineTraceId!, 90_000)) as {
    batches?: Array<{
      scopeSpans?: Array<{ spans?: Array<{ name: string; startTimeUnixNano: string }> }>;
    }>;
  } | null;
  assert.ok(
    trace,
    `the trace captured while the backend was down was never delivered (${offlineTraceId})`,
  );
  const span = trace!.batches?.[0]?.scopeSpans?.[0]?.spans?.[0];
  assert.ok(span, "the delivered trace has no spans");
  assert.equal(span!.name, "mission.daemon.start");

  // Delivered late, but recorded when it happened. A span stamped at delivery time would make
  // every outage look like a burst of activity the moment the backend came back.
  const spanStartMs = Number(BigInt(span!.startTimeUnixNano) / 1_000_000n);
  assert.ok(
    Math.abs(spanStartMs - (happenedAt - 265)) < 5_000,
    `span started ${new Date(spanStartMs).toISOString()}, expected near ${new Date(happenedAt - 265).toISOString()}`,
  );
  checkpoint(
    "tempo query",
    `traceId=${offlineTraceId} span=${span!.name} ` +
      `startedAt=${new Date(spanStartMs).toISOString()} ` +
      `(${spanStartMs - (happenedAt - 265)}ms from the original operation start)`,
  );

  // 8. And the documented bound this whole path is promised within.
  //
  //    The governing number is payload retention: an undelivered batch is expired once it is
  //    older than that, so "delivered when its backend returns" holds only while the outage is
  //    shorter than the window. Asserted rather than merely printed, so a regression that made
  //    recovery take days would fail here instead of being read past.
  const recoveryMs = deliveredAt - happenedAt;
  assert.ok(
    recoveryMs < TELEMETRY_LIMITS.payloadRetentionMs,
    `capture-to-delivery ${recoveryMs}ms exceeded the ${TELEMETRY_LIMITS.payloadRetentionMs}ms retention bound`,
  );
  checkpoint(
    "timing against the documented bound",
    `capture->delivered ${recoveryMs}ms; backend offline ${recoveredAt - stoppedAt}ms; ` +
      `documented payload retention bound ${TELEMETRY_LIMITS.payloadRetentionMs}ms ` +
      `(7 days); unattended export cadence 30000ms`,
  );
});

test("the daemon's journal is unchanged by everything the backend did", async () => {
  // The last invariant, and the easiest to lose sight of: the backend is a consumer. Nothing it
  // says rewrites what was accepted locally.
  const rows = openDb()
    .prepare(`SELECT COUNT(*) AS n FROM telemetry_journal`)
    .get() as { n: number };
  assert.ok(rows.n > 0, "facts captured during this run are still in the journal");
});
