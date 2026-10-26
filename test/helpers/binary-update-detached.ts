import { buildSync } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { binaryOffer } from './binary-update.ts';

/** Only Apple trust responses are simulated. These test-owned bundles cannot be
 * Developer ID signed; archive, platform, descriptor and transaction code stays real. */
function nativeTrustFixture(root: string, format: 'esm' | 'cjs'): string {
  const load = (module: string) => format === 'cjs' ? `require('${module}')` : `(await import('${module}')).default`;
  return `
    const fixtureCp = ${load('node:child_process')};
    const fixtureFs = ${load('node:fs')};
    const fixtureModule = ${load('node:module')};
    const fixtureAssert = ${load('node:assert/strict')};
    const fixtureRoot = ${JSON.stringify(root)};
    const fixtureExec = fixtureCp.execFileSync, fixtureSpawn = fixtureCp.spawnSync;
    function fixtureTrust(command, args) {
      const bundle = fixtureFs.realpathSync(args.at(-1));
      fixtureAssert.ok(bundle.startsWith(fixtureRoot + '/'));
      fixtureAssert.ok(fixtureFs.existsSync(bundle + '/Contents/Frameworks/Electron Framework.framework'));
      fixtureFs.appendFileSync(fixtureRoot + '/trust-checks.jsonl', JSON.stringify({command, bundle,
        pid: process.pid, executable: process.execPath, nodeFlag: process.env.ELECTRON_RUN_AS_NODE ?? null,
        path: process.env.PATH, traps: process.env.MISSION_RUNTIME_TRAPS}) + '\\n');
    }
    fixtureCp.execFileSync = (command, args, options) => {
      if (command !== '/usr/bin/codesign') return fixtureExec(command, args, options);
      fixtureAssert.deepEqual(args.slice(0, -1), ['--verify', '--deep', '--strict', '--all-architectures', '-R',
        'anchor apple generic and identifier "com.mission-control.app" and certificate leaf[subject.OU] = "S2FPCQK39Z"']);
      fixtureTrust(command, args);
      return '';
    };
    fixtureCp.spawnSync = (command, args, options) => {
      if (command !== '/usr/sbin/spctl') return fixtureSpawn(command, args, options);
      fixtureAssert.deepEqual(args.slice(0, -1), ['--assess', '--type', 'execute', '--verbose=4']);
      fixtureTrust(command, args);
      return {status: 0, stderr: 'source=Notarized Developer ID', stdout: ''};
    };
    fixtureModule.syncBuiltinESMExports();
  `;
}

/** Install the shim only in disposable fixture copies, including the detached
 * helper's copied entry point. There is no production bypass or test environment flag. */
export function prepareBinaryFixtureRuntime(root: string, resources: string): void {
  const shim = nativeTrustFixture(root, 'esm');
  writeFileSync(join(resources, 'fixture-native-trust.mjs'), shim);
  const helper = join(resources, 'scripts/apply-update.mjs');
  const source = readFileSync(helper, 'utf8');
  const firstLine = source.startsWith('#!') ? source.indexOf('\n') + 1 : 0;
  writeFileSync(helper, source.slice(0, firstLine) + shim + source.slice(firstLine));
  buildSync({entryPoints: ['src/main/update-binary.ts'], bundle: true, platform: 'node', format: 'esm',
    outfile: join(resources, 'binary-stage-fixture.mjs')});
  buildSync({entryPoints: ['src/main/update-binary-worker.ts'], bundle: true, platform: 'node', format: 'cjs',
    banner: {js: nativeTrustFixture(root, 'cjs')}, outfile: join(resources, 'dist/main/update-binary-worker.cjs')});
}

export function createBinaryFixtureArchive(root: string, candidate: string): ReturnType<typeof binaryOffer> {
  const offer = binaryOffer('b'.repeat(40), 'stable', '1.26.1');
  const {assets: _assets, ...identity} = offer.manifest;
  const packagePath = join(candidate, 'Contents/Resources/app/package.json');
  writeFileSync(packagePath, JSON.stringify({...JSON.parse(readFileSync(packagePath, 'utf8')), version: identity.version,
    missionBinary: {...identity, receiptSchema: 2}}));
  const plist = join(candidate, 'Contents/Info.plist');
  for (const [key, value] of Object.entries({CFBundleShortVersionString: identity.version, LSMinimumSystemVersion: identity.minimumSystemVersion})) {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
  }
  const archive = join(root, 'fixture.zip');
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', candidate, archive]);
  const bytes = readFileSync(archive);
  Object.assign(offer.manifest.assets[0]!, {bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')});
  offer.manifestText = JSON.stringify(offer.manifest);
  offer.manifestSha256 = createHash('sha256').update(offer.manifestText).digest('hex');
  // A local canonical-asset transport fixture, not a staged bundle or descriptor mock.
  writeFileSync(join(root, 'gh-fixture'), `#!/bin/sh
if [ "$*" != 'api --hostname github.com repos/teamupstart/mission-control/releases/assets/123 -H Accept: application/octet-stream' ]; then exit 98; fi
printf '%s\\n' "$*" >> '${root}/download-requests'
exec /bin/cat '${archive}'
`, {mode: 0o755});
  return offer;
}

/** Runs inside the old app's Electron process. Keep the descriptor returned by
 * the worker intact all the way into the production detached-helper handoff. */
export function binaryPreparationScript(root: string, offer: ReturnType<typeof binaryOffer>): string {
  return `
    await import('./fixture-native-trust.mjs');
    const {stageBinaryUpdate} = await import('./binary-stage-fixture.mjs');
    const {readMigrationJournal} = await import('./scripts/install-migration.mjs');
    const originalReceipt = readFileSync(state + '/install-receipt.json');
    const originalBundle = inspectBundle(receipt.appPath);
    assert.ok(process.env.PATH.startsWith(${JSON.stringify(join(root, 'traps') + ':')}));
    assert.equal(process.env.MISSION_RUNTIME_TRAPS, ${JSON.stringify(join(root, 'trap-hits'))});
    const progress = [];
    const prepared = await stageBinaryUpdate({offer: ${JSON.stringify(offer)}, receipt, targetTag: 'v1.26.1',
      signal: new AbortController().signal, onStage(stage, transfer) {progress.push({stage, transfer});}}, {
      worker: fileURLToPath(new URL('./dist/main/update-binary-worker.cjs', import.meta.url)),
      stateDirectory: state, gh: ${JSON.stringify(join(root, 'gh-fixture'))}, env: process.env,
      log(line) {writeFileSync(state + '/binary-preparation.log', line + '\\n', {flag: 'a'});}
    });
    assert.equal(prepared.ok, true, JSON.stringify(prepared) + '\\n' + (existsSync(state + '/binary-preparation.log') ? readFileSync(state + '/binary-preparation.log', 'utf8') : ''));
    assert.deepEqual(readFileSync(state + '/install-receipt.json'), originalReceipt);
    assert.deepEqual(inspectBundle(receipt.appPath), originalBundle);
    assert.notEqual(prepared.descriptor.bundle, candidate, 'handoff must use the extracted download');
    assert.ok(prepared.descriptor.bundle.startsWith(state + '/update-downloads/'));
    assert.equal(prepared.descriptor.receipt.schema, 2);
    assert.equal(prepared.descriptor.receipt.provenance.assetId, '123');
    assert.ok(progress.some(event => event.stage === 'download' && event.transfer.received === ${offer.manifest.assets[0]!.bytes} && event.transfer.total === ${offer.manifest.assets[0]!.bytes}));
    assert.ok(progress.some(event => event.stage === 'extract'));
    assert.ok(progress.some(event => event.stage === 'signature'));
    Object.assign(handoff, {descriptor: prepared.descriptor, receipt, stagedBundle: prepared.staged.bundlePath,
      stagedRevision: prepared.staged.revision, targetTag: 'v1.26.1'});
    writeFileSync(state + '/binary-prepared.json', JSON.stringify({descriptor: prepared.descriptor, progress, parent: process.execPath}));
  `;
}
