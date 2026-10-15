// A complete Electron bundle, an exiting parent, a real detached helper and GUI
// readiness gate. Everything lives in a disposable tree; no operator app/home is used.
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import test from 'node:test';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { UPDATE_HELPER_FILES } from '../scripts/update-helper-files.mjs';
import { MIGRATION_ACK, readMigrationJournal } from '../scripts/install-migration.mjs';
import { inspectBundle } from '../scripts/install-staged-app.mjs';
import { boundedMigrationWait } from '../scripts/migration-runtime.mjs';
import { cleanupHelperSnapshots } from '../scripts/update-helper-runtime.mjs';
import { processIdentity, processIsAlive, type ProcessRecord } from '../scripts/update-lock.mjs';
import { ensureNativeStateLockAddon } from './helpers/native-state-lock.ts';

ensureNativeStateLockAddon();
const require = createRequire(import.meta.url);

for (const mode of ['success', 'preparation-retry', 'readiness-failure', 'interrupted-after-swap']) test(`copied complete Electron ${mode} after parent exit with host runtimes trapped`, {skip: process.platform !== 'darwin', timeout: 180_000}, async (t) => {
  const failure = mode === 'readiness-failure' || mode === 'interrupted-after-swap';
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mission-detached-electron-')));
  const ownedProcesses: ProcessRecord[] = [];
  let interruptedTarget: ProcessRecord | null = null;
  t.after(() => {
    const runtimes = join(root, 'state/update-runtimes');
    if (existsSync(runtimes)) for (const name of readdirSync(runtimes)) {
      const marker = join(runtimes, name, 'owner.json');
      if (existsSync(marker)) {
        const owner = JSON.parse(readFileSync(marker, 'utf8'));
        if (owner.helper) ownedProcesses.push(owner.helper);
      }
    }
    for (const record of ownedProcesses) {
      if (record.identity && processIdentity(record.pid) === record.identity && processIsAlive(record.pid)) process.kill(record.pid, 'SIGKILL');
    }
    rmSync(root, {recursive: true, force: true});
  });
  const state = join(root, 'state'); mkdirSync(state);
  const apps = join(root, 'apps'); mkdirSync(apps);
  const current = join(apps, 'Mission Control.app');
  const candidate = join(root, 'candidate.app');
  const electron = require('electron') as string;
  const electronBundle = resolve(dirname(electron), '../..');
  execFileSync('/bin/cp', ['-R', electronBundle, current]);
  renameSync(join(current, 'Contents/MacOS/Electron'), join(current, 'Contents/MacOS/Mission Control'));
  const plist = join(current, 'Contents/Info.plist');
  writeFileSync(plist, readFileSync(plist, 'utf8').replace(/(<key>CFBundleExecutable<\/key>\s*<string>)[^<]+/, '$1Mission Control')
    .replace(/(<key>CFBundleIdentifier<\/key>\s*<string>)[^<]+/, '$1com.mission-control.app')
    .replace(/(<key>CFBundleShortVersionString<\/key>\s*<string>)[^<]+/, '$11.26.0'));
  const resources = join(current, 'Contents/Resources/app'); mkdirSync(resources, {recursive: true});
  // Use inert fixture modules at the production readiness inventory. The native
  // ownership addon is real. A daemon launch would fail, proving this is pre-state.
  for (const path of ['dist/main/index.cjs', 'dist/preload/index.cjs', 'dist/server/index.mjs', 'dist/server/foreman-worker.mjs',
    'dist/web/index.html', 'dist/mcp/server.mjs', 'dist/satellites/hook.mjs']) {
    mkdirSync(dirname(join(resources, path)), {recursive: true});
    writeFileSync(join(resources, path), 'throw new Error("Fixture must not start a daemon or agent");');
  }
  for (const path of ['dist/native/state-lock.node', ...UPDATE_HELPER_FILES]) {
    mkdirSync(dirname(join(resources, path)), {recursive: true});
    copyFileSync(path, join(resources, path));
  }
  buildSync({entryPoints: ['src/main/updater.ts'], bundle: true, platform: 'node', format: 'esm',
    alias: {'@shared': './src/shared'}, outfile: join(resources, 'updater-fixture.mjs')});
  const pkg = {name: 'mission-control-fixture', version: '1.26.0', main: 'fixture-main.cjs', missionCommit: 'a'.repeat(40),
    missionInstallMigration: {protocol: 1, automatic: true}, missionInstallTransaction: {protocol: 1, receiptSchemas: [1, 2]}};
  writeFileSync(join(resources, 'package.json'), JSON.stringify(pkg));
  writeFileSync(join(resources, 'fixture-main.cjs'), `
    const {app} = require('electron');
    const {writeFileSync, readFileSync, existsSync} = require('node:fs');
    const {join, resolve} = require('node:path');
    app.whenReady().then(async () => {
      try {
        if (process.argv.includes('--fixture-parent')) {await import('./parent.mjs'); app.quit(); return;}
        const {migrationStartupGate, boundedMigrationWait, recordMigrationLaunch} = await import('./scripts/migration-runtime.mjs');
        // Hold only the attempt's target before readiness. Ordinary recovery and
        // restored-source launches must still run the real startup gate.
        if (${JSON.stringify(mode)} === 'interrupted-after-swap' && process.argv.includes('--mission-migration')) {
          const {readMigrationJournal} = await import('./scripts/install-migration.mjs');
          recordMigrationLaunch(readMigrationJournal(process.env.MISSION_HOME).plan);
          writeFileSync(join(process.env.MISSION_HOME, 'fixture-target-waiting'), String(process.pid));
          await boundedMigrationWait(() => existsSync(join(process.env.MISSION_HOME, 'fixture-release-target')),
            'Fixture target was not stopped by recovery', {timeout: 120000});
        }
        const result = await migrationStartupGate({stateDirectory: process.env.MISSION_HOME,
          runningBundle: resolve(__dirname, '../../..'), nonce: process.argv.includes('--mission-migration') ? process.argv[process.argv.indexOf('--mission-migration') + 1] : undefined, port: 59999});
        if (!result.proceed) {app.exit(0); return;}
        const receipt = JSON.parse(readFileSync(join(process.env.MISSION_HOME, 'install-receipt.json')));
        writeFileSync(join(process.env.MISSION_HOME, 'fixture-ready.json'), JSON.stringify({result, receipt, pid: process.pid,
          nodeFlag: process.env.ELECTRON_RUN_AS_NODE ?? null, electron: process.versions.electron}));
        app.quit();
      } catch (error) {
        writeFileSync(join(process.env.MISSION_HOME, 'fixture-error.txt'), String(error.stack));
        if (${JSON.stringify(mode)} === 'readiness-failure' && process.argv.includes('--mission-migration')) {
          const {boundedMigrationWait} = await import('./scripts/migration-runtime.mjs');
          const {readMigrationJournal} = await import('./scripts/install-migration.mjs');
          // Exercise exit after launch identification, rather than racing the
          // helper's first poll and falling into its missing-launch deadline.
          await boundedMigrationWait(() => readMigrationJournal(process.env.MISSION_HOME)?.targetProcess?.pid === process.pid,
            'Fixture failed target was not identified', {timeout: 5000});
        }
        app.exit(1);
      }
    });
  `);
  execFileSync('/bin/cp', ['-R', current, candidate]);
  writeFileSync(join(candidate, 'Contents/Resources/app/package.json'), JSON.stringify({...pkg, missionCommit: 'b'.repeat(40)}));
  if (mode === 'readiness-failure') rmSync(join(candidate, 'Contents/Resources/app/dist/native/state-lock.node'));
  const receipt = {schema: 1, repo: 'teamupstart/mission-control', releaseTag: 'v1.26.0', installedVersion: '1.26.0',
    installedCommit: 'a'.repeat(40), sourceClone: join(root, 'source-does-not-exist'), appPath: current, installedAt: '2026-10-14T00:00:00.000Z'};
  const receiptBytes = Buffer.from(`\n${JSON.stringify(receipt, null, 2)}\n\n`);
  writeFileSync(join(state, 'install-receipt.json'), receiptBytes);
  const traps = join(root, 'traps'); mkdirSync(traps);
  for (const command of ['node', 'npm', 'npx']) writeFileSync(join(traps, command), '#!/bin/sh\nprintf "%s\\n" "$0" >> "$MISSION_RUNTIME_TRAPS"\nexit 97\n', {mode: 0o755});
  const parentScript = join(resources, 'parent.mjs');
  writeFileSync(parentScript, `
    import assert from 'node:assert/strict';
    import childProcess from 'node:child_process';
    import {syncBuiltinESMExports} from 'node:module';
    import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, lstatSync, readdirSync} from 'node:fs';
    import {fileURLToPath} from 'node:url';
    import {spawnDetachedUpdateHelper} from './updater-fixture.mjs';
    import {stagedBundleRevision} from './src/shared/staged-bundle.mjs';
    import {inspectBundle, prepareSourceUpdate} from './scripts/install-staged-app.mjs';
    import {prepareInPlaceInstall} from './scripts/install-migration.mjs';
    const receipt = ${JSON.stringify(receipt)};
    const state = ${JSON.stringify(state)}, candidate = ${JSON.stringify(candidate)};
    const handoff = {node: '/must-not-use-host-node', env: process.env,
      helperSource: fileURLToPath(new URL('./scripts/apply-update.mjs', import.meta.url)),
      stateDirectory: state, parentPid: process.pid, logPath: state + '/update.log', sourceClone: receipt.sourceClone,
      targetTag: 'v1.26.0', appPath: receipt.appPath, stagedBundle: candidate, stagedRevision: stagedBundleRevision(lstatSync(candidate))};
    if (${JSON.stringify(mode)} === 'preparation-retry') {
      const descriptor = prepareSourceUpdate({receipt, bundle: candidate, revision: handoff.stagedRevision, targetTag: handoff.targetTag});
      handoff.migration = prepareInPlaceInstall({descriptor, stateDirectory: state});
      const attempt = state + '/update-runtimes/attempt-' + handoff.migration.nonce;
      const originalExec = childProcess.execFileSync;
      const priorBundle = inspectBundle(receipt.appPath);
      const priorReceipt = readFileSync(state + '/install-receipt.json');
      for (const boundary of ['copy', 'verification']) {
        let injected = false;
        childProcess.execFileSync = (command, args, options) => {
          if (command !== '/bin/cp' || args[2] !== attempt + '/Runtime.app') return originalExec(command, args, options);
          injected = true;
          assert.equal(JSON.parse(readFileSync(attempt + '/owner.json')).helper, null);
          if (boundary === 'copy') {
            mkdirSync(attempt + '/Runtime.app');
            writeFileSync(attempt + '/Runtime.app/partial', 'incomplete copied bytes');
            throw new Error('Fixture snapshot copy ran out of space');
          }
          const result = originalExec(command, args, options);
          writeFileSync(attempt + '/Runtime.app/partial', 'changed copied bytes');
          return result;
        };
        syncBuiltinESMExports();
        try {
          await assert.rejects(() => spawnDetachedUpdateHelper(handoff), boundary === 'copy'
            ? /Fixture snapshot copy ran out of space/ : /helper runtime changed while copying/);
        } finally {childProcess.execFileSync = originalExec; syncBuiltinESMExports();}
        assert.ok(injected, 'failure must occur after the attempt directory is created');
        assert.equal(existsSync(attempt), false, boundary + ' failure reclaims the entire incomplete attempt');
        assert.deepEqual(inspectBundle(receipt.appPath), priorBundle);
        assert.deepEqual(readFileSync(state + '/install-receipt.json'), priorReceipt);
      }
      // Cleanup must never claim an attempt directory it did not create.
      mkdirSync(attempt);
      writeFileSync(attempt + '/unknown-owner', 'retain');
      await assert.rejects(() => spawnDetachedUpdateHelper(handoff), {code: 'EEXIST'});
      assert.equal(readFileSync(attempt + '/unknown-owner', 'utf8'), 'retain');
      rmSync(attempt, {recursive: true});
      writeFileSync(state + '/fixture-preparation-retry.json', JSON.stringify({attempt}));
    }
    await spawnDetachedUpdateHelper(handoff);
    const runtime = state + '/update-runtimes/' + readdirSync(state + '/update-runtimes')[0];
    writeFileSync(state + '/handoff.json', JSON.stringify({runtime, pid: process.pid}));
  `);
  const priorBundle = inspectBundle(current);
  const env: NodeJS.ProcessEnv = {...process.env, MISSION_HOME: state, MISSION_PORT: '59999', PATH: `${traps}:/usr/bin:/bin`,
    MISSION_RUNTIME_TRAPS: join(root, 'trap-hits')};
  delete env.ELECTRON_RUN_AS_NODE;
  const parent = spawn('/usr/bin/open', ['-W', '-n', current, '--env', `MISSION_HOME=${state}`, '--args', '--fixture-parent'], {
    env, stdio: ['ignore', 'pipe', 'pipe']});
  let output = ''; parent.stdout.on('data', (v) => {output += v;}); parent.stderr.on('data', (v) => {output += v;});
  assert.equal(await new Promise((done) => parent.once('exit', done)), 0, output);
  const handed = JSON.parse(readFileSync(join(state, 'handoff.json'), 'utf8'));
  if (mode === 'preparation-retry') assert.equal(handed.runtime,
    JSON.parse(readFileSync(join(state, 'fixture-preparation-retry.json'), 'utf8')).attempt,
    'the same transaction retries preparation and acknowledges a real detached helper');
  const owner = JSON.parse(readFileSync(join(handed.runtime, 'owner.json'), 'utf8'));
  ownedProcesses.push(owner.helper);
  if (mode === 'interrupted-after-swap') {
    await boundedMigrationWait(() => {
      const journal = readMigrationJournal(state);
      return journal?.stage === 'target-staged' && journal.targetProcess !== null && existsSync(join(state, 'fixture-target-waiting'));
    }, 'fixture never reached the post-swap interruption boundary', {timeout: 120_000});
    const journal = readMigrationJournal(state)!;
    assert.equal(journal.stage, 'target-staged');
    assert.ok(journal.targetProcess);
    interruptedTarget = journal.targetProcess;
    ownedProcesses.push(journal.targetProcess);
    assert.equal(processIsAlive(handed.pid), false, 'parent exited before the post-swap interruption');
    assert.equal(processIdentity(journal.targetProcess.pid), journal.targetProcess.identity);
    assert.equal(readFileSync(join(state, 'fixture-target-waiting'), 'utf8'), String(journal.targetProcess.pid));
    const installedBundle = inspectBundle(current);
    assert.deepEqual(installedBundle, inspectBundle(candidate), 'candidate is installed before helper termination');
    assert.notEqual(installedBundle.digest, priorBundle.digest);
    assert.deepEqual(readFileSync(join(state, 'install-receipt.json')), receiptBytes, 'receipt is not committed');
    assert.equal(existsSync(join(state, MIGRATION_ACK)), false, 'target has not acknowledged readiness');
    assert.deepEqual(journal.owner, owner.helper);
    assert.equal(processIdentity(owner.helper.pid), owner.helper.identity);
    process.kill(owner.helper.pid, 'SIGKILL');
    await boundedMigrationWait(() => !processIsAlive(owner.helper.pid), 'interrupted helper did not exit', {timeout: 10_000});
    // Ordinary startup of the installed replacement must detach its own recovery
    // helper before restoring the app whose executable it just launched.
    delete env.ELECTRON_RUN_AS_NODE;
    const retry = spawn('/usr/bin/open', ['-W', '-n', current, '--env', `MISSION_HOME=${state}`], {env, stdio: 'ignore'});
    await new Promise<void>((done, reject) => {retry.once('spawn', done); retry.once('error', reject);});
    ownedProcesses.push({pid: retry.pid!, identity: processIdentity(retry.pid!)});
    assert.equal(await new Promise((done) => retry.once('exit', done)), 0, 'ordinary startup handed off recovery');
  }
  await boundedMigrationWait(() => {
    if (mode !== 'readiness-failure' && existsSync(join(state, 'fixture-error.txt'))) throw new Error(readFileSync(join(state, 'fixture-error.txt'), 'utf8'));
    return existsSync(join(state, 'fixture-ready.json'));
  }, `detached fixture failed: ${state}`, {timeout: 120_000});
  const ready = JSON.parse(readFileSync(join(state, 'fixture-ready.json'), 'utf8'));
  await boundedMigrationWait(() => !processIsAlive(ready.pid), 'fixture app did not exit', {timeout: 10000});
  assert.equal(ready.receipt.installedCommit, (failure ? 'a' : 'b').repeat(40));
  assert.equal(ready.result.committed, !failure);
  assert.equal(ready.nodeFlag, null, 'GUI launch must clear run-as-node');
  assert.ok(ready.electron);
  assert.equal(existsSync(join(root, 'trap-hits')), false, 'no node/npm/npx was invoked');
  assert.equal(processIsAlive(handed.pid), false, 'original parent exited');
  assert.equal(JSON.parse(readFileSync(join(current, 'Contents/Resources/app/package.json'), 'utf8')).missionCommit, (failure ? 'a' : 'b').repeat(40));
  if (failure) {
    assert.deepEqual(inspectBundle(current), priorBundle, 'recovery restores the complete prior bundle');
    assert.deepEqual(readFileSync(join(state, 'install-receipt.json')), receiptBytes, 'recovery preserves exact receipt bytes including whitespace');
  }
  if (interruptedTarget) assert.equal(processIsAlive(interruptedTarget.pid), false, 'recovery stopped the replaced target');
  assert.equal(JSON.parse(readFileSync(join(state, 'update-outcome.json'), 'utf8')).result, failure ? 'failure' : 'success');
  await boundedMigrationWait(() => !processIsAlive(owner.helper.pid), 'helper did not exit', {timeout: 10_000});
  assert.ok(existsSync(join(handed.runtime, 'Runtime.app/Contents/Frameworks/Electron Framework.framework')));
  cleanupHelperSnapshots(state);
  if (!failure) assert.deepEqual(readdirSync(apps), ['Mission Control.app'], 'successful update leaves no retained swap siblings');
  assert.equal(existsSync(handed.runtime), failure, 'only a later owner reclaims a dead completed runtime; failed recovery material remains');
  if (mode !== 'interrupted-after-swap') assert.equal(existsSync(join(state, 'install-attempts', owner.transactionNonce, 'previous.app')), failure,
    'a completed matching transaction reclaims its recovery copy; failures retain it');
  console.log(`Detached complete-bundle proof: parent exited; original replaced; ${failure ? `${mode} restored exact prior app and receipt` : 'GUI readiness before state, durable success, dead snapshot reclaimed'}; no host runtime traps.`);
  if (mode === 'preparation-retry') console.log('Snapshot preparation proof: partial copy and digest-verification failures reclaimed; app and receipt unchanged; pre-existing attempt retained; same transaction retried to completion.');
});
