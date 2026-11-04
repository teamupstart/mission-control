import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { stopUtilityProcess } from '../src/main/utility-shutdown.ts';

test('desktop quit requests teardown and waits for the utility exit, without killing it', async () => {
  const child = Object.assign(new EventEmitter(), {
    postMessage(message: unknown) { assert.deepEqual(message, {type: 'mission:shutdown'}); },
    kill() { throw new Error('graceful shutdown must not kill'); },
  });
  let done = false;
  const stopping = stopUtilityProcess(child).then(() => { done = true; });
  await Promise.resolve();
  assert.equal(done, false);
  child.emit('exit', 0);
  await stopping;
  assert.equal(done, true);
});

test('a utility that cannot respond is bounded and force stopped', async () => {
  let kills = 0;
  const child = Object.assign(new EventEmitter(), {
    postMessage() {}, kill() { kills++; child.emit('exit', 1); },
  });
  await stopUtilityProcess(child, 5);
  assert.equal(kills, 1);
});

for (const failure of ['timeout', 'failed send'] as const) test(`forced shutdown after ${failure} waits for delayed utility exit`, async (t) => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let kills = 0;
  const child = Object.assign(new EventEmitter(), {
    postMessage() { if (failure === 'failed send') throw new Error('port closed'); },
    kill() { kills++; },
  });
  let done = false;
  const stopping = stopUtilityProcess(child, 30_000).then(() => { done = true; });
  if (failure === 'timeout') {
    assert.equal(kills, 0);
    t.mock.timers.tick(30_000);
  }
  await Promise.resolve();
  assert.equal(kills, 1);
  assert.equal(done, false, 'requesting termination does not prove that the utility exited');
  t.mock.timers.tick(5000);
  await Promise.resolve();
  assert.equal(done, false, 'the shell must remain open during delayed termination');

  child.emit('exit', 1);
  await stopping;
  assert.equal(done, true);
  t.mock.timers.tick(30_000);
  assert.equal(kills, 1, 'no shutdown timer may kill the utility again after exit');
});
