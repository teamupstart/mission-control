import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A fresh state dir BEFORE anything that resolves it is imported. Static imports hoist
// above assignments, so every module below has to arrive through a dynamic import or the
// suite would open the machine's real database (see db-isolation.test.ts).
//
// `realpathSync` because $TMPDIR is a symlink into /private on macOS and the lease manager
// canonicalizes every path it stores - so a fixture that skipped this would be comparing
// two spellings of the same directory and calling them different trees.
const home = realpathSync(mkdtempSync(join(tmpdir(), "mission-check-lease-")));
process.env.HARNESS_HOME = home;

const { openDb } = await import("../src/server/db.ts");
const { CheckLeaseManager, CheckLeaseStore } = await import("../src/server/workflows/check-lease.ts");
const { checkHolderToken, isCheckHolder, installCheckLeasePins } =
  await import("../src/server/pool-lease.ts");
const { parsePoolStatus, poolPins } = await import("../src/server/pool.ts");
const { Registry } = await import("../src/server/registry.ts");
const { onPath, stubRun } = await import("../src/server/util/exec.ts");
const { verifyPinnedBase } = await import("../src/server/dispatcher.ts");

type TreehouseCli = import("../src/server/pool-lease.ts").TreehouseCli;
type CheckGroupRecovery = import("../src/server/workflows/check-lease.ts").CheckGroupRecovery;

const db = openDb();
const store = new CheckLeaseStore(db);
const SHA = "a".repeat(40);

const liveRows = (): unknown[] =>
  db
    .prepare(`SELECT attempt_id, lease_path, cleanup_state FROM workflow_check_leases
               WHERE cleanup_state IN ('held', 'returning')`)
    .all();

/**
 * THE LEAK ASSERTION, per test rather than once at the end - the cheapest guard against the
 * worst failure mode this subsystem has, which is code that ends still holding a pooled
 * worktree. Per test because "the suite leaked" is a bug report nobody can act on, while
 * "this test leaked" names the case.
 *
 * A row left in `held` or `returning` is a lease nothing handed back. Terminal rows are fine
 * and expected - they are the audit trail, and several cases below deliberately leave one.
 *
 * Clearing the table afterwards is what makes each case hermetic: reclamation and the pin
 * query both read the WHOLE table by design, so one case's leftovers would otherwise decide
 * another's outcome.
 */
afterEach((t) => {
  const live = liveRows();
  db.exec("DELETE FROM workflow_check_leases");
  assert.deepEqual(live, [], `${t.name} ended still holding a check lease`);
});

after(() => {
  assert.deepEqual(liveRows(), [], "the suite ended still holding a check lease");

  // The other half: the developer's REAL pool. Every case here drives a fake subprocess, so
  // a tree in the actual pool held by a check token could only come from a call that escaped
  // the fake - which is precisely the mistake worth catching. Skipped where treehouse is not
  // installed (CI), and a pool we cannot read is not evidence of anything.
  if (onPath("treehouse")) {
    try {
      const out = execFileSync("treehouse", ["status"], { cwd: process.cwd(), stdio: "pipe" }).toString();
      const leaked = parsePoolStatus(out).filter((t) => isCheckHolder(t.holder));
      assert.deepEqual(leaked, [], "a real pooled worktree is still held by a check token");
    } catch {
      // An unreadable pool tells us nothing; it must not fail the suite either way.
    }
  }
  installCheckLeasePins(null);
  rmSync(home, { recursive: true, force: true });
});

// ---- a fake pool -----------------------------------------------------------

interface FakeTree {
  name: string;
  path: string;
  state: "available" | "leased" | "dirty";
  holder: string | null;
  busy: boolean;
}

interface CliCall {
  cmd: "status" | "get" | "return";
  cwd: string | null;
  holder?: string;
  path?: string;
  force?: boolean;
}

/**
 * A pool that behaves like one: `get` hands out the first free slot and stamps the holder,
 * `status` renders what treehouse would print, `return` frees the slot. Modelled rather than
 * canned so the identity rules are exercised against a pool that actually changes.
 */
function fakePool(slots: number, dir: string) {
  const trees: FakeTree[] = [];
  for (let i = 1; i <= slots; i++) {
    const path = join(dir, String(i), "repo");
    // Real directories: `acquireLease` refuses a path that does not exist, and that refusal
    // is part of what it promises.
    mkdirSync(path, { recursive: true });
    trees.push({ name: String(i), path, state: "available", holder: null, busy: false });
  }
  const calls: CliCall[] = [];
  const fail = { status: false, return: false };

  const render = (): string =>
    trees
      .map((t) => `${t.name}     ${t.state}       ${t.path}${t.holder ? `  (held by ${t.holder})` : ""}`)
      .join("\n");

  const cli: TreehouseCli = {
    status: async (repoRoot) => {
      calls.push({ cmd: "status", cwd: repoRoot });
      return fail.status
        ? stubRun({ stdout: "", stderr: "pool is unreadable", code: 1 })
        : stubRun({ stdout: render(), stderr: "", code: 0 });
    },
    get: async (repoRoot, holder) => {
      calls.push({ cmd: "get", cwd: repoRoot, holder });
      const free = trees.find((t) => t.state === "available");
      if (!free) return stubRun({ stdout: "", stderr: "no trees available", code: 1 });
      free.state = "leased";
      free.holder = holder;
      return stubRun({ stdout: `${free.path}\n`, stderr: "", code: 0 });
    },
    return: async ({ cwd, path, force }) => {
      calls.push({ cmd: "return", cwd, path, force });
      if (fail.return) return stubRun({ stdout: "", stderr: "tree is busy", code: 1 });
      const t = trees.find((x) => x.path === path);
      if (t) {
        t.state = "available";
        t.holder = null;
      }
      return stubRun({ stdout: "", stderr: "", code: 0 });
    },
  };
  return { cli, trees, calls, fail };
}

let seq = 0;
/** A manager over a fresh fake pool, with the git work stubbed unless a test wants it. */
function mkManager(
  opts: { slots?: number; pin?: (r: string, p: string, s: string) => Promise<void> } = {},
) {
  const dir = mkdtempSync(join(home, `pool-${seq++}-`));
  const pool = fakePool(opts.slots ?? 3, dir);
  const manager = new CheckLeaseManager(db, {
    cli: pool.cli,
    // The pin is real git work against a real pool tree; every case here is about the LEASE,
    // so it is stubbed unless the case is specifically about a pin failing.
    pin: opts.pin ?? (async () => {}),
    verifyBase: async (_repoRoot, sha) => sha,
  });
  return { ...pool, manager, repoRoot: dir };
}

function acquire(m: ReturnType<typeof mkManager>, attemptId: string, over: Partial<{ submissionId: string; nodeId: string }> = {}) {
  return m.manager.acquireForAttempt({
    attemptId,
    submissionId: over.submissionId ?? `sub-${attemptId}`,
    nodeId: over.nodeId ?? `node-${attemptId}`,
    repoRoot: m.repoRoot,
    headSha: SHA,
  });
}

// ---- acquire ---------------------------------------------------------------

test("acquire stamps a check-specific holder the shared reaper cannot recognise", async () => {
  const m = mkManager();
  const path = await acquire(m, "att-holder");

  const get = m.calls.find((c) => c.cmd === "get");
  assert.equal(get?.holder, "mission-control-check-att-holder");
  assert.equal(get?.holder, checkHolderToken("att-holder"));
  assert.equal(m.trees.find((t) => t.path === path)?.holder, checkHolderToken("att-holder"));

  await m.manager.releaseForAttempt("att-holder");
});

test("acquire pins the path from the moment the lease exists, not from when the row does", async () => {
  const m = mkManager();
  // Asserted from INSIDE the pin step, which is the window that matters: the tree is leased
  // and a reaper tick landing here must already see the path as held.
  let pinnedDuringSetup: string[] = [];
  const m2 = mkManager({
    pin: async () => {
      pinnedDuringSetup = m2.manager.pinnedPaths();
    },
  });
  const path = await acquire(m2, "att-pin");
  assert.ok(pinnedDuringSetup.includes(path), "the path was not pinned while setup was still running");

  // And the in-memory half is real, not just the durable query reading back: delete the row
  // out from under the manager and the path stays pinned. This is the union the reaper
  // depends on during the window between `treehouse get` returning and the INSERT landing.
  db.prepare(`DELETE FROM workflow_check_leases WHERE attempt_id = ?`).run("att-pin");
  assert.ok(m2.manager.pinnedPaths().includes(path), "the pin was only ever the table query");

  await m2.manager.releaseForAttempt("att-pin");
  assert.equal(m.calls.length, 0);
});

test("acquire persists the row as held, with the supervisor sentinels", async () => {
  const m = mkManager();
  const path = await acquire(m, "att-row", { submissionId: "sub-1", nodeId: "node-1" });

  const row = store.get("att-row");
  assert.equal(row?.cleanupState, "held");
  assert.equal(row?.leasePath, path);
  assert.equal(row?.submissionId, "sub-1");
  assert.equal(row?.nodeId, "node-1");
  assert.equal(row?.holderToken, checkHolderToken("att-row"));
  // The sentinel: proof the supervisor gate was never released and no branch code ran.
  assert.equal(row?.supervisorPid, 0);
  assert.equal(row?.supervisorStartTicks, "");

  await m.manager.releaseForAttempt("att-row");
});

test("acquire refuses a second lease for one attempt, live or already finished", async () => {
  const m = mkManager();
  await acquire(m, "att-twice");
  await assert.rejects(
    () => acquire(m, "att-twice"),
    /already holds .* refusing to take a second lease/s,
  );
  // And it refused BEFORE asking the pool for anything.
  assert.equal(m.calls.filter((c) => c.cmd === "get").length, 1);

  // Still refused once the lease has been handed back: one lease per attempt id EVER, not
  // one at a time. A retry is a new attempt id by construction, so an attempt asking twice
  // is a bug - and it must say so rather than surface as a primary-key violation.
  await m.manager.releaseForAttempt("att-twice");
  await assert.rejects(() => acquire(m, "att-twice"), /refusing to take a second lease/);
  assert.equal(m.calls.filter((c) => c.cmd === "get").length, 1);
});

test("a pool slot can be leased again after an earlier lease of it went terminal", async () => {
  // THE CASE THAT DECIDES THE SHAPE OF idx_workflow_check_leases_path, so it is worth being
  // explicit about what it proves. Two rules have to hold at once:
  //
  //   1. Terminal rows (`returned`, `lost`) are RETAINED, for audit.
  //   2. A pool hands the same slot out over and over - that is what a pool IS.
  //
  // Together they mean the table must tolerate several rows naming one path, differing only
  // in state. An UNSCOPED unique index on `lease_path` cannot: the first check to use pool
  // slot 1 leaves a retained row behind, and every later check handed that same slot fails
  // its INSERT with a constraint violation - permanently, for that slot, on every future
  // run. So the index is scoped to the live states, which still forbids the thing that
  // actually corrupts work (two LIVE rows believing they hold one tree) while letting the
  // audit trail accumulate.
  //
  // One slot in the fixture, so re-use is forced rather than hoped for.
  const m = mkManager({ slots: 1 });

  const first = await acquire(m, "att-slot-1");
  assert.deepEqual(await m.manager.releaseForAttempt("att-slot-1"), { outcome: "returned" });
  assert.equal(store.get("att-slot-1")?.cleanupState, "returned", "the audit row is retained");

  // The same tree, handed back out. This is the INSERT an unscoped unique index rejects.
  const second = await acquire(m, "att-slot-2");
  assert.equal(second, first, "the fixture must re-hand the same slot for this to prove anything");
  assert.equal(store.get("att-slot-2")?.cleanupState, "held");

  // And again behind a `lost` row, which is retained with its path intact by design.
  const tree = m.trees.find((t) => t.path === second)!;
  tree.holder = "someone-else";
  assert.equal((await m.manager.releaseForAttempt("att-slot-2")).outcome, "lost");
  // The external holder eventually gives the tree back to the pool.
  tree.state = "available";
  tree.holder = null;

  const third = await acquire(m, "att-slot-3");
  assert.equal(third, first);
  assert.equal(store.get("att-slot-3")?.cleanupState, "held");

  // All three rows coexist, naming one path - which is the whole point.
  const rows = db
    .prepare(`SELECT cleanup_state FROM workflow_check_leases WHERE lease_path = ? ORDER BY created_at`)
    .all(first);
  assert.deepEqual(rows.map((r) => (r as { cleanup_state: string }).cleanup_state), [
    "returned",
    "lost",
    "held",
  ]);

  await m.manager.releaseForAttempt("att-slot-3");
});

test("two concurrent acquires for one attempt cannot strip the winner of its row", async () => {
  // The failure this prevents is silent and unrecoverable. Both callers get past the
  // "already holds" check because neither has inserted yet; the first inserts and keeps its
  // tree; the second's INSERT fails on the primary key, and its unwind - which acts on
  // `attemptId` - deletes the FIRST caller's row. The winner then holds a live tree with no
  // durable record, and because a check holder is deliberately invisible to the shared
  // reaper, NOTHING would ever collect it. Not the reaper (wrong holder), not reclamation
  // (it reads the table), not a restart.
  const m = mkManager({ slots: 4 });

  const results = await Promise.allSettled([
    acquire(m, "att-concurrent"),
    acquire(m, "att-concurrent"),
  ]);
  const won = results.filter((r) => r.status === "fulfilled");
  const lost = results.filter((r) => r.status === "rejected");
  assert.equal(won.length, 1, "exactly one caller may win the attempt");
  assert.equal(lost.length, 1);
  assert.match(
    String((lost[0] as PromiseRejectedResult).reason),
    /refusing to take a second lease for one attempt/,
  );

  // The winner's row survives, still live, still naming the tree it is holding.
  const path = (won[0] as PromiseFulfilledResult<string>).value;
  const row = store.get("att-concurrent");
  assert.equal(row?.cleanupState, "held");
  assert.equal(row?.leasePath, path);
  assert.ok(m.manager.pinnedPaths().includes(path));
  // And the loser took no tree at all, so the pool lost nothing.
  assert.equal(m.trees.filter((t) => t.state === "leased").length, 1);

  await m.manager.releaseForAttempt("att-concurrent");
});

test("a primary-key clash from another manager leaves the winner's row alone", async () => {
  // The in-flight claim above is per manager, so it closes the concurrent case for the one
  // manager the daemon runs - but the guard underneath it has to hold on its own, or it is
  // just a comment. Two managers over one table reach the INSERT that the claim prevents:
  // both read `store.get` as null before either has written, then the pool lock serialises
  // them, and the second's INSERT fails on the primary key. Its unwind must not touch the
  // row, because that row now belongs to a live lease the first manager is holding.
  const m = mkManager({ slots: 4 });
  const other = new CheckLeaseManager(db, {
    cli: m.cli,
    pin: async () => {},
    verifyBase: async (_r, s) => s,
  });
  const ask = (mgr: InstanceType<typeof CheckLeaseManager>) =>
    mgr.acquireForAttempt({
      attemptId: "att-two-managers",
      submissionId: "sub-tm",
      nodeId: "node-tm",
      repoRoot: m.repoRoot,
      headSha: SHA,
    });

  const results = await Promise.allSettled([ask(m.manager), ask(other)]);
  const won = results.filter((r) => r.status === "fulfilled");
  assert.equal(won.length, 1, "the primary key must let exactly one through");
  assert.match(
    String((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason),
    /UNIQUE constraint failed|already holds/,
  );

  // The survivor's row still describes the tree it is actually holding.
  const path = (won[0] as PromiseFulfilledResult<string>).value;
  const row = store.get("att-two-managers");
  assert.equal(row?.cleanupState, "held", "the loser's unwind deleted the winner's row");
  assert.equal(row?.leasePath, path);
  // And the loser handed its own tree back, so the pool kept every slot but one.
  assert.equal(m.trees.filter((t) => t.state === "leased").length, 1);

  await m.manager.releaseForAttempt("att-two-managers");
});

test("a loser whose unwind cannot return its tree still leaves the winner's row held", async () => {
  // The same clash, but now the loser's own return fails too - the one path that reaches the
  // `returning` write. Unconditional, that write lands on the WINNER's row and marks a live
  // check's lease as being handed back, which invites reclamation to force-return a tree
  // with a build running in it.
  const m = mkManager({ slots: 4 });
  const other = new CheckLeaseManager(db, {
    cli: { ...m.cli, return: async () => stubRun({ stdout: "", stderr: "tree is busy", code: 1 }) },
    pin: async () => {},
    verifyBase: async (_r, s) => s,
  });
  const ask = (mgr: InstanceType<typeof CheckLeaseManager>) =>
    mgr.acquireForAttempt({
      attemptId: "att-clash-stuck",
      submissionId: "sub-cs",
      nodeId: "node-cs",
      repoRoot: m.repoRoot,
      headSha: SHA,
    });

  const [first, second] = await Promise.allSettled([ask(m.manager), ask(other)]);
  assert.equal(first.status, "fulfilled", "the first caller through the lock should win");
  assert.equal(second.status, "rejected");
  // It names the tree it could neither record nor return, because a human has to hand that
  // one back - there is no row for reclamation to find it by.
  assert.match(String((second as PromiseRejectedResult).reason), /no lease row could be written/);

  const row = store.get("att-clash-stuck");
  assert.equal(row?.cleanupState, "held", "the loser's unwind re-stated the winner's lease");
  assert.equal(row?.leasePath, (first as PromiseFulfilledResult<string>).value);

  await m.manager.releaseForAttempt("att-clash-stuck");
});

test("a failed insert never deletes or re-states a row this acquire did not write", async () => {
  // The other half of the same rule, reached without concurrency: the pool hands out a path
  // that a DIFFERENT live attempt already records, so the unique lease-path index rejects
  // the INSERT. The unwind must return the tree it just took and leave the other attempt's
  // row exactly as it found it.
  const m = mkManager({ slots: 2 });
  const held = await acquire(m, "att-owner");

  // Force the next acquire onto the same path, behind the owner's back.
  const stealer = new CheckLeaseManager(db, {
    cli: {
      ...m.cli,
      get: async () => stubRun({ stdout: `${held}\n`, stderr: "", code: 0 }),
    },
    pin: async () => {},
    verifyBase: async (_r, s) => s,
  });

  await assert.rejects(
    () => stealer.acquireForAttempt({
      attemptId: "att-stealer",
      submissionId: "sub-s",
      nodeId: "node-s",
      repoRoot: m.repoRoot,
      headSha: SHA,
    }),
    /UNIQUE constraint failed/,
  );

  // The owner is untouched: same state, same path, still pinned, still gating a retry.
  const row = store.get("att-owner");
  assert.equal(row?.cleanupState, "held");
  assert.equal(row?.leasePath, held);
  assert.equal(m.manager.unresolvedLeaseForNode("sub-att-owner", "node-att-owner"), true);
  assert.equal(store.get("att-stealer"), null, "the failed acquire wrote no row of its own");

  await m.manager.releaseForAttempt("att-owner");
});

test("acquire refuses a short base sha through the existing pinned-base check", async () => {
  // The real `verifyPinnedBase`, not a second regex - and it must refuse before a slot is
  // taken, so a bad caller costs an error rather than a pool tree that has to be unwound.
  const repo = join(home, "real-repo");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@test"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
  writeFileSync(join(repo, "f.txt"), "base\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "base"]);
  const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"]).toString().trim();

  const pool = fakePool(1, mkdtempSync(join(home, "real-pool-")));
  const manager = new CheckLeaseManager(db, { cli: pool.cli, pin: async () => {}, verifyBase: verifyPinnedBase });

  await assert.rejects(
    () => manager.acquireForAttempt({
      attemptId: "att-shortsha",
      submissionId: "s",
      nodeId: "n",
      repoRoot: repo,
      headSha: head.slice(0, 12),
    }),
    /not a full 40-character commit id/,
  );
  assert.deepEqual(pool.calls, [], "a bad base sha must cost no pool slot");
  assert.equal(store.get("att-shortsha"), null);
});

test("a pin failure unwinds the lease and surfaces the return's own outcome in the error", async () => {
  const m = mkManager({ pin: async () => { throw new Error("reset --hard refused"); } });
  await assert.rejects(() => acquire(m, "att-pinfail"), /reset --hard refused/);

  // The lease went back, the row is gone, nothing is pinned, and the slot is free again -
  // otherwise a pin failure would cost a pool slot permanently, since nothing downstream
  // would ever record the tree.
  assert.equal(m.calls.filter((c) => c.cmd === "return").length, 1);
  assert.equal(store.get("att-pinfail"), null);
  assert.deepEqual(m.manager.pinnedPaths(), []);
  assert.ok(m.trees.every((t) => t.state === "available"));

  // And when the unwind itself fails, the real cause survives WITH the return's outcome,
  // and the lease stays recorded rather than being pretended away.
  const m2 = mkManager({ pin: async () => { throw new Error("verify failed"); } });
  m2.fail.return = true;
  await assert.rejects(
    () => acquire(m2, "att-unwindfail"),
    /verify failed - and the pool lease could not be returned: tree is busy/,
  );
  assert.equal(store.get("att-unwindfail")?.cleanupState, "returning");
  assert.equal(m2.manager.pinnedPaths().length, 1, "a tree we could not return stays pinned");

  // Clean up the deliberately-stranded lease so the leak assertion means something.
  m2.fail.return = false;
  assert.equal((await m2.manager.releaseForAttempt("att-unwindfail")).outcome, "returned");
});

// ---- release: the four identity outcomes -----------------------------------

test("release returns the tree when both the path and the exact holder token match", async () => {
  const m = mkManager();
  const path = await acquire(m, "att-match");

  const result = await m.manager.releaseForAttempt("att-match");
  assert.deepEqual(result, { outcome: "returned" });

  const ret = m.calls.filter((c) => c.cmd === "return");
  assert.equal(ret.length, 1);
  assert.equal(ret[0]!.path, path);
  // Forced: this is a reclaimer, not an interactive teardown, and a prompt would hang it.
  assert.equal(ret[0]!.force, true);
  assert.equal(store.get("att-match")?.cleanupState, "returned");
  assert.deepEqual(m.manager.pinnedPaths(), []);
});

test("release is idempotent: a second call issues no return at all", async () => {
  const m = mkManager();
  await acquire(m, "att-idem");
  await m.manager.releaseForAttempt("att-idem");
  const after = m.calls.length;

  assert.deepEqual(await m.manager.releaseForAttempt("att-idem"), { outcome: "returned" });
  assert.equal(m.calls.length, after, "an already-returned lease must not be returned again");
  // Same for an attempt with no row at all.
  assert.deepEqual(await m.manager.releaseForAttempt("att-never-existed"), { outcome: "returned" });
  assert.equal(m.calls.length, after);
});

test("release completes cleanup without a return when the slot is already available", async () => {
  const m = mkManager();
  const path = await acquire(m, "att-available");
  // The prior return succeeded but the row outlived it - the crash this rule exists for.
  const tree = m.trees.find((t) => t.path === path)!;
  tree.state = "available";
  tree.holder = null;

  assert.deepEqual(await m.manager.releaseForAttempt("att-available"), { outcome: "returned" });
  assert.equal(m.calls.filter((c) => c.cmd === "return").length, 0);
  assert.equal(store.get("att-available")?.cleanupState, "returned");
  assert.deepEqual(m.manager.pinnedPaths(), []);
});

test("release completes cleanup without a return when the path is absent from status", async () => {
  const m = mkManager();
  const path = await acquire(m, "att-absent");
  m.trees.splice(m.trees.findIndex((t) => t.path === path), 1);

  assert.deepEqual(await m.manager.releaseForAttempt("att-absent"), { outcome: "returned" });
  assert.equal(m.calls.filter((c) => c.cmd === "return").length, 0);
  assert.equal(store.get("att-absent")?.cleanupState, "returned");
});

test("release refuses a path held by a different token, keeps the row as lost, and drops the pin", async () => {
  // The invariant that stops a recovery from destroying someone else's work: between our
  // return and our row's deletion, the pool re-leased this tree to somebody else.
  const m = mkManager();
  const path = await acquire(m, "att-lost");
  const tree = m.trees.find((t) => t.path === path)!;
  tree.holder = "mission-control";

  const result = await m.manager.releaseForAttempt("att-lost");
  assert.deepEqual(result, { outcome: "lost", holder: "mission-control" });
  assert.equal(m.calls.filter((c) => c.cmd === "return").length, 0, "it must issue NO return");
  assert.equal(tree.holder, "mission-control", "the other holder's lease is untouched");

  // The row is kept for audit...
  assert.equal(store.get("att-lost")?.cleanupState, "lost");
  // ...but the pin is DROPPED. Keeping it would outlive the external holder's lease and bar
  // the ordinary reaper from that path for the life of the daemon - one pool slot lost.
  assert.deepEqual(m.manager.pinnedPaths(), []);
  installCheckLeasePins(() => m.manager.pinnedPaths());
  assert.deepEqual(poolPins(new Registry()).checkLeasePaths, []);
  installCheckLeasePins(null);
});

test("a failed return keeps the row in returning, keeps the pin, and permits no second lease", async () => {
  const m = mkManager();
  const path = await acquire(m, "att-retry");
  m.fail.return = true;

  const result = await m.manager.releaseForAttempt("att-retry");
  assert.equal(result.outcome, "retry");
  assert.match((result as { reason: string }).reason, /tree is busy/);
  assert.equal(store.get("att-retry")?.cleanupState, "returning");
  assert.deepEqual(m.manager.pinnedPaths(), [path], "a tree we could not return is still ours");
  await assert.rejects(() => acquire(m, "att-retry"), /refusing to take a second lease/);

  // And the retry eventually succeeds, which is what makes `returning` a state rather than a
  // grave. (`reclaimLeaked` drives this on the reaper's tick; called directly here because
  // the backoff is deliberately minutes long.)
  m.fail.return = false;
  assert.deepEqual(await m.manager.releaseForAttempt("att-retry"), { outcome: "returned" });
  assert.deepEqual(m.manager.pinnedPaths(), []);
});

test("release keeps the lease when the pool cannot be read at all", async () => {
  const m = mkManager();
  await acquire(m, "att-blindstatus");
  m.fail.status = true;

  const result = await m.manager.releaseForAttempt("att-blindstatus");
  assert.equal(result.outcome, "retry");
  assert.equal(m.calls.filter((c) => c.cmd === "return").length, 0, "never return on an unread pool");
  assert.equal(store.get("att-blindstatus")?.cleanupState, "returning");

  m.fail.status = false;
  await m.manager.releaseForAttempt("att-blindstatus");
});

// ---- startup reconciliation ------------------------------------------------

test("reconciliation restores pins before it resolves anything", async () => {
  const m = mkManager();
  await acquire(m, "att-restore");

  // A second manager over the same table is what a restart looks like: the row is there and
  // nothing is in memory.
  const fresh = new CheckLeaseManager(db, { cli: m.cli, pin: async () => {}, verifyBase: async (_r, s) => s });
  const pinsDuringReconcile: string[][] = [];
  const watching: CheckGroupRecovery = async () => {
    pinsDuringReconcile.push(fresh.pinnedPaths());
    return "not-empty";
  };
  // Give the row a supervisor identity so it takes the group-recovery path.
  fresh.processes.record("att-restore", 4321, "ticks-4321");
  await fresh.reconcileOnStartup(watching);

  assert.equal(pinsDuringReconcile.length, 1);
  assert.equal(pinsDuringReconcile[0]!.length, 1, "the pin must exist before any return is considered");

  await fresh.releaseForAttempt("att-restore");
});

test("reconciliation returns a sentinel-pid row on identity alone", async () => {
  const m = mkManager();
  const path = await acquire(m, "att-sentinel");

  const fresh = new CheckLeaseManager(db, { cli: m.cli, pin: async () => {}, verifyBase: async (_r, s) => s });
  // No `processes.record` ever ran, so the gate was never released and no branch code
  // started. There is no group to prove empty, and the refusing default must not block it.
  await fresh.reconcileOnStartup();

  assert.equal(store.get("att-sentinel")?.cleanupState, "returned");
  assert.equal(m.trees.find((t) => t.path === path)?.state, "available");
});

test("reconciliation never returns a non-sentinel row on ownership alone", async () => {
  // The failure this prevents: a daemon restarts while a check's process group is still
  // writing in its tree, and ownership alone authorises `return --force` on it - killing the
  // build and hard-resetting the work. Ownership is not emptiness.
  const m = mkManager();
  const path = await acquire(m, "att-live");
  m.manager.processes.record("att-live", 9999, "ticks-9999");

  const restart = () =>
    new CheckLeaseManager(db, { cli: m.cli, pin: async () => {}, verifyBase: async (_r, s) => s });

  // 1. The shipped default refuses, so an uninjected daemon keeps the tree.
  const a = restart();
  await a.reconcileOnStartup();
  assert.equal(store.get("att-live")?.cleanupState, "held");
  assert.deepEqual(a.pinnedPaths(), [path], "an unresolved lease keeps its pin");
  assert.equal(m.calls.filter((c) => c.cmd === "return").length, 0);

  // 2. A group that is provably still running keeps it too.
  const b = restart();
  await b.reconcileOnStartup(async () => "not-empty");
  assert.equal(store.get("att-live")?.cleanupState, "held");
  assert.equal(m.calls.filter((c) => c.cmd === "return").length, 0);

  // 3. Only proven emptiness authorises the return.
  const c = restart();
  await c.reconcileOnStartup(async () => "empty");
  assert.equal(store.get("att-live")?.cleanupState, "returned");
  assert.equal(m.trees.find((t) => t.path === path)?.state, "available");
});

test("reconciliation retries a returning row without re-asking about its group", async () => {
  const m = mkManager();
  await acquire(m, "att-resume");
  m.fail.return = true;
  await m.manager.releaseForAttempt("att-resume");
  assert.equal(store.get("att-resume")?.cleanupState, "returning");

  // `returning` means the return was already authorised and recorded; the only thing left is
  // to complete it. Re-asking the group would strand it behind a seam that may not be wired.
  m.fail.return = false;
  const fresh = new CheckLeaseManager(db, { cli: m.cli, pin: async () => {}, verifyBase: async (_r, s) => s });
  let asked = 0;
  await fresh.reconcileOnStartup(async () => { asked++; return "unknown"; });

  assert.equal(asked, 0);
  assert.equal(store.get("att-resume")?.cleanupState, "returned");
});

// ---- reclamation -----------------------------------------------------------

test("reclamation collects a leaked lease and leaves a live attempt's alone", async () => {
  const m = mkManager({ slots: 4 });
  const leakedPath = await acquire(m, "att-leaked");
  const livePath = await acquire(m, "att-running");

  // A leaked row is one nobody is coming back for: this process did not acquire it. Model
  // that the way a restart does, with a manager that has no memory of either.
  const fresh = new CheckLeaseManager(db, { cli: m.cli, pin: async () => {}, verifyBase: async (_r, s) => s });
  fresh.processes.record("att-running", 1234, "ticks-1234");
  await fresh.reclaimLeaked(async (id) => (id === "att-running" ? "not-empty" : "empty"));

  assert.equal(store.get("att-leaked")?.cleanupState, "returned");
  assert.equal(m.trees.find((t) => t.path === leakedPath)?.state, "available");
  assert.equal(store.get("att-running")?.cleanupState, "held", "a running check is not a leak");
  assert.equal(m.trees.find((t) => t.path === livePath)?.holder, checkHolderToken("att-running"));

  // The manager that OWNS a lease never reclaims it, whatever a recovery seam says: it was
  // handed out to a caller that has not released it.
  await m.manager.reclaimLeaked(async () => "empty");
  assert.equal(store.get("att-running")?.cleanupState, "held");

  await m.manager.releaseForAttempt("att-running");
});

test("reclamation is bounded per pass", async () => {
  const m = mkManager({ slots: 5 });
  for (let i = 0; i < 5; i++) await acquire(m, `att-bounded-${i}`);

  const fresh = new CheckLeaseManager(db, {
    cli: m.cli,
    pin: async () => {},
    verifyBase: async (_r, s) => s,
    maxReclaimPerPass: 2,
  });
  await fresh.reclaimLeaked();
  assert.equal(m.trees.filter((t) => t.state === "available").length, 2);

  await fresh.reclaimLeaked();
  await fresh.reclaimLeaked();
  assert.equal(m.trees.filter((t) => t.state === "available").length, 5, "later passes finish the job");
});

// ---- the contracts a later phase consumes ----------------------------------

test("the process registry round-trips identity through the sentinel columns", async () => {
  const m = mkManager();
  await acquire(m, "att-proc");
  assert.equal(store.get("att-proc")?.supervisorPid, 0);

  m.manager.processes.record("att-proc", 51234, "1717171717 mission-check att-proc");
  assert.equal(store.get("att-proc")?.supervisorPid, 51234);
  // Stored and compared, never parsed: its composition belongs to the supervisor.
  assert.equal(store.get("att-proc")?.supervisorStartTicks, "1717171717 mission-check att-proc");

  m.manager.processes.clear("att-proc");
  assert.equal(store.get("att-proc")?.supervisorPid, 0);
  assert.equal(store.get("att-proc")?.supervisorStartTicks, "");

  await m.manager.releaseForAttempt("att-proc");
});

test("unresolvedLeaseForNode answers from the table alone, outliving the attempt", async () => {
  const m = mkManager({ slots: 4 });
  await acquire(m, "att-gate", { submissionId: "sub-gate", nodeId: "node-gate" });

  assert.equal(m.manager.unresolvedLeaseForNode("sub-gate", "node-gate"), true);
  assert.equal(m.manager.unresolvedLeaseForNode("sub-gate", "other-node"), false);

  // A failed return still counts: the resource is still owned, which is the whole point of
  // the gate - a retry would be a NEW attempt id, so it would lease a DIFFERENT tree while
  // this one may still have a writer in it.
  m.fail.return = true;
  await m.manager.releaseForAttempt("att-gate");
  assert.equal(m.manager.unresolvedLeaseForNode("sub-gate", "node-gate"), true);

  m.fail.return = false;
  await m.manager.releaseForAttempt("att-gate");
  assert.equal(m.manager.unresolvedLeaseForNode("sub-gate", "node-gate"), false);

  // And a `lost` row does not gate a retry either: that tree is provably not ours.
  const p = await acquire(m, "att-gate-lost", { submissionId: "sub-gate2", nodeId: "node-gate2" });
  m.trees.find((t) => t.path === p)!.holder = "someone-else";
  await m.manager.releaseForAttempt("att-gate-lost");
  assert.equal(m.manager.unresolvedLeaseForNode("sub-gate2", "node-gate2"), false);
});

test("poolPins contributes no path for a returned or a lost row", async () => {
  // The regression this catches is subtle and would be silent: terminal rows are RETAINED
  // for audit, so a pin query without a state filter would put every path this subsystem
  // ever leased back into the pin set on the next sweep - making a returned tree unreapable
  // forever and quietly undoing the rule that a `lost` row drops its pin.
  const m = mkManager({ slots: 4 });
  installCheckLeasePins(() => m.manager.pinnedPaths());

  const returned = await acquire(m, "att-pin-returned");
  await m.manager.releaseForAttempt("att-pin-returned");

  const lost = await acquire(m, "att-pin-lost");
  m.trees.find((t) => t.path === lost)!.holder = "mission-control";
  await m.manager.releaseForAttempt("att-pin-lost");

  assert.equal(store.get("att-pin-returned")?.cleanupState, "returned");
  assert.equal(store.get("att-pin-lost")?.cleanupState, "lost");
  const pinned = poolPins(new Registry()).checkLeasePaths;
  assert.equal(pinned.includes(returned), false, "a returned tree is not still ours");
  assert.equal(pinned.includes(lost), false, "a lost tree is not ours at all");

  // A live one still pins, or the filter would have thrown out the baby with the bathwater.
  const held = await acquire(m, "att-pin-held");
  assert.deepEqual(poolPins(new Registry()).checkLeasePaths, [held]);
  await m.manager.releaseForAttempt("att-pin-held");
  installCheckLeasePins(null);
});
