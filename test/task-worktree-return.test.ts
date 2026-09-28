import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask, mkSession } from "./helpers/session-fixture.ts";
import { gitIn, mkLinkedWorktree, mkOriginAndClone } from "./helpers/git-fixture.ts";
import type { Session, Task } from "../src/shared/types.ts";
import type { TaskManagerStartupDeps } from "../src/server/tasks.ts";
import type { WorktreeOccupancy } from "../src/server/worktrees/occupancy.ts";

const home = mkdtempSync(join(tmpdir(), "mission-task-return-"));
process.env.MISSION_HOME = home;
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { WorktreeTeardownError, teardownWorktree } = await import("../src/server/dispatcher.ts");
const { worktreeReturnBlocker } = await import("../src/server/git/worktree-return-safety.ts");
const { getTaskSessionClosure } = await import("../src/server/db.ts");
const managers: InstanceType<typeof TaskManager>[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) {
    manager.stopMissionSessionClosures();
    await manager.settleWorktreeReturns();
  }
});
after(() => rmSync(home, { recursive: true, force: true }));

function world(over: Partial<Task> = {}, observed = true, deps: TaskManagerStartupDeps = {}) {
  const registry = new Registry();
  for (const stale of registry.listTasks()) registry.removeTask(stale.id);
  const sessions = (registry as unknown as { sessions: Map<string, Session> }).sessions;
  const state = {
    occupancy: { status: "known", occupants: [] } as WorktreeOccupancy,
    unsafe: null as string | null,
    released: [] as string[],
    stopped: [] as string[],
    probed: [] as string[],
    duringProbe: null as (() => void) | null,
    partial: false,
    runtimeLive: false,
    archiveRefused: false,
    archived: false,
  };
  const manager = new TaskManager(registry, {
    resetWouldDestroyWork: async () => null,
    kill: async (session) => { state.stopped.push(session.id); return { ok: true }; },
  }, { handleFor: () => state.runtimeLive ? {} : null, taskLiveness: () => null } as never, undefined, {
    ensureReady: async () => ({ ok: true }),
    settleBeforeCleanup: async () => {
      state.archived = true;
      return state.archiveRefused ? { ok: false, error: "archive unavailable" } : { ok: true };
    },
  }, {
    occupancy: async (paths) => new Map(paths.map((path) => [path, state.occupancy])),
    returnBlocker: async (path) => {
      state.probed.push(path);
      state.duringProbe?.();
      return state.unsafe;
    },
    teardown: async (task, _legacy, _priority, _worktrees, guard) => {
      assert.ok(state.archived, "archives precede teardown");
      const paths = [task.worktreePath, ...(task.extraRepos ?? []).map((ref) => ref.worktreePath)].filter((path): path is string => Boolean(path));
      for (const path of paths) {
        const blocked = await guard?.(path);
        if (blocked) throw new Error(blocked);
        state.released.push(path);
        if (state.partial) throw new WorktreeTeardownError("second provider refused", [path]);
      }
    },
    ...deps,
  });
  managers.push(manager);
  if (observed) registry.applyDiscovery([]);
  const task = mkTask({ id: "return-task", status: "running", sessionId: "return-session",
    worktreePath: "/pool/one", provider: "mission", worktreeLeaseId: "lease-one", ...over });
  registry.upsertTask(task);
  const session = mkSession({ id: "return-session", cwd: "/pool/one", pid: undefined, terminals: [] });
  sessions.set(session.id, session);
  const remove = async () => {
    sessions.delete(session.id);
    registry.emit("event", { type: "session_remove", id: session.id });
    await manager.settleWorktreeReturns();
  };
  return { registry, manager, state, task, session, sessions, remove };
}

const extra = { repoRoot: "/repo/two", worktreePath: "/pool/two", branch: "task", provider: "mission" as const,
  worktreeLeaseId: "lease-two", baseSha: null, prUrl: null, prState: null, mergedAt: null };

test("completion persists closure, waits for removal, and returns every tree despite local work", async () => {
  const w = world({ extraRepos: [extra] });
  w.state.unsafe = "local changes";
  await w.manager.complete(w.task.id, "shipped");
  assert.equal(w.registry.getTask(w.task.id)?.status, "done");
  assert.ok(getTaskSessionClosure(w.task.id));
  await w.manager.sweepMissionSessionClosures();
  assert.deepEqual(w.state.stopped, [w.session.id]);
  assert.deepEqual(w.state.released, []);
  await w.remove();
  await w.manager.sweepMissionSessionClosures();
  await w.manager.settleWorktreeReturns();
  assert.deepEqual(w.state.released, ["/pool/one", "/pool/two"]);
  assert.equal(w.registry.getTask(w.task.id)?.worktreePath, null);
  assert.equal(w.registry.getTask(w.task.id)?.extraRepos[0]?.worktreePath, null);
  assert.equal(w.registry.getTask(w.task.id)?.outcome, "shipped");
});

for (const reset of [false, true]) {
  test(`accepted Kill returns safe resources${reset ? " after Reset detached the session" : ""}`, async () => {
    const w = world(reset ? { status: "cancelled", sessionId: null } : {});
    w.manager.prepareKilledSessionReturn(w.session)();
    assert.deepEqual(w.state.released, []);
    await w.remove();
    assert.deepEqual(w.state.released, ["/pool/one"]);
    assert.equal(w.registry.getTask(w.task.id)?.status, reset ? "cancelled" : "failed");
    assert.equal(w.registry.getTask(w.task.id)?.worktreePath, null);
  });
}

test("Kill preserves a Git-provider tree when its upstream branch is deleted after initial eligibility", async (t) => {
  const { root, clone, origin } = mkOriginAndClone("mission-kill-publication-race-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const branch = "harness/kill-publication";
  const path = mkLinkedWorktree(clone, branch, join(root, "task"));
  writeFileSync(join(path, "keep.txt"), "published task work\n");
  gitIn(path, "commit", "-am", "task work");
  gitIn(path, "push", "origin", branch);
  const head = gitIn(path, "rev-parse", "HEAD");
  let probes = 0;
  const w = world({ repoRoot: clone, worktreePath: path, branch, provider: "git", worktreeLeaseId: null }, true, {
    returnBlocker: async (checkout, options) => {
      const blocked = await worktreeReturnBlocker(checkout, options);
      if (++probes === 1) {
        assert.equal(blocked, null, "initial fresh-origin eligibility must succeed");
        gitIn(origin, "update-ref", "-d", `refs/heads/${branch}`);
        assert.equal(gitIn(path, "rev-parse", `refs/remotes/origin/${branch}`), head,
          "deleting upstream leaves the original publication proof stale locally");
      }
      return blocked;
    },
    // Exercise real fallback removal, which does not fetch on the provider's behalf.
    teardown: teardownWorktree,
  });
  w.session.cwd = path;
  w.manager.prepareKilledSessionReturn(w.session)();
  await w.remove();

  assert.equal(probes, 2, "recheck publication at the destructive provider boundary");
  assert.equal(w.registry.getTask(w.task.id)?.status, "failed");
  assert.equal(w.registry.getTask(w.task.id)?.worktreePath, path, "retain ownership for existing cleanup policy");
  assert.equal(w.registry.getTask(w.task.id)?.provider, "git");
  assert.ok(existsSync(path), "the checkout must not be removed");
  assert.equal(gitIn(path, "rev-parse", "HEAD"), head);
  assert.equal(gitIn(clone, "rev-parse", `refs/heads/${branch}`), head, "the local task branch must survive");
});

for (const reason of ["dirty", "unknown", "occupied", "new-owner", "refused-stop", "other-session", "runtime-draining"] as const) {
  test(`Kill preserves resources when ${reason}`, async () => {
    const w = world();
    const accept = w.manager.prepareKilledSessionReturn(w.session);
    if (reason !== "refused-stop") accept();
    if (reason === "runtime-draining") w.state.runtimeLive = true;
    if (reason === "dirty") w.state.unsafe = "untracked work";
    if (reason === "unknown") w.state.occupancy = { status: "unknown", reason: "could not inspect" };
    if (reason === "occupied") w.state.occupancy = { status: "known", occupants: [{} as never] };
    if (reason === "new-owner") w.state.duringProbe = () => w.registry.upsertTask({
      ...w.registry.getTask(w.task.id)!, worktreeLeaseId: "replacement",
    });
    if (reason === "other-session") w.sessions.set("other", mkSession({ id: "other", cwd: "/pool/one/subdir" }));
    await w.remove();
    assert.deepEqual(w.state.released, []);
    assert.equal(w.registry.getTask(w.task.id)?.worktreePath, "/pool/one");
  });
}

test("an unsafe secondary repo preserves the whole killed task", async () => {
  const w = world({ extraRepos: [extra] });
  w.state.duringProbe = () => { if (w.state.probed.at(-1) === "/pool/two") w.state.unsafe = "local commit"; };
  w.manager.prepareKilledSessionReturn(w.session)();
  await w.remove();
  assert.deepEqual(w.state.released, []);
  assert.deepEqual(w.state.probed, ["/pool/one", "/pool/two"]);
});

test("partial provider failure clears only returned trees", async () => {
  const w = world({ extraRepos: [extra] });
  w.state.partial = true;
  w.manager.prepareKilledSessionReturn(w.session)();
  await w.remove();
  assert.equal(w.registry.getTask(w.task.id)?.worktreePath, null);
  assert.equal(w.registry.getTask(w.task.id)?.extraRepos[0]?.worktreeLeaseId, "lease-two");
});

test("Reset ownership in a secondary-only checkout remains eligible", async () => {
  const w = world({ status: "cancelled", sessionId: null, worktreePath: null, extraRepos: [extra] });
  w.session.cwd = "/pool/two";
  w.manager.prepareKilledSessionReturn(w.session)();
  await w.remove();
  assert.deepEqual(w.state.released, ["/pool/two"]);
});

test("ambiguous retained owners never authorize a return", async () => {
  const w = world({ status: "cancelled", sessionId: null });
  w.registry.upsertTask({ ...w.task, id: "other-owner" });
  w.manager.prepareKilledSessionReturn(w.session)();
  await w.remove();
  assert.deepEqual(w.state.released, []);
});


test("archive refusal preserves completion resources and the closure sweep retries later", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const w = world({ sessionId: null });
  w.sessions.clear();
  w.state.archiveRefused = true;
  await w.manager.complete(w.task.id, "finished");
  await w.manager.settleWorktreeReturns();
  assert.deepEqual(w.state.released, []);
  assert.equal(w.registry.getTask(w.task.id)?.worktreePath, "/pool/one");
  w.state.archiveRefused = false;
  now += 30_001;
  await w.manager.sweepMissionSessionClosures();
  await w.manager.settleWorktreeReturns();
  assert.deepEqual(w.state.released, ["/pool/one"]);
});

test("completion recovery waits for observed sessions before returning an old done tree", async () => {
  const w = world({ status: "done", sessionId: null }, false);
  w.sessions.clear();
  assert.deepEqual(w.state.released, []);
  w.registry.applyDiscovery([]);
  await w.manager.settleWorktreeReturns();
  assert.deepEqual(w.state.released, ["/pool/one"]);
});


test("read-only Kill eligibility never reserves a dirty checkout against manual cleanup", async () => {
  const w = world();
  w.state.duringProbe = () => {
    assert.equal(w.manager.taskCleanupIsReserved(w.task.id), false);
    w.state.unsafe = "dirty checkout";
  };
  w.manager.prepareKilledSessionReturn(w.session)();
  await w.remove();
  assert.deepEqual(w.state.released, []);
});
