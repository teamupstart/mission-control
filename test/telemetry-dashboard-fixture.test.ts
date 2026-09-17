import { test, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const home = mkdtempSync(join(tmpdir(), 'mission-dashboard-fixture-'));
process.env.MISSION_HOME = home;
const { closeDb } = await import('../src/server/db.ts');
const { seedDashboardFixture } = await import('./helpers/dashboard-telemetry.ts');
after(() => { closeDb(); rmSync(home, { recursive: true, force: true }); });
test('six real workflow owners with fake runners produce the dashboard oracle', async () => {
  console.log(await seedDashboardFixture(Date.now(), 'http://127.0.0.1:34318'));
});
