import test from "node:test";
import assert from "node:assert/strict";

import {
  PIPELINE_HALT_CLASSES,
  type PipelineActionResult,
  type PipelineRun,
} from "../src/shared/pipeline.ts";
import { conductorEngineerArgv } from "../src/server/pipelines/conductor/index.ts";
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
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import { mkMuxHandle, mkTask } from "./helpers/session-fixture.ts";

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
  const dispatcher = new Dispatcher(registry, async () => assert.fail("no worktree is owned"), {
    pipelineLaunch: async () => ({
      ok: true,
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
    }),
    spawn: async (...args) => {
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
});

test("a pipeline child binds its durable run and the processed projection settles the task", () => {
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
