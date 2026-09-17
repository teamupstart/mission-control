/** Isolated synthetic workload. Owners, reducers and exporters are real; model calls are fake. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { SpanDto } from '../../src/server/telemetry/projection.ts';
import type { LlmRunner, LlmRunnerId } from '../../src/shared/llm.ts';
import type { PublishedWorkflowGraph } from '../../src/shared/workflow.ts';
import { seedTelemetryWorkflow, runWorkflowGoldenFixture, goldenWorkflowGraph } from './workflow-telemetry.ts';
import { WorkflowEngine } from '../../src/server/workflows/engine.ts';
import { recordWorkflowAction } from '../../src/server/telemetry/workflow-actions.ts';
import { registerBuiltinTelemetry } from '../../src/server/telemetry/service.ts';
import { setTelemetryConfig, getTelemetryConfig } from '../../src/server/telemetry/config.ts';
import { runDeliveryPass } from '../../src/server/telemetry/delivery.ts';
import { runProjectionPass } from '../../src/server/telemetry/projection.ts';
import { resourceAttributes } from '../../src/server/telemetry/capture.ts';
import { captureTelemetryHealth } from '../../src/server/telemetry/health.ts';
import { listSeries } from '../../src/server/telemetry/store.ts';
import { retainPrObservation, recordTelemetryPrMerges } from '../../src/server/telemetry/pr-observations.ts';
import { openDb } from '../../src/server/db.ts';
import { runPrimaryOwnerFixture } from './primary-telemetry.ts';
import { recordSafeError, recordAutomationTransition } from '../../src/server/telemetry/experience.ts';
import { attachSessionTelemetry, observeEffortSelected, observeUsageRecorded, observeDispatchFinished } from '../../src/server/telemetry/sessions.ts';
import { Registry } from '../../src/server/registry.ts';

export const DAY = 86_400_000;
export const DASHBOARD_ORACLE = { 'runs.eligible': 6, 'runs.completed': 4, 'runs.pending': 1, 'runs.cancelled': 1,
  'runs.with_recovery': 1, 'runs.human_free': 1, 'runs.automation_eligible': 5, 'runs.ambiguous_actor': 1,
  'reviews.executed': 8, 'reviews.fail': 2, 'reviews.pass': 6, 'reviews.invalid': 1, 'reviews.reused': 1 };
function singleGraph(): PublishedWorkflowGraph {
  const graph = structuredClone(goldenWorkflowGraph);
  graph.nodes = graph.nodes.filter((n) => n.id !== 'p2' && n.id !== 'join');
  graph.edges = [
    { id: 'start', source: 'session', sourcePort: 'submitted', target: 'p1', targetPort: 'activate' },
    { id: 'pass', source: 'p1', sourcePort: 'pass', target: 'end', targetPort: 'terminal' },
    { id: 'fail', source: 'p1', sourcePort: 'fail', target: 'session', targetPort: 'return_for_changes' },
  ];
  return graph;
}
async function settle(check: () => boolean) {
  const deadline = performance.now() + 10000;
  while (!check()) {
    assert.ok(performance.now() < deadline, 'fake workflow must settle');
    await new Promise((r) => setTimeout(r, 10));
  }
}
export async function seedDashboardFixture(now: number, endpoint: string, exportHistory = false) {
  registerBuiltinTelemetry();
  assert.ok(setTelemetryConfig({ enabled: true, user: { enabled: true, endpoint } }, now - 15 * DAY).ok);
  assert.equal(getTelemetryConfig().product.enabled, false);
  const originalNow = Date.now;
  let start = now - 7.5 * DAY;
  const wall = performance.now();
  Date.now = () => start + Math.floor(performance.now() - wall);
  const repo = mkdtempSync(join(tmpdir(), 'mission-dashboard-repo-'));
  const exportedSpans: SpanDto[] = [];
  const rememberSpans = () => {
    for (const row of openDb().prepare("SELECT payload_json FROM telemetry_batches WHERE profile='user' AND signal='traces'").all())
      exportedSpans.push(...JSON.parse(String(row.payload_json)).spans);
  };
  let detach: (() => void) | undefined;
  try {
    await runWorkflowGoldenFixture('dashboard-R1');
    for (let r = 2; r <= 6; r++) {
      const { store, run, submission } = seedTelemetryWorkflow(`dashboard-R${r}`, r === 2 ? goldenWorkflowGraph : singleGraph(), r === 5 ? 'preview' : 'live');
      if ([3, 5, 6].includes(r)) store.setRunState(run.id, 'waiting_for_session', 'persona_feedback');
      if (r === 3) continue;
      if (r === 5 || r === 6) {
        recordWorkflowAction({ action: 'workflow.resubmit', before: store.getRun(run.id), automaticResumption: r !== 5,
          operationId: `decision-R${r}`, context: { operationId: `decision-R${r}`, surface: 'runs',
            actor: { kind: r === 6 ? 'unknown' : 'human', origin: 'dashboard', basis: r === 6 ? 'unknown' : 'app_context' } },
          outcome: 'applied', startedAt: Date.now(), now: Date.now() });
        store.setRunState(run.id, 'running', 'persona_review');
      }
      const runner = (id: LlmRunnerId): LlmRunner => ({ id, label: id, runInThread: null,
        structuredOutput: null, sandbox: null, price: () => null, litter: null, killLiveRuns() {},
        async run() {
          return JSON.stringify(r === 4 ? { verdict: 'fail', summary: 'synthetic', confidence: 1,
            requestedChanges: [{ title: 'synthetic', rationale: 'synthetic', basis: 'substantive', category: 'correctness', evidence: [{ kind: 'goal', quote: 'synthetic' }] }] }
            : { verdict: 'pass', summary: 'synthetic', approvalDetails: { reason: 'met', evidence: [] }, confidence: 1 });
        } });
      const engine = new WorkflowEngine(store, () => {}, { runnerFor: runner,
        resolveExecution: (p) => ({ runner: { id: p.runner ?? 'claude', source: 'config', unknown: null }, model: { id: 'claude-sonnet-4-6', source: 'config' } }) });
      try {
        engine.start(); engine.activateSubmission(submission.id);
        await settle(() => store.getRun(run.id)?.status === (r === 4 ? 'waiting_for_session' : 'completed'));
        if (r === 4) {
          const before = store.getRun(run.id);
          store.cancelRun(run.id, 'synthetic termination');
          recordWorkflowAction({ action: 'workflow.cancel', before, operationId: 'cancel-R4',
            context: { operationId: 'cancel-R4', surface: 'runs', actor: { kind: 'human', origin: 'dashboard', basis: 'app_context' } },
            outcome: 'applied', startedAt: Date.now(), now: Date.now() });
        }
      } finally { await engine.stop(); }
    }
    // Real primary-action routes and canonical Registry observations, not chart-value seeding.
    execFileSync('git', ['init', '-q', repo]);
    writeFileSync(join(repo, 'README.md'), 'Synthetic dashboard fixture\n');
    const registry = new Registry();
    detach = attachSessionTelemetry(registry);
    const session = registry.registerSdkSession({ id: 'sdk:dashboard-model', agent: 'claude', name: 'synthetic', cwd: repo, gitBranch: null, now: Date.now() });
    observeEffortSelected({ session, requested: 'high', outcome: 'accepted', actor: { kind: 'human', origin: 'dashboard', basis: 'app_context' }, applies: 'next_turn', now: Date.now() });
    const owners = await runPrimaryOwnerFixture(repo);
    const detachTasks = attachSessionTelemetry(owners.registry);
    const task = owners.tasks.list().find((t) => t.kind === 'ship')!;
    observeDispatchFinished({ taskId: task.id, sessionId: session.id, agent: 'claude', runtime: 'sdk', taskKind: 'ship', resolvedModel: 'claude-sonnet-4-6', resolvedEffort: 'high', resolutionSource: 'task', repoCount: 2, outcome: 'launched' });
    await owners.tasks.complete(task.id, 'synthetic completed');
    detachTasks();
    const pr = 'https://github.com/fixture/dashboard-only/pull/1';
    assert.ok(retainPrObservation({ taskId: task.id, taskKind: 'ship', repoRoot: repo, primaryRepoRoot: repo,
      prUrl: pr, sessionId: session.id, creationVerified: true, now: Date.now() }).retained);
    recordSafeError({ component: 'provider', family: 'provider', code: 'timeout', retryable: 'yes', handled: true, fingerprint: 'unknown', suppressed: 0 }, new Error('PRIVATE_SENTINEL'));
    recordAutomationTransition('synthetic', { feature: 'foreman', action: 'answer', outcome: 'applied', coverage: 'owner_transition' }, { kind: 'foreman', origin: 'daemon', basis: 'owner' });
    // Export historical activity while the synthetic clock is still in that period. This
    // models online history followed by cohort maturation, not an unsupported >7-day outbox.
    for (let i = 0; i < 64; i++) if (runProjectionPass(Date.now()).consumed < 256) break;
    rememberSpans();
    if (exportHistory) for (let i = 0; i < 20; i++) {
      const pass = await runDeliveryPass({ now: Date.now });
      if (!pass.sent) break;
    }
    // Second-window use establishes repeat use through the same real owner routes.
    start = now - DAY;
    recordWorkflowAction({ action: 'workflow.resubmit', before: null, operationId: 'repeat-use',
      context: { operationId: 'repeat-use', surface: 'runs', actor: { kind: 'human', origin: 'dashboard', basis: 'app_context' } },
      outcome: 'applied', startedAt: Date.now(), now: Date.now() });
    // usage is the actual canonical usage observer; values are synthetic inputs, not gauges.
    observeUsageRecorded({ identity: 'dashboard-usage', taskId: task.id, usageOrigin: 'authoring', costBasis: 'api-equivalent', reasoningOutput: 0, cacheRead: 0, cacheWrite: 0, sessionId: session.id, agent: 'claude', modelId: 'claude-sonnet-4-6',
      input: 1200, output: 400, costUsd: .02 });
    start = now - DAY / 4;
    recordTelemetryPrMerges(new Map([[pr, Date.now()]]), () => false, Date.now());
    runProjectionPass(Date.now());
    rememberSpans();
    if (exportHistory) await runDeliveryPass({ now: Date.now });
  } finally { Date.now = originalNow; detach?.(); rmSync(repo, { recursive: true, force: true }); }
  captureTelemetryHealth(now);
  // Drain all source pages before producing a coherent analytical snapshot.
  for (let i = 0; i < 64; i++) if (runProjectionPass(now).consumed < 256) break;
  const series = listSeries(openDb(), 'user');
  for (const [key, value] of Object.entries(DASHBOARD_ORACLE)) {
    assert.equal(series.find((s) => s.instrument === `mission.analytics.v1.${key}` && s.dimensions.slice_by === 'all')?.value, value, key);
  }
  const traceRows = openDb().prepare("SELECT payload_json FROM telemetry_batches WHERE profile='user' AND signal='traces'").all();
  const spans: SpanDto[] = [...exportedSpans, ...traceRows.flatMap((r) => JSON.parse(String(r.payload_json)).spans)];
  assert.ok(spans.length > 0);
  return { installation: resourceAttributes()['service.instance.id'], now, oracle: DASHBOARD_ORACLE,
    reviewTrace: spans.find((s) => s.name === 'mission.workflow.review.finished' && s.attributes['mission.verdict'] === 'fail')?.traceId,
    errorTrace: spans.find((s) => s.name === 'mission.error.occurrence')?.traceId,
    spanCount: new Set(spans.map((s) => s.spanId)).size };
}
