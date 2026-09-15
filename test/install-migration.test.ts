// Exercise the real filesystem transaction at its durable boundaries. No live app,
// operator receipt, agent process, login setting or integration config is touched.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CANONICAL_REPO } from '../src/shared/install-receipt-schema.mjs';
import { migrationStartupGate } from '../scripts/migration-runtime.mjs';
import { readUpdateOutcome } from '../src/main/update-outcome.ts';
import {
  prepareMigration, migrationBundleIdentity, atomicMigrationJson, runMigration,
  readMigrationJournal, migrationReceipt, recoverMigration, repairMigration,
  MIGRATION_JOURNAL, migrationIsCommitted, type MigrationPorts,
} from '../scripts/install-migration.mjs';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'mission-migration-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'Jo sé');
  const systemDirectory = join(root, 'System Applications');
  const stateDirectory = join(home, 'state');
  mkdirSync(stateDirectory, {recursive: true});
  mkdirSync(systemDirectory);
  const source = join(systemDirectory, 'Mission Control.app');
  const stagedBundle = join(root, 'build.app');
  function bundle(path: string, commit: string, automatic = true, protocol: number | null = 1) {
    mkdirSync(join(path, 'Contents/Resources/app'), {recursive: true});
    writeFileSync(join(path, 'Contents/Info.plist'), '<key>CFBundleShortVersionString</key><string>1.17.0</string>');
    atomicMigrationJson(join(path, 'Contents/Resources/app/package.json'), {missionCommit: commit, missionInstallMigration: {protocol, automatic}});
  }
  bundle(source, 'a'.repeat(40));
  bundle(stagedBundle, 'b'.repeat(40));
  const receipt = {schema: 1, repo: CANONICAL_REPO, releaseTag: 'v1.17.0', installedVersion: '1.17.0', installedCommit: 'a'.repeat(40), sourceClone: join(stateDirectory, 'app-src'), appPath: source, installedAt: '2026-09-15T00:00:00.000Z'};
  atomicMigrationJson(join(stateDirectory, 'install-receipt.json'), receipt);
  const args = {receipt, stagedBundle, stagedRevision: migrationBundleIdentity(stagedBundle).revision!, stateDirectory, home, systemDirectory};
  const policy = {home, systemDirectory};
  const plan = prepareMigration(args)!;
  assert.ok(plan);
  const events: string[] = [];
  const ports: MigrationPorts = {
    inventory: {login: false},
    waitForParent: async () => { events.push('parent-gone'); },
    waitForDaemonExit: async () => { events.push('daemon-gone'); },
    launchTarget: async () => {
      events.push('launch-target');
      assert.deepEqual(migrationReceipt(stateDirectory), receipt, 'launch cannot publish a receipt');
      return {pid: 123456, identity: 'test target'};
    },
    waitForReady: async () => {
      events.push('ready');
      assert.deepEqual(migrationReceipt(stateDirectory), receipt, 'readiness is before receipt commit');
    },
    stopTarget: async () => { events.push('stop-target'); },
    launchSource: async () => { events.push('launch-source'); },
  };
  return {root, home, stateDirectory, source, stagedBundle, receipt, plan, policy, ports, events, args, bundle};
}

test('relocation stages beside the personal destination, retains the system app, then commits and repairs forward', async (t) => {
  const f = fixture(t);
  const before = readFileSync(join(f.source, 'Contents/Resources/app/package.json'));
  const result = await runMigration(f.plan, f.ports, {policy: f.policy});
  assert.equal(result.committed, true);
  assert.deepEqual(f.events, ['parent-gone', 'daemon-gone', 'launch-target', 'ready']);
  assert.deepEqual(readFileSync(join(f.source, 'Contents/Resources/app/package.json')), before);
  assert.equal(migrationReceipt(f.stateDirectory).installScope, 'user');
  assert.equal(migrationReceipt(f.stateDirectory).appPath, f.plan.target);
  assert.equal(readMigrationJournal(f.stateDirectory, f.policy)?.stage, 'receipt-committed');
  const broken = await repairMigration(f.stateDirectory, async () => [{id: 'mcp', status: 'pending', message: 'read-back failed'}], {policy: f.policy});
  assert.equal(broken?.stage, 'repair-required');
  assert.equal(migrationReceipt(f.stateDirectory).installScope, 'user');
  const repaired = await repairMigration(f.stateDirectory, async (journal) => {
    assert.equal(journal.repairs[0]?.id, 'mcp');
    return [{id: 'mcp', status: 'complete', message: 'verified'}];
  }, {policy: f.policy});
  assert.equal(repaired?.stage, 'complete');
  let repeats = 0;
  await repairMigration(f.stateDirectory, async () => { repeats++; return []; }, {policy: f.policy});
  assert.equal(repeats, 0);
});

for (const boundary of ['prepared', 'target-reserved', 'target-published', 'target-staged', 'target-ready', 'receipt-renamed', 'receipt-committed']) {
  test(`recovery after helper death at ${boundary} obeys the receipt commit boundary`, async (t) => {
    const f = fixture(t);
    f.ports.checkpoint = (stage) => {
      if (stage === boundary) throw Object.assign(new Error('simulated crash'), {migrationCrash: true});
    };
    await assert.rejects(runMigration(f.plan, f.ports, {policy: f.policy}), /simulated crash/);
    const committed = boundary === 'receipt-renamed' || boundary === 'receipt-committed';
    const recovered = await recoverMigration(f.stateDirectory, f.ports, {policy: f.policy});
    assert.equal(recovered?.stage, committed ? 'receipt-committed' : 'restored');
    assert.equal(existsSync(f.plan.target), committed);
    assert.equal(existsSync(f.source), true);
    assert.equal(f.events.includes('launch-source'), !committed);
    assert.equal(migrationReceipt(f.stateDirectory).appPath, committed ? f.plan.target : f.source);
  });
}

test('pre-commit launch failure restores the original receipt and stops only the target through the identity port', async (t) => {
  const f = fixture(t);
  f.ports.waitForReady = async () => { throw new Error('target exited'); };
  const result = await runMigration(f.plan, f.ports, {policy: f.policy});
  assert.equal(result.committed, false);
  assert.deepEqual(migrationReceipt(f.stateDirectory), f.receipt);
  assert.ok(f.events.includes('stop-target'));
  assert.ok(f.events.includes('launch-source'));
  assert.equal(existsSync(f.plan.target), false);
  assert.equal(readUpdateOutcome(join(f.stateDirectory, 'update-outcome.json'))?.result, 'failure');
  assert.equal(readMigrationJournal(f.stateDirectory, f.policy)?.inventory, null, 'restoration discards sensitive inventory');
});

test('post-helper repair ownership permits old-copy redirect without waiting for the live personal process', async (t) => {
  const f = fixture(t);
  await runMigration(f.plan, f.ports, {policy: f.policy});
  await assert.rejects(migrationStartupGate({stateDirectory: f.stateDirectory, runningBundle: f.source, port: 1, policy: f.policy, timeout: 5}), /helper is still running/);
  await repairMigration(f.stateDirectory, async () => [{id: 'login', status: 'pending', message: 'retry'}], {policy: f.policy});
  assert.equal(readMigrationJournal(f.stateDirectory, f.policy)?.ownerRole, 'recovery');
  assert.deepEqual(await migrationStartupGate({stateDirectory: f.stateDirectory, runningBundle: f.source, port: 1, policy: f.policy, timeout: 5}), {proceed: true, committed: true, fresh: false});
});

test('invalid process identity and malformed repair entries are refused before recovery', async (t) => {
  const f = fixture(t);
  const {journal} = await runMigration(f.plan, f.ports, {policy: f.policy});
  for (const changed of [{owner: {pid: -1, identity: 'invalid'}}, {ownerRole: 'unknown'}, {repairs: [{id: 'login', status: 'invented', message: 'bad'}]}]) {
    atomicMigrationJson(join(f.stateDirectory, MIGRATION_JOURNAL), {...journal, ...changed});
    await assert.rejects(recoverMigration(f.stateDirectory, f.ports, {policy: f.policy}), /Invalid migration journal/);
    assert.equal(migrationReceipt(f.stateDirectory).appPath, f.plan.target);
    assert.equal(f.events.includes('launch-source'), false);
  }
});

test('foreign target, symlink destination, changed staged identity and untrusted policy are refused', async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.home, 'Applications'));
  mkdirSync(f.plan.target);
  writeFileSync(join(f.plan.target, 'foreign'), 'leave me');
  assert.throws(() => prepareMigration(f.args), /already exists/);
  await assert.rejects(runMigration(f.plan, f.ports, {policy: f.policy}), /occupied/);
  assert.equal(readFileSync(join(f.plan.target, 'foreign'), 'utf8'), 'leave me');
  rmSync(join(f.home, 'Applications'), {recursive: true});
  symlinkSync(f.policy.systemDirectory, join(f.home, 'Applications'));
  assert.throws(() => prepareMigration(f.args), /outside|symbolic/);
  rmSync(join(f.home, 'Applications'));
  f.bundle(f.stagedBundle, 'c'.repeat(40));
  const result = await runMigration(f.plan, f.ports, {policy: f.policy});
  assert.equal(result.committed, false);
  assert.match(result.error!, /changed/);
  for (const installScope of ['system', 'custom', 'user'] as const) assert.equal(prepareMigration({...f.args, receipt: {...f.receipt, installScope}}), null);
  assert.equal(prepareMigration({...f.args, receipt: {...f.receipt, repo: 'foreign/repo'}}), null);
});

test('unsupported packaged capability preserves the legacy in-place transition', (t) => {
  const f = fixture(t);
  f.bundle(f.stagedBundle, 'b'.repeat(40), true, null);
  assert.equal(prepareMigration(f.args), null);
  f.bundle(f.stagedBundle, 'b'.repeat(40));
  f.bundle(f.source, 'a'.repeat(40), false);
  assert.equal(prepareMigration(f.args), null, 'unverified release must keep migration disabled');
});

test('receipt edits and replaced target ownership prevent destructive recovery', async (t) => {
  const f = fixture(t);
  f.ports.checkpoint = (stage) => { if (stage === 'target-staged') throw Object.assign(new Error('crash'), {migrationCrash: true}); };
  await assert.rejects(runMigration(f.plan, f.ports, {policy: f.policy}));
  const saved = join(f.root, 'saved-target');
  renameSync(f.plan.target, saved);
  mkdirSync(f.plan.target);
  writeFileSync(join(f.plan.target, 'foreign'), 'unchanged');
  atomicMigrationJson(join(f.stateDirectory, 'install-receipt.json'), {...f.receipt, installScope: 'system'});
  await assert.rejects(recoverMigration(f.stateDirectory, f.ports, {policy: f.policy}), /receipt changed/);
  assert.equal(readFileSync(join(f.plan.target, 'foreign'), 'utf8'), 'unchanged');
  assert.equal(f.events.includes('launch-source'), false);
});

test('corrupt or unsupported journals fail closed and a competing helper writes no outcome or receipt', async (t) => {
  const f = fixture(t);
  atomicMigrationJson(join(f.stateDirectory, MIGRATION_JOURNAL), {plan: {...f.plan, protocol: 999}});
  assert.throws(() => readMigrationJournal(f.stateDirectory, f.policy), /Unsupported/);
  rmSync(join(f.stateDirectory, MIGRATION_JOURNAL));
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  f.ports.waitForParent = () => barrier;
  const first = runMigration(f.plan, f.ports, {policy: f.policy});
  // A second process is represented by its distinct, live claim. Files and lock election
  // remain real; same-process reentrancy is tested separately by the controller.
  const {realHelperLockOperations} = await import('../scripts/update-lock.mjs');
  const lock = realHelperLockOperations();
  lock.pid = process.pid + 1;
  lock.identity = () => 'other';
  lock.isLive = () => true;
  await assert.rejects(runMigration(f.plan, f.ports, {policy: f.policy, lock}), /Another update/);
  assert.deepEqual(migrationReceipt(f.stateDirectory), f.receipt);
  release();
  assert.equal((await first).committed, true);
  assert.equal(migrationIsCommitted(readMigrationJournal(f.stateDirectory, f.policy)!, migrationReceipt(f.stateDirectory)), true);
});
