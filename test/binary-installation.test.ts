import assert from 'node:assert/strict';
import test from 'node:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { binaryInstallReceipt, readBinaryReceipt, assertPersistentDestination, parseBinaryInstallArgs } from '../scripts/binary-install-policy.mjs';
import { installBinary, waitForInstalledDaemon } from '../scripts/install-binary.mjs';
import { prepareStagedInstall, installStagedApp, verifyBinaryBuild } from '../scripts/install-staged-app.mjs';
import { resolveInstallDestination } from '../scripts/install-destination.mjs';
import { binaryEnrollmentChoice } from '../src/shared/binary-enrollment.ts';
import { validateReceipt } from '../src/shared/install-receipt-schema.mjs';

const identity = {protocol: 1, repo: 'teamupstart/mission-control', bundleId: 'com.mission-control.app', channel: 'stable', releaseTag: 'v1.2.3', version: '1.2.3', commit: 'a'.repeat(40), platform: 'darwin', arch: 'arm64', minimumSystemVersion: '12.0', helperProtocol: {min: 1, max: 1}};
const manifest = {...identity, assets: [
  {kind: 'dmg', id: '1', name: 'app.dmg', bytes: 100, sha256: 'a'.repeat(64)},
  {kind: 'app-zip', id: '2', name: 'app.zip', bytes: 100, sha256: 'b'.repeat(64)},
]};
test('the packaged CLI refuses host-runtime execution even through a symlinked entry', t => {
  const directory = mkdtempSync(join(tmpdir(), 'binary-cli-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const entry = join(directory, 'entry.mjs');
  symlinkSync(join(process.cwd(), 'scripts/install-binary.mjs'), entry);
  const result = spawnSync(process.execPath, [entry], {encoding: 'utf8'});
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Use scripts\/install.sh/);
});
function fixture(t: test.TestContext) {
  const root = realpathSync(mkdtempSync(join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'binary-install-')));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const home = join(root, 'home'); mkdirSync(home);
  const stateDirectory = join(root, 'state'); mkdirSync(stateDirectory);
  writeFileSync(join(stateDirectory, 'keep-state'), 'untouched operator fixture');
  const bundle = join(root, 'runtime.app');
  mkdirSync(join(bundle, 'Contents/Resources/app'), {recursive: true});
  writeFileSync(join(bundle, 'Contents/Info.plist'), '<key>CFBundleShortVersionString</key><string>1.2.3</string>');
  writeFileSync(join(bundle, 'Contents/Resources/app/package.json'), JSON.stringify({missionBinary: {...identity, receiptSchema: 2}, missionCommit: identity.commit, version: identity.version}));
  const manifestPath = join(root, 'manifest.json'); writeFileSync(manifestPath, JSON.stringify(manifest));
  const verifyPublisher = () => {};
  const prepare = (args: Parameters<typeof prepareStagedInstall>[0]) => prepareStagedInstall(args, {verifyPublisher});
  const installed: string[] = [];
  const ports = {home, stateDirectory, prepare, runtime: {waitForDaemonExit: async () => {}},
    verifyBuild: (path: string, receipt: Parameters<typeof verifyBinaryBuild>[1], publisher: Parameters<typeof verifyBinaryBuild>[2]) => verifyBinaryBuild(path, receipt, publisher, verifyPublisher),
    install: (descriptor: Parameters<typeof installStagedApp>[0], options: Parameters<typeof installStagedApp>[1]) => installStagedApp(descriptor, {...options, verifyPublisher}),
    acquireState: () => () => {}, launch: async (path: string) => {installed.push(path);}};
  const args = {bundle, manifest: manifestPath, scope: null, appsDir: null, dryRun: false, enroll: false};
  return {root, home, stateDirectory, bundle, ports, args, installed, appPath: join(home, 'Applications/Mission Control.app')};
}

test('first binary install uses the shared swap/receipt writer, preserves state, and reruns as managed', async t => {
  const f = fixture(t); const result = await installBinary(f.args, f.ports);
  assert.equal(result.appPath, f.appPath);
  const receipt = readBinaryReceipt(f.stateDirectory)!;
  assert.equal(validateReceipt(receipt), null); assert.equal(receipt.kind, 'binary'); assert.equal(receipt.sourceClone, undefined);
  assert.equal(receipt.installScope, 'user'); assert.deepEqual(f.installed, [f.appPath]);
  assert.equal(readFileSync(join(f.stateDirectory, 'keep-state'), 'utf8'), 'untouched operator fixture');
  const calls: string[] = [];
  await installBinary(f.args, {...f.ports, prepareInPlace: ({descriptor}: {descriptor: {receipt: unknown}}) => {calls.push('prepare'); assert.equal((descriptor.receipt as {appPath: string}).appPath, f.appPath); return {};}, runMigration: async () => {calls.push('journal'); return {committed: true};}});
  assert.deepEqual(calls, ['prepare', 'journal']);
});

test('copied signed app enrollment verifies exact published bytes and writes no source clone', async t => {
  const f = fixture(t); mkdirSync(join(f.home, 'Applications')); cpSync(f.bundle, f.appPath, {recursive: true});
  await assert.rejects(installBinary(f.args, f.ports), /unmanaged app/);
  await installBinary({...f.args, enroll: true}, f.ports);
  assert.equal(readBinaryReceipt(f.stateDirectory)?.kind, 'binary'); assert.deepEqual(f.installed, []);
});

test('enrollment refuses a modified copied app and a different managed destination', async t => {
  const f = fixture(t); mkdirSync(join(f.home, 'Applications')); cpSync(f.bundle, f.appPath, {recursive: true});
  writeFileSync(join(f.appPath, 'extra'), 'not published');
  await assert.rejects(installBinary({...f.args, enroll: true}, f.ports), /exact published app bytes/);
  assert.equal(readBinaryReceipt(f.stateDirectory), null);
});

test('unreadable, newer, foreign and symlink receipts never authorize replacement', t => {
  const f = fixture(t); const path = join(f.stateDirectory, 'install-receipt.json');
  for (const value of ['broken', JSON.stringify({schema: 999}), JSON.stringify({schema: 1, repo: 'foreign/repo'})]) {
    writeFileSync(path, value); assert.throws(() => readBinaryReceipt(f.stateDirectory));
  }
  rmSync(path); symlinkSync(f.args.manifest, path); assert.throws(() => readBinaryReceipt(f.stateDirectory), /bounded regular file/);
});

test('occupied and missing custom destinations fail without altering state', async t => {
  const f = fixture(t);
  await assert.rejects(installBinary({...f.args, appsDir: join(f.root, 'missing')}, f.ports), /does not exist/);
  assert.equal(existsSync(join(f.stateDirectory, 'install-receipt.json')), false);
  assert.throws(() => assertPersistentDestination('/Volumes/Installer/Mission Control.app', () => true), /mounted image/);
  assert.doesNotThrow(() => assertPersistentDestination('/Volumes/External/Apps/Mission Control.app', () => false));
});

test('unknown state owner prevents first install before the bundle or receipt is written', async t => {
  const f = fixture(t);
  await assert.rejects(installBinary(f.args, {...f.ports, acquireState: () => {throw new Error('unrelated state owner');}}), /unrelated state owner/);
  assert.equal(existsSync(f.appPath), false); assert.equal(readBinaryReceipt(f.stateDirectory), null);
});

test('dry runs verify the candidate but create no application or receipt', async t => {
  const f = fixture(t); assert.equal((await installBinary({...f.args, dryRun: true}, f.ports)).dryRun, true);
  assert.equal(existsSync(f.appPath), false); assert.equal(readBinaryReceipt(f.stateDirectory), null);
});

test('schema-1 clone and retained-compiled-installer receipts preserve destination and absent scope', () => {
  for (const sourceClone of ['/state/app-src', '/state/installers/installer-owned']) {
    const previous = {schema: 1 as const, sourceClone, repo: identity.repo, releaseTag: 'v1.0.0', installedVersion: '1.0.0', installedAt: '2026-10-14T00:00:00.000Z', appPath: '/Applications/Mission Control.app'};
    const receipt = binaryInstallReceipt(JSON.stringify(manifest), resolveInstallDestination({receipt: previous}), previous);
    assert.equal(receipt.appPath, previous.appPath); assert.equal(receipt.installScope, undefined); assert.equal(receipt.sourceClone, undefined);
  }
});

test('enrollment choices preserve managed conflicts and never enroll mounted or translocated apps', () => {
  for (const bundle of ['/Volumes/MC/Mission Control.app', '/private/var/folders/test/AppTranslocation/id/d/Mission Control.app']) {
    const state = binaryEnrollmentChoice({bundle, home: '/Users/test', managedPath: null, temporary: true});
    assert.equal(state.action, 'install'); assert.equal(state.destination, '/Users/test/Applications/Mission Control.app');
  }
  assert.equal(binaryEnrollmentChoice({bundle: '/custom/Mission Control.app', home: '/Users/test', managedPath: null}).action, 'enroll');
  assert.equal(binaryEnrollmentChoice({bundle: '/custom/Mission Control.app', home: '/Users/test', managedPath: '/other/Mission Control.app'}).action, null);
  assert.throws(() => parseBinaryInstallArgs(['--bundle','/x','--manifest','/m','--bundle','/other']), /Repeated/);
});

test('first-launch readiness requires the expected daemon, state lock and installed executable', async t => {
  const f = fixture(t);
  const {PORT} = await import('../src/shared/harness-runtime.mjs');
  const receipt = binaryInstallReceipt(JSON.stringify(manifest), resolveInstallDestination({home: f.home}), null);
  writeFileSync(join(f.stateDirectory, 'daemon.lock'), JSON.stringify({pid: 123, port: PORT}));
  const probe = (async () => new Response(JSON.stringify({ok: true, service: 'mission-control', version: '1.2.3', pid: 123}))) as typeof fetch;
  const mac = {run: async () => ({code: 0, stdout: `123 1 S ${f.appPath}/Contents/Frameworks/Helper`})};
  await waitForInstalledDaemon(receipt, f.stateDirectory, mac, {probe, timeout: 1});
  await assert.rejects(waitForInstalledDaemon(receipt, f.stateDirectory, {run: async () => ({code: 0, stdout: '123 1 S /another/app'})}, {probe, timeout: 1}), /did not become ready/);
  writeFileSync(join(f.stateDirectory, 'daemon.lock'), JSON.stringify({pid: 456, port: PORT}));
  await assert.rejects(waitForInstalledDaemon(receipt, f.stateDirectory, mac, {probe, timeout: 1}), /did not become ready/);
});
