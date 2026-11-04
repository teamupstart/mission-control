import { test, expect } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { realApplyOperations, runApplyUpdate } from '../../scripts/apply-update.mjs';
import { darwinCheckIdentity } from '../../scripts/darwin-process-identity.mjs';
import { UPDATE_HELPER_FILES } from '../../scripts/update-helper-files.mjs';
import { captureUpdateProcessOwners } from '../../scripts/update-process-owners.mjs';
import { processIdentity, processIsAlive } from '../../scripts/update-lock.mjs';
import { withDaemonDb } from '../fixtures/daemon-db.ts';
import { nativeUpdateProgress } from '../fixtures/native-update-progress.ts';

for (const legacy of [false, true]) test(legacy
  ? 'a legacy update without a migration handoff shows its blocker and closes progress after the wait'
  : 'the visible update progress identifies an owned blocking process and its work', async () => {
  test.skip(process.platform !== 'darwin', 'the helper displays a native macOS progress dialog');
  test.setTimeout(60_000);
  const root = mkdtempSync(join(tmpdir(), 'mc-update-blocker-progress-'));
  const bundle = join(root, 'Fixture.app');
  const executable = join(bundle, 'Contents/MacOS/background-work');
  mkdirSync(dirname(executable), {recursive: true});
  const blockerSource = join(root, 'blocker.c');
  writeFileSync(blockerSource, `#include <signal.h>
#include <stdio.h>
#include <unistd.h>
int main(void) {
  signal(SIGTERM, SIG_IGN);
  puts("ready");
  fflush(stdout);
  for (;;) pause();
}
`);
  execFileSync('/usr/bin/clang', [blockerSource, '-o', executable]);
  let createOperations = realApplyOperations;
  // Optional mutation proof: omit only the callback's progress update in a private helper
  // copy. The same visible-dialog assertion must fail, without editing production source.
  if (process.env.MC_E2E_UPDATE_PROGRESS_MUTATION === '1') {
    const helper = join(root, 'helper');
    for (const file of UPDATE_HELPER_FILES) {
      mkdirSync(dirname(join(helper, file)), {recursive: true});
      copyFileSync(file, join(helper, file));
    }
    const path = join(helper, 'scripts/apply-update.mjs');
    const source = readFileSync(path, 'utf8');
    const update = 'else progress(message);';
    expect(source.split(update)).toHaveLength(2);
    writeFileSync(path, source.replace(update, '/* progress update omitted by test mutation */'));
    createOperations = (await import(pathToFileURL(path).href)).realApplyOperations;
  }
  const progressWindow = nativeUpdateProgress(root);
  const ops = createOperations(join(root, 'update.log'));
  const blocker = spawn(executable, [], {detached: legacy, stdio: ['ignore', 'pipe', 'inherit']});
  const ready = once(blocker.stdout, 'data');
  const exited = once(blocker, 'exit');
  let closeProgress: (() => void) | undefined;
  let waiting: Promise<void> | undefined;
  try {
    await once(blocker, 'spawn');
    expect((await ready)[0].toString()).toBe('ready\n');
    const pid = blocker.pid!;
    const work = legacy ? 'workflow check test, attempt legacy-progress, run legacy-run, session sdk:legacy'
      : 'Mission Control fixture background task';
    if (legacy) {
      // The legacy helper has no snapshot handoff. Its real read-only lease reader
      // supplies ownership of this disposable process group during the shared wait.
      withDaemonDb({home: root}, db => {
        db.exec(`CREATE TABLE workflow_check_leases (attempt_id TEXT, submission_id TEXT, node_id TEXT,
          supervisor_pid INTEGER, supervisor_start_ticks TEXT, cleanup_state TEXT);
          CREATE TABLE workflow_submissions (id TEXT, run_id TEXT);
          CREATE TABLE workflow_runs (id TEXT, binding_id TEXT);
          CREATE TABLE workflow_bindings (id TEXT, session_id TEXT);
          INSERT INTO workflow_submissions VALUES ('legacy-sub', 'legacy-run');
          INSERT INTO workflow_runs VALUES ('legacy-run', 'legacy-binding');
          INSERT INTO workflow_bindings VALUES ('legacy-binding', 'sdk:legacy');`);
        db.prepare('INSERT INTO workflow_check_leases VALUES (?, ?, ?, ?, ?, ?)')
          .run('legacy-progress', 'legacy-sub', 'test', pid, darwinCheckIdentity(processIdentity(pid)), 'held');
      });
    } else {
      const parent = {pid: process.pid, identity: processIdentity(process.pid)};
      const owners = await captureUpdateProcessOwners({stateDirectory: root, parent,
        processNames: {[pid]: 'fixture background task'}});
      expect(owners.find(owner => owner.pid === pid)?.work).toBe(work);
      ops.setProcessOwners!(owners);
    }
    // The ready fixture ignores TERM so the real wait/progress path remains observable
    // until the helper's existing KILL escalation at ten seconds.
    let initialPid: number | undefined;
    if (!legacy) {
      closeProgress = ops.showProgress!('Waiting for Mission Control and its background work to close.');
      await expect.poll(() => progressWindow(process.pid), {timeout: 10_000}).not.toBeNull();
      const initial = progressWindow(process.pid)!;
      expect(initial.command).not.toContain(work);
      initialPid = initial.pid;
    } else expect(progressWindow(process.pid)).toBeNull();

    let settled = false;
    waiting = legacy ? runApplyUpdate({sourceClone: root, targetTag: 'v1.26.1', appPath: bundle,
      parentPid: process.pid, stateDirectory: root, logPath: join(root, 'update.log')}, {
      ...ops,
      // Exercise the retained legacy orchestration with its real wait, progress, lock
      // and outcome. This narrow fixture has no installable app or launch registration.
      preflight: async () => {}, waitForParent: async () => {}, exists: () => true,
      copy: () => {}, remove: () => {}, install: () => {}, prepareLaunch: async () => {},
      launch: () => {}, verifyLaunch: async () => {},
    }).then(result => { expect(result.ok).toBe(true); }) : ops.waitForBundle(bundle);
    void waiting.then(() => { settled = true; }, () => { settled = true; });
    await expect.poll(() => progressWindow(process.pid)?.command, {timeout: 8000})
      .toContain(`Waiting for background work to stop: ${pid} (`);
    const shown = progressWindow(process.pid)!;
    expect(shown.command).toContain(work);
    expect(shown.command).toContain(executable);
    if (initialPid) expect(shown.pid).not.toBe(initialPid);
    expect(settled, 'the specific message must be visible while the helper is still waiting').toBe(false);
    expect(processIsAlive(pid)).toBe(true);
    console.log('Blocker progress proof:', JSON.stringify({legacy, blockerPid: pid, work, waiting: !settled, progress: shown}));
    if (process.env.MC_E2E_EVIDENCE) {
      const directory = 'e2e/.artifacts/update-blocker-progress';
      mkdirSync(directory, {recursive: true});
      const windowId = shown.windows[0].kCGWindowNumber;
      expect(typeof windowId).toBe('number');
      execFileSync('/usr/sbin/screencapture', ['-x', '-o', '-l', String(windowId),
        join(directory, `${legacy ? 'legacy' : 'transaction'}-blocker.png`)]);
    }

    await expect.poll(() => settled, {timeout: 15_000}).toBe(true);
    await waiting;
    expect(await exited).toEqual([null, 'SIGKILL']);
    expect(processIsAlive(pid)).toBe(false);
    closeProgress?.();
    await expect.poll(() => progressWindow(process.pid)).toBeNull();
    console.log(`Verified: ${legacy ? 'legacy update without a migration handoff started' : 'transaction wait updated'} the visible native dialog with the owned blocker PID and work, then automatically reaped the blocker, closed progress and finished.`);
  } finally {
    closeProgress?.();
    blocker.kill('SIGKILL');
    await exited;
    await waiting?.catch(() => {});
    rmSync(root, {recursive: true, force: true});
  }
});
