import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { distributionFailure, distributionStages, DistributionStageError, redactDistributionText } from '../scripts/distribution-diagnostics.mjs';
import { distributionFailureDryRun } from './helpers/distribution-failure-runs.ts';

test('distribution failure survives the real builder temporary-directory exit hook', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import {TmpDir} from 'temp-file';
    import {runDistributionCli} from './scripts/package-distribution.mjs';
    await runDistributionCli(async () => {
      await new TmpDir().getTempFile({suffix: 'fixture'});
      throw new Error('fixture packaging failure');
    });
  `], {encoding: 'utf8'});
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /fixture packaging failure/);
});

test('the CLI permits temporary cleanup before pinning a failed exit', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import exitHook from 'async-exit-hook';
    import {runDistributionCli} from './scripts/package-distribution.mjs';
    exitHook(done => setTimeout(() => {console.log('cleanup completed'); done();}, 10));
    await runDistributionCli(async () => {throw new Error('failure');});
  `], {encoding: 'utf8'});
  assert.equal(result.status, 1);
  assert.match(result.stdout, /cleanup completed/);
});

test('redaction removes fake credentials, secret paths, PEM and generated keychain passwords', () => {
  const env = {CSC_LINK: 'base64-fake-certificate', CSC_KEY_PASSWORD: 'password with "quotes" and spaces',
    APPLE_API_KEY: '/private/key folder/auth.p8', APPLE_API_KEY_BASE64: 'base64-fake-private-key'};
  const pem = '-----BEGIN PRIVATE KEY-----\nFAKE-PRIVATE-KEY-BODY\n-----END PRIVATE KEY-----';
  const message = [Object.values(env).join('\n'), JSON.stringify(env), encodeURIComponent(env.CSC_KEY_PASSWORD), pem,
    'security create-keychain -p random-generated-password keychain',
    'security set-key-partition-list -S apple-tool:,apple: -k "unknown password with spaces" keychain',
    '{"command":"security","args":["unlock-keychain","-p","array-password"]}',
    '{"keychainPassword":"json-password"}',
    'xcrun notarytool submit app.zip --key "/another private/key.p8" --password "unknown token"',
    '::error::forged annotation', 'codesign: errSecInternalComponent'].join('\n');
  const error = new DistributionStageError('sign', Object.assign(new Error(message), {
    code: 'ERR_SIGN', status: 1, stderr: message, password: 'never serialize arbitrary properties',
  }));
  const output = distributionFailure(error, env);
  for (const value of [...Object.values(env), 'FAKE-PRIVATE-KEY-BODY', 'random-generated-password',
    'unknown password with spaces', 'array-password', 'json-password', 'unknown token', '.p8', 'never serialize arbitrary properties']) {
    assert.ok(!output.includes(value), value);
  }
  const parsed = JSON.parse(output.slice('[distribution] failed '.length));
  assert.equal(parsed.stage, 'sign'); assert.equal(parsed.error, 'Error');
  assert.equal(parsed.code, 'ERR_SIGN'); assert.equal(parsed.status, 1);
  assert.match(parsed.message, /errSecInternalComponent/);
  assert.doesNotMatch(output, /::error::/);
  assert.ok(redactDistributionText('x'.repeat(20_000)).length <= 6000);
});

test('stage transitions retain signing substage and child exit metadata', async () => {
  const output: string[] = [];
  const stages = distributionStages((line: string) => output.push(line));
  await assert.rejects(stages.run('build', async () => {
    stages.enter('sign');
    throw Object.assign(new Error('codesign failed'), {code: 9, signal: 'SIGTERM'});
  }), (error: Error) => {
    const detail = JSON.parse(distributionFailure(error).slice('[distribution] failed '.length));
    assert.equal(detail.stage, 'sign'); assert.equal(detail.code, 9); assert.equal(detail.signal, 'SIGTERM');
    return true;
  });
  assert.deepEqual(output, ['[distribution] stage=build', '[distribution] stage=sign']);
});

test('local dry run fails npm itself in every production stage with redacted details', (t) => {
  distributionFailureDryRun((line: string) => t.diagnostic(line));
});
