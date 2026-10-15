import type { BinaryInstallReceipt } from "../src/shared/install-receipt-schema.mjs";
import type { BinaryIdentity } from "../src/shared/binary-distribution.mjs";
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, existsSync, readdirSync, chmodSync, cpSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { stagingPaths } from '../scripts/app-bundle-swap.mjs';
import { prepareStagedInstall, prepareSourceUpdate, installStagedApp, inspectBundle, requireInstallSpace } from '../scripts/install-staged-app.mjs';
import { prepareInPlaceInstall, runMigration, recoverMigration, migrationReceipt, readMigrationJournal, validateMigrationPlan, atomicMigrationJson, MIGRATION_JOURNAL, type MigrationJournal } from '../scripts/install-migration.mjs';
import { cleanupHelperSnapshots } from '../scripts/update-helper-runtime.mjs';

function fixture(t: test.TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'staged-install-')));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const stateDirectory = join(root, 'state'); mkdirSync(stateDirectory);
  const apps = join(root, 'apps'); mkdirSync(apps);
  const app = join(apps, 'Mission Control.app');
  const candidate = join(root, 'candidate.app');
  for (const [path, commit] of [[app, 'a'.repeat(40)], [candidate, 'b'.repeat(40)]] as const) {
    mkdirSync(join(path, 'Contents/Resources/app'), {recursive: true});
    writeFileSync(join(path, 'Contents/Info.plist'), '<key>CFBundleShortVersionString</key><string>1.26.0</string>');
    writeFileSync(join(path, 'Contents/Resources/app/package.json'), JSON.stringify({missionCommit: commit,
      missionInstallMigration: {protocol: 1, automatic: true}, missionInstallTransaction: {protocol: 1, receiptSchemas: [1, 2]}}));
  }
  const oldReceipt = {schema: 1, repo: 'teamupstart/mission-control', releaseTag: 'v1.26.0', installedVersion: '1.26.0',
    installedCommit: 'a'.repeat(40), sourceClone: '/source-that-must-not-be-executed', appPath: app, installedAt: '2026-10-14T00:00:00.000Z'};
  const receiptPath = join(stateDirectory, 'install-receipt.json');
  const oldBytes = `\n${JSON.stringify(oldReceipt, null, 4)}\n\n`;
  writeFileSync(receiptPath, oldBytes);
  const descriptor = prepareStagedInstall({bundle: candidate, receipt: {...oldReceipt, installedCommit: 'b'.repeat(40)}});
  const events: string[] = [];
  const ports = {waitForParent: async () => {}, waitForDaemonExit: async () => {},
    launchTarget: async () => {events.push('launch'); return {pid: 987654, identity: 'fixture'};},
    waitForReady: async () => {assert.equal(readFileSync(receiptPath, 'utf8'), oldBytes);},
    stopTarget: async () => {events.push('stop');}, launchSource: async () => {events.push('restore');}};
  return {root, stateDirectory, app, candidate, descriptor, receiptPath, oldBytes, ports, events};
}

function finishedSnapshot(journal: MigrationJournal) {
  const {stateDirectory, nonce} = journal.plan;
  const path = join(stateDirectory, 'update-runtimes', `attempt-${nonce}`);
  mkdirSync(path, {recursive: true});
  atomicMigrationJson(join(path, 'owner.json'), {protocol: 1, nonce, transactionNonce: nonce, path, helper: journal.owner});
  atomicMigrationJson(join(path, 'finished.json'), {nonce, ...journal.owner});
  return path;
}

for (const fallback of [false, true]) test(`repeated completed in-place installs reclaim their exact ${fallback ? 'fallback' : 'fixed'} swap sibling`, {
  skip: fallback && (!process.getuid || process.getuid() === 0),
}, async (t) => {
  const f = fixture(t);
  const appsDir = dirname(f.app);
  const paths = stagingPaths({appsDir, pid: process.pid});
  const retained = fallback ? paths.previous : paths.failed;
  const foreign = join(appsDir, '.Mission Control.app.previous-987654321');
  mkdirSync(foreign);
  writeFileSync(join(foreign, 'keep'), 'another transaction');
  if (fallback) {
    mkdirSync(paths.failed);
    writeFileSync(join(paths.failed, 'keep'), 'older retained material');
    chmodSync(paths.failed, 0o500); // Force the swap's documented previous-PID fallback.
  }
  try {
    for (const letter of ['b', 'c']) {
      const pkgPath = join(f.candidate, 'Contents/Resources/app/package.json');
      writeFileSync(pkgPath, JSON.stringify({...JSON.parse(readFileSync(pkgPath, 'utf8')), missionCommit: letter.repeat(40)}));
      const descriptor = prepareStagedInstall({bundle: f.candidate, receipt: {...migrationReceipt(f.stateDirectory), installedCommit: letter.repeat(40)}});
      const plan = prepareInPlaceInstall({descriptor, stateDirectory: f.stateDirectory});
      let snapshot = '';
      const result = await runMigration(plan, {...f.ports, waitForReady: async () => {
        const journal = readMigrationJournal(f.stateDirectory)!;
        assert.equal(journal.retainedSwap?.path, retained, 'record the path actually returned by the swap');
        snapshot = finishedSnapshot(journal);
        // Even a finished/dead marker cannot permit cleanup while the journal is pending.
        cleanupHelperSnapshots(f.stateDirectory, {isLive: () => false});
        assert.ok(existsSync(retained));
        assert.ok(existsSync(plan.backup!));
        assert.ok(existsSync(snapshot));
      }});
      assert.equal(result.committed, true, result.error);
      cleanupHelperSnapshots(f.stateDirectory, {isLive: () => false});
      assert.ok(existsSync(retained), 'receipt commitment alone does not settle recovery');
      assert.equal((await recoverMigration(f.stateDirectory, f.ports))?.stage, 'complete');
      cleanupHelperSnapshots(f.stateDirectory, {isLive: () => true});
      assert.ok(existsSync(retained), 'a live or unknown helper retains its material');
      cleanupHelperSnapshots(f.stateDirectory, {isLive: () => false});
      assert.equal(existsSync(retained), false);
      assert.equal(existsSync(plan.backup!), false);
      assert.equal(existsSync(snapshot), false);
      assert.equal(migrationReceipt(f.stateDirectory).installedCommit, letter.repeat(40));
      const expected = ['Mission Control.app', '.Mission Control.app.previous-987654321', ...(fallback ? ['.Mission Control.app.failed-update'] : [])];
      assert.deepEqual(readdirSync(appsDir).sort(), expected.sort());
      assert.equal(readFileSync(join(foreign, 'keep'), 'utf8'), 'another transaction');
      if (fallback) assert.equal(readFileSync(join(paths.failed, 'keep'), 'utf8'), 'older retained material');
    }
  } finally {
    if (fallback) chmodSync(paths.failed, 0o700);
  }
});

for (const alteration of ['identity', 'bytes']) test(`completed cleanup retains a swap sibling with changed ${alteration}`, async (t) => {
  const f = fixture(t);
  const plan = prepareInPlaceInstall({descriptor: f.descriptor, stateDirectory: f.stateDirectory});
  const result = await runMigration(plan, f.ports);
  const snapshot = finishedSnapshot(result.journal);
  await recoverMigration(f.stateDirectory, f.ports);
  const retained = readMigrationJournal(f.stateDirectory)!.retainedSwap!.path;
  if (alteration === 'identity') {
    renameSync(retained, `${retained}.original`);
    cpSync(`${retained}.original`, retained, {recursive: true, preserveTimestamps: true});
    assert.equal(inspectBundle(retained).digest, plan.sourceDigest);
  } else writeFileSync(join(retained, 'Contents/Info.plist'), 'changed after commitment');
  const changed = inspectBundle(retained);
  cleanupHelperSnapshots(f.stateDirectory, {isLive: () => false});
  assert.deepEqual(inspectBundle(retained), changed);
  assert.ok(existsSync(plan.backup!));
  assert.ok(existsSync(snapshot));
});

test('retained swap records cannot name another path and older journals remain readable', async (t) => {
  const f = fixture(t);
  const plan = prepareInPlaceInstall({descriptor: f.descriptor, stateDirectory: f.stateDirectory});
  const result = await runMigration(plan, f.ports);
  const journal = result.journal;
  assert.ok(journal.retainedSwap);
  atomicMigrationJson(join(f.stateDirectory, MIGRATION_JOURNAL), {...journal, retainedSwap: {...journal.retainedSwap, path: f.app}});
  assert.throws(() => readMigrationJournal(f.stateDirectory), /retained swap/);
  const {retainedSwap: _retainedSwap, ...legacy} = journal;
  atomicMigrationJson(join(f.stateDirectory, MIGRATION_JOURNAL), legacy);
  assert.equal(readMigrationJournal(f.stateDirectory)?.retainedSwap, undefined);
});

test('shared source installation never invokes the retained installer and preserves schema 1', (t) => {
  const f = fixture(t);
  installStagedApp(f.descriptor, {stateDirectory: f.stateDirectory});
  assert.equal(migrationReceipt(f.stateDirectory).schema, 1);
  assert.equal(migrationReceipt(f.stateDirectory).sourceClone, '/source-that-must-not-be-executed');
  assert.match(readFileSync(join(f.app, 'Contents/Resources/app/package.json'), 'utf8'), /bbbbbbbb/);
});

test('direct staged receipt-write failure restores the retained app and exact receipt bytes', (t) => {
  const f = fixture(t);
  const previous = inspectBundle(f.app);
  let swapped = false;
  assert.throws(() => installStagedApp(f.descriptor, {
    stateDirectory: f.stateDirectory,
    checkpoint: (stage) => {
      if (stage !== 'bundle-swapped') return;
      swapped = true;
      assert.equal(inspectBundle(f.app).digest, f.descriptor.digest, 'the new app was actually installed');
      assert.equal(readFileSync(f.receiptPath, 'utf8'), f.oldBytes);
      // Refuse the real atomic writer after the swap without altering the old receipt.
      mkdirSync(`${f.receiptPath}.${process.pid}.tmp`);
    },
  }), /EISDIR/);
  assert.equal(swapped, true);
  assert.deepEqual(inspectBundle(f.app), previous, 'rollback restores all prior app bytes and modes');
  assert.equal(readFileSync(f.receiptPath, 'utf8'), f.oldBytes);
});

for (const failure of ['digest mismatch', 'unreadable bundle']) test(`direct post-swap ${failure} restores the prior app and exact receipt bytes`, (t) => {
  const f = fixture(t);
  const previous = inspectBundle(f.app);
  let swapped = false;
  assert.throws(() => installStagedApp(f.descriptor, {
    stateDirectory: f.stateDirectory,
    checkpoint: (stage) => {
      if (stage !== 'bundle-swapped') return;
      swapped = true;
      assert.equal(inspectBundle(f.app).digest, f.descriptor.digest);
      if (failure === 'digest mismatch') writeFileSync(join(f.app, 'changed-after-swap'), 'corrupted installed copy');
      else rmSync(f.app, {recursive: true});
    },
  }), failure === 'digest mismatch' ? /installed app bytes changed/ : /ENOENT/);
  assert.equal(swapped, true, 'failure occurs after the real replacement');
  assert.deepEqual(inspectBundle(f.app), previous);
  assert.equal(readFileSync(f.receiptPath, 'utf8'), f.oldBytes);
});

test('successful repeated direct installs reclaim only their retained app after receipt publication', (t) => {
  const f = fixture(t);
  const appsDir = dirname(f.app);
  const retained = stagingPaths({appsDir, pid: process.pid}).failed;
  const foreign = join(appsDir, '.Mission Control.app.previous-987654321');
  mkdirSync(foreign);
  writeFileSync(join(foreign, 'keep'), 'another transaction');
  for (let attempt = 0; attempt < 2; attempt++) {
    const previous = inspectBundle(f.app);
    installStagedApp(f.descriptor, {stateDirectory: f.stateDirectory, checkpoint: (stage) => {
      if (stage === 'bundle-swapped') assert.deepEqual(inspectBundle(retained), previous, 'retain rollback until receipt publication');
    }});
    assert.deepEqual(migrationReceipt(f.stateDirectory), f.descriptor.receipt);
    assert.deepEqual(inspectBundle(f.app), inspectBundle(f.candidate));
    assert.equal(existsSync(retained), false);
    assert.deepEqual(readdirSync(appsDir).sort(), ['.Mission Control.app.previous-987654321', 'Mission Control.app']);
    assert.equal(readFileSync(join(foreign, 'keep'), 'utf8'), 'another transaction');
  }
});

test('retained-app cleanup failure reports its path without rolling back a committed direct install', {
  skip: !process.getuid || process.getuid() === 0,
}, (t) => {
  const f = fixture(t);
  const retained = stagingPaths({appsDir: dirname(f.app), pid: process.pid}).failed;
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (message: string) => {warnings.push(message);});
  try {
    installStagedApp(f.descriptor, {stateDirectory: f.stateDirectory, checkpoint: (stage) => {
      if (stage === 'bundle-swapped') chmodSync(retained, 0o500);
    }});
    assert.deepEqual(migrationReceipt(f.stateDirectory), f.descriptor.receipt);
    assert.deepEqual(inspectBundle(f.app), inspectBundle(f.candidate));
    assert.equal(existsSync(retained), true);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0]?.includes(retained));
  } finally {
    if (existsSync(retained)) chmodSync(retained, 0o700);
  }
});

test('in-place plans reject a missing or mismatched kind discriminator', (t) => {
  const f = fixture(t);
  const plan = prepareInPlaceInstall({descriptor: f.descriptor, stateDirectory: f.stateDirectory});
  for (const kind of [undefined, 'relocation']) {
    assert.throws(() => validateMigrationPlan({...plan, kind}), /Invalid in-place/);
  }
  assert.equal(validateMigrationPlan(plan), plan);
});

test('in-place readiness failure restores the exact receipt bytes and prior bundle', async (t) => {
  const f = fixture(t);
  const plan = prepareInPlaceInstall({descriptor: f.descriptor, stateDirectory: f.stateDirectory});
  f.ports.waitForReady = async () => {throw new Error('readiness failed');};
  const result = await runMigration(plan, f.ports);
  assert.equal(result.committed, false);
  assert.equal(readFileSync(f.receiptPath, 'utf8'), f.oldBytes);
  assert.match(readFileSync(join(f.app, 'Contents/Resources/app/package.json'), 'utf8'), /aaaaaaaa/);
  assert.deepEqual(f.events, ['launch', 'stop', 'restore']);
});

test('candidate byte changes and low space fail before mutation', async (t) => {
  const f = fixture(t);
  assert.throws(() => requireInstallSpace([{path: f.root, bytes: 1024}], () => ({bavail: 1, bsize: 1})), /free disk/);
  const plan = prepareInPlaceInstall({descriptor: f.descriptor, stateDirectory: f.stateDirectory});
  writeFileSync(join(f.candidate, 'Contents/Resources/app/payload'), 'changed without changing the root revision');
  await assert.rejects(runMigration(plan, f.ports), /bytes changed/);
  assert.equal(readFileSync(f.receiptPath, 'utf8'), f.oldBytes);
  assert.deepEqual(f.events, []);
});

for (const stage of ['source-backed-up', 'target-staged', 'receipt-renamed']) {
  test(`interrupted in-place install recovers safely at ${stage}`, async (t) => {
    const f = fixture(t);
    const plan = prepareInPlaceInstall({descriptor: f.descriptor, stateDirectory: f.stateDirectory});
    await assert.rejects(runMigration(plan, {...f.ports, checkpoint: (point: string) => {
      if (point === stage) throw Object.assign(new Error('crash'), {migrationCrash: true});
    }}), /crash/);
    const recovered = await recoverMigration(f.stateDirectory, f.ports);
    if (stage === 'receipt-renamed') {
      assert.equal(recovered?.stage, 'complete');
      assert.equal(migrationReceipt(f.stateDirectory).installedCommit, 'b'.repeat(40));
      assert.equal(f.events.includes('restore'), false);
      const retained = recovered!.retainedSwap!.path;
      finishedSnapshot(recovered!);
      cleanupHelperSnapshots(f.stateDirectory, {isLive: () => false});
      assert.equal(existsSync(retained), false, 'forward recovery also releases the recorded swap sibling');
    } else {
      assert.equal(readFileSync(f.receiptPath, 'utf8'), f.oldBytes);
      assert.equal(f.events.at(-1), 'restore');
    }
    assert.ok(!readMigrationJournal(f.stateDirectory) || readMigrationJournal(f.stateDirectory)?.stage === 'complete');
  });
}

test('binary staged publication authenticates matching signed metadata and writes provenance without a clone', (t) => {
  const f = fixture(t);
  const identity: BinaryIdentity = {protocol: 1, repo: 'teamupstart/mission-control', channel: 'stable', releaseTag: 'v1.26.0', version: '1.26.0',
    commit: 'b'.repeat(40), platform: 'darwin', arch: 'arm64', bundleId: 'com.mission-control.app', minimumSystemVersion: '12.0', helperProtocol: {min: 1, max: 1}};
  const pkgPath = join(f.candidate, 'Contents/Resources/app/package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  writeFileSync(pkgPath, JSON.stringify({...pkg, missionBinary: {...identity, receiptSchema: 2}}));
  const {sourceClone: _clone, ...base} = f.descriptor.receipt;
  const receipt: BinaryInstallReceipt = {...base, schema: 2, kind: 'binary', installedCommit: identity.commit, provenance: {manifest: {...identity,
    assets: [{kind: 'app-zip', id: '123', name: 'app.zip', bytes: 1234, sha256: 'c'.repeat(64)}]}, manifestSha256: 'd'.repeat(64), assetId: '123'}};
  let verified = 0;
  const options = {verifyPublisher: () => {verified++;}};
  assert.throws(() => prepareStagedInstall({bundle: f.candidate, receipt}), /trusted Developer ID/);
  const descriptor = prepareStagedInstall({bundle: f.candidate, receipt}, options);
  installStagedApp(descriptor, {stateDirectory: f.stateDirectory, ...options});
  assert.equal(verified, 2, 'publisher check happens at acceptance and mutation');
  const installed = migrationReceipt(f.stateDirectory);
  assert.ok(installed.kind === 'binary');
  assert.equal(installed.sourceClone, undefined);
  assert.deepEqual(installed.provenance, receipt.provenance);
});

test('a competing installer cannot change the receipt or bundle while the journal owns them', async (t) => {
  const f = fixture(t);
  const plan = prepareInPlaceInstall({descriptor: f.descriptor, stateDirectory: f.stateDirectory});
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {entered = resolve;});
  const first = runMigration(plan, {...f.ports, waitForParent: () => {entered(); return new Promise<void>((resolve) => {release = resolve;});}});
  await waiting;
  await assert.rejects(runMigration(plan, f.ports), /in progress/);
  assert.equal(readFileSync(f.receiptPath, 'utf8'), f.oldBytes);
  release();
  assert.equal((await first).committed, true);
});

test('an outcome write failure after commitment retains forward recovery and never launches the old app', async (t) => {
  const f = fixture(t);
  const plan = prepareInPlaceInstall({descriptor: f.descriptor, stateDirectory: f.stateDirectory});
  const result = await runMigration(plan, f.ports);
  assert.equal(result.committed, true);
  mkdirSync(join(f.stateDirectory, 'update-outcome.json'));
  await assert.rejects(recoverMigration(f.stateDirectory, f.ports));
  assert.equal(migrationReceipt(f.stateDirectory).installedCommit, 'b'.repeat(40));
  assert.equal(f.events.includes('restore'), false);
  assert.equal(readMigrationJournal(f.stateDirectory)?.stage, 'receipt-committed');
  const retained = result.journal.retainedSwap!.path;
  const snapshot = finishedSnapshot(result.journal);
  cleanupHelperSnapshots(f.stateDirectory, {isLive: () => false});
  assert.ok(existsSync(retained), 'failed outcome publication retains recovery material');
  assert.ok(existsSync(snapshot));
  rmSync(join(f.stateDirectory, 'update-outcome.json'), {recursive: true});
  assert.equal((await recoverMigration(f.stateDirectory, f.ports))?.stage, 'complete');
});

test('receipt publication failure restores the prior bundle and byte-identical receipt', async (t) => {
  const f = fixture(t);
  const plan = prepareInPlaceInstall({descriptor: f.descriptor, stateDirectory: f.stateDirectory});
  f.ports.waitForReady = async () => {mkdirSync(`${f.receiptPath}.${process.pid}.tmp`);};
  const result = await runMigration(plan, f.ports);
  assert.equal(result.committed, false);
  assert.equal(readFileSync(f.receiptPath, 'utf8'), f.oldBytes);
  assert.match(readFileSync(join(f.app, 'Contents/Resources/app/package.json'), 'utf8'), /aaaaaaaa/);
  assert.equal(f.events.at(-1), 'restore');
});

test('an edit to receipt bytes after acceptance refuses the transaction without mutation', async (t) => {
  const f = fixture(t);
  const plan = prepareInPlaceInstall({descriptor: f.descriptor, stateDirectory: f.stateDirectory});
  writeFileSync(f.receiptPath, JSON.stringify(plan.oldReceipt));
  await assert.rejects(runMigration(plan, f.ports), /changed before.*ownership/);
  assert.deepEqual(f.events, []);
});

test('legacy source targets without embedded commits do not inherit a false prior commit', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.candidate, 'Contents/Resources/app/package.json'), JSON.stringify({version: '1.26.0'}));
  const descriptor = prepareSourceUpdate({receipt: f.descriptor.receipt, bundle: f.candidate, targetTag: 'v1.26.0'});
  assert.equal(descriptor.receipt.installedCommit, undefined);
  assert.equal(descriptor.receipt.schema, 1);
  assert.throws(() => prepareSourceUpdate({receipt: f.descriptor.receipt, bundle: f.candidate, targetTag: 'b'.repeat(40)}), /accepted update/);
});
