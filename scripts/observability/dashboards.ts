/** Source of truth for the six dashboards, panel manifest and cohort recording rules. */
import { ANALYTICAL_METRICS, ANALYTICAL_VIEWS, type AnalyticalView } from '../../src/shared/telemetry-projections/index.ts';
import { analyticalCoherenceQuery, analyticalPromName, analyticalValueQuery } from '../../src/shared/telemetry-projections/queries.ts';
import { TELEMETRY_METRICS } from '../../src/shared/telemetry-catalog.ts';

export const scope = 'deployment_environment_name=~"$environment",service_instance_id=~"$installation"';
const prom = { type: 'prometheus', uid: 'mission-prometheus' };
const tempo = { type: 'tempo', uid: 'mission-tempo' };
const base = 'audience="user",window="7d",horizon="7d"';
export const cohortRule = (view: AnalyticalView) => `mission:analytics_${view}:calculated_at`;
export const axes = {
  runs: ['all', 'workflow', 'author_model', 'author_effort', 'app_version'],
  reviews: ['all', 'reviewer_model', 'reviewer_effort', 'app_version'],
  tasks: ['all', 'task_kind', 'app_version'],
} as const;
export function cohortLabels(view: AnalyticalView, sliced = true): string {
  const axis = sliced && view in axes;
  return `${scope},${base},slice_by="${axis ? `$${view}_axis` : 'all'}",slice=~"${axis ? `$${view}_slice` : 'all'}"`;
}
export function cohortValue(view: AnalyticalView, field: string, labels = cohortLabels(view)): string {
  const value = analyticalValueQuery(view, field, labels);
  const calc = analyticalValueQuery(view, 'calculated_at', labels);
  // Compare to the actual calculation, not just presence of a last-evaluation guard. A new
  // partial snapshot arriving between rule evaluations must immediately disappear.
  const guard = `(${calc} == ${cohortRule(view)}{${labels}}) and ((time() - ${calc}) >= 0) and ((time() - ${calc}) < 7200)`;
  // Also catch a partial batch that updates a field BEFORE calculated_at arrives. The
  // recorded guard can still describe the old complete snapshot until its next evaluation.
  // Once current samples leave the instant lookback, the recorded coherence check owns it.
  const timestamps = ANALYTICAL_METRICS.filter((m) => m.name.startsWith(`mission.analytics.v1.${view}.`)).map((m) => {
    const field = m.name.split('.').at(-1)!;
    // timestamp drops the metric name; label each field afterwards to avoid collisions.
    return `label_replace(timestamp(${analyticalPromName(view, field)}{${labels}}), "analytical_field", "${field}", "__name__", ".*")`;
  }).join(' or ');
  const ahead = `max without(__name__, analytical_field) (${timestamps}) > ${calc}`;
  return `(${value} and ((${guard}) unless (${ahead})))`;
}
export function cohortRatio(view: AnalyticalView, numerator: string, denominator: string): string {
  const n = cohortValue(view, numerator), d = cohortValue(view, denominator);
  // Exactly the same guarded producer set contributes both sides.
  return `(sum(${n}) / sum(${d})) and (sum(${d}) > 0)`;
}
export interface PanelSpec {
  title: string; description: string; expr: string; unit: string; source: string[];
  kind?: 'stat' | 'table'; legend?: string; expected?: number; empty?: string;
  coverage?: boolean; filter?: AnalyticalView;
}
const exact = (view: AnalyticalView, field: string, title: string, expected?: number, unit = 'short'): PanelSpec => ({
  title, expr: `sum(${cohortValue(view, field)})`, source: [`mission.analytics.v1.${view}.${field}`],
  unit, expected, filter: view,
  description: `Exact ${view} snapshot at the selected end time. Starts in [T-14d,T-7d); outcomes through start+7d. Observed counts include incomplete coverage. ${view in axes ? `Uses only ${view} axis/slice controls.` : 'Environment and installation scope only.'}`,
});
const ratio = (view: AnalyticalView, n: string, d: string, title: string, expected?: number): PanelSpec => ({
  ...exact(view, n, title, expected, 'percentunit'), expr: cohortRatio(view, n, d),
  source: [`mission.analytics.v1.${view}.${n}`, `mission.analytics.v1.${view}.${d}`],
  description: `Observed ${n} / ${d}; identical coherent producers and filters on both sides. Incomplete is not complete; consult coverage. No eligible denominator is not zero.`,
  empty: 'No eligible / stale or partial',
});
export function metricName(name: string): string {
  const m = TELEMETRY_METRICS[name];
  if (!m) throw new Error(`Unknown panel instrument ${name}`);
  const root = name.replaceAll('.', '_');
  return root + (m.unit === 's' ? '_seconds' : m.unit === 'ms' ? '_milliseconds' : m.unit === 'USD' ? '_USD' : m.unit === 'By' && !root.endsWith('_bytes') ? '_bytes' : '') + (m.kind === 'counter' ? '_total' : '');
}
const activity = (name: string, title: string, by: string[], filter = '', unit = 'short'): PanelSpec => ({
  title, expr: `sum${by.length ? ` by (${by.join(',')})` : ''} (last_over_time(${metricName(name)}{${scope}${filter ? `,${filter}` : ''}}[$__range]))`,
  unit, source: [name], kind: by.length ? 'table' : 'stat',
  description: 'Last observed cumulative stream totals in the selected range, not events occurring in this range and not a distinct cohort census. Environment and installation only. Streams can reset with consent or resource changes.',
});
const duration = (name: string, title: string, by: string[], filter = ''): PanelSpec => ({
  ...activity(name, title, by, filter, TELEMETRY_METRICS[name]?.unit === 'ms' ? 'ms' : 's'),
  expr: `histogram_quantile(0.95, sum by (le${by.length ? `,${by.join(',')}` : ''}) (last_over_time(${metricName(name)}_bucket{${scope}${filter ? `,${filter}` : ''}}[$__range])))`,
  description: 'p95 over last observed cumulative histograms; not a selected-window latency census. Environment and installation only. Missing observations remain absent.',
});
const slice = (view: AnalyticalView, field: string, axis: string, title: string, unit = 'short'): PanelSpec => ({
  ...exact(view, field, title, undefined, unit), kind: 'table', filter: undefined,
  expr: `sum by (slice) (${cohortValue(view, field, `${scope},${base},slice_by="${axis}"`)})`,
  description: `Independent ${axis} marginal view; environment and installation only. No cross-product or join to other cohort filters.`,
});
const health = (field: string, title: string, unit = 'short'): PanelSpec => ({
  title, unit, source: [`mission.telemetry.health.${field}`],
  expr: `sum by (profile) (last_over_time(${metricName(`mission.telemetry.health.${field}`)}{${scope},profile="user"}[2m]))`,
  description: 'User destination health before its last drain. Absent after two minutes means no recent export, never a healthy zero. Other profile health stays private to that destination.', kind: 'table',
});
export const dashboardSpecs: Array<{ uid: string; title: string; view: AnalyticalView; note: string; panels: PanelSpec[] }> = [
  { uid: 'mission-adoption', title: 'Adoption and first value', view: 'features',
    note: 'Installations are consent epochs, not people. First observed success is not first-ever use. PR eligibility is unavailable: verified positives are shown without a fabricated PR-production denominator.', panels: [
      exact('features', 'first_period', 'Active observed installations: first period'),
      exact('features', 'second_period', 'Active observed installations: second period'),
      exact('features', 'repeated', 'Repeat-use installations'), ratio('features', 'repeated', 'repeat_eligible', 'Repeat-use rate'),
      { ...exact('features', 'first_observed_at', 'First observed success', undefined, 'dateTimeAsIso'), expr: `min(${cohortValue('features', 'first_observed_at')} > 0) * 1000`, empty: 'No observed success' },
      slice('features', 'successful_operations', 'feature', 'Successful use by feature'),
      activity('mission.action.count', 'Actions by feature and outcome (cumulative)', ['feature', 'outcome', 'actor']),
      activity('mission.dispatches', 'Dispatch funnel by task kind (cumulative)', ['task_kind', 'outcome']),
      exact('tasks', 'eligible', 'Eligible tasks'), exact('tasks', 'completed', 'Completed tasks'),
      exact('tasks', 'with_new_pr', 'Tasks with verified new PR'), exact('tasks', 'pr_visibility_unknown', 'Tasks with unknown PR visibility'),
      exact('prs', 'merged', 'Verified merged PRs'), exact('prs', 'late_merges', 'Late observed merges'),
  ] },
  { uid: 'mission-workflows', title: 'Workflow completion', view: 'runs',
    note: 'Exact matured cohorts retain pending, cancelled and unknown runs. Recent starts are immature. Session departure is separate from task completion. PR merges after the horizon do not rewrite task outcomes.', panels: [
      exact('runs', 'eligible', 'Eligible runs', 6), exact('runs', 'completed', 'Completed runs', 4),
      exact('runs', 'pending', 'Pending runs', 1), exact('runs', 'cancelled', 'Cancelled runs', 1),
      exact('runs', 'unknown', 'Unknown runs', 0), ratio('runs', 'completed', 'eligible', 'Observed horizon completion', 4 / 6),
      exact('runs', 'immature', 'Immature starts'), exact('runs', 'left_censored', 'Starts missing / pre-opt-in'),
      activity('mission.workflow.started', 'Workflow starts (cumulative)', ['workflow']),
      duration('mission.workflow.stage.duration', 'Stage wall time p95', ['stage_kind']),
      duration('mission.workflow.node.duration', 'Node execution time p95', ['node_kind', 'disposition']),
      duration('mission.workflow.wait.duration', 'Wait time p95 by wait owner', ['previous_wait']),
      duration('mission.workflow.node.queue.duration', 'Node queue wait p95', ['node_kind']),
      activity('mission.workflow.repair.rounds', 'Repair rounds (cumulative)', ['workflow']),
      duration('mission.workflow.repair.duration', 'Repair continuation p95', ['coverage']),
      exact('tasks', 'early_exit', 'Open-work departures'), exact('tasks', 'abandonment_candidate', 'Unconfirmed abandonment candidates'),
      exact('prs', 'merged_within_horizon', 'PR merges within horizon'),
  ] },
  { uid: 'mission-personas', title: 'Persona quality and burden', view: 'reviews',
    note: 'Executed reviews exclude invalid responses and reused passes. Reviewer model is distinct from author model. Persona identities and revisions are trace-only in the current contract. Low-volume slices are exploratory, not rankings.', panels: [
      exact('reviews', 'executed', 'Executed reviews', 8), exact('reviews', 'pass', 'Passed reviews', 6),
      exact('reviews', 'fail', 'Rejected reviews', 2), ratio('reviews', 'fail', 'executed', 'Observed rejection rate', .25),
      exact('reviews', 'invalid', 'Invalid responses', 1), exact('reviews', 'reused', 'Reused passes', 1),
      exact('reviews', 'packets', 'Delivered repair packets', 1), ratio('reviews', 'resolved', 'failed_with_next', 'Next-review resolution'),
      exact('reviews', 'no_next', 'Rejected without next review'), exact('reviews', 'ordering_unknown', 'Unknown review order'),
      slice('reasons', 'findings', 'category', 'Findings by reason'),
      activity('mission.persona.findings', 'Finding basis (cumulative)', ['basis', 'category_source']),
      activity('mission.workflow.nodes', 'Executed, disabled and reused nodes (cumulative)', ['node_kind', 'disposition']),
      activity('mission.action.count', 'Persona and workflow controls (cumulative)', ['action', 'outcome'], 'feature=~"persona|workflow"'),
      slice('reviews', 'executed', 'reviewer_model', 'Reviewer comparison: volume'),
  ] },
  { uid: 'mission-models', title: 'Models and effort', view: 'quality',
    note: 'Author-at-submission and reviewer execution use independent cohort axes. Pending effort is a selection, not effective execution. Session terminal and raw model context are trace-only; usage has its own bounded model dimension. Cost is reported or API-equivalent, never subscription billing.', panels: [
      exact('runs', 'mixed_author', 'Mixed author runs'), exact('quality', 'model_observations', 'Model observation volume'),
      ratio('quality', 'known_model', 'model_observations', 'Known model share'), ratio('quality', 'known_effort', 'effort_observations', 'Known effort share'),
      activity('mission.session.segments', 'Effective effort segments (cumulative)', ['effort', 'quality', 'agent', 'runtime']),
      activity('mission.session.effort.selections', 'Pending and applied effort choices (cumulative)', ['requested_effort', 'applies', 'outcome']),
      activity('mission.sessions.started', 'Session runtimes and origins (cumulative)', ['agent', 'runtime', 'origin']),
      duration('mission.session.turn.duration', 'Turn latency p95 by effective effort', ['effort', 'runtime']),
      activity('mission.usage.tokens', 'Tokens by observed model (cumulative)', ['model_id', 'usage_origin']),
      activity('mission.usage.cost', 'Attributed cost by observed model (cumulative)', ['model_id', 'cost_basis'], '', 'currencyUSD'),
      exact('runs', 'completed', 'Author-at-submission completions'), exact('reviews', 'executed', 'Reviewer execution volume'),
      slice('usage', 'cost', 'cost_basis', 'Cohort cost by basis', 'currencyUSD'),
      slice('usage', 'input', 'work_role', 'Cohort input tokens by role'),
      ratio('usage', 'cost', 'qualifying_outcomes', 'Cost per qualifying outcome'),
      exact('usage', 'unpriced', 'Unpriced usage observations'), exact('tasks', 'usage_missing', 'Tasks missing usage'),
  ] },
  { uid: 'mission-interventions', title: 'Human involvement', view: 'runs',
    note: 'Confirmed recovery counts distinct affected runs, not resume clicks. Known human-free means no observed human action within Mission Control coverage. External terminal typing is unobserved; ambiguous actors cannot qualify.', panels: [
      exact('runs', 'eligible', 'Eligible runs', 6), exact('runs', 'with_recovery', 'Runs with confirmed recovery', 1),
      ratio('runs', 'with_recovery', 'eligible', 'Observed recovery incidence', 1 / 6), exact('runs', 'recovery_operations', 'Distinct recovery operations', 1),
      exact('runs', 'automation_eligible', 'Automation-eligible runs', 5), exact('runs', 'human_free', 'Known human-free completions', 1),
      ratio('runs', 'human_free', 'automation_eligible', 'Known human-free completion rate', .2),
      exact('runs', 'human_gate', 'Authored human gates', 1), exact('runs', 'ambiguous_actor', 'Ambiguous actor runs', 1),
      exact('runs', 'with_human', 'Runs with observed human action'), exact('runs', 'observation_incomplete', 'Incomplete run observations'),
      activity('mission.workflow.interventions', 'Human actions by intent (cumulative)', ['intent', 'action', 'cause']),
      activity('mission.action.count', 'Action failures and actor provenance (cumulative)', ['actor', 'outcome']),
      duration('mission.workflow.wait.duration', 'Human wait p95', ['previous_wait'], 'previous_wait="human"'),
  ] },
  { uid: 'mission-reliability', title: 'Reliability and data quality', view: 'quality',
    note: 'Backend health is last exported health and cannot diagnose a completely disconnected producer in real time. Use Settings > Telemetry locally during an outage. Error observations are not a distinct affected-operation census; suppression and coverage are shown separately.', panels: [
      activity('mission.errors', 'Safe errors by component and family (cumulative)', ['component', 'family', 'code']),
      activity('mission.renderer.errors', 'Renderer errors (cumulative)', ['component', 'family', 'code']),
      activity('mission.errors.suppressed', 'Suppressed repeat errors (cumulative)', ['component', 'code']),
      exact('features', 'affected_installation', 'Installations with failed operations'), exact('features', 'failed_operations', 'Distinct failed operations'),
      health('pending', 'Pending batches'), health('pending_bytes', 'Pending queue bytes', 'bytes'),
      health('oldest_pending_age', 'Oldest pending age', 's'), health('retrying', 'Retrying delivery batches'),
      health('rejected', 'Rejected delivery batches'), health('expired', 'Expired delivery batches'),
      activity('mission.session.restores', 'Session restart recovery (cumulative)', ['outcome']),
      activity('mission.connection.recoveries', 'Browser reconnections (cumulative)', []),
      exact('quality', 'late_facts', 'Late-arriving facts'), exact('quality', 'omitted_facts', 'Omitted joining context'),
      exact('quality', 'rejected_state', 'Rejected bounded state facts'), exact('quality', 'expired_state', 'Expired minimal state facts'),
      exact('quality', 'unknown_actor', 'Unknown actor facts'),
  ] },
];
// This is money per outcome, not a percentage.
dashboardSpecs.find((d) => d.uid === 'mission-models')!.panels.find((p) => p.title === 'Cost per qualifying outcome')!.unit = 'currencyUSD';

function variable(name: string, query: string, label: string, value: string, custom = false) {
  return { name, label, type: custom ? 'custom' : 'query', datasource: prom, query,
    refresh: 1, sort: 1, multi: false, includeAll: !custom, allValue: '.*',
    current: { selected: true, text: value === '$__all' ? 'All' : value, value }, options: [] };
}
export function dashboardVariables(spec: typeof dashboardSpecs[number]) {
  const used = new Set(allPanels(spec).map((p) => p.filter));
  return [variable('environment', 'local,demo,test', 'Environment (every panel)', 'local', true),
    variable('installation', `label_values(mission_analytics_v1_quality_calculated_at_seconds{deployment_environment_name=~"$environment",audience="user",slice_by="all"},service_instance_id)`, 'Installation (every panel)', '$__all'),
    ...Object.entries(axes).filter(([view]) => used.has(view as AnalyticalView)).flatMap(([view, choices]) => [
      variable(`${view}_axis`, choices.join(','), `${view} cohort axis only`, 'all', true),
      variable(`${view}_slice`, `label_values(mission_analytics_v1_${view}_calculated_at_seconds{${scope},audience="user",slice_by="$${view}_axis"},slice)`, `${view} cohort slice only`, '$__all'),
    ])];
}
export function allPanels(spec: typeof dashboardSpecs[number]): PanelSpec[] {
  return [
    ...spec.panels,
    ...[...new Set(spec.panels.flatMap((p) => p.source.filter((s) => s.startsWith('mission.analytics.v1.')).map((s) => s.split('.')[3] as AnalyticalView)))].filter((view) => view !== spec.view).flatMap((view) => [
      { ...exact(view, 'complete', `${view}: observation coverage`), expr: `min(${cohortValue(view, 'complete')})`, coverage: true },
      { ...exact(view, 'calculated_at', `${view}: snapshot age`, undefined, 's'), expr: `max(time() - ${cohortValue(view, 'calculated_at')})` },
    ]),
    { ...exact(spec.view, 'complete', 'Observation coverage'), expr: `min(${cohortValue(spec.view, 'complete')})`, coverage: true },
    { ...exact(spec.view, 'calculated_at', 'Snapshot age', undefined, 's'), expr: `max(time() - ${cohortValue(spec.view, 'calculated_at')})` },
    { ...exact(spec.view, 'calculated_at', 'Coherent producers'), expr: `count(max by (service_instance_id) (${cohortValue(spec.view, 'calculated_at')}))` },
    { ...exact(spec.view, 'calculated_at', 'Producers seen in 30 days'), expr: `count(max by (service_instance_id) (last_over_time(mission_analytics_v1_${spec.view}_calculated_at_seconds{${scope},${base},slice_by="all",slice="all"}[30d])))`,
      filter: undefined,
      description: 'Environment and installation only. Previously seen producers, not a configured inventory. With the cohort axis set to all, compare with coherent producers to expose stale or partial installations. A narrower cohort slice can also reduce the coherent count; never-seen producers cannot be counted.' },
  ];
}
export function makeDashboard(spec: typeof dashboardSpecs[number]) {
  let x = 0, y = 7;
  const panels = allPanels(spec).map((p, i) => {
    // Tables need room for their dimension columns and value without horizontal scrolling.
    const w = p.kind === 'table' ? 24 : 8;
    if (x + w > 24) { x = 0; y += 7; }
    const gridPos = { x, y, w, h: 7 };
    x += w;
    if (x === 24) { x = 0; y += 7; }
    return { id: i + 2, title: p.title, description: p.description,
    type: p.kind ?? 'stat', datasource: prom,
    gridPos,
    targets: [{ refId: 'A', datasource: prom, expr: p.expr, instant: true, format: p.kind === 'table' ? 'table' : 'time_series', legendFormat: p.legend ?? p.title }],
    fieldConfig: { defaults: { unit: p.unit, decimals: p.unit === 'short' ? 0 : 2,
      noValue: p.empty ?? 'Absent / stale / partial', color: { mode: 'fixed', fixedColor: 'text' },
      ...(p.coverage ? { mappings: [{ type: 'value', options: { '0': { text: 'Incomplete', color: 'orange' }, '1': { text: 'Complete', color: 'green' } } }] } : {}) }, overrides: [] },
    ...(p.kind === 'table' ? { transformations: [{ id: 'organize', options: { excludeByName: { Time: true, __name__: true } } }] } : {}),
    options: p.kind === 'table' ? { showHeader: true, cellHeight: 'sm' } : { reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false }, textMode: 'value', graphMode: 'none' },
  }; });
  const traceFilter = spec.uid === 'mission-personas' ? ' && name = "mission.workflow.review.finished"' : spec.uid === 'mission-reliability' ? ' && name = "mission.error.occurrence"' : '';
  const traceY = y + (x ? 7 : 0);
  return { uid: spec.uid, title: `Mission Control: ${spec.title}`, schemaVersion: 39, version: 1,
    editable: false, tags: ['mission-control', 'product-telemetry'], timezone: 'browser', refresh: '30s',
    time: { from: 'now-14d', to: 'now' }, templating: { list: dashboardVariables(spec) },
    links: dashboardSpecs.map((d) => ({ title: d.title, type: 'link', url: `/d/${d.uid}`, includeVars: true, keepTime: true })),
    panels: [{ id: 1, type: 'text', title: 'Scope and interpretation', gridPos: { x: 0, y: 0, w: 24, h: 7 },
      options: { mode: 'markdown', content: `${spec.note}\n\n**Environment and installation apply everywhere.** Axis/slice controls affect only their labelled cohort panels, including coverage. Other panels use only environment and installation. Cohorts show the 7-day start window ending 7 days before the selected end time. Activity panels show last observed cumulative streams in the selected time range. Missing, stale (>2h) or partial snapshots are absent, never zero. An explicit 0 is an observed zero; Incomplete means coverage gaps.\n\n[Signal and query contract](https://github.com/teamupstart/mission-control/blob/main/docs/telemetry-analytics.md)` } },
      ...panels,
      { id: 900, title: 'Event-time traces: select a Trace ID', type: 'table', datasource: tempo,
        description: 'Safe workflow, review, session and error context. Trace sampling never changes metric denominators. Environment, installation and time only. Trace attributes support persona, revision, stage and model inspection.',
        gridPos: { x: 0, y: traceY, w: 24, h: 10 }, targets: [{ refId: 'A', datasource: tempo, queryType: 'traceql',
          query: '{ resource.service.name = "mission-control" && resource.deployment.environment.name =~ "$environment" && resource.service.instance.id =~ "$installation"' + traceFilter + ' }', limit: 100, tableType: 'traces' }],
        options: { showHeader: true }, fieldConfig: { defaults: { noValue: 'No traces in this range' }, overrides: [] } },
    ],
  };
}
export function recordingRules() {
  return { groups: [{ name: 'mission-coherent-snapshots', interval: '30s', rules: Object.keys(ANALYTICAL_VIEWS).map((v) => {
    const view = v as AnalyticalView;
    return { record: cohortRule(view), expr: `${analyticalValueQuery(view, 'calculated_at', base)} and (${analyticalCoherenceQuery(view, base)})` };
  }) }] };
}
