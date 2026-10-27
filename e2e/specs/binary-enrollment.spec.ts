import childProcess from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { temporaryInstallLocation } from '../../scripts/binary-install-policy.mjs';
import { binaryEnrollmentChoice, BINARY_UPDATE_UNAVAILABLE } from '../../src/shared/binary-enrollment.ts';
import { expect, test } from '../fixtures/test.ts';

function mountedImage(bundle: string): boolean {
  // Feed native inventory responses into the same policy used before daemon
  // startup; do not arrange the temporary-location verdict in the bridge.
  const exec = childProcess.execFileSync;
  childProcess.execFileSync = ((command: string) => {
    if (command === '/usr/bin/hdiutil') return 'fixture plist';
    if (command === '/usr/bin/plutil') return JSON.stringify({images: [{'system-entities': [{'mount-point': dirname(bundle)}]}]});
    throw new Error(`Unexpected image inventory command: ${command}`);
  }) as typeof childProcess.execFileSync;
  syncBuiltinESMExports();
  try { return temporaryInstallLocation(bundle); }
  finally { childProcess.execFileSync = exec; syncBuiltinESMExports(); }
}

for (const kind of ['copied', 'mounted', 'custom-mounted', 'conflict'] as const) {
  test(`binary installation ${kind} presents the safe action and recovery route`, async ({dashboard}) => {
    const mounted = kind === 'mounted' || kind === 'custom-mounted';
    const bundle = kind === 'mounted' ? '/Volumes/Agent Mission Control/Agent Mission Control.app'
      : kind === 'custom-mounted' ? '/private/tmp/mission-custom-mount-ui-fixture/Agent Mission Control.app'
        : '/Users/operator/Applications/Agent Mission Control.app';
    const state = binaryEnrollmentChoice({
      bundle, home: '/Users/operator', managedPath: kind === 'conflict' ? '/Applications/Mission Control.app' : null,
      temporary: mounted && mountedImage(bundle),
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
    await panel.getByRole('link', {name: 'Signed installer and recovery instructions'}).focus();
    await expect(panel.getByRole('link', {name: 'Signed installer and recovery instructions'})).toHaveAccessibleDescription('Open signed installation and manual replacement instructions.');
    await expect(dashboard.locator('.tooltip')).toBeVisible();
    await expect(panel).toContainText(state.message);
    if (kind === 'conflict') {
      await expect(panel.getByRole('button', {name: 'Enroll this copied app'})).toHaveCount(0);
      expect(calls).toBe(0);
    } else {
      await panel.getByRole('button', {name: kind === 'copied' ? 'Enroll this copied app' : 'Install Mission Control'}).focus();
      await expect(panel.getByRole('button', {name: kind === 'copied' ? 'Enroll this copied app' : 'Install Mission Control'})).toHaveAccessibleDescription(kind === 'copied'
        ? 'Verify this copied app and record its current destination for managed installation.'
        : 'Install the verified app at the displayed persistent destination.');
      await expect(dashboard.locator('.tooltip')).toBeVisible();
      if (mounted) {
        await expect(panel.getByRole('button', {name: 'Enroll this copied app'})).toHaveCount(0);
        await expect(panel).toContainText('Destination: /Users/operator/Applications/Agent Mission Control.app');
      }
      if (process.env.MC_E2E_EVIDENCE === '1') {
        const dir = join(process.cwd(), 'e2e/.artifacts/binary-enrollment'); await mkdir(dir, {recursive: true});
        if (kind === 'copied') await dashboard.screenshot({path: join(dir, 'copied-tooltip.png'), fullPage: true});
        await dashboard.mouse.move(1, 1);
        await panel.getByRole('button', {name: kind === 'copied' ? 'Enroll this copied app' : 'Install Mission Control'}).blur();
        await dashboard.screenshot({path: join(dir, `${kind}.png`), fullPage: true});
      }
      await panel.getByRole('button', {name: kind === 'copied' ? 'Enroll this copied app' : 'Install Mission Control'}).click();
      await expect(panel.getByRole('status')).toContainText(kind === 'copied' ? 'now managed' : 'Installation started');
      expect(calls).toBe(1);
    }
  });
}
