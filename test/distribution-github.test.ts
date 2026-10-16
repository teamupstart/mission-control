import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { githubDistributionTransport } from '../scripts/distribution-github.mjs';
import { distributionMetadata } from '../scripts/distribution-contract.mjs';

const commit = 'a'.repeat(40);
const versions = {packageVersion: '1.26.0', lockVersion: '1.26.0', lockPackageVersion: '1.26.0'};
const metadata = (channel = 'stable') => distributionMetadata({channel, tag: 'v1.26.0', commit, versions});

function fakeGh(t: TestContext, responses: Record<string, unknown>, mode = '') {
  const root = mkdtempSync(join(tmpdir(), 'mission-gh-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const command = join(root, 'gh');
  const calls = join(root, 'calls');
  const responsePath = join(root, 'responses.json');
  writeFileSync(responsePath, JSON.stringify(responses));
  writeFileSync(command, `#!${process.execPath}
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({args, debug:process.env.GH_DEBUG ?? null, host:process.env.GH_HOST})+'\\n');
    const responses = JSON.parse(fs.readFileSync(${JSON.stringify(responsePath)}, 'utf8'));
    const mode = ${JSON.stringify(mode)};
    if (mode === 'denied') {process.stderr.write('token fixture-secret authorization https://example.invalid/?token=fixture-secret (HTTP 403)');process.exit(1);}
    if (mode === 'bytes') {process.stdout.write('binary bytes');process.exit(0);}
    const endpoint = args[3];
    const method = args[args.indexOf('--method') + 1];
    if (mode.startsWith('retire')) {
      if (method === 'PATCH') {
        Object.assign(responses[endpoint], JSON.parse(fs.readFileSync(0, 'utf8')));
        fs.writeFileSync(${JSON.stringify(responsePath)}, JSON.stringify(responses));
      }
      if (method === 'DELETE') {
        const id = Number(endpoint.split('/').at(-1));
        if (mode === 'retire-fail-once' && id === 11 && !fs.existsSync(${JSON.stringify(join(root, 'failed'))})) {
          fs.writeFileSync(${JSON.stringify(join(root, 'failed'))}, 'failed');
          process.stderr.write('denied (HTTP 403)');process.exit(1);
        }
        for (const key of Object.keys(responses)) if (key.includes('/assets?')) responses[key] = responses[key].filter(asset => asset.id !== id);
        fs.writeFileSync(${JSON.stringify(responsePath)}, JSON.stringify(responses));
        process.exit(0);
      }
    }
    if (responses[endpoint] === undefined) {process.stderr.write('not found (HTTP 404)');process.exit(1);}
    process.stdout.write(JSON.stringify(responses[endpoint]));
  `, {mode: 0o755});
  const transport = githubDistributionTransport({command, env: {GH_DEBUG: 'api', GH_HOST: 'evil.invalid'}});
  return {transport, calls: () => readFileSync(calls, 'utf8').trim().split('\n').map((line) => JSON.parse(line)),
    responses: () => JSON.parse(readFileSync(responsePath, 'utf8'))};
}

const prefix = 'repos/teamupstart/mission-control';
const release = {id: 7, tag_name: 'v1.26.0', draft: false, prerelease: false};

test('canonical transport rejects drafts, prereleases and wrong commit in stable discovery', async (t) => {
  for (const change of [{draft: true}, {prerelease: true}, {tag_name: `alpha-${commit}`}]) {
    const f = fakeGh(t, {[`${prefix}/releases/tags/v1.26.0`]: {...release, ...change}});
    await assert.rejects(f.transport.ensureRelease(metadata()), /channel or identity/);
  }
  const f = fakeGh(t, {[`${prefix}/releases/tags/v1.26.0`]: release, [`${prefix}/commits/v1.26.0`]: {sha: 'b'.repeat(40)}});
  await assert.rejects(f.transport.ensureRelease(metadata()), /exact build commit/);
});

test('stable release creation stays with Release Please; alpha verifies main ancestry and uses a prerelease namespace', async (t) => {
  const stable = fakeGh(t, {});
  await assert.rejects(stable.transport.ensureRelease(metadata()), /Release Please/);
  assert.equal(stable.calls().length, 1);
  const tag = `alpha-${commit}`;
  const alpha = fakeGh(t, {[`${prefix}/compare/${commit}...main`]: {status: 'ahead', merge_base_commit: {sha: commit}},
    [`${prefix}/releases`]: {...release, tag_name: tag, prerelease: true}, [`${prefix}/commits/${tag}`]: {sha: commit}});
  assert.deepEqual(await alpha.transport.ensureRelease(metadata('alpha')), {id: 7, tag});
  assert.ok(alpha.calls().some((call) => call.args.includes('POST')));
  for (const call of alpha.calls()) {assert.equal(call.host, 'github.com'); assert.equal(call.debug, null);}
  const offMain = fakeGh(t, {[`${prefix}/compare/${commit}...main`]: {status: 'diverged', merge_base_commit: {sha: 'b'.repeat(40)}}});
  await assert.rejects(offMain.transport.ensureRelease(metadata('alpha')), /canonical main/);
});

test('asset transport streams canonical API bytes with bounds and no leaked credentials in errors', async (t) => {
  const f = fakeGh(t, {}, 'bytes');
  const result = await f.transport.readAsset('123', 100, true);
  assert.equal(result.text, 'binary bytes');
  assert.equal(result.sha256, createHash('sha256').update('binary bytes').digest('hex'));
  assert.ok(f.calls()[0].args.includes(`${prefix}/releases/assets/123`));
  await assert.rejects(f.transport.readAsset('123', 1), /expected size/);
  await assert.rejects(f.transport.readAsset('https://evil.invalid', 100), /asset id/);
  const denied = fakeGh(t, {}, 'denied');
  await assert.rejects(denied.transport.ensureRelease(metadata()), (error: Error) => {
    assert.match(error.message, /HTTP 403/); assert.doesNotMatch(error.message, /fixture-secret|example.invalid/); return true;
  });
  await assert.rejects(denied.transport.readAsset('123', 100), /HTTP 403/);
});

test('alpha inventory excludes stable, drafts and mutable names and rejects moved tags', async (t) => {
  const tag = `alpha-${commit}`;
  const f = fakeGh(t, {[`${prefix}/releases?per_page=100&page=1`]: [
    release, {...release, tag_name: tag, draft: true, prerelease: true},
    {...release, tag_name: 'alpha-latest', prerelease: true},
    {...release, tag_name: tag, prerelease: true},
  ], [`${prefix}/commits/${tag}`]: {sha: commit}});
  assert.deepEqual(await f.transport.listAlphaReleases(), [{id: 7, tag, retired: false}]);
  const mismatch = fakeGh(t, {[`${prefix}/releases?per_page=100&page=1`]: [{...release, tag_name: tag, prerelease: true}], [`${prefix}/commits/${tag}`]: {sha: 'b'.repeat(40)}});
  await assert.rejects(mismatch.transport.listAlphaReleases(), /exact commit/);
});

for (const mode of ['retire', 'retire-fail-once']) test(`alpha ${mode} removes readiness first, resumes cleanup and refuses republication`, async (t) => {
  const tag = `alpha-${commit}`, alpha = {...release, tag_name: tag, prerelease: true};
  const f = fakeGh(t, {[`${prefix}/releases/7`]: alpha, [`${prefix}/commits/${tag}`]: {sha: commit},
    [`${prefix}/releases/7/assets?per_page=100&page=1`]: [
      {id: 11, name: `Mission-Control-${tag}-darwin-arm64.zip`, size: 4, state: 'uploaded'},
      {id: 12, name: `Mission-Control-${tag}-darwin-arm64.dmg`, size: 4, state: 'uploaded'},
      {id: 13, name: 'mission-control-manifest.json', size: 4, state: 'uploaded'},
    ]}, mode);
  if (mode === 'retire-fail-once') {
    await assert.rejects(f.transport.retireAlphaRelease({id: 7, tag}), /HTTP 403/);
    const remaining = await f.transport.listAssets({id: 7, tag});
    assert.deepEqual(remaining.map((asset) => asset.id), [11, 12], 'no ready manifest points to a partially retired set');
  }
  await f.transport.retireAlphaRelease({id: 7, tag});
  assert.deepEqual(await f.transport.listAssets({id: 7, tag}), []);
  const deletes = f.calls().filter((call) => call.args.includes('DELETE'));
  assert.equal(deletes[0].args[3], `${prefix}/releases/assets/13`);
  assert.ok(!deletes.some((call) => call.args[3] === `${prefix}/releases/7`), 'retirement preserves an identity tombstone');
  // A later producer recognizes the persisted retirement marker through the API.
  const tombstone = fakeGh(t, {[`${prefix}/compare/${commit}...main`]: {status: 'identical', merge_base_commit: {sha: commit}},
    [`${prefix}/releases/tags/${tag}`]: f.responses()[`${prefix}/releases/7`],
    [`${prefix}/releases?per_page=100&page=1`]: [{...f.responses()[`${prefix}/releases/7`], assets: []}]});
  await assert.rejects(tombstone.transport.ensureRelease(metadata('alpha')), /retired/);
  assert.deepEqual(await tombstone.transport.listAlphaReleases(), []);
  await assert.rejects(f.transport.retireAlphaRelease({id: 7, tag: 'v1.26.0'}), /Only an exact-commit alpha/);
});

test('alpha retirement refuses unexpected assets before changing readiness', async (t) => {
  const tag = `alpha-${commit}`;
  const f = fakeGh(t, {[`${prefix}/releases/7`]: {...release, tag_name: tag, prerelease: true},
    [`${prefix}/commits/${tag}`]: {sha: commit},
    [`${prefix}/releases/7/assets?per_page=100&page=1`]: [{id: 11, name: 'unrelated.zip'}]}, 'retire');
  await assert.rejects(f.transport.retireAlphaRelease({id: 7, tag}), /Unexpected alpha/);
  assert.ok(!f.calls().some((call) => call.args.includes('PATCH') || call.args.includes('DELETE')));
});
