import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Registry } from "../src/server/registry.ts";
import type { InspectorComment } from "../src/shared/types.ts";

// Drive the real Inspector loop through fake `gh` and Claude binaries. Environment
// overrides must be installed before importing the worker: its runner and poll interval
// are resolved at module load.
const temp = mkdtempSync(join(tmpdir(), "mission-inspector-resolution-"));
const binDir = join(temp, "bin");
const statePath = join(temp, "github-state.json");
const claudePath = join(binDir, "claude");
const ghPath = join(binDir, "gh");
const project = fileURLToPath(new URL("..", import.meta.url));

mkdirSync(binDir, { recursive: true });
process.env.MISSION_HOME = join(temp, "state");
process.env.MISSION_CLAUDE_BIN = claudePath;
process.env.MISSION_INSPECTOR_POLL_MS = "25";
process.env.FAKE_GITHUB_STATE = statePath;
process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;

// One fake for both jobs. The reply prompt ends with a line the review prompt never
// carries, which is what tells the two apart without the test reaching into either.
writeFileSync(
  claudePath,
  `#!/usr/bin/env node
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  const prompt = Buffer.concat(chunks).toString("utf8");
  if (prompt.includes('"resolved": true | false')) {
    const answer = {
      reply: process.env.FAKE_REPLY || "Dropping the finding.",
      resolved: process.env.FAKE_REPLY_RESOLVED === "1",
    };
    process.stdout.write(JSON.stringify({ result: JSON.stringify(answer) }));
    return;
  }
  const verdict = {
    summary: "Nothing else to flag.",
    findings: [],
    resolved: JSON.parse(process.env.FAKE_RESOLVED || "[]"),
  };
  process.stdout.write(JSON.stringify({ result: JSON.stringify(verdict) }));
});
`,
);
chmodSync(claudePath, 0o755);

const { configureClaudeRunnerTransport } = await import("../src/server/llm/claude.ts");
const restoreTransport = configureClaudeRunnerTransport(() => "print");

writeFileSync(
  ghPath,
  `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const statePath = process.env.FAKE_GITHUB_STATE;
const load = () => JSON.parse(fs.readFileSync(statePath, "utf8"));
const save = (state) => fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

if (args[0] === "api" && args[1] === "user") {
  process.stdout.write("operator\\n");
} else if (args.includes("graphql")) {
  const query = args.find((arg) => arg.startsWith("query=")) || "";
  const state = load();
  if (query.includes("resolveReviewThread")) {
    state.threadResolved = true;
    state.actions.push("resolved thread T_1");
    save(state);
    process.stdout.write(JSON.stringify({ data: { resolveReviewThread: { thread: { isResolved: true } } } }));
  } else {
    state.sweeps += 1;
    save(state);
    const threads = state.threadBody ? [{
      id: "T_1",
      isResolved: state.threadResolved,
      path: "src/example.ts",
      comments: { nodes: state.threadComments }
    }] : [];
    process.stdout.write(JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            state: "OPEN",
            headRefOid: state.headSha,
            headRefName: "feature",
            isDraft: false,
            title: "Inspector finding resolution",
            body: "Exercise the route out of an open finding.",
            createdAt: "2020-01-01T00:00:00Z",
            mergeable: "MERGEABLE",
            reviewDecision: null,
            commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
            reviewThreads: { nodes: threads, pageInfo: { hasNextPage: false, endCursor: null } },
            reviews: {
              nodes: state.reviews,
              pageInfo: { hasPreviousPage: false, startCursor: null }
            }
          }
        }
      }
    }));
  }
} else if (args.includes("--method") && args.includes("POST") && args.some((a) => /replies$/.test(a))) {
  const chunks = [];
  process.stdin.on("data", (chunk) => chunks.push(chunk));
  process.stdin.on("end", () => {
    const state = load();
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    state.replies.push(payload.body);
    state.actions.push("posted reply");
    save(state);
    process.stdout.write("{}");
  });
} else if (args.includes("--method") && args.includes("POST") && args.some((a) => /\\/reviews$/.test(a))) {
  const chunks = [];
  process.stdin.on("data", (chunk) => chunks.push(chunk));
  process.stdin.on("end", () => {
    const state = load();
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    state.posts.push(payload);
    state.reviews.push({ body: payload.body, author: { login: "operator" }, commit: { oid: payload.commit_id } });
    state.actions.push("accepted review for " + payload.commit_id);
    save(state);
    process.stdout.write("{}");
  });
} else if (args.some((a) => /\\/merge$/.test(a))) {
  const state = load();
  state.actions.push("MERGED");
  state.merged = true;
  save(state);
  process.stdout.write("{}");
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

const {
  openDb,
  getInspectorPr,
  loadInspectorComments,
  resolveInspectorFindings,
  updateInspectorPr,
  upsertInspectorComment,
} = await import("../src/server/db.ts");
const { setInspectorConfig } = await import("../src/server/inspector/config.ts");
const { setShippingConfig } = await import("../src/server/shipping/config.ts");
const { adoptPr, startInspector } = await import("../src/server/inspector/worker.ts");
const { formatMarker } = await import("../src/server/inspector/marker.ts");
const { resetAuthenticatedLogin } = await import("../src/server/inspector/github.ts");

interface FakeComment {
  databaseId: number;
  body: string;
  createdAt: string;
  author: { login: string };
}

interface FakeGithubState {
  headSha: string;
  threadBody: string | null;
  threadComments: FakeComment[];
  threadResolved: boolean;
  merged: boolean;
  sweeps: number;
  reviews: { body: string; author: { login: string }; commit: { oid: string } }[];
  posts: { commit_id: string; body: string }[];
  replies: string[];
  actions: string[];
}

function writeGithubState(state: Partial<FakeGithubState>): void {
  const full: FakeGithubState = {
    headSha: "head-fixed",
    threadBody: null,
    threadComments: [],
    threadResolved: false,
    merged: false,
    sweeps: 0,
    reviews: [],
    posts: [],
    replies: [],
    actions: [],
    ...state,
  };
  writeFileSync(statePath, JSON.stringify(full, null, 2));
}

function readGithubState(): FakeGithubState {
  return JSON.parse(readFileSync(statePath, "utf8")) as FakeGithubState;
}

function registryStub(): Registry {
  return {
    onPrOpened: () => () => {},
    refreshInspections: () => {},
    snapshot: () => ({ sessions: [] }),
  } as unknown as Registry;
}

async function waitFor(description: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${description}`);
}

/**
 * Stop the loop and wait for any tick already in flight to finish.
 *
 * `startInspector`'s stop clears the timer; it does not await a tick that is mid-`gh`.
 * Without this the next test's `beforeEach` wipes the tables under that tick, which sees
 * an empty ledger, counts zero open findings, and MERGES - a false green produced by the
 * harness rather than by the code under test.
 */
async function stopAndSettle(stop: () => void): Promise<void> {
  stop();
  let last = "";
  for (let i = 0; i < 50; i++) {
    const now = JSON.stringify(readGithubState());
    if (now === last) return;
    last = now;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
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

/** A PR whose head has ALREADY been reviewed live, carrying one open finding. */
function seedReviewedPr(key: string, fingerprint: string, over: Partial<InspectorComment> = {}): void {
  updateInspectorPr(
    key,
    { headSha: "head-fixed", reviewPosture: "live", round: 5, lastReviewedAt: Date.now() },
    Date.now(),
  );
  upsertInspectorComment({
    id: "finding-1",
    prKey: key,
    fingerprint,
    path: "src/example.ts",
    line: 1,
    title: "Prior issue",
    body: "The finding the author has since fixed.",
    severity: "major",
    round: 4,
    status: "open",
    replies: 0,
    answeredCommentId: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  });
}

function armConsent(): void {
  setInspectorConfig({
    enabled: true,
    mode: "live",
    repoAllowlist: [project],
    maxCommentsPerRound: 8,
  });
  setShippingConfig({
    autoMerge: true,
    soakMinutes: 0,
    repoAllowlist: [project],
  });
}

beforeEach(() => {
  openDb().exec("DELETE FROM inspector_prs; DELETE FROM inspector_comments; DELETE FROM app_config");
  resetAuthenticatedLogin();
  delete process.env.FAKE_RESOLVED;
  delete process.env.FAKE_REPLY;
});

after(() => {
  restoreTransport();
  rmSync(temp, { recursive: true, force: true });
});

test("an operator can resolve a finding no review round is left to close", async () => {
  const fingerprint = "dc436b4e2f";
  const marker = formatMarker({ id: "finding-1", fingerprint, round: 4 });
  writeGithubState({
    headSha: "head-fixed",
    threadBody: marker,
    // Resolved on GitHub by hand. That alone never helped: the daemon counts its own
    // ledger, not GitHub's thread state, which is why this needed an affordance at all.
    threadResolved: true,
    threadComments: [
      { databaseId: 101, body: marker, createdAt: "2026-07-23T12:00:00Z", author: { login: "operator" } },
    ],
  });
  armConsent();
  const key = adopt(494);
  seedReviewedPr(key, fingerprint);

  // FIRST, the dead end itself: the head has already been reviewed, so no later round can
  // ever list this fingerprint as resolved, and the block survives every sweep.
  const stop = startInspector(registryStub());
  await waitFor("the merge gate to record a block", () => getInspectorPr(key)?.mergeBlock !== null);
  const firstSweep = readGithubState().sweeps;
  await waitFor("three more sweeps", () => readGithubState().sweeps >= firstSweep + 3);

  assert.equal(getInspectorPr(key)!.mergeBlock, "findings", "stuck on the open finding");
  assert.equal(loadInspectorComments(key)[0]!.status, "open", "and no round closes the row");
  assert.equal(readGithubState().merged, false, "so it never lands on its own");
  assert.equal(getInspectorPr(key)!.round, 5, "no further round ran - the head was reviewed");

  // THEN the operator resolves it - the same writer `/api/inspector/resolve-findings`
  // calls - while the loop keeps running, and the next sweep lands the pull request.
  assert.equal(resolveInspectorFindings(key, Date.now()), 1, "one finding closed");
  await waitFor("the pull request to merge on the next sweep", () => readGithubState().merged);
  await stopAndSettle(stop);

  assert.equal(loadInspectorComments(key)[0]!.status, "resolved");
  assert.notEqual(getInspectorPr(key)!.mergedAt, null, "and it merged rather than needing a human");
});

test("resolving findings does not merge over a review thread GitHub still has open", async () => {
  const fingerprint = "dc436b4e2f";
  const marker = formatMarker({ id: "finding-1", fingerprint, round: 4 });
  writeGithubState({
    headSha: "head-fixed",
    threadBody: marker,
    // The one difference from the test above: nobody resolved it on GitHub.
    threadResolved: false,
    threadComments: [
      { databaseId: 101, body: marker, createdAt: "2026-07-23T12:00:00Z", author: { login: "operator" } },
    ],
  });
  armConsent();
  const key = adopt(497);
  seedReviewedPr(key, fingerprint);

  const stop = startInspector(registryStub());
  await waitFor("the merge gate to record a block", () => getInspectorPr(key)?.mergeBlock !== null);
  assert.equal(resolveInspectorFindings(key, Date.now()), 1);
  const firstSweep = readGithubState().sweeps;
  await waitFor("three more sweeps", () => readGithubState().sweeps >= firstSweep + 3);
  await stopAndSettle(stop);

  // The operator's word closes OUR ledger and nothing else. `threads` counts GitHub's own
  // unresolved review threads, so clearing findings moves the PR from one block to the
  // next rather than to merged - which is what keeps this affordance from being a bypass.
  assert.equal(loadInspectorComments(key)[0]!.status, "resolved");
  assert.equal(getInspectorPr(key)!.mergeBlock, "threads");
  assert.equal(readGithubState().merged, false, "an unresolved thread still stops the merge");
});

test("a finding the Inspector drops in conversation closes its thread, its row, and the block", async () => {
  const fingerprint = "dc436b4e2f";
  const marker = formatMarker({ id: "finding-1", fingerprint, round: 4 });
  process.env.FAKE_REPLY = "You are right - the fix covers it. Dropping the finding.";
  process.env.FAKE_REPLY_RESOLVED = "1";
  writeGithubState({
    headSha: "head-fixed",
    threadBody: marker,
    threadResolved: false,
    threadComments: [
      { databaseId: 101, body: marker, createdAt: "2026-07-23T12:00:00Z", author: { login: "operator" } },
      {
        databaseId: 202,
        body: "This is handled by the guard three lines up.",
        createdAt: "2026-07-23T13:00:00Z",
        author: { login: "author" },
      },
    ],
  });
  armConsent();
  const key = adopt(495);
  seedReviewedPr(key, fingerprint);

  const stop = startInspector(registryStub());
  // Every other gate in this fixture is green, so the finding was the only thing left. The
  // pull request landing on its own is the end-to-end proof the dead end is gone: this is
  // the PR that previously had to be merged by hand.
  await waitFor("the pull request to merge itself", () => readGithubState().merged);
  await stopAndSettle(stop);

  const state = readGithubState();
  const row = loadInspectorComments(key)[0]!;

  // The prose is still posted verbatim - the JSON contract carries the comment, it does
  // not summarize it.
  assert.match(state.replies[0]!, /You are right - the fix covers it\. Dropping the finding\./);
  assert.equal(row.replies, 1, "the reply is stamped so the question is never answered twice");
  assert.equal(row.answeredCommentId, 202);

  // The judgment reaches the ledger, which is the whole fix.
  assert.equal(row.status, "resolved", "the finding the Inspector dropped is closed");
  assert.equal(state.threadResolved, true, "and its GitHub thread is closed too");
  // Reply first, then the thread it belongs to, and only then the merge - never a thread
  // closed without an answer, and never a merge over a thread still open.
  assert.deepEqual(state.actions, ["posted reply", "resolved thread T_1", "MERGED"]);
  assert.notEqual(getInspectorPr(key)!.mergedAt, null, "the ledger records that WE merged it");
});

test("a reply that only answers a question leaves the finding blocking the merge", async () => {
  const fingerprint = "dc436b4e2f";
  const marker = formatMarker({ id: "finding-1", fingerprint, round: 4 });
  process.env.FAKE_REPLY = "It still stands: the guard runs only on the happy path.";
  // The model did not drop it, so `resolved` is false - the fail-closed default.
  delete process.env.FAKE_REPLY_RESOLVED;
  writeGithubState({
    headSha: "head-fixed",
    threadBody: marker,
    threadResolved: false,
    threadComments: [
      { databaseId: 101, body: marker, createdAt: "2026-07-23T12:00:00Z", author: { login: "operator" } },
      {
        databaseId: 202,
        body: "Is this really reachable?",
        createdAt: "2026-07-23T13:00:00Z",
        author: { login: "author" },
      },
    ],
  });
  armConsent();
  const key = adopt(496);
  seedReviewedPr(key, fingerprint);

  const stop = startInspector(registryStub());
  await waitFor("the Inspector to answer the follow-up", () => readGithubState().replies.length > 0);
  const firstSweep = readGithubState().sweeps;
  await waitFor("three more sweeps", () => readGithubState().sweeps >= firstSweep + 3);
  await stopAndSettle(stop);

  const state = readGithubState();
  const row = loadInspectorComments(key)[0]!;
  assert.equal(row.status, "open", "answering a question is not dropping the finding");
  assert.equal(state.threadResolved, false, "and the thread stays open on GitHub");
  assert.equal(getInspectorPr(key)!.mergeBlock, "findings", "so the gate still holds");
  assert.equal(state.merged, false, "an answered question must never land the pull request");
});
