import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkSession, mkTask as baseTask } from "./helpers/session-fixture.ts";
import { agentIsFree } from "../src/server/foreman/backlog-machine.ts";
import type { BacklogConfig } from "../src/server/foreman/backlog-machine.ts";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";

const home = mkdtempSync(join(tmpdir(), "mission-task-completion-reconciler-"));
process.env.HARNESS_HOME = home;
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { pollAndReconcilePrs } = await import("../src/server/pr.ts");
const { setShippingConfig } = await import("../src/server/shipping/config.ts");
const { openDb } = await import("../src/server/db.ts");

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
    nomistakesGated: false,
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
  f.tasks.complete(f.taskId, "done by hand");

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
    nomistakes: null,
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
