import assert from 'node:assert/strict';
import test from 'node:test';
import { notarizeDistribution } from '../scripts/notarize-distribution.mjs';
import { distributionFailure } from '../scripts/distribution-diagnostics.mjs';

const id = '12345678-1234-4234-a234-123456789abc';
const credentials = {appleApiKey: '/fake/private key.p8', appleApiKeyId: 'FAKEKEY123', appleApiIssuer: 'fake-issuer'};
const ok = (stdout = '') => ({status: 0, stdout, stderr: ''});

for (const suffix of ['app', 'dmg']) test(`${suffix} submits once, reports identity, waits for acceptance, then staples`, async () => {
  const calls: Array<[string, string[]]> = [], logs: string[] = [];
  await notarizeDistribution(`/fixture/Application.${suffix}`, credentials, {
    log: (line: string) => logs.push(line),
    run: async (command: string, args: string[]) => {
      calls.push([command, args]);
      if (args[0] === 'notarytool') return ok(JSON.stringify({id, status: args[1] === 'submit' ? 'In Progress' : 'Accepted'}));
      return ok();
    },
  });
  assert.deepEqual(calls.filter(([, args]) => args[0] === 'notarytool').map(([, args]) => args[1]), ['submit', 'wait']);
  assert.equal(calls.at(-1)?.[1][0], 'stapler');
  assert.equal(calls.some(([command]) => command.endsWith('/ditto')), suffix === 'app');
  assert.match(logs.join('\n'), new RegExp(id));
  assert.match(logs.join('\n'), /In Progress/); assert.match(logs.join('\n'), /Accepted/);
  assert.doesNotMatch(logs.join('\n'), /private key|FAKEKEY123|fake-issuer/);
});

test('stapling succeeds after temporary failures and stops retrying after success', async () => {
  const operations: string[] = [], delays: number[] = [];
  let staples = 0;
  await assert.doesNotReject(notarizeDistribution('/fixture/Application.dmg', credentials, {
    log: () => {}, wait: async (ms: number) => { delays.push(ms); },
    run: async (_command: string, args: string[]) => {
      operations.push(`${args[0]} ${args[1]}`);
      if (args[0] === 'notarytool') return ok(JSON.stringify({id, status: args[1] === 'submit' ? 'In Progress' : 'Accepted'}));
      staples++;
      return staples < 3 ? {status: 65, stdout: '', stderr: 'ticket unavailable'} : ok();
    },
  }));
  assert.equal(staples, 3);
  assert.deepEqual(delays, [1000, 2000]);
  assert.deepEqual(operations, ['notarytool submit', 'notarytool wait', 'stapler staple', 'stapler staple', 'stapler staple']);
});

test('app codesign verification failure retains child status and prevents archiving or submission', async () => {
  const calls: Array<[string, string[]]> = [];
  await assert.rejects(notarizeDistribution('/fixture/Application.app', credentials, {
    log: () => {}, run: async (command: string, args: string[]) => {
      calls.push([command, args]);
      return {status: 1, stdout: '', stderr: 'code object is not signed at all'};
    },
  }), (error: Error) => {
    const detail = JSON.parse(distributionFailure(error).slice('[distribution] failed '.length));
    assert.equal(detail.stage, 'notarize (app)');
    assert.equal(detail.command, '/usr/bin/codesign');
    assert.equal(detail.status, 1);
    assert.match(detail.stderr, /code object is not signed/);
    return true;
  });
  assert.deepEqual(calls, [['/usr/bin/codesign', ['--verify', '--deep', '--strict', '/fixture/Application.app']]]);
});

test('successful submit without an ID fails before waiting or stapling', async () => {
  const operations: string[] = [];
  await assert.rejects(notarizeDistribution('/fixture/Application.dmg', credentials, {
    log: () => {}, run: async (_command: string, args: string[]) => {
      operations.push(`${args[0]} ${args[1]}`);
      return ok(JSON.stringify({status: 'In Progress'}));
    },
  }), (error: Error) => {
    const detail = JSON.parse(distributionFailure(error).slice('[distribution] failed '.length));
    assert.equal(detail.stage, 'notarize (dmg)');
    assert.equal(detail.message, 'Notarytool did not return a submission ID');
    assert.equal(detail.notarizationStatus, 'In Progress');
    assert.equal(detail.submissionId, undefined);
    return true;
  });
  assert.deepEqual(operations, ['notarytool submit']);
});

test('Apple rejection retains submission ID, status, child exit and actionable sanitized issues', async () => {
  const calls: string[] = [];
  await assert.rejects(notarizeDistribution('/fixture/Application.dmg', credentials, {
    log: () => {},
    run: async (_command: string, args: string[]) => {
      calls.push(args[1]!);
      if (args[1] === 'log') return ok(JSON.stringify({status: 'Invalid', statusCode: 4000,
        statusSummary: 'Archive contains critical validation errors',
        issues: [{severity: 'error', code: 4000, path: 'Application.app/Contents/MacOS/Application',
          message: 'The signature does not include a secure timestamp.', architecture: 'arm64'}],
        privateKey: 'MUST NOT LOG UNSELECTED FIELDS'}));
      return {status: args[1] === 'wait' ? 65 : 0,
        stdout: JSON.stringify({id, status: args[1] === 'wait' ? 'Invalid' : 'In Progress'}),
        stderr: 'xcrun notarytool --key "/fake/private key.p8" --password "fake-password"'};
    },
  }), (error: Error) => {
    const output = distributionFailure(error);
    const detail = JSON.parse(output.slice('[distribution] failed '.length));
    assert.equal(detail.stage, 'notarize (dmg)'); assert.equal(detail.command, 'notarytool');
    assert.equal(detail.status, 65); assert.equal(detail.submissionId, id); assert.equal(detail.notarizationStatus, 'Invalid');
    assert.match(output, /secure timestamp/);
    assert.doesNotMatch(output, /private key|fake-password|MUST NOT LOG/);
    return true;
  });
  assert.deepEqual(calls, ['submit', 'wait', 'log']);
});

test('plain-text authentication failure retains child status and refuses stapling without a submission', async () => {
  const calls: string[] = [];
  await assert.rejects(notarizeDistribution('/fixture/Application.dmg', credentials, {
    log: () => {}, run: async (_command: string, args: string[]) => {
      calls.push(args[1]!);
      return {status: 69, stdout: '', stderr: 'HTTP status code: 401. Invalid credentials.'};
    },
  }), (error: Error) => {
    const output = distributionFailure(error);
    assert.match(output, /"status":69/); assert.match(output, /401/);
    return true;
  });
  assert.deepEqual(calls, ['submit']);
});

test('wait failure keeps the submitted ID even when diagnostic log retrieval fails', async () => {
  await assert.rejects(notarizeDistribution('/fixture/Application.app', credentials, {
    log: () => {}, run: async (_command: string, args: string[]) => {
      if (args[0] !== 'notarytool') return ok();
      if (args[1] === 'submit') return ok(JSON.stringify({id, status: 'In Progress'}));
      if (args[1] === 'log') throw new Error('log transport failed');
      return {status: null, signal: 'SIGTERM', error: {code: 'ETIMEDOUT'}, stdout: '', stderr: 'wait timeout'};
    },
  }), (error: Error) => {
    const output = distributionFailure(error);
    assert.match(output, new RegExp(id)); assert.match(output, /In Progress/);
    assert.match(output, /ETIMEDOUT/); assert.match(output, /SIGTERM/);
    assert.doesNotMatch(output, /log transport failed/);
    return true;
  });
});

test('zero-exit Invalid is a failure and exhausted stapler retries retain Accepted submission context', async () => {
  for (const status of ['Invalid', 'Accepted']) {
    let staples = 0;
    await assert.rejects(notarizeDistribution('/fixture/Application.dmg', credentials, {
      log: () => {}, wait: async () => {}, run: async (_command: string, args: string[]) => {
        if (args[0] === 'notarytool') return ok(JSON.stringify({id, status}));
        staples++; return {status: 65, stdout: '', stderr: 'ticket unavailable'};
      },
    }), (error: Error) => {
      const output = distributionFailure(error);
      assert.match(output, new RegExp(id)); assert.match(output, new RegExp(status));
      assert.match(output, status === 'Invalid' ? /"status":0/ : /"status":65/);
      return true;
    });
    assert.equal(staples, status === 'Accepted' ? 4 : 0);
  }
});
