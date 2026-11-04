import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '../fixtures/test.ts';
import { updateWorkflowApp } from '../fixtures/update-workflow-app.ts';
import { nativeDialogWindows } from '../fixtures/native-update-progress.ts';
import { prepareInPlaceInstall } from '../../scripts/install-migration.mjs';
import { prepareStagedInstall } from '../../scripts/install-staged-app.mjs';
import { processIdentity } from '../../scripts/update-lock.mjs';

test('failed migrated startup renders native recovery guidance', async ({daemon}) => {
  test.skip(process.platform !== 'darwin', 'native Electron recovery dialog');
  test.setTimeout(120_000);
  const fixture = await updateWorkflowApp(daemon);
  const windows = nativeDialogWindows(fixture.root);
  const state = realpathSync(daemon.home);
  const receipt = JSON.parse(readFileSync(join(state, 'install-receipt.json'), 'utf8'));
  const candidate = join(fixture.root, 'payload/Agent Mission Control.app');
  const descriptor = prepareStagedInstall({bundle: candidate, receipt: {...receipt,
    releaseTag: 'v1.26.1', installedVersion: '1.26.1', installedCommit: 'b'.repeat(40)}});
  const plan = prepareInPlaceInstall({descriptor, stateDirectory: state});
  // Both fixture bundles have identical runtime code; these are the files changed
  // by the candidate's release identity. Seed a consistent completed transaction.
  for (const file of ['Contents/Resources/app/package.json', 'Contents/Info.plist']) {
    copyFileSync(join(candidate, file), join(fixture.installed, file));
  }
  writeFileSync(join(state, 'install-receipt.json'), JSON.stringify(plan.intendedReceipt));
  writeFileSync(join(state, 'install-migration.json'), JSON.stringify({plan,
    owner: {pid: 1, identity: 'finished fixture migration'}, ownerRole: 'recovery', stage: 'complete',
    repairs: [], inventory: null, targetProcess: null}));
  // The same incompatible daemon response as the main-entry test, through actual
  // loopback HTTP. The production main entry owns the failure and native dialog.
  const health = createServer((_request, response) => {
    response.writeHead(200, {'content-type': 'application/json'});
    response.end(JSON.stringify({service: 'mission-control', capabilities: []}));
  });
  await new Promise<void>(resolve => health.listen(Number(new URL(daemon.baseURL).port), '127.0.0.1', resolve));
  let owner: {pid: number; identity: string | null} | undefined;
  try {
    execFileSync('/usr/bin/open', ['-n', fixture.installed, '--stdout', join(fixture.root, 'recovery.stdout'),
      '--stderr', join(fixture.root, 'recovery.stderr')]);
    await expect.poll(() => existsSync(join(fixture.root, 'launches.jsonl'))).toBe(true);
    const launch = JSON.parse(readFileSync(join(fixture.root, 'launches.jsonl'), 'utf8').trim().split('\n')[0]!);
    owner = {pid: launch.pid, identity: processIdentity(launch.pid)};
    const errorPath = join(fixture.root, 'native-errors.jsonl');
    await expect.poll(() => existsSync(errorPath), {timeout: 30_000}).toBe(true);
    const error = JSON.parse(readFileSync(errorPath, 'utf8').trim().split('\n')[0]!);
    expect(error.title).toBe('Personal installation needs recovery');
    expect(error.content).toContain('The personal installation committed, but its runtime could not start.');
    expect(error.content).toContain('Stop any older background daemon, then reopen the personal app.');
    await expect.poll(() => windows(owner!.pid).some(window => window.kCGWindowAlpha === 1)).toBe(true);
    const shown = windows(owner.pid).find(window => window.kCGWindowAlpha === 1)!;
    expect(readFileSync(join(fixture.root, 'recovery.stderr'), 'utf8')).toContain('running Mission Control daemon is from an older build');
    console.log('Native recovery guidance:', JSON.stringify({pid: owner.pid, ...error, window: shown}));
    if (process.env.MC_E2E_EVIDENCE) {
      const directory = 'e2e/.artifacts/update-recovery-guidance';
      mkdirSync(directory, {recursive: true});
      execFileSync('/usr/sbin/screencapture', ['-x', '-o', '-l', String(shown.kCGWindowNumber),
        join(directory, 'failed-migration.png')]);
    }
  } finally {
    if (owner?.identity && processIdentity(owner.pid) === owner.identity) process.kill(owner.pid, 'SIGKILL');
    await new Promise<void>((resolve, reject) => health.close(error => error ? reject(error) : resolve()));
  }
});
