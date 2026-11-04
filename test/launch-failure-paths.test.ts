import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkTask } from "./helpers/session-fixture.ts";
import type { Task } from "../src/shared/types.ts";

// The launch-failure record, driven through each production path that writes or withholds it.
// The record decides where a failure is drawn and which actions it offers, and the one that
// matters most is `sessionKept`: a failure whose agent the dispatcher deliberately kept must
// never be drawn as "did not start" with a Retry, because Retry re-files the task and reclaims
// the very worktree that agent may still be working in. And a session that ran and was then
// lost to a restart is not a launch failure at all - it must carry no record.

const home = mkdtempSync(join(tmpdir(), "mission-launch-failure-paths-"));
process.env.HARNESS_HOME = home;
process.env.MISSION_CLAUDE_BIN = "/bin/echo";

const { Registry } = await import("../src/server/registry.ts");
const { Dispatcher } = await import("../src/server/dispatcher.ts");
const { TaskManager } = await import("./helpers/task-manager-fixture.ts");
const { launchFailureOutcome } = await import("../src/shared/launch-failure.ts");
const { FailedLaunchList, LaunchFailureProvider, fleetFailureGroups } = await import("../src/web/components/LaunchFailures.tsx");

after(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.MISSION_CLAUDE_BIN;
});

async function eventually(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

/** A launch that fails at the first step it takes, after the dispatch has begun. */
const failingRuntime = (): never => {
  throw new Error("the first prompt was not delivered");
};

function tile(tasks: Task[]): string {
  const controls = { tasks, openReport() {}, launchResident() {}, openProfile() {}, openSession() {} };
  return renderToStaticMarkup(
    createElement(LaunchFailureProvider, { value: controls }, createElement(FailedLaunchList, { groups: fleetFailureGroups(tasks), variant: "tile" })),
  );
}

// ---- the dispatcher ----------------------------------------------------------------------

test("a failed launch whose agent the dispatcher kept is recorded as kept, and is never offered a Retry", async () => {
  const registry = new Registry();
  registry.upsertTask(mkTask({ id: "kept", kind: "chat", title: "Talk", status: "dispatching" }));
  // The supervisor still holds this task's handle: the dispatcher's "kept" branch.
  const supervisor = { taskLiveness: () => true };
  await new Dispatcher(registry, undefined, { resolveRuntime: failingRuntime, supervisor } as never).dispatch("kept");

  const task = registry.getTask("kept")!;
  assert.equal(task.status, "failed");
  assert.match(task.error ?? "", /its session and worktree were kept/);
  assert.equal(task.sessionId, null, "the task was never bound to the session it kept");
  assert.equal(task.launchFailure?.sessionKept, true);
  assert.equal(launchFailureOutcome(task), "kept");
  // No session card can carry it, so it is drawn as a tile - but as a kept one.
  const html = tile([task]);
  assert.match(html, /Launch failed, session kept/);
  assert.doesNotMatch(html, />Retry</, "a retry would reclaim the worktree its agent may be using");
  assert.match(html, />Report bug</);
});

test("a failed launch whose agent is gone is recorded as not started and torn down", async () => {
  const registry = new Registry();
  registry.upsertTask(mkTask({ id: "gone", kind: "chat", title: "Talk", status: "dispatching" }));
  const supervisor = { taskLiveness: () => false };
  await new Dispatcher(registry, async () => {}, { resolveRuntime: failingRuntime, supervisor } as never).dispatch("gone");

  const task = registry.getTask("gone")!;
  assert.equal(task.status, "failed");
  assert.equal(task.launchFailure?.sessionKept, false);
  assert.equal(launchFailureOutcome(task), "not-started");
  assert.match(tile([task]), />Retry</);
});

// ---- startup reconciliation --------------------------------------------------------------

function startup(tasks: Task[], supervisor: Record<string, unknown>) {
  const registry = new Registry();
  for (const task of tasks) registry.upsertTask(task);
  new TaskManager(registry, undefined, supervisor as never, undefined, undefined, { teardown: async () => {} });
  return registry;
}

test("a restart that interrupts a dispatch before provisioning records it: Backlog kinds return, chats fail", async () => {
  const registry = startup([
    mkTask({ id: "ship-early", kind: "ship", status: "dispatching", dispatchedAt: 900 }),
    mkTask({ id: "chat-early", kind: "chat", status: "dispatching", dispatchedAt: 900 }),
  ], { taskLiveness: () => null });
  await eventually(() => registry.getTask("chat-early")?.status === "failed", "the chat was never settled");

  assert.equal(launchFailureOutcome(registry.getTask("ship-early")!), "returned");
  assert.equal(launchFailureOutcome(registry.getTask("chat-early")!), "not-started");
});

test("a restart that interrupts a provisioned dispatch whose agent died records a launch failure", async () => {
  const registry = startup([mkTask({
    id: "interrupted",
    status: "dispatching",
    dispatchedAt: 5_000,
    worktreePath: "/pool/interrupted/1",
    provider: "git",
    homeName: "interrupted-home",
    terminalResourceId: "interrupted-res",
  })], { taskLiveness: () => false });
  await eventually(() => registry.getTask("interrupted")?.status === "failed", "the task was never settled");

  const task = registry.getTask("interrupted")!;
  assert.match(task.error ?? "", /dispatch interrupted by a restart/);
  assert.equal(task.launchFailure?.sessionKept, false);
  assert.equal(launchFailureOutcome(task), "not-started");
});

test("a restart that interrupts a dispatch whose session is being resumed records it as kept", async () => {
  const registry = startup([mkTask({
    id: "resuming",
    status: "dispatching",
    dispatchedAt: 5_000,
    worktreePath: "/pool/resuming/1",
    provider: "git",
  })], { taskLiveness: () => true, liveSessionForTask: () => null });
  await eventually(() => registry.getTask("resuming")?.status === "failed", "the task was never settled");

  const task = registry.getTask("resuming")!;
  assert.match(task.error ?? "", /its session is being resumed/);
  assert.equal(task.launchFailure?.sessionKept, true);
  assert.equal(launchFailureOutcome(task), "kept");
});

test("a session that ran and was lost to a restart is not a launch failure", async () => {
  const registry = startup([mkTask({
    id: "ran",
    status: "running",
    dispatchedAt: 5_000,
    worktreePath: "/pool/ran/1",
    provider: "git",
    homeName: "ran-home",
    terminalResourceId: "ran-res",
    sessionId: "proc:dead",
  })], { taskLiveness: () => false });
  await eventually(() => registry.getTask("ran")?.status === "failed", "the task was never settled");

  const task = registry.getTask("ran")!;
  assert.equal(task.error, "the agent's session did not survive a restart");
  assert.equal(task.launchFailure ?? null, null);
  assert.equal(launchFailureOutcome(task), null);
  assert.equal(tile([task]), "", "nothing is drawn for it");
});
