import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask as baseTask } from "./helpers/session-fixture.ts";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { Task, TaskRepoEntry } from "../src/shared/types.ts";
import {
  changedTaskRepos,
  repoChangeVerdict,
  taskMergeQuorum,
  taskRepoRefs,
} from "../src/shared/task-repos.ts";

// The all-merged completion quorum, and the changed-set rule underneath it.
//
// What is at stake: a task that shipped half its work. A multi-repo dispatch is one agent
// asked for one pull request per repository it changed, and the adopted decision is that the
// task is not over until every one of them has landed. Getting that wrong in the permissive
// direction marks a task done - satisfying its dependents, releasing its slot, and letting an
// operator stop looking - while a repository's changes sit unmerged.
//
// The subtle half is the PRIMARY. Its baseline lives on `tasks.base_sha` and its pull request
// lives on the work-episode binding, while every secondary's live in `task_repos` and
// `work_episode_prs`. A rule that iterates the child tables alone is silently a rule about
// secondaries only - it looks right, it passes an all-merged test, and it completes a task
// whose primary was changed and never shipped. `holds when the primary changed but opened no
// pull request` below is that case, and it is the reason the predicate is shared with the
// phase that creates review runs rather than written twice.

const home = mkdtempSync(join(tmpdir(), "mission-multi-pr-quorum-"));
process.env.HARNESS_HOME = home;
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { setShippingConfig } = await import("../src/server/shipping/config.ts");
const { pollAndReconcilePrs } = await import("../src/server/pr.ts");

after(() => rmSync(home, { recursive: true, force: true }));

const PRIMARY_BASE = "a".repeat(40);
const EXTRA_BASE = "b".repeat(40);
const MOVED = "c".repeat(40);
const NOW = 5_000_000;

function entry(over: Partial<TaskRepoEntry> = {}): TaskRepoEntry {
  return {
    repoRoot: "/other",
    worktreePath: "/wt/task-1",
    branch: "feat/work",
    provider: "git",
    baseSha: EXTRA_BASE,
    prUrl: null,
    prState: null,
    mergedAt: null,
    ...over,
  };
}

function multiRepoTask(over: Partial<Task> = {}): Task {
  return baseTask({
    id: "task-1",
    repoRoot: "/repo",
    worktreePath: "/wt/task-0",
    branch: "feat/work",
    provider: "git",
    baseSha: PRIMARY_BASE,
    extraRepos: [entry()],
    ...over,
  });
}

// ---- the shared predicate ------------------------------------------------------------------

test("the repo set a task owns pull requests for always begins with the primary", () => {
  const refs = taskRepoRefs(multiRepoTask({ extraRepos: [entry(), entry({ repoRoot: "/third" })] }));
  assert.deepEqual(
    refs.map((r) => [r.repoRoot, r.role, r.position]),
    [
      ["/repo", "primary", 0],
      ["/other", "secondary", 1],
      ["/third", "secondary", 2],
    ],
    "the primary is a repository like any other, and it is first",
  );
  // The invariant that keeps every rule built on this identical for the tasks that are
  // nearly all of them.
  assert.deepEqual(
    taskRepoRefs(baseTask({ repoRoot: "/repo" })).map((r) => r.repoRoot),
    ["/repo"],
  );
});

test("a repo is changed by a pull request or by a head that moved, and by nothing else", () => {
  const [primary] = taskRepoRefs(multiRepoTask());
  assert.ok(primary);
  const at = (facts: Parameters<typeof repoChangeVerdict>[1]) => repoChangeVerdict(primary, facts);

  // A pull request is proof, and it outlives the worktree - which is the whole reason it is
  // the first clause rather than a consequence of the second.
  assert.equal(at({ prUrl: "https://github.com/o/r/pull/1", headSha: PRIMARY_BASE }), "changed");
  assert.equal(at({ prUrl: null, headSha: MOVED }), "changed");
  assert.equal(at({ prUrl: null, headSha: PRIMARY_BASE }), "unchanged");
  // Looked and could not answer - a tree that was torn down. Unchanged, because the
  // alternative is a task that can never complete once its checkouts are reclaimed.
  assert.equal(at({ prUrl: null, headSha: null }), "unchanged");
  // Nobody has looked yet. NOT the same answer, and the difference is what stops a restart
  // completing a task on one merged sibling before anything has read the others.
  assert.equal(at({ prUrl: null }), "unknown");

  // No baseline recorded (every task dispatched before the column existed) and no worktree
  // provisioned both read as unchanged: neither can be compared, and neither may hold a
  // task hostage.
  const noBaseline = taskRepoRefs(multiRepoTask({ baseSha: null }))[0]!;
  assert.equal(repoChangeVerdict(noBaseline, { prUrl: null, headSha: MOVED }), "unchanged");
  const noTree = taskRepoRefs(multiRepoTask({ worktreePath: null }))[0]!;
  assert.equal(repoChangeVerdict(noTree, { prUrl: null, headSha: MOVED }), "unchanged");
});

test("the changed set covers the primary, not only the attached repos", () => {
  const task = multiRepoTask();
  // The primary moved off its baseline; the secondary did not.
  const changed = changedTaskRepos(task, (ref) =>
    ref.role === "primary"
      ? { prUrl: null, headSha: MOVED }
      : { prUrl: null, headSha: EXTRA_BASE },
  );
  assert.deepEqual(changed.map((c) => c.ref.repoRoot), ["/repo"]);
});

test("the quorum names what it is waiting for, and is never satisfied by nothing", () => {
  const task = multiRepoTask();
  const waiting = taskMergeQuorum(task, (ref) =>
    ref.role === "primary"
      ? { prUrl: "https://github.com/o/r/pull/1", mergedAt: NOW, headSha: MOVED }
      : { prUrl: "https://github.com/o/r/pull/2", mergedAt: null, headSha: MOVED },
  );
  assert.equal(waiting.satisfied, false);
  assert.deepEqual(waiting.holds.map((h) => [h.reason, h.ref.repoRoot]), [["unmerged", "/other"]]);

  // A task nothing can be shown to have changed is not a completed task.
  const empty = taskMergeQuorum(task, (ref) => ({ prUrl: null, headSha: ref.baseSha }));
  assert.equal(empty.satisfied, false);
  assert.deepEqual(empty.holds, []);
  assert.deepEqual(empty.merged, []);
});

// ---- the reconciler ------------------------------------------------------------------------

function discovered(id: string, cwd: string): DiscoveredSession {
  return {
    syntheticId: id,
    agent: "claude",
    name: `agent-${id}`,
    nameSource: "process",
    cwd,
    gitBranch: "feat/work",
    gitRoot: "/repo",
    repoRoot: "/repo",
    pid: 100,
    tty: null,
    terminals: [],
    startedAt: 0,
  };
}

/**
 * A dispatched multi-repo task whose agent has since gone away - the state in which the
 * reconciler, rather than either session-shaped path, is what decides.
 */
function fixture(id: string, over: Partial<Task> = {}) {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const taskId = `task-${id}`;
  const cwd = `/wt/${id}-0`;
  const extraCwd = `/wt/${id}-1`;
  registry.applyDiscovery([discovered(id, cwd)]);
  registry.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: `${id}-episode`,
    cwd,
    transcriptPath: null,
    env: {},
  });
  registry.upsertTask(
    multiRepoTask({
      id: taskId,
      title: "Rename the shared field",
      status: "running",
      sessionId: id,
      worktreePath: cwd,
      homeName: "Rename the shared field",
      extraRepos: [entry({ worktreePath: extraCwd })],
      ...over,
    }),
  );
  registry.bindTaskToWorkEpisode(taskId, id);
  const episode = registry.workEpisodeForSession(id)!;
  return { registry, tasks, id, taskId, cwd, extraCwd, episode };
}

type Fixture = ReturnType<typeof fixture>;

/** `gh` reporting a pull request on the PRIMARY worktree's branch, as the poller would. */
function primaryPr(f: Fixture, url: string, mergedAt: number | null = null): void {
  f.registry.reconcilePrs(
    new Map([[f.id, {
      url,
      number: 1,
      state: mergedAt === null ? ("open" as const) : ("merged" as const),
      checks: null,
      branch: "feat/work",
      agentSessionId: `${f.id}-episode`,
      episodeId: f.episode.episodeId,
      createdAt: f.episode.startedAt,
      mergedAt,
      headSha: "head",
      worktreeHeadSha: "head",
    }]]),
    new Set(),
  );
}

/** `gh` reporting a pull request inside an ATTACHED repo's worktree. */
function extraPr(f: Fixture, url: string, mergedAt: number | null = null): void {
  // By task, because these fixtures share one database: a fresh Registry rehydrates every
  // in-flight task, so the first target in the list belongs to whichever test ran first.
  const target = f.registry.extraRepoPrPollTargets().find((t) => t.taskId === f.taskId);
  assert.ok(target, "the attached repo is polled at all");
  f.registry.reconcileRepoPrs(
    new Map([[target.key, {
      url,
      number: 2,
      state: mergedAt === null ? ("open" as const) : ("merged" as const),
      checks: null,
      branch: target.branch,
      agentSessionId: target.agentSessionId,
      episodeId: target.episodeId,
      createdAt: f.episode.startedAt,
      mergedAt,
      headSha: "extra-head",
      worktreeHeadSha: "extra-head",
    }]]),
    new Set(),
  );
}

/** The agent leaves, which is what hands the decision to the reconciler. */
function departs(f: Fixture): void {
  f.registry.applyDiscovery([]);
  f.registry.emit("event", { type: "session_remove", id: f.id });
}

/**
 * One by-URL poll pass in which `merged` report merged and no branch is asked about.
 *
 * The only channel left once the agent is gone: the branch poller answers for LIVE sessions,
 * so a pull request that lands afterwards is seen exactly if its url is still harvested.
 */
async function pollMerged(
  f: Fixture,
  merged: Record<string, number>,
): Promise<string[]> {
  const asked: string[] = [];
  await pollAndReconcilePrs(
    f.registry,
    async () => null,
    async (url) => {
      asked.push(url);
      return url in merged ? { state: "merged" as const, mergedAt: merged[url]! } : null;
    },
    undefined,
    Date.now(),
    async () => null,
  );
  return asked;
}

const PR_A = "https://github.com/example/repo/pull/10";
const PR_B = "https://github.com/example/other/pull/20";

test("a two-repo task completes on the second merge, not the first", async () => {
  setShippingConfig({ closeSessionAfterMerge: false });
  const f = fixture("both");
  primaryPr(f, PR_A);
  extraPr(f, PR_B);
  // Both repos moved off their baselines, which is what an agent that opened two pull
  // requests has necessarily done.
  f.registry.recordWorktreeHeads(new Map([[f.cwd, MOVED], [f.extraCwd, MOVED]]));

  extraPr(f, PR_B, NOW);
  departs(f);
  assert.equal(
    f.registry.getTask(f.taskId)?.status,
    "failed",
    "one merged sibling is not the task's outcome",
  );

  primaryPr(f, PR_A, NOW + 1);
  const t = f.registry.getTask(f.taskId)!;
  assert.equal(t.status, "done");
  // Every landed pull request is named, in repo order, and the scalar link stays the
  // primary's - which is what every existing consumer of `outcomeUrl` means by it.
  assert.equal(t.outcome, `merged ${PR_A}, ${PR_B}`);
  assert.equal(t.outcomeUrl, PR_A);
});

test("holds when the primary changed but opened no pull request, while a sibling merged", async () => {
  // The case a secondaries-only changed set completes wrongly. The agent committed to the
  // primary and shipped only the attached repo; the primary's work is real and unmerged.
  setShippingConfig({ closeSessionAfterMerge: false });
  const f = fixture("primary-unshipped");
  extraPr(f, PR_B);
  f.registry.recordWorktreeHeads(new Map([[f.cwd, MOVED], [f.extraCwd, MOVED]]));
  extraPr(f, PR_B, NOW);

  departs(f);

  const t = f.registry.getTask(f.taskId)!;
  assert.notEqual(t.status, "done");
  assert.equal(t.outcomeUrl, null, "nothing claims this task shipped");
});

test("a repository the agent never touched is exempt from the quorum", async () => {
  // The other direction, and the reason the rule is a changed SET rather than "every attached
  // repo". An agent that finds the second repo needed no change must still be able to finish.
  setShippingConfig({ closeSessionAfterMerge: false });
  const f = fixture("untouched-extra");
  primaryPr(f, PR_A);
  f.registry.recordWorktreeHeads(new Map([[f.cwd, MOVED], [f.extraCwd, EXTRA_BASE]]));
  primaryPr(f, PR_A, NOW);

  departs(f);

  const t = f.registry.getTask(f.taskId)!;
  assert.equal(t.status, "done");
  assert.equal(t.outcome, `merged ${PR_A}`);
});

test("an untouched PRIMARY is exempt on exactly the same rule", async () => {
  // Proof that the primary is evaluated rather than merely required: the same baseline
  // comparison that exempted the secondary above exempts it, and the task completes on the
  // attached repo's pull request alone.
  setShippingConfig({ closeSessionAfterMerge: false });
  const f = fixture("untouched-primary");
  extraPr(f, PR_B);
  f.registry.recordWorktreeHeads(new Map([[f.cwd, PRIMARY_BASE], [f.extraCwd, MOVED]]));
  extraPr(f, PR_B, NOW);

  departs(f);

  const t = f.registry.getTask(f.taskId)!;
  assert.equal(t.status, "done");
  assert.equal(t.outcome, `merged ${PR_B}`);
  assert.equal(t.outcomeUrl, PR_B, "with no primary pull request, the outcome link is what landed");
});

test("a head nothing has read yet holds the task until something reads it", async () => {
  // The restart case. No sweep has run, so the primary's membership of the changed set is
  // undecided - and an undecided repository must not be silently treated as unchanged.
  setShippingConfig({ closeSessionAfterMerge: false });
  const f = fixture("unobserved");
  extraPr(f, PR_B);
  extraPr(f, PR_B, NOW);

  departs(f);
  assert.notEqual(f.registry.getTask(f.taskId)?.status, "done", "nothing has looked at the primary");

  // The sweep lands and says the primary never moved; now it can finish.
  f.registry.recordWorktreeHeads(new Map([[f.cwd, PRIMARY_BASE], [f.extraCwd, MOVED]]));
  f.registry.emit("pr_merges_recorded");

  assert.equal(f.registry.getTask(f.taskId)?.status, "done");
});

test("a closed-unmerged sibling never satisfies the quorum", async () => {
  setShippingConfig({ closeSessionAfterMerge: false });
  const f = fixture("closed-sibling");
  primaryPr(f, PR_A);
  extraPr(f, PR_B);
  f.registry.recordWorktreeHeads(new Map([[f.cwd, MOVED], [f.extraCwd, MOVED]]));
  primaryPr(f, PR_A, NOW);

  departs(f);

  // The attached repo's pull request was closed rather than merged, so the poller stops
  // reporting it and its episode row is never stamped. The task stays visible.
  const t = f.registry.getTask(f.taskId)!;
  assert.notEqual(t.status, "done");
});

test("a cancelled multi-repo task is upgraded only by the FULL quorum", async () => {
  // Two things at once, and both are load-bearing once the agent is gone. An attached repo's
  // pull request has to keep being polled BY URL, or a merge that lands after the session
  // ends is never observed and the task waits for ever - and even a terminal row, which a
  // single merge would upgrade today, must wait for all of them.
  setShippingConfig({ closeSessionAfterMerge: false });
  const f = fixture("cancelled");
  primaryPr(f, PR_A);
  extraPr(f, PR_B);
  f.registry.recordWorktreeHeads(new Map([[f.cwd, MOVED], [f.extraCwd, MOVED]]));
  departs(f);

  const cancelled = f.registry.getTask(f.taskId)!;
  f.registry.upsertTask({ ...cancelled, status: "cancelled", error: "operator cancelled" });
  const watched = f.registry.taskPrPollTargets();
  assert.ok(watched.includes(PR_A), "the primary's pull request is still watched");
  assert.ok(watched.includes(PR_B), "and so is the attached repo's");

  await pollMerged(f, { [PR_A]: NOW });
  assert.notEqual(
    f.registry.getTask(f.taskId)?.status,
    "done",
    "one merge does not upgrade a cancelled multi-repo task either",
  );

  await pollMerged(f, { [PR_A]: NOW, [PR_B]: NOW + 1 });
  const t = f.registry.getTask(f.taskId)!;
  assert.equal(t.status, "done");
  assert.equal(t.outcome, `merged ${PR_A}, ${PR_B}`);
  assert.equal(t.error, null);
});

test("a single-repo task still completes on its own merge, unchanged", async () => {
  // The regression that matters most: everything above is reached only through
  // `extraRepos.length > 0`, and a single-repo task must take the branch it always took.
  setShippingConfig({ closeSessionAfterMerge: false });
  const f = fixture("single", { extraRepos: [] });
  primaryPr(f, PR_A);
  primaryPr(f, PR_A, NOW);
  departs(f);

  const t = f.registry.getTask(f.taskId)!;
  assert.equal(t.status, "done");
  assert.equal(t.outcome, `merged ${PR_A}`);
  assert.equal(t.outcomeUrl, PR_A);
  // And it costs no head sweep at all: nothing single-repo is ever asked about.
  assert.equal(f.registry.worktreeHeadTargets().includes(f.cwd), false);
  assert.deepEqual(f.registry.extraRepoPrPollTargets().filter((t) => t.taskId === f.taskId), []);
});
