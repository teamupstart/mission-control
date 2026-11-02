import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { mock, type TestContext } from 'node:test';
import { FuseV1Options } from '@electron/fuses';
import { distributionNames } from '../../scripts/distribution-contract.mjs';
import { binaryPublisherPolicy } from '../../src/shared/binary-publisher-policy.mjs';
import { UPDATE_HELPER_FILES } from '../../scripts/update-helper-files.mjs';

// Keep the real producer, app/DMG/archive verifiers, fuse reader, bundle hashing,
// signed-runtime qualifier and publication-input validator. Only external build,
// Apple tools and process responses are fixtures. No signed-artifact claim is made.
const require = createRequire(import.meta.url);
const builder = require('electron-builder');
const buildDescriptor = Object.getOwnPropertyDescriptor(builder, 'build')!;
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const arch = Object.getOwnPropertyDescriptor(process, 'arch')!;
const policy = binaryPublisherPolicy();
const commit = 'a'.repeat(40);
const parentPid = 2_000_000_001, helperPid = 2_000_000_002;
const realWriteFileSync = fs.writeFileSync;
let active: ReturnType<typeof fixture>;

export function installDistributionFixture() {
  // Production success logs describe real signed runs; keep fixture runs quiet.

  Object.defineProperty(process, 'platform', {value: 'darwin'});
  Object.defineProperty(process, 'arch', {value: 'arm64'});
  // Dynamic CJS imports retain these dispatchers; each test supplies fresh state.
  Object.defineProperty(builder, 'build', {configurable: true, value: (options: any) => active.build(options)});
  mock.method(childProcess, 'execFile', ((command: string, args: string[], _options: unknown, callback: Function) => active.notarize(command, args, callback)) as unknown as typeof childProcess.execFile);
  mock.method(childProcess, 'execFileSync', ((command: string, args: string[], options: any) => active.exec(command, args, options)) as typeof childProcess.execFileSync);
  mock.method(childProcess, 'spawnSync', ((command: string, args: string[]) => active.run(command, args)) as typeof childProcess.spawnSync);
  mock.method(childProcess, 'spawn', ((command: string, args: string[], options: any) => active.spawn(command, args, options)) as unknown as typeof childProcess.spawn);
  mock.method(fs, 'writeFileSync', ((path: string, ...args: any[]) => {
    active?.beforeWrite(path);
    return (realWriteFileSync as Function)(path, ...args);
  }) as typeof fs.writeFileSync);
  mock.method(process, 'kill', ((pid: number, signal: unknown) => {
    assert.ok(pid === parentPid || pid === helperPid, 'only fixture process identities may be queried');
    assert.equal(signal, 0, 'no real process may be signalled');
    throw Object.assign(new Error('fixture process exited'), {code: 'ESRCH'});
  }) as typeof process.kill);
  syncBuiltinESMExports();
}
export function restoreDistributionFixture() {
  mock.restoreAll(); syncBuiltinESMExports();
  Object.defineProperty(builder, 'build', buildDescriptor);
  Object.defineProperty(process, 'platform', platform);
  Object.defineProperty(process, 'arch', arch);
}

function put(path: string, body: string | Buffer) {
  mkdirSync(dirname(path), {recursive: true}); writeFileSync(path, body);
}

export function fixture(t: Pick<TestContext, 'after'>, failure = '', channel = 'alpha') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mission-package-behavior-')));
  const output = join(root, 'release/distribution');
  const app = join(output, 'mac-arm64/Agent Mission Control.app');
  const roots: string[] = [], mounts: string[] = [], stages: string[] = [], mcpMethods: string[] = [];
  const snapshots = new Map<string, string>();
  const validationAttempts = new Map<string, number>();
  let metadata: any, dmgNotarized = false, recovery = false;
  const env = {CSC_NAME: `Developer ID Application: Fixture (${policy.teamId})`, CSC_LINK: 'fixture-certificate-secret', CSC_KEY_PASSWORD: 'fixture-password-secret',
    APPLE_API_KEY: join(root, 'key.p8'), APPLE_API_KEY_ID: 'fixture-key-id', APPLE_API_ISSUER: 'fixture-issuer',
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
  const injectedError = () => Object.assign(new Error(`fixture failure CSC_LINK=${env.CSC_LINK}\n--key "${env.APPLE_API_KEY}"\ncode signing rejected`),
    {code: 'E_FIXTURE', status: 17, stderr: `fixture detail ${env.CSC_KEY_PASSWORD}`});
  function snapshot(archive: string, kind: string) {
    const copy = join(root, `${kind}-contents/Agent Mission Control.app`);
    cpSync(app, copy, {recursive: true}); snapshots.set(archive, copy);
    put(archive, `${kind} archive fixture`);
  }
  function child() {
    const proc = Object.assign(new EventEmitter(), {stdout: new PassThrough(), stderr: new PassThrough(),
      stdin: new PassThrough() as Writable, exitCode: null as number | null, signalCode: null as string | null,
      pid: parentPid, kill(_signal: string): boolean {proc.signalCode = 'SIGKILL'; queueMicrotask(() => proc.emit('close', null)); return true;}});
    return proc;
  }
  const f = {root, output, app, roots, mounts, stages, mcpMethods, validationAttempts, env, assertUnqualified,
    beforeWrite(path: string) {
      if (failure === 'metadata' && path === join(output, 'build-metadata.json')) throw injectedError();
    },
    beginRecovery(reason = '') {recovery = true; failure = reason;},
    async build(options: any) {
      assertQualificationBoundary();
      if (!options.prepackaged) {
        await options.config.afterPack();
        stages.push('sign-app');
        if (failure === 'sign') {
          require('builder-util').log.warn({error: injectedError()}, 'fixture builder retry before rejection');
          throw injectedError();
        }
        if (failure === 'signing') throw new Error('fixture signing failed');
        metadata = options.config.extraMetadata.missionBinary;
        assert.equal(options.config.forceCodeSigning, true);
        assert.equal(options.config.mac.notarize, false);
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
        if (failure === 'dmg build') throw injectedError();
        snapshot(join(output, distributionNames(metadata).dmg), 'dmg');
      }
      return [];
    },
    notarize(command: string, args: string[], callback: Function) {
      assertQualificationBoundary();
      if (args[0] === 'notarytool') {
        if (args[1] === 'submit') {
          const dmg = args[2]!.endsWith('.dmg');
          stages.push(dmg ? 'notarize-dmg' : 'notarize-app');
          if (failure === (dmg ? 'notarize (dmg)' : 'notarize (app)')) {
            const error = injectedError();
            callback(Object.assign(error, {code: 17}), JSON.stringify({id: 'cccccccc-cccc-4ccc-accc-cccccccccccc', status: 'Invalid'}), error.message); return;
          }
          if (dmg && failure === 'notarization') {
            callback(Object.assign(new Error('fixture notarization failed'), {code: 17}), '', 'fixture notarization failed'); return;
          }
          callback(null, JSON.stringify({id: dmg ? 'bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb' : 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', status: 'In Progress'}), '');
        } else if (args[1] === 'log') {
          callback(null, JSON.stringify({status: 'Invalid', issues: [{severity: 'error', message: 'fixture rejection'}]}), '');
        } else {
          dmgNotarized ||= args[2] === 'bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb';
          callback(null, JSON.stringify({id: args[2], status: 'Accepted'}), '');
        }
      } else {
        assert.ok(command === '/usr/bin/codesign' || command === '/usr/bin/ditto' || args[0] === 'stapler');
        callback(null, '', '');
      }
    },
    exec(command: string, args: string[], options: any) {
      assertQualificationBoundary();
      if (command === 'git') return args[0] === 'status' ? '' : commit;
      if (command === 'npm') {
        assert.ok(Object.keys(options.env).every((key) => !/^(CSC_|APPLE_|GH_)/.test(key)), 'compilation must not receive signing secrets');
        stages.push('build'); if (failure === 'build') throw injectedError(); return '';
      }
      if (command === '/usr/bin/codesign') {
        stages.push('verify-app-signature');
        if (failure === 'verifyDistributionApp') throw injectedError();
        assert.match(args.join(' '), new RegExp(policy.teamId));
        if (failure === 'app-signature') throw new Error('fixture app signature invalid');
        return '';
      }
      if (command === '/bin/cp') {cpSync(args[1]!, args[2]!, {recursive: true}); return '';}
      if (command === '/usr/bin/xattr') {stages.push('quarantine-copy'); return '';}
      if (command === '/usr/bin/ditto') {
        if (failure === 'ditto') throw injectedError();
        snapshot(args.at(-1)!, 'zip'); stages.push('archive-zip'); return '';
      }
      if (basename(command) === 'Mission Control') return JSON.stringify({electron: '43.0.0', node: '24.0.0'});
      throw new Error(`Unexpected external command: ${command}`);
    },
    run(command: string, args: string[]) {
      assertQualificationBoundary();
      let stdout = '', stderr = '', status = 0;
      if (command === '/usr/sbin/spctl') {
        stderr = failure === 'gatekeeper' ? 'source=Unnotarized Developer ID' : 'source=Notarized Developer ID';
        if (failure === 'gatekeeper-status') {status = 3; stderr = 'rejected\nsource=Unnotarized Developer ID';}
      } else if (command === '/usr/bin/xcrun') {
        const path = args.at(-1)!;
        const attempt = (validationAttempts.get(path) ?? 0) + 1;
        validationAttempts.set(path, attempt);
        const dmg = path.endsWith('.dmg');
        stages.push(dmg ? 'validate-dmg-staple' : 'validate-app-staple');
        if ((dmg && (!dmgNotarized || failure === 'dmg-staple')) || (!dmg && failure === 'app-staple')) status = 1;
        if ((failure === 'parent-staple-transient' && path.endsWith('/Parent.app') && attempt === 1)
          || (failure === 'dmg-staple-transient' && dmg && attempt === 1)
          || (failure === 'parent-staple-network' && path.endsWith('/Parent.app'))) {
          status = 68;
          stdout = 'error is Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."\n'
            + "CloudKit's response is inconsistent with expections: (null)\nThe validate action failed! Error 68.\n";
        }
      } else if (command === '/usr/libexec/PlistBuddy') {
        const key = args[1]!.slice('Print :'.length);
        stdout = ({CFBundleIdentifier: policy.bundleId, CFBundleExecutable: "Mission Control", CFBundleName: "Agent Mission Control", CFBundleShortVersionString: metadata.version, LSMinimumSystemVersion: metadata.minimumSystemVersion} as Record<string, string>)[key]!;
      } else if (command === '/usr/bin/lipo') stdout = 'arm64';
      else if (command === '/usr/bin/codesign') {
        if (args[0] === '-d') stderr = 'flags=0x10000(runtime)';
        else {stages.push('verify-dmg-signature'); if (failure === 'dmg-signature') status = 1;}
      } else if (command === '/usr/bin/hdiutil') {
        if (args[0] === 'attach') {
          if (failure === 'archive verification') return {status: 17, stdout: '', stderr: injectedError().message};
          const mount = args.at(-1)!; mounts.push(mount); stages.push('mount-dmg');
          cpSync(snapshots.get(args[1]!)!, join(mount, 'Agent Mission Control.app'), {recursive: true});
          if (failure === 'dmg-bytes') put(join(mount, 'Agent Mission Control.app/changed'), 'tampered');
        } else {stages.push('detach-dmg'); mounts.splice(mounts.indexOf(args[1]!), 1);}
      } else if (command === '/usr/bin/ditto') {
        const destination = join(args.at(-1)!, 'Agent Mission Control.app'); stages.push('extract-zip');
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
        if (failure === 'qualifySignedRuntime') throw injectedError();
        stages.push('copied-parent');
        const probe = args[2]!; roots.push(probe);
        queueMicrotask(() => {
          if (failure === 'parent') {proc.exitCode = 1; proc.emit('exit', 1); return;}
          const directory = join(probe, 'state/update-runtimes/attempt'); mkdirSync(directory, {recursive: true});
          const original = join(probe, 'Agent Mission Control.app');
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
