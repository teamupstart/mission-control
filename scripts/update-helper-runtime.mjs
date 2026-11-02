// Complete app snapshots outlive their parent and the installed bundle. Only a later
// lock holder removes snapshots whose exact helper is dead and whose outcome is durable.
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { UPDATE_HELPER_FILES } from './update-helper-files.mjs';
import { inspectBundle, requireInstallSpace } from './install-staged-app.mjs';
import { atomicMigrationJson, readMigrationJson, readMigrationJournal, migrationIsCommitted, migrationReceipt, withMigrationLock } from './install-migration.mjs';
import { processIdentity, processIsAlive, claimIsLive } from './update-lock.mjs';
import { BUNDLE_COPY_ARGUMENTS } from './app-bundle-swap.mjs';
import { resolveOwnedRuntime } from '../src/shared/owned-runtime.mjs';
import { stagedBundleRevision } from '../src/shared/staged-bundle.mjs';
import { boundedMigrationWait } from './migration-runtime.mjs';

export function cleanupHelperSnapshots(stateDirectory, {isLive = claimIsLive} = {}) {
  const root = join(stateDirectory, 'update-runtimes');
  const journal = readMigrationJournal(stateDirectory);
  if (!existsSync(root)) return;
  if (lstatSync(root).isSymbolicLink()) throw new Error('The runtime snapshot store is a symbolic link');
  for (const name of readdirSync(root)) {
    if (!/^attempt-[a-f0-9]{64}$/.test(name)) continue;
    const path = join(root, name);
    try {
      if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) continue;
      const marker = readMigrationJson(join(path, 'owner.json'));
      if (marker.protocol !== 1 || marker.nonce !== name.slice(8) || marker.path !== realpathSync(path) || !marker.helper?.identity || isLive(marker.helper)) continue;
      const finished = readMigrationJson(join(path, 'finished.json'));
      if (finished.nonce !== marker.nonce || finished.pid !== marker.helper.pid || finished.identity !== marker.helper.identity) continue;
      if (journal?.plan.nonce === (marker.transactionNonce ?? marker.nonce) && !['complete', 'restored'].includes(journal.stage)) continue;
      // Only the matching completed transaction can release its recovery copy.
      // Keep its journal for diagnostics; failures and unknown ownership retain all material.
      if (journal?.plan.kind === 'in-place' && journal.plan.nonce === (marker.transactionNonce ?? marker.nonce) && journal.stage === 'complete') {
        const {backup, sourceDigest} = journal.plan;
        if (!migrationIsCommitted(journal, migrationReceipt(stateDirectory))) continue;
        const retained = journal.retainedSwap;
        const retainedStat = retained ? lstatSync(retained.path, {throwIfNoEntry: false}) : null;
        const hasBackup = existsSync(backup);
        // The fixed slot may now belong to another attempt. A path or matching
        // bytes alone cannot prove ownership; keep unknown material for inspection.
        if (retainedStat && (realpathSync(dirname(retained.path)) !== dirname(retained.path) ||
          stagedBundleRevision(retainedStat) !== retained.revision || inspectBundle(retained.path).digest !== sourceDigest)) continue;
        if (hasBackup && (realpathSync(dirname(backup)) !== dirname(backup) || inspectBundle(backup).digest !== sourceDigest)) continue;
        if (hasBackup || retainedStat) {
          atomicMigrationJson(join(dirname(backup), 'complete-journal.json'), journal);
          if (retainedStat) rmSync(retained.path, {recursive: true});
          if (hasBackup) rmSync(backup, {recursive: true});
        }
      }
      rmSync(path, {recursive: true, force: true});
    } catch { /* Unknown ownership or recovery obligations always retain. */ }
  }
}

export async function spawnBundledUpdateHelper({runtimeBundle, helperSource, stateDirectory, parentPid, logPath, argv, handoff, candidateBundle, recovery = false, env = process.env}) {
  stateDirectory = realpathSync(stateDirectory);
  const runtimePath = realpathSync(runtimeBundle);
  if (stateDirectory === runtimePath || stateDirectory.startsWith(`${runtimePath}/`)) throw new Error('The runtime snapshot store must be outside its source app');
  const parent = {pid: parentPid, identity: processIdentity(parentPid)};
  if (!parent.identity) throw new Error('Could not prove the source app process identity');
  const nonce = recovery ? randomBytes(32).toString('hex') : handoff?.plan.nonce ?? randomBytes(32).toString('hex');
  const transactionNonce = handoff?.plan.nonce ?? nonce;
  const store = join(stateDirectory, 'update-runtimes');
  const directory = join(store, `attempt-${nonce}`);
  let child;
  let childIdentity;
  // Release before child claims: the helper must independently acquire ownership before ack.
  await withMigrationLock(stateDirectory, () => {
    cleanupHelperSnapshots(stateDirectory);
    const runtime = inspectBundle(runtimeBundle);
    const candidateBytes = handoff?.plan.descriptor?.bytes ?? (candidateBundle ? inspectBundle(candidateBundle).bytes : handoff?.plan.stagedBundle ? inspectBundle(handoff.plan.stagedBundle).bytes : 0);
    const oldBytes = handoff?.plan.source ? inspectBundle(handoff.plan.source).bytes : runtime.bytes;
    requireInstallSpace([{path: stateDirectory, bytes: runtime.bytes + oldBytes},
      {path: handoff?.plan.target ? dirname(handoff.plan.target) : dirname(runtimeBundle), bytes: candidateBytes + oldBytes}]);
    mkdirSync(store, {recursive: true, mode: 0o700});
    if (lstatSync(store).isSymbolicLink()) throw new Error('The runtime snapshot store is a symbolic link');
    mkdirSync(directory, {mode: 0o700});
    try {
      atomicMigrationJson(join(directory, 'owner.json'), {protocol: 1, nonce, transactionNonce, path: realpathSync(directory), parent, helper: null});
      const snapshot = join(directory, 'Runtime.app');
      execFileSync('/bin/cp', [...BUNDLE_COPY_ARGUMENTS, runtimeBundle, snapshot], {timeout: 10 * 60 * 1000});
      if (inspectBundle(snapshot).digest !== runtime.digest || inspectBundle(runtimeBundle).digest !== runtime.digest) throw new Error('The helper runtime changed while copying');
      if (realpathSync(helperSource) !== join(runtimePath, 'Contents/Resources/app/scripts/apply-update.mjs')) throw new Error('The helper scripts must belong to the copied runtime');
      const root = join(snapshot, 'Contents/Resources/app');
      for (const file of UPDATE_HELPER_FILES) {
        mkdirSync(dirname(join(directory, file)), {recursive: true});
        copyFileSync(join(root, file), join(directory, file));
      }
      if (handoff) atomicMigrationJson(join(directory, 'migration-plan.json'), {...handoff, parent});
    } catch (error) {
      // This lock holder created the directory and has not spawned a helper.
      // Reclaim partial copies before releasing the lock so the same attempt can retry.
      rmSync(directory, {recursive: true, force: true});
      throw error;
    }
  });
  try {
    const executable = join(directory, 'Runtime.app/Contents/MacOS', 'Mission Control');
    const runtime = resolveOwnedRuntime({executable, kind: 'electron'});
    const helperEnv = {...env, ...runtime.env, MISSION_HOME: stateDirectory};
    delete helperEnv.NODE_OPTIONS;
    delete helperEnv.NODE_PATH;
    const fd = openSync(logPath, 'a', 0o600);
    try {
      child = spawn(runtime.command, [join(directory, 'scripts/apply-update.mjs'), ...argv,
        ...(handoff ? ['--source-app', handoff.plan.source, '--target-app', handoff.plan.target, '--migration-plan', join(directory, 'migration-plan.json')] : []),
        '--attempt-directory', directory], {detached: true, stdio: ['ignore', fd, fd], env: helperEnv});
      await new Promise((resolve, reject) => {child.once('spawn', resolve); child.once('error', reject);});
      child.unref();
    } finally {closeSync(fd);}
    await boundedMigrationWait(() => {
      if (!processIsAlive(child.pid)) throw new Error('The detached helper exited before startup acknowledgement');
      childIdentity = processIdentity(child.pid);
      return childIdentity !== null;
    }, 'The detached helper process could not be identified', {timeout: 10_000});
    atomicMigrationJson(join(directory, 'owner.json'), {protocol: 1, nonce, transactionNonce, path: realpathSync(directory), parent,
      helper: {pid: child.pid, identity: childIdentity}});
    await boundedMigrationWait(() => {
      if (!processIsAlive(child.pid) || processIdentity(child.pid) !== childIdentity) throw new Error('The detached helper exited before startup acknowledgement');
      if (!existsSync(join(directory, 'ready.json'))) return false;
      const ready = readMigrationJson(join(directory, 'ready.json'));
      return ready.nonce === nonce && ready.pid === child.pid && ready.identity === childIdentity;
    }, 'The detached helper did not acknowledge startup', {timeout: 30_000});
    return directory;
  } catch (error) {
    // Never unlink a mapped runtime, including on an uncertain handoff. The helper's
    // bounded parent wait will settle it, and a future owner can inspect the result.
    if (!child?.pid) rmSync(directory, {recursive: true, force: true});
    throw error;
  }
}

export function acknowledgeHelper(directory) {
  const marker = readMigrationJson(join(directory, 'owner.json'));
  const identity = processIdentity(process.pid);
  if (!identity || marker.path !== realpathSync(directory)) throw new Error('The helper attempt identity is invalid');
  atomicMigrationJson(join(directory, 'ready.json'), {nonce: marker.nonce, pid: process.pid, identity});
}

export function finishHelper(directory) {
  const marker = readMigrationJson(join(directory, 'owner.json'));
  const identity = processIdentity(process.pid);
  if (!identity || marker.helper?.pid !== process.pid || marker.helper.identity !== identity) return;
  atomicMigrationJson(join(directory, 'finished.json'), {nonce: marker.nonce, pid: process.pid, identity});
}
