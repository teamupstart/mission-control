// The prepared-bundle boundary shared by the source installer and detached transaction.
// This module never resolves an interpreter or executes code from a source clone.
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, statfsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { APP_BUNDLE_NAME, bundleShortVersion, replaceAppBundle, RESTORE_AUTHORIZATION_PROMPT } from './app-bundle-swap.mjs';
import { inspectInstallDirectory, installDirectoryProblem, mayCreateAppsDir } from './install-destination.mjs';
import { stagedBundleRevision, stagedRevisionProblem } from '../src/shared/staged-bundle.mjs';
import { validateReceipt } from '../src/shared/install-receipt-schema.mjs';
import { writeReceipt } from '../src/shared/install-receipt.mjs';
import { INSTALL_HELPER_PROTOCOL, validateBinaryBuildMetadata } from '../src/shared/binary-distribution.mjs';

export function bundleCommit(bundle) {
  try {
    const value = JSON.parse(readFileSync(join(bundle, 'Contents/Resources/app/package.json'), 'utf8')).missionCommit;
    return typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) ? value : null;
  } catch { return null; }
}

/** Hash bytes, modes and link destinations, without following links or assuming CoW.
 * Framework symlinks may point inside the bundle, never outside it. */
export function inspectBundle(bundle) {
  // Electron virtualizes .asar files even when our app is packaged with asar:false.
  // Hash physical bytes consistently across host Node and every owned runtime.
  // This traversal is synchronous, so the temporary setting cannot span other work.
  const noAsar = process.noAsar;
  try {
    process.noAsar = true;
    return inspectPhysicalBundle(bundle);
  } finally {
    if (noAsar === undefined) delete process.noAsar;
    else process.noAsar = noAsar;
  }
}

function inspectPhysicalBundle(bundle) {
  const root = realpathSync(bundle);
  if (lstatSync(bundle).isSymbolicLink() || !statSync(root).isDirectory()) throw new Error('The staged app must be a real directory');
  const hash = createHash('sha256');
  let bytes = 0;
  let entries = 0;
  const buffer = Buffer.alloc(1024 * 1024);
  const visit = (path) => {
    if (++entries > 200_000) throw new Error("The staged app exceeds the file inventory limit");
    const stat = lstatSync(path);
    const name = relative(root, path);
    hash.update(JSON.stringify([name, stat.mode & 0o777, stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'link' : 'file']));
    if (stat.isSymbolicLink()) {
      const target = realpathSync(path);
      if (target !== root && !target.startsWith(`${root}/`)) throw new Error('The staged app contains an escaping symlink');
      hash.update(readlinkSync(path));
    } else if (stat.isDirectory()) {
      for (const entry of readdirSync(path).sort()) visit(join(path, entry));
    } else if (stat.isFile()) {
      hash.update(String(stat.size));
      const fd = openSync(path, 'r');
      try { let n; while ((n = readSync(fd, buffer, 0, buffer.length, null)) > 0) { hash.update(buffer.subarray(0, n)); bytes += n; if (bytes > 8 * 1024 ** 3) throw new Error("The staged app exceeds the unpacked size limit"); } }
      finally { closeSync(fd); }
    } else throw new Error('The staged app contains an unsupported file type');
  };
  visit(root);
  return {digest: hash.digest('hex'), bytes};
}

/** Publisher policy comes from the trusted caller, never from downloaded metadata. */
export function verifyBinaryPublisher(bundle, publisher) {
  if (process.platform !== 'darwin' || !publisher || !/^[A-Z0-9]{10}$/.test(publisher.teamId ?? '') || publisher.notarized !== true) {
    throw new Error('A trusted Developer ID and notarization policy are required');
  }
  const run = (command, args) => execFileSync(command, args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000});
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--all-architectures', '-R',
    `anchor apple generic and identifier "com.mission-control.app" and certificate leaf[subject.OU] = "${publisher.teamId}"`, bundle]);
  const assessment = spawnSync('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', bundle],
    {encoding: 'utf8', env: {...process.env, LC_ALL: 'C'}, timeout: 30_000});
  if (assessment.error || assessment.status !== 0 || !/^source=Notarized Developer ID$/m.test(assessment.stderr)) {
    throw new Error('The binary app did not satisfy the notarized Developer ID policy');
  }
}

export function verifyBinaryBuild(bundle, receipt, publisher, verifyPublisher = verifyBinaryPublisher) {
  const metadata = JSON.parse(readFileSync(join(bundle, 'Contents/Resources/app/package.json'), 'utf8')).missionBinary;
  const problem = validateBinaryBuildMetadata(metadata);
  if (problem) throw new Error(problem);
  const {assets: _assets, ...identity} = receipt.provenance.manifest;
  for (const key of Object.keys(identity)) {
    if (JSON.stringify(metadata[key]) !== JSON.stringify(identity[key])) throw new Error('Signed binary metadata disagrees with the accepted manifest');
  }
  verifyPublisher(bundle, publisher);
}

export function prepareStagedInstall({bundle, revision = null, receipt, publisher}, {verifyPublisher = verifyBinaryPublisher} = {}) {
  const problem = validateReceipt(receipt);
  if (problem) throw new Error(problem);
  if (resolve(bundle) !== bundle || receipt.appPath !== join(dirname(receipt.appPath), APP_BUNDLE_NAME) || resolve(receipt.appPath) !== receipt.appPath) throw new Error('Invalid staged installation paths');
  if (bundle === receipt.appPath || bundle.startsWith(`${receipt.appPath}/`) || receipt.appPath.startsWith(`${bundle}/`)) throw new Error('Candidate and destination must be separate');
  const realBundle = realpathSync(bundle);
  const realDestination = existsSync(receipt.appPath) ? realpathSync(receipt.appPath) : (existsSync(dirname(receipt.appPath)) ? join(realpathSync(dirname(receipt.appPath)), APP_BUNDLE_NAME) : resolve(receipt.appPath));
  if (realBundle === realDestination || realBundle.startsWith(`${realDestination}/`) || realDestination.startsWith(`${realBundle}/`)) throw new Error('Candidate and destination must resolve to separate paths');
  const found = stagedBundleRevision(lstatSync(bundle));
  const pin = stagedRevisionProblem({expected: revision, found});
  if (pin) throw new Error(pin);
  if (bundleShortVersion(bundle) !== receipt.installedVersion || (receipt.installedCommit && bundleCommit(bundle) !== receipt.installedCommit)) throw new Error('The staged build does not match the accepted receipt');
  if (receipt.kind === 'binary') verifyBinaryBuild(bundle, receipt, publisher, verifyPublisher);
  return {protocol: INSTALL_HELPER_PROTOCOL, bundle, revision: found, ...inspectBundle(bundle), receipt: structuredClone(receipt), ...(publisher ? {publisher: {...publisher}} : {})};
}

/** Existing source update handoffs keep their source identity and legacy receipts. */
export function prepareSourceUpdate({receipt, bundle, revision = null, targetTag}) {
  if (!receipt || receipt.kind === 'binary') throw new Error('A staged source update requires its existing managed receipt');
  const commit = bundleCommit(bundle);
  const version = bundleShortVersion(bundle);
  const alpha = /^[a-f0-9]{40}$/.test(targetTag);
  if (alpha ? commit !== targetTag : version !== targetTag.replace(/^v/, '')) throw new Error('The staged target no longer matches the accepted update');
  const {installedCommit: _previousCommit, ...previous} = receipt;
  return prepareStagedInstall({bundle, revision, receipt: {...previous, installedVersion: version,
    ...(commit ? {installedCommit: commit} : {}), releaseTag: alpha ? null : targetTag, installedAt: new Date().toISOString()}});
}

export function validateStagedInstall(descriptor, options) {
  if (descriptor?.protocol !== INSTALL_HELPER_PROTOCOL) throw new Error('Unsupported staged installation protocol');
  const found = prepareStagedInstall({bundle: descriptor.bundle, revision: descriptor.revision, receipt: descriptor.receipt, publisher: descriptor.publisher}, options);
  if (descriptor.digest !== found.digest || descriptor.bytes !== found.bytes) throw new Error('The accepted staged app bytes changed');
  return descriptor;
}

/** Space claims are summed per filesystem. Existing candidate bytes are already allocated;
 * reserve each additional copy plus safety room, using measured sizes rather than APFS clones. */
export function requireInstallSpace(claims, inspect = statfsSync) {
  const volumes = new Map();
  for (const {path, bytes} of claims) {
    let existing = path;
    while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
    const disk = inspect(existing);
    const key = statSync(existing).dev;
    const previous = volumes.get(key) ?? {available: Number(disk.bavail) * Number(disk.bsize), needed: 64 * 1024 ** 2};
    previous.needed += bytes;
    volumes.set(key, previous);
  }
  if ([...volumes.values()].some((v) => v.available < v.needed)) throw new Error('Insufficient free disk space for the installation and recovery copies');
}

/** Caller holds the receipt lock. Journal transactions defer receipt publication until readiness. */
export function stageInstallBundle(descriptor, {home = homedir(), verifyPublisher = verifyBinaryPublisher, checkpoint = () => {}} = {}) {
  validateStagedInstall(descriptor, {verifyPublisher});
  const appPath = descriptor.receipt.appPath;
  const appsDir = dirname(appPath);
  const problem = installDirectoryProblem(inspectInstallDirectory(appsDir, home));
  if (problem) throw new Error(problem);
  if (!existsSync(appsDir) && mayCreateAppsDir({appsDir, home})) mkdirSync(appsDir, {recursive: true, mode: 0o755});
  requireInstallSpace([{path: appsDir, bytes: descriptor.bytes}]);
  checkpoint('before-swap');
  const swap = replaceAppBundle({sourceBundle: descriptor.bundle, appPath, appsDir, pid: process.pid, keepPrevious: true,
    verifyStaged: (path) => {
      if (inspectBundle(path).digest !== descriptor.digest) throw new Error('The copied staged app bytes changed');
    }, sweep: () => []});
  if (swap.problem) throw new Error(swap.problem);
  try {
    checkpoint('bundle-swapped');
    if (inspectBundle(appPath).digest !== descriptor.digest) throw new Error('The installed app bytes changed');
  } catch (error) {
    // The caller has not received the retained path yet. Restore here while this
    // boundary still owns it, including when inspection itself cannot read the app.
    rollbackStagedInstall(descriptor, swap, error);
  }
  return swap;
}

function rollbackStagedInstall(descriptor, swap, error) {
  // replaceAppBundle maps the inner swap attempt's retainedAt to failedBundle.
  if (swap.failedBundle) {
    const restore = replaceAppBundle({sourceBundle: swap.failedBundle, appPath: descriptor.receipt.appPath,
      appsDir: dirname(descriptor.receipt.appPath), pid: process.pid, prompt: RESTORE_AUTHORIZATION_PROMPT, sweep: () => []});
    if (restore.problem) throw new Error(`${error.message}. Recovery failed: ${restore.problem}`);
  }
  throw error;
}

/** Direct source installation keeps schema 1 and uses the same publication owner.
 * Detached callers use the journal instead, because their GUI must acknowledge readiness. */
export function installStagedApp(descriptor, {stateDirectory, ...options}) {
  const swap = stageInstallBundle(descriptor, options);
  try { writeReceipt(descriptor.receipt, join(stateDirectory, 'install-receipt.json')); }
  catch (error) { rollbackStagedInstall(descriptor, swap, error); }
  // Receipt publication ends this direct install's rollback obligation. Cleanup
  // is best-effort and must never roll back an app whose new receipt is committed.
  if (swap.failedBundle) {
    try { rmSync(swap.failedBundle, {recursive: true, force: true}); }
    catch (error) {
      console.warn(`Installed successfully, but could not remove the retained app at ${swap.failedBundle}: ${error.message}`);
    }
  }
  return descriptor.receipt.appPath;
}

/** Legacy isolation API, retained for source installers using the rename handoff.
 * Check before and after moving, returning another builder's replacement when possible. */
export function isolateStagedBundle({ bundle, isolated, expectedRevision, bundleName, ops }) {
  const pinProblem = (path) =>
    stagedRevisionProblem({ expected: expectedRevision, found: ops.revision(path) });

  const before = pinProblem(bundle);
  if (before) return { sourceBundle: null, problem: before, keepIsolated: false, rescued: null, inPlace: null };
  // Nothing pinned this, so it was not staged by an app: a plain `make install` built it in this
  // same process moments ago and leaves it in `release/`, where a developer expects to find it.
  if (!expectedRevision) {
    return { sourceBundle: bundle, problem: null, keepIsolated: false, rescued: null, inPlace: null };
  }

  const moved = join(isolated, bundleName);
  try {
    ops.remove(isolated);
    ops.makeDirectory(isolated);
    ops.move(bundle, moved);
  } catch (error) {
    // A rename across filesystems is the realistic failure. Installing in place is what this
    // script has always done, and the pin was already checked; only the window stays open.
    try {
      ops.remove(isolated);
    } catch {
      // It may not exist, and it is inside the state directory either way.
    }
    return {
      sourceBundle: bundle,
      problem: null,
      keepIsolated: false,
      rescued: null,
      inPlace: error instanceof Error ? error.message : String(error),
    };
  }

  const after = pinProblem(moved);
  if (!after) {
    return { sourceBundle: moved, problem: null, keepIsolated: false, rescued: null, inPlace: null };
  }

  // What came across is not what was checked, so it is not ours to install - or to delete.
  try {
    ops.move(moved, bundle);
    return { sourceBundle: null, problem: after, keepIsolated: false, rescued: null, inPlace: null };
  } catch {
    return { sourceBundle: null, problem: after, keepIsolated: true, rescued: moved, inPlace: null };
  }
}
