// Every bundle copy below is verified by a mode-sensitive digest, so each case drives a real
// copy path under the installer's `umask 077` against a bundle at ordinary 0755/0644 modes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, lstatSync, readdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { prepareStagedInstall, installStagedApp, inspectBundle } from '../scripts/install-staged-app.mjs';
import { prepareInPlaceInstall, runMigration, migrationReceipt } from '../scripts/install-migration.mjs';
import { spawnBundledUpdateHelper } from '../scripts/update-helper-runtime.mjs';
import { realApplyOperations, runApplyUpdate } from '../scripts/apply-update.mjs';
import { waitForBundleExit, type MacAppOps } from '../scripts/mac-app-lifecycle.mjs';
import { processFingerprint } from '../scripts/update-process-owners.mjs';

/** Every entry's path and permission bits, which is what the install digest hashes. */
function bundleModes(bundle: string) {
  const modes: Record<string, string> = {};
  const visit = (path: string) => {
    const stat = lstatSync(path);
    modes[relative(bundle, path) || '.'] = (stat.mode & 0o777).toString(8);
    if (stat.isDirectory()) for (const entry of readdirSync(path).sort()) visit(join(path, entry));
  };
  visit(bundle);
  return modes;
}

/** The bundle executable, which is the one file a bundle ships at 0755. */
const EXECUTABLE = 'Contents/MacOS/Mission Control';

/** Write the executable every fixture bundle needs, before modes are normalized. */
function writeExecutable(bundle: string) {
  mkdirSync(join(bundle, 'Contents/MacOS'), {recursive: true});
  writeFileSync(join(bundle, EXECUTABLE), '#!/bin/sh\nexit 0\n');
}

/** Ordinary distributed modes: 0755 directories and executable, 0644 everything else. A umask of
 * 077 cannot produce them, and a copy that recreated files at default modes would drop the
 * executable's 0755 to 0644 while leaving every directory looking correct. */
function normalizeModes(bundle: string) {
  const visit = (path: string) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    chmodSync(path, stat.isDirectory() ? 0o755 : 0o644);
    if (stat.isDirectory()) for (const entry of readdirSync(path)) visit(join(path, entry));
  };
  visit(bundle);
  chmodSync(join(bundle, EXECUTABLE), 0o755);
}

function underInstallerUmask(t: test.TestContext) {
  const previous = process.umask(0o077);
  t.after(() => process.umask(previous));
}

function fixture(t: test.TestContext, rename = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'install-copy-modes-')));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const stateDirectory = join(root, 'state'); mkdirSync(stateDirectory);
  const apps = join(root, 'apps'); mkdirSync(apps);
  const app = join(apps, 'Mission Control.app');
  const candidate = join(root, 'candidate.app');
  for (const [path, commit] of [[app, 'a'.repeat(40)], [candidate, 'b'.repeat(40)]] as const) {
    mkdirSync(join(path, 'Contents/Resources/app'), {recursive: true});
    writeFileSync(join(path, 'Contents/Info.plist'), '<key>CFBundleShortVersionString</key><string>1.26.0</string>');
    writeFileSync(join(path, 'Contents/Resources/app/package.json'), JSON.stringify({missionCommit: commit,
      missionInstallMigration: {protocol: 1, automatic: true}, missionInstallTransaction: {protocol: 1, appNaming: 1, receiptSchemas: [1, 2]}}));
    writeExecutable(path);
    normalizeModes(path);
  }
  const oldReceipt = {schema: 1, repo: 'teamupstart/mission-control', releaseTag: 'v1.26.0', installedVersion: '1.26.0',
    installedCommit: 'a'.repeat(40), sourceClone: '/source-that-must-not-be-executed', appPath: app, installedAt: '2026-10-14T00:00:00.000Z'};
  const receiptPath = join(stateDirectory, 'install-receipt.json');
  const oldBytes = `\n${JSON.stringify(oldReceipt, null, 4)}\n\n`;
  writeFileSync(receiptPath, oldBytes);
  const descriptor = prepareStagedInstall({bundle: candidate, receipt: {...oldReceipt,
    ...(rename ? {appPath: join(apps, 'Agent Mission Control.app')} : {}), installedCommit: 'b'.repeat(40)}});
  const ports = {waitForParent: async () => {}, waitForDaemonExit: async () => {},
    launchTarget: async () => ({pid: 987654, identity: 'fixture'}), waitForReady: async () => {},
    stopTarget: async () => {}, launchSource: async () => {}};
  return {root, stateDirectory, app, candidate, descriptor, receiptPath, oldBytes, ports};
}

test('the rename migration commits under the installer umask and keeps the recovery copy at source modes', async (t) => {
  const f = fixture(t, true);
  const sourceModes = bundleModes(f.app);
  const candidateModes = bundleModes(f.candidate);
  const plan = prepareInPlaceInstall({descriptor: f.descriptor, stateDirectory: f.stateDirectory});
  underInstallerUmask(t);
  const result = await runMigration(plan, f.ports);
  assert.equal(result.error, undefined);
  assert.equal(result.committed, true);
  assert.deepEqual(bundleModes(plan.backup!), sourceModes, 'the retained recovery copy lost the source modes');
  assert.equal(inspectBundle(plan.backup!).digest, plan.sourceDigest);
  assert.deepEqual(bundleModes(plan.target), candidateModes, 'the published renamed app lost the staged modes');
  assert.equal(migrationReceipt(f.stateDirectory).appPath, plan.target);
});

test('the in-place migration backs the installed app up at its own modes under the installer umask', async (t) => {
  const f = fixture(t);
  const sourceModes = bundleModes(f.app);
  const candidateModes = bundleModes(f.candidate);
  const plan = prepareInPlaceInstall({descriptor: f.descriptor, stateDirectory: f.stateDirectory});
  underInstallerUmask(t);
  const result = await runMigration(plan, f.ports);
  assert.equal(result.error, undefined);
  assert.equal(result.committed, true);
  assert.deepEqual(bundleModes(plan.backup!), sourceModes, 'the in-place backup lost the installed modes');
  assert.equal(inspectBundle(plan.backup!).digest, plan.sourceDigest);
  assert.deepEqual(bundleModes(plan.target), candidateModes, 'the installed app lost the staged modes');
});

test('an in-place rollback restores the previous app at its original modes', async (t) => {
  const f = fixture(t);
  const sourceModes = bundleModes(f.app);
  const plan = prepareInPlaceInstall({descriptor: f.descriptor, stateDirectory: f.stateDirectory});
  const events: string[] = [];
  const stages: string[] = [];
  (f.ports as {checkpoint?: (stage: string) => void}).checkpoint = (stage) => {stages.push(stage);};
  f.ports.stopTarget = async () => {events.push('stop');};
  f.ports.launchSource = async () => {events.push('restore');};
  f.ports.waitForReady = async () => {throw new Error('readiness failed');};
  underInstallerUmask(t);
  const result = await runMigration(plan, f.ports);
  assert.equal(result.committed, false);
  // Without these the staging copy fails first, nothing was ever swapped, and the restore
  // under test has no displaced app to put back.
  assert.ok(stages.includes('target-staged'), `the attempt failed before the swap: ${stages.join(', ')}`);
  assert.deepEqual(events, ['stop', 'restore'], 'the attempt failed before it reached the rollback');
  assert.equal(readFileSync(f.receiptPath, 'utf8'), f.oldBytes);
  assert.match(readFileSync(join(f.app, 'Contents/Resources/app/package.json'), 'utf8'), /aaaaaaaa/);
  assert.deepEqual(bundleModes(f.app), sourceModes, 'the restored app did not get its original modes back');
  assert.equal(inspectBundle(f.app).digest, plan.sourceDigest);
});

test('the bundle swap copy keeps the staged modes under the installer umask', (t) => {
  const f = fixture(t);
  const candidateModes = bundleModes(f.candidate);
  underInstallerUmask(t);
  assert.equal(installStagedApp(f.descriptor, {stateDirectory: f.stateDirectory}), f.app);
  assert.deepEqual(bundleModes(f.app), candidateModes, 'the swapped-in app lost the staged modes');
  assert.equal(inspectBundle(f.app).digest, f.descriptor.digest);
});

test('the helper runtime snapshot copy keeps the source runtime modes under the installer umask', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'install-copy-modes-helper-')));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const stateDirectory = join(root, 'state'); mkdirSync(stateDirectory);
  const runtimeBundle = join(root, 'Runtime source.app');
  mkdirSync(join(runtimeBundle, 'Contents/Resources/app/scripts'), {recursive: true});
  writeFileSync(join(runtimeBundle, 'Contents/Resources/app/scripts/apply-update.mjs'), 'export {};\n');
  writeExecutable(runtimeBundle);
  normalizeModes(runtimeBundle);
  const elsewhere = join(root, 'elsewhere.mjs');
  writeFileSync(elsewhere, 'export {};\n');
  underInstallerUmask(t);
  // The snapshot copy is the first thing this does, and the helper-source check right after it
  // is where a correctly copied runtime stops. Reaching that check is the assertion: a copy that
  // let the umask through fails earlier, at its own digest comparison.
  await assert.rejects(spawnBundledUpdateHelper({runtimeBundle, helperSource: elsewhere,
    stateDirectory, parentPid: process.pid, logPath: join(stateDirectory, 'update.log'), argv: []}),
    /helper scripts must belong to the copied runtime/);
});

test('the update helper backup and restore copies keep the app at its own modes under the installer umask', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'install-copy-modes-apply-')));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const app = join(root, 'Mission Control.app');
  mkdirSync(join(app, 'Contents/Resources/app'), {recursive: true});
  writeFileSync(join(app, 'Contents/Info.plist'), '<key>CFBundleShortVersionString</key><string>1.26.0</string>');
  writeFileSync(join(app, 'Contents/Resources/app/package.json'), JSON.stringify({missionCommit: 'a'.repeat(40)}));
  writeExecutable(app);
  normalizeModes(app);
  const expected = bundleModes(app);
  const digest = inspectBundle(app).digest;
  underInstallerUmask(t);
  // The detached helper's own copy operation: it takes the backup its rollback restores from.
  const copy = realApplyOperations(join(root, 'update.log')).copy;
  const backup = join(root, 'previous.app');
  copy(app, backup);
  assert.deepEqual(bundleModes(backup), expected, 'the helper backup copy lost the installed modes');
  assert.equal(inspectBundle(backup).digest, digest);
  // The restore direction travels back through the same operation.
  const restored = join(root, 'restored.app');
  copy(backup, restored);
  assert.deepEqual(bundleModes(restored), expected, 'the helper restore copy lost the original modes');
  assert.equal(inspectBundle(restored).digest, digest);
});

test('reopening an in-place update with a live owner exits promptly and leaves the transaction alone', async (t) => {
  const {migrationStartupGate} = await import('../scripts/migration-runtime.mjs');
  const f = fixture(t, false);
  const plan = prepareInPlaceInstall({descriptor: f.descriptor, stateDirectory: f.stateDirectory});
  let gate: {proceed: boolean} | undefined;
  f.ports.waitForParent = async () => {
    gate = await migrationStartupGate({stateDirectory: f.stateDirectory, runningBundle: f.app, port: 1});
    assert.equal(gate.proceed, false);
  };
  const result = await runMigration(plan, f.ports);
  assert.equal(result.committed, true);
  assert.equal(gate?.proceed, false);
});

test('in-place rollback preserves the blocking process diagnostic in the durable outcome', async (t) => {
  const f = fixture(t, false);
  const plan = prepareInPlaceInstall({descriptor: f.descriptor, stateDirectory: f.stateDirectory});
  const reason = 'Mission Control bundle processes did not exit: 39896 (Mission Control Helper; parent 1)';
  f.ports.waitForParent = async () => { throw new Error(reason); };
  const result = await runMigration(plan, f.ports);
  assert.equal(result.committed, false);
  assert.equal(result.error, reason);
  const outcome = JSON.parse(readFileSync(join(f.stateDirectory, 'update-outcome.json'), 'utf8'));
  assert.ok(outcome.message.includes(reason));
  assert.equal(readFileSync(f.receiptPath, 'utf8'), f.oldBytes);
});

for (const work of [
  'workflow check test, attempt check-123, run run-456, session sdk:789',
  'Mission Control orphaned Node utility',
  'Mission Control session sdk:orphan, task task-789',
]) test(`a pre-replacement blocker restores the usable app and names its work in outcome and log: ${work}`, async (t) => {
  const f = fixture(t, false);
  const plan = prepareInPlaceInstall({descriptor: f.descriptor, stateDirectory: f.stateDirectory});
  const handoff = join(f.root, 'handoff.json');
  writeFileSync(handoff, JSON.stringify({plan, parent: {pid: 42, identity: 'parent'}, port: 1}));
  const logPath = join(f.stateDirectory, 'update.log');
  const identity = 'exact check process';
  const mac = {now: () => 0, sleep: async () => {}, identity: () => identity,
    run: async () => ({code: 0, stdout: `39896 1 S ${f.app}/Contents/MacOS/Mission Control\n`}),
  } as unknown as MacAppOps;
  let waits = 0;
  let reopened = '';
  const result = await runApplyUpdate({migrationPlan: handoff, sourceApp: plan.source, targetApp: plan.target,
    sourceClone: plan.oldReceipt.sourceClone!, appPath: f.app, stateDirectory: f.stateDirectory,
    logPath, targetTag: 'v1.26.0', parentPid: 42, stagedBundle: plan.stagedBundle, stagedRevision: plan.stagedRevision,
  }, {...realApplyOperations(logPath), showProgress: () => () => {}, preflightAll: async () => {},
    migrationPorts: () => ({...f.ports, launchSource: async (source) => { reopened = source; }}),
    waitForBundle: async () => {
      waits++;
      await waitForBundleExit(f.app, mac, 0, undefined, [{pid: 39896, fingerprint: processFingerprint(identity)!, group: true, work}]);
    },
  });
  assert.equal(result.ok, false);
  assert.equal(waits, 1, 'rollback must not restart the failed wait against an untouched bundle');
  assert.equal(reopened, f.app, 'the previous app is reopened without manual cleanup or retry');
  assert.equal(readFileSync(f.receiptPath, 'utf8'), f.oldBytes);
  const outcome = JSON.parse(readFileSync(join(f.stateDirectory, 'update-outcome.json'), 'utf8'));
  for (const text of [outcome.message, readFileSync(logPath, 'utf8')]) {
    assert.match(text, /39896/);
    assert.ok(text.includes(work), text);
    assert.doesNotMatch(text, /Close them|retrying|Manual recovery/);
  }
});
