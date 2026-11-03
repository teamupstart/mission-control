// An in-place update must always either progress or roll back with an explanation.
//
// Both defects below were observed on 2026-11-03 and are pinned against the REAL journal,
// receipt and bundle transaction: only the OS observations are scripted.
//
//  1. A workflow-check supervisor that outlived its daemon kept the bundle busy, the helper's
//     bundle-exit wait timed out, and the rollback outcome said only "The update did not
//     commit" - no pid, no cause.
//  2. Opening the app (no migration nonce) while the in-place helper was still running threw
//     "An uncommitted personal app cannot start. Reopen the system app...". Source and target
//     are the same bundle in place, so that advice pointed at the app the person just opened.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareStagedInstall } from '../scripts/install-staged-app.mjs';
import { migrationRollbackMessage, prepareInPlaceInstall, runMigration, readMigrationJournal } from '../scripts/install-migration.mjs';
import { MIGRATION_IN_PROGRESS_NOTICE, migrationStartupGate } from '../scripts/migration-runtime.mjs';
import { waitForBundleExit, type MacAppOps } from '../scripts/mac-app-lifecycle.mjs';
import { CHECK_SUPERVISOR_MARKER } from '../src/shared/owned-runtime.mjs';

/** `rename` asks for the app-name migration: the same transaction, published under the new name. */
function inPlaceFixture(t: test.TestContext, {rename = false} = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'in-place-progress-')));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const stateDirectory = join(root, 'state'); mkdirSync(stateDirectory);
  const apps = join(root, 'apps'); mkdirSync(apps);
  const app = join(apps, 'Mission Control.app');
  const candidate = join(root, 'candidate.app');
  for (const [path, commit] of [[app, 'a'.repeat(40)], [candidate, 'b'.repeat(40)]] as const) {
    mkdirSync(join(path, 'Contents/Resources/app'), {recursive: true});
    mkdirSync(join(path, 'Contents/MacOS'), {recursive: true});
    writeFileSync(join(path, 'Contents/MacOS/Mission Control'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(path, 'Contents/MacOS/Mission Control'), 0o755);
    writeFileSync(join(path, 'Contents/Info.plist'), '<key>CFBundleShortVersionString</key><string>1.26.0</string>');
    writeFileSync(join(path, 'Contents/Resources/app/package.json'), JSON.stringify({missionCommit: commit,
      missionInstallMigration: {protocol: 1, automatic: true}, missionInstallTransaction: {protocol: 1, appNaming: 1, receiptSchemas: [1, 2]}}));
  }
  const oldReceipt = {schema: 1, repo: 'teamupstart/mission-control', releaseTag: 'v1.26.0', installedVersion: '1.26.0',
    installedCommit: 'a'.repeat(40), sourceClone: '/source-that-must-not-be-executed', appPath: app, installedAt: '2026-10-14T00:00:00.000Z'};
  writeFileSync(join(stateDirectory, 'install-receipt.json'), `${JSON.stringify(oldReceipt, null, 2)}\n`);
  const descriptor = prepareStagedInstall({bundle: candidate, receipt: {...oldReceipt, installedCommit: 'b'.repeat(40),
    ...(rename ? {appPath: join(apps, 'Agent Mission Control.app')} : {})}});
  const plan = prepareInPlaceInstall({descriptor, stateDirectory});
  const events: string[] = [];
  const ports = {
    waitForParent: async () => {}, waitForDaemonExit: async () => {},
    launchTarget: async () => ({pid: 987654, identity: 'fixture'}), waitForReady: async () => {},
    stopTarget: async () => { events.push('stop-target'); }, launchSource: async () => { events.push('launch-source'); },
  };
  return {root, stateDirectory, app, plan, ports, events};
}

/** `ps` as the helper sees it after the daemon was reaped: one detached check supervisor left. */
function lingeringSupervisorOps(bundle: string, supervisorPid = 4321): {ops: MacAppOps; calls: string[]} {
  let now = 0;
  const calls: string[] = [];
  const helper = `${bundle}/Contents/Frameworks/Mission Control Helper.app/Contents/MacOS/Mission Control Helper`;
  const ops: MacAppOps = {
    uid: 501, now: () => now, sleep: async (ms) => { now += ms; },
    run: async (command, args) => {
      calls.push(`${command} ${args.join(' ')}`);
      if (command === '/bin/ps' && args.includes('args=')) {
        // The supervisor's command line carries the marker; it is read, never printed.
        return {code: 0, stdout: `${helper} -e // ${CHECK_SUPERVISOR_MARKER}\nconst net = require("node:net"); attempt-1 npm test\n`};
      }
      if (command === '/bin/ps') return {code: 0, stdout: `1 0 S /sbin/launchd\n${supervisorPid} 1 S ${helper}\n`};
      return {code: 0, stdout: ''};
    },
    identity: () => 'start', kill: () => { throw new Error('the helper must not signal a process it only diagnoses'); },
    readAck: () => null,
  };
  return {ops, calls};
}

test('a lingering check supervisor is named, with its pid and cause, in the in-place rollback outcome', async (t) => {
  const f = inPlaceFixture(t);
  const {ops} = lingeringSupervisorOps(f.plan.source);
  f.ports.waitForParent = () => waitForBundleExit(f.plan.source, ops, 1_000);
  const result = await runMigration(f.plan, f.ports);
  assert.equal(result.committed, false);
  const outcome = JSON.parse(readFileSync(join(f.stateDirectory, 'update-outcome.json'), 'utf8'));
  assert.equal(outcome.result, 'failure');
  assert.match(outcome.message, /^The update did not commit\b/);
  assert.match(outcome.message, /\b4321\b/, 'the blocking pid is missing from the outcome');
  assert.match(outcome.message, /workflow check/, 'the cause is missing from the outcome');
  assert.match(outcome.message, /previous app and exact installation receipt were preserved/);
  // The outcome is shown to a person and must not carry a command line or a home path.
  assert.doesNotMatch(outcome.message, /require\(|npm test|\/Users\/|\/private\//);
  assert.deepEqual(f.events, ['stop-target', 'launch-source']);
});

test('a restored app-name migration names what stopped it in the outcome', async (t) => {
  const f = inPlaceFixture(t, {rename: true});
  assert.equal(f.plan.kind, 'rename');
  f.ports.waitForReady = async () => { throw new Error('The personal app did not confirm readiness before the migration timeout'); };
  const result = await runMigration(f.plan, f.ports);
  assert.equal(result.committed, false);
  const outcome = JSON.parse(readFileSync(join(f.stateDirectory, 'update-outcome.json'), 'utf8'));
  assert.equal(outcome.result, 'failure');
  assert.equal(outcome.message, 'The app-name migration did not commit. The personal app did not confirm readiness before the migration timeout. '
    + 'The previous app and exact receipt are unchanged.');
  assert.deepEqual(f.events, ['stop-target', 'launch-source']);
});

test('the rollback cause is kept whole up to the 500-character redaction bound and cut just past it', () => {
  const lead = 'The update did not commit.';
  const tail = 'The previous app and exact installation receipt were preserved.';
  const at = 'x'.repeat(499) + '.';
  assert.equal(at.length, 500);
  assert.equal(migrationRollbackMessage(lead, new Error(at), tail), `${lead} ${at} ${tail}`, 'a cause at the limit lost characters');
  const over = 'y'.repeat(501);
  assert.equal(migrationRollbackMessage(lead, over, tail), `${lead} ${'y'.repeat(500)}. ${tail}`, 'a cause past the limit was not cut at 500');
  // Whitespace is trimmed before the limit, so padding cannot push real text out.
  assert.equal(migrationRollbackMessage(lead, `   ${at}   `, tail), `${lead} ${at} ${tail}`);
  // No cause leaves the original sentence exactly as it was.
  for (const none of [undefined, null, '', '   ']) assert.equal(migrationRollbackMessage(lead, none, tail), `${lead} ${tail}`);
  // A cause already ending a sentence is not given a second full stop.
  assert.equal(migrationRollbackMessage(lead, 'Stopped!', tail), `${lead} Stopped! ${tail}`);
});

test('a rollback cause is redacted before it is persisted or shown', async (t) => {
  // The outcome reaches update-outcome.json and the dashboard dialog, so a filesystem or
  // child-process error must not carry a home path, a URL or a token into either.
  const f = inPlaceFixture(t);
  f.ports.waitForReady = async () => {
    throw new Error(`ENOENT: no such file or directory, open '${f.root}/Users/jo/.mission-control/secret.json' via https://example.test/x?token=abc ghp_abcdefghijklmnop1234`);
  };
  const result = await runMigration(f.plan, f.ports);
  assert.equal(result.committed, false);
  const {message} = JSON.parse(readFileSync(join(f.stateDirectory, 'update-outcome.json'), 'utf8'));
  assert.equal(message, "The update did not commit. ENOENT: no such file or directory, open '<path>' via <url><redacted> <redacted-token>. "
    + 'The previous app and exact installation receipt were preserved.');
  assert.doesNotMatch(message, /\/Users\/|secret\.json|example\.test|ghp_|token=abc/);
});

test('a no-nonce launch of the in-place target while the helper is alive is told the update is in progress', async (t) => {
  const f = inPlaceFixture(t);
  assert.equal(f.plan.source, f.plan.target, 'an in-place plan replaces its own bundle');
  let release!: () => void;
  const parked = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const parentWait = new Promise<void>((resolve) => { entered = resolve; });
  f.ports.waitForParent = async () => { entered(); await parked; };
  const running = runMigration(f.plan, f.ports);
  await parentWait;
  // The helper (this test process) is alive and the journal is uncommitted.
  const journal = readMigrationJournal(f.stateDirectory);
  assert.equal(journal?.stage, 'prepared');
  assert.equal(journal?.owner.pid, process.pid);
  const started = Date.now();
  const gate = await migrationStartupGate({stateDirectory: f.stateDirectory, runningBundle: f.plan.target, port: 1, timeout: 60_000});
  assert.deepEqual(gate, {proceed: false, committed: false, fresh: false, notice: MIGRATION_IN_PROGRESS_NOTICE});
  // Waiting for the helper here would deadlock it: it is waiting for this very bundle to exit.
  assert.ok(Date.now() - started < 5_000, 'the gate waited on the helper instead of answering');
  assert.match(MIGRATION_IN_PROGRESS_NOTICE, /update/i);
  assert.doesNotMatch(MIGRATION_IN_PROGRESS_NOTICE, /system app|uncommitted/i);
  // The launch changed nothing the helper owns.
  assert.equal(existsSync(join(f.stateDirectory, 'install-migration-launch.json')), false);
  release();
  const result = await running;
  assert.equal(result.committed, true, result.error);
});
