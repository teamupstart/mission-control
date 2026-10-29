import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import test from 'node:test';
import { inspectBundle } from '../scripts/install-staged-app.mjs';
import { renderInstallBootstrap } from '../scripts/render-install-bootstrap.mjs';

const macOnly = {skip: process.platform !== 'darwin' ? 'Requires real macOS archive tools' : false};
const native = (command: string, args: string[]) => execFileSync(command, args,
  {encoding: 'utf8', timeout: 60_000, env: {...process.env, LC_ALL: 'C'}, stdio: ['ignore', 'pipe', 'pipe']});

async function attachDmg(dmg: string, mount: string, {
  run = native,
  wait = setTimeout,
  diagnostic = (_message: string) => {},
}: {run?: typeof native; wait?: (ms: number) => Promise<unknown>; diagnostic?: (message: string) => void} = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return run('/usr/bin/hdiutil', ['attach', dmg, '-readonly', '-nobrowse', '-mountpoint', mount]);
    } catch (error) {
      // The real macOS probe can hit temporary mount resource exhaustion while
      // other tests run. Retry only that refusal, never corrupt images or timeouts.
      if (attempt >= 3 || !(error instanceof Error)
        || !('status' in error) || error.status !== 1
        || !('signal' in error) || error.signal !== null
        || !('stderr' in error) || typeof error.stderr !== 'string'
        || error.stderr.trim() !== 'hdiutil: attach failed - Resource temporarily unavailable') throw error;
      diagnostic(`DMG attach attempt ${attempt}: Resource temporarily unavailable; retrying in ${attempt}s.`);
      await wait(attempt * 1000);
    }
  }
}

const unavailableMount = () => Object.assign(new Error('attach refused'), {
  status: 1, signal: null, stderr: 'hdiutil: attach failed - Resource temporarily unavailable\n',
});

test('DMG attach retries temporary resource refusal with the same read-only mount arguments', async () => {
  const calls: string[][] = [];
  const waits: number[] = [];
  const diagnostics: string[] = [];
  const result = await attachDmg('/fixture/installer.dmg', '/fixture/image', {
    run: (command, args) => {
      calls.push([command, ...args]);
      if (calls.length < 3) throw unavailableMount();
      return 'mounted';
    },
    wait: async ms => { waits.push(ms); },
    diagnostic: message => { diagnostics.push(message); },
  });
  assert.equal(result, 'mounted');
  assert.equal(calls.length, 3);
  for (const call of calls) assert.deepEqual(call, [
    '/usr/bin/hdiutil', 'attach', '/fixture/installer.dmg', '-readonly', '-nobrowse', '-mountpoint', '/fixture/image',
  ]);
  assert.deepEqual(waits, [1000, 2000]);
  assert.equal(diagnostics.length, 2);
  assert.match(diagnostics[0]!, /Resource temporarily unavailable/);
});

test('DMG attach retains the final failure after three temporary resource refusals', async () => {
  const failures = [unavailableMount(), unavailableMount(), unavailableMount()];
  let calls = 0;
  const waits: number[] = [];
  await assert.rejects(attachDmg('/fixture/installer.dmg', '/fixture/image', {
    run: () => { throw failures[calls++]; },
    wait: async ms => { waits.push(ms); },
  }), error => error === failures[2]);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [1000, 2000]);
});

test('DMG attach does not retry permanent errors, timeouts, or unrelated resource errors', async () => {
  for (const failure of [
    Object.assign(unavailableMount(), {stderr: 'hdiutil: attach failed - no mountable file systems\n'}),
    Object.assign(unavailableMount(), {status: null, signal: 'SIGTERM'}),
    Object.assign(unavailableMount(), {stderr: 'spawn hdiutil: Resource temporarily unavailable\n'}),
  ]) {
    let calls = 0;
    await assert.rejects(attachDmg('/fixture/installer.dmg', '/fixture/image', {
      run: () => { calls++; throw failure; },
      wait: async () => { assert.fail('must not wait after a non-retryable failure'); },
    }), error => error === failure);
    assert.equal(calls, 1);
  }
});

test('real cp, quarantine, ditto and read-only DMG round trips preserve bundle bytes, modes and links', macOnly, async t => {
  const root = mkdtempSync(join(tmpdir(), 'distribution-native-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const name = 'Agent Mission Control.app';
  const app = join(root, 'source', name);
  const framework = join(app, 'Contents/Frameworks/Fixture.framework');
  mkdirSync(join(framework, 'Versions/A'), {recursive: true});
  writeFileSync(join(framework, 'Versions/A/Fixture'), 'fixture executable bytes\n', {mode: 0o755});
  symlinkSync('A', join(framework, 'Versions/Current'));
  symlinkSync('Versions/Current/Fixture', join(framework, 'Fixture'));
  writeFileSync(join(app, 'Contents/Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.mission-control.app</string></dict></plist>');
  const digest = inspectBundle(app).digest;
  const copy = join(root, 'Copied Runtime.app');
  native('/bin/cp', ['-R', app, copy]);
  native('/usr/bin/xattr', ['-w', 'com.apple.quarantine', '0083;00000000;MissionControlQualification;', copy]);
  const second = join(root, 'Parent.app');
  native('/bin/cp', ['-R', copy, second]);
  assert.equal(inspectBundle(second).digest, digest);
  // macOS may normalize the flags and agent name while copying. The quarantine
  // attribute must survive; byte-for-byte attribution is not the contract.
  assert.match(native('/usr/bin/xattr', ['-p', 'com.apple.quarantine', second]), /^[a-f0-9]{4};/i);

  const zip = join(root, 'app.zip');
  native('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip]);
  const extracted = join(root, 'extracted'); mkdirSync(extracted);
  native('/usr/bin/ditto', ['-x', '-k', zip, extracted]);
  assert.equal(inspectBundle(join(extracted, name)).digest, digest);

  // A disposable unsigned image tests archive mechanics only. Electron-builder's
  // signed DMG and Apple's notarization still require the approved release run.
  const dmg = join(root, 'installer.dmg');
  native('/usr/bin/hdiutil', ['create', '-srcfolder', join(root, 'source'), '-format', 'UDZO', '-volname', 'Native argument probe', dmg]);
  const mount = join(root, 'image'); mkdirSync(mount);
  await attachDmg(dmg, mount, {diagnostic: message => t.diagnostic(message)});
  try {
    assert.equal(inspectBundle(join(mount, name)).digest, digest);
    assert.throws(() => writeFileSync(join(mount, 'must-not-write'), 'refuse'), /EROFS|EACCES|EPERM/);
    const staged = join(root, 'staged', name);
    native('/usr/bin/ditto', [join(mount, name), staged]);
    assert.equal(inspectBundle(staged).digest, digest);
  } finally { native('/usr/bin/hdiutil', ['detach', mount]); }
  t.diagnostic(`Native copy/quarantine, ZIP, mounted read-only DMG and bootstrap ditto all preserve digest ${digest}. Unsigned fixture only.`);
});

test('real bootstrap metadata and digest helpers accept JSON array paths and spaced file names', macOnly, t => {
  const root = mkdtempSync(join(tmpdir(), 'bootstrap-native-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const metadata = join(root, 'build metadata.json');
  writeFileSync(metadata, JSON.stringify({missionBinary: {appBundleName: 'Agent Mission Control.app'}, assets: [{id: 123, bytes: 456}]}));
  const source = renderInstallBootstrap();
  const helpers = source.slice(0, source.indexOf('\nmain() {'));
  const script = `${helpers}\nfield "$1" missionBinary.appBundleName\nfield "$1" assets.0.id\nfield "$1" assets.0.bytes\ndigest "$1"\n`;
  const output = native('/bin/bash', ['-c', script, 'bootstrap-native', metadata]);
  assert.match(output, /^Agent Mission Control\.app\n123\n456\n[a-f0-9]{64}\n$/);
  assert.equal(native('/usr/bin/stat', ['-f', '%z', metadata]).trim(), String(Buffer.byteLength(readFileSync(metadata))));
  t.diagnostic('Shipped Bash field/digest helpers passed real plutil, openssl and stat with JSON array indexes.');
});

test('installed notarytool accepts the submit/wait/log option vocabulary without credentials or submissions', macOnly, t => {
  for (const operation of ['submit', 'wait', 'log']) {
    const help = native('/usr/bin/xcrun', ['notarytool', 'help', operation]);
    for (const option of ['--key ', '--key-id ', '--issuer ']) assert.ok(help.includes(option), `${operation}: ${option}`);
    if (operation !== 'log') assert.match(help, /--output-format/);
    if (operation === 'wait') assert.match(help, /--timeout <duration>[\s\S]*minutes 'm'/);
  }
  // Validate the actual stapler argument order against an ineligible system
  // binary. This must reach ticket validation, never an unknown-option error.
  const staple = spawnSync('/usr/bin/xcrun', ['stapler', 'validate', '/bin/ls'], {encoding: 'utf8', timeout: 30_000});
  assert.ifError(staple.error);
  assert.notEqual(staple.status, 0);
  assert.match(staple.stdout + staple.stderr, /does not have a ticket stapled|not a supported file format/i);
  t.diagnostic(`notarytool submit/wait/log help matches producer argv; stapler validate reached ticket/format refusal (exit ${staple.status}). No Apple submission made.`);
});

test('real spctl understands the app and primary-signature assessment arguments', macOnly, t => {
  for (const args of [
    ['--assess', '--type', 'execute', '--verbose=4', '/bin/ls'],
    ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=4', '/bin/ls'],
  ]) {
    const result = spawnSync('/usr/sbin/spctl', args, {encoding: 'utf8', timeout: 30_000, env: {...process.env, LC_ALL: 'C'}});
    assert.ifError(result.error);
    assert.ok(result.status === 0 || result.status === 3, result.stderr);
    assert.match(result.stderr, /accepted|rejected/);
    assert.doesNotMatch(result.stderr, /unrecognized|unknown option|usage:/i);
    // /bin/ls is Apple system code, never our notarized Developer ID app.
    assert.doesNotMatch(result.stderr, /^source=Notarized Developer ID$/m);
    t.diagnostic(JSON.stringify({tool: '/usr/sbin/spctl', args, status: result.status, stderr: result.stderr}));
  }
});
