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
import { mkTask } from "./helpers/session-fixture.ts";

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
