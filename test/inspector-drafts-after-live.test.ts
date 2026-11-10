import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Registry } from "../src/server/registry.ts";
import type { InspectorComment } from "../src/shared/types.ts";

// Findings drafted in dry run, after the operator switches the GitHub Inspector to live.
//
// Drives the real Inspector loop through a fake `gh` and a fake model runner, so it spends
// no model tokens. The fake `gh` can refuse a review POST in the ways GitHub does: a 422 for
// a comment it cannot anchor, or a whole-review refusal such as a rate limit. Environment
// overrides are installed before the worker is imported, because its runner and poll
// interval are resolved at module load.
const temp = mkdtempSync(join(tmpdir(), "mission-inspector-drafts-live-"));
const binDir = join(temp, "bin");
const statePath = join(temp, "github-state.json");
const reviewCountPath = join(temp, "review-count.txt");
const claudePath = join(binDir, "claude");
const ghPath = join(binDir, "gh");
const project = fileURLToPath(new URL("..", import.meta.url));

mkdirSync(binDir, { recursive: true });
process.env.MISSION_HOME = join(temp, "state");
process.env.MISSION_CLAUDE_BIN = claudePath;
process.env.MISSION_INSPECTOR_POLL_MS = "25";
process.env.FAKE_GITHUB_STATE = statePath;
process.env.FAKE_REVIEW_COUNT_PATH = reviewCountPath;
process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;

// The fake model. Its first review returns FAKE_FIRST_FINDINGS, and every later one returns
// nothing new and resolves nothing, which is what the review prompt asks of it once a finding
// has been raised. It also records every review prompt, so a test can read what it was told.
writeFileSync(
  claudePath,
  `#!/usr/bin/env node
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  const fs = require("node:fs");
  const prompt = Buffer.concat(chunks).toString("utf8");
  const countPath = process.env.FAKE_REVIEW_COUNT_PATH;
  const count = Number(fs.readFileSync(countPath, "utf8")) + 1;
  fs.writeFileSync(countPath, String(count));
  fs.writeFileSync(countPath + "." + count + ".prompt", prompt);
  const verdict = {
    summary: "Nothing else to flag.",
    findings: count === 1 ? JSON.parse(process.env.FAKE_FIRST_FINDINGS || "[]") : [],
    resolved: [],
  };
  process.stdout.write(JSON.stringify({ result: JSON.stringify(verdict) }));
});
`,
);
chmodSync(claudePath, 0o755);

const { configureClaudeRunnerTransport } = await import("../src/server/llm/claude.ts");
const restoreTransport = configureClaudeRunnerTransport(() => "print");

// The fake GitHub.
//
// A review POST is answered, in order, by:
//   1. the next entry of `forcedStatuses`, when there is one: a status other than 200 refuses
//      the whole review with that HTTP status, whatever it carries, and -1 makes gh die by a
//      signal before answering, which is a response lost rather than a refusal;
//   2. `rejectFingerprints`: a review carrying a comment whose marker names one of these is
//      refused with GitHub's 422 for a line it cannot resolve;
//   3. otherwise it is accepted.
// `headAfterRefusal` moves the head the moment a review is refused, so the moved-head check
// reads a different commit from the one the review was made for.
writeFileSync(
  ghPath,
  `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const statePath = process.env.FAKE_GITHUB_STATE;
const load = () => JSON.parse(fs.readFileSync(statePath, "utf8"));
// Written through a temp file and renamed, so a test polling the file never reads it half-written.
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
  process.stdout.write(JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          state: "OPEN",
          headRefOid: state.headSha,
          headRefName: "feature",
          isDraft: false,
          title: "Drafts after a switch to live",
          body: "Exercise posting dry-run drafts.",
          createdAt: "2020-01-01T00:00:00Z",
          mergeable: "MERGEABLE",
          reviewDecision: null,
          commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
          reviewThreads: { nodes: state.threads, pageInfo: { hasNextPage: false, endCursor: null } },
          reviews: { nodes: state.reviews, pageInfo: { hasPreviousPage: false, startCursor: null } }
        }
      }
    }
  }));
} else if (args.includes("--method") && args.includes("POST") && args.some((a) => /\\/reviews$/.test(a))) {
  const chunks = [];
  process.stdin.on("data", (chunk) => chunks.push(chunk));
  process.stdin.on("end", () => {
    const state = load();
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const fps = payload.comments.map((c) => (/ fp=(\\S+) /.exec(c.body) || [])[1]);
    state.attempts.push({ body: payload.body, fingerprints: fps, commit_id: payload.commit_id });
    const refuse = (status, message) => {
      state.refusals.push({ status, fingerprints: fps });
      if (state.headAfterRefusal) state.headSha = state.headAfterRefusal;
      save(state);
      process.stdout.write(JSON.stringify({ message }));
      process.stderr.write("gh: " + message + " (HTTP " + status + ")\\n");
      process.exit(1);
    };
    const forced = state.forcedStatuses.length ? state.forcedStatuses.shift() : 200;
    if (forced === -1) {
      save(state);
      process.kill(process.pid, "SIGKILL");
      return;
    }
    if (forced !== 200) return refuse(forced, forced === 429 ? "API rate limit exceeded" : "Refused");
    if (fps.some((fp) => state.rejectFingerprints.includes(fp))) {
      return refuse(422, "Unprocessable Entity: Line could not be resolved");
    }
    state.posts.push({ body: payload.body, fingerprints: fps, commit_id: payload.commit_id });
    payload.comments.forEach((c, i) => {
      state.threads.push({
        id: "T_" + (state.threads.length + 1),
        isResolved: false,
        path: c.path,
        comments: { nodes: [{
          databaseId: 1000 + state.threads.length,
          body: c.body,
          url: "https://github.com/mission/control/pull/1#discussion_r" + (1000 + state.threads.length),
          createdAt: "2026-10-15T00:00:00Z",
          author: { login: "operator" }
        }] }
      });
    });
    state.reviews.push({ body: payload.body, author: { login: "operator" }, commit: { oid: payload.commit_id } });
    save(state);
    process.stdout.write("{}");
  });
} else if (args.includes("--jq") && args.includes(".head.sha")) {
  const state = load();
  state.headReads += 1;
  save(state);
  process.stdout.write(state.headSha + "\\n");
} else if (args.some((arg) => /repos\\/mission\\/control\\/pulls\\/\\d+$/.test(arg))) {
  process.stdout.write([
    "diff --git a/src/example.ts b/src/example.ts",
    "--- a/src/example.ts",
    "+++ b/src/example.ts",
    "@@ -1 +1 @@",
    "-export const value = 1;",
    "+export const value = 2;",
    ""
  ].join("\\n"));
} else {
  process.stderr.write("unexpected fake gh invocation: " + JSON.stringify(args));
  process.exit(2);
}
`,
);
chmodSync(ghPath, 0o755);

const { openDb, getInspectorPr, loadInspectorComments, updateInspectorPr, upsertInspectorComment } =
  await import("../src/server/db.ts");
const { setInspectorConfig } = await import("../src/server/inspector/config.ts");
const { setShippingConfig } = await import("../src/server/shipping/config.ts");
const { adoptPr, startInspector } = await import("../src/server/inspector/worker.ts");
const { resetAuthenticatedLogin } = await import("../src/server/inspector/github.ts");
const { fingerprint } = await import("../src/server/inspector/marker.ts");
const { REVIEW_PROMPT_CAPS } = await import("../src/server/inspector/prompt.ts");

interface FakeGithubState {
  headSha: string;
  headAfterRefusal: string | null;
  forcedStatuses: number[];
  rejectFingerprints: string[];
  threads: unknown[];
  reviews: { body: string; author: { login: string }; commit: { oid: string } }[];
  attempts: { body: string; fingerprints: string[]; commit_id: string }[];
  posts: { body: string; fingerprints: string[]; commit_id: string }[];
  refusals: { status: number; fingerprints: string[] }[];
  headReads: number;
  sweeps: number;
}

function writeGithubState(state: Partial<FakeGithubState> = {}): void {
  const full: FakeGithubState = {
    headSha: "head-1",
    headAfterRefusal: null,
    forcedStatuses: [],
    rejectFingerprints: [],
    threads: [],
    reviews: [],
    attempts: [],
    posts: [],
    refusals: [],
    headReads: 0,
    sweeps: 0,
    ...state,
  };
  const tmp = `${statePath}.seed.tmp`;
  writeFileSync(tmp, JSON.stringify(full, null, 2));
  renameSync(tmp, statePath);
}

function readGithubState(): FakeGithubState {
  return JSON.parse(readFileSync(statePath, "utf8")) as FakeGithubState;
}

function reviewCount(): number {
  return Number(readFileSync(reviewCountPath, "utf8"));
}

let stopAtSweepEnd: (() => void) | null = null;
function registryStub(): Registry {
  return {
    onPrOpened: () => () => {},
    onPipelineRun: () => () => {},
    refreshInspections: () => { stopAtSweepEnd?.(); },
    snapshot: () => ({ sessions: [] }),
  } as unknown as Registry;
}

/** One full sweep of the real loop, stopped at its end so nothing runs under the next case. */
async function runOneSweep(): Promise<void> {
  let stop = () => {};
  const finished = new Promise<void>((resolve) => {
    stopAtSweepEnd = () => { stop(); stopAtSweepEnd = null; resolve(); };
  });
  stop = startInspector(registryStub());
  await finished;
}

function adopt(number: number): string {
  const key = `mission/control#${number}`;
  assert.equal(
    adoptPr(
      `https://github.com/mission/control/pull/${number}`,
      { sessionId: null, cwd: project, repoRoot: project },
      "hook",
      Date.now(),
    ),
    true,
  );
  return key;
}

function goLive(): void {
  setInspectorConfig({ enabled: true, mode: "live", repoAllowlist: [project], maxCommentsPerRound: 8 });
}

function byTitle(key: string): Map<string, InspectorComment> {
  return new Map(loadInspectorComments(key).map((r) => [r.title, r]));
}

beforeEach(() => {
  openDb().exec("DELETE FROM inspector_prs; DELETE FROM inspector_comments; DELETE FROM app_config");
  resetAuthenticatedLogin();
  delete process.env.FAKE_FIRST_FINDINGS;
  writeFileSync(reviewCountPath, "0");
  setShippingConfig({ autoMerge: false });
});

after(() => {
  restoreTransport();
  rmSync(temp, { recursive: true, force: true });
});

test("reproduction: findings drafted in dry run are posted by the forced re-review after a switch to live", async () => {
  // 1. In dry run, one round drafts two findings.
  process.env.FAKE_FIRST_FINDINGS = JSON.stringify([
    { path: "src/example.ts", line: 1, title: "First drafted finding", body: "Needs attention.", severity: "major" },
    { path: "src/example.ts", line: 1, title: "Second drafted finding", body: "Also this.", severity: "minor" },
  ]);
  writeGithubState();
  setInspectorConfig({ enabled: true, mode: "dry-run", repoAllowlist: [project], maxCommentsPerRound: 8 });
  const key = adopt(701);
  await runOneSweep();
  assert.equal(reviewCount(), 1, "the dry-run round reviewed the head");
  assert.equal(readGithubState().posts.length, 0, "dry run posts nothing");
  assert.deepEqual(loadInspectorComments(key).map((r) => r.status), ["drafted", "drafted"]);
  assert.equal(getInspectorPr(key)?.reviewPosture, "dry-run");

  // 2. The config switches to live, on an allowlisted repository.
  goLive();

  // 3. The next tick forces a re-review of the same head. The fake model raises nothing new
  //    and resolves nothing, as the prompt asks of a finding it has already raised.
  await runOneSweep();
  const state = readGithubState();
  const rows = loadInspectorComments(key);
  console.log(JSON.stringify({
    reviews: reviewCount(),
    reviewPosture: getInspectorPr(key)?.reviewPosture,
    reviewedHead: getInspectorPr(key)?.headSha,
    posts: state.posts.map((p) => p.fingerprints.length),
    rows: rows.map((r) => ({ title: r.title, status: r.status, postedAt: r.postedAt })),
  }));
  assert.equal(reviewCount(), 2, "the switch to live forced a second review of the same head");
  assert.equal(getInspectorPr(key)?.reviewPosture, "live");

  // 4. The drafts were posted, in one review, and stamped.
  assert.equal(state.posts.length, 1, "one review carried the drafted findings");
  assert.equal(state.posts[0]!.fingerprints.length, 2);
  for (const row of rows) {
    assert.equal(row.status, "open", `${row.title} reached GitHub`);
    assert.ok(row.postedAt != null, `${row.title} is stamped posted`);
  }

  // And the model was told what they were: never posted, not already on the pull request.
  const prompt = readFileSync(`${reviewCountPath}.2.prompt`, "utf8");
  assert.match(prompt, /## Found earlier but never posted/);
  assert.doesNotMatch(prompt, /## Issues you raised earlier that are still open/);
});

// ---- Refusals ----
//
// The rest seed the dry-run drafts directly, as the reproduction's first round leaves them:
// drafted rows on a head the GitHub Inspector reviewed in dry run. The switch to live then
// forces the re-review that carries them.

interface Draft {
  title: string;
  path?: string;
  severity?: InspectorComment["severity"];
  postRefusals?: number;
}

/** Drafted rows on a head reviewed in dry run, returning each draft's fingerprint by title. */
function seedDrafts(key: string, drafts: Draft[]): Map<string, string> {
  updateInspectorPr(key, { headSha: "head-1", reviewPosture: "dry-run", round: 1, lastReviewedAt: 1 }, Date.now());
  const fps = new Map<string, string>();
  drafts.forEach((d, i) => {
    const path = d.path ?? "src/example.ts";
    const fp = fingerprint(path, d.title);
    fps.set(d.title, fp);
    upsertInspectorComment({
      id: `draft-${i + 1}`, prKey: key, fingerprint: fp, path, line: 1, title: d.title,
      body: `Detail for ${d.title}.`, severity: d.severity ?? "major", round: 1, status: "drafted",
      replies: 0, answeredCommentId: null, postedAt: null, postRefusals: d.postRefusals ?? 0,
      lastPostError: d.postRefusals ? "an earlier refusal" : null, createdAt: i + 1, updatedAt: i + 1,
    });
  });
  return fps;
}

const NEW_FINDING = { path: "src/example.ts", line: 1, title: "New live finding", body: "Raised this round.", severity: "major" };

/** The round failed the ordinary way: not finished, nothing pinned, and backed off. */
function assertRoundFailed(key: string): void {
  const pr = getInspectorPr(key)!;
  assert.equal(pr.reviewPosture, "dry-run", "the head was not recorded as reviewed live");
  assert.equal(pr.round, 1);
  assert.ok(pr.lastError, "the failure is reported");
  // The test polls every 25ms, so the first rung of the ladder has passed by now. What
  // proves backoff applies is the failure counted and a retry time scheduled.
  assert.ok(pr.failCount >= 1, "the failure is counted toward backoff");
  assert.notEqual(pr.nextAttemptAt, null, "and a retry time is scheduled");
}

/** The round finished: the head is recorded as reviewed live, with no failure left on it. */
function assertRoundFinished(key: string): void {
  const pr = getInspectorPr(key)!;
  assert.equal(pr.reviewPosture, "live");
  assert.equal(pr.headSha, "head-1");
  assert.equal(pr.round, 2);
  assert.equal(pr.lastError, null);
  assert.equal(pr.failCount, 0);
}

const WHOLE_REVIEW_REFUSALS: { name: string; state: Partial<FakeGithubState>; rejectAll?: true }[] = [
  { name: "a rate limit", state: { forcedStatuses: [429] } },
  { name: "a server error", state: { forcedStatuses: [502] } },
  { name: "a 422 on a head that moved", state: { headAfterRefusal: "head-2" }, rejectAll: true },
];
for (const scenario of WHOLE_REVIEW_REFUSALS) {
  test(`whole-review refusal (${scenario.name}): no retry, no refusal counted, today's failure path`, async () => {
    process.env.FAKE_FIRST_FINDINGS = JSON.stringify([NEW_FINDING]);
    const key = adopt(710);
    const fps = seedDrafts(key, [{ title: "Draft one" }, { title: "Draft two" }]);
    writeGithubState({
      ...scenario.state,
      rejectFingerprints: scenario.rejectAll ? [...fps.values()] : [],
    });
    goLive();
    await runOneSweep();

    const state = readGithubState();
    assert.equal(state.attempts.length, 1, "no retry is sent");
    assert.equal(state.posts.length, 0);
    assert.equal(state.headReads, scenario.rejectAll ? 1 : 0, "the head is read only for a 422");
    for (const row of loadInspectorComments(key)) {
      assert.equal(row.status, "drafted", `${row.title} is a draft again`);
      assert.equal(row.postRefusals, 0, `${row.title} counts no refusal`);
      assert.equal(row.lastPostError, null);
    }
    assertRoundFailed(key);
  });
}

test("a mixed review refused with 422, retry accepted: the one carried draft records the refusal, the new finding is open", async () => {
  process.env.FAKE_FIRST_FINDINGS = JSON.stringify([NEW_FINDING]);
  const key = adopt(711);
  const fps = seedDrafts(key, [{ title: "Unanchorable draft" }]);
  writeGithubState({ rejectFingerprints: [fps.get("Unanchorable draft")!] });
  goLive();
  await runOneSweep();

  const state = readGithubState();
  const newFp = fingerprint("src/example.ts", NEW_FINDING.title);
  assert.deepEqual(state.attempts.map((a) => a.fingerprints.sort()), [
    [fps.get("Unanchorable draft")!, newFp].sort(),
    [newFp],
  ], "the retry carried the new finding alone");
  assert.equal(state.posts.length, 1);
  assert.equal(state.headReads, 1, "one head read, after the refusal");
  const rows = byTitle(key);
  assert.equal(rows.get(NEW_FINDING.title)!.status, "open");
  assert.ok(rows.get(NEW_FINDING.title)!.postedAt != null);
  const draft = rows.get("Unanchorable draft")!;
  assert.equal(draft.status, "drafted");
  assert.equal(draft.postRefusals, 1);
  assert.match(draft.lastPostError ?? "", /Line could not be resolved \(HTTP 422\)/);
  assert.doesNotMatch(draft.lastPostError ?? "", /^gh:/);
  assert.equal(reviewCount(), 1, "the retry reused the round's verdict");
  assertRoundFinished(key);
});

test("a mixed review refused with 422, retry also refused: no row counts a refusal", async () => {
  process.env.FAKE_FIRST_FINDINGS = JSON.stringify([NEW_FINDING]);
  const key = adopt(712);
  const fps = seedDrafts(key, [{ title: "Unanchorable draft" }]);
  writeGithubState({
    rejectFingerprints: [fps.get("Unanchorable draft")!, fingerprint("src/example.ts", NEW_FINDING.title)],
  });
  goLive();
  await runOneSweep();

  const state = readGithubState();
  assert.equal(state.attempts.length, 2, "the first review and one retry, nothing more");
  assert.equal(state.posts.length, 0);
  for (const row of loadInspectorComments(key)) {
    assert.equal(row.status, "drafted");
    assert.equal(row.postRefusals, 0, `${row.title} counts no refusal`);
  }
  assertRoundFailed(key);
});

test("a drafts-only review refused with 422: the draft records it, the round finishes, and the model runs once", async () => {
  const key = adopt(713);
  const fps = seedDrafts(key, [{ title: "Unanchorable draft" }]);
  writeGithubState({ rejectFingerprints: [fps.get("Unanchorable draft")!] });
  goLive();
  await runOneSweep();

  const draft = loadInspectorComments(key)[0]!;
  assert.equal(draft.status, "drafted", "a refused draft stays drafted");
  assert.equal(draft.postRefusals, 1);
  assert.match(draft.lastPostError ?? "", /Line could not be resolved/);
  assertRoundFinished(key);

  // Later sweeps reuse this reviewed head: no model run, no further POST, no refusal.
  await runOneSweep();
  await runOneSweep();
  assert.equal(reviewCount(), 1, "the fake model runner was called once, not once per backoff");
  assert.equal(readGithubState().attempts.length, 1);
  assert.equal(loadInspectorComments(key)[0]!.postRefusals, 1);
});

test("a drafts-only review refused with 422, three drafts: each is posted alone and only the bad one counts", async () => {
  const key = adopt(714);
  const fps = seedDrafts(key, [{ title: "Good draft one" }, { title: "Bad anchor draft" }, { title: "Good draft two" }]);
  writeGithubState({ rejectFingerprints: [fps.get("Bad anchor draft")!] });
  goLive();
  await runOneSweep();

  const state = readGithubState();
  assert.equal(state.attempts.length, 4, "the refused review, then one review per draft");
  assert.deepEqual(state.attempts.slice(1).map((a) => a.fingerprints.length), [1, 1, 1]);
  for (const isolated of state.attempts.slice(1)) {
    assert.match(isolated.body, /round 2/);
    assert.match(isolated.body, /posted on its own/);
  }
  assert.equal(state.posts.length, 2);
  const rows = byTitle(key);
  for (const title of ["Good draft one", "Good draft two"]) {
    assert.equal(rows.get(title)!.status, "open", `${title} was posted`);
    assert.ok(rows.get(title)!.postedAt != null, `${title} is stamped`);
    assert.equal(rows.get(title)!.postRefusals, 0, `${title} counts nothing for its bad sibling`);
  }
  const bad = rows.get("Bad anchor draft")!;
  assert.equal(bad.status, "drafted");
  assert.equal(bad.postRefusals, 1);
  assert.equal(reviewCount(), 1);
  assertRoundFinished(key);
});

test("a whole-review refusal partway through isolation stops it, with nothing counted", async () => {
  const key = adopt(715);
  const fps = seedDrafts(key, [{ title: "First draft" }, { title: "Bad anchor draft" }, { title: "Third draft" }]);
  // The first review is refused for the bad anchor; isolation posts the first draft, then
  // GitHub rate-limits the second isolated review.
  writeGithubState({ rejectFingerprints: [fps.get("Bad anchor draft")!], forcedStatuses: [200, 200, 429] });
  goLive();
  await runOneSweep();

  const state = readGithubState();
  assert.equal(state.attempts.length, 3, "isolation stopped at the rate limit");
  const rows = byTitle(key);
  assert.equal(rows.get("First draft")!.status, "open");
  for (const title of ["Bad anchor draft", "Third draft"]) {
    assert.equal(rows.get(title)!.status, "drafted");
    assert.equal(rows.get(title)!.postRefusals, 0, `${title} counts no refusal`);
  }
  assertRoundFailed(key);
});

test("a response lost during isolation never counts as a refusal", async () => {
  const key = adopt(717);
  const fps = seedDrafts(key, [{ title: "First draft" }, { title: "Bad anchor draft" }, { title: "Third draft" }]);
  // The second isolated review's gh dies before it answers: GitHub may or may not have it.
  writeGithubState({ rejectFingerprints: [fps.get("Bad anchor draft")!], forcedStatuses: [200, 200, -1] });
  goLive();
  await runOneSweep();

  const rows = byTitle(key);
  assert.equal(rows.get("First draft")!.status, "open");
  assert.equal(rows.get("Bad anchor draft")!.status, "posting", "left for the next round's reconciliation");
  assert.equal(rows.get("Third draft")!.status, "drafted", "not yet tried, so a draft again");
  for (const row of rows.values()) assert.equal(row.postRefusals, 0, `${row.title} counts no refusal`);
  assertRoundFailed(key);
});

test("a draft the prompt cut for length is not posted, because the model never saw it", async () => {
  const key = adopt(718);
  const fps = seedDrafts(key, [{ title: "Draft below the prompt cut", severity: "minor" }]);
  // Posted findings of higher severity fill every row the review prompt lists, so the draft,
  // otherwise eligible to be carried, is cut from the prompt.
  for (let i = 0; i < REVIEW_PROMPT_CAPS.openRows; i++) {
    upsertInspectorComment({
      id: `posted-${i}`, prKey: key, fingerprint: `posted-fp-${i}`, path: "src/example.ts", line: 1,
      title: `Posted finding ${i}`, body: "Already on GitHub.", severity: "major", round: 1,
      status: "open", replies: 0, answeredCommentId: null, postedAt: 1, createdAt: 100 + i, updatedAt: 100 + i,
    });
  }
  writeGithubState();
  goLive();
  await runOneSweep();

  assert.equal(reviewCount(), 1, "the switch to live still forced the re-review");
  const prompt = readFileSync(`${reviewCountPath}.1.prompt`, "utf8");
  assert.ok(!prompt.includes(fps.get("Draft below the prompt cut")!), "the draft was cut from the prompt");
  assert.equal(readGithubState().attempts.length, 0, "so it was not carried, and nothing was posted");
  const draft = byTitle(key).get("Draft below the prompt cut")!;
  assert.equal(draft.status, "drafted");
  assert.equal(draft.postRefusals, 0);
  assertRoundFinished(key);
});

test("a draft at the refusal cap, and a draft whose file left the diff, are not offered", async () => {
  const key = adopt(716);
  seedDrafts(key, [
    { title: "Refused three times", postRefusals: 3 },
    { title: "About a file the push removed", path: "src/gone.ts" },
  ]);
  writeGithubState();
  goLive();
  await runOneSweep();

  assert.equal(readGithubState().attempts.length, 0, "nothing was offered, so nothing was posted");
  const rows = byTitle(key);
  assert.equal(rows.get("Refused three times")!.status, "drafted");
  assert.equal(rows.get("Refused three times")!.postRefusals, 3);
  assert.equal(rows.get("About a file the push removed")!.status, "drafted");
  assertRoundFinished(key);
});
