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
 *   --fresh        delete the state root, rebuild it, and SEED a lived-in fleet before
 *                  booting (see `seed.mjs`); without it an existing root boots as-is,
 *                  which is the point of a persistent demo
 *   --no-seed      with --fresh, rebuild the root but skip the seeder - an empty fleet in
 *                  seconds instead of a populated one in minutes
 *   --no-foreman   skip starting the real Foreman worker
 *   --no-open      do not open a browser (a remote machine, or a scripted inspection of the
 *                  seeded fleet that should not steal the operator's focus)
 *   --port <n>     override the fixed default port
 *   --check        boot, assert identity and isolation, run a REDUCED seed and assert its
 *                  residue, shut down, exit 0 (no browser, no Foreman) - the CI-shaped
 *                  smoke test for this launcher and its seeder
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
export const DEFAULT_PORT = 7417; // distinct from the dev daemon (7317) and the smoke port (7519)
const BOOT_TIMEOUT_MS = 30_000;
const FOREMAN_TIMEOUT_MS = 30_000;
const POLL_MS = 100;
/**
 * The arrangement a demo daemon opens on, one of `LAYOUT_MODES`.
 *
 * The Board, because a demo is read before it is driven: a column per state answers "what is this
 * fleet doing" in one look, where Cards asks the viewer to read five headers and add them up. The
 * seeded fleet is arranged for exactly that reading - work in progress, two cards waiting on a
 * human, one approved - and a column count says it without a word of narration.
 *
 * Applied on EVERY boot, beside the runtime override above and for the same reason: this launcher
 * asserts the demo's configuration rather than hoping a persistent state root still holds it. The
 * cost is deliberate and small - an operator who switches layout mid-demo keeps that switch for as
 * long as the daemon runs, and the next `npm run demo` opens on the Board again, which is what a
 * presentation surface should do.
 */
export const DEMO_LAYOUT = "board";

/**
 * The exact body the launcher PUTs to `/api/ui/config`, and nothing more.
 *
 * A function rather than an inline literal at the call site, so `test/demo-launch.test.ts` can
 * parse it with the ROUTE's own `UiConfigPatchSchema` - the same discipline every seeded body is
 * held to. What that test is really guarding is the field list: the patch schema is a plain
 * `.partial()` because each top-level key is owned whole by one panel, so a body that mentioned
 * `keybindings` or `alerts` would REPLACE them, and a demo launcher would be quietly resetting
 * preferences it has no business touching.
 */
export function demoUiConfigBody() {
  return { layout: DEMO_LAYOUT };
}

/**
 * Whether the daemon's answer proves it STORED the layout, rather than merely accepting the write.
 *
 * The failure this exists for is silent: `UiConfigPatchSchema` is a partial, so a key this
 * launcher spelled wrong is valid input that sets nothing, answers 200, and leaves the demo
 * opening on the shipped `grid` default. Reading the echo is the only way to tell that apart from
 * a write that landed - and it has to be a strict equality against the config the route reports,
 * because an absent field and a stored `grid` are the same mistake with different spellings.
 */
export function demoLayoutAccepted(answer) {
  return answer?.config?.layout === DEMO_LAYOUT;
}

/**
 * How long a SIGTERM'd daemon gets to shut down on its own before it is killed.
 *
 * Generous, and load-bearing rather than merely polite: the daemon's own SIGTERM handler
 * drains every embedded session's driver (`SdkSupervisor.stopAll`, itself a 5s budget) and
 * only then records each one `suspended`, which is the status `restore()` picks back up at
 * the next boot. A short kill here would take the seeded fleet's session cards with it, and
 * would cut SQLite off mid-write besides.
 */
const SHUTDOWN_GRACE_MS = 15_000;

/**
 * Guarantees a cleanup runs exactly once, no matter how many of `stop`'s callers race to
 * claim it - a signal, a Foreman lease failure, `--check`'s own natural completion. This is
 * the exact site of the orphan-daemon bug a Code Risk Reviewer round found (cleanup that
 * only ran on ONE of several exit paths) and the race in this fix's own first attempt
 * (`process.exit` on a losing path could still run before the winning path's cleanup did).
 * Extracted so that ordering is unit-testable without booting a real daemon or Foreman -
 * see `test/demo-launch.test.ts`.
 */
export function createShutdownGate(onStop) {
  let stopping = false;
  return {
    /** Whether a caller has already claimed the stop. */
    isStopping: () => stopping,
    /**
     * Claim the stop and run `onStop` - but only for the FIRST caller. Every later caller
     * (concurrent or sequential) gets `false` back and must not act further: `onStop` is
     * already running, or has already finished, on someone else's claim.
     */
    async stop(reason) {
      if (stopping) return false;
      stopping = true;
      await onStop(reason);
      return true;
    },
  };
}

/**
 * Wire SIGINT/SIGTERM to `stop` and hand back the function that unwires them.
 *
 * The seed and `--check` each hold a live daemon for minutes with no signal handlers of their
 * own - a Ctrl-C in that window would take this process down and leave that daemon squatting
 * the port, so the NEXT run refuses to start on `bootDaemon`'s pid check. Built on
 * `createShutdownGate` rather than a second ad-hoc guard, so a signal racing a natural failure
 * still cleans up exactly once (the bug that gate exists for).
 *
 * Releasing matters as much as holding, because these phases hand off: `main` installs its own
 * long-lived pair after the seed returns, and a stale listener from this one would stop a
 * daemon that had already been replaced by the one the operator is looking at.
 */
export function holdSignals(stop) {
  const gate = createShutdownGate(async (reason) => {
    console.error(`\n[demo] ${reason}: stopping the daemon before exiting`);
    await stop();
  });
  const onSignal = (signal) => {
    void gate.stop(signal).then((won) => {
      if (won) process.exit(130);
    });
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  return () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  };
}

export function parseArgs(argv) {
  const args = {
    fresh: false,
    noForeman: false,
    noSeed: false,
    noOpen: false,
    check: false,
    port: DEFAULT_PORT,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--fresh") args.fresh = true;
    else if (arg === "--no-foreman") args.noForeman = true;
    else if (arg === "--no-seed") args.noSeed = true;
    else if (arg === "--no-open") args.noOpen = true;
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

export function ensureBuilt() {
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

/** The one name for the demo state root, so no caller can invent a second one. */
export const DEMO_ROOT_NAME = ".mission-control-demo";
/** A disposable demo root used only while regenerating committed documentation imagery. */
export const DEMO_SCREENSHOTS_ROOT_NAME = ".mission-control-demo-screenshots";
/**
 * `--check`'s own throwaway root, beside the real one rather than inside it.
 *
 * `--check` now runs a reduced seed, which writes tasks, sessions and worktrees - so it must
 * not run against `~/.mission-control-demo`, or a CI-shaped assertion would quietly bulldoze
 * a curated demo an operator had spent an afternoon arranging. Rebuilt on every `--check`
 * and removed afterwards.
 */
export const DEMO_CHECK_ROOT_NAME = ".mission-control-demo-check";

/** The roots anything under `scripts/demo/` is allowed to create, write, and delete. */
const WRITABLE_ROOT_NAMES = [DEMO_ROOT_NAME, DEMO_CHECK_ROOT_NAME, DEMO_SCREENSHOTS_ROOT_NAME];

/** Resolve (and, on `--fresh`, rebuild) the persistent demo state root. */
function resolveRoot(fresh, name = DEMO_ROOT_NAME) {
  const root = join(homedir(), name);
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

/**
 * Rebuild the isolated root used by `scripts/docs-screenshots.mjs`.
 *
 * Documentation captures must be repeatable, but they must not reset the persistent demo an
 * operator may be using. Keeping this root in the same allowlist as the other demo roots means
 * the seeder retains its refusal to write to ordinary Mission Control state.
 */
export function resetDocsScreenshotRoot() {
  return resolveRoot(true, DEMO_SCREENSHOTS_ROOT_NAME);
}

/**
 * Refuse to treat anything but the demo state root as one.
 *
 * The guard the plan asks for, hoisted here so the launcher and the seeder share ONE
 * definition of "this is the demo's own state, not the operator's". `~/.mission-control` is
 * live operator state whose schema is append-only; nothing in `scripts/demo/` may write to
 * it, and a path typo is the realistic way that would otherwise happen.
 */
export function assertDemoRoot(root) {
  const resolved = realpathSync(root);
  const allowed = WRITABLE_ROOT_NAMES.filter((name) => existsSync(join(homedir(), name))).map(
    (name) => realpathSync(join(homedir(), name)),
  );
  if (!allowed.includes(resolved)) {
    throw new Error(
      `[demo] refusing to act on ${root}: only ${WRITABLE_ROOT_NAMES.map((n) => join(homedir(), n)).join(" or ")} ` +
        "may be written by the demo tooling, which must never touch the operator's own " +
        "Mission Control state.",
    );
  }
  return resolved;
}

/**
 * Everything the state root needs before a daemon can boot into it: the seeded workspace
 * repos, the installed players, and the scenario tables.
 *
 * One function rather than four calls at the top of `main`, because the seeder boots into
 * the same root and has to know that this has already happened. Idempotent - `seedRepo`
 * returns an existing repo untouched, and the copies simply overwrite - so an ordinary
 * `npm run demo` refreshes the players against the checkout on every launch.
 */
export function prepareStateRoot(root) {
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const repos = [seedRepo(workspace, "demo-api"), seedRepo(workspace, "demo-web")];
  const bins = installPlayers(root);
  const scenarios = installScenarios(root);
  return { workspace, repos, bins, scenarios };
}

// --- daemon boot (factored apart from opening the dashboard, so Phase 2's seeder can
// drive this quietly, per the cross-phase contract) ----------------------------------------

export function buildDaemonEnv(root, port, bins) {
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
    // The demo's Claude one-shot player implements `claude -p`, not the Agent SDK's wire
    // protocol. Pin print transport so Persona reviews, goal refinement, and titles stay on the
    // local fake binary even though the product default is SDK transport.
    MISSION_CLAUDE_TRANSPORT: "print",
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
export async function bootDaemon(root, port, env) {
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
  /**
   * Stop the daemon and WAIT for it to actually be gone.
   *
   * Waiting is the point. The seeder's whole mechanism is "let real sessions run, then let a
   * clean shutdown suspend them", and `SHUTDOWN_GRACE_MS` explains why that needs more than
   * a token pause. It also means the next boot cannot race this one for the port.
   */
  const stop = async (graceMs = SHUTDOWN_GRACE_MS) => {
    if (exited) return;
    child.kill("SIGTERM");
    const deadline = Date.now() + graceMs;
    while (!exited && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    if (exited) return;
    child.kill("SIGKILL");
    // A second, short window: SIGKILL cannot be caught, so this only covers the kernel
    // getting round to it. Bounded anyway - a stop that cannot finish must still return.
    const killDeadline = Date.now() + 2_000;
    while (!exited && Date.now() < killDeadline) await new Promise((r) => setTimeout(r, 50));
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

  const laidOut = await fetch(`${baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(demoUiConfigBody()),
  });
  if (!laidOut.ok) {
    await stop();
    throw new Error(
      `[demo] could not open the dashboard on the ${DEMO_LAYOUT}: ${laidOut.status} ${await laidOut.text()}`,
    );
  }
  // The echo, not the status - see `demoLayoutAccepted`.
  const answer = await laidOut.json().catch(() => null);
  if (!demoLayoutAccepted(answer)) {
    await stop();
    throw new Error(
      `[demo] the daemon kept layout ${JSON.stringify(answer?.config?.layout)} rather than ${DEMO_LAYOUT}`,
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

/**
 * Spawn the Foreman child and return its handle immediately - before waiting for the lease,
 * not after. That ordering is load-bearing: the caller registers this handle for cleanup
 * (including on a signal) right away, so a SIGINT/SIGTERM that lands anywhere during the
 * lease wait below still has a live handle to stop, rather than a spawned-but-unreachable
 * child that outlives the process which spawned it.
 */
function spawnForeman(env) {
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

  return {
    child,
    readLog: () => log,
    hasExited: () => exited,
    stop: async () => {
      if (exited) return;
      child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 200));
      if (!exited) child.kill("SIGKILL");
    },
  };
}

/** Wait for an already-spawned Foreman's lease-acquired log line, or throw. Does not spawn
 * or stop anything itself - the caller owns the handle's lifecycle either way. */
async function waitForForemanLease(foreman) {
  const deadline = Date.now() + FOREMAN_TIMEOUT_MS;
  for (;;) {
    const exited = foreman.hasExited();
    if (exited) {
      throw new Error(
        `[demo] Foreman exited before acquiring its lease (code ${exited.code}, signal ${exited.signal}):\n${foreman.readLog()}`,
      );
    }
    if (foreman.readLog().includes("[foreman] acquired the lease")) return;
    if (Date.now() > deadline) {
      throw new Error(`[demo] Foreman did not acquire its lease within ${FOREMAN_TIMEOUT_MS}ms:\n${foreman.readLog()}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

function openDashboard(baseURL, open = true) {
  console.log(`[demo] dashboard: ${baseURL}`);
  if (open && process.platform === "darwin") {
    spawn("open", [baseURL], { stdio: "ignore", detached: true }).unref();
  }
}

// --- --check ---------------------------------------------------------------------------------

/**
 * The CI-shaped proof, end to end: prepare a throwaway root, run a REDUCED seed through the
 * real routes, then boot a second daemon over what the first one left and assert the residue
 * the way the dashboard reads it.
 *
 * The reboot is the part that could not be faked. Every other assertion here could be made
 * against the seeder's own live daemon; "a suspended session comes back as a card" is a claim
 * about a DIFFERENT process reading rows the previous one wrote, and only a real second boot
 * tests it. That path is exactly what an operator's `npm run demo -- --fresh` then does.
 */
async function runCheck(port) {
  const root = resolveRoot(true, DEMO_CHECK_ROOT_NAME);
  console.log(`[demo] --check: throwaway state root ${root}`);
  const { seedDemoFleet, readSnapshot, waitFor } = await import("./seed.mjs");
  try {
    const { bins } = prepareStateRoot(root);
    const summary = await seedDemoFleet({ root, port, reduced: true });
    console.log("[demo] --check: reduced seed complete, rebooting over it");

    const daemon = await bootDaemon(root, port, buildDaemonEnv(root, port, bins));
    try {
      // Poll rather than read once: `SdkSupervisor.restore()` relaunches suspended sessions
      // after the server is already answering /api/health, so the first snapshot on a cold
      // boot legitimately has no cards in it yet.
      const snap = await waitFor(
        "the seeded fleet to be restored",
        async () => {
          const s = await readSnapshot(daemon.baseURL);
          return s.sessions.length > 0 ? s : null;
        },
        { timeoutMs: 60_000 },
      );

      // Read the CONFIG the dashboard reads, not the value this process just posted: the write
      // happens inside `bootDaemon`, and a route that accepted it while storing something else
      // would leave the demo opening on the shipped default with nothing saying so.
      const ui = await (await fetch(`${daemon.baseURL}/api/ui/config`)).json().catch(() => null);
      const checks = [
        [`tasks were seeded (${snap.tasks.length})`, snap.tasks.length > 0],
        [
          `a suspended session came back as a card (${snap.sessions.length})`,
          snap.sessions.length > 0,
        ],
        [
          "a pending review survived the restart",
          snap.reviews.some((r) => r.status === "pending"),
        ],
        [
          `the cost ledger has priced rows (${snap.fleetCost?.estimatedCostToday ?? "none"})`,
          (snap.fleetCost?.estimatedCostToday ?? 0) > 0,
        ],
        [
          `the dashboard opens on the ${DEMO_LAYOUT} (${ui?.config?.layout ?? "unreadable"})`,
          ui?.config?.layout === DEMO_LAYOUT,
        ],
      ];
      for (const [what, ok] of checks) {
        console.log(`[demo] --check: ${ok ? "ok  " : "FAIL"} ${what}`);
      }
      const failed = checks.filter(([, ok]) => !ok).map(([what]) => what);
      if (failed.length > 0) {
        throw new Error(`[demo] --check: the seeded fleet is missing: ${failed.join("; ")}`);
      }
      console.log(`[demo] --check: identity, isolation and seed assertions passed`);
      console.log(`[demo] --check: seeded ${summary.headline}`);
    } finally {
      await daemon.stop();
    }
  } finally {
    // Always, including on a failed assertion: a leftover check root would make the next
    // run's `--fresh` rebuild look like it had passed when it had merely reused this one.
    rmSync(root, { recursive: true, force: true });
  }
  console.log("[demo] --check: ok");
}

// --- main -----------------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const realHome = process.env.HOME ?? homedir();

  ensureBuilt();

  // `--check` is its own program: a disposable root, a reduced seed, assertions, exit. It
  // shares this file's boot and preparation rather than the rest of its lifecycle.
  if (args.check) {
    await runCheck(args.port);
    return;
  }

  const root = resolveRoot(args.fresh);
  const { bins } = prepareStateRoot(root);
  console.log(`[demo] state root: ${root}`);

  // The Phase 2 hook, deliberately BEFORE the boot below: the seeder needs the port to
  // itself (it boots, drives real routes, and stops so its sessions suspend), and what it
  // leaves behind is what the daemon we are about to start restores.
  if (args.fresh && !args.noSeed) {
    const { seedDemoFleet, printSeedSummary } = await import("./seed.mjs");
    console.log("[demo] --fresh: seeding a lived-in fleet (this replays real work - a few minutes)");
    printSeedSummary(await seedDemoFleet({ root, port: args.port }));
  } else if (args.fresh) {
    console.log("[demo] --no-seed: rebuilt the state root without seeding it");
  }

  const daemonEnv = buildDaemonEnv(root, args.port, bins);
  console.log(`[demo] booting the daemon on port ${args.port}...`);
  const daemon = await bootDaemon(root, args.port, daemonEnv);
  console.log(`[demo] daemon is up (pid ${daemon.child.pid}), isolated under ${root}`);

  // From here on, the daemon (and, once spawned, Foreman) must be stopped on EVERY exit
  // path - a thrown error, a signal, or a clean shutdown - or the next `npm run demo`
  // invocation finds this one still squatting on the port and refuses to start (see
  // `bootDaemon`'s pid-identity check). `foreman` is declared and the gate's signal handlers
  // are registered BEFORE it is spawned, so a stop can always reach it even if a signal
  // lands mid-lease-wait, before `spawnForeman` itself has returned - the gap a prior
  // review round found: registering handlers only after a successful Foreman start left a
  // signal received during that wait to fall through to Node's default (immediate exit, no
  // cleanup at all). `createShutdownGate` is what then keeps a losing racer from also
  // calling `process.exit` before the winner's own cleanup has run - the second, subtler
  // bug that same round's fix first introduced and this one closes; see
  // `test/demo-launch.test.ts`.
  let foreman = null;
  const gate = createShutdownGate(async (reason) => {
    console.log(`\n[demo] ${reason}: stopping (state root kept at ${root})`);
    if (foreman) await foreman.stop();
    await daemon.stop();
  });
  process.on("SIGINT", async () => {
    if (await gate.stop("SIGINT")) process.exit(0);
  });
  process.on("SIGTERM", async () => {
    if (await gate.stop("SIGTERM")) process.exit(0);
  });

  if (!args.noForeman) {
    console.log("[demo] starting the real Foreman against the demo daemon...");
    foreman = spawnForeman(buildForemanEnv(daemonEnv, realHome));
    try {
      await waitForForemanLease(foreman);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      // If a signal already claimed the gate, it owns cleanup and its own process.exit(0) -
      // this branch must not also stop things or exit, or it can win that race and exit
      // before the signal's cleanup finishes.
      if (await gate.stop("foreman-failed")) process.exit(1);
      return;
    }
    console.log(`[demo] Foreman is up (pid ${foreman.child.pid}) and holds its lease`);
  } else {
    console.log("[demo] --no-foreman: skipping the Foreman worker");
  }

  openDashboard(daemon.baseURL, !args.noOpen);
}

// Guarded so a test can `import { createShutdownGate } from "./launch.mjs"` without
// booting a real daemon - importing a script must not run it.
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
