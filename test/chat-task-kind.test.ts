import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { plannableBacklog, readyBacklog } from "../src/shared/backlog.ts";
import { DispatchSchema, CreateScheduleSchema, UpdateTaskSchema } from "../src/shared/protocol.ts";
import { CHAT_DEPENDENCY_REFUSAL, CHAT_WORKFLOW_REFUSAL, TASK_KIND_BACKLOG_REFUSAL, taskAllowsBacklogAutopilot } from "../src/shared/task.ts";
import { TaskSourceDefaultsSchema } from "../src/shared/task-source.ts";
import { mkTask } from "./helpers/session-fixture.ts";

const home = mkdtempSync(join(tmpdir(), "mission-chat-kind-"));
process.env.HARNESS_HOME = home;

const { Registry } = await import("../src/server/registry.ts");
const {
  INTERRUPTED_CHAT_BEFORE_PROVISION_ERROR,
  MANUAL_DISPATCH_TASK_CREATE,
  TaskKindBacklogError,
  TaskManager,
} = await import("../src/server/tasks.ts");
const { kindMissionMcpRequirement } = await import("../src/server/mission-mcp.ts");
const { withTaskKindContract } = await import("../src/server/task-contract.ts");
const { executionAuthorizationContract } = await import(
  "../src/server/execution-authorization.ts"
);

after(() => rmSync(home, { recursive: true, force: true }));

const chatInput = {
  repoRoot: "/repo",
  intent: "Help me understand the session lifecycle.",
  title: "Session lifecycle conversation",
  kind: "chat" as const,
  agent: "claude" as const,
  workflowId: null,
  backlog: false,
};

test("the dispatch schema accepts only an immediate dependency-free chat", () => {
  const immediate = DispatchSchema.safeParse(chatInput);
  assert.equal(immediate.success, true);
  assert.equal(DispatchSchema.safeParse({ ...chatInput, backlog: true }).success, false);
  assert.equal(
    DispatchSchema.safeParse({
      ...chatInput,
      dependencies: [{ type: "task", taskId: "prerequisite" }],
    }).success,
    false,
  );
  // The schema admits chat as a kind a mission-filed row may be edited into; whether THIS
  // row may hold it is `TaskManager.update`'s answer - see the malformed-row test below.
  assert.equal(UpdateTaskSchema.safeParse({ kind: "chat" }).success, true);
  assert.equal(UpdateTaskSchema.safeParse({ kind: "resident" }).success, false);
});

test("a recurring mission may name chat; a task source still may not", () => {
  assert.equal(
    CreateScheduleSchema.safeParse({
      name: "Conversation",
      expression: "0 9 * * *",
      timezone: "UTC",
      overlapPolicy: "skip-active",
      missedPolicy: "coalesce-latest",
      template: {
        title: "Talk",
        intent: "Talk about the system.",
        repoRoot: "/repo",
        kind: "chat",
        agent: "claude",
        priority: null,
        labels: [],
        model: null,
        effort: null,
      },
    }).success,
    true,
  );
  assert.equal(TaskSourceDefaultsSchema.safeParse({ kind: "chat" }).success, false);
});

test("an immediate chat persists and dispatches with its opener as the exact prompt prefix", async () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const launched: string[] = [];
  const seam = tasks as unknown as {
    dispatcher: { dispatch: (id: string) => Promise<{ ok: true; task: ReturnType<typeof mkTask> }> };
  };
  seam.dispatcher = {
    dispatch: async (id) => {
      launched.push(id);
      return { ok: true, task: registry.getTask(id)! };
    },
  };

  const task = tasks.create(chatInput, undefined, MANUAL_DISPATCH_TASK_CREATE);
  await Promise.resolve();

  assert.equal(task.status, "dispatching");
  assert.equal(registry.getTask(task.id)?.kind, "chat");
  assert.deepEqual(launched, [task.id]);
  assert.equal(
    withTaskKindContract(task, task.intent),
    `${chatInput.intent}\n\n${executionAuthorizationContract({
      workflowEvidence: false,
      workflowContinuation: false,
    })}`,
  );
  assert.deepEqual(kindMissionMcpRequirement(task, null)?.tools, ["create_task", "dispatch_task"]);
});

test("chat requires scheduling and dispatch without losing caller requirements", () => {
  const requirement = kindMissionMcpRequirement(mkTask({ kind: "chat" }), { tools: ["report_status"] }, true)!;
  assert.deepEqual(requirement.tools, ["report_status", "create_task", "dispatch_task", "submit_workflow_evidence"]);
  assert.deepEqual(kindMissionMcpRequirement(mkTask({ kind: "chat" }), requirement, true), requirement);
});

test("only manual Dispatch can create an immediate chat", () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const taskCount = registry.listTasks().length;

  assert.throws(() => tasks.create(chatInput), (error) => {
    assert.ok(error instanceof TaskKindBacklogError);
    assert.equal(error.message, TASK_KIND_BACKLOG_REFUSAL);
    return true;
  });
  assert.equal(registry.listTasks().length, taskCount);
});

test("TaskManager refuses every backlog-producing chat creation path", () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);

  for (const [id, create] of [
    [
      "backlog",
      () => tasks.create({ ...chatInput, backlog: true }, undefined, MANUAL_DISPATCH_TASK_CREATE),
    ],
    [
      "dependency",
      () =>
        tasks.create(
          {
            ...chatInput,
            dependencies: [{ type: "task", taskId: "prerequisite" }],
          },
          undefined,
          MANUAL_DISPATCH_TASK_CREATE,
        ),
    ],
    [
      "internal",
      () =>
        tasks.create(
          { ...chatInput, backlog: true },
          { id: "chat-internal" },
          MANUAL_DISPATCH_TASK_CREATE,
        ),
    ],
    [
      "source",
      () =>
        tasks.create(
          {
            ...chatInput,
            backlog: true,
            source: { sourceId: "source-1", externalId: "issue-1", url: null },
          },
          undefined,
          MANUAL_DISPATCH_TASK_CREATE,
        ),
    ],
  ] as const) {
    assert.throws(create, (error) => {
      assert.ok(error instanceof TaskKindBacklogError, id);
      assert.equal(error.message, TASK_KIND_BACKLOG_REFUSAL);
      return true;
    });
  }
  assert.equal(registry.getTask("chat-internal"), undefined);
});

test("malformed chat rows cannot enter later backlog-only operations", async () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  registry.upsertTask(mkTask({ id: "chat-backlog", kind: "chat", status: "backlog" }));
  registry.upsertTask(mkTask({ id: "chat-failed", kind: "chat", status: "failed" }));
  registry.upsertTask(mkTask({ id: "ordinary", kind: "ship", status: "backlog" }));

  const dispatched = await tasks.dispatch("chat-backlog");
  assert.equal(dispatched.ok, false);
  if (dispatched.ok) assert.fail("malformed chat dispatch unexpectedly succeeded");
  assert.equal(dispatched.error, TASK_KIND_BACKLOG_REFUSAL);
  assert.equal(
    (await tasks.assign("chat-backlog", "missing-session")).error,
    TASK_KIND_BACKLOG_REFUSAL,
  );
  assert.equal((await tasks.reschedule("chat-failed")).error, TASK_KIND_BACKLOG_REFUSAL);
  assert.equal((await tasks.update("ordinary", { kind: "chat" })).error, TASK_KIND_BACKLOG_REFUSAL);

  assert.equal(registry.getTask("chat-backlog")?.status, "backlog", "the malformed row is retained");
  assert.equal(registry.getTask("chat-failed")?.status, "failed", "reschedule changes nothing");
  assert.equal(registry.getTask("ordinary")?.kind, "ship", "the edit changes nothing");
});

test("autopilot filters a malformed chat row out of planning and readiness", () => {
  const chat = mkTask({ id: "chat-parked", kind: "chat", status: "backlog" });
  const ship = mkTask({ id: "ship-parked", kind: "ship", status: "backlog" });
  assert.deepEqual(plannableBacklog([chat, ship]).map((task) => task.id), [ship.id]);
  assert.deepEqual(readyBacklog([chat, ship], null).map((task) => task.id), [ship.id]);
});

test("startup never recovers an interrupted chat into the backlog", () => {
  const registry = new Registry();
  registry.upsertTask(mkTask({
    id: "chat-interrupted",
    kind: "chat",
    status: "dispatching",
    worktreePath: null,
    homeName: null,
    sessionId: null,
  }));

  new TaskManager(registry);

  const task = registry.getTask("chat-interrupted")!;
  assert.equal(task.status, "failed");
  assert.equal(task.error, INTERRUPTED_CHAT_BEFORE_PROVISION_ERROR);
});

// ---- a chat a Recurring Mission filed ----

const scheduled = (id: string) => ({
  id,
  schedule: { scheduleId: "mission-1", scheduleOccurrenceId: `occ-${id}`, scheduledFor: 1_700_000_000_000 },
});

test("the scheduler alone may file a chat into the backlog, and only as plain backlog work", () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);

  const filed = tasks.create({ ...chatInput, backlog: true }, scheduled("chat-scheduled"));
  assert.equal(filed.status, "backlog");
  assert.equal(filed.kind, "chat");
  assert.equal(filed.scheduleId, "mission-1");
  assert.equal(filed.workflowId, null, "a scheduled chat has no after-work");

  for (const [id, create] of [
    ["not backlog", () => tasks.create({ ...chatInput, backlog: false }, scheduled("chat-now"))],
    [
      "dependency",
      () =>
        tasks.create(
          { ...chatInput, backlog: true, dependencies: [{ type: "task", taskId: filed.id }] },
          scheduled("chat-dep"),
        ),
    ],
    [
      "source",
      () =>
        tasks.create(
          { ...chatInput, backlog: true, source: { sourceId: "s", externalId: "e", url: null } },
          scheduled("chat-source"),
        ),
    ],
  ] as const) {
    assert.throws(create, (error) => {
      assert.ok(error instanceof TaskKindBacklogError, id);
      return true;
    });
  }
  for (const id of ["chat-now", "chat-dep", "chat-source"]) {
    assert.equal(registry.getTask(id), undefined, id);
  }
});

test("a mission-filed chat is ready backlog work Foreman may launch, but never assign", async () => {
  const chat = mkTask({ id: "chat-mission", kind: "chat", status: "backlog", scheduleId: "mission-1" });
  const stray = mkTask({ id: "chat-stray", kind: "chat", status: "backlog" });
  assert.deepEqual(readyBacklog([chat, stray], null).map((task) => task.id), [chat.id]);
  assert.deepEqual(plannableBacklog([chat, stray]).map((task) => task.id), [chat.id]);
  assert.equal(taskAllowsBacklogAutopilot(chat), true);
  assert.equal(taskAllowsBacklogAutopilot(stray), false);
  assert.equal(taskAllowsBacklogAutopilot({ kind: "pipeline", scheduleId: "mission-1" }), false,
    "a scheduled Pipeline still waits for a manual start");

  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const launched: string[] = [];
  (tasks as unknown as { dispatcher: unknown }).dispatcher = {
    dispatch: async (id: string) => {
      launched.push(id);
      return { ok: true, task: registry.getTask(id)! };
    },
  };
  registry.upsertTask(chat);
  assert.equal((await tasks.assign(chat.id, "missing-session")).error, TASK_KIND_BACKLOG_REFUSAL);
  const dispatched = await tasks.dispatch(chat.id);
  assert.equal(dispatched.ok, true);
  assert.deepEqual(launched, [chat.id]);
});

test("a mission-filed chat can be edited, re-filed, and recovered to its backlog card", async () => {
  const registry = new Registry();
  registry.upsertTask(mkTask({ id: "edit-me", kind: "ship", status: "backlog", scheduleId: "mission-1" }));
  registry.upsertTask(mkTask({ id: "failed-chat", kind: "chat", status: "failed", scheduleId: "mission-1" }));
  registry.upsertTask(mkTask({
    id: "interrupted-chat",
    kind: "chat",
    status: "dispatching",
    scheduleId: "mission-1",
    worktreePath: null,
    homeName: null,
    sessionId: null,
  }));
  const tasks = new TaskManager(registry);

  assert.equal(registry.getTask("interrupted-chat")?.status, "backlog");
  assert.equal((await tasks.update("edit-me", { kind: "chat" })).ok, true);
  assert.equal(registry.getTask("edit-me")?.kind, "chat");
  assert.equal((await tasks.reschedule("failed-chat")).ok, true);
  assert.equal(registry.getTask("failed-chat")?.status, "backlog");
});

test("a mission-filed chat never carries dependencies, however the edit arrives", async () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  registry.upsertTask(mkTask({ id: "prerequisite", kind: "ship", status: "backlog" }));
  registry.upsertTask(mkTask({ id: "mission-ship", kind: "ship", status: "backlog", scheduleId: "mission-1" }));
  registry.upsertTask(mkTask({ id: "mission-chat-row", kind: "chat", status: "backlog", scheduleId: "mission-1" }));
  const edge = [{ type: "task" as const, taskId: "prerequisite" }];

  // A dependent mission task turned into a chat keeps its edges, so the edit is refused...
  assert.equal((await tasks.update("mission-ship", { dependencies: edge })).ok, true);
  assert.equal(registry.getTask("mission-ship")?.dependencies.length, 1);
  assert.equal((await tasks.update("mission-ship", { kind: "chat" })).error, CHAT_DEPENDENCY_REFUSAL);
  assert.equal(registry.getTask("mission-ship")?.kind, "ship", "the refused edit changes nothing");
  // ...and accepted once the same edit clears them, which is what the dashboard sends.
  assert.equal((await tasks.update("mission-ship", { kind: "chat", dependencies: [] })).ok, true);
  assert.deepEqual(registry.getTask("mission-ship")?.dependencies, []);

  // An edge added to a chat that is already one is refused too.
  assert.equal((await tasks.update("mission-chat-row", { dependencies: edge })).error, CHAT_DEPENDENCY_REFUSAL);
  assert.deepEqual(registry.getTask("mission-chat-row")?.dependencies, []);
});

test("a mission-filed chat runs no after-work Workflow, however the edit or save arrives", async () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const review = "builtin-workflow:general-review";
  registry.upsertTask(mkTask({ id: "kind-only", kind: "ship", status: "backlog", scheduleId: "mission-1", workflowId: review }));
  registry.upsertTask(mkTask({ id: "explicit", kind: "ship", status: "backlog", scheduleId: "mission-1", workflowId: review }));
  registry.upsertTask(mkTask({ id: "already-chat", kind: "chat", status: "backlog", scheduleId: "mission-1", workflowId: null }));
  registry.upsertTask(mkTask({ id: "stays-ship", kind: "ship", status: "backlog", scheduleId: "mission-1", workflowId: review }));

  // A kind-only edit takes chat's None rather than carrying the previous kind's Workflow.
  assert.equal((await tasks.update("kind-only", { kind: "chat" })).ok, true);
  assert.equal(registry.getTask("kind-only")?.workflowId, null);

  // Naming one is refused, whether the row is becoming a chat or already is one.
  assert.equal((await tasks.update("explicit", { kind: "chat", workflowId: review })).error, CHAT_WORKFLOW_REFUSAL);
  assert.equal(registry.getTask("explicit")?.kind, "ship", "the refused edit changes nothing");
  assert.equal((await tasks.update("already-chat", { workflowId: review })).error, CHAT_WORKFLOW_REFUSAL);
  assert.equal(registry.getTask("already-chat")?.workflowId, null);

  // Other kind changes keep their Workflow, as before.
  assert.equal((await tasks.update("stays-ship", { kind: "bugfix" })).ok, true);
  assert.equal(registry.getTask("stays-ship")?.workflowId, review);

  // The mission template refuses one too...
  const template = {
    name: "Conversation",
    expression: "0 9 * * *",
    timezone: "UTC",
    overlapPolicy: "skip-active",
    missedPolicy: "coalesce-latest",
    template: { title: "Talk", intent: "Talk.", repoRoot: "/repo", kind: "chat", agent: "claude" },
  };
  assert.equal(CreateScheduleSchema.safeParse(template).success, true);
  const withWorkflow = CreateScheduleSchema.safeParse({ ...template, template: { ...template.template, workflowId: review } });
  assert.equal(withWorkflow.success, false);
  assert.equal(withWorkflow.error?.issues[0]?.message, CHAT_WORKFLOW_REFUSAL);

  // ...and the scheduler cannot file a chat that names one, or that leaves it to the dispatch default.
  for (const [id, workflowId] of [["sched-armed", review], ["sched-default", undefined]] as const) {
    assert.throws(
      () => tasks.create({ ...chatInput, backlog: true, workflowId }, scheduled(id)),
      (error) => error instanceof TaskKindBacklogError,
      id,
    );
    assert.equal(registry.getTask(id), undefined, id);
  }
});
