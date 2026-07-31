import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { planReap, reapPool, type PoolDeps, type PoolPins, type PoolTree } from "../src/server/pool.ts";
import {
  acquireLease,
  checkHolderToken,
  withPoolLock,
  type TreehouseCli,
} from "../src/server/pool-lease.ts";
import { LEASE_HOLDER } from "../src/shared/harness-runtime.mjs";
import { stubRun } from "../src/server/util/exec.ts";
import { gitIn, mkLinkedWorktree, mkOriginAndClone } from "./helpers/git-fixture.ts";

/**
 * What the harness is holding; nothing, unless a test says otherwise.
 *
 * `checkLeasePaths` is spelled out rather than defaulted through a `?? []` anywhere in the
 * production path: the field is required precisely so a caller that has not thought about
 * check leases fails to compile instead of quietly disarming the rung.
 */
function pins(over: Partial<PoolPins> = {}): PoolPins {
  return { sessionCwds: [], taskWorktrees: [], checkLeasePaths: [], ...over };
}

function tree(path: string, over: Partial<PoolTree> = {}): PoolTree {
  return { name: "1", state: "leased", path, holder: "mission-control", busy: false, ...over };
}

/** A clone that opted into treehouse, with the opt-in landed on ORIGIN. */
function mkPoolRepo(prefix: string): string {
  const { origin, clone } = mkOriginAndClone(prefix);
  writeFileSync(join(origin, "treehouse.toml"), "max_trees = 16\n");
  gitIn(origin, "add", "-A");
  gitIn(origin, "commit", "-qm", "opt into treehouse");
  gitIn(clone, "fetch", "-q", "origin");
  gitIn(clone, "reset", "-q", "--hard", "origin/main");
  return clone;
}

/** An idle, clean, already-merged pooled tree - exactly the leak the sweep collects. */
function mkIdleTree(prefix: string): { clone: string; wt: string } {
  const clone = mkPoolRepo(prefix);
  const wt = mkLinkedWorktree(clone, "idle", join(clone, "..", "t-idle"));
  return { clone, wt };
}

test("the reaper refuses a tree held by a check token, and says whose it is", async () => {
  // Layer 1, and the primary protection: a check lease is stamped with a holder that is not
  // in LEASE_HOLDERS, so the standing ownership rung refuses it with no new logic at all.
  // The tree is otherwise a textbook leak - idle, clean, merged - which is the point.
  const { wt } = mkIdleTree("harness-pool-check-holder-");

  const [reapable] = await planReap([tree(wt)], pins());
  assert.equal(reapable!.skip, null, "control: this tree IS reapable when it is not a check's");

  const [c] = await planReap([tree(wt, { holder: checkHolderToken("att-1") })], pins());
  assert.equal(
    c!.skip,
    "it is leased to mission-control-check-att-1; we only return our own leases " +
      "(mission-control, fleet-control, ai-harness)",
  );
});

test("the reaper refuses a pinned check lease even when the holder reads mission-control", async () => {
  // Layer 2, defence in depth, and the case a future refactor breaks: the holder is a
  // STRING, so a rename, a legacy row, or someone appending the check token to
  // LEASE_HOLDERS would sail straight through the rung above. The pin is a PATH this
  // process knows it is holding, and it survives all three.
  const { wt } = mkIdleTree("harness-pool-check-pin-");

  const [c] = await planReap([tree(wt, { holder: "mission-control" })], pins({ checkLeasePaths: [wt] }));
  assert.equal(c!.skip, "a check is running in it");
});

test("the check pin covers a tree the check is standing inside, not just its root", async () => {
  const { wt } = mkIdleTree("harness-pool-check-nested-");
  const [c] = await planReap([tree(wt)], pins({ checkLeasePaths: [join(wt, "packages", "app")] }));
  assert.equal(c!.skip, "a check is running in it");
});

test("reapPool never returns a tree this process re-leased after it looked", async () => {
  // The dispatcher's setup window, which is invisible to every rung the reaper trusts.
  // `provisionWorktree` takes its tree from the pool and the task does not record
  // `worktreePath` until provisioning returns - so in between there is no process, no
  // session and no task pin. And because a dispatch stamps the same `mission-control`
  // holder, the per-candidate re-read cannot tell that fresh lease apart from the stale one
  // the sweep planned to collect: same path, same holder, and `treehouse status` prints no
  // lease id or timestamp to separate them. Force-returning it cleans and hard-resets a
  // checkout an agent is about to be launched into.
  const { clone, wt } = mkIdleTree("harness-pool-release-race-");
  const status = `1     leased       ${wt}  (held by mission-control)`;

  // A pool that hands `wt` straight back, so the "re-lease" goes through the real
  // `acquireLease` rather than a test poking the ledger directly.
  const handsBackTheSameTree: TreehouseCli = {
    status: async () => stubRun({ stdout: status, stderr: "", code: 0 }),
    get: async () => stubRun({ stdout: `${wt}\n`, stderr: "", code: 0 }),
    return: async () => stubRun({ stdout: "", stderr: "", code: 0 }),
  };

  let reads = 0;
  const returned: string[] = [];
  const deps: PoolDeps = {
    status: async () => {
      reads++;
      // Between the sweep's snapshot and its re-read, a dispatch takes this very slot.
      if (reads === 1) await acquireLease(clone, LEASE_HOLDER, handsBackTheSameTree);
      return stubRun({ stdout: status, stderr: "", code: 0 });
    },
    returnTree: async (_r, path) => {
      returned.push(path);
      return stubRun({ stdout: "", stderr: "", code: 0 });
    },
  };

  const r = await reapPool(clone, () => pins(), deps);

  assert.deepEqual(returned, [], "a freshly leased tree was force-returned under its dispatch");
  assert.deepEqual(
    r.skipped.map((c) => c.skip),
    ["this process re-leased it while we looked"],
  );
});

test("reapPool still collects a lease taken before the sweep began", async () => {
  // The other side of the ledger, and the one that keeps it from becoming an off switch: an
  // OLD lease is exactly the leak the sweep exists to collect, so a path this process leased
  // at some point in the past must stay reapable once a later sweep judges it idle.
  const { clone, wt } = mkIdleTree("harness-pool-release-old-");
  const status = `1     leased       ${wt}  (held by mission-control)`;
  const cli: TreehouseCli = {
    status: async () => stubRun({ stdout: status, stderr: "", code: 0 }),
    get: async () => stubRun({ stdout: `${wt}\n`, stderr: "", code: 0 }),
    return: async () => stubRun({ stdout: "", stderr: "", code: 0 }),
  };
  // Leased BEFORE the sweep starts, and never returned - a leak.
  await acquireLease(clone, LEASE_HOLDER, cli);

  const returned: string[] = [];
  const deps: PoolDeps = {
    status: async () => stubRun({ stdout: status, stderr: "", code: 0 }),
    returnTree: async (_r, path) => {
      returned.push(path);
      return stubRun({ stdout: "", stderr: "", code: 0 });
    },
  };

  const r = await reapPool(clone, () => pins(), deps);
  assert.deepEqual(returned, [wt]);
  assert.deepEqual(r.reaped.map((t) => t.name), ["1"]);
});

test("reapPool holds the pool lock across its re-read and the return it authorises", async () => {
  // The re-read exists to catch a tree that came alive while the sweep was fetching. If
  // anything in this process can act between that re-read and the return, it proves nothing:
  // the check lease manager could take the very tree we just judged free and be pinning it
  // while we shell out to destroy it. So the two run inside ONE acquisition.
  const { clone, wt } = mkIdleTree("harness-pool-check-lock-");
  const status = `1     leased       ${wt}  (held by mission-control)`;

  const order: string[] = [];
  let statusCalls = 0;
  let competitor: Promise<void> | null = null;
  const deps: PoolDeps = {
    status: async () => {
      statusCalls++;
      order.push(`status-${statusCalls}`);
      if (statusCalls === 2) {
        // The per-candidate re-read has just happened. Something else in this process asks
        // for the same pool right now - it must not be served until the return is done.
        competitor = withPoolLock(clone, async () => {
          order.push("competitor");
        });
      }
      return stubRun({ stdout: status, stderr: "", code: 0 });
    },
    returnTree: async () => {
      order.push("return");
      return stubRun({ stdout: "", stderr: "", code: 0 });
    },
  };

  const r = await reapPool(clone, () => pins(), deps);
  assert.deepEqual(r.reaped.map((t) => t.name), ["1"]);

  assert.ok(competitor, "the competing acquisition never ran");
  await competitor;
  assert.deepEqual(
    order,
    ["status-1", "status-2", "return", "competitor"],
    "something else in this process was served between the re-read and the return",
  );
});
