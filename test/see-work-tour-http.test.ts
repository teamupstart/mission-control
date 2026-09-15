import assert from "node:assert/strict";
import test from "node:test";

import type { Task } from "../src/shared/types.ts";
import { Registry } from "../src/server/registry.ts";
import { buildApp } from "../src/server/routes.ts";
import type { SdkSupervisor } from "../src/server/sdk/supervisor.ts";
import type { CreateTaskInput, TaskManager } from "../src/server/tasks.ts";
import { SERVER_TOURS, serverTour, tourRecipeFor } from "../src/server/tours.ts";

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
    backlogRank: null,
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
  const app = buildApp({ registry: new Registry(), reviews: {} as never, tasks, queues: {} as never });

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
  const app = buildApp({ registry: new Registry(), reviews: {} as never, tasks, queues: {} as never });

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
  const app = buildApp({ registry: new Registry(), reviews: {} as never, tasks, queues: {} as never });

  const response = await app.request(`/api/tours/see-work/tasks/${current.id}/complete`, {
    method: "POST",
    headers: { host: "127.0.0.1:7317" },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["cancel", "complete:Tour demo"]);
  assert.equal(current.status, "done");
  assert.equal(current.outcome, "Tour demo");
});

test("a cancel that left resources behind still records the tour's outcome", async () => {
  // `TaskManager.cancel` answers `ok: false` when the task WAS cancelled but its worktree
  // teardown could not reclaim everything - contention on the pool, a lease still held. That
  // is a warning about trees, not a refusal to cancel, and the route used to return on it and
  // never record the outcome. The task was then left `cancelled` with a null outcome, which is
  // exactly the leftover a tour promises not to produce; it reached CI as an e2e failure whose
  // row still carried its `worktreePath` and `worktreeLeaseId`.
  const calls: string[] = [];
  let current = tourTask({ status: "dispatching" });
  const tasks = {
    get(id: string) { return id === current.id ? current : undefined; },
    async cancel() {
      calls.push("cancel");
      current = { ...current, status: "cancelled" };
      return { ok: false as const, error: "task cancelled, but its resources remain tracked: lease busy" };
    },
    async complete(_id: string, outcome: string) {
      calls.push(`complete:${outcome}`);
      current = { ...current, status: "done", outcome };
      return current;
    },
  } as unknown as TaskManager;
  const app = buildApp({ registry: new Registry(), reviews: {} as never, tasks, queues: {} as never });

  const response = await app.request(`/api/tours/see-work/tasks/${current.id}/complete`, {
    method: "POST",
    headers: { host: "127.0.0.1:7317" },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["cancel", "complete:Tour demo"], "the completion still runs");
  assert.equal(current.status, "done");
  assert.equal(current.outcome, "Tour demo");
  // Not swallowed either: the leftover trees are the operator's problem to see.
  const body = (await response.json()) as { ok: boolean; warning?: string };
  assert.equal(body.ok, true);
  assert.match(String(body.warning), /resources remain tracked/);
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
  const app = buildApp({ registry: new Registry(), reviews: {} as never, tasks, queues: {} as never });

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
  const app = buildApp({ registry, reviews: {} as never, tasks, queues: {} as never, sdkSessions: supervisor });

  const response = await app.request(`/api/tours/see-work/tasks/${current.id}/complete`, {
    method: "POST",
    headers: { host: "127.0.0.1:7317" },
  });
  assert.equal(response.status, 200);
  assert.equal(current.status, "done");
  assert.equal(registry.getSession(session.id)?.state, "exited");
});

test("an unknown tour id is refused before any task is created", async () => {
  let created = 0;
  const tasks = {
    create(input: CreateTaskInput) {
      created += 1;
      return tourTask({ repoRoot: String(input.repoRoot) });
    },
    get() { return tourTask(); },
  } as unknown as TaskManager;
  const app = buildApp({ registry: new Registry(), reviews: {} as never, tasks, queues: {} as never });

  for (const path of [
    "/api/tours/nope/dispatch",
    "/api/tours/nope/preview",
    "/api/tours/nope/tasks/tour-task/complete",
  ]) {
    const response = await app.request(path, {
      method: "POST",
      headers: { host: "127.0.0.1:7317", "content-type": "application/json" },
      body: JSON.stringify({ repoRoot: process.cwd() }),
    });
    assert.equal(response.status, 404, path);
    assert.deepEqual(await response.json(), { ok: false, error: "no such tour" });
  }
  // The generalized URL widened the shape of the route, never its authority: an unknown
  // tour cannot fall through to general dispatch.
  assert.equal(created, 0);
});

test("the Library tour has no server recipe, so every tour route refuses it", async () => {
  let created = 0;
  const tasks = {
    create(input: CreateTaskInput) {
      created += 1;
      return tourTask({ repoRoot: String(input.repoRoot) });
    },
    get() { return tourTask(); },
  } as unknown as TaskManager;
  const app = buildApp({ registry: new Registry(), reviews: {} as never, tasks, queues: {} as never });

  // A registered BROWSER tour is not a registered server tour. The Library tour creates
  // nothing - no task, no session, no binding - so it declares no operation, and asking for
  // one on its behalf is refused with the same answer an invented id gets rather than
  // falling through to general dispatch.
  assert.equal(serverTour("library"), null);
  for (const path of [
    "/api/tours/library/dispatch",
    "/api/tours/library/preview",
    "/api/tours/library/tasks/tour-task/complete",
  ]) {
    const response = await app.request(path, {
      method: "POST",
      headers: { host: "127.0.0.1:7317", "content-type": "application/json" },
      body: JSON.stringify({ repoRoot: process.cwd() }),
    });
    assert.equal(response.status, 404, path);
    assert.deepEqual(await response.json(), { ok: false, error: "no such tour" });
  }
  assert.equal(created, 0);
});

test("cleanup refuses a task the named tour did not create", async () => {
  const stranger = tourTask({
    id: "real-work",
    title: "Ship the thing",
    intent: "Do the actual work",
    labels: [],
  });
  const calls: string[] = [];
  const tasks = {
    get(id: string) { return id === stranger.id ? stranger : undefined; },
    async cancel() { calls.push("cancel"); return { ok: true as const }; },
    async complete() { calls.push("complete"); return stranger; },
  } as unknown as TaskManager;
  const app = buildApp({ registry: new Registry(), reviews: {} as never, tasks, queues: {} as never });

  const response = await app.request(`/api/tours/see-work/tasks/${stranger.id}/complete`, {
    method: "POST",
    headers: { host: "127.0.0.1:7317" },
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "that task does not belong to the tour",
  });
  assert.deepEqual(calls, []);
});

test("the See the work recipes stay byte-for-byte what they were", () => {
  const tour = serverTour("see-work")!;
  assert.ok(tour);
  assert.deepEqual(Object.keys(tour.operations).sort(), ["dispatch", "preview"]);
  assert.equal(tour.operations.dispatch?.outcome, "Tour demo");
  assert.equal(tour.operations.preview?.outcome, "Tour conversation");
  assert.equal(tour.operations.dispatch?.create.title, "Tour demo");
  assert.equal(tour.operations.dispatch?.create.model, "gpt-5.6-terra");
  assert.deepEqual(tour.operations.dispatch?.dispatch, {
    overrideDisabled: true,
    missionMcp: { tools: ["request_input"] },
  });
  // The preview is created and left alone; only the demo recipe launches.
  assert.equal(tour.operations.preview?.dispatch, undefined);
  assert.equal(serverTour("nope"), null);
  assert.equal(serverTour(undefined), null);
});

test("identity is matched per recipe, so cleanup names one outcome and only one", () => {
  const tour = SERVER_TOURS["see-work"]!;
  assert.equal(tourRecipeFor(tour, tourTask())?.outcome, "Tour demo");
  assert.equal(
    tourRecipeFor(tour, tourTask({
      title: "Tour conversation",
      kind: "chat",
      labels: ["tour-demo", "tour-preview"],
      intent: "[Mission Control See the work tour conversation]\n\nShow the desk.",
    }))?.outcome,
    "Tour conversation",
  );
  // A right-looking title with the wrong intent prefix is still not the tour's task.
  assert.equal(tourRecipeFor(tour, tourTask({ intent: "Tour demo please" })), null);
  assert.equal(tourRecipeFor(tour, tourTask({ labels: [] })), null);
});
