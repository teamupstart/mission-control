import { test } from "node:test";
import assert from "node:assert/strict";
import { mkTask } from "./helpers/session-fixture.ts";
import {
  STACKING_SHIPPED_DEFAULT,
  effectiveEdgeMode,
  effectiveStacking,
  expectedStackBase,
  stackDepth,
  stackEligibility,
  stackReleased,
  stackStartEdge,
  stackedOnLabel,
  type StackReleaseFacts,
} from "../src/shared/stacking.ts";
import { declaredBlockers } from "../src/shared/backlog.ts";
import { ShippingConfigPatchSchema, ShippingConfigSchema, TaskDependencyInputSchema } from "../src/shared/protocol.ts";
import { dependencyInputOf } from "../src/shared/task-bulk.ts";
import type { Task, TaskDependency } from "../src/shared/types.ts";

// The shared rules of Stacked pull requests: which edge may stack, when the shared blocker
// predicate lets a dependent start, which base a stacked pull request belongs on, and when it
// is released to merge. All pure, so every case is a table row.

type TaskEdge = Extract<TaskDependency, { type: "task" }>;

function edge(taskId: string, over: Partial<TaskEdge> = {}): TaskEdge {
  return {
    type: "task", taskId, title: taskId, sessionId: null, episodeId: null, agentSessionId: null,
    branch: null, prUrl: null, selectedAt: 1, satisfiedAt: null, ...over,
  };
}

const STACK = ShippingConfigSchema.parse({ stacking: "stack" });
const MERGE = ShippingConfigSchema.parse({ stacking: "merge" });

const parentA = mkTask({ id: "A", title: "Phase 1", status: "running", repoRoot: "/repo" });
const stamp = { stackReadyAt: 5, stackBaseBranch: "feat/a", stackBaseSha: "a".repeat(40), stackPrUrl: "https://github.com/acme/repo/pull/7" };

function byId(...tasks: Task[]): Map<string, Task> {
  return new Map(tasks.map((task) => [task.id, task]));
}

test("the shipped default is wait-for-merge, and an absent key follows it", () => {
  assert.equal(STACKING_SHIPPED_DEFAULT, "merge");
  const parsed = ShippingConfigSchema.parse({});
  assert.equal(parsed.stacking, undefined, "no stored default: absent means the shipped default");
  assert.equal(effectiveStacking(parsed), STACKING_SHIPPED_DEFAULT);
  assert.equal(effectiveStacking(STACK), "stack");
});

test("an old Shipping blob gains a depth default and keeps stacking absent", () => {
  const old = ShippingConfigSchema.parse({ autoMerge: true, soakMinutes: 4, repoAllowlist: ["/r"] });
  assert.equal(old.maxStackDepth, 3);
  assert.equal("stacking" in old && old.stacking !== undefined, false);
  // Saving another card is a patch without the key, so it cannot pin the install.
  const patched = ShippingConfigSchema.parse({ ...old, ...ShippingConfigPatchSchema.parse({ soakMinutes: 9 }) });
  assert.equal(patched.stacking, undefined);
  assert.equal(JSON.parse(JSON.stringify(patched)).stacking, undefined);
  assert.throws(() => ShippingConfigSchema.parse({ maxStackDepth: 6 }));
  assert.throws(() => ShippingConfigSchema.parse({ maxStackDepth: 0 }));
});

test("an edge's mode inherits the default, an explicit mode wins, and plan edges never stack", () => {
  assert.equal(effectiveEdgeMode(edge("A"), STACK), "stack");
  assert.equal(effectiveEdgeMode(edge("A"), MERGE), "merge");
  assert.equal(effectiveEdgeMode(edge("A", { mode: "merge" }), STACK), "merge");
  assert.equal(effectiveEdgeMode(edge("A", { mode: "stack" }), MERGE), "stack");
  const plan: TaskDependency = {
    type: "plan", repoKey: "k", planId: "p", revision: 1, title: "plan", selectedAt: null, satisfiedAt: null,
    sessionId: null, episodeId: null, agentSessionId: null, branch: null, prUrl: null,
  };
  assert.equal(effectiveEdgeMode(plan, STACK), "merge");
});

test("dependency inputs carry mode, and a stored edge's mode survives an edit round trip", () => {
  assert.deepEqual(TaskDependencyInputSchema.parse({ type: "task", taskId: "A", mode: "stack" }), { type: "task", taskId: "A", mode: "stack" });
  assert.deepEqual(TaskDependencyInputSchema.parse({ type: "task", taskId: "A" }), { type: "task", taskId: "A" });
  assert.throws(() => TaskDependencyInputSchema.parse({ type: "task", taskId: "A", mode: "rebase" }));
  assert.deepEqual(dependencyInputOf(edge("A", { mode: "merge" })), { type: "task", taskId: "A", mode: "merge" });
  assert.deepEqual(dependencyInputOf(edge("A")), { type: "task", taskId: "A" });
});

test("stackEligibility: the eligibility table", () => {
  const sameRepo = mkTask({ id: "C", dependencies: [edge("A")] });
  const ok = stackEligibility(sameRepo, [parentA, sameRepo], STACK);
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.edge.taskId, "A");

  // Inheriting wait-for-merge, or set to After merge, waits.
  assert.equal(stackEligibility(sameRepo, [parentA, sameRepo], MERGE).ok, false);
  const explicitMerge = mkTask({ id: "C", dependencies: [edge("A", { mode: "merge" })] });
  const merge = stackEligibility(explicitMerge, [parentA, explicitMerge], STACK);
  assert.equal(!merge.ok && merge.code, "after-merge");

  // Cross repository: keeps the merge rule.
  const other = mkTask({ id: "X", status: "running", repoRoot: "/other" });
  const cross = mkTask({ id: "C", dependencies: [edge("X")] });
  const crossVerdict = stackEligibility(cross, [other, cross], STACK);
  assert.equal(!crossVerdict.ok && crossVerdict.code, "cross-repository-unmerged");

  // Two unmerged same-repository prerequisites: one base, so wait.
  const parentB = mkTask({ id: "B", status: "running" });
  const two = mkTask({ id: "C", dependencies: [edge("A"), edge("B")] });
  const twoVerdict = stackEligibility(two, [parentA, parentB, two], STACK);
  assert.equal(!twoVerdict.ok && twoVerdict.code, "several-unmerged");
  // ...until one merges; then the other is the one to stack on.
  const oneMerged = mkTask({ id: "C", dependencies: [edge("A", { satisfiedAt: 9 }), edge("B")] });
  const oneMergedVerdict = stackEligibility(oneMerged, [parentA, parentB, oneMerged], STACK);
  assert.equal(oneMergedVerdict.ok && oneMergedVerdict.edge.taskId, "B");

  // A multi-repository prerequisite with an unmerged secondary change waits for merge.
  const multi = mkTask({
    id: "A", status: "running",
    extraRepos: [{ repoRoot: "/second", worktreePath: null, branch: null, provider: null, worktreeLeaseId: null, baseSha: null,
      prUrl: "https://github.com/acme/second/pull/3", prState: "open", mergedAt: null }],
  });
  const multiVerdict = stackEligibility(sameRepo, [multi, sameRepo], STACK);
  assert.equal(!multiVerdict.ok && multiVerdict.code, "secondary-unmerged");
  const multiMerged = { ...multi, extraRepos: [{ ...multi.extraRepos[0]!, prState: "merged", mergedAt: 4 }] };
  assert.equal(stackEligibility(sameRepo, [multiMerged, sameRepo], STACK).ok, true);

  // A stopped prerequisite cannot be stacked on.
  const stopped = { ...parentA, status: "failed" as const };
  const stoppedVerdict = stackEligibility(sameRepo, [stopped, sameRepo], STACK);
  assert.equal(!stoppedVerdict.ok && stoppedVerdict.code, "prerequisite-stopped");

  // A bare session prerequisite has nothing to stack on.
  const withSession = mkTask({ id: "C", dependencies: [{
    type: "session", sessionId: "s", title: "op session", episodeId: null, agentSessionId: null, branch: null,
    prUrl: null, selectedAt: 1, satisfiedAt: null,
  }] });
  const sessionVerdict = stackEligibility(withSession, [withSession], STACK);
  assert.equal(!sessionVerdict.ok && sessionVerdict.code, "not-a-task");
});

test("the depth cap counts unmerged stacked ancestors", () => {
  const root = mkTask({ id: "R", status: "running" });
  const a = mkTask({ id: "A", status: "running", stackParentTaskId: "R", dependencies: [edge("R")] });
  const b = mkTask({ id: "B", status: "running", stackParentTaskId: "A", dependencies: [edge("A")] });
  const tasks = byId(root, a, b);
  assert.equal(stackDepth(root, tasks), 0);
  assert.equal(stackDepth(a, tasks), 1);
  assert.equal(stackDepth(b, tasks), 2);
  const c = mkTask({ id: "C", dependencies: [edge("B")] });
  const all = [root, a, b, c];
  assert.equal(stackEligibility(c, all, { ...STACK, maxStackDepth: 3 }).ok, true);
  const tooDeep = stackEligibility(c, all, { ...STACK, maxStackDepth: 2 });
  assert.equal(!tooDeep.ok && tooDeep.code, "too-deep");
  // The bottom merging shortens every stack above it.
  const aMerged = { ...a, dependencies: [edge("R", { satisfiedAt: 3 })] };
  assert.equal(stackDepth(b, byId(root, aMerged, b)), 1);
  assert.equal(stackEligibility(c, [root, aMerged, b, c], { ...STACK, maxStackDepth: 2 }).ok, true);
});

test("declaredBlockersIn: only a stamped, structurally eligible edge stops blocking a start", () => {
  const stamped = mkTask({ id: "C", dependencies: [edge("A", stamp)] });
  assert.deepEqual(declaredBlockers(stamped, [parentA, stamped]), []);
  assert.equal(stackStartEdge(stamped, byId(parentA, stamped))?.taskId, "A");
  // satisfiedAt is untouched by stacking.
  assert.equal(stamped.dependencies[0]!.satisfiedAt, null);

  // Unstamped: an explicit null, and an edge written before the field existed.
  const nullStamp = mkTask({ id: "C", dependencies: [edge("A", { stackReadyAt: null })] });
  const legacy = mkTask({ id: "C", dependencies: [edge("A")] });
  assert.equal("stackReadyAt" in legacy.dependencies[0]!, false);
  for (const task of [nullStamp, legacy]) {
    assert.deepEqual(declaredBlockers(task, [parentA, task]).map((b) => b.taskId), ["A"]);
  }

  // An explicit After merge never releases, even with a stale stamp.
  const merge = mkTask({ id: "C", dependencies: [edge("A", { ...stamp, mode: "merge" })] });
  assert.deepEqual(declaredBlockers(merge, [parentA, merge]).map((b) => b.taskId), ["A"]);

  // A second unmerged same-repository prerequisite makes the stamp moot.
  const parentB = mkTask({ id: "B", status: "running" });
  const two = mkTask({ id: "C", dependencies: [edge("A", stamp), edge("B")] });
  assert.deepEqual(declaredBlockers(two, [parentA, parentB, two]).map((b) => b.taskId).sort(), ["A", "B"]);

  // Only a backlog dependent starts on a stamp.
  const running = mkTask({ id: "C", status: "running", dependencies: [edge("A", stamp)] });
  assert.deepEqual(declaredBlockers(running, [parentA, running]).map((b) => b.taskId), ["A"]);
});

test("expectedStackBase: the parent's branch while it is open, the default branch after", () => {
  assert.equal(expectedStackBase({ state: "OPEN", headRefName: "feat/a" }, "main"), "feat/a");
  assert.equal(expectedStackBase({ state: "MERGED", headRefName: "feat/a" }, "main"), "main");
  assert.equal(expectedStackBase({ state: "CLOSED", headRefName: "feat/a" }, "main"), "main");
  // Unknown never guesses.
  assert.equal(expectedStackBase(null, "main"), null);
  assert.equal(expectedStackBase({ state: null, headRefName: "feat/a" }, "main"), null);
  assert.equal(expectedStackBase({ state: "MERGED", headRefName: "feat/a" }, null), null);
  assert.equal(expectedStackBase({ state: "OPEN", headRefName: "" }, "main"), null);
});

const onMain: StackReleaseFacts = {
  baseRefName: "main", defaultBranch: "main", parentState: "MERGED",
  parentMergeCommitInHead: true, stackBaseInHead: null, parentLastHeadInHead: null,
};

test("stackReleased: a merged parent releases only on verified ancestry", () => {
  assert.equal(stackReleased(onMain), true);
  // An automatic retarget with no restack: the merge commit is not in the head.
  assert.equal(stackReleased({ ...onMain, parentMergeCommitInHead: false }), false);
  // A failed compare holds.
  assert.equal(stackReleased({ ...onMain, parentMergeCommitInHead: null }), false);
  // Not on the default branch yet holds, whatever ancestry says.
  assert.equal(stackReleased({ ...onMain, baseRefName: "feat/a" }), false);
  assert.equal(stackReleased({ ...onMain, baseRefName: null }), false);
  assert.equal(stackReleased({ ...onMain, defaultBranch: null }), false);
  // An open or unknown parent never releases.
  assert.equal(stackReleased({ ...onMain, parentState: "OPEN" }), false);
  assert.equal(stackReleased({ ...onMain, parentState: null }), false);
});

test("stackReleased: a closed parent releases only once the child carries none of it", () => {
  const closed: StackReleaseFacts = { ...onMain, parentState: "CLOSED", parentMergeCommitInHead: null, stackBaseInHead: false, parentLastHeadInHead: false };
  assert.equal(stackReleased(closed), true);
  // The parent pushed again before closing: its last head is absent, the cut commit is not.
  assert.equal(stackReleased({ ...closed, stackBaseInHead: true }), false);
  // The default branch merged into a child whose parent closed: the parent's commits stay.
  assert.equal(stackReleased({ ...closed, stackBaseInHead: true, parentLastHeadInHead: true }), false);
  // Unknown either way holds.
  assert.equal(stackReleased({ ...closed, stackBaseInHead: null }), false);
  assert.equal(stackReleased({ ...closed, parentLastHeadInHead: null }), false);
});

test("stackedOnLabel names the parent pull request a task was cut on", () => {
  assert.equal(stackedOnLabel(mkTask({ stackParentTaskId: "A", stackPrUrl: "https://github.com/acme/repo/pull/42" })), "Stacked on #42");
  assert.equal(stackedOnLabel(mkTask()), null);
});

test("a blocked stack card names the depth cap when the board has it", async () => {
  const { stackWaitLabel } = await import("../src/web/lib/backlog-copy.ts");
  const root = mkTask({ id: "R", title: "Root", status: "running" });
  const a = mkTask({ id: "A", title: "Phase A", status: "running", stackParentTaskId: "R", dependencies: [edge("R")] });
  const c = mkTask({ id: "C", dependencies: [edge("A", { mode: "stack" })] });
  const tasks = byId(root, a, c);
  assert.equal(stackWaitLabel(c, tasks, { maxStackDepth: 1 }), "can't stack yet - the stack under Phase A is already 1 deep");
  assert.equal(stackWaitLabel(c, tasks, { maxStackDepth: 2 }), "stacks on Phase A once its pull request is open and its agent is done");
  assert.equal(stackWaitLabel(c, tasks), "stacks on Phase A once its pull request is open and its agent is done",
    "without the cap only the structural rule is checked");
});

test("an inherited Stack edge gets the same wait reason as an explicit one, when the board has the default", async () => {
  const { stackWaitLabel } = await import("../src/web/lib/backlog-copy.ts");
  const root = mkTask({ id: "R", title: "Root", status: "running" });
  const a = mkTask({ id: "A", title: "Phase A", status: "running", stackParentTaskId: "R", dependencies: [edge("R")] });
  // No mode on the edge: it inherits the Shipping default.
  const c = mkTask({ id: "C", dependencies: [edge("A")] });
  const tasks = byId(root, a, c);
  assert.equal(stackWaitLabel(c, tasks, { stacking: "stack", maxStackDepth: 1 }), "can't stack yet - the stack under Phase A is already 1 deep");
  assert.equal(stackWaitLabel(c, tasks, { stacking: "stack", maxStackDepth: 3 }), "stacks on Phase A once its pull request is open and its agent is done");
  assert.equal(stackWaitLabel(c, tasks, { stacking: "merge", maxStackDepth: 1 }), null, "a Wait for merge default keeps the plain after-X copy");
  assert.equal(stackWaitLabel(c, tasks, { maxStackDepth: 1 }), null, "without the default, only an explicit Stack choice is read");
  // An explicit After merge under a Stack default is not a stack.
  const merge = { ...c, dependencies: [edge("A", { mode: "merge" })] };
  assert.equal(stackWaitLabel(merge, byId(root, a, merge), { stacking: "stack", maxStackDepth: 1 }), null);
});
