import assert from "node:assert/strict";
import { after, afterEach, test, type TestContext } from "node:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { TASK_STATUSES, type Task } from "../src/shared/types.ts";
import { DEFAULT_WORKFLOW_POLICY } from "../src/shared/workflow.ts";
import { LOCAL_PLAN_VALIDATION_WORKFLOW_ID, PLAN_VALIDATION_WORKFLOW_ID } from "../src/shared/builtin-workflow.ts";
import { McpTaskConfigurationSchema, type McpTaskSnapshot } from "../src/shared/protocol.ts";
import { ensureNativeStateLockAddon } from "./helpers/native-state-lock.ts";
import type { TaskArchiveGate } from "../src/server/tasks.ts";

ensureNativeStateLockAddon();

const home = mkdtempSync(join(tmpdir(), "mission-mcp-backlog-"));
const repos = join(home, "repos");
process.env.MISSION_HOME = home;
process.env.MISSION_WORKSPACE_DIRS = repos;
process.env.MISSION_REPOS_CACHE_MS = "0";

const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("./helpers/task-manager-fixture.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { ensureToken } = await import("../src/server/auth.ts");
const { getTask, listTasks, openDb } = await import("../src/server/db.ts");
const { setHarnessesConfig, resolveDispatchModel, resolveDispatchEffort } = await import("../src/server/harnesses.ts");
const { applySkillsConfig } = await import("../src/server/skills/config.ts");
const { savePlan } = await import("../src/server/plans/store.ts");
const { planAuthority } = await import("../src/server/plans/authority.ts");

function gitRepo(name: string): string {
  const path = join(repos, name);
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["-C", path, "init", "-q"]);
  return realpathSync(path);
}
const repoA = gitRepo("primary");
const repoB = gitRepo("secondary");
afterEach(() => openDb().exec("DELETE FROM app_config"));
after(() => rmSync(home, { recursive: true, force: true }));

/** Real stdio MCP -> authenticated HTTP -> route validation -> TaskManager -> SQLite. */
async function fixture(t: TestContext, oldDaemon = false, archives?: TaskArchiveGate) {
  const registry = new Registry();
  const tasks = new TaskManager(registry, undefined, undefined, undefined, archives);
  const queues = new QueueManager(registry);
  const workflows = new WorkflowManager(registry);
  const reviews = new ReviewManager(registry);
  const app = buildApp({ registry, tasks, queues, workflows, reviews });
  const paths: string[] = [];
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      paths.push(path);
      if (oldDaemon && (path === "/mcp/v3/tasks" || path.endsWith("/update") || path === "/mcp/tasks/delete")) {
        return new Response("Not Found", { status: 404 });
      }
      return app.fetch(req);
    },
  });
  const client = new Client({ name: "backlog-test", version: "1" });
  t.after(async () => {
    await client.close();
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    await workflows.stop();
  });
  await new Promise<void>((resolve) => server.listening ? resolve() : server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", fileURLToPath(new URL("../src/mcp/server.ts", import.meta.url))],
    env: {
      ...process.env,
      MISSION_HOME: home,
      MISSION_API_TOKEN: ensureToken(),
      MISSION_PORT: String(address.port),
      MISSION_SESSION_ID: "sdk:backlog-test",
    } as Record<string, string>,
    stderr: "pipe",
  }));
  async function call<T = Task & { repository: string; additionalRepositories: string[] }>(name: string, args: Record<string, unknown>, error?: RegExp) {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as Array<{ type: string; text: string }>;
    const text = content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
    assert.equal(Boolean(result.isError), Boolean(error), text);
    if (error) {
      assert.match(text, error);
      return null;
    }
    return JSON.parse(text) as T;
  }
  async function create(over: Record<string, unknown> = {}) {
    return (await call("create_task", { title: "Backlog work", intent: "Deliver the requested change", repository: repoA, ...over }))!;
  }
  return { client, call, create, registry, tasks, app, paths, reviews };
}

test("MCP configuration and exact local plan inputs coexist without changing either dependency boundary", async (t) => {
  applySkillsConfig({ planStorage: "local", commitPlanHtml: true });
  const f = await fixture(t);
  const defaultPlan = await f.create({ kind: "plan" });
  assert.equal(defaultPlan.workflowId, LOCAL_PLAN_VALIDATION_WORKFLOW_ID);
  assert.deepEqual(getTask(defaultPlan.id)!.planPolicy, { version: 2, storage: "local", commitPlanHtml: true });

  const source = await f.create({ kind: "plan", workflowId: null });
  f.registry.applyDiscovery([{
    syntheticId: "sdk:backlog-test", agent: "claude", name: "Local plan author", nameSource: "process",
    cwd: repoA, repoRoot: repoA, gitRoot: repoA, gitBranch: "plan/local",
    pid: 101, tty: null, terminals: [], startedAt: Date.now(),
  }]);
  f.registry.applyHook({ agent: "claude", event: "Stop", sessionId: "local-plan-author", cwd: repoA, transcriptPath: null, env: {} });
  f.registry.upsertTask({ ...getTask(source.id)!, status: "running", sessionId: "sdk:backlog-test", worktreePath: repoA });
  const saved = await savePlan(planAuthority(f.registry, f.registry.getSession("sdk:backlog-test")!, "repo-01"), {
    repoSlot: "repo-01", requestId: randomUUID(), slug: "merged-mcp-contract", expectedRevision: 0,
    files: [{ name: "plan.md", content: "# Exact plan" }, { name: "plan.html", content: "<h1>Exact plan</h1>" }],
  });
  const identity = { repoKey: saved.manifest.repoKey, planId: saved.manifest.planId, revision: 1 };
  const planInputs = [{ ...identity, files: ["plan.md"] }];
  await f.call("create_task", { title: "Unapproved plan", intent: "Must wait for approval", repository: repoA, workflowId: null,
    planInputs, dependencies: [{ type: "plan", ...identity }] }, /explicit human approval/);
  await f.call("create_task", { title: "Too many prerequisites", intent: "All dependency forms share one cap", repository: repoA, workflowId: null,
    planInputs, planPrerequisites: [identity], dependsOnTaskIds: Array.from({ length: 50 }, (_, i) => `prerequisite-${i}`) }, /at most 50 task dependencies/);
  const reviewResponse = await f.app.request("/mcp/v2/reviews", {
    method: "POST", headers: { "content-type": "application/json", "x-harness-token": ensureToken() },
    body: JSON.stringify({ env: {}, sessionId: "sdk:backlog-test", cwd: repoA, kind: "plan-decisions", title: "Approve exact plan", body: "Review the final bundle", managedPlan: { repoSlot: "repo-01", planId: identity.planId, revision: 1 } }),
  });
  assert.equal(reviewResponse.status, 200, await reviewResponse.clone().text());
  const review = await reviewResponse.json() as { id: string };
  f.reviews.resolve(review.id, "answer", null, "human", [{ decisionId: "approve-final-bundle", selected: ["approve"], other: null }]);
  const code = await f.create({ workflowId: null });
  const created = await f.create({ kind: "bugfix", agent: "codex", model: "gpt-6-sol", effort: "high", workflowId: null,
    planInputs, planPrerequisites: [identity], dependencies: [{ type: "task", taskId: code.id }] });
  const stored = getTask(created.id)!;
  assert.deepEqual(stored.planInputs, planInputs);
  assert.deepEqual(created.planInputs, planInputs);
  assert.equal(stored.kind, "bugfix");
  assert.equal(stored.model, "gpt-6-sol");
  assert.equal(stored.effort, "high");
  assert.deepEqual(stored.dependencies.map((edge) => edge.type), ["task", "plan"]);
  assert.ok(stored.dependencies.every((edge) => edge.satisfiedAt === null));
  const edited = await f.call("update_task", { taskId: created.id, title: "Retain exact input", priority: "high" });
  assert.equal(edited!.priority, "high");
  assert.deepEqual(getTask(created.id)!.planInputs, planInputs);
  const read = (await f.call("get_task", { taskId: created.id }))!;
  assert.deepEqual(read.planInputs, planInputs);
  assert.deepEqual(read.dependencies, stored.dependencies);

  await t.test("list_tasks returns saved configuration, exact plan inputs and the running task's durable PR", async () => {
    const labels = ["mcp", "read-payload"];
    await f.call("update_task", { taskId: created.id, labels, enabled: false });
    const sessionId = `sdk:listed-${created.id}`;
    const prUrl = "https://github.com/example/repo/pull/1369";
    // Persist execution facts without launching a session. The PR exists only in the
    // work-episode binding: a running task has no completion outcome to fall back to.
    openDb().prepare("UPDATE tasks SET status = 'running', session_id = ? WHERE id = ?")
      .run(sessionId, created.id);
    openDb().prepare(`INSERT INTO task_work_episode_bindings
      (task_id, episode_id, session_id, agent_session_id, pr_url, bound_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, 1)`).run(created.id, randomUUID(), sessionId, "listed-native-id", prUrl);

    const page = (await f.call<TaskPage>("list_tasks", { repository: repoA, status: "running", labels }))!;
    assert.equal(page.tasks.length, 1);
    assert.equal(page.nextCursor, null);
    const listed = page.tasks[0]!;
    const expected = {
      id: created.id,
      title: "Retain exact input",
      status: "running",
      kind: "bugfix",
      repository: repoA,
      additionalRepositories: [],
      agent: "codex",
      model: "gpt-6-sol",
      effort: "high",
      advisorModel: null,
      workflowId: null,
      planPolicy: stored.planPolicy,
      priority: "high",
      labels,
      enabled: false,
      dependencies: stored.dependencies,
      planInputs,
      sessionId,
      prUrl,
      outcomeUrl: null,
    };
    for (const [field, value] of Object.entries(expected)) {
      assert.deepEqual(listed[field as keyof ReadTask], value, `list_tasks preserves ${field}`);
    }
    assert.equal(Object.hasOwn(listed, "intent"), false, "the default list remains compact");
    const full = (await f.call<TaskPage>("list_tasks", { repository: repoA, status: "running", labels, includeIntent: true }))!;
    assert.deepEqual(full.tasks, [{ ...listed, intent: stored.intent }], "full lists retain every summary field and add intent");
  });
});

test("MCP advertises and persists every backlog configuration field without launching", async (t) => {
  const f = await fixture(t);
  const tools = (await f.client.listTools()).tools;
  for (const name of ["create_task", "update_task"]) {
    const tool = tools.find((entry) => entry.name === name)!;
    assert.ok(tool);
    for (const field of Object.keys(McpTaskConfigurationSchema.shape)) {
      assert.ok(tool.inputSchema.properties?.[field], `${name} advertises ${field}`);
    }
  }
  const prerequisite = await f.create();
  const created = await f.create({
    kind: "bugfix", agent: "codex", model: "gpt-6-sol", effort: "high",
    workflowId: DEFAULT_WORKFLOW_POLICY.defaultWorkflowId, enabled: false,
    priority: "high", labels: [" api ", "api", "mcp"],
    additionalRepositories: ["secondary"], dependsOnTaskIds: [prerequisite.id],
  });
  const stored = getTask(created.id)!;
  assert.equal(created.agent, "codex");
  assert.equal(created.model, "gpt-6-sol");
  assert.equal(created.effort, "high");
  assert.equal(created.kind, "bugfix");
  assert.equal(created.workflowId, DEFAULT_WORKFLOW_POLICY.defaultWorkflowId);
  assert.equal(created.enabled, false);
  assert.equal(created.priority, "high");
  assert.deepEqual(created.labels, ["api", "mcp"]);
  assert.equal(created.repository, repoA);
  assert.deepEqual(created.additionalRepositories, [repoB]);
  assert.equal(stored.dependencies[0]?.type, "task");
  assert.equal(stored.status, "backlog");
  assert.equal(stored.sessionId, null);
  assert.equal(stored.worktreePath, null);
  for (const field of Object.keys(McpTaskConfigurationSchema.shape) as Array<keyof Task>) {
    assert.deepEqual(stored[field], created[field], `persisted ${field}`);
  }
  assert.deepEqual(f.paths, ["/mcp/v2/tasks", "/mcp/v3/tasks"]);
});

test("MCP accepts and persists exactly 50 combined direct and shortcut dependencies", async (t) => {
  const f = await fixture(t);
  const prerequisites = Array.from({ length: 50 }, (_, i) => f.tasks.create({
    title: `Prerequisite ${i + 1}`, intent: "Complete before the dependent task",
    repoRoot: repoA, kind: "ship", backlog: true,
  }));
  const created = await f.create({
    dependencies: prerequisites.slice(0, 49).map((task) => ({ type: "task", taskId: task.id })),
    dependsOnTaskIds: [prerequisites[49]!.id],
  });
  const stored = getTask(created.id)!;
  const expected = prerequisites.map((task) => ({ type: "task", taskId: task.id }));
  assert.equal(stored.status, "backlog");
  assert.equal(stored.dependencies.length, 50);
  assert.deepEqual(stored.dependencies.map((edge) => ({
    type: edge.type, taskId: edge.type === "task" ? edge.taskId : null,
  })), expected);
  assert.ok(stored.dependencies.every((edge) => edge.satisfiedAt === null));
  assert.deepEqual(created.dependencies, stored.dependencies);
  assert.deepEqual(f.paths, ["/mcp/v3/tasks"]);
});

test("MCP creation inherits the selected non-Ship kind's configured harness when agent is omitted", async (t) => {
  setHarnessesConfig({ kindDefaults: { ship: { agent: "claude" }, bugfix: { agent: "codex" } } });
  const f = await fixture(t);
  const created = await f.create({ kind: "bugfix" });
  const stored = getTask(created.id)!;
  assert.equal(created.kind, "bugfix");
  assert.equal(created.agent, "codex");
  assert.equal(stored.kind, "bugfix");
  assert.equal(stored.agent, "codex");
  assert.equal(stored.status, "backlog");
  assert.deepEqual(f.paths, ["/mcp/v3/tasks"]);
});

test("MCP defaults stay inherited and edits preserve, replace, and clear saved configuration", async (t) => {
  setHarnessesConfig({ kindDefaults: { ship: { agent: "codex" } } });
  const f = await fixture(t);
  const defaults = await f.create();
  assert.equal(defaults.agent, "codex");
  assert.equal(defaults.model, null);
  assert.equal(defaults.effort, null);
  const configuredDefault = await f.create({ enabled: false });
  assert.equal(configuredDefault.agent, "codex");
  assert.equal(configuredDefault.model, null);
  assert.equal(configuredDefault.effort, null);
  setHarnessesConfig({ defaultModel: { codex: "gpt-6-sol" }, defaultEffort: { codex: "high" } });
  const storedDefault = getTask(configuredDefault.id)!;
  assert.equal(resolveDispatchModel(storedDefault.agent, storedDefault.model), "gpt-6-sol");
  assert.equal(resolveDispatchEffort(storedDefault.agent, storedDefault.effort), "high");

  const patch = {
    title: "Edited task", intent: "A revised outcome", kind: "bugfix", agent: "claude",
    model: "claude-opus-4-8", effort: "high", workflowId: null,
    enabled: false, priority: "blocker", labels: ["edited"],
    repository: "secondary", additionalRepositories: [repoA],
    dependencies: [{ type: "task", taskId: defaults.id }],
  };
  const edited = (await f.call("update_task", { taskId: configuredDefault.id, ...patch }))!;
  assert.equal(edited.repository, repoB);
  assert.deepEqual(edited.additionalRepositories, [repoA]);
  for (const field of ["title", "intent", "kind", "agent", "model", "effort", "workflowId", "enabled", "priority", "labels"] as const) {
    assert.deepEqual(edited[field], patch[field], field);
  }
  assert.equal(edited.dependencies[0]?.type === "task" && edited.dependencies[0].taskId, defaults.id);
  const marked = (await f.call("update_task", { taskId: edited.id, priority: "low" }))!;
  assert.equal(marked.title, edited.title);
  assert.equal(marked.model, edited.model);
  assert.deepEqual(marked.dependencies, edited.dependencies);

  const cleared = (await f.call("update_task", {
    taskId: edited.id, model: null, effort: null, priority: null, labels: [],
    dependencies: [], additionalRepositories: [], enabled: true,
  }))!;
  assert.equal(cleared.model, null);
  assert.equal(cleared.effort, null);
  assert.equal(cleared.priority, null);
  assert.equal(cleared.enabled, true);
  assert.deepEqual(cleared.labels, []);
  assert.deepEqual(cleared.dependencies, []);
  assert.deepEqual(cleared.additionalRepositories, []);
  await f.call("update_task", { taskId: edited.id, model: "claude-opus-4-8", effort: "high" });
  const switched = (await f.call("update_task", { taskId: edited.id, agent: "codex" }))!;
  assert.equal(switched.model, null);
  assert.equal(switched.effort, null);
  assert.equal(getTask(edited.id)?.agent, "codex");
  assert.equal(getTask(edited.id)?.status, "backlog");
});

test("MCP refuses invalid configuration, dependencies, repositories, and non-backlog edits atomically", async (t) => {
  const f = await fixture(t);
  const task = await f.create({ workflowId: null, model: "gpt-6-sol", agent: "codex" });
  const before = getTask(task.id);
  for (const [patch, error] of [
    [{ model: "--bad-model" }, /model id/],
    [{ effort: "impossible" }, /Invalid enum/],
    [{ kind: "chat" }, /launched immediately/],
    [{ agent: "codex", effort: "max" }, /not supported/],
    [{ workflowId: "missing-workflow" }, /published version/],
    [{ dependencies: [{ type: "task", taskId: task.id }] }, /itself/],
    [{ dependencies: [{ type: "task", taskId: "missing" }] }, /no longer available/],
    [{ repository: repoB, additionalRepositories: [repoB] }, /primary repo/],
    [{}, /empty task update/],
  ] as Array<[Record<string, unknown>, RegExp]>) {
    await f.call("update_task", { taskId: task.id, ...patch }, error);
    assert.deepEqual(getTask(task.id), before, "rejected edit leaves the entire task unchanged");
  }
  const dependent = await f.create({ workflowId: null, dependsOnTaskIds: [task.id] });
  await f.call("update_task", { taskId: task.id, dependencies: [{ type: "task", taskId: dependent.id }] }, /cycle/);
  for (const args of [
    { model: "--bad-model" }, { kind: "chat" }, { workflowId: "missing-workflow" },
    { agent: "codex", effort: "max" },
    { dependencies: Array.from({ length: 50 }, (_, i) => ({ type: "task", taskId: `task-${i}` })), dependsOnTaskIds: [task.id] },
  ]) {
    const count = f.registry.snapshot().tasks.length;
    await f.call("create_task", { title: "Rejected", intent: "No task should be saved", repository: repoA, ...args }, /model id|launched immediately|published version|at most 50|not supported/);
    assert.equal(f.registry.snapshot().tasks.length, count);
  }
  await f.call("update_task", { taskId: "missing", title: "No" }, /no such task/);
  for (const status of ["dispatching", "running", "done", "failed", "cancelled"] as const) {
    f.registry.upsertTask({ ...getTask(task.id)!, status });
    await f.call("update_task", { taskId: task.id, priority: "high" }, /not in the backlog/);
    assert.equal(getTask(task.id)?.priority, null);
  }
  const unauthenticated = await f.app.request(`/mcp/tasks/${task.id}/update`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "No" }),
  });
  assert.equal(unauthenticated.status, 401);
});

test("the daemon independently rejects malformed configuration and inherited unsupported effort", async (t) => {
  const f = await fixture(t);
  const task = await f.create({ workflowId: null });
  setHarnessesConfig({ kindDefaults: { ship: { agent: "codex" } } });
  const headers = { "content-type": "application/json", "x-harness-token": ensureToken() };
  const before = getTask(task.id);
  const count = f.registry.snapshot().tasks.length;
  for (const config of [{ model: "--bad-model" }, { effort: "max" }, { kind: "chat" }, { launchNow: true }]) {
    const response = await f.app.request("/mcp/v3/tasks", {
      method: "POST", headers,
      body: JSON.stringify({ env: {}, cwd: repoA, repoRoot: repoA, title: "No write", intent: "Invalid config", workflowId: null, ...config }),
    });
    assert.equal(response.status, 400, await response.text());
    assert.equal(f.registry.snapshot().tasks.length, count);
  }
  for (const patch of [{ model: "--bad-model" }, { kind: "chat" }, { status: "running" }, {}]) {
    const response = await f.app.request(`/mcp/tasks/${task.id}/update`, {
      method: "POST", headers, body: JSON.stringify(patch),
    });
    assert.equal(response.status, 400, await response.text());
    assert.deepEqual(getTask(task.id), before);
  }
});

test("a task can no longer be created with an advisor pin: MCP refuses the key, the dashboard drops it", async (t) => {
  // The advisor moved to Settings -> Harnesses. The MCP create schema is strict, so an agent
  // still sending a pin is told; the dashboard's dispatch schema strips it like any unknown
  // key, and the task is stored with no pin either way.
  const f = await fixture(t);
  const count = f.registry.snapshot().tasks.length;
  const mcp = await f.app.request("/mcp/v3/tasks", {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": ensureToken() },
    body: JSON.stringify({ env: {}, cwd: repoA, repoRoot: repoA, title: "Advisor pin", intent: "No pin here",
      workflowId: null, advisorModel: "opus" }),
  });
  assert.equal(mcp.status, 400);
  assert.match(((await mcp.json()) as { error: string }).error, /Unrecognized key\(s\) in object: 'advisorModel'/);
  assert.equal(f.registry.snapshot().tasks.length, count);
  const dashboard = await f.app.request("/api/tasks", {
    method: "POST",
    headers: { host: "127.0.0.1:7317", "content-type": "application/json" },
    body: JSON.stringify({ repoRoot: repoA, title: "Advisor pin", intent: "No pin here",
      workflowId: null, backlog: true, advisorModel: "off" }),
  });
  assert.equal(dashboard.status, 200);
  const created = (await dashboard.json()) as { id: string; advisorModel: string | null };
  assert.equal(created.advisorModel, null);
});

test("configured MCP tasks combine direct prerequisites and the calling session", async (t) => {
  const f = await fixture(t);
  const prerequisite = await f.create();
  const args = {
    title: "Dependent work", intent: "Wait for the plan", repository: repoB,
    model: "gpt-6-sol", agent: "codex", effort: "high", workflowId: null,
    dependencies: [{ type: "task", taskId: prerequisite.id }], dependsOnCurrentSession: true,
  };
  await f.call("create_task", args, /no matching active session/);
  f.registry.applyDiscovery([{
    syntheticId: "sdk:backlog-test", agent: "claude", name: "Planning", nameSource: "process",
    cwd: repoA, repoRoot: repoA, gitRoot: repoA, gitBranch: "plan/backlog-tools",
    pid: 101, tty: null, terminals: [], startedAt: Date.now(),
  }]);
  f.registry.applyHook({
    agent: "claude", event: "Stop", sessionId: "native-planning-id", cwd: repoA,
    transcriptPath: null, env: {},
  });
  const created = (await f.call("create_task", args))!;
  assert.equal(created.model, "gpt-6-sol");
  assert.equal(created.effort, "high");
  assert.deepEqual(created.dependencies.map((edge) => edge.type === "task" ? edge.taskId : edge.sessionId), [prerequisite.id, "sdk:backlog-test"]);
  assert.equal(created.status, "backlog");
});

test("MCP refuses an exited calling-session dependency without saving a task", async (t) => {
  const f = await fixture(t);
  f.registry.applyDiscovery([{
    syntheticId: "sdk:backlog-test", agent: "claude", name: "Finished planning", nameSource: "process",
    cwd: repoA, repoRoot: repoA, gitRoot: repoA, gitBranch: "plan/backlog-tools",
    pid: 101, tty: null, terminals: [], startedAt: Date.now(),
  }]);
  f.registry.applyHook({
    agent: "claude", event: "Stop", sessionId: "native-exited-planning-id", cwd: repoA,
    transcriptPath: null, env: {},
  });
  f.registry.applyDiscovery([]);
  assert.equal(f.registry.findSessionByEnv({}, "sdk:backlog-test")?.state, "exited");
  const before = listTasks();
  await f.call("create_task", {
    title: "Rejected dependency", intent: "Wait for the exited caller", repository: repoA,
    workflowId: null, dependsOnCurrentSession: true,
  }, /no matching active session/);
  assert.deepEqual(listTasks(), before, "refusal leaves persisted tasks unchanged");
  assert.deepEqual(f.paths, ["/mcp/v3/tasks"]);
});

test("new task configuration never falls back to an older daemon that would drop it", async (t) => {
  const f = await fixture(t, true);
  const before = f.registry.snapshot().tasks.length;
  await f.call("create_task", { title: "New config", intent: "Keep the chosen model", model: "gpt-6-sol", enabled: false }, /restart Mission Control.*no task was created/);
  assert.deepEqual(f.paths, ["/mcp/v3/tasks"]);
  assert.equal(f.registry.snapshot().tasks.length, before);
  // Legacy callers still use the original routes and defaults.
  await f.create();
  await f.call("create_task", { title: "Legacy", intent: "Current repo", additionalRepositories: [] });
  assert.deepEqual(f.paths, ["/mcp/v3/tasks", "/mcp/v2/tasks", "/mcp/tasks"]);
  await f.call("update_task", { taskId: "old-task", model: null }, /Could not update task \(404\)/);
  assert.equal(f.paths.at(-1), "/mcp/tasks/old-task/update");
  const retained = await f.create();
  await f.call("delete_task", { taskId: retained.id }, /Could not delete task \(404\)/);
  assert.equal(f.paths.at(-1), "/mcp/tasks/delete");
  assert.ok(getTask(retained.id), "an unsupported delete route never falls back to another operation");
});

test("MCP deletes backlog and finished tasks durably and publishes each removal", async (t) => {
  const f = await fixture(t);
  const tool = (await f.client.listTools()).tools.find((entry) => entry.name === "delete_task");
  assert.ok(tool);
  assert.deepEqual(tool.inputSchema.required, ["taskId"]);
  const prerequisite = await f.create();
  const seen: string[] = [];
  f.registry.on("event", (event) => {
    if (event.type === "task_remove") seen.push(event.id);
  });
  for (const status of ["backlog", "done", "failed", "cancelled"] as const) {
    const task = await f.create({ enabled: false, dependsOnTaskIds: [prerequisite.id] });
    f.registry.upsertTask({ ...getTask(task.id)!, status });
    const result = await f.call("delete_task", { taskId: task.id });
    assert.deepEqual(result, { taskId: task.id, deleted: true });
    assert.equal(getTask(task.id), undefined);
    assert.equal(f.registry.getTask(task.id), undefined);
    assert.equal(seen.at(-1), task.id);
    assert.ok(getTask(prerequisite.id), "deleting a dependent preserves its prerequisite");
    await f.call("delete_task", { taskId: task.id }, /Could not delete task \(404\).*no such task/);
  }
  assert.equal(seen.length, 4, "only successful removals emit task_remove");
});

test("MCP deletion refuses active tasks, invalid ids, unknown fields, and unauthenticated calls", async (t) => {
  const f = await fixture(t);
  const task = await f.create();
  for (const status of ["dispatching", "running"] as const) {
    f.registry.upsertTask({ ...getTask(task.id)!, status });
    const before = getTask(task.id);
    await f.call("delete_task", { taskId: task.id }, /Could not delete task \(409\).*cancel the task before removing it/);
    assert.deepEqual(getTask(task.id), before);
  }
  await f.call("delete_task", { taskId: " " }, /validation/i);
  await f.call("delete_task", { taskId: task.id, force: true }, /validation/i);
  const unauthenticated = await f.app.request("/mcp/tasks/delete", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId: task.id }),
  });
  assert.equal(unauthenticated.status, 401);
  for (const body of [{}, { taskId: " " }, { taskId: 123 }, { taskId: task.id, force: true }]) {
    const response = await f.app.request("/mcp/tasks/delete", {
      method: "POST", headers: { "content-type": "application/json", "x-harness-token": ensureToken() },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 400, await response.text());
  }
  assert.equal(getTask(task.id)?.status, "running");
});

test("MCP deletion keeps the record on an archive cleanup refusal and succeeds after retry", async (t) => {
  let ready = false;
  const calls: string[] = [];
  const f = await fixture(t, false, {
    ensureReady: async () => ({ ok: true }),
    settleBeforeCleanup: async (taskId) => {
      assert.ok(getTask(taskId), "archive gate runs before durable deletion");
      calls.push(taskId);
      return ready ? { ok: true } : { ok: false, error: "archive is not ready for cleanup" };
    },
  });
  const task = await f.create();
  const before = getTask(task.id);
  await f.call("delete_task", { taskId: task.id }, /Could not delete task \(409\).*archive is not ready for cleanup/);
  assert.deepEqual(getTask(task.id), before);
  ready = true;
  assert.deepEqual(await f.call("delete_task", { taskId: task.id }), { taskId: task.id, deleted: true });
  assert.equal(getTask(task.id), undefined);
  assert.deepEqual(calls, [task.id, task.id]);
});

test("a backlog-only edit rechecks status after asynchronous preparation", async () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const task = tasks.create({ title: "Race", intent: "Stay shelved", repoRoot: repoA, kind: "ship", backlog: true });
  const updating = tasks.update(task.id, { priority: "high" }, { backlogOnly: true });
  registry.upsertTask({ ...task, status: "running" });
  const result = await updating;
  assert.equal(result.ok, false);
  assert.match(result.error!, /not in the backlog/);
  assert.equal(getTask(task.id)?.status, "running");
  assert.equal(getTask(task.id)?.priority, null);
});

test("concurrent backlog-only edits refuse a stale update and preserve the newer saved task", async () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const task = tasks.create({ title: "Race", intent: "Stay shelved", repoRoot: repoA, kind: "ship", backlog: true });
  // Both edits prepare from the same row before either resumes to save it.
  const saving = tasks.update(task.id, { title: "Saved meanwhile", priority: "low" }, { backlogOnly: true });
  const stale = tasks.update(task.id, { priority: "high" }, { backlogOnly: true });
  const saved = await saving;
  assert.equal(saved.ok, true);
  assert.ok(saved.task);
  assert.equal(saved.task.status, "backlog");
  assert.equal(saved.task.title, "Saved meanwhile");
  assert.equal(saved.task.priority, "low");
  const result = await stale;
  assert.equal(result.ok, false);
  assert.equal(result.error, "task changed while preparing the update; retry");
  const stored = getTask(task.id)!;
  for (const field of Object.keys(saved.task) as Array<keyof Task>) {
    assert.deepEqual(stored[field], saved.task[field], `stale edit preserves saved ${field}`);
  }
  assert.equal(registry.getTask(task.id), saved.task);
});

test("MCP creates and edits storage overrides without changing global settings", async (t) => {
  const f = await fixture(t);
  applySkillsConfig({ planStorage: "repository" });
  const local = await f.create({ kind: "plan", planStorage: "local" });
  assert.equal(local.planPolicy?.storage, "local");
  assert.equal(local.workflowId, LOCAL_PLAN_VALIDATION_WORKFLOW_ID);
  const repository = await f.create({ kind: "plan" });
  assert.equal(repository.planPolicy?.storage, "repository");
  const changed = await f.call("update_task", { taskId: local.id, planStorage: "repository" });
  assert.equal(changed?.planPolicy?.storage, "repository");
  applySkillsConfig({ planStorage: "local" });
  const explicitRepo = await f.create({ kind: "plan", planStorage: "repository" });
  assert.equal(explicitRepo.planPolicy?.storage, "repository");
  const inherited = await f.call("update_task", { taskId: local.id, planStorage: null });
  assert.equal(inherited?.planPolicy?.storage, "local");
  await f.call("update_task", { taskId: local.id, planStorage: "invalid" }, /Invalid enum/);
  await f.call("create_task", { title: "Invalid storage kind", intent: "Ship", repository: repoA, kind: "ship", planStorage: "local" }, /only available for plan tasks/);
});

test("MCP rejects storage overrides on backlog ship updates without changing saved state", async (t) => {
  const f = await fixture(t);
  const task = await f.create({ kind: "ship", workflowId: null });
  const before = getTask(task.id)!;
  assert.equal(before.status, "backlog");
  assert.equal(before.kind, "ship");
  const registeredBefore = structuredClone(f.registry.getTask(task.id));
  for (const planStorage of ["local", "repository", null]) {
    await f.call("update_task", {
      taskId: task.id,
      planStorage,
      title: "This change must not be saved",
    }, /Plan storage is only available for plan tasks/);
    assert.deepEqual(getTask(task.id), before, "a refused edit must not change persisted task state");
    assert.deepEqual(f.registry.getTask(task.id), registeredBefore, "a refused edit must not change live task state");
  }
});

test("MCP plan conversion chooses storage-compatible workflows unless explicitly supplied", async (t) => {
  const f = await fixture(t);
  for (const planStorage of ["local", "repository"] as const) {
    const workflowId = planStorage === "local" ? LOCAL_PLAN_VALIDATION_WORKFLOW_ID : PLAN_VALIDATION_WORKFLOW_ID;
    const task = await f.create({ kind: "ship" });
    const converted = await f.call("update_task", { taskId: task.id, kind: "plan", planStorage });
    assert.equal(converted?.workflowId, workflowId);
    assert.equal(getTask(task.id)?.planPolicy?.storage, planStorage);
    const explicitNone = await f.create({ kind: "ship", workflowId: null });
    const withoutWorkflow = await f.call("update_task", { taskId: explicitNone.id, kind: "plan", planStorage, workflowId: null });
    assert.equal(withoutWorkflow?.workflowId, null);
  }
});

type ReadTask = Omit<McpTaskSnapshot, "repoRoot"> & { repository: string; additionalRepositories: string[] };
type TaskPage = { tasks: ReadTask[]; nextCursor: string | null };

test("read-only MCP task tools filter and page durable tasks without writes or session control", async (t) => {
  const f = await fixture(t);
  const label = `read-${randomUUID().slice(0, 8)}`;
  const prerequisite = await f.create({ workflowId: null });
  const config = { workflowId: null, labels: [label, "api"], priority: "high", enabled: false,
    kind: "bugfix", dependsOnTaskIds: [prerequisite.id] };
  const wanted = [];
  for (let i = 0; i < 3; i++) wanted.push(await f.create({ ...config, title: `Read ${i}` }));
  // Each near-match differs in exactly one filter, so dropping any predicate fails.
  for (const patch of [
    { repository: repoB }, { labels: [label] }, { priority: null }, { enabled: true },
    { kind: "ship" }, { dependsOnTaskIds: [] },
  ]) await f.create({ ...config, ...patch });
  const running = await f.create(config);
  openDb().prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(running.id);
  // Identical timestamps exercise the id tie-breaker, not the clock's resolution.
  for (const task of wanted) openDb().prepare("UPDATE tasks SET created_at = 1000 WHERE id = ?").run(task.id);
  const query = { repository: "primary", status: "backlog", kind: "bugfix", labels: [label, "api"],
    priority: "high", enabled: false, dependsOnTaskId: prerequisite.id, limit: 1 };
  const before = listTasks();
  const board = f.registry.snapshot();
  const changes = openDb().prepare("SELECT total_changes() AS n").get();
  const events: unknown[] = [];
  const unsub = f.registry.subscribe((event) => {
    if (event.type.startsWith("task_") || event.type.startsWith("session_")) events.push(event);
  });
  t.after(unsub);
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = (await f.call<TaskPage>("list_tasks", { ...query, ...(cursor ? { cursor } : {}) }))!;
    assert.equal(page.tasks.length, 1);
    const task = page.tasks[0]!;
    assert.equal(Object.hasOwn(task, "intent"), false);
    assert.equal(task.repository, repoA);
    assert.deepEqual(task.labels, [label, "api"]);
    assert.equal(task.sessionId, null);
    assert.equal(task.outcomeUrl, null);
    ids.push(task.id);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.deepEqual(ids, wanted.map((task) => task.id).sort().reverse());
  const full = (await f.call<TaskPage>("list_tasks", { ...query, limit: 100, includeIntent: true }))!;
  assert.equal(full.nextCursor, null);
  assert.equal(full.tasks[0]!.intent, wanted[0]!.intent);
  const empty = (await f.call<TaskPage>("list_tasks", { labels: [randomUUID()] }))!;
  assert.deepEqual(empty, { tasks: [], nextCursor: null });
  assert.deepEqual(listTasks(), before, "no task configuration, status, timestamp or rank changes");
  assert.deepEqual(openDb().prepare("SELECT total_changes() AS n").get(), changes, "no SQLite writes");
  const after = f.registry.snapshot();
  assert.deepEqual(after.sessions, board.sessions, "no sessions launched");
  assert.deepEqual(after.tasks, board.tasks, "no board task mutations");
  assert.deepEqual(events, [], "reads publish no task or session events");
});

test("get_task reads full configuration in every status, including off-board completed tasks", async (t) => {
  const f = await fixture(t);
  const advertised = (await f.client.listTools()).tools;
  for (const name of ["list_tasks", "get_task"]) {
    const tool = advertised.find((tool) => tool.name === name)!;
    assert.match(tool.description!, /read-only/i);
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.destructiveHint, false);
  }
  const label = `statuses-${randomUUID().slice(0, 8)}`;
  for (const status of TASK_STATUSES) {
    const created = await f.create({ title: `Read ${status}`, intent: `Full ${status} intent`, labels: [label],
      workflowId: null, agent: "codex", model: "gpt-6-sol", effort: "high", additionalRepositories: [repoB] });
    // Update storage directly, leaving the board stale, as with records not restored at startup.
    const sessionId = `sdk:private-${created.id}`;
    const prUrl = "https://github.com/example/repo/pull/42";
    const outcomeUrl = status === "running" ? null : prUrl;
    openDb().prepare("UPDATE tasks SET status = ?, session_id = ?, outcome_url = ? WHERE id = ?")
      .run(status, sessionId, outcomeUrl, created.id);
    if (status === "running") {
      openDb().prepare(`INSERT INTO task_work_episode_bindings
        (task_id, episode_id, session_id, agent_session_id, pr_url, bound_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, 1)`).run(created.id, randomUUID(), sessionId, "private-native-id", prUrl);
    }
    const before = getTask(created.id)!;
    const changes = openDb().prepare("SELECT total_changes() AS n").get();
    const read = (await f.call<ReadTask>("get_task", { taskId: created.id }))!;
    for (const [key, value] of Object.entries(created)) {
      if (["status", "dependsOnTaskIds", "dependsOnCurrentSession", "planPrerequisites"].includes(key)) continue;
      assert.deepEqual(read[key as keyof ReadTask], value, `get_task preserves ${key}`);
    }
    assert.equal(read.status, status);
    assert.equal(read.sessionId, sessionId);
    assert.equal(read.outcomeUrl, outcomeUrl);
    assert.equal(read.prUrl, prUrl, "running tasks expose durable PR bindings before an outcome exists");
    assert.equal(read.repoPrs[0]?.prUrl, prUrl);
    assert.equal(Object.hasOwn(read, "transcript"), false);
    const page = (await f.call<TaskPage>("list_tasks", { status, labels: [label], repository: "secondary" }))!;
    assert.deepEqual(page.tasks.map((task) => task.id), [created.id], "status and secondary repo match durable rows");
    assert.deepEqual(getTask(created.id), before);
    assert.deepEqual(openDb().prepare("SELECT total_changes() AS n").get(), changes, "get_task and list_tasks perform no writes");
  }
  await f.call("get_task", { taskId: "missing-task" }, /404.*no such task/);
});

test("task read cursors survive deletion and newer inserts and reject invalid or changed-filter requests", async (t) => {
  const f = await fixture(t);
  const label = `cursor-${randomUUID().slice(0, 8)}`;
  const older = await f.create({ labels: [label], workflowId: null });
  const newer = await f.create({ labels: [label], workflowId: null });
  openDb().prepare("UPDATE tasks SET created_at = 100 WHERE id = ?").run(older.id);
  openDb().prepare("UPDATE tasks SET created_at = 200 WHERE id = ?").run(newer.id);
  const first = (await f.call<TaskPage>("list_tasks", { labels: [label], limit: 1 }))!;
  assert.deepEqual(first.tasks.map((task) => task.id), [newer.id]);
  assert.ok(first.nextCursor);
  await f.call("delete_task", { taskId: newer.id });
  await f.create({ labels: [label], workflowId: null });
  const next = (await f.call<TaskPage>("list_tasks", { labels: [label], cursor: first.nextCursor }))!;
  assert.deepEqual(next.tasks.map((task) => task.id), [older.id]);
  assert.equal(next.nextCursor, null);
  await f.call("list_tasks", { labels: [label], enabled: false, cursor: first.nextCursor }, /Invalid task cursor or changed filters/);
  await f.call("list_tasks", { cursor: "not-a-cursor" }, /Invalid task cursor/);
  for (const body of [{ labels: [label], enabled: false, cursor: first.nextCursor }, { cursor: "not-a-cursor" }]) {
    const response = await f.app.request("/mcp/tasks/list", { method: "POST",
      headers: { "content-type": "application/json", "x-harness-token": ensureToken() }, body: JSON.stringify(body) });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Invalid task cursor or changed filters" });
  }
  for (const args of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { status: "unknown" }, { kind: "unknown" },
    { enabled: "false" }, { labels: "api" }, { priority: "unknown" }, { taskId: "ignored" }]) {
    await f.call("list_tasks", args, /Invalid|Unrecognized|Number/);
  }
  const unset = (await f.call<TaskPage>("list_tasks", { labels: [label], priority: null }))!;
  assert.equal(unset.tasks.length, 2);
});

test("task read HTTP routes enforce token authentication and independent body validation", async (t) => {
  const f = await fixture(t);
  for (const [route, body] of [["list", {}], ["get", { taskId: "missing" }]] as const) {
    for (const token of [undefined, "wrong-token"]) {
      const response = await f.app.request(`/mcp/tasks/${route}`, { method: "POST",
        headers: { "content-type": "application/json", ...(token ? { "x-harness-token": token } : {}) },
        body: JSON.stringify(body) });
      assert.equal(response.status, 401);
    }
  }
  for (const [route, body] of [["list", { limit: 101 }], ["list", { status: "unknown" }],
    ["list", { cursor: "invalid" }], ["get", {}], ["get", { taskId: " " }], ["get", { taskId: "id", intent: "no writes" }]] as const) {
    const response = await f.app.request(`/mcp/tasks/${route}`, { method: "POST",
      headers: { "content-type": "application/json", "x-harness-token": ensureToken() }, body: JSON.stringify(body) });
    assert.equal(response.status, 400, await response.text());
  }
});

test("list_tasks canonicalizes linked worktree repository selectors", async (t) => {
  const f = await fixture(t);
  const root = gitRepo(`read-worktree-${randomUUID().slice(0, 8)}`);
  execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "fixture"]);
  const worktree = join(home, `linked-${randomUUID()}`);
  execFileSync("git", ["-C", root, "worktree", "add", "--detach", worktree], { stdio: "pipe" });
  const first = await f.create({ repository: root, workflowId: null });
  const second = await f.create({ repository: root, workflowId: null });
  const fromWorktree = (await f.call<TaskPage>("list_tasks", { repository: worktree, limit: 1 }))!;
  assert.equal(fromWorktree.tasks[0]!.repository, root);
  assert.ok(fromWorktree.nextCursor);
  const fromRoot = (await f.call<TaskPage>("list_tasks", { repository: root, cursor: fromWorktree.nextCursor }))!;
  assert.deepEqual([...fromWorktree.tasks, ...fromRoot.tasks].map((task) => task.id).sort(), [first.id, second.id].sort());
  assert.equal(fromRoot.nextCursor, null);
});

test("read tools include durable attached-repository PRs without live session feedback", async (t) => {
  const f = await fixture(t);
  const labels = [`attached-pr-${randomUUID().slice(0, 8)}`];
  const created = await f.create({ agent: "codex", additionalRepositories: [repoB], labels, workflowId: null });
  const sessionId = `sdk:attached-pr-${created.id}`;
  const episodeId = randomUUID();
  const abandonedEpisodeId = randomUUID();
  const attachedPrUrl = "https://github.com/example/secondary/pull/1369";
  openDb().prepare(`INSERT INTO task_work_episode_bindings
    (task_id, episode_id, session_id, agent_session_id, bound_at, updated_at)
    VALUES (?, ?, ?, 'attached-native-id', 1, 1)`).run(created.id, episodeId, sessionId);
  openDb().prepare(`INSERT INTO work_episode_prs
    (episode_id, repo_root, session_id, task_id, pr_url, pr_state, pr_head_sha, merged_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'open', 'attached-head', NULL, 1)`)
    .run(episodeId, repoB, sessionId, created.id, attachedPrUrl);
  openDb().prepare(`INSERT INTO work_episode_prs
    (episode_id, repo_root, session_id, task_id, pr_url, pr_state, pr_head_sha, merged_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'open', 'abandoned-head', NULL, 2)`)
    .run(abandonedEpisodeId, repoB, sessionId, created.id, "https://github.com/example/secondary/pull/1368");
  const abandonedRow = openDb().prepare("SELECT * FROM work_episode_prs WHERE task_id = ? AND episode_id = ? AND repo_root = ?");
  const abandonedBefore = abandonedRow.get(created.id, abandonedEpisodeId, repoB);
  assert.equal(f.registry.getTask(created.id)!.extraRepos[0]!.prUrl, null,
    "the live board has not loaded the durable attached PR");
  assert.deepEqual(f.registry.snapshot().sessions, [], "no session or live PR feedback is needed");

  for (const stage of [
    { name: "current open PR", episode: episodeId, status: "running", prUrl: attachedPrUrl, prState: "open", mergedAt: null },
    { name: "abandoned unmerged PR", episode: randomUUID(), status: "running", prUrl: null, prState: null, mergedAt: null },
    { name: "merged PR from a previous episode", episode: randomUUID(), status: "done", prUrl: attachedPrUrl, prState: "merged", mergedAt: 1000 },
  ] as const) {
    openDb().prepare("UPDATE task_work_episode_bindings SET episode_id = ? WHERE task_id = ?")
      .run(stage.episode, created.id);
    openDb().prepare("UPDATE tasks SET status = ?, session_id = ? WHERE id = ?")
      .run(stage.status, sessionId, created.id);
    openDb().prepare("UPDATE work_episode_prs SET pr_state = ?, merged_at = ? WHERE task_id = ? AND episode_id = ? AND repo_root = ?")
      .run(stage.mergedAt === null ? "open" : "merged", stage.mergedAt, created.id, episodeId, repoB);
    const writesBefore = openDb().prepare("SELECT total_changes() AS n").get();
    const task = (await f.call<ReadTask>("get_task", { taskId: created.id }))!;
    const page = (await f.call<TaskPage>("list_tasks", { repository: repoB, labels }))!;
    assert.equal(page.tasks.length, 1);
    const expectedRepos = [
      { repoRoot: repoA, primary: true, prUrl: null, prState: null, mergedAt: null, feedback: null },
      { repoRoot: repoB, primary: false, prUrl: stage.prUrl, prState: stage.prState, mergedAt: stage.mergedAt, feedback: null },
    ];
    for (const [tool, result] of [["get_task", task], ["list_tasks", page.tasks[0]!]] as const) {
      assert.equal(result.id, created.id);
      assert.equal(result.status, stage.status);
      assert.equal(result.prUrl, null, "the secondary PR is not substituted for the primary");
      assert.equal(result.outcomeUrl, null, "there is no outcome URL to fall back to");
      assert.deepEqual(result.repoPrs, expectedRepos, `${tool}: ${stage.name}`);
    }
    assert.deepEqual(openDb().prepare("SELECT total_changes() AS n").get(), writesBefore,
      "loading durable PR bindings is read-only");
    assert.deepEqual(abandonedRow.get(created.id, abandonedEpisodeId, repoB), abandonedBefore,
      "the distinct abandoned open PR is preserved and never returned");
  }
});
