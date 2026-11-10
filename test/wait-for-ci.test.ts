/**
 * Wait for CI, below the runtime: how CI is read, stored, decided and placed.
 *
 * - The Inspector's ONE PR query reads the head commit's check runs, and `fetchPr` maps them
 *   (driven here through a fake `gh`, so the query text and the mapping are both exercised).
 * - The observation is stored beside the adoption row, keyed to the commit it was read for,
 *   through a migration an existing database has to survive.
 * - `decideWaitForCi` is pure, so every outcome is stated with no daemon at all.
 * - Graph validation only accepts the node after a Pull Request action's `complete` route,
 *   and a path through it to End is still a shipping-only continuation.
 *
 * The runtime (engine, manager, repair packet, retry, disable) is in
 * `test/session-action-runtime.test.ts`, which already drives a real Pull Request action.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const home = mkdtempSync(join(tmpdir(), "mission-wait-for-ci-"));
process.env.MISSION_HOME = home;
// The fake `gh`: prints whatever the test last wrote, and records the query it was asked.
const ghDir = mkdtempSync(join(tmpdir(), "mission-wait-for-ci-gh-"));
const ghBin = join(ghDir, "gh");
writeFileSync(ghBin, `#!/bin/sh\nprintf '%s' "$@" > "${ghDir}/args"\ncat "${ghDir}/response.json"\n`);
chmodSync(ghBin, 0o755);
process.env.MISSION_GH_BIN = ghBin;
after(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(ghDir, { recursive: true, force: true });
});

/** An `inspector_prs` from before the CI column, written out verbatim. */
function seedPreCiDb(): void {
  const raw = new DatabaseSync(join(home, "harness.db"));
  raw.exec(`
    CREATE TABLE IF NOT EXISTS inspector_prs (
      key TEXT PRIMARY KEY, url TEXT NOT NULL, owner TEXT NOT NULL, repo TEXT NOT NULL,
      number INTEGER NOT NULL, repo_root TEXT, cwd TEXT, session_id TEXT, source TEXT NOT NULL,
      state TEXT NOT NULL, head_sha TEXT, review_posture TEXT, round INTEGER NOT NULL DEFAULT 0,
      last_reviewed_at INTEGER, last_error TEXT, fail_count INTEGER NOT NULL DEFAULT 0,
      last_fail_kind TEXT, next_attempt_at INTEGER, last_attempt_sha TEXT, merged_at INTEGER,
      merge_block TEXT, observed_head_sha TEXT, observed_state TEXT, observed_at INTEGER,
      head_ref_name TEXT, title TEXT, adopted_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
  raw.prepare(
    `INSERT INTO inspector_prs (key, url, owner, repo, number, source, state, adopted_at, updated_at)
     VALUES ('owner/repo#7', 'https://github.com/owner/repo/pull/7', 'owner', 'repo', 7, 'hook', 'open', 1, 1)`,
  ).run();
  raw.close();
}
seedPreCiDb();

const { openDb, getInspectorCiObservation, getInspectorPr, recordInspectorCiObservation } =
  await import("../src/server/db.ts");
const { fetchPr } = await import("../src/server/inspector/github.ts");
const {
  CI_CHECK_SUMMARY_CHARS,
  WAIT_FOR_CI_LEGACY_SETTINGS,
  WAIT_FOR_CI_NEW_NODE_SETTINGS,
  WAIT_FOR_CI_QUIET_MINUTES,
  WAIT_FOR_CI_QUIET_GRACE_MS,
  WaitForCiStateSchema,
  ciCheckRunsFromRollup,
  decideWaitForCi,
  initialWaitForCiState,
  waitForCiSettings,
} = await import("../src/shared/wait-for-ci.ts");
const { CI_STRICTNESS, requiredChecksRollup } = await import("../src/shared/ci-checks.ts");
const { validateWorkflowGraph } = await import("../src/shared/workflow-graph.ts");
const { sessionActionContinuationReachesOnlyEnd, waitForCiFollows } = await import(
  "../src/shared/workflow.ts"
);
const { waitForCiVerdict } = await import("../src/server/workflows/engine.ts");
const { WorkflowDraftNodeSchema } = await import("../src/shared/protocol.ts");
import type { CiCheckRun, CiObservation } from "../src/shared/wait-for-ci.ts";
import type { WorkflowDraftGraph, PublishedWorkflowGraph } from "../src/shared/workflow.ts";

openDb();

const HEAD = "a".repeat(40);
// ---- reading CI --------------------------------------------------------------------------

test("the rollup maps check runs and legacy statuses, and cuts a long summary", () => {
  const summary = "x".repeat(CI_CHECK_SUMMARY_CHARS * 2);
  const { checkRuns, totalCount } = ciCheckRunsFromRollup([
    { name: "unit", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://ci/unit", title: "ok", summary: "fine", isRequired: true },
    { name: "e2e", status: "IN_PROGRESS", conclusion: null, detailsUrl: null, title: null, summary: null },
    { name: "lint", status: "COMPLETED", conclusion: "TIMED_OUT", detailsUrl: "https://ci/lint", title: "slow", summary: null },
    { name: "docs", status: "COMPLETED", conclusion: "SKIPPED" },
    { name: "report", status: "COMPLETED", conclusion: "NEUTRAL", title: "1 note", summary },
    { context: "legacy/ci", state: "ERROR", targetUrl: "https://legacy", description: "broke", isRequired: true },
    { context: "legacy/pending", state: "EXPECTED", isRequired: false },
    { unknown: true },
  ], 140);
  assert.deepEqual(checkRuns.map((run) => [run.name, run.state, run.conclusion]), [
    ["unit", "passing", "SUCCESS"],
    ["e2e", "pending", null],
    ["lint", "failing", "TIMED_OUT"],
    ["docs", "passing", "SKIPPED"],
    ["report", "passing", "NEUTRAL"],
    ["legacy/ci", "failing", "ERROR"],
    ["legacy/pending", "pending", null],
  ]);
  assert.equal(totalCount, 140);
  // Only `isRequired: true` is stored, on both shapes; false or absent leaves the key absent.
  assert.deepEqual(checkRuns.filter((run) => "required" in run).map((run) => [run.name, run.required]), [
    ["unit", true],
    ["legacy/ci", true],
  ]);
  const stored = checkRuns.find((run) => run.name === "report")!;
  assert.equal(stored.summary!.length, CI_CHECK_SUMMARY_CHARS);
  assert.ok(stored.summary!.endsWith("..."));
});

test("a total count GitHub did not give, or gave malformed, reads as null", () => {
  for (const total of [undefined, null, -1, 2.5, "140"]) {
    assert.equal(ciCheckRunsFromRollup([], total).totalCount, null, String(total));
  }
  assert.equal(ciCheckRunsFromRollup([], 0).totalCount, 0);
});

test("fetchPr reads CI from the same query as the head, keyed to the head commit", async () => {
  writeFileSync(join(ghDir, "response.json"), JSON.stringify({
    data: { repository: { pullRequest: {
      state: "OPEN", headRefOid: HEAD, headRefName: "feature", isDraft: false, title: "t", body: "",
      createdAt: "2026-01-01T00:00:00Z", mergeable: "MERGEABLE", reviewDecision: null,
      commits: { nodes: [{ commit: { oid: HEAD, statusCheckRollup: { state: "FAILURE", contexts: { totalCount: 2, nodes: [
        { name: "unit", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://ci/unit", title: "2 failed", summary: "a.test.ts", isRequired: true },
        { name: "lint", status: "COMPLETED", conclusion: "NEUTRAL", title: "1 warning", summary: "style", isRequired: false },
      ] } } } }] },
      reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      reviews: { nodes: [], pageInfo: { hasPreviousPage: false, startCursor: null } },
    } } },
  }));
  const result = await fetchPr(null, "owner", "repo", 7);
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  const snapshot = result.ok ? result.value! : null;
  assert.equal(snapshot?.checks, "failing");
  assert.equal(snapshot?.ci?.headSha, HEAD);
  assert.deepEqual(snapshot?.ci?.checkRuns.map((run) => [run.name, run.state]), [
    ["unit", "failing"],
    ["lint", "passing"],
  ]);
  assert.equal(snapshot?.ci?.totalCount, 2);
  assert.deepEqual(snapshot?.ci?.checkRuns.map((run) => run.required), [true, undefined]);
});

test("the PR query asks for isRequired on both check shapes and the total count, in the one query", async () => {
  // The fake gh records its argv; the query is the same one fetchPr sends for the head.
  await fetchPr(null, "owner", "repo", 7);
  const args = readFileSync(join(ghDir, "args"), "utf8");
  const query = args.slice(args.indexOf("query="), args.indexOf("owner=owner"));
  assert.match(query, /contexts\(first:100\)\{ totalCount nodes\{/);
  assert.match(query, /\.\.\. on CheckRun\{[^}]*\bisRequired\(pullRequestNumber:\$number\)/);
  assert.match(query, /\.\.\. on StatusContext\{[^}]*\bisRequired\(pullRequestNumber:\$number\)/);
  // Still the one PR query: the head, CI, threads and reviews all come back together.
  assert.match(query, /headRefOid/);
  assert.match(query, /reviewThreads\(first:100\)/);
});

test("the observation survives an upgraded database and reads back only while it parses", () => {
  // The row written before the column existed is still whole, and reads as "not looked at".
  assert.equal(getInspectorPr("owner/repo#7")?.url, "https://github.com/owner/repo/pull/7");
  assert.equal(getInspectorCiObservation("owner/repo#7"), null);
  const observation: CiObservation = {
    headSha: HEAD,
    observedAt: 5,
    checkRuns: [{ name: "unit", state: "passing", conclusion: "SUCCESS", detailsUrl: null, title: null, summary: null }],
  };
  // Written before `required` and `totalCount` existed: still parses, nothing marked.
  recordInspectorCiObservation("owner/repo#7", observation);
  const legacy = getInspectorCiObservation("owner/repo#7");
  assert.deepEqual(legacy, observation);
  assert.equal(legacy?.totalCount, undefined);
  assert.equal(requiredChecksRollup(legacy!.checkRuns), null);
  const current: CiObservation = {
    ...observation,
    checkRuns: [{ ...observation.checkRuns[0]!, required: true }],
    totalCount: 1,
  };
  recordInspectorCiObservation("owner/repo#7", current);
  assert.deepEqual(getInspectorCiObservation("owner/repo#7"), current);
  // The total the rollup returns when GitHub gave no usable one: stored, not refused.
  const unknownTotal: CiObservation = { ...current, totalCount: null };
  recordInspectorCiObservation("owner/repo#7", unknownTotal);
  assert.deepEqual(getInspectorCiObservation("owner/repo#7"), unknownTotal);
  assert.equal(getInspectorCiObservation("owner/repo#404"), null);
  openDb().prepare("UPDATE inspector_prs SET observed_ci_json = '{\"nope\":1}' WHERE key = 'owner/repo#7'").run();
  assert.equal(getInspectorCiObservation("owner/repo#7"), null);
});

test("a fetched snapshot's CI is stored with its total and required flags, or a null total", async () => {
  const respond = (contexts: Record<string, unknown>) => writeFileSync(join(ghDir, "response.json"), JSON.stringify({
    data: { repository: { pullRequest: {
      state: "OPEN", headRefOid: HEAD, headRefName: "feature", isDraft: false, title: "t", body: "",
      createdAt: "2026-01-01T00:00:00Z", mergeable: "MERGEABLE", reviewDecision: null,
      commits: { nodes: [{ commit: { oid: HEAD, statusCheckRollup: { state: "PENDING", contexts } } }] },
      reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      reviews: { nodes: [], pageInfo: { hasPreviousPage: false, startCursor: null } },
    } } },
  }));
  const nodes = [
    { name: "unit", status: "COMPLETED", conclusion: "SUCCESS", isRequired: true },
    { context: "deploy", state: "PENDING", isRequired: true },
    { name: "lint", status: "COMPLETED", conclusion: "FAILURE", isRequired: false },
  ];
  for (const [contexts, total] of [[{ totalCount: 140, nodes }, 140], [{ nodes }, null]] as const) {
    respond(contexts);
    const result = await fetchPr(null, "owner", "repo", 7);
    assert.ok(result.ok && result.value?.ci, result.ok ? "no ci" : result.error);
    // Recorded exactly as the Inspector worker records a poll: the snapshot's CI plus the instant.
    recordInspectorCiObservation("owner/repo#7", { ...result.value.ci, observedAt: 9 });
    const stored = getInspectorCiObservation("owner/repo#7");
    assert.ok(stored, `total ${total}: the observation must parse back`);
    assert.equal(stored.totalCount, total);
    assert.deepEqual(stored.checkRuns.map((run) => [run.name, run.required]), [
      ["unit", true],
      ["deploy", true],
      ["lint", undefined],
    ]);
    assert.equal(requiredChecksRollup(stored.checkRuns), "pending");
  }
});

// ---- required checks -------------------------------------------------------------------------

test("CI strictness is the append-only pair all, required", () => {
  assert.deepEqual(CI_STRICTNESS, ["all", "required"]);
});

test("the required-checks rollup reads only checks marked required", () => {
  const run = (state: CiCheckRun["state"], required?: boolean) =>
    ({ state, ...(required === undefined ? {} : { required }) });
  const cases: [string, ReturnType<typeof run>[], ReturnType<typeof requiredChecksRollup>][] = [
    ["no checks", [], null],
    ["nothing marked", [run("failing"), run("pending"), run("passing", false)], null],
    ["a required failure", [run("passing", true), run("failing", true), run("pending", true)], "failing"],
    ["a required pending check", [run("passing", true), run("pending", true)], "pending"],
    ["every required check passed", [run("passing", true), run("passing", true)], "passing"],
    ["an unrequired failure is ignored", [run("passing", true), run("failing"), run("failing", false)], "passing"],
    ["an unrequired pending check is ignored", [run("passing", true), run("pending")], "passing"],
  ];
  for (const [label, runs, expected] of cases) assert.equal(requiredChecksRollup(runs), expected, label);
});

// ---- deciding ------------------------------------------------------------------------------

const T0 = 1_000_000;
const state = (over: Partial<ReturnType<typeof initialWaitForCiState>> = {}) => ({
  ...initialWaitForCiState({
    pullRequestKey: "owner/repo#7",
    pullRequestUrl: "https://github.com/owner/repo/pull/7",
    pullRequestNumber: 7,
    expectedHeadOid: HEAD,
    timeoutMinutes: 45,
    now: T0,
  }),
  ...over,
});
const run = (name: string, runState: CiCheckRun["state"]): CiCheckRun => ({
  name,
  state: runState,
  conclusion: runState === "pending" ? null : runState === "failing" ? "FAILURE" : "SUCCESS",
  detailsUrl: null,
  title: null,
  summary: null,
});
const seen = (
  checkRuns: CiCheckRun[],
  headSha = HEAD,
  observedAt = T0 + 1,
): CiObservation => ({ headSha, observedAt, checkRuns });
const QUIET_MS = 3 * 60_000;
const LIMIT = T0 + 45 * 60_000;
/** Green CI seen once, then again one quiet period later: the shortest path to a pass. */
function settle(checkRuns: CiCheckRun[], from = state()) {
  const first = decideWaitForCi(from, seen(checkRuns, HEAD, T0 + 1), T0 + 1);
  assert.equal(first.kind, "wait");
  return decideWaitForCi(first.state, seen(checkRuns, HEAD, T0 + 1 + QUIET_MS), T0 + 1 + QUIET_MS);
}

test("another head, no observation, and pending checks all wait", () => {
  assert.equal(decideWaitForCi(state(), null, T0 + 1).kind, "wait");
  const other = decideWaitForCi(state(), seen([run("unit", "failing")], "b".repeat(40)), T0 + 1);
  assert.equal(other.kind, "wait");
  assert.deepEqual(other.state.checkRuns, [], "another head's checks were recorded as this head's");
  const pending = decideWaitForCi(state(), seen([run("unit", "passing"), run("e2e", "pending")]), T0 + 1);
  assert.equal(pending.kind, "wait");
  assert.equal(pending.state.checkRuns.length, 2);
  assert.equal(pending.state.quietSince, null);
  // Even a failure waits while anything is still running, so the packet names every failure.
  assert.equal(decideWaitForCi(state(), seen([run("unit", "failing"), run("e2e", "pending")]), T0 + 1).kind, "wait");
  // Heads compare case-insensitively: both spellings are the same full object id.
  assert.equal(decideWaitForCi(state(), seen([run("unit", "passing")], HEAD.toUpperCase()), T0 + 1).state.checkRuns.length, 1);
});

test("a failing check fails the node with no quiet period, naming every failing check", () => {
  const decision = decideWaitForCi(state(), seen([
    run("unit", "failing"),
    run("lint", "failing"),
    run("docs", "passing"),
    run("e2e", "failing"),
  ]), T0 + 1);
  assert.equal(decision.kind, "fail");
  if (decision.kind !== "fail") return;
  assert.deepEqual(decision.failing.map((check) => check.name), ["unit", "lint", "e2e"]);
  assert.equal(decision.state.outcome, "fail");
  assert.equal(decision.state.quietSince, null);
});

test("green CI passes only on an observation a quiet period after the one that first saw it settled", () => {
  const green = [run("unit", "passing"), run("lint", "passing")];
  const first = decideWaitForCi(state(), seen(green, HEAD, T0 + 10), T0 + 10);
  assert.equal(first.kind, "wait");
  assert.equal(first.state.quietSince, T0 + 10, "the clock starts at the observation, not at now");
  // One poll later, the same set: still quiet, not yet long enough.
  const second = decideWaitForCi(first.state, seen(green, HEAD, T0 + 10 + 90_000), T0 + 10 + 90_000);
  assert.equal(second.kind, "wait");
  assert.equal(second.state.quietSince, T0 + 10);
  const short = decideWaitForCi(second.state, seen(green, HEAD, T0 + 9 + QUIET_MS), T0 + 9 + QUIET_MS);
  assert.equal(short.kind, "wait");
  const passed = decideWaitForCi(short.state, seen(green, HEAD, T0 + 10 + QUIET_MS), T0 + 10 + QUIET_MS);
  assert.equal(passed.kind, "pass");
  assert.equal(passed.state.outcome, "pass");
  // Order is not a change: GitHub may list the same checks differently between polls.
  const reordered = decideWaitForCi(first.state, seen([...green].reverse(), HEAD, T0 + 10 + QUIET_MS), T0 + 10 + QUIET_MS);
  assert.equal(reordered.kind, "pass");
});

test("the fifteen-second sweep re-deciding one observation never passes the node", () => {
  const observation = seen([run("unit", "passing")], HEAD, T0 + 10);
  let current = decideWaitForCi(state(), observation, T0 + 10);
  // Twenty minutes of sweeps over the same observation: the clock reads observations, so it
  // never advances, and the state is not even rewritten.
  for (let at = T0 + 10 + 15_000; at < T0 + 20 * 60_000; at += 15_000) {
    const next = decideWaitForCi(current.state, observation, at);
    assert.equal(next.kind, "wait", `passed at +${at - T0} ms on a stale observation`);
    assert.deepEqual(next.state, current.state);
    current = next;
  }
});

test("a change to the settled set restarts the quiet clock, and a pending check clears it", () => {
  const first = decideWaitForCi(state(), seen([run("unit", "passing")], HEAD, T0 + 10), T0 + 10);
  // A new check appears and has already passed: a different set, so the clock starts again.
  const grown = decideWaitForCi(first.state, seen([run("unit", "passing"), run("e2e", "passing")], HEAD, T0 + 10 + 2 * 60_000), T0 + 10 + 2 * 60_000);
  assert.equal(grown.kind, "wait");
  assert.equal(grown.state.quietSince, T0 + 10 + 2 * 60_000);
  const notYet = decideWaitForCi(grown.state, seen([run("unit", "passing"), run("e2e", "passing")], HEAD, T0 + 10 + QUIET_MS), T0 + 10 + QUIET_MS);
  assert.equal(notYet.kind, "wait", "the first sighting's clock passed a set it never saw");
  // A conclusion that changes is a change too.
  const neutral = { ...run("e2e", "passing"), conclusion: "NEUTRAL" };
  const relabelled = decideWaitForCi(notYet.state, seen([run("unit", "passing"), neutral], HEAD, T0 + 10 + 5 * 60_000), T0 + 10 + 5 * 60_000);
  assert.equal(relabelled.state.quietSince, T0 + 10 + 5 * 60_000);
  // A rerun puts a check back to pending: no quiet period while anything runs.
  const rerun = decideWaitForCi(relabelled.state, seen([run("unit", "passing"), run("e2e", "pending")], HEAD, T0 + 10 + 6 * 60_000), T0 + 10 + 6 * 60_000);
  assert.equal(rerun.kind, "wait");
  assert.equal(rerun.state.quietSince, null);
});

test("the timeout blocks as missing CI when nothing appeared, and names the checks still running otherwise", () => {
  assert.equal(decideWaitForCi(state(), null, LIMIT - 1).kind, "wait");
  const missing = decideWaitForCi(state(), null, LIMIT);
  assert.equal(missing.kind === "block" && missing.code, "ci_missing");
  const otherHead = decideWaitForCi(state(), seen([run("unit", "pending")], "b".repeat(40)), LIMIT);
  assert.equal(otherHead.kind === "block" && otherHead.code, "ci_missing");
  const running = decideWaitForCi(state(), seen([run("unit", "passing"), run("e2e", "pending"), run("build", "pending")]), LIMIT);
  assert.equal(running.kind === "block" && running.code, "ci_timeout");
  assert.equal(running.kind === "block" ? running.detail : "", 'Still running after 45 minutes: "e2e", "build".');
  // A failure is decided before the timeout: it fails, it does not block.
  assert.equal(decideWaitForCi(state(), seen([run("unit", "failing")]), LIMIT + 1).kind, "fail");
});

test("a quiet period running at the timeout finishes on its first new observation, unchanged", () => {
  const green = [run("unit", "passing")];
  // The clock starts within one poll of the timeout.
  const start = LIMIT - 60_000;
  const quiet = decideWaitForCi(state(), seen(green, HEAD, start), start);
  // Sweeps past the timeout re-decide the same observation: the period is still running.
  const swept = decideWaitForCi(quiet.state, seen(green, HEAD, start), LIMIT + 30_000);
  assert.equal(swept.kind, "wait");
  // A poll before the period ends, unchanged: still waiting, past the timeout.
  const mid = decideWaitForCi(swept.state, seen(green, HEAD, start + 90_000), start + 90_000);
  assert.equal(mid.kind, "wait");
  // A review held the poll up for several minutes; the late observation still decides it.
  const late = start + QUIET_MS + 8 * 60_000;
  assert.equal(decideWaitForCi(mid.state, seen(green, HEAD, late), late).kind, "pass");
  // A changed set past the timeout never restarts the period.
  const changed = decideWaitForCi(mid.state, seen([run("unit", "passing"), run("e2e", "passing")], HEAD, late), late);
  assert.equal(changed.kind === "block" && changed.code, "ci_timeout");
  assert.match(changed.kind === "block" ? changed.detail : "", /had not stayed settled for the 3-minute quiet period/);
  // And a new pending check past the timeout blocks at once.
  const pending = decideWaitForCi(mid.state, seen([run("unit", "passing"), run("e2e", "pending")], HEAD, start + 2 * 60_000), start + 2 * 60_000);
  assert.equal(pending.kind === "block" && pending.code, "ci_timeout");
  assert.match(pending.kind === "block" ? pending.detail : "", /Still running after 45 minutes: "e2e"/);
});

test("a quiet period past the timeout that gets no new observation blocks once the grace runs out", () => {
  const green = [run("unit", "passing")];
  const start = LIMIT - 60_000;
  const quiet = decideWaitForCi(state(), seen(green, HEAD, start), start);
  const end = start + QUIET_MS;
  assert.equal(decideWaitForCi(quiet.state, seen(green, HEAD, start), end + WAIT_FOR_CI_QUIET_GRACE_MS - 1).kind, "wait");
  const stalled = decideWaitForCi(quiet.state, seen(green, HEAD, start), end + WAIT_FOR_CI_QUIET_GRACE_MS);
  assert.equal(stalled.kind === "block" && stalled.code, "ci_timeout");
  assert.match(stalled.kind === "block" ? stalled.detail : "", /No new CI observation arrived to finish the quiet period within 15 minutes/);
  assert.equal(WAIT_FOR_CI_QUIET_GRACE_MS, 15 * 60_000);
  // A period that started long before the timeout and then stalled is already out of grace.
  const early = decideWaitForCi(state(), seen(green, HEAD, T0 + 10), T0 + 10);
  const stale = decideWaitForCi(early.state, seen(green, HEAD, T0 + 10), LIMIT);
  assert.equal(stale.kind === "block" && stale.code, "ci_timeout");
  // A green set first seen after the timeout cannot start one: nothing was running to finish.
  const fresh = decideWaitForCi(state(), seen(green, HEAD, LIMIT + 1), LIMIT + 1);
  assert.equal(fresh.kind === "block" && fresh.code, "ci_timeout");
});

test("a node with no proven head blocks rather than guessing one", () => {
  const decision = decideWaitForCi(state({ expectedHeadOid: null }), seen([run("unit", "passing")]), T0 + 1);
  assert.equal(decision.kind === "block" && decision.code, "ci_pull_request_unknown");
});

test("the verdicts cite the attempt and carry each failing check's own words", () => {
  const failing = decideWaitForCi(state(), seen([{
    ...run("unit (node 24)", "failing"),
    title: "2 tests failed",
    summary: "test/a.test.ts failed twice",
    detailsUrl: "https://ci/unit",
  }]), T0 + 1);
  assert.equal(failing.kind, "fail");
  if (failing.kind !== "fail") return;
  const verdict = waitForCiVerdict(failing, "attempt-1");
  assert.equal(verdict?.verdict, "fail");
  if (verdict?.verdict !== "fail") return;
  assert.equal(verdict.requestedChanges[0]!.title, 'Fix the failing CI check "unit (node 24)"');
  assert.match(verdict.requestedChanges[0]!.rationale, /2 tests failed[\s\S]*failed twice[\s\S]*https:\/\/ci\/unit/);
  assert.deepEqual(verdict.requestedChanges[0]!.evidence, [{ kind: "check", path: "attempt-1", quote: "2 tests failed" }]);
  const passing = settle([run("unit", "passing")]);
  if (passing.kind !== "pass") return assert.fail("expected a pass");
  assert.equal(waitForCiVerdict(passing, "attempt-2")?.summary, `CI passed on ${HEAD.slice(0, 12)}.`);
});

test("a failure too large for the verdict budget still settles, naming every failing check", () => {
  const long = (name: string): CiCheckRun => ({
    ...run(name, "failing"),
    title: "t".repeat(300),
    summary: "s".repeat(1_500),
    detailsUrl: `https://ci/${name}`,
  });
  for (const count of [8, 30]) {
    const checks = Array.from({ length: count }, (_, index) => long(`check-${index}`));
    const failing = decideWaitForCi(state(), seen(checks), T0 + 1);
    if (failing.kind !== "fail") return assert.fail("expected a fail");
    const verdict = waitForCiVerdict(failing, "attempt-1");
    if (verdict?.verdict !== "fail") return assert.fail(`no verdict for ${count} checks`);
    assert.ok(verdict.requestedChanges.length <= 20, String(count));
    const shared = verdict.requestedChanges.at(-1)!;
    assert.match(shared.title, /^Fix the other \d+ failing CI checks$/);
    const named = verdict.requestedChanges.slice(0, -1).map((change) => change.title.match(/"(.+)"$/)![1]!);
    for (const check of checks) {
      assert.ok(named.includes(check.name) || shared.rationale.includes(`"${check.name}": FAILURE (https://ci/${check.name})`), check.name);
    }
    assert.deepEqual(verdict.requestedChanges.at(-1)!.evidence, [
      { kind: "check", path: "attempt-1", quote: `${count - named.length} failing checks on the pull request's head commit.` },
    ]);
  }
});

// ---- node settings: strictness, quiet period, expected checks -------------------------------

const req = (name: string, runState: CiCheckRun["state"]): CiCheckRun => ({ ...run(name, runState), required: true });
const configured = (
  settings: { strictness?: "all" | "required"; quietMinutes?: number; expectedChecks?: string[] },
  over: Partial<ReturnType<typeof initialWaitForCiState>> = {},
) => state({ strictness: "all", quietMinutes: 3, expectedChecks: [], ...settings, ...over });
const at = (checkRuns: CiCheckRun[], observedAt: number, totalCount?: number | null): CiObservation => ({
  headSha: HEAD,
  observedAt,
  checkRuns,
  ...(totalCount === undefined ? {} : { totalCount }),
});
/** Decide a sequence of observations, each at its own `observedAt`, and return every decision. */
function observe(from: ReturnType<typeof state>, ...observations: CiObservation[]) {
  const decisions = [];
  let current = from;
  for (const observation of observations) {
    const decision = decideWaitForCi(current, observation, observation.observedAt);
    decisions.push(decision);
    current = decision.state;
  }
  return decisions;
}

test("settings resolve field by field, absent ones to the frozen legacy settings, and new nodes write all three", () => {
  assert.deepEqual(waitForCiSettings({}), WAIT_FOR_CI_LEGACY_SETTINGS);
  assert.deepEqual(waitForCiSettings({ quietMinutes: 0 }), { strictness: "all", quietMinutes: 0, expectedChecks: [] });
  assert.deepEqual(
    waitForCiSettings({ strictness: "required", expectedChecks: ["deploy"] }),
    { strictness: "required", quietMinutes: 3, expectedChecks: ["deploy"] },
  );
  assert.deepEqual(WAIT_FOR_CI_NEW_NODE_SETTINGS, { strictness: "all", quietMinutes: 3, expectedChecks: [] });
  assert.deepEqual(WAIT_FOR_CI_QUIET_MINUTES, { default: 3, min: 0, max: 30 });
  // The attempt copies what it is given, and "Wait for CI again" carries it through its spread.
  const copied = initialWaitForCiState({
    pullRequestKey: null, pullRequestUrl: null, pullRequestNumber: null, expectedHeadOid: HEAD,
    timeoutMinutes: 45, now: T0, strictness: "required", quietMinutes: 5, expectedChecks: ["deploy"],
  });
  const decided = { ...copied, quietSince: T0, missingExpected: ["deploy"], requiredFallback: true, checksTotal: 140 };
  const rewait = initialWaitForCiState({ ...decided, now: T0 + 1 });
  assert.deepEqual(waitForCiSettings(rewait), { strictness: "required", quietMinutes: 5, expectedChecks: ["deploy"] });
  assert.equal(rewait.quietSince, null);
  for (const key of ["missingExpected", "requiredFallback", "checksTotal"]) assert.equal(key in rewait, false, key);
  // A legacy attempt waited again stays legacy: nothing is invented for it.
  const legacy = initialWaitForCiState({ ...state(), now: T0 + 1 });
  for (const key of ["strictness", "quietMinutes", "expectedChecks"]) assert.equal(key in legacy, false, key);
});

test("a quiet period of 0 passes on the first settled observation", () => {
  const [first] = observe(configured({ quietMinutes: 0 }), at([run("unit", "passing")], T0 + 10));
  assert.equal(first!.kind, "pass");
  assert.equal(observe(configured({ quietMinutes: 0 }), at([run("unit", "pending")], T0 + 10))[0]!.kind, "wait");
});

test("Required mode counts marked checks only: a failure that is not required never fails the node or reaches the packet", () => {
  const required = configured({ strictness: "required" });
  // Waits out the quiet period over a non-required failure, and passes.
  const [first, second] = observe(
    required,
    at([req("build", "passing"), run("lint", "failing")], T0 + 10),
    at([req("build", "passing"), run("lint", "failing")], T0 + 10 + QUIET_MS),
  );
  assert.equal(first!.kind, "wait");
  assert.equal(first!.state.quietSince, T0 + 10);
  assert.equal(second!.kind, "pass");
  assert.equal(second!.state.requiredFallback, undefined);
  // A non-required check still running never holds it up.
  assert.equal(observe(required, at([req("build", "passing"), run("e2e", "pending")], T0 + 10))[0]!.state.quietSince, T0 + 10);
  // A required failure fails at once, and only counted failures become requested changes.
  const [failed] = observe(required, at([req("build", "failing"), run("lint", "failing")], T0 + 10));
  assert.equal(failed!.kind, "fail");
  if (failed!.kind !== "fail") return;
  assert.deepEqual(failed!.failing.map((check) => check.name), ["build"]);
  const verdict = waitForCiVerdict(failed!, "attempt-1");
  if (verdict?.verdict !== "fail") return assert.fail("expected a fail verdict");
  assert.deepEqual(verdict.requestedChanges.map((change) => change.title), ['Fix the failing CI check "build"']);
  assert.doesNotMatch(verdict.summary, /lint/);
});

test("marking or unmarking a check required resets the quiet clock, and other non-required changes do not", () => {
  const [first, marked, unmarked] = observe(
    configured({ strictness: "required" }),
    at([req("build", "passing"), run("lint", "passing")], T0 + 10),
    at([req("build", "passing"), req("lint", "passing")], T0 + 10 + 60_000),
    at([req("build", "passing"), run("lint", "passing")], T0 + 10 + 2 * 60_000),
  );
  assert.equal(first!.state.quietSince, T0 + 10);
  assert.equal(marked!.state.quietSince, T0 + 10 + 60_000, "marking a check required did not reset the clock");
  assert.equal(unmarked!.state.quietSince, T0 + 10 + 2 * 60_000, "unmarking a check did not reset the clock");
  // A non-required check that changes, or appears, is not part of the counted set.
  const [, changed, passed] = observe(
    configured({ strictness: "required" }),
    at([req("build", "passing"), run("lint", "failing")], T0 + 10),
    at([req("build", "passing"), run("lint", "passing"), run("docs", "pending")], T0 + 10 + 60_000),
    at([req("build", "passing"), run("lint", "passing")], T0 + 10 + QUIET_MS),
  );
  assert.equal(changed!.state.quietSince, T0 + 10);
  assert.equal(passed!.kind, "pass");
  // In All mode the flag is part of the set too.
  const [allFirst, allMarked] = observe(
    configured({}),
    at([run("build", "passing")], T0 + 10),
    at([req("build", "passing")], T0 + 10 + QUIET_MS),
  );
  assert.equal(allFirst!.kind, "wait");
  assert.equal(allMarked!.kind, "wait");
  assert.equal(allMarked!.state.quietSince, T0 + 10 + QUIET_MS);
});

test("Required mode with nothing marked waits out the quiet period, then judges every check and records the fallback", () => {
  const required = configured({ strictness: "required" });
  // A failure is not decided at once: GitHub may mark the required checks late.
  const [first, later] = observe(
    required,
    at([run("build", "passing"), run("lint", "failing")], T0 + 10),
    at([run("build", "passing"), run("lint", "failing")], T0 + 10 + QUIET_MS),
  );
  assert.equal(first!.kind, "wait");
  assert.equal(first!.state.quietSince, T0 + 10);
  assert.equal(later!.kind, "fail");
  assert.equal(later!.state.requiredFallback, true);
  if (later!.kind === "fail") {
    assert.deepEqual(later!.failing.map((check) => check.name), ["lint"]);
    assert.match(waitForCiVerdict(later!, "a")?.summary ?? "", /No check was marked required, so every check was judged\.$/);
  }
  // Checks marked before the period ends take over, and the clock restarts on them.
  const [, rescued] = observe(
    required,
    at([run("build", "passing"), run("lint", "failing")], T0 + 10),
    at([req("build", "passing"), run("lint", "failing")], T0 + 10 + 60_000),
  );
  assert.equal(rescued!.kind, "wait");
  assert.equal(rescued!.state.quietSince, T0 + 10 + 60_000);
  // A pass through the fallback records it too.
  const [, green] = observe(required, at([run("build", "passing")], T0 + 10), at([run("build", "passing")], T0 + 10 + QUIET_MS));
  assert.equal(green!.kind, "pass");
  assert.equal(green!.state.requiredFallback, true);
  assert.match(waitForCiVerdict(green as never, "a")?.summary ?? "", /every check was judged/);
  // A quiet period of 0 decides at once.
  const [now] = observe(configured({ strictness: "required", quietMinutes: 0 }), at([run("lint", "failing")], T0 + 10));
  assert.equal(now!.kind, "fail");
  assert.equal(now!.state.requiredFallback, true);
  // Every expected check reported and settled skips the period, and decides the fallback.
  const [skipped] = observe(
    configured({ strictness: "required", expectedChecks: ["deploy"] }),
    at([run("build", "passing"), run("deploy", "passing")], T0 + 10),
  );
  assert.equal(skipped!.kind, "pass");
  assert.equal(skipped!.state.requiredFallback, true);
  // The skip is for a pass only: a fallback failure with every expected check reported still
  // waits out the quiet period, so a required check that reports last can still take over.
  const [held, marked, judged] = observe(
    configured({ strictness: "required", expectedChecks: ["deploy"] }),
    at([run("deploy", "passing"), run("lint", "failing")], T0 + 10),
    at([run("deploy", "passing"), run("lint", "failing")], T0 + 10 + 60_000),
    at([run("deploy", "passing"), run("lint", "failing")], T0 + 10 + QUIET_MS),
  );
  assert.equal(held!.kind, "wait", "a failure that may not be required spent a repair round at once");
  assert.equal(held!.state.quietSince, T0 + 10);
  assert.equal(marked!.kind, "wait");
  assert.equal(judged!.kind, "fail");
  assert.equal(judged!.state.requiredFallback, true);
  // ...and when the required check does report, the failure that is not required never decides.
  const [, reported] = observe(
    configured({ strictness: "required", expectedChecks: ["deploy"] }),
    at([run("deploy", "passing"), run("lint", "failing")], T0 + 10),
    at([run("deploy", "passing"), run("lint", "failing"), req("CI result", "passing")], T0 + 10 + 60_000),
  );
  assert.equal(reported!.kind, "pass");
  assert.equal(reported!.state.requiredFallback, undefined);
});

test("expected checks must appear and pass in both modes, and all of them settled skips the quiet period", () => {
  for (const strictness of ["all", "required"] as const) {
    const node = configured({ strictness, expectedChecks: ["deploy"] });
    const marked = strictness === "required" ? req : run;
    const missing = observe(
      node,
      at([marked("build", "passing")], T0 + 10),
      at([marked("build", "passing")], T0 + 10 + QUIET_MS),
      at([marked("build", "passing")], T0 + 10 + 2 * QUIET_MS),
    );
    for (const decision of missing) {
      assert.equal(decision.kind, "wait", `${strictness}: passed without its expected check`);
      assert.deepEqual(decision.state.missingExpected, ["deploy"]);
      assert.equal(decision.state.quietSince, null);
    }
    // Pending is never skipped.
    assert.equal(observe(node, at([marked("build", "passing"), run("deploy", "pending")], T0 + 10))[0]!.kind, "wait");
    // Present and settled: pass at once, not merely marked required.
    const [skipped] = observe(node, at([marked("build", "passing"), run("deploy", "passing")], T0 + 10));
    assert.equal(skipped!.kind, "pass", strictness);
    assert.deepEqual(skipped!.state.missingExpected, []);
    assert.equal(skipped!.state.requiredFallback, undefined);
    // An expected check that fails fails the node, required or not.
    const [failed] = observe(node, at([marked("build", "passing"), run("deploy", "failing")], T0 + 10));
    assert.equal(failed!.kind, "fail", strictness);
  }
  // A name matches every check of that name: present once one exists, settled when all have,
  // passing when all pass.
  const node = configured({ expectedChecks: ["deploy"] });
  assert.equal(observe(node, at([run("deploy", "passing"), run("deploy", "pending")], T0 + 10))[0]!.kind, "wait");
  assert.equal(observe(node, at([run("deploy", "passing"), run("deploy", "passing")], T0 + 10))[0]!.kind, "pass");
  assert.equal(observe(node, at([run("deploy", "passing"), run("deploy", "failing")], T0 + 10))[0]!.kind, "fail");
});

test("a counted failure while an expected check is missing fails now and names the missing check", () => {
  const [failed] = observe(configured({ expectedChecks: ["deploy", "e2e"] }), at([run("unit", "failing"), run("e2e", "passing")], T0 + 10));
  assert.equal(failed!.kind, "fail");
  assert.deepEqual(failed!.state.missingExpected, ["deploy"]);
  if (failed!.kind !== "fail") return;
  assert.equal(
    waitForCiVerdict(failed!, "a")?.summary,
    `CI failed on ${HEAD.slice(0, 12)}: "unit". Not reported when CI failed: "deploy".`,
  );
});

test("the timeout blocks in order: missing CI, counted checks still running, then expected checks never reported", () => {
  const node = configured({ strictness: "required", expectedChecks: ["deploy", "e2e"] });
  const nothing = decideWaitForCi(node, null, LIMIT);
  assert.equal(nothing.kind === "block" && nothing.code, "ci_missing");
  const running = decideWaitForCi(node, at([req("build", "pending"), run("e2e", "pending"), run("lint", "pending")], T0 + 10), LIMIT);
  assert.equal(running.kind === "block" && running.code, "ci_timeout");
  assert.equal(running.kind === "block" && running.detail, 'Still running after 45 minutes: "build", "e2e".');
  const absent = decideWaitForCi(node, at([req("build", "passing"), run("e2e", "passing"), run("lint", "pending")], T0 + 10), LIMIT);
  assert.equal(absent.kind === "block" && absent.code, "ci_expected_missing");
  assert.equal(absent.kind === "block" && absent.detail, 'Never reported within 45 minutes: "deploy".');
  assert.deepEqual(absent.state.missingExpected, ["deploy"]);
  assert.equal(absent.state.outcome, "blocked");
  // The same, decided by the sweep on the last observation after the timeout passes.
  const waited = decideWaitForCi(node, at([req("build", "passing"), run("e2e", "passing")], T0 + 10), T0 + 10);
  assert.equal(waited.kind, "wait");
  const swept = decideWaitForCi(waited.state, null, LIMIT);
  assert.equal(swept.kind === "block" && swept.code, "ci_expected_missing");
});

test("a head with more than 100 checks never passes on the first 100, but a counted failure among them still fails", () => {
  for (const strictness of ["all", "required"] as const) {
    const [, quiet] = observe(
      configured({ strictness }),
      at([req("build", "passing")], T0 + 10, 140),
      at([req("build", "passing")], T0 + 10 + QUIET_MS, 140),
    );
    assert.equal(quiet!.kind === "block" && quiet!.code, "ci_checks_truncated", strictness);
    assert.equal(quiet!.kind === "block" && quiet!.detail, "GitHub reported 140 checks; only the first 100 were read.");
    assert.equal(quiet!.state.checksTotal, 140);
    // Expected names read on a truncated head do not skip the quiet period: the rest are unknown.
    const [first, expectedQuiet] = observe(
      configured({ strictness, expectedChecks: ["build"] }),
      at([req("build", "passing")], T0 + 10, 140),
      at([req("build", "passing")], T0 + 10 + QUIET_MS, 140),
    );
    assert.equal(first!.kind, "wait", strictness);
    assert.equal(expectedQuiet!.kind === "block" && expectedQuiet!.code, "ci_checks_truncated", strictness);
    const [zero] = observe(configured({ strictness, quietMinutes: 0 }), at([req("build", "passing")], T0 + 10, 140));
    assert.equal(zero!.kind === "block" && zero!.code, "ci_checks_truncated", strictness);
    const [failed] = observe(configured({ strictness }), at([req("build", "failing")], T0 + 10, 140));
    assert.equal(failed!.kind, "fail", strictness);
  }
  // Required mode on a truncated head never falls back: the required checks may be unread, so a
  // failure that is not marked among those read blocks rather than spend a repair round.
  const unmarked = [run("build", "passing"), run("lint", "failing")];
  const [held, blocked] = observe(
    configured({ strictness: "required" }),
    at(unmarked, T0 + 10, 140),
    at(unmarked, T0 + 10 + QUIET_MS, 140),
  );
  assert.equal(held!.kind, "wait");
  assert.equal(held!.state.quietSince, T0 + 10, "the checks read settling still runs the quiet period");
  assert.equal(blocked!.kind === "block" && blocked!.code, "ci_checks_truncated");
  assert.equal(blocked!.state.requiredFallback, undefined, "a truncated head claimed no check was marked required");
  const [atOnce] = observe(configured({ strictness: "required", quietMinutes: 0 }), at(unmarked, T0 + 10, 140));
  assert.equal(atOnce!.kind === "block" && atOnce!.code, "ci_checks_truncated");
  // While the checks read are still running, it waits; at the timeout it names them.
  const running = decideWaitForCi(configured({ strictness: "required" }), at([run("lint", "pending")], T0 + 10, 140), LIMIT);
  assert.equal(running.kind === "block" && running.detail, 'Still running after 45 minutes: "lint".');
  // An expected name not among the checks read is unknown, not missing: no wait for it, no
  // ci_expected_missing, and no quiet-period skip on the strength of the names read.
  const expectedNode = configured({ strictness: "required", expectedChecks: ["deploy"] });
  const [unknown] = observe(expectedNode, at([req("build", "passing")], T0 + 10, 140));
  assert.equal(unknown!.kind, "wait");
  assert.deepEqual(unknown!.state.missingExpected, []);
  assert.equal(unknown!.state.quietSince, T0 + 10);
  const late = decideWaitForCi(unknown!.state, null, LIMIT);
  assert.equal(late.kind === "block" && late.code, "ci_timeout");
  // A marked failure among the checks read still fails.
  const [markedFail] = observe(configured({ strictness: "required" }), at([req("build", "failing"), run("lint", "failing")], T0 + 10, 140));
  assert.equal(markedFail!.kind, "fail");
  if (markedFail!.kind === "fail") assert.deepEqual(markedFail!.failing.map((check) => check.name), ["build"]);
  // Exactly 100, or a total GitHub did not give, is the whole list.
  assert.equal(observe(configured({ quietMinutes: 0 }), at([run("build", "passing")], T0 + 10, 100))[0]!.kind, "pass");
  assert.equal(observe(configured({ quietMinutes: 0 }), at([run("build", "passing")], T0 + 10, null))[0]!.kind, "pass");
  // A legacy node blocks too: it never names a quiet period of 0, but its pass is the same pass.
  assert.equal(settle([run("unit", "passing")], state()).kind, "pass");
  const legacy = observe(state(), at([run("unit", "passing")], T0 + 10, 101), at([run("unit", "passing")], T0 + 10 + QUIET_MS, 101));
  assert.equal(legacy[1]!.kind === "block" && legacy[1]!.code, "ci_checks_truncated");
});

test("the node arms take the three settings as optional fields, and never add them", async () => {
  const { PublishedWorkflowNodeSchema } = await import("../src/shared/protocol.ts");
  const legacy = { id: "ci", kind: "wait_for_ci", timeoutMinutes: 45, position: { x: 0, y: 0 } };
  for (const schema of [WorkflowDraftNodeSchema, PublishedWorkflowNodeSchema]) {
    assert.deepEqual(schema.parse(legacy), legacy);
    assert.equal(JSON.stringify(schema.parse(legacy)), JSON.stringify(legacy), "a legacy node changed bytes");
    const configuredNode = { ...legacy, strictness: "required", quietMinutes: 0, expectedChecks: ["deploy", "e2e"] };
    assert.deepEqual(schema.parse(configuredNode), configuredNode);
    assert.deepEqual(
      (schema.parse({ ...legacy, expectedChecks: ["  deploy "] }) as { expectedChecks?: string[] }).expectedChecks,
      ["deploy"],
    );
    for (const bad of [
      { quietMinutes: 31 },
      { quietMinutes: -1 },
      { quietMinutes: 1.5 },
      { strictness: "some" },
      { expectedChecks: ["   "] },
      { expectedChecks: ["x".repeat(501)] },
      { expectedChecks: Array.from({ length: 101 }, (_, index) => `c${index}`) },
    ]) {
      assert.equal(schema.safeParse({ ...legacy, ...bad }).success, false, JSON.stringify(bad));
    }
  }
});

test("Publish refuses a quiet period at or above the timeout, and duplicate or more than 20 expected checks, on the node", () => {
  const withCi = (fields: Record<string, unknown>): WorkflowDraftGraph => {
    const graph = shippingGraph({ node: "pr", port: "complete" });
    return { ...graph, nodes: graph.nodes.map((node) => node.kind === "wait_for_ci" ? { ...node, ...fields } as never : node) };
  };
  const codes = (fields: Record<string, unknown>) => validateWorkflowGraph({
    graph: withCi(fields),
    sessionActions: [action("pull_request")],
    completionPolicy: { kind: "none" },
  }).diagnostics.map((item) => [item.code, item.nodeId, item.message, item.severity]);
  // A legacy node, and a new node, produce neither.
  assert.deepEqual(codes({}), []);
  assert.deepEqual(codes({ ...WAIT_FOR_CI_NEW_NODE_SETTINGS }), []);
  assert.deepEqual(codes({ timeoutMinutes: 5, quietMinutes: 4 }), []);
  const quiet = ["wait_for_ci_quiet_period", "ci", "The quiet period must be shorter than the timeout.", "error"];
  assert.deepEqual(codes({ timeoutMinutes: 5, quietMinutes: 5 }), [quiet]);
  assert.deepEqual(codes({ timeoutMinutes: 10, quietMinutes: 30 }), [quiet]);
  const expected = ["wait_for_ci_expected_checks", "ci", "Expected checks must be unique, and there can be at most 20.", "error"];
  assert.deepEqual(codes({ expectedChecks: ["deploy", "e2e", "deploy"] }), [expected]);
  assert.deepEqual(codes({ expectedChecks: Array.from({ length: 21 }, (_, index) => `c${index}`) }), [expected]);
  assert.deepEqual(codes({ expectedChecks: Array.from({ length: 20 }, (_, index) => `c${index}`) }), []);
});

// ---- legacy settings ---------------------------------------------------------------------

test("an attempt state without the settings judges under the frozen legacy settings", () => {
  assert.deepEqual(WAIT_FOR_CI_LEGACY_SETTINGS, { strictness: "all", quietMinutes: 3, expectedChecks: [] });
  // No settings and no `quietSince`: absence still parses, and reads as the legacy settings.
  const bare: Record<string, unknown> = { ...state() };
  delete bare.quietSince;
  const legacy = WaitForCiStateSchema.parse(bare);
  assert.equal("quietSince" in legacy, false);
  assert.deepEqual(waitForCiSettings(legacy), WAIT_FOR_CI_LEGACY_SETTINGS);
  assert.equal(settle([run("unit", "passing")], legacy).kind, "pass");
});

// ---- placing -------------------------------------------------------------------------------

const action = (completion: "pull_request" | "session_turn", id = `action-${completion}`) => ({
  id,
  archivedAt: null,
  completion: { kind: completion },
}) as never;

function shippingGraph(ciSource: { node: string; port: "complete" | "pass" }): WorkflowDraftGraph {
  return {
    nodes: [
      { id: "s", kind: "session", position: { x: 0, y: 0 } },
      { id: "check", kind: "check", slot: "lint", position: { x: 100, y: 0 } },
      { id: "pr", kind: "session_action", sessionActionId: "action-pull_request", position: { x: 200, y: 0 } },
      { id: "ci", kind: "wait_for_ci", timeoutMinutes: 45, position: { x: 300, y: 0 } },
      { id: "end", kind: "end", outcome: "Done", position: { x: 400, y: 0 } },
    ],
    edges: [
      { id: "e1", source: "s", sourcePort: "submitted", target: "check", targetPort: "activate" },
      { id: "e2", source: "check", sourcePort: "fail", target: "s", targetPort: "return_for_changes" },
      { id: "e3", source: "check", sourcePort: "pass", target: "pr", targetPort: "activate" },
      ...(ciSource.node === "pr"
        ? [{ id: "e4", source: "pr", sourcePort: "complete" as const, target: "ci", targetPort: "activate" as const }]
        : [
            { id: "e4", source: "pr", sourcePort: "complete" as const, target: "end", targetPort: "terminal" as const },
            { id: "e4b", source: ciSource.node, sourcePort: ciSource.port, target: "ci", targetPort: "activate" as const },
          ]),
      { id: "e5", source: "ci", sourcePort: "pass", target: "end", targetPort: "terminal" },
      { id: "e6", source: "ci", sourcePort: "fail", target: "s", targetPort: "return_for_changes" },
    ],
  };
}

test("Wait for CI is valid only after a Pull Request action's complete route", () => {
  const valid = validateWorkflowGraph({
    graph: shippingGraph({ node: "pr", port: "complete" }),
    sessionActions: [action("pull_request")],
    completionPolicy: { kind: "none" },
  });
  assert.deepEqual(valid.diagnostics, []);
  const afterCheck = validateWorkflowGraph({ graph: shippingGraph({ node: "check", port: "pass" }) });
  assert.ok(afterCheck.diagnostics.some((item) => item.code === "wait_for_ci_placement" && item.nodeId === "ci"));
  const afterOtherAction = validateWorkflowGraph({
    graph: shippingGraph({ node: "pr", port: "complete" }),
    sessionActions: [action("session_turn", "action-pull_request")],
  });
  assert.ok(afterOtherAction.diagnostics.some((item) => item.code === "wait_for_ci_placement"));
  // The timeout is bounded by the persisted schema, not by the validator.
  assert.equal(WorkflowDraftNodeSchema.safeParse({ id: "ci", kind: "wait_for_ci", timeoutMinutes: 4, position: { x: 0, y: 0 } }).success, false);
  assert.equal(WorkflowDraftNodeSchema.safeParse({ id: "ci", kind: "wait_for_ci", timeoutMinutes: 240, position: { x: 0, y: 0 } }).success, true);
  assert.equal(WorkflowDraftNodeSchema.safeParse({ id: "ci", kind: "wait_for_ci", timeoutMinutes: 241, position: { x: 0, y: 0 } }).success, false);
});

test("a continuation through Wait for CI to End is still shipping-only, and owns CI", () => {
  const graph = shippingGraph({ node: "pr", port: "complete" }) as unknown as PublishedWorkflowGraph;
  assert.equal(sessionActionContinuationReachesOnlyEnd(graph, "pr"), true);
  assert.equal(waitForCiFollows(graph, "pr"), true);
  const withoutCi: PublishedWorkflowGraph = {
    nodes: graph.nodes.filter((node) => node.id !== "ci"),
    edges: [
      ...graph.edges.filter((edge) => edge.source !== "ci" && edge.target !== "ci"),
      { id: "e4", source: "pr", sourcePort: "complete", target: "end", targetPort: "terminal" },
    ],
  };
  assert.equal(sessionActionContinuationReachesOnlyEnd(withoutCi, "pr"), true);
  assert.equal(waitForCiFollows(withoutCi, "pr"), false);
  // A reviewer after Wait for CI makes it an ordinary evaluator-bound continuation again.
  const reviewed: PublishedWorkflowGraph = {
    nodes: [...graph.nodes, { id: "late", kind: "check", slot: "lint", position: { x: 0, y: 0 } }],
    edges: graph.edges.map((edge) => edge.id === "e5" ? { ...edge, target: "late", targetPort: "activate" } : edge),
  };
  assert.equal(sessionActionContinuationReachesOnlyEnd(reviewed, "pr"), false);
});


test("the PR card and Wait for CI classify a check by one shared rule", async () => {
  const { classifyCheckEntry } = await import("../src/shared/ci-checks.ts");
  const { readFileSync } = await import("node:fs");
  assert.equal(classifyCheckEntry({ status: "IN_PROGRESS" }), "pending");
  assert.equal(classifyCheckEntry({ status: "COMPLETED", conclusion: "stale" }), "failing");
  assert.equal(classifyCheckEntry({ status: "COMPLETED", conclusion: "NEUTRAL" }), "passing");
  assert.equal(classifyCheckEntry({ state: "EXPECTED" }), "pending");
  assert.equal(classifyCheckEntry({ state: "ERROR" }), "failing");
  assert.equal(classifyCheckEntry({ other: 1 }), null);
  for (const path of ["../src/server/pr.ts", "../src/shared/wait-for-ci.ts"]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.match(source, /classifyCheckEntry\(/, path);
    assert.doesNotMatch(source, /FAIL_CONCLUSIONS/, `${path} keeps its own copy of the rule`);
  }
});

test("which CI blocks retry is read from the recovery table, and only those offer retry", async () => {
  const { WORKFLOW_PHASE_RECOVERY, infrastructureRecoveryAvailable } = await import("../src/server/workflows/recovery.ts");
  const { WAIT_FOR_CI_BLOCK_CODES } = await import("../src/shared/wait-for-ci.ts");
  const failed = { mode: "full_workflow", status: "failed", triggerSource: "manual", triggerKey: "k" } as never;
  for (const code of WAIT_FOR_CI_BLOCK_CODES) {
    assert.equal(
      infrastructureRecoveryAvailable({ status: "blocked", phase: code }, failed, true),
      WORKFLOW_PHASE_RECOVERY[code] === "retry",
      code,
    );
  }
  assert.equal(WORKFLOW_PHASE_RECOVERY.ci_pull_request_unknown, "resume");
});
