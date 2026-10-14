import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, existsSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicMigrationJson } from '../scripts/install-migration.mjs';
import { cleanupHelperSnapshots } from '../scripts/update-helper-runtime.mjs';
import { resolveOwnedRuntime } from '../src/shared/owned-runtime.mjs';

test('snapshot cleanup requires exact dead ownership and a durable completed outcome', (t) => {
  const state = realpathSync(mkdtempSync(join(tmpdir(), 'helper-cleanup-')));
  t.after(() => rmSync(state, {recursive: true, force: true}));
  const store = join(state, 'update-runtimes'); mkdirSync(store);
  const make = (n: string, finished = true) => {
    const nonce = n.repeat(64), path = join(store, `attempt-${nonce}`); mkdirSync(path);
    atomicMigrationJson(join(path, 'owner.json'), {protocol: 1, nonce, path, helper: {pid: 42, identity: 'known'}});
    if (finished) atomicMigrationJson(join(path, 'finished.json'), {nonce, pid: 42, identity: 'known'});
    return path;
  };
  const done = make('a'), unfinished = make('b', false), mismatched = make('c');
  atomicMigrationJson(join(mismatched, 'finished.json'), {nonce: 'c'.repeat(64), pid: 42, identity: 'reused PID'});
  const foreign = join(state, 'foreign'); mkdirSync(foreign); symlinkSync(foreign, join(store, `attempt-${'d'.repeat(64)}`));
  cleanupHelperSnapshots(state, {isLive: () => true});
  assert.ok(existsSync(done), 'unknown/live ownership retains');
  cleanupHelperSnapshots(state, {isLive: () => false});
  assert.equal(existsSync(done), false);
  assert.ok(existsSync(unfinished)); assert.ok(existsSync(mismatched)); assert.ok(existsSync(foreign));
});

test('owned runtime policy pins an absolute executable and scopes Electron Node mode', () => {
  assert.deepEqual(resolveOwnedRuntime({executable: '/snapshot/Mission Control', kind: 'electron'}), {command: '/snapshot/Mission Control', env: {ELECTRON_RUN_AS_NODE: '1'}});
  assert.deepEqual(resolveOwnedRuntime({executable: '/pinned/node', kind: 'node'}), {command: '/pinned/node', env: {}});
  assert.throws(() => resolveOwnedRuntime({executable: 'node', kind: 'node'}), /absolute/);
});
