import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorktreeActionRequest } from "../src/shared/worktrees.ts";
import { openDb } from "../src/server/db.ts";
import { WorktreeManager } from "../src/server/worktrees/manager.ts";
import { WorktreeOperationsService } from "../src/server/worktrees/operations.ts";
import type { WorktreeOccupancy } from "../src/server/worktrees/occupancy.ts";
import { LegacyTreehouseService } from "../src/server/worktrees/legacy-treehouse.ts";
import { CheckLeaseManager } from "../src/server/workflows/check-lease.ts";
import { gitIn, mkOriginAndClone } from "./helpers/git-fixture.ts";

const db = openDb();
const roots: string[] = [];
afterEach(() => {
  db.exec("DELETE FROM worktree_slots; DELETE FROM worktree_pools;");
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(): string {
  const { root, origin, clone } = mkOriginAndClone("mission-preview-scope-");
  roots.push(root);
  gitIn(origin, "commit", "--allow-empty", "-qm", "second merged commit");
  gitIn(clone, "pull", "--ff-only");
  return clone;
}

function occupied(path: string, count = 1): WorktreeOccupancy {
  return {
    status: "known",
    occupants: Array.from({ length: count }, (_, index) => ({
      pid: 100 + index, ppid: 1, startRaw: "fixture", startMs: 1,
      command: "agent helper", cwd: path, knownOwner: null,
    })),
  };
}

async function fixture(action: "destroy" | "prune") {
  const clone = repository();
  const occupancy = new Map<string, WorktreeOccupancy>();
  const manager = new WorktreeManager(db, {
    occupancy: async (paths) => new Map(paths.map((path) => [
      path, occupancy.get(path) ?? { status: "known", occupants: [] },
    ])),
    resolvePolicy: () => ({ enabled: true, maxSlots: 4, setupArgv: null }),
  });
  const legacy = new LegacyTreehouseService(db);
  const operations = new WorktreeOperationsService(manager, {
    legacy,
    tasks: { get: () => null, reclaim: async () => ({ ok: false }) },
    checks: new CheckLeaseManager(db, { manager, legacy }),
    checkRecovery: async () => "unknown",
    notifyChanged: () => {},
    diskBytes: async () => 1024,
  });
  let owner = 0;
  async function acquire(repo = clone) {
    const result = await manager.acquire({
      repositoryPath: repo, baseSha: gitIn(repo, "rev-parse", "HEAD"),
      owner: { kind: "manual", key: `preview-scope-${++owner}` },
    });
    assert.equal(result.outcome, "acquired");
    if (result.outcome !== "acquired") throw new Error("fixture acquisition failed");
    return result.lease;
  }
  const target = await acquire();
  const sibling = await acquire();
  assert.equal((await manager.release(target, { ownerAuthorized: true })).outcome, "released");
  const request: WorktreeActionRequest = action === "destroy"
    ? { action, target: { kind: "slot", slotId: target.slotId } }
    : { action, poolId: target.poolId, mode: "safe" };
  return { manager, operations, occupancy, target, sibling, request, acquire };
}

for (const action of ["destroy", "prune"] as const) {
  test(`${action} executes unchanged targets despite sibling and unrelated pool churn`, async () => {
    const f = await fixture(action);
    const unrelated = await f.acquire(repository());
    f.occupancy.set(f.sibling.path, occupied(f.sibling.path));
    const preview = await f.operations.preview(f.request);
    assert.equal(preview.allowed, true, preview.blockers.join("; "));
    assert.deepEqual(preview.affected.map((target) => target.id), [f.target.slotId]);

    f.occupancy.set(f.sibling.path, occupied(f.sibling.path, 2));
    f.occupancy.set(unrelated.path, occupied(unrelated.path));
    f.manager.store.recordReconciliation(f.target.poolId, Date.now() + 1000, null);
    const refreshed = await f.operations.preview(f.request);
    assert.notEqual(refreshed.inventoryRevision, preview.inventoryRevision);
    assert.deepEqual(refreshed.affected, preview.affected);

    assert.equal((await f.operations.execute(preview.token, [])).ok, true);
    assert.equal(f.manager.store.slot(f.target.slotId), null);
    assert.equal(existsSync(f.target.path), false);
    for (const preserved of [f.sibling, unrelated]) {
      assert.equal(f.manager.lookupLease({ leaseId: preserved.leaseId }).state, "active");
      assert.equal(existsSync(preserved.path), true);
    }
  });

  for (const change of ["occupied", "unknown occupancy", "dirty", "merged HEAD", "version"] as const) {
    test(`${action} rejects a target's changed ${change} before removal`, async () => {
      const f = await fixture(action);
      const preview = await f.operations.preview(f.request);
      assert.equal(preview.allowed, true, preview.blockers.join("; "));
      switch (change) {
        case "occupied": f.occupancy.set(f.target.path, occupied(f.target.path)); break;
        case "unknown occupancy": f.occupancy.set(f.target.path, { status: "unknown", reason: "scan unavailable" }); break;
        case "dirty": writeFileSync(join(f.target.path, "keep-me.txt"), "uncommitted\n"); break;
        case "merged HEAD": gitIn(f.target.path, "checkout", "--detach", "HEAD^"); break;
        case "version": db.prepare("UPDATE worktree_slots SET version = version + 1 WHERE id = ?").run(f.target.slotId); break;
      }
      await assert.rejects(f.operations.execute(preview.token, []), /changed after preview/);
      assert.ok(f.manager.store.slot(f.target.slotId));
      assert.equal(existsSync(f.target.path), true);
    });
  }

  test(`${action} rejects a changed fixed target set`, async () => {
    const f = await fixture(action);
    const request: WorktreeActionRequest = action === "destroy"
      ? { action, target: { kind: "pool", poolId: f.target.poolId } }
      : f.request;
    const preview = await f.operations.preview(request);
    assert.equal(preview.allowed, true, preview.blockers.join("; "));
    if (action === "destroy") await f.acquire();
    else assert.equal((await f.manager.release(f.sibling, { ownerAuthorized: true })).outcome, "released");
    await assert.rejects(f.operations.execute(preview.token, []), /changed after preview/);
    assert.equal(existsSync(f.target.path), true);
    assert.equal(existsSync(f.sibling.path), true);
  });
}
