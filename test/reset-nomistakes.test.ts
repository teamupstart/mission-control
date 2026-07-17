import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitIn, mkCloneOnBranch, mkLinkedWorktree } from "./helpers/git-fixture.ts";

// Isolate the daemon's state dir (token + sqlite) BEFORE anything reads config.
process.env.MISSION_HOME = mkdtempSync(join(tmpdir(), "mission-reset-nm-"));

const { openDb } = await import("../src/server/db.ts");
const { ensureToken } = await import("../src/server/auth.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { buildApp } = await import("../src/server/routes.ts");
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { NmRunSummary, Session } from "../src/shared/types.ts";

openDb();
const TOKEN = ensureToken();
const LOOPBACK = { host: "127.0.0.1:7317" };
const authed = { ...LOOPBACK, "content-type": "application/json", "x-harness-token": TOKEN };

const registry = new Registry();
const app = buildApp(
  registry,
  new ReviewManager(registry),
  new TaskManager(registry),
  new QueueManager(registry),
);

/** A clone on `branch` with the local work a finished run would have validated. */
const mkClone = (branch: string): string => mkCloneOnBranch("harness-reset-nm-", branch);

/**
 * A session on `branch` in the checkout at `cwd`. `gitRoot` is what discovery
 * resolves from `cwd`; it defaults to `cwd` (the session sits at the worktree
 * top) and is passed explicitly when a session drives a run in another worktree.
 */
function mkDisco(
  id: string,
  cwd: string,
  branch: string,
  extra: Partial<DiscoveredSession> = {},
): DiscoveredSession {
  return {
    syntheticId: id,
    agent: "claude",
    name: "work",
    nameSource: "tmux",
    cwd,
    gitBranch: branch,
    gitRoot: cwd,
    repoRoot: cwd,
    nomistakesGated: true,
    pid: 4242,
    tty: "ttys003",
    wezterm: null,
    tmux: null, // no pane -> the reset's best-effort `/clear` is a no-op
    startedAt: 0,
    ...extra,
  };
}

/** Seed a single discovered session on `branch`, checked out at `cwd`. */
function seedSession(id: string, cwd: string, branch: string): void {
  registry.applyDiscovery([mkDisco(id, cwd, branch)]);
}

/** A finished run on `branch` - what `axi status` keeps reporting after a merge. */
function finishedRun(branch: string, id = "01RUN_FINISHED"): NmRunSummary {
  return {
    id,
    status: "completed",
    branch,
    startedAt: null,
    endedAt: null,
    awaitingAgent: null,
    findingsSummary: null,
    gateStep: null,
    gateSummary: null,
    gateRisk: null,
    steps: [{ step: "review", status: "completed", findings: 0 }],
    activeSteps: [],
    findings: [],
    outcome: "passed",
  };
}

async function card(id: string): Promise<Session> {
  const res = await app.request("/api/sessions", { headers: LOOPBACK });
  const all = (await res.json()) as Session[];
  const s = all.find((x) => x.id === id);
  assert.ok(s, `session ${id} is on the dashboard`);
  return s;
}

test("reset clears the no-mistakes strip, and the poller cannot bring it back", async () => {
  const branch = "mancej/feature";
  const clone = mkClone(branch);
  seedSession("s1", clone, branch);

  // The run finished and its PR merged, but `axi status` still reports it, so the
  // card is decorated. This is the state the user is looking at when they reset.
  registry.reconcileNomistakes([finishedRun(branch)]);
  registry.applyNomistakesNarration("s1", "wrapping up");
  assert.equal((await card("s1")).nomistakes?.outcome, "passed");

  const res = await app.request("/api/sessions/s1/reset", {
    method: "POST",
    headers: authed,
    body: JSON.stringify({ clear: false }),
  });
  assert.equal(res.status, 200);

  // The card is clean the moment the reset lands.
  const afterReset = await card("s1");
  assert.equal(afterReset.nomistakes, null, "strip is gone right after the reset");
  assert.equal(afterReset.nomistakesNarration, null, "narration goes with its run");

  // The reset released the branch, so the checkout is detached - but the session's
  // RECORDED branch still reads `mancej/feature` until the next discovery sweep,
  // and `axi status` keeps reporting the same run for that branch regardless of
  // what any checkout holds. A poll in that window is what used to re-decorate the
  // card ~5s later, so the dismissal - not the detach - is what has to hold here.
  assert.equal(gitIn(clone, "branch", "--show-current"), "", "the reset released the branch");
  registry.reconcileNomistakes([finishedRun(branch)]);
  assert.equal((await card("s1")).nomistakes, null, "the poller must not resurrect it");
});

test("a dismissal is scoped to the run it retired, not to the branch", async () => {
  const branch = "mancej/second";
  const clone = mkClone(branch);
  seedSession("s2", clone, branch);

  registry.reconcileNomistakes([finishedRun(branch, "01RUN_OLD")]);
  const res = await app.request("/api/sessions/s2/reset", {
    method: "POST",
    headers: authed,
    body: JSON.stringify({ clear: false }),
  });
  assert.equal(res.status, 200);
  assert.equal((await card("s2")).nomistakes, null);

  // A brand-new run on the same branch is a different run - it must still show,
  // or resetting once would gag the card forever.
  registry.reconcileNomistakes([finishedRun(branch, "01RUN_NEW")]);
  assert.equal((await card("s2")).nomistakes?.id, "01RUN_NEW");
});

test("a sibling sharing the reset checkout loses its strip too", async () => {
  const branch = "mancej/shared";
  const clone = mkClone(branch);
  // Two agents cd'd into the SAME checkout on the same branch: both cards show the
  // run by exact-branch match, and one reset wipes the work behind both of them.
  registry.applyDiscovery([mkDisco("sh1", clone, branch), mkDisco("sh2", clone, branch, { pid: 4343 })]);
  registry.reconcileNomistakes([finishedRun(branch)]);
  assert.equal((await card("sh2")).nomistakes?.outcome, "passed");

  const res = await app.request("/api/sessions/sh1/reset", {
    method: "POST",
    headers: authed,
    body: JSON.stringify({ clear: false }),
  });
  assert.equal(res.status, 200);

  // The sibling's strip described the very work the reset threw away, so it goes
  // too - and the next poll must not bring either of them back.
  assert.equal((await card("sh1")).nomistakes, null, "the resetting session's strip is gone");
  assert.equal((await card("sh2")).nomistakes, null, "the sibling in the same checkout clears too");
  registry.reconcileNomistakes([finishedRun(branch)]);
  assert.equal((await card("sh1")).nomistakes, null, "the poller must not resurrect it");
  assert.equal((await card("sh2")).nomistakes, null, "nor the sibling's");
});

test("a run driven in another worktree survives a reset that never touched it", async () => {
  const mainBranch = "main";
  const runBranch = "mancej/auto-pilot";
  const clone = mkClone("mancej/lonely"); // the session's own checkout
  gitIn(clone, "checkout", "-q", mainBranch);
  const wt = mkLinkedWorktree(clone, runBranch, join(clone, "..", "wt-autopilot"));

  // The session sits in `clone` on main and drives a live, parked run over in
  // `wt-autopilot` - its card shows that run through the launcher binding.
  registry.applyDiscovery([
    mkDisco("drv", clone, mainBranch, { nomistakesRuns: [{ cwd: wt, branch: runBranch }] }),
  ]);
  const parked: NmRunSummary = {
    ...finishedRun(runBranch, "01RUN_LIVE"),
    status: "running",
    awaitingAgent: "parked 1m30s",
    gateStep: "review",
    outcome: null,
  };
  registry.reconcileNomistakes([parked]);
  assert.equal((await card("drv")).nomistakes?.id, "01RUN_LIVE");

  const res = await app.request("/api/sessions/drv/reset", {
    method: "POST",
    headers: authed,
    body: JSON.stringify({ clear: false }),
  });
  assert.equal(res.status, 200);

  // The reset only wiped `clone`; the run's worktree and its work are untouched,
  // so retiring it would strand a parked gate with no approve/fix/skip buttons.
  assert.equal(gitIn(wt, "rev-parse", "--abbrev-ref", "HEAD"), runBranch);
  assert.equal((await card("drv")).nomistakes?.id, "01RUN_LIVE", "the live run keeps its strip");
  registry.reconcileNomistakes([parked]);
  assert.equal((await card("drv")).nomistakes?.awaitingAgent, "parked 1m30s");
});

test("a retired run does not shadow a live run the session drives elsewhere", async () => {
  const own = "mancej/shadowed";
  const runBranch = "harness/dispatched";
  const clone = mkClone(own);
  seedSession("shadow", clone, own);

  registry.reconcileNomistakes([finishedRun(own, "01RUN_RETIRED")]);
  const res = await app.request("/api/sessions/shadow/reset", {
    method: "POST",
    headers: authed,
    body: JSON.stringify({ clear: false }),
  });
  assert.equal(res.status, 200);
  assert.equal((await card("shadow")).nomistakes, null);

  // Resetting and then dispatching fresh work is the natural next move. The new
  // run lands in its own worktree (a launcher binding), while the session itself
  // never left `own` - a reset keeps the branch name - so `axi status` goes on
  // reporting the retired run for the session's own branch indefinitely.
  const wt = mkLinkedWorktree(clone, runBranch, join(clone, "..", "wt-dispatched"));
  registry.applyDiscovery([
    mkDisco("shadow", clone, own, { nomistakesRuns: [{ cwd: wt, branch: runBranch }] }),
  ]);
  const parked: NmRunSummary = {
    ...finishedRun(runBranch, "01RUN_DISPATCHED"),
    status: "running",
    awaitingAgent: "parked 0m20s",
    gateStep: "review",
    outcome: null,
  };
  registry.reconcileNomistakes([finishedRun(own, "01RUN_RETIRED"), parked]);

  // The retired run wins the exact-branch match, so it must be skipped *during*
  // matching and fall through to the binding. Dropping it afterwards would blank
  // the card and strand the parked gate with no approve/fix/skip buttons.
  const shown = (await card("shadow")).nomistakes;
  assert.equal(shown?.id, "01RUN_DISPATCHED", "the live run the session drives is shown");
  assert.equal(shown?.awaitingAgent, "parked 0m20s", "its parked gate is still answerable");
});

test("a same-branch session in a different worktree keeps its strip", async () => {
  const branch = "mancej/twin";
  const a = mkClone(branch);
  const b = mkClone(branch); // an independent checkout that happens to share the branch name
  registry.applyDiscovery([mkDisco("twinA", a, branch), mkDisco("twinB", b, branch)]);
  registry.reconcileNomistakes([finishedRun(branch, "01RUN_TWIN")]);

  const res = await app.request("/api/sessions/twinA/reset", {
    method: "POST",
    headers: authed,
    body: JSON.stringify({ clear: false }),
  });
  assert.equal(res.status, 200);

  // Same branch name, but `reset --hard` only ever touches one worktree - twinB's
  // work is still on disk, so its strip still describes something real.
  assert.equal((await card("twinA")).nomistakes, null, "the reset checkout's strip is gone");
  assert.equal((await card("twinB")).nomistakes?.id, "01RUN_TWIN", "the untouched checkout keeps its strip");
  registry.reconcileNomistakes([finishedRun(branch, "01RUN_TWIN")]);
  assert.equal((await card("twinA")).nomistakes, null, "the poller must not resurrect it");
  assert.equal((await card("twinB")).nomistakes?.id, "01RUN_TWIN");
});

test("a run we cannot name is left alone rather than gagging every id-less run", async () => {
  const branch = "mancej/idless";
  const clone = mkClone(branch);
  seedSession("idless", clone, branch);
  // A no-mistakes that renames or drops `id:` parses to an empty id. Retiring ""
  // would match every later id-less run and gag the card for good - the exact
  // failure keying on the run id was meant to avoid, and it fails silently.
  registry.reconcileNomistakes([finishedRun(branch, "")]);
  assert.equal((await card("idless")).nomistakes?.outcome, "passed");

  const res = await app.request("/api/sessions/idless/reset", {
    method: "POST",
    headers: authed,
    body: JSON.stringify({ clear: false }),
  });
  assert.equal(res.status, 200);

  // So we degrade to the old behavior - the strip lingers - instead of over-suppressing.
  registry.reconcileNomistakes([finishedRun(branch, "")]);
  assert.equal((await card("idless")).nomistakes?.outcome, "passed", "an id-less run is never gagged");
});

test("a dismissal outlives the session that made it", async () => {
  const branch = "mancej/restart";
  const clone = mkClone(branch);
  seedSession("proc:ttys003:100:1", clone, branch);
  registry.reconcileNomistakes([finishedRun(branch, "01RUN_RESTART")]);

  const res = await app.request("/api/sessions/proc:ttys003:100:1/reset", {
    method: "POST",
    headers: authed,
    body: JSON.stringify({ clear: false }),
  });
  assert.equal(res.status, 200);
  assert.equal((await card("proc:ttys003:100:1")).nomistakes, null);

  // Quitting the agent and relaunching in the same pane is the natural companion
  // to "reset and start fresh" - and it mints a new synthetic id (tty+pid+start)
  // for what is, to the user, the same card in the same checkout on the same
  // branch. `axi status` still reports the merged run, so a dismissal that died
  // with the old session id would let the next poll re-decorate the new card.
  registry.applyDiscovery([]); // the old process is gone
  seedSession("proc:ttys003:200:2", clone, branch); // relaunched in the same pane
  registry.reconcileNomistakes([finishedRun(branch, "01RUN_RESTART")]);
  assert.equal(
    (await card("proc:ttys003:200:2")).nomistakes,
    null,
    "a restart must not resurrect the strip",
  );
});

test("a transient poll failure does not resurrect a dismissed strip", async () => {
  const branch = "mancej/flaky";
  const clone = mkClone(branch);
  seedSession("flaky", clone, branch);
  registry.reconcileNomistakes([finishedRun(branch, "01RUN_FLAKY")]);

  const res = await app.request("/api/sessions/flaky/reset", {
    method: "POST",
    headers: authed,
    body: JSON.stringify({ clear: false }),
  });
  assert.equal(res.status, 200);
  assert.equal((await card("flaky")).nomistakes, null);

  // `axi status` timing out (or the binary going missing) reconciles an EMPTY run
  // set. That observes nothing - it must not be read as "the run is gone" and
  // forget the dismissal, or the next good poll brings the strip straight back.
  registry.reconcileNomistakes([]);
  registry.reconcileNomistakes([finishedRun(branch, "01RUN_FLAKY")]);
  assert.equal((await card("flaky")).nomistakes, null, "a failed poll must not un-retire the run");
});

test("repeated resets on one checkout evict the oldest run, never the newest", async () => {
  const branch = "mancej/churn";
  const clone = mkClone(branch);
  seedSession("churn", clone, branch);

  // Far more resets on one checkout than the per-checkout cap keeps run ids for.
  // Eviction is what bounds the map, so it must drop the runs that can no longer
  // be reported (`axi status` only reports a branch's latest run) and never the
  // one the user just retired.
  for (let i = 0; i < 12; i++) {
    registry.reconcileNomistakes([finishedRun(branch, `01RUN_CHURN_${i}`)]);
    const res = await app.request("/api/sessions/churn/reset", {
      method: "POST",
      headers: authed,
      body: JSON.stringify({ clear: false }),
    });
    assert.equal(res.status, 200);
    assert.equal((await card("churn")).nomistakes, null, `reset ${i} clears the strip`);
  }

  registry.reconcileNomistakes([finishedRun(branch, "01RUN_CHURN_11")]);
  assert.equal((await card("churn")).nomistakes, null, "the newest retired run stays retired");
});

test("evicting checkouts drops the stalest, not the one just reset", async () => {
  const branch = "mancej/recent";
  const clone = mkClone(branch);
  seedSession("recent", clone, branch);
  const reset = async (): Promise<void> => {
    const res = await app.request("/api/sessions/recent/reset", {
      method: "POST",
      headers: authed,
      body: JSON.stringify({ clear: false }),
    });
    assert.equal(res.status, 200);
  };
  /** Another checkout retiring a run, without the cost of a real clone per entry. */
  const filler = (i: number): void =>
    registry.dismissNomistakes(
      finishedRun(`filler/${i}`, `01RUN_FILLER_${i}`),
      `/filler/${i}`,
      `filler/${i}`,
    );

  registry.reconcileNomistakes([finishedRun(branch, "01RUN_FIRST")]);
  await reset();
  // Fill the rest of the checkout cap (200) behind this one.
  for (let i = 0; i < 199; i++) filler(i);

  // A new run on the branch decorates the card again and the user resets again,
  // making this checkout the most recently retired of the 200.
  registry.reconcileNomistakes([finishedRun(branch, "01RUN_SECOND")]);
  await reset();
  assert.equal((await card("recent")).nomistakes, null);

  // One more checkout pushes past the cap. Eviction walks insertion order, so it
  // must rank this checkout by its latest reset, not its first: dropping it here
  // would let the very next poll bring back a strip cleared seconds ago.
  filler(199);
  registry.reconcileNomistakes([finishedRun(branch, "01RUN_SECOND")]);
  assert.equal(
    (await card("recent")).nomistakes,
    null,
    "the freshly reset checkout outlives 200 staler ones",
  );
});

test("a failed reset leaves the strip alone", async () => {
  const branch = "mancej/third";
  const notRepo = realpathSync(mkdtempSync(join(tmpdir(), "harness-reset-nm-norepo-")));
  seedSession("s3", notRepo, branch);
  registry.reconcileNomistakes([finishedRun(branch)]);

  const res = await app.request("/api/sessions/s3/reset", {
    method: "POST",
    headers: authed,
    body: JSON.stringify({ clear: false }),
  });
  assert.equal(res.status, 500); // not a git repository

  // The work (and the run that validated it) is still there, so the strip stays.
  assert.equal((await card("s3")).nomistakes?.outcome, "passed");
});
