import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

test('installed builder authenticates partition access with the generated keychain password', async (t) => {
  const require = createRequire(import.meta.url);
  const builderUtil = require('builder-util');
  const certificates = require('app-builder-lib/out/codeSign/codesign.js');
  const {createKeychain} = require('app-builder-lib/out/codeSign/macCodeSign.js');
  const commands: string[][] = [];
  t.mock.method(builderUtil, 'exec', async (command: string, args: string[]) => {
    assert.equal(command, '/usr/bin/security'); commands.push(args); return '';
  });
  t.mock.method(certificates, 'importCertificate', async () => '/fixture/certificate.p12');
  // Skip the unrelated root-certificate file copy. Every security command remains
  // intercepted; no keychain, credential, or native signing tool is accessed.
  const original = process.env.TRAVIS; process.env.TRAVIS = 'true';
  t.after(() => {if (original === undefined) delete process.env.TRAVIS; else process.env.TRAVIS = original;});
  await createKeychain({tmpDir: {}, cscLink: 'fake-certificate', cscKeyPassword: 'fake-import-password', currentDir: '/fixture'});
  const create = commands.find((args) => args[0] === 'create-keychain')!;
  const unlock = commands.find((args) => args[0] === 'unlock-keychain')!;
  const imported = commands.find((args) => args[0] === 'import')!;
  const partition = commands.find((args) => args[0] === 'set-key-partition-list')!;
  assert.equal(imported[imported.indexOf('-P') + 1], 'fake-import-password');
  // Compare as booleans so even this generated fixture password is never printed.
  assert.ok(create[2] !== 'fake-import-password');
  assert.ok(unlock[2] === create[2]);
  assert.ok(partition[partition.indexOf('-k') + 1] === create[2], 'partition ACL must use the keychain password, not the PKCS#12 import password');
});
