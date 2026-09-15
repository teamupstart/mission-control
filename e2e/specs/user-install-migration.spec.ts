import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { UpdateSnapshot, UpdateMigration } from '../../src/shared/update.ts';
import { UPDATE_DIALOGS, type UpdateDialogRequest } from '../../src/shared/update-dialog.ts';
import { expectContentClearsBorder } from '../fixtures/modal-inset.ts';
import { expect, test } from '../fixtures/test.ts';

const migration: UpdateMigration = {source: '/Applications/Mission Control.app', target: '/Users/Fixture/Applications/Mission Control.app', status: 'offered', repairs: []};
const ready: UpdateSnapshot = {phase: 'ready', currentVersion: '1.17.0', newVersion: '1.17.1', releaseTag: 'v1.17.1', stagedAt: 1, lastOutcome: null, migration};

declare global {
  interface Window {
    migrationFixture: { push(snapshot: UpdateSnapshot): void; dialog(request: UpdateDialogRequest): void; actions: string[]; answers: string[] };
  }
}

async function bridge(page: Page): Promise<void> {
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
  }, ready);
  await page.reload();
}

async function capture(page: Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== '1') return;
  const folder = join(process.cwd(), 'e2e/.artifacts/user-install-migration');
  await mkdir(folder, {recursive: true});
  await page.screenshot({path: join(folder, name), fullPage: true});
}

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
