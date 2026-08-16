import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask as baseTask } from "./helpers/session-fixture.ts";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { PrMatch } from "../src/server/registry.ts";
import type { Task, TaskRepoEntry } from "../src/shared/types.ts";
import { pullRequestUrlIn, pullRequestUrlsIn } from "../src/shared/pr-command.mjs";

// Discovering, adopting and showing one pull request per changed repository.
//
// What is at stake: a pull request nobody in the daemon ever hears about. A multi-repo agent
// opens one per repo it changed, and before this every one of them after the first was
// invisible - the sniffer returned the first url in a command's output, and the branch poller
// only ever asked `gh` about the session's own cwd. An invisible pull request is not merely
// undisplayed: it is unadopted (so the Inspector never reviews it) and uncounted (so the
// completion quorum in `multi-pr-quorum.test.ts` cannot wait for it).
//
// The two behaviours the per-repo review phase depends on are the ones pinned hardest here:
// multi-url sniffing, and the poller fanning out over every attached worktree.

const home = mkdtempSync(join(tmpdir(), "mission-multi-pr-tracking-"));
process.env.HARNESS_HOME = home;
const { Registry, SDK_SESSION_ID_PREFIX } = await import("../src/server/registry.ts");
const { pollAndReconcilePrs } = await import("../src/server/pr.ts");
const { getInspectorPr, openDb, primaryRepoPrForTask, taskReposFor, workEpisodeRepoPrsForTask } =
  await import("../src/server/db.ts");
const { adoptPr } = await import("../src/server/inspector/worker.ts");

after(() => rmSync(home, { recursive: true, force: true }));

const PR_A = "https://github.com/example/repo/pull/10";
const PR_B = "https://github.com/example/other/pull/20";
const PR_C = "https://github.com/example/other/pull/21";

// ---- sniffing ------------------------------------------------------------------------------

test("one command that opens two pull requests yields both urls", () => {
  // Exactly what `cd a && gh pr create && cd ../b && gh pr create` prints into one tool
  // response. The old reader stopped at the first line.
  const output = `Creating pull request...\n${PR_A}\nCreating pull request...\n${PR_B}\n`;
  assert.deepEqual(pullRequestUrlsIn(output), [PR_A, PR_B]);
  // The scalar keeps meaning what it meant - the one that decorates the card - and is now
  // defined in terms of the list so the two can never disagree about ordering.
  assert.equal(pullRequestUrlIn(output), PR_A);
});

test("the same pull request printed twice is one pull request", () => {
  assert.deepEqual(pullRequestUrlsIn(`${PR_A}\nsee ${PR_A} for details`), [PR_A]);
});

test("output with no pull request, and a non-string, are both simply none", () => {
  assert.deepEqual(pullRequestUrlsIn("nothing to see"), []);
  assert.deepEqual(pullRequestUrlsIn(undefined), []);
  assert.equal(pullRequestUrlIn("nothing to see"), null);
});

// ---- fixtures ------------------------------------------------------------------------------

const PRIMARY_BASE = "a".repeat(40);
const EXTRA_BASE = "b".repeat(40);

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

function entry(over: Partial<TaskRepoEntry>): TaskRepoEntry {
  return {
    repoRoot: "/other",
    worktreePath: null,
    branch: "feat/work",
    provider: "git",
    worktreeLeaseId: null,
    baseSha: EXTRA_BASE,
    prUrl: null,
    prState: null,
    mergedAt: null,
    ...over,
  };
}

/** A live multi-repo session, its task, and the worktrees the dispatch cut for it. */
function fixture(id: string, extras: string[] = ["/other"], over: Partial<Task> = {}) {
  const registry = new Registry();
  const taskId = `task-${id}`;
  const cwd = `/wt/${id}-0`;
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
    baseTask({
      id: taskId,
      title: "Rename the shared field",
      status: "running",
      sessionId: id,
      repoRoot: "/repo",
      worktreePath: cwd,
      branch: "feat/work",
      provider: "git",
      baseSha: PRIMARY_BASE,
      extraRepos: extras.map((repoRoot, index) =>
        entry({ repoRoot, worktreePath: `/wt/${id}-${index + 1}` }),
      ),
      ...over,
    }),
  );
  registry.bindTaskToWorkEpisode(taskId, id);
  const episode = registry.workEpisodeForSession(id)!;
  return { registry, id, taskId, cwd, episode };
}

type Fixture = ReturnType<typeof fixture>;

function repoMatch(f: Fixture, repoRoot: string, over: Partial<PrMatch> = {}): [string, PrMatch] {
  const target = f.registry
    .extraRepoPrPollTargets()
    .find((t) => t.taskId === f.taskId && t.repoRoot === repoRoot);
  assert.ok(target, `the attached repo ${repoRoot} is polled`);
  return [
    target.key,
    {
      url: PR_B,
      number: 20,
      state: "open",
      checks: null,
      branch: target.branch,
      agentSessionId: target.agentSessionId,
      episodeId: target.episodeId,
      createdAt: f.episode.startedAt,
      mergedAt: null,
      headSha: "extra-head",
      worktreeHeadSha: "extra-head",
      ...over,
    },
  ];
}

// ---- announcement --------------------------------------------------------------------------

test("every pull request one command opened is announced, not just the first", () => {
  const f = fixture("announce");
  const announced: string[] = [];
  f.registry.onPrOpened((e) => announced.push(e.url));

  f.registry.applyHook({
    agent: "claude",
    event: "PostToolUse",
    sessionId: "announce-episode",
    cwd: f.cwd,
    transcriptPath: null,
    env: {},
    toolName: "Bash",
    prCreated: true,
    prUrl: PR_A,
    prUrls: [PR_A, PR_B],
  });

  assert.deepEqual(announced, [PR_A, PR_B]);
  // And the card still shows ONE: `Session.prUrl` is the current-branch pull request, the
  // poller re-decides it every tick, and a multi-repo agent still has one branch at cwd.
  assert.equal(f.registry.getSession(f.id)?.prUrl, PR_A);
});

test("a hook installed before the list existed still announces its one", () => {
  // Hooks are written into ~/.claude/settings.json once and keep running with whatever they
  // were installed with, so the scalar fallback is a live path rather than a courtesy.
  const f = fixture("legacy-hook");
  const announced: string[] = [];
  f.registry.onPrOpened((e) => announced.push(e.url));

  f.registry.applyHook({
    agent: "claude",
    event: "PostToolUse",
    sessionId: "legacy-hook-episode",
    cwd: f.cwd,
    transcriptPath: null,
    env: {},
    toolName: "Bash",
    prCreated: true,
    prUrl: PR_A,
  });

  assert.deepEqual(announced, [PR_A]);
});

test("a driver that watched two pull requests open announces both", () => {
  const registry = new Registry();
  const sdkId = `${SDK_SESSION_ID_PREFIX}33333333-3333-4333-8333-333333333333`;
  registry.registerSdkSession({ id: sdkId, agent: "claude", name: "driver", cwd: "/wt/driver" });
  const announced: string[] = [];
  registry.onPrOpened((e) => announced.push(e.url));

  registry.applyDriverEvent(sdkId, { kind: "pr_created", urls: [PR_A, PR_B] });

  assert.deepEqual(announced, [PR_A, PR_B]);
  assert.equal(registry.getSession(sdkId)?.prUrl, PR_A);
});

// ---- poller fan-out ------------------------------------------------------------------------

test("the poller asks about every attached worktree, one gh call per checkout", async () => {
  const f = fixture("fanout", ["/other", "/third"]);
  const asked: Array<[string, string]> = [];
  await pollAndReconcilePrs(
    f.registry,
    async (cwd, branch) => {
      asked.push([cwd, branch]);
      return null;
    },
    async () => null,
    undefined,
    Date.now(),
    async () => null,
  );

  const mine = asked.filter(([cwd]) => cwd.startsWith("/wt/fanout"));
  assert.deepEqual(
    mine.sort(),
    [["/wt/fanout-0", "feat/work"], ["/wt/fanout-1", "feat/work"], ["/wt/fanout-2", "feat/work"]],
    "the primary and both attached worktrees, each asked once",
  );
});

test("a native attached checkout is polled on the branch the agent later created", () => {
  const f = fixture("native-live-branch");
  const checkout = join(home, "native-secondary");
  execFileSync("git", ["init", "-q", "-b", "feat/native-secondary", checkout]);
  const task = f.registry.getTask(f.taskId)!;
  f.registry.upsertTask({
    ...task,
    extraRepos: [entry({
      worktreePath: checkout,
      branch: null,
      provider: "mission",
      worktreeLeaseId: "lease-native-secondary",
    })],
  });

  const target = f.registry.extraRepoPrPollTargets().find((item) => item.taskId === f.taskId);
  assert.equal(target?.branch, "feat/native-secondary");
  assert.equal(
    f.registry.getTask(f.taskId)?.extraRepos[0]?.branch,
    null,
    "observing the later branch must not rewrite the acquisition record",
  );
});

test("a single-repo session contributes no attached-repo targets at all", () => {
  const f = fixture("single", []);
  assert.deepEqual(
    f.registry.extraRepoPrPollTargets().filter((t) => t.taskId === f.taskId),
    [],
  );
});

test("an attached repo with no provisioned worktree is not asked about", () => {
  // Before dispatch, or after teardown nulled it: there is no checkout for `gh` to resolve
  // the repository from, and asking in the primary's tree would answer for the wrong repo.
  const f = fixture("unprovisioned", []);
  const task = f.registry.getTask(f.taskId)!;
  f.registry.upsertTask({ ...task, extraRepos: [entry({ worktreePath: null })] });
  assert.deepEqual(
    f.registry.extraRepoPrPollTargets().filter((t) => t.taskId === f.taskId),
    [],
  );
});

// ---- per-repo acceptance -------------------------------------------------------------------

test("a pull request found in an attached worktree is recorded against that repo", () => {
  const f = fixture("accept");
  f.registry.reconcileRepoPrs(new Map([repoMatch(f, "/other")]), new Set());

  const rows = workEpisodeRepoPrsForTask(f.taskId);
  assert.deepEqual(
    rows.map((r) => [r.repoRoot, r.prUrl, r.prState, r.mergedAt]),
    [["/other", PR_B, "open", null]],
  );
  // And it reaches the wire, on the fields phase 1 reserved and left null.
  const task = f.registry.getTask(f.taskId)!;
  assert.deepEqual(
    task.extraRepos.map((e) => [e.repoRoot, e.prUrl, e.prState, e.mergedAt]),
    [["/other", PR_B, "open", null]],
  );
});

test("a SECOND, different pull request for the same repo is refused", () => {
  // The per-repo twin of the guard that refuses a second primary pull request on one episode.
  // Without it, an agent that opened a replacement pull request would silently move which one
  // the task is waiting on - and the first, which may already be reviewed, would stop counting.
  const f = fixture("refuse");
  f.registry.reconcileRepoPrs(new Map([repoMatch(f, "/other")]), new Set());
  f.registry.reconcileRepoPrs(
    new Map([repoMatch(f, "/other", { url: PR_C, number: 21 })]),
    new Set(),
  );

  assert.deepEqual(
    workEpisodeRepoPrsForTask(f.taskId).map((r) => r.prUrl),
    [PR_B],
    "the first association stands",
  );
});

test("one repo's pull request does not refuse another repo's", () => {
  // The whole point of keying the guard per repository rather than per episode.
  const f = fixture("two-repos", ["/other", "/third"]);
  f.registry.reconcileRepoPrs(new Map([repoMatch(f, "/other")]), new Set());
  f.registry.reconcileRepoPrs(
    new Map([repoMatch(f, "/third", { url: PR_C, number: 21 })]),
    new Set(),
  );

  assert.deepEqual(
    workEpisodeRepoPrsForTask(f.taskId)
      .map((r) => [r.repoRoot, r.prUrl])
      .sort(),
    [["/other", PR_B], ["/third", PR_C]],
  );
});

test("the same pull request observed again updates its state instead of being refused", () => {
  const f = fixture("restate");
  f.registry.reconcileRepoPrs(new Map([repoMatch(f, "/other")]), new Set());
  f.registry.reconcileRepoPrs(
    new Map([repoMatch(f, "/other", { state: "merged", mergedAt: 9_000 })]),
    new Set(),
  );

  const [row] = workEpisodeRepoPrsForTask(f.taskId);
  assert.equal(row?.prState, "merged");
  assert.equal(row?.mergedAt, 9_000);
  assert.equal(f.registry.getTask(f.taskId)?.extraRepos[0]?.mergedAt, 9_000);
});

test("a `gh` that errored on an attached repo changes nothing", () => {
  const f = fixture("skipped");
  const [key, match] = repoMatch(f, "/other");
  f.registry.reconcileRepoPrs(new Map([[key, match]]), new Set([key]));
  assert.deepEqual(workEpisodeRepoPrsForTask(f.taskId), []);
});

test("a pull request on a branch the entry does not name is not this repo's", () => {
  // The branch compared against is the ENTRY's, not the session's: a pooled secondary lease
  // can arrive on a different branch, which is exactly why the session's is the wrong one to
  // check - but a mismatch against the entry's own branch is still somebody else's work.
  const f = fixture("wrong-branch");
  f.registry.reconcileRepoPrs(
    new Map([repoMatch(f, "/other", { branch: "someone-else/work" })]),
    new Set(),
  );
  assert.deepEqual(workEpisodeRepoPrsForTask(f.taskId), []);
});

// ---- adoption ------------------------------------------------------------------------------

test("finding a pull request in an attached worktree corrects the checkout it was adopted against", () => {
  // Adoption is proof-grade and arrives from a hook that can only name the SESSION's repo -
  // which on a multi-repo task is the primary. Left there, the Inspector would review a
  // secondary repo's pull request against the primary's INSPECTOR.md and standards. The
  // poller found this pull request by asking `gh` inside one specific worktree, so the repo
  // it belongs to is measured rather than guessed.
  const f = fixture("adopt");
  assert.equal(adoptPr(PR_B, { sessionId: f.id, cwd: f.cwd, repoRoot: "/repo" }, "hook", 1), true);
  assert.equal(getInspectorPr("example/other#20")?.repoRoot, "/repo", "adopted against the primary");

  f.registry.reconcileRepoPrs(new Map([repoMatch(f, "/other")]), new Set());

  const row = getInspectorPr("example/other#20");
  assert.equal(row?.repoRoot, "/other");
  assert.equal(row?.cwd, "/wt/adopt-1");
});

// ---- the primary repo's own pull request ---------------------------------------------------

/** A rolled-off binding written straight to the store - what a rollover leaves behind. */
function insertHistorical(b: {
  taskId: string;
  episodeId: string;
  prUrl: string;
  mergedAt: number | null;
}): void {
  openDb()
    .prepare(
      `INSERT INTO historical_task_work_episode_bindings
         (task_id, episode_id, session_id, agent_session_id, branch, pr_url, pr_head_sha,
          merged_at, bound_at, updated_at)
       VALUES (?, ?, 'sess', 'agent', 'feat/old', ?, 'sha', ?, 1, 1)`,
    )
    .run(b.taskId, b.episodeId, b.prUrl, b.mergedAt);
}

test("a rolled-off episode's UNMERGED pull request is not the primary's current one", () => {
  // The window this is about: the agent opened a pull request, restarted onto a new branch,
  // and the poller has not yet found a pull request on that one. `acceptPrForEpisode` is
  // branch-based and will never re-attach the old one, so it is work the task walked away
  // from. Reporting it would name a pull request nobody is working on - and would tell the
  // completion quorum the task is waiting for a url that is never going to move.
  const f = fixture("rolled-off", []);
  insertHistorical({
    taskId: f.taskId,
    episodeId: "rolled-past-episode",
    prUrl: PR_A,
    mergedAt: null,
  });

  assert.deepEqual(primaryRepoPrForTask(f.taskId), {
    prUrl: null,
    prState: null,
    mergedAt: null,
  });
});

test("a rolled-off episode's MERGED pull request IS the primary's outcome", () => {
  // The other half, and why the two passes are asymmetric: a merge on an episode the task has
  // already rolled past is still what landed - the same rule `mergedPrFor` applies, and the
  // rule the durable-completion contract rests on.
  const f = fixture("rolled-off-merged", []);
  insertHistorical({
    taskId: f.taskId,
    episodeId: "merged-past-episode",
    prUrl: PR_A,
    mergedAt: 7_000,
  });

  assert.deepEqual(primaryRepoPrForTask(f.taskId), {
    prUrl: PR_A,
    prState: "merged",
    mergedAt: 7_000,
  });
});

test("the CURRENT episode's open pull request is shown when nothing has merged", () => {
  const f = fixture("current-open", []);
  f.registry.reconcilePrs(
    new Map([[f.id, {
      url: PR_A,
      number: 10,
      state: "open" as const,
      checks: null,
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

  assert.deepEqual(primaryRepoPrForTask(f.taskId), {
    prUrl: PR_A,
    prState: "open",
    mergedAt: null,
  });
});

// ---- an attached repo's own pull request, across episodes -----------------------------------

/** A `work_episode_prs` row from some OTHER episode - what a rollover leaves behind. */
function insertRepoPr(b: {
  taskId: string;
  episodeId: string;
  repoRoot: string;
  prUrl: string;
  mergedAt: number | null;
}): void {
  openDb()
    .prepare(
      `INSERT INTO work_episode_prs
         (episode_id, repo_root, session_id, task_id, pr_url, pr_state, pr_head_sha,
          merged_at, updated_at)
       VALUES (?, ?, 'sess', ?, ?, ?, 'sha', ?, 9)`,
    )
    .run(
      b.episodeId,
      b.repoRoot,
      b.taskId,
      b.prUrl,
      b.mergedAt === null ? "open" : "merged",
      b.mergedAt,
    );
}

test("an attached repo's pull request from a rolled-off episode is not its current one", () => {
  // The secondary twin of the primary's rule, and it has to be the same rule or the two halves
  // of one card disagree. Nothing prunes an old episode's row - deliberately, so a merge on a
  // rolled-off episode still counts - so an unmerged one would otherwise be reported for ever,
  // and the quorum would hold on a url that can never move.
  const f = fixture("repo-rolled-off");
  insertRepoPr({
    taskId: f.taskId,
    episodeId: "repo-rolled-past-episode",
    repoRoot: "/other",
    prUrl: PR_B,
    mergedAt: null,
  });

  assert.deepEqual(
    taskReposFor(f.taskId).map((e) => [e.repoRoot, e.prUrl, e.prState, e.mergedAt]),
    [["/other", null, null, null]],
  );
});

test("an attached repo's MERGED pull request still counts from a rolled-off episode", () => {
  const f = fixture("repo-rolled-off-merged");
  insertRepoPr({
    taskId: f.taskId,
    episodeId: "repo-merged-past-episode",
    repoRoot: "/other",
    prUrl: PR_B,
    mergedAt: 8_000,
  });

  assert.deepEqual(
    taskReposFor(f.taskId).map((e) => [e.prUrl, e.prState, e.mergedAt]),
    [[PR_B, "merged", 8_000]],
  );
});

test("a merge on any episode outranks the current episode's open pull request", () => {
  // Same precedence the primary keeps: what LANDED is the answer, wherever it landed.
  const f = fixture("repo-merged-outranks");
  f.registry.reconcileRepoPrs(new Map([repoMatch(f, "/other")]), new Set());
  insertRepoPr({
    taskId: f.taskId,
    episodeId: "repo-outranked-episode",
    repoRoot: "/other",
    prUrl: PR_C,
    mergedAt: 8_000,
  });

  assert.deepEqual(
    taskReposFor(f.taskId).map((e) => [e.prUrl, e.prState]),
    [[PR_C, "merged"]],
  );
});

// ---- the live per-repo observation the follow-through reads ----------------------------------
//
// The durable association above is never retracted once made, deliberately: a card and the
// completion quorum need it to survive the worktree. That is the wrong reading for anything
// that TYPES at the agent, which is what `TaskRepoPrSummary.feedback` is for - the per-repo
// twin of the `prChecks`/`inspector` scalars, retracted the moment a poll stops seeing an open
// pull request in that repository.

/** The per-repo lines on this session's card, by repo root. */
function repoPrLines(f: Fixture) {
  const summaries = f.registry.getSession(f.id)?.task?.repoPrs ?? [];
  return new Map(summaries.map((line) => [line.repoRoot, line]));
}

test("an attached repo's open pull request carries its own number and CI rollup", () => {
  const f = fixture("live-feedback");
  f.registry.reconcileRepoPrs(
    new Map([repoMatch(f, "/other", { checks: "failing" })]),
    new Set(),
  );

  const line = repoPrLines(f).get("/other");
  assert.equal(line?.prUrl, PR_B);
  assert.equal(line?.feedback?.prNumber, 20);
  assert.equal(line?.feedback?.prChecks, "failing");
});

test("a poll that stops seeing an open pull request retracts the feedback, not the record", () => {
  // What a closed-unmerged sibling looks like: `gh` answers "nothing on this branch". The
  // association must stand (something did open a pull request here) and the feedback must go,
  // because Foreman would otherwise go on nudging a pull request nobody can push to.
  const f = fixture("retract");
  f.registry.reconcileRepoPrs(new Map([repoMatch(f, "/other")]), new Set());
  assert.ok(repoPrLines(f).get("/other")?.feedback, "seen open");

  f.registry.reconcileRepoPrs(new Map(), new Set());
  const line = repoPrLines(f).get("/other");
  assert.equal(line?.feedback, null, "the poll answered: no open pull request here");
  assert.equal(line?.prUrl, PR_B, "the association it made is not retracted");
});

test("a `gh` that errored leaves the previous observation alone", () => {
  // `skip` is not an answer. Dropping the feedback on an error would silence the follow-through
  // for as long as `gh` is unhappy, which is precisely when a red CI matters.
  const f = fixture("live-skip");
  const [key, match] = repoMatch(f, "/other", { checks: "failing" });
  f.registry.reconcileRepoPrs(new Map([[key, match]]), new Set());
  f.registry.reconcileRepoPrs(new Map(), new Set([key]));

  assert.equal(repoPrLines(f).get("/other")?.feedback?.prChecks, "failing");
});

test("a merged pull request is no longer live feedback", () => {
  const f = fixture("live-merged");
  f.registry.reconcileRepoPrs(
    new Map([repoMatch(f, "/other", { state: "merged", mergedAt: 9_000 })]),
    new Set(),
  );
  const line = repoPrLines(f).get("/other");
  assert.equal(line?.feedback, null, "a merged pull request needs no follow-through");
  assert.equal(line?.mergedAt, 9_000);
});

test("one repo's observation says nothing about another's", () => {
  const f = fixture("live-two", ["/other", "/third"]);
  f.registry.reconcileRepoPrs(
    new Map([
      repoMatch(f, "/other", { checks: "failing" }),
      repoMatch(f, "/third", { url: PR_C, number: 21, checks: "passing" }),
    ]),
    new Set(),
  );
  const lines = repoPrLines(f);
  assert.equal(lines.get("/other")?.feedback?.prChecks, "failing");
  assert.equal(lines.get("/third")?.feedback?.prChecks, "passing");
  assert.equal(lines.get("/third")?.feedback?.prNumber, 21);
});

test("the Inspector's findings reach the repository they were left on", () => {
  const f = fixture("live-inspector");
  f.registry.reconcileRepoPrs(new Map([repoMatch(f, "/other")]), new Set());
  adoptPr(PR_B, { sessionId: f.id, cwd: "/wt/live-inspector-1", repoRoot: "/other" }, "hook", 1);
  f.registry.refreshInspections();

  const summary = repoPrLines(f).get("/other")?.feedback?.inspector;
  assert.equal(summary?.prKey, "example/other#20");
  assert.equal(summary?.postedOpen, 0);
});
