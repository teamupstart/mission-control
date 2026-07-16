#!/usr/bin/env node
// Prepare a freshly-provisioned git worktree for an agent session:
//   1. warm its dependencies, so treehouse's whole promise - not re-paying the
//      install/build cost every time you start a session - actually holds, and
//   2. make sure the repo is gated by no-mistakes, so the session's work still
//      flows through the push gate.
//
// Every step is best-effort and idempotent, and the script always exits 0, so
// it never blocks a worktree from being handed to you. That also makes it safe
// to wire as a treehouse `post_create` hook in ~/.config/treehouse/config.toml
// (repo-level hooks are ignored by treehouse for safety), in which case it runs
// in the new worktree with no arguments.
//
// Usage: node scripts/worktree-setup.mjs [worktree-dir]   (defaults to cwd)

import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { have } from "./lib.mjs";

const dir = process.argv[2] ?? process.cwd();
// MISSION_ names, with the legacy HARNESS_ names still honored.
const skipInstall =
  (process.env.MISSION_WORKTREE_SKIP_INSTALL ?? process.env.HARNESS_WORKTREE_SKIP_INSTALL) === "1";
const skipGate =
  (process.env.MISSION_WORKTREE_SKIP_GATE ?? process.env.HARNESS_WORKTREE_SKIP_GATE) === "1";

const log = (m) => console.log(`  ${m}`);
const warn = (m) => console.warn(`  ⚠ ${m}`);

function silent(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], ...opts }).trim();
}

console.log(`🌳 preparing worktree ${dir}`);

// Must be a real git worktree; if not, there is nothing sensible to do.
try {
  silent("git", ["rev-parse", "--is-inside-work-tree"]);
} catch {
  warn(`${dir} is not a git worktree - skipping setup`);
  process.exit(0);
}

// 1. Warm dependencies. A fresh worktree has no node_modules even though the
// build cache elsewhere is warm, so install once here. Prefer a clean, lockfile-
// exact install when we can.
if (skipInstall) {
  log("dep install skipped (MISSION_WORKTREE_SKIP_INSTALL=1)");
} else if (!existsSync(join(dir, "package.json"))) {
  log("no package.json - skipping dependency install");
} else if (existsSync(join(dir, "node_modules"))) {
  log("node_modules already present - dependencies warm");
} else if (have("npm")) {
  const useCi = existsSync(join(dir, "package-lock.json"));
  log(`installing dependencies (npm ${useCi ? "ci" : "install"})…`);
  try {
    execFileSync("npm", [useCi ? "ci" : "install"], { cwd: dir, stdio: "inherit" });
    log("dependencies installed");
  } catch {
    warn("dependency install failed - run `npm install` in the worktree yourself");
  }
} else {
  warn("npm not found - skipping dependency install");
}

// 2. Gate with no-mistakes. Gating is keyed to the repo's origin, so once the
// backing repo is gated every worktree of it is covered; running init again is a
// harmless refresh. We only try when there is an origin to gate.
if (skipGate) {
  log("no-mistakes gating skipped (MISSION_WORKTREE_SKIP_GATE=1)");
} else if (!have("no-mistakes")) {
  log("no-mistakes not installed - skipping gate (run `make init` to set it up)");
} else {
  let remotes = "";
  try {
    remotes = silent("git", ["remote"]);
  } catch {
    /* not a repo we can read remotes from */
  }
  const remoteList = remotes.split("\n").map((r) => r.trim());
  if (remoteList.includes("no-mistakes")) {
    log("repo already gated by no-mistakes");
  } else if (!remoteList.includes("origin")) {
    log("no origin remote - skipping no-mistakes gate");
  } else {
    log("gating repo with no-mistakes (init)…");
    try {
      execFileSync("no-mistakes", ["init"], { cwd: dir, stdio: "inherit" });
      log("repo gated");
    } catch {
      warn("no-mistakes init failed - gate it manually with `no-mistakes init`");
    }
  }
}

console.log("🌳 worktree ready");
process.exit(0);
