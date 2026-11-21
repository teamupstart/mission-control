import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// The merge gate's CI verdict, read through the Inspector's one GraphQL query.
//
// GitHub's aggregate `statusCheckRollup.state` still says FAILURE after a later run of the same
// check passed - the title check re-run after an edit is the everyday case - which held the
// pull request on "CI is failing" while GitHub's checks list was green. The Inspector now reads
// the individual checks beside it, and clears that failure only when every narrowing condition
// in `checksOf` holds. Everything else keeps GitHub's verdict.

const dir = mkdtempSync(join(tmpdir(), "mission-inspector-retried-checks-"));
const gh = join(dir, "gh");
const calls = join(dir, "calls");
const snapshot = join(dir, "snapshot.json");
process.env.MISSION_GH_BIN = gh;
writeFileSync(calls, "");
writeFileSync(gh, `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');
process.stdout.write(fs.readFileSync(${JSON.stringify(snapshot)}, 'utf8'));
`);
chmodSync(gh, 0o755);
const { fetchPr } = await import("../src/server/inspector/github.ts");
after(() => rmSync(dir, { force: true, recursive: true }));

let suites = 0;
/** A GraphQL Actions run, each in its own check suite unless it names one. */
function run(
  name: string,
  conclusion: string | null,
  startedAt: string,
  completedAt: string | null,
  { workflow = "Pull request title", event = "pull_request_target", workflowId = `W_${workflow}`, suite = `CS_${++suites}` }:
    { workflow?: string; event?: string; workflowId?: string; suite?: string } = {},
) {
  return {
    __typename: "CheckRun", name, status: conclusion === null ? "IN_PROGRESS" : "COMPLETED",
    conclusion, startedAt, completedAt,
    checkSuite: { id: suite, app: { slug: "github-actions" }, workflowRun: { event, workflow: { id: workflowId, name: workflow } } },
  };
}

const TITLE_FAILED = run("release-compatible title", "FAILURE", "2026-10-07T20:00:22Z", "2026-10-07T20:00:29Z");
const TITLE_PASSED = run("release-compatible title", "SUCCESS", "2026-10-07T20:01:35Z", "2026-10-07T20:01:42Z");

async function checksFor(state: string, nodes: unknown[], hasNextPage = false): Promise<string | undefined> {
  writeFileSync(snapshot, JSON.stringify({ data: { repository: { pullRequest: {
    state: "OPEN", headRefOid: "sha", isDraft: false,
    commits: { nodes: [{ commit: { statusCheckRollup: { state, contexts: { pageInfo: { hasNextPage }, nodes } } } }] },
    reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    reviews: { nodes: [], pageInfo: { hasPreviousPage: false, startCursor: null } },
  } } } }));
  const read = await fetchPr(dir, "o", "r", 1);
  assert.ok(read.ok, read.error);
  return read.value?.checks;
}

test("the query reads the head commit's individual checks beside GitHub's aggregate", async () => {
  writeFileSync(calls, "");
  await checksFor("SUCCESS", []);
  const args = JSON.parse(readFileSync(calls, "utf8").trim()) as string[];
  const query = args.find((arg) => arg.startsWith("query="))!;
  assert.match(query, /statusCheckRollup\{\s*state\s+contexts\(first:100\)/);
  assert.match(query, /\.\.\. on CheckRun\{ name status conclusion startedAt completedAt\s+checkSuite\{ id app\{ slug \} workflowRun\{ event workflow\{ id name \} \} \} \}/);
  assert.match(query, /\.\.\. on StatusContext\{ context state createdAt \}/);
});

test("a failure a later run of the same check re-checked no longer holds the merge gate", async () => {
  assert.equal(await checksFor("FAILURE", [TITLE_FAILED, TITLE_PASSED]), "passing");
});

test("a failure whose re-run is still going reads as CI still running", async () => {
  const rerun = run("release-compatible title", null, "2026-10-07T20:01:35Z", null);
  assert.equal(await checksFor("FAILURE", [TITLE_FAILED, rerun]), "pending");
});

test("GitHub's failing verdict stands whenever the checks cannot prove it stale", async (t) => {
  await t.test("a failure nothing re-ran", async () => {
    assert.equal(await checksFor("FAILURE", [TITLE_FAILED]), "failing");
  });
  await t.test("another check still failing beside the re-checked one", async () => {
    const lint = run("lint", "FAILURE", "2026-10-07T20:00:00Z", "2026-10-07T20:02:00Z", { workflow: "CI", event: "pull_request" });
    assert.equal(await checksFor("FAILURE", [TITLE_FAILED, TITLE_PASSED, lint]), "failing");
  });
  await t.test("a failed push run followed, without overlap, by a passing pull_request run of the same job", async () => {
    const ci = (event: string, conclusion: string, startedAt: string, completedAt: string) =>
      run("build", conclusion, startedAt, completedAt, { workflow: "CI", event });
    assert.equal(await checksFor("FAILURE", [
      ci("push", "FAILURE", "2026-10-07T20:00:00Z", "2026-10-07T20:03:00Z"),
      ci("pull_request", "SUCCESS", "2026-10-07T20:10:00Z", "2026-10-07T20:14:00Z"),
    ]), "failing");
  });
  await t.test("two workflow files that share a display name", async () => {
    // Both called `CI`: a pass in one must not release the gate on the other's failure.
    assert.equal(await checksFor("FAILURE", [
      run("build", "FAILURE", "2026-10-07T20:00:00Z", "2026-10-07T20:01:00Z", { workflow: "CI", event: "pull_request", workflowId: "W_ci_yml" }),
      run("build", "SUCCESS", "2026-10-07T20:02:00Z", "2026-10-07T20:03:00Z", { workflow: "CI", event: "pull_request", workflowId: "W_nightly_yml" }),
    ]), "failing");
  });
  await t.test("two jobs of one workflow run that share a name", async () => {
    // A `needs` job with `if: always()` passing after its namesake failed is not a re-run of it.
    assert.equal(await checksFor("FAILURE", [
      run("build", "FAILURE", "2026-10-07T20:00:00Z", "2026-10-07T20:01:00Z", { suite: "CS_one_run" }),
      run("build", "SUCCESS", "2026-10-07T20:02:00Z", "2026-10-07T20:03:00Z", { suite: "CS_one_run" }),
    ]), "failing");
  });
  await t.test("an unreadable node beside a re-checked failure", async () => {
    assert.equal(await checksFor("FAILURE", [TITLE_FAILED, null, TITLE_PASSED]), "failing");
  });
  await t.test("two runs whose suites do not name their workflow", async () => {
    // Same app, event and check name, and no workflow: they may be two workflows' `build` jobs,
    // so the later pass must not release the merge gate on the earlier failure.
    const unnamed = (conclusion: string, startedAt: string, completedAt: string) => ({
      ...run("build", conclusion, startedAt, completedAt, { event: "pull_request" }),
      checkSuite: { app: { slug: "github-actions" }, workflowRun: { event: "pull_request", workflow: null } },
    });
    assert.equal(await checksFor("FAILURE", [
      unnamed("FAILURE", "2026-10-07T20:00:00Z", "2026-10-07T20:01:00Z"),
      unnamed("SUCCESS", "2026-10-07T20:02:00Z", "2026-10-07T20:03:00Z"),
    ]), "failing");
  });
  await t.test("two Actions runs whose suites carry no workflow run", async () => {
    const noRun = (conclusion: string, startedAt: string, completedAt: string) => ({
      ...run("build", conclusion, startedAt, completedAt),
      checkSuite: { app: { slug: "github-actions" }, workflowRun: null },
    });
    assert.equal(await checksFor("FAILURE", [
      noRun("FAILURE", "2026-10-07T20:00:00Z", "2026-10-07T20:01:00Z"),
      noRun("SUCCESS", "2026-10-07T20:02:00Z", "2026-10-07T20:03:00Z"),
    ]), "failing");
  });
  await t.test("a failed commit status followed by a later status for its context", async () => {
    // A status names no app, workflow or event: under the Actions-only rule it clears nothing.
    const status = (state: string, createdAt: string) => ({ __typename: "StatusContext", context: "ci/legacy", state, createdAt });
    assert.equal(await checksFor("FAILURE", [status("FAILURE", "2026-10-07T20:00:00Z"), status("SUCCESS", "2026-10-07T20:01:00Z")]), "failing");
  });
  await t.test("another app's failed check followed by its own later pass of that name", async () => {
    const appRun = (conclusion: string, startedAt: string, completedAt: string) => ({
      ...run("build", conclusion, startedAt, completedAt),
      checkSuite: { app: { slug: "circleci-checks" }, workflowRun: null },
    });
    assert.equal(await checksFor("FAILURE", [
      appRun("FAILURE", "2026-10-07T20:00:00Z", "2026-10-07T20:01:00Z"),
      appRun("SUCCESS", "2026-10-07T20:02:00Z", "2026-10-07T20:03:00Z"),
    ]), "failing");
  });
  await t.test("a run whose suite does not say which event triggered it", async () => {
    const unnamed = { ...TITLE_PASSED, checkSuite: { app: { slug: "github-actions" }, workflowRun: { event: null, workflow: { name: "Pull request title" } } } };
    assert.equal(await checksFor("FAILURE", [TITLE_FAILED, unnamed]), "failing");
  });
  await t.test("more checks than one page holds", async () => {
    assert.equal(await checksFor("FAILURE", [TITLE_FAILED, TITLE_PASSED], true), "failing");
  });
  await t.test("a result this code does not recognise among the checks still counting", async () => {
    const odd = run("future", "SOMETHING_NEW", "2026-10-07T20:00:00Z", "2026-10-07T20:02:00Z");
    assert.equal(await checksFor("FAILURE", [TITLE_FAILED, TITLE_PASSED, odd]), "failing");
  });
  await t.test("nothing was re-checked, whatever the checks themselves say", async () => {
    assert.equal(await checksFor("FAILURE", [TITLE_PASSED]), "failing");
  });
  await t.test("no individual checks in the answer at all", async () => {
    writeFileSync(snapshot, JSON.stringify({ data: { repository: { pullRequest: {
      state: "OPEN", headRefOid: "sha", isDraft: false,
      commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] },
      reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    } } } }));
    assert.equal((await fetchPr(dir, "o", "r", 1)).value?.checks, "failing");
  });
});

test("only a failing aggregate is ever reconsidered", async () => {
  assert.equal(await checksFor("SUCCESS", [TITLE_FAILED]), "passing");
  assert.equal(await checksFor("PENDING", [TITLE_FAILED, TITLE_PASSED]), "pending");
});

test("a current FAILURE aggregate with only cancelled and passing jobs keeps the existing gate verdict", async () => {
  const cancelled = run("Catalog Security review", "CANCELLED", "2026-10-07T20:00:00Z", "2026-10-07T20:01:00Z");
  // No failure-retry proof is supplied: reporting must not relax this conservative gate.
  const passed = run("required", "SUCCESS", "2026-10-07T20:00:00Z", "2026-10-07T20:01:00Z");
  assert.equal(await checksFor("FAILURE", [cancelled, passed]), "failing");
});
