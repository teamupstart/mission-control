import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "mission-retro-followup-"));
process.env.MISSION_HOME = home;

const {
  bindTaskWorkEpisode,
  markWorkEpisodeMerged,
  recordWorkEpisodeRepoPr,
  retroFollowupForSource,
  retroFollowupForTask,
  retroPrPostureForTask,
  reserveRetroFollowup,
} = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { RETRO_NO_CHANGE_OUTCOME, TaskManager } = await import("../src/server/tasks.ts");
const { mkTask } = await import("./helpers/session-fixture.ts");

after(() => rmSync(home, { recursive: true, force: true }));

function binding(over: {
  taskId: string;
  episodeId: string;
  sessionId: string;
  prUrl: string | null;
  mergedAt: number | null;
}) {
  return {
    ...over,
    agentSessionId: `agent:${over.sessionId}`,
    branch: `feature/${over.episodeId}`,
    prHeadSha: over.prUrl ? "a".repeat(40) : null,
    boundAt: 100,
    updatedAt: over.mergedAt ?? 100,
  };
}

test("retro posture prefers a current open review over a historical merge", () => {
  const taskId = "retro-posture-source";
  const old = binding({
    taskId,
    episodeId: "episode-merged",
    sessionId: "session-merged",
    prUrl: "https://github.example/o/r/pull/1",
    mergedAt: 1_000,
  });
  bindTaskWorkEpisode(old);
  const current = binding({
    taskId,
    episodeId: "episode-open",
    sessionId: "session-open",
    prUrl: "https://github.example/o/r/pull/2",
    mergedAt: null,
  });
  bindTaskWorkEpisode(current);

  assert.deepEqual(retroPrPostureForTask(taskId), { kind: "open", binding: current });

  const mergedCurrent = { ...current, mergedAt: 2_000, updatedAt: 2_000 };
  bindTaskWorkEpisode(mergedCurrent);
  assert.deepEqual(retroPrPostureForTask(taskId), {
    kind: "merged",
    binding: mergedCurrent,
    prUrl: mergedCurrent.prUrl,
    mergedAt: mergedCurrent.mergedAt,
  });
});

test("retro posture follows a merged attached-repository review when the primary had none", () => {
  const taskId = "retro-secondary-posture-source";
  const current = binding({
    taskId,
    episodeId: "episode-secondary-only",
    sessionId: "session-secondary-only",
    prUrl: null,
    mergedAt: null,
  });
  bindTaskWorkEpisode(current);
  const secondaryUrl = "https://github.example/o/secondary/pull/3";
  recordWorkEpisodeRepoPr({
    episodeId: current.episodeId,
    repoRoot: "/repos/secondary-only",
    sessionId: current.sessionId,
    taskId,
    prUrl: secondaryUrl,
    prState: "open",
    prHeadSha: "b".repeat(40),
  }, 2_000);

  assert.deepEqual(retroPrPostureForTask(taskId), { kind: "open", binding: current });
  assert.equal(
    markWorkEpisodeMerged(current.sessionId, current.episodeId, secondaryUrl, 3_000),
    true,
  );
  assert.deepEqual(retroPrPostureForTask(taskId), {
    kind: "merged",
    binding: current,
    prUrl: secondaryUrl,
    mergedAt: 3_000,
  });
});

test("a source task and episode reserve exactly one durable retro task id", () => {
  const first = reserveRetroFollowup({
    sourceTaskId: "reservation-source",
    sourceEpisodeId: "reservation-episode",
    sourceSessionId: "reservation-session",
    retroTaskId: "retro-reserved-first",
    now: 1_000,
  });
  const replay = reserveRetroFollowup({
    sourceTaskId: "reservation-source",
    sourceEpisodeId: "reservation-episode",
    sourceSessionId: "another-session",
    retroTaskId: "retro-reserved-second",
    now: 2_000,
  });

  assert.equal(first.created, true);
  assert.equal(replay.created, false);
  assert.equal(replay.relation.retroTaskId, "retro-reserved-first");
  assert.deepEqual(
    retroFollowupForTask("retro-reserved-first"),
    retroFollowupForSource("reservation-source", "reservation-episode"),
  );
  assert.equal(retroFollowupForTask("retro-reserved-second"), null);
});

test("follow-up creation is idempotent and copies the exact source repository set", () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const source = mkTask({
    id: "copy-source",
    title: "Ship across repos",
    status: "done",
    outcome: "merged source work",
    repoRoot: "/repos/primary",
    extraRepos: [
      {
        repoRoot: "/repos/secondary",
        worktreePath: "/old/secondary",
        branch: "old-branch",
        provider: "git",
        worktreeLeaseId: null,
        baseSha: "b".repeat(40),
        prUrl: "https://github.example/o/secondary/pull/4",
        prState: "merged",
        mergedAt: 1_000,
      },
    ],
  });
  registry.upsertTask(source);
  const input = {
    sourceTask: source,
    sourceEpisodeId: "copy-episode",
    sourceSessionId: "copy-session",
    title: "Retro: Ship across repos",
    intent: "Run the linked retro",
    agent: "claude" as const,
  };

  const first = tasks.createRetroFollowup(input);
  const replay = tasks.createRetroFollowup(input);

  assert.equal(replay.id, first.id);
  assert.deepEqual([first.repoRoot, ...first.extraRepos.map((repo) => repo.repoRoot)], [
    "/repos/primary",
    "/repos/secondary",
  ]);
  assert.equal(first.worktreePath, null);
  assert.equal(first.extraRepos[0]?.worktreePath, null);
  assert.equal(first.extraRepos[0]?.prUrl, null);
  assert.equal(registry.getTask(source.id)?.status, "done", "the source is never reopened");
  assert.equal(tasks.list().filter((task) => task.id === first.id).length, 1);
});

test("a source merge cannot settle its retro, but the retro's own merge can", () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const source = mkTask({ id: "merge-source", title: "Merged source", status: "done" });
  registry.upsertTask(source);
  const retro = tasks.createRetroFollowup({
    sourceTask: source,
    sourceEpisodeId: "merge-source-episode",
    sourceSessionId: "merge-source-session",
    title: "Retro: Merged source",
    intent: "Run the linked retro",
    agent: "claude",
  });
  registry.upsertTask({ ...retro, status: "running", updatedAt: 2_000 });

  bindTaskWorkEpisode(binding({
    taskId: source.id,
    episodeId: "merge-source-episode",
    sessionId: "merge-source-session",
    prUrl: "https://github.example/o/r/pull/10",
    mergedAt: 1_000,
  }));
  tasks.reconcileMergedTasks();
  assert.equal(registry.getTask(retro.id)?.status, "running");

  registry.upsertTask({
    ...registry.getTask(retro.id)!,
    status: "failed",
    error: "agent exited after opening review",
    updatedAt: 2_500,
  });
  bindTaskWorkEpisode(binding({
    taskId: retro.id,
    episodeId: "merge-retro-episode",
    sessionId: "merge-retro-session",
    prUrl: "https://github.example/o/r/pull/11",
    mergedAt: 3_000,
  }));
  tasks.reconcileMergedTasks();
  assert.equal(registry.getTask(retro.id)?.status, "done");
  assert.equal(registry.getTask(retro.id)?.outcomeUrl, "https://github.example/o/r/pull/11");
  assert.equal(registry.getTask(source.id)?.status, "done");
});

test("a multi-repository retro completes only after every changed retro review merges", () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const source = mkTask({
    id: "multi-merge-source",
    title: "Multi-repo source",
    status: "done",
    repoRoot: "/repos/multi-primary",
    extraRepos: [{
      repoRoot: "/repos/multi-secondary",
      worktreePath: "/old/secondary",
      branch: "old-source",
      provider: "git",
      worktreeLeaseId: null,
      baseSha: "d".repeat(40),
      prUrl: "https://github.example/o/secondary/pull/30",
      prState: "merged",
      mergedAt: 1_000,
    }],
  });
  registry.upsertTask(source);
  const retro = tasks.createRetroFollowup({
    sourceTask: source,
    sourceEpisodeId: "multi-source-episode",
    sourceSessionId: "multi-source-session",
    title: "Retro: Multi-repo source",
    intent: "Run the linked multi-repo retro",
    agent: "claude",
  });
  registry.upsertTask({
    ...retro,
    status: "failed",
    error: "agent exited after opening reviews",
    worktreePath: "/retro/primary",
    branch: "retro-memory",
    extraRepos: retro.extraRepos.map((repo) => ({
      ...repo,
      worktreePath: "/retro/secondary",
      branch: "retro-memory",
    })),
  });
  const episodeId = "multi-retro-episode";
  const sessionId = "multi-retro-session";
  const primaryUrl = "https://github.example/o/primary/pull/31";
  const secondaryUrl = "https://github.example/o/secondary/pull/32";
  bindTaskWorkEpisode(binding({
    taskId: retro.id,
    episodeId,
    sessionId,
    prUrl: primaryUrl,
    mergedAt: null,
  }));
  recordWorkEpisodeRepoPr({
    episodeId,
    repoRoot: "/repos/multi-secondary",
    sessionId,
    taskId: retro.id,
    prUrl: secondaryUrl,
    prState: "open",
    prHeadSha: "e".repeat(40),
  }, 2_000);

  registry.reconcilePrMerges(new Map([[primaryUrl, 3_000]]));
  assert.equal(registry.getTask(retro.id)?.status, "failed", "the sibling review still holds it");

  registry.reconcilePrMerges(new Map([[secondaryUrl, 4_000]]));
  assert.equal(registry.getTask(retro.id)?.status, "done");
  assert.match(registry.getTask(retro.id)?.outcome ?? "", /pull\/31/);
  assert.match(registry.getTask(retro.id)?.outcome ?? "", /pull\/32/);
  assert.equal(registry.getTask(source.id)?.status, "done");
});

test("no-change completion settles only the attributed retro and is replay-safe", async () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const source = mkTask({
    id: "no-change-source",
    title: "Original work",
    status: "done",
    outcome: "merged original",
    outcomeUrl: "https://github.example/o/r/pull/20",
  });
  registry.upsertTask(source);
  const retro = tasks.createRetroFollowup({
    sourceTask: source,
    sourceEpisodeId: "no-change-source-episode",
    sourceSessionId: "no-change-source-session",
    title: "Retro: Original work",
    intent: "Run the linked retro",
    agent: "claude",
  });
  const dependent = tasks.create({
    repoRoot: "/repo",
    title: "Must still wait",
    intent: "Wait for a merged dependency",
    kind: "ship",
    agent: "claude",
    backlog: true,
    dependencies: [{ type: "task", taskId: retro.id }],
  });
  const running = {
    ...retro,
    status: "running" as const,
    worktreePath: "/worktrees/no-change-retro",
    sessionId: "sdk:no-change-retro",
    updatedAt: 4_000,
  };
  registry.upsertTask(running);
  registry.registerSdkSession({
    id: running.sessionId,
    agent: "claude",
    name: "no change retro",
    cwd: running.worktreePath,
    agentSessionId: "agent:no-change-retro",
  });

  const first = await tasks.completeRetroNoChange(running.sessionId, running.worktreePath);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.replayed, false);
  assert.equal(first.task.outcome, RETRO_NO_CHANGE_OUTCOME);
  assert.equal(first.task.outcomeUrl, null);
  assert.equal(registry.getTask(source.id)?.status, "done");
  assert.equal(registry.getTask(source.id)?.outcome, "merged original");
  assert.equal(
    registry.getTask(dependent.id)?.dependencies[0]?.satisfiedAt,
    null,
    "no-change settlement does not satisfy declared dependencies",
  );

  const replay = await tasks.completeRetroNoChange(running.sessionId, running.worktreePath);
  assert.equal(replay.ok, true);
  if (!replay.ok) return;
  assert.equal(replay.replayed, true);
  assert.equal(replay.task.completedAt, first.task.completedAt);
});

test("no-change completion refuses an ordinary task attributed to the caller", async () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const ordinary = mkTask({
    id: "ordinary-task",
    status: "running",
    worktreePath: "/worktrees/ordinary",
    sessionId: "sdk:ordinary",
  });
  registry.upsertTask(ordinary);
  registry.registerSdkSession({
    id: ordinary.sessionId!,
    agent: "claude",
    name: "ordinary task",
    cwd: ordinary.worktreePath!,
    agentSessionId: "agent:ordinary",
  });

  const result = await tasks.completeRetroNoChange(ordinary.sessionId!, ordinary.worktreePath);
  assert.deepEqual(result, {
    ok: false,
    status: 409,
    error: "this session is not running a post-merge retro follow-up task",
  });
  assert.equal(registry.getTask(ordinary.id)?.status, "running");
});
