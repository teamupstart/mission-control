// A branch update writes to GitHub even when shipping is off. Claim once, fail closed,
// and never reuse checks or reviews from the previous commit.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyFeatureFlagIntent } from "../src/server/feature-flags/index.ts";
import { after, beforeEach, test } from "node:test";
import { openDb, closeDb } from "../src/server/db.ts";
import { branchUpdateEligible, reconcileBranchUpdate, type BranchSnapshot, type BranchUpdateDeps } from "../src/server/github/branch-update.ts";
import type { PrBranchUpdate } from "../src/shared/pr-branch-update.ts";
const url = "https://github.com/acme/demo/pull/1545";
function snapshot(patch: Partial<BranchSnapshot> = {}): BranchSnapshot {
  return { state: "OPEN", isDraft: false, headRefOid: "a".repeat(40), baseRefOid: "b".repeat(40), baseRefName: "main",
    mergeStateStatus: "BEHIND", mergeable: "MERGEABLE", reviewDecision: "APPROVED",
    commits: { nodes: [{ commit: { oid: "a".repeat(40), statusCheckRollup: { contexts: {
      pageInfo: { hasNextPage: false }, nodes: [{ __typename: "StatusContext", context: "ci", state: "SUCCESS" }],
    } } } }] }, ...patch };
}
beforeEach(() => { openDb().exec("DELETE FROM pr_branch_update_attempts"); });
after(() => closeDb());
function fixture() {
  let current = snapshot();
  let enabled = true;
  let owned = true;
  let writes = 0;
  const published: (PrBranchUpdate | null)[] = [];
  const deps: BranchUpdateDeps = { read: async () => current, enabled: () => enabled,
    update: async () => { writes++; return null; } };
  return { deps, published, get writes() { return writes; }, set current(pr: BranchSnapshot) { current = pr; },
    set enabled(value: boolean) { enabled = value; }, set owned(value: boolean) { owned = value; },
    tick: () => reconcileBranchUpdate(url, "/tmp", u => published.push(u), () => owned, deps) };
}
test("only GitHub-required, non-draft, otherwise ready PRs qualify", () => {
  assert.equal(branchUpdateEligible(snapshot()), true);
  assert.equal(branchUpdateEligible(snapshot({ reviewDecision: null })), true);
  for (const patch of [{ state: "CLOSED" }, { state: "MERGED" }, { isDraft: true }, { mergeStateStatus: "CLEAN" },
    { mergeStateStatus: "BLOCKED" }, { mergeStateStatus: "UNKNOWN" }, { mergeable: "CONFLICTING" },
    { mergeable: "UNKNOWN" }, { reviewDecision: "REVIEW_REQUIRED" }, { reviewDecision: "CHANGES_REQUESTED" }] as Partial<BranchSnapshot>[]) {
    assert.equal(branchUpdateEligible(snapshot(patch)), false, JSON.stringify(patch));
  }
  for (const state of ["PENDING", "FAILURE", "ERROR", "UNRECOGNIZED"]) {
    const pr = snapshot();
    pr.commits.nodes[0]!.commit.statusCheckRollup!.contexts.nodes = [{ __typename: "StatusContext", context: "ci", state }];
    assert.equal(branchUpdateEligible(pr), false, state);
  }
  const incomplete = snapshot(); incomplete.commits.nodes[0]!.commit.statusCheckRollup!.contexts.pageInfo.hasNextPage = true;
  assert.equal(branchUpdateEligible(incomplete), false);
  const stale = snapshot(); stale.commits.nodes[0]!.commit.oid = "c".repeat(40);
  assert.equal(branchUpdateEligible(stale), false);
});
test("claims before writing, deduplicates concurrent polls and persists across restart", async () => {
  const f = fixture();
  await Promise.all([f.tick(), f.tick()]);
  assert.equal(f.writes, 1);
  assert.equal(f.published.at(-1)?.status, "updating");
  closeDb();
  await f.tick(); assert.equal(f.writes, 1);
  f.current = snapshot({ baseRefOid: "c".repeat(40) });
  await f.tick(); assert.equal(f.writes, 2);
  f.current = snapshot({ baseRefOid: "b".repeat(40) });
  await f.tick(); assert.equal(f.writes, 2, "returning to an attempted pair is still deduplicated");
});
test("a new ready head on the same target gets one fresh guarded update through the real adapter", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mission-pr-update-new-head-"));
  const gh = join(dir, "gh.cjs");
  const calls = join(dir, "calls.jsonl");
  const snapshotPath = join(dir, "snapshot.json");
  const previousGh = process.env.MISSION_GH_BIN;
  const original = snapshot();
  writeFileSync(snapshotPath, JSON.stringify(original));
  // Keep the reconciler, durable claims, GraphQL reader and PUT adapter real.
  // Only GitHub's executable is faked, so the recorded writes include the actual SHA guard.
  writeFileSync(gh, `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
if (args[0] === "api" && args[1] === "graphql") {
  const pullRequest = JSON.parse(fs.readFileSync(${JSON.stringify(snapshotPath)}, "utf8"));
  process.stdout.write(JSON.stringify({ data: { repository: { pullRequest } } }));
} else if (args[0] === "api" && args[1] === "--method" && args[2] === "PUT") {
  process.stdout.write('{"message":"Updating pull request branch."}');
} else {
  process.stderr.write("Unexpected fake gh command");
  process.exitCode = 2;
}
`, { mode: 0o755 });
  process.env.MISSION_GH_BIN = gh;
  applyFeatureFlagIntent({ kind: "flag", id: "automatic-pr-branch-update", enabled: true });
  try {
    const published: (PrBranchUpdate | null)[] = [];
    const tick = () => reconcileBranchUpdate(url, dir, update => published.push(update), () => true);
    const argv = () => readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
    const guardedUpdate = (head: string) => [
      "api", "--method", "PUT", "repos/acme/demo/pulls/1545/update-branch", "-f", `expected_head_sha=${head}`,
    ];
    await tick();
    await tick();
    assert.deepEqual(argv().filter(args => args[1] !== "graphql"), [guardedUpdate(original.headRefOid)]);
    const priorCalls = argv().length;

    // Only the PR head changes. Its own checks pass and its required review is approved,
    // but GitHub still requires it to catch up with the unchanged target commit.
    const next = snapshot({ headRefOid: "c".repeat(40) });
    next.commits.nodes[0]!.commit.oid = next.headRefOid;
    writeFileSync(snapshotPath, JSON.stringify(next));
    await tick();
    await tick();
    await tick();
    assert.deepEqual(argv().filter(args => args[1] !== "graphql"), [
      guardedUpdate(original.headRefOid), guardedUpdate(next.headRefOid),
    ], "each head gets exactly one update guarded by its own SHA, even across repeated polls");
    assert.deepEqual(argv().slice(priorCalls).map(args => args[1]), [
      "graphql", "graphql", "--method", "graphql", "graphql",
    ], "the new head is read and rechecked before its update; subsequent polls only read");
    assert.deepEqual(published.at(-1), { status: "updating", reason: null });
  } finally {
    applyFeatureFlagIntent({ kind: "flag", id: "automatic-pr-branch-update", enabled: false });
    if (previousGh === undefined) delete process.env.MISSION_GH_BIN;
    else process.env.MISSION_GH_BIN = previousGh;
    rmSync(dir, { recursive: true, force: true });
  }
});
test("head/target/eligibility changes during recheck abstain; disabled or removed ownership cannot write", async () => {
  for (const change of [{ headRefOid: "c".repeat(40) }, { baseRefOid: "d".repeat(40) },
    { baseRefName: "release" }, { isDraft: true }, { reviewDecision: "REVIEW_REQUIRED" }] as Partial<BranchSnapshot>[]) {
    const f = fixture(); let reads = 0;
    f.deps.read = async () => snapshot(++reads === 1 ? {} : change);
    await f.tick(); assert.equal(f.writes, 0);
  }
  for (const field of ["enabled", "owned"] as const) {
    const f = fixture(); let reads = 0;
    f.deps.read = async () => { if (++reads === 2) f[field] = false; return snapshot(); };
    await f.tick(); assert.equal(f.writes, 0);
  }
});
test("checks becoming pending during the final recheck prevent an update for unchanged commits", async () => {
  const f = fixture(); let reads = 0;
  f.deps.read = async () => {
    const pr = snapshot();
    if (++reads === 2) {
      pr.commits.nodes[0]!.commit.statusCheckRollup!.contexts.nodes = [{ __typename: "StatusContext", context: "ci", state: "PENDING" }];
    }
    return pr;
  };
  await f.tick();
  assert.equal(reads, 2, "passing checks on the first snapshot must reach the final recheck");
  assert.equal(f.writes, 0, "pending checks on the same head and target must prevent the update");
});
test("a complete empty check set allows an otherwise ready PR to update after recheck", async () => {
  const f = fixture(); let reads = 0;
  const pr = snapshot();
  pr.commits.nodes[0]!.commit.statusCheckRollup!.contexts.nodes = [];
  f.deps.read = async () => { reads++; return pr; };
  assert.equal(branchUpdateEligible(pr), true);
  await f.tick();
  assert.equal(reads, 2, "an empty check set must still be rechecked before updating");
  assert.equal(f.writes, 1);
  assert.deepEqual(f.published.at(-1), { status: "updating", reason: null });
  await f.tick();
  assert.equal(f.writes, 1, "an empty check set must not bypass attempt deduplication");
});
test("confirmed new head follows its checks and required reviews before clearing", async () => {
  const f = fixture(); await f.tick();
  const next = snapshot({ headRefOid: "d".repeat(40), mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED" });
  next.commits.nodes[0]!.commit.oid = next.headRefOid;
  next.commits.nodes[0]!.commit.statusCheckRollup!.contexts.nodes = [{ __typename: "StatusContext", context: "ci", state: "PENDING" }];
  f.current = next; await f.tick(); assert.equal(f.published.at(-1)?.status, "checks");
  next.commits.nodes[0]!.commit.statusCheckRollup!.contexts.nodes = [{ __typename: "StatusContext", context: "ci", state: "SUCCESS" }];
  await f.tick(); assert.equal(f.published.at(-1)?.status, "review");
  next.reviewDecision = "APPROVED"; next.mergeStateStatus = "CLEAN";
  await f.tick(); assert.equal(f.published.at(-1), null); assert.equal(f.writes, 1);
});
test("conflict, refusal and unknown outcomes remain visible without retries", async () => {
  for (const status of ["conflict", "blocked"] as const) {
    openDb().exec("DELETE FROM pr_branch_update_attempts");
    const f = fixture(); let writes = 0;
    f.deps.update = async () => { writes++; return { status, reason: "GitHub refused the update" }; };
    await f.tick(); await f.tick();
    assert.equal(writes, 1); assert.deepEqual(f.published.at(-1), { status, reason: "GitHub refused the update" });
  }
  openDb().exec("DELETE FROM pr_branch_update_attempts");
  const f = fixture(); let writes = 0;
  f.deps.update = async () => { writes++; throw new Error("timeout"); };
  await f.tick(); await f.tick(); assert.equal(writes, 1); assert.match(f.published.at(-1)!.reason!, /unknown/);
});
test("missing or incomplete checks hold; accepted but unconfirmed updates become a visible blocker, never a retry", async () => {
  const empty = snapshot(); empty.commits.nodes[0]!.commit.statusCheckRollup = null;
  assert.equal(branchUpdateEligible(empty), false);
  empty.commits.nodes[0]!.commit.statusCheckRollup = { contexts: { pageInfo: { hasNextPage: true }, nodes: [] } };
  assert.equal(branchUpdateEligible(empty), false);
  empty.commits.nodes[0]!.commit.statusCheckRollup = { contexts: { pageInfo: { hasNextPage: false }, nodes: [null] } };
  assert.equal(branchUpdateEligible(empty), false);
  const f = fixture(); await f.tick();
  openDb().prepare("UPDATE pr_branch_update_attempts SET attempted_at = ?").run(Date.now() - 180_000);
  await f.tick(); assert.equal(f.writes, 1); assert.equal(f.published.at(-1)?.status, "blocked");
  assert.match(f.published.at(-1)!.reason!, /not confirmed/);
});

test("CLEAN clears a stored refusal without forgetting the attempted commit pair", async () => {
  for (const status of ["blocked", "conflict"] as const) {
    openDb().exec("DELETE FROM pr_branch_update_attempts");
    const f = fixture(); let writes = 0;
    const refusal = { status, reason: "GitHub refused the update" };
    f.deps.update = async () => { writes++; return refusal; };
    await f.tick();
    f.current = snapshot({ mergeStateStatus: "UNKNOWN" });
    await f.tick(); assert.deepEqual(f.published.at(-1), refusal);
    f.current = snapshot({ mergeStateStatus: "CLEAN" });
    await f.tick(); assert.equal(f.published.at(-1), null);
    closeDb();
    await f.tick(); assert.equal(f.published.at(-1), null);
    f.current = snapshot();
    await f.tick(); assert.equal(writes, 1, "clearing stale feedback must not authorize another write");
  }
});


for (const outcome of [
  { label: "non-conflict GitHub refusal", reason: "Resource not accessible by integration (HTTP 403)", unknown: false },
  { label: "unknown command outcome", reason: "Branch update outcome unknown. GitHub may have accepted the update; check the PR before retrying.", unknown: true },
]) test(`real update adapter publishes a ${outcome.label} and never retries the commit pair`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "mission-pr-update-refusal-"));
  const gh = join(dir, "gh.cjs");
  const calls = join(dir, "calls.jsonl");
  const previousGh = process.env.MISSION_GH_BIN;
  const reason = outcome.reason;
  // Fake only the external executable. Use the real flag, GraphQL reader, PUT adapter,
  // reason extraction and durable reconciler, with no injected BranchUpdateDeps.
  writeFileSync(gh, `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
if (args[0] === "api" && args[1] === "graphql") {
  process.stdout.write(${JSON.stringify(JSON.stringify({ data: { repository: { pullRequest: snapshot() } } }))});
} else if (args[0] === "api" && args[1] === "--method" && args[2] === "PUT") {
  if (${outcome.unknown}) process.kill(process.pid, "SIGTERM");
  else {
    process.stdout.write("update request refused");
    process.stderr.write(${JSON.stringify(`gh: ${reason}`)});
    process.exitCode = 1;
  }
} else {
  process.stderr.write("Unexpected fake gh command");
  process.exitCode = 2;
}
`, { mode: 0o755 });
  process.env.MISSION_GH_BIN = gh;
  applyFeatureFlagIntent({ kind: "flag", id: "automatic-pr-branch-update", enabled: true });
  try {
    const published: (PrBranchUpdate | null)[] = [];
    const tick = () => reconcileBranchUpdate(url, dir, update => published.push(update), () => true);
    await tick();
    assert.deepEqual(published, [null, { status: "updating", reason: null }, { status: "blocked", reason }]);
    await tick();
    assert.deepEqual(published.at(-1), { status: "blocked", reason });
    const argv = readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
    assert.equal(argv.filter(args => args[1] === "graphql").length, 3, "eligibility is re-read before writing and on the next poll");
    assert.deepEqual(argv.filter(args => args[1] !== "graphql"), [[
      "api", "--method", "PUT", "repos/acme/demo/pulls/1545/update-branch", "-f", `expected_head_sha=${"a".repeat(40)}`,
    ]], "the refused update is attempted exactly once, using the expected head guard");
  } finally {
    applyFeatureFlagIntent({ kind: "flag", id: "automatic-pr-branch-update", enabled: false });
    if (previousGh === undefined) delete process.env.MISSION_GH_BIN;
    else process.env.MISSION_GH_BIN = previousGh;
    rmSync(dir, { recursive: true, force: true });
  }
});
