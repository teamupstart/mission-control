import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parsePoolStatus, planReap, reapPool, type PoolDeps, type PoolTree } from "../src/server/pool.ts";
import { gitIn, mkOriginAndClone, mkLinkedWorktree } from "./helpers/git-fixture.ts";

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
  const [c] = await planReap([tree(wt)], []);
  assert.equal(c!.skip, null, "a clean, merged, idle lease is exactly the leak we collect");
});

test("planReap spares a BUSY tree even though it is clean and merged", async () => {
  // The load-bearing case: an agent that has just pushed sits in a tree that is
  // clean AND merged, so the git checks alone would happily reap it out from
  // under a live session. Only the process list saves it.
  const { wt } = mkIdleTree();
  const [c] = await planReap([tree(wt, { busy: true })], []);
  assert.equal(c!.skip, "processes are still running in it");
});

test("planReap spares a tree a live session stands in, including from a nested subdir", async () => {
  const { wt } = mkIdleTree();
  // Discovery reports a pane's cwd, which may be nested well below the worktree
  // top - that still pins the tree.
  const [c] = await planReap([tree(wt)], [join(wt, "packages", "app")]);
  assert.equal(c!.skip, "a live session is standing in it");
});

test("planReap spares a tree with uncommitted changes", async () => {
  const { wt } = mkIdleTree();
  writeFileSync(join(wt, "keep.txt"), "base\nwork in progress\n");
  const [c] = await planReap([tree(wt)], []);
  assert.equal(c!.skip, "it has uncommitted changes", "`treehouse return` would reset this away");
});

test("planReap spares a tree holding commits origin has never seen", async () => {
  const { wt } = mkIdleTree();
  writeFileSync(join(wt, "keep.txt"), "base\nunpushed\n");
  gitIn(wt, "commit", "-qam", "unpushed work");
  const [c] = await planReap([tree(wt)], []);
  assert.equal(c!.skip, "it has commits origin/main doesn't have");
});

test("planReap spares an untracked-file-only tree (clean checkout, real scratch work)", async () => {
  const { wt } = mkIdleTree();
  writeFileSync(join(wt, "scratch.txt"), "notes\n");
  const [c] = await planReap([tree(wt)], []);
  assert.equal(c!.skip, "it has uncommitted changes");
});

test("planReap leaves available and in-use trees alone", async () => {
  const { wt } = mkIdleTree();
  const plan = await planReap([tree(wt, { state: "available" }), tree(wt, { state: "in-use" })], []);
  assert.deepEqual(plan.map((c) => c.skip), ["it is available", "it is in-use"]);
});

test("planReap spares a tree whose directory has gone missing", async () => {
  const [c] = await planReap([tree("/definitely/not/a/worktree")], []);
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

  const r = await reapPool(clone, [live], deps);

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
  const r = await reapPool(clone, [], deps);
  assert.deepEqual(returned, []);
  assert.deepEqual(
    r.skipped.map((c) => [c.tree.name, c.skip]),
    [
      ["1", "it is available"],
      ["2", "processes are still running in it"],
    ],
  );
});

test("reapPool does nothing in a repo that never opted into treehouse", async () => {
  const { clone } = mkOriginAndClone("harness-pool-nontree-");
  const { deps, returned } = fakeDeps(`1     leased       ${clone}  (held by x)`);
  const r = await reapPool(clone, [], deps);
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
  const r = await reapPool(clone, [], deps);
  assert.deepEqual(r.reaped, []);
  assert.deepEqual(r.skipped.map((c) => c.skip), ["treehouse return failed: lease is held elsewhere"]);
});
