/**
 * The export shapes a telemetry destination can receive, and the one statement of what each
 * shape actually exports.
 *
 * A shape changes what ONE destination receives and nothing else: the local store, the other
 * destination and every span keep the full catalog. `full` is the identity, so a destination
 * that never names a shape exports exactly what it did before shapes existed. `datadog-lean`
 * holds the cost-bounded values approved in docs/plans/upstart-datadog-telemetry/plan.md
 * ("Datadog cost"); changing any of them needs an audit entry in that plan's phase record.
 *
 * Browser-safe. The Settings panel prints `label` and `summary`, and the Datadog dashboard
 * validator reads `exportedInstruments`, so neither restates the lean rules.
 */
import {
  TELEMETRY_EXPORT_SHAPE_IDS,
  type TelemetryExportShapeId,
  type TelemetryProfileId,
} from "./telemetry.ts";
import {
  TELEMETRY_EVENTS,
  TELEMETRY_METRICS,
  type TelemetryEventDefinition,
  type TelemetryMetricDefinition,
} from "./telemetry-catalog.ts";

export { TELEMETRY_EXPORT_SHAPE_IDS, type TelemetryExportShapeId };

/** How a series is priced against a shape's budget: by what it becomes on the wire. */
export type TelemetrySeriesWeightKind = "distribution" | "sumCount" | "counter" | "gauge";

export interface TelemetryExportShape {
  id: TelemetryExportShapeId;
  /** The option text in Settings. */
  label: string;
  /** One sentence naming what the shape leaves out. Settings prints it beside the select. */
  summary: string;
  /** Instrument-name prefixes this destination never receives. */
  excludedPrefixes: readonly string[];
  /** Labels removed from particular instruments, so their series aggregate together. */
  droppedDimensions: Readonly<Record<string, readonly string[]>>;
  /**
   * Histograms kept as distributions. Every other histogram is exported as a `<name>.sum`
   * counter and a `<name>.count` counter instead.
   */
  distributionHistograms: "all" | readonly string[];
  /** Constant attributes added to every metrics batch resource for this destination. */
  resourceAttributes: Readonly<Record<string, string>>;
  /** Most weighted series live at once, and exported in any clock hour. Null is unbounded. */
  seriesBudget: number | null;
  /** What one series costs against `seriesBudget`, by what it becomes on the wire. */
  weights: Readonly<Record<TelemetrySeriesWeightKind, number>>;
}

/** The suffixes a histogram exported as two counters is published under. */
export const SUM_COUNT_SUFFIXES = { sum: ".sum", count: ".count" } as const;

export const TELEMETRY_EXPORT_SHAPES: Readonly<Record<TelemetryExportShapeId, TelemetryExportShape>> = {
  full: {
    id: "full",
    label: "Full",
    summary: "Every metric and label in the catalog, with every histogram as a distribution.",
    excludedPrefixes: [],
    droppedDimensions: {},
    distributionHistograms: "all",
    resourceAttributes: {},
    seriesBudget: null,
    weights: { distribution: 1, sumCount: 1, counter: 1, gauge: 1 },
  },
  "datadog-lean": {
    id: "datadog-lean",
    label: "Datadog lean",
    summary:
      "Leaves out the mission.analytics.v1 cohort gauges and the labels traces already carry, sends minor histograms as sum and count, and caps this destination at 1,500 weighted series an hour.",
    excludedPrefixes: ["mission.analytics.v1."],
    droppedDimensions: {
      "mission.dispatches": ["resolution_source", "resolved_effort"],
      "mission.action.count": ["actor"],
      "mission.sessions.ended": ["ended_while_work_open"],
      "mission.session.segments": ["quality", "reason"],
      "mission.sessions.started": ["start_observation"],
      "mission.session.operations": ["actor_basis"],
      "mission.session.turns": ["quality"],
      "mission.session.effort.selections": ["applies"],
      "mission.automation.actions": ["actor"],
    },
    distributionHistograms: [
      "mission.session.turn.duration",
      "mission.dispatch.duration",
      "mission.workflow.duration",
      "mission.workflow.node.duration",
    ],
    // Datadog resolves a host from `host` first, then `datadog.host.name`, and recommends the
    // latter. One constant value stops the gateway pod that happened to take a request from
    // splitting one installation's series; `service.instance.id` still tells installations apart.
    resourceAttributes: { "datadog.host.name": "mission-control" },
    seriesBudget: 1_500,
    // A distribution is 9 custom metrics while the gateway keeps `send_aggregation_metrics: true`,
    // and 5 if its owners turn that off. Change that one number if they do.
    weights: { distribution: 9, sumCount: 2, counter: 1, gauge: 1 },
  },
};

export function exportShape(id: TelemetryExportShapeId): TelemetryExportShape {
  return TELEMETRY_EXPORT_SHAPES[id];
}

/** Whether a shape leaves this instrument out of its destination entirely. */
export function shapeExcludes(shape: TelemetryExportShape, instrument: string): boolean {
  return shape.excludedPrefixes.some((prefix) => instrument.startsWith(prefix));
}

/** The dimensions a shape keeps for an instrument, in the catalog's own order. */
export function shapeDimensions(
  shape: TelemetryExportShape,
  definition: TelemetryMetricDefinition,
): readonly string[] {
  const dropped = shape.droppedDimensions[definition.name];
  return dropped ? definition.dimensions.filter((key) => !dropped.includes(key)) : definition.dimensions;
}

/** Whether a histogram is exported as two counters rather than as a distribution. */
export function shapeSplitsHistogram(
  shape: TelemetryExportShape,
  definition: TelemetryMetricDefinition,
): boolean {
  if (definition.kind !== "histogram") return false;
  return shape.distributionHistograms !== "all" && !shape.distributionHistograms.includes(definition.name);
}

export function seriesWeightKind(
  shape: TelemetryExportShape,
  definition: TelemetryMetricDefinition,
): TelemetrySeriesWeightKind {
  if (definition.kind === "histogram") {
    return shapeSplitsHistogram(shape, definition) ? "sumCount" : "distribution";
  }
  return definition.kind;
}

/** What one series of this instrument costs against the shape's budget. */
export function seriesWeight(shape: TelemetryExportShape, definition: TelemetryMetricDefinition): number {
  return shape.weights[seriesWeightKind(shape, definition)];
}

export interface TelemetryExportedInstrument {
  /** The metric name the destination receives. */
  name: string;
  kind: "counter" | "gauge" | "distribution";
  unit: string;
  /** The data-point attributes it carries, in catalog order. */
  labels: readonly string[];
  /** The catalog instrument it is derived from. */
  source: string;
}

/**
 * Everything a shape exports, one entry per metric name the destination receives.
 *
 * The only statement of a shape's output. `profile` narrows to the instruments that audience
 * may receive at all, which is what a dashboard built for one destination needs.
 */
export function exportedInstruments(
  shapeId: TelemetryExportShapeId,
  catalog: Readonly<Record<string, TelemetryMetricDefinition>> = TELEMETRY_METRICS,
  profile?: TelemetryProfileId,
): TelemetryExportedInstrument[] {
  const shape = exportShape(shapeId);
  const exported: TelemetryExportedInstrument[] = [];
  for (const definition of Object.values(catalog)) {
    if (shapeExcludes(shape, definition.name)) continue;
    if (profile !== undefined && !definition.audience.includes(profile)) continue;
    const labels = shapeDimensions(shape, definition);
    if (shapeSplitsHistogram(shape, definition)) {
      exported.push(
        { name: `${definition.name}${SUM_COUNT_SUFFIXES.sum}`, kind: "counter", unit: definition.unit, labels, source: definition.name },
        { name: `${definition.name}${SUM_COUNT_SUFFIXES.count}`, kind: "counter", unit: "1", labels, source: definition.name },
      );
      continue;
    }
    exported.push({
      name: definition.name,
      kind: definition.kind === "histogram" ? "distribution" : definition.kind,
      unit: definition.unit,
      labels,
      source: definition.name,
    });
  }
  return exported.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Every way a shape disagrees with the catalog it shapes. Empty when the shape is sound.
 *
 * A dropped label must still be recoverable from the trace: either the instrument's event
 * carries it as a span attribute, or it is `actor`, which every span carries as
 * `mission.actor.kind`.
 */
export function exportShapeProblems(
  shape: TelemetryExportShape,
  catalog: Readonly<Record<string, TelemetryMetricDefinition>> = TELEMETRY_METRICS,
  events: Readonly<Record<string, TelemetryEventDefinition>> = TELEMETRY_EVENTS,
): string[] {
  const problems: string[] = [];
  for (const [instrument, dropped] of Object.entries(shape.droppedDimensions)) {
    const definition = catalog[instrument];
    if (!definition) {
      problems.push(`${shape.id} drops labels from unknown instrument ${instrument}`);
      continue;
    }
    const spanAttributes = events[definition.event]?.span?.attributes ?? [];
    for (const label of dropped) {
      if (!definition.dimensions.includes(label)) {
        problems.push(`${shape.id} drops ${label}, which ${instrument} does not declare`);
      } else if (label !== "actor" && !spanAttributes.includes(label)) {
        problems.push(`${shape.id} drops ${label} from ${instrument}, but its span does not carry it`);
      }
    }
  }
  if (shape.distributionHistograms !== "all") {
    for (const instrument of shape.distributionHistograms) {
      if (catalog[instrument]?.kind !== "histogram") {
        problems.push(`${shape.id} keeps ${instrument} as a distribution, but it is not a histogram`);
      }
    }
  }
  for (const exported of exportedInstruments(shape.id, catalog)) {
    if (exported.name !== exported.source && catalog[exported.name]) {
      problems.push(`${shape.id} exports ${exported.name}, which collides with a catalog instrument`);
    }
  }
  return problems;
}
