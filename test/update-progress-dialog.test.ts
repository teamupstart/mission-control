import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realApplyOperations } from '../scripts/apply-update.mjs';
import { updateProgressRequestPath } from '../scripts/mac-app-lifecycle.mjs';
import { showUpdateProgress } from '../scripts/mac-app-lifecycle.mjs';

test('progress has no automatic timeout that could be mistaken for Hide', () => {
  const child = Object.assign(new EventEmitter(), {kill: () => true});
  let script = '';
  const launch = ((_command: string, args: string[]) => {
    script = args[1]!;
    return child;
  }) as unknown as typeof spawn;
  const close = showUpdateProgress('Installing the update', launch);
  assert.match(script, /buttons \{"Hide"\}/);
  assert.doesNotMatch(script, /giving up after/);
  close();
});

for (const closeByOwner of [false, true]) test(`progress ${closeByOwner ? 'replacement does not count as Hide' : 'dismissal tells its owner to keep later updates hidden'}`, () => {
  const child = Object.assign(new EventEmitter(), {kill: () => true});
  let hidden = 0;
  const close = showUpdateProgress('Installing the update', (() => child) as unknown as typeof spawn, () => { hidden++; });
  if (closeByOwner) close();
  child.emit('exit', 0);
  assert.equal(hidden, closeByOwner ? 0 : 1);
});


test('Hide survives later messages until reopening explicitly reveals the latest progress', async () => {
  const root = mkdtempSync(join(tmpdir(), 'update-progress-hide-'));
  const shown: string[] = [];
  let hidden!: () => void;
  const ops = realApplyOperations(join(root, 'update.log'), undefined, (message, _launch, onHidden) => {
    shown.push(message);
    hidden = onHidden!;
    return () => {};
  });
  const nonce = 'a'.repeat(64);
  const close = ops.showProgress!('Waiting for a check', nonce);
  try {
    hidden();
    ops.showProgress!('Installing the new build');
    assert.deepEqual(shown, ['Waiting for a check'], 'a message change must not undo Hide');
    writeFileSync(updateProgressRequestPath(root, nonce), JSON.stringify({at: Date.now()}));
    const deadline = Date.now() + 3000;
    while (shown.length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(shown, ['Waiting for a check', 'Installing the new build']);
  } finally { close(); rmSync(root, {recursive: true, force: true}); }
});
