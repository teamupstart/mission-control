import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, renameSync, linkSync, openSync, writeSync, closeSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishIntegrationText, verifyIntegrationBackups } from '../src/main/migration-integration-file.ts';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'mission-integration-file-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const path = join(root, 'config.json');
  writeFileSync(path, 'original');
  return {path, nonce: randomBytes(32).toString('hex')};
}

test('an edit after comparison is retained and never replaced by migration', (t) => {
  const f = fixture(t);
  assert.throws(() => publishIntegrationText(f.path, f.nonce, 'original', 'migrated', {
    rename: (from, to) => { writeFileSync(from, 'user edit'); renameSync(from, to); }, link: linkSync,
  }), /preserved/);
  assert.equal(readFileSync(f.path, 'utf8'), 'user edit');
});

test('a concurrent replacement wins the path without losing either file', (t) => {
  const f = fixture(t);
  let backup = '';
  assert.throws(() => publishIntegrationText(f.path, f.nonce, 'original', 'migrated', {
    rename: (from, to) => { backup = String(to); renameSync(from, to); },
    link: (from, to) => { writeFileSync(to, 'editor replacement'); linkSync(from, to); },
  }), /preserved/);
  assert.equal(readFileSync(f.path, 'utf8'), 'editor replacement');
  assert.equal(readFileSync(backup, 'utf8'), 'original');
});

test('late writes through an open editor fd remain recoverable and invalidate retry verification', (t) => {
  const f = fixture(t);
  const fd = openSync(f.path, 'r+');
  t.after(() => closeSync(fd));
  publishIntegrationText(f.path, f.nonce, 'original', 'migrated');
  assert.equal(readFileSync(f.path, 'utf8'), 'migrated');
  verifyIntegrationBackups(f.path, f.nonce);
  writeSync(fd, 'EDIT', 0, 'utf8');
  assert.throws(() => verifyIntegrationBackups(f.path, f.nonce), /concurrent integration edit.*preserved/);
});

test('retry restores an original displaced before publication', (t) => {
  const f = fixture(t);
  assert.throws(() => publishIntegrationText(f.path, f.nonce, 'original', 'migrated', {
    rename: (from, to) => { renameSync(from, to); throw new Error('process died'); }, link: linkSync,
  }), /process died/);
  verifyIntegrationBackups(f.path, f.nonce);
  assert.equal(readFileSync(f.path, 'utf8'), 'original');
  publishIntegrationText(f.path, f.nonce, 'original', 'migrated');
  assert.equal(readFileSync(f.path, 'utf8'), 'migrated');
});
