import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { binaryEnrollmentChoice, BINARY_UPDATE_UNAVAILABLE } from '../../src/shared/binary-enrollment.ts';
import { expect, test } from '../fixtures/test.ts';

for (const kind of ['copied', 'mounted', 'conflict'] as const) {
  test(`binary installation ${kind} presents the safe action and recovery route`, async ({dashboard}) => {
    const state = binaryEnrollmentChoice({
      bundle: kind === 'mounted' ? '/Volumes/Mission Control/Mission Control.app' : '/Users/operator/Applications/Mission Control.app',
      home: '/Users/operator', managedPath: kind === 'conflict' ? '/Applications/Mission Control.app' : null, temporary: kind === 'mounted',
    });
    let calls = 0;
    await dashboard.exposeFunction('beginBinaryInstallation', async () => {
      calls++;
      return {started: true, message: kind === 'copied' ? 'This copied app is now managed.' : 'Installation started at the persistent destination.'};
    });
    await dashboard.addInitScript(({state, reason}) => {
      const snapshot = {phase: 'disabled', reason, lastOutcome: null};
      Object.defineProperty(window, 'missionDesktop', {configurable: true, value: {
        isDesktop: true, version: async () => '1.2.3', onOpenSettings: () => () => {},
        binaryInstallation: {getState: async () => state, enroll: () => (window as unknown as {beginBinaryInstallation(): Promise<unknown>}).beginBinaryInstallation()},
        updates: {getState: async () => snapshot, setAlpha: async () => snapshot, check: async () => snapshot, onState: () => () => {}},
      }});
    }, {state, reason: BINARY_UPDATE_UNAVAILABLE});
    await dashboard.reload();
    await dashboard.getByRole('button', {name: 'Settings'}).click();
    await dashboard.getByRole('tab', {name: 'Setup'}).click();
    const panel = dashboard.getByRole('region', {name: 'Application updates'});
    await expect(panel).toContainText(BINARY_UPDATE_UNAVAILABLE);
    await expect(panel).not.toContainText('Updates are built while you work');
    await expect(panel.getByRole('button', {name: 'Check for updates'})).toBeDisabled();
    await expect(panel.getByRole('link', {name: 'Signed installer and recovery instructions'})).toHaveAttribute('href', /github.com\/teamupstart\/mission-control/);
    await expect(panel).toContainText(state.message);
    if (kind === 'conflict') {
      await expect(panel.getByRole('button', {name: 'Enroll this copied app'})).toHaveCount(0);
      expect(calls).toBe(0);
    } else {
      if (kind === 'mounted') {
        await expect(panel.getByRole('button', {name: 'Enroll this copied app'})).toHaveCount(0);
        await expect(panel).toContainText('Destination: /Users/operator/Applications/Mission Control.app');
      }
      if (process.env.MC_E2E_EVIDENCE === '1') {
        const dir = join(process.cwd(), 'e2e/.artifacts/binary-enrollment'); await mkdir(dir, {recursive: true});
        await dashboard.mouse.move(1, 1);
        await dashboard.screenshot({path: join(dir, `${kind}.png`), fullPage: true});
      }
      await panel.getByRole('button', {name: kind === 'copied' ? 'Enroll this copied app' : 'Install Mission Control'}).click();
      await expect(panel.getByRole('status')).toContainText(kind === 'copied' ? 'now managed' : 'Installation started');
      expect(calls).toBe(1);
    }
  });
}
