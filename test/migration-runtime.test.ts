// Readiness is a nonce/process/build/state tuple, not the success of an `open` call.
// These tests exercise the real timeout and OS identity ports with disposable files.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { processIdentity } from '../scripts/update-lock.mjs';
import { atomicMigrationJson, MIGRATION_ACK, MIGRATION_LAUNCH, MIGRATION_TIMEOUT_MS, type MigrationJournal } from '../scripts/install-migration.mjs';
import { COMMAND_TIMEOUT_MS, type MacAppOps } from '../scripts/mac-app-lifecycle.mjs';
import { boundedMigrationWait, migrationRuntimePorts, migrationStartupGate, sameMigrationProcess, verifyMigrationAssets } from '../scripts/migration-runtime.mjs';
import { migrationPlanFixture } from './helpers/migration-plan.ts';

function fixture(t: test.TestContext) {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'mission-readiness-'));
  t.after(() => rmSync(stateDirectory, {recursive: true, force: true}));
  const receipt = {schema: 1, repo: 'teamupstart/mission-control', releaseTag: 'v1.2.3', installedVersion: '1.2.3', sourceClone: '/source', appPath: '/Applications/Mission Control.app', installedAt: '2026-09-15T00:00:00.000Z'};
  const plan = {...migrationPlanFixture(receipt), stateDirectory};
  const identity = processIdentity(process.pid)!;
  assert.ok(identity);
  const journal: MigrationJournal = {plan, owner: {pid: process.pid, identity}, ownerRole: 'helper', stage: 'target-staged', repairs: [], inventory: {}, targetProcess: {pid: process.pid, identity}};
  const ack = {nonce: plan.nonce, pid: process.pid, identity, bundle: plan.target, commit: plan.targetIdentity.commit, stateDirectory};
  return {stateDirectory, journal, ack};
}

function launchFixture(t: test.TestContext) {
  const f = fixture(t);
  const calls: Array<{command: string; args: string[]}> = [];
  const mac: MacAppOps = {
    uid: 501, now: Date.now, sleep: async () => {}, identity: processIdentity,
    kill: () => { throw new Error('no signal'); }, readAck: () => null,
    run: async (command, args) => {
      calls.push({command, args});
      return {code: 0, stdout: command.endsWith('/ps') ? '1 0 S /sbin/launchd\n'
        : command.endsWith('/launchctl') ? 'PID\tStatus\tLabel\n' : ''};
    },
  };
  return {...f, mac, calls, ports: migrationRuntimePorts({port: 1, timeout: 5, mac})};
}

test('migration launch opens the exact target and nonce through LaunchServices and accepts its matching journal', async (t) => {
  const f = launchFixture(t);
  const run = f.mac.run;
  f.mac.run = async (command, args, timeout) => {
    if (command === '/usr/bin/open') atomicMigrationJson(join(f.stateDirectory, MIGRATION_LAUNCH), f.ack);
    return run(command, args, timeout);
  };
  assert.deepEqual(await f.ports.launchTarget(f.journal.plan), {pid: f.ack.pid, identity: f.ack.identity});
  assert.deepEqual(f.calls.filter((call) => call.command === '/usr/bin/open'), [
    {command: '/usr/bin/open', args: [f.journal.plan.target, '--env', `MISSION_HOME=${f.stateDirectory}`, '--args', '--mission-migration', f.journal.plan.nonce]},
  ]);
  assert.ok(f.calls[0]?.command.endsWith('/lsregister'));
  assert.deepEqual(f.calls[0]?.args, ['-f', f.journal.plan.target]);
  assert.ok(!f.calls.some((call) => call.command.includes('/Contents/MacOS/')));
});

test('migration open gets COMMAND_TIMEOUT_MS, so an open slower than the former 5s still launches', async (t) => {
  // Modeled on the real ops: an open slower than the budget it was handed is killed and
  // rejects; otherwise LaunchServices takes the request and the target registers itself.
  for (const [duration, outcome] of [[7_000, 'launches'], [COMMAND_TIMEOUT_MS + 1, 'rejects']] as const) {
    await t.test(`${duration}ms ${outcome}`, async (t) => {
      const f = launchFixture(t);
      const budgets: number[] = [];
      const run = f.mac.run;
      f.mac.run = async (command, args, timeout) => {
        if (command !== '/usr/bin/open') return run(command, args, timeout);
        budgets.push(timeout ?? -1);
        if (duration > (timeout ?? 0)) throw new Error('Could not inspect macOS launch state within the time limit.');
        atomicMigrationJson(join(f.stateDirectory, MIGRATION_LAUNCH), f.ack);
        return run(command, args, timeout);
      };
      const launched = f.ports.launchTarget(f.journal.plan);
      if (outcome === 'launches') assert.deepEqual(await launched, {pid: f.ack.pid, identity: f.ack.identity});
      else await assert.rejects(launched, {message: 'Could not inspect macOS launch state within the time limit.'});
      assert.deepEqual(budgets, [COMMAND_TIMEOUT_MS]);
    });
  }
});

test('the migration launchd sweep gets the migration budget, not the former 15s inspection cap', async (t) => {
  // A step that runs out of time rejects rather than retrying, so the launchd sweep must be
  // handed the budget the migration actually has, not `inspectAppLaunch`'s fixed default.
  const f = launchFixture(t);
  const budgets = new Map<string, number[]>();
  const run = f.mac.run;
  f.mac.run = async (command, args, timeout) => {
    const name = command.split('/').at(-1) ?? command;
    budgets.set(name, [...(budgets.get(name) ?? []), timeout ?? -1]);
    if (command === '/usr/bin/open') atomicMigrationJson(join(f.stateDirectory, MIGRATION_LAUNCH), f.ack);
    return run(command, args, timeout);
  };
  await f.ports.launchTarget(f.journal.plan);
  // `inspectAppLaunch` turns its timeout into a deadline and hands each probe what REMAINS, and
  // this fixture runs on the real clock, so a probe is offered 120000ms or a millisecond or two
  // less depending on scheduling. An exact equality would make this test load-sensitive, so it
  // asserts what the fix guarantees: the migration's budget rather than the fixed cap.
  const sweep = (name: string): number => {
    const seen = budgets.get(name) ?? [];
    assert.ok(seen.length >= 1, `the sweep makes a ${name} read`);
    return Math.max(...seen);
  };
  for (const name of ['ps', 'launchctl', 'lsappinfo']) {
    const offered = sweep(name);
    assert.ok(offered > COMMAND_TIMEOUT_MS,
      `${name} clears the former fixed cap: ${offered}ms must exceed ${COMMAND_TIMEOUT_MS}ms`);
    assert.ok(offered <= MIGRATION_TIMEOUT_MS,
      `${name} never exceeds the migration budget: ${offered}ms`);
    assert.ok(MIGRATION_TIMEOUT_MS - offered < 1_000,
      `${name} is offered essentially the whole migration budget: ${offered}ms`);
  }
  // The ports' `timeout` bounds waiting for a state change and the fixture sets it to 5ms.
  // It must never become the budget for one OS command.
  assert.ok(!budgets.get('ps')?.includes(5), 'a short wait deadline must not shrink a command budget');
});

test('migration launch reports open failure even if a matching launch journal exists', async (t) => {
  const f = launchFixture(t);
  atomicMigrationJson(join(f.stateDirectory, MIGRATION_LAUNCH), f.ack);
  const run = f.mac.run;
  f.mac.run = async (command, args, timeout) => command === '/usr/bin/open'
    ? {code: 1, stdout: 'private diagnostic'} : run(command, args, timeout);
  await assert.rejects(f.ports.launchTarget(f.journal.plan), {message: 'LaunchServices could not open the migration app.'});
});

test('migration launch times out when its journal is missing or its launch tuple never matches', async (t) => {
  for (const changed of [null, {nonce: 'stale'}, {bundle: '/other.app'}, {stateDirectory: '/other-state'},
    {commit: 'c'.repeat(40)}, {identity: 'reused PID'}, {identity: ''}, {pid: 2147483647}]) {
    await t.test(JSON.stringify(changed), async (t) => {
      const f = launchFixture(t);
      if (changed) atomicMigrationJson(join(f.stateDirectory, MIGRATION_LAUNCH), {...f.ack, ...changed});
      await assert.rejects(f.ports.launchTarget(f.journal.plan), {
        message: 'The personal app did not register its launch. Check LaunchServices before recovery.',
      });
      assert.equal(f.calls.filter((call) => call.command === '/usr/bin/open').length, 1);
    });
  }
});

test('only the intended live process and exact acknowledgment tuple establish readiness', async (t) => {
  const f = fixture(t);
  const ports = migrationRuntimePorts({port: 1, timeout: 5, mac: {
    uid: 501, now: Date.now, sleep: async () => {}, identity: processIdentity, kill: () => {}, readAck: () => null,
    run: async (command) => ({code: 0, stdout: command.endsWith("lsappinfo")
      ? `1) "Mission Control" ASN:0x0-0x123:\n bundleID="com.mission-control.app"\n bundle path="${f.journal.plan.target}"\n pid = ${process.pid} type="Foreground"\n`
      : `${process.pid} 1 S ${f.journal.plan.target}/Contents/MacOS/Mission Control\n`}),
  }});
  for (const changed of [{nonce: 'stale'}, {pid: process.pid + 1}, {identity: 'reused PID'}, {commit: 'c'.repeat(40)}, {stateDirectory: '/another-state'}, {bundle: '/another-app'}]) {
    atomicMigrationJson(join(f.stateDirectory, MIGRATION_ACK), {...f.ack, ...changed});
    await assert.rejects(ports.waitForReady(f.journal), /timeout/);
  }
  atomicMigrationJson(join(f.stateDirectory, MIGRATION_ACK), f.ack);
  await ports.waitForReady(f.journal);
  await assert.rejects(ports.waitForReady({...f.journal, targetProcess: {pid: 2147483647, identity: 'gone'}}), /exited/);
});

test('reused PID is not signalled; missing assets and a launch without its journal cannot start', async (t) => {
  const f = fixture(t);
  assert.equal(sameMigrationProcess({pid: process.pid, identity: 'different process'}), false);
  await migrationRuntimePorts({port: 1}).stopTarget({...f.journal, targetProcess: {pid: process.pid, identity: 'different process'}});
  assert.throws(() => verifyMigrationAssets(f.journal.plan.target));
  await assert.rejects(migrationStartupGate({stateDirectory: f.stateDirectory, runningBundle: f.journal.plan.target, nonce: f.journal.plan.nonce, port: 1}), /no matching transaction/);
  const normal = await migrationStartupGate({stateDirectory: f.stateDirectory, runningBundle: f.journal.plan.source, port: 1});
  assert.equal(normal.proceed, true);
  await assert.rejects(boundedMigrationWait(() => false, 'bounded startup', {timeout: 5}), /bounded startup/);
});

test('an identified parent that refuses shutdown is bounded before mutation', async () => {
  const identity = processIdentity(process.pid)!;
  const ports = migrationRuntimePorts({parent: {pid: process.pid, identity}, port: 1, timeout: 5});
  await assert.rejects(ports.waitForParent(), /did not exit/);
});

test('migration readiness requires matching Foreground registration and a running target process', async (t) => {
  const f = launchFixture(t);
  atomicMigrationJson(join(f.stateDirectory, MIGRATION_ACK), f.ack);
  const registration = `1) "Mission Control" ASN:0x0-0x123:\n bundleID="com.mission-control.app"\n bundle path="${f.journal.plan.target}"\n pid = ${process.pid} type="Foreground"\n`;
  const running = `${process.pid} 1 S ${f.journal.plan.target}/Contents/MacOS/Mission Control\n`;
  const valid = {registration: {code: 0, stdout: registration}, process: {code: 0, stdout: running}};
  let observed = valid;
  f.mac.run = async (command) => command.endsWith('/lsappinfo') ? observed.registration : observed.process;
  await f.ports.waitForReady(f.journal);
  for (const [name, changed] of [
    ['missing registration', {registration: {code: 0, stdout: ''}}],
    ['wrong bundle', {registration: {code: 0, stdout: registration.replace(f.journal.plan.target, '/other.app')}}],
    ['wrong PID', {registration: {code: 0, stdout: registration.replace(`pid = ${process.pid}`, 'pid = 2147483647')}}],
    ['wrong bundle ID', {registration: {code: 0, stdout: registration.replace('com.mission-control.app', 'com.other.app')}}],
    ['background registration', {registration: {code: 0, stdout: registration.replace('Foreground', 'BackgroundOnly')}}],
    ['unreadable registration', {registration: {code: 1, stdout: registration}}],
    ['stopped target', {process: {code: 0, stdout: running.replace(' 1 S ', ' 1 T ')}}],
    ['missing target', {process: {code: 0, stdout: '1 0 S /sbin/launchd\n'}}],
    ['unreadable processes', {process: {code: 1, stdout: running}}],
  ] as const) {
    await t.test(name, async () => {
      observed = {...valid, ...changed};
      await assert.rejects(f.ports.waitForReady(f.journal), /did not confirm readiness before the migration timeout/);
      observed = valid;
      await f.ports.waitForReady(f.journal);
    });
  }
});

test('recovery inside the registered retained source does not wait for or spawn a second source instance', async () => {
  const source = '/Applications/Mission Control.app';
  const commands: string[] = [];
  const ports = migrationRuntimePorts({port: 1, mac: {
    uid: 501, now: Date.now, sleep: async () => {}, identity: processIdentity, kill: () => { throw new Error('no signal'); }, readAck: () => null,
    run: async (command) => {
      commands.push(command);
      return {code: 0, stdout: `1) "Mission Control" ASN:0x0-0x123:\n bundleID="com.mission-control.app"\n bundle path="${source}"\n pid = ${process.pid} type="Foreground"\n`};
    },
  }});
  await ports.launchSource(source);
  assert.deepEqual(commands, ['/usr/bin/lsappinfo']);
});

test('migration recovery opens the exact source through LaunchServices when it is not registered', async (t) => {
  const f = launchFixture(t);
  const source = f.journal.plan.source;
  await f.ports.launchSource(source);
  assert.deepEqual(f.calls.filter((call) => call.command === '/usr/bin/open'), [
    {command: '/usr/bin/open', args: [source]},
  ]);
  const registration = f.calls.findIndex((call) => call.command.endsWith('/lsregister'));
  const open = f.calls.findIndex((call) => call.command === '/usr/bin/open');
  assert.ok(registration >= 0 && registration < open);
  assert.deepEqual(f.calls[registration]?.args, ['-f', source]);
  assert.ok(!f.calls.some((call) => call.command.includes('/Contents/MacOS/')));
});
