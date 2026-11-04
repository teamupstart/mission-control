import assert from 'node:assert/strict';
import test from 'node:test';
import { validateDistributionTicket } from '../scripts/verify-distribution.mjs';
import { distributionFailure, type DistributionToolResult } from '../scripts/distribution-diagnostics.mjs';

const connectionLost = 'error is Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."';
const ok = {status: 0, stdout: '', stderr: ''};

for (const stream of ['stdout', 'stderr']) test(`ticket validation retries connection loss in ${stream} with bounded backoff`, async () => {
  const calls: Array<[string, string[]]> = [], delays: number[] = [], logs: string[] = [];
  await validateDistributionTicket('/fixture/Parent.app', {
    run: (command, args) => {
      calls.push([command, args]);
      return calls.length < 4 ? {status: 68, [stream]: connectionLost + '\nPRIVATE RAW TOOL OUTPUT'} : ok;
    },
    wait: async ms => { delays.push(ms); }, log: line => { logs.push(line); },
  });
  assert.deepEqual(delays, [1000, 2000, 4000]);
  assert.equal(calls.length, 4);
  for (const call of calls) assert.deepEqual(call, ['/usr/bin/xcrun', ['stapler', 'validate', '/fixture/Parent.app']]);
  assert.equal(logs.length, 3);
  assert.deepEqual(logs.map(line => JSON.parse(line.slice('[distribution] '.length)).retryInMs), delays);
  assert.doesNotMatch(logs.join('\n'), /PRIVATE|\/fixture|NSURLError/);
});

test('a persistent connection loss retries for about two minutes with capped backoff, then fails', async () => {
  let calls = 0;
  const delays: number[] = [];
  await assert.rejects(validateDistributionTicket('/fixture/Runtime.app', {
    run: () => { calls++; return {status: 68, stdout: connectionLost}; },
    wait: async ms => { delays.push(ms); }, log: () => {},
  }), /Distribution verification failed: \/usr\/bin\/xcrun/);
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  assert.equal(calls, 9);
});

test('a valid ticket succeeds immediately without retries', async () => {
  let calls = 0;
  await validateDistributionTicket('/fixture/Application.dmg', {
    run: () => { calls++; return ok; },
    wait: async () => { assert.fail('must not wait'); }, log: () => { assert.fail('must not log a retry'); },
  });
  assert.equal(calls, 1);
});

const refusals: Array<[string, DistributionToolResult]> = [
  ['invalid ticket', {status: 65, stdout: 'The validate action failed! Error 65.'}],
  ['revoked ticket', {status: 77, stderr: 'The ticket has been revoked.'}],
  ['unknown CloudKit response', {status: 68, stdout: "CloudKit's response is inconsistent with expections: (null)"}],
  ['TLS failure', {status: 68, stderr: 'Error Domain=NSURLErrorDomain Code=-1200'}],
  ['unrecognized URL error', {status: 68, stderr: 'Error Domain=NSURLErrorDomain Code=-10050'}],
  ['connection text with a ticket refusal', {status: 65, stdout: connectionLost}],
  ['spawn timeout', {status: null, error: {code: 'ETIMEDOUT'}, stdout: connectionLost}],
  ['signal termination', {status: 68, signal: 'SIGTERM', stdout: connectionLost}],
];
for (const [name, result] of refusals) test(`${name} fails immediately without transport retries`, async () => {
  let calls = 0;
  await assert.rejects(validateDistributionTicket('/fixture/Application.app', {
    run: () => { calls++; return result; },
    wait: async () => { assert.fail('must not wait'); }, log: () => { assert.fail('must not log a retry'); },
  }), /Distribution verification failed: \/usr\/bin\/xcrun/);
  assert.equal(calls, 1);
});

test('a trust refusal after a connection loss stops retries and retains the latest failure', async () => {
  let calls = 0;
  const delays: number[] = [];
  await assert.rejects(validateDistributionTicket('/fixture/Application.app', {
    run: () => ++calls === 1 ? {status: 68, stdout: connectionLost} : {status: 65, stderr: 'ticket invalid'},
    wait: async ms => { delays.push(ms); }, log: () => {},
  }), error => {
    const diagnostic = JSON.parse(distributionFailure(error).slice('[distribution] failed '.length));
    assert.equal(diagnostic.status, 65);
    assert.equal(diagnostic.stderr, 'ticket invalid');
    return true;
  });
  assert.equal(calls, 2);
  assert.deepEqual(delays, [1000]);
});
