import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Registry } from "../src/server/registry.ts";

// One diff subprocess per tick, and zero on the steady-state tick.
//
// A tick that both answers a follow-up and reviews used to call `fetchDiff` twice for
// the same PR at the same head - two `gh api` subprocesses, each buffering up to 16MB,
// to fetch bytes that cannot differ. This drives the REAL worker loop through fake `gh`
// and Claude binaries and counts diff fetches in the shared state file, because the
// thing under test is which subprocesses a tick spawns, not what any one helper returns.
//
// The count must stay honest in both directions: the busy tick at exactly ONE (shared,
// not doubled), and the steady-state tick at ZERO (lazy, not hoisted). And the shared
// result must not flatten the two consumers' failure semantics - the reply degrades to
// an empty diff while the review books `tooLarge` as a push-fixable park.
//
// Environment overrides must be installed before importing the worker: its runner and
// poll interval are resolved at module load.
const temp = mkdtempSync(join(tmpdir(), "mission-inspector-diff-once-"));
const binDir = join(temp, "bin");
const statePath = join(temp, "github-state.json");
const claudePath = join(binDir, "claude");
const ghPath = join(binDir, "gh");
const project = fileURLToPath(new URL("..", import.meta.url));

await import("node:fs").then(({ mkdirSync }) => mkdirSync(binDir, { recursive: true }));
process.env.MISSION_HOME = join(temp, "state");
process.env.MISSION_CLAUDE_BIN = claudePath;
process.env.MISSION_INSPECTOR_POLL_MS = "25";
process.env.FAKE_GITHUB_STATE = statePath;
process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;

writeFileSync(
  claudePath,
  `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  const verdict = { summary: "Nothing else to flag.", findings: [], resolved: [] };
  process.stdout.write(JSON.stringify({ result: JSON.stringify(verdict) }));
});
`,
);
chmodSync(claudePath, 0o755);

const { configureClaudeRunnerTransport } = await import("../src/server/llm/claude.ts");
const restoreTransport = configureClaudeRunnerTransport(() => "print");

// The fake `gh` records every snapshot read and every diff read in the state file, and
// writes it atomically (write + rename) because the test polls the file while ticks are
// still running.
writeFileSync(
  ghPath,
  `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const statePath = process.env.FAKE_GITHUB_STATE;
const load = () => JSON.parse(fs.readFileSync(statePath, "utf8"));
const save = (state) => {
  fs.writeFileSync(statePath + ".tmp", JSON.stringify(state, null, 2));
  fs.renameSync(statePath + ".tmp", statePath);
};

if (args[0] === "api" && args[1] === "user") {
  process.stdout.write("operator\\n");
} else if (args.includes("graphql")) {
  const state = load();
  state.snapshots += 1;
  save(state);
  const comments = [];
  if (state.threadBody) comments.push({
    databaseId: 101,
    body: state.threadBody,
    createdAt: "2026-07-30T12:00:00Z",
    author: { login: "operator" }
  });
  if (state.followUpBody) comments.push({
    databaseId: 202,
    body: state.followUpBody,
    createdAt: "2026-07-30T13:00:00Z",
    author: { login: "reviewer" }
  });
  const threads = comments.length ? [{
    id: "T_1",
    isResolved: false,
    path: "src/example.ts",
    comments: { nodes: comments }
  }] : [];
  process.stdout.write(JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          state: "OPEN",
          headRefOid: state.headSha,
          isDraft: false,
          title: "Inspector diff sharing",
          body: "Exercise the once-per-tick diff fetch.",
          createdAt: "2026-07-30T12:00:00Z",
          mergeable: "MERGEABLE",
          reviewDecision: null,
          commits: { nodes: [{ commit: { statusCheckRollup: { state: "PENDING" } } }] },
          reviewThreads: { nodes: threads },
          reviews: {
            nodes: [],
            pageInfo: { hasPreviousPage: false, startCursor: null }
          }
        }
      }
    }
  }));
} else if (args.some((arg) => /\\/comments\\/\\d+\\/replies$/.test(arg))) {
  const chunks = [];
  process.stdin.on("data", (chunk) => chunks.push(chunk));
  process.stdin.on("end", () => {
    const state = load();
    const target = args.find((arg) => /\\/comments\\/\\d+\\/replies$/.test(arg));
    state.actions.push("replied to comment " + target.match(/comments\\/(\\d+)\\/replies$/)[1]);
    save(state);
    process.stdout.write("{}");
  });
} else if (args.some((arg) => /repos\\/mission\\/control\\/pulls\\/\\d+$/.test(arg))) {
  const state = load();
  state.diffCalls += 1;
  save(state);
  if (state.diffTooLarge) {
    // Past run()'s 16MB maxBuffer, so fetchDiff reports this read as tooLarge.
    process.stdout.write("x".repeat(17 * 1024 * 1024));
  } else {
    process.stdout.write([
      "diff --git a/src/example.ts b/src/example.ts",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -1 +1 @@",
      "-export const value = 1;",
      "+export const value = 2;",
      ""
    ].join("\\n"));
  }
} else {
  process.stderr.write("unexpected fake gh invocation: " + JSON.stringify(args));
  process.exit(2);
}
`,
);
chmodSync(ghPath, 0o755);

const { openDb, getInspectorPr, loadInspectorComments, upsertInspectorComment } = await import(
  "../src/server/db.ts"
);
const { setInspectorConfig } = await import("../src/server/inspector/config.ts");
const { adoptPr, startInspector } = await import("../src/server/inspector/worker.ts");
const { formatMarker } = await import("../src/server/inspector/marker.ts");
const { resetAuthenticatedLogin } = await import("../src/server/inspector/github.ts");

interface FakeGithubState {
  headSha: string;
  threadBody: string | null;
  followUpBody: string | null;
  diffTooLarge: boolean;
  snapshots: number;
  diffCalls: number;
  actions: string[];
}

function writeGithubState(state: FakeGithubState): void {
  writeFileSync(statePath, JSON.stringify(state, null, 2));
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

const fingerprint = "prior-finding";
const priorMarker = formatMarker({ id: "prior-1", fingerprint, round: 1 });

/** The ledger row behind the fake thread, so `threadsAwaitingUs` finds a reply to owe. */
function seedThreadRow(key: string): void {
  upsertInspectorComment({
    id: "prior-1",
    prKey: key,
    fingerprint,
    path: "src/example.ts",
    line: 1,
    title: "Prior issue",
    body: "Already scrubbed prior finding detail.",
    severity: "major",
    round: 1,
    status: "open",
    replies: 0,
    answeredCommentId: null,
    createdAt: 1,
    updatedAt: 1,
  });
}

beforeEach(() => {
  openDb().exec("DELETE FROM inspector_prs; DELETE FROM inspector_comments; DELETE FROM app_config");
  resetAuthenticatedLogin();
});

after(() => {
  restoreTransport();
  rmSync(temp, { recursive: true, force: true });
});

test("a tick that replies AND reviews fetches the diff once; steady state fetches none", async () => {
  writeGithubState({
    headSha: "head-1",
    threadBody: priorMarker,
    followUpBody: "Why is this change safe?",
    diffTooLarge: false,
    snapshots: 0,
    diffCalls: 0,
    actions: [],
  });
  setInspectorConfig({
    enabled: true,
    mode: "live",
    repoAllowlist: [project],
    maxCommentsPerRound: 8,
  });
  const key = adopt(7);
  seedThreadRow(key);

  const stop = startInspector(registryStub());
  await waitFor(
    "the combined reply-and-review tick to finish the head",
    () => getInspectorPr(key)?.headSha === "head-1",
  );

  const active = readGithubState();
  assert.deepEqual(active.actions, ["replied to comment 202"], "the follow-up was answered");
  assert.equal(getInspectorPr(key)?.round, 1, "the review round completed in the same tick");
  assert.equal(
    active.diffCalls,
    1,
    "answering a follow-up and reviewing in one tick must share a single diff fetch",
  );
  const row = loadInspectorComments(key).find((c) => c.fingerprint === fingerprint);
  assert.equal(row?.answeredCommentId, 202, "the reply was stamped off the shared diff");

  // Steady state: nothing pushed and nobody waiting. Wait for the SNAPSHOT count to
  // prove two more full sweeps genuinely ran, rather than sleeping and hoping, then
  // check they fetched nothing - the laziness half of the memo.
  const sweeps = active.snapshots;
  await waitFor(
    "two more steady-state sweeps to run",
    () => readGithubState().snapshots >= sweeps + 2,
  );
  stop();
  assert.equal(readGithubState().diffCalls, 1, "a steady-state tick must fetch zero diffs");
});

test("a tooLarge shared fetch still parks push-fixable while the reply carries on", async () => {
  writeGithubState({
    headSha: "head-big",
    threadBody: priorMarker,
    followUpBody: "Can you double-check this?",
    diffTooLarge: true,
    snapshots: 0,
    diffCalls: 0,
    actions: [],
  });
  setInspectorConfig({
    enabled: true,
    mode: "live",
    repoAllowlist: [project],
    maxCommentsPerRound: 8,
  });
  const key = adopt(8);
  seedThreadRow(key);

  const stop = startInspector(registryStub());
  await waitFor(
    "the failing review to book its backoff",
    () => getInspectorPr(key)?.lastFailKind === "push-fixable",
  );
  stop();

  const state = readGithubState();
  assert.equal(state.diffCalls, 1, "the failing fetch is shared too, not retried by the review");
  assert.deepEqual(
    state.actions,
    ["replied to comment 202"],
    "the reply degraded to an empty diff instead of inheriting the review's failure",
  );
  const row = getInspectorPr(key);
  assert.match(row?.lastError ?? "", /too large/);
  assert.equal(row?.headSha, null, "a failed round never advances the head");
});
