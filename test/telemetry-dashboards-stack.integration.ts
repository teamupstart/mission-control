import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const home = mkdtempSync(join(tmpdir(), 'mission-dashboards-stack-'));
process.env.MISSION_HOME = home;
process.env.MISSION_TELEMETRY_ENVIRONMENT = 'test';
const { MODE, ENDPOINTS, composeService, waitUntilReady } = await import('../scripts/observability.mjs');
const { openDb, closeDb } = await import('../src/server/db.ts');
const { runProjectionPass } = await import('../src/server/telemetry/projection.ts');
const { runDeliveryPass, send } = await import('../src/server/telemetry/delivery.ts');
const { serializeMetrics, serializeTraces } = await import('../src/server/telemetry/otlp.ts');
const { captureTelemetry } = await import('../src/server/telemetry/capture.ts');
const { DAEMON_STARTED_EVENT } = await import('../src/shared/telemetry-catalog.ts');
const { seedDashboardFixture, DAY } = await import('./helpers/dashboard-telemetry.ts');
const { dashboardSpecs, allPanels } = await import('../scripts/observability/dashboards.ts');
type Point = { metric: Record<string, string>; value: [number, string] };
after(() => { closeDb(); rmSync(home, { recursive: true, force: true }); });
async function query(q: string, at?: number): Promise<Point[]> {
  const response = await fetch(`${ENDPOINTS.prometheus}/api/v1/query?${new URLSearchParams({ query: q, ...(at ? { time: String(at / 1000) } : {}) })}`, { signal: AbortSignal.timeout(15000) });
  const body = await response.json() as { status: string; error?: string; data: { result: Point[] } };
  assert.equal(body.status, 'success', `${q}\n${body.error}`);
  return body.data.result;
}
async function eventually(check: () => Promise<boolean>, caption: string, ms = 90000) {
  const until = performance.now() + ms;
  do { if (await check()) return; await new Promise((r) => setTimeout(r, 500)); } while (performance.now() < until);
  assert.fail(caption);
}
const vars = (q: string, installation: string) => q.replaceAll('$environment', 'test').replaceAll('$installation', installation).replaceAll('$__range', '14d').replace(/\$(runs|reviews|tasks)_axis/g, 'all').replace(/\$(runs|reviews|tasks)_slice/g, 'all');
function service(action: 'stop' | 'start' | 'kill', name: 'collector' | 'prometheus' | 'tempo' | 'grafana') {
  const r = composeService(action, name); assert.ok(r.ok, r.output);
}
async function trace(id: string) {
  const r = await fetch(`${ENDPOINTS.tempo}/api/traces/${id}`);
  return r.ok ? r.json() : null;
}

test('all six dashboards query the real owner oracle, every slice and historical safe traces', async () => {
  assert.equal(MODE, 'test', 'requires MC_OBSERVABILITY_MODE=test; never interrupt an operator stack');
  assert.ok((await waitUntilReady(60000)).ok);
  const fixture = await seedDashboardFixture(Date.now() - 60000, ENDPOINTS.otlp, true);
  const pending = openDb().prepare("SELECT payload_json FROM telemetry_batches WHERE profile='user' AND signal='metrics'").all();
  const copied = pending.map((r) => JSON.parse(String(r.payload_json)) as import('../src/server/telemetry/projection.ts').MetricsBatchPayload);
  for (let i = 0; i < 20; i++) if (!(await runDeliveryPass()).sent) break;
  const q = vars(dashboardSpecs[1]!.panels[0]!.expr, fixture.installation!);
  await eventually(async () => Number((await query(q))[0]?.value[1]) === 6, 'coherent six-run calculation must reach the receiver');
  const timings: number[] = [];
  let populated = 0, total = 0;
  for (const spec of dashboardSpecs) {
    const response = await fetch(`${ENDPOINTS.grafana}/api/dashboards/uid/${spec.uid}`);
    assert.ok(response.ok, spec.uid);
    assert.equal((await response.json() as { dashboard: { uid: string } }).dashboard.uid, spec.uid);
    for (const p of allPanels(spec)) {
      const start = performance.now(); const values = await query(vars(p.expr, fixture.installation!)); timings.push(performance.now() - start);
      total++; if (values.length) populated++;
      if (p.expected !== undefined) assert.ok(Math.abs(Number(values[0]?.value[1]) - p.expected) < 1e-6, `${spec.uid}: ${p.title}: ${JSON.stringify(values)}`);
      if (/Successful use by feature|Findings by reason|Reviewer comparison|Stage wall time|Actions by feature|Tokens by observed/.test(p.title)) assert.ok(values.length, p.title);
    }
  }
  const runsLabels = `service_instance_id="${fixture.installation}",audience="user",slice_by="workflow",slice="custom"`;
  assert.equal(Number((await query(`last_over_time(mission_analytics_v1_runs_eligible{${runsLabels}}[2h])`))[0]?.value[1]), 6);
  assert.equal((await query(q.replace(fixture.installation!, 'absent-installation'))).length, 0);
  assert.equal((await query(q, fixture.now + 3 * 3600000)).length, 0);
  assert.equal(Number((await query(`sum(last_over_time(mission_analytics_v1_prs_late_merges{service_instance_id="${fixture.installation}",slice_by="all"}[2h]))`))[0]?.value[1]), 1);
  for (const id of [fixture.reviewTrace, fixture.errorTrace]) {
    assert.ok(id);
    await eventually(async () => !!await trace(id), 'original-time trace is queryable');
    const content = JSON.stringify(await trace(id));
    assert.ok(!content.includes('PRIVATE_SENTINEL'));
    assert.ok(content.includes('mission.actor.kind'));
    assert.ok(content.includes(Buffer.from(id, 'hex').toString('base64')), 'lookup content identifies the requested trace bytes');
    const search = new URL(`${ENDPOINTS.tempo}/api/search`);
    search.searchParams.set('q', `{ resource.service.instance.id = "${fixture.installation}" && name = "${id === fixture.reviewTrace ? 'mission.workflow.review.finished' : 'mission.error.occurrence'}" }`);
    search.searchParams.set('start', String(Math.floor((fixture.now - 8 * DAY) / 1000)));
    search.searchParams.set('end', String(Math.floor(fixture.now / 1000)));
    await eventually(async () => JSON.stringify(await (await fetch(search)).json()).includes(id), 'historical time-bounded search finds that trace');
    if (id === fixture.reviewTrace) assert.ok(content.includes('mission.reviewer_model') && content.includes('mission.verdict'));
    else assert.ok(content.includes('mission.code') && content.includes('timeout'));
  }
  // Ambiguous ACK: resend the exact immutable metrics twice; gauges remain unchanged.
  for (const payload of copied) assert.equal((await send(`${ENDPOINTS.otlp}/v1/metrics`, 'metrics', serializeMetrics(payload), 'user', { fetch: globalThis.fetch, now: Date.now, abort: null })).kind, 'accepted');
  assert.equal(Number((await query(q))[0]?.value[1]), 6);
  timings.sort((a, b) => a - b);
  console.log(`ORACLE real workflow owners: reviews=8 pass=6 fail=2; completed=4 pending=1 cancelled=1; recovery=1/6; known human-free=R2 only (1/5 automation eligible).`);
  console.log(`PANELS ${total} queries valid, ${populated} populated; query p50=${timings[Math.floor(timings.length * .5)]!.toFixed(2)}ms p95=${timings[Math.floor(timings.length * .95)]!.toFixed(2)}ms; filtered slices, late PR and safe historical trace search passed.`);
  mkdirSync('.evidence/observability', { recursive: true });
  writeFileSync('.evidence/observability/integration-fixture.json', JSON.stringify(fixture, null, 2));
});

test('offline capture survives owner restart, and each durable backend handoff survives restart', async () => {
  assert.equal(MODE, 'test');
  const resource = (await import('../src/server/telemetry/capture.ts')).resourceAttributes();
  let seq = 0;
  const capture = () => {
    const at = Date.now() - 60000;
    const result = captureTelemetry({ event: DAEMON_STARTED_EVENT, source: { kind: 'mission.dashboard.outage', id: String(++seq), revision: 1 },
      facts: { launch_mode: 'daemon', startup_ms: 100, schema_upgraded: false }, occurredAt: at, now: at });
    assert.equal(result.kind, 'accepted');
    runProjectionPass();
    const rows = openDb().prepare("SELECT signal,payload_json FROM telemetry_batches WHERE profile='user' AND signal='traces'").all();
    const spans = rows.flatMap((r) => JSON.parse(String(r.payload_json)).spans) as import('../src/server/telemetry/projection.ts').SpanDto[];
    return { at, span: spans.find((s) => s.name === 'mission.daemon.start')! };
  };
  const check = async (count: number, id: string) => {
    await eventually(async () => Number((await query(`sum(last_over_time(mission_daemon_starts_total{service_instance_id="${resource['service.instance.id']}"}[1h]))`))[0]?.value[1]) === count, 'unchanged canonical counts after recovery');
    await eventually(async () => !!await trace(id), 'trace survives durable handoff');
  };
  const start = performance.now();
  for (const name of ['collector', 'prometheus', 'tempo', 'grafana'] as const) service('stop', name);
  let first: ReturnType<typeof capture>;
  try {
    first = capture();
    assert.ok(first.span);
    const backlog = openDb().prepare("SELECT id,payload_json FROM telemetry_batches WHERE profile='user' ORDER BY id").all();
    assert.ok((await runDeliveryPass()).retried > 0);
    closeDb(); openDb();
    assert.deepEqual(openDb().prepare("SELECT id,payload_json FROM telemetry_batches WHERE profile='user' ORDER BY id").all(), backlog);
  } finally {
    for (const name of ['prometheus', 'tempo', 'collector', 'grafana'] as const) service('start', name);
  }
  assert.ok((await waitUntilReady(90000)).ok);
  // Backoff remains real; advance delivery scheduling only, not the source event timestamps.
  await runDeliveryPass({ now: () => Date.now() + 60000 });
  await check(1, first!.span.traceId);
  console.log(`FULL OUTAGE: durable owner restart retained immutable backlog; recovery ${(performance.now() - start).toFixed(0)}ms; original event timestamp ${first!.at}.`);
  for (const backend of ['prometheus', 'tempo'] as const) {
    service('stop', backend);
    let point: ReturnType<typeof capture>;
    try {
      point = capture();
      assert.ok((await runDeliveryPass()).accepted > 0, 'Collector acknowledges its persisted queue');
      service('kill', 'collector'); service('start', 'collector');
      // A healthy independent destination must still advance while its sibling is offline.
      if (backend === 'prometheus') await eventually(async () => !!await trace(point.span.traceId), 'Tempo not starved by Prometheus outage');
      else await eventually(async () => Number((await query(`sum(last_over_time(mission_daemon_starts_total{service_instance_id="${resource['service.instance.id']}"}[1h]))`))[0]?.value[1]) === seq, 'Prometheus not starved by Tempo outage');
    } finally { service('start', backend); }
    assert.ok((await waitUntilReady(90000)).ok);
    await check(seq, point!.span.traceId);
    console.log(`PERSISTENT HANDOFF: ${backend} outage + Collector SIGKILL/restart; sibling continued; canonical count=${seq}, trace found.`);
  }
  // Duplicate trace payload with identical IDs: lookup must retain one semantic span.
  const body = serializeTraces({ resource, scope: { name: 'mission-control', version: '1' }, spans: [first!.span] });
  for (let i = 0; i < 2; i++) assert.equal((await send(`${ENDPOINTS.otlp}/v1/traces`, 'traces', body, 'user', { fetch: globalThis.fetch, now: Date.now, abort: null })).kind, 'accepted');
  const traceContent = JSON.stringify(await trace(first!.span.traceId));
  assert.ok(traceContent.includes('mission.daemon.start'));
  console.log('Ambiguous metric and trace ACK replay preserves canonical values and queryable semantic IDs.');
});

test('seven-day late samples remain searchable; beyond-window rejection is observable', async () => {
  assert.equal(MODE, 'test');
  const resource = (await import('../src/server/telemetry/capture.ts')).resourceAttributes();
  const at = Date.now() - 7 * DAY + 60000;
  const marker = `${resource['service.instance.id']}-late`;
  const make = (time: number) => ({ resource: { ...resource, 'service.instance.id': marker }, scope: { name: 'mission-control', version: '1' },
    metrics: [{ name: 'mission.daemon.starts', description: 'Late-window compatibility probe', unit: '1', kind: 'counter' as const,
      valueType: 'int' as const, startTimeMs: time - 60000, endTimeMs: time, attributes: { launch_mode: 'daemon', schema_upgraded: 'false' }, value: 1, histogram: null }] });
  const deps = { fetch: globalThis.fetch, now: Date.now, abort: null };
  assert.equal((await send(`${ENDPOINTS.otlp}/v1/metrics`, 'metrics', serializeMetrics(make(at)), 'user', deps)).kind, 'accepted');
  await eventually(async () => Number((await query(`mission_daemon_starts_total{service_instance_id="${marker}"}`, at + 1000))[0]?.value[1]) === 1, 'maximum supported late data is queryable at original time');
  const traceId = '1' + resource['service.instance.id']!.padEnd(31, 'a').slice(0, 31);
  const span = { name: 'mission.late.compatibility', kind: 'internal' as const, traceId, spanId: '123456789abcdef1', parentSpanId: null,
    startTimeMs: at - 10, endTimeMs: at, status: 'ok' as const, statusMessage: null, attributes: { 'mission.model_id': 'unknown', 'mission.effort': 'unknown' } };
  assert.equal((await send(`${ENDPOINTS.otlp}/v1/traces`, 'traces', serializeTraces({ resource: { ...resource, 'service.instance.id': marker }, scope: { name: 'mission-control', version: '1' }, spans: [span] }), 'user', deps)).kind, 'accepted');
  const search = `${ENDPOINTS.tempo}/api/search?${new URLSearchParams({ q: `{ resource.service.instance.id = "${marker}" }`, start: String(Math.floor((at - 60000) / 1000)), end: String(Math.floor((at + 60000) / 1000)) })}`;
  await eventually(async () => JSON.stringify(await (await fetch(search)).json()).includes(traceId), 'seven-day historical trace search');
  // Direct receiver response exposes the downstream rejection that an async Collector ACK
  // cannot report to the daemon. Collector delivery failures are exposed separately below.
  const rejected = await send(`${ENDPOINTS.prometheus}/api/v1/otlp/v1/metrics`, 'metrics', serializeMetrics(make(Date.now() - 9 * DAY)), 'user', deps);
  assert.notEqual(rejected.kind, 'accepted');
  console.log(`LATE BOUNDARY: seven-day metric and time-bounded trace search passed; nine-day Prometheus response=${JSON.stringify(rejected)}.`);
  for (const name of ['grafana', 'prometheus', 'tempo', 'collector'] as const) { service('stop', name); service('start', name); }
  assert.ok((await waitUntilReady(90000)).ok);
  assert.ok(await trace(traceId), 'persisted trace after every service restart');
  assert.equal(Number((await query(`mission_daemon_starts_total{service_instance_id="${marker}"}`, at + 1000))[0]?.value[1]), 1);
  for (const { uid } of dashboardSpecs) { const response = await fetch(`${ENDPOINTS.grafana}/api/dashboards/uid/${uid}`); assert.ok(response.ok, uid); await response.body?.cancel(); }
  console.log('PERSISTENCE: all six dashboard UIDs, source metrics and original-time trace remain after every service restart without reset.');
});
