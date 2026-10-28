import { APP_EXECUTABLE_NAME, binaryBundleName } from "../src/shared/app-naming.mjs";
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getCurrentFuseWire, FuseV1Options } from '@electron/fuses';
import { inspectBundle, verifyBinaryPublisher } from './install-staged-app.mjs';
import { UPDATE_HELPER_FILES } from './update-helper-files.mjs';
import { assertBuildMetadata } from './distribution-contract.mjs';
import { distributionToolError } from './distribution-diagnostics.mjs';

function macTool(command, args) {
  const result = spawnSync(command, args, {encoding: 'utf8', timeout: 60_000, env: {...process.env, LC_ALL: 'C'}});
  if (result.error || result.status !== 0) throw distributionToolError(command, result);
  return {stdout: result.stdout.trim(), stderr: result.stderr};
}

export async function verifyDistributionApp(app, metadata, policy) {
  assertBuildMetadata(metadata);
  verifyBinaryPublisher(app, policy);
  macTool('/usr/bin/xcrun', ['stapler', 'validate', app]);
  const plist = join(app, 'Contents/Info.plist');
  for (const [key, value] of Object.entries({CFBundleIdentifier: policy.bundleId, CFBundleExecutable: APP_EXECUTABLE_NAME,
    CFBundleName: binaryBundleName(metadata).slice(0, -4),
    CFBundleShortVersionString: metadata.version, LSMinimumSystemVersion: metadata.minimumSystemVersion})) {
    assert.equal(macTool('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist]).stdout, value, key);
  }
  const executable = join(app, 'Contents/MacOS', APP_EXECUTABLE_NAME);
  assert.equal(macTool('/usr/bin/lipo', ['-archs', executable]).stdout, 'arm64');
  const signature = macTool('/usr/bin/codesign', ['-d', '--verbose=4', app]).stderr;
  assert.match(signature, /flags=.*\bruntime\b/);
  const metadataFile = JSON.parse(readFileSync(join(app, 'Contents/Resources/app/package.json'), 'utf8'));
  assert.deepEqual(metadataFile.missionBinary, metadata);
  assert.equal(metadataFile.missionCommit, metadata.commit);
  assert.equal(metadataFile.version, metadata.version);
  for (const path of UPDATE_HELPER_FILES) assert.ok(existsSync(join(app, 'Contents/Resources/app', path)), `Missing packaged helper ${path}`);
  const fuses = await getCurrentFuseWire(app);
  assert.equal(fuses[FuseV1Options.RunAsNode], 49, 'RunAsNode must remain enabled');
  assert.equal(fuses[FuseV1Options.EnableNodeOptionsEnvironmentVariable], 48, 'NodeOptions environment variable must remain disabled');
  assert.equal(fuses[FuseV1Options.EnableNodeCliInspectArguments], 48, 'Node CLI inspector arguments must remain disabled');
  assert.equal(fuses[FuseV1Options.OnlyLoadAppFromAsar], 48, 'Plain-file satellites and helpers require asar disabled');
}

export function verifyDistributionDmg(dmg, policy) {
  macTool('/usr/bin/codesign', ['--verify', '--strict', '-R',
    `=anchor apple generic and certificate leaf[subject.OU] = "${policy.teamId}"`, dmg]);
  macTool('/usr/bin/xcrun', ['stapler', 'validate', dmg]);
  const assessment = macTool('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=4', dmg]);
  assert.match(assessment.stderr, /^source=Notarized Developer ID$/m);
}

export async function verifyDistributionArchives({app, appDigest, files, metadata, policy, requalifyRuntime = false}) {
  const root = mkdtempSync(join(tmpdir(), 'mission-archive-verification-'));
  const mount = join(root, 'image'); mkdirSync(mount);
  let mounted = false;
  try {
    const digest = app ? inspectBundle(app).digest : appDigest;
    assert.match(digest ?? '', /^[a-f0-9]{64}$/);
    macTool('/usr/bin/hdiutil', ['attach', files.dmg, '-readonly', '-nobrowse', '-mountpoint', mount]);
    mounted = true;
    const dmgApp = join(mount, binaryBundleName(metadata));
    assert.equal(inspectBundle(dmgApp).digest, digest, 'DMG must contain the exact signed app');
    await verifyDistributionApp(dmgApp, metadata, policy);
    const extracted = join(root, 'zip'); mkdirSync(extracted);
    // Locally produced or retained producer artifacts, not the later client
    // untrusted-download extractor or an installer entry point.
    macTool('/usr/bin/ditto', ['-x', '-k', files['app-zip'], extracted]);
    const zipApp = join(extracted, binaryBundleName(metadata));
    assert.equal(inspectBundle(zipApp).digest, digest, 'ZIP must contain the exact signed app');
    await verifyDistributionApp(zipApp, metadata, policy);
    if (requalifyRuntime) {
      const {qualifySignedRuntime} = await import('./qualify-signed-runtime.mjs');
      await qualifySignedRuntime(zipApp, metadata, policy);
    }
  } finally {
    if (mounted) macTool('/usr/bin/hdiutil', ['detach', mount]);
    rmSync(root, {recursive: true, force: true});
  }
}
