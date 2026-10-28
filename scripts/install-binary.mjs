// Runs only in the complete private, publisher-verified app created by install.sh.
// No source clone, host interpreter, package manager or compiler participates.
import { LEGACY_APP_BUNDLE_NAME } from "../src/shared/app-naming.mjs";
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { stateDir, PORT } from '../src/shared/harness-runtime.mjs';
import { binaryPublisherPolicy } from '../src/shared/binary-publisher-policy.mjs';
import { writeReceipt } from '../src/shared/install-receipt.mjs';
import { resolveInstallDestination, inspectInstallDirectory, installDirectoryProblem } from './install-destination.mjs';
import { inspectBundle, prepareStagedInstall, installStagedApp, verifyBinaryBuild } from './install-staged-app.mjs';
import { prepareInPlaceInstall, runMigration, recoverMigration, readMigrationJournal,
  claimInstallReceiptWriter } from './install-migration.mjs';
import { boundedMigrationWait, migrationRuntimePorts } from './migration-runtime.mjs';
import { assertSafeAppLaunch, waitForBundleExit, realMacAppOps, prepareAppLaunch, verifyAppLaunch, parseAppProcesses } from './mac-app-lifecycle.mjs';

import { parseBinaryInstallArgs, readBinaryReceipt, binaryInstallReceipt, assertPersistentDestination } from './binary-install-policy.mjs';
export { parseBinaryInstallArgs, readBinaryReceipt, binaryInstallReceipt, assertPersistentDestination } from './binary-install-policy.mjs';

// Probe/hold the SAME native state lock as the daemon. The helper never opens SQLite.
// No PID metadata is sufficient to authorize killing an unrelated state owner.
function acquireInstallerState(directory, bundle) {
  const binding = createRequire(import.meta.url)(join(bundle, 'Contents/Resources/app/dist/native/state-lock.node'));
  const path = join(directory, 'daemon.lock');
  const previous = existsSync(path) ? readFileSync(path, 'utf8') : '';
  try {
    const handle = binding.acquire(path, previous || `${JSON.stringify({pid: process.pid, role: 'binary-installer'})}\n`);
    return () => binding.release(handle);
  } catch (error) {
    if (error.code === 'ELOCKED') throw new Error('A daemon still owns this state home. Quit that Mission Control installation or stop its standalone daemon, then retry. No process was signalled.');
    throw error;
  }
}

export async function waitForInstalledDaemon(receipt, stateDirectory, mac, {probe = fetch, timeout = 60_000} = {}) {
  await boundedMigrationWait(async () => {
    try {
      const owner = JSON.parse(readFileSync(join(stateDirectory, 'daemon.lock'), 'utf8'));
      const response = await probe(`http://127.0.0.1:${PORT}/api/health`, {signal: AbortSignal.timeout(1000)});
      if (!response.ok) return false;
      const health = await response.json();
      if (health.service !== 'mission-control' || health.ok !== true || health.version !== receipt.installedVersion || health.pid !== owner.pid || owner.port !== PORT) return false;
      const processes = await mac.run('/bin/ps', ['-axww', '-o', 'pid=,ppid=,stat=,comm=']);
      return processes.code === 0 && parseAppProcesses(processes.stdout).some(row => row.pid === owner.pid &&
        !/[TZUX]/.test(row.state) && row.executable.startsWith(`${receipt.appPath}/Contents/`));
    } catch { return false; }
  }, 'The app was installed, but its daemon did not become ready in this state home. Keep the installed app and receipt; inspect daemon.log and reopen it for forward recovery.', {timeout});
}

export async function installBinary(options, ports = {}) {
  const home = ports.home ?? homedir();
  const directory = ports.stateDirectory ?? stateDir();
  const publisher = binaryPublisherPolicy();
  const bundle = realpathSync(options.bundle);
  if (bundle.startsWith('/Volumes/') || bundle.includes('/AppTranslocation/')) throw new Error('The installer must run from its private complete runtime copy');
  const previous = readBinaryReceipt(directory);
  const destination = resolveInstallDestination({...options, receipt: previous, home});
  const receipt = binaryInstallReceipt(readFileSync(options.manifest, 'utf8'), destination, previous);
  assertPersistentDestination(receipt.appPath);
  const problem = installDirectoryProblem(inspectInstallDirectory(destination.appsDir, home));
  if (problem) throw new Error(problem);
  const prepare = ports.prepare ?? prepareStagedInstall;
  const descriptor = prepare({bundle, receipt, publisher});
  const occupied = !!lstatSync(receipt.appPath, {throwIfNoEntry: false});
  if (!previous && lstatSync(join(destination.appsDir, LEGACY_APP_BUNDLE_NAME), {throwIfNoEntry: false})) throw new Error("An unmanaged Mission Control.app already exists in this folder. Preserve that app and its state; use its managed receipt or move the copy aside explicitly before installing.");
  if (!previous && occupied && !options.enroll) throw new Error('An unmanaged app already occupies the destination. To enroll this exact signed build, rerun with --enroll; a different build must be moved aside explicitly.');
  if (options.enroll) {
    if (!occupied) throw new Error('There is no copied app at this destination to enroll');
    if (previous && previous.appPath !== receipt.appPath) throw new Error('A different managed installation owns this state home');
    (ports.verifyBuild ?? verifyBinaryBuild)(receipt.appPath, receipt, publisher);
    if (inspectBundle(receipt.appPath).digest !== descriptor.digest) throw new Error('Enrollment requires the exact published app bytes. Use the installer to repair an existing managed app.');
  }
  if (options.dryRun) return {appPath: receipt.appPath, dryRun: true};
  mkdirSync(directory, {recursive: true, mode: 0o700});
  const stateDirectory = realpathSync(directory);
  if (stateDirectory === bundle || stateDirectory.startsWith(`${bundle}/`) || stateDirectory === receipt.appPath || stateDirectory.startsWith(`${receipt.appPath}/`)) throw new Error('State must remain outside both app bundles');
  const mac = ports.mac ?? realMacAppOps(stateDirectory);
  const runtime = ports.runtime ?? migrationRuntimePorts({port: PORT, mac});
  let releaseState = () => {};
  const releaseProbe = () => { releaseState(); releaseState = () => {}; };
  const launchSource = async source => { releaseProbe(); await runtime.launchSource(source); };
  let sourceExited = false;
  const stopBoundary = async () => {
    console.log('Quit the installation being replaced to continue. Standalone or unrelated daemons must be stopped separately.');
    await assertSafeAppLaunch(previous?.appPath ?? receipt.appPath, mac);
    await waitForBundleExit(previous?.appPath ?? receipt.appPath, mac);
    await assertSafeAppLaunch(previous?.appPath ?? receipt.appPath, mac);
    sourceExited = true;
  };
  const transactionPorts = {...runtime, waitForParent: stopBoundary,
    // The transaction retains its receipt/journal ownership. Only the daemon
    // probe must yield before either the replacement or restored app can start.
    launchTarget: async plan => { releaseProbe(); return runtime.launchTarget(plan); },
    launchSource: async source => { if (sourceExited) await launchSource(source); }, waitForDaemonExit: async () => {
    await runtime.waitForDaemonExit();
    releaseState = (ports.acquireState ?? acquireInstallerState)(stateDirectory, bundle);
  }};
  try {
    const pending = readMigrationJournal(stateDirectory);
    if (pending && !['restored', 'complete'].includes(pending.stage)) {
      // Reuse the original journal and recovery owner; never create a competing writer.
      await recoverMigration(stateDirectory, {...transactionPorts, waitForParent: async () => {}, launchSource});
      throw new Error('The previous installation was recovered. Reopen the managed app or rerun this installer after inspecting its outcome.');
    }
    if (previous && !options.enroll) {
      if (previous.appPath !== receipt.appPath && previous.appPath !== join(destination.appsDir, LEGACY_APP_BUNDLE_NAME)) {
        // Integration inventory/repair requires Electron's existing migration owner.
        // The canonical in-place recovery route is always available without relocation.
        throw new Error('Use the managed app relocation flow to move this installation and repair its integrations. Rerun without destination flags for a Node-free in-place replacement.');
      }
      const plan = (ports.prepareInPlace ?? prepareInPlaceInstall)({descriptor, stateDirectory});
      const result = await (ports.runMigration ?? runMigration)(plan, transactionPorts);
      if (!result.committed || result.error) throw new Error(result.error ?? 'Installation did not commit; inspect the retained recovery journal');
      return {appPath: receipt.appPath, dryRun: false};
    }
    const release = claimInstallReceiptWriter(stateDirectory);
    try {
      const current = readBinaryReceipt(stateDirectory);
      if (JSON.stringify(current) !== JSON.stringify(previous)) throw new Error('The install receipt changed while acquiring ownership');
      if (options.enroll) {
        (ports.verifyBuild ?? verifyBinaryBuild)(receipt.appPath, receipt, publisher);
        if (inspectBundle(receipt.appPath).digest !== descriptor.digest) throw new Error('The copied app changed before enrollment');
        writeReceipt(receipt, join(stateDirectory, 'install-receipt.json'));
      } else {
        releaseState = (ports.acquireState ?? acquireInstallerState)(stateDirectory, bundle);
        await runtime.waitForDaemonExit();
        if (lstatSync(receipt.appPath, {throwIfNoEntry: false})) throw new Error('The first-install destination became occupied');
        (ports.install ?? installStagedApp)(descriptor, {stateDirectory, home});
      }
    } finally { release(); }
    // A first install has no prior executable to restore. Receipt publication uses
    // the direct staged-install owner; launch failures retain the managed app for
    // forward recovery instead of guessing at the compatibility of existing state.
    releaseProbe();
    if (!options.enroll) {
      if (ports.launch) { await ports.launch(receipt.appPath, stateDirectory); return {appPath: receipt.appPath, dryRun: false}; }
      const nonce = randomBytes(16).toString('hex');
      await prepareAppLaunch(receipt.appPath, mac);
      await assertSafeAppLaunch(receipt.appPath, mac);
      const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
      const launched = spawnSync('/usr/bin/open', [receipt.appPath, '--env', `MISSION_HOME=${stateDirectory}`, '--args', '--mission-update-launch', nonce, '--mission-binary-first-launch'], {env, timeout: 5000});
      if (launched.error || launched.status !== 0) throw new Error('The managed app was installed but could not be opened. Open it from Finder to continue.');
      await verifyAppLaunch(receipt.appPath, nonce, mac);
      await waitForInstalledDaemon(receipt, stateDirectory, mac);
    }
    return {appPath: receipt.appPath, dryRun: false};
  } finally { releaseProbe(); }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  try {
    if (process.platform !== 'darwin' || process.arch !== 'arm64' || !process.versions.electron || process.env.ELECTRON_RUN_AS_NODE !== '1') throw new Error('Use scripts/install.sh to verify and launch the bundled installer');
    const result = await installBinary(parseBinaryInstallArgs(process.argv.slice(2)));
    console.log(`${result.dryRun ? 'Verified dry run' : 'Managed installation ready'}: ${result.appPath}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
