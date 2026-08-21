import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PIPELINE_HALT_CLASSES,
  type PipelineActionResult,
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
import { getTask as getDurableTask } from "../src/server/db.ts";
import { setPipelinesConfig } from "../src/server/pipelines/config.ts";
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
        id: `sdk:pipeline-${starts.length}`,
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
  const dispatcher = new Dispatcher(registry, async () => assert.fail("no worktree is owned"), {
    supervisor,
    missionMcpDescriptor: async () => mcp,
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
  assert.deepEqual(supervisor.starts, [{
    agent: "codex",
    name: "Build the SDK path",
    cwd: "/repo/sdk",
    prompt: "$engineer - run this skill now. Build the SDK path\nwithout changing the daemon",
    acceptedGoalPrompt: "Build the SDK path\nwithout changing the daemon",
    model: null,
    effort: null,
    permissionMode: "approveForMe",
    mcp,
    extraDirs: [],
    taskId: "pipeline-sdk",
    gitBranch: null,
    gitRoot: "/repo/sdk",
    repoRoot: "/repo/sdk",
  }]);
  const task = registry.getTask("pipeline-sdk");
  assert.equal(task?.status, "running");
  assert.equal(task?.sessionId, "sdk:pipeline-1");
  assert.equal(task?.homeName, null);
  assert.equal(task?.worktreePath, null);
  assert.deepEqual(task?.extraRepos, []);
  assert.deepEqual(task?.pipelineRun, link);
  assert.equal(registry.workEpisodeForTask("pipeline-sdk")?.sessionId, "sdk:pipeline-1");
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
      missionMcpDescriptor: async () => null,
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
  const supervisor = {
    start: () => new Promise<Session>((resolve) => {
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
    missionMcpDescriptor: async () => null,
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
    id: "sdk:pipeline-cancelled",
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

test("an unreadable provider key space refuses before the terminal host starts", async (t) => {
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
    spawn: async () => {
      spawned = true;
      return "unreachable";
    },
  });

  await dispatcher.dispatch("pipeline-unreadable");

  assert.equal(spawned, false);
  assert.equal(registry.getTask("pipeline-unreadable")?.status, "failed");
  assert.match(registry.getTask("pipeline-unreadable")?.error ?? "", /could not read current pipeline runs/);
  assert.equal(registry.getTask("pipeline-unreadable")?.pipelineRun, null);
});

test("an existing provider worktree refuses the same run before terminal spawn", async (t) => {
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
    /pipeline run "existing-provider-worktree" already exists/,
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
    cwd: building.worktree,
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
