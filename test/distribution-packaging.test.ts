import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { before, after, mock } from 'node:test';
import { packageDistribution } from '../scripts/package-distribution.mjs';
import { qualifiedDistribution } from '../scripts/publish-distribution.mjs';
import { distributionNames, localDistributionAssets } from '../scripts/distribution-contract.mjs';
import { binaryPublisherPolicy } from '../src/shared/binary-publisher-policy.mjs';
import { distributionFailure } from '../scripts/distribution-diagnostics.mjs';
import { fixture, installDistributionFixture, restoreDistributionFixture } from './helpers/distribution-packaging.ts';

const policy = binaryPublisherPolicy();
const commit = 'a'.repeat(40);
before(() => { installDistributionFixture(); mock.method(console, 'log', () => {}); });
after(restoreDistributionFixture);

for (const target of ['parent', 'dmg']) test(`${target} ticket validation recovers from Apple's dropped connection`, async (t) => {
  const f = fixture(t, `${target}-staple-transient`);
  await packageDistribution({repoRoot: f.root, env: f.env});
  const path = [...f.validationAttempts.keys()].find((path) => target === 'parent' ? path.endsWith('/Parent.app') : path.endsWith('.dmg'))!;
  assert.equal(f.validationAttempts.get(path), 2);
  assert.ok(existsSync(join(f.output, 'qualification.json')));
});

test('persistent Apple ticket transport failure withholds qualification and retains the failing stage', async (t) => {
  const f = fixture(t, 'parent-staple-network');
  await assert.rejects(packageDistribution({repoRoot: f.root, env: f.env}), (error: Error) => {
    const diagnostic = JSON.parse(distributionFailure(error).slice('[distribution] failed '.length));
    assert.equal(diagnostic.stage, 'qualifySignedRuntime');
    assert.equal(diagnostic.command, '/usr/bin/xcrun');
    assert.equal(diagnostic.status, 68);
    assert.match(diagnostic.stdout, /NSURLErrorDomain Code=-1005/);
    return true;
  });
  const path = [...f.validationAttempts.keys()].find((path) => path.endsWith('/Parent.app'))!;
  assert.equal(f.validationAttempts.get(path), 4);
  f.assertUnqualified();
});

test('Gatekeeper child refusal keeps spctl status and assessment in the stage diagnostic', async (t) => {
  const f = fixture(t, 'gatekeeper-status');
  await assert.rejects(packageDistribution({repoRoot: f.root, env: f.env}), (error: Error) => {
    const diagnostic = JSON.parse(distributionFailure(error).slice('[distribution] failed '.length));
    assert.equal(diagnostic.stage, 'verifyDistributionApp');
    assert.equal(diagnostic.command, 'spctl'); assert.equal(diagnostic.status, 3);
    assert.match(diagnostic.stderr, /Unnotarized Developer ID/);
    return true;
  });
  f.assertUnqualified();
});

for (const channel of ['stable', 'alpha']) test(`${channel} packaging qualifies final archives before exposing publication input`, async (t) => {
  const f = fixture(t, '', channel);
  await packageDistribution({repoRoot: f.root, env: f.env});
  f.beginRecovery();
  const ready = await qualifiedDistribution(f.output, policy);
  assert.equal(ready.metadata.channel, channel);
  assert.equal(ready.metadata.commit, commit);
  const qualification = JSON.parse(readFileSync(join(f.output, 'qualification.json'), 'utf8'));
  assert.equal(qualification.copiedRuntime, true);
  assert.equal(qualification.notarized, true);
  assert.equal(qualification.assets.length, 2);
  assert.deepEqual(f.mcpMethods, [...Array(2)].flatMap(() => ['initialize', 'notifications/initialized', 'tools/list']));
  let previous = -1;
  for (const stage of ['sign-app', 'verify-app-signature', 'validate-app-staple', 'quarantine-copy', 'copied-parent', 'mcp',
    'build-dmg', 'notarize-dmg', 'verify-dmg-signature', 'validate-dmg-staple', 'archive-zip', 'mount-dmg', 'extract-zip', 'detach-dmg']) {
    const position = f.stages.indexOf(stage);
    assert.ok(position > previous, `${stage} must execute in qualification order`);
    previous = position;
  }
  assert.deepEqual(f.mounts, []);
  assert.ok(f.roots.every((root) => !existsSync(root)), 'temporary runtime copies are reclaimed');
  writeFileSync(ready.files['app-zip'], 'changed after qualification');
  await assert.rejects(qualifiedDistribution(f.output, policy), /final archive bytes/);
});

for (const [failure, reason] of [
  ['signing', /fixture signing failed/],
  ['app-signature', /fixture app signature invalid/],
  ['gatekeeper', /notarized Developer ID policy/],
  ['app-staple', /Distribution verification failed: \/usr\/bin\/xcrun/],
  ['fuse', /RunAsNode must remain enabled/],
  ['node-options-fuse', /NodeOptions environment variable must remain disabled/],
  ['inspector-fuse', /Node CLI inspector arguments must remain disabled/],
  ['parent', /signed parent must acknowledge/],
  ['mcp', /MCP refused the qualification handshake/],
  ['host-runtime', /Host runtime traps must never execute/],
  ['notarization', /Distribution verification failed: notarytool/],
  ['dmg-signature', /Distribution verification failed: \/usr\/bin\/codesign/],
  ['dmg-staple', /Distribution verification failed: \/usr\/bin\/xcrun/],
  ['dmg-bytes', /DMG must contain the exact signed app/],
  ['zip-bytes', /ZIP must contain the exact signed app/],
] as const) {
  test(`${failure} failure withholds qualification and publication input`, async (t) => {
    const f = fixture(t, failure);
    await assert.rejects(packageDistribution({repoRoot: f.root, env: f.env}), reason);
    f.assertUnqualified();
    if (failure === 'dmg-bytes' || failure === 'zip-bytes') {
      assert.ok(f.stages.includes('mount-dmg'), 'archive verification must reach the DMG mount');
      assert.ok(f.stages.includes('detach-dmg'), 'failed archive verification still detaches the DMG');
      assert.deepEqual(f.mounts, []);
    }
    if (['parent', 'mcp', 'host-runtime', 'notarization', 'dmg-signature', 'dmg-staple', 'dmg-bytes', 'zip-bytes'].includes(failure)) {
      assert.ok(f.roots.length > 0, 'these failures must reach copied runtime qualification');
      assert.ok(f.roots.every((root) => !existsSync(root)), 'temporary runtime copies are reclaimed after failure');
    }
  });
}

for (const [failure, reason] of [
  ['app-signature', /fixture app signature invalid/],
  ['app-staple', /Distribution verification failed/],
  ['gatekeeper', /Notarized Developer ID/],
  ['dmg-signature', /Distribution verification failed/],
  ['dmg-staple', /Distribution verification failed/],
  ['dmg-bytes', /DMG must contain the exact signed app/],
  ['zip-bytes', /ZIP must contain the exact signed app/],
  ['mcp', /MCP refused the qualification handshake/],
] as const) test(`recovery rechecks ${failure} even with matching edited qualification hashes`, async (t) => {
  const f = fixture(t);
  await packageDistribution({repoRoot: f.root, env: f.env});
  f.beginRecovery(failure);
  const path = join(f.output, 'qualification.json');
  const qualification = JSON.parse(readFileSync(path, 'utf8'));
  const names = distributionNames(qualification.metadata);
  const files = {'app-zip': join(f.output, names['app-zip']), dmg: join(f.output, names.dmg)};
  // Model a retained artifact edited together with its local attestation.
  for (const file of Object.values(files)) writeFileSync(file, 'changed retained bytes');
  qualification.assets = await localDistributionAssets(qualification.metadata, files);
  writeFileSync(path, JSON.stringify(qualification));
  await assert.rejects(qualifiedDistribution(f.output, policy), reason);
});
