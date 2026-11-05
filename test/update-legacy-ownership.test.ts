import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { UPDATE_HELPER_FILES } from '../scripts/update-helper-files.mjs';
import { spawnBundledUpdateHelper } from '../scripts/update-helper-runtime.mjs';
import { processIdentity, processIsAlive } from '../scripts/update-lock.mjs';
import { darwinCheckIdentity } from '../scripts/darwin-process-identity.mjs';
import type { UpdateProcessOwner } from '../scripts/update-process-owners.mjs';

test('legacy snapshot handoff captures and cleans up an orphaned SDK driver and native utility before continuing', {
  skip: process.platform !== 'darwin', timeout: 60_000,
}, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mc-legacy-ownership-')));
  const bundle = join(root, 'Fixture.app');
  const userDataDirectory = join(root, 'profile');
  const electron = createRequire(import.meta.url)('electron') as string;
  execFileSync('/bin/cp', ['-R', resolve(dirname(electron), '../..'), bundle]);
  const executable = join(bundle, 'Contents/MacOS/Mission Control');
  renameSync(join(bundle, 'Contents/MacOS/Electron'), executable);
  const resources = join(bundle, 'Contents/Resources/app');
  for (const file of UPDATE_HELPER_FILES) {
    mkdirSync(dirname(join(resources, file)), {recursive: true});
    copyFileSync(file, join(resources, file));
  }
  // Keep the actual consumer in the copied runtime. Only installation and relaunch
  // are fixture ports; capture, snapshot, fork/ack, parent wait and cleanup are real.
  copyFileSync('scripts/apply-update.mjs', join(resources, 'scripts/fixture-apply.mjs'));
  writeFileSync(join(resources, 'scripts/apply-update.mjs'), `
    import {runApplyUpdate, realApplyOperations, parseArgs} from '../Runtime.app/Contents/Resources/app/scripts/fixture-apply.mjs';
    const {args, problem} = parseArgs(process.argv.slice(2));
    if (problem) throw new Error(problem);
    // Ownership is real; native presentation belongs to the dedicated Playwright specs.
    const ops = realApplyOperations(args.logPath, undefined, () => () => {});
    const result = await runApplyUpdate(args, {...ops,
      preflight: async () => {}, copy: () => {}, remove: () => {}, install: () => {},
      prepareLaunch: async () => {}, launch: () => {}, verifyLaunch: async () => {},
    });
    process.exit(result.ok ? 0 : 1);
  `);
  writeFileSync(join(resources, 'package.json'), JSON.stringify({name: 'mission-control', version: '1.0.0', main: 'fixture-main.cjs'}));
  writeFileSync(join(root, 'worker.cjs'), "process.parentPort.postMessage('ready'); setInterval(() => {}, 1000);\n");
  const utilityReady = join(root, 'utility.json');
  writeFileSync(join(resources, 'fixture-main.cjs'), `
    const {app, utilityProcess} = require('electron');
    const {writeFileSync} = require('node:fs');
    app.setPath('userData', ${JSON.stringify(userDataDirectory)});
    app.whenReady().then(() => {
      const child = utilityProcess.fork(${JSON.stringify(join(root, 'worker.cjs'))});
      child.once('message', () => writeFileSync(${JSON.stringify(utilityReady)}, JSON.stringify({pid: child.pid})));
    });
  `);
  const sdkExecutable = join(bundle, 'Contents/MacOS/sdk-driver');
  const sdkSource = join(root, 'sdk.c');
  writeFileSync(sdkSource, `#include <signal.h>
#include <stdio.h>
#include <unistd.h>
int main(void) {
  pid_t child = fork();
  if (child < 0) return 1;
  if (child) { printf("%d\\n", child); return 0; }
  close(1); close(2); signal(SIGTERM, SIG_IGN);
  for (;;) pause();
}
`);
  execFileSync('/usr/bin/clang', [sdkSource, '-o', sdkExecutable]);
  const until = async (predicate: () => boolean, message: string, timeout = 10_000) => {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, `${message}\n${existsSync(join(root, 'update.log')) ? readFileSync(join(root, 'update.log'), 'utf8') : ''}`);
      await delay(50);
    }
  };
  const parentPid = (pid: number) => Number(execFileSync('/bin/ps', ['-p', String(pid), '-o', 'ppid='], {encoding: 'utf8'}).trim());
  const owned: Array<{pid: number; identity: string | null}> = [];
  const remember = (pid: number) => { owned.push({pid, identity: processIdentity(pid)}); return pid; };
  const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
  const oldDesktop = spawn(executable, [], {env, stdio: 'ignore'});
  const oldExited = once(oldDesktop, 'exit');
  const acceptedDesktop = spawn('/bin/sleep', ['120'], {stdio: 'ignore'});
  const acceptedExited = once(acceptedDesktop, 'exit');
  try {
    await until(() => existsSync(utilityReady), 'native utility did not become ready');
    const utilityPid = remember(JSON.parse(readFileSync(utilityReady, 'utf8')).pid);
    process.kill(utilityPid, 'SIGSTOP');
    oldDesktop.kill('SIGKILL');
    await oldExited;
    const sdkPid = remember(Number(execFileSync(sdkExecutable, {encoding: 'utf8'}).trim()));
    await until(() => parentPid(utilityPid) === 1 && parentPid(sdkPid) === 1, 'blockers did not become orphans');
    const db = new DatabaseSync(join(root, 'harness.db'));
    try {
      db.exec('CREATE TABLE sdk_sessions (id TEXT, task_id TEXT, recovery_process_json TEXT)');
      const identity = processIdentity(sdkPid)!;
      db.prepare('INSERT INTO sdk_sessions VALUES (?, ?, ?)').run('sdk:legacy-owned', 'task-legacy', JSON.stringify({
        pid: sdkPid, startMs: Date.parse(identity.split(' ').slice(0, 5).join(' ')), darwinIdentity: darwinCheckIdentity(identity),
      }));
    } finally { db.close(); }
    const directory = await spawnBundledUpdateHelper({runtimeBundle: bundle,
      helperSource: join(resources, 'scripts/apply-update.mjs'), stateDirectory: root,
      parentPid: acceptedDesktop.pid!, userDataDirectory, logPath: join(root, 'update.log'),
      argv: ['--source-clone', root, '--target-tag', 'v1.0.1', '--app-path', bundle,
        '--parent-pid', String(acceptedDesktop.pid), '--state-dir', root, '--log-path', join(root, 'update.log')],
    });
    const marker = JSON.parse(readFileSync(join(directory, 'owner.json'), 'utf8'));
    remember(marker.helper.pid);
    assert.equal(existsSync(join(directory, 'migration-plan.json')), false, 'the legacy candidate supplies no transaction handoff');
    assert.equal(processIsAlive(acceptedDesktop.pid!), true, 'capture and helper acknowledgment finish before the accepted desktop quits');
    const owners = marker.processOwners as UpdateProcessOwner[] | undefined;
    assert.equal(owners?.find(owner => owner.pid === sdkPid)?.work, 'Mission Control session sdk:legacy-owned, task task-legacy');
    assert.equal(owners?.find(owner => owner.pid === utilityPid)?.work, 'Mission Control orphaned Node utility');
    acceptedDesktop.kill('SIGTERM');
    await acceptedExited;
    await until(() => {
      const path = join(root, 'update-outcome.json');
      return existsSync(path) && JSON.parse(readFileSync(path, 'utf8')).result !== 'in-progress';
    }, 'legacy helper did not finish cleaning up the captured owners', 20_000);
    const outcome = JSON.parse(readFileSync(join(root, 'update-outcome.json'), 'utf8'));
    assert.equal(outcome.result, 'success', JSON.stringify(outcome));
    assert.equal(processIsAlive(sdkPid), false);
    assert.equal(processIsAlive(utilityPid), false);
    const log = readFileSync(join(root, 'update.log'), 'utf8');
    assert.match(log, /session sdk:legacy-owned, task task-legacy/);
    assert.match(log, /orphaned Node utility/);
    console.log(`Legacy ownership proof: SDK PID ${sdkPid} and native utility PID ${utilityPid}, both parent 1 with no check lease, captured before quit and automatically reaped by the detached helper. Installation/relaunch are fixture ports.`);
  } finally {
    // Stop the helper before releasing its parent so a failed assertion cannot start
    // a fresh update during fixture cleanup. Only exact task-owned identities count.
    const runtimes = join(root, 'update-runtimes');
    if (existsSync(runtimes)) for (const name of readdirSync(runtimes)) {
      const marker = join(runtimes, name, 'owner.json');
      if (existsSync(marker)) {
        const helper = JSON.parse(readFileSync(marker, 'utf8')).helper;
        if (helper) owned.push(helper);
      }
    }
    for (const record of owned.reverse()) if (record.identity && processIdentity(record.pid) === record.identity) {
      try { process.kill(record.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    oldDesktop.kill('SIGKILL'); acceptedDesktop.kill('SIGKILL');
    await oldExited; await acceptedExited;
    rmSync(root, {recursive: true, force: true});
  }
});
