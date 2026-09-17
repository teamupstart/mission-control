// Exercise the real filesystem transaction at its durable boundaries. No live app,
// operator receipt, agent process, login setting or integration config is touched.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { processIdentity, processIsAlive } from '../scripts/update-lock.mjs';
import { removeMigrationSourceLogin } from '../src/main/migration-integration-ports.ts';
import { CANONICAL_REPO } from '../src/shared/install-receipt-schema.mjs';
import { migrationStartupGate, migrationRuntimePorts, boundedMigrationWait } from '../scripts/migration-runtime.mjs';
import { readUpdateOutcome } from '../src/main/update-outcome.ts';
import {
  prepareMigration, migrationBundleIdentity, atomicMigrationJson, runMigration,
  readMigrationJournal, migrationReceipt, recoverMigration, repairMigration,
  MIGRATION_JOURNAL, type MigrationPorts,
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

test('ownership refuses a replaced source even when its commit and version still match', async (t) => {
  const f = fixture(t);
  renameSync(f.source, `${f.source}.recorded`);
  f.bundle(f.source, f.plan.sourceIdentity.commit!);
  const replacement = migrationBundleIdentity(f.source);
  assert.equal(replacement.commit, f.plan.sourceIdentity.commit);
  assert.equal(replacement.version, f.plan.sourceIdentity.version);
  assert.notEqual(replacement.revision, f.plan.sourceIdentity.revision);
  await assert.rejects(runMigration(f.plan, f.ports, {policy: f.policy}), /changed before.*ownership/);
  assert.deepEqual(f.events, []);
  assert.equal(existsSync(f.plan.target), false);
  assert.equal(existsSync(join(f.stateDirectory, MIGRATION_JOURNAL)), false);
  assert.deepEqual(migrationReceipt(f.stateDirectory), f.receipt);
});

for (const when of ['before recovery', 'while stopping the target'] as const) {
  test(`recovery refuses a source revision changed ${when}`, async (t) => {
    const f = fixture(t);
    f.ports.checkpoint = (stage) => {if (stage === 'target-staged') throw Object.assign(new Error('crash'), {migrationCrash: true});};
    await assert.rejects(runMigration(f.plan, f.ports, {policy: f.policy}), /crash/);
    const replace = () => {
      renameSync(f.source, `${f.source}.recorded`);
      f.bundle(f.source, f.plan.sourceIdentity.commit!);
      assert.equal(migrationBundleIdentity(f.source).version, f.plan.sourceIdentity.version);
      assert.notEqual(migrationBundleIdentity(f.source).revision, f.plan.sourceIdentity.revision);
    };
    if (when === 'before recovery') replace();
    else f.ports.stopTarget = async () => {replace();};
    await assert.rejects(recoverMigration(f.stateDirectory, f.ports, {policy: f.policy}), /retained system app changed/);
    assert.equal(f.events.includes('launch-source'), false);
    assert.equal(existsSync(f.plan.target), true);
    assert.equal(readMigrationJournal(f.stateDirectory, f.policy)?.stage, 'target-staged');
    assert.deepEqual(migrationReceipt(f.stateDirectory), f.receipt);
  });
}

test('migration cannot take ownership without a recorded source revision', async (t) => {
  const f = fixture(t);
  f.plan.sourceIdentity.revision = null;
  await assert.rejects(runMigration(f.plan, f.ports, {policy: f.policy}), /source.*revision/);
  assert.deepEqual(f.events, []);
});

for (const boundary of ['before commit', 'after commit'] as const) {
  for (const damage of ['missing', 'truncated', 'directory'] as const) {
    test(`an unreadable ${damage} receipt ${boundary} records manual recovery without relaunching`, async (t) => {
      const f = fixture(t);
      const path = join(f.stateDirectory, 'install-receipt.json');
      const fail = () => {
        if (damage === 'truncated') writeFileSync(path, '{');
        else {
          rmSync(path);
          if (damage === 'directory') mkdirSync(path);
        }
        throw new Error('injected migration failure');
      };
      if (boundary === 'before commit') f.ports.waitForReady = async () => {fail();};
      else f.ports.checkpoint = (stage) => {if (stage === 'receipt-renamed') fail();};
      const result = await runMigration(f.plan, f.ports, {policy: f.policy});
      assert.equal(result.committed, false);
      assert.match(result.error!, /receipt.*could not be read/i);
      assert.match(result.error!, /Manual recovery is required/);
      assert.match(result.diagnostic!, /injected migration failure.*Receipt read failed:/);
      assert.equal(f.events.includes('stop-target'), false);
      assert.equal(f.events.includes('launch-source'), false);
      assert.equal(existsSync(f.source), true);
      assert.equal(existsSync(f.plan.target), true);
      const outcome = readUpdateOutcome(join(f.stateDirectory, 'update-outcome.json'));
      assert.equal(outcome?.result, 'failure');
      assert.match(outcome!.message, /receipt.*could not be read/i);
      assert.ok(!outcome!.message.includes(f.stateDirectory));
    });
  }
}

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

test('a launch not yet recorded cannot delete its bundle or relaunch the source during recovery', async (t) => {
  const f = fixture(t);
  f.ports.launchTarget = async () => { throw Object.assign(new Error('died after spawn'), {migrationCrash: true}); };
  await assert.rejects(runMigration(f.plan, f.ports, {policy: f.policy}), /died after spawn/);
  await assert.rejects(recoverMigration(f.stateDirectory, {...f.ports, stopTarget: migrationRuntimePorts({port: 1}).stopTarget}, {policy: f.policy}), /launch.*identity/);
  assert.equal(existsSync(f.plan.target), true);
  assert.equal(f.events.includes('launch-source'), false);
  assert.deepEqual(migrationReceipt(f.stateDirectory), f.receipt);
});

test('the target-owned launch record recovers a real child after the helper dies before journal publication', async (t) => {
  const f = fixture(t);
  let pid = 0;
  const modulePath = new URL('../scripts/migration-runtime.mjs', import.meta.url).href;
  f.ports.launchTarget = async () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `import {recordMigrationLaunch} from ${JSON.stringify(modulePath)}; recordMigrationLaunch(${JSON.stringify(f.plan)}); process.send('recorded'); setInterval(()=>{},1000);`], {stdio: ['ignore', 'ignore', 'inherit', 'ipc']});
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
    await new Promise<void>((resolve, reject) => { child.once('message', () => resolve()); child.once('error', reject); child.once('exit', () => reject(new Error('fixture child exited'))); });
    pid = child.pid!;
    return {pid, identity: processIdentity(pid)!};
  };
  f.ports.checkpoint = (stage) => { if (stage === 'target-launched') throw Object.assign(new Error('helper died'), {migrationCrash: true}); };
  await assert.rejects(runMigration(f.plan, f.ports, {policy: f.policy}), /helper died/);
  assert.equal(readMigrationJournal(f.stateDirectory, f.policy)?.targetProcess, null);
  assert.equal(processIsAlive(pid), true);
  const recovered = await recoverMigration(f.stateDirectory, {...f.ports, stopTarget: migrationRuntimePorts({port: 1}).stopTarget}, {policy: f.policy});
  assert.equal(recovered?.stage, 'restored');
  await boundedMigrationWait(() => !processIsAlive(pid), 'fixture child was not reaped', {timeout: 2000});
  assert.equal(processIsAlive(pid), false);
  assert.equal(existsSync(f.plan.target), false);
  assert.equal(f.events.includes('launch-source'), true);
});

test('login cleanup requires the committed recovery parent, exact source and nonce', async (t) => {
  const f = fixture(t);
  let enabled = true;
  let writes = 0;
  const app = {getLoginItemSettings: () => ({openAtLogin: enabled}), setLoginItemSettings: () => {enabled = false; writes++;}} as unknown as Parameters<typeof removeMigrationSourceLogin>[0]['app'];
  const options = {stateDirectory: f.stateDirectory, runningBundle: f.source, nonce: f.plan.nonce, policy: f.policy, app, parentPid: process.pid};
  assert.throws(() => removeMigrationSourceLogin(options), /matching committed/);
  await runMigration(f.plan, f.ports, {policy: f.policy});
  assert.throws(() => removeMigrationSourceLogin(options), /matching committed/);
  await repairMigration(f.stateDirectory, async () => {
    assert.throws(() => removeMigrationSourceLogin({...options, nonce: 'stale'}), /matching committed/);
    assert.throws(() => removeMigrationSourceLogin({...options, parentPid: process.pid + 1}), /matching committed/);
    assert.throws(() => removeMigrationSourceLogin({...options, runningBundle: f.plan.target}), /matching committed/);
    assert.equal(writes, 0);
    removeMigrationSourceLogin(options);
    removeMigrationSourceLogin(options);
    assert.equal(writes, 1);
    assert.equal(enabled, false);
    f.bundle(f.source, 'c'.repeat(40));
    assert.throws(() => removeMigrationSourceLogin(options), /source changed/);
    return [];
  }, {policy: f.policy});
});

for (const failure of ['stop', 'source', 'receipt'] as const) {
  test(`failed ${failure} recovery records both errors without escaping or launching an unverified source`, async (t) => {
    const f = fixture(t);
    f.ports.waitForReady = async () => {
      if (failure === 'source') f.bundle(f.source, 'c'.repeat(40));
      if (failure === 'receipt') atomicMigrationJson(join(f.stateDirectory, 'install-receipt.json'), {...f.receipt, installScope: 'system'});
      throw new Error('readiness failed');
    };
    if (failure === 'stop') f.ports.stopTarget = async () => { throw new Error('stop refused'); };
    const result = await runMigration(f.plan, f.ports, {policy: f.policy});
    assert.equal(result.committed, false);
    assert.match(result.error!, /readiness failed.*recovery failed/i);
    const outcome = readUpdateOutcome(join(f.stateDirectory, 'update-outcome.json'));
    assert.equal(outcome?.result, 'failure');
    assert.match(outcome!.message, /readiness failed.*recovery failed/i);
    assert.equal(f.events.includes('launch-source'), false);
    assert.equal(existsSync(f.plan.target), true);
  });
}

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
  // A second process is represented by its distinct, live claim. Files and lock election
  // remain real; same-process reentrancy is tested separately by the controller.
  const {realHelperLockOperations, claimEntryName, HELPER_LOCK_DIR_NAME} = await import('../scripts/update-lock.mjs');
  const lock = realHelperLockOperations();
  const directory = join(f.stateDirectory, HELPER_LOCK_DIR_NAME);
  const foreign = {pid: process.pid + 1, identity: 'other', createdAtMs: 1};
  mkdirSync(directory);
  writeFileSync(join(directory, claimEntryName(foreign)), JSON.stringify(foreign));
  lock.isLive = () => true;
  await assert.rejects(runMigration(f.plan, f.ports, {policy: f.policy, lock}), /Another update/);
  assert.deepEqual(migrationReceipt(f.stateDirectory), f.receipt);
  assert.deepEqual(f.events, []);
  assert.equal(existsSync(f.plan.target), false);
  assert.equal(existsSync(join(f.stateDirectory, 'update-outcome.json')), false);
  assert.equal(existsSync(join(f.stateDirectory, MIGRATION_JOURNAL)), false);
  assert.equal(existsSync(join(directory, claimEntryName(foreign))), true);
});
