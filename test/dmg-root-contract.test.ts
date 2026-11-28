import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { APP_BUNDLE_NAME } from '../src/shared/app-naming.mjs';
import { dmgRootProblem } from '../src/shared/binary-distribution.mjs';
import { renderInstallBootstrap } from '../scripts/render-install-bootstrap.mjs';
import { verifyDistributionArchives, verifyDistributionDmgRoot } from '../scripts/verify-distribution.mjs';
import { native, releaseFixtureImage } from './helpers/native-dmg.ts';
import { tempDir } from "./temp-root.mjs";

const macOnly = {skip: process.platform !== 'darwin' ? 'Requires real macOS disk image tools' : false};
// The root of alpha-80b1258e's published DMG, which every installer before this contract refused.
const publishedRoot = [APP_BUNDLE_NAME, 'Read Me.txt', '.DS_Store', '.VolumeIcon.icns', '.background.tiff'];

// The rendered installer's own root loop, run unchanged against a directory.
const installerRootCheck = (() => {
  const shell = renderInstallBootstrap();
  const start = shell.indexOf('  shopt -s dotglob nullglob\n');
  const end = shell.indexOf('  done\n', start);
  assert.ok(start > 0 && end > start, 'rendered installer must keep its DMG root loop');
  return shell.slice(start, end + '  done\n'.length);
})();
function installerAcceptsRoot(mount: string): {accepted: boolean; stderr: string} {
  const loop = installerRootCheck.replaceAll('"$mission_tmp/image/"', '"$mission_tmp/"');
  const script = `fail() { printf '%s\\n' "$1" >&2; exit 1; }\nmission_tmp=$1; app_bundle=$2\n${loop}`;
  const result = spawnSync('/bin/bash', ['-c', script, 'root-check', mount, APP_BUNDLE_NAME], {encoding: 'utf8', timeout: 10_000});
  assert.ifError(result.error);
  return {accepted: result.status === 0, stderr: result.stderr};
}
function layout(t: test.TestContext, entries: readonly string[]): string {
  const dir = realpathSync(tempDir('dmg-root-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  for (const entry of entries) {
    if (entry.endsWith('.app')) mkdirSync(join(dir, entry, 'Contents'), {recursive: true});
    else writeFileSync(join(dir, entry), 'volume metadata');
  }
  return dir;
}
function producerAccepts(mount: string): boolean {
  try { verifyDistributionDmgRoot(mount, APP_BUNDLE_NAME); return true; } catch { return false; }
}

test('the shared contract accepts the root electron-builder published', () => {
  assert.equal(dmgRootProblem(publishedRoot, APP_BUNDLE_NAME), null);
});

test('the shared contract names stray entries and a missing app, and admits no pattern', () => {
  assert.match(dmgRootProblem([...publishedRoot, 'payload.command'], APP_BUNDLE_NAME) ?? '', /Unexpected DMG root entries: "payload.command"/);
  assert.match(dmgRootProblem([...publishedRoot, '.background.png'], APP_BUNDLE_NAME) ?? '', /"\.background\.png"/);
  assert.match(dmgRootProblem([...publishedRoot, 'Mission Control.app'], APP_BUNDLE_NAME) ?? '', /"Mission Control\.app"/);
  assert.match(dmgRootProblem(publishedRoot.slice(1), APP_BUNDLE_NAME) ?? '', /does not contain Agent Mission Control\.app/);
});

for (const [name, entries, accepted] of [
  ['the published layout', publishedRoot, true],
  ['a stray executable', [...publishedRoot, 'payload.command'], false],
  ['an unreviewed background format', [...publishedRoot, '.background.png'], false],
  ['a second app', [...publishedRoot, 'Mission Control.app'], false],
] as const) {
  test(`producer qualification and the rendered installer agree on ${name}`, t => {
    const mount = layout(t, entries);
    const installer = installerAcceptsRoot(mount);
    assert.equal(installer.accepted, accepted, installer.stderr);
    if (!accepted) assert.match(installer.stderr, /Unexpected DMG root/);
    assert.equal(producerAccepts(mount), accepted);
    if (!accepted) assert.throws(() => verifyDistributionDmgRoot(mount, APP_BUNDLE_NAME), /Unexpected DMG root entries/);
  });
}

/**
 * One `hdiutil` verb, with the bounded retry `image()` gives `hdiutil create`: `attach` and
 * `detach` fail the same way on a loaded host, exit 1 while the disk image service is busy.
 * A persistent failure still fails with every attempt's text, and a timed-out child that
 * happens to exit 0 is not a success. `beforeAttempt` undoes what a refused attempt left.
 */
function hdiutil(args: readonly string[], beforeAttempt: (attempt: number) => void = () => {}): void {
  const failures: string[] = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    beforeAttempt(attempt);
    const ran = spawnSync('/usr/bin/hdiutil', args, {encoding: 'utf8', timeout: 60_000});
    if (!ran.error && ran.status === 0) return;
    failures.push(`attempt ${attempt}: status ${ran.status} signal ${ran.signal} ${ran.error?.message ?? ''}\n${ran.stdout}${ran.stderr}`.trim());
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500 * attempt);
  }
  throw new Error(`hdiutil ${args[0]} failed 3 times:\n${failures.join('\n')}`);
}

function image(t: test.TestContext, entries: readonly string[], retainWriter = false): {work: string; dmg: string} {
  const source = layout(t, entries);
  const work = realpathSync(tempDir('dmg-root-image-'));
  const dmg = join(work, 'fixture.dmg');
  t.after(() => { releaseFixtureImage(dmg); rmSync(work, {recursive: true, force: true}); });
  // Building the image is fixture setup, not the contract under test, and `hdiutil create`
  // fails transiently on a loaded host (a full `make test` beside other worktrees' suites):
  // exit 1 with nothing printed, because `-quiet` silences its errors too. So keep its output
  // and give it a bounded retry; a persistent failure still fails with every attempt's text.
  const failures: string[] = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    // A failed create may still own a helper device. Release it before unlinking.
    releaseFixtureImage(dmg);
    rmSync(dmg, {force: true});
    const created = spawnSync('/usr/bin/hdiutil', ['create', '-srcfolder', source, '-format', retainWriter ? 'UDRW' : 'UDZO', '-volname', 'Agent Mission Control', dmg], {encoding: 'utf8', timeout: 60_000});
    if (created.status === 0) {
      // Deterministically reproduce a writable helper retained by fixture creation.
      if (retainWriter) native('/usr/bin/hdiutil', ['attach', dmg, '-readwrite', '-nomount']);
      // Even a successful create can retain its writer, blocking the real verifier's
      // read-only attach. Finish fixture preparation before testing qualification.
      releaseFixtureImage(dmg);
      return {work, dmg};
    }
    failures.push(`attempt ${attempt}: status ${created.status} signal ${created.signal} ${created.error?.message ?? ''}\n${created.stdout}${created.stderr}`.trim());
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500 * attempt);
  }
  throw new Error(`hdiutil create failed 3 times:\n${failures.join('\n')}`);
}

test('archive qualification refuses a DMG whose root the installer refuses, before trusting its app', macOnly, async t => {
  // Drives the Signed distribution entry point itself, so removing the root check from
  // verifyDistributionArchives fails here rather than only in the helper's own tests.
  const qualify = (dmg: string) => verifyDistributionArchives({appDigest: 'a'.repeat(64),
    files: {dmg, 'app-zip': join(dmg, '..', 'unused.zip')}, metadata: {appBundleName: APP_BUNDLE_NAME} as never, policy: {} as never});
  const stray = image(t, [...publishedRoot, 'payload.command']);
  await assert.rejects(qualify(stray.dmg), /Unexpected DMG root entries: "payload\.command"/);
  // The control: the published root passes the root check and qualification moves on to the
  // app itself, so the refusal above is the root check and nothing that runs after it.
  const published = image(t, publishedRoot);
  await assert.rejects(qualify(published.dmg), (error: Error) => {
    t.diagnostic(`published root proceeds past the root check to: ${error.message.split('\n')[0]}`);
    assert.match(error.message, /DMG must contain the exact signed app/);
    return true;
  });
});

test('archive root qualification reaches the root check after fixture creation retains a writable attachment', macOnly, async t => {
  const {dmg} = image(t, [...publishedRoot, 'payload.command'], true);
  await assert.rejects(verifyDistributionArchives({appDigest: 'a'.repeat(64),
    files: {dmg, 'app-zip': join(dmg, '..', 'unused.zip')}, metadata: {appBundleName: APP_BUNDLE_NAME} as never, policy: {} as never}),
  /Unexpected DMG root entries: "payload\.command"/);
});

test('producer qualification refuses a real mounted DMG whose root the installer refuses', macOnly, t => {
  for (const [entries, accepted] of [[publishedRoot, true], [[...publishedRoot, 'payload.command'], false]] as const) {
    const {work, dmg} = image(t, entries);
    const mount = join(work, 'image');
    mkdirSync(mount);
    // A refused attach can still leave the image attached, so each retry starts from a released
    // image; after the last refusal `image()`'s own cleanup releases it, and reports if it cannot.
    hdiutil(['attach', dmg, '-readonly', '-nobrowse', '-mountpoint', mount], (attempt) => {
      if (attempt > 1) releaseFixtureImage(dmg);
    });
    try {
      const installer = installerAcceptsRoot(mount);
      t.diagnostic(JSON.stringify({entries, installer: installer.accepted, producer: producerAccepts(mount)}));
      assert.equal(installer.accepted, accepted, installer.stderr);
      assert.equal(producerAccepts(mount), accepted);
    } finally {
      hdiutil(['detach', mount]);
    }
  }
});
