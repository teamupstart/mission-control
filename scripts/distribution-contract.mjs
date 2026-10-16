import { createHash } from 'node:crypto';
import { createReadStream, lstatSync } from 'node:fs';
import { basename } from 'node:path';
import { BINARY_MANIFEST_PROTOCOL, BINARY_RECEIPT_SCHEMA, BINARY_REPO, BINARY_BUNDLE_ID,
  INSTALL_HELPER_PROTOCOL, MAX_BINARY_ASSET_BYTES, validateBinaryBuildMetadata, validateBinaryManifest } from '../src/shared/binary-distribution.mjs';
import { MINIMUM_DISTRIBUTION_MACOS, MAX_BINARY_MANIFEST_BYTES } from '../src/shared/binary-publisher-policy.mjs';
import { releaseVersionProblem } from './assert-release-version.mjs';

export function distributionMetadata({channel, tag, commit, versions}) {
  const problem = releaseVersionProblem({tag: channel === 'stable' ? tag : `v${versions.packageVersion}`, ...versions});
  if (problem) throw new Error(problem);
  const metadata = {protocol: BINARY_MANIFEST_PROTOCOL, repo: BINARY_REPO, channel,
    releaseTag: channel === 'stable' ? tag : null, version: versions.packageVersion, commit,
    platform: 'darwin', arch: 'arm64', bundleId: BINARY_BUNDLE_ID,
    minimumSystemVersion: MINIMUM_DISTRIBUTION_MACOS,
    helperProtocol: {min: INSTALL_HELPER_PROTOCOL, max: INSTALL_HELPER_PROTOCOL}, receiptSchema: BINARY_RECEIPT_SCHEMA};
  assertBuildMetadata(metadata);
  return metadata;
}

export function assertBuildMetadata(metadata) {
  const problem = validateBinaryBuildMetadata(metadata);
  if (problem) throw new Error(problem);
}

export function distributionNames(metadata) {
  assertBuildMetadata(metadata);
  const identity = metadata.channel === 'stable' ? metadata.releaseTag : `alpha-${metadata.commit}`;
  const stem = `Mission-Control-${identity}-darwin-arm64`;
  return {'app-zip': `${stem}.zip`, dmg: `${stem}.dmg`};
}

export function distributionManifest(metadata, assets) {
  assertBuildMetadata(metadata);
  const {receiptSchema: _schema, ...identity} = metadata;
  const manifest = {...identity, assets};
  const problem = validateBinaryManifest(manifest);
  if (problem) throw new Error(problem);
  if (assets.length !== 2 || !['app-zip', 'dmg'].every((kind) => assets.some((a) => a.kind === kind))) {
    throw new Error('A ready distribution requires both the app ZIP and DMG');
  }
  if (Buffer.byteLength(JSON.stringify(manifest)) > MAX_BINARY_MANIFEST_BYTES) throw new Error('Manifest is too large');
  return manifest;
}

export async function fingerprintFile(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size < 1 || stat.size > MAX_BINARY_ASSET_BYTES) throw new Error('Invalid local distribution asset');
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    if (bytes > MAX_BINARY_ASSET_BYTES) throw new Error('Distribution asset exceeds the size limit');
    hash.update(chunk);
  }
  if (bytes !== stat.size) throw new Error('Distribution asset changed while reading');
  return {bytes, sha256: hash.digest('hex')};
}

export async function localDistributionAssets(metadata, files) {
  const names = distributionNames(metadata);
  const assets = [];
  for (const kind of ['app-zip', 'dmg']) {
    if (typeof files[kind] !== 'string' || basename(files[kind]) !== names[kind]) throw new Error('Unexpected distribution asset name');
    assets.push({kind, name: names[kind], ...await fingerprintFile(files[kind])});
  }
  return assets;
}
