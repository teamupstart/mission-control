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
import { join } from "node:path";
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
const pollMs = 25;

await import("node:fs").then(({ mkdirSync }) => mkdirSync(binDir, { recursive: true }));
process.env.MISSION_HOME = join(temp, "state");
process.env.MISSION_CLAUDE_BIN = claudePath;
process.env.MISSION_GH_BIN = ghPath;
process.env.MISSION_INSPECTOR_POLL_MS = String(pollMs);
process.env.FAKE_GITHUB_STATE = statePath;

// Both jobs answer with JSON, and they answer with DIFFERENT json - a review returns a
// verdict, a follow-up returns `{reply, resolved}`. The reply prompt's output contract is
// what tells them apart here, so this fake cannot answer a review in the reply's shape and
// quietly stop exercising either path.
writeFileSync(
  claudePath,
  `#!/usr/bin/env node
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  const prompt = Buffer.concat(chunks).toString("utf8");
  const answer = prompt.includes('"resolved": true | false')
    ? { reply: "Still stands - see the guard above.", resolved: false }
    : { summary: "Nothing else to flag.", findings: [], resolved: [] };
  process.stdout.write(JSON.stringify({ result: JSON.stringify(answer) }));
});
`,
);
chmodSync(claudePath, 0o755);

const { claudeRunner, configureClaudeRunnerTransport } = await import("../src/server/llm/claude.ts");
const restoreTransport = configureClaudeRunnerTransport(() => "print");

// The fake `gh` records every snapshot read and every diff read in the state file.
//
// A busy tick runs several `gh` subprocesses at once, so updates must serialize: atomic
// rename prevents a torn read but not a lost update. Each writer takes an exclusive lock
// around read-mutate-publish, and stages through a pid-scoped temp file so two stagers
// cannot collide.
writeFileSync(
  ghPath,
  `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const statePath = process.env.FAKE_GITHUB_STATE;
const load = () => JSON.parse(fs.readFileSync(statePath, "utf8"));
const lockPath = statePath + ".lock";
const napper = new Int32Array(new SharedArrayBuffer(4));
// Read, mutate and publish under one lock, so concurrent subprocesses cannot lose an
// update. Returns the mutated state for callers that keep reading it afterwards.
const withState = (mutate) => {
  for (;;) {
    let fd;
    try {
      fd = fs.openSync(lockPath, "wx");
    } catch {
      Atomics.wait(napper, 0, 0, 2);
      continue;
    }
    try {
      const state = load();
      mutate(state);
      const staged = statePath + "." + process.pid + ".tmp";
      fs.writeFileSync(staged, JSON.stringify(state, null, 2));
      fs.renameSync(staged, statePath);
      return state;
    } finally {
      fs.closeSync(fd);
      fs.unlinkSync(lockPath);
    }
  }
};

if (args[0] === "api" && args[1] === "user") {
  process.stdout.write("operator\\n");
} else if (args.some((arg) => arg.startsWith("query=mutation") && arg.includes("resolveReviewThread"))) {
  const thread = args.find((arg) => arg.startsWith("threadId=")).slice("threadId=".length);
  const state = withState((draft) => {
    draft.actions.push((draft.resolutionSucceeds ? "resolved " : "failed to resolve ") + thread);
  });
  process.stdout.write(JSON.stringify(state.resolutionSucceeds
    ? { data: { resolveReviewThread: { thread: { isResolved: true } } } }
    : { errors: [{ message: "fake thread resolution failure" }] }));
} else if (args.includes("graphql")) {
  const state = withState((draft) => { draft.snapshots += 1; });
  const number = args.find((arg) => arg.startsWith("number=")).slice("number=".length);
  const threads = state.threadsByPr[number].map(({ id, marker, question }) => ({
    id: "T_" + id,
    isResolved: false,
    path: "src/example.ts",
    comments: { nodes: [
      { databaseId: 101 + id, body: marker, createdAt: "2026-07-30T12:00:00Z", author: { login: "operator" } },
      { databaseId: 202 + id, body: question, createdAt: "2026-07-30T13:00:00Z", author: { login: "reviewer" } }
    ] }
  }));
  process.stdout.write(JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          state: Number(number) === state.closedPr ? "CLOSED" : "OPEN",
          headRefOid: state.headSha,
          baseRefName: "main",
          repository: { defaultBranchRef: { name: "main" } },
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
    const target = args.find((arg) => /\\/comments\\/\\d+\\/replies$/.test(arg));
    withState((draft) => {
      draft.actions.push("replied to comment " + target.match(/comments\\/(\\d+)\\/replies$/)[1]);
    });
    process.stdout.write("{}");
  });
} else if (args.some((arg) => /repos\\/mission\\/control\\/pulls\\/\\d+$/.test(arg))) {
  const state = withState((draft) => { draft.diffCalls += 1; });
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
const { setShippingConfig } = await import("../src/server/shipping/config.ts");

interface FakeThread {
  id: number;
  marker: string;
  question: string;
}

interface FakeGithubState {
  headSha: string;
  threadsByPr: Record<number, FakeThread[]>;
  closedPr?: number;
  resolutionSucceeds?: boolean;
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

function registryStub(refreshInspections = () => {}): Registry {
  return {
    onPrOpened: () => () => {},
    onPipelineRun: () => () => {},
    refreshInspections,
    snapshot: () => ({ sessions: [] }),
  } as unknown as Registry;
}

/**
 * Poll until `predicate` holds. The bound exists only to turn a real hang into a readable
 * failure: a healthy run returns on the first tick that satisfies it, so a generous bound costs
 * nothing, while ten seconds was routinely exceeded under the full suite's concurrency.
 */
async function waitFor(description: string, predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 60_000;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${description}`);
}

function adopt(number: number, adoptedAt = Date.now()): string {
  const key = `mission/control#${number}`;
  assert.equal(
    adoptPr(
      `https://github.com/mission/control/pull/${number}`,
      { sessionId: null, cwd: project, repoRoot: project },
      "hook",
      adoptedAt,
    ),
    true,
  );
  return key;
}

/** Pair the fake GitHub thread with its owned finding in the ledger. */
function seedThread(key: string, id: number, question: string): FakeThread {
  const fingerprint = `prior-finding-${id}`;
  const marker = formatMarker({ id: `prior-${id}`, fingerprint, round: 1 });
  upsertInspectorComment({
    id: `prior-${id}`,
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
  return { id, marker, question };
}

beforeEach(() => {
  openDb().exec("DELETE FROM inspector_prs; DELETE FROM inspector_comments; DELETE FROM app_config");
  resetAuthenticatedLogin();
  setShippingConfig({ codeRabbitAutoResolve: false });
  setInspectorConfig({
    enabled: true,
    mode: "live",
    runner: "claude",
    repoAllowlist: [project],
    maxCommentsPerRound: 8,
  });
});

after(() => {
  restoreTransport();
  rmSync(temp, { recursive: true, force: true });
});

test("a healthy tick answers multiple replies and reviews with one diff; steady state fetches none", async (t) => {
  const key = adopt(7);
  writeGithubState({
    headSha: "head-1",
    threadsByPr: { 7: [0, 1, 2].map((id) => seedThread(key, id, "Why is this change safe?")) },
    diffTooLarge: false,
    snapshots: 0,
    diffCalls: 0,
    actions: [],
  });

  // Stopped on every exit path. A failed wait used to skip the `stop()` below and leave this
  // worker polling into the next test, where its extra diff fetch read as a second failure.
  let firstSweep: FakeGithubState | undefined;
  const stop = startInspector(registryStub(() => { firstSweep ??= readGithubState(); }));
  t.after(stop);
  await waitFor(
    "the combined reply-and-review tick to finish the head",
    () => firstSweep !== undefined,
  );

  const active = firstSweep!;
  assert.deepEqual(active.actions, ["replied to comment 202", "replied to comment 203", "replied to comment 204"]);
  assert.equal(active.snapshots, 1, "all healthy replies and the review completed in one pass");
  assert.equal(getInspectorPr(key)?.headSha, "head-1");
  assert.equal(getInspectorPr(key)?.round, 1, "the review round completed in the same tick");
  assert.equal(
    active.diffCalls,
    1,
    "answering a follow-up and reviewing in one tick must share a single diff fetch",
  );
  assert.deepEqual(loadInspectorComments(key).map((c) => c.answeredCommentId).sort(), [202, 203, 204]);

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
  assert.deepEqual(readGithubState().actions, active.actions, "answered replies were not reposted");
});

test("a tooLarge shared fetch still parks push-fixable while the reply carries on", async (t) => {
  const key = adopt(8);
  writeGithubState({
    headSha: "head-big",
    threadsByPr: { 8: [seedThread(key, 0, "Can you double-check this?")] },
    diffTooLarge: true,
    snapshots: 0,
    diffCalls: 0,
    actions: [],
  });

  const stop = startInspector(registryStub());
  t.after(stop);
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

test("a failed reply yields to the next PR and retries pending replies from the failure deadline", async (t) => {
  const startedAt = Date.now();
  const modelDuration = 500;
  let now = startedAt;
  t.mock.method(Date, "now", () => now);

  const failing = adopt(9, startedAt - 2);
  const later = adopt(10, startedAt - 1);
  writeGithubState({
    headSha: "head-reply-batch",
    threadsByPr: {
      9: [0, 1, 2].map((id) => seedThread(failing, id, `Blocked question ${id}`)),
      10: [seedThread(later, 3, "Healthy question")],
    },
    diffTooLarge: false,
    snapshots: 0,
    diffCalls: 0,
    actions: [],
  });

  const calls: string[] = [];
  const firstOutcomeAt = startedAt + modelDuration;
  const firstDeadline = firstOutcomeAt + pollMs;
  const secondOutcomeAt = firstDeadline + modelDuration;
  const secondDeadline = secondOutcomeAt + 2 * pollMs;
  // Move the clock at the transport outcome. The duration exceeds the initial backoff
  // without relying on how fast a test worker or subprocess is scheduled.
  t.mock.method(claudeRunner, "run", async (prompt: string) => {
    const blocked = prompt.match(/Blocked question \d/);
    if (blocked) {
      calls.push(blocked[0]);
      if (blocked[0] === "Blocked question 1" || now >= secondDeadline) {
        return JSON.stringify({ reply: "The guard still applies.", resolved: false });
      }
      now += modelDuration;
      throw new Error("fake reply timeout");
    }
    if (prompt.includes("Healthy question")) {
      calls.push("healthy reply");
      return JSON.stringify({ reply: "The guard still applies.", resolved: false });
    }
    calls.push("review");
    return JSON.stringify({ summary: "No additional findings.", findings: [], resolved: [] });
  });

  type LedgerRow = NonNullable<ReturnType<typeof getInspectorPr>>;
  let pendingAfterFailures: ReturnType<typeof loadInspectorComments> = [];
  const sweeps: { failed: LedgerRow; later: LedgerRow; calls: string[] }[] = [];
  const stop = startInspector(registryStub(() => {
    const observed = getInspectorPr(later)!;
    // The closed-stack pass can also refresh the registry after this same sweep.
    if (observed.observedAt === sweeps.at(-1)?.later.observedAt) return;
    sweeps.push({ failed: getInspectorPr(failing)!, later: observed, calls: calls.splice(0) });
    if (sweeps.length === 1) now = firstDeadline - 1;
    if (sweeps.length === 2) now = firstDeadline;
    if (sweeps.length === 3) {
      pendingAfterFailures = loadInspectorComments(failing);
      // Return the remaining threads in the opposite order to their failures.
      const github = readGithubState();
      github.threadsByPr[9]!.reverse();
      writeGithubState(github);
      now = secondDeadline;
    }
    if (sweeps.length === 4) stop();
  }));
  t.after(stop);
  await waitFor("the sweep that retries both deferred replies", () => sweeps.length === 4);

  const [initial, backedOff, retry] = sweeps;
  assert.ok(initial && backedOff && retry);
  assert.deepEqual(sweeps.map(({ calls }) => calls), [
    ["Blocked question 0", "healthy reply", "review"],
    [],
    ["Blocked question 1", "Blocked question 2"],
    ["Blocked question 0", "Blocked question 2", "review"],
  ], "untried replies go first, then deferred replies retry in failure order");
  assert.deepEqual(
    sweeps.slice(0, 3).map(({ failed }) => [failed.failCount, failed.updatedAt, failed.nextAttemptAt]),
    [
      [1, firstOutcomeAt, firstDeadline],
      [1, firstDeadline - 1, firstDeadline],
      [2, secondOutcomeAt, secondDeadline],
    ],
    "failure timestamps and the doubling retry wait start at the outcome",
  );
  assert.equal(initial.failed.observedAt, startedAt);
  assert.equal(backedOff.failed.observedAt, firstDeadline - 1, "backoff still allows observations");
  assert.equal(initial.later.observedAt, firstOutcomeAt);
  assert.equal(initial.later.observedHeadSha, "head-reply-batch");
  assert.equal(initial.later.headSha, "head-reply-batch", "the later PR completed its review in the first sweep");
  assert.equal(retry.failed.lastFailKind, "persistent");
  assert.match(retry.failed.lastError ?? "", /fake reply timeout/);
  assert.equal(retry.failed.headSha, null, "reply failure never certifies a review");
  assert.equal(pendingAfterFailures.length, 3);
  for (const finding of pendingAfterFailures) {
    const answered = finding.id === "prior-1";
    assert.equal(finding.answeredCommentId, answered ? 203 : null);
    assert.equal(finding.replies, answered ? 1 : 0);
    assert.equal(finding.status, "open");
  }
  assert.deepEqual(readGithubState().actions, [
    "replied to comment 205", "replied to comment 203", "replied to comment 202", "replied to comment 204",
  ]);
  assert.deepEqual(loadInspectorComments(failing).map((row) => row.answeredCommentId).sort(), [202, 203, 204]);
});

test("waiting replies and failed resolutions both get a turn on eligible sweeps", async (t) => {
  const adoptedAt = Date.now();
  let now = adoptedAt;
  t.mock.method(Date, "now", () => now);
  const failing = adopt(11, adoptedAt);
  const later = adopt(12, adoptedAt + 1);
  writeGithubState({
    headSha: "head-resolution-failure",
    threadsByPr: {
      11: [
        seedThread(failing, 0, "First question"),
        seedThread(failing, 1, "Second question"),
        seedThread(failing, 2, "Third question"),
      ],
      12: [],
    },
    closedPr: 12,
    diffTooLarge: false,
    snapshots: 0,
    diffCalls: 0,
    actions: [],
  });

  const model = t.mock.method(claudeRunner, "run", async (prompt: string) => {
    if (prompt.includes("Third question")) throw new Error("fake reply timeout");
    return JSON.stringify({ reply: "I checked the guard.", resolved: prompt.includes("First question") });
  });
  const sweeps: { calls: number; actions: string[]; resolutionPending: boolean | undefined }[] = [];
  const stop = startInspector(registryStub(() => {
    if (getInspectorPr(failing)?.observedAt !== now) return;
    const github = readGithubState();
    const first = loadInspectorComments(failing).find((row) => row.id === "prior-0");
    sweeps.push({ calls: model.mock.callCount(), actions: [...github.actions], resolutionPending: first?.resolutionPending });
    if (sweeps.length === 2) {
      github.resolutionSucceeds = true;
      writeGithubState(github);
    }
    if (sweeps.length === 3) stop();
    now += sweeps.length * pollMs;
  }));
  t.after(stop);
  await waitFor("three eligible sweeps through resolution recovery", () => sweeps.length === 3);

  assert.deepEqual(sweeps[0], {
    calls: 1,
    actions: ["replied to comment 202", "failed to resolve T_0"],
    resolutionPending: true,
  });
  assert.deepEqual(sweeps[1], {
    calls: 3,
    actions: ["replied to comment 202", "failed to resolve T_0", "replied to comment 203"],
    resolutionPending: true,
  });
  assert.deepEqual(sweeps[2], {
    calls: 4,
    actions: ["replied to comment 202", "failed to resolve T_0", "replied to comment 203", "resolved T_0"],
    resolutionPending: undefined,
  });
  assert.deepEqual(model.mock.calls.map((call) => call.arguments[0].match(/\b(First|Second|Third) question/)?.[0]),
    ["First question", "Second question", "Third question", "Third question"]);

  const findings = loadInspectorComments(failing);
  const answered = findings.find((row) => row.id === "prior-0");
  const second = findings.find((row) => row.id === "prior-1");
  assert.equal(answered?.answeredCommentId, 202, "the posted reply stays recorded");
  assert.equal(answered?.status, "resolved", "resolution retries despite the other failing reply");
  assert.equal(second?.answeredCommentId, 203);
  assert.equal(second?.replies, 1);
  assert.equal(getInspectorPr(failing)?.failCount, 3);
  assert.match(getInspectorPr(failing)?.lastError ?? "", /fake reply timeout/);
  assert.equal(getInspectorPr(later)?.observedHeadSha, "head-resolution-failure");
  assert.equal(getInspectorPr(later)?.observedState, "CLOSED", "the later PR was observed in the same sweep");
});
