// Browser-safe wire contracts. Shape validation is not publisher authentication.
// The caller's shipped publisher policy, never a manifest claim, authorizes execution.
import { APP_BUNDLE_NAME } from "./app-naming.mjs";
export const BINARY_MANIFEST_PROTOCOL = 1;
export const INSTALL_HELPER_PROTOCOL = 1;
export const BINARY_RECEIPT_SCHEMA = 2;
export const BINARY_REPO = 'teamupstart/mission-control';
export const BINARY_BUNDLE_ID = 'com.mission-control.app';
export const MAX_BINARY_ASSET_BYTES = 4 * 1024 ** 3;
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})(?:-[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*)?$/;
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const isBinaryDigest = (v) => typeof v === 'string' && DIGEST.test(v);
const bounded = (v, n) => typeof v === 'string' && v.length > 0 && v.length <= n;

function identityProblem(v) {
  if (!object(v) || v.protocol !== BINARY_MANIFEST_PROTOCOL) return 'Unsupported binary protocol';
  if (v.appBundleName !== undefined && v.appBundleName !== APP_BUNDLE_NAME) return 'Unsupported binary app name';
  if (v.repo !== BINARY_REPO || v.bundleId !== BINARY_BUNDLE_ID) return 'Unexpected binary product identity';
  if (!bounded(v.version, 80) || !VERSION.test(v.version) || typeof v.commit !== 'string' || !SHA.test(v.commit)) return 'Invalid binary build identity';
  if (!['stable', 'alpha'].includes(v.channel) || (v.channel === 'stable'
    ? v.releaseTag !== `v${v.version}` || v.version.includes('-') : v.releaseTag !== null)) return 'Inconsistent binary channel and tag';
  if (v.platform !== 'darwin' || v.arch !== 'arm64') return 'Unsupported binary platform';
  if (!bounded(v.minimumSystemVersion, 20) || !/^\d{1,2}\.\d{1,2}(?:\.\d{1,2})?$/.test(v.minimumSystemVersion)) return 'Invalid minimum macOS version';
  const range = v.helperProtocol;
  if (!object(range) || Object.keys(range).some((key) => !['min', 'max'].includes(key)) || !Number.isInteger(range.min) || !Number.isInteger(range.max) || range.min < 1 || range.max > 100 || range.min > INSTALL_HELPER_PROTOCOL || range.max < INSTALL_HELPER_PROTOCOL) return 'Incompatible install helper protocol';
  return null;
}

export function validateBinaryManifest(v) {
  const problem = identityProblem(v);
  if (problem) return problem;
  if (Object.keys(v).some((key) => !['protocol', 'repo', 'channel', 'releaseTag', 'version', 'commit', 'platform', 'arch', 'bundleId', 'minimumSystemVersion', 'helperProtocol', 'appBundleName', 'assets'].includes(key))) return 'Unknown manifest field';
  if (!Array.isArray(v.assets) || v.assets.length < 1 || v.assets.length > 2) return 'Invalid binary asset inventory';
  const kinds = new Set(), ids = new Set(), names = new Set();
  for (const asset of v.assets) {
    if (!object(asset) || Object.keys(asset).some((key) => !['kind', 'id', 'name', 'bytes', 'sha256'].includes(key)) || !['app-zip', 'dmg'].includes(asset.kind) || !bounded(asset.id, 32) || !/^[1-9]\d*$/.test(asset.id) ||
      !bounded(asset.name, 160) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(asset.name) || asset.name.includes('..') ||
      !asset.name.endsWith(asset.kind === 'app-zip' ? '.zip' : '.dmg') || !Number.isSafeInteger(asset.bytes) ||
      asset.bytes < 1 || asset.bytes > MAX_BINARY_ASSET_BYTES || !isBinaryDigest(asset.sha256)) return 'Invalid immutable binary asset';
    if (kinds.has(asset.kind) || ids.has(asset.id) || names.has(asset.name)) return 'Duplicate binary asset';
    kinds.add(asset.kind); ids.add(asset.id); names.add(asset.name);
  }
  return null;
}

export function validateBinaryBuildMetadata(v) {
  const problem = identityProblem(v);
  if (problem) return problem;
  if (v.receiptSchema !== BINARY_RECEIPT_SCHEMA || Object.keys(v).some((key) => ![
    'protocol', 'repo', 'channel', 'releaseTag', 'version', 'commit', 'platform', 'arch', 'bundleId',
    'minimumSystemVersion', 'helperProtocol', 'appBundleName', 'receiptSchema',
  ].includes(key))) return 'Invalid signed build metadata (archive provenance belongs outside the app)';
  return null;
}

export function validateBinaryProvenance(v) {
  if (!object(v) || Object.keys(v).some((key) => !['manifest', 'manifestSha256', 'assetId'].includes(key))) return 'Invalid binary provenance';
  const problem = validateBinaryManifest(v.manifest);
  if (problem) return problem;
  if (!isBinaryDigest(v.manifestSha256) || !v.manifest.assets.some((a) => a.id === v.assetId)) return 'Invalid binary manifest provenance';
  return null;
}
