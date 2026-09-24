// Installation must never sacrifice a healthy generation to a failed update.
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import fs, { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { applyPiExtensionConfig, getPiExtensionConfig, reconcilePiExtension } from "../src/server/extensions/config.ts";
import { inspectPiExtension } from "../src/server/environment/pi-extension.ts";
import { inspectMissionMcpTools } from "../src/server/mission-mcp.ts";
import { piMetadataSource, piBridgeSource, writePiIntegration } from "./helpers/pi-integration.ts";
import { verifyPiIntegration } from "../src/server/extensions/pi-artifact.ts";
import { buildPiExtension } from "../scripts/build-pi-extension.ts";
import { piGenerationPath, piIntegrationRoot, isManagedPiExtensionTarget } from "../src/server/extensions/pi-paths.ts";
import { ensureNativeStateLockAddon } from "./helpers/native-state-lock.ts";
import { mockSymlinkPublication } from "./helpers/symlink-publication.ts";

ensureNativeStateLockAddon();

const root = mkdtempSync(join(tmpdir(), "pi-publisher-"));
const previous = { ...process.env };
const home = join(root, "state");
const source = join(root, "app", "dist", "pi-integration");
const link = join(home, "pi-extensions", "mission-control.js");
beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  process.env.MISSION_HOME = home; process.env.MISSION_PI_EXTENSION = join(source, "extension.js");
  delete process.env.PI_EXTENSIONS_DIR;
  for (const prefix of ["MISSION", "FLEET", "HARNESS"]) delete process.env[`${prefix}_MCP_SERVER`];
  writePiIntegration(source);
});
after(() => { process.env = previous; rmSync(root, { recursive: true, force: true }); });
const enable = async () => { const r = await applyPiExtensionConfig({ enabled: true }); assert.deepEqual(r.problems, []); return readlinkSync(link); };

test("successful updates bound idle generations to the current and previous publication", async () => {
  const targets: string[] = [];
  for (let release = 0; release < 5; release++) {
    writePiIntegration(source, piMetadataSource + `\n// release ${release}`);
    targets.push(await enable());
  }
  const generations = readdirSync(join(home, "integrations", "pi")).filter(name => /^[a-f0-9]{64}$/.test(name));
  assert.equal(generations.length, 2);
  for (const target of targets.slice(-2)) verifyPiIntegration(dirname(target));
  for (const target of targets.slice(0, -2)) assert.equal(existsSync(target), false);
  await enable();
  assert.equal(existsSync(targets.at(-2)!), true, "an idempotent publication preserves the previous generation");
});

test("a loaded real extension pins its bridge across updates and a crashed process is reclaimed", { timeout: 30_000 }, async () => {
  await buildPiExtension(join(source, "extension.js"));
  const old = await enable();
  // The child loads the shipped extension, then opens a new bridge on demand from its
  // captured metadata. Its state home deliberately differs from the owning app's home.
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { createInterface } from 'node:readline';
    import { McpClient } from ${JSON.stringify(new URL("../src/pi/mcp-client.ts", import.meta.url).href)};
    const { missionControlBuild } = await import(process.argv[1]);
    process.title = 'pi-retention-live-session';
    const lines = createInterface({ input: process.stdin });
    console.log('loaded');
    for await (const line of lines) {
      const client = new McpClient(missionControlBuild.mcpServerPath);
      try { console.log(JSON.stringify((await client.tools()).map(tool => tool.name))); }
      finally { client.close(); }
    }
  `, pathToFileURL(old).href], { env: { ...process.env, MISSION_HOME: join(root, "isolated-agent") }, stdio: ["pipe", "pipe", "pipe"] });
  const output = createInterface({ input: child.stdout });
  const exited = once(child, "exit");
  try {
    assert.deepEqual(await once(output, "line", { signal: AbortSignal.timeout(5000) }), ["loaded"]);
    assert.equal(readdirSync(join(dirname(old), ".leases")).length, 1);
    for (let release = 0; release < 4; release++) {
      writePiIntegration(source, piMetadataSource + `\n// release ${release}`);
      await enable();
    }
    assert.equal(existsSync(old), true);
    assert.equal(readdirSync(piIntegrationRoot()).filter(name => /^[a-f0-9]{64}$/.test(name)).length, 3);
    const reply = once(output, "line", { signal: AbortSignal.timeout(5000) });
    child.stdin.write("new bridge after updates\n");
    const [tools] = await reply;
    assert.ok(JSON.parse(tools).includes("request_input"));
    child.kill("SIGKILL"); await exited;
    assert.equal(readdirSync(join(dirname(old), ".leases")).length, 1, "crash leaves a lease for liveness-based cleanup");
    await enable();
    assert.equal(existsSync(old), false);
    assert.equal(readdirSync(piIntegrationRoot()).filter(name => /^[a-f0-9]{64}$/.test(name)).length, 2);
  } finally { child.kill("SIGKILL"); await exited; output.close(); }
});

test("publication and ownership use the same managed namespace under a custom state home", async () => {
  const target = await enable();
  const manifest = verifyPiIntegration(dirname(target));
  assert.equal(dirname(target), piGenerationPath(manifest.buildId));
  assert.equal(isManagedPiExtensionTarget(target), true);
  assert.equal(isManagedPiExtensionTarget(join(root, manifest.buildId, "extension.js")), false);
  assert.equal(isManagedPiExtensionTarget(join(piIntegrationRoot(), manifest.buildId, "foreign.js")), false);
  rmSync(dirname(target), { recursive: true });
  assert.equal(isManagedPiExtensionTarget(target), true, "a deleted managed generation stays owned for repair");
  await enable();
  assert.equal((await applyPiExtensionConfig({ enabled: false })).blocked.length, 0);
  assert.equal(existsSync(link), false);
});

test("startup upgrades enabled integration atomically, retaining the previous bridge and idempotent link", async () => {
  const old = await enable(); const oldBytes = readFileSync(old);
  writePiIntegration(source, piMetadataSource + "\n// next release");
  const samples: string[] = [];
  const poll = setInterval(() => samples.push(readlinkSync(link)), 1);
  try {
    assert.equal((await reconcilePiExtension()).changed, true);
    const current = readlinkSync(link); assert.notEqual(current, old);
    assert.ok(samples.length > 0); assert.ok(samples.every(x => x === old || x === current));
    assert.deepEqual(readFileSync(old), oldBytes);
    assert.equal(await inspectMissionMcpTools(join(dirname(old), "mcp-server.mjs")), true);
    const inode = lstatSync(link).ino;
    assert.equal((await reconcilePiExtension()).changed, false); assert.equal(lstatSync(link).ino, inode);
    assert.equal((await inspectPiExtension()).healthy, true);
  } finally { clearInterval(poll); }
});

for (const operation of ["copyFileSync", "exchangePaths", "symlinkSync"] as const) {
  test(`failed ${operation} preserves the previous link, generation and intent`, async (t) => {
    const old = await enable(); const inode = lstatSync(link).ino;
    writePiIntegration(source, piMetadataSource + "\n// next release");
    const fail = () => { throw new Error("injected publication fault"); };
    const fault = operation === "exchangePaths" ? mockSymlinkPublication(t, operation, fail) : t.mock.method(fs, operation, fail);
    syncBuiltinESMExports();
    try {
      const result = await applyPiExtensionConfig({ enabled: true });
      assert.equal(result.changed, false); assert.equal(result.blocked.length, 1);
      assert.ok(fault.mock.callCount() > 0);
      assert.equal(lstatSync(link).ino, inode); assert.equal(readlinkSync(link), old);
      assert.deepEqual(getPiExtensionConfig(), { enabled: true });
      verifyPiIntegration(dirname(old));
    } finally {
      if (operation === "exchangePaths") (fault as ReturnType<typeof mockSymlinkPublication>).restore(); else t.mock.restoreAll();
      syncBuiltinESMExports();
    }
    assert.equal((await reconcilePiExtension()).changed, true);
  });
}
test("hash, protocol and copied-byte refusal preserve the healthy generation", async (t) => {
  const old = await enable(); const inode = lstatSync(link).ino;
  for (const damage of [
    () => writeFileSync(join(source, "extension.js"), "damaged"),
    () => writeFileSync(join(source, "manifest.json"), '{"protocol":2}'),
    () => writeFileSync(join(source, "mcp-server.mjs"), "damaged"),
  ]) {
    writePiIntegration(source); damage();
    assert.equal((await reconcilePiExtension()).blocked.length, 1);
    assert.equal(lstatSync(link).ino, inode); assert.equal(readlinkSync(link), old);
  }
  writePiIntegration(source);
  const copy = fs.copyFileSync;
  const fault = t.mock.method(fs, "copyFileSync", (...args: Parameters<typeof fs.copyFileSync>) => {
    copy(...args); if (String(args[1]).endsWith("extension.js")) writeFileSync(args[1], "corrupted copy");
  }); syncBuiltinESMExports();
  try { assert.equal((await reconcilePiExtension()).blocked.length, 1); assert.equal(lstatSync(link).ino, inode); }
  finally { fault.mock.restore(); syncBuiltinESMExports(); }
});
test("first link publication failure never persists enabled intent", async (t) => {
  const fault = t.mock.method(fs, "symlinkSync", () => { throw new Error("cannot publish"); }); syncBuiltinESMExports();
  try {
    const result = await applyPiExtensionConfig({ enabled: true });
    assert.equal(result.blocked.length, 1); assert.equal(getPiExtensionConfig().enabled, false);
    assert.equal(existsSync(link), false);
  } finally { fault.mock.restore(); syncBuiltinESMExports(); }
});

for (const installation of ["fresh", "disabled", "replacement", "unchanged"] as const) {
  for (const timing of ["before", "after"] as const) {
    for (const replacement of ["file", "directory", "same-target-link"] as const) {
      test(`${installation} publication restores prior intent when a ${replacement} arrives ${timing} intent rename`, async (t) => {
        const wasEnabled = installation === "replacement" || installation === "unchanged";
        if (wasEnabled) await enable();
        const owned = installation === "replacement" ? { entry: lstatSync(link), target: readlinkSync(link) } : undefined;
        if (installation === "replacement") writePiIntegration(source, piMetadataSource + "\n// next release");
        const intent = join(home, "pi-extension.json");
        if (installation === "disabled") { mkdirSync(home, { recursive: true }); writeFileSync(intent, '{ "enabled": false }\n'); }
        const prior = existsSync(intent) ? readFileSync(intent, "utf8") : undefined;
        const rename = fs.renameSync;
        let concurrent: fs.Stats | undefined;
        let concurrentTarget: string | undefined;
        const arrive = () => {
          concurrentTarget = readlinkSync(link);
          rename(link, join(home, "displaced.js"));
          if (replacement === "file") writeFileSync(link, "operator bytes");
          else if (replacement === "directory") mkdirSync(link);
          else symlinkSync(concurrentTarget, link);
          concurrent = lstatSync(link);
        };
        const fault = t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
          const committing = String(from).endsWith("/intent.json") && String(to) === intent;
          if (committing && timing === "before") arrive();
          rename(from, to);
          if (committing && timing === "after") arrive();
        });
        syncBuiltinESMExports();
        try {
          const result = await applyPiExtensionConfig({ enabled: true });
          assert.ok(concurrent, "replacement races with the durable intent write");
          assert.equal(result.blocked.length, 1);
          assert.equal(result.changed, false);
          assert.equal(existsSync(intent) ? readFileSync(intent, "utf8") : undefined, prior);
          assert.equal(result.config.enabled, wasEnabled);
          assert.equal(lstatSync(link).ino, concurrent.ino);
          if (replacement === "file") assert.equal(readFileSync(link, "utf8"), "operator bytes");
          if (replacement === "same-target-link") assert.equal(readlinkSync(link), concurrentTarget);
          assert.equal(readdirSync(home).some(name => name.startsWith(".pi-extension-")), false);
          const recoveryDirectories = readdirSync(dirname(link)).filter(name => name.startsWith(".mission-extension-"));
          if (owned) {
            assert.equal(recoveryDirectories.length, 1, "a failed update keeps its formerly working discovery link");
            const recovery = join(dirname(link), recoveryDirectories[0]!);
            assert.ok(result.problems[0]!.includes(recovery));
            assert.equal(lstatSync(join(recovery, "candidate")).ino, owned.entry.ino);
            assert.equal(readlinkSync(join(recovery, "candidate")), owned.target);
          } else assert.deepEqual(recoveryDirectories, []);
        } finally { fault.mock.restore(); syncBuiltinESMExports(); }
      });
    }
  }
}

test("intent commit failure restores the previous link without deleting either generation", async (t) => {
  const old = await enable(); writePiIntegration(source, piMetadataSource + "\n// next");
  const rename = fs.renameSync;
  const fault = t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === join(home, "pi-extension.json")) throw new Error("cannot commit intent");
    rename(from, to);
  }); syncBuiltinESMExports();
  try {
    assert.equal((await applyPiExtensionConfig({ enabled: true })).blocked.length, 1);
    assert.equal(readlinkSync(link), old); verifyPiIntegration(dirname(old));
    assert.equal(getPiExtensionConfig().enabled, true);
    assert.equal(readdirSync(join(home, "integrations", "pi")).filter(x => /^[a-f0-9]{64}$/.test(x)).length, 2);
  } finally { fault.mock.restore(); syncBuiltinESMExports(); }
});
test("legacy missing build is adopted, foreign entries and a foreign arrival during verification are untouched", async () => {
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(join(root, "deleted/dist/pi-extension/index.js"), link);
  await enable(); rmSync(link);
  const foreign = join(root, "foreign.js"); writeFileSync(foreign, "operator");
  for (const kind of ["file", "directory", "link", "unknown-missing"]) {
    if (kind === "file") writeFileSync(link, "operator");
    else if (kind === "directory") mkdirSync(link);
    else symlinkSync(kind === "link" ? foreign : join(root, "unknown.js"), link);
    const inode = lstatSync(link).ino;
    assert.equal((await applyPiExtensionConfig({ enabled: true })).blocked.length, 1);
    assert.equal((await applyPiExtensionConfig({ enabled: false })).blocked.length, 1);
    assert.equal(lstatSync(link).ino, inode); rmSync(link, { recursive: kind === "directory" });
  }
  writePiIntegration(source, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(link)}, 'arrived during child probe');\n` + piMetadataSource);
  assert.equal((await applyPiExtensionConfig({ enabled: true })).blocked.length, 1);
  assert.equal(readFileSync(link, "utf8"), "arrived during child probe");
  assert.equal(getPiExtensionConfig().enabled, false);
});
test("repair replaces damaged owned files, retaining the damaged directory for recovery", async () => {
  const target = await enable(); writeFileSync(target, "damaged");
  assert.equal((await inspectPiExtension()).healthy, false);
  assert.equal(await enable(), target);
  assert.equal((await inspectPiExtension()).healthy, true);
  const generations = join(home, "integrations", "pi");
  assert.equal(readdirSync(generations).filter(name => name.startsWith(".damaged-")).length, 1);
});

for (const failure of ["backup", "replacement", "restoration"] as const) {
  test(`failed damaged-generation ${failure} removes empty backup containers and retains recovery data`, async (t) => {
    const target = await enable();
    const generation = dirname(target);
    const buildId = verifyPiIntegration(generation).buildId;
    writeFileSync(target, "damaged bytes for recovery");
    const rename = fs.renameSync;
    let failures = 0;
    const fault = t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
      if ((failure === "backup" && String(from) === generation)
        || (failure !== "backup" && String(to) === generation
          && (failure === "restoration" || String(from).includes("/.staging-")))) {
        failures++;
        throw new Error("injected damaged-generation rename failure");
      }
      rename(from, to);
    });
    syncBuiltinESMExports();
    try {
      for (let attempt = 0; attempt < (failure === "restoration" ? 1 : 3); attempt++) {
        assert.equal((await applyPiExtensionConfig({ enabled: true })).blocked.length, 1);
        const entries = readdirSync(piIntegrationRoot());
        assert.equal(entries.some(name => name.startsWith(".staging-")), false);
        const backups = entries.filter(name => name.startsWith(".damaged-"));
        if (failure === "restoration") {
          assert.equal(backups.length, 1);
          assert.equal(readFileSync(join(piIntegrationRoot(), backups[0]!, buildId, "extension.js"), "utf8"), "damaged bytes for recovery");
        } else {
          assert.deepEqual(backups, [], "failed retries must not accumulate empty backup containers");
          assert.equal(readFileSync(target, "utf8"), "damaged bytes for recovery");
        }
      }
      assert.equal(failures, failure === "restoration" ? 2 : 3);
    } finally { fault.mock.restore(); syncBuiltinESMExports(); }
  });
}

test("repeated repair retains only the newest idle damaged backup", async () => {
  const target = await enable();
  for (let repair = 0; repair < 4; repair++) {
    writeFileSync(target, `damage ${repair}`);
    await enable();
  }
  const backups = readdirSync(piIntegrationRoot()).filter(name => name.startsWith(".damaged-"));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(piIntegrationRoot(), backups[0]!, verifyPiIntegration(dirname(target)).buildId, "extension.js"), "utf8"), "damage 3");
});
test("preflight probes the copied bridge even when a healthy runtime override exists", async () => {
  const override = join(root, "healthy.mjs"); writeFileSync(override, piBridgeSource());
  process.env.MISSION_MCP_SERVER = override;
  writePiIntegration(source, piMetadataSource, piBridgeSource(["request_input"]));
  assert.equal((await applyPiExtensionConfig({ enabled: true })).blocked.length, 1);
  assert.equal(getPiExtensionConfig().enabled, false);
  assert.equal(existsSync(link), false);
});
test("concurrent enable and disable serialize publication and leave durable off", async () => {
  const [on, off] = await Promise.all([applyPiExtensionConfig({ enabled: true }), applyPiExtensionConfig({ enabled: false })]);
  assert.equal(on.blocked.length, 0); assert.equal(off.blocked.length, 0);
  assert.equal(getPiExtensionConfig().enabled, false); assert.equal(existsSync(link), false);
});

test("a disabled startup never publishes an available generation", async () => {
  assert.equal((await reconcilePiExtension()).changed, false);
  assert.equal(existsSync(link), false); assert.equal(getPiExtensionConfig().enabled, false);
});

test("an unknown dangling link matching an arbitrary configured output remains foreign", async () => {
  const unknown = join(root, "unknown.js"); process.env.MISSION_PI_EXTENSION = unknown;
  mkdirSync(dirname(link), { recursive: true }); symlinkSync(unknown, link);
  const inode = lstatSync(link).ino;
  assert.equal((await applyPiExtensionConfig({ enabled: true })).blocked.length, 1);
  assert.equal((await applyPiExtensionConfig({ enabled: false })).blocked.length, 1);
  assert.equal(lstatSync(link).ino, inode);
});
