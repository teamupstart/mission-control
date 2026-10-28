import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeRenamedBundle, renamedBundleRemovalCommand } from '../scripts/app-bundle-swap.mjs';

const realOps = {
  identity: (path: string) => {
    const s = lstatSync(path);
    return s.isDirectory() && !s.isSymbolicLink() ? `${s.dev}:${s.ino}` : null;
  },
  makePrivateDirectory: mkdtempSync,
  move: renameSync,
  remove: (path: string) => rmSync(path, {recursive: true}),
  removeDirectory: rmdirSync,
};

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'rename-cleanup-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const app = join(root, 'Agent Mission Control.app');
  mkdirSync(app);
  writeFileSync(join(app, 'sentinel'), 'verified app');
  const stat = lstatSync(app);
  return {root, app, identity: `${stat.dev}:${stat.ino}`};
}

test('rename cleanup refuses a directory substituted after ownership verification', t => {
  const f = fixture(t);
  const retained = `${f.app}.verified`;
  renameSync(f.app, retained);
  mkdirSync(f.app);
  writeFileSync(join(f.app, 'sentinel'), 'unrelated app');
  assert.throws(() => removeRenamedBundle(f.app, f.identity), /identity changed/);
  assert.equal(readFileSync(join(f.app, 'sentinel'), 'utf8'), 'unrelated app');
  assert.ok(existsSync(retained));
});

test('rename cleanup deletes its verified capture and leaves a recreated public path intact', t => {
  const f = fixture(t);
  let capture = '';
  removeRenamedBundle(f.app, f.identity, {ops: {...realOps, move(from, to) {
    renameSync(from, to);
    capture = to;
    mkdirSync(from);
    writeFileSync(join(from, 'sentinel'), 'new public app');
    assert.equal(lstatSync(join(to, '..')).mode & 0o777, 0o700);
  }}});
  assert.equal(readFileSync(join(f.app, 'sentinel'), 'utf8'), 'new public app');
  assert.equal(existsSync(capture), false);
  assert.deepEqual(readdirSync(f.root), ['Agent Mission Control.app']);
});

for (const replacement of ['directory', 'symlink'] as const) {
  test(`rename cleanup retains a foreign ${replacement} raced into the atomic capture`, t => {
    const f = fixture(t);
    let captured = '';
    const saved = `${f.app}.verified`;
    assert.throws(() => removeRenamedBundle(f.app, f.identity, {ops: {...realOps, move(from, to) {
      renameSync(from, saved);
      if (replacement === 'directory') {
        mkdirSync(from); writeFileSync(join(from, 'sentinel'), 'foreign capture');
      } else symlinkSync(saved, from);
      renameSync(from, to);
      captured = to;
      // A restore must not replace this concurrent arrival, even when it is empty.
      mkdirSync(from);
    }}}), error => {
      assert.match(String(error), /identity changed/);
      assert.ok(String(error).includes(captured), 'report the retained location');
      return true;
    });
    assert.equal(readFileSync(join(saved, 'sentinel'), 'utf8'), 'verified app');
    assert.deepEqual(readdirSync(f.app), []);
    assert.equal(lstatSync(captured).isSymbolicLink(), replacement === 'symlink');
    assert.equal(readFileSync(join(captured, 'sentinel'), 'utf8'), replacement === 'directory' ? 'foreign capture' : 'verified app');
  });
}

test('custom cleanup retains a capture after permission failure without requesting elevation', t => {
  const f = fixture(t);
  let captured = '';
  assert.throws(() => removeRenamedBundle(f.app, f.identity, {
    ops: {...realOps, remove(path) {captured = path; throw Object.assign(new Error('fixture denied'), {code: 'EACCES'});}},
    runElevated: () => assert.fail('custom destinations never elevate'),
  }), /fixture denied/);
  assert.equal(readFileSync(join(captured, 'sentinel'), 'utf8'), 'verified app');
  assert.equal(existsSync(f.app), false);
});

for (const name of ['Mission Control.app', 'Agent Mission Control.app']) {
  for (const failure of ['reserve', 'delete'] as const) {
    test(`system cleanup ${name} after ${failure} denial elevates only a pinned capture transaction`, () => {
      const source = `/Applications/${name}`;
      const holding = '/Applications/.mission-rename-cleanup-fixture';
      const denied = () => {throw Object.assign(new Error('permission denied'), {code: 'EACCES'});};
      let command = '';
      removeRenamedBundle(source, '42:71', {
        ops: {identity: () => '42:71', makePrivateDirectory: failure === 'reserve' ? denied : () => holding,
          move: () => {}, remove: denied, removeDirectory: () => {}},
        runElevated: value => {command = value;},
      });
      assert.equal(command, renamedBundleRemovalCommand(failure === 'reserve' ? source : join(holding, 'bundle.app'), '42:71'));
      assert.ok(!command.includes(`/bin/rm -rf '${source}'`));
    });
  }
}

// Execute the actual macOS shell transaction against disposable paths. No osascript,
// administrator authorization or operator app is involved. Wrapping only mv lets the
// test interleave a competing replacement at the atomic filesystem boundary.
for (const race of ['none', 'prompt', 'capture', 'recreate'] as const) {
  test(`authorized cleanup transaction preserves identity across ${race} race`, {skip: process.platform !== 'darwin'}, t => {
    const f = fixture(t);
    const source = join(f.root, "app with 'quotes.app"); renameSync(f.app, source);
    const saved = join(f.root, 'verified.app');
    const quote = (text: string) => `'${text.replaceAll("'", `'"'"'`)}'`;
    let command = renamedBundleRemovalCommand(source, f.identity);
    if (race === 'prompt') {
      renameSync(source, saved); mkdirSync(source);
      writeFileSync(join(source, 'sentinel'), 'foreign after prompt');
    }
    if (race === 'capture' || race === 'recreate') {
      const wrapper = join(f.root, 'move-fixture.sh');
      writeFileSync(wrapper, '#!/bin/sh\nset -eu\n' + (race === 'capture'
        ? `/bin/mv "$1" ${quote(saved)}\n/bin/mkdir "$1"\nprintf foreign > "$1/sentinel"\n/bin/mv "$1" "$2"\n`
        : '/bin/mv "$1" "$2"\n/bin/mkdir "$1"\nprintf public > "$1/sentinel"\n'));
      chmodSync(wrapper, 0o700);
      command = command.replace('/bin/mv "$source"', `${quote(wrapper)} "$source"`);
    }
    const result = spawnSync('/bin/sh', ['-c', command], {encoding: 'utf8'});
    assert.equal(result.status, race === 'prompt' || race === 'capture' ? 1 : 0, result.stderr);
    if (race === 'none') assert.equal(existsSync(source), false);
    if (race === 'prompt') assert.equal(readFileSync(join(source, 'sentinel'), 'utf8'), 'foreign after prompt');
    if (race === 'recreate') assert.equal(readFileSync(join(source, 'sentinel'), 'utf8'), 'public');
    if (race === 'capture') {
      const holding = readdirSync(f.root).find(path => path.startsWith('.mission-rename-cleanup-'))!;
      const retained = join(f.root, holding, 'bundle.app');
      assert.equal(readFileSync(join(retained, 'sentinel'), 'utf8'), 'foreign');
      assert.ok(result.stderr.includes(retained));
    }
    if (race === 'prompt' || race === 'capture') assert.equal(readFileSync(join(saved, 'sentinel'), 'utf8'), 'verified app');
    if (race !== 'capture') assert.equal(readdirSync(f.root).some(path => path.startsWith('.mission-rename-cleanup-')), false);
  });
}

test('shell cleanup refuses a symlink without following it', {skip: process.platform !== 'darwin'}, t => {
  const f = fixture(t);
  const link = join(f.root, 'foreign-link.app'); symlinkSync(f.app, link);
  assert.throws(() => execFileSync('/bin/sh', ['-c', renamedBundleRemovalCommand(link, f.identity)], {stdio: 'pipe'}));
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(readFileSync(join(f.app, 'sentinel'), 'utf8'), 'verified app');
});
