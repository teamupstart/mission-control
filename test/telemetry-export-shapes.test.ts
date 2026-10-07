import assert from "node:assert/strict";
import test from "node:test";
import {
  TELEMETRY_EXPORT_SHAPE_IDS,
  TELEMETRY_EXPORT_SHAPES,
  exportShapeProblems,
  exportedInstruments,
  seriesWeight,
} from "../src/shared/telemetry-export-shapes.ts";
import { TELEMETRY_EVENTS, TELEMETRY_METRICS } from "../src/shared/telemetry-catalog.ts";
import { TelemetryDestinationSchema } from "../src/shared/telemetry.ts";

const LEAN = TELEMETRY_EXPORT_SHAPES["datadog-lean"];

test("the shape ids are the persisted tuple, and a destination defaults to the full shape", () => {
  assert.deepEqual([...TELEMETRY_EXPORT_SHAPE_IDS], ["full", "datadog-lean"]);
  assert.equal(TelemetryDestinationSchema.parse({}).exportShape, "full");
  assert.throws(() => TelemetryDestinationSchema.parse({ exportShape: "lean" }));
  for (const id of TELEMETRY_EXPORT_SHAPE_IDS) assert.equal(TELEMETRY_EXPORT_SHAPES[id].id, id);
});

test("every shape agrees with the catalog, and every dropped label survives on its span", () => {
  for (const id of TELEMETRY_EXPORT_SHAPE_IDS) {
    assert.deepEqual(exportShapeProblems(TELEMETRY_EXPORT_SHAPES[id]), [], id);
  }
});

test("the consistency check refuses a label no span carries and a sum/count name collision", () => {
  const broken = {
    ...LEAN,
    droppedDimensions: { "mission.daemon.starts": ["launch_mode"], "mission.nope": ["x"] },
  };
  const event = TELEMETRY_METRICS["mission.daemon.starts"]!.event;
  const definition = TELEMETRY_EVENTS[event]!;
  const problems = exportShapeProblems(broken, TELEMETRY_METRICS, {
    ...TELEMETRY_EVENTS,
    [event]: { ...definition, span: { ...definition.span!, attributes: [] } },
  });
  assert.ok(problems.some((p) => p.includes("mission.nope")), problems.join("\n"));
  assert.ok(problems.some((p) => p.includes("launch_mode")), problems.join("\n"));

  const colliding = {
    ...TELEMETRY_METRICS,
    "mission.daemon.startup.duration.count": TELEMETRY_METRICS["mission.daemon.starts"]!,
  };
  assert.ok(
    exportShapeProblems(LEAN, colliding).some((p) => p.includes("collides")),
    "a derived counter name that is already an instrument must be refused",
  );
});

test("the lean shape holds exactly the approved values", () => {
  assert.deepEqual(LEAN.excludedPrefixes, ["mission.analytics.v1."]);
  assert.deepEqual(LEAN.droppedDimensions, {
    "mission.dispatches": ["resolution_source", "resolved_effort"],
    "mission.action.count": ["actor"],
    "mission.sessions.ended": ["ended_while_work_open"],
    "mission.session.segments": ["quality", "reason"],
    "mission.sessions.started": ["start_observation"],
    "mission.session.operations": ["actor_basis"],
    "mission.session.turns": ["quality"],
    "mission.session.effort.selections": ["applies"],
    "mission.automation.actions": ["actor"],
  });
  assert.deepEqual(LEAN.distributionHistograms, [
    "mission.session.turn.duration",
    "mission.dispatch.duration",
    "mission.workflow.duration",
    "mission.workflow.node.duration",
  ]);
  assert.deepEqual(LEAN.resourceAttributes, { "datadog.host.name": "mission-control" });
  assert.equal(LEAN.seriesBudget, 1_500);
  assert.deepEqual(LEAN.weights, { distribution: 9, sumCount: 2, counter: 1, gauge: 1 });
});

test("the lean product export has no cohort gauges, four distributions and seven sum-and-count pairs", () => {
  const exported = exportedInstruments("datadog-lean", TELEMETRY_METRICS, "product");
  assert.equal(exported.filter((m) => m.name.startsWith("mission.analytics.v1.")).length, 0);
  assert.deepEqual(
    exported.filter((m) => m.kind === "distribution").map((m) => m.name),
    [
      "mission.dispatch.duration",
      "mission.session.turn.duration",
      "mission.workflow.duration",
      "mission.workflow.node.duration",
    ],
  );
  const split = exported.filter((m) => m.name !== m.source);
  assert.deepEqual(
    [...new Set(split.map((m) => m.source))].sort(),
    [
      "mission.daemon.startup.duration",
      "mission.session.observed.duration",
      "mission.workflow.pickup.duration",
      "mission.workflow.repair.duration",
      "mission.workflow.node.queue.duration",
      "mission.workflow.stage.duration",
      "mission.workflow.wait.duration",
    ].sort(),
  );
  for (const source of new Set(split.map((m) => m.source))) {
    const pair = split.filter((m) => m.source === source);
    assert.deepEqual(
      pair.map((m) => [m.name, m.kind, m.unit]),
      [
        [`${source}.count`, "counter", "1"],
        [`${source}.sum`, "counter", TELEMETRY_METRICS[source]!.unit],
      ],
    );
  }
});

test("an operator-only histogram is split for a lean destination of your own", () => {
  // `mission.connection.downtime` never reaches the product audience, so the approved count of
  // seven pairs is a product-audience count. Every other audience splits it as well.
  const all = exportedInstruments("datadog-lean");
  assert.ok(all.some((m) => m.name === "mission.connection.downtime.sum"));
  assert.ok(!all.some((m) => m.name === "mission.connection.downtime"));
});

test("every trimmed metric omits exactly its dropped labels, and nothing else changes", () => {
  const lean = new Map(exportedInstruments("datadog-lean").map((m) => [m.name, m]));
  for (const [instrument, dropped] of Object.entries(LEAN.droppedDimensions)) {
    const definition = TELEMETRY_METRICS[instrument]!;
    assert.deepEqual(
      lean.get(instrument)?.labels,
      definition.dimensions.filter((label) => !dropped.includes(label)),
      instrument,
    );
  }
  for (const exported of lean.values()) {
    if (LEAN.droppedDimensions[exported.source]) continue;
    assert.deepEqual(exported.labels, TELEMETRY_METRICS[exported.source]!.dimensions, exported.name);
  }
});

test("the full shape exports the catalog unchanged", () => {
  const full = exportedInstruments("full");
  const catalog = Object.values(TELEMETRY_METRICS).sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(
    full.map((m) => [m.name, m.kind, m.unit, m.labels, m.source]),
    catalog.map((m) => [
      m.name,
      m.kind === "histogram" ? "distribution" : m.kind,
      m.unit,
      m.dimensions,
      m.name,
    ]),
  );
});

test("series weights follow what a series becomes on the wire", () => {
  const weight = (name: string) => seriesWeight(LEAN, TELEMETRY_METRICS[name]!);
  assert.equal(weight("mission.dispatch.duration"), 9);
  assert.equal(weight("mission.daemon.startup.duration"), 2);
  assert.equal(weight("mission.dispatches"), 1);
  assert.equal(weight("mission.telemetry.health.pending"), 1);
});
