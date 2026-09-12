import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { once } from "node:events";
import { createServer } from "node:net";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { capabilitiesFor } from "../src/shared/harness-capabilities.ts";
import { ensureNativeStateLockAddon } from "./helpers/native-state-lock.ts";

const home = mkdtempSync(join(tmpdir(), "mission-extension-reconcile-"));
process.env.MISSION_HOME = home;
delete process.env.PI_EXTENSIONS_DIR;
const target = join(home, "build", "index.js");
process.env.MISSION_PI_EXTENSION = target;
const spec = capabilitiesFor("pi").extensions!;
const dir = join(home, spec.isolatedDirName);
const link = join(dir, spec.linkName);
const { extensionsDirFor, reconcileExtensionLink, uninstallExtensionLink } = await import("../src/server/skills/reconcile.ts");
const { applyPiExtensionConfig, getPiExtensionConfig, reconcilePiExtension } = await import("../src/server/extensions/config.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { closeDb, openDb } = await import("../src/server/db.ts");
ensureNativeStateLockAddon();
after(() => { closeDb(); rmSync(home, { recursive: true, force: true }); });
beforeEach(() => {
  delete process.env.PI_EXTENSIONS_DIR;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(home, "build"), { recursive: true });
  writeFileSync(target, "export const missionControlBuild = {};\n");
});

test("extension resolver uses the shared override, isolated home, real home order", () => {
  assert.ok(spec.linkName.endsWith(".js"));
  assert.equal(capabilitiesFor("claude").extensions, null);
  assert.equal(capabilitiesFor("codex").extensions, null);
  process.env.PI_EXTENSIONS_DIR = join(home, "explicit");
  assert.equal(extensionsDirFor(spec), process.env.PI_EXTENSIONS_DIR);
  delete process.env.PI_EXTENSIONS_DIR;
  assert.equal(extensionsDirFor(spec), dir);
  const saved = ["MISSION_HOME", "FLEET_HOME", "HARNESS_HOME"].map((key) => [key, process.env[key]] as const);
  try {
    for (const [key] of saved) delete process.env[key];
    assert.equal(extensionsDirFor(spec), join(homedir(), ...spec.homeDir));
  } finally {
    for (const [key, value] of saved) if (value !== undefined) process.env[key] = value;
  }
});

test("off on a new install writes nothing; install, repoint and uninstall are idempotent", () => {
  assert.equal(reconcileExtensionLink(false).changed, false);
  assert.equal(existsSync(dir), false);
  assert.equal(reconcileExtensionLink(true).changed, true);
  assert.equal(readlinkSync(link), target);
  assert.equal(reconcileExtensionLink(true).changed, false);
  const prior = join(home, "previous.js");
  writeFileSync(prior, "export const missionControlBuild = {};\n");
  rmSync(link); symlinkSync(prior, link);
  assert.equal(reconcileExtensionLink(true).changed, true);
  assert.equal(readlinkSync(link), target);
  assert.equal(reconcileExtensionLink(true).changed, false);
  writeFileSync(join(dir, "operator.js"), "operator");
  assert.equal(uninstallExtensionLink().changed, true);
  assert.deepEqual(readdirSync(dir), ["operator.js"]);
  assert.equal(uninstallExtensionLink().changed, false);
});

for (const operation of ["symlinkSync", "renameSync"] as const) {
  test(`failed replacement ${operation} preserves the working link and enabled intent`, (t) => {
    const prior = join(home, "previous.js");
    const contents = "export const missionControlBuild = { previous: true };\n";
    writeFileSync(prior, contents);
    mkdirSync(dir);
    symlinkSync(prior, link);
    const before = lstatSync(link);
    const fault = t.mock.method(fs, operation, () => {
      // The old implementation had already unlinked here when symlink creation failed.
      throw Object.assign(new Error("injected replacement I/O failure"), { code: "EIO" });
    });
    syncBuiltinESMExports();
    try {
      // Persist intent before injecting rename failure into link publication only.
      writeFileSync(join(home, "pi-extension.json"), '{"enabled":true}\n');
      const result = reconcilePiExtension();
      assert.equal(fault.mock.callCount(), 1, "the replacement reached the failing operation");
      assert.equal(result.changed, false);
      assert.deepEqual(result.linked, []);
      assert.deepEqual(result.unlinked, []);
      assert.deepEqual(result.blocked, [spec.linkName]);
      assert.deepEqual(result.problems, [`${link}: injected replacement I/O failure`]);
      assert.equal(lstatSync(link).ino, before.ino);
      assert.equal(readlinkSync(link), prior);
      assert.equal(readFileSync(link, "utf8"), contents);
      assert.deepEqual(readdirSync(dir), [spec.linkName], "staging leaves no residue");
      assert.deepEqual(getPiExtensionConfig(), { enabled: true });
    } finally {
      fault.mock.restore();
      syncBuiltinESMExports();
    }
    const retried = reconcilePiExtension();
    assert.deepEqual(retried.blocked, []);
    assert.equal(retried.changed, true);
    assert.equal(readlinkSync(link), target);
  });
}

test("real files, directories, foreign links and unknown dangling links are never modified", () => {
  mkdirSync(dir);
  const foreign = join(home, "foreign.js"); writeFileSync(foreign, "operator code");
  for (const kind of ["file", "directory", "link", "dangling"]) {
    if (kind === "file") writeFileSync(link, "operator code");
    else if (kind === "directory") mkdirSync(link);
    else symlinkSync(kind === "link" ? foreign : join(home, "missing.js"), link);
    const before = lstatSync(link);
    for (const call of [() => reconcileExtensionLink(true), uninstallExtensionLink]) {
      const result = call();
      assert.equal(result.changed, false);
      assert.deepEqual(result.blocked, [spec.linkName]);
      assert.match(result.problems[0]!, /isn't ours/);
      assert.equal(lstatSync(link).ino, before.ino);
    }
    if (kind === "file") assert.equal(readFileSync(link, "utf8"), "operator code");
    rmSync(link, { recursive: kind === "directory" });
  }
});

test("missing build cannot replace a working link, and off removes our dangling link", () => {
  reconcileExtensionLink(true);
  rmSync(target);
  assert.equal(reconcileExtensionLink(true).blocked.length, 1);
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.equal(uninstallExtensionLink().changed, true);
});

test("reconciliation reports a filesystem error without mutating the installed link", () => {
  reconcileExtensionLink(true);
  const before = lstatSync(link);
  const contents = readFileSync(target, "utf8");
  const loop = join(home, "loop.js");
  // Unlike chmod-based failures, ELOOP also fails when the test runs as root.
  symlinkSync(loop, loop);
  process.env.MISSION_PI_EXTENSION = loop;
  try {
    const result = reconcileExtensionLink(true);
    assert.equal(result.changed, false);
    assert.deepEqual(result.linked, []);
    assert.deepEqual(result.unlinked, []);
    assert.deepEqual(result.blocked, [spec.linkName]);
    assert.equal(result.problems.length, 1);
    assert.ok(result.problems[0]!.startsWith(`${link}: `));
    assert.match(result.problems[0]!, /ELOOP/);
    assert.equal(lstatSync(link).ino, before.ino);
    assert.equal(readlinkSync(link), target);
    assert.equal(readFileSync(target, "utf8"), contents);
    assert.deepEqual(readdirSync(dir), [spec.linkName]);
  } finally {
    process.env.MISSION_PI_EXTENSION = target;
    rmSync(loop);
  }
});

for (const operation of ["writeFileSync", "renameSync"] as const) {
  test(`failed intent publication ${operation} preserves persisted intent and cleans staging`, (t) => {
    applyPiExtensionConfig({ enabled: true });
    const intentFile = join(home, "pi-extension.json");
    const priorIntent = readFileSync(intentFile, "utf8");
    const priorIntentInode = lstatSync(intentFile).ino;
    const priorLinkInode = lstatSync(link).ino;
    const priorEntries = readdirSync(home).sort();
    const failure = Object.assign(new Error("injected intent publication failure"), { code: "EIO" });
    const originalWrite = fs.writeFileSync;
    const fault = t.mock.method(fs, operation, (...args: unknown[]) => {
      const staged = String(args[0]);
      assert.ok(staged.startsWith(join(home, ".pi-extension-")), "fault targets private staging");
      assert.ok(staged.endsWith("/intent.json"));
      if (operation === "writeFileSync") {
        // Leave a partial staged file, as a real disk write failure may do.
        originalWrite(staged, '{"enabled":');
      } else {
        assert.equal(args[1], intentFile);
        assert.equal(readFileSync(staged, "utf8"), '{"enabled":false}\n');
      }
      throw failure;
    });
    syncBuiltinESMExports();
    try {
      assert.throws(() => applyPiExtensionConfig({ enabled: false }), (error) => error === failure);
      assert.equal(fault.mock.callCount(), 1);
      assert.equal(readFileSync(intentFile, "utf8"), priorIntent);
      assert.equal(lstatSync(intentFile).ino, priorIntentInode);
      assert.deepEqual(getPiExtensionConfig(), { enabled: true });
      assert.deepEqual(readdirSync(home).sort(), priorEntries, "staged files and directory are removed");
      assert.equal(lstatSync(link).ino, priorLinkInode, "failed persistence never reaches link teardown");
      assert.equal(readlinkSync(link), target);
    } finally {
      fault.mock.restore();
      syncBuiltinESMExports();
    }
    assert.deepEqual(applyPiExtensionConfig({ enabled: false }).config, { enabled: false });
    assert.deepEqual(getPiExtensionConfig(), { enabled: false });
    assert.equal(existsSync(link), false, "retry publishes intent and reconciles normally");
  });
}

test("API GET returns default and persisted intent; PUT validates and reports foreign-file conflicts", async () => {
  const intentFile = join(home, "pi-extension.json");
  rmSync(intentFile, { force: true });
  const app = buildApp({ registry: {} as never, reviews: {} as never, tasks: {} as never, queues: {} as never });
  const url = "/api/extensions/pi/config";
  const get = () => app.request(url, { headers: { host: "127.0.0.1:7317" } });
  const put = (body: unknown) => app.request(url, { method: "PUT", headers: { host: "127.0.0.1:7317", "content-type": "application/json" }, body: JSON.stringify(body) });
  const initial = await get();
  assert.equal(initial.status, 200);
  assert.deepEqual(await initial.json(), { enabled: false });
  assert.equal(existsSync(intentFile), false, "GET leaves never-installed intent absent");
  assert.equal((await put({ enabled: "true" })).status, 400);
  assert.equal((await put({})).status, 400);
  assert.equal((await put({ enabled: true })).status, 200);
  const enabled = await get();
  assert.equal(enabled.status, 200);
  assert.deepEqual(await enabled.json(), { enabled: true });
  assert.equal(getPiExtensionConfig().enabled, true);
  assert.equal((await put({ enabled: false })).status, 200);
  const disabled = await get();
  assert.equal(disabled.status, 200);
  assert.deepEqual(await disabled.json(), { enabled: false });
  closeDb();
  assert.equal(getPiExtensionConfig().enabled, false);
  assert.equal(reconcilePiExtension().changed, false);
  assert.equal(existsSync(link), false);
  writeFileSync(link, "operator");
  assert.equal((await put({ enabled: true })).status, 409);
  assert.equal(getPiExtensionConfig().enabled, true, "blocked intent remains readable for Phase 6");
  assert.equal(readFileSync(link, "utf8"), "operator");
  assert.equal((await put({ enabled: false })).status, 409);
  assert.equal(getPiExtensionConfig().enabled, false, "blocked removal cannot resurrect on restart");
});

test("standalone install persists the same intent without opening SQLite", () => {
  const run = (args: string[] = []) => execFileSync(process.execPath,
    ["--import", "tsx", "scripts/install-pi-extension.ts", ...args],
    { env: process.env, encoding: "utf8" });
  const isolated = join(home, "standalone-only");
  execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { registerHooks } from "node:module";
    registerHooks({ resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      if (resolved.url === "node:sqlite" || resolved.url.endsWith("/src/server/db.ts")) {
        throw new Error("standalone installer must not load the database: " + resolved.url);
      }
      return resolved;
    } });
    await import("./scripts/install-pi-extension.ts");
  `], { env: { ...process.env, MISSION_HOME: isolated }, stdio: "pipe" });
  assert.equal(existsSync(join(isolated, "harness.db")), false);
  assert.deepEqual(JSON.parse(readFileSync(join(isolated, "pi-extension.json"), "utf8")), { enabled: true });
  run();
  assert.equal(getPiExtensionConfig().enabled, true);
  assert.equal(readlinkSync(link), target);
  assert.equal(reconcilePiExtension().changed, false);
  run(["--uninstall"]);
  assert.equal(getPiExtensionConfig().enabled, false);
  assert.equal(existsSync(link), false);
  assert.equal(reconcilePiExtension().changed, false);
  assert.throws(() => run(["--invalid"]));
});

test("standalone install fails closed on a malformed inherited isolation capture", () => {
  const isolated = join(home, "malformed-capture");
  assert.throws(() => execFileSync(process.execPath,
    ["--import", "tsx", "scripts/install-pi-extension.ts"],
    { env: { ...process.env, MISSION_HOME: isolated, MISSION_TEST_STATE: "not json" }, stdio: "pipe" }),
  /loaded no test\/setup-state.mjs and inherited no capture/);
  assert.equal(existsSync(isolated), false, "refusal happens before any state or link write");
});

test("intent writer reuses the state guard before touching an operator state home", () => {
  const previous = process.env.MISSION_HOME;
  process.env.MISSION_HOME = join(homedir(), ".mission-control");
  try {
    assert.throws(() => applyPiExtensionConfig({ enabled: false }), /refusing to open/);
  } finally { process.env.MISSION_HOME = previous; }
});

test("an accepted intent write cannot exempt a frozen database path from isolation", () => {
  const previous = process.env.MISSION_HOME;
  process.env.MISSION_HOME = join(home, "other-state");
  try {
    assert.deepEqual(applyPiExtensionConfig({ enabled: false }).config, { enabled: false });
    assert.throws(openDb, /refusing to open .*frozen against a different state dir/);
  } finally { process.env.MISSION_HOME = previous; }
});

test("malformed installation intent is never overwritten or interpreted as off", () => {
  const file = join(home, "pi-extension.json");
  const prior = readFileSync(file, "utf8");
  writeFileSync(file, "operator data");
  try {
    assert.throws(getPiExtensionConfig);
    assert.throws(reconcilePiExtension);
    assert.throws(() => execFileSync(process.execPath,
      ["--import", "tsx", "scripts/install-pi-extension.ts"], { env: process.env, stdio: "pipe" }));
    assert.equal(readFileSync(file, "utf8"), "operator data");
  } finally { writeFileSync(file, prior); }
});

test("uninstall-hooks tears down extension even when no Claude hooks remain, without enabling it", () => {
  const settings = join(home, "settings.json"); writeFileSync(settings, "{}\n");
  reconcileExtensionLink(true);
  const args = ["--import", "tsx", "hooks/install.mjs", "--uninstall"];
  const env = { ...process.env, CLAUDE_SETTINGS_PATH: settings };
  const output = execFileSync(process.execPath, args, { env, encoding: "utf8" });
  assert.match(output, /removed extension link/);
  assert.equal(existsSync(link), false);
  execFileSync(process.execPath, ["--import", "tsx", "hooks/install.mjs", "--force"], { env });
  assert.equal(existsSync(link), false, "Claude hook install never opts Pi in");
});

// Exercise destructive calls against a disposable operator home, so a broken guard
// fails the test without harming the actual operator. Preserve inherited test signals.
test("isolation guard refuses exact, dot-dot and symlinked live paths on install and teardown", () => {
  const fake = join(home, "operator"); mkdirSync(fake, { recursive: true });
  const script = `
    import assert from 'node:assert/strict';
    import {mkdirSync,symlinkSync,lstatSync,readlinkSync} from 'node:fs';
    import {join} from 'node:path';
    const {reconcileExtensionLink,uninstallExtensionLink} = await import('./src/server/skills/reconcile.ts');
    const live = join(process.env.HOME,'.pi','agent','extensions');
    mkdirSync(live,{recursive:true});
    const link = join(live,'mission-control.js'); symlinkSync(process.env.MISSION_PI_EXTENSION,link);
    const alias = join(process.env.HOME,'alias'); symlinkSync(join(process.env.HOME,'.pi'),alias);
    for (const path of [live,live+'/../extensions',join(alias,'agent','extensions')]) {
      process.env.PI_EXTENSIONS_DIR = path;
      const inode = lstatSync(link).ino;
      for (const call of [()=>reconcileExtensionLink(true),()=>reconcileExtensionLink(false),uninstallExtensionLink]) {
        assert.throws(call,/refusing to reconcile/);
        assert.equal(lstatSync(link).ino,inode);
        assert.equal(readlinkSync(link),process.env.MISSION_PI_EXTENSION);
      }
    }
    console.log('all three live-path spellings refused; link unchanged');`;
  const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { env: { ...process.env, HOME: fake }, encoding: "utf8" });
  assert.match(output, /link unchanged/);
});

test("real operator paths stay unchanged through a scratch symlink and dot-dot spelling", () => {
  const real = join(homedir(), ...spec.homeDir);
  const snapshot = () => existsSync(real) ? readdirSync(real).sort().map((name) => {
    const path = join(real, name); const stat = lstatSync(path);
    return [name, stat.ino, stat.mtimeMs, stat.size, stat.isSymbolicLink() ? readlinkSync(path) : null];
  }) : null;
  const before = snapshot();
  const alias = join(home, "real-pi-alias");
  // Alias an existing ancestor: fresh CI homes have no .pi directory yet.
  symlinkSync(homedir(), alias, "dir");
  // Inert even if the guard regresses: an absent desired build prevents every write.
  // Never exercise destructive off/teardown against real data; the fake-home test does.
  process.env.MISSION_PI_EXTENSION = join(home, "not-built.js");
  try {
    for (const path of [real, real + "/../extensions", join(alias, ...spec.homeDir)]) {
      process.env.PI_EXTENSIONS_DIR = path;
      assert.throws(() => reconcileExtensionLink(true), /refusing to reconcile/);
      assert.deepEqual(snapshot(), before);
    }
  } finally {
    process.env.MISSION_PI_EXTENSION = target;
    delete process.env.PI_EXTENSIONS_DIR;
  }
});

test("an actual isolated daemon leaves the operator's real extension directory unchanged", async () => {
  const real = join(homedir(), ...spec.homeDir);
  const snapshot = () => existsSync(real) ? readdirSync(real).sort().map((name) => {
    const path = join(real, name); const stat = lstatSync(path);
    return { name, ino: stat.ino, mtime: stat.mtimeMs, size: stat.size, target: stat.isSymbolicLink() ? readlinkSync(path) : null };
  }) : null;
  const before = snapshot();
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  await new Promise<void>((done) => server.close(() => done()));
  const isolated = join(home, "second-daemon");
  const child = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
    env: { ...process.env, MISSION_HOME: isolated, MISSION_PORT: String(address.port), MISSION_POLL_MS: "0", MISSION_SCOUT_RECONCILE_MS: "0" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = ""; child.stdout.on("data", (c) => output += c); child.stderr.on("data", (c) => output += c);
  try {
    const deadline = Date.now() + 25_000;
    while (!output.includes("[mission-control] listening on") && child.exitCode === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.match(output, /\[mission-control\] listening on/);
    assert.deepEqual(snapshot(), before);
    assert.equal(existsSync(join(isolated, spec.isolatedDirName)), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;
    }
  }
  assert.deepEqual(snapshot(), before);
});

test("daemon startup logs failed extension reconciliation and remains available", async () => {
  const isolated = join(home, "failed-startup-reconcile");
  const extensions = join(isolated, spec.isolatedDirName);
  mkdirSync(extensions, { recursive: true });
  const installed = join(extensions, spec.linkName);
  symlinkSync(target, installed);
  const inode = lstatSync(installed).ino;
  const intentFile = join(isolated, "pi-extension.json");
  const malformed = "{ broken installation intent";
  writeFileSync(intentFile, malformed);
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  await new Promise<void>((done) => server.close(() => done()));
  const child = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
    env: { ...process.env, MISSION_HOME: isolated, MISSION_PORT: String(address.port), MISSION_POLL_MS: "0", MISSION_SCOUT_RECONCILE_MS: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = ""; child.stdout.on("data", (c) => output += c); child.stderr.on("data", (c) => output += c);
  try {
    const deadline = Date.now() + 25_000;
    while (!output.includes("[mission-control] listening on") && child.exitCode === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.match(output, /\[extensions\] could not reconcile: SyntaxError/);
    assert.match(output, /\[mission-control\] listening on/);
    const response = await fetch(`http://127.0.0.1:${address.port}/api/health`, { signal: AbortSignal.timeout(5_000) });
    assert.equal(response.status, 200);
    const health = await response.json();
    assert.equal(health.ok, true);
    assert.equal(health.service, "mission-control");
    assert.equal(health.pid, child.pid);
    assert.equal(child.exitCode, null, "reconciliation failure must not stop the daemon");
    assert.equal(lstatSync(installed).ino, inode);
    assert.equal(readlinkSync(installed), target);
    assert.equal(readFileSync(intentFile, "utf8"), malformed);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;
    }
  }
});
