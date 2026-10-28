import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const failureStages = ['build', 'sign', 'notarize (app)', 'verifyDistributionApp',
  'qualifySignedRuntime', 'dmg build', 'notarize (dmg)', 'ditto', 'archive verification', 'metadata'];

export function distributionFailureDryRun(log = console.log) {
  for (const stage of failureStages) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CSC_|APPLE_|GH_|GITHUB_|DEBUG$)/.test(key)));
    const result = spawnSync('npm', ['run', 'package:distribution'], {encoding: 'utf8', timeout: 30_000,
      env: {...env, MISSION_DISTRIBUTION_FIXTURE_STAGE: stage,
        NODE_OPTIONS: `--import tsx --import ${pathToFileURL(resolve('test/fixtures/distribution-failure-preload.ts')).href}`}});
    assert.equal(result.status, 1, `${stage}: ${result.stdout}\n${result.stderr}`);
    const line = result.stderr.split('\n').find((line) => line.startsWith('[distribution] failed '));
    assert.ok(line, `${stage}: missing diagnostic: ${result.stderr}`);
    const diagnostic = JSON.parse(line.slice('[distribution] failed '.length));
    assert.equal(diagnostic.stage, stage);
    assert.equal(diagnostic.status, 17, line);
    assert.match(line, /REDACTED/);
    assert.doesNotMatch(line, /fixture-certificate-secret|fixture-password-secret|\.p8/);
    assert.doesNotMatch(result.stdout + result.stderr, /fixture-certificate-secret|fixture-password-secret|key\.p8/);
    log(`npm run package:distribution [fixture: ${stage}] exit=${result.status}\n${line}`);
  }
}

if (process.argv[1] === resolve('test/helpers/distribution-failure-runs.ts')) distributionFailureDryRun();
