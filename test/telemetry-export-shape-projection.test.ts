import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MetricPointDto, MetricsBatchPayload } from "../src/server/telemetry/projection.ts";
import type { TelemetryProjection } from "../src/server/telemetry/registration.ts";
import type { TelemetryConfigPatch } from "../src/shared/telemetry.ts";

const home = mkdtempSync(join(tmpdir(), "mission-telemetry-shapes-"));
process.env.HARNESS_HOME = join(home, "state");

const { closeDb, openDb } = await import("../src/server/db.ts");
const { captureTelemetry } = await import("../src/server/telemetry/capture.ts");
const { setTelemetryConfig } = await import("../src/server/telemetry/config.ts");
const { runDeliveryPass } = await import("../src/server/telemetry/delivery.ts");
const { runTelemetryProbe } = await import("../src/server/telemetry/diagnostics.ts");
const { serializeMetrics } = await import("../src/server/telemetry/otlp.ts");
const { CATALOG_PROJECTION, committedSeriesWeight, runProjectionPass } = await import(
  "../src/server/telemetry/projection.ts"
);
const { ANALYTICAL_PROJECTION } = await import("../src/server/telemetry/projections/index.ts");
const { registerTelemetryProjection, resetTelemetryRegistrations } = await import(
  "../src/server/telemetry/registration.ts"
);
const { runRetentionPass } = await import("../src/server/telemetry/retention.ts");
const {
  exportLedgerHorizon,
  getDestination,
  getProjectionState,
  getSeries,
  listGaps,
  listSeries,
  resetUsedBytesCache,
} =
  await import("../src/server/telemetry/store.ts");
const { SESSION_KILL_REQUESTED_EVENT } = await import("../src/shared/telemetry-catalog.ts");
const { ANALYTICAL_METRICS } = await import("../src/shared/telemetry-projections/index.ts");
const { TELEMETRY_EXPORT_SHAPES } = await import("../src/shared/telemetry-export-shapes.ts");
const { TELEMETRY_LIMITS, TELEMETRY_OVERFLOW_VALUE } = await import("../src/shared/telemetry.ts");
const scenario = await import("./helpers/telemetry-shape-scenario.ts");

const LEAN = TELEMETRY_EXPORT_SHAPES["datadog-lean"];
const BUDGET = LEAN.seriesBudget as number;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** An hour boundary, so a scenario can stay inside one clock hour. */
const T0 = Math.floor(1_800_000_000_000 / HOUR) * HOUR;

after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  const d = openDb();
  const tables = d
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'telemetry_%'")
    .all() as Array<{ name: string }>;
  for (const { name } of tables) d.exec(`DELETE FROM ${name}`);
  d.exec("DELETE FROM app_config");
  resetUsedBytesCache();
  delete process.env.MISSION_TELEMETRY_ENVIRONMENT;
  plans.length = 0;
});

// ---- a projection that emits exactly what a test asks for ----

interface Emission {
  instrument: string;
  dimensions: Record<string, string>;
  value: number;
}

/** One plan per captured trigger event, consumed in journal order. */
const plans: Emission[][] = [];

const PLAN_PROJECTION: TelemetryProjection<Record<string, never>> = {
  id: "test.export-shape-plan",
  stateVersion: 1,
  initialState: () => ({}),
  migrateState: (state) => state as Record<string, never>,
  reduce(_event, state, emit) {
    for (const m of plans.shift() ?? []) emit.metric(m.instrument, m.dimensions, m.value);
    return state;
  },
};

/**
 * The same plan, under an id that sorts BEFORE `mission.catalog`. Projections run in id order,
 * so its contributions land before the catalog pass carries deferred and heartbeat series.
 */
const EARLY_PLAN_PROJECTION: TelemetryProjection<Record<string, never>> = {
  ...PLAN_PROJECTION,
  id: "a-test.export-shape-plan",
};

function useProjections(...projections: TelemetryProjection<unknown>[]): void {
  resetTelemetryRegistrations();
  for (const projection of projections) registerTelemetryProjection(projection);
}

let triggers = 0;

/**
 * Emit through one trigger event per resource, then run a pass. `environment` selects the
 * resource: a different deployment environment is a different OTLP resource.
 */
function emitAt(now: number, groups: Array<{ environment?: string; emissions: Emission[] }>): void {
  captureOnly(now, groups);
  runProjectionPass(now);
}

/** Capture the triggers without projecting them, as a stalled or stopped projection leaves them. */
function captureOnly(now: number, groups: Array<{ environment?: string; emissions: Emission[] }>): void {
  for (const group of groups) {
    if (group.environment) process.env.MISSION_TELEMETRY_ENVIRONMENT = group.environment;
    else delete process.env.MISSION_TELEMETRY_ENVIRONMENT;
    const captured = captureTelemetry({
      // An event the catalog turns into no metric, so only the plan contributes.
      event: SESSION_KILL_REQUESTED_EVENT,
      source: { kind: "test.trigger", id: `trigger-${(triggers += 1)}`, revision: 1 },
      profiles: ["user"],
      facts: { agent: "claude", runtime: "terminal", outcome: "accepted", actor_basis: "owner" },
      now,
    });
    assert.equal(captured.kind, "accepted");
    plans.push(group.emissions);
  }
  delete process.env.MISSION_TELEMETRY_ENVIRONMENT;
}

const hourOf = (time: number): number => Math.floor(time / HOUR) * HOUR;

const SECOND = "second-resource";

const counter = (action: string, value = 1): Emission => ({
  instrument: "mission.action.count",
  dimensions: { feature: "shape", action, outcome: "ok" },
  value,
});
const counters = (n: number, prefix: string, value = 1): Emission[] =>
  Array.from({ length: n }, (_, i) => counter(`${prefix}-${i}`, value));
const distribution = (agent: string): Emission => ({
  instrument: "mission.dispatch.duration",
  dimensions: { outcome: "launched", agent, runtime: "terminal" },
  value: 1_000,
});
const sumCount = (launchMode: string): Emission => ({
  instrument: "mission.daemon.startup.duration",
  dimensions: { launch_mode: launchMode },
  value: 120,
});
const gauge = (profile: string): Emission => ({
  instrument: "mission.telemetry.health.pending",
  dimensions: { profile },
  value: 4,
});

function configure(user: NonNullable<TelemetryConfigPatch["user"]>, now: number): void {
  const applied = setTelemetryConfig({ enabled: true, user: { enabled: true, ...user } }, now);
  assert.equal(applied.ok, true, applied.ok ? "" : applied.error);
}

function committed(now: number): number {
  const d = openDb();
  return committedSeriesWeight(d, "user", getDestination(d, "user").policyEpoch, LEAN, now);
}

function gap(kind: string): number {
  return listGaps(openDb()).find((g) => g.kind === kind)?.count ?? 0;
}

function rows(instrument: string) {
  return listSeries(openDb(), "user").filter((s) => s.instrument === instrument);
}

const isOverflow = (dimensions: Record<string, string>) =>
  Object.values(dimensions).length > 0 &&
  Object.values(dimensions).every((value) => value === TELEMETRY_OVERFLOW_VALUE);

function ledgerWeight(hourStart: number): number {
  const row = openDb()
    .prepare(
      `SELECT COALESCE(SUM(weight), 0) AS w FROM telemetry_export_hours
        WHERE profile = 'user' AND hour_start = ?`,
    )
    .get(hourStart) as { w: number };
  return row.w;
}

function metricPayloads(): Array<{ generation: number; payload: MetricsBatchPayload }> {
  return (
    openDb()
      .prepare(
        `SELECT destination_generation, payload_json FROM telemetry_batches
          WHERE profile = 'user' AND signal = 'metrics' ORDER BY created_at, id`,
      )
      .all() as Array<{ destination_generation: number; payload_json: string }>
  ).map((row) => ({
    generation: row.destination_generation,
    payload: JSON.parse(row.payload_json) as MetricsBatchPayload,
  }));
}

function points(filter?: (generation: number) => boolean): MetricPointDto[] {
  return metricPayloads()
    .filter(({ generation }) => filter?.(generation) ?? true)
    .flatMap(({ payload }) => payload.metrics);
}

// ---- the default stays exactly what it was ----

test("a default destination's batches are byte-identical to the export before shapes existed", () => {
  useProjections(CATALOG_PROJECTION);
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/telemetry-full-shape-batches.json", import.meta.url), "utf8"),
  ) as { cumulative: MetricsBatchPayload[]; delta: MetricsBatchPayload[] };

  assert.equal(JSON.stringify(scenario.runShapeScenario({})), JSON.stringify(fixture.cumulative));
});

test("a default delta destination's batches are byte-identical too", () => {
  useProjections(CATALOG_PROJECTION);
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/telemetry-full-shape-batches.json", import.meta.url), "utf8"),
  ) as { cumulative: MetricsBatchPayload[]; delta: MetricsBatchPayload[] };

  assert.equal(
    JSON.stringify(scenario.runShapeScenario({ temporality: "delta", exportShape: "full" })),
    JSON.stringify(fixture.delta),
  );
});

// ---- what the lean shape sends ----

test("a lean destination and a full one fed the same events receive different shapes", () => {
  useProjections(CATALOG_PROJECTION, ANALYTICAL_PROJECTION);
  scenario.pinScenarioIdentity();
  const applied = setTelemetryConfig(
    {
      enabled: true,
      user: { enabled: true, endpoint: "https://otlp.example.com" },
      product: {
        enabled: true,
        endpoint: "https://otlp-product.example.com",
        exportShape: "datadog-lean",
      },
    },
    100,
  );
  assert.equal(applied.ok, true, applied.ok ? "" : applied.error);
  const both = ["user", "product"] as const;
  scenario.captureDaemonStart([...both], "lean-start", 1_000, 250);
  scenario.captureDispatch([...both], "lean-dispatch-1", 2_000, { resolution_source: "task" });
  scenario.captureDispatch([...both], "lean-dispatch-2", 2_100, {
    resolution_source: "kind",
    resolved_effort: "low",
  });
  scenario.captureHealth([...both], "lean-health", 2_200, 3);
  // Past the analytical projection's 30-second snapshot cadence, so cohort gauges are emitted.
  runProjectionPass(60_000);

  const full = scenario.metricBatches("user");
  const lean = scenario.metricBatches("product");
  const fullPoints = full.flatMap((p) => p.metrics);
  const leanPoints = lean.flatMap((p) => p.metrics);

  assert.ok(fullPoints.some((p) => p.name.startsWith("mission.analytics.v1.")));
  assert.equal(leanPoints.filter((p) => p.name.startsWith("mission.analytics.v1.")).length, 0);

  assert.ok(full.every((p) => !("datadog.host.name" in p.resource)));
  assert.ok(lean.length > 0);
  for (const payload of lean) {
    assert.equal(payload.resource["datadog.host.name"], "mission-control");
    // Everything else about the resource is untouched.
    assert.equal(payload.resource["service.instance.id"], scenario.SCENARIO_INSTALLATION_ID);
  }

  // Two dispatches that differ only in dropped labels are one lean series.
  assert.equal(fullPoints.filter((p) => p.name === "mission.dispatches").length, 2);
  const dispatches = leanPoints.filter((p) => p.name === "mission.dispatches");
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0]!.value, 2);
  assert.deepEqual(Object.keys(dispatches[0]!.attributes), ["outcome", "agent", "runtime", "task_kind"]);

  // A minor histogram is two counters; a distribution stays a distribution.
  assert.ok(!leanPoints.some((p) => p.name === "mission.daemon.startup.duration"));
  const sum = leanPoints.find((p) => p.name === "mission.daemon.startup.duration.sum");
  const count = leanPoints.find((p) => p.name === "mission.daemon.startup.duration.count");
  assert.deepEqual(
    [sum?.kind, sum?.value, sum?.unit, sum?.valueType, sum?.histogram],
    ["counter", 250, "ms", "double", null],
  );
  assert.deepEqual(
    [count?.kind, count?.value, count?.unit, count?.valueType, count?.histogram],
    ["counter", 1, "1", "int", null],
  );
  const duration = leanPoints.find((p) => p.name === "mission.dispatch.duration");
  assert.equal(duration?.kind, "histogram");
  assert.equal(duration?.histogram?.count, 2);

  // And it serializes: the derived names and the host attribute are on the wire.
  const wire = new TextDecoder().decode(serializeMetrics(lean[0]!));
  assert.ok(wire.includes("mission.daemon.startup.duration.sum"));
  assert.ok(wire.includes("datadog.host.name"));
});

// ---- the live-series budget ----

test("the budget admits to exactly its ceiling, folds into paid-for overflow, and drops a new pair", () => {
  useProjections(PLAN_PROJECTION);
  configure({ exportShape: "datadog-lean" }, T0);

  // Second resource: a distribution (9 + its reservation 9), a sum-and-count histogram (2 + 2)
  // and a gauge (1 + 1). First resource: one counter pair, 1 + 1 for its first series.
  emitAt(T0 + 1, [{ environment: SECOND, emissions: [distribution("a"), sumCount("a"), gauge("a")] }]);
  assert.equal(committed(T0 + 1), 24);
  emitAt(T0 + 2, [{ emissions: counters(1_474, "fill") }]);
  assert.equal(committed(T0 + 2), BUDGET - 1);

  // A distribution that would overshoot by 8 folds into its pair's reserved overflow series.
  const overflowBefore = gap("series_overflow");
  emitAt(T0 + 3, [{ environment: SECOND, emissions: [distribution("b")] }]);
  assert.equal(committed(T0 + 3), BUDGET - 1);
  const durations = rows("mission.dispatch.duration");
  assert.equal(durations.length, 2);
  assert.ok(durations.some((s) => s.dimensions.agent === "a"));
  assert.ok(durations.some((s) => isOverflow(s.dimensions)));
  assert.equal(gap("series_overflow"), overflowBefore + 1);

  // A weight-1 series for a pair already holding its reservation fits exactly.
  emitAt(T0 + 4, [{ emissions: [counter("last")] }]);
  assert.equal(committed(T0 + 4), BUDGET);
  assert.ok(rows("mission.action.count").some((s) => s.dimensions.action === "last"));

  // One more for that pair folds into its overflow, which converts the reservation.
  emitAt(T0 + 5, [{ emissions: [counter("over", 3)] }]);
  assert.equal(committed(T0 + 5), BUDGET);
  const overflow = rows("mission.action.count").filter((s) => isOverflow(s.dimensions));
  assert.equal(overflow.length, 1);
  assert.equal(overflow[0]!.value, 3);
  assert.ok(!rows("mission.action.count").some((s) => s.dimensions.action === "over"));

  // A brand-new pair needs its own weight AND a reservation, and there is no room for either.
  const exhaustedBefore = gap("budget_exhausted");
  emitAt(T0 + 6, [{ emissions: [gauge("first-resource")] }]);
  assert.equal(committed(T0 + 6), BUDGET);
  assert.equal(rows("mission.telemetry.health.pending").length, 1, "only the second resource's gauge");
  assert.equal(gap("budget_exhausted"), exhaustedBefore + 1);
});

test("a resumed series that does not fit folds into its pair's overflow and leaves its row untouched", () => {
  useProjections(PLAN_PROJECTION);
  configure({ exportShape: "datadog-lean" }, T0);
  emitAt(T0, [{ emissions: [counter("s", 2), counter("keep")] }]);

  // Eight idle days: neither series is live. "keep" reports again and is re-admitted, so the
  // pair holds a reservation; another pair then fills the budget exactly.
  const t1 = T0 + 8 * DAY;
  assert.equal(committed(t1), 0);
  emitAt(t1, [{ emissions: [counter("keep")] }]);
  assert.equal(committed(t1), 2);
  emitAt(t1 + 1, [{ environment: SECOND, emissions: counters(BUDGET - 3, "other") }]);
  assert.equal(committed(t1 + 1), BUDGET);

  const key = rows("mission.action.count").find((s) => s.dimensions.action === "s")!;
  const before = getSeries(openDb(), key);
  emitAt(t1 + 2, [{ emissions: [counter("s", 5)] }]);
  assert.deepEqual(getSeries(openDb(), key), before, "a refused resume leaves its row alone");
  assert.ok(before!.lastActivity < t1 + 2 - TELEMETRY_LIMITS.payloadRetentionMs, "and it stays not live");
  const overflow = rows("mission.action.count").filter(
    (s) => isOverflow(s.dimensions) && s.resourceId === key.resourceId,
  );
  assert.equal(overflow.length, 1);
  assert.equal(overflow[0]!.value, 5);
  assert.equal(committed(t1 + 2), BUDGET);

  // Free the room: eight more days, then "keep" holds the pair's reservation again and S
  // resumes for exactly its own weight.
  const t2 = t1 + 8 * DAY + 10;
  emitAt(t2, [{ emissions: [counter("keep")] }]);
  assert.equal(committed(t2), 2);
  emitAt(t2 + 1, [{ emissions: [counter("s", 7)] }]);
  assert.equal(committed(t2 + 1), 3);
  // Its total excludes what went to overflow, so its next delta does too.
  assert.equal(getSeries(openDb(), key)!.value, 2 + 7);
});

test("a resumed series whose pair holds nothing is dropped and counted, then resumes with a reservation", () => {
  useProjections(PLAN_PROJECTION);
  configure({ exportShape: "datadog-lean" }, T0);
  emitAt(T0, [{ emissions: [counter("s", 2)] }]);
  const t1 = T0 + 8 * DAY;
  emitAt(t1, [{ environment: SECOND, emissions: counters(BUDGET - 1, "other") }]);
  assert.equal(committed(t1), BUDGET);

  const key = rows("mission.action.count").find((s) => s.dimensions.action === "s")!;
  const before = getSeries(openDb(), key);
  const exhausted = gap("budget_exhausted");
  emitAt(t1 + 1, [{ emissions: [counter("s", 5)] }]);
  assert.deepEqual(getSeries(openDb(), key), before);
  assert.equal(gap("budget_exhausted"), exhausted + 1);
  assert.ok(
    !rows("mission.action.count").some(
      (s) => isOverflow(s.dimensions) && s.resourceId === key.resourceId,
    ),
  );
  assert.equal(committed(t1 + 1), BUDGET);

  const t2 = t1 + 8 * DAY + 10;
  assert.equal(committed(t2), 0);
  emitAt(t2, [{ emissions: [counter("s", 7)] }]);
  // Its own weight plus the reservation its pair did not have.
  assert.equal(committed(t2), 2);
  assert.equal(getSeries(openDb(), key)!.value, 2 + 7);
});

test("idle series stop counting, and so does their pair's reservation", () => {
  useProjections(PLAN_PROJECTION);
  configure({ exportShape: "datadog-lean" }, T0);
  emitAt(T0, [{ emissions: [counter("a"), distribution("a")] }]);
  assert.equal(committed(T0), 2 + 18);
  assert.equal(committed(T0 + 7 * DAY), 2 + 18, "still live on the last day of the window");
  assert.equal(committed(T0 + 8 * DAY), 0);
});

test("property: committed weight never exceeds the budget, with one overflow per pair", () => {
  useProjections(PLAN_PROJECTION);
  configure({ exportShape: "datadog-lean" }, T0);
  let seed = 0x5eed;
  const random = (): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
  const pool: Emission[] = [
    ...counters(400, "p"),
    ...Array.from({ length: 60 }, (_, i) => distribution(`agent-${i}`)),
    ...Array.from({ length: 40 }, (_, i) => sumCount(`mode-${i}`)),
    ...Array.from({ length: 40 }, (_, i) => gauge(`g-${i}`)),
  ];

  let now = T0;
  let resumptions = 0;
  for (let step = 0; step < 120; step += 1) {
    now += random() < 0.06 ? 8 * DAY : MINUTE;
    const groups = [undefined, SECOND].map((environment) => ({
      environment,
      emissions: Array.from({ length: 80 }, () => pick(pool)),
    }));
    for (const s of listSeries(openDb(), "user")) {
      if (s.lastActivity < now - TELEMETRY_LIMITS.payloadRetentionMs) resumptions += 1;
    }
    emitAt(now, groups);

    assert.ok(committed(now) <= BUDGET, `step ${step}: committed ${committed(now)}`);
    const overflowPerPair = new Map<string, number>();
    for (const s of listSeries(openDb(), "user")) {
      if (!isOverflow(s.dimensions)) continue;
      const pair = `${s.resourceId}|${s.instrument}`;
      overflowPerPair.set(pair, (overflowPerPair.get(pair) ?? 0) + 1);
    }
    assert.ok([...overflowPerPair.values()].every((n) => n === 1), `step ${step}`);
  }
  assert.ok(resumptions > 0, "the walk must exercise stored series that aged out");
  assert.ok(gap("series_overflow") + gap("budget_exhausted") > 0, "and it must reach the ceiling");
});

test("the long-standing 2,000 and 10,000 series ceilings still apply beside the budget", () => {
  useProjections(PLAN_PROJECTION);
  configure({ exportShape: "datadog-lean" }, T0);
  // Ten thousand rows in an earlier consent epoch: they are not live, so the budget ignores
  // them, but the per-profile ceiling has always counted every stored row.
  openDb().exec(`
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${TELEMETRY_LIMITS.maxSeriesPerProfile})
    INSERT INTO telemetry_series (profile, policy_epoch, resource_id, instrument, dimensions_key,
      dimensions_json, catalog_version, kind, start_time, last_time, value, last_activity)
    SELECT 'user', 0, 'old', 'mission.action.count', 'k' || i, '{}', 1, 'counter', 0, 0, 0, 0 FROM n`);
  emitAt(T0 + 1, [{ emissions: [counter("new")] }]);
  assert.ok(!rows("mission.action.count").some((s) => s.dimensions.action === "new"));
  assert.ok(gap("series_overflow") > 0);
  assert.ok(gap("budget_exhausted") > 0);
  assert.equal(committed(T0 + 1), 0);
});

// ---- the hourly export ledger ----

function sumFor(prefix: string, generation?: (g: number) => boolean): number {
  return points(generation)
    .filter((p) => p.attributes.action?.startsWith(prefix))
    .reduce((sum, p) => sum + p.value, 0);
}

function distinctPerHour(): Map<number, number> {
  const seen = new Map<number, Set<string>>();
  for (const { payload } of metricPayloads()) {
    for (const point of payload.metrics) {
      const hour = Math.floor(point.endTimeMs / HOUR) * HOUR;
      const set = seen.get(hour) ?? new Set<string>();
      set.add(JSON.stringify([point.name, point.attributes, payload.resource]));
      seen.set(hour, set);
    }
  }
  return new Map([...seen].map(([hour, set]) => [hour, set.size]));
}

test("ledger: a shape change mid-hour grants no fresh allowance, and deferred deltas arrive whole", () => {
  useProjections(CATALOG_PROJECTION, PLAN_PROJECTION);
  configure({ endpoint: "https://otlp.example.com", temporality: "delta", exportShape: "datadog-lean" }, T0);
  emitAt(T0 + MINUTE, [{ emissions: counters(1_000, "before") }]);
  assert.equal(ledgerWeight(T0), 1_000);

  // Two shape changes inside the same hour. Each resets the series; neither resets the ledger.
  const generation = getDestination(openDb(), "user").generation;
  configure({ exportShape: "full" }, T0 + 2 * MINUTE);
  configure({ exportShape: "datadog-lean" }, T0 + 3 * MINUTE);
  assert.equal(getDestination(openDb(), "user").generation, generation + 2);
  assert.equal(listSeries(openDb(), "user").length, 0);
  assert.equal(ledgerWeight(T0), 1_000, "the hour's ledger survives the shape reset");
  assert.equal(gap("shape_changed"), 2);

  const current = (g: number) => g === generation + 2;
  emitAt(T0 + 4 * MINUTE, [{ emissions: counters(800, "after", 3) }]);
  assert.equal(ledgerWeight(T0), BUDGET);
  assert.equal(gap("hourly_cap_deferred"), 300);
  const waiting = listSeries(openDb(), "user").filter((s) => s.deferredAt !== null);
  assert.equal(waiting.length, 300);
  assert.equal(sumFor("after-", current), 500 * 3);

  // A further contribution to a waiting series is still waiting, and not counted twice.
  const late = waiting[0]!.dimensions.action!;
  emitAt(T0 + 5 * MINUTE, [{ emissions: [counter(late, 3)] }]);
  assert.equal(gap("hourly_cap_deferred"), 300);

  // A series the hour already exported always goes out, even at the cap.
  const known = listSeries(openDb(), "user").find(
    (s) => s.deferredAt === null && s.dimensions.action?.startsWith("after-"),
  )!;
  emitAt(T0 + 6 * MINUTE, [{ emissions: [counter(known.dimensions.action!, 3)] }]);
  assert.equal(sumFor("after-", current), 500 * 3 + 3);
  assert.equal(ledgerWeight(T0), BUDGET);

  // The next hour: nothing new happens, and the waiting deltas go out whole.
  runProjectionPass(T0 + HOUR + MINUTE);
  assert.equal(listSeries(openDb(), "user").filter((s) => s.deferredAt !== null).length, 0);
  assert.equal(sumFor("after-", current), 800 * 3 + 3 + 3);
  assert.equal(ledgerWeight(T0 + HOUR), 300);
  for (const [, distinct] of distinctPerHour()) assert.ok(distinct <= BUDGET);

  // Rollover: the next hour has its own allowance, and the retention sweep drops old hours.
  emitAt(T0 + HOUR + 2 * MINUTE, [{ emissions: [counter("next-hour")] }]);
  assert.equal(ledgerWeight(T0 + HOUR), 301);
  // A fact from either hour can still be projected days later, so both hours stay on record...
  assert.equal(runRetentionPass(T0 + 3 * HOUR + 1).prunedExportHours, 0);
  assert.equal(ledgerWeight(T0), BUDGET);
  // ...until the hour has left the window in which anything can still land in it.
  const swept = runRetentionPass(T0 + TELEMETRY_LIMITS.exportLedgerRetentionMs + HOUR + 1);
  assert.equal(swept.prunedExportHours, BUDGET);
  assert.equal(ledgerWeight(T0), 0);
  assert.equal(ledgerWeight(T0 + HOUR), 301);
});

test("ledger: withdrawing and re-giving consent mid-hour, and a restart, grant no fresh allowance", () => {
  useProjections(CATALOG_PROJECTION, PLAN_PROJECTION);
  configure({ endpoint: "https://otlp.example.com", temporality: "delta", exportShape: "datadog-lean" }, T0);
  emitAt(T0 + MINUTE, [{ emissions: counters(1_000, "before") }]);
  const epoch = getDestination(openDb(), "user").policyEpoch;

  assert.equal(setTelemetryConfig({ user: { enabled: false } }, T0 + 2 * MINUTE).ok, true);
  assert.equal(setTelemetryConfig({ user: { enabled: true } }, T0 + 3 * MINUTE).ok, true);
  assert.equal(getDestination(openDb(), "user").policyEpoch, epoch + 1);
  assert.equal(ledgerWeight(T0), 1_000);

  emitAt(T0 + 4 * MINUTE, [{ emissions: counters(800, "after", 2) }]);
  assert.equal(ledgerWeight(T0), BUDGET);
  assert.equal(gap("hourly_cap_deferred"), 300);

  // A restart reopens the same durable ledger.
  closeDb();
  openDb();
  emitAt(T0 + 5 * MINUTE, [{ emissions: [counter("after-restart")] }]);
  assert.equal(ledgerWeight(T0), BUDGET);
  assert.equal(gap("hourly_cap_deferred"), 301);

  runProjectionPass(T0 + HOUR + MINUTE);
  assert.equal(sumFor("after"), 800 * 2 + 1);
  for (const [, distinct] of distinctPerHour()) assert.ok(distinct <= BUDGET);
});

test("ledger: a deferred cumulative point goes out in a later hour, and that export keeps it live", () => {
  useProjections(CATALOG_PROJECTION, PLAN_PROJECTION);
  configure({ endpoint: "https://otlp.example.com", exportShape: "datadog-lean" }, T0);
  emitAt(T0 + MINUTE, [{ emissions: counters(1_000, "before") }]);
  configure({ exportShape: "full" }, T0 + 2 * MINUTE);
  configure({ exportShape: "datadog-lean" }, T0 + 3 * MINUTE);
  const contributed = T0 + 4 * MINUTE;
  emitAt(contributed, [{ emissions: counters(600, "after", 2) }]);
  const waiting = () => listSeries(openDb(), "user").filter((s) => s.deferredAt !== null);
  assert.equal(ledgerWeight(T0), BUDGET);
  assert.equal(waiting().length, 100);

  // Later in the same full hour nothing fits yet, and the wait is not counted twice.
  runProjectionPass(T0 + 30 * MINUTE);
  assert.equal(waiting().length, 100);
  assert.equal(gap("hourly_cap_deferred"), 100);

  // The next hour: the waiting cumulative totals go out, stamped in the hour that has room
  // rather than in the event hour that never will.
  const retry = T0 + HOUR + MINUTE;
  runProjectionPass(retry);
  assert.equal(waiting().length, 0);
  assert.equal(ledgerWeight(T0 + HOUR), 100);
  const retried = points().filter((p) => p.attributes.action?.startsWith("after-") && p.endTimeMs === retry);
  assert.equal(retried.length, 100);
  assert.ok(retried.every((p) => p.value === 2 && p.startTimeMs === contributed));

  // Seven days after their contribution, but not after their export, those 100 are still live:
  // they and their pair's reservation are committed.
  const boundary = retry + 7 * DAY - MINUTE;
  assert.ok(contributed < boundary - TELEMETRY_LIMITS.payloadRetentionMs);
  assert.equal(committed(boundary), 101);

  // So admission fills at exactly the right point, and the next series folds into overflow.
  emitAt(boundary, [{ emissions: counters(BUDGET - 101, "later") }]);
  assert.equal(committed(boundary), BUDGET);
  emitAt(boundary + 1, [{ emissions: [counter("one-more")] }]);
  assert.ok(!rows("mission.action.count").some((s) => s.dimensions.action === "one-more"));
  assert.equal(rows("mission.action.count").filter((s) => isOverflow(s.dimensions)).length, 1);
  assert.equal(committed(boundary + 1), BUDGET);
});

test("ledger: facts projected hours late are charged to their event hour, which is still on record", () => {
  useProjections(CATALOG_PROJECTION, PLAN_PROJECTION);
  configure({ endpoint: "https://otlp.example.com", exportShape: "datadog-lean" }, T0);
  emitAt(T0 + MINUTE, [{ emissions: counters(1_000, "before") }]);
  configure({ exportShape: "full" }, T0 + 2 * MINUTE);
  configure({ exportShape: "datadog-lean" }, T0 + 3 * MINUTE);
  // Captured inside the hour that already exported 1,000 series, and projected hours later.
  captureOnly(T0 + 5 * MINUTE, [{ emissions: counters(800, "delayed") }]);

  const late = T0 + 3 * HOUR + MINUTE;
  assert.equal(runRetentionPass(late).prunedExportHours, 0, "the billed hour is still on record");
  runProjectionPass(late);

  // Cumulative points keep their event hour, so that hour's remaining 500 is all they get.
  const inEventHour = points().filter(
    (p) => p.attributes.action?.startsWith("delayed-") && hourOf(p.endTimeMs) === T0,
  );
  assert.equal(inEventHour.length, 500);
  assert.equal(ledgerWeight(T0), BUDGET);
  assert.equal(gap("hourly_cap_deferred"), 300);
  for (const [, distinct] of distinctPerHour()) assert.ok(distinct <= BUDGET);
});

test("ledger: a point from an hour the ledger no longer tracks is charged to the current hour", () => {
  useProjections(CATALOG_PROJECTION, PLAN_PROJECTION);
  configure({ endpoint: "https://otlp.example.com", exportShape: "datadog-lean" }, T0);
  captureOnly(T0 + MINUTE, [{ emissions: counters(3, "ancient", 2) }]);

  const late = T0 + TELEMETRY_LIMITS.exportLedgerRetentionMs + 2 * HOUR;
  runRetentionPass(late);
  runProjectionPass(late);
  const sent = points().filter((p) => p.attributes.action?.startsWith("ancient-"));
  assert.equal(sent.length, 3);
  assert.ok(sent.every((p) => p.endTimeMs === late && p.value === 2), "stamped now, total unchanged");
  assert.equal(ledgerWeight(hourOf(late)), 3);
  assert.equal(ledgerWeight(hourOf(T0)), 0);
});

test("ledger: the horizon is exact: a point at it keeps its event hour, one a millisecond older is restamped", () => {
  useProjections(CATALOG_PROJECTION, PLAN_PROJECTION);
  configure({ endpoint: "https://otlp.example.com", exportShape: "datadog-lean" }, T0 - HOUR);
  captureOnly(T0 - 1, [{ emissions: [counter("before-horizon", 2)] }]);
  captureOnly(T0, [{ emissions: [counter("at-horizon", 2)] }]);

  // Thirty minutes into the hour that puts the ledger's oldest tracked hour at exactly T0.
  const late = T0 + TELEMETRY_LIMITS.exportLedgerRetentionMs + 30 * MINUTE;
  assert.equal(exportLedgerHorizon(late), T0);
  // Retention at the same clock keeps that hour, so the two agree on what is tracked.
  runRetentionPass(late);
  runProjectionPass(late);

  const sent = (action: string) => points().filter((p) => p.attributes.action === action);
  assert.deepEqual(sent("at-horizon").map((p) => [p.endTimeMs, p.value]), [[T0, 2]]);
  assert.deepEqual(sent("before-horizon").map((p) => [p.endTimeMs, p.value]), [[late, 2]]);
  assert.equal(ledgerWeight(T0), 1, "the point at the horizon is charged to its own, tracked hour");
  assert.equal(ledgerWeight(hourOf(late)), 1, "the older one is charged to the current hour");
  assert.equal(ledgerWeight(T0 - HOUR), 0, "and nothing is charged to the untracked hour");
});

test("a full destination's late cumulative point keeps its event time", () => {
  useProjections(CATALOG_PROJECTION, PLAN_PROJECTION);
  configure({ endpoint: "https://otlp.example.com" }, T0);
  captureOnly(T0 + MINUTE, [{ emissions: counters(1, "ancient", 2) }]);
  runProjectionPass(T0 + TELEMETRY_LIMITS.exportLedgerRetentionMs + 2 * HOUR);
  const sent = points().filter((p) => p.attributes.action?.startsWith("ancient-"));
  assert.deepEqual(sent.map((p) => p.endTimeMs), [T0 + MINUTE]);
});

test("ledger: an hour is never charged for a batch that was not queued", () => {
  useProjections(CATALOG_PROJECTION, PLAN_PROJECTION);
  configure({ endpoint: "https://otlp.example.com", temporality: "delta", exportShape: "datadog-lean" }, T0);
  // No single point fits the request limit, so the pass queues nothing at all.
  const limits = TELEMETRY_LIMITS as { maxRequestBytes: number };
  const original = limits.maxRequestBytes;
  limits.maxRequestBytes = 1;
  try {
    emitAt(T0 + MINUTE, [{ emissions: counters(3, "unqueued") }]);
  } finally {
    limits.maxRequestBytes = original;
  }
  assert.equal(metricPayloads().length, 0);
  assert.equal(ledgerWeight(T0), 0, "nothing was queued, so the hour spent nothing");

  emitAt(T0 + 2 * MINUTE, [{ emissions: counters(3, "unqueued") }]);
  assert.equal(ledgerWeight(T0), 3);
  assert.equal(sumFor("unqueued-"), 6, "the unqueued delta was kept and goes out whole");
});

test("a deferred series that aged out is admitted to the live budget before it is exported", () => {
  useProjections(CATALOG_PROJECTION, EARLY_PLAN_PROJECTION);
  configure({ endpoint: "https://otlp.example.com", exportShape: "datadog-lean" }, T0);
  emitAt(T0 + MINUTE, [{ emissions: counters(1_000, "before") }]);
  configure({ exportShape: "full" }, T0 + 2 * MINUTE);
  configure({ exportShape: "datadog-lean" }, T0 + 3 * MINUTE);
  emitAt(T0 + 4 * MINUTE, [{ emissions: counters(600, "after", 2) }]);
  const waiting = () => listSeries(openDb(), "user").filter((s) => s.deferredAt !== null);
  assert.equal(waiting().length, 100);

  // Eight days later, with no pass in between, the 100 waiting series are no longer live.
  // Another resource fills the live budget first, in the very pass whose catalog projection
  // then carries the waiting ones. (Another resource, so the 2,000-per-instrument ceiling the
  // 600 stored rows already count toward cannot be what refuses anything here.)
  const retry = T0 + 8 * DAY;
  assert.equal(committed(retry), 0);
  emitAt(retry, [{ environment: SECOND, emissions: counters(BUDGET - 1, "filler") }]);
  assert.equal(committed(retry), BUDGET, "the export did not push the live set past the budget");
  assert.equal(
    points().filter((p) => p.attributes.action?.startsWith("after-") && p.endTimeMs === retry).length,
    0,
    "no aged-out series was exported without room",
  );
  assert.equal(waiting().length, 100, "they still wait, with nothing lost");

  // Once that room frees, they are admitted and go out with their whole totals.
  const later = retry + 8 * DAY;
  runProjectionPass(later);
  const sent = points().filter((p) => p.attributes.action?.startsWith("after-") && p.endTimeMs === later);
  assert.equal(sent.length, 100);
  assert.ok(sent.every((p) => p.value === 2));
  assert.equal(waiting().length, 0);
  assert.equal(committed(later), 101);
});

// ---- changing shape ----

test("a shape change from nonzero totals resets every series and counts pending facts exactly once", async () => {
  useProjections(CATALOG_PROJECTION, ANALYTICAL_PROJECTION);
  scenario.pinScenarioIdentity();
  configure({ endpoint: "https://otlp.example.com", temporality: "delta" }, 100);
  scenario.captureDaemonStart("user", "reset-start-1", 1_000, 250);
  scenario.captureDispatch("user", "reset-dispatch-1", 2_000);
  scenario.captureDispatch("user", "reset-dispatch-2", 2_100);
  scenario.captureHealth("user", "reset-health-1", 2_200, 3);
  runProjectionPass(10_000);
  const before = getDestination(openDb(), "user");
  assert.ok(listSeries(openDb(), "user").some((s) => s.exportedGeneration === before.generation));
  const checkpoints = [CATALOG_PROJECTION.id, ANALYTICAL_PROJECTION.id].map(
    (id) => getProjectionState(openDb(), id, "user")!.consumedSeq,
  );

  // Captured, not yet projected.
  scenario.captureDaemonStart("user", "reset-start-2", 11_000, 400);
  scenario.captureDispatch("user", "reset-dispatch-3", 11_100, { resolution_source: "kind" });
  scenario.captureDispatch("user", "reset-dispatch-4", 11_200, { resolution_source: "automation" });

  configure({ exportShape: "datadog-lean" }, 12_000);
  const after = getDestination(openDb(), "user");
  assert.equal(after.generation, before.generation + 1);
  assert.equal(after.policyEpoch, before.policyEpoch, "the epoch must not move, or pending facts are skipped");
  assert.equal(listSeries(openDb(), "user").length, 0);
  assert.equal(gap("shape_changed"), 1);
  assert.deepEqual(
    [CATALOG_PROJECTION.id, ANALYTICAL_PROJECTION.id].map(
      (id) => getProjectionState(openDb(), id, "user")!.consumedSeq,
    ),
    checkpoints,
  );

  // Queued old-shape batches are fenced: nothing is sent for them.
  let requests = 0;
  await runDeliveryPass({
    fetch: async () => {
      requests += 1;
      return new Response(null, { status: 200 });
    },
  });
  assert.equal(requests, 0);

  runProjectionPass(20_000);
  const fresh = points((g) => g === after.generation);
  const named = (name: string) => fresh.filter((p) => p.name === name);
  assert.deepEqual(named("mission.daemon.starts").map((p) => p.value), [1]);
  assert.deepEqual(named("mission.dispatches").map((p) => p.value), [2]);
  assert.deepEqual(named("mission.daemon.startup.duration.sum").map((p) => p.value), [400]);
  assert.deepEqual(named("mission.daemon.startup.duration.count").map((p) => p.value), [1]);
  assert.deepEqual(named("mission.dispatch.duration").map((p) => p.histogram?.count), [2]);
  assert.ok(fresh.every((p) => p.temporality === "delta"));
  assert.equal(fresh.filter((p) => p.name.startsWith("mission.analytics.v1.")).length, 0);

  // No registered projection can carry a counter total past the reset: the catalog holds no
  // state at all, and the analytical projection publishes only gauges.
  assert.deepEqual(getProjectionState(openDb(), CATALOG_PROJECTION.id, "user")!.state, {});
  assert.ok(ANALYTICAL_METRICS.every((m) => m.kind === "gauge"));

  // Back to full: the analytical gauges return with their current population values.
  configure({ exportShape: "full" }, 25_000);
  const generation = getDestination(openDb(), "user").generation;
  runProjectionPass(30_000);
  const restored = points((g) => g === generation);
  assert.ok(restored.filter((p) => p.name.startsWith("mission.analytics.v1.")).length > 100);
  assert.ok(restored.every((p) => p.kind === "gauge"));
});

// ---- the connection probe ----

async function probeRequest(exportShape: "full" | "datadog-lean"): Promise<string> {
  useProjections(CATALOG_PROJECTION);
  configure({ endpoint: "https://otlp.example.com", exportShape }, T0);
  const bodies: Uint8Array[] = [];
  const result = await runTelemetryProbe("user", {
    fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(new Uint8Array(init?.body as Uint8Array));
      return new Response(new Uint8Array(0), { status: 200 });
    }) as unknown as typeof globalThis.fetch,
  });
  assert.equal(result.outcome, "accepted");
  assert.equal(bodies.length, 1, "the probe sends exactly one request");
  return new TextDecoder().decode(bodies[0]);
}

test("a lean destination's probe request carries the constant Datadog host attribute", async () => {
  const wire = await probeRequest("datadog-lean");
  assert.ok(wire.includes("datadog.host.name"));
  assert.ok(wire.includes("mission-control"));
  assert.ok(wire.includes("service.instance.id"), "the rest of the resource is still there");
});

test("a full destination's probe request has no Datadog host attribute", async () => {
  const wire = await probeRequest("full");
  assert.ok(!wire.includes("datadog.host.name"));
  assert.ok(wire.includes("service.instance.id"));
});

// ---- pruning series nothing can contribute to ----

test("retention prunes a budgeted destination's old-resource idle series, never the running resource's", () => {
  useProjections(PLAN_PROJECTION);
  configure({ exportShape: "datadog-lean" }, T0);
  emitAt(T0, [{ emissions: [counter("current")] }, { environment: "retired", emissions: [counter("old")] }]);
  emitAt(T0 + 30 * DAY, [{ environment: "retired", emissions: [counter("recent")] }]);

  const result = runRetentionPass(T0 + 31 * DAY);
  assert.equal(result.prunedSeries, 1);
  const actions = rows("mission.action.count").map((s) => s.dimensions.action).sort();
  assert.deepEqual(actions, ["current", "recent"]);
});

test("the prune cutoff is exact: a retired series idle one millisecond past 30 days goes, one at 30 days stays", () => {
  useProjections(PLAN_PROJECTION);
  configure({ exportShape: "datadog-lean" }, T0);
  // Last activity is the pass clock, so these two rows are one millisecond apart.
  emitAt(T0, [{ environment: "retired", emissions: [counter("before-cutoff")] }]);
  emitAt(T0 + 1, [{ environment: "retired", emissions: [counter("at-cutoff")] }]);

  const result = runRetentionPass(T0 + 1 + TELEMETRY_LIMITS.reducerStateRetentionMs);
  assert.equal(result.prunedSeries, 1);
  assert.deepEqual(
    rows("mission.action.count").map((s) => s.dimensions.action),
    ["at-cutoff"],
  );
});

test("a full destination keeps a retired version's series, so a rollback continues its cumulative stream", () => {
  useProjections(PLAN_PROJECTION);
  configure({}, T0);
  emitAt(T0, [{ environment: "version-a", emissions: [counter("rollback", 4)] }]);
  const before = rows("mission.action.count").find((s) => s.dimensions.action === "rollback")!;

  // A month and more on another version, then retention runs.
  const result = runRetentionPass(T0 + 31 * DAY);
  assert.equal(result.prunedSeries, 0);
  assert.deepEqual(getSeries(openDb(), before), before);

  // Version A runs again: its stream continues from its stored total and start time.
  emitAt(T0 + 32 * DAY, [{ environment: "version-a", emissions: [counter("rollback", 1)] }]);
  const after = getSeries(openDb(), before)!;
  assert.equal(after.value, 5);
  assert.equal(after.startTime, before.startTime);
});
