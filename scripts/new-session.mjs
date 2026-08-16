#!/usr/bin/env node
// Acquire and retain one daemon-owned native worktree for manual development.
//
// Usage:
//   node scripts/new-session.mjs [--label <text>] [-- <command...>]
//   node scripts/new-session.mjs --return <path>
//   node scripts/new-session.mjs --return-lease <id>

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { BASE_URL } from "../src/shared/harness-runtime.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
let label;
let returnPath;
let returnLeaseId;
let command = [];

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--") {
    command = args.slice(i + 1);
    break;
  }
  if (arg === "--label") {
    label = args[++i];
    if (!label) {
      console.error("--label requires a value");
      process.exit(2);
    }
    continue;
  }
  if (arg === "--return") {
    returnPath = args[++i];
    if (!returnPath) {
      console.error("--return requires a worktree path");
      process.exit(2);
    }
    continue;
  }
  if (arg === "--return-lease") {
    returnLeaseId = args[++i];
    if (!returnLeaseId) {
      console.error("--return-lease requires a lease ID");
      process.exit(2);
    }
    continue;
  }
  console.error(`unknown argument: ${arg}`);
  process.exit(2);
}

if (returnPath && returnLeaseId) {
  console.error("choose either --return or --return-lease");
  process.exit(2);
}
if ((returnPath || returnLeaseId) && (label || command.length > 0)) {
  console.error("return actions cannot also launch a session");
  process.exit(2);
}

async function post(path, body) {
  let response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    console.error("Mission Control is not running. Start it with `make up`, `make dev`, or the application, then retry.");
    process.exit(1);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error(payload.error ?? `Mission Control returned HTTP ${response.status}`);
    process.exit(1);
  }
  return payload;
}

if (returnPath || returnLeaseId) {
  const result = await post("/api/worktrees/manual/return", returnPath
    ? { path: returnPath }
    : { leaseId: returnLeaseId });
  console.error(result.alreadyReleased ? "🌳 lease was already returned" : "🌳 worktree returned");
  process.exit(0);
}

console.error("🌳 acquiring a native Mission Control worktree...");
const acquired = await post("/api/worktrees/manual/acquire", {
  repositoryPath: repo,
  ...(label ? { label } : {}),
});
const worktree = acquired.path;
const leaseId = acquired.leaseId;
if (typeof worktree !== "string" || typeof leaseId !== "string") {
  console.error("Mission Control returned an invalid manual lease.");
  process.exit(1);
}

// Keep the established checkout-local warmup. The daemon owns allocation; this explicit
// client step still prepares this repository before handing it to the operator.
spawnSync(process.execPath, [join(repo, "scripts", "worktree-setup.mjs"), worktree], {
  stdio: "inherit",
});

const env = {
  ...process.env,
  MISSION_WORKTREE: worktree,
  MISSION_WORKTREE_LEASE_ID: leaseId,
};
delete env.TREEHOUSE_LEASE_HOLDER;
const [cmd, ...rest] = command.length > 0 ? command : [process.env.SHELL || "/bin/bash"];
console.error(
  `\n🌳 session ready in ${worktree}\n` +
    `   Return it later with: make session ARGS="--return-lease ${leaseId}"\n` +
    "   A future Settings > Worktrees panel will offer the same action.\n",
);

const result = spawnSync(cmd, rest, { cwd: worktree, stdio: "inherit", env });

console.error(
  `\n🌳 left ${worktree} - still leased to you.\n` +
    `   Return it with: make session ARGS="--return-lease ${leaseId}"`,
);
process.exit(result.status ?? 0);
