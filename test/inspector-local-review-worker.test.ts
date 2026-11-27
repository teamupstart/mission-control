import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Registry } from "../src/server/registry.ts";
import type { WorkflowLocalReviewMatch } from "../src/shared/workflow.ts";
import { tempDir } from "./temp-root.mjs";

// A head the Local Inspector already passed gets no GitHub review, no reply and no post, and
// the worker keeps observing its pull request.
//
// Drives the real Inspector loop through a fake `gh` and a fake model runner, so it spends no
// model tokens. The workflow manager's match answer is injected through the same start option
// the daemon wires, so the worker is exercised exactly as it is called in production.
const temp = tempDir("mission-inspector-local-review-");
const binDir = join(temp, "bin");
const statePath = join(temp, "github-state.json");
const modelCallsPath = join(temp, "model-calls.txt");
const claudePath = join(binDir, "claude");
const ghPath = join(binDir, "gh");
const project = fileURLToPath(new URL("..", import.meta.url));

mkdirSync(binDir, { recursive: true });
process.env.MISSION_HOME = join(temp, "state");
process.env.MISSION_CLAUDE_BIN = claudePath;
process.env.MISSION_INSPECTOR_POLL_MS = "25";
process.env.FAKE_GITHUB_STATE = statePath;
process.env.FAKE_MODEL_CALLS = modelCallsPath;
process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;

// Every model call - review or reply - is counted. A clean verdict that is also a valid reply:
// `resolved: null` reads as "nothing resolved" to the review schema and as `false` to the reply's.
writeFileSync(claudePath, `#!/usr/bin/env node
const fs = require("node:fs");
process.stdin.resume();
process.stdin.on("end", () => {
  const path = process.env.FAKE_MODEL_CALLS;
  fs.writeFileSync(path, String(Number(fs.readFileSync(path, "utf8")) + 1));
  process.stdout.write(JSON.stringify({ result: JSON.stringify({ summary: "Clean.", findings: [], resolved: null,
    reply: "Answered." }) }));
});
`);
chmodSync(claudePath, 0o755);

const { configureClaudeRunnerTransport } = await import("../src/server/llm/claude.ts");
const restoreTransport = configureClaudeRunnerTransport(() => "print");

writeFileSync(ghPath, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const statePath = process.env.FAKE_GITHUB_STATE;
const load = () => JSON.parse(fs.readFileSync(statePath, "utf8"));
const save = (state) => {
  const tmp = statePath + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, statePath);
};
if (args[0] === "api" && args[1] === "user") {
  process.stdout.write("operator\\n");
} else if (args.includes("graphql")) {
  const state = load();
  state.sweeps += 1;
  save(state);
  process.stdout.write(JSON.stringify({ data: { repository: { pullRequest: {
    state: "OPEN", headRefOid: state.headSha, headRefName: "feature", isDraft: false,
    title: "Locally reviewed", body: "", createdAt: "2020-01-01T00:00:00Z",
    mergeable: "MERGEABLE", reviewDecision: null, baseRefName: "main", baseRefOid: "base-1",
    mergeCommit: null, mergedAt: null, repository: { defaultBranchRef: { name: "main" } },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
    reviewThreads: { nodes: state.threads, pageInfo: { hasNextPage: false, endCursor: null } },
    reviews: { nodes: [], pageInfo: { hasPreviousPage: false, startCursor: null } },
  } } } }));
} else if (args.includes("--method") && args.includes("POST")) {
  const state = load();
  state.posts.push(args.join(" "));
  save(state);
  process.stdout.write("{}");
} else if (args.includes("--jq") && args.includes(".head.sha")) {
  process.stdout.write(load().headSha + "\\n");
} else if (args.some((arg) => /repos\\/mission\\/control\\/pulls\\/\\d+$/.test(arg))) {
  process.stdout.write("diff --git a/src/example.ts b/src/example.ts\\n--- a/src/example.ts\\n+++ b/src/example.ts\\n@@ -1 +1 @@\\n-export const value = 1;\\n+export const value = 2;\\n");
} else {
  process.stderr.write("unexpected fake gh invocation: " + JSON.stringify(args));
  process.exit(2);
}
`);
chmodSync(ghPath, 0o755);

const { openDb, getInspectorPr, upsertInspectorComment } = await import("../src/server/db.ts");
const { setInspectorConfig } = await import("../src/server/inspector/config.ts");
const { setShippingConfig } = await import("../src/server/shipping/config.ts");
const { adoptPr, startInspector } = await import("../src/server/inspector/worker.ts");
const { resetAuthenticatedLogin } = await import("../src/server/inspector/github.ts");
const { formatMarker } = await import("../src/server/inspector/marker.ts");

interface FakeGithubState { headSha: string; threads: unknown[]; posts: string[]; sweeps: number }

function writeGithubState(state: Partial<FakeGithubState> = {}): void {
  const tmp = `${statePath}.seed.tmp`;
  writeFileSync(tmp, JSON.stringify({ headSha: "head-1", threads: [], posts: [], sweeps: 0, ...state }));
  renameSync(tmp, statePath);
}
const github = (): FakeGithubState => JSON.parse(readFileSync(statePath, "utf8")) as FakeGithubState;
const modelCalls = (): number => Number(readFileSync(modelCallsPath, "utf8"));

let stopAtSweepEnd: (() => void) | null = null;
function registryStub(): Registry {
  return {
    onPrOpened: () => () => {},
    onPipelineRun: () => () => {},
    refreshInspections: () => { stopAtSweepEnd?.(); },
    snapshot: () => ({ sessions: [] }),
  } as unknown as Registry;
}

/** What the workflow manager would answer: a match for `matching` heads, nothing otherwise. */
const asked: Array<{ prKey: string; headSha: string; baseRefName: string | null }> = [];
let matching = new Set<string>();
/** Makes the matcher reject, as a manager whose store or git read failed would. */
let rejecting = false;
const localReview = async (prKey: string, head: { headSha: string; baseRefName: string | null }):
  Promise<WorkflowLocalReviewMatch | null> => {
  asked.push({ prKey, ...head });
  if (rejecting) throw new Error("fixture: the local review match could not be read");
  return matching.has(head.headSha)
    ? { submissionId: "submission", attemptId: "attempt", headSha: head.headSha, treeOid: "t".repeat(40),
      baseRef: "refs/remotes/origin/main" }
    : null;
};

async function runOneSweep(): Promise<void> {
  let stop = () => {};
  const finished = new Promise<void>((resolve) => {
    stopAtSweepEnd = () => { stop(); stopAtSweepEnd = null; resolve(); };
  });
  stop = startInspector(registryStub(), { localReview });
  await finished;
}

function adopt(number: number): string {
  assert.equal(adoptPr(`https://github.com/mission/control/pull/${number}`,
    { sessionId: null, cwd: project, repoRoot: project }, "hook", Date.now()), true);
  return `mission/control#${number}`;
}

const live = () => setInspectorConfig({ enabled: true, mode: "live", repoAllowlist: [project], maxCommentsPerRound: 8 });
const dryRun = () => setInspectorConfig({ enabled: true, mode: "dry-run", repoAllowlist: [project], maxCommentsPerRound: 8 });

beforeEach(() => {
  openDb().exec("DELETE FROM inspector_prs; DELETE FROM inspector_comments; DELETE FROM app_config");
  resetAuthenticatedLogin();
  writeFileSync(modelCallsPath, "0");
  asked.length = 0;
  matching = new Set();
  rejecting = false;
  setShippingConfig({ autoMerge: false, codeRabbitAutoResolve: false });
});

after(() => {
  restoreTransport();
  rmSync(temp, { recursive: true, force: true });
});

/**
 * A colleague's question on an Inspector thread from an earlier GitHub round. Answering it is a
 * model call and a POST, so their absence is what "answers no thread" looks like - and the
 * control case below proves this fixture does draw a reply when the head is not matched.
 */
function seedWaitingQuestion(key: string, number: number): void {
  upsertInspectorComment({ id: `earlier-${number}`, prKey: key, fingerprint: "fp-earlier", path: "src/example.ts", line: 1,
    title: "Earlier finding", body: "From a GitHub round.", severity: "major", round: 1, status: "open", replies: 0,
    answeredCommentId: null, postedAt: 1, createdAt: 1, updatedAt: 1 });
  writeGithubState({ threads: [{ id: "T_1", isResolved: false, path: "src/example.ts", comments: { nodes: [
    { databaseId: 11, url: `https://github.com/mission/control/pull/${number}#discussion_r11`, createdAt: "2026-10-15T00:00:00Z",
      body: `${formatMarker({ id: `earlier-${number}`, fingerprint: "fp-earlier", round: 1 })}\nEarlier finding`, author: { login: "operator" } },
    { databaseId: 12, url: `https://github.com/mission/control/pull/${number}#discussion_r12`, createdAt: "2026-10-15T00:01:00Z",
      body: "Why is this a problem?", author: { login: "colleague" } },
  ] } }] });
}

test("control: the waiting question draws a reply when the head is not matched", async () => {
  live();
  const key = adopt(900);
  seedWaitingQuestion(key, 900);
  await runOneSweep();
  assert.ok(modelCalls() >= 1, "the fixture question was answered");
  assert.ok(github().posts.some((post) => post.includes("/comments")), "the reply was posted");
});

test("a Live matched head gets no review, reply or post, is recorded local, and stays observed", async () => {
  live();
  const key = adopt(901);
  seedWaitingQuestion(key, 901);
  matching = new Set(["head-1"]);

  await runOneSweep();
  assert.deepEqual(asked, [{ prKey: key, headSha: "head-1", baseRefName: "main" }], "the worker asked the manager once, after observing");
  assert.equal(modelCalls(), 0, "no review and no reply ran");
  assert.deepEqual(github().posts, [], "nothing was posted");
  const row = getInspectorPr(key)!;
  assert.equal(row.reviewPosture, "local");
  assert.equal(row.localReviewHeadSha, "head-1");
  assert.equal(row.headSha, "head-1");
  assert.equal(row.observedHeadSha, "head-1", "the pull request was still observed");
  assert.equal(row.round, 0, "no GitHub round was counted");

  // A second sweep keeps observing and still asks GitHub for nothing.
  await runOneSweep();
  assert.equal(github().sweeps, 2);
  assert.equal(modelCalls(), 0);
  assert.deepEqual(github().posts, []);
});

test("Dry run records a matched head as dry-run, then local after a switch to Live, with no review either time", async () => {
  dryRun();
  const key = adopt(902);
  writeGithubState();
  matching = new Set(["head-1"]);

  await runOneSweep();
  assert.equal(getInspectorPr(key)?.reviewPosture, "dry-run", "Dry run never produces a local head");
  assert.equal(getInspectorPr(key)?.localReviewHeadSha, "head-1");
  assert.equal(modelCalls(), 0);

  live();
  await runOneSweep();
  assert.equal(getInspectorPr(key)?.reviewPosture, "local");
  assert.equal(modelCalls(), 0, "the switch to Live did not force a GitHub review of a matched head");
  assert.deepEqual(github().posts, []);
});

test("a head that does not match is reviewed on GitHub as before", async () => {
  live();
  const key = adopt(903);
  writeGithubState({ headSha: "head-2" });
  matching = new Set(["head-1"]);

  await runOneSweep();
  assert.equal(modelCalls(), 1, "the other head got its GitHub review");
  assert.equal(getInspectorPr(key)?.reviewPosture, "live");
  assert.equal(getInspectorPr(key)?.localReviewHeadSha ?? null, null);
  assert.ok(github().posts.length > 0, "the Live review was posted");
});

test("a local head that stops matching is reviewed on GitHub once the posture is Live", async () => {
  live();
  const key = adopt(904);
  writeGithubState();
  matching = new Set(["head-1"]);
  await runOneSweep();
  assert.equal(getInspectorPr(key)?.reviewPosture, "local");

  // Local review switched off, or the repository given the merge grant: the manager answers no.
  matching = new Set();
  await runOneSweep();
  assert.equal(modelCalls(), 1);
  assert.equal(getInspectorPr(key)?.reviewPosture, "live");
});

test("a worker started without a matcher never skips a review", async () => {
  live();
  const key = adopt(905);
  writeGithubState();
  let stop = () => {};
  const finished = new Promise<void>((resolve) => {
    stopAtSweepEnd = () => { stop(); stopAtSweepEnd = null; resolve(); };
  });
  stop = startInspector(registryStub());
  await finished;
  assert.equal(modelCalls(), 1);
  assert.equal(getInspectorPr(key)?.reviewPosture, "live");
});

test("a matcher that rejects is no match: the GitHub review starts and nothing is recorded as local", async (t) => {
  live();
  const key = adopt(906);
  writeGithubState();
  // Even a head the manager would otherwise vouch for: a failed answer must never skip a review.
  matching = new Set(["head-1"]);
  rejecting = true;
  const logged = t.mock.method(console, "error", () => {});

  await runOneSweep();
  assert.deepEqual(asked, [{ prKey: key, headSha: "head-1", baseRefName: "main" }], "the worker did ask");
  assert.equal(modelCalls(), 1, "the GitHub review began");
  assert.ok(github().posts.length > 0, "the Live review was posted");
  const row = getInspectorPr(key)!;
  assert.equal(row.reviewPosture, "live");
  assert.equal(row.localReviewHeadSha ?? null, null, "the head is not recorded as locally reviewed");
  assert.ok(logged.mock.calls.some((call) => String(call.arguments[0]).includes("local review match failed")),
    "the failure was reported");
});

test("in Dry run, a head recorded from a local match that stops matching gets its GitHub review, once", async () => {
  dryRun();
  const key = adopt(907);
  writeGithubState();
  matching = new Set(["head-1"]);
  await runOneSweep();
  assert.equal(modelCalls(), 0);
  assert.equal(getInspectorPr(key)?.reviewPosture, "dry-run");
  assert.equal(getInspectorPr(key)?.localReviewHeadSha, "head-1");

  // Local review switched off (or the merge grant given) while the Inspector stays in Dry run.
  // The local record is not a review, so the same head is reviewed - recorded, never posted.
  matching = new Set();
  await runOneSweep();
  assert.equal(modelCalls(), 1, "the GitHub review ran");
  const row = getInspectorPr(key)!;
  assert.equal(row.reviewPosture, "dry-run");
  assert.equal(row.headSha, "head-1");
  assert.equal(row.localReviewHeadSha ?? null, null, "the review replaced the local record");
  assert.deepEqual(github().posts, [], "Dry run posts nothing");

  // Reviewed now, so the next sweep reuses that review instead of reviewing again.
  await runOneSweep();
  assert.equal(modelCalls(), 1);
});
