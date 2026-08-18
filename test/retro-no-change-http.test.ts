import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QueueManager } from "../src/server/queue.ts";
import type { ReviewManager } from "../src/server/reviews.ts";

const home = mkdtempSync(join(tmpdir(), "mission-retro-no-change-http-"));
process.env.MISSION_HOME = home;

const { ensureToken } = await import("../src/server/auth.ts");
const { Registry } = await import("../src/server/registry.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { RETRO_NO_CHANGE_OUTCOME, TaskManager } = await import("../src/server/tasks.ts");
const { mkTask } = await import("./helpers/session-fixture.ts");

after(() => rmSync(home, { recursive: true, force: true }));

test("the authenticated no-change route settles only its calling retro task", async () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const source = mkTask({
    id: "http-source",
    title: "Source task",
    status: "done",
    outcome: "merged source",
    outcomeUrl: "https://github.example/o/r/pull/1",
  });
  registry.upsertTask(source);
  const retro = tasks.createRetroFollowup({
    sourceTask: source,
    sourceEpisodeId: "http-source-episode",
    sourceSessionId: "http-source-session",
    title: "Retro: Source task",
    intent: "Run the linked retro",
    agent: "claude",
  });
  const running = {
    ...retro,
    status: "running" as const,
    worktreePath: "/worktrees/http-retro",
    sessionId: "sdk:http-retro",
    updatedAt: Date.now(),
  };
  registry.upsertTask(running);
  registry.registerSdkSession({
    id: running.sessionId,
    agent: "claude",
    name: "http retro",
    cwd: running.worktreePath,
    agentSessionId: "agent:http-retro",
  });
  const app = buildApp(registry, {} as ReviewManager, tasks, {} as QueueManager);
  const payload = {
    env: {},
    sessionId: "agent:http-retro",
    cwd: running.worktreePath,
  };

  const unauthorized = await app.request("/mcp/retros/no-change", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(unauthorized.status, 401);

  const callerNamedTask = await app.request("/mcp/retros/no-change", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-harness-token": ensureToken(),
    },
    body: JSON.stringify({ ...payload, taskId: source.id }),
  });
  assert.equal(callerNamedTask.status, 400, "the operation has no caller-controlled target");
  assert.equal(registry.getTask(source.id)?.status, "done");

  const first = await app.request("/mcp/retros/no-change", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-harness-token": ensureToken(),
    },
    body: JSON.stringify(payload),
  });
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.replayed, false);
  assert.equal(firstBody.task.id, retro.id);
  assert.equal(firstBody.task.outcome, RETRO_NO_CHANGE_OUTCOME);
  assert.equal(firstBody.task.outcomeUrl, null);
  assert.equal(registry.getTask(source.id)?.outcome, "merged source");

  const replay = await app.request("/mcp/retros/no-change", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-harness-token": ensureToken(),
    },
    body: JSON.stringify(payload),
  });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).replayed, true);
});
