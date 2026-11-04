import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { darwinCheckIdentity } from '../scripts/darwin-process-identity.mjs';
import { captureUpdateProcessOwners, processFingerprint, readCheckProcessOwners } from '../scripts/update-process-owners.mjs';
import { waitForBundleExit, type MacAppOps } from '../scripts/mac-app-lifecycle.mjs';
import { processIdentity } from '../scripts/update-lock.mjs';

const bundle = '/fixture/Mission Control.app';
const executable = `${bundle}/Contents/Frameworks/Helper.app/Contents/MacOS/Helper`;
const identity = 'Tue Nov 3 10:00:00 2026 /fixture/helper -e shim attempt-123';
const work = 'workflow check test, attempt attempt-123, run run-456, session sdk:789';

function database(t: test.TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'update-process-owner-'));
  t.after(() => rmSync(home, {recursive: true, force: true}));
  const db = new DatabaseSync(join(home, 'harness.db'));
  db.exec(`CREATE TABLE workflow_check_leases (attempt_id TEXT, submission_id TEXT, node_id TEXT,
    supervisor_pid INTEGER, supervisor_start_ticks TEXT, cleanup_state TEXT);
    CREATE TABLE workflow_submissions (id TEXT, run_id TEXT);
    CREATE TABLE workflow_runs (id TEXT, binding_id TEXT);
    CREATE TABLE workflow_bindings (id TEXT, session_id TEXT);
    INSERT INTO workflow_submissions VALUES ('sub-1', 'run-456');
    INSERT INTO workflow_runs VALUES ('run-456', 'binding-1');
    INSERT INTO workflow_bindings VALUES ('binding-1', 'sdk:789');`);
  db.prepare('INSERT INTO workflow_check_leases VALUES (?, ?, ?, ?, ?, ?)')
    .run('attempt-123', 'sub-1', 'test', 42, darwinCheckIdentity(identity), 'held');
  db.close();
  return home;
}

function operations() {
  let now = 0;
  let alive = true;
  const signals: Array<[number, string]> = [];
  const ops: MacAppOps = {
    uid: 501, now: () => now, sleep: async (ms) => { now += ms; },
    run: async () => ({code: 0, stdout: alive ? `42 1 S ${executable}\n` : '1 0 S /sbin/launchd\n'}),
    identity: () => identity,
    kill: (pid, signal) => { signals.push([pid, signal]); if (signal === 'SIGKILL') alive = false; },
    readAck: () => null,
  };
  return {ops, signals};
}

test('update ownership reads the existing lease and retains check, attempt, run and session', (t) => {
  const home = database(t);
  const records = readCheckProcessOwners(home, {identity: () => identity});
  assert.deepEqual(records, [{pid: 42, fingerprint: processFingerprint(identity), group: true, work}]);
  assert.deepEqual(readCheckProcessOwners(home, {identity: () => identity + 'reused'}), []);
  const db = new DatabaseSync(join(home, 'harness.db'), {readOnly: true});
  assert.equal(db.prepare('SELECT cleanup_state FROM workflow_check_leases').get()?.cleanup_state, 'held');
  db.close();
});

test('desktop snapshots capture only proven descendants and omit their secret argv', async (t) => {
  const home = database(t);
  const f = operations();
  f.ops.run = async () => ({code: 0, stdout: `42 1 S ${executable}\n43 10 S ${executable}\n44 1 S ${executable}\n`});
  f.ops.identity = (pid) => pid === 42 ? identity : `Tue Nov 3 10:00:00 2026 process-${pid} --type=renderer SECRET`;
  const parent = {pid: 10, identity: f.ops.identity(10)};
  const records = await captureUpdateProcessOwners({stateDirectory: home, parent, processNames: {43: 'mission-control-daemon'}}, f.ops);
  assert.deepEqual(records.map((row) => row.pid).sort(), [10, 42, 43]);
  assert.equal(records.find((row) => row.pid === 43)?.work, 'Mission Control mission-control-daemon');
  assert.doesNotMatch(JSON.stringify(records), /SECRET/);
});

test('a reused desktop parent PID excludes its descendants but retains independently verified check ownership', async (t) => {
  const home = database(t);
  const f = operations();
  const parent = {pid: 10, identity: 'Tue Nov 3 10:00:00 2026 Mission Control desktop'};
  f.ops.identity = (pid) => pid === 42 ? identity : `Tue Nov 3 10:01:00 2026 replacement-process-${pid}`;
  f.ops.run = async () => ({code: 0, stdout: `42 1 S ${executable}\n43 10 S ${executable}\n`});

  const records = await captureUpdateProcessOwners({stateDirectory: home, parent,
    processNames: {43: 'mission-control-daemon'}}, f.ops);

  assert.deepEqual(records, [{pid: 42, fingerprint: processFingerprint(identity), group: true, work}],
    'only the verified check lease remains; neither the reused desktop nor its child is owned');
});

test('desktop PID reuse during the process-table read cannot authorize the replacement desktop or its children', async (t) => {
  const home = database(t);
  const f = operations();
  const parent = {pid: 10, identity: 'Tue Nov 3 10:00:00 2026 Mission Control desktop'};
  let desktopIdentity = parent.identity;
  f.ops.identity = (pid) => pid === 42 ? identity : pid === 10 ? desktopIdentity : `${identity} child`;
  f.ops.run = async () => {
    desktopIdentity = 'Tue Nov 3 10:01:00 2026 unrelated replacement';
    return {code: 0, stdout: `10 1 S /unrelated\n42 1 S ${executable}\n43 10 S ${executable}\n`};
  };
  const owners = await captureUpdateProcessOwners({stateDirectory: home, parent, processNames: {43: 'daemon'}}, f.ops);
  assert.deepEqual(owners, [{pid: 42, fingerprint: processFingerprint(identity), group: true, work}]);
});

for (const start of ['Tue Nov 3 10:00:00 2026', 'Tue Nov  3 10:00:00 2026']) test(`an orphaned native utility is attributed and cleaned up with macOS start date ${JSON.stringify(start)}`, async (t) => {
  const home = database(t);
  const f = operations();
  const helper = `${bundle}/Contents/Frameworks/Mission Control Helper.app/Contents/MacOS/Mission Control Helper`;
  const userDataDirectory = '/fixture/Application Support/Mission Control';
  const rawIdentity = `${start} ${helper} --type=utility --utility-sub-type=node.mojom.NodeService --user-data-dir=${userDataDirectory} --shared-files`;
  // realMacAppOps uses this identity reader, which normalizes ps column padding
  // before ownership capture separates the date from the command.
  const orphanIdentity = processIdentity(43, () => rawIdentity)!;
  assert.ok(orphanIdentity.startsWith('Tue Nov 3 10:00:00 2026 '));
  const parent = {pid: 10, identity: `${identity} desktop`};
  let alive = true;
  f.ops.identity = (pid) => pid === 10 ? parent.identity : pid === 43 ? orphanIdentity : null;
  f.ops.run = async () => ({code: 0, stdout: alive ? `43 1 S ${helper}\n` : '1 0 S /sbin/launchd\n'});
  f.ops.kill = (pid, signal) => { f.signals.push([pid, signal]); if (signal === 'SIGKILL') alive = false; };
  const owners = await captureUpdateProcessOwners({stateDirectory: home, parent, bundle, userDataDirectory}, f.ops);
  assert.deepEqual(owners.find(owner => owner.pid === 43), {
    pid: 43, fingerprint: processFingerprint(orphanIdentity), group: false, work: 'Mission Control orphaned Node utility',
  });
  const waiting: string[] = [];
  await waitForBundleExit(bundle, f.ops, 12_000, message => waiting.push(message), owners);
  assert.equal(alive, false);
  assert.deepEqual(f.signals, [[43, 'SIGTERM'], [43, 'SIGKILL']]);
  assert.match(waiting[0]!, /43.*Mission Control orphaned Node utility/);
  assert.doesNotMatch(JSON.stringify(owners), /user-data-dir|shared-files/);
});

test('a bundle executable or profile name alone never proves orphan ownership', async (t) => {
  const home = database(t);
  const f = operations();
  const helper = `${bundle}/Contents/Frameworks/Mission Control Helper.app/Contents/MacOS/Mission Control Helper`;
  const userDataDirectory = '/fixture/profile';
  const parent = {pid: 10, identity: `${identity} desktop`};
  const identities: Record<number, string> = {
    43: `Tue Nov 3 10:00:00 2026 ${helper} arbitrary-script.js --user-data-dir=${userDataDirectory}`,
    44: `Tue Nov 3 10:00:00 2026 ${helper} --type=utility --utility-sub-type=node.mojom.NodeService --user-data-dir=${userDataDirectory}-other`,
    45: `Tue Nov 3 10:00:00 2026 /other/helper --type=utility --utility-sub-type=node.mojom.NodeService --user-data-dir=${userDataDirectory}`,
    46: `Tue Nov 3 10:00:00 2026 ${helper} --type=utility --utility-sub-type=node.mojom.NodeService --user-data-dir=${userDataDirectory}`,
  };
  f.ops.identity = pid => pid === 10 ? parent.identity : identities[pid] ?? null;
  f.ops.run = async () => ({code: 0, stdout: `43 1 S ${helper}\n44 1 S ${helper}\n45 1 S /other/helper\n46 999 S ${helper}\n`});
  const owners = await captureUpdateProcessOwners({stateDirectory: home, parent, bundle, userDataDirectory}, f.ops);
  assert.deepEqual(owners.map(owner => owner.pid), [10], 'unrelated runtime use, another profile, another bundle and a live unrelated parent are excluded');
});

test('orphan native service diagnostics distinguish the renderer, graphics and network work', async (t) => {
  const home = database(t);
  const f = operations();
  const helper = `${bundle}/Contents/Frameworks/Mission Control Helper.app/Contents/MacOS/Mission Control Helper`;
  const parent = {pid: 10, identity: `${identity} desktop`};
  for (const [flags, work] of [
    ['--type=renderer', 'Mission Control orphaned dashboard renderer'],
    ['--type=gpu-process', 'Mission Control orphaned graphics service'],
    ['--type=utility --utility-sub-type=network.mojom.NetworkService', 'Mission Control orphaned network service'],
    ['--type=utility --utility-sub-type=unknown', undefined],
  ]) {
    f.ops.identity = pid => pid === 43 ? `Tue Nov 3 10:00:00 2026 ${helper} ${flags} --user-data-dir=/fixture/profile` : parent.identity;
    f.ops.run = async () => ({code: 0, stdout: `43 1 S ${helper}\n`});
    const owners = await captureUpdateProcessOwners({stateDirectory: home, parent, bundle, userDataDirectory: '/fixture/profile'}, f.ops);
    assert.equal(owners.find(owner => owner.pid === 43)?.work, work);
  }
});

test('persisted SDK ownership survives reparenting and identifies the session and task during cleanup', async (t) => {
  const home = database(t);
  const db = new DatabaseSync(join(home, 'harness.db'));
  db.exec('CREATE TABLE sdk_sessions (id TEXT, task_id TEXT, recovery_process_json TEXT)');
  db.prepare('INSERT INTO sdk_sessions VALUES (?, ?, ?)').run('sdk:orphan', 'task-789', JSON.stringify({
    pid: 43, startMs: Date.parse('Tue Nov 3 10:00:00 2026'),
    darwinIdentity: darwinCheckIdentity(`Tue Nov 3 10:00:00 2026 ${executable} sdk-driver.js`),
  }));
  db.close();
  const f = operations();
  const parent = {pid: 10, identity: `${identity} desktop`};
  const sessionIdentity = `Tue Nov 3 10:00:00 2026 ${executable} sdk-driver.js`;
  let alive = true;
  f.ops.identity = pid => pid === 10 ? parent.identity : pid === 43 ? sessionIdentity : null;
  f.ops.run = async () => ({code: 0, stdout: alive ? `43 1 S ${executable}\n` : '1 0 S /sbin/launchd\n'});
  f.ops.kill = (pid, signal) => { f.signals.push([pid, signal]); if (signal === 'SIGKILL') alive = false; };
  const owners = await captureUpdateProcessOwners({stateDirectory: home, parent, bundle}, f.ops);
  assert.match(owners.find(owner => owner.pid === 43)?.work ?? '', /session sdk:orphan, task task-789/);
  const waiting: string[] = [];
  await waitForBundleExit(bundle, f.ops, 12_000, message => waiting.push(message), owners);
  assert.equal(alive, false);
  assert.deepEqual(f.signals, [[43, 'SIGTERM'], [43, 'SIGKILL']]);
  assert.match(waiting[0]!, /43.*session sdk:orphan, task task-789/);

  alive = true;
  f.ops.identity = pid => pid === 43 ? sessionIdentity.replace('10:00:00', '10:01:00') : parent.identity;
  const reused = await captureUpdateProcessOwners({stateDirectory: home, parent, bundle}, f.ops);
  assert.equal(reused.some(owner => owner.pid === 43), false, 'a stale session PID does not own a new process lifetime');
});

for (const storedIdentity of ['original', 'missing']) test(`SDK cleanup refuses same-second PID reuse with ${storedIdentity} persisted identity`, async (t) => {
  const home = database(t);
  const originalIdentity = `Tue Nov 3 10:00:00 2026 ${executable} original-sdk-driver.js`;
  const replacementIdentity = `Tue Nov 3 10:00:00 2026 ${executable} unrelated-command.js`;
  const db = new DatabaseSync(join(home, 'harness.db'));
  db.exec('CREATE TABLE sdk_sessions (id TEXT, task_id TEXT, recovery_process_json TEXT)');
  db.prepare('INSERT INTO sdk_sessions VALUES (?, ?, ?)').run('sdk:old', 'task-old', JSON.stringify({
    pid: 43, startMs: Date.parse('Tue Nov 3 10:00:00 2026'),
    ...(storedIdentity === 'original' ? {darwinIdentity: darwinCheckIdentity(originalIdentity)} : {}),
  }));
  db.close();
  const f = operations();
  const parent = {pid: 10, identity: `${identity} desktop`};
  f.ops.identity = pid => pid === 10 ? parent.identity : pid === 43 ? replacementIdentity : null;
  f.ops.run = async () => ({code: 0, stdout: `43 1 S ${executable}\n`});
  const owners = await captureUpdateProcessOwners({stateDirectory: home, parent, bundle}, f.ops);
  // Exercise authorization all the way through the wait, not just the captured array.
  let failure = '';
  await assert.rejects(waitForBundleExit(bundle, f.ops, 12_000, undefined, owners), (error: Error) => {
    failure = error.message;
    return true;
  });
  assert.deepEqual(f.signals, [], 'a reused PID or legacy lifetime without command identity cannot authorize a signal');
  assert.match(failure, /work ownership could not be verified/);
  assert.equal(owners.some(owner => owner.pid === 43), false);
});

test('the helper automatically terminates an owned stubborn check group and continues', async () => {
  const f = operations();
  const waiting: string[] = [];
  await waitForBundleExit(bundle, f.ops, 12_000, (line) => waiting.push(line), [
    {pid: 42, fingerprint: processFingerprint(identity)!, group: true, work},
  ]);
  assert.deepEqual(f.signals, [[-42, 'SIGTERM'], [-42, 'SIGKILL']]);
  assert.match(waiting[0]!, /attempt-123.*run-456.*sdk:789/);
});

test('processes with identical start and command fingerprints each receive their own cleanup signals', async () => {
  const f = operations();
  const alive = new Set([42, 43]);
  f.ops.run = async () => ({code: 0, stdout: `1 0 S /sbin/launchd\n${[...alive].map(pid => `${pid} 1 S ${executable}\n`).join('')}`});
  f.ops.kill = (pid, signal) => { f.signals.push([pid, signal]); if (signal === 'SIGKILL') alive.delete(pid); };
  await waitForBundleExit(bundle, f.ops, 12_000, undefined, [...alive].map(pid => ({
    pid, fingerprint: processFingerprint(identity)!, group: false, work: 'Mission Control orphaned Node utility',
  })));
  assert.deepEqual(f.signals, [[42, 'SIGTERM'], [43, 'SIGTERM'], [42, 'SIGKILL'], [43, 'SIGKILL']]);
  assert.equal(alive.size, 0);
});

test('the helper cleans up an ordinary owned descendant by signalling only its PID and finishes waiting', async (t) => {
  const home = database(t);
  const f = operations();
  const parent = {pid: 10, identity: 'Tue Nov 3 10:00:00 2026 Mission Control desktop'};
  const descendantIdentity = 'Tue Nov 3 10:00:01 2026 Mission Control renderer';
  let alive = true;
  f.ops.identity = (pid) => pid === parent.pid ? parent.identity : pid === 43 ? descendantIdentity : null;
  f.ops.run = async () => ({code: 0, stdout: alive ? `43 10 S ${executable}\n` : '1 0 S /sbin/launchd\n'});
  f.ops.kill = (pid, signal) => {
    f.signals.push([pid, signal]);
    if (pid === 43 && signal === 'SIGKILL') alive = false;
  };
  const owners = await captureUpdateProcessOwners({stateDirectory: home, parent, processNames: {43: 'dashboard renderer'}}, f.ops);
  assert.deepEqual(owners.find(owner => owner.pid === 43), {
    pid: 43, fingerprint: processFingerprint(descendantIdentity), group: false, work: 'Mission Control dashboard renderer',
  });

  await waitForBundleExit(bundle, f.ops, 12_000, undefined, owners);

  assert.equal(alive, false, 'the wait completes only after the descendant exits');
  assert.deepEqual(f.signals, [[43, 'SIGTERM'], [43, 'SIGKILL']], 'never signal the descendant process group');
});

test('a blocker that resists cleanup retains its work association in the failure without manual cleanup advice', async () => {
  const f = operations();
  f.ops.kill = () => { throw new Error('EPERM'); };
  await assert.rejects(waitForBundleExit(bundle, f.ops, 12_000, undefined, [
    {pid: 42, fingerprint: processFingerprint(identity)!, group: true, work},
  ]), (error: Error) => {
    assert.match(error.message, /42.*workflow check test.*attempt-123.*run-456.*sdk:789/);
    assert.match(error.message, /reopen the previous build automatically/);
    assert.doesNotMatch(error.message, /Close them|retrying|manually/);
    return true;
  });
});

test('a reused or unverified PID is never signalled using another process ownership', async () => {
  const f = operations();
  await assert.rejects(waitForBundleExit(bundle, f.ops, 12_000, undefined, [
    {pid: 42, fingerprint: processFingerprint(identity + 'previous')!, group: true, work},
  ]), /work ownership could not be verified/);
  assert.deepEqual(f.signals, []);
});
