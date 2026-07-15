import { test } from "node:test";
import assert from "node:assert/strict";
import { symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  parsePoolStatus,
  planReap,
  reapIntervalMs,
  reapPool,
  startPoolReaper,
  type PoolDeps,
  type PoolPins,
  type PoolTree,
} from "../src/server/pool.ts";
import type { Registry } from "../src/server/registry.ts";
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
      "7     leased       ~/t/7/repo  (held by fleet-control)",
      "8     leased       ~/t/8/repo  (held by fleet-control)",
      "                   claude (74975), node (75244), node (75258)",
      "9     leased       ~/t/9/repo  (held by fleet-control)",
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

// --- the safety gate --------------------------------------------------------

/** A pool tree record over a real worktree path. */
function tree(path: string, over: Partial<PoolTree> = {}): PoolTree {
  return { name: "1", state: "leased", path, holder: "fleet-control", busy: false, ...over };
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
      status: async () => ({ stdout: status, stderr: "", code: 0 }),
      returnTree: async (_root, path) => {
        returned.push(path);
        return { stdout: "", stderr: "", code: 0 };
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
      `1     leased       ${idle}  (held by fleet-control)`,
      `2     leased       ${busy}  (held by fleet-control)`,
      "                   claude (999)",
      `3     leased       ${dirty}  (held by fleet-control)`,
      `4     leased       ${live}  (held by fleet-control)`,
    ].join("\n"),
  );

  const r = await reapPool(clone, pins({ sessionCwds: [live] }), deps);

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
      `2     leased       ${busy}  (held by fleet-control)`,
      "                   claude (999)",
    ].join("\n"),
  );
  const r = await reapPool(clone, pins(), deps);
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
  const { deps, returned } = fakeDeps(`1     leased       ${held}  (held by fleet-control)`);

  const r = await reapPool(clone, pins({ taskWorktrees: [held] }), deps);

  assert.deepEqual(returned, [], "no process, no session, clean and merged - and still not ours to take");
  assert.deepEqual(r.reaped, []);
  assert.deepEqual(r.skipped.map((c) => c.skip), ["a task still holds it"]);
});

test("reapPool does nothing in a repo that never opted into treehouse", async () => {
  const { clone } = mkOriginAndClone("harness-pool-nontree-");
  const { deps, returned } = fakeDeps(`1     leased       ${clone}  (held by x)`);
  const r = await reapPool(clone, pins(), deps);
  assert.deepEqual(returned, []);
  assert.deepEqual(r, { reaped: [], skipped: [] });
});

test("reapPool reports a failed return as a skip instead of claiming the slot is free", async () => {
  const clone = mkPoolRepo("harness-pool-fail-");
  const idle = mkLinkedWorktree(clone, "idle", join(clone, "..", "f-idle"));

  const deps: PoolDeps = {
    status: async () => ({ stdout: `1     leased       ${idle}  (held by x)`, stderr: "", code: 0 }),
    returnTree: async () => ({ stdout: "", stderr: "lease is held elsewhere", code: 1 }),
  };
  const r = await reapPool(clone, pins(), deps);
  assert.deepEqual(r.reaped, []);
  assert.deepEqual(r.skipped.map((c) => c.skip), ["treehouse return failed: lease is held elsewhere"]);
});

// --- the sweep's interval ---------------------------------------------------

/** Run `body` with `FLEET_POOL_REAP_MS` set to `value` (or unset), then restore it. */
async function withReapEnv(value: string | undefined, body: () => void | Promise<void>): Promise<void> {
  const prev = process.env.FLEET_POOL_REAP_MS;
  if (value === undefined) delete process.env.FLEET_POOL_REAP_MS;
  else process.env.FLEET_POOL_REAP_MS = value;
  try {
    await body();
  } finally {
    if (prev === undefined) delete process.env.FLEET_POOL_REAP_MS;
    else process.env.FLEET_POOL_REAP_MS = prev;
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
});

test("FLEET_POOL_REAP_MS=0 schedules no sweep at all", async () => {
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
