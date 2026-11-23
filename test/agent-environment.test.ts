import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { build } from "esbuild";
import { AgentEnvironmentConfigSchema } from "../src/shared/protocol.ts";
import { tokenPath } from "../src/shared/harness-runtime.mjs";
import { agentEnvironmentPresence, launchAgentEnvironment, saveAgentEnvironment } from "../src/server/agent-environment.ts";
import { applyFeatureFlagIntent } from "../src/server/feature-flags/index.ts";
import { isolatedAgentArgv } from "../src/server/agent-subprocess-env.ts";
import { beginResumeLaunch, createResumeLease, RESUME_START_MS, resumeLeaseRoot, writeResumeRecord } from "../src/server/terminal/resume-lease.ts";
import { terminalEnvironmentArgv } from "../src/server/terminal/environment-handoff.ts";
import { sdkSubprocessEnv } from "../src/server/harness/claude/sdk-deps.ts";

test("names reject assignments, duplicates, object keys, launcher identities and state credentials", () => {
  for (const name of ["TOKEN=example", "__proto__", "constructor", "MISSION_API_TOKEN", "FLEET_HOME",
    "HARNESS_PORT", "PATH", "WORK_UNIT_ID", "TMUX_PANE", "RESIDENT_STATE_DIR"]) {
    assert.equal(AgentEnvironmentConfigSchema.safeParse({ names: [name] }).success, false, name);
  }
  assert.equal(AgentEnvironmentConfigSchema.safeParse({ names: ["TOKEN", "TOKEN"] }).success, false);
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
    for (const name of ["SHELL", "SERVICE_OVERRIDE", "CREDENTIAL_ALIAS"]) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  });
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
  assert.deepEqual(view, [
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
    assert.deepEqual(await agentEnvironmentPresence(), [{ name: "SERVICE_OVERRIDE", present: true, source: "loginShell" }]);
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
    process.exitCode = matches && !env.MISSION_API_TOKEN && !env.MISSION_SCOUT_SESSION_LOCATOR
      && env.MISSION_PORT !== "spoofed-port" && !env.MISSING_NAME && env.TMUX_PANE === "%real" ? 0 : 1;
  `);
  const agent = [process.execPath, probe];
  const pane = { ...process.env, MISSING_NAME: "stale", TMUX_PANE: "%real" };
  // Check on entry as well as inside the agent. A guard that repairs its child's env could
  // otherwise pass while its own process and any helpers it starts receive the credential.
  const checkEntry = 'if [ -n "${MISSION_API_TOKEN:-}${MISSION_SCOUT_SESSION_LOCATOR:-}" ] || [ "${MISSION_PORT:-}" = spoofed-port ]; then exit 42; fi; exec "$@"';

  for (const kind of ["dispatch wrapper", "managed resume guard"] as const) {
    await t.test(kind, async (t) => {
      let stateHome: string;
      let argv: string[];
      let launchFile: string;
      if (kind === "dispatch wrapper") {
        stateHome = mkdtempSync(join(dir, "dispatch-"));
        argv = isolatedAgentArgv(agent, { stateHome });
        launchFile = argv[1]!;
      } else {
        const root = resumeLeaseRoot(dir);
        t.after(() => rmSync(root, { recursive: true, force: true }));
        const lease = createResumeLease(root, "test", new Set());
        stateHome = lease.home;
        launchFile = join(stateHome, "launch.json");
        writeResumeRecord(launchFile, { argv: agent, env: { MISSION_HOME: stateHome }, cwd: dir });
        beginResumeLaunch(lease);
        argv = [process.execPath, guard, root, lease.id];
      }
      const handoff = await terminalEnvironmentArgv(["/bin/sh", "-c", checkEntry, "entry-check", ...argv], { cwd: dir, stateHome }, named);
      t.after(handoff.dispose);
      assert.ok(!handoff.argv.join(" ").includes(secret));
      assert.ok(!readFileSync(launchFile, "utf8").includes(secret));
      await promisify(execFile)(handoff.argv[0]!, handoff.argv.slice(1), { env: pane });
    });
  }

  await t.test("a terminal handoff delivers the credential once and rejects the same argv before a second agent starts", async (t) => {
    const starts = join(dir, "agent-starts");
    const handoff = await terminalEnvironmentArgv([...agent, starts], { cwd: dir, stateHome: dir }, named);
    t.after(handoff.dispose);
    const launch = () => promisify(execFile)(handoff.argv[0]!, handoff.argv.slice(1), { env: { TMUX_PANE: "%real" } });

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
