/** Reproducible local capture measurement, not a production performance guarantee. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
const home = mkdtempSync(join(tmpdir(), 'mission-observability-bench-'));
process.env.MISSION_HOME = home;
process.env.MISSION_TELEMETRY_ENVIRONMENT = 'test';
const { closeDb } = await import('../../src/server/db.ts');
const { observeSessionOperation } = await import('../../src/server/telemetry/sessions.ts');
const { captureTelemetry } = await import('../../src/server/telemetry/capture.ts');
const { setTelemetryConfig } = await import('../../src/server/telemetry/config.ts');
const { DAEMON_STARTED_EVENT } = await import('../../src/shared/telemetry-catalog.ts');
const { registerBuiltinTelemetry } = await import('../../src/server/telemetry/service.ts');
const { runProjectionPass } = await import('../../src/server/telemetry/projection.ts');
const { telemetryHealth } = await import('../../src/server/telemetry/health.ts');
const count = 1000;
function workload(prefix: string) {
  const samples: number[] = [];
  for (let i = 0; i < count; i++) {
    const at = performance.now();
    captureTelemetry({ event: DAEMON_STARTED_EVENT, source: { kind: 'mission.benchmark', id: `${prefix}-${i}`, revision: 1 },
      facts: { launch_mode: 'daemon', startup_ms: 100, schema_upgraded: false } });
    samples.push(performance.now() - at);
  }
  samples.sort((a, b) => a - b);
  return { p50ms: samples[500], p95ms: samples[950], p99ms: samples[990] };
}
async function paced(enabled: boolean) {
  setTelemetryConfig({ enabled });
  const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
  const latencies: number[] = [];
  const before = process.memoryUsage().rss;
  const begin = performance.now();
  const tick = (i: number) => {
    const at = performance.now();
    const result = observeSessionOperation({ session: { id: `bench-${i % 20}`, agent: 'claude', runtime: 'sdk', agentSessionId: null },
      operation: 'send', outcome: 'delivered', operationId: `paced-${enabled}-${i}`,
      actor: { kind: 'human', origin: 'dashboard', basis: 'app_context' } });
    assert.equal(result.kind, enabled ? 'accepted' : 'disabled');
    latencies.push(performance.now() - at);
  };
  for (let i = 0; i < 100; i++) { tick(i); await new Promise((r) => setTimeout(r, 100)); }
  for (let i = 100; i < 200; i++) tick(i);
  for (let i = 0; i < 64; i++) if (runProjectionPass().consumed < 256) break;
  await new Promise((r) => setTimeout(r, 20)); loop.disable();
  latencies.sort((a, b) => a - b);
  globalThis.gc?.();
  return { ownerP95ms: latencies[190], eventLoopP95ms: loop.percentile(95) / 1e6,
    eventLoopP99ms: loop.percentile(99) / 1e6, rssDeltaMiB: (process.memoryUsage().rss - before) / 1048576,
    elapsedMs: performance.now() - begin };
}
try {
  registerBuiltinTelemetry();
  const pacedOff = await paced(false), pacedOn = await paced(true);
  console.log(JSON.stringify({ workload: '20 synthetic session contexts; 10 owner events/s for 10s followed by 100-event burst and projection', pacedOff, pacedOn }, null, 2));
  setTelemetryConfig({ enabled: false });
  const off = workload('off');
  setTelemetryConfig({ enabled: true });
  // Warm schema and caches before measuring steady capture overhead.
  captureTelemetry({ event: DAEMON_STARTED_EVENT, source: { kind: 'mission.benchmark', id: 'warm', revision: 1 }, facts: { launch_mode: 'daemon', startup_ms: 100, schema_upgraded: false } });
  const rssBefore = process.memoryUsage().rss;
  const delay = monitorEventLoopDelay({ resolution: 10 }); delay.enable();
  await new Promise((r) => setTimeout(r, 20));
  const on = workload('on');
  const projectedAt = performance.now();
  for (let i = 0; i < 64; i++) if (runProjectionPass().consumed < 256) break;
  const projectionMs = performance.now() - projectedAt;
  await new Promise((r) => setTimeout(r, 20)); delay.disable();
  const health = telemetryHealth();
  console.log(JSON.stringify({ workload: `${count} synchronous captures, collection off vs local-only on; no model/network calls`, off, on,
    additionalP95ms: on.p95ms! - off.p95ms!, rssDeltaMiB: (process.memoryUsage().rss - rssBefore) / 1048576,
    projectionMs, eventLoopP95ms: delay.percentile(95) / 1e6, eventLoopP99ms: delay.percentile(99) / 1e6,
    logicalBytes: health.usedBytes, sqliteBytes: statSync(join(home, 'harness.db')).size,
    walBytes: statSync(join(home, 'harness.db-wal')).size,
    note: 'Synchronous 1000-event burst intentionally measures blocking worst case; not a sustained 10 events/s or 20-agent benchmark.' }, null, 2));
} finally { closeDb(); rmSync(home, { recursive: true, force: true }); }
