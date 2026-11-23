import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask } from "./helpers/session-fixture.ts";

// A task's call sign (contract C of the voice plan): an optional spoken name on every task-writing
// schema, the dispatch form's, an update's and the MCP tools'. It is annotation, like priority:
// nothing is provisioned from it, so it can be set or taken off while the agent runs, where a
// provisioning field is refused.

const home = mkdtempSync(join(tmpdir(), "mission-voice-call-sign-"));
process.env.HARNESS_HOME = home;

const {
  DispatchSchema,
  UpdateTaskSchema,
  McpTaskConfigurationSchema,
  McpUpdateTaskSchema,
  isAnnotationOnlyUpdate,
} = await import("../src/shared/protocol.ts");
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { getTask } = await import("../src/server/db.ts");

after(() => rmSync(home, { recursive: true, force: true }));

const dispatch = (over: Record<string, unknown>) => DispatchSchema.safeParse({ repoRoot: "/repo", intent: "fix it", ...over });

test("the dispatch schema takes an optional call sign, trimmed, of 1 to 40 characters", () => {
  assert.equal(dispatch({}).data?.callSign, undefined, "omitted is none");
  assert.equal(dispatch({ callSign: "  Atlas  Prime " }).data?.callSign, "Atlas Prime");
  assert.equal(dispatch({ callSign: "   " }).success, false, "blank is refused: omit it instead");
  assert.equal(dispatch({ callSign: "x".repeat(41) }).success, false);
  assert.equal(dispatch({ callSign: "x".repeat(40) }).success, true);
});

test("an update takes a call sign or null, and a call sign alone is annotation", () => {
  assert.equal(UpdateTaskSchema.parse({ callSign: " Alice " }).callSign, "Alice");
  assert.equal(UpdateTaskSchema.parse({ callSign: null }).callSign, null);
  assert.ok(isAnnotationOnlyUpdate({ callSign: "Alice" }));
  assert.ok(isAnnotationOnlyUpdate({ callSign: null, priority: "high", labels: [] }));
  assert.equal(isAnnotationOnlyUpdate({ callSign: "Alice", title: "Renamed" }), false);
});

test("both MCP task tools accept a call sign, and describe it as a spoken name", () => {
  assert.ok("callSign" in McpTaskConfigurationSchema.shape, "create_task");
  assert.ok("callSign" in McpUpdateTaskSchema.shape, "update_task");
  assert.equal(McpUpdateTaskSchema.parse({ callSign: null }).callSign, null);
  assert.match(McpTaskConfigurationSchema.shape.callSign.description ?? "", /spoken name/);
});

test("a task is created with its call sign, and one may be set or taken off while it runs", async () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const created = tasks.create({
    repoRoot: "/repo", intent: "fix the parser", title: "Fix the parser", kind: "ship", agent: "claude",
    workflowId: null, backlog: true, callSign: "Alice",
  });
  assert.equal(created.callSign, "Alice");
  assert.equal(getTask(created.id)!.callSign, "Alice", "stored");
  const plain = tasks.create({
    repoRoot: "/repo", intent: "no name", title: "No name", kind: "ship", agent: "claude", workflowId: null, backlog: true,
  });
  assert.equal("callSign" in plain, false, "a task with none carries no key");

  registry.upsertTask({ ...getTask(created.id)!, status: "running", dispatchedAt: 5 });
  const renamed = await tasks.update(created.id, { callSign: "Atlas" });
  assert.equal(renamed.ok, true, renamed.error);
  assert.equal(getTask(created.id)!.callSign, "Atlas");
  assert.equal(registry.getTask(created.id)!.callSign, "Atlas", "the Registry holds the change, and its frame went out");

  const cleared = await tasks.update(created.id, { callSign: null });
  assert.equal(cleared.ok, true, cleared.error);
  assert.equal(getTask(created.id)!.callSign ?? null, null);

  const provisioning = await tasks.update(created.id, { callSign: "Atlas", title: "Renamed" });
  assert.equal(provisioning.ok, false, "a title still cannot change once the task has left the backlog");
  assert.match(provisioning.error ?? "", /not in the backlog/);
});

test("an edit that does not name the call sign leaves it alone", async () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  registry.upsertTask(mkTask({ id: "t-keep", callSign: "Alice", status: "backlog" }));
  const result = await tasks.update("t-keep", { priority: "high" });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.task?.callSign, "Alice");
});
