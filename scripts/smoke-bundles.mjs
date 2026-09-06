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

import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

/** How long a bundle gets to honour SIGTERM before it is killed outright. */
const KILL_GRACE_MS = 2_000;

/**
 * End a spawned bundle for good, and do not return until it is actually gone.
 *
 * `SIGTERM` is a request, and the bundles this script exists to catch are the ones least likely
 * to honour it. A smoke that sends one and moves on leaves the child alive with its stdio pipes
 * attached to us, which keeps the event loop open and means `npm run smoke` never exits. A hung
 * build is not a red build: it burns the job's whole timeout and reports nothing useful.
 *
 * AWAITED, and deliberately NOT `unref`'d - which is where this differs from its counterpart in
 * `src/server/mission-mcp.ts`, and why the two cannot share one implementation. The daemon is a
 * long-lived process that must never be held open by a dying probe, so unref is right there.
 * This is a short-lived CLI with the opposite hazard: on the success path nothing else is
 * referenced by the time this returns, so an unref'd escalation timer lets node exit BEFORE the
 * SIGKILL is ever delivered. The smoke then reports a clean run while leaving the orphan behind
 * - exactly the malformed-bundle case the reaper exists for, silently unhandled. Observed: two
 * such orphans survived a "successful" smoke run against a SIGTERM-trapping bundle.
 *
 * So the child stays referenced and this awaits its `exit` UNCONDITIONALLY. There is no
 * give-up path on purpose: returning early while the process is still alive would be this
 * function reporting a reap it did not perform, which is the same false assurance in a
 * different disguise. `SIGKILL` cannot be trapped, so the only way to outlive it is a state no
 * userland retry could fix anyway - and a build that stops with an obvious hung teardown is
 * more honest than one that prints "ok" over a live orphan.
 */
async function reap(child) {
  for (const stream of [child.stdout, child.stderr, child.stdin]) {
    stream?.removeAllListeners("data");
    // `destroy()` and a racing EPIPE both emit `error`, and an `error` with no listener throws.
    stream?.on("error", () => {});
    stream?.destroy();
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  // Attached BEFORE the signal, so a child that dies instantly cannot settle between the check
  // above and the listener below and leave this waiting on an event that already fired.
  const exited = new Promise((r) => child.once("exit", () => r()));
  child.kill("SIGTERM");
  // An interval rather than one shot: it keeps escalating for as long as the child is there,
  // and being referenced it also keeps this process alive to deliver them.
  const escalate = setInterval(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, KILL_GRACE_MS);
  try {
    await exited;
  } finally {
    clearInterval(escalate);
  }
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
        await smokeForeman(home);
        return;
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  } finally {
    await reap(child);
    await rm(home, { recursive: true, force: true });
  }
}

/**
 * Boot the exact Foreman artifact the packaged Electron app supervises and prove it acquires
 * the daemon lease. A source-level worker test cannot catch a missing build entry or a main
 * process pointing at an artifact the package never produced.
 *
 * The smoke database is empty and backlog autopilot is off, so this starts no agent and spends
 * no model tokens. It only exercises the worker's load, HTTP, and lease boundaries.
 */
async function smokeForeman(home) {
  const child = spawn(process.execPath, ["dist/server/foreman-worker.mjs"], {
    env: { ...process.env, MISSION_HOME: home, MISSION_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (data) => (output += data));
  child.stderr.on("data", (data) => (output += data));
  let exited = null;
  child.on("exit", (code, signal) => (exited = { code, signal }));

  try {
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    for (;;) {
      if (exited) {
        fail(
          `the Foreman bundle exited (code ${exited.code}, signal ${exited.signal}) ` +
            "instead of acquiring its lease",
        );
        console.error(output.trimEnd());
        return;
      }
      if (Date.now() > deadline) {
        fail(`the Foreman bundle did not acquire its lease within ${BOOT_TIMEOUT_MS}ms`);
        console.error(output.trimEnd());
        return;
      }
      const res = await fetch(`http://127.0.0.1:${PORT}/api/foreman/status`).catch(() => null);
      if (res?.ok) {
        const body = await res.json().catch(() => ({}));
        if (body.running === true) {
          console.log("[smoke] Foreman bundle boots and acquires the daemon lease");
          return;
        }
      }
      await new Promise((resolvePoll) => setTimeout(resolvePoll, POLL_MS));
    }
  } finally {
    await reap(child);
  }
}

/**
 * Loading the Darwin addon must be side-effect free. Requiring it and checking its
 * surface proves the artifact path and Node-API ABI without calling `create`, so smoke
 * never changes the host's power state.
 */
async function smokeNativeKeepAwake() {
  if (process.platform !== "darwin") {
    console.log(`[smoke] native Keep Awake addon deliberately skipped on ${process.platform}`);
    return;
  }
  const addonPath = resolve("dist/native/keep-awake.node");
  if (!existsSync(addonPath)) {
    fail(`the Darwin build is missing ${addonPath}`);
    return;
  }
  let binding;
  try {
    binding = createRequire(import.meta.url)(addonPath);
  } catch (err) {
    fail(`the native Keep Awake addon could not load (${err instanceof Error ? err.message : err})`);
    return;
  }
  if (typeof binding?.create !== "function" || typeof binding?.release !== "function") {
    fail("the native Keep Awake addon does not export create and release functions");
    return;
  }
  console.log("[smoke] native Keep Awake addon loads without creating an assertion");
}

/**
 * Pin the packaged main process to the Foreman artifact. Booting the worker proves the bundle;
 * this check proves Electron actually names it, which is the seam that left the installed app
 * healthy while its scheduler never existed.
 */
async function smokeDesktopBackgroundPaths() {
  const mainPath = resolve("dist/main/index.cjs");
  const foremanPath = resolve("dist/server/foreman-worker.mjs");
  if (!existsSync(mainPath) || !existsSync(foremanPath)) {
    fail("the desktop build is missing its main process or Foreman worker bundle");
    return;
  }
  const main = await readFile(mainPath, "utf8");
  if (!main.includes("foreman-worker.mjs") || !main.includes("mission-control-foreman")) {
    fail("the Electron main bundle does not supervise the built Foreman worker");
    return;
  }
  console.log("[smoke] Electron main bundle supervises the built Foreman worker");
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
    const done = (value) => {
      clearTimeout(timer);
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
          done({ tools });
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

  // Awaited before anything is reported, so the child is confirmed gone on every path -
  // including the successful one, where nothing else would keep this process alive.
  await reap(child);

  if (result.error) {
    fail(`the MCP bundle did not complete an MCP handshake: ${result.error}`);
    if (stderr.trim()) console.error(stderr.trimEnd());
    return;
  }

  const declared = await declaredMcpTools();
  if (!declared) return;
  const published = new Set(
    result.tools.map((tool) => tool.name).filter((name) => typeof name === "string"),
  );
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
  const createTask = result.tools.find((tool) => tool.name === "create_task");
  const properties = createTask?.inputSchema?.properties;
  if (!properties?.repository || !properties?.additionalRepositories) {
    fail(
      "the built create_task schema does not publish repository and additionalRepositories - " +
        "the daemon supports cross-repository tasks but the bundled agent tool cannot request one",
    );
    return;
  }
  const extraRepoLimit = await declaredTaskExtraRepoLimit();
  if (extraRepoLimit === null) return;
  if (properties.additionalRepositories.maxItems !== extraRepoLimit) {
    fail(
      "the built create_task schema does not preserve MAX_TASK_EXTRA_REPOS from the shared contract",
    );
    return;
  }
  console.log(`[smoke] mcp bundle publishes all ${declared.length} declared tools`);
}

/** Prove the separate credential-free repository MCP publishes and executes eight tools. */
async function smokeRepositoryMcp() {
  const root = await mkdtemp(join(tmpdir(), "mc-repository-mcp-smoke-"));
  const auditPath = join(root, "audit.jsonl");
  const configPath = join(root, "config.json");
  try {
    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", ["-C", root, "config", "user.email", "smoke@example.test"]);
    execFileSync("git", ["-C", root, "config", "user.name", "Smoke"]);
    await writeFile(join(root, "hello.txt"), "hello repository MCP\n", "utf8");
    execFileSync("git", ["-C", root, "add", "hello.txt"]);
    execFileSync("git", ["-C", root, "commit", "-qm", "fixture"]);
    const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const tree = execFileSync("git", ["-C", root, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
    const blob = execFileSync("git", ["-C", root, "rev-parse", "HEAD:hello.txt"], { encoding: "utf8" }).trim();
    await writeFile(auditPath, "", { mode: 0o600 });
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      descriptor: {
        schemaVersion: 1,
        snapshotDigest: "1".repeat(64),
        artifactLocator: "smoke-artifact",
        manifestPath: join(root, "manifest.json"),
        repositoryRoot: root,
        objectDirectory: join(root, ".git", "objects"),
        headRevision: head,
        sourceRevision: head,
        indexTree: tree,
        worktreeTree: tree,
        historyPolicy: { version: 1, traversal: "all_parent_breadth_first", root: "captured_head", maxCommits: 2048, maxIncrementalAllowedBlobBytes: 536870912, overflow: "stop_before_overflow", timestampCutoff: null },
        retainedRevisions: [{ id: head, parents: [], incrementalAllowedBlobBytes: 21 }],
        frontier: [],
        omittedParents: [],
        retainedCommitCount: 1,
        retainedAllowedBlobBytes: 21,
        entries: [{ path: "hello.txt", kind: "file", addressable: true, mode: 33188, sensitive: false, worktreePresent: true, indexObjectId: blob, worktreeObjectId: blob, status: "clean" }],
      },
      workloadId: "smoke-workload",
      workflowAttemptId: "smoke-attempt",
      budgets: { maxCalls: 8, maxAttemptBytes: 1048576, maxResponseBytes: 65536, maxAttemptMs: 30000, maxItemsPerCall: 100, maxCallMs: 5000 },
      cursorSecret: Buffer.alloc(32, 7).toString("base64url"),
      auditPath,
    }), { mode: 0o600 });
    const contract = await readFile(resolve("src/shared/repository-access.ts"), "utf8");
    const operationBlock = /export const REPOSITORY_OPERATION_IDS = \[([\s\S]*?)\] as const;/.exec(contract)?.[1] ?? "";
    const expected = [...operationBlock.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    const child = spawn(process.execPath, ["dist/repository-mcp/server.mjs"], {
      env: { ...process.env, MISSION_REPOSITORY_MCP_CONFIG: configPath },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (data) => (stderr += data));
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const result = await new Promise((resolveResult) => {
      let pending = "";
      const timer = setTimeout(() => resolveResult({ error: "repository MCP handshake timed out" }), MCP_HANDSHAKE_MS);
      const done = (value) => { clearTimeout(timer); resolveResult(value); };
      child.on("error", (error) => done({ error: error.message }));
      child.stdout.on("data", (data) => {
        pending += data;
        for (;;) {
          const newline = pending.indexOf("\n");
          if (newline < 0) break;
          const line = pending.slice(0, newline).trim();
          pending = pending.slice(newline + 1);
          if (!line) continue;
          const message = JSON.parse(line);
          if (message.id === 1) {
            send({ jsonrpc: "2.0", method: "notifications/initialized" });
            send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
          } else if (message.id === 2) {
            const names = message.result?.tools?.map((tool) => tool.name) ?? [];
            send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "read", arguments: { path: "hello.txt", layer: "worktree", window: { kind: "line", startLine: 1, maxLines: 5 } } } });
            if (JSON.stringify(names) !== JSON.stringify(expected)) done({ error: `repository MCP published ${JSON.stringify(names)} instead of ${JSON.stringify(expected)}` });
          } else if (message.id === 3) {
            const structured = message.result?.structuredContent;
            if (structured?.status !== "ok" || structured?.items?.[0]?.text !== "hello repository MCP") {
              done({ error: "repository MCP read query returned the wrong fixture result" });
            } else done({ ok: true });
          }
        }
      });
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "repository-smoke", version: "1" } } });
    });
    await reap(child);
    if (result.error) {
      fail(result.error);
      if (stderr.trim()) console.error(stderr.trimEnd());
      return;
    }
    console.log("[smoke] repository MCP publishes eight tools and serves a fixture read");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function declaredTaskExtraRepoLimit() {
  const source = await readFile(resolve("src/shared/protocol.ts"), "utf8");
  const value = /export const MAX_TASK_EXTRA_REPOS = (\d+);/.exec(source)?.[1];
  if (!value) {
    fail("MAX_TASK_EXTRA_REPOS could not be read out of src/shared/protocol.ts");
    return null;
  }
  return Number(value);
}

/**
 * The tool names this build DECLARES, read from `mission-mcp.ts` rather than duplicated here.
 *
 * A scrape rather than an import because this script is plain `node` with no TypeScript
 * loader, and the alternative - a hand-copied list in a smoke script - is a fourth place the
 * vocabulary can drift, which is the exact class of bug the check above exists to catch.
 * The constants it has to resolve live in their own single-spelling modules, so they are
 * read from there for the same reason.
 *
 * A name arriving as a constant this script cannot resolve is a FAILURE rather than a skip,
 * which is why adding one to `MISSION_MCP_TOOLS` means adding it to the map below too. Silently
 * dropping it would shrink the declared list and quietly hand the "extra" branch above a tool
 * the bundle publishes and nobody declares - the opposite of what happened.
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
    // Some names arrive as imported constants, each spelled in exactly one module: the two
    // submission tools, workflow evidence, retro no-change completion, and the two a plan
    // task's prompt names and its launch pre-approves.
    const ref = /^\s*([A-Z_]+),/.exec(line);
    if (!ref) continue;
    const from = {
      SUBMIT_ENSEMBLE_RESULT_TOOL: "src/server/ensembles/submission-tool.ts",
      SUBMIT_SCOUT_ARTIFACTS_TOOL: "src/server/scouts/submission-tool.ts",
      SUBMIT_WORKFLOW_EVIDENCE_TOOL: "src/server/workflows/evidence-tool.ts",
      COMPLETE_RETRO_NO_CHANGE_TOOL: "src/server/retro-tool.ts",
      PLAN_DECISIONS_TOOL: "src/server/plans/tools.ts",
      PLAN_SCHEDULING_TOOL: "src/server/plans/tools.ts",
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

/**
 * Prove the second Vite entry is a real isolated document and Mermaid remains outside
 * the dashboard's initial static import graph. A missing file would otherwise be answered
 * by the daemon's SPA fallback, which looks like a successful HTTP load until the bridge
 * times out in front of a checkout file.
 */
async function smokeMermaidRenderer() {
  const webRoot = resolve("dist/web");
  const rendererHtmlPath = join(webRoot, "mermaid-renderer.html");
  const rendererScriptPath = join(webRoot, "assets", "mermaid-renderer.js");
  const indexHtmlPath = join(webRoot, "index.html");
  const manifestPath = join(webRoot, ".vite", "manifest.json");
  for (const path of [rendererHtmlPath, rendererScriptPath, indexHtmlPath, manifestPath]) {
    if (!existsSync(path)) {
      fail(`the web build is missing ${path}`);
      return;
    }
  }
  const [rendererHtml, rendererScript, indexHtml, manifestSource] = await Promise.all([
    readFile(rendererHtmlPath, "utf8"),
    readFile(rendererScriptPath, "utf8"),
    readFile(indexHtmlPath, "utf8"),
    readFile(manifestPath, "utf8"),
  ]);
  if (rendererHtml === indexHtml || !rendererHtml.includes("Content-Security-Policy")) {
    fail("mermaid-renderer.html is the SPA fallback or has lost its Content Security Policy");
    return;
  }
  const manifest = JSON.parse(manifestSource);
  const app = manifest["index.html"];
  if (!app?.isEntry || !existsSync(join(webRoot, app.file))) {
    fail("the Vite manifest does not publish the dashboard entry");
    return;
  }
  if (
    !rendererHtml.includes("nonce=\"mission-mermaid-v1\"") ||
    !rendererHtml.includes("src=\"/assets/mermaid-renderer.js\"") ||
    !rendererScript.includes('globalThis["mermaid"]') ||
    !rendererScript.includes("mission:mermaid-ready")
  ) {
    fail("the isolated Mermaid renderer is missing its nonce-authorized classic bundle");
    return;
  }
  if (indexHtml.includes("mermaid-renderer")) {
    fail("the dashboard's initial document now includes the Mermaid renderer bundle");
    return;
  }
  console.log("[smoke] isolated Mermaid renderer exists and stays outside the dashboard entry");
}

await smokeNativeKeepAwake();
await smokeDesktopBackgroundPaths();
await smokeDaemon();
await smokeMcp();
await smokeRepositoryMcp();
await smokeSatellitePaths();
await smokeMermaidRenderer();
if (process.exitCode) process.exit(process.exitCode);
console.log("[smoke] ok");
