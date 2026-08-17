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
import type { InspectorComment } from "../src/shared/types.ts";

// Drive the real Inspector loop through fake `gh` and Claude binaries. Environment
// overrides must be installed before importing the worker: its runner and poll interval
// are resolved at module load.
const temp = mkdtempSync(join(tmpdir(), "mission-inspector-clean-e2e-"));
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
  const verdict = { summary: "Nothing else to flag.", findings: [], resolved: JSON.parse(process.env.FAKE_RESOLVED || "[]") };
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
    state.actions.push("resolved prior Inspector thread T_1");
    save(state);
    process.stdout.write(JSON.stringify({ data: { resolveReviewThread: { thread: { isResolved: true } } } }));
  } else {
    const comments = state.threadBody ? [{
      databaseId: 101,
      body: state.threadBody,
      createdAt: "2026-07-23T12:00:00Z",
      author: { login: "operator" }
    }] : [];
    const threads = state.threadBody ? [{
      id: "T_1",
      isResolved: state.threadResolved,
      path: "src/example.ts",
      comments: { nodes: comments }
    }] : [];
    const reviews = state.reviews.map((review) => ({
      body: review.body,
      author: { login: review.author },
      commit: { oid: review.headSha }
    }));
    process.stdout.write(JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            state: "OPEN",
            headRefOid: state.headSha,
            isDraft: false,
            title: "Inspector clean review",
            body: "Exercise clean-review publication and retry recovery.",
            createdAt: "2026-07-23T12:00:00Z",
            mergeable: "MERGEABLE",
            reviewDecision: null,
            commits: { nodes: [{ commit: { statusCheckRollup: { state: "PENDING" } } }] },
            reviewThreads: { nodes: threads },
            reviews: {
              nodes: reviews,
              pageInfo: { hasPreviousPage: false, startCursor: null }
            }
          }
        }
      }
    }));
  }
} else if (args.includes("--method") && args.includes("POST") && args.some((arg) => /\\/reviews$/.test(arg))) {
  const chunks = [];
  process.stdin.on("data", (chunk) => chunks.push(chunk));
  process.stdin.on("end", () => {
    const state = load();
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    state.posts.push(payload);
    state.reviews.push({ body: payload.body, author: "operator", headSha: payload.commit_id });
    state.actions.push("GitHub accepted clean review for " + payload.commit_id);
    const loseResponse = state.loseNextPostResponse;
    state.loseNextPostResponse = false;
    save(state);
    if (loseResponse) process.kill(process.pid, "SIGKILL");
    process.stdout.write("{}");
  });
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
  threadResolved: boolean;
  loseNextPostResponse: boolean;
  reviews: { body: string; author: string; headSha: string }[];
  posts: {
    commit_id: string;
    body: string;
    event: string;
    comments: unknown[];
  }[];
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
    onPipelineRun: () => () => {},
    refreshInspections: () => {},
    snapshot: () => ({ sessions: [] }),
  } as unknown as Registry;
}

async function waitFor(description: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
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

beforeEach(() => {
  openDb().exec("DELETE FROM inspector_prs; DELETE FROM inspector_comments; DELETE FROM app_config");
  resetAuthenticatedLogin();
});

after(() => {
  restoreTransport();
  rmSync(temp, { recursive: true, force: true });
});

test("clean review is live-only, follows resolution, and is not duplicated after a lost response", async () => {
  const fingerprint = "prior-finding";
  process.env.FAKE_RESOLVED = JSON.stringify([fingerprint]);
  const priorMarker = formatMarker({ id: "prior-1", fingerprint, round: 1 });

  writeGithubState({
    headSha: "head-live",
    threadBody: priorMarker,
    threadResolved: false,
    loseNextPostResponse: true,
    reviews: [],
    posts: [],
    actions: [],
  });
  setInspectorConfig({
    enabled: true,
    mode: "live",
    repoAllowlist: [project],
    maxCommentsPerRound: 8,
  });
  const liveKey = adopt(7);
  const priorRow: InspectorComment = {
    id: "prior-1",
    prKey: liveKey,
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
  };
  upsertInspectorComment(priorRow);

  const stopLive = startInspector(registryStub());
  await waitFor(
    "the retry to recover the accepted review and finish the head",
    () => getInspectorPr(liveKey)?.headSha === "head-live",
  );
  stopLive();

  const liveState = readGithubState();
  assert.deepEqual(
    liveState.actions,
    [
      "resolved prior Inspector thread T_1",
      "GitHub accepted clean review for head-live",
    ],
    "the earlier finding must resolve before the clean review is accepted",
  );
  assert.equal(liveState.posts.length, 1, "a lost response must not duplicate the clean review");
  assert.equal(liveState.posts[0]!.event, "COMMENT");
  assert.equal(liveState.posts[0]!.commit_id, "head-live");
  assert.deepEqual(liveState.posts[0]!.comments, []);
  assert.match(liveState.posts[0]!.body, /No further issues found\./);
  assert.match(liveState.posts[0]!.body, /safe to merge/i);
  assert.equal(loadInspectorComments(liveKey)[0]?.status, "resolved");
  assert.equal(getInspectorPr(liveKey)?.lastError, null, "the recovered retry completes cleanly");
  const recoveredLiveHead = getInspectorPr(liveKey)?.headSha;

  openDb().exec("DELETE FROM inspector_prs; DELETE FROM inspector_comments");
  writeGithubState({
    headSha: "head-dry",
    threadBody: null,
    threadResolved: false,
    loseNextPostResponse: false,
    reviews: [],
    posts: [],
    actions: [],
  });
  setInspectorConfig({
    enabled: true,
    mode: "dry-run",
    repoAllowlist: [project],
  });
  const dryKey = adopt(8);
  const stopDry = startInspector(registryStub());
  await waitFor("the dry-run analysis to finish", () => getInspectorPr(dryKey)?.headSha === "head-dry");
  stopDry();

  const dryState = readGithubState();
  assert.equal(dryState.posts.length, 0, "dry run must never publish the clean review");

  const evidencePath = process.env.INSPECTOR_EVIDENCE_PATH;
  if (evidencePath) {
    writeFileSync(
      evidencePath,
      [
        "# Inspector clean-review end-to-end evidence",
        "",
        "The real Inspector sweep resolved its earlier owned thread, submitted the following",
        "top-level GitHub `COMMENT` review for `head-live`, lost the CLI response after",
        "GitHub accepted it, then recovered from live review history without posting again.",
        "",
        liveState.posts[0]!.body,
        "",
        "## Observed lifecycle",
        "",
        ...liveState.actions.map((action, index) => `${index + 1}. ${action}`),
        `3. Retry completed head \`${recoveredLiveHead}\` with ${liveState.posts.length} total review POST.`,
        `4. Dry-run head \`${getInspectorPr(dryKey)?.headSha}\` completed with ${dryState.posts.length} review POSTs.`,
        "",
        "## Submitted API shape",
        "",
        "```json",
        JSON.stringify(liveState.posts[0], null, 2),
        "```",
        "",
      ].join("\n"),
    );
  }
});
