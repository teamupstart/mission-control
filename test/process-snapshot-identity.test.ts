import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { listProcessesSnapshot } from '../src/server/discovery/processes.ts';
import { darwinCheckIdentity } from '../scripts/darwin-process-identity.mjs';
import { processIdentity } from '../scripts/update-lock.mjs';

test('a narrow terminal cannot truncate the SDK lifetime command captured for update ownership', {skip: process.platform !== 'darwin'}, async () => {
  const argument = 'sdk-owned-argument-'.repeat(80);
  const child = spawn(process.execPath, ['-e', 'console.log("ready"); setInterval(() => {}, 1000)', '--', argument], {stdio: ['ignore', 'pipe', 'pipe']});
  const exited = once(child, 'exit');
  const columns = process.env.COLUMNS;
  try {
    await once(child.stdout, 'data');
    process.env.COLUMNS = '80';
    const snapshot = await listProcessesSnapshot();
    assert.equal(snapshot.unknownReason, null);
    const captured = snapshot.processes.find(row => row.pid === child.pid);
    assert.ok(captured);
    assert.ok(captured.command.endsWith(argument), 'the full SDK argv must reach the lifetime fingerprint');
    assert.equal(darwinCheckIdentity(`${captured.startRaw} ${captured.command}`), darwinCheckIdentity(processIdentity(child.pid!)), 'the supervisor snapshot and detached helper must agree on this process lifetime');
  } finally {
    if (columns === undefined) delete process.env.COLUMNS; else process.env.COLUMNS = columns;
    child.kill();
    await exited;
  }
});

test('width-limited process discovery produces the same lifetime digest as the wide update helper', async () => {
  const start = 'Wed Nov 4 10:00:00 2026';
  const command = '/Applications/Fixture.app/Contents/MacOS/driver ' + '--sdk-context='.repeat(80);
  const snapshot = await listProcessesSnapshot(async (_bin, args) => ({
    code: 0, stderr: '', outcomeUnknown: false, overflowed: false,
    stdout: args.includes('pid=,command=')
      ? `42 ${args.includes('-ww') ? command : command.slice(0, 80)}\n`
      : `501 42 1 S ?? ${start}\n`,
  }));
  assert.equal(snapshot.unknownReason, null);
  const captured = snapshot.processes[0]!;
  assert.equal(darwinCheckIdentity(`${captured.startRaw} ${captured.command}`),
    darwinCheckIdentity(`${start} ${command}`));
});
