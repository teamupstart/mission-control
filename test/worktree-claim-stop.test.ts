import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitIn, mkOriginAndClone } from "./helpers/git-fixture.ts";
import { mkTask } from "./helpers/session-fixture.ts";

// Stop, and task cancel, for a running dependency claim. Both find the claim through the
// worktree manager's claim registry, kill the step's process group, and hand the slot over as a
// failed claim. Real Git, a real pooled slot and real `node -e` steps; only the SDK supervisor
// is fake, so no agent binary ever runs.

const home = mkdtempSync(join(tmpdir(), "mission-claim-stop-"));
process.env.HARNESS_HOME = home;
process.env.MISSION_CLAUDE_BIN = "/bin/echo";
process.env.MISSION_MCP_SERVER = join(home, "no-such-mcp-bundle.mjs");

const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { setHarnessesConfig } = await import("../src/server/harnesses.ts");
const { WorktreeManager } = await import("../src/server/worktrees/manager.ts");
const { ClaimRegistry } = await import("../src/server/worktrees/claim.ts");
const { WorktreeClaimSchema } = await import("../src/shared/protocol.ts");
const { activeAgentCount } = await import("../src/server/foreman/backlog-machine.ts");
const { getTask: getDurableTask, openDb } = await import("../src/server/db.ts");

type SdkSupervisor = import("../src/server/sdk/supervisor.ts").SdkSupervisor;
type Session = import("../src/shared/types.ts").Session;
type Task = import("../src/shared/types.ts").Task;
type TaskRepoEntry = import("../src/shared/types.ts").TaskRepoEntry;
type WorktreeManagerT = InstanceType<typeof WorktreeManager>;
type Dispatcher = import("../src/server/dispatcher.ts").Dispatcher;

after(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.MISSION_CLAUDE_BIN;
  delete process.env.MISSION_MCP_SERVER;
});

afterEach(() => {
  openDb().exec("DELETE FROM worktree_slots; DELETE FROM worktree_pools;");
});

/**
 * An origin and its clone, the clone's `deps/` ignored so a step's own files never dirty the
 * tree. A native slot returns to the pool by resetting to origin's default, so it needs one.
 */
function seedRepo(): { repo: string; sha: string } {
  const { origin, clone } = mkOriginAndClone("mission-claim-stop-repo-");
  writeFileSync(join(origin, ".gitignore"), "deps/\n");
  gitIn(origin, "add", "-A");
  gitIn(origin, "commit", "-qm", "ignore deps");
  gitIn(clone, "fetch", "-q", "origin");
  gitIn(clone, "reset", "-q", "--hard", "origin/main");
  return { repo: clone, sha: gitIn(clone, "rev-parse", "HEAD") };
}

/**
 * A step that starts a long-lived descendant in its own process group, records both pids, and
 * then waits forever, so only a Stop or a kill ends either. A real install's build scripts are
 * exactly such descendants; killing the leader alone would leak them. The descendant's pid is
 * written before the leader's, so a leader pid on disk means both exist.
 */
const SLEEPER = [
  process.execPath,
  "-e",
  `const fs=require("fs");const {spawn}=require("child_process");fs.mkdirSync("deps",{recursive:true});` +
    `const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});` +
    `fs.writeFileSync("deps/child.pid",String(child.pid));` +
    `console.log("resolving fixture packages");` +
    `fs.writeFileSync("deps/leader.pid",String(process.pid));setInterval(()=>{},1000);`,
];

function claimManager(maxSlots = 2): WorktreeManagerT {
  return new WorktreeManager(undefined, {
    occupancy: async (paths) => new Map(paths.map((path) => [path, { status: "known" as const, occupants: [] }])),
    resolvePolicy: () => ({
      enabled: true,
      maxSlots,
      setupArgv: null,
      claim: WorktreeClaimSchema.parse({ steps: [{ argv: SLEEPER }] }),
    }),
  });
}

function fakeSupervisor(registry: InstanceType<typeof Registry>) {
  const starts: Parameters<SdkSupervisor["start"]>[0][] = [];
  const supervisor = {
    starts,
    async start(input: Parameters<SdkSupervisor["start"]>[0]): Promise<Session> {
      starts.push(input);
      return registry.registerSdkSession({ id: `sdk:${starts.length}`, agent: input.agent, name: input.name, cwd: input.cwd });
    },
    async stop(): Promise<void> {},
    taskLiveness: () => null,
  };
  return supervisor as typeof supervisor & SdkSupervisor;
}

async function waitFor(predicate: () => boolean, label: string, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The pids the running sleeper step wrote into the slot, its own and its descendant's. */
async function stepPids(m: WorktreeManagerT): Promise<{ leader: number; child: number }> {
  const deps = () => {
    const slot = m.store.slots().find((entry) => entry.depsState === "claiming");
    return slot ? join(slot.path, "deps") : "";
  };
  await waitFor(() => deps() !== "" && existsSync(join(deps(), "leader.pid")), "the claim step to start");
  return {
    leader: Number(readFileSync(join(deps(), "leader.pid"), "utf8")),
    child: Number(readFileSync(join(deps(), "child.pid"), "utf8")),
  };
}

/** Fail with `label` rather than hang the suite when `pending` never settles. */
async function settlesWithin<T>(pending: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** An attached repository entry that has not been provisioned yet. */
function attachedRepo(repoRoot: string): TaskRepoEntry {
  return {
    repoRoot,
    worktreePath: null,
    branch: null,
    provider: null,
    worktreeLeaseId: null,
    baseSha: null,
    prUrl: null,
    prState: null,
    mergedAt: null,
  };
}

// ---- the claim registry ----

test("Stop names one claim by slot and id, and never a later claim in the same slot", () => {
  let next = 0;
  const claims = new ClaimRegistry(() => `claim-${++next}`);
  const owner = { kind: "task" as const, key: "task-a:0" };
  const first = claims.register("slot-1", owner, 10)!;
  assert.equal(claims.stop("slot-1", "claim-9"), null, "an id the slot is not running stops nothing");
  assert.equal(first.signal.aborted, false);
  claims.unregister("slot-1", first);

  const second = claims.register("slot-1", owner, 20)!;
  assert.equal(claims.stop("slot-1", "claim-1"), null, "the first claim's Stop cannot reach the second");
  assert.equal(second.signal.aborted, false);
  const stopped = claims.stop("slot-1", "claim-2");
  assert.equal(stopped?.id, "claim-2");
  assert.equal(second.signal.aborted, true);
  assert.equal(claims.has("slot-1"), true, "the claim's own acquire unregisters it, not Stop");
});

test("listeners hear every claim change, and a failing one cannot fail the claim", () => {
  const claims = new ClaimRegistry(() => "claim-1");
  const heard: string[] = [];
  claims.subscribe(() => {
    throw new Error("a broken projection");
  });
  const unsubscribe = claims.subscribe((claim) => heard.push(`${claim.id}:${claim.step?.step ?? "-"}`));
  const control = claims.register("slot-1", { kind: "task", key: "t:0" }, 0)!;
  claims.progress("slot-1", control, { step: 1, stepCount: 2, argv: ["yarn"], startedAt: 1 });
  claims.unregister("slot-1", control);
  unsubscribe();
  claims.register("slot-2", { kind: "task", key: "t:0" }, 0);
  assert.deepEqual(heard, ["claim-1:-", "claim-1:1", "claim-1:1"]);
});

test("a task's claims are found by its owner key, and no other owner's are", () => {
  const m = claimManager();
  const a0 = m.claims.register("slot-a0", { kind: "task", key: "task-a:0" }, 0)!;
  const a2 = m.claims.register("slot-a2", { kind: "task", key: "task-a:2" }, 0)!;
  const prefix = m.claims.register("slot-ab", { kind: "task", key: "task-ab:0" }, 0)!;
  const check = m.claims.register("slot-check", { kind: "check", key: "task-a:0" }, 0)!;
  assert.equal(m.runningTaskClaim("task-a")?.claim.slotId, "slot-a0");
  assert.equal(m.runningTaskClaim("task-a")?.position, 0);
  assert.equal(m.runningTaskClaim("task-missing"), null);

  const stopped = m.stopTaskClaims("task-a").map((claim) => claim.slotId).sort();
  assert.deepEqual(stopped, ["slot-a0", "slot-a2"]);
  assert.equal(a0.signal.aborted, true);
  assert.equal(a2.signal.aborted, true);
  assert.equal(prefix.signal.aborted, false, "a task id that merely starts with this one is another task");
  assert.equal(check.signal.aborted, false, "a check's claim is never a task's");
});

// ---- Stop through the manager ----

test("Stop kills the claim's process group and hands the slot over as a failed claim", async () => {
  const { repo, sha } = seedRepo();
  const m = claimManager();
  const pending = m.acquire({ repositoryPath: repo, baseSha: sha, owner: { kind: "task", key: "task-stop:0" }, runClaim: true });
  const { leader, child } = await stepPids(m);
  assert.notEqual(leader, child);
  const running = m.runningTaskClaim("task-stop");
  assert.ok(running?.claim.step, "the claim is on its first step");

  assert.equal(m.stopClaim(running.claim.slotId, "some-other-claim"), null);
  assert.equal(alive(leader), true, "a Stop for another claim leaves this one's step running");
  assert.equal(alive(child), true, "and leaves the step's descendant running too");
  assert.equal(m.stopClaim(running.claim.slotId, running.claim.id)?.id, running.claim.id);

  const result = await pending;
  assert.equal(result.outcome, "acquired", JSON.stringify(result));
  assert.ok(result.outcome === "acquired");
  assert.equal(result.claimWarning?.step, 1);
  assert.equal(result.claimWarning?.reason, "was stopped");
  assert.match(result.claimWarning?.tail ?? "", /resolving fixture packages/);
  // The whole process group, not only the step it started: a descendant the step spawned (an
  // install's build script, say) is killed with it rather than leaked.
  await waitFor(() => !alive(leader), "the step's process to be killed");
  await waitFor(() => !alive(child), "the step's descendant to be killed with its group");

  const slot = m.store.slots().find((entry) => entry.id === running.claim.slotId)!;
  assert.equal(slot.state, "leased", "a stopped claim never quarantines the slot");
  assert.equal(slot.depsState, "failed", "Stop during a step is a failed claim; the next one reruns the steps");
  assert.equal(slot.depsFingerprint, null);
  assert.equal(m.claims.has(slot.id), false);
  assert.equal(m.stopClaim(slot.id, running.claim.id), null, "a finished claim cannot be stopped");
});

// ---- the task card and task cancel ----

function taskManagerFor(registry: InstanceType<typeof Registry>, worktrees: WorktreeManagerT) {
  const supervisor = fakeSupervisor(registry);
  const manager = new TaskManager(registry, undefined, supervisor, undefined, undefined, {}, worktrees);
  const dispatcher = (manager as unknown as { dispatcher: Dispatcher }).dispatcher;
  return { manager, supervisor, dispatcher };
}

test("the task carries an Installing dependencies phase, and Stop lets its dispatch continue with the warning", async (t) => {
  const { repo, sha } = seedRepo();
  setHarnessesConfig({ sessionRuntime: { claude: "sdk" } });
  const registry = new Registry();
  const worktrees = claimManager();
  const { manager, supervisor, dispatcher } = taskManagerFor(registry, worktrees);
  t.after(() => manager.stop());
  // A regression that leaves a claim running must fail this test, not hang the file on its step.
  t.after(() => worktrees.stopClaims());
  const id = "task-claim-stop";
  registry.upsertTask(mkTask({ id, status: "dispatching", repoRoot: repo, agent: "claude", intent: "fix the build" }));
  const upserts: Task[] = [];
  const unsubscribe = registry.subscribe((event) => {
    if (event.type === "task_upsert" && event.task.id === id) upserts.push(event.task);
  });
  t.after(unsubscribe);

  const dispatched = dispatcher.dispatch(id, { baseSha: sha });
  const { leader: pid, child } = await stepPids(worktrees);
  await waitFor(() => registry.getTask(id)?.provisioning != null, "the provisioning phase");
  const provisioning = registry.getTask(id)!.provisioning!;
  assert.equal(provisioning.phase, "installingDependencies");
  assert.equal(provisioning.repoRoot, repo);
  assert.equal(provisioning.step.step, 1);
  assert.equal(provisioning.step.stepCount, 1);
  assert.match(provisioning.step.command, /-e const fs=require/);
  assert.ok(
    upserts.some((task) => task.provisioning?.claimId === provisioning.claimId),
    "the phase arrived through the ordinary task_upsert",
  );
  assert.equal(getDurableTask(id)?.provisioning, undefined, "the phase is a projection, never a column");
  // Still `dispatching` while it claims, so Foreman keeps counting it against the limit.
  assert.equal(registry.getTask(id)!.status, "dispatching");
  assert.equal(activeAgentCount([], [registry.getTask(id)!]), 1);

  // The same Stop the task card's control sends.
  assert.ok(worktrees.stopClaim(provisioning.slotId, provisioning.claimId));
  await dispatched;
  await waitFor(() => !alive(pid), "the step's process to be killed");
  await waitFor(() => !alive(child), "the step's descendant to be killed with its group");

  const task = registry.getTask(id)!;
  assert.equal(task.status, "running", task.error ?? "");
  assert.equal(task.provisioning, undefined, "the phase is gone once the claim ends");
  assert.equal(upserts.at(-1)?.provisioning, undefined);
  assert.equal(supervisor.starts.length, 1, "the dispatch continued into a launch");
  assert.match(supervisor.starts[0]!.prompt, /^## Dependency install warning\n/);
  assert.match(supervisor.starts[0]!.prompt, /Failing step 1 of 1: `.*` was stopped\./);
  const expected = {
    repoRoot: repo,
    step: 1,
    stepCount: 1,
    reason: "was stopped",
    truncatedBytes: 0,
  };
  assert.deepEqual(
    task.claimWarnings?.map(({ command: _command, tail: _tail, ...rest }) => rest),
    [expected],
  );
  assert.match(task.claimWarnings![0]!.tail, /resolving fixture packages/);
  assert.deepEqual(
    getDurableTask(id)?.claimWarnings?.map(({ command: _command, tail: _tail, ...rest }) => rest),
    [expected],
    "the warning is persisted on the task row",
  );
  const card = registry.snapshot().sessions.find((session) => session.task?.id === id);
  assert.equal(card?.task?.claimWarnings?.[0]?.reason, "was stopped", "the session card carries the warning");
});

test("task cancel during a claim stops it, and the dispatch tears down as for any cancel", async (t) => {
  const { repo, sha } = seedRepo();
  setHarnessesConfig({ sessionRuntime: { claude: "sdk" } });
  const registry = new Registry();
  const worktrees = claimManager();
  const { manager, supervisor, dispatcher } = taskManagerFor(registry, worktrees);
  t.after(() => manager.stop());
  // A regression that leaves a claim running must fail this test, not hang the file on its step.
  t.after(() => worktrees.stopClaims());
  const id = "task-claim-cancel";
  registry.upsertTask(mkTask({ id, status: "dispatching", repoRoot: repo, agent: "claude", intent: "never runs" }));

  const dispatched = dispatcher.dispatch(id, { baseSha: sha });
  const { leader: pid, child } = await stepPids(worktrees);
  await waitFor(() => registry.getTask(id)?.provisioning != null, "the provisioning phase");

  const cancelled = await manager.cancel(id);
  assert.deepEqual(cancelled, { ok: true });
  // Without the stop the dispatch would wait out a claim that never ends.
  await settlesWithin(dispatched, 60_000, "the dispatch waited out the claim instead of stopping it");
  await waitFor(() => !alive(pid), "the step's process to be killed");
  await waitFor(() => !alive(child), "the step's descendant to be killed with its group");

  const task = registry.getTask(id)!;
  assert.equal(task.status, "cancelled");
  assert.equal(task.provisioning, undefined);
  assert.equal(task.worktreePath, null, `the dispatch tore down the tree it was handed: ${task.error}`);
  assert.equal(task.worktreeLeaseId, null);
  assert.equal(supervisor.starts.length, 0, "nothing launched into a cancelled task");
  await waitFor(
    () => worktrees.store.slots().every((slot) => slot.state === "available"),
    "the slot to return to the pool",
  );
  assert.equal(worktrees.store.slots()[0]!.depsState, "failed");
});

test("a cancel during the primary repository's claim starts no attached repository's claim", async (t) => {
  const primary = seedRepo();
  const attached = seedRepo();
  setHarnessesConfig({ sessionRuntime: { claude: "sdk" } });
  const registry = new Registry();
  const worktrees = claimManager();
  const { manager, supervisor, dispatcher } = taskManagerFor(registry, worktrees);
  t.after(() => manager.stop());
  // A regression that leaves a claim running must fail this test, not hang the file on its step.
  t.after(() => worktrees.stopClaims());
  const id = "task-claim-cancel-multi";
  // Every owner a claim ran for, in order: `<task>:0` is the primary, `<task>:1` the attached repo.
  const claimed: string[] = [];
  const unsubscribe = worktrees.onClaimChange((claim) => {
    if (!claimed.includes(claim.owner.key)) claimed.push(claim.owner.key);
  });
  t.after(unsubscribe);
  registry.upsertTask(mkTask({
    id,
    status: "dispatching",
    repoRoot: primary.repo,
    agent: "claude",
    intent: "never runs",
    extraRepos: [attachedRepo(attached.repo)],
  }));

  const dispatched = dispatcher.dispatch(id, { baseSha: primary.sha });
  const { leader, child } = await stepPids(worktrees);
  await waitFor(() => registry.getTask(id)?.provisioning != null, "the provisioning phase");
  assert.equal(registry.getTask(id)!.provisioning!.repoRoot, primary.repo, "the primary's claim is the one running");

  assert.deepEqual(await manager.cancel(id), { ok: true });
  // The attached repository's claim runs the same never-ending step. Had the dispatch gone on
  // to provision it after the cancel, nothing would ever stop it and this would not settle.
  await settlesWithin(dispatched, 60_000, "the dispatch provisioned the attached repository after the cancel");
  await waitFor(() => !alive(leader) && !alive(child), "the primary claim's process group to be killed");

  assert.deepEqual(claimed, [`${id}:0`], "no claim ever ran for the attached repository");
  assert.equal(
    worktrees.store.slots().length,
    1,
    "the attached repository was never acquired: its pool has no slot at all",
  );
  const task = registry.getTask(id)!;
  assert.equal(task.status, "cancelled");
  assert.equal(task.worktreePath, null, `the primary's tree was torn down: ${task.error}`);
  assert.equal(task.worktreeLeaseId, null);
  assert.deepEqual(
    task.extraRepos.map((entry) => [entry.repoRoot, entry.worktreePath, entry.worktreeLeaseId]),
    [[attached.repo, null, null]],
    "the attached repository stays on the task, unprovisioned",
  );
  assert.equal(supervisor.starts.length, 0, "nothing launched into a cancelled task");
  await waitFor(
    () => worktrees.store.slots().every((slot) => slot.state === "available"),
    "the primary's slot to return to the pool",
  );
});

test("a dispatching task without a running claim step carries no provisioning key at all", () => {
  const registry = new Registry();
  registry.setTaskProvisioningSource(() => null);
  registry.upsertTask(mkTask({ id: "plain", status: "dispatching" }));
  assert.equal("provisioning" in registry.getTask("plain")!, false);
  // A stale value spread in from an earlier snapshot is read again, not trusted.
  registry.upsertTask({
    ...registry.getTask("plain")!,
    status: "running",
    provisioning: {
      phase: "installingDependencies",
      repoRoot: "/r",
      slotId: "s",
      claimId: "c",
      startedAt: 0,
      step: { step: 1, stepCount: 1, command: "yarn", startedAt: 0 },
    },
  });
  assert.equal("provisioning" in registry.getTask("plain")!, false);
});
