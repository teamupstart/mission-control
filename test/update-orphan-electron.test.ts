import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { captureUpdateProcessOwners } from '../scripts/update-process-owners.mjs';
import { parseAppProcesses, realMacAppOps, waitForBundleExit } from '../scripts/mac-app-lifecycle.mjs';
import { processIdentity, processIsAlive } from '../scripts/update-lock.mjs';

test('a real orphaned Electron utility is identified and reaped without its former desktop or a check lease', {
  skip: process.platform !== 'darwin', timeout: 45_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-update-orphan-'));
  const bundle = join(root, 'Fixture.app');
  const userDataDirectory = join(root, 'Application Support/Fixture');
  const electron = createRequire(import.meta.url)('electron') as string;
  execFileSync('/bin/cp', ['-R', resolve(dirname(electron), '../..'), bundle]);
  const workerPath = join(root, 'worker.cjs');
  const mainPath = join(root, 'main.cjs');
  const readyPath = join(root, 'ready.json');
  writeFileSync(workerPath, "process.parentPort.postMessage('ready'); setInterval(() => {}, 1000);\n");
  writeFileSync(mainPath, `
    const {app, utilityProcess} = require('electron');
    const {writeFileSync} = require('node:fs');
    app.setPath('userData', ${JSON.stringify(userDataDirectory)});
    app.whenReady().then(() => {
      const child = utilityProcess.fork(${JSON.stringify(workerPath)}, [], {serviceName: 'mission-control-daemon'});
      child.once('message', () => writeFileSync(${JSON.stringify(readyPath)}, JSON.stringify({pid: child.pid})));
    });
  `);
  const env = {...process.env};
  delete env.ELECTRON_RUN_AS_NODE;
  const desktop = spawn(join(bundle, 'Contents/MacOS/Electron'), [mainPath], {env, stdio: ['ignore', 'ignore', 'pipe']});
  const exited = once(desktop, 'exit');
  let stderr = '';
  desktop.stderr.on('data', chunk => { stderr += chunk; });
  let orphanPid: number | undefined;
  const ops = realMacAppOps(root);
  const rows = async () => parseAppProcesses((await ops.run('/bin/ps', ['-axww', '-o', 'pid=,ppid=,stat=,comm='])).stdout);
  const until = async (predicate: () => boolean | Promise<boolean>, message: string) => {
    const deadline = Date.now() + 10_000;
    while (!(await predicate())) {
      assert.ok(Date.now() < deadline, `${message}: ${stderr}`);
      await delay(50);
    }
  };
  try {
    await until(() => existsSync(readyPath), 'utility did not start');
    orphanPid = JSON.parse(readFileSync(readyPath, 'utf8')).pid;
    // Freeze the utility before killing its main process so IPC disconnect cannot
    // voluntarily retire it. It now models the stuck, reparented bundle process.
    process.kill(orphanPid!, 'SIGSTOP');
    desktop.kill('SIGKILL');
    await exited;
    await until(async () => (await rows()).some(row => row.pid === orphanPid && row.ppid === 1), 'utility was not reparented');
    const owners = await captureUpdateProcessOwners({stateDirectory: root, bundle, userDataDirectory,
      parent: {pid: process.pid, identity: processIdentity(process.pid)}}, ops);
    const orphan = owners.find(owner => owner.pid === orphanPid);
    assert.equal(orphan?.work, 'Mission Control orphaned Node utility');
    assert.equal(orphan?.group, false);
    const waiting: string[] = [];
    await waitForBundleExit(bundle, ops, 15_000, message => waiting.push(message), owners);
    assert.equal(processIsAlive(orphanPid!), false);
    assert.ok(waiting.some(message => message.includes(`${orphanPid} (`) && message.includes(orphan!.work)));
    console.log(`Verified orphan PID ${orphanPid}: parent 1, ${orphan!.work}, no check lease; automatic cleanup completed the real bundle wait.`);
  } finally {
    desktop.kill('SIGKILL');
    if (orphanPid) { try { process.kill(orphanPid, 'SIGKILL'); } catch { /* already reaped */ } }
    await exited;
    rmSync(root, {recursive: true, force: true});
  }
});
