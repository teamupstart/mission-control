import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask as baseTask } from "./helpers/session-fixture.ts";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";

const home = mkdtempSync(join(tmpdir(), "mission-task-dependencies-"));
process.env.HARNESS_HOME = home;
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");

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
    { type: "task", taskId: "force-pre", title: "Merge the foundation", satisfiedAt: null },
  ]);
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
        {
          url: "https://github.com/example/repo/pull/1",
          number: 1,
          state: "merged" as const,
          checks: "passing" as const,
        },
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
  const dependent = tasks.create({
    ...createInput,
    backlog: true,
    dependencies: [{ type: "session", sessionId: "standalone-session" }],
  });

  registry.reconcilePrs(
    new Map([
      [
        "standalone-session",
        {
          url: "https://github.com/example/repo/pull/2",
          number: 2,
          state: "merged" as const,
          checks: "passing" as const,
        },
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
  const dependent = tasks.create({
    ...createInput,
    backlog: true,
    dependencies: [{ type: "session", sessionId: "reused-standalone" }],
  });

  registry.reconcilePrs(
    new Map([
      [
        "reused-standalone",
        {
          url: "https://github.com/example/repo/pull/10",
          number: 10,
          state: "open" as const,
          checks: "passing" as const,
        },
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
  restarted.reconcilePrs(
    new Map([
      [
        "reused-standalone",
        {
          url: "https://github.com/example/repo/pull/11",
          number: 11,
          state: "merged" as const,
          checks: "passing" as const,
        },
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
    registry.reconcilePrs(
      new Map([
        [
          id,
          {
            url: `https://github.com/example/repo/pull/${state === "open" ? 20 : 21}`,
            number: state === "open" ? 20 : 21,
            state,
            checks: "passing" as const,
          },
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
