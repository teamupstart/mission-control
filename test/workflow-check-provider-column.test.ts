/**
 * `workflow_check_leases.provider` - what wrote it, what reads it, and why it is read from the
 * ROW rather than from the machine.
 *
 * A check's tree is taken by one mechanism and has to be handed back by that same one. Those
 * two moments are minutes apart, and on a developer's machine the answer to "is treehouse
 * installed?" can change in between - an uninstall, a reinstall, a PATH edit. Both directions
 * of a re-decision are destructive: a pooled tree handed to `git worktree remove` costs a pool
 * slot permanently, and a plain worktree handed to `treehouse return --force` is a hard reset
 * of a directory the pool has never heard of. The column is what makes the release path
 * independent of the current machine, so it is asserted here as three separate claims:
 *
 *   1. An existing database gains the column, and its rows read back as `treehouse` - which is
 *      what they factually are, since the pool was the only way a check could get a tree.
 *   2. A new lease records the provider that actually took it.
 *   3. A release routes on the RECORDED value, proven when current acquisition would choose
 *      a different provider and when a row names a provider this build cannot reach.
 *
 * The pool is faked throughout, the way every other check suite fakes it. This file is about
 * the bookkeeping, not about treehouse.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A fresh state dir BEFORE anything that resolves it is imported, and `realpathSync` because
// $TMPDIR is a symlink into /private on macOS and the lease manager canonicalizes every path
// it stores (see workflow-check-lease.test.ts).
const home = realpathSync(mkdtempSync(join(tmpdir(), "mission-check-provider-")));
process.env.HARNESS_HOME = home;

/**
 * A PRE-MIGRATION database, written by hand: `workflow_check_leases` exactly as it shipped,
 * with no `provider` column, holding a live row.
 *
 * This is the upgrade path a real operator takes, not a simulation of it. The schema block in
 * `db.ts` is `CREATE TABLE IF NOT EXISTS`, so it will leave this table alone - which is
 * precisely why the column has to arrive through `migrate()` as well, and why a test that
 * seeded the current schema would prove nothing.
 */
const LEGACY_TREE = join(home, "legacy-pool-tree");
mkdirSync(LEGACY_TREE, { recursive: true });
const raw = new DatabaseSync(join(home, "harness.db"));
raw.exec(`
  CREATE TABLE workflow_check_leases (
    attempt_id             TEXT    NOT NULL PRIMARY KEY,
    submission_id          TEXT    NOT NULL,
    node_id                TEXT    NOT NULL,
    repo_root              TEXT    NOT NULL,
    lease_path             TEXT    NOT NULL,
    holder_token           TEXT    NOT NULL,
    cleanup_state          TEXT    NOT NULL,
    supervisor_pid         INTEGER NOT NULL,
    supervisor_start_ticks TEXT    NOT NULL,
    created_at             INTEGER NOT NULL,
    updated_at             INTEGER NOT NULL
  );
  INSERT INTO workflow_check_leases
    (attempt_id, submission_id, node_id, repo_root, lease_path, holder_token,
     cleanup_state, supervisor_pid, supervisor_start_ticks, created_at, updated_at)
  VALUES ('legacy-att', 'legacy-sub', 'gate', '${home}', '${LEGACY_TREE}',
          'mission-control-check-legacy-att', 'held', 0, '', 1234, 1234);
`);
raw.close();

const { openDb } = await import("../src/server/db.ts");
const { CheckLeaseManager, CheckLeaseStore } = await import("../src/server/workflows/check-lease.ts");
const { checkHolderToken } = await import("../src/server/pool-lease.ts");
const { stubRun } = await import("../src/server/util/exec.ts");

type TreehouseCli = import("../src/server/pool-lease.ts").TreehouseCli;

const db = openDb();
const store = new CheckLeaseStore(db);
const SHA = "b".repeat(40);
const TREEHOUSE_PRESENT = async () => true;

const providerOf = (attemptId: string): unknown =>
  (
    db
      .prepare(`SELECT provider FROM workflow_check_leases WHERE attempt_id = ?`)
      .get(attemptId) as { provider: unknown } | undefined
  )?.provider;

after(() => rmSync(home, { recursive: true, force: true }));

// ---- a fake pool -----------------------------------------------------------

/** One slot, modelled: `get` hands it out and stamps the holder, `return` frees it. */
function fakePool(dir: string) {
  const path = join(dir, "tree");
  mkdirSync(path, { recursive: true });
  const slot = { state: "available", holder: null as string | null };
  const calls: string[] = [];
  const cli: TreehouseCli = {
    status: async () => {
      calls.push("status");
      return stubRun({
        stdout: `1     ${slot.state}       ${path}${slot.holder ? `  (held by ${slot.holder})` : ""}`,
        stderr: "",
        code: 0,
      });
    },
    get: async (_repoRoot, holder) => {
      calls.push("get");
      if (slot.state !== "available") return stubRun({ stdout: "", stderr: "no trees", code: 1 });
      slot.state = "leased";
      slot.holder = holder;
      return stubRun({ stdout: `${path}\n`, stderr: "", code: 0 });
    },
    return: async () => {
      calls.push("return");
      slot.state = "available";
      slot.holder = null;
      return stubRun({ stdout: "", stderr: "", code: 0 });
    },
  };
  return { cli, calls, slot, path };
}

let seq = 0;
function mkManager() {
  const dir = mkdtempSync(join(home, `pool-${seq++}-`));
  const pool = fakePool(dir);
  const manager = new CheckLeaseManager(db, {
    cli: pool.cli,
    pin: async () => {},
    verifyBase: async (_repoRoot, sha) => sha,
    treehouseInstalled: TREEHOUSE_PRESENT,
  });
  return { ...pool, manager, repoRoot: dir };
}

// ---- 1. the migration ------------------------------------------------------

test("an existing lease table gains the provider column and backfills it truthfully", () => {
  const columns = db.prepare("PRAGMA table_info(workflow_check_leases)").all() as unknown as Array<{
    name: string;
    notnull: number;
    dflt_value: unknown;
  }>;
  const provider = columns.find((c) => c.name === "provider");
  assert.ok(provider, "the pre-migration table did not gain the column");
  // NOT NULL with a real default, which is what keeps this clear of the trap the table's own
  // comment warns about: a nullable column whose NULL cannot be told apart from a row written
  // by a build that did not set it. Here the release path would have to guess.
  assert.equal(provider.notnull, 1);
  assert.equal(provider.dflt_value, "'treehouse'");

  // And the legacy row reads back as what it FACTUALLY is. Every row that could exist before
  // this column did was written by a build in which the pool was the only source of a tree.
  const row = store.get("legacy-att");
  assert.equal(row?.provider, "treehouse");
  assert.equal(row?.cleanupState, "held", "the migration must not disturb the lifecycle");
  assert.equal(row?.leasePath, LEGACY_TREE);
  assert.equal(row?.holderToken, checkHolderToken("legacy-att"));
});

test("the migration leaves the live-scoped partial index in place", () => {
  // The index and the column are independent, and the column arriving must not have cost the
  // scoping. Unscoped, the second check ever handed a given pool slot fails its INSERT
  // forever - see the case in workflow-check-lease.test.ts that decides this index's shape.
  const sql = (
    db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name=?`)
      .get("idx_workflow_check_leases_path") as { sql: string | null } | undefined
  )?.sql;
  assert.ok(sql, "the unique lease-path index is missing on an upgraded database");
  assert.match(sql, /WHERE cleanup_state IN \('held', 'returning'\)/);
});

// ---- 2. what an acquisition records ----------------------------------------

test("a new lease records the provider that took its tree", async () => {
  const m = mkManager();
  const path = await m.manager.acquireForAttempt({
    attemptId: "att-records",
    submissionId: "sub-records",
    nodeId: "gate",
    repoRoot: m.repoRoot,
    headSha: SHA,
  });
  assert.equal(path, m.path);

  assert.equal(store.get("att-records")?.provider, "treehouse");
  // Read from the column itself as well as through the row mapper, because a mapper that
  // returned a constant would satisfy the assertion above on its own.
  assert.equal(providerOf("att-records"), "treehouse");

  assert.deepEqual(await m.manager.releaseForAttempt("att-records"), { outcome: "returned" });
  assert.equal(store.get("att-records")?.cleanupState, "returned");
  // The provider is retained on the terminal row, alongside the rest of the audit trail.
  assert.equal(store.get("att-records")?.provider, "treehouse");
  assert.equal(m.slot.state, "available");
});

// ---- 3. what a release routes on ---------------------------------------------

test("a release routes on the recorded provider, not on what this machine has", async () => {
  // The one case where routing and probing give different answers, which is what makes this a
  // test of the contract rather than of a tautology: the row names a provider this build has
  // no implementation for. Probing would find treehouse - it is what the manager was
  // constructed with - and hand it a path the pool has never heard of.
  const m = mkManager();
  db.prepare(
    `INSERT INTO workflow_check_leases
       (attempt_id, submission_id, node_id, repo_root, lease_path, holder_token,
        cleanup_state, supervisor_pid, supervisor_start_ticks, provider, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'held', 0, '', ?, ?, ?)`,
  ).run(
    "att-foreign",
    "sub-foreign",
    "gate",
    m.repoRoot,
    join(home, "a-tree-treehouse-never-heard-of"),
    checkHolderToken("att-foreign"),
    "some-later-provider",
    5678,
    5678,
  );

  await assert.rejects(
    () => m.manager.releaseForAttempt("att-foreign"),
    /took .* from the "some-later-provider" provider, which this build cannot reach/,
  );

  // Nothing was asked of treehouse - not even a status read, because the refusal happens
  // before a mechanism is chosen at all.
  assert.deepEqual(m.calls, [], "a foreign row must not reach the pool adapter");
  // And the refusal is the FAIL-CLOSED direction: the row stays live, so the pin stays and
  // reclamation keeps the tree. `CheckRuntime` reads the throw as an unresolved cleanup, so
  // the attempt is not forgotten - it is simply not destroyed by a guess.
  const row = store.get("att-foreign");
  assert.equal(row?.cleanupState, "held");
  assert.equal(row?.provider, "some-later-provider");
  assert.ok(
    m.manager.pinnedPaths().includes(join(home, "a-tree-treehouse-never-heard-of")),
    "a tree we refused to release is still ours, so it is still pinned",
  );
});

test("a treehouse row is released through treehouse when the current machine would choose git", async () => {
  // A second manager over the same table is what a restart looks like. The point is that
  // nothing re-derives the column: the row that a treehouse build wrote still says treehouse,
  // and that is the value the next release will route on.
  const m = mkManager();
  await m.manager.acquireForAttempt({
    attemptId: "att-restart",
    submissionId: "sub-restart",
    nodeId: "gate",
    repoRoot: m.repoRoot,
    headSha: SHA,
  });

  let probes = 0;
  const restarted = new CheckLeaseManager(db, {
    cli: m.cli,
    pin: async () => {},
    verifyBase: async (_r, s) => s,
    treehouseInstalled: async () => {
      probes++;
      return false;
    },
  });
  assert.equal(store.get("att-restart")?.provider, "treehouse");
  assert.deepEqual(await restarted.releaseForAttempt("att-restart"), { outcome: "returned" });
  assert.equal(providerOf("att-restart"), "treehouse", "a release must never rewrite it");
  assert.equal(m.slot.state, "available");
  assert.ok(m.calls.includes("return"), "the recorded provider is the one that acted");
  assert.equal(probes, 0, "release re-probed the machine instead of reading the row");
});

test("a treehouse row fails closed when the binary vanishes", async () => {
  const m = mkManager();
  const path = await m.manager.acquireForAttempt({
    attemptId: "att-vanished",
    submissionId: "sub-vanished",
    nodeId: "gate",
    repoRoot: m.repoRoot,
    headSha: SHA,
  });

  let statusReads = 0;
  let probes = 0;
  const missingBinary: TreehouseCli = {
    ...m.cli,
    status: async () => {
      statusReads++;
      return stubRun({ stdout: "", stderr: "spawn treehouse ENOENT", code: 1 });
    },
  };
  const restarted = new CheckLeaseManager(db, {
    cli: missingBinary,
    pin: async () => {},
    verifyBase: async (_r, s) => s,
    treehouseInstalled: async () => {
      probes++;
      return false;
    },
  });

  const outcome = await restarted.releaseForAttempt("att-vanished");
  assert.equal(outcome.outcome, "retry");
  assert.match(outcome.outcome === "retry" ? outcome.reason : "", /treehouse status exited 1/);
  assert.equal(statusReads, 1, "the recorded treehouse provider was not asked about ownership");
  assert.equal(probes, 0, "release re-probed the machine instead of reading the row");
  assert.equal(store.get("att-vanished")?.cleanupState, "held");
  assert.equal(store.get("att-vanished")?.provider, "treehouse");
  assert.ok(restarted.pinnedPaths().includes(path), "an unreadable treehouse row lost its pin");
  assert.equal(m.calls.filter((call) => call === "return").length, 0, "an unreadable row was returned");

  // Restore the provider only for test cleanup. The asserted state above is the product's
  // deliberate outcome until the real binary becomes available again.
  assert.deepEqual(await m.manager.releaseForAttempt("att-vanished"), { outcome: "returned" });
});
