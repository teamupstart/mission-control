import assert from "node:assert/strict";
import test from "node:test";
import { rollUpChecks } from "../src/server/github/check-rollup.ts";

// The rule behind the PR chip's "a CI check failed" alert and the merge gate's "CI is failing":
// a check run stops counting once a later run of the SAME check - same app, workflow, triggering
// event and name - has re-checked it.
//
// Most entries are GraphQL check runs, the shape that carries that identity. `gh pr list --json
// statusCheckRollup` drops the app and the event, and its shape is covered on its own below.

const ZERO = "0001-01-01T00:00:00Z"; // `gh`'s export of a timestamp GitHub has not set yet

/** A GraphQL check run from GitHub Actions. The workflow file's id defaults to one per name. */
function run(
  name: string,
  conclusion: string | null,
  startedAt: string | null,
  completedAt: string | null,
  { workflow = "CI", event = "pull_request", workflowId = `W_${workflow}` }: { workflow?: string; event?: string; workflowId?: string } = {},
): Record<string, unknown> {
  return {
    __typename: "CheckRun",
    name,
    status: conclusion === null ? (startedAt ? "IN_PROGRESS" : "QUEUED") : "COMPLETED",
    conclusion,
    startedAt,
    completedAt,
    checkSuite: { app: { slug: "github-actions" }, workflowRun: { event, workflow: { id: workflowId, name: workflow } } },
  };
}

/** The same run as `gh pr list --json statusCheckRollup` prints it: no app, no event. */
function ghRun(name: string, conclusion: string, startedAt: string, completedAt: string, workflowName = "CI") {
  return { __typename: "CheckRun", name, workflowName, status: "COMPLETED", conclusion, startedAt, completedAt,
    detailsUrl: "https://github.com/o/r/actions/runs/1/job/1" };
}

const TITLE = { workflow: "Pull request title", event: "pull_request_target" };

test("a failed check that a later run of the same check passed no longer reads as failing", () => {
  // The shape GitHub returned for teamupstart/mission-control#1170: the title check failed,
  // the title was edited, the check ran again on the same commit and passed. `gh pr checks`
  // reports it passing; the chip held the alert until the pull request closed.
  const rollup = rollUpChecks([
    run("build", "SUCCESS", "2026-10-07T19:59:00Z", "2026-10-07T20:05:00Z"),
    run("release-compatible title", "FAILURE", "2026-10-07T20:00:22Z", "2026-10-07T20:00:29Z", TITLE),
    run("release-compatible title", "SUCCESS", "2026-10-07T20:01:35Z", "2026-10-07T20:01:42Z", TITLE),
  ]);
  assert.deepEqual(rollup, { checks: "passing", retriedFailure: true, unconfirmedRetry: false, recognized: true });
});

test("the latest run failing is still failing, whatever passed before it", () => {
  const rollup = rollUpChecks([
    run("unit", "SUCCESS", "2026-10-07T20:00:00Z", "2026-10-07T20:02:00Z"),
    run("unit", "FAILURE", "2026-10-07T20:03:00Z", "2026-10-07T20:05:00Z"),
  ]);
  assert.equal(rollup.checks, "failing");
  assert.equal(rollup.retriedFailure, false);
});

test("a run cancelled and started over by a concurrency group stops counting once the new run passes", () => {
  const rollup = rollUpChecks([
    run("e2e (shard 4/15)", "CANCELLED", "2026-10-26T20:04:07Z", "2026-10-26T20:05:10Z"),
    run("e2e (shard 4/15)", "SUCCESS", "2026-10-26T20:05:12Z", "2026-10-26T20:09:00Z"),
  ]);
  assert.equal(rollup.checks, "passing");
});

test("a cancelled check nothing re-ran still reads as failing, as GitHub reads it", () => {
  const coderabbit = { __typename: "CheckRun", name: "CodeRabbit", status: "COMPLETED", conclusion: "CANCELLED",
    startedAt: "2026-11-17T17:12:01Z", completedAt: "2026-11-17T17:19:40Z", checkSuite: { app: { slug: "coderabbitai" }, workflowRun: null } };
  assert.equal(rollUpChecks([coderabbit]).checks, "failing");
});

test("a re-run still in progress reads as pending, not failing", () => {
  const rollup = rollUpChecks([
    run("unit", "FAILURE", "2026-10-07T20:00:00Z", "2026-10-07T20:02:00Z"),
    run("unit", null, "2026-10-07T20:03:00Z", null),
  ]);
  assert.equal(rollup.checks, "pending");
  assert.equal(rollup.retriedFailure, true);
});

test("a re-run that has not started yet does not clear the failure", () => {
  assert.equal(rollUpChecks([run("unit", "FAILURE", "2026-10-07T20:00:00Z", "2026-10-07T20:02:00Z"), run("unit", null, null, null)]).checks, "failing");
});

test("a push run and a pull_request run of one job are different checks, whatever their timing", () => {
  // The case a workflow-and-name identity gets wrong: the two runs do not overlap, so a later
  // pass would have looked exactly like a re-run of the failure.
  const push = { event: "push" };
  const pr = { event: "pull_request" };
  const pushFailedFirst = rollUpChecks([
    run("build", "FAILURE", "2026-10-07T20:00:00Z", "2026-10-07T20:03:00Z", push),
    run("build", "SUCCESS", "2026-10-07T20:10:00Z", "2026-10-07T20:14:00Z", pr),
  ]);
  const prFailedFirst = rollUpChecks([
    run("build", "FAILURE", "2026-10-07T20:00:00Z", "2026-10-07T20:03:00Z", pr),
    run("build", "SUCCESS", "2026-10-07T20:10:00Z", "2026-10-07T20:14:00Z", push),
  ]);
  for (const rollup of [pushFailedFirst, prFailedFirst]) {
    assert.equal(rollup.checks, "failing");
    assert.equal(rollup.retriedFailure, false);
  }
  // The same event running again is still the same check.
  assert.equal(rollUpChecks([
    run("build", "FAILURE", "2026-10-07T20:00:00Z", "2026-10-07T20:03:00Z", push),
    run("build", "SUCCESS", "2026-10-07T20:10:00Z", "2026-10-07T20:14:00Z", pr),
    run("build", "SUCCESS", "2026-10-07T20:20:00Z", "2026-10-07T20:24:00Z", push),
  ]).checks, "passing");
});

test("overlapping runs of one check are independent verdicts, so a failure in either counts", () => {
  const failedFirst = rollUpChecks([
    run("build", "FAILURE", "2026-10-07T20:00:00Z", "2026-10-07T20:03:00Z"),
    run("build", "SUCCESS", "2026-10-07T20:00:05Z", "2026-10-07T20:04:00Z"),
  ]);
  const failedLast = rollUpChecks([
    run("build", "SUCCESS", "2026-10-07T20:00:00Z", "2026-10-07T20:03:00Z"),
    run("build", "FAILURE", "2026-10-07T20:00:05Z", "2026-10-07T20:04:00Z"),
  ]);
  assert.equal(failedFirst.checks, "failing");
  assert.equal(failedLast.checks, "failing");
});

test("two runs reported in the same second never retire each other", () => {
  const at = "2026-10-07T20:00:00Z";
  assert.equal(rollUpChecks([run("lint", "FAILURE", at, at), run("lint", "SUCCESS", at, at)]).checks, "failing");
});

test("a re-run must start in a later second than the failure finished in", () => {
  // GitHub reports whole seconds: a start in the finishing second may still have overlapped it.
  const failed = run("unit", "FAILURE", "2026-10-07T10:00:00Z", "2026-10-07T10:01:00Z");
  assert.equal(rollUpChecks([failed, run("unit", "SUCCESS", "2026-10-07T10:01:00Z", "2026-10-07T10:03:00Z")]).checks, "failing");
  assert.equal(rollUpChecks([failed, run("unit", "SUCCESS", "2026-10-07T10:01:01Z", "2026-10-07T10:03:00Z")]).checks, "passing");
});

test("two workflow files that share a display name are different workflows", () => {
  // Both called `CI`, both running `build` on `pull_request`: only the workflow's id tells them apart.
  const rollup = rollUpChecks([
    run("build", "FAILURE", "2026-10-07T20:00:00Z", "2026-10-07T20:01:00Z", { workflow: "CI", workflowId: "W_ci_yml" }),
    run("build", "SUCCESS", "2026-10-07T20:02:00Z", "2026-10-07T20:03:00Z", { workflow: "CI", workflowId: "W_ci_nightly_yml" }),
  ]);
  assert.equal(rollup.checks, "failing");
  assert.equal(rollup.retriedFailure, false);
});

test("a check with the same name in another workflow is a different check", () => {
  const rollup = rollUpChecks([
    run("build", "FAILURE", "2026-10-07T20:00:00Z", "2026-10-07T20:01:00Z", { workflow: "Release" }),
    run("build", "SUCCESS", "2026-10-07T20:02:00Z", "2026-10-07T20:03:00Z", { workflow: "CI" }),
  ]);
  assert.equal(rollup.checks, "failing");
});

test("another app's failed check is never retired, even by its own later pass of that name", () => {
  // A third-party app reports the app and the name and nothing else, and it can report two
  // independent checks under one name. Nothing tells a re-run from a sibling, so the failure
  // stands, as GitHub's own aggregate has it.
  const appRun = (app: string, conclusion: string, startedAt: string, completedAt: string) => ({
    __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion, startedAt, completedAt,
    checkSuite: { app: { slug: app }, workflowRun: null },
  });
  for (const [failed, passed] of [["circleci-checks", "circleci-checks"], ["other-bot", "circleci-checks"]]) {
    const rollup = rollUpChecks([
      appRun(failed!, "FAILURE", "2026-10-07T20:00:00Z", "2026-10-07T20:01:00Z"),
      appRun(passed!, "SUCCESS", "2026-10-07T20:02:00Z", "2026-10-07T20:03:00Z"),
    ]);
    assert.equal(rollup.checks, "failing", `${failed} then ${passed}`);
    assert.equal(rollup.retriedFailure, false, `${failed} then ${passed}`);
  }
});

test("an Actions run whose suite does not name its app, workflow run, workflow or event never retires another", () => {
  const anonymous = (event: string | null, conclusion: string, startedAt: string, completedAt: string) => ({
    __typename: "CheckRun", name: "unit", status: "COMPLETED", conclusion, startedAt, completedAt,
    checkSuite: { app: null, workflowRun: { event, workflow: { name: "CI" } } },
  });
  assert.equal(rollUpChecks([
    anonymous("pull_request", "FAILURE", "2026-10-07T20:00:00Z", "2026-10-07T20:01:00Z"),
    anonymous("pull_request", "SUCCESS", "2026-10-07T20:02:00Z", "2026-10-07T20:03:00Z"),
  ]).checks, "failing");
  assert.equal(rollUpChecks([
    run("unit", "FAILURE", "2026-10-07T20:00:00Z", "2026-10-07T20:01:00Z"),
    { ...run("unit", "SUCCESS", "2026-10-07T20:02:00Z", "2026-10-07T20:03:00Z"),
      checkSuite: { app: { slug: "github-actions" }, workflowRun: { event: null, workflow: { id: "W_CI", name: "CI" } } } },
  ]).checks, "failing");
  // No workflow run at all, on a suite GitHub Actions reported: two workflows' `build` jobs would
  // otherwise share one key.
  const noRun = (conclusion: string, startedAt: string, completedAt: string) => ({
    __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion, startedAt, completedAt,
    checkSuite: { app: { slug: "github-actions" }, workflowRun: null },
  });
  assert.equal(rollUpChecks([
    noRun("FAILURE", "2026-10-07T20:00:00Z", "2026-10-07T20:01:00Z"),
    noRun("SUCCESS", "2026-10-07T20:02:00Z", "2026-10-07T20:03:00Z"),
  ]).checks, "failing");
  // No workflow name: a later pass from another workflow's `build` would otherwise share the key
  // of this one's failure and clear it, and the Inspector would release the merge gate on it.
  for (const workflow of [null, { id: null, name: "CI" }, { id: "", name: "CI" }, { name: "CI" }]) {
    const unnamed = (conclusion: string, startedAt: string, completedAt: string) => ({
      __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion, startedAt, completedAt,
      checkSuite: { app: { slug: "github-actions" }, workflowRun: { event: "pull_request", workflow } },
    });
    const rollup = rollUpChecks([
      unnamed("FAILURE", "2026-10-07T20:00:00Z", "2026-10-07T20:01:00Z"),
      unnamed("SUCCESS", "2026-10-07T20:02:00Z", "2026-10-07T20:03:00Z"),
    ]);
    assert.equal(rollup.checks, "failing", JSON.stringify(workflow));
    assert.equal(rollup.retriedFailure, false, JSON.stringify(workflow));
  }
});

test("gh pr list's export never retires a run, but flags a failure that looks re-checked", () => {
  // It carries the workflow and name and nothing else, which is exactly what cannot tell a
  // title check's re-run from a `pull_request` pass beside a failed `push` run.
  const looksRetried = rollUpChecks([
    ghRun("release-compatible title", "FAILURE", "2026-10-07T20:00:22Z", "2026-10-07T20:00:29Z", "Pull request title"),
    ghRun("release-compatible title", "SUCCESS", "2026-10-07T20:01:35Z", "2026-10-07T20:01:42Z", "Pull request title"),
  ]);
  assert.deepEqual(looksRetried, { checks: "failing", retriedFailure: false, unconfirmedRetry: true, recognized: true });
  const plainFailure = rollUpChecks([ghRun("unit", "FAILURE", "2026-10-07T20:00:00Z", "2026-10-07T20:01:00Z")]);
  assert.equal(plainFailure.unconfirmedRetry, false);
  // A pending re-run keeps its zero completion time from counting as an instant.
  const pending = { ...ghRun("unit", "", ZERO, ZERO), status: "QUEUED" };
  assert.equal(rollUpChecks([ghRun("unit", "FAILURE", "2026-10-07T20:00:00Z", "2026-10-07T20:01:00Z"), pending]).unconfirmedRetry, false);
});

test("a later commit status for the same context replaces an earlier one", () => {
  const status = (state: string, at: string) => ({ __typename: "StatusContext", context: "ci/legacy", state, createdAt: at });
  assert.equal(rollUpChecks([status("FAILURE", "2026-10-07T20:00:00Z"), status("SUCCESS", "2026-10-07T20:01:00Z")]).checks, "passing");
  assert.equal(rollUpChecks([status("SUCCESS", "2026-10-07T20:00:00Z"), status("ERROR", "2026-10-07T20:01:00Z")]).checks, "failing");
  // `gh` exports the same instant as `startedAt`.
  const exported = (state: string, at: string) => ({ __typename: "StatusContext", context: "ci/legacy", state, targetUrl: "", startedAt: at });
  assert.equal(rollUpChecks([exported("FAILURE", "2026-10-07T20:00:00Z"), exported("SUCCESS", "2026-10-07T20:01:00Z")]).checks, "passing");
});

test("an unrecognised result reads as passing but is reported as unrecognised", () => {
  const rollup = rollUpChecks([run("future", "SOMETHING_NEW", "2026-10-07T20:00:00Z", "2026-10-07T20:01:00Z")]);
  assert.deepEqual(rollup, { checks: "passing", retriedFailure: false, unconfirmedRetry: false, recognized: false });
});

test("no checks, or none in a shape we know, roll up to null", () => {
  assert.equal(rollUpChecks([]).checks, null);
  assert.equal(rollUpChecks([null, 7, { __typename: "Mystery" }]).checks, null);
});

test("an unreadable entry makes the whole answer unrecognised", () => {
  // GraphQL allows a null node, and the one it hides could be the failure that still counts.
  const rollup = rollUpChecks([
    run("unit", "FAILURE", "2026-10-07T20:00:00Z", "2026-10-07T20:01:00Z"),
    null,
    run("unit", "SUCCESS", "2026-10-07T20:02:00Z", "2026-10-07T20:03:00Z"),
  ]);
  assert.equal(rollup.checks, "passing");
  assert.equal(rollup.retriedFailure, true);
  assert.equal(rollup.recognized, false);
  assert.equal(rollUpChecks([]).recognized, true);
});
