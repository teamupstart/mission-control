import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, renameSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { build } from "esbuild";
import { APP_CONFIG_ENTRIES } from "../src/shared/app-config-entries.ts";
import { AgentEnvironmentConfigSchema } from "../src/shared/protocol.ts";
import { tokenPath } from "../src/shared/harness-runtime.mjs";
import { agentEnvironmentPresence, launchAgentEnvironment, saveAgentEnvironment } from "../src/server/agent-environment.ts";
import { applyFeatureFlagIntent } from "../src/server/feature-flags/index.ts";
import { isolatedAgentArgv } from "../src/server/agent-subprocess-env.ts";
import { beginResumeLaunch, createResumeLease, RESUME_START_MS, resumeLeaseRoot, writeResumeEnvironmentSocket, writeResumeRecord } from "../src/server/terminal/resume-lease.ts";
import { openTerminalEnvironmentHandoff, reconcileTerminalEnvironmentHandoffs, stopTerminalEnvironmentHandoffs, terminalEnvironmentArgv } from "../src/server/terminal/environment-handoff.ts";
import { sdkSubprocessEnv } from "../src/server/harness/claude/sdk-deps.ts";

test("a version 53 database gains an empty terminal warning store and retains its configured names", async () => {
  const { upgradeDatabaseToCurrentSchema } = await import("../src/server/db.ts");
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL); PRAGMA user_version = 53");
    const config = JSON.stringify({ names: ["SERVICE"] });
    db.prepare("INSERT INTO app_config VALUES (?, ?)").run(APP_CONFIG_ENTRIES.agentEnvironment.key, config);
    upgradeDatabaseToCurrentSchema(db);
    assert.equal(db.prepare("SELECT count(*) AS n FROM terminal_launch_warnings").get()?.n, 0);
    assert.equal(db.prepare("SELECT value FROM app_config WHERE key = ?").get(APP_CONFIG_ENTRIES.agentEnvironment.key)?.value, config);
  } finally { db.close(); }
});

test("an unclaimed warning cannot be taken by a replaced launch directory and is pruned", async (t) => {
  const { rememberTerminalLaunchWarning, restoreTerminalLaunchWarning, pruneTerminalLaunchWarnings } =
    await import("../src/server/terminal-launch-warnings.ts");
  const { openDb } = await import("../src/server/db.ts");
  const dir = mkdtempSync(join(tmpdir(), "agent-warning-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, "launch");
  mkdirSync(home);
  rememberTerminalLaunchWarning(home, ["MISSING"]);
  renameSync(home, join(dir, "previous"));
  mkdirSync(home);
  assert.equal(restoreTerminalLaunchWarning("proc:replacement", home), undefined);
  pruneTerminalLaunchWarnings(new Set());
  assert.equal(openDb().prepare("SELECT 1 FROM terminal_launch_warnings WHERE launch_home = ?").get(home), undefined);
});

test("names reject assignments, duplicates, object keys, launcher identities and state credentials", () => {
  for (const name of ["TOKEN=example", "__proto__", "constructor", "MISSION_API_TOKEN", "FLEET_HOME",
    "HARNESS_PORT", "CODEX_HOME", "PATH", "WORK_UNIT_ID", "TMUX_PANE", "RESIDENT_STATE_DIR"]) {
    assert.equal(AgentEnvironmentConfigSchema.safeParse({ names: [name] }).success, false, name);
  }
  assert.equal(AgentEnvironmentConfigSchema.safeParse({ names: ["TOKEN", "TOKEN"] }).success, false);
});

test("a stored list from before CODEX_HOME was reserved retains its other valid names", () => {
  assert.deepEqual(APP_CONFIG_ENTRIES.agentEnvironment.schema.parse({ names: ["SERVICE", "CODEX_HOME"] }), { names: ["SERVICE"] });
});

test("Agent environment accepts 32 unique names and rejects a 33rd", () => {
  const names = Array.from({ length: 32 }, (_, index) => `TEST_VAR_${index + 1}`);
  assert.deepEqual(AgentEnvironmentConfigSchema.parse({ names }).names, names);
  assert.equal(AgentEnvironmentConfigSchema.safeParse({ names: [...names, "TEST_VAR_33"] }).success, false);
});

test("each launch reads selected names afresh, prefers the daemon and omits its token under an alias", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agent-environment-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const shell = join(dir, "shell");
  const previous = { ...process.env };
  t.after(() => {
    for (const name of ["SHELL", "SHELL_ONLY", "MISSING_NAME", "SERVICE_OVERRIDE", "CREDENTIAL_ALIAS"]) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  });
  delete process.env.SHELL_ONLY;
  delete process.env.MISSING_NAME;
  process.env.SHELL = shell;
  process.env.SERVICE_OVERRIDE = "daemon-choice";
  process.env.CREDENTIAL_ALIAS = "prefix-test-daemon-bearer";
  mkdirSync(dirname(tokenPath()), { recursive: true });
  writeFileSync(tokenPath(), "test-daemon-bearer");
  const profile = (value: string) => writeFileSync(shell,
    `#!/bin/sh\nexport SHELL_ONLY=${value} SERVICE_OVERRIDE=shell-choice IGNORED_NAME=ignored\nexec /bin/sh -c "$2"\n`, { mode: 0o700 });
  profile("first");
  saveAgentEnvironment(["SHELL_ONLY", "SERVICE_OVERRIDE", "MISSING_NAME", "CREDENTIAL_ALIAS"]);
  assert.equal(await launchAgentEnvironment(), undefined);
  applyFeatureFlagIntent({ kind: "flag", id: "agent-environment", enabled: true });
  assert.equal(await launchAgentEnvironment(true), undefined);
  const view = await agentEnvironmentPresence();
  assert.deepEqual(view.variables, [
    { name: "SHELL_ONLY", present: true, source: "loginShell" },
    { name: "SERVICE_OVERRIDE", present: true, source: "daemon" },
    { name: "MISSING_NAME", present: false, source: null },
    { name: "CREDENTIAL_ALIAS", present: false, source: null },
  ]);
  assert.equal((await launchAgentEnvironment())?.extraEnv.SHELL_ONLY, "first");
  profile("second");
  const named = await launchAgentEnvironment();
  assert.deepEqual(named, { extraEnv: { SHELL_ONLY: "second", SERVICE_OVERRIDE: "daemon-choice" }, missing: ["MISSING_NAME", "CREDENTIAL_ALIAS"] });
  const isolated = sdkSubprocessEnv(process.env, dir, dir, named);
  assert.equal(isolated.CREDENTIAL_ALIAS, undefined);
  assert.equal(isolated.IGNORED_NAME, undefined);
  process.env.SHELL = join(dir, "unavailable");
  assert.ok((await launchAgentEnvironment())?.missing.includes("SHELL_ONLY"));

  await t.test("an empty daemon value uses the login-shell value and reports its source", async () => {
    process.env.SHELL = shell;
    process.env.SERVICE_OVERRIDE = "";
    saveAgentEnvironment(["SERVICE_OVERRIDE"]);
    assert.deepEqual(await launchAgentEnvironment(), { extraEnv: { SERVICE_OVERRIDE: "shell-choice" }, missing: [] });
    assert.deepEqual((await agentEnvironmentPresence()).variables, [{ name: "SERVICE_OVERRIDE", present: true, source: "loginShell" }]);
  });
});

test("terminal handoff enforces SDK isolation before either launch command executes", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "terminal-environment-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const guard = join(dir, "resume-guard.mjs");
  await build({ entryPoints: ["src/server/terminal/resume-guard.ts"], outfile: guard, platform: "node", format: "esm", bundle: true });
  const previousGuard = process.env.MISSION_RESUME_GUARD;
  process.env.MISSION_RESUME_GUARD = guard;
  t.after(() => {
    if (previousGuard === undefined) delete process.env.MISSION_RESUME_GUARD;
    else process.env.MISSION_RESUME_GUARD = previousGuard;
  });
  const secret = "synthetic '\n$() value";
  const named = {
    // Deliberately enter below Settings validation. Isolation must hold at the process boundary.
    extraEnv: { FIXTURE_TOKEN: secret, MISSION_API_TOKEN: secret, MISSION_PORT: "spoofed-port", MISSION_SCOUT_SESSION_LOCATOR: secret, TMUX_PANE: "wrong-pane" },
    missing: ["MISSING_NAME"],
  };
  const sdk = sdkSubprocessEnv({}, dir, dir, named);
  assert.equal(sdk.MISSION_API_TOKEN, undefined);
  assert.equal(sdk.MISSION_SCOUT_SESSION_LOCATOR, undefined);
  assert.equal(sdk.TMUX_PANE, undefined);
  assert.notEqual(sdk.MISSION_PORT, named.extraEnv.MISSION_PORT);

  const probe = join(dir, "probe.cjs");
  const digest = createHash("sha256").update(secret).digest("hex");
  writeFileSync(probe, `
    if (process.argv[2]) require("node:fs").appendFileSync(process.argv[2], "started\\n");
    const env = process.env;
    const matches = require("node:crypto").createHash("sha256").update(env.FIXTURE_TOKEN ?? "").digest("hex") === ${JSON.stringify(digest)};
    process.exitCode = matches && !env.MISSION_TERMINAL_HANDOFF_TICKET && !env.MISSION_API_TOKEN && !env.MISSION_SCOUT_SESSION_LOCATOR
      && env.MISSION_PORT !== "spoofed-port" && !env.MISSING_NAME && env.TMUX_PANE === "%real" ? 0 : 1;
  `);
  const agent = [process.execPath, probe];
  const pane = { ...process.env, MISSING_NAME: "stale", TMUX_PANE: "%real" };
  // Check dispatch wrapper entry as well as the final agent, before the wrapper can repair its environment.
  const checkEntry = 'if [ -n "${FIXTURE_TOKEN+x}${MISSION_API_TOKEN:-}${MISSION_SCOUT_SESSION_LOCATOR:-}" ] || [ "${MISSION_PORT:-}" = spoofed-port ]; then exit 42; fi; exec "$@"';

  for (const kind of ["dispatch wrapper", "managed resume guard"] as const) {
    await t.test(kind, async (t) => {
      let stateHome: string;
      let launchFile: string;
      let paneCommand: string[];
      if (kind === "dispatch wrapper") {
        stateHome = mkdtempSync(join(dir, "dispatch-"));
        const handoff = await terminalEnvironmentArgv(agent, { cwd: dir, stateHome }, named, {
          wrap: (reader) => {
            const wrapper = isolatedAgentArgv(reader, { stateHome });
            launchFile = wrapper[1]!;
            return ["/bin/sh", "-c", checkEntry, "entry-check", ...wrapper];
          },
          fallbackArgv: null,
        });
        t.after(handoff.dispose);
        assert.ok(!readFileSync(join(stateHome, "launch.json"), "utf8").includes(secret));
        paneCommand = handoff.argv;
      } else {
        const root = resumeLeaseRoot(dir);
        t.after(() => rmSync(root, { recursive: true, force: true }));
        const lease = createResumeLease(root, "test", new Set());
        stateHome = lease.home;
        launchFile = join(stateHome, "launch.json");
        writeResumeRecord(launchFile, { argv: agent, env: { MISSION_HOME: stateHome }, cwd: dir });
        beginResumeLaunch(lease);
        const handoff = await openTerminalEnvironmentHandoff({ cwd: dir, stateHome }, named);
        t.after(handoff.dispose);
        writeResumeEnvironmentSocket(lease, handoff.path);
        paneCommand = handoff.authorize([process.execPath, guard, root, lease.id]);
      }
      assert.ok(!paneCommand.join(" ").includes(secret));
      assert.ok(!readFileSync(launchFile!, "utf8").includes(secret));
      await promisify(execFile)(paneCommand[0]!, paneCommand.slice(1), { env: pane });
    });
  }

  await t.test("named dispatch runs executable shell text without a shebang and preserves its arguments and credential", async (t) => {
    const stateHome = mkdtempSync(join(dir, "dispatch-shim-"));
    const shim = join(dir, "harness-shim");
    writeFileSync(shim, 'exec "$@"\n', { mode: 0o700 });
    const output = join(dir, "shim started");
    const handoff = await terminalEnvironmentArgv([shim, ...agent, output], { cwd: dir, stateHome }, named, {
      wrap: (reader) => isolatedAgentArgv(reader, { stateHome }), fallbackArgv: null,
    });
    t.after(handoff.dispose);
    await promisify(execFile)(handoff.argv[0]!, handoff.argv.slice(1), { env: pane });
    assert.equal(readFileSync(output, "utf8"), "started\n");
    assert.equal(existsSync(stateHome), false, "the owning wrapper cleaned up");
  });

  await t.test("named dispatch respects execute permission and preserves a shim's exit status", async (t) => {
    for (const executable of [false, true]) {
      const stateHome = mkdtempSync(join(dir, "shim-status-"));
      const shim = join(dir, executable ? "returns-126" : "no-execute-permission");
      const marker = shim + ".starts";
      writeFileSync(shim, 'echo started >> "$1"\nexit 126\n', { mode: executable ? 0o700 : 0o600 });
      const handoff = await terminalEnvironmentArgv([shim, marker], { cwd: dir, stateHome }, named, {
        wrap: (reader) => isolatedAgentArgv(reader, { stateHome }), fallbackArgv: null,
      });
      t.after(handoff.dispose);
      const code = await new Promise((resolve) => {
        execFile(handoff.argv[0]!, handoff.argv.slice(1), { env: pane }, (error) => resolve(error?.code ?? 0));
      });
      if (executable) {
        assert.equal(code, 126);
        assert.equal(readFileSync(marker, "utf8"), "started\n");
      } else {
        assert.notEqual(code, 0);
        assert.equal(existsSync(marker), false);
      }
    }
  });

  await t.test("a named dispatch probes the final agent size and records only the command that ran", async (t) => {
    for (const fits of [true, false]) {
      const stateHome = mkdtempSync(join(dir, "dispatch-fit-"));
      const output = join(dir, fits ? "primary-start" : "fallback-start");
      const command = [...agent, output, fits ? "short" : "p".repeat(3 * 1024 * 1024)];
      const handoff = await terminalEnvironmentArgv(command, { cwd: dir, stateHome }, named, {
        wrap: (reader) => isolatedAgentArgv(reader, { stateHome }), fallbackArgv: [...agent, output],
      });
      t.after(handoff.dispose);
      await promisify(execFile)(handoff.argv[0]!, handoff.argv.slice(1), { env: pane });
      assert.equal(readFileSync(output, "utf8"), "started\n");
      assert.equal(readFileSync(stateHome + ".turn-one", "utf8"), fits ? "shaped" : "original");
    }
  });

  await t.test("a terminal handoff delivers the credential once and rejects the same argv before a second agent starts", async (t) => {
    const starts = join(dir, "agent-starts");
    const handoff = await terminalEnvironmentArgv([...agent, starts], { cwd: dir, stateHome: dir }, named);
    t.after(handoff.dispose);
    const launch = () => promisify(execFile)(handoff.argv[0]!, handoff.argv.slice(1), { env: { TMUX_PANE: "%real" } });

    const wrongTicket = handoff.argv.slice(1).map((arg) => arg.startsWith("MISSION_TERMINAL_HANDOFF_TICKET=")
      ? "MISSION_TERMINAL_HANDOFF_TICKET=" + "00".repeat(32) : arg);
    await assert.rejects(promisify(execFile)(handoff.argv[0]!, wrongTicket), { code: 1, stderr: /could not read/ });
    assert.equal(existsSync(starts), false);
    await launch(); // The agent exits successfully only when it receives the expected credential.
    assert.equal(readFileSync(starts, "utf8"), "started\n");
    await assert.rejects(launch(), { code: 1, stderr: /could not read the terminal environment handoff/ });
    assert.equal(readFileSync(starts, "utf8"), "started\n", "reusing the handoff must never enter the agent");
  });

  await t.test("concurrent handoffs use separate private directories and remove them after use or disposal", async (t) => {
    const start = () => terminalEnvironmentArgv(["/bin/pwd", "-P"], { cwd: dir, stateHome: dir }, named);
    const first = await start();
    t.after(first.dispose);
    const second = await start();
    t.after(second.dispose);
    const socketDir = (argv: string[]) => dirname(argv[argv.indexOf("--with-agent-environment") + 1]!);
    const firstDir = socketDir(first.argv);
    const secondDir = socketDir(second.argv);
    assert.notEqual(firstDir, secondDir);
    for (const path of [firstDir, secondDir]) {
      const stat = lstatSync(path);
      assert.ok(stat.isDirectory());
      assert.equal(stat.uid, process.getuid!());
      assert.equal(stat.mode & 0o777, 0o700);
    }
    first.dispose();
    const result = await promisify(execFile)(second.argv[0]!, second.argv.slice(1), { cwd: dir });
    assert.equal(result.stdout.trim(), realpathSync(dir), "the command starts in the pane's original working directory");
    assert.equal(existsSync(firstDir), false);
    assert.equal(existsSync(secondDir), false);
  });

  await t.test("a pane starting after expiry gets a fixed handoff diagnostic and never runs the agent", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const marker = join(dir, "expired-agent-started");
    const handoff = await terminalEnvironmentArgv(["/usr/bin/touch", marker], { cwd: dir, stateHome: dir }, named);
    t.after(handoff.dispose);
    t.mock.timers.tick(RESUME_START_MS);
    await assert.rejects(promisify(execFile)(handoff.argv[0]!, handoff.argv.slice(1)), (error: Error & { code?: number; stderr?: string }) => {
      assert.equal(error.code, 1);
      assert.equal(error.stderr?.trim(), "Mission Control could not read the terminal environment handoff. It expired or is unavailable. Start a new launch.");
      return true;
    });
    assert.equal(existsSync(marker), false);
  });
});

test("the handoff refuses a valid ticket at its deadline even before the expiry timer runs", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "terminal-deadline-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const start = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const handoff = await openTerminalEnvironmentHandoff({ cwd: dir, stateHome: dir }, { extraEnv: {}, missing: [] });
  t.after(handoff.dispose);
  const reader = createConnection(handoff.path);
  t.after(() => reader.destroy());
  await once(reader, "connect");
  const ticket = handoff.authorize([])[1]!.split("=")[1]!;
  let received = 0;
  reader.on("data", (chunk: Buffer) => { received += chunk.length; });
  const closed = once(reader, "close");
  // Move only the wall clock: the pane is connected and the real cleanup timer is still pending.
  t.mock.timers.setTime(start + RESUME_START_MS);
  reader.write(Buffer.from(ticket, "hex"));
  await closed;
  assert.equal(received, 0);
  assert.equal(existsSync(dirname(handoff.path)), false);
});

test("startup reclaims a crashed handoff owner and leaves live, foreign and unexpected entries alone", { timeout: 15_000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "agent-env-crash-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const script = `
    import { openTerminalEnvironmentHandoff } from "./src/server/terminal/environment-handoff.ts";
    const home = process.env.MISSION_HOME;
    const handoff = await openTerminalEnvironmentHandoff({ cwd: home, stateHome: home }, { extraEnv: {}, missing: [] });
    console.log(handoff.path);
    setInterval(() => {}, 60_000);
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script],
    { env: { ...process.env, MISSION_HOME: home } });
  const closed = once(child, "close");
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  const lines = createInterface({ input: child.stdout });
  t.after(() => lines.close());
  const ready = await lines[Symbol.asyncIterator]().next();
  assert.ok(!ready.done, "the fixture daemon opened its handoff");
  const path = ready.value;
  const directory = dirname(path);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  reconcileTerminalEnvironmentHandoffs(home);
  assert.ok(lstatSync(path).isSocket(), "the live owner's socket survives startup");
  child.kill("SIGKILL");
  assert.deepEqual(await closed, [null, "SIGKILL"]);
  reconcileTerminalEnvironmentHandoffs(join(home, "another-state"));
  assert.ok(lstatSync(path).isSocket(), "a different state home cannot reclaim this socket");
  const unexpected = join(directory, "unexpected");
  writeFileSync(unexpected, "preserve");
  reconcileTerminalEnvironmentHandoffs(home);
  assert.ok(existsSync(unexpected) && existsSync(path));
  rmSync(unexpected);
  reconcileTerminalEnvironmentHandoffs(home);
  assert.equal(existsSync(directory), false);
  reconcileTerminalEnvironmentHandoffs(home);
});

test("shutdown removes pending handoff sockets and directories and refuses new handoffs", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "terminal-environment-stop-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const start = () => openTerminalEnvironmentHandoff({ cwd, stateHome: cwd }, { extraEnv: {}, missing: ["MISSING"] });
  const pending = await Promise.all([start(), start()]);
  for (const { path } of pending) assert.ok(lstatSync(path).isSocket());
  await stopTerminalEnvironmentHandoffs();
  for (const { path } of pending) assert.equal(existsSync(dirname(path)), false);
  await assert.rejects(start(), /stopping/);
});
