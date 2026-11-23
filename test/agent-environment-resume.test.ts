import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { managedResumeFixture, writeResumeProcessInventory } from "./helpers/managed-resume-fixture.ts";

const home = mkdtempSync(join(tmpdir(), "mission-env-resume-"));
const cwd = join(home, "checkout");
mkdirSync(cwd);
process.env.MISSION_HOME = join(home, "state");
process.env.PI_CODING_AGENT_DIR = join(home, "pi");
process.env.MISSION_CLAUDE_BIN = join(home, "terminal-agent");
process.env.SHELL = join(home, "login-shell");
delete process.env.MISSION_PI_SDK_MODULE;
const token = "MC_TEST_ROTATING_TOKEN";
const removable = "MC_TEST_REMOVABLE_TOKEN";
const unlisted = "MC_TEST_UNLISTED_TOKEN";
for (const name of [token, removable, unlisted]) delete process.env[name];

await managedResumeFixture(process.env.MISSION_HOME);
const { Registry } = await import("../src/server/registry.ts");
const { SdkSupervisor } = await import("../src/server/sdk/supervisor.ts");
const { HARNESSES } = await import("../src/server/harness/index.ts");
const { piSdkSpec } = await import("../src/server/harness/pi/sdk.ts");
const { createRuntime, defaultPiSdkDeps } = await import("../src/server/harness/pi/sdk-deps.ts");
const { prepareTerminalResume } = await import("../src/server/harness/resume.ts");
const { launchPreparedResume } = await import("../src/server/terminal/resume-launch.ts");
const { applyFeatureFlagIntent } = await import("../src/server/feature-flags/index.ts");
const { saveAgentEnvironment } = await import("../src/server/agent-environment.ts");

applyFeatureFlagIntent({ kind: "flag", id: "agent-environment", enabled: true });
saveAgentEnvironment([token, removable]);
after(() => rmSync(home, { recursive: true, force: true }));

function writeProfile(rotated: boolean): void {
  writeFileSync(process.env.SHELL!, [
    "#!/bin/sh",
    `export ${token}=${rotated ? "replacement-example" : "initial-example"}`,
    rotated ? `unset ${removable}` : `export ${removable}=available`,
    `export ${unlisted}=unlisted-example`,
    'exec /bin/sh -c "$2"',
  ].join("\n"), { mode: 0o700 });
}

// Both probes inspect an actual child environment and return only the matched fixture phase.
const probe = `
if [ "\${${unlisted}+x}" = x ]; then echo unexpected-unlisted
elif [ "$${token}" = initial-example ] && [ "$${removable}" = available ]; then echo initial
elif [ "$${token}" = replacement-example ] && [ -z "\${${removable}+x}" ]; then echo rotated
else echo unexpected-environment
fi`;

test("Pi's launched bash tool observes shell-only selection and rotation after SdkSupervisor.restore", async (t) => {
  writeProfile(false);
  // Give Pi a locally selectable model for restore. Neither session sends a prompt.
  const agentDir = process.env.PI_CODING_AGENT_DIR!;
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "offline-test-fixture" } }));
  const pi = await import("@earendil-works/pi-coding-agent");
  const sdk = await defaultPiSdkDeps.load();
  const sessions: AgentSession[] = [];
  // Observe the real vendor session so the test can call its registered tool without a model turn.
  const observedVendor: typeof pi = {
    ...pi,
    async createAgentSessionFromServices(options) {
      const created = await pi.createAgentSessionFromServices(options);
      sessions.push(created.session);
      return created;
    },
  };
  const originalDriver = HARNESSES.pi.sdk;
  t.after(() => { HARNESSES.pi.sdk = originalDriver; });
  HARNESSES.pi.sdk = piSdkSpec({
    ...defaultPiSdkDeps,
    load: async () => ({ ...sdk, createRuntime: (options) => createRuntime(observedVendor, options) }),
  });

  async function checkBash(session: AgentSession, phase: string) {
    const bash = session.agent.state.tools.find((tool) => tool.name === "bash");
    assert.ok(bash, "the launched session installed its bash tool");
    const result = await bash.execute("environment-probe", { command: probe });
    assert.equal(result.content.find((item) => item.type === "text")?.text.trim(), phase);
  }

  const first = new SdkSupervisor(new Registry());
  const registry = new Registry();
  const next = new SdkSupervisor(registry);
  try {
    const card = await first.start({ agent: "pi", name: "Environment probe", cwd, prompt: "",
      model: "openai/gpt-4o", effort: null, permissionMode: null, mcp: null, taskId: null });
    assert.deepEqual(card.missingEnvironment, []);
    assert.equal(sessions.length, 1);
    const original = sessions[0]!;
    await checkBash(original, "initial");
    // Pi defers the session-file write until a turn. Persist its real header to allow the
    // real session manager to reopen this conversation without contacting a provider.
    assert.ok(original.sessionFile);
    mkdirSync(dirname(original.sessionFile), { recursive: true });
    writeFileSync(original.sessionFile, JSON.stringify(original.sessionManager.getHeader()) + "\n");
    await first.stopAll();
    writeProfile(true);
    await next.restore();
    assert.equal(sessions.length, 2, "restore launched a replacement runtime");
    const resumed = sessions[1]!;
    assert.equal(resumed.sessionId, original.sessionId);
    await checkBash(resumed, "rotated");
    assert.deepEqual(registry.getSession(card.id)?.missingEnvironment, [removable]);
  } finally {
    await first.stopAll();
    await next.stopAll();
  }
});

test("launchPreparedResume reads the rotated shell at launch and publishes the newly missing name", async () => {
  writeProfile(false);
  writeFileSync(process.env.MISSION_CLAUDE_BIN!, "#!/bin/sh\n" + probe, { mode: 0o700 });
  const paneEnv = { ...process.env, MISSION_PS_BIN: writeResumeProcessInventory(home) };
  const source = { id: "terminal-source", agentSessionId: "native-env", agent: "claude", cwd,
    runtime: "terminal", permissionMode: null } as const;
  for (const phase of ["initial", "rotated"] as const) {
    const prepared = await prepareTerminalResume(source, { managed: true, requiredTools: [], extraDirs: [] });
    if (phase === "rotated") writeProfile(true);
    const result = await launchPreparedResume({ name: "env-resume", prepared }, async ({ argv, stateHome }) => {
      // Model the discovery event while this lease is still live. On normal exit the
      // guard removes its home and Registry can no longer attribute the launch to it.
      const registry = new Registry();
      const id = "proc:env-resume-" + phase;
      registry.applyDiscovery([{ syntheticId: id, agent: source.agent, name: source.agent, nameSource: "process",
        cwd, gitBranch: null, repoRoot: cwd, gitRoot: cwd, pid: 123, tty: "ttys123", terminals: [],
        startedAt: 1, missionLaunched: true, missionLaunchHome: stateHome }]);
      assert.deepEqual(registry.getSession(id)?.missingEnvironment, phase === "rotated" ? [removable] : []);
      const { stdout } = await promisify(execFile)(argv[0]!, argv.slice(1), { cwd, env: paneEnv, timeout: 30_000 });
      return { outcome: "launched", value: stdout.trim() };
    });
    assert.equal(result.value, phase);
  }
});

test("an unmanaged terminal resume skips the configured environment lookup and launches without its credentials", async () => {
  const source = { id: "external-terminal", agentSessionId: "external-native", agent: "claude", cwd,
    runtime: "terminal", permissionMode: null } as const;
  const marker = join(home, "unmanaged-shell-probed");
  writeFileSync(process.env.MISSION_CLAUDE_BIN!, `#!/bin/sh\ntest -z "\${${token}+x}\${${removable}+x}"\n`, { mode: 0o700 });
  const prepared = await prepareTerminalResume(source, { managed: false, requiredTools: [], extraDirs: [] });
  // The guard may discover system executables through this shell. Record only a probe for configured names.
  writeFileSync(process.env.SHELL!, [
    "#!/bin/sh", `case "$2" in *${token}*) touch "${marker}" ;; esac`,
    `export ${token}=profile-example`, 'exec /bin/sh -c "$2"',
  ].join("\n"), { mode: 0o700 });
  const result = await launchPreparedResume({ name: "external-resume", prepared }, async ({ argv }) => {
    assert.deepEqual(argv, prepared.wrappedArgv);
    await promisify(execFile)(argv[0]!, argv.slice(1), { cwd, env: { ...process.env, MISSION_PS_BIN: writeResumeProcessInventory(home) } });
    return { outcome: "launched", value: null };
  });
  assert.equal(result.outcome, "launched");
  assert.equal(existsSync(marker), false, "launch must not even probe the profile");
});
