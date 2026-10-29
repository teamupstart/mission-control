// Immutable publication. Superseded alpha sets retire readiness before their bytes.
import { isDeepStrictEqual } from 'node:util';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { distributionManifest, distributionNames, localDistributionAssets, assertBuildMetadata } from './distribution-contract.mjs';
import { binaryPublisherPolicy, BINARY_MANIFEST_NAME, MAX_BINARY_MANIFEST_BYTES } from '../src/shared/binary-publisher-policy.mjs';
import { githubDistributionTransport } from './distribution-github.mjs';
import { validateBinaryManifest } from '../src/shared/binary-distribution.mjs';
import { verifyDistributionDmg, verifyDistributionArchives } from './verify-distribution.mjs';

function namedAsset(assets, name) {
  const matches = assets.filter((a) => a.name === name);
  if (matches.length > 1) throw new Error('Duplicate published asset names');
  return matches[0];
}

async function verifyAsset(transport, asset, expected) {
  if (!asset || !/^[1-9]\d{0,31}$/.test(String(asset.id)) || asset.state !== 'uploaded' || asset.size !== expected.bytes) {
    throw new Error('Published asset id, state or length mismatch');
  }
  const found = await transport.readAsset(String(asset.id), expected.bytes);
  if (found.bytes !== expected.bytes || found.sha256 !== expected.sha256) throw new Error('Published asset digest or length mismatch');
  return {...expected, id: String(asset.id)};
}

async function readReadyAlpha(transport, release, verifiedManifest) {
  const inventory = await transport.listAssets(release);
  const ready = namedAsset(inventory, BINARY_MANIFEST_NAME);
  if (!ready) return null;
  if (ready.state !== 'uploaded' || ready.size < 1 || ready.size > MAX_BINARY_MANIFEST_BYTES) throw new Error('Invalid alpha readiness during retention');
  const body = await transport.readAsset(String(ready.id), MAX_BINARY_MANIFEST_BYTES, true);
  if (body.bytes !== ready.size) throw new Error('Alpha manifest length changed during retention');
  let manifest;
  try { manifest = JSON.parse(body.text); } catch { throw new Error('Invalid alpha manifest during retention'); }
  if (validateBinaryManifest(manifest) || manifest.channel !== 'alpha' || release.tag !== `alpha-${manifest.commit}` || manifest.assets.length !== 2) {
    throw new Error('Alpha retention requires a complete exact-commit manifest');
  }
  if (verifiedManifest && !isDeepStrictEqual(manifest, verifiedManifest)) throw new Error('Retained alpha identity changed');
  for (const expected of manifest.assets) {
    const remote = namedAsset(inventory, expected.name);
    if (String(remote?.id) !== expected.id || remote?.size !== expected.bytes || remote?.state !== 'uploaded') throw new Error('Retained alpha asset inventory is incomplete');
    // Bytes already downloaded under these immutable ids need not be downloaded again.
    if (!verifiedManifest) await verifyAsset(transport, remote, expected);
  }
  return manifest;
}

export async function retainLatestAlpha({release, manifest, transport}) {
  if (validateBinaryManifest(manifest) || manifest.channel !== 'alpha' || release.tag !== `alpha-${manifest.commit}` || manifest.assets.length !== 2) {
    throw new Error('Retention requires a verified complete alpha identity');
  }
  const releases = await transport.listAlphaReleases();
  if (releases.some((item) => !/^alpha-[a-f0-9]{40}$/.test(item.tag)) || new Set(releases.map((item) => item.tag)).size !== releases.length) {
    throw new Error('Ambiguous alpha retention inventory');
  }
  let keeper = release, retained = manifest;
  for (const candidate of releases) {
    if (candidate.retired || candidate.tag === keeper.tag) continue;
    if (!await transport.isAncestor(retained.commit, candidate.tag.slice(6))) continue;
    const newer = await readReadyAlpha(transport, candidate);
    if (newer) {keeper = candidate; retained = newer;}
  }
  const retiredAlphaCommits = [];
  for (const candidate of releases) {
    if (candidate.tag === keeper.tag || !await transport.isAncestor(candidate.tag.slice(6), retained.commit)) continue;
    // Reconfirm the complete replacement before each retirement. An interrupted or
    // out-of-order job must never delete a newer build or the last ready alpha.
    if (!await readReadyAlpha(transport, keeper, retained)) throw new Error('Replacement alpha is no longer ready');
    await transport.retireAlphaRelease(candidate);
    retiredAlphaCommits.push(candidate.tag.slice(6));
  }
  return {retainedAlphaCommit: retained.commit, retiredAlphaCommits};
}

async function publicationResult(result, release, transport) {
  return result.manifest.channel === 'alpha'
    ? {...result, ...await retainLatestAlpha({release, manifest: result.manifest, transport})}
    : result;
}

export async function publishDistribution({metadata, files, transport}) {
  assertBuildMetadata(metadata);
  const local = await localDistributionAssets(metadata, files);
  const release = await transport.ensureRelease(metadata);
  let inventory = await transport.listAssets(release);
  const ready = namedAsset(inventory, BINARY_MANIFEST_NAME);
  let advertised = null;
  if (ready) {
    if (ready.state !== 'uploaded' || ready.size < 1 || ready.size > MAX_BINARY_MANIFEST_BYTES) throw new Error('Invalid ready manifest asset');
    const body = await transport.readAsset(String(ready.id), MAX_BINARY_MANIFEST_BYTES, true);
    if (body.bytes !== ready.size) throw new Error('Ready manifest length mismatch');
    try { advertised = JSON.parse(body.text); } catch { throw new Error('Invalid ready manifest JSON'); }
  }
  const assets = [];
  for (const expected of local) {
    let asset = namedAsset(inventory, expected.name);
    if (!asset) {
      if (ready) throw new Error('Ready manifest references an incomplete asset set');
      await transport.upload(release, files[expected.kind]);
      inventory = await transport.listAssets(release);
      asset = namedAsset(inventory, expected.name);
    }
    assets.push(await verifyAsset(transport, asset, expected));
  }
  const manifest = distributionManifest(metadata, assets);
  if (ready) {
    if (!isDeepStrictEqual(advertised, manifest)) throw new Error('Immutable ready manifest collision');
    return publicationResult({manifest, alreadyPublished: true}, release, transport);
  }
  // Re-list immediately before publishing readiness. A failed/ambiguous upload is
  // resolved by the next run's read path, never by overwriting a name.
  inventory = await transport.listAssets(release);
  if (namedAsset(inventory, BINARY_MANIFEST_NAME)) throw new Error('Another publisher exposed readiness; retry verification');
  for (const expected of assets) {
    const remote = namedAsset(inventory, expected.name);
    if (String(remote?.id) !== expected.id || remote?.state !== 'uploaded' || remote?.size !== expected.bytes) throw new Error('Asset inventory changed before readiness');
  }
  const body = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const directory = mkdtempSync(join(tmpdir(), 'mission-publish-'));
  try {
    const path = join(directory, BINARY_MANIFEST_NAME);
    writeFileSync(path, body, {mode: 0o600});
    await transport.upload(release, path);
    const uploaded = namedAsset(await transport.listAssets(release), BINARY_MANIFEST_NAME);
    await verifyAsset(transport, uploaded, {bytes: body.length, sha256: createHash('sha256').update(body).digest('hex')});
  } finally { rmSync(directory, {recursive: true, force: true}); }
  return publicationResult({manifest, alreadyPublished: false}, release, transport);
}

export async function qualifiedDistribution(directory, policy) {
  const metadata = JSON.parse(readFileSync(join(directory, 'build-metadata.json'), 'utf8'));
  assertBuildMetadata(metadata);
  const names = distributionNames(metadata);
  const files = Object.fromEntries(Object.entries(names).map(([kind, name]) => [kind, join(directory, name)]));
  const qualification = JSON.parse(readFileSync(join(directory, 'qualification.json'), 'utf8'));
  if (!isDeepStrictEqual(qualification.metadata, metadata) || qualification.teamId !== policy.teamId ||
      qualification.notarized !== true || qualification.copiedRuntime !== true ||
      qualification.recovery !== 'forward-only-after-receipt-commit' ||
      !/^[a-f0-9]{64}$/.test(qualification.appDigest ?? '') ||
      !isDeepStrictEqual(qualification.assets, await localDistributionAssets(metadata, files))) {
    throw new Error('Local qualification does not match the approved publisher and final archive bytes');
  }
  // Retained JSON and hashes are not a trust root. Reassess the actual archives
  // with Apple tools and the shipped publisher policy on every publication retry.
  await verifyDistributionDmg(files.dmg, policy);
  await verifyDistributionArchives({appDigest: qualification.appDigest, files, metadata, policy, requalifyRuntime: true});
  return {metadata, files};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const policy = binaryPublisherPolicy();
    const directory = resolve(process.argv[2] ?? 'release/distribution');
    const qualified = await qualifiedDistribution(directory, policy);
    const result = await publishDistribution({...qualified, transport: githubDistributionTransport()});
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`Distribution publication refused: ${error.message}`);
    process.exitCode = 1;
  }
}
