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
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Long enough for a cold ESM load of a ~780KB bundle on a slow CI runner. */
const BOOT_TIMEOUT_MS = 30_000;
const POLL_MS = 200;

/** Same budget, for the MCP bundle's cold load plus two round-trips. */
const MCP_HANDSHAKE_MS = 30_000;

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
 * Speak MCP to the bundle and prove it publishes exactly the tools this build declares.
 *
 * This used to spawn the bundle, wait 3s, and pass if it had not exited. That is a liveness
 * check, and liveness was never the failing property. What actually shipped: `dist/mcp/server.mjs`
 * built six days before `submit_scout_artifacts` landed in source, serving its other seven tools
 * perfectly - loading, running, answering, and missing the one tool a scout is REQUIRED to call
 * to finish its task. A scout landing on it is told to call a tool it was never given, and its
 * task deadlocks with no error and no warning anywhere. The old check passed that bundle, because
 * the bundle was alive. It was just wrong.
 *
 * So it now completes a real `initialize` + `tools/list` and compares the published names against
 * `MISSION_MCP_TOOLS` - the same list every launch pre-approves from. Both directions are failures
 * and they are different bugs: a tool the list declares and the server does not publish is the
 * stale-bundle deadlock above, and a tool the server publishes that the list omits is a tool no
 * launch can ever pre-approve, so calling it stops the agent on a permission prompt.
 *
 * The list is read out of SOURCE while the tools are read out of the BUNDLE, and that is the
 * point - it is the one comparison neither the unit suite (which reads only source, and says so
 * in `mission-mcp.test.ts`) nor a bundler can make.
 *
 * Note what this does NOT protect. It runs after `npm run build`, where a stale bundle is
 * impossible by construction, so it guards the artifact we ship rather than the operator's
 * `dist/`. The daemon's own startup check and the dispatch guard in `mission-mcp.ts` cover that.
 */
async function smokeMcp() {
  const child = spawn(process.execPath, ["dist/mcp/server.mjs"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));

  const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
  const result = await new Promise((resolve) => {
    let pending = "";
    let exited = false;
    const done = (value) => {
      clearTimeout(timer);
      if (!exited) child.kill("SIGTERM");
      resolve(value);
    };
    const timer = setTimeout(
      () => done({ error: `it did not answer initialize + tools/list within ${MCP_HANDSHAKE_MS}ms` }),
      MCP_HANDSHAKE_MS,
    );
    child.on("error", (err) => done({ error: `it could not be started (${err.message})` }));
    // EPIPE on a stream with no `error` listener is an uncaught exception, and a bundle that
    // dies on load closes stdin under our first write. That must be reported as a failed
    // handshake, not as a crashed smoke run.
    child.stdin.on("error", (err) => done({ error: `its stdin closed (${err.message})` }));
    child.on("exit", (code, signal) => {
      exited = true;
      done({ error: `it exited (code ${code}, signal ${signal}) during the handshake` });
    });
    child.stdout.on("data", (d) => {
      pending += d;
      for (;;) {
        const nl = pending.indexOf("\n");
        if (nl === -1) break;
        const line = pending.slice(0, nl).trim();
        pending = pending.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // Tolerate a banner on stdout.
        }
        if (msg.id === 1) {
          if (msg.error) return done({ error: `it refused initialize (${msg.error.message})` });
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        } else if (msg.id === 2) {
          if (msg.error) return done({ error: `it refused tools/list (${msg.error.message})` });
          const tools = msg.result?.tools;
          if (!Array.isArray(tools)) return done({ error: "its tools/list answer carried no tool array" });
          done({ tools: tools.map((t) => t.name).filter((n) => typeof n === "string") });
        }
      }
    });
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "mission-control-smoke", version: "1" },
      },
    });
  });

  if (result.error) {
    fail(`the MCP bundle did not complete an MCP handshake: ${result.error}`);
    if (stderr.trim()) console.error(stderr.trimEnd());
    return;
  }

  const declared = await declaredMcpTools();
  if (!declared) return;
  const published = new Set(result.tools);
  const missing = declared.filter((t) => !published.has(t));
  const extra = [...published].filter((t) => !declared.includes(t));
  if (missing.length) {
    fail(
      `MISSION_MCP_TOOLS declares ${missing.join(", ")}, which the MCP bundle does not publish - ` +
        `a launch pre-approves the name and the agent then finds no such tool, which is a task ` +
        `that deadlocks rather than one that fails`,
    );
  }
  if (extra.length) {
    fail(
      `the MCP bundle publishes ${extra.join(", ")}, which MISSION_MCP_TOOLS does not declare - ` +
        `no launch can pre-approve a name that is not on that list, so calling it stops the ` +
        `agent on a permission prompt`,
    );
  }
  if (missing.length || extra.length) return;
  console.log(`[smoke] mcp bundle publishes all ${declared.length} declared tools`);
}

/**
 * The tool names this build DECLARES, read from `mission-mcp.ts` rather than duplicated here.
 *
 * A scrape rather than an import because this script is plain `node` with no TypeScript
 * loader, and the alternative - a hand-copied list in a smoke script - is a fourth place the
 * vocabulary can drift, which is the exact class of bug the check above exists to catch.
 * The two constants it has to resolve live in their own single-spelling modules, so they are
 * read from there for the same reason.
 */
async function declaredMcpTools() {
  const read = async (path) => await readFile(resolve(path), "utf8");
  const source = await read("src/server/mission-mcp.ts");
  const block = /export const MISSION_MCP_TOOLS = \[([\s\S]*?)\] as const;/.exec(source)?.[1];
  if (!block) {
    fail("MISSION_MCP_TOOLS could not be read out of src/server/mission-mcp.ts - has it been renamed?");
    return null;
  }
  const tools = [];
  for (const line of block.split("\n")) {
    const literal = /^\s*"([a-z_]+)",/.exec(line);
    if (literal) {
      tools.push(literal[1]);
      continue;
    }
    // The two submission tools arrive as imported constants, each named in exactly one module.
    const ref = /^\s*([A-Z_]+),/.exec(line);
    if (!ref) continue;
    const from = {
      SUBMIT_ENSEMBLE_RESULT_TOOL: "src/server/ensembles/submission-tool.ts",
      SUBMIT_SCOUT_ARTIFACTS_TOOL: "src/server/scouts/submission-tool.ts",
    }[ref[1]];
    if (!from) {
      fail(`MISSION_MCP_TOOLS names ${ref[1]}, which this smoke does not know how to resolve`);
      return null;
    }
    const value = new RegExp(String.raw`export const ${ref[1]} = "([a-z_]+)"`).exec(await read(from))?.[1];
    if (!value) {
      fail(`${ref[1]} could not be read out of ${from}`);
      return null;
    }
    tools.push(value);
  }
  if (!tools.length) {
    fail("MISSION_MCP_TOOLS scraped empty - has its shape changed?");
    return null;
  }
  return tools;
}

/**
 * Prove the satellite paths the DAEMON BUNDLE computes land on the bundles we just built.
 *
 * The failure this catches has already shipped once, for the Codex hook bridge: the
 * specifier was written from a module four levels down in the source tree, esbuild
 * collapsed everything into `dist/server/index.mjs`, and `import.meta.url` became that one
 * file's - so the path resolved above the repo, `existsSync` failed, and every packaged
 * build silently launched Codex uninstrumented. The designed fallback, firing for a reason
 * that is not the designed one. Nothing was looking: typecheck reads source, the unit tests
 * import from `src/`, and a path that merely does not exist throws nothing.
 *
 * So this reads the specifiers out of the built bundle and resolves them relative to the
 * bundle's own location, which is exactly what the daemon does at runtime. It is the one
 * question a source-level suite cannot ask, and the two answers it checks - the MCP server
 * a dispatched session is pointed at, and the hook bridge a dispatched Codex session runs -
 * are both launch paths whose failure mode is silence.
 */
async function smokeSatellitePaths() {
  const bundle = resolve("dist/server/index.mjs");
  const source = await readFile(bundle, "utf8");
  const expected = [
    ["MCP server", "dist/mcp/server.mjs"],
    ["Codex hook bridge", "dist/satellites/codex-hook.mjs"],
  ];
  for (const [label, built] of expected) {
    const m = new RegExp(String.raw`new URL\d*\("([^"]*${built.replace(/[./]/g, "\\$&")})", *import\.meta\.url\)`)
      .exec(source);
    if (!m) {
      fail(`the daemon bundle computes no path for the ${label} - has its resolver been renamed?`);
      continue;
    }
    const resolved = fileURLToPath(new URL(m[1], pathToFileURL(bundle)));
    if (resolved !== resolve(built)) {
      fail(`the daemon bundle resolves the ${label} to ${resolved}, but it was built at ${resolve(built)}`);
      continue;
    }
    if (!existsSync(resolved)) {
      fail(`the daemon bundle resolves the ${label} to ${resolved}, which does not exist`);
      continue;
    }
    console.log(`[smoke] daemon bundle resolves the ${label} to the built artifact`);
  }
}

await smokeDaemon();
await smokeMcp();
await smokeSatellitePaths();
if (process.exitCode) process.exit(process.exitCode);
console.log("[smoke] ok");
