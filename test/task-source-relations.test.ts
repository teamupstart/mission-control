import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  LinkedReadResult,
  SweepContext,
  TaskCandidate,
  TaskSourceInstance,
} from "../src/shared/task-source.ts";
import { GithubIssuesConfigSchema, TASK_SOURCE_KIND_INFO, TASK_SOURCE_KINDS } from "../src/shared/task-source.ts";
import type { Task } from "../src/shared/types.ts";
import { mkTask } from "./helpers/session-fixture.ts";

// The `canRelate` seam: a sweep candidate's blocking links become dependency edges on the
// task it files, and the sweep re-reads the external items `source` edges wait on.
//
// The mapping under test, end to end through a real TaskManager (so cycle refusal and the
// edge resolution are the daemon's own), with the GitHub half fed faked `gh` JSON in the
// shape gh 2.101 prints for `--json blockedBy,parent,state,stateReason`.

const home = mkdtempSync(join(tmpdir(), "mission-task-relations-"));
process.env.HARNESS_HOME = home;
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { ingestSweep } = await import("../src/server/task-sources/ingest.ts");
const { candidateFrom, issueState } = await import("../src/server/task-sources/github-issues.ts");
const {
  dependenciesFor,
  orderByBlockers,
  recheckSourceDependencies,
  sourceEdgesToRecheck,
} = await import("../src/server/task-sources/relations.ts");
const { canRelateTo } = await import("../src/server/task-sources/index.ts");
const { dependencyInputOf } = await import("../src/shared/task-dependency.ts");
const { blockersFor, deadSourceBlockersFor, backlogIndex, readyBacklog } = await import(
  "../src/shared/backlog.ts"
);
const { openDb, getTask, upsertTask, serializeTaskDependencies } = await import(
  "../src/server/db.ts"
);

after(() => rmSync(home, { recursive: true, force: true }));

function source(kind: TaskSourceInstance["kind"] = "github-issues"): TaskSourceInstance {
  return {
    id: `src-${kind}`,
    kind,
    label: "issues",
    enabled: true,
    repoRoot: "/repo",
    intervalMs: 900_000,
    keepUpdated: false,
    defaults: { kind: "ship", agent: "claude", priority: null, labels: [], enabled: false },
    maxPerSweep: 25,
    writeback: { onPrOpened: false, onCompleted: false, resolve: false },
    config: {},
  } as TaskSourceInstance;
}

const ctx: SweepContext = { sourceId: "src-github-issues", repoRoot: "/repo", signal: new AbortController().signal };
const cfg = GithubIssuesConfigSchema.parse({});

/** One issue as `gh issue list --json …,blockedBy,parent` prints it. */
function ghIssue(n: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: n,
    title: `Issue ${n}`,
    body: `Body ${n}`,
    url: `https://github.com/acme/demo/issues/${n}`,
    labels: [],
    state: "OPEN",
    stateReason: "",
    blockedBy: { nodes: [], totalCount: 0 },
    parent: null,
    ...over,
  };
}
function blocker(n: number, repo = "acme/demo"): Record<string, unknown> {
  return { id: `I_${n}`, number: n, state: "OPEN", title: `Issue ${n}`, url: `https://github.com/${repo}/issues/${n}` };
}
function candidate(issue: Record<string, unknown>): TaskCandidate {
  const c = candidateFrom(issue, cfg, ctx);
  assert.ok(c);
  return c;
}

function manager() {
  // Each test starts from an empty board: a Registry loads whatever the database holds.
  openDb().exec("DELETE FROM tasks");
  const registry = new Registry();
  return { registry, tasks: new TaskManager(registry) };
}
async function ingest(inst: TaskSourceInstance, items: TaskCandidate[], tasks: InstanceType<typeof TaskManager>) {
  return ingestSweep(inst, { items, error: null }, tasks, {
    resolveRepoRoot: async (p) => ({ ok: true, repoRoot: p }) as never,
    seen: () => new Set(),
    remember: () => {},
    transaction: (fn) => fn(),
    log: () => {},
  });
}
function bySource(tasks: InstanceType<typeof TaskManager>, externalId: string): Task {
  const t = tasks.list().find((task) => task.source?.externalId === externalId);
  assert.ok(t, `no task for ${externalId}`);
  return t;
}

test("every kind declares canRelate, GitHub true and Jira false", () => {
  for (const kind of TASK_SOURCE_KINDS) {
    assert.equal(typeof TASK_SOURCE_KIND_INFO[kind].canRelate, "boolean");
    assert.equal(canRelateTo(source(kind)), TASK_SOURCE_KIND_INFO[kind].canRelate);
  }
  assert.equal(TASK_SOURCE_KIND_INFO["github-issues"].canRelate, true);
  assert.equal(TASK_SOURCE_KIND_INFO.jira.canRelate, false);
});

test("gh's blockedBy and parent JSON become refs on the candidate; the state is ours", () => {
  const c = candidate(
    ghIssue(86, {
      blockedBy: { nodes: [blocker(16), blocker(16), blocker(3, "acme/other")], totalCount: 3 },
      parent: blocker(19),
    }),
  );
  assert.deepEqual(c.blockedBy, [
    { sourceId: ctx.sourceId, externalId: "acme/demo#16", url: "https://github.com/acme/demo/issues/16" },
    { sourceId: ctx.sourceId, externalId: "acme/other#3", url: "https://github.com/acme/other/issues/3" },
  ]);
  assert.deepEqual(c.parent, {
    sourceId: ctx.sourceId, externalId: "acme/demo#19", url: "https://github.com/acme/demo/issues/19",
  });
  assert.equal(c.state, "open");
  // An issue with no links carries no relation keys at all.
  const plain = candidate(ghIssue(1));
  assert.equal("blockedBy" in plain, false);
  assert.equal("parent" in plain, false);
});

test("a closed issue reads as completed or not_planned from its stateReason", () => {
  assert.equal(issueState({ state: "OPEN", stateReason: "REOPENED" }), "open");
  assert.equal(issueState({ state: "CLOSED", stateReason: "COMPLETED" }), "completed");
  assert.equal(issueState({ state: "CLOSED", stateReason: "" }), "completed");
  assert.equal(issueState({ state: "CLOSED", stateReason: "NOT_PLANNED" }), "not_planned");
  assert.equal(issueState({ state: "CLOSED", stateReason: "DUPLICATE" }), "not_planned");
  assert.equal(issueState({}), undefined);
});

test("a blocker linked to one of our tasks is a task edge; any other is a source edge; the parent is neither", async () => {
  const { tasks } = manager();
  const inst = source();
  // #16 is filed in the same sweep, listed AFTER what it blocks; #3 in another repo never is.
  const blocked = candidate(
    ghIssue(86, { blockedBy: { nodes: [blocker(16), blocker(3, "acme/other")], totalCount: 2 }, parent: blocker(19) }),
  );
  const report = await ingest(inst, [blocked, candidate(ghIssue(16))], tasks);
  assert.equal(report.filed, 2);
  assert.deepEqual(report.refused, []);

  const dependent = bySource(tasks, "acme/demo#86");
  const prerequisite = bySource(tasks, "acme/demo#16");
  assert.equal(dependent.status, "backlog");
  assert.deepEqual(
    dependent.dependencies.map((d) => (d.type === "task" ? `task:${d.taskId}` : d.type === "source" ? `source:${d.externalId}:${d.state}` : d.type)),
    [`task:${prerequisite.id}`, "source:acme/other#3:open"],
  );
  // The parent (#19) created nothing - no edge, no task.
  assert.equal(dependent.dependencies.some((d) => d.type === "source" && d.externalId === "acme/demo#19"), false);
  assert.equal(tasks.list().length, 2);

  const [taskBlocker, sourceBlocker] = blockersFor(dependent, null, tasks.list());
  // Swept tasks arrive parked (the source default), so the task blocker says so.
  assert.equal(taskBlocker?.state, "disabled");
  assert.equal(sourceBlocker?.state, "waiting");
  assert.deepEqual(sourceBlocker?.external, {
    sourceId: inst.id, externalId: "acme/other#3", url: "https://github.com/acme/other/issues/3",
  });
});

test("a source that cannot relate files no edges, whatever its candidates carry", async () => {
  const inst = source("jira");
  const c: TaskCandidate = {
    ref: { sourceId: inst.id, externalId: "MC-2", url: null },
    title: "Blocked", intent: "x", repoRoot: "/repo",
    blockedBy: [{ sourceId: inst.id, externalId: "MC-1", url: null }],
  };
  assert.deepEqual(dependenciesFor(inst, c, () => [], () => true), { dependencies: [], sourceDependencies: [] });
  const { tasks } = manager();
  await ingest(inst, [c], tasks);
  assert.deepEqual(bySource(tasks, "MC-2").dependencies, []);
});

test("a blocker takes a task edge only where TaskManager accepts one, otherwise a source edge", () => {
  const inst = source();
  const accepted = mkTask({ id: "yes", status: "backlog", source: { sourceId: inst.id, externalId: "acme/demo#6", url: null } });
  const refused = mkTask({ id: "no", status: "done", source: { sourceId: inst.id, externalId: "acme/demo#5", url: null } });
  const c = candidate(ghIssue(7, { blockedBy: { nodes: [blocker(5), blocker(6), blocker(7)], totalCount: 3 } }));
  const asked: string[] = [];
  const out = dependenciesFor(inst, c, () => [refused, accepted], (id) => (asked.push(id), id === "yes"));
  assert.deepEqual(out, {
    dependencies: [{ type: "task", taskId: "yes" }],
    // #7 blocking itself is dropped rather than deadlocking.
    sourceDependencies: [{ sourceId: inst.id, externalId: "acme/demo#5", url: "https://github.com/acme/demo/issues/5" }],
  });
  // The decision is the owner's, asked per linked task - never a status list kept here.
  assert.deepEqual(asked.sort(), ["no", "yes"]);
});

test("TaskManager accepts a new task edge to a backlogged or live running task only, and ingest follows it", async () => {
  // A dispatching task has no session yet, a running one whose session is gone cannot be
  // followed to its merge, and a finished or stopped one is not in play: the resolver
  // refuses a new edge to each, so a swept blocker linked to one waits on the issue instead.
  const { registry, tasks } = manager();
  const inst = source();
  const statuses = ["backlog", "running", "running", "dispatching", "cancelled", "failed", "done"] as const;
  statuses.forEach((status, i) =>
    registry.upsertTask(mkTask({
      id: `t-${i}`, status, worktreePath: `/wt/t-${i}`,
      source: { sourceId: inst.id, externalId: `acme/demo#${i + 100}`, url: `https://github.com/acme/demo/issues/${i + 100}` },
    })),
  );
  // t-1 is running under a live session whose hooks report; t-2 is running with none.
  registry.applyDiscovery([{
    syntheticId: "live", agent: "claude", name: "agent-live", nameSource: "process", cwd: "/wt/t-1",
    gitBranch: "feat/x", gitRoot: "/repo", repoRoot: "/repo", pid: 100, tty: null, terminals: [], startedAt: 0,
  }]);
  registry.applyHook({ agent: "claude", event: "Stop", sessionId: "live-episode", cwd: "/wt/t-1", transcriptPath: null, env: {} });
  registry.upsertTask({ ...registry.getTask("t-1")!, sessionId: "live" });
  registry.bindTaskToWorkEpisode("t-1", "live");

  assert.deepEqual(statuses.map((_, i) => tasks.acceptsNewTaskEdgeTo(`t-${i}`)),
    [true, true, false, false, false, false, false]);

  const c = candidate(ghIssue(1, {
    blockedBy: { nodes: statuses.map((_, i) => blocker(i + 100)), totalCount: statuses.length },
  }));
  const report = await ingest(inst, [c], tasks);
  assert.deepEqual(report.refused, []);
  const edges = bySource(tasks, "acme/demo#1").dependencies.map((d) =>
    d.type === "task" ? `task:${d.taskId}` : d.type === "source" ? `source:${d.externalId}` : d.type,
  );
  assert.deepEqual(edges, [
    "task:t-0",
    "task:t-1",
    "source:acme/demo#102",
    "source:acme/demo#103",
    "source:acme/demo#104",
    "source:acme/demo#105",
    "source:acme/demo#106",
  ]);
});

test("a request can keep or remove a source edge but never create one", async () => {
  const { tasks } = manager();
  const t = tasks.create({ repoRoot: "/repo", intent: "x", title: "held", kind: "ship", agent: "claude", backlog: true,
    sourceDependencies: [{ sourceId: "s", externalId: "acme/ext#1", url: null }] });
  const fabricated = { type: "source" as const, sourceId: "x", externalId: "fake#1", url: null, title: "fake" };
  const kept = { type: "source" as const, sourceId: "s", externalId: "acme/ext#1" };

  const refused = await tasks.update(t.id, { dependencies: [kept, fabricated] });
  assert.equal(refused.ok, false);
  assert.match(String((refused as { error?: string }).error), /no longer available/);
  assert.throws(
    () => tasks.create({ repoRoot: "/repo", intent: "y", title: "y", kind: "ship", agent: "claude", backlog: true, dependencies: [fabricated] }),
    /no longer available/,
  );

  assert.equal((await tasks.update(t.id, { title: "held still", dependencies: [kept] })).ok, true);
  assert.deepEqual(tasks.get(t.id)?.dependencies.map((d) => d.type === "source" && d.externalId), ["acme/ext#1"]);
  assert.equal((await tasks.update(t.id, { dependencies: [] })).ok, true);
  assert.deepEqual(tasks.get(t.id)?.dependencies, []);
});

test("in-batch blockers are filed first, and an upstream cycle keeps the source's order", () => {
  const c = (n: number, blockers: number[]) =>
    candidate(ghIssue(n, { blockedBy: { nodes: blockers.map((b) => blocker(b)), totalCount: blockers.length } }));
  const ids = (list: TaskCandidate[]) => list.map((x) => x.ref.externalId);
  assert.deepEqual(ids(orderByBlockers([c(1, [2]), c(2, [3]), c(3, [])])), ["acme/demo#3", "acme/demo#2", "acme/demo#1"]);
  assert.deepEqual(ids(orderByBlockers([c(1, [2]), c(2, [1])])), ["acme/demo#2", "acme/demo#1"]);
});

test("cycle refusal still holds on the resolver that swept task edges go through", async () => {
  // A freshly swept task cannot close a cycle - nothing depends on it yet - so the
  // refusal is exercised on the resolver `create` shares with every edit.
  const { registry, tasks } = manager();
  const one = tasks.create({ repoRoot: "/repo", intent: "one", title: "one", kind: "ship", agent: "claude", backlog: true });
  const two = tasks.create({ repoRoot: "/repo", intent: "two", title: "two", kind: "ship", agent: "claude", backlog: true,
    dependencies: [{ type: "task", taskId: one.id }],
    sourceDependencies: [{ sourceId: "s", externalId: "acme/ext#1", url: null }] });
  const refused = await tasks.update(one.id, { dependencies: [{ type: "task", taskId: two.id }] });
  assert.equal(refused.ok, false);
  assert.match(String((refused as { error?: string }).error), /cycle/);
  assert.equal(registry.getTask(one.id)?.dependencies.length, 0);
});

test("the sweep's re-check satisfies a completed item and marks a not-planned one stopped", async () => {
  const { tasks } = manager();
  const inst = source();
  const a = candidate(ghIssue(40, { blockedBy: { nodes: [blocker(41, "acme/ext")], totalCount: 1 } }));
  const b = candidate(ghIssue(50, { blockedBy: { nodes: [blocker(51, "acme/ext")], totalCount: 1 } }));
  await ingest(inst, [a, b], tasks);
  for (const t of tasks.list()) await tasks.update(t.id, { enabled: true });

  const refs = sourceEdgesToRecheck(tasks.list(), inst.id);
  assert.deepEqual(refs.map((r) => r.externalId).sort(), ["acme/ext#41", "acme/ext#51"]);

  // Faked `gh issue view` answers, through the real GitHub mapping.
  const read = async (_i: TaskSourceInstance, asked: typeof refs): Promise<LinkedReadResult> => ({
    error: null,
    items: asked.map((ref) =>
      candidate({
        ...ghIssue(Number(ref.externalId.split("#")[1]), { url: ref.url, title: `Upstream ${ref.externalId}` }),
        state: "CLOSED",
        stateReason: ref.externalId.endsWith("#41") ? "COMPLETED" : "NOT_PLANNED",
      }),
    ),
  });
  assert.equal(await recheckSourceDependencies(inst, tasks, ctx, { read }), 2);

  const released = bySource(tasks, "acme/demo#40");
  const stopped = bySource(tasks, "acme/demo#50");
  const edge = (t: Task) => {
    const d = t.dependencies[0];
    assert.equal(d?.type, "source");
    return d as Extract<Task["dependencies"][number], { type: "source" }>;
  };
  assert.equal(edge(released).state, "completed");
  assert.equal(typeof edge(released).satisfiedAt, "number");
  assert.equal(edge(stopped).state, "not_planned");
  assert.equal(edge(stopped).satisfiedAt, null);
  assert.equal(edge(stopped).title, "Upstream acme/ext#51");

  const all = tasks.list();
  assert.deepEqual(readyBacklog(all, null).map((t) => t.id), [released.id]);
  assert.equal(blockersFor(stopped, null, all)[0]?.state, "stopped");
  const [dead] = deadSourceBlockersFor(stopped, backlogIndex(all, null));
  assert.equal(dead?.ownerTaskId, stopped.id);
  assert.equal(dead?.externalId, "acme/ext#51");
  assert.deepEqual(dead?.remainingDependencies, []);

  // Removing it (the Resolve action) keeps working through an ordinary update.
  const removed = await tasks.update(stopped.id, { dependencies: dead!.remainingDependencies });
  assert.equal(removed.ok, true);
  assert.deepEqual(readyBacklog(tasks.list(), null).map((t) => t.id).sort(), [released.id, stopped.id].sort());
  // Only the still-waiting edges are queued for the next re-check - none now.
  assert.deepEqual(sourceEdgesToRecheck(tasks.list(), inst.id), []);
});

test("a failed read changes nothing, and an unanswered item only moves to the back of the queue", async () => {
  const { tasks } = manager();
  const inst = source();
  await ingest(inst, [candidate(ghIssue(60, { blockedBy: { nodes: [blocker(61, "acme/x"), blocker(62, "acme/x")], totalCount: 2 } }))], tasks);
  const before = bySource(tasks, "acme/demo#60").dependencies;
  await recheckSourceDependencies(inst, tasks, ctx, { read: async () => ({ items: [], error: "gh is not authenticated" }) });
  assert.deepEqual(bySource(tasks, "acme/demo#60").dependencies, before);

  await recheckSourceDependencies(inst, tasks, ctx, {
    read: async () => ({ items: [], error: null, itemErrors: { "acme/x#61": "could not be read" } }),
  });
  const after = bySource(tasks, "acme/demo#60").dependencies;
  assert.ok(after.every((d) => d.type === "source" && d.state === "open" && d.satisfiedAt === null && d.checkedAt !== null));
  // A budget of one takes the least recently checked item.
  const [first] = sourceEdgesToRecheck(tasks.list(), inst.id, 1);
  assert.ok(first);
});

test("an unknown edge type is read as unsatisfied, kept on edit, and written back verbatim", async () => {
  const { registry, tasks } = manager();
  const t = tasks.create({ repoRoot: "/repo", intent: "x", title: "held", kind: "ship", agent: "claude", backlog: true });
  const future = { type: "jira-link", key: "MC-9", title: "A newer build's edge", satisfiedAt: 5 };
  const stored = JSON.stringify([future, { type: "source", sourceId: "s", externalId: "a/b#1", url: null, title: "b#1", state: "not_planned" }]);
  openDb().prepare("UPDATE tasks SET dependencies = ? WHERE id = ?").run(stored, t.id);

  const read = getTask(t.id)!;
  assert.equal(read.dependencies.length, 2);
  const [unknown, src] = read.dependencies;
  assert.equal(unknown?.type, "unknown");
  assert.equal(unknown?.satisfiedAt, null);
  assert.equal(unknown?.title, "A newer build's edge");
  assert.equal(src?.type === "source" && src.state, "not_planned");
  const blockers = blockersFor(read, null, [read]);
  assert.deepEqual(blockers.map((b) => b.state), ["waiting", "stopped"]);

  // An edit that keeps it (the input the edit form round-trips) keeps the stored edge.
  registry.upsertTask(read);
  const kept = await tasks.update(t.id, { dependencies: read.dependencies.map(dependencyInputOf) });
  assert.equal(kept.ok, true);
  assert.deepEqual(registry.getTask(t.id)?.dependencies, read.dependencies);

  // Round trip: the unknown edge goes back to disk exactly as the newer build wrote it.
  upsertTask(registry.getTask(t.id)!);
  const raw = openDb().prepare("SELECT dependencies FROM tasks WHERE id = ?").get(t.id) as { dependencies: string };
  assert.deepEqual(JSON.parse(raw.dependencies)[0], future);
  assert.equal(serializeTaskDependencies([]), null);
});
