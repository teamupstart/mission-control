// Shared binary installation policy; no CLI execution or Electron startup imports.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { validateBinaryManifest } from '../src/shared/binary-distribution.mjs';
import { MAX_BINARY_MANIFEST_BYTES } from '../src/shared/binary-publisher-policy.mjs';
import { validateReceipt, isTrustedInstallRepo } from '../src/shared/install-receipt-schema.mjs';
import { readMigrationJson } from './install-migration.mjs';

export function parseBinaryInstallArgs(argv) {
  const options = {bundle: null, manifest: null, scope: null, appsDir: null, dryRun: false, enroll: false};
  const names = {'--bundle': 'bundle', '--manifest': 'manifest', '--scope': 'scope', '--apps-dir': 'appsDir'};
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (seen.has(key)) throw new Error(`Repeated installer argument: ${key}`);
    seen.add(key);
    if (key === '--dry-run') options.dryRun = true;
    else if (key === '--enroll') options.enroll = true;
    else if (names[key] && argv[i + 1]) options[names[key]] = argv[++i];
    else throw new Error(`Unsupported binary installer argument: ${key}`);
  }
  if (!options.bundle || !options.manifest) throw new Error('A verified bundle and manifest are required');
  return options;
}

export function readBinaryReceipt(directory) {
  const path = join(directory, 'install-receipt.json');
  if (!lstatSync(path, {throwIfNoEntry: false})) return null;
  const receipt = readMigrationJson(path);
  const problem = validateReceipt(receipt);
  if (problem || !isTrustedInstallRepo(receipt.repo)) throw new Error(`The existing receipt cannot authorize installation: ${problem ?? 'untrusted repository'}. Preserve it and repair the managed installation first.`);
  return receipt;
}

export function binaryInstallReceipt(manifestText, destination, previous, installedAt = new Date().toISOString()) {
  if (Buffer.byteLength(manifestText) > MAX_BINARY_MANIFEST_BYTES) throw new Error('Manifest exceeds its size limit');
  const manifest = JSON.parse(manifestText);
  const problem = validateBinaryManifest(manifest);
  if (problem) throw new Error(problem);
  const asset = manifest.assets.find((entry) => entry.kind === 'dmg');
  if (!asset || manifest.assets.length !== 2) throw new Error('A complete ZIP and DMG publication is required');
  if (destination.problem) throw new Error(destination.problem);
  // A legacy scope stays absent. Never infer system consent from /Applications.
  const receipt = {schema: 2, kind: 'binary', repo: manifest.repo, releaseTag: manifest.releaseTag,
    installedVersion: manifest.version, installedCommit: manifest.commit, installedAt,
    appPath: join(destination.appsDir, 'Mission Control.app'),
    ...(destination.installScope ? {installScope: destination.installScope} : {}),
    provenance: {manifest, assetId: asset.id, manifestSha256: createHash('sha256').update(manifestText).digest('hex')}};
  if (previous && previous.appPath === receipt.appPath && previous.installScope !== receipt.installScope) {
    throw new Error('Changing the recorded scope in place requires the existing installation policy flow. Rerun without destination options.');
  }
  return receipt;
}

export function temporaryInstallLocation(path) {
  const canonical = value => existsSync(value) ? realpathSync(value) : resolve(value);
  const location = canonical(path);
  if (location.includes('/AppTranslocation/')) return true;
  // Disk images may be mounted anywhere, while /Volumes also holds persistent
  // external disks. Check the image inventory for every location and resolve
  // aliases on both sides before comparing directory membership.
  const plist = execFileSync('/usr/bin/hdiutil', ['info', '-plist'], {timeout: 10_000, maxBuffer: 1024 * 1024});
  const json = execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], {input: plist, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024});
  const info = JSON.parse(json);
  if (!Array.isArray(info.images)) throw new Error('Cannot determine whether this destination is a mounted image');
  return info.images.some(image => Array.isArray(image['system-entities']) && image['system-entities'].some(entity => {
    const mount = entity['mount-point'];
    if (typeof mount !== 'string') return false;
    const root = canonical(mount);
    return location === root || location.startsWith(root === '/' ? root : `${root}/`);
  }));
}

export function assertPersistentDestination(appPath, temporary = temporaryInstallLocation) {
  const parent = existsSync(dirname(appPath)) ? realpathSync(dirname(appPath)) : resolve(dirname(appPath));
  if (temporary(parent)) {
    throw new Error('A mounted image or translocated temporary app cannot be enrolled. Install into Applications or a persistent custom directory.');
  }
}
