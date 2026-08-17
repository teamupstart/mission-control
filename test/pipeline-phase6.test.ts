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
import { setPipelinesConfig } from "../src/server/pipelines/config.ts";
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
  const link = {
    provider: "ai-conductor" as const,
    repoRoot: "/repo/demo",
    slug: "run-conductor-from-mission-control",
  };
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
