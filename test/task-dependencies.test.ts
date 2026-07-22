import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask as baseTask } from "./helpers/session-fixture.ts";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { PrMatch } from "../src/server/registry.ts";

const home = mkdtempSync(join(tmpdir(), "mission-task-dependencies-"));
process.env.HARNESS_HOME = home;
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { DependencyPrPollState, pollAndReconcilePrs } = await import("../src/server/pr.ts");

after(() => rmSync(home, { recursive: true, force: true }));

const createInput = {
  repoRoot: "/repo",
  intent: "do the dependent work",
  title: "Dependent work",
  kind: "ship" as const,
  agent: "claude" as const,
  backlog: false,
};

function discovered(
  id: string,
  cwd: string,
  over: Partial<DiscoveredSession> = {},
): DiscoveredSession {
  return {
    syntheticId: id,
    agent: "claude",
    name: `agent-${id}`,
    nameSource: "process",
    cwd,
    gitBranch: "feat/dependency",
    gitRoot: "/repo",
    repoRoot: "/repo",
    nomistakesGated: false,
    pid: 100,
    tty: null,
    terminals: [],
    startedAt: 0,
    ...over,
  };
}

function prMatch(over: Partial<PrMatch> = {}): PrMatch {
  const match: PrMatch = {
    url: "https://github.com/example/repo/pull/1",
    number: 1,
    state: "open",
    checks: "passing",
    branch: "feat/dependency",
    agentSessionId: null,
    episodeId: null,
    createdAt: null,
    mergedAt: null,
    headSha: "current-head",
    worktreeHeadSha: "current-head",
    ...over,
  };
  if (match.state === "merged" && match.mergedAt === null) match.mergedAt = Date.now();
  return match;
}

test("an unmet dependency forces a dispatch-now create into the backlog and blocks later dispatch", async () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  registry.upsertTask(baseTask({ id: "force-pre", title: "Merge the foundation" }));

  const dependent = tasks.create({
    ...createInput,
    dependencies: [{ type: "task", taskId: "force-pre" }],
  });

  assert.equal(dependent.status, "backlog");
  assert.deepEqual(dependent.dependencies, [
    {
      type: "task",
      taskId: "force-pre",
      title: "Merge the foundation",
      selectedAt: dependent.dependencies[0]?.selectedAt,
      satisfiedAt: null,
    },
  ]);
  assert.equal(typeof dependent.dependencies[0]?.selectedAt, "number");
  await tasks.dispatch(dependent.id);
  assert.equal(registry.getTask(dependent.id)?.status, "backlog");
});

test("drag-to-assign refuses a declared blocker before touching the destination session", async () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  registry.upsertTask(baseTask({ id: "assign-pre", title: "Schema PR" }));
  const dependent = tasks.create({
    ...createInput,
    backlog: true,
    dependencies: [{ type: "task", taskId: "assign-pre" }],
  });

  const result = await tasks.assign(dependent.id, "does-not-matter");
  assert.equal(result.ok, false);
  assert.equal(result.scope, "task");
  assert.match(result.error ?? "", /Schema PR/);
});

test("a merged PR durably satisfies dependencies selected through an active task session", () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  registry.upsertTask(
    baseTask({
      id: "merge-pre",
      title: "Land the schema",
      status: "running",
      worktreePath: "/wt/merge-pre",
    }),
  );
  registry.applyDiscovery([discovered("merge-session", "/wt/merge-pre")]);
  registry.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: "merge-episode",
    cwd: "/wt/merge-pre",
    transcriptPath: null,
    env: {},
  });
  registry.upsertTask({
    ...registry.getTask("merge-pre")!,
    sessionId: "merge-session",
  });
  registry.bindTaskToWorkEpisode("merge-pre", "merge-session");
  const mergeEpisode = registry.workEpisodeForSession("merge-session")!;
  const dependent = tasks.create({
    ...createInput,
    backlog: true,
    dependencies: [{ type: "session", sessionId: "merge-session" }],
  });
  assert.equal(dependent.dependencies[0]?.type, "task", "task-backed sessions normalize to task edges");
  assert.equal(dependent.dependencies[0]?.satisfiedAt, null);

  registry.reconcilePrs(
    new Map([
      [
        "merge-session",
        prMatch({
          url: "https://github.com/example/repo/pull/1",
          number: 1,
          state: "merged" as const,
          checks: "passing" as const,
          agentSessionId: "merge-episode",
          episodeId: mergeEpisode.episodeId,
          createdAt: mergeEpisode.startedAt,
        }),
      ],
    ]),
    new Set(),
  );

  assert.ok(registry.getTask(dependent.id)?.dependencies[0]?.satisfiedAt);
  assert.deepEqual(tasks.dependencyBlockers(registry.getTask(dependent.id)!), []);
});

test("a satisfied standalone-session dependency stays satisfied after its PR chip clears and the task is edited", async () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  registry.applyDiscovery([discovered("standalone-session", "/repo")]);
  registry.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: "standalone-episode",
    cwd: "/repo",
    transcriptPath: null,
    env: {},
  });
  const standaloneEpisode = registry.workEpisodeForSession("standalone-session")!;
  const dependent = tasks.create({
    ...createInput,
    backlog: true,
    dependencies: [{ type: "session", sessionId: "standalone-session" }],
  });

  registry.reconcilePrs(
    new Map([
      [
        "standalone-session",
        prMatch({
          url: "https://github.com/example/repo/pull/2",
          number: 2,
          state: "merged" as const,
          checks: "passing" as const,
          agentSessionId: "standalone-episode",
          episodeId: standaloneEpisode.episodeId,
          createdAt: standaloneEpisode.startedAt,
        }),
      ],
    ]),
    new Set(),
  );
  const satisfiedAt = registry.getTask(dependent.id)?.dependencies[0]?.satisfiedAt;
  assert.ok(satisfiedAt);

  registry.reconcilePrs(new Map(), new Set());
  const updated = await tasks.update(dependent.id, {
    dependencies: [{ type: "session", sessionId: "standalone-session" }],
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.task?.dependencies[0]?.satisfiedAt, satisfiedAt);
});

test("new work after a merge starts a dependency episode on the same session and branch", () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const id = "same-session-new-work";
  const cwd = "/repo/same-session-new-work";
  registry.applyDiscovery([discovered(id, cwd, { gitBranch: "feat/reused-work" })]);
  registry.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: "same-conversation",
    cwd,
    transcriptPath: null,
    env: {},
  });
  const completedEpisode = registry.workEpisodeForSession(id)!;
  const completedDependent = tasks.create({
    ...createInput,
    title: "Wait for completed work",
    backlog: true,
    dependencies: [{ type: "session", sessionId: id }],
  });
  registry.reconcilePrs(
    new Map([
      [
        id,
        prMatch({
          url: "https://github.com/example/repo/pull/80",
          number: 80,
          state: "merged",
          branch: "feat/reused-work",
          agentSessionId: "same-conversation",
          episodeId: completedEpisode.episodeId,
          createdAt: completedEpisode.startedAt,
        }),
      ],
    ]),
    new Set(),
  );
  assert.ok(registry.getTask(completedDependent.id)?.dependencies[0]?.satisfiedAt);
  const mergedAt = registry.workEpisodeForSession(id)!.mergedAt!;

  registry.applyHook({
    agent: "claude",
    event: "UserPromptSubmit",
    sessionId: "same-conversation",
    cwd,
    transcriptPath: null,
    env: {},
    prompt: "start the follow-up implementation",
    ts: mergedAt,
  });
  const nextEpisode = registry.workEpisodeForSession(id)!;
  assert.notEqual(nextEpisode.episodeId, completedEpisode.episodeId);
  assert.equal(nextEpisode.mergedAt, null);

  const nextDependent = tasks.create({
    ...createInput,
    title: "Wait for follow-up work",
    backlog: true,
    dependencies: [{ type: "session", sessionId: id }],
  });
  const edge = nextDependent.dependencies[0];
  assert.equal(edge?.type === "session" ? edge.episodeId : null, nextEpisode.episodeId);
  assert.equal(edge?.type === "session" ? edge.prUrl : null, null);
  assert.equal(edge?.satisfiedAt, null);
  assert.equal(tasks.dependencyBlockers(nextDependent).length, 1);
});

test("a delayed merge satisfies pre-prompt edges and rebinds post-prompt edges", async () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const id = "merge-prompt-race";
  const cwd = "/repo/merge-prompt-race";
  const url = "https://github.com/example/repo/pull/83";
  registry.applyDiscovery([discovered(id, cwd, { gitBranch: "feat/merge-prompt-race" })]);
  registry.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: "merge-prompt-race-episode",
    cwd,
    transcriptPath: null,
    env: {},
  });
  const originalEpisode = registry.workEpisodeForSession(id)!;
  registry.reconcilePrs(
    new Map([[id, prMatch({
      url,
      number: 83,
      branch: "feat/merge-prompt-race",
      agentSessionId: "merge-prompt-race-episode",
      episodeId: originalEpisode.episodeId,
      createdAt: originalEpisode.startedAt,
    })]]),
    new Set(),
  );
  const beforePrompt = tasks.create({
    ...createInput,
    title: "Wait for work selected before the raced prompt",
    backlog: true,
    dependencies: [{ type: "session", sessionId: id }],
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 2));
  const promptAt = Date.now();
  registry.applyHook({
    agent: "claude",
    event: "UserPromptSubmit",
    sessionId: "merge-prompt-race-episode",
    cwd,
    transcriptPath: null,
    env: {},
    prompt: "begin the follow-up",
    ts: promptAt,
  });
  const afterPrompt = tasks.create({
    ...createInput,
    title: "Wait for the follow-up after the raced merge",
    backlog: true,
    dependencies: [{ type: "session", sessionId: id }],
  });
  assert.equal(
    afterPrompt.dependencies[0]?.type === "session" ? afterPrompt.dependencies[0].prUrl : null,
    url,
  );

  registry.reconcilePrs(
    new Map([[id, prMatch({
      url,
      number: 83,
      state: "merged",
      branch: "feat/merge-prompt-race",
      agentSessionId: "merge-prompt-race-episode",
      episodeId: originalEpisode.episodeId,
      createdAt: originalEpisode.startedAt,
      mergedAt: promptAt - 1,
    })]]),
    new Set(),
  );

  const nextEpisode = registry.workEpisodeForSession(id)!;
  const beforeEdge = registry.getTask(beforePrompt.id)?.dependencies[0];
  const afterEdge = registry.getTask(afterPrompt.id)?.dependencies[0];
  assert.ok((beforeEdge?.selectedAt ?? promptAt) < promptAt);
  assert.ok((afterEdge?.selectedAt ?? promptAt - 1) >= promptAt);
  assert.notEqual(nextEpisode.episodeId, originalEpisode.episodeId);
  assert.equal(nextEpisode.startedAt, promptAt);
  assert.equal(
    beforeEdge?.type === "session" ? beforeEdge.episodeId : null,
    originalEpisode.episodeId,
  );
  assert.equal(beforeEdge?.type === "session" ? beforeEdge.prUrl : null, url);
  assert.equal(beforeEdge?.satisfiedAt, promptAt - 1);
  assert.equal(
    afterEdge?.type === "session" ? afterEdge.episodeId : null,
    nextEpisode.episodeId,
  );
  assert.equal(afterEdge?.type === "session" ? afterEdge.prUrl : null, null);
  assert.equal(afterEdge?.satisfiedAt, null);
  assert.equal(registry.getSession(id)?.prUrl, null);
  assert.deepEqual(tasks.dependencyBlockers(registry.getTask(beforePrompt.id)!), []);
  assert.equal(tasks.dependencyBlockers(registry.getTask(afterPrompt.id)!).length, 1);
});

test("persisted merge reconciliation preserves prompt ordering after session exit", async () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const id = "exited-merge-prompt-race";
  const cwd = "/repo/exited-merge-prompt-race";
  const url = "https://github.com/example/repo/pull/85";
  registry.applyDiscovery([discovered(id, cwd, { gitBranch: "feat/exited-merge-prompt-race" })]);
  registry.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: "exited-merge-prompt-race-episode",
    cwd,
    transcriptPath: null,
    env: {},
  });
  const originalEpisode = registry.workEpisodeForSession(id)!;
  registry.reconcilePrs(
    new Map([[id, prMatch({
      url,
      number: 85,
      branch: "feat/exited-merge-prompt-race",
      agentSessionId: "exited-merge-prompt-race-episode",
      episodeId: originalEpisode.episodeId,
      createdAt: originalEpisode.startedAt,
    })]]),
    new Set(),
  );
  const beforePrompt = tasks.create({
    ...createInput,
    title: "Wait for exited work selected before the prompt",
    backlog: true,
    dependencies: [{ type: "session", sessionId: id }],
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 2));
  const promptAt = Date.now();
  registry.applyHook({
    agent: "claude",
    event: "UserPromptSubmit",
    sessionId: "exited-merge-prompt-race-episode",
    cwd,
    transcriptPath: null,
    env: {},
    prompt: "continue after the pending merge",
    ts: promptAt,
  });
  const afterPrompt = tasks.create({
    ...createInput,
    title: "Wait for exited follow-up work",
    backlog: true,
    dependencies: [{ type: "session", sessionId: id }],
  });
  registry.applyDiscovery([]);

  await pollAndReconcilePrs(
    registry,
    async () => null,
    async (candidate) =>
      candidate === url ? { state: "merged", mergedAt: promptAt - 1 } : null,
  );

  const nextEpisode = registry.workEpisodeForSession(id)!;
  const beforeEdge = registry.getTask(beforePrompt.id)?.dependencies[0];
  const afterEdge = registry.getTask(afterPrompt.id)?.dependencies[0];
  assert.ok((beforeEdge?.selectedAt ?? promptAt) < promptAt);
  assert.ok((afterEdge?.selectedAt ?? promptAt - 1) >= promptAt);
  assert.notEqual(nextEpisode.episodeId, originalEpisode.episodeId);
  assert.equal(nextEpisode.startedAt, promptAt);
  assert.equal(
    beforeEdge?.type === "session" ? beforeEdge.episodeId : null,
    originalEpisode.episodeId,
  );
  assert.equal(beforeEdge?.satisfiedAt, promptAt - 1);
  assert.equal(
    afterEdge?.type === "session" ? afterEdge.episodeId : null,
    nextEpisode.episodeId,
  );
  assert.equal(afterEdge?.type === "session" ? afterEdge.prUrl : null, null);
  assert.equal(afterEdge?.satisfiedAt, null);
  assert.deepEqual(tasks.dependencyBlockers(registry.getTask(beforePrompt.id)!), []);
  assert.equal(tasks.dependencyBlockers(registry.getTask(afterPrompt.id)!).length, 1);
});

test("post-merge episode rollover preserves running task ownership", () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const id = "owned-rollover";
  const cwd = "/repo/owned-rollover";
  registry.upsertTask(baseTask({
    id: "owned-rollover-task",
    title: "Owned rollover task",
    status: "running",
    worktreePath: cwd,
  }));
  registry.applyDiscovery([discovered(id, cwd, { gitBranch: "feat/owned-rollover" })]);
  registry.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: "owned-rollover-episode",
    cwd,
    transcriptPath: null,
    env: {},
  });
  registry.upsertTask({ ...registry.getTask("owned-rollover-task")!, sessionId: id });
  registry.bindTaskToWorkEpisode("owned-rollover-task", id);
  const originalEpisode = registry.workEpisodeForSession(id)!;
  const mergedAt = originalEpisode.startedAt + 10;
  registry.reconcilePrs(
    new Map([[id, prMatch({
      url: "https://github.com/example/repo/pull/84",
      number: 84,
      state: "merged",
      branch: "feat/owned-rollover",
      agentSessionId: "owned-rollover-episode",
      episodeId: originalEpisode.episodeId,
      createdAt: originalEpisode.startedAt,
      mergedAt,
    })]]),
    new Set(),
  );

  registry.applyHook({
    agent: "claude",
    event: "UserPromptSubmit",
    sessionId: "owned-rollover-episode",
    cwd,
    transcriptPath: null,
    env: {},
    prompt: "continue with the next change",
    ts: mergedAt + 1,
  });

  const nextEpisode = registry.workEpisodeForSession(id)!;
  const owner = registry.getTask("owned-rollover-task")!;
  assert.notEqual(nextEpisode.episodeId, originalEpisode.episodeId);
  assert.equal(owner.status, "running");
  assert.equal(owner.sessionId, id);
  assert.equal(registry.getSession(id)?.task?.id, owner.id);
  const dependent = tasks.create({
    ...createInput,
    title: "Wait for preserved task ownership",
    backlog: true,
    dependencies: [{ type: "session", sessionId: id }],
  });
  assert.equal(dependent.dependencies[0]?.type, "task");
  assert.equal(dependent.dependencies[0]?.satisfiedAt, null);
});

test("persisted dependency PR polling is bounded and backs off per URL", async () => {
  const registry = new Registry();
  const now = Date.now();
  for (let i = 0; i < 12; i += 1) {
    registry.upsertTask(baseTask({
      id: `bounded-pr-${i}`,
      status: "backlog",
      dependencies: [{
        type: "session",
        sessionId: `bounded-session-${i}`,
        title: `Bounded dependency ${i}`,
        episodeId: `bounded-episode-${i}`,
        agentSessionId: `bounded-agent-${i}`,
        branch: `feat/bounded-${i}`,
        prUrl: `https://github.com/example/repo/pull/${200 + i}`,
        selectedAt: now,
        satisfiedAt: null,
      }],
    }));
  }
  const state = new DependencyPrPollState();
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  const lookupUrl = async () => {
    calls += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise<void>((resolve) => setImmediate(resolve));
    active -= 1;
    return { state: "open" as const, mergedAt: null };
  };

  await pollAndReconcilePrs(registry, async () => null, lookupUrl, state, now);
  assert.equal(calls, 12);
  assert.ok(maxActive <= 4);
  await pollAndReconcilePrs(registry, async () => null, lookupUrl, state, now + 1);
  assert.equal(calls, 12);
  for (let i = 0; i < 12; i += 1) registry.removeTask(`bounded-pr-${i}`);
});

test("persisted dependency PRs keep merging after their sessions exit", async () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const standaloneId = "exited-standalone";
  const standaloneCwd = "/repo/exited-standalone";
  const assignedId = "exited-assigned";
  const assignedCwd = "/repo/exited-assigned";
  registry.upsertTask(
    baseTask({
      id: "exited-prerequisite",
      title: "Exited assigned prerequisite",
      status: "running",
      worktreePath: assignedCwd,
    }),
  );
  registry.applyDiscovery([
    discovered(standaloneId, standaloneCwd, { gitBranch: "feat/exited-standalone" }),
    discovered(assignedId, assignedCwd, { gitBranch: "feat/exited-assigned" }),
  ]);
  registry.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: "exited-standalone-episode",
    cwd: standaloneCwd,
    transcriptPath: null,
    env: {},
  });
  registry.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: "exited-assigned-episode",
    cwd: assignedCwd,
    transcriptPath: null,
    env: {},
  });
  registry.upsertTask({ ...registry.getTask("exited-prerequisite")!, sessionId: assignedId });
  registry.bindTaskToWorkEpisode("exited-prerequisite", assignedId);
  const standaloneEpisode = registry.workEpisodeForSession(standaloneId)!;
  const assignedEpisode = registry.workEpisodeForSession(assignedId)!;
  const standaloneDependent = tasks.create({
    ...createInput,
    title: "Wait for exited standalone work",
    backlog: true,
    dependencies: [{ type: "session", sessionId: standaloneId }],
  });
  const assignedDependent = tasks.create({
    ...createInput,
    title: "Wait for exited assigned work",
    backlog: true,
    dependencies: [{ type: "task", taskId: "exited-prerequisite" }],
  });
  const standaloneUrl = "https://github.com/example/repo/pull/81";
  const assignedUrl = "https://github.com/example/repo/pull/82";
  registry.reconcilePrs(
    new Map([
      [standaloneId, prMatch({
        url: standaloneUrl,
        number: 81,
        branch: "feat/exited-standalone",
        agentSessionId: "exited-standalone-episode",
        episodeId: standaloneEpisode.episodeId,
        createdAt: standaloneEpisode.startedAt,
      })],
      [assignedId, prMatch({
        url: assignedUrl,
        number: 82,
        branch: "feat/exited-assigned",
        agentSessionId: "exited-assigned-episode",
        episodeId: assignedEpisode.episodeId,
        createdAt: assignedEpisode.startedAt,
      })],
    ]),
    new Set(),
  );
  registry.applyDiscovery([]);

  let liveLookups = 0;
  const polledUrls = new Set<string>();
  await pollAndReconcilePrs(
    registry,
    async () => {
      liveLookups += 1;
      return null;
    },
    async (url) => {
      polledUrls.add(url);
      return { state: "merged", mergedAt: Date.now() };
    },
  );

  assert.equal(liveLookups, 0);
  assert.deepEqual(polledUrls, new Set([standaloneUrl, assignedUrl]));
  assert.ok(registry.getTask(standaloneDependent.id)?.dependencies[0]?.satisfiedAt);
  assert.ok(registry.getTask(assignedDependent.id)?.dependencies[0]?.satisfiedAt);
  assert.deepEqual(tasks.dependencyBlockers(registry.getTask(standaloneDependent.id)!), []);
  assert.deepEqual(tasks.dependencyBlockers(registry.getTask(assignedDependent.id)!), []);
});

test("a standalone dependency follows an expected reset identity rebind", () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const id = "standalone-reset-rebind";
  const cwd = "/repo/standalone-reset-rebind";
  registry.applyDiscovery([discovered(id, cwd, { gitBranch: "main" })]);
  registry.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: "standalone-before-clear",
    cwd,
    transcriptPath: null,
    env: {},
  });
  registry.resetWorkEpisode(id, {
    awaitingAgentRebind: true,
    previousAgentSessionId: "standalone-before-clear",
  });
  const pendingEpisode = registry.workEpisodeForSession(id)!;

  registry.applyHook({
    agent: "claude",
    event: "SessionStart",
    sessionId: "standalone-after-clear",
    cwd,
    transcriptPath: null,
    env: {},
    source: "clear",
  });
  registry.applyDiscovery([discovered(id, cwd, { gitBranch: "feat/reset-rebind" })]);
  const reboundEpisode = registry.workEpisodeForSession(id)!;
  assert.equal(reboundEpisode.episodeId, pendingEpisode.episodeId);
  const dependent = tasks.create({
    ...createInput,
    title: "Wait across reset identity",
    backlog: true,
    dependencies: [{ type: "session", sessionId: id }],
  });
  assert.equal(dependent.dependencies[0]?.type, "session");
  assert.equal(
    dependent.dependencies[0]?.type === "session"
      ? dependent.dependencies[0].agentSessionId
      : null,
    "standalone-after-clear",
  );
  registry.reconcilePrs(
    new Map([
      [
        id,
        prMatch({
          url: "https://github.com/example/repo/pull/3",
          number: 3,
          state: "merged",
          branch: "feat/reset-rebind",
          agentSessionId: "standalone-after-clear",
          episodeId: reboundEpisode.episodeId,
          createdAt: reboundEpisode.startedAt,
        }),
      ],
    ]),
    new Set(),
  );

  const edge = registry.getTask(dependent.id)?.dependencies[0];
  assert.equal(
    edge?.type === "session" ? edge.agentSessionId : null,
    "standalone-after-clear",
  );
  assert.ok(edge?.satisfiedAt);
  assert.deepEqual(tasks.dependencyBlockers(registry.getTask(dependent.id)!), []);
});

test("old-identity work disarms a pending reset rebind", () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const id = "old-identity-resumed";
  const cwd = "/repo/old-identity-resumed";
  registry.applyDiscovery([discovered(id, cwd, { gitBranch: "main" })]);
  registry.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: "original-identity",
    cwd,
    transcriptPath: null,
    env: {},
  });
  registry.resetWorkEpisode(id, {
    awaitingAgentRebind: true,
    previousAgentSessionId: "original-identity",
  });
  const pendingEpisode = registry.workEpisodeForSession(id)!;

  registry.applyHook({
    agent: "claude",
    event: "UserPromptSubmit",
    sessionId: "original-identity",
    cwd,
    transcriptPath: null,
    env: {},
    prompt: "continue the assigned task",
  });
  assert.equal(registry.workEpisodeForSession(id)?.episodeId, pendingEpisode.episodeId);
  assert.equal(registry.workEpisodeForSession(id)?.awaitingAgentRebind, false);
  registry.upsertTask(
    baseTask({
      id: "old-identity-task",
      title: "Work resumed without rebind",
      status: "running",
      sessionId: id,
    }),
  );
  assert.equal(registry.bindTaskToWorkEpisode("old-identity-task", id), true);
  const dependent = tasks.create({
    ...createInput,
    title: "Wait for original identity work",
    backlog: true,
    dependencies: [{ type: "task", taskId: "old-identity-task" }],
  });
  registry.applyHook({
    agent: "claude",
    event: "SessionStart",
    sessionId: "unrelated-later-identity",
    cwd,
    transcriptPath: null,
    env: {},
    source: "clear",
  });
  registry.applyDiscovery([discovered(id, cwd, { gitBranch: "feat/unrelated-later" })]);
  const unrelatedEpisode = registry.workEpisodeForSession(id)!;
  assert.notEqual(unrelatedEpisode.episodeId, pendingEpisode.episodeId);
  assert.equal(registry.getTask("old-identity-task")?.sessionId, null);
  registry.reconcilePrs(
    new Map([
      [
        id,
        prMatch({
          url: "https://github.com/example/repo/pull/4",
          number: 4,
          state: "merged",
          branch: "feat/unrelated-later",
          agentSessionId: "unrelated-later-identity",
          episodeId: unrelatedEpisode.episodeId,
          createdAt: unrelatedEpisode.startedAt,
        }),
      ],
    ]),
    new Set(),
  );

  assert.equal(registry.getTask(dependent.id)?.dependencies[0]?.satisfiedAt, null);
  assert.equal(tasks.dependencyBlockers(registry.getTask(dependent.id)!).length, 1);
});

test("old-identity work before clear issuance cannot resolve the reset episode", () => {
  const registry = new Registry();
  const id = "pre-clear-old-work";
  const cwd = "/repo/pre-clear-old-work";
  registry.applyDiscovery([discovered(id, cwd, { gitBranch: "main" })]);
  registry.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: "pre-clear-identity",
    cwd,
    transcriptPath: null,
    env: {},
    ts: 100,
  });
  registry.resetWorkEpisode(id, {
    awaitingAgentRebind: true,
    previousAgentSessionId: "pre-clear-identity",
    at: 200,
  });
  const pending = registry.workEpisodeForSession(id)!;

  registry.applyHook({
    agent: "claude",
    event: "PostToolUse",
    sessionId: "pre-clear-identity",
    cwd,
    transcriptPath: null,
    env: {},
    ts: 150,
  });
  assert.equal(registry.workEpisodeForSession(id)?.episodeId, pending.episodeId);
  assert.equal(registry.workEpisodeForSession(id)?.awaitingAgentRebind, true);

  registry.applyHook({
    agent: "claude",
    event: "SessionStart",
    sessionId: "post-clear-identity",
    cwd,
    transcriptPath: null,
    env: {},
    source: "clear",
    ts: 250,
  });
  assert.equal(registry.workEpisodeForSession(id)?.episodeId, pending.episodeId);
  assert.equal(registry.workEpisodeForSession(id)?.agentSessionId, "post-clear-identity");
  assert.equal(registry.workEpisodeForSession(id)?.awaitingAgentRebind, false);
});

test("a later identity without reset proof cannot inherit pending ownership", () => {
  const registry = new Registry();
  const id = "unproven-later-identity";
  const cwd = "/repo/unproven-later-identity";
  registry.applyDiscovery([discovered(id, cwd, { gitBranch: "main" })]);
  registry.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: "identity-before-reset",
    cwd,
    transcriptPath: "/transcripts/before.jsonl",
    env: {},
  });
  registry.resetWorkEpisode(id, {
    awaitingAgentRebind: true,
    previousAgentSessionId: "identity-before-reset",
  });
  const pending = registry.workEpisodeForSession(id)!;
  registry.upsertTask(baseTask({
    id: "unproven-owner",
    status: "running",
    sessionId: id,
  }));
  assert.equal(registry.bindTaskToWorkEpisode("unproven-owner", id), false);

  registry.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: "unrelated-later-identity",
    cwd,
    transcriptPath: "/transcripts/later.jsonl",
    env: {},
  });

  const later = registry.workEpisodeForSession(id)!;
  assert.notEqual(later.episodeId, pending.episodeId);
  assert.equal(later.awaitingAgentRebind, false);
  assert.equal(registry.getTask("unproven-owner")?.sessionId, null);
});

test("a rejected PR cannot resolve or bind a pending reset episode", () => {
  const registry = new Registry();
  const id = "rejected-pr-pending";
  const cwd = "/repo/rejected-pr-pending";
  registry.applyDiscovery([discovered(id, cwd, { gitBranch: "feat/rejected" })]);
  registry.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: "rejected-pr-identity",
    cwd,
    transcriptPath: "/transcripts/rejected.jsonl",
    env: {},
  });
  registry.resetWorkEpisode(id, {
    awaitingAgentRebind: true,
    previousAgentSessionId: "rejected-pr-identity",
    at: Date.now() - 1,
  });
  const pending = registry.workEpisodeForSession(id)!;
  registry.upsertTask(baseTask({
    id: "rejected-pr-owner",
    status: "running",
    sessionId: id,
  }));
  assert.equal(registry.bindTaskToWorkEpisode("rejected-pr-owner", id), false);

  registry.reconcilePrs(new Map([[id, prMatch({
    branch: "feat/rejected",
    agentSessionId: "rejected-pr-identity",
    episodeId: pending.episodeId,
    createdAt: pending.startedAt,
    headSha: "stale-head",
    worktreeHeadSha: "current-head",
  })]]), new Set());

  assert.equal(registry.workEpisodeForSession(id)?.awaitingAgentRebind, true);
  assert.equal(registry.bindTaskToWorkEpisode("rejected-pr-owner", id), false);
  assert.equal(registry.getSession(id)?.prUrl, null);
});

test("passive rollout replacement resolves a hookless reset after restart", () => {
  const id = "passive-reset-recovery";
  const cwd = "/repo/passive-reset-recovery";
  const registry = new Registry();
  registry.applyDiscovery([discovered(id, cwd, {
    agent: "codex",
    gitBranch: "main",
    agentSessionId: "passive-before",
    transcriptPath: "/rollouts/before.jsonl",
  })]);
  registry.resetWorkEpisode(id, {
    awaitingAgentRebind: true,
    previousAgentSessionId: "passive-before",
    at: Date.now() - 1,
  });
  const pending = registry.workEpisodeForSession(id)!;

  const restarted = new Registry();
  restarted.applyDiscovery([discovered(id, cwd, {
    agent: "codex",
    gitBranch: "feat/passive-reset",
    agentSessionId: "passive-after",
    transcriptPath: "/rollouts/after.jsonl",
  })]);

  const resolved = restarted.workEpisodeForSession(id)!;
  assert.equal(resolved.episodeId, pending.episodeId);
  assert.equal(resolved.agentSessionId, "passive-after");
  assert.equal(resolved.awaitingAgentRebind, false);
  assert.equal(resolved.rebindFromTranscriptPath, null);
});

test("a delayed daemon restart resolves pending ownership from hook identity", () => {
  const registry = new Registry();
  const id = "delayed-restart-rebind";
  const cwd = "/repo/delayed-restart-rebind";
  registry.applyDiscovery([discovered(id, cwd, { gitBranch: "main" })]);
  registry.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: "restart-before-clear",
    cwd,
    transcriptPath: null,
    env: {},
  });
  registry.resetWorkEpisode(id, {
    awaitingAgentRebind: true,
    previousAgentSessionId: "restart-before-clear",
    at: 1,
  });
  const pendingEpisode = registry.workEpisodeForSession(id)!;

  const restarted = new Registry();
  const restartedTasks = new TaskManager(restarted);
  restarted.applyDiscovery([discovered(id, cwd, { gitBranch: "feat/delayed-restart" })]);
  assert.equal(restarted.workEpisodeForSession(id)?.episodeId, pendingEpisode.episodeId);
  assert.equal(restarted.workEpisodeForSession(id)?.awaitingAgentRebind, true);
  restarted.applyHook({
    agent: "claude",
    event: "SessionStart",
    sessionId: "restart-after-clear",
    cwd,
    transcriptPath: null,
    env: {},
    source: "clear",
  });
  const reboundEpisode = restarted.workEpisodeForSession(id)!;
  assert.equal(reboundEpisode.episodeId, pendingEpisode.episodeId);
  assert.equal(reboundEpisode.agentSessionId, "restart-after-clear");
  assert.equal(reboundEpisode.awaitingAgentRebind, false);
  restarted.upsertTask(
    baseTask({
      id: "delayed-restart-task",
      title: "Survive delayed restart",
      status: "running",
      sessionId: id,
    }),
  );
  assert.equal(restarted.bindTaskToWorkEpisode("delayed-restart-task", id), true);
  const dependent = restartedTasks.create({
    ...createInput,
    title: "Wait for delayed restart work",
    backlog: true,
    dependencies: [{ type: "task", taskId: "delayed-restart-task" }],
  });
  restarted.reconcilePrs(
    new Map([
      [
        id,
        prMatch({
          url: "https://github.com/example/repo/pull/5",
          number: 5,
          state: "merged",
          branch: "feat/delayed-restart",
          agentSessionId: "restart-after-clear",
          episodeId: reboundEpisode.episodeId,
          createdAt: reboundEpisode.startedAt,
        }),
      ],
    ]),
    new Set(),
  );

  assert.ok(restarted.getTask(dependent.id)?.dependencies[0]?.satisfiedAt);
  assert.deepEqual(restartedTasks.dependencyBlockers(restarted.getTask(dependent.id)!), []);
});

test("a reused standalone session cannot satisfy an earlier episode with an unrelated PR", () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  registry.applyDiscovery([
    discovered("reused-standalone", "/repo", { gitBranch: "feat/original" }),
  ]);
  registry.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: "episode-original",
    cwd: "/repo",
    transcriptPath: null,
    env: {},
  });
  const originalEpisode = registry.workEpisodeForSession("reused-standalone")!;
  const dependent = tasks.create({
    ...createInput,
    backlog: true,
    dependencies: [{ type: "session", sessionId: "reused-standalone" }],
  });

  registry.reconcilePrs(
    new Map([
      [
        "reused-standalone",
        prMatch({
          url: "https://github.com/example/repo/pull/10",
          number: 10,
          state: "open" as const,
          checks: "passing" as const,
          branch: "feat/original",
          agentSessionId: "episode-original",
          episodeId: originalEpisode.episodeId,
          createdAt: originalEpisode.startedAt,
        }),
      ],
    ]),
    new Set(),
  );
  const pinned = registry.getTask(dependent.id)?.dependencies[0];
  assert.equal(pinned?.type === "session" ? pinned.prUrl : null, "https://github.com/example/repo/pull/10");

  const restarted = new Registry();
  const restartedTasks = new TaskManager(restarted);
  restarted.applyDiscovery([
    discovered("reused-standalone", "/repo", { gitBranch: "feat/unrelated" }),
  ]);
  restarted.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: "episode-unrelated",
    cwd: "/repo",
    transcriptPath: null,
    env: {},
  });
  const unrelatedEpisode = restarted.workEpisodeForSession("reused-standalone")!;
  restarted.reconcilePrs(
    new Map([
      [
        "reused-standalone",
        prMatch({
          url: "https://github.com/example/repo/pull/11",
          number: 11,
          state: "merged" as const,
          checks: "passing" as const,
          branch: "feat/unrelated",
          agentSessionId: "episode-unrelated",
          episodeId: unrelatedEpisode.episodeId,
          createdAt: unrelatedEpisode.startedAt,
        }),
      ],
    ]),
    new Set(),
  );

  const edge = restarted.getTask(dependent.id)?.dependencies[0];
  assert.equal(edge?.satisfiedAt, null);
  assert.equal(edge?.type === "session" ? edge.prUrl : null, "https://github.com/example/repo/pull/10");
  assert.equal(restartedTasks.dependencyBlockers(restarted.getTask(dependent.id)!).length, 1);
});

test("stale PR chips cannot pin or satisfy dependencies for new work", () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);

  for (const state of ["open", "merged"] as const) {
    const id = `stale-${state}`;
    const cwd = `/repo/${state}`;
    registry.applyDiscovery([discovered(id, cwd, { gitBranch: `feat/${state}-old` })]);
    registry.applyHook({
      agent: "claude",
      event: "Stop",
      sessionId: `${state}-old-episode`,
      cwd,
      transcriptPath: null,
      env: {},
    });
    const oldEpisode = registry.workEpisodeForSession(id)!;
    registry.reconcilePrs(
      new Map([
        [
          id,
          prMatch({
            url: `https://github.com/example/repo/pull/${state === "open" ? 20 : 21}`,
            number: state === "open" ? 20 : 21,
            state,
            checks: "passing" as const,
            branch: `feat/${state}-old`,
            agentSessionId: `${state}-old-episode`,
            episodeId: oldEpisode.episodeId,
            createdAt: oldEpisode.startedAt,
          }),
        ],
      ]),
      new Set(),
    );

    registry.applyDiscovery([discovered(id, cwd, { gitBranch: `feat/${state}-new` })]);
    registry.applyHook({
      agent: "claude",
      event: "Stop",
      sessionId: `${state}-new-episode`,
      cwd,
      transcriptPath: null,
      env: {},
    });
    const dependent = tasks.create({
      ...createInput,
      title: `Wait for ${state} replacement`,
      backlog: true,
      dependencies: [{ type: "session", sessionId: id }],
    });
    const edge = dependent.dependencies[0];
    assert.equal(edge?.type, "session");
    assert.equal(edge?.satisfiedAt, null);
    assert.equal(edge?.type === "session" ? edge.prUrl : null, null);
    assert.equal(tasks.dependencyBlockers(dependent).length, 1);
  }
});

test("an in-flight PR poll cannot cross work episodes", async () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const id = "poll-race";
  const cwd = "/repo/poll-race";
  registry.applyDiscovery([discovered(id, cwd, { gitBranch: "feat/poll-old" })]);
  registry.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: "poll-old-episode",
    cwd,
    transcriptPath: null,
    env: {},
  });
  let queryStarted!: () => void;
  let finishQuery!: (
    match: Omit<PrMatch, "branch" | "agentSessionId" | "episodeId">,
  ) => void;
  const started = new Promise<void>((resolve) => {
    queryStarted = resolve;
  });
  const result = new Promise<
    Omit<PrMatch, "branch" | "agentSessionId" | "episodeId">
  >((resolve) => {
    finishQuery = resolve;
  });
  const polling = pollAndReconcilePrs(registry, async () => {
    queryStarted();
    return result;
  });
  await started;

  registry.applyDiscovery([discovered(id, cwd, { gitBranch: "feat/poll-new" })]);
  registry.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: "poll-new-episode",
    cwd,
    transcriptPath: null,
    env: {},
  });
  const dependent = tasks.create({
    ...createInput,
    title: "Wait for the new work episode",
    backlog: true,
    dependencies: [{ type: "session", sessionId: id }],
  });

  finishQuery({
    url: "https://github.com/example/repo/pull/30",
    number: 30,
    state: "merged",
    checks: "passing",
    createdAt: Date.now(),
    mergedAt: Date.now(),
    headSha: "old-head",
    worktreeHeadSha: "old-head",
  });
  await polling;

  assert.equal(registry.getSession(id)?.prUrl, null);
  const edge = registry.getTask(dependent.id)?.dependencies[0];
  assert.equal(edge?.satisfiedAt, null);
  assert.equal(edge?.type === "session" ? edge.prUrl : null, null);
  assert.equal(tasks.dependencyBlockers(registry.getTask(dependent.id)!).length, 1);
});

test("manual session reuse cannot complete the task from the discarded episode", () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const id = "manual-reuse";
  const cwd = "/repo/manual-reuse";
  registry.applyDiscovery([discovered(id, cwd, { gitBranch: "feat/task-work" })]);
  registry.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: "task-episode",
    cwd,
    transcriptPath: null,
    env: {},
  });
  registry.upsertTask(
    baseTask({
      id: "manually-assigned",
      title: "Original assigned work",
      status: "running",
      sessionId: id,
    }),
  );
  registry.bindTaskToWorkEpisode("manually-assigned", id);
  const dependent = tasks.create({
    ...createInput,
    backlog: true,
    dependencies: [{ type: "task", taskId: "manually-assigned" }],
  });

  registry.resetWorkEpisode(id);
  registry.applyDiscovery([discovered(id, cwd, { gitBranch: "feat/unrelated-work" })]);
  registry.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: "unrelated-episode",
    cwd,
    transcriptPath: null,
    env: {},
  });
  const unrelated = registry.workEpisodeForSession(id)!;
  registry.reconcilePrs(
    new Map([
      [
        id,
        prMatch({
          url: "https://github.com/example/repo/pull/40",
          number: 40,
          state: "merged",
          branch: "feat/unrelated-work",
          agentSessionId: "unrelated-episode",
          episodeId: unrelated.episodeId,
          createdAt: unrelated.startedAt,
          headSha: "unrelated-head",
          worktreeHeadSha: "unrelated-head",
        }),
      ],
    ]),
    new Set(),
  );

  assert.equal(registry.getTask("manually-assigned")?.sessionId, null);
  assert.equal(registry.getTask(dependent.id)?.dependencies[0]?.satisfiedAt, null);
  assert.equal(tasks.dependencyBlockers(registry.getTask(dependent.id)!).length, 1);
});

test("a dependency follows its work episode from the default branch", () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const id = "default-promotion";
  const cwd = "/repo/default-promotion";
  registry.applyDiscovery([discovered(id, cwd, { gitBranch: "main" })]);
  registry.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: "default-promotion-episode",
    cwd,
    transcriptPath: null,
    env: {},
  });
  const originalEpisode = registry.workEpisodeForSession(id)!;
  const dependent = tasks.create({
    ...createInput,
    title: "Wait for promoted work",
    backlog: true,
    dependencies: [{ type: "session", sessionId: id }],
  });

  registry.applyDiscovery([discovered(id, cwd, { gitBranch: "feat/promoted-work" })]);
  const promotedEpisode = registry.workEpisodeForSession(id)!;
  assert.equal(promotedEpisode.episodeId, originalEpisode.episodeId);
  registry.reconcilePrs(
    new Map([
      [
        id,
        prMatch({
          url: "https://github.com/example/repo/pull/42",
          number: 42,
          state: "merged",
          branch: "feat/promoted-work",
          agentSessionId: "default-promotion-episode",
          episodeId: promotedEpisode.episodeId,
          createdAt: promotedEpisode.startedAt,
        }),
      ],
    ]),
    new Set(),
  );

  const edge = registry.getTask(dependent.id)?.dependencies[0];
  assert.equal(edge?.type === "session" ? edge.branch : null, "feat/promoted-work");
  assert.ok(edge?.satisfiedAt);
  assert.deepEqual(tasks.dependencyBlockers(registry.getTask(dependent.id)!), []);
});

test("a pinned PR remains attributable after its head advances", () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const id = "advanced-pr-head";
  const cwd = "/repo/advanced-pr-head";
  registry.applyDiscovery([discovered(id, cwd, { gitBranch: "feat/advanced-head" })]);
  registry.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: "advanced-head-episode",
    cwd,
    transcriptPath: null,
    env: {},
  });
  const episode = registry.workEpisodeForSession(id)!;
  const dependent = tasks.create({
    ...createInput,
    title: "Wait for the advanced PR",
    backlog: true,
    dependencies: [{ type: "session", sessionId: id }],
  });
  const url = "https://github.com/example/repo/pull/43";

  registry.reconcilePrs(
    new Map([
      [
        id,
        prMatch({
          url,
          number: 43,
          branch: "feat/advanced-head",
          agentSessionId: "advanced-head-episode",
          episodeId: episode.episodeId,
          createdAt: episode.startedAt,
          headSha: "initial-head",
          worktreeHeadSha: "initial-head",
        }),
      ],
    ]),
    new Set(),
  );
  registry.reconcilePrs(
    new Map([
      [
        id,
        prMatch({
          url,
          number: 43,
          state: "merged",
          branch: "feat/advanced-head",
          agentSessionId: "advanced-head-episode",
          episodeId: episode.episodeId,
          createdAt: episode.startedAt,
          headSha: "advanced-head",
          worktreeHeadSha: "initial-head",
        }),
      ],
    ]),
    new Set(),
  );

  const edge = registry.getTask(dependent.id)?.dependencies[0];
  assert.equal(edge?.type === "session" ? edge.prUrl : null, url);
  assert.ok(edge?.satisfiedAt);
  assert.deepEqual(tasks.dependencyBlockers(registry.getTask(dependent.id)!), []);
});

test("a current-episode PR can first pin after its remote head advances", async () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const id = "advanced-before-first-poll";
  const cwd = "/repo/advanced-before-first-poll";
  registry.applyDiscovery([discovered(id, cwd, { gitBranch: "feat/advanced-before-poll" })]);
  registry.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: "advanced-before-poll-episode",
    cwd,
    transcriptPath: null,
    env: {},
  });
  const episode = registry.workEpisodeForSession(id)!;
  const dependent = tasks.create({
    ...createInput,
    title: "Wait for the PR advanced before polling",
    backlog: true,
    dependencies: [{ type: "session", sessionId: id }],
  });
  const url = "https://github.com/example/repo/pull/45";
  const createdAt = episode.startedAt + 1;

  await pollAndReconcilePrs(registry, async () => ({
    url,
    number: 45,
    state: "open",
    checks: "passing",
    createdAt,
    mergedAt: null,
    headSha: "remote-head-after-push",
    worktreeHeadSha: "local-head-before-push",
  }));

  assert.equal(registry.getSession(id)?.prUrl, url);
  let edge = registry.getTask(dependent.id)?.dependencies[0];
  assert.equal(edge?.type === "session" ? edge.prUrl : null, url);
  assert.equal(edge?.satisfiedAt, null);
  assert.equal(tasks.dependencyBlockers(registry.getTask(dependent.id)!).length, 1);

  await pollAndReconcilePrs(registry, async () => ({
    url,
    number: 45,
    state: "merged",
    checks: "passing",
    createdAt,
    mergedAt: Date.now(),
    headSha: "remote-head-at-merge",
    worktreeHeadSha: "local-head-before-push",
  }));

  edge = registry.getTask(dependent.id)?.dependencies[0];
  assert.equal(edge?.type === "session" ? edge.prUrl : null, url);
  assert.ok(edge?.satisfiedAt);
  assert.deepEqual(tasks.dependencyBlockers(registry.getTask(dependent.id)!), []);
});

test("an unrelated hook PR hint cannot block the validated episode PR", () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const id = "replace-hook-pr-hint";
  const cwd = "/repo/replace-hook-pr-hint";
  registry.applyDiscovery([discovered(id, cwd, { gitBranch: "feat/hook-hint" })]);
  registry.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: "hook-hint-episode",
    cwd,
    transcriptPath: null,
    env: {},
  });
  const episode = registry.workEpisodeForSession(id)!;
  registry.applyHook({
    agent: "claude",
    event: "PostToolUse",
    sessionId: "hook-hint-episode",
    cwd,
    transcriptPath: null,
    env: {},
    prUrl: "https://github.com/example/repo/pull/70",
  });
  assert.equal(registry.getSession(id)?.prUrl, "https://github.com/example/repo/pull/70");
  assert.equal(registry.workEpisodeForSession(id)?.prUrl, null);
  assert.equal(registry.prObservationFor(id), null);

  const dependent = tasks.create({
    ...createInput,
    title: "Wait for validated PR",
    backlog: true,
    dependencies: [{ type: "session", sessionId: id }],
  });
  assert.equal(
    dependent.dependencies[0]?.type === "session" ? dependent.dependencies[0].prUrl : null,
    null,
  );

  const validatedUrl = "https://github.com/example/repo/pull/71";
  registry.reconcilePrs(new Map([[id, prMatch({
    url: validatedUrl,
    number: 71,
    state: "merged",
    branch: "feat/hook-hint",
    agentSessionId: "hook-hint-episode",
    episodeId: episode.episodeId,
    createdAt: episode.startedAt,
    headSha: "validated-head",
    worktreeHeadSha: "validated-head",
  })]]), new Set());

  assert.equal(registry.getSession(id)?.prUrl, validatedUrl);
  assert.equal(registry.workEpisodeForSession(id)?.prUrl, validatedUrl);
  const edge = registry.getTask(dependent.id)?.dependencies[0];
  assert.equal(edge?.type === "session" ? edge.prUrl : null, validatedUrl);
  assert.ok(edge?.satisfiedAt);
  assert.deepEqual(tasks.dependencyBlockers(registry.getTask(dependent.id)!), []);
});

test("reset ownership cannot be reconstructed from a reused cwd", () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const id = "reset-cwd";
  const cwd = "/repo/reset-cwd";
  registry.upsertTask(
    baseTask({
      id: "reset-cwd-task",
      title: "Discarded assigned work",
      status: "running",
      worktreePath: cwd,
    }),
  );
  registry.applyDiscovery([discovered(id, cwd, { gitBranch: "feat/discarded" })]);
  registry.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: "reset-cwd-old-episode",
    cwd,
    transcriptPath: null,
    env: {},
  });
  registry.upsertTask({ ...registry.getTask("reset-cwd-task")!, sessionId: id });
  registry.bindTaskToWorkEpisode("reset-cwd-task", id);

  registry.resetWorkEpisode(id);
  registry.applyDiscovery([discovered(id, cwd, { gitBranch: "feat/reused-cwd" })]);
  registry.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: "reset-cwd-new-episode",
    cwd,
    transcriptPath: null,
    env: {},
  });
  const dependent = tasks.create({
    ...createInput,
    title: "Wait for reused cwd work",
    backlog: true,
    dependencies: [{ type: "session", sessionId: id }],
  });

  assert.equal(registry.getSession(id)?.task, null);
  assert.equal(registry.getTask("reset-cwd-task")?.sessionId, null);
  assert.equal(dependent.dependencies[0]?.type, "session");
  assert.equal(
    dependent.dependencies[0]?.type === "session"
      ? dependent.dependencies[0].agentSessionId
      : null,
    "reset-cwd-new-episode",
  );
});

test("a missing branch observation preserves task episode ownership", () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const id = "missing-branch";
  const cwd = "/repo/missing-branch";
  registry.applyDiscovery([discovered(id, cwd, { gitBranch: "feat/stable-work" })]);
  registry.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: "missing-branch-episode",
    cwd,
    transcriptPath: null,
    env: {},
  });
  registry.upsertTask(
    baseTask({
      id: "missing-branch-task",
      title: "Work through transient discovery",
      status: "running",
      sessionId: id,
      worktreePath: cwd,
    }),
  );
  registry.bindTaskToWorkEpisode("missing-branch-task", id);
  const episode = registry.workEpisodeForSession(id)!;
  const dependent = tasks.create({
    ...createInput,
    title: "Wait through missing branch",
    backlog: true,
    dependencies: [{ type: "task", taskId: "missing-branch-task" }],
  });

  registry.applyDiscovery([discovered(id, cwd, { gitBranch: null })]);
  assert.equal(registry.workEpisodeForSession(id)?.episodeId, episode.episodeId);
  assert.equal(registry.getTask("missing-branch-task")?.sessionId, id);
  registry.applyDiscovery([discovered(id, cwd, { gitBranch: "feat/stable-work" })]);
  registry.reconcilePrs(
    new Map([
      [
        id,
        prMatch({
          url: "https://github.com/example/repo/pull/44",
          number: 44,
          state: "merged",
          branch: "feat/stable-work",
          agentSessionId: "missing-branch-episode",
          episodeId: episode.episodeId,
          createdAt: episode.startedAt,
        }),
      ],
    ]),
    new Set(),
  );

  assert.ok(registry.getTask(dependent.id)?.dependencies[0]?.satisfiedAt);
  assert.deepEqual(tasks.dependencyBlockers(registry.getTask(dependent.id)!), []);
});

test("a historical merge on a reused branch cannot satisfy a new episode", async () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const id = "historical-branch";
  const cwd = "/repo/historical-branch";
  registry.applyDiscovery([discovered(id, cwd, { gitBranch: "feat/reused-name" })]);
  registry.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: "new-branch-episode",
    cwd,
    transcriptPath: null,
    env: {},
  });
  const episode = registry.workEpisodeForSession(id)!;
  const dependent = tasks.create({
    ...createInput,
    backlog: true,
    dependencies: [{ type: "session", sessionId: id }],
  });

  await pollAndReconcilePrs(registry, async () => ({
    url: "https://github.com/example/repo/pull/41",
    number: 41,
    state: "merged",
    checks: "passing",
    createdAt: episode.startedAt - 1,
    mergedAt: Date.now(),
    headSha: "historical-head",
    worktreeHeadSha: "new-work-head",
  }));

  assert.equal(registry.getSession(id)?.prUrl, null);
  assert.equal(registry.getTask(dependent.id)?.dependencies[0]?.satisfiedAt, null);
  assert.equal(tasks.dependencyBlockers(registry.getTask(dependent.id)!).length, 1);
});

test("a session without an agent episode cannot become a dependency", () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  registry.applyDiscovery([
    discovered("unknown-episode", "/repo/unknown-episode", { gitBranch: "feat/unknown" }),
  ]);

  assert.throws(
    () =>
      tasks.create({
        ...createInput,
        backlog: true,
        dependencies: [{ type: "session", sessionId: "unknown-episode" }],
      }),
    /no stable work identity/,
  );
});

test("completing a scout satisfies its dependents, while dependency cycles are refused", async () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  registry.upsertTask(baseTask({ id: "scout-pre", title: "Investigate", kind: "scout", status: "running" }));
  const dependent = tasks.create({
    ...createInput,
    backlog: true,
    dependencies: [{ type: "task", taskId: "scout-pre" }],
  });
  tasks.complete("scout-pre", "documented the answer");
  assert.ok(registry.getTask(dependent.id)?.dependencies[0]?.satisfiedAt);

  const a = tasks.create({ ...createInput, title: "A", backlog: true });
  const b = tasks.create({
    ...createInput,
    title: "B",
    backlog: true,
    dependencies: [{ type: "task", taskId: a.id }],
  });
  const cycle = await tasks.update(a.id, { dependencies: [{ type: "task", taskId: b.id }] });
  assert.equal(cycle.ok, false);
  assert.match(cycle.error ?? "", /cycle/);
});
