import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { plannableBacklog, readyBacklog } from "../src/shared/backlog.ts";
import { DispatchSchema, CreateScheduleSchema, UpdateTaskSchema } from "../src/shared/protocol.ts";
import { TASK_KIND_BACKLOG_REFUSAL } from "../src/shared/task.ts";
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
  assert.equal(UpdateTaskSchema.safeParse({ kind: "chat" }).success, false);
});

test("schedule and task-source schemas refuse chat instead of normalizing it", () => {
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
    false,
  );
  assert.equal(TaskSourceDefaultsSchema.safeParse({ kind: "chat" }).success, false);
});

test("an immediate chat persists and dispatches with its opener unchanged", async () => {
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
  assert.equal(withTaskKindContract(task, task.intent), chatInput.intent);
  assert.equal(kindMissionMcpRequirement(task, null), null);
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
