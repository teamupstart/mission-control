#!/usr/bin/env node
/**
 * `npm run demo` - a fully isolated Mission Control where every agent binary is a
 * token-free scenario player. Real daemon, real dashboard, real git, real Foreman; the
 * only thing scripted is what sits behind the spawned `claude`/`codex` binary.
 *
 * This is `e2e/fixtures/daemon.ts`'s `startDaemon()` promoted into an operator-facing
 * tool: a persistent state root instead of a throwaway temp dir, a fixed port instead of
 * an OS-assigned one, no teardown on exit, and a real (optional) Foreman instead of one a
 * spec starts on demand. See docs/plans/demo-mode/ for the contract this implements and
 * why each isolation guard below exists - the short version is in that file's env block
 * comments, which this mirrors.
 *
 * Flags:
 *   --fresh        delete the state root and rebuild it before booting
 *   --no-foreman   skip starting the real Foreman worker
 *   --port <n>     override the fixed default port
 *   --check        boot, assert identity and isolation, shut down, exit 0 (no browser,
 *                  no Foreman) - the CI-shaped smoke test for this launcher
 */
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DEMO_DIR = fileURLToPath(new URL(".", import.meta.url));
const DEFAULT_PORT = 7417; // distinct from the dev daemon (7317) and the smoke port (7519)
const BOOT_TIMEOUT_MS = 30_000;
const FOREMAN_TIMEOUT_MS = 30_000;
const POLL_MS = 100;

function parseArgs(argv) {
  const args = { fresh: false, noForeman: false, check: false, port: DEFAULT_PORT };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--fresh") args.fresh = true;
    else if (arg === "--no-foreman") args.noForeman = true;
    else if (arg === "--check") args.check = true;
    else if (arg === "--port") args.port = Number(argv[++i]);
    else {
      console.error(`[demo] unrecognized argument: ${arg}`);
      process.exit(1);
    }
  }
  if (!Number.isInteger(args.port) || args.port <= 0) {
    console.error(`[demo] --port must be a positive integer, got ${JSON.stringify(args.port)}`);
    process.exit(1);
  }
  return args;
}

function ensureBuilt() {
  const server = join(REPO_ROOT, "dist/server/index.mjs");
  const web = join(REPO_ROOT, "dist/web");
  if (!existsSync(server) || !existsSync(web)) {
    console.error(
      "[demo] dist/ is missing or incomplete - run `npm run build` first (this launcher runs " +
        "the built daemon and serves the built dashboard, exactly like `npm run smoke` and " +
        "`npm run test:e2e`).",
    );
    process.exit(1);
  }
}

// --- state root ---------------------------------------------------------------------------

function git(repo, ...args) {
  execFileSync("git", ["-C", repo, ...args], {
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "demo",
      GIT_AUTHOR_EMAIL: "demo@example.com",
      GIT_COMMITTER_NAME: "demo",
      GIT_COMMITTER_EMAIL: "demo@example.com",
    },
  });
}

/**
 * A real git repository with a small TypeScript module and its test, seeded so the starter
 * scenarios' `editFile` steps land on a real diff instead of inventing files from nothing.
 * Two commits, not one, so the Diff view's merge-base math has something to show.
 */
function seedRepo(workspace, name) {
  const repo = join(workspace, name);
  if (existsSync(repo)) return realpathSync(repo);
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "pipe" });

  writeFileSync(join(repo, "README.md"), `# ${name}\n\nSeeded for Mission Control's demo mode.\n`);
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(
    join(repo, "src/retry.ts"),
    `export interface RetryOptions {
  retries: number;
  delayMs: number;
  signal?: AbortSignal;
}

/** Retry an async operation with a fixed delay between attempts. */
export async function retry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempt += 1;
      if (attempt >= opts.retries) throw err;
      await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
    }
  }
}
`,
  );
  writeFileSync(
    join(repo, "src/retry.test.ts"),
    `import assert from "node:assert/strict";
import test from "node:test";
import { retry } from "./retry.ts";

test("retries until success", async () => {
  let calls = 0;
  const result = await retry(
    async () => {
      calls += 1;
      if (calls < 3) throw new Error("not yet");
      return "ok";
    },
    { retries: 5, delayMs: 1 },
  );
  assert.equal(result, "ok");
  assert.equal(calls, 3);
});
`,
  );
  writeFileSync(
    join(repo, "src/dashboard.ts"),
    `export interface FleetCounts {
  active: number;
  waiting: number;
  idle: number;
}

/** A one-line summary of the fleet's current state. */
export function summarize(counts: FleetCounts): string {
  return \`\${counts.active} active, \${counts.waiting} waiting, \${counts.idle} idle\`;
}
`,
  );
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base scaffolding");

  writeFileSync(
    join(repo, "README.md"),
    `# ${name}\n\nSeeded for Mission Control's demo mode.\n\nRun \`npm test\` before shipping.\n`,
  );
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "polish the README");

  return realpathSync(repo);
}

/** Copy a fake agent player to an extension-less path and chmod it executable - the
 * combination the vendored Claude SDK's spawn-by-extension sniffing requires. */
function installPlayer(source, dest) {
  copyFileSync(source, dest);
  chmodSync(dest, 0o755);
}

/**
 * `pi`'s player (`fake-pi.mjs`) genuinely executes a scenario - real transcript, real file
 * edits, same schema as its Claude and Codex siblings - so it is NOT a stub. What remains a
 * hard, separately-documented architectural fact (investigated twice, confirmed by reading
 * `src/server/harness/index.ts` and `src/server/dispatcher.ts` directly, not assumed) is that
 * this demo's daemon configuration has no path that would ever ADOPT the resulting session
 * onto the dashboard: `pi`'s only real runtime is a terminal pane, and getting a dispatched
 * pane into the registry depends on the passive discovery sweep this demo turns off as a
 * non-negotiable isolation guard (`MISSION_POLL_MS=0` - see README.md's Demo mode section for
 * the full reasoning, including the SDK/RPC-adapter gap that rules out the other fix). That is
 * orthogonal to whether the player itself plays a scenario, which it does.
 */
function installPlayers(root) {
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  installPlayer(join(DEMO_DIR, "fake-claude.mjs"), join(binDir, "claude"));
  installPlayer(join(DEMO_DIR, "fake-codex.mjs"), join(binDir, "codex"));
  installPlayer(join(DEMO_DIR, "fake-pi.mjs"), join(binDir, "pi"));
  return {
    claude: join(binDir, "claude"),
    codex: join(binDir, "codex"),
    pi: join(binDir, "pi"),
  };
}

function installScenarios(root) {
  const sourceDir = join(DEMO_DIR, "scenarios");
  const destDir = join(root, "scenarios");
  mkdirSync(destDir, { recursive: true });
  for (const file of readdirSync(sourceDir).filter((f) => f.endsWith(".json"))) {
    copyFileSync(join(sourceDir, file), join(destDir, file));
  }
  return destDir;
}

/** Resolve (and, on `--fresh`, rebuild) the persistent demo state root. */
function resolveRoot(fresh) {
  const root = join(homedir(), ".mission-control-demo");
  if (fresh && existsSync(root)) {
    console.log(`[demo] --fresh: removing ${root}`);
    rmSync(root, { recursive: true, force: true });
  }
  mkdirSync(root, { recursive: true });
  // realpath because macOS resolves /var -> /private/var, and Claude derives its
  // transcript path from the resolved cwd - an unresolved root here and the daemon's own
  // view of it would disagree by a prefix, and conversations would never be found.
  return realpathSync(root);
}

// --- daemon boot (factored apart from opening the dashboard, so Phase 2's seeder can
// drive this quietly, per the cross-phase contract) ----------------------------------------

function buildDaemonEnv(root, port, bins) {
  return {
    ...process.env,
    HOME: root,
    MISSION_HOME: root,
    MISSION_PORT: String(port),
    MISSION_WORKSPACE_DIRS: join(root, "workspace"),
    MISSION_WEB_DIR: join(REPO_ROOT, "dist/web"),
    MISSION_CLAUDE_BIN: bins.claude,
    MISSION_CODEX_BIN: bins.codex,
    MISSION_PI_BIN: bins.pi,
    MISSION_DEMO_SCENARIO_DIR: join(root, "scenarios"),
    // Neither sweep below is scoped to MISSION_HOME - left on, this daemon would walk
    // every process on the machine and adopt the operator's real sessions (POLL_MS), or
    // reap a shared treehouse worktree pool it does not own (POOL_REAP_MS). Both zero,
    // non-negotiably.
    MISSION_POLL_MS: "0",
    MISSION_POOL_REAP_MS: "0",
    // A scenario player answers instantly once its own delayMs pacing is done, so the
    // dispatch settle window is pure latency here.
    MISSION_DISPATCH_SETTLE_MS: "0",
    MISSION_WORKFLOW_SWEEP_MS: "1000",
    // Belt and braces: if some path ever escaped the fake bins, an unset key fails loudly
    // instead of quietly spending.
    ANTHROPIC_API_KEY: "",
  };
}

async function fetchHealth(baseURL) {
  return await fetch(`${baseURL}/api/health`).catch(() => null);
}

/**
 * Boot the daemon and wait for it to be provably OURS - the same identity and isolation
 * checks `e2e/fixtures/daemon.ts` runs before any test writes through it: `/api/health`
 * answers the spawned child's own pid, and `harness.db` lands under the state root rather
 * than the operator's real one.
 */
async function bootDaemon(root, port, env) {
  const child = spawn(process.execPath, [join(REPO_ROOT, "dist/server/index.mjs")], {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let log = "";
  child.stdout?.on("data", (d) => (log += d.toString()));
  child.stderr?.on("data", (d) => (log += d.toString()));
  let exited = null;
  child.on("exit", (code, signal) => (exited = { code, signal }));

  const baseURL = `http://127.0.0.1:${port}`;
  const stop = async () => {
    if (exited) return;
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 200));
    if (!exited) child.kill("SIGKILL");
  };

  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  for (;;) {
    if (exited) {
      throw new Error(`[demo] the daemon exited (code ${exited.code}, signal ${exited.signal}):\n${log}`);
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`[demo] the daemon did not answer /api/health within ${BOOT_TIMEOUT_MS}ms:\n${log}`);
    }
    const res = await fetchHealth(baseURL);
    if (res?.ok) {
      const body = await res.json().catch(() => ({}));
      if (body.service !== "mission-control") {
        await stop();
        throw new Error(`[demo] /api/health answered as ${JSON.stringify(body.service)}`);
      }
      if (body.pid !== child.pid) {
        await stop();
        throw new Error(
          `[demo] port ${port} is already held by a different Mission Control daemon ` +
            `(pid ${body.pid}, expected the spawned child's pid ${child.pid}). Refusing to ` +
            "run the demo against it - stop that daemon or pass --port.",
        );
      }
      break;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  if (!existsSync(join(root, "harness.db"))) {
    await stop();
    throw new Error(
      `[demo] the daemon did not create its database under ${root} - MISSION_HOME was not ` +
        "honoured, and it may be about to write to the operator's real state dir.",
    );
  }

  const configured = await fetch(`${baseURL}/api/harnesses/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionRuntime: { claude: "sdk", codex: "sdk" } }),
  });
  if (!configured.ok) {
    await stop();
    throw new Error(
      `[demo] could not switch claude/codex to the sdk runtime: ${configured.status} ${await configured.text()}`,
    );
  }

  return { child, baseURL, readLog: () => log, stop };
}

/**
 * The Foreman child's environment: start from the DAEMON's env so `MISSION_HOME` and
 * `MISSION_PORT` match, then restore everything that makes it a REAL agent - the
 * operator's own `HOME` (their CLI's credentials live under it), no fake-bin overrides,
 * and whatever `ANTHROPIC_API_KEY` (if any) the operator's own shell had. Foreman tokens
 * are the one deliberate exception to this demo's zero-spend guarantee.
 */
function buildForemanEnv(daemonEnv, realHome) {
  const env = { ...daemonEnv, HOME: realHome };
  delete env.MISSION_CLAUDE_BIN;
  delete env.MISSION_CODEX_BIN;
  delete env.MISSION_PI_BIN;
  if (process.env.ANTHROPIC_API_KEY !== undefined) env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  else delete env.ANTHROPIC_API_KEY;
  return env;
}

async function startForeman(env) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", join(REPO_ROOT, "src/server/foreman/worker.ts")],
    { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let log = "";
  child.stdout?.on("data", (d) => (log += d.toString()));
  child.stderr?.on("data", (d) => (log += d.toString()));
  let exited = null;
  child.on("exit", (code, signal) => (exited = { code, signal }));

  const deadline = Date.now() + FOREMAN_TIMEOUT_MS;
  for (;;) {
    if (exited) {
      throw new Error(
        `[demo] Foreman exited before acquiring its lease (code ${exited.code}, signal ${exited.signal}):\n${log}`,
      );
    }
    if (log.includes("[foreman] acquired the lease")) break;
    if (Date.now() > deadline) {
      child.kill("SIGTERM");
      throw new Error(`[demo] Foreman did not acquire its lease within ${FOREMAN_TIMEOUT_MS}ms:\n${log}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  return {
    child,
    readLog: () => log,
    stop: async () => {
      if (exited) return;
      child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 200));
      if (!exited) child.kill("SIGKILL");
    },
  };
}

function openDashboard(baseURL) {
  console.log(`[demo] dashboard: ${baseURL}`);
  if (process.platform === "darwin") {
    spawn("open", [baseURL], { stdio: "ignore", detached: true }).unref();
  }
}

// --- main -----------------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const realHome = process.env.HOME ?? homedir();

  ensureBuilt();
  const root = resolveRoot(args.fresh);
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  seedRepo(workspace, "demo-api");
  seedRepo(workspace, "demo-web");
  const bins = installPlayers(root);
  installScenarios(root);

  const daemonEnv = buildDaemonEnv(root, args.port, bins);
  console.log(`[demo] state root: ${root}`);
  console.log(`[demo] booting the daemon on port ${args.port}...`);
  const daemon = await bootDaemon(root, args.port, daemonEnv);
  console.log(`[demo] daemon is up (pid ${daemon.child.pid}), isolated under ${root}`);

  if (args.check) {
    console.log("[demo] --check: identity and isolation assertions passed");
    await daemon.stop();
    console.log("[demo] --check: ok");
    return;
  }

  let foreman = null;
  if (!args.noForeman) {
    console.log("[demo] starting the real Foreman against the demo daemon...");
    foreman = await startForeman(buildForemanEnv(daemonEnv, realHome));
    console.log(`[demo] Foreman is up (pid ${foreman.child.pid}) and holds its lease`);
  } else {
    console.log("[demo] --no-foreman: skipping the Foreman worker");
  }

  openDashboard(daemon.baseURL);

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n[demo] ${signal}: stopping (state root kept at ${root})`);
    if (foreman) await foreman.stop();
    await daemon.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
