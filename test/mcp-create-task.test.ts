import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QueueManager } from "../src/server/queue.ts";
import type { ReviewManager } from "../src/server/reviews.ts";

const home = mkdtempSync(join(tmpdir(), "mission-mcp-create-task-home-"));
const repos = mkdtempSync(join(tmpdir(), "mission-mcp-create-task-repos-"));
process.env.HARNESS_HOME = home;
process.env.HARNESS_WORKSPACE_DIRS = repos;
process.env.HARNESS_REPOS_CACHE_MS = "0";

const { ensureToken } = await import("../src/server/auth.ts");
const { Registry } = await import("../src/server/registry.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { setHarnessesConfig } = await import("../src/server/harnesses.ts");
const { openDb } = await import("../src/server/db.ts");

after(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repos, { recursive: true, force: true });
});

afterEach(() => {
  openDb().exec("DELETE FROM app_config");
});

function gitRepo(name = "repo"): string {
  const dir = join(repos, name);
  execFileSync("mkdir", ["-p", dir]);
  execFileSync("git", ["-C", dir, "init", "-q"]);
  return realpathSync(dir);
}

async function createTaskRequest(
  app: ReturnType<typeof buildApp>,
  path: "/mcp/tasks" | "/mcp/v2/tasks",
  repoRoot: string,
  body: Record<string, unknown> = {},
): Promise<Response> {
  return await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": ensureToken() },
    body: JSON.stringify({
      env: {},
      cwd: repoRoot,
      repoRoot,
      title: "Filed by an agent",
      intent: "Do the thing",
      ...body,
    }),
  });
}

test("MCP task creation combines phase prerequisites with the calling session", async () => {
  const repo = gitRepo();
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const prerequisite = tasks.create({
    repoRoot: repo,
    intent: "Implement the prerequisite phase",
    title: "Prerequisite phase",
    kind: "ship",
    agent: "claude",
    backlog: true,
  });

  registry.applyDiscovery([
    {
      syntheticId: "planning-session",
      agent: "claude",
      name: "phase the plan",
      nameSource: "process",
      cwd: repo,
      gitBranch: "plan/phased-plan",
      gitRoot: repo,
      repoRoot: repo,
      pid: 101,
      tty: null,
      terminals: [],
      startedAt: Date.now(),
    },
  ]);
  registry.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: "planning-agent-session",
    cwd: repo,
    transcriptPath: null,
    env: {},
  });

  const planningSession = registry.snapshot().sessions.find(
    (session) => session.name === "phase the plan",
  );
  assert.ok(planningSession);
  const app = buildApp({ registry, reviews: {} as ReviewManager, tasks, queues: {} as QueueManager });
  const response = await app.request("/mcp/tasks", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-harness-token": ensureToken(),
    },
    body: JSON.stringify({
      env: {},
      sessionId: "planning-agent-session",
      cwd: repo,
      repoRoot: repo,
      title: "Dependent phase",
      intent: "Implement the dependent phase",
      dependsOnTaskIds: [prerequisite.id],
      dependsOnCurrentSession: true,
    }),
  });

  assert.equal(response.status, 200);
  const created = await response.json();
  assert.equal(created.status, "backlog");
  assert.deepEqual(
    created.dependencies.map((dependency: { type: string; taskId?: string; sessionId?: string }) =>
      dependency.type === "task"
        ? `task:${dependency.taskId}`
        : `session:${dependency.sessionId}`,
    ),
    [`task:${prerequisite.id}`, `session:${planningSession.id}`],
  );
});

test("a task filed through MCP takes the kind's agent, not a hardcoded Claude", async () => {
  // An agent filing work through MCP has no opinion about which harness runs it - the tool
  // has no `agent` field at all - so it must take whatever `ship` is configured to run on.
  // The route used to say `agent: "claude"` here, which was an opinion expressed by accident
  // and one no setting could reach.
  openDb().exec("DELETE FROM app_config");
  setHarnessesConfig({ kindDefaults: { ship: { agent: "codex" } } });
  const repo = gitRepo();
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const app = buildApp({ registry, reviews: {} as ReviewManager, tasks, queues: {} as QueueManager });
  const response = await app.request("/mcp/tasks", {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": ensureToken() },
    body: JSON.stringify({
      env: {},
      cwd: repo,
      repoRoot: repo,
      title: "Filed by an agent",
      intent: "Do the thing",
    }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).agent, "codex");
});

test("the versioned route resolves an absolute alternate primary and echoes its canonical set", async () => {
  const repoA = gitRepo("absolute-a");
  const repoB = gitRepo("absolute-b");
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const app = buildApp({ registry, reviews: {} as ReviewManager, tasks, queues: {} as QueueManager });
  const before = registry.snapshot().tasks.length;

  const response = await createTaskRequest(app, "/mcp/v2/tasks", repoA, {
    targetRepository: repoB,
  });

  assert.equal(response.status, 200);
  const created = await response.json();
  assert.equal(created.repoRoot, repoB);
  assert.deepEqual(created.extraRepos, []);
  assert.equal(created.status, "backlog");
  assert.equal(registry.snapshot().tasks.length, before + 1);
});

test("a unique repository basename resolves through the workspace index", async () => {
  const repoA = gitRepo("short-name-a");
  const repoB = gitRepo("short-name-b");
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const app = buildApp({ registry, reviews: {} as ReviewManager, tasks, queues: {} as QueueManager });

  const response = await createTaskRequest(app, "/mcp/v2/tasks", repoA, {
    targetRepository: "short-name-b",
  });

  assert.equal(response.status, 200);
  assert.equal((await response.json()).repoRoot, repoB);
});

test("missing and ambiguous short names are actionable and create no task", async () => {
  const repoA = gitRepo("selector-a");
  const first = gitRepo("alpha/shared-lib");
  const second = gitRepo("beta/shared-lib");
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const app = buildApp({ registry, reviews: {} as ReviewManager, tasks, queues: {} as QueueManager });
  const before = registry.snapshot().tasks.length;

  const missing = await createTaskRequest(app, "/mcp/v2/tasks", repoA, {
    targetRepository: "not-here",
  });
  assert.equal(missing.status, 400);
  assert.match(((await missing.json()) as { error: string }).error, /use an absolute repository path/);

  const ambiguous = await createTaskRequest(app, "/mcp/v2/tasks", repoA, {
    targetRepository: "shared-lib",
  });
  assert.equal(ambiguous.status, 409);
  const message = ((await ambiguous.json()) as { error: string }).error;
  assert.match(message, /ambiguous/);
  assert.ok(message.indexOf(first) < message.indexOf(second), "canonical candidates are sorted");
  assert.equal(registry.snapshot().tasks.length, before);
});

test("one versioned call stores an ordered canonical attachment set", async () => {
  const repoA = gitRepo("attached-a");
  const repoB = gitRepo("attached-b");
  const repoC = gitRepo("attached-c");
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const app = buildApp({ registry, reviews: {} as ReviewManager, tasks, queues: {} as QueueManager });

  const response = await createTaskRequest(app, "/mcp/v2/tasks", repoA, {
    targetRepository: "attached-b",
    additionalRepositories: [repoA, "attached-c"],
  });

  assert.equal(response.status, 200);
  const created = await response.json();
  assert.equal(created.repoRoot, repoB);
  assert.deepEqual(
    created.extraRepos.map((entry: { repoRoot: string }) => entry.repoRoot),
    [repoA, repoC],
  );
});

test("the full repository set is refused before storage on collisions, duplicates, and cap", async () => {
  const repoA = gitRepo("policy-a");
  const repoB = gitRepo("policy-b");
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const app = buildApp({ registry, reviews: {} as ReviewManager, tasks, queues: {} as QueueManager });
  const before = registry.snapshot().tasks.length;

  const primaryCollision = await createTaskRequest(app, "/mcp/v2/tasks", repoA, {
    targetRepository: repoB,
    additionalRepositories: [repoB],
  });
  assert.equal(primaryCollision.status, 400);
  assert.match(((await primaryCollision.json()) as { error: string }).error, /already this task's primary repo/);

  const duplicate = await createTaskRequest(app, "/mcp/v2/tasks", repoA, {
    additionalRepositories: [repoB, repoB],
  });
  assert.equal(duplicate.status, 400);
  assert.match(((await duplicate.json()) as { error: string }).error, /attached twice/);

  const overCap = await createTaskRequest(app, "/mcp/v2/tasks", repoA, {
    additionalRepositories: Array.from({ length: 9 }, (_, i) => `/repo-${i}`),
  });
  assert.equal(overCap.status, 400);
  assert.equal(registry.snapshot().tasks.length, before);
});

test("the default ship harness is capability-checked before a multi-repo task is stored", async () => {
  setHarnessesConfig({ kindDefaults: { ship: { agent: "pi" } } });
  const repoA = gitRepo("pi-a");
  const repoB = gitRepo("pi-b");
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const app = buildApp({ registry, reviews: {} as ReviewManager, tasks, queues: {} as QueueManager });
  const before = registry.snapshot().tasks.length;

  const response = await createTaskRequest(app, "/mcp/v2/tasks", repoA, {
    additionalRepositories: [repoB],
  });

  assert.equal(response.status, 400);
  assert.match(((await response.json()) as { error: string }).error, /pi cannot be given write access/);
  assert.equal(registry.snapshot().tasks.length, before);
});

test("a planning session in repo A can gate a task whose primary is repo B", async () => {
  const repoA = gitRepo("dependency-a");
  const repoB = gitRepo("dependency-b");
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  registry.applyDiscovery([{
    syntheticId: "cross-repo-plan",
    agent: "claude",
    name: "plan across repos",
    nameSource: "process",
    cwd: repoA,
    gitBranch: "plan/cross-repo",
    gitRoot: repoA,
    repoRoot: repoA,
    pid: 202,
    tty: null,
    terminals: [],
    startedAt: Date.now(),
  }]);
  registry.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: "cross-repo-agent",
    cwd: repoA,
    transcriptPath: null,
    env: {},
  });
  const planningSession = registry.snapshot().sessions.find((session) => session.name === "plan across repos");
  assert.ok(planningSession);
  const app = buildApp({ registry, reviews: {} as ReviewManager, tasks, queues: {} as QueueManager });

  const response = await createTaskRequest(app, "/mcp/v2/tasks", repoA, {
    sessionId: "cross-repo-agent",
    targetRepository: repoB,
    dependsOnCurrentSession: true,
  });

  assert.equal(response.status, 200);
  const created = await response.json();
  assert.equal(created.repoRoot, repoB);
  assert.equal(created.dependencies[0]?.sessionId, planningSession.id);
  assert.equal(created.dependencies[0]?.satisfiedAt, null);
});
