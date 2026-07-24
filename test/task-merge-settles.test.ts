import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask as baseTask } from "./helpers/session-fixture.ts";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { PrMatch } from "../src/server/registry.ts";

const home = mkdtempSync(join(tmpdir(), "mission-task-merge-settles-"));
process.env.HARNESS_HOME = home;
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
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
    nomistakesGated: false,
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
) {
  const registry = new Registry();
  const tasks = new TaskManager(registry, closeDeps);
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
    worktreePath: cwd,
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

test("an agent that rolled onto new work and then vanished fails, not lands", () => {
  // Deliberate, and the tempting alternative is wrong. A rollover means the agent was
  // given MORE work; vanishing mid-flight leaves that work unlanded, so reporting the
  // earlier merge as this task's outcome would claim a success for something that never
  // finished. Only the episode the agent was actually on may conclude the task, which is
  // why `mergedPrFor` reads the current binding and not the historical ones.
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
  assert.equal(f.registry.getTask(f.taskId)?.status, "failed");
});

test("a task an operator already completed is not rewritten", () => {
  setShippingConfig({ closeSessionAfterMerge: false });
  const f = fleet("s-idempotent");
  f.tasks.complete(f.taskId, "done by hand");
  merge(f);
  agentGone(f);
  const t = f.registry.getTask(f.taskId)!;
  assert.equal(t.status, "done");
  assert.equal(t.outcome, "done by hand");
});

test("a cancelled task is left cancelled", () => {
  setShippingConfig({ closeSessionAfterMerge: false });
  const f = fleet("s-cancelled");
  const cur = f.registry.getTask(f.taskId)!;
  f.registry.upsertTask({ ...cur, status: "cancelled" });
  merge(f);
  agentGone(f);
  assert.equal(f.registry.getTask(f.taskId)?.status, "cancelled");
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

test("a HUMAN's completion is never reopened by the agent going busy again", () => {
  // The guard that keeps the above from overwriting somebody's recorded outcome. Only
  // conclusions this class drew from idleness are reversible; a human's is a statement
  // about the work, not an inference.
  setShippingConfig({ closeSessionAfterMerge: false });
  const f = fleet("s-human-done", true);
  f.tasks.complete(f.taskId, "shipped, and I say so");
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

test("a human completion supersedes an earlier reversible idle completion", () => {
  setShippingConfig({ closeSessionAfterMerge: false });
  const f = fleet("s-human-overrides-idle");
  merge(f);
  assert.equal(f.registry.getTask(f.taskId)?.status, "done");
  f.tasks.complete(f.taskId, "verified and completed by hand");
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
  // Idle again on a rolled-over episode with no merge of its own: it stays running,
  // which is `mergedPrFor`'s current-binding rule doing its job.
  assert.equal(f.registry.getTask(f.taskId)?.status, "running");
});
