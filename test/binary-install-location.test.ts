import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertPersistentDestination, temporaryInstallLocation } from '../scripts/binary-install-policy.mjs';

function inventory(t: test.TestContext, read: () => string) {
  const query = t.mock.method(childProcess, 'execFileSync', ((command: string, args: readonly string[], options: childProcess.ExecFileSyncOptions) => {
    if (command === '/usr/bin/hdiutil') {
      assert.deepEqual(args, ['info', '-plist']);
      return 'fixture plist';
    }
    assert.equal(command, '/usr/bin/plutil');
    assert.deepEqual(args, ['-convert', 'json', '-o', '-', '-']);
    assert.equal(options.input, 'fixture plist');
    return read();
  }) as typeof childProcess.execFileSync);
  syncBuiltinESMExports();
  t.after(() => {query.mock.restore(); syncBuiltinESMExports();});
}

function fixture(t: test.TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'binary-mount-location-')));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const mount = join(root, 'MC-image');
  const app = join(mount, 'Mission Control.app'); mkdirSync(app, {recursive: true});
  return {root, mount, app};
}

test('custom image mountpoints are temporary and refuse installation destinations outside /Volumes', t => {
  const f = fixture(t);
  inventory(t, () => JSON.stringify({images: [{'system-entities': [{'mount-point': f.mount}]}]}));
  assert.equal(temporaryInstallLocation(f.app), true);
  assert.equal(temporaryInstallLocation(f.mount), true);
  assert.throws(() => assertPersistentDestination(f.app), /mounted image/);
});

test('mount membership resolves aliases on both the app and the mounted-image path', t => {
  const f = fixture(t);
  const alias = join(f.root, 'image-alias'); symlinkSync(f.mount, alias);
  let reportedMount = f.mount;
  inventory(t, () => JSON.stringify({images: [{'system-entities': [{'mount-point': reportedMount}]}]}));
  assert.equal(temporaryInstallLocation(join(alias, 'Mission Control.app')), true);
  reportedMount = alias;
  assert.equal(temporaryInstallLocation(f.app), true);
});

test('persistent directories and external disks remain allowed beside mounted-image prefixes', t => {
  const f = fixture(t);
  inventory(t, () => JSON.stringify({images: [{'system-entities': [{'mount-point': f.mount}, {'mount-point': '/Volumes/MC-image'}]}]}));
  for (const path of [f.root, `${f.mount}-persistent/Mission Control.app`, '/Applications/Mission Control.app', '/Volumes/External/Apps/Mission Control.app', '/Volumes/MC-image-persistent/Mission Control.app']) {
    assert.equal(temporaryInstallLocation(path), false, path);
    assert.doesNotThrow(() => assertPersistentDestination(path));
  }
  assert.equal(temporaryInstallLocation('/Volumes/MC-image/Mission Control.app'), true);
});

test('unavailable or malformed mounted-image inventory cannot authorize an ordinary destination', t => {
  let response: () => string = () => {throw new Error('image inventory unavailable');};
  inventory(t, () => response());
  assert.throws(() => temporaryInstallLocation('/Applications/Mission Control.app'), /image inventory unavailable/);
  response = () => '{"images":null}';
  assert.throws(() => temporaryInstallLocation('/Applications/Mission Control.app'), /Cannot determine/);
});
