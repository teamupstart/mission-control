import { afterEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ManualWorktreeRequestView } from "../src/shared/types.ts";
import { WorktreeClaimSchema, type WorktreeClaim } from "../src/shared/protocol.ts";
import { openDb } from "../src/server/db.ts";
import { Registry } from "../src/server/registry.ts";
import { ReviewManager } from "../src/server/reviews.ts";
import { TaskManager } from "../src/server/tasks.ts";
import { QueueManager } from "../src/server/queue.ts";
import { buildApp } from "../src/server/routes.ts";
import { buildClaimEnvironment, type ClaimStepResult } from "../src/server/worktrees/claim.ts";
import { WorktreeManager, type WorktreeManagerDeps } from "../src/server/worktrees/manager.ts";
import { MANUAL_PICKUP_WINDOW_MS } from "../src/server/worktrees/manual-requests.ts";
import type { WorktreeOccupancy } from "../src/server/worktrees/occupancy.ts";
import { gitIn, mkOriginAndClone } from "./helpers/git-fixture.ts";

// The manual acquire route when the pool has a dependency claim: it accepts with 202, the
// acquire runs in the background with the claim, and the caller polls the request until the
// lease is granted or the acquire failed. A pool with no claim still answers 201 at once.

const db = openDb();
const HEADERS = { host: "127.0.0.1:7317", "content-type": "application/json" };

afterEach(() => {
  db.exec("DELETE FROM worktree_slots; DELETE FROM worktree_pools;");
});

function emptyOccupancy(paths: readonly string[]): Promise<Map<string, WorktreeOccupancy>> {
  return Promise.resolve(new Map(paths.map((path) => [path, { status: "known", occupants: [] }])));
}

const CLAIM: WorktreeClaim = WorktreeClaimSchema.parse({ steps: [{ argv: ["yarn", "install"] }] });

/** A claim step that runs until the test settles it. */
function gatedStep(): {
  runClaimStep: WorktreeManagerDeps["runClaimStep"];
  started: () => number;
  settle: (result: ClaimStepResult) => void;
} {
  let settle!: (result: ClaimStepResult) => void;
  const gate = new Promise<ClaimStepResult>((resolve) => { settle = resolve; });
  let started = 0;
  return {
    runClaimStep: async () => {
      started += 1;
      return gate;
    },
    started: () => started,
    settle,
  };
}

const EXITED_OK: ClaimStepResult = { outcome: "exited", code: 0, signal: null, tail: "", truncatedBytes: 0 };

function harness(claim: WorktreeClaim | null, deps: Partial<WorktreeManagerDeps> = {}, maxSlots = 2) {
  const worktrees = new WorktreeManager(db, {
    occupancy: emptyOccupancy,
    resolvePolicy: () => ({ enabled: true, maxSlots, setupArgv: null, claim }),
    claimEnvironment: async (names) =>
      buildClaimEnvironment({ names, daemonEnv: { PATH: process.env.PATH }, daemonToken: "t", loginShell: {} }),
    runClaimStep: async () => EXITED_OK,
    ...deps,
  });
  const registry = new Registry();
  const app = buildApp({
    registry,
    reviews: new ReviewManager(registry),
    tasks: new TaskManager(registry),
    queues: new QueueManager(registry),
    worktrees,
  });
  const post = (path: string, body: unknown) =>
    app.request(path, { method: "POST", headers: HEADERS, body: JSON.stringify(body) });
  const poll = async (requestId: string): Promise<{ status: number; body: ManualWorktreeRequestView }> => {
    const response = await app.request(`/api/worktrees/manual/requests/${requestId}`, { headers: HEADERS });
    return { status: response.status, body: await response.json() as ManualWorktreeRequestView };
  };
  return { worktrees, app, post, poll };
}

async function waitFor<T>(read: () => Promise<T> | T, done: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function accepted(post: (path: string, body: unknown) => Response | Promise<Response>, body: unknown) {
  const response = await post("/api/worktrees/manual/acquire", body);
  assert.equal(response.status, 202);
  const payload = await response.json() as { requestId: string; baseSha: string };
  assert.match(payload.requestId, /\S/);
  return payload;
}

test("a pool with a claim answers 202, then the request reports claiming with its step and then granted", async () => {
  const { clone } = mkOriginAndClone("mission-manual-claim-grant-");
  const head = gitIn(clone, "rev-parse", "HEAD");
  const step = gatedStep();
  const { worktrees, post, poll } = harness(CLAIM, { runClaimStep: step.runClaimStep });

  const { requestId, baseSha } = await accepted(post, { repositoryPath: clone, label: "claimed review" });
  assert.equal(baseSha, head, "HEAD is pinned before the request is accepted");

  const claiming = await waitFor(() => poll(requestId), (r) => r.body.state === "claiming" && r.body.step !== null, "the running step");
  assert.equal(claiming.status, 200);
  assert.equal(claiming.body.state, "claiming");
  if (claiming.body.state === "claiming") {
    assert.deepEqual(
      { step: claiming.body.step?.step, stepCount: claiming.body.step?.stepCount, command: claiming.body.step?.command },
      { step: 1, stepCount: 1, command: "yarn install" },
    );
    assert.equal(typeof claiming.body.elapsedMs, "number");
    assert.equal(typeof claiming.body.step?.elapsedMs, "number");
  }
  // The claim runs under the same manual owner the lease will carry.
  const running = worktrees.claims.list();
  assert.equal(running.length, 1);
  assert.equal(running[0]!.owner.kind, "manual");
  assert.match(running[0]!.owner.key, /:claimed review$/);
  assert.equal(worktrees.store.slots()[0]!.state, "provisioning", "nothing is granted while the claim runs");

  step.settle(EXITED_OK);
  const granted = await waitFor(() => poll(requestId), (r) => r.body.state !== "claiming", "the grant");
  assert.equal(granted.body.state, "granted");
  if (granted.body.state !== "granted") return;
  assert.equal(granted.body.claimWarning, undefined);
  assert.equal(granted.body.lease.baseSha, head);
  assert.equal(gitIn(granted.body.lease.path, "rev-parse", "HEAD"), head);
  const stored = worktrees.lookupLease({ leaseId: granted.body.lease.leaseId });
  assert.equal(stored.state, "active");
  if (stored.state === "active") assert.deepEqual(stored.lease.owner, running[0]!.owner);
  assert.equal(worktrees.store.slots()[0]!.depsState, "current");

  // Reading a grant again answers the same lease.
  const again = await poll(requestId);
  assert.equal(again.body.state, "granted");
  if (again.body.state === "granted") assert.equal(again.body.lease.leaseId, granted.body.lease.leaseId);

  const returned = await post("/api/worktrees/manual/return", { leaseId: granted.body.lease.leaseId });
  assert.equal(returned.status, 200);
});

test("a claim that fails still grants the lease, with the failing step and its tail", async () => {
  const { clone } = mkOriginAndClone("mission-manual-claim-warning-");
  const { worktrees, post, poll } = harness(CLAIM, {
    runClaimStep: async () => ({
      outcome: "exited",
      code: 3,
      signal: null,
      tail: "resolving packages\nE401 registry refused the token\n",
      truncatedBytes: 0,
    }),
  });
  const { requestId } = await accepted(post, { repositoryPath: clone });
  const granted = await waitFor(() => poll(requestId), (r) => r.body.state !== "claiming", "the grant");
  assert.equal(granted.body.state, "granted");
  if (granted.body.state !== "granted") return;
  assert.deepEqual(
    { ...granted.body.claimWarning, tail: undefined },
    { step: 1, stepCount: 1, command: "yarn install", reason: "exited with code 3", tail: undefined, truncatedBytes: 0 },
  );
  assert.match(granted.body.claimWarning?.tail ?? "", /E401 registry refused the token/);
  const slot = worktrees.store.slots()[0]!;
  assert.equal(slot.state, "leased", "a failed claim never quarantines the slot");
  assert.equal(slot.depsState, "failed");
  const returned = await post("/api/worktrees/manual/return", { leaseId: granted.body.lease.leaseId });
  assert.equal(returned.status, 200);
});

test("an acquire the pool refuses is reported as failed with its reason", async () => {
  const { clone } = mkOriginAndClone("mission-manual-claim-failed-");
  const { worktrees, post, poll } = harness(CLAIM, {}, 1);
  const held = await worktrees.acquire({
    repositoryPath: clone,
    baseSha: gitIn(clone, "rev-parse", "HEAD"),
    owner: { kind: "task", key: "task-holding-the-only-slot:0" },
  });
  assert.equal(held.outcome, "acquired");

  const { requestId } = await accepted(post, { repositoryPath: clone });
  const failed = await waitFor(() => poll(requestId), (r) => r.body.state !== "claiming", "the failure");
  assert.equal(failed.status, 200);
  assert.equal(failed.body.state, "failed");
  if (failed.body.state !== "failed") return;
  assert.equal(failed.body.outcome, "notAcquired");
  assert.match(failed.body.reason, /capacity 1 is exhausted/);
  if (held.outcome === "acquired") await worktrees.release(held.lease);
});

test("a grant nobody picks up within the pickup window is returned to the pool", async () => {
  const { clone } = mkOriginAndClone("mission-manual-claim-pickup-");
  const { worktrees, post, poll } = harness(CLAIM, { manualPickupWindowMs: 300 });
  const { requestId } = await accepted(post, { repositoryPath: clone, label: "never polled" });

  // Observed through the store, never through the request: a poll is what picks a grant up.
  await waitFor(() => worktrees.store.slots()[0]?.state, (state) => state === "leased", "the grant");
  const leaseId = worktrees.store.slots()[0]!.activeLeaseId!;
  const returned = await waitFor(() => worktrees.store.slots()[0]!, (slot) => slot.state === "available", "the return");
  assert.equal(returned.lastReleasedLeaseId, leaseId);
  assert.equal(returned.lastReleasedOwnerKind, "manual");
  assert.equal(worktrees.lookupLease({ leaseId }).state, "released");

  const late = await poll(requestId);
  assert.equal(late.body.state, "failed", "a late poll is never handed a slot that was returned");
  if (late.body.state === "failed") {
    assert.equal(late.body.outcome, "expired");
    assert.match(late.body.reason, /not picked up within 300 ms, so Mission Control returned it to the pool/);
  }
});

test("a grant that is picked up is never returned on its caller's behalf", async () => {
  const { clone } = mkOriginAndClone("mission-manual-claim-picked-");
  const { worktrees, post, poll } = harness(CLAIM, { manualPickupWindowMs: 200 });
  const { requestId } = await accepted(post, { repositoryPath: clone });
  const granted = await waitFor(() => poll(requestId), (r) => r.body.state === "granted", "the grant");
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(worktrees.store.slots()[0]!.state, "leased");
  if (granted.body.state === "granted") {
    assert.equal(worktrees.lookupLease({ leaseId: granted.body.lease.leaseId }).state, "active");
  }
});

test("an unpicked grant whose slot is occupied stays leased", async () => {
  const { clone } = mkOriginAndClone("mission-manual-claim-occupied-");
  let occupied = false;
  let refusedChecks = 0;
  const { worktrees, post, poll } = harness(CLAIM, {
    manualPickupWindowMs: 300,
    occupancy: (paths) => {
      if (occupied) refusedChecks += 1;
      return Promise.resolve(new Map(paths.map((path) => [path, {
        status: "known" as const,
        occupants: occupied
          ? [{ pid: 4242, ppid: 1, startRaw: "", startMs: 0, command: "vim", cwd: path, knownOwner: null }]
          : [],
      }])));
    },
  });
  const { requestId } = await accepted(post, { repositoryPath: clone });
  await waitFor(() => worktrees.store.slots()[0]?.state, (state) => state === "leased", "the grant");
  const leaseId = worktrees.store.slots()[0]!.activeLeaseId!;
  // Someone found the slot through Settings and opened an editor in it.
  occupied = true;
  const settled = await waitFor(
    () => (refusedChecks > 0 ? poll(requestId) : null),
    (r) => r !== null && r.body.state === "failed" && /stays leased/.test(r.body.reason),
    "the refused return",
  );
  assert.ok(settled);
  if (settled.body.state === "failed") {
    assert.equal(settled.body.outcome, "expired");
    assert.match(settled.body.reason, /Settings > Worktrees can return it/);
  }
  assert.equal(worktrees.store.slots()[0]!.state, "leased");
  assert.equal(worktrees.lookupLease({ leaseId }).state, "active");
});

test("an unpicked grant whose worktree is dirty stays leased, with its work intact", async () => {
  const { clone } = mkOriginAndClone("mission-manual-claim-dirty-");
  const { worktrees, post, poll } = harness(CLAIM, { manualPickupWindowMs: 300 });
  const returns: Array<{ ownerAuthorized?: boolean; requireClean?: boolean }> = [];
  const release = worktrees.release.bind(worktrees);
  worktrees.release = async (lease, options = {}) => {
    returns.push(options);
    return release(lease, options);
  };
  const { requestId } = await accepted(post, { repositoryPath: clone });
  await waitFor(() => worktrees.store.slots()[0]?.state, (state) => state === "leased", "the grant");
  const slot = worktrees.store.slots()[0]!;
  const leaseId = slot.activeLeaseId!;
  // Work the caller never came back for, but that is still somebody's.
  const work = join(slot.path, "unsaved-notes.txt");
  writeFileSync(work, "do not discard\n");

  const settled = await waitFor(
    () => (returns.length > 0 ? poll(requestId) : null),
    (r) => r !== null && r.body.state === "failed" && /stays leased/.test(r.body.reason),
    "the refused return",
  );
  assert.deepEqual(returns, [{ ownerAuthorized: true, requireClean: true }]);
  if (settled?.body.state === "failed") {
    assert.equal(settled.body.outcome, "expired");
    assert.match(settled.body.reason, /dirty/);
  }
  assert.equal(worktrees.store.slots()[0]!.state, "leased");
  assert.equal(worktrees.lookupLease({ leaseId }).state, "active");
  assert.equal(readFileSync(work, "utf8"), "do not discard\n");
});

test("the production pickup window is ten minutes", async (t) => {
  assert.equal(MANUAL_PICKUP_WINDOW_MS, 10 * 60_000);
  // No `manualPickupWindowMs`: this manager carries the daemon's default. Only `setTimeout` is
  // mocked, so Git and the claim run for real while the window is stepped through by hand.
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const settle = async (read: () => boolean, label: string) => {
    const deadline = Date.now() + 15_000;
    while (!read()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise((resolve) => setImmediate(resolve));
    }
    // Let the background acquire resume past the grant and arm its pickup timer.
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  const { clone } = mkOriginAndClone("mission-manual-claim-default-window-");
  const { worktrees, post } = harness(CLAIM);
  // The expiry calls `release` synchronously when its timer fires, so this count says whether
  // a return has begun before the slot row could show it.
  const returns: Array<{ ownerAuthorized?: boolean; requireClean?: boolean }> = [];
  const release = worktrees.release.bind(worktrees);
  worktrees.release = async (lease, options = {}) => {
    returns.push(options);
    return release(lease, options);
  };
  await accepted(post, { repositoryPath: clone });
  await settle(
    () => worktrees.store.slots()[0]?.state === "leased" && worktrees.claims.list().length === 0,
    "the grant",
  );
  const leaseId = worktrees.store.slots()[0]!.activeLeaseId!;

  mock.timers.tick(MANUAL_PICKUP_WINDOW_MS - 1);
  await settle(() => true, "a turn");
  assert.equal(returns.length, 0, "no return begins one millisecond before the window");
  assert.equal(worktrees.store.slots()[0]!.state, "leased");
  assert.equal(worktrees.lookupLease({ leaseId }).state, "active");

  mock.timers.tick(1);
  assert.deepEqual(returns, [{ ownerAuthorized: true, requireClean: true }], "the return begins at ten minutes");
  await settle(() => worktrees.store.slots()[0]!.state === "available", "the return at ten minutes");
  assert.equal(worktrees.lookupLease({ leaseId }).state, "released");
});

test("a pool with no claim still answers 201 with the lease, synchronously", async () => {
  const { clone } = mkOriginAndClone("mission-manual-no-claim-");
  const { worktrees, post } = harness(null);
  const response = await post("/api/worktrees/manual/acquire", { repositoryPath: clone });
  assert.equal(response.status, 201);
  const lease = await response.json() as { path: string; leaseId: string; baseSha: string; requestId?: string };
  assert.equal(lease.requestId, undefined);
  assert.equal(lease.baseSha, gitIn(clone, "rev-parse", "HEAD"));
  assert.equal(worktrees.lookupLease({ leaseId: lease.leaseId, path: lease.path }).state, "active");
});

test("a request the daemon does not know, as after a restart, is a 404", async () => {
  const { clone } = mkOriginAndClone("mission-manual-claim-restart-");
  const step = gatedStep();
  const before = harness(CLAIM, { runClaimStep: step.runClaimStep });
  const { requestId } = await accepted(before.post, { repositoryPath: clone });
  await waitFor(step.started, (count) => count > 0, "the claim step");
  assert.equal((await before.poll(requestId)).status, 200);

  // A second manager over the same database is what a restarted daemon is: same rows, no memory.
  const after = harness(CLAIM);
  const lost = await after.poll(requestId);
  assert.equal(lost.status, 404);
  assert.match((lost.body as unknown as { error: string }).error, /manual acquire request was not found/);
  assert.equal((await after.poll(randomUUID())).status, 404);

  step.settle(EXITED_OK);
  await waitFor(() => before.poll(requestId), (r) => r.body.state !== "claiming", "the first daemon's grant");
});
