import { binaryBundleName } from "../src/shared/app-naming.mjs";
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { binaryPublisherPolicy } from '../src/shared/binary-publisher-policy.mjs';
import { distributionMetadata, distributionNames, localDistributionAssets } from './distribution-contract.mjs';
import { readVersions } from './assert-release-version.mjs';
import { inspectBundle } from './install-staged-app.mjs';
import { verifyDistributionApp, verifyDistributionDmg, verifyDistributionArchives } from './verify-distribution.mjs';
import { qualifySignedRuntime } from './qualify-signed-runtime.mjs';
import { distributionStages, distributionFailure, preserveFailureExit } from './distribution-diagnostics.mjs';
import { notarizeDistribution } from './notarize-distribution.mjs';

export function distributionCredentials(env, policy) {
  if (!env.CSC_NAME || !env.CSC_NAME.endsWith(`(${policy.teamId})`) || !env.CSC_NAME.startsWith('Developer ID Application: ')) {
    throw new Error('CSC_NAME must name the approved Developer ID Application certificate');
  }
  if (!env.CSC_LINK || !env.CSC_KEY_PASSWORD) throw new Error('CSC_LINK and CSC_KEY_PASSWORD must be securely provisioned');
  if (!env.APPLE_API_KEY || !env.APPLE_API_KEY_ID || !env.APPLE_API_ISSUER) {
    throw new Error('APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER must be securely provisioned');
  }
  if (env.APPLE_ID || env.APPLE_APP_SPECIFIC_PASSWORD || env.APPLE_KEYCHAIN_PROFILE) throw new Error('Ambiguous notarization credentials');
  return {appleApiKey: env.APPLE_API_KEY, appleApiKeyId: env.APPLE_API_KEY_ID, appleApiIssuer: env.APPLE_API_ISSUER};
}

export function distributionBuilderConfig(metadata, identity, output) {
  return {extends: './electron-builder.yml', directories: {output}, forceCodeSigning: true,
    extraMetadata: {missionCommit: metadata.commit, missionBinary: metadata},
    electronFuses: {runAsNode: true, enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false, onlyLoadAppFromAsar: false},
    // Notarization has its own mandatory stages below, with observable tool status.
    mac: {identity: identity.replace(/^Developer ID Application: /, ''), hardenedRuntime: true, notarize: false, minimumSystemVersion: metadata.minimumSystemVersion},
    dmg: {sign: true, writeUpdateInfo: false, artifactName: distributionNames(metadata).dmg}};
}

export async function packageDistribution({repoRoot = process.cwd(), env = process.env} = {}) {
  const stages = distributionStages();
  const policy = binaryPublisherPolicy();
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Distribution requires a macOS arm64 builder');
  const credentials = distributionCredentials(env, policy);
  if (!existsSync(credentials.appleApiKey)) throw new Error('Notarization key file is unavailable');
  const git = (...args) => execFileSync('git', args, {cwd: repoRoot, encoding: 'utf8'}).trim();
  if (git('status', '--porcelain', '--untracked-files=normal')) throw new Error('Distribution requires a clean exact-commit checkout');
  const commit = git('rev-parse', 'HEAD');
  if (env.GITHUB_SHA && env.GITHUB_SHA !== commit) throw new Error('Workflow source commit mismatch');
  const metadata = distributionMetadata({channel: env.MISSION_DISTRIBUTION_CHANNEL,
    tag: env.MISSION_DISTRIBUTION_TAG, commit, versions: readVersions(repoRoot)});
  const output = join(repoRoot, 'release/distribution');
  // Retrying publication uses the retained bytes. Rebuilding signed/timestamped
  // archives is not a reproducible-byte retry and must never silently replace them.
  if (existsSync(output)) throw new Error('Distribution output already exists; publish its original bytes or use a fresh checkout');
  // Compilation needs no signing credentials and its inherited output is public.
  const buildEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !/^(CSC_|APPLE_|GH_|GITHUB_TOKEN)/.test(key)));
  await stages.run('build', () => execFileSync('npm', ['run', 'build'], {cwd: repoRoot, stdio: 'inherit', env: buildEnv}));
  const {build, Platform, Arch} = await stages.run('build', () => import('electron-builder'));
  const {log} = await import('builder-util');
  // Builder can log credential-bearing error objects during retries before it
  // rejects. Its raw logger is not a diagnostic boundary. Emit our stage markers
  // and project the final rejection instead; DEBUG is disabled at the CLI entry.
  const buildQuietly = async (options) => {
    const stream = log.stream;
    log.stream = {write: () => true};
    try { return await build(options); } finally { log.stream = stream; }
  };
  const config = distributionBuilderConfig(metadata, env.CSC_NAME, output);
  await stages.run('build', () => buildQuietly({targets: Platform.MAC.createTarget(['dir'], Arch.arm64),
    config: {...config, afterPack: () => stages.enter('sign')}, publish: 'never'}));
  const app = join(output, 'mac-arm64', binaryBundleName(metadata));
  await stages.run('notarize (app)', () => notarizeDistribution(app, credentials, {env}));
  await stages.run('verifyDistributionApp', () => verifyDistributionApp(app, metadata, policy));
  await stages.run('qualifySignedRuntime', () => qualifySignedRuntime(app, metadata, policy));
  const before = await stages.run('archive verification', () => inspectBundle(app));
  // --prepackaged does not package/sign the app again. Both archives use these bytes.
  await stages.run('dmg build', () => buildQuietly({targets: Platform.MAC.createTarget(['dmg'], Arch.arm64), prepackaged: app, config, publish: 'never'}));
  const names = distributionNames(metadata);
  const dmg = join(output, names.dmg);
  await stages.run('notarize (dmg)', () => notarizeDistribution(dmg, credentials, {env}));
  await stages.run('archive verification', () => {
    verifyDistributionDmg(dmg, policy);
    if (inspectBundle(app).digest !== before.digest) throw new Error('The signed app changed during archive generation');
  });
  await stages.run('ditto', () => execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, join(output, names['app-zip'])],
    {timeout: 10 * 60_000, stdio: ['ignore', 'pipe', 'pipe']}));
  await stages.run('verifyDistributionApp', () => verifyDistributionApp(app, metadata, policy));
  const files = Object.fromEntries(Object.entries(names).map(([kind, name]) => [kind, join(output, name)]));
  await stages.run('archive verification', () => verifyDistributionArchives({app, files, metadata, policy}));
  await stages.run('metadata', async () => {
    const assets = await localDistributionAssets(metadata, files);
    writeFileSync(join(output, 'build-metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
    writeFileSync(join(output, 'qualification.json'), `${JSON.stringify({metadata, assets,
      appDigest: before.digest, teamId: policy.teamId, notarized: true, copiedRuntime: true,
      recovery: 'forward-only-after-receipt-commit'}, null, 2)}\n`);
  });
  console.log(`Qualified ${metadata.channel} ${metadata.commit}: signed/notarized app ZIP and DMG, copied runtime and MCP handshake`);
}

export async function runDistributionCli(produce = packageDistribution) {
  try {
    delete process.env.DEBUG;
    delete process.env.GH_DEBUG;
    // A static dependency may already have initialized debug before env deletion.
    const {default: debug} = await import('debug');
    debug.disable();
    binaryPublisherPolicy();
    await produce();
  } catch (error) {
    console.error(distributionFailure(error));
    preserveFailureExit();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runDistributionCli();
