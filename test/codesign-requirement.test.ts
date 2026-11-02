import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { appPublisherRequirement, binaryPublisherPolicy, imagePublisherRequirement } from '../src/shared/binary-publisher-policy.mjs';

const {teamId} = binaryPublisherPolicy();
const requirements = {app: appPublisherRequirement(teamId), image: imagePublisherRequirement(teamId)};

// Spelled out rather than rebuilt from the helpers, so a weakened anchor, identifier or team
// fails here even though it would still compile and still miss /bin/ls below.
test('publisher requirements pin the Apple anchor, app identifier and Developer ID team', () => {
  assert.equal(teamId, 'S2FPCQK39Z');
  assert.equal(requirements.app, '=anchor apple generic and identifier "com.mission-control.app" and certificate leaf[subject.OU] = "S2FPCQK39Z"');
  assert.equal(requirements.image, '=anchor apple generic and certificate leaf[subject.OU] = "S2FPCQK39Z"');
});

// Exercise the shared formatter output directly; production verifiers and bootstrap
// argv are covered separately. /bin/ls is Apple-signed, so a compiled publisher
// requirement fails to match it (status 3) instead of failing to parse (status 1).
const verify = (requirement: string) =>
  spawnSync('/usr/bin/codesign', ['--verify', '-R', requirement, '/bin/ls'], {encoding: 'utf8', env: {...process.env, LC_ALL: 'C'}});

for (const [kind, requirement] of Object.entries(requirements)) {
  test(`codesign compiles the ${kind} publisher requirement as text`, {skip: process.platform !== 'darwin'}, () => {
    const result = verify(requirement);
    assert.doesNotMatch(result.stderr, /No such file or directory|invalid requirement specification/);
    assert.equal(result.status, 3, result.stderr);
  });
}

test('codesign reads an unprefixed requirement as a file path', {skip: process.platform !== 'darwin'}, () => {
  const result = verify(requirements.app.slice(1));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No such file or directory/);
});

test('the standalone installer carries the shared publisher requirements', () => {
  const shell = readFileSync(new URL('../scripts/install.sh', import.meta.url), 'utf8');
  for (const requirement of Object.values(requirements)) assert.ok(shell.includes(`-R '${requirement}'`), requirement);
});
