import assert from 'node:assert/strict';
import test from 'node:test';
import type { App } from 'electron';
import { createMigrationIntegrationPorts } from '../src/main/migration-integration-ports.ts';
import { migrationPlanFixture } from './helpers/migration-plan.ts';

const receipt = {schema: 1, repo: 'teamupstart/mission-control', releaseTag: 'v1.2.3', installedVersion: '1.2.3', sourceClone: '/source', appPath: '/Applications/Mission Control.app', installedAt: '2026-09-15T00:00:00.000Z'};
const plan = migrationPlanFixture(receipt);
const executable = `${plan.target}/Contents/MacOS/Mission Control`;

for (const enabled of [false, true]) {
  test(`macOS removes the source login registration before preserving login ${enabled ? 'on' : 'off'}`, async () => {
    let source = true;
    let target = !enabled;
    const calls: string[] = [];
    const app = {
      getLoginItemSettings: () => ({openAtLogin: target, executableWillLaunchAtLogin: false}),
      setLoginItemSettings: ({openAtLogin}: {openAtLogin?: boolean}) => { assert.equal(source, false); target = Boolean(openAtLogin); calls.push(`target:${target}`); },
    } as Pick<App, 'getLoginItemSettings' | 'setLoginItemSettings'>;
    const ports = createMigrationIntegrationPorts(app, {executable, platform: 'darwin', sourceCleanup: async (received) => {
      assert.equal(received, plan);
      if (source) { source = false; calls.push('source:off'); }
    }});
    await ports.retargetLogin(plan, enabled);
    assert.equal(source, false);
    assert.equal(target, enabled);
    assert.deepEqual(calls, ['source:off', `target:${enabled}`]);
    await ports.retargetLogin(plan, enabled);
    assert.equal(calls.length, 2, 'a verified retry makes no login changes');
  });
}

test('source cleanup failure leaves target login untouched and remains retryable', async () => {
  let writes = 0;
  const app = {getLoginItemSettings: () => ({openAtLogin: false}), setLoginItemSettings: () => { writes++; }} as unknown as App;
  const ports = createMigrationIntegrationPorts(app, {executable, platform: 'darwin', sourceCleanup: async () => { throw new Error('source removal failed'); }});
  await assert.rejects(ports.retargetLogin(plan, true), /source removal failed/);
  assert.equal(writes, 0);
});

test('Windows verifies the executable field and login repair refuses a different running bundle', async () => {
  const app = {getLoginItemSettings: ({path}: {path?: string}) => ({openAtLogin: path === executable, executableWillLaunchAtLogin: false}), setLoginItemSettings: () => {}} as unknown as App;
  await assert.rejects(createMigrationIntegrationPorts(app, {executable, platform: 'win32'}).retargetLogin(plan, true), /could not be verified/);
  await assert.rejects(createMigrationIntegrationPorts(app, {executable: '/foreign', platform: 'darwin'}).retargetLogin(plan, true), /personal installation/);
});
