import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ghProductScriptPath,
  productConsentBinPath,
  productConsentScriptPath,
  writeProductConsentBin,
  ghPullRequestsPath,
  piCatalogControlPath,
  writeFakeAgents,
} from "./fake-agents.ts";
import {
  FAKE_CONDUCTOR_VERSION,
  seedConductorInstallerCheckout,
  writeFakeConductor,
  type FakeConductor,
} from "./conductor.ts";

/**
 * A real Mission Control daemon, isolated from the operator's machine, for a browser to drive.
 *
 * Everything the daemon would otherwise reach for is redirected at a throwaway temp tree:
 * the SQLite database, the workspace it discovers repos in, and - most importantly - the
 * agent binaries it launches. See `fake-agents.ts` for why that last one is what makes this
 * suite free to run.
 */
export interface DaemonHandle {
  /** Origin the dashboard is served from, on an OS-assigned loopback port. */
  baseURL: string;
  /** The throwaway `MISSION_HOME`, holding the DB, the token, and the daemon log. */
  home: string;
  /** Where the fake agent binaries record the argv/env they were launched with. */
  recordDir: string;
  /** The workspace root `MISSION_WORKSPACE_DIRS` points at. */
  workspace: string;
  /** Absolute path of the seeded git repository a dispatch can branch from. */
  repo: string;
  /**
   * A SECOND seeded repository in the same workspace.
   *
   * Here rather than seeded per spec because a multi-repo dispatch needs it to exist before
   * the daemon does: `listRepos` caches its workspace scan behind a TTL, so a repo created
   * after the first scan can be missing from the picker for reasons that have nothing to do
   * with the spec. Nothing asserts a repo COUNT, so its presence costs the other specs
   * nothing.
   */
  secondRepo: string;
  /**
   * Where a spec scripts what the fake `gh` reports, for THIS daemon.
   *
   * On the handle rather than derived in each spec because the daemon has to be told about it
   * at spawn time - the fake reads one env var, and a spec cannot add one afterwards.
   */
  ghPrsPath: string;
  /**
   * Where a spec scripts the fake `gh`'s product-report behavior, for THIS daemon.
   *
   * On the handle for `ghPrsPath`'s reason: the fake reads one env var, set at spawn time.
   */
  ghProductPath: string;
  /** Where a spec writes what the stand-in operator answers next. */
  productConsentPath: string;
  /** One JSON line per publish question the daemon actually asked. */
  productConsentAskedPath: string;
  /**
   * The fake ai-conductor installation this daemon probes, and where a spec scripts the
   * repositories it says it manages.
   *
   * On the handle for `ghPrsPath`'s reason: the fake reads one env var, set at spawn time,
   * so a spec cannot introduce one afterwards.
   */
  conductor: FakeConductor;
  /** Verified local source checkout seeded only for guided-installer specs. */
  conductorCheckout: string | null;
  /** Make the initially missing fake engine resolve on the next real provider probe. */
  installFakeConductor(): void;
  /** Start the real standalone Foreman worker against this isolated daemon and fake agents. */
  startForeman(): Promise<void>;
  /**
   * Everything the daemon has written to stdout/stderr so far. The daemon's structured
   * `[workflow]`/`[llm]` lines are the only view of a server-side failure a spec has -
   * the home dir is deleted on stop, so without this a seeding failure is undebuggable.
   */
  readLog(): string;
  /**
   * SIGKILL the daemon - the CRASH case, with no orderly shutdown of any kind. The
   * port, home and database stay put so `restart()` can bring a successor up on the
   * same coordinates. Exists for the states only an ungraceful death can produce:
   * transient daemon state (keep awake) must reset, `-w`-style child backstops must
   * fire, and the dashboard must fall to `reconnecting` rather than keep old claims.
   */
  crash(): Promise<void>;
  /** Boot a fresh daemon on the same port and home after `crash()`. */
  restart(): Promise<void>;
  stop(): Promise<void>;
}

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const BOOT_TIMEOUT_MS = 30_000;
const POLL_MS = 100;

/**
 * A terminal identity for the daemon to leak, seeded so that "it did not leak" can fail.
 *
 * `sdkSubprocessEnv` strips these three before launching an agent, and the launch spec
 * asserts the child received none of them. That assertion is worth nothing unless the
 * daemon HAD them: CI starts with no `TMUX_PANE`, `WEZTERM_PANE` or `TERM_PROGRAM`, so
 * inheriting `process.env` means the fake records `null` whether the stripping still works
 * or not - and a regression that forwarded the daemon's pane down to every session it
 * launches would sail through the one path CI actually requires.
 *
 * The values are deliberately recognisable rather than realistic. If one ever shows up in a
 * recorded invocation, the failure message names exactly what leaked and from where.
 *
 * This is not a hypothetical defect. Inheriting the spawner's pane env once fused two
 * different real cards onto one headless run's uuid, which is what `sdkSubprocessEnv`'s own
 * comment documents.
 */
export const DAEMON_TERMINAL_IDENTITY = {
  TMUX_PANE: "%e2e-daemon-tmux-pane",
  WEZTERM_PANE: "e2e-daemon-wezterm-pane",
  TERM_PROGRAM: "e2e-daemon-term-program",
} as const;

/**
 * A port the OS has just confirmed is free on loopback.
 *
 * NOT a fixed port derived from the worker index, which is what this was and which had a
 * bad failure mode: if anything already held the port - a concurrent `test:e2e`, a daemon
 * left behind by a killed run, an unrelated local service - the child would fail to bind
 * while `/api/health` kept answering, because the SQUATTER answered it. When the squatter is
 * itself a Mission Control daemon, the service check passes, and the fixture then rewrites
 * that daemon's harness config and dispatches sessions into it. A test suite quietly driving
 * someone else's daemon is the same class of hazard `MISSION_POLL_MS=0` exists to close.
 *
 * Binding port 0 makes the kernel pick, so two workers cannot collide by construction. There
 * is still a window between closing this probe and the daemon binding, which is why the boot
 * check below verifies the daemon's identity rather than trusting the port.
 */
async function freeLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (typeof address !== "object" || address === null) {
        probe.close(() => reject(new Error("could not read the probe socket's assigned port")));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * A real git repository for a dispatch to branch a worktree off.
 *
 * Real git rather than a stub directory because dispatch does real work with it - it cuts a
 * worktree and reads the branch. A fixture
 * that only looked like a repo would fail at the first `git` call, inside the daemon, where
 * the failure surfaces as an inscrutable dispatch error rather than as a broken fixture.
 *
 * Exported for the specs that need a SECOND repo in the same workspace - anything asserting
 * that a control is scoped to one repo has to have another one for it to be scoped away from.
 * Routes that take a repo path resolve it to a git root and refuse anything else, so a bare
 * `mkdir` cannot stand in for this.
 */
export function seedRepo(workspace: string, name: string): string {
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
  // Native return resets to the freshly fetched remote default. Give every fixture repo the
  // same local bare origin a real developer clone has, kept outside the scanned workspace so
  // it cannot appear as another dispatch target.
  const origins = join(dirname(workspace), "origins");
  const origin = join(origins, `${name}.git`);
  mkdirSync(origins, { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", origin], { stdio: "pipe" });
  git("remote", "add", "origin", origin);
  git("push", "-qu", "origin", "main");
  execFileSync("git", ["-C", origin, "symbolic-ref", "HEAD", "refs/heads/main"], { stdio: "pipe" });
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
export async function startDaemon(extraEnv: Record<string, string> = {}): Promise<DaemonHandle> {
  // `realpathSync` because macOS resolves /var -> /private/var, and the daemon reports the
  // resolved cwd for a session. The transcript path is derived from that cwd, so an
  // unresolved fixture path and the daemon's own view would disagree by a prefix and the
  // conversation would silently never be found.
  const home = realpathSync(mkdtempSync(join(tmpdir(), "mc-e2e-")));
  const workspace = join(home, "workspace");
  const port = await freeLoopbackPort();
  const { recordDir, bins } = writeFakeAgents(home);
  writeProductConsentBin(home);
  const conductor = writeFakeConductor(home);
  mkdirSync(workspace, { recursive: true });
  const repo = seedRepo(workspace, "demo-repo");
  const secondRepo = seedRepo(workspace, "second-repo");
  const conductorCheckout =
    extraEnv.MC_E2E_CONDUCTOR_CHECKOUT === "1"
      ? seedConductorInstallerCheckout(seedRepo(workspace, "ai-conductor"))
      : null;
  const startsMissing = extraEnv.MC_E2E_CONDUCTOR_STARTS_MISSING === "1";
  const installRoot = join(home, "installed-conductor");
  const installBin = join(installRoot, "bin/conduct-ts");

  const installFakeConductor = (): void => {
    if (!startsMissing) return;
    mkdirSync(join(installRoot, "bin"), { recursive: true });
    copyFileSync(conductor.bin, installBin);
    chmodSync(installBin, 0o755);
    writeFileSync(join(installRoot, "VERSION"), `${FAKE_CONDUCTOR_VERSION}\n`);
  };

  const isolatedEnv = {
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
    // The one terminal backend this suite installs, so continue-in-terminal is drivable on
    // a machine with no terminal: cmux resolves through this env override, needs no
    // emulator to raise its workspaces, and the fake records the `new-workspace --command`
    // it was handed - the exact command line a click asked a terminal to run. See
    // `FAKE_CMUX` in fake-agents.ts for why the other backends cannot play this role.
    CMUX_BIN: bins.cmux,
    // The keep-awake provider, redirected at a fake that records its argv. With the
    // override present this daemon is "supported" on any platform - which is the point:
    // Linux CI drives the full manager/route/SSE path, and no test run ever places a
    // real power assertion on the machine it runs on.
    MISSION_KEEP_AWAKE_BIN: bins.keepAwake,
    // Every `gh` call the daemon makes, redirected at a fake. This is the one override here
    // that is not about cost: `gh issue create` PUBLISHES to a repository other people watch,
    // and on a machine where `gh` is signed in - which is every machine this is developed on -
    // an unfaked binary would file a real issue on every run of the push spec. `ghBin()` is the
    // single seam every `gh` call in the daemon goes through, so the PR poller and the Inspector
    // are covered by this one variable rather than each needing its own.
    MISSION_GH_BIN: bins.gh,
    // The external SDLC engine, redirected at a fake. Not about cost either: the probe is
    // a subprocess, and on a machine where the operator actually uses conductor an
    // unfaked binary would list THEIR repositories in the Settings panel and read THEIR
    // state files - non-deterministic against CI, where there are none, and an
    // observation of somebody's real work. `AI_CONDUCTOR_REGISTRY` closes the other door:
    // the probe falls back to the registry FILE when the CLI cannot answer, and that file
    // lives in the operator's home unless it is pointed somewhere throwaway.
    MISSION_CONDUCTOR_BIN: startsMissing ? installBin : conductor.bin,
    AI_CONDUCTOR_REGISTRY: conductor.registryPath,
    MC_E2E_CONDUCTOR_PROJECTS: conductor.projectsPath,
    // Where that fake records the verbs it is asked for. Set for every daemon so a spec only
    // has to read the file; a daemon that never spawns a control verb simply leaves it absent.
    MC_E2E_CONDUCTOR_LOG: conductor.logPath,
    MC_E2E_RECORD_DIR: recordDir,
    // Re-read on every prompt-free Pi catalog probe so a spec can move from live discovery
    // to failure across a daemon restart without ever allowing a launch-shaped invocation.
    MC_E2E_PI_CATALOG_CONTROL: piCatalogControlPath(home),
    // Where that fake reads its scripted pull requests from. Set for every daemon so a spec
    // only has to write the file; absent content simply means "no pull requests anywhere",
    // which is what every spec that does not script one already expects.
    MC_E2E_GH_PRS: ghPullRequestsPath(home),
    // Where that fake reads its scripted product-report behavior from. Set for every daemon
    // so a spec only has to write the file; absent content is the working default, which is
    // what every spec that never opens the Feedback form already expects.
    MC_E2E_GH_PRODUCT: ghProductScriptPath(home),
    // The public repository product reports would target. Pointed at a fixture owner/name so
    // no run - not even one whose `gh` override somehow failed - names the real tracker. The
    // blast dam is `MISSION_GH_BIN` above; this is the second lock on the same door.
    MISSION_PRODUCT_ISSUES_REPO: "acme/public-issues",
    // The stand-in for the operator answering the native publish dialog. Without something
    // here the daemon can ask nobody and refuses every publish, which is exactly what a
    // daemon started outside the desktop shell is supposed to do.
    MISSION_PRODUCT_ISSUE_CONSENT_CMD: productConsentBinPath(home),
    // Native pools live inside this disposable MISSION_HOME. Keep their maintenance pass
    // deterministic during browser assertions; focused maintenance behavior belongs to the
    // allocator unit suite, while e2e specs drive explicit task cleanup.
    MISSION_WORKTREE_SWEEP_MS: "0",
    // Neither is terminal discovery. It walks EVERY process on the machine and cards
    // anything that looks like an agent, so on a developer's laptop this daemon adopts
    // their real sessions - non-deterministic against CI, where there are none, and
    // unsafe, because the dashboard's Kill and Reset controls would then act on them.
    // 0 switches passive discovery off entirely.
    MISSION_POLL_MS: "0",
    // A fake agent answers instantly, so the dispatch settle windows are pure latency here.
    MISSION_DISPATCH_SETTLE_MS: "0",
    // The same reasoning for the workflow sweep, which is what advances a session action
    // once its turn has settled. Shipped at 15s for a laptop with real agents on it; here
    // every turn is already over by the time the first sweep would have looked, so the
    // default is pure wall clock in every action spec.
    //
    // A second and lower, deliberately: this runs in EVERY daemon this suite starts, not
    // only the ones running an action, and four workers each hold a daemon and a browser.
    // `queued-turn-recall` has a real five-second budget between two submits, so background
    // work here is not free - and a sweep fifteen times faster than shipped is already far
    // more than the action specs need.
    MISSION_WORKFLOW_SWEEP_MS: "1000",
    // Same reasoning as the sweep above. The retro-worthiness scan decides whether the
    // dashboard offers a retrospective, and it is deliberately lazy in production - a stat
    // per unflipped live session every ten seconds, and nothing at all once one flips. Here
    // the transcripts are three turns long and a spec would otherwise spend that ten seconds
    // as pure wall clock waiting for a button to appear.
    MISSION_RETRO_SCAN_MS: "400",
    // Belt and braces: if some path ever escaped the fake bins, an unset key fails loudly
    // instead of quietly spending.
    ANTHROPIC_API_KEY: "",
    // Give the daemon a terminal identity to leak. See DAEMON_TERMINAL_IDENTITY.
    ...DAEMON_TERMINAL_IDENTITY,
    // Last, so a spec that needs a different cadence or feature switch can say so through
    // the `daemonEnv` fixture option rather than by editing this shared list.
    ...extraEnv,
  };

  let log = "";
  let exited: { code: number | null; signal: string | null } | null = null;

  /** Spawn the daemon bundle and wire its log and exit tracking to the shared state. */
  const spawnDaemon = (): ChildProcess => {
    exited = null;
    const spawned = spawn(process.execPath, [join(REPO_ROOT, "dist/server/index.mjs")], {
      cwd: REPO_ROOT,
      env: isolatedEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    spawned.stdout?.on("data", (d: Buffer) => (log += d.toString()));
    spawned.stderr?.on("data", (d: Buffer) => (log += d.toString()));
    spawned.on("exit", (code, signal) => (exited = { code, signal }));
    return spawned;
  };

  let child: ChildProcess = spawnDaemon();

  const baseURL = `http://127.0.0.1:${port}`;
  let foreman: ChildProcess | null = null;
  let foremanExited: { code: number | null; signal: string | null } | null = null;

  const startForeman = async (): Promise<void> => {
    if (foreman && !foremanExited) return;
    if (foremanExited) {
      throw new Error(
        `the isolated Foreman worker already exited (code ${foremanExited.code}, ` +
          `signal ${foremanExited.signal}):\n${log}`,
      );
    }

    const logStart = log.length;
    // The standalone worker is deliberately started only by specs that need its policy.
    // It receives the same isolated home and fake agent binaries as the daemon, closing
    // every route to operator state or paid model calls. A zero settle window removes only
    // test latency; the spec still waits for the worker's durable completion stamp.
    foreman = spawn(
      process.execPath,
      ["--import", "tsx", join(REPO_ROOT, "src/server/foreman/worker.ts")],
      {
        cwd: REPO_ROOT,
        env: {
          ...isolatedEnv,
          FOREMAN_QUEUE_SETTLE_MS: "0",
          FOREMAN_EVAL_DEBOUNCE_MS: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    foreman.stdout?.on("data", (d: Buffer) => (log += d.toString()));
    foreman.stderr?.on("data", (d: Buffer) => (log += d.toString()));
    foreman.on("exit", (code, signal) => (foremanExited = { code, signal }));

    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    for (;;) {
      if (foremanExited) {
        throw new Error(
          `Foreman exited before acquiring its lease (code ${foremanExited.code}, ` +
            `signal ${foremanExited.signal}):\n${log}`,
        );
      }
      if (log.slice(logStart).includes("[foreman] acquired the lease")) return;
      if (Date.now() > deadline) {
        throw new Error(`Foreman did not acquire its lease in ${BOOT_TIMEOUT_MS}ms:\n${log}`);
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  };

  const stop = async (): Promise<void> => {
    if (foreman && !foremanExited) {
      foreman.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 200));
      if (!foremanExited) foreman.kill("SIGKILL");
    }
    if (!exited) {
      child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 200));
      if (!exited) child.kill("SIGKILL");
    }
    /*
     * Retried, because the daemon is not the only writer under `home`.
     *
     * A dispatch leaves `git` processes of its own working inside the leased pool, and they do
     * not die with the daemon that spawned them: SIGKILL above returns as soon as the daemon is
     * gone, so a recursive delete can walk a directory a grandchild is still creating files in
     * and fail the TEST with `ENOTEMPTY` after its every assertion passed. Observed once in a
     * full-suite run on `multi-repo-dispatch`, which is the spec that spawns the most of them.
     * `maxRetries` is exactly what Node documents this for - it backs off on `ENOTEMPTY`,
     * `EBUSY` and `EPERM` - and a teardown that cannot clean up after five attempts over ~1.5s
     * is a real leak worth failing on rather than a race.
     */
    rmSync(home, { force: true, recursive: true, maxRetries: 5, retryDelay: 300 });
  };

  const awaitBoot = async (): Promise<void> => {
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
        const body = (await res.json().catch(() => ({}))) as { service?: string; pid?: number };
        if (body.service !== "mission-control") {
          await stop();
          throw new Error(`/api/health answered as ${JSON.stringify(body.service)}`);
        }
        // The daemon answering has to be the one we just spawned, not merely A daemon.
        //
        // `service` alone cannot tell those apart: a Mission Control daemon already holding
        // this port answers it perfectly, and everything after this point - the harness config
        // write, every dispatch - would land on that daemon's real database instead of the
        // throwaway one. `/api/health` reports `pid`, so identity is checkable rather than
        // assumed, and a lost race fails loudly here instead of silently driving someone
        // else's fleet.
        if (body.pid !== child.pid) {
          await stop();
          throw new Error(
            `port ${port} is held by a different Mission Control daemon (pid ${body.pid}, ` +
              `expected the spawned child's pid ${child.pid}). Refusing to run against it.`,
          );
        }
        return;
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  };
  await awaitBoot();

  const crash = async (): Promise<void> => {
    if (exited) return;
    const gone = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await gone;
  };

  const restart = async (): Promise<void> => {
    if (!exited) throw new Error("restart() is for a dead daemon - call crash() first");
    // Same port, same home, same env: the successor is the same installation coming back,
    // which is exactly the case transient state (keep awake) must reset across. The boot
    // check re-verifies identity by pid, so a squatter that stole the freed port between
    // the crash and this bind still fails loudly rather than being driven silently.
    child = spawnDaemon();
    await awaitBoot();
  };

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

  return {
    baseURL,
    home,
    recordDir,
    workspace,
    repo,
    secondRepo,
    ghPrsPath: ghPullRequestsPath(home),
    ghProductPath: ghProductScriptPath(home),
    productConsentPath: productConsentScriptPath(home),
    productConsentAskedPath: join(home, "product-consent-asked.jsonl"),
    conductor,
    conductorCheckout,
    installFakeConductor,
    readLog: () => log,
    startForeman,
    crash,
    restart,
    stop,
  };
}
