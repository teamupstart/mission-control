import assert from "node:assert/strict";
import test from "node:test";

import type { Task } from "../src/shared/types.ts";
import { Registry } from "../src/server/registry.ts";
import { buildApp } from "../src/server/routes.ts";
import type { SdkSupervisor } from "../src/server/sdk/supervisor.ts";
import type { CreateTaskInput, TaskManager } from "../src/server/tasks.ts";

function tourTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "tour-task",
    title: "Tour demo",
    intent: "[Mission Control See the work tour demo]\n\nWait and ask.",
    kind: "ship",
    agent: "codex",
    priority: null,
    labels: ["tour-demo"],
    dependencies: [],
    enabled: true,
    model: "gpt-5.6-terra",
    effort: null,
    workflowId: null,
    source: null,
    pipelineRun: null,
    repoRoot: process.cwd(),
    worktreePath: null,
    branch: null,
    provider: null,
    worktreeLeaseId: null,
    baseSha: null,
    extraRepos: [],
    homeName: null,
    terminalResourceId: null,
    sessionId: null,
    scheduleId: null,
    scheduleOccurrenceId: null,
    scheduledFor: null,
    status: "backlog",
    outcome: null,
    outcomeUrl: null,
    error: null,
    createdAt: 1,
    updatedAt: 1,
    dispatchedAt: null,
    automaticCleanup: null,
    completedAt: null,
    ...overrides,
  };
}

test("the tour route fixes Terra, the harmless prompt, and request_input at the server", async () => {
  const captured: {
    created?: CreateTaskInput;
    options?: Record<string, unknown>;
  } = {};
  let current = tourTask();
  const tasks = {
    create(input: CreateTaskInput) {
      captured.created = input;
      current = tourTask({ repoRoot: String(input.repoRoot) });
      return current;
    },
    async dispatch(_id: string, input: Record<string, unknown>) {
      captured.options = input;
      current = { ...current, status: "dispatching" };
      return { ok: true as const, task: current };
    },
    get() { return current; },
  } as unknown as TaskManager;
  const app = buildApp(new Registry(), {} as never, tasks, {} as never);

  const response = await app.request("/api/tours/see-work/dispatch", {
    method: "POST",
    headers: { host: "127.0.0.1:7317", "content-type": "application/json" },
    body: JSON.stringify({ repoRoot: process.cwd() }),
  });
  assert.equal(response.status, 200);
  assert.equal(captured.created?.agent, "codex");
  assert.equal(captured.created?.model, "gpt-5.6-terra");
  assert.equal(captured.created?.workflowId, null);
  assert.equal(captured.created?.backlog, true);
  assert.match(String(captured.created?.intent), /Do not edit files/);
  assert.match(String(captured.created?.intent), /enable Foreman, grant Trust/);
  assert.match(String(captured.created?.intent), /request_input/);
  assert.deepEqual(captured.options, {
    overrideDisabled: true,
    missionMcp: { tools: ["request_input"] },
  });
});

test("an empty-fleet preview launches one fixed manual Chat conversation", async () => {
  let captured: CreateTaskInput | undefined;
  let current = tourTask();
  const tasks = {
    create(input: CreateTaskInput) {
      captured = input;
      current = tourTask({
        title: String(input.title),
        intent: input.intent,
        kind: input.kind,
        agent: input.agent,
        model: input.model ?? null,
        workflowId: input.workflowId ?? null,
        labels: input.labels ?? [],
        repoRoot: input.repoRoot,
        status: "dispatching",
      });
      return current;
    },
  } as unknown as TaskManager;
  const app = buildApp(new Registry(), {} as never, tasks, {} as never);

  const response = await app.request("/api/tours/see-work/preview", {
    method: "POST",
    headers: { host: "127.0.0.1:7317", "content-type": "application/json" },
    body: JSON.stringify({ repoRoot: process.cwd() }),
  });
  assert.equal(response.status, 200);
  assert.equal(captured?.title, "Tour conversation");
  assert.equal(captured?.kind, "chat");
  assert.equal(captured?.agent, "codex");
  assert.equal(captured?.model, undefined);
  assert.equal(captured?.workflowId, null);
  assert.equal(captured?.backlog, false);
  assert.deepEqual(captured?.labels, ["tour-demo", "tour-preview"]);
  assert.match(String(captured?.intent), /Do not edit files, run commands, use tools/);
  assert.match(String(captured?.intent), /Conversation holds the exchange/);
});

test("an early tour exit cancels provisioning before recording Tour demo", async () => {
  const calls: string[] = [];
  let current = tourTask({ status: "dispatching" });
  const tasks = {
    get(id: string) { return id === current.id ? current : undefined; },
    async cancel() {
      calls.push("cancel");
      current = { ...current, status: "cancelled" };
      return { ok: true as const };
    },
    async complete(_id: string, outcome: string) {
      calls.push(`complete:${outcome}`);
      current = { ...current, status: "done", outcome };
      return current;
    },
  } as unknown as TaskManager;
  const app = buildApp(new Registry(), {} as never, tasks, {} as never);

  const response = await app.request(`/api/tours/see-work/tasks/${current.id}/complete`, {
    method: "POST",
    headers: { host: "127.0.0.1:7317" },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["cancel", "complete:Tour demo"]);
  assert.equal(current.status, "done");
  assert.equal(current.outcome, "Tour demo");
});

test("the same cleanup doorway recognizes and closes the Chat preview", async () => {
  const calls: string[] = [];
  let current = tourTask({
    title: "Tour conversation",
    intent: "[Mission Control See the work tour conversation]\n\nShow the desk.",
    kind: "chat",
    labels: ["tour-demo", "tour-preview"],
    model: null,
    status: "dispatching",
  });
  const tasks = {
    get(id: string) { return id === current.id ? current : undefined; },
    async cancel() {
      calls.push("cancel");
      current = { ...current, status: "cancelled" };
      return { ok: true as const };
    },
    async complete(_id: string, outcome: string) {
      calls.push(`complete:${outcome}`);
      current = { ...current, status: "done", outcome };
      return current;
    },
  } as unknown as TaskManager;
  const app = buildApp(new Registry(), {} as never, tasks, {} as never);

  const response = await app.request(`/api/tours/see-work/tasks/${current.id}/complete`, {
    method: "POST",
    headers: { host: "127.0.0.1:7317" },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["cancel", "complete:Tour conversation"]);
  assert.equal(current.outcome, "Tour conversation");
});

test("tour cleanup reconciles a registered SDK session after its driver is already gone", async () => {
  const registry = new Registry();
  const session = registry.registerSdkSession({
    id: "sdk:tour-cleanup",
    agent: "codex",
    name: "Tour demo",
    cwd: process.cwd(),
  });
  let current = tourTask({ sessionId: session.id, status: "running" });
  const tasks = {
    get(id: string) { return id === current.id ? current : undefined; },
    async complete(_id: string, outcome: string) {
      current = { ...current, status: "done", outcome };
      return current;
    },
  } as unknown as TaskManager;
  const supervisor = {
    handleFor: () => null,
  } as unknown as SdkSupervisor;
  const app = buildApp(
    registry,
    {} as never,
    tasks,
    {} as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    supervisor,
  );

  const response = await app.request(`/api/tours/see-work/tasks/${current.id}/complete`, {
    method: "POST",
    headers: { host: "127.0.0.1:7317" },
  });
  assert.equal(response.status, 200);
  assert.equal(current.status, "done");
  assert.equal(registry.getSession(session.id)?.state, "exited");
});
