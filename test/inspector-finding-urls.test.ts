import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Registry } from "../src/server/registry.ts";
import type { InspectorComment } from "../src/shared/types.ts";

// Where each finding lives on GitHub, captured from the pull request snapshot the tick
// already reads.
//
// Two halves. The pure half reads a snapshot parsed by the real `fetchPr` from a GraphQL
// fixture, so the query fields, the parser, and the matching rule are tested together. The
// loop half drives the real Inspector through fake `gh` and Claude binaries, and records
// every `gh` invocation, because "captures the link at no extra GitHub cost" is a claim
// about which subprocesses a tick spawns.
//
// Environment overrides must be installed before importing the worker: its runner and poll
// interval are resolved at module load.
const temp = mkdtempSync(join(tmpdir(), "mission-inspector-urls-"));
const binDir = join(temp, "bin");
const statePath = join(temp, "github-state.json");
const callsPath = join(temp, "gh-calls.log");
const claudePath = join(binDir, "claude");
const ghPath = join(binDir, "gh");
const project = fileURLToPath(new URL("..", import.meta.url));

mkdirSync(binDir, { recursive: true });
process.env.MISSION_HOME = join(temp, "state");
process.env.MISSION_CLAUDE_BIN = claudePath;
process.env.MISSION_INSPECTOR_POLL_MS = "25";
process.env.FAKE_GITHUB_STATE = statePath;
process.env.FAKE_GH_CALLS = callsPath;
process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;

writeFileSync(
  claudePath,
  `#!/usr/bin/env node
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  const verdict = {
    summary: "Review summary.",
    findings: JSON.parse(process.env.FAKE_FINDINGS || "[]"),
    resolved: [],
  };
  process.stdout.write(JSON.stringify({ result: JSON.stringify(verdict) }));
});
`,
);
chmodSync(claudePath, 0o755);

const { configureClaudeRunnerTransport } = await import("../src/server/llm/claude.ts");
const restoreTransport = configureClaudeRunnerTransport(() => "print");

// The fake answers the snapshot query from a state file, and an accepted review adds to that
// state what GitHub would: one review carrying the body, and one thread per inline comment,
// each with the link GitHub mints. Every invocation is logged by kind, one line each.
writeFileSync(
  ghPath,
  `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const statePath = process.env.FAKE_GITHUB_STATE;
const load = () => JSON.parse(fs.readFileSync(statePath, "utf8"));
const save = (state) => {
  const tmp = statePath + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, statePath);
};
const log = (kind) => fs.appendFileSync(process.env.FAKE_GH_CALLS, kind + "\\n");
const base = "https://github.com/mission/control/pull/";

if (args[0] === "api" && args[1] === "user") {
  log("user");
  process.stdout.write("operator\\n");
} else if (args.includes("graphql")) {
  const query = args.find((arg) => arg.startsWith("query=")) || "";
  const state = load();
  // The continuation pages, past GitHub's first hundred threads or newest hundred reviews.
  const page = query.includes("reviewThreads(first:100,after:$after)")
    ? { kind: "thread page", body: { reviewThreads: {
        nodes: state.threadPage, pageInfo: { hasNextPage: false, endCursor: null } } } }
    : query.includes("reviews(last:100,before:$before)")
      ? { kind: "review page", body: { reviews: {
          nodes: state.reviewPage, pageInfo: { hasPreviousPage: false, startCursor: null } } } }
      : null;
  if (page) {
    log("graphql " + page.kind);
    state.lastQuery = query;
    save(state);
    process.stdout.write(JSON.stringify({ data: { repository: { pullRequest: page.body } } }));
    process.exit(0);
  }
  if (!query.includes("reviewThreads(first:100){")) {
    log("graphql other");
    process.stderr.write("unexpected graphql query");
    process.exit(2);
  }
  log("graphql snapshot");
  state.lastQuery = query;
  save(state);
  process.stdout.write(JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          state: "OPEN",
          headRefOid: state.headSha,
          headRefName: "feature",
          isDraft: false,
          title: "Inspector finding links",
          body: "Capture where each finding lives.",
          createdAt: "2026-10-01T00:00:00Z",
          mergeable: "MERGEABLE",
          reviewDecision: null,
          commits: { nodes: [{ commit: { oid: state.headSha, statusCheckRollup: { state: "PENDING" } } }] },
          reviewThreads: { nodes: state.threads, pageInfo: { hasNextPage: !!state.threadsMore, endCursor: state.threadsMore ? "threads-2" : null } },
          reviews: { nodes: state.reviews, pageInfo: { hasPreviousPage: !!state.reviewsMore, startCursor: state.reviewsMore ? "reviews-2" : null } }
        }
      }
    }
  }));
} else if (args.includes("POST") && args.some((a) => /\\/reviews$/.test(a))) {
  log("post review");
  const chunks = [];
  process.stdin.on("data", (chunk) => chunks.push(chunk));
  process.stdin.on("end", () => {
    const state = load();
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const number = args.find((a) => /\\/reviews$/.test(a)).match(/pulls\\/(\\d+)\\/reviews$/)[1];
    state.nextId += 1;
    state.reviews.push({
      url: base + number + "#pullrequestreview-" + state.nextId,
      body: payload.body,
      author: { login: "operator" },
      commit: { oid: payload.commit_id }
    });
    for (const c of payload.comments) {
      state.nextId += 1;
      state.threads.push({
        id: "T_" + state.nextId,
        isResolved: false,
        path: c.path,
        comments: { nodes: [{
          databaseId: state.nextId,
          url: base + number + "#discussion_r" + state.nextId,
          body: c.body,
          createdAt: "2026-10-01T00:00:00Z",
          author: { login: "operator" }
        }] }
      });
    }
    state.posts += 1;
    save(state);
    process.stdout.write("{}");
  });
} else if (args.some((arg) => /repos\\/mission\\/control\\/pulls\\/\\d+$/.test(arg))) {
  log("diff");
  // Two files: one with a line to anchor to, and one whose diff is pure deletion, so a
  // finding on it has nowhere to anchor and is demoted into the review body.
  process.stdout.write([
    "diff --git a/src/example.ts b/src/example.ts",
    "--- a/src/example.ts",
    "+++ b/src/example.ts",
    "@@ -1 +1 @@",
    "-export const value = 1;",
    "+export const value = 2;",
    "diff --git a/src/shrunk.ts b/src/shrunk.ts",
    "--- a/src/shrunk.ts",
    "+++ b/src/shrunk.ts",
    "@@ -1,2 +1,0 @@",
    "-export const a = 1;",
    "-export const b = 2;",
    ""
  ].join("\\n"));
} else {
  log("unexpected " + JSON.stringify(args));
  process.stderr.write("unexpected fake gh invocation: " + JSON.stringify(args));
  process.exit(2);
}
`,
);
chmodSync(ghPath, 0o755);

const { openDb, loadInspectorComments, updateInspectorPr, upsertInspectorComment } = await import(
  "../src/server/db.ts"
);
const { setInspectorConfig } = await import("../src/server/inspector/config.ts");
const { setShippingConfig } = await import("../src/server/shipping/config.ts");
const { adoptPr, startInspector } = await import("../src/server/inspector/worker.ts");
const { BODY_ONLY_FINDINGS_MARKER, fingerprint, formatMarker, reviewHeader } = await import(
  "../src/server/inspector/marker.ts"
);
const { fetchPr, fetchReviewPage, fetchThreadPage, findingUrls, resetAuthenticatedLogin } = await import("../src/server/inspector/github.ts");
const { findingPublication } = await import("../src/shared/inspector-findings.ts");

const US = "operator";
const PR = "https://github.com/mission/control/pull/";

interface FakeThread {
  id: string;
  isResolved: boolean;
  path: string;
  comments: { nodes: { databaseId: number; url: string; body: string; createdAt: string; author: { login: string } }[] };
}

interface FakeReview {
  url: string;
  body: string;
  author: { login: string };
  commit: { oid: string };
}

interface FakeGithubState {
  headSha: string;
  threads: FakeThread[];
  reviews: FakeReview[];
  posts: number;
  nextId: number;
  /** The snapshot reports a further page of threads, served from `threadPage`. */
  threadsMore?: boolean;
  /** The snapshot reports an earlier page of reviews, served from `reviewPage`. */
  reviewsMore?: boolean;
  threadPage: FakeThread[];
  reviewPage: FakeReview[];
  lastQuery?: string;
}

function writeGithubState(state: Partial<FakeGithubState>): void {
  const full: FakeGithubState = { headSha: "head-1", threads: [], reviews: [], threadPage: [], reviewPage: [], posts: 0, nextId: 100, ...state };
  const tmp = `${statePath}.seed.tmp`;
  writeFileSync(tmp, JSON.stringify(full, null, 2));
  renameSync(tmp, statePath);
}

function readGithubState(): FakeGithubState {
  return JSON.parse(readFileSync(statePath, "utf8")) as FakeGithubState;
}

function thread(id: string, url: string, body: string, author = US, isResolved = false): FakeThread {
  return {
    id,
    isResolved,
    path: "src/example.ts",
    comments: { nodes: [{ databaseId: 1, url, body, createdAt: "2026-10-01T00:00:00Z", author: { login: author } }] },
  };
}

function findingsReview(url: string, round: number, author = US): FakeReview {
  return {
    url,
    body: [reviewHeader(round), "", "Summary", "", "---", "", "- **src/shrunk.ts** · `minor` - Gone", "",
      "  detail", "", BODY_ONLY_FINDINGS_MARKER].join("\n"),
    author: { login: author },
    commit: { oid: "head-1" },
  };
}

function ghCalls(): string[] {
  try {
    return readFileSync(callsPath, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
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

async function runOneSweep(): Promise<void> {
  let stop = () => {};
  const finished = new Promise<void>((resolve) => {
    stopAtSweepEnd = () => { stop(); stopAtSweepEnd = null; resolve(); };
  });
  stop = startInspector(registryStub());
  await finished;
}

function adopt(number: number): string {
  assert.equal(
    adoptPr(`${PR}${number}`, { sessionId: null, cwd: project, repoRoot: project }, "hook", Date.now()),
    true,
  );
  return `mission/control#${number}`;
}

function seedRow(key: string, over: Partial<InspectorComment> & Pick<InspectorComment, "fingerprint">): void {
  upsertInspectorComment({
    id: `id-${over.fingerprint}`,
    prKey: key,
    path: "src/example.ts",
    line: 1,
    title: `Issue ${over.fingerprint}`,
    body: "detail",
    severity: "major",
    round: 2,
    status: "open",
    replies: 0,
    answeredCommentId: null,
    postedAt: 1_000,
    createdAt: 1,
    updatedAt: 7,
    ...over,
  });
}

function byFingerprint(key: string): Map<string, InspectorComment> {
  return new Map(loadInspectorComments(key).map((r) => [r.fingerprint, r]));
}

beforeEach(() => {
  openDb().exec("DELETE FROM inspector_prs; DELETE FROM inspector_comments; DELETE FROM app_config");
  resetAuthenticatedLogin();
  delete process.env.FAKE_FINDINGS;
  writeFileSync(callsPath, "");
  setShippingConfig({ autoMerge: false });
});

after(() => {
  restoreTransport();
  rmSync(temp, { recursive: true, force: true });
});

// ---- The snapshot: the link travels in the read the tick already makes ----

test("the snapshot query asks for each comment's and review's link, and the parser keeps it", async () => {
  writeGithubState({
    threads: [thread("T_1", `${PR}7#discussion_r11`, formatMarker({ id: "a", fingerprint: "fp-inline", round: 2 }))],
    reviews: [findingsReview(`${PR}7#pullrequestreview-21`, 2)],
  });
  const snap = await fetchPr(null, "mission", "control", 7);
  assert.ok(snap.ok && snap.value);
  assert.equal(snap.value.threads[0]!.comments[0]!.url, `${PR}7#discussion_r11`);
  assert.equal(snap.value.reviews[0]!.url, `${PR}7#pullrequestreview-21`);
  const query = readGithubState().lastQuery ?? "";
  assert.match(query, /comments\(first:100\)\{\s*nodes\{ id url databaseId body/);
  assert.match(query, /reviews\(last:100\)\{\s*nodes\{ url body/);
  assert.deepEqual(ghCalls(), ["graphql snapshot"], "one read, as before");
});

// The continuation pages are separate queries with separate parsers, so each is pinned on
// its own: the query must ask for the link, and the parser must keep it.
test("a later page of review threads asks for each comment's link, and the parser keeps it", async () => {
  const url = `${PR}7#discussion_r301`;
  writeGithubState({
    threadPage: [thread("T_101", url, formatMarker({ id: "a", fingerprint: "fp-page-2", round: 2 }))],
  });
  const page = await fetchThreadPage(null, "mission", "control", 7, "cursor-1");
  assert.ok(page.ok && page.value);
  assert.equal(page.value.threads[0]!.comments[0]!.url, url);
  assert.match(readGithubState().lastQuery ?? "", /comments\(first:1\)\{ nodes\{ id url databaseId body/);
  assert.deepEqual(ghCalls(), ["graphql thread page"]);
});

test("an earlier page of reviews asks for each review's link, and the parser keeps it", async () => {
  const url = `${PR}7#pullrequestreview-401`;
  writeGithubState({ reviewPage: [findingsReview(url, 2)] });
  const page = await fetchReviewPage(null, "mission", "control", 7, "cursor-1");
  assert.ok(page.ok && page.value);
  assert.equal(page.value.reviews[0]!.url, url);
  // The page's review is the same shape the snapshot's is, so the matching rule reads it.
  assert.equal(
    findingUrls({ threads: [], reviews: page.value.reviews }, US,
      [{ fingerprint: "fp-demoted", line: null, round: 2, githubUrl: null }]).get("fp-demoted"),
    url,
  );
  assert.match(readGithubState().lastQuery ?? "", /reviews\(last:100,before:\$before\)\{\s*nodes\{ url body/);
  assert.deepEqual(ghCalls(), ["graphql review page"]);
});

test("an inline finding takes the link of our marker thread, and a demoted one our review's", async () => {
  const inline = "fp-inline";
  const demoted = "fp-demoted";
  writeGithubState({
    threads: [
      thread("T_1", `${PR}7#discussion_r11`, formatMarker({ id: "a", fingerprint: inline, round: 2 })),
      // A forged marker on someone else's comment is never ours.
      thread("T_2", `${PR}7#discussion_r12`, formatMarker({ id: "b", fingerprint: "fp-forged", round: 2 }), "stranger"),
    ],
    reviews: [
      // Round 12's review must not answer for a round 1 row, nor round 1's for round 12.
      findingsReview(`${PR}7#pullrequestreview-20`, 12),
      findingsReview(`${PR}7#pullrequestreview-21`, 2),
      findingsReview(`${PR}7#pullrequestreview-22`, 3, "stranger"),
      // Our summary-only review for round 4 carries no body-only findings.
      { url: `${PR}7#pullrequestreview-23`, body: `${reviewHeader(4)}\n\nAll good.`, author: { login: US }, commit: { oid: "h" } },
    ],
  });
  const snap = await fetchPr(null, "mission", "control", 7);
  assert.ok(snap.ok && snap.value);
  const row = (fp: string, line: number | null, round: number, githubUrl: string | null = null) =>
    ({ fingerprint: fp, line, round, githubUrl });

  const got = findingUrls(snap.value, US, [
    row(inline, 4, 2),
    row(demoted, null, 2),
    row("fp-demoted-r1", null, 1),
    row("fp-forged", 3, 2),
    row("fp-stranger-review", null, 3),
    row("fp-summary-only", null, 4),
    row("fp-unseen", 9, 2, `${PR}7#discussion_r1`),
  ]);
  assert.deepEqual(Object.fromEntries(got), {
    [inline]: `${PR}7#discussion_r11`,
    [demoted]: `${PR}7#pullrequestreview-21`,
  }, "a finding that matches nothing is left out, so its stored link is kept");

  // Nothing to write when the stored link already matches, something when it differs.
  assert.equal(findingUrls(snap.value, US, [row(inline, 4, 2, `${PR}7#discussion_r11`)]).size, 0);
  assert.equal(findingUrls(snap.value, US, [row(inline, 4, 2, `${PR}7#discussion_r1`)]).get(inline),
    `${PR}7#discussion_r11`);
  // Without a login nothing is ours.
  assert.equal(findingUrls(snap.value, null, [row(inline, 4, 2), row(demoted, null, 2)]).size, 0);
});

test("a finding posted more than once links to its newest thread, whatever order GitHub lists them in", async () => {
  const fp = "fp-again";
  const older = thread("T_old", `${PR}7#discussion_r1`, formatMarker({ id: "a", fingerprint: fp, round: 1 }), US, true);
  const newer = thread("T_new", `${PR}7#discussion_r9`, formatMarker({ id: "a", fingerprint: fp, round: 3 }));
  for (const threads of [[older, newer], [newer, older]]) {
    writeGithubState({ threads });
    const snap = await fetchPr(null, "mission", "control", 7);
    assert.ok(snap.ok && snap.value);
    assert.equal(findingUrls(snap.value, US, [{ fingerprint: fp, line: 2, round: 3, githubUrl: null }]).get(fp),
      `${PR}7#discussion_r9`);
  }
});

// ---- The loop: written on the tick that sees it, with no extra call ----

test("a live review's links land on the next tick, for an inline and a demoted finding", async () => {
  process.env.FAKE_FINDINGS = JSON.stringify([
    { path: "src/example.ts", line: 1, title: "Inline finding", body: "Anchored", severity: "major" },
    { path: "src/shrunk.ts", line: 1, title: "Demoted finding", body: "Nowhere to anchor", severity: "minor" },
  ]);
  writeGithubState({});
  setInspectorConfig({ enabled: true, mode: "live", repoAllowlist: [project], maxCommentsPerRound: 8 });
  const key = adopt(701);

  await runOneSweep();
  assert.equal(readGithubState().posts, 1, "one review carried both findings");
  const inlineFp = fingerprint("src/example.ts", "Inline finding");
  const demotedFp = fingerprint("src/shrunk.ts", "Demoted finding");
  let rows = byFingerprint(key);
  assert.equal(rows.get(demotedFp)?.line, null, "the second finding really was demoted");
  for (const row of rows.values()) {
    assert.equal(row.status, "open");
    assert.equal(row.githubUrl, null, "the review was posted after this tick's snapshot was read");
    assert.equal(findingPublication(row).state, "posted", "posted, without a link yet");
  }

  const posted = readGithubState();
  writeFileSync(callsPath, "");
  await runOneSweep();
  rows = byFingerprint(key);
  assert.equal(rows.get(inlineFp)?.githubUrl, posted.threads[0]!.comments.nodes[0]!.url);
  assert.equal(rows.get(demotedFp)?.githubUrl, posted.reviews[0]!.url);
  assert.equal(findingPublication(rows.get(inlineFp)!).url, posted.threads[0]!.comments.nodes[0]!.url);
  assert.deepEqual(ghCalls(), ["graphql snapshot"], "the steady-state tick still reads the snapshot once");
});

test("capturing links adds no GitHub call to a tick, and leaves each finding's updatedAt alone", async () => {
  const inline = "aaaaaaaaaaaa";
  const demoted = "bbbbbbbbbbbb";
  const run = async (stored: boolean): Promise<string[]> => {
    openDb().exec("DELETE FROM inspector_prs; DELETE FROM inspector_comments");
    resetAuthenticatedLogin();
    writeGithubState({
      threads: [thread("T_1", `${PR}702#discussion_r11`, formatMarker({ id: "a", fingerprint: inline, round: 2 }))],
      reviews: [findingsReview(`${PR}702#pullrequestreview-21`, 2)],
    });
    const key = adopt(702);
    // Already reviewed live at this head, so the tick is the steady-state one.
    updateInspectorPr(key, { headSha: "head-1", reviewPosture: "live", round: 2, lastReviewedAt: 1 }, Date.now());
    seedRow(key, { fingerprint: inline, githubUrl: stored ? `${PR}702#discussion_r11` : null });
    seedRow(key, { fingerprint: demoted, line: null, githubUrl: stored ? `${PR}702#pullrequestreview-21` : null });
    writeFileSync(callsPath, "");
    await runOneSweep();
    const rows = byFingerprint(key);
    assert.equal(rows.get(inline)?.githubUrl, `${PR}702#discussion_r11`);
    assert.equal(rows.get(demoted)?.githubUrl, `${PR}702#pullrequestreview-21`);
    for (const row of rows.values()) assert.equal(row.updatedAt, 7, "learning a link is not a change to the finding");
    return ghCalls();
  };
  setInspectorConfig({ enabled: true, mode: "live", repoAllowlist: [project], maxCommentsPerRound: 8 });
  const capturing = await run(false);
  const alreadyStored = await run(true);
  assert.deepEqual(capturing, ["graphql snapshot", "user"]);
  assert.deepEqual(capturing, alreadyStored, "the tick that writes links makes the calls the tick with nothing to write makes");
});

test("a tick replaces a stored link that no longer matches what GitHub shows", async () => {
  // Missing and already-correct links are covered above. This is the third case: a link is
  // stored, but it is not the one the snapshot now names, so a worker that skipped every
  // row already holding a link would leave it stale.
  const inline = "cccccccccccc";
  const demoted = "dddddddddddd";
  writeGithubState({
    threads: [thread("T_1", `${PR}704#discussion_r11`, formatMarker({ id: "a", fingerprint: inline, round: 2 }))],
    reviews: [findingsReview(`${PR}704#pullrequestreview-21`, 2)],
  });
  setInspectorConfig({ enabled: true, mode: "live", repoAllowlist: [project], maxCommentsPerRound: 8 });
  const key = adopt(704);
  updateInspectorPr(key, { headSha: "head-1", reviewPosture: "live", round: 2, lastReviewedAt: 1 }, Date.now());
  seedRow(key, { fingerprint: inline, githubUrl: `${PR}704#discussion_r1` });
  seedRow(key, { fingerprint: demoted, line: null, githubUrl: `${PR}704#pullrequestreview-1` });

  await runOneSweep();
  const rows = byFingerprint(key);
  assert.equal(rows.get(inline)?.githubUrl, `${PR}704#discussion_r11`);
  assert.equal(rows.get(demoted)?.githubUrl, `${PR}704#pullrequestreview-21`);
  assert.deepEqual(ghCalls(), ["graphql snapshot", "user"], "still no extra call");
});

// ---- Partial reads: a link a later page could still change is never rewritten ----

test("a partial read fills a missing link but replaces a stored one only when no unread page could change it", async () => {
  const fp = "fp-partial";
  const older = thread("T_1", `${PR}7#discussion_r1`, formatMarker({ id: "a", fingerprint: fp, round: 1 }), US, true);
  const current = thread("T_2", `${PR}7#discussion_r9`, formatMarker({ id: "a", fingerprint: fp, round: 3 }));
  const stored = `${PR}7#discussion_r5`;
  const inline = (round: number, githubUrl: string | null) => ({ fingerprint: fp, line: 2, round, githubUrl });
  const linkFor = (sources: Parameters<typeof findingUrls>[0], row: ReturnType<typeof inline>) =>
    findingUrls(sources, US, [row]).get(fp) ?? null;
  const partial = (threads: FakeThread[], reviews: FakeReview[] = []) => ({
    threads: threads.map((t) => ({ ...t, comments: t.comments.nodes.map((c) => ({ ...c, author: c.author.login })) })),
    reviews: reviews.map((r) => ({ url: r.url, body: r.body, author: r.author.login, headSha: r.commit.oid })),
    threadsComplete: false,
    reviewsComplete: false,
  });

  // Threads: a newer post may sit on an unread page, unless the one seen is the row's own round.
  assert.equal(linkFor(partial([older]), inline(3, null)), older.comments.nodes[0]!.url, "a missing link is filled");
  assert.equal(linkFor(partial([older]), inline(3, stored)), null, "a stored link is kept while a newer post may be unread");
  assert.equal(linkFor(partial([current]), inline(3, stored)), current.comments.nodes[0]!.url,
    "a thread of the row's own round is the newest there can be");
  assert.equal(linkFor({ ...partial([older]), threadsComplete: true }, inline(3, stored)), older.comments.nodes[0]!.url,
    "with every page read, the newest thread seen is the answer");

  // Demoted: the round's review settles it wherever it was found; the thread fallback waits for every review.
  const demoted = (githubUrl: string | null) => ({ fingerprint: fp, line: null, round: 2, githubUrl });
  const review = findingsReview(`${PR}7#pullrequestreview-21`, 2);
  assert.equal(findingUrls(partial([current], [review]), US, [demoted(stored)]).get(fp), review.url);
  assert.equal(findingUrls(partial([current]), US, [demoted(null)]).size, 0,
    "its review may be on an unread page, so the thread is not taken");
  assert.equal(findingUrls({ ...partial([current]), reviewsComplete: true }, US, [demoted(null)]).get(fp),
    current.comments.nodes[0]!.url);
});

/** A pull request whose head was reviewed clean in live, with every finding resolved. */
function seedResolvedPr(number: number): string {
  setInspectorConfig({ enabled: true, mode: "live", repoAllowlist: [project], maxCommentsPerRound: 8 });
  const key = adopt(number);
  updateInspectorPr(
    key,
    { headSha: "head-1", reviewPosture: "live", round: 3, reviewComplete: true, lastReviewedAt: 1 },
    Date.now(),
  );
  return key;
}

test("links on the pages the clean-review traversals load are captured, at no extra call", async () => {
  // An inline finding whose thread is on the second page of threads, and a demoted one whose
  // review is on the earlier page of reviews. The first page holds neither.
  const inline = "eeeeeeeeeeee";
  const demoted = "ffffffffffff";
  const threadUrl = `${PR}705#discussion_r300`;
  const reviewUrl = `${PR}705#pullrequestreview-400`;
  const run = async (stored: boolean): Promise<string[]> => {
    openDb().exec("DELETE FROM inspector_prs; DELETE FROM inspector_comments");
    resetAuthenticatedLogin();
    writeGithubState({
      threadsMore: true,
      reviewsMore: true,
      threadPage: [thread("T_300", threadUrl, formatMarker({ id: "a", fingerprint: inline, round: 2 }), US, true)],
      reviewPage: [findingsReview(reviewUrl, 2)],
    });
    const key = seedResolvedPr(705);
    seedRow(key, { fingerprint: inline, status: "resolved", githubUrl: stored ? threadUrl : null });
    seedRow(key, { fingerprint: demoted, line: null, status: "resolved", githubUrl: stored ? reviewUrl : null });
    writeFileSync(callsPath, "");
    await runOneSweep();
    const rows = byFingerprint(key);
    assert.equal(rows.get(inline)?.githubUrl, threadUrl, "taken from the second page of threads");
    assert.equal(rows.get(demoted)?.githubUrl, reviewUrl, "taken from the earlier page of reviews");
    for (const row of rows.values()) assert.equal(row.updatedAt, 7);
    return ghCalls();
  };
  const capturing = await run(false);
  const alreadyStored = await run(true);
  // The tick's own read, the login, the clean-review re-read, and the two traversals' pages.
  // The review page is read once per review traversal, as it was before links existed: the
  // body-only findings it finds there stop the clean review before the third traversal.
  assert.deepEqual(capturing, ["graphql snapshot", "user", "graphql snapshot", "graphql thread page", "graphql review page"]);
  assert.deepEqual(capturing, alreadyStored, "taking the links adds no call");
});

test("a finding with an older thread on the first page and a newer one later keeps the newer link", async () => {
  // Without the partial-read rule, every tick's first capture would write the older link
  // back, and only a tick that happened to read the later page would correct it.
  const fp = "999999999999";
  const olderUrl = `${PR}706#discussion_r1`;
  const newerUrl = `${PR}706#discussion_r300`;
  writeGithubState({
    threadsMore: true,
    threads: [thread("T_1", olderUrl, formatMarker({ id: "a", fingerprint: fp, round: 1 }), US, true)],
    threadPage: [thread("T_300", newerUrl, formatMarker({ id: "a", fingerprint: fp, round: 3 }), US, true)],
  });
  const key = seedResolvedPr(706);
  seedRow(key, { fingerprint: fp, round: 3, status: "resolved", githubUrl: null });

  await runOneSweep();
  assert.equal(byFingerprint(key).get(fp)?.githubUrl, newerUrl, "the later page's newer post wins");
  assert.equal(readGithubState().posts, 1, "the clean review went out, so later ticks read no further pages");

  writeFileSync(callsPath, "");
  await runOneSweep();
  assert.deepEqual(ghCalls(), ["graphql snapshot"], "this tick saw only the first page");
  assert.equal(byFingerprint(key).get(fp)?.githubUrl, newerUrl, "the first page's older post does not overwrite it");
});

test("a drafted row whose earlier version was posted takes, and keeps, that earlier comment's link", async () => {
  const title = "Came back";
  const fp = fingerprint("src/example.ts", title);
  const earlier = `${PR}703#discussion_r5`;
  process.env.FAKE_FINDINGS = JSON.stringify([
    { path: "src/example.ts", line: 1, title, body: "Back again", severity: "major" },
  ]);
  // The earlier post's thread, resolved when the finding was closed.
  writeGithubState({
    headSha: "head-2",
    threads: [thread("T_1", earlier, formatMarker({ id: "a", fingerprint: fp, round: 1 }), US, true)],
  });
  // Dry run, so raising it again drafts it rather than posting it.
  setInspectorConfig({ enabled: true, mode: "dry-run", repoAllowlist: [project], maxCommentsPerRound: 8 });
  const key = adopt(703);
  updateInspectorPr(key, { headSha: "head-1", reviewPosture: "dry-run", round: 1, lastReviewedAt: 1 }, Date.now());
  // Posted before link capture shipped, so it holds no link yet.
  seedRow(key, { fingerprint: fp, title, round: 1, status: "resolved", githubUrl: null });

  await runOneSweep();
  let row = byFingerprint(key).get(fp)!;
  assert.equal(row.status, "drafted");
  assert.equal(row.body, "Back again", "the row really was raised again");
  assert.equal(row.githubUrl, earlier);
  assert.deepEqual(findingPublication(row), { state: "not-posted", url: earlier, postedAt: 1_000, earlierPost: true, refusals: 0, reason: null });

  // GitHub no longer shows the earlier thread, here as if it fell off the first page. The
  // link stays.
  writeGithubState({ headSha: "head-2" });
  await runOneSweep();
  row = byFingerprint(key).get(fp)!;
  assert.equal(row.githubUrl, earlier);
});

