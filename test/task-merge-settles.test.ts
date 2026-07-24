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
const { recordWorkEpisodePrompt } = await import("../src/server/db.ts");
const { ShippingConfigSchema } = await import("../src/shared/protocol.ts");

after(() => rmSync(home, { recursive: true, force: true }));

/**
 * A merged pull request has to END its task.
 *
 * Nothing did that. `maybeMerge` retires its own ledger row and returns; no poller
 * touched the task. So a shipped task sat `running` forever, and the cost was not
 * cosmetic - it compounded twice over. `activeAgentCount` counts that session against
 * `maxSessions`, and `agentIsFree` refuses an agent that still has a non-terminal task
 * bound to it, so a finished agent simultaneously occupied a fleet slot AND was
 * ineligible to be given anything. A fleet silts up at its ceiling with agents that are
 * done: observed as 9 active against a max of 7, two ready backlog items, nothing
 * launching.
 *
 * Two properties are pinned here, and the second is the one most likely to be broken by
 * someone tidying up later:
 *
 *  1. Settling is NOT gated on YOLO mode. The same stranded row happens when a human
 *     merges on GitHub, which is the commoner path, and `autoMerge` ships off - so a fix
 *     hung off `maybeMerge` would have covered almost nothing and shipped dark.
 *  2. It does NOT fire when the agent kept working. A merge of some intermediate pull
 *     request, followed by another prompt, is not the end of the task; the registry's own
 *     `rolledOver` answer is what separates the two, and this is what stops someone
 *     "simplifying" the guard away.
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
  // Zero delay: the ORDERING is what these tests are about, not the wall clock.
  const tasks = new TaskManager(registry, { mergeSettleMs: 0 });
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

/** Let the deferred settle (scheduled at 0ms here) run to completion. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

// ---- the settle itself -----------------------------------------------------------------

test("a merged pull request marks its task done, recording the PR as the outcome", async () => {
  setShippingConfig({ closeSessionAfterMerge: false });
  const f = fleet("s-settle");
  merge(f);
  await flush();
  const t = f.registry.getTask(f.taskId)!;
  assert.equal(t.status, "done");
  assert.equal(t.outcomeUrl, PR);
  assert.match(t.outcome ?? "", /merged/);
});

test("it settles with YOLO mode OFF - a human's merge strands a task just the same", async () => {
  // The property the whole design turns on. `autoMerge` defaults to false, so a fix
  // hung off `maybeMerge` would never have run for most merges.
  setShippingConfig({ autoMerge: false, closeSessionAfterMerge: false });
  const f = fleet("s-yolo-off");
  merge(f);
  await flush();
  assert.equal(f.registry.getTask(f.taskId)?.status, "done");
});

test("a task an operator already completed is not reopened by a late sweep", async () => {
  setShippingConfig({ closeSessionAfterMerge: false });
  const f = fleet("s-idempotent");
  f.tasks.complete(f.taskId, "done by hand");
  merge(f);
  await flush();
  const t = f.registry.getTask(f.taskId)!;
  assert.equal(t.status, "done");
  assert.equal(t.outcome, "done by hand");
});

test("a cancelled task is left cancelled", async () => {
  setShippingConfig({ closeSessionAfterMerge: false });
  const f = fleet("s-cancelled");
  const cur = f.registry.getTask(f.taskId)!;
  f.registry.upsertTask({ ...cur, status: "cancelled" });
  merge(f);
  await flush();
  assert.equal(f.registry.getTask(f.taskId)?.status, "cancelled");
});

// ---- the agent kept working ------------------------------------------------------------

test("a prompt recorded before the merge is seen keeps the task running", async () => {
  setShippingConfig({ closeSessionAfterMerge: false });
  const f = fleet("s-rollover");
  const episode = f.registry.workEpisodeForSession(f.id)!;
  const mergedAt = Date.now();
  recordWorkEpisodePrompt(f.id, episode.episodeId, mergedAt + 1000);
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
  await flush();
  assert.equal(f.registry.getTask(f.taskId)?.status, "running");
});

test("a prompt that arrives AFTER the merge was seen still keeps the task running", async () => {
  // The ordering that makes the delay necessary rather than merely tidy, and the one a
  // synchronous settle gets wrong: the poller sees the merge, and only then does the
  // agent get told to carry on. Nothing checkable at merge time can see that prompt, so
  // the answer has to be re-asked afterwards - which is what the episode id comparison
  // in `settleMergedTask` does. Pinned here because "simplifying" the wait away passes
  // every other test in this file.
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
  f.registry.applyHook({
    agent: "claude",
    event: "UserPromptSubmit",
    sessionId: `${f.id}-episode`,
    cwd: `/repo/${f.id}`,
    transcriptPath: null,
    env: {},
    prompt: "continue with the next change",
    ts: mergedAt + 1,
  });
  await flush();
  assert.notEqual(
    f.registry.workEpisodeForSession(f.id)?.episodeId,
    episode.episodeId,
    "the agent should have rolled onto a new work episode",
  );
  assert.equal(f.registry.getTask(f.taskId)?.status, "running");
});

// ---- the config only governs the AGENT --------------------------------------------------

test("closeSessionAfterMerge defaults off, and off still settles the task", () => {
  // "Off" must not read as "nothing happens": the completion is what makes the agent
  // reusable at all, and it is deliberately not behind this switch.
  assert.equal(ShippingConfigSchema.parse({}).closeSessionAfterMerge, false);
});
