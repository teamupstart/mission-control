import { after, test } from "node:test";
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

function gitRepo(): string {
  const dir = join(repos, "repo");
  execFileSync("mkdir", ["-p", dir]);
  execFileSync("git", ["-C", dir, "init", "-q"]);
  return realpathSync(dir);
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
  const app = buildApp(registry, {} as ReviewManager, tasks, {} as QueueManager);
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
  const app = buildApp(registry, {} as ReviewManager, tasks, {} as QueueManager);
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
  openDb().exec("DELETE FROM app_config");
});
