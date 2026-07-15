import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mkOriginAndClone } from "./helpers/git-fixture.ts";

// The fix log's BYLINE: who wrote the reply that authorized a fix.
//
// no-mistakes records one bit about a reply's origin - `selection_source =
// user | auto_fix` - which says THAT somebody answered and never who. These
// cover the join that names them, over our own `gate_replies` record of what we
// witnessed ourselves.
//
// The thing most worth pinning here is a NEGATIVE: none of this may depend on
// `findingsDigest` or on finding description text. `axi status` truncates
// descriptions at 600 runes with a "… (truncated, %d chars total)" suffix, so
// anything matching on them silently stops matching the day that constant or
// that format string moves. There's a test at the bottom that fails if it ever
// creeps back in.

const temps: string[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

process.env.NM_HOME = tmp("nm-home-");
// Both homes, before the imports resolve their paths: NM_HOME for no-mistakes'
// fixture db, FLEET_HOME for OUR db - which without this would be the
// developer's live ~/.fleet-control/harness.db.
process.env.FLEET_HOME = tmp("fleet-byline-");

const { readFixLog, pickGateReply } = await import("../src/server/nomistakes-fixes.ts");
const { logGateReply, gateRepliesFor, pruneGateReplies, hooksEverSeen, openDb } = await import(
  "../src/server/db.ts"
);
const { classifyPending } = await import("../src/server/foreman/pending.ts");
const { applyVerdict, planFromVerdict } = await import("../src/server/foreman/verdict.ts");
import type { GateReplyRow } from "../src/server/db.ts";
import type { ForemanActions, ReviewContext, Verdict } from "../src/server/foreman/verdict.ts";
import type { NmFinding, NmRunSummary, Session } from "@shared/types.ts";

openDb();

// ---- pickGateReply: which candidate explains a fix ----

function reply(over: Partial<GateReplyRow> = {}): GateReplyRow {
  return {
    sessionId: "s1",
    ts: 1000,
    source: "foreman",
    runId: "run1",
    step: "review",
    findingIds: ["f1"],
    text: "go ahead",
    ...over,
  };
}

test("pickGateReply: a reply filed AFTER the fix landed cannot have caused it", () => {
  const late = reply({ ts: 5000 });
  assert.equal(pickGateReply([late], ["f1"], 4000), null);
});

test("pickGateReply: finding ids separate two rounds of the SAME (run, step)", () => {
  // The case the whole id scheme exists for: both replies share a run and a step,
  // so only the ids say which round each answered.
  const round1 = reply({ ts: 1000, findingIds: ["f1", "f2"], text: "apply both" });
  const round2 = reply({ ts: 3000, findingIds: ["f9"], text: "fix the new one" });
  // Round 1's fix committed at 3500 - AFTER round 2's reply was filed, which is
  // ordinary (the re-review parks again while the first fix is still committing).
  // Recency alone would pick round 2's reply; the ids are what get this right.
  const hit = pickGateReply([round1, round2], ["f1", "f2"], 3500);
  assert.equal(hit?.text, "apply both");
});

test("pickGateReply: with no ids to match on, the newest surviving reply wins", () => {
  // A findings_json we couldn't read leaves no ids, so the fallback is "who spoke
  // last before this landed" - never the one that came after.
  const older = reply({ ts: 1000, text: "first" });
  const newer = reply({ ts: 2000, text: "second" });
  const later = reply({ ts: 9000, text: "after the fix" });
  assert.equal(pickGateReply([older, newer, later], [], 3000)?.text, "second");
});

test("pickGateReply: an identical re-run round falls back to the one before the fix", () => {
  // A round can be re-run with the SAME findings, so ids tie. Causality breaks it.
  const first = reply({ ts: 1000, findingIds: ["f1"], text: "first attempt" });
  const rerun = reply({ ts: 9000, findingIds: ["f1"], text: "second attempt" });
  assert.equal(pickGateReply([first, rerun], ["f1"], 3000)?.text, "first attempt");
});

/**
 * `%ct` is git's committer date in whole SECONDS, so `committedAt` is truncated
 * down by up to 999ms. A reply logged inside that same second reads as being in
 * its own fix's future and would be discarded without the one-second tolerance.
 */
test("pickGateReply: survives %ct's truncation to the second", () => {
  const at = reply({ ts: 10_000_500 }); // logged mid-second...
  const committed = 10_000_000; // ...and %ct floored the commit to the second
  assert.equal(pickGateReply([at], ["f1"], committed)?.ts, 10_000_500);
});

test("pickGateReply: no candidates at all is null, not a guess", () => {
  assert.equal(pickGateReply([], ["f1"], 1000), null);
});

// ---- the store ----

// The store tests share one db, and `pruneGateReplies` is global (it takes a
// cutoff and nothing else). So every row here is dated well ABOVE the prune
// test's cutoff on purpose - otherwise each new test quietly changes how many
// rows that prune deletes, and its count assertion rots from a distance.
const SAFELY_RECENT = 9_000_000;

test("gate replies round-trip, and an empty text stays null", () => {
  logGateReply({
    sessionId: "sx",
    ts: SAFELY_RECENT,
    source: "you",
    runId: "run-store",
    step: "review",
    findingIds: ["a", "b"],
    text: null,
  });
  const rows = gateRepliesFor("run-store", "review");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.source, "you");
  assert.deepEqual(rows[0]!.findingIds, ["a", "b"]);
  // Selecting findings and typing nothing is ordinary: an author with no words,
  // not an absent author.
  assert.equal(rows[0]!.text, null);
});

test("gate replies are scoped to their own (run, step)", () => {
  logGateReply({
    sessionId: "sx", ts: SAFELY_RECENT, source: "you", runId: "run-a",
    step: "review", findingIds: [], text: "a",
  });
  logGateReply({
    sessionId: "sx", ts: SAFELY_RECENT, source: "you", runId: "run-a",
    step: "document", findingIds: [], text: "b",
  });
  assert.deepEqual(gateRepliesFor("run-a", "review").map((r) => r.text), ["a"]);
  assert.deepEqual(gateRepliesFor("run-a", "document").map((r) => r.text), ["b"]);
});

/**
 * `hooksEverSeen` reads ANY session_events row as "hooks reached us from this
 * session" - it does not filter by kind. That's why the byline got its own table
 * instead of a session_events kind, and this is the tripwire: a future move back
 * would make every foreman-nudged session claim hooks it never emitted, silently,
 * in a fact that decides whether a session looks uninstrumented.
 */
test("recording a gate reply does not make a session claim it has hooks", () => {
  logGateReply({
    sessionId: "never-hooked", ts: SAFELY_RECENT, source: "foreman", runId: "r",
    step: "review", findingIds: [], text: "hi",
  });
  assert.equal(hooksEverSeen("never-hooked"), false);
});

test("pruneGateReplies drops only what is older than the cutoff", () => {
  logGateReply({
    sessionId: "sp", ts: 100, source: "you", runId: "run-prune",
    step: "review", findingIds: [], text: "old",
  });
  logGateReply({
    sessionId: "sp", ts: SAFELY_RECENT, source: "you", runId: "run-prune",
    step: "review", findingIds: [], text: "recent",
  });
  assert.equal(pruneGateReplies(1_000), 1);
  assert.deepEqual(gateRepliesFor("run-prune", "review").map((r) => r.text), ["recent"]);
});

// ---- the foreman side: classify -> plan -> apply ----

function nmRun(over: Partial<NmRunSummary> = {}): NmRunSummary {
  return {
    id: "run-parked",
    status: "running",
    branch: "feature",
    startedAt: null,
    endedAt: null,
    awaitingAgent: "parked 1m30s",
    findingsSummary: "1 awaiting",
    gateStep: "review",
    gateSummary: null,
    gateRisk: null,
    steps: [],
    findings: [
      { id: "f1", severity: "error", file: "a.ts", action: "ask-user", description: "why" },
    ] as NmFinding[],
    outcome: null,
    ...over,
  };
}

function gatedSession(over: Partial<Session> = {}): Session {
  return {
    id: "sess-1",
    state: "idle",
    tmux: { session: "s", window: "w", windowIndex: 0, paneId: "%1" },
    nomistakes: nmRun(),
    firstSeen: 1,
    lastActivity: 1,
    ...over,
  } as Session;
}

test("classifyPending carries the gate's run, step and finding ids - and no digest", () => {
  const p = classifyPending(gatedSession(), []);
  assert.equal(p.situation, "gate-parked");
  assert.deepEqual(p.gate, { runId: "run-parked", step: "review", findingIds: ["f1"] });
});

test("classifyPending carries no gate when the step is unknown", () => {
  // The step is half the join key; a reply filed under "parked" would attach to
  // whatever step the fix log later asked about.
  const p = classifyPending(gatedSession({ nomistakes: nmRun({ gateStep: null }) }), []);
  assert.equal(p.situation, "gate-parked");
  assert.equal(p.gate, undefined);
});

const ANSWER: Verdict = {
  purpose: "decide the gate",
  classification: "implementation",
  action: "answer",
  answer: { text: "Apply all of them.", submit: true },
};

function ctx(over: Partial<ReviewContext> = {}): ReviewContext {
  return {
    sessionId: "sess-1",
    repoRoot: "/repo",
    promptMarker: "gate:run-parked:review:abc",
    inputReviewId: null,
    canSend: true,
    gate: { runId: "run-parked", step: "review", findingIds: ["f1"] },
    ...over,
  };
}

function actions(log: string[], over: Partial<ForemanActions> = {}): ForemanActions {
  return {
    putNote: async () => (log.push("putNote"), {}),
    sendText: async () => (log.push("sendText"), {}),
    resolveReview: async () => (log.push("resolveReview"), {}),
    logGateReply: async () => (log.push("logGateReply"), {}),
    ...over,
  };
}

test("applyVerdict records a DELIVERED gate answer, after the send", () => {
  const calls: string[] = [];
  const plan = planFromVerdict(ANSWER, ctx(), true);
  return applyVerdict(actions(calls), ctx(), plan).then(() => {
    assert.deepEqual(calls, ["sendText", "logGateReply", "putNote"]);
  });
});

test("applyVerdict records nothing for a prompt that isn't a gate", async () => {
  const calls: string[] = [];
  const noGate = ctx({ gate: null });
  await applyVerdict(actions(calls), noGate, planFromVerdict(ANSWER, noGate, true));
  assert.deepEqual(calls, ["sendText", "putNote"]);
});

/** A draft was never seen by the agent, so it caused nothing. A byline for it would be fiction. */
test("applyVerdict records nothing for a draft that was never sent", async () => {
  const calls: string[] = [];
  await applyVerdict(actions(calls), ctx(), planFromVerdict(ANSWER, ctx(), false));
  assert.deepEqual(calls, ["putNote"]);
});

/**
 * The reply is already delivered by the time this is recorded, so a failure here
 * must cost the byline and nothing else. Throwing would skip the note below it,
 * leaving a delivered send unstamped - which the worker's idempotency check would
 * then RE-SEND, typing into a live session twice over a missing audit row.
 */
test("applyVerdict still stamps the note when the byline can't be recorded", async () => {
  const calls: string[] = [];
  const acts = actions(calls, {
    logGateReply: async () => {
      throw new Error("daemon down");
    },
  });
  await applyVerdict(acts, ctx(), planFromVerdict(ANSWER, ctx(), true));
  assert.deepEqual(calls, ["sendText", "putNote"]);
});

// ---- the join, end to end over git + both databases ----

function mkNmDb(repoPath: string, branch: string): DatabaseSync {
  const home = tmp("nm-home-");
  process.env.NM_HOME = home;
  const db = new DatabaseSync(join(home, "state.sqlite"));
  db.exec(`
    CREATE TABLE repos (id TEXT PRIMARY KEY, working_path TEXT NOT NULL UNIQUE,
      upstream_url TEXT NOT NULL DEFAULT '', default_branch TEXT NOT NULL DEFAULT 'main',
      created_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE runs (id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, branch TEXT NOT NULL,
      head_sha TEXT NOT NULL DEFAULT '', base_sha TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'completed', created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE step_results (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_name TEXT NOT NULL,
      step_order INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'completed');
    CREATE TABLE step_rounds (id TEXT PRIMARY KEY, step_result_id TEXT NOT NULL, round INTEGER NOT NULL,
      trigger_type TEXT NOT NULL, findings_json TEXT, user_findings_json TEXT,
      selected_finding_ids TEXT, selection_source TEXT, fix_summary TEXT,
      duration_ms INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
  `);
  db.prepare("INSERT INTO repos (id, working_path) VALUES (?, ?)").run("repo1", repoPath);
  db.prepare("INSERT INTO runs (id, repo_id, branch) VALUES (?, ?, ?)").run("run1", "repo1", branch);
  return db;
}

function findings(...items: Array<{ id: string; desc: string; instructions?: string }>): string {
  return JSON.stringify({
    findings: items.map((i) => ({
      id: i.id,
      severity: "error",
      file: `src/${i.id}.ts`,
      line: 10,
      description: i.desc,
      action: "auto-fix",
      ...(i.instructions ? { user_instructions: i.instructions } : {}),
    })),
  });
}

function mkRepo(): string {
  const { root, clone } = mkOriginAndClone("byline-");
  temps.push(root);
  return clone;
}

function commit(cwd: string, file: string, subject: string): void {
  writeFileSync(join(cwd, file), `${file}\n`);
  execFileSync("git", ["-C", cwd, "add", "-A"], { stdio: "pipe" });
  execFileSync("git", ["-C", cwd, "commit", "-qm", subject], { stdio: "pipe" });
}

/** A `replied` fix caused by round 1, with round 1's decision recorded by us. */
function seedRepliedFix(repo: string, opts: { desc?: string } = {}): void {
  const db = mkNmDb(repo, "main");
  db.prepare("INSERT INTO step_results (id, run_id, step_name) VALUES (?, ?, ?)").run(
    "sr1", "run1", "review",
  );
  const desc = opts.desc ?? "This is why the fix happened.";
  db.prepare(
    `INSERT INTO step_rounds (id, step_result_id, round, trigger_type, findings_json,
       user_findings_json, selected_finding_ids, selection_source, fix_summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "rd1", "sr1", 1, "initial",
    findings({ id: "caused-it", desc }),
    findings({ id: "caused-it", desc, instructions: "Apply all four." }),
    JSON.stringify(["caused-it"]), "user", null, 100,
  );
  db.prepare(
    `INSERT INTO step_rounds (id, step_result_id, round, trigger_type, findings_json,
       selection_source, fix_summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("rd2", "sr1", 2, "auto_fix", findings({ id: "after", desc: "re-review" }), "user", "fix the guard", 200);
  db.close();
  commit(repo, "b.ts", "no-mistakes(review): fix the guard");
}

test("a foreman nudge puts a byline on the fix its reply produced", async () => {
  const repo = mkRepo();
  seedRepliedFix(repo);
  const log = await readFixLog(repo, () => [
    {
      sessionId: "s", ts: 1, source: "foreman", runId: "run1", step: "review",
      findingIds: ["caused-it"], text: "This looks safe to apply - go ahead.",
    },
  ]);

  const summary = log.summaries[0]!;
  assert.equal(summary.repliedBy, "foreman");
  const detail = log.details.get(summary.sha)!;
  assert.equal(detail.decision, "replied");
  // The reply and the nudge stay two separate sentences by two separate authors.
  assert.equal(detail.reply, "Apply all four.");
  assert.equal(detail.attribution?.source, "foreman");
  assert.equal(detail.attribution?.text, "This looks safe to apply - go ahead.");
});

test("a dashboard reply reads as you, not as the foreman", async () => {
  const repo = mkRepo();
  seedRepliedFix(repo);
  const log = await readFixLog(repo, () => [
    {
      sessionId: "s", ts: 1, source: "you", runId: "run1", step: "review",
      findingIds: ["caused-it"], text: "Apply all four.",
    },
  ]);
  assert.equal(log.summaries[0]!.repliedBy, "you");
});

/**
 * The common case, and it must stay quiet: the agent drives its own gate via the
 * `/no-mistakes` skill, which no-mistakes records identically to a human reply and
 * which nothing on our side witnessed. The card says `replied` and names nobody.
 */
test("a fix with no recorded reply is replied-by-nobody, not mis-attributed", async () => {
  const repo = mkRepo();
  seedRepliedFix(repo);
  const log = await readFixLog(repo, () => []);
  const detail = log.details.get(log.summaries[0]!.sha)!;
  assert.equal(detail.decision, "replied");
  assert.equal(detail.reply, "Apply all four.");
  assert.equal(detail.attribution, null);
  assert.equal(log.summaries[0]!.repliedBy, null);
});

/**
 * A reply filed against a gate whose fix never landed (the agent ignored the nudge,
 * or the run died) must not attach itself to some other fix on the same run+step.
 */
test("a foreman reply with no matching fix attributes nothing", async () => {
  const repo = mkRepo();
  const db = mkNmDb(repo, "main");
  db.prepare("INSERT INTO step_results (id, run_id, step_name) VALUES (?, ?, ?)").run(
    "sr1", "run1", "review",
  );
  // An AUTO fix on the same run and step. A reply exists for the run, but nobody
  // was asked about THIS fix - it was decided under the pipeline's own round limit.
  db.prepare(
    `INSERT INTO step_rounds (id, step_result_id, round, trigger_type, findings_json,
       selected_finding_ids, selection_source, fix_summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "rd1", "sr1", 1, "initial", findings({ id: "auto1", desc: "found and fixed itself" }),
    JSON.stringify(["auto1"]), "auto_fix", "tidy the imports", 100,
  );
  db.close();
  commit(repo, "c.ts", "no-mistakes(review): tidy the imports");

  const log = await readFixLog(repo, () => [
    {
      sessionId: "s", ts: 1, source: "foreman", runId: "run1", step: "review",
      findingIds: ["something-else"], text: "about a different gate entirely",
    },
  ]);
  const detail = log.details.get(log.summaries[0]!.sha)!;
  assert.equal(detail.decision, "auto");
  assert.equal(detail.attribution, null, "an auto fix has no author to name");
  assert.equal(log.summaries[0]!.repliedBy, null);
});

test("a byline lookup that throws costs the byline, never the log", async () => {
  const repo = mkRepo();
  seedRepliedFix(repo);
  const log = await readFixLog(repo, () => {
    throw new Error("db is locked");
  });
  assert.equal(log.summaries.length, 1, "the fix still lists");
  assert.equal(log.details.get(log.summaries[0]!.sha)!.attribution, null);
});

/**
 * THE constraint, stated as a test.
 *
 * `axi status` truncates a finding's description at 600 runes and appends
 * "… (truncated, %d chars total)", so the harness's copy of a long description is
 * NOT the one in findings_json. Any match on description text - directly, or via
 * `findingsDigest`, which hashes [id, description] pairs - would therefore have to
 * replicate another tool's display constant and format string byte-for-byte,
 * forever, and would fail silently rather than loudly when either moved.
 *
 * So: give the reply a description-derived id-less match and a findings_json whose
 * descriptions are enormous and share nothing with what a gate would have rendered.
 * The ids still line up, so the byline must still land.
 */
test("the byline survives descriptions that no digest could match", async () => {
  const repo = mkRepo();
  // Well past axi status' 600-rune cut, so a digest built from the rendered text
  // and one built from findings_json could not possibly agree.
  seedRepliedFix(repo, { desc: "x".repeat(900) });
  const log = await readFixLog(repo, () => [
    {
      sessionId: "s", ts: 1, source: "foreman", runId: "run1", step: "review",
      // Only the ID. No description, no digest, nothing derived from the text.
      findingIds: ["caused-it"], text: "go ahead",
    },
  ]);
  assert.equal(log.summaries[0]!.repliedBy, "foreman");
});
