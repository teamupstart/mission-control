import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { writeFakeAgents } from "./fake-agents.ts";

/**
 * A real Mission Control daemon, isolated from the operator's machine, for a browser to drive.
 *
 * Everything the daemon would otherwise reach for is redirected at a throwaway temp tree:
 * the SQLite database, the workspace it discovers repos in, and - most importantly - the
 * agent binaries it launches. See `fake-agents.ts` for why that last one is what makes this
 * suite free to run.
 */
export interface DaemonHandle {
  /** Origin the dashboard is served from, e.g. `http://127.0.0.1:7531`. */
  baseURL: string;
  /** The throwaway `MISSION_HOME`, holding the DB, the token, and the daemon log. */
  home: string;
  /** Where the fake agent binaries record the argv/env they were launched with. */
  recordDir: string;
  /** The workspace root `MISSION_WORKSPACE_DIRS` points at. */
  workspace: string;
  /** Absolute path of the seeded git repository a dispatch can branch from. */
  repo: string;
  stop(): Promise<void>;
}

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const BOOT_TIMEOUT_MS = 30_000;
const POLL_MS = 100;

/**
 * Ports are assigned per worker rather than fixed.
 *
 * 7317 is the operator's real daemon and must never be touched; a fixed test port would
 * also make two Playwright workers fight over one database. `TEST_WORKER_INDEX` is
 * Playwright's own per-worker counter, so each worker gets its own daemon, its own
 * `MISSION_HOME`, and its own port by construction.
 */
function portForWorker(): number {
  return 7530 + Number(process.env.TEST_WORKER_INDEX ?? 0);
}

/**
 * A real git repository for a dispatch to branch a worktree off.
 *
 * Real git rather than a stub directory because dispatch does real work with it - it cuts a
 * worktree, reads the branch, and asks whether the repo is gated by no-mistakes. A fixture
 * that only looked like a repo would fail at the first `git` call, inside the daemon, where
 * the failure surfaces as an inscrutable dispatch error rather than as a broken fixture.
 */
function seedRepo(workspace: string, name: string): string {
  const repo = join(workspace, name);
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]): void => {
    execFileSync("git", ["-C", repo, ...args], {
      stdio: "pipe",
      env: { ...process.env, GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@example.com", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@example.com" },
    });
  };
  execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "pipe" });
  writeFileSync(join(repo, "README.md"), `# ${name}\n`);
  git("add", "-A");
  git("-c", "user.name=e2e", "-c", "user.email=e2e@example.com", "commit", "-qm", "base");
  return realpathSync(repo);
}

/**
 * Boot the built daemon bundle against a throwaway state dir and wait for `/api/health`.
 *
 * Runs `dist/server/index.mjs`, not `src/`, because the browser needs `dist/web` to exist
 * anyway - there is no version of this suite that does not require a build first. That is
 * also why this suite lives outside `test/`: everything in `test/` must pass on a fresh
 * checkout without one, and `scripts/smoke-bundles.mjs` already draws that same line.
 */
export async function startDaemon(): Promise<DaemonHandle> {
  // `realpathSync` because macOS resolves /var -> /private/var, and the daemon reports the
  // resolved cwd for a session. The transcript path is derived from that cwd, so an
  // unresolved fixture path and the daemon's own view would disagree by a prefix and the
  // conversation would silently never be found.
  const home = realpathSync(mkdtempSync(join(tmpdir(), "mc-e2e-")));
  const workspace = join(home, "workspace");
  const port = portForWorker();
  const { recordDir, bins } = writeFakeAgents(home);
  mkdirSync(workspace, { recursive: true });
  const repo = seedRepo(workspace, "demo-repo");

  const child: ChildProcess = spawn(process.execPath, [join(REPO_ROOT, "dist/server/index.mjs")], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      // The OS home, NOT the state dir. Claude transcripts are derived from `homedir()` as
      // `~/.claude/projects/<mangled cwd>/<session id>.jsonl`, so without this the fake
      // agent would write conversations into the operator's real ~/.claude.
      HOME: home,
      MISSION_HOME: home,
      MISSION_PORT: String(port),
      MISSION_WORKSPACE_DIRS: workspace,
      MISSION_WEB_DIR: join(REPO_ROOT, "dist/web"),
      // Every agent the daemon can launch, redirected at a fake. Missing even one would
      // let a real CLI start and spend real tokens.
      MISSION_CLAUDE_BIN: bins.claude,
      MISSION_CODEX_BIN: bins.codex,
      MISSION_PI_BIN: bins.pi,
      MC_E2E_RECORD_DIR: recordDir,
      // The pool sweep is NOT scoped to MISSION_HOME - it reaps the shared treehouse
      // worktree pool, so an isolated daemon will still delete a sibling checkout's work.
      // 0 switches the sweep off entirely.
      MISSION_POOL_REAP_MS: "0",
      // Neither is terminal discovery. It walks EVERY process on the machine and cards
      // anything that looks like an agent, so on a developer's laptop this daemon adopts
      // their real sessions - non-deterministic against CI, where there are none, and
      // unsafe, because the dashboard's Kill and Reset controls would then act on them.
      // 0 switches passive discovery off entirely.
      MISSION_POLL_MS: "0",
      // A fake agent answers instantly, so the dispatch settle windows are pure latency here.
      MISSION_DISPATCH_SETTLE_MS: "0",
      // Belt and braces: if some path ever escaped the fake bins, an unset key fails loudly
      // instead of quietly spending.
      ANTHROPIC_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let log = "";
  child.stdout?.on("data", (d: Buffer) => (log += d.toString()));
  child.stderr?.on("data", (d: Buffer) => (log += d.toString()));

  let exited: { code: number | null; signal: string | null } | null = null;
  child.on("exit", (code, signal) => (exited = { code, signal }));

  const baseURL = `http://127.0.0.1:${port}`;
  const stop = async (): Promise<void> => {
    if (!exited) {
      child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 200));
      if (!exited) child.kill("SIGKILL");
    }
    rmSync(home, { force: true, recursive: true });
  };

  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  for (;;) {
    // Report a crash the moment it happens. Waiting out the full timeout to say "did not
    // boot" buries the stack trace that says why.
    if (exited) {
      await stop();
      throw new Error(`daemon exited (code ${exited.code}, signal ${exited.signal}):\n${log}`);
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`daemon did not answer /api/health in ${BOOT_TIMEOUT_MS}ms:\n${log}`);
    }
    const res = await fetch(`${baseURL}/api/health`).catch(() => null);
    if (res?.ok) {
      const body = (await res.json().catch(() => ({}))) as { service?: string };
      if (body.service !== "mission-control") {
        await stop();
        throw new Error(`/api/health answered as ${JSON.stringify(body.service)}`);
      }
      break;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  // Prove the isolation held before any test writes through it.
  //
  // `openDb`'s own `assertTestStateIsolation` guard does not cover this suite: it keys on
  // `NODE_TEST_CONTEXT`, which the node:test runner sets and Playwright does not. So the
  // only thing standing between a mistyped env var and the operator's live database is
  // `MISSION_HOME` itself, and that deserves to be checked rather than assumed - the
  // failure it prevents is a test run that silently deletes real sessions and real tasks.
  if (!existsSync(join(home, "harness.db"))) {
    await stop();
    throw new Error(
      `the daemon did not create its database under ${home} - MISSION_HOME was not honoured, ` +
        "and it may be writing to the operator's real state dir",
    );
  }

  // Dispatch the SDK runtime, not a terminal one. `terminal` is the shipped default and it
  // needs tmux or wezterm to spawn a pane, which CI does not have; `sdk` is fully headless -
  // `Dispatcher.dispatch` returns before every terminal-only step. Set through the real
  // route rather than a seeded DB row, so this configures the daemon the way the Settings
  // panel does and cannot drift from it.
  const configured = await fetch(`${baseURL}/api/harnesses/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionRuntime: { claude: "sdk" } }),
  });
  if (!configured.ok) {
    await stop();
    throw new Error(`could not switch claude to the sdk runtime: ${configured.status} ${await configured.text()}`);
  }

  return { baseURL, home, recordDir, workspace, repo, stop };
}
