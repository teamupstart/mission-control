import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { distributionInput, resolveDistributionTag } from '../scripts/distribution-input.mjs';
import { distributionMetadata } from '../scripts/distribution-contract.mjs';
import { distributionCredentials, distributionBuilderConfig } from '../scripts/package-distribution.mjs';
import { APPROVED_DEVELOPER_TEAM_ID, binaryPublisherPolicy } from '../src/shared/binary-publisher-policy.mjs';
import { BINARY_BUNDLE_ID, BINARY_REPO } from '../src/shared/binary-distribution.mjs';

const versions = {packageVersion: '1.26.0', lockVersion: '1.26.0', lockPackageVersion: '1.26.0'};
const commit = 'a'.repeat(40);
const push = {head_sha: commit, head_branch: 'main', event: 'push', conclusion: 'success', head_repository: {full_name: 'teamupstart/mission-control'}};
const input = {ref: 'main', commit, head: commit, versions, ciRuns: [push]};
const stableInput = {...input, ref: 'v1.26.0', ciRuns: [{...push, head_branch: 'v1.26.0'}],
  sourceTag: {ref: 'refs/tags/v1.26.0', commit}};

test('only exact successful canonical push CI qualifies stable or alpha publication', () => {
  assert.deepEqual(distributionInput(input), {commit, channel: 'alpha', tag: ''});
  assert.deepEqual(distributionInput(stableInput), {commit, channel: 'stable', tag: 'v1.26.0'});
  for (const ref of ['feature', 'alpha-latest', `alpha-${commit}`, 'v1.26.0-rc.1', 'v1.26.1']) {
    assert.throws(() => distributionInput({...input, ref}));
  }
  for (const change of [{conclusion: 'cancelled'}, {event: 'pull_request'}, {head_sha: 'b'.repeat(40)}, {head_repository: {full_name: 'fork/mission-control'}}]) {
    assert.throws(() => distributionInput({...input, ciRuns: [{...push, ...change}]}), /successful canonical/);
  }
  assert.throws(() => distributionInput({...input, head: 'b'.repeat(40)}), /source commit/);
});

test('a v-prefixed branch cannot qualify stable signing without the exact canonical tag commit', () => {
  for (const sourceTag of [undefined, {ref: 'refs/heads/v1.26.0', commit},
    {ref: 'refs/tags/v1.25.0', commit}, {ref: 'refs/tags/v1.26.0', commit: 'b'.repeat(40)}]) {
    assert.throws(() => distributionInput({...stableInput, sourceTag}), /canonical tag/);
  }
});

test('stable provenance reads only the canonical tag namespace and peels annotated tags with a bound', () => {
  const ref = 'v1.26.0', tagSha = 'c'.repeat(40);
  const calls: string[] = [];
  const sourceTag = resolveDistributionTag(ref, (endpoint) => {
    calls.push(endpoint);
    if (endpoint === `git/ref/tags/${ref}`) return {ref: `refs/tags/${ref}`, object: {type: 'tag', sha: tagSha}};
    assert.equal(endpoint, `git/tags/${tagSha}`);
    return {object: {type: 'commit', sha: commit}};
  });
  assert.deepEqual(sourceTag, stableInput.sourceTag);
  assert.deepEqual(calls, [`git/ref/tags/${ref}`, `git/tags/${tagSha}`]);
  assert.deepEqual(resolveDistributionTag(ref, () => ({ref: `refs/tags/${ref}`, object: {type: 'commit', sha: commit}})), sourceTag);
  assert.throws(() => resolveDistributionTag(ref, () => {throw new Error('HTTP 404');}), /404/);
  assert.throws(() => resolveDistributionTag(ref, () => ({ref: `refs/heads/${ref}`})), /namespace/);
  for (const object of [{type: 'tree', sha: commit}, {type: 'commit', sha: '../main'}]) {
    assert.throws(() => resolveDistributionTag(ref, () => ({ref: `refs/tags/${ref}`, object})));
  }
  assert.throws(() => resolveDistributionTag(ref, () => ({ref: `refs/tags/${ref}`, object: {type: 'tag', sha: tagSha}})), /nesting/);
});

test('the trusted CLI verifies a separate candidate checkout as data without executing its verifier', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mission-distribution-input-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const source = join(root, 'source'), output = join(root, 'output');
  mkdirSync(join(source, 'scripts'), {recursive: true});
  writeFileSync(join(source, 'package.json'), JSON.stringify({version: '9.8.7'}));
  writeFileSync(join(source, 'package-lock.json'), JSON.stringify({version: '9.8.7', packages: {'': {version: '9.8.7'}}}));
  writeFileSync(join(source, 'scripts/distribution-input.mjs'), 'throw new Error("candidate verifier must never execute");');
  const git = (...args: string[]) => execFileSync('git', args, {cwd: source, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  git('init'); git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
  const sha = git('rev-parse', 'HEAD');
  const responses = {
    [`repos/${BINARY_REPO}/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&status=success&per_page=100`]:
      {workflow_runs: [{...push, head_sha: sha, head_branch: 'v9.8.7'}]},
    [`repos/${BINARY_REPO}/git/ref/tags/v9.8.7`]: {ref: 'refs/tags/v9.8.7', object: {type: 'commit', sha}},
  };
  writeFileSync(join(root, 'gh'), `#!${process.execPath}\nconst responses=${JSON.stringify(responses)}; const result=responses[process.argv[5]]; if (!result) process.exit(1); process.stdout.write(JSON.stringify(result));\n`, {mode: 0o755});
  execFileSync(process.execPath, [resolve('scripts/distribution-input.mjs')], {env: {...process.env,
    PATH: `${root}:${process.env.PATH}`, SOURCE_DIRECTORY: source, SOURCE_SHA: sha, SOURCE_REF: 'v9.8.7', GITHUB_OUTPUT: output}});
  assert.equal(readFileSync(output, 'utf8'), `commit=${sha}\nchannel=stable\ntag=v9.8.7\n`);
});

for (const selected of [input, stableInput]) {
  test(`${selected.ref} distribution requires successful CI for that ref, not another ref at the same commit`, () => {
    const matching = selected.ciRuns[0];
    const other = selected.ref === 'main' ? stableInput.ciRuns[0] : push;
    assert.ok(matching && other);
    for (const ciRuns of [[other], [{...matching, conclusion: 'failure'}, other], [{...matching, head_branch: undefined}]]) {
      assert.throws(() => distributionInput({...selected, ciRuns}), /successful canonical/);
    }
    assert.equal(distributionInput({...selected, ciRuns: [other, matching]}).channel, selected.ref === 'main' ? 'alpha' : 'stable');
  });
}

test('Release Please merges wait for the stable tag and never also produce an alpha', () => {
  const pr = {merged_at: '2026-10-15T12:00:00Z', merge_commit_sha: commit,
    base: {ref: 'main', repo: {full_name: BINARY_REPO}}, head: {ref: 'release-please--branches--main--components--mission-control', repo: {full_name: BINARY_REPO}},
    labels: [{name: 'autorelease: tagged'}]};
  assert.deepEqual(distributionInput({...input, releasePulls: [pr]}), {commit, channel: 'skip', tag: ''});
  assert.equal(distributionInput({...stableInput, releasePulls: [pr]}).channel, 'stable');
  assert.equal(distributionInput({...input, commitTags: ['v1.26.0']}).channel, 'skip', 'an existing stable tag remains authoritative after a PR label is removed');
  assert.equal(distributionInput({...input, commitTags: ['v1.25.0', `alpha-${commit}`]}).channel, 'alpha');
  for (const change of [{merged_at: null}, {merge_commit_sha: 'b'.repeat(40)}, {labels: []},
    {head: {...pr.head, ref: 'feature'}}, {base: {...pr.base, ref: 'feature'}},
    {head: {...pr.head, repo: {full_name: 'fork/mission-control'}}}]) {
    assert.equal(distributionInput({...input, releasePulls: [{...pr, ...change}]}).channel, 'alpha');
  }
});

test('distribution pins the operator-approved identity, rejects incomplete credentials and uses hardened notarized packaging', async () => {
  assert.equal(APPROVED_DEVELOPER_TEAM_ID, 'S2FPCQK39Z');
  assert.deepEqual(binaryPublisherPolicy(), {repo: BINARY_REPO, bundleId: BINARY_BUNDLE_ID, teamId: APPROVED_DEVELOPER_TEAM_ID, notarized: true});
  const teamId = 'TESTTEAM01';
  const env = {CSC_NAME: `Developer ID Application: Fixture (${teamId})`, CSC_LINK: 'fixture', CSC_KEY_PASSWORD: 'fixture-password',
    APPLE_API_KEY: '/fixture/key.p8', APPLE_API_KEY_ID: 'fixture-key-id', APPLE_API_ISSUER: 'fixture-issuer'};
  assert.equal(distributionCredentials(env, {teamId}).appleApiKey, env.APPLE_API_KEY);
  for (const key of Object.keys(env)) assert.throws(() => distributionCredentials({...env, [key]: ''}, {teamId}));
  assert.throws(() => distributionCredentials(env, {teamId: 'OTHERTEAM1'}));
  const metadata = distributionMetadata({channel: 'alpha', commit, versions});
  const config = distributionBuilderConfig(metadata, env.CSC_NAME, '/output');
  assert.equal(config.extends, './electron-builder.yml');
  assert.equal(config.forceCodeSigning, true);
  assert.equal(config.mac?.identity, `Fixture (${teamId})`, 'builder selects certificate type, and rejects a type prefix');
  assert.equal(config.mac?.hardenedRuntime, true);
  assert.equal(config.mac?.notarize, true);
  assert.equal(config.electronFuses?.runAsNode, true);
  assert.equal(config.electronFuses?.onlyLoadAppFromAsar, false);
  assert.deepEqual(config.extraMetadata?.missionBinary, metadata);
  const require = createRequire(import.meta.url);
  const {validateConfiguration} = require('app-builder-lib/out/util/config/config.js');
  const {DebugLogger} = require('builder-util');
  await validateConfiguration(config, new DebugLogger(false));
});

test('workflow keeps secrets behind canonical push checks, exact checkout, environment and non-cancelling publication', () => {
  const require = createRequire(import.meta.url);
  const {parse} = require('yaml') as {parse(input: string): any};
  const workflow = parse(readFileSync('.github/workflows/distribution.yml', 'utf8'));
  assert.deepEqual(Object.keys(workflow.on).sort(), ['workflow_dispatch', 'workflow_run']);
  assert.deepEqual(workflow.on.workflow_run.workflows, ['CI']);
  assert.match(workflow.jobs.input.if, /workflow_run\.event == 'push'/);
  assert.match(workflow.jobs.input.if, /workflow_run\.conclusion == 'success'/);
  assert.match(workflow.jobs.input.if, /head_repository\.full_name == 'teamupstart\/mission-control'/);
  assert.doesNotMatch(JSON.stringify(workflow.jobs.input), /secrets\./);
  const inputSteps = workflow.jobs.input.steps;
  assert.equal(inputSteps[0].with.ref, '${{ github.workflow_sha }}', 'candidate code cannot approve itself for signing');
  assert.equal(inputSteps[1].with.ref, '${{ github.event.workflow_run.head_sha || github.sha }}');
  assert.equal(inputSteps[1].with.path, '.tmp/distribution-source');
  const verifier = inputSteps.find((s: any) => s.id === 'identity');
  assert.equal(verifier.run, 'node scripts/distribution-input.mjs');
  assert.equal(verifier['working-directory'], undefined);
  assert.equal(verifier.env.SOURCE_DIRECTORY, '${{ github.workspace }}/.tmp/distribution-source');
  const job = workflow.jobs.package;
  assert.equal(job['runs-on'], 'macos-15');
  assert.equal(job.needs, 'input');
  assert.equal(job.if, "needs.input.outputs.channel != 'skip'");
  assert.equal(job.environment, 'desktop-distribution');
  assert.equal(job.concurrency['cancel-in-progress'], false);
  assert.match(job.concurrency.group, /== 'alpha' && 'distribution-alpha'/);
  assert.equal(job.steps[0].with.ref, '${{ needs.input.outputs.commit }}');
  assert.equal(job.steps[0].with['persist-credentials'], false);
  const packageStep = job.steps.findIndex((s: any) => s.run === 'npm run package:distribution');
  const tokenStep = job.steps.findIndex((s: any) => s.id === 'release-app-token');
  const publishStep = job.steps.findIndex((s: any) => s.run === 'npm run publish:distribution');
  assert.ok(packageStep > 0 && tokenStep > packageStep && publishStep > tokenStep);
  assert.equal(job.steps[tokenStep].with['permission-contents'], 'write');
  assert.equal(job.steps[tokenStep].with.repositories, 'mission-control');
  assert.equal(job.steps[tokenStep].with['permission-pull-requests'], undefined);
  const config = parse(readFileSync('electron-builder.yml', 'utf8'));
  assert.equal(config.asar, false);
  assert.equal(config.mac.identity, null, 'local developer packaging remains credential-free');
  assert.ok(config.files.includes('src/shared/binary-publisher-policy.mjs'));
});
