import assert from 'node:assert/strict';
import test from 'node:test';
import { validateBinaryManifest, validateBinaryBuildMetadata } from '../src/shared/binary-distribution.mjs';
import { validateReceipt, CANONICAL_REPO } from '../src/shared/install-receipt-schema.mjs';

export function manifest() {
  return {protocol: 1, repo: CANONICAL_REPO, channel: 'stable', releaseTag: 'v1.26.0', version: '1.26.0',
    commit: 'b'.repeat(40), platform: 'darwin', arch: 'arm64', bundleId: 'com.mission-control.app',
    minimumSystemVersion: '12.0', helperProtocol: {min: 1, max: 1},
    assets: [{kind: 'app-zip', id: '12345', name: 'Mission-Control-1.26.0-arm64.zip', bytes: 1234, sha256: 'c'.repeat(64)}]};
}

test('binary contracts bound immutable identities and reject incompatible or ambiguous manifests', () => {
  assert.equal(validateBinaryManifest(manifest()), null);
  for (const change of [{protocol: 2}, {repo: 'other/repo'}, {channel: 'alpha'}, {releaseTag: 'v2.0.0'},
    {commit: 'main'}, {commit: ['b'.repeat(40)]}, {arch: 'x64'}, {version: '../app'}, {helperProtocol: {min: 2, max: 3}},
    {helperProtocol: {min: 1, max: 1, extra: 'unbounded'}},
    {assets: [...manifest().assets, ...manifest().assets]},
    {assets: [{...manifest().assets[0], name: '../escape.zip'}]},
    {assets: [{...manifest().assets[0], bytes: Number.MAX_SAFE_INTEGER}]}]) {
    assert.ok(validateBinaryManifest({...manifest(), ...change}), JSON.stringify(change));
  }
  assert.equal(validateBinaryManifest({...manifest(), channel: 'alpha', releaseTag: null}), null);
  const {assets: _assets, ...identity} = manifest();
  assert.equal(validateBinaryBuildMetadata({...identity, receiptSchema: 2}), null);
  assert.ok(validateBinaryBuildMetadata({...identity, receiptSchema: 2, assets: manifest().assets}), 'archive hashes must stay outside signed metadata');
});

test('legacy/source receipts remain readable and binary receipts require real immutable provenance', () => {
  const legacy = {schema: 1, repo: CANONICAL_REPO, releaseTag: 'v1.26.0', installedVersion: '1.26.0',
    installedCommit: 'b'.repeat(40), sourceClone: '/retained/installer', appPath: '/Applications/Mission Control.app',
    installedAt: '2026-10-14T00:00:00.000Z'};
  assert.equal(validateReceipt(legacy), null);
  assert.equal(validateReceipt({...legacy, schema: 2, kind: 'source'}), null);
  const {sourceClone: _sourceClone, ...base} = legacy;
  const binary = {...base, schema: 2, kind: 'binary', provenance: {manifest: manifest(), manifestSha256: 'd'.repeat(64), assetId: '12345'}};
  assert.equal(validateReceipt(binary), null);
  for (const change of [{sourceClone: '/fake'}, {installedCommit: 'a'.repeat(40)}, {provenance: null},
    {provenance: {...binary.provenance, extra: 'unbounded'}}, {schema: 3}, {kind: 'unknown'}]) {
    assert.ok(validateReceipt({...binary, ...change}), JSON.stringify(change));
  }
});
