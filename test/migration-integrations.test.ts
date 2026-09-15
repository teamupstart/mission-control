// Real JSONC/TOML files plus a read-only CLI port prove owned-path edits preserve
// comments, custom options, disabled registrations and concurrent human changes.
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'jsonc-parser';
import { inspectMigrationIntegrations, repairMigrationIntegrations, type MigrationIntegrationPorts } from '../src/main/migration-integrations.ts';
import type { MigrationPlan, MigrationJournal } from '../scripts/install-migration.mjs';

function fixture(t: test.TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'mission-integrations-'));
  t.after(() => rmSync(home, {recursive: true, force: true}));
  const plan = {nonce: randomBytes(32).toString('hex'), source: '/Applications/Mission Control.app', target: join(home, 'Applications/Mission Control.app')} as MigrationPlan;
  const oldHook = `${plan.source}/Contents/Resources/app/dist/satellites/hook.mjs`;
  const oldMcp = `${plan.source}/Contents/Resources/app/dist/mcp/server.mjs`;
  const oldExe = `${plan.source}/Contents/MacOS/Mission Control`;
  const hook = `ELECTRON_RUN_AS_NODE=1 "${oldExe}" "${oldHook}" Stop`;
  mkdirSync(join(home, '.claude'));
  writeFileSync(join(home, '.claude/settings.json'), `{// retain this comment\n"hooks":{"Stop":[{"hooks":[{"type":"command","command":${JSON.stringify(hook)}},{"type":"command","command":"echo mine"}]}]},"theme":"dark"}`);
  writeFileSync(join(home, '.claude.json'), JSON.stringify({mcpServers: {'mission-control': {type: 'stdio', command: oldExe, args: [oldMcp], env: {ELECTRON_RUN_AS_NODE:'1', CUSTOM:'keep'}, customOption: 'keep'}, mine: {command: 'other'}}}));
  const calls: string[] = [];
  let login = false;
  const ports: MigrationIntegrationPorts = {
    home,
    command: () => { throw new Error('No CLI should be queried without its configuration'); },
    login: () => ({openAtLogin: login, executableWillLaunchAtLogin: login}),
    retargetLogin: async (_plan, value) => { login = value; calls.push(`login:${value}`); },
    skills: async () => { calls.push('skills'); return []; },
  };
  const journal = (): MigrationJournal => ({plan, owner: {pid: 1, identity: 'fixture'}, ownerRole: 'recovery', stage: 'receipt-committed', repairs: [], targetProcess: null, inventory: inspectMigrationIntegrations(plan, ports)});
  return {home, plan, oldMcp, oldExe, hook, ports, calls, journal};
}

test('repairs existing hooks and MCP, preserves JSONC/custom values, Electron fallback and login off', async (t) => {
  const f = fixture(t);
  const journal = f.journal();
  const results = await repairMigrationIntegrations(journal, f.ports);
  assert.ok(results.every((r) => r.status === 'complete'));
  const text = readFileSync(join(f.home, '.claude/settings.json'), 'utf8');
  assert.match(text, /retain this comment/);
  const cfg = parse(text);
  assert.equal(cfg.hooks.Stop[0].hooks[0].command, f.hook.replaceAll(f.plan.source, f.plan.target));
  assert.equal(cfg.hooks.Stop[0].hooks[1].command, 'echo mine');
  const mcp = JSON.parse(readFileSync(join(f.home, '.claude.json'), 'utf8'));
  assert.equal(mcp.mcpServers['mission-control'].command, `${f.plan.target}/Contents/MacOS/Mission Control`);
  assert.equal(mcp.mcpServers['mission-control'].customOption, 'keep');
  assert.deepEqual(mcp.mcpServers['mission-control'].env, {ELECTRON_RUN_AS_NODE: '1', CUSTOM: 'keep'});
  assert.equal(mcp.mcpServers.mine.command, 'other');
  assert.deepEqual(f.calls, ['skills', 'login:false']);
  const before = text;
  await repairMigrationIntegrations({...journal, repairs: results}, f.ports);
  assert.equal(readFileSync(join(f.home, '.claude/settings.json'), 'utf8'), before);
  assert.deepEqual(f.calls, ['skills', 'login:false', 'skills', 'login:false'], 'every retry verifies current surfaces');
});

test('absent and custom registrations remain absent/custom and concurrent hook edits are preserved', async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.home, '.claude.json'), '{"mcpServers":{"mission-control":{"command":"custom","args":["custom.mjs"]}}}');
  const journal = f.journal();
  const path = join(f.home, '.claude/settings.json');
  const edited = readFileSync(path, 'utf8').replace(' Stop', ' Start');
  writeFileSync(path, edited);
  const results = await repairMigrationIntegrations(journal, f.ports);
  assert.equal(results.find((r) => r.id === 'hooks')?.status, 'pending');
  assert.equal(readFileSync(path, 'utf8'), edited);
  assert.equal(JSON.parse(readFileSync(join(f.home, '.claude.json'), 'utf8')).mcpServers['mission-control'].command, 'custom');
});

test('retry revalidates completed hooks and MCP after another surface failed', async (t) => {
  const f = fixture(t);
  const journal = f.journal();
  f.ports.skills = async () => ['conflict'];
  journal.repairs = await repairMigrationIntegrations(journal, f.ports);
  assert.equal(journal.repairs.find((r) => r.id === 'hooks')?.status, 'complete');
  const path = join(f.home, '.claude/settings.json');
  const custom = readFileSync(path, 'utf8').replace(' Stop', ' Start');
  writeFileSync(path, custom);
  const mcpPath = join(f.home, '.claude.json');
  const mcp = JSON.parse(readFileSync(mcpPath, 'utf8'));
  mcp.mcpServers['mission-control'].args = ['custom.mjs'];
  writeFileSync(mcpPath, JSON.stringify(mcp));
  f.ports.skills = async () => [];
  const retried = await repairMigrationIntegrations(journal, f.ports);
  assert.deepEqual(retried.filter((r) => r.status === 'pending').map((r) => r.id), ['hooks', 'mcp:claude']);
  assert.equal(readFileSync(path, 'utf8'), custom);
  assert.deepEqual(JSON.parse(readFileSync(mcpPath, 'utf8')), mcp);
});

test('MCP inventory excludes credentials while repair preserves them in the original configuration', async (t) => {
  const f = fixture(t);
  const path = join(f.home, '.claude.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  const entry = config.mcpServers['mission-control'];
  entry.env.API_TOKEN = 'fixture-private-token-do-not-persist';
  entry.env.PATH_SHAPED_SECRET = `${f.plan.source}/private-fixture-value`;
  entry.args.push('--credential', 'fixture-private-argument');
  writeFileSync(path, JSON.stringify(config));
  const journal = f.journal();
  const serialized = JSON.stringify(journal.inventory);
  assert.ok(!serialized.includes(entry.env.API_TOKEN));
  assert.ok(!serialized.includes('fixture-private-argument'));
  assert.ok(!serialized.includes('API_TOKEN'));
  assert.ok(!serialized.includes('private-fixture-value'));
  const results = await repairMigrationIntegrations(journal, f.ports);
  assert.ok(results.every((r) => r.status === 'complete'));
  const repaired = JSON.parse(readFileSync(path, 'utf8')).mcpServers['mission-control'];
  assert.equal(repaired.env.API_TOKEN, entry.env.API_TOKEN);
  assert.equal(repaired.env.PATH_SHAPED_SECRET, entry.env.PATH_SHAPED_SECRET);
  assert.deepEqual(repaired.args, [f.oldMcp.replace(f.plan.source, f.plan.target), '--credential', 'fixture-private-argument']);
  assert.ok((await repairMigrationIntegrations({...journal, repairs: results}, f.ports)).every((r) => r.status === 'complete'));
});

test('persisted MCP comparison facts do not depend on secret values, even for low-entropy credentials', (t) => {
  const f = fixture(t);
  const path = join(f.home, '.claude.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  const facts = (secret: string) => {
    config.mcpServers['mission-control'].env.PASSWORD = secret;
    config.mcpServers['mission-control'].args = [f.oldMcp, '--password', secret];
    writeFileSync(path, JSON.stringify(config));
    const inventory = inspectMigrationIntegrations(f.plan, f.ports);
    return inventory.mcp.map(({revision: _revision, ...facts}) => facts);
  };
  assert.deepEqual(facts('1234'), facts('5678'));
});

test('a credential edit after inventory is preserved and blocks automatic MCP repair', async (t) => {
  const f = fixture(t);
  const journal = f.journal();
  const path = join(f.home, '.claude.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  config.mcpServers['mission-control'].env.PASSWORD = 'new-private-value';
  const changed = JSON.stringify(config);
  writeFileSync(path, changed);
  const results = await repairMigrationIntegrations(journal, f.ports);
  assert.equal(results.find((r) => r.id === 'mcp:claude')?.status, 'pending');
  assert.equal(readFileSync(path, 'utf8'), changed);
});

test('integration policy consumes normalized snapshots without reaching filesystem or CLI access', async (t) => {
  const f = fixture(t);
  f.ports.home = join(f.home, 'does-not-exist');
  let entry = {command: f.oldExe, args: [f.oldMcp], env: {SECRET: 'preserve'}};
  let writes = 0;
  f.ports.config = {
    readHooks: () => ({entries: [], revision: 'missing'}),
    writeHooks: () => {throw new Error('No hooks were inventoried');},
    readMcp: (spec) => ({registration: spec.migration.kind === 'jsonc' ? entry : null, revision: '1:2:3:4:5'}),
    writeMcp: (_spec, _nonce, _before, desired) => {
      writes++;
      entry = {...desired, env: {...desired.env, SECRET: 'preserve'}};
      return {registration: entry, revision: '1:6:7:8:9'};
    },
  };
  const results = await repairMigrationIntegrations(f.journal(), f.ports);
  assert.ok(results.every((result) => result.status === 'complete'));
  assert.equal(writes, 1);
  assert.equal(entry.args[0], f.oldMcp.replace(f.plan.source, f.plan.target));
  assert.equal(entry.env.SECRET, 'preserve');
});

test('the CLI-backed TOML adapter preserves registration options and reads back changed paths', async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.home, '.codex'));
  const path = join(f.home, '.codex/config.toml');
  writeFileSync(path, `# configuration\n[mcp_servers.mission-control]\ncommand = "/custom/node"\nargs = [${JSON.stringify(f.oldMcp)}] # old script ${JSON.stringify(f.oldMcp)}\ntool_timeout_sec = 123\ndescription = ${JSON.stringify(f.oldMcp)}\n[mcp_servers.mission-control.env]\nCUSTOM = "preserve"\n[mcp_servers.unrelated]\ncommand = ${JSON.stringify(f.oldExe)}\n`);
  let reads = 0;
  f.ports.command = (_spec, args) => {
    assert.deepEqual(args, ['mcp', 'list', '--json']);
    reads++;
    const text = readFileSync(path, 'utf8');
    const script = text.includes(`args = [${JSON.stringify(f.oldMcp)}]`) ? f.oldMcp : f.oldMcp.replace(f.plan.source, f.plan.target);
    return JSON.stringify([{name: 'mission-control', enabled: true, transport: {type: 'stdio', command: '/custom/node', args: [script], env: {CUSTOM:'preserve'}}}]);
  };
  const results = await repairMigrationIntegrations(f.journal(), f.ports);
  assert.equal(results.find((r) => r.id === 'mcp:codex')?.status, 'complete');
  const after = readFileSync(path, 'utf8');
  assert.match(after, /tool_timeout_sec = 123/);
  assert.match(after, /# configuration/);
  assert.ok(after.includes(`description = ${JSON.stringify(f.oldMcp)}`));
  assert.ok(after.includes(`# old script ${JSON.stringify(f.oldMcp)}`));
  assert.ok(after.includes(`command = ${JSON.stringify(f.oldExe)}`), 'unrelated table keeps its old executable');
  assert.equal(reads, 3);
});

test('a CLI snapshot cannot inventory a configuration that changed while the CLI read it', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.home, '.codex'));
  const path = join(f.home, '.codex/config.toml');
  writeFileSync(path, '# before');
  f.ports.command = () => {
    writeFileSync(path, '# concurrent replacement');
    return JSON.stringify([{name: 'mission-control', transport: {command: 'node', args: [f.oldMcp]}}]);
  };
  assert.throws(() => f.journal(), /changed while its CLI was reading/);
  assert.equal(readFileSync(path, 'utf8'), '# concurrent replacement');
});

test('disabled registrations stay disabled, null CLI env is accepted, and custom TOML is preserved on repair failure', async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.home, '.codex'));
  const path = join(f.home, '.codex/config.toml');
  const original = `[mcp_servers.mission-control]\ncommand = "node"\nargs = [\n  ${JSON.stringify(f.oldMcp)}\n]\n`;
  writeFileSync(path, original);
  let enabled = false;
  f.ports.command = () => JSON.stringify([{name: 'mission-control', enabled, transport: {command: 'node', args: [f.oldMcp], env: null}}]);
  assert.equal((f.journal().inventory as {mcp: {id: string}[]}).mcp.some((r) => r.id === 'mcp:codex'), false);
  enabled = true;
  const results = await repairMigrationIntegrations(f.journal(), f.ports);
  assert.equal(results.find((r) => r.id === 'mcp:codex')?.status, 'pending');
  assert.equal(readFileSync(path, 'utf8'), original);
});

test('linked configuration and malformed persisted hook paths cannot overwrite custom files', async (t) => {
  const f = fixture(t);
  const journal = f.journal();
  (journal.inventory as {hooks: {path: string[]}[]}).hooks[0]!.path = ['theme'];
  await assert.rejects(repairMigrationIntegrations(journal, f.ports), /inventory is invalid/);
  assert.deepEqual(f.calls, []);
  const path = join(f.home, '.claude.json');
  const contents = readFileSync(path, 'utf8');
  const linked = join(f.home, 'linked.json');
  writeFileSync(linked, contents);
  rmSync(path);
  symlinkSync(linked, path);
  assert.throws(() => f.journal(), /custom link/);
  assert.equal(readFileSync(linked, 'utf8'), contents);
});

test('a custom CLI configuration home cannot inventory one file and write a different default file', (t) => {
  const f = fixture(t);
  f.ports.environment = {CODEX_HOME: join(f.home, 'custom-codex')};
  assert.throws(() => f.journal(), /custom configuration home/);
  assert.deepEqual(f.calls, []);
});

test('inventory failures block before the move; skill conflicts and unverifiable login become named repair items', async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.home, '.claude.json'), 'invalid');
  assert.throws(() => f.journal(), /JSON/);
  writeFileSync(join(f.home, '.claude.json'), '{}');
  f.ports.login = () => ({openAtLogin: true, executableWillLaunchAtLogin: false});
  f.ports.skills = async () => ['owned link conflicts'];
  f.ports.retargetLogin = async () => { throw new Error('login could not be verified'); };
  const results = await repairMigrationIntegrations(f.journal(), f.ports);
  assert.deepEqual(results.filter((r) => r.status === 'pending').map((r) => r.id), ['skills', 'login']);
});
