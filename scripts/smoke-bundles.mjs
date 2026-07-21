#!/usr/bin/env node
// Boot the built bundles and prove they actually RUN.
//
// What is at stake: `npm run build` succeeding while the artifact it produced cannot start.
// That is not hypothetical - it shipped. `src/shared/claude-settings.ts` pulls in
// `jsonc-parser`, which has no `exports` map and whose `main` is a UMD build; esbuild's
// default `main-fields` for `platform=node` is `main,module`, so the ESM daemon bundle got
// the UMD copy, whose internal `require("./impl/format")` cannot be resolved statically.
// esbuild emitted a `__require` shim that throws on the first call, and the bundle died on
// its very first line of work:
//
//   Error: Dynamic require of "./impl/format" is not supported
//
// Every gate passed. Typecheck reads source, not the bundle. The unit tests import from
// `src/`. And the build step only asserts that esbuild EMITTED something. The Electron shell
// is the only thing that runs `dist/server/index.mjs`, so the failure surfaced as a packaged
// app that crash-looped - 18,052 stack traces in one operator's daemon.log - while CI stayed
// green. Nothing about the defect was subtle; nothing was looking.
//
// So this is the missing assertion, and it is deliberately the dumbest one that could work:
// start the thing, wait for it to answer, stop it. It does not test behaviour - the unit
// tests do that far better against source. It tests that the bytes we ship are loadable,
// which is the one question a bundler can get wrong and a source-level suite can never ask.
//
// Kept as a script rather than a `node:test` file on purpose: every test in `test/` runs
// against `src/` and passes on a fresh checkout, and one that silently depended on `dist/`
// would fail for anyone who had not built first - reporting a missing build as a broken
// daemon. This runs after `npm run build`, where the artifact is guaranteed to exist.

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Long enough for a cold ESM load of a ~780KB bundle on a slow CI runner. */
const BOOT_TIMEOUT_MS = 30_000;
const POLL_MS = 200;

/**
 * A port unlikely to collide with a developer's running daemon (7317) or anything else on
 * the box. The smoke never talks to a real daemon and must never be mistaken for one.
 */
const PORT = 7519;

function fail(msg) {
  console.error(`[smoke] FAIL: ${msg}`);
  process.exitCode = 1;
}

/**
 * Boot the daemon bundle against a throwaway state dir and wait for `/api/health`.
 *
 * `MISSION_HOME` is a fresh temp dir every run, which is not tidiness: the daemon is the
 * only writer of the SQLite DB, and pointing a smoke run at `~/.mission-control` would have
 * it open the operator's live database - the exact accident `openDb`'s test-runner guard
 * exists to prevent, on a path that guard does not cover.
 */
async function smokeDaemon() {
  const home = await mkdtemp(join(tmpdir(), "mc-smoke-"));
  const child = spawn(process.execPath, ["dist/server/index.mjs"], {
    env: { ...process.env, MISSION_HOME: home, MISSION_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));

  let exited = null;
  child.on("exit", (code, signal) => (exited = { code, signal }));

  try {
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    for (;;) {
      // A crash is reported the moment it happens rather than after the full timeout: the
      // whole failure mode here is a bundle that dies instantly, and making the operator
      // wait 30s to be told so buries the stack trace we actually want them to read.
      if (exited) {
        fail(`the daemon bundle exited (code ${exited.code}, signal ${exited.signal}) instead of listening`);
        console.error(output.trimEnd());
        return;
      }
      if (Date.now() > deadline) {
        fail(`the daemon bundle did not answer /api/health within ${BOOT_TIMEOUT_MS}ms`);
        console.error(output.trimEnd());
        return;
      }
      const res = await fetch(`http://127.0.0.1:${PORT}/api/health`).catch(() => null);
      if (res?.ok) {
        const body = await res.json().catch(() => ({}));
        if (body.service !== "mission-control") {
          fail(`/api/health answered, but as ${JSON.stringify(body.service)}`);
          return;
        }
        console.log(`[smoke] daemon bundle boots and serves /api/health (version ${body.version})`);
        return;
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  } finally {
    if (!exited) child.kill("SIGTERM");
    await rm(home, { recursive: true, force: true });
  }
}

/**
 * Load the MCP bundle far enough to prove it resolves.
 *
 * Only `--version`-style loading, not a session: it speaks stdio JSON-RPC to a parent that
 * is Claude Code, so there is nothing to connect to here. Import-time resolution is the
 * whole of what this file is checking anyway - it bundles the same `@shared` tree the daemon
 * does, so it grows the identical defect the moment it imports `claude-settings.ts`.
 */
async function smokeMcp() {
  const child = spawn(process.execPath, ["dist/mcp/server.mjs"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));

  const result = await new Promise((resolve) => {
    const t = setTimeout(() => resolve({ ok: true }), 3000);
    child.on("exit", (code) => {
      clearTimeout(t);
      resolve({ ok: code === 0, code });
    });
  });
  child.kill("SIGTERM");
  if (!result.ok) {
    fail(`the MCP bundle exited (code ${result.code}) on load`);
    console.error(output.trimEnd());
    return;
  }
  console.log("[smoke] mcp bundle loads");
}

await smokeDaemon();
await smokeMcp();
if (process.exitCode) process.exit(process.exitCode);
console.log("[smoke] ok");
