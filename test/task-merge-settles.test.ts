import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { mkTask as baseTask } from "./helpers/session-fixture.ts";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { PrMatch } from "../src/server/registry.ts";
import type { Session } from "../src/shared/types.ts";
import { tempDir } from "./temp-root.mjs";

const home = tempDir("mission-task-merge-settles-");
process.env.HARNESS_HOME = home;
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("./helpers/task-manager-fixture.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { setShippingConfig } = await import("../src/server/shipping/config.ts");
const { ShippingConfigSchema } = await import("../src/shared/protocol.ts");

after(() => rmSync(home, { recursive: true, force: true }));

/**
 * Regression coverage for merged-task settlement. README's "When a task's pull request
 * merges" section owns the user-facing behavior; these cases pin its local mechanics:
 * idle completion is reversible, working and rolled-over episodes stay running, and a
 * departed agent settles from only its current work-episode binding.
 */

const PR = "https://github.com/example/repo/pull/77";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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

/**
 * A session with a running task bound to its current work episode.
 *
 * `busy` is what separates "this turn is over" from "this agent is mid-turn", and the
 * distinction is load-bearing: an idle agent whose pull request merged has finished the
 * episode and its task lands, while a working one has not and must be left alone
 * whatever its pull request did.
 */
function fleet(
  id: string,
  busy = false,
  closeDeps?: ConstructorParameters<typeof TaskManager>[1],
  archives?: ConstructorParameters<typeof TaskManager>[4],
) {
  const registry = new Registry();
  for (const stale of registry.listTasks()) registry.removeTask(stale.id);
  const tasks = new TaskManager(registry, closeDeps, undefined, undefined, archives);
  const cwd = `/repo/${id}`;
  registry.applyDiscovery([discovered(id, cwd)]);
  registry.applyHook({
    agent: "claude",
    event: busy ? "UserPromptSubmit" : "Stop",
    sessionId: `${id}-episode`,
    cwd,
    transcriptPath: null,
    env: {},
    ...(busy ? { prompt: "get on with it" } : {}),
  });
  registry.upsertTask(baseTask({
    id: `task-${id}`,
    title: "Ship the thing",
    status: "running",
    sessionId: id,
    // These legacy close/reopen cases describe assigned agents. Managed completion is
    // terminal and covered separately below.
    worktreePath: null,
  }));
  registry.bindTaskToWorkEpisode(`task-${id}`, id);
  return { registry, tasks, id, taskId: `task-${id}` };
}

function merge(f: ReturnType<typeof fleet>): void {
  const episode = f.registry.workEpisodeForSession(f.id)!;
  f.registry.reconcilePrs(
    new Map([[f.id, prMatch({
      state: "merged",
      agentSessionId: `${f.id}-episode`,
      episodeId: episode.episodeId,
      createdAt: episode.startedAt,
    })]]),
    new Set(),
  );
}

/** The durable "this agent is gone for good" signal - Registry's eviction. */
function agentGone(f: ReturnType<typeof fleet>): void {
  f.registry.emit("event", { type: "session_remove", id: f.id });
}

// ---- a merge alone concludes nothing -----------------------------------------------------

test("a merge does NOT complete the task while its agent is mid-turn", () => {
  // An agent that lands an intermediate pull request and keeps going has not finished
  // the episode, so the merge alone is never terminal. Nothing observable at merge time
  // can rule out more work; only the agent's own idleness says the turn is over.
  setShippingConfig({ closeSessionAfterMerge: false });
  const f = fleet("s-alive", true);
  merge(f);
  assert.equal(f.registry.getTask(f.taskId)?.status, "running");
});

test("an agent prompted long after its merge still owns a running task", () => {
  setShippingConfig({ closeSessionAfterMerge: false });
  const f = fleet("s-late-prompt", true);
  const episode = f.registry.workEpisodeForSession(f.id)!;
  const mergedAt = episode.startedAt + 10;
  f.registry.reconcilePrs(
    new Map([[f.id, prMatch({
      state: "merged",
      mergedAt,
      agentSessionId: `${f.id}-episode`,
      episodeId: episode.episodeId,
      createdAt: episode.startedAt,
    })]]),
    new Set(),
  );
  // A minute later, by the clock or by the operator reading the diff - it makes no
  // difference, because nothing is counting.
  f.registry.applyHook({
    agent: "claude",
    event: "UserPromptSubmit",
    sessionId: `${f.id}-episode`,
    cwd: `/repo/${f.id}`,
    transcriptPath: null,
    env: {},
    prompt: "now do the follow-up",
    ts: mergedAt + 60_000,
  });
  assert.equal(f.registry.getTask(f.taskId)?.status, "running");
});

// ---- the agent that ships and then just sits there ---------------------------------------

test("an agent already idle when the merge is observed lands its task there and then", () => {
  // The ordinary ordering, and the one a `session_upsert` listener alone misses: the
  // agent finished its turn BEFORE the poller caught up with GitHub, so nothing further
  // is guaranteed to touch that session and no later event arrives to settle on. Left
  // `running`, the task makes `agentIsFree` refuse its own agent for ever - the exact
  // stall this whole change exists to remove. Nothing happens here after the merge.
  setShippingConfig({ closeSessionAfterMerge: false });
  const f = fleet("s-idle-live");
  merge(f);
  const t = f.registry.getTask(f.taskId)!;
  assert.equal(t.status, "done");
  assert.equal(t.outcomeUrl, PR);
  assert.ok(f.registry.getSession(f.id), "the agent itself is left alone");
});

test("an agent that goes idle AFTER the merge lands its task on that transition", () => {
  // The other ordering: still mid-turn when the merge lands, so the merge itself must
  // conclude nothing, and the settle has to come from the agent finishing later.
  setShippingConfig({ closeSessionAfterMerge: false });
  const f = fleet("s-idle-after", true);
  merge(f);
  assert.equal(f.registry.getTask(f.taskId)?.status, "running");
  f.registry.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: `${f.id}-episode`,
    cwd: `/repo/${f.id}`,
    transcriptPath: null,
    env: {},
  });
  assert.equal(f.registry.getTask(f.taskId)?.status, "done");
});

test("an idle agent with NO merge keeps its running task", () => {
  // The guard that keeps the above from settling every idle agent: idleness alone says
  // the turn ended, not that the work shipped.
  setShippingConfig({ closeSessionAfterMerge: false });
  const f = fleet("s-idle-unmerged");
  f.registry.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: `${f.id}-episode`,
    cwd: `/repo/${f.id}`,
    transcriptPath: null,
    env: {},
  });
  assert.equal(f.registry.getTask(f.taskId)?.status, "running");
});

// ---- the boundary that concludes it ------------------------------------------------------

test("once the agent is gone, a merged task settles as done with the PR as its outcome", () => {
  setShippingConfig({ closeSessionAfterMerge: false });
  const f = fleet("s-gone-merged");
  merge(f);
  agentGone(f);
  const t = f.registry.getTask(f.taskId)!;
  assert.equal(t.status, "done");
  assert.equal(t.outcomeUrl, PR);
  assert.match(t.outcome ?? "", /merged/);
});

test("it concludes with YOLO mode OFF - a human's merge lands a task just the same", () => {
  // `autoMerge` ships off, so anything hung off `maybeMerge` would cover almost nothing.
  // The signal is the merge itself, whoever performed it.
  setShippingConfig({ autoMerge: false, closeSessionAfterMerge: false });
  const f = fleet("s-yolo-off");
  merge(f);
  agentGone(f);
  assert.equal(f.registry.getTask(f.taskId)?.status, "done");
});

test("an agent that went away with NO merge still fails, exactly as before", () => {
  // The other half of the contract: this must not turn every orphaned task into a
  // success. `failed` keeps its meaning - ended with no outcome recorded.
  setShippingConfig({ closeSessionAfterMerge: false });
  const f = fleet("s-gone-unmerged");
  agentGone(f);
  const t = f.registry.getTask(f.taskId)!;
  assert.equal(t.status, "failed");
  assert.match(t.error ?? "", /no outcome recorded/);
});

test("an agent that rolled onto new work and then vanished LANDS on the earlier merge", () => {
  // The durable-completion reversal (phase 1). This case used to assert `failed` on the
  // reasoning that a rollover means unlanded follow-up work. But the only path here is
  // `agentWentAway`: the session is GONE, so there is no follow-up in progress to strand,
  // and a merged pull request IS an outcome the task produced. Reporting it as `failed`
  // behind a `stopped` blocker strands every dependent for work that shipped. So the merge
  // survives the rollover - archived to the historical binding - and `mergedPrFor` reads it
  // across ALL of the task's episodes, not just the current one.
  setShippingConfig({ closeSessionAfterMerge: false });
  const f = fleet("s-rolled", true);
  const episode = f.registry.workEpisodeForSession(f.id)!;
  const mergedAt = episode.startedAt + 10;
  f.registry.reconcilePrs(
    new Map([[f.id, prMatch({
      state: "merged",
      mergedAt,
      agentSessionId: `${f.id}-episode`,
      episodeId: episode.episodeId,
      createdAt: episode.startedAt,
    })]]),
    new Set(),
  );
  f.registry.applyHook({
    agent: "claude",
    event: "UserPromptSubmit",
    sessionId: `${f.id}-episode`,
    cwd: `/repo/${f.id}`,
    transcriptPath: null,
    env: {},
    prompt: "carry on",
    ts: mergedAt + 1,
  });
  assert.notEqual(f.registry.workEpisodeForSession(f.id)?.episodeId, episode.episodeId);
  agentGone(f);
  const t = f.registry.getTask(f.taskId)!;
  assert.equal(t.status, "done");
  assert.equal(t.outcomeUrl, PR);
});

test("a task an operator already completed is not rewritten", async () => {
  setShippingConfig({ closeSessionAfterMerge: false });
  const f = fleet("s-idempotent");
  await f.tasks.complete(f.taskId, "done by hand");
  merge(f);
  agentGone(f);
  const t = f.registry.getTask(f.taskId)!;
  assert.equal(t.status, "done");
  assert.equal(t.outcome, "done by hand");
});

test("a cancelled task whose pull request merged anyway is upgraded to done", () => {
  // The completion reconciler's upgrade (phase 2), and the reversal of what this case used
  // to assert. `cancelled` records what was concluded before anyone could see the pull
  // request merge; the merge is evidence that outranks it, and leaving the row terminal
  // means every task declared to wait on it deadlocks behind a `stopped` blocker for work
  // that shipped. Only a MERGE does this - a closed-unmerged pull request changes nothing -
  // and an outcome an operator recorded is still never overwritten (`done` is untouchable).
  setShippingConfig({ closeSessionAfterMerge: false });
  const f = fleet("s-cancelled");
  const cur = f.registry.getTask(f.taskId)!;
  f.registry.upsertTask({ ...cur, status: "cancelled" });
  merge(f);
  agentGone(f);
  const t = f.registry.getTask(f.taskId)!;
  assert.equal(t.status, "done");
  assert.equal(t.outcomeUrl, PR);
  // Whatever the cancel left behind stays where it is: the upgrade records an outcome, it
  // does not run a teardown. Freeing a checkout is still the operator's confirmed click.
  assert.equal(t.worktreePath, cur.worktreePath);
});

// ---- the switch only governs the AGENT ---------------------------------------------------

test("closeSessionAfterMerge defaults off", () => {
  assert.equal(ShippingConfigSchema.parse({}).closeSessionAfterMerge, false);
});

test("with the switch off, a merge leaves the session alone", () => {
  setShippingConfig({ closeSessionAfterMerge: false });
  const f = fleet("s-keep");
  merge(f);
  assert.ok(f.registry.getSession(f.id), "the session should still be here");
});

test("closing after merge records completion before it terminates the agent", async () => {
  setShippingConfig({ closeSessionAfterMerge: true });
  const closeAttempted = deferred();
  let statusAtClose: string | undefined;
  let outcomeAtClose: string | null | undefined;
  const f = fleet("s-complete-before-close", false, {
    // Keep the fake checkout out of reclaim; this test is about lifecycle ordering.
    resetWouldDestroyWork: async () => "an untracked test file",
    kill: async () => {
      statusAtClose = f.registry.getTask(f.taskId)?.status;
      outcomeAtClose = f.registry.getTask(f.taskId)?.outcome;
      closeAttempted.resolve();
      return { ok: true };
    },
  });

  merge(f);
  await closeAttempted.promise;

  assert.equal(statusAtClose, "done");
  assert.match(outcomeAtClose ?? "", /merged/);
});

test("closing after merge waits for a working agent's later idle transition", async () => {
  setShippingConfig({ closeSessionAfterMerge: true });
  const closeAttempted = deferred();
  const killed: string[] = [];
  const f = fleet("s-close-after-idle", true, {
    // Keep the fake checkout out of reclaim; this test is about the delayed close signal.
    resetWouldDestroyWork: async () => "an untracked test file",
    kill: async (session) => {
      killed.push(session.id);
      closeAttempted.resolve();
      return { ok: true };
    },
  });

  merge(f);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(killed, [], "the merge must not close a session mid-turn");
  assert.equal(f.registry.getTask(f.taskId)?.status, "running");

  f.registry.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: `${f.id}-episode`,
    cwd: `/repo/${f.id}`,
    transcriptPath: null,
    env: {},
  });
  await closeAttempted.promise;

  assert.equal(f.registry.getTask(f.taskId)?.status, "done");
  assert.deepEqual(killed, [f.id]);
});

test("a merged session awaiting input is not killed as a substitute for completion", async () => {
  setShippingConfig({ closeSessionAfterMerge: true });
  const killed: string[] = [];
  const f = fleet("s-awaiting-input", false, {
    resetWouldDestroyWork: async () => null,
    kill: async (session) => {
      killed.push(session.id);
      return { ok: true };
    },
  });
  f.registry.applyHook({
    agent: "claude",
    event: "Notification",
    sessionId: `${f.id}-episode`,
    cwd: `/repo/${f.id}`,
    transcriptPath: null,
    env: {},
    message: "Approve this action?",
  });
  assert.equal(f.registry.getSession(f.id)?.state, "awaiting_input");

  merge(f);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(killed, []);
  assert.equal(f.registry.getTask(f.taskId)?.status, "running");
  assert.ok(f.registry.getSession(f.id), "the unfinished session remains live");
});

test("a merged session awaiting review is not completed or closed", async () => {
  setShippingConfig({ closeSessionAfterMerge: true });
  const killed: string[] = [];
  const f = fleet("s-awaiting-review", false, {
    resetWouldDestroyWork: async () => null,
    kill: async (session) => {
      killed.push(session.id);
      return { ok: true };
    },
  });
  const sessions = (f.registry as unknown as { sessions: Map<string, Session> }).sessions;
  const session = sessions.get(f.id)!;
  sessions.set(f.id, { ...session, state: "awaiting_review" });

  merge(f);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(killed, []);
  assert.equal(f.registry.getTask(f.taskId)?.status, "running");
  assert.equal(f.registry.getSession(f.id)?.state, "awaiting_review");
});

test("a merged idle session carrying queued work is not completed or closed", async () => {
  setShippingConfig({ closeSessionAfterMerge: true });
  const killed: string[] = [];
  const f = fleet("s-queued-work", false, {
    resetWouldDestroyWork: async () => null,
    kill: async (session) => {
      killed.push(session.id);
      return { ok: true };
    },
  });
  const queues = new QueueManager(f.registry);
  assert.ok(queues.add(f.id, "finish the queued follow-up"));
  assert.equal(f.registry.getSession(f.id)?.queue?.openCount, 1);

  merge(f);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(killed, []);
  assert.equal(f.registry.getTask(f.taskId)?.status, "running");
  assert.equal(f.registry.getSession(f.id)?.queue?.openCount, 1);
});

test("work resuming during the close probe cancels the pending session close", async () => {
  setShippingConfig({ closeSessionAfterMerge: true });
  const probeStarted = deferred();
  const releaseProbe = deferred();
  const killed: string[] = [];
  const f = fleet("s-close-race", false, {
    resetWouldDestroyWork: async () => {
      probeStarted.resolve();
      await releaseProbe.promise;
      return null;
    },
    kill: async (session) => {
      killed.push(session.id);
      return { ok: true };
    },
  });

  merge(f);
  await probeStarted.promise;
  assert.equal(f.registry.getTask(f.taskId)?.status, "done");
  f.registry.applyHook({
    agent: "claude",
    event: "UserPromptSubmit",
    sessionId: `${f.id}-episode`,
    cwd: `/repo/${f.id}`,
    transcriptPath: null,
    env: {},
    prompt: "now do the follow-up",
  });
  releaseProbe.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(killed, []);
  assert.ok(f.registry.getSession(f.id), "the working session remains live");
  assert.equal(f.registry.getTask(f.taskId)?.status, "running");
});

test("a failed session close keeps the inferred completion reversible", async () => {
  setShippingConfig({ closeSessionAfterMerge: true });
  const closeAttempted = deferred();
  const f = fleet("s-close-failed", false, {
    resetWouldDestroyWork: async () => null,
    kill: async () => {
      closeAttempted.resolve();
      return { ok: false, error: "agent refused to stop" };
    },
  });
  const active = f.registry.getTask(f.taskId)!;
  f.registry.upsertTask({
    ...active,
    worktreePath: null,
    updatedAt: active.updatedAt + 1,
  });

  merge(f);
  await closeAttempted.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));

  const completed = f.registry.getTask(f.taskId)!;
  assert.equal(completed.status, "done");
  assert.equal(completed.sessionId, f.id, "a failed close must not reclaim or unbind the task");
  f.registry.applyHook({
    agent: "claude",
    event: "UserPromptSubmit",
    sessionId: `${f.id}-episode`,
    cwd: `/repo/${f.id}`,
    transcriptPath: null,
    env: {},
    prompt: "continue after the failed close",
  });
  assert.equal(f.registry.getTask(f.taskId)?.status, "running");
});

// ---- the conclusion is reversible --------------------------------------------------------

test("an agent that resumes work reopens the task we concluded from its idleness", () => {
  // The one thing an idle agent cannot tell us: whether it is finished, or merely
  // waiting to be typed at. Landing a pull request, reading the diff, then saying "now
  // the follow-up" is ordinary - and it produces a terminal task while its agent works
  // on. Rather than guess for longer before concluding (every fixed window is
  // outrunnable, which is what the timer this replaced got wrong), the conclusion is
  // undone the moment the agent contradicts it.
  setShippingConfig({ closeSessionAfterMerge: false });
  const f = fleet("s-resumed");
  merge(f);
  assert.equal(f.registry.getTask(f.taskId)?.status, "done");
  f.registry.applyHook({
    agent: "claude",
    event: "UserPromptSubmit",
    sessionId: `${f.id}-episode`,
    cwd: `/repo/${f.id}`,
    transcriptPath: null,
    env: {},
    prompt: "now do the follow-up",
  });
  const t = f.registry.getTask(f.taskId)!;
  assert.equal(t.status, "running");
  assert.equal(t.outcome, null, "a reopened task carries no outcome");
  assert.equal(t.outcomeUrl, null);
});

test("a HUMAN's completion is never reopened by the agent going busy again", async () => {
  // The guard that keeps the above from overwriting somebody's recorded outcome. Only
  // conclusions this class drew from idleness are reversible; a human's is a statement
  // about the work, not an inference.
  setShippingConfig({ closeSessionAfterMerge: false });
  const f = fleet("s-human-done", true);
  await f.tasks.complete(f.taskId, "shipped, and I say so");
  f.registry.applyHook({
    agent: "claude",
    event: "UserPromptSubmit",
    sessionId: `${f.id}-episode`,
    cwd: `/repo/${f.id}`,
    transcriptPath: null,
    env: {},
    prompt: "something else entirely",
  });
  const t = f.registry.getTask(f.taskId)!;
  assert.equal(t.status, "done");
  assert.equal(t.outcome, "shipped, and I say so");
});

test("a human completion supersedes an earlier reversible idle completion", async () => {
  setShippingConfig({ closeSessionAfterMerge: false });
  const f = fleet("s-human-overrides-idle");
  merge(f);
  assert.equal(f.registry.getTask(f.taskId)?.status, "done");
  await f.tasks.complete(f.taskId, "verified and completed by hand");
  f.registry.applyHook({
    agent: "claude",
    event: "UserPromptSubmit",
    sessionId: `${f.id}-episode`,
    cwd: `/repo/${f.id}`,
    transcriptPath: null,
    env: {},
    prompt: "start something new",
  });
  const t = f.registry.getTask(f.taskId)!;
  assert.equal(t.status, "done");
  assert.equal(t.outcome, "verified and completed by hand");
});

test("unbinding an inferred completion releases its reopening provenance", () => {
  setShippingConfig({ closeSessionAfterMerge: false });
  const f = fleet("s-unbound-completion");
  merge(f);
  const provenance = f.tasks as unknown as {
    autoCompleted: Map<string, string>;
  };
  assert.equal(provenance.autoCompleted.size, 1);
  const completed = f.registry.getTask(f.taskId)!;
  f.registry.upsertTask({
    ...completed,
    sessionId: null,
    updatedAt: completed.updatedAt + 1,
  });
  assert.equal(provenance.autoCompleted.size, 0);
  f.registry.applyHook({
    agent: "claude",
    event: "UserPromptSubmit",
    sessionId: `${f.id}-episode`,
    cwd: `/repo/${f.id}`,
    transcriptPath: null,
    env: {},
    prompt: "start the next assignment",
  });
  const released = f.registry.getTask(f.taskId)!;
  assert.equal(released.status, "done");
  assert.equal(released.outcomeUrl, PR, "later work must not erase the released task's outcome");
});

test("pruning an inferred completion does not recreate its reopening provenance", () => {
  setShippingConfig({ closeSessionAfterMerge: false });
  const f = fleet("s-pruned-completion");
  const active = f.registry.getTask(f.taskId)!;
  f.registry.upsertTask({
    ...active,
    worktreePath: null,
    updatedAt: active.updatedAt + 1,
  });
  const future = Date.now() + 60_000;
  for (let i = 0; i < 50; i++) {
    f.registry.upsertTask(baseTask({
      id: `newer-terminal-${i}`,
      status: "done",
      completedAt: future + i,
      updatedAt: future + i,
    }));
  }

  merge(f);

  assert.equal(f.registry.getTask(f.taskId), undefined, "the bounded task list evicts the older row");
  const provenance = f.tasks as unknown as {
    autoCompleted: Map<string, string>;
  };
  assert.equal(provenance.autoCompleted.size, 0);
});

test("a reopened task stays running when its next idle turn is on an unmerged episode", () => {
  setShippingConfig({ closeSessionAfterMerge: false });
  const f = fleet("s-recycle");
  merge(f);
  assert.equal(f.registry.getTask(f.taskId)?.status, "done");
  const hook = (event: "UserPromptSubmit" | "Stop") =>
    f.registry.applyHook({
      agent: "claude",
      event,
      sessionId: `${f.id}-episode`,
      cwd: `/repo/${f.id}`,
      transcriptPath: null,
      env: {},
      ...(event === "UserPromptSubmit" ? { prompt: "more" } : {}),
    });
  hook("UserPromptSubmit");
  assert.equal(f.registry.getTask(f.taskId)?.status, "running");
  hook("Stop");
  // Idle again on a rolled-over episode with no merge of its own: it stays running. This
  // is a LIVE session, so `settleIfEpisodeFinished`'s episode-currency gate governs (the
  // current episode never merged), NOT `agentWentAway`/`mergedPrFor` - the two paths differ
  // precisely because a present agent may still be mid-turn while a departed one cannot.
  assert.equal(f.registry.getTask(f.taskId)?.status, "running");
});


test("managed merge completion closes regardless of the assigned-agent reuse setting", async () => {
  setShippingConfig({ closeSessionAfterMerge: false });
  const killed: string[] = [];
  const f = fleet("s-managed-final", false, {
    resetWouldDestroyWork: async () => "local edits",
    kill: async (session) => { killed.push(session.id); return { ok: true }; },
  });
  f.registry.upsertTask({ ...f.registry.getTask(f.taskId)!, worktreePath: `/repo/${f.id}` });
  merge(f);
  await f.tasks.sweepMissionSessionClosures();
  assert.deepEqual(killed, [f.id]);
  f.registry.applyHook({ agent: "claude", event: "UserPromptSubmit", sessionId: `${f.id}-episode`,
    cwd: `/repo/${f.id}`, transcriptPath: null, env: {}, prompt: "late work" });
  assert.equal(f.registry.getTask(f.taskId)?.status, "done");
  assert.match(f.registry.promptResourceBlockerForSession(f.id) ?? "", /being closed/);
});

for (const status of ["completed", "cancelled"] as const) {
  test(`a merged idle plan settles when its workflow is ${status}`, async () => {
    const { LADDER_SUMMARY } = await import("./helpers/workflow-ladder.ts");
    const f = fleet(`workflow-${status}`);
    f.registry.upsertTask({ ...f.registry.getTask(f.taskId)!, kind: "plan" });
    const run = { ...LADDER_SUMMARY, id: `run-${status}`, sessionId: f.id,
      status: "waiting_for_action" as const, phase: "session_action" };
    f.registry.upsertWorkflowRun(run);
    merge(f);
    assert.equal(f.registry.getTask(f.taskId)?.status, "running");
    f.registry.upsertWorkflowRun({ ...run, status, phase: "done" });
    assert.equal(f.registry.getTask(f.taskId)?.status, "done");
    assert.equal(f.registry.getTask(f.taskId)?.outcomeUrl, PR);
  });
}

for (const status of ["completed", "cancelled"] as const) {
  test(`startup observation settles an idle merged plan with a ${status} workflow`, async () => {
    const { LADDER_SUMMARY } = await import("./helpers/workflow-ladder.ts");
    setShippingConfig({ closeSessionAfterMerge: false });
    const f = fleet(`startup-workflow-${status}`);
    f.registry.upsertTask({ ...f.registry.getTask(f.taskId)!, kind: "plan" });
    const run = { ...LADDER_SUMMARY, id: `startup-run-${status}`, sessionId: f.id,
      status: "waiting_for_action" as const, phase: "session_action" };
    f.registry.upsertWorkflowRun(run);
    merge(f);
    await f.tasks.stop();

    // Restore the terminal run while TaskManager is offline. No listener can settle it.
    f.registry.upsertWorkflowRun({ ...run, status, phase: "done" });
    assert.equal(f.registry.getSession(f.id)?.state, "idle");
    assert.equal(f.registry.getTask(f.taskId)?.status, "running");
    assert.equal(f.registry.sessionsObserved(), true);

    // onSessionsObserved replays completed discovery to the new manager. There is no
    // fresh workflow or session update to drive the ordinary event-based settlement.
    new TaskManager(f.registry);
    const settled = f.registry.getTask(f.taskId)!;
    assert.equal(settled.status, "done");
    assert.equal(settled.outcomeUrl, PR);
    assert.ok(settled.completedAt);
  });
}

test("a terminal workflow cannot settle a busy agent or bypass another active run", async () => {
  const { LADDER_SUMMARY } = await import("./helpers/workflow-ladder.ts");
  const f = fleet("workflow-still-busy", true);
  const run = { ...LADDER_SUMMARY, id: "finished", sessionId: f.id, status: "completed" as const };
  merge(f);
  f.registry.upsertWorkflowRun(run);
  assert.equal(f.registry.getTask(f.taskId)?.status, "running");
  f.registry.upsertWorkflowRun({ ...run, id: "sibling", status: "waiting_for_action" });
  f.registry.applyHook({ agent: "claude", event: "Stop", sessionId: `${f.id}-episode`,
    cwd: `/repo/${f.id}`, transcriptPath: null, env: {} });
  f.registry.upsertWorkflowRun(run);
  assert.equal(f.registry.getTask(f.taskId)?.status, "running");
});

for (const status of ["completed", "cancelled"] as const) {
  for (const published of [true, false]) test(`rolled-over plan after ${status}, publication proof=${published}`, async () => {
    const { LADDER_SUMMARY } = await import("./helpers/workflow-ladder.ts");
    const proof = deferred();
    const f = fleet(`rolled-${status}-${published}`, true, {
      resetWouldDestroyWork: async () => null,
      kill: async () => ({ ok: true }),
      mergedPublicationCoversCheckout: async () => { await proof.promise; return published; },
      workflowDeliveredCurrentPrompt: () => true,
    });
    f.registry.upsertTask({ ...f.registry.getTask(f.taskId)!, kind: "plan" });
    merge(f);
    const before = f.registry.workEpisodeForSession(f.id)!;
    f.registry.applyHook({ agent: "claude", event: "UserPromptSubmit", sessionId: `${f.id}-episode`,
      cwd: `/repo/${f.id}`, transcriptPath: null, env: {}, prompt: "Pull Request", ts: Date.now() + 1 });
    assert.notEqual(f.registry.workEpisodeForSession(f.id)?.episodeId, before.episodeId);
    f.registry.applyHook({ agent: "claude", event: "Stop", sessionId: `${f.id}-episode`,
      cwd: `/repo/${f.id}`, transcriptPath: null, env: {}, ts: Date.now() + 2 });
    f.registry.upsertWorkflowRun({ ...LADDER_SUMMARY, id: `rolled-run-${status}-${published}`, sessionId: f.id, status });
    proof.resolve();
    for (let i = 0; i < 20 && f.registry.getTask(f.taskId)?.status === "running"; i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(f.registry.getTask(f.taskId)?.status, published ? "done" : "running");
  });
}

for (const failureStage of ["publication", "completion"] as const) {
  test(`rolled-over settlement distinguishes ${failureStage} failure and permits a later retry`, async (t) => {
    const { LADDER_SUMMARY } = await import("./helpers/workflow-ladder.ts");
    setShippingConfig({ closeSessionAfterMerge: false });
    const failure = new Error(`${failureStage} unavailable`);
    let failing = true;
    const f = fleet(`rolled-failure-${failureStage}`, true, {
      resetWouldDestroyWork: async () => null,
      kill: async () => ({ ok: true }),
      mergedPublicationCoversCheckout: async () => {
        if (failing && failureStage === "publication") throw failure;
        return true;
      },
      workflowDeliveredCurrentPrompt: () => true,
    });
    f.registry.upsertTask({ ...f.registry.getTask(f.taskId)!, kind: "plan" });
    const run = { ...LADDER_SUMMARY, id: `failure-run-${failureStage}`, sessionId: f.id,
      status: "waiting_for_action" as const, phase: "session_action" };
    f.registry.upsertWorkflowRun(run);
    merge(f);
    const before = f.registry.workEpisodeForSession(f.id)!;
    f.registry.applyHook({ agent: "claude", event: "UserPromptSubmit", sessionId: `${f.id}-episode`,
      cwd: `/repo/${f.id}`, transcriptPath: null, env: {}, prompt: "Pull Request", ts: Date.now() + 1 });
    assert.notEqual(f.registry.workEpisodeForSession(f.id)?.episodeId, before.episodeId);
    f.registry.applyHook({ agent: "claude", event: "Stop", sessionId: `${f.id}-episode`,
      cwd: `/repo/${f.id}`, transcriptPath: null, env: {}, ts: Date.now() + 2 });

    const errors: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => errors.push(args));
    let completionCalls = 0;
    const upsertTask = f.registry.upsertTask.bind(f.registry);
    t.mock.method(f.registry, "upsertTask", (task: Parameters<typeof upsertTask>[0]) => {
      if (task.id === f.taskId && task.status === "done") {
        completionCalls++;
        if (failing && failureStage === "completion") throw failure;
      }
      return upsertTask(task);
    });
    const terminal = { ...run, status: "completed" as const, phase: "done" };
    f.registry.upsertWorkflowRun(terminal);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.registry.getTask(f.taskId)?.status, "running");
    assert.equal(completionCalls, failureStage === "completion" ? 1 : 0);
    assert.deepEqual(errors, failureStage === "completion"
      ? [["[merge] settling published task after workflow failed:", f.taskId, failure]] : []);

    failing = false;
    f.registry.upsertWorkflowRun(terminal);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.registry.getTask(f.taskId)?.status, "done", "failed settlement releases its in-flight entry");
    assert.equal(f.registry.getTask(f.taskId)?.outcomeUrl, PR);
  });
}

test("rolled-over settlement verifies the actual clean checkout against the merged PR", async (t) => {
  const { execFileSync } = await import("node:child_process");
  const { writeFileSync } = await import("node:fs");
  const { adoptInspectorPr } = await import("../src/server/db.ts");
  const { mergedPublicationCoversCheckout } = await import("../src/server/tasks.ts");
  const repo = mkdtempSync(join(home, "publication-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-b", "plan");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.test");
  writeFileSync(join(repo, "plan.md"), "Reviewed plan");
  git("add", "."); git("commit", "-m", "Plan");
  const head = git("rev-parse", "HEAD");
  const url = "https://github.com/example/repo/pull/1570";
  adoptInspectorPr({ key: "example/repo#1570", url, owner: "example", repo: "repo", number: 1570,
    repoRoot: repo, cwd: repo, sessionId: "proof", source: "hook", state: "closed",
    headSha: head, reviewPosture: "live", round: 1, lastReviewedAt: 1, lastError: null,
    failCount: 0, lastFailKind: null, nextAttemptAt: null, lastAttemptSha: head,
    mergedAt: 1, mergeBlock: null, observedHeadSha: head, observedState: "MERGED", observedAt: 1,
    headRefName: "plan", title: "Plan", adoptedAt: 1, updatedAt: 1 });
  const session = { cwd: repo, gitBranch: "plan" } as Session;
  assert.equal(await mergedPublicationCoversCheckout(session, url), true);
  await t.test("a tracked edit after the first status read prevents settlement", async () => {
    const { run } = await import("../src/server/util/exec.ts");
    let statusReads = 0;
    try {
      const exec: typeof run = async (...args) => {
        const result = await run(...args);
        if (args[1]?.includes("status") && ++statusReads === 1) {
          writeFileSync(join(repo, "plan.md"), "Edited during publication proof");
        }
        return result;
      };
      assert.equal(await mergedPublicationCoversCheckout(session, url, exec), false);
    } finally { git("restore", "plan.md"); }
  });
  await t.test("untracked files prevent settlement even when Git's user config hides them", async () => {
    git("config", "status.showUntrackedFiles", "no");
    writeFileSync(join(repo, "unpublished.md"), "More work");
    try {
      assert.equal(git("status", "--porcelain"), "");
      assert.equal(await mergedPublicationCoversCheckout(session, url), false);
    } finally {
      rmSync(join(repo, "unpublished.md"));
      git("config", "--unset", "status.showUntrackedFiles");
    }
  });
  await t.test("a clean external commit during the final status check still prevents settlement", async () => {
    const { run } = await import("../src/server/util/exec.ts");
    const before = git("rev-parse", "HEAD");
    let statusReads = 0;
    try {
      const exec: typeof run = async (...args) => {
        const result = await run(...args);
        if (args[1]?.includes("status") && ++statusReads === 2) {
          writeFileSync(join(repo, "plan.md"), "Committed unpublished work");
          git("add", "plan.md"); git("commit", "-m", "Concurrent unpublished work");
        }
        return result;
      };
      assert.equal(await mergedPublicationCoversCheckout(session, url, exec), false);
      assert.equal(git("status", "--porcelain"), "");
      assert.notEqual(git("rev-parse", "HEAD"), before);
    } finally {
      if (git("rev-parse", "HEAD") !== before) git("revert", "--no-edit", "HEAD");
    }
  });
  await t.test("rejects another repository with the same merged commit and clean content tree", async () => {
    const otherRepo = mkdtempSync(join(home, "other-publication-"));
    git("clone", "--no-hardlinks", repo, otherRepo);
    const otherGit = (...args: string[]) =>
      execFileSync("git", ["-C", otherRepo, ...args], { encoding: "utf8" }).trim();
    assert.equal(otherGit("rev-parse", "HEAD"), git("rev-parse", "HEAD"));
    assert.equal(otherGit("rev-parse", "HEAD^{tree}"), git("rev-parse", "HEAD^{tree}"));
    assert.equal(otherGit("status", "--porcelain"), "");
    assert.equal(otherGit("branch", "--show-current"), session.gitBranch);
    assert.notEqual(otherGit("rev-parse", "--path-format=absolute", "--git-common-dir"),
      git("rev-parse", "--path-format=absolute", "--git-common-dir"));
    assert.equal(await mergedPublicationCoversCheckout({ ...session, cwd: otherRepo }, url), false);
  });
  writeFileSync(join(repo, "plan.md"), "Unpublished changes");
  assert.equal(await mergedPublicationCoversCheckout(session, url), false);
  git("add", "."); git("commit", "-m", "Unpublished");
  assert.equal(await mergedPublicationCoversCheckout(session, url), false);
  assert.equal(await mergedPublicationCoversCheckout({ ...session, gitBranch: "other" }, url), false);
});

async function rolledPublicationFixture(id: string, options: {
  proof?: () => Promise<boolean>;
  archives?: ConstructorParameters<typeof TaskManager>[4];
  managed?: boolean;
} = {}) {
  const { LADDER_SUMMARY } = await import("./helpers/workflow-ladder.ts");
  setShippingConfig({ closeSessionAfterMerge: false });
  let receipt: { episodeId: string; promptedAt: number | null } | null = null;
  const f = fleet(id, true, {
    resetWouldDestroyWork: async () => null,
    kill: async () => ({ ok: true }),
    mergedPublicationCoversCheckout: options.proof ?? (async () => true),
    workflowDeliveredCurrentPrompt: (_runId, _sessionId, episodeId, promptedAt) =>
      receipt?.episodeId === episodeId && receipt.promptedAt === promptedAt,
  }, options.archives);
  f.registry.upsertTask({ ...f.registry.getTask(f.taskId)!, kind: options.archives ? "scout" : "plan",
    ...(options.managed ? { worktreePath: `/repo/${id}` } : {}) });
  const run = { ...LADDER_SUMMARY, id: `run-${id}`, sessionId: f.id,
    status: "waiting_for_action" as const, phase: "session_action" };
  f.registry.upsertWorkflowRun(run);
  merge(f);
  const merged = f.registry.recordedWorkEpisodeForSession(f.id)!;
  let time = Math.max(Date.now(), merged.mergedAt!) + 5;
  const hook = (event: "UserPromptSubmit" | "Stop", prompt?: string) => f.registry.applyHook({
    agent: "claude", event, sessionId: `${f.id}-episode`, cwd: `/repo/${f.id}`,
    transcriptPath: null, env: {}, ts: time++, ...(prompt ? { prompt } : {}),
  });
  hook("UserPromptSubmit", "Pull Request");
  const current = f.registry.recordedWorkEpisodeForSession(f.id)!;
  receipt = { episodeId: current.episodeId, promptedAt: current.promptedAt };
  hook("Stop");
  const finish = () => f.registry.upsertWorkflowRun({ ...run, status: "completed", phase: "done" });
  return { ...f, hook, finish, merged, current };
}

async function settleTicks() {
  for (let i = 0; i < 10; i++) await new Promise<void>(resolve => setImmediate(resolve));
}

test("an operator follow-up cannot borrow a terminal workflow's publication proof", async () => {
  let proofs = 0;
  const f = await rolledPublicationFixture("operator-followup", { proof: async () => { proofs++; return true; } });
  f.hook("UserPromptSubmit", "Now also handle X");
  f.hook("Stop");
  f.finish();
  await settleTicks();
  assert.equal(proofs, 0);
  assert.equal(f.registry.getTask(f.taskId)?.status, "running");
});

test("an idle event during publication verification is replayed once after the stale proof", async () => {
  const proof = deferred();
  let calls = 0;
  let active = 0;
  let maximum = 0;
  const f = await rolledPublicationFixture("proof-recheck", { proof: async () => {
    calls++; maximum = Math.max(maximum, ++active);
    if (calls === 1) await proof.promise;
    active--; return true;
  } });
  f.finish();
  await new Promise<void>(resolve => setImmediate(resolve));
  f.hook("Stop");
  f.hook("Stop");
  proof.resolve();
  await settleTicks();
  assert.equal(f.registry.getTask(f.taskId)?.status, "done");
  assert.equal(calls, 3, "one stale proof, one coalesced retry, one final revalidation");
  assert.equal(maximum, 1);
});

test("publication inferred for an assigned agent reopens when that agent resumes", async () => {
  const f = await rolledPublicationFixture("assigned-reopens");
  f.finish(); await settleTicks();
  assert.equal(f.registry.getTask(f.taskId)?.status, "done");
  f.hook("UserPromptSubmit", "Continue the task");
  assert.equal(f.registry.getTask(f.taskId)?.status, "running");
});

for (const change of ["none", "working", "queue", "workflow", "checkout"] as const) {
  test(`scout publication revalidates after archive verification: ${change}`, async () => {
    const archive = deferred();
    const entered = deferred();
    let published = true;
    const f = await rolledPublicationFixture(`scout-proof-${change}`, {
      managed: true,
      proof: async () => published,
      archives: {
        ensureReady: async () => { entered.resolve(); await archive.promise; return { ok: true }; },
        settleBeforeCleanup: async () => ({ ok: true }),
      },
    });
    f.finish(); await entered.promise;
    if (change === "working") f.hook("UserPromptSubmit", "Continue this scout");
    if (change === "queue") assert.ok(new QueueManager(f.registry).add(f.id, "More work"));
    if (change === "workflow") {
      const { LADDER_SUMMARY } = await import("./helpers/workflow-ladder.ts");
      f.registry.upsertWorkflowRun({ ...LADDER_SUMMARY, id: "new-active-run", sessionId: f.id, status: "waiting_for_action" });
    }
    if (change === "checkout") published = false;
    archive.resolve(); await settleTicks();
    assert.equal(f.registry.getTask(f.taskId)?.status, change === "none" ? "done" : "running");
    const { getTaskSessionClosure } = await import("../src/server/db.ts");
    assert.equal(getTaskSessionClosure(f.taskId) !== null, change === "none");
  });
}

test("shutdown drains an owned scout archive without finishing stale publication settlement", async () => {
  const archive = deferred();
  const entered = deferred();
  const f = await rolledPublicationFixture("scout-shutdown", {
    managed: true,
    archives: {
      ensureReady: async () => { entered.resolve(); await archive.promise; return { ok: true }; },
      settleBeforeCleanup: async () => ({ ok: true }),
    },
  });
  f.finish(); await entered.promise;
  let stopped = false;
  const stopping = f.tasks.stop().then(() => { stopped = true; });
  try {
    await settleTicks();
    assert.equal(stopped, false, "shutdown retains the existing durable archive drain");
  } finally {
    archive.resolve();
    await stopping;
  }
  assert.equal(f.registry.getTask(f.taskId)?.status, "running", "the stopped settlement cannot write done");
  const { getTaskSessionClosure } = await import("../src/server/db.ts");
  assert.equal(getTaskSessionClosure(f.taskId), null, "shutdown creates no stale closure obligation");
});

test("workflow settlement releases only dependency edges pinned to the merged episode", async () => {
  const f = await rolledPublicationFixture("dependency-episodes");
  const dep = (episodeId: string) => ({ type: "task" as const, taskId: f.taskId, title: "Plan",
    sessionId: f.id, episodeId, agentSessionId: `${f.id}-episode`, branch: "feat/work",
    prUrl: null, selectedAt: 1, satisfiedAt: null });
  f.registry.upsertTask(baseTask({ id: "dependent-merged", sessionId: null, status: "backlog",
    dependencies: [dep(f.merged.episodeId)] }));
  f.registry.upsertTask(baseTask({ id: "dependent-unmerged", sessionId: null, status: "backlog",
    dependencies: [dep(f.current.episodeId)] }));
  f.finish(); await settleTicks();
  assert.equal(f.registry.getTask(f.taskId)?.status, "done");
  assert.ok(f.registry.getTask("dependent-merged")?.dependencies[0]?.satisfiedAt);
  assert.equal(f.registry.getTask("dependent-unmerged")?.dependencies[0]?.satisfiedAt, null);
});

test("a blocked workflow retains a merged task until the operator cancels its run", async () => {
  const { LADDER_SUMMARY } = await import("./helpers/workflow-ladder.ts");
  const { activeWorkflowOwnsSession } = await import("../src/server/foreman/review-followup.ts");
  setShippingConfig({ closeSessionAfterMerge: false });
  const f = fleet("blocked-merge-policy");
  const run = { ...LADDER_SUMMARY, id: "blocked-publication", sessionId: f.id,
    status: "blocked" as const, phase: "session_action_blocked" };
  f.registry.upsertWorkflowRun(run);
  merge(f);
  assert.equal(activeWorkflowOwnsSession([run]), true);
  assert.equal(f.registry.getTask(f.taskId)?.status, "running",
    "a blocked publication action still owns its recovery, even after an earlier merge");
  f.registry.upsertWorkflowRun({ ...run, status: "cancelled", phase: "done" });
  assert.equal(f.registry.getTask(f.taskId)?.status, "done");
});

for (const status of ["completed", "cancelled"] as const) {
  test(`a driver-only SDK action settles its merged episode after ${status} without a prompt hook`, async () => {
    const { LADDER_SUMMARY } = await import("./helpers/workflow-ladder.ts");
    setShippingConfig({ closeSessionAfterMerge: false });
    const registry = new Registry();
    const tasks = new TaskManager(registry);
    const id = `sdk:no-hook-${status}`;
    registry.registerSdkSession({ id, agent: "codex", name: "Driver-only plan", cwd: `/repo/${status}`,
      agentSessionId: `native-${status}`, gitBranch: "feat/work" });
    registry.applyDriverEvent(id, { kind: "state", state: "working", activity: "Finishing plan" });
    const taskId = `driver-only-${status}`;
    registry.upsertTask(baseTask({ id: taskId, kind: "plan", status: "running", sessionId: id,
      worktreePath: null }));
    registry.bindTaskToWorkEpisode(taskId, id);
    const before = registry.workEpisodeForSession(id)!;
    const run = { ...LADDER_SUMMARY, id: `workflow-${id}`, sessionId: id,
      status: "waiting_for_action" as const, phase: "session_action" };
    registry.upsertWorkflowRun(run);
    registry.reconcilePrs(new Map([[id, prMatch({ state: "merged", agentSessionId: `native-${status}`,
      episodeId: before.episodeId, createdAt: before.startedAt })]]), new Set());
    // The driver acknowledges work and its eventual completion without manufacturing hooks.
    registry.applyDriverEvent(id, { kind: "state", state: "working", activity: "Nothing remains to publish" });
    registry.applyDriverEvent(id, { kind: "state", state: "idle", activity: null });
    const after = registry.recordedWorkEpisodeForSession(id)!;
    assert.equal(after.episodeId, before.episodeId, "driver state alone does not roll the episode");
    assert.equal(after.promptedAt, null);
    assert.equal(registry.getTask(taskId)?.status, "running", "the live workflow still owns the session");
    registry.upsertWorkflowRun({ ...run, status, phase: "done" });
    assert.equal(registry.getTask(taskId)?.status, "done",
      "the current merged episode uses ordinary settlement without a rolled-over receipt");
    await tasks.stop();
  });
}
