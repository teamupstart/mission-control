import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess, { execFileSync, spawnSync } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import fs, { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishRenamedApp, renamedBundlePublicationCommand, reserveRenamedApp } from '../scripts/app-bundle-swap.mjs';
import { ensureNativeStateLockAddon } from './helpers/native-state-lock.ts';

const native = createRequire(import.meta.url)(ensureNativeStateLockAddon()) as {
  renameNoReplace(source: string, target: string): void;
};

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'rename-publication-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const target = join(root, 'Agent Mission Control.app');
  const staging = reserveRenamedApp(target);
  assert.equal(lstatSync(staging).mode & 0o777, 0o700);
  assert.equal(existsSync(target), false, 'reservation never writes the public app path');
  const source = join(staging, 'Agent Mission Control.app');
  mkdirSync(source); writeFileSync(join(source, 'sentinel'), 'candidate bytes'); chmodSync(source, 0o750);
  const stat = lstatSync(source);
  return {root, source, target, identity: `${stat.dev}:${stat.ino}`};
}

test('exclusive publication moves the private app with its identity and permissions intact', t => {
  const f = fixture(t);
  publishRenamedApp(f.source, f.target, f.identity);
  const stat = lstatSync(f.target);
  assert.equal(`${stat.dev}:${stat.ino}`, f.identity);
  assert.equal(stat.mode & 0o777, 0o750);
  assert.equal(readFileSync(join(f.target, 'sentinel'), 'utf8'), 'candidate bytes');
  assert.equal(existsSync(f.source), false);
});

for (const collision of ['empty directory', 'app', 'symlink', 'dangling symlink'] as const) {
  test(`exclusive publication refuses ${collision} arriving at the kernel publication boundary`, t => {
    const f = fixture(t);
    const foreign = join(f.root, 'foreign.app'); mkdirSync(foreign);
    writeFileSync(join(foreign, 'sentinel'), 'unrelated bytes');
    let inode: number | undefined;
    assert.throws(() => publishRenamedApp(f.source, f.target, f.identity, {rename(source, target) {
      if (collision === 'app') renameSync(foreign, target);
      else if (collision === 'empty directory') mkdirSync(target, {mode: 0o711});
      else symlinkSync(collision === 'symlink' ? foreign : join(f.root, 'absent'), target);
      inode = lstatSync(target).ino;
      native.renameNoReplace(source, target);
    }, runElevated: () => assert.fail('collisions never request administrator authorization')}), {code: 'EEXIST'});
    assert.equal(lstatSync(f.target).ino, inode, 'the occupied directory entry was never replaced');
    assert.equal(readFileSync(join(f.source, 'sentinel'), 'utf8'), 'candidate bytes');
    assert.equal(readFileSync(join(collision === 'app' ? f.target : foreign, 'sentinel'), 'utf8'), 'unrelated bytes');
    if (collision === 'empty directory') assert.deepEqual(readdirSync(f.target), []);
  });
}

test('a custom publication permission error cannot authorize system writes', t => {
  const f = fixture(t);
  assert.throws(() => publishRenamedApp(f.source, f.target, f.identity, {
    rename: () => {throw Object.assign(new Error('fixture permission refusal'), {code: 'ERENAME'});},
    runElevated: () => assert.fail('custom paths never elevate'),
  }), /fixture permission refusal/);
  assert.equal(readFileSync(join(f.source, 'sentinel'), 'utf8'), 'candidate bytes');
  assert.equal(existsSync(f.target), false);
});

for (const changed of ['destination', 'source'] as const) {
  test(`authorization command refuses a changed ${changed} after the prompt`, t => {
    const f = fixture(t);
    const command = renamedBundlePublicationCommand(f.source, f.target, f.identity);
    if (changed === 'destination') {
      mkdirSync(f.target); writeFileSync(join(f.target, 'sentinel'), 'foreign destination');
    } else {
      renameSync(f.source, join(f.root, 'verified.app'));
      mkdirSync(f.source); writeFileSync(join(f.source, 'sentinel'), 'foreign source');
    }
    const result = spawnSync('/bin/sh', ['-c', command], {encoding: 'utf8'});
    assert.equal(result.status, 1);
    assert.match(result.stderr, changed === 'destination' ? /EEXIST/ : /identity changed/);
    assert.equal(readFileSync(join(changed === 'destination' ? f.target : f.source, 'sentinel'), 'utf8'), `foreign ${changed}`);
    if (changed === 'source') assert.equal(existsSync(f.target), false);
  });
}

test('authorization command performs the same exclusive native publication without a host PATH', t => {
  const f = fixture(t);
  execFileSync('/bin/sh', ['-c', renamedBundlePublicationCommand(f.source, f.target, f.identity)], {
    env: {...process.env, PATH: '/deliberately-missing'}, stdio: 'pipe',
  });
  assert.equal(readFileSync(join(f.target, 'sentinel'), 'utf8'), 'candidate bytes');
  const stat = lstatSync(f.target);
  assert.equal(`${stat.dev}:${stat.ino}`, f.identity);
});

test('system staging and retry stay scoped to private material and exclusive publication', t => {
  const f = fixture(t);
  const target = '/Applications/Agent Mission Control.app';
  const staging = '/Applications/.mission-rename-staging-fixture';
  const source = join(staging, 'Agent Mission Control.app');
  const stagedStat = lstatSync(f.source);
  const directoryStat = lstatSync(f.root);
  const readStat = fs.lstatSync;
  t.mock.method(fs, 'mkdtempSync', () => {throw Object.assign(new Error('fixture permission denied'), {code: 'EACCES'});});
  t.mock.method(fs, 'lstatSync', ((path: fs.PathLike, options: unknown) => {
    if (String(path) === staging) return directoryStat;
    if (String(path) === source) return stagedStat;
    return readStat(path, options as {bigint?: false});
  }) as typeof fs.lstatSync);
  let authorization = '';
  t.mock.method(childProcess, 'execFileSync', ((_command: string, args: readonly string[]) => {
    authorization = args[2]!;
    return staging;
  }) as typeof childProcess.execFileSync);
  syncBuiltinESMExports();
  t.after(() => {t.mock.restoreAll(); syncBuiltinESMExports();});
  assert.equal(reserveRenamedApp(target), staging);
  assert.match(authorization, /mktemp -d '\/Applications\/\.mission-rename-staging-/);
  assert.equal(authorization.includes(target), false, 'authorization never creates or copies into the public name');
  let published = '';
  publishRenamedApp(source, target, f.identity, {
    rename: () => {throw Object.assign(new Error('permission denied'), {code: 'ERENAME'});},
    runElevated: command => {published = command;},
  });
  assert.equal(published, renamedBundlePublicationCommand(source, target, f.identity));
  assert.throws(() => publishRenamedApp(source, target, f.identity, {
    rename: () => {throw Object.assign(new Error('occupied'), {code: 'EEXIST'});},
    runElevated: () => assert.fail('a collision must not elevate'),
  }), {code: 'EEXIST'});
});

test('publication authorization uses embedded Electron with host runtimes trapped', {skip: process.platform !== 'darwin'}, t => {
  const f = fixture(t);
  const traps = join(f.root, 'traps'); mkdirSync(traps);
  const hits = join(f.root, 'trap-hits');
  for (const name of ['node', 'npm', 'npx']) {
    writeFileSync(join(traps, name), `#!/bin/sh\nprintf hit >> '${hits}'\nexit 93\n`, {mode: 0o755});
  }
  const electron = createRequire(import.meta.url)('electron') as string;
  const code = `
    const {execFileSync} = await import('node:child_process');
    const {renamedBundlePublicationCommand} = await import(${JSON.stringify(new URL('../scripts/app-bundle-swap.mjs', import.meta.url).href)});
    const command = renamedBundlePublicationCommand(${JSON.stringify(f.source)}, ${JSON.stringify(f.target)}, ${JSON.stringify(f.identity)});
    if (!process.versions.electron || !command.includes(process.execPath)) throw new Error('publication must use the embedded runtime');
    execFileSync('/bin/sh', ['-c', command], {stdio: 'pipe'});
    console.log('Exclusive publication child used embedded Electron ' + process.versions.electron);
  `;
  const output = execFileSync(electron, ['--input-type=module', '-e', code], {
    env: {...process.env, ELECTRON_RUN_AS_NODE: '1', HOME: f.root, MISSION_HOME: join(f.root, 'state'), PATH: traps}, encoding: 'utf8',
  });
  assert.match(output, /Exclusive publication child used embedded Electron/);
  assert.equal(readFileSync(join(f.target, 'sentinel'), 'utf8'), 'candidate bytes');
  assert.equal(existsSync(hits), false);
  console.log(output.trim() + '; no host Node/npm/npx invocations. Authorization shell executed without elevation in a temporary fixture.');
});
