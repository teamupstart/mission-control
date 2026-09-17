// Readiness is a nonce/process/build/state tuple, not the success of an `open` call.
// These tests exercise the real timeout and OS identity ports with disposable files.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { processIdentity } from '../scripts/update-lock.mjs';
import { atomicMigrationJson, MIGRATION_ACK, type MigrationJournal } from '../scripts/install-migration.mjs';
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

test('only the intended live process and exact acknowledgment tuple establish readiness', async (t) => {
  const f = fixture(t);
  const ports = migrationRuntimePorts({port: 1, timeout: 5});
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
