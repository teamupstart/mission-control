import test from "node:test";
import assert from "node:assert/strict";
import { AGENT_TYPES } from "@shared/types.ts";
import type { Task, TaskRepoEntry } from "@shared/types.ts";
import { HARNESS_CAPABILITIES, capabilitiesFor } from "@shared/harness-capabilities.ts";
import { taskReposAllowlisted } from "@shared/allowlist.ts";
import { decideBacklogTick } from "../src/server/foreman/backlog-machine.ts";
import { mkTask } from "./helpers/session-fixture.ts";
import { TaskManager as TaskManagerType } from "../src/server/tasks.ts";

// The consent and capability rules that ship WITH multi-repo dispatch rather than after it.
//
// One dispatch of a multi-repo task provisions a worktree per attached repo and hands the
// agent write access to all of them. Two things have to be true at that moment, and both
// are cheap to get wrong in a way nothing later would notice: the operator must have
// trusted every one of those repos, and the harness must actually be able to hold write
// access outside its cwd.

function entry(repoRoot: string): TaskRepoEntry {
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

// ---- the allowlist AND rule ------------------------------------------------------------

test("a task is allowlisted only when EVERY repo it attaches is", () => {
  const solo = mkTask({ repoRoot: "/trusted/api" });
  assert.equal(taskReposAllowlisted(solo, ["/trusted"]), true);
  assert.equal(taskReposAllowlisted(solo, ["/elsewhere"]), false);

  const spanning = mkTask({
    repoRoot: "/trusted/api",
    extraRepos: [entry("/trusted/web"), entry("/untrusted/vendor")],
  });
  // AND, not any. An any-match would make attaching a trusted repo a way to launder an
  // untrusted one - consent obtained for one project and spent on another.
  assert.equal(taskReposAllowlisted(spanning, ["/trusted"]), false);
  assert.equal(taskReposAllowlisted(spanning, ["/trusted", "/untrusted"]), true);
  // The primary alone being trusted is exactly the hole this closes.
  assert.equal(taskReposAllowlisted(spanning, ["/trusted/api"]), false);
});

test("Foreman will not schedule a task whose secondary repo it was never trusted in", () => {
  // The rule where it actually bites. Without it the autopilot would dispatch an agent -
  // unattended, by design - into a repository the operator never cleared it for.
  const task = mkTask({
    id: "spanning",
    status: "backlog",
    repoRoot: "/trusted/api",
    extraRepos: [entry("/untrusted/vendor")],
  });
  const cfg = {
    enabled: true,
    maxSessions: 4,
    allowlist: ["/trusted"],
    mayActLive: true,
    settleMs: 0,
    respectOpenPrs: false,
    planExhausted: true,
  };

  const decision = decideBacklogTick({ tasks: [task], sessions: [], plan: null, cfg, now: 1000 });
  assert.equal(decision.kind, "none");
  assert.match(
    decision.kind === "none" ? decision.why : "",
    /no backlog item is in a repo Foreman is trusted to act in/,
  );

  // Trust the second repo and the same task becomes schedulable - so the refusal is the
  // allowlist talking, not something else about the task.
  const cleared = decideBacklogTick({
    tasks: [task],
    sessions: [],
    plan: null,
    cfg: { ...cfg, allowlist: ["/trusted", "/untrusted"] },
    now: 1000,
  });
  assert.equal(cleared.kind, "dispatch");
});

test("single-repo scheduling is untouched by the rule", () => {
  const task = mkTask({ id: "solo", status: "backlog", repoRoot: "/trusted/api" });
  const decision = decideBacklogTick({
    tasks: [task],
    sessions: [],
    plan: null,
    cfg: {
      enabled: true,
      maxSessions: 4,
      allowlist: ["/trusted"],
      mayActLive: true,
      settleMs: 0,
      respectOpenPrs: false,
      planExhausted: true,
    },
    now: 1000,
  });
  assert.equal(decision.kind, "dispatch");
});

// ---- the capability --------------------------------------------------------------------

test("every harness answers the multi-repo question, and null means measured-unsupported", () => {
  // The record is exhaustive by construction, so this is not checking that the keys exist -
  // the compiler does that. What it checks is that whoever added a harness gave a real
  // answer: a spec that renders no flags would be a harness advertising a grant it does not
  // make, which is worse than declaring null.
  for (const agent of AGENT_TYPES) {
    const spec = HARNESS_CAPABILITIES[agent].multiRepoDispatch;
    if (spec === null) continue;
    const args = spec.launchArgs(["/wt/a", "/wt/b"]);
    assert.ok(args.length > 0, `${agent} declares the capability but renders no flags`);
    assert.ok(
      args.some((arg) => arg.includes("/wt/a")) && args.some((arg) => arg.includes("/wt/b")),
      `${agent}'s flags must name every directory it was given`,
    );
  }
});

test("Claude and Codex render the launch flags that were measured against a real install", () => {
  // Pinned as literals rather than described, because these strings are the whole capability:
  // a typo in either is a session that starts fine and silently cannot write where it was
  // told it could.
  assert.deepEqual(capabilitiesFor("claude").multiRepoDispatch?.launchArgs(["/wt/a", "/wt/b"]), [
    // Repeated, which is what the vendor SDK itself emits for this CLI. The variadic
    // spelling the help text documents also parses, but it would swallow a following flag.
    "--add-dir",
    "/wt/a",
    "--add-dir",
    "/wt/b",
  ]);
  assert.deepEqual(capabilitiesFor("codex").multiRepoDispatch?.launchArgs(["/wt/a", "/wt/b"]), [
    // A TOML array through `-c`, the one grammar both the Codex TUI and `codex app-server`
    // accept - which is what lets the terminal and embedded runtimes share this renderer.
    "-c",
    'sandbox_workspace_write.writable_roots=["/wt/a","/wt/b"]',
  ]);
  // pi is null until somebody measures it. A guess here would have the dispatch modal
  // offer a multi-repo task that launches an agent which cannot write to half of it.
  assert.equal(capabilitiesFor("pi").multiRepoDispatch, null);
});

test("both shipped drivers can carry the grant on the embedded runtime too", () => {
  // A dispatch resolves to the `sdk` runtime on operator configuration alone. A harness
  // whose driver ignored the grant would make that toggle the difference between an agent
  // that can write to its secondary worktrees and one that silently cannot.
  for (const agent of ["claude", "codex"] as const) {
    assert.equal(capabilitiesFor(agent).multiRepoDispatch?.sdk, true, agent);
  }
});

// ---- dispatch-only ---------------------------------------------------------------------

test("a multi-repo task refuses to be assigned to a running session", async () => {
  // Assignment hands a task to a session that already exists, and everything a secondary
  // repo needs was decided when that session LAUNCHED - its extra worktrees, and a write
  // grant neither harness can widen afterwards. Accepting one would produce a session whose
  // intent names repositories it cannot reach.
  const { TaskManager } = await import("../src/server/tasks.ts");
  const task: Task = mkTask({
    id: "spanning",
    title: "Rename the field",
    status: "backlog",
    repoRoot: "/repo/api",
    extraRepos: [entry("/repo/web")],
  });
  const registry = {
    getTask: (id: string) => (id === task.id ? task : undefined),
    getSession: () => undefined,
    listTasks: () => [task],
  };
  const manager = Object.create(TaskManager.prototype) as InstanceType<typeof TaskManager>;
  Object.assign(manager, {
    registry,
    assigningTasks: new Set<string>(),
    assigningSessions: new Set<string>(),
  });

  const outcome = await manager.assign("spanning", "session-1");
  assert.equal(outcome.ok, false);
  assert.equal((outcome.ok === false ? outcome.scope : "") ?? "", "task");
  // The refusal says WHY, and names the number, so an operator reading a toast knows what
  // to do about it rather than only that something was refused.
  const error = (outcome.ok === false ? outcome.error : "") ?? "";
  assert.match(error, /multi-repo task has to be dispatched/);
  assert.match(error, /1 more repo/);
});

// ---- editing the repo set --------------------------------------------------------------

/** A TaskManager with just enough wired for `update`, over a fixed task. */
function managerOver(task: Task): { manager: InstanceType<typeof TaskManagerType>; saved: Task[] } {
  const saved: Task[] = [];
  const registry = {
    getTask: (id: string) => (id === task.id ? task : undefined),
    upsertTask: (next: Task) => { saved.push(next); },
    listTasks: () => [task],
  };
  const manager = Object.create(TaskManagerType.prototype) as InstanceType<typeof TaskManagerType>;
  Object.assign(manager, {
    registry,
    titling: new Map(),
    assigningTasks: new Set<string>(),
    resolveDependencies: () => task.dependencies,
  });
  return { manager, saved };
}

test("moving the primary onto an already-attached repo is refused", async () => {
  // The half a check on the incoming repo SET cannot see. `taskUpdatePatch` names a field
  // only when it changed, so this edit sends `repoRoot` alone - and the collision is between
  // the new primary and a secondary the patch never mentions.
  //
  // Left unchecked the task saves with one repo listed twice, and the failure surfaces much
  // later as a raw `git worktree add` refusal during the all-or-nothing unwind: a message
  // naming neither the duplicate nor the edit that created it.
  const task = mkTask({
    id: "collide",
    status: "backlog",
    repoRoot: "/repo/api",
    extraRepos: [entry("/repo/web")],
  });
  const { manager, saved } = managerOver(task);

  const outcome = await manager.update("collide", { repoRoot: "/repo/web" });

  assert.equal(outcome.ok, false);
  assert.match((outcome.ok === false ? outcome.error : "") ?? "", /detach it before making it the primary/);
  assert.deepEqual(saved, [], "nothing is written when the edit is refused");
});

test("an ordinary primary move on a multi-repo task still saves", async () => {
  // The guard is a collision check, not a ban on editing a multi-repo task's primary.
  const task = mkTask({
    id: "moveok",
    status: "backlog",
    repoRoot: "/repo/api",
    extraRepos: [entry("/repo/web")],
  });
  const { manager, saved } = managerOver(task);

  const outcome = await manager.update("moveok", { repoRoot: "/repo/core" });

  assert.equal(outcome.ok, true);
  assert.equal(saved[0]?.repoRoot, "/repo/core");
  assert.deepEqual(saved[0]?.extraRepos.map((e) => e.repoRoot), ["/repo/web"]);
});

test("attaching the current primary as a secondary is refused from the other direction too", async () => {
  // The direction the route already covered, asserted here as well so the invariant is
  // pinned at the chokepoint every caller passes through rather than only at one door.
  const task = mkTask({ id: "collide2", status: "backlog", repoRoot: "/repo/api", extraRepos: [] });
  const { manager, saved } = managerOver(task);

  const outcome = await manager.update("collide2", { extraRepoRoots: ["/repo/api"] });

  assert.equal(outcome.ok, false);
  assert.deepEqual(saved, []);
});
