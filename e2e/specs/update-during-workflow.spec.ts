import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, type Browser, type Page } from 'playwright';
import { test, expect } from '../fixtures/test.ts';
import { updateWorkflowApp } from '../fixtures/update-workflow-app.ts';
import { withDaemonDb } from '../fixtures/daemon-db.ts';
import { expectContentClearsBorder } from '../fixtures/modal-inset.ts';
import { processIdentity, processIsAlive } from '../../scripts/update-lock.mjs';
import { processStartIdentity } from '../../src/server/workflows/check-identity.ts';
import { readMigrationJournal } from '../../scripts/install-migration.mjs';
import { parseAppProcesses, realMacAppOps } from '../../scripts/mac-app-lifecycle.mjs';
import { readCheckProcessOwners } from '../../scripts/update-process-owners.mjs';
import { nativeUpdateProgress } from '../fixtures/native-update-progress.ts';

type Owner = { pid: number; identity: string | null };
type CheckLease = { attempt_id: string; supervisor_pid: number; supervisor_identity: string };

// Production renderer -> preload -> updater -> detached helper -> production quit ->
// workflow interruption/lease return -> bundle replacement -> new desktop.
for (const reopenDuringUpdate of [false, true]) test(
  reopenDuringUpdate ? 'opening the app during an active update reveals progress and does not delay the replacement' :
    'accepting an in-app update with a live workflow check and orphaned utility installs and relaunches the new build', async ({ daemon }) => {
  test.skip(process.platform !== 'darwin', 'the in-place desktop update uses macOS LaunchServices');
  test.setTimeout(360_000);
  const fixture = await updateWorkflowApp(daemon);
  const evidence = 'e2e/.artifacts/update-during-workflow';
  mkdirSync(evidence, { recursive: true });
  const label = `${fixture.baseline ? 'baseline' : 'fixed'}${reopenDuringUpdate ? '-reopen' : ''}`;
  const progressWindow = reopenDuringUpdate ? nativeUpdateProgress(fixture.root) : null;
  const browsers: Browser[] = [];
  const owned: Owner[] = [];
  let checkPid = 0;
  let checkIdentity = '';
  let orphanPid = 0;
  let paused: Owner | null = null;
  let pausedHelper: Owner | null = null;
  let progressHelperPid = 0;
  let reopenedProgressPid = 0;
  const remember = (pid: number): Owner => {
    const record = { pid, identity: processIdentity(pid) };
    owned.push(record);
    return record;
  };
  const resume = () => {
    if (paused?.identity && processIdentity(paused.pid) === paused.identity) {
      try { process.kill(paused.pid, 'SIGCONT'); } catch { /* Already exited. */ }
    }
    paused = null;
  };
  const api = async (path: string, body?: unknown, method?: string) => {
    const response = await fetch(`${daemon.baseURL}${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(response.ok, `${path}: ${response.status} ${await response.clone().text()}`).toBe(true);
    return response.json();
  };
  const connect = async (): Promise<Page> => {
    let browser: Browser | undefined;
    await expect.poll(async () => {
      try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${fixture.cdpPort}`, { timeout: 1000 });
        return true;
      } catch { return false; }
    }, { timeout: 90_000 }).toBe(true);
    browsers.push(browser!);
    const context = browser!.contexts()[0]!;
    await expect.poll(() => context.pages().length).toBeGreaterThan(0);
    const page = context.pages()[0]!;
    await expect(page.getByRole('button', { name: 'Dispatch' }).first()).toBeVisible({ timeout: 60_000 });
    return page;
  };
  const parentPid = (pid: number) => Number(execFileSync('/bin/ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
  try {
    execFileSync('/usr/bin/open', ['-n', fixture.installed,
      '--stdout', join(fixture.root, 'main.stdout'), '--stderr', join(fixture.root, 'main.stderr')]);
    const dashboard = await connect();
    const health = await api('/api/health');
    const daemonOwner = remember(health.pid);
    // The daemon was started by the packaged shell, never adopted from the test fixture.
    const initialMain = parentPid(health.pid);
    remember(initialMain);
    if (!reopenDuringUpdate) {
      const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
      const previousDesktop = spawn(join(fixture.installed, 'Contents/MacOS/Mission Control'), ['--fixture-orphan-host'], {env, stdio: 'ignore'});
      const exited = once(previousDesktop, 'exit');
      try {
        await expect.poll(() => existsSync(join(fixture.root, 'orphan-ready.json'))).toBe(true);
        orphanPid = JSON.parse(readFileSync(join(fixture.root, 'orphan-ready.json'), 'utf8')).pid;
        remember(orphanPid);
        process.kill(orphanPid, 'SIGSTOP');
      } finally {
        previousDesktop.kill('SIGKILL');
        await exited;
      }
      await expect.poll(() => parentPid(orphanPid)).toBe(1);
      expect(readCheckProcessOwners(daemon.home, realMacAppOps()).some(owner => owner.pid === orphanPid)).toBe(false);
    }
    await dashboard.getByRole('button', { name: 'Dispatch' }).first().click();
    const dispatch = dashboard.getByRole('dialog', { name: 'Dispatch an agent' });
    await dispatch.getByPlaceholder('search repos or type a path…').fill(daemon.repo);
    await dashboard.keyboard.press('Escape');
    await dispatch.getByPlaceholder('What should this agent do?').fill('Hold a session for the update-during-check regression');
    await dispatch.locator('select').filter({ hasText: 'finish without a Workflow' }).selectOption('__none');
    await dispatch.getByRole('button', { name: 'Dispatch now' }).click();
    await expect(dispatch).toBeHidden();
    let sessionId = '';
    await expect.poll(async () => {
      const sessions = await api('/api/sessions');
      const session = sessions.find((s: { state: string }) => s.state === 'idle');
      sessionId = session?.id ?? '';
      return !!sessionId;
    }).toBe(true);
    await api('/api/workflows/config', {
      liveEnabled: true, checksEnabled: true, repoAllowlist: [daemon.repo], defaultWorkflowId: null,
      checkCommands: [{ repoRoot: daemon.repo, slot: 'test', command: ['/bin/sh', '-c', 'echo UPDATE_CHECK_RUNNING; sleep 240'] }],
    }, 'PUT');
    const workflow = await api('/api/workflows', {
      name: 'Update while check runs',
      draft: {
        nodes: [
          { id: 'session', kind: 'session', position: { x: 0, y: 0 } },
          { id: 'check', kind: 'check', slot: 'test', position: { x: 220, y: 0 } },
          { id: 'end', kind: 'end', outcome: 'Approved', position: { x: 440, y: 0 } },
        ],
        edges: [
          { id: 'start', source: 'session', sourcePort: 'submitted', target: 'check', targetPort: 'activate' },
          { id: 'pass', source: 'check', sourcePort: 'pass', target: 'end', targetPort: 'terminal' },
          { id: 'fail', source: 'check', sourcePort: 'fail', target: 'session', targetPort: 'return_for_changes' },
        ],
      },
    });
    const published = await api(`/api/workflows/${workflow.workflow.id}/publish`, { expectedDraftRevision: 1 });
    const binding = await api('/api/workflow-bindings', { workflowVersionId: published.version.id, sessionId, deliveryMode: 'preview' });
    const submitted = await api(`/api/workflow-bindings/${binding.id}/submit`, { requestId: 'update-live-check' });
    const runId = submitted.run.id;
    let lease: CheckLease | undefined;
    await expect.poll(() => {
      lease = withDaemonDb(daemon, db => db.prepare(`
        SELECT attempt_id, supervisor_pid, supervisor_start_ticks AS supervisor_identity
        FROM workflow_check_leases WHERE cleanup_state = 'held' AND supervisor_pid > 0
      `).get()) as CheckLease | undefined;
      return !!lease;
    }, { timeout: 60_000 }).toBe(true);
    checkPid = lease!.supervisor_pid;
    checkIdentity = lease!.supervisor_identity;
    expect(processIsAlive(checkPid)).toBe(true);
    const executable = execFileSync('/bin/ps', ['-p', String(checkPid), '-o', 'comm='], { encoding: 'utf8' }).trim();
    expect(executable).toContain(fixture.installed + '/Contents/');
    await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);
    // Invoke the real native menu callback; acceptance itself is a renderer click through preload.
    writeFileSync(join(fixture.root, 'request-update'), 'check');
    const dialog = dashboard.getByRole('dialog', { name: 'Mission Control update' });
    await expect(dialog).toBeVisible();
    await expect(dialog).not.toContainText('could not be completed');
    await dialog.getByRole('button', { name: 'Update Now' }).click({ timeout: 10_000 });
    await expect.poll(async () => {
      const text = await dialog.textContent();
      if (text?.includes('could not be completed')) throw new Error(text);
      return dialog.getByRole('button', { name: 'Restart and Install' }).isVisible();
    }, { timeout: 90_000 }).toBe(true);
    await expectContentClearsBorder(dialog);
    expect(processStartIdentity(checkPid), 'the same bundle check is still running at acceptance').toBe(checkIdentity);
    if (orphanPid) expect(parentPid(orphanPid), 'the orphan is still alive at acceptance').toBe(1);
    const checkOwner = readCheckProcessOwners(daemon.home, realMacAppOps()).find(owner => owner.pid === checkPid);
    expect(checkOwner?.work).toContain(`attempt ${lease!.attempt_id}, run ${runId}, session ${sessionId}`);
    console.log('Live check ownership:', checkOwner?.work);
    await dashboard.screenshot({ path: join(evidence, `${label}-accepted-with-running-check.png`) });

    // Select the race where the utility cannot handle SIGTERM before Electron quits. A busy
    // event loop can have this scheduling; SIGSTOP makes it repeatable without altering code.
    // Resume after before-quit. The fixed shell waits for the daemon; the old shell kills it.
    paused = daemonOwner;
    process.kill(paused.pid, 'SIGSTOP');
    const acceptedAt = Date.now();
    await dialog.getByRole('button', { name: 'Restart and Install' }).click();
    await expect.poll(() => readFileSync(join(daemon.home, 'daemon.log'), 'utf8').includes('kind=ready choice=confirm')).toBe(true);
    await expect.poll(() => existsSync(join(fixture.root, 'quit-requested')), { timeout: 30_000 }).toBe(true);
    if (reopenDuringUpdate) {
      const journal = readMigrationJournal(daemon.home)!;
      expect(journal.ownerRole).toBe('helper');
      await expect.poll(() => progressWindow!(journal.owner.pid), {timeout: 15_000}).not.toBeNull();
      pausedHelper = remember(journal.owner.pid);
      progressHelperPid = journal.owner.pid;
      process.kill(pausedHelper.pid, 'SIGSTOP');
    }
    await delay(15_000);
    console.log('Quit barrier:', JSON.stringify({ mainAlive: processIsAlive(initialMain), daemonAlive: processIsAlive(health.pid), checkAlive: processIsAlive(checkPid) }));
    resume();
    await expect.poll(() => processIsAlive(initialMain), { timeout: 90_000 }).toBe(false);
    if (reopenDuringUpdate) {
      const before = readFileSync(join(daemon.home, 'install-migration.json'), 'utf8');
      const helper = pausedHelper!;
      const hidden = progressWindow!(helper.pid);
      // Hide ends the osascript dialog. Closing this fixture-owned process gives the same
      // closed-dialog state without requiring machine-wide Accessibility permission.
      // The helper can be paused between closing a message and displaying its replacement;
      // that is already the hidden state this reopen boundary needs.
      if (hidden) process.kill(hidden.pid, 'SIGTERM');
      await expect.poll(() => progressWindow!(helper.pid)).toBeNull();
      const openedAt = Date.now();
      execFileSync('/usr/bin/open', ['-n', fixture.installed]);
      let reopenPid = 0;
      await expect.poll(() => {
        const launches = readFileSync(join(fixture.root, 'launches.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        reopenPid = launches.find(row => row.pid !== initialMain)?.pid ?? 0;
        return reopenPid;
      }).toBeGreaterThan(0);
      remember(reopenPid);
      await expect.poll(() => {
        const errors = join(fixture.root, 'native-errors.jsonl');
        if (existsSync(errors)) throw new Error(`Reopen showed an installation error: ${readFileSync(errors, 'utf8')}`);
        return processIsAlive(reopenPid);
      }, {timeout: 10_000}).toBe(false);
      expect(existsSync(join(fixture.root, 'native-errors.jsonl'))).toBe(false);
      expect(readFileSync(join(daemon.home, 'install-migration.json'), 'utf8')).toBe(before);
      expect(processIdentity(helper.pid)).toBe(helper.identity);
      process.kill(helper.pid, 'SIGCONT');
      pausedHelper = null;
      await expect.poll(() => progressWindow!(helper.pid), {timeout: 10_000}).not.toBeNull();
      const shown = progressWindow!(helper.pid)!;
      reopenedProgressPid = shown.pid;
      if (hidden) expect(shown.pid).not.toBe(hidden.pid);
      expect(shown.command).toContain('Mission Control will reopen automatically');
      console.log('Reopen proof:', JSON.stringify({reopenPid, exitMs: Date.now() - openedAt,
        helperPid: helper.pid, journalUnchanged: true, progress: shown}));
      // The original transaction finishes in its normal launch budget; opening did not
      // start a replacement helper, restart the wait, or keep the old executable open.
      await expect.poll(() => {
        const path = join(daemon.home, 'update-outcome.json');
        return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).result : null;
      }, {timeout: 60_000}).toBe('success');
    }
    // The helper must report an actual installation result, not a synthetic seeded outcome.
    await expect.poll(() => {
      const path = join(daemon.home, 'update-outcome.json');
      return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).result : null;
    }, { timeout: 270_000 }).toMatch(/success|failure/);
    const outcome = JSON.parse(readFileSync(join(daemon.home, 'update-outcome.json'), 'utf8'));
    const receipt = JSON.parse(readFileSync(join(daemon.home, 'install-receipt.json'), 'utf8'));
    const summary = {
      baseline: fixture.baseline ?? null, runId, attemptId: lease!.attempt_id, checkPid, executable, initialMain,
      elapsedMs: Date.now() - acceptedAt, outcome, installedCommit: receipt.installedCommit,
    };
    writeFileSync(join(evidence, `${label}-journey.json`), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary));
    expect(outcome.result).toBe('success');
    if (progressWindow) {
      await expect.poll(() => processIsAlive(reopenedProgressPid)).toBe(false);
      await expect.poll(() => progressWindow(progressHelperPid)).toBeNull();
      await expect.poll(() => processIsAlive(progressHelperPid)).toBe(false);
      console.log('Verified: successful installation closed the reopened native progress process and its helper.');
    }
    expect(receipt.installedCommit).toBe('b'.repeat(40));
    if (orphanPid) {
      expect(processIsAlive(orphanPid)).toBe(false);
      expect(readFileSync(join(daemon.home, 'update.log'), 'utf8')).toContain(`${orphanPid} (`);
      expect(readFileSync(join(daemon.home, 'update.log'), 'utf8')).toContain('Mission Control orphaned Node utility');
      console.log(`Verified orphan PID ${orphanPid}: no check lease or current-desktop ancestry; helper captured its Node utility ownership, logged it, and automatically reaped it before installing.`);
    }
    const relaunched = await connect();
    const nextHealth = await api('/api/health');
    remember(nextHealth.pid);
    remember(parentPid(nextHealth.pid));
    expect(nextHealth.pid).not.toBe(health.pid);
    const currentVersion = (await relaunched.evaluate(() => window.missionDesktop!.updates.getState())).currentVersion;
    expect(currentVersion).toBe('1.26.1');
    expect(processIsAlive(checkPid)).toBe(false);
    const interrupted = withDaemonDb(daemon, db => db.prepare(
      'SELECT state, error FROM workflow_node_attempts WHERE id = ?',
    ).get(lease!.attempt_id)) as { state: string; error: string };
    expect(interrupted.error).toContain('Mission Control is shutting down');
    expect(withDaemonDb(daemon, db => db.prepare(`
      SELECT COUNT(*) AS n FROM workflow_check_leases
      WHERE attempt_id = ? AND cleanup_state IN ('held','returning')
    `).get(lease!.attempt_id))).toEqual({ n: 0 });
    console.log('Verified relaunched runtime:', JSON.stringify({currentVersion, daemonPid: nextHealth.pid,
      previousDaemonPid: health.pid, checkAlive: processIsAlive(checkPid), interrupted, heldLeases: 0}));
    await expect(relaunched.getByRole('dialog', { name: 'Mission Control update' })).toContainText('updated to');
    await relaunched.screenshot({ path: join(evidence, `${label}-relaunched-new-build.png`) });
    if (process.env.MC_E2E_DESKTOP_EVIDENCE === '1') {
      // Capture the actual desktop, including external native windows. A renderer-only
      // screenshot cannot demonstrate the absence of the macOS progress dialog.
      execFileSync('/usr/bin/open', [fixture.installed]);
      await relaunched.bringToFront();
      await delay(500); // Let macOS finish activating/compositing the relaunched window.
      execFileSync('/usr/sbin/screencapture', ['-x', '-m',
        join(evidence, `${label}-completed-desktop.png`)]);
      console.log('Captured actual desktop after successful relaunch and native progress/helper exit.');
    }
    console.log('Verified: ready-dialog acceptance while a bundle-owned workflow check was live; actual helper replacement; new build/daemon running; old group gone; interrupted attempt reason persisted; old lease released.');
  } finally {
    resume();
    if (pausedHelper?.identity && processIdentity(pausedHelper.pid) === pausedHelper.identity) {
      try { process.kill(pausedHelper.pid, 'SIGCONT'); } catch { /* Already exited. */ }
    }
    for (const name of ['update.log', 'daemon.log']) {
      if (existsSync(join(daemon.home, name))) {
        writeFileSync(join(evidence, `${label}-${name}`), readFileSync(join(daemon.home, name)));
      }
    }
    // Kill only exact fixture identities, including helpers and a rollback's reopened app.
    const runtimes = join(daemon.home, 'update-runtimes');
    if (existsSync(runtimes)) for (const name of readdirSync(runtimes)) {
      const marker = join(runtimes, name, 'owner.json');
      if (existsSync(marker)) {
        const record = JSON.parse(readFileSync(marker, 'utf8')).helper;
        if (record) owned.push(record);
      }
    }
    const journal = readMigrationJournal(daemon.home);
    if (journal?.targetProcess) owned.push(journal.targetProcess);
    for (const browser of browsers) await browser.close().catch(() => {});
    // Stop helpers before scanning the bundle, so rollback cannot launch another copy.
    for (const record of owned.reverse()) if (record.identity && processIdentity(record.pid) === record.identity) {
      try { process.kill(record.pid, 'SIGKILL'); } catch { /* Already exited. */ }
    }
    if (checkPid && processStartIdentity(checkPid) === checkIdentity) {
      try { process.kill(-checkPid, 'SIGKILL'); } catch { /* Already exited. */ }
    }
    const processes = parseAppProcesses(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,stat=,comm='], { encoding: 'utf8' }));
    for (const record of processes) {
      if (!record.executable.startsWith(fixture.installed + '/Contents/')) continue;
      const identity = processIdentity(record.pid);
      if (identity && processIdentity(record.pid) === identity) {
        try { process.kill(record.pid, 'SIGKILL'); } catch { /* Already exited. */ }
      }
    }
  }
});
