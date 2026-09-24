import { loadPiExtensionMetadata } from "../src/server/extensions/pi-candidate.ts";
// Health is read-only, bounded, and uses the same manifest and bridge as publication.
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, writeFileSync, symlinkSync, rmSync, lstatSync, realpathSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { inspectPiExtension, canInstallPiExtension, piExtensionLinkPath } from "../src/server/environment/pi-extension.ts";
import { missionToolsAvailability } from "../src/server/mission-tools.ts";
import { MISSION_MCP_TOOLS } from "../src/server/mission-mcp.ts";
import { ENVIRONMENT_CHECK_IDS } from "../src/shared/environment-checks.ts";
import { applyPiExtensionConfig, getPiExtensionConfig } from "../src/server/extensions/config.ts";
import { installPiExtensionFromSetup } from "../src/server/setup/pi-extension.ts";
import { piMetadataSource, piBridgeSource, sealPiIntegration, writePiIntegration } from "./helpers/pi-integration.ts";
import { ensureNativeStateLockAddon } from "./helpers/native-state-lock.ts";

ensureNativeStateLockAddon();

const root = mkdtempSync(join(tmpdir(), "pi-health-"));
const previous = { ...process.env };
const extensions = join(root, "override");
const link = join(extensions, "mission-control.js");
const expected = join(root, "current", "extension.js");
const installed = join(root, "installed", "extension.js");
const bridge = join(dirname(installed), "mcp-server.mjs");
function setBridge(source: string) {
  for (const file of [expected, installed]) {
    writeFileSync(join(dirname(file), "mcp-server.mjs"), source); sealPiIntegration(dirname(file));
  }
}
function setExtension(source: string) {
  for (const file of [expected, installed]) { writeFileSync(file, source); sealPiIntegration(dirname(file)); }
}
beforeEach(() => {
  rmSync(root, { recursive: true, force: true }); mkdirSync(extensions, { recursive: true });
  process.env.MISSION_HOME = join(root, "state");
  process.env.PI_EXTENSIONS_DIR = extensions;
  process.env.MISSION_PI_EXTENSION = expected;
  for (const prefix of ["MISSION", "FLEET", "HARNESS"]) delete process.env[`${prefix}_MCP_SERVER`];
  writePiIntegration(dirname(expected)); writePiIntegration(dirname(installed));
});
after(() => { process.env = previous; rmSync(root, { recursive: true, force: true }); });

test("environment IDs preserve every earlier index and append Pi", () => {
  assert.deepEqual(ENVIRONMENT_CHECK_IDS, ["upstartclaw-core-setup", "mission-hook-script", "pi-extension"]);
});
test("never installed is silent but unavailable; enabled missing link warns and allows repair", async () => {
  assert.equal((await inspectPiExtension()).warning, null);
  assert.equal((await missionToolsAvailability("pi")).available, false);
  assert.equal(canInstallPiExtension(), true);
  assert.equal((await applyPiExtensionConfig({ enabled: true })).blocked.length, 0); rmSync(link);
  const reading = await inspectPiExtension();
  assert.match(reading.warning!, /enabled.*missing.*Pi reports nothing/);
  assert.equal(reading.healthy, false); assert.equal(existsSync(link), false);
  assert.equal(canInstallPiExtension(), true);
});
test("unknown dangling and cyclic links warn without granting repair or dispatch", async () => {
  assert.equal(piExtensionLinkPath(), link);
  for (const target of [join(root, "gone.js"), link]) {
    symlinkSync(target, link);
    const reading = await inspectPiExtension();
    assert.match(reading.warning!, target === link ? /cannot be resolved/ : /Pi reports nothing.*dangling/);
    assert.equal(canInstallPiExtension(), false);
    assert.equal((await missionToolsAvailability("pi")).available, false);
    assert.equal((await installPiExtensionFromSetup()).ok, false);
    assert.equal(readlinkSync(link), target); rmSync(link);
  }
});
for (const [label, source] of [["parse error", "export default !!"], ["module-scope throw", "throw Error('private diagnostic');"], ["hang", "while (true) {}"], ["stdout flood", "while(true) console.log('x'.repeat(10000));"]]) {
  test(`${label} stays in the bounded child and refuses availability`, async () => {
    setExtension(source!); symlinkSync(installed, link);
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
test("loads canonical target and probes the MCP child with daemon secrets scrubbed", async () => {
  process.env.MISSION_API_TOKEN = "must-not-leak"; process.env.MISSION_API_TOKEN_FILE = "/must-not-leak";
  process.env.MISSION_SCOUT_SUBMISSION_CREDENTIAL = "must-not-leak";
  const record = (name: string) => `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(join(root, name))}, JSON.stringify({url:import.meta.url, token:process.env.MISSION_API_TOKEN, tokenFile:process.env.MISSION_API_TOKEN_FILE, scout:process.env.MISSION_SCOUT_SUBMISSION_CREDENTIAL, home:process.env.MISSION_HOME})); `;
  setExtension(record("child.json") + piMetadataSource); setBridge(record("mcp.json") + piBridgeSource());
  symlinkSync(installed, link);
  assert.equal((await inspectPiExtension()).healthy, true);
  for (const name of ["child.json", "mcp.json"]) {
    const data = JSON.parse(readFileSync(join(root, name), "utf8"));
    assert.equal(data.token, undefined); assert.equal(data.tokenFile, undefined); assert.equal(data.scout, undefined);
    assert.notEqual(data.home, process.env.MISSION_HOME); assert.equal(existsSync(data.home), false);
  }
  assert.equal(JSON.parse(readFileSync(join(root, "child.json"), "utf8")).url, new URL(`file://${realpathSync(installed)}`).href);
});
test("missing or modified artifacts and manifest protocol are refused before executing the extension", async () => {
  symlinkSync(installed, link);
  for (const mutate of [
    () => rmSync(bridge),
    () => writeFileSync(bridge, "tampered"),
    () => writeFileSync(installed, "throw Error('must not run');"),
    () => writeFileSync(join(dirname(installed), "manifest.json"), '{"protocol":999}'),
  ]) {
    writePiIntegration(dirname(installed)); mutate();
    assert.match((await inspectPiExtension()).warning!, /manifest or artifact hashes/);
    assert.equal((await missionToolsAvailability("pi")).available, false);
  }
});
test("stale build IDs, missing markers and stale tools warn; a correct generation recovers", async () => {
  symlinkSync(installed, link);
  writeFileSync(installed, piMetadataSource + "\n// old source"); sealPiIntegration(dirname(installed));
  assert.match((await inspectPiExtension()).warning!, /out of date/);
  setExtension("export default () => {};");
  assert.match((await inspectPiExtension()).warning!, /no valid build marker/);
  setExtension(piMetadataSource); setBridge(piBridgeSource(["request_input"]));
  assert.match((await inspectPiExtension()).warning!, /stale.*tools\/list/);
  setBridge(piBridgeSource()); assert.equal((await inspectPiExtension()).healthy, true);
});
test("Setup installs an app-owned copy, repairs an owned dangling link and is idempotent", async () => {
  assert.equal((await installPiExtensionFromSetup()).ok, true);
  const target = readlinkSync(link);
  assert.notEqual(realpathSync(link), realpathSync(expected));
  assert.ok(target.includes("/integrations/pi/"));
  const inode = lstatSync(link).ino;
  assert.equal((await installPiExtensionFromSetup()).ok, true);
  assert.equal(lstatSync(link).ino, inode);
  rmSync(link); symlinkSync(join(root, "gone/dist/pi-extension/index.js"), link);
  assert.equal((await installPiExtensionFromSetup()).ok, true);
  assert.equal(readlinkSync(link), target);
  assert.equal(getPiExtensionConfig().enabled, true);
});
test("Setup refuses an unhealthy copied candidate without persisting intent or a link", async () => {
  setExtension("throw Error('bad build')");
  const result = await installPiExtensionFromSetup();
  assert.equal(result.ok, false);
  assert.match(result.detail, /not published.*candidate.*failed to load/);
  assert.doesNotMatch(result.detail, /Every Pi session.*may refuse/);
  assert.equal(existsSync(link), false);
  assert.equal(existsSync(join(root, "state", "pi-extension.json")), false);
});
test("Setup can publish from a temporary pooled source because it copies the generation", async () => {
  writeFileSync(join(dirname(expected), ".mission-control-worktree-pool"), "");
  assert.equal((await installPiExtensionFromSetup()).ok, true);
  rmSync(dirname(expected), { recursive: true });
  const loaded = await loadPiExtensionMetadata(realpathSync(link));
  assert.equal(loaded.loaded, true);
  assert.ok(existsSync(readlinkSync(link)));
});
test("a bridge override is checked without concealing broken bundled artifacts", async () => {
  const override = join(root, "override.mjs"); writeFileSync(override, readFileSync(bridge));
  process.env.MISSION_MCP_SERVER = override; symlinkSync(installed, link);
  assert.equal((await inspectPiExtension()).healthy, true);
  rmSync(override);
  assert.match((await inspectPiExtension()).warning!, /configured MCP bridge.*cannot be resolved/);
  rmSync(bridge);
  assert.match((await inspectPiExtension()).warning!, /manifest or artifact hashes/);
});
test("permissions failures are not treated as absence and do not permit repair", { skip: process.getuid?.() === 0 }, async () => {
  symlinkSync(installed, link);
  for (const restricted of [extensions, dirname(installed)]) {
    chmodSync(restricted, 0);
    try {
      const reading = await inspectPiExtension();
      assert.equal(reading.healthy, false); assert.match(reading.warning!, /cannot be inspected|cannot be resolved/);
      assert.equal(canInstallPiExtension(), false);
      assert.equal((await installPiExtensionFromSetup()).ok, false);
    } finally { chmodSync(restricted, 0o700); }
  }
  assert.equal(readlinkSync(link), installed);
  assert.equal((await inspectPiExtension()).healthy, true);
});
test("unexpected intent errors log a bounded diagnostic without disclosing file contents", async (t) => {
  mkdirSync(join(root, "state")); writeFileSync(join(root, "state", "pi-extension.json"), "private-intent-content");
  const log = t.mock.method(console, "warn", () => {});
  assert.match((await inspectPiExtension()).warning!, /could not establish/);
  assert.equal(log.mock.callCount(), 1);
  assert.doesNotMatch(JSON.stringify(log.mock.calls[0]!.arguments), /private-intent-content/);
});
test("dispatch cache observes link, manifest, artifact, override and intent changes", async () => {
  const counter = join(root, "loads");
  setExtension(`import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(counter)}, 'x'); ` + piMetadataSource);
  symlinkSync(installed, link);
  assert.equal((await missionToolsAvailability("pi")).available, true);
  assert.equal((await missionToolsAvailability("pi")).available, true);
  assert.equal(readFileSync(counter, "utf8"), "x");
  await inspectPiExtension(); await missionToolsAvailability("pi");
  assert.equal(readFileSync(counter, "utf8"), "xxx");
  const contents = readFileSync(bridge); writeFileSync(bridge, "tampered");
  assert.equal((await missionToolsAvailability("pi")).available, false);
  writeFileSync(bridge, contents);
  assert.equal((await missionToolsAvailability("pi")).available, true);
  const manifest = join(dirname(installed), "manifest.json"); const original = readFileSync(manifest);
  writeFileSync(manifest, "{}"); assert.equal((await missionToolsAvailability("pi")).available, false);
  writeFileSync(manifest, original); assert.equal((await missionToolsAvailability("pi")).available, true);
  process.env.MISSION_MCP_SERVER = join(root, "missing-override.mjs");
  assert.equal((await missionToolsAvailability("pi")).available, false);
  delete process.env.MISSION_MCP_SERVER;
  assert.equal((await missionToolsAvailability("pi")).available, true);
  rmSync(link); assert.equal((await missionToolsAvailability("pi")).available, false);
});
test("dispatch cache expires when an unchanged bridge stops providing tools", async (t) => {
  let clock = Date.now(); t.mock.method(Date, "now", () => clock);
  const flag = join(root, "stop-bridge");
  setBridge(`import {existsSync} from 'node:fs'; if (existsSync(${JSON.stringify(flag)})) process.exit(1);\n` + piBridgeSource());
  symlinkSync(installed, link);
  assert.equal((await missionToolsAvailability("pi")).available, true);
  writeFileSync(flag, ""); assert.equal((await missionToolsAvailability("pi")).available, true);
  clock += 30_001; assert.equal((await missionToolsAvailability("pi")).available, false);
});
test("a slower earlier dispatch probe cannot overwrite a newer completed health reading", async () => {
  // Warm runtime environment setup so it cannot independently invalidate the older probe.
  await loadPiExtensionMetadata(realpathSync(installed));
  const started = join(root, "first-bridge-started");
  const release = join(root, "release-first-bridge");
  const probes = join(root, "bridge-probes");
  setBridge( `import {createInterface} from 'node:readline';
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
  setBridge( `import {createInterface} from 'node:readline';
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
