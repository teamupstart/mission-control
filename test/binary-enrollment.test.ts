import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { startBinaryEnrollment } from '../src/main/binary-enrollment.ts';
import { inspectBundle } from '../scripts/install-staged-app.mjs';

function fixture(t: test.TestContext, channel: 'stable' | 'alpha', exitCode: number, location: 'copied' | 'translocated' | 'mounted-image' = 'copied') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'binary-enrollment-')));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const temporary = location !== 'copied';
  const bundle = join(root, location === 'translocated' ? 'AppTranslocation/fixture/d/Mission Control.app'
    : location === 'mounted-image' ? 'MC-image/Mission Control.app' : 'Copied Apps/Mission Control.app');
  const appRoot = join(bundle, 'Contents/Resources/app');
  mkdirSync(join(appRoot, 'scripts'), {recursive: true});
  const metadata = {protocol: 1, repo: 'teamupstart/mission-control', bundleId: 'com.mission-control.app',
    channel, releaseTag: channel === 'stable' ? 'v1.2.3' : null, version: '1.2.3', commit: 'a'.repeat(40),
    platform: 'darwin', arch: 'arm64', minimumSystemVersion: '12.0', helperProtocol: {min: 1, max: 1}, receiptSchema: 2};
  writeFileSync(join(appRoot, 'package.json'), JSON.stringify({missionBinary: metadata}));
  const bootstrap = join(appRoot, 'scripts/install.sh');
  // The real Bash child only prints fixture diagnostics. It cannot download or install.
  writeFileSync(bootstrap, `${temporary ? 'while [ ! -e "$MISSION_HOME/release-child" ]; do /bin/sleep 0.01; done\n' : ''}printf '%s\\n' 'bootstrap stdout'
printf '%s\\n' 'bootstrap stderr' >&2
printf 'state=%s\\n' "$MISSION_HOME"
printf 'electron=%s\\n' "\${ELECTRON_RUN_AS_NODE-unset}"
exit ${exitCode}
`);
  const stateDirectory = join(root, 'state'); mkdirSync(stateDirectory, {mode: 0o700});
  writeFileSync(join(stateDirectory, 'keep-state'), 'untouched operator fixture');
  const logPath = join(stateDirectory, 'binary-install.log');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const electronRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
  Object.defineProperty(process, 'platform', {value: 'darwin'});
  process.env.ELECTRON_RUN_AS_NODE = '1';
  // Only native signature and image inventory responses are simulated. Keep enrollment selection,
  // argument construction, logging, spawn and child exit handling real.
  const signing = t.mock.method(childProcess, 'execFileSync', ((command: string, args: readonly string[]) => {
    if (command === '/usr/bin/hdiutil') return 'fixture plist';
    if (command === '/usr/bin/plutil') return JSON.stringify({images: location === 'mounted-image'
      ? [{'system-entities': [{'mount-point': dirname(bundle)}]}] : []});
    assert.equal(command, '/usr/bin/codesign');
    assert.equal(args.at(-1), bundle);
    return '';
  }) as typeof childProcess.execFileSync);
  const assessment = t.mock.method(childProcess, 'spawnSync', ((command: string, args: readonly string[]) => {
    assert.equal(command, '/usr/sbin/spctl');
    assert.equal(args.at(-1), bundle);
    return {status: 0, stdout: '', stderr: 'source=Notarized Developer ID\n'};
  }) as typeof childProcess.spawnSync);
  const spawn = childProcess.spawn;
  const children: {child: childProcess.ChildProcess; closed: Promise<number | null>; unrefs: () => number}[] = [];
  const launch = t.mock.method(childProcess, 'spawn', ((command: string, args: readonly string[], options: childProcess.SpawnOptions) => {
    assert.equal(command, '/bin/bash');
    assert.deepEqual(args, [bootstrap, '--ref', channel === 'stable' ? 'v1.2.3' : metadata.commit,
      ...(temporary ? [] : ['--enroll', '--apps-dir', dirname(bundle)])]);
    assert.equal(options.detached, temporary);
    assert.equal(options.env?.MISSION_HOME, stateDirectory);
    assert.equal(options.env?.ELECTRON_RUN_AS_NODE, undefined);
    const child = spawn(command, args, options);
    const closed = new Promise<number | null>(resolve => child.once('close', resolve));
    let unrefs = 0;
    const unref = child.unref.bind(child);
    t.mock.method(child, 'unref', () => {unrefs++; unref();});
    children.push({child, closed, unrefs: () => unrefs});
    return child;
  }) as typeof childProcess.spawn);
  syncBuiltinESMExports();
  t.after(() => {
    signing.mock.restore(); assessment.mock.restore(); launch.mock.restore(); syncBuiltinESMExports();
    Object.defineProperty(process, 'platform', platform);
    if (electronRunAsNode === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = electronRunAsNode;
  });
  return {bundle, stateDirectory, logPath, launch, children,
    expectedLog: `bootstrap stdout\nbootstrap stderr\nstate=${stateDirectory}\nelectron=unset\n`};
}

for (const channel of ['stable', 'alpha'] as const) test(`copied-app ${channel} enrollment launches its exact release and destination through Bash and logs the child output`, async t => {
  const f = fixture(t, channel, 0);
  const result = await startBinaryEnrollment(f.bundle, f.stateDirectory);
  assert.equal(f.launch.mock.callCount(), 1);
  assert.equal(result.started, true);
  assert.match(result.message, /copied app is now managed/);
  assert.equal(readFileSync(f.logPath, 'utf8'), f.expectedLog);
  assert.equal(statSync(f.logPath).mode & 0o777, 0o600, 'new enrollment logs are private');
  assert.equal(readFileSync(join(f.stateDirectory, 'keep-state'), 'utf8'), 'untouched operator fixture');
});

for (const location of ['translocated', 'mounted-image'] as const) test(`${location} app installation launches detached without enrollment or destination flags and returns the progress log before the child exits`, {timeout: 15_000}, async t => {
  const f = fixture(t, 'stable', 0, location);
  const previous = inspectBundle(f.bundle);
  const release = () => writeFileSync(join(f.stateDirectory, 'release-child'), 'continue');
  // Bound a regression that incorrectly waits for completion; normally the test
  // releases the child immediately after observing the returned handoff.
  const safetyRelease = setTimeout(release, 5000);
  let exitCodes: (number | null)[] = [];
  try {
    const result = await startBinaryEnrollment(f.bundle, f.stateDirectory);
    assert.equal(f.launch.mock.callCount(), 1);
    const launched = f.children[0]!;
    assert.equal(launched.child.exitCode, null, 'the handoff returns while the real Bash child is still running');
    assert.equal(launched.unrefs(), 1, 'the detached child does not hold the GUI open');
    assert.deepEqual(result, {started: true, message: `Installation started. Progress and recovery details: ${f.logPath}`});
    assert.equal(statSync(f.logPath).mode & 0o777, 0o600);
  } finally {
    for (const {child} of f.children) child.ref();
    clearTimeout(safetyRelease);
    release();
    // Reap the exact fixture children before removing their temporary app/state.
    exitCodes = await Promise.all(f.children.map(child => child.closed));
  }
  assert.deepEqual(exitCodes, [0]);
  assert.equal(readFileSync(f.logPath, 'utf8'), f.expectedLog);
  assert.deepEqual(inspectBundle(f.bundle), previous);
  assert.equal(existsSync(join(f.stateDirectory, 'install-receipt.json')), false);
  assert.equal(readFileSync(join(f.stateDirectory, 'keep-state'), 'utf8'), 'untouched operator fixture');
});

test('copied-app enrollment reports a nonzero bootstrap exit with its appended log and preserves the app and state', async t => {
  const f = fixture(t, 'stable', 17);
  const previous = inspectBundle(f.bundle);
  writeFileSync(f.logPath, 'earlier attempt\n', {mode: 0o600});
  await assert.rejects(startBinaryEnrollment(f.bundle, f.stateDirectory), (error: Error) => {
    assert.match(error.message, /Enrollment could not complete\. Your existing installation was preserved\./);
    assert.ok(error.message.includes(f.logPath), 'the failure points to the retained diagnostics');
    return true;
  });
  assert.equal(f.launch.mock.callCount(), 1);
  assert.equal(readFileSync(f.logPath, 'utf8'), `earlier attempt\n${f.expectedLog}`);
  assert.deepEqual(inspectBundle(f.bundle), previous);
  assert.equal(existsSync(join(f.stateDirectory, 'install-receipt.json')), false);
  assert.equal(readFileSync(join(f.stateDirectory, 'keep-state'), 'utf8'), 'untouched operator fixture');
});
