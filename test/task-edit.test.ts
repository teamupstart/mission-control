import { test, after } from "node:test";
import { mkTask as baseTask } from "./helpers/session-fixture.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "../src/shared/types.ts";

// Throwaway state dir, set before anything reads config - see tasks-db.test.ts.
const home = mkdtempSync(join(tmpdir(), "mission-task-edit-"));
process.env.HARNESS_HOME = home;
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");

after(() => rmSync(home, { recursive: true, force: true }));

/**
 * Rewriting a task that is still shelved - what the dispatch modal, reopened on a
 * backlog card, sends.
 *
 * The status boundary is the whole rule and the reason this file exists. A dispatched
 * task's title is already baked into a git branch and a tmux session name that nothing
 * downstream can rename, and its intent has already been typed at an agent, so an edit
 * past that point would change the card and nothing else - a dashboard quietly
 * disagreeing with the terminal it is meant to describe. Refusing is the honest answer.
 */

/** The shared task fixture with this file's defaults on top. */
const mkTask = (over: Partial<Task> = {}): Task =>
  baseTask({ title: "Wire The Thing Up", intent: "wire the thing up", ...over });

function setup(over: Partial<Task> = {}) {
  const r = new Registry();
  r.upsertTask(mkTask(over));
  return { r, tasks: new TaskManager(r) };
}

test("an edit merges over the stored row rather than replacing it", async () => {
  // The modal sends every field, but the API is a patch - so a caller correcting only
  // the intent must not have to restate the repo to keep it.
  const { r, tasks } = setup();
  const res = await tasks.update("t1", { intent: "wire the OTHER thing up" });
  assert.equal(res.ok, true);
  const t = r.getTask("t1")!;
  assert.equal(t.intent, "wire the OTHER thing up");
  assert.equal(t.repoRoot, "/repo");
  assert.equal(t.title, "Wire The Thing Up");
  assert.equal(t.kind, "ship");
  assert.equal(t.agent, "claude");
  assert.equal(t.status, "backlog");
});

test("every editable field can actually be changed", async () => {
  const { r, tasks } = setup();
  const res = await tasks.update("t1", {
    repoRoot: "/other",
    intent: "audit the parser",
    title: "Parser audit",
    kind: "scout",
    agent: "codex",
    model: "gpt-5.6-sol",
    effort: "xhigh",
  });
  assert.equal(res.ok, true);
  const t = r.getTask("t1")!;
  assert.deepEqual(
    {
      repoRoot: t.repoRoot,
      intent: t.intent,
      title: t.title,
      kind: t.kind,
      agent: t.agent,
      model: t.model,
      effort: t.effort,
    },
    {
      repoRoot: "/other",
      intent: "audit the parser",
      title: "Parser audit",
      kind: "scout",
      agent: "codex",
      model: "gpt-5.6-sol",
      effort: "xhigh",
    },
  );
});

test("a null model clears the override, where an absent one leaves it standing", async () => {
  // The same absent-versus-empty split the title makes, on the one other field where a
  // stored value can be taken back OFF the row. Collapsing the two would make "follow the
  // harness default again" unsayable: the picker's default option would save as a no-op
  // and the task would keep launching on a model the operator had just deselected.
  const { r, tasks } = setup({ model: "claude-opus-4-8" });
  await tasks.update("t1", { intent: "still opus" });
  assert.equal(r.getTask("t1")!.model, "claude-opus-4-8");
  await tasks.update("t1", { model: null });
  assert.equal(r.getTask("t1")!.model, null);
});

test("switching agents clears omitted model and effort overrides", async () => {
  const { r, tasks } = setup({ model: "claude-opus-4-8", effort: "max" });
  const res = await tasks.update("t1", { agent: "codex" });
  assert.equal(res.ok, true);
  assert.equal(r.getTask("t1")!.agent, "codex");
  assert.equal(r.getTask("t1")!.model, null);
  assert.equal(r.getTask("t1")!.effort, null);
});

test("switching agents accepts explicit compatible overrides", async () => {
  const { r, tasks } = setup({ model: "claude-opus-4-8", effort: "max" });
  const res = await tasks.update("t1", {
    agent: "codex",
    model: "gpt-5.6-sol",
    effort: "xhigh",
  });
  assert.equal(res.ok, true);
  assert.equal(r.getTask("t1")!.model, "gpt-5.6-sol");
  assert.equal(r.getTask("t1")!.effort, "xhigh");
});

test("task persistence rejects an effort unsupported by the effective agent", async () => {
  const { r, tasks } = setup({ agent: "codex" });
  const res = await tasks.update("t1", { effort: "max" });
  assert.equal(res.ok, false);
  assert.equal(r.getTask("t1")!.effort, null);
});

test("emptying the title re-derives one from the intent as it NOW reads", async () => {
  // The create form's bargain, kept on the way back in: a blank title means "name it
  // for me". Naming it from the OLD intent would be the one answer that is never
  // wanted - the operator just rewrote the sentence the name should come from.
  const { r, tasks } = setup();
  const res = await tasks.update("t1", { title: "", intent: "rip out the legacy poller" });
  assert.equal(res.ok, true);
  const t = r.getTask("t1")!;
  assert.match(t.title, /Legacy Poller/i);
  assert.notEqual(t.title, "Wire The Thing Up");
});

test("a title left out of the patch is left alone, unlike one sent empty", async () => {
  // Absent and empty are different answers, and only the API can tell them apart -
  // so the two must not collapse into each other on the way through.
  const { r, tasks } = setup();
  await tasks.update("t1", { intent: "rip out the legacy poller" });
  assert.equal(r.getTask("t1")!.title, "Wire The Thing Up");
});

test("a task that has left the backlog is refused, not half-applied", async () => {
  // Its branch and tmux session are already cut from the title it had.
  for (const status of ["dispatching", "running", "done", "cancelled", "failed"] as const) {
    // A resource-free dispatching row now proves no agent could have launched and is
    // intentionally recovered to Backlog at startup. Give this boundary test the
    // provisioned checkout its premise says already exists.
    const launchResources = status === "dispatching"
      ? { worktreePath: "/repo-worktree", provider: "git" as const }
      : {};
    const { r, tasks } = setup({ status, ...launchResources });
    const res = await tasks.update("t1", { intent: "too late" });
    assert.equal(res.ok, false, `${status} must be refused`);
    assert.match(res.error!, /not in the backlog/);
    assert.equal(r.getTask("t1")!.intent, "wire the thing up");
  }
});

test("an unknown task is a 'no such task', which the route turns into a 404", async () => {
  const { tasks } = setup();
  const res = await tasks.update("nope", { intent: "x" });
  assert.equal(res.ok, false);
  assert.equal(res.error, "no such task");
});

test("an edit is published, so every open board sees it without a reload", async () => {
  // The dashboard has no poll for tasks: if the write doesn't go out over SSE, the card
  // keeps showing the text the operator just replaced until something else happens to
  // push a snapshot.
  const { r, tasks } = setup();
  const seen: Task[] = [];
  r.on("event", (e) => {
    if (e.type === "task_upsert") seen.push(e.task);
  });
  await tasks.update("t1", { title: "Renamed" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.title, "Renamed");
});

test("an edit stamps updatedAt, and never moves the task's place in the backlog", async () => {
  // createdAt is what the card's "added 3h ago" reads and what orders the column.
  // Correcting a typo must not shove a task to the front of the queue.
  const { r, tasks } = setup();
  await tasks.update("t1", { title: "Renamed" });
  const t = r.getTask("t1")!;
  assert.equal(t.createdAt, 1000);
  assert.ok(t.updatedAt > 1000);
});
