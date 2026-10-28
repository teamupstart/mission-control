import assert from 'node:assert/strict';
import test from 'node:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import childProcess, { spawnSync } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { binaryInstallReceipt, readBinaryReceipt, assertPersistentDestination, parseBinaryInstallArgs } from '../scripts/binary-install-policy.mjs';
import { installBinary, waitForInstalledDaemon } from '../scripts/install-binary.mjs';
import { prepareStagedInstall, installStagedApp, verifyBinaryBuild, inspectBundle } from '../scripts/install-staged-app.mjs';
import { resolveInstallDestination } from '../scripts/install-destination.mjs';
import { binaryEnrollmentChoice } from '../src/shared/binary-enrollment.ts';
import { validateReceipt } from '../src/shared/install-receipt-schema.mjs';
import { ensureNativeStateLockAddon } from './helpers/native-state-lock.ts';
import { validateNativeStateLockBinding } from '../src/server/state-ownership-native.ts';
import { claimInstallReceiptWriter, readMigrationJournal } from '../scripts/install-migration.mjs';
import { binaryInstallationPage } from '../src/main/startup-page.ts';

test('the local installation page treats paths and diagnostics as text, not markup', () => {
  const page = binaryInstallationPage({action: 'install', destination: '/Users/<operator & tools>/Applications/Agent Mission Control.app', message: '<script>untrusted()</script>'});
  assert.match(page, /&lt;operator &amp; tools&gt;/);
  assert.match(page, /&lt;script&gt;untrusted\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(page, /<script>/);
});

const nativeAddon = ensureNativeStateLockAddon();
const identity = {protocol: 1, appBundleName: 'Agent Mission Control.app', repo: 'teamupstart/mission-control', bundleId: 'com.mission-control.app', channel: 'stable', releaseTag: 'v1.2.3', version: '1.2.3', commit: 'a'.repeat(40), platform: 'darwin', arch: 'arm64', minimumSystemVersion: '12.0', helperProtocol: {min: 1, max: 1}};
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
  writeFileSync(join(bundle, 'Contents/Resources/app/package.json'), JSON.stringify({missionBinary: {...identity, receiptSchema: 2}, missionCommit: identity.commit, version: identity.version,
    missionInstallMigration: {protocol: 1, automatic: true}, missionInstallTransaction: {protocol: 1, appNaming: 1, receiptSchemas: [1, 2]}}));
  const manifestPath = join(root, 'manifest.json'); writeFileSync(manifestPath, JSON.stringify(manifest));
  const exec = childProcess.execFileSync;
  const native = t.mock.method(childProcess, 'execFileSync', ((command: string, args: readonly string[], options: childProcess.ExecFileSyncOptions) => {
    if (command === '/usr/bin/hdiutil') return 'fixture plist';
    if (command === '/usr/bin/plutil') return JSON.stringify({images: []});
    if (command === '/usr/bin/codesign') {
      assert.ok(args.at(-1)?.startsWith(`${root}/`));
      return '';
    }
    assert.ok(command === '/bin/cp' || command === '/bin/ps', `Unexpected installer command: ${command}`);
    return exec(command, args, options);
  }) as typeof childProcess.execFileSync);
  syncBuiltinESMExports();
  t.after(() => {native.mock.restore(); syncBuiltinESMExports();});
  const verifyPublisher = () => {};
  const prepare = (args: Parameters<typeof prepareStagedInstall>[0]) => prepareStagedInstall(args, {verifyPublisher});
  const installed: string[] = [];
  const ports = {home, stateDirectory, prepare, runtime: {waitForDaemonExit: async () => {}},
    verifyBuild: (path: string, receipt: Parameters<typeof verifyBinaryBuild>[1], publisher: Parameters<typeof verifyBinaryBuild>[2]) => verifyBinaryBuild(path, receipt, publisher, verifyPublisher),
    install: (descriptor: Parameters<typeof installStagedApp>[0], options: Parameters<typeof installStagedApp>[1]) => installStagedApp(descriptor, {...options, verifyPublisher}),
    acquireState: () => () => {}, launch: async (path: string) => {installed.push(path);}};
  const args = {bundle, manifest: manifestPath, scope: null, appsDir: null, dryRun: false, enroll: false};
  return {root, home, stateDirectory, bundle, ports, args, installed, appPath: join(home, 'Applications/Agent Mission Control.app')};
}

function nextRelease(f: ReturnType<typeof fixture>) {
  const next = {...manifest, releaseTag: 'v1.2.4', version: '1.2.4', commit: 'b'.repeat(40)};
  const {assets: _assets, ...nextIdentity} = next;
  const packagePath = join(f.bundle, 'Contents/Resources/app/package.json');
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
  writeFileSync(packagePath, JSON.stringify({...pkg, version: next.version, missionCommit: next.commit,
    missionBinary: {...nextIdentity, receiptSchema: 2}}));
  writeFileSync(join(f.bundle, 'Contents/Info.plist'), `<key>CFBundleShortVersionString</key><string>${next.version}</string>`);
  writeFileSync(f.args.manifest, JSON.stringify(next));
  return next;
}

function replacementPorts(t: test.TestContext, f: ReturnType<typeof fixture>) {
  // Keep installBinary, prepareInPlaceInstall, runMigration, bundle copies and
  // receipt publication real. Only Apple verification and lifecycle responses
  // are simulated; this fixture does not qualify a signed release.
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', {value: 'darwin'});
  const assessment = t.mock.method(childProcess, 'spawnSync', ((command: string, args: readonly string[]) => {
    assert.equal(command, '/usr/sbin/spctl');
    assert.ok(args.at(-1)?.startsWith(`${f.root}/`));
    return {status: 0, stdout: '', stderr: 'source=Notarized Developer ID\n'};
  }) as typeof childProcess.spawnSync);
  syncBuiltinESMExports();
  t.after(() => {
    assessment.mock.restore(); syncBuiltinESMExports();
    Object.defineProperty(process, 'platform', platform);
  });
  const events: string[] = [];
  return {...f.ports, events,
    mac: {uid: process.getuid?.() ?? 501, now: Date.now, run: async (command: string) => {
      if (command === '/bin/ps') return {code: 0, stdout: '1 0 S /sbin/launchd'};
      if (command === '/bin/launchctl') return {code: 0, stdout: 'PID Status Label\n'};
      assert.equal(command, '/usr/bin/lsappinfo');
      return {code: 0, stdout: ''};
    }},
    runtime: {
      waitForDaemonExit: async () => {},
      launchTarget: async () => {events.push('launch'); return {pid: 987654, identity: 'fixture'};},
      waitForReady: async () => {},
      stopTarget: async () => {events.push('stop');},
      launchSource: async (path: string) => {events.push(`restore:${path}`);},
    }};
}

test('first binary install uses the shared swap/receipt writer and preserves state', async t => {
  const f = fixture(t); const result = await installBinary(f.args, f.ports);
  assert.equal(result.appPath, f.appPath);
  const receipt = readBinaryReceipt(f.stateDirectory)!;
  assert.equal(validateReceipt(receipt), null); assert.equal(receipt.kind, 'binary'); assert.equal(receipt.sourceClone, undefined);
  assert.equal(receipt.installScope, 'user'); assert.deepEqual(f.installed, [f.appPath]);
  assert.equal(readFileSync(join(f.stateDirectory, 'keep-state'), 'utf8'), 'untouched operator fixture');
});

test('failed first launch retains the published app, exact receipt and state for forward recovery', async t => {
  const f = fixture(t);
  const expected = inspectBundle(f.bundle);
  const receiptPath = join(f.stateDirectory, 'install-receipt.json');
  let publishedReceipt = '';
  const launch = t.mock.method(childProcess, 'spawnSync', ((command: string, args: readonly string[]) => {
    assert.equal(command, '/usr/bin/open');
    assert.equal(args[0], f.appPath);
    assert.deepEqual(inspectBundle(f.appPath), expected, 'the complete app is installed before launch');
    publishedReceipt = readFileSync(receiptPath, 'utf8');
    const receipt = JSON.parse(publishedReceipt);
    assert.equal(validateReceipt(receipt), null);
    assert.equal(receipt.schema, 2);
    assert.equal(receipt.kind, 'binary');
    assert.equal(receipt.appPath, f.appPath);
    assert.equal(receipt.installScope, 'user');
    assert.equal(receipt.installedCommit, identity.commit);
    assert.deepEqual(receipt.provenance.manifest, manifest);
    return {status: 1, stdout: '', stderr: 'fixture launch refused'};
  }) as typeof childProcess.spawnSync);
  syncBuiltinESMExports();
  t.after(() => {launch.mock.restore(); syncBuiltinESMExports();});
  const mac = {uid: process.getuid?.() ?? 501, now: Date.now, run: async (command: string) => {
    if (command === '/bin/ps') return {code: 0, stdout: '1 0 S /sbin/launchd'};
    if (command === '/bin/launchctl') return {code: 0, stdout: 'PID Status Label\n'};
    assert.ok(command === '/usr/bin/lsappinfo' || command === '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister');
    return {code: 0, stdout: ''};
  }};
  // Use the production launch path, with only the OS command response failing.
  await assert.rejects(installBinary(f.args, {...f.ports, launch: undefined, mac}), /managed app was installed but could not be opened/);
  assert.equal(launch.mock.callCount(), 1);
  assert.deepEqual(inspectBundle(f.appPath), expected);
  assert.equal(readFileSync(receiptPath, 'utf8'), publishedReceipt);
  assert.equal(readFileSync(join(f.stateDirectory, 'keep-state'), 'utf8'), 'untouched operator fixture');
});

for (const scope of ['user', 'custom'] as const) test(`binary rerun replaces the managed ${scope} app and receipt while preserving destination, scope and state`, async t => {
  const f = fixture(t);
  const appsDir = join(f.root, 'custom-apps');
  if (scope === 'custom') mkdirSync(appsDir);
  const installed = await installBinary(scope === 'custom' ? {...f.args, appsDir} : f.args, f.ports);
  const previous = inspectBundle(installed.appPath);
  const receiptPath = join(f.stateDirectory, 'install-receipt.json');
  const previousReceipt = readFileSync(receiptPath, 'utf8');
  const next = nextRelease(f);
  const expected = inspectBundle(f.bundle);
  assert.notEqual(expected.digest, previous.digest);
  const ports = replacementPorts(t, f);
  let ready = false;
  ports.runtime.waitForReady = async () => {
    ready = true;
    assert.deepEqual(inspectBundle(installed.appPath), expected, 'the new app is installed before readiness');
    assert.equal(readFileSync(receiptPath, 'utf8'), previousReceipt, 'the prior receipt remains until readiness');
  };
  // No destination flags: the existing receipt must select the rerun destination.
  assert.deepEqual(await installBinary(f.args, ports), {appPath: installed.appPath, dryRun: false});
  assert.equal(ready, true);
  assert.deepEqual(ports.events, ['launch']);
  assert.deepEqual(inspectBundle(installed.appPath), expected);
  const receipt = readBinaryReceipt(f.stateDirectory)!;
  assert.equal(validateReceipt(receipt), null);
  assert.equal(receipt.kind, 'binary');
  assert.equal(receipt.appPath, installed.appPath);
  assert.equal(receipt.installScope, scope);
  assert.equal(receipt.installedVersion, next.version);
  assert.equal(receipt.installedCommit, next.commit);
  assert.deepEqual(receipt.provenance.manifest, next);
  assert.equal(readFileSync(join(f.stateDirectory, 'keep-state'), 'utf8'), 'untouched operator fixture');
});

for (const source of ['app-src', 'installers/installer-owned']) test(`binary installer replaces a schema-1 old-name ${source} installation while preserving its directory, absent scope and state`, async t => {
  const f = fixture(t);
  const appsDir = join(f.root, 'legacy-apps'); mkdirSync(appsDir);
  const legacyApp = join(appsDir, 'Mission Control.app');
  const renamedApp = join(appsDir, 'Agent Mission Control.app'); cpSync(f.bundle, legacyApp, {recursive: true});
  // This old app advertises neither binary provenance nor either new handshake.
  writeFileSync(join(legacyApp, 'Contents/Resources/app/package.json'), JSON.stringify({version: identity.version, missionCommit: identity.commit}));
  const previous = inspectBundle(legacyApp);
  const sourceClone = join(f.stateDirectory, source); mkdirSync(sourceClone, {recursive: true});
  const supportPath = join(sourceClone, 'install-app.mjs');
  const support = 'throw new Error("The legacy installer must not run");\n';
  writeFileSync(supportPath, support);
  const legacyReceipt = {schema: 1, sourceClone, repo: identity.repo, releaseTag: identity.releaseTag,
    installedVersion: identity.version, installedAt: '2026-10-14T00:00:00.000Z', appPath: legacyApp};
  assert.equal(validateReceipt(legacyReceipt), null);
  const receiptPath = join(f.stateDirectory, 'install-receipt.json');
  const previousReceipt = `${JSON.stringify(legacyReceipt, null, 4)}\n`;
  writeFileSync(receiptPath, previousReceipt);
  const next = nextRelease(f);
  const expected = inspectBundle(f.bundle);
  assert.notEqual(expected.digest, previous.digest);
  const ports = replacementPorts(t, f);
  let ready = false;
  ports.runtime.waitForReady = async () => {
    ready = true;
    assert.deepEqual(inspectBundle(legacyApp), previous, 'old app remains until receipt commitment');
    assert.equal(inspectBundle(renamedApp).digest, expected.digest);
    assert.equal(readFileSync(receiptPath, 'utf8'), previousReceipt, 'keep the legacy receipt until the new app is ready');
  };
  assert.deepEqual(await installBinary(f.args, ports), {appPath: renamedApp, dryRun: false});
  assert.equal(ready, true);
  assert.deepEqual(ports.events, ['launch']);
  assert.equal(existsSync(legacyApp), false);
  assert.equal(inspectBundle(renamedApp).digest, expected.digest);
  const receipt = readBinaryReceipt(f.stateDirectory)!;
  assert.equal(validateReceipt(receipt), null);
  assert.equal(receipt.schema, 2);
  assert.equal(receipt.kind, 'binary');
  assert.equal(receipt.appPath, renamedApp);
  assert.equal(Object.hasOwn(receipt, 'installScope'), false);
  assert.equal(Object.hasOwn(receipt, 'sourceClone'), false);
  assert.equal(receipt.installedVersion, next.version);
  assert.equal(receipt.installedCommit, next.commit);
  assert.deepEqual(receipt.provenance.manifest, next);
  assert.equal(existsSync(f.appPath), false, 'replacement must not silently create a personal installation');
  assert.equal(readFileSync(supportPath, 'utf8'), support, 'retain old support material for recovery');
  assert.equal(readFileSync(join(f.stateDirectory, 'keep-state'), 'utf8'), 'untouched operator fixture');
});

test('failed binary replacement restores the prior app and exact receipt bytes and preserves state', async t => {
  const f = fixture(t);
  await installBinary(f.args, f.ports);
  const previous = inspectBundle(f.appPath);
  const receiptPath = join(f.stateDirectory, 'install-receipt.json');
  // Preserve formatting too, rather than accepting a reconstructed receipt.
  const previousReceipt = `\n${JSON.stringify(readBinaryReceipt(f.stateDirectory), null, 4)}\n\n`;
  writeFileSync(receiptPath, previousReceipt);
  nextRelease(f);
  const expected = inspectBundle(f.bundle);
  assert.notEqual(expected.digest, previous.digest);
  const ports = replacementPorts(t, f);
  let swapped = false;
  ports.runtime.waitForReady = async () => {
    swapped = true;
    assert.deepEqual(inspectBundle(f.appPath), expected, 'failure occurs after the real bundle swap');
    assert.equal(readFileSync(receiptPath, 'utf8'), previousReceipt);
    throw new Error('replacement readiness failed');
  };
  await assert.rejects(installBinary(f.args, ports), /replacement readiness failed/);
  assert.equal(swapped, true);
  assert.deepEqual(ports.events, ['launch', 'stop', `restore:${f.appPath}`]);
  assert.deepEqual(inspectBundle(f.appPath), previous, 'all prior bundle bytes and modes are restored');
  assert.equal(readFileSync(receiptPath, 'utf8'), previousReceipt);
  assert.equal(readFileSync(join(f.stateDirectory, 'keep-state'), 'utf8'), 'untouched operator fixture');
});

test('copied signed app enrollment verifies exact published bytes and writes no source clone', async t => {
  const f = fixture(t); mkdirSync(join(f.home, 'Applications')); cpSync(f.bundle, f.appPath, {recursive: true});
  await assert.rejects(installBinary(f.args, f.ports), /unmanaged app/);
  await installBinary({...f.args, enroll: true}, f.ports);
  assert.equal(readBinaryReceipt(f.stateDirectory)?.kind, 'binary'); assert.deepEqual(f.installed, []);
});

test('enrollment refuses a modified copied app', async t => {
  const f = fixture(t); mkdirSync(join(f.home, 'Applications')); cpSync(f.bundle, f.appPath, {recursive: true});
  writeFileSync(join(f.appPath, 'extra'), 'not published');
  await assert.rejects(installBinary({...f.args, enroll: true}, f.ports), /exact published app bytes/);
  assert.equal(readBinaryReceipt(f.stateDirectory), null);
});

test('enrollment refuses a different managed destination without changing either app or the receipt', async t => {
  const f = fixture(t);
  await installBinary(f.args, f.ports);
  const appsDir = join(f.root, 'copied-apps'); mkdirSync(appsDir);
  const copiedApp = join(appsDir, 'Agent Mission Control.app'); cpSync(f.bundle, copiedApp, {recursive: true});
  const managed = inspectBundle(f.appPath);
  const copied = inspectBundle(copiedApp);
  const receiptPath = join(f.stateDirectory, 'install-receipt.json');
  const previousReceipt = readFileSync(receiptPath, 'utf8');
  assert.equal(validateReceipt(JSON.parse(previousReceipt)), null);
  assert.equal(JSON.parse(previousReceipt).appPath, f.appPath);
  assert.deepEqual(copied, inspectBundle(f.bundle), 'the copied app is an otherwise valid enrollment candidate');
  await assert.rejects(installBinary({...f.args, appsDir, enroll: true}, f.ports), /different managed installation owns this state home/);
  assert.deepEqual(inspectBundle(f.appPath), managed);
  assert.deepEqual(inspectBundle(copiedApp), copied);
  assert.equal(readFileSync(receiptPath, 'utf8'), previousReceipt);
  assert.equal(readFileSync(join(f.stateDirectory, 'keep-state'), 'utf8'), 'untouched operator fixture');
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
  assert.throws(() => assertPersistentDestination('/Volumes/Installer/Agent Mission Control.app', () => true), /mounted image/);
  assert.doesNotThrow(() => assertPersistentDestination('/Volumes/External/Apps/Agent Mission Control.app', () => false));
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
    const previous = {schema: 1 as const, sourceClone, repo: identity.repo, releaseTag: 'v1.0.0', installedVersion: '1.0.0', installedAt: '2026-10-14T00:00:00.000Z', appPath: '/Applications/Agent Mission Control.app'};
    const receipt = binaryInstallReceipt(JSON.stringify(manifest), resolveInstallDestination({receipt: previous}), previous);
    assert.equal(receipt.appPath, previous.appPath); assert.equal(receipt.installScope, undefined); assert.equal(receipt.sourceClone, undefined);
  }
});

test('desktop ZIP receipts share installer policy and bind the downloaded asset and original manifest bytes', () => {
  const previous = {schema: 1 as const, sourceClone: '/state/app-src', repo: identity.repo, releaseTag: 'v1.0.0',
    installedVersion: '1.0.0', installedAt: '2026-10-14T00:00:00.000Z', appPath: '/custom/Agent Mission Control.app', installScope: 'custom' as const};
  const text = JSON.stringify(manifest, null, 2);
  const destination = resolveInstallDestination({receipt: previous});
  const disk = binaryInstallReceipt(text, destination, previous);
  const zip = binaryInstallReceipt(text, destination, previous, disk.installedAt, 'app-zip');
  assert.deepEqual(zip, {...disk, provenance: {...disk.provenance, assetId: '2'}});
  assert.equal(zip.appPath, previous.appPath);
  assert.equal(zip.installScope, 'custom');
  assert.equal(zip.sourceClone, undefined);
  assert.equal(validateReceipt(zip), null);
  assert.notEqual(zip.provenance.manifestSha256, binaryInstallReceipt(JSON.stringify(manifest), destination, previous).provenance.manifestSha256);
});

test('enrollment choices preserve managed conflicts and never enroll mounted or translocated apps', () => {
  for (const bundle of ['/Volumes/MC/Agent Mission Control.app', '/private/var/folders/test/AppTranslocation/id/d/Agent Mission Control.app']) {
    const state = binaryEnrollmentChoice({bundle, home: '/Users/test', managedPath: null, temporary: true});
    assert.equal(state.action, 'install'); assert.equal(state.destination, '/Users/test/Applications/Agent Mission Control.app');
  }
  assert.equal(binaryEnrollmentChoice({bundle: '/custom/Agent Mission Control.app', home: '/Users/test', managedPath: null}).action, 'enroll');
  assert.equal(binaryEnrollmentChoice({bundle: '/custom/Agent Mission Control.app', home: '/Users/test', managedPath: '/other/Agent Mission Control.app'}).action, null);
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

for (const outcome of ['commit', 'rollback', 'recovery'] as const) test(`binary replacement releases its native state probe before ${outcome} launch while retaining receipt ownership`, async t => {
  const f = fixture(t);
  const native = join(f.bundle, 'Contents/Resources/app/dist/native/state-lock.node');
  mkdirSync(join(native, '..'), {recursive: true});
  cpSync(nativeAddon, native);
  const binding = validateNativeStateLockBinding(createRequire(import.meta.url)(native));
  await installBinary(f.args, f.ports);
  const previous = inspectBundle(f.appPath);
  const previousReceipt = readFileSync(join(f.stateDirectory, 'install-receipt.json'), 'utf8');
  nextRelease(f);
  const ports = replacementPorts(t, f);
  const lockPath = join(f.stateDirectory, 'daemon.lock');
  writeFileSync(lockPath, JSON.stringify({pid: 987653, port: 4242}));
  let probed = false;
  let launches = 0;
  const launch = async () => {
    // This is the same native acquisition a replacement or restored daemon needs.
    const handle = binding.acquire(lockPath, 'fixture daemon');
    binding.release(handle);
    launches++;
    assert.throws(() => claimInstallReceiptWriter(f.stateDirectory), /lock|owned|another|progress/i,
      'releasing the daemon probe must not release the install transaction');
  };
  const runtime = {...ports.runtime,
    checkpoint: (stage: string) => {
      if (stage !== 'target-launching') return;
      probed = true;
      assert.throws(() => binding.acquire(lockPath, 'intruder'), {code: 'ELOCKED'},
        'hold the daemon probe until the staged target is validated');
      if (outcome !== 'commit') throw Object.assign(new Error('before launch failure'), {migrationCrash: outcome === 'recovery'});
    },
    launchTarget: async () => {await launch(); return {pid: 987654, identity: 'fixture'};},
    launchSource: launch,
  };
  // Exercise the production acquireInstallerState, using a real native addon in
  // a disposable app. Apple signature and GUI responses remain fixture ports.
  const run = () => installBinary(f.args, {...ports, runtime, acquireState: undefined});
  if (outcome === 'commit') await run();
  else {
    await assert.rejects(run(), /before launch failure/);
    if (outcome === 'recovery') await assert.rejects(run(), /previous installation was recovered/);
    assert.deepEqual(inspectBundle(f.appPath), previous);
    assert.equal(readFileSync(join(f.stateDirectory, 'install-receipt.json'), 'utf8'), previousReceipt);
  }
  assert.equal(probed, true);
  assert.equal(launches, 1);
  assert.equal(readBinaryReceipt(f.stateDirectory)?.installedVersion, outcome === 'commit' ? '1.2.4' : '1.2.3');
  const finalProbe = binding.acquire(lockPath, 'after transaction');
  binding.release(finalProbe);
  assert.equal(readFileSync(join(f.stateDirectory, 'keep-state'), 'utf8'), 'untouched operator fixture');
});

for (const initialLock of ['missing', 'released'] as const) test(`first install acquires a ${initialLock} native state lock and releases it before launch`, async t => {
  const f = fixture(t);
  const native = join(f.bundle, 'Contents/Resources/app/dist/native/state-lock.node');
  mkdirSync(join(native, '..'), {recursive: true});
  cpSync(nativeAddon, native);
  const binding = validateNativeStateLockBinding(createRequire(import.meta.url)(native));
  const lockPath = join(f.stateDirectory, 'daemon.lock');
  if (initialLock === 'released') writeFileSync(lockPath, '');
  let launched = false;
  await installBinary(f.args, {...f.ports, acquireState: undefined,
    runtime: {waitForDaemonExit: async () => {
      assert.throws(() => binding.acquire(lockPath, 'contender'), {code: 'ELOCKED'});
    }},
    launch: async () => {
      const handle = binding.acquire(lockPath, 'new daemon');
      binding.release(handle);
      launched = true;
    },
  });
  assert.equal(launched, true);
  assert.equal(readBinaryReceipt(f.stateDirectory)?.appPath, f.appPath);
  assert.deepEqual(inspectBundle(f.appPath), inspectBundle(f.bundle));
  assert.equal(readFileSync(join(f.stateDirectory, 'keep-state'), 'utf8'), 'untouched operator fixture');
});

test('an old-name schema-2 binary receipt migrates in the same personal folder and retains its original provenance in recovery', async t => {
  const f = fixture(t);
  await installBinary(f.args, f.ports);
  const legacyApp = join(f.home, 'Applications/Mission Control.app');
  const receipt = readBinaryReceipt(f.stateDirectory)!;
  cpSync(f.appPath, legacyApp, {recursive: true}); rmSync(f.appPath, {recursive: true});
  const previous = inspectBundle(legacyApp);
  assert.equal(receipt.kind, 'binary');
  if (receipt.kind !== 'binary') throw new Error('Expected binary receipt');
  const legacyManifest = structuredClone(receipt.provenance.manifest);
  delete legacyManifest.appBundleName;
  const old = {...receipt, appPath: legacyApp, provenance: {...receipt.provenance, manifest: legacyManifest}};
  const exact = `\n${JSON.stringify(old, null, 4)}\n`;
  writeFileSync(join(f.stateDirectory, 'install-receipt.json'), exact);
  nextRelease(f);
  const ports = replacementPorts(t, f);
  assert.deepEqual(await installBinary(f.args, ports), {appPath: f.appPath, dryRun: false});
  const journal = readMigrationJournal(f.stateDirectory)!;
  assert.equal(journal.plan.oldReceiptText, exact);
  assert.deepEqual(inspectBundle(journal.plan.backup!), previous);
  assert.equal(existsSync(legacyApp), false);
  assert.equal(readBinaryReceipt(f.stateDirectory)!.appPath, f.appPath);
  assert.equal(readFileSync(join(f.stateDirectory, 'keep-state'), 'utf8'), 'untouched operator fixture');
});

test('a layout without the rename capability cannot downgrade a renamed installation', t => {
  const f = fixture(t);
  const original = {...manifest}; delete (original as {appBundleName?: string}).appBundleName;
  assert.throws(() => binaryInstallReceipt(JSON.stringify(original), resolveInstallDestination({home: f.home}), null), /older binary cannot maintain the renamed installation/);
});
