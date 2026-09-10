import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
  assert.equal(PORT, 7317);
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
  };
  const cwd = join(root, "checkout");
  const first = agentSubprocessEnv(inherited, { loopbackAccess: true, cwd });
  const second = agentSubprocessEnv(inherited, { loopbackAccess: true });

  assert.equal(first.ORDINARY_TOOL_SETTING, "kept");
  assert.equal(first.FLEET_HOME, undefined);
  assert.equal(first.HARNESS_HOME, undefined);
  assert.notEqual(first.MISSION_HOME, operatorState);
  assert.notEqual(first.MISSION_HOME, second.MISSION_HOME, "each launch receives its own home");
  assert.ok(existsSync(first.MISSION_HOME!));
  assert.equal(first.MISSION_PORT, "7317");
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
