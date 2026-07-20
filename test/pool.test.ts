import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LEASE_HOLDERS } from "../src/shared/harness-runtime.mjs";
import {
  parsePoolStatus,
  planReap,
  poolRepos,
  reapIntervalMs,
  reapPool,
  startPoolReaper,
  type PoolDeps,
  type PoolPins,
  type PoolTree,
} from "../src/server/pool.ts";
import type { Registry } from "../src/server/registry.ts";
import { stubRun } from "../src/server/util/exec.ts";
import { sleep } from "../src/server/util/timers.ts";
import { gitIn, mkOriginAndClone, mkLinkedWorktree } from "./helpers/git-fixture.ts";

/** What the harness is holding; nothing, unless a test says otherwise. */
function pins(over: Partial<PoolPins> = {}): PoolPins {
  return { sessionCwds: [], taskWorktrees: [], ...over };
}

// --- parsing ----------------------------------------------------------------

test("parsePoolStatus reads slot, state, holder, and expands ~ to an absolute path", () => {
  const trees = parsePoolStatus(
    [
      "1     leased       ~/.treehouse/repo-abc/1/repo  (held by nm-reset-fix)",
      "2     available    ~/.treehouse/repo-abc/2/repo",
      "3     in-use       /abs/path/repo-abc/3/repo",
    ].join("\n"),
  );
  assert.equal(trees.length, 3);
  assert.deepEqual(trees[0], {
    name: "1",
    state: "leased",
    path: join(homedir(), ".treehouse/repo-abc/1/repo"),
    holder: "nm-reset-fix",
    busy: false,
  });
  assert.equal(trees[1]!.state, "available");
  assert.equal(trees[1]!.holder, null);
  // An already-absolute path is left alone (root may be configured absolute).
  assert.equal(trees[2]!.path, "/abs/path/repo-abc/3/repo");
});

test("parsePoolStatus attributes an indented process list to the tree above it", () => {
  const trees = parsePoolStatus(
    [
      "7     leased       ~/t/7/repo  (held by mission-control)",
      "8     leased       ~/t/8/repo  (held by mission-control)",
      "                   claude (74975), node (75244), node (75258)",
      "9     leased       ~/t/9/repo  (held by mission-control)",
    ].join("\n"),
  );
  // Only 8 has processes under it - this is what separates a live agent's tree
  // from a leaked lease, since both report `leased`.
  assert.deepEqual(
    trees.map((t) => [t.name, t.busy]),
    [
      ["7", false],
      ["8", true],
      ["9", false],
    ],
  );
});

test("parsePoolStatus ignores trailing banners rather than reading them as trees", () => {
  const trees = parsePoolStatus(
    ["1     leased       ~/t/1/repo  (held by x)", "Shell cwd was reset to /some/where"].join("\n"),
  );
  assert.deepEqual(trees.map((t) => t.name), ["1"]);
});

test("parsePoolStatus reads every state the treehouse binary can print", () => {
  // Verbatim `treehouse status`, so the parser is pinned against real output rather
  // than against what we imagine it prints. `dirty` and `you're here` are states
  // `internal/pool.List.func1` renders that a healthy pool simply doesn't show:
  // before they were listed, each slot fell through the regex and vanished from the
  // plan entirely - neither reaped nor skipped, which `ReapResult` promises not to do.
  const trees = parsePoolStatus(
    [
      "1     leased       ~/.treehouse/ai-harness-c7356c/1/ai-harness  (held by mission-control)",
      "                   2.1.210 (25528), zsh (25545), node (25834)",
      "2     you're here  ~/.treehouse/ai-harness-c7356c/2/ai-harness",
      "3     available    ~/.treehouse/ai-harness-c7356c/3/ai-harness",
      "5     leased       ~/.treehouse/ai-harness-c7356c/5/ai-harness  (held by ai-harness)",
      "13    dirty        ~/.treehouse/ai-harness-c7356c/13/ai-harness",
      "15    in-use       ~/.treehouse/ai-harness-c7356c/15/ai-harness",
      "                   claude (88322), node (88493)",
    ].join("\n"),
  );
  assert.deepEqual(
    trees.map((t) => [t.name, t.state, t.holder, t.busy]),
    [
      ["1", "leased", "mission-control", true],
      // The state column, not a suffix: treehouse stamps it on whichever tree the
      // caller stands in, masking that tree's real state. Note the space in it.
      ["2", "you're here", null, false],
      ["3", "available", null, false],
      ["5", "leased", "ai-harness", false],
      ["13", "dirty", null, false],
      ["15", "in-use", null, true],
    ],
  );
});

test("parsePoolStatus never hangs an unreadable tree's process list on the tree above it", () => {
  // A state treehouse grows later parses as nothing - fine, an unparsed tree is
  // never a candidate. What must NOT happen is its process list drifting up onto the
  // previous slot: that would report tree 12 as "processes are still running in it"
  // on the strength of processes running in 13, a false reason on a real decision.
  const trees = parsePoolStatus(
    [
      "12    leased       ~/t/12/repo  (held by mission-control)",
      "13    quarantined  ~/t/13/repo",
      "                   claude (99001), node (99002)",
    ].join("\n"),
  );
  assert.deepEqual(trees.map((t) => t.name), ["12"], "the unknown state is not invented into a tree");
  assert.equal(trees[0]!.busy, false, "13's processes are 13's, and 13 was never parsed");
});

// --- the safety gate --------------------------------------------------------

/** A pool tree record over a real worktree path. */
function tree(path: string, over: Partial<PoolTree> = {}): PoolTree {
  return { name: "1", state: "leased", path, holder: "mission-control", busy: false, ...over };
}

/** A repo plus a linked worktree that is clean and fully merged into origin/main. */
function mkIdleTree(branch = "wt"): { clone: string; wt: string } {
  const { clone } = mkOriginAndClone("harness-pool-");
  const wt = mkLinkedWorktree(clone, branch, join(clone, "..", `tree-${branch}`));
  return { clone, wt };
}

/**
 * A clone that opted into treehouse, with the opt-in landed on ORIGIN - a
 * clone-only commit would leave every worktree branched off it carrying a commit
 * origin has never seen, and the gate would (correctly) refuse to reap any of them.
 */
function mkPoolRepo(prefix: string): string {
  const { origin, clone } = mkOriginAndClone(prefix);
  writeFileSync(join(origin, "treehouse.toml"), "max_trees = 16\n");
  gitIn(origin, "add", "-A");
  gitIn(origin, "commit", "-qm", "opt into treehouse");
  gitIn(clone, "fetch", "-q", "origin");
  gitIn(clone, "reset", "-q", "--hard", "origin/main");
  return clone;
}

test("planReap reclaims a leased tree that is idle, clean, and already in origin", async () => {
  const { wt } = mkIdleTree();
  const [c] = await planReap([tree(wt)], pins());
  assert.equal(c!.skip, null, "a clean, merged, idle lease is exactly the leak we collect");
});

test("planReap spares a BUSY tree even though it is clean and merged", async () => {
  // The load-bearing case: an agent that has just pushed sits in a tree that is
  // clean AND merged, so the git checks alone would happily reap it out from
  // under a live session. Only the process list saves it.
  const { wt } = mkIdleTree();
  const [c] = await planReap([tree(wt, { busy: true })], pins());
  assert.equal(c!.skip, "processes are still running in it");
});

test("planReap spares a tree a live session stands in, including from a nested subdir", async () => {
  const { wt } = mkIdleTree();
  // Discovery reports a pane's cwd, which may be nested well below the worktree
  // top - that still pins the tree.
  const [c] = await planReap([tree(wt)], pins({ sessionCwds: [join(wt, "packages", "app")] }));
  assert.equal(c!.skip, "a live session is standing in it");
});

test("planReap matches a live session's cwd through a symlinked tree path", async () => {
  // treehouse prints whatever `root` is configured as, while a session's cwd comes
  // from the kernel and is always physical. Compare them raw and the liveness rung
  // silently never fires - leaving `busy` as the only thing between a live agent
  // and a forced return.
  const { wt } = mkIdleTree("symlinked");
  const link = join(dirname(wt), "link-to-tree");
  symlinkSync(wt, link);
  const [c] = await planReap([tree(link)], pins({ sessionCwds: [wt] }));
  assert.equal(c!.skip, "a live session is standing in it");
});

test("planReap spares a tree a task still holds, though it is idle, clean, and merged", async () => {
  // A task deliberately keeps its tree once its agent exits (a mid-flight complete
  // must not discard work), so no process and no session speaks for it - it looks
  // exactly like the leak we collect. Only the task record saves it.
  const { wt } = mkIdleTree("task-held");
  const [c] = await planReap([tree(wt)], pins({ taskWorktrees: [wt] }));
  assert.equal(c!.skip, "a task still holds it");
});

test("planReap spares another holder's lease, idle and clean and merged though it is", async () => {
  // Someone else's reservation, and it looks exactly like our leak: treehouse keeps
  // a lease "even with no process running inside it, until you release it", so idle
  // is what a reservation IS, not evidence it was abandoned. We can only claim to
  // know a holder is gone for leases we took, and the sweep now walks every pool in
  // the workspace - including repos this app has never dispatched into.
  const { wt } = mkIdleTree("other-holder");
  const [c] = await planReap([tree(wt, { holder: "release-prep" })], pins());
  assert.match(c!.skip!, /^it is leased to release-prep; we only return our own leases/);
});

test("planReap's foreign-holder reason names what it WILL return, not just what it won't", async () => {
  // The gate returns leases under any name this app has used, so a reason claiming it
  // only returns `mission-control` ones would be a lie to whoever reads the log.
  const { wt } = mkIdleTree("reason");
  const [c] = await planReap([tree(wt, { holder: "release-prep" })], pins());
  for (const name of LEASE_HOLDERS) assert.match(c!.skip!, new RegExp(name));
  assert.doesNotMatch(c!.skip!, /not this harness/);
});

test("planReap reclaims a lease stamped with a name this app used to go by", async () => {
  // The rename migration, encoded. A lease records its holder forever and is never
  // restamped, so every lease taken before a rename reads the old name - and a gate
  // that knew only the current one refused them all, silently and permanently. That
  // is not a hypothesis: `ai-harness` leases were written off as "a one-time
  // migration, deliberately not encoded here" and one is STILL stranded in the live
  // pool; the rename to `mission-control` would have stranded six `fleet-control`
  // leases the same way.
  // These names were us, and the gate's real question is whether we took the lease.
  for (const holder of ["mission-control", "ai-harness"]) {
    const { wt } = mkIdleTree(`was-${holder}`);
    const [c] = await planReap([tree(wt, { holder })], pins());
    assert.equal(c!.skip, null, `a lease under our old name ${holder} is ours to collect`);
  }
});

test("an old name is reclaimable, not exempt from every other check", async () => {
  // Widening the holder check must not widen anything else: a former name gets a
  // lease PAST the first gate, no further. `treehouse return` kills processes and
  // resets the tree, so the protections after the holder still decide.
  const { wt } = mkIdleTree("old-but-busy");
  const [c] = await planReap([tree(wt, { holder: "ai-harness", busy: true })], pins());
  assert.equal(c!.skip, "processes are still running in it");
});

test("planReap spares a lease with no recorded holder rather than assuming it is ours", async () => {
  // Fail closed, like every other uncertainty in the gate: an absent holder is not
  // proof of ownership, and ownership is what licenses the return.
  const { wt } = mkIdleTree("no-holder");
  const [c] = await planReap([tree(wt, { holder: null })], pins());
  assert.equal(c!.skip, "its lease records no holder");
});

test("planReap spares a tree with uncommitted changes", async () => {
  const { wt } = mkIdleTree();
  writeFileSync(join(wt, "keep.txt"), "base\nwork in progress\n");
  const [c] = await planReap([tree(wt)], pins());
  assert.equal(c!.skip, "it has uncommitted changes", "`treehouse return` would reset this away");
});

test("planReap spares a tree holding commits origin has never seen", async () => {
  const { wt } = mkIdleTree();
  writeFileSync(join(wt, "keep.txt"), "base\nunpushed\n");
  gitIn(wt, "commit", "-qam", "unpushed work");
  const [c] = await planReap([tree(wt)], pins());
  assert.equal(c!.skip, "it has commits origin/main doesn't have");
});

test("planReap spares an untracked-file-only tree (clean checkout, real scratch work)", async () => {
  const { wt } = mkIdleTree();
  writeFileSync(join(wt, "scratch.txt"), "notes\n");
  const [c] = await planReap([tree(wt)], pins());
  assert.equal(c!.skip, "it has uncommitted changes");
});

test("planReap leaves available and in-use trees alone", async () => {
  const { wt } = mkIdleTree();
  const plan = await planReap([tree(wt, { state: "available" }), tree(wt, { state: "in-use" })], pins());
  assert.deepEqual(plan.map((c) => c.skip), ["it is available", "it is in-use"]);
});

test("planReap spares a tree whose directory has gone missing", async () => {
  const [c] = await planReap([tree("/definitely/not/a/worktree")], pins());
  assert.equal(c!.skip, "the worktree is missing");
});

// --- reapPool ---------------------------------------------------------------

/** Fake treehouse: canned `status`, and a log of every `return` we asked for. */
function fakeDeps(status: string): { deps: PoolDeps; returned: string[] } {
  const returned: string[] = [];
  return {
    returned,
    deps: {
      status: async () => (stubRun({ stdout: status, stderr: "", code: 0 })),
      returnTree: async (_root, path) => {
        returned.push(path);
        return stubRun({ stdout: "", stderr: "", code: 0 });
      },
    },
  };
}

test("reapPool returns only the reclaimable leases and leaves live/dirty ones held", async () => {
  const clone = mkPoolRepo("harness-pool-e2e-");

  const idle = mkLinkedWorktree(clone, "idle", join(clone, "..", "t-idle"));
  const busy = mkLinkedWorktree(clone, "busy", join(clone, "..", "t-busy"));
  const dirty = mkLinkedWorktree(clone, "dirty", join(clone, "..", "t-dirty"));
  const live = mkLinkedWorktree(clone, "live", join(clone, "..", "t-live"));
  writeFileSync(join(dirty, "keep.txt"), "base\nuncommitted\n");

  const { deps, returned } = fakeDeps(
    [
      `1     leased       ${idle}  (held by mission-control)`,
      `2     leased       ${busy}  (held by mission-control)`,
      "                   claude (999)",
      `3     leased       ${dirty}  (held by mission-control)`,
      `4     leased       ${live}  (held by mission-control)`,
    ].join("\n"),
  );

  const r = await reapPool(clone, () => pins({ sessionCwds: [live] }), deps);

  assert.deepEqual(returned, [idle], "only the idle, clean, merged tree goes back to the pool");
  assert.deepEqual(r.reaped.map((t) => t.name), ["1"]);
  assert.deepEqual(
    r.skipped.map((c) => [c.tree.name, c.skip]),
    [
      ["2", "processes are still running in it"],
      ["3", "it has uncommitted changes"],
      ["4", "a live session is standing in it"],
    ],
  );
});

test("reapPool still reports every tree when none is even plausibly idle", async () => {
  // The healthy pool: nothing to reap, so this must stay cheap (no fetch, no
  // per-tree git) while still explaining every slot.
  const clone = mkPoolRepo("harness-pool-healthy-");
  const busy = mkLinkedWorktree(clone, "busy", join(clone, "..", "h-busy"));
  const { deps, returned } = fakeDeps(
    [
      `1     available    ${busy}`,
      `2     leased       ${busy}  (held by mission-control)`,
      "                   claude (999)",
    ].join("\n"),
  );
  const r = await reapPool(clone, () => pins(), deps);
  assert.deepEqual(returned, []);
  assert.deepEqual(
    r.skipped.map((c) => [c.tree.name, c.skip]),
    [
      ["1", "it is available"],
      ["2", "processes are still running in it"],
    ],
  );
});

test("reapPool leaves a task's worktree leased rather than handing it to the next agent", async () => {
  // The whole failure this guards: reaping a done-with-worktree task's tree both
  // discards the work Mark done promised to keep AND leaves the task pointing at a
  // path the pool can re-lease, so its later teardown returns someone else's tree.
  const clone = mkPoolRepo("harness-pool-task-");
  const held = mkLinkedWorktree(clone, "held", join(clone, "..", "k-held"));
  const { deps, returned } = fakeDeps(`1     leased       ${held}  (held by mission-control)`);

  const r = await reapPool(clone, () => pins({ taskWorktrees: [held] }), deps);

  assert.deepEqual(returned, [], "no process, no session, clean and merged - and still not ours to take");
  assert.deepEqual(r.reaped, []);
  assert.deepEqual(r.skipped.map((c) => c.skip), ["a task still holds it"]);
});

test("reapPool collects its own leases and leaves every other holder's reservation standing", async () => {
  // The blast radius the workspace scan opened up: the sweep now walks pools this
  // harness has no relationship with, where `treehouse get --lease --lease-holder
  // release-prep` is someone deliberately holding a tree for tomorrow. Nothing in
  // treehouse defends it - `return` takes a path and checks no holder - so this rung
  // is the only thing standing between that reservation and a forced return.
  const clone = mkPoolRepo("harness-pool-holder-");
  const ours = mkLinkedWorktree(clone, "ours", join(clone, "..", "h-ours"));
  const theirs = mkLinkedWorktree(clone, "theirs", join(clone, "..", "h-theirs"));
  const anon = mkLinkedWorktree(clone, "anon", join(clone, "..", "h-anon"));

  const { deps, returned } = fakeDeps(
    [
      `1     leased       ${ours}  (held by mission-control)`,
      `2     leased       ${theirs}  (held by release-prep)`,
      `3     leased       ${anon}`,
    ].join("\n"),
  );

  const r = await reapPool(clone, () => pins(), deps);

  assert.deepEqual(returned, [ours], "idle, clean and merged all three - only one is ours");
  assert.deepEqual(r.reaped.map((t) => t.name), ["1"]);
  // Which slots are skipped and why - matched on the stable half of the reason, since
  // the holder list it names is `LEASE_HOLDERS` and grows by one on every rename.
  assert.deepEqual(r.skipped.map((c) => c.tree.name), ["2", "3"]);
  assert.match(r.skipped[0]!.skip!, /^it is leased to release-prep; we only return our own leases/);
  assert.equal(r.skipped[1]!.skip, "its lease records no holder");
});

test("reapPool accounts for a dirty slot instead of dropping it out of the plan", async () => {
  // `skipped` is documented as every tree we considered and declined, and it is the
  // module's only observability. A dirty slot used to fall through the parser, so it
  // appeared in neither list: the pool looked one tree smaller than it is.
  const clone = mkPoolRepo("harness-pool-dirty-");
  const ours = mkLinkedWorktree(clone, "ours", join(clone, "..", "d-ours"));
  const grubby = mkLinkedWorktree(clone, "grubby", join(clone, "..", "d-grubby"));

  const { deps, returned } = fakeDeps(
    [`1     leased       ${ours}  (held by mission-control)`, `2     dirty        ${grubby}`].join(
      "\n",
    ),
  );

  const r = await reapPool(clone, () => pins(), deps);

  assert.deepEqual(returned, [ours], "a dirty tree is treehouse's to clean, not ours to reclaim");
  assert.deepEqual(r.skipped.map((c) => [c.tree.name, c.skip]), [["2", "it is dirty"]]);
});

test("reapPool does nothing in a repo that never opted into treehouse", async () => {
  const { clone } = mkOriginAndClone("harness-pool-nontree-");
  const { deps, returned } = fakeDeps(`1     leased       ${clone}  (held by x)`);
  const r = await reapPool(clone, () => pins(), deps);
  assert.deepEqual(returned, []);
  assert.deepEqual(r, { reaped: [], skipped: [] });
});

test("reapPool reports a failed return as a skip instead of claiming the slot is free", async () => {
  const clone = mkPoolRepo("harness-pool-fail-");
  const idle = mkLinkedWorktree(clone, "idle", join(clone, "..", "f-idle"));

  const deps: PoolDeps = {
    status: async () =>
      stubRun({
        stdout: `1     leased       ${idle}  (held by mission-control)`,
        stderr: "",
        code: 0,
      }),
    returnTree: async () => stubRun({ stdout: "", stderr: "lease is held elsewhere", code: 1 }),
  };
  const r = await reapPool(clone, () => pins(), deps);
  assert.deepEqual(r.reaped, []);
  assert.deepEqual(r.skipped.map((c) => c.skip), ["treehouse return failed: lease is held elsewhere"]);
});

// --- the fetch window -------------------------------------------------------

/**
 * Fake treehouse whose `status` answers differently per call, so a test can move
 * the world underneath a reap the way the fetch really does. The last entry
 * repeats, so a one-status script pins "nothing changed".
 */
function scriptedDeps(...statuses: string[]): { deps: PoolDeps; returned: string[] } {
  const returned: string[] = [];
  let call = 0;
  return {
    returned,
    deps: {
      status: async () =>
        stubRun({
          stdout: statuses[Math.min(call++, statuses.length - 1)]!,
          stderr: "",
          code: 0,
        }),
      returnTree: async (_root, path) => {
        returned.push(path);
        return stubRun({ stdout: "", stderr: "", code: 0 });
      },
    },
  };
}

test("reapPool spares a tree that came alive while it was fetching", async () => {
  // The gate ran against a reading the fetch has since left up to 30s stale. A
  // tree `make session` leased a moment before we looked has no processes yet, so
  // it read as a leak - and 30s is plenty for its agent to start. Only evidence
  // re-read at the moment of the return sees that.
  const clone = mkPoolRepo("harness-pool-race-busy-");
  const idle = mkLinkedWorktree(clone, "idle", join(clone, "..", "r-busy"));
  const leased = `1     leased       ${idle}  (held by mission-control)`;
  const { deps, returned } = scriptedDeps(leased, [leased, "                   claude (999)"].join("\n"));

  const r = await reapPool(clone, () => pins(), deps);

  assert.deepEqual(returned, [], "clean and merged, and now running an agent - not ours to take");
  assert.deepEqual(r.reaped, []);
  assert.deepEqual(r.skipped.map((c) => c.skip), ["processes are still running in it"]);
});

test("reapPool spares a tree a session appeared in while it was fetching", async () => {
  // The other half of the same window: discovery only polls every ~1.5s, so a
  // freshly leased tree has no session to speak for it at the instant we judge -
  // which is why the pins are a callback and not a snapshot.
  const clone = mkPoolRepo("harness-pool-race-pin-");
  const idle = mkLinkedWorktree(clone, "idle", join(clone, "..", "r-pin"));
  const { deps, returned } = scriptedDeps(`1     leased       ${idle}  (held by mission-control)`);

  let reads = 0;
  const r = await reapPool(clone, () => (reads++ === 0 ? pins() : pins({ sessionCwds: [idle] })), deps);

  assert.deepEqual(returned, [], "the pins that count are the ones at the moment of the return");
  assert.deepEqual(r.skipped.map((c) => c.skip), ["a live session is standing in it"]);
});

test("reapPool spares a tree that was re-leased to a different holder mid-sweep", async () => {
  // Returned and handed to someone else while we fetched: every rung still passes,
  // because a just-leased tree looks exactly like the leak we came for. Only the
  // lease's identity says this isn't the tree we judged.
  const clone = mkPoolRepo("harness-pool-race-holder-");
  const idle = mkLinkedWorktree(clone, "idle", join(clone, "..", "r-holder"));
  const { deps, returned } = scriptedDeps(
    `1     leased       ${idle}  (held by mission-control)`,
    `1     leased       ${idle}  (held by someone-else)`,
  );

  const r = await reapPool(clone, () => pins(), deps);

  assert.deepEqual(returned, []);
  assert.deepEqual(r.skipped.map((c) => c.skip), ["its lease changed while we looked"]);
});

test("reapPool reaps nothing when it cannot re-read the pool before acting", async () => {
  // Fail closed: a re-check we couldn't take is not a re-check that passed, so the
  // stale snapshot must never stand in as confirmation.
  const clone = mkPoolRepo("harness-pool-race-unreadable-");
  const idle = mkLinkedWorktree(clone, "idle", join(clone, "..", "r-unreadable"));
  const returned: string[] = [];
  let call = 0;
  const deps: PoolDeps = {
    status: async () =>
      call++ === 0
        ? stubRun({ stdout: `1     leased       ${idle}  (held by mission-control)`, stderr: "", code: 0 })
        : stubRun({ stdout: "", stderr: "treehouse: could not read pool state", code: 1 }),
    returnTree: async (_root, path) => {
      returned.push(path);
      return stubRun({ stdout: "", stderr: "", code: 0 });
    },
  };

  const r = await reapPool(clone, () => pins(), deps);

  assert.deepEqual(returned, []);
  assert.deepEqual(r.reaped, []);
  assert.deepEqual(
    r.skipped.map((c) => c.skip),
    ["its pool state could not be re-read before returning it"],
  );
});

test("reapPool re-checks between returns instead of trusting one reading for the batch", async () => {
  // A `return --force` is allowed 30s of its own, so a pool with several leaks to
  // collect spends minutes inside the loop - long enough for the user to walk into
  // a tree further down the list and start an agent. One reading taken before the
  // first return cannot see that; it has to be re-taken before each one.
  const clone = mkPoolRepo("harness-pool-race-loop-");
  const first = mkLinkedWorktree(clone, "first", join(clone, "..", "l-first"));
  const second = mkLinkedWorktree(clone, "second", join(clone, "..", "l-second"));
  const leased = (p: string, name: string) => `${name}     leased       ${p}  (held by mission-control)`;
  const idle = [leased(first, "1"), leased(second, "2")].join("\n");

  const returned: string[] = [];
  const deps: PoolDeps = {
    // The world only moves once tree 1 is actually back in the pool.
    status: async () =>
      stubRun({
        stdout: returned.length === 0 ? idle : [leased(first, "1"), leased(second, "2"), "                   claude (999)"].join("\n"),
        stderr: "",
        code: 0,
      }),
    returnTree: async (_root, path) => {
      returned.push(path);
      return stubRun({ stdout: "", stderr: "", code: 0 });
    },
  };

  const r = await reapPool(clone, () => pins(), deps);

  assert.deepEqual(returned, [first], "tree 2 came alive while tree 1 was being returned");
  assert.deepEqual(r.reaped.map((t) => t.name), ["1"]);
  assert.deepEqual(r.skipped.map((c) => c.skip), ["processes are still running in it"]);
});

// --- which pools get swept --------------------------------------------------

test("poolRepos sweeps a treehouse repo the workspace scan alone can name", async () => {
  // The repo that most needs the sweep is the one that cannot advertise itself: a
  // fully leaked pool has no live session left, and `make session` never files a
  // task - so both live-state sources are blind to exactly the leak we exist for.
  // (`listRepos` caches its scan, so this is the file's only poolRepos test.)
  const ws = mkdtempSync(join(tmpdir(), "harness-pool-ws-"));
  const pooled = join(ws, "pooled");
  mkdirSync(pooled, { recursive: true });
  gitIn(pooled, "init", "-q");
  gitIn(pooled, "config", "user.email", "t@test");
  gitIn(pooled, "config", "user.name", "t");
  writeFileSync(join(pooled, "treehouse.toml"), "max_trees = 16\n");
  gitIn(pooled, "add", "-A");
  gitIn(pooled, "commit", "-qm", "opt into the pool");
  // A linked worktree of that same repo, which the scan cannot tell apart from a
  // pool owner: its `.git` is a FILE, but the scan matches the ENTRY, and
  // `treehouse.toml` rides along because it is committed. Only walking back to the
  // owning repo collapses the two - otherwise it names a second, empty pool and
  // every tick pays a wasted `treehouse status` on it.
  const linked = mkLinkedWorktree(pooled, "feature", join(ws, "feature"));
  // A repo that never opted into the pool has nothing for treehouse to sweep.
  mkdirSync(join(ws, "plain", ".git"), { recursive: true });

  // A task's repoRoot arrives by the same trap: it is `rev-parse --show-toplevel`,
  // which inside a linked worktree names the worktree, not the pool's owner.
  const registry = {
    liveSessions: () => [],
    listTasks: () => [{ repoRoot: linked }],
  } as unknown as Registry;
  const prev = process.env.MISSION_WORKSPACE_DIRS;
  process.env.MISSION_WORKSPACE_DIRS = ws;
  try {
    assert.deepEqual(await poolRepos(registry), [realpathSync(pooled)]);
  } finally {
    if (prev === undefined) delete process.env.MISSION_WORKSPACE_DIRS;
    else process.env.MISSION_WORKSPACE_DIRS = prev;
  }
});

// --- the sweep's interval ---------------------------------------------------

/** Run `body` with `MISSION_POOL_REAP_MS` set to `value` (or unset), then restore it. */
async function withReapEnv(value: string | undefined, body: () => void | Promise<void>): Promise<void> {
  const prev = process.env.MISSION_POOL_REAP_MS;
  if (value === undefined) delete process.env.MISSION_POOL_REAP_MS;
  else process.env.MISSION_POOL_REAP_MS = value;
  try {
    await body();
  } finally {
    if (prev === undefined) delete process.env.MISSION_POOL_REAP_MS;
    else process.env.MISSION_POOL_REAP_MS = prev;
  }
}

test("reapIntervalMs disables on 0 and refuses to hand setTimeout a hot loop", async () => {
  await withReapEnv(undefined, () => assert.equal(reapIntervalMs(), 300_000));
  await withReapEnv("", () => assert.equal(reapIntervalMs(), 300_000, "empty reads as unset, not off"));
  await withReapEnv("900000", () => assert.equal(reapIntervalMs(), 900_000));
  await withReapEnv("0", () => assert.equal(reapIntervalMs(), null, "0 is the off switch"));
  await withReapEnv("-1", () => assert.equal(reapIntervalMs(), null, "so is any non-positive value"));
  // Both of these would otherwise reach setTimeout as a ~1ms tick of forced
  // returns and fetches - the opposite of what either value was asking for.
  await withReapEnv("nope", () => assert.equal(reapIntervalMs(), 300_000, "a typo is not an instruction"));
  await withReapEnv("5", () => assert.equal(reapIntervalMs(), 30_000, "a tiny value is clamped"));
  // The far end of the same trap: past setTimeout's 32-bit range an "effectively
  // off" value fires every ~1ms, so a huge interval must clamp, not overflow.
  await withReapEnv("99999999999", () =>
    assert.equal(reapIntervalMs(), 604_800_000, "a huge value is clamped, not handed to setTimeout"),
  );
  // The clamp dodges the overflow; it does not overrule the user. A slow sweep is
  // a legitimate ask, so anything short of nonsense is honored exactly as written.
  await withReapEnv("21600000", () =>
    assert.equal(reapIntervalMs(), 21_600_000, "a deliberate 6h interval is honored, not downgraded"),
  );
});

test("MISSION_POOL_REAP_MS=0 schedules no sweep at all", async () => {
  await withReapEnv("0", async () => {
    let sweeps = 0;
    const registry = {
      liveSessions: () => {
        sweeps++;
        return [];
      },
      listTasks: () => [],
    } as unknown as Registry;

    const stop = startPoolReaper(registry);
    // A 0 that reached setTimeout would tick every ~1ms; this window would see hundreds.
    await sleep(50);
    stop();
    assert.equal(sweeps, 0, "the off switch must schedule nothing, not spin");
  });
});
