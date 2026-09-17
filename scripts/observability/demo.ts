import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
// Never inherit an operator's configured home. Every invocation is a synthetic installation.
const home = mkdtempSync(join(tmpdir(), 'mission-observability-demo-'));
process.env.MISSION_HOME = home;
const { MODE, ENDPOINTS, waitUntilReady } = await import('../observability.mjs');
if (MODE === 'real') throw new Error('Demo refuses the real project. Set MC_OBSERVABILITY_MODE=demo or test.');
process.env.MISSION_TELEMETRY_ENVIRONMENT = MODE;
const { closeDb } = await import('../../src/server/db.ts');
const { seedDashboardFixture } = await import('../../test/helpers/dashboard-telemetry.ts');
const { runDeliveryPass } = await import('../../src/server/telemetry/delivery.ts');
const { telemetryHealth } = await import('../../src/server/telemetry/health.ts');
try {
  const ready = await waitUntilReady(30000);
  if (!ready.ok) throw new Error(`Start the ${MODE} stack first: ${ready.waiting.join(', ')}`);
  const started = performance.now();
  const fixture = await seedDashboardFixture(Date.now() - 60000, ENDPOINTS.otlp, true);
  const userHealth = () => telemetryHealth().profiles.find((p) => p.profile === 'user')!;
  let delivered = 0;
  for (let i = 0; i < 100; i++) {
    const pass = await runDeliveryPass(); delivered += pass.accepted;
    const health = userHealth();
    if (!health.pending && !health.retrying) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const health = userHealth();
  if (health.pending || health.retrying || health.rejected || health.expired) throw new Error('Demo outbox did not drain successfully');
  const output = { ...fixture, mode: MODE, delivered, elapsedMs: Math.round(performance.now() - started),
    dashboard: `${ENDPOINTS.dashboard}?var-environment=${MODE}&var-installation=${fixture.installation}` };
  const path = resolve('.evidence/observability', `${MODE}-fixture.json`);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(output, null, 2) + '\n');
  console.log(JSON.stringify(output, null, 2));
} finally { closeDb(); rmSync(home, { recursive: true, force: true }); }
