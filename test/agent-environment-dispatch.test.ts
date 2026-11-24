import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, watch, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { after, test, type TestContext } from "node:test";
import { build } from "esbuild";
import { originAndCloneAt } from "./helpers/git-fixture.ts";
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

async function checkTerminalDispatch(t: TestContext, scenario: "ship" | "resident" | "cleared" | "unconfirmed" | "never-started" | "settled" | "cancel-probe" | "exited" | "exited-dirty") {
  const timesOut = scenario === "unconfirmed" || scenario === "never-started" || scenario === "settled" || scenario === "exited" || scenario === "exited-dirty";
  const kind = scenario === "resident" ? "resident" : "ship";
  process.env.MISSION_HOME = join(dir, "state");
  process.env.SHELL = join(dir, "login-shell");
  process.env.MISSION_PI_BIN = join(dir, "pi");
  process.env.MISSION_RESUME_GUARD = join(dir, "guard.mjs");
  const lookupMarker = join(dir, `${scenario}-named-lookup`);
  process.env.MC_DISPATCH_LOOKUP_MARKER = lookupMarker;
  for (const key of ["MC_DISPATCH_LISTED", "MC_DISPATCH_UNLISTED", "MC_DISPATCH_MISSING"]) delete process.env[key];
  writeFileSync(process.env.SHELL, `#!/bin/sh
case "$2" in *MC_DISPATCH_LISTED*)
  : > "$MC_DISPATCH_LOOKUP_MARKER"
  ${scenario === "cancel-probe" ? 'while [ ! -f "$MC_DISPATCH_LOOKUP_MARKER.release" ]; do sleep 0.02; done' : ""}
;; esac
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
  const { launchAgentEnvironment, saveAgentEnvironment } = await import("../src/server/agent-environment.ts");
  applyFeatureFlagIntent({ kind: "flag", id: "agent-environment", enabled: true });
  saveAgentEnvironment(["MC_DISPATCH_LISTED", "MC_DISPATCH_MISSING"]);
  if (scenario === "cleared") {
    saveAgentEnvironment([]);
    assert.equal(await launchAgentEnvironment(), undefined);
  }

  const registry = new Registry();
  const { clone: repo } = originAndCloneAt(join(dir, scenario));
  const task = mkTask({ id: `fresh-terminal-${scenario}`, kind, status: "dispatching", agent: "pi", repoRoot: repo });
  const discoveredId = `proc:${task.id}`;
  registry.upsertTask(task);
  if (scenario === "cancel-probe") {
    const watcher = watch(dir, () => {
      if (!existsSync(lookupMarker)) return;
      watcher.close();
      registry.upsertTask({ ...registry.getTask(task.id)!, status: "cancelled" });
      writeFileSync(lookupMarker + ".release", "");
    });
    t.after(() => watcher.close());
  }

  let observedEnvironment: Record<string, boolean> | undefined;
  let spawnCount = 0;
  let delayed: { argv: readonly string[]; cwd: string } | undefined;
  const mux = fakeMultiplexer({ sessions: {
    names: PLAIN_NAMES, attachArgv: null, rename: async () => OK, kill: null, alive: null, closeIfOnlyPane: null,
    async spawnDetached({ argv, cwd, name }) {
      spawnCount++;
      if (timesOut) {
        delayed = { argv, cwd };
        return { ok: false, outcomeUnknown: true, error: "terminal reply timed out" };
      }
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
  const { RESUME_START_MS } = await import("../src/server/terminal/resume-lease.ts");
  const retained = new Promise<void>((resolve) => {
    t.after(registry.subscribe(() => {
      if (registry.getTask(task.id)?.launchFailure?.sessionKept) resolve();
    }));
  });
  if (timesOut) t.mock.timers.enable({ apis: ["setTimeout"] });
  const dispatch = new Dispatcher(registry, undefined, {
    resolveRuntime: () => "terminal", resolveTerminalBackend: () => "tmux",
    residentLaunch: (_task, instructions) => instructions,
    homeDeps: fakeTerminals(mux, fakeEmulator()), piExtensionInstalled: () => true,
    verifyMissionMcpTools: async () => ({ ok: true }), sleep: async () => {},
  }).dispatch(task.id);

  if (timesOut) await Promise.race([retained, dispatch]);
  else await dispatch;
  const launched = registry.getTask(task.id)!;
  if (scenario === "cancel-probe") {
    assert.equal(launched.status, "cancelled");
    assert.equal(spawnCount, 0);
    assert.equal(launched.worktreeLeaseId, null);
    return;
  }
  if (timesOut) {
    assert.equal(launched.status, "failed");
    assert.equal(launched.launchFailure?.sessionKept, true);
    assert.ok(delayed && existsSync(delayed.cwd), "an unconfirmed pane retains its checkout");
    if (scenario === "settled") {
      registry.upsertTask({ ...launched, status: "done" });
      t.mock.timers.tick(RESUME_START_MS);
      await dispatch;
      assert.equal(registry.getTask(task.id)?.status, "done");
      assert.equal(registry.getTask(task.id)?.worktreeLeaseId, launched.worktreeLeaseId);
      assert.ok(existsSync(delayed.cwd));
      return;
    }
    if (scenario === "never-started") {
      t.mock.timers.tick(RESUME_START_MS);
      await dispatch;
      const expired = registry.getTask(task.id)!;
      assert.equal(expired.status, "failed");
      assert.equal(expired.launchFailure?.sessionKept, false);
      assert.equal(expired.worktreePath, null, expired.error ?? undefined);
      assert.equal(expired.worktreeLeaseId, null);
      return;
    }
    const child = spawn(delayed.argv[0]!, delayed.argv.slice(1), { cwd: delayed.cwd, env: { PATH: process.env.PATH }, timeout: 30_000 });
    const exited = once(child, "close");
    const lines = createInterface({ input: child.stdout });
    try {
      const report = await lines[Symbol.asyncIterator]().next();
      assert.ok(!report.done, "the late pane ran the original wrapper");
      const observed = JSON.parse(report.value);
      assert.equal(observed.listedMatches, true);
      assert.ok(existsSync(observed.home));
      if (scenario === "exited" || scenario === "exited-dirty") {
        const work = join(delayed.cwd, "agent-work.txt");
        if (scenario === "exited-dirty") writeFileSync(work, "saved work");
        child.stdin.end();
        assert.deepEqual(await exited, [0, null]);
        assert.equal(existsSync(observed.home), false);
        t.mock.timers.tick(RESUME_START_MS);
        await dispatch;
        const failed = registry.getTask(task.id)!;
        assert.equal(failed.status, "failed");
        if (scenario === "exited-dirty") {
          assert.equal(failed.worktreeLeaseId, launched.worktreeLeaseId);
          assert.ok(existsSync(work));
        } else {
          assert.equal(failed.launchFailure?.sessionKept, false, failed.error ?? undefined);
          assert.equal(failed.worktreeLeaseId, null);
        }
        return;
      }
      t.mock.timers.tick(RESUME_START_MS);
      await dispatch;
      assert.equal(registry.getTask(task.id)?.launchFailure?.sessionKept, true);
      assert.ok(existsSync(delayed.cwd));
      child.stdin.end();
      assert.deepEqual(await exited, [0, null]);
      assert.equal(existsSync(observed.home), false);
    } finally {
      lines.close();
      child.stdin.end();
    }
    return;
  }
  assert.equal(launched.status, "running", launched.error ?? "fresh dispatch reached running");
  assert.equal(launched.sessionId, discoveredId);
  const passesNames = scenario === "ship";
  assert.deepEqual(observedEnvironment, { listedPresent: passesNames, listedMatches: passesNames, unlistedPresent: false, missingPresent: false });
  assert.equal(existsSync(lookupMarker), passesNames, "only a managed launch with configured names should probe them");
  const session = registry.getSession(discoveredId);
  assert.ok(session, "the registry retained the dispatched agent");
  assert.deepEqual(session.missingEnvironment, passesNames ? ["MC_DISPATCH_MISSING"] : undefined);
}

test("fresh terminal dispatch delivers the listed shell-only value, excludes the unlisted export and warns on the missing name",
  (t) => checkTerminalDispatch(t, "ship"));
test("fresh resident terminal dispatch skips named shell lookups, variable injection and missing-name warnings",
  (t) => checkTerminalDispatch(t, "resident"));
test("clearing the enabled list gives the next dispatched agent no named environment or missing-name warning",
  (t) => checkTerminalDispatch(t, "cleared"));

test("a pane confirmed only after the backend timeout can still enter its checkout and run its named dispatch wrapper",
  (t) => checkTerminalDispatch(t, "unconfirmed"));

test("a backend timeout releases the failed task's checkout when its wrapper never starts",
  (t) => checkTerminalDispatch(t, "never-started"));

test("a timed-out wrapper that exits before the deadline releases its clean checkout",
  (t) => checkTerminalDispatch(t, "exited"));
test("a timed-out wrapper that exits before the deadline retains unpublished work",
  (t) => checkTerminalDispatch(t, "exited-dirty"));

test("expiry preserves the checkout of a task marked done during the startup window",
  (t) => checkTerminalDispatch(t, "settled"));

test("cancelling during the login shell probe never sends a command to the terminal backend",
  (t) => checkTerminalDispatch(t, "cancel-probe"));

test("dispatch state-home cleanup follows wrapper startup across the handoff deadline", async (t) => {
  const { spawnUniquely } = await import("../src/server/dispatcher.ts");
  const { RESUME_START_MS } = await import("../src/server/terminal/resume-lease.ts");
  const { createDisposableAgentStateHome, cleanupDisposableAgentStateHome } = await import("../src/server/agent-subprocess-env.ts");
  process.env.MISSION_RESUME_GUARD = join(dir, "expiry-guard.mjs");
  await build({ entryPoints: ["src/server/terminal/resume-guard.ts"], outfile: process.env.MISSION_RESUME_GUARD,
    bundle: true, platform: "node", format: "esm" });

  async function accepted(t: TestContext, bin: string, args: string[]) {
    const stateHome = createDisposableAgentStateHome();
    t.after(() => cleanupDisposableAgentStateHome(stateHome));
    let command: readonly string[] = [];
    const mux = fakeMultiplexer({ sessions: {
      names: PLAIN_NAMES, attachArgv: null, rename: async () => OK, kill: null, alive: null, closeIfOnlyPane: null,
      async spawnDetached({ argv, name }) { command = argv; return { ...OK, session: name }; },
    } });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    await spawnUniquely("delayed", "1", dir, bin, args, stateHome, "tmux", {}, null,
      { extraEnv: { LISTED: "fixture" }, missing: [] }, fakeTerminals(mux, fakeEmulator()));
    assert.ok(existsSync(stateHome));
    return { command, stateHome };
  }

  await t.test("an unopened socket expires before a delayed pane can start", async (t) => {
    const marker = join(dir, "late-dispatch-started");
    const { command, stateHome } = await accepted(t, "/usr/bin/touch", [marker]);
    t.mock.timers.tick(RESUME_START_MS);
    assert.equal(existsSync(stateHome), false);
    await assert.rejects(promisify(execFile)(command[0]!, command.slice(1)), { code: 1, stderr: /handoff.*expired/ });
    assert.equal(existsSync(marker), false);
  });

  await t.test("a reader that consumes the socket but never starts its wrapper still expires", async (t) => {
    const { command, stateHome } = await accepted(t, "/bin/true", []);
    const socket = createConnection(command[command.indexOf("--with-agent-environment") + 1]!);
    const ticket = command.find((arg) => arg.startsWith("MISSION_TERMINAL_HANDOFF_TICKET="))!;
    socket.write(Buffer.from(ticket.split("=")[1]!, "hex"));
    socket.resume();
    await once(socket, "close");
    assert.ok(existsSync(stateHome));
    t.mock.timers.tick(RESUME_START_MS);
    assert.equal(existsSync(stateHome), false);
  });

  await t.test("a running wrapper owns its home beyond the deadline and cleans it on exit", async (t) => {
    const { command, stateHome } = await accepted(t, "/bin/sh", ["-c", "echo ready; read -r line"]);
    const child = spawn(command[0]!, command.slice(1));
    const exited = once(child, "close");
    const lines = createInterface({ input: child.stdout });
    try {
      assert.equal((await lines[Symbol.asyncIterator]().next()).value, "ready");
      t.mock.timers.tick(RESUME_START_MS);
      assert.ok(existsSync(stateHome));
    } finally {
      lines.close();
      child.stdin.end("done\n");
      await exited;
    }
    assert.equal(existsSync(stateHome), false);
  });
});
