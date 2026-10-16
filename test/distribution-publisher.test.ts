import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { distributionManifest, distributionMetadata, distributionNames, localDistributionAssets } from '../scripts/distribution-contract.mjs';
import { publishDistribution, qualifiedDistribution, retainLatestAlpha } from '../scripts/publish-distribution.mjs';
import type { DistributionTransport, RemoteAsset } from '../scripts/distribution-github.mjs';
import { binaryReleaseTag, BINARY_MANIFEST_NAME } from '../src/shared/binary-publisher-policy.mjs';

const versions = {packageVersion: '1.26.0', lockVersion: '1.26.0', lockPackageVersion: '1.26.0'};
const metadata = (channel = 'stable') => distributionMetadata({channel, tag: 'v1.26.0', commit: 'a'.repeat(40), versions});

function fixture(t: TestContext, channel = 'stable') {
  const root = mkdtempSync(join(tmpdir(), 'mission-publisher-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const build = metadata(channel), names = distributionNames(build);
  const files = {'app-zip': join(root, names['app-zip']), dmg: join(root, names.dmg)};
  writeFileSync(files['app-zip'], 'signed zip fixture'); writeFileSync(files.dmg, 'signed dmg fixture');
  const inventory: Array<RemoteAsset & {body: Buffer}> = [];
  const uploads: string[] = [];
  let interruption: {name: string; after: boolean} | null = null;
  const transport: DistributionTransport = {
    async listAlphaReleases() {return [{id: 1, tag: binaryReleaseTag(build)}];},
    async isAncestor(ancestor, descendant) {return ancestor === descendant;},
    async retireAlphaRelease() {throw new Error('This fixture has no older alphas');},
    async ensureRelease(input) {return {id: 1, tag: binaryReleaseTag(input)};},
    async listAssets() {return inventory.map(({body: _body, ...asset}) => ({...asset}));},
    async upload(_release, path) {
      const name = basename(path); uploads.push(name);
      if (interruption?.name === name && !interruption.after) throw new Error('Interrupted before upload');
      assert.ok(!inventory.some((asset) => asset.name === name), 'publisher must not overwrite an existing asset');
      const body = readFileSync(path);
      inventory.push({id: inventory.length + 1, name, size: body.length, state: 'uploaded', body});
      if (interruption?.name === name && interruption.after) throw new Error('Connection lost after upload');
    },
    async readAsset(id, maxBytes, text) {
      const found = inventory.find((a) => String(a.id) === id)!;
      assert.ok(found.body.length <= maxBytes);
      return {bytes: found.body.length, sha256: createHash('sha256').update(found.body).digest('hex'), ...(text ? {text: found.body.toString()} : {})};
    },
  };
  return {root, build, names, files, inventory, uploads, transport,
    interrupt(name: string, after: boolean) {interruption = {name, after};}, resume() {interruption = null;},
    publish() {return publishDistribution({metadata: build, files, transport});}};
}

for (const channel of ['stable', 'alpha']) test(`${channel} publication uses C1 and exposes readiness only after both verified assets`, async (t) => {
  const f = fixture(t, channel);
  const result = await f.publish();
  assert.deepEqual(f.uploads, [f.names['app-zip'], f.names.dmg, BINARY_MANIFEST_NAME]);
  assert.equal(result.manifest.releaseTag, channel === 'stable' ? 'v1.26.0' : null);
  assert.equal(binaryReleaseTag(result.manifest), channel === 'stable' ? 'v1.26.0' : `alpha-${'a'.repeat(40)}`);
  assert.equal(result.manifest.commit, 'a'.repeat(40));
  assert.deepEqual(result.manifest.assets.map((a) => a.id), ['1', '2']);
  assert.equal('receiptSchema' in result.manifest, false);
  assert.equal((await f.publish()).alreadyPublished, true);
  assert.equal(f.uploads.length, 3, 'identical retry only verifies');
});

for (const boundary of ['zip-after', 'dmg-before', 'manifest-before', 'manifest-after']) test(`interruption at ${boundary} resumes without replacing published bytes`, async (t) => {
  const f = fixture(t);
  const name = boundary.startsWith('zip') ? f.names['app-zip'] : boundary.startsWith('dmg') ? f.names.dmg : BINARY_MANIFEST_NAME;
  f.interrupt(name, boundary.endsWith('after'));
  await assert.rejects(f.publish());
  assert.equal(f.inventory.some((a) => a.name === BINARY_MANIFEST_NAME), boundary === 'manifest-after');
  const previous = f.inventory.map((a) => ({...a}));
  f.resume();
  const result = await f.publish();
  assert.equal(result.alreadyPublished, boundary === 'manifest-after');
  for (const asset of previous) assert.deepEqual(f.inventory.find((a) => a.id === asset.id), asset);
});

for (const ready of [false, true]) test(`immutable byte collision refuses a ${ready ? 'ready' : 'partial'} identity`, async (t) => {
  const f = fixture(t);
  if (!ready) f.interrupt(f.names.dmg, false);
  await f.publish().catch(() => {});
  f.resume(); f.uploads.length = 0;
  writeFileSync(f.files['app-zip'], 'different zip data!');
  await assert.rejects(f.publish(), /digest|length/);
  assert.deepEqual(f.uploads, []);
});

test('a ready manifest cannot be repaired by adding a missing asset or changing commit identity', async (t) => {
  const f = fixture(t);
  await f.publish();
  f.inventory.splice(1, 1); f.uploads.length = 0;
  await assert.rejects(f.publish(), /incomplete/);
  assert.deepEqual(f.uploads, []);
  f.build.commit = 'b'.repeat(40);
  await assert.rejects(f.publish());
});

for (const failure of ['size', 'digest', 'starter', 'denied']) test(`remote ${failure} failure never exposes readiness`, async (t) => {
  const f = fixture(t);
  if (failure === 'denied') f.transport.upload = async () => {throw new Error('Access denied');};
  else {
    const list = f.transport.listAssets;
    f.transport.listAssets = async (release) => (await list(release)).map((asset) => ({...asset,
      ...(failure === 'size' ? {size: asset.size + 1} : failure === 'starter' ? {state: 'starter'} : {})}));
    if (failure === 'digest') f.transport.readAsset = async () => ({bytes: 18, sha256: '0'.repeat(64)});
  }
  await assert.rejects(f.publish());
  assert.ok(!f.inventory.some((a) => a.name === BINARY_MANIFEST_NAME));
});

test('producer rejects mismatched metadata and requires both archive kinds without widening C1', () => {
  for (const change of [{channel: 'preview'}, {commit: 'main'}, {tag: 'v1.26.1'}, {versions: {...versions, lockVersion: '1.0.0'}}]) {
    assert.throws(() => distributionMetadata({channel: 'stable', tag: 'v1.26.0', commit: 'a'.repeat(40), versions, ...change}));
  }
  assert.throws(() => distributionNames({...metadata(), arch: 'x64'} as never), /platform/);
  assert.throws(() => distributionManifest(metadata(), [{kind: 'dmg', id: '1', name: 'app.dmg', bytes: 1, sha256: 'c'.repeat(64)}]), /both/);
});

test('publication input binds qualification to the final archive bytes and approved team', async (t) => {
  const f = fixture(t);
  const policy = {teamId: 'TESTTEAM01'};
  writeFileSync(join(f.root, 'build-metadata.json'), JSON.stringify(f.build));
  const qualification = {metadata: f.build, teamId: policy.teamId, assets: await localDistributionAssets(f.build, f.files),
    appDigest: 'a'.repeat(64), notarized: true, copiedRuntime: true, recovery: 'forward-only-after-receipt-commit'};
  writeFileSync(join(f.root, 'qualification.json'), JSON.stringify(qualification));
  assert.deepEqual(await qualifiedDistribution(f.root, policy), {metadata: f.build, files: f.files});
  await assert.rejects(qualifiedDistribution(f.root, {teamId: 'OTHERTEAM1'}), /qualification/);
  writeFileSync(f.files.dmg, 'bytes changed after qualification');
  await assert.rejects(qualifiedDistribution(f.root, policy), /qualification/);
});

for (const failure of ['malformed', 'oversized', 'wrong-commit', 'duplicate-name', 'wrong-id']) test(`ready ${failure} is rejected without writes`, async (t) => {
  const f = fixture(t);
  await f.publish(); f.uploads.length = 0;
  const ready = f.inventory.find((a) => a.name === BINARY_MANIFEST_NAME)!;
  if (failure === 'duplicate-name') f.inventory.push({...f.inventory[0]!, id: 99});
  else if (failure === 'oversized') ready.size = 32 * 1024;
  else {
    const manifest = JSON.parse(ready.body.toString());
    if (failure === 'wrong-commit') manifest.commit = 'b'.repeat(40);
    if (failure === 'wrong-id') manifest.assets[0].id = '99';
    ready.body = Buffer.from(failure === 'malformed' ? 'not JSON' : JSON.stringify(manifest));
    ready.size = ready.body.length;
  }
  await assert.rejects(f.publish());
  assert.deepEqual(f.uploads, []);
});

async function retentionFixture(t: TestContext) {
  const f = fixture(t, 'alpha');
  const {manifest} = await f.publish();
  const releases = [{id: 1, tag: binaryReleaseTag(f.build)}];
  const inventories = new Map([[1, f.inventory]]);
  const retirements: number[] = [], downloads: string[] = [];
  f.transport.listAlphaReleases = async () => releases;
  f.transport.listAssets = async (release) => inventories.get(release.id)!;
  f.transport.isAncestor = async (ancestor, descendant) => ancestor <= descendant;
  f.transport.readAsset = async (id, maxBytes, text) => {
    downloads.push(id);
    const asset = [...inventories.values()].flat().find((item) => String(item.id) === id)!;
    assert.ok(asset.body.length <= maxBytes);
    return {bytes: asset.body.length, sha256: createHash('sha256').update(asset.body).digest('hex'), ...(text ? {text: asset.body.toString()} : {})};
  };
  f.transport.retireAlphaRelease = async (release) => {retirements.push(release.id); inventories.set(release.id, []);};
  function add(commit: string, ready = true) {
    const id = releases.length + 1, build = {...f.build, commit}, names = distributionNames(build);
    const assets = (['app-zip', 'dmg'] as const).map((kind, index) => {
      const body = Buffer.from(`alpha ${commit} ${kind}`);
      return {id: id * 10 + index, name: names[kind], size: body.length, state: 'uploaded', body};
    });
    const manifest = distributionManifest(build, assets.map((asset, index) => ({kind: index ? 'dmg' : 'app-zip', id: String(asset.id), name: asset.name,
      bytes: asset.size, sha256: createHash('sha256').update(asset.body).digest('hex')})));
    if (ready) {
      const body = Buffer.from(JSON.stringify(manifest));
      assets.push({id: id * 10 + 2, name: BINARY_MANIFEST_NAME, size: body.length, state: 'uploaded', body});
    }
    releases.push({id, tag: binaryReleaseTag(build)});
    inventories.set(id, assets);
    return {id, assets};
  }
  return {...f, add, retirements, downloads, retain: () => retainLatestAlpha({release: releases[0]!, manifest, transport: f.transport})};
}

test('alpha retention retires ancestors only after a complete replacement is verified', async (t) => {
  const f = await retentionFixture(t), older = f.add('0'.repeat(40));
  const incompleteNewer = f.add('b'.repeat(40), false);
  const result = await f.retain();
  assert.equal(result.retainedAlphaCommit, f.build.commit);
  assert.deepEqual(f.retirements, [older.id]);
  assert.ok(!f.retirements.includes(incompleteNewer.id));
  assert.ok(f.inventory.some((asset) => asset.name === BINARY_MANIFEST_NAME));
});

test('an out-of-order alpha job retains the newer ready commit and retires itself', async (t) => {
  const f = await retentionFixture(t), newer = f.add('b'.repeat(40));
  const result = await f.retain();
  assert.equal(result.retainedAlphaCommit, 'b'.repeat(40));
  assert.deepEqual(f.retirements, [1]);
  assert.ok(f.downloads.includes(String(newer.id * 10)) && f.downloads.includes(String(newer.id * 10 + 1)), 'newer archive bytes were verified before deleting the older build');
  assert.ok(newer.assets.some((asset) => asset.name === BINARY_MANIFEST_NAME));
});

for (const failure of ['missing-archive', 'changed-bytes']) test(`alpha retention preserves existing builds when the replacement has ${failure}`, async (t) => {
  const f = await retentionFixture(t);
  f.add('0'.repeat(40));
  const newer = f.add('b'.repeat(40));
  if (failure === 'missing-archive') newer.assets.shift();
  else newer.assets[0]!.body = Buffer.from('corrupt archive');
  await assert.rejects(f.retain());
  assert.deepEqual(f.retirements, []);
  assert.ok(f.inventory.some((asset) => asset.name === BINARY_MANIFEST_NAME));
});
