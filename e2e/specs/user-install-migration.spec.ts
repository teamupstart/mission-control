import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { UpdateSnapshot, UpdateMigration } from '../../src/shared/update.ts';
import { UPDATE_DIALOGS, type UpdateDialogRequest } from '../../src/shared/update-dialog.ts';
import { UpdateController } from '../../src/main/updater.ts';
import { repairMigrationIntegrations } from '../../src/main/migration-integrations.ts';
import { migrationPlanFixture } from '../../test/helpers/migration-plan.ts';
import { migrationBundleIdentity, prepareMigration } from '../../scripts/install-migration.mjs';
import { expectContentClearsBorder } from '../fixtures/modal-inset.ts';
import { expect, test } from '../fixtures/test.ts';

const migration: UpdateMigration = {source: '/Applications/Mission Control.app', target: '/Users/Fixture/Applications/Mission Control.app', status: 'offered', repairs: []};
const ready: UpdateSnapshot = {phase: 'ready', currentVersion: '1.17.0', newVersion: '1.17.1', releaseTag: 'v1.17.1', stagedAt: 1, lastOutcome: null, migration};

declare global {
  interface Window {
    migrationFixture: { push(snapshot: UpdateSnapshot): void; dialog(request: UpdateDialogRequest): void; actions: string[]; answers: string[] };
    retryMigrationInMain(): Promise<UpdateSnapshot>;
  }
}

async function bridge(page: Page, initial: UpdateSnapshot = ready): Promise<void> {
  await page.addInitScript((initial: UpdateSnapshot) => {
    let state = initial;
    const listeners = new Set<(state: UpdateSnapshot) => void>();
    const dialogs = new Set<(request: UpdateDialogRequest) => void>();
    const actions: string[] = [];
    const answers: string[] = [];
    const push = (next: UpdateSnapshot): void => {state = next; for (const listener of listeners) listener(next);};
    window.migrationFixture = {push, dialog: (request) => {for (const listener of dialogs) listener(request);}, actions, answers};
    Object.defineProperty(window, 'missionDesktop', {value: {
      isDesktop: true, onOpenSettings: () => () => {},
      updates: {
        getState: async () => state,
        onState: (listener: (state: UpdateSnapshot) => void) => {listeners.add(listener); return () => listeners.delete(listener);},
        onDialog: (listener: (request: UpdateDialogRequest) => void) => {dialogs.add(listener); return () => dialogs.delete(listener);},
        answerDialog: (_id: string, choice: string) => answers.push(choice),
        install: async () => {actions.push('install'); return true;},
        keepSystem: async () => {actions.push('system'); push({phase: 'error', currentVersion: '1.17.0', message: 'The installation change could not finish. Check the update log and try again.', manual: true, retryable: true, lastOutcome: null}); return false;},
        defer: async () => {actions.push('later'); push({phase: 'idle', currentVersion: '1.17.0', lastCheckedAt: null, lastOutcome: null});},
        repairMigration: async () => {actions.push('repair'); push({phase: 'idle', currentVersion: '1.17.1', lastCheckedAt: null, lastOutcome: null, migration: {...initial.migration!, status: 'complete', repairs: []}});},
      },
    }});
  }, initial);
  await page.reload();
}

async function capture(page: Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== '1') return;
  const folder = join(process.cwd(), 'e2e/.artifacts/user-install-migration');
  await mkdir(folder, {recursive: true});
  await page.screenshot({path: join(folder, name), fullPage: true});
}

test('the packaged migration policy offers the personal destination for an alpha update', async ({dashboard, daemon}) => {
  // Read the shipped gate: a canned migration snapshot would pass while packaging disabled it.
  const config = readFileSync(new URL('../../electron-builder.yml', import.meta.url), 'utf8');
  const metadata = config.match(/^  missionInstallMigration:\n((?: {4}[^\n]*\n)+)/m)?.[1] ?? '';
  const capability = {protocol: 1, automatic: /^ {4}automatic: true$/m.test(metadata)};
  const stateDirectory = realpathSync(daemon.home);
  const home = join(stateDirectory, 'migration-home');
  const systemDirectory = join(home, 'System Applications');
  const source = join(systemDirectory, 'Mission Control.app');
  const stagedBundle = join(home, 'staged.app');
  for (const [bundle, commit] of [[source, 'a'.repeat(40)], [stagedBundle, 'b'.repeat(40)]] as const) {
    await mkdir(join(bundle, 'Contents/Resources/app'), {recursive: true});
    await writeFile(join(bundle, 'Contents/Info.plist'), '<key>CFBundleShortVersionString</key><string>1.19.0</string>');
    await writeFile(join(bundle, 'Contents/Resources/app/package.json'), JSON.stringify({missionCommit: commit, missionInstallMigration: capability}));
  }
  const plan = prepareMigration({
    receipt: {schema: 1, repo: 'teamupstart/mission-control', releaseTag: null, installedVersion: '1.19.0', installedCommit: 'a'.repeat(40), sourceClone: join(stateDirectory, 'app-src'), appPath: source, installedAt: '2026-09-15T00:00:00.000Z'},
    stagedBundle, stagedRevision: migrationBundleIdentity(stagedBundle).revision!, stateDirectory, home, systemDirectory,
  });
  expect(plan, 'the packaged source must enable the real migration preflight').not.toBeNull();
  const offered: UpdateMigration = {source: plan!.source, target: plan!.target, status: 'offered', repairs: []};
  await bridge(dashboard, {...ready, alpha: true, newVersion: 'alpha bbbbbbb', releaseTag: 'b'.repeat(40), migration: offered});
  const banner = dashboard.getByRole('status', {name: 'Mission Control update'});
  await expect(banner).toContainText(offered.target);
  const request = {...UPDATE_DIALOGS.ready('alpha bbbbbbb', offered), id: 'enabled-alpha-migration'};
  await dashboard.evaluate((request) => window.migrationFixture.dialog(request), request);
  const modal = dashboard.getByRole('dialog', {name: 'Mission Control update'});
  await expect(modal).toContainText(offered.source);
  await expect(modal).toContainText(offered.target);
  await expectContentClearsBorder(modal);
  await capture(dashboard, 'enabled-alpha-migration.png');
  await modal.getByRole('button', {name: 'Install and restart', exact: true}).click();
  expect(await dashboard.evaluate(() => window.migrationFixture.answers)).toEqual(['confirm']);
});

test('migration names both paths, preserves Later, sends explicit acceptance, and displays policy-write failure', async ({dashboard, context, daemon}) => {
  await bridge(dashboard);
  const banner = dashboard.getByRole('status', {name: 'Mission Control update'});
  await expect(banner).toContainText(migration.source);
  await expect(banner).toContainText(migration.target);
  await expect(banner).toContainText('system copy is retained');
  await capture(dashboard, 'ready-banner.png');
  await banner.getByRole('button', {name: 'Later', exact: true}).click();
  await expect(banner).toBeHidden();
  expect(await dashboard.evaluate(() => window.migrationFixture.actions)).toEqual(['later']);
  await dashboard.evaluate((snapshot) => window.migrationFixture.push(snapshot), ready);
  await banner.getByRole('button', {name: 'Install and restart', exact: true}).click();
  expect(await dashboard.evaluate(() => window.migrationFixture.actions)).toEqual(['later', 'install']);
  await banner.getByRole('button', {name: 'Keep system installation', exact: true}).hover();
  await expect(dashboard.locator('.tooltip')).toHaveText('Keep installing updates in the shared system folder');
  await capture(dashboard, 'system-choice-tooltip.png');
  await banner.getByRole('button', {name: 'Keep system installation', exact: true}).click();
  await expect(banner).toContainText('The installation change could not finish. Check the update log and try again.');
  await capture(dashboard, 'safe-error-banner.png');
  const browser = await context.newPage();
  await browser.goto(daemon.baseURL);
  await expect(browser.getByRole('button', {name: 'Keep system installation'})).toHaveCount(0);
  await browser.close();
});

test('migration dialog keeps Escape and backdrop inert and carries the system choice', async ({dashboard}) => {
  await bridge(dashboard);
  const modal = dashboard.getByRole('dialog', {name: 'Mission Control update'});
  const request = {...UPDATE_DIALOGS.ready('1.17.1', migration), id: 'migration-choice'};
  await dashboard.evaluate((request) => window.migrationFixture.dialog(request), request);
  await expect(modal).toContainText(migration.target);
  await expectContentClearsBorder(modal);
  await capture(dashboard, 'ready-dialog.png');
  await dashboard.keyboard.press('Escape');
  await expect(modal).toBeHidden();
  await dashboard.evaluate((request) => window.migrationFixture.dialog(request), {...request, id: 'backdrop'});
  await expect(modal).toBeVisible();
  await dashboard.mouse.click(5, 5);
  await expect(modal).toBeHidden();
  await dashboard.evaluate((request) => window.migrationFixture.dialog(request), {...request, id: 'system'});
  await modal.getByRole('button', {name: 'Keep system installation', exact: true}).click();
  expect(await dashboard.evaluate(() => window.migrationFixture.answers)).toEqual(['dismiss', 'dismiss', 'system']);
  expect(await dashboard.evaluate(() => window.migrationFixture.actions)).toEqual([]);
});

test('committed installation distinguishes incomplete integration repair and targeted retry from completion', async ({dashboard}) => {
  await bridge(dashboard);
  await dashboard.evaluate((migration) => window.migrationFixture.push({phase: 'idle', currentVersion: '1.17.1', lastCheckedAt: null, lastOutcome: null, migration: {...migration, status: 'repair-required', repairs: [{id: 'login', message: 'Login startup could not be verified for the personal app.'}]}}), migration);
  const banner = dashboard.getByRole('status', {name: 'Mission Control update'});
  await expect(banner).toContainText('Personal installation committed; integrations need repair');
  await expect(banner).toContainText('Login startup could not be verified');
  await banner.getByRole('button', {name: 'Retry integration repair'}).hover();
  await expect(dashboard.locator('.tooltip')).toHaveText('Retry only the integrations that still need repair');
  await capture(dashboard, 'repair-retry-tooltip.png');
  await banner.getByRole('button', {name: 'Dismiss'}).hover();
  await expect(dashboard.locator('.tooltip')).toHaveText('Hide this installation result');
  await capture(dashboard, 'dismiss-result-tooltip.png');
  await dashboard.mouse.move(0, 0);
  await expect(dashboard.locator('.tooltip')).toBeHidden();
  await capture(dashboard, 'repair-required.png');
  await banner.getByRole('button', {name: 'Retry integration repair'}).click();
  await expect(banner).toContainText('Personal installation complete');
  await expect(banner).toContainText('Replace the old Dock shortcut');
  await expect(banner.getByRole('button', {name: 'Retry integration repair'})).toHaveCount(0);
  expect(await dashboard.evaluate(() => window.migrationFixture.actions)).toEqual(['repair']);
  await capture(dashboard, 'complete.png');
});

test('a failed repair followed by a successful retry shows completion from the main controller', async ({dashboard}) => {
  let attempts = 0;
  const unexpected = (): never => {throw new Error('This repair fixture must not check, build, or install an update');};
  const controller = new UpdateController({
    packaged: false, arch: 'arm64',
    readAlpha: () => false, writeAlpha: unexpected,
    currentVersion: () => '1.17.1',
    currentCommit: () => null,
    latestMainCommit: unexpected, installSnapshot: unexpected, runtime: unexpected,
    latestRelease: unexpected, stage: unexpected, stagedBundleIdentity: unexpected,
    readOutcome: unexpected, clearOutcome: unexpected, now: Date.now, random: () => 0,
    helperSource: unexpected, stateDirectory: unexpected, handoff: unexpected, requestQuit: unexpected,
    log: () => {},
    dialogs: {error: async () => {}, available: unexpected, upToDate: unexpected, preparing: unexpected, ready: unexpected, applying: unexpected, outcome: unexpected},
    migrationStatus: () => ({...migration, status: attempts >= 2 ? 'complete' : 'repair-required', repairs: []}),
    repairMigration: async () => {if (++attempts === 1) throw new Error('temporary fixture failure');},
  });
  try {
    await controller.start();
    await dashboard.exposeFunction('retryMigrationInMain', async () => {
      await controller.retryMigrationRepair();
      return controller.getSnapshot();
    });
    await bridge(dashboard);
    await dashboard.evaluate((snapshot) => {
      window.missionDesktop!.updates!.repairMigration = async () => {
        window.migrationFixture.push(await window.retryMigrationInMain());
      };
      window.migrationFixture.push(snapshot);
    }, controller.getSnapshot());
    const banner = dashboard.getByRole('status', {name: 'Mission Control update'});
    await banner.getByRole('button', {name: 'Retry integration repair'}).click();
    await expect.poll(() => controller.getSnapshot().phase).toBe('error');
    await banner.getByRole('button', {name: 'Retry integration repair'}).click();
    await expect(banner).toContainText('Personal installation complete');
    await expect(banner.getByRole('button', {name: 'Retry integration repair'})).toHaveCount(0);
    await capture(dashboard, 'repair-retry-complete.png');
  } finally {
    controller.stop();
  }
});

test('integration repair status displays safe guidance instead of private diagnostics', async ({dashboard, daemon}) => {
  const plan = migrationPlanFixture({schema: 1, repo: 'teamupstart/mission-control', releaseTag: 'v1.17.0', installedVersion: '1.17.0', sourceClone: daemon.home, appPath: migration.source, installedAt: '2026-09-15T00:00:00Z'});
  const repairs = await repairMigrationIntegrations({plan, owner: {pid: 1, identity: 'fixture'}, ownerRole: 'recovery', stage: 'receipt-committed', targetProcess: null, repairs: [], inventory: {schema: 3, hooks: [], mcp: [], login: false}}, {
    home: daemon.home,
    log: () => {},
    command: () => {throw new Error('No MCP registration was inventoried');},
    login: () => ({openAtLogin: false}),
    retargetLogin: async () => {},
    skills: async () => {throw new Error('EACCES /Users/Private/.config/credentials token=fixture-secret');},
  });
  await bridge(dashboard);
  await dashboard.evaluate((repairs) => window.migrationFixture.push({phase: 'idle', currentVersion: '1.17.1', lastCheckedAt: null, lastOutcome: null, migration: {source: '/Applications/Mission Control.app', target: '/Users/Fixture/Applications/Mission Control.app', status: 'repair-required', repairs}}), repairs.filter((item) => item.status === 'pending'));
  const banner = dashboard.getByRole('status', {name: 'Mission Control update'});
  await expect(banner).toContainText('Enabled skill links need attention in Settings > Skills. Resolve their conflicts, then retry.');
  await expect(banner).not.toContainText('/Users/Private');
  await expect(banner).not.toContainText('fixture-secret');
  await capture(dashboard, 'safe-repair-status.png');
});
