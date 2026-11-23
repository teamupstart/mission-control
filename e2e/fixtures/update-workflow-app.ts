import { build, type Plugin } from 'esbuild';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFileSync, cpSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { createServer } from 'node:net';
import { prepareBinaryFixtureRuntime, createBinaryFixtureArchive } from '../../test/helpers/binary-update-detached.ts';
import type { DaemonHandle } from './daemon.ts';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

/** Full production main/daemon/preload/dashboard, in disposable complete Electron bundles.
 * Only release discovery, asset transport and Apple trust responses are fixture ports.
 * BASELINE_REF builds the same journey from a pinned pre-fix revision without editing source.
 */
export async function updateWorkflowApp(daemon: DaemonHandle) {
  await daemon.crash();
  const root = join(daemon.home, 'desktop-update');
  const installed = join(root, 'apps/Agent Mission Control.app');
  const candidate = join(root, 'payload/Agent Mission Control.app');
  mkdirSync(dirname(installed), { recursive: true });
  mkdirSync(dirname(candidate), { recursive: true });
  const electron = createRequire(import.meta.url)('electron') as string;
  execFileSync('/bin/cp', ['-R', resolve(dirname(electron), '../..'), installed]);
  rmSync(join(installed, 'Contents/Resources/default_app.asar'));
  renameSync(join(installed, 'Contents/MacOS/Electron'), join(installed, 'Contents/MacOS/Mission Control'));
  const plist = join(installed, 'Contents/Info.plist');
  for (const [key, value] of Object.entries({
    CFBundleExecutable: 'Mission Control', CFBundleIdentifier: 'com.mission-control.app',
    CFBundleShortVersionString: '1.26.0',
  })) {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
  }
  const resources = join(installed, 'Contents/Resources/app');
  mkdirSync(resources);
  for (const path of ['dist', 'scripts', 'src/shared', 'build', 'hooks', 'skills']) {
    cpSync(path, join(resources, path), { recursive: true });
  }
  const baseline = process.env.MC_E2E_UPDATE_BASELINE_REF;
  const baselineFiles = new Set([
    'src/main/index.ts', 'src/main/daemon-policy.ts', 'src/main/daemon.ts', 'src/main/utility-supervisor.ts',
    'src/server/index.ts', 'src/server/foreman/worker.ts', 'src/server/workflows/check-group.ts',
    'src/server/workflows/check-runtime.ts', 'src/server/workflows/check-spawn.ts',
    'src/server/workflows/check-supervisor.ts', 'src/server/workflows/checks.ts', 'src/server/workflows/engine.ts',
    'scripts/apply-update.mjs', 'scripts/install-migration.mjs', 'scripts/mac-app-lifecycle.mjs', 'scripts/migration-runtime.mjs',
  ]);
  // Isolate the old startup gate when reproducing the reopen failure. Keep the fixed
  // shutdown so the app can reach that journey with a running workflow check.
  if (process.env.MC_E2E_UPDATE_BASELINE_REOPEN === '1') {
    if (!baseline) throw new Error('The reopen baseline requires a pinned source revision');
    baselineFiles.clear();
    baselineFiles.add('scripts/migration-runtime.mjs');
  }
  const source = (path: string) => baseline && baselineFiles.has(path)
    ? execFileSync('git', ['show', `${baseline}:${path}`], { encoding: 'utf8' }) : readFileSync(path, 'utf8');
  if (baseline) for (const path of baselineFiles) {
    if (path.startsWith('scripts/')) writeFileSync(join(resources, path), source(path));
  }
  const plugin: Plugin = {
    name: 'isolated-update-release',
    setup(builder) {
      builder.onLoad({ filter: /\.(ts|mjs)$/ }, args => {
        const path = relative(process.cwd(), args.path);
        if (path !== 'src/main/updater.ts' && !(baseline && baselineFiles.has(path))) return;
        let contents = source(path);
        if (path === 'src/main/updater.ts') {
          contents = contents.replace('export function createDefaultUpdaterPort(', 'function fixtureDefaultUpdaterPort(');
          contents += `
          export function createDefaultUpdaterPort(options) {
            const port = fixtureDefaultUpdaterPort(options);
            return {...port,
              latestRelease: async () => {
                const binary = JSON.parse(readFileSync(${JSON.stringify(join(root, 'offer.json'))}, 'utf8'));
                return {binary, tagName:binary.manifest.releaseTag, name:'Workflow-safe update fixture',
                  body:'Test-owned complete app update', publishedAt:'2026-11-03T00:00:00Z', isDraft:false, isPrerelease:false};
              },
              stage: request => stageBinaryUpdate(request, {
                worker:join(dirname(options.helperSource),'../dist/main/update-binary-worker.cjs'),
                stateDirectory:options.stateDirectory, gh:${JSON.stringify(join(root, 'gh-fixture'))},
                env:process.env, log:port.log,
              }),
            };
          }
        `;
        }
        return { contents, loader: path.endsWith('.ts') ? 'ts' : 'js', resolveDir: dirname(args.path) };
      });
    },
  };
  const common = {
    bundle: true, platform: 'node' as const, target: 'node22', mainFields: ['module', 'main'],
    alias: { '@shared': './src/shared' }, plugins: [plugin],
  };
  await build({ ...common, entryPoints: ['src/main/index.ts'], format: 'cjs', external: ['electron'],
    outfile: join(resources, 'dist/main/index.cjs') });
  for (const [entry, outfile] of [['src/server/index.ts', 'index.mjs'], ['src/server/foreman/worker.ts', 'foreman-worker.mjs']]) {
    await build({
      ...common, entryPoints: [entry!], format: 'esm',
      banner: { js: "import{createRequire as __mcCreateRequire}from'node:module';const require=__mcCreateRequire(import.meta.url);" },
      outfile: join(resources, 'dist/server', outfile!),
    });
  }
  prepareBinaryFixtureRuntime(daemon.home, resources);
  const cdpPort = await freePort();
  const { MISSION_DEV_SERVER_URL: _dev, ...env } = daemon.desktopLaunchConfig().env;
  writeFileSync(join(root, 'orphan-worker.cjs'), "process.parentPort.postMessage('ready'); setInterval(() => {}, 1000);\n");
  writeFileSync(join(resources, 'fixture-main.cjs'), `
    const {app, Menu, dialog, utilityProcess} = require('electron');
    const fs = require('node:fs');
    app.setPath('userData', ${JSON.stringify(join(daemon.home, 'electron-profile'))});
    if (process.argv.includes('--fixture-orphan-host')) {
      app.whenReady().then(() => {
        const child = utilityProcess.fork(${JSON.stringify(join(root, 'orphan-worker.cjs'))}, [], {serviceName: 'mission-control-daemon'});
        child.once('message', () => fs.writeFileSync(${JSON.stringify(join(root, 'orphan-ready.json'))}, JSON.stringify({pid: child.pid})));
      });
      return;
    }
    fs.appendFileSync(${JSON.stringify(join(root, 'launches.jsonl'))}, JSON.stringify({pid:process.pid}) + '\\n');
    const showErrorBox = dialog.showErrorBox;
    dialog.showErrorBox = (title, content) => {
      fs.appendFileSync(${JSON.stringify(join(root, 'native-errors.jsonl'))}, JSON.stringify({title,content}) + '\\n');
      return showErrorBox(title, content);
    };
    app.on('before-quit', () => fs.writeFileSync(${JSON.stringify(join(root, 'quit-requested'))}, 'quitting'));
    fs.watchFile(${JSON.stringify(join(root, 'request-update'))}, {interval:100}, (current,previous) => {
      if(current.mtimeMs === previous.mtimeMs) return;
      const item = Menu.getApplicationMenu()?.items.flatMap(menu => menu.submenu?.items ?? []).find(item => item.label === 'Check for Updates…');
      if(item) item.click();
    });
    Object.assign(process.env, ${JSON.stringify(env)});
    delete process.env.ELECTRON_RUN_AS_NODE;
    app.commandLine.appendSwitch('remote-debugging-port', '${cdpPort}');
    import('./fixture-native-trust.mjs').then(() => require('./dist/main/index.cjs'));
  `);
  const pkg = {
    name: 'mission-control', version: '1.26.0', main: 'fixture-main.cjs', missionCommit: 'a'.repeat(40),
    missionInstallMigration: { protocol: 1, automatic: true },
    missionInstallTransaction: { protocol: 1, appNaming: 1, receiptSchemas: [1, 2] },
  };
  writeFileSync(join(resources, 'package.json'), JSON.stringify(pkg));
  execFileSync('/bin/cp', ['-R', installed, candidate]);
  writeFileSync(join(candidate, 'Contents/Resources/app/package.json'), JSON.stringify({ ...pkg, missionCommit: 'b'.repeat(40) }));
  const offer = createBinaryFixtureArchive(root, candidate);
  // Archive creation stamps the candidate's release identity in both package and
  // plist. Verify the finished bundles, not the initial copy's inherited version.
  const versions = Object.fromEntries([['installed', installed], ['candidate', candidate]].map(([name, bundle]) => [name, {
    package: JSON.parse(readFileSync(join(bundle!, 'Contents/Resources/app/package.json'), 'utf8')).version,
    plist: execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString',
      join(bundle!, 'Contents/Info.plist')], {encoding: 'utf8'}).trim(),
  }]));
  assert.deepEqual(versions, {installed: {package: '1.26.0', plist: '1.26.0'},
    candidate: {package: '1.26.1', plist: '1.26.1'}});
  assert.equal(offer.manifest.version, versions.candidate.package);
  console.log('Verified fixture bundle versions:', JSON.stringify(versions));
  writeFileSync(join(root, 'offer.json'), JSON.stringify(offer));
  const receipt = {
    schema: 1, repo: 'teamupstart/mission-control', releaseTag: 'v1.26.0', installedVersion: '1.26.0', installedCommit: 'a'.repeat(40),
    sourceClone: join(root, 'unused-source'), appPath: installed, installedAt: '2026-11-03T00:00:00.000Z', installScope: 'user',
  };
  writeFileSync(join(daemon.home, 'install-receipt.json'), JSON.stringify(receipt));
  copyFileSync(join(daemon.home, 'install-receipt.json'), join(root, 'original-receipt.json'));
  return { root, installed, cdpPort, baseline };
}
