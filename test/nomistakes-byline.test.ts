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
// fixture db, MISSION_HOME for OUR db - which without this would be the
// developer's live ~/.mission-control/harness.db.
process.env.MISSION_HOME = tmp("mission-byline-");

const { readFixLog, pickGateReply } = await import("../src/server/nomistakes-fixes.ts");
const { logGateReply, dropGateReply, gateRepliesFor, pruneGateReplies, hooksEverSeen, openDb } =
  await import("../src/server/db.ts");
const { classifyPending } = await import("../src/server/foreman/pending.ts");
const { applyVerdict, planFromVerdict } = await import("../src/server/foreman/verdict.ts");
const { respond, isResponding, responseForRun } = await import("../src/server/nomistakes.ts");
import { gateParked } from "@shared/session.ts";
import type { GateReplyRow } from "../src/server/db.ts";
import type { ForemanActions, ReviewContext, Verdict } from "../src/server/foreman/verdict.ts";
import type { Registry } from "../src/server/registry.ts";
import type { NmFinding, NmRunSummary, Session } from "@shared/types.ts";
import { mkMuxHandle } from "./helpers/session-fixture.ts";

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

/**
 * The gate this fix's reply must have been answered in: parked at 1000, fixed by 4000.
 * See `ReplyWindow` - the bounds are no-mistakes' own round rows, which a rebase cannot
 * rewrite, rather than git's `%ct`, which `axi run` rewrites every time it rebases.
 */
const WINDOW = { after: 1000, before: 4000 };

test("pickGateReply: a reply filed after the fix had run cannot have caused it", () => {
  const late = reply({ ts: 5000 });
  assert.equal(pickGateReply([late], ["f1"], WINDOW), null);
});

test("pickGateReply: a reply filed before the gate parked answered something else", () => {
  const early = reply({ ts: 500 });
  assert.equal(pickGateReply([early], ["f1"], WINDOW), null);
});

/**
 * Two rounds of one (run, step) - the case the join has to get right, since they share
 * everything the byline keys on. Each round's gate is its own window, and that is what
 * separates them: round 1's reply is outside round 2's window however the ids fall.
 */
test("pickGateReply: each round's window holds only its own reply", () => {
  const round1 = reply({ ts: 2000, findingIds: ["f1", "f2"], text: "apply both" });
  const round2 = reply({ ts: 6000, findingIds: ["f9"], text: "fix the new one" });
  const both = [round1, round2];
  assert.equal(pickGateReply(both, ["f1", "f2"], WINDOW)?.text, "apply both");
  assert.equal(pickGateReply(both, ["f9"], { after: 5000, before: 8000 })?.text, "fix the new one");
});

/**
 * The gap ids alone cannot close, and the reason the window carries the join rather than
 * confirming it. Round 1's gate showed [f1, f2] and the Fix box answered it. f1 outlived
 * the fix and came back at round 2 beside a new f3 - ids are semantic slugs, so a
 * surviving finding keeps its name - which leaves overlap at 1, not 0, and the
 * zero-overlap guard sails right past it. The window is what says round 1's reply was
 * answering round 1's gate.
 */
test("pickGateReply: a reply from the previous round's gate cannot sign this one", () => {
  const round1 = reply({ ts: 2000, source: "you", findingIds: ["f1", "f2"], text: "fix both" });
  assert.equal(pickGateReply([round1], ["f1", "f3"], { after: 5000, before: 8000 }), null);
  // ...and the window is doing that work, not the ids: inside its own gate that same
  // partial overlap stands as the cause.
  assert.equal(pickGateReply([round1], ["f1", "f3"], WINDOW)?.text, "fix both");
});

test("pickGateReply: with no ids to match on, the newest reply in the window wins", () => {
  // A findings_json we couldn't read leaves no ids, so the fallback is "who spoke
  // last inside this gate" - never one from outside it.
  const older = reply({ ts: 1500, text: "first" });
  const newer = reply({ ts: 2000, text: "second" });
  const later = reply({ ts: 9000, text: "after the fix" });
  assert.equal(pickGateReply([older, newer, later], [], WINDOW)?.text, "second");
});

/**
 * Ids still earn their keep, in the job the window leaves them: telling two replies
 * apart WITHIN one gate. You can answer twice, or a foreman nudge can land before your
 * dashboard reply. Ids read on both sides that share nothing say "different round" -
 * they do not say "no idea, take the newest".
 */
test("pickGateReply: inside one window, ids still separate two replies", () => {
  const mine = reply({ ts: 2000, source: "you", findingIds: ["f9"], text: "about f9" });
  const nudge = reply({ ts: 3000, source: "foreman", findingIds: ["f1"], text: "about f1" });
  assert.equal(pickGateReply([mine, nudge], ["f9"], WINDOW)?.text, "about f9");
  // ...and one sharing nothing with the round is rejected outright, not fallen back on.
  assert.equal(pickGateReply([nudge], ["f9"], WINDOW), null);
  // But ids missing from the CANDIDATE are "we cannot tell", not a disagreement,
  // so that one still falls back to recency.
  const idless = reply({ ts: 2000, findingIds: [], text: "ids we could not read" });
  assert.equal(pickGateReply([idless], ["f9"], WINDOW)?.text, "ids we could not read");
});

/**
 * A round-1 fix decides and fixes inside ONE round, so both bounds come from that single
 * row and the window collapses to a point. Not hypothetical and not caught upstream:
 * `document` and `lint` do their work on first execution, and such rounds really do
 * record `selection_source = user` (3 on this machine), so they read as `replied` and
 * arrive here rather than being turned away as `auto`. One stamp taken after the fix ran
 * orders nothing, so the honest answer is no byline.
 */
test("pickGateReply: a window collapsed to a point admits nothing", () => {
  const any = reply({ ts: 2000, findingIds: ["f1"] });
  assert.equal(pickGateReply([any], ["f1"], { after: 2000, before: 2000 }), null);
});

test("pickGateReply: no candidates at all is null, not a guess", () => {
  assert.equal(pickGateReply([], ["f1"], WINDOW), null);
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
 * These rows outlive the daemon that wrote them (90 days), so a source a NEWER
 * daemon minted, read back by an older one, is a real upgrade-window state. An
 * author we can't name must read as no author - never as the loudest thing the log
 * can say, which is that a bot changed your branch.
 */
test("a source we do not recognise is dropped, not read as the foreman", () => {
  openDb()
    .prepare(
      `INSERT INTO gate_replies (session_id, ts, source, run_id, step, finding_ids, text)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("sx", SAFELY_RECENT, "some-future-actor", "run-unknown", "review", "[]", "hi");
  assert.deepEqual(gateRepliesFor("run-unknown", "review"), []);
});

/**
 * The retraction half of the "you" lane. A byline has to be staked before its decision
 * is known to have landed - `ts` is what the causality filter reads, so a row written
 * once the outcome is in would postdate the fix it explains and be discarded - which
 * makes the write a claim, and this the way to take a false one back.
 */
test("a staked byline can be taken back by its row id, and only that row", () => {
  const id = logGateReply({
    sessionId: "su", ts: SAFELY_RECENT, source: "you", runId: "run-undo",
    step: "review", findingIds: ["f1"], text: "never delivered",
  });
  logGateReply({
    sessionId: "su", ts: SAFELY_RECENT, source: "you", runId: "run-undo",
    step: "review", findingIds: ["f2"], text: "this one landed",
  });
  dropGateReply(id);
  assert.deepEqual(gateRepliesFor("run-undo", "review").map((r) => r.text), ["this one landed"]);
  // Retracting a byline that isn't there is the same outcome as retracting one that is,
  // so the caller never has to know whether its optimistic write actually happened.
  dropGateReply(id);
  assert.equal(gateRepliesFor("run-undo", "review").length, 1);
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

// ---- the "you" lane: a decision the gate never received has no author ----

/**
 * A fake `no-mistakes` that fails only where a `respond-fails` marker sits, so one
 * binary drives both outcomes: `respond` resolves the binary once and caches it for
 * the process, and the cwd is the only thing left that varies per call.
 */
function fakeAxi(): string {
  const bin = join(tmp("fake-axi-"), "no-mistakes");
  writeFileSync(
    bin,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "no-mistakes 0.0-fake"; exit 0; fi
if [ -f ./respond-stdout-error ]; then cat ./respond-stdout-error; exit 1; fi
if [ -f ./respond-error ]; then cat ./respond-error >&2; exit 1; fi
if [ -f ./respond-fails ]; then exit 1; fi
exit 0
`,
    { mode: 0o755 },
  );
  return bin;
}
process.env.NOMISTAKES_BIN = fakeAxi();

/** A registry with nothing to poll: `respond`'s reconciles then cost no subprocesses. */
const noSessions = {
  nomistakesPollCwds: () => [],
  reconcileNomistakes: () => {},
} as unknown as Registry;

/** Wait for the background `respond` to settle - `isResponding` clears last. */
async function settled(cwd: string): Promise<void> {
  for (let i = 0; i < 500 && isResponding(cwd); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(isResponding(cwd), false, "the respond never settled");
}

/**
 * The bug this closes: the Fix box acts on a POLLED status, so the gate you answered
 * may be one the run has already moved past. `axi respond` then exits non-zero having
 * said nothing - but `respond()` returned ok long before that, because the command
 * blocks server-side until the run reaches its next gate or an outcome. A byline left
 * behind would go on to sign whatever the agent then decided for ITSELF through the
 * `/no-mistakes` skill: an autonomous fix reading "by you, in the dashboard", which is
 * this feature's own distinction inverted, in its worst direction.
 */
test("a respond the gate never received reports itself undelivered", async () => {
  const cwd = tmp("respond-fail-");
  writeFileSync(join(cwd, "respond-fails"), "");
  const undo: string[] = [];
  const runId = "run-dashboard-fail";
  const r = await respond(noSessions, cwd, "fix", {
    runId,
    step: "review",
    findings: ["the-finding"],
    onUndelivered: () => undo.push("retracted"),
  });
  // Accepted only means SPAWNED. Delivery isn't known yet - that's the whole problem.
  assert.equal(r.ok, true);
  await settled(cwd);
  assert.deepEqual(undo, ["retracted"]);
  assert.deepEqual(responseForRun(runId), {
    responseId: 1,
    runId,
    step: "review",
    action: "fix",
    findingIds: ["the-finding"],
    status: "failed",
    error: "no-mistakes exited with status 1",
  });
});

test("a delivered respond keeps its byline", async () => {
  const cwd = tmp("respond-ok-");
  const runId = "run-dashboard-ok";
  let retracted = false;
  const r = await respond(noSessions, cwd, "fix", {
    runId,
    onUndelivered: () => (retracted = true),
  });
  assert.equal(r.ok, true);
  await settled(cwd);
  assert.equal(retracted, false, "a delivered decision keeps its author");
  assert.equal(responseForRun(runId)?.status, "submitted", "the next gate can identify the prior response");
});

test("a failed respond retains a bounded dashboard error", async () => {
  const cwd = tmp("respond-large-error-");
  const runId = "run-dashboard-large-error";
  writeFileSync(join(cwd, "respond-error"), `opening diagnosis\n${"x".repeat(10_000)}\nfinal diagnosis`);
  const r = await respond(noSessions, cwd, "fix", { runId });
  assert.equal(r.ok, true);
  await settled(cwd);
  const error = responseForRun(runId)?.error ?? "";
  assert.equal(error.length, 4000);
  assert.match(error, /^\n… \[earlier output truncated\]\n/);
  assert.match(error, /final diagnosis$/);
  assert.doesNotMatch(error, /opening diagnosis/);
});

test("a failed respond surfaces the CLI's stdout diagnosis", async () => {
  const cwd = tmp("respond-stdout-error-");
  const runId = "run-dashboard-stdout-error";
  writeFileSync(join(cwd, "respond-stdout-error"), "error: the gate already moved");
  const r = await respond(noSessions, cwd, "fix", { runId });
  assert.equal(r.ok, true);
  await settled(cwd);
  assert.equal(responseForRun(runId)?.error, "error: the gate already moved");
});

// ---- the foreman side: classify -> plan -> apply ----

function nmRun(over: Partial<NmRunSummary> = {}): NmRunSummary {
  return {
    id: "run-parked",
    status: "running",
    branch: "feature",
    startedAt: null,
    endedAt: null,
    prUrl: null,
    awaitingAgent: "parked 1m30s",
    findingsSummary: "1 awaiting",
    gateStep: "review",
    gateSummary: null,
    gateRisk: null,
    steps: [],
    activeSteps: [],
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
    terminals: [mkMuxHandle()],
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

/**
 * Where the foreman's byline STOPS, pinned so it stays a decision rather than a
 * side effect of how `classifyPending` happens to be ordered.
 *
 * A session can be parked at a gate AND sitting on a live prompt at once (the gate parks,
 * then the agent puts the finding up as a question). The prompt wins - it's the thing
 * actually blocked - and it carries no gate, so a send that answers it is filed against
 * nothing and its fix reads `replied` with no author. That is the intended half of the
 * trade: what the agent put up may be about anything, so crediting our answer to the gate
 * would claim a reply was about the gate when nothing establishes it - the overclaim this
 * feature exists to prevent. A byline we miss is the safe side of the same trade.
 */
test("a live prompt in front of a parked gate carries no gate, so nothing is filed", async () => {
  const s = gatedSession({ state: "awaiting_input", activity: "Which of these should I fix?" });
  assert.equal(gateParked(s), true, "the gate really is parked behind the prompt");
  const p = classifyPending(s, []);
  assert.equal(p.situation, "terminal-pane");
  assert.equal(p.gate, undefined);

  // ...and that absence is what reaches applyVerdict, which then names nobody.
  const calls: string[] = [];
  const live = ctx({ gate: p.gate ?? null });
  await applyVerdict(actions(calls), live, planFromVerdict(ANSWER, live, true));
  assert.deepEqual(calls, ["sendText", "putNote"]);
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
    selectOption: async () => (log.push("selectOption"), {}),
    submitForm: async () => (log.push("submitForm"), {}),
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
 * The OTHER way a reply goes undelivered, which the draft above does not reach: that one
 * plans no send at all, while this one sends and stops short of Enter. `submit` is the
 * model's to choose, so `submit: false` types the text and leaves it sitting unsubmitted
 * in the pane - the state queue-machine.ts already names - with the gate still parked and
 * the agent none the wiser. The send SUCCEEDS, so nothing throws and nothing else notices.
 *
 * Built from a fresh verdict rather than from ANSWER, which hardcodes `submit: true`:
 * reuse it and the test passes whether or not the guard is there.
 */
test("applyVerdict records nothing for text typed but never submitted", async () => {
  const calls: string[] = [];
  const typed: Verdict = { ...ANSWER, answer: { text: "Apply all of them.", submit: false } };
  const plan = planFromVerdict(typed, ctx(), true);
  assert.equal(plan.send?.submit, false, "the plan really did keep Enter unpressed");
  await applyVerdict(actions(calls), ctx(), plan);
  assert.deepEqual(calls, ["sendText", "putNote"]);
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

// The two clocks, in the two units they really arrive in - the thing most easily got
// wrong here, and the way it fails is silent and total.
//
// `step_rounds.created_at` is no-mistakes' own, in whole SECONDS (verified against live
// data: its newest value reads as today as seconds, and as 1970 as milliseconds). Our
// `gate_replies.ts` is `Date.now()`, in MILLISECONDS. Compared raw, every reply ts is a
// thousand times every created_at, so an upper bound that skipped the conversion would
// reject every reply ever filed and the byline would disappear from the product without
// a single error - so these fixtures use real epoch seconds, and every reply below is
// stamped `* 1000`. Drop the conversion in `roundMs` and this whole section fails.
//
// A round returns, THEN its row is written, so: round 1 returns its findings and the
// gate parks; someone answers it 50s later; round 2 runs the fix and returns.
/** Round 1 returned its findings - the gate parks. The window's lower bound. */
const GATE_PARKED = 1_700_000_000;
/** ...and is answered, well inside the gate. Real rounds sit 11-79 MINUTES apart. */
const GATE_ANSWERED = 1_700_000_050;
/** Round 2 returned: the fix had run. The window's upper bound. */
const FIX_RAN = 1_700_000_100;
/** Round 3 returned: the SECOND fix on this gate had run. */
const FIX_TWO_RAN = 1_700_000_200;

/**
 * `at` pins the COMMITTER date (epoch seconds), which `%ct` reports and the fix log
 * DISPLAYS. The byline no longer reads it at all - it brackets against the round rows
 * above, which a rebase cannot rewrite - so this is here to prove that independence
 * rather than to arrange it. Left off, git uses the wall clock.
 */
function commit(cwd: string, file: string, subject: string, at?: number): void {
  writeFileSync(join(cwd, file), `${file}\n`);
  execFileSync("git", ["-C", cwd, "add", "-A"], { stdio: "pipe" });
  execFileSync("git", ["-C", cwd, "commit", "-qm", subject], {
    stdio: "pipe",
    env: at === undefined ? process.env : { ...process.env, GIT_COMMITTER_DATE: `@${at} +0000` },
  });
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
    JSON.stringify(["caused-it"]), "user", null, GATE_PARKED,
  );
  db.prepare(
    `INSERT INTO step_rounds (id, step_result_id, round, trigger_type, findings_json,
       selection_source, fix_summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("rd2", "sr1", 2, "auto_fix", findings({ id: "after", desc: "re-review" }), "user", "fix the guard", FIX_RAN);
  db.close();
  commit(repo, "b.ts", "no-mistakes(review): fix the guard");
}

/** A reply filed inside `seedRepliedFix`'s gate, by whoever. */
function witnessed(over: Partial<GateReplyRow> = {}): GateReplyRow {
  return {
    sessionId: "s", ts: GATE_ANSWERED * 1000, source: "foreman", runId: "run1",
    step: "review", findingIds: ["caused-it"], text: "This looks safe to apply - go ahead.",
    ...over,
  };
}

test("a foreman nudge puts a byline on the fix its reply produced", async () => {
  const repo = mkRepo();
  seedRepliedFix(repo);
  const log = await readFixLog(repo, () => [witnessed()]);

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
    witnessed({ source: "you", text: "Apply all four." }),
  ]);
  assert.equal(log.summaries[0]!.repliedBy, "you");
});

/**
 * The units, pinned on their own - because getting them wrong takes the whole feature
 * down in silence rather than loudly.
 *
 * `step_rounds.created_at` is SECONDS and `gate_replies.ts` is MILLISECONDS, so every
 * reply's ts is ~1000x every round's created_at. Unconverted, the window's upper bound
 * rejects every reply there has ever been: no byline anywhere, no error, nothing to
 * notice. Here the reply sits squarely inside its gate in real units, and only the
 * conversion in `roundMs` puts it there.
 */
test("the byline reads no-mistakes' round clock in seconds and its own in milliseconds", async () => {
  const repo = mkRepo();
  seedRepliedFix(repo);
  const inside = witnessed({ ts: GATE_ANSWERED * 1000 });
  assert.ok(
    inside.ts > FIX_RAN && inside.ts > GATE_PARKED,
    "raw, the reply looks like it postdates a gate it is actually inside",
  );
  assert.equal((await readFixLog(repo, () => [inside])).summaries[0]!.repliedBy, "foreman");
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
 * Two REPLIED rounds of one (run, step), only the first of which we witnessed - the
 * agent answered round 2's gate itself through the `/no-mistakes` skill. Round 1's
 * nudge is the only candidate round 2's fix has, and it must still name nobody:
 * a byline the foreman didn't earn is the exact claim this feature exists to avoid.
 */
test("an unrelated round's nudge does not sign the next round's fix", async () => {
  const repo = mkRepo();
  const db = mkNmDb(repo, "main");
  db.prepare("INSERT INTO step_results (id, run_id, step_name) VALUES (?, ?, ?)").run(
    "sr1", "run1", "review",
  );
  const round = (id: string, n: number, ids: string, summary: string | null, at: number) =>
    db.prepare(
      `INSERT INTO step_rounds (id, step_result_id, round, trigger_type, findings_json,
         user_findings_json, selected_finding_ids, selection_source, fix_summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, "sr1", n, "initial", findings({ id: ids, desc: `round ${n}` }),
      findings({ id: ids, desc: `round ${n}`, instructions: `apply ${ids}` }),
      JSON.stringify([ids]), "user", summary, at,
    );
  round("rd1", 1, "f1", null, GATE_PARKED); // the foreman nudged this one...
  round("rd2", 2, "f9", "fix one", FIX_RAN); // ...and it produced "fix one"
  round("rd3", 3, "f13", "fix two", FIX_TWO_RAN); // round 2 produced "fix two", unwitnessed
  db.close();
  commit(repo, "d.ts", "no-mistakes(review): fix one");
  commit(repo, "e.ts", "no-mistakes(review): fix two");

  const log = await readFixLog(repo, () => [
    witnessed({ findingIds: ["f1"], text: "Go ahead and fix f1." }),
  ]);

  const two = log.summaries.find((s) => s.summary === "fix two")!;
  assert.equal(log.details.get(two.sha)!.decision, "replied");
  assert.equal(two.repliedBy, null, "round 1's nudge is not round 2's author");
  assert.equal(log.details.get(two.sha)!.attribution, null);
  // ...while the fix the nudge DID cause still carries it.
  const one = log.summaries.find((s) => s.summary === "fix one")!;
  assert.equal(one.repliedBy, "foreman");
  assert.equal(log.details.get(one.sha)!.attribution?.text, "Go ahead and fix f1.");
});

/**
 * Two rounds of one (run, step) where a finding SURVIVES the first fix - the gap ids
 * alone cannot close, and the reason the window has to carry the join.
 *
 * Round 1's gate showed [f1, f2] and the Fix box answered it with the box's default,
 * every finding selected, producing "fix one". f1 was only partly addressed, so the
 * re-review reports it AGAIN - ids are semantic slugs, a surviving finding keeps its
 * name - beside a new f3. Round 2's gate is answered by the agent itself through the
 * `/no-mistakes` skill, unwitnessed, producing "fix two". So round 1's "you" row is the
 * only candidate fix two has, and it shares f1 with round 2: overlap is 1, and the
 * zero-overlap guard sails right past it. Only the window rules it out.
 */
function seedSurvivingFinding(repo: string): void {
  const db = mkNmDb(repo, "main");
  db.prepare("INSERT INTO step_results (id, run_id, step_name) VALUES (?, ?, ?)").run(
    "sr1", "run1", "review",
  );
  const round = (id: string, n: number, ids: string[], summary: string | null, at: number) =>
    db.prepare(
      `INSERT INTO step_rounds (id, step_result_id, round, trigger_type, findings_json,
         user_findings_json, selected_finding_ids, selection_source, fix_summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, "sr1", n, "initial", findings(...ids.map((i) => ({ id: i, desc: `round ${n}` }))),
      findings(...ids.map((i) => ({ id: i, desc: `round ${n}`, instructions: `apply ${ids.join()}` }))),
      JSON.stringify(ids), "user", summary, at,
    );
  round("rd1", 1, ["f1", "f2"], null, GATE_PARKED); // the Fix box answered this one...
  round("rd2", 2, ["f1", "f3"], "fix one", FIX_RAN); // ...producing "fix one"; f1 survived it
  round("rd3", 3, ["f13"], "fix two", FIX_TWO_RAN); // round 2 produced "fix two", unwitnessed
  db.close();
}

/** The Fix box's answer to round 1's gate, shared f1 and all. */
const FIX_BOX_REPLY: GateReplyRow = {
  sessionId: "s", ts: GATE_ANSWERED * 1000, source: "you", runId: "run1",
  step: "review", findingIds: ["f1", "f2"], text: "Fix both of them.",
};

test("a reply from the previous round's gate does not sign the next fix", async () => {
  const repo = mkRepo();
  seedSurvivingFinding(repo);
  commit(repo, "d.ts", "no-mistakes(review): fix one");
  commit(repo, "e.ts", "no-mistakes(review): fix two");

  const log = await readFixLog(repo, () => [FIX_BOX_REPLY]);

  const two = log.summaries.find((s) => s.summary === "fix two")!;
  assert.equal(log.details.get(two.sha)!.decision, "replied");
  assert.equal(two.repliedBy, null, "a reply from fix one's gate is not fix two's author");
  assert.equal(log.details.get(two.sha)!.attribution, null);
  // ...while the fix that reply DID authorize still carries it, f1 and all.
  const one = log.summaries.find((s) => s.summary === "fix one")!;
  assert.equal(one.repliedBy, "you");
  assert.equal(log.details.get(one.sha)!.attribution?.text, "Fix both of them.");
});

/**
 * THE reason the window is bracketed by no-mistakes' rounds and not by git.
 *
 * `axi run` rebases before it pushes, and a rebase re-stamps every replayed commit with
 * its own committer time - so two fixes minutes apart during the run arrive on the
 * branch you sit down to review sharing one second, with `%ct` no longer ordering them
 * at all. The byline must not so much as flinch: it reads round rows, which live in a
 * database and cannot be rewritten by anything git does. Same seeding as above, same
 * two answers expected, every commit stamped identically.
 */
test("a rebase that re-stamps every fix into one second changes no byline", async () => {
  const repo = mkRepo();
  seedSurvivingFinding(repo);
  // What a rebase leaves behind: one committer second across the pair, in whatever
  // order it replayed them.
  const REBASED_AT = 1_700_009_999;
  commit(repo, "d.ts", "no-mistakes(review): fix one", REBASED_AT);
  commit(repo, "e.ts", "no-mistakes(review): fix two", REBASED_AT);

  const log = await readFixLog(repo, () => [FIX_BOX_REPLY]);

  const one = log.summaries.find((s) => s.summary === "fix one")!;
  const two = log.summaries.find((s) => s.summary === "fix two")!;
  assert.equal(one.committedAt, two.committedAt, "the rebase really did collapse the clock");
  assert.equal(one.repliedBy, "you", "the reply still signs the fix it authorized");
  assert.equal(two.repliedBy, null, "and still signs nothing else");
  // `%ct` keeps the one job it can still do honestly: saying when the fix arrived.
  assert.equal(one.committedAt, REBASED_AT * 1000);
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
    JSON.stringify(["auto1"]), "auto_fix", "tidy the imports", GATE_PARKED,
  );
  db.close();
  commit(repo, "c.ts", "no-mistakes(review): tidy the imports");

  const log = await readFixLog(repo, () => [
    witnessed({ findingIds: ["something-else"], text: "about a different gate entirely" }),
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
    // Only the ID. No description, no digest, nothing derived from the text.
    witnessed({ findingIds: ["caused-it"], text: "go ahead" }),
  ]);
  assert.equal(log.summaries[0]!.repliedBy, "foreman");
});
