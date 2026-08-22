#!/usr/bin/env node
// One-time bootstrap that makes Mission Control fully functional.
// Steps: install deps, build, and wire the Claude status hooks. Every step detects whether
// it is already done, so this is safe to run repeatedly.
//
// Usage: node scripts/init.mjs [--dry-run] [--skip-hooks] [--skip-build] [--with-e2e]
//   --dry-run     print what each step would do, change nothing
//   --skip-hooks  don't touch ~/.claude/settings.json (the Claude hooks)
//   --skip-build  don't run the web/MCP build
//   --with-e2e    also require the Playwright Chromium browser for browser tests

import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chromiumPrerequisiteMessage,
  nodePrerequisiteMessage,
  xcodeToolsPrerequisiteMessage,
} from "./init-prerequisites.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = new Set(process.argv.slice(2));
const dryRun = argv.has("--dry-run");
const skipHooks = argv.has("--skip-hooks");
const skipBuild = argv.has("--skip-build");
const withE2e = argv.has("--with-e2e");

let stepNo = 0;
const problems = [];

function heading(title) {
  stepNo += 1;
  console.log(`\n\x1b[1m${stepNo}. ${title}\x1b[0m`);
}
const ok = (m) => console.log(`   \x1b[32m✓\x1b[0m ${m}`);
const doing = (m) => console.log(`   \x1b[36m→\x1b[0m ${m}`);
const warn = (m) => {
  console.log(`   \x1b[33m⚠\x1b[0m ${m}`);
  problems.push(m);
};

function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

async function chromiumPath() {
  try {
    const { chromium } = await import("@playwright/test");
    const path = chromium.executablePath();
    return existsSync(path) ? path : null;
  } catch {
    return null;
  }
}

// Run a command for real, unless --dry-run, in which case just print it.
function run(cmd, args, opts = {}) {
  if (dryRun) {
    doing(`[dry-run] ${cmd} ${args.join(" ")}`);
    return true;
  }
  try {
    execFileSync(cmd, args, { cwd: repo, stdio: "inherit", ...opts });
    return true;
  } catch (err) {
    warn(`\`${cmd} ${args.join(" ")}\` failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

console.log(`\x1b[1mMission Control · init\x1b[0m${dryRun ? "  (dry-run)" : ""}`);
console.log(`repo: ${repo}`);

// 1. Runtime prerequisite -----------------------------------------------------
heading("Node.js prerequisite");
const nodeProblem = nodePrerequisiteMessage(process.versions.node);
if (nodeProblem) fail(nodeProblem);
ok(`Node.js ${process.versions.node}`);

// 2. Toolchain prerequisite ---------------------------------------------------
// The build below compiles native/keep-awake with node-gyp, and this script's `run()` only
// warns on failure. So without the tools the build warns past node-gyp, `dist/native` is never
// written, and the daemon refuses to start later on an artifact that was never produced.
// Not asked when `--skip-build` means no native build is going to happen at all.
if (!skipBuild) {
  heading("Xcode command line tools prerequisite");
  const xcodeProblem = xcodeToolsPrerequisiteMessage({
    platform: process.platform,
    installed: spawnSync("xcode-select", ["-p"], { encoding: "utf8" }).status === 0,
  });
  if (xcodeProblem) fail(xcodeProblem);
  ok("Xcode command line tools available");
}

// 3. Node dependencies -------------------------------------------------------
heading("Node dependencies");
if (existsSync(join(repo, "node_modules"))) {
  ok("node_modules present");
  if (run("npm", ["install", "--no-audit", "--no-fund"])) ok("dependencies up to date");
} else {
  doing("installing dependencies (npm install)…");
  if (run("npm", ["install", "--no-audit", "--no-fund"])) ok("dependencies installed");
}

// 4. Browser prerequisite -----------------------------------------------------
if (withE2e) {
  heading("Playwright Chromium prerequisite");
  const path = await chromiumPath();
  if (!path) fail(chromiumPrerequisiteMessage());
  ok(`Chromium available (${path})`);
}

// 5. Build -------------------------------------------------------------------
heading("Build (web UI + MCP bundle)");
if (skipBuild) {
  ok("skipped (--skip-build)");
} else if (run("npm", ["run", "build"])) {
  ok("built dist/web + dist/mcp");
}

// 6. Claude status hooks -----------------------------------------------------
heading("Claude status hooks");
if (skipHooks) {
  ok("skipped (--skip-hooks) - wire later with `npm run install-hooks`");
} else {
  doing("wiring hooks into ~/.claude/settings.json (idempotent; preserves your other hooks)…");
  if (run("npm", ["run", "install-hooks"])) ok("hooks installed");
}

// Summary --------------------------------------------------------------------
console.log("\n\x1b[1m─ summary ─\x1b[0m");
if (problems.length === 0) {
  console.log("\x1b[32mHarness initialized.\x1b[0m");
} else {
  console.log(`\x1b[33m${problems.length} thing(s) need your attention:\x1b[0m`);
  for (const p of problems) console.log(`  • ${p}`);
}
console.log("\nNext:");
console.log("  make dev       # daemon + dashboard (http://127.0.0.1:5173)");
console.log("  make session   # start an agent in a fresh worktree");
if (dryRun) console.log("\n(dry-run: nothing was changed)");
