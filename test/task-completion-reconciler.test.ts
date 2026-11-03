import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkSession, mkTask as baseTask } from "./helpers/session-fixture.ts";
import { withProcessEnv } from "./helpers/process-env.ts";
import { agentIsFree } from "../src/server/foreman/backlog-machine.ts";
import type { BacklogConfig } from "../src/server/foreman/backlog-machine.ts";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";

const home = mkdtempSync(join(tmpdir(), "mission-task-completion-reconciler-"));
process.env.HARNESS_HOME = home;
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("./helpers/task-manager-fixture.ts");
const { pollAndReconcilePrs } = await import("../src/server/pr.ts");
const { setShippingConfig } = await import("../src/server/shipping/config.ts");
const { openDb, replaceSessionWorkEpisode, historicalTaskWorkEpisodeBindingsForTask, taskWorkEpisodeForTask } = await import("../src/server/db.ts");

const managers: InstanceType<typeof TaskManager>[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) {
    manager.stopMissionSessionClosures();
    await manager.settleWorktreeReturns();
  }
});
after(() => rmSync(home, { recursive: true, force: true }));

/**
 * What is at stake: a task whose pull request MERGED, sitting in a state that says it did
 * not.
 *
 * Both existing completion paths need a session. `settleIfEpisodeFinished` needs an agent
 * that is here and idle on the episode that merged; `agentWentAway` needs to catch the
 * exact moment one is evicted. Between them they miss the rows an operator actually finds
 * on a Monday: an agent killed while the daemon was down, a pull request someone merged
 * days after everyone stopped looking, a task cancelled in a hurry whose branch landed
 * anyway. Each of those is a `stopped` blocker holding up every dependent task for work
 * that has already shipped, and an agent that occupies a fleet slot it is ineligible to use.
 *
 * These pin the reconciler that closes them: what it completes (merged evidence, on any
 * episode, whatever the current status), what it refuses to touch (`done`, `backlog`, a
 * closed-unmerged pull request, a task whose agent is still here and may be mid-turn), and
 * that a standalone task's pull request is polled by URL at all - which is the only reason
 * the merge is ever observed once its session is gone.
 */

const CFG: BacklogConfig = {
  enabled: true,
  maxSessions: 3,
  allowlist: ["/repo"],
  mayActLive: true,
  settleMs: 10_000,
  respectOpenPrs: true,
  planExhausted: false,
};
const NOW = 5_000_000;

function discovered(id: string, cwd: string, over: Partial<DiscoveredSession> = {}): DiscoveredSession {
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
    ...over,
  };
}

/** A historical binding written straight to the store - the shape a rollover leaves behind. */
function insertHistorical(b: {
  taskId: string;
  episodeId: string;
  sessionId: string;
  prUrl: string;
  mergedAt: number | null;
}): void {
  openDb()
    .prepare(
      `INSERT INTO historical_task_work_episode_bindings
         (task_id, episode_id, session_id, agent_session_id, branch, pr_url, pr_head_sha,
          merged_at, bound_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(b.taskId, b.episodeId, b.sessionId, b.sessionId, "feat/work", b.prUrl, "sha", b.mergedAt, 1, 1);
}

/**
 * A fleet whose agent is already gone: the task row survives, the session does not.
 *
 * Built by discovering the session, binding the task to its work episode and then letting
 * it be evicted, so the binding in the store is the one a real dispatch leaves behind
 * rather than a hand-written row.
 */
function departed(id: string, over: Partial<ReturnType<typeof baseTask>> = {}) {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  managers.push(tasks);
  const taskId = `task-${id}`;
  const cwd = `/repo/${id}`;
  registry.applyDiscovery([discovered(id, cwd)]);
  registry.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: `${id}-episode`,
    cwd,
    transcriptPath: null,
    env: {},
  });
  registry.upsertTask(baseTask({
    id: taskId,
    title: "Ship the thing",
    status: "running",
    sessionId: id,
    worktreePath: cwd,
    homeName: "Ship the thing",
    repoRoot: "/repo",
    ...over,
  }));
  registry.bindTaskToWorkEpisode(taskId, id);
  const episode = registry.workEpisodeForSession(id)!;
  return { registry, tasks, id, taskId, cwd, episode };
}

/** One poll pass in which `url` reports merged, and nothing is asked about any branch. */
async function pollMerged(
  registry: InstanceType<typeof Registry>,
  url: string,
  mergedAt = NOW,
): Promise<string[]> {
  const asked: string[] = [];
  await pollAndReconcilePrs(
    registry,
    async () => null,
    async (candidate) => {
      asked.push(candidate);
      return candidate === url ? { state: "merged" as const, mergedAt } : null;
    },
  );
  return asked;
}

/** The open PR `gh` reports for a live session's branch, matched to its current episode. */
function openPr(f: ReturnType<typeof departed>, url: string): void {
  f.registry.reconcilePrs(
    new Map([[f.id, {
      url,
      number: 1,
      state: "open" as const,
      checks: "passing" as const,
      branch: "feat/work",
      agentSessionId: `${f.id}-episode`,
      episodeId: f.episode.episodeId,
      createdAt: f.episode.startedAt,
      mergedAt: null,
      headSha: "head",
      worktreeHeadSha: "head",
    }]]),
    new Set(),
  );
}

// ---- the row nothing was ever going to move -----------------------------------------------

test("an agent killed with its pull request open lands on the merge that follows", async () => {
  // The ordinary shape of this, end to end and with no hand-written rows: the agent opens a
  // pull request, someone kills the session (or the daemon was down when it exited), and the
  // pull request is merged afterwards. The branch poller stopped answering for it the moment
  // the session went - so the merge is only ever seen because the task's OWN pull request is
  // still being polled by url.
  setShippingConfig({ closeSessionAfterMerge: false });
  const url = "https://github.com/example/repo/pull/400";
  const f = departed("open-then-killed");
  openPr(f, url);
  assert.ok(f.registry.taskPrPollTargets().includes(url), "watched while it is still open");

  f.registry.applyDiscovery([]);
  f.registry.emit("event", { type: "session_remove", id: f.id });
  assert.equal(f.registry.getTask(f.taskId)?.status, "failed", "no outcome recorded yet");

  await pollMerged(f.registry, url);

  const t = f.registry.getTask(f.taskId)!;
  assert.equal(t.status, "done");
  assert.equal(t.outcomeUrl, url);
});

test("a killed agent's task lands on a merge observed long after it went away", async () => {
  // The headline case. The agent is gone, so no session event will ever fire again, and the
  // merge happened on an episode this task had already rolled past - invisible to both
  // session-shaped paths. The by-URL poller is what sees it, and the reconciler is what
  // decides the task is over.
  setShippingConfig({ closeSessionAfterMerge: false });
  const url = "https://github.com/example/repo/pull/401";
  const f = departed("gone-merged");
  insertHistorical({
    taskId: f.taskId,
    episodeId: "rolled-past-episode",
    sessionId: f.id,
    prUrl: url,
    mergedAt: null,
  });
  f.registry.applyDiscovery([]);
  f.registry.emit("event", { type: "session_remove", id: f.id });
  assert.equal(f.registry.getTask(f.taskId)?.status, "failed", "no merge recorded yet");

  const asked = await pollMerged(f.registry, url);

  assert.ok(asked.includes(url), "the failed task's open pull request is still watched");
  const t = f.registry.getTask(f.taskId)!;
  assert.equal(t.status, "done");
  assert.equal(t.outcomeUrl, url);
  assert.match(t.outcome ?? "", /merged/);
  assert.equal(t.error, null, "the failure was about the absence of an outcome; there is one now");
  // Settled, not torn down: `git worktree remove --force` stays behind the operator's
  // confirmed Clean up, exactly as `agentWentAway` and `complete` both leave it.
  assert.equal(t.worktreePath, f.cwd);
  assert.equal(t.homeName, "Ship the thing");
});

test("a cancelled task whose branch landed anyway is upgraded, with the pull request as its outcome", async () => {
  // The adopted decision: only a MERGE upgrades a terminal row, and when one lands the
  // task's status is the last thing still claiming otherwise.
  setShippingConfig({ closeSessionAfterMerge: false });
  const url = "https://github.com/example/repo/pull/402";
  const f = departed("cancelled-merged");
  insertHistorical({
    taskId: f.taskId,
    episodeId: "cancelled-episode",
    sessionId: f.id,
    prUrl: url,
    mergedAt: null,
  });
  const cur = f.registry.getTask(f.taskId)!;
  f.registry.upsertTask({ ...cur, status: "cancelled", sessionId: null });

  await pollMerged(f.registry, url);

  const t = f.registry.getTask(f.taskId)!;
  assert.equal(t.status, "done");
  assert.equal(t.outcomeUrl, url);
  assert.equal(t.worktreePath, f.cwd, "an upgrade records an outcome; it reclaims nothing");
});

test("a closed-unmerged pull request changes nothing", async () => {
  // The other half of the upgrade rule, and the reason it is stated as "merged" rather than
  // "resolved": a pull request someone closed is the strongest possible evidence the work
  // did NOT land, so the cancellation stands.
  setShippingConfig({ closeSessionAfterMerge: false });
  const url = "https://github.com/example/repo/pull/403";
  const f = departed("cancelled-closed");
  insertHistorical({
    taskId: f.taskId,
    episodeId: "closed-episode",
    sessionId: f.id,
    prUrl: url,
    mergedAt: null,
  });
  const cur = f.registry.getTask(f.taskId)!;
  f.registry.upsertTask({ ...cur, status: "cancelled", sessionId: null });

  // `queryPrUrl` maps a CLOSED (unmerged) pull request to null - "provably no open or
  // merged PR" - which is what this returns for every url.
  const asked: string[] = [];
  await pollAndReconcilePrs(f.registry, async () => null, async (candidate) => {
    asked.push(candidate);
    return null;
  });

  assert.ok(asked.includes(url), "it is still watched - a closed PR can be reopened and merged");
  assert.equal(f.registry.getTask(f.taskId)?.status, "cancelled");
});

test("a task failed for no outcome is upgraded when its pull request finally merges", async () => {
  setShippingConfig({ closeSessionAfterMerge: false });
  const url = "https://github.com/example/repo/pull/404";
  const f = departed("failed-merged");
  insertHistorical({
    taskId: f.taskId,
    episodeId: "failed-episode",
    sessionId: f.id,
    prUrl: url,
    mergedAt: null,
  });
  const cur = f.registry.getTask(f.taskId)!;
  f.registry.upsertTask({
    ...cur,
    status: "failed",
    sessionId: null,
    error: "the agent's session ended with no outcome recorded",
  });

  await pollMerged(f.registry, url);

  const t = f.registry.getTask(f.taskId)!;
  assert.equal(t.status, "done");
  assert.equal(t.error, null);
  assert.equal(t.outcomeUrl, url);
});

// ---- what it must not touch ----------------------------------------------------------------

test("an outcome an operator recorded is never rewritten", async () => {
  setShippingConfig({ closeSessionAfterMerge: false });
  const url = "https://github.com/example/repo/pull/405";
  const f = departed("done-by-hand");
  insertHistorical({
    taskId: f.taskId,
    episodeId: "hand-episode",
    sessionId: f.id,
    prUrl: url,
    mergedAt: NOW - 1,
  });
  await f.tasks.complete(f.taskId, "done by hand");

  f.tasks.reconcileMergedTasks();

  const t = f.registry.getTask(f.taskId)!;
  assert.equal(t.outcome, "done by hand");
  assert.equal(t.outcomeUrl, null);
});

test("a task whose agent is still here is left to the narrower path", () => {
  // The asymmetry `settleIfEpisodeFinished` documents, restated here because this reconciler
  // is the one thing that could quietly erase it. An agent that lands an intermediate pull
  // request and is handed more work is still mid-task; only its own idleness on the episode
  // that merged may conclude it, and that conclusion stays reversible. Here the merge sits
  // on a rolled-past episode and the agent is working, so nothing concludes.
  setShippingConfig({ closeSessionAfterMerge: false });
  const url = "https://github.com/example/repo/pull/406";
  const f = departed("agent-present");
  insertHistorical({
    taskId: f.taskId,
    episodeId: "earlier-episode",
    sessionId: f.id,
    prUrl: url,
    mergedAt: NOW - 1,
  });

  f.tasks.reconcileMergedTasks();

  assert.equal(f.registry.getTask(f.taskId)?.status, "running");
  // And the moment the agent goes, the same evidence lands it.
  f.registry.applyDiscovery([]);
  f.registry.emit("event", { type: "session_remove", id: f.id });
  assert.equal(f.registry.getTask(f.taskId)?.status, "done");
});

test("a live task is not completed from a partial startup session map", () => {
  setShippingConfig({ closeSessionAfterMerge: false });
  const presentRegistry = new Registry();
  const presentTasks = new TaskManager(presentRegistry);
  managers.push(presentTasks);
  const presentId = "startup-live";
  const presentTaskId = "task-startup-live";
  presentRegistry.upsertTask(baseTask({
    id: presentTaskId,
    title: "Live through startup",
    status: "running",
    sessionId: presentId,
    repoRoot: "/repo",
  }));
  insertHistorical({
    taskId: presentTaskId,
    episodeId: "startup-live-episode",
    sessionId: presentId,
    prUrl: "https://github.com/example/repo/pull/411",
    mergedAt: NOW - 1,
  });

  presentTasks.reconcileMergedTasks();
  assert.equal(presentRegistry.getTask(presentTaskId)?.status, "running");

  presentRegistry.applyDiscovery([discovered(presentId, "/repo/startup-live")]);
  assert.equal(presentRegistry.getTask(presentTaskId)?.status, "running");

  const absentRegistry = new Registry();
  const absentTasks = new TaskManager(absentRegistry);
  managers.push(absentTasks);
  const absentTaskId = "task-startup-absent";
  absentRegistry.upsertTask(baseTask({
    id: absentTaskId,
    title: "Gone before startup",
    status: "running",
    sessionId: "startup-absent",
    repoRoot: "/repo",
  }));
  insertHistorical({
    taskId: absentTaskId,
    episodeId: "startup-absent-episode",
    sessionId: "startup-absent",
    prUrl: "https://github.com/example/repo/pull/412",
    mergedAt: NOW - 1,
  });

  absentTasks.reconcileMergedTasks();
  assert.equal(absentRegistry.getTask(absentTaskId)?.status, "running");

  absentRegistry.applyDiscovery([]);
  assert.equal(absentRegistry.getTask(absentTaskId)?.status, "done");
});

test("an upgraded task is not reopened by its agent working again", () => {
  // `reopenIfWorkResumed` reverses an inference drawn from IDLENESS. This completion is
  // drawn from a merged pull request, so it is not the kind of conclusion an agent can
  // contradict by typing - and registering it as reversible would resurrect a task whose
  // work has landed in main.
  setShippingConfig({ closeSessionAfterMerge: false });
  const url = "https://github.com/example/repo/pull/407";
  const f = departed("no-reopen");
  insertHistorical({
    taskId: f.taskId,
    episodeId: "reopen-episode",
    sessionId: f.id,
    prUrl: url,
    mergedAt: NOW - 1,
  });
  const cur = f.registry.getTask(f.taskId)!;
  f.registry.upsertTask({ ...cur, status: "failed" });
  f.tasks.reconcileMergedTasks();
  assert.equal(f.registry.getTask(f.taskId)?.status, "done");

  f.registry.applyHook({
    agent: "claude",
    event: "UserPromptSubmit",
    sessionId: `${f.id}-episode`,
    cwd: f.cwd,
    transcriptPath: null,
    env: {},
    prompt: "actually, one more thing",
  });

  assert.equal(f.registry.getTask(f.taskId)?.status, "done", "evidence, not an inference");
});

// ---- the harvest -----------------------------------------------------------------------------

test("a merge already recorded is never asked about again", async () => {
  // `merged_at` is stamped once and the row is dropped from the harvest, so a landed pull
  // request costs exactly one `gh` call in total however long its task row lives.
  setShippingConfig({ closeSessionAfterMerge: false });
  const url = "https://github.com/example/repo/pull/408";
  const f = departed("harvest-merged");
  insertHistorical({
    taskId: f.taskId,
    episodeId: "already-merged-episode",
    sessionId: f.id,
    prUrl: url,
    mergedAt: NOW - 1,
  });
  const cur = f.registry.getTask(f.taskId)!;
  f.registry.upsertTask({ ...cur, status: "cancelled", sessionId: null });

  assert.ok(!f.registry.taskPrPollTargets().includes(url));
  const asked = await pollMerged(f.registry, url);
  assert.ok(!asked.includes(url), "nothing left to ask about it");
  // ...and the record alone still completes it.
  assert.equal(f.registry.getTask(f.taskId)?.status, "done");
});

test("a done or backlog task's pull request is not polled", () => {
  setShippingConfig({ closeSessionAfterMerge: false });
  const url = "https://github.com/example/repo/pull/409";
  const f = departed("harvest-terminal");
  insertHistorical({
    taskId: f.taskId,
    episodeId: "terminal-episode",
    sessionId: f.id,
    prUrl: url,
    mergedAt: null,
  });
  assert.ok(f.registry.taskPrPollTargets().includes(url), "running: still in question");

  const cur = f.registry.getTask(f.taskId)!;
  f.registry.upsertTask({ ...cur, status: "done" });
  assert.ok(!f.registry.taskPrPollTargets().includes(url), "its outcome is already recorded");

  // A rescheduled task is being RE-RUN, so the previous attempt's pull request is not this
  // run's outcome and nothing is waiting on it.
  f.registry.upsertTask({ ...f.registry.getTask(f.taskId)!, status: "backlog" });
  assert.ok(!f.registry.taskPrPollTargets().includes(url));
});

/** Push `taskId` past the recent-terminal cap with newer, fully-cleaned terminal rows. */
function buryPastTerminalCap(registry: InstanceType<typeof Registry>, tag: string): void {
  for (let i = 0; i < 51; i += 1) {
    registry.upsertTask(baseTask({
      id: `${tag}-filler-${i}`,
      title: `Filler ${i}`,
      status: "done",
      outcome: "done",
      updatedAt: 9_000_000 + i,
      completedAt: 9_000_000 + i,
    }));
  }
}

test("a reclaimed task still waiting on its pull request survives a restart past the cap", () => {
  // The in-memory task map is bounded, and a `failed` row whose worktree the operator
  // already cleaned up holds no resources to keep it loaded. Past the fifty most recent
  // terminal tasks it would not be rebuilt at all - so nothing would poll the pull request
  // it left open, the merge would never be observed, and it would stay a `stopped` blocker
  // for ever. An unresolved OUTCOME keeps a row exactly as an unreclaimed RESOURCE does.
  setShippingConfig({ closeSessionAfterMerge: false });
  const url = "https://github.com/example/repo/pull/411";
  const f = departed("restart-past-cap");
  insertHistorical({
    taskId: f.taskId,
    episodeId: "buried-episode",
    sessionId: f.id,
    prUrl: url,
    mergedAt: null,
  });
  const cur = f.registry.getTask(f.taskId)!;
  f.registry.upsertTask({
    ...cur,
    status: "failed",
    sessionId: null,
    worktreePath: null,
    homeName: null,
    updatedAt: 1,
  });
  buryPastTerminalCap(f.registry, "restart");

  // In memory: not evicted, because its pull request has not been resolved yet.
  assert.ok(f.registry.getTask(f.taskId), "kept while its outcome is still open");
  // And after a restart: rebuilt from the store rather than dropped with the old history.
  const restarted = new Registry();
  assert.ok(
    restarted.listTasks().some((t) => t.id === f.taskId),
    "loaded regardless of the recent-terminal cap",
  );
  assert.ok(restarted.taskPrPollTargets().includes(url), "and still polled");
});

test("a terminal task whose pull request is settled is evicted as before", () => {
  // The other side of it: once the merge is recorded there is nothing left for that URL to
  // decide, so the row goes back to being ordinary history and the cap governs it again.
  setShippingConfig({ closeSessionAfterMerge: false });
  const f = departed("evictable-again");
  const cur = f.registry.getTask(f.taskId)!;
  f.registry.upsertTask({
    ...cur,
    status: "failed",
    sessionId: null,
    worktreePath: null,
    homeName: null,
    updatedAt: 1,
  });
  buryPastTerminalCap(f.registry, "evictable");

  assert.equal(f.registry.getTask(f.taskId), undefined, "no pull request, no reason to keep it");
});

// ---- what the completion releases -------------------------------------------------------------

test("a dependent unblocks, and the agent stops being refused its next task", async () => {
  // The two things a stuck row costs, and the reason this is worth a poller at all. The
  // dependent is blocked by a `stopped` prerequisite; `agentIsFree` refuses any session a
  // `running` row names. Both clear on the same completion - and the dependent's edge is
  // stamped rather than inferred from the prerequisite's status, because terminal rows are
  // eventually pruned and a completion readable only from the target's row stops being
  // readable with it.
  setShippingConfig({ closeSessionAfterMerge: false });
  const url = "https://github.com/example/repo/pull/410";
  const f = departed("dependent-unblocks");
  insertHistorical({
    taskId: f.taskId,
    episodeId: "dependency-episode",
    sessionId: f.id,
    prUrl: url,
    mergedAt: null,
  });
  f.registry.upsertTask(baseTask({
    id: "waiting-task",
    title: "The follow-up",
    status: "backlog",
    repoRoot: "/repo",
    dependencies: [{
      type: "task",
      taskId: f.taskId,
      title: "Ship the thing",
      sessionId: null,
      episodeId: null,
      agentSessionId: null,
      branch: null,
      prUrl: null,
      selectedAt: 1,
      satisfiedAt: null,
    }],
  }));
  // While the row says it is executing, the autopilot will not hand that agent anything
  // else - so an agent whose work has shipped occupies a fleet slot it is ineligible to use.
  const agent = mkSession({
    id: f.id,
    state: "idle",
    cwd: "/repo",
    repoRoot: "/repo",
    lastActivity: NOW - 60_000,
  });
  assert.equal(agentIsFree(agent, [agent], f.registry.listTasks(), CFG, NOW), false);

  f.registry.applyDiscovery([]);
  f.registry.emit("event", { type: "session_remove", id: f.id });
  const blocked = f.registry.getTask("waiting-task")!;
  // Settling as `failed` frees the agent but strands the dependent behind a `stopped`
  // blocker - which is the half of this that only a recorded merge can fix.
  assert.equal(f.tasks.dependencyBlockers(blocked)[0]?.state, "stopped");

  await pollMerged(f.registry, url);

  assert.equal(f.registry.getTask(f.taskId)?.status, "done");
  const unblocked = f.registry.getTask("waiting-task")!;
  assert.notEqual(unblocked.dependencies[0]?.satisfiedAt, null, "stamped on the edge");
  assert.deepEqual(f.tasks.dependencyBlockers(unblocked), []);
  assert.equal(agentIsFree(agent, [agent], f.registry.listTasks(), CFG, NOW), true);
});

test("manual completion without the override heals stale edges from a later durable merge", async () => {
  const f = departed("manual-late-merge", { worktreePath: null, homeName: null });
  const url = "https://github.com/example/repo/pull/1303";
  f.registry.upsertTask(baseTask({ id: "manual-dependent", dependencies: [{
    type: "task", taskId: f.taskId, title: "Prerequisite", sessionId: f.id,
    episodeId: "stale-episode", agentSessionId: f.id, branch: "feat/work",
    prUrl: null, selectedAt: 1, satisfiedAt: null,
  }] }));
  await f.tasks.complete(f.taskId, "completed");
  const completed = f.registry.getTask(f.taskId)!;
  assert.equal(f.registry.getTask("manual-dependent")!.dependencies[0]!.satisfiedAt, null);
  insertHistorical({ taskId: f.taskId, sessionId: f.id, episodeId: "late-merge", prUrl: url, mergedAt: null });
  await pollMerged(f.registry, url);
  const healed = f.registry.getTask("manual-dependent")!;
  assert.notEqual(healed.dependencies[0]!.satisfiedAt, null);
  assert.equal(healed.dependencies[0]!.prUrl, url);
  assert.deepEqual(f.tasks.dependencyBlockers(healed), []);
  assert.deepEqual(f.registry.getTask(f.taskId), completed, "never re-complete or rewrite the operator's outcome");
  f.tasks.reconcileMergedTasks();
  assert.equal(f.registry.getTask("manual-dependent"), healed, "second sweep is a no-op");
});

test("a completed prerequisite discovers its PR after session loss without a cached URL", async () => {
  const f = departed("manual-branch-merge", { worktreePath: null, homeName: null });
  f.registry.upsertTask(baseTask({ id: "branch-dependent", dependencies: [{
    type: "task", taskId: f.taskId, title: "Prerequisite", sessionId: f.id,
    episodeId: f.episode.episodeId, agentSessionId: f.episode.agentSessionId, branch: "feat/work",
    prUrl: null, selectedAt: 1, satisfiedAt: null,
  }] }));
  await f.tasks.complete(f.taskId, "completed");
  f.registry.applyDiscovery([]);
  f.registry.emit("event", { type: "session_remove", id: f.id });
  const url = "https://github.com/example/repo/pull/1304";
  await pollAndReconcilePrs(f.registry, async (cwd, branch) => {
    assert.equal(cwd, "/repo", "use the repository even after its worktree is returned");
    assert.equal(branch, "feat/work");
    return { url, number: 1304, state: "merged", checks: "passing", createdAt: f.episode.startedAt,
      mergedAt: Date.now(), headSha: "merged-head", worktreeHeadSha: null };
  }, async () => null);
  const edge = f.registry.getTask("branch-dependent")!.dependencies[0]!;
  assert.equal(edge.prUrl, url);
  assert.notEqual(edge.satisfiedAt, null);
});

for (const state of ["open", "closed", "error", "old", "reset"] as const) {
  test(`completed dependency branch recovery refuses ${state} evidence`, async () => {
    const f = departed(`manual-refuse-${state}`, { worktreePath: null, homeName: null });
    f.registry.upsertTask(baseTask({ id: `refused-${state}`, dependencies: [{
      type: "task", taskId: f.taskId, title: "Prerequisite", sessionId: f.id,
      episodeId: f.episode.episodeId, agentSessionId: f.episode.agentSessionId, branch: "feat/work",
      prUrl: null, selectedAt: 1, satisfiedAt: null,
    }] }));
    await f.tasks.complete(f.taskId, "completed");
    f.registry.applyDiscovery([]);
    await pollAndReconcilePrs(f.registry, async () => {
      if (state === "error") return "error";
      if (state === "reset") {
        const t = f.registry.getTask(f.taskId)!;
        f.registry.upsertTask({ ...t, status: "backlog" });
      }
      return { url: `https://github.com/example/repo/pull/refuse-${state}`, number: 1,
        state: state === "open" || state === "closed" ? state : "merged", checks: null,
        createdAt: state === "old" ? f.episode.startedAt - 1 : f.episode.startedAt,
        mergedAt: Date.now(), headSha: "head", worktreeHeadSha: null };
    }, async () => null);
    assert.equal(f.registry.getTask(`refused-${state}`)!.dependencies[0]!.satisfiedAt, null);
  });
}

test("saving an existing edge repairs it from durable merge proof without a live session", async () => {
  const f = departed("manual-save-heals", { worktreePath: null, homeName: null });
  f.registry.upsertTask(baseTask({ id: "save-heals", dependencies: [{
    type: "task", taskId: f.taskId, title: "Prerequisite", sessionId: null,
    episodeId: null, agentSessionId: null, branch: null, prUrl: null, selectedAt: 1, satisfiedAt: null,
  }] }));
  await f.tasks.complete(f.taskId, "completed");
  f.registry.applyDiscovery([]);
  const url = "https://github.com/example/repo/pull/1305";
  insertHistorical({ taskId: f.taskId, sessionId: f.id, episodeId: "save-merged", prUrl: url, mergedAt: NOW });
  await f.tasks.update("save-heals", { dependencies: [{ type: "task", taskId: f.taskId }] });
  const edge = f.registry.getTask("save-heals")!.dependencies[0]!;
  assert.equal(edge.prUrl, url);
  assert.notEqual(edge.satisfiedAt, null);
  insertHistorical({ taskId: f.taskId, sessionId: f.id, episodeId: "newer-merged", prUrl: `${url}0`, mergedAt: NOW + 1 });
  await f.tasks.update("save-heals", { dependencies: [{ type: "task", taskId: f.taskId }] });
  assert.deepEqual(f.registry.getTask("save-heals")!.dependencies[0], edge, "saving never rewrites satisfied evidence");
});

test("completed source recovery survives pruning and restart and persists its repaired edge", async () => {
  const f = departed("manual-pruned", { worktreePath: null, homeName: null });
  const url = "https://github.com/example/repo/pull/1306";
  f.registry.upsertTask(baseTask({ id: "pruned-dependent", dependencies: [{
    type: "task", taskId: f.taskId, title: "Prerequisite", sessionId: f.id,
    episodeId: "stale", agentSessionId: f.id, branch: "feat/work", prUrl: null, selectedAt: 1, satisfiedAt: null,
  }] }));
  await f.tasks.complete(f.taskId, "completed");
  insertHistorical({ taskId: f.taskId, sessionId: f.id, episodeId: "pruned-merged", prUrl: url, mergedAt: null });
  f.registry.upsertTask({ ...f.registry.getTask(f.taskId)!, updatedAt: 1 });
  buryPastTerminalCap(f.registry, "manual-done");
  const restarted = new Registry();
  assert.equal(restarted.getTask(f.taskId), undefined);
  const tasks = new TaskManager(restarted);
  managers.push(tasks);
  await pollMerged(restarted, url);
  const healed = restarted.getTask("pruned-dependent")!.dependencies[0]!;
  assert.equal(healed.prUrl, url);
  assert.notEqual(healed.satisfiedAt, null);
  assert.deepEqual(new Registry().getTask("pruned-dependent")!.dependencies[0], healed);
});

test("completion with an already verified merge satisfies dependents when the override is omitted", async () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  managers.push(tasks);
  const taskId = "already-merged-source";
  const dependentId = "already-merged-dependent";
  const url = "https://github.com/example/repo/pull/1307";
  // No bound session can emit session_upsert and trigger the recovery sweep during
  // completion. This pins finishCompletion's own writeback, independently of recovery.
  registry.upsertTask(baseTask({ id: taskId, status: "running", sessionId: null }));
  registry.upsertTask(baseTask({ id: dependentId, dependencies: [{
    type: "task", taskId, title: "Already shipped prerequisite", sessionId: null,
    episodeId: null, agentSessionId: null, branch: null, prUrl: null,
    selectedAt: 1, satisfiedAt: null,
  }] }));
  insertHistorical({ taskId, sessionId: "departed-already-merged", episodeId: "already-merged-episode", prUrl: url, mergedAt: NOW });
  assert.equal(registry.getTask(dependentId)!.dependencies[0]!.satisfiedAt, null);

  await tasks.complete(taskId, "completed");

  const dependent = registry.getTask(dependentId)!;
  assert.equal(typeof dependent.dependencies[0]!.satisfiedAt, "number");
  assert.equal(dependent.dependencies[0]!.prUrl, url);
  assert.deepEqual(tasks.dependencyBlockers(dependent), []);
});


function completedAfterUnobservedEpisode(id: string, reuseBranch = false) {
  const f = departed(id, { worktreePath: null, homeName: null });
  f.episode.branch = `feat/${id}-a`;
  replaceSessionWorkEpisode(f.episode);
  f.episode.startedAt = Date.now() - 1000;
  replaceSessionWorkEpisode(f.episode);
  f.registry.bindTaskToWorkEpisode(f.taskId, f.id, f.episode, f.episode.startedAt);
  const dependentId = `${id}-dependent`;
  f.registry.upsertTask(baseTask({ id: dependentId, dependencies: [{
    type: "task", taskId: f.taskId, title: "Earlier work", sessionId: f.id,
    episodeId: f.episode.episodeId, agentSessionId: f.episode.agentSessionId,
    branch: f.episode.branch, prUrl: null, selectedAt: Date.now(), satisfiedAt: null,
  }] }));
  // Move the same task to B with no PR observed on A. Use the durable episode and
  // binding writers so both archival and Registry cleanup participate in this fixture.
  const next = { ...f.episode, episodeId: `${id}-episode-b`, branch: reuseBranch ? f.episode.branch : `feat/${id}-b`, startedAt: Date.now() - 100 };
  replaceSessionWorkEpisode(next);
  f.registry.bindTaskToWorkEpisode(f.taskId, f.id, next, next.startedAt);
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  managers.push(tasks);
  return { ...f, registry, tasks, dependentId, next };
}

test("a completed task discovers an unobserved historical branch after rollover and restart", async () => {
  const f = completedAfterUnobservedEpisode("historical-branch");
  const history = historicalTaskWorkEpisodeBindingsForTask(f.taskId);
  assert.equal(history.length, 1, "an unresolved edge preserves A before completion despite its missing PR URL");
  assert.equal(history[0]!.episodeId, f.episode.episodeId);
  assert.equal(history[0]!.prUrl, null);
  await f.tasks.complete(f.taskId, "completed");
  const before = f.registry.getTask(f.taskId)!;
  const restarted = new Registry();
  const tasks = new TaskManager(restarted);
  managers.push(tasks);
  const url = "https://github.com/example/repo/pull/1308";
  const asked: string[] = [];
  await pollAndReconcilePrs(restarted, async (_cwd, branch) => {
    asked.push(branch);
    if (branch !== f.episode.branch) return null;
    return { url, number: 1308, state: "merged", checks: "passing", createdAt: f.episode.startedAt + 1,
      mergedAt: Date.now(), headSha: "historical-head", worktreeHeadSha: null };
  }, async () => null);
  assert.ok(asked.includes(f.episode.branch!));
  const dependent = restarted.getTask(f.dependentId)!;
  assert.equal(dependent.dependencies[0]!.prUrl, url);
  assert.equal(typeof dependent.dependencies[0]!.satisfiedAt, "number");
  assert.deepEqual(tasks.dependencyBlockers(dependent), []);
  assert.deepEqual(restarted.getTask(f.taskId), before);
  assert.equal(taskWorkEpisodeForTask(f.taskId)!.episodeId, f.next.episodeId);
  assert.equal(taskWorkEpisodeForTask(f.taskId)!.prUrl, null, "A's PR must not be associated with current episode B");
  assert.equal(historicalTaskWorkEpisodeBindingsForTask(f.taskId)[0]!.prUrl, url);
  assert.notEqual(historicalTaskWorkEpisodeBindingsForTask(f.taskId)[0]!.mergedAt, null);
  assert.deepEqual(new Registry().getTask(f.dependentId)!.dependencies, dependent.dependencies);
});


for (const refusal of ["old-pr", "removed-edge", "reset"] as const) {
  test(`historical branch recovery refuses ${refusal} evidence`, async () => {
    const f = completedAfterUnobservedEpisode(`historical-${refusal}`);
    await f.tasks.complete(f.taskId, "completed");
    await pollAndReconcilePrs(f.registry, async (_cwd, branch) => {
      if (branch !== f.episode.branch) return null;
      if (refusal === "removed-edge") {
        f.registry.upsertTask({ ...f.registry.getTask(f.dependentId)!, dependencies: [] });
      } else if (refusal === "reset") {
        f.registry.upsertTask({ ...f.registry.getTask(f.taskId)!, status: "backlog" });
      }
      return { url: "https://github.com/example/repo/pull/1309", number: 1309,
        state: "merged", checks: "passing", createdAt: refusal === "old-pr" ? 0 : f.episode.startedAt + 1,
        mergedAt: Date.now(), headSha: "historical-head", worktreeHeadSha: null };
    }, async () => null);
    assert.ok(historicalTaskWorkEpisodeBindingsForTask(f.taskId).every(binding => binding.prUrl === null));
    assert.equal(taskWorkEpisodeForTask(f.taskId)!.prUrl, null);
    const edge = f.registry.getTask(f.dependentId)!.dependencies[0];
    if (refusal === "removed-edge") {
      assert.equal(edge, undefined);
      assert.deepEqual(historicalTaskWorkEpisodeBindingsForTask(f.taskId), [], "unreferenced branch evidence is pruned");
    } else assert.equal(edge!.satisfiedAt, null);
  });
}

test("an open historical PR stays blocked and later heals through the shared URL poller", async () => {
  const f = completedAfterUnobservedEpisode("historical-open");
  await f.tasks.complete(f.taskId, "completed");
  const url = "https://github.com/example/repo/pull/1310";
  await pollAndReconcilePrs(f.registry, async (_cwd, branch) => branch !== f.episode.branch ? null : {
    url, number: 1310, state: "open", checks: "passing", createdAt: f.episode.startedAt + 1,
    mergedAt: null, headSha: "historical-head", worktreeHeadSha: null,
  }, async () => null);
  assert.equal(f.registry.getTask(f.dependentId)!.dependencies[0]!.satisfiedAt, null);
  assert.equal(historicalTaskWorkEpisodeBindingsForTask(f.taskId)[0]!.prUrl, url);
  assert.equal(taskWorkEpisodeForTask(f.taskId)!.prUrl, null);
  await pollMerged(f.registry, url);
  const edge = f.registry.getTask(f.dependentId)!.dependencies[0]!;
  assert.equal(edge.prUrl, url);
  assert.equal(typeof edge.satisfiedAt, "number");
});


test("a PR created for a later episode on the same branch cannot satisfy the earlier edge", async () => {
  const f = completedAfterUnobservedEpisode("reused-historical-branch", true);
  await f.tasks.complete(f.taskId, "completed");
  const url = "https://github.com/example/repo/pull/1311";
  await pollAndReconcilePrs(f.registry, async (_cwd, branch) => branch !== f.episode.branch ? null : {
    url, number: 1311, state: "merged", checks: "passing", createdAt: f.next.startedAt + 1,
    mergedAt: Date.now(), headSha: "unrelated-next-head", worktreeHeadSha: null,
  }, async () => null);
  const historical = historicalTaskWorkEpisodeBindingsForTask(f.taskId)[0]!;
  assert.equal(historical.prUrl, null, "B's PR is not evidence for A");
  assert.equal(historical.mergedAt, null);
  assert.equal(taskWorkEpisodeForTask(f.taskId)!.prUrl, url, "the PR can belong to B without satisfying A");
  assert.equal(f.registry.getTask(f.dependentId)!.dependencies[0]!.satisfiedAt, null);
  await f.tasks.update(f.dependentId, { dependencies: [{ type: "task", taskId: f.taskId }] });
  assert.equal(f.registry.getTask(f.dependentId)!.dependencies[0]!.satisfiedAt, null, "saving cannot bypass episode ownership");
});

test("a PR created after completion cannot be attributed to the retained current episode", async () => {
  const f = departed("reused-current-branch", { worktreePath: null, homeName: null });
  f.registry.upsertTask(baseTask({ id: "reused-current-dependent", dependencies: [{
    type: "task", taskId: f.taskId, title: "Earlier work", sessionId: f.id,
    episodeId: f.episode.episodeId, agentSessionId: f.episode.agentSessionId,
    branch: f.episode.branch, prUrl: null, selectedAt: 1, satisfiedAt: null,
  }] }));
  await f.tasks.complete(f.taskId, "completed");
  const completedAt = f.registry.getTask(f.taskId)!.completedAt!;
  const restarted = new Registry();
  const tasks = new TaskManager(restarted);
  managers.push(tasks);
  await pollAndReconcilePrs(restarted, async () => ({
    url: "https://github.com/example/repo/pull/1312", number: 1312, state: "merged", checks: "passing",
    createdAt: completedAt + 1, mergedAt: completedAt + 2, headSha: "unrelated-head", worktreeHeadSha: null,
  }), async () => null);
  assert.equal(taskWorkEpisodeForTask(f.taskId)!.prUrl, null);
  assert.equal(restarted.getTask("reused-current-dependent")!.dependencies[0]!.satisfiedAt, null);
});

test("historical branch discovery refuses an unknown legacy episode end", async () => {
  const f = completedAfterUnobservedEpisode("historical-unknown-end");
  await f.tasks.complete(f.taskId, "completed");
  openDb().prepare("UPDATE historical_task_work_episode_bindings SET ended_at = NULL WHERE task_id = ?").run(f.taskId);
  await pollAndReconcilePrs(f.registry, async (_cwd, branch) => branch !== f.episode.branch ? null : {
    url: "https://github.com/example/repo/pull/1313", number: 1313, state: "merged", checks: "passing",
    createdAt: f.episode.startedAt + 1, mergedAt: Date.now(), headSha: "unknown-head", worktreeHeadSha: null,
  }, async () => null);
  assert.equal(historicalTaskWorkEpisodeBindingsForTask(f.taskId)[0]!.prUrl, null);
  assert.equal(f.registry.getTask(f.dependentId)!.dependencies[0]!.satisfiedAt, null);
});

test("branch recovery finds A's PR even when the newest candidate belongs to B", async () => {
  const f = completedAfterUnobservedEpisode("historical-candidates", true);
  await f.tasks.complete(f.taskId, "completed");
  const earlierUrl = "https://github.com/example/repo/pull/1314";
  const laterUrl = "https://github.com/example/repo/pull/1315";
  await pollAndReconcilePrs(f.registry, async () => [
    { url: laterUrl, number: 1315, state: "merged", checks: "passing", createdAt: f.next.startedAt + 1,
      mergedAt: Date.now(), headSha: "later-head", worktreeHeadSha: null },
    { url: earlierUrl, number: 1314, state: "merged", checks: "passing", createdAt: f.episode.startedAt + 1,
      mergedAt: Date.now(), headSha: "earlier-head", worktreeHeadSha: null },
  ], async () => null);
  const edge = f.registry.getTask(f.dependentId)!.dependencies[0]!;
  assert.equal(edge.prUrl, earlierUrl);
  assert.equal(typeof edge.satisfiedAt, "number");
  assert.equal(taskWorkEpisodeForTask(f.taskId)!.prUrl, laterUrl);
});

for (const matches of [true, false]) {
  test(`a PR opened after manual completion ${matches ? "recovers matching" : "rejects unrelated"} retained commits`, async () => {
    const f = departed(`late-created-${matches}`, { worktreePath: null, homeName: null });
    const dependentId = `late-created-dependent-${matches}`;
    f.registry.upsertTask(baseTask({ id: dependentId, dependencies: [{
      type: "task", taskId: f.taskId, title: "Earlier work", sessionId: f.id,
      episodeId: f.episode.episodeId, agentSessionId: f.episode.agentSessionId,
      branch: f.episode.branch, prUrl: null, selectedAt: 1, satisfiedAt: null,
    }] }));
    const retainedHead = "a".repeat(40);
    // The active episode has no PR yet. Its branch commit is captured by the poller.
    await pollAndReconcilePrs(f.registry, async () => null, async () => null,
      undefined, undefined, async () => retainedHead);
    await f.tasks.complete(f.taskId, "completed");
    const completedAt = f.registry.getTask(f.taskId)!.completedAt!;
    const restarted = new Registry();
    const tasks = new TaskManager(restarted);
    managers.push(tasks);
    const url = "https://github.com/example/repo/pull/1316";
    await pollAndReconcilePrs(restarted, async () => ({
      url, number: 1316, state: "merged", checks: "passing", createdAt: completedAt + 1,
      mergedAt: completedAt + 2, headSha: matches ? retainedHead : "b".repeat(40), worktreeHeadSha: null,
    }), async () => null);
    const edge = restarted.getTask(dependentId)!.dependencies[0]!;
    assert.equal(edge.prUrl, matches ? url : null);
    assert.equal(typeof edge.satisfiedAt, matches ? "number" : "object");
  });
}

test("retained commits survive rollover and allow a late-opened historical PR", async () => {
  const f = departed("late-created-history", { worktreePath: null, homeName: null });
  const sha = "c".repeat(40);
  f.registry.upsertTask(baseTask({ id: "late-history-dependent", dependencies: [{
    type: "task", taskId: f.taskId, title: "Earlier work", sessionId: f.id,
    episodeId: f.episode.episodeId, agentSessionId: f.episode.agentSessionId,
    branch: f.episode.branch, prUrl: null, selectedAt: 1, satisfiedAt: null,
  }] }));
  await pollAndReconcilePrs(f.registry, async () => null, async () => null, undefined, undefined, async () => sha);
  const next = { ...f.episode, episodeId: "late-created-history-b", startedAt: Date.now() };
  replaceSessionWorkEpisode(next);
  f.registry.bindTaskToWorkEpisode(f.taskId, f.id, next);
  assert.equal(historicalTaskWorkEpisodeBindingsForTask(f.taskId)[0]!.workHeadSha, sha);
  assert.equal(taskWorkEpisodeForTask(f.taskId)!.workHeadSha, null, "B cannot inherit A's commit");
  await f.tasks.complete(f.taskId, "completed");
  const at = f.registry.getTask(f.taskId)!.completedAt! + 1;
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  managers.push(tasks);
  const url = "https://github.com/example/repo/pull/1317";
  await pollAndReconcilePrs(registry, async () => ({ url, number: 1317, state: "merged", checks: "passing",
    createdAt: at, mergedAt: at + 1, headSha: sha, worktreeHeadSha: null }), async () => null);
  assert.equal(registry.getTask("late-history-dependent")!.dependencies[0]!.prUrl, url);
  assert.equal(typeof registry.getTask("late-history-dependent")!.dependencies[0]!.satisfiedAt, "number");
  assert.equal(taskWorkEpisodeForTask(f.taskId)!.prUrl, null);
});

test("a head poll finishing after completion cannot manufacture retained commit evidence", async () => {
  const f = departed("late-head-observation", { worktreePath: null, homeName: null });
  const [target] = f.registry.dependencyWorkHeadTargets().filter(t => t.binding.taskId === f.taskId);
  assert.ok(target);
  await f.tasks.complete(f.taskId, "completed");
  f.registry.recordDependencyWorkHead(target, "d".repeat(40));
  assert.equal(taskWorkEpisodeForTask(f.taskId)!.workHeadSha, null);
});

test("production discovery searches each episode window and retained SHA before choosing a PR", async () => {
  const f = completedAfterUnobservedEpisode("production-candidates", true);
  f.registry.upsertTask({ ...f.registry.getTask(f.taskId)!, repoRoot: home });
  // A retained commit enables the independent late-opened search in addition to the window.
  const sha = "e".repeat(40);
  openDb().prepare("UPDATE historical_task_work_episode_bindings SET work_head_sha = ? WHERE task_id = ?").run(sha, f.taskId);
  await f.tasks.complete(f.taskId, "completed");
  const older = { url: "https://github.com/example/repo/pull/1318", number: 1318, state: "MERGED",
    createdAt: new Date(f.episode.startedAt + 1).toISOString(), mergedAt: new Date().toISOString(), headRefOid: sha,
    mergeCommit: { oid: "f".repeat(40) } };
  const newer = { ...older, url: "https://github.com/example/repo/pull/1319", number: 1319,
    createdAt: new Date(f.next.startedAt + 1).toISOString(), headRefOid: "a".repeat(40) };
  const bin = join(home, "candidate-gh");
  const log = join(home, "candidate-gh.log");
  writeFileSync(bin, `#!${process.execPath}\nconst fs = require('node:fs');
const args = process.argv.slice(2); const search = args[args.indexOf('--search') + 1];
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const rows = search && search.includes('created:') ? [${JSON.stringify(newer)}, ${JSON.stringify(older)}] : [${JSON.stringify(newer)}];
process.stdout.write(JSON.stringify(rows));\n`, { mode: 0o755 });
  await withProcessEnv({ MISSION_GH_BIN: bin }, async () => {
    await pollAndReconcilePrs(f.registry, undefined, async () => null);
  });
  const args = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
  const lower = new Date(Math.floor(f.episode.startedAt / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const upper = new Date(Math.ceil(f.next.startedAt / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  assert.ok(args.some(a => a.includes(`created:${lower}..${upper}`)));
  for (const a of args) {
    const search = a[a.indexOf("--search") + 1]!;
    assert.doesNotMatch(search, /\.\d{3}Z/, "GitHub search qualifiers use whole-second timestamps");
  }
  assert.ok(args.some(a => a.some(v => v.startsWith(`${sha} created:>=`))));
  assert.equal(f.registry.getTask(f.dependentId)!.dependencies[0]!.prUrl, older.url);
  assert.equal(typeof f.registry.getTask(f.dependentId)!.dependencies[0]!.satisfiedAt, "number");
});


test("recording an active head revalidates one task without scanning the fleet", (t) => {
  const f = departed("head-single-target", { worktreePath: null, homeName: null });
  const target = f.registry.dependencyWorkHeadTargets().find(candidate => candidate.binding.taskId === f.taskId)!;
  const scan = t.mock.method(f.registry, "listTasks");
  f.registry.recordDependencyWorkHead(target, "f".repeat(40));
  assert.equal(scan.mock.callCount(), 0, "recording N targets must not rescan all N tasks each time");
  assert.equal(taskWorkEpisodeForTask(f.taskId)!.workHeadSha, "f".repeat(40));
});

for (const boundary of ["completion", "rollover"] as const) {
  test(`a PR created exactly at ${boundary} cannot satisfy an edge without a retained commit`, async () => {
    const f = completedAfterUnobservedEpisode(`exact-end-${boundary}`);
    const episode = boundary === "rollover" ? f.episode : f.next;
    if (boundary === "completion") {
      const dependent = f.registry.getTask(f.dependentId)!;
      const edge = dependent.dependencies[0]!;
      assert.equal(edge.type, "task");
      f.registry.upsertTask({ ...dependent, dependencies: [{ ...edge,
        sessionId: episode.sessionId, episodeId: episode.episodeId,
        agentSessionId: episode.agentSessionId, branch: episode.branch,
      }] });
    }
    await f.tasks.complete(f.taskId, "completed");
    const end = boundary === "rollover" ? f.next.startedAt : f.registry.getTask(f.taskId)!.completedAt!;
    const bindingBefore = taskWorkEpisodeForTask(f.taskId);
    const historyBefore = historicalTaskWorkEpisodeBindingsForTask(f.taskId);
    assert.equal(bindingBefore!.workHeadSha, null);
    assert.ok(historyBefore.every(binding => binding.workHeadSha === null));
    await pollAndReconcilePrs(f.registry, async (_cwd, branch) => branch !== episode.branch ? null : {
      url: "https://github.com/example/repo/pull/1320", number: 1320, state: "merged", checks: "passing",
      createdAt: end, mergedAt: end + 1, headSha: "unretained-head", worktreeHeadSha: null,
    }, async () => null);
    assert.deepEqual(taskWorkEpisodeForTask(f.taskId), bindingBefore);
    assert.deepEqual(historicalTaskWorkEpisodeBindingsForTask(f.taskId), historyBefore);
    assert.equal(f.registry.getTask(f.dependentId)!.dependencies[0]!.satisfiedAt, null);
    assert.equal(f.registry.getTask(f.dependentId)!.dependencies[0]!.prUrl, null);
  });
}

for (const failure of ["command-failure", "invalid-json", "non-array"] as const) {
  test(`production episode search preserves bindings and dependency edges on ${failure}`, async () => {
    const f = completedAfterUnobservedEpisode(`search-${failure}`);
    f.registry.upsertTask({ ...f.registry.getTask(f.taskId)!, repoRoot: home });
    await f.tasks.complete(f.taskId, "completed");
    const bindingBefore = taskWorkEpisodeForTask(f.taskId);
    const historyBefore = historicalTaskWorkEpisodeBindingsForTask(f.taskId);
    const dependentBefore = f.registry.getTask(f.dependentId)!;
    const sourceBefore = f.registry.getTask(f.taskId)!;
    const bin = join(home, `gh-${failure}`);
    const log = join(home, `gh-${failure}.log`);
    // A failed command can still print plausible PR data. Its exit code must win.
    const output = failure === "command-failure" ? JSON.stringify([{
      url: "https://github.com/example/repo/pull/1321", number: 1321, state: "MERGED",
      createdAt: new Date(f.episode.startedAt + 1).toISOString(),
      mergedAt: new Date().toISOString(), headRefOid: "historical-head",
    }]) : failure === "invalid-json" ? "{invalid-json" : "{}";
    writeFileSync(bin, `#!${process.execPath}\nconst fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
process.stdout.write(${JSON.stringify(output)});
process.exitCode = ${failure === "command-failure" ? 23 : 0};\n`, { mode: 0o755 });
    await withProcessEnv({ MISSION_GH_BIN: bin }, async () => {
      // Use the production branch search and parser, not an injected "error" result.
      await pollAndReconcilePrs(f.registry, undefined, async () => null);
    });
    const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
    assert.ok(calls.some(args => args.includes("--search") && args.includes(f.episode.branch!)), "the real episode search must invoke the fake CLI");
    assert.deepEqual(taskWorkEpisodeForTask(f.taskId), bindingBefore);
    assert.deepEqual(historicalTaskWorkEpisodeBindingsForTask(f.taskId), historyBefore);
    assert.deepEqual(f.registry.getTask(f.dependentId), dependentBefore);
    assert.deepEqual(f.registry.getTask(f.taskId), sourceBefore);
  });
}
