import { after, afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask as baseTask } from "./helpers/session-fixture.ts";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { PrRefs } from "../src/server/inspector/github.ts";
import type { StackGitHub } from "../src/server/stacking/github.ts";
import type { TaskDependency } from "../src/shared/types.ts";

// The PR poller's half of the #1416 / #1417 gap, against a real Registry, TaskManager and
// SQLite, with GitHub scripted behind the stacking seam:
//
//  - a stacked pull request merged into anything but the default branch marks no episode
//    merged, completes no task and satisfies no dependency edge - by URL, on a live session's
//    branch, and as a completed task's merge evidence - while a merge into the default branch,
//    and any merge of an ordinary pull request, settles exactly as before;
//  - the poller's merge observation retargets the parent's open stacked children at once;
//  - the session that starts the recovery on a new branch keeps its task, and the recovery
//    pull request's merge into the default branch is what completes it.

const home = mkdtempSync(join(tmpdir(), "mission-stacking-stray-poller-"));
process.env.HARNESS_HOME = home;
const db = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("./helpers/task-manager-fixture.ts");
const { pollAndReconcilePrs } = await import("../src/server/pr.ts");
const { StackMergeWatch } = await import("../src/server/stacking/merges.ts");
const { useStackGitHub } = await import("../src/server/stacking/github.ts");
const { setShippingConfig } = await import("../src/server/shipping/config.ts");
const { observeStackLifecycle } = await import("../src/server/stacking/state.ts");
const { stackStandingFor } = await import("../src/server/stacking/delivery.ts");
const { activeStackGitHub } = await import("../src/server/stacking/github.ts");

const FOREMAN_OFF = { enabled: false, mode: "live", repoAllowlist: ["/repo"] } as unknown as Parameters<typeof stackStandingFor>[2];

const managers: InstanceType<typeof TaskManager>[] = [];
let restoreGitHub: (() => void) | null = null;
afterEach(async () => {
  restoreGitHub?.();
  restoreGitHub = null;
  for (const manager of managers.splice(0)) {
    manager.stopMissionSessionClosures();
    await manager.settleWorktreeReturns();
  }
});
after(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => setShippingConfig({ closeSessionAfterMerge: false }));

const PARENT = "https://github.com/example/repo/pull/1416";
const NOW = 5_000_000;

/** GitHub behind the stacking seam: refs by URL, and every read and retarget recorded. */
function github(refs: Record<string, Partial<PrRefs>>, over: Partial<StackGitHub> = {}) {
  const reads: string[] = [];
  const retargets: { number: number; base: string }[] = [];
  const seam: StackGitHub = {
    prRefs: async (_cwd, url) => {
      reads.push(url);
      const found = refs[url];
      return found
        ? { ok: true, value: { state: "MERGED", isDraft: false, headSha: "h".repeat(40), headRefName: "feat/x",
            baseRefName: "main", defaultBranch: "main", mergeCommitSha: null, ...found } }
        : { ok: false, error: "unreadable" };
    },
    isAncestor: async () => ({ ok: false, error: "unused" }),
    compare: async () => ({ ok: false, error: "unused" }),
    mergeBase: async () => ({ ok: false, error: "unused" }),
    branchSha: async () => ({ ok: false, reason: "unused", outcomeUnknown: false }),
    repositories: async () => [{ owner: "example", repo: "repo" }],
    primaryRepository: async () => ({ owner: "example", repo: "repo" }),
    retarget: async (_cwd, _o, _r, number, base) => {
      retargets.push({ number, base });
      return { ok: true };
    },
    ...over,
  };
  restoreGitHub = useStackGitHub(seam);
  return { reads, retargets };
}

function discovered(id: string, cwd: string, over: Partial<DiscoveredSession> = {}): DiscoveredSession {
  return {
    syntheticId: id, agent: "claude", name: `agent-${id}`, nameSource: "process", cwd, gitBranch: "feat/phase-2",
    gitRoot: "/repo", repoRoot: "/repo", pid: 100, tty: null, terminals: [], startedAt: 0, ...over,
  };
}

/** A stacked task's fields: cut on #1416's branch in the same repository. */
const STACKED = {
  stackParentTaskId: "task-phase-1", stackBaseBranch: "feat/phase-1", stackBaseSha: "c".repeat(40), stackPrUrl: PARENT,
} as const;

/** A task with an idle agent bound to its work episode, and a dependent waiting on it. */
function fleet(id: string, over: Partial<ReturnType<typeof baseTask>> = {}) {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  managers.push(tasks);
  const taskId = `task-${id}`;
  const cwd = `/repo/${id}`;
  const disco = discovered(id, cwd);
  registry.applyDiscovery([disco]);
  registry.applyHook({ agent: "claude", event: "Stop", sessionId: `${id}-episode`, cwd, transcriptPath: null, env: {} });
  registry.upsertTask(baseTask({
    id: taskId, title: "Phase 2", status: "running", sessionId: id, worktreePath: null, homeName: null, repoRoot: "/repo", ...over,
  }));
  registry.bindTaskToWorkEpisode(taskId, id);
  const edge: TaskDependency = {
    type: "task", taskId, title: "Phase 2", sessionId: null, episodeId: null, agentSessionId: null, branch: null,
    prUrl: null, selectedAt: 1, satisfiedAt: null,
  };
  registry.upsertTask(baseTask({ id: `dependent-of-${id}`, title: "Phase 3", status: "backlog", dependencies: [edge] }));
  const episode = () => registry.workEpisodeForSession(id)!;
  return { registry, tasks, id, taskId, cwd, disco, episode, dependent: () => registry.getTask(`dependent-of-${id}`)! };
}

/** `gh` reporting one pull request for the session's branch, in this state. */
function onBranch(f: ReturnType<typeof fleet>, url: string, state: "open" | "merged", headSha = "head", mergedAt = NOW) {
  const number = Number(url.split("/").at(-1));
  return async () => ({
    url, number, state, checks: "passing" as const, createdAt: f.episode().startedAt,
    mergedAt: state === "merged" ? mergedAt : null, headSha, worktreeHeadSha: headSha,
  });
}

async function poll(
  f: ReturnType<typeof fleet>,
  lookup: Parameters<typeof pollAndReconcilePrs>[1],
  watch: InstanceType<typeof StackMergeWatch>,
  byUrl: Parameters<typeof pollAndReconcilePrs>[2] = async () => null,
  telemetry: (() => string[]) | null = () => [],
): Promise<void> {
  await pollAndReconcilePrs(f.registry, lookup, byUrl, undefined, NOW, async () => null, telemetry, watch);
}

const edgeSatisfied = (f: ReturnType<typeof fleet>): boolean => {
  const edge = f.dependent().dependencies[0]!;
  return edge.type === "task" && edge.satisfiedAt !== null;
};

// ---- a merge that missed the default branch completes nothing ----

test("a stacked pull request merged into its parent's branch leaves the task open and its dependent blocked", async () => {
  const f = fleet("stray-live", STACKED);
  const child = "https://github.com/example/repo/pull/1417";
  github({ [child]: { baseRefName: "feat/phase-1" } });
  const watch = new StackMergeWatch();
  await poll(f, onBranch(f, child, "open"), watch);
  assert.equal(f.registry.getSession(f.id)?.prState, "open");

  await poll(f, onBranch(f, child, "merged"), watch);
  const task = f.registry.getTask(f.taskId)!;
  assert.equal(task.status, "running", "a merge into the parent's branch completed the task");
  assert.equal(task.outcomeUrl, null);
  assert.equal(f.episode().mergedAt, null, "the work episode was marked merged");
  assert.equal(edgeSatisfied(f), false, "the dependent was released");
  assert.notDeepEqual(f.tasks.dependencyBlockers(f.dependent()), [], "the dependent is no longer blocked");
  // Its card is left as it was - the open pull request Foreman's follow-up reads.
  assert.equal(f.registry.getSession(f.id)?.prState, "open");
});

test("the same stacked pull request merged into the default branch completes exactly as before", async () => {
  const f = fleet("landed-live", STACKED);
  const child = "https://github.com/example/repo/pull/1418";
  github({ [child]: { baseRefName: "main" } });
  const watch = new StackMergeWatch();
  await poll(f, onBranch(f, child, "open"), watch);
  await poll(f, onBranch(f, child, "merged"), watch);
  const task = f.registry.getTask(f.taskId)!;
  assert.equal(task.status, "done");
  assert.equal(task.outcomeUrl, child);
  assert.equal(edgeSatisfied(f), true);
});

test("an ordinary pull request's merge is untouched and costs no GitHub read", async () => {
  const f = fleet("ordinary-live");
  const pr = "https://github.com/example/repo/pull/1419";
  const gh = github({});
  const watch = new StackMergeWatch();
  await poll(f, onBranch(f, pr, "open"), watch);
  await poll(f, onBranch(f, pr, "merged"), watch);
  assert.equal(f.registry.getTask(f.taskId)!.status, "done");
  assert.deepEqual(gh.reads, [], "a non-stacked merge was read from GitHub");
});

test("a stacked merge GitHub cannot place is held until it can, then settles", async () => {
  const f = fleet("unknown-live", STACKED);
  const child = "https://github.com/example/repo/pull/1420";
  const watch = new StackMergeWatch();
  github({});
  await poll(f, onBranch(f, child, "open"), watch);
  await poll(f, onBranch(f, child, "merged"), watch);
  assert.equal(f.registry.getTask(f.taskId)!.status, "running", "an unknown base completed the task");
  restoreGitHub?.();
  github({ [child]: { baseRefName: "main" } });
  await poll(f, onBranch(f, child, "merged"), watch);
  assert.equal(f.registry.getTask(f.taskId)!.status, "done");
});

test("by URL, a departed agent's stacked pull request merged into its parent's branch does not upgrade the task", async () => {
  const f = fleet("stray-departed", STACKED);
  const child = "https://github.com/example/repo/pull/1421";
  const gh = github({ [child]: { baseRefName: "feat/phase-1" } });
  const watch = new StackMergeWatch();
  await poll(f, onBranch(f, child, "open"), watch);
  f.registry.applyDiscovery([]);
  f.registry.emit("event", { type: "session_remove", id: f.id });
  assert.equal(f.registry.getTask(f.taskId)!.status, "failed");

  const asked: string[] = [];
  const byUrl = async (url: string) => (asked.push(url), url === child ? { state: "merged" as const, mergedAt: NOW } : null);
  await poll(f, async () => null, watch, byUrl);
  assert.ok(asked.includes(child), "the task's own pull request was polled");
  assert.equal(f.registry.getTask(f.taskId)!.status, "failed", "a stray merge upgraded the task to done");
  assert.equal(edgeSatisfied(f), false);
  // The verdict is remembered: a merged pull request's base never changes again.
  await poll(f, async () => null, watch, byUrl);
  assert.equal(gh.reads.filter((url) => url === child).length, 1);
});

// ---- retarget on the poller's merge observation ----

function adoptStackedChild(url: string, parentUrl: string, taskId: string): string {
  const number = Number(url.split("/").at(-1));
  const key = `example/repo#${number}`;
  db.adoptInspectorPr({
    key, url, owner: "example", repo: "repo", number, repoRoot: "/repo", cwd: "/repo", sessionId: null, source: "hook",
    state: "open", headSha: null, reviewPosture: null, round: 0, lastReviewedAt: null, lastError: null, failCount: 0,
    lastFailKind: null, nextAttemptAt: null, lastAttemptSha: null, mergedAt: null, mergeBlock: null,
    observedHeadSha: null, observedState: null, observedAt: null, headRefName: "feat/phase-2", title: null,
    adoptedAt: 1, updatedAt: 1,
  });
  assert.equal(db.recordInspectorPrLineage(key, { taskId, episode: "ep", adoptedAt: 1, parentPrUrl: parentUrl, baseSha: null, history: [] }), true);
  return key;
}

test("the poller's merge observation retargets the parent's open stacked children at once, and only once", async () => {
  const f = fleet("retarget");
  const parent = "https://github.com/example/repo/pull/1500";
  const child = "https://github.com/example/repo/pull/1501";
  adoptStackedChild(child, parent, "task-retarget-child");
  const gh = github({
    [parent]: { state: "MERGED", headRefName: "feat/phase-1", mergeCommitSha: "e".repeat(40) },
    [child]: { state: "OPEN", baseRefName: "feat/phase-1" },
  });
  const watch = new StackMergeWatch();
  const byUrl = async (url: string) => (url === parent ? { state: "merged" as const, mergedAt: NOW } : null);
  // Seen by URL (here through the telemetry harvest, which shares the by-URL cadence).
  await poll(f, async () => null, watch, byUrl, () => [parent]);
  assert.deepEqual(gh.retargets, [{ number: 1501, base: "main" }], "not retargeted on the poller's merge observation");
  assert.match(db.getInspectorPr("example/repo#1501")!.stack!.note ?? "", /base moved from feat\/phase-1 to main/);

  await poll(f, async () => null, watch, byUrl, () => [parent]);
  assert.equal(gh.retargets.length, 1, "retargeted again on a later poll");
});

test("a retarget GitHub refuses is left to the Inspector tick, which retries it, shows Retarget failed, then corrects it", async () => {
  const f = fleet("retarget-refused");
  const parent = "https://github.com/example/repo/pull/1510";
  const child = "https://github.com/example/repo/pull/1511";
  const key = adoptStackedChild(child, parent, "task-refused-child");
  const attempts: string[] = [];
  let refuse = true;
  github({
    [parent]: { state: "MERGED", headRefName: "feat/phase-1", mergeCommitSha: "e".repeat(40) },
    [child]: { state: "OPEN", baseRefName: "feat/phase-1" },
  }, {
    retarget: async (_cwd, _o, _r, _n, base) => {
      attempts.push(base);
      return refuse ? { ok: false, error: "HTTP 422: base is protected", outcomeUnknown: false } : { ok: true };
    },
  });
  const watch = new StackMergeWatch();
  const byUrl = async (url: string) => (url === parent ? { state: "merged" as const, mergedAt: NOW } : null);
  await poll(f, async () => null, watch, byUrl, () => [parent]);
  await poll(f, async () => null, watch, byUrl, () => [parent]);
  assert.deepEqual(attempts, ["main"], "the poller tries once and leaves the rest to the tick");
  assert.match(db.getInspectorPr(key)!.stack!.note ?? "", /could not move the base from feat\/phase-1 to main: HTTP 422/);

  // The Inspector tick's stacked-row step, as `processPr` runs it on the child's fresh snapshot.
  const tick = (at: number) => observeStackLifecycle(db.getInspectorPr(key)!, {
    state: "OPEN", headSha: "f".repeat(40), baseRefName: "feat/phase-1", defaultBranch: "main",
  }, "/repo", activeStackGitHub(), f.registry, at);
  const label = () => stackStandingFor(db.getInspectorPr(key)!, [], FOREMAN_OFF)!.label;

  // Still refused: the tick retries, and the merge queue shows GitHub's reason.
  const refused = await tick(NOW + 90_000);
  assert.deepEqual(attempts, ["main", "main"], "the tick did not retry the refused retarget");
  assert.equal(refused?.retargetError, "HTTP 422: base is protected");
  assert.equal(label(), "Retarget failed: HTTP 422: base is protected");

  // GitHub accepts on the next tick: the base moves and the failure clears.
  refuse = false;
  const moved = await tick(NOW + 180_000);
  assert.deepEqual(attempts, ["main", "main", "main"]);
  assert.equal(moved?.retargetError, null);
  assert.equal(moved?.baseRefName, "main");
  assert.doesNotMatch(label() ?? "", /Retarget failed/);
});

// ---- the recovery keeps its task, and its own merge completes it ----

/** What the Inspector tick records when it reads a child merged into its finished parent's branch. */
function strayObservation() {
  return {
    observedAt: 1, childState: "MERGED" as const, childHeadSha: "f".repeat(40), baseRefName: "feat/phase-1", defaultBranch: "main",
    parentUrl: PARENT, parentState: "MERGED" as const, parentHeadSha: "d".repeat(40), parentHeadRefName: "feat/phase-1",
    parentMergeCommitSha: "e".repeat(40), parentHeadInChild: null, baseBehindBy: null, parentTaskStopped: null,
    parentTaskId: "task-phase-1", parentEpisodeId: null, retargetError: null,
    childMergeCommitSha: "7".repeat(40), childMergedAt: 2, parentMergedAt: 1,
  };
}

test("a session that leaves a stray-merged branch for its recovery keeps its task, and the recovery's merge completes it", async () => {
  const f = fleet("recover", STACKED);
  const child = "https://github.com/example/repo/pull/1430";
  const recovery = "https://github.com/example/repo/pull/1456";
  github({ [child]: { baseRefName: "feat/phase-1" }, [recovery]: { baseRefName: "main" } });
  const watch = new StackMergeWatch();
  await poll(f, onBranch(f, child, "open"), watch);
  const key = adoptStackedChild(child, PARENT, f.taskId);
  await poll(f, onBranch(f, child, "merged"), watch);
  db.recordStackObservation(key, strayObservation(), 3);
  const stray = f.episode();
  assert.equal(stray.prUrl, child);

  // The recovery prompt asks for a new branch from origin/main.
  f.registry.applyDiscovery([{ ...f.disco, gitBranch: "feat/phase-2-recovery" }]);
  f.registry.workEpisodeForSession(f.id);
  const task = f.registry.getTask(f.taskId)!;
  assert.equal(task.status, "running", "starting the recovery cancelled the task");
  assert.equal(task.sessionId, f.id);
  const next = f.episode();
  assert.notEqual(next.episodeId, stray.episodeId);
  assert.equal(next.branch, "feat/phase-2-recovery");
  assert.equal(f.registry.workEpisodeForTask(f.taskId)?.episodeId, next.episodeId, "the task did not move with its session");

  await poll(f, onBranch(f, recovery, "open", "recovery-head"), watch);
  // The agent opened the recovery pull request and finished its turn.
  f.registry.applyHook({ agent: "claude", event: "Stop", sessionId: `${f.id}-episode`, cwd: f.cwd, transcriptPath: null, env: {} });
  assert.equal(f.registry.getTask(f.taskId)!.status, "running");
  assert.equal(edgeSatisfied(f), false);
  // Merged after the recovery episode began, as it always is outside a fixture.
  await poll(f, onBranch(f, recovery, "merged", "recovery-head", next.startedAt + 1), watch);
  const done = f.registry.getTask(f.taskId)!;
  assert.equal(done.status, "done");
  assert.equal(done.outcomeUrl, recovery, "the stray merge, not the recovery, was recorded as the outcome");
  assert.equal(edgeSatisfied(f), true, "the recovery's merge did not release the dependent");
});

test("switching branches away from an ordinary unmerged pull request still gives the task up", async () => {
  const f = fleet("takeover", STACKED);
  const pr = "https://github.com/example/repo/pull/1440";
  github({});
  await poll(f, onBranch(f, pr, "open"), new StackMergeWatch());
  f.registry.applyDiscovery([{ ...f.disco, gitBranch: "feat/something-else" }]);
  f.registry.workEpisodeForSession(f.id);
  assert.equal(f.registry.getTask(f.taskId)!.status, "cancelled");
});

test("a stray merge the poller never saw open is still the session's unfinished pull request, so its recovery keeps the task", async () => {
  // The pull request was opened and merged into its parent's branch between two polls (or
  // while the daemon was down): the first sighting is already merged.
  const f = fleet("first-sighting", STACKED);
  const child = "https://github.com/example/repo/pull/1450";
  github({ [child]: { baseRefName: "feat/phase-1" } });
  const watch = new StackMergeWatch();
  assert.equal(f.registry.getSession(f.id)?.prUrl ?? null, null, "the fixture already had the pull request");
  await poll(f, onBranch(f, child, "merged"), watch);

  // Carried on the card and the episode, unmerged: nothing completed.
  const session = f.registry.getSession(f.id)!;
  assert.equal(session.prUrl, child);
  assert.equal(session.prState, "open");
  assert.equal(f.episode().prUrl, child);
  assert.equal(f.episode().mergedAt, null);
  assert.equal(f.registry.getTask(f.taskId)!.status, "running");
  assert.equal(edgeSatisfied(f), false);

  // With the stray merge observed, leaving the branch for the recovery keeps the task.
  const key = adoptStackedChild(child, PARENT, f.taskId);
  db.recordStackObservation(key, strayObservation(), 3);
  f.registry.applyDiscovery([{ ...f.disco, gitBranch: "feat/phase-2-recovery" }]);
  f.registry.workEpisodeForSession(f.id);
  assert.equal(f.registry.getTask(f.taskId)!.status, "running", "starting the recovery cancelled the task");
  assert.equal(f.registry.workEpisodeForTask(f.taskId)?.branch, "feat/phase-2-recovery");
});

test("a stacked merge GitHub cannot place yet leaves a session's card exactly as it was", async () => {
  const f = fleet("unplaced-first", STACKED);
  const child = "https://github.com/example/repo/pull/1451";
  github({});
  await poll(f, onBranch(f, child, "merged"), new StackMergeWatch());
  assert.equal(f.registry.getSession(f.id)?.prUrl ?? null, null);
  assert.equal(f.episode().prUrl, null);
  assert.equal(f.registry.getTask(f.taskId)!.status, "running");
});

// ---- the gate on a completed task's merge evidence ----

/**
 * A task completed by hand whose session is gone, with a dependent bound to its episode and no
 * pull request recorded yet: the poller's completed-dependency branch search is the only thing
 * that can still find its merge and release the dependent.
 */
async function completedPrerequisite(id: string) {
  const f = fleet(id, STACKED);
  const episode = f.episode();
  f.registry.upsertTask(baseTask({ id: `bound-dependent-of-${id}`, title: "Phase 3", status: "backlog", dependencies: [{
    type: "task", taskId: f.taskId, title: "Phase 2", sessionId: f.id, episodeId: episode.episodeId,
    agentSessionId: episode.agentSessionId, branch: "feat/phase-2", prUrl: null, selectedAt: 1, satisfiedAt: null,
  }] }));
  await f.tasks.complete(f.taskId, "completed");
  f.registry.applyDiscovery([]);
  f.registry.emit("event", { type: "session_remove", id: f.id });
  const edge = () => f.registry.getTask(`bound-dependent-of-${id}`)!.dependencies[0]!;
  return { f, episode, edge };
}

for (const [base, released] of [["feat/phase-1", false], ["main", true]] as const) {
  test(`a completed task's stacked pull request merged into ${base} ${released ? "releases" : "does not release"} its dependent`, async () => {
    const { f, episode, edge } = await completedPrerequisite(`completed-${released ? "landed" : "stray"}`);
    const url = `https://github.com/example/repo/pull/${released ? 1471 : 1470}`;
    const gh = github({ [url]: { baseRefName: base } });
    const asked: string[] = [];
    await pollAndReconcilePrs(f.registry, async (cwd, branch, search) => {
      asked.push(`${cwd} ${branch} ${search ? "episode" : "live"}`);
      return { url, number: Number(url.split("/").at(-1)), state: "merged", checks: "passing", createdAt: episode.startedAt,
        mergedAt: Date.now(), headSha: "merged-head", worktreeHeadSha: null };
    }, async () => null, undefined, NOW, async () => null, () => [], new StackMergeWatch());
    // Only the completed-dependency branch search runs: there is no live session and no URL yet.
    assert.ok(asked.length > 0 && asked.every((call) => call === "/repo feat/phase-2 episode"), `unexpected lookups: ${asked.join(", ")}`);
    assert.ok(gh.reads.includes(url), "the gate did not read where the merge landed");
    const after = edge();
    assert.equal(after.type === "task" && after.satisfiedAt !== null, released);
    if (!released) {
      assert.equal(after.type === "task" ? after.prUrl : "?", null, "a stray merge was recorded as the task's pull request");
      assert.equal(f.registry.workEpisodeForTask(f.taskId)?.mergedAt ?? null, null);
    }
  });
}

// ---- the default branch is GitHub's, not `main` ----

test("in a repository whose default branch is develop, a merge into develop completes and one into main is held", async () => {
  const intoDevelop = fleet("default-develop", STACKED);
  const landed = "https://github.com/example/repo/pull/1480";
  github({ [landed]: { baseRefName: "develop", defaultBranch: "develop" } });
  const watch = new StackMergeWatch();
  await poll(intoDevelop, onBranch(intoDevelop, landed, "open"), watch);
  await poll(intoDevelop, onBranch(intoDevelop, landed, "merged"), watch);
  assert.equal(intoDevelop.registry.getTask(intoDevelop.taskId)!.status, "done");
  assert.equal(edgeSatisfied(intoDevelop), true);
  restoreGitHub?.();

  const intoMain = fleet("default-develop-main", STACKED);
  const stray = "https://github.com/example/repo/pull/1481";
  github({ [stray]: { baseRefName: "main", defaultBranch: "develop" } });
  await poll(intoMain, onBranch(intoMain, stray, "open"), watch);
  await poll(intoMain, onBranch(intoMain, stray, "merged"), watch);
  assert.equal(intoMain.registry.getTask(intoMain.taskId)!.status, "running", "a merge into main completed a develop-default task");
  assert.equal(intoMain.episode().mergedAt, null);
  assert.equal(edgeSatisfied(intoMain), false);
});

// ---- every child of the merged parent, and no other ----

test("the poller retargets every open child of the merged parent, and leaves another parent's child alone", async () => {
  const f = fleet("retarget-many");
  const parent = "https://github.com/example/repo/pull/1600";
  const other = "https://github.com/example/repo/pull/1610";
  adoptStackedChild("https://github.com/example/repo/pull/1601", parent, "task-many-a");
  adoptStackedChild("https://github.com/example/repo/pull/1602", parent, "task-many-b");
  adoptStackedChild("https://github.com/example/repo/pull/1611", other, "task-many-c");
  const gh = github({
    [parent]: { state: "MERGED", headRefName: "feat/phase-1", mergeCommitSha: "e".repeat(40) },
    [other]: { state: "OPEN", headRefName: "feat/other" },
    "https://github.com/example/repo/pull/1601": { state: "OPEN", baseRefName: "feat/phase-1" },
    "https://github.com/example/repo/pull/1602": { state: "OPEN", baseRefName: "feat/phase-1" },
    "https://github.com/example/repo/pull/1611": { state: "OPEN", baseRefName: "feat/other" },
  });
  const byUrl = async (url: string) => (url === parent ? { state: "merged" as const, mergedAt: NOW } : url === other ? { state: "open" as const, mergedAt: null } : null);
  await poll(f, async () => null, new StackMergeWatch(), byUrl, () => [parent, other]);
  assert.deepEqual([...gh.retargets].sort((a, b) => a.number - b.number), [{ number: 1601, base: "main" }, { number: 1602, base: "main" }]);
  assert.ok(!gh.reads.includes("https://github.com/example/repo/pull/1611"), "an unrelated child was read for a retarget");
});
