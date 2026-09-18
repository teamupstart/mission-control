import { ANALYTICAL_METRICS, ANALYTICAL_PREFIX, type AnalyticalView } from "./index.ts";

/** Pinned reference receiver translation, verified by the analytical stack test. */
export function analyticalPromName(view: AnalyticalView, field: string): string {
  const name = `${ANALYTICAL_PREFIX}.${view}.${field}`;
  const metric = ANALYTICAL_METRICS.find((m) => m.name === name);
  if (!metric) throw new Error(`undeclared analytical field: ${name}`);
  return name.replaceAll(".", "_") + (metric.unit === "s" ? "_seconds" : metric.unit === "USD" ? "_USD" : metric.unit === "1" ? "_ratio" : "");
}

/** Labels are a trusted PromQL selector supplied by dashboard definitions, not user input. */
export function analyticalValueQuery(view: AnalyticalView, field: string, labels: string): string {
  return `last_over_time(${analyticalPromName(view, field)}{${labels}}[2h])`;
}

/**
 * Validate an entire view before taking any ratio. Evaluate timestamp on EACH raw selector
 * before adding a field label: label_replace first would replace its timestamp with query
 * evaluation time, while timestamp on the whole family drops names and creates collisions.
 * The subquery retains real point timestamps across the hourly idle refresh, beyond
 * Prometheus's default five-minute instant-vector lookback. Its 30s grid can temporarily
 * withhold a new snapshot, but cannot pair different calculations.
 */
export function analyticalCoherenceQuery(view: AnalyticalView, labels: string): string {
  const calculated = analyticalValueQuery(view, "calculated_at", labels);
  const expected = analyticalValueQuery(view, "expected_points", labels);
  const fields = ANALYTICAL_METRICS.filter((m) => m.name.startsWith(`${ANALYTICAL_PREFIX}.${view}.`))
    .map((m) => m.name.slice(`${ANALYTICAL_PREFIX}.${view}.`.length));
  const stamped = fields.map((field) => `label_replace(timestamp(${analyticalPromName(view, field)}{${labels}}), "analytical_field", "${field}", "__name__", ".*")`).join(" or ");
  const timestamps = `last_over_time((${stamped})[2h:30s])`;
  const aligned = `(${timestamps} == ignoring(__name__, analytical_field) group_left ${calculated})`;
  return `(count without(__name__, analytical_field) (${aligned}) == ignoring(__name__) ${expected})`
    + ` and ignoring(__name__) ((time() - ${calculated}) >= 0)`
    + ` and ignoring(__name__) ((time() - ${calculated}) < 7200)`
    // An app upgrade creates a new resource series for the same installation. Only its
    // latest calculation may contribute; a still-fresh previous version must not double it.
    + ` and ignoring(__name__) (${calculated} == ignoring(__name__, service_version) group_left max without(__name__, service_version) (${calculated}))`;
}
