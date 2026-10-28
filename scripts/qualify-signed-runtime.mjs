// Run against final signed bytes. The only app paths touched are fresh temporary
// copies; the deliberate missing-source failure prevents GUI/daemon/state startup.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { boundedMigrationWait } from './migration-runtime.mjs';
import { processIdentity, processIsAlive } from './update-lock.mjs';
import { verifyDistributionApp } from './verify-distribution.mjs';

async function mcpHandshake(executable, server, env) {
  const child = spawn(executable, [server], {env, stdio: ['pipe', 'pipe', 'pipe']});
  const closed = new Promise((done) => {child.once('close', done); child.once('error', done);});
  child.stderr.resume();
  let timer;
  try {
    await new Promise((done, reject) => {
      timer = setTimeout(() => reject(new Error('Copied-runtime MCP handshake timed out')), 30_000);
      child.once('error', reject);
      child.once('exit', () => reject(new Error('Copied-runtime MCP exited during handshake')));
      child.stdin.on('error', reject);
      const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
      let pending = '';
      child.stdout.on('data', (chunk) => {
        pending += chunk;
        if (pending.length > 1024 * 1024) return reject(new Error('MCP response exceeded the probe limit'));
        for (;;) {
          const end = pending.indexOf('\n');
          if (end < 0) break;
          const line = pending.slice(0, end); pending = pending.slice(end + 1);
          try {
            const response = JSON.parse(line);
            if (response.error) return reject(new Error('MCP refused the qualification handshake'));
            if (response.id === 1) {
              assert.ok(response.result?.serverInfo);
              send({jsonrpc: '2.0', method: 'notifications/initialized'});
              send({jsonrpc: '2.0', id: 2, method: 'tools/list', params: {}});
            } else if (response.id === 2) {
              assert.ok(response.result?.tools?.some((tool) => tool.name === 'request_input'));
              done();
            }
          } catch { reject(new Error('Invalid MCP qualification response')); }
        }
      });
      send({jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-06-18', capabilities: {},
        clientInfo: {name: 'mission-signed-runtime-qualification', version: '1'}}});
    });
  } finally {
    clearTimeout(timer);
    child.kill('SIGKILL');
    await closed;
  }
}

export async function qualifySignedRuntime(app, metadata, policy) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mission-signed-runtime-')));
  let helper;
  let parent;
  try {
    const original = join(root, 'Agent Mission Control.app');
    execFileSync('/bin/cp', ['-R', app, original]);
    // Preserve download quarantine through both copies and assess it. A separate
    // clean-account GUI test is still required for first-install Gatekeeper UX.
    execFileSync('/usr/bin/xattr', ['-w', 'com.apple.quarantine', '0083;00000000;MissionControlQualification;', original]);
    await verifyDistributionApp(original, metadata, policy);
    // A Node-mode executable is deliberately not a LaunchServices foreground
    // app. Keep the probe parent outside the install path so production launch
    // conflict detection remains intact while the helper waits for its PID.
    const parentRuntime = join(root, 'Parent.app');
    execFileSync('/bin/cp', ['-R', original, parentRuntime]);
    await verifyDistributionApp(parentRuntime, metadata, policy);
    const state = join(root, 'state'); mkdirSync(state);
    const traps = join(root, 'traps'); mkdirSync(traps);
    for (const command of ['node', 'npm', 'npx']) {
      writeFileSync(join(traps, command), '#!/bin/sh\nprintf "%s\\n" "$0" >> "$MISSION_RUNTIME_TRAPS"\nexit 97\n', {mode: 0o755});
    }
    const env = {...process.env, MISSION_HOME: state, PATH: `${traps}:/usr/bin:/bin`,
      MISSION_RUNTIME_TRAPS: join(root, 'trap-hits'), ELECTRON_RUN_AS_NODE: '1'};
    delete env.NODE_OPTIONS; delete env.NODE_PATH; delete env.FLEET_HOME; delete env.HARNESS_HOME;
    for (const key of Object.keys(env)) {
      if (/^(CSC_|APPLE_|GH_|GITHUB_)/.test(key)) delete env[key];
    }
    parent = spawn(join(parentRuntime, 'Contents/MacOS/Mission Control'), [fileURLToPath(import.meta.url), '--parent', root],
      {env, stdio: ['ignore', 'pipe', 'pipe']});
    parent.stdout.resume(); parent.stderr.resume();
    const parentDeadline = setTimeout(() => parent.kill('SIGKILL'), 180_000);
    let exit;
    try { exit = await new Promise((done, reject) => {parent.once('error', reject); parent.once('exit', done);}); }
    finally { clearTimeout(parentDeadline); }
    assert.equal(exit, 0, 'The signed parent must acknowledge its detached helper before exiting');
    const handed = JSON.parse(readFileSync(join(root, 'handoff.json'), 'utf8'));
    const owner = JSON.parse(readFileSync(join(handed.directory, 'owner.json'), 'utf8'));
    helper = owner.helper;
    assert.equal(processIsAlive(handed.parentPid), false);
    assert.equal(existsSync(original), false, 'The original app path must disappear');
    await boundedMigrationWait(() => {
      const path = join(state, 'update-outcome.json');
      if (!existsSync(path)) return false;
      const outcome = JSON.parse(readFileSync(path, 'utf8'));
      return outcome.result === 'failure' && /installed app is missing before the update/.test(outcome.message);
    }, 'The detached signed helper did not finish after parent/original removal', {timeout: 45_000});
    await boundedMigrationWait(() => !processIsAlive(helper.pid), 'The signed helper did not exit', {timeout: 10_000});
    const runtime = join(handed.directory, 'Runtime.app');
    await verifyDistributionApp(runtime, metadata, policy);
    const runtimeInfo = JSON.parse(execFileSync(join(runtime, 'Contents/MacOS/Mission Control'),
      ['-e', 'console.log(JSON.stringify({electron:process.versions.electron,node:process.versions.node}))'], {env, encoding: 'utf8', timeout: 30_000}));
    assert.ok(runtimeInfo.electron);
    assert.ok(Number(runtimeInfo.node.split('.')[0]) >= 24);
    await mcpHandshake(join(runtime, 'Contents/MacOS/Mission Control'), join(runtime, 'Contents/Resources/app/dist/mcp/server.mjs'), env);
    assert.equal(existsSync(join(root, 'trap-hits')), false, 'Host runtime traps must never execute');
    console.log(`Signed-runtime qualification ${metadata.commit}: signature/staple/fuses retained; parent exited; original path retired; shipped detached helper recorded expected pre-swap failure; shipped MCP initialize/tools-list passed; no node/npm/npx trap hit.`);
  } finally {
    if (parent?.exitCode === null && parent.signalCode === null) {
      parent.kill('SIGKILL');
      await boundedMigrationWait(() => !parent.pid || !processIsAlive(parent.pid), 'Probe parent could not be stopped', {timeout: 10_000});
    }
    // A parent can fail between spawning and writing handoff.json. Inspect its
    // attempt-owned records before reclaiming any possibly mapped runtime.
    const attempts = join(root, 'state/update-runtimes');
    for (const name of existsSync(attempts) ? readdirSync(attempts) : []) {
      const owner = JSON.parse(readFileSync(join(attempts, name, 'owner.json'), 'utf8'));
      const readyPath = join(attempts, name, 'ready.json');
      const record = owner.helper ?? (existsSync(readyPath) ? JSON.parse(readFileSync(readyPath, 'utf8')) : null);
      if (!record?.identity) throw new Error('Probe retained its temporary runtime because helper ownership is unknown');
      if (processIsAlive(record.pid)) {
        if (processIdentity(record.pid) !== record.identity) throw new Error('Probe retained its temporary runtime because process identity changed');
        process.kill(record.pid, 'SIGKILL');
        await boundedMigrationWait(() => !processIsAlive(record.pid), 'Probe helper could not be stopped', {timeout: 10_000});
      }
    }
    rmSync(root, {recursive: true, force: true});
  }
}

if (process.argv[2] === '--parent') {
  const root = process.argv[3];
  const original = join(root, 'Agent Mission Control.app');
  const appRoot = join(original, 'Contents/Resources/app');
  const {spawnBundledUpdateHelper} = await import(pathToFileURL(join(appRoot, 'scripts/update-helper-runtime.mjs')).href);
  const state = join(root, 'state');
  const logPath = join(state, 'qualification.log');
  const directory = await spawnBundledUpdateHelper({runtimeBundle: original,
    helperSource: join(appRoot, 'scripts/apply-update.mjs'), stateDirectory: state, parentPid: process.pid, logPath,
    argv: ['--source-clone', join(root, 'nonexistent-source'), '--target-tag', 'v1.0.0', '--app-path', original,
      '--parent-pid', String(process.pid), '--state-dir', state, '--log-path', logPath]});
  writeFileSync(join(root, 'handoff.json'), JSON.stringify({directory, parentPid: process.pid}));
  renameSync(original, join(root, 'Retired.app'));
}
