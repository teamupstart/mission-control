import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask as baseTask } from "./helpers/session-fixture.ts";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { PrMatch } from "../src/server/registry.ts";

const home = mkdtempSync(join(tmpdir(), "mission-task-durable-merge-"));
process.env.HARNESS_HOME = home;
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { setShippingConfig } = await import("../src/server/shipping/config.ts");
const {
  openDb,
  markWorkEpisodeMerged,
  historicalTaskWorkEpisodeBindingsForTask,
  bindTaskWorkEpisode,
  taskWorkEpisodeForTask,
} = await import("../src/server/db.ts");

after(() => rmSync(home, { recursive: true, force: true }));

/**
 * What is at stake: a merged pull request is the durable proof a task's work landed, and it
 * must survive the agent rolling onto follow-up work. `mergedPrFor` reads a task's CURRENT
 * and HISTORICAL bindings so that a departed agent whose PR merged on a rolled-past episode
 * completes rather than fails - the reversal phase 1 exists to make. These pin the three
 * moving parts: the archival that preserves the rolled-off binding, the `markWorkEpisodeMerged`
 * stamp that reaches an already-historical row (the ordering phase 2's by-URL harvest
 * produces), and the newest-merge-wins tiebreak for a fix-forward task.
 */

const PR = "https://github.com/example/repo/pull/77";

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

function prMatch(over: Partial<PrMatch> = {}): PrMatch {
  const match: PrMatch = {
    url: PR,
    number: 77,
    state: "open",
    checks: "passing",
    branch: "feat/work",
    agentSessionId: null,
    episodeId: null,
    createdAt: null,
    mergedAt: null,
    headSha: "head",
    worktreeHeadSha: "head",
    ...over,
  };
  if (match.state === "merged" && match.mergedAt === null) match.mergedAt = Date.now();
  return match;
}

/** A historical binding written straight to the store - the shape a rollover leaves behind. */
function insertHistorical(b: {
  taskId: string;
  episodeId: string;
  sessionId: string;
  agentSessionId: string;
  branch: string | null;
  prUrl: string | null;
  prHeadSha: string | null;
  mergedAt: number | null;
  boundAt: number;
  updatedAt: number;
}): void {
  openDb()
    .prepare(
      `INSERT INTO historical_task_work_episode_bindings
         (task_id, episode_id, session_id, agent_session_id, branch, pr_url, pr_head_sha,
          merged_at, bound_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      b.taskId,
      b.episodeId,
      b.sessionId,
      b.agentSessionId,
      b.branch,
      b.prUrl,
      b.prHeadSha,
      b.mergedAt,
      b.boundAt,
      b.updatedAt,
    );
}

// ---- the db stamp reaches an already-historical binding ----------------------------------

test("markWorkEpisodeMerged stamps a binding that has already rolled to historical", () => {
  // A binding archived while its PR was still open - the ordering phase 2's by-URL harvest
  // produces, where the merge is observed AFTER the episode rolled off. The current rollover
  // paths only archive an already-merged episode, so this row is inserted directly; the point
  // is that the merge stamp still reaches it, in the same transaction as the live tables.
  const taskId = "durable-stamp-task";
  const sessionId = "durable-stamp-session";
  const episodeId = "durable-stamp-episode-1";
  const prUrl = "https://github.com/example/repo/pull/301";
  insertHistorical({
    taskId,
    episodeId,
    sessionId,
    agentSessionId: sessionId,
    branch: "feat/stamp",
    prUrl,
    prHeadSha: "sha",
    mergedAt: null,
    boundAt: 1,
    updatedAt: 1,
  });

  const now = 12_345;
  const changed = markWorkEpisodeMerged(sessionId, episodeId, prUrl, now);

  assert.equal(changed, true);
  const historical = historicalTaskWorkEpisodeBindingsForTask(taskId);
  assert.equal(historical.length, 1);
  assert.equal(historical[0]?.mergedAt, now);
});

test("the historical merge stamp is COALESCEd, never overwritten by a later observation", () => {
  const taskId = "durable-coalesce-task";
  const sessionId = "durable-coalesce-session";
  const episodeId = "durable-coalesce-episode-1";
  const prUrl = "https://github.com/example/repo/pull/302";
  insertHistorical({
    taskId,
    episodeId,
    sessionId,
    agentSessionId: sessionId,
    branch: "feat/coalesce",
    prUrl,
    prHeadSha: "sha",
    mergedAt: 1_000,
    boundAt: 1,
    updatedAt: 1,
  });

  assert.equal(markWorkEpisodeMerged(sessionId, episodeId, prUrl, 9_999), true);
  const historical = historicalTaskWorkEpisodeBindingsForTask(taskId);
  assert.equal(historical[0]?.mergedAt, 1_000, "the first-seen merge time is authoritative");
});

// ---- the rollover archives the merge, and the departed agent lands on it ------------------

test("a rollover archives the merged binding, and the departed agent lands on it", () => {
  setShippingConfig({ closeSessionAfterMerge: false });
  const registry = new Registry();
  new TaskManager(registry);
  const id = "durable-archive";
  const taskId = "durable-archive-task";
  const cwd = `/repo/${id}`;
  registry.applyDiscovery([discovered(id, cwd)]);
  // Still mid-turn when the PR merges, so the merge concludes nothing yet.
  registry.applyHook({
    agent: "claude",
    event: "UserPromptSubmit",
    sessionId: `${id}-episode`,
    cwd,
    transcriptPath: null,
    env: {},
    prompt: "go",
  });
  registry.upsertTask(baseTask({
    id: taskId,
    title: "Ship it",
    status: "running",
    sessionId: id,
    worktreePath: cwd,
  }));
  registry.bindTaskToWorkEpisode(taskId, id);
  const episode = registry.workEpisodeForSession(id)!;
  const mergedAt = episode.startedAt + 10;
  registry.reconcilePrs(
    new Map([[id, prMatch({
      state: "merged",
      mergedAt,
      agentSessionId: `${id}-episode`,
      episodeId: episode.episodeId,
      createdAt: episode.startedAt,
    })]]),
    new Set(),
  );
  // A later prompt rolls the task onto a new episode; the merged one moves to historical.
  registry.applyHook({
    agent: "claude",
    event: "UserPromptSubmit",
    sessionId: `${id}-episode`,
    cwd,
    transcriptPath: null,
    env: {},
    prompt: "carry on",
    ts: mergedAt + 1,
  });
  assert.notEqual(registry.workEpisodeForSession(id)?.episodeId, episode.episodeId);

  const historical = historicalTaskWorkEpisodeBindingsForTask(taskId);
  assert.equal(historical.length, 1, "the rolled-off episode is archived, not discarded");
  assert.equal(historical[0]?.episodeId, episode.episodeId);
  assert.equal(historical[0]?.prUrl, PR);
  assert.equal(historical[0]?.mergedAt, mergedAt);

  // The agent then vanishes mid-follow-up: the task lands on the earlier merge, not fails.
  registry.emit("event", { type: "session_remove", id });
  const t = registry.getTask(taskId)!;
  assert.equal(t.status, "done");
  assert.equal(t.outcomeUrl, PR);
  assert.match(t.outcome ?? "", /merged/);
});

test("an idle merge survives the provisional done-to-running rollover", () => {
  setShippingConfig({ closeSessionAfterMerge: false });
  const registry = new Registry();
  new TaskManager(registry);
  const id = "durable-idle-rollover";
  const taskId = "durable-idle-rollover-task";
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
    title: "Ship then follow up",
    status: "running",
    sessionId: id,
    worktreePath: cwd,
  }));
  registry.bindTaskToWorkEpisode(taskId, id);
  const episode = registry.workEpisodeForSession(id)!;
  const mergedAt = episode.startedAt + 10;
  registry.reconcilePrs(
    new Map([[id, prMatch({
      state: "merged",
      mergedAt,
      agentSessionId: `${id}-episode`,
      episodeId: episode.episodeId,
      createdAt: episode.startedAt,
    })]]),
    new Set(),
  );
  assert.equal(registry.getTask(taskId)?.status, "done");

  registry.applyHook({
    agent: "claude",
    event: "UserPromptSubmit",
    sessionId: `${id}-episode`,
    cwd,
    transcriptPath: null,
    env: {},
    prompt: "do the follow-up",
    ts: mergedAt + 1,
  });
  assert.equal(registry.getTask(taskId)?.status, "running");
  const historical = historicalTaskWorkEpisodeBindingsForTask(taskId);
  assert.equal(historical.length, 1);
  assert.equal(historical[0]?.episodeId, episode.episodeId);
  assert.equal(historical[0]?.mergedAt, mergedAt);

  registry.emit("event", { type: "session_remove", id });
  const task = registry.getTask(taskId)!;
  assert.equal(task.status, "done");
  assert.equal(task.outcomeUrl, PR);
  assert.match(task.outcome ?? "", /merged/);
});

// ---- newest merge wins across several bindings -------------------------------------------

test("a departed agent lands on the NEWEST merge across all of its episodes", () => {
  setShippingConfig({ closeSessionAfterMerge: false });
  const registry = new Registry();
  new TaskManager(registry);
  const id = "durable-newest";
  const taskId = "durable-newest-task";
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
    title: "Fix forward",
    status: "running",
    sessionId: id,
    worktreePath: cwd,
  }));
  registry.bindTaskToWorkEpisode(taskId, id);
  // Two earlier episodes each merged a PR - a fix-forward task opens more than one. The live
  // episode (the current binding) carries no merge of its own; the newest earlier merge is
  // the outcome to report.
  const older = "https://github.com/example/repo/pull/311";
  const newer = "https://github.com/example/repo/pull/312";
  insertHistorical({
    taskId,
    episodeId: `${id}-hist-older`,
    sessionId: id,
    agentSessionId: `${id}-episode`,
    branch: "feat/a",
    prUrl: older,
    prHeadSha: "sha1",
    mergedAt: 1_000,
    boundAt: 1,
    updatedAt: 1,
  });
  insertHistorical({
    taskId,
    episodeId: `${id}-hist-newer`,
    sessionId: id,
    agentSessionId: `${id}-episode`,
    branch: "feat/b",
    prUrl: newer,
    prHeadSha: "sha2",
    mergedAt: 2_000,
    boundAt: 2,
    updatedAt: 2,
  });

  registry.emit("event", { type: "session_remove", id });
  const t = registry.getTask(taskId)!;
  assert.equal(t.status, "done");
  assert.equal(t.outcomeUrl, newer, "the latest merge is the outcome, not the first");
});

test("with no merge on any binding, a departed agent still fails", () => {
  // The other half of the contract: reading historical bindings must not turn every orphaned
  // task into a success. An open (unmerged) historical PR is not an outcome.
  setShippingConfig({ closeSessionAfterMerge: false });
  const registry = new Registry();
  new TaskManager(registry);
  const id = "durable-unmerged";
  const taskId = "durable-unmerged-task";
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
    title: "Never landed",
    status: "running",
    sessionId: id,
    worktreePath: cwd,
  }));
  registry.bindTaskToWorkEpisode(taskId, id);
  insertHistorical({
    taskId,
    episodeId: `${id}-hist-open`,
    sessionId: id,
    agentSessionId: `${id}-episode`,
    branch: "feat/open",
    prUrl: "https://github.com/example/repo/pull/320",
    prHeadSha: "sha",
    mergedAt: null,
    boundAt: 1,
    updatedAt: 1,
  });

  registry.emit("event", { type: "session_remove", id });
  const t = registry.getTask(taskId)!;
  assert.equal(t.status, "failed");
  assert.match(t.error ?? "", /no outcome recorded/);
});

// ---- a session rebound to a new task preserves the prior task's merge ---------------------

test("rebinding a session to a new task archives the prior task's merged binding", () => {
  // The cross-task counterpart to rollover archival: when a session that ran task A is
  // rebound to task B, bindTaskWorkEpisode's `task_id <> ?` DELETE drops A's current binding.
  // If A's PR had merged while A was active, that row is A's only merge proof, so it must be
  // archived before the delete - otherwise a later departure fails A for shipped work.
  const sessionId = "durable-rebind-session";
  const taskA = "durable-rebind-task-a";
  const taskB = "durable-rebind-task-b";
  const prA = "https://github.com/example/repo/pull/330";
  bindTaskWorkEpisode({
    taskId: taskA,
    episodeId: "durable-rebind-episode-a",
    sessionId,
    agentSessionId: sessionId,
    branch: "feat/a",
    prUrl: prA,
    prHeadSha: "sha",
    mergedAt: 5_000,
    boundAt: 1,
    updatedAt: 1,
  });
  bindTaskWorkEpisode({
    taskId: taskB,
    episodeId: "durable-rebind-episode-b",
    sessionId,
    agentSessionId: sessionId,
    branch: "feat/b",
    prUrl: null,
    prHeadSha: null,
    mergedAt: null,
    boundAt: 2,
    updatedAt: 2,
  });

  assert.equal(taskWorkEpisodeForTask(taskA), null, "A's current binding is gone with the session");
  const histA = historicalTaskWorkEpisodeBindingsForTask(taskA);
  assert.equal(histA.length, 1, "A's merge is preserved in history, not lost with the delete");
  assert.equal(histA[0]?.episodeId, "durable-rebind-episode-a");
  assert.equal(histA[0]?.prUrl, prA);
  assert.equal(histA[0]?.mergedAt, 5_000);
});
