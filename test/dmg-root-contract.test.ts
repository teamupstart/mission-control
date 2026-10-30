import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
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

function image(t: test.TestContext, entries: readonly string[]): {work: string; dmg: string} {
  const source = layout(t, entries);
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'dmg-root-image-')));
  t.after(() => rmSync(work, {recursive: true, force: true}));
  const dmg = join(work, 'fixture.dmg');
  execFileSync('/usr/bin/hdiutil', ['create', '-quiet', '-srcfolder', source, '-format', 'UDZO', '-volname', 'Agent Mission Control', dmg], {timeout: 60_000});
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
    execFileSync('/usr/bin/hdiutil', ['attach', dmg, '-readonly', '-nobrowse', '-mountpoint', mount], {timeout: 60_000, stdio: 'ignore'});
    try {
      const installer = installerAcceptsRoot(mount);
      t.diagnostic(JSON.stringify({entries, installer: installer.accepted, producer: producerAccepts(mount)}));
      assert.equal(installer.accepted, accepted, installer.stderr);
      assert.equal(producerAccepts(mount), accepted);
    } finally {
      execFileSync('/usr/bin/hdiutil', ['detach', mount], {timeout: 60_000, stdio: 'ignore'});
    }
  }
});
