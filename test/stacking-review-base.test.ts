import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Registry } from "../src/server/registry.ts";
import type { StackGitHub } from "../src/server/stacking/github.ts";

// The real Inspector loop, through fake `gh` and Claude binaries, on a pull request whose base
// is another pull request's branch. The review it reuses is tied to the base COMMIT: the
// parent moving forward keeps it, the parent being rebased under the same child head and the
// same base name buys a new review, and a merge base GitHub cannot report stops the tick
// rather than trusting the old verdict. Overrides go in before the worker is imported: its
// runner and poll interval are read at module load.

const temp = mkdtempSync(join(tmpdir(), "mission-stacking-review-base-"));
const binDir = join(temp, "bin");
const statePath = join(temp, "github-state.json");
const reviewsPath = join(temp, "claude-reviews.log");
const project = fileURLToPath(new URL("..", import.meta.url));
mkdirSync(binDir, { recursive: true });
process.env.MISSION_HOME = join(temp, "state");
process.env.MISSION_CLAUDE_BIN = join(binDir, "claude");
process.env.MISSION_INSPECTOR_POLL_MS = "25";
process.env.FAKE_GITHUB_STATE = statePath;
process.env.FAKE_CLAUDE_REVIEWS = reviewsPath;
process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;

writeFileSync(
  join(binDir, "claude"),
  `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  require("node:fs").appendFileSync(process.env.FAKE_CLAUDE_REVIEWS, "review\\n");
  const verdict = { summary: "Nothing to flag.", findings: [], resolved: [] };
  process.stdout.write(JSON.stringify({ result: JSON.stringify(verdict) }));
});
`,
);
chmodSync(join(binDir, "claude"), 0o755);

writeFileSync(
  join(binDir, "gh"),
  `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.FAKE_GITHUB_STATE, "utf8"));
if (args[0] === "api" && args[1] === "user") {
  process.stdout.write("operator\\n");
} else if (args.includes("graphql")) {
  process.stdout.write(JSON.stringify({ data: { repository: { pullRequest: {
    state: "OPEN", headRefOid: state.headSha, headRefName: "feat/child",
    baseRefName: "feat/parent", baseRefOid: state.baseSha,
    repository: { defaultBranchRef: { name: "main" } },
    isDraft: false, title: "Stacked child", body: "", createdAt: "2026-07-23T12:00:00Z",
    mergeable: "MERGEABLE", reviewDecision: null,
    commits: { nodes: [{ commit: { statusCheckRollup: { state: "PENDING" } } }] },
    reviewThreads: { nodes: [] },
    reviews: { nodes: [], pageInfo: { hasPreviousPage: false, startCursor: null } }
  } } } }));
} else if (args[0] === "api" && args[1] === "repos/mission/control/pulls/9") {
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
chmodSync(join(binDir, "gh"), 0o755);

const { configureClaudeRunnerTransport } = await import("../src/server/llm/claude.ts");
const restoreTransport = configureClaudeRunnerTransport(() => "print");
const { openDb, getInspectorPr } = await import("../src/server/db.ts");
const { setInspectorConfig } = await import("../src/server/inspector/config.ts");
const { adoptPr, startInspector, useInspectorStackGitHub } = await import("../src/server/inspector/worker.ts");
const { resetAuthenticatedLogin } = await import("../src/server/inspector/github.ts");

const HEAD = "a".repeat(40);
const BASE_V1 = "1".repeat(40);
const BASE_V2 = "2".repeat(40);
const REBASED = "3".repeat(40);
const UNKNOWN = "6".repeat(40);
const CUT = "4".repeat(40);
const OLDER = "5".repeat(40);

/** `${base}...${head}` -> merge base, as GitHub's compare API would report it. */
const mergeBases = new Map<string, string>([
  [`${BASE_V1}...${HEAD}`, CUT],
  [`${BASE_V2}...${HEAD}`, CUT],
  [`${REBASED}...${HEAD}`, OLDER],
]);
const compares: string[] = [];
const unused = async (): Promise<never> => {
  throw new Error("not used by this test");
};
const seam: StackGitHub = {
  prRefs: unused,
  isAncestor: unused,
  branchSha: unused,
  repositories: unused,
  retarget: unused,
  mergeBase: async (_cwd, _owner, _repo, base, head) => {
    compares.push(`${base}...${head}`);
    const answer = mergeBases.get(`${base}...${head}`);
    return answer ? { ok: true, value: answer } : { ok: false, error: "compare failed" };
  },
};
const restoreSeam = useInspectorStackGitHub(seam);

after(() => {
  restoreSeam();
  restoreTransport();
  rmSync(temp, { recursive: true, force: true });
});

function setBase(baseSha: string): void {
  writeFileSync(statePath, JSON.stringify({ headSha: HEAD, baseSha }));
}

function reviews(): number {
  try {
    return readFileSync(reviewsPath, "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

const registry = {
  onPrOpened: () => () => {},
  onPipelineRun: () => () => {},
  refreshInspections: () => {},
  snapshot: () => ({ sessions: [] }),
} as unknown as Registry;

/** A wall-clock ceiling on a hang under suite contention, not a performance assertion. */
async function waitFor(description: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${description}`);
}

/** Let the 25 ms loop run several more sweeps. */
async function sweeps(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 400));
}

test("a parent rebased under an unchanged child head is reviewed again; a parent moving forward is not", async () => {
  openDb().exec("DELETE FROM inspector_prs; DELETE FROM inspector_comments; DELETE FROM app_config");
  resetAuthenticatedLogin();
  setInspectorConfig({ enabled: true, mode: "dry-run", repoAllowlist: [project], maxCommentsPerRound: 8 });
  setBase(BASE_V1);
  const key = "mission/control#9";
  assert.equal(adoptPr("https://github.com/mission/control/pull/9", { sessionId: null, cwd: project, repoRoot: project }, "hook", Date.now()), true);

  const stop = startInspector(registry);
  try {
    // 1. The first review records the base commit it was made against.
    await waitFor("the first review", () => getInspectorPr(key)?.headSha === HEAD);
    assert.equal(reviews(), 1);
    assert.equal(getInspectorPr(key)?.reviewedBaseRef, "feat/parent");
    assert.equal(getInspectorPr(key)?.reviewedBaseSha, BASE_V1);
    await sweeps();
    assert.equal(reviews(), 1, "nothing changed: the review is reused");

    // 2. The parent moves forward. Same merge base, same diff: no new review, and the new
    //    tip is recorded so GitHub is asked once, not on every sweep.
    setBase(BASE_V2);
    await waitFor("the forward move to be recorded", () => getInspectorPr(key)?.reviewedBaseSha === BASE_V2);
    const afterForward = compares.length;
    await sweeps();
    assert.equal(reviews(), 1, "a parent that only moved forward keeps the review");
    assert.equal(compares.length, afterForward, "an unchanged tip asks GitHub nothing");

    // 3. The parent is rebased. Head and base NAME are unchanged, but the merge base moved:
    //    the diff GitHub shows changed, so the old verdict cannot be reused.
    setBase(REBASED);
    await waitFor("a second review", () => reviews() === 2);
    await waitFor("the rebased base to be recorded", () => getInspectorPr(key)?.reviewedBaseSha === REBASED);
    assert.equal(getInspectorPr(key)?.headSha, HEAD);
    await sweeps();
    assert.equal(reviews(), 2, "the new review is then reused like any other");

    // 4. A tip whose merge base GitHub cannot report stops the tick: no new review, no
    //    reuse, and the reason is on the row.
    setBase(UNKNOWN);
    await waitFor("the unanswered merge base to be reported", () => /merge base/.test(getInspectorPr(key)?.lastError ?? ""));
    assert.equal(reviews(), 2, "an unanswered question is not answered with a review");
    assert.equal(getInspectorPr(key)?.reviewedBaseSha, REBASED, "nor does it advance the reviewed base");
  } finally {
    stop();
  }
});
