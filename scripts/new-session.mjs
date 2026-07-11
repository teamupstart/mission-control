#!/usr/bin/env node
// Start a new agent session in its own pre-warmed, no-mistakes-gated worktree.
//
// It leases a worktree from this repo's treehouse pool (creating one if the pool
// is empty, up to max_trees), prepares it (warm deps + gate), and then drops you
// into it - so two agents never share one working tree, which is exactly the
// clobbering this harness exists to watch for.
//
// Usage: node scripts/new-session.mjs [--holder <label>] [-- <command…>]
//   (no command)     open your $SHELL in the worktree
//   -- claude        launch an agent directly in the worktree
//   --holder <label> record who holds the lease (default: fleet-control)
//
// The lease is durable: the worktree stays yours after you exit, so a
// backgrounded agent keeps its tree. Release it later with:
//   treehouse return <path>

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

// --- args -------------------------------------------------------------------
const args = process.argv.slice(2);
let holder = "fleet-control";
let command = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--") {
    command = args.slice(i + 1);
    break;
  }
  if (args[i] === "--holder") {
    holder = args[++i] ?? holder;
  }
}

function have(bin) {
  try {
    execFileSync("which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

if (!have("treehouse")) {
  console.error("treehouse is not installed. Run `make init` (or see https://github.com/kunchenguid/treehouse).");
  process.exit(1);
}

// --- acquire a worktree -----------------------------------------------------
// `get --lease` prints only the absolute path on stdout; its banners go to
// stderr, which we let through.
console.error("🌳 acquiring a worktree from the pool…");
let worktree;
try {
  worktree = execFileSync("treehouse", ["get", "--lease", "--lease-holder", holder], {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
} catch (err) {
  console.error(`Failed to acquire a worktree: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
if (!worktree) {
  console.error("treehouse did not return a worktree path.");
  process.exit(1);
}

// --- prepare it -------------------------------------------------------------
spawnSync(process.execPath, [join(repo, "scripts", "worktree-setup.mjs"), worktree], { stdio: "inherit" });

// --- hand it over -----------------------------------------------------------
const env = { ...process.env, FLEET_WORKTREE: worktree, TREEHOUSE_LEASE_HOLDER: holder };
const [cmd, ...rest] = command.length > 0 ? command : [process.env.SHELL || "/bin/bash"];
console.error(`\n🌳 session ready in ${worktree}\n   (lease held by "${holder}"; return it later with: treehouse return ${worktree})\n`);

const result = spawnSync(cmd, rest, { cwd: worktree, stdio: "inherit", env });

console.error(`\n🌳 left ${worktree} - still leased to you. Return it with: treehouse return ${worktree}`);
process.exit(result.status ?? 0);
