import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const home = mkdtempSync(join(tmpdir(), "mission-analytics-stack-"));
process.env.MISSION_HOME = home;
process.env.MISSION_TELEMETRY_ENVIRONMENT = "test";
const { closeDb, openDb } = await import("../src/server/db.ts");
const { captureTelemetry, resourceAttributes } = await import("../src/server/telemetry/capture.ts");
const { setTelemetryConfig } = await import("../src/server/telemetry/config.ts");
const { registerAnalyticalTelemetry } = await import("../src/server/telemetry/projections/index.ts");
const { runProjectionPass } = await import("../src/server/telemetry/projection.ts");
const { runDeliveryPass, send } = await import("../src/server/telemetry/delivery.ts");
const { serializeMetrics } = await import("../src/server/telemetry/otlp.ts");
const { TELEMETRY_EVENTS } = await import("../src/shared/telemetry-catalog.ts");
const { analyticalCoherenceQuery, analyticalValueQuery, analyticalPromName } = await import("../src/shared/telemetry-projections/queries.ts");
const { analyticalGoldenFixture, analyticalEvent, ANALYTICAL_DAY: DAY } = await import("./helpers/analytical-telemetry.ts");
const { ENDPOINTS, waitUntilReady } = await import("../scripts/observability.mjs");
type Payload = import("../src/server/telemetry/projection.ts").MetricsBatchPayload;
type Result = { metric: Record<string, string>; value: [number, string] };
after(() => { closeDb(); rmSync(home, { recursive: true, force: true }); });
async function query(expression: string, at: number): Promise<Result[]> {
  const url = new URL("/api/v1/query", ENDPOINTS.prometheus);
  url.searchParams.set("query", expression); url.searchParams.set("time", String(at / 1000));
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const body = await response.json() as { status: string; error?: string; data: { result: Result[] } };
  assert.equal(response.ok, true, JSON.stringify(body));
  assert.equal(body.status, "success", body.error);
  return body.data.result;
}
async function eventually(expression: string, at: number, expected: number): Promise<Result[]> {
  const end = Date.now() + 60_000;
  let result: Result[] = [];
  do {
    result = await query(expression, at);
    if (result.length === 1 && Number(result[0]!.value[1]) === expected) return result;
    await new Promise((resolve) => setTimeout(resolve, 300));
  } while (Date.now() < end);
  assert.fail(`expected ${expected}: ${expression}\n${JSON.stringify(result)}`);
}

test("real OTLP/Prometheus analytical oracle, restart/replay, translation and partial/stale snapshot guards", async () => {
  const ready = await waitUntilReady(30_000);
  assert.ok(ready.ok, `Start the local receiver with npm run observability:up: ${ready.waiting.join(", ")}`);
  registerAnalyticalTelemetry();
  const now = Date.now() - 120_000;
  assert.equal(setTelemetryConfig({ enabled: true, user: { enabled: true, endpoint: ENDPOINTS.otlp } }, now - 15 * DAY).ok, true);
  for (const event of analyticalGoldenFixture(now)) {
    const result = captureTelemetry({ event: TELEMETRY_EVENTS[event.name]!, source: { kind: "mission.analytics.fixture", id: event.eventId, revision: 1 },
      facts: event.facts, refs: event.refs, actor: event.actor, occurredAt: event.occurredAt, now: event.observedAt });
    assert.equal(result.kind, "accepted");
  }
  runProjectionPass(now);
  const instance = resourceAttributes()["service.instance.id"];
  const labels = `service_instance_id="${instance}",audience="user",slice_by="all",slice="all",window="7d",horizon="7d"`;
  const snapshot = JSON.parse((openDb().prepare("SELECT payload_json FROM telemetry_batches WHERE profile='user' AND signal='metrics'").get() as { payload_json: string }).payload_json) as Payload;
  const saved = openDb().prepare("SELECT id,digest,payload_json FROM telemetry_batches ORDER BY id").all();
  closeDb(); openDb(); runProjectionPass(now);
  assert.deepEqual(openDb().prepare("SELECT id,digest,payload_json FROM telemetry_batches ORDER BY id").all(), saved);
  assert.ok((await runDeliveryPass()).accepted > 0);
  await eventually(analyticalValueQuery("runs", "eligible", labels), now + 30_000, 6);
  for (const [view, field, expected] of [
    ["reviews", "executed", 8], ["reviews", "pass", 6], ["reviews", "fail", 2],
    ["runs", "completed", 4], ["runs", "pending", 1], ["runs", "cancelled", 1],
    ["runs", "with_recovery", 1], ["runs", "human_free", 1], ["runs", "automation_eligible", 5],
    ["runs", "ambiguous_actor", 1], ["runs", "complete", 0], ["runs", "calculated_at", now / 1000],
    ["usage", "cost", 0], ["runs", "horizon", 7 * DAY / 1000],
  ] as const) await eventually(analyticalValueQuery(view, field, labels), now + 30_000, expected);
  assert.equal((await query(analyticalCoherenceQuery("runs", labels), now + 30_000)).length, 1);
  console.log("Receiver oracle: reviews=8 pass=6 fail=2; runs=6 completed=4 pending=1 cancelled=1; recovery=1 human-free=1 eligible-for-automation=5 ambiguous=1; one calculation timestamp.");

  const deps = { fetch: globalThis.fetch, now: Date.now, abort: null };
  const replay = await send(`${ENDPOINTS.otlp}/v1/metrics`, "metrics", serializeMetrics(snapshot), "user", deps);
  assert.equal(replay.kind, "accepted");
  await eventually(analyticalValueQuery("runs", "eligible", labels), now + 30_000, 6);

  // A new durable calculation, delivered incompletely on purpose. Simulates receiver partial
  // success without weakening the ordinary delivery acknowledgement contract.
  const at = now + 60_000;
  const extra = analyticalEvent("workflow.run", "R3-finished", now - 9 * DAY, { observation: "finished", status: "completed" }, { run_id: "R3" });
  assert.equal(captureTelemetry({ event: TELEMETRY_EVENTS[extra.name]!, source: { kind: "mission.analytics.fixture", id: extra.eventId, revision: 1 },
    facts: extra.facts, refs: extra.refs, actor: extra.actor, occurredAt: extra.occurredAt, now: at }).kind, "accepted");
  runProjectionPass(at);
  const next = JSON.parse((openDb().prepare("SELECT payload_json FROM telemetry_batches WHERE profile='user' AND signal='metrics' AND created_at=?").get(at) as { payload_json: string }).payload_json) as Payload;
  const partial = { ...next, metrics: next.metrics.filter((p) => p.name !== "mission.analytics.v1.runs.eligible") };
  assert.equal((await send(`${ENDPOINTS.otlp}/v1/metrics`, "metrics", serializeMetrics(partial), "user", deps)).kind, "accepted");
  await eventually(analyticalValueQuery("runs", "calculated_at", labels), at + 30_000, at / 1000);
  assert.equal((await query(analyticalCoherenceQuery("runs", labels), at + 30_000)).length, 0, "new numerator cannot pair with the old denominator");
  assert.ok((await runDeliveryPass()).accepted > 0);
  await eventually(analyticalValueQuery("runs", "completed", labels), at + 30_000, 5);
  // completed was already present in the partial batch; only coherence proves that the
  // restored denominator has passed through the receiver's asynchronous export queue.
  await eventually(`count(${analyticalCoherenceQuery("runs", labels)})`, at + 30_000, 1);
  assert.equal((await query(analyticalCoherenceQuery("runs", labels), at + 60 * 60_000)).length, 1, "hourly quiet-producer samples survive the default instant lookback");
  assert.equal((await query(analyticalCoherenceQuery("runs", labels), at + 2 * 60 * 60_000 + 1)).length, 0, "stale producers are absent, not zero");
  const upgradeAt = at + 30_000;
  const upgraded: Payload = { ...next, resource: { ...next.resource, "service.version": "analytics-upgrade-fixture" },
    metrics: next.metrics.map((point) => ({ ...point, endTimeMs: upgradeAt,
      value: point.name.endsWith(".calculated_at") ? upgradeAt / 1000 : point.value })) };
  assert.equal((await send(`${ENDPOINTS.otlp}/v1/metrics`, "metrics", serializeMetrics(upgraded), "user", deps)).kind, "accepted");
  await eventually(analyticalValueQuery("runs", "calculated_at", `${labels},service_version="analytics-upgrade-fixture"`), upgradeAt + 30_000, upgradeAt / 1000);
  const upgradeGuard = await query(analyticalCoherenceQuery("runs", labels), upgradeAt + 30_000);
  assert.equal(upgradeGuard.length, 1, "an upgrade cannot double an installation across resource versions");
  assert.equal(upgradeGuard[0]!.metric.service_version, "analytics-upgrade-fixture");
  console.log(`Verified ${analyticalPromName("runs", "calculated_at")}; restart/replay retained counts; partial snapshot suppressed; full snapshot restored; one-hour lookback valid; stale producer suppressed.`);
  console.log("Version overlap: one latest calculation per installation, with immutable original resource context retained.");
});
