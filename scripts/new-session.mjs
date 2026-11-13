#!/usr/bin/env node
// Acquire and retain one daemon-owned native worktree for manual development.
//
// Usage:
//   node scripts/new-session.mjs [--label <text>] [-- <command...>]
//   node scripts/new-session.mjs --return <lease-id>
//   node scripts/new-session.mjs --return-lease <id>

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { BASE_URL } from "../src/shared/harness-runtime.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
let label;
let returnLeaseId;
let returnOption;
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
    if (returnOption) {
      console.error("choose either --return or --return-lease");
      process.exit(2);
    }
    returnOption = arg;
    returnLeaseId = args[++i];
    if (!returnLeaseId) {
      console.error("--return requires a lease ID");
      process.exit(2);
    }
    continue;
  }
  if (arg === "--return-lease") {
    if (returnOption) {
      console.error("choose either --return or --return-lease");
      process.exit(2);
    }
    returnOption = arg;
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

if (returnLeaseId && (label || command.length > 0)) {
  console.error("return actions cannot also launch a session");
  process.exit(2);
}

const NOT_RUNNING =
  "Mission Control is not running. Start it with `make up`, `make dev`, or the application, then retry.";
/** How often a claiming acquire is polled. */
const POLL_MS = 2_000;
/**
 * How long polling rides out a daemon that stopped answering before giving up, measured from
 * the start of the first poll that went unanswered.
 */
const UNREACHABLE_LIMIT_MS = 60_000;
/**
 * The most one status poll may take, headers and body together. A daemon that accepts the
 * connection and never answers would otherwise hold a poll open forever, and the outage limit
 * above could never be reached.
 */
const POLL_REQUEST_TIMEOUT_MS = 5_000;
/** Without a terminal to redraw, progress is printed when the step changes and this often. */
const PLAIN_PROGRESS_MS = 30_000;

/**
 * One loopback request. Null when the daemon could not be reached, or, with `timeoutMs`, did
 * not finish answering in time.
 */
async function call(method, path, body, timeoutMs) {
  const signal = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
      ...(signal ? { signal } : {}),
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
  } catch {
    return null;
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    // A body cut off by the deadline is an unanswered request, not an empty answer.
    if (signal?.aborted) return null;
    payload = {};
  }
  return { status: response.status, payload };
}

async function post(path, body) {
  const answered = await call("POST", path, body);
  if (!answered) {
    console.error(NOT_RUNNING);
    process.exit(1);
  }
  if (answered.status < 200 || answered.status > 299) {
    console.error(answered.payload.error ?? `Mission Control returned HTTP ${answered.status}`);
    process.exit(1);
  }
  return answered;
}

if (returnLeaseId) {
  const { payload: result } = await post("/api/worktrees/manual/return", { leaseId: returnLeaseId });
  console.error(result.alreadyReleased ? "🌳 lease was already returned" : "🌳 worktree returned");
  process.exit(0);
}

function elapsed(ms) {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} elapsed`;
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/**
 * Poll a manual acquire the daemon accepted with 202, because the pool's dependency claim may
 * outlast one HTTP request, until the lease is granted or the acquire failed.
 */
async function awaitGrant(requestId) {
  const redraw = process.stderr.isTTY === true;
  const statusPath = `/api/worktrees/manual/requests/${encodeURIComponent(requestId)}`;
  let lastLabel = null;
  let lastPrintedAt = 0;
  let unreachableSince = null;
  let drawn = false;
  const endLine = () => {
    if (drawn) process.stderr.write("\n");
    drawn = false;
  };
  for (;;) {
    const askedAt = Date.now();
    const answered = await call("GET", statusPath, undefined, POLL_REQUEST_TIMEOUT_MS);
    if (!answered) {
      // From when this poll was sent, so time spent waiting on a stalled one counts too.
      unreachableSince ??= askedAt;
      if (Date.now() - unreachableSince >= UNREACHABLE_LIMIT_MS) {
        endLine();
        console.error(
          "Mission Control stopped answering while it prepared this worktree. Once it is running again, " +
            "the slot it was preparing is recovered at startup; run make session again.",
        );
        process.exit(1);
      }
      await sleep(POLL_MS);
      continue;
    }
    unreachableSince = null;
    const { status, payload } = answered;
    if (status === 404) {
      // Requests live in daemon memory, so a request it accepted with 202 and no longer knows
      // means the daemon restarted in between.
      endLine();
      console.error(
        "Mission Control restarted while it was installing this worktree's dependencies, so this " +
          "request was lost. The slot it was preparing is recovered at startup; run make session again.",
      );
      process.exit(1);
    }
    if (status !== 200) {
      endLine();
      console.error(payload.error ?? `Mission Control returned HTTP ${status}`);
      process.exit(1);
    }
    if (payload.state === "granted") {
      endLine();
      return payload;
    }
    if (payload.state === "failed") {
      endLine();
      console.error(payload.reason ?? "Mission Control could not acquire a worktree.");
      process.exit(1);
    }
    const label = payload.step
      ? `installing dependencies: step ${payload.step.step} of ${payload.step.stepCount} (${payload.step.command})`
      : "preparing the worktree";
    const line = `🌳 ${label} · ${elapsed(payload.elapsedMs ?? 0)}`;
    if (redraw) {
      process.stderr.write(`\r\x1b[K${line}`);
      drawn = true;
    } else if (label !== lastLabel || Date.now() - lastPrintedAt >= PLAIN_PROGRESS_MS) {
      console.error(line);
      lastPrintedAt = Date.now();
    }
    lastLabel = label;
    await sleep(POLL_MS);
  }
}

console.error("🌳 acquiring a native Mission Control worktree...");
const accepted = await post("/api/worktrees/manual/acquire", {
  repositoryPath: repo,
  ...(label ? { label } : {}),
});
// 201 is a pool with no dependency claim, answered at once. 202 is a pool with one: the daemon
// acquires in the background, and this polls until the lease is granted or the acquire failed.
let acquired = accepted.payload;
if (accepted.status === 202) {
  if (typeof accepted.payload.requestId !== "string") {
    console.error("Mission Control accepted the request without a request ID.");
    process.exit(1);
  }
  const granted = await awaitGrant(accepted.payload.requestId);
  acquired = granted.lease ?? {};
  const warning = granted.claimWarning;
  if (warning) {
    console.error(
      `⚠️  the dependency claim failed: step ${warning.step} of ${warning.stepCount} (${warning.command}) ${warning.reason}`,
    );
    if (warning.tail?.trim()) console.error(warning.tail.trimEnd().replace(/^/gm, "   "));
    console.error("   The worktree is yours anyway. Its next lease runs the claim again.");
  }
}
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
