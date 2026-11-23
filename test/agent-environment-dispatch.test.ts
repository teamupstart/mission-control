import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { after, test, type TestContext } from "node:test";
import { build } from "esbuild";
import { seedGitRepo } from "./helpers/git-fixture.ts";
import { mkMuxHandle, mkTask } from "./helpers/session-fixture.ts";
import { fakeEmulator, fakeMultiplexer, fakeTerminals, OK } from "./helpers/terminal-fakes.ts";
import { PLAIN_NAMES } from "../src/server/terminal/names.ts";

const dir = mkdtempSync(join(tmpdir(), "mission-dispatch-environment-"));
after(() => rmSync(dir, { recursive: true, force: true }));

// Residents normally force the SDK. Override only the dispatcher's runtime selection so a
// regression in the terminal branch cannot be hidden by that independent policy.
const dispatcherUrl = new URL("../src/server/dispatcher.ts", import.meta.url).href;
const fixtureUrl = new URL("./fixtures/resident-terminal-task.ts", import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === dispatcherUrl && specifier === "@shared/task.ts") {
      return { url: fixtureUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
after(() => hooks.deregister());

async function checkTerminalDispatch(t: TestContext, kind: "ship" | "resident") {
  const resident = kind === "resident";
  process.env.MISSION_HOME = join(dir, "state");
  process.env.SHELL = join(dir, "login-shell");
  process.env.MISSION_PI_BIN = join(dir, "pi");
  process.env.MISSION_RESUME_GUARD = join(dir, "guard.mjs");
  const lookupMarker = join(dir, `${kind}-named-lookup`);
  process.env.MC_DISPATCH_LOOKUP_MARKER = lookupMarker;
  for (const key of ["MC_DISPATCH_LISTED", "MC_DISPATCH_UNLISTED", "MC_DISPATCH_MISSING"]) delete process.env[key];
  writeFileSync(process.env.SHELL, `#!/bin/sh
case "$2" in *MC_DISPATCH_LISTED*) : > "$MC_DISPATCH_LOOKUP_MARKER" ;; esac
export MC_DISPATCH_LISTED=profile-example MC_DISPATCH_UNLISTED=unlisted-example
exec /bin/sh -c "$2"
`, { mode: 0o700 });
  writeFileSync(process.env.MISSION_PI_BIN, `#!/usr/bin/env node
console.log(JSON.stringify({
  pid: process.pid, home: process.env.MISSION_HOME, sessionId: process.argv[process.argv.indexOf("--session-id") + 1],
  listedPresent: Object.hasOwn(process.env, "MC_DISPATCH_LISTED"),
  listedMatches: process.env.MC_DISPATCH_LISTED === "profile-example",
  unlistedPresent: Object.hasOwn(process.env, "MC_DISPATCH_UNLISTED"),
  missingPresent: Object.hasOwn(process.env, "MC_DISPATCH_MISSING")
}));
process.stdin.resume();
`, { mode: 0o700 });
  await build({ entryPoints: ["src/server/terminal/resume-guard.ts"], outfile: process.env.MISSION_RESUME_GUARD,
    bundle: true, platform: "node", format: "esm", target: "node24" });

  const { Registry } = await import("../src/server/registry.ts");
  const { Dispatcher } = await import("../src/server/dispatcher.ts");
  const { applyFeatureFlagIntent } = await import("../src/server/feature-flags/index.ts");
  const { saveAgentEnvironment } = await import("../src/server/agent-environment.ts");
  applyFeatureFlagIntent({ kind: "flag", id: "agent-environment", enabled: true });
  saveAgentEnvironment(["MC_DISPATCH_LISTED", "MC_DISPATCH_MISSING"]);

  const registry = new Registry();
  const repo = join(dir, kind);
  seedGitRepo(repo, { branch: "main" });
  const task = mkTask({ id: `fresh-terminal-${kind}`, kind, status: "dispatching", agent: "pi", repoRoot: repo });
  const discoveredId = `proc:${task.id}`;
  registry.upsertTask(task);

  let observedEnvironment: Record<string, boolean> | undefined;
  const mux = fakeMultiplexer({ sessions: {
    names: PLAIN_NAMES, attachArgv: null, rename: async () => OK, kill: null, alive: null, closeIfOnlyPane: null,
    async spawnDetached({ argv, cwd, name }) {
      // Execute exactly what the launcher gives the pane. The probe stays alive until
      // dispatch binds the task so discovery can claim this wrapper's missing-name warning.
      const child = spawn(argv[0]!, argv.slice(1), { cwd, env: { PATH: process.env.PATH }, timeout: 30_000 });
      const exited = once(child, "close");
      t.after(async () => {
        child.stdin.end();
        const [code] = await exited;
        assert.equal(code, 0, "the terminal wrapper and its agent exited cleanly");
      });
      const lines = createInterface({ input: child.stdout });
      const report = await lines[Symbol.asyncIterator]().next();
      lines.close();
      assert.ok(!report.done, "the dispatched agent reported its own environment");
      const { pid, home, sessionId, ...observed } = JSON.parse(report.value);
      observedEnvironment = observed;
      registry.applyDiscovery([{ syntheticId: discoveredId, agent: "pi", name, nameSource: "process",
        cwd, repoRoot: repo, gitRoot: cwd, gitBranch: null, pid, tty: "ttys123", startedAt: 1,
        terminals: [mkMuxHandle({ session: name })], missionLaunched: true, missionLaunchHome: home }]);
      registry.applyHook({ agent: "pi", event: "SessionStart", sessionId, cwd, transcriptPath: null, env: { tmuxPane: "%1" } });
      return { ...OK, session: name };
    },
  } });
  await new Dispatcher(registry, undefined, {
    resolveRuntime: () => "terminal", resolveTerminalBackend: () => "tmux",
    residentLaunch: (_task, instructions) => instructions,
    homeDeps: fakeTerminals(mux, fakeEmulator()), piExtensionInstalled: () => true,
    verifyMissionMcpTools: async () => ({ ok: true }), sleep: async () => {},
  }).dispatch(task.id);

  const launched = registry.getTask(task.id)!;
  assert.equal(launched.status, "running", launched.error ?? "fresh dispatch reached running");
  assert.equal(launched.sessionId, discoveredId);
  assert.deepEqual(observedEnvironment, { listedPresent: !resident, listedMatches: !resident, unlistedPresent: false, missingPresent: false });
  assert.equal(existsSync(lookupMarker), !resident, "only an ordinary launch should read the configured shell variable");
  const session = registry.getSession(discoveredId);
  assert.ok(session, "the registry retained the dispatched agent");
  assert.deepEqual(session.missingEnvironment, resident ? undefined : ["MC_DISPATCH_MISSING"]);
}

test("fresh terminal dispatch delivers the listed shell-only value, excludes the unlisted export and warns on the missing name",
  (t) => checkTerminalDispatch(t, "ship"));
test("fresh resident terminal dispatch skips named shell lookups, variable injection and missing-name warnings",
  (t) => checkTerminalDispatch(t, "resident"));
