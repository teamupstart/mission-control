import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./temp-root.mjs";

// The branch poller's half of issue #1511: the PR chip's "a CI check failed" alert.
//
// `gh pr list --json statusCheckRollup` names each run's workflow and check but not its app or
// triggering event, so a failure followed by a later run of the same name could be the check
// running again - the title check after an edit - or a `pull_request` pass beside a failed `push`
// run of the same job. The poller reads the commit's checks through GraphQL before it clears
// anything, and keeps the failure unless that answer proves the later run was the same check.

const dir = tempDir("mission-pr-retried-checks-");
const gh = join(dir, "gh");
const calls = join(dir, "calls");
const answer = join(dir, "answer.json");
process.env.MISSION_GH_BIN = gh;
writeFileSync(calls, "");
writeFileSync(gh, `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');
const reply = JSON.parse(fs.readFileSync(${JSON.stringify(answer)}, 'utf8'));
if (reply.exit) { process.stderr.write('HTTP 502 (fake)'); process.exit(reply.exit); }
process.stdout.write(JSON.stringify(reply.body));
`);
chmodSync(gh, 0o755);
const { confirmRetriedChecks } = await import("../src/server/pr.ts");
after(() => rmSync(dir, { force: true, recursive: true }));

const HEAD = "a".repeat(40);
let prNumber = 1;
/** A fresh pull request per case, so one case's confirmed verdict never answers another's. */
function nextPr(): { url: string; headSha: string } {
  prNumber += 1;
  return { url: `https://github.com/acme/demo/pull/${prNumber}`, headSha: HEAD };
}

function ghRun(name: string, workflowName: string, conclusion: string, startedAt: string, completedAt: string) {
  return { __typename: "CheckRun", name, workflowName, status: "COMPLETED", conclusion, startedAt, completedAt,
    detailsUrl: "https://github.com/acme/demo/actions/runs/1/job/1" };
}

let suites = 0;
/** A GraphQL Actions run, each in its own check suite: a re-run is a new workflow run. */
function node(name: string, workflow: string, event: string, conclusion: string, startedAt: string, completedAt: string) {
  return { __typename: "CheckRun", name, status: "COMPLETED", conclusion, startedAt, completedAt,
    checkSuite: { id: `CS_${++suites}`, app: { slug: "github-actions" }, workflowRun: { event, workflow: { id: `W_${workflow}`, name: workflow } } } };
}

function reply(nodes: unknown[], { oid = HEAD, hasNextPage = false } = {}): void {
  writeFileSync(answer, JSON.stringify({ body: { data: { repository: { pullRequest: { commits: { nodes: [{ commit: {
    oid, statusCheckRollup: { contexts: { pageInfo: { hasNextPage }, nodes } },
  } }] } } } } } }));
}

function ghCalls(): string[][] {
  return readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
}

// The title check failed, the title was edited, and the check ran again on the same commit.
const TITLE_RUNS = [
  ghRun("release-compatible title", "Pull request title", "FAILURE", "2026-10-07T20:00:22Z", "2026-10-07T20:00:29Z"),
  ghRun("release-compatible title", "Pull request title", "SUCCESS", "2026-10-07T20:01:35Z", "2026-10-07T20:01:42Z"),
];
const TITLE_NODES = [
  node("release-compatible title", "Pull request title", "pull_request_target", "FAILURE", "2026-10-07T20:00:22Z", "2026-10-07T20:00:29Z"),
  node("release-compatible title", "Pull request title", "pull_request_target", "SUCCESS", "2026-10-07T20:01:35Z", "2026-10-07T20:01:42Z"),
];

test("a re-run GitHub confirms is the same check clears the alert, and is read once per rollup", async () => {
  writeFileSync(calls, "");
  reply(TITLE_NODES);
  const pr = nextPr();
  assert.equal(await confirmRetriedChecks(dir, pr, { statusCheckRollup: TITLE_RUNS }), "passing");
  const [args] = ghCalls();
  assert.deepEqual(args?.slice(0, 2), ["api", "graphql"]);
  assert.ok(args?.includes("owner=acme") && args.includes("name=demo") && args.includes(`number=${prNumber}`));
  assert.match(args?.find((arg) => arg.startsWith("query=")) ?? "", /workflowRun\{ event workflow\{ id name \} \}/);
  // The next tick sees the same rollup: the confirmed answer stands without another read.
  assert.equal(await confirmRetriedChecks(dir, pr, { statusCheckRollup: TITLE_RUNS }), "passing");
  assert.equal(ghCalls().length, 1);
});

test("a failed push run is not cleared by a later passing pull_request run of the same job", async () => {
  // Indistinguishable from a re-run in `gh pr list`'s answer, and the runs do not overlap.
  const runs = [
    ghRun("build", "CI", "FAILURE", "2026-10-07T20:00:00Z", "2026-10-07T20:03:00Z"),
    ghRun("build", "CI", "SUCCESS", "2026-10-07T20:10:00Z", "2026-10-07T20:14:00Z"),
  ];
  reply([
    node("build", "CI", "push", "FAILURE", "2026-10-07T20:00:00Z", "2026-10-07T20:03:00Z"),
    node("build", "CI", "pull_request", "SUCCESS", "2026-10-07T20:10:00Z", "2026-10-07T20:14:00Z"),
  ]);
  assert.equal(await confirmRetriedChecks(dir, nextPr(), { statusCheckRollup: runs }), "failing");
});

test("the failure stands whenever GitHub's answer is not a complete one about the same head", async (t) => {
  await t.test("the read fails", async () => {
    writeFileSync(answer, JSON.stringify({ exit: 1 }));
    assert.equal(await confirmRetriedChecks(dir, nextPr(), { statusCheckRollup: TITLE_RUNS }), "failing");
  });
  await t.test("GraphQL reports an error", async () => {
    writeFileSync(answer, JSON.stringify({ body: { errors: [{ message: "Resource not accessible" }], data: null } }));
    assert.equal(await confirmRetriedChecks(dir, nextPr(), { statusCheckRollup: TITLE_RUNS }), "failing");
  });
  await t.test("the head moved since gh pr list read it", async () => {
    reply(TITLE_NODES, { oid: "b".repeat(40) });
    assert.equal(await confirmRetriedChecks(dir, nextPr(), { statusCheckRollup: TITLE_RUNS }), "failing");
  });
  await t.test("more checks than one page holds", async () => {
    reply(TITLE_NODES, { hasNextPage: true });
    assert.equal(await confirmRetriedChecks(dir, nextPr(), { statusCheckRollup: TITLE_RUNS }), "failing");
  });
  await t.test("the re-run's result is one this code does not recognise", async () => {
    // The merge gate keeps GitHub's failure on such an answer; the chip must not clear it either.
    reply([TITLE_NODES[0], { ...TITLE_NODES[1], conclusion: "SOMETHING_NEW" }]);
    assert.equal(await confirmRetriedChecks(dir, nextPr(), { statusCheckRollup: TITLE_RUNS }), "failing");
  });
  await t.test("the answer carries an unreadable node", async () => {
    reply([TITLE_NODES[0], null, TITLE_NODES[1]]);
    assert.equal(await confirmRetriedChecks(dir, nextPr(), { statusCheckRollup: TITLE_RUNS }), "failing");
  });
  await t.test("a complete answer that leaves the reported failure out", async () => {
    // Only the pass comes back: nothing shows the failure gh reported being retired, so it stands,
    // and is read again on the next tick rather than remembered.
    const pr = nextPr();
    reply([TITLE_NODES[1]]);
    assert.equal(await confirmRetriedChecks(dir, pr, { statusCheckRollup: TITLE_RUNS }), "failing");
    reply(TITLE_NODES);
    assert.equal(await confirmRetriedChecks(dir, pr, { statusCheckRollup: TITLE_RUNS }), "passing");
  });
  await t.test("an answer with an unreadable node is read again rather than remembered", async () => {
    // Same pull request, head and gh rollup: the next tick must ask again, and can then clear.
    const pr = nextPr();
    reply([TITLE_NODES[0], null, TITLE_NODES[1]]);
    assert.equal(await confirmRetriedChecks(dir, pr, { statusCheckRollup: TITLE_RUNS }), "failing");
    reply(TITLE_NODES);
    assert.equal(await confirmRetriedChecks(dir, pr, { statusCheckRollup: TITLE_RUNS }), "passing");
  });
  await t.test("an unreadable answer is retried on the next tick rather than remembered", async () => {
    const pr = nextPr();
    writeFileSync(answer, JSON.stringify({ exit: 1 }));
    assert.equal(await confirmRetriedChecks(dir, pr, { statusCheckRollup: TITLE_RUNS }), "failing");
    reply(TITLE_NODES);
    assert.equal(await confirmRetriedChecks(dir, pr, { statusCheckRollup: TITLE_RUNS }), "passing");
  });
});

test("nothing that looks re-checked costs no extra read", async () => {
  writeFileSync(calls, "");
  const failing = [ghRun("unit", "CI", "FAILURE", "2026-10-07T20:00:00Z", "2026-10-07T20:01:00Z")];
  const passing = [ghRun("unit", "CI", "SUCCESS", "2026-10-07T20:00:00Z", "2026-10-07T20:01:00Z")];
  // Commit statuses never clear a failure, so a later status for the context is no re-run to confirm.
  const statuses = [
    { __typename: "StatusContext", context: "ci/legacy", state: "FAILURE", targetUrl: "", startedAt: "2026-10-07T20:00:00Z" },
    { __typename: "StatusContext", context: "ci/legacy", state: "SUCCESS", targetUrl: "", startedAt: "2026-10-07T20:01:00Z" },
  ];
  assert.equal(await confirmRetriedChecks(dir, nextPr(), { statusCheckRollup: statuses }), "failing");
  assert.equal(await confirmRetriedChecks(dir, nextPr(), { statusCheckRollup: failing }), "failing");
  assert.equal(await confirmRetriedChecks(dir, nextPr(), { statusCheckRollup: passing }), "passing");
  assert.equal(await confirmRetriedChecks(dir, nextPr(), {}), null);
  assert.equal(ghCalls().length, 0);
});

test("a rollup gh pr list may have cut short is confirmed afresh on every tick", async () => {
  // At 100 checks the export can be missing some, so a check added past the cut would leave the
  // remembered verdict's key unchanged.
  const filler = Array.from({ length: 98 }, (_, i) =>
    ghRun(`shard ${i}`, "CI", "SUCCESS", "2026-10-07T19:50:00Z", "2026-10-07T19:55:00Z"));
  const full = [...filler, ...TITLE_RUNS];
  assert.equal(full.length, 100);
  const pr = nextPr();
  reply(TITLE_NODES);
  writeFileSync(calls, "");
  assert.equal(await confirmRetriedChecks(dir, pr, { statusCheckRollup: full }), "passing");
  // The head gained a failing check past the cut: the next read sees more than one page.
  reply(TITLE_NODES, { hasNextPage: true });
  assert.equal(await confirmRetriedChecks(dir, pr, { statusCheckRollup: full }), "failing");
  assert.equal(ghCalls().length, 2);
});

test("a new run on the pull request is confirmed afresh", async () => {
  const pr = nextPr();
  reply(TITLE_NODES);
  assert.equal(await confirmRetriedChecks(dir, pr, { statusCheckRollup: TITLE_RUNS }), "passing");
  // The title check fails again later: the remembered answer was for a different rollup.
  const again = [...TITLE_RUNS,
    ghRun("release-compatible title", "Pull request title", "FAILURE", "2026-10-07T20:05:00Z", "2026-10-07T20:05:07Z")];
  reply([...TITLE_NODES,
    node("release-compatible title", "Pull request title", "pull_request_target", "FAILURE", "2026-10-07T20:05:00Z", "2026-10-07T20:05:07Z")]);
  assert.equal(await confirmRetriedChecks(dir, pr, { statusCheckRollup: again }), "failing");
});
