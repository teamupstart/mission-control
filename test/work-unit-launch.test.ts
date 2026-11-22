// Work unit id, Phase 2: the launch environment, the launch record and the reuse guard.
//
// The claims are about what an AGENT carries and what Mission Control then emits for it, so
// the oracles are the environment a launch hands the agent, the session the registry
// publishes, and the record that survives. See docs/work-units.md, "The launch environment".
import { MISSION_TEST_MCP_DEPS } from "./helpers/mission-mcp-deps.ts";
import { mkTask } from "./helpers/session-fixture.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Session } from "../src/shared/types.ts";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { ClaudeSdkDeps, ClaudeSdkQuery, ClaudeSdkQueryOptions } from "../src/server/harness/claude/sdk-types.ts";
import type { SdkLaunchOptions, SdkSessionHandle } from "../src/server/harness/types.ts";

const home = mkdtempSync(join(tmpdir(), "mission-work-unit-launch-"));
process.env.HARNESS_HOME = home;

const { upsertTask, loadLaunchWorkUnits } = await import("../src/server/db.ts");
const { applyFeatureFlagIntent } = await import("../src/server/feature-flags/index.ts");
const { withWorkUnit, workUnitEnv } = await import("../src/server/agent-work-unit.ts");
const { agentSubprocessEnv, isolatedAgentArgv } = await import("../src/server/agent-subprocess-env.ts");
const { launchWorkUnitId, launchWorkUnitFor, sessionWorkUnitId } = await import("../src/server/work-unit.ts");
const shared = await import("../src/shared/work-unit.ts");
const { WORK_UNIT_ID_FLAG_ID } = await import("../src/shared/feature-flag-registry.ts");
const handOver = await import("../src/server/terminal-launch-work-units.ts");
const { claudeSdkSpec } = await import("../src/server/harness/claude/sdk.ts");
const { codexSdkSpec } = await import("../src/server/harness/codex/sdk.ts");
const { codexAppServerEnv } = await import("../src/server/harness/codex/sdk-deps.ts");
const { HARNESSES } = await import("../src/server/harness/index.ts");
const { Registry, noteKeyFor } = await import("../src/server/registry.ts");
const { SdkSupervisor } = await import("../src/server/sdk/supervisor.ts");
const { Dispatcher } = await import("../src/server/dispatcher.ts");
const { upsertSdkSession } = await import("../src/server/sdk/store.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { resumeContext } = await import("../src/server/resume-context.ts");
const { launchPreparedResume } = await import("../src/server/terminal/resume-launch.ts");
const { managedResumeRoot } = await import("../src/server/harness/resume.ts");
const { createResumeLease, revokeResumeLease } = await import("../src/server/terminal/resume-lease.ts");
const { missionLaunchAncestorHome, missionLaunchHomeOf, missionLaunchMarkers } = await import("../src/server/terminal/launch-process.ts");

after(() => rmSync(home, { recursive: true, force: true }));

const WU_A = "wu_01JD00000000000000000000AA";
const WU_B = "wu_01JD00000000000000000000BB";

function preview(enabled: boolean): void {
  const result = applyFeatureFlagIntent({ kind: "flag", id: WORK_UNIT_ID_FLAG_ID, enabled });
  assert.equal(result.ok, true);
}

// ---- the decision and the carrier ----

test("launchWorkUnitId is the task's id only while the preview is on and the id is well formed", () => {
  preview(false);
  assert.equal(launchWorkUnitId({ workUnitId: WU_A }), null, "off: no launch carries one");
  preview(true);
  assert.equal(launchWorkUnitId({ workUnitId: WU_A }), WU_A);
  assert.equal(launchWorkUnitId({ workUnitId: "wu_not-a-ulid" }), null, "a malformed id is never carried");
  assert.equal(launchWorkUnitId({ workUnitId: null }), null, "a resident run has none");
  assert.equal(launchWorkUnitId(null), null, "a session with no task has none");
  preview(false);
});

test("withWorkUnit removes an inherited value and sets only the launch's; workUnitEnv carries only a given id", () => {
  const inherited = { PATH: "/usr/bin", WORK_UNIT_ID: WU_B };
  assert.deepEqual(withWorkUnit(inherited, WU_A), { PATH: "/usr/bin", WORK_UNIT_ID: WU_A });
  assert.deepEqual(withWorkUnit(inherited, null), { PATH: "/usr/bin" });
  assert.deepEqual(withWorkUnit({ PATH: "/usr/bin" }, undefined), { PATH: "/usr/bin" });
  assert.equal(inherited.WORK_UNIT_ID, WU_B, "the input is not mutated");
  assert.deepEqual(workUnitEnv(WU_A), { WORK_UNIT_ID: WU_A });
  assert.deepEqual(workUnitEnv(null), {});
});

test("the shared predicates: reuse conflict, emitted id, and the config reference", () => {
  assert.equal(shared.launchWorkUnitConflicts(WU_A, WU_B), true);
  assert.equal(shared.launchWorkUnitConflicts(WU_A, null), true, "an older task gets a new id at assign");
  assert.equal(shared.launchWorkUnitConflicts(WU_A, WU_A), false);
  assert.equal(shared.launchWorkUnitConflicts(null, WU_B), false, "an agent started with none takes any task");
  assert.equal(shared.launchWorkUnitConflicts(undefined, null), false);
  assert.equal(shared.emittedWorkUnitId(WU_A, WU_A), WU_A);
  assert.equal(shared.emittedWorkUnitId(WU_A, WU_B), null);
  assert.equal(shared.emittedWorkUnitId(null, WU_A), null, "a task's own id is never emitted on its own");
  const session = { launchWorkUnitId: WU_A } as Pick<Session, "launchWorkUnitId">;
  assert.equal(launchWorkUnitFor(session), WU_A);
  assert.equal(sessionWorkUnitId(session, { workUnitId: WU_A }), WU_A);
  assert.equal(sessionWorkUnitId(session, { workUnitId: WU_B }), null);
  assert.equal(launchWorkUnitFor({}), null);
  for (const value of ["${WORK_UNIT_ID}", "${WORK_UNIT_ID:-}", "${WORK_UNIT_ID:-x}"]) {
    assert.equal(shared.isWorkUnitHeaderReference("X-Work-Unit-Id", value, "claude"), true, value);
  }
  for (const value of ["fixed", "", "${WORK_UNIT_ID}-suffix", "${OTHER:-}", "WORK_UNIT_ID"]) {
    assert.equal(shared.isWorkUnitHeaderReference("x-work-unit-id", value, "claude"), false, value);
  }
  assert.equal(shared.isWorkUnitHeaderReference("authorization", "${WORK_UNIT_ID:-}", "claude"), false);
  assert.equal(shared.isWorkUnitHeaderReference("x-work-unit-id", "WORK_UNIT_ID", "codex-env"), true);
  assert.equal(shared.isWorkUnitHeaderReference("x-work-unit-id", "OTHER", "codex-env"), false);
});

test("agentSubprocessEnv never passes an inherited WORK_UNIT_ID and keeps a launch's own", () => {
  const stateHome = mkdtempSync(join(home, "env-"));
  const inherited = agentSubprocessEnv({ PATH: "/usr/bin", WORK_UNIT_ID: WU_B }, { stateHome });
  assert.equal("WORK_UNIT_ID" in inherited, false, "workflow checks and one-shot calls carry none");
  const own = agentSubprocessEnv({ PATH: "/usr/bin", WORK_UNIT_ID: WU_B }, { stateHome, extraEnv: workUnitEnv(WU_A) });
  assert.equal(own.WORK_UNIT_ID, WU_A);
});

test("the terminal wrapper, run in a pane that already has WORK_UNIT_ID, gives the agent only the launch's", () => {
  const read = (extraEnv: Record<string, string>): string => {
    const out = join(mkdtempSync(join(home, "pane-")), "seen");
    const argv = isolatedAgentArgv(["/bin/sh", "-c", `printf '%s' "\${WORK_UNIT_ID-unset}" > '${out}'`], { extraEnv });
    // The pane's own environment: what a terminal server started from a worker's shell holds.
    execFileSync(argv[0]!, argv.slice(1), { env: { ...process.env, WORK_UNIT_ID: WU_B } });
    return readFileSync(out, "utf8");
  };
  // The launch home a dispatch hands over is exactly what discovery reads off this wrapper.
  const real = isolatedAgentArgv(["/usr/bin/true"]);
  assert.equal(missionLaunchHomeOf({ command: real.join(" ") }, missionLaunchMarkers()), dirname(real[1]!));
  assert.equal(read({}), "unset", "a launch that carries none: the pane's value does not survive");
  assert.equal(read(workUnitEnv(WU_A)), WU_A, "a launch that carries one: its own, not the pane's");
});

/** A Claude SDK launch is refused without Mission Control's server (`sdkAskChannel`). */
const MISSION_MCP = { serverName: "mission-control", command: "/usr/bin/node", args: ["/d/mcp.mjs"], env: {} };

function launchOpts(over: Partial<SdkLaunchOptions> = {}): SdkLaunchOptions {
  return {
    cwd: "/wt/one",
    stateHome: mkdtempSync(join(home, "agent-")),
    prompt: "",
    model: null,
    effort: null,
    permissionMode: null,
    mcp: null,
    extraDirs: [],
    standingInstructions: "",
    standingInstructionsPrompt: "",
    resume: null,
    ...over,
  };
}

test("Claude's SDK launch and Codex's app-server carry the launch's work unit and drop an inherited one", async () => {
  let options: ClaudeSdkQueryOptions | null = null;
  const deps: ClaudeSdkDeps = {
    executable: async () => "/fake/bin/claude",
    env: () => ({ PATH: "/usr/bin", WORK_UNIT_ID: WU_B }),
    query: async ({ options: given }) => {
      options = given;
      return {
        [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
        interrupt: async () => {},
      } as unknown as ClaudeSdkQuery;
    },
  };
  await claudeSdkSpec(deps).launch(launchOpts({ workUnitId: WU_A, mcp: MISSION_MCP }));
  assert.equal((options as ClaudeSdkQueryOptions | null)?.env?.WORK_UNIT_ID, WU_A);
  await claudeSdkSpec(deps).launch(launchOpts({ mcp: MISSION_MCP }));
  assert.equal("WORK_UNIT_ID" in ((options as ClaudeSdkQueryOptions | null)?.env ?? {}), false);

  const seen: unknown[] = [];
  const codex = codexSdkSpec({
    connect: async (_args, _cwd, _stateHome, opts) => {
      seen.push(opts?.workUnitId ?? null);
      throw new Error("scripted: no server");
    },
  });
  await assert.rejects(codex.launch(launchOpts({ workUnitId: WU_A })));
  await assert.rejects(codex.launch(launchOpts()));
  assert.deepEqual(seen, [WU_A, null]);
  const stateHome = mkdtempSync(join(home, "codex-"));
  assert.equal(codexAppServerEnv({ PATH: "/usr/bin", WORK_UNIT_ID: WU_B }, "/wt", stateHome, null, WU_A).WORK_UNIT_ID, WU_A);
  assert.equal("WORK_UNIT_ID" in codexAppServerEnv({ PATH: "/usr/bin", WORK_UNIT_ID: WU_B }, "/wt", stateHome, null, null), false);
});

// ---- the launch record: embedded launches ----

/** A driver that never emits and stops on request. */
function idleHandle(): SdkSessionHandle {
  let release: (() => void) | null = null;
  return {
    events: {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<never>>((resolve) => {
          release = () => resolve({ done: true, value: undefined as never });
        }),
      }),
    },
    send: async () => "started" as const,
    sendIfIdle: async () => "started" as const,
    interrupt: async () => {},
    answer: async () => {},
    setPermissionMode: null,
    setEffort: null,
    setModel: null,
    clearContext: null,
    stop: async () => {
      release?.();
    },
  } as unknown as SdkSessionHandle;
}

/** The session each session_upsert first published, by id. */
function firstPublished(registry: InstanceType<typeof Registry>): Map<string, Session> {
  const first = new Map<string, Session>();
  registry.subscribe((event) => {
    if (event.type === "session_upsert" && !first.has(event.session.id)) first.set(event.session.id, event.session);
  });
  return first;
}

function storedRecord(noteKey: string): string | null {
  return loadLaunchWorkUnits().find((row) => row.noteKey === noteKey)?.workUnitId ?? null;
}

test("an embedded launch's record is installed before its first event, and a restore decides again", async (t) => {
  const calls: SdkLaunchOptions[] = [];
  let failRestoreOf: string | null = null;
  let flipDuringLaunch = false;
  const real = HARNESSES.claude.sdk;
  HARNESSES.claude.sdk = {
    answersRequests: true,
    launch: async (opts) => {
      calls.push(opts);
      // A switch while a launch is in flight: the decision was made before this point.
      if (flipDuringLaunch) preview(false);
      if (failRestoreOf && opts.resume === failRestoreOf) throw new Error("scripted: restore failed");
      return idleHandle();
    },
  };
  t.after(() => {
    HARNESSES.claude.sdk = real;
    preview(false);
  });

  // A fresh launch: the caller's one decision reaches the driver and the first published event.
  const registry = new Registry();
  const published = firstPublished(registry);
  const supervisor = new SdkSupervisor(registry, MISSION_TEST_MCP_DEPS);
  const started = await supervisor.start({
    agent: "claude", name: "wu", cwd: "/wt/wu", prompt: "", model: null, effort: null,
    permissionMode: null, mcp: null, taskId: null, workUnitId: WU_A,
  });
  assert.equal(calls.at(-1)?.workUnitId, WU_A);
  assert.equal(published.get(started.id)?.launchWorkUnitId, WU_A, "installed before the first event");
  assert.equal(storedRecord(noteKeyFor(started)), WU_A);
  // The task is bound, then the driver reports its native id - the order a dispatch sees. The
  // emitted id is read after the rotation moved the record, so the card carries it.
  registry.upsertTask(mkTask({ id: "embedded-task", workUnitId: WU_A, status: "running", sessionId: started.id, worktreePath: "/wt/wu" }));
  registry.applyDriverEvent(started.id, { kind: "bound", agentSessionId: "embedded-conversation", transcriptPath: null, modelId: null, pid: null });
  assert.equal(storedRecord("embedded-conversation"), WU_A, "the record followed the bind");
  assert.equal(registry.getSession(started.id)?.launchWorkUnitId, WU_A);
  assert.equal(registry.getSession(started.id)?.task?.workUnitId, WU_A, "the session emits it for its task");
  await supervisor.stop(started.id).catch(() => {});

  // A restore of a task-bound session decides from the task and the preview as they are now.
  const task = mkTask({ id: "restore-task", workUnitId: WU_A, status: "running", sessionId: "sdk:wu-restore" });
  upsertTask(task);
  const restoreRow = (conversation: string) => upsertSdkSession({
    id: "sdk:wu-restore", agent: "claude", agentSessionId: conversation, cwd: "/wt/wu-restore",
    taskId: task.id, model: null, effort: null, permissionMode: null, status: "suspended", turnInProgress: false,
  });
  const restore = async () => {
    const reg = new Registry();
    const sup = new SdkSupervisor(reg, MISSION_TEST_MCP_DEPS);
    const first = firstPublished(reg);
    await sup.restore();
    await sup.stop("sdk:wu-restore").catch(() => {});
    return first.get("sdk:wu-restore") ?? null;
  };

  preview(true);
  flipDuringLaunch = true;
  restoreRow("wu-conversation");
  const on = await restore();
  flipDuringLaunch = false;
  assert.equal(calls.at(-1)?.workUnitId, WU_A, "the restored agent carries the task's id");
  assert.equal(on?.launchWorkUnitId, WU_A, "a switch after the decision changed nothing for this launch");
  assert.equal(storedRecord("wu-conversation"), WU_A);

  // Switched off, then a restore that FAILS: the record of the agent it described is untouched.
  preview(false);
  failRestoreOf = "wu-conversation";
  restoreRow("wu-conversation");
  await restore();
  assert.equal(calls.at(-1)?.workUnitId, null, "the failed attempt decided none");
  assert.equal(storedRecord("wu-conversation"), WU_A, "a launch that fails changes nothing");

  // A restore that succeeds with the preview off removes the record.
  failRestoreOf = null;
  restoreRow("wu-conversation");
  const off = await restore();
  assert.equal(calls.at(-1)?.workUnitId, null);
  assert.equal(off?.launchWorkUnitId ?? null, null);
  assert.equal(storedRecord("wu-conversation"), null);
});

test("a managed Pipeline host's agent carries its task's work unit with the preview on, and none with it off", async (t) => {
  // The real dispatch, supervisor and Claude adapter; only the SDK's query is scripted, so the
  // environment observed is the one the host's agent process would be started with - over a
  // base environment that already holds another unit's id.
  const envs: Array<Record<string, string | undefined>> = [];
  const real = HARNESSES.claude.sdk;
  HARNESSES.claude.sdk = claudeSdkSpec({
    executable: async () => "/fake/bin/claude",
    env: () => ({ PATH: "/usr/bin", WORK_UNIT_ID: WU_B }),
    query: async ({ options }) => {
      envs.push(options.env ?? {});
      // Ends when the host is stopped, so teardown does not wait on a turn that never comes.
      let end: (() => void) | null = null;
      const ended = new Promise<IteratorResult<never>>((resolve) => { end = () => resolve({ done: true, value: undefined as never }); });
      return {
        [Symbol.asyncIterator]: () => ({ next: () => ended, return: async () => { end?.(); return ended; } }),
        interrupt: async () => { end?.(); },
        close: () => { end?.(); },
      } as unknown as ClaudeSdkQuery;
    },
  });
  const registry = new Registry();
  const supervisor = new SdkSupervisor(registry, MISSION_TEST_MCP_DEPS);
  t.after(async () => {
    HARNESSES.claude.sdk = real;
    preview(false);
    for (const session of registry.snapshot().sessions) await supervisor.stop(session.id).catch(() => {});
  });
  const dispatcher = new Dispatcher(registry, async () => assert.fail("a managed Pipeline host owns no worktree"), {
    supervisor,
    missionMcpDescriptor: async () => MISSION_MCP,
    verifyMissionMcpTools: async () => ({ ok: true }),
    pipelineLaunch: async () => ({
      ok: true, launchRuntime: "agent-sdk", cwd: "/repo/pipeline",
      pipelineRun: { provider: "ai-conductor" as const, repoRoot: "/repo/pipeline", slug: "work-unit-host" },
    }),
    spawn: async () => assert.fail("the managed host opens no terminal"),
  });
  for (const [enabled, id] of [[true, "pipeline-on"], [false, "pipeline-off"]] as const) {
    preview(enabled);
    registry.upsertTask(mkTask({
      id, agent: "claude", kind: "pipeline", repoRoot: "/repo/pipeline", title: "Host a pipeline",
      intent: "Host a pipeline", workflowId: null, workUnitId: WU_A,
    }));
    await dispatcher.dispatch(id);
    const task = registry.getTask(id)!;
    assert.equal(task.status, "running", task.error ?? "");
    const env = envs.at(-1)!;
    const host = registry.getSession(task.sessionId!)!;
    if (enabled) {
      assert.equal(env.WORK_UNIT_ID, WU_A, "the host's agent carries its task's work unit");
      assert.equal(host.launchWorkUnitId, WU_A, "and its record says so");
    } else {
      assert.equal("WORK_UNIT_ID" in env, false, "off: none, and not the inherited one either");
      assert.equal(host.launchWorkUnitId ?? null, null);
    }
    registry.upsertTask({ ...task, status: "done" });
  }
  assert.equal(envs.length, 2);
});

test("a restore carries the work unit of the task that owns the session now, not the one that launched it", async (t) => {
  const calls: SdkLaunchOptions[] = [];
  const real = HARNESSES.claude.sdk;
  HARNESSES.claude.sdk = { answersRequests: true, launch: async (opts) => { calls.push(opts); return idleHandle(); } };
  t.after(() => { HARNESSES.claude.sdk = real; preview(false); });
  preview(true);
  // Launched for one task (provenance in the row), since assigned another unit's task.
  upsertTask(mkTask({ id: "launched-for", workUnitId: WU_A, status: "done", sessionId: null }));
  upsertTask(mkTask({ id: "owns-it-now", workUnitId: WU_B, status: "running", sessionId: "sdk:wu-owner" }));
  upsertSdkSession({
    id: "sdk:wu-owner", agent: "claude", agentSessionId: "owner-conversation", cwd: "/wt/wu-owner",
    taskId: "launched-for", model: null, effort: null, permissionMode: null, status: "suspended", turnInProgress: false,
  });
  const registry = new Registry();
  const supervisor = new SdkSupervisor(registry, MISSION_TEST_MCP_DEPS);
  await supervisor.restore();
  await supervisor.stop("sdk:wu-owner").catch(() => {});
  const restored = calls.find((call) => call.resume === "owner-conversation");
  assert.ok(restored, "the suspended row was relaunched");
  assert.equal(restored.workUnitId, WU_B, "the task it will run, not the task that launched it");
  assert.equal(storedRecord("owner-conversation"), WU_B);
});

test("a hibernation wake carries the woken task's work unit, and a restore finds an owner the registry dropped", async (t) => {
  const calls: SdkLaunchOptions[] = [];
  const real = HARNESSES.claude.sdk;
  HARNESSES.claude.sdk = { answersRequests: true, launch: async (opts) => { calls.push(opts); return idleHandle(); } };
  t.after(() => { HARNESSES.claude.sdk = real; preview(false); });
  preview(true);

  // Hibernating cleared the woken task's session pointer, so the wake names it.
  const checkout = mkdtempSync(join(home, "hibernated-"));
  upsertTask(mkTask({ id: "hib-launched-for", workUnitId: WU_A, status: "done", sessionId: null }));
  upsertTask(mkTask({ id: "hib-woken", workUnitId: WU_B, status: "hibernated", sessionId: null }));
  upsertSdkSession({
    id: "sdk:wu-hibernated", agent: "claude", agentSessionId: "hibernated-conversation", cwd: checkout,
    taskId: "hib-launched-for", model: null, effort: null, permissionMode: null, status: "hibernated", turnInProgress: false,
  });
  const registry = new Registry();
  const supervisor = new SdkSupervisor(registry, MISSION_TEST_MCP_DEPS);
  await supervisor.wake("sdk:wu-hibernated", "hibernated-conversation", "hib-woken");
  await supervisor.stop("sdk:wu-hibernated").catch(() => {});
  assert.equal(calls.at(-1)?.workUnitId, WU_B, "the task it is woken for, not the one that launched it");

  // A launch task the registry no longer holds is read from SQLite.
  const later = new Registry();
  upsertTask(mkTask({ id: "only-durable", workUnitId: WU_A, status: "done", sessionId: null }));
  assert.equal(later.getTask("only-durable"), undefined);
  upsertSdkSession({
    id: "sdk:wu-durable", agent: "claude", agentSessionId: "durable-conversation", cwd: "/wt/wu-durable",
    taskId: "only-durable", model: null, effort: null, permissionMode: null, status: "suspended", turnInProgress: false,
  });
  const laterSupervisor = new SdkSupervisor(later, MISSION_TEST_MCP_DEPS);
  await laterSupervisor.restore();
  await laterSupervisor.stop("sdk:wu-durable").catch(() => {});
  assert.equal(calls.find((call) => call.resume === "durable-conversation")?.workUnitId, WU_A);
});

test("a restore whose adoption fails stops the driver it started", async (t) => {
  let stopped = 0;
  const real = HARNESSES.claude.sdk;
  HARNESSES.claude.sdk = {
    answersRequests: true,
    launch: async () => {
      const handle = idleHandle();
      const stop = handle.stop.bind(handle);
      handle.stop = async () => { stopped += 1; await stop(); };
      return handle;
    },
  };
  t.after(() => { HARNESSES.claude.sdk = real; });
  upsertSdkSession({
    id: "sdk:wu-adopt-fails", agent: "claude", agentSessionId: "adopt-fails-conversation", cwd: "/wt/wu-adopt-fails",
    taskId: null, model: null, effort: null, permissionMode: null, status: "suspended", turnInProgress: false,
  });
  const registry = new Registry();
  const register = registry.registerSdkSession.bind(registry);
  registry.registerSdkSession = (input) => {
    if (input.id === "sdk:wu-adopt-fails") throw new Error("scripted: registration failed");
    return register(input);
  };
  await new SdkSupervisor(registry, MISSION_TEST_MCP_DEPS).restore();
  assert.equal(stopped, 1, "nothing else owns that driver, so a retried wake would start a second one");
});

test("a restore whose adoption fails and whose driver will not stop logs that stop", async (t) => {
  const real = HARNESSES.claude.sdk;
  HARNESSES.claude.sdk = {
    answersRequests: true,
    launch: async () => {
      const handle = idleHandle();
      handle.stop = async () => { throw new Error("scripted: stop failed"); };
      return handle;
    },
  };
  t.after(() => { HARNESSES.claude.sdk = real; });
  const logged = t.mock.method(console, "error", () => {});
  upsertSdkSession({
    id: "sdk:wu-stop-fails", agent: "claude", agentSessionId: "stop-fails-conversation", cwd: "/wt/wu-stop-fails",
    taskId: null, model: null, effort: null, permissionMode: null, status: "suspended", turnInProgress: false,
  });
  const registry = new Registry();
  const register = registry.registerSdkSession.bind(registry);
  registry.registerSdkSession = (input) => {
    if (input.id === "sdk:wu-stop-fails") throw new Error("scripted: registration failed");
    return register(input);
  };
  await new SdkSupervisor(registry, MISSION_TEST_MCP_DEPS).restore();
  const lines = logged.mock.calls.map((call) => call.arguments.map(String).join(" "));
  assert.ok(
    lines.some((line) => line.includes("could not stop the unadopted driver for sdk:wu-stop-fails") && line.includes("scripted: stop failed")),
    lines.join("\n"),
  );
});

test("an SDK registration that throws before publishing puts back the record it replaced", () => {
  const registry = new Registry();
  const register = (id: string, conversation: string, workUnitId: string | null) => registry.registerSdkSession({
    id, agent: "claude", name: id, cwd: "/wt/register-fails", agentSessionId: conversation, launchWorkUnitId: workUnitId,
  });
  // The conversation's previous process left its record.
  register("sdk:wu-before", "register-fails-conversation", WU_A);
  assert.equal(storedRecord("register-fails-conversation"), WU_A);

  const internals = registry as unknown as { workspaceFor: (...args: unknown[]) => unknown };
  const workspaceFor = internals.workspaceFor;
  internals.workspaceFor = () => { throw new Error("scripted: publishing failed"); };
  try {
    assert.throws(() => register("sdk:wu-replacing", "register-fails-conversation", WU_B), /publishing failed/);
    assert.throws(() => register("sdk:wu-fresh", "register-fails-fresh", WU_B), /publishing failed/);
  } finally {
    internals.workspaceFor = workspaceFor;
  }
  assert.equal(storedRecord("register-fails-conversation"), WU_A, "the stopped driver's value is not left behind");
  assert.equal(storedRecord("register-fails-fresh"), null);
  assert.equal(registry.getSession("sdk:wu-replacing"), undefined);
});

// ---- the launch record: terminal launches ----

let paneN = 0;
function discovered(cwd: string, over: Partial<DiscoveredSession> = {}): DiscoveredSession {
  const n = ++paneN;
  return {
    syntheticId: `proc:ttys${n}:${100 + n}:1`, agent: "claude", name: "agent", nameSource: "process",
    cwd, gitBranch: null, gitRoot: cwd, repoRoot: cwd, pid: 100 + n, tty: `ttys${n}`, terminals: [], startedAt: 0,
    ...over,
  };
}

/** Discover a pane and drive it idle, binding its native conversation id (a key rotation). */
function idleAgent(registry: InstanceType<typeof Registry>, disc: DiscoveredSession, agentSessionId: string): Session {
  registry.applyDiscovery([disc]);
  registry.applyHook({ agent: "claude", event: "Stop", sessionId: agentSessionId, cwd: disc.cwd, transcriptPath: null, env: {} });
  return registry.getSession(disc.syntheticId)!;
}

/** A launch's private state home, as the dispatcher and a managed resume each mint one. */
let homeN = 0;
/** Real directories: a decision lasts exactly as long as its launch home exists. */
const launchHome = () => mkdtempSync(join(home, `launch-${++homeN}-`));

test("a terminal launch's hand-over is installed when ITS agent is first seen, and follows every key rotation", () => {
  const registry = new Registry();
  const published = firstPublished(registry);
  const home = launchHome();
  const decision = handOver.expectTerminalLaunchWorkUnit(home, WU_A);
  const disc = discovered("/wt/terminal-a", { missionLaunched: true, missionLaunchHome: home });
  const live = idleAgent(registry, disc, "terminal-conversation-a");
  handOver.settleTerminalLaunchWorkUnit(decision, "succeeded");
  assert.equal(published.get(disc.syntheticId)?.launchWorkUnitId, WU_A, "installed before the first event");
  assert.equal(live.launchWorkUnitId, WU_A, "carried across the bind to the native key");
  assert.equal(storedRecord("terminal-conversation-a"), WU_A);
  assert.equal(storedRecord(disc.syntheticId), null, "moved, not copied");

  // Loaded at daemon start.
  const reloaded = new Registry();
  const again = idleAgent(reloaded, { ...disc }, "terminal-conversation-a");
  assert.equal(again.launchWorkUnitId, WU_A);

  // The emitted id: the record while the task has the same one.
  registry.upsertTask(mkTask({ id: "terminal-task", workUnitId: WU_A, status: "running", sessionId: live.id, repoRoot: "/wt/terminal-a" }));
  assert.equal(registry.getSession(live.id)?.task?.workUnitId, WU_A);
  // Another work unit's task on the same agent (which the reuse guard prevents through assign)
  // emits nothing: the id shown is never one the agent's environment does not carry.
  registry.upsertTask(mkTask({ id: "terminal-task", workUnitId: WU_A, status: "done", sessionId: live.id, repoRoot: "/wt/terminal-a" }));
  registry.upsertTask(mkTask({ id: "terminal-task-b", workUnitId: WU_B, status: "running", sessionId: live.id, repoRoot: "/wt/terminal-a" }));
  assert.equal(registry.getSession(live.id)?.task?.id, "terminal-task-b");
  assert.equal(registry.getSession(live.id)?.task?.workUnitId, undefined);
});

test("another pane in the same checkout cannot take a launch's hand-over", () => {
  const registry = new Registry();
  const home = launchHome();
  const decision = handOver.expectTerminalLaunchWorkUnit(home, WU_A);
  // The operator's own agent in the launch's checkout, beneath no wrapper, and a second
  // launch's agent beneath another one: neither is this launch.
  const own = idleAgent(registry, discovered("/wt/shared"), "operator-conversation");
  assert.equal(own.launchWorkUnitId ?? null, null);
  const other = idleAgent(registry, discovered("/wt/shared", { missionLaunched: true, missionLaunchHome: launchHome() }), "other-launch");
  assert.equal(other.launchWorkUnitId ?? null, null);
  // Its own agent still finds it afterwards.
  const mine = idleAgent(registry, discovered("/wt/shared", { missionLaunched: true, missionLaunchHome: home }), "this-launch");
  assert.equal(mine.launchWorkUnitId, WU_A);
  handOver.settleTerminalLaunchWorkUnit(decision, "succeeded");
});

test("a failed dispatch whose agent is still running keeps its record, so the reuse guard still refuses it", async () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  // Failed after its agent was seen, with that agent still in its kept terminal: it carries
  // WORK_UNIT_ID, so the record stays and the guard still knows it.
  const home = launchHome();
  const decision = handOver.expectTerminalLaunchWorkUnit(home, WU_A);
  const seen = idleAgent(registry, discovered("/repo", { missionLaunched: true, missionLaunchHome: home }), "failed-launch-conversation");
  handOver.settleTerminalLaunchWorkUnit(decision, "failed");
  assert.equal(storedRecord("failed-launch-conversation"), WU_A, "the agent it describes is still running");
  assert.equal(registry.getSession(seen.id)?.launchWorkUnitId, WU_A);
  registry.upsertTask(mkTask({ id: "after-failed-launch", workUnitId: WU_B }));
  assert.equal((await tasks.assign("after-failed-launch", seen.id)).error, shared.WORK_UNIT_REUSE_REFUSAL);
  // Settling again changes nothing.
  handOver.settleTerminalLaunchWorkUnit(decision, "succeeded");
  assert.equal(storedRecord("failed-launch-conversation"), WU_A);

  // Failed BEFORE its agent appeared: the decision keeps waiting, and an agent that shows up
  // late beneath that launch's wrapper still gets its record - final at once.
  const early = launchHome();
  handOver.settleTerminalLaunchWorkUnit(handOver.expectTerminalLaunchWorkUnit(early, WU_A), "failed");
  const late = idleAgent(registry, discovered("/repo", { missionLaunched: true, missionLaunchHome: early }), "late-conversation");
  assert.equal(late.launchWorkUnitId, WU_A);
  registry.upsertTask(mkTask({ id: "after-late-agent", workUnitId: WU_B }));
  assert.equal((await tasks.assign("after-late-agent", late.id)).error, shared.WORK_UNIT_REUSE_REFUSAL);

  // A launch that definitely started nothing withdraws its decision.
  const refused = launchHome();
  handOver.settleTerminalLaunchWorkUnit(handOver.expectTerminalLaunchWorkUnit(refused, WU_A), "not-started");
  assert.equal(handOver.takeTerminalLaunchWorkUnit(refused, () => {}), null);
});

test("a seen launch's record is final: a failure keeps it, and the conversation's next launch replaces it", () => {
  const registry = new Registry();
  // The conversation's previous agent was started with WU_A.
  const first = launchHome();
  handOver.settleTerminalLaunchWorkUnit(handOver.expectTerminalLaunchWorkUnit(first, WU_A), "succeeded");
  idleAgent(registry, discovered("/wt/reopen", { missionLaunched: true, missionLaunchHome: first }), "reopened-conversation");
  assert.equal(storedRecord("reopened-conversation"), WU_A);

  // A resume carrying WU_B, seen beneath its own guard: its record replaces the stopped
  // process's under the reopened key, and stays after the launch fails and its agent is gone.
  const failed = launchHome();
  const failing = handOver.expectTerminalLaunchWorkUnit(failed, WU_B, "reopened-conversation");
  const pane = discovered("/wt/reopen", { missionLaunched: true, missionLaunchHome: failed });
  registry.applyDiscovery([pane]);
  assert.equal(storedRecord("reopened-conversation"), WU_B, "installed before the rebind could find the old one");
  registry.applyDiscovery([]);
  handOver.settleTerminalLaunchWorkUnit(failing, "failed");
  assert.equal(storedRecord("reopened-conversation"), WU_B, "it describes the agent that started, now ended");

  // The next launch of the conversation replaces it. One whose terminal opened confirms before
  // its agent appears, and its record is installed when it does.
  const next = launchHome();
  handOver.settleTerminalLaunchWorkUnit(handOver.expectTerminalLaunchWorkUnit(next, null, "reopened-conversation"), "succeeded");
  registry.applyDiscovery([discovered("/wt/reopen", { missionLaunched: true, missionLaunchHome: next })]);
  assert.equal(storedRecord("reopened-conversation"), null);
});

test("an unclaimed decision waits as long as its launch home exists, with no timer, and is taken once", async (t) => {
  // A late agent: its dispatch failed long ago, other launches have come and gone since, and
  // its terminal still produces it. The decision is there to install before it is published,
  // so the guard refuses it another work unit's task.
  const realNow = Date.now;
  t.after(() => { Date.now = realNow; });
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const slow = launchHome();
  handOver.settleTerminalLaunchWorkUnit(handOver.expectTerminalLaunchWorkUnit(slow, WU_A), "failed");
  Date.now = () => realNow() + 24 * 60 * 60_000;
  handOver.expectTerminalLaunchWorkUnit(launchHome(), WU_B);
  const published = firstPublished(registry);
  const late = idleAgent(registry, discovered("/repo", { missionLaunched: true, missionLaunchHome: slow }), "a-day-late-conversation");
  assert.equal(published.get(late.id)?.launchWorkUnitId, WU_A, "installed before its first event, however late");
  registry.upsertTask(mkTask({ id: "for-the-late-agent", workUnitId: WU_B }));
  assert.equal((await tasks.assign("for-the-late-agent", late.id)).error, shared.WORK_UNIT_REUSE_REFUSAL);
  Date.now = realNow;

  // Taken once; a pane beneath no launch takes nothing.
  const install = (): void => {};
  assert.equal(handOver.takeTerminalLaunchWorkUnit(slow, install), null);
  assert.equal(handOver.takeTerminalLaunchWorkUnit(null, install), null);
  // A launch whose home is gone is over - its wrapper, and any agent beneath it, has exited -
  // so its decision is forgotten at the next sweep, with no further launch needed.
  const ended = launchHome();
  handOver.expectTerminalLaunchWorkUnit(ended, WU_A);
  rmSync(ended, { recursive: true, force: true });
  assert.equal(handOver.takeTerminalLaunchWorkUnit(ended, install), null);

  // A verdict sweeps too, and so does a sighting of a pane beneath no launch: once their homes
  // are gone, nothing waits, while a launch whose home still exists keeps its decision.
  handOver.resetTerminalLaunchWorkUnits();
  const live = launchHome();
  const finished = launchHome();
  const failed = handOver.expectTerminalLaunchWorkUnit(finished, WU_A);
  handOver.expectTerminalLaunchWorkUnit(live, WU_B);
  rmSync(finished, { recursive: true, force: true });
  handOver.settleTerminalLaunchWorkUnit(failed, "failed");
  assert.equal(handOver.terminalLaunchWorkUnitsWaiting(), 1);
  const abandoned = launchHome();
  handOver.expectTerminalLaunchWorkUnit(abandoned, WU_A);
  rmSync(abandoned, { recursive: true, force: true });
  assert.equal(handOver.takeTerminalLaunchWorkUnit(null, install), null);
  assert.equal(handOver.terminalLaunchWorkUnitsWaiting(), 1);
  // An install that throws leaves the decision waiting for the next sighting.
  const retried = launchHome();
  handOver.expectTerminalLaunchWorkUnit(retried, WU_A);
  assert.throws(() => handOver.takeTerminalLaunchWorkUnit(retried, () => { throw new Error("scripted: write failed"); }));
  assert.equal(handOver.takeTerminalLaunchWorkUnit(retried, install)?.workUnitId, WU_A);
  assert.equal(handOver.takeTerminalLaunchWorkUnit(live, install)?.workUnitId, WU_B);
});

test("a /clear no daemon saw still carries the launch record to the conversation the process is in now", () => {
  const home = launchHome();
  handOver.expectTerminalLaunchWorkUnit(home, WU_A);
  const pane = discovered("/repo", { missionLaunched: true, missionLaunchHome: home });
  const before = new Registry();
  idleAgent(before, pane, "before-restart-conversation");
  assert.equal(storedRecord("before-restart-conversation"), WU_A);

  // The daemon restarts; while it was down the agent ran /clear, so its first sight names the
  // new conversation and only the stored binding knows the old one.
  const after = new Registry();
  after.applyDiscovery([{ ...pane, agentSessionId: "after-clear-conversation" }]);
  const session = after.getSession(pane.syntheticId)!;
  assert.equal(session.launchWorkUnitId, WU_A);
  assert.equal(storedRecord("after-clear-conversation"), WU_A);
  assert.equal(storedRecord("before-restart-conversation"), null);

  // Not when another live session holds the old conversation: it was reopened there, and the
  // record under it is that agent's.
  const heldHome = launchHome();
  handOver.expectTerminalLaunchWorkUnit(heldHome, WU_B);
  const original = discovered("/repo", { missionLaunched: true, missionLaunchHome: heldHome });
  idleAgent(new Registry(), original, "held-conversation");
  assert.equal(storedRecord("held-conversation"), WU_B);
  const restarted = new Registry();
  const reopened = discovered("/repo", { agentSessionId: "held-conversation" });
  restarted.applyDiscovery([reopened]);
  restarted.applyDiscovery([reopened, { ...original, agentSessionId: "original-after-clear" }]);
  assert.equal(storedRecord("held-conversation"), WU_B);
  assert.equal(storedRecord("original-after-clear"), null);

  // Nor when the session holding it comes later in the same sweep: after a restart both are
  // first sights, and the moving process may be merged first.
  const sweepHome = launchHome();
  handOver.expectTerminalLaunchWorkUnit(sweepHome, WU_B);
  const mover = discovered("/repo", { missionLaunched: true, missionLaunchHome: sweepHome });
  idleAgent(new Registry(), mover, "held-in-sweep");
  const holder = discovered("/repo", { agentSessionId: "held-in-sweep" });
  const oneSweep = new Registry();
  const published = firstPublished(oneSweep);
  oneSweep.applyDiscovery([{ ...mover, agentSessionId: "mover-after-clear" }, holder]);
  assert.equal(storedRecord("held-in-sweep"), WU_B);
  assert.equal(storedRecord("mover-after-clear"), null);
  assert.equal(published.get(holder.syntheticId)?.launchWorkUnitId, WU_B, "the holder publishes with its record");
});

test("discovery names the exact launch an agent runs beneath", () => {
  const markers = { disposableRoot: "/tmp/mission-control-agent-state", resumeGuard: "/app/resume-guard.mjs", resumeLeaseRoot: "/state/resume" };
  const procs = [
    { pid: 10, ppid: 1, startMs: 1, command: "/bin/sh /tmp/mission-control-agent-state/session-abc/launch-and-cleanup.sh" },
    { pid: 11, ppid: 10, startMs: 2, command: "claude" },
    { pid: 20, ppid: 1, startMs: 3, command: "/usr/bin/node /app/resume-guard.mjs /state/resume 0f0e0d0c-0b0a-4908-8706-050403020100" },
    { pid: 21, ppid: 20, startMs: 4, command: "claude --resume x" },
    { pid: 30, ppid: 1, startMs: 5, command: "claude" },
  ] as never;
  assert.equal(missionLaunchAncestorHome(11, procs, markers), "/tmp/mission-control-agent-state/session-abc");
  assert.equal(missionLaunchAncestorHome(21, procs, markers), join("/state/resume", "homes", "0f0e0d0c-0b0a-4908-8706-050403020100"), "a managed resume, beneath its guard");
  assert.equal(missionLaunchAncestorHome(30, procs, markers), null, "an agent started outside Mission Control");
});

test("a managed resume decides once in resumeContext and hands its decision over only for a launch that happened", async () => {
  preview(true);
  const source = { id: "proc:resume", agent: "claude", agentSessionId: "resume-conversation", cwd: "/wt/resume",
    permissionMode: null, runtime: "terminal" } as const;
  assert.equal(resumeContext(source, mkTask({ workUnitId: WU_A }), false, false).workUnitId, WU_A);
  assert.equal(resumeContext(source, null, false, false).workUnitId, null);
  preview(false);
  assert.equal(resumeContext(source, mkTask({ workUnitId: WU_A }), false, false).workUnitId, null);

  handOver.resetTerminalLaunchWorkUnits();
  const prepared = (cwd: string) => {
    const lease = createResumeLease(managedResumeRoot(), `claude:${cwd}`, new Set(), source.id);
    return {
      cwd, argv: [], wrappedArgv: ["/bin/true"], stateHome: lease.home, lease, descriptor: null, requiredTools: [],
      instrumented: false, workUnitId: WU_A, conversationKey: "resume-conversation",
      beginLaunch: () => {}, dispose: () => revokeResumeLease(lease),
    };
  };
  const install = (): void => {};
  const refused = prepared("/wt/resume-refused");
  await launchPreparedResume({ name: "r", prepared: refused }, async () => ({ outcome: "refused", value: null }));
  assert.equal(handOver.takeTerminalLaunchWorkUnit(refused.stateHome, install), null, "a refused launch withdraws it");
  const opened = prepared("/wt/resume-ok");
  await launchPreparedResume({ name: "r", prepared: opened }, async () => ({ outcome: "launched", value: null }));
  // Keyed by the lease's own home - the one its guard runs from - not by the checkout.
  assert.equal(handOver.takeTerminalLaunchWorkUnit("/wt/resume-ok", install), null);
  const taken = handOver.takeTerminalLaunchWorkUnit(opened.stateHome, install);
  assert.deepEqual([taken?.workUnitId, taken?.conversationKey], [WU_A, "resume-conversation"]);
});

// ---- the reuse guard (decision D7) ----

test("assign refuses an agent started for another work unit, with the preview on or off", async () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const home = launchHome();
  const decision = handOver.expectTerminalLaunchWorkUnit(home, WU_A);
  const agent = idleAgent(registry, discovered("/repo", { missionLaunched: true, missionLaunchHome: home }), "guarded-conversation");
  handOver.settleTerminalLaunchWorkUnit(decision, "succeeded");
  assert.equal(agent.launchWorkUnitId, WU_A);
  for (const enabled of [true, false]) {
    preview(enabled);
    registry.upsertTask(mkTask({ id: `other-${enabled}`, workUnitId: WU_B }));
    const refused = await tasks.assign(`other-${enabled}`, agent.id);
    assert.equal(refused.ok, false);
    assert.equal(refused.error, shared.WORK_UNIT_REUSE_REFUSAL);
    assert.equal(refused.scope, "session");
    assert.equal(registry.getTask(`other-${enabled}`)?.status, "backlog");
  }
  // While the agent still runs its own task, the work unit is the reason given, not "busy":
  // busy passes, and waiting for it would only meet this refusal.
  registry.upsertTask(mkTask({ id: "own-running", workUnitId: WU_A, status: "running", sessionId: agent.id }));
  registry.upsertTask(mkTask({ id: "other-while-busy", workUnitId: WU_B }));
  assert.equal((await tasks.assign("other-while-busy", agent.id)).error, shared.WORK_UNIT_REUSE_REFUSAL);
  assert.match(String((await tasks.assign("same-unit-while-busy", agent.id)).error), /no such task/);
  registry.upsertTask(mkTask({ id: "same-unit-while-busy", workUnitId: WU_A }));
  assert.match(String((await tasks.assign("same-unit-while-busy", agent.id)).error), /already running/);
  registry.upsertTask(mkTask({ id: "own-running", workUnitId: WU_A, status: "done", sessionId: agent.id }));
  preview(false);
  // Its own work unit, and an agent started with none, pass the guard (and may be refused
  // later for reasons of their own, which is not this rule).
  registry.upsertTask(mkTask({ id: "same-unit", workUnitId: WU_A }));
  assert.notEqual((await tasks.assign("same-unit", agent.id)).error, shared.WORK_UNIT_REUSE_REFUSAL);
  const unrecorded = idleAgent(registry, discovered("/repo"), "unrecorded-conversation");
  assert.equal(unrecorded.launchWorkUnitId ?? null, null);
  registry.upsertTask(mkTask({ id: "any-unit", workUnitId: WU_B }));
  assert.notEqual((await tasks.assign("any-unit", unrecorded.id)).error, shared.WORK_UNIT_REUSE_REFUSAL);
});
