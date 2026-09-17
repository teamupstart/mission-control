import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dashboardSpecs, allPanels, makeDashboard } from '../scripts/observability/dashboards.ts';
import { TELEMETRY_METRICS } from '../src/shared/telemetry-catalog.ts';
test('six provisioned dashboards are generated from one bounded instrument and panel manifest', () => {
  execFileSync(process.execPath, ['--import', 'tsx', 'scripts/observability/generate.ts', '--check']);
  assert.equal(dashboardSpecs.length, 6);
  for (const spec of dashboardSpecs) {
    const dashboard = makeDashboard(spec);
    assert.equal(new Set(dashboard.panels.map((p) => p.id)).size, dashboard.panels.length);
    assert.equal(dashboard.links.length, 6);
    for (const panel of allPanels(spec)) {
      for (const source of panel.source) assert.ok(TELEMETRY_METRICS[source], source);
      assert.ok(panel.expr.includes('$environment') && panel.expr.includes('$installation'));
      assert.ok(!panel.expr.includes('or vector(0)'));
      assert.ok(!/rate\(mission_analytics|increase\(mission_analytics/.test(panel.expr));
    }
  }
  const config = readFileSync('observability/collector/config.yaml', 'utf8');
  assert.ok(!config.includes('processors: [memory_limiter, batch]'), 'no early-ACK memory buffer before durable queues');
});
