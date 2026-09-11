import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, writeFileSync, symlinkSync, rmSync, lstatSync, realpathSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectPiExtension, loadPiExtensionMetadata, canInstallPiExtension, piExtensionLinkPath } from "../src/server/environment/pi-extension.ts";
import { missionToolsAvailability } from "../src/server/mission-tools.ts";
import { MISSION_MCP_TOOLS } from "../src/server/mission-mcp.ts";
import { ENVIRONMENT_CHECK_IDS } from "../src/shared/environment-checks.ts";
import { applyPiExtensionConfig, getPiExtensionConfig } from "../src/server/extensions/config.ts";
import { installPiExtensionFromSetup } from "../src/server/setup/pi-extension.ts";

const root = mkdtempSync(join(tmpdir(), "pi-health-"));
const previous = { ...process.env };
const extensions = join(root, "override");
const link = join(extensions, "mission-control.js");
const expected = join(root, "current.js");
const installed = join(root, "installed.js");
const bridge = join(root, "bridge.mjs");
const metadata = (version = "current", mcpServerPath = bridge) => `export default () => {}; export const missionControlBuild = ${JSON.stringify({ version, mcpServerPath })};`;
function mcp(tools: readonly string[] = MISSION_MCP_TOOLS) {
  writeFileSync(bridge, `import {createInterface} from 'node:readline';
  createInterface({input:process.stdin}).on('line', l => { const m=JSON.parse(l); if(m.id) console.log(JSON.stringify({jsonrpc:'2.0', id:m.id, result:m.method==='tools/list'?{tools:${JSON.stringify(tools.map(name => ({ name })))} }:{protocolVersion:'2025-06-18',capabilities:{},serverInfo:{name:'fixture',version:'1'}}})); });`);
}
beforeEach(() => {
  rmSync(root, { recursive: true, force: true }); mkdirSync(extensions, { recursive: true });
  process.env.MISSION_HOME = join(root, "state");
  process.env.PI_EXTENSIONS_DIR = extensions;
  process.env.MISSION_PI_EXTENSION = expected;
  for (const key of ["MISSION_MCP_SERVER", "FLEET_MCP_SERVER", "HARNESS_MCP_SERVER"]) delete process.env[key];
  writeFileSync(expected, metadata()); writeFileSync(installed, metadata()); mcp();
});
after(() => { process.env = previous; rmSync(root, { recursive: true, force: true }); });

test("environment IDs preserve every earlier index and append Pi", () => {
  assert.deepEqual(ENVIRONMENT_CHECK_IDS, ["upstartclaw-core-setup", "mission-hook-script", "pi-extension"]);
});
test("never installed is silent but unavailable, and enabled missing link warns without repair", async () => {
  assert.equal((await inspectPiExtension()).warning, null);
  assert.equal((await missionToolsAvailability("pi")).available, false);
  assert.equal(canInstallPiExtension(), true);
  applyPiExtensionConfig({ enabled: true }); rmSync(link);
  const reading = await inspectPiExtension();
  assert.match(reading.warning!, /enabled.*missing.*Pi reports nothing/);
  assert.equal(reading.healthy, false); assert.equal(existsSync(link), false);
  assert.equal(canInstallPiExtension(), false);
});
test("capability override agrees with installer and dangling links report both paths without changing them", async () => {
  assert.equal(piExtensionLinkPath(), link);
  symlinkSync(join(root, "gone.js"), link);
  const reading = await inspectPiExtension();
  assert.match(reading.warning!, /Pi reports nothing.*dangling/);
  assert.ok(reading.warning!.includes(link)); assert.ok(reading.warning!.includes(join(root, "gone.js")));
  assert.ok(lstatSync(link).isSymbolicLink()); assert.equal(canInstallPiExtension(), false);
});
for (const [label, source] of [["parse error", "export default !!"], ["module-scope throw", "throw Error('private diagnostic');"], ["hang", "while (true) {}"], ["stdout flood", "while(true) console.log('x'.repeat(10000));"]]) {
  test(`${label} stays in the bounded child and refuses availability`, async () => {
    writeFileSync(installed, source!); symlinkSync(installed, link);
    const reading = await inspectPiExtension();
    assert.match(reading.warning!, /Every Pi session.*refuse to start/);
    assert.doesNotMatch(reading.warning!, /private diagnostic/);
    assert.equal(reading.healthy, false);
  });
}
test("timeout uses SIGKILL even for a module ignoring SIGTERM", async () => {
  writeFileSync(installed, "process.on('SIGTERM',()=>{}); setInterval(()=>{},1); await new Promise(()=>{});");
  const start = Date.now();
  assert.equal((await loadPiExtensionMetadata(realpathSync(installed), 200)).loaded, false);
  assert.ok(Date.now() - start < 3000);
});
test("loads canonical target with daemon secrets and state scrubbed", async () => {
  const record = join(root, "child.json");
  process.env.MISSION_API_TOKEN = "must-not-leak"; process.env.MISSION_API_TOKEN_FILE = "/must-not-leak";
  process.env.MISSION_SCOUT_SUBMISSION_CREDENTIAL = "must-not-leak";
  writeFileSync(installed, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(record)}, JSON.stringify({url:import.meta.url, token:process.env.MISSION_API_TOKEN, tokenFile:process.env.MISSION_API_TOKEN_FILE, scout:process.env.MISSION_SCOUT_SUBMISSION_CREDENTIAL, home:process.env.MISSION_HOME})); ${metadata()}`);
  symlinkSync(installed, link);
  assert.equal((await inspectPiExtension()).healthy, true);
  const data = JSON.parse(readFileSync(record, "utf8"));
  assert.equal(data.url, new URL(`file://${realpathSync(installed)}`).href);
  assert.equal(data.token, undefined); assert.equal(data.tokenFile, undefined); assert.equal(data.scout, undefined);
  assert.notEqual(data.home, process.env.MISSION_HOME); assert.equal(existsSync(data.home), false);
});
test("missing baked bridge names the affected tools half", async () => {
  symlinkSync(installed, link); rmSync(bridge);
  assert.match((await inspectPiExtension()).warning!, /baked MCP bundle is missing.*Lifecycle reports may still work/);
});
test("stale and missing markers warn, a stale bridged tool list warns, rebuilding clears immediately", async () => {
  symlinkSync(installed, link);
  writeFileSync(installed, metadata("old"));
  assert.match((await inspectPiExtension()).warning!, /out of date/);
  writeFileSync(installed, "export default () => {};");
  assert.match((await inspectPiExtension()).warning!, /no valid build marker/);
  writeFileSync(installed, metadata()); mcp(["request_input"]);
  assert.match((await inspectPiExtension()).warning!, /stale.*tools\/list/);
  mcp(); assert.deepEqual(await inspectPiExtension(), { healthy: true, warning: null, detail: null });
  assert.equal((await missionToolsAvailability("pi")).available, true);
});
test("Setup installs once, verifies health and refuses a second or broken-install repair", async () => {
  assert.equal((await installPiExtensionFromSetup()).ok, true);
  assert.equal(realpathSync(link), realpathSync(expected));
  assert.equal((await installPiExtensionFromSetup()).ok, false);
  rmSync(expected);
  assert.equal((await installPiExtensionFromSetup()).ok, false);
  assert.ok(lstatSync(link).isSymbolicLink());
});
test("Setup refuses an unhealthy candidate before persisting intent or publishing a link", async () => {
  writeFileSync(expected, "throw Error('bad build')");
  const result = await installPiExtensionFromSetup();
  assert.equal(result.ok, false);
  assert.match(result.detail, /Nothing was installed or enabled.*candidate.*failed to load/);
  assert.doesNotMatch(result.detail, /Every Pi session.*may refuse/);
  assert.equal(existsSync(link), false);
  assert.equal(existsSync(join(root, "state", "pi-extension.json")), false);
  assert.equal(canInstallPiExtension(), true);
});
test("Setup refuses a pooled candidate, including one reached through a durable-looking symlink", async () => {
  const pool = join(root, "pool"); mkdirSync(pool);
  writeFileSync(join(pool, ".mission-control-worktree-pool"), "");
  const pooled = join(pool, "index.js"); writeFileSync(pooled, metadata());
  rmSync(expected); symlinkSync(pooled, expected);
  const result = await installPiExtensionFromSetup();
  assert.equal(result.ok, false); assert.match(result.detail, /pooled worktree/);
  assert.equal(canInstallPiExtension(), true);
  assert.equal(existsSync(link), false);
});
test("the MCP child also receives no daemon credentials and its private home is cleaned", async () => {
  const record = join(root, "mcp-env.json");
  process.env.MISSION_API_TOKEN = "must-not-leak";
  process.env.MISSION_API_TOKEN_FILE = "/must-not-leak";
  process.env.MISSION_SCOUT_SUBMISSION_CREDENTIAL = "must-not-leak";
  const protocol = readFileSync(bridge, "utf8");
  writeFileSync(bridge, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(record)}, JSON.stringify({token:process.env.MISSION_API_TOKEN, tokenFile:process.env.MISSION_API_TOKEN_FILE, scout:process.env.MISSION_SCOUT_SUBMISSION_CREDENTIAL, home:process.env.MISSION_HOME})); ${protocol}`);
  symlinkSync(installed, link);
  assert.equal((await inspectPiExtension()).healthy, true);
  const data = JSON.parse(readFileSync(record, "utf8"));
  assert.equal(data.token, undefined); assert.equal(data.tokenFile, undefined); assert.equal(data.scout, undefined);
  assert.notEqual(data.home, process.env.MISSION_HOME); assert.equal(existsSync(data.home), false);
});
test("a bridge override is checked as Pi uses it, without hiding a missing baked path", async () => {
  const override = join(root, "override.mjs");
  writeFileSync(override, readFileSync(bridge, "utf8"));
  process.env.MISSION_MCP_SERVER = override;
  symlinkSync(installed, link);
  assert.equal((await inspectPiExtension()).healthy, true);
  rmSync(override);
  assert.match((await inspectPiExtension()).warning!, /configured MCP bridge.*cannot be resolved/);
  rmSync(bridge);
  assert.match((await inspectPiExtension()).warning!, /baked MCP bundle is missing/);
});
test("a cyclic extension link warns without claiming absence or enabling install or dispatch", async () => {
  applyPiExtensionConfig({ enabled: true }); rmSync(link);
  symlinkSync(link, link);
  const reading = await inspectPiExtension();
  assert.equal(reading.healthy, false);
  assert.match(reading.warning!, /cannot be resolved/);
  assert.match(reading.warning!, /npm run install-pi-extension/);
  assert.doesNotMatch(reading.warning!, /missing|dangling/);
  assert.equal(reading.detail, link);
  assert.equal(canInstallPiExtension(), false);
  assert.equal((await missionToolsAvailability("pi")).available, false);
  assert.equal((await installPiExtensionFromSetup()).ok, false);
  assert.equal(readlinkSync(link), link);
});
test("an inaccessible extension target warns without treating permissions as absence", { skip: process.getuid?.() === 0 }, async () => {
  const restricted = join(root, "restricted"); mkdirSync(restricted);
  const target = join(restricted, "index.js"); writeFileSync(target, metadata());
  symlinkSync(target, link);
  chmodSync(restricted, 0);
  try {
    assert.throws(() => realpathSync(link), { code: "EACCES" });
    const reading = await inspectPiExtension();
    assert.equal(reading.healthy, false);
    assert.match(reading.warning!, /cannot be resolved/);
    assert.match(reading.warning!, /permissions/);
    assert.match(reading.warning!, /npm run install-pi-extension/);
    assert.doesNotMatch(reading.warning!, /missing|dangling/);
    assert.equal(canInstallPiExtension(), false);
    assert.equal(readlinkSync(link), target);
  } finally { chmodSync(restricted, 0o700); }
});

for (const enabled of [false, true]) {
  test(`entry inspection failure warns without repair when persisted intent is ${enabled}`, { skip: process.getuid?.() === 0 }, async () => {
    if (enabled) applyPiExtensionConfig({ enabled: true });
    else symlinkSync(expected, link);
    const targetBefore = readlinkSync(link);
    chmodSync(extensions, 0);
    try {
      assert.throws(() => lstatSync(link), { code: "EACCES" });
      const reading = await inspectPiExtension();
      assert.equal(reading.healthy, false);
      assert.match(reading.warning!, /extension entry.*cannot be inspected/);
      assert.match(reading.warning!, /permissions.*npm run install-pi-extension/);
      assert.doesNotMatch(reading.warning!, /missing|dangling/);
      assert.equal(reading.detail, link);
      assert.equal(canInstallPiExtension(), false);
      assert.equal((await installPiExtensionFromSetup()).ok, false);
      assert.equal((await missionToolsAvailability("pi")).available, false);
      assert.equal(statSync(extensions).mode & 0o777, 0);
    } finally { chmodSync(extensions, 0o700); }
    assert.equal(readlinkSync(link), targetBefore);
    assert.equal((await inspectPiExtension()).healthy, true);
  });
}

test("baked MCP bundle access failure warns about tools and preserves permissions", { skip: process.getuid?.() === 0 }, async () => {
  const restricted = join(root, "restricted-mcp"); mkdirSync(restricted);
  const baked = join(restricted, "server.mjs");
  const protocol = readFileSync(bridge, "utf8"); writeFileSync(baked, protocol);
  writeFileSync(installed, metadata("current", baked)); symlinkSync(installed, link);
  chmodSync(restricted, 0);
  try {
    assert.throws(() => statSync(baked), { code: "EACCES" });
    const reading = await inspectPiExtension();
    assert.equal(reading.healthy, false);
    assert.match(reading.warning!, /baked MCP bundle.*cannot be inspected/);
    assert.match(reading.warning!, /Lifecycle reports may still work/);
    assert.match(reading.warning!, /permissions.*npm run install-pi-extension/);
    assert.doesNotMatch(reading.warning!, /missing|dangling/);
    assert.equal(reading.detail, baked);
    assert.equal((await missionToolsAvailability("pi")).available, false);
    assert.equal(statSync(restricted).mode & 0o777, 0);
    assert.equal(readlinkSync(link), installed);
  } finally { chmodSync(restricted, 0o700); }
  assert.equal(readFileSync(baked, "utf8"), protocol);
  assert.equal((await inspectPiExtension()).healthy, true);
});


test("unexpected intent errors log a bounded diagnostic without disclosing file contents", async (t) => {
  mkdirSync(join(root, "state"));
  writeFileSync(join(root, "state", "pi-extension.json"), "private-intent-content");
  const log = t.mock.method(console, "warn", () => {});
  assert.match((await inspectPiExtension()).warning!, /could not establish/);
  assert.equal(log.mock.callCount(), 1);
  const logged = JSON.stringify(log.mock.calls[0]!.arguments);
  assert.match(logged, /SyntaxError/);
  assert.doesNotMatch(logged, /private-intent-content/);
});

test("dispatch caches completed health but observes link, bundle, bridge and intent changes", async () => {
  const counter = join(root, "loads");
  const counted = `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(counter)}, 'x'); `;
  writeFileSync(installed, counted + metadata()); symlinkSync(installed, link);
  assert.equal((await missionToolsAvailability("pi")).available, true);
  assert.equal((await missionToolsAvailability("pi")).available, true);
  assert.equal(readFileSync(counter, "utf8"), "x", "unchanged dispatch reuses a completed probe");
  await inspectPiExtension();
  assert.equal((await missionToolsAvailability("pi")).available, true);
  assert.equal(readFileSync(counter, "utf8"), "xxx", "Setup re-check bypasses and invalidates dispatch cache");
  writeFileSync(installed, counted + metadata("old"));
  assert.equal((await missionToolsAvailability("pi")).available, false);
  writeFileSync(installed, counted + metadata());
  assert.equal((await missionToolsAvailability("pi")).available, true);
  writeFileSync(expected, metadata("new-reference"));
  assert.equal((await missionToolsAvailability("pi")).available, false);
  writeFileSync(expected, metadata());
  assert.equal((await missionToolsAvailability("pi")).available, true);
  mcp(["request_input"]);
  assert.equal((await missionToolsAvailability("pi")).available, false);
  mcp();
  assert.equal((await missionToolsAvailability("pi")).available, true);
  process.env.MISSION_MCP_SERVER = join(root, "missing-override.mjs");
  assert.equal((await missionToolsAvailability("pi")).available, false);
  delete process.env.MISSION_MCP_SERVER;
  assert.equal((await missionToolsAvailability("pi")).available, true);
  rmSync(link); symlinkSync(join(root, "missing-target.js"), link);
  assert.equal((await missionToolsAvailability("pi")).available, false);
  rmSync(link);
  assert.equal((await missionToolsAvailability("pi")).available, false);
  assert.equal((await installPiExtensionFromSetup()).ok, true);
  assert.equal((await missionToolsAvailability("pi")).available, true);
});

test("dispatch cache expires when an unchanged bridge stops providing tools", async (t) => {
  let clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  const flag = join(root, "stop-bridge");
  const protocol = readFileSync(bridge, "utf8");
  writeFileSync(bridge, `import {existsSync} from 'node:fs'; if (existsSync(${JSON.stringify(flag)})) process.exit(1);\n` + protocol);
  symlinkSync(installed, link);
  assert.equal((await missionToolsAvailability("pi")).available, true);
  writeFileSync(flag, "");
  assert.equal((await missionToolsAvailability("pi")).available, true);
  clock += 30_001;
  assert.equal((await missionToolsAvailability("pi")).available, false);
});


test("post-publication failure retains explicit intent and reports manual recovery without removing the link", async () => {
  const firstLoad = join(root, "candidate-loaded");
  writeFileSync(expected, `import {existsSync,writeFileSync} from 'node:fs';
    if (existsSync(${JSON.stringify(firstLoad)})) throw Error('post-install failure');
    writeFileSync(${JSON.stringify(firstLoad)}, 'loaded'); ${metadata()}`);
  const result = await installPiExtensionFromSetup();
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.status, 500);
  assert.match(result.detail, /npm run install-pi-extension/);
  assert.equal(getPiExtensionConfig().enabled, true);
  assert.equal(readlinkSync(link), expected);
  assert.equal(canInstallPiExtension(), false);
  assert.match((await inspectPiExtension()).warning!, /Every Pi session.*may refuse/);
});


test("a slower earlier dispatch probe cannot overwrite a newer completed health reading", async () => {
  // Warm runtime environment setup so it cannot independently invalidate the older probe.
  await loadPiExtensionMetadata(realpathSync(installed));
  const started = join(root, "first-bridge-started");
  const release = join(root, "release-first-bridge");
  const probes = join(root, "bridge-probes");
  writeFileSync(bridge, `import {createInterface} from 'node:readline';
    import {existsSync,writeFileSync,appendFileSync} from 'node:fs';
    const first = !existsSync(${JSON.stringify(started)});
    appendFileSync(${JSON.stringify(probes)}, 'x');
    writeFileSync(${JSON.stringify(started)}, 'started');
    const tools = ${JSON.stringify(MISSION_MCP_TOOLS.map(name => ({ name })))};
    createInterface({input:process.stdin}).on('line', async line => {
      const m=JSON.parse(line); if (!m.id) return;
      if (first && m.method==='tools/list') {
        while (!existsSync(${JSON.stringify(release)})) await new Promise(done => setTimeout(done, 10));
      }
      console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.method==='tools/list'
        ? {tools:first?[]:tools}
        : {protocolVersion:'2025-06-18',capabilities:{},serverInfo:{name:'fixture',version:'1'}}}));
    });`);
  symlinkSync(installed, link);
  const older = missionToolsAvailability("pi");
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(started) && Date.now() < deadline) await new Promise(done => setTimeout(done, 10));
    assert.ok(existsSync(started), "the older probe reached its bridge before the newer one starts");
    assert.equal((await missionToolsAvailability("pi")).available, true);
  } finally { writeFileSync(release, "released"); }
  assert.equal((await older).available, false);
  assert.equal((await missionToolsAvailability("pi")).available, true, "the newer healthy reading remains cached");
  assert.equal(readFileSync(probes, "utf8"), "xx", "the final dispatch reused the newer completed probe");
});


test("completed health can serve continued arrivals while a newer probe is pending", async () => {
  await loadPiExtensionMetadata(realpathSync(installed));
  const probes = join(root, "overlapping-probes");
  const firstRelease = join(root, "release-first");
  const secondRelease = join(root, "release-second");
  writeFileSync(probes, "");
  writeFileSync(bridge, `import {createInterface} from 'node:readline';
    import {existsSync,readFileSync,appendFileSync} from 'node:fs';
    const ordinal = readFileSync(${JSON.stringify(probes)}, 'utf8').length + 1;
    appendFileSync(${JSON.stringify(probes)}, 'x');
    const release = ordinal===1 ? ${JSON.stringify(firstRelease)} : ordinal===2 ? ${JSON.stringify(secondRelease)} : null;
    createInterface({input:process.stdin}).on('line', async line => {
      const m=JSON.parse(line); if (!m.id) return;
      if (m.method==='tools/list' && release) {
        while (!existsSync(release)) await new Promise(done => setTimeout(done, 10));
      }
      console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.method==='tools/list'
        ? {tools:${JSON.stringify(MISSION_MCP_TOOLS.map(name => ({ name })))}}
        : {protocolVersion:'2025-06-18',capabilities:{},serverInfo:{name:'fixture',version:'1'}}}));
    });`);
  symlinkSync(installed, link);
  const waitForProbes = async (count: number) => {
    const deadline = Date.now() + 5000;
    while (readFileSync(probes, "utf8").length < count && Date.now() < deadline) await new Promise(done => setTimeout(done, 10));
    assert.equal(readFileSync(probes, "utf8").length, count);
  };
  const first = missionToolsAvailability("pi");
  let second: ReturnType<typeof missionToolsAvailability> | undefined;
  try {
    await waitForProbes(1);
    second = missionToolsAvailability("pi");
    await waitForProbes(2);
    writeFileSync(firstRelease, "released");
    assert.equal((await first).available, true);
    const arrivals = await Promise.all(Array.from({ length: 4 }, () => missionToolsAvailability("pi")));
    assert.ok(arrivals.every(result => result.available));
    assert.equal(readFileSync(probes, "utf8"), "xx", "continued arrivals reuse the completed result while the newer probe is pending");
  } finally {
    writeFileSync(firstRelease, "released"); writeFileSync(secondRelease, "released");
    await first; await second;
  }
});
