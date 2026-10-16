import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import test, { after, before, mock, type TestContext } from 'node:test';
import { FuseV1Options } from '@electron/fuses';
import { packageDistribution } from '../scripts/package-distribution.mjs';
import { qualifiedDistribution } from '../scripts/publish-distribution.mjs';
import { distributionNames, localDistributionAssets } from '../scripts/distribution-contract.mjs';
import { binaryPublisherPolicy } from '../src/shared/binary-publisher-policy.mjs';
import { UPDATE_HELPER_FILES } from '../scripts/update-helper-files.mjs';

// Keep the real producer, app/DMG/archive verifiers, fuse reader, bundle hashing,
// signed-runtime qualifier and publication-input validator. Only external build,
// Apple tools and process responses are fixtures. No signed-artifact claim is made.
const require = createRequire(import.meta.url);
const builder = require('electron-builder');
const notarizer = require('@electron/notarize');
const buildDescriptor = Object.getOwnPropertyDescriptor(builder, 'build')!;
const notarizeDescriptor = Object.getOwnPropertyDescriptor(notarizer, 'notarize')!;
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const arch = Object.getOwnPropertyDescriptor(process, 'arch')!;
const policy = binaryPublisherPolicy();
const commit = 'a'.repeat(40);
const parentPid = 2_000_000_001, helperPid = 2_000_000_002;
let active: ReturnType<typeof fixture>;

before(() => {
  // Production success logs describe real signed runs; keep fixture runs quiet.
  mock.method(console, 'log', () => {});
  Object.defineProperty(process, 'platform', {value: 'darwin'});
  Object.defineProperty(process, 'arch', {value: 'arm64'});
  // Dynamic CJS imports retain these dispatchers; each test supplies fresh state.
  Object.defineProperty(builder, 'build', {configurable: true, value: (options: any) => active.build(options)});
  Object.defineProperty(notarizer, 'notarize', {configurable: true, value: (options: any) => active.notarize(options)});
  mock.method(childProcess, 'execFileSync', ((command: string, args: string[]) => active.exec(command, args)) as typeof childProcess.execFileSync);
  mock.method(childProcess, 'spawnSync', ((command: string, args: string[]) => active.run(command, args)) as typeof childProcess.spawnSync);
  mock.method(childProcess, 'spawn', ((command: string, args: string[], options: any) => active.spawn(command, args, options)) as unknown as typeof childProcess.spawn);
  mock.method(process, 'kill', ((pid: number, signal: unknown) => {
    assert.ok(pid === parentPid || pid === helperPid, 'only fixture process identities may be queried');
    assert.equal(signal, 0, 'no real process may be signalled');
    throw Object.assign(new Error('fixture process exited'), {code: 'ESRCH'});
  }) as typeof process.kill);
  syncBuiltinESMExports();
});
after(() => {
  mock.restoreAll(); syncBuiltinESMExports();
  Object.defineProperty(builder, 'build', buildDescriptor);
  Object.defineProperty(notarizer, 'notarize', notarizeDescriptor);
  Object.defineProperty(process, 'platform', platform);
  Object.defineProperty(process, 'arch', arch);
});

function put(path: string, body: string | Buffer) {
  mkdirSync(dirname(path), {recursive: true}); writeFileSync(path, body);
}

function fixture(t: TestContext, failure = '', channel = 'alpha') {
  const root = mkdtempSync(join(tmpdir(), 'mission-package-behavior-'));
  const output = join(root, 'release/distribution');
  const app = join(output, 'mac-arm64/Mission Control.app');
  const roots: string[] = [], mounts: string[] = [], stages: string[] = [], mcpMethods: string[] = [];
  const snapshots = new Map<string, string>();
  let metadata: any, dmgNotarized = false, recovery = false;
  const env = {CSC_NAME: `Developer ID Application: Fixture (${policy.teamId})`, CSC_LINK: 'fixture', CSC_KEY_PASSWORD: 'fixture',
    APPLE_API_KEY: join(root, 'key.p8'), APPLE_API_KEY_ID: 'fixture', APPLE_API_ISSUER: 'fixture',
    GITHUB_SHA: commit, MISSION_DISTRIBUTION_CHANNEL: channel, MISSION_DISTRIBUTION_TAG: channel === 'stable' ? 'v1.26.0' : ''};
  put(env.APPLE_API_KEY, 'non-secret fixture');
  put(join(root, 'package.json'), JSON.stringify({version: '1.26.0'}));
  put(join(root, 'package-lock.json'), JSON.stringify({version: '1.26.0', packages: {'': {version: '1.26.0'}}}));
  t.after(() => {for (const path of [...roots, root]) rmSync(path, {recursive: true, force: true});});
  const assertUnqualified = () => {
    assert.equal(existsSync(join(output, 'qualification.json')), false, 'publication input must not exist before all checks finish');
    assert.equal(existsSync(join(output, 'build-metadata.json')), false);
  };
  const assertQualificationBoundary = () => {if (!recovery) assertUnqualified();};
  function snapshot(archive: string, kind: string) {
    const copy = join(root, `${kind}-contents/Mission Control.app`);
    cpSync(app, copy, {recursive: true}); snapshots.set(archive, copy);
    put(archive, `${kind} archive fixture`);
  }
  function child() {
    const proc = Object.assign(new EventEmitter(), {stdout: new PassThrough(), stderr: new PassThrough(),
      stdin: new PassThrough() as Writable, exitCode: null as number | null, signalCode: null as string | null,
      pid: parentPid, kill(_signal: string): boolean {proc.signalCode = 'SIGKILL'; queueMicrotask(() => proc.emit('close', null)); return true;}});
    return proc;
  }
  const f = {root, output, app, roots, mounts, stages, mcpMethods, env, assertUnqualified,
    beginRecovery(reason = '') {recovery = true; failure = reason;},
    async build(options: any) {
      assertQualificationBoundary();
      if (!options.prepackaged) {
        stages.push('sign-app');
        if (failure === 'signing') throw new Error('fixture signing failed');
        metadata = options.config.extraMetadata.missionBinary;
        assert.equal(options.config.forceCodeSigning, true);
        assert.equal(options.config.mac.notarize, true);
        for (const path of UPDATE_HELPER_FILES) put(join(app, 'Contents/Resources/app', path), 'fixture helper');
        put(join(app, 'Contents/Resources/app/package.json'), JSON.stringify({version: metadata.version, ...options.config.extraMetadata}));
        put(join(app, 'Contents/MacOS/Mission Control'), 'fixture executable');
        put(join(app, 'Contents/Info.plist'), 'fixture plist');
        // Actual @electron/fuses parsing, including each required fuse policy.
        const fuseWire = Buffer.from([49, 48, 48, 48, 48, 48, 48, 48]);
        if (failure === 'fuse') fuseWire[FuseV1Options.RunAsNode] = 48;
        if (failure === 'node-options-fuse') fuseWire[FuseV1Options.EnableNodeOptionsEnvironmentVariable] = 49;
        if (failure === 'inspector-fuse') fuseWire[FuseV1Options.EnableNodeCliInspectArguments] = 49;
        put(join(app, 'Contents/Frameworks/Electron Framework.framework/Electron Framework'),
          Buffer.concat([Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'), Buffer.from([1, fuseWire.length]), fuseWire]));
      } else {
        stages.push('build-dmg'); assert.equal(options.prepackaged, app);
        snapshot(join(output, distributionNames(metadata).dmg), 'dmg');
      }
      return [];
    },
    async notarize(options: any) {
      assertQualificationBoundary(); stages.push('notarize-dmg');
      assert.equal(options.appPath, join(output, distributionNames(metadata).dmg));
      assert.ok(existsSync(options.appPath), 'notarize the generated DMG, not a future path');
      if (failure === 'notarization') throw new Error('fixture notarization failed');
      dmgNotarized = true;
    },
    exec(command: string, args: string[]) {
      assertQualificationBoundary();
      if (command === 'git') return args[0] === 'status' ? '' : commit;
      if (command === 'npm') {stages.push('build'); return '';}
      if (command === '/usr/bin/codesign') {
        stages.push('verify-app-signature');
        assert.match(args.join(' '), new RegExp(policy.teamId));
        if (failure === 'app-signature') throw new Error('fixture app signature invalid');
        return '';
      }
      if (command === '/bin/cp') {cpSync(args[1]!, args[2]!, {recursive: true}); return '';}
      if (command === '/usr/bin/xattr') {stages.push('quarantine-copy'); return '';}
      if (command === '/usr/bin/ditto') {snapshot(args.at(-1)!, 'zip'); stages.push('archive-zip'); return '';}
      if (basename(command) === 'Mission Control') return JSON.stringify({electron: '43.0.0', node: '24.0.0'});
      throw new Error(`Unexpected external command: ${command}`);
    },
    run(command: string, args: string[]) {
      assertQualificationBoundary();
      let stdout = '', stderr = '', status = 0;
      if (command === '/usr/sbin/spctl') {
        stderr = failure === 'gatekeeper' ? 'source=Unnotarized Developer ID' : 'source=Notarized Developer ID';
      } else if (command === '/usr/bin/xcrun') {
        const dmg = args.at(-1)!.endsWith('.dmg');
        stages.push(dmg ? 'validate-dmg-staple' : 'validate-app-staple');
        if ((dmg && (!dmgNotarized || failure === 'dmg-staple')) || (!dmg && failure === 'app-staple')) status = 1;
      } else if (command === '/usr/libexec/PlistBuddy') {
        const key = args[1]!.slice('Print :'.length);
        stdout = ({CFBundleIdentifier: policy.bundleId, CFBundleShortVersionString: metadata.version, LSMinimumSystemVersion: metadata.minimumSystemVersion} as Record<string, string>)[key]!;
      } else if (command === '/usr/bin/lipo') stdout = 'arm64';
      else if (command === '/usr/bin/codesign') {
        if (args[0] === '-d') stderr = 'flags=0x10000(runtime)';
        else {stages.push('verify-dmg-signature'); if (failure === 'dmg-signature') status = 1;}
      } else if (command === '/usr/bin/hdiutil') {
        if (args[0] === 'attach') {
          const mount = args.at(-1)!; mounts.push(mount); stages.push('mount-dmg');
          cpSync(snapshots.get(args[1]!)!, join(mount, 'Mission Control.app'), {recursive: true});
          if (failure === 'dmg-bytes') put(join(mount, 'Mission Control.app/changed'), 'tampered');
        } else {stages.push('detach-dmg'); mounts.splice(mounts.indexOf(args[1]!), 1);}
      } else if (command === '/usr/bin/ditto') {
        const destination = join(args.at(-1)!, 'Mission Control.app'); stages.push('extract-zip');
        cpSync(snapshots.get(args[2]!)!, destination, {recursive: true});
        if (failure === 'zip-bytes') put(join(destination, 'changed'), 'tampered');
      } else throw new Error(`Unexpected verification command: ${command}`);
      return {status, stdout, stderr};
    },
    spawn(command: string, args: string[], options: any) {
      assertQualificationBoundary();
      assert.equal(basename(command), 'Mission Control');
      assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1');
      assert.equal(Object.keys(options.env).some((key) => /^(CSC_|APPLE_|GH_|GITHUB_)/.test(key)), false);
      const proc = child();
      if (args[1] === '--parent') {
        stages.push('copied-parent');
        const probe = args[2]!; roots.push(probe);
        queueMicrotask(() => {
          if (failure === 'parent') {proc.exitCode = 1; proc.emit('exit', 1); return;}
          const directory = join(probe, 'state/update-runtimes/attempt'); mkdirSync(directory, {recursive: true});
          const original = join(probe, 'Mission Control.app');
          cpSync(original, join(directory, 'Runtime.app'), {recursive: true});
          put(join(directory, 'owner.json'), JSON.stringify({helper: {pid: helperPid, identity: 'fixture helper'}}));
          put(join(probe, 'handoff.json'), JSON.stringify({directory, parentPid}));
          put(join(probe, 'state/update-outcome.json'), JSON.stringify({result: 'failure', message: 'installed app is missing before the update'}));
          renameSync(original, join(probe, 'Retired.app'));
          proc.exitCode = 0; proc.emit('exit', 0);
        });
      } else {
        stages.push('mcp');
        assert.match(args[0]!, /Runtime\.app\/Contents\/Resources\/app\/dist\/mcp\/server\.mjs$/);
        proc.stdin = new Writable({write(chunk, _encoding, done) {
          const message = JSON.parse(chunk.toString()); mcpMethods.push(message.method);
          if (message.id) queueMicrotask(() => proc.stdout.write(JSON.stringify(failure === 'mcp' ? {id: message.id, error: {code: -1}} :
            {id: message.id, result: message.id === 1 ? {serverInfo: {name: 'fixture'}} : {tools: [{name: 'request_input'}]}}) + '\n'));
          if (failure === 'host-runtime') put(options.env.MISSION_RUNTIME_TRAPS, 'node');
          done();
        }});
      }
      return proc;
    },
  };
  active = f; return f;
}

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
  ['notarization', /fixture notarization failed/],
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
