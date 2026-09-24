#!/usr/bin/env node
// Opt-in macOS acceptance exercise. Only source retrieval and dependency installation
// use the local working snapshot/cache. Bash, compilation, packaging, app swap, Setup,
// the installed Electron runtime and Pi's extension loader all execute for real.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { createServer } from "node:net";
import { chromium, expect } from "@playwright/test";

assert.equal(process.platform, "darwin", "this exercise requires macOS");
assert.equal(process.arch, "arm64", "the desktop package targets Apple Silicon");
const repo = resolve(import.meta.dirname, "..");
const root = mkdtempSync(join(tmpdir(), "mission-pi-desktop-"));
const home = join(root, "home"); const state = join(home, ".mission-control");
const scratch = join(root, "temporary sources"); const bin = join(root, "bin");
for (const dir of [home, scratch, bin]) mkdirSync(dir, { recursive: true });
const evidence = resolve(repo, process.argv[2] ?? ".evidence/pi-integration/desktop"); mkdirSync(evidence, { recursive: true });
const version = JSON.parse(readFileSync(join(repo, "package.json"))).version;
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: repo, encoding: "utf8" }).split("\0").filter(Boolean);
const npm = execFileSync("/usr/bin/which", ["npm"], { encoding: "utf8" }).trim();
const shim = `#!${process.execPath}
import {cpSync,mkdirSync,symlinkSync,writeFileSync} from 'node:fs';
import {basename,dirname,join} from 'node:path'; import {spawnSync} from 'node:child_process';
const args=process.argv.slice(2), tool=basename(process.argv[1]);
const run=(cmd,args)=>{const r=spawnSync(cmd,args,{stdio:'inherit'}); if(r.status!==0) process.exit(r.status??1);};
if(tool==='git') {
 if(args[0]==='clone') {const target=args.at(-1); mkdirSync(join(target,'.git'),{recursive:true});
  for(const name of ${JSON.stringify(files)}) {const dest=join(target,name); mkdirSync(dirname(dest),{recursive:true}); cpSync(join(${JSON.stringify(repo)},name),dest,{recursive:true});}}
 else if(args.includes('get-url')) console.log('https://github.com/teamupstart/mission-control.git');
 else if(args.includes('rev-parse')) console.log(${JSON.stringify(revision)});
 else if(args.includes('symbolic-ref')) console.log('origin/main');
 else if(args.includes('--version')) console.log('git version 2.50.0');
} else if(tool==='gh') { if(args[0]==='release') console.log(${JSON.stringify(JSON.stringify([{ tagName: `v${version}` }]))}); }
else if(tool==='npm') {
 if(args[0]==='ci') symlinkSync(${JSON.stringify(join(repo, "node_modules"))},join(process.cwd(),'node_modules'),'dir');
 else if(args[0]==='run'&&args[1]==='package') {run(${JSON.stringify(npm)},['run','build']);run(process.execPath,[${JSON.stringify(join(repo,"node_modules/electron-builder/cli.js"))},'--mac','dir','--publish','never',...args.slice(3)]);}
 else run(${JSON.stringify(npm)},args);
}
`;
for (const name of ["git", "gh", "npm"]) writeFileSync(join(bin, name), shim, { mode: 0o755 });
const env = { ...process.env, HOME: home, MISSION_HOME: state, TMPDIR: scratch,
  PATH: `${bin}:${process.env.PATH}`, MISSION_NPM_BIN: join(bin, "npm"), MISSION_GH_BIN: join(bin, "gh"),
  // The cached binary is pinned by package-lock; no package/model network is needed.
  ELECTRON_CACHE: join(process.env.HOME, "Library/Caches/electron"),
  ELECTRON_BUILDER_CACHE: join(process.env.HOME, "Library/Caches/electron-builder"),
};
for (const key of Object.keys(env)) if (/^(MISSION|FLEET|HARNESS)_(API_TOKEN|API_TOKEN_FILE|MCP_SERVER|PI_EXTENSION|SESSION_ID|SCOUT_SUBMISSION_CREDENTIAL)$/.test(key)) delete env[key];
let child; let browser;
try {
  console.log("Building current working snapshot through the standard Bash temporary-source installer.");
  execFileSync("/bin/bash", [join(repo, "scripts/install.sh")], { cwd: root, env, stdio: "inherit", timeout: 600_000 });
  assert.deepEqual(readdirSync(scratch).filter(name => /^mission-control-(bootstrap|install)/.test(name)), [], "Bash bootstrap and build source must be deleted");
  const app = join(home, "Applications/Mission Control.app");
  const resources = join(app, "Contents/Resources/app");
  const runtime = join(app, "Contents/MacOS/Mission Control");
  assert.ok(existsSync(runtime));
  const receipt = JSON.parse(readFileSync(join(state, "install-receipt.json")));
  assert.equal(receipt.appPath, app); assert.equal(receipt.installScope, "user");
  assert.equal(existsSync(join(state, "app-src")), false);
  console.log("Installed managed app in isolated ~/Applications; temporary build sources are gone.");
  const portServer = createServer(); portServer.listen(0, "127.0.0.1"); await once(portServer, "listening");
  const port = portServer.address().port; await new Promise(done => portServer.close(done));
  const baseURL = `http://127.0.0.1:${port}`;
  const daemonEnv = { ...env, ELECTRON_RUN_AS_NODE: "1", MISSION_PORT: String(port), MISSION_POLL_MS: "0", MISSION_SCOUT_RECONCILE_MS: "0", MISSION_WORKSPACE_DIRS: join(root, "empty-workspace") };
  mkdirSync(daemonEnv.MISSION_WORKSPACE_DIRS);
  for (const name of ["CLAUDE", "CODEX", "PI"]) daemonEnv[`MISSION_${name}_BIN`] = "/usr/bin/false";
  child = spawn(runtime, [join(resources, "dist/server/index.mjs")], { cwd: root, env: daemonEnv, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", chunk => log += chunk); child.stderr.on("data", chunk => log += chunk);
  const deadline = Date.now() + 30_000; let ready = false;
  while (Date.now() < deadline) {
    try { const health = await (await fetch(`${baseURL}/api/health`)).json(); if (health.pid === child.pid) { ready = true; break; } } catch { /* booting */ }
    if (child.exitCode !== null) break;
    await new Promise(done => setTimeout(done, 100));
  }
  assert.ok(ready, log);
  browser = await chromium.launch(); const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  await page.goto(`${baseURL}/#/settings/setup`);
  await page.getByRole("button", { name: "Close tour picker" }).click();
  const family = page.getByRole("tab", { name: /Agent extensions/ });
  if (await family.count()) await family.click();
  else await page.getByRole("button", { name: /Agent extensions/ }).click();
  const install = page.getByRole("button", { name: "Install Pi integration" });
  await install.waitFor(); await page.screenshot({ path: join(evidence, "packaged-before.png") });
  const response = await Promise.all([page.waitForResponse(r => r.url().endsWith("/api/setup/install")), install.click()]);
  assert.equal(response[0].status(), 200, await response[0].text());
  const checks = await (await fetch(`${baseURL}/api/environment/checks`)).json();
  assert.equal(checks.checks.find(c => c.id === "pi-extension").ready, true);
  await page.getByRole("button", { name: "Re-check" }).click();
  await expect(install).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Re-check" })).toBeEnabled();
  await page.mouse.move(0, 0); await page.getByRole("button", { name: "Re-check" }).blur();
  await page.screenshot({ path: join(evidence, "packaged-installed.png") });
  console.log("Setup installed and verified Pi using only the installed app runtime and bundled generation.");
  // Exercise the installed CLI from a directory outside the build/app, with no tsx/npm.
  execFileSync(runtime, [join(resources, "dist/pi-installer/index.mjs")], { cwd: root, env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "inherit", timeout: 30_000 });
  // The live compatibility check starts Pi in RPC mode, never submits a prompt, and
  // asserts tool registration after automatic .js discovery. No provider is invoked.
  execFileSync(process.execPath, [join(repo, "scripts/check-pi-extension.mjs"), join(repo, "node_modules/.bin/pi"), join(state, "pi-extensions/mission-control.js")], { cwd: root, env, stdio: "inherit", timeout: 30_000 });
  writeFileSync(join(evidence, "daemon.log"), log);
  console.log("PASS: temporary-source Bash package, managed app install, source deletion, Setup publication, installed CLI and fresh Pi tool discovery; zero external model calls.");
} finally {
  await browser?.close();
  if (child && child.exitCode === null && child.signalCode === null) { const done = once(child, "exit"); child.kill("SIGTERM"); await done; }
  rmSync(root, { recursive: true, force: true });
}
