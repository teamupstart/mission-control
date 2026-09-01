import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ENGINEER_STEP_NAMES,
  PIPELINE_CALLER_CREDENTIAL_ENV,
  PIPELINE_HALT_CLASSES,
  type PipelineActionResult,
  type PipelineCommission,
  type PipelineRun,
} from "../src/shared/pipeline.ts";
import {
  conductorEngineerArgv,
} from "../src/server/pipelines/conductor/index.ts";
import {
  pipelineAutomationAction,
  runPipelineTriage,
  type PipelineTriageActions,
} from "../src/server/foreman/pipeline-triage.ts";
import type { RecordEpisode } from "../src/shared/protocol.ts";
import { Registry } from "../src/server/registry.ts";
import { Dispatcher } from "../src/server/dispatcher.ts";
import { TaskManager } from "../src/server/tasks.ts";
import { pipelineCommissionLine } from "../src/web/pipelines/pipeline-run-model.ts";
import {
  getTask as getDurableTask,
  upsertPipelineCommissionAttempt,
} from "../src/server/db.ts";
import { setPipelinesConfig } from "../src/server/pipelines/config.ts";
import {
  bindPipelineCommissionAttempt,
  createPipelineCommission,
} from "../src/server/pipelines/commissions.ts";
import { PIPELINE_PROVIDERS } from "../src/server/pipelines/providers.ts";
import type { PipelineEngineerRunSnapshot } from "../src/server/pipelines/types.ts";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import { mkMuxHandle, mkTask } from "./helpers/session-fixture.ts";

type SdkSupervisor = import("../src/server/sdk/supervisor.ts").SdkSupervisor;
type Session = import("../src/shared/types.ts").Session;

/** Records the fixed SDK launch facts while registering a real dashboard session. */
function fakeSupervisor(registry: Registry) {
  const starts: Parameters<SdkSupervisor["start"]>[0][] = [];
  const stopped: string[] = [];
  const supervisor = {
    starts,
    stopped,
    async start(input: Parameters<SdkSupervisor["start"]>[0]): Promise<Session> {
      starts.push(input);
      return registry.registerSdkSession({
        id: input.sessionId ?? `sdk:pipeline-${starts.length}`,
        agent: input.agent,
        name: input.name,
        cwd: input.cwd,
        agentSessionId: `claude-pipeline-${starts.length}`,
        gitBranch: input.gitBranch,
        gitRoot: input.gitRoot,
        repoRoot: input.repoRoot,
      });
    },
    async stop(id: string): Promise<void> {
      stopped.push(id);
    },
    taskLiveness: () => null,
    liveSessionForTask: () => null,
    handleFor: () => null,
  };
  return supervisor as typeof supervisor & SdkSupervisor;
}

function run(haltClass = "mechanical"): PipelineRun {
  return {
    provider: "ai-conductor",
    repoRoot: "/repo/demo",
    slug: "phase-six",
    worktree: "/repo/demo/.worktrees/phase-six",
    tier: "M",
    track: "technical",
    steps: [{ name: "build", state: "failed" }],
    lastStep: "build",
    halt: { class: haltClass as NonNullable<PipelineRun["halt"]>["class"], reason: "retry the gate" },
    group: "halted",
    prUrl: null,
    costTokens: null,
    updatedAt: 1,
  };
}

test("conductor idea dispatch scrubs nesting and preserves the intent as one argv value", () => {
  const intent = "Build the thing; keep $HOME and `pwd` literal";
  assert.deepEqual(conductorEngineerArgv("/opt/bin/conduct-ts", intent), [
    "/usr/bin/env",
    "-u",
    "CLAUDECODE",
    "/opt/bin/conduct-ts",
    "engineer",
    "--idea",
    intent,
  ]);
});

test("a pipeline task launches the provider in its repository without an agent binding", async () => {
  const registry = new Registry();
  registry.upsertTask(
    mkTask({
      id: "pipeline-task",
      kind: "pipeline",
      repoRoot: "/repo/demo",
      intent: "Run conductor from Mission Control",
      title: "Run conductor",
    }),
  );
  const launches: unknown[][] = [];
  const link = {
    provider: "ai-conductor" as const,
    repoRoot: "/repo/demo",
    slug: "run-conductor-from-mission-control",
  };
  const dispatcher = new Dispatcher(registry, async () => assert.fail("no worktree is owned"), {
    pipelineLaunch: async () => ({
      ok: true,
      launchRuntime: "terminal",
      cwd: "/repo/demo",
      argv: [
        "/usr/bin/env",
        "-u",
        "CLAUDECODE",
        "/bin/conduct-ts",
        "engineer",
        "--idea",
        "Run conductor from Mission Control",
      ],
      pipelineRun: link,
    }),
    spawn: async (...args) => {
      assert.deepEqual(registry.getTask("pipeline-task")?.pipelineRun, link);
      assert.deepEqual(getDurableTask("pipeline-task")?.pipelineRun, link);
      assert.equal(registry.getTask("pipeline-task")?.homeName, null);
      launches.push(args);
      return "Run conductor";
    },
  });

  await dispatcher.dispatch("pipeline-task");

  assert.deepEqual(launches, [[
    "Run conductor",
    "pipeli",
    "/repo/demo",
    "/usr/bin/env",
    ["-u", "CLAUDECODE", "/bin/conduct-ts", "engineer", "--idea", "Run conductor from Mission Control"],
  ]]);
  const task = registry.getTask("pipeline-task");
  assert.equal(task?.status, "running");
  assert.equal(task?.homeName, "Run conductor");
  assert.equal(task?.sessionId, null);
  assert.deepEqual(task?.pipelineRun, link);
});

test("a Codex pipeline task refuses the Claude-only Terminal runtime before spawn", async () => {
  const registry = new Registry();
  registry.upsertTask(
    mkTask({
      id: "pipeline-terminal-codex",
      agent: "codex",
      kind: "pipeline",
      repoRoot: "/repo/terminal-codex",
      intent: "Keep this Pipeline on Codex",
      title: "Keep this Pipeline on Codex",
    }),
  );
  const link = {
    provider: "ai-conductor" as const,
    repoRoot: "/repo/terminal-codex",
    slug: "keep-this-pipeline-on-codex",
  };
  let spawned = false;
  const dispatcher = new Dispatcher(registry, undefined, {
    pipelineLaunch: async () => ({
      ok: true,
      launchRuntime: "terminal",
      cwd: "/repo/terminal-codex",
      argv: ["/bin/conduct-ts", "engineer", "--idea", "Keep this Pipeline on Codex"],
      pipelineRun: link,
    }),
    spawn: async () => {
      spawned = true;
      return "unreachable terminal";
    },
  });

  await dispatcher.dispatch("pipeline-terminal-codex");

  const task = registry.getTask("pipeline-terminal-codex");
  assert.deepEqual(
    {
      error: task?.error,
      homeName: task?.homeName,
      pipelineRun: task?.pipelineRun,
      sessionId: task?.sessionId,
      spawned,
      status: task?.status,
    },
    {
      error: "Terminal Pipeline launches are Claude-only; choose Claude or switch the Pipelines launch runtime to Agent SDK",
      homeName: null,
      pipelineRun: link,
      sessionId: null,
      spawned: false,
      status: "failed",
    },
  );
});

test("managed SDK pipeline dispatch composes the selected host prompt with no terminal or worktree", async () => {
  const registry = new Registry();
  registry.upsertTask(
    mkTask({
      id: "pipeline-sdk",
      agent: "codex",
      kind: "pipeline",
      repoRoot: "/repo/sdk",
      intent: "Build the SDK path\nwithout changing the daemon",
      title: "Build the SDK path",
    }),
  );
  const link = {
    provider: "ai-conductor" as const,
    repoRoot: "/repo/sdk",
    slug: "build-the-sdk-path-without-changing-the-daemon",
  };
  const supervisor = fakeSupervisor(registry);
  const mcp = {
    serverName: "mission-control",
    command: "/usr/bin/node",
    args: ["/dist/mcp/server.mjs"],
    env: { MISSION_TOKEN: "fixture" },
  };
  let spawned = false;
  let callerCredential = "";
  const dispatcher = new Dispatcher(registry, async () => assert.fail("no worktree is owned"), {
    supervisor,
    missionMcpDescriptor: async () => mcp,
    verifyMissionMcpTools: async (tools, descriptor) => {
      assert.deepEqual(tools, ["adopt_pipeline_run", "report_pipeline_workspace"]);
      callerCredential = descriptor?.env[PIPELINE_CALLER_CREDENTIAL_ENV] ?? "";
      assert.match(callerCredential, /^[A-Za-z0-9_-]{43}$/);
      return { ok: true };
    },
    pipelineLaunch: async () => ({
      ok: true,
      launchRuntime: "agent-sdk",
      cwd: "/repo/sdk",
      pipelineRun: link,
    }),
    spawn: async () => {
      spawned = true;
      return "unreachable";
    },
  });

  await dispatcher.dispatch("pipeline-sdk");

  assert.equal(spawned, false);
  const launchedSessionId = supervisor.starts[0]?.sessionId;
  assert.match(launchedSessionId ?? "", /^sdk:/);
  assert.equal(registry.managedPipelineLaunch(launchedSessionId!), null);
  assert.deepEqual(supervisor.starts, [{
    sessionId: launchedSessionId,
    agent: "codex",
    name: "Build the SDK path",
    cwd: "/repo/sdk",
    prompt: "$engineer - run this skill now. Build the SDK path\nwithout changing the daemon\n\n[Mission Control launch context: the reserved Pipeline run is build-the-sdk-path-without-changing-the-daemon. If Engineer resumes a different existing run, call adopt_pipeline_run with that run's slug before continuing. No call is needed when Engineer creates the reserved run. After Engineer creates or enters its authoring worktree, call report_pipeline_workspace with that absolute path before editing files there.]",
    acceptedGoalPrompt: "Build the SDK path\nwithout changing the daemon",
    // A pipeline task on this arm launches a directly streamable agent conversation, so it
    // presents its launch turn exactly as an ordinary embedded dispatch does: the host's
    // composed engineer invocation reaches the agent, the operator's own idea is what the
    // conversation shows. The terminal arm above launches the Conductor host instead - not an
    // agent conversation - and records no presentation at all.
    //
    // The marker's prompt is the SAME string as `prompt` above, spelled out rather than
    // referenced so this stays a literal assertion: fingerprinting a recomposed copy of turn
    // one is the exact defect that would make every pipeline launch render in full.
    launchPresentation: {
      prompt: "$engineer - run this skill now. Build the SDK path\nwithout changing the daemon\n\n[Mission Control launch context: the reserved Pipeline run is build-the-sdk-path-without-changing-the-daemon. If Engineer resumes a different existing run, call adopt_pipeline_run with that run's slug before continuing. No call is needed when Engineer creates the reserved run. After Engineer creates or enters its authoring worktree, call report_pipeline_workspace with that absolute path before editing files there.]",
      displayText: "Build the SDK path\nwithout changing the daemon",
    },
    model: null,
    effort: null,
    permissionMode: "approveForMe",
    mcp: {
      ...mcp,
      env: {
        ...mcp.env,
        [PIPELINE_CALLER_CREDENTIAL_ENV]: callerCredential,
      },
    },
    extraDirs: [],
    taskId: "pipeline-sdk",
    gitBranch: null,
    gitRoot: "/repo/sdk",
    repoRoot: "/repo/sdk",
  }]);
  const task = registry.getTask("pipeline-sdk");
  assert.equal(task?.status, "running");
  assert.equal(task?.sessionId, launchedSessionId);
  assert.equal(task?.homeName, null);
  assert.equal(task?.worktreePath, null);
  assert.deepEqual(task?.extraRepos, []);
  assert.deepEqual(task?.pipelineRun, link);
  assert.equal(registry.workEpisodeForTask("pipeline-sdk")?.sessionId, launchedSessionId);
  assert.deepEqual(registry.managedPipelineCaller(callerCredential), {
    taskId: "pipeline-sdk",
    sessionId: launchedSessionId,
    cwd: "/repo/sdk",
  });
});

test("the first discovery sweep does not settle a managed Pipeline host that is still launching", async () => {
  const registry = new Registry();
  const taskId = "pipeline-sdk-first-sweep";
  registry.upsertTask(
    mkTask({
      id: taskId,
      agent: "codex",
      kind: "pipeline",
      repoRoot: "/repo/first-sweep",
      intent: "Keep the managed host through the first sweep",
      title: "Keep the managed host",
    }),
  );
  // Installs the same sessions-observed reconciliation the daemon owns.
  new TaskManager(registry);
  let statusDuringStart: string | undefined;
  const stopped: string[] = [];
  const supervisor = {
    async start(input: Parameters<SdkSupervisor["start"]>[0]): Promise<Session> {
      assert.deepEqual(registry.managedPipelineLaunch(input.sessionId!), {
        taskId,
        sessionId: input.sessionId,
        cwd: "/repo/first-sweep",
      });
      registry.applyDiscovery([]);
      statusDuringStart = registry.getTask(taskId)?.status;
      return registry.registerSdkSession({
        id: input.sessionId!,
        agent: input.agent,
        name: input.name,
        cwd: input.cwd,
        agentSessionId: "codex-first-sweep",
        gitBranch: null,
        gitRoot: input.gitRoot,
        repoRoot: input.repoRoot,
      });
    },
    async stop(id: string): Promise<void> {
      stopped.push(id);
    },
    taskLiveness: () => null,
    liveSessionForTask: () => null,
    handleFor: () => null,
  } as unknown as SdkSupervisor;
  const dispatcher = new Dispatcher(registry, undefined, {
    supervisor,
    missionMcpDescriptor: async () => ({
      serverName: "mission-control",
      command: "/usr/bin/node",
      args: ["/dist/mcp/server.mjs"],
      env: {},
    }),
    verifyMissionMcpTools: async () => ({ ok: true }),
    pipelineLaunch: async () => ({
      ok: true,
      launchRuntime: "agent-sdk",
      cwd: "/repo/first-sweep",
      pipelineRun: {
        provider: "ai-conductor",
        repoRoot: "/repo/first-sweep",
        slug: "keep-the-managed-host-through-the-first-sweep",
      },
    }),
  });

  await dispatcher.dispatch(taskId);

  assert.equal(statusDuringStart, "dispatching");
  assert.equal(registry.getTask(taskId)?.status, "running");
  assert.match(registry.getTask(taskId)?.sessionId ?? "", /^sdk:/);
  assert.deepEqual(stopped, []);
});

test("managed Pipeline dispatch refuses a stale MCP bundle before host launch", async () => {
  const registry = new Registry();
  registry.upsertTask(mkTask({
    id: "pipeline-stale-mcp",
    agent: "codex",
    kind: "pipeline",
    repoRoot: "/repo/stale-mcp",
    intent: "Resume safely",
  }));
  const supervisor = fakeSupervisor(registry);
  const dispatcher = new Dispatcher(registry, undefined, {
    supervisor,
    missionMcpDescriptor: async () => ({
      serverName: "mission-control",
      command: "/usr/bin/node",
      args: ["/dist/mcp/server.mjs"],
      env: {},
    }),
    verifyMissionMcpTools: async () => ({
      ok: false,
      reason: "the built bundle does not publish adopt_pipeline_run; rebuild with: npm run build",
    }),
    pipelineLaunch: async () => ({
      ok: true,
      launchRuntime: "agent-sdk",
      cwd: "/repo/stale-mcp",
      pipelineRun: {
        provider: "ai-conductor",
        repoRoot: "/repo/stale-mcp",
        slug: "resume-safely",
      },
    }),
  });

  await dispatcher.dispatch("pipeline-stale-mcp");

  assert.deepEqual(supervisor.starts, []);
  assert.equal(registry.getTask("pipeline-stale-mcp")?.status, "failed");
  assert.match(registry.getTask("pipeline-stale-mcp")?.error ?? "", /rebuild with: npm run build/);
});

test("SDK preflight and start failures never fall back to Terminal", async () => {
  for (const mode of ["missing", "rejected"] as const) {
    const registry = new Registry();
    registry.upsertTask(
      mkTask({
        id: `pipeline-sdk-${mode}`,
        kind: "pipeline",
        repoRoot: `/repo/${mode}`,
        intent: "No fallback",
      }),
    );
    let spawned = false;
    const supervisor = mode === "rejected"
      ? ({
          start: async () => {
            throw new Error("Claude SDK launch refused by fixture");
          },
          taskLiveness: () => false,
        } as unknown as SdkSupervisor)
      : undefined;
    const dispatcher = new Dispatcher(registry, undefined, {
      supervisor,
      missionMcpDescriptor: async () =>
        mode === "rejected"
          ? {
              serverName: "mission-control",
              command: "/usr/bin/node",
              args: ["/dist/mcp/server.mjs"],
              env: {},
            }
          : null,
      verifyMissionMcpTools: async () => ({ ok: true }),
      pipelineLaunch: async () => ({
        ok: true,
        launchRuntime: "agent-sdk",
        cwd: `/repo/${mode}`,
        pipelineRun: {
          provider: "ai-conductor",
          repoRoot: `/repo/${mode}`,
          slug: "no-fallback",
        },
      }),
      spawn: async () => {
        spawned = true;
        return "unreachable";
      },
    });

    await dispatcher.dispatch(`pipeline-sdk-${mode}`);
    const task = registry.getTask(`pipeline-sdk-${mode}`);
    assert.equal(spawned, false, mode);
    assert.equal(task?.status, "failed", mode);
    assert.match(
      task?.error ?? "",
      mode === "missing" ? /cannot launch Conductor through Agent SDK/ : /Claude SDK launch refused by fixture/,
      mode,
    );
    assert.equal(task?.homeName, null, mode);
  }
});

test("rejected managed Pipeline launch clears its preallocated nonexistent session", async () => {
  const registry = new Registry();
  registry.upsertTask(mkTask({
    id: "pipeline-sdk-rejected-stale-liveness",
    agent: "codex",
    kind: "pipeline",
    repoRoot: "/repo/rejected-stale-liveness",
    intent: "Keep no phantom managed session",
  }));
  let prelaunchAttributionObserved = false;
  let registrySessionMissing = false;
  let callerCredential = "";
  let stopped = 0;
  let tornDown = 0;
  const supervisor = {
    start: async (input: Parameters<SdkSupervisor["start"]>[0]) => {
      callerCredential = input.mcp?.env[PIPELINE_CALLER_CREDENTIAL_ENV] ?? "";
      assert.match(callerCredential, /^[A-Za-z0-9_-]{43}$/);
      prelaunchAttributionObserved =
        typeof input.sessionId === "string" &&
        registry.getTask("pipeline-sdk-rejected-stale-liveness")?.sessionId === input.sessionId;
      registrySessionMissing =
        typeof input.sessionId === "string" && registry.getSession(input.sessionId) === undefined;
      throw new Error("Codex SDK launch refused by fixture");
    },
    taskLiveness: () => true,
    stop: async () => {
      stopped += 1;
    },
  } as unknown as SdkSupervisor;
  const dispatcher = new Dispatcher(registry, async () => {
    tornDown += 1;
  }, {
    supervisor,
    missionMcpDescriptor: async () => ({
      serverName: "mission-control",
      command: "/usr/bin/node",
      args: ["/dist/mcp/server.mjs"],
      env: {},
    }),
    verifyMissionMcpTools: async () => ({ ok: true }),
    pipelineLaunch: async () => ({
      ok: true,
      launchRuntime: "agent-sdk",
      cwd: "/repo/rejected-stale-liveness",
      pipelineRun: {
        provider: "ai-conductor",
        repoRoot: "/repo/rejected-stale-liveness",
        slug: "keep-no-phantom-managed-session",
      },
    }),
  });

  await dispatcher.dispatch("pipeline-sdk-rejected-stale-liveness");

  const task = registry.getTask("pipeline-sdk-rejected-stale-liveness");
  assert.equal(registry.managedPipelineCaller(callerCredential), null);
  assert.deepEqual({
    prelaunchAttributionObserved,
    registrySessionMissing,
    task: {
      sessionId: task?.sessionId,
      status: task?.status,
    },
    staleLiveResource: { stopped, tornDown },
  }, {
    prelaunchAttributionObserved: true,
    registrySessionMissing: true,
    task: {
      sessionId: null,
      status: "failed",
    },
    staleLiveResource: { stopped: 0, tornDown: 0 },
  });
});

test("rejected managed Pipeline retry restores its older live session attribution", async () => {
  const taskId = "pipeline-sdk-rejected-retry";
  const repoRoot = "/repo/rejected-retry";
  const olderSessionId = "sdk:pipeline-older-live";
  const registry = new Registry();
  registry.registerSdkSession({
    id: olderSessionId,
    agent: "codex",
    name: "Older live Pipeline host",
    cwd: repoRoot,
    agentSessionId: "codex-older-live",
    gitRoot: repoRoot,
    repoRoot,
  });
  registry.upsertTask(mkTask({
    id: taskId,
    agent: "codex",
    kind: "pipeline",
    repoRoot,
    intent: "Retry without losing older live attribution",
    sessionId: olderSessionId,
    status: "failed",
    error: "Older managed attempt failed",
  }));
  let prelaunchAttributionObserved = false;
  let stopped = 0;
  let tornDown = 0;
  const supervisor = {
    start: async (input: Parameters<SdkSupervisor["start"]>[0]) => {
      prelaunchAttributionObserved =
        typeof input.sessionId === "string" &&
        input.sessionId !== olderSessionId &&
        registry.getTask(taskId)?.sessionId === input.sessionId;
      throw new Error("Codex SDK retry launch refused by fixture");
    },
    taskLiveness: () => true,
    stop: async () => {
      stopped += 1;
    },
  } as unknown as SdkSupervisor;
  const dispatcher = new Dispatcher(registry, async () => {
    tornDown += 1;
  }, {
    supervisor,
    missionMcpDescriptor: async () => ({
      serverName: "mission-control",
      command: "/usr/bin/node",
      args: ["/dist/mcp/server.mjs"],
      env: {},
    }),
    verifyMissionMcpTools: async () => ({ ok: true }),
    pipelineLaunch: async () => ({
      ok: true,
      launchRuntime: "agent-sdk",
      cwd: repoRoot,
      pipelineRun: {
        provider: "ai-conductor",
        repoRoot,
        slug: "rejected-retry",
      },
    }),
  });

  await dispatcher.dispatch(taskId);

  const task = registry.getTask(taskId);
  assert.deepEqual({
    prelaunchAttributionObserved,
    task: {
      sessionId: task?.sessionId,
      status: task?.status,
    },
    olderLiveResource: {
      registered: registry.getSession(olderSessionId)?.id === olderSessionId,
      stopped,
      tornDown,
    },
  }, {
    prelaunchAttributionObserved: true,
    task: {
      sessionId: olderSessionId,
      status: "failed",
    },
    olderLiveResource: {
      registered: true,
      stopped: 0,
      tornDown: 0,
    },
  });
});

test("managed Pipeline start rejection clears its phantom host after concurrent settlement", async () => {
  const taskId = "pipeline-sdk-settled-during-start";
  const repoRoot = "/repo/settled-during-start";
  const slug = "preserve-settled-launch-attribution";
  const prUrl = "https://github.com/example/settled-during-start/pull/91";
  const registry = new Registry();
  new TaskManager(registry);
  registry.upsertTask(mkTask({
    id: taskId,
    agent: "codex",
    kind: "pipeline",
    repoRoot,
    intent: "Preserve settled launch attribution",
  }));
  let preallocatedSessionId = "";
  let markStarted!: () => void;
  let rejectStart!: (error: Error) => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const supervisor = {
    start: (input: Parameters<SdkSupervisor["start"]>[0]) => {
      preallocatedSessionId = input.sessionId!;
      return new Promise<Session>((_resolve, reject) => {
        rejectStart = reject;
        markStarted();
      });
    },
    taskLiveness: () => null,
  } as unknown as SdkSupervisor;
  const dispatcher = new Dispatcher(registry, undefined, {
    supervisor,
    missionMcpDescriptor: async () => ({
      serverName: "mission-control",
      command: "/usr/bin/node",
      args: ["/dist/mcp/server.mjs"],
      env: {},
    }),
    verifyMissionMcpTools: async () => ({ ok: true }),
    pipelineLaunch: async () => ({
      ok: true,
      launchRuntime: "agent-sdk",
      cwd: repoRoot,
      pipelineRun: {
        provider: "ai-conductor",
        repoRoot,
        slug,
      },
    }),
  });

  const dispatching = dispatcher.dispatch(taskId);
  await started;
  registry.upsertPipelineRun({
    ...run(),
    repoRoot,
    slug,
    worktree: `${repoRoot}/.worktrees/${slug}`,
    halt: null,
    group: "processed",
    steps: [{ name: "build", state: "done" }],
    prUrl,
    updatedAt: 2,
  });
  rejectStart(new Error("Codex SDK launch rejected after task settlement"));
  await dispatching;

  const settled = registry.getTask(taskId);
  assert.deepEqual({
    outcome: settled?.outcome,
    outcomeUrl: settled?.outcomeUrl,
    sessionId: settled?.sessionId,
    status: settled?.status,
  }, {
    outcome: `pipeline opened ${prUrl}`,
    outcomeUrl: prUrl,
    sessionId: null,
    status: "done",
  });
  assert.notEqual(preallocatedSessionId, "", "the rejected launch had assigned a host identity");
});

test("managed Pipeline cancellation clears a preallocated session when SDK start rejects", async () => {
  const taskId = "pipeline-sdk-cancel-rejected-start";
  const repoRoot = "/repo/cancel-rejected-start";
  const registry = new Registry();
  registry.upsertTask(mkTask({
    id: taskId,
    agent: "codex",
    kind: "pipeline",
    repoRoot,
    intent: "Cancel while SDK start is pending and then rejects",
  }));
  let preallocatedSessionId = "";
  let markStarted!: () => void;
  let rejectStart!: (error: Error) => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let stopped = 0;
  let tornDown = 0;
  const supervisor = {
    start: (input: Parameters<SdkSupervisor["start"]>[0]) => {
      preallocatedSessionId = input.sessionId!;
      assert.equal(registry.getTask(taskId)?.sessionId, preallocatedSessionId);
      assert.equal(registry.getSession(preallocatedSessionId), undefined);
      return new Promise<Session>((_resolve, reject) => {
        rejectStart = reject;
        markStarted();
      });
    },
    stop: async () => {
      stopped += 1;
    },
    taskLiveness: () => null,
  } as unknown as SdkSupervisor;
  const tasks = new TaskManager(registry, undefined, supervisor);
  const dispatcher = new Dispatcher(registry, async () => {
    tornDown += 1;
  }, {
    supervisor,
    missionMcpDescriptor: async () => ({
      serverName: "mission-control",
      command: "/usr/bin/node",
      args: ["/dist/mcp/server.mjs"],
      env: {},
    }),
    verifyMissionMcpTools: async () => ({ ok: true }),
    pipelineLaunch: async () => ({
      ok: true,
      launchRuntime: "agent-sdk",
      cwd: repoRoot,
      pipelineRun: {
        provider: "ai-conductor",
        repoRoot,
        slug: "cancel-rejected-start",
      },
    }),
  });

  const dispatching = dispatcher.dispatch(taskId);
  await started;
  const cancellation = await tasks.cancel(taskId);
  assert.equal(cancellation.ok, true);
  rejectStart(new Error("Codex SDK start rejected after cancellation"));
  await dispatching;

  const cancelled = registry.getTask(taskId);
  assert.deepEqual({
    sessionId: cancelled?.sessionId,
    status: cancelled?.status,
    stopped,
    tornDown,
  }, {
    sessionId: null,
    status: "cancelled",
    stopped: 0,
    tornDown: 1,
  });
});

test("failed cancellation during provider reservation leaves the task running", async (t) => {
  const taskId = "pipeline-cancel-during-reservation";
  const repoRoot = "/repo/cancel-during-reservation";
  const registry = new Registry();
  registry.upsertTask(mkTask({
    id: taskId,
    agent: "codex",
    kind: "pipeline",
    repoRoot,
    intent: "Cancel while reserving Engineer",
  }));
  let releaseCreate!: (result: { ok: true; value: PipelineEngineerRunSnapshot }) => void;
  let markCreateStarted!: () => void;
  const createStarted = new Promise<void>((resolve) => {
    markCreateStarted = resolve;
  });
  const createResult = new Promise<{ ok: true; value: PipelineEngineerRunSnapshot }>((resolve) => {
    releaseCreate = resolve;
  });
  const cancelledRunIds: string[] = [];
  const originalLifecycle = PIPELINE_PROVIDERS["ai-conductor"].engineerLifecycle;
  PIPELINE_PROVIDERS["ai-conductor"].engineerLifecycle = {
    capability: async () => ({ ok: true, value: { supported: true } }),
    create: async () => {
      markCreateStarted();
      return createResult;
    },
    inspectCorrelation: async () => ({ ok: true, value: [] }),
    replay: async () => ({ ok: true, value: [] }),
    cancel: async ({ engineerRunId }) => {
      cancelledRunIds.push(engineerRunId);
      return { ok: false, error: "provider unavailable", outcomeUnknown: true };
    },
  };
  t.after(() => {
    PIPELINE_PROVIDERS["ai-conductor"].engineerLifecycle = originalLifecycle;
  });
  const supervisor = fakeSupervisor(registry);
  const tasks = new TaskManager(registry, undefined, supervisor);
  const dispatcher = new Dispatcher(registry, undefined, {
    supervisor,
    missionMcpDescriptor: async () => ({
      serverName: "mission-control",
      command: "/usr/bin/node",
      args: ["/dist/mcp/server.mjs"],
      env: {},
    }),
    verifyMissionMcpTools: async () => ({ ok: true }),
    pipelineLaunch: async () => ({
      ok: true,
      commissioned: true,
      provider: "ai-conductor",
      launchRuntime: "agent-sdk",
      cwd: repoRoot,
    }),
  });

  const dispatching = dispatcher.dispatch(taskId);
  await createStarted;
  const cancellation = tasks.cancel(taskId);
  const commission = registry.pipelineCommissionForTask(taskId)!;
  releaseCreate({
    ok: true,
    value: {
      schemaVersion: 1,
      capability: "engineerLifecycleEventsV1",
      engineerRunId: "engineer-reserved-after-cancel",
      correlationId: commission.correlationId,
      attemptKey: commission.attempts[0]!.launchKey,
      attempt: 1,
      previousEngineerRunId: null,
      repoRoot,
      idea: "Cancel while reserving Engineer",
      eventRevision: 1,
      state: "created",
    },
  });
  assert.deepEqual(await cancellation, {
    ok: false,
    error: "could not cancel the provider Engineer run: provider unavailable",
  });
  await dispatching;

  assert.equal(registry.getTask(taskId)?.status, "running");
  assert.equal(supervisor.starts.length, 1);
  assert.deepEqual(cancelledRunIds, ["engineer-reserved-after-cancel"]);
  assert.equal(registry.pipelineCommissionForTask(taskId)?.lifecycle, "created");
  assert.equal(
    registry.pipelineCommissionForTask(taskId)?.attempts[0]?.engineerRunId,
    "engineer-reserved-after-cancel",
  );
  assert.equal(registry.pipelineCommissionForTask(taskId)?.error, null);
});

test("successful cancellation during provider reservation prevents host launch", async (t) => {
  const taskId = "pipeline-cancel-reservation-success";
  const repoRoot = "/repo/cancel-reservation-success";
  const registry = new Registry();
  registry.upsertTask(mkTask({
    id: taskId,
    agent: "codex",
    kind: "pipeline",
    repoRoot,
    intent: "Cancel the reserved Engineer",
  }));
  let releaseCreate!: (result: { ok: true; value: PipelineEngineerRunSnapshot }) => void;
  let markCreateStarted!: () => void;
  const createStarted = new Promise<void>((resolve) => {
    markCreateStarted = resolve;
  });
  const createResult = new Promise<{ ok: true; value: PipelineEngineerRunSnapshot }>((resolve) => {
    releaseCreate = resolve;
  });
  let reservedRun!: PipelineEngineerRunSnapshot;
  const cancelledRunIds: string[] = [];
  const originalLifecycle = PIPELINE_PROVIDERS["ai-conductor"].engineerLifecycle;
  PIPELINE_PROVIDERS["ai-conductor"].engineerLifecycle = {
    capability: async () => ({ ok: true, value: { supported: true } }),
    create: async () => {
      markCreateStarted();
      return createResult;
    },
    inspectCorrelation: async () => ({ ok: true, value: [] }),
    replay: async () => ({ ok: true, value: [] }),
    cancel: async ({ engineerRunId }) => {
      cancelledRunIds.push(engineerRunId);
      return { ok: true, value: reservedRun };
    },
  };
  t.after(() => {
    PIPELINE_PROVIDERS["ai-conductor"].engineerLifecycle = originalLifecycle;
  });
  let starts = 0;
  const supervisor = {
    start: async () => {
      starts += 1;
      throw new Error("a cancelled reservation must not start a host");
    },
    taskLiveness: () => null,
  } as unknown as SdkSupervisor;
  const tasks = new TaskManager(registry, undefined, supervisor);
  const dispatcher = new Dispatcher(registry, undefined, {
    supervisor,
    pipelineLaunch: async () => ({
      ok: true,
      commissioned: true,
      provider: "ai-conductor",
      launchRuntime: "agent-sdk",
      cwd: repoRoot,
    }),
  });

  const dispatching = dispatcher.dispatch(taskId);
  await createStarted;
  const cancellation = tasks.cancel(taskId);
  const commission = registry.pipelineCommissionForTask(taskId)!;
  reservedRun = {
    schemaVersion: 1,
    capability: "engineerLifecycleEventsV1",
    engineerRunId: "engineer-reserved-and-cancelled",
    correlationId: commission.correlationId,
    attemptKey: commission.attempts[0]!.launchKey,
    attempt: 1,
    previousEngineerRunId: null,
    repoRoot,
    idea: "Cancel the reserved Engineer",
    eventRevision: 1,
    state: "created",
  };
  releaseCreate({
    ok: true,
    value: reservedRun,
  });

  assert.deepEqual(await cancellation, { ok: true });
  await dispatching;
  assert.equal(registry.getTask(taskId)?.status, "cancelled");
  assert.equal(starts, 0);
  assert.deepEqual(cancelledRunIds, ["engineer-reserved-and-cancelled"]);
  assert.equal(registry.pipelineCommissionForTask(taskId)?.lifecycle, "cancelled");
  assert.equal(
    registry.pipelineCommissionForTask(taskId)?.attempts[0]?.engineerRunId,
    "engineer-reserved-and-cancelled",
  );
});

test("cancellation after reservation settlement prevents managed host launch", async (t) => {
  const taskId = "pipeline-cancel-after-reservation";
  const repoRoot = "/repo/cancel-after-reservation";
  const registry = new Registry();
  registry.upsertTask(mkTask({
    id: taskId,
    agent: "codex",
    kind: "pipeline",
    repoRoot,
    intent: "Cancel before the managed host launches",
  }));
  let reservedRun!: PipelineEngineerRunSnapshot;
  const cancelledRunIds: string[] = [];
  const originalLifecycle = PIPELINE_PROVIDERS["ai-conductor"].engineerLifecycle;
  PIPELINE_PROVIDERS["ai-conductor"].engineerLifecycle = {
    capability: async () => ({ ok: true, value: { supported: true } }),
    create: async ({ correlationId, attemptKey }) => {
      reservedRun = {
        schemaVersion: 1,
        capability: "engineerLifecycleEventsV1",
        engineerRunId: "engineer-cancel-after-reservation",
        correlationId,
        attemptKey,
        attempt: 1,
        previousEngineerRunId: null,
        repoRoot,
        idea: "Cancel before the managed host launches",
        eventRevision: 1,
        state: "created",
      };
      return { ok: true, value: reservedRun };
    },
    inspectCorrelation: async () => ({ ok: true, value: [] }),
    replay: async () => ({ ok: true, value: [] }),
    cancel: async ({ engineerRunId }) => {
      cancelledRunIds.push(engineerRunId);
      return { ok: true, value: { ...reservedRun, eventRevision: 2, state: "cancelled" } };
    },
  };
  t.after(() => {
    PIPELINE_PROVIDERS["ai-conductor"].engineerLifecycle = originalLifecycle;
  });
  let markDescriptorStarted!: () => void;
  let releaseDescriptor!: () => void;
  const descriptorStarted = new Promise<void>((resolve) => {
    markDescriptorStarted = resolve;
  });
  const descriptorReleased = new Promise<void>((resolve) => {
    releaseDescriptor = resolve;
  });
  const supervisor = fakeSupervisor(registry);
  const tasks = new TaskManager(registry, undefined, supervisor);
  const dispatcher = new Dispatcher(registry, undefined, {
    supervisor,
    missionMcpDescriptor: async () => {
      markDescriptorStarted();
      await descriptorReleased;
      return {
        serverName: "mission-control",
        command: "/usr/bin/node",
        args: ["/dist/mcp/server.mjs"],
        env: {},
      };
    },
    verifyMissionMcpTools: async () => ({ ok: true }),
    pipelineLaunch: async () => ({
      ok: true,
      commissioned: true,
      provider: "ai-conductor",
      launchRuntime: "agent-sdk",
      cwd: repoRoot,
    }),
  });

  const dispatching = dispatcher.dispatch(taskId);
  await descriptorStarted;
  const cancellation = await tasks.cancel(taskId);
  releaseDescriptor();
  await dispatching;

  assert.deepEqual(cancellation, { ok: true });
  assert.equal(registry.getTask(taskId)?.status, "cancelled");
  assert.deepEqual(cancelledRunIds, ["engineer-cancel-after-reservation"]);
  assert.equal(supervisor.starts.length, 0);
});

test("commissioned dispatch rejects a provider reservation with mismatched identity", async (t) => {
  const registry = new Registry();
  const supervisor = fakeSupervisor(registry);
  let mismatch: {
    field: "correlationId" | "repoRoot" | "attemptKey";
    value: string;
  } = { field: "correlationId", value: "foreign-correlation" };
  const originalLifecycle = PIPELINE_PROVIDERS["ai-conductor"].engineerLifecycle;
  PIPELINE_PROVIDERS["ai-conductor"].engineerLifecycle = {
    capability: async () => ({ ok: true, value: { supported: true } }),
    create: async (input) => ({
      ok: true,
      value: {
        schemaVersion: 1,
        capability: "engineerLifecycleEventsV1",
        engineerRunId: `engineer-mismatched-${mismatch.field}`,
        correlationId:
          mismatch.field === "correlationId" ? mismatch.value : input.correlationId,
        attemptKey: mismatch.field === "attemptKey" ? mismatch.value : input.attemptKey,
        attempt: 1,
        previousEngineerRunId: null,
        repoRoot: mismatch.field === "repoRoot" ? mismatch.value : input.repoRoot,
        idea: input.idea,
        eventRevision: 1,
        state: "created",
      },
    }),
    inspectCorrelation: async () => ({ ok: true, value: [] }),
    replay: async () => ({ ok: true, value: [] }),
    cancel: async () => assert.fail("a mismatched provider reservation is not owned locally"),
  };
  t.after(() => {
    PIPELINE_PROVIDERS["ai-conductor"].engineerLifecycle = originalLifecycle;
  });
  const dispatcher = new Dispatcher(registry, undefined, {
    supervisor,
    pipelineLaunch: async (repoRoot) => ({
      ok: true,
      commissioned: true,
      provider: "ai-conductor",
      launchRuntime: "agent-sdk",
      cwd: repoRoot,
    }),
  });

  for (const candidate of [
    { field: "correlationId", value: "foreign-correlation" },
    { field: "repoRoot", value: "/repo/foreign" },
    { field: "attemptKey", value: "foreign-attempt" },
  ] as const) {
    mismatch = candidate;
    const taskId = `pipeline-mismatched-${candidate.field}`;
    registry.upsertTask(mkTask({
      id: taskId,
      agent: "codex",
      kind: "pipeline",
      repoRoot: `/repo/mismatched-${candidate.field}`,
      intent: `Reject a mismatched ${candidate.field}`,
    }));

    await dispatcher.dispatch(taskId);

    assert.equal(registry.getTask(taskId)?.status, "failed");
    assert.match(registry.getTask(taskId)?.error ?? "", new RegExp(candidate.field));
    assert.equal(
      registry.pipelineCommissionForTask(taskId)?.attempts[0]?.engineerRunId,
      null,
    );
  }
  assert.equal(supervisor.starts.length, 0);
});

test("commissioned requests sharing derived task identity reserve separate provider runs", async (t) => {
  const repoRoot = "/repo/shared-derived-identity";
  const registry = new Registry();
  for (const taskId of ["pipeline-shared-identity-one", "pipeline-shared-identity-two"]) {
    registry.upsertTask(mkTask({
      id: taskId,
      agent: "codex",
      kind: "pipeline",
      repoRoot,
      intent: "Build the same named plan",
    }));
  }
  const originalLifecycle = PIPELINE_PROVIDERS["ai-conductor"].engineerLifecycle;
  PIPELINE_PROVIDERS["ai-conductor"].engineerLifecycle = {
    capability: async () => ({ ok: true, value: { supported: true } }),
    create: async (input) => ({
      ok: true,
      value: {
        schemaVersion: 1,
        capability: "engineerLifecycleEventsV1",
        engineerRunId: `engineer-${input.correlationId}`,
        correlationId: input.correlationId,
        attemptKey: input.attemptKey,
        attempt: 1,
        previousEngineerRunId: null,
        repoRoot: input.repoRoot,
        idea: input.idea,
        eventRevision: 1,
        state: "created",
      },
    }),
    inspectCorrelation: async () => ({ ok: true, value: [] }),
    replay: async () => ({ ok: true, value: [] }),
    cancel: async () => assert.fail("successful distinct reservations remain active"),
  };
  t.after(() => {
    PIPELINE_PROVIDERS["ai-conductor"].engineerLifecycle = originalLifecycle;
  });
  const supervisor = fakeSupervisor(registry);
  const dispatcher = new Dispatcher(registry, undefined, {
    supervisor,
    missionMcpDescriptor: async () => ({
      serverName: "mission-control",
      command: "/usr/bin/node",
      args: ["/dist/mcp/server.mjs"],
      env: {},
    }),
    verifyMissionMcpTools: async () => ({ ok: true }),
    pipelineLaunch: async () => ({
      ok: true,
      commissioned: true,
      provider: "ai-conductor",
      launchRuntime: "agent-sdk",
      cwd: repoRoot,
    }),
  });

  await dispatcher.dispatch("pipeline-shared-identity-one");
  await dispatcher.dispatch("pipeline-shared-identity-two");

  const commissions = [
    registry.pipelineCommissionForTask("pipeline-shared-identity-one"),
    registry.pipelineCommissionForTask("pipeline-shared-identity-two"),
  ];
  assert.deepEqual(
    [
      registry.getTask("pipeline-shared-identity-one")?.status,
      registry.getTask("pipeline-shared-identity-two")?.status,
    ],
    ["running", "running"],
  );
  assert.equal(supervisor.starts.length, 2);
  assert.notEqual(commissions[0]?.id, commissions[1]?.id);
  assert.notEqual(
    commissions[0]?.attempts[0]?.engineerRunId,
    commissions[1]?.attempts[0]?.engineerRunId,
  );
});

test("provider reservation is cancelled when managed host setup fails", async (t) => {
  const taskId = "pipeline-reserved-host-failure";
  const repoRoot = "/repo/reserved-host-failure";
  const registry = new Registry();
  registry.upsertTask(mkTask({
    id: taskId,
    agent: "codex",
    kind: "pipeline",
    repoRoot,
    intent: "Cancel reservation after host failure",
  }));
  const cancelledRunIds: string[] = [];
  const originalLifecycle = PIPELINE_PROVIDERS["ai-conductor"].engineerLifecycle;
  PIPELINE_PROVIDERS["ai-conductor"].engineerLifecycle = {
    capability: async () => ({ ok: true, value: { supported: true } }),
    create: async ({ correlationId, attemptKey }) => ({
      ok: true,
      value: {
        schemaVersion: 1,
        capability: "engineerLifecycleEventsV1",
        engineerRunId: "engineer-reserved-host-failure",
        correlationId,
        attemptKey,
        attempt: 1,
        previousEngineerRunId: null,
        repoRoot,
        idea: "Cancel reservation after host failure",
        eventRevision: 1,
        state: "created",
      },
    }),
    inspectCorrelation: async () => ({ ok: true, value: [] }),
    replay: async () => ({ ok: true, value: [] }),
    cancel: async ({ engineerRunId }) => {
      cancelledRunIds.push(engineerRunId);
      return {
        ok: true,
        value: {
          schemaVersion: 1,
          capability: "engineerLifecycleEventsV1",
          engineerRunId,
          correlationId: registry.pipelineCommissionForTask(taskId)!.correlationId,
          attemptKey: registry.pipelineCommissionForTask(taskId)!.attempts[0]!.launchKey,
          attempt: 1,
          previousEngineerRunId: null,
          repoRoot,
          idea: "Cancel reservation after host failure",
          eventRevision: 2,
          state: "cancelled",
        },
      };
    },
  };
  t.after(() => {
    PIPELINE_PROVIDERS["ai-conductor"].engineerLifecycle = originalLifecycle;
  });
  const supervisor = {
    start: async () => {
      throw new Error("SDK host refused after reservation");
    },
    taskLiveness: () => false,
  } as unknown as SdkSupervisor;
  const dispatcher = new Dispatcher(registry, undefined, {
    supervisor,
    missionMcpDescriptor: async () => ({
      serverName: "mission-control",
      command: "/usr/bin/node",
      args: ["/dist/mcp/server.mjs"],
      env: {},
    }),
    verifyMissionMcpTools: async () => ({ ok: true }),
    pipelineLaunch: async () => ({
      ok: true,
      commissioned: true,
      provider: "ai-conductor",
      launchRuntime: "agent-sdk",
      cwd: repoRoot,
    }),
  });

  await dispatcher.dispatch(taskId);

  assert.deepEqual(cancelledRunIds, ["engineer-reserved-host-failure"]);
  assert.equal(registry.getTask(taskId)?.status, "failed");
  assert.equal(registry.getTask(taskId)?.error, "SDK host refused after reservation");
  assert.equal(registry.pipelineCommissionForTask(taskId)?.lifecycle, "cancelled");
});

test("failed host cleanup keeps the provider reservation owned until cancellation retries", async (t) => {
  const taskId = "pipeline-reserved-host-cleanup-failure";
  const repoRoot = "/repo/reserved-host-cleanup-failure";
  const registry = new Registry();
  registry.upsertTask(mkTask({
    id: taskId,
    agent: "codex",
    kind: "pipeline",
    repoRoot,
    intent: "Retain reservation after host cleanup failure",
  }));
  const cancelledRunIds: string[] = [];
  const originalLifecycle = PIPELINE_PROVIDERS["ai-conductor"].engineerLifecycle;
  PIPELINE_PROVIDERS["ai-conductor"].engineerLifecycle = {
    capability: async () => ({ ok: true, value: { supported: true } }),
    create: async ({ correlationId, attemptKey }) => ({
      ok: true,
      value: {
        schemaVersion: 1,
        capability: "engineerLifecycleEventsV1",
        engineerRunId: "engineer-reserved-host-cleanup-failure",
        correlationId,
        attemptKey,
        attempt: 1,
        previousEngineerRunId: null,
        repoRoot,
        idea: "Retain reservation after host cleanup failure",
        eventRevision: 1,
        state: "created",
      },
    }),
    inspectCorrelation: async () => ({ ok: true, value: [] }),
    replay: async () => ({ ok: true, value: [] }),
    cancel: async ({ engineerRunId }) => {
      cancelledRunIds.push(engineerRunId);
      if (cancelledRunIds.length === 1) {
        return { ok: false, error: "provider unavailable", outcomeUnknown: true };
      }
      return {
        ok: true,
        value: {
          schemaVersion: 1,
          capability: "engineerLifecycleEventsV1",
          engineerRunId,
          correlationId: registry.pipelineCommissionForTask(taskId)!.correlationId,
          attemptKey: registry.pipelineCommissionForTask(taskId)!.attempts[0]!.launchKey,
          attempt: 1,
          previousEngineerRunId: null,
          repoRoot,
          idea: "Retain reservation after host cleanup failure",
          eventRevision: 2,
          state: "cancelled",
        },
      };
    },
  };
  t.after(() => {
    PIPELINE_PROVIDERS["ai-conductor"].engineerLifecycle = originalLifecycle;
  });
  const supervisor = {
    start: async () => {
      throw new Error("SDK host refused after reservation");
    },
    taskLiveness: () => false,
  } as unknown as SdkSupervisor;
  const tasks = new TaskManager(registry, undefined, supervisor);
  const dispatcher = new Dispatcher(registry, undefined, {
    supervisor,
    missionMcpDescriptor: async () => ({
      serverName: "mission-control",
      command: "/usr/bin/node",
      args: ["/dist/mcp/server.mjs"],
      env: {},
    }),
    verifyMissionMcpTools: async () => ({ ok: true }),
    pipelineLaunch: async () => ({
      ok: true,
      commissioned: true,
      provider: "ai-conductor",
      launchRuntime: "agent-sdk",
      cwd: repoRoot,
    }),
  });

  await dispatcher.dispatch(taskId);

  const retainedTask = registry.getTask(taskId)!;
  const retainedCommission = registry.pipelineCommissionForTask(taskId)!;
  assert.equal(retainedTask.status, "running");
  assert.match(retainedTask.error ?? "", /SDK host refused after reservation/);
  assert.match(retainedTask.error ?? "", /provider unavailable/);
  assert.equal(retainedCommission.lifecycle, "created");
  assert.equal(retainedCommission.attempts[0]?.state, "reserved");
  assert.equal(
    retainedCommission.attempts[0]?.engineerRunId,
    "engineer-reserved-host-cleanup-failure",
  );
  assert.match(retainedCommission.error ?? "", /provider unavailable/);
  assert.deepEqual(cancelledRunIds, ["engineer-reserved-host-cleanup-failure"]);
  assert.deepEqual(await tasks.reschedule(taskId), {
    ok: false,
    error: "task is running, only a cancelled or failed task can be rescheduled",
  });

  assert.deepEqual(await tasks.cancel(taskId), { ok: true });
  assert.deepEqual(cancelledRunIds, [
    "engineer-reserved-host-cleanup-failure",
    "engineer-reserved-host-cleanup-failure",
  ]);
  assert.equal(registry.getTask(taskId)?.status, "cancelled");
  assert.equal(registry.pipelineCommissionForTask(taskId)?.lifecycle, "cancelled");
});

test("a commission persistence race does not strand local task cancellation", async (t) => {
  const taskId = "pipeline-cancel-commission-race";
  const repoRoot = "/repo/cancel-commission-race";
  const registry = new Registry();
  registry.upsertTask(mkTask({
    id: taskId,
    kind: "pipeline",
    repoRoot,
    status: "running",
  }));
  const created = createPipelineCommission({
    taskId,
    provider: "ai-conductor",
    repoRoot,
    id: "commission-cancel-race",
    correlationId: "correlation-cancel-race",
    launchKey: "launch-cancel-race",
  });
  const authoring = bindPipelineCommissionAttempt({
    commissionId: created.id,
    attempt: 1,
    engineerRunId: "engineer-cancel-race",
    providerAttempt: 1,
    attemptKey: "launch-cancel-race",
    previousEngineerRunId: null,
  });
  registry.upsertTask({
    ...registry.getTask(taskId)!,
    pipelineCommissionId: authoring.id,
    updatedAt: Date.now(),
  });
  registry.upsertPipelineCommission(authoring);

  const settledAttempt = {
    ...authoring.attempts[0]!,
    state: "settled" as const,
    terminalReason: "provider settled during cancellation",
  };
  const settled: PipelineCommission = {
    ...authoring,
    lifecycle: "settled",
    attempts: [settledAttempt],
  };
  const originalLifecycle = PIPELINE_PROVIDERS["ai-conductor"].engineerLifecycle;
  PIPELINE_PROVIDERS["ai-conductor"].engineerLifecycle = {
    capability: async () => ({ ok: true, value: { supported: true } }),
    create: async () => ({ ok: false, error: "unused", outcomeUnknown: false }),
    inspectCorrelation: async () => ({ ok: true, value: [] }),
    replay: async () => ({ ok: true, value: [] }),
    cancel: async () => {
      upsertPipelineCommissionAttempt(settled, settledAttempt);
      registry.upsertPipelineCommission(settled);
      return {
        ok: true,
        value: {
          schemaVersion: 1,
          capability: "engineerLifecycleEventsV1",
          engineerRunId: "engineer-cancel-race",
          correlationId: authoring.correlationId,
          attemptKey: authoring.attempts[0]!.launchKey,
          attempt: 1,
          previousEngineerRunId: null,
          repoRoot,
          idea: "Cancel commission race",
          eventRevision: 2,
          state: "awaiting_spec_merge",
        },
      };
    },
  };
  t.after(() => {
    PIPELINE_PROVIDERS["ai-conductor"].engineerLifecycle = originalLifecycle;
  });

  const cancellation = await new TaskManager(registry).cancel(taskId);

  assert.equal(cancellation.ok, false);
  assert.match(cancellation.error ?? "", /could not cancel the Engineer commission/);
  assert.match(cancellation.error ?? "", /settled pipeline commission cannot be cancelled/);
  assert.equal(registry.getTask(taskId)?.status, "cancelled");
  assert.equal(registry.pipelineCommission(authoring.id)?.lifecycle, "settled");
});

test("cancelling implementation preserves the successful Engineer commission", async () => {
  const taskId = "pipeline-post-handoff-cancel";
  const repoRoot = "/repo/post-handoff-cancel";
  const sessionId = `sdk:${taskId}`;
  const registry = new Registry();
  registry.registerSdkSession({
    id: sessionId,
    agent: "claude",
    name: taskId,
    cwd: repoRoot,
    agentSessionId: "engineer-before-cancel",
    gitBranch: "plan/post-handoff-cancel",
    gitRoot: repoRoot,
    repoRoot,
  });
  registry.upsertTask(mkTask({
    id: taskId,
    kind: "pipeline",
    repoRoot,
    status: "running",
    sessionId,
    pipelineCommissionId: "commission-post-handoff",
    pipelineRun: {
      provider: "ai-conductor",
      repoRoot,
      slug: "post-handoff-cancel",
    },
  }));
  const commission: PipelineCommission = {
    id: "commission-post-handoff",
    taskId,
    provider: "ai-conductor",
    repoRoot,
    correlationId: "correlation-post-handoff",
    lifecycle: "awaiting_spec_merge",
    attempts: [{
      attempt: 1,
      launchKey: "launch-post-handoff",
      engineerRunId: "engineer-post-handoff",
      previousEngineerRunId: null,
      providerRevision: 3,
      state: "settled",
      terminalReason: "awaiting_spec_merge",
      updatedAt: 1_000,
    }],
    activeAttempt: 1,
    steps: ENGINEER_STEP_NAMES.map((name) => ({ name, state: "done" })),
    currentStep: null,
    tier: "M",
    track: "technical",
    project: "mission-control",
    authoringWorktree: `${repoRoot}/.worktrees/spec`,
    handoff: {
      planSlug: "post-handoff-cancel",
      branch: "plan/post-handoff-cancel",
      prUrl: "https://github.com/example/repo/pull/42",
      outcome: "pr_opened",
    },
    linkedRun: {
      provider: "ai-conductor",
      repoRoot,
      slug: "post-handoff-cancel",
    },
    blocker: null,
    error: null,
    createdAt: 500,
    updatedAt: 1_000,
  };
  registry.upsertPipelineCommission(commission);
  registry.bindTaskToWorkEpisode(taskId, sessionId);

  let markStopStarted!: () => void;
  let releaseStop!: () => void;
  const stopStarted = new Promise<void>((resolve) => {
    markStopStarted = resolve;
  });
  const stopped = new Promise<void>((resolve) => {
    releaseStop = resolve;
  });
  const supervisor = {
    handleFor: () => ({}),
    taskLiveness: () => null,
    stop: async () => {
      markStopStarted();
      await stopped;
    },
  } as unknown as SdkSupervisor;

  const cancelling = new TaskManager(registry, undefined, supervisor).cancel(taskId);
  await stopStarted;
  assert.equal(registry.getTask(taskId)?.status, "cancelled");
  registry.applyDriverEvent(sessionId, {
    kind: "bound",
    agentSessionId: "engineer-after-cancel",
    transcriptPath: null,
    modelId: "claude-opus-4",
    pid: null,
  });
  assert.equal(registry.workEpisodeForTask(taskId), null);
  releaseStop();

  const cancellation = await cancelling;

  assert.equal(cancellation.ok, true);
  assert.equal(registry.getTask(taskId)?.status, "cancelled");
  const preserved = registry.pipelineCommission(commission.id);
  assert.deepEqual(preserved, commission);
  assert.equal(pipelineCommissionLine(preserved!), "Awaiting spec merge");
});

test("cancellation during SDK start stops the newly created Engineer host", async () => {
  const registry = new Registry();
  registry.upsertTask(
    mkTask({
      id: "pipeline-sdk-cancel",
      kind: "pipeline",
      repoRoot: "/repo/cancel",
      intent: "Cancel while starting",
    }),
  );
  let release!: (session: Session) => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const stopped: string[] = [];
  let startingSessionId: string | undefined;
  const supervisor = {
    start: (input: Parameters<SdkSupervisor["start"]>[0]) => new Promise<Session>((resolve) => {
      startingSessionId = input.sessionId;
      release = resolve;
      markStarted();
    }),
    async stop(id: string) {
      stopped.push(id);
    },
    taskLiveness: () => null,
  } as unknown as SdkSupervisor;
  const dispatcher = new Dispatcher(registry, undefined, {
    supervisor,
    missionMcpDescriptor: async () => ({
      serverName: "mission-control",
      command: "/usr/bin/node",
      args: ["/dist/mcp/server.mjs"],
      env: {},
    }),
    verifyMissionMcpTools: async () => ({ ok: true }),
    pipelineLaunch: async () => ({
      ok: true,
      launchRuntime: "agent-sdk",
      cwd: "/repo/cancel",
      pipelineRun: {
        provider: "ai-conductor",
        repoRoot: "/repo/cancel",
        slug: "cancel-while-starting",
      },
    }),
    spawn: async () => assert.fail("Terminal fallback is forbidden"),
  });

  const dispatching = dispatcher.dispatch("pipeline-sdk-cancel");
  await started;
  const current = registry.getTask("pipeline-sdk-cancel")!;
  registry.upsertTask({ ...current, status: "cancelled", updatedAt: Date.now() });
  const session = registry.registerSdkSession({
    id: startingSessionId!,
    agent: "claude",
    name: "cancelled",
    cwd: "/repo/cancel",
  });
  release(session);
  await dispatching;

  assert.deepEqual(stopped, [session.id]);
  assert.equal(registry.getTask("pipeline-sdk-cancel")?.status, "cancelled");
  assert.equal(registry.getTask("pipeline-sdk-cancel")?.sessionId, null);
});

test("an unreadable provider capability refuses before the terminal host starts", async (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), "mission-pipeline-unreadable-"));
  writeFileSync(join(repoRoot, ".worktrees"), "not a directory");
  t.after(() => {
    setPipelinesConfig({ enabled: false, repos: [] });
    rmSync(repoRoot, { recursive: true, force: true });
  });
  setPipelinesConfig({
    enabled: true,
    repos: [{ provider: "ai-conductor", repoRoot, enabled: true }],
  });

  const registry = new Registry();
  registry.upsertTask(
    mkTask({
      id: "pipeline-unreadable",
      kind: "pipeline",
      repoRoot,
      intent: "Unreadable provider key space",
    }),
  );
  let spawned = false;
  const dispatcher = new Dispatcher(registry, undefined, {
    pipelineLaunch: async () => ({
      ok: false,
      error: "could not verify Engineer lifecycle support: provider output was unreadable",
    }),
    spawn: async () => {
      spawned = true;
      return "unreachable";
    },
  });

  await dispatcher.dispatch("pipeline-unreadable");

  assert.equal(spawned, false);
  assert.equal(registry.getTask("pipeline-unreadable")?.status, "failed");
  assert.match(
    registry.getTask("pipeline-unreadable")?.error ?? "",
    /could not verify Engineer lifecycle support/,
  );
  assert.equal(registry.getTask("pipeline-unreadable")?.pipelineRun, null);
});

test("an authoring worktree cannot bypass the Engineer capability gate", async (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), "mission-pipeline-collision-"));
  const slug = "existing-provider-worktree";
  mkdirSync(join(repoRoot, ".worktrees", slug, ".pipeline"), { recursive: true });
  t.after(() => {
    setPipelinesConfig({ enabled: false, repos: [] });
    rmSync(repoRoot, { recursive: true, force: true });
  });
  setPipelinesConfig({
    enabled: true,
    repos: [{ provider: "ai-conductor", repoRoot, enabled: true }],
  });

  const registry = new Registry();
  registry.upsertTask(
    mkTask({
      id: "pipeline-provider-collision",
      kind: "pipeline",
      repoRoot,
      intent: "Existing provider worktree",
    }),
  );
  let spawned = false;
  const dispatcher = new Dispatcher(registry, undefined, {
    pipelineLaunch: async () => ({
      ok: false,
      error: "the pipeline provider does not advertise engineerLifecycleEventsV1; upgrade it before dispatch",
    }),
    spawn: async () => {
      spawned = true;
      return "unreachable";
    },
  });

  await dispatcher.dispatch("pipeline-provider-collision");

  assert.equal(spawned, false);
  assert.equal(registry.getTask("pipeline-provider-collision")?.status, "failed");
  assert.match(
    registry.getTask("pipeline-provider-collision")?.error ?? "",
    /does not advertise engineerLifecycleEventsV1/,
  );
  assert.equal(registry.getTask("pipeline-provider-collision")?.pipelineRun, null);
});

test("running and dispatching tasks refuse a second active owner before terminal spawn", async () => {
  for (const status of ["running", "dispatching"] as const) {
    const repoRoot = `/repo/duplicate-${status}`;
    const link = { provider: "ai-conductor" as const, repoRoot, slug: "same-run" };
    const registry = new Registry();
    registry.upsertTask(
      mkTask({
        id: `pipeline-owner-${status}`,
        kind: "pipeline",
        repoRoot,
        status,
        pipelineRun: link,
      }),
    );
    registry.upsertTask(
      mkTask({
        id: `pipeline-contender-${status}`,
        kind: "pipeline",
        repoRoot,
        intent: "Same run",
      }),
    );
    let spawned = false;
    const dispatcher = new Dispatcher(registry, undefined, {
      pipelineLaunch: async () => ({
        ok: true,
        launchRuntime: "terminal",
        cwd: repoRoot,
        argv: ["/bin/conduct-ts", "engineer", "--idea", "Same run"],
        pipelineRun: link,
      }),
      spawn: async () => {
        spawned = true;
        return "unreachable";
      },
    });

    await dispatcher.dispatch(`pipeline-contender-${status}`);

    const contender = registry.getTask(`pipeline-contender-${status}`);
    assert.equal(spawned, false, status);
    assert.equal(contender?.status, "failed", status);
    assert.match(contender?.error ?? "", /is already owned by active task/, status);
    assert.equal(contender?.pipelineRun, null, status);
  }
});

test("different repository and slug identities may launch beside active pipeline tasks", async () => {
  const repoRoot = "/repo/distinct-pipeline-runs";
  const link = { provider: "ai-conductor" as const, repoRoot, slug: "target-run" };
  const registry = new Registry();
  registry.upsertTask(
    mkTask({
      id: "pipeline-other-repo",
      kind: "pipeline",
      repoRoot: "/repo/elsewhere",
      status: "running",
      pipelineRun: { ...link, repoRoot: "/repo/elsewhere" },
    }),
  );
  registry.upsertTask(
    mkTask({
      id: "pipeline-other-slug",
      kind: "pipeline",
      repoRoot,
      status: "dispatching",
      pipelineRun: { ...link, slug: "other-run" },
    }),
  );
  registry.upsertTask(
    mkTask({
      id: "pipeline-distinct-target",
      kind: "pipeline",
      repoRoot,
      intent: "Target run",
      title: "Target run",
    }),
  );
  let spawned = 0;
  const dispatcher = new Dispatcher(registry, undefined, {
    pipelineLaunch: async () => ({
      ok: true,
      launchRuntime: "terminal",
      cwd: repoRoot,
      argv: ["/bin/conduct-ts", "engineer", "--idea", "Target run"],
      pipelineRun: link,
    }),
    spawn: async () => {
      spawned += 1;
      return "Target run";
    },
  });

  await dispatcher.dispatch("pipeline-distinct-target");

  assert.equal(spawned, 1);
  assert.equal(registry.getTask("pipeline-distinct-target")?.status, "running");
  assert.deepEqual(registry.getTask("pipeline-distinct-target")?.pipelineRun, link);
});

function registerPipelineSdkHost(
  registry: Registry,
  taskId: string,
  link: { provider: "ai-conductor"; repoRoot: string; slug: string },
): string {
  const sessionId = `sdk:${taskId}`;
  registry.registerSdkSession({
    id: sessionId,
    agent: "claude",
    name: taskId,
    cwd: link.repoRoot,
    initialState: "idle",
    agentSessionId: `agent-${taskId}`,
    gitBranch: `feat/${link.slug}`,
    gitRoot: link.repoRoot,
    repoRoot: link.repoRoot,
  });
  registry.upsertTask(
    mkTask({
      id: taskId,
      kind: "pipeline",
      repoRoot: link.repoRoot,
      status: "running",
      sessionId,
      pipelineRun: link,
    }),
  );
  registry.bindTaskToWorkEpisode(taskId, sessionId);
  return sessionId;
}

test("idle and merged SDK host evidence cannot complete a provider-owned pipeline task", () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const link = {
    provider: "ai-conductor" as const,
    repoRoot: "/repo/provider-completion",
    slug: "provider-completion",
  };
  const sessionId = registerPipelineSdkHost(registry, "pipeline-provider-completion", link);
  const url = "https://github.com/example/repo/pull/42";

  registry.applyDriverEvent(sessionId, { kind: "pr_created", urls: [url] });
  registry.reconcilePrMerges(new Map([[url, Date.now()]]));
  tasks.reconcileMergedTasks();

  const task = registry.getTask("pipeline-provider-completion");
  assert.equal(task?.status, "running");
  assert.equal(task?.outcome, null);
  assert.equal(task?.outcomeUrl, null);
  assert.equal(task?.sessionId, sessionId);
});

test("an SDK host loss fails before its exact run exists and ignores a different run", () => {
  for (const projection of ["none", "different"] as const) {
    const registry = new Registry();
    new TaskManager(registry);
    const link = {
      provider: "ai-conductor" as const,
      repoRoot: `/repo/host-loss-${projection}`,
      slug: "expected-run",
    };
    const sessionId = registerPipelineSdkHost(registry, `pipeline-host-loss-${projection}`, link);
    if (projection === "different") {
      registry.initializePipelineRuns([{
        ...run(),
        repoRoot: link.repoRoot,
        slug: "different-run",
        group: "building",
        halt: null,
      }]);
    }

    registry.emit("event", { type: "session_remove", id: sessionId });

    const task = registry.getTask(`pipeline-host-loss-${projection}`);
    assert.equal(task?.status, "failed", projection);
    assert.equal(task?.sessionId, null, projection);
    assert.match(task?.error ?? "", /host ended before Conductor created pipeline run "expected-run"/, projection);
  }
});

test("an SDK host loss after the exact provider run appears clears only the stale host", () => {
  const registry = new Registry();
  new TaskManager(registry);
  const link = {
    provider: "ai-conductor" as const,
    repoRoot: "/repo/provider-took-over",
    slug: "provider-took-over",
  };
  const sessionId = registerPipelineSdkHost(registry, "pipeline-provider-took-over", link);
  registry.initializePipelineRuns([{
    ...run(),
    repoRoot: link.repoRoot,
    slug: link.slug,
    group: "building",
    halt: null,
  }]);

  registry.emit("event", { type: "session_remove", id: sessionId });

  const task = registry.getTask("pipeline-provider-took-over");
  assert.equal(task?.status, "running");
  assert.equal(task?.sessionId, null);
  assert.equal(task?.error, null);
  assert.deepEqual(task?.pipelineRun, link);
});

test("a processed projection settles an SDK-hosted task with the provider pull request", () => {
  const registry = new Registry();
  new TaskManager(registry);
  const link = {
    provider: "ai-conductor" as const,
    repoRoot: "/repo/sdk-processed",
    slug: "sdk-processed",
  };
  const sessionId = registerPipelineSdkHost(registry, "pipeline-sdk-processed", link);
  const prUrl = "https://github.com/example/sdk-processed/pull/51";

  registry.upsertPipelineRun({
    ...run(),
    repoRoot: link.repoRoot,
    slug: link.slug,
    group: "processed",
    halt: null,
    prUrl,
  });

  const task = registry.getTask("pipeline-sdk-processed");
  assert.equal(task?.status, "done");
  assert.equal(task?.outcomeUrl, prUrl);
  assert.equal(task?.sessionId, sessionId, "completion does not tear down the managed host");
});

test("cancelling a running SDK pipeline stops its managed host without a worktree", async () => {
  const registry = new Registry();
  const stopped: string[] = [];
  const supervisor = {
    handleFor: () => ({}),
    async stop(id: string) {
      stopped.push(id);
    },
    taskLiveness: () => true,
  } as unknown as SdkSupervisor;
  const tasks = new TaskManager(registry, undefined, supervisor);
  const link = {
    provider: "ai-conductor" as const,
    repoRoot: "/repo/cancel-running",
    slug: "cancel-running",
  };
  const sessionId = registerPipelineSdkHost(registry, "pipeline-cancel-running", link);

  const result = await tasks.cancel("pipeline-cancel-running");

  assert.equal(result.ok, true);
  assert.deepEqual(stopped, [sessionId]);
  assert.equal(registry.getTask("pipeline-cancel-running")?.status, "cancelled");
});

test("startup keeps a hostless SDK task when its exact provider run is active", () => {
  const registry = new Registry();
  const link = {
    provider: "ai-conductor" as const,
    repoRoot: "/repo/startup-provider",
    slug: "startup-provider",
  };
  registry.initializePipelineRuns([{
    ...run(),
    repoRoot: link.repoRoot,
    slug: link.slug,
    group: "building",
    halt: null,
  }]);
  registry.upsertTask(
    mkTask({
      id: "pipeline-startup-provider",
      kind: "pipeline",
      repoRoot: link.repoRoot,
      status: "running",
      sessionId: "sdk:gone-on-restart",
      pipelineRun: link,
    }),
  );
  new TaskManager(registry);

  registry.applyDiscovery([]);

  const task = registry.getTask("pipeline-startup-provider");
  assert.equal(task?.status, "running");
  assert.equal(task?.sessionId, null);
  assert.deepEqual(task?.pipelineRun, link);
});

test("the first discovery sweep preserves a managed SDK host that is still launching", () => {
  const registry = new Registry();
  const sessionId = "sdk:pending-managed-launch";
  new TaskManager(registry);
  registry.upsertTask(
    mkTask({
      id: "pipeline-pending-managed-launch",
      kind: "pipeline",
      repoRoot: "/repo/pending-managed-launch",
      status: "dispatching",
      sessionId,
      pipelineRun: {
        provider: "ai-conductor",
        repoRoot: "/repo/pending-managed-launch",
        slug: "pending-managed-launch",
      },
    }),
  );
  registry.beginManagedPipelineLaunch(
    "pipeline-pending-managed-launch",
    sessionId,
    "/repo/pending-managed-launch",
  );

  // The process table is authoritative for sessions that existed before boot, but this
  // SDK host has a reserved identity and has not reached supervisor registration yet.
  registry.applyDiscovery([]);

  const task = registry.getTask("pipeline-pending-managed-launch");
  assert.equal(task?.status, "dispatching");
  assert.equal(task?.sessionId, sessionId);
  assert.equal(task?.error, null);
});

test("a legacy pipeline child binds its durable run and the processed projection settles the task", () => {
  const registry = new Registry();
  new TaskManager(registry);
  const building: PipelineRun = {
    ...run(),
    halt: null,
    group: "building",
    steps: [{ name: "build", state: "in_progress" }],
  };
  registry.initializePipelineRuns([building]);
  registry.upsertTask(
    mkTask({
      id: "pipeline-lifecycle",
      kind: "pipeline",
      repoRoot: building.repoRoot,
      status: "running",
      homeName: "Pipeline lifecycle",
    }),
  );

  registry.applyDiscovery([{
    syntheticId: "pipeline-child",
    agent: "claude",
    name: "engineer",
    nameSource: "process",
    cwd: `${building.worktree}/src`,
    gitBranch: "feature/phase-six",
    pid: 42,
    tty: "ttys42",
    terminals: [mkMuxHandle({
      session: "pipeline-home-id",
      sessionName: "Pipeline lifecycle",
      paneId: "%42",
    })],
    startedAt: 1,
  } as DiscoveredSession]);

  const link = {
    provider: building.provider,
    repoRoot: building.repoRoot,
    slug: building.slug,
  };
  assert.deepEqual(registry.getTask("pipeline-lifecycle")?.pipelineRun, link);
  assert.deepEqual(getDurableTask("pipeline-lifecycle")?.pipelineRun, link);
  assert.equal(registry.getSession("pipeline-child")?.task?.id, "pipeline-lifecycle");
  assert.equal(registry.getSession("pipeline-child")?.task?.status, "running");

  const prUrl = "https://github.com/example/demo/pull/42";
  registry.upsertPipelineRun({
    ...building,
    group: "processed",
    steps: [{ name: "build", state: "done" }],
    prUrl,
    updatedAt: 2,
  });

  const settled = registry.getTask("pipeline-lifecycle");
  assert.equal(settled?.status, "done");
  assert.equal(settled?.outcomeUrl, prUrl);
  assert.equal(settled?.homeName, "Pipeline lifecycle", "cleanup ownership is retained");
  assert.equal(registry.getSession("pipeline-child")?.task?.status, "done");
});

test("strong Terminal proof refuses to replace a different unobserved reservation", () => {
  const registry = new Registry();
  new TaskManager(registry);
  const target: PipelineRun = {
    ...run(),
    slug: "terminal-existing-run",
    worktree: "/repo/demo/.worktrees/terminal-existing-run",
    halt: null,
    group: "building",
    steps: [{ name: "build", state: "in_progress" }],
  };
  const reservation = {
    provider: target.provider,
    repoRoot: target.repoRoot,
    slug: "terminal-unobserved-reservation",
  };
  registry.initializePipelineRuns([target]);
  registry.upsertTask(mkTask({
    id: "pipeline-terminal-adoption",
    kind: "pipeline",
    repoRoot: target.repoRoot,
    status: "running",
    homeName: "Terminal adoption",
    pipelineRun: reservation,
  }));

  registry.applyDiscovery([{
    syntheticId: "pipeline-terminal-adopter",
    agent: "claude",
    name: "engineer",
    nameSource: "process",
    cwd: `${target.worktree}/src`,
    gitBranch: "feature/terminal-existing-run",
    pid: 43,
    tty: "ttys43",
    terminals: [mkMuxHandle({
      session: "pipeline-terminal-home",
      sessionName: "Terminal adoption",
      paneId: "%43",
    })],
    startedAt: 1,
  } as DiscoveredSession]);

  assert.deepEqual({
    pipelineRun: registry.getTask("pipeline-terminal-adoption")?.pipelineRun,
    status: registry.getTask("pipeline-terminal-adoption")?.status,
  }, {
    pipelineRun: reservation,
    status: "running",
  });
});

test("a processed projection settles a prebound task without child-session discovery", () => {
  const registry = new Registry();
  new TaskManager(registry);
  const projected: PipelineRun = {
    ...run(),
    slug: "prebound-run",
    worktree: "/repo/demo/.worktrees/prebound-run",
    halt: null,
    group: "building",
    steps: [{ name: "build", state: "in_progress" }],
  };
  registry.upsertTask(
    mkTask({
      id: "pipeline-prebound",
      kind: "pipeline",
      repoRoot: projected.repoRoot,
      status: "running",
      homeName: "Prebound pipeline",
      pipelineRun: {
        provider: projected.provider,
        repoRoot: projected.repoRoot,
        slug: projected.slug,
      },
    }),
  );

  registry.upsertPipelineRun({
    ...projected,
    group: "processed",
    steps: [{ name: "finish", state: "done" }],
    lastStep: "finish",
    prUrl: "https://github.com/example/demo/pull/44",
    updatedAt: 2,
  });

  assert.equal(registry.getTask("pipeline-prebound")?.status, "done");
  assert.equal(
    registry.getTask("pipeline-prebound")?.outcomeUrl,
    "https://github.com/example/demo/pull/44",
  );
  assert.equal(registry.getTask("pipeline-prebound")?.sessionId, null);
  assert.equal(registry.getTask("pipeline-prebound")?.homeName, "Prebound pipeline");
});

function managedAdoptionFixture() {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const target: PipelineRun = {
    ...run(),
    slug: "existing-run",
    worktree: "/repo/demo/.worktrees/existing-run",
    halt: null,
    group: "building",
    steps: [{ name: "build", state: "in_progress" }],
    lastStep: "build",
  };
  const host = registry.registerSdkSession({
    id: "sdk:pipeline-adoption",
    agent: "codex",
    name: "Pipeline adoption host",
    cwd: target.repoRoot,
    agentSessionId: "codex-pipeline-adoption",
    gitBranch: null,
    gitRoot: target.repoRoot,
    repoRoot: target.repoRoot,
  });
  const reservation = {
    provider: target.provider,
    repoRoot: target.repoRoot,
    slug: "prompt-derived-reservation",
  };
  registry.upsertTask(mkTask({
    id: "pipeline-adoption",
    agent: "codex",
    kind: "pipeline",
    repoRoot: target.repoRoot,
    status: "running",
    sessionId: host.id,
    pipelineRun: reservation,
  }));
  return {
    registry,
    tasks,
    target,
    targetLink: {
      provider: target.provider,
      repoRoot: target.repoRoot,
      slug: target.slug,
    },
    host,
    reservation,
    task: registry.getTask("pipeline-adoption")!,
  };
}

test("a managed Pipeline host adopts an observed run without completing the task", () => {
  const { registry, tasks, target, targetLink, host, task } = managedAdoptionFixture();
  registry.initializePipelineRuns([target]);

  const adopted = tasks.adoptPipelineRun(task, targetLink, {
    kind: "managed",
    session: host,
  });

  assert.equal(adopted.ok, true);
  if (!adopted.ok) return;
  assert.equal(adopted.replayed, false);
  assert.deepEqual(adopted.task.pipelineRun, {
    provider: target.provider,
    repoRoot: target.repoRoot,
    slug: target.slug,
  });
  assert.equal(adopted.task.status, "running", "adoption is not completion authority");
  assert.equal(registry.getSession(host.id)?.pipeline, null, "the interactive host stays messageable");
  assert.deepEqual(registry.getSession(host.id)?.task?.pipelineRun, adopted.task.pipelineRun);
});

test("managed Pipeline adoption replays without changing the durable binding", () => {
  const { registry, tasks, target, targetLink, host, task } = managedAdoptionFixture();
  registry.initializePipelineRuns([target]);
  const first = tasks.adoptPipelineRun(task, targetLink, { kind: "managed", session: host });
  assert.equal(first.ok, true);
  const afterFirst = registry.getTask(task.id)!;

  const replayed = tasks.adoptPipelineRun(afterFirst, targetLink, {
    kind: "managed",
    session: registry.getSession(host.id)!,
  });
  assert.deepEqual(replayed.ok ? replayed.replayed : null, true);
  assert.deepEqual(registry.getTask(task.id)?.pipelineRun, targetLink);
});

test("only the processed provider projection settles an adopted Pipeline task", () => {
  const { registry, tasks, target, targetLink, host, task } = managedAdoptionFixture();
  registry.initializePipelineRuns([target]);
  const adopted = tasks.adoptPipelineRun(task, targetLink, { kind: "managed", session: host });
  assert.equal(adopted.ok, true);
  assert.equal(registry.getTask(task.id)?.status, "running");

  registry.upsertPipelineRun({
    ...target,
    group: "processed",
    steps: [{ name: "build", state: "done" }],
    updatedAt: 2,
  });
  assert.equal(registry.getTask(task.id)?.status, "done");
});

test("adopting an already-processed provider projection settles through the ordinary path", () => {
  const { registry, tasks, target, targetLink, host, task } = managedAdoptionFixture();
  registry.initializePipelineRuns([{
    ...target,
    group: "processed",
    steps: [{ name: "build", state: "done" }],
    prUrl: "https://github.com/example/demo/pull/77",
  }]);

  const adopted = tasks.adoptPipelineRun(task, targetLink, { kind: "managed", session: host });

  assert.equal(adopted.ok, true);
  assert.equal(registry.getTask(task.id)?.status, "done");
  assert.equal(registry.getTask(task.id)?.outcomeUrl, "https://github.com/example/demo/pull/77");
});

test("managed Pipeline adoption refuses an unobserved target", () => {
  const { registry, tasks, targetLink, host, task, reservation } = managedAdoptionFixture();
  const result = tasks.adoptPipelineRun(task, targetLink, { kind: "managed", session: host });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, 409);
  assert.deepEqual(registry.getTask(task.id)?.pipelineRun, reservation);
});

test("managed Pipeline adoption refuses replacing an observed reservation", () => {
  const { registry, tasks, target, targetLink, host, task, reservation } = managedAdoptionFixture();
  registry.initializePipelineRuns([
    target,
    { ...target, slug: reservation.slug, worktree: `/repo/demo/.worktrees/${reservation.slug}` },
  ]);
  const result = tasks.adoptPipelineRun(task, targetLink, { kind: "managed", session: host });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /already observed/);
  assert.deepEqual(registry.getTask(task.id)?.pipelineRun, reservation);
});

test("managed Pipeline adoption refuses a run owned by another active task", () => {
  const { registry, tasks, target, targetLink, host, task, reservation } = managedAdoptionFixture();
  registry.initializePipelineRuns([target]);
  registry.upsertTask(mkTask({
    id: "competing-owner",
    kind: "pipeline",
    repoRoot: target.repoRoot,
    status: "running",
    pipelineRun: targetLink,
  }));
  const result = tasks.adoptPipelineRun(task, targetLink, { kind: "managed", session: host });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /competing-owner/);
  assert.deepEqual(registry.getTask(task.id)?.pipelineRun, reservation);
});

test("managed Pipeline adoption refuses a different live SDK host", () => {
  const { registry, tasks, target, targetLink, task, reservation } = managedAdoptionFixture();
  registry.initializePipelineRuns([target]);
  const wrongHost = registry.registerSdkSession({
    id: "sdk:wrong-host",
    agent: "codex",
    name: "wrong host",
    cwd: target.repoRoot,
    agentSessionId: "codex-wrong-host",
    gitBranch: null,
    gitRoot: target.repoRoot,
    repoRoot: target.repoRoot,
  });
  const result = tasks.adoptPipelineRun(task, targetLink, {
    kind: "managed",
    session: wrongHost,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, 403);
  assert.deepEqual(registry.getTask(task.id)?.pipelineRun, reservation);
});

test("managed Pipeline adoption refuses stale, worker, non-Pipeline, and mismatched run identity", () => {
  for (const mode of ["exited", "worker", "non-pipeline", "provider", "repository"] as const) {
    const { registry, tasks, target, targetLink, host, task, reservation } = managedAdoptionFixture();
    registry.initializePipelineRuns([target]);
    let proof = host;
    let resolvedTask = task;
    let candidate = targetLink;

    if (mode === "exited") {
      registry.applyDriverEvent(host.id, { kind: "exited", reason: "done", resumable: false });
      proof = registry.getSession(host.id)!;
    } else if (mode === "worker") {
      registry.applyDiscovery([{
        syntheticId: "provider-worker-proof",
        agent: "claude",
        name: "provider worker",
        nameSource: "process",
        cwd: target.worktree,
        gitBranch: "feature/provider-worker",
        pid: 700,
        tty: "ttys700",
        terminals: [mkMuxHandle({
          session: "provider-worker-home",
          sessionName: "provider worker",
          paneId: "%700",
        })],
        startedAt: 1,
      } as DiscoveredSession]);
      proof = registry.getSession("provider-worker-proof")!;
      registry.upsertTask({
        ...registry.getTask(task.id)!,
        sessionId: proof.id,
        updatedAt: Date.now(),
      });
      resolvedTask = registry.getTask(task.id)!;
    } else if (mode === "non-pipeline") {
      registry.upsertTask({ ...task, kind: "chat", updatedAt: Date.now() });
      resolvedTask = registry.getTask(task.id)!;
    } else if (mode === "provider") {
      candidate = { ...targetLink, provider: "unsupported" as typeof targetLink.provider };
    } else {
      candidate = { ...targetLink, repoRoot: "/repo/another" };
    }

    const result = tasks.adoptPipelineRun(resolvedTask, candidate, {
      kind: "managed",
      session: proof,
    });

    assert.equal(result.ok, false, mode);
    assert.deepEqual(registry.getTask(task.id)?.pipelineRun, reservation, mode);
  }
});

test("a mismatched discovered child cannot reassign a prebound pipeline task", () => {
  const registry = new Registry();
  new TaskManager(registry);
  const expected: PipelineRun = {
    ...run(),
    slug: "expected-run",
    worktree: "/repo/demo/.worktrees/expected-run",
    halt: null,
    group: "building",
  };
  const mismatched: PipelineRun = {
    ...expected,
    slug: "mismatched-run",
    worktree: "/repo/demo/.worktrees/mismatched-run",
  };
  registry.initializePipelineRuns([expected, mismatched]);
  registry.upsertTask(
    mkTask({
      id: "pipeline-prebound-mismatch",
      kind: "pipeline",
      repoRoot: expected.repoRoot,
      status: "running",
      homeName: "Prebound mismatch",
      pipelineRun: {
        provider: expected.provider,
        repoRoot: expected.repoRoot,
        slug: expected.slug,
      },
    }),
  );

  registry.applyDiscovery([{
    syntheticId: "pipeline-mismatched-child",
    agent: "claude",
    name: "engineer",
    nameSource: "process",
    cwd: mismatched.worktree,
    gitBranch: "feature/mismatched-run",
    pid: 43,
    tty: "ttys43",
    terminals: [mkMuxHandle({
      session: "pipeline-mismatch-home-id",
      sessionName: "Prebound mismatch",
      paneId: "%43",
    })],
    startedAt: 1,
  } as DiscoveredSession]);

  assert.deepEqual(registry.getTask("pipeline-prebound-mismatch")?.pipelineRun, {
    provider: expected.provider,
    repoRoot: expected.repoRoot,
    slug: expected.slug,
  });

  registry.upsertPipelineRun({ ...mismatched, group: "processed", updatedAt: 2 });
  assert.equal(registry.getTask("pipeline-prebound-mismatch")?.status, "running");
  registry.upsertPipelineRun({ ...expected, group: "processed", updatedAt: 3 });
  assert.equal(registry.getTask("pipeline-prebound-mismatch")?.status, "done");
});

test("a boot-restored processed run settles a persisted pipeline task", () => {
  const persisted = new Registry();
  const projected: PipelineRun = {
    ...run(),
    slug: "restored-run",
    halt: null,
    group: "processed",
    steps: [{ name: "ship", state: "done" }],
    lastStep: "ship",
    prUrl: "https://github.com/example/demo/pull/43",
  };
  persisted.upsertTask(
    mkTask({
      id: "pipeline-restored",
      kind: "pipeline",
      repoRoot: projected.repoRoot,
      status: "running",
      pipelineRun: {
        provider: projected.provider,
        repoRoot: projected.repoRoot,
        slug: projected.slug,
      },
    }),
  );

  const restarted = new Registry();
  new TaskManager(restarted);
  restarted.initializePipelineRuns([projected]);

  assert.equal(restarted.getTask("pipeline-restored")?.status, "done");
  assert.equal(restarted.getTask("pipeline-restored")?.outcomeUrl, projected.prUrl);
});

test("only the exact mechanical halt class is automatable", () => {
  for (const haltClass of PIPELINE_HALT_CLASSES) {
    assert.equal(
      pipelineAutomationAction(haltClass),
      haltClass === "mechanical" ? "unpark" : null,
      haltClass,
    );
  }
  assert.equal(pipelineAutomationAction("future-class"), null, "new classes fail closed");
  assert.equal(pipelineAutomationAction(null), null);
});

test("pipeline triage stamps the episode before one mechanical action", async () => {
  const calls: string[] = [];
  const episodes: RecordEpisode[] = [];
  const pipeline = run();
  const client: PipelineTriageActions = {
    pipelineForeman: async () => ({
      enabled: true,
      items: [{ run: pipeline, marker: "halt-1", handled: false }],
    }),
    recordPipelineEpisode: async (_run, episode) => {
      calls.push(`episode:${episode.disposition}`);
      episodes.push(episode);
    },
    pipelineAction: async (_run, action): Promise<PipelineActionResult> => {
      calls.push(`action:${action}`);
      return { ok: true, action, command: "conduct-ts unpark phase-six", detail: "unparked", output: "" };
    },
  };

  assert.equal(await runPipelineTriage(client), true);
  assert.deepEqual(calls, ["episode:pending", "action:unpark", "episode:answered"]);
  assert.equal(episodes[0]?.surface, "pipeline");
  assert.equal(episodes[0]?.classification, "mechanical");
});

test("needs-human and every other non-mechanical halt never reach an action route", async () => {
  const acted: string[] = [];
  const items = PIPELINE_HALT_CLASSES.filter((value) => value !== "mechanical").map(
    (haltClass, index) => ({ run: run(haltClass), marker: `halt-${index}`, handled: false }),
  );
  const client: PipelineTriageActions = {
    pipelineForeman: async () => ({ enabled: true, items }),
    recordPipelineEpisode: async () => {
      assert.fail("a non-mechanical halt must not be reserved as an action");
    },
    pipelineAction: async (_run, action) => {
      acted.push(action);
      throw new Error("unreachable");
    },
  };

  assert.equal(await runPipelineTriage(client), false);
  assert.deepEqual(acted, []);
});
