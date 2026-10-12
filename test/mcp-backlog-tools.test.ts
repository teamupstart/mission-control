import assert from "node:assert/strict";
import { after, afterEach, test, type TestContext } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Task } from "../src/shared/types.ts";
import { DEFAULT_WORKFLOW_POLICY } from "../src/shared/workflow.ts";
import { McpTaskConfigurationSchema } from "../src/shared/protocol.ts";
import type { TaskArchiveGate } from "../src/server/tasks.ts";

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
  const app = buildApp({ registry, tasks, queues, workflows, reviews: new ReviewManager(registry) });
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
  async function call(name: string, args: Record<string, unknown>, error?: RegExp) {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as Array<{ type: string; text: string }>;
    const text = content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
    assert.equal(Boolean(result.isError), Boolean(error), text);
    if (error) {
      assert.match(text, error);
      return null;
    }
    return JSON.parse(text) as Task & { repository: string; additionalRepositories: string[] };
  }
  async function create(over: Record<string, unknown> = {}) {
    return (await call("create_task", { title: "Backlog work", intent: "Deliver the requested change", repository: repoA, ...over }))!;
  }
  return { client, call, create, registry, tasks, app, paths };
}

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
