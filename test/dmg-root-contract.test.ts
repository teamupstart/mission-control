import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { APP_BUNDLE_NAME } from '../src/shared/app-naming.mjs';
import { dmgRootProblem } from '../src/shared/binary-distribution.mjs';
import { renderInstallBootstrap } from '../scripts/render-install-bootstrap.mjs';
import { verifyDistributionArchives, verifyDistributionDmgRoot } from '../scripts/verify-distribution.mjs';

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
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dmg-root-')));
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
 * One `hdiutil` verb, with a bounded retry. Building, mounting and unmounting the image are
 * fixture work, not the contract under test, and every one of them fails transiently on a
 * loaded host (a full `make test` beside other worktrees' suites): exit 1 with nothing useful
 * printed while the disk image service is busy. `create` met it first, then `attach`. So keep
 * the output and try again; a persistent failure still fails with every attempt's text.
 * `beforeAttempt` undoes whatever a refused attempt may have left behind.
 */
function hdiutil(args: readonly string[], beforeAttempt: (attempt: number) => void = () => {}): void {
  const failures: string[] = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    beforeAttempt(attempt);
    const ran = spawnSync('/usr/bin/hdiutil', args, {encoding: 'utf8', timeout: 60_000});
    // A timed-out child that still exits 0 reports both, and is not a success.
    if (!ran.error && ran.status === 0) return;
    failures.push(`attempt ${attempt}: status ${ran.status} signal ${ran.signal} ${ran.error?.message ?? ''}\n${ran.stdout}${ran.stderr}`.trim());
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500 * attempt);
  }
  throw new Error(`hdiutil ${args[0]} failed 3 times:\n${failures.join('\n')}`);
}

/**
 * Every image hdiutil reports attached, by real path, or null when it cannot say. Read the way
 * `scripts/binary-install-policy.mjs` reads it: `hdiutil info -plist` through `plutil`.
 */
function attachedImages(): string[] | null {
  const plist = spawnSync('/usr/bin/hdiutil', ['info', '-plist'], {timeout: 10_000, maxBuffer: 1024 * 1024});
  if (plist.error || plist.status !== 0) return null;
  const json = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'],
    {input: plist.stdout, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024});
  if (json.error || json.status !== 0) return null;
  try {
    const images = (JSON.parse(json.stdout) as {images?: unknown}).images;
    if (!Array.isArray(images)) return null;
    return images.flatMap((image: {'image-path'?: unknown}) => {
      const path = image['image-path'];
      if (typeof path !== 'string') return [];
      try { return [realpathSync(path)]; } catch { return [path]; }
    });
  } catch {
    return null;
  }
}

/**
 * True only when hdiutil confirms `dmg` is no longer attached. The image itself, not its mount
 * point: an attach can attach the device without mounting it where we asked, and a mount point
 * that is empty says nothing about that. An inventory that cannot be read proves nothing either.
 */
function imageDetached(dmg: string, inventory: () => readonly string[] | null = attachedImages): boolean {
  const images = inventory();
  return images !== null && !images.includes(dmg);
}

/**
 * Run `attach`; when it gives up, release whatever it may have left mounted before passing its
 * error on. A refused attach can still mount the image, and after the last refusal nothing else
 * would ever detach it, because the work directory's cleanup only deletes files. A release that
 * itself fails is reported beside the attach error, never in place of it, unless the image is
 * confirmed detached - an inventory that cannot be read is not that confirmation.
 */
function attachOrRelease(
  attach: () => void,
  release: () => Pick<SpawnSyncReturns<unknown>, 'status' | 'signal' | 'error'>,
  gone: () => boolean,
): void {
  try {
    attach();
  } catch (error) {
    const released = release();
    if ((released.error || released.status !== 0) && !gone()) {
      const why = `status ${released.status} signal ${released.signal} ${released.error?.message ?? ''}`.trim();
      throw new Error(`${(error as Error).message}\nForce-detach also failed, so the image may still be mounted: ${why}`, {cause: error});
    }
    throw error;
  }
}

test('a refused attach releases the mount, and says so when it cannot', () => {
  const refused = () => { throw new Error('hdiutil attach failed 3 times'); };
  const failed = () => ({status: 1, signal: null, error: undefined});
  const ok = () => ({status: 0, signal: null, error: undefined});
  let released = 0;
  attachOrRelease(() => {}, () => { released += 1; return ok(); }, () => false);
  assert.equal(released, 0, 'a successful attach releases nothing');
  assert.throws(() => attachOrRelease(refused, () => { released += 1; return ok(); }, () => false),
    (error: Error) => error.message === 'hdiutil attach failed 3 times');
  assert.equal(released, 1, 'a refused attach is released before its error is passed on');
  assert.throws(() => attachOrRelease(refused, failed, () => false), (error: Error) =>
    error.message.startsWith('hdiutil attach failed 3 times\nForce-detach also failed, so the image may still be mounted: status 1')
    && (error.cause as Error).message === 'hdiutil attach failed 3 times');
  assert.throws(() => attachOrRelease(refused, () => ({status: null, signal: null, error: new Error('spawnSync hdiutil ETIMEDOUT')}), () => false),
    /Force-detach also failed, so the image may still be mounted: status null signal null spawnSync hdiutil ETIMEDOUT/);
  assert.throws(() => attachOrRelease(refused, failed, () => true),
    (error: Error) => error.message === 'hdiutil attach failed 3 times', 'a mount that is gone needs no report');
  // An image still attached, or an inventory that cannot be read, is not a clean release.
  assert.throws(() => attachOrRelease(refused, failed, () => imageDetached('/w/fixture.dmg', () => ['/w/fixture.dmg'])),
    /Force-detach also failed/);
  assert.throws(() => attachOrRelease(refused, failed, () => imageDetached('/w/fixture.dmg', () => null)),
    /Force-detach also failed/);
});

test('an image is detached only when the inventory confirms it', () => {
  // Attached but mounted nowhere we asked: an empty mount point proves nothing, the inventory does.
  assert.equal(imageDetached('/w/fixture.dmg', () => ['/System/other.dmg', '/w/fixture.dmg']), false);
  assert.equal(imageDetached('/w/fixture.dmg', () => ['/System/other.dmg']), true);
  assert.equal(imageDetached('/w/fixture.dmg', () => []), true);
  assert.equal(imageDetached('/w/fixture.dmg', () => null), false, 'an unreadable inventory is not confirmation');
});

function image(t: test.TestContext, entries: readonly string[]): {work: string; dmg: string} {
  const source = layout(t, entries);
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'dmg-root-image-')));
  t.after(() => rmSync(work, {recursive: true, force: true}));
  const dmg = join(work, 'fixture.dmg');
  hdiutil(['create', '-srcfolder', source, '-format', 'UDZO', '-volname', 'Agent Mission Control', dmg],
    () => rmSync(dmg, {force: true}));
  return {work, dmg};
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
    assert.doesNotMatch(error.message, /DMG root/);
    return true;
  });
});

test('producer qualification refuses a real mounted DMG whose root the installer refuses', macOnly, t => {
  for (const [entries, accepted] of [[publishedRoot, true], [[...publishedRoot, 'payload.command'], false]] as const) {
    const {work, dmg} = image(t, entries);
    const mount = join(work, 'image');
    mkdirSync(mount);
    // A refused attach that still mounted would block the next attempt, so each retry starts
    // from a released mount point, and so does the error after the last one.
    const forceDetach = () => spawnSync('/usr/bin/hdiutil', ['detach', mount, '-force'], {timeout: 60_000, stdio: 'ignore'});
    attachOrRelease(
      () => hdiutil(['attach', dmg, '-readonly', '-nobrowse', '-mountpoint', mount], (attempt) => {
        if (attempt > 1) forceDetach();
      }),
      forceDetach,
      () => imageDetached(dmg),
    );
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
