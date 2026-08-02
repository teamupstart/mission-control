#!/usr/bin/env node
// One-time bootstrap that makes Mission Control fully functional and wires up the
// companion tool it builds on:
//
//   • treehouse   - a pool of pre-warmed git worktrees, so parallel agent
//                   sessions never fight over one working tree.
// Steps: install deps, build, wire the Claude status hooks, make sure treehouse
// is installed, and write this repo's treehouse.toml. Every step detects whether
// it is already done, so this is safe to run repeatedly.
//
// Usage: node scripts/init.mjs [--dry-run] [--skip-hooks] [--skip-build]
//   --dry-run     print what each step would do, change nothing
//   --skip-hooks  don't touch ~/.claude/settings.json (the Claude hooks)
//   --skip-build  don't run the web/MCP build

import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { have } from "./lib.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = new Set(process.argv.slice(2));
const dryRun = argv.has("--dry-run");
const skipHooks = argv.has("--skip-hooks");
const skipBuild = argv.has("--skip-build");

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

function cap(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], ...opts }).trim();
  } catch {
    return "";
  }
}
// A clean semver-ish version string from a tool's noisy --version output.
function ver(bin) {
  const raw = cap(bin, ["--version"]) || cap(bin, ["version"]);
  const m = raw.match(/v?\d+\.\d+\.\d+/);
  return m ? m[0] : "version unknown";
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

// 1. Node dependencies -------------------------------------------------------
heading("Node dependencies");
if (existsSync(join(repo, "node_modules"))) {
  ok("node_modules present");
  if (run("npm", ["install", "--no-audit", "--no-fund"])) ok("dependencies up to date");
} else {
  doing("installing dependencies (npm install)…");
  if (run("npm", ["install", "--no-audit", "--no-fund"])) ok("dependencies installed");
}

// 2. Build -------------------------------------------------------------------
heading("Build (web UI + MCP bundle)");
if (skipBuild) {
  ok("skipped (--skip-build)");
} else if (run("npm", ["run", "build"])) {
  ok("built dist/web + dist/mcp");
}

// 3. treehouse (pooled worktrees) --------------------------------------------
heading("treehouse - pooled git worktrees");
if (have("treehouse")) {
  ok(`installed (${ver("treehouse")})`);
} else {
  doing("treehouse not found - installing…");
  const installed = have("go")
    ? run("go", ["install", "github.com/kunchenguid/treehouse@latest"])
    : run("sh", ["-c", "curl -fsSL https://kunchenguid.github.io/treehouse/install.sh | sh"]);
  if (installed && !dryRun && !have("treehouse")) {
    warn("treehouse installed but not on PATH - add its bin dir (e.g. ~/.local/bin or `go env GOPATH`/bin) to PATH");
  } else if (installed) {
    ok("treehouse installed");
  }
}
// Repo-level pool config (safe settings only; treehouse ignores hooks here).
if (existsSync(join(repo, "treehouse.toml"))) {
  ok("treehouse.toml present");
} else if (dryRun) {
  doing("[dry-run] would run `treehouse init` to create treehouse.toml");
} else if (have("treehouse") && run("treehouse", ["init"])) {
  ok("wrote treehouse.toml");
}

// 4. Claude status hooks -----------------------------------------------------
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
