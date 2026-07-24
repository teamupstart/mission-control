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
 * A task whose work SHIPPED has to end as `done`, not as `failed`.
 *
 * Nothing used to end a task on merge at all - `maybeMerge` retires its own ledger row
 * and returns, and no poller touched the task - so a shipped task sat `running` until
 * its agent went away and then settled as `failed`, "ended with no outcome recorded".
 * That is wrong twice: the outcome exists (it is the pull request), and `failed` reports
 * as a `stopped` blocker, so every task declared to wait on it deadlocks behind work that
 * actually landed.
 *
 * The interesting part is WHEN it may be concluded, and the first design got it wrong in
 * a way that looked right. Completing when the merge is observed - or a fixed delay
 * afterwards - treats a timeout as proof the episode ended. It is not: an agent routinely
 * lands an intermediate pull request and carries on, and an operator can merge, read the
 * diff for a minute, and only then tell the agent to continue. Any fixed window is
 * outrunnable, and the task is already terminal when the prompt arrives.
 *
 * So the conclusion is drawn at a boundary a later prompt CANNOT outrun - the agent
 * actually going away - and the merge is read from the durable binding row rather than
 * from a clock. While an agent is still being given work it is still here, so nothing
 * concludes anything; once it is gone, no prompt is coming.
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

/** A session with a running task bound to its current work episode. */
function fleet(id: string) {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
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

test("a merge does NOT complete the task while its agent is still here", () => {
  // The heart of the Inspector's finding. The agent may have landed an intermediate pull
  // request and be about to be told to carry on; nothing observable at merge time can
  // rule that out, so the merge alone must not be terminal.
  setShippingConfig({ closeSessionAfterMerge: false });
  const f = fleet("s-alive");
  merge(f);
  assert.equal(f.registry.getTask(f.taskId)?.status, "running");
});

test("an agent prompted long after its merge still owns a running task", () => {
  setShippingConfig({ closeSessionAfterMerge: false });
  const f = fleet("s-late-prompt");
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
  const f = fleet("s-rolled");
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
