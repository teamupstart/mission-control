import { readFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { expect, test } from '../fixtures/test.ts';
import { dashboardSpecs, allPanels } from '../../scripts/observability/dashboards.ts';
import { ENDPOINTS, MODE } from '../../scripts/observability.mjs';

test.skip(!process.env.MC_E2E_OBSERVABILITY, 'Requires MC_E2E_OBSERVABILITY=1 and MC_OBSERVABILITY_MODE=test with the real local test stack');
test.describe.configure({ mode: 'serial' });
let fixture: { installation: string; reviewTrace: string; errorTrace: string; now: number };
test.beforeAll(async () => {
  if (!process.env.MC_E2E_OBSERVABILITY) return;
  expect(MODE, 'browser tests must not write to the real-data project').toBe('test');
  execFileSync(process.execPath, ['--import', 'tsx', 'scripts/observability/demo.ts'], { env: process.env, timeout: 90000, stdio: 'pipe' });
  fixture = JSON.parse(readFileSync('.evidence/observability/test-fixture.json', 'utf8'));
  // Export ACK precedes the next 30-second coherence-rule evaluation. Wait for usable data,
  // otherwise the first dashboard can render a transient empty state and still pass.
  await expect.poll(async () => {
    const values = await Promise.all(dashboardSpecs.map(async (spec) => {
      const query = spec.panels[0]!.expr.replaceAll('$environment', 'test').replaceAll('$installation', fixture.installation)
        .replaceAll('$__range', '14d').replace(/\$(runs|reviews|tasks)_axis/g, 'all').replace(/\$(runs|reviews|tasks)_slice/g, 'all');
      const response = await fetch(`${ENDPOINTS.prometheus}/api/v1/query?${new URLSearchParams({ query })}`);
      const body = await response.json() as { status: string; data: { result: unknown[] } };
      return body.status === 'success' && body.data.result.length > 0;
    }));
    return values.every(Boolean);
  }, { timeout: 60000 }).toBe(true);
});
function url(uid: string, extra = '') {
  return `${ENDPOINTS.grafana}/d/${uid}?from=now-14d&to=now&var-environment=test&var-installation=${fixture.installation}${extra}`;
}
async function shot(page: import('@playwright/test').Page, name: string) {
  if (!process.env.MC_E2E_EVIDENCE) return;
  const root = 'e2e/.artifacts/telemetry-dashboards';
  mkdirSync(root, { recursive: true });
  await page.screenshot({ path: `${root}/${name}.png`, fullPage: false, animations: 'disabled' });
  console.log(`CAPTURED ${root}/${name}.png`);
}
for (const spec of dashboardSpecs) {
  test(`${spec.uid}: provisioned panels, live query values and navigation`, async ({ page }) => {
    test.setTimeout(180000);
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.goto(url(spec.uid));
    await expect(page.getByText(`Mission Control: ${spec.title}`, { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Scope and interpretation', { exact: true })).toBeVisible();
    for (const p of allPanels(spec)) {
      const section = page.locator('section').filter({ has: page.getByRole('heading', { name: p.title, exact: true }) });
      // Grafana lazily mounts panels. Scrolling the page in steps materializes each row.
      for (let n = 0; n < 16 && !(await section.count()); n++) await page.mouse.wheel(0, 550);
      await section.scrollIntoViewIfNeeded();
      await expect(section).toBeVisible();
      if (p.expected !== undefined) {
        const display = p.unit === 'percentunit' ? `${(p.expected * 100).toFixed(2)}%` : String(p.expected);
        await expect(section.getByText(display, { exact: true })).toBeVisible({ timeout: 60000 });
      }
      await expect(section.getByText('Query error', { exact: true })).toHaveCount(0);
    }
    await page.goto(url(spec.uid));
    await expect(page.getByRole('heading', { name: spec.panels[0]!.title, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
    await shot(page, spec.uid);
    const next = dashboardSpecs[(dashboardSpecs.indexOf(spec) + 1) % dashboardSpecs.length]!;
    await page.getByRole('link', { name: next.title, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(next.uid));
    await expect(page).toHaveURL(new RegExp(`var-installation=${fixture.installation}`));
  });
}
test('supported filters, explicit zero, incomplete, empty and stale states', async ({ page }) => {
  await page.goto(url('mission-workflows', '&viewPanel=6'));
  await expect(page.locator('section').filter({ hasText: 'Unknown runs' }).getByText('0', { exact: true })).toBeVisible();
  const coverage = allPanels(dashboardSpecs[1]!).findIndex((p) => p.title === 'Observation coverage') + 2;
  await page.goto(url('mission-workflows', `&viewPanel=${coverage}`));
  await expect(page.getByText('Incomplete', { exact: true })).toBeVisible();
  await shot(page, 'incomplete');
  await page.goto(url('mission-workflows', '&viewPanel=2&var-runs_axis=workflow&var-runs_slice=custom'));
  await expect(page.locator('section').filter({ hasText: 'Eligible runs' }).getByText('6', { exact: true })).toBeVisible();
  await page.goto(url('mission-workflows', '&viewPanel=2&var-runs_axis=workflow&var-runs_slice=builtin'));
  await expect(page.getByText('Absent / stale / partial', { exact: true })).toBeVisible();
  await page.goto(url('mission-personas', '&viewPanel=2&var-reviews_axis=reviewer_model&var-reviews_slice=unknown'));
  await expect(page.locator('section').filter({ hasText: 'Executed reviews' }).getByText('0', { exact: true })).toBeVisible();
  await page.goto(url('mission-workflows').replace('var-environment=test', 'var-environment=local') + '&viewPanel=2');
  await expect(page.getByText('Absent / stale / partial', { exact: true })).toBeVisible();
  await shot(page, 'empty-environment');
  const future = fixture.now + 3 * 3600000;
  await page.goto(url('mission-workflows', '&viewPanel=2').replace('to=now', `to=${future}`));
  await expect(page.getByText('Absent / stale / partial', { exact: true })).toBeVisible();
  await shot(page, 'stale');
});
test('historical failing review and error open their actual event-time traces', async ({ page }) => {
  test.setTimeout(180000);
  await page.setViewportSize({ width: 1440, height: 1100 });
  for (const [uid, id, name] of [['mission-personas', fixture.reviewTrace, 'mission.workflow.review.finished'], ['mission-reliability', fixture.errorTrace, 'mission.error.occurrence']]) {
    expect(id).toBeTruthy();
    await page.goto(url(uid!, '&viewPanel=900'));
    const row = page.getByRole('row').filter({ hasText: id! });
    await expect(row).toBeVisible({ timeout: 90000 });
    // A workflow trace contains review, stage and repair spans; its displayed root name
    // need not be the span matched by TraceQL. Assert that span after opening the trace.
    await shot(page, `${uid}-trace-search`);
    await row.getByRole('link', { name: id!, exact: true }).click();
    await expect(page.getByText(id!, { exact: true }).first()).toBeVisible({ timeout: 60000 });
    await expect(page.getByText(name!, { exact: true }).first()).toBeVisible();
    await page.getByText(name!, { exact: true }).first().scrollIntoViewIfNeeded();
    await shot(page, `${uid}-trace-detail`);
  }
});
