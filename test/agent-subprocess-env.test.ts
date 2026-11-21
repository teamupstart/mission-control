import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "mission-agent-env-test-"));
const operatorState = join(root, "operator-state");
mkdirSync(operatorState, { recursive: true });
writeFileSync(join(operatorState, "token"), "loopback-test-token\n", { mode: 0o600 });
process.env.HARNESS_HOME = operatorState;
// Resolve a known nondefault port before imports, independent of the workflow's port.
const daemonPort = 17317;
process.env.MISSION_PORT = String(daemonPort);

const { shellCommand } = await import("../src/server/terminal/shell.ts");
const {
  agentSubprocessEnv,
  cleanupAgentSubprocessEnv,
  dropPaneIdentityEnv,
  isolatedAgentArgv,
} = await import("../src/server/agent-subprocess-env.ts");
const {
  MISSION_API_TOKEN_ENV,
  MISSION_API_TOKEN_FILE_ENV,
  PORT,
  SCOUT_SUBMISSION_CREDENTIAL_FILE_ENV,
  isolatedScoutSubmissionCredentialPath,
  readClientToken,
  readToken,
} = await import("../src/shared/harness-runtime.mjs");

after(() => rmSync(root, { recursive: true, force: true }));

test("the subprocess helper resolves the shared runtime port export", () => {
  assert.equal(PORT, daemonPort);
  const env = agentSubprocessEnv({}, { loopbackAccess: true });
  try {
    assert.equal(env.MISSION_PORT, String(PORT));
  } finally {
    cleanupAgentSubprocessEnv(env);
  }
});

test("pane identity scrubbing removes only terminal pane ownership", () => {
  const env: Record<string, string | undefined> = {
    TMUX_PANE: "%3",
    WEZTERM_PANE: "7",
    ITERM_SESSION_ID: "w0t0p0:UUID",
    TERM_PROGRAM: "iTerm.app",
    ORDINARY_TOOL_SETTING: "kept",
  };

  dropPaneIdentityEnv(env);

  assert.equal(env.TMUX_PANE, undefined);
  assert.equal(env.WEZTERM_PANE, undefined);
  assert.equal(env.ITERM_SESSION_ID, undefined);
  assert.equal(env.TERM_PROGRAM, "iTerm.app");
  assert.equal(env.ORDINARY_TOOL_SETTING, "kept");
});

test("agent launch env replaces every inherited state alias and preserves loopback access", () => {
  const inherited = {
    PATH: process.env.PATH,
    MISSION_HOME: operatorState,
    FLEET_HOME: join(root, "old-fleet"),
    HARNESS_HOME: join(root, "old-harness"),
    ORDINARY_TOOL_SETTING: "kept",
    MISSION_SCOUT_SESSION_LOCATOR: "inherited-launch-secret",
  };
  const cwd = join(root, "checkout");
  const first = agentSubprocessEnv(inherited, { loopbackAccess: true, cwd });
  const second = agentSubprocessEnv(inherited, { loopbackAccess: true });

  assert.equal(first.ORDINARY_TOOL_SETTING, "kept");
  assert.equal(first.MISSION_SCOUT_SESSION_LOCATOR, undefined);
  assert.equal(first.FLEET_HOME, undefined);
  assert.equal(first.HARNESS_HOME, undefined);
  assert.notEqual(first.MISSION_HOME, operatorState);
  assert.notEqual(first.MISSION_HOME, second.MISSION_HOME, "each launch receives its own home");
  assert.ok(existsSync(first.MISSION_HOME!));
  assert.equal(first.MISSION_PORT, String(daemonPort));
  assert.equal(first[MISSION_API_TOKEN_ENV], undefined);
  assert.equal(readFileSync(first[MISSION_API_TOKEN_FILE_ENV]!, "utf8").trim(), "loopback-test-token");
  assert.equal(statSync(first[MISSION_API_TOKEN_FILE_ENV]!).mode & 0o777, 0o600);
  assert.equal(
    first[SCOUT_SUBMISSION_CREDENTIAL_FILE_ENV],
    isolatedScoutSubmissionCredentialPath(cwd),
  );
  cleanupAgentSubprocessEnv(first);
  cleanupAgentSubprocessEnv(second);
});

test("a direct child credential does not change the daemon's state-backed token", () => {
  const previous = process.env[MISSION_API_TOKEN_ENV];
  process.env[MISSION_API_TOKEN_ENV] = "isolated-child-token";
  try {
    assert.equal(readToken(), "loopback-test-token");
    assert.equal(readClientToken(), "isolated-child-token");
  } finally {
    if (previous === undefined) delete process.env[MISSION_API_TOKEN_ENV];
    else process.env[MISSION_API_TOKEN_ENV] = previous;
  }
});

test("an isolated client reads the restrictive token file without a direct bearer", () => {
  const tokenFile = join(root, "isolated-client-token");
  writeFileSync(tokenFile, "file-delivered-token\n", { mode: 0o600 });
  const previousDirect = process.env[MISSION_API_TOKEN_ENV];
  const previousFile = process.env[MISSION_API_TOKEN_FILE_ENV];
  delete process.env[MISSION_API_TOKEN_ENV];
  process.env[MISSION_API_TOKEN_FILE_ENV] = tokenFile;
  try {
    assert.equal(readClientToken(), "file-delivered-token");
  } finally {
    if (previousDirect === undefined) delete process.env[MISSION_API_TOKEN_ENV];
    else process.env[MISSION_API_TOKEN_ENV] = previousDirect;
    if (previousFile === undefined) delete process.env[MISSION_API_TOKEN_FILE_ENV];
    else process.env[MISSION_API_TOKEN_FILE_ENV] = previousFile;
  }
});

test("terminal argv applies isolation after the terminal server's inherited environment", () => {
  const argv = isolatedAgentArgv([
    process.execPath,
    "-e",
    `process.stdout.write(JSON.stringify({mission:process.env.MISSION_HOME,fleet:process.env.FLEET_HOME,harness:process.env.HARNESS_HOME,direct:process.env.${MISSION_API_TOKEN_ENV},tokenFile:process.env.${MISSION_API_TOKEN_FILE_ENV},token:require("node:fs").readFileSync(process.env.${MISSION_API_TOKEN_FILE_ENV},"utf8").trim()}))`,
  ]);
  assert.equal(argv.some((arg) => arg.includes("loopback-test-token")), false);
  assert.equal(argv.some((arg) => arg.startsWith(`${MISSION_API_TOKEN_ENV}=`)), false);
  // The environment now travels in the wrapper script rather than in the argv - see the case
  // below for why - so what used to be an assertion about an argv element is one about the
  // script. The end-to-end run underneath is unchanged and is what actually proves it.
  const script = readFileSync(argv.at(-1)!, "utf8");
  assert.match(script, new RegExp(`^export ${MISSION_API_TOKEN_FILE_ENV}=`, "m"));
  assert.equal(script.includes("loopback-test-token"), false);
  const result = JSON.parse(execFileSync(argv[0]!, argv.slice(1), {
    encoding: "utf8",
    env: {
      ...process.env,
      MISSION_HOME: operatorState,
      FLEET_HOME: operatorState,
      HARNESS_HOME: operatorState,
    },
  })) as {
    mission: string;
    fleet?: string;
    harness?: string;
    direct?: string;
    tokenFile: string;
    token: string;
  };

  assert.notEqual(result.mission, operatorState);
  assert.equal(existsSync(result.mission), false, "the terminal wrapper removes its state home");
  assert.equal(result.fleet, undefined);
  assert.equal(result.harness, undefined);
  assert.equal(result.direct, undefined);
  assert.equal(result.tokenFile.startsWith(result.mission), true);
  assert.equal(result.token, "loopback-test-token");
});

test("the launch wrapper carries the environment and the agent, so what a backend types is short", () => {
  // The Herdr defect this shape exists for: its socket API has no command parameter, so a
  // launch is TYPED into a login shell as a bracketed paste, and at the size a real dispatch
  // used to produce - 3,546 bytes measured on the operator's machine - the paste and its
  // Enter race. The command sat unexecuted at the prompt and the dispatch failed thirty
  // seconds later blaming the agent for exiting. tmux and cmux exec what they are handed and
  // never noticed the length; they get the shorter command for free.
  const argv = isolatedAgentArgv(["/agents/claude", "--model", "opus", "don't"]);

  assert.equal(argv.length, 2, "the interpreter and the wrapper, and nothing else");
  assert.equal(argv[0], "/bin/sh");
  // An order of magnitude, not a byte count: the wrapper path is a temp dir whose length is
  // the platform's business. What must hold is that this is nothing like 3,546 bytes.
  const command = shellCommand(argv);
  assert.ok(command.length < 300, `a backend receives ${command.length} bytes`);

  const script = readFileSync(argv[1]!, "utf8");
  // Every state-home spelling is removed before anything is exported, so the login shell's
  // own MISSION_HOME cannot survive into the agent.
  assert.match(script, /^unset MISSION_HOME FLEET_HOME HARNESS_HOME$/m);
  assert.match(script, /^export PATH=/m);
  assert.match(script, /^export MISSION_HOME=/m);
  // The agent is the last statement, quoted the way a backend would quote it, and NOT
  // `exec`ed: `exec` replaces the shell, so the EXIT trap below would never fire and the
  // disposable state home would never be released.
  assert.equal(script.includes("exec "), false);
  assert.match(script, /^trap '\/bin\/rm -rf -- "\$MISSION_HOME"' EXIT$/m);
  assert.equal(script.trimEnd().split("\n").at(-1), `'/agents/claude' '--model' 'opus' 'don'"'"'t'`);

  rmSync(dirname(argv[1]!), { recursive: true, force: true });
});

test("a workflow-style environment gets disposable state without daemon credentials", () => {
  const env = agentSubprocessEnv(
    {
      PATH: "/usr/bin",
      MISSION_HOME: operatorState,
      [MISSION_API_TOKEN_ENV]: "must-not-survive",
      [SCOUT_SUBMISSION_CREDENTIAL_FILE_ENV]: "/tmp/must-not-survive",
    },
    { loopbackAccess: false },
  );
  assert.notEqual(env.MISSION_HOME, operatorState);
  assert.ok(existsSync(env.MISSION_HOME!));
  assert.equal(env[MISSION_API_TOKEN_ENV], undefined);
  assert.equal(env[MISSION_API_TOKEN_FILE_ENV], undefined);
  assert.equal(env[SCOUT_SUBMISSION_CREDENTIAL_FILE_ENV], undefined);
  cleanupAgentSubprocessEnv(env);
});

/** A stand-in agent that records how many arguments it got and the length of its last one. */
function recordingAgent(name: string): { agent: string; out: string } {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const out = join(dir, "launched");
  const agent = join(dir, "agent");
  writeFileSync(agent, [
    "#!/bin/sh",
    `for last in "$@"; do :; done`,
    `printf '%s:%s' "$#" "\${#last}" > ${shellCommand([out])}`,
    "",
  ].join("\n"), { mode: 0o755 });
  return { agent, out };
}

test("a launch with a fallback runs its own argv when it fits in the pane's environment", () => {
  const { agent, out } = recordingAgent("fits");
  const shaped = [agent, "--session-id", "s1", "x".repeat(20_000)];
  const argv = isolatedAgentArgv(shaped, { fallbackArgv: [agent, "--session-id", "s1", "short"] });
  execFileSync(argv[0]!, argv.slice(1), { env: process.env });
  assert.equal(readFileSync(out, "utf8"), "3:20000", "the shaped turn one launched");
  // The answer outlives the state home the wrapper removed when the agent exited.
  const stateHome = dirname(argv[1]!);
  assert.equal(existsSync(stateHome), false);
  assert.equal(readFileSync(`${stateHome}.turn-one`, "utf8"), "shaped");
  rmSync(`${stateHome}.turn-one`, { force: true });
});

test("a launch whose argv would not fit in the pane's inherited environment runs the fallback and says so", () => {
  const { agent, out } = recordingAgent("falls-back");
  const big = "x".repeat(100_000);
  const shaped = [agent, "--session-id", "s1", big];
  const fallback = [agent, "--session-id", "s1", "the original prompt"];
  const argMax = Number(execFileSync("/usr/bin/getconf", ["ARG_MAX"], { encoding: "utf8" }).trim());
  // The pane's environment: what the daemon would see, plus a terminal server's own variables
  // filling all but about 40 KiB of the limit - room for the original prompt, not the shaped one.
  const count = (value: string) => Buffer.byteLength(value) + 1 + 8;
  const pane: Record<string, string> = { ...(process.env as Record<string, string>) };
  let used = Object.entries(pane).reduce((sum, [k, v]) => sum + count(`${k}=${v}`), 0) + 16 * 1024;
  for (let n = 0; argMax - used > 40 * 1024 + 4096; n++) {
    const name = `TERMINAL_SERVER_PAD_${n}`;
    const value = "p".repeat(4000);
    pane[name] = value;
    used += count(`${name}=${value}`);
  }
  // The failure this guards against, reproduced: the shaped exec itself is refused under that
  // environment, while the original one runs.
  assert.throws(() => execFileSync(agent, shaped.slice(1), { env: pane }), (error: NodeJS.ErrnoException) => error.code === "E2BIG");
  execFileSync(agent, fallback.slice(1), { env: pane });

  const argv = isolatedAgentArgv(shaped, { fallbackArgv: fallback });
  execFileSync(argv[0]!, argv.slice(1), { env: pane });
  assert.equal(readFileSync(out, "utf8"), `3:${"the original prompt".length}`, "the wrapper launched the original turn one");
  const stateHome = dirname(argv[1]!);
  assert.equal(readFileSync(`${stateHome}.turn-one`, "utf8"), "original", "and said so, where the dispatcher reads it");
  rmSync(`${stateHome}.turn-one`, { force: true });
});

test("a launch with no fallback keeps its one-line agent command", () => {
  const argv = isolatedAgentArgv(["/agents/pi", "--session-id", "s1", "turn one"]);
  const script = readFileSync(argv[1]!, "utf8");
  assert.equal(script.includes("mission-turn-one-probe"), false);
  assert.equal(script.trimEnd().split("\n").at(-1), "'/agents/pi' '--session-id' 's1' 'turn one'");
  rmSync(dirname(argv[1]!), { recursive: true, force: true });
});

test("a launch read back through the wrapper is the primary launch, fallback or not, with multiline prompts", async () => {
  const { launchedArgv } = await import("./helpers/isolated-launch.ts");
  // Real turn ones span lines, and the shaped one carries a section whose lines a naive reader
  // would take for statements, apostrophes included.
  const shaped = ["/agents/pi", "--session-id", "s1",
    "Fix the charge retry.\n\n## Task context\n\n### Acme guidance: Don't double-charge\nfi\nelse\nCharge each key once."];
  const original = ["/agents/pi", "--session-id", "s1", "Fix the charge retry.\nIt's flaky."];
  const withFallback = isolatedAgentArgv(shaped, { fallbackArgv: original });
  assert.deepEqual(launchedArgv(withFallback), shaped);
  const plain = isolatedAgentArgv(original);
  assert.deepEqual(launchedArgv(plain), original);
  for (const argv of [withFallback, plain]) rmSync(dirname(argv[1]!), { recursive: true, force: true });
});

test("at the exact limit where an interpreter re-exec fails, the wrapper launches the original prompt", () => {
  // A Node-style entry point: it execs an interpreter deep in a version manager's tree with the
  // whole argv a second time, so that second exec also charges the interpreter's long path.
  const dir = join(root, "env-interpreter");
  const deep = join(dir, ...Array.from({ length: 32 }, (_, n) => `node-v24.19.0-segment-${n}`), "bin");
  mkdirSync(deep, { recursive: true });
  const out = join(dir, "launched");
  writeFileSync(join(deep, "mission-fake-node"), [
    "#!/bin/sh",
    `for last in "$@"; do :; done`,
    `printf '%s' "\${#last}" > ${shellCommand([out])}`,
    "",
  ].join("\n"), { mode: 0o755 });
  assert.ok(deep.length > 800, "an interpreter path well past what the `#!` line allows for");
  const agent = join(dir, "agent");
  writeFileSync(agent, `#!/bin/sh\nexec ${shellCommand([join(deep, "mission-fake-node")])} "$0" "$@"\n`, { mode: 0o755 });
  const shaped = [agent, "--session-id", "s1", "x".repeat(60_000)];
  const fallback = [agent, "--session-id", "s1", "the original prompt"];
  const argMax = Number(execFileSync("/usr/bin/getconf", ["ARG_MAX"], { encoding: "utf8" }).trim());

  // An environment of `bytes` padding on top of the daemon's own, in ordinary-sized variables.
  const paneWith = (bytes: number): Record<string, string> => {
    const pane: Record<string, string> = { ...(process.env as Record<string, string>) };
    for (let n = 0; bytes > 0; n++) {
      const value = "p".repeat(Math.min(4000, bytes));
      pane[`TERMINAL_SERVER_PAD_${n}`] = value;
      bytes -= value.length;
    }
    return pane;
  };
  // Started means the interpreter itself ran: once the outer shell is up, a refused re-exec shows
  // only as a nonzero status, and the stand-in interpreter never writes its record.
  const runs = (file: string, args: readonly string[], env: Record<string, string>) => {
    rmSync(out, { force: true });
    const ran = spawnSync(file, args, { env, stdio: "ignore" });
    return ran.error === undefined && ran.status === 0 && existsSync(out);
  };
  // The largest padding under which the shaped launch itself still starts, found by bisection so
  // the case holds on any platform's accounting.
  let fits = 0;
  let fails = argMax;
  while (fails - fits > 1) {
    const mid = Math.floor((fits + fails) / 2);
    if (runs(agent, shaped.slice(1), paneWith(mid))) fits = mid;
    else fails = mid;
  }
  const pane = paneWith(fails);
  assert.equal(runs(agent, shaped.slice(1), pane), false, "the shaped launch cannot start in this environment");
  // And it is the interpreter's re-exec that is refused there: the outer script itself starts, and
  // fails only when it hands the argv on under the interpreter's long path.
  const outer = spawnSync(agent, shaped.slice(1), { env: pane, stdio: "ignore" });
  assert.equal(outer.error, undefined, "the outer script starts at this limit");
  assert.notEqual(outer.status, 0, "and its interpreter's exec fails");
  assert.equal(runs(agent, fallback.slice(1), pane), true, "the original one can");
  rmSync(out, { force: true });

  const argv = isolatedAgentArgv(shaped, { fallbackArgv: fallback });
  execFileSync(argv[0]!, argv.slice(1), { env: pane });
  const stateHome = dirname(argv[1]!);
  const outcome = readFileSync(`${stateHome}.turn-one`, "utf8");
  rmSync(`${stateHome}.turn-one`, { force: true });
  assert.equal(outcome, "original");
  assert.equal(readFileSync(out, "utf8"), String("the original prompt".length), "and the agent started with it");
});

test("restart recovery removes a turn-one outcome whose launch is over, and keeps a live one", async () => {
  const { reconcileDisposableAgentStateHomes, createDisposableAgentStateHome } = await import("../src/server/agent-subprocess-env.ts");
  const { DISPOSABLE_STATE_ROOT } = await import("../src/server/terminal/launch-process.ts");
  // A launch whose wrapper already removed its state home, from a daemon that has since died.
  const orphan = join(DISPOSABLE_STATE_ROOT, "session-orphaned-turn-one");
  writeFileSync(`${orphan}.turn-one`, "original");
  // A launch still running: its state home exists.
  const live = createDisposableAgentStateHome();
  writeFileSync(`${live}.turn-one`, "shaped");
  // An orphan that cannot be removed - a non-empty directory - sorted ahead of the others.
  const stuck = join(DISPOSABLE_STATE_ROOT, "session-0-stuck-turn-one");
  mkdirSync(join(`${stuck}.turn-one`, "held"), { recursive: true });
  const warn = console.warn;
  const warnings: unknown[] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args[0]); };
  try {
    reconcileDisposableAgentStateHomes();
    assert.equal(existsSync(`${orphan}.turn-one`), false, "the orphaned outcome was reclaimed despite the stuck one");
    assert.equal(readFileSync(`${live}.turn-one`, "utf8"), "shaped", "a live launch's outcome is kept for its dispatch");
    assert.ok(warnings.some((w) => /could not remove the orphaned turn-one outcome session-0-stuck-turn-one/.test(String(w))), "the stuck one was logged");
  } finally {
    console.warn = warn;
    rmSync(`${stuck}.turn-one`, { recursive: true, force: true });
    rmSync(`${orphan}.turn-one`, { force: true });
    rmSync(`${live}.turn-one`, { force: true });
    rmSync(live, { recursive: true, force: true });
  }
});
