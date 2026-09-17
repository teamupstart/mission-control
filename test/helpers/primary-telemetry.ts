/** Real synchronous owners and HTTP adapters. All process launches are injected fakes. */
import assert from "node:assert/strict";
import { Registry } from "../../src/server/registry.ts";
import { TaskManager } from "../../src/server/tasks.ts";
import { QueueManager } from "../../src/server/queue.ts";
import { ReviewManager } from "../../src/server/reviews.ts";
import { FileCommentManager } from "../../src/server/file-comments.ts";
import { SessionActionManager } from "../../src/server/workflows/session-actions.ts";
import { WorkflowStore } from "../../src/server/workflows/store.ts";
import { ScheduleManager } from "../../src/server/schedules/manager.ts";
import { buildApp } from "../../src/server/routes.ts";
import { openDb } from "../../src/server/db.ts";
import { upsertSdkSession } from "../../src/server/sdk/store.ts";

export async function runPrimaryOwnerFixture(repo: string) {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const queues = new QueueManager(registry);
  const reviews = new ReviewManager(registry);
  const schedules = new ScheduleManager({ tasks, resolveRepoRoot: async () => ({ ok: true, repoRoot: repo }), log: () => {} });
  const sessionActions = new SessionActionManager(registry, new WorkflowStore(openDb()));
  const fileComments = new FileCommentManager(registry);
  const session = registry.registerSdkSession({ id: "sdk:telemetry-owner", agent: "claude", name: "PRIVATE_SENTINEL", cwd: repo, gitBranch: "private", now: Date.now() });
  upsertSdkSession({ id: session.id, agent: "claude", cwd: repo, status: "running", agentSessionId: null, taskId: null, model: null, effort: null, permissionMode: null, turnInProgress: false });
  const app = buildApp({ registry, tasks, queues, reviews, schedules, sessionActions, fileComments,
    launchSessionTerminal: async (_backend, spec) => ({ ok: true, label: "fake", homeName: spec.name, status: 200 }),
  });
  let sequence = 0;
  const request = async (path: string, body: unknown, method = "POST") => {
    const response = await app.request(path, { method,
      headers: { host: "127.0.0.1", "content-type": "application/json", "x-mission-operation-id": String(++sequence).padStart(16, "0"), "x-mission-operation-surface": "board", "x-mission-operation-actor": "human" },
      body: JSON.stringify(body) });
    const result = await response.json() as Record<string, unknown>;
    assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(result)}`);
    return result;
  };
  const attention = reviews.create(session.id, "input", "PRIVATE_SENTINEL", "PRIVATE_SENTINEL");
  await request(`/api/reviews/${attention.id}/resolve`, { action: "approve", response: "PRIVATE_SENTINEL", by: "human" });
  await request(`/api/sessions/${session.id}/rename`, { name: "PRIVATE_SENTINEL renamed" });
  await request("/api/setup/install", { id: "node-runtime", backend: "cmux" });
  const task = await request("/api/tasks", { title: "PRIVATE_SENTINEL", intent: "PRIVATE_SENTINEL", repoRoot: repo, kind: "ship", workflowId: null, backlog: true });
  await request(`/api/tasks/${task.id}/update`, { title: "PRIVATE_SENTINEL edited" });
  await request("/api/session-actions", { name: "PRIVATE_SENTINEL", promptMarkdown: "PRIVATE_SENTINEL", requiredSkillId: "pull-request" });
  await request(`/api/sessions/${session.id}/file-comments`, { path: "PRIVATE_SENTINEL.md", startLine: 1, endLine: 1, quote: "PRIVATE_SENTINEL", revision: "r1", surface: "editor", body: "PRIVATE_SENTINEL" });
  await request(`/api/sessions/${session.id}/queue`, { intent: "PRIVATE_SENTINEL" });
  const queue = queues.get(session.id)!;
  assert.ok(queue.items.length);
  queues.setState(queue.items[0]!.id, { state: "verified" });
  await request(`/api/sessions/${session.id}/foreman-invite`, {});
  await request(`/api/sessions/${session.id}/foreman-invite`, {}, "DELETE");
  await request("/api/ui/config", { richText: false }, "PUT");
  await request("/api/away", { away: false }, "PUT");
  await request("/api/inspector/config", { enabled: false }, "PUT");
  const schedule = await request("/api/schedules", { name: "PRIVATE_SENTINEL", expression: "0 9 * * *", timezone: "UTC", overlapPolicy: "skip-active", missedPolicy: "coalesce-latest",
    completionPolicy: "manual", template: { title: "PRIVATE_SENTINEL", intent: "PRIVATE_SENTINEL", repoRoot: repo, kind: "ship", workflowId: null, agent: "claude", priority: null, labels: [], model: null, effort: null } });
  await request(`/api/schedules/${schedule.id}/run-now`, {});
  return { app, registry, tasks, queues, schedules, sessionId: session.id };
}
